import type { RenderContext } from '../renderer';
import { FX, type FxQuality } from './fxConstants';
import { EmberPool } from './embers';
import {
  clearDirty,
  dilateEmpty,
  frontCells,
  pulseCells,
  writeFireRGBA,
  writeSmokeRGBA,
  type DirtyBox,
  type RasterLayout,
} from './hazardRaster';
import { headSmoke } from '../../evacuation/hazardSensing';
import { makeValueNoiseTexture } from './noise';

export interface HazardFxContext {
  quality: FxQuality;
  reducedMotion: boolean;
  nowMs: number;
  layout: RasterLayout | null;
  states: ReadonlyMap<string, { smoke: number; fire: { state: string } }> | null;
  buildingVerts: readonly { x: number; y: number }[];
  cellM: number;
}

export interface HazardFxStats {
  ms: number;
  embers: number;
}

/** Longest side of the offscreen smoke blend. It is scaled up onto the map. */
const MAX_MASK = 384;
const STYLE_PULSE = '#fb923c';
const STYLE_EDGE = 'rgba(251, 146, 60, 0.9)';
const EMBER_STYLES: string[] = [];
for (let i = 0; i < 8; i++) {
  const u = i / 7;
  const r = Math.round(255 + (239 - 255) * u);
  const g = Math.round(220 + (68 - 220) * u);
  const b = Math.round(120 + (68 - 120) * u);
  EMBER_STYLES.push(`rgb(${r},${g},${b})`);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStud(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 4294967296) * Math.PI * 2;
}

function radialSprite(size: number, inner: string, outer: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) return canvas;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return canvas;
}

function canvasX(rc: RenderContext, x: number): number {
  return (x - rc.bounds.minX) * rc.scale + rc.padX;
}

function canvasY(rc: RenderContext, y: number): number {
  return (y - rc.bounds.minY) * rc.scale + rc.padY;
}

/**
 * Draws the hazard overlay. Reads effect state and never writes it.
 * Owns its own RNG so the picture cannot change the simulation.
 */
export class HazardFxRenderer {
  readonly pool: EmberPool;
  readonly last: HazardFxStats = { ms: 0, embers: 0 };
  private readonly rng: () => number;
  private readonly smokeCanvas: HTMLCanvasElement;
  private readonly fireCanvas: HTMLCanvasElement;
  private readonly halfSmoke: HTMLCanvasElement;
  private readonly halfFire: HTMLCanvasElement;
  private readonly mask: HTMLCanvasElement;
  private readonly punch: HTMLCanvasElement;
  private readonly noise: HTMLCanvasElement;
  private readonly glow: HTMLCanvasElement;
  private readonly inner: HTMLCanvasElement;
  private readonly noisePattern: CanvasPattern | null;
  private smokeImage: ImageData;
  private fireImage: ImageData;
  private edges: Int32Array;
  private pulses: Int32Array;
  private readonly dirtySmoke: DirtyBox = { minC: 0, minR: 0, maxC: -1, maxR: -1, any: false };
  private readonly dirtyFire: DirtyBox = { minC: 0, minR: 0, maxC: -1, maxR: -1, any: false };
  private phi = new Float32Array(0);
  private bound: RasterLayout | null = null;
  private cols = 0;
  private rows = 0;
  private lastNowMs = -1;
  private pendingMs = 0;
  private drew = false;
  private disposed = false;

  constructor(seed = FX.FX_RNG_SEED) {
    this.rng = mulberry32(seed);
    this.pool = new EmberPool(FX.EMBER_CAP_HIGH);
    this.smokeCanvas = document.createElement('canvas');
    this.fireCanvas = document.createElement('canvas');
    this.halfSmoke = document.createElement('canvas');
    this.halfFire = document.createElement('canvas');
    this.mask = document.createElement('canvas');
    this.punch = document.createElement('canvas');
    this.noise = document.createElement('canvas');
    this.glow = radialSprite(64, 'rgba(251,146,60,0.9)', 'rgba(251,146,60,0)');
    this.inner = radialSprite(64, 'rgba(255,244,180,0.95)', 'rgba(255,244,180,0)');
    const img = makeValueNoiseTexture(FX.NOISE_SIZE, seed);
    this.noise.width = FX.NOISE_SIZE;
    this.noise.height = FX.NOISE_SIZE;
    this.noise.getContext('2d')?.putImageData(img, 0, 0);
    const patternHost = document.createElement('canvas').getContext('2d');
    this.noisePattern = patternHost?.createPattern(this.noise, 'repeat') ?? null;
    this.smokeImage = new ImageData(1, 1);
    this.fireImage = new ImageData(1, 1);
    this.edges = new Int32Array(4);
    this.pulses = new Int32Array(1);
  }

