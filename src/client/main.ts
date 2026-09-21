/**
 * Jev Dojo — live canvas client. Five scenes share one WebSocket and one <canvas>:
 *   Router   — tasks classified by Jev fly down neon lanes; low-confidence escalates.
 *   Triage   — one ticket, a whole typed-question panel answered in ONE batched call.
 *   Stacker  — Jev plays Tetris: one typed choice per piece over every legal placement.
 *   Swarm    — hundreds of agents react in parallel to one broadcast.
 *   Gauntlet — Jev vs Claude on labeled tasks, scored against ground truth (honest).
 */
import { ROUTER_LANES, SWARM_ACTIONS } from "../shared/protocol";
import type {
  GauntletResult,
  Health,
  StackerFrame,
  RouterDecision,
  ServerMsg,
  SwarmAgentInit,
  SwarmReaction,
  TriageField,
  TriageResult,
  TxEntry,
} from "../shared/protocol";

// --- palette ---------------------------------------------------------------
const C = {
  bg: "#08080d", panel: "#12131d", line: "#242637", text: "#e8eaf5", muted: "#878ca6",
  jev: "#ff2e97", cyan: "#22d3ee", amber: "#f8b74d", green: "#34d39a", red: "#fb5c6c", violet: "#a986ff",
};
const LANE_COLOR: Record<string, string> = {
  haiku: C.green, sonnet: C.cyan, opus: C.violet, fable: C.jev, tool: "#7f88b0", review: C.amber,
};
const LANE_LABEL: Record<string, string> = {
  haiku: "HAIKU", sonnet: "SONNET", opus: "OPUS", fable: "FABLE", tool: "TOOL · DET", review: "REVIEW",
};
const ACTION_COLOR: Record<string, string> = {
  "carry on": "#6b7192", investigate: C.cyan, "join in": C.green, flee: C.red, "warn others": C.amber,
};
const TONE_COLOR: Record<string, string> = { good: C.green, warn: C.amber, bad: C.red, info: C.cyan };
const OPUS_BASELINE = 0.012; // assumed $/task if everything went to Opus — the savings yardstick
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
/** Tetromino colors, indexed by piece id 1..7 (I O T S Z J L). */
const PIECE_COLOR = ["", C.cyan, C.amber, C.violet, C.green, C.red, "#5b8cff", "#ff9f45"];
/** Rotation-0 cells for the NEXT preview (client only needs the spawn shape). */
const PIECE_CELLS: [number, number][][] = [
  [], [[0, 0], [0, 1], [0, 2], [0, 3]], [[0, 0], [0, 1], [1, 0], [1, 1]],
  [[0, 0], [0, 1], [0, 2], [1, 1]], [[0, 1], [0, 2], [1, 0], [1, 1]],
  [[0, 0], [0, 1], [1, 1], [1, 2]], [[0, 0], [1, 0], [1, 1], [1, 2]], [[0, 2], [1, 0], [1, 1], [1, 2]],
];

// --- dom + canvas ----------------------------------------------------------
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const canvas = $("#stage") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const hud = $("#hud");
const dock = $("#dock");
const note = $("#note");
const badge = $("#badge");
const badgeText = $("#badge-text");
const sub = $("#sub");
let W = 0, H = 0;

function fit() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const r = canvas.getBoundingClientRect();
  W = r.width; H = r.height;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  scene?.resize();
}
addEventListener("resize", fit);

