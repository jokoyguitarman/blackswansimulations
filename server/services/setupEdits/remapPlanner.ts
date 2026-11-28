import { canonicalJson } from '../../../shared/canonicalJson.js';
import { countryCode, countrySlug } from '../../../shared/countries.js';
import { formatConditionKey, slugifyTeamName } from '../../../shared/conditionKeyGrammar.js';
import { injectKeyOf } from '../../lib/injectKey.js';
import {
  fingerprintInject,
  inferLayer,
  isAiOwned,
  type LayerTeam,
} from '../../lib/injectFingerprint.js';
import { injectKeysInParsedCondition, parseConditionKey } from '../conditions/conditionCatalog.js';
import { makeOrgKey } from '../scenarioOrgModel.js';
import type { SetupDelta } from './setupDeltaCore.js';
import type { SetupSnapshot, SnapshotOrg, SnapshotTeam } from './setupSnapshotCore.js';

/**
 * Pure remap plan for one setup edit. No AI and no database.
 * Order is fixed: primary swap, then renames, then removals, then additions.
 * The swap map is applied once. A second pass would merge the two organisations.
 */

export const EDIT_TOKEN = '$edit';

export const CALL_LINE_STEPS = ['insert_line', 'move_takers', 'delete_old_line'] as const;

export interface PlannerTeam {
  id: string;
  team_uid: string;
  team_name: string;
  org_key: string | null;
  function_key: string | null;
  team_description: string | null;
  charter: unknown;
  expected_actions: unknown;
  scoring_rubric: unknown;
}

export interface PlannerInject {
  id: string;
  title?: string | null;
  content?: string | null;
  type?: string | null;
  severity?: string | null;
  trigger_time_minutes?: number | null;
  eligible_after_minutes?: number | null;
  target_teams?: string[] | null;
  inject_scope?: string | null;
  requires_response?: boolean | null;
  conditions_to_appear?: unknown;
  conditions_to_cancel?: unknown;
  trigger_condition?: string | null;
  delivery_config?: Record<string, unknown> | null;
  generation_source?: string | null;
  has_history: boolean;
}

export interface LobbySession {
  session_id: string;
  status: string;
  start_time: string | null;
  teams: Array<{ user_id: string; team_name: string }>;
  channels: Array<{ team_name: string | null; message_count: number }>;
  call_lines: Array<{ team_name: string }>;
  call_takers: Array<{ team_name: string; user_id: string }>;
  role_assignments: Array<{ role_id: string; user_id: string }>;
  page_controllers: Array<{ org_key: string; user_id: string }>;
  org_pages?: Array<{ org_key: string }>;
}

export interface RemapPlannerInput {
  delta: SetupDelta;
  /** Edited setup. Org keys are still the pre-swap keys. */
  edited: SetupSnapshot;
  initial_state: unknown;
  teams: readonly PlannerTeam[];
  injects: readonly PlannerInject[];
  sessions: readonly LobbySession[];
  /** Trainer decisions for orphan ids. Applied before `applicable` is set. */
  resolutions?: Readonly<Record<string, OrphanResolution>>;
}

export interface TeamRetire {
  source_id: string;
  team_uid: string;
  team_name: string;
  /** Key the removal acted on, after the swap. */
  org_key: string | null;
  /**
   * `removed` drops the team. Any other reason retires the source row of the
   * successor with the same `source_id`. WP10 retires every entry here.
   */
  reason: 'removed' | 'renamed' | 'rekeyed' | 'renamed_rekeyed';
}

export interface TeamSuccessor {
  source_id: string;
  team_uid: string;
  team_name: string;
  from_name: string;
  org_key: string | null;
  function_key: string | null;
  team_description: string | null;
  charter: unknown;
  expected_actions: unknown;
  scoring_rubric: unknown;
  /**
   * Replacement for `source_id`. That source is also listed in `teams.retire`
   * with this same reason, and applying the successor retires it.
   */
  reason: 'renamed' | 'rekeyed' | 'renamed_rekeyed';
}

export interface InjectFieldPatch {
  target_teams?: string[];
  conditions_to_appear?: unknown;
  conditions_to_cancel?: unknown;
  delivery_config?: Record<string, unknown>;
  title?: string;
  content?: string;
}

export interface InjectPatch {
  inject_id: string;
  inject_key: string;
  has_history: false;
  changes: InjectFieldPatch;
}

export interface InjectSuccessor {
  source_id: string;
  inject_key: string;
  has_history: true;
  changes: InjectFieldPatch;
}

export type InjectRetireReason =
  'targets_only_removed' | 'team_layer' | 'org_key' | 'pressure_layer' | 'dependent';

export interface InjectRetire {
  inject_id: string;
  inject_key: string;
  reason: InjectRetireReason;
  /** Post-swap key, when an org or pressure key caused the retire. */
  org_key?: string;
  team_uid?: string;
}

export interface JsonPatch {
  op: 'replace';
  path: string;
  value: unknown;
}

export type RetiredBucket =
  'orgs' | 'org_page_orgs' | 'stakeholders' | 'countries' | 'player_roles';

export interface RetiredEntry {
  bucket: RetiredBucket;
  key: string;
  value: unknown;
}

export interface CallLineMove {
  from_team: string;
  to_team: string;
  steps: typeof CALL_LINE_STEPS;
}

export interface NameMap {
  team_names: Array<{ from: string; to: string }>;
  channels: Array<{ from: string; to: string }>;
  call_lines: CallLineMove[];
}

export interface ScheduledSessionPlan {
  session_id: string;
  rename: NameMap;
  remove_teams: string[];
  /** Team names whose call lines and takers are deleted. */
  delete_call_lines: string[];
  /** Team channels with no messages. Channels that already have messages stay. */
  delete_channels: string[];
  remove_org_keys: string[];
  retire_roles: string[];
  /** Assignments kept because the role moved to another team instead of being retired. */
  reassign_roles: Array<{ role_id: string; team_name: string }>;
  unassigned_players: Array<{ user_id: string; team_name: string }>;
  /** Simultaneous org-key map, one entry per controller row that changes. */
  remap_page_controllers: Array<{ from: string; to: string; user_id: string }>;
  /** Delete sim_org_pages and posts seeded from them, then seedOrgPages after commit. */
  delete_sim_org_pages: boolean;
  reseed_org_pages: boolean;
}

export type OrphanKind =
  | 'player_role'
  | 'condition'
  | 'stakeholder'
  | 'pressure_targets'
  | 'chain_target'
  | 'mood_consequence'
  | 'team_dependency';

export type OrphanChoice =
  'keep' | 'retire' | 'retarget' | 'reassign' | 'move_to_retired' | 'clear' | 'remove';

/**
 * One trainer decision for an orphan id.
 * `keep` leaves the reference. `retire` retires the dependent inject, stakeholder, or pressure group.
 * `retarget` uses `inject_key`, `team_name`, or `org_keys`. `reassign` moves a role or stakeholder onto `team_name`.
 * `move_to_retired` parks a role or stakeholder. `clear` drops a chain, mood, or dependency reference. `remove` drops a dependency edge or pressure group.
 */
export interface OrphanResolution {
  choice: OrphanChoice;
  inject_key?: string;
  team_name?: string;
  org_keys?: string[];
}

export interface Orphan {
  id: string;
  kind: OrphanKind;
  message: string;
  choices: string[];
  inject_id?: string;
  inject_key?: string;
  role_id?: string;
  stakeholder_id?: string;
  team_uid?: string;
  team_name?: string;
  condition_key?: string;
  org_key?: string;
  dependency_id?: string;
  target_key?: string;
}

export interface Warning {
  code:
    | 'hand_edit_team_mention'
    | 'hand_edit_names_former_primary'
    | 'retired_role_fallback'
    | 'hand_edit_relocation'
    | 'swap_unresolved';
  message: string;
  inject_id?: string;
  inject_key?: string;
  role_id?: string;
  org_key?: string;
}

export interface PrimarySwapPlan {
  from_org_uid: string;
  to_org_uid: string;
  to_is_new: boolean;
  /** Apply every replacement in one pass. Never run the map twice. */
  map: Record<string, string>;
  old_primary_key: string;
  old_primary_new_key: string;
  /** Null when the new primary is created directly with `primary`. */
  new_primary_previous_key: string | null;
  story: { severity: 'story'; premise: string };
}

export interface RemapPlan {
  teams: { retire: TeamRetire[]; successors: TeamSuccessor[] };
  injects: { rewrite_in_place: InjectPatch[]; cow: InjectSuccessor[]; retire: InjectRetire[] };
  initial_state: { patch: JsonPatch[]; move_to_retired: RetiredEntry[] };
  scheduled_sessions: ScheduledSessionPlan[];
  orphans: Orphan[];
  warnings: Warning[];
  /** False while any orphan is unresolved. Apply must refuse. */
  applicable: boolean;
  phases: Array<'swap' | 'rename' | 'remove' | 'add'>;
  primary_swap: PrimarySwapPlan | null;
  vacated_countries: string[];
}

interface SwapResolved {
  plan: PrimarySwapPlan;
  /** Identity of O used for the fresh key, after any rename in this edit. */
  oldOrg: {
    org_uid: string;
    display_name: string;
    short_name: string;
    country: string;
    city?: string;
  };
  newOrg: SnapshotOrg | null;
}

interface Working {
  input: RemapPlannerInput;
  swap: SwapResolved | null;
  mapKey: (key: string) => string;
  removedOrgKeys: Set<string>;
  removedPressure: Set<string>;
  removedRivals: Set<string>;
  removedTeamUids: Set<string>;
  removedTeamNames: Set<string>;
  removedSlugs: Set<string>;
  renames: Array<{ team_uid: string; from: string; to: string }>;
  nameMap: Map<string, string>;
  slugMap: Map<string, string>;
  uidName: Map<string, string>;
  /** True when the scenario had exactly one protagonist before this edit. */
  singleProtagonist: boolean;
  warnings: Warning[];
  orphans: Orphan[];
  retiredInjectKeys?: Set<string>;
}

const PATCH_PATHS = [
  '/country',
  '/org_name',
  '/orgs',
  '/org_page',
  '/stakeholders',
  '/player_roles',
  '/strategic_benchmarks',
  '/team_charters',
  '/team_dependencies',
  '/personas',
  '/countries',
  '/decision_context',
  '/sop_steps',
  '/org_key_history',
] as const;

export function planRemap(input: RemapPlannerInput): RemapPlan {
  const state = asRecord(input.initial_state) ?? {};
  const working = buildWorking(input, state);
  const teamPlan = planTeams(working);
  const injectPlan = planInjects(working);
  const statePlan = planInitialState(working, state);
  const sessions = planSessions(working);
  const phases = phasesOf(working, teamPlan, injectPlan, statePlan);
  sortOrphans(working.orphans);
  sortWarnings(working.warnings);
  const plan: RemapPlan = {
    teams: teamPlan,
    injects: injectPlan,
    initial_state: statePlan,
    scheduled_sessions: sessions,
    orphans: working.orphans,
    warnings: working.warnings,
    applicable: working.orphans.length === 0,
    phases,
    primary_swap: working.swap?.plan ?? null,
    vacated_countries: [...input.delta.vacated_countries],
  };
  return applyResolutions(plan, input);
}

