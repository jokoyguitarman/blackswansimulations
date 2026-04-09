/**
 * Exit Flow Service
 *
 * Processes crowd/evacuee pins that have been dragged to exit pathway areas.
 * Computes flow rate based on exit properties and modifiers, then materializes
 * evacuated people outside the exit. Tracks handoff of injured to triage.
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from '../services/websocketService.js';
import {
  haversineM as haversineMeters,
  pointInGeoJSONPolygon as pointInPolygon,
} from './geoUtils.js';
import { placeOutsideAllZones } from './zonePlacementService.js';

const BASE_FLOW_RATE_PER_MIN = 40;

/**
 * Check if marshals are within range of a crowd/casualty pin location.
 * Returns true if at least 1 marshal-type asset is within the threshold.
 */
export async function hasMarshalProximity(
  sessionId: string,
  lat: number,
  lng: number,
  thresholdM = 100,
): Promise<boolean> {
  const { data: assets } = await supabaseAdmin
    .from('placed_assets')
    .select('asset_type, geometry')
    .eq('session_id', sessionId)
    .eq('status', 'active');

  if (!assets?.length) return false;

  for (const asset of assets) {
    const assetType = (asset.asset_type as string).toLowerCase();
    if (
      !assetType.includes('marshal') &&
      !assetType.includes('steward') &&
      !assetType.includes('police')
    )
      continue;

    const geom = asset.geometry as Record<string, unknown>;
    if (!geom) continue;

    let assetLat: number, assetLng: number;
    const gType = geom.type as string;

    if (gType === 'Point') {
      const coords = geom.coordinates as number[];
      assetLat = coords[1];
      assetLng = coords[0];
    } else if (gType === 'LineString') {
      const coords = geom.coordinates as number[][];
      const mid = coords[Math.floor(coords.length / 2)];
      assetLat = mid[1];
      assetLng = mid[0];
    } else if (gType === 'Polygon') {
      const coords = (geom.coordinates as number[][][])[0];
      let latSum = 0,
        lngSum = 0;
      for (const c of coords) {
        latSum += c[1];
        lngSum += c[0];
      }
      assetLat = latSum / coords.length;
      assetLng = lngSum / coords.length;
    } else continue;

    if (haversineMeters(lat, lng, assetLat, assetLng) <= thresholdM) {
      return true;
    }
  }

  return false;
}

/**
 * Process exit flow for a session. Runs each tick (called from the scheduler
 * or on a 2-minute interval).
 *
 * 1. Find all claimed exit locations
 * 2. Find exit pathway polygons (operational areas near claimed exits)
 * 3. For each crowd pin inside an exit pathway, compute flow rate and process
 * 4. Materialize evacuated people outside the exit
 */
