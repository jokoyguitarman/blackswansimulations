import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { activeTeams, activeTemplateInjects } from '../../lib/templateRows.js';
import { seedOrgPages } from '../ambientContentService.js';
import { consumeCredit, isAdmin, refundCredit, type ConsumeResult } from '../creditService.js';
import { usablePeaceFeed } from '../generation/peaceFeedCore.js';
import { blankGenerated, type SetupEditStageOutput } from './deltaBuildTypes.js';
import { loadSetupEditSource } from './deltaBuildContext.js';
import { asSnapshot } from './prepareSetupEditBuild.js';
import { planRemap, type OrphanResolution, type PlannerInject, type PlannerTeam } from './remapPlanner.js';
import { isSetupEditSchemaMissing, remainingEdits } from './setupEditCore.js';
import { computeDelta } from './setupDeltaCore.js';
import {
  mergeSetupEdit,
  MultiOrgValidationError,
  SetupMergeError,
  type ApplyBundle,
  type ApplySummary,
  type MergeCurrent,
  type MergeInjectRow,
  type MergeObjective,
  type MergeScenario,
  type MergeSetupEditInput,
  type MergeTeamRow,
} from './setupMergeCore.js';
import { snapshotFromDraftInput } from './setupSnapshotCore.js';

/** An apply that has not finished returns to open after this long. */
export const APPLY_HEARTBEAT_MS = 10 * 60 * 1000;

const TEAM_COLUMNS =
  'id, team_uid, team_name, team_description, required_roles, min_participants, max_participants, counter_definitions, is_investigative, charter, expected_actions, scoring_rubric, org_key, function_key';

const INJECT_COLUMNS =
  'id, trigger_time_minutes, trigger_condition, type, title, content, affected_roles, severity, requires_response, ai_generated, inject_scope, target_teams, requires_coordination, triggered_by_user_id, required_gate_id, required_gate_not_met_id, conditions_to_appear, conditions_to_cancel, eligible_after_minutes, objective_penalty, state_effect, generation_source, delivery_config, response_type';

export function applyingIsStale(heartbeat: string | null | undefined, now: Date): boolean {
  if (!heartbeat) return true;
  const at = Date.parse(heartbeat);
  if (Number.isNaN(at)) return true;
  return now.getTime() - at >= APPLY_HEARTBEAT_MS;
}

export interface ApplySetupEditRequest {
  scenarioId: string;
  editId: string;
  user: { id: string; role?: string };
  buildId: string;
  orphanDecisions: Readonly<Record<string, OrphanResolution>>;
}

export interface ScheduledSessionResult {
  id: string;
  title: string;
  unassigned_players: Array<{ user_id: string; team_name: string }>;
  new_teams: string[];
}

export type ApplySetupEditResult =
  | {
      ok: true;
      summary: ApplySummary;
      remaining: number | null;
      scheduled_sessions: ScheduledSessionResult[];
    }
  | { ok: false; status: number; code: string; error: string };

export interface PreparedApply {
  ok: true;
  input: MergeSetupEditInput;
  sessions: Array<{
    id: string;
    reseed: boolean;
    unassigned_players: Array<{ user_id: string; team_name: string }>;
  }>;
  title: string;
}

export interface ApplyDeps {
  prepare(request: ApplySetupEditRequest): Promise<PreparedApply | ApplySetupEditResult>;
  claim(request: ApplySetupEditRequest, now: Date): Promise<'claimed' | 'busy' | 'unavailable'>;
  heartbeat(editId: string, now: Date): Promise<void>;
  release(editId: string, error: string | null): Promise<void>;
  md5(scenarioId: string): Promise<string | null>;
  rpc(args: {
    editId: string;
    md5: string;
    bundle: ApplyBundle;
    isAdmin: boolean;
    limit: number;
  }): Promise<{ result: string | null; error: { code?: string; message?: string } | null }>;
  reseed(sessionId: string, initialState: Record<string, unknown>): Promise<void>;
  used(scenarioId: string): Promise<number>;
  limit(): number;
  chargesCredit(): boolean;
  consume(userId: string, scenarioId: string): Promise<ConsumeResult>;
  refund(userId: string, scenarioId: string, fundingInvoiceId: string | null): Promise<void>;
  now(): Date;
}

