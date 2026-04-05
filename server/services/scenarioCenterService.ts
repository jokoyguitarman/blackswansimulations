import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';

export interface ScenarioCenter {
  lat: number;
  lng: number;
}

const cache = new Map<string, ScenarioCenter>();

/**
 * Resolve the geographic center for a scenario. Tries in order:
 *   1. In-memory cache (centers never change mid-session)
 *   2. scenarios.center_lat / center_lng
 *   3. incident_site pin from scenario_locations
 *   4. First scenario_location with coordinates
 *   5. Centroid of all scenario_locations
 *
 * When a fallback succeeds, the result is backfilled into the
 * scenarios table so subsequent lookups hit path 2 directly.
 */
export async function resolveScenarioCenter(scenarioId: string): Promise<ScenarioCenter | null> {
  const cached = cache.get(scenarioId);
  if (cached) return cached;

  const { data: scenario } = await supabaseAdmin
    .from('scenarios')
    .select('center_lat, center_lng')
    .eq('id', scenarioId)
    .single();

  if (!scenario) return null;

  if (scenario.center_lat != null && scenario.center_lng != null) {
    const center: ScenarioCenter = {
      lat: scenario.center_lat as number,
      lng: scenario.center_lng as number,
    };
    cache.set(scenarioId, center);
    return center;
  }

  // Fallback: derive from scenario_locations
  const { data: locations } = await supabaseAdmin
    .from('scenario_locations')
    .select('coordinates, location_type')
    .eq('scenario_id', scenarioId)
    .limit(30);

  if (!locations || locations.length === 0) return null;

  const typed = locations as Array<Record<string, unknown>>;

  // Prefer incident_site pin
  const incidentPin = typed.find((l) =>
    ((l.location_type as string) ?? '').includes('incident_site'),
  );

  let resolved: ScenarioCenter | null = null;

  if (incidentPin) {
    const coords = incidentPin.coordinates as { lat?: number; lng?: number } | null;
    if (coords?.lat != null && coords?.lng != null) {
      resolved = { lat: coords.lat, lng: coords.lng };
    }
  }

  // Fall back to first location with coordinates
  if (!resolved) {
    for (const loc of typed) {
      const coords = loc.coordinates as { lat?: number; lng?: number } | null;
      if (coords?.lat != null && coords?.lng != null) {
        resolved = { lat: coords.lat, lng: coords.lng };
        break;
      }
    }
  }

  // Fall back to centroid of all locations
  if (!resolved) {
    let sumLat = 0;
    let sumLng = 0;
    let count = 0;
    for (const loc of typed) {
      const coords = loc.coordinates as { lat?: number; lng?: number } | null;
      if (coords?.lat != null && coords?.lng != null) {
        sumLat += coords.lat;
        sumLng += coords.lng;
        count++;
      }
    }
    if (count > 0) {
      resolved = { lat: sumLat / count, lng: sumLng / count };
    }
  }

  if (!resolved) return null;

  cache.set(scenarioId, resolved);

  // Backfill the scenario record so future lookups skip the fallback chain
  supabaseAdmin
    .from('scenarios')
    .update({ center_lat: resolved.lat, center_lng: resolved.lng })
    .eq('id', scenarioId)
    .then(({ error: backfillErr }) => {
      if (backfillErr) {
        logger.warn(
          { error: backfillErr, scenarioId },
          'Failed to backfill scenario center coords',
        );
      } else {
        logger.info(
          { scenarioId, lat: resolved!.lat, lng: resolved!.lng },
          'Backfilled scenario center_lat/center_lng from locations',
        );
      }
    });

  return resolved;
}

/**
 * Resolve the geographic center for a session by looking up its scenario.
 */
export async function resolveSessionCenter(sessionId: string): Promise<ScenarioCenter | null> {
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id')
    .eq('id', sessionId)
    .single();

  if (!session?.scenario_id) return null;
  return resolveScenarioCenter(session.scenario_id as string);
}

/**
 * Evict a scenario from the center cache (e.g. after admin edits location).
 */
export function invalidateScenarioCenterCache(scenarioId: string): void {
  cache.delete(scenarioId);
}
