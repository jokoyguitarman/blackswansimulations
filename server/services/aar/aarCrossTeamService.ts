/**
 * Loads the cross-team AAR section. A missing trigger table, or a session
 * with no trigger rows, falls back to static parent links marked inferred.
 */

import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { teamDependenciesSchema } from '../dependencies/dependencySchema.js';
import type { TeamDependencyEdge } from '../../../shared/teamDependencies.js';
import {
  buildCrossTeamSection,
  inferCrossTeamTriggers,
  type CrossTeamEdgeInput,
  type CrossTeamReplyInput,
  type CrossTeamSection,
  type CrossTeamTriggerInput,
} from '../../../shared/crossTeamAar.js';
import {
  readCrossTeamReplies,
  readDependencyStateRows,
  readInjectTriggers,
  readSessionInjects,
  type StoredStateRow,
  type TriggerHistoryRow,
} from '../crossTeam/crossTeamReads.js';

export function emptyCrossTeamSection(): CrossTeamSection {
  return { provenance: 'inferred', edges: [], chains: [], teams: [] };
}

export async function loadCrossTeamSection(sessionId: string): Promise<CrossTeamSection> {
  try {
    const session = await loadSession(sessionId);
    if (!session) return emptyCrossTeamSection();
    const [triggers, states, injects, replies] = await Promise.all([
      readInjectTriggers(sessionId),
      readDependencyStateRows(sessionId),
      readSessionInjects(session.scenarioId, sessionId, session.validAt),
      readCrossTeamReplies(sessionId),
    ]);
    const titles = new Map(
      injects.catalog.map((brief) => [brief.inject_key, brief.title || brief.inject_key]),
    );
    const recorded = triggers.missing
      ? null
      : triggers.rows.map((row) => triggerInput(row, titles));
    const edgeList = edgeInputs(session.edges, states.missing ? [] : states.rows, triggers.rows);
    const hasTriggers = recorded != null && recorded.length > 0;
    return buildCrossTeamSection({
      triggers: recorded,
      edges: edgeList,
      replies: replies.map(replyInput).filter((reply) => reply.inject_key !== ''),
      inferred: hasTriggers ? [] : inferCrossTeamTriggers(injects.published, edgeList),
      inject_keys: injects.catalog.map((brief) => brief.inject_key),
    });
  } catch (err) {
    logger.warn(
      { err, event: 'aar_cross_team_failed', sessionId },
      'Cross-team cause and effect omitted',
    );
    return emptyCrossTeamSection();
  }
}

async function loadSession(
  sessionId: string,
): Promise<{ scenarioId: string; validAt: string; edges: TeamDependencyEdge[] } | null> {
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id, start_time, created_at')
    .eq('id', sessionId)
    .maybeSingle();
  if (error || !data || typeof data.scenario_id !== 'string') return null;
  const validAt =
    (typeof data.start_time === 'string' && data.start_time) ||
    (typeof data.created_at === 'string' && data.created_at) ||
    new Date().toISOString();
  const scenario = await supabaseAdmin
    .from('scenarios')
    .select('initial_state')
    .eq('id', data.scenario_id)
    .maybeSingle();
  const initial = scenario.data?.initial_state as { team_dependencies?: unknown } | null;
  const parsed = teamDependenciesSchema.safeParse(initial?.team_dependencies);
  return {
    scenarioId: data.scenario_id,
    validAt,
    edges: parsed.success ? parsed.data.edges : [],
  };
}

function triggerInput(
  row: TriggerHistoryRow,
  titles: ReadonlyMap<string, string>,
): CrossTeamTriggerInput {
  return {
    inject_key: row.inject_key,
    title: titles.get(row.inject_key) || row.inject_key,
    minute: row.minute,
    origin: row.origin,
    source_teams: row.source_teams,
    target_teams: row.target_teams,
    dep_id: row.dep_id,
    cause_depth: row.cause_depth,
    parent_inject_keys: row.parent_inject_keys,
  };
}

function edgeInputs(
  edges: readonly TeamDependencyEdge[],
  states: readonly StoredStateRow[],
  triggers: readonly TriggerHistoryRow[],
): CrossTeamEdgeInput[] {
  const byId = new Map(states.map((row) => [row.dep_id, row]));
  return edges.map((edge) => {
    const state = byId.get(edge.id);
    const status = isStatus(state?.status) ? state.status : 'pending';
    const evidence = state?.evidence ?? [];
    const fallback =
      evidence.length > 0
        ? evidence
        : triggers.filter((row) => row.dep_id === edge.id).flatMap((row) => row.key_details);
    return {
      id: edge.id,
      upstream: edge.upstream.team_name,
      downstream: edge.downstream.map((team) => team.team_name),
      deliverable: edge.deliverable,
      due: edge.due,
      consequence_keys: edge.consequence_keys,
      status,
      broken_minute: state?.broken_minute ?? null,
      met_minute: state?.met_minute ?? null,
      recovered_minute: state?.recovered_minute ?? null,
      evidence: fallback.map((item) => ({ detail: item.detail })),
    };
  });
}

function replyInput(row: {
  inject_key: string;
  team_name: string | null;
  response_minute: number;
  judgement: unknown;
}): CrossTeamReplyInput {
  const judgement =
    row.judgement && typeof row.judgement === 'object' && !Array.isArray(row.judgement)
      ? (row.judgement as { tone?: unknown; criteria?: unknown })
      : null;
  const criteria = Array.isArray(judgement?.criteria) ? judgement.criteria : [];
  const met = criteria.filter(
    (item) => !!item && typeof item === 'object' && (item as { met?: unknown }).met === true,
  ).length;
  return {
    inject_key: row.inject_key,
    team: row.team_name ?? '',
    minute: row.response_minute,
    tone: typeof judgement?.tone === 'string' ? judgement.tone : null,
    criteria_met: criteria.length > 0 ? met : null,
    criteria_total: criteria.length > 0 ? criteria.length : null,
  };
}

function isStatus(value: string | undefined): value is CrossTeamEdgeInput['status'] {
  return (
    value === 'pending' ||
    value === 'met' ||
    value === 'broken' ||
    value === 'recovered' ||
    value === 'waived'
  );
}
