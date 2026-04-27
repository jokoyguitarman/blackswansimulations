import type { Vec2, ExitDef } from '../evacuation/types';
import type { PedSnapshot } from '../evacuation/engine';
import type {
  RTSUnit,
  RTSEquipment,
  RTSGameState,
  CasualtyCluster,
  CasualtyPin,
  InteriorWall,
  HazardZone,
  Stairwell,
} from './types';
import { HAZARD_DEFS } from './types';
import type { WallInspectionPoint } from './wallInspection';
import { polygonBounds } from '../evacuation/geometry';
import type { Bounds } from '../evacuation/geometry';
import { getIcon, LOCATION_ICON_KEY, HAZARD_ICON_KEY } from './iconCache';

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

export function scaledFont(
  basePx: number,
  rc: RenderContext,
  weight = 'bold',
  family = 'monospace',
): string {
  const scaled = Math.max(basePx, Math.round(basePx * Math.min(rc.scale / 3, 4)));
  return `${weight} ${scaled}px ${family}`;
}

function scaledR(basePx: number, rc: RenderContext): number {
  return Math.max(basePx, Math.round(basePx * Math.min(rc.scale / 3, 4)));
}

function drawSvgIcon(
  ctx: CanvasRenderingContext2D,
  key: string,
  cx: number,
  cy: number,
  size: number,
): boolean {
  const img = getIcon(key, Math.round(size));
  if (!img || !img.complete || img.naturalWidth === 0) return false;
  ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
  return true;
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
  casualtyPinsParam?: CasualtyPin[],
  activeCasualtyPinId?: string | null,
  interiorWalls?: InteriorWall[],
  hazardZones?: HazardZone[],
  stairwells?: Stairwell[],
  blastSite?: Vec2 | null,
  gameZones?: Array<{ type: string; radius: number }>,
  wallDrawPreview?: { start: Vec2; cursor: Vec2 } | null,
  trainerGps?: { pos: Vec2; accuracy: number } | null,
  studGrid?: Array<{
    simPos: Vec2;
    studType: string;
    spatialContext: string | null;
    id: string;
  }> | null,
  effectStates?: Map<
    string,
    { fire: { state: string }; gas: number; flood: number; structural: number }
  > | null,
  blastRadius?: number,
  showBlastZone?: boolean,
  showOperatingZones?: boolean,
) {
  ctx.clearRect(0, 0, w, h);

  if (!transparentBg) {
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, w, h);
    drawGrid(ctx, w, h, rc);
  }

  if (studGrid && studGrid.length > 0) {
    drawStudGrid(ctx, studGrid, rc, effectStates ?? null);
  }

  if (blastSite) {
    if (showOperatingZones && gameZones && gameZones.length > 0) {
      drawGameZones(ctx, blastSite, gameZones, rc);
    }
    if (showBlastZone) {
      drawBlastRadius(ctx, blastSite, rc, blastRadius);
    }
    drawBlastSite(ctx, blastSite, rc);
  }

  drawBuilding(ctx, buildingVerts, rc, transparentBg);

  if (interiorWalls && interiorWalls.length > 0) {
    for (const wall of interiorWalls) drawInteriorWall(ctx, wall, rc);
  }
  if (hazardZones && hazardZones.length > 0) {
    for (const hz of hazardZones) drawHazardZone(ctx, hz, rc);
  }
  if (stairwells && stairwells.length > 0) {
    for (const sw of stairwells) drawStairwell(ctx, sw, rc);
  }

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

  if (casualtyPinsParam && casualtyPinsParam.length > 0) {
    for (const pin of casualtyPinsParam) {
      drawCasualtyPin(ctx, pin, rc, activeCasualtyPinId === pin.id);
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

  if (wallDrawPreview) {
    drawWallDrawPreview(ctx, wallDrawPreview.start, wallDrawPreview.cursor, rc);
  }

  if (trainerGps) {
    drawTrainerGps(ctx, trainerGps.pos, trainerGps.accuracy, rc);
  }
}

// ── Stud Grid ────────────────────────────────────────────────────────────
function drawStudGrid(
  ctx: CanvasRenderingContext2D,
  studs: Array<{ simPos: Vec2; studType: string; spatialContext: string | null; id: string }>,
  rc: RenderContext,
  effectStates: Map<
    string,
    { fire: { state: string }; gas: number; flood: number; structural: number }
  > | null,
) {
  const baseR = Math.max(1.5, mToCanvas(0.4, rc));

  for (const s of studs) {
    const { cx, cy } = toCanvas(s.simPos.x, s.simPos.y, rc);
    if (cx < -5 || cy < -5 || cx > 4000 || cy > 4000) continue;

    const es = effectStates?.get(s.id);
    let drawn = false;

    if (es) {
      // Structural collapse zone (bottom layer)
      if (es.structural > 0.05) {
        const r = baseR * (1.5 + es.structural);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(220, 38, 38, ${0.12 + es.structural * 0.2})`;
        ctx.fill();
        if (es.structural > 0.5) {
          ctx.setLineDash([2, 2]);
          ctx.strokeStyle = `rgba(220, 38, 38, ${es.structural * 0.4})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
          ctx.setLineDash([]);
        }
        drawn = true;
      }

      // Flood (second layer)
      if (es.flood > 0.05) {
        const r = baseR * (1.3 + es.flood * 0.8);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(59, 130, 246, ${0.1 + es.flood * 0.4})`;
        ctx.fill();
        drawn = true;
      }

      // Gas cloud (third layer)
      if (es.gas > 0.05) {
        const r = baseR * (1.5 + es.gas * 1.2);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(163, 230, 53, ${0.08 + es.gas * 0.35})`;
        ctx.fill();
        drawn = true;
      }

      // Fire (top layer — most visible)
      if (es.fire.state === 'burning') {
        const r = baseR * 2.5;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(239, 68, 68, 0.7)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(251, 146, 60, 0.9)';
        ctx.fill();
        drawn = true;
      } else if (es.fire.state === 'heating') {
        const r = baseR * 1.8;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(251, 146, 60, 0.45)';
        ctx.fill();
        drawn = true;
      } else if (es.fire.state === 'burnt_out') {
        const r = baseR * 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(75, 75, 75, 0.35)';
        ctx.fill();
        drawn = true;
      }
    }

    if (!drawn) {
      ctx.beginPath();
      ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
      if (s.spatialContext === 'inside_building' || s.studType === 'building') {
        ctx.fillStyle = 'rgba(34, 197, 94, 0.18)';
      } else if (s.studType === 'street') {
        ctx.fillStyle = 'rgba(59, 130, 246, 0.15)';
      } else {
        ctx.fillStyle = 'rgba(156, 163, 175, 0.12)';
      }
      ctx.fill();
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
  if (speedMs < 0.05) return '#ef4444'; // stuck/crushed — red
  if (speedMs < 0.2) return '#f97316'; // severely slowed — orange
  if (speedMs < 0.5) return '#eab308'; // congested — yellow
  if (speedMs < 1.0) return '#84cc16'; // moving slowly — lime
  return '#22c55e'; // free-flowing — green
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

// ── Wall draw preview ───────────────────────────────────────────────────
function drawWallDrawPreview(
  ctx: CanvasRenderingContext2D,
  start: Vec2,
  cursor: Vec2,
  rc: RenderContext,
) {
  const s = toCanvas(start.x, start.y, rc);
  const c = toCanvas(cursor.x, cursor.y, rc);
  const isSamePoint = Math.abs(s.cx - c.cx) < 2 && Math.abs(s.cy - c.cy) < 2;

  // Pulsing glow at anchor
  const pulse = (Date.now() % 1500) / 1500;
  ctx.save();
  ctx.shadowColor = '#94a3b8';
  ctx.shadowBlur = 8 + pulse * 8;
  ctx.beginPath();
  ctx.arc(s.cx, s.cy, 8 + pulse * 4, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(148, 163, 184, ${0.3 - pulse * 0.2})`;
  ctx.fill();
  ctx.restore();

  // Anchor circle at point A
  ctx.beginPath();
  ctx.arc(s.cx, s.cy, 7, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(148, 163, 184, 0.5)';
  ctx.fill();
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // "A" label
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('A', s.cx, s.cy);

  if (isSamePoint) {
    // Only anchor placed — show "tap to set point B" hint
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Tap endpoint (B)', s.cx, s.cy + 18);
    return;
  }

  // Dashed line from A to cursor
  ctx.beginPath();
  ctx.moveTo(s.cx, s.cy);
  ctx.lineTo(c.cx, c.cy);
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Small circle at cursor (point B)
  ctx.beginPath();
  ctx.arc(c.cx, c.cy, 5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
  ctx.fill();
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Length label
  const dist = Math.hypot(cursor.x - start.x, cursor.y - start.y);
  const mx = (s.cx + c.cx) / 2;
  const my = (s.cy + c.cy) / 2;
  ctx.fillStyle = '#94a3b8';
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`${dist.toFixed(1)}m`, mx, my - 8);
}

// ── Trainer GPS dot ─────────────────────────────────────────────────────
function drawTrainerGps(
  ctx: CanvasRenderingContext2D,
  pos: Vec2,
  accuracyM: number,
  rc: RenderContext,
) {
  const p = toCanvas(pos.x, pos.y, rc);
  const accR = mToCanvas(accuracyM, rc);

  // Accuracy circle
  if (accR > 3) {
    ctx.beginPath();
    ctx.arc(p.cx, p.cy, accR, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(59, 130, 246, 0.08)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Outer pulse ring
  const pulse = (Date.now() % 2000) / 2000;
  const pulseR = 8 + pulse * 12;
  ctx.beginPath();
  ctx.arc(p.cx, p.cy, pulseR, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(59, 130, 246, ${0.5 - pulse * 0.5})`;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Dark border
  ctx.beginPath();
  ctx.arc(p.cx, p.cy, 8, 0, Math.PI * 2);
  ctx.fillStyle = '#1e3a5f';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Blue center
  ctx.beginPath();
  ctx.arc(p.cx, p.cy, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#3b82f6';
  ctx.fill();

  // Inner white dot
  ctx.beginPath();
  ctx.arc(p.cx, p.cy - 1.5, 2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.fill();

  // Label
  ctx.fillStyle = '#3b82f6';
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('YOU ARE HERE', p.cx, p.cy + 16);
}

// ── Game zones (hot/warm/cold) ───────────────────────────────────────────
function drawGameZones(
  ctx: CanvasRenderingContext2D,
  fallbackCenter: Vec2,
  zones: Array<{ type: string; radius: number; center?: Vec2 }>,
  rc: RenderContext,
) {
  const colors: Record<string, string> = { hot: '#ef4444', warm: '#f97316', cold: '#eab308' };
  const labels: Record<string, string> = { hot: 'HOT ZONE', warm: 'WARM ZONE', cold: 'COLD ZONE' };

  for (const zone of [...zones].reverse()) {
    const zoneCenter = zone.center ?? fallbackCenter;
    const p = toCanvas(zoneCenter.x, zoneCenter.y, rc);
    const r = mToCanvas(zone.radius, rc);
    if (r < 5) continue;
    const color = colors[zone.type] || '#888';

    ctx.beginPath();
    ctx.arc(p.cx, p.cy, r, 0, Math.PI * 2);
    ctx.fillStyle = color + '15';
    ctx.fill();
    ctx.strokeStyle = color + '80';
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 6]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = color + '90';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${labels[zone.type] || zone.type} (${zone.radius}m)`, p.cx + r + 4, p.cy - 4);

    // Draw draggable center marker
    ctx.beginPath();
    ctx.arc(p.cx, p.cy, 5, 0, Math.PI * 2);
    ctx.fillStyle = color + '60';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.stroke();
  }
}

// ── Blast site ──────────────────────────────────────────────────────────
function drawBlastRadius(
  ctx: CanvasRenderingContext2D,
  pos: Vec2,
  rc: RenderContext,
  blastRadius?: number,
) {
  const p = toCanvas(pos.x, pos.y, rc);
  const effectiveRadius = blastRadius ?? 20;
  const blastR = mToCanvas(effectiveRadius, rc);
  if (blastR >= 5) {
    ctx.beginPath();
    ctx.arc(p.cx, p.cy, blastR, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(239, 68, 68, 0.06)';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawBlastSite(ctx: CanvasRenderingContext2D, pos: Vec2, rc: RenderContext) {
  const p = toCanvas(pos.x, pos.y, rc);

  // Blast center
  ctx.save();
  ctx.shadowColor = '#ef4444';
  ctx.shadowBlur = 18;
  ctx.beginPath();
  ctx.arc(p.cx, p.cy, 10, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(239, 68, 68, 0.4)';
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(p.cx, p.cy, 8, 0, Math.PI * 2);
  ctx.fillStyle = '#000';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(p.cx, p.cy, 6, 0, Math.PI * 2);
  ctx.fillStyle = '#dc2626';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(p.cx, p.cy, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();

  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(p.cx - 8, p.cy);
  ctx.lineTo(p.cx + 8, p.cy);
  ctx.moveTo(p.cx, p.cy - 8);
  ctx.lineTo(p.cx, p.cy + 8);
  ctx.stroke();
}

// ── Interior walls ──────────────────────────────────────────────────────
function drawInteriorWall(ctx: CanvasRenderingContext2D, wall: InteriorWall, rc: RenderContext) {
  const s = toCanvas(wall.start.x, wall.start.y, rc);
  const e = toCanvas(wall.end.x, wall.end.y, rc);

  if (wall.hasDoor) {
    const dx = e.cx - s.cx;
    const dy = e.cy - s.cy;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;
    const nx = dx / len;
    const ny = dy / len;
    const doorPx = mToCanvas(wall.doorWidth, rc);
    const doorCenter = wall.doorPosition * len;
    const doorStart = doorCenter - doorPx / 2;
    const doorEnd = doorCenter + doorPx / 2;

    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 3;

    ctx.beginPath();
    ctx.moveTo(s.cx, s.cy);
    ctx.lineTo(s.cx + nx * doorStart, s.cy + ny * doorStart);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(s.cx + nx * doorEnd, s.cy + ny * doorEnd);
    ctx.lineTo(e.cx, e.cy);
    ctx.stroke();

    // Door gap indicator
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(s.cx + nx * doorStart, s.cy + ny * doorStart);
    ctx.lineTo(s.cx + nx * doorEnd, s.cy + ny * doorEnd);
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    ctx.beginPath();
    ctx.moveTo(s.cx, s.cy);
    ctx.lineTo(e.cx, e.cy);
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 3;
    ctx.stroke();
  }
}

// ── Hazard zones ────────────────────────────────────────────────────────
function drawHazardZone(ctx: CanvasRenderingContext2D, hz: HazardZone, rc: RenderContext) {
  const p = toCanvas(hz.pos.x, hz.pos.y, rc);
  const r = mToCanvas(hz.radius, rc);
  const drawR = Math.max(r, 10);
  const def = HAZARD_DEFS[hz.hazardType];

  const alpha = hz.severity === 'high' ? '40' : hz.severity === 'medium' ? '25' : '15';
  ctx.beginPath();
  ctx.arc(p.cx, p.cy, drawR, 0, Math.PI * 2);
  ctx.fillStyle = def.color + alpha;
  ctx.fill();

  ctx.strokeStyle = def.color + '80';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  const iconKey = HAZARD_ICON_KEY[hz.hazardType];
  const iconSize = Math.min(drawR * 0.6, scaledR(10, rc));
  if (!iconKey || !drawSvgIcon(ctx, iconKey, p.cx, p.cy, iconSize)) {
    ctx.fillStyle = def.color;
    ctx.font = `bold ${Math.min(drawR * 0.5, 14)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(def.label.charAt(0).toUpperCase(), p.cx, p.cy);
  }
}

// ── Stairwells ──────────────────────────────────────────────────────────
function drawStairwell(ctx: CanvasRenderingContext2D, sw: Stairwell, rc: RenderContext) {
  const p = toCanvas(sw.pos.x, sw.pos.y, rc);
  const r = 10;

  ctx.beginPath();
  ctx.arc(p.cx, p.cy, r + 1.5, 0, Math.PI * 2);
  ctx.fillStyle = '#000';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(p.cx, p.cy, r, 0, Math.PI * 2);
  ctx.fillStyle = sw.blocked ? '#991b1b' : '#1e3a5f';
  ctx.fill();
  ctx.strokeStyle = sw.blocked ? '#ef4444' : '#60a5fa';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Stair icon (zigzag)
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(p.cx - 4, p.cy + 3);
  ctx.lineTo(p.cx - 4, p.cy);
  ctx.lineTo(p.cx, p.cy);
  ctx.lineTo(p.cx, p.cy - 3);
  ctx.lineTo(p.cx + 4, p.cy - 3);
  ctx.stroke();

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 7px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(sw.label || 'STAIRS', p.cx, p.cy + r + 8);

  if (sw.blocked) {
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p.cx - 6, p.cy - 6);
    ctx.lineTo(p.cx + 6, p.cy + 6);
    ctx.moveTo(p.cx + 6, p.cy - 6);
    ctx.lineTo(p.cx - 6, p.cy + 6);
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

// ── Individual casualty pins ─────────────────────────────────────────────
const TAG_COLORS: Record<string, string> = {
  red: '#ef4444',
  yellow: '#eab308',
  green: '#22c55e',
  black: '#374151',
  untagged: '#d1d5db',
};

function drawPersonSilhouette(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  const headR = r * 0.28;
  const headY = cy - r * 0.25;
  ctx.beginPath();
  ctx.arc(cx, headY, headR, 0, Math.PI * 2);
  ctx.fill();

  const shoulderW = r * 0.45;
  const bodyTop = headY + headR + r * 0.05;
  const bodyBot = cy + r * 0.45;
  ctx.beginPath();
  ctx.moveTo(cx - shoulderW, bodyBot);
  ctx.quadraticCurveTo(cx - shoulderW, bodyTop, cx, bodyTop);
  ctx.quadraticCurveTo(cx + shoulderW, bodyTop, cx + shoulderW, bodyBot);
  ctx.fill();
}

function drawCasualtyPin(
  ctx: CanvasRenderingContext2D,
  pin: CasualtyPin,
  rc: RenderContext,
  isActive: boolean,
) {
  const p = toCanvas(pin.pos.x, pin.pos.y, rc);
  const r = scaledR(isActive ? 10 : 7, rc);
  const color = TAG_COLORS[pin.currentTag] || TAG_COLORS.untagged;

  if (pin.deteriorationLevel > 0.05) {
    ctx.beginPath();
    ctx.arc(p.cx, p.cy, r + 4, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(239, 68, 68, ${0.15 + pin.deteriorationLevel * 0.3})`;
    ctx.fill();
  }

  if (isActive) {
    ctx.beginPath();
    ctx.arc(p.cx, p.cy, r + 3, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(p.cx, p.cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const iconSize = r * 1.0;
  if (!drawSvgIcon(ctx, 'person', p.cx, p.cy, iconSize)) {
    ctx.fillStyle = '#fff';
    drawPersonSilhouette(ctx, p.cx, p.cy, r);
  }
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

    const isCustom = pt.imageSource === 'custom';

    ctx.beginPath();
    ctx.arc(p.cx, p.cy, r + 2, 0, Math.PI * 2);
    ctx.strokeStyle = isActive
      ? '#ffffff'
      : isCustom
        ? 'rgba(250, 204, 21, 0.5)'
        : 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = isActive ? 2 : 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(p.cx, p.cy, r, 0, Math.PI * 2);
    ctx.fillStyle = isActive
      ? '#38bdf8'
      : isCustom
        ? '#d97706'
        : pt.cached
          ? '#0ea5e9'
          : 'rgba(14, 165, 233, 0.5)';
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.font = `${r}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(isCustom ? '📸' : '📷', p.cx, p.cy);
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

// ── Scenario overlay drawing functions ───────────────────────────────────

export interface SimLocation {
  simPos: Vec2;
  label: string;
  pinCategory?: string;
  locationType?: string;
}

export interface SimZone {
  center: Vec2;
  radiusM: number;
  zoneType: string;
}

export interface SimRoad {
  points: Vec2[];
  name?: string;
}

const LOCATION_COLORS: Record<string, string> = {
  hospital: '#ef4444',
  police: '#3b82f6',
  fire_station: '#f97316',
  incident_site: '#eab308',
  incident_zone: '#eab308',
  entry_exit: '#22d3ee',
  staging_area: '#22c55e',
  assembly_point: '#22c55e',
  poi: '#a78bfa',
  cordon: '#f87171',
};

function drawLocationIcon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  category: string,
  color: string,
  rc: RenderContext,
) {
  const r = scaledR(5, rc);
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(1, r * 0.15);

  switch (category) {
    case 'hospital': {
      const arm = r * 0.7;
      const thick = r * 0.3;
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(cx - thick / 2, cy - arm, thick, arm * 2);
      ctx.fillRect(cx - arm, cy - thick / 2, arm * 2, thick);
      break;
    }
    case 'police': {
      ctx.beginPath();
      const pts = 5;
      for (let i = 0; i < pts; i++) {
        const angle = -Math.PI / 2 + (i * 2 * Math.PI) / pts;
        const px = cx + r * Math.cos(angle);
        const py = cy + r * Math.sin(angle);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'fire_station': {
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.quadraticCurveTo(cx + r * 0.4, cy - r * 0.2, cx + r * 0.5, cy + r);
      ctx.lineTo(cx, cy + r * 0.3);
      ctx.lineTo(cx - r * 0.5, cy + r);
      ctx.quadraticCurveTo(cx - r * 0.4, cy - r * 0.2, cx, cy - r);
      ctx.closePath();
      ctx.fillStyle = '#f97316';
      ctx.fill();
      break;
    }
    case 'incident_site': {
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy + r * 0.8);
      ctx.lineTo(cx - r, cy + r * 0.8);
      ctx.closePath();
      ctx.fillStyle = '#ef4444';
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.max(6, r)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', cx, cy + r * 0.15);
      break;
    }
    case 'entry_exit': {
      const w = r * 1.2;
      const h = r * 1.6;
      ctx.fillStyle = '#06b6d4';
      ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
      ctx.fillStyle = '#fff';
      ctx.fillRect(cx + w * 0.15, cy - h / 2, w * 0.15, h);
      break;
    }
    case 'staging_area': {
      const pole = r * 1.4;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, r * 0.12);
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.4, cy + pole / 2);
      ctx.lineTo(cx - r * 0.4, cy - pole / 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.4, cy - pole / 2);
      ctx.lineTo(cx + r * 0.6, cy - pole / 2 + r * 0.4);
      ctx.lineTo(cx - r * 0.4, cy - pole / 2 + r * 0.8);
      ctx.closePath();
      ctx.fill();
      break;
    }
    default: {
      const d = r * 0.8;
      ctx.beginPath();
      ctx.moveTo(cx, cy - d);
      ctx.lineTo(cx + d, cy);
      ctx.lineTo(cx, cy + d);
      ctx.lineTo(cx - d, cy);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    }
  }
  ctx.restore();
}

export function drawScenarioLocation(
  ctx: CanvasRenderingContext2D,
  loc: SimLocation,
  rc: RenderContext,
) {
  const p = toCanvas(loc.simPos.x, loc.simPos.y, rc);
  const category = loc.pinCategory || loc.locationType || 'poi';
  const color = LOCATION_COLORS[category] || '#a78bfa';

  ctx.beginPath();
  ctx.arc(p.cx, p.cy, scaledR(6, rc), 0, Math.PI * 2);
  ctx.fillStyle = color + '60';
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const iconKey = LOCATION_ICON_KEY[category];
  const iconSize = scaledR(8, rc);
  if (!iconKey || !drawSvgIcon(ctx, iconKey, p.cx, p.cy, iconSize)) {
    drawLocationIcon(ctx, p.cx, p.cy, category, color, rc);
  }
}

export function drawIncidentZone(ctx: CanvasRenderingContext2D, zone: SimZone, rc: RenderContext) {
  const p = toCanvas(zone.center.x, zone.center.y, rc);
  const r = mToCanvas(zone.radiusM, rc);
  if (r < 2) return;

  const colors: Record<string, { fill: string; stroke: string }> = {
    hot: { fill: 'rgba(239,68,68,0.10)', stroke: '#ef4444' },
    warm: { fill: 'rgba(249,115,22,0.08)', stroke: '#f97316' },
    cold: { fill: 'rgba(234,179,8,0.05)', stroke: '#eab308' },
  };
  const c = colors[zone.zoneType] || { fill: 'rgba(168,139,250,0.06)', stroke: '#a78bfa' };

  ctx.beginPath();
  ctx.arc(p.cx, p.cy, r, 0, Math.PI * 2);
  ctx.fillStyle = c.fill;
  ctx.fill();
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = c.stroke;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = 'bold 8px monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = c.stroke;
  ctx.fillText(zone.zoneType.toUpperCase() + ' ZONE', p.cx, p.cy - r - 4);
}

export function drawRoadPolyline(ctx: CanvasRenderingContext2D, road: SimRoad, rc: RenderContext) {
  if (road.points.length < 2) return;

  ctx.beginPath();
  const first = toCanvas(road.points[0].x, road.points[0].y, rc);
  ctx.moveTo(first.cx, first.cy);
  for (let i = 1; i < road.points.length; i++) {
    const pt = toCanvas(road.points[i].x, road.points[i].y, rc);
    ctx.lineTo(pt.cx, pt.cy);
  }
  ctx.strokeStyle = 'rgba(148,163,184,0.35)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

/**
 * Convert a lat/lng position to sim-space meters using a building polygon's
 * centroid as the reference point. Inverse of projectPolygon.
 */
export function latLngToSim(lat: number, lng: number, polygon: [number, number][]): Vec2 {
  const refLat = polygon.reduce((s, p) => s + p[0], 0) / polygon.length;
  const refLng = polygon.reduce((s, p) => s + p[1], 0) / polygon.length;
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos((refLat * Math.PI) / 180);
  return {
    x: (lng - refLng) * mPerDegLng,
    y: (refLat - lat) * mPerDegLat,
  };
}

export { toCanvas, toSim, mToCanvas, CANVAS_PAD };
