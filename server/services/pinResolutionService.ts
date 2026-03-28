/**
 * Pin Resolution Service
 *
 * Evaluates whether player-placed assets meet the resolution requirements of
 * hazard and casualty pins. Updates pin statuses, triggers cascade effects,
 * and emits WebSocket events for real-time UI updates.
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from '../services/websocketService.js';
import { haversineM as haversineMeters, pointInGeoJSONPolygon } from './geoUtils.js';

const PROXIMITY_THRESHOLD_M = 80;

interface PlacedAssetRow {
  id: string;
  asset_type: string;
  label: string | null;
  geometry: Record<string, unknown>;
  properties: Record<string, unknown> | null;
  team_name: string;
  status: string;
}

function extractAssetCenter(asset: PlacedAssetRow): { lat: number; lng: number } | null {
  const geom = asset.geometry;
  if (!geom) return null;
  const gType = geom.type as string;

  if (gType === 'Point') {
    const coords = geom.coordinates as number[];
    return { lat: coords[1], lng: coords[0] };
  }

  if (gType === 'LineString') {
    const coords = geom.coordinates as number[][];
    const mid = coords[Math.floor(coords.length / 2)];
    return { lat: mid[1], lng: mid[0] };
  }

  if (gType === 'Polygon') {
    const coords = (geom.coordinates as number[][][])[0];
    let latSum = 0;
    let lngSum = 0;
    for (const c of coords) {
      latSum += c[1];
      lngSum += c[0];
    }
    return { lat: latSum / coords.length, lng: lngSum / coords.length };
  }

  return null;
}

/**
 * Evaluate all active hazard pins for a session — check if nearby placed assets
 * meet their resolution requirements.
 */
export async function evaluateHazardResolution(sessionId: string): Promise<void> {
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id')
    .eq('id', sessionId)
    .single();
  if (!session) return;

  const { data: hazards } = await supabaseAdmin
    .from('scenario_hazards')
    .select('*')
    .eq('scenario_id', session.scenario_id)
    .or(`session_id.is.null,session_id.eq.${sessionId}`)
    .in('status', ['active', 'escalating', 'contained']);

  if (!hazards?.length) return;

  const { data: assets } = await supabaseAdmin
    .from('placed_assets')
    .select('id, asset_type, label, geometry, properties, team_name, status')
    .eq('session_id', sessionId)
    .eq('status', 'active');

  const assetList = (assets ?? []) as PlacedAssetRow[];

  for (const hazard of hazards) {
    const resReq = (hazard.resolution_requirements ?? {}) as Record<string, unknown>;
    const persReq = (hazard.personnel_requirements ?? {}) as Record<string, unknown>;
    const eqReq = (hazard.equipment_requirements ?? []) as Array<Record<string, unknown>>;

    if (!resReq.personnel_type && !persReq.primary_responder && eqReq.length === 0) continue;

    const nearbyAssets = assetList.filter((a) => {
      const center = extractAssetCenter(a);
      if (!center) return false;
      return (
        haversineMeters(hazard.location_lat, hazard.location_lng, center.lat, center.lng) <=
        PROXIMITY_THRESHOLD_M
      );
    });

    if (nearbyAssets.length === 0) continue;

    const nearbyTypes = new Set(nearbyAssets.map((a) => a.asset_type.toLowerCase()));

    const requiredPersonnel =
      (resReq.personnel_type as string)?.toLowerCase() ??
      (persReq.primary_responder as string)?.toLowerCase() ??
      '';
    const requiredCount =
      (resReq.personnel_count as number) ?? (persReq.minimum_count as number) ?? 1;
    const requiredEquipment = eqReq
      .filter((e) => e.critical)
      .map((e) => (e.equipment_type as string).toLowerCase());

    const matchingPersonnel = nearbyAssets.filter(
      (a) =>
        a.asset_type.toLowerCase().includes(requiredPersonnel) ||
        requiredPersonnel.includes(a.asset_type.toLowerCase()),
    );

    const hasEnoughPersonnel =
      matchingPersonnel.length >= requiredCount || requiredPersonnel === '';
    const hasRequiredEquipment =
      requiredEquipment.length === 0 ||
      requiredEquipment.every((eq) =>
        nearbyAssets.some((a) => a.asset_type.toLowerCase().includes(eq)),
      );

    let newStatus: string;
    if (hasEnoughPersonnel && hasRequiredEquipment) {
      newStatus = 'resolved';
    } else if (matchingPersonnel.length > 0 || nearbyTypes.size > 0) {
      newStatus = 'contained';
    } else {
      continue;
    }

    if (newStatus === hazard.status) continue;

    await supabaseAdmin.from('scenario_hazards').update({ status: newStatus }).eq('id', hazard.id);

    logger.info(
      { hazardId: hazard.id, hazardType: hazard.hazard_type, oldStatus: hazard.status, newStatus },
      'Hazard status updated by pin resolution',
    );

    try {
      getWebSocketService().broadcastToSession(sessionId, {
        type: 'hazard.updated',
        data: { hazard_id: hazard.id, status: newStatus, hazard_type: hazard.hazard_type },
        timestamp: new Date().toISOString(),
      });
    } catch {
      /* ws not initialized */
    }

    if (newStatus === 'resolved') {
      await handleHazardResolutionCascade(sessionId, session.scenario_id, hazard);
    }
  }
}

