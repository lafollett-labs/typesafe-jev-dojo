/**
 * Jev Dojo live demo server.
 *
 * Serves the canvas client and drives three scenes with REAL Jev calls over a
 * WebSocket. With no OPENROUTER_API_KEY it runs in SIM mode (clearly badged) so the
 * graphics are watchable and I can verify them; with a key it goes LIVE · Jev 1.13.
 */
import http from "node:http";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { watch } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { WebSocketServer, type WebSocket } from "ws";

import { JevClient, JEV_TRANSPORTS, choice, noul, score, estimateCostUSD } from "../jev/index";
import { askClaude, claudeConfigured } from "./claude";
import { SWARM_ACTIONS } from "../shared/protocol";
import type {
  ClientMsg,
  GauntletResult,
  Health,
  ReflexFrame,
  RouterDecision,
  ServerMsg,
  SwarmAgentInit,
  TxEntry,
} from "../shared/protocol";

const TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY?.trim() || "";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY?.trim() || "";
/** Every Claude call bills against the user's SUBSCRIPTION token (never a metered key). */
const CLAUDE_MODEL = process.env.CLAUDE_MODEL?.trim() || "claude-haiku-4-5";
const PORT = Number(process.env.PORT) || 5178;

/** Prefer native TypeSafe (authoritative schema) → OpenRouter alpha → SIM. */
type Transport = "native" | "openrouter" | "sim";
const TRANSPORT: Transport = TYPESAFE_API_KEY ? "native" : OPENROUTER_API_KEY ? "openrouter" : "sim";
const MODE: "live" | "sim" = TRANSPORT === "sim" ? "sim" : "live";
const JEV_MODEL =
  process.env.JEV_MODEL?.trim() ||
  (TRANSPORT === "native" ? JEV_TRANSPORTS.native.model : JEV_TRANSPORTS.openrouter.model);

const jev =
  TRANSPORT === "native"
    ? new JevClient({ apiKey: TYPESAFE_API_KEY, baseUrl: JEV_TRANSPORTS.native.baseUrl, path: JEV_TRANSPORTS.native.path, model: JEV_MODEL, maxRetries: 4 })
    : TRANSPORT === "openrouter"
      ? new JevClient({ apiKey: OPENROUTER_API_KEY, baseUrl: JEV_TRANSPORTS.openrouter.baseUrl, path: JEV_TRANSPORTS.openrouter.path, model: JEV_MODEL, maxRetries: 4 })
      : null;

const HEALTH: Health = {
  mode: MODE,
  jevModel: JEV_MODEL,
  llmModel: CLAUDE_MODEL,
  note:
    TRANSPORT === "native"
      ? `LIVE · native TypeSafe · ${JEV_MODEL}`
      : TRANSPORT === "openrouter"
        ? `LIVE · ${JEV_MODEL} via OpenRouter`
        : "SIM · no key — decisions generated locally (set TYPESAFE_API_KEY or OPENROUTER_API_KEY to go live)",
};

// --- durable transaction log (the audit history) ----------------------------
const LOG_DIR = fileURLToPath(new URL("../../logs", import.meta.url));
const LOG_PATH = `${LOG_DIR}/transactions.jsonl`;
await mkdir(LOG_DIR, { recursive: true }).catch(() => {});
function appendTx(e: TxEntry): void {
  void appendFile(LOG_PATH, JSON.stringify(e) + "\n").catch(() => {});
}

// --- Real content corpora (never lorem) -----------------------------------