  draw(ctx: CanvasRenderingContext2D, rc: RenderContext, fx: HazardFxContext): HazardFxStats {
    const t0 = performance.now();
    this.drew = false;
    if (this.disposed || fx.quality === 'classic') {
      this.last.ms = 0;
      this.last.embers = 0;
      return this.last;
    }
    const layout = fx.layout;
    const states = fx.states;
    this.advanceEmbers(fx, layout, states);
    if (layout && states && layout.cols > 0 && layout.rows > 0) {
      this.bind(layout);
      this.writeRasters(layout, states);
      this.paintGround(ctx, rc, fx, layout);
      this.drew = true;
    }
    this.pendingMs = performance.now() - t0;
    this.last.ms = this.pendingMs;
    this.last.embers = fx.reducedMotion ? 0 : this.pool.aliveCount;
    return this.last;
  }

  /** Flicker and embers, after pedestrians so people stay visible under the glow. */
  drawAbove(ctx: CanvasRenderingContext2D, rc: RenderContext, fx: HazardFxContext): void {
    if (!this.drew || this.disposed || fx.quality === 'classic') return;
    const t0 = performance.now();
    const layout = fx.layout;
    const states = fx.states;
    if (!layout || !states) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    this.paintFlicker(ctx, rc, fx, layout, states);
    if (!fx.reducedMotion) this.paintEmbers(ctx, rc);
    ctx.restore();
    this.last.ms = this.pendingMs + (performance.now() - t0);
    this.drew = false;
  }

  dispose(): void {
    this.disposed = true;
    this.smokeCanvas.width = 0;
    this.fireCanvas.width = 0;
    this.halfSmoke.width = 0;
    this.halfFire.width = 0;
    this.mask.width = 0;
    this.punch.width = 0;
    this.noise.width = 0;
    this.bound = null;
  }

  private advanceEmbers(
    fx: HazardFxContext,
    layout: RasterLayout | null,
    states: ReadonlyMap<string, { smoke: number; fire: { state: string } }> | null,
  ): void {
    const raw = this.lastNowMs < 0 ? 0 : (fx.nowMs - this.lastNowMs) / 1000;
    this.lastNowMs = fx.nowMs;
    if (fx.reducedMotion) return;
    const dt = raw > 0.1 ? 0.1 : raw > 0 ? raw : 0;
    const cap = fx.quality === 'low' ? FX.EMBER_CAP_LOW : FX.EMBER_CAP_HIGH;
    if (this.pool.aliveCount > cap) this.pool.trim(cap);
    this.pool.update(dt);
    if (!layout || !states || !(dt > 0)) return;
    const chance = FX.EMBER_RATE_PER_STUD_S * dt;
    const n = layout.studIds.length;
    for (let i = 0; i < n; i++) {
      const st = states.get(layout.studIds[i]);
      if (st?.fire.state !== 'burning') continue;
      if (this.rng() < chance) this.pool.spawn(layout.xs[i], layout.ys[i], this.rng, cap);
    }
  }

  private bind(layout: RasterLayout): void {
    const same =
      this.bound === layout && this.cols === layout.cols && this.rows === layout.rows;
    if (same) return;
    this.bound = layout;
    const n = layout.studIds.length;
    if (this.phi.length < n) this.phi = new Float32Array(n);
    for (let i = 0; i < n; i++) this.phi[i] = hashStud(layout.studIds[i]);
    this.ensureSize(layout.cols, layout.rows);
  }

  private ensureSize(cols: number, rows: number): void {
    if (this.cols === cols && this.rows === rows && this.smokeImage.width === cols) return;
    this.cols = cols;
    this.rows = rows;
    this.smokeCanvas.width = cols;
    this.fireCanvas.width = cols;
    this.smokeCanvas.height = rows;
    this.fireCanvas.height = rows;
    this.smokeImage = new ImageData(cols, rows);
    this.fireImage = new ImageData(cols, rows);
    const cells = cols * rows;
    this.edges = new Int32Array(cells * 4);
    this.pulses = new Int32Array(cells);
    const hw = Math.max(1, Math.ceil(cols / 2));
    const hh = Math.max(1, Math.ceil(rows / 2));
    this.halfSmoke.width = hw;
    this.halfSmoke.height = hh;
    this.halfFire.width = hw;
    this.halfFire.height = hh;
  }

