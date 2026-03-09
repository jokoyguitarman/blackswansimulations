import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { evaluateGateContentSatisfaction } from './decisionEvaluationAiService.js';

/**
 * Gate condition shape (from scenario_gates.condition JSONB).
 * content_hints and min_hints are used for the hybrid content check (description only).
 */
export interface GateCondition {
  team?: string;
  decision_types?: string[];
  content_hints?: string[];
  min_hints?: number;
  [key: string]: unknown;
}

/**
 * Not_met gate row with fields needed for band-based inject (vague + medium).
 */
export interface NotMetGate {
  gate_id: string;
  id: string;
  condition: GateCondition;
  objective_id: string | null;
  if_vague_decision_inject_id: string | null;
  if_medium_band_inject_id?: string | null;
}

/**
 * Check if decision body (description) satisfies the gate's content requirement.
 * Uses description only; case-insensitive substring match for hints.
 */
export function decisionSatisfiesGateContent(
  description: string,
  condition: GateCondition,
): boolean {
  const hints = condition.content_hints;
  const minHints = condition.min_hints ?? 0;
  if (!Array.isArray(hints) || hints.length === 0 || minHints <= 0) {
    return true;
  }
  const lower = description.toLowerCase();
  const count = hints.filter(
    (h) => typeof h === 'string' && lower.includes((h as string).toLowerCase()),
  ).length;
  return count >= minHints;
}

/**
 * Async gate content check: uses AI when openAiApiKey is set; falls back to substring match on failure.
 */
export async function decisionSatisfiesGateContentAsync(
  description: string,
  condition: GateCondition,
  openAiApiKey: string | undefined,
): Promise<boolean> {
  const hints = condition.content_hints;
  const minHints = condition.min_hints ?? 0;
  if (!Array.isArray(hints) || hints.length === 0 || minHints <= 0) {
    return true;
  }
  if (openAiApiKey) {
    const result = await evaluateGateContentSatisfaction(
      {
        decisionDescription: description,
        contentHints: hints.filter((h): h is string => typeof h === 'string'),
        minHints,
        gateDescription: undefined,
      },
      openAiApiKey,
    );
    if (result !== null) return result.satisfies;
  }
  return decisionSatisfiesGateContent(description, condition);
}

/**
 * Returns gates for this session that are not_met (status = 'not_met').
 * Used by decision execution and pathway service to apply anti-gaming logic.
 */
export async function getNotMetGatesForSession(sessionId: string): Promise<NotMetGate[]> {
  const sessionScenarioId = await getSessionScenarioId(sessionId);
  if (!sessionScenarioId) return [];

  const { data: progressRows, error: progressError } = await supabaseAdmin
    .from('session_gate_progress')
    .select('gate_id')
    .eq('session_id', sessionId)
    .eq('status', 'not_met');

  if (progressError || !progressRows?.length) {
    return [];
  }

  const gateIds = progressRows.map((r: { gate_id: string }) => r.gate_id);

  const { data: gates, error: gatesError } = await supabaseAdmin
    .from('scenario_gates')
    .select(
      'id, gate_id, condition, objective_id, if_vague_decision_inject_id, if_medium_band_inject_id',
    )
    .eq('scenario_id', sessionScenarioId)
    .in('gate_id', gateIds);

  if (gatesError || !gates?.length) {
    return [];
  }

  return (gates as NotMetGate[]).map((g) => ({
    gate_id: g.gate_id,
    id: g.id,
    condition: (g.condition as GateCondition) ?? {},
    objective_id: g.objective_id ?? null,
    if_vague_decision_inject_id: g.if_vague_decision_inject_id ?? null,
    if_medium_band_inject_id: g.if_medium_band_inject_id ?? null,
  }));
}

async function getSessionScenarioId(sessionId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id')
    .eq('id', sessionId)
    .single();
  if (error || !data) return null;
  return (data as { scenario_id: string }).scenario_id;
}

/**
 * Initialize session_gate_progress for all gates of the session's scenario.
 * Call when session transitions to in_progress so gate evaluation and inject filtering work.
 * Inserts one row per scenario gate with status 'pending'; safe to re-run (conflict ignored).
 */
