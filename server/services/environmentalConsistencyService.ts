/**
 * Checkpoint 2: Environmental consistency evaluation.
 * Compares a decision's details to the scenario's layout/environment ground truth.
 * Used to fire environmental mismatch injects, skip positive objective progress, and cap robustness.
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { publishInjectToSession } from '../routes/injects.js';
import type { Server as SocketServer } from 'socket.io';

export type EnvironmentalConsistencySeverity = 'low' | 'medium' | 'high';
export type EnvironmentalConsistencyErrorType = 'capacity' | 'location' | 'flow' | 'other';

export interface EnvironmentalConsistencyResult {
  consistent: boolean;
  severity?: EnvironmentalConsistencySeverity;
  error_type?: EnvironmentalConsistencyErrorType;
  reason?: string;
}

function buildGroundTruthSummary(insiderKnowledge: Record<string, unknown>): string {
  const layout = insiderKnowledge.layout_ground_truth as
    | {
        evacuee_count?: number;
        exits?: Array<{ id?: string; label?: string; flow_per_min?: number; status?: string }>;
        zones?: Array<{ id?: string; label?: string; capacity?: number; type?: string }>;
      }
    | undefined;
  if (!layout) return '';
  const parts: string[] = [];
  if (layout.evacuee_count != null) parts.push(`Evacuees: ${layout.evacuee_count}`);
  if (layout.exits?.length)
    parts.push(
      `Exits: ${layout.exits.map((e) => `${e.label ?? e.id ?? 'Exit'}${e.flow_per_min != null ? ` ${e.flow_per_min}/min` : ''}${e.status ? ` [${e.status}]` : ''}`).join('; ')}`,
    );
  if (layout.zones?.length)
    parts.push(
      `Zones/areas: ${layout.zones.map((z) => `${z.label ?? z.id ?? 'Zone'}${z.capacity != null ? ` capacity ${z.capacity}` : ''}${z.type ? ` type ${z.type}` : ''}`).join('; ')}`,
    );
  return parts.length > 0 ? parts.join('. ') : '';
}

/**
 * Evaluate whether a decision's details are consistent with the scenario's environment.
 * Uses scenario.insider_knowledge (layout_ground_truth). If no ground truth, returns consistent.
 * On AI failure/timeout, returns consistent to avoid blocking execute.
 * When incident is provided, only flag contradictions relevant to that incident; prefer consistent when the decision does not make layout-specific claims that contradict ground truth.
 */
