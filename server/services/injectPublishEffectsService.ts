/**
 * Inject publish effects service (Implementation Guide Phase 5.1).
 * Central place for "when this inject is published, apply penalty and/or state updates."
 * Reads objective_penalty and state_effect from the inject (DB columns) and applies them.
 *
 * State effects are written to a SEPARATE column (inject_state_effects) so they cannot
 * be clobbered by the counter scheduler or any other current_state writer.
 * The frontend and condition evaluator deep-merge both columns at read time.
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { addObjectivePenalty } from './objectiveTrackingService.js';
import { getWebSocketService } from './websocketService.js';

/**
 * Deep-merge helper: merge `inject_state_effects` on top of `current_state`.
 * Two-level merge so that e.g. evacuation_state fields from both sources coexist.
 */
export function mergeStateWithInjectEffects(
  currentState: Record<string, unknown>,
  injectEffects: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...currentState };
  for (const [key, val] of Object.entries(injectEffects)) {
    if (
      val != null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      merged[key] != null &&
      typeof merged[key] === 'object' &&
      !Array.isArray(merged[key])
    ) {
      merged[key] = {
        ...(merged[key] as Record<string, unknown>),
        ...(val as Record<string, unknown>),
      };
    } else {
      merged[key] = val;
    }
  }
  return merged;
}

/**
 * Apply effects configured on the inject: objective penalty and state_effect merge into
 * session inject_state_effects (separate column from current_state).
 * Sentiment nudge is the one exception — written to current_state because the AI
 * scheduler also manages public_sentiment there.
 */
export async function applyInjectPublishEffects(
  sessionId: string,
  injectId: string,
  inject: Record<string, unknown>,
): Promise<void> {
  const objectivePenalty = inject.objective_penalty as
    | { objective_id?: string; reason?: string; points?: number }
    | undefined;
  if (
    objectivePenalty?.objective_id &&
    objectivePenalty?.reason != null &&
    typeof objectivePenalty?.points === 'number'
  ) {
    try {
      await addObjectivePenalty(
        sessionId,
        objectivePenalty.objective_id,
        objectivePenalty.reason,
        objectivePenalty.points,
      );
    } catch (penaltyErr) {
      logger.error(
        {
          err: penaltyErr,
          sessionId,
          injectId,
          objectiveId: objectivePenalty.objective_id,
        },
        'Failed to apply objective penalty on inject publish',
      );
    }
  }

  const stateEffect = inject.state_effect as Record<string, Record<string, unknown>> | undefined;
  if (stateEffect && typeof stateEffect === 'object' && Object.keys(stateEffect).length > 0) {
    try {
      // Read the SEPARATE inject_state_effects column (only this service writes to it)
      const { data: sessionForState } = await supabaseAdmin
        .from('sessions')
        .select('inject_state_effects, current_state')
        .eq('id', sessionId)
        .single();
      const existing = (sessionForState?.inject_state_effects as Record<string, unknown>) || {};
      const nextEffects = { ...existing };

      for (const [key, effectVal] of Object.entries(stateEffect)) {
        if (!key.endsWith('_state') || !effectVal || typeof effectVal !== 'object') continue;
        const current = (nextEffects[key] as Record<string, unknown>) || {};
        const effect = effectVal as Record<string, unknown>;
        if (
          key === 'evacuation_state' &&
          Array.isArray(current.exits_congested) &&
          Array.isArray(effect.exits_congested)
        ) {
          const combined = [...current.exits_congested, ...effect.exits_congested].filter(
            (v): v is string => typeof v === 'string',
          );
          const deduped = [...new Set(combined)];
          nextEffects[key] = { ...current, ...effect, exits_congested: deduped };
        } else {
          const flatEffect: Record<string, unknown> = {};
          const ADDITIVE_KEYS = new Set([
            'unaddressed_misinformation_count',
            'deaths_on_site',
            'casualties',
            'patients_waiting',
          ]);
          for (const [ek, ev] of Object.entries(effect)) {
            if (ev != null && typeof ev === 'object' && !Array.isArray(ev)) continue;
            if (ADDITIVE_KEYS.has(ek) && typeof ev === 'number') {
              flatEffect[ek] = Math.max(0, (Number(current[ek]) || 0) + ev);
            } else {
              flatEffect[ek] = ev;
            }
          }
          nextEffects[key] = { ...current, ...flatEffect };
        }
      }

      // Write inject effects to the separate column (race-free)
      await supabaseAdmin
        .from('sessions')
        .update({ inject_state_effects: nextEffects })
        .eq('id', sessionId);

      // Broadcast the merged view so frontend has the complete picture
      const currentState = (sessionForState?.current_state as Record<string, unknown>) || {};
      const mergedState = mergeStateWithInjectEffects(currentState, nextEffects);
      getWebSocketService().stateUpdated?.(sessionId, {
        state: mergedState,
        inject_state_effects: nextEffects,
        timestamp: new Date().toISOString(),
      });

      logger.info(
        { sessionId, injectId, effectKeys: Object.keys(nextEffects) },
        'Inject state effects written to inject_state_effects column',
      );

      // Sentiment nudge: still written to current_state because the AI scheduler
      // also manages public_sentiment there (both writers are aware of it).
      const mediaEffect = stateEffect.media_state as Record<string, unknown> | undefined;
      if (mediaEffect && typeof mediaEffect.sentiment_nudge === 'number') {
        const media = (currentState.media_state as Record<string, unknown>) || {};
        const curSentiment =
          typeof media.public_sentiment === 'number' ? media.public_sentiment : 5;
        const nudge = mediaEffect.sentiment_nudge as number;
        const newSentiment = Math.max(1, Math.min(10, Math.round(curSentiment + nudge)));
        const updatedMedia: Record<string, unknown> = {
          ...media,
          public_sentiment: newSentiment,
          sentiment_nudge_applied: nudge,
        };
        delete updatedMedia.sentiment_nudge;
        await supabaseAdmin
          .from('sessions')
          .update({ current_state: { ...currentState, media_state: updatedMedia } })
          .eq('id', sessionId);
        logger.info(
          { sessionId, injectId, nudge, from: curSentiment, to: newSentiment },
          'Applied deterministic sentiment nudge from inject',
        );
      }
    } catch (stateErr) {
      logger.error({ err: stateErr, sessionId, injectId }, 'Failed to apply inject state effects');
    }

    // Adversary sighting: update the last_known_adversary pin on the map
    const sighting = stateEffect.adversary_sighting as Record<string, unknown> | undefined;
    if (sighting && typeof sighting.lat === 'number' && typeof sighting.lng === 'number') {
      try {
        await handleAdversarySighting(sessionId, injectId, sighting);
      } catch (sightErr) {
        logger.error({ err: sightErr, sessionId, injectId }, 'Failed to handle adversary sighting');
      }
    }

    // Adversary casualties: spawn new casualty pins
    const advCasualties = stateEffect.adversary_casualties as Record<string, unknown> | undefined;
    if (advCasualties && typeof advCasualties.count === 'number' && advCasualties.count > 0) {
      try {
        await spawnAdversaryCasualties(sessionId, injectId, advCasualties);
      } catch (casErr) {
        logger.error({ err: casErr, sessionId, injectId }, 'Failed to spawn adversary casualties');
      }
    }
  }
}