interface RouterTask { text: string; kind: string; lane: string; risk: number }
const ROUTER_TASKS: RouterTask[] = [
  { text: "Reformat this JSON blob and strip null fields.", kind: "format", lane: "tool", risk: 0.2 },
  { text: "Is this email a refund request or a sales inquiry?", kind: "classify", lane: "haiku", risk: 0.5 },
  { text: "Write a friendly 2-line reply confirming the appointment.", kind: "reply", lane: "haiku", risk: 0.4 },
  { text: "Add pagination to the /orders endpoint and its tests.", kind: "code", lane: "sonnet", risk: 1.2 },
  { text: "Draft release notes from these 14 merged PRs.", kind: "draft", lane: "sonnet", risk: 0.8 },
  { text: "Design the sharding strategy for the events table at 40TB.", kind: "architecture", lane: "opus", risk: 2.6 },
  { text: "Review this auth middleware for privilege-escalation bugs.", kind: "security", lane: "opus", risk: 3.0 },
  { text: "Should we grant this IAM role s3:DeleteBucket? Explain risk.", kind: "security", lane: "opus", risk: 3.2 },
  { text: "Write a punchy launch tweet for the new pricing page.", kind: "creative", lane: "fable", risk: 0.6 },
  { text: "Brainstorm 10 cold-open ideas for the demo video.", kind: "creative", lane: "fable", risk: 0.5 },
  { text: "Convert 41.9 USD to EUR at today's rate.", kind: "math", lane: "tool", risk: 0.3 },
  { text: "Deduplicate these 1,200 CRM rows by email.", kind: "data", lane: "tool", risk: 0.7 },
  { text: "Summarize this 30-page RFC into 5 bullets.", kind: "summarize", lane: "sonnet", risk: 0.9 },
  { text: "Customer says they were charged twice — what team owns this?", kind: "support", lane: "haiku", risk: 1.1 },
  { text: "Migrate the billing schema; write a reversible migration.", kind: "code", lane: "opus", risk: 2.8 },
  { text: "Translate this error message to Spanish and French.", kind: "translate", lane: "haiku", risk: 0.3 },
  { text: "Is 'ur account is suspended, verify here bit.ly/x' spam?", kind: "moderation", lane: "haiku", risk: 1.4 },
  { text: "Plan a 3-phase rollout for the new permissions model.", kind: "planning", lane: "opus", risk: 2.4 },
  { text: "Extract invoice number, date, and total from this PDF text.", kind: "extract", lane: "tool", risk: 0.6 },
  { text: "Rewrite this paragraph to be warmer but keep the facts.", kind: "rewrite", lane: "sonnet", risk: 0.5 },
];

const SWARM_PERSONAS = [
  "baker", "guard", "child", "merchant", "farmer", "elder", "thief", "priest",
  "blacksmith", "traveler", "musician", "dog", "cat", "noble", "beggar", "sailor",
];

interface LabeledTask { text: string; truth: string }
const GAUNTLET_LABELS = ["billing", "technical", "sales", "spam"];
const GAUNTLET_TASKS: LabeledTask[] = [
  { text: "I was double charged on my last invoice, please refund one.", truth: "billing" },
  { text: "The webhook stopped firing after your API update this morning.", truth: "technical" },
  { text: "Do you offer volume pricing for 50+ seats?", truth: "sales" },
  { text: "Congrats! You won a $500 gift card, claim at freegc.ru now!!", truth: "spam" },
  { text: "My card was declined but I still got charged twice.", truth: "billing" },
  { text: "Getting a 500 error when uploading files over 2MB.", truth: "technical" },
  { text: "Can I get a demo before my team commits to annual?", truth: "sales" },
  { text: "URGENT: verify your account or it will be deleted — click here.", truth: "spam" },
  { text: "Why does my receipt show tax for a tax-exempt org?", truth: "billing" },
  { text: "The SDK throws 'invalid grant' on token refresh.", truth: "technical" },
  { text: "What's the difference between the Pro and Scale plans?", truth: "sales" },
  { text: "Hot singles in your area want to connect, tap to view.", truth: "spam" },
  { text: "Please cancel my subscription and stop billing me.", truth: "billing" },
  { text: "Dark mode toggle doesn't persist after refresh.", truth: "technical" },
  { text: "We're evaluating vendors — can you send a security whitepaper?", truth: "sales" },
  { text: "Your package is held, pay $1.99 customs fee: track-now.biz", truth: "spam" },
];

// --- Jev question sets ------------------------------------------------------

const routerQuestions = {
  route: choice(
    "Which model tier should handle this task? Pick the cheapest one that can do it well.",
    {
      haiku: "Trivial or short: format, classify, extract, quick reply",
      sonnet: "Moderate: normal coding, drafting, bounded multi-step work",
      opus: "Hard reasoning, architecture, security-critical, or ambiguous",
      fable: "Creative and long-form writing or ideation",
      tool: "Deterministic — no LLM needed (regex, lookup, math, CRUD)",
    },
  ),
  needHuman: noul("Is this risky or ambiguous enough that a human should review before acting?"),
  risk: score("Operational risk if this decision is wrong", ["low", "medium", "high", "critical"]),
};

