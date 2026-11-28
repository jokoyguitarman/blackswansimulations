import { createHash, randomUUID } from 'node:crypto';
import { injectKeyOf, stampGeneratedInjectKeys } from '../../lib/injectKey.js';
import { usablePeaceFeed } from '../generation/peaceFeedCore.js';
import { sanitizeTeamTargeting } from '../socialCrisisPersistenceService.js';
import {
  MultiOrgValidationError,
  validateScenarioPayload,
} from '../scenarioValidationService.js';
import {
  normalizeOrgPages,
  type ObjectiveDef,
  type SocialCrisisPayload,
  type SocialInject,
} from '../socialCrisisGeneratorService.js';
import type { PersistableTeamCharter } from '../socialCrisisPersistenceService.js';
import { applyRevisionDecision, carryDeliveryConfig } from './briefRevisionCore.js';
import type { SetupRevision } from './briefRevisionCore.js';
import {
  EDIT_TOKEN,
  type InjectFieldPatch,
  type OrphanResolution,
  type RemapPlan,
  type ScheduledSessionPlan,
} from './remapPlanner.js';
import type { SetupEditStageOutput, TextUpdate } from './deltaBuildTypes.js';
import type { SetupSnapshot } from './setupSnapshotCore.js';

/**
 * Pure apply bundle for one setup edit. No database. The SQL function in
 * migration 277 is the only writer. Unresolved orphans and a contract
 * validation failure throw before a bundle exists, so nothing is written.
 */

export class SetupMergeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SetupMergeError';
    this.code = code;
  }
}

export interface MergeTeamRow {
  id: string;
  team_uid: string;
  team_name: string;
  team_description: string | null;
  required_roles: string[] | null;
  min_participants: number | null;
  max_participants: number | null;
  counter_definitions: unknown;
  is_investigative: boolean | null;
  charter: unknown;
  expected_actions: unknown;
  scoring_rubric: unknown;
  org_key: string | null;
  function_key: string | null;
}

export interface MergeInjectRow {
  id: string;
  has_history: boolean;
  trigger_time_minutes: number | null;
  trigger_condition: string | null;
  type: string;
  title: string;
  content: string;
  affected_roles: unknown;
  severity: string;
  requires_response: boolean | null;
  ai_generated: boolean | null;
  inject_scope: string | null;
  target_teams: string[] | null;
  requires_coordination: boolean | null;
  triggered_by_user_id: string | null;
  required_gate_id: string | null;
  required_gate_not_met_id: string | null;
  conditions_to_appear: unknown;
  conditions_to_cancel: unknown;
  eligible_after_minutes: number | null;
  objective_penalty: unknown;
  state_effect: unknown;
  generation_source: string | null;
  delivery_config: Record<string, unknown> | null;
  response_type: string | null;
}

export interface MergeObjective {
  id: string;
  objective_id: string;
  objective_name: string;
  description: string | null;
  weight: number | null;
  success_criteria: unknown;
}

export interface MergeScenario {
  title: string;
  description: string;
  briefing: string;
  category: string;
  difficulty: string;
  duration_minutes: number;
  initial_state: unknown;
  objectives: MergeObjective[];
}

export interface MergeCurrent {
  scenario: MergeScenario;
  teams: readonly MergeTeamRow[];
  injects: readonly MergeInjectRow[];
}

/** Texts frozen when the edit opened. A field is three-way checked only when it is present. */
export interface OpenedTexts {
  briefing?: string;
  description?: string;
  title?: string;
  stakeholders?: ReadonlyArray<{ id: string; grievance: string; knowledge: string[] }>;
  objectives?: ReadonlyArray<{ id: string; objective_name: string; description: string }>;
}

export interface MergeEdit {
  id: string;
  baseline: SetupSnapshot;
  edited: SetupSnapshot;
  opened?: OpenedTexts;
}

export interface MergeSetupEditInput {
  current: MergeCurrent;
  plan: RemapPlan;
  buildOutputs: readonly SetupEditStageOutput[];
  edit: MergeEdit;
  /** The same decisions passed to planRemap. Targets must still be active. */
  resolutions?: Readonly<Record<string, OrphanResolution>>;
}

export interface TeamInsert {
  id: string;
  team_name: string;
  team_description: string | null;
  required_roles: string[];
  min_participants: number;
  max_participants: number | null;
  counter_definitions: unknown;
  is_investigative: boolean;
  charter: unknown;
  expected_actions: unknown;
  scoring_rubric: unknown;
  org_key: string | null;
  function_key: string | null;
  team_uid: string;
}

export interface TeamRetireWrite {
  id: string;
  reason: string;
  superseded_by: string | null;
}

export interface InjectInsert {
  id: string;
  trigger_time_minutes: number | null;
  trigger_condition: string | null;
  type: string;
  title: string;
  content: string;
  affected_roles: unknown;
  severity: string;
  requires_response: boolean;
  ai_generated: boolean;
  inject_scope: string;
  target_teams: string[];
  requires_coordination: boolean;
  triggered_by_user_id: string | null;
  required_gate_id: string | null;
  required_gate_not_met_id: string | null;
  conditions_to_appear: unknown;
  conditions_to_cancel: unknown;
  eligible_after_minutes: number | null;
  objective_penalty: unknown;
  state_effect: unknown;
  generation_source: string | null;
  delivery_config: Record<string, unknown>;
  response_type: string | null;
}

export interface InjectPatchWrite {
  id: string;
  title: string;
  content: string;
  type: string;
  severity: string;
  trigger_time_minutes: number | null;
  trigger_condition: string | null;
  inject_scope: string;
  target_teams: string[];
  requires_response: boolean;
  conditions_to_appear: unknown;
  conditions_to_cancel: unknown;
  eligible_after_minutes: number | null;
  delivery_config: Record<string, unknown>;
  state_effect: unknown;
  generation_source: string | null;
}

export interface InjectRetireWrite {
  id: string;
  reason: string;
  superseded_by: string | null;
}

export interface ObjectiveInsert {
  id: string;
  objective_id: string;
  objective_name: string;
  description: string;
  weight: number;
  success_criteria: unknown;
}

export interface ObjectiveUpdate {
  id: string;
  objective_name: string;
  description: string;
  weight: number;
}