export async function evaluateDecisionAgainstEnvironment(
  sessionId: string,
  decision: { id: string; title: string; description: string; type: string | null },
  openAiApiKey: string | undefined,
  incident?: { title: string; description: string } | null,
): Promise<EnvironmentalConsistencyResult> {
  const consistentDefault: EnvironmentalConsistencyResult = { consistent: true };
  if (!openAiApiKey) return consistentDefault;

  try {
    const { data: session, error: sessionErr } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id')
      .eq('id', sessionId)
      .single();
    if (sessionErr || !session) {
      logger.debug(
        { sessionId, error: sessionErr },
        'Session not found for environmental consistency',
      );
      return consistentDefault;
    }

    const { data: scenario, error: scenarioErr } = await supabaseAdmin
      .from('scenarios')
      .select('id, description, insider_knowledge')
      .eq('id', (session as { scenario_id: string }).scenario_id)
      .single();
    if (scenarioErr || !scenario) return consistentDefault;

    const insiderKnowledge = ((scenario as { insider_knowledge?: Record<string, unknown> })
      .insider_knowledge ?? {}) as Record<string, unknown>;
    const groundTruthSummary = buildGroundTruthSummary(insiderKnowledge);
    if (!groundTruthSummary) {
      logger.debug(
        { sessionId, scenarioId: (scenario as { id: string }).id },
        'No layout ground truth for environmental check',
      );
      return consistentDefault;
    }

    const incidentBlock =
      incident?.title != null || incident?.description != null
        ? ` The decision is in response to a specific incident. Only flag contradictions that are RELEVANT to that incident (e.g. for "Journalists at triage", do not penalize lack of exit/layout claims; for "Evacuation route blocked", focus on route/exit/capacity claims). Prefer consistent: true when the decision does not make layout-specific claims that contradict ground truth. When consistent is false, phrase the reason as: "Given the incident (X), the decision proposed Y which contradicts ground truth Z."`
        : '';

    const systemPrompt = `You are an expert crisis management evaluator. Given a decision (title and description) and the scenario's ENVIRONMENT GROUND TRUTH, determine if the decision's details are consistent with that environment.${incidentBlock}

Rules:
- consistent: true if the decision does not contradict the ground truth (e.g. capacities, exit names, flow rates, zones). Generic or high-level decisions with no specific numbers/locations are consistent.
- consistent: false if the decision states specific details that contradict the ground truth (e.g. "assembly area North for 100" but North capacity is 50; "use East exit" but East does not exist; "clear in 2 minutes" but flow cannot support that).
- severity: "low" = minor mismatch (e.g. 60 in 50-capacity area); "medium" = clear mismatch (e.g. 100 in 50, wrong exit name); "high" = dangerous/impossible (e.g. 200 in 50, non-existent exit).
- error_type: "capacity" = assembly/triage capacity overflow; "location" = wrong place/exit; "flow" = unrealistic flow/timing; "other" = generic.
- reason: one clear sentence for the player (e.g. "The assembly area you designated has a safe capacity of 50; your plan assumed 100.").

Return ONLY valid JSON: { "consistent": boolean, "severity": "low"|"medium"|"high" (if consistent is false), "error_type": "capacity"|"location"|"flow"|"other" (if consistent is false), "reason": "..." (if consistent is false) }`;

    const incidentUserBlock =
      incident?.title != null || incident?.description != null
        ? `\nINCIDENT (this decision is in response to):\nTitle: ${incident.title ?? ''}\nDescription: ${incident.description ?? ''}\n\n`
        : '';

    const userPrompt = `ENVIRONMENT GROUND TRUTH: ${groundTruthSummary}
${incidentUserBlock}DECISION:
Title: ${decision.title}
Description: ${decision.description}

Is this decision consistent with the environment? Return JSON only.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 300,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      logger.warn(
        { status: response.status },
        'OpenAI API error in evaluateDecisionAgainstEnvironment',
      );
      return consistentDefault;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return consistentDefault;

    const parsed = JSON.parse(content) as {
      consistent?: boolean;
      severity?: string;
      error_type?: string;
      reason?: string;
    };

    const consistent = parsed.consistent === true;
    if (consistent) return { consistent: true };

    const severity = ['low', 'medium', 'high'].includes(parsed.severity ?? '')
      ? (parsed.severity as EnvironmentalConsistencySeverity)
      : 'medium';
    const error_type = ['capacity', 'location', 'flow', 'other'].includes(parsed.error_type ?? '')
      ? (parsed.error_type as EnvironmentalConsistencyErrorType)
      : 'other';
    const reason =
      typeof parsed.reason === 'string' && parsed.reason.trim()
        ? parsed.reason.trim().slice(0, 500)
        : 'Decision details do not match current site conditions.';

    return { consistent: false, severity, error_type, reason };
  } catch (err) {
    logger.warn(
      { err, sessionId, decisionId: decision.id },
      'evaluateDecisionAgainstEnvironment failed, treating as consistent',
    );
    return consistentDefault;
  }
}

/**
 * Create and publish an environmental mismatch inject for the team(s) that made the decision.
 * Call when Checkpoint 2 returns consistent: false.
 */
export async function createAndPublishEnvironmentalMismatchInject(
  params: {
    sessionId: string;
    scenarioId: string;
    trainerId: string;
    authorTeamNames: string[];
    result: EnvironmentalConsistencyResult;
    decisionId: string;
  },
  io: SocketServer,
): Promise<void> {
  const { sessionId, scenarioId, trainerId, authorTeamNames, result } = params;
  if (result.consistent) return;

  const title =
    result.error_type === 'capacity'
      ? 'Environmental mismatch: capacity'
      : result.error_type === 'location'
        ? 'Environmental mismatch: location or route'
        : result.error_type === 'flow'
          ? 'Environmental mismatch: flow or timing'
          : 'Decision at odds with site conditions';
  const content = result.reason ?? 'Decision details do not match current site conditions.';
  const severity = result.severity === 'high' ? 'high' : 'medium';
  const requiresResponse = result.severity === 'high' || result.severity === 'medium';
  const targetTeams = authorTeamNames.length > 0 ? authorTeamNames : null;
  const injectScope =
    targetTeams && targetTeams.length > 0 ? ('team_specific' as const) : ('universal' as const);

  try {
    const { data: createdInject, error: createError } = await supabaseAdmin
      .from('scenario_injects')
      .insert({
        scenario_id: scenarioId,
        trigger_time_minutes: null,
        trigger_condition: null,
        type: 'field_update',
        title,
        content,
        severity,
        affected_roles: [],
        inject_scope: injectScope,
        target_teams: targetTeams,
        requires_response: requiresResponse,
        requires_coordination: false,
        ai_generated: true,
        triggered_by_user_id: null,
      })
      .select()
      .single();

    if (createError) {
      logger.warn(
        { error: createError, sessionId },
        'Failed to create environmental mismatch inject',
      );
      return;
    }
    if (createdInject) {
      await publishInjectToSession(createdInject.id, sessionId, trainerId, io);
      logger.info(
        {
          sessionId,
          injectId: createdInject.id,
          severity: result.severity,
          error_type: result.error_type,
        },
        'Environmental mismatch inject published',
      );
    }
  } catch (err) {
    logger.warn({ err, sessionId }, 'Error publishing environmental mismatch inject');
  }
}
