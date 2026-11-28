/**
 * Pure response-branch post-processing (WP8 §8.2.4 and §8.3).
 * Fills a missing cancel, coerces an unknown app back to the parent's app,
 * and counts conditional coverage. No database and no network.
 */

import { logger } from '../../lib/logger.js';
import { allocateInjectKey, isValidInjectKey } from '../../lib/injectKey.js';
import {
  deriveGenericRubric,
  readAuthoredRubric,
  type ResponseRubric,
} from '../judging/judgeCore.js';
import { collectConditionKeys, parseConditionKey } from '../conditions/conditionCatalog.js';
import { formatConditionKey } from '../../../shared/conditionKeyGrammar.js';

export const DELIVERY_APPS = [
  'social_feed',
  'email',
  'group_chat',
  'phone_call',
  'news',
  'messenger_dm',
  'npc_dm',
] as const;

export type DeliveryApp = (typeof DELIVERY_APPS)[number];

export const BRANCH_KINDS = ['no_reply', 'poor_reply', 'good_reply', 'risky_admission'] as const;
export type BranchKind = (typeof BRANCH_KINDS)[number];

const PARENT_APPS = new Set<DeliveryApp>(['email', 'phone_call', 'messenger_dm', 'npc_dm']);

export interface BranchInject {
  trigger_time_minutes?: number | null;
  trigger_condition?: string | null;
  type?: string;
  title?: string;
  content?: string;
  severity?: string;
  inject_scope?: string;
  target_teams?: string[];
  requires_response?: boolean;
  response_deadline_minutes?: number | null;
  conditions_to_appear?: { all?: string[]; conditions?: string[]; threshold?: number } | null;
  conditions_to_cancel?: string[] | null;
  eligible_after_minutes?: number | null;
  delivery_config?: Record<string, unknown> | null;
}

export interface BranchParent {
  inject_key: string;
  title: string;
  app: DeliveryApp;
  content: string;
  window_minutes: number;
  target_teams: string[];
  stakeholder_id?: string;
  relationship?: string;
}

export interface BranchRubricUpdate {
  inject_key: string;
  rubric: ResponseRubric;
}

export interface ProcessedBranches {
  branches: BranchInject[];
  rubrics: BranchRubricUpdate[];
}

export interface CoverageReport {
  by_platform: Record<string, number>;
  gaps: string[];
  chained_roots: number;
  redialing_calls: number;
  stakeholders_with_ladder: number;
  gave_up_consequences: number;
  dependency_edges: number;
  cross_team_consequences: number;
  teams_without_dependency: string[];
}

export interface DependencyCoverage {
  edges: readonly {
    upstream: { team_name: string };
    downstream: readonly { team_name: string }[];
  }[];
  teams: readonly string[];
}

export function isDeliveryApp(value: unknown): value is DeliveryApp {
  return typeof value === 'string' && (DELIVERY_APPS as readonly string[]).includes(value);
}

export function clampWindow(minutes: number, durationMinutes: number): number {
  const cap = Math.min(240, Math.max(1, Math.floor(durationMinutes > 0 ? durationMinutes : 240)));
  if (!Number.isFinite(minutes)) return Math.min(15, cap);
  return Math.min(cap, Math.max(1, Math.floor(minutes)));
}

export function selectBranchParents(
  injects: readonly BranchInject[],
  durationMinutes: number,
): BranchParent[] {
  const parents: BranchParent[] = [];
  for (const inject of injects) {
    const config = inject.delivery_config ?? {};
    if (typeof config.branch === 'string' && config.branch) continue;
    if (!isDeliveryApp(config.app) || !PARENT_APPS.has(config.app)) continue;
    const stakeholderId = text(config.stakeholder_id);
    if (inject.requires_response !== true && !stakeholderId) continue;
    const key = text(config.inject_key);
    if (!key || !isValidInjectKey(key)) continue;
    const window = clampWindow(
      numberFrom(config.response_window_minutes, numberFrom(inject.response_deadline_minutes, 15)),
      durationMinutes,
    );
    parents.push({
      inject_key: key,
      title: inject.title?.trim() || key,
      app: config.app,
      content: inject.content?.trim() || '',
      window_minutes: window,
      target_teams: Array.isArray(inject.target_teams)
        ? inject.target_teams.filter((team) => typeof team === 'string')
        : [],
      ...(stakeholderId ? { stakeholder_id: stakeholderId } : {}),
    });
  }
  return parents;
}