export async function processExitFlow(sessionId: string): Promise<void> {
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id, start_time, current_state, inject_state_effects')
    .eq('id', sessionId)
    .single();
  if (!session?.start_time) return;

  // Find per-session claimed exits
  const { data: claims } = await supabaseAdmin
    .from('session_location_claims')
    .select('location_id, claimed_by_team, claimed_as, claim_exclusivity')
    .eq('session_id', sessionId);

  if (!claims?.length) return;

  const claimedLocationIds = claims.map((c) => c.location_id);
  const { data: claimedLocations } = await supabaseAdmin
    .from('scenario_locations')
    .select('*')
    .in('id', claimedLocationIds);

  if (!claimedLocations?.length) return;

  // Merge claim data onto location rows
  const claimMap = new Map(claims.map((c) => [c.location_id, c]));
  const claimedExits = claimedLocations.map((loc) => {
    const claim = claimMap.get(loc.id);
    return {
      ...loc,
      claimed_by_team: claim?.claimed_by_team ?? null,
      claimed_as: claim?.claimed_as ?? null,
      claim_exclusivity: claim?.claim_exclusivity ?? null,
    };
  });

  // Find operational area polygons placed by teams near claimed exits
  const { data: exitPathways } = await supabaseAdmin
    .from('placed_assets')
    .select('*')
    .eq('session_id', sessionId)
    .eq('status', 'active')
    .in('asset_type', ['operating_area', 'assembly_point', 'exit_pathway']);

  // Find crowd/evacuee pins that are eligible for exit flow processing
  const { data: crowdPins } = await supabaseAdmin
    .from('scenario_casualties')
    .select('*')
    .eq('scenario_id', session.scenario_id)
    .eq('session_id', sessionId)
    .eq('casualty_type', 'crowd')
    .in('status', ['being_evacuated', 'being_moved', 'at_exit']);

  if (!crowdPins?.length) return;

  // Pre-compute shared state modifiers
  const rawState = (session.current_state as Record<string, unknown>) ?? {};
  const injEffects = (session.inject_state_effects as Record<string, unknown>) ?? {};
  const evacState = {
    ...((rawState.evacuation_state as Record<string, unknown>) ?? {}),
    ...((injEffects.evacuation_state as Record<string, unknown>) ?? {}),
  };
  const flowRateMod = Math.max(0.1, Number(evacState.flow_rate_modifier) || 1);
  const complianceMod = Math.max(0.1, Number(evacState.crowd_compliance_score) || 1);

  // Count marshals for flow rate modifier
  const { data: marshalsNear } = await supabaseAdmin
    .from('placed_assets')
    .select('id')
    .eq('session_id', sessionId)
    .eq('status', 'active');
  const marshalCount = (marshalsNear ?? []).length;
  const marshalModifier = Math.min(2, 1 + (marshalCount > 2 ? 0.15 * (marshalCount - 2) : 0));

  for (const exit of claimedExits) {
    const exitCoords = exit.coordinates as { lat: number; lng: number };
    if (!exitCoords?.lat) continue;

    const exitConds = (exit.conditions as Record<string, unknown>) ?? {};
    const flowRateBase = (exitConds.capacity_flow_per_min as number) ?? BASE_FLOW_RATE_PER_MIN;
    const effectiveFlowRate = Math.floor(
      flowRateBase * marshalModifier * flowRateMod * complianceMod,
    );

    // Find operational areas within 200m of this exit
    const nearbyPathways = (exitPathways ?? []).filter((p) => {
      const geom = p.geometry as Record<string, unknown>;
      if (!geom || geom.type !== 'Polygon') return false;
      const coords = (geom.coordinates as number[][][])[0];
      let cLat = 0,
        cLng = 0;
      for (const c of coords) {
        cLat += c[1];
        cLng += c[0];
      }
      cLat /= coords.length;
      cLng /= coords.length;
      return haversineMeters(exitCoords.lat, exitCoords.lng, cLat, cLng) <= 200;
    });

    // Process crowd pins that are either:
    // 1. Inside a nearby exit pathway polygon (legacy spatial trigger), OR
    // 2. Have status 'at_exit' and are within 80m of this exit (decision-routed)
    for (const crowd of crowdPins ?? []) {
      let eligible = false;

      // Decision-routed: crowd arrived at exit via movement system
      if (crowd.status === 'at_exit') {
        if (
          haversineMeters(crowd.location_lat, crowd.location_lng, exitCoords.lat, exitCoords.lng) <=
          80
        ) {
          eligible = true;
        }
      }

      // Legacy: crowd is inside a pathway polygon near this exit
      if (!eligible && nearbyPathways.length > 0) {
        for (const pathway of nearbyPathways) {
          const pg = pathway.geometry as Record<string, unknown>;
          if (!pg || pg.type !== 'Polygon') continue;
          const coords = (pg.coordinates as number[][][])[0];
          if (pointInPolygon(crowd.location_lat, crowd.location_lng, coords)) {
            eligible = true;
            break;
          }
        }
      }

      if (!eligible) continue;

      // Process flow: deduct from headcount
      const processed = Math.min(crowd.headcount, effectiveFlowRate);
      const remaining = crowd.headcount - processed;
      const mixedWounded =
        ((crowd.conditions as Record<string, unknown>)?.mixed_wounded as Array<
          Record<string, unknown>
        >) ?? [];

      if (remaining <= 0) {
        // Fully evacuated — mark as resolved
        await supabaseAdmin
          .from('scenario_casualties')
          .update({ status: 'at_assembly', headcount: 0, updated_at: new Date().toISOString() })
          .eq('id', crowd.id);
      } else {
        // Partially evacuated
        await supabaseAdmin
          .from('scenario_casualties')
          .update({
            headcount: remaining,
            status: 'being_moved',
            updated_at: new Date().toISOString(),
          })
          .eq('id', crowd.id);
      }

      // Check if the original crowd had a final_destination stored by the decision system
      const crowdConds = (crowd.conditions ?? {}) as Record<string, unknown>;
      const finalDest = crowdConds.final_destination as
        | { lat: number; lng: number; label: string }
        | undefined;

      // Place evacuees outside all zones (near the exit)
      const exitRef = { lat: exitCoords.lat, lng: exitCoords.lng };
      const evacueeCoord = await placeOutsideAllZones(
        sessionId,
        exitRef,
        17,
        undefined,
        session.scenario_id as string,
      );
      const outsideLat = evacueeCoord.lat;
      const outsideLng = evacueeCoord.lng;

      const evacueeConditions: Record<string, unknown> = {
        behavior: 'calm',
        movement_direction: finalDest ? 'moving' : 'stationary',
        visible_description: `${processed} people evacuated through ${exit.label}`,
        mixed_wounded:
          mixedWounded.length > 0
            ? mixedWounded.map((w) => ({
                ...w,
                count: Math.ceil(
                  ((w.count as number) ?? 0) * (processed / (processed + remaining)),
                ),
              }))
            : [],
        pending_triage_endorsement: mixedWounded.length > 0,
        evacuated_through: exit.label,
        current_area: exit.label,
      };

      const newPin: Record<string, unknown> = {
        scenario_id: session.scenario_id,
        session_id: sessionId,
        casualty_type: 'evacuee_group',
        location_lat: outsideLat,
        location_lng: outsideLng,
        floor_level: 'G',
        headcount: processed,
        conditions: evacueeConditions,
        status: finalDest ? 'being_moved' : 'at_assembly',
        appears_at_minutes: 0,
      };

      // If there's a final destination, set movement fields so evacuees walk there
      if (finalDest) {
        newPin.destination_lat = finalDest.lat;
        newPin.destination_lng = finalDest.lng;
        newPin.destination_label = finalDest.label;
        newPin.movement_speed_mpm = 72; // walking speed
        newPin.destination_reached_status = 'at_assembly';
      }

      const { data: created } = await supabaseAdmin
        .from('scenario_casualties')
        .insert(newPin)
        .select()
        .single();

      if (created) {
        try {
          getWebSocketService().broadcastToSession(sessionId, {
            type: 'casualty.created',
            data: { casualty_id: created.id, evacuated_through: exit.label, count: processed },
            timestamp: new Date().toISOString(),
          });
        } catch {
          /* ws not initialized */
        }
      }

      try {
        getWebSocketService().broadcastToSession(sessionId, {
          type: 'casualty.updated',
          data: {
            casualty_id: crowd.id,
            headcount: remaining,
            status: remaining > 0 ? 'being_moved' : 'at_assembly',
          },
          timestamp: new Date().toISOString(),
        });
      } catch {
        /* ws not initialized */
      }

      logger.info(
        { sessionId, exitLabel: exit.label, processed, remaining },
        'Exit flow processed',
      );
    }
  }
}