export async function applySetupEdit(
  request: ApplySetupEditRequest,
  deps: ApplyDeps,
): Promise<ApplySetupEditResult> {
  let claimed = false;
  let charged: ConsumeResult | null = null;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prepared = await deps.prepare(request);
      if (!prepared.ok || !('input' in prepared)) {
        if (!prepared.ok) {
          await abort();
          return prepared;
        }
        throw new Error('Apply prepare returned no scenario');
      }
      let bundle: ApplyBundle;
      try {
        bundle = mergeSetupEdit(prepared.input);
      } catch (err) {
        await abort();
        const mapped = mergeFailure(err);
        if (mapped) return mapped;
        throw err;
      }
      if (!claimed) {
        const claim = await deps.claim(request, deps.now());
        if (claim === 'unavailable') {
          return {
            ok: false,
            status: 404,
            code: 'SETUP_EDITS_UNAVAILABLE',
            error: 'Setup edits are not available until the apply migration is applied.',
          };
        }
        if (claim !== 'claimed') {
          return {
            ok: false,
            status: 409,
            code: 'SETUP_EDIT_BUSY',
            error: 'This setup edit is already being applied.',
          };
        }
        claimed = true;
        if (deps.chargesCredit() && !isAdmin(request.user)) {
          const consumed = await deps.consume(request.user.id, request.scenarioId);
          if (!consumed.ok) {
            await deps.release(request.editId, 'credit');
            return {
              ok: false,
              status: 402,
              code: 'SETUP_EDIT_CREDIT',
              error: 'A scenario credit is required to apply this edit.',
            };
          }
          charged = consumed;
        }
      } else {
        await deps.heartbeat(request.editId, deps.now());
      }

      const md5 = await deps.md5(request.scenarioId);
      if (!md5) {
        await abort();
        return { ok: false, status: 404, code: 'NOT_FOUND', error: 'Scenario not found' };
      }
      const rpc = await deps.rpc({
        editId: request.editId,
        md5,
        bundle,
        isAdmin: isAdmin(request.user),
        limit: deps.limit(),
      });
      const outcome = outcomeOf(rpc.result, rpc.error);
      if (outcome === 'unavailable') {
        await abort();
        return {
          ok: false,
          status: 404,
          code: 'SETUP_EDITS_UNAVAILABLE',
          error: 'Setup edits are not available until the apply migration is applied.',
        };
      }
      if (outcome === 'applied') {
        await reseedSessions(deps, prepared, bundle);
        const used = await deps.used(request.scenarioId);
        return {
          ok: true,
          summary: bundle.summary,
          remaining: remainingEdits(used, deps.limit(), isAdmin(request.user)),
          scheduled_sessions: prepared.sessions.map((session) => ({
            id: session.id,
            title: prepared.title,
            unassigned_players: session.unassigned_players,
            new_teams: bundle.new_team_names,
          })),
        };
      }
      if (outcome === 'stale' && attempt === 0) continue;
      await abort();
      return outcomeResult(outcome);
    }
    return outcomeResult('stale');
  } catch (err) {
    await abort();
    throw err;
  }

  async function abort(): Promise<void> {
    const wasClaimed = claimed;
    const wasCharged = charged;
    claimed = false;
    charged = null;
    await unwind(deps, request, wasClaimed, wasCharged);
  }
}

async function unwind(
  deps: ApplyDeps,
  request: ApplySetupEditRequest,
  claimed: boolean,
  charged: ConsumeResult | null,
): Promise<void> {
  if (claimed) {
    await deps.release(request.editId, null).catch((err) => {
      logger.error({ err, editId: request.editId }, 'Failed to release a setup edit apply');
    });
  }
  if (charged?.ok) {
    await deps.refund(request.user.id, request.scenarioId, charged.fundingInvoiceId ?? null).catch((err) => {
      logger.error({ err, editId: request.editId }, 'Failed to refund a setup edit credit');
    });
  }
}

