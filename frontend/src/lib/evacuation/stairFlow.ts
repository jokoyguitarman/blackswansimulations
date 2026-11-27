/**
 * Stair flights: one per pair of adjacent storeys a stair joins, per
 * direction. Each flight has its own release slot, so the flights of a tall
 * stair carry their capacity at the same time. At a landing the stream
 * already on the stair merges with the floor stream entering at the door,
 * a minor reverse stream takes a lane, and a full flight holds the
 * releases above it.
 */
import { stairEffectiveWidthM } from '../rts/levels';
import type { LevelDef, Stairwell } from '../rts/types';
import { LEVEL } from './levelConstants';

export type StairDir = 'up' | 'down';
export type StairSource = 'floor' | 'stream';

/** Seconds a newcomer would wait at a flight's head, entering at the door or on the stair. */
export interface FlightWait {
  floor: number;
  stream: number;
}

export function flightKey(stairId: string, dir: StairDir, fromLevel: string): string {
  return `${stairId}:${dir}:${fromLevel}`;
}

/**
 * Effective width one direction gets on a flight. With nobody coming the
 * other way it is the whole stair. With counterflow each direction gets its
 * share of the demand, but the minor one never less than one reverse lane,
 * and neither more than the stair less the other's half.
 */
export function flightWidthM(sw: Stairwell, demand: number, opposing: number): number {
  const eff = stairEffectiveWidthM(sw);
  if (opposing <= 0 || demand <= 0) return eff;
  const half = eff / 2;
  const lane = Math.min(LEVEL.STAIR_REVERSE_LANE_M, half);
  const own = eff * (demand / (demand + opposing));
  const other = eff - own;
  if (own < other) return Math.min(half, Math.max(lane, own));
  return eff - Math.min(half, Math.max(lane, other));
}

export function flightFlowPerS(sw: Stairwell, demand: number, opposing: number): number {
  return LEVEL.STAIR_SPECIFIC_FLOW * flightWidthM(sw, demand, opposing);
}

/**
 * The most a flight holds at once: walking length per storey times nominal
 * width at the stopped density. Counts people walking it and people waiting
 * on the landing at its foot to go on.
 */
export function flightStorage(sw: Stairwell, from: LevelDef): number {
  const width = sw.widthM ?? LEVEL.DEFAULT_STAIR_WIDTH_M;
  const area = from.heightM * LEVEL.STAIR_TRAVEL_FACTOR * width;
  return Math.max(1, Math.floor(area * LEVEL.STAIR_JAM_DENSITY_PM2));
}

/**
 * Which stream the next release goes to when both wait. `credit` carries
 * the floor's share between releases, so 0.5 alternates and the long-run
 * split matches the share exactly.
 */
export function mergePick(
  credit: number,
  floorShare: number,
): { pick: StairSource; credit: number } {
  const next = credit + floorShare;
  if (next >= 1 - 1e-9) return { pick: 'floor', credit: next - 1 };
  return { pick: 'stream', credit: next };
}

/**
 * Seconds a newcomer waits at a flight, from the people ahead in the same
 * stream and the share the other stream takes while both wait.
 */
export function flightWaitS(
  own: number,
  other: number,
  ownShare: number,
  flowPerS: number,
): number {
  if (!(flowPerS > 0)) return Infinity;
  if (own <= 0) return 0;
  if (other <= 0 || ownShare >= 1) return own / flowPerS;
  if (ownShare <= 0) return (own + other) / flowPerS;
  const interleaved = Math.min(other, (own * (1 - ownShare)) / ownShare);
  return (own + interleaved) / flowPerS;
}

/**
 * Flights of one stair as [from, to] pairs of adjacent storey ids. `span`
 * is the sorted list of storeys the stair joins.
 */
export function stairFlights(
  span: readonly string[],
  levelIndexOf: (id: string) => number,
): Array<{ from: string; to: string; dir: StairDir }> {
  const out: Array<{ from: string; to: string; dir: StairDir }> = [];
  for (let i = 0; i < span.length - 1; i++) {
    const lower = span[i];
    const upper = span[i + 1];
    if (levelIndexOf(upper) !== levelIndexOf(lower) + 1) continue;
    out.push({ from: upper, to: lower, dir: 'down' });
    out.push({ from: lower, to: upper, dir: 'up' });
  }
  return out;
}