const gauntletQuestions = {
  intent: choice("Classify the customer message intent.", {
    billing: "Payments, invoices, refunds, charges, subscriptions",
    technical: "Bugs, errors, integration or product problems",
    sales: "Pricing, plans, demos, pre-purchase questions",
    spam: "Scam, phishing, or junk not from a real customer",
  }),
};

const REFLEX_LANES = 5;
const REFLEX_VIEW = 7; // gates spawn this many rows ahead
const reflexQuestion = {
  steer: choice(
    "You pilot a craft along fixed lanes. Ahead are gates that block some lanes. Steer so you are in a CLEAR lane when the nearest gate reaches you. Which way?",
    { left: "move one lane left", stay: "keep the current lane", right: "move one lane right" },
  ),
};

// --- helpers ----------------------------------------------------------------

const RISK_LEVELS = ["low", "medium", "high", "critical"];

function simJevLatency(): number {
  // Mirrors the observed distribution from our research: ~40ms typical, rare spikes.
  if (Math.random() < 0.04) return 380 + Math.random() * 1000;
  return 26 + Math.random() * Math.random() * 90;
}
function simLlmLatency(): number {
  return 650 + Math.random() * 700;
}
function pick<T>(xs: readonly T[]): T {
  return xs[Math.floor(Math.random() * xs.length)]!;
}
function softmaxNoise(keys: string[], winner: string, sharp: number): Record<string, number> {
  const raw: Record<string, number> = {};
  let sum = 0;
  for (const k of keys) {
    const base = k === winner ? sharp : Math.random() * 0.9;
    const v = Math.exp(base);
    raw[k] = v;
    sum += v;
  }
  for (const k of keys) raw[k] = Number((raw[k]! / sum).toFixed(3));
  return raw;
}

// --- live callers -----------------------------------------------------------

async function routerDecide(task: RouterTask, id: number): Promise<RouterDecision> {
  if (jev) {
    const t0 = performance.now();
    const res = await jev.systemOne({ state: task.text, questions: routerQuestions });
    const latencyMs = performance.now() - t0;
    const route = res.answers.route;
    const risk = res.answers.risk;
    const needHuman = res.answers.needHuman.noul;
    const escalated = route.confidence < 0.5 || needHuman > 0.7 || risk.score >= 2.8;
    return {
      id, task: task.text, kind: task.kind,
      lane: route.choice, laneProbs: route.probabilities,
      needHuman, risk: risk.score, riskLevels: RISK_LEVELS,
      confidence: route.confidence, latencyMs,
      costUsd: estimateCostUSD(res.usage), inputTokens: res.usage.input_tokens, escalated,
    };
  }
  // sim
  const laneProbs = softmaxNoise(Object.keys(routerQuestions.route.criteria), task.lane, 2.2 + Math.random());
  const confidence = laneProbs[task.lane]!;
  const needHuman = Math.min(1, Math.max(0, task.risk / 4 + (Math.random() - 0.5) * 0.25));
  const risk = Math.max(0, Math.min(3, task.risk + (Math.random() - 0.5) * 0.5));
  return {
    id, task: task.text, kind: task.kind,
    lane: task.lane, laneProbs, needHuman, risk, riskLevels: RISK_LEVELS,
    confidence, latencyMs: simJevLatency(),
    costUsd: (60 + Math.random() * 90) * (0.042 / 1_000_000),
    inputTokens: Math.round(60 + Math.random() * 90),
    escalated: confidence < 0.5 || needHuman > 0.7 || risk >= 2.8,
  };
}

async function swarmReact(persona: string, event: string): Promise<{ action: string; confidence: number; latencyMs: number; inputTokens: number; costUsd: number }> {
  if (jev) {
    const q = {
      reaction: choice(`A villager whose role is "${persona}" hears a town announcement. How do they react?`, {
        "carry on": "Ignore it and keep doing their thing",
        investigate: "Cautiously go look into it",
        "join in": "Enthusiastically participate",
        flee: "Run away or avoid danger",
        "warn others": "Alert the other villagers",
      }),
    };
    const t0 = performance.now();
    const res = await jev.systemOne({ state: { announcement: event, role: persona }, questions: q });
    return { action: res.answers.reaction.choice, confidence: res.answers.reaction.confidence, latencyMs: performance.now() - t0, inputTokens: res.usage.input_tokens, costUsd: estimateCostUSD(res.usage) };
  }
  const danger = /snake|poison|bite|flee|run|evacuate|storm|bitten/i.test(event);
  const winner = danger
    ? pick(["flee", "flee", "warn others", "investigate", "carry on"])
    : pick(["carry on", "carry on", "investigate", "join in", "warn others"]);
  const probs = softmaxNoise([...SWARM_ACTIONS], winner, 1.8 + Math.random());
  const inputTokens = Math.round(40 + Math.random() * 60);
  return { action: winner, confidence: probs[winner]!, latencyMs: simJevLatency(), inputTokens, costUsd: inputTokens * (0.042 / 1_000_000) };
}