/**
 * Update the last_known_adversary scenario location pin with new coordinates
 * from an adversary sighting inject.
 */
async function handleAdversarySighting(
  sessionId: string,
  injectId: string,
  sighting: Record<string, unknown>,
): Promise<void> {
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id')
    .eq('id', sessionId)
    .single();
  if (!session?.scenario_id) return;

  const adversaryId = (sighting.adversary_id as string) || 'adversary_1';
  const lat = sighting.lat as number;
  const lng = sighting.lng as number;
  const zoneLabel = (sighting.zone_label as string) || 'Unknown';
  const description = (sighting.description as string) || '';
  const intelSource = (sighting.intel_source as string) || 'eyewitness';
  const confidence = (sighting.confidence as string) || 'low';
  const accuracyRadiusM = (sighting.accuracy_radius_m as number) || 500;
  const directionOfTravel = (sighting.direction_of_travel as string) || null;
  const resourceHint = (sighting.resource_hint as string) || null;
  const testsContainment = (sighting.tests_containment as boolean) || false;

  let effectiveConfidence = confidence;
  let effectiveRadius = accuracyRadiusM;

  if (resourceHint) {
    const boost = await checkResourceGatedIntelBoost(sessionId, resourceHint);
    if (boost) {
      effectiveConfidence = boost.upgradedConfidence;
      effectiveRadius = boost.upgradedRadius;
      logger.info(
        { sessionId, resourceHint, from: confidence, to: effectiveConfidence },
        'Intel confidence boosted by deployed resource',
      );
    }
  }

  if (testsContainment) {
    await evaluateContainment(sessionId, injectId, { lat, lng }, zoneLabel, adversaryId);
  }

  const { data: existingPin } = await supabaseAdmin
    .from('scenario_locations')
    .select('id, conditions')
    .eq('scenario_id', session.scenario_id)
    .eq('pin_category', 'last_known_adversary')
    .limit(1)
    .maybeSingle();

  if (existingPin) {
    const elapsed = await getSessionElapsedMinutes(sessionId);
    const oldConditions = (existingPin.conditions as Record<string, unknown>) || {};
    const updatedConditions = {
      ...oldConditions,
      adversary_id: adversaryId,
      zone_label: zoneLabel,
      last_seen_at_minutes: elapsed,
      last_seen_description: description,
      pin_category: 'last_known_adversary',
      intel_source: intelSource,
      confidence: effectiveConfidence,
      accuracy_radius_m: effectiveRadius,
      direction_of_travel: directionOfTravel,
      resource_hint: resourceHint,
      tests_containment: testsContainment,
    };
    await supabaseAdmin
      .from('scenario_locations')
      .update({
        coordinates: { lat, lng },
        label: `Last Seen: ${zoneLabel}`,
        conditions: updatedConditions,
      })
      .eq('id', existingPin.id);

    getWebSocketService().broadcastToSession(sessionId, {
      type: 'adversary_sighting_update',
      data: {
        pin_id: existingPin.id,
        adversary_id: adversaryId,
        coordinates: { lat, lng },
        zone_label: zoneLabel,
        description,
        last_seen_at_minutes: elapsed,
        intel_source: intelSource,
        confidence: effectiveConfidence,
        accuracy_radius_m: effectiveRadius,
        direction_of_travel: directionOfTravel,
        tests_containment: testsContainment,
      },
      timestamp: new Date().toISOString(),
    });
    logger.info(
      { sessionId, injectId, adversaryId, lat, lng, zoneLabel, intelSource, effectiveConfidence },
      'Last-known adversary pin updated',
    );
  } else {
    logger.warn({ sessionId, adversaryId }, 'No last_known_adversary pin found to update');
  }
}