  private writeRasters(
    layout: RasterLayout,
    states: ReadonlyMap<string, { smoke: number; fire: { state: string } }>,
  ): void {
    clearDirty(this.dirtySmoke);
    clearDirty(this.dirtyFire);
    const smokeChanged = writeSmokeRGBA(
      layout,
      states,
      this.smokeImage.data,
      headSmoke,
      this.dirtySmoke,
    );
    dilateEmpty(this.smokeImage.data, layout.cols, layout.rows, layout.occupied);
    const fireChanged = writeFireRGBA(layout, states, this.fireImage.data, this.dirtyFire);
    this.upload(this.smokeCanvas, this.smokeImage, this.dirtySmoke, smokeChanged, layout.cols, layout.rows, 1);
    this.upload(this.fireCanvas, this.fireImage, this.dirtyFire, fireChanged, layout.cols, layout.rows, 0);
  }

  private upload(
    canvas: HTMLCanvasElement,
    image: ImageData,
    dirty: DirtyBox,
    changed: number,
    cols: number,
    rows: number,
    pad: number,
  ): void {
    if (changed <= 0) return;
    const g = canvas.getContext('2d');
    if (!g) return;
    const cells = cols * rows;
    if (!dirty.any || changed > cells * 0.25) {
      g.putImageData(image, 0, 0);
      return;
    }
    let x = dirty.minC - pad;
    let y = dirty.minR - pad;
    let w = dirty.maxC - dirty.minC + 1 + pad * 2;
    let h = dirty.maxR - dirty.minR + 1 + pad * 2;
    if (x < 0) {
      w += x;
      x = 0;
    }
    if (y < 0) {
      h += y;
      y = 0;
    }
    if (x + w > cols) w = cols - x;
    if (y + h > rows) h = rows - y;
    if (w <= 0 || h <= 0) return;
    g.putImageData(image, 0, 0, x, y, w, h);
  }

  private paintGround(
    ctx: CanvasRenderingContext2D,
    rc: RenderContext,
    fx: HazardFxContext,
    layout: RasterLayout,
  ): void {
    const cell = layout.cellM;
    const dw = layout.cols * cell * rc.scale;
    const dh = layout.rows * cell * rc.scale;
    if (!(dw > 1) || !(dh > 1)) return;
    const dx = canvasX(rc, layout.minX - cell / 2);
    const dy = canvasY(rc, layout.minY - cell / 2);
    const low = fx.quality === 'low';
    if (low) {
      this.blitHalf(this.smokeCanvas, this.halfSmoke);
      this.blitHalf(this.fireCanvas, this.halfFire);
    }
    ctx.save();
    this.clipBuilding(ctx, rc, fx.buildingVerts);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = low ? 'low' : 'high';
    const smokeSrc = low ? this.halfSmoke : this.smokeCanvas;
    const fireSrc = low ? this.halfFire : this.fireCanvas;
    this.paintSmoke(ctx, rc, fx, smokeSrc, dx, dy, dw, dh);
    ctx.drawImage(fireSrc, dx, dy, dw, dh);
    this.paintFront(ctx, rc, fx, layout);
    ctx.restore();
  }

  private blitHalf(src: HTMLCanvasElement, dest: HTMLCanvasElement): void {
    const g = dest.getContext('2d');
    if (!g) return;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'low';
    g.clearRect(0, 0, dest.width, dest.height);
    g.drawImage(src, 0, 0, dest.width, dest.height);
  }

  private clipBuilding(
    ctx: CanvasRenderingContext2D,
    rc: RenderContext,
    verts: readonly { x: number; y: number }[],
  ): void {
    if (verts.length < 3) return;
    ctx.beginPath();
    ctx.moveTo(canvasX(rc, verts[0].x), canvasY(rc, verts[0].y));
    for (let i = 1; i < verts.length; i++) {
      ctx.lineTo(canvasX(rc, verts[i].x), canvasY(rc, verts[i].y));
    }
    ctx.closePath();
    ctx.clip();
  }