async function reseedSessions(deps: ApplyDeps, prepared: PreparedApply, bundle: ApplyBundle): Promise<void> {
  const state = bundle.scenario.initial_state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return;
  for (const session of prepared.sessions) {
    if (!session.reseed) continue;
    try {
      await deps.reseed(session.id, state as Record<string, unknown>);
    } catch (err) {
      logger.error({ err, sessionId: session.id }, 'Setup edit applied but org pages were not re-seeded');
    }
  }
}

function mergeFailure(err: unknown): ApplySetupEditResult | null {
  if (err instanceof SetupMergeError) {
    return { ok: false, status: 400, code: err.code, error: err.message };
  }
  if (err instanceof MultiOrgValidationError) {
    return { ok: false, status: 400, code: err.code, error: err.message };
  }
  return null;
}

function outcomeOf(
  result: string | null,
  error: { code?: string; message?: string } | null,
): string {
  if (error) {
    if (isSetupEditSchemaMissing(error)) return 'unavailable';
    if (/live_session/.test(error.message ?? '')) return 'live_session';
    throw new Error(error.message || 'Apply setup edit failed');
  }
  return result ?? '';
}

function outcomeResult(outcome: string): ApplySetupEditResult {
  if (outcome === 'stale') {
    return {
      ok: false,
      status: 409,
      code: 'SETUP_EDIT_STALE',
      error: 'The scenario changed while this edit was applying. Review it and apply again.',
    };
  }
  if (outcome === 'live_session') {
    return {
      ok: false,
      status: 423,
      code: 'SCENARIO_LOCKED',
      error: 'A session on this scenario is currently live. Editing resumes when it ends.',
    };
  }
  if (outcome === 'limit_reached') {
    return {
      ok: false,
      status: 403,
      code: 'SETUP_EDIT_LIMIT',
      error: 'All setup edits for this scenario have been used.',
    };
  }
  if (outcome === 'not_applying') {
    return {
      ok: false,
      status: 409,
      code: 'SETUP_EDIT_NOT_OPEN',
      error: 'Only an open setup edit can be applied.',
    };
  }
  if (outcome === 'not_found') {
    return { ok: false, status: 404, code: 'NOT_FOUND', error: 'Setup edit not found' };
  }
  return { ok: false, status: 500, code: 'APPLY_FAILED', error: 'The setup edit could not be applied.' };
}

/** Turn the four stage rows into the outputs the merge reads. Placeholders are not copied onto the scenario. */
export function stageOutputsFromRows(
  rows: ReadonlyArray<{ stage: string; output: unknown }>,
): SetupEditStageOutput[] {
  const byStage = new Map(rows.map((row) => [row.stage, row.output]));
  return ['characters', 'storyline', 'convergence', 'pages'].map((stage) =>
    normaliseStage(byStage.get(stage), stage),
  );
}

