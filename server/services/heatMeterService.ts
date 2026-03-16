/**
 * Heat Meter Service
 *
 * Ratio-based decision quality scoring. Each team starts at 0% heat.
 * Mistakes add weighted points; good decisions earn small cooldown credits.
 * Heat = max(0, (mistake_points - cooldown_points) / total_decisions) * 100, capped at 100.
 *
 * Stored in session.current_state.heat_meter[teamName] and broadcast via state.updated.
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from './websocketService.js';
import { publishInjectToSession } from '../routes/injects.js';
import type { Server as IoServer } from 'socket.io';
import type { PathwayOutcome } from './aiService.js';

export type MistakeType = 'vague' | 'contradiction' | 'prereq' | 'no_intel' | 'rejected' | 'good';

const MISTAKE_WEIGHTS: Record<MistakeType, number> = {
  vague: 1,
  contradiction: 2,
  prereq: 1,
  no_intel: 0.5,
  rejected: 3,
  good: 0,
};

const GOOD_DECISION_COOLDOWN = 0.3;

export interface TeamHeatState {
  mistake_points: number;
  cooldown_points: number;
  total_decisions: number;
  heat_percentage: number;
}

function computeHeatPercentage(state: TeamHeatState): number {
  if (state.total_decisions === 0) return 0;
  const raw = ((state.mistake_points - state.cooldown_points) / state.total_decisions) * 100;
  return Math.min(100, Math.max(0, Math.round(raw * 10) / 10));
}

/**
 * Update a team's heat meter after a decision is evaluated.
 * Reads current heat_meter from session.current_state, applies the change,
 * writes back to the DB and broadcasts via WebSocket.
 */
export async function updateTeamHeatMeter(
  sessionId: string,
  teamName: string,
  mistakeType: MistakeType,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _io?: IoServer | null,
): Promise<{ heat_percentage: number }> {
  const { data: session, error: sessErr } = await supabaseAdmin
    .from('sessions')
    .select('current_state')
    .eq('id', sessionId)
    .single();

  if (sessErr || !session) {
    logger.warn({ sessionId, error: sessErr }, 'Heat meter: session not found');
    return { heat_percentage: 0 };
  }

  const currentState = ((session as { current_state?: Record<string, unknown> }).current_state ??
    {}) as Record<string, unknown>;
  const heatMeterAll = (currentState.heat_meter ?? {}) as Record<string, TeamHeatState>;

  const teamState: TeamHeatState = heatMeterAll[teamName] ?? {
    mistake_points: 0,
    cooldown_points: 0,
    total_decisions: 0,
    heat_percentage: 0,
  };

  teamState.total_decisions += 1;

  if (mistakeType === 'good') {
    teamState.cooldown_points += GOOD_DECISION_COOLDOWN;
  } else {
    teamState.mistake_points += MISTAKE_WEIGHTS[mistakeType];
  }

  teamState.heat_percentage = computeHeatPercentage(teamState);
  heatMeterAll[teamName] = teamState;

  // Re-read latest state to avoid clobbering concurrent writes (e.g. inject state_effects)
  const { data: freshRow } = await supabaseAdmin
    .from('sessions')
    .select('current_state')
    .eq('id', sessionId)
    .single();
  const freshState = (freshRow?.current_state as Record<string, unknown>) ?? currentState;
  const nextState = { ...freshState, heat_meter: heatMeterAll };

  await supabaseAdmin.from('sessions').update({ current_state: nextState }).eq('id', sessionId);

  try {
    getWebSocketService().stateUpdated?.(sessionId, {
      state: nextState,
      timestamp: new Date().toISOString(),
    });
  } catch {
    // WebSocket broadcast is non-critical
  }

  logger.info(
    {
      sessionId,
      team: teamName,
      mistakeType,
      heat: teamState.heat_percentage,
      decisions: teamState.total_decisions,
    },
    'Heat meter updated',
  );

  return { heat_percentage: teamState.heat_percentage };
}

// ---------------------------------------------------------------------------
// Heat-to-Robustness Band Mapping
// ---------------------------------------------------------------------------

export function heatPercentageToRobustnessBand(heat: number): 'low' | 'medium' | 'high' {
  if (heat >= 60) return 'low';
  if (heat >= 30) return 'medium';
  return 'high';
}

// ---------------------------------------------------------------------------
// Immediate Pathway Outcome Selection
// ---------------------------------------------------------------------------