function applyResolutions(plan: RemapPlan, input: RemapPlannerInput): RemapPlan {
  const resolutions = input.resolutions;
  if (!resolutions || plan.orphans.length === 0) return plan;
  const state = asRecord(input.initial_state) ?? {};
  const kept: Orphan[] = [];
  for (const orphan of plan.orphans) {
    const resolution = resolutions[orphan.id];
    if (!resolution || !resolutionApplies(orphan, resolution)) {
      kept.push(orphan);
      continue;
    }
    if (resolution.choice !== 'keep') applyOneResolution(plan, input, state, orphan, resolution);
  }
  plan.orphans = kept;
  plan.applicable = kept.length === 0;
  plan.initial_state.move_to_retired.sort(
    (a, b) => a.bucket.localeCompare(b.bucket) || a.key.localeCompare(b.key),
  );
  plan.scheduled_sessions.sort((a, b) => a.session_id.localeCompare(b.session_id));
  return plan;
}

function resolutionApplies(orphan: Orphan, resolution: OrphanResolution): boolean {
  const choice = resolution.choice;
  if (choice === 'keep') return true;
  if (orphan.kind === 'player_role') {
    return choice === 'move_to_retired' || (choice === 'reassign' && !!resolution.team_name);
  }
  if (orphan.kind === 'condition') {
    return (
      choice === 'retire' ||
      (choice === 'retarget' && !!(resolution.team_name || resolution.inject_key))
    );
  }
  if (orphan.kind === 'stakeholder') {
    return (
      choice === 'retire' ||
      choice === 'move_to_retired' ||
      (choice === 'reassign' && !!resolution.team_name)
    );
  }
  if (orphan.kind === 'pressure_targets') {
    return choice === 'remove' || (choice === 'retarget' && (resolution.org_keys?.length ?? 0) > 0);
  }
  if (orphan.kind === 'chain_target') {
    return (
      choice === 'clear' ||
      (choice === 'retarget' && !!(resolution.inject_key || resolution.team_name))
    );
  }
  if (orphan.kind === 'mood_consequence') {
    return choice === 'clear' || (choice === 'retarget' && !!resolution.inject_key);
  }
  if (orphan.kind === 'team_dependency') {
    return (
      choice === 'remove' ||
      choice === 'clear' ||
      (choice === 'retarget' && !!(resolution.team_name || resolution.inject_key))
    );
  }
  return false;
}

function applyOneResolution(
  plan: RemapPlan,
  input: RemapPlannerInput,
  state: Record<string, unknown>,
  orphan: Orphan,
  resolution: OrphanResolution,
): void {
  if (orphan.kind === 'player_role') applyRoleResolution(plan, input, state, orphan, resolution);
  else if (orphan.kind === 'condition') applyConditionResolution(plan, input, orphan, resolution);
  else if (orphan.kind === 'stakeholder')
    applyStakeholderResolution(plan, state, orphan, resolution);
  else if (orphan.kind === 'pressure_targets')
    applyPressureResolution(plan, state, orphan, resolution);
  else if (orphan.kind === 'chain_target') applyChainResolution(plan, input, orphan, resolution);
  else if (orphan.kind === 'mood_consequence')
    applyMoodResolution(plan, input, state, orphan, resolution);
  else if (orphan.kind === 'team_dependency')
    applyDependencyResolution(plan, state, orphan, resolution);
}

function applyRoleResolution(
  plan: RemapPlan,
  input: RemapPlannerInput,
  state: Record<string, unknown>,
  orphan: Orphan,
  resolution: OrphanResolution,
): void {
  const roles = objectList(structuredClone(patchValue(plan, '/player_roles', state.player_roles)));
  const role = roles.find((row) => textOf(row.role_id) === orphan.role_id);
  if (!role || !orphan.role_id) return;
  if (resolution.choice === 'reassign' && resolution.team_name) {
    role.team_name = resolution.team_name;
    upsertPatch(plan, '/player_roles', roles);
    for (const session of input.sessions) {
      if (!isScheduled(session)) continue;
      if (!session.role_assignments.some((row) => row.role_id === orphan.role_id)) continue;
      const planned = ensureSessionPlan(plan, session);
      planned.retire_roles = planned.retire_roles.filter((id) => id !== orphan.role_id);
      if (!planned.reassign_roles.some((row) => row.role_id === orphan.role_id)) {
        planned.reassign_roles.push({ role_id: orphan.role_id, team_name: resolution.team_name });
      }
    }
    plan.warnings = plan.warnings.filter(
      (warning) =>
        !(warning.code === 'retired_role_fallback' && warning.role_id === orphan.role_id),
    );
    return;
  }
  if (resolution.choice === 'move_to_retired') {
    upsertPatch(
      plan,
      '/player_roles',
      roles.filter((row) => textOf(row.role_id) !== orphan.role_id),
    );
    plan.initial_state.move_to_retired.push({
      bucket: 'player_roles',
      key: orphan.role_id,
      value: role,
    });
  }
}

function applyConditionResolution(
  plan: RemapPlan,
  input: RemapPlannerInput,
  orphan: Orphan,
  resolution: OrphanResolution,
): void {
  const inject = input.injects.find((row) => row.id === orphan.inject_id);
  if (!inject) return;
  if (resolution.choice === 'retire') {
    retireDependentInject(plan, inject);
    return;
  }
  if (resolution.choice !== 'retarget' || !orphan.condition_key) return;
  if (plan.injects.retire.some((row) => row.inject_id === inject.id)) return;
  const nextKey = retargetConditionKey(orphan.condition_key, resolution);
  const changes = ensureInjectChanges(plan, inject);
  const appear =
    'conditions_to_appear' in changes ? changes.conditions_to_appear : inject.conditions_to_appear;
  const cancel =
    'conditions_to_cancel' in changes ? changes.conditions_to_cancel : inject.conditions_to_cancel;
  changes.conditions_to_appear = mapConditionContainer(appear, (key) =>
    key === orphan.condition_key ? nextKey : key,
  );
  changes.conditions_to_cancel = mapConditionContainer(cancel, (key) =>
    key === orphan.condition_key ? nextKey : key,
  );
}

function retargetConditionKey(key: string, resolution: OrphanResolution): string {
  const parsed = parseConditionKey(key);
  if ('error' in parsed) return key;
  let args = [...parsed.args];
  let scope = parsed.scope ? { ...parsed.scope } : undefined;
  if (resolution.team_name && scope?.team)
    scope = { ...scope, team: slugifyTeamName(resolution.team_name) };
  if (resolution.inject_key) {
    const refs = new Set(referencedInjectKeys(parsed));
    if (refs.size > 0)
      args = args.map((arg) => (refs.has(arg) ? (resolution.inject_key ?? arg) : arg));
  }
  const formatted = formatConditionKey(parsed.def, args, scope);
  return 'error' in formatted ? key : formatted.key;
}

function applyStakeholderResolution(
  plan: RemapPlan,
  state: Record<string, unknown>,
  orphan: Orphan,
  resolution: OrphanResolution,
): void {
  const rows = objectList(structuredClone(patchValue(plan, '/stakeholders', state.stakeholders)));
  const index = rows.findIndex((row) => textOf(row.id) === orphan.stakeholder_id);
  if (index < 0) return;
  if (resolution.choice === 'reassign' && resolution.team_name) {
    rows[index].owning_team = resolution.team_name;
    upsertPatch(plan, '/stakeholders', rows);
    return;
  }
  if (resolution.choice === 'retire' || resolution.choice === 'move_to_retired') {
    const [removed] = rows.splice(index, 1);
    upsertPatch(plan, '/stakeholders', rows);
    plan.initial_state.move_to_retired.push({
      bucket: 'stakeholders',
      key: orphan.stakeholder_id || textOf(removed.id),
      value: removed,
    });
  }
}

function applyPressureResolution(
  plan: RemapPlan,
  state: Record<string, unknown>,
  orphan: Orphan,
  resolution: OrphanResolution,
): void {
  const key = orphan.org_key ?? '';
  if (!key) return;
  const orgs = structuredClone(patchValue(plan, '/orgs', state.orgs));
  const page = structuredClone(patchValue(plan, '/org_page', state.org_page));
  if (resolution.choice === 'retarget') {
    const keys = [...(resolution.org_keys ?? [])];
    for (const org of objectList(orgs)) {
      if (textOf(org.org_key) === key && Array.isArray(org.targets_org_keys))
        org.targets_org_keys = keys;
    }
    for (const org of objectList(asRecord(page)?.orgs)) {
      if (textOf(org.org_key) !== key) continue;
      if (Array.isArray(org.targets_org_keys)) org.targets_org_keys = [...keys];
      const posture = asRecord(org.posture);
      if (posture && Array.isArray(posture.targets_org_keys)) posture.targets_org_keys = [...keys];
    }
    if (orgs !== undefined) upsertPatch(plan, '/orgs', orgs);
    if (page !== undefined) upsertPatch(plan, '/org_page', page);
    return;
  }
  if (resolution.choice !== 'remove') return;
  const liveOrgs = objectList(orgs).filter((org) => textOf(org.org_key) !== key);
  const removedOrgs = objectList(orgs).filter((org) => textOf(org.org_key) === key);
  for (const org of removedOrgs) {
    plan.initial_state.move_to_retired.push({ bucket: 'orgs', key, value: org });
  }
  if (Array.isArray(orgs)) upsertPatch(plan, '/orgs', liveOrgs);
  const pageRecord = asRecord(page);
  if (pageRecord && Array.isArray(pageRecord.orgs)) {
    const removedPages = objectList(pageRecord.orgs).filter((org) => textOf(org.org_key) === key);
    pageRecord.orgs = objectList(pageRecord.orgs).filter((org) => textOf(org.org_key) !== key);
    for (const org of removedPages) {
      plan.initial_state.move_to_retired.push({ bucket: 'org_page_orgs', key, value: org });
    }
    upsertPatch(plan, '/org_page', pageRecord);
  }
}

function applyChainResolution(
  plan: RemapPlan,
  input: RemapPlannerInput,
  orphan: Orphan,
  resolution: OrphanResolution,
): void {
  const inject = input.injects.find((row) => row.id === orphan.inject_id);
  if (!inject || plan.injects.retire.some((row) => row.inject_id === inject.id)) return;
  const changes = ensureInjectChanges(plan, inject);
  const config = ensureConfig(changes, inject);
  const escalation = asRecord(config.escalation);
  if (!escalation) return;
  const step = /^chain:.*:step:(\d+):(target_team|cc_team)$/.exec(orphan.id);
  if (step && Array.isArray(escalation.steps)) {
    const record = asRecord(escalation.steps[Number(step[1])]);
    if (!record) return;
    const field = step[2];
    if (resolution.choice === 'clear') delete record[field];
    else if (resolution.team_name) record[field] = resolution.team_name;
    escalation.steps[Number(step[1])] = record;
    config.escalation = escalation;
    return;
  }
  const exhausted = asRecord(escalation.on_exhausted) ?? {};
  if (resolution.choice === 'clear') delete exhausted.publish_inject_key;
  else if (resolution.inject_key) exhausted.publish_inject_key = resolution.inject_key;
  if (Object.keys(exhausted).length === 0) delete escalation.on_exhausted;
  else escalation.on_exhausted = exhausted;
  config.escalation = escalation;
}

function applyMoodResolution(
  plan: RemapPlan,
  input: RemapPlannerInput,
  state: Record<string, unknown>,
  orphan: Orphan,
  resolution: OrphanResolution,
): void {
  const target = orphan.target_key ?? '';
  if (!target) return;
  if (orphan.inject_id) {
    const inject = input.injects.find((row) => row.id === orphan.inject_id);
    if (!inject || plan.injects.retire.some((row) => row.inject_id === inject.id)) return;
    const changes = ensureInjectChanges(plan, inject);
    const config = ensureConfig(changes, inject);
    config.mood_ladder = rewriteMoodLadder(config.mood_ladder, target, resolution);
    return;
  }
  if (!orphan.stakeholder_id) return;
  const rows = objectList(structuredClone(patchValue(plan, '/stakeholders', state.stakeholders)));
  const row = rows.find((item) => textOf(item.id) === orphan.stakeholder_id);
  if (!row) return;
  row.mood_ladder = rewriteMoodLadder(row.mood_ladder, target, resolution);
  upsertPatch(plan, '/stakeholders', rows);
}