const RESOURCE_ASSET_MAP: Record<string, string[]> = {
  cctv_operator: ['cctv_monitor', 'cctv_operator', 'surveillance'],
  k9_unit: ['k9_unit', 'k9'],
  helicopter: ['helicopter', 'air_support', 'helo'],
};

async function checkResourceGatedIntelBoost(
  sessionId: string,
  resourceHint: string,
): Promise<{ upgradedConfidence: string; upgradedRadius: number } | null> {
  const assetTypes = RESOURCE_ASSET_MAP[resourceHint];
  if (!assetTypes?.length) return null;

  const { data: placements } = await supabaseAdmin
    .from('placed_assets')
    .select('asset_type')
    .eq('session_id', sessionId)
    .eq('status', 'active')
    .in('asset_type', assetTypes);

  if (placements && placements.length > 0) {
    return { upgradedConfidence: 'high', upgradedRadius: 50 };
  }
  return null;
}

const CONTAINMENT_CORDON_TYPES = [
  'police_cordon',
  'barrier',
  'blast_cordon',
  'ops_cordon',
  'fire_cordon',
  'safe_perimeter',
  'press_cordon',
  'crush_barrier',
  'crowd_barrier',
  'crowd_barrier_line',
  'platform_barrier',
  'mall_lockdown_gate',
];

async function evaluateContainment(
  sessionId: string,
  injectId: string,
  suspectCoords: { lat: number; lng: number },
  zoneLabel: string,
  adversaryId: string,
): Promise<void> {
  const { data: cordons } = await supabaseAdmin
    .from('placed_assets')
    .select('id, asset_type, label, geometry, team_name')
    .eq('session_id', sessionId)
    .eq('status', 'active')
    .in('asset_type', CONTAINMENT_CORDON_TYPES);

  if (!cordons?.length) {
    getWebSocketService().broadcastToSession(sessionId, {
      type: 'containment_breach',
      data: {
        adversary_id: adversaryId,
        zone_label: zoneLabel,
        coordinates: suspectCoords,
        result: 'no_cordons',
        message: `Suspect passed through ${zoneLabel} — no cordons detected in the area. Containment failed.`,
      },
      timestamp: new Date().toISOString(),
    });
    logger.info({ sessionId, injectId, zoneLabel }, 'Containment test: no cordons found');
    return;
  }

  const PROXIMITY_THRESHOLD_DEG = 300 / 111_320;
  let nearbyCordon = false;

  for (const cordon of cordons) {
    const geom = cordon.geometry as Record<string, unknown>;
    if (!geom) continue;

    let checkPoints: Array<{ lat: number; lng: number }> = [];

    if (geom.type === 'LineString') {
      const coords = geom.coordinates as [number, number][];
      if (coords?.length) {
        checkPoints = coords.map((c) => ({ lat: c[1], lng: c[0] }));
      }
    } else if (geom.type === 'Point') {
      const coords = geom.coordinates as [number, number];
      if (coords?.length === 2) {
        checkPoints = [{ lat: coords[1], lng: coords[0] }];
      }
    } else if (geom.type === 'Polygon') {
      const coords = (geom.coordinates as [number, number][][])?.[0];
      if (coords?.length) {
        checkPoints = coords.map((c) => ({ lat: c[1], lng: c[0] }));
      }
    }

    for (const pt of checkPoints) {
      const dLat = pt.lat - suspectCoords.lat;
      const dLng = pt.lng - suspectCoords.lng;
      const dist = Math.sqrt(dLat * dLat + dLng * dLng);
      if (dist <= PROXIMITY_THRESHOLD_DEG) {
        nearbyCordon = true;
        break;
      }
    }
    if (nearbyCordon) break;
  }

  if (nearbyCordon) {
    getWebSocketService().broadcastToSession(sessionId, {
      type: 'containment_held',
      data: {
        adversary_id: adversaryId,
        zone_label: zoneLabel,
        coordinates: suspectCoords,
        result: 'contained',
        message: `Suspect approached cordon near ${zoneLabel} — turned back. Perimeter holding. Last seen retreating.`,
      },
      timestamp: new Date().toISOString(),
    });
    logger.info({ sessionId, injectId, zoneLabel }, 'Containment test: cordon held');
  } else {
    getWebSocketService().broadcastToSession(sessionId, {
      type: 'containment_breach',
      data: {
        adversary_id: adversaryId,
        zone_label: zoneLabel,
        coordinates: suspectCoords,
        result: 'breach',
        message: `Suspect breached containment at ${zoneLabel} — no cordon covering this sector. Suspect now outside perimeter.`,
      },
      timestamp: new Date().toISOString(),
    });
    logger.info({ sessionId, injectId, zoneLabel }, 'Containment test: breach — no cordon nearby');
  }
}

