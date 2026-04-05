/**
 * Live Counter Service
 *
 * Computes all team counters directly from scenario_casualties status counts
 * and scenario_hazards statuses, replacing synthetic accumulators.
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { haversineM, pointInPolygon } from './geoUtils.js';

export interface AreaOccupancy {
  area_label: string;
  headcount: number;
}

export interface LiveCounters {
  fire_rescue: {
    active_fires: number;
    fires_contained: number;
    fires_resolved: number;
    hazards_active: number;
    hazards_resolved: number;
    casualties_in_hot_zone: number;
    extracted_to_warm: number;
    debris_cleared: number;
  };
  evacuation: {
    civilians_at_assembly: number;
    total_evacuated: number;
    still_inside: number;
    in_transit: number;
    convergent_crowds_count: number;
  };
  triage: {
    awaiting_triage: number;
    being_moved: number;
    in_treatment: number;
    red_immediate: number;
    yellow_delayed: number;
    green_minor: number;
    black_deceased: number;
    ready_for_transport: number;
    transported: number;
    deaths_on_site: number;
    total_patients: number;
  };
  bomb_squad: {
    tips_received: number;
    devices_found: number;
    false_alarms_cleared: number;
    devices_rendered_safe: number;
    active_threats: number;
    detonations: number;
    sweeps_completed: number;
    exclusion_zones_active: number;
  };
  area_occupancy: AreaOccupancy[];
}

/**
 * Compute live pin-driven counters from actual casualty and hazard data.
 */
