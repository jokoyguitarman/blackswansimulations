import type { Vec2, ExitDef } from '../evacuation/types';
import type { PedSnapshot } from '../evacuation/engine';
import type { RTSUnit, RTSEquipment, RTSGameState } from './types';
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
) {
  ctx.clearRect(0, 0, w, h);

  if (!transparentBg) {
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, w, h);
    drawGrid(ctx, w, h, rc);
  }

  drawBuilding(ctx, buildingVerts, rc, transparentBg);
  drawExits(ctx, exits, buildingVerts, rc);

  for (const eq of state.equipment) {
    drawEquipment(ctx, eq, rc);
  }

  if (state.stagingArea) {
    drawStagingArea(ctx, state.stagingArea, rc);
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
  const drawR = Math.max(r, 6);

  if (unit.selected) {
    ctx.beginPath();
    ctx.arc(p.cx, p.cy, drawR + 3, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(p.cx, p.cy, drawR, 0, Math.PI * 2);
  ctx.fillStyle = unit.def.color;
  ctx.fill();
  ctx.strokeStyle = unit.state === 'working' ? '#fbbf24' : 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const label = unit.def.label.charAt(0);
  ctx.fillStyle = '#000';
  ctx.font = `bold ${Math.max(drawR, 9)}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, p.cx, p.cy);

  if (unit.state === 'working') {
    const progress = unit.workTimer > 0 ? 1 - unit.workTimer / 10 : 1;
    ctx.beginPath();
    ctx.arc(p.cx, p.cy, drawR + 5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 2;
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