export async function initializeSessionGateProgress(sessionId: string): Promise<void> {
  const scenarioId = await getSessionScenarioId(sessionId);
  if (!scenarioId) return;

  const { data: gates, error: gatesError } = await supabaseAdmin
    .from('scenario_gates')
    .select('gate_id')
    .eq('scenario_id', scenarioId);

  if (gatesError || !gates?.length) {
    if (gatesError)
      logger.warn({ error: gatesError, sessionId }, 'No scenario gates or error loading gates');
    return;
  }

  const rows = (gates as Array<{ gate_id: string }>).map((g) => ({
    session_id: sessionId,
    gate_id: g.gate_id,
    status: 'pending',
  }));

  const { error: insertError } = await supabaseAdmin
    .from('session_gate_progress')
    .upsert(rows, { onConflict: 'session_id,gate_id', ignoreDuplicates: true });

  if (insertError) {
    logger.error({ error: insertError, sessionId }, 'Failed to initialize session gate progress');
    return;
  }
  logger.info({ sessionId, gateCount: rows.length }, 'Session gate progress initialized');
}

/**
 * Check if the decision is "vague" for any of the not_met gates in scope
 * (author's team matches gate.team and decision.type in gate.decision_types, and content check fails).
 * Returns vague: true and the list of gate_ids for which the decision was vague (for firing if_vague_decision_inject_id).
 */
export function isDecisionVagueForNotMetGate(
  decision: { description: string; type: string },
  authorTeamNames: string[],
  notMetGates: NotMetGate[],
): { vague: boolean; gateIds: string[] } {
  const gateIds: string[] = [];
  for (const gate of notMetGates) {
    const cond = gate.condition;
    const team = cond.team;
    const types = cond.decision_types;
    if (typeof team !== 'string' || !authorTeamNames.includes(team)) continue;
    if (Array.isArray(types) && types.length > 0 && !types.includes(decision.type)) continue;
    if (decisionSatisfiesGateContent(decision.description, cond)) continue;
    gateIds.push(gate.gate_id);
  }
  return { vague: gateIds.length > 0, gateIds };
}

/**
 * Async version: uses AI for gate content satisfaction when openAiApiKey is set; falls back to substring match.
 * When openAiApiKey is set, builds gateContentReason from AI results for persistence on decisions.evaluation_reasoning.
 */
export async function isDecisionVagueForNotMetGateAsync(
  decision: { description: string; type: string },
  authorTeamNames: string[],
  notMetGates: NotMetGate[],
  openAiApiKey: string | undefined,
): Promise<{ vague: boolean; gateIds: string[]; gateContentReason?: string }> {
  const gateIds: string[] = [];
  const reasonParts: string[] = [];
  for (const gate of notMetGates) {
    const cond = gate.condition;
    const team = cond.team;
    const types = cond.decision_types;
    if (typeof team !== 'string' || !authorTeamNames.includes(team)) continue;
    if (Array.isArray(types) && types.length > 0 && !types.includes(decision.type)) continue;
    const hints = cond.content_hints;
    const minHints = cond.min_hints ?? 0;
    let satisfies: boolean;
    if (openAiApiKey && Array.isArray(hints) && hints.length > 0 && minHints > 0) {
      const result = await evaluateGateContentSatisfaction(
        {
          decisionDescription: decision.description,
          contentHints: hints.filter((h): h is string => typeof h === 'string'),
          minHints,
          gateDescription: undefined,
        },
        openAiApiKey,
      );
      if (result !== null) {
        satisfies = result.satisfies;
        const short = (result.reason ?? (satisfies ? 'satisfied' : 'vague')).slice(0, 120);
        reasonParts.push(`${gate.gate_id}: ${satisfies ? 'satisfied' : 'vague'} (${short})`);
      } else {
        satisfies = decisionSatisfiesGateContent(decision.description, cond);
      }
    } else {
      satisfies = decisionSatisfiesGateContent(decision.description, cond);
    }
    if (satisfies) continue;
    gateIds.push(gate.gate_id);
  }
  const gateContentReason = reasonParts.length > 0 ? reasonParts.join('. ') : undefined;
  return { vague: gateIds.length > 0, gateIds, gateContentReason };
}

/**
 * Resolve objective_id for a not_met gate: use gate.objective_id or infer from condition.team.
 * Returns lowercase to match objective tracking (evacuation, media, triage, coordination).
 */
export function objectiveIdForGate(gate: NotMetGate): string | null {
  const raw =
    gate.objective_id ?? (typeof gate.condition.team === 'string' ? gate.condition.team : null);
  return raw ? raw.toLowerCase() : null;
}

/**
 * Filter not_met gates to those "in scope" for this decision: the decision's incident's inject
 * must target the gate's team (inject.target_teams contains gate.condition.team).
 */