export function postProcessResponseBranches(
  model: { branches?: unknown; rubrics?: unknown },
  parents: readonly BranchParent[],
  durationMinutes: number,
  taken: ReadonlySet<string> = new Set(parents.map((parent) => parent.inject_key)),
  roster: readonly string[] = [],
): ProcessedBranches {
  const byKey = new Map(parents.map((parent) => [parent.inject_key, parent]));
  const rubrics = rubricsForParents(model.rubrics, parents);
  const rubricByKey = new Map(rubrics.map((row) => [row.inject_key, row.rubric]));
  const reserved = new Set(taken);
  const rawBranches = Array.isArray(model.branches) ? model.branches : [];
  const drafted: Array<{ branch: BranchInject; parent: BranchParent; kind: BranchKind }> = [];

  for (const raw of rawBranches) {
    const row = record(raw);
    if (!row) continue;
    const parent = byKey.get(text(row.parent_inject_key) ?? '');
    if (!parent) continue;
    const perParent = drafted.filter((item) => item.parent.inject_key === parent.inject_key).length;
    if (perParent >= 8) continue;
    const content = text(row.content);
    if (!content) continue;
    const kind = kindOf(row.branch, row);
    const app = coerceApp(configOf(row).app, parent.app);
    const title = text(row.title) || `${parent.title} (${kind})`;
    const injectKey = allocateKey(text(configOf(row).inject_key), title, reserved);
    const appear = appearKeys(row.conditions_to_appear);
    const cancelProvided = row.conditions_to_cancel != null;
    const cancel = cancelProvided ? stringList(row.conditions_to_cancel) : null;
    drafted.push({
      parent,
      kind,
      branch: {
        title,
        content,
        type: typeForApp(app),
        severity: text(row.severity) || 'high',
        inject_scope: scopeOf(row.inject_scope, parent),
        target_teams: teamsOf(row.target_teams, parent, roster),
        requires_response: false,
        conditions_to_appear: { all: appear },
        conditions_to_cancel: cancel ?? undefined,
        eligible_after_minutes: clampEligible(row.eligible_after_minutes, durationMinutes),
        delivery_config: {
          ...configOf(row),
          app,
          inject_key: injectKey,
          branch: kind,
          parent_inject_key: parent.inject_key,
          parent_title: parent.title,
          parent_app: parent.app,
          parent_target_teams: parent.target_teams,
          ...(parent.stakeholder_id ? { stakeholder_id: stakeholderOf(configOf(row), parent) } : {}),
          parent_response_rubric: rubricByKey.get(parent.inject_key),
        },
      },
    });
  }

  const known = new Set<string>([
    ...parents.map((parent) => parent.inject_key),
    ...drafted.map((item) => text(item.branch.delivery_config?.inject_key) || ''),
  ]);
  const branches = drafted
    .map((item) => finishConditions(item, known, durationMinutes))
    .filter((branch) => {
      if (branch.delivery_config?.app !== 'npc_dm') return true;
      if (text(branch.delivery_config.stakeholder_id)) return true;
      logger.warn(
        { event: 'conditional_branch_dropped_no_stakeholder', title: branch.title },
        'Dropping generated npc_dm branch with no stakeholder',
      );
      return false;
    });
  return { branches, rubrics };
}