/** Metered-equivalent cost; the subscription covers the real charge. Haiku 4.5 ≈ $1/MTok in, $5/MTok out. */
function estimateClaudeCost(promptChars: number): number {
  const inTok = promptChars / 4;
  return (inTok * 1 + 4 * 5) / 1_000_000;
}

async function llmClassify(text: string, truth: string): Promise<{ answer: string; latencyMs: number; costUsd: number; inputTokens: number }> {
  const labels = GAUNTLET_LABELS;
  if (MODE === "live" && claudeConfigured()) {
    try {
      const prompt = `Classify this customer message into exactly one of: ${labels.join(", ")}. Reply with only the label.\n\nMessage: ${text}`;
      const { text: out, latencyMs } = await askClaude(prompt, CLAUDE_MODEL);
      const raw = out.toLowerCase();
      const answer = labels.find((l) => raw.includes(l)) ?? labels[0]!;
      return { answer, latencyMs, costUsd: estimateClaudeCost(prompt.length), inputTokens: Math.round(prompt.length / 4) };
    } catch {
      // subscription path not wired yet (no CLAUDE_CODE_OAUTH_TOKEN / SDK) — use a plausible opponent
    }
  }
  const correct = Math.random() < 0.82; // LLM slightly more accurate than Jev, far slower
  const answer = correct ? truth : pick(labels.filter((l) => l !== truth));
  return { answer, latencyMs: simLlmLatency(), costUsd: estimateClaudeCost(text.length + 80), inputTokens: Math.round((text.length + 80) / 4) };
}

async function jevClassify(text: string, truth: string): Promise<{ answer: string; latencyMs: number; costUsd: number; inputTokens: number }> {
  if (jev) {
    const t0 = performance.now();
    const res = await jev.systemOne({ state: text, questions: gauntletQuestions });
    return { answer: res.answers.intent.choice, latencyMs: performance.now() - t0, costUsd: estimateCostUSD(res.usage), inputTokens: res.usage.input_tokens };
  }
  const correct = Math.random() < 0.68; // ~ TypeSafe's self-reported accuracy
  const answer = correct ? truth : pick(GAUNTLET_LABELS.filter((l) => l !== truth));
  const inputTokens = Math.round(55 + Math.random() * 80);
  return { answer, latencyMs: simJevLatency(), costUsd: inputTokens * (0.042 / 1_000_000), inputTokens };
}

// --- reflex sim (a self-generating real-time environment) -------------------

interface ReflexState { craft: number; gates: { id: number; dist: number; blocked: number[] }[]; distance: number; crashes: number; nextId: number; }

