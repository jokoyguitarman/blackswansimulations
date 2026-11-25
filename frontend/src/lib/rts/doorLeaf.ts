/**
 * One door leaf, shut at 0 and fully open at 1. The fire vent, the smoke
 * gap, and the crowd read this same fraction. The clear width is that
 * fraction times the nominal width, so the width is linear in the swing
 * angle. A swinging leaf does not clear the opening in proportion to the
 * angle. This model uses the linear map.
 *
 * A fire door is self-closing (NFPA 80). The sweep uses the ICC
 * A117.1-2017 §404.2.8.1 minimum: 5 s from 90° open to 12° from the latch.
 * That minimum is the rate used here, including the last 12°, which the
 * section does not time separately. An unrated door has no closer. It stays
 * where it was left.
 *
 * A person in the opening holds an unpinned leaf open. A command can pin
 * the leaf. The pin is the trainer or a firefighter holding it.
 *
 * The rating is the NFPA 252 endurance, in minutes. The clock runs only
 * while a room on either side has flashed. Flashover is this model's
 * developed fire, not the furnace curve. When the rating elapses the leaf
 * is gone: it stays open and the closer stops.
 */

/** ICC A117.1-2017 §404.2.8.1. From 90° to 12° from the latch, 5 s minimum. */
export const CLOSER_SWEEP_S = 5;
export const CLOSER_OPEN_DEG = 90;
export const CLOSER_LATCH_DEG = 12;
/** Fraction still open at 12° from the latch. */
export const CLOSER_LATCH_FRACTION = CLOSER_LATCH_DEG / CLOSER_OPEN_DEG;
/**
 * The code minimum, as a fraction per second. Applied across the whole
 * swing, so the last 12° closes at the same rate as the timed part.
 */
export const CLOSER_RATE_PER_S = (1 - CLOSER_LATCH_FRACTION) / CLOSER_SWEEP_S;

export function doorOpenFraction(wall: { openFraction?: number }): number {
  const value = wall.openFraction;
  if (value == null || !Number.isFinite(value)) return 1;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/**
 * Clear width the fire, the smoke, and a pinned leaf use, metres.
 * Linear in the swing: nominal width times the open fraction. A real
 * leaf's clear opening is not linear in angle.
 */
export function leafWidthM(wall: {
  hasDoor: boolean;
  doorWidth: number;
  openFraction?: number;
}): number {
  if (!wall.hasDoor || !(wall.doorWidth > 0)) return 0;
  return wall.doorWidth * doorOpenFraction(wall);
}

/** True when a command is holding the leaf shut. */
export function doorHeldShut(wall: {
  hasDoor: boolean;
  doorWidth: number;
  openFraction?: number;
  doorPinned?: boolean;
}): boolean {
  return wall.doorPinned === true && !(leafWidthM(wall) > 0);
}

/**
 * An unpinned door can be pushed. A failed leaf is already open. A pin
 * holds whatever width it was given.
 */
export function doorCanBePushed(wall: {
  hasDoor: boolean;
  doorWidth: number;
  doorPinned?: boolean;
  doorFailed?: boolean;
}): boolean {
  return wall.hasDoor && wall.doorWidth > 0 && wall.doorPinned !== true && wall.doorFailed !== true;
}

export interface DoorBody {
  x: number;
  y: number;
  level?: string;
}

export interface DoorLeafWall {
  id: string;
  hasDoor: boolean;
  doorWidth: number;
  doorPosition: number;
  openFraction?: number;
  /** NFPA 252 endurance, minutes. Absent means the door is unrated. */
  fireRatingMin?: number;
  doorExposedSec?: number;
  doorFailed?: boolean;
  doorPinned?: boolean;
  level?: string;
  start?: { x: number; y: number };
  end?: { x: number; y: number };
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
}

/**
 * Hold or move every leaf for `dt` seconds. `exposed` is the set of wall
 * ids on a flashed room. `approachM` is the crowd's mouth distance: a body
 * that close to the stored opening pushes an unpinned leaf fully open.
 */
export function stepDoorLeaves(
  walls: readonly DoorLeafWall[],
  bodies: readonly DoorBody[],
  exposed: ReadonlySet<string>,
  dt: number,
  approachM: number,
): void {
  if (!(dt > 0)) return;
  for (const wall of walls) {
    if (!wall.hasDoor || !(wall.doorWidth > 0)) continue;
    if (wall.doorFailed) {
      wall.openFraction = 1;
      wall.doorPinned = false;
      continue;
    }
    const rating = wall.fireRatingMin;
    if (rating != null && rating > 0 && exposed.has(wall.id)) {
      wall.doorExposedSec = (wall.doorExposedSec ?? 0) + dt;
      if (wall.doorExposedSec >= rating * 60) {
        wall.doorFailed = true;
        wall.openFraction = 1;
        wall.doorPinned = false;
        continue;
      }
    }
    if (wall.doorPinned) continue;
    if (personAtDoor(wall, bodies, approachM)) {
      wall.openFraction = 1;
      continue;
    }
    if (rating != null && rating > 0) {
      wall.openFraction = Math.max(0, doorOpenFraction(wall) - CLOSER_RATE_PER_S * dt);
    }
  }
}

/**
 * A trainer or firefighter sets the leaf. The pin holds it against the
 * closer and against people. A failed leaf stays open.
 */
export function commandDoorLeaf(
  wall: { openFraction?: number; doorPinned?: boolean; doorFailed?: boolean },
  fraction: number,
  pin = true,
): void {
  if (wall.doorFailed) {
    wall.openFraction = 1;
    wall.doorPinned = false;
    return;
  }
  wall.openFraction = fraction <= 0 ? 0 : fraction >= 1 ? 1 : fraction;
  wall.doorPinned = pin;
}

/** Cache key so a moved leaf rebuilds vents and smoke gaps. */
export function doorLeafKey(
  walls: readonly {
    id: string;
    openFraction?: number;
    doorPinned?: boolean;
    doorFailed?: boolean;
  }[],
): string {
  let key = '';
  for (const wall of walls) {
    key += `${wall.id}:${wall.openFraction ?? ''}:${wall.doorPinned ? 1 : 0}:${wall.doorFailed ? 1 : 0};`;
  }
  return key;
}

function wallEnds(wall: DoorLeafWall): { ax: number; ay: number; bx: number; by: number } | null {
  if (wall.start && wall.end) {
    return { ax: wall.start.x, ay: wall.start.y, bx: wall.end.x, by: wall.end.y };
  }
  if (wall.startX != null && wall.startY != null && wall.endX != null && wall.endY != null) {
    return { ax: wall.startX, ay: wall.startY, bx: wall.endX, by: wall.endY };
  }
  return null;
}

function personAtDoor(wall: DoorLeafWall, bodies: readonly DoorBody[], approachM: number): boolean {
  const ends = wallEnds(wall);
  if (!ends) return false;
  const dx = ends.bx - ends.ax;
  const dy = ends.by - ends.ay;
  const len = Math.hypot(dx, dy);
  if (!(len > 0.01)) return false;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const centre = wall.doorPosition * len;
  const half = wall.doorWidth / 2;
  for (const body of bodies) {
    if (wall.level && body.level && wall.level !== body.level) continue;
    const ox = body.x - ends.ax;
    const oy = body.y - ends.ay;
    if (Math.abs(ox * nx + oy * ny) > approachM) continue;
    const along = ox * ux + oy * uy;
    if (along < centre - half || along > centre + half) continue;
    return true;
  }
  return false;
}