function rewriteMoodLadder(ladder: unknown, target: string, resolution: OrphanResolution): unknown {
  const record = asRecord(structuredClone(ladder));
  if (!record || !Array.isArray(record.rungs)) return ladder;
  for (const rung of record.rungs) {
    const rungRecord = asRecord(rung);
    if (!rungRecord || !Array.isArray(rungRecord.consequences)) continue;
    const next = [];
    for (const consequence of rungRecord.consequences) {
      const item = asRecord(consequence);
      if (!item || item.type !== 'publish_inject' || item.inject_key !== target) {
        next.push(consequence);
        continue;
      }
      if (resolution.choice === 'clear') continue;
      if (resolution.inject_key) next.push({ ...item, inject_key: resolution.inject_key });
      else next.push(consequence);
    }
    rungRecord.consequences = next;
  }
  return record;
}

function applyDependencyResolution(
  plan: RemapPlan,
  state: Record<string, unknown>,
  orphan: Orphan,
  resolution: OrphanResolution,
): void {
  const doc = asRecord(
    structuredClone(patchValue(plan, '/team_dependencies', state.team_dependencies)),
  );
  if (!doc || !Array.isArray(doc.edges)) return;
  doc.edges = doc.edges.flatMap((raw) => {
    const edge = asRecord(raw);
    if (!edge || textOf(edge.id) !== orphan.dependency_id) return [raw];
    if (resolution.choice === 'remove') return [];
    if (resolution.choice === 'clear' && orphan.target_key) {
      edge.consequence_keys = stringList(edge.consequence_keys).filter(
        (key) => key !== orphan.target_key,
      );
    }
    if (resolution.choice === 'retarget') {
      if (resolution.team_name) {
        edge.upstream = retargetRemovedRef(edge.upstream, resolution.team_name);
        if (Array.isArray(edge.downstream)) {
          edge.downstream = edge.downstream.map((ref) =>
            retargetRemovedRef(ref, resolution.team_name ?? ''),
          );
        }
      }
      if (resolution.inject_key && orphan.target_key) {
        edge.consequence_keys = stringList(edge.consequence_keys).map((key) =>
          key === orphan.target_key ? (resolution.inject_key ?? key) : key,
        );
      }
    }
    return [edge];
  });
  upsertPatch(plan, '/team_dependencies', doc);
}

function retargetRemovedRef(value: unknown, teamName: string): unknown {
  const ref = asRecord(value);
  if (!ref || !teamName) return value;
  return { ...ref, team_name: teamName };
}

function retireDependentInject(plan: RemapPlan, inject: PlannerInject): void {
  if (plan.injects.retire.some((row) => row.inject_id === inject.id)) return;
  plan.injects.rewrite_in_place = plan.injects.rewrite_in_place.filter(
    (row) => row.inject_id !== inject.id,
  );
  plan.injects.cow = plan.injects.cow.filter((row) => row.source_id !== inject.id);
  plan.injects.retire.push({
    inject_id: inject.id,
    inject_key: injectKeyOf(inject),
    reason: 'dependent',
  });
  plan.injects.retire.sort((a, b) => a.inject_id.localeCompare(b.inject_id));
}

function ensureInjectChanges(plan: RemapPlan, inject: PlannerInject): InjectFieldPatch {
  const live = plan.injects.rewrite_in_place.find((row) => row.inject_id === inject.id);
  if (live) return live.changes;
  const cow = plan.injects.cow.find((row) => row.source_id === inject.id);
  if (cow) return cow.changes;
  const changes: InjectFieldPatch = {};
  if (inject.has_history) {
    plan.injects.cow.push({
      source_id: inject.id,
      inject_key: injectKeyOf(inject),
      has_history: true,
      changes,
    });
    plan.injects.cow.sort((a, b) => a.source_id.localeCompare(b.source_id));
  } else {
    plan.injects.rewrite_in_place.push({
      inject_id: inject.id,
      inject_key: injectKeyOf(inject),
      has_history: false,
      changes,
    });
    plan.injects.rewrite_in_place.sort((a, b) => a.inject_id.localeCompare(b.inject_id));
  }
  return changes;
}

function ensureConfig(changes: InjectFieldPatch, inject: PlannerInject): Record<string, unknown> {
  if (!changes.delivery_config)
    changes.delivery_config = structuredClone(inject.delivery_config ?? {});
  return changes.delivery_config;
}

function ensureSessionPlan(plan: RemapPlan, session: LobbySession): ScheduledSessionPlan {
  const existing = plan.scheduled_sessions.find((row) => row.session_id === session.session_id);
  if (existing) return existing;
  const created: ScheduledSessionPlan = {
    session_id: session.session_id,
    rename: { team_names: [], channels: [], call_lines: [] },
    remove_teams: [],
    delete_call_lines: [],
    delete_channels: [],
    remove_org_keys: [],
    retire_roles: [],
    reassign_roles: [],
    unassigned_players: [],
    remap_page_controllers: [],
    delete_sim_org_pages: false,
    reseed_org_pages: false,
  };
  plan.scheduled_sessions.push(created);
  return created;
}

function patchValue(plan: RemapPlan, path: string, fallback: unknown): unknown {
  const patch = plan.initial_state.patch.find((item) => item.path === path);
  return patch ? patch.value : fallback;
}

function upsertPatch(plan: RemapPlan, path: string, value: unknown): void {
  const existing = plan.initial_state.patch.find((item) => item.path === path);
  if (existing) {
    existing.value = value;
    return;
  }
  plan.initial_state.patch.push({ op: 'replace', path, value });
  plan.initial_state.patch.sort(
    (a, b) =>
      PATCH_PATHS.indexOf(a.path as (typeof PATCH_PATHS)[number]) -
      PATCH_PATHS.indexOf(b.path as (typeof PATCH_PATHS)[number]),
  );
}

function buildWorking(input: RemapPlannerInput, state: Record<string, unknown>): Working {
  const swap = resolveSwap(input, state);
  const mapRecord = swap?.plan.map ?? {};
  const mapKey = (key: string) =>
    Object.prototype.hasOwnProperty.call(mapRecord, key) ? mapRecord[key] : key;
  const removedOrgKeys = new Set(input.delta.removed_orgs.map(mapKey));
  const removedPressure = new Set(input.delta.removed_pressure);
  const removedRivals = new Set(input.delta.removed_rivals);
  const removedTeamUids = new Set(input.delta.removed_teams.map((team) => team.team_uid));
  const removedTeamNames = new Set(input.delta.removed_teams.map((team) => team.team_name));
  for (const team of input.teams) {
    if (removedOrgKeys.has(orgKeyOfTeam(team, swap))) {
      removedTeamUids.add(team.team_uid);
      removedTeamNames.add(team.team_name);
    }
  }
  const renames = input.delta.renamed_teams.filter((team) => !removedTeamUids.has(team.team_uid));
  const nameMap = new Map(renames.map((team) => [team.from, team.to]));
  const slugMap = new Map<string, string>();
  for (const team of renames) {
    const from = slugifyTeamName(team.from);
    const to = slugifyTeamName(team.to);
    if (from && to && from !== to) slugMap.set(from, to);
  }
  const uidName = new Map(renames.map((team) => [team.team_uid, team.to]));
  const removedSlugs = new Set<string>();
  for (const name of removedTeamNames) {
    const slug = slugifyTeamName(name);
    if (slug) removedSlugs.add(slug);
  }
  return {
    input,
    swap,
    mapKey,
    removedOrgKeys,
    removedPressure,
    removedRivals,
    removedTeamUids,
    removedTeamNames,
    removedSlugs,
    renames,
    nameMap,
    slugMap,
    uidName,
    singleProtagonist: protagonistCount(state) === 1,
    warnings: [],
    orphans: [],
  };
}

function protagonistCount(state: Record<string, unknown>): number {
  const registry = objectList(state.orgs).filter(isProtagonist);
  if (registry.length > 0) return registry.length;
  const pages = pageOrgList(state).filter(isProtagonist);
  if (pages.length > 0) return pages.length;
  return 1;
}

function orgKeyOfTeam(team: PlannerTeam, swap: SwapResolved | null): string {
  const raw = team.org_key?.trim() ?? '';
  if (!raw) return swap ? swap.plan.old_primary_new_key : 'primary';
  return swap ? (swap.plan.map[raw] ?? raw) : raw;
}

function resolveSwap(
  input: RemapPlannerInput,
  state: Record<string, unknown>,
): SwapResolved | null {
  const requested = input.delta.primary_swap;
  if (!requested) return null;
  const registry = objectList(state.orgs);
  const protagonists = registry.filter(isProtagonist);
  const currentOld =
    protagonists.find((org) => textOf(org.org_uid) === requested.from_org_uid) ??
    protagonists.find((org) => org.is_primary === true || textOf(org.org_key) === 'primary');
  const editedOld = input.edited.organisations.find(
    (org) => org.org_uid === requested.from_org_uid || org.org_key === textOf(currentOld?.org_key),
  );
  const editedNew =
    input.edited.organisations.find((org) => org.org_uid === requested.to_org_uid) ??
    input.edited.organisations.find((org) => org.is_primary);
  if (!currentOld || !editedNew) return null;
  const oldKey = textOf(currentOld.org_key) || 'primary';
  const currentNew = requested.to_is_new
    ? null
    : (protagonists.find((org) => textOf(org.org_uid) === requested.to_org_uid) ?? null);
  const previousKey = requested.to_is_new ? null : textOf(currentNew?.org_key) || editedNew.org_key;
  if (!requested.to_is_new && !previousKey) return null;

  const taken = collectTakenKeys(state, input.edited);
  taken.add('primary');
  if (previousKey) taken.add(previousKey);
  const fresh = makeOrgKey(
    {
      display_name: editedOld?.display_name || textOf(currentOld.display_name) || 'Organisation',
      short_name: editedOld?.short_name || textOf(currentOld.short_name) || undefined,
      country: editedOld?.country || textOf(currentOld.country) || 'Singapore',
      is_primary: false,
    },
    taken,
  );
  const map: Record<string, string> = {};
  map[oldKey] = fresh;
  if (previousKey && previousKey !== oldKey) map[previousKey] = 'primary';
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(map).sort()) sorted[key] = map[key];

  const oldName =
    editedOld?.display_name || textOf(currentOld.display_name) || 'The former primary';
  const newName = editedNew.display_name || 'The new primary';
  return {
    plan: {
      from_org_uid: requested.from_org_uid,
      to_org_uid: requested.to_org_uid,
      to_is_new: requested.to_is_new,
      map: sorted,
      old_primary_key: oldKey,
      old_primary_new_key: fresh,
      new_primary_previous_key: previousKey,
      story: {
        severity: 'story',
        premise: `${newName} is now the organisation at the centre of the crisis; ${oldName} becomes a supporting organisation`,
      },
    },
    oldOrg: {
      org_uid: textOf(currentOld.org_uid) || requested.from_org_uid,
      display_name: oldName,
      short_name: editedOld?.short_name || textOf(currentOld.short_name),
      country: editedOld?.country || textOf(currentOld.country),
      city: editedOld?.city || textOf(currentOld.city) || undefined,
    },
    newOrg: editedNew,
  };
}

