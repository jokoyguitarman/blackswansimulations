import type { Vec2, ExitDef } from '../evacuation/types';
import type { PedSnapshot } from '../evacuation/engine';
import type { RTSUnit, RTSEquipment, RTSGameState, CasualtyCluster } from './types';
import type { WallInspectionPoint } from './wallInspection';
import { polygonBounds } from '../evacuation/geometry';
import type { Bounds } from '../evacuation/geometry';

export interface RenderContext {
  scale: number;
  bounds: Bounds;
  padX: number;
  padY: number;
}

function toCanvas(mx: number, my: number, rc: RenderContext) {
  return {
    cx: (mx - rc.bounds.minX) * rc.scale + rc.padX,
    cy: (my - rc.bounds.minY) * rc.scale + rc.padY,
  };
}

function toSim(cx: number, cy: number, rc: RenderContext) {
  return {
    x: (cx - rc.padX) / rc.scale + rc.bounds.minX,
    y: (cy - rc.padY) / rc.scale + rc.bounds.minY,
  };
}

function mToCanvas(meters: number, rc: RenderContext) {
  return meters * rc.scale;
}

// ── Main render function ────────────────────────────────────────────────
export function renderRTS(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  rc: RenderContext,
  state: RTSGameState,
  buildingVerts: Vec2[],
  exits: ExitDef[],
  pedestrians: PedSnapshot[],
  transparentBg: boolean,
  wallPoints?: WallInspectionPoint[],
  activeWallPointId?: string | null,
  plantedWallPointIds?: Set<string>,
  discoveredWallPointIds?: Set<string>,
  casualtyClusters?: CasualtyCluster[],
  activeCasualtyId?: string | null,
) {
  ctx.clearRect(0, 0, w, h);

  if (!transparentBg) {
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, w, h);
    drawGrid(ctx, w, h, rc);
  }

  drawBuilding(ctx, buildingVerts, rc, transparentBg);
  drawExits(ctx, exits, buildingVerts, rc);

  if (wallPoints && wallPoints.length > 0) {
    drawWallInspectionPoints(
      ctx,
      wallPoints,
      rc,
      activeWallPointId ?? null,
      plantedWallPointIds ?? new Set(),
      discoveredWallPointIds ?? new Set(),
    );
  }

  for (const eq of state.equipment) {
    drawEquipment(ctx, eq, rc);
  }

  if (state.stagingArea) {
    drawStagingArea(ctx, state.stagingArea, rc);
  }

  if (casualtyClusters && casualtyClusters.length > 0) {
    for (const cluster of casualtyClusters) {
      drawCasualtyCluster(ctx, cluster, rc, activeCasualtyId === cluster.id);
    }
  }

  for (const ped of pedestrians) {
    if (ped.evacuated) continue;
    drawPedestrian(ctx, ped, rc);
  }

  for (const unit of state.units) {
    drawUnit(ctx, unit, rc);
  }

  if (state.selection.selectionBox) {
    drawSelectionBox(ctx, state.selection.selectionBox, rc);
  }

  for (const unit of state.units) {
    if (unit.waypoints.length > 0) {
      drawWaypoints(ctx, unit, rc, unit.selected);
    }
  }
}

// ── Grid ────────────────────────────────────────────────────────────────
function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number, rc: RenderContext) {
  const gridSpacing = 10;
  const pxSpacing = mToCanvas(gridSpacing, rc);
  if (pxSpacing < 10) return;

  ctx.strokeStyle = '#1a1a2e';
  ctx.lineWidth = 0.5;

  const startX = rc.padX % pxSpacing;
  const startY = rc.padY % pxSpacing;

  for (let x = startX; x < w; x += pxSpacing) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = startY; y < h; y += pxSpacing) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
}

// ── Building ────────────────────────────────────────────────────────────
function drawBuilding(
  ctx: CanvasRenderingContext2D,
  verts: Vec2[],
  rc: RenderContext,
  transparentBg: boolean,
) {
  if (verts.length < 3) return;

  ctx.beginPath();
  const first = toCanvas(verts[0].x, verts[0].y, rc);
  ctx.moveTo(first.cx, first.cy);
  for (let i = 1; i < verts.length; i++) {
    const p = toCanvas(verts[i].x, verts[i].y, rc);
    ctx.lineTo(p.cx, p.cy);
  }
  ctx.closePath();

  ctx.fillStyle = transparentBg ? 'rgba(20, 20, 40, 0.55)' : 'rgba(30, 30, 50, 0.6)';
  ctx.fill();
  ctx.strokeStyle = transparentBg ? '#94a3b8' : '#4a5568';
  ctx.lineWidth = 2.5;
  ctx.stroke();
}

