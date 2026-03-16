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
  }
}
