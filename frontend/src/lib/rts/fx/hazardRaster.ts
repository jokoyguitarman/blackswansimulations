import { FX } from './fxConstants';

export interface RasterLayout {
  minX: number;
  minY: number;
  cellM: number;
  cols: number;
  rows: number;
  /** Stud i → pixel, or -1 when a later stud lost the pixel. */
  index: Int32Array;
  studIds: string[];
  /** Sim position of each stud, parallel to studIds. */
  xs: Float32Array;
  ys: Float32Array;
  /** 1 where a stud owns the pixel. */
  occupied: Uint8Array;
  collisions: number;
}

export interface DirtyBox {
  minC: number;
  minR: number;
  maxC: number;
  maxR: number;
  any: boolean;
}

export function clearDirty(box: DirtyBox): void {
  box.minC = 0;
  box.minR = 0;
  box.maxC = -1;
  box.maxR = -1;
  box.any = false;
}

function markDirty(box: DirtyBox | undefined, col: number, row: number): void {
  if (!box) return;
  if (!box.any) {
    box.minC = col;
    box.maxC = col;
    box.minR = row;
    box.maxR = row;
    box.any = true;
    return;
  }
  if (col < box.minC) box.minC = col;
  if (col > box.maxC) box.maxC = col;
  if (row < box.minR) box.minR = row;
  if (row > box.maxR) box.maxR = row;
}

export function buildRasterLayout(
  studs: ReadonlyArray<{ id: string; simPos: { x: number; y: number } }>,
  cellM: number,
): RasterLayout {
  const n = studs.length;
  const index = new Int32Array(n);
  const studIds: string[] = new Array(n);
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  if (n === 0 || !(cellM > 0)) {
    return {
      minX: 0,
      minY: 0,
      cellM,
      cols: 0,
      rows: 0,
      index,
      studIds,
      xs,
      ys,
      occupied: new Uint8Array(0),
      collisions: 0,
    };
  }
  let minX = Infinity;
  let minY = Infinity;
  for (let i = 0; i < n; i++) {
    const s = studs[i];
    studIds[i] = s.id;
    xs[i] = s.simPos.x;
    ys[i] = s.simPos.y;
    if (s.simPos.x < minX) minX = s.simPos.x;
    if (s.simPos.y < minY) minY = s.simPos.y;
  }
  const colOf = new Int32Array(n);
  const rowOf = new Int32Array(n);
  let maxC = 0;
  let maxR = 0;
  for (let i = 0; i < n; i++) {
    const s = studs[i].simPos;
    const c = Math.round((s.x - minX) / cellM);
    const r = Math.round((s.y - minY) / cellM);
    colOf[i] = c;
    rowOf[i] = r;
    if (c > maxC) maxC = c;
    if (r > maxR) maxR = r;
  }
  const cols = maxC + 1;
  const rows = maxR + 1;
  const owner = new Int32Array(cols * rows);
  owner.fill(-1);
  let collisions = 0;
  for (let i = 0; i < n; i++) {
    const p = rowOf[i] * cols + colOf[i];
    if (owner[p] !== -1) {
      index[i] = -1;
      collisions++;
      continue;
    }
    owner[p] = i;
    index[i] = p;
  }
  const occupied = new Uint8Array(cols * rows);
  for (let i = 0; i < n; i++) {
    const p = index[i];
    if (p >= 0) occupied[p] = 1;
  }
  return { minX, minY, cellM, cols, rows, index, studIds, xs, ys, occupied, collisions };
}

function smokeRgb(h: number, channel: 0 | 1 | 2): number {
  const from = channel === 2 ? 98 : 88;
  const to = channel === 2 ? 46 : 40;
  return Math.round(from + (to - from) * h);
}

/** Straight alpha matching the showcase overlay. Returns how many pixels changed. */
export function writeSmokeRGBA(
  layout: RasterLayout,
  states: ReadonlyMap<string, { smoke: number }>,
  out: Uint8ClampedArray,
  headSmoke: (d: number) => number,
  dirty?: DirtyBox,
): number {
  let changed = 0;
  const cols = layout.cols;
  for (let i = 0; i < layout.index.length; i++) {
    const p = layout.index[i];
    if (p < 0) continue;
    const st = states.get(layout.studIds[i]);
    const d = st?.smoke ?? 0;
    let a = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    if (d >= 0.05) {
      const h = headSmoke(d);
      a = Math.round(
        255 * (FX.SMOKE_ALPHA_MIN + (FX.SMOKE_ALPHA_MAX - FX.SMOKE_ALPHA_MIN) * h),
      );
      r = smokeRgb(h, 0);
      g = smokeRgb(h, 1);
      b = smokeRgb(h, 2);
    }
    const o = p * 4;
    if (out[o] !== r || out[o + 1] !== g || out[o + 2] !== b || out[o + 3] !== a) {
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
      changed++;
      markDirty(dirty, p % cols, (p / cols) | 0);
    }
  }
  return changed;
}