  private paintSmoke(
    ctx: CanvasRenderingContext2D,
    rc: RenderContext,
    fx: HazardFxContext,
    smokeSrc: HTMLCanvasElement,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void {
    let mw = Math.ceil(dw);
    let mh = Math.ceil(dh);
    const side = mw > mh ? mw : mh;
    if (side > MAX_MASK) {
      const k = MAX_MASK / side;
      mw = Math.max(1, Math.round(mw * k));
      mh = Math.max(1, Math.round(mh * k));
    }
    if (mw < 1 || mh < 1) return;
    if (this.mask.width !== mw || this.mask.height !== mh) {
      this.mask.width = mw;
      this.mask.height = mh;
      this.punch.width = mw;
      this.punch.height = mh;
    }
    const g = this.mask.getContext('2d');
    const punch = this.punch.getContext('2d');
    if (!g || !punch) {
      ctx.drawImage(smokeSrc, dx, dy, dw, dh);
      return;
    }
    const sx = mw / dw;
    const sy = mh / dh;
    const smooth = fx.quality === 'low' ? 'low' : 'high';
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.clearRect(0, 0, mw, mh);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = smooth;
    g.drawImage(smokeSrc, 0, 0, mw, mh);

    punch.setTransform(1, 0, 0, 1, 0, 0);
    punch.globalCompositeOperation = 'source-over';
    punch.globalAlpha = 1;
    punch.clearRect(0, 0, mw, mh);
    const t = fx.nowMs / 1000;
    const speed = fx.reducedMotion
      ? 0
      : FX.DRIFT_SPEED_PX_S * (fx.quality === 'low' ? 0.5 : 1);
    const ang = (FX.DRIFT_DIR * Math.PI) / 180;
    const tile = FX.NOISE_SCALE_M * rc.scale * sx;
    this.tileNoise(
      punch,
      mw,
      mh,
      tile,
      Math.cos(ang) * speed * t * sx,
      -Math.sin(ang) * speed * t * sy,
    );
    if (fx.quality === 'high') {
      const ang2 = ((FX.DRIFT_DIR + 35) * Math.PI) / 180;
      const speed2 = speed * 0.6;
      this.tileNoise(
        punch,
        mw,
        mh,
        tile * 0.5,
        Math.cos(ang2) * speed2 * t * sx,
        -Math.sin(ang2) * speed2 * t * sy,
      );
    }
    // Keep noise only where smoke already is, so it cannot add smoke.
    punch.globalCompositeOperation = 'destination-in';
    punch.drawImage(this.mask, 0, 0);
    g.globalCompositeOperation = 'destination-out';
    g.globalAlpha = FX.NOISE_STRENGTH;
    g.drawImage(this.punch, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    ctx.drawImage(this.mask, dx, dy, dw, dh);
  }

  private tileNoise(
    g: CanvasRenderingContext2D,
    mw: number,
    mh: number,
    tile: number,
    ox: number,
    oy: number,
  ): void {
    const pattern = this.noisePattern;
    if (!pattern || !(tile >= 1)) return;
    const scale = tile / FX.NOISE_SIZE;
    const inv = 1 / scale;
    g.save();
    g.setTransform(scale, 0, 0, scale, -mod(ox, tile), -mod(oy, tile));
    g.fillStyle = pattern;
    g.fillRect(mod(ox, tile) * inv, mod(oy, tile) * inv, mw * inv, mh * inv);
    g.restore();
  }

  private paintFront(
    ctx: CanvasRenderingContext2D,
    rc: RenderContext,
    fx: HazardFxContext,
    layout: RasterLayout,
  ): void {
    const states = fx.states;
    if (!states) return;
    const pulses = pulseCells(layout, states, this.pulses);
    if (pulses > 0) {
      const t = fx.nowMs / 1000;
      ctx.save();
      ctx.strokeStyle = STYLE_PULSE;
      ctx.globalAlpha = fx.reducedMotion
        ? 0.7
        : 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(2 * Math.PI * FX.FRONT_PULSE_HZ * t));
      ctx.lineWidth = Math.max(1, 0.12 * rc.scale);
      const radius = (layout.cellM * rc.scale) / 2;
      for (let i = 0; i < pulses; i++) {
        const p = this.pulses[i];
        const col = p % layout.cols;
        const row = (p / layout.cols) | 0;
        const wx = layout.minX + col * layout.cellM;
        const wy = layout.minY + row * layout.cellM;
        ctx.beginPath();
        ctx.arc(canvasX(rc, wx), canvasY(rc, wy), radius, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (fx.quality !== 'high') return;
    const edges = frontCells(layout, states, this.edges);
    if (edges <= 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = STYLE_EDGE;
    ctx.lineWidth = 0.6 * rc.scale;
    const half = layout.cellM / 2;
    for (let i = 0; i < edges; i++) {
      const packed = this.edges[i];
      const pixel = packed >> 2;
      const dir = packed & 3;
      const col = pixel % layout.cols;
      const row = (pixel / layout.cols) | 0;
      const cx = layout.minX + col * layout.cellM;
      const cy = layout.minY + row * layout.cellM;
      let x1 = cx;
      let y1 = cy;
      let x2 = cx;
      let y2 = cy;
      if (dir === 0) {
        x1 = cx + half;
        y1 = cy - half;
        x2 = cx + half;
        y2 = cy + half;
      } else if (dir === 1) {
        x1 = cx - half;
        y1 = cy + half;
        x2 = cx + half;
        y2 = cy + half;
      } else if (dir === 2) {
        x1 = cx - half;
        y1 = cy - half;
        x2 = cx - half;
        y2 = cy + half;
      } else {
        x1 = cx - half;
        y1 = cy - half;
        x2 = cx + half;
        y2 = cy - half;
      }
      ctx.beginPath();
      ctx.moveTo(canvasX(rc, x1), canvasY(rc, y1));
      ctx.lineTo(canvasX(rc, x2), canvasY(rc, y2));
      ctx.stroke();
    }
    ctx.restore();
  }

  private paintFlicker(
    ctx: CanvasRenderingContext2D,
    rc: RenderContext,
    fx: HazardFxContext,
    layout: RasterLayout,
    states: ReadonlyMap<string, { fire: { state: string } }>,
  ): void {
    const t = fx.nowMs / 1000;
    const n = layout.studIds.length;
    for (let i = 0; i < n; i++) {
      if (states.get(layout.studIds[i])?.fire.state !== 'burning') continue;
      let wobble = 0;
      if (!fx.reducedMotion) {
        const phi = this.phi[i];
        wobble =
          Math.sin(2 * Math.PI * 1.3 * t + phi) * 0.6 +
          Math.sin(2 * Math.PI * 3.1 * t + 1.7 * phi) * 0.4;
      }
      const radius = layout.cellM * (0.9 + FX.FLICKER_AMP * wobble) * rc.scale;
      const sx = canvasX(rc, layout.xs[i]);
      const sy = canvasY(rc, layout.ys[i]);
      ctx.globalAlpha = 0.55;
      ctx.drawImage(this.glow, sx - radius, sy - radius, radius * 2, radius * 2);
      if (fx.quality === 'high' && !fx.reducedMotion) {
        const inner = radius * 0.45;
        ctx.globalAlpha = 0.4;
        ctx.drawImage(this.inner, sx - inner, sy - inner, inner * 2, inner * 2);
      }
    }
  }

  private paintEmbers(ctx: CanvasRenderingContext2D, rc: RenderContext): void {
    const viewW = rc.bounds.maxX - rc.bounds.minX;
    const viewH = rc.bounds.maxY - rc.bounds.minY;
    const canvasW = viewW * rc.scale + rc.padX * 2;
    const canvasH = viewH * rc.scale + rc.padY * 2;
    const pool = this.pool;
    ctx.globalCompositeOperation = 'source-over';
    let style = -1;
    for (let i = 0; i < pool.capacity; i++) {
      if (pool.alive[i] === 0) continue;
      const sx = canvasX(rc, pool.x[i]);
      const sy = canvasY(rc, pool.y[i]) - 6 * pool.age[i];
      if (sx < -8 || sy < -8 || sx > canvasW + 8 || sy > canvasH + 8) continue;
      const life = pool.life[i] > 0 ? pool.life[i] : 1;
      const u = pool.age[i] / life;
      if (u >= 1) continue;
      const bucket = (u * 7) | 0;
      if (bucket !== style) {
        style = bucket;
        ctx.fillStyle = EMBER_STYLES[bucket];
      }
      ctx.globalAlpha = 1 - u;
      const size = pool.size[i];
      ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
    }
  }
}

function mod(value: number, tile: number): number {
  const m = value % tile;
  return m < 0 ? m + tile : m;
}
