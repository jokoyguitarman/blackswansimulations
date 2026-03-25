import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';

export interface SpatialScore {
  overall: number;
  dimensions: SpatialScoreDimension[];
  reasoning: string;
}

export interface SpatialScoreDimension {
  dimension: string;
  score: number;
  reasoning: string;
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

function extractPoint(geometry: Record<string, unknown>): { lat: number; lng: number } | null {
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

/**
 * Score the distance of a placement from the blast/incident site.
 * Optimal range varies by asset type.
 */
function scoreDistance(
  placementPoint: { lat: number; lng: number },
  incidentSites: Array<{ lat: number; lng: number; blast_radius_m?: number }>,
  assetType: string,
): SpatialScoreDimension {
  if (!incidentSites.length) {
    return { dimension: 'distance', score: 0.5, reasoning: 'No incident sites to measure against' };
  }

  const nearest = incidentSites.reduce(
    (best, site) => {
      const dist = haversine(placementPoint.lat, placementPoint.lng, site.lat, site.lng);
      return dist < best.dist ? { site, dist } : best;
    },
    { site: incidentSites[0], dist: Infinity },
  );

  const dist = nearest.dist;
  const blastRadius = nearest.site.blast_radius_m ?? 100;

  // Define optimal ranges by asset type
  const medicalAssets = ['triage_tent', 'field_hospital', 'decon_zone', 'ambulance_staging'];
  const commandAssets = ['command_post', 'briefing_point'];
  const perimeterAssets = ['barrier', 'marshal_post', 'press_cordon'];

  let optimalMin: number, optimalMax: number;
  if (medicalAssets.includes(assetType)) {
    optimalMin = blastRadius * 1.5;
    optimalMax = blastRadius * 4;
  } else if (commandAssets.includes(assetType)) {
    optimalMin = blastRadius * 2;
    optimalMax = blastRadius * 6;
  } else if (perimeterAssets.includes(assetType)) {
    optimalMin = blastRadius * 1.2;
    optimalMax = blastRadius * 3;
  } else {
    optimalMin = blastRadius * 1.5;
    optimalMax = blastRadius * 5;
  }

  if (dist < blastRadius) {
    return {
      dimension: 'distance',
      score: 0,
      reasoning: `Inside blast zone (${Math.round(dist)}m from incident, blast radius ${blastRadius}m)`,
    };
  }
  if (dist < optimalMin) {
    const score = 0.3 + 0.3 * ((dist - blastRadius) / (optimalMin - blastRadius));
    return {
      dimension: 'distance',
      score: Math.round(score * 100) / 100,
      reasoning: `Close to incident (${Math.round(dist)}m) — dangerously near`,
    };
  }
  if (dist <= optimalMax) {
    return {
      dimension: 'distance',
      score: 1,
      reasoning: `Optimal distance from incident (${Math.round(dist)}m)`,
    };
  }
  // Too far — diminishing score
  const overshoot = (dist - optimalMax) / optimalMax;
  const score = Math.max(0.3, 1 - overshoot * 0.5);
  return {
    dimension: 'distance',
    score: Math.round(score * 100) / 100,
    reasoning: `Far from incident (${Math.round(dist)}m) — may reduce response time`,
  };
}

/**
 * Score route proximity — whether the asset is near a clear route.
 */
function scoreRouteProximity(
  placementPoint: { lat: number; lng: number },
  routes: Array<{
    label?: string;
    managed?: boolean;
    problem?: string | null;
    geometry?: [number, number][];
  }>,
  assetType: string,
): SpatialScoreDimension {
  const vehicleAssets = ['ambulance_staging', 'command_post', 'field_hospital'];
  if (!vehicleAssets.includes(assetType) || !routes.length) {
    return {
      dimension: 'route_proximity',
      score: 0.5,
      reasoning: 'Not a vehicle-dependent asset or no routes available',
    };
  }

  let nearestClear = Infinity;
  let nearestBlocked = Infinity;

  for (const route of routes) {
    if (!route.geometry?.length) continue;
    for (const [lat, lng] of route.geometry) {
      const dist = haversine(placementPoint.lat, placementPoint.lng, lat, lng);
      if (!route.problem || route.managed) {
        nearestClear = Math.min(nearestClear, dist);
      } else {
        nearestBlocked = Math.min(nearestBlocked, dist);
      }
    }
  }

  if (nearestClear < 100) {
    return {
      dimension: 'route_proximity',
      score: 1,
      reasoning: `Near clear route (${Math.round(nearestClear)}m)`,
    };
  }
  if (nearestClear < 300) {
    return {
      dimension: 'route_proximity',
      score: 0.7,
      reasoning: `Accessible via nearby route (${Math.round(nearestClear)}m)`,
    };
  }
  if (nearestBlocked < 100) {
    return {
      dimension: 'route_proximity',
      score: 0.3,
      reasoning: 'Near route but it is blocked/congested',
    };
  }
  return { dimension: 'route_proximity', score: 0.4, reasoning: 'No nearby clear routes' };
}

/**
 * Score wind awareness — check if placement is upwind or downwind of hazards.
 */
function scoreWindAwareness(
  placementPoint: { lat: number; lng: number },
  incidentSites: Array<{ lat: number; lng: number }>,
  wind: { direction_degrees: number; speed_kph?: number } | undefined,
  assetType: string,
): SpatialScoreDimension {
  const windSensitive = ['triage_tent', 'decon_zone', 'assembly_point', 'field_hospital'];
  if (!windSensitive.includes(assetType) || !wind || !incidentSites.length) {
    return {
      dimension: 'wind_awareness',
      score: 0.5,
      reasoning: 'Not wind-sensitive or no wind data',
    };
  }

  const site = incidentSites[0];
  const bearing =
    Math.atan2(placementPoint.lng - site.lng, placementPoint.lat - site.lat) * (180 / Math.PI);

  const windDir = wind.direction_degrees;
  const angleDiff = Math.abs(((bearing - windDir + 540) % 360) - 180);

  // If the placement is roughly downwind from the incident (within 60 degrees of wind direction)
  if (angleDiff < 60) {
    return {
      dimension: 'wind_awareness',
      score: 0.2,
      reasoning: 'Placement is downwind of incident — contamination risk',
    };
  }
  if (angleDiff > 120) {
    return {
      dimension: 'wind_awareness',
      score: 1,
      reasoning: 'Placement is upwind — good position relative to wind',
    };
  }
  return {
    dimension: 'wind_awareness',
    score: 0.6,
    reasoning: 'Placement is crosswind from incident',
  };
}

/**
 * Score inter-team conflict — detect overlapping or conflicting placements.
 */
function scoreConflicts(
  placementPoint: { lat: number; lng: number },
  teamName: string,
  assetType: string,
  otherPlacements: Array<{
    team_name: string;
    asset_type: string;
    geometry: Record<string, unknown>;
    label?: string;
  }>,
): SpatialScoreDimension {
  let conflicts = 0;
  const conflictDetails: string[] = [];

  for (const other of otherPlacements) {
    if (other.team_name === teamName) continue;
    const otherPoint = extractPoint(other.geometry);
    if (!otherPoint) continue;

    const dist = haversine(placementPoint.lat, placementPoint.lng, otherPoint.lat, otherPoint.lng);

    // Press area blocking ambulance staging
    if (
      (assetType === 'press_cordon' && other.asset_type === 'ambulance_staging') ||
      (assetType === 'ambulance_staging' && other.asset_type === 'press_cordon')
    ) {
      if (dist < 100) {
        conflicts++;
        conflictDetails.push(
          `${other.label ?? other.asset_type} from ${other.team_name} is too close (${Math.round(dist)}m)`,
        );
      }
    }

    // General overlap
    if (dist < 30) {
      conflicts++;
      conflictDetails.push(`Overlaps with ${other.team_name}'s ${other.label ?? other.asset_type}`);
    }
  }

  if (conflicts === 0) {
    return {
      dimension: 'conflict',
      score: 1,
      reasoning: 'No conflicts with other team placements',
    };
  }
  const score = Math.max(0.2, 1 - conflicts * 0.3);
  return {
    dimension: 'conflict',
    score: Math.round(score * 100) / 100,
    reasoning: conflictDetails.join('; '),
  };
}

/**
 * Evaluate a placement's spatial quality across all dimensions.
 */
export async function evaluatePlacement(
  sessionId: string,
  teamName: string,
  assetType: string,
  geometry: Record<string, unknown>,
): Promise<SpatialScore> {
  const dimensions: SpatialScoreDimension[] = [];

  const placementPoint = extractPoint(geometry);
  if (!placementPoint) {
    return {
      overall: 0,
      dimensions: [{ dimension: 'geometry', score: 0, reasoning: 'Invalid geometry' }],
      reasoning: 'Could not extract coordinates from placement geometry',
    };
  }

  try {
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id, current_state')
      .eq('id', sessionId)
      .single();

    if (!session) {
      return { overall: 0.5, dimensions: [], reasoning: 'Session not found' };
    }

    // Fetch incident sites
    const { data: locations } = await supabaseAdmin
      .from('scenario_locations')
      .select('id, location_type, label, coordinates, conditions')
      .eq('scenario_id', session.scenario_id);

    const incidentSites = (locations ?? [])
      .filter((loc) => {
        const conds = (loc.conditions as Record<string, unknown>) ?? {};
        const cat = (conds.pin_category as string)?.toLowerCase() ?? '';
        const t = (loc.location_type as string).toLowerCase();
        return cat === 'incident_site' || t.includes('blast') || t.includes('epicentre');
      })
      .map((loc) => {
        const coords = loc.coordinates as { lat?: number; lng?: number } | null;
        const conds = (loc.conditions as Record<string, unknown>) ?? {};
        return {
          lat: coords?.lat ?? 0,
          lng: coords?.lng ?? 0,
          blast_radius_m: conds.blast_radius_m as number | undefined,
        };
      })
      .filter((s) => s.lat !== 0 && s.lng !== 0);

    // Get environmental state for routes and wind
    const state = (session.current_state as Record<string, unknown>) ?? {};
    const envState = (state.environmental_state as Record<string, unknown>) ?? {};
    const routes = (Array.isArray(envState.routes) ? envState.routes : []) as Array<{
      label?: string;
      managed?: boolean;
      problem?: string | null;
      geometry?: [number, number][];
    }>;
    const wind = envState.wind as { direction_degrees: number; speed_kph?: number } | undefined;

    // Fetch other team placements
    const { data: otherPlacements } = await supabaseAdmin
      .from('placed_assets')
      .select('team_name, asset_type, geometry, label')
      .eq('session_id', sessionId)
      .eq('status', 'active');

    // Score each dimension
    dimensions.push(scoreDistance(placementPoint, incidentSites, assetType));
    dimensions.push(scoreRouteProximity(placementPoint, routes, assetType));
    dimensions.push(scoreWindAwareness(placementPoint, incidentSites, wind, assetType));
    dimensions.push(
      scoreConflicts(
        placementPoint,
        teamName,
        assetType,
        (otherPlacements ?? []) as Array<{
          team_name: string;
          asset_type: string;
          geometry: Record<string, unknown>;
          label?: string;
        }>,
      ),
    );

    // Compute overall as weighted average
    const weights: Record<string, number> = {
      distance: 0.35,
      route_proximity: 0.25,
      wind_awareness: 0.2,
      conflict: 0.2,
    };

    let weightedSum = 0;
    let totalWeight = 0;
    for (const dim of dimensions) {
      const w = weights[dim.dimension] ?? 0.2;
      weightedSum += dim.score * w;
      totalWeight += w;
    }

    const overall = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 100) / 100 : 0.5;
    const reasoning =
      dimensions
        .filter((d) => d.score < 0.5)
        .map((d) => d.reasoning)
        .join('; ') || 'Good placement overall';

    return { overall, dimensions, reasoning };
  } catch (err) {
    logger.warn({ err, sessionId }, 'Spatial scoring error');
    return { overall: 0.5, dimensions, reasoning: 'Scoring error — defaulting to neutral' };
  }
}

/**
 * Compute spatial metrics for a team's placements in a session.
 */
export async function computeTeamSpatialMetrics(
  sessionId: string,
  teamName: string,
): Promise<{
  placement_count: number;
  avg_score: number;
  relocation_count: number;
  dimension_averages: Record<string, number>;
}> {
  try {
    const { data: placements } = await supabaseAdmin
      .from('placed_assets')
      .select('asset_type, geometry, placement_score, status')
      .eq('session_id', sessionId)
      .eq('team_name', teamName);

    if (!placements?.length) {
      return { placement_count: 0, avg_score: 0, relocation_count: 0, dimension_averages: {} };
    }

    const active = placements.filter((p) => p.status === 'active');
    const relocated = placements.filter((p) => p.status === 'relocated');

    // Compute average from stored placement_score
    const scores: number[] = [];
    for (const p of active) {
      const scoreObj = p.placement_score as Record<string, number> | null;
      if (scoreObj) {
        const vals = Object.values(scoreObj);
        if (vals.length > 0) {
          const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
          scores.push(avg);
        }
      }
    }

    const avgScore =
      scores.length > 0
        ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100
        : 0;

    return {
      placement_count: active.length,
      avg_score: avgScore,
      relocation_count: relocated.length,
      dimension_averages: {},
    };
  } catch (err) {
    logger.warn({ err }, 'Team spatial metrics error');
    return { placement_count: 0, avg_score: 0, relocation_count: 0, dimension_averages: {} };
  }
}