function collectTakenKeys(state: Record<string, unknown>, edited: SetupSnapshot): Set<string> {
  const taken = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) taken.add(value.trim());
  };
  for (const org of objectList(state.orgs)) add(org.org_key);
  for (const org of pageOrgList(state)) add(org.org_key);
  const retired = asRecord(state.retired);
  for (const org of objectList(retired?.orgs)) add(org.org_key);
  for (const org of objectList(retired?.org_page_orgs)) add(org.org_key);
  for (const entry of objectList(state.org_key_history)) add(entry.org_key);
  for (const org of edited.organisations) add(org.org_key);
  for (const org of edited.pressure_organisations) add(org.org_key);
  for (const org of edited.competitors) add(org.org_key);
  return taken;
}

function planTeams(working: Working): RemapPlan['teams'] {
  const retire: TeamRetire[] = [];
  const successors: TeamSuccessor[] = [];
  const editedTeams = indexEditedTeams(working.input.edited);
  for (const team of working.input.teams) {
    const actedKey = orgKeyOfTeam(team, working.swap);
    if (working.removedTeamUids.has(team.team_uid)) {
      retire.push({
        source_id: team.id,
        team_uid: team.team_uid,
        team_name: team.team_name,
        org_key: actedKey,
        reason: 'removed',
      });
      continue;
    }
    const rename = working.renames.find((item) => item.team_uid === team.team_uid);
    const storedKey = team.org_key?.trim() ? team.org_key.trim() : null;
    const nextKey = working.swap ? actedKey : storedKey;
    const keyChanged = working.swap != null && nextKey !== storedKey;
    const edited = editedTeams.get(team.team_uid);
    const nextFunction =
      edited && edited.function_key && edited.function_key !== (team.function_key ?? '')
        ? edited.function_key
        : (team.function_key ?? null);
    const functionChanged = nextFunction !== (team.function_key ?? null);
    if (!rename && !keyChanged && !functionChanged) continue;
    const nextName = rename?.to ?? team.team_name;
    const reason = rename && keyChanged ? 'renamed_rekeyed' : rename ? 'renamed' : 'rekeyed';
    retire.push({
      source_id: team.id,
      team_uid: team.team_uid,
      team_name: team.team_name,
      org_key: working.swap ? actedKey : storedKey,
      reason,
    });
    successors.push({
      source_id: team.id,
      team_uid: team.team_uid,
      team_name: nextName,
      from_name: team.team_name,
      org_key: nextKey,
      function_key: nextFunction,
      team_description: team.team_description,
      charter: retargetCharter(team.charter, nextName, working),
      expected_actions: cloneJson(team.expected_actions),
      scoring_rubric: team.scoring_rubric ?? null,
      reason,
    });
  }
  retire.sort((a, b) => a.team_uid.localeCompare(b.team_uid));
  successors.sort((a, b) => a.team_uid.localeCompare(b.team_uid));
  return { retire, successors };
}

function indexEditedTeams(edited: SetupSnapshot): Map<string, SnapshotTeam> {
  const out = new Map<string, SnapshotTeam>();
  for (const org of edited.organisations) {
    for (const team of org.teams) out.set(team.team_uid, team);
  }
  return out;
}

function retargetCharter(charter: unknown, teamName: string, working: Working): unknown {
  if (!charter || typeof charter !== 'object' || Array.isArray(charter)) return charter ?? null;
  const copy = structuredClone(charter) as Record<string, unknown>;
  if (typeof copy.team_name === 'string') copy.team_name = teamName;
  if (working.swap && (copy.org_key == null || typeof copy.org_key === 'string')) {
    const current = textOf(copy.org_key);
    copy.org_key = current ? working.mapKey(current) : working.swap.plan.old_primary_new_key;
  }
  return copy;
}

interface InjectDraft {
  retire: InjectRetire | null;
  changes: InjectFieldPatch;
  changed: boolean;
  nextConditions: string[];
  nextConfig: Record<string, unknown> | null;
}

function planInjects(working: Working): RemapPlan['injects'] {
  const layers = layerTeams(working);
  const drafts = new Map<string, InjectDraft>();
  for (const inject of working.input.injects) {
    drafts.set(inject.id, draftInject(working, inject, layers));
  }
  const retiredKeys = new Set<string>();
  for (const inject of working.input.injects) {
    const draft = drafts.get(inject.id);
    if (draft?.retire) retiredKeys.add(injectKeyOf(inject));
  }
  working.retiredInjectKeys = retiredKeys;
  const rewrite_in_place: InjectPatch[] = [];
  const cow: InjectSuccessor[] = [];
  const retire: InjectRetire[] = [];
  for (const inject of working.input.injects) {
    const draft = drafts.get(inject.id);
    if (!draft) continue;
    if (draft.retire) {
      retire.push(draft.retire);
      continue;
    }
    noteTextWarnings(working, inject);
    noteInjectOrphans(working, inject, draft.nextConditions, draft.nextConfig, retiredKeys);
    if (!draft.changed) continue;
    const key = injectKeyOf(inject);
    if (inject.has_history) {
      cow.push({
        source_id: inject.id,
        inject_key: key,
        has_history: true,
        changes: draft.changes,
      });
    } else {
      rewrite_in_place.push({
        inject_id: inject.id,
        inject_key: key,
        has_history: false,
        changes: draft.changes,
      });
    }
  }
  rewrite_in_place.sort((a, b) => a.inject_id.localeCompare(b.inject_id));
  cow.sort((a, b) => a.source_id.localeCompare(b.source_id));
  retire.sort((a, b) => a.inject_id.localeCompare(b.inject_id));
  return { rewrite_in_place, cow, retire };
}

function layerTeams(working: Working): LayerTeam[] {
  return working.input.teams.map((team) => ({
    team_name: working.uidName.get(team.team_uid) ?? team.team_name,
    team_uid: team.team_uid,
  }));
}

function draftInject(working: Working, inject: PlannerInject, layers: LayerTeam[]): InjectDraft {
  const key = injectKeyOf(inject);
  const config = asRecord(inject.delivery_config);
  const stamped = textOf(asRecord(config?.gen)?.layer);
  const removedUid = removedLayerUid(stamped, working);
  if (removedUid) {
    return emptyDraft({
      inject_id: inject.id,
      inject_key: key,
      reason: 'team_layer',
      team_uid: removedUid,
    });
  }
  const explicitOrg = typeof config?.org_key === 'string' ? config.org_key.trim() : '';
  if (explicitOrg) {
    const mapped = working.mapKey(explicitOrg);
    if (working.removedOrgKeys.has(mapped)) {
      return emptyDraft({
        inject_id: inject.id,
        inject_key: key,
        reason: 'org_key',
        org_key: mapped,
      });
    }
  }
  const layer = stamped || layerOf(inject, config, layers);
  const pressureKey = pressureLayerKey(layer, config);
  if (pressureKey && working.removedPressure.has(pressureKey)) {
    return emptyDraft({
      inject_id: inject.id,
      inject_key: key,
      reason: 'pressure_layer',
      org_key: pressureKey,
    });
  }
  const originalTargets = stringList(inject.target_teams);
  const nextTargets = remapNames(originalTargets, working);
  if (originalTargets.length > 0 && nextTargets.length === 0) {
    return emptyDraft({ inject_id: inject.id, inject_key: key, reason: 'targets_only_removed' });
  }

  const changes: InjectFieldPatch = {};
  let changed = false;
  if (!sameStrings(originalTargets, nextTargets)) {
    changes.target_teams = nextTargets;
    changed = true;
  }
  const appear = rewriteConditionValue(inject.conditions_to_appear, working);
  const cancel = rewriteConditionValue(inject.conditions_to_cancel, working);
  if (!sameJson(inject.conditions_to_appear ?? null, appear.value)) {
    changes.conditions_to_appear = appear.value;
    changed = true;
  }
  if (!sameJson(inject.conditions_to_cancel ?? null, cancel.value)) {
    changes.conditions_to_cancel = cancel.value;
    changed = true;
  }
  const rewritten = rewriteDeliveryConfig(config, working);
  const owned = isAiOwned(inject);
  const text = rewriteInjectText(inject, working, owned);
  if (text.title != null) {
    changes.title = text.title;
    changed = true;
  }
  if (text.content != null) {
    changes.content = text.content;
    changed = true;
  }
  const nextConfig = rewritten.config;
  if (changed && owned && typeof asRecord(config?.gen)?.hash === 'string' && nextConfig) {
    const hashed = restampHash(inject, changes, nextConfig);
    if (!sameJson(config, hashed)) {
      changes.delivery_config = hashed;
      changed = true;
    }
  } else if (rewritten.changed && nextConfig) {
    changes.delivery_config = nextConfig;
    changed = true;
  }
  return {
    retire: null,
    changes,
    changed,
    nextConditions: conditionKeysOf(
      changes.conditions_to_appear ?? inject.conditions_to_appear,
      changes.conditions_to_cancel ?? inject.conditions_to_cancel,
    ),
    nextConfig: (changes.delivery_config ?? config) as Record<string, unknown> | null,
  };
}

function emptyDraft(retire: InjectRetire): InjectDraft {
  return { retire, changes: {}, changed: false, nextConditions: [], nextConfig: null };
}

function layerOf(
  inject: PlannerInject,
  config: Record<string, unknown> | null,
  layers: LayerTeam[],
): string {
  const gen = asRecord(config?.gen);
  if (typeof gen?.layer === 'string' && gen.layer) return gen.layer;
  return inferLayer(
    {
      title: inject.title,
      content: inject.content,
      type: inject.type,
      severity: inject.severity,
      trigger_time_minutes: inject.trigger_time_minutes,
      eligible_after_minutes: inject.eligible_after_minutes,
      target_teams: inject.target_teams,
      inject_scope: inject.inject_scope,
      requires_response: inject.requires_response,
      conditions_to_appear: inject.conditions_to_appear,
      conditions_to_cancel: inject.conditions_to_cancel,
      trigger_condition: inject.trigger_condition,
      delivery_config: inject.delivery_config,
      generation_source: inject.generation_source,
    },
    layers,
  );
}

function removedLayerUid(layer: string, working: Working): string | null {
  if (!layer.startsWith('team:')) return null;
  const uid = layer.slice('team:'.length);
  return working.removedTeamUids.has(uid) ? uid : null;
}

function pressureLayerKey(layer: string, config: Record<string, unknown> | null): string | null {
  if (layer.startsWith('pressure:')) return layer.slice('pressure:'.length);
  const orgKey = typeof config?.org_key === 'string' ? config.org_key : '';
  if (orgKey.startsWith('org_pressure_')) return orgKey;
  return null;
}

function remapNames(names: readonly string[], working: Working): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (working.removedTeamNames.has(name)) continue;
    const next = working.nameMap.get(name) ?? name;
    if (!out.includes(next)) out.push(next);
  }
  return out;
}

function rewriteConditionValue(value: unknown, working: Working): { value: unknown } {
  if (working.slugMap.size === 0) return { value };
  return { value: mapConditionContainer(value, (key) => rewriteConditionKey(key, working)) };
}

function mapConditionContainer(value: unknown, mapKey: (key: string) => string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? mapKey(item) : item));
  }
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = { ...record };
  for (const field of ['all', 'any', 'conditions'] as const) {
    if (!Array.isArray(record[field])) continue;
    next[field] = (record[field] as unknown[]).map((item) =>
      typeof item === 'string' ? mapKey(item) : item,
    );
  }
  return next;
}

function rewriteConditionKey(key: string, working: Working): string {
  const parsed = parseConditionKey(key);
  if ('error' in parsed || !parsed.scope?.team) return key;
  const next = working.slugMap.get(parsed.scope.team);
  if (!next) return key;
  const formatted = formatConditionKey(parsed.def, parsed.args, { ...parsed.scope, team: next });
  if ('error' in formatted) return key;
  return formatted.key;
}