export interface ApplySummary {
  teams_retired: number;
  teams_added: number;
  teams_succeeded: number;
  injects_patched: number;
  injects_retired: number;
  injects_added: number;
  objectives_updated: number;
  scheduled_sessions: number;
  unassigned_players: number;
  primary_swap: boolean;
  /** Fields the three-way rule left alone because the live value had moved. */
  text_kept: string[];
}

export interface ApplyBundle {
  teams: { retire: TeamRetireWrite[]; insert: TeamInsert[] };
  injects: {
    patch: InjectPatchWrite[];
    retire: InjectRetireWrite[];
    insert: InjectInsert[];
  };
  /** In-place inject ids. The SQL re-checks publications (and deliveries when that table exists) and returns stale if history appeared. */
  history_free_inject_ids: string[];
  scenario: {
    initial_state: unknown;
    set_briefing: boolean;
    briefing: string;
    set_description: boolean;
    description: string;
    set_title: boolean;
    title: string;
    objective_names: string[];
  };
  objectives: {
    update: ObjectiveUpdate[];
    retire: Array<{ id: string }>;
    insert: ObjectiveInsert[];
  };
  scheduled_sessions: ScheduledSessionPlan[];
  /** Team names inserted that are not successors of a retired row. */
  new_team_names: string[];
  summary: ApplySummary;
}

interface WorkingInject {
  row: MergeInjectRow;
  retire: boolean;
  retireReason: string;
  cow: boolean;
  changes: InjectFieldPatch;
  useRevisionText: boolean;
  revision: SetupRevision | null;
}

const CARRIED_CONFIG = ['response_rubric', 'mood_ladder', 'escalation', 'parent_response_rubric'] as const;

export function threeWayText(
  baseline: string,
  current: string,
  proposed: string,
): { value: string; kept: boolean } {
  if (current === baseline) return { value: proposed, kept: false };
  return { value: current, kept: true };
}

/** The page rows `seedOrgPages` writes: one per platform that the org page configures. */
export function orgPagesSeededBy(
  initialState: unknown,
): Array<{ org_key: string; is_primary: boolean; platform: 'facebook' | 'x_twitter' }> {
  const state = asRecord(initialState);
  const orgPage = asRecord(state?.org_page);
  if (!orgPage) return [];
  const rows: Array<{ org_key: string; is_primary: boolean; platform: 'facebook' | 'x_twitter' }> = [];
  for (const org of normalizeOrgPages(orgPage)) {
    if (org.facebook) rows.push({ org_key: org.org_key, is_primary: !!org.is_primary, platform: 'facebook' });
    if (org.x_twitter) rows.push({ org_key: org.org_key, is_primary: !!org.is_primary, platform: 'x_twitter' });
  }
  return rows;
}

export function mergeSetupEdit(input: MergeSetupEditInput): ApplyBundle {
  if (!input.plan.applicable || input.plan.orphans.length > 0) {
    throw new SetupMergeError(
      'ORPHANS_UNRESOLVED',
      'Apply is refused until every orphan has a decision.',
    );
  }
  assertResolutionTargets(input);
  const bundle = composeBundle(input);
  const projected = projectPayload(input, bundle);
  validateScenarioPayload(projected.payload, projected.charters);
  return bundle;
}

export { MultiOrgValidationError };

function composeBundle(input: MergeSetupEditInput): ApplyBundle {
  const textKept: string[] = [];
  const teams = composeTeams(input, textKept);
  const injects = composeInjects(input, teams.activeNames);
  const state = composeState(input, textKept);
  const objectives = composeObjectives(input, textKept);
  const objectiveNames = objectives.active.map((row) => row.objective_name);
  const briefing = nextScenarioText(
    input.current.scenario.briefing,
    narrativeBriefing(input),
    input.edit.opened?.briefing,
    input.edit.baseline.crisis.briefing_hash,
    textKept,
    'briefing',
  );
  const description = nextScenarioText(
    input.current.scenario.description,
    narrativeField(input, 'description'),
    input.edit.opened?.description,
    undefined,
    textKept,
    'description',
  );
  const title = nextScenarioText(
    input.current.scenario.title,
    narrativeField(input, 'title'),
    input.edit.opened?.title,
    undefined,
    textKept,
    'title',
  );
  const newTeamNames = teams.insert
    .filter((row) => !teams.successorIds.has(row.id))
    .map((row) => row.team_name);
  const summary: ApplySummary = {
    teams_retired: teams.retire.length,
    teams_added: newTeamNames.length,
    teams_succeeded: teams.successorIds.size,
    injects_patched: injects.patch.length,
    injects_retired: injects.retire.length,
    injects_added: injects.added,
    objectives_updated: objectives.update.length + objectives.insert.length,
    scheduled_sessions: input.plan.scheduled_sessions.length,
    unassigned_players: input.plan.scheduled_sessions.reduce(
      (sum, session) => sum + session.unassigned_players.length,
      0,
    ),
    primary_swap: input.plan.primary_swap != null,
    text_kept: textKept,
  };
  return {
    teams: { retire: teams.retire, insert: teams.insert },
    injects: { patch: injects.patch, retire: injects.retire, insert: injects.insert },
    history_free_inject_ids: injects.historyFree,
    scenario: {
      initial_state: state,
      set_briefing: briefing.set,
      briefing: briefing.value,
      set_description: description.set,
      description: description.value,
      set_title: title.set,
      title: title.value,
      objective_names: objectiveNames,
    },
    objectives: {
      update: objectives.update,
      retire: objectives.retire,
      insert: objectives.insert,
    },
    scheduled_sessions: input.plan.scheduled_sessions,
    new_team_names: newTeamNames,
    summary,
  };
}

