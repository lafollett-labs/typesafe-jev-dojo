/**
 * Verified Jev / TypeSafe "System One" decision contract, as exposed through
 * OpenRouter's alpha Decisions API:  POST https://openrouter.ai/api/alpha/decisions
 *
 * Canonical wire format (native TypeSafe docs + OpenRouter Go SDK README agree):
 * every question carries `instructions` + `criteria`. See docs/jev-api-contract.md
 * for provenance and the one response-shape detail still to confirm on first call.
 */

export type QuestionType = "noul" | "choice" | "score";

/** Yes/No -> calibrated P(yes) in [0,1]. Independent: does NOT sum across questions. */
export interface NoulQuestion {
  type: "noul";
  instructions: string;
  /** Optional explicit definitions of what true / false mean. */
  criteria?: { true: string; false: string };
}

/** Pick one named option -> per-option probabilities summing to ~1. Max 255 options. */
export interface ChoiceQuestion<
  C extends Record<string, string> = Record<string, string>,
> {
  type: "choice";
  instructions: string;
  /** option key -> human description of that option. */
  criteria: C;
}

/** Place the state on an ordered rubric -> interpolated float + per-level probs. 2..10 levels. */
export interface ScoreQuestion<L extends readonly string[] = readonly string[]> {
  type: "score";
  instructions: string;
  /** ordered level descriptions, lowest (index 0) to highest. */
  criteria: L;
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export interface NoulAnswer {
  type: "noul";
  /** P(yes), 0..1. */
  noul: number;
}

export interface ChoiceAnswer<K extends string = string> {
  type: "choice";
  /** the winning option key. */
  choice: K;
  /** key -> probability, sums to ~1. */
  probabilities: Record<K, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  /** interpolated position on the rubric (e.g. 1.05), NOT just an index. */
  score: number;
  /** level index (as string) -> probability. */
  probabilities: Record<string, number>;
  /** level index (as string) -> description. */
  legend: Record<string, string>;
  confidence: number;
}

/** Maps a single question to the answer type Jev returns for it. */
export type AnswerFor<Q extends Question> = Q extends NoulQuestion
  ? NoulAnswer
  : Q extends ChoiceQuestion<infer C>
    ? ChoiceAnswer<Extract<keyof C, string>>
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : never;

/** The full answers map, statically typed by the questions you sent. */
export type Answers<Q extends Questions> = { [K in keyof Q]: AnswerFor<Q[K]> };

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface SystemOneRequest<Q extends Questions> {
  /** Text or structured content to evaluate. */
  state: string | Record<string, unknown> | unknown[];
  /** Overrides the client default model (typesafe/jev-1.13). */
  model?: string;
  questions: Q;
}

export interface SystemOneResult<Q extends Questions> {
  model: string;
  answers: Answers<Q>;
  usage: Usage;
}
