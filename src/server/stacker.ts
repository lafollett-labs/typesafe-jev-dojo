/**
 * Pure Tetris engine for the Stacker scene — no Jev, no I/O, fully deterministic.
 *
 * Jev's job (in index.ts) is ONE `choice` per piece over every legal placement this
 * module enumerates; each option is described by the board it produces (lines cleared,
 * holes, height, bumpiness). The SIM fallback picks the max-scoring placement using a
 * well-known genetic-algorithm-tuned heuristic (Yiyuan Lee's weights), so no-key mode
 * still plays beautifully.
 */

export const STACKER_ROWS = 16;
export const STACKER_COLS = 10;
const ROWS = STACKER_ROWS;
const COLS = STACKER_COLS;

/** Color id per tetromino. 0 = empty cell. */
export type PieceId = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const PIECE_IDS: PieceId[] = [1, 2, 3, 4, 5, 6, 7];
export const PIECE_NAMES: Record<PieceId, string> = { 1: "I", 2: "O", 3: "T", 4: "S", 5: "Z", 6: "J", 7: "L" };

/** Spawn shapes as [row, col] cells; rotations are generated programmatically. */
const BASE: Record<PieceId, [number, number][]> = {
  1: [[0, 0], [0, 1], [0, 2], [0, 3]], // I
  2: [[0, 0], [0, 1], [1, 0], [1, 1]], // O
  3: [[0, 0], [0, 1], [0, 2], [1, 1]], // T
  4: [[0, 1], [0, 2], [1, 0], [1, 1]], // S
  5: [[0, 0], [0, 1], [1, 1], [1, 2]], // Z
  6: [[0, 0], [1, 0], [1, 1], [1, 2]], // J
  7: [[0, 2], [1, 0], [1, 1], [1, 2]], // L
};

export interface Shape {
  cells: [number, number][];
  w: number;
  h: number;
}

const idx = (r: number, c: number) => r * COLS + c;

function normalize(cells: [number, number][]): [number, number][] {
  const minR = Math.min(...cells.map((c) => c[0]));
  const minC = Math.min(...cells.map((c) => c[1]));
  return cells.map(([r, c]) => [r - minR, c - minC] as [number, number]);
}
/** 90° clockwise: (r,c) -> (c,-r), then shift back into the top-left corner. */
function rotateCW(cells: [number, number][]): [number, number][] {
  return normalize(cells.map(([r, c]) => [c, -r] as [number, number]));
}
function toShape(cells: [number, number][]): Shape {
  const n = normalize(cells);
  return { cells: n, w: Math.max(...n.map((c) => c[1])) + 1, h: Math.max(...n.map((c) => c[0])) + 1 };
}

/** Unique rotations per piece (O has 1, I/S/Z have 2, T/J/L have 4). */
export const ROTATIONS: Record<PieceId, Shape[]> = (() => {
  const out = {} as Record<PieceId, Shape[]>;
  for (const id of PIECE_IDS) {
    const shapes: Shape[] = [];
    const seen = new Set<string>();
    let cur = normalize(BASE[id]);
    for (let i = 0; i < 4; i++) {
      const s = toShape(cur);
      const key = s.cells.map((c) => c.join(",")).sort().join(";");
      if (!seen.has(key)) { seen.add(key); shapes.push(s); }
      cur = rotateCW(cur);
    }
    out[id] = shapes;
  }
  return out;
})();

export type Grid = number[]; // ROWS*COLS, row-major, 0 = empty.
export const emptyGrid = (): Grid => new Array(ROWS * COLS).fill(0);

/** Topmost filled row in a column, or ROWS if the column is empty. */
function firstFilled(grid: Grid, c: number): number {
  for (let r = 0; r < ROWS; r++) if (grid[idx(r, c)]) return r;
  return ROWS;
}
function columnHeights(grid: Grid): number[] {
  const h: number[] = [];
  for (let c = 0; c < COLS; c++) h.push(ROWS - firstFilled(grid, c));
  return h;
}
function countHoles(grid: Grid): number {
  let holes = 0;
  for (let c = 0; c < COLS; c++) {
    const top = firstFilled(grid, c);
    for (let r = top + 1; r < ROWS; r++) if (!grid[idx(r, c)]) holes++;
  }
  return holes;
}
function bumpiness(hs: number[]): number {
  let b = 0;
  for (let c = 0; c < COLS - 1; c++) b += Math.abs(hs[c]! - hs[c + 1]!);
  return b;
}

/** Resting top row for `shape` dropped in column `col`; < 0 means it tops out (illegal). */
function landingTop(grid: Grid, shape: Shape, col: number): number {
  let t = Infinity;
  for (let pc = 0; pc < shape.w; pc++) {
    let bottom = -1;
    for (const [dr, dc] of shape.cells) if (dc === pc) bottom = Math.max(bottom, dr);
    if (bottom < 0) continue; // column of the piece has no cell
    const ff = firstFilled(grid, col + pc);
    t = Math.min(t, ff - 1 - bottom);
  }
  return t;
}