function composeTeams(
  input: MergeSetupEditInput,
  textKept: string[],
): { retire: TeamRetireWrite[]; insert: TeamInsert[]; successorIds: Set<string>; activeNames: Set<string> } {
  const byId = new Map(input.current.teams.map((row) => [row.id, row]));
  const retire: TeamRetireWrite[] = [];
  const insert: TeamInsert[] = [];
  const successorIds = new Set<string>();
  const retiredSource = new Set<string>();
  const descriptionByUid = descriptionUpdates(input.buildOutputs);

  for (const successor of input.plan.teams.successors) {
    const source = byId.get(successor.source_id);
    if (!source) continue;
    const id = randomUUID();
    const described = applyTeamDescription(
      successor.team_uid,
      source.team_description ?? '',
      successor.team_description ?? source.team_description ?? '',
      descriptionByUid,
      input.edit.baseline,
      textKept,
    );
    retire.push({
      id: source.id,
      reason: successor.reason,
      superseded_by: id,
    });
    retiredSource.add(source.id);
    successorIds.add(id);
    insert.push(teamInsert(id, source, {
      team_name: successor.team_name,
      team_description: described,
      org_key: successor.org_key,
      function_key: successor.function_key,
      team_uid: successor.team_uid,
      charter: successor.charter ?? source.charter,
      expected_actions: successor.expected_actions ?? source.expected_actions,
      scoring_rubric: successor.scoring_rubric ?? source.scoring_rubric,
    }));
  }

  for (const row of input.plan.teams.retire) {
    if (retiredSource.has(row.source_id)) continue;
    if (!byId.has(row.source_id)) continue;
    retire.push({ id: row.source_id, reason: row.reason, superseded_by: null });
    retiredSource.add(row.source_id);
  }

  const liveUids = new Set(
    input.current.teams.filter((row) => !retiredSource.has(row.id)).map((row) => row.team_uid),
  );
  for (const row of input.current.teams) {
    if (retiredSource.has(row.id)) continue;
    const proposed = descriptionByUid.get(row.team_uid);
    if (proposed == null) continue;
    const baseline = baselineTeamDescription(input.edit.baseline, row.team_uid);
    const decided = threeWayText(baseline, row.team_description ?? '', proposed);
    if (decided.kept) {
      textKept.push(`team_description:${row.team_uid}`);
      continue;
    }
    if (decided.value === (row.team_description ?? '')) continue;
    const id = randomUUID();
    retire.push({ id: row.id, reason: 'revised', superseded_by: id });
    retiredSource.add(row.id);
    insert.push(teamInsert(id, row, { team_description: decided.value }));
  }

  for (const org of input.edit.edited.organisations) {
    for (const team of org.teams) {
      if (!team.team_uid || liveUids.has(team.team_uid)) continue;
      if (insert.some((row) => row.team_uid === team.team_uid)) continue;
      const charter = charterFor(input.buildOutputs, team.team_name);
      insert.push({
        id: randomUUID(),
        team_name: team.team_name,
        team_description: team.description || null,
        required_roles: [],
        min_participants: 1,
        max_participants: null,
        counter_definitions: null,
        is_investigative: false,
        charter: charter ?? {
          function_key: team.function_key,
          is_custom: team.is_custom,
          can_post_publicly: team.is_public_voice,
          mission: team.description,
        },
        expected_actions: null,
        scoring_rubric: null,
        org_key: mapOrgKey(org.org_key, input.plan),
        function_key: team.function_key || null,
        team_uid: team.team_uid,
      });
    }
  }

  const activeNames = new Set<string>();
  for (const row of input.current.teams) {
    if (!retiredSource.has(row.id)) activeNames.add(row.team_name);
  }
  for (const row of insert) activeNames.add(row.team_name);
  return { retire, insert, successorIds, activeNames };
}

function composeInjects(
  input: MergeSetupEditInput,
  activeNames: Set<string>,
): {
  patch: InjectPatchWrite[];
  retire: InjectRetireWrite[];
  insert: InjectInsert[];
  historyFree: string[];
  added: number;
} {
  const revisions = revisionsById(input.buildOutputs);
  const working = new Map<string, WorkingInject>();
  for (const row of input.current.injects) {
    working.set(row.id, {
      row,
      retire: false,
      retireReason: 'revised',
      cow: false,
      changes: {},
      useRevisionText: false,
      revision: revisions.get(row.id) ?? null,
    });
  }

  for (const patch of input.plan.injects.rewrite_in_place) {
    const item = working.get(patch.inject_id);
    if (!item) continue;
    item.changes = { ...item.changes, ...patch.changes };
    if (item.row.has_history) {
      item.cow = true;
      item.retireReason = 'renamed';
    }
  }
  for (const cow of input.plan.injects.cow) {
    const item = working.get(cow.source_id);
    if (!item) continue;
    item.cow = true;
    item.changes = { ...item.changes, ...cow.changes };
    item.retireReason = 'renamed';
  }
  for (const retired of input.plan.injects.retire) {
    const item = working.get(retired.inject_id);
    if (!item) continue;
    item.retire = true;
    item.cow = false;
    item.retireReason = retired.reason;
  }

  for (const item of working.values()) {
    const revision = item.revision;
    if (!revision || revision.accepted === false || revision.write === 'none' || revision.decision === 'keep') {
      continue;
    }
    const decided = applyRevisionDecision(injectRecord(item.row), revision);
    if (!decided.retired && decided.active === injectRecord(item.row)) continue;
    if (revision.write === 'retire' || revision.decision === 'retire') {
      if (!item.retire) item.retireReason = 'revised';
      item.retire = true;
      item.cow = false;
      continue;
    }
    if (item.retire) continue;
    item.useRevisionText = true;
    if (revision.write === 'cow' || item.row.has_history) item.cow = true;
  }

  const patch: InjectPatchWrite[] = [];
  const retire: InjectRetireWrite[] = [];
  const insert: InjectInsert[] = [];
  const historyFree: string[] = [];
  const activeKeys = new Set<string>();

  for (const item of working.values()) {
    if (item.retire && !item.cow) {
      retire.push({ id: item.row.id, reason: item.retireReason, superseded_by: null });
      continue;
    }
    const dirty = item.useRevisionText || Object.keys(item.changes).length > 0;
    if (!dirty) {
      activeKeys.add(injectKeyOf({ id: item.row.id, delivery_config: item.row.delivery_config }));
      continue;
    }
    const next = materialiseInject(item, activeNames);
    if (item.cow || item.row.has_history) {
      const id = randomUUID();
      retire.push({ id: item.row.id, reason: item.retireReason, superseded_by: id });
      insert.push({ ...next, id });
      activeKeys.add(injectKeyOf({ id, delivery_config: next.delivery_config }));
      continue;
    }
    if (!injectChanged(item.row, next)) {
      activeKeys.add(injectKeyOf({ id: item.row.id, delivery_config: item.row.delivery_config }));
      continue;
    }
    patch.push(patchOf(item.row.id, next));
    historyFree.push(item.row.id);
    activeKeys.add(injectKeyOf({ id: item.row.id, delivery_config: next.delivery_config }));
  }

  const fresh = stampGeneratedInjectKeys(collectGenerated(input.buildOutputs), { taken: [...activeKeys] });
  for (const row of fresh) {
    const targeted = sanitizeTeamTargeting(
      {
        title: row.title ?? '',
        inject_scope: textOf(row.inject_scope) || 'universal',
        target_teams: stringList(row.target_teams),
      },
      activeNames,
    );
    const config = { ...(row.delivery_config ?? {}) };
    insert.push({
      id: randomUUID(),
      trigger_time_minutes: numberOrNull(row.trigger_time_minutes),
      trigger_condition: textOrNull(row.trigger_condition),
      type: textOf(row.type) || 'social_post',
      title: textOf(row.title) || 'Inject',
      content: textOf(row.content),
      affected_roles: [],
      severity: textOf(row.severity) || 'medium',
      requires_response: row.requires_response === true,
      ai_generated: true,
      inject_scope: targeted.inject_scope,
      target_teams: targeted.target_teams,
      requires_coordination: false,
      triggered_by_user_id: null,
      required_gate_id: null,
      required_gate_not_met_id: null,
      conditions_to_appear: row.conditions_to_appear ?? null,
      conditions_to_cancel: row.conditions_to_cancel ?? null,
      eligible_after_minutes: numberOrNull(row.eligible_after_minutes),
      objective_penalty: null,
      state_effect: asRecord(row.state_effect) ?? row.state_effect ?? null,
      generation_source: 'war_room',
      delivery_config: config,
      response_type: null,
    });
  }

  return { patch, retire, insert, historyFree, added: fresh.length };
}

