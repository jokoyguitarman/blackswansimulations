import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from '../services/websocketService.js';
import { validatePlacement } from '../services/placementValidationService.js';
import { evaluatePlacement } from '../services/spatialScoringService.js';
import { evaluatePinResolution } from '../services/pinResolutionService.js';
import { pointInGeoJSONPolygon } from '../services/geoUtils.js';
import {
  generateStudGrids,
  snapCoordinate,
  getOccupiedStudIds,
  getCachedGrids,
  setCachedGrids,
} from '../services/buildingStudService.js';
import type { OsmBuilding } from '../services/osmVicinityService.js';

const router = Router();

// --- Spatial linking: polygon enclosure detection + capacity computation ---

/** Capacity per m² by asset type (how many units fit per square metre of enclosed area). */
const CAPACITY_PER_M2: Record<string, { rate: number; unit: string }> = {
  triage_tent: { rate: 1 / 4, unit: 'casualties' },
  field_hospital: { rate: 1 / 8, unit: 'beds' },
  decon_zone: { rate: 1 / 6, unit: 'persons' },
  assembly_point: { rate: 1 / 2, unit: 'persons' },
  ambulance_staging: { rate: 1 / 25, unit: 'vehicles' },
  fire_truck_staging: { rate: 1 / 30, unit: 'vehicles' },
  command_post: { rate: 1 / 10, unit: 'operators' },
};

function getCapacity(assetType: string, areaM2: number): { capacity: number; unit: string } {
  const cfg = CAPACITY_PER_M2[assetType] ?? { rate: 1 / 5, unit: 'units' };
  return { capacity: Math.max(1, Math.floor(areaM2 * cfg.rate)), unit: cfg.unit };
}

function isPointInPolygon(point: { lat: number; lng: number }, ring: [number, number][]): boolean {
  return pointInGeoJSONPolygon(point.lat, point.lng, ring);
}

/** Extract a polygon ring from Polygon or closed LineString geometry. */
function extractRing(geometry: Record<string, unknown>): [number, number][] | null {
  if (geometry.type === 'Polygon') {
    const coords = geometry.coordinates as [number, number][][];
    if (coords?.[0]?.length >= 4) return coords[0];
  }
  if (geometry.type === 'LineString') {
    const coords = geometry.coordinates as [number, number][];
    if (coords?.length >= 4) {
      const first = coords[0];
      const last = coords[coords.length - 1];
      if (first[0] === last[0] && first[1] === last[1]) return coords;
    }
  }
  return null;
}

function extractPointCoords(
  geometry: Record<string, unknown>,
): { lat: number; lng: number } | null {
  if (geometry.type === 'Point') {
    const coords = geometry.coordinates as [number, number];
    if (coords?.length === 2) return { lat: coords[1], lng: coords[0] };
  }
  return null;
}

function polygonAreaM2(ring: [number, number][]): number {
  const R = 6371000;
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    const lat1 = (ring[i][1] * Math.PI) / 180;
    const lat2 = (ring[j][1] * Math.PI) / 180;
    const dLng = ((ring[j][0] - ring[i][0]) * Math.PI) / 180;
    total += dLng * (2 + Math.sin(lat1) + Math.sin(lat2));
  }
  return Math.abs((total * R * R) / 2);
}

interface PlacedAssetRow {
  id: string;
  team_name: string;
  asset_type: string;
  geometry: Record<string, unknown>;
  properties: Record<string, unknown>;
}

/**
 * After a placement is created, check for spatial enclosure relationships
 * between polygon/area assets and point assets on the same team.
 * Updates properties on both sides and broadcasts changes.
 */