export function coverageReport(
  injects: readonly BranchInject[],
  stakeholders: readonly { mood_ladder?: unknown }[] = [],
  dependencies?: DependencyCoverage | null,
): CoverageReport {
  const used = new Set<string>();
  const conditional = new Map<string, number>();
  let chained_roots = 0;
  let redialing_calls = 0;
  let gave_up_consequences = 0;
  let cross_team_consequences = 0;
  for (const inject of injects) {
    const config = inject.delivery_config;
    const app = text(config?.app);
    if (app) {
      used.add(app);
      if (isConditionalInject(inject)) conditional.set(app, (conditional.get(app) ?? 0) + 1);
    }
    if (app === 'phone_call' && redialAttempts(config?.redial) > 1) redialing_calls += 1;
    const escalation = config?.escalation;
    if (escalation && typeof escalation === 'object' && !Array.isArray(escalation)) {
      const steps = (escalation as { steps?: unknown }).steps;
      if (Array.isArray(steps) && steps.length > 0 && !config?.branch) chained_roots += 1;
      if (Array.isArray(steps)) {
        for (const step of steps) {
          if (!step || typeof step !== 'object') continue;
          const row = step as { app?: unknown; redial?: unknown };
          if (row.app === 'phone_call' && redialAttempts(row.redial) > 1) redialing_calls += 1;
        }
      }
    }
    const appear = [
      ...(inject.conditions_to_appear?.all ?? []),
      ...(inject.conditions_to_appear?.conditions ?? []),
    ];
    if (appear.some((key) => (key.split('|')[0] ?? '').startsWith('stakeholder_gave_up:'))) {
      gave_up_consequences += 1;
    }
    if (appear.some((key) => isDependencyBreakKey(key))) {
      cross_team_consequences += 1;
    }
  }
  const by_platform: Record<string, number> = {};
  for (const app of used) by_platform[app] = conditional.get(app) ?? 0;
  const gaps = [...used].filter((app) => by_platform[app] === 0);
  const stakeholders_with_ladder = stakeholders.filter((stakeholder) => stakeholder.mood_ladder != null).length;
  const dependency = dependencyCoverage(dependencies, cross_team_consequences);
  if (dependency.teams_without_dependency.length > 0) {
    logger.warn(
      {
        event: 'dependency_team_without_edge',
        teams: dependency.teams_without_dependency,
      },
      'A playable team is not in any dependency',
    );
  }
  return {
    by_platform,
    gaps,
    chained_roots,
    redialing_calls,
    stakeholders_with_ladder,
    gave_up_consequences,
    ...dependency,
  };
}

function isDependencyBreakKey(key: string): boolean {
  const parsed = parseConditionKey(key);
  if ('error' in parsed) return false;
  return parsed.def.id === 'dependency_broken' || parsed.def.id === 'dependency_broken_for';
}

function dependencyCoverage(
  input: DependencyCoverage | null | undefined,
  cross_team_consequences: number,
): {
  dependency_edges: number;
  cross_team_consequences: number;
  teams_without_dependency: string[];
} {
  if (!input) {
    return { dependency_edges: 0, cross_team_consequences, teams_without_dependency: [] };
  }
  const covered = new Set<string>();
  for (const edge of input.edges) {
    covered.add(edge.upstream.team_name);
    for (const team of edge.downstream) covered.add(team.team_name);
  }
  const teams = [...new Set(input.teams.filter((team) => team && team !== 'Shared'))];
  return {
    dependency_edges: input.edges.length,
    cross_team_consequences,
    teams_without_dependency: teams.length >= 2 ? teams.filter((team) => !covered.has(team)) : [],
  };
}

function redialAttempts(value: unknown): number {
  if (!value || typeof value !== 'object') return 1;
  const attempts = (value as { attempts?: unknown }).attempts;
  return typeof attempts === 'number' && Number.isFinite(attempts) ? attempts : 1;
}

export function parentAlreadyBranched(
  parent: BranchParent,
  injects: readonly BranchInject[],
): boolean {
  return injects.some((inject) => {
    const config = inject.delivery_config;
    if (!config || typeof config.branch !== 'string' || !config.branch) return false;
    if (config.parent_inject_key === parent.inject_key) return true;
    return config.parent_title === parent.title && config.parent_app === parent.app;
  });
}

export function bindParentKeys(injects: BranchInject[]): void {
  const byKey = new Map<string, BranchInject>();
  for (const inject of injects) {
    const key = text(inject.delivery_config?.inject_key);
    if (key) byKey.set(key, inject);
  }
  for (const branch of injects) {
    const config = branch.delivery_config;
    if (!config || typeof config.branch !== 'string' || !config.branch) continue;
    const wanted = text(config.parent_inject_key);
    if (!wanted) continue;
    const parent = findParent(injects, config, byKey);
    if (!parent) continue;
    const parentConfig = { ...(parent.delivery_config ?? {}) };
    const owner = byKey.get(wanted);
    if (!owner || owner === parent) {
      if (parentConfig.inject_key !== wanted) {
        if (text(parentConfig.inject_key)) byKey.delete(text(parentConfig.inject_key) as string);
        parentConfig.inject_key = wanted;
        byKey.set(wanted, parent);
      }
    } else if (text(parentConfig.inject_key) && text(parentConfig.inject_key) !== wanted) {
      retargetBranch(branch, wanted, text(parentConfig.inject_key) as string);
    }
    const carried = parentConfig.response_rubric ?? config.parent_response_rubric;
    if (carried && !readAuthoredRubric(parentConfig.response_rubric)) {
      parentConfig.response_rubric = config.parent_response_rubric ?? carried;
    }
    parent.delivery_config = parentConfig;
  }
}

