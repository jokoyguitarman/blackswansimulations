import {
  LINING,
  coldSurfaceIncidentKwM2,
  diameterForReleaseKw,
  effectiveHeatLossKwM2K,
  freshLayer,
  mqhFlashoverKw,
  stepZone,
  type LayerSpec,
} from '../../../src/lib/rts/twoZone.ts';

/** The NUREG-1805 MQH room: 4 m × 5 m × 2.6 m concrete, one 0.9 m × 2.0 m door. */
export const FLASHOVER_ROOM = {
  ventAreaM2: 0.9 * 2,
  ventHeightM: 2,
  /** Interior surfaces less the door, m². */
  atM2: 2 * 20 + 2 * (4 + 5) * 2.6 - 0.9 * 2,
} as const;

const aSqrtH = FLASHOVER_ROOM.ventAreaM2 * Math.sqrt(FLASHOVER_ROOM.ventHeightM);

export function room(qKw: number): LayerSpec {
  return {
    areaM2: 20,
    ceilingM: 2.6,
    vents: [{ widthM: 0.9, sillM: 0, soffitM: 2 }],
    boundaries: [
      { areaM2: 20, lining: LINING.concrete },
      { areaM2: 20, lining: LINING.concrete },
      { areaM2: 2 * (4 + 5) * 2.6 - 0.9 * 2, lining: LINING.concrete },
    ],
    fires: qKw > 0 ? [{ heatKw: qKw, diameterM: diameterForReleaseKw(qKw) }] : [],
  };
}

/** Babrauskas, 750 A√H kW. */
export function babrauskasFlashoverKw(): number {
  return 750 * aSqrtH;
}

/** Thomas, 7.8 A_T + 378 A√H kW. */
export function thomasFlashoverKw(): number {
  return 7.8 * FLASHOVER_ROOM.atM2 + 378 * aSqrtH;
}

/** MQH, NUREG-1805 Eq. 13-2, with hk at `tS`. */
export function mqhRoomFlashoverKw(tS = 600): number {
  return mqhFlashoverKw(
    effectiveHeatLossKwM2K(LINING.concrete, tS),
    FLASHOVER_ROOM.atM2,
    FLASHOVER_ROOM.ventAreaM2,
    FLASHOVER_ROOM.ventHeightM,
  );
}

/** Roadmap definition: a 600 °C upper layer or 20 kW/m² on the floor. */
export const FLASHOVER_UPPER_K = 600 + 273.15;
export const FLASHOVER_FLOOR_KW_M2 = 20;

export function flashed(upperK: number): boolean {
  return upperK >= FLASHOVER_UPPER_K || coldSurfaceIncidentKwM2(upperK) >= FLASHOVER_FLOOR_KW_M2;
}

export function flashesWithin(qKw: number, horizonS: number): boolean {
  const spec = room(qKw);
  let state = freshLayer(spec.ceilingM);
  for (let t = 1; t <= horizonS; t++) {
    state = stepZone(state, spec, 1).state;
    if (flashed(state.upperK)) return true;
  }
  return false;
}

/** NFPA 72 / SFPE t² growth coefficients, kW/s². */
export const T2_ALPHA = {
  slow: 0.00293,
  medium: 0.01172,
  fast: 0.0469,
  ultrafast: 0.1876,
} as const;

/** Seconds until a t² fire first flashes the room, or null by `horizonS`. */
export function timeToFlashoverS(alpha: number, horizonS: number): number | null {
  let state = freshLayer(2.6);
  for (let t = 1; t <= horizonS; t++) {
    const q = alpha * (t - 0.5) * (t - 0.5);
    state = stepZone(state, room(q), 1).state;
    if (flashed(state.upperK)) return t;
  }
  return null;
}

/** The MQH clock: first second at which α t² reaches Eq. 13-2 with hk at that time. */
export function correlationClockS(alpha: number, horizonS = 5000): number | null {
  for (let t = 1; t <= horizonS; t++) {
    if (alpha * t * t >= mqhRoomFlashoverKw(t)) return t;
  }
  return null;
}
