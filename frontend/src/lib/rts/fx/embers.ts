import { FX } from './fxConstants';

const DRIFT_COS = Math.cos((FX.DRIFT_DIR * Math.PI) / 180);
const DRIFT_SIN = Math.sin((FX.DRIFT_DIR * Math.PI) / 180);

/**
 * Structure-of-arrays ember pool. spawn and update allocate nothing after init.
 * Positions are sim metres. Screen rise is applied by the drawer.
 */
export class EmberPool {
  readonly capacity: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  readonly size: Float32Array;
  readonly alive: Uint8Array;
  readonly born: Uint32Array;
  aliveCount = 0;
  private clock = 0;

  constructor(capacity = FX.EMBER_CAP_HIGH) {
    this.capacity = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.alive = new Uint8Array(capacity);
    this.born = new Uint32Array(capacity);
  }

  spawn(px: number, py: number, rng: () => number, limit = this.capacity): void {
    const cap = limit > 0 && limit < this.capacity ? limit : this.capacity;
    let slot = -1;
    if (this.aliveCount < cap) {
      for (let i = 0; i < this.capacity; i++) {
        if (this.alive[i] === 0) {
          slot = i;
          break;
        }
      }
    } else {
      let oldest = -1;
      let born = 0xffffffff;
      for (let i = 0; i < this.capacity; i++) {
        if (this.alive[i] !== 0 && this.born[i] < born) {
          born = this.born[i];
          oldest = i;
        }
      }
      slot = oldest;
    }
    if (slot < 0) return;
    const wasDead = this.alive[slot] === 0;
    this.alive[slot] = 1;
    if (wasDead) this.aliveCount++;
    this.clock++;
    this.born[slot] = this.clock;
    this.x[slot] = px;
    this.y[slot] = py;
    const jitterX = (rng() - 0.5) * 0.8;
    const jitterY = (rng() - 0.5) * 0.8;
    this.vx[slot] = DRIFT_COS * FX.EMBER_DRIFT_M_S + jitterX;
    // Sim +y is south, so screen-north drift is negative y.
    this.vy[slot] = -DRIFT_SIN * FX.EMBER_DRIFT_M_S + jitterY;
    this.age[slot] = 0;
    this.life[slot] = FX.EMBER_LIFE_S[0] + rng() * (FX.EMBER_LIFE_S[1] - FX.EMBER_LIFE_S[0]);
    this.size[slot] = 1 + rng() * 1.5;
  }

  /** Clamps dt to 0.1 s so a hidden tab does not teleport embers. */
  update(dt: number): void {
    const step = dt > 0.1 ? 0.1 : dt > 0 ? dt : 0;
    if (step === 0) return;
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i] === 0) continue;
      const age = this.age[i] + step;
      if (age >= this.life[i]) {
        this.alive[i] = 0;
        this.aliveCount--;
        continue;
      }
      this.age[i] = age;
      this.x[i] += this.vx[i] * step;
      this.y[i] += this.vy[i] * step;
    }
  }

  forEachAlive(cb: (slot: number) => void): void {
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i]) cb(i);
    }
  }

  /** Drop the oldest until `cap` remain. Used when quality falls to Low. */
  trim(cap: number): void {
    while (this.aliveCount > cap) {
      let oldest = -1;
      let born = 0xffffffff;
      for (let i = 0; i < this.capacity; i++) {
        if (this.alive[i] && this.born[i] < born) {
          born = this.born[i];
          oldest = i;
        }
      }
      if (oldest < 0) return;
      this.alive[oldest] = 0;
      this.aliveCount--;
    }
  }
}
