import type { Vec2, ExitDef } from '../evacuation/types';
import { isInsidePolygon } from '../evacuation/geometry';

/**
 * Check if two line segments (p1→p2) and (p3→p4) intersect.
 */
function segmentsIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;

  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-10) return false;

  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;

  return t > 0.01 && t < 0.99 && u > 0.01 && u < 0.99;
}

/**
 * Check if a movement from `from` to `to` crosses any solid wall edge
 * (edges that don't have an exit gap).
 */
function crossesWall(from: Vec2, to: Vec2, verts: Vec2[], exits: ExitDef[]): boolean {
  const n = verts.length;
  if (n < 3) return false;

  for (let i = 0; i < n; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];

    if (!segmentsIntersect(from, to, a, b)) continue;

    // Check if this edge has an exit gap that covers the crossing point
    const edgeExits = exits.filter((e) => e.edgeIndex === i);
    if (edgeExits.length === 0) return true;

    // Find the parametric crossing point on the edge
    const edgeDx = b.x - a.x;
    const edgeDy = b.y - a.y;
    const edgeLen = Math.hypot(edgeDx, edgeDy);
    if (edgeLen < 0.01) return true;

    const moveDx = to.x - from.x;
    const moveDy = to.y - from.y;
    const denom = moveDx * edgeDy - moveDy * edgeDx;
    if (Math.abs(denom) < 1e-10) return true;

    const t = ((a.x - from.x) * edgeDy - (a.y - from.y) * edgeDx) / denom;
    const crossX = from.x + t * moveDx;
    const crossY = from.y + t * moveDy;

    // Parametric position along the edge
    const tEdge = ((crossX - a.x) * edgeDx + (crossY - a.y) * edgeDy) / (edgeLen * edgeLen);

    // Check if crossing point falls within any exit gap
    let inGap = false;
    for (const ex of edgeExits) {
      const halfW = ex.width / 2;
      const tCenter =
        ((ex.center.x - a.x) * edgeDx + (ex.center.y - a.y) * edgeDy) / (edgeLen * edgeLen);
      const tStart = tCenter - halfW / edgeLen;
      const tEnd = tCenter + halfW / edgeLen;
      if (tEdge >= tStart && tEdge <= tEnd) {
        inGap = true;
        break;
      }
    }

    if (!inGap) return true;
  }

  return false;
}

/**
 * Find the nearest exit center to a given position.
 */
function nearestExit(pos: Vec2, exits: ExitDef[]): ExitDef | null {
  let best: ExitDef | null = null;
  let bestDist = Infinity;
  for (const ex of exits) {
    const d = Math.hypot(ex.center.x - pos.x, ex.center.y - pos.y);
    if (d < bestDist) {
      bestDist = d;
      best = ex;
    }
  }
  return best;
}

/**
 * Compute a point just outside an exit (offset outward from the building).
 */
function exitApproachPoint(ex: ExitDef, verts: Vec2[], offset: number = 2.0): Vec2 {
  const a = verts[ex.edgeIndex];
  const b = verts[(ex.edgeIndex + 1) % verts.length];
  const edgeDx = b.x - a.x;
  const edgeDy = b.y - a.y;
  const edgeLen = Math.hypot(edgeDx, edgeDy);
  if (edgeLen < 0.01) return { ...ex.center };

  // Outward normal (perpendicular, pointing away from polygon interior)
  let nx = -edgeDy / edgeLen;
  let ny = edgeDx / edgeLen;

  // Check which direction is outward by testing a point offset in that direction
  const testX = ex.center.x + nx * 2;
  const testY = ex.center.y + ny * 2;
  if (isInsidePolygon(testX, testY, verts)) {
    nx = -nx;
    ny = -ny;
  }

  return {
    x: ex.center.x + nx * offset,
    y: ex.center.y + ny * offset,
  };
}

/**
 * Compute a point just inside an exit.
 */
function exitInteriorPoint(ex: ExitDef, verts: Vec2[], offset: number = 2.0): Vec2 {
  const approach = exitApproachPoint(ex, verts, offset);
  // Interior is the opposite direction from the approach point
  return {
    x: ex.center.x * 2 - approach.x,
    y: ex.center.y * 2 - approach.y,
  };
}

/**
 * Given a unit's current position and a target waypoint, compute intermediate
 * waypoints that route through building exits instead of through walls.
 *
 * Returns the full waypoint list (may include injected exit approach/interior points).
 */
export function computePathThroughExits(
  from: Vec2,
  target: Vec2,
  verts: Vec2[],
  exits: ExitDef[],
): Vec2[] {
  if (verts.length < 3 || exits.length === 0) return [target];

  const fromInside = isInsidePolygon(from.x, from.y, verts);
  const targetInside = isInsidePolygon(target.x, target.y, verts);

  // No wall crossing — direct path is fine
  if (!crossesWall(from, target, verts, exits)) {
    return [target];
  }

  // Outside → Inside: route through nearest exit to the target
  if (!fromInside && targetInside) {
    const ex = nearestExit(target, exits) ?? nearestExit(from, exits);
    if (!ex) return [target];
    const approach = exitApproachPoint(ex, verts);
    const interior = exitInteriorPoint(ex, verts);
    return [approach, { ...ex.center }, interior, target];
  }

  // Inside → Outside: route through nearest exit to the unit
  if (fromInside && !targetInside) {
    const ex = nearestExit(from, exits) ?? nearestExit(target, exits);
    if (!ex) return [target];
    const interior = exitInteriorPoint(ex, verts);
    const approach = exitApproachPoint(ex, verts);
    return [interior, { ...ex.center }, approach, target];
  }

  // Outside → Outside but path crosses the building: route around
  if (!fromInside && !targetInside) {
    const exFrom = nearestExit(from, exits);
    const exTo = nearestExit(target, exits);
    if (!exFrom || !exTo) return [target];

    if (exFrom.id === exTo.id) {
      // Same nearest exit — go to approach point, then around
      const approach = exitApproachPoint(exFrom, verts, 4);
      if (
        !crossesWall(from, approach, verts, exits) &&
        !crossesWall(approach, target, verts, exits)
      ) {
        return [approach, target];
      }
    }

    // Different exits — route via both approach points
    const approachFrom = exitApproachPoint(exFrom, verts, 4);
    const approachTo = exitApproachPoint(exTo, verts, 4);
    return [approachFrom, approachTo, target];
  }

  // Inside → Inside but path crosses a wall (e.g., concave building)
  // For now, allow direct movement (rare case for convex buildings)
  return [target];
}

/**
 * Clamp a position to stay outside a wall. If the unit has moved inside
 * a wall (due to floating-point drift), push it to the nearest edge exterior.
 */
export function clampToWallExterior(
  pos: Vec2,
  prevPos: Vec2,
  verts: Vec2[],
  exits: ExitDef[],
): Vec2 {
  if (verts.length < 3) return pos;

  // If movement didn't cross a wall, allow it
  if (!crossesWall(prevPos, pos, verts, exits)) return pos;

  // Movement crossed a solid wall — revert to previous position
  return { ...prevPos };
}

export { crossesWall, nearestExit };