function rewriteDeliveryConfig(
  config: Record<string, unknown> | null,
  working: Working,
): { config: Record<string, unknown> | null; changed: boolean } {
  if (!config) return { config: null, changed: false };
  const copy = structuredClone(config);
  let changed = false;
  if (typeof copy.org_key === 'string' && copy.org_key.trim()) {
    const next = working.mapKey(copy.org_key.trim());
    if (next !== copy.org_key) {
      copy.org_key = next;
      changed = true;
    }
  }
  if (typeof copy.stakeholder_team === 'string') {
    const next = remapScalarTeam(copy.stakeholder_team, working);
    if (next === null) {
      delete copy.stakeholder_team;
      changed = true;
    } else if (next !== copy.stakeholder_team) {
      copy.stakeholder_team = next;
      changed = true;
    }
  }
  if (Array.isArray(copy.parent_target_teams)) {
    const original = stringList(copy.parent_target_teams);
    const next = remapNames(original, working);
    if (!sameStrings(original, next)) {
      copy.parent_target_teams = next;
      changed = true;
    }
  }
  const gen = asRecord(copy.gen);
  if (gen && typeof gen.org_key === 'string' && gen.org_key.trim()) {
    const next = working.mapKey(gen.org_key.trim());
    if (next !== gen.org_key) {
      gen.org_key = next;
      copy.gen = gen;
      changed = true;
    }
  }
  if (rewriteEscalationTeams(copy, working)) changed = true;
  return { config: copy, changed };
}

/** Drop a removed team name. Rename through the simultaneous name map. Leave any other token. */
function remapScalarTeam(name: string, working: Working): string | null {
  if (working.removedTeamNames.has(name)) return null;
  return working.nameMap.get(name) ?? name;
}

function rewriteEscalationTeams(config: Record<string, unknown>, working: Working): boolean {
  const escalation = asRecord(config.escalation);
  if (!escalation || !Array.isArray(escalation.steps)) return false;
  let changed = false;
  const steps = escalation.steps.map((step) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return step;
    const copy = { ...(step as Record<string, unknown>) };
    for (const field of ['target_team', 'cc_team'] as const) {
      if (typeof copy[field] !== 'string') continue;
      const current = copy[field] as string;
      if (working.removedTeamNames.has(current)) continue;
      const next = working.nameMap.get(current);
      if (next && next !== current) {
        copy[field] = next;
        changed = true;
      }
    }
    return copy;
  });
  if (changed) {
    escalation.steps = steps;
    config.escalation = escalation;
  }
  return changed;
}

function rewriteInjectText(
  inject: PlannerInject,
  working: Working,
  owned: boolean,
): { title?: string; content?: string } {
  const title = inject.title ?? '';
  const content = inject.content ?? '';
  if (!owned || working.renames.length === 0) return {};
  const nextTitle = substituteNames(title, working.renames);
  const nextContent = substituteNames(content, working.renames);
  return {
    ...(nextTitle !== title ? { title: nextTitle } : {}),
    ...(nextContent !== content ? { content: nextContent } : {}),
  };
}

function noteTextWarnings(working: Working, inject: PlannerInject): void {
  const title = inject.title ?? '';
  const content = inject.content ?? '';
  const owned = isAiOwned(inject);
  if (!owned) {
    for (const rename of working.renames) {
      if (mentionsName(title, rename.from) || mentionsName(content, rename.from)) {
        working.warnings.push({
          code: 'hand_edit_team_mention',
          message: `Hand-edited inject mentions "${rename.from}", which is now "${rename.to}". The text was left as written.`,
          inject_id: inject.id,
          inject_key: injectKeyOf(inject),
        });
        break;
      }
    }
    if (working.swap) {
      const oldName = working.swap.oldOrg.display_name;
      const shortName = working.swap.oldOrg.short_name;
      if (
        (oldName && (mentionsName(title, oldName) || mentionsName(content, oldName))) ||
        (shortName &&
          shortName !== oldName &&
          (mentionsName(title, shortName) || mentionsName(content, shortName)))
      ) {
        working.warnings.push({
          code: 'hand_edit_names_former_primary',
          message: `Hand-edited inject still names ${oldName} as it was written. The story now centres on the new primary.`,
          inject_id: inject.id,
          inject_key: injectKeyOf(inject),
        });
      }
    }
  }
  for (const move of working.input.delta.relocated_orgs) {
    if (owned) continue;
    const mapped = working.mapKey(move.org_key);
    const orgKey =
      typeof inject.delivery_config?.org_key === 'string' ? inject.delivery_config.org_key : '';
    if (orgKey && working.mapKey(orgKey) === mapped) {
      working.warnings.push({
        code: 'hand_edit_relocation',
        message: `Hand-edited inject belongs to an organisation that moved from ${move.from_country} to ${move.to_country}.`,
        inject_id: inject.id,
        inject_key: injectKeyOf(inject),
        org_key: mapped,
      });
    }
  }
}

function restampHash(
  inject: PlannerInject,
  changes: InjectFieldPatch,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const copy = structuredClone(config);
  const gen = asRecord(copy.gen) ?? {};
  delete (gen as { hash?: unknown }).hash;
  copy.gen = gen;
  const hash = fingerprintInject({
    title: changes.title ?? inject.title,
    content: changes.content ?? inject.content,
    type: inject.type,
    severity: inject.severity,
    trigger_time_minutes: inject.trigger_time_minutes,
    eligible_after_minutes: inject.eligible_after_minutes,
    target_teams: changes.target_teams ?? inject.target_teams,
    inject_scope: inject.inject_scope,
    requires_response: inject.requires_response,
    conditions_to_appear: changes.conditions_to_appear ?? inject.conditions_to_appear,
    conditions_to_cancel: changes.conditions_to_cancel ?? inject.conditions_to_cancel,
    delivery_config: copy,
    generation_source: inject.generation_source,
  });
  gen.hash = hash;
  copy.gen = gen;
  return copy;
}

function noteInjectOrphans(
  working: Working,
  inject: PlannerInject,
  conditions: string[],
  config: Record<string, unknown> | null,
  retiredKeys: Set<string>,
): void {
  const injectKey = injectKeyOf(inject);
  for (const key of conditions) {
    const parsed = parseConditionKey(key);
    if (!('error' in parsed) && parsed.scope?.team && working.removedSlugs.has(parsed.scope.team)) {
      working.orphans.push({
        id: `condition:${inject.id}:${key}`,
        kind: 'condition',
        message: `Condition ${key} scopes a team that is being removed.`,
        choices: ['keep', 'retire_inject', 'retarget'],
        inject_id: inject.id,
        inject_key: injectKey,
        condition_key: key,
        team_name: [...working.removedTeamNames].find(
          (name) => slugifyTeamName(name) === parsed.scope?.team,
        ),
      });
    }
    if ('error' in parsed) continue;
    for (const target of referencedInjectKeys(parsed)) {
      if (!retiredKeys.has(target)) continue;
      working.orphans.push({
        id: `condition:${inject.id}:${key}:ref:${target}`,
        kind: 'condition',
        message: `Condition ${key} references retired inject ${target}.`,
        choices: ['keep', 'retire_inject', 'retarget'],
        inject_id: inject.id,
        inject_key: injectKey,
        condition_key: key,
        target_key: target,
      });
    }
  }
  noteChainOrphans(working, inject, config, retiredKeys);
  noteMoodOrphans(working, inject.id, injectKey, config?.mood_ladder, retiredKeys, 'inject');
  const roleId = typeof config?.target_role_id === 'string' ? config.target_role_id : '';
  if (roleId && retiredRoleIds(working).has(roleId)) {
    working.warnings.push({
      code: 'retired_role_fallback',
      message: `Inject targets role ${roleId}, which is retired with its team. At runtime it uses the unknown-role fallback.`,
      inject_id: inject.id,
      inject_key: injectKey,
      role_id: roleId,
    });
  }
}

function referencedInjectKeys(parsed: {
  def: { id: string; looseArgs?: boolean; params?: Array<{ type: string; name: string }> };
  args: string[];
}): string[] {
  return injectKeysInParsedCondition(parsed);
}

function noteChainOrphans(
  working: Working,
  inject: PlannerInject,
  config: Record<string, unknown> | null,
  retiredKeys: Set<string>,
): void {
  const escalation = asRecord(config?.escalation);
  if (!escalation) return;
  const exhausted = asRecord(escalation.on_exhausted);
  const publish =
    typeof exhausted?.publish_inject_key === 'string' ? exhausted.publish_inject_key : '';
  if (publish && retiredKeys.has(publish)) {
    working.orphans.push({
      id: `chain:${inject.id}:${publish}`,
      kind: 'chain_target',
      message: `Escalation on ${injectKeyOf(inject)} publishes retired inject ${publish} when it is exhausted.`,
      choices: ['keep', 'clear', 'retarget'],
      inject_id: inject.id,
      inject_key: injectKeyOf(inject),
      target_key: publish,
    });
  }
  const steps = Array.isArray(escalation.steps) ? escalation.steps : [];
  steps.forEach((step, index) => {
    const record = asRecord(step);
    if (!record) return;
    for (const field of ['target_team', 'cc_team'] as const) {
      const name = typeof record[field] === 'string' ? record[field] : '';
      if (!name || !working.removedTeamNames.has(name)) continue;
      working.orphans.push({
        id: `chain:${inject.id}:step:${index}:${field}`,
        kind: 'chain_target',
        message: `Escalation step ${index + 1} still targets removed team ${name}.`,
        choices: ['clear', 'retarget'],
        inject_id: inject.id,
        inject_key: injectKeyOf(inject),
        team_name: name,
      });
    }
  });
}

function noteMoodOrphans(
  working: Working,
  ownerId: string,
  ownerKey: string,
  ladder: unknown,
  retiredKeys: Set<string>,
  owner: 'inject' | 'stakeholder',
): void {
  const record = asRecord(ladder);
  if (!record || !Array.isArray(record.rungs)) return;
  for (const rung of record.rungs) {
    const rungRecord = asRecord(rung);
    const consequences = Array.isArray(rungRecord?.consequences) ? rungRecord.consequences : [];
    for (const consequence of consequences) {
      const item = asRecord(consequence);
      if (!item || item.type !== 'publish_inject') continue;
      const key = typeof item.inject_key === 'string' ? item.inject_key : '';
      if (!key || !retiredKeys.has(key)) continue;
      working.orphans.push({
        id: `mood:${owner}:${ownerId}:${key}`,
        kind: 'mood_consequence',
        message: `A mood rung publishes retired inject ${key}.`,
        choices: ['keep', 'clear', 'retarget'],
        ...(owner === 'inject'
          ? { inject_id: ownerId, inject_key: ownerKey }
          : { stakeholder_id: ownerId }),
        target_key: key,
      });
    }
  }
}

function retiredRoleIds(working: Working): Set<string> {
  const ids = new Set<string>();
  for (const role of objectList(asRecord(working.input.initial_state)?.player_roles)) {
    const team = textOf(role.team_name);
    if (team && working.removedTeamNames.has(team) && textOf(role.role_id))
      ids.add(textOf(role.role_id));
  }
  return ids;
}