/**
 * Check for pending triage endorsements — evacuated groups with wounded
 * that haven't been endorsed to triage. Called by deterioration cycle.
 */
export async function checkPendingEndorsements(sessionId: string): Promise<void> {
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id, start_time')
    .eq('id', sessionId)
    .single();
  if (!session?.start_time) return;

  const elapsedMinutes = Math.floor((Date.now() - new Date(session.start_time).getTime()) / 60000);

  const { data: evacuatedGroups } = await supabaseAdmin
    .from('scenario_casualties')
    .select('*')
    .eq('scenario_id', session.scenario_id)
    .eq('session_id', sessionId)
    .eq('casualty_type', 'evacuee_group')
    .eq('status', 'at_assembly');

  if (!evacuatedGroups?.length) return;

  for (const group of evacuatedGroups) {
    const conds = (group.conditions ?? {}) as Record<string, unknown>;
    if (!conds.pending_triage_endorsement) continue;

    const mixedWounded = (conds.mixed_wounded as Array<Record<string, unknown>>) ?? [];
    const woundedCount = mixedWounded.reduce((sum, w) => sum + ((w.count as number) ?? 0), 0);

    if (woundedCount === 0) continue;

    const minutesSinceUpdate = group.updated_at
      ? Math.floor((Date.now() - new Date(group.updated_at).getTime()) / 60000)
      : 0;

    if (minutesSinceUpdate >= 5) {
      await supabaseAdmin.from('scenario_injects').insert({
        scenario_id: session.scenario_id,
        session_id: sessionId,
        title: 'Unendorsed Wounded in Evacuee Group',
        body: `${woundedCount} walking wounded in an evacuated group near assembly area have NOT been endorsed to triage. Their condition may deteriorate without medical attention.`,
        inject_type: 'deterioration',
        trigger_type: 'time_based',
        trigger_minutes: elapsedMinutes,
        target_team: null,
        generation_source: 'deterioration_cycle',
      });

      logger.info(
        { sessionId, groupId: group.id, woundedCount },
        'Pending endorsement warning inject created',
      );
    }
  }
}

