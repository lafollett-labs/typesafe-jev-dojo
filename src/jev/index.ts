/**
 * A thin, fully-typed client for Jev via OpenRouter's alpha Decisions API.
 *
 * We hand-roll this instead of using the official `typesafe-sdk` because that SDK
 * targets the native `api.typesafe.ai/v1/systemone` path, which we can't reach yet
 * (waitlisted). OpenRouter proxies the same {model, state, questions} body under
 * `/api/alpha/decisions`, so a small client keeps us honest and type-safe.
 */

import type {
  ChoiceQuestion,
  NoulQuestion,
  Questions,
  ScoreQuestion,
  SystemOneRequest,
  SystemOneResult,
  Usage,
} from "./types";

export * from "./types";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/alpha";
const DEFAULT_PATH = "/decisions";
const DEFAULT_MODEL = "typesafe/jev-1.13";
/** $0.042 / 1M input tokens; output is free. */
const INPUT_USD_PER_TOKEN = 0.042 / 1_000_000;

/** Preset transports. Native uses the authoritative schema our types already match. */
export const JEV_TRANSPORTS = {
  native: { baseUrl: "https://api.typesafe.ai", path: "/v1/systemone", model: "jev-latest" },
  openrouter: { baseUrl: "https://openrouter.ai/api/alpha", path: "/decisions", model: "typesafe/jev-1.13" },
} as const;

export interface JevClientOptions {
  /** Defaults to process.env.OPENROUTER_API_KEY. */
  apiKey?: string;
  /** Defaults to https://openrouter.ai/api/alpha (trailing slashes trimmed). */
  baseUrl?: string;
  /** Endpoint path appended to baseUrl. Native: /v1/systemone · OpenRouter: /decisions. */
  path?: string;
  /** Defaults to process.env.JEV_MODEL ?? typesafe/jev-1.13. */
  model?: string;
  /** Per-attempt timeout in ms. Default 30_000. */
  timeoutMs?: number;
  /** Retries for 429 / 529 / 5xx / network blips. Default 3. */
  maxRetries?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "JevError";
  }
}

export class JevClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly path: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: JevClientOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new JevError(
        "Missing Jev API key. Pass apiKey, or set OPENROUTER_API_KEY / TYPESAFE_API_KEY (see .env).",
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.path = opts.path ?? DEFAULT_PATH;
    this.model = opts.model ?? process.env.JEV_MODEL ?? DEFAULT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Ask Jev a map of typed questions about `state`. Answers are typed by the map. */
  async systemOne<Q extends Questions>(
    req: SystemOneRequest<Q>,
  ): Promise<SystemOneResult<Q>> {
    const url = `${this.baseUrl}${this.path}`;
    const body = JSON.stringify({
      model: req.model ?? this.model,
      state: req.state,
      questions: req.questions,
    });

    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body,
          signal: controller.signal,
        });

        if (res.ok) {
          return (await res.json()) as SystemOneResult<Q>;
        }

        const retryable =
          res.status === 429 || res.status === 529 || res.status >= 500;
        if (retryable && attempt < this.maxRetries) {
          await backoff(attempt++, res.headers.get("retry-after"));
          continue;
        }
        throw new JevError(
          `Jev request failed (HTTP ${res.status})`,
          res.status,
          await safeJson(res),
        );
      } catch (err) {
        if (err instanceof JevError) throw err;
        if (attempt < this.maxRetries) {
          await backoff(attempt++, null);
          continue;
        }
        throw new JevError(`Jev request errored: ${(err as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

/** Input-token cost in USD for a call. Output tokens are free on Jev. */
export function estimateCostUSD(usage: Usage): number {
  return usage.input_tokens * INPUT_USD_PER_TOKEN;
}

// --- Question builders (preserve literal keys/levels for answer inference) ---

export function noul(
  instructions: string,
  criteria?: { true: string; false: string },
): NoulQuestion {
  return criteria
    ? { type: "noul", instructions, criteria }
    : { type: "noul", instructions };
}

export function choice<const C extends Record<string, string>>(
  instructions: string,
  criteria: C,
): ChoiceQuestion<C> {
  return { type: "choice", instructions, criteria };
}

export function score<const L extends readonly string[]>(
  instructions: string,
  criteria: L,
): ScoreQuestion<L> {
  return { type: "score", instructions, criteria };
}

// --- internals ---

async function backoff(attempt: number, retryAfter: string | null): Promise<void> {
  const headerMs = retryAfter ? Number(retryAfter) * 1000 : 0;
  const delay =
    headerMs || Math.min(1000 * 2 ** attempt + Math.random() * 250, 8000);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