function planInitialState(
  working: Working,
  state: Record<string, unknown>,
): RemapPlan['initial_state'] {
  const retired: RetiredEntry[] = [];
  const orgs = planOrgs(working, state, retired);
  const orgPage = planOrgPage(working, state, retired);
  const stakeholders = planStakeholders(working, state, retired);
  const roles = planRoles(working, state);
  const benchmarks = planBenchmarks(working, state);
  const charters = planCharters(working, state);
  const dependencies = planDependencies(working, state);
  const personas = planPersonas(working, state);
  const countries = planCountries(working, state, orgs.value, retired);
  const decision = planKeyedTree(state.decision_context, working);
  const steps = planKeyedTree(state.sop_steps, working);
  const history = planHistory(working, state);
  const country = planScenarioCountry(working, state);
  const orgName = planScenarioName(working, state);

  const candidates: Array<{ path: string; value: unknown; before: unknown }> = [
    { path: '/country', value: country.value, before: state.country ?? null },
    { path: '/org_name', value: orgName.value, before: state.org_name ?? null },
    { path: '/orgs', value: orgs.value, before: state.orgs ?? null },
    { path: '/org_page', value: orgPage.value, before: state.org_page ?? null },
    { path: '/stakeholders', value: stakeholders.value, before: state.stakeholders ?? null },
    { path: '/player_roles', value: roles.value, before: state.player_roles ?? null },
    {
      path: '/strategic_benchmarks',
      value: benchmarks.value,
      before: state.strategic_benchmarks ?? null,
    },
    { path: '/team_charters', value: charters.value, before: state.team_charters ?? null },
    {
      path: '/team_dependencies',
      value: dependencies.value,
      before: state.team_dependencies ?? null,
    },
    { path: '/personas', value: personas.value, before: state.personas ?? null },
    { path: '/countries', value: countries.value, before: state.countries ?? null },
    { path: '/decision_context', value: decision.value, before: state.decision_context ?? null },
    { path: '/sop_steps', value: steps.value, before: state.sop_steps ?? null },
    { path: '/org_key_history', value: history.value, before: state.org_key_history ?? null },
  ];
  const patch: JsonPatch[] = [];
  for (const path of PATCH_PATHS) {
    const item = candidates.find((candidate) => candidate.path === path);
    if (!item || item.value === undefined) continue;
    if (sameJson(item.before ?? null, item.value ?? null)) continue;
    patch.push({ op: 'replace', path, value: item.value });
  }
  retired.sort((a, b) => a.bucket.localeCompare(b.bucket) || a.key.localeCompare(b.key));
  return { patch, move_to_retired: retired };
}

function planOrgs(
  working: Working,
  state: Record<string, unknown>,
  retired: RetiredEntry[],
): { value: unknown } {
  if (!Array.isArray(state.orgs)) return { value: state.orgs };
  const orgs = objectList(state.orgs).map((org) => structuredClone(org));
  const next: Record<string, unknown>[] = [];
  for (const org of orgs) {
    const key = textOf(org.org_key);
    if (!key) {
      next.push(org);
      continue;
    }
    const mapped = isProtagonist(org) ? working.mapKey(key) : key;
    if (key !== mapped) org.org_key = mapped;
    applyEditedIdentity(org, working);
    if (isProtagonist(org)) retargetProtagonist(org, working);
    if (isPressure(org)) retargetPressure(org, working);
    if (
      working.removedOrgKeys.has(textOf(org.org_key)) ||
      working.removedRivals.has(key) ||
      working.removedPressure.has(key)
    ) {
      retired.push({ bucket: 'orgs', key: textOf(org.org_key) || key, value: org });
      continue;
    }
    next.push(org);
  }
  if (working.swap?.plan.to_is_new && working.swap.newOrg) {
    const created = newPrimaryRegistry(working.swap.newOrg);
    if (!next.some((org) => textOf(org.org_uid) === created.org_uid)) next.push(created);
  }
  return { value: next };
}

function retargetProtagonist(org: Record<string, unknown>, working: Working): void {
  if (!working.swap) return;
  const uid = textOf(org.org_uid);
  const swap = working.swap.plan;
  if (uid !== swap.to_org_uid && uid !== swap.from_org_uid) return;
  const key = textOf(org.org_key);
  org.is_primary = uid === swap.to_org_uid;
  if (!Array.isArray(org.sites)) return;
  org.sites = org.sites.map((site) => {
    const record = asRecord(site);
    if (!record || typeof record.site_key !== 'string') return site;
    const copy = { ...record };
    copy.site_key = siteKeyFor(key, org, record.site_key);
    return copy;
  });
}

function retargetPressure(org: Record<string, unknown>, working: Working): void {
  if (!Array.isArray(org.targets_org_keys)) return;
  const original = stringList(org.targets_org_keys);
  const mapped = original.map((key) => working.mapKey(key));
  const kept = mapped.filter((key) => !working.removedOrgKeys.has(key));
  if (noteEmptyPressureTargets(working, org, original, kept)) {
    org.targets_org_keys = mapped;
    return;
  }
  org.targets_org_keys = kept;
}

function noteEmptyPressureTargets(
  working: Working,
  org: Record<string, unknown>,
  original: string[],
  kept: string[],
): boolean {
  if (original.length === 0 || kept.length > 0) return false;
  const key = textOf(org.org_key);
  if (key && !working.orphans.some((row) => row.id === `pressure:${key}`)) {
    working.orphans.push({
      id: `pressure:${key}`,
      kind: 'pressure_targets',
      message: `Pressure group ${textOf(org.display_name) || key} only targeted organisations that are being removed.`,
      choices: ['retarget', 'remove'],
      org_key: key,
    });
  }
  return true;
}

function applyEditedIdentity(org: Record<string, unknown>, working: Working): void {
  const uid = textOf(org.org_uid);
  const edited = working.input.edited.organisations.find((item) => item.org_uid === uid);
  if (!edited) return;
  if (edited.display_name) org.display_name = edited.display_name;
  if (edited.short_name) org.short_name = edited.short_name;
  if (edited.country) org.country = edited.country;
  if (edited.city) org.city = edited.city;
  if (edited.kind) org.kind = edited.kind;
  if (edited.operation) org.operation = edited.operation;
  if (edited.facebook_handle) org.facebook_handle = edited.facebook_handle;
  if (edited.x_handle) org.x_handle = edited.x_handle;
}

function newPrimaryRegistry(org: SnapshotOrg): Record<string, unknown> {
  const place = countrySlug(org.city || org.country || org.display_name) || 'site';
  return {
    org_uid: org.org_uid,
    org_key: 'primary',
    display_name: org.display_name,
    short_name: org.short_name,
    country: org.country,
    ...(org.city ? { city: org.city } : {}),
    kind: org.kind,
    side: 'protagonist',
    is_primary: true,
    operation: org.operation,
    ...(org.facebook_handle ? { facebook_handle: org.facebook_handle } : {}),
    ...(org.x_handle ? { x_handle: org.x_handle } : {}),
    sites: [
      {
        site_key: `hq_${place}`.slice(0, 40),
        name: `${org.display_name} — ${org.city || org.country}`,
        country: org.country,
        ...(org.city ? { city: org.city } : {}),
      },
    ],
  };
}

function siteKeyFor(orgKey: string, org: Record<string, unknown>, current: string): string {
  const place = current.includes('_')
    ? current.slice(current.indexOf('_') + 1)
    : countrySlug(textOf(org.city) || textOf(org.country) || textOf(org.display_name)) || 'site';
  if (orgKey === 'primary') return `hq_${place}`.slice(0, 40);
  if (current.startsWith('hq_') || current === 'hq') {
    const prefix = countrySlug(textOf(org.short_name) || textOf(org.display_name)) || 'org';
    return `${prefix}_${place}`.slice(0, 40);
  }
  return current;
}

function planOrgPage(
  working: Working,
  state: Record<string, unknown>,
  retired: RetiredEntry[],
): { value: unknown } {
  const page = asRecord(state.org_page);
  if (!page) return { value: state.org_page };
  const copy = structuredClone(page);
  if (!Array.isArray(copy.orgs)) return { value: copy };
  const next: unknown[] = [];
  for (const raw of copy.orgs) {
    const org = asRecord(raw);
    if (!org) {
      next.push(raw);
      continue;
    }
    const key = textOf(org.org_key);
    const protagonist = !isPressure(org) && !isRival(org);
    const mapped = protagonist && key ? working.mapKey(key) : key;
    if (mapped && mapped !== key) org.org_key = mapped;
    if (protagonist && working.swap) {
      const uid = textOf(org.org_uid);
      if (uid === working.swap.plan.to_org_uid) org.is_primary = true;
      else if (uid === working.swap.plan.from_org_uid) org.is_primary = false;
    }
    retargetPagePressure(org, working);
    syncPageIdentity(org, working);
    const remove =
      (protagonist && working.removedOrgKeys.has(textOf(org.org_key))) ||
      working.removedRivals.has(key) ||
      working.removedPressure.has(key);
    if (remove) {
      retired.push({
        bucket: 'org_page_orgs',
        key: textOf(org.org_key) || key,
        value: structuredClone(org),
      });
      continue;
    }
    next.push(org);
  }
  copy.orgs = next;
  return { value: copy };
}

function retargetPagePressure(org: Record<string, unknown>, working: Working): void {
  const posture = asRecord(org.posture);
  if (posture && Array.isArray(posture.targets_org_keys)) {
    const original = stringList(posture.targets_org_keys);
    const mapped = original.map((key) => working.mapKey(key));
    const kept = mapped.filter((key) => !working.removedOrgKeys.has(key));
    posture.targets_org_keys = noteEmptyPressureTargets(working, org, original, kept)
      ? mapped
      : kept;
    org.posture = posture;
  }
  if (Array.isArray(org.targets_org_keys)) {
    const original = stringList(org.targets_org_keys);
    const mapped = original.map((key) => working.mapKey(key));
    const kept = mapped.filter((key) => !working.removedOrgKeys.has(key));
    org.targets_org_keys = noteEmptyPressureTargets(working, org, original, kept) ? mapped : kept;
  }
}

function syncPageIdentity(org: Record<string, unknown>, working: Working): void {
  const uid = textOf(org.org_uid);
  const edited =
    working.input.edited.organisations.find((item) => item.org_uid === uid) ??
    working.input.edited.pressure_organisations.find((item) => item.org_uid === uid) ??
    working.input.edited.competitors.find((item) => item.org_uid === uid);
  if (!edited) return;
  if ('display_name' in edited && edited.display_name) org.display_name = edited.display_name;
  if ('name' in edited && edited.name && org.name) org.name = edited.name;
  if ('short_name' in edited && edited.short_name) org.short_name = edited.short_name;
  if ('country' in edited && edited.country) org.country = edited.country;
  const handle = 'facebook_handle' in edited ? edited.facebook_handle : undefined;
  const xHandle = 'x_handle' in edited ? edited.x_handle : undefined;
  if (handle && typeof org.facebook_handle === 'string') org.facebook_handle = handle;
  if (xHandle && typeof org.x_handle === 'string') org.x_handle = xHandle;
  const facebook = asRecord(org.facebook);
  if (
    facebook &&
    handle &&
    typeof facebook.page_handle === 'string' &&
    facebook.page_handle !== handle
  ) {
    facebook.page_handle = handle;
    org.facebook = facebook;
  }
  const twitter = asRecord(org.x_twitter);
  if (
    twitter &&
    xHandle &&
    typeof twitter.page_handle === 'string' &&
    twitter.page_handle !== xHandle
  ) {
    twitter.page_handle = xHandle;
    org.x_twitter = twitter;
  }
}