export function stripBranchCarry(inject: BranchInject): void {
  const config = inject.delivery_config;
  if (!config) return;
  delete config.parent_title;
  delete config.parent_app;
  delete config.parent_target_teams;
  delete config.parent_response_rubric;
}

function finishConditions(
  item: { branch: BranchInject; parent: BranchParent; kind: BranchKind },
  known: ReadonlySet<string>,
  durationMinutes: number,
): BranchInject {
  const { branch, parent, kind } = item;
  const appear = (branch.conditions_to_appear?.all ?? [])
    .map((key) => clampConditionWindow(key, durationMinutes))
    .filter((key) => keepCondition(key, known));
  const appearKeysFinal = appear.length > 0 ? appear : [defaultAppear(kind, parent)];
  const cancelMissing = branch.conditions_to_cancel == null;
  const cancel = (branch.conditions_to_cancel ?? [])
    .map((key) => clampConditionWindow(key, durationMinutes))
    .filter((key) => keepCondition(key, known));
  branch.conditions_to_appear = { all: appearKeysFinal };
  branch.conditions_to_cancel = cancelMissing ? [defaultCancel(kind, parent)] : cancel;
  const config = branch.delivery_config ?? {};
  if (config.app === 'phone_call') repairGeneratedPhone(config);
  if (config.app === 'npc_dm' && parent.stakeholder_id && !text(config.stakeholder_id)) {
    config.stakeholder_id = parent.stakeholder_id;
  }
  delete config.escalation;
  delete config.mood_ladder;
  branch.delivery_config = config;
  return branch;
}

function rubricsForParents(raw: unknown, parents: readonly BranchParent[]): BranchRubricUpdate[] {
  const authored = new Map<string, ResponseRubric>();
  if (Array.isArray(raw)) {
    for (const row of raw) {
      const recordRow = record(row);
      if (!recordRow) continue;
      const key = text(recordRow.inject_key);
      if (!key || !parents.some((parent) => parent.inject_key === key)) continue;
      const rubric = normaliseRubric(recordRow, parents.find((parent) => parent.inject_key === key)!);
      if (rubric) authored.set(key, rubric);
    }
  }
  return parents.map((parent) => ({
    inject_key: parent.inject_key,
    rubric: authored.get(parent.inject_key) ?? genericRubric(parent),
  }));
}

function normaliseRubric(raw: Record<string, unknown>, parent: BranchParent): ResponseRubric | null {
  const authored = readAuthoredRubric(raw);
  if (!authored) return null;
  const generic = genericRubric(parent);
  const criteria = authored.criteria.slice(0, 4);
  for (const criterion of generic.criteria) {
    if (criteria.length >= 3) break;
    if (!criteria.includes(criterion)) criteria.push(criterion);
  }
  return {
    ...authored,
    criteria,
    pass_threshold: Math.min(authored.pass_threshold, criteria.length),
  };
}

function genericRubric(parent: BranchParent): ResponseRubric {
  return deriveGenericRubric(
    {
      content: parent.content,
      stakeholder: parent.relationship ? { relationship: parent.relationship } : null,
    },
    null,
  );
}

function defaultAppear(kind: BranchKind, parent: BranchParent): string {
  const key = parent.inject_key;
  const window = parent.window_minutes;
  if (kind === 'poor_reply') return `reply_failed:${key}`;
  if (kind === 'good_reply') return `reply_passed:${key}`;
  if (kind === 'risky_admission') return `reply_risky_admission:${key}`;
  if (parent.app === 'phone_call') return `call_missed:${key}`;
  if (parent.app === 'email') return `email_unreplied:${key}:${window}`;
  if (parent.app === 'messenger_dm' || parent.app === 'npc_dm') return `dm_unanswered:${key}:${window}`;
  return `unresponded:${key}:${window}`;
}

function defaultCancel(kind: BranchKind, parent: BranchParent): string {
  const key = parent.inject_key;
  if (kind === 'poor_reply' || kind === 'risky_admission') return `reply_best_passed:${key}`;
  if (kind === 'good_reply') return `reply_failed:${key}`;
  if (parent.app === 'phone_call') return `call_answered:${key}`;
  if (parent.app === 'email') return `email_replied:${key}`;
  return `responded:${key}`;
}