function normaliseStage(raw: unknown, stage: string): SetupEditStageOutput {
  const row = asRecord(raw) ?? {};
  const generated = asRecord(row.generated);
  const narrative = asRecord(row.narrative_update);
  const fact = asRecord(row.fact_sheet);
  return {
    revisions: Array.isArray(row.revisions) ? (row.revisions as SetupEditStageOutput['revisions']) : [],
    flags: Array.isArray(row.flags) ? (row.flags as SetupEditStageOutput['flags']) : [],
    generated: generated
      ? { ...blankGenerated(), ...(generated as object) }
      : blankGenerated(),
    text_updates: Array.isArray(row.text_updates)
      ? (row.text_updates as SetupEditStageOutput['text_updates'])
      : [],
    narrative_update:
      narrative && typeof narrative.briefing === 'string'
        ? {
            title: text(narrative.title),
            description: text(narrative.description),
            briefing: narrative.briefing,
            briefing_kept: narrative.briefing_kept === true,
          }
        : null,
    objective_updates: Array.isArray(row.objective_updates)
      ? (row.objective_updates as SetupEditStageOutput['objective_updates'])
      : [],
    setup_source_update: (asRecord(row.setup_source_update) as SetupEditStageOutput['setup_source_update']) ?? null,
    stakeholder_updates: Array.isArray(row.stakeholder_updates)
      ? (row.stakeholder_updates as SetupEditStageOutput['stakeholder_updates'])
      : [],
    brief_diff: null,
    swap_premise: typeof row.swap_premise === 'string' ? row.swap_premise : null,
    skipped: row.skipped === true,
    personas: Array.isArray(row.personas) ? (row.personas as SetupEditStageOutput['personas']) : [],
    fact_sheet:
      fact && Array.isArray(fact.confirmed_facts)
        ? (fact as unknown as SetupEditStageOutput['fact_sheet'])
        : { confirmed_facts: [], unconfirmed_claims: [] },
    communities: [],
    countries: [],
    injects: [],
    team_storylines: {},
    team_charters: [],
    stakeholders: [],
    stakeholder_injects: [],
    persona_twins: [],
    orgs: [],
    sop_steps: [],
    decision_context: { leakiness: 0, labour_signal: false, product_safety_signal: false },
    pressure_organisations: [],
    sharedInjects: [],
    convergenceGates: [],
    narrative: null,
    objectives: [],
    dimensionLabels: null,
    org_page: null,
    pressure_injects: [],
    ...(stage === 'pages' ? { peace_period: usablePeaceFeed(row.peace_period) } : {}),
  };
}

export function createApplyDeps(): ApplyDeps {
  return {
    prepare: prepareApply,
    claim: claimApply,
    heartbeat: touchHeartbeat,
    release: releaseApply,
    md5: readStateMd5,
    rpc: callApplyRpc,
    reseed: (sessionId, initialState) => seedOrgPages(sessionId, initialState),
    used: readUsed,
    limit: () => env.scenarioSetupEditLimit,
    chargesCredit: () => env.scenarioSetupEditChargesCredit,
    consume: (userId, scenarioId) =>
      consumeCredit(userId, 'scenario', 'scenario_setup_edit', { scenarioId }),
    refund: (userId, scenarioId, fundingInvoiceId) =>
      refundCredit(userId, 'scenario', fundingInvoiceId, { scenarioId }),
    now: () => new Date(),
  };
}

async function prepareApply(
  request: ApplySetupEditRequest,
): Promise<PreparedApply | ApplySetupEditResult> {
  const loaded = await loadSetupEditSource(request.editId);
  if (!loaded.available) {
    return {
      ok: false,
      status: 404,
      code: 'SETUP_EDITS_UNAVAILABLE',
      error: 'Setup edits are not available.',
    };
  }
  const source = loaded.source;
  if (!source || source.edit.scenario_id !== request.scenarioId) {
    return { ok: false, status: 404, code: 'NOT_FOUND', error: 'Setup edit not found' };
  }
  if (source.edit.status !== 'open' && source.edit.status !== 'applying') {
    return {
      ok: false,
      status: 409,
      code: 'SETUP_EDIT_NOT_OPEN',
      error: 'Only an open setup edit can be applied.',
    };
  }
  const baseline = asSnapshot(source.edit.baseline);
  if (!baseline) {
    return {
      ok: false,
      status: 409,
      code: 'SETUP_EDIT_NOT_READY',
      error: 'This edit has no baseline yet.',
    };
  }
  const build = await loadBuild(request.buildId);
  if (!build) return { ok: false, status: 404, code: 'NOT_FOUND', error: 'Build not found' };
  if (build.unavailable) {
    return {
      ok: false,
      status: 404,
      code: 'SETUP_EDITS_UNAVAILABLE',
      error: 'Setup edits are not available.',
    };
  }
  const belongs =
    build.row.status === 'succeeded' &&
    build.row.scenario_id === request.scenarioId &&
    build.request.setup_edit_id === request.editId;
  if (!belongs) {
    return {
      ok: false,
      status: 409,
      code: 'SETUP_EDIT_BUILD',
      error: 'Apply needs a succeeded build for this edit.',
    };
  }
  const edited = snapshotFromDraftInput(source.draft_input, baseline);
  const delta = computeDelta(baseline, edited);
  if (delta.empty) {
    return {
      ok: false,
      status: 400,
      code: 'SETUP_EDIT_EMPTY',
      error: 'This edit does not change the setup.',
    };
  }
  const plan = planRemap({
    delta,
    edited,
    initial_state: source.remap.initial_state,
    teams: source.remap.teams,
    injects: source.remap.injects,
    sessions: source.remap.sessions,
    resolutions: request.orphanDecisions,
  });
  const rows = await loadScenarioRows(request.scenarioId, source.remap.teams, source.remap.injects);
  const outputs = await loadOutputs(request.buildId);
  const input: MergeSetupEditInput = {
    current: rows,
    plan,
    buildOutputs: outputs,
    edit: { id: request.editId, baseline, edited },
    resolutions: request.orphanDecisions,
  };
  return {
    ok: true,
    input,
    title: rows.scenario.title,
    sessions: plan.scheduled_sessions.map((session) => ({
      id: session.session_id,
      reseed: session.reseed_org_pages,
      unassigned_players: session.unassigned_players,
    })),
  };
}

