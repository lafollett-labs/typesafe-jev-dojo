/**
 * Claude access for the demo — ALWAYS billed against the user's SUBSCRIPTION,
 * never a metered API key.
 *
 * Mechanism (confirmed via claude-code-guide):
 *   1. `claude setup-token`  → prints a ~1-year OAuth token
 *   2. put it in .env as     CLAUDE_CODE_OAUTH_TOKEN=...
 *   3. `npm i @anthropic-ai/claude-agent-sdk`  (optional — only the Gauntlet's LLM half needs it)
 *
 * If ANTHROPIC_API_KEY is present it would win and bill the metered key, so we
 * strip it from the child env and pass only the OAuth token. The SDK import is
 * lazy so SIM mode and Jev-only scenes run without the package installed.
 */

export function claudeConfigured(): boolean {
  return !!process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
}

export async function askClaude(
  prompt: string,
  model: string,
): Promise<{ text: string; latencyMs: number }> {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (!token) throw new Error("CLAUDE_CODE_OAUTH_TOKEN not set (run `claude setup-token`)");

  // Lazy import so the package is only required when the subscription path runs.
  // Non-literal specifier keeps tsc from resolving an optional, may-not-be-installed dep.
  const pkg = "@anthropic-ai/claude-agent-sdk";
  const sdk: any = await import(pkg);
  const query = sdk.query;
  if (typeof query !== "function") throw new Error("claude-agent-sdk: query() not found");

  // Force the subscription path: pass only the OAuth token, drop any metered key.
  const childEnv: Record<string, string | undefined> = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token };
  delete childEnv.ANTHROPIC_API_KEY;

  const t0 = performance.now();
  let text = "";
  // Keep the query lean: a plain system prompt (not the heavy claude_code preset),
  // no tools, no MCP, no CLAUDE.md/settings — this is a one-shot classifier.
  const options: Record<string, unknown> = {
    model,
    maxTurns: 1,
    systemPrompt: "You are a precise text classifier. Reply with only the single requested label in lowercase — no punctuation, no explanation.",
    allowedTools: [],
    settingSources: [],
    mcpServers: {},
    env: childEnv,
  };
  for await (const msg of query({ prompt, options })) {
    const t = extractText(msg);
    if (t) text = t;
  }
  return { text: text.trim(), latencyMs: performance.now() - t0 };
}

/** The Agent SDK's message shape varies by version; pull text from whatever it is. */
function extractText(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const m = msg as Record<string, any>;
  if (typeof m.result === "string") return m.result; // final "result" message
  const content = m.content ?? m.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
  }
  return "";
}