export async function getNotMetGatesInScopeForDecision(
  responseToIncidentId: string,
  notMetGates: NotMetGate[],
): Promise<NotMetGate[]> {
  const { data: incident } = await supabaseAdmin
    .from('incidents')
    .select('inject_id')
    .eq('id', responseToIncidentId)
    .single();
  const injectId = (incident as { inject_id?: string | null } | null)?.inject_id;
  if (!injectId) return [];

  const { data: inject } = await supabaseAdmin
    .from('scenario_injects')
    .select('target_teams')
    .eq('id', injectId)
    .single();
  const targetTeams = (inject as { target_teams?: string[] | null } | null)?.target_teams ?? [];

  return notMetGates.filter((gate) => {
    const team = gate.condition.team;
    return typeof team === 'string' && Array.isArray(targetTeams) && targetTeams.includes(team);
  });
}

/**
 * Evaluate a single gate for a session at a given elapsed time.
 * If gate is still pending and check_at_minutes <= elapsedMinutes, evaluate condition and set met/not_met.
 * Uses AI content analysis (content_hints) as primary classifier; decision_types is optional.
 * First decision that passes the content check satisfies the gate.
 */
export async function evaluateGate(
  sessionId: string,
  gate: {
    id: string;
    gate_id: string;
    scenario_id: string;
    check_at_minutes: number;
    condition: GateCondition;
    if_not_met_inject_ids: string[] | null;
    if_met_inject_id: string | null;
  },
  elapsedMinutes: number,
  io: import('socket.io').Server | null,
  openAiApiKey?: string,
): Promise<void> {
  if (gate.check_at_minutes > elapsedMinutes) return;

  const { data: progress } = await supabaseAdmin
    .from('session_gate_progress')
    .select('status')
    .eq('session_id', sessionId)
    .eq('gate_id', gate.gate_id)
    .single();

  if (progress?.status !== 'pending') return;

  const team = gate.condition.team;
  if (typeof team !== 'string') {
    await setGateNotMet(sessionId, gate.gate_id);
    await fireInjects(sessionId, gate.if_not_met_inject_ids, io);
    return;
  }

  const { data: teamUserIds } = await supabaseAdmin
    .from('session_teams')
    .select('user_id')
    .eq('session_id', sessionId)
    .eq('team_name', team);

  const userIds = (teamUserIds ?? []).map((r: { user_id: string }) => r.user_id);
  if (userIds.length === 0) {
    await setGateNotMet(sessionId, gate.gate_id);
    await fireInjects(sessionId, gate.if_not_met_inject_ids, io);
    return;
  }

  // decision_types is optional: when empty, all team decisions are candidates
  const decisionTypes = (gate.condition.decision_types ?? []) as string[];
  const { data: decisions } = await supabaseAdmin
    .from('decisions')
    .select('id, description, type, response_to_incident_id, executed_at')
    .eq('session_id', sessionId)
    .eq('status', 'executed')
    .in('proposed_by', userIds)
    .not('response_to_incident_id', 'is', null)
    .order('executed_at', { ascending: false });

  const candidates = (decisions ?? []).filter(
    (d: { type?: string }) =>
      !decisionTypes.length || decisionTypes.includes((d as { type?: string }).type ?? ''),
  );

  // Build in-scope candidates: decisions whose incident's inject targets this team
  let inScopeCandidates: Array<{ id: string; description: string }> = [];
  if (candidates.length > 0) {
    const incidentIds = [
      ...new Set(
        (candidates as Array<{ response_to_incident_id?: string | null }>)
          .map((d) => d.response_to_incident_id)
          .filter(Boolean) as string[],
      ),
    ];
    const { data: incidents } = await supabaseAdmin
      .from('incidents')
      .select('id, inject_id')
      .in('id', incidentIds);
    const injectIds = [
      ...new Set(
        (incidents ?? [])
          .map((i: { inject_id?: string | null }) => i.inject_id)
          .filter(Boolean) as string[],
      ),
    ];
    if (injectIds.length > 0) {
      const { data: injects } = await supabaseAdmin
        .from('scenario_injects')
        .select('id, target_teams')
        .eq('scenario_id', gate.scenario_id)
        .in('id', injectIds);
      const targetTeamInjectIds = new Set<string>();
      for (const inj of injects ?? []) {
        const targetTeams = (inj as { target_teams?: string[] | null }).target_teams;
        if (Array.isArray(targetTeams) && targetTeams.includes(team)) {
          targetTeamInjectIds.add((inj as { id: string }).id);
        }
      }
      const incidentIdToInjectId = new Map(
        (incidents ?? []).map((i: { id: string; inject_id?: string | null }) => [
          i.id,
          i.inject_id,
        ]),
      );
      inScopeCandidates = (
        candidates as Array<{
          id: string;
          description: string;
          response_to_incident_id?: string | null;
        }>
      )
        .filter((d) => {
          const injId = d.response_to_incident_id
            ? incidentIdToInjectId.get(d.response_to_incident_id)
            : null;
          return injId && targetTeamInjectIds.has(injId);
        })
        .map((d) => ({ id: d.id, description: d.description }));
    }
  }

  // Content check: first decision that passes satisfies the gate (AI when key set, else substring fallback)
  const apiKey = openAiApiKey ?? env.openAiApiKey;
  let satisfying: { id: string } | undefined;
  for (const candidate of inScopeCandidates) {
    const passes = await decisionSatisfiesGateContentAsync(
      candidate.description,
      gate.condition,
      apiKey,
    );
    if (passes) {
      satisfying = { id: candidate.id };
      break;
    }
  }

  if (satisfying) {
    await setGateMet(sessionId, gate.gate_id, satisfying.id);
    if (gate.if_met_inject_id) {
      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('trainer_id')
        .eq('id', sessionId)
        .single();
      if (session?.trainer_id && io) {
        const { publishInjectToSession } = await import('../routes/injects.js');
        await publishInjectToSession(
          gate.if_met_inject_id,
          sessionId,
          (session as { trainer_id: string }).trainer_id,
          io,
        );
      }
    }
  } else {
    await setGateNotMet(sessionId, gate.gate_id);
    await fireInjects(sessionId, gate.if_not_met_inject_ids, io);
  }
}