function materialiseInject(item: WorkingInject, activeNames: Set<string>): Omit<InjectInsert, 'id'> {
  const source = item.row;
  const changes = item.changes;
  const revision = item.useRevisionText ? item.revision?.new : undefined;
  const baseConfig = { ...(source.delivery_config ?? {}) };
  const planConfig = changes.delivery_config ? { ...baseConfig, ...changes.delivery_config } : baseConfig;
  const app = textOf(planConfig.app) || textOf(revision?.delivery_config?.app) || textOf(baseConfig.app);
  const key = injectKeyOf({ id: source.id, delivery_config: planConfig });
  let delivery = revision
    ? carryDeliveryConfig(baseConfig, { ...planConfig, ...revision.delivery_config }, key, app)
    : planConfig;
  delivery = restoreCarried(baseConfig, delivery);
  const title = revision?.title ?? changes.title ?? source.title;
  const content = revision?.content ?? changes.content ?? source.content;
  const scope = revision?.inject_scope ?? source.inject_scope ?? 'universal';
  const targets = revision?.target_teams ?? changes.target_teams ?? source.target_teams ?? [];
  const targeted = sanitizeTeamTargeting(
    { title, inject_scope: scope, target_teams: [...targets] },
    activeNames,
  );
  return {
    trigger_time_minutes: revision?.trigger_time_minutes ?? source.trigger_time_minutes,
    trigger_condition: source.trigger_condition,
    type: revision?.type ?? source.type,
    title,
    content,
    affected_roles: source.affected_roles ?? [],
    severity: revision?.severity ?? source.severity,
    requires_response: source.requires_response === true,
    ai_generated: source.ai_generated === true,
    inject_scope: targeted.inject_scope,
    target_teams: targeted.target_teams,
    requires_coordination: source.requires_coordination === true,
    triggered_by_user_id: source.triggered_by_user_id,
    required_gate_id: source.required_gate_id,
    required_gate_not_met_id: source.required_gate_not_met_id,
    conditions_to_appear: revision?.conditions_to_appear ?? changes.conditions_to_appear ?? source.conditions_to_appear ?? null,
    conditions_to_cancel: revision?.conditions_to_cancel ?? changes.conditions_to_cancel ?? source.conditions_to_cancel ?? null,
    eligible_after_minutes: source.eligible_after_minutes,
    objective_penalty: source.objective_penalty ?? null,
    state_effect: source.state_effect ?? null,
    generation_source: source.generation_source,
    delivery_config: delivery,
    response_type: source.response_type,
  };
}

function composeState(input: MergeSetupEditInput, textKept: string[]): unknown {
  const state = asRecord(structuredClone(input.current.scenario.initial_state)) ?? {};
  const peace = pagesPeaceFeed(input.buildOutputs);
  for (const patch of input.plan.initial_state.patch) {
    if (patch.op !== 'replace' || !patch.path.startsWith('/')) continue;
    const key = patch.path.slice(1);
    if (!key || key.includes('/')) continue;
    if (key === 'peace_period' && peace) continue;
    state[key] = structuredClone(patch.value);
  }
  const retired = asRecord(state.retired) ?? {};
  for (const entry of input.plan.initial_state.move_to_retired) {
    const bucket = Array.isArray(retired[entry.bucket]) ? [...(retired[entry.bucket] as unknown[])] : [];
    bucket.push(structuredClone(entry.value));
    retired[entry.bucket] = bucket;
  }
  if (Object.keys(retired).length > 0) state.retired = retired;
  if (Array.isArray(state.org_key_history)) {
    state.org_key_history = replaceEditToken(state.org_key_history, input.edit.id);
  }
  applyTextUpdates(state, input, textKept);
  applyStakeholderUpdates(state, input, textKept);
  const setupSource = latestSetupSource(input.buildOutputs);
  if (setupSource) state.setup_source = setupSource;
  mergePersonas(state, input.buildOutputs);
  const factSheet = latestFactSheet(input.buildOutputs);
  if (factSheet) state.fact_sheet = factSheet;
  overlayPages(state, input);
  ensureEditedProtagonists(state, input);
  if (peace) state.peace_period = peace;
  return state;
}

/**
 * The pages stage builds its feed on top of the planner rewrite. Writing the
 * `/peace_period` patch as well, or instead, drops the new posts and leak terms.
 */
