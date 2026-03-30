import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';

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
      const cloned = templateHazards.map((h) => {
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
}