function parseOutcomes(raw: PathwayOutcome[] | string | null | undefined): PathwayOutcome[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as PathwayOutcome[] | PathwayOutcome;
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Select a matching pathway outcome based on heat-derived robustness band
 * and publish it immediately. Marks the row as consumed to avoid duplicates.
 */
export async function selectAndPublishPathwayOutcome(
  sessionId: string,
  teamName: string,
  heatPercentage: number,
  scenarioId: string,
  trainerId: string,
  io: IoServer,
): Promise<void> {
  try {
    const { data: rows } = await supabaseAdmin
      .from('session_pathway_outcomes')
      .select('id, outcomes, trigger_inject_id')
      .eq('session_id', sessionId)
      .is('consumed_at', null)
      .order('evaluated_at', { ascending: false });

    if (!rows || rows.length === 0) return;

    const typedRows = rows as Array<{
      id: string;
      outcomes: PathwayOutcome[] | string;
      trigger_inject_id?: string;
    }>;

    // Find a row whose trigger inject targets this team (or is universal)
    let chosenRow: (typeof typedRows)[number] | null = null;
    for (const row of typedRows) {
      const outcomes = parseOutcomes(row.outcomes);
      if (outcomes.length === 0) continue;
      const scope = outcomes[0]?.inject_payload?.inject_scope ?? 'universal';
      const targetTeams = (outcomes[0]?.inject_payload?.target_teams as string[] | null) ?? [];
      if (scope !== 'team_specific' || targetTeams.length === 0 || targetTeams.includes(teamName)) {
        chosenRow = row;
        break;
      }
    }
    if (!chosenRow) return;

    const outcomes = parseOutcomes(chosenRow.outcomes);
    if (outcomes.length === 0) return;

    const band = heatPercentageToRobustnessBand(heatPercentage);
    const matching = outcomes.filter((o) => o.robustness_band === band);
    const toPublish =
      matching.length > 0 ? matching[0] : outcomes[Math.floor(Math.random() * outcomes.length)];

    const requiresResponse = band !== 'high';

    const { data: createdInject, error: createError } = await supabaseAdmin
      .from('scenario_injects')
      .insert({
        scenario_id: scenarioId,
        trigger_time_minutes: null,
        trigger_condition: null,
        type: toPublish.inject_payload.type,
        title: toPublish.inject_payload.title,
        content: toPublish.inject_payload.content,
        severity: toPublish.inject_payload.severity,
        affected_roles: toPublish.inject_payload.affected_roles ?? [],
        inject_scope: toPublish.inject_payload.inject_scope ?? 'universal',
        target_teams: toPublish.inject_payload.target_teams ?? null,
        requires_response: requiresResponse,
        requires_coordination: false,
        ai_generated: true,
        triggered_by_user_id: null,
        generation_source: 'pathway_outcome',
      })
      .select()
      .single();

    if (createError || !createdInject) {
      logger.warn(
        { error: createError, sessionId, team: teamName },
        'Pathway outcome inject insert failed',
      );
      return;
    }

    await publishInjectToSession(createdInject.id, sessionId, trainerId, io);

    await supabaseAdmin
      .from('session_pathway_outcomes')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', chosenRow.id);

    logger.info(
      {
        sessionId,
        team: teamName,
        injectId: createdInject.id,
        robustnessBand: band,
        heatPercentage,
        outcomeId: toPublish.outcome_id,
        triggerInjectId: chosenRow.trigger_inject_id,
      },
      'Pathway outcome inject published (per-decision)',
    );
  } catch (err) {
    logger.warn({ err, sessionId, team: teamName }, 'selectAndPublishPathwayOutcome failed');
  }
}

// ---------------------------------------------------------------------------
// Public Sentiment Nudge (media team only)
// ---------------------------------------------------------------------------

const SENTIMENT_DELTAS: Record<MistakeType, number> = {
  good: 0.5,
  vague: -0.5,
  contradiction: -1.0,
  prereq: -0.5,
  no_intel: -0.3,
  rejected: -2.0,
};

export async function nudgePublicSentiment(
  sessionId: string,
  mistakeType: MistakeType,
): Promise<void> {
  try {
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('current_state')
      .eq('id', sessionId)
      .single();
    if (!session) return;

    const currentState = ((session as { current_state?: Record<string, unknown> }).current_state ??
      {}) as Record<string, unknown>;
    const mediaState = (currentState.media_state ?? {}) as Record<string, unknown>;
    const current =
      typeof mediaState.public_sentiment === 'number' ? mediaState.public_sentiment : 5;

    const delta = SENTIMENT_DELTAS[mistakeType];
    const nudged = Math.min(10, Math.max(1, Math.round((current + delta) * 10) / 10));

    // Re-read latest state to avoid clobbering concurrent writes
    const { data: freshRow } = await supabaseAdmin
      .from('sessions')
      .select('current_state')
      .eq('id', sessionId)
      .single();
    const freshState = (freshRow?.current_state as Record<string, unknown>) ?? currentState;
    const freshMedia = (freshState.media_state as Record<string, unknown>) ?? mediaState;
    const nextState = {
      ...freshState,
      media_state: { ...freshMedia, public_sentiment: nudged },
    };

    await supabaseAdmin.from('sessions').update({ current_state: nextState }).eq('id', sessionId);

    try {
      getWebSocketService().stateUpdated?.(sessionId, {
        state: nextState,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // non-critical
    }

    logger.info(
      { sessionId, mistakeType, previous: current, nudged, delta },
      'Public sentiment nudged (media decision)',
    );
  } catch (err) {
    logger.warn({ err, sessionId }, 'nudgePublicSentiment failed');
  }
}