function pagesPeaceFeed(outputs: readonly SetupEditStageOutput[]): ReturnType<typeof usablePeaceFeed> {
  const pages = outputs.length >= 4 ? outputs[3] : undefined;
  return usablePeaceFeed(pages?.peace_period);
}

/** Added organisations are not a remap. The edited setup is what puts them in the registry. */
function ensureEditedProtagonists(state: Record<string, unknown>, input: MergeSetupEditInput): void {
  const orgs = objectList(state.orgs).map((org) => ({ ...org }));
  const keys = new Set(orgs.map((org) => textOf(org.org_key)).filter((key) => key.length > 0));
  for (const org of input.edit.edited.organisations) {
    const key = mapOrgKey(org.org_key, input.plan);
    if (!key || keys.has(key)) continue;
    orgs.push({
      org_uid: org.org_uid,
      org_key: key,
      display_name: org.display_name,
      short_name: org.short_name,
      country: org.country,
      ...(org.city ? { city: org.city } : {}),
      kind: org.kind || 'company',
      side: 'protagonist',
      is_primary: false,
      operation: org.operation,
    });
    keys.add(key);
    const countries = Array.isArray(state.countries) ? [...state.countries] : [];
    const names = new Set(countries.map((row) => textOf(asRecord(row)?.name)));
    if (org.country && !names.has(org.country)) {
      countries.push({ name: org.country, code: org.country.slice(0, 2).toUpperCase() });
      state.countries = countries;
    }
  }
  state.orgs = orgs;
}

function composeObjectives(
  input: MergeSetupEditInput,
  textKept: string[],
): {
  update: ObjectiveUpdate[];
  retire: Array<{ id: string }>;
  insert: ObjectiveInsert[];
  active: MergeObjective[];
} {
  const byId = new Map(input.current.scenario.objectives.map((row) => [row.id, { ...row }]));
  const opened = new Map((input.edit.opened?.objectives ?? []).map((row) => [row.id, row]));
  const update: ObjectiveUpdate[] = [];
  const retire: Array<{ id: string }> = [];
  const insert: ObjectiveInsert[] = [];
  const updates = input.buildOutputs.flatMap((output) => output.objective_updates ?? []);
  for (const change of updates) {
    const current = byId.get(change.objective_id);
    if (!current) continue;
    const baseline = opened.get(current.id);
    const name = baseline
      ? threeWayText(baseline.objective_name, current.objective_name, change.fields.objective_name)
      : { value: change.fields.objective_name, kept: false };
    const description = baseline
      ? threeWayText(baseline.description, current.description ?? '', change.fields.description)
      : { value: change.fields.description, kept: false };
    if (name.kept) textKept.push(`objective:${current.id}:name`);
    if (description.kept) textKept.push(`objective:${current.id}:description`);
    const fields = {
      objective_name: name.value,
      description: description.value,
      weight: change.fields.weight,
    };
    if (change.write === 'cow') {
      const id = randomUUID();
      retire.push({ id: current.id });
      insert.push({
        id,
        objective_id: current.objective_id,
        objective_name: fields.objective_name,
        description: fields.description,
        weight: fields.weight,
        success_criteria: current.success_criteria ?? {},
      });
      byId.delete(current.id);
      byId.set(id, {
        id,
        objective_id: current.objective_id,
        objective_name: fields.objective_name,
        description: fields.description,
        weight: fields.weight,
        success_criteria: current.success_criteria ?? {},
      });
      continue;
    }
    if (name.kept && description.kept && fields.weight === current.weight) continue;
    update.push({ id: current.id, ...fields });
    current.objective_name = fields.objective_name;
    current.description = fields.description;
    current.weight = fields.weight;
  }
  return { update, retire, insert, active: [...byId.values()] };
}

function projectPayload(
  input: MergeSetupEditInput,
  bundle: ApplyBundle,
): { payload: SocialCrisisPayload; charters: PersistableTeamCharter[] } {
  const retiredTeams = new Set(bundle.teams.retire.map((row) => row.id));
  const teams = [
    ...input.current.teams.filter((row) => !retiredTeams.has(row.id)),
    ...bundle.teams.insert.map((row) => ({
      ...row,
      team_description: row.team_description,
    })),
  ];
  const retiredInjects = new Set(bundle.injects.retire.map((row) => row.id));
  const patched = new Map(bundle.injects.patch.map((row) => [row.id, row]));
  const injects: SocialInject[] = [];
  for (const row of input.current.injects) {
    if (retiredInjects.has(row.id)) continue;
    const patch = patched.get(row.id);
    injects.push(socialInject(patch ? { ...row, ...patch, id: row.id } : row));
  }
  for (const row of bundle.injects.insert) injects.push(socialInject(row));
  const state = bundle.scenario.initial_state as SocialCrisisPayload['scenario']['initial_state'];
  const charters = teams.map((team) => charterOf(team));
  const time_injects = injects.filter((row) => row.trigger_time_minutes != null && !row.conditions_to_appear && !row.trigger_condition);
  const decision_injects = injects.filter((row) => row.trigger_condition && row.trigger_time_minutes == null);
  const condition_injects = injects.filter((row) => !time_injects.includes(row) && !decision_injects.includes(row));
  const payload: SocialCrisisPayload = {
    scenario: {
      title: bundle.scenario.set_title ? bundle.scenario.title : input.current.scenario.title,
      description: bundle.scenario.set_description ? bundle.scenario.description : input.current.scenario.description,
      briefing: bundle.scenario.set_briefing ? bundle.scenario.briefing : input.current.scenario.briefing,
      category: 'social_media_crisis',
      difficulty: input.current.scenario.difficulty,
      duration_minutes: input.current.scenario.duration_minutes,
      initial_state: state,
    },
    teams: teams.map((team) => ({
      team_name: team.team_name,
      team_description: team.team_description ?? '',
      min_participants: team.min_participants ?? 1,
      max_participants: team.max_participants ?? 6,
    })),
    objectives: objectiveDefs(input, bundle),
    sop: {
      sop_name: 'Setup',
      description: '',
      steps: [],
      response_time_limit_minutes: input.current.scenario.duration_minutes,
      content_guidelines: { tone: [], avoid: [], include: [], language_sensitivity: [] },
    },
    time_injects,
    condition_injects,
    decision_injects,
  };
  return { payload, charters };
}