async function loadBuild(
  buildId: string,
): Promise<{ unavailable: true } | null | { unavailable: false; row: { status: string; scenario_id: string | null; request: unknown }; request: { setup_edit_id?: string } }> {
  const result = await supabaseAdmin
    .from('warroom_builds')
    .select('id, status, scenario_id, request')
    .eq('id', buildId)
    .maybeSingle<{ status: string; scenario_id: string | null; request: unknown }>();
  if (result.error) {
    if (isSetupEditSchemaMissing(result.error)) return { unavailable: true };
    throw new Error(result.error.message);
  }
  if (!result.data) return null;
  const request = asRecord(result.data.request) ?? {};
  return {
    unavailable: false,
    row: result.data,
    request: { setup_edit_id: typeof request.setup_edit_id === 'string' ? request.setup_edit_id : undefined },
  };
}

async function loadOutputs(buildId: string): Promise<SetupEditStageOutput[]> {
  const result = await supabaseAdmin
    .from('warroom_build_outputs')
    .select('stage, output')
    .eq('build_id', buildId);
  if (result.error) {
    if (isSetupEditSchemaMissing(result.error)) return stageOutputsFromRows([]);
    throw new Error(result.error.message);
  }
  return stageOutputsFromRows((result.data ?? []) as Array<{ stage: string; output: unknown }>);
}

async function loadScenarioRows(
  scenarioId: string,
  plannerTeams: readonly PlannerTeam[],
  plannerInjects: readonly PlannerInject[],
): Promise<MergeCurrent> {
  const scenario = await supabaseAdmin
    .from('scenarios')
    .select('title, description, briefing, category, difficulty, duration_minutes, initial_state')
    .eq('id', scenarioId)
    .maybeSingle<{
      title: string | null;
      description: string | null;
      briefing: string | null;
      category: string | null;
      difficulty: string | null;
      duration_minutes: number | null;
      initial_state: unknown;
    }>();
  if (scenario.error || !scenario.data) throw new Error(scenario.error?.message || 'Scenario not found');
  const history = new Map(plannerInjects.map((row) => [row.id, row.has_history]));
  const teams = await readTeams(scenarioId, plannerTeams);
  const injects = await readInjects(scenarioId, history);
  const objectives = await readObjectives(scenarioId);
  const row = scenario.data;
  const current: MergeScenario = {
    title: row.title ?? '',
    description: row.description ?? '',
    briefing: row.briefing ?? '',
    category: row.category ?? 'social_media_crisis',
    difficulty: row.difficulty ?? 'intermediate',
    duration_minutes: row.duration_minutes ?? 60,
    initial_state: row.initial_state ?? {},
    objectives,
  };
  return { scenario: current, teams, injects };
}