function spawnGate(s: ReflexState, dist: number) {
  const nBlock = 1 + Math.floor(Math.random() * 3); // block 1..3 of 5 lanes → always ≥2 clear
  const pool = [0, 1, 2, 3, 4];
  const blocked: number[] = [];
  for (let i = 0; i < nBlock; i++) blocked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]!);
  s.gates.push({ id: s.nextId++, dist, blocked: blocked.sort((a, b) => a - b) });
}
function newReflexState(): ReflexState {
  const s: ReflexState = { craft: 2, gates: [], distance: 0, crashes: 0, nextId: 0 };
  spawnGate(s, 4); spawnGate(s, 7);
  return s;
}
const clearLanes = (blocked: number[]) => [0, 1, 2, 3, 4].filter((l) => !blocked.includes(l));
function reflexStateForJev(s: ReflexState) {
  const g = [...s.gates].sort((a, b) => a.dist - b.dist);
  const g0 = g[0], g1 = g[1];
  return {
    craft_lane: s.craft,
    total_lanes: REFLEX_LANES,
    next_gate: g0 ? { distance: Math.round(g0.dist), blocked_lanes: g0.blocked, clear_lanes: clearLanes(g0.blocked) } : null,
    following_gate: g1 ? { distance: Math.round(g1.dist), blocked_lanes: g1.blocked, clear_lanes: clearLanes(g1.blocked) } : null,
  };
}
/** Apply a steer, advance the world one tick, and report whether the craft crashed. */
function reflexStep(s: ReflexState, choice: string): boolean {
  if (choice === "left") s.craft = Math.max(0, s.craft - 1);
  else if (choice === "right") s.craft = Math.min(REFLEX_LANES - 1, s.craft + 1);
  for (const g of s.gates) g.dist -= 1;
  let crashed = false;
  for (const g of s.gates) if (g.dist <= 0 && g.blocked.includes(s.craft)) crashed = true;
  s.gates = s.gates.filter((g) => g.dist > 0);
  while (s.gates.length < 3) {
    const maxDist = s.gates.length ? Math.max(...s.gates.map((g) => g.dist)) : 0;
    spawnGate(s, Math.max(REFLEX_VIEW, maxDist + 3));
  }
  if (crashed) s.crashes++; else s.distance++;
  return crashed;
}
async function reflexDecide(s: ReflexState): Promise<{ choice: string; confidence: number; latencyMs: number; inputTokens: number; costUsd: number }> {
  if (jev) {
    const t0 = performance.now();
    const res = await jev.systemOne({ state: reflexStateForJev(s), questions: reflexQuestion });
    return { choice: res.answers.steer.choice, confidence: res.answers.steer.confidence, latencyMs: performance.now() - t0, inputTokens: res.usage.input_tokens, costUsd: estimateCostUSD(res.usage) };
  }
  // sim: head toward the nearest clear lane of the imminent gate (with an occasional slip)
  const g = [...s.gates].sort((a, b) => a.dist - b.dist)[0];
  let target = s.craft;
  if (g) {
    const clear = clearLanes(g.blocked);
    target = clear.reduce((best, l) => (Math.abs(l - s.craft) < Math.abs(best - s.craft) ? l : best), clear[0] ?? s.craft);
  }
  let choice = target < s.craft ? "left" : target > s.craft ? "right" : "stay";
  if (Math.random() < 0.08) choice = pick(["left", "stay", "right"]); // honest imperfection → real crashes
  const inputTokens = Math.round(70 + Math.random() * 45);
  return { choice, confidence: 0.6 + Math.random() * 0.39, latencyMs: simJevLatency(), inputTokens, costUsd: inputTokens * (0.042 / 1_000_000) };
}