/**
 * When a hazard is resolved, unlock any casualties that were blocked by it.
 */
async function handleHazardResolutionCascade(
  sessionId: string,
  scenarioId: string,
  hazard: Record<string, unknown>,
): Promise<void> {
  const hazardLat = hazard.location_lat as number;
  const hazardLng = hazard.location_lng as number;

  const { data: blockedCasualties } = await supabaseAdmin
    .from('scenario_casualties')
    .select('*')
    .eq('scenario_id', scenarioId)
    .or(`session_id.is.null,session_id.eq.${sessionId}`)
    .in('status', ['undiscovered', 'identified']);

  if (!blockedCasualties?.length) return;

  for (const cas of blockedCasualties) {
    const conds = (cas.conditions ?? {}) as Record<string, unknown>;
    const accessibility = conds.accessibility as string;

    if (!accessibility || accessibility === 'open') continue;

    const dist = haversineMeters(hazardLat, hazardLng, cas.location_lat, cas.location_lng);
    if (dist > 150) continue;

    const updatedConds = { ...conds, accessibility: 'open' };
    await supabaseAdmin
      .from('scenario_casualties')
      .update({ conditions: updatedConds, updated_at: new Date().toISOString() })
      .eq('id', cas.id);

    try {
      getWebSocketService().broadcastToSession(sessionId, {
        type: 'casualty.updated',
        data: { casualty_id: cas.id, status: cas.status, accessibility: 'open' },
        timestamp: new Date().toISOString(),
      });
    } catch {
      /* ws not initialized */
    }

    logger.info(
      { casualtyId: cas.id, unlockedBy: hazard.id },
      'Casualty accessibility unlocked by hazard resolution',
    );
  }
}

const TREATMENT_DURATIONS: Record<string, number> = {
  red: 20,
  yellow: 12,
  green: 5,
  black: 0,
};

function isMedicalAsset(assetType: string): boolean {
  const t = assetType.toLowerCase();
  return t.includes('medic') || t.includes('paramedic') || t.includes('emt');
}

function isTransportAsset(assetType: string): boolean {
  const t = assetType.toLowerCase();
  return t.includes('ambulance') || t.includes('transport') || t.includes('medevac');
}

function isMedicalArea(assetType: string): boolean {
  const t = assetType.toLowerCase();
  return t.includes('triage') || t.includes('treatment') || t.includes('field_hospital');
}

function isInsideArea(lat: number, lng: number, asset: PlacedAssetRow): boolean {
  const geom = asset.geometry;
  if (!geom || geom.type !== 'Polygon') return false;
  const coords = (geom.coordinates as number[][][])?.[0];
  if (!coords?.length) return false;
  return pointInGeoJSONPolygon(lat, lng, coords);
}

/**
 * Evaluate casualty pins — advance lifecycle based on nearby assets and timing.
 */