async function getSessionElapsedMinutes(sessionId: string): Promise<number> {
  const { data } = await supabaseAdmin
    .from('sessions')
    .select('started_at')
    .eq('id', sessionId)
    .single();
  if (!data?.started_at) return 0;
  const startedAt = new Date(data.started_at as string);
  return Math.max(0, (Date.now() - startedAt.getTime()) / 60000);
}

/**
 * Spawn new casualty pins when an adversary-caused casualty inject fires.
 */
async function spawnAdversaryCasualties(
  sessionId: string,
  injectId: string,
  casualtyDef: Record<string, unknown>,
): Promise<void> {
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id')
    .eq('id', sessionId)
    .single();
  if (!session?.scenario_id) return;

  const count = (casualtyDef.count as number) || 1;
  const coords = casualtyDef.coordinates as { lat: number; lng: number } | undefined;
  const zoneLabel = (casualtyDef.zone_label as string) || 'Unknown';
  const severityDist = (casualtyDef.severity_distribution as Record<string, number>) || {};

  if (!coords || typeof coords.lat !== 'number' || typeof coords.lng !== 'number') {
    logger.warn({ sessionId, injectId }, 'adversary_casualties missing coordinates');
    return;
  }

  const METER_TO_DEG = 1 / 111_320;
  const newCasualties = [];
  for (let i = 0; i < count; i++) {
    let severity = 'yellow';
    if (severityDist.red && i < severityDist.red) severity = 'red';
    else if (severityDist.yellow && i < (severityDist.red || 0) + severityDist.yellow)
      severity = 'yellow';
    else severity = 'green';

    const angle = Math.random() * 2 * Math.PI;
    const dist = 5 + Math.random() * 15;
    const lat = coords.lat + Math.cos(angle) * dist * METER_TO_DEG;
    const lng =
      coords.lng +
      Math.sin(angle) * dist * METER_TO_DEG * (1 / Math.cos((coords.lat * Math.PI) / 180));

    newCasualties.push({
      scenario_id: session.scenario_id,
      casualty_type: 'patient',
      location_lat: lat,
      location_lng: lng,
      floor_level: 'G',
      headcount: 1,
      conditions: {
        triage_category: severity,
        mechanism_of_injury: 'adversary_attack',
        zone_label: zoneLabel,
        spawned_by_inject: injectId,
      },
      status: 'undiscovered',
      appears_at_minutes: 0,
    });
  }

  const { error } = await supabaseAdmin.from('scenario_casualties').insert(newCasualties);
  if (error) {
    logger.error({ error, sessionId, injectId }, 'Failed to insert adversary casualties');
    return;
  }

  getWebSocketService().broadcastToSession(sessionId, {
    type: 'adversary_casualties_spawned',
    data: {
      count,
      zone_label: zoneLabel,
      coordinates: coords,
    },
    timestamp: new Date().toISOString(),
  });
  logger.info({ sessionId, injectId, count, zoneLabel }, 'Adversary casualties spawned');
}