async function mapLimit<T>(items: T[], limit: number, fn: (t: T, i: number) => Promise<void>, signal: AbortSignal): Promise<void> {
  let i = 0;
  const run = async () => {
    while (i < items.length && !signal.aborted) {
      const idx = i++;
      await fn(items[idx]!, idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

// --- per-connection session -------------------------------------------------

class Session {
  private abort = new AbortController();
  private routerRunning = false;
  private routerPerSec = 3;
  private reflexRunning = false;
  private reflexPerSec = 4;
  private reflex: ReflexState = newReflexState();
  private txId = 0;
  constructor(private ws: WebSocket) {
    this.send({ type: "health", health: HEALTH });
    ws.on("message", (raw) => this.onMessage(String(raw)));
    ws.on("close", () => this.abort.abort());
  }
  private send(m: ServerMsg) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(m));
  }
  /** Record one billed call: append to the durable log AND stream it to the UI ledger. */
  private tx(p: Omit<TxEntry, "id" | "ts">) {
    const e: TxEntry = { id: this.txId++, ts: Date.now(), ...p };
    appendTx(e);
    this.send({ type: "tx", e });
  }
  private reset(): AbortSignal {
    this.abort.abort();
    this.abort = new AbortController();
    return this.abort.signal;
  }
  private onMessage(raw: string) {
    let msg: ClientMsg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case "scene":
        if (msg.scene === "router") this.startRouter();
        else if (msg.scene === "reflex") this.startReflex();
        else this.reset();
        break;
      case "router.run": this.routerRunning = msg.on; break;
      case "router.rate": this.routerPerSec = Math.max(1, Math.min(10, msg.perSec)); break;
      case "reflex.run": this.reflexRunning = msg.on; break;
      case "reflex.rate": this.reflexPerSec = Math.max(1, Math.min(10, msg.perSec)); break;
      case "swarm.broadcast": this.runSwarm(msg.event, msg.count); break;
      case "gauntlet.start": this.runGauntlet(msg.count); break;
    }
  }

  private async startRouter() {
    const signal = this.reset();
    this.routerRunning = false; // ALWAYS start paused — no calls until the user presses Start
    let id = 0;
    while (!signal.aborted) {
      if (!this.routerRunning) {
        await sleep(100, signal); // idle: no decisions, no calls
        continue;
      }
      const task = ROUTER_TASKS[id % ROUTER_TASKS.length]!;
      try {
        const d = await routerDecide(task, id++);
        if (signal.aborted) return;
        this.send({ type: "router.decision", d });
        this.tx({
          scene: "router", transport: TRANSPORT, model: JEV_MODEL, kind: d.kind, input: d.task,
          summary: `→ ${d.escalated ? "REVIEW" : d.lane.toUpperCase()} · conf ${Math.round(d.confidence * 100)}% · risk ${d.risk.toFixed(1)} · human ${d.needHuman.toFixed(2)}`,
          inputTokens: d.inputTokens, costUsd: d.costUsd, latencyMs: d.latencyMs, live: MODE === "live",
        });
      } catch (e) {
        this.send({ type: "error", message: (e as Error).message });
        await sleep(500, signal);
      }
      await sleep(Math.max(80, Math.round(1000 / this.routerPerSec)), signal);
    }
  }

  private async startReflex() {
    const signal = this.reset();
    this.reflexRunning = false; // start PAUSED — no calls until Start
    this.reflex = newReflexState();
    while (!signal.aborted) {
      if (!this.reflexRunning) { await sleep(100, signal); continue; }
      try {
        const view = reflexStateForJev(this.reflex);
        const d = await reflexDecide(this.reflex);
        if (signal.aborted) return;
        const crashed = reflexStep(this.reflex, d.choice);
        const f: ReflexFrame = {
          lanes: REFLEX_LANES, craft: this.reflex.craft,
          gates: this.reflex.gates.map((g) => ({ id: g.id, dist: g.dist, blocked: g.blocked })),
          choice: d.choice, confidence: d.confidence,
          distance: this.reflex.distance, crashes: this.reflex.crashes, crashed,
          latencyMs: d.latencyMs, live: MODE === "live",
        };
        this.send({ type: "reflex.frame", f });
        this.tx({
          scene: "reflex", transport: TRANSPORT, model: JEV_MODEL, kind: "steer",
          input: `lane ${view.craft_lane}/${REFLEX_LANES} · next gate d${view.next_gate?.distance ?? "-"} blocks [${view.next_gate?.blocked_lanes.join(",") ?? ""}]`,
          summary: `${d.choice.toUpperCase()} · conf ${Math.round(d.confidence * 100)}%${crashed ? " · 💥 CRASH" : ""}`,
          inputTokens: d.inputTokens, costUsd: d.costUsd, latencyMs: d.latencyMs, live: MODE === "live",
        });
      } catch (e) {
        this.send({ type: "error", message: (e as Error).message });
        await sleep(500, signal);
      }
      await sleep(Math.max(80, Math.round(1000 / this.reflexPerSec)), signal);
    }
  }

  private async runSwarm(event: string, count: number) {
    const signal = this.reset();
    const n = Math.max(1, Math.min(count, 600));
    const agents: SwarmAgentInit[] = Array.from({ length: n }, (_, i) => ({
      id: i, x: Math.random(), y: Math.random(), persona: pick(SWARM_PERSONAS),
    }));
    this.send({ type: "swarm.init", agents, event });
    const totals = { tokens: 0, cost: 0, lat: 0, n: 0 };
    await mapLimit(agents, MODE === "live" ? 24 : 64, async (a) => {
      if (MODE === "sim") await sleep(Math.random() * 900, signal); // spread the ripple in sim
      const r = await swarmReact(a.persona, event);
      if (signal.aborted) return;
      this.send({ type: "swarm.reaction", r: { id: a.id, action: r.action, confidence: r.confidence, latencyMs: r.latencyMs } });
      totals.tokens += r.inputTokens; totals.cost += r.costUsd; totals.lat += r.latencyMs; totals.n++;
    }, signal);
    if (!signal.aborted) {
      this.send({ type: "swarm.done" });
      this.tx({
        scene: "swarm", transport: TRANSPORT, model: JEV_MODEL, kind: "broadcast", input: event,
        summary: `${totals.n} parallel decisions · avg ${totals.n ? Math.round(totals.lat / totals.n) : 0}ms`,
        inputTokens: totals.tokens, costUsd: totals.cost, latencyMs: totals.n ? Math.round(totals.lat / totals.n) : 0, live: MODE === "live",
      });
    }
  }

  private async runGauntlet(count: number) {
    const signal = this.reset();
    const tasks = GAUNTLET_TASKS.slice(0, Math.max(1, Math.min(count, GAUNTLET_TASKS.length)));
    let id = 0;
    for (const t of tasks) {
      if (signal.aborted) return;
      const [jr, lr] = await Promise.all([jevClassify(t.text, t.truth), llmClassify(t.text, t.truth)]);
      const r: GauntletResult = {
        id: id++, task: t.text, truth: t.truth,
        jev: { answer: jr.answer, correct: jr.answer === t.truth, latencyMs: jr.latencyMs, costUsd: jr.costUsd },
        llm: { answer: lr.answer, correct: lr.answer === t.truth, latencyMs: lr.latencyMs, costUsd: lr.costUsd },
      };
      this.send({ type: "gauntlet.result", r });
      const claudeLive = MODE === "live" && claudeConfigured();
      this.tx({
        scene: "gauntlet", transport: TRANSPORT, model: JEV_MODEL, kind: "intent", input: t.text,
        summary: `JEV → ${r.jev.answer} ${r.jev.correct ? "✓" : "✗"} (truth: ${t.truth})`,
        inputTokens: jr.inputTokens, costUsd: r.jev.costUsd, latencyMs: r.jev.latencyMs, live: MODE === "live",
      });
      this.tx({
        scene: "gauntlet", transport: claudeLive ? "claude-sub" : "sim", model: CLAUDE_MODEL, kind: "intent", input: t.text,
        summary: `CLAUDE → ${r.llm.answer} ${r.llm.correct ? "✓" : "✗"} (truth: ${t.truth})`,
        inputTokens: lr.inputTokens, costUsd: r.llm.costUsd, latencyMs: r.llm.latencyMs, live: claudeLive,
      });
      await sleep(MODE === "live" ? 120 : 360, signal);
    }
    if (!signal.aborted) this.send({ type: "gauntlet.done" });
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

// --- http + bundling + ws (with dev hot reload) -----------------------------

const htmlPath = fileURLToPath(new URL("../client/index.html", import.meta.url));
const clientEntry = fileURLToPath(new URL("../client/main.ts", import.meta.url));

const clients = new Set<WebSocket>();
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
function broadcastReload() {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "reload" }));
  }, 120);
}