function objectiveDefs(input: MergeSetupEditInput, bundle: ApplyBundle): ObjectiveDef[] {
  const retired = new Set(bundle.objectives.retire.map((row) => row.id));
  const updated = new Map(bundle.objectives.update.map((row) => [row.id, row]));
  const defs: ObjectiveDef[] = [];
  for (const row of input.current.scenario.objectives) {
    if (retired.has(row.id)) continue;
    const next = updated.get(row.id);
    defs.push({
      objective_id: row.objective_id,
      objective_name: next?.objective_name ?? row.objective_name,
      description: next?.description ?? row.description ?? '',
      weight: next?.weight ?? row.weight ?? 25,
    });
  }
  for (const row of bundle.objectives.insert) {
    defs.push({
      objective_id: row.objective_id,
      objective_name: row.objective_name,
      description: row.description,
      weight: row.weight,
    });
  }
  return defs;
}

function assertResolutionTargets(input: MergeSetupEditInput): void {
  const resolutions = resolutionRecord(input);
  if (!resolutions) return;
  const activeTeams = postEditTeamNames(input);
  const activeKeys = postEditInjectKeys(input);
  const activeOrgs = postEditOrgKeys(input);
  for (const [id, resolution] of Object.entries(resolutions)) {
    if (input.plan.orphans.some((orphan) => orphan.id === id)) continue;
    if (resolution.choice === 'keep') continue;
    if (resolution.team_name && !activeTeams.has(resolution.team_name)) {
      throw new SetupMergeError(
        'ORPHAN_TARGET_INACTIVE',
        `Orphan ${id} retargets team "${resolution.team_name}", which is not active after this edit.`,
      );
    }
    if (resolution.inject_key && !activeKeys.has(resolution.inject_key)) {
      throw new SetupMergeError(
        'ORPHAN_TARGET_INACTIVE',
        `Orphan ${id} retargets inject "${resolution.inject_key}", which is not active after this edit.`,
      );
    }
    for (const key of resolution.org_keys ?? []) {
      if (!activeOrgs.has(key)) {
        throw new SetupMergeError(
          'ORPHAN_TARGET_INACTIVE',
          `Orphan ${id} retargets organisation "${key}", which is not active after this edit.`,
        );
      }
    }
  }
}

function postEditTeamNames(input: MergeSetupEditInput): Set<string> {
  const removed = new Set(input.plan.teams.retire.map((row) => row.team_name));
  const names = new Set<string>();
  for (const team of input.current.teams) {
    if (!removed.has(team.team_name) || input.plan.teams.successors.some((row) => row.team_name === team.team_name)) {
      names.add(team.team_name);
    }
  }
  for (const row of input.plan.teams.retire) {
    if (row.reason === 'removed') names.delete(row.team_name);
  }
  for (const row of input.plan.teams.successors) names.add(row.team_name);
  for (const org of input.edit.edited.organisations) {
    for (const team of org.teams) names.add(team.team_name);
  }
  return names;
}

function postEditInjectKeys(input: MergeSetupEditInput): Set<string> {
  const retired = new Set(input.plan.injects.retire.map((row) => row.inject_id));
  const kept = new Set(input.plan.injects.cow.map((row) => row.source_id));
  const keys = new Set<string>();
  for (const row of input.current.injects) {
    if (retired.has(row.id) && !kept.has(row.id)) continue;
    keys.add(injectKeyOf(row));
  }
  return keys;
}

function postEditOrgKeys(input: MergeSetupEditInput): Set<string> {
  const keys = new Set<string>();
  for (const org of input.edit.edited.organisations) keys.add(mapOrgKey(org.org_key, input.plan));
  for (const org of input.edit.edited.pressure_organisations) keys.add(mapOrgKey(org.org_key, input.plan));
  for (const org of input.edit.edited.competitors) keys.add(mapOrgKey(org.org_key, input.plan));
  const retiredKeys = new Set(
    input.plan.initial_state.move_to_retired
      .filter((entry) => entry.bucket === 'orgs')
      .map((entry) => entry.key),
  );
  const state = asRecord(input.current.scenario.initial_state);
  for (const org of objectList(state?.orgs)) {
    const key = textOf(org.org_key);
    if (!key || retiredKeys.has(key) || retiredKeys.has(mapOrgKey(key, input.plan))) continue;
    keys.add(mapOrgKey(key, input.plan));
  }
  for (const key of retiredKeys) keys.delete(key);
  return keys;
}

function resolutionRecord(
  input: MergeSetupEditInput,
): Readonly<Record<string, OrphanResolution>> | null {
  return input.resolutions ?? null;
}

function applyTeamDescription(
  teamUid: string,
  baselineCurrent: string,
  proposedFromSuccessor: string,
  updates: Map<string, string>,
  baseline: SetupSnapshot,
  textKept: string[],
): string {
  const update = updates.get(teamUid);
  const proposed = update ?? proposedFromSuccessor;
  const frozen = baselineTeamDescription(baseline, teamUid);
  const decided = threeWayText(frozen, baselineCurrent, proposed);
  if (decided.kept && update != null) textKept.push(`team_description:${teamUid}`);
  return decided.kept ? baselineCurrent : decided.value;
}

function baselineTeamDescription(baseline: SetupSnapshot, teamUid: string): string {
  for (const org of baseline.organisations) {
    const team = org.teams.find((row) => row.team_uid === teamUid);
    if (team) return team.description ?? '';
  }
  return '';
}

function descriptionUpdates(outputs: readonly SetupEditStageOutput[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const output of outputs) {
    for (const update of output.text_updates ?? []) {
      if (update.field === 'team_description' && update.team_uid) map.set(update.team_uid, update.value);
    }
  }
  return map;
}

function applyTextUpdates(state: Record<string, unknown>, input: MergeSetupEditInput, textKept: string[]): void {
  const updates = input.buildOutputs.flatMap((output) => output.text_updates ?? []);
  for (const update of updates) {
    if (update.field === 'team_description') continue;
    if (update.field === 'stance') applyStance(state, input.edit.baseline, update, textKept);
    if (update.field === 'mandate') applyMandate(state, input.edit.baseline, update, textKept);
  }
}

