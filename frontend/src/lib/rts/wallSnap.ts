import type { Vec2 } from '../evacuation/types';

/** How far a wall end reaches to a building corner, another wall's end or the outline, metres. */
export const WALL_SNAP_M = 1.5;

export type WallSnapKind = 'join' | 'outline' | 'stud' | 'free';

/** Nearest point on the closed outline `verts`, corners included. */
export function nearestOutlinePoint(
  p: Vec2,
  verts: readonly Vec2[],
): { point: Vec2; dist: number } {
  let best = { point: p, dist: Infinity };
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    const t =
      lenSq > 1e-10 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq)) : 0;
    const point = { x: a.x + t * dx, y: a.y + t * dy };
    const dist = Math.hypot(p.x - point.x, p.y - point.y);
    if (dist < best.dist) best = { point, dist };
  }
  return best;
}

/**
 * Where a wall end drawn at `p` lands. A building corner or an existing wall
 * end within WALL_SNAP_M wins if it is nearer than the nearest stud. Otherwise
 * the nearer of the building outline (within WALL_SNAP_M) and the nearest
 * stud; else `p` itself. Studs sit on cell centres, half a cell in from the
 * outline, so a stud alone can never put a wall on the building edge.
 */
export function snapWallPoint(
  p: Vec2,
  verts: readonly Vec2[],
  wallEnds: readonly Vec2[],
  stud: Vec2 | null,
): { pos: Vec2; kind: WallSnapKind } {
  const dist = (q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y);
  const studDist = stud ? dist(stud) : Infinity;
  let join: Vec2 | null = null;
  let joinDist = WALL_SNAP_M;
  for (const q of [...verts, ...wallEnds]) {
    const d = dist(q);
    if (d <= joinDist) {
      joinDist = d;
      join = q;
    }
  }
  if (join && joinDist < studDist) return { pos: { x: join.x, y: join.y }, kind: 'join' };
  if (verts.length >= 3) {
    const edge = nearestOutlinePoint(p, verts);
    if (edge.dist <= WALL_SNAP_M && edge.dist < studDist)
      return { pos: edge.point, kind: 'outline' };
  }
  if (stud) return { pos: { x: stud.x, y: stud.y }, kind: 'stud' };
  return { pos: { x: p.x, y: p.y }, kind: 'free' };
}