// --- draw helpers ----------------------------------------------------------
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] ?? c));
function rr(x: number, y: number, w: number, h: number, rad: number) {
  ctx.beginPath();
  (ctx as any).roundRect ? (ctx as any).roundRect(x, y, w, h, rad) : ctx.rect(x, y, w, h);
}
function bgGrid() {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(255,255,255,0.025)";
  ctx.lineWidth = 1;
  const step = 44;
  ctx.beginPath();
  for (let x = (0); x < W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  for (let y = 0; y < H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();
}
function glow(color: string, blur: number, fn: () => void) {
  ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = blur; fn(); ctx.restore();
}
function text(s: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign = "left") {
  ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = "middle";
  ctx.fillText(s, x, y);
}
const D = (s: number) => `600 ${s}px "Chakra Petch", sans-serif`;
const M = (s: number) => `500 ${s}px "IBM Plex Mono", monospace`;
/** Greedy word-wrap for canvas text at a given font + max width. */
function wrapLines(s: string, maxW: number, font: string): string[] {
  ctx.font = font;
  const lines: string[] = [];
  let line = "";
  for (const word of s.split(/\s+/)) {
    const test = line ? line + " " + word : word;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = word; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function tiles(items: { k: string; v: string; sub?: string; color?: string }[]) {
  hud.innerHTML = "";
  for (const it of items) {
    const t = document.createElement("div");
    t.className = "tile";
    t.innerHTML = `<div class="k">${it.k}</div><div class="v" style="color:${it.color ?? C.text}">${it.v}${it.sub ? ` <small>${it.sub}</small>` : ""}</div>`;
    hud.appendChild(t);
  }
}
function setTile(i: number, v: string) {
  const el = hud.children[i]?.querySelector<HTMLElement>(".v");
  if (el) el.childNodes[0] && (el.childNodes[0].nodeValue = v);
}

// --- scene framework -------------------------------------------------------
interface Scene {
  enter(): void;
  exit(): void;
  message(m: ServerMsg): void;
  frame(dt: number, now: number): void;
  resize(): void;
}
let scene: Scene | null = null;
function activate(s: Scene) {
  scene?.exit();
  hud.innerHTML = ""; dock.innerHTML = ""; note.textContent = "";
  scene = s;
  s.resize(); s.enter();
}

// ===========================================================================
// ROUTER
// ===========================================================================
interface Packet { kind: string; lane: string; conf: number; t: number; sx: number; sy: number; cx: number; cy: number; ex: number; ey: number; }
class RouterScene implements Scene {
  private packets: Packet[] = [];
  private coreX = 0; private coreY = 0; private coreR = 46;
  private ends: Record<string, { x: number; y: number; hit: number }> = {};
  private total = 0;
  private perLane: Record<string, number> = {};
  private lat: number[] = [];
  private cost = 0; private saved = 0;
  private stamps: number[] = [];
  private spin = 0;
  private feed: HTMLElement | null = null;
  private running = false;

  resize() {
    this.coreX = W * (W < 620 ? 0.28 : 0.34);
    this.coreY = H * 0.52;
    this.coreR = clamp(Math.min(W, H) * 0.06, 34, 52);
    const keys = [...ROUTER_LANES, "review"];
    const x = W * (W < 620 ? 0.9 : 0.84);
    // Keep the lowest lane (REVIEW) clear of the bottom-right help note, which can wrap tall.
    const top = H * 0.14, bot = H * 0.72;
    keys.forEach((k, i) => {
      const y = lerp(top, bot, i / (keys.length - 1));
      this.ends[k] = { x, y, hit: this.ends[k]?.hit ?? 0 };
      this.perLane[k] ??= 0;
    });
  }
  enter() {
    this.running = false;
    send({ type: "scene", scene: "router" }); // server starts PAUSED — no calls until Start
    tiles([
      { k: "decisions", v: "0" },
      { k: "throughput", v: "0", sub: "/s", color: C.jev },
      { k: "avg latency", v: "—", sub: "ms", color: C.cyan },
      { k: "spent", v: "$0.00" },
      { k: "saved vs opus", v: "$0.00", color: C.green },
    ]);
    // controls: Start/Pause + Reset + speed
    const panel = document.createElement("div");
    panel.className = "panel controls";
    panel.innerHTML = `
      <button class="btn" id="rt-toggle">▶ Start</button>
      <button class="btn ghost" id="rt-reset">⟲ Reset</button>
      <label>speed <span id="rt-rn">3</span>/s</label>
      <input type="range" id="rt-rate" min="1" max="8" step="1" value="3" />
      <span class="chip" id="rt-status">paused · idle</span>`;
    // stack the two control rows in a left column so they never collide with the note (right)
    const col = document.createElement("div");
    col.style.cssText = "display:flex;flex-direction:column;gap:10px;max-width:70vw;";
    col.appendChild(panel);
    // manual injection: type any task and route it live (works even while paused)
    const inject = document.createElement("div");
    inject.className = "panel controls";
    inject.innerHTML = `
      <label>route your own</label>
      <input type="text" id="rt-task" placeholder="e.g. Review this auth middleware for IDOR bugs" style="min-width:260px" />
      <button class="btn" id="rt-send">Route ▸</button>`;
    col.appendChild(inject);
    dock.appendChild(col);
    const toggle = $("#rt-toggle") as HTMLButtonElement;
    toggle.onclick = () => {
      this.running = !this.running;
      send({ type: "router.run", on: this.running });
      toggle.textContent = this.running ? "⏸ Pause" : "▶ Start";
      toggle.classList.toggle("ghost", this.running);
      ($("#rt-status")).textContent = this.running ? "running — live calls" : "paused · idle";
    };
    ($("#rt-reset") as HTMLButtonElement).onclick = () => {
      this.running = false;
      send({ type: "router.reset" });
      this.packets = []; this.total = 0; this.lat = []; this.cost = 0; this.saved = 0; this.stamps = [];
      for (const k of Object.keys(this.perLane)) this.perLane[k] = 0;
      if (this.feed) while (this.feed.children.length > 1) this.feed.lastElementChild!.remove();
      toggle.textContent = "▶ Start"; toggle.classList.remove("ghost");
      ($("#rt-status")).textContent = "reset · idle";
      setTile(0, "0"); setTile(1, "0"); setTile(2, "—"); setTile(3, "$0.00"); setTile(4, "$0.00");
    };
    const routeInput = $("#rt-task") as HTMLInputElement;
    const sendTask = () => {
      const text = routeInput.value.trim();
      if (!text) return;
      send({ type: "router.task", text });
      routeInput.value = "";
    };
    ($("#rt-send") as HTMLButtonElement).onclick = sendTask;
    routeInput.onkeydown = (e) => { if (e.key === "Enter") sendTask(); };
    ($("#rt-rate") as HTMLInputElement).oninput = (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      $("#rt-rn").textContent = String(v);
      send({ type: "router.rate", perSec: v });
    };
    // live decision feed
    this.feed = document.createElement("div");
    Object.assign(this.feed.style, {
      position: "absolute", left: "16px", top: "210px", width: "360px", maxWidth: "44vw",
      background: "color-mix(in srgb, #12131d 90%, transparent)", backdropFilter: "blur(8px)",
      border: "1px solid #242637", borderRadius: "12px", padding: "10px 12px",
      pointerEvents: "none", fontFamily: "var(--mono)", fontSize: "11px", zIndex: "3",
    } as CSSStyleDeclaration);
    this.feed.innerHTML = `<div style="font-family:var(--display);font-size:11px;letter-spacing:.08em;color:#878ca6;text-transform:uppercase;margin-bottom:2px">Decision feed</div>`;
    document.querySelector("main")!.appendChild(this.feed);
    note.textContent = "Endless self-generating tasks — or type your own and Route it live. Jev answers 3 typed questions each: tier (tool→haiku→sonnet→opus→fable) · too-ambiguous? · risk. Hard work routes UP the ladder; only real uncertainty escalates to REVIEW.";
  }
  exit() {
    this.running = false;
    this.feed?.remove();
    this.feed = null;
  }
  message(m: ServerMsg) {
    if (m.type !== "router.decision") return;
    const d: RouterDecision = m.d;
    const key = d.escalated ? "review" : d.lane;
    const e = this.ends[key] ?? this.ends["tool"]!;
    const midx = (this.coreX + e.x) / 2;
    const midy = (this.coreY + e.y) / 2 - (e.y - this.coreY) * 0.15 - 40;
    this.packets.push({ kind: d.kind, lane: key, conf: d.confidence, t: 0, sx: this.coreX, sy: this.coreY, cx: midx, cy: midy, ex: e.x, ey: e.y });
    if (this.packets.length > 60) this.packets.shift();
    this.total++;
    this.perLane[key] = (this.perLane[key] ?? 0) + 1;
    this.lat.push(d.latencyMs); if (this.lat.length > 40) this.lat.shift();
    this.cost += d.costUsd;
    this.saved += Math.max(0, OPUS_BASELINE - d.costUsd);
    this.stamps.push(performance.now());
    // live feed row: what it actually decided on
    if (this.feed) {
      const col = LANE_COLOR[key]!;
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;align-items:center;padding:4px 0;border-top:1px solid rgba(255,255,255,0.06)";
      row.innerHTML =
        `<span style="width:7px;height:7px;border-radius:50%;background:${col};box-shadow:0 0 6px ${col};flex:0 0 auto"></span>` +
        `<span style="flex:1;color:#cfd3e6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(d.task)}</span>` +
        `<span style="color:${col};text-transform:uppercase;font-size:10px;flex:0 0 auto">${LANE_LABEL[key]}</span>` +
        `<span style="color:#878ca6;flex:0 0 auto">${Math.round(d.confidence * 100)}%</span>`;
      this.feed.firstElementChild!.after(row);
      while (this.feed.children.length > 9) this.feed.lastElementChild!.remove();
    }
  }
  frame(dt: number, now: number) {
    bgGrid();
    this.spin += dt * 0.4;
    // intake stream (ambient)
    if (!REDUCED) {
      ctx.fillStyle = "rgba(255,46,151,0.5)";
      for (let i = 0; i < 5; i++) {
        const p = ((now * 0.00018 + i / 5) % 1);
        const x = lerp(0, this.coreX, p), y = this.coreY + Math.sin(p * 6 + i) * 26;
        ctx.globalAlpha = 0.5 * (1 - Math.abs(p - 0.5) * 1.2);
        ctx.beginPath(); ctx.arc(x, y, 2.4, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    // lanes
    for (const k of [...ROUTER_LANES, "review"]) {
      const e = this.ends[k]!, col = LANE_COLOR[k]!;
      const glowAmt = clamp((300 - (now - e.hit)) / 300, 0, 1);
      // rail from core to lane
      ctx.strokeStyle = `rgba(255,255,255,${0.05 + glowAmt * 0.12})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(this.coreX + this.coreR, this.coreY);
      ctx.quadraticCurveTo((this.coreX + e.x) / 2, (this.coreY + e.y) / 2 - (e.y - this.coreY) * 0.15 - 40, e.x - 60, e.y);
      ctx.stroke();
      // endpoint pill
      const w = W < 620 ? 92 : 128, h = 34;
      glow(col, glowAmt * 22, () => {
        rr(e.x - w + 20, e.y - h / 2, w, h, 9);
        ctx.fillStyle = `color-mix(in srgb, ${col} ${12 + glowAmt * 26}%, ${C.panel})`;
        ctx.fill();
        ctx.strokeStyle = col; ctx.globalAlpha = 0.4 + glowAmt * 0.6; ctx.lineWidth = 1.5; ctx.stroke(); ctx.globalAlpha = 1;
      });
      text(LANE_LABEL[k]!, e.x - w + 32, e.y - 5, D(12), C.text);
      text(String(this.perLane[k] ?? 0), e.x - w + 32, e.y + 9, M(11), col);
    }
    // core
    glow(C.jev, 28, () => {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = this.spin + (i / 6) * Math.PI * 2;
        const px = this.coreX + Math.cos(a) * this.coreR, py = this.coreY + Math.sin(a) * this.coreR;
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = "#170a15"; ctx.fill();
      ctx.strokeStyle = C.jev; ctx.lineWidth = 2; ctx.stroke();
    });
    text("JEV", this.coreX, this.coreY - 5, D(17), "#fff", "center");
    text("system-one", this.coreX, this.coreY + 12, M(9), C.muted, "center");
    // packets
    const spd = REDUCED ? 3 : 1.6;
    for (const p of this.packets) {
      p.t = clamp(p.t + dt * spd, 0, 1);
      const t = ease(p.t);
      const x = lerp(lerp(p.sx, p.cx, t), lerp(p.cx, p.ex - 60, t), t);
      const y = lerp(lerp(p.sy, p.cy, t), lerp(p.cy, p.ey, t), t);
      const col = LANE_COLOR[p.lane]!;
      const alpha = p.t < 0.12 ? p.t / 0.12 : p.t > 0.9 ? (1 - p.t) / 0.1 : 1;
      ctx.globalAlpha = alpha;
      glow(col, 10, () => { ctx.beginPath(); ctx.arc(x, y, 4.5, 0, 7); ctx.fillStyle = col; ctx.fill(); });
      ctx.globalAlpha = alpha * 0.9;
      text(p.kind, x + 9, y, M(10.5), C.text);
      ctx.globalAlpha = 1;
      if (p.t >= 1) this.ends[p.lane]!.hit = now;
    }
    this.packets = this.packets.filter((p) => p.t < 1);
    // hud
    const cutoff = performance.now() - 1000;
    this.stamps = this.stamps.filter((s) => s > cutoff);
    setTile(0, String(this.total));
    setTile(1, String(this.stamps.length));
    setTile(2, this.lat.length ? String(Math.round(this.lat.reduce((a, b) => a + b, 0) / this.lat.length)) : "—");
    setTile(3, "$" + this.cost.toFixed(this.cost < 0.01 ? 5 : 2));
    setTile(4, "$" + this.saved.toFixed(2));
  }
}

// ===========================================================================
// SWARM
// ===========================================================================
interface Agent { x: number; y: number; tx: number; ty: number; color: string; action?: string; conf: number; pop: number; }
class SwarmScene implements Scene {
  private agents = new Map<number, Agent>();
  private event = ""; private count = 200;
  private tally: Record<string, number> = {};
  private ring = 0; private ringOn = false;
  private start = 0; private done = 0; private reacted = 0;

  resize() {}
  enter() {
    tiles([
      { k: "agents", v: "0" },
      { k: "reacted", v: "0", color: C.jev },
      { k: "elapsed", v: "0", sub: "ms", color: C.cyan },
    ]);
    const presets = ["fire sale at the bakery, everything must go!", "everyone who doesn't reach the fountain will be bitten by a snake", "a royal parade is starting in the square", "the well water has gone bad — do not drink"];
    dock.innerHTML = "";
    const panel = document.createElement("div"); panel.className = "panel controls";
    panel.innerHTML = `
      <label>broadcast</label>
      <input type="text" id="sw-event" value="${presets[0]}" />
      <label>agents <span id="sw-n">200</span></label>
      <input type="range" id="sw-count" min="50" max="500" step="50" value="200" />
      <button class="btn" id="sw-go">Broadcast ▸</button>`;
    dock.appendChild(panel);
    const chipRow = document.createElement("div"); chipRow.className = "panel"; chipRow.style.display = "flex"; chipRow.style.gap = "6px"; chipRow.style.flexWrap = "wrap";
    presets.forEach((p) => { const c = document.createElement("span"); c.className = "chip"; c.textContent = p.length > 26 ? p.slice(0, 24) + "…" : p; c.onclick = () => { ($("#sw-event") as HTMLInputElement).value = p; }; chipRow.appendChild(c); });
    dock.appendChild(chipRow);
    ($("#sw-count") as HTMLInputElement).oninput = (e) => { $("#sw-n").textContent = (e.target as HTMLInputElement).value; };
    $("#sw-go").onclick = () => {
      send({ type: "swarm.broadcast", event: ($("#sw-event") as HTMLInputElement).value || "something is happening", count: Number(($("#sw-count") as HTMLInputElement).value) });
    };
    note.textContent = "One broadcast → N Jev decisions in parallel — each agent reacts in character (a thief flees authority, a scholar investigates, a musician joins in). The crowd self-sorts into rings by decision: join in (center) · investigate · warn others · flee (edge). Halo = confidence.";
    send({ type: "scene", scene: "swarm" });
  }
  exit() {}
  message(m: ServerMsg) {
    if (m.type === "swarm.init") {
      this.agents.clear(); this.tally = {}; this.reacted = 0; this.done = 0;
      this.event = m.event; this.start = performance.now(); this.ring = 0; this.ringOn = true;
      const pad = 60;
      for (const a of m.agents as SwarmAgentInit[]) {
        const x = lerp(pad, W - pad, a.x), y = lerp(pad + 40, H - 80, a.y);
        this.agents.set(a.id, { x, y, tx: x, ty: y, color: "#3a3f57", conf: 0, pop: 0 });
      }
      setTile(0, String(m.agents.length));
    } else if (m.type === "swarm.reaction") {
      const r: SwarmReaction = m.r; const a = this.agents.get(r.id); if (!a) return;
      a.action = r.action; a.conf = r.confidence; a.color = ACTION_COLOR[r.action] ?? C.muted; a.pop = 1;
      // sort the crowd into concentric rings BY DECISION — emergent structure from individual choices
      const cx = W / 2, cy = H / 2, minD = Math.min(W, H);
      const ang = Math.atan2(a.y - cy, a.x - cx) + (Math.random() - 0.5) * 0.35;
      const ringR: Record<string, number> = { "join in": 0.05, investigate: 0.20, "warn others": 0.32, flee: 0.45 };
      if (r.action === "carry on") { a.tx = a.x + (Math.random() - 0.5) * 12; a.ty = a.y + (Math.random() - 0.5) * 12; }
      else {
        const rad = minD * ((ringR[r.action] ?? 0.25) + Math.random() * 0.05);
        a.tx = clamp(cx + Math.cos(ang) * rad, 30, W - 30);
        a.ty = clamp(cy + Math.sin(ang) * rad, 78, H - 92);
      }
      this.tally[r.action] = (this.tally[r.action] ?? 0) + 1; this.reacted++;
    } else if (m.type === "swarm.done") this.done = performance.now();
  }
  frame(dt: number, now: number) {
    bgGrid();
    if (this.ringOn) {
      this.ring += dt * 620;
      ctx.strokeStyle = `rgba(255,46,151,${clamp(1 - this.ring / (Math.max(W, H)), 0, 1) * 0.6})`;
      ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(W / 2, H / 2, this.ring, 0, 7); ctx.stroke();
      if (this.ring > Math.max(W, H)) this.ringOn = false;
    }
    for (const a of this.agents.values()) {
      a.x += (a.tx - a.x) * Math.min(1, dt * 6); a.y += (a.ty - a.y) * Math.min(1, dt * 6);
      if (a.pop > 0) a.pop = Math.max(0, a.pop - dt * 2.2);
      if (a.action && a.conf > 0) { ctx.globalAlpha = 0.16 * a.conf; ctx.beginPath(); ctx.arc(a.x, a.y, 8 + a.conf * 7, 0, 7); ctx.fillStyle = a.color; ctx.fill(); ctx.globalAlpha = 1; }
      const r = 3 + a.pop * 4;
      glow(a.action ? a.color : "transparent", a.action ? 8 : 0, () => { ctx.beginPath(); ctx.arc(a.x, a.y, r, 0, 7); ctx.fillStyle = a.color; ctx.fill(); });
    }
    if (this.event) text(`“${this.event}”`, W / 2, 34, D(W < 620 ? 13 : 16), "#fff", "center");
    // consensus headline — the crowd's dominant decision
    const total = Object.values(this.tally).reduce((a, b) => a + b, 0);
    let topAct = "", topN = 0;
    for (const act of SWARM_ACTIONS) { const n = this.tally[act] ?? 0; if (n > topN) { topN = n; topAct = act; } }
    if (total > 0) text(`consensus  ${topAct.toUpperCase()} · ${Math.round((topN / total) * 100)}%`, W / 2, 56, M(13), ACTION_COLOR[topAct] ?? C.text, "center");
    // tally legend top-right (clear of the HUD tiles and the bottom dock)
    const lx = Math.max(W - 300, W * 0.5);
    let ly = 100;
    const max = Math.max(1, ...Object.values(this.tally));
    for (const act of SWARM_ACTIONS) {
      const n = this.tally[act] ?? 0, col = ACTION_COLOR[act]!, isTop = total > 0 && act === topAct;
      ctx.fillStyle = col; ctx.globalAlpha = 0.9; rr(lx, ly, 9, 9, 2); ctx.fill(); ctx.globalAlpha = 1;
      text(isTop ? `▸ ${act}` : act, lx + 16, ly + 5, M(11), isTop ? col : C.text);
      const bw = 120 * (n / max);
      ctx.fillStyle = "rgba(255,255,255,0.08)"; rr(lx + 108, ly, 120, 9, 3); ctx.fill();
      ctx.fillStyle = col; rr(lx + 108, ly, Math.max(2, bw), 9, 3); ctx.fill();
      text(String(n), lx + 236, ly + 5, M(11), C.muted);
      ly += 24;
    }
    setTile(1, String(this.reacted));
    setTile(2, this.done ? String(Math.round(this.done - this.start)) : this.start ? String(Math.round(now - this.start)) : "0");
  }
}

// ===========================================================================
// GAUNTLET
// ===========================================================================
const GAUNTLET_CATS = [
  { key: "billing", ab: "BIL" },
  { key: "technical", ab: "TEC" },
  { key: "sales", ab: "SAL" },
  { key: "spam", ab: "SPM" },
];
class GauntletScene implements Scene {
  private results: GauntletResult[] = [];
  private total = 16;
  private jev = { n: 0, ok: 0, lat: 0, cost: 0 };
  private llm = { n: 0, ok: 0, lat: 0, cost: 0 };
  private running = false;
  private anims: { i: number; row: number; ok: boolean; pop: number }[] = [];

  resize() {}
  enter() {
    dock.innerHTML = "";
    const panel = document.createElement("div"); panel.className = "panel controls";
    panel.innerHTML = `
      <label>tasks <span id="g-n">16</span></label>
      <input type="range" id="g-count" min="4" max="41" step="1" value="16" />
      <button class="btn" id="g-go">Run gauntlet ▸</button>`;
    dock.appendChild(panel);
    ($("#g-count") as HTMLInputElement).oninput = (e) => { $("#g-n").textContent = (e.target as HTMLInputElement).value; };
    $("#g-go").onclick = () => {
      this.results = []; this.anims = []; this.jev = { n: 0, ok: 0, lat: 0, cost: 0 }; this.llm = { n: 0, ok: 0, lat: 0, cost: 0 };
      this.total = Number(($("#g-count") as HTMLInputElement).value); this.running = true;
      send({ type: "gauntlet.start", count: this.total });
    };
    note.textContent = "Same labeled tasks → Jev vs Claude. Ticks: green = matched ground truth, red = missed. The bars + confusion matrix are what the hype videos never show — including exactly WHICH categories Jev mixes up.";
    send({ type: "scene", scene: "gauntlet" });
  }
  exit() {}
  message(m: ServerMsg) {
    if (m.type === "gauntlet.result") {
      const r = m.r; this.results.push(r);
      this.jev.n++; this.jev.ok += r.jev.correct ? 1 : 0; this.jev.lat += r.jev.latencyMs; this.jev.cost += r.jev.costUsd;
      this.llm.n++; this.llm.ok += r.llm.correct ? 1 : 0; this.llm.lat += r.llm.latencyMs; this.llm.cost += r.llm.costUsd;
      this.anims.push({ i: r.id, row: 0, ok: r.jev.correct, pop: 1 });
      this.anims.push({ i: r.id, row: 1, ok: r.llm.correct, pop: 1 });
    } else if (m.type === "gauntlet.done") this.running = false;
  }
  private track(label: string, color: string, y: number, side: { n: number; ok: number; lat: number; cost: number }, row: number, now: number) {
    const x0 = 120, x1 = W * 0.62, tw = x1 - x0;
    text(label, 24, y, D(15), color);
    text(`${side.n ? Math.round((side.ok / side.n) * 100) : 0}% acc`, 24, y + 18, M(11), C.muted);
    ctx.strokeStyle = "rgba(255,255,255,0.08)"; ctx.lineWidth = 1;
    rr(x0, y - 12, tw, 24, 6); ctx.stroke();
    const cellW = tw / this.total;
    for (let i = 0; i < this.results.length; i++) {
      const r = this.results[i]!; const ok = row === 0 ? r.jev.correct : r.llm.correct;
      const anim = this.anims.find((a) => a.i === r.id && a.row === row);
      const pop = anim ? anim.pop : 0;
      const cx = x0 + cellW * i + 3, cw = cellW - 6;
      ctx.globalAlpha = 0.85;
      glow(ok ? C.green : C.red, pop * 12, () => { rr(cx, y - 8, cw, 16, 4); ctx.fillStyle = ok ? C.green : C.red; ctx.fill(); });
      ctx.globalAlpha = 1;
    }
  }
  private bar(label: string, y: number, jevVal: number, llmVal: number, fmt: (n: number) => string, lowerBetter: boolean) {
    const x0 = W * 0.66, w = Math.min(W * 0.3, W - x0 - 24);
    text(label, x0, y - 14, M(10.5), C.muted);
    const max = Math.max(jevVal, llmVal, 1e-9);
    const rows: [string, number, string][] = [["JEV", jevVal, C.jev], ["CLA", llmVal, C.cyan]];
    rows.forEach(([nm, val, col], i) => {
      const yy = y + i * 20;
      ctx.fillStyle = "rgba(255,255,255,0.07)"; rr(x0 + 34, yy - 7, w - 34, 12, 4); ctx.fill();
      const bw = (w - 34) * (val / max);
      glow(col, 8, () => { ctx.fillStyle = col; rr(x0 + 34, yy - 7, Math.max(3, bw), 12, 4); ctx.fill(); });
      text(nm, x0, yy, M(10), col);
      text(fmt(val), x0 + 40 + Math.max(3, bw), yy, M(10), C.text);
    });
    const winner = lowerBetter ? (jevVal <= llmVal ? "JEV" : "CLA") : (jevVal >= llmVal ? "JEV" : "CLA");
    text(`▲ ${winner}`, x0 + w - 4, y - 14, M(9.5), winner === "JEV" ? C.jev : C.cyan, "right");
  }
  /** Jev confusion matrix (actual ↓ vs predicted →) — shows exactly which categories it mixes up. */
  private drawConfusion(x0: number, y0: number) {
    const cats = GAUNTLET_CATS, cell = 36, lx = 46, ty = 26;
    text("JEV — CONFUSION  (actual ↓ · predicted →)", x0, y0, M(10.5), C.muted);
    const cnt = new Map<string, Map<string, number>>();
    for (const a of cats) { const m = new Map<string, number>(); for (const b of cats) m.set(b.key, 0); cnt.set(a.key, m); }
    let maxc = 1;
    for (const r of this.results) {
      const row = cnt.get(r.truth);
      if (row && row.has(r.jev.answer)) { const v = (row.get(r.jev.answer) ?? 0) + 1; row.set(r.jev.answer, v); maxc = Math.max(maxc, v); }
    }
    cats.forEach((b, j) => text(b.ab, x0 + lx + j * cell + cell / 2, y0 + ty - 10, M(9), C.muted, "center"));
    cats.forEach((a, i) => {
      const yy = y0 + ty + i * cell;
      text(a.ab, x0 + lx - 6, yy + cell / 2, M(9), C.muted, "right");
      cats.forEach((b, j) => {
        const xx = x0 + lx + j * cell;
        const v = cnt.get(a.key)?.get(b.key) ?? 0;
        const correct = a.key === b.key, col = correct ? C.green : C.red;
        ctx.globalAlpha = v ? 0.15 + 0.6 * (v / maxc) : 0.05;
        ctx.fillStyle = v ? col : "rgba(255,255,255,0.4)";
        rr(xx + 2, yy + 2, cell - 4, cell - 4, 5); ctx.fill();
        ctx.globalAlpha = 1;
        if (v) text(String(v), xx + cell / 2, yy + cell / 2, M(11.5), correct ? "#eafff5" : "#ffe9ec", "center");
      });
    });
  }
  /** Per-category accuracy for Jev (diagonal / row total). */
  private drawCatAcc(x0: number, y0: number) {
    text("PER-CATEGORY  (Jev accuracy)", x0, y0, M(10.5), C.muted);
    GAUNTLET_CATS.forEach((c, i) => {
      const rows = this.results.filter((r) => r.truth === c.key);
      const ok = rows.filter((r) => r.jev.correct).length;
      const acc = rows.length ? ok / rows.length : 0;
      const yy = y0 + 26 + i * 24;
      text(c.ab, x0, yy, M(11), C.text);
      const bx = x0 + 44, bw = 120;
      ctx.fillStyle = "rgba(255,255,255,0.07)"; rr(bx, yy - 7, bw, 12, 4); ctx.fill();
      glow(C.jev, 6, () => { ctx.fillStyle = C.jev; rr(bx, yy - 7, Math.max(2, bw * acc), 12, 4); ctx.fill(); });
      text(rows.length ? `${Math.round(acc * 100)}% (${ok}/${rows.length})` : "—", bx + bw + 8, yy, M(10), C.muted);
    });
  }
  frame(dt: number, now: number) {
    bgGrid();
    for (const a of this.anims) a.pop = Math.max(0, a.pop - dt * 1.5);
    text("THE GAUNTLET", 24, 40, D(18), "#fff");
    text(this.running ? "running…" : this.results.length ? "complete" : "press run", 200, 40, M(11), this.running ? C.amber : C.muted);
    this.track("JEV", C.jev, H * 0.30, this.jev, 0, now);
    this.track("CLAUDE", C.cyan, H * 0.44, this.llm, 1, now);
    const jAcc = this.jev.n ? (this.jev.ok / this.jev.n) * 100 : 0;
    const lAcc = this.llm.n ? (this.llm.ok / this.llm.n) * 100 : 0;
    this.bar("ACCURACY  (higher = better)", H * 0.26, jAcc, lAcc, (n) => n.toFixed(0) + "%", false);
    this.bar("AVG LATENCY  (lower = better)", H * 0.46, this.jev.n ? this.jev.lat / this.jev.n : 0, this.llm.n ? this.llm.lat / this.llm.n : 0, (n) => Math.round(n) + "ms", true);
    this.bar("TOTAL COST  (lower = better)", H * 0.66, this.jev.cost, this.llm.cost, (n) => "$" + n.toFixed(4), true);
    this.drawConfusion(24, H * 0.58);
    this.drawCatAcc(330, H * 0.58);
  }
}

// ===========================================================================
// STACKER — Jev plays Tetris: one typed choice per piece over every legal placement.
// ===========================================================================
const PIECE_NAME = ["", "I", "O", "T", "S", "Z", "J", "L"];
const ST_ROWS = 16, ST_COLS = 10;
class StackerScene implements Scene {
  private f: StackerFrame | null = null;
  private running = false;
  private drop: { set: Set<number>; color: number; t: number } | null = null;
  private flashRows = new Map<number, number>(); // row -> alpha
  private overFlash = 0;
  private lat: number[] = []; private stamps: number[] = [];
  private best = 0;

  private geom() {
    const cols = this.f?.cols ?? ST_COLS, rows = this.f?.rows ?? ST_ROWS;
    const topPad = 128, botPad = 92; // clear the HUD tiles above and the control dock below
    const availH = Math.max(120, H - topPad - botPad);
    const cell = Math.max(9, Math.floor(Math.min((W * 0.42) / cols, availH / rows)));
    const boardW = cell * cols, boardH = cell * rows;
    const x0 = Math.round(W * 0.38 - boardW / 2);
    const y0 = Math.round(topPad + (availH - boardH) / 2);
    return { cols, rows, cell, boardW, boardH, x0, y0 };
  }
  private drawCell(x: number, y: number, s: number, color: string, glowAmt: number, alpha = 1) {
    ctx.globalAlpha = alpha;
    glow(color, glowAmt, () => { rr(x + 1, y + 1, s - 2, s - 2, Math.min(4, s * 0.24)); ctx.fillStyle = color; ctx.fill(); });
    ctx.globalAlpha = alpha * 0.22; ctx.fillStyle = "#fff"; rr(x + 2.5, y + 2.5, s - 5, (s - 5) * 0.42, 2); ctx.fill();
    ctx.globalAlpha = 1;
  }

  resize() {}
  enter() {
    this.f = null; this.running = false; this.drop = null; this.flashRows.clear();
    this.overFlash = 0; this.lat = []; this.stamps = []; this.best = 0;
    send({ type: "scene", scene: "reflex" });
    tiles([
      { k: "lines", v: "0", color: C.jev },
      { k: "pieces", v: "0" },
      { k: "max height", v: "0", color: C.amber },
      { k: "holes", v: "0", color: C.red },
      { k: "think", v: "—", sub: "ms", color: C.cyan },
    ]);
    const panel = document.createElement("div");
    panel.className = "panel controls";
    panel.innerHTML = `
      <button class="btn" id="rx-toggle">▶ Start</button>
      <button class="btn ghost" id="rx-reset">⟲ Reset</button>
      <label>speed <span id="rx-rn">3</span>/s</label>
      <input type="range" id="rx-rate" min="1" max="8" step="1" value="3" />
      <span class="chip" id="rx-status">paused · idle</span>`;
    dock.appendChild(panel);
    const t = $("#rx-toggle") as HTMLButtonElement;
    t.onclick = () => {
      this.running = !this.running;
      send({ type: "reflex.run", on: this.running });
      t.textContent = this.running ? "⏸ Pause" : "▶ Start";
      t.classList.toggle("ghost", this.running);
      ($("#rx-status")).textContent = this.running ? "playing — live calls" : "paused · idle";
    };
    ($("#rx-reset") as HTMLButtonElement).onclick = () => {
      this.running = false;
      send({ type: "reflex.reset" }); // server: new game, paused
      this.f = null; this.drop = null; this.flashRows.clear(); this.overFlash = 0;
      this.lat = []; this.stamps = []; this.best = 0;
      t.textContent = "▶ Start"; t.classList.remove("ghost");
      ($("#rx-status")).textContent = "reset · idle";
      setTile(0, "0"); setTile(1, "0"); setTile(2, "0"); setTile(3, "0"); setTile(4, "—");
    };
    ($("#rx-rate") as HTMLInputElement).oninput = (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      $("#rx-rn").textContent = String(v);
      send({ type: "reflex.rate", perSec: v });
    };
    note.textContent = "Jev plays Tetris. Every piece is ONE typed choice over every legal placement — each option described by the board it makes (lines · holes · height · bumps). No look-ahead search, just a fast typed decision. Starts paused.";
  }
  exit() { this.running = false; }
  message(m: ServerMsg) {
    if (m.type !== "reflex.frame") return;
    const f = m.f; this.f = f;
    this.stamps.push(performance.now());
    if (!f.gameOver) { this.lat.push(f.latencyMs); if (this.lat.length > 30) this.lat.shift(); }
    if (f.placed.length && !f.gameOver) this.drop = { set: new Set(f.placed), color: f.piece, t: 0 };
    for (const r of f.clearedRows) this.flashRows.set(r, 1);
    this.best = Math.max(this.best, f.lines);
    if (f.gameOver) {
      // the game stops on top-out; reflect that in the control so Start begins a fresh game
      this.overFlash = 1; this.drop = null; this.running = false;
      const t = document.querySelector<HTMLButtonElement>("#rx-toggle");
      if (t) { t.textContent = "▶ Start"; t.classList.remove("ghost"); }
      const st = document.querySelector<HTMLElement>("#rx-status");
      if (st) st.textContent = "topped out · press start";
    }
  }
  /** Right-side panel: NEXT preview + Jev's decision readout (clear of the HUD + dock). */
  private drawPanel(g: { x0: number; y0: number; boardW: number; cell: number }, now: number) {
    const f = this.f; if (!f) return;
    const px = g.x0 + g.boardW + 28, s = Math.max(16, Math.round(g.cell * 0.7));
    // NEXT preview
    text("NEXT", px, g.y0 + 6, M(11), C.muted);
    const cells = PIECE_CELLS[f.next] ?? [];
    const by = g.y0 + 22;
    ctx.strokeStyle = "rgba(255,255,255,0.08)"; rr(px - 6, by - 6, 4 * s + 12, 2.4 * s + 12, 8); ctx.stroke();
    if (cells.length) {
      const w = Math.max(...cells.map((c) => c[1])) + 1, h = Math.max(...cells.map((c) => c[0])) + 1;
      const ox = px + ((4 - w) * s) / 2, oy = by + ((2.4 - h) * s) / 2;
      const col = PIECE_COLOR[f.next] ?? C.muted;
      for (const [r, c] of cells) this.drawCell(ox + c * s, oy + r * s, s, col, 6);
    }
    // decision readout
    let ry = by + 2.4 * s + 30;
    if (f.gameOver) {
      text("GAME OVER", px, ry, M(10.5), C.red); ry += 22;
      text("topped out", px, ry, D(16), C.red); ry += 26;
      text(`cleared ${f.lines} lines · ${f.pieces} pieces`, px, ry, M(11.5), "#cfd3e6"); ry += 22;
      text("press Start for a new game", px, ry, M(11.5), C.muted); ry += 20;
      text(`best  ${this.best} lines`, px, ry, M(11.5), C.jev);
      return;
    }
    const pcol = PIECE_COLOR[f.piece] ?? C.text;
    text("JEV JUST PLACED", px, ry, M(10.5), C.muted); ry += 20;
    text(`${PIECE_NAME[f.piece] ?? "?"}-piece`, px, ry, D(16), pcol); ry += 26;
    text(f.reason, px, ry, M(11.5), "#cfd3e6"); ry += 22;
    const pace = this.stamps.length;
    text(`confidence ${Math.round(f.confidence * 100)}%  ·  +${Math.round(f.margin * 100)}% lead`, px, ry, M(11.5), C.jev); ry += 18;
    text(`${f.options} moves judged  ·  pace ${pace}/s`, px, ry, M(11.5), C.muted); ry += 18;
    text(`best  ${this.best} lines`, px, ry, M(11.5), C.muted);
  }
  frame(dt: number, now: number) {
    bgGrid();
    const g = this.geom();
    const f = this.f;
    // well frame + faint grid
    ctx.strokeStyle = "rgba(255,255,255,0.10)"; ctx.lineWidth = 1.5;
    rr(g.x0 - 4, g.y0 - 4, g.boardW + 8, g.boardH + 8, 10); ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.035)"; ctx.lineWidth = 1; ctx.beginPath();
    for (let c = 1; c < g.cols; c++) { const x = g.x0 + c * g.cell; ctx.moveTo(x, g.y0); ctx.lineTo(x, g.y0 + g.boardH); }
    for (let r = 1; r < g.rows; r++) { const y = g.y0 + r * g.cell; ctx.moveTo(g.x0, y); ctx.lineTo(g.x0 + g.boardW, y); }
    ctx.stroke();

    // advance the drop-in animation
    if (this.drop) { this.drop.t = Math.min(1, this.drop.t + dt / 0.13); if (this.drop.t >= 1) this.drop = null; }
    const dropping = this.drop;

    if (f) {
      // settled cells (skip the ones currently dropping in — drawn separately below)
      for (let i = 0; i < f.board.length; i++) {
        const id = f.board[i]!; if (!id) continue;
        if (dropping && dropping.set.has(i)) continue;
        const r = Math.floor(i / g.cols), c = i % g.cols;
        this.drawCell(g.x0 + c * g.cell, g.y0 + r * g.cell, g.cell, PIECE_COLOR[id] ?? C.muted, 5);
      }
      // dropping piece: rigid fall from just above its resting place
      if (dropping) {
        const off = (1 - ease(dropping.t)) * g.cell * 7;
        ctx.save(); rr(g.x0, g.y0, g.boardW, g.boardH, 8); ctx.clip();
        for (const i of dropping.set) {
          const r = Math.floor(i / g.cols), c = i % g.cols;
          this.drawCell(g.x0 + c * g.cell, g.y0 + r * g.cell - off, g.cell, PIECE_COLOR[dropping.color] ?? C.muted, 12);
        }
        ctx.restore();
      }
      // line-clear flash over full rows
      for (const [r, a] of this.flashRows) {
        ctx.globalAlpha = a; glow("#fff", 24 * a, () => { rr(g.x0, g.y0 + r * g.cell, g.boardW, g.cell, 3); ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.fill(); });
        ctx.globalAlpha = 1;
        const na = a - dt * 4; if (na <= 0) this.flashRows.delete(r); else this.flashRows.set(r, na);
      }
      this.drawPanel(g, now);
    } else {
      text("press start", g.x0 + g.boardW / 2, g.y0 + g.boardH / 2, D(18), C.muted, "center");
    }

    // game-over overlay
    if (this.overFlash > 0 && f) {
      ctx.fillStyle = `rgba(251,92,108,${this.overFlash * 0.22})`; ctx.fillRect(0, 0, W, H);
      text("TOPPED OUT", g.x0 + g.boardW / 2, g.y0 + g.boardH * 0.42, D(30), `rgba(251,92,108,${this.overFlash})`, "center");
      text(`${f.lines} lines · ${f.pieces} pieces — new game…`, g.x0 + g.boardW / 2, g.y0 + g.boardH * 0.42 + 30, M(12), `rgba(232,234,245,${this.overFlash})`, "center");
      this.overFlash = Math.max(0, this.overFlash - dt * 0.8);
    }

    const cutoff = performance.now() - 1000; this.stamps = this.stamps.filter((s) => s > cutoff);
    if (f) {
      setTile(0, String(f.lines)); setTile(1, String(f.pieces));
      setTile(2, String(f.maxHeight)); setTile(3, String(f.holes));
    }
    setTile(4, this.lat.length ? String(Math.round(this.lat.reduce((a, b) => a + b, 0) / this.lat.length)) : "—");
  }
}

// ===========================================================================
// TRIAGE — one ticket, a whole typed-question panel answered in ONE batched call.
// ===========================================================================
class TriageScene implements Scene {
  private r: TriageResult | null = null;
  private shownAt = 0;
  private running = false;

  resize() {}
  enter() {
    this.r = null; this.running = false; this.shownAt = 0; // fresh on every (re)entry
    tiles([
      { k: "decisions", v: "0" },
      { k: "requests", v: "1", color: C.jev },
      { k: "latency", v: "—", color: C.cyan },
      { k: "cost", v: "$0.00000" },
      { k: "vs sequential", v: "—", color: C.green },
    ]);
    const p1 = document.createElement("div");
    p1.className = "panel controls";
    p1.innerHTML = `
      <button class="btn" id="tr-go">Triage a ticket ▸</button>
      <span class="chip" id="tr-status">idle</span>`;
    const col = document.createElement("div");
    col.style.cssText = "display:flex;flex-direction:column;gap:10px;max-width:70vw;";
    col.appendChild(p1);
    const inject = document.createElement("div");
    inject.className = "panel controls";
    inject.innerHTML = `
      <label>your ticket</label>
      <input type="text" id="tr-ticket" placeholder="paste a support message and triage it live…" style="min-width:280px" />
      <button class="btn" id="tr-send">Triage ▸</button>`;
    col.appendChild(inject);
    dock.appendChild(col);
    const start = (ticket?: string) => { this.running = true; ($("#tr-status")).textContent = "one batched call…"; send({ type: "triage.run", ticket }); };
    ($("#tr-go") as HTMLButtonElement).onclick = () => start();
    const input = $("#tr-ticket") as HTMLInputElement;
    const sendTicket = () => start(input.value.trim() || undefined);
    ($("#tr-send") as HTMLButtonElement).onclick = sendTicket;
    input.onkeydown = (e) => { if (e.key === "Enter") sendTicket(); };
    note.textContent = "One support ticket → a whole panel of typed questions (intent · priority · sentiment · churn · refund? · spam? · upsell? · language …) answered in ONE batched Jev call — all at once, one round-trip, versus a separate call per question.";
    send({ type: "scene", scene: "triage" });
  }
  exit() {}
  message(m: ServerMsg) {
    if (m.type !== "triage.result") return;
    this.r = m.r; this.shownAt = performance.now(); this.running = false;
    ($("#tr-status")).textContent = m.r.live ? "batched · live" : "batched · sim";
    setTile(0, String(m.r.count));
    setTile(2, Math.round(m.r.latencyMs) + "ms");
    setTile(3, "$" + m.r.costUsd.toFixed(6));
    setTile(4, (m.r.seqInputTokens / Math.max(1, m.r.inputTokens)).toFixed(1) + "× fewer tok");
  }
  private card(f: TriageField, x: number, y: number, w: number, h: number, reveal: number) {
    const e = ease(clamp(reveal, 0, 1));
    if (e <= 0) return;
    const col = TONE_COLOR[f.tone] ?? C.cyan;
    ctx.globalAlpha = e;
    ctx.fillStyle = C.panel; rr(x, y, w, h, 10); ctx.fill();
    ctx.strokeStyle = col + "44"; ctx.lineWidth = 1; rr(x, y, w, h, 10); ctx.stroke();
    text(f.label.toUpperCase(), x + 12, y + 15, M(9.5), C.muted);
    const disp = f.type === "choice" ? f.value.toUpperCase() : f.type === "noul" ? Math.round(f.level * 100) + "%" : f.value;
    glow(col, 6 * e, () => text(disp, x + 12, y + 35, D(18), col));
    if (f.type === "choice") text(Math.round(f.level * 100) + "%", x + w - 12, y + 35, M(10), C.muted, "right");
    const bx = x + 12, bw = w - 24, by = y + h - 12;
    ctx.fillStyle = "rgba(255,255,255,0.07)"; rr(bx, by, bw, 5, 3); ctx.fill();
    glow(col, 5 * e, () => { ctx.fillStyle = col; rr(bx, by, Math.max(3, bw * clamp(f.level, 0, 1) * e), 5, 3); ctx.fill(); });
    ctx.globalAlpha = 1;
  }
  frame(_dt: number, now: number) {
    bgGrid();
    text("TRIAGE", 24, 40, D(18), "#fff");
    text(this.running ? "batching…" : this.r ? "one call · one round-trip" : "press Triage a ticket", 150, 40, M(11), this.running ? C.amber : this.r ? C.green : C.muted);
    if (!this.r) {
      text("Ask Jev a whole panel of typed questions about one ticket — in a single request.", 24, 92, M(12.5), C.muted);
      return;
    }
    const r = this.r;
    const mult = (r.seqInputTokens / Math.max(1, r.inputTokens)).toFixed(1);
    const narrow = W < 780;
    let gx: number, gw: number, gy: number;
    if (narrow) {
      // Stacked: compact ticket + metrics across the top, cards full-width below.
      const lines = wrapLines(r.ticket, W - 48, M(11.5)).slice(0, 2);
      lines.forEach((ln, i) => text(ln, 24, 64 + i * 16, M(11.5), C.muted));
      glow(C.jev, 6, () => text(`${r.count} typed decisions · 1 request · ${Math.round(r.latencyMs)}ms · $${r.costUsd.toFixed(6)}`, 24, 108, D(14), "#fff"));
      text(`vs one-by-one: ${fmtTok(r.seqInputTokens)} tok · $${r.seqCostUsd.toFixed(6)} · ${mult}× more`, 24, 128, M(10.5), C.green);
      gx = 24; gw = W - 48; gy = 148;
    } else {
      const LW = clamp(W * 0.36, 260, 430);
      const tx = 24, ty = 70;
      const all = wrapLines(r.ticket, LW - 28, M(12.5));
      const lines = all.length > 7 ? [...all.slice(0, 7), "…"] : all;
      const theight = 30 + lines.length * 18 + 12;
      ctx.fillStyle = C.panel; rr(tx, ty, LW, theight, 12); ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.08)"; ctx.lineWidth = 1; rr(tx, ty, LW, theight, 12); ctx.stroke();
      text("TICKET", tx + 14, ty + 16, M(9.5), C.muted);
      lines.forEach((ln, i) => text(ln, tx + 14, ty + 34 + i * 18, M(12.5), C.text));
      let my = ty + theight + 28;
      glow(C.jev, 8, () => text(`${r.count} typed decisions`, tx, my, D(22), "#fff"));
      my += 26; text(`1 request · ${Math.round(r.latencyMs)}ms · $${r.costUsd.toFixed(6)}`, tx, my, M(12.5), C.cyan);
      my += 20; text(`one-by-one: ${r.count} requests · ${fmtTok(r.seqInputTokens)} tok · $${r.seqCostUsd.toFixed(6)}`, tx, my, M(11), C.muted);
      my += 18; text(`→ batched sends the ticket once — ${mult}× fewer tokens`, tx, my, M(11), C.green);
      gx = tx + LW + 40; gw = W - gx - 24; gy = 74;
    }
    const gap = 12, cardH = 62;
    const cols = Math.max(2, Math.floor(gw / 168));
    const cardW = (gw - gap * (cols - 1)) / cols;
    r.fields.forEach((f, i) => {
      const cx = gx + (i % cols) * (cardW + gap);
      const cy = gy + Math.floor(i / cols) * (cardH + gap);
      this.card(f, cx, cy, cardW, cardH, (now - this.shownAt) / 1000 / 0.28 - i * 0.04);
    });
  }
}

// --- scenes registry + tabs ------------------------------------------------
const scenes: Record<string, Scene> = { router: new RouterScene(), reflex: new StackerScene(), swarm: new SwarmScene(), gauntlet: new GauntletScene(), triage: new TriageScene() };
document.querySelectorAll<HTMLButtonElement>("#tabs button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll("#tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    activate(scenes[b.dataset.scene!]!);
  };
});

// --- ledger (session totals + scrollable transaction history) --------------
const SCENE_COLOR: Record<string, string> = { router: C.jev, reflex: C.amber, swarm: C.violet, gauntlet: C.cyan, triage: C.green };
const fmtTok = (n: number) => (n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "K" : String(Math.round(n)));
const ledger = (() => {
  const list = $("#lg-list"), drawer = $("#ledger");
  const reqEl = $("#lg-req"), tokEl = $("#lg-tok"), costEl = $("#lg-cost");
  let req = 0, tok = 0, cost = 0;
  ($("#ledger-toggle") as HTMLButtonElement).onclick = () => { drawer.hidden = !drawer.hidden; };
  ($("#lg-clear") as HTMLButtonElement).onclick = () => { list.innerHTML = ""; };
  function add(e: TxEntry) {
    req++; tok += e.inputTokens; if (e.live) cost += e.costUsd;
    reqEl.textContent = String(req);
    tokEl.textContent = fmtTok(tok);
    costEl.textContent = cost.toFixed(cost < 0.01 ? 5 : 4);
    const col = SCENE_COLOR[e.scene] ?? C.muted;
    const time = new Date(e.ts).toLocaleTimeString([], { hour12: false });
    const row = document.createElement("div");
    row.className = "lx";
    row.innerHTML =
      `<div class="top"><span class="scene" style="color:${col};border-color:${col}55">${e.scene}</span>` +
      `<span class="in">${esc(e.input)}</span>` +
      (e.live ? "" : `<span class="sim">SIM</span>`) + `</div>` +
      `<div class="sum">${esc(e.summary)}</div>` +
      `<div class="meta"><span>${time}</span><span>${Math.round(e.latencyMs)}ms</span><span>${fmtTok(e.inputTokens)} tok</span><span>$${e.costUsd.toFixed(6)}</span><span style="color:${col}">${esc(e.transport)}</span></div>`;
    row.onclick = () => row.classList.toggle("open");
    list.prepend(row);
    while (list.children.length > 300) list.lastElementChild!.remove();
  }
  return { add };
})();

// --- websocket -------------------------------------------------------------
let ws: WebSocket | null = null;
function send(m: import("../shared/protocol").ClientMsg) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); }
function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
  ws.onopen = () => { if (!scene) activate(scenes.router!); else send({ type: "scene", scene: currentScene() }); };
  ws.onmessage = (ev) => {
    const m: ServerMsg = JSON.parse(ev.data);
    if (m.type === "reload") { location.reload(); return; } // dev hot reload
    if (m.type === "health") applyHealth(m.health);
    else if (m.type === "tx") ledger.add(m.e);
    else scene?.message(m);
  };
  ws.onclose = () => { badge.dataset.mode = "sim"; badgeText.textContent = "reconnecting…"; setTimeout(connect, 1200); };
}
function currentScene(): "router" | "reflex" | "swarm" | "gauntlet" | "triage" {
  const sel = document.querySelector('#tabs button[aria-selected="true"]') as HTMLButtonElement | null;
  return (sel?.dataset.scene as "router" | "reflex" | "swarm" | "gauntlet" | "triage") ?? "router";
}
function applyHealth(h: Health) {
  badge.dataset.mode = h.mode;
  badgeText.textContent = h.mode === "live" ? h.note : "SIM MODE";
  sub.textContent = h.mode === "live" ? h.jevModel : "no key · simulated";
  if (h.mode === "sim") note.textContent = "SIM · decisions generated locally. Add a TypeSafe or OpenRouter key to go LIVE. " + note.textContent;
}

// --- boot ------------------------------------------------------------------
fit();
connect();
let last = performance.now();
function loop(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  scene?.frame(dt, now);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