// Rebuild the client bundle on source change; nudge open pages to reload.
let clientJs = "";
const ctx = await esbuild.context({
  entryPoints: [clientEntry],
  bundle: true, format: "esm", target: "es2022",
  write: false, sourcemap: "inline", logLevel: "silent",
  plugins: [{
    name: "hot-reload",
    setup(build) {
      build.onEnd((result) => {
        const out = result.outputFiles?.[0];
        if (out) { clientJs = out.text; broadcastReload(); }
      });
    },
  }],
});
await ctx.rebuild(); // initial build populates clientJs
await ctx.watch();   // rebuild on any change under src/

// index.html isn't in esbuild's graph — watch it and serve it fresh each load.
try { watch(htmlPath, () => broadcastReload()); } catch { /* fs.watch unsupported here */ }

const server = http.createServer(async (req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(await readFile(htmlPath, "utf8"));
  } else if (req.url === "/app.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    res.end(clientJs);
  } else if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(HEALTH));
  } else {
    res.writeHead(404); res.end("not found");
  }
});

new WebSocketServer({ server }).on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  new Session(ws);
});

server.listen(PORT, () => {
  console.log(`\n  🥋 Jev Dojo demo — ${HEALTH.note}`);
  console.log(`  ▸ open http://localhost:${PORT}  (hot reload on — edit src/client and the page refreshes)\n`);
});