function coerceApp(raw: unknown, parentApp: DeliveryApp): DeliveryApp {
  return isDeliveryApp(raw) ? raw : parentApp;
}

function kindOf(raw: unknown, row: Record<string, unknown>): BranchKind {
  if (typeof raw === 'string' && (BRANCH_KINDS as readonly string[]).includes(raw)) {
    return raw as BranchKind;
  }
  const appear = appearKeys(row.conditions_to_appear).join(' ');
  if (appear.includes('reply_passed:')) return 'good_reply';
  if (appear.includes('reply_risky_admission:')) return 'risky_admission';
  if (appear.includes('reply_failed:') || appear.includes('reply_tone:')) return 'poor_reply';
  return 'no_reply';
}

function appearKeys(value: unknown): string[] {
  return collectConditionKeys(value, null);
}

function keepCondition(key: string, known: ReadonlySet<string>): boolean {
  const parsed = parseConditionKey(key);
  if ('error' in parsed) return false;
  const params = parsed.def.params ?? [];
  for (let i = 0; i < params.length; i++) {
    if (params[i].type === 'inject_key' && !known.has(parsed.args[i] ?? '')) return false;
  }
  return true;
}

function clampConditionWindow(key: string, durationMinutes: number): string {
  const parsed = parseConditionKey(key);
  if ('error' in parsed) return key;
  const cap = clampWindow(durationMinutes, durationMinutes);
  let changed = false;
  const args = parsed.args.map((arg, index) => {
    const param = parsed.def.params?.[index];
    if (param?.type !== 'minutes') return arg;
    const minutes = Number(arg);
    if (!Number.isFinite(minutes) || minutes <= cap) return arg;
    changed = true;
    return String(cap);
  });
  if (!changed) return key;
  return rebuildConditionKey(parsed, args);
}

function rebuildConditionKey(
  parsed: Exclude<ReturnType<typeof parseConditionKey>, { error: string }>,
  args: string[],
): string {
  const formatted = formatConditionKey(parsed.def, args, parsed.scope);
  if ('key' in formatted) return formatted.key;
  const body =
    parsed.def.kind === 'fixed' || args.length === 0
      ? parsed.def.id
      : `${parsed.def.id}:${args.join(':')}`;
  return body;
}

function clampEligible(value: unknown, durationMinutes: number): number {
  const cap = durationMinutes > 0 ? Math.floor(durationMinutes) : 240;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(cap, Math.floor(n));
}

function repairGeneratedPhone(config: Record<string, unknown>): void {
  if (config.ring_seconds != null) config.ring_seconds = clampLimit(config.ring_seconds, 10, 60);
  if (config.max_call_seconds != null) {
    config.max_call_seconds = clampLimit(config.max_call_seconds, 60, 900);
  }
  if (config.redial != null && typeof config.redial !== 'object') {
    delete config.redial;
  } else if (config.redial && typeof config.redial === 'object') {
    const redial = config.redial as Record<string, unknown>;
    if (redial.attempts != null) redial.attempts = clampLimit(redial.attempts, 1, 6);
    if (redial.interval_minutes != null) {
      redial.interval_minutes = clampLimit(redial.interval_minutes, 1, 30);
    }
  }
  if (config.call_script != null && typeof config.call_script !== 'object') delete config.call_script;
  clampCallScript(config);
}