// ── Exits ───────────────────────────────────────────────────────────────
function drawExits(
  ctx: CanvasRenderingContext2D,
  exits: ExitDef[],
  verts: Vec2[],
  rc: RenderContext,
) {
  for (const ex of exits) {
    const edgeA = verts[ex.edgeIndex];
    const edgeB = verts[(ex.edgeIndex + 1) % verts.length];
    const edgeDx = edgeB.x - edgeA.x;
    const edgeDy = edgeB.y - edgeA.y;
    const edgeLen = Math.hypot(edgeDx, edgeDy);
    if (edgeLen < 0.01) continue;

    const nx = edgeDx / edgeLen;
    const ny = edgeDy / edgeLen;
    const halfW = ex.width / 2;

    const p1 = toCanvas(ex.center.x - nx * halfW, ex.center.y - ny * halfW, rc);
    const p2 = toCanvas(ex.center.x + nx * halfW, ex.center.y + ny * halfW, rc);

    ctx.beginPath();
    ctx.moveTo(p1.cx, p1.cy);
    ctx.lineTo(p2.cx, p2.cy);
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 4;
    ctx.stroke();

    const perpX = -ny;
    const perpY = nx;
    const center = toCanvas(ex.center.x, ex.center.y, rc);
    const arrowLen = mToCanvas(2, rc);
    ctx.beginPath();
    ctx.moveTo(center.cx, center.cy);
    ctx.lineTo(center.cx + perpX * arrowLen, center.cy + perpY * arrowLen);
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

// ── Pedestrian ──────────────────────────────────────────────────────────
function drawPedestrian(ctx: CanvasRenderingContext2D, ped: PedSnapshot, rc: RenderContext) {
  const p = toCanvas(ped.x, ped.y, rc);
  const r = mToCanvas(0.25, rc);

  ctx.beginPath();
  ctx.arc(p.cx, p.cy, Math.max(r, 2), 0, Math.PI * 2);
  ctx.fillStyle = pedColor(ped.speed);
  ctx.fill();
}

function pedColor(speedMs: number): string {
  if (speedMs < 0.3) return '#ef4444';
  if (speedMs < 0.8) return '#f59e0b';
  return '#22c55e';
}

// ── Unit ────────────────────────────────────────────────────────────────
function drawUnit(ctx: CanvasRenderingContext2D, unit: RTSUnit, rc: RenderContext) {
  const p = toCanvas(unit.pos.x, unit.pos.y, rc);
  const r = mToCanvas(unit.def.radius, rc);
  const drawR = Math.max(r, 8);

  // Outer glow (team color, large, semi-transparent)
  ctx.save();
  ctx.shadowColor = unit.def.color;
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.arc(p.cx, p.cy, drawR + 2, 0, Math.PI * 2);
  ctx.fillStyle = unit.def.color + '40';
  ctx.fill();
  ctx.restore();

  // Selection ring (white, outside everything)
  if (unit.selected) {
    ctx.beginPath();
    ctx.arc(p.cx, p.cy, drawR + 5, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // Dark border ring
  ctx.beginPath();
  ctx.arc(p.cx, p.cy, drawR + 1.5, 0, Math.PI * 2);
  ctx.fillStyle = '#000000';
  ctx.fill();

  // Main colored fill
  ctx.beginPath();
  ctx.arc(p.cx, p.cy, drawR, 0, Math.PI * 2);
  ctx.fillStyle = unit.def.color;
  ctx.fill();

  // Inner highlight for depth
  ctx.beginPath();
  ctx.arc(p.cx, p.cy - drawR * 0.2, drawR * 0.6, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.fill();

  // Label letter
  const label = unit.def.label.charAt(0);
  ctx.fillStyle = '#000';
  ctx.font = `bold ${Math.max(drawR, 10)}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, p.cx, p.cy);

  // Work progress ring
  if (unit.state === 'working') {
    const progress = unit.workTimer > 0 ? 1 - unit.workTimer / 10 : 1;
    ctx.beginPath();
    ctx.arc(p.cx, p.cy, drawR + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
}

// ── Equipment ───────────────────────────────────────────────────────────
function drawEquipment(ctx: CanvasRenderingContext2D, eq: RTSEquipment, rc: RenderContext) {
  const p = toCanvas(eq.pos.x, eq.pos.y, rc);
  const r = mToCanvas(eq.def.radius, rc);
  const drawR = Math.max(r, 4);

  ctx.beginPath();
  ctx.arc(p.cx, p.cy, drawR, 0, Math.PI * 2);
  ctx.fillStyle = eq.def.color + '20';
  ctx.fill();
  ctx.strokeStyle = eq.def.color + '60';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = eq.def.color;
  ctx.font = `${Math.max(Math.min(drawR * 0.8, 18), 10)}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(eq.def.icon, p.cx, p.cy);
}

// ── Staging area ────────────────────────────────────────────────────────
function drawStagingArea(ctx: CanvasRenderingContext2D, pos: Vec2, rc: RenderContext) {
  const p = toCanvas(pos.x, pos.y, rc);
  const r = mToCanvas(5, rc);

  ctx.beginPath();
  ctx.arc(p.cx, p.cy, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(250, 204, 21, 0.12)';
  ctx.fill();
  ctx.strokeStyle = '#facc15';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#facc15';
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('STAGING / RVP', p.cx, p.cy - r - 4);
}

// ── Selection box ───────────────────────────────────────────────────────
function drawSelectionBox(
  ctx: CanvasRenderingContext2D,
  box: { start: Vec2; end: Vec2 },
  rc: RenderContext,
) {
  const s = toCanvas(box.start.x, box.start.y, rc);
  const e = toCanvas(box.end.x, box.end.y, rc);

  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(s.cx, s.cy, e.cx - s.cx, e.cy - s.cy);
  ctx.setLineDash([]);

  ctx.fillStyle = 'rgba(34, 211, 238, 0.1)';
  ctx.fillRect(s.cx, s.cy, e.cx - s.cx, e.cy - s.cy);
}

// ── Waypoints ───────────────────────────────────────────────────────────
function drawWaypoints(
  ctx: CanvasRenderingContext2D,
  unit: RTSUnit,
  rc: RenderContext,
  isSelected: boolean,
) {
  const alpha = isSelected ? 'cc' : '50';
  const dotAlpha = isSelected ? 'ff' : '80';

  ctx.strokeStyle = unit.def.color + alpha;
  ctx.lineWidth = isSelected ? 1.5 : 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();

  const start = toCanvas(unit.pos.x, unit.pos.y, rc);
  ctx.moveTo(start.cx, start.cy);

  for (const wp of unit.waypoints) {
    const p = toCanvas(wp.x, wp.y, rc);
    ctx.lineTo(p.cx, p.cy);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  for (const wp of unit.waypoints) {
    const p = toCanvas(wp.x, wp.y, rc);
    ctx.beginPath();
    ctx.arc(p.cx, p.cy, isSelected ? 4 : 3, 0, Math.PI * 2);
    ctx.fillStyle = unit.def.color + dotAlpha;
    ctx.fill();
  }

  // Destination marker for the final waypoint
  if (unit.waypoints.length > 0) {
    const last = unit.waypoints[unit.waypoints.length - 1];
    const lp = toCanvas(last.x, last.y, rc);
    ctx.beginPath();
    ctx.arc(lp.cx, lp.cy, isSelected ? 6 : 4, 0, Math.PI * 2);
    ctx.strokeStyle = unit.def.color + dotAlpha;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

// ── Casualty clusters ───────────────────────────────────────────────────
function drawCasualtyCluster(
  ctx: CanvasRenderingContext2D,
  cluster: CasualtyCluster,
  rc: RenderContext,
  isActive: boolean,
) {
  const p = toCanvas(cluster.pos.x, cluster.pos.y, rc);
  const r = isActive ? 12 : 9;
  const victimCount = cluster.victims.length;

  // Glow
  ctx.save();
  ctx.shadowColor = cluster.triageComplete ? '#22c55e' : '#ef4444';
  ctx.shadowBlur = isActive ? 16 : 8;
  ctx.beginPath();
  ctx.arc(p.cx, p.cy, r + 4, 0, Math.PI * 2);
  ctx.fillStyle = cluster.triageComplete ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.2)';
  ctx.fill();
  ctx.restore();

  // Selection ring
  if (isActive) {
    ctx.beginPath();
    ctx.arc(p.cx, p.cy, r + 5, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Dark border
  ctx.beginPath();
  ctx.arc(p.cx, p.cy, r + 1.5, 0, Math.PI * 2);
  ctx.fillStyle = '#000';
  ctx.fill();

  // Main circle
  ctx.beginPath();
  ctx.arc(p.cx, p.cy, r, 0, Math.PI * 2);
  ctx.fillStyle = cluster.triageComplete ? '#15803d' : '#dc2626';
  ctx.fill();

  // Cross icon
  const crossSize = r * 0.5;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(p.cx - crossSize, p.cy);
  ctx.lineTo(p.cx + crossSize, p.cy);
  ctx.moveTo(p.cx, p.cy - crossSize);
  ctx.lineTo(p.cx, p.cy + crossSize);
  ctx.stroke();

  // Victim count badge
  ctx.fillStyle = '#000';
  ctx.font = `bold 9px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const badgeX = p.cx + r + 2;
  const badgeY = p.cy - r - 2;
  ctx.beginPath();
  ctx.arc(badgeX, badgeY, 7, 0, Math.PI * 2);
  ctx.fillStyle = '#facc15';
  ctx.fill();
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = '#000';
  ctx.font = 'bold 8px monospace';
  ctx.fillText(String(victimCount), badgeX, badgeY);

  // Label
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('CASUALTIES', p.cx, p.cy + r + 12);
}

// ── Wall inspection points ──────────────────────────────────────────────
function drawWallInspectionPoints(
  ctx: CanvasRenderingContext2D,
  points: WallInspectionPoint[],
  rc: RenderContext,
  activeId: string | null,
  _plantedIds: Set<string>,
  discoveredIds: Set<string>,
) {
  for (const pt of points) {
    const p = toCanvas(pt.simPos.x, pt.simPos.y, rc);
    const isActive = pt.id === activeId;
    const isDiscovered = discoveredIds.has(pt.id);
    const r = isActive ? 7 : 5;

    if (isDiscovered) {
      ctx.save();
      ctx.shadowColor = '#ef4444';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(p.cx, p.cy, r + 4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(239, 68, 68, 0.25)';
      ctx.fill();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(p.cx, p.cy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#dc2626';
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.max(r + 2, 9)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('⚠', p.cx, p.cy);
      continue;
    }

    ctx.beginPath();
    ctx.arc(p.cx, p.cy, r + 2, 0, Math.PI * 2);
    ctx.strokeStyle = isActive ? '#ffffff' : 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = isActive ? 2 : 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(p.cx, p.cy, r, 0, Math.PI * 2);
    ctx.fillStyle = isActive ? '#38bdf8' : pt.cached ? '#0ea5e9' : 'rgba(14, 165, 233, 0.5)';
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.font = `${r}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('📷', p.cx, p.cy);
  }
}

// ── Utility: compute render context (standalone canvas mode) ────────────
const CANVAS_PAD = 80;

export function computeRenderContext(
  verts: Vec2[],
  canvasWidth: number,
  canvasHeight: number,
  extraPadding: number = 40,
): RenderContext {
  const bounds = polygonBounds(verts);
  const totalPad = CANVAS_PAD + extraPadding;
  const scaleX = (canvasWidth - totalPad * 2) / Math.max(bounds.width, 1);
  const scaleY = (canvasHeight - totalPad * 2) / Math.max(bounds.height, 1);
  const scale = Math.min(scaleX, scaleY);

  return { scale, bounds, padX: totalPad, padY: totalPad };
}

// ── Utility: compute render context from Leaflet map ────────────────────
export function computeMapRenderContext(
  map: L.Map,
  originalPolygon: [number, number][],
  projectedVerts: Vec2[],
): RenderContext {
  const bounds = polygonBounds(projectedVerts);

  // Pick two widely-spaced vertices and compute pixel-per-meter scale
  const idx0 = 0;
  const idx1 = Math.floor(originalPolygon.length / 2);

  const p0 = map.latLngToContainerPoint([originalPolygon[idx0][0], originalPolygon[idx0][1]]);
  const p1 = map.latLngToContainerPoint([originalPolygon[idx1][0], originalPolygon[idx1][1]]);

  const m0 = projectedVerts[idx0];
  const m1 = projectedVerts[idx1];

  const pxDist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const mDist = Math.hypot(m1.x - m0.x, m1.y - m0.y);
  const scale = mDist > 0.01 ? pxDist / mDist : 1;

  const padX = p0.x - (m0.x - bounds.minX) * scale;
  const padY = p0.y - (m0.y - bounds.minY) * scale;

  return { scale, bounds, padX, padY };
}

export { toCanvas, toSim, mToCanvas, CANVAS_PAD };