export interface Locked {
  /** board with the piece locked in, BEFORE clearing full rows (for the drop + flash). */
  snapshot: Grid;
  /** board after full rows clear and everything above collapses down (the next state). */
  collapsed: Grid;
  /** row indices that were full in the snapshot. */
  full: number[];
  /** flat indices of the cells this piece occupies in the snapshot. */
  cells: number[];
}

function collapse(snapshot: Grid, full: number[]): Grid {
  if (!full.length) return snapshot.slice();
  const drop = new Set(full);
  const out = emptyGrid();
  let target = ROWS - 1;
  for (let r = ROWS - 1; r >= 0; r--) {
    if (drop.has(r)) continue;
    for (let c = 0; c < COLS; c++) out[idx(target, c)] = snapshot[idx(r, c)]!;
    target--;
  }
  return out;
}

/** Lock a piece at (rot,col) and resolve the resulting boards. Assumes a legal placement. */
export function lockPiece(grid: Grid, id: PieceId, rot: number, col: number): Locked {
  const shape = ROTATIONS[id][rot]!;
  const t = landingTop(grid, shape, col);
  const snapshot = grid.slice();
  const cells: number[] = [];
  for (const [dr, dc] of shape.cells) {
    const i = idx(t + dr, col + dc);
    snapshot[i] = id;
    cells.push(i);
  }
  const full: number[] = [];
  for (let r = 0; r < ROWS; r++) {
    let filled = true;
    for (let c = 0; c < COLS; c++) if (!snapshot[idx(r, c)]) { filled = false; break; }
    if (filled) full.push(r);
  }
  return { snapshot, collapsed: collapse(snapshot, full), full, cells };
}

/** Yiyuan Lee's GA-tuned weights over [lines, aggHeight, holes, bumpiness] — plays near-perfectly, so SIM looks sharp. */
const W_LINES = 0.760666, W_AGG = -0.510066, W_HOLES = -0.35663, W_BUMP = -0.184483;

export interface Placement {
  key: string; // `${rot}_${col}` — the choice key Jev returns
  rot: number;
  col: number;
  /** footprint of this rotation: cells span columns col..col+w-1 and are h rows tall. */
  w: number;
  h: number;
  lines: number;
  maxHeight: number;
  aggHeight: number;
  holes: number;
  bumpiness: number;
  score: number;
}

/** Every legal placement of `id` on `grid`, each scored on its resulting board. */
export function placementsFor(grid: Grid, id: PieceId): Placement[] {
  const out: Placement[] = [];
  const rots = ROTATIONS[id];
  for (let rot = 0; rot < rots.length; rot++) {
    const shape = rots[rot]!;
    for (let col = 0; col + shape.w <= COLS; col++) {
      const t = landingTop(grid, shape, col);
      if (t < 0) continue; // tops out — not a legal move
      const { collapsed, full } = lockPiece(grid, id, rot, col);
      const hs = columnHeights(collapsed);
      const agg = hs.reduce((a, b) => a + b, 0);
      const holes = countHoles(collapsed);
      const bump = bumpiness(hs);
      const lines = full.length;
      out.push({
        key: `${rot}_${col}`, rot, col, w: shape.w, h: shape.h, lines,
        maxHeight: Math.max(0, ...hs), aggHeight: agg, holes, bumpiness: bump,
        score: W_LINES * lines + W_AGG * agg + W_HOLES * holes + W_BUMP * bump,
      });
    }
  }
  return out;
}

/** Board stats for the scoreboard, computed on a settled (collapsed) grid. */
export function gridStats(grid: Grid): { maxHeight: number; holes: number } {
  const hs = columnHeights(grid);
  return { maxHeight: Math.max(0, ...hs), holes: countHoles(grid) };
}

/**
 * Spatial view of the board for the decision state: a top-to-bottom ASCII matrix
 * ("." empty, "#" filled) plus per-column surface heights. Lets a decision model
 * reason about WHERE to place a piece, not just the resulting outcome numbers.
 */
export function boardView(grid: Grid): { rows: string[]; heights: number[]; maxHeight: number; holes: number } {
  const rows: string[] = [];
  for (let r = 0; r < ROWS; r++) {
    let line = "";
    for (let c = 0; c < COLS; c++) line += grid[idx(r, c)] ? "#" : ".";
    rows.push(line);
  }
  const hs = columnHeights(grid);
  return { rows, heights: hs, maxHeight: Math.max(0, ...hs), holes: countHoles(grid) };
}

/** Fisher-Yates shuffled 7-bag: fair, no droughts, no floods. */
export function sevenBag(): PieceId[] {
  const b = [...PIECE_IDS];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j]!, b[i]!];
  }
  return b;
}
