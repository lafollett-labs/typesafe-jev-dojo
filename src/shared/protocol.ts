/**
 * Wire protocol shared by the demo server and the canvas client.
 * One WebSocket per browser; client sends ClientMsg, server streams ServerMsg.
 */

export type SceneId = "router" | "swarm" | "gauntlet" | "reflex" | "triage" | "queue";

export interface Health {
  mode: "live" | "sim";
  jevModel: string;
  llmModel: string;
  /** Human-readable note shown in the UI badge. */
  note: string;
}

/** Router: one task classified live by Jev (choice + noul + score). */
export interface RouterDecision {
  id: number;
  task: string;
  kind: string;
  /** chosen lane key (a model or a non-LLM destination). */
  lane: string;
  laneProbs: Record<string, number>;
  /** P(needs a human), from a noul. */
  needHuman: number;
  /** risk as an interpolated score float. */
  risk: number;
  riskLevels: string[];
  confidence: number;
  latencyMs: number;
  costUsd: number;
  inputTokens: number;
  /** flat tier distribution (top prob < 0.35) -> abstained to REVIEW; risk/needHuman are advisory, not gates. */
  escalated: boolean;
}

/** Swarm: many agents react in parallel to one broadcast. */
export interface SwarmAgentInit {
  id: number;
  x: number;
  y: number;
  persona: string;
}
export interface SwarmReaction {
  id: number;
  action: string;
  confidence: number;
  latencyMs: number;
}

/** Gauntlet: Jev vs an LLM on the same labeled task, scored against ground truth. */
export interface GauntletSide {
  answer: string;
  correct: boolean;
  latencyMs: number;
  costUsd: number;
}
export interface GauntletResult {
  id: number;
  task: string;
  truth: string;
  jev: GauntletSide;
  llm: GauntletSide;
}

/**
 * Stacker: Jev plays Tetris. One `choice` per piece over every legal placement;
 * the server locks the winner and streams the resulting board (scene id stays "reflex").
 */
export interface StackerFrame {
  cols: number;
  rows: number;
  /** rows*cols, row-major, 0 = empty else piece color id 1..7. Snapshot BEFORE line clears. */
  board: number[];
  /** flat indices the just-placed piece occupies (for the drop + flash). */
  placed: number[];
  /** row indices that are full in `board` and about to clear (flash, then collapse next frame). */
  clearedRows: number[];
  /** color id of the piece that was just placed. */
  piece: number;
  /** color id of the piece coming next (preview). */
  next: number;
  /** chosen placement key `${rot}_${col}`. */
  choice: string;
  /** short human summary of why, e.g. "clears 2 · holes 0 · top 5". */
  reason: string;
  /** probability of the winning option (diluted across many near-equal options). */
  confidence: number;
  /** lead of the winning option over the runner-up — how decisive the pick was. */
  margin: number;
  /** how many placements Jev chose among (after pruning self-destructive moves). */
  options: number;
  /** total lines cleared this game. */
  lines: number;
  /** total pieces placed this game. */
  pieces: number;
  maxHeight: number;
  holes: number;
  /** no legal placement remained — board topped out; the game STOPS and waits for the user to press Start. */
  gameOver: boolean;
  latencyMs: number;
  live: boolean;
}

export type ClientMsg =
  | { type: "scene"; scene: SceneId }
  | { type: "router.run"; on: boolean }
  | { type: "router.rate"; perSec: number }
  | { type: "router.task"; text: string }
  | { type: "router.reset" }
  | { type: "swarm.broadcast"; event: string; count: number }
  | { type: "gauntlet.start"; count: number }
  | { type: "reflex.run"; on: boolean }
  | { type: "reflex.rate"; perSec: number }
  | { type: "reflex.reset" }
  /** Triage: run the whole typed-question panel on one ticket in a single batched call. */
  | { type: "triage.run"; ticket?: string }
  /** Triage queue: run the panel over N tickets, fanned out in parallel caller-side. */
  | { type: "triage.queue"; count: number };

/** One line in the transaction ledger — a single billed call. */
export interface TxEntry {
  id: number;
  ts: number;
  scene: SceneId;
  transport: string;
  model: string;
  kind: string;
  /** the state that was judged (truncated for display). */
  input: string;
  /** compact human summary of the verdict. */
  summary: string;
  inputTokens: number;
  costUsd: number;
  latencyMs: number;
  live: boolean;
}

export type ServerMsg =
  | { type: "health"; health: Health }
  | { type: "tx"; e: TxEntry }
  | { type: "router.decision"; d: RouterDecision }
  | { type: "swarm.init"; agents: SwarmAgentInit[]; event: string }
  | { type: "swarm.reaction"; r: SwarmReaction }
  | { type: "swarm.done" }
  | { type: "gauntlet.result"; r: GauntletResult }
  | { type: "gauntlet.done" }
  | { type: "reflex.frame"; f: StackerFrame }
  | { type: "triage.result"; r: TriageResult }
  | { type: "triage.queue.start"; count: number }
  | { type: "triage.item"; id: number; r: TriageResult }
  | { type: "triage.queue.done"; count: number; inputTokens: number; costUsd: number; wallMs: number; live: boolean }
  | { type: "reload" }
  | { type: "error"; message: string };

/** Triage: one ticket → many typed answers from ONE batched Jev call. */
export interface TriageField {
  key: string;
  label: string;
  type: "choice" | "noul" | "score";
  /** display value: chosen key (choice), probability 0..1 (noul), or interpolated float (score). */
  value: string;
  /** 0..1 meter fill (choice confidence · noul probability · score / top-level). */
  level: number;
  /** semantic color bucket for the UI. */
  tone: "good" | "warn" | "bad" | "info";
}
export interface TriageResult {
  ticket: string;
  /** one entry per typed question in the panel, all answered in the SAME request. */
  fields: TriageField[];
  count: number;
  /** the single batched round-trip. */
  latencyMs: number;
  inputTokens: number;
  costUsd: number;
  /** estimated cost of the same panel run as `count` separate calls (the ticket re-sent each time). */
  seqInputTokens: number;
  seqCostUsd: number;
  live: boolean;
}

/** Router lane targets, frontier→deterministic (Fable is the most capable tier, tool is no-LLM). */
export const ROUTER_LANES = ["fable", "opus", "sonnet", "haiku", "tool"] as const;
export type RouterLane = (typeof ROUTER_LANES)[number];

/** Swarm actions an agent can pick. */
export const SWARM_ACTIONS = ["carry on", "investigate", "join in", "flee", "warn others"] as const;
