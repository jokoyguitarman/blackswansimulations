import type { Vec2 } from './types';

export function projectPolygon(polygon: [number, number][]): Vec2[] {
  if (polygon.length === 0) return [];

  let sumLat = 0;
  let sumLng = 0;
  for (const [lat, lng] of polygon) {
    sumLat += lat;
    sumLng += lng;
  }
  const refLat = sumLat / polygon.length;
  const refLng = sumLng / polygon.length;

  const metersPerDegLat = 111_320;
  const metersPerDegLng = 111_320 * Math.cos((refLat * Math.PI) / 180);

  return polygon.map(([lat, lng]) => ({
    x: (lng - refLng) * metersPerDegLng,
    y: (refLat - lat) * metersPerDegLat,
  }));
}

export function isInsidePolygon(x: number, y: number, verts: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    if (
      verts[i].y > y !== verts[j].y > y &&
      x < ((verts[j].x - verts[i].x) * (y - verts[i].y)) / (verts[j].y - verts[i].y) + verts[i].x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

export interface EdgeSnapResult {
  edgeIndex: number;
  point: Vec2;
  dist: number;
  t: number; // 0–1 parametric position along the edge
}

export function nearestEdge(x: number, y: number, verts: Vec2[]): EdgeSnapResult {
  let best: EdgeSnapResult = { edgeIndex: 0, point: { x: 0, y: 0 }, dist: Infinity, t: 0 };

  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-10) continue;

    let t = ((x - a.x) * dx + (y - a.y) * dy) / lenSq;
    t = Math.max(0.05, Math.min(0.95, t)); // keep away from corners

    const px = a.x + t * dx;
    const py = a.y + t * dy;
    const d = Math.hypot(x - px, y - py);

    if (d < best.dist) {
      best = { edgeIndex: i, point: { x: px, y: py }, dist: d, t };
    }
  }

  return best;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export function polygonBounds(verts: Vec2[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of verts) {
    if (v.x < minX) minX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.x > maxX) maxX = v.x;
    if (v.y > maxY) maxY = v.y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function edgeLength(verts: Vec2[], edgeIndex: number): number {
  const a = verts[edgeIndex];
  const b = verts[(edgeIndex + 1) % verts.length];
  return Math.hypot(b.x - a.x, b.y - a.y);
}
