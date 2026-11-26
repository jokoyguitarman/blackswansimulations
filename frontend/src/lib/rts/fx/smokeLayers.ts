import type { SmokeLayerView } from '../spatialEffects';
import { FX } from './fxConstants';

/** Per-stud tint of the room's upper layer, parallel to the stud list it was built for. */
export interface LayerShade {
  /** 0..1 opacity seen from above. */
  alpha: Float32Array;
  /** 0 light grey, 1 near black. */
  dark: Float32Array;
  /** Studs with a visible tint. */
  count: number;
}

export function createLayerShade(n: number): LayerShade {
  return { alpha: new Float32Array(n), dark: new Float32Array(n), count: 0 };
}

/**
 * Looking down through a layer of depth d and extinction K lets through
 * exp(-K d) of the floor, so 1 - exp(-K d) is how much of the room is hidden.
 * Fuller rooms read heavier, and the gas near a burning stud reads darker.
 */
export function shadeLayers(
  indexOf: ReadonlyMap<string, number>,
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  layers: readonly SmokeLayerView[] | null,
  states: ReadonlyMap<string, { fire: { state: string } }> | null,
  out: LayerShade,
  nearFire = true,
): LayerShade {
  out.alpha.fill(0);
  out.dark.fill(0);
  out.count = 0;
  if (!layers || layers.length === 0) return out;
  // Every burning stud on the storey, so the side of a neighbouring room by the fire reads darker too.
  const burnX: number[] = [];
  const burnY: number[] = [];
  if (nearFire && states) {
    for (const [id, i] of indexOf) {
      if (states.get(id)?.fire.state !== 'burning') continue;
      burnX.push(xs[i]);
      burnY.push(ys[i]);
    }
  }
  const stride = Math.max(1, Math.ceil(burnX.length / FX.LAYER_FIRE_SAMPLES));
  const falloff = FX.LAYER_NEAR_FIRE_M;
  for (const layer of layers) {
    const depth = layer.depthM > 0 ? layer.depthM : 0;
    const k = layer.extinctionK > 0 ? layer.extinctionK : 0;
    const optical = 1 - Math.exp(-k * depth);
    if (!(optical > 0)) continue;
    const fill = layer.ceilingM > 0 ? Math.min(1, depth / layer.ceilingM) : 0;
    const base = Math.max(
      FX.LAYER_ALPHA_MIN,
      FX.LAYER_ALPHA_MAX * optical * (FX.LAYER_FILL_FLOOR + (1 - FX.LAYER_FILL_FLOOR) * fill),
    );
    const hot = Math.max(0, Math.min(1, (layer.upperK - 293) / FX.LAYER_HOT_RISE_K));
    for (const id of layer.members) {
      const i = indexOf.get(id);
      if (i == null) continue;
      let near = 0;
      if (burnX.length > 0) {
        let best = Infinity;
        const x = xs[i];
        const y = ys[i];
        for (let b = 0; b < burnX.length; b += stride) {
          const dx = burnX[b] - x;
          const dy = burnY[b] - y;
          const d2 = dx * dx + dy * dy;
          if (d2 < best) best = d2;
        }
        near = Math.exp(-Math.max(0, Math.sqrt(best) - FX.LAYER_NEAR_FIRE_CORE_M) / falloff);
      }
      const a = base + (FX.LAYER_ALPHA_MAX - base) * 0.6 * near;
      if (a > out.alpha[i]) {
        if (out.alpha[i] === 0) out.count++;
        out.alpha[i] = a;
        out.dark[i] = Math.min(1, 0.1 * fill + 0.15 * hot + 0.85 * near);
      }
    }
  }
  return out;
}

/**
 * Pale haze to charcoal. The building floor draws as mid grey, so the far
 * smoke stays light and only the smoke by the fire goes dark.
 */
export function layerRgb(dark: number, channel: 0 | 1 | 2): number {
  const from = channel === 0 ? 206 : channel === 1 ? 209 : 216;
  const to = channel === 0 ? 32 : channel === 1 ? 29 : 28;
  return from + (to - from) * dark;
}
