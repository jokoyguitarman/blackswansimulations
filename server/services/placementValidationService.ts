import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';

export interface PlacementValidationResult {
  valid: boolean;
  warnings: string[];
  blocks: string[];
  score_modifiers: Record<string, number>;
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function extractPointFromGeometry(
  geometry: Record<string, unknown>,
): { lat: number; lng: number } | null {
  if (geometry.type === 'Point') {
    const coords = geometry.coordinates as [number, number];
    if (coords?.length === 2) return { lat: coords[1], lng: coords[0] };
  }
  if (geometry.type === 'Polygon') {
    const coords = geometry.coordinates as [number, number][][];
    if (coords?.[0]?.length) {
      let latSum = 0,
        lngSum = 0;
      for (const [lng, lat] of coords[0]) {
        latSum += lat;
        lngSum += lng;
      }
      return { lat: latSum / coords[0].length, lng: lngSum / coords[0].length };
    }
  }
  if (geometry.type === 'LineString') {
    const coords = geometry.coordinates as [number, number][];
    if (coords?.length >= 2) {
      let latSum = 0,
        lngSum = 0;
      for (const [lng, lat] of coords) {
        latSum += lat;
        lngSum += lng;
      }
      return { lat: latSum / coords.length, lng: lngSum / coords.length };
    }
  }
  return null;
}

export async function validatePlacement(
  sessionId: string,
  teamName: string,
  assetType: string,
  geometry: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  properties: Record<string, unknown>,
): Promise<PlacementValidationResult> {
  const result: PlacementValidationResult = {
    valid: true,
    warnings: [],
    blocks: [],
    score_modifiers: {},
  };

  const placementPoint = extractPointFromGeometry(geometry);
  if (!placementPoint) {
    result.blocks.push('Invalid geometry — could not extract coordinates');
    result.valid = false;
    return result;
  }

  try {
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id, current_state')
      .eq('id', sessionId)
      .single();

    if (!session) return result;

    const { data: locations } = await supabaseAdmin
      .from('scenario_locations')
      .select('id, location_type, label, coordinates, conditions')
      .eq('scenario_id', session.scenario_id);

    const incidentSites = (locations ?? []).filter((loc) => {
      const conds = (loc.conditions as Record<string, unknown>) ?? {};
      const cat = (conds.pin_category as string)?.toLowerCase() ?? '';
      const t = (loc.location_type as string).toLowerCase();
      return cat === 'incident_site' || t.includes('blast') || t.includes('epicentre');
    });

    // Check blast exclusion zone
    for (const site of incidentSites) {
      const coords = site.coordinates as { lat?: number; lng?: number } | null;
      const conds = (site.conditions as Record<string, unknown>) ?? {};
      const blastRadius = conds.blast_radius_m as number | undefined;

      if (coords?.lat != null && coords?.lng != null && blastRadius) {
        const dist = haversine(placementPoint.lat, placementPoint.lng, coords.lat, coords.lng);
        if (dist < blastRadius) {
          result.blocks.push(
            `Placement is ${Math.round(dist)}m from ${site.label} — inside the ${blastRadius}m blast exclusion zone`,
          );
          result.valid = false;
        } else if (dist < blastRadius * 1.5) {
          result.warnings.push(
            `Placement is only ${Math.round(dist)}m from ${site.label} — dangerously close to the ${blastRadius}m exclusion zone`,
          );
          result.score_modifiers.proximity_penalty = -0.2;
        }
      }
    }

    // Check for conflicting placements from other teams
    const { data: existingPlacements } = await supabaseAdmin
      .from('placed_assets')
      .select('id, team_name, asset_type, geometry, label')
      .eq('session_id', sessionId)
      .eq('status', 'active')
      .neq('team_name', teamName);

    if (existingPlacements?.length) {
      for (const existing of existingPlacements) {
        const existingPoint = extractPointFromGeometry(
          existing.geometry as Record<string, unknown>,
        );
        if (!existingPoint) continue;

        const dist = haversine(
          placementPoint.lat,
          placementPoint.lng,
          existingPoint.lat,
          existingPoint.lng,
        );

        if (dist < 20) {
          result.warnings.push(
            `Very close (${Math.round(dist)}m) to ${existing.team_name}'s ${existing.label ?? existing.asset_type} — potential coordination conflict`,
          );
        }
      }
    }

    // Check candidate space suitability (site_requirements match)
    const candidateSpaces = (locations ?? []).filter((loc) => {
      const conds = (loc.conditions as Record<string, unknown>) ?? {};
      return (conds.pin_category as string)?.toLowerCase() === 'candidate_space';
    });

    let nearestCandidate: {
      label: string;
      dist: number;
      conditions: Record<string, unknown>;
    } | null = null;
    for (const space of candidateSpaces) {
      const coords = space.coordinates as { lat?: number; lng?: number } | null;
      if (!coords?.lat || !coords?.lng) continue;
      const dist = haversine(placementPoint.lat, placementPoint.lng, coords.lat, coords.lng);
      if (!nearestCandidate || dist < nearestCandidate.dist) {
        nearestCandidate = {
          label: space.label,
          dist,
          conditions: (space.conditions as Record<string, unknown>) ?? {},
        };
      }
    }

    if (nearestCandidate && nearestCandidate.dist < 100) {
      const conds = nearestCandidate.conditions;
      const needsWater = ['triage_tent', 'decon_zone', 'field_hospital'].includes(assetType);
      const needsVehicle = ['ambulance_staging', 'command_post'].includes(assetType);

      if (needsWater && conds.has_water === false) {
        result.warnings.push(
          `${nearestCandidate.label} has no water supply — ${assetType} effectiveness reduced`,
        );
        result.score_modifiers.no_water_penalty = -0.15;
      }
      if (needsVehicle && conds.vehicle_access === false) {
        result.warnings.push(
          `${nearestCandidate.label} has no vehicle access — ${assetType} accessibility limited`,
        );
        result.score_modifiers.no_vehicle_penalty = -0.15;
      }
    }
  } catch (err) {
    logger.warn({ err, sessionId }, 'Placement validation error (non-blocking)');
  }

  return result;
}