export function writeFireRGBA(
  layout: RasterLayout,
  states: ReadonlyMap<string, { fire: { state: string } }>,
  out: Uint8ClampedArray,
  dirty?: DirtyBox,
): number {
  let changed = 0;
  const cols = layout.cols;
  for (let i = 0; i < layout.index.length; i++) {
    const p = layout.index[i];
    if (p < 0) continue;
    const st = states.get(layout.studIds[i]);
    const state = st?.fire.state ?? 'none';
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    if (state === 'burning') {
      r = 245;
      g = 107;
      b = 64;
      a = 191;
    } else if (state === 'heating') {
      r = 251;
      g = 146;
      b = 60;
      a = 115;
    } else if (state === 'burnt_out') {
      r = 60;
      g = 60;
      b = 60;
      a = 128;
    }
    const o = p * 4;
    if (out[o] !== r || out[o + 1] !== g || out[o + 2] !== b || out[o + 3] !== a) {
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
      changed++;
      markDirty(dirty, p % cols, (p / cols) | 0);
    }
  }
  return changed;
}

function sampleOccupied(
  out: Uint8ClampedArray,
  occupied: Uint8Array,
  cols: number,
  rows: number,
  c: number,
  r: number,
  acc: Int32Array,
): void {
  if (c < 0 || r < 0 || c >= cols || r >= rows) return;
  const q = r * cols + c;
  if (!occupied[q]) return;
  const o = q * 4;
  const a = out[o + 3];
  if (a === 0) return;
  acc[0]++;
  acc[1] += out[o];
  acc[2] += out[o + 1];
  acc[3] += out[o + 2];
  acc[4] += a;
}

const DILATE_ACC = new Int32Array(5);

/** Empty cells take half the average alpha of occupied neighbours. Occupied cells stay put. */
export function dilateEmpty(
  out: Uint8ClampedArray,
  cols: number,
  rows: number,
  occupied: Uint8Array,
): void {
  if (cols <= 0 || rows <= 0) return;
  const acc = DILATE_ACC;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const p = r * cols + c;
      if (occupied[p]) continue;
      acc[0] = 0;
      acc[1] = 0;
      acc[2] = 0;
      acc[3] = 0;
      acc[4] = 0;
      sampleOccupied(out, occupied, cols, rows, c - 1, r, acc);
      sampleOccupied(out, occupied, cols, rows, c + 1, r, acc);
      sampleOccupied(out, occupied, cols, rows, c, r - 1, acc);
      sampleOccupied(out, occupied, cols, rows, c, r + 1, acc);
      const n = acc[0];
      const o = p * 4;
      if (n === 0) {
        out[o] = 0;
        out[o + 1] = 0;
        out[o + 2] = 0;
        out[o + 3] = 0;
        continue;
      }
      out[o] = Math.round(acc[1] / n);
      out[o + 1] = Math.round(acc[2] / n);
      out[o + 2] = Math.round(acc[3] / n);
      out[o + 3] = Math.round(acc[4] / n / 2);
    }
  }
}

/** 0 none, 1 burning, 2 other. Grown only when the raster gets larger. */
let fireScratch = new Uint8Array(256 * 256);

function fireCode(state: string): number {
  if (state === 'burning') return 1;
  if (state === 'none' || state === '') return 0;
  return 2;
}

/** edgeDir: 0 east, 1 south, 2 west, 3 north. Packed as (pixel << 2) | edgeDir. */
export function frontCells(
  layout: RasterLayout,
  states: ReadonlyMap<string, { fire: { state: string } }>,
  outEdges: Int32Array,
): number {
  const cols = layout.cols;
  const rows = layout.rows;
  const cells = cols * rows;
  if (cells === 0) return 0;
  if (fireScratch.length < cells) fireScratch = new Uint8Array(cells);
  fireScratch.fill(0, 0, cells);
  for (let i = 0; i < layout.index.length; i++) {
    const p = layout.index[i];
    if (p < 0) continue;
    fireScratch[p] = fireCode(states.get(layout.studIds[i])?.fire.state ?? 'none');
  }
  let count = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const p = r * cols + c;
      if (fireScratch[p] !== 1) continue;
      if (count < outEdges.length && c + 1 < cols && fireScratch[p + 1] === 0) {
        outEdges[count++] = (p << 2) | 0;
      }
      if (count < outEdges.length && r + 1 < rows && fireScratch[p + cols] === 0) {
        outEdges[count++] = (p << 2) | 1;
      }
      if (count < outEdges.length && c - 1 >= 0 && fireScratch[p - 1] === 0) {
        outEdges[count++] = (p << 2) | 2;
      }
      if (count < outEdges.length && r - 1 >= 0 && fireScratch[p - cols] === 0) {
        outEdges[count++] = (p << 2) | 3;
      }
    }
  }
  return count;
}

/** Heating studs, one pixel index each. */
export function pulseCells(
  layout: RasterLayout,
  states: ReadonlyMap<string, { fire: { state: string } }>,
  out: Int32Array,
): number {
  let count = 0;
  for (let i = 0; i < layout.index.length; i++) {
    const p = layout.index[i];
    if (p < 0 || count >= out.length) continue;
    if (states.get(layout.studIds[i])?.fire.state === 'heating') out[count++] = p;
  }
  return count;
}