/**
 * Process non-ambulatory extraction: patients with stretcher teams + equipment
 * nearby are automatically extracted to the nearest triage area.
 */
export async function processNonAmbulatoryExtraction(sessionId: string): Promise<void> {
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id')
    .eq('id', sessionId)
    .single();
  if (!session) return;

  const { data: trappedPatients } = await supabaseAdmin
    .from('scenario_casualties')
    .select('*')
    .eq('scenario_id', session.scenario_id)
    .eq('session_id', sessionId)
    .eq('casualty_type', 'patient')
    .in('status', ['being_evacuated', 'being_moved']);

  if (!trappedPatients?.length) return;

  const { data: assets } = await supabaseAdmin
    .from('placed_assets')
    .select('id, asset_type, geometry')
    .eq('session_id', sessionId)
    .eq('status', 'active');

  if (!assets?.length) return;

  // Find triage areas (placed operational areas named triage)
  const triageAreas = (assets ?? []).filter(
    (a) =>
      (a.asset_type as string).toLowerCase().includes('triage') ||
      (a.asset_type as string).toLowerCase().includes('treatment'),
  );

  for (const patient of trappedPatients) {
    const conds = (patient.conditions ?? {}) as Record<string, unknown>;
    const mobility = conds.mobility as string;

    if (mobility !== 'non_ambulatory' && mobility !== 'trapped') continue;

    // Check for stretcher/rescue teams nearby
    const hasExtractors = (assets ?? []).some((a) => {
      const aType = (a.asset_type as string).toLowerCase();
      if (!aType.includes('stretcher') && !aType.includes('rescue') && !aType.includes('medic'))
        return false;

      const geom = a.geometry as Record<string, unknown>;
      if (!geom) return false;
      let aLat: number, aLng: number;
      if ((geom.type as string) === 'Point') {
        const coords = geom.coordinates as number[];
        aLat = coords[1];
        aLng = coords[0];
      } else return false;

      return haversineMeters(patient.location_lat, patient.location_lng, aLat, aLng) <= 80;
    });

    if (!hasExtractors) continue;

    // Move patient to triage area or nearest safe location
    let destLat = patient.location_lat + 0.001;
    let destLng = patient.location_lng;

    if (triageAreas.length > 0) {
      const tGeom = triageAreas[0].geometry as Record<string, unknown>;
      if (tGeom?.type === 'Polygon') {
        const coords = (tGeom.coordinates as number[][][])[0];
        let cLat = 0,
          cLng = 0;
        for (const c of coords) {
          cLat += c[1];
          cLng += c[0];
        }
        destLat = cLat / coords.length;
        destLng = cLng / coords.length;
      } else if (tGeom?.type === 'Point') {
        const coords = tGeom.coordinates as number[];
        destLat = coords[1];
        destLng = coords[0];
      }
    }

    await supabaseAdmin
      .from('scenario_casualties')
      .update({
        location_lat: destLat,
        location_lng: destLng,
        status: 'awaiting_triage',
        conditions: { ...conds, mobility: 'non_ambulatory', extracted: true },
        updated_at: new Date().toISOString(),
      })
      .eq('id', patient.id);

    try {
      getWebSocketService().broadcastToSession(sessionId, {
        type: 'casualty.updated',
        data: { casualty_id: patient.id, status: 'awaiting_triage', extracted: true },
        timestamp: new Date().toISOString(),
      });
    } catch {
      /* ws not initialized */
    }

    logger.info(
      { sessionId, casualtyId: patient.id },
      'Non-ambulatory patient extracted — awaiting triage decision',
    );
  }
}
