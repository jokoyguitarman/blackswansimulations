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
    in_treatment: number;
    red_immediate: number;
    yellow_delayed: number;
    green_minor: number;
    ready_for_transport: number;
    transported: number;
    deaths_on_site: number;
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
      .or(`session_id.is.null,session_id.eq.${sessionId}`),
    supabaseAdmin
      .from('scenario_hazards')
      .select('id, hazard_type, status, location_lat, location_lng, zones')
      .eq('scenario_id', scenarioId)
      .or(`session_id.is.null,session_id.eq.${sessionId}`),
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
    .filter((c) => ['identified', 'being_evacuated', 'undiscovered'].includes(c.status))
    .reduce((sum, c) => sum + c.headcount, 0);

  const inTransit = crowds
    .filter((c) => c.status === 'being_evacuated' && c.destination_lat != null)
    .reduce((sum, c) => sum + c.headcount, 0);

  const convergentCrowds = casualties.filter(
    (c) => c.casualty_type === 'convergent_crowd' && !['resolved', 'deceased'].includes(c.status),
  );
  const convergentCrowdsCount = convergentCrowds.reduce((sum, c) => sum + c.headcount, 0);

  // --- Triage counters ---
  const patients = casualties.filter((c) => c.casualty_type === 'patient');

  const awaitingTriage = patients.filter((c) => c.status === 'endorsed_to_triage').length;
  const inTreatment = patients.filter((c) => c.status === 'in_treatment').length;
  const readyForTransport = patients.filter((c) => c.status === 'endorsed_to_transport').length;
  const transported = patients.filter((c) => c.status === 'transported').length;
  const deathsOnSite = patients.filter((c) => c.status === 'deceased').length;

  const inTreatmentPatients = patients.filter((c) => c.status === 'in_treatment');
  const triageColor = (c: CasualtyRow) => {
    const conds = (c.conditions ?? {}) as Record<string, unknown>;
    return (conds.player_triage_color ?? conds.triage_color ?? '') as string;
  };
  const redImmediate = inTreatmentPatients.filter((c) => triageColor(c) === 'red').length;
  const yellowDelayed = inTreatmentPatients.filter((c) => triageColor(c) === 'yellow').length;
  const greenMinor = inTreatmentPatients.filter((c) => triageColor(c) === 'green').length;

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
      in_treatment: inTreatment,
      red_immediate: redImmediate,
      yellow_delayed: yellowDelayed,
      green_minor: greenMinor,
      ready_for_transport: readyForTransport,
      transported,
      deaths_on_site: deathsOnSite,
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
}

interface ZoneRow {
  zone_type: string;
  radius_m: number;
  polygon?: [number, number][];
}