function clampLimit(value: unknown, min: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function clampCallScript(config: Record<string, unknown>): void {
  const script = config.call_script;
  if (!script || typeof script !== 'object') return;
  const body = script as Record<string, unknown>;
  if (Array.isArray(body.beats)) body.beats = body.beats.slice(0, 6);
  const parts = [
    text(body.opening) ?? '',
    text(body.closing) ?? '',
    ...(Array.isArray(body.beats)
      ? body.beats.map((beat) => text(record(beat)?.say) ?? '')
      : []),
  ];
  if (parts.join('').length <= 2000) return;
  body.opening = (text(body.opening) ?? '').slice(0, 400);
  body.closing = (text(body.closing) ?? '').slice(0, 200);
  if (Array.isArray(body.beats)) {
    body.beats = body.beats.map((beat) => {
      const row = record(beat);
      if (!row || typeof row.say !== 'string') return beat;
      return { ...row, say: row.say.slice(0, 200) };
    });
  }
}

function allocateKey(requested: string | null, title: string, taken: Set<string>): string {
  return allocateInjectKey(requested, title, taken);
}

function findParent(
  injects: readonly BranchInject[],
  config: Record<string, unknown>,
  byKey: ReadonlyMap<string, BranchInject>,
): BranchInject | undefined {
  const wanted = text(config.parent_inject_key);
  const titled = injects.filter((inject) => {
    if (inject.delivery_config?.branch) return false;
    if (text(config.parent_title) && inject.title !== config.parent_title) return false;
    if (text(config.parent_app) && inject.delivery_config?.app !== config.parent_app) return false;
    return Boolean(text(config.parent_title));
  });
  const teams = Array.isArray(config.parent_target_teams) ? config.parent_target_teams.join('|') : '';
  const byTeam =
    teams.length > 0
      ? titled.find((inject) => (inject.target_teams ?? []).join('|') === teams)
      : undefined;
  if (byTeam) return byTeam;
  if (titled.length === 1) return titled[0];
  if (wanted && byKey.get(wanted) && !byKey.get(wanted)?.delivery_config?.branch) return byKey.get(wanted);
  return titled[0];
}

function retargetBranch(branch: BranchInject, from: string, to: string): void {
  const config = branch.delivery_config ?? {};
  config.parent_inject_key = to;
  branch.conditions_to_appear = mapAppear(branch.conditions_to_appear, from, to);
  if (Array.isArray(branch.conditions_to_cancel)) {
    branch.conditions_to_cancel = branch.conditions_to_cancel.map((key) => swapKey(key, from, to));
  }
  branch.delivery_config = config;
}

function mapAppear(value: BranchInject['conditions_to_appear'], from: string, to: string) {
  if (!value) return value;
  if (Array.isArray(value.all)) return { ...value, all: value.all.map((key) => swapKey(key, from, to)) };
  if (Array.isArray(value.conditions)) {
    return { ...value, conditions: value.conditions.map((key) => swapKey(key, from, to)) };
  }
  return value;
}

function swapKey(key: string, from: string, to: string): string {
  const parsed = parseConditionKey(key);
  if ('error' in parsed) return key;
  let changed = false;
  const args = parsed.args.map((arg, index) => {
    if (parsed.def.params?.[index]?.type === 'inject_key' && arg === from) {
      changed = true;
      return to;
    }
    return arg;
  });
  if (!changed) return key;
  return rebuildConditionKey(parsed, args);
}

export function typeForApp(app: DeliveryApp): string {
  if (app === 'email') return 'email_inbound';
  if (app === 'phone_call') return 'phone_call';
  if (app === 'group_chat') return 'chat_message';
  if (app === 'messenger_dm' || app === 'npc_dm') return 'dm';
  if (app === 'news') return 'news_article';
  return 'social_post';
}

function scopeOf(raw: unknown, parent: BranchParent): string {
  if (raw === 'team_specific' || raw === 'universal' || raw === 'role_specific') return raw;
  return parent.target_teams.length > 0 ? 'team_specific' : 'universal';
}

function teamsOf(raw: unknown, parent: BranchParent, roster: readonly string[] = []): string[] {
  const listed = Array.isArray(raw)
    ? raw.filter((team): team is string => typeof team === 'string' && team.trim() !== '')
    : null;
  if (!listed) return [...parent.target_teams];
  if (roster.length === 0) return listed;
  const known: string[] = [];
  const unknown: string[] = [];
  for (const name of listed) {
    const canonical = roster.find((team) => team === name) ?? roster.find((team) => team.toLowerCase() === name.toLowerCase());
    if (canonical && !known.includes(canonical)) known.push(canonical);
    else if (!canonical) unknown.push(name);
  }
  if (unknown.length === 0) return known;
  logger.warn(
    { event: 'branch_target_team_unknown', parent: parent.inject_key, targets: unknown },
    'Response branch target is not on the roster',
  );
  return known.length > 0 ? known : [...parent.target_teams];
}

function stakeholderOf(config: Record<string, unknown>, parent: BranchParent): string | undefined {
  return text(config.stakeholder_id) ?? parent.stakeholder_id;
}

function isConditionalInject(inject: BranchInject): boolean {
  if (inject.trigger_time_minutes != null) return false;
  if (text(inject.trigger_condition)) return false;
  return collectConditionKeys(inject.conditions_to_appear, null).length > 0;
}

function configOf(row: Record<string, unknown>): Record<string, unknown> {
  const config = row.delivery_config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  return { ...(config as Record<string, unknown>) };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberFrom(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}
