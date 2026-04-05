import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';

/**
 * Reset adversary sighting pins back to their pristine template state.
 * - Deletes any runtime-created fallback sighting pins (those without source_inject_id)
 * - Resets all pre-created sighting pins back to sighting_status: 'hidden'
 */
async function resetSightingPinsForScenario(scenarioId: string): Promise<void> {
  try {
    const { data: sightingPins } = await supabaseAdmin
      .from('scenario_locations')
      .select('id, conditions')
      .eq('scenario_id', scenarioId)
      .eq('pin_category', 'adversary_sighting');

    if (!sightingPins || sightingPins.length === 0) return;

    const toDelete: string[] = [];
    const toReset: Array<{ id: string; conditions: Record<string, unknown> }> = [];

    // Track seen source_inject_ids to deduplicate pins sharing the same inject
    const seenInjectIds = new Set<string>();

    for (const pin of sightingPins) {
      const conds = (pin.conditions as Record<string, unknown>) || {};
      const sourceInjectId = conds.source_inject_id as string | null;

      if (!sourceInjectId) {
        toDelete.push(pin.id as string);
      } else if (seenInjectIds.has(sourceInjectId)) {
        toDelete.push(pin.id as string);
      } else {
        seenInjectIds.add(sourceInjectId);
        if (conds.sighting_status !== 'hidden') {
          toReset.push({ id: pin.id as string, conditions: conds });
        }
      }
    }

    if (toDelete.length > 0) {
      const { error } = await supabaseAdmin.from('scenario_locations').delete().in('id', toDelete);
      if (error) {
        logger.warn(
          { error, scenarioId, count: toDelete.length },
          'Failed to delete orphaned sighting pins',
        );
      } else {
        logger.info(
          { scenarioId, count: toDelete.length },
          'Deleted orphaned runtime sighting pins',
        );
      }
    }

    for (const pin of toReset) {
      const originalConds = { ...pin.conditions };
      originalConds.sighting_status = 'hidden';
      delete originalConds.last_seen_at_minutes;
      delete originalConds.last_seen_description;
      delete originalConds.nato_grade;
      delete originalConds.source_reliability;
      delete originalConds.info_credibility;
      delete originalConds.debunked_at_minutes;
      delete originalConds.debunked_by_inject_id;

      await supabaseAdmin
        .from('scenario_locations')
        .update({ conditions: originalConds })
        .eq('id', pin.id);
    }

    if (toReset.length > 0) {
      logger.info({ scenarioId, count: toReset.length }, 'Reset sighting pins back to hidden');
    }
  } catch (err) {
    logger.warn({ err, scenarioId }, 'Error resetting sighting pins (non-blocking)');
  }
}

/**
 * Clones scenario-level casualties and hazards into session-scoped rows so
 * that each session has its own independent copy of pin state. This prevents
 * mutations in one session from bleeding into others that share the same
 * scenario.
 *
 * Called once when a session transitions to `in_progress`.
 */
export async function cloneScenarioPinsForSession(
  sessionId: string,
  scenarioId: string,
): Promise<void> {
  await resetSightingPinsForScenario(scenarioId);

  // --- Casualties ---
  const { data: existingSessionCasualties } = await supabaseAdmin
    .from('scenario_casualties')
    .select('id')
    .eq('scenario_id', scenarioId)
    .eq('session_id', sessionId)
    .limit(1);

  if (existingSessionCasualties && existingSessionCasualties.length > 0) {
    logger.info(
      { sessionId, scenarioId },
      'Session already has cloned casualties — skipping clone',
    );
  } else {
    const { data: templateCasualties } = await supabaseAdmin
      .from('scenario_casualties')
      .select('*')
      .eq('scenario_id', scenarioId)
      .is('session_id', null);

    if (templateCasualties && templateCasualties.length > 0) {
      const cloned = templateCasualties.map((c) => {
        const row = { ...(c as Record<string, unknown>) };
        delete row.id;
        delete row.created_at;
        delete row.updated_at;
        row.session_id = sessionId;
        return row;
      });

      const { error } = await supabaseAdmin.from('scenario_casualties').insert(cloned);
      if (error) {
        logger.error({ error, sessionId, scenarioId }, 'Failed to clone casualties for session');
      } else {
        logger.info(
          { sessionId, scenarioId, count: cloned.length },
          'Cloned scenario casualties into session',
        );
      }
    }
  }

  // --- Hazards ---
  const { data: existingSessionHazards } = await supabaseAdmin
    .from('scenario_hazards')
    .select('id')
    .eq('scenario_id', scenarioId)
    .eq('session_id', sessionId)
    .limit(1);

  if (existingSessionHazards && existingSessionHazards.length > 0) {
    logger.info({ sessionId, scenarioId }, 'Session already has cloned hazards — skipping clone');
  } else {
    const { data: templateHazards } = await supabaseAdmin
      .from('scenario_hazards')
      .select('*')
      .eq('scenario_id', scenarioId)
      .is('session_id', null);

    if (templateHazards && templateHazards.length > 0) {
      const cloned = templateHazards
        .filter((h) => (h as Record<string, unknown>).status !== 'delayed')
        .map((h) => {
          const row = { ...(h as Record<string, unknown>) };
          delete row.id;
          delete row.created_at;
          delete row.updated_at;
          row.session_id = sessionId;
          return row;
        });

      const { error } = await supabaseAdmin.from('scenario_hazards').insert(cloned);
      if (error) {
        logger.error({ error, sessionId, scenarioId }, 'Failed to clone hazards for session');
      } else {
        logger.info(
          { sessionId, scenarioId, count: cloned.length },
          'Cloned scenario hazards into session',
        );
      }
    }
  }

  // --- Sweep device pool + hidden devices ---
  const { data: scenarioRow } = await supabaseAdmin
    .from('scenarios')
    .select('sweep_device_pool')
    .eq('id', scenarioId)
    .single();

  const pool = (scenarioRow as Record<string, unknown> | null)?.sweep_device_pool;
  if (Array.isArray(pool) && pool.length > 0) {
    const { error: poolErr } = await supabaseAdmin
      .from('sessions')
      .update({ sweep_device_pool: pool, hidden_devices: [] })
      .eq('id', sessionId);
    if (poolErr) {
      logger.error({ error: poolErr, sessionId }, 'Failed to clone sweep_device_pool to session');
    } else {
      logger.info({ sessionId, poolSize: pool.length }, 'Cloned sweep_device_pool into session');
    }
  }
}
