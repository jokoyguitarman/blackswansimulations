/**
 * Pure checks for generated conditional injects (WP8 §8.2.5).
 * Unknown keys are dropped. A response branch whose parent inject is missing is dropped.
 * Everything else is reported. No database and no network.
 */

import { logger } from '../../lib/logger.js';
import { phoneConfigError } from '../calls/callCore.js';
import { validateInjectTriggerShape } from './injectTriggerShape.js';
import {
  collectConditionKeys,
  parseConditionKey,
  retainKnownConditions,
  type ConditionDef,
  type ParsedCondition,
} from './conditionCatalog.js';

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
}): ConditionalInjectValidation<T> {
  const issues: ConditionalInjectIssue[] = [];
  const duration = scenario.duration_minutes;

  for (const inject of scenario.injects) dropUnknownKeys(inject);

  const withParents = dropOrphanBranches([...scenario.injects]);
  const apps = appByKey(withParents);

  withParents.forEach((inject, index) => {
    const path = injectPath(inject, index);
    reportShape(inject, path, issues);
    reportDanglingAndApps(inject, path, apps, issues);
    reportWindow(inject, path, duration, issues);
    reportPhone(inject, path, issues);
    reportNpcDm(inject, path, issues);
  });
  reportCycles(withParents, apps, issues);

  return { injects: [...withParents], issues };
}

function dropUnknownKeys(inject: ConditionalInjectInput): void {
  const retained = retainKnownConditions(inject.conditions_to_appear, inject.conditions_to_cancel);
  if (retained.dropped.length === 0) return;
  for (const key of retained.dropped) {
    logger.warn(
      { event: 'conditional_invalid_key_dropped', key, title: inject.title },
      'Dropping unknown condition key',
    );
  }
  inject.conditions_to_appear = retained.conditions_to_appear ?? undefined;
  inject.conditions_to_cancel = retained.conditions_to_cancel;
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
  for (const key of collectConditionKeys(inject.conditions_to_appear, inject.conditions_to_cancel)) {
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
  for (const key of collectConditionKeys(inject.conditions_to_appear, inject.conditions_to_cancel)) {
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

function reportCycles(
  injects: readonly ConditionalInjectInput[],
  apps: ReadonlyMap<string, string>,
  issues: ConditionalInjectIssue[],
): void {
  const graph = new Map<string, string[]>();
  for (const inject of injects) {
    const key = inject.delivery_config?.inject_key;
    if (typeof key !== 'string' || !key) continue;
    const edges = graph.get(key) ?? [];
    graph.set(key, edges);
    for (const condition of collectConditionKeys(inject.conditions_to_appear, null)) {
      const parsed = parseConditionKey(condition);
      if ('error' in parsed) continue;
      for (const ref of injectKeyArgs(parsed)) {
        if (ref === key || !apps.has(ref)) continue;
        if (!edges.includes(ref)) edges.push(ref);
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