export async function evaluateCasualtyResolution(sessionId: string): Promise<void> {
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id, start_time, current_state, inject_state_effects')
    .eq('id', sessionId)
    .single();
  if (!session) return;

  const elapsedMinutes = session.start_time
    ? Math.floor((Date.now() - new Date(session.start_time).getTime()) / 60000)
    : 0;

  const rawState = (session.current_state as Record<string, unknown>) ?? {};
  const injEffects = (session.inject_state_effects as Record<string, unknown>) ?? {};
  const triageModState = {
    ...((rawState.triage_state as Record<string, unknown>) ?? {}),
    ...((injEffects.triage_state as Record<string, unknown>) ?? {}),
  };
  const treatmentTimeMod = Math.max(0.5, Number(triageModState.treatment_time_modifier) || 1);

  const { data: casualties } = await supabaseAdmin
    .from('scenario_casualties')
    .select('*')
    .eq('scenario_id', session.scenario_id)
    .or(`session_id.is.null,session_id.eq.${sessionId}`)
    .not('status', 'in', '("resolved","transported","deceased")');

  if (!casualties?.length) return;

  const { data: assets } = await supabaseAdmin
    .from('placed_assets')
    .select('id, asset_type, label, geometry, properties, team_name, status')
    .eq('session_id', sessionId)
    .eq('status', 'active');

  const assetList = (assets ?? []) as PlacedAssetRow[];

  // Find medical area polygons for triage containment checks
  const medicalAreas = assetList.filter(
    (a) => a.geometry?.type === 'Polygon' && isMedicalArea(a.asset_type),
  );
  const assemblyAreas = assetList.filter(
    (a) =>
      a.geometry?.type === 'Polygon' &&
      (a.asset_type.toLowerCase().includes('assembly') ||
        a.asset_type.toLowerCase().includes('gathering')),
  );

  // Find hospital/off-map locations for transport destination
  const { data: hospitalLocs } = await supabaseAdmin
    .from('scenario_locations')
    .select('id, label, coordinates')
    .eq('scenario_id', session.scenario_id)
    .or('location_type.ilike.%hospital%,claimed_as.eq.hospital,conditions->>pin_category.eq.poi');

  for (const cas of casualties) {
    const conds = (cas.conditions ?? {}) as Record<string, unknown>;
    const mobility = conds.mobility as string;
    const accessibility = conds.accessibility as string;

    // --- Crowd/evacuee_group at assembly → resolved ---
    if (
      (cas.casualty_type === 'crowd' || cas.casualty_type === 'evacuee_group') &&
      cas.status === 'at_assembly'
    ) {
      const pendingTriage = conds.pending_triage_endorsement === true;
      if (!pendingTriage) {
        const minutesSinceUpdate = cas.updated_at
          ? Math.floor((Date.now() - new Date(cas.updated_at).getTime()) / 60000)
          : 0;
        if (
          minutesSinceUpdate >= 5 &&
          assemblyAreas.some((a) => isInsideArea(cas.location_lat, cas.location_lng, a))
        ) {
          await updateCasualtyStatus(sessionId, cas.id, 'resolved');
        }
      }
      continue;
    }

    if (cas.casualty_type !== 'patient') continue;

    // --- endorsed_to_transport → transported (ambulance nearby) ---
    if (cas.status === 'endorsed_to_transport') {
      const nearbyTransport = assetList.filter((a) => {
        if (!isTransportAsset(a.asset_type)) return false;
        const center = extractAssetCenter(a);
        if (!center) return false;
        return (
          haversineMeters(cas.location_lat, cas.location_lng, center.lat, center.lng) <=
          PROXIMITY_THRESHOLD_M
        );
      });

      if (nearbyTransport.length > 0) {
        // Find nearest hospital to set as destination
        let destLat = cas.location_lat + 0.005;
        let destLng = cas.location_lng;
        let destLabel = 'Hospital';
        if (hospitalLocs?.length) {
          let bestDist = Infinity;
          for (const h of hospitalLocs) {
            const hCoords = h.coordinates as { lat?: number; lng?: number } | null;
            if (!hCoords?.lat) continue;
            const d = haversineMeters(
              cas.location_lat,
              cas.location_lng,
              hCoords.lat!,
              hCoords.lng!,
            );
            if (d < bestDist) {
              bestDist = d;
              destLat = hCoords.lat!;
              destLng = hCoords.lng!;
              destLabel = (h.label as string) ?? 'Hospital';
            }
          }
        }

        await supabaseAdmin
          .from('scenario_casualties')
          .update({
            status: 'transported',
            destination_lat: destLat,
            destination_lng: destLng,
            destination_label: destLabel,
            movement_speed_mpm: 500,
            destination_reached_status: 'transported',
            updated_at: new Date().toISOString(),
          })
          .eq('id', cas.id);

        broadcastStatus(sessionId, cas.id, 'transported');
      }
      continue;
    }

    // --- in_treatment → endorsed_to_transport (treatment duration elapsed) ---
    if (cas.status === 'in_treatment') {
      const treatmentStarted = conds.treatment_started_at as number | undefined;
      const triageColor = (conds.player_triage_color ?? conds.triage_color ?? 'green') as string;
      const baseDuration = TREATMENT_DURATIONS[triageColor] ?? 12;
      const duration = baseDuration * treatmentTimeMod;
      if (treatmentStarted != null && elapsedMinutes - treatmentStarted >= duration) {
        await updateCasualtyStatus(sessionId, cas.id, 'endorsed_to_transport');
      }
      continue;
    }

    // --- endorsed_to_triage → in_treatment (inside medical area with medic) ---
    if (cas.status === 'endorsed_to_triage') {
      const insideMedical = medicalAreas.some((a) =>
        isInsideArea(cas.location_lat, cas.location_lng, a),
      );
      const nearbyMedic = assetList.some((a) => {
        if (!isMedicalAsset(a.asset_type)) return false;
        const center = extractAssetCenter(a);
        if (!center) return false;
        return (
          haversineMeters(cas.location_lat, cas.location_lng, center.lat, center.lng) <=
          PROXIMITY_THRESHOLD_M
        );
      });

      if (insideMedical && nearbyMedic) {
        const updatedConds = { ...conds, treatment_started_at: elapsedMinutes };
        await supabaseAdmin
          .from('scenario_casualties')
          .update({
            status: 'in_treatment',
            conditions: updatedConds,
            updated_at: new Date().toISOString(),
          })
          .eq('id', cas.id);
        broadcastStatus(sessionId, cas.id, 'in_treatment');
      }
      continue;
    }

    // --- identified → being_evacuated (original logic) ---
    if (accessibility && accessibility !== 'open') continue;

    const nearbyAssets = assetList.filter((a) => {
      const center = extractAssetCenter(a);
      if (!center) return false;
      return (
        haversineMeters(cas.location_lat, cas.location_lng, center.lat, center.lng) <=
        PROXIMITY_THRESHOLD_M
      );
    });

    if (nearbyAssets.length === 0) continue;

    const hasMedical = nearbyAssets.some((a) => isMedicalAsset(a.asset_type));

    let newStatus: string | null = null;

    if (cas.status === 'identified' && mobility === 'trapped') {
      const hasExtractionEquipment = nearbyAssets.some(
        (a) =>
          a.asset_type.toLowerCase().includes('stretcher') ||
          a.asset_type.toLowerCase().includes('cutting') ||
          a.asset_type.toLowerCase().includes('rescue'),
      );
      if (hasExtractionEquipment && hasMedical) {
        newStatus = 'being_evacuated';
      }
    } else if (cas.status === 'identified' && mobility === 'non_ambulatory') {
      const hasStretcher = nearbyAssets.some((a) =>
        a.asset_type.toLowerCase().includes('stretcher'),
      );
      if (hasStretcher || hasMedical) {
        newStatus = 'being_evacuated';
      }
    } else if (cas.status === 'identified' && hasMedical) {
      newStatus = 'being_evacuated';
    }

    if (newStatus && newStatus !== cas.status) {
      await updateCasualtyStatus(sessionId, cas.id, newStatus);
    }
  }
}

async function updateCasualtyStatus(
  sessionId: string,
  casualtyId: string,
  status: string,
): Promise<void> {
  await supabaseAdmin
    .from('scenario_casualties')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', casualtyId);
  broadcastStatus(sessionId, casualtyId, status);
}

function broadcastStatus(sessionId: string, casualtyId: string, status: string): void {
  try {
    getWebSocketService().broadcastToSession(sessionId, {
      type: 'casualty.updated',
      data: { casualty_id: casualtyId, status },
      timestamp: new Date().toISOString(),
    });
  } catch {
    /* ws not initialized */
  }
}

/**
 * Combined evaluation — called on placement creation/update and periodic ticks.
 */
export async function evaluatePinResolution(sessionId: string): Promise<void> {
  await Promise.all([evaluateHazardResolution(sessionId), evaluateCasualtyResolution(sessionId)]);
}
