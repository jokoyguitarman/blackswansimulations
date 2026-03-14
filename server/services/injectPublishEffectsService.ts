/**
 * Inject publish effects service (Implementation Guide Phase 5.1).
 * Central place for "when this inject is published, apply penalty and/or state updates."
 * Reads objective_penalty and state_effect from the inject (DB columns) and applies them.
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { addObjectivePenalty } from './objectiveTrackingService.js';
import { getWebSocketService } from './websocketService.js';

/**
 * Apply effects configured on the inject: objective penalty and state_effect merge into
 * session current_state (evacuation_state, triage_state, media_state).
 * Called from publishInjectToSession after the inject event is created and pathway outcomes are triggered.
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
      const { data: sessionForState } = await supabaseAdmin
        .from('sessions')
        .select('current_state')
        .eq('id', sessionId)
        .single();
      const currentState = (sessionForState?.current_state as Record<string, unknown>) || {};
      const nextState = { ...currentState };
      for (const [key, effectVal] of Object.entries(stateEffect)) {
        if (!key.endsWith('_state') || !effectVal || typeof effectVal !== 'object') continue;
        const current = (nextState[key] as Record<string, unknown>) || {};
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
          (nextState as Record<string, unknown>)[key] = {
            ...current,
            ...effect,
            exits_congested: deduped,
          };
        } else {
          const flatEffect: Record<string, unknown> = {};
          for (const [ek, ev] of Object.entries(effect)) {
            if (ev != null && typeof ev === 'object' && !Array.isArray(ev)) continue;
            flatEffect[ek] = ev;
          }
          (nextState as Record<string, unknown>)[key] = {
            ...current,
            ...flatEffect,
          };
        }
      }
      await supabaseAdmin.from('sessions').update({ current_state: nextState }).eq('id', sessionId);
      getWebSocketService().stateUpdated?.(sessionId, {
        state: nextState,
        timestamp: new Date().toISOString(),
      });
    } catch (stateErr) {
      logger.error(
        { err: stateErr, sessionId, injectId },
        'Failed to apply state effect on inject publish',
      );
    }
  }
}