async function readTeams(scenarioId: string, fallback: readonly PlannerTeam[]): Promise<MergeTeamRow[]> {
  const result = await activeTeams(
    supabaseAdmin.from('scenario_teams').select(TEAM_COLUMNS).eq('scenario_id', scenarioId),
  );
  if (result.error) {
    if (isSetupEditSchemaMissing(result.error)) return fallback.map(teamFromPlanner);
    throw new Error(result.error.message);
  }
  return ((result.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: text(row.id),
    team_uid: text(row.team_uid) || text(row.id),
    team_name: text(row.team_name),
    team_description: textOrNull(row.team_description),
    required_roles: stringList(row.required_roles),
    min_participants: numberOrNull(row.min_participants),
    max_participants: numberOrNull(row.max_participants),
    counter_definitions: row.counter_definitions ?? null,
    is_investigative: row.is_investigative === true,
    charter: row.charter ?? null,
    expected_actions: row.expected_actions ?? null,
    scoring_rubric: typeof row.scoring_rubric === 'string' ? row.scoring_rubric : null,
    org_key: textOrNull(row.org_key),
    function_key: textOrNull(row.function_key),
  }));
}

function teamFromPlanner(row: PlannerTeam): MergeTeamRow {
  return {
    id: row.id,
    team_uid: row.team_uid,
    team_name: row.team_name,
    team_description: row.team_description,
    required_roles: [],
    min_participants: 1,
    max_participants: null,
    counter_definitions: null,
    is_investigative: false,
    charter: row.charter,
    expected_actions: row.expected_actions,
    scoring_rubric: typeof row.scoring_rubric === 'string' ? row.scoring_rubric : null,
    org_key: row.org_key,
    function_key: row.function_key,
  };
}

async function readInjects(
  scenarioId: string,
  history: Map<string, boolean>,
): Promise<MergeInjectRow[]> {
  const result = await activeTemplateInjects(
    supabaseAdmin
      .from('scenario_injects')
      .select(INJECT_COLUMNS)
      .eq('scenario_id', scenarioId)
      .is('session_id', null),
  );
  if (result.error) throw new Error(result.error.message);
  return ((result.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: text(row.id),
    has_history: history.get(text(row.id)) === true,
    trigger_time_minutes: numberOrNull(row.trigger_time_minutes),
    trigger_condition: textOrNull(row.trigger_condition),
    type: text(row.type) || 'social_post',
    title: text(row.title),
    content: text(row.content),
    affected_roles: row.affected_roles ?? [],
    severity: text(row.severity) || 'medium',
    requires_response: row.requires_response === true,
    ai_generated: row.ai_generated === true,
    inject_scope: textOrNull(row.inject_scope),
    target_teams: stringList(row.target_teams),
    requires_coordination: row.requires_coordination === true,
    triggered_by_user_id: textOrNull(row.triggered_by_user_id),
    required_gate_id: textOrNull(row.required_gate_id),
    required_gate_not_met_id: textOrNull(row.required_gate_not_met_id),
    conditions_to_appear: row.conditions_to_appear ?? null,
    conditions_to_cancel: row.conditions_to_cancel ?? null,
    eligible_after_minutes: numberOrNull(row.eligible_after_minutes),
    objective_penalty: row.objective_penalty ?? null,
    state_effect: row.state_effect ?? null,
    generation_source: textOrNull(row.generation_source),
    delivery_config: asRecord(row.delivery_config),
    response_type: textOrNull(row.response_type),
  }));
}