function planStakeholders(
  working: Working,
  state: Record<string, unknown>,
  retired: RetiredEntry[],
): { value: unknown } {
  if (!Array.isArray(state.stakeholders)) return { value: state.stakeholders };
  const rows = objectList(state.stakeholders).map((row) => structuredClone(row));
  const survivingTeams = new Set(
    working.input.teams
      .filter((team) => !working.removedTeamUids.has(team.team_uid))
      .map((team) => working.uidName.get(team.team_uid) ?? team.team_name),
  );
  const spokespersons = removedSpokespersons(working, state);
  const usedElsewhere = spokespersonUse(working, spokespersons);
  const next: Record<string, unknown>[] = [];
  for (const row of rows) {
    const id = textOf(row.id);
    if (working.swap) {
      const current = typeof row.org_key === 'string' ? row.org_key.trim() : '';
      if (current) row.org_key = working.mapKey(current);
      else if (working.singleProtagonist) row.org_key = working.swap.plan.old_primary_new_key;
    }
    const owning = typeof row.owning_team === 'string' ? row.owning_team : '';
    if (owning && working.nameMap.has(owning) && !working.removedTeamNames.has(owning)) {
      row.owning_team = working.nameMap.get(owning);
    }
    const orgKey = textOf(row.org_key);
    const ownedBySurvivor =
      owning !== '' && survivingTeams.has(owning) && !working.removedTeamNames.has(owning);
    if (orgKey && working.removedOrgKeys.has(orgKey) && !ownedBySurvivor) {
      retired.push({ bucket: 'stakeholders', key: id || orgKey, value: row });
      continue;
    }
    if (orgKey && working.removedOrgKeys.has(orgKey) && ownedBySurvivor) {
      working.orphans.push({
        id: `stakeholder:${id || orgKey}:org`,
        kind: 'stakeholder',
        message: `Stakeholder ${id || orgKey} belongs to a removed organisation but is owned by ${owning}, which stays.`,
        choices: ['reassign', 'retire'],
        stakeholder_id: id,
        org_key: orgKey,
        team_name: owning,
      });
    }
    if (id && spokespersons.has(id) && !usedElsewhere.has(id)) {
      retired.push({ bucket: 'stakeholders', key: id, value: row });
      continue;
    }
    if (owning && working.removedTeamNames.has(owning)) {
      working.orphans.push({
        id: `stakeholder:${id || owning}`,
        kind: 'stakeholder',
        message: `Stakeholder ${id || owning} is owned by removed team ${owning}.`,
        choices: ['reassign', 'retire'],
        stakeholder_id: id,
        team_name: owning,
      });
    }
    next.push(row);
  }
  for (const row of next) {
    noteMoodOrphans(
      working,
      textOf(row.id),
      '',
      row.mood_ladder,
      retiredInjectKeys(working),
      'stakeholder',
    );
  }
  return { value: next };
}

function retiredInjectKeys(working: Working): Set<string> {
  if (working.retiredInjectKeys) return working.retiredInjectKeys;
  const keys = new Set<string>();
  const layers = layerTeams(working);
  for (const inject of working.input.injects) {
    if (draftInject(working, inject, layers).retire) keys.add(injectKeyOf(inject));
  }
  working.retiredInjectKeys = keys;
  return keys;
}

function removedSpokespersons(working: Working, state: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  if (working.removedPressure.size === 0) return ids;
  for (const org of objectList(state.orgs)) {
    const key = textOf(org.org_key);
    if (!working.removedPressure.has(key)) continue;
    const id = textOf(org.spokesperson_stakeholder_id);
    if (id) ids.add(id);
  }
  for (const org of pageOrgList(state)) {
    const key = textOf(org.org_key);
    if (!working.removedPressure.has(key)) continue;
    const id = textOf(org.spokesperson_stakeholder_id);
    if (id) ids.add(id);
  }
  return ids;
}

function spokespersonUse(working: Working, ids: Set<string>): Set<string> {
  const used = new Set<string>();
  if (ids.size === 0) return used;
  const retired = retiredInjectKeys(working);
  for (const inject of working.input.injects) {
    if (retired.has(injectKeyOf(inject))) continue;
    const stakeholder = textOf(asRecord(inject.delivery_config)?.stakeholder_id);
    if (stakeholder && ids.has(stakeholder)) used.add(stakeholder);
  }
  for (const org of objectList(asRecord(working.input.initial_state)?.orgs)) {
    const key = textOf(org.org_key);
    if (working.removedPressure.has(key)) continue;
    const id = textOf(org.spokesperson_stakeholder_id);
    if (id && ids.has(id)) used.add(id);
  }
  return used;
}

function planRoles(working: Working, state: Record<string, unknown>): { value: unknown } {
  if (!Array.isArray(state.player_roles)) return { value: state.player_roles };
  const roles = objectList(state.player_roles).map((role) => structuredClone(role));
  for (const role of roles) {
    const team = textOf(role.team_name);
    if (!team) continue;
    if (working.removedTeamNames.has(team)) {
      const roleId = textOf(role.role_id);
      working.orphans.push({
        id: `role:${roleId || team}`,
        kind: 'player_role',
        message: `Role ${roleId || team} is on removed team ${team}.`,
        choices: ['move_to_retired', 'reassign'],
        role_id: roleId,
        team_name: team,
      });
      continue;
    }
    if (working.nameMap.has(team)) role.team_name = working.nameMap.get(team);
  }
  return { value: roles };
}

function planBenchmarks(working: Working, state: Record<string, unknown>): { value: unknown } {
  if (!Array.isArray(state.strategic_benchmarks)) return { value: state.strategic_benchmarks };
  const next = [];
  for (const raw of state.strategic_benchmarks) {
    const row = asRecord(raw);
    if (!row) {
      next.push(raw);
      continue;
    }
    const copy = structuredClone(row);
    const team = textOf(copy.team);
    if (team && working.removedTeamNames.has(team)) continue;
    if (team && working.nameMap.has(team)) {
      const renamed = working.nameMap.get(team) ?? team;
      copy.team = renamed;
      for (const field of [
        'description',
        'consequence_if_done',
        'consequence_if_missed',
      ] as const) {
        if (typeof copy[field] === 'string')
          copy[field] = substituteNames(copy[field] as string, working.renames);
      }
    }
    next.push(copy);
  }
  return { value: next };
}

function planCharters(working: Working, state: Record<string, unknown>): { value: unknown } {
  if (!Array.isArray(state.team_charters)) return { value: state.team_charters };
  const next = [];
  for (const raw of state.team_charters) {
    const row = asRecord(raw);
    if (!row) {
      next.push(raw);
      continue;
    }
    const copy = structuredClone(row);
    const name = textOf(copy.team_name);
    if (name && working.removedTeamNames.has(name)) continue;
    if (name && working.nameMap.has(name)) copy.team_name = working.nameMap.get(name);
    if (working.swap && (copy.org_key == null || typeof copy.org_key === 'string')) {
      const current = textOf(copy.org_key);
      copy.org_key = current ? working.mapKey(current) : working.swap.plan.old_primary_new_key;
    }
    next.push(copy);
  }
  return { value: next };
}

function planDependencies(working: Working, state: Record<string, unknown>): { value: unknown } {
  const doc = asRecord(state.team_dependencies);
  if (!doc || !Array.isArray(doc.edges)) return { value: state.team_dependencies };
  const copy = structuredClone(doc);
  copy.edges = (copy.edges as unknown[]).map((raw) => rewriteEdge(raw, working));
  return { value: copy };
}

function rewriteEdge(raw: unknown, working: Working): unknown {
  const edge = asRecord(raw);
  if (!edge) return raw;
  const copy = structuredClone(edge);
  copy.upstream = rewriteTeamRef(copy.upstream, working);
  if (Array.isArray(copy.downstream)) {
    copy.downstream = copy.downstream.map((ref) => rewriteTeamRef(ref, working));
  }
  if (working.slugMap.size > 0) {
    if (copy.broken_when)
      copy.broken_when = mapConditionContainer(copy.broken_when, (key) =>
        rewriteConditionKey(key, working),
      );
    if (copy.met_when)
      copy.met_when = mapConditionContainer(copy.met_when, (key) =>
        rewriteConditionKey(key, working),
      );
  }
  const id = textOf(copy.id) || 'edge';
  if (edgeReferencesRemoved(copy, working)) {
    working.orphans.push({
      id: `dependency:${id}`,
      kind: 'team_dependency',
      message: `Team dependency ${id} references a team that is being removed.`,
      choices: ['remove', 'retarget'],
      dependency_id: id,
    });
  }
  const retired = retiredInjectKeys(working);
  const keys = [
    ...stringList(copy.consequence_keys),
    ...(asRecord(copy.due)?.after_inject_key ? [textOf(asRecord(copy.due)?.after_inject_key)] : []),
  ];
  for (const key of keys) {
    if (!key || !retired.has(key)) continue;
    working.orphans.push({
      id: `dependency:${id}:inject:${key}`,
      kind: 'team_dependency',
      message: `Team dependency ${id} references retired inject ${key}.`,
      choices: ['keep', 'clear', 'retarget'],
      dependency_id: id,
      target_key: key,
    });
  }
  return copy;
}

function rewriteTeamRef(value: unknown, working: Working): unknown {
  const ref = asRecord(value);
  if (!ref) return value;
  const copy = { ...ref };
  const uid = textOf(copy.team_uid);
  const name = textOf(copy.team_name);
  if (uid && working.uidName.has(uid)) copy.team_name = working.uidName.get(uid);
  else if (name && working.nameMap.has(name) && !working.removedTeamNames.has(name)) {
    copy.team_name = working.nameMap.get(name);
  }
  return copy;
}

function edgeReferencesRemoved(edge: Record<string, unknown>, working: Working): boolean {
  const refs = [edge.upstream, ...(Array.isArray(edge.downstream) ? edge.downstream : [])];
  return refs.some((raw) => {
    const ref = asRecord(raw);
    if (!ref) return false;
    const uid = textOf(ref.team_uid);
    const name = textOf(ref.team_name);
    return (
      (uid !== '' && working.removedTeamUids.has(uid)) ||
      (name !== '' && working.removedTeamNames.has(name))
    );
  });
}

function planPersonas(working: Working, state: Record<string, unknown>): { value: unknown } {
  if (!Array.isArray(state.personas)) return { value: state.personas };
  const human = humanCountries(working);
  let changed = false;
  const next = state.personas.map((raw) => {
    const persona = asRecord(raw);
    if (!persona) return raw;
    const country = textOf(persona.country);
    if (!country || human.has(country)) return raw;
    changed = true;
    const copy = structuredClone(persona);
    delete copy.country;
    const backstory = typeof copy.backstory === 'string' ? copy.backstory : '';
    copy.backstory = /Based in /.test(backstory)
      ? backstory
      : `${backstory} (Based in ${country}.)`.trim();
    return copy;
  });
  return { value: changed ? next : state.personas };
}

function humanCountries(working: Working): Set<string> {
  const countries = new Set<string>();
  for (const org of working.input.edited.organisations) {
    if (org.operation === 'ai') continue;
    if (org.country.trim()) countries.add(org.country.trim());
  }
  return countries;
}

function planCountries(
  working: Working,
  state: Record<string, unknown>,
  orgs: unknown,
  retired: RetiredEntry[],
): { value: unknown } {
  if (!Array.isArray(state.countries)) return { value: state.countries };
  const live = new Set<string>();
  for (const org of objectList(orgs)) {
    const country = textOf(org.country);
    if (country) live.add(country);
  }
  for (const org of working.input.edited.pressure_organisations) {
    if (working.removedPressure.has(org.org_key)) continue;
    if (org.country.trim()) live.add(org.country.trim());
  }
  for (const org of working.input.edited.competitors) {
    if (working.removedRivals.has(org.org_key)) continue;
    if (org.country.trim()) live.add(org.country.trim());
  }
  const next = [];
  for (const raw of state.countries) {
    const row = asRecord(raw);
    const name = textOf(row?.name) || (typeof raw === 'string' ? raw : '');
    if (row && name && !live.has(name)) {
      retired.push({ bucket: 'countries', key: name, value: structuredClone(row) });
      continue;
    }
    next.push(raw);
  }
  const present = new Set(next.map((raw) => textOf(asRecord(raw)?.name)));
  for (const name of [...live].sort()) {
    if (present.has(name)) continue;
    next.push({ name, code: countryCode(name).toUpperCase() });
  }
  return { value: next };
}