async function processEnclosureLinks(
  sessionId: string,
  newPlacement: PlacedAssetRow,
): Promise<void> {
  const ws = (() => {
    try {
      return getWebSocketService();
    } catch {
      return null;
    }
  })();

  const { data: teamPlacements } = await supabaseAdmin
    .from('placed_assets')
    .select('id, team_name, asset_type, geometry, properties')
    .eq('session_id', sessionId)
    .eq('team_name', newPlacement.team_name)
    .eq('status', 'active');

  if (!teamPlacements?.length) return;

  const newRing = extractRing(newPlacement.geometry);
  const newPoint = extractPointCoords(newPlacement.geometry);

  // Case 1: New placement is a polygon/area — find enclosed point assets
  if (newRing) {
    const areaM2 = polygonAreaM2(newRing);
    const enclosedIds: string[] = [];

    for (const other of teamPlacements) {
      if (other.id === newPlacement.id) continue;
      const pt = extractPointCoords(other.geometry as Record<string, unknown>);
      if (!pt) continue;
      if (!isPointInPolygon(pt, newRing)) continue;

      enclosedIds.push(other.id);
      const { capacity, unit } = getCapacity(other.asset_type, areaM2);
      const updatedProps = {
        ...(other.properties ?? {}),
        enclosed_by: newPlacement.id,
        capacity,
        capacity_unit: unit,
        enclosed_area_m2: Math.round(areaM2),
      };

      const { data: updated } = await supabaseAdmin
        .from('placed_assets')
        .update({ properties: updatedProps, updated_at: new Date().toISOString() })
        .eq('id', other.id)
        .select()
        .single();

      if (updated) {
        ws?.broadcastToSession(sessionId, {
          type: 'placement.updated',
          data: { placement: updated },
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Update the polygon itself to record what it encloses
    if (enclosedIds.length > 0) {
      const polyProps = {
        ...(newPlacement.properties ?? {}),
        area_m2: Math.round(areaM2),
        encloses: enclosedIds,
      };
      const { data: updatedPoly } = await supabaseAdmin
        .from('placed_assets')
        .update({ properties: polyProps, updated_at: new Date().toISOString() })
        .eq('id', newPlacement.id)
        .select()
        .single();

      if (updatedPoly) {
        ws?.broadcastToSession(sessionId, {
          type: 'placement.updated',
          data: { placement: updatedPoly },
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  // Case 2: New placement is a point — check if it falls inside an existing polygon
  if (newPoint) {
    for (const other of teamPlacements) {
      if (other.id === newPlacement.id) continue;
      const ring = extractRing(other.geometry as Record<string, unknown>);
      if (!ring) continue;
      if (!isPointInPolygon(newPoint, ring)) continue;

      const areaM2 = polygonAreaM2(ring);
      const { capacity, unit } = getCapacity(newPlacement.asset_type, areaM2);

      // Update the point asset with capacity
      const pointProps = {
        ...(newPlacement.properties ?? {}),
        enclosed_by: other.id,
        capacity,
        capacity_unit: unit,
        enclosed_area_m2: Math.round(areaM2),
      };
      const { data: updatedPoint } = await supabaseAdmin
        .from('placed_assets')
        .update({ properties: pointProps, updated_at: new Date().toISOString() })
        .eq('id', newPlacement.id)
        .select()
        .single();

      if (updatedPoint) {
        ws?.broadcastToSession(sessionId, {
          type: 'placement.updated',
          data: { placement: updatedPoint },
          timestamp: new Date().toISOString(),
        });
      }

      // Update the polygon to include this point in its encloses list
      const existingEncloses = Array.isArray(other.properties?.encloses)
        ? (other.properties.encloses as string[])
        : [];
      if (!existingEncloses.includes(newPlacement.id)) {
        const polyProps = {
          ...(other.properties ?? {}),
          encloses: [...existingEncloses, newPlacement.id],
        };
        const { data: updatedPoly } = await supabaseAdmin
          .from('placed_assets')
          .update({ properties: polyProps, updated_at: new Date().toISOString() })
          .eq('id', other.id)
          .select()
          .single();

        if (updatedPoly) {
          ws?.broadcastToSession(sessionId, {
            type: 'placement.updated',
            data: { placement: updatedPoly },
            timestamp: new Date().toISOString(),
          });
        }
      }

      break; // Link to the first enclosing polygon only
    }
  }
}

// GET /sessions/:id/placements — list active placements
router.get('/sessions/:id/placements', requireAuth, async (req, res) => {
  try {
    const { id: sessionId } = req.params;
    const { data, error } = await supabaseAdmin
      .from('placed_assets')
      .select('*')
      .eq('session_id', sessionId)
      .eq('status', 'active')
      .order('placed_at', { ascending: true });

    if (error) {
      logger.error({ error, sessionId }, 'Failed to fetch placements');
      return res.status(500).json({ error: 'Failed to fetch placements' });
    }

    return res.json({ data: data ?? [] });
  } catch (err) {
    logger.error({ err }, 'Unexpected error in GET placements');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /sessions/:id/placements — create a new placement
router.post('/sessions/:id/placements', requireAuth, async (req, res) => {
  try {
    const { id: sessionId } = req.params;
    const user = (req as AuthenticatedRequest).user;
    if (!user?.id) return res.status(401).json({ error: 'Not authenticated' });

    const { team_name, asset_type, label, geometry, properties } = req.body;

    if (!team_name || !asset_type || !geometry) {
      return res.status(400).json({ error: 'team_name, asset_type, and geometry are required' });
    }

    // Validate session is in progress
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('status')
      .eq('id', sessionId)
      .single();

    if (!session || session.status !== 'in_progress') {
      return res.status(400).json({ error: 'Session is not in progress' });
    }

    // Snap Point geometry to building stud if inside a building
    if (
      geometry?.type === 'Point' &&
      Array.isArray(geometry.coordinates) &&
      geometry.coordinates.length === 2
    ) {
      const { data: sessionFull } = await supabaseAdmin
        .from('sessions')
        .select('scenario_id')
        .eq('id', sessionId)
        .single();

      if (sessionFull?.scenario_id) {
        const scenarioId = sessionFull.scenario_id as string;
        let grids = getCachedGrids(scenarioId);

        if (!grids) {
          const { data: sc } = await supabaseAdmin
            .from('scenarios')
            .select('insider_knowledge')
            .eq('id', scenarioId)
            .single();

          const ik = sc?.insider_knowledge as Record<string, unknown> | null;
          const osmVicinity = ik?.osm_vicinity as { buildings?: OsmBuilding[] } | undefined;
          const buildings = (osmVicinity as Record<string, unknown>)?.buildings as
            | OsmBuilding[]
            | undefined;

          if (buildings?.length) {
            grids = generateStudGrids(buildings);
            setCachedGrids(scenarioId, grids);
          }
        }

        if (grids?.length) {
          const [gLng, gLat] = geometry.coordinates;
          const floor = ((properties as Record<string, unknown>)?.floor_level as string) ?? 'G';
          const occupied = await getOccupiedStudIds(scenarioId, grids, sessionId);
          const snapped = snapCoordinate(gLat, gLng, floor, grids, occupied);
          if (snapped.studId) {
            geometry.coordinates = [snapped.lng, snapped.lat];
          }
        }
      }
    }

    // Run placement validation
    const validation = await validatePlacement(
      sessionId,
      team_name,
      asset_type,
      geometry,
      properties ?? {},
    );

    if (!validation.valid) {
      return res.status(422).json({
        error: 'Placement blocked',
        blocks: validation.blocks,
        warnings: validation.warnings,
      });
    }

    // Run spatial scoring
    const spatialScore = await evaluatePlacement(sessionId, team_name, asset_type, geometry);

    const { data: placement, error } = await supabaseAdmin
      .from('placed_assets')
      .insert({
        session_id: sessionId,
        team_name,
        placed_by: user.id,
        asset_type,
        label: label || asset_type.replace(/_/g, ' '),
        geometry,
        properties: properties ?? {},
        placement_score: {
          ...validation.score_modifiers,
          overall: spatialScore.overall,
          dimensions: spatialScore.dimensions,
        },
      })
      .select()
      .single();

    if (error) {
      logger.error({ error, sessionId }, 'Failed to create placement');
      return res.status(500).json({ error: 'Failed to create placement' });
    }

    // Broadcast to session
    try {
      const ws = getWebSocketService();
      ws.broadcastToSession(sessionId, {
        type: 'placement.created',
        data: { placement, warnings: validation.warnings },
        timestamp: new Date().toISOString(),
      });
    } catch {
      /* non-blocking */
    }

    // Auto-link polygon enclosures (capacity computation) — non-blocking
    processEnclosureLinks(sessionId, {
      id: placement.id,
      team_name,
      asset_type,
      geometry,
      properties: properties ?? {},
    }).catch((err) => {
      logger.warn({ err, sessionId }, 'Enclosure linking error (non-blocking)');
    });

    // Trigger pin resolution in background (don't block response)
    evaluatePinResolution(sessionId).catch((err) => {
      logger.warn({ err, sessionId }, 'Pin resolution evaluation error (non-blocking)');
    });

    return res.status(201).json({
      data: placement,
      warnings: validation.warnings,
    });
  } catch (err) {
    logger.error({ err }, 'Unexpected error in POST placements');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /sessions/:id/placements/:placementId — update (relocate)
router.patch('/sessions/:id/placements/:placementId', requireAuth, async (req, res) => {
  try {
    const { id: sessionId, placementId } = req.params;
    const user = (req as AuthenticatedRequest).user;
    if (!user?.id) return res.status(401).json({ error: 'Not authenticated' });

    const { geometry, properties, label, linked_decision_id } = req.body;

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (geometry) updates.geometry = geometry;
    if (properties) updates.properties = properties;
    if (label) updates.label = label;
    if (linked_decision_id) updates.linked_decision_id = linked_decision_id;

    // Snap relocated Point geometry to building stud if inside a building
    if (
      geometry?.type === 'Point' &&
      Array.isArray(geometry.coordinates) &&
      geometry.coordinates.length === 2
    ) {
      const { data: sessionFull } = await supabaseAdmin
        .from('sessions')
        .select('scenario_id')
        .eq('id', sessionId)
        .single();

      if (sessionFull?.scenario_id) {
        const scenarioId = sessionFull.scenario_id as string;
        let grids = getCachedGrids(scenarioId);

        if (!grids) {
          const { data: sc } = await supabaseAdmin
            .from('scenarios')
            .select('insider_knowledge')
            .eq('id', scenarioId)
            .single();

          const ik = sc?.insider_knowledge as Record<string, unknown> | null;
          const osmVicinity = ik?.osm_vicinity as { buildings?: OsmBuilding[] } | undefined;
          const buildings = (osmVicinity as Record<string, unknown>)?.buildings as
            | OsmBuilding[]
            | undefined;

          if (buildings?.length) {
            grids = generateStudGrids(buildings);
            setCachedGrids(scenarioId, grids);
          }
        }

        if (grids?.length) {
          const [gLng, gLat] = geometry.coordinates;
          const floor = ((properties as Record<string, unknown>)?.floor_level as string) ?? 'G';
          const occupied = await getOccupiedStudIds(scenarioId, grids, sessionId);
          const snapped = snapCoordinate(gLat, gLng, floor, grids, occupied);
          if (snapped.studId) {
            geometry.coordinates = [snapped.lng, snapped.lat];
            updates.geometry = geometry;
          }
        }
      }
    }

    // Re-validate if geometry changed
    if (geometry) {
      const { data: existing } = await supabaseAdmin
        .from('placed_assets')
        .select('team_name, asset_type')
        .eq('id', placementId)
        .single();

      if (existing) {
        const validation = await validatePlacement(
          sessionId,
          existing.team_name,
          existing.asset_type,
          geometry,
          properties ?? {},
        );

        if (!validation.valid) {
          return res.status(422).json({
            error: 'Relocation blocked',
            blocks: validation.blocks,
            warnings: validation.warnings,
          });
        }

        const spatialScore = await evaluatePlacement(
          sessionId,
          existing.team_name,
          existing.asset_type,
          geometry,
        );
        updates.placement_score = {
          ...validation.score_modifiers,
          overall: spatialScore.overall,
          dimensions: spatialScore.dimensions,
        };
      }
    }

    const { data: updated, error } = await supabaseAdmin
      .from('placed_assets')
      .update(updates)
      .eq('id', placementId)
      .eq('session_id', sessionId)
      .select()
      .single();

    if (error) {
      logger.error({ error, placementId }, 'Failed to update placement');
      return res.status(500).json({ error: 'Failed to update placement' });
    }

    try {
      const ws = getWebSocketService();
      ws.broadcastToSession(sessionId, {
        type: 'placement.updated',
        data: { placement: updated },
        timestamp: new Date().toISOString(),
      });
    } catch {
      /* non-blocking */
    }

    evaluatePinResolution(sessionId).catch((err) => {
      logger.warn({ err, sessionId }, 'Pin resolution evaluation error (non-blocking)');
    });

    return res.json({ data: updated });
  } catch (err) {
    logger.error({ err }, 'Unexpected error in PATCH placements');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /sessions/:id/placements/:placementId — remove (soft delete)
router.delete('/sessions/:id/placements/:placementId', requireAuth, async (req, res) => {
  try {
    const { id: sessionId, placementId } = req.params;
    const user = (req as AuthenticatedRequest).user;
    if (!user?.id) return res.status(401).json({ error: 'Not authenticated' });

    const { data: updated, error } = await supabaseAdmin
      .from('placed_assets')
      .update({
        status: 'removed',
        removed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', placementId)
      .eq('session_id', sessionId)
      .select()
      .single();

    if (error) {
      logger.error({ error, placementId }, 'Failed to remove placement');
      return res.status(500).json({ error: 'Failed to remove placement' });
    }

    try {
      const ws = getWebSocketService();
      ws.broadcastToSession(sessionId, {
        type: 'placement.removed',
        data: { placement: updated },
        timestamp: new Date().toISOString(),
      });
    } catch {
      /* non-blocking */
    }

    return res.json({ data: updated });
  } catch (err) {
    logger.error({ err }, 'Unexpected error in DELETE placements');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
