/**
 * Pure checks for generated conditional injects (WP8 §8.2.5).
 * Unknown keys are dropped. A response branch whose parent inject is missing is dropped.
 * Everything else is reported. No database and no network.
 */

import { logger } from '../../lib/logger.js';
import { env } from '../../env.js';
import { phoneConfigError } from '../calls/callCore.js';
import { validateEscalation } from '../escalation/escalationCore.js';
import { validateMoodLadder } from '../mood/moodCore.js';
import { validateInjectTriggerShape } from './injectTriggerShape.js';
import {
  collectConditionKeys,
  parseConditionKey,
  retainKnownConditions,
  slugifyTeamName,
  type ConditionDef,
  type ParsedCondition,
} from './conditionCatalog.js';
import { validateDependencies, type ActiveTeam } from '../dependencies/dependencyCore.js';
import type { TeamDependencyEdge } from '../../../shared/teamDependencies.js';

export interface ConditionalInjectIssue {
  code: string;
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ConditionalInjectInput {
  title?: string;
  trigger_time_minutes?: number | null;
  trigger_condition?: string | null;
  conditions_to_appear?: unknown;
  conditions_to_cancel?: string[] | null;
  eligible_after_minutes?: number | null;
  delivery_config?: Record<string, unknown> | null;
}

export interface ConditionalInjectValidation<T extends ConditionalInjectInput> {
  injects: T[];
  issues: ConditionalInjectIssue[];
}

const RESPONSE_APPS = [
  'email',
  'group_chat',
  'phone_call',
  'messenger_dm',
  'npc_dm',
  'social_feed',
] as const;

/** Condition id → delivery apps that can produce the event. */
const APP_FOR_CONDITION: Record<string, readonly string[]> = {
  email_opened: ['email'],
  email_unopened: ['email'],
  email_replied: ['email'],
  email_unreplied: ['email'],
  email_forwarded: ['email'],
  chat_replied: ['group_chat'],
  chat_unanswered: ['group_chat'],
  dm_replied: ['messenger_dm', 'npc_dm'],
  dm_unanswered: ['messenger_dm', 'npc_dm'],
  call_answered: ['phone_call'],
  call_missed: ['phone_call'],
  call_declined: ['phone_call'],
  call_missed_count: ['phone_call'],
  call_attempts_gte: ['phone_call'],
  call_answered_by_attempt: ['phone_call'],
  call_unreturned: ['phone_call'],
  call_answered_within: ['phone_call'],
  news_opened: ['news'],
};

const RESPONSE_CONDITION_IDS = new Set([
  'responded',
  'unresponded',
  'responded_within',
  'response_count_gte',
  'responded_by_bot_only',
  'reply_passed',
  'reply_failed',
  'reply_best_passed',
  'reply_criterion',
  'reply_missing_criterion',
  'reply_answered_ask',
  'reply_missed_ask',
  'reply_tone',
  'reply_tone_off',
  'reply_score_below',
  'reply_score_at_least',
  'reply_factual_error',
  'reply_risky_admission',
  'reply_irrelevant',
  'responded_relevant',
]);

export function validateConditionalInjects<T extends ConditionalInjectInput>(scenario: {
  duration_minutes?: number | null;
  injects: readonly T[];
  stakeholders?: readonly { id: string; mood_ladder?: unknown }[] | null;
  /** Active roster. When set, a `|team=` slug that matches nobody is MO-COND-011. */
  teams?: readonly ActiveTeam[] | null;
  /** `initial_state.team_dependencies`. Validated here, and used by the cycle check. */
  team_dependencies?: unknown;
}): ConditionalInjectValidation<T> {
  const issues: ConditionalInjectIssue[] = [];
  const duration = scenario.duration_minutes;

  const withKnownKeys: T[] = [];
  for (const inject of scenario.injects) {
    if (keepAfterUnknownKeys(inject)) withKnownKeys.push(inject);
  }

  const withParents = repairGeneratedBranches(dropOrphanBranches(withKnownKeys), issues);
  const apps = appByKey(withParents);

  withParents.forEach((inject, index) => {
    const path = injectPath(inject, index);
    reportShape(inject, path, issues);
    reportDanglingAndApps(inject, path, apps, issues);
    reportWindow(inject, path, duration, issues);
    reportPhone(inject, path, issues);
    reportNpcDm(inject, path, issues);
  });
  const dependencyEdges = reportDependencies(
    scenario.team_dependencies,
    scenario.teams,
    withParents,
    scenario.duration_minutes,
    issues,
  );
  reportUnknownTeamSlugs(withParents, scenario.teams, issues);
  reportCycles(withParents, apps, issues, dependencyEdges);
  reportChainsAndLadders(withParents, scenario.stakeholders, scenario.duration_minutes, issues);

  return { injects: [...withParents], issues };
}

function reportDependencies(
  document: unknown,
  teams: readonly ActiveTeam[] | null | undefined,
  injects: readonly ConditionalInjectInput[],
  duration: number | null | undefined,
  issues: ConditionalInjectIssue[],
): TeamDependencyEdge[] {
  if (document == null) return [];
  const read = document as { edges?: unknown };
  const edges = Array.isArray(read?.edges) ? read.edges : document;
  const refs = injects.flatMap((inject) => {
    const key = inject.delivery_config?.inject_key;
    if (typeof key !== 'string' || !key) return [];
    return [
      {
        inject_key: key,
        trigger_time_minutes: inject.trigger_time_minutes ?? null,
        conditional: inject.trigger_time_minutes == null,
        condition_keys: collectConditionKeys(
          inject.conditions_to_appear,
          inject.conditions_to_cancel,
        ),
      },
    ];
  });
  const durationArg = typeof duration === 'number' && Number.isFinite(duration) ? duration : null;
  const result = validateDependencies(edges, teams ?? [], refs, durationArg);
  for (const item of result.issues) {
    issues.push({
      code: item.code,
      path: item.path,
      message: item.message,
      severity: item.severity,
    });
  }
  return result.edges;
}

function reportUnknownTeamSlugs(
  injects: readonly ConditionalInjectInput[],
  teams: readonly ActiveTeam[] | null | undefined,
  issues: ConditionalInjectIssue[],
): void {
  if (!teams) return;
  const slugs = new Set(
    teams.map((team) => slugifyTeamName(team.team_name)).filter((slug) => slug),
  );
  injects.forEach((inject, index) => {
    const path = injectPath(inject, index);
    const seen = new Set<string>();
    for (const key of collectConditionKeys(
      inject.conditions_to_appear,
      inject.conditions_to_cancel,
    )) {
      if (seen.has(key)) continue;
      seen.add(key);
      const parsed = parseConditionKey(key);
      if ('error' in parsed || !parsed.scope?.team) continue;
      if (slugs.has(parsed.scope.team)) continue;
      issues.push({
        code: 'MO-COND-011',
        path,
        severity: 'error',
        message: `Condition ${key} names team "${parsed.scope.team}", which is not an active team`,
      });
    }
  });
}

function keepAfterUnknownKeys(inject: ConditionalInjectInput): boolean {
  const retained = retainKnownConditions(inject.conditions_to_appear, inject.conditions_to_cancel);
  if (retained.dropped.length === 0) return true;
  for (const key of retained.dropped) {
    logger.warn(
      { event: 'conditional_invalid_key_dropped', key, title: inject.title },
      'Dropping unknown condition key',
    );
  }
  const conditional =
    inject.trigger_time_minutes == null &&
    !(typeof inject.trigger_condition === 'string' && inject.trigger_condition.trim() !== '');
  if (retained.emptied && conditional) {
    logger.warn(
      { event: 'generated_inject_dropped_empty_conditions', title: inject.title },
      'Dropping generated inject whose conditions were all unknown',
    );
    return false;
  }
  inject.conditions_to_appear = retained.conditions_to_appear ?? undefined;
  inject.conditions_to_cancel = retained.conditions_to_cancel;
  return true;
}

function isGeneratedBranch(inject: ConditionalInjectInput): boolean {
  const branch = inject.delivery_config?.branch;
  return typeof branch === 'string' && branch.length > 0;
}

/**
 * A generated branch must not fail the compile. Repair a phone field that is
 * outside the call limits, and drop an npc_dm that still has no stakeholder.
 * Author-written injects keep the error path below.
 */
function repairGeneratedBranches<T extends ConditionalInjectInput>(
  rows: readonly T[],
  issues: ConditionalInjectIssue[],
): T[] {
  return rows.filter((inject) => {
    if (!isGeneratedBranch(inject)) return true;
    const config = inject.delivery_config;
    if (!config) return true;
    const path = injectPath(inject, 0);
    if (config.app === 'npc_dm') {
      const stakeholder = config.stakeholder_id;
      if (typeof stakeholder !== 'string' || !stakeholder.trim()) {
        logger.warn(
          { event: 'conditional_branch_dropped_no_stakeholder', title: inject.title },
          'Dropping generated npc_dm branch with no stakeholder',
        );
        issues.push({
          code: 'MO-COND-009',
          path,
          severity: 'warning',
          message: `Inject "${inject.title ?? ''}" is a generated npc_dm with no stakeholder_id and was dropped`,
        });
        return false;
      }
    }
    if (config.app === 'phone_call') {
      const before = phoneConfigError(config);
      if (before) {
        repairPhoneConfig(config);
        const after = phoneConfigError(config);
        if (after) {
          logger.warn(
            { event: 'conditional_branch_dropped_phone', title: inject.title, error: after },
            'Dropping generated phone branch that could not be repaired',
          );
          issues.push({
            code: 'MO-COND-008',
            path,
            severity: 'warning',
            message: `Inject "${inject.title ?? ''}" was dropped: ${after}`,
          });
          return false;
        }
        logger.warn(
          { event: 'conditional_branch_phone_repaired', title: inject.title, error: before },
          'Repaired a generated phone branch',
        );
        issues.push({
          code: 'MO-COND-008',
          path,
          severity: 'warning',
          message: `Inject "${inject.title ?? ''}": ${before} The generated branch was clamped.`,
        });
      }
    }
    return true;
  });
}

function repairPhoneConfig(config: Record<string, unknown>): void {
  if (config.ring_seconds != null) config.ring_seconds = clampLimit(config.ring_seconds, 10, 60);
  if (config.max_call_seconds != null) {
    config.max_call_seconds = clampLimit(config.max_call_seconds, 60, 900);
  }
  if (config.call_script != null && typeof config.call_script !== 'object') {
    delete config.call_script;
  } else if (config.call_script && typeof config.call_script === 'object') {
    const body = config.call_script as Record<string, unknown>;
    if (Array.isArray(body.beats)) body.beats = body.beats.slice(0, 6);
    const parts = scriptParts(body);
    if (parts.join('').length > 2000) {
      if (typeof body.opening === 'string') body.opening = body.opening.slice(0, 400);
      if (typeof body.closing === 'string') body.closing = body.closing.slice(0, 200);
      if (Array.isArray(body.beats)) {
        body.beats = body.beats.map((beat) => {
          if (
            !beat ||
            typeof beat !== 'object' ||
            typeof (beat as { say?: unknown }).say !== 'string'
          ) {
            return beat;
          }
          return {
            ...(beat as Record<string, unknown>),
            say: (beat as { say: string }).say.slice(0, 200),
          };
        });
      }
      if (Array.isArray(body.redial_openings)) {
        body.redial_openings = body.redial_openings.map((line) =>
          typeof line === 'string' ? line.slice(0, 200) : line,
        );
      }
    }
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
}

function scriptParts(body: Record<string, unknown>): string[] {
  const beats = Array.isArray(body.beats) ? body.beats : [];
  return [
    typeof body.opening === 'string' ? body.opening : '',
    typeof body.closing === 'string' ? body.closing : '',
    ...beats.map((beat) =>
      beat && typeof beat === 'object' && typeof (beat as { say?: unknown }).say === 'string'
        ? (beat as { say: string }).say
        : '',
    ),
    ...(Array.isArray(body.redial_openings)
      ? body.redial_openings.filter((line): line is string => typeof line === 'string')
      : []),
  ];
}

function clampLimit(value: unknown, min: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function dropOrphanBranches<T extends ConditionalInjectInput>(rows: T[]): T[] {
  let current = rows;
  let changed = true;
  while (changed) {
    changed = false;
    const keys = new Set(
      current
        .map((row) => row.delivery_config?.inject_key)
        .filter((key): key is string => typeof key === 'string' && key.length > 0),
    );
    current = current.filter((inject) => {
      const branch = inject.delivery_config?.branch;
      if (typeof branch !== 'string' || branch.length === 0) return true;
      const parent = inject.delivery_config?.parent_inject_key;
      if (typeof parent !== 'string' || parent.length === 0 || keys.has(parent)) return true;
      changed = true;
      logger.warn(
        {
          event: 'conditional_branch_dropped_missing_parent',
          title: inject.title,
          parent_inject_key: parent,
        },
        'Dropping response branch whose parent inject is missing',
      );
      return false;
    });
  }
  return current;
}

function appByKey(injects: readonly ConditionalInjectInput[]): Map<string, string> {
  const apps = new Map<string, string>();
  for (const inject of injects) {
    const key = inject.delivery_config?.inject_key;
    const app = inject.delivery_config?.app;
    if (typeof key === 'string' && key && typeof app === 'string' && app) apps.set(key, app);
  }
  return apps;
}

function injectPath(inject: ConditionalInjectInput, index: number): string {
  return `injects.${inject.title || index}`;
}

function reportShape(
  inject: ConditionalInjectInput,
  path: string,
  issues: ConditionalInjectIssue[],
): void {
  const shape = validateInjectTriggerShape(inject);
  if (shape === 'timed_with_conditions') {
    issues.push({
      code: 'MO-COND-005',
      path,
      severity: 'warning',
      message: `Inject "${inject.title ?? ''}" is both timed and conditional`,
    });
  } else if (shape === 'conditional_without_conditions') {
    issues.push({
      code: 'MO-COND-006',
      path,
      severity: 'warning',
      message: `Inject "${inject.title ?? ''}" is conditional but has no conditions`,
    });
  }
}

function reportDanglingAndApps(
  inject: ConditionalInjectInput,
  path: string,
  apps: ReadonlyMap<string, string>,
  issues: ConditionalInjectIssue[],
): void {
  const seen = new Set<string>();
  for (const key of collectConditionKeys(
    inject.conditions_to_appear,
    inject.conditions_to_cancel,
  )) {
    if (seen.has(key)) continue;
    seen.add(key);
    const parsed = parseConditionKey(key);
    if ('error' in parsed) continue;
    for (const ref of injectKeyArgs(parsed)) {
      const app = apps.get(ref);
      if (!app) {
        issues.push({
          code: 'MO-COND-002',
          path,
          severity: 'warning',
          message: `Condition ${key} references inject_key "${ref}", which is not in the scenario`,
        });
        continue;
      }
      const required = requiredApps(parsed.def);
      if (required && !required.includes(app)) {
        issues.push({
          code: 'MO-COND-004',
          path,
          severity: 'warning',
          message: `${parsed.def.id} on "${ref}" needs ${required.join(' or ')}, but that inject is ${app}`,
        });
      }
    }
  }
}

function injectKeyArgs(parsed: Exclude<ParsedCondition, { error: string }>): string[] {
  const params = parsed.def.params ?? [];
  const refs: string[] = [];
  params.forEach((param, index) => {
    if (param.type === 'inject_key' && parsed.args[index]) refs.push(parsed.args[index]);
  });
  return refs;
}

function requiredApps(def: ConditionDef): readonly string[] | null {
  if (APP_FOR_CONDITION[def.id]) return APP_FOR_CONDITION[def.id];
  if (RESPONSE_CONDITION_IDS.has(def.id)) return RESPONSE_APPS;
  return null;
}

function reportWindow(
  inject: ConditionalInjectInput,
  path: string,
  duration: number | null | undefined,
  issues: ConditionalInjectIssue[],
): void {
  if (duration == null || !Number.isFinite(duration) || duration <= 0) return;
  if (
    typeof inject.eligible_after_minutes === 'number' &&
    inject.eligible_after_minutes > duration
  ) {
    issues.push({
      code: 'MO-COND-007',
      path,
      severity: 'warning',
      message: `Inject "${inject.title ?? ''}" is eligible after ${inject.eligible_after_minutes} min, past the ${duration}-minute scenario`,
    });
  }
  for (const key of collectConditionKeys(
    inject.conditions_to_appear,
    inject.conditions_to_cancel,
  )) {
    const parsed = parseConditionKey(key);
    if ('error' in parsed) continue;
    (parsed.def.params ?? []).forEach((param, index) => {
      if (param.type !== 'minutes') return;
      const minutes = Number(parsed.args[index]);
      if (Number.isFinite(minutes) && minutes > duration) {
        issues.push({
          code: 'MO-COND-007',
          path,
          severity: 'warning',
          message: `Condition ${key} waits ${minutes} min, past the ${duration}-minute scenario`,
        });
      }
    });
  }
}

function reportPhone(
  inject: ConditionalInjectInput,
  path: string,
  issues: ConditionalInjectIssue[],
): void {
  if (inject.delivery_config?.app !== 'phone_call') return;
  const error = phoneConfigError(inject.delivery_config);
  if (!error) return;
  issues.push({
    code: 'MO-COND-008',
    path,
    severity: 'error',
    message: `Inject "${inject.title ?? ''}": ${error}`,
  });
}

function reportNpcDm(
  inject: ConditionalInjectInput,
  path: string,
  issues: ConditionalInjectIssue[],
): void {
  if (inject.delivery_config?.app !== 'npc_dm') return;
  const stakeholder = inject.delivery_config.stakeholder_id;
  if (typeof stakeholder === 'string' && stakeholder.trim()) return;
  issues.push({
    code: 'MO-COND-009',
    path,
    severity: 'error',
    message: `Inject "${inject.title ?? ''}" is an npc_dm and has no stakeholder_id`,
  });
}

function reportChainsAndLadders(
  injects: readonly ConditionalInjectInput[],
  stakeholders: readonly { id: string; mood_ladder?: unknown }[] | null | undefined,
  duration: number | null | undefined,
  issues: ConditionalInjectIssue[],
): void {
  const known = injects
    .map((inject) => {
      const key = inject.delivery_config?.inject_key;
      if (typeof key !== 'string' || !key) return null;
      return {
        key,
        trigger_time_minutes: inject.trigger_time_minutes ?? null,
        conditional: inject.trigger_time_minutes == null,
        condition_keys: collectConditionKeys(
          inject.conditions_to_appear,
          inject.conditions_to_cancel,
        ),
      };
    })
    .filter((row): row is NonNullable<typeof row> => row != null);
  const durationArg = typeof duration === 'number' && Number.isFinite(duration) ? duration : null;
  const listed = stakeholders ?? [];
  const stakeholderIds = stakeholders == null ? null : listed.map((stakeholder) => stakeholder.id);

  injects.forEach((inject, index) => {
    const path = injectPath(inject, index);
    const escalation = inject.delivery_config?.escalation;
    if (escalation != null) {
      const rootKey =
        typeof inject.delivery_config?.inject_key === 'string'
          ? inject.delivery_config.inject_key
          : null;
      for (const issue of validateEscalation({
        escalation,
        rootApp:
          typeof inject.delivery_config?.app === 'string' ? inject.delivery_config.app : null,
        rootStakeholderId:
          typeof inject.delivery_config?.stakeholder_id === 'string'
            ? inject.delivery_config.stakeholder_id
            : null,
        stakeholderIds,
        durationMinutes: durationArg,
        rootKey,
        rootTriggerMinute: inject.trigger_time_minutes ?? null,
        otherInjects: known.filter((row) => row.key !== rootKey),
      })) {
        issues.push({
          code: issue.level === 'error' ? 'MO-CHAIN-001' : 'MO-CHAIN-002',
          path,
          severity: issue.level,
          message: issue.message,
        });
      }
    }
    if (inject.delivery_config?.mood_ladder != null) {
      reportLadder(inject.delivery_config.mood_ladder, path, known, durationArg, issues);
    }
  });

  for (const stakeholder of listed) {
    if (stakeholder.mood_ladder == null) continue;
    reportLadder(
      stakeholder.mood_ladder,
      `stakeholders.${stakeholder.id}`,
      known,
      durationArg,
      issues,
    );
  }
}

function reportLadder(
  ladder: unknown,
  path: string,
  known: readonly { key: string; conditional: boolean }[],
  duration: number | null,
  issues: ConditionalInjectIssue[],
): void {
  for (const issue of validateMoodLadder({
    ladder,
    knownInjects: known.map((row) => ({ key: row.key, conditional: row.conditional })),
  })) {
    issues.push({
      code: 'MO-MOOD-001',
      path,
      severity: 'error',
      message: issue.message,
    });
  }
  const record =
    ladder && typeof ladder === 'object' ? (ladder as { gave_up_after_minutes?: unknown }) : null;
  const explicit = record?.gave_up_after_minutes;
  const effective =
    typeof explicit === 'number' && Number.isFinite(explicit)
      ? explicit
      : env.callbackWindowMinutes;
  if (duration != null && duration > 0 && effective >= duration) {
    issues.push({
      code: 'MO-MOOD-002',
      path,
      severity: 'warning',
      message:
        explicit == null
          ? `gave_up_after_minutes falls back to the ${env.callbackWindowMinutes}-minute call-back window, which is not shorter than the ${duration}-minute scenario, so this stakeholder can never give up`
          : `gave_up_after_minutes ${explicit} is not shorter than the ${duration}-minute scenario, so this stakeholder can never give up`,
    });
  }
}

function dependencyIdFromKey(key: string): string | null {
  const parsed = parseConditionKey(key);
  if ('error' in parsed || !parsed.def.id.startsWith('dependency_')) return null;
  return parsed.args[0] || null;
}

function brokenWhenKeys(edge: TeamDependencyEdge): string[] {
  return 'all' in edge.broken_when ? edge.broken_when.all : edge.broken_when.conditions;
}

function reportCycles(
  injects: readonly ConditionalInjectInput[],
  apps: ReadonlyMap<string, string>,
  issues: ConditionalInjectIssue[],
  dependencyEdges: readonly TeamDependencyEdge[] = [],
): void {
  const byDep = new Map(dependencyEdges.map((edge) => [edge.id, edge]));
  const graph = new Map<string, string[]>();
  for (const inject of injects) {
    const key = inject.delivery_config?.inject_key;
    if (typeof key !== 'string' || !key) continue;
    const edges = graph.get(key) ?? [];
    graph.set(key, edges);
    const link = (ref: string, allowSelf: boolean) => {
      if ((!allowSelf && ref === key) || !apps.has(ref) || edges.includes(ref)) return;
      edges.push(ref);
    };
    for (const condition of collectConditionKeys(inject.conditions_to_appear, null)) {
      const parsed = parseConditionKey(condition);
      if (!('error' in parsed)) {
        for (const ref of injectKeyArgs(parsed)) link(ref, false);
      }
      const depId = dependencyIdFromKey(condition);
      const dependency = depId ? byDep.get(depId) : undefined;
      if (!dependency) continue;
      for (const broken of brokenWhenKeys(dependency)) {
        const parsedBroken = parseConditionKey(broken, { allowPlaceholders: true });
        if ('error' in parsedBroken) continue;
        for (const ref of injectKeyArgs(parsedBroken)) link(ref, true);
      }
    }
  }

  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const seen = new Set<string>();
  const visit = (node: string) => {
    color.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const state = color.get(next) ?? 0;
      if (state === 0) visit(next);
      else if (state === 1) {
        const start = stack.indexOf(next);
        const cycle = start >= 0 ? stack.slice(start) : [next];
        const label = [...cycle, next].join(' → ');
        if (!seen.has(label)) {
          seen.add(label);
          issues.push({
            code: 'MO-COND-003',
            path: `injects.${next}`,
            severity: 'error',
            message: `Conditional injects cycle: ${label}`,
          });
        }
      }
    }
    stack.pop();
    color.set(node, 2);
  };
  for (const node of graph.keys()) {
    if ((color.get(node) ?? 0) === 0) visit(node);
  }
}