async function readObjectives(scenarioId: string): Promise<MergeObjective[]> {
  const result = await supabaseAdmin
    .from('scenario_objectives')
    .select('id, objective_id, objective_name, description, weight, success_criteria, retired_at')
    .eq('scenario_id', scenarioId);
  if (result.error) {
    if (isSetupEditSchemaMissing(result.error)) return [];
    throw new Error(result.error.message);
  }
  return ((result.data ?? []) as Array<Record<string, unknown>>)
    .filter((row) => row.retired_at == null)
    .map((row) => ({
      id: text(row.id),
      objective_id: text(row.objective_id),
      objective_name: text(row.objective_name),
      description: textOrNull(row.description),
      weight: numberOrNull(row.weight),
      success_criteria: row.success_criteria ?? {},
    }));
}

async function claimApply(
  request: ApplySetupEditRequest,
  now: Date,
): Promise<'claimed' | 'busy' | 'unavailable'> {
  const current = await supabaseAdmin
    .from('scenario_setup_edits')
    .select('status, apply_heartbeat_at')
    .eq('id', request.editId)
    .eq('scenario_id', request.scenarioId)
    .maybeSingle<{ status: string; apply_heartbeat_at: string | null }>();
  if (current.error) {
    if (isSetupEditSchemaMissing(current.error)) return 'unavailable';
    throw new Error(current.error.message);
  }
  const row = current.data;
  if (!row) return 'busy';
  const stale = row.status === 'applying' && applyingIsStale(row.apply_heartbeat_at, now);
  if (row.status !== 'open' && !stale) return 'busy';
  let update = supabaseAdmin
    .from('scenario_setup_edits')
    .update({
      status: 'applying',
      apply_heartbeat_at: now.toISOString(),
      build_id: request.buildId,
      error: null,
    })
    .eq('id', request.editId)
    .eq('scenario_id', request.scenarioId)
    .eq('status', row.status);
  if (row.status === 'applying') {
    update = row.apply_heartbeat_at
      ? update.eq('apply_heartbeat_at', row.apply_heartbeat_at)
      : update.is('apply_heartbeat_at', null);
  }
  const written = await update.select('id');
  if (written.error) {
    if (isSetupEditSchemaMissing(written.error)) return 'unavailable';
    throw new Error(written.error.message);
  }
  return Array.isArray(written.data) && written.data.length > 0 ? 'claimed' : 'busy';
}

async function touchHeartbeat(editId: string, now: Date): Promise<void> {
  await supabaseAdmin
    .from('scenario_setup_edits')
    .update({ apply_heartbeat_at: now.toISOString() })
    .eq('id', editId)
    .eq('status', 'applying');
}

async function releaseApply(editId: string, error: string | null): Promise<void> {
  await supabaseAdmin
    .from('scenario_setup_edits')
    .update({ status: 'open', error })
    .eq('id', editId)
    .eq('status', 'applying');
}

async function readStateMd5(scenarioId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.rpc('scenario_initial_state_md5', {
    p_scenario_id: scenarioId,
  });
  if (error) {
    if (isSetupEditSchemaMissing(error)) return null;
    throw new Error(error.message);
  }
  return typeof data === 'string' ? data : null;
}

async function callApplyRpc(args: {
  editId: string;
  md5: string;
  bundle: ApplyBundle;
  isAdmin: boolean;
  limit: number;
}): Promise<{ result: string | null; error: { code?: string; message?: string } | null }> {
  const { data, error } = await supabaseAdmin.rpc('apply_scenario_setup_edit', {
    p_edit_id: args.editId,
    p_expected_state_md5: args.md5,
    p_bundle: args.bundle,
    p_is_admin: args.isAdmin,
    p_limit: args.limit,
  });
  return {
    result: typeof data === 'string' ? data : null,
    error: error ? { code: error.code, message: error.message } : null,
  };
}

async function readUsed(scenarioId: string): Promise<number> {
  const result = await supabaseAdmin
    .from('scenarios')
    .select('setup_edits_used')
    .eq('id', scenarioId)
    .maybeSingle<{ setup_edits_used: number }>();
  if (result.error || !result.data) return 0;
  const used = Number(result.data.setup_edits_used);
  return Number.isFinite(used) ? used : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}