function planKeyedTree(value: unknown, working: Working): { value: unknown } {
  if (!working.swap || value == null) return { value };
  return { value: rewriteTreeOrgKeys(value, working.mapKey) };
}

function rewriteTreeOrgKeys(value: unknown, mapKey: (key: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteTreeOrgKeys(item, mapKey));
  if (!value || typeof value !== 'object') return value;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'org_key' && typeof item === 'string') copy[key] = mapKey(item);
    else if (key === 'targets_org_keys' && Array.isArray(item)) {
      copy[key] = item.map((entry) => (typeof entry === 'string' ? mapKey(entry) : entry));
    } else copy[key] = rewriteTreeOrgKeys(item, mapKey);
  }
  return copy;
}

function planHistory(working: Working, state: Record<string, unknown>): { value: unknown } {
  if (!working.swap) return { value: state.org_key_history };
  const rows = objectList(state.org_key_history).map((row) => structuredClone(row));
  const swap = working.swap.plan;
  closeHistory(rows, swap.from_org_uid, swap.old_primary_key);
  if (swap.new_primary_previous_key)
    closeHistory(rows, swap.to_org_uid, swap.new_primary_previous_key);
  openHistory(rows, swap.from_org_uid, swap.old_primary_new_key);
  openHistory(rows, swap.to_org_uid, 'primary');
  return { value: rows };
}

function closeHistory(rows: Record<string, unknown>[], uid: string, key: string): void {
  for (const row of rows) {
    if (textOf(row.org_uid) === uid && textOf(row.org_key) === key && row.until_edit == null) {
      row.until_edit = EDIT_TOKEN;
    }
  }
}

function openHistory(rows: Record<string, unknown>[], uid: string, key: string): void {
  const open = rows.some(
    (row) => textOf(row.org_uid) === uid && textOf(row.org_key) === key && row.until_edit == null,
  );
  if (open) return;
  rows.push({ org_uid: uid, org_key: key, from_edit: EDIT_TOKEN, until_edit: null });
}

function planScenarioCountry(working: Working, state: Record<string, unknown>): { value: unknown } {
  if (!working.swap?.newOrg) return { value: state.country };
  return { value: working.swap.newOrg.country };
}

function planScenarioName(working: Working, state: Record<string, unknown>): { value: unknown } {
  if (!working.swap?.newOrg) return { value: state.org_name };
  return { value: working.swap.newOrg.display_name };
}

function planSessions(working: Working): ScheduledSessionPlan[] {
  const reseed = needsPageReseed(working);
  const plans: ScheduledSessionPlan[] = [];
  for (const session of working.input.sessions) {
    if (!isScheduled(session)) continue;
    const plan = sessionPlan(session, working, reseed);
    if (plan) plans.push(plan);
  }
  plans.sort((a, b) => a.session_id.localeCompare(b.session_id));
  return plans;
}

function isScheduled(session: LobbySession): boolean {
  if (session.start_time) return false;
  return session.status === 'scheduled';
}

function needsPageReseed(working: Working): boolean {
  return (
    working.swap != null ||
    working.removedOrgKeys.size > 0 ||
    working.removedPressure.size > 0 ||
    working.removedRivals.size > 0 ||
    working.input.delta.renamed_orgs.length > 0 ||
    working.input.delta.relocated_orgs.length > 0
  );
}

function sessionPlan(
  session: LobbySession,
  working: Working,
  reseed: boolean,
): ScheduledSessionPlan | null {
  const teamNames = working.renames
    .filter((rename) => sessionHasTeam(session, rename.from))
    .map((rename) => ({ from: rename.from, to: rename.to }));
  const channels = teamNames.filter((rename) =>
    session.channels.some((channel) => channel.team_name === rename.from),
  );
  const callLines: CallLineMove[] = session.call_lines
    .filter((line) => working.nameMap.has(line.team_name))
    .map((line) => ({
      from_team: line.team_name,
      to_team: working.nameMap.get(line.team_name) ?? line.team_name,
      steps: CALL_LINE_STEPS,
    }));
  const removeTeams = [
    ...new Set(
      session.teams
        .map((row) => row.team_name)
        .filter((name) => working.removedTeamNames.has(name)),
    ),
  ].sort();
  const deleteCallLines = [
    ...new Set(
      session.call_lines
        .map((line) => line.team_name)
        .filter((name) => working.removedTeamNames.has(name)),
    ),
  ].sort();
  const deleteChannels = [
    ...new Set(
      session.channels
        .filter(
          (channel) =>
            channel.team_name &&
            working.removedTeamNames.has(channel.team_name) &&
            channel.message_count === 0,
        )
        .map((channel) => channel.team_name as string),
    ),
  ].sort();
  const retiredRoles = retiredRoleIds(working);
  const retireRoles = [
    ...new Set(
      session.role_assignments.map((row) => row.role_id).filter((id) => retiredRoles.has(id)),
    ),
  ].sort();
  const unassigned = session.teams
    .filter((row) => working.removedTeamNames.has(row.team_name))
    .map((row) => ({ user_id: row.user_id, team_name: row.team_name }))
    .sort((a, b) => a.user_id.localeCompare(b.user_id) || a.team_name.localeCompare(b.team_name));
  const presentOrgKeys = new Set<string>();
  for (const row of session.page_controllers) presentOrgKeys.add(row.org_key);
  for (const row of session.org_pages ?? []) presentOrgKeys.add(row.org_key);
  const removeOrgKeys = [...presentOrgKeys]
    .filter(
      (key) =>
        working.removedOrgKeys.has(working.mapKey(key)) ||
        working.removedRivals.has(key) ||
        working.removedPressure.has(key),
    )
    .map((key) => working.mapKey(key))
    .sort();
  const uniqueRemoveOrg = [...new Set(removeOrgKeys)];
  const remapControllers = session.page_controllers
    .map((row) => ({ from: row.org_key, to: working.mapKey(row.org_key), user_id: row.user_id }))
    .filter((row) => row.from !== row.to)
    .sort((a, b) => a.user_id.localeCompare(b.user_id) || a.from.localeCompare(b.from));
  const touched =
    teamNames.length > 0 ||
    callLines.length > 0 ||
    removeTeams.length > 0 ||
    deleteCallLines.length > 0 ||
    deleteChannels.length > 0 ||
    retireRoles.length > 0 ||
    uniqueRemoveOrg.length > 0 ||
    remapControllers.length > 0 ||
    (reseed &&
      (working.swap != null || uniqueRemoveOrg.length > 0 || (session.org_pages?.length ?? 0) > 0));
  if (!touched && !reseed) return null;
  if (
    !touched &&
    reseed &&
    !sessionHasPages(session) &&
    remapControllers.length === 0 &&
    working.swap == null
  ) {
    return null;
  }
  const doReseed =
    reseed &&
    (working.swap != null ||
      uniqueRemoveOrg.length > 0 ||
      sessionHasPages(session) ||
      working.input.delta.renamed_orgs.length > 0);
  return {
    session_id: session.session_id,
    rename: { team_names: teamNames, channels, call_lines: callLines },
    remove_teams: removeTeams,
    delete_call_lines: deleteCallLines,
    delete_channels: deleteChannels,
    remove_org_keys: uniqueRemoveOrg,
    retire_roles: retireRoles,
    reassign_roles: [],
    unassigned_players: unassigned,
    remap_page_controllers: remapControllers,
    delete_sim_org_pages: doReseed,
    reseed_org_pages: doReseed,
  };
}

function sessionHasTeam(session: LobbySession, name: string): boolean {
  return (
    session.teams.some((row) => row.team_name === name) ||
    session.channels.some((row) => row.team_name === name) ||
    session.call_lines.some((row) => row.team_name === name)
  );
}

function sessionHasPages(session: LobbySession): boolean {
  return (session.org_pages?.length ?? 0) > 0 || session.page_controllers.length > 0;
}

function phasesOf(
  working: Working,
  teams: RemapPlan['teams'],
  injects: RemapPlan['injects'],
  state: RemapPlan['initial_state'],
): RemapPlan['phases'] {
  const phases: RemapPlan['phases'] = [];
  if (working.swap) phases.push('swap');
  if (
    working.renames.length > 0 ||
    working.input.delta.renamed_orgs.length > 0 ||
    working.input.delta.relocated_orgs.length > 0
  ) {
    phases.push('rename');
  }
  if (
    teams.retire.length > 0 ||
    injects.retire.length > 0 ||
    working.removedOrgKeys.size > 0 ||
    working.removedPressure.size > 0 ||
    working.removedRivals.size > 0 ||
    state.move_to_retired.length > 0
  ) {
    phases.push('remove');
  }
  if (
    working.input.delta.added_orgs.length > 0 ||
    working.input.delta.added_teams.length > 0 ||
    working.input.delta.added_pressure.length > 0 ||
    working.input.delta.added_rivals.length > 0 ||
    working.swap?.plan.to_is_new
  ) {
    phases.push('add');
  }
  return phases;
}

function sortOrphans(orphans: Orphan[]): void {
  orphans.sort((a, b) => a.id.localeCompare(b.id));
}

function sortWarnings(warnings: Warning[]): void {
  warnings.sort(
    (a, b) =>
      a.code.localeCompare(b.code) ||
      (a.inject_id ?? '').localeCompare(b.inject_id ?? '') ||
      a.message.localeCompare(b.message),
  );
}

function conditionKeysOf(appear: unknown, cancel: unknown): string[] {
  const keys: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) keys.push(value.trim());
  };
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) push(item);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    for (const field of ['all', 'any', 'conditions'] as const) {
      if (Array.isArray(record[field])) for (const item of record[field] as unknown[]) push(item);
    }
  };
  walk(appear);
  walk(cancel);
  return keys;
}

function substituteNames(text: string, renames: Array<{ from: string; to: string }>): string {
  const pairs = renames.filter((pair) => pair.from && pair.from !== pair.to);
  if (!text || pairs.length === 0) return text;
  const ordered = [...pairs].sort((a, b) => b.from.length - a.from.length);
  const pattern = ordered.map((pair) => escapeRegExp(pair.from)).join('|');
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`, 'giu');
  return text.replace(re, (match) => {
    const pair = ordered.find((item) => item.from.toLowerCase() === match.toLowerCase());
    return pair ? preserveCase(match, pair.to) : match;
  });
}

function mentionsName(text: string, name: string): boolean {
  if (!text || !name) return false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, 'iu');
  return re.test(text);
}

function preserveCase(match: string, replacement: string): string {
  if (match === match.toUpperCase() && match !== match.toLowerCase())
    return replacement.toUpperCase();
  if (match === match.toLowerCase()) return replacement.toLowerCase();
  const words = match.split(/\s+/);
  const titled = words.every((word) => word.length === 0 || word[0] === word[0].toUpperCase());
  if (titled) {
    return replacement.replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
  }
  return replacement;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left ?? null) === canonicalJson(right ?? null);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function objectList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === 'object' && !Array.isArray(item),
  );
}

function pageOrgList(state: Record<string, unknown>): Record<string, unknown>[] {
  return objectList(asRecord(state.org_page)?.orgs);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isProtagonist(org: Record<string, unknown>): boolean {
  return !isPressure(org) && !isRival(org);
}

function isPressure(org: Record<string, unknown>): boolean {
  return (
    org.side === 'pressure' ||
    org.role === 'pressure' ||
    textOf(org.org_key).startsWith('org_pressure_')
  );
}

function isRival(org: Record<string, unknown>): boolean {
  return (
    org.side === 'antagonist' ||
    org.role === 'antagonist' ||
    textOf(org.org_key).startsWith('org_antagonist_')
  );
}

function cloneJson<T>(value: T): T {
  if (value == null) return value;
  return structuredClone(value);
}
