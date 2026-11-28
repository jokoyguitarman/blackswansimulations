/**
 * Loads the cross-team AAR section. A missing trigger table, or a session
 * with no trigger rows, falls back to static parent links marked inferred.
 */

import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { collectConditionKeys, parseConditionKey } from '../conditions/conditionCatalog.js';
import { teamDependenciesSchema } from '../dependencies/dependencySchema.js';
import type { TeamDependencyEdge } from '../../../shared/teamDependencies.js';
import {
  buildCrossTeamSection,
  type CrossTeamEdgeInput,
  type CrossTeamReplyInput,
  type CrossTeamSection,
  type CrossTeamTriggerInput,
} from '../../../shared/crossTeamAar.js';
import {
  readCrossTeamReplies,
  readDependencyStateRows,
  readInjectBriefs,
  readInjectTriggers,
  type InjectBriefRow,
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
    const [triggers, states, briefs, replies] = await Promise.all([
      readInjectTriggers(sessionId),
      readDependencyStateRows(sessionId),
      readInjectBriefs(session.scenarioId, sessionId),
      readCrossTeamReplies(sessionId),
    ]);
    const titles = new Map(
      briefs.map((brief) => [brief.inject_key, brief.title || brief.inject_key]),
    );
    const recorded = triggers.missing
      ? null
      : triggers.rows.map((row) => triggerInput(row, titles));
    return buildCrossTeamSection({
      triggers: recorded,
      edges: edgeInputs(session.edges, states.missing ? [] : states.rows, triggers.rows),
      replies: replies.map(replyInput).filter((reply) => reply.inject_key !== ''),
      inferred: recorded && recorded.length > 0 ? [] : inferredFrom(briefs),
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
): Promise<{ scenarioId: string; edges: TeamDependencyEdge[] } | null> {
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id')
    .eq('id', sessionId)
    .maybeSingle();
  if (error || !data || typeof data.scenario_id !== 'string') return null;
  const scenario = await supabaseAdmin
    .from('scenarios')
    .select('initial_state')
    .eq('id', data.scenario_id)
    .maybeSingle();
  const initial = scenario.data?.initial_state as { team_dependencies?: unknown } | null;
  const parsed = teamDependenciesSchema.safeParse(initial?.team_dependencies);
  return {
    scenarioId: data.scenario_id,
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

function inferredFrom(briefs: readonly InjectBriefRow[]): CrossTeamTriggerInput[] {
  const known = new Set(briefs.map((brief) => brief.inject_key));
  return briefs.map((brief) => ({
    inject_key: brief.inject_key,
    title: brief.title || brief.inject_key,
    minute: brief.trigger_time_minutes,
    origin: brief.trigger_time_minutes != null ? 'timed' : 'conditional',
    source_teams: [],
    target_teams: brief.target_teams,
    dep_id: null,
    cause_depth: 0,
    parent_inject_keys: parentsOf(brief, known),
  }));
}

function parentsOf(brief: InjectBriefRow, known: ReadonlySet<string>): string[] {
  const parents = new Set<string>();
  for (const key of collectConditionKeys(brief.conditions_to_appear, brief.conditions_to_cancel)) {
    const parsed = parseConditionKey(key);
    if ('error' in parsed) continue;
    for (const arg of parsed.args) {
      if (known.has(arg) && arg !== brief.inject_key) parents.add(arg);
    }
  }
  return [...parents];
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