function applyStance(
  state: Record<string, unknown>,
  baseline: SetupSnapshot,
  update: TextUpdate,
  textKept: string[],
): void {
  const page = pageOrg(state, update.org_key);
  if (!page) return;
  const frozen = baseline.competitors.find((row) => row.org_key === update.org_key)?.description ?? '';
  const current = textOf(page.stance);
  const decided = threeWayText(frozen, current, update.value);
  if (decided.kept) {
    textKept.push(`stance:${update.org_key}`);
    return;
  }
  page.stance = decided.value;
}

function applyMandate(
  state: Record<string, unknown>,
  baseline: SetupSnapshot,
  update: TextUpdate,
  textKept: string[],
): void {
  const page = pageOrg(state, update.org_key);
  if (!page) return;
  const posture = asRecord(page.posture) ?? {};
  const frozen = baseline.pressure_organisations.find((row) => row.org_key === update.org_key)?.wants ?? '';
  const current = textOf(posture.mandate);
  const decided = threeWayText(frozen, current, update.value);
  if (decided.kept) {
    textKept.push(`mandate:${update.org_key}`);
    return;
  }
  posture.mandate = decided.value;
  page.posture = posture;
}

function applyStakeholderUpdates(state: Record<string, unknown>, input: MergeSetupEditInput, textKept: string[]): void {
  const updates = input.buildOutputs.flatMap((output) => output.stakeholder_updates ?? []);
  if (updates.length === 0 || !Array.isArray(state.stakeholders)) return;
  const opened = new Map((input.edit.opened?.stakeholders ?? []).map((row) => [row.id, row]));
  const rows = state.stakeholders as Array<Record<string, unknown>>;
  for (const update of updates) {
    const row = rows.find((item) => textOf(item.id) === update.id);
    if (!row) continue;
    const frozen = opened.get(update.id);
    if (!frozen) {
      row.grievance = update.grievance;
      row.knowledge = update.knowledge;
      continue;
    }
    const grievance = threeWayText(frozen.grievance, textOf(row.grievance), update.grievance);
    if (grievance.kept) textKept.push(`stakeholder:${update.id}:grievance`);
    else row.grievance = grievance.value;
    const knowledgeSame = JSON.stringify(row.knowledge ?? []) === JSON.stringify(frozen.knowledge);
    if (knowledgeSame) row.knowledge = update.knowledge;
    else textKept.push(`stakeholder:${update.id}:knowledge`);
  }
}

function mergePersonas(state: Record<string, unknown>, outputs: readonly SetupEditStageOutput[]): void {
  const existing = Array.isArray(state.npc_personas) ? [...state.npc_personas] : [];
  const handles = new Set(
    existing
      .map((row) => textOf(asRecord(row)?.handle))
      .filter((handle) => handle.length > 0),
  );
  for (const output of outputs) {
    if (output.skipped) continue;
    for (const persona of output.generated?.personas ?? []) {
      if (!persona?.handle || handles.has(persona.handle)) continue;
      handles.add(persona.handle);
      existing.push(persona);
    }
  }
  if (existing.length > 0) state.npc_personas = existing;
}

function overlayPages(state: Record<string, unknown>, input: MergeSetupEditInput): void {
  const previous = input.plan.primary_swap?.new_primary_previous_key ?? null;
  const pages = input.buildOutputs.flatMap((output) => (output.skipped ? [] : output.generated?.pages ?? []));
  if (pages.length === 0) return;
  const orgPage = asRecord(state.org_page) ?? { orgs: [] };
  const orgs = Array.isArray(orgPage.orgs) ? (orgPage.orgs as Array<Record<string, unknown>>) : [];
  for (const raw of pages) {
    const page = asRecord(raw);
    if (!page) continue;
    const key = textOf(page.org_key);
    const mapped = key && key === previous ? 'primary' : key;
    const target = orgs.find((org) => textOf(org.org_key) === mapped || (textOf(org.org_uid) && textOf(org.org_uid) === textOf(page.org_uid)));
    if (!target) continue;
    if (page.branded_history != null) target.branded_history = page.branded_history;
    if (typeof page.stance === 'string' && target.stance == null) target.stance = page.stance;
  }
  orgPage.orgs = orgs;
  state.org_page = orgPage;
}

function latestFactSheet(outputs: readonly SetupEditStageOutput[]): unknown {
  for (let index = outputs.length - 1; index >= 0; index -= 1) {
    const output = outputs[index];
    if (output.skipped) continue;
    if (output.fact_sheet && Array.isArray(output.fact_sheet.confirmed_facts)) return output.fact_sheet;
  }
  return null;
}

function latestSetupSource(outputs: readonly SetupEditStageOutput[]): unknown {
  for (let index = outputs.length - 1; index >= 0; index -= 1) {
    const source = outputs[index].setup_source_update;
    if (source) return source;
  }
  return null;
}

function narrativeBriefing(input: MergeSetupEditInput): string | null {
  for (let index = input.buildOutputs.length - 1; index >= 0; index -= 1) {
    const update = input.buildOutputs[index].narrative_update;
    if (!update) continue;
    if (update.briefing_kept) return null;
    return update.briefing;
  }
  return null;
}

function narrativeField(input: MergeSetupEditInput, field: 'title' | 'description'): string | null {
  for (let index = input.buildOutputs.length - 1; index >= 0; index -= 1) {
    const update = input.buildOutputs[index].narrative_update;
    if (update) return update[field];
  }
  return null;
}

function nextScenarioText(
  current: string,
  proposed: string | null,
  opened: string | undefined,
  briefingHash: string | null | undefined,
  textKept: string[],
  label: string,
): { set: boolean; value: string } {
  if (proposed == null) return { set: false, value: current };
  if (opened !== undefined) {
    const decided = threeWayText(opened, current, proposed);
    if (decided.kept) {
      textKept.push(label);
      return { set: false, value: current };
    }
    return { set: true, value: decided.value };
  }
  if (label === 'briefing' && briefingHash && sha256(current) !== briefingHash) {
    textKept.push(label);
    return { set: false, value: current };
  }
  return { set: true, value: proposed };
}

function collectGenerated(outputs: readonly SetupEditStageOutput[]): SocialInject[] {
  const rows: SocialInject[] = [];
  for (const output of outputs) {
    const generated = output.generated;
    if (!generated) continue;
    rows.push(
      ...generated.stakeholder_injects,
      ...generated.shared_injects,
      ...generated.gates,
      ...generated.pressure_injects,
      ...generated.branches,
      ...generated.layer_injects,
    );
    for (const list of Object.values(generated.team_storylines ?? {})) rows.push(...list);
  }
  return rows;
}