async function setGateMet(
  sessionId: string,
  gateId: string,
  satisfyingDecisionId: string,
): Promise<void> {
  await supabaseAdmin
    .from('session_gate_progress')
    .update({
      status: 'met',
      met_at: new Date().toISOString(),
      satisfying_decision_id: satisfyingDecisionId,
      updated_at: new Date().toISOString(),
    })
    .eq('session_id', sessionId)
    .eq('gate_id', gateId);
  logger.info({ sessionId, gateId }, 'Gate met');
}

async function setGateNotMet(sessionId: string, gateId: string): Promise<void> {
  await supabaseAdmin
    .from('session_gate_progress')
    .update({
      status: 'not_met',
      updated_at: new Date().toISOString(),
    })
    .eq('session_id', sessionId)
    .eq('gate_id', gateId);
  logger.info({ sessionId, gateId }, 'Gate not_met');
}

async function fireInjects(
  sessionId: string,
  injectIds: string[] | null | undefined,
  io: import('socket.io').Server | null,
): Promise<void> {
  if (!io || !Array.isArray(injectIds) || injectIds.length === 0) return;
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('trainer_id')
    .eq('id', sessionId)
    .single();
  const trainerId = (session as { trainer_id: string } | null)?.trainer_id;
  if (!trainerId) return;
  const { publishInjectToSession } = await import('../routes/injects.js');
  for (const injectId of injectIds) {
    try {
      await publishInjectToSession(injectId, sessionId, trainerId, io);
    } catch (err) {
      logger.error({ err, sessionId, injectId }, 'Failed to publish punishment inject');
    }
  }
}

/**
 * Run gate evaluation for all due gates (check_at_minutes <= elapsedMinutes) that are still pending.
 */
export async function runGateEvaluationForSession(
  sessionId: string,
  elapsedMinutes: number,
  io: import('socket.io').Server | null,
): Promise<void> {
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id')
    .eq('id', sessionId)
    .single();
  if (!session?.scenario_id) return;

  const { data: gates } = await supabaseAdmin
    .from('scenario_gates')
    .select(
      'id, gate_id, scenario_id, check_at_minutes, condition, if_not_met_inject_ids, if_met_inject_id',
    )
    .eq('scenario_id', session.scenario_id)
    .lte('check_at_minutes', elapsedMinutes);

  if (!gates?.length) return;

  const { data: progressList } = await supabaseAdmin
    .from('session_gate_progress')
    .select('gate_id')
    .eq('session_id', sessionId)
    .eq('status', 'pending');

  const pendingGateIds = new Set((progressList ?? []).map((p: { gate_id: string }) => p.gate_id));

  for (const gate of gates as Array<{
    id: string;
    gate_id: string;
    scenario_id: string;
    check_at_minutes: number;
    condition: GateCondition;
    if_not_met_inject_ids: string[] | null;
    if_met_inject_id: string | null;
  }>) {
    if (pendingGateIds.has(gate.gate_id)) {
      await evaluateGate(sessionId, gate, elapsedMinutes, io, env.openAiApiKey);
    }
  }
}