export async function computeLiveCounters(
  sessionId: string,
  scenarioId: string,
): Promise<LiveCounters> {
  const [casualtyResult, hazardResult] = await Promise.all([
    supabaseAdmin
      .from('scenario_casualties')
      .select(
        'id, casualty_type, status, headcount, conditions, location_lat, location_lng, destination_lat',
      )
      .eq('scenario_id', scenarioId)
      .eq('session_id', sessionId),
    supabaseAdmin
      .from('scenario_hazards')
      .select('id, hazard_type, status, location_lat, location_lng, zones, properties')
      .eq('scenario_id', scenarioId)
      .eq('session_id', sessionId),
  ]);

  const casualties = (casualtyResult.data ?? []) as CasualtyRow[];
  const hazards = (hazardResult.data ?? []) as HazardRow[];

  // --- Fire/Rescue counters ---
  const fireHazards = hazards.filter(
    (h) =>
      h.hazard_type?.toLowerCase().includes('fire') ||
      h.hazard_type?.toLowerCase().includes('blaze') ||
      h.hazard_type?.toLowerCase().includes('flame'),
  );
  const debrisHazards = hazards.filter(
    (h) =>
      h.hazard_type?.toLowerCase().includes('debris') ||
      h.hazard_type?.toLowerCase().includes('structural') ||
      h.hazard_type?.toLowerCase().includes('collapse'),
  );

  const activeFires = fireHazards.filter(
    (h) => h.status === 'active' || h.status === 'escalating',
  ).length;
  const firesContained = fireHazards.filter((h) => h.status === 'contained').length;
  const firesResolved = fireHazards.filter((h) => h.status === 'resolved').length;
  const debrisCleared = debrisHazards.filter((h) => h.status === 'resolved').length;

  // Broad hazard counters: all non-explosive hazards handled by fire/rescue
  const nonExplosiveHazards = hazards.filter(
    (h) => !/suspicious|secondary_device|explosive|bomb|ied/i.test(h.hazard_type ?? ''),
  );
  const hazardsActive = nonExplosiveHazards.filter(
    (h) => h.status === 'active' || h.status === 'escalating' || h.status === 'contained',
  ).length;
  const hazardsResolved = nonExplosiveHazards.filter((h) => h.status === 'resolved').length;

  // Count casualties in hot zones (ground truth)
  let casualtiesInHotZone = 0;
  const patientsNotTerminal = casualties.filter(
    (c) =>
      c.casualty_type === 'patient' && !['resolved', 'transported', 'deceased'].includes(c.status),
  );
  for (const patient of patientsNotTerminal) {
    for (const hazard of hazards) {
      const zones = hazard.zones as ZoneRow[] | null;
      if (!zones?.length) continue;
      const hotZone = zones.find((z) => z.zone_type === 'hot');
      if (!hotZone) continue;
      if (hotZone.polygon?.length) {
        if (pointInPolygon(patient.location_lat, patient.location_lng, hotZone.polygon)) {
          casualtiesInHotZone++;
          break;
        }
      } else {
        const dist = haversineM(
          patient.location_lat,
          patient.location_lng,
          hazard.location_lat,
          hazard.location_lng,
        );
        if (dist <= hotZone.radius_m) {
          casualtiesInHotZone++;
          break;
        }
      }
    }
  }

  const extractedToWarm = casualties.filter(
    (c) =>
      c.casualty_type === 'patient' &&
      (c.conditions as Record<string, unknown>)?.extracted === true,
  ).length;

  // --- Evacuation counters ---
  const crowds = casualties.filter(
    (c) => c.casualty_type === 'crowd' || c.casualty_type === 'evacuee_group',
  );

  const civiliansAtAssembly = crowds
    .filter((c) => c.status === 'at_assembly')
    .reduce((sum, c) => sum + c.headcount, 0);

  const totalEvacuated = crowds
    .filter((c) => ['at_assembly', 'resolved'].includes(c.status))
    .reduce((sum, c) => sum + c.headcount, 0);

  const stillInside = crowds
    .filter((c) =>
      ['identified', 'being_evacuated', 'being_moved', 'undiscovered'].includes(c.status),
    )
    .reduce((sum, c) => sum + c.headcount, 0);

  const inTransit = crowds
    .filter(
      (c) =>
        (c.status === 'being_evacuated' || c.status === 'being_moved') && c.destination_lat != null,
    )
    .reduce((sum, c) => sum + c.headcount, 0);

  const convergentCrowds = casualties.filter(
    (c) => c.casualty_type === 'convergent_crowd' && !['resolved', 'deceased'].includes(c.status),
  );
  const convergentCrowdsCount = convergentCrowds.reduce((sum, c) => sum + c.headcount, 0);

  // --- Triage counters ---
  const patients = casualties.filter((c) => c.casualty_type === 'patient');

  const awaitingTriage = patients.filter(
    (c) => c.status === 'awaiting_triage' || c.status === 'endorsed_to_triage',
  ).length;
  const beingMoved = patients.filter(
    (c) => c.status === 'being_moved' || c.status === 'being_evacuated',
  ).length;
  const inTreatment = patients.filter((c) => c.status === 'in_treatment').length;
  const readyForTransport = patients.filter((c) => c.status === 'endorsed_to_transport').length;
  const transported = patients.filter((c) => c.status === 'transported').length;
  const deathsOnSite = patients.filter((c) => c.status === 'deceased').length;

  const triageColor = (c: CasualtyRow) => {
    const conds = (c.conditions ?? {}) as Record<string, unknown>;
    return (conds.player_triage_color ?? conds.triage_color ?? '') as string;
  };
  const redImmediate = patients.filter((c) => triageColor(c) === 'red').length;
  const yellowDelayed = patients.filter((c) => triageColor(c) === 'yellow').length;
  const greenMinor = patients.filter((c) => triageColor(c) === 'green').length;
  const blackDeceased = patients.filter(
    (c) => triageColor(c) === 'black' || c.status === 'deceased',
  ).length;

  // --- Bomb squad counters ---
  const suspiciousPackages = hazards.filter(
    (h) =>
      h.hazard_type?.toLowerCase().includes('suspicious') ||
      h.hazard_type?.toLowerCase().includes('secondary_device'),
  );
  const deviceActive = suspiciousPackages.filter((h) => h.status === 'active').length;
  const deviceResolved = suspiciousPackages.filter((h) => h.status === 'resolved');
  const deviceFalseAlarms = deviceResolved.filter((h) => {
    const props = (h.properties ?? {}) as Record<string, unknown>;
    return props.is_live === false;
  }).length;
  const deviceRenderedSafe = deviceResolved.filter((h) => {
    const props = (h.properties ?? {}) as Record<string, unknown>;
    return props.is_live === true;
  }).length;
  const deviceDetonations = hazards.filter((h) =>
    h.hazard_type?.toLowerCase().includes('secondary_explosion'),
  ).length;

  // Sweep count from session_events (async fetch — run in parallel with area occupancy)
  const { count: sweepsCount } = await supabaseAdmin
    .from('session_events')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId)
    .eq('event_type', 'bomb_squad_sweep');

  // Exclusion zones from placed_assets
  const { count: exclusionCount } = await supabaseAdmin
    .from('placed_assets')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId)
    .ilike('asset_type', '%exclusion%');

  // Tips received: count published inject events whose title contains 'Suspicious Package'
  const { count: tipsCount } = await supabaseAdmin
    .from('session_events')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId)
    .eq('event_type', 'inject')
    .ilike('metadata->>title', '%Suspicious Package%');

  // --- Area occupancy: aggregate headcounts by current_area label ---
  const areaMap = new Map<string, number>();
  for (const c of casualties) {
    if (['resolved', 'transported', 'deceased'].includes(c.status)) continue;
    const conds = (c.conditions ?? {}) as Record<string, unknown>;
    const areaLabel = conds.current_area as string | undefined;
    if (!areaLabel) continue;
    areaMap.set(areaLabel, (areaMap.get(areaLabel) ?? 0) + c.headcount);
  }
  const areaOccupancy: AreaOccupancy[] = Array.from(areaMap.entries())
    .map(([area_label, headcount]) => ({ area_label, headcount }))
    .sort((a, b) => b.headcount - a.headcount);

  const counters: LiveCounters = {
    fire_rescue: {
      active_fires: activeFires,
      fires_contained: firesContained,
      fires_resolved: firesResolved,
      hazards_active: hazardsActive,
      hazards_resolved: hazardsResolved,
      casualties_in_hot_zone: casualtiesInHotZone,
      extracted_to_warm: extractedToWarm,
      debris_cleared: debrisCleared,
    },
    evacuation: {
      civilians_at_assembly: civiliansAtAssembly,
      total_evacuated: totalEvacuated,
      still_inside: stillInside,
      in_transit: inTransit,
      convergent_crowds_count: convergentCrowdsCount,
    },
    triage: {
      awaiting_triage: awaitingTriage,
      being_moved: beingMoved,
      in_treatment: inTreatment,
      red_immediate: redImmediate,
      yellow_delayed: yellowDelayed,
      green_minor: greenMinor,
      black_deceased: blackDeceased,
      ready_for_transport: readyForTransport,
      transported,
      deaths_on_site: deathsOnSite,
      total_patients: patients.length,
    },
    bomb_squad: {
      tips_received: tipsCount ?? 0,
      devices_found: suspiciousPackages.length,
      false_alarms_cleared: deviceFalseAlarms,
      devices_rendered_safe: deviceRenderedSafe,
      active_threats: deviceActive,
      detonations: deviceDetonations,
      sweeps_completed: sweepsCount ?? 0,
      exclusion_zones_active: exclusionCount ?? 0,
    },
    area_occupancy: areaOccupancy,
  };

  logger.debug({ sessionId, counters }, 'Live counters computed');
  return counters;
}

interface CasualtyRow {
  id: string;
  casualty_type: string;
  status: string;
  headcount: number;
  conditions: Record<string, unknown> | null;
  location_lat: number;
  location_lng: number;
  destination_lat: number | null;
}

interface HazardRow {
  id: string;
  hazard_type: string;
  status: string;
  location_lat: number;
  location_lng: number;
  zones: unknown;
  properties?: Record<string, unknown>;
}

interface ZoneRow {
  zone_type: string;
  radius_m: number;
  polygon?: [number, number][];
}