function revisionsById(outputs: readonly SetupEditStageOutput[]): Map<string, SetupRevision> {
  const map = new Map<string, SetupRevision>();
  for (const output of outputs) {
    for (const revision of output.revisions ?? []) map.set(revision.inject_id, revision);
  }
  return map;
}

function teamInsert(
  id: string,
  source: MergeTeamRow,
  overlay: Partial<TeamInsert>,
): TeamInsert {
  return {
    id,
    team_name: source.team_name,
    team_description: source.team_description,
    required_roles: source.required_roles ?? [],
    min_participants: source.min_participants ?? 1,
    max_participants: source.max_participants,
    counter_definitions: source.counter_definitions ?? null,
    is_investigative: source.is_investigative === true,
    charter: source.charter ?? null,
    expected_actions: source.expected_actions ?? null,
    scoring_rubric: source.scoring_rubric ?? null,
    org_key: source.org_key,
    function_key: source.function_key,
    team_uid: source.team_uid,
    ...overlay,
  };
}

function charterFor(outputs: readonly SetupEditStageOutput[], teamName: string): unknown {
  for (const output of outputs) {
    const match = (output.generated?.charters ?? []).find((row) => row.team_name === teamName);
    if (match) return match;
  }
  return null;
}

function charterOf(team: {
  team_name: string;
  org_key: string | null;
  function_key: string | null;
  charter: unknown;
}): PersistableTeamCharter {
  const charter = asRecord(team.charter) ?? {};
  return {
    team_name: team.team_name,
    org_key: team.org_key,
    function_key: textOf(charter.function_key) || team.function_key,
    mission: textOf(charter.mission),
    responsibilities: stringList(charter.responsibilities),
    expected_actions: [],
    scoring_rubric: typeof charter.scoring_rubric === 'string' ? charter.scoring_rubric : '',
    out_of_lane: stringList(charter.out_of_lane),
    min_participants: 1,
    max_participants: 6,
    can_post_publicly: charter.can_post_publicly === true,
    is_custom: charter.is_custom !== false,
    sentiment_dimension: textOf(charter.sentiment_dimension) || 'public_trust',
  } as PersistableTeamCharter;
}

function socialInject(row: {
  title: string;
  content: string;
  type: string;
  severity: string;
  trigger_time_minutes?: number | null;
  trigger_condition?: string | null;
  inject_scope: string | null;
  target_teams: string[] | null;
  requires_response?: boolean | null;
  conditions_to_appear?: unknown;
  conditions_to_cancel?: unknown;
  eligible_after_minutes?: number | null;
  state_effect?: unknown;
  delivery_config: Record<string, unknown> | null;
}): SocialInject {
  return {
    title: row.title,
    content: row.content,
    type: row.type,
    severity: row.severity,
    trigger_time_minutes: row.trigger_time_minutes ?? undefined,
    trigger_condition: row.trigger_condition ?? undefined,
    inject_scope: row.inject_scope || 'universal',
    target_teams: row.target_teams ?? [],
    requires_response: row.requires_response === true,
    conditions_to_appear: row.conditions_to_appear as SocialInject['conditions_to_appear'],
    conditions_to_cancel: row.conditions_to_cancel as SocialInject['conditions_to_cancel'],
    eligible_after_minutes: row.eligible_after_minutes ?? undefined,
    state_effect: asRecord(row.state_effect) ?? undefined,
    delivery_config: (row.delivery_config ?? {}) as SocialInject['delivery_config'],
  };
}

function injectRecord(row: MergeInjectRow): Record<string, unknown> {
  return { ...row };
}

function patchOf(id: string, row: Omit<InjectInsert, 'id'>): InjectPatchWrite {
  return {
    id,
    title: row.title,
    content: row.content,
    type: row.type,
    severity: row.severity,
    trigger_time_minutes: row.trigger_time_minutes,
    trigger_condition: row.trigger_condition,
    inject_scope: row.inject_scope,
    target_teams: row.target_teams,
    requires_response: row.requires_response,
    conditions_to_appear: row.conditions_to_appear,
    conditions_to_cancel: row.conditions_to_cancel,
    eligible_after_minutes: row.eligible_after_minutes,
    delivery_config: row.delivery_config,
    state_effect: row.state_effect,
    generation_source: row.generation_source,
  };
}

function injectChanged(row: MergeInjectRow, next: Omit<InjectInsert, 'id'>): boolean {
  return (
    row.title !== next.title ||
    row.content !== next.content ||
    (row.inject_scope || 'universal') !== next.inject_scope ||
    JSON.stringify(row.target_teams ?? []) !== JSON.stringify(next.target_teams) ||
    JSON.stringify(row.conditions_to_appear ?? null) !== JSON.stringify(next.conditions_to_appear ?? null) ||
    JSON.stringify(row.conditions_to_cancel ?? null) !== JSON.stringify(next.conditions_to_cancel ?? null) ||
    JSON.stringify(row.delivery_config ?? {}) !== JSON.stringify(next.delivery_config)
  );
}

function restoreCarried(
  original: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...next };
  for (const key of CARRIED_CONFIG) {
    if (key in original) merged[key] = original[key];
  }
  return merged;
}

function replaceEditToken(value: unknown, editId: string): unknown {
  if (value === EDIT_TOKEN) return editId;
  if (Array.isArray(value)) return value.map((item) => replaceEditToken(item, editId));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = replaceEditToken(item, editId);
    }
    return out;
  }
  return value;
}

function mapOrgKey(key: string, plan: RemapPlan): string {
  return plan.primary_swap?.map[key] ?? key;
}

function pageOrg(state: Record<string, unknown>, orgKey: string): Record<string, unknown> | null {
  const page = asRecord(state.org_page);
  const orgs = Array.isArray(page?.orgs) ? (page.orgs as Array<Record<string, unknown>>) : [];
  return orgs.find((org) => textOf(org.org_key) === orgKey) ?? null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function objectList(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((row) => row && typeof row === 'object' && !Array.isArray(row)) as Array<Record<string, unknown>>;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
