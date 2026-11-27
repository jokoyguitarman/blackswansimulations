/**
 * Escalation-chain decisions, templates, urgency and authoring checks.
 * No database access. The service applies whatever this module returns.
 */

import { createHash } from 'node:crypto';
import { slugifyTeamName } from '../conditions/conditionCatalog.js';

export const URGENCIES = ['reminder', 'follow_up', 'urgent', 'final', 'escalated'] as const;
export type Urgency = (typeof URGENCIES)[number];

export const CHAIN_APPS = [
  'same',
  'email',
  'group_chat',
  'npc_dm',
  'messenger_dm',
  'phone_call',
  'social_feed',
] as const;
export type ChainApp = (typeof CHAIN_APPS)[number];

export const CONCRETE_CHAIN_APPS = [
  'email',
  'group_chat',
  'npc_dm',
  'messenger_dm',
  'phone_call',
  'social_feed',
] as const;
export type ConcreteChainApp = (typeof CONCRETE_CHAIN_APPS)[number];

export const STOP_ON = ['any_response', 'relevant_response', 'passed_response'] as const;
export type StopOn = (typeof STOP_ON)[number];

export const CHAIN_SCOPES = ['per_team', 'any_recipient'] as const;
export type ChainScope = (typeof CHAIN_SCOPES)[number];

const RESPONSE_STOPS = new Set([
  'response',
  'relevant_response',
  'passed_response',
  'contact_elsewhere',
]);

const UNJUDGED_GRACE_MINUTES = 2;

export interface ChainRedial {
  attempts: number;
  interval_minutes: number;
  voicemail_each?: boolean;
  stop_on_contact?: boolean;
}

export interface ChainStepSpec {
  after_minutes: number;
  urgency: Urgency;
  app: ChainApp;
  content_mode: 'template' | 'ai';
  template?: string;
  brief?: string;
  sender_stakeholder_id?: string;
  target_team?: string;
  cc_team?: string;
  redial?: ChainRedial;
}

export interface EscalationConfig {
  max_steps: number;
  scope: ChainScope;
  stop_on: StopOn;
  stop_on_contact: boolean;
  steps: ChainStepSpec[];
  on_exhausted?: { publish_inject_key?: string };
}

export interface ResolvedStep extends ChainStepSpec {
  stepNo: number;
  repeated: boolean;
  appResolved: ConcreteChainApp;
}

export interface UrgencyEffects {
  emailPriority: 'normal' | 'high' | 'urgent';
  emailSubjectPrefix: string;
  chatPrefix: string;
  notificationPriority: 'low' | 'medium' | 'high';
  ringSecondsExtra: number;
  viralityScore: number;
}

const EFFECTS: Record<Urgency, UrgencyEffects> = {
  reminder: {
    emailPriority: 'normal',
    emailSubjectPrefix: 'Reminder: ',
    chatPrefix: '',
    notificationPriority: 'low',
    ringSecondsExtra: 0,
    viralityScore: 60,
  },
  follow_up: {
    emailPriority: 'normal',
    emailSubjectPrefix: 'Following up: ',
    chatPrefix: '',
    notificationPriority: 'medium',
    ringSecondsExtra: 0,
    viralityScore: 64,
  },
  urgent: {
    emailPriority: 'high',
    emailSubjectPrefix: 'URGENT: ',
    chatPrefix: '‼️ ',
    notificationPriority: 'high',
    ringSecondsExtra: 10,
    viralityScore: 68,
  },
  final: {
    emailPriority: 'urgent',
    emailSubjectPrefix: 'FINAL REQUEST: ',
    chatPrefix: '‼️ FINAL: ',
    notificationPriority: 'high',
    ringSecondsExtra: 15,
    viralityScore: 72,
  },
  escalated: {
    emailPriority: 'urgent',
    emailSubjectPrefix: 'Escalation: ',
    chatPrefix: '‼️ ',
    notificationPriority: 'high',
    ringSecondsExtra: 15,
    viralityScore: 75,
  },
};

export const DEFAULT_TEMPLATES: Record<Urgency, string> = {
  reminder: 'Just checking you saw my message below.',
  follow_up:
    'Following up on my message from {minutes_waiting} minutes ago. Could you confirm {ask}?',
  urgent: "I still haven't heard back and this is now urgent. I need {ask}.",
  final: 'This is my last attempt to reach you before I take this further.',
  escalated:
    "I'm writing because {sender_name}'s messages to {recipient_team} have gone unanswered since T+{root_minute}.",
};

const KNOWN_PLACEHOLDERS = new Set([
  'sender_name',
  'recipient_team',
  'original_subject',
  'ask',
  'minutes_waiting',
  'root_minute',
  'followups_sent',
  'missed_calls',
  'step',
  'max_steps',
  'mood_line',
]);

export interface TemplateVars {
  sender_name: string;
  recipient_team: string;
  original_subject: string;
  ask: string;
  minutes_waiting: number;
  root_minute: number;
  followups_sent: number;
  missed_calls: number;
  step: number;
  max_steps: number;
  /** First script line of the current mood rung. Empty when the stakeholder is calm. */
  mood_line?: string;
}

export function urgencyRank(urgency: Urgency): number {
  return URGENCIES.indexOf(urgency);
}

export function raiseUrgency(urgency: Urgency, floor: Urgency): Urgency {
  return urgencyRank(urgency) >= urgencyRank(floor) ? urgency : floor;
}

export function urgencyEffects(urgency: Urgency): UrgencyEffects {
  return EFFECTS[urgency];
}

/** Prefixes already present are left as they are. */
export function applyUrgencyPrefix(text: string, prefix: string): string {
  if (!prefix) return text;
  if (text.startsWith(prefix)) return text;
  return `${prefix}${text}`;
}

export function extractAsk(content: string, title: string): string {
  const sentences = content
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const question = sentences.find((sentence) => sentence.includes('?'));
  const raw = question || title.trim();
  return raw || 'an answer';
}

export function renderChainTemplate(template: string, vars: TemplateVars): string {
  const values: Record<string, string> = {
    sender_name: vars.sender_name,
    recipient_team: vars.recipient_team,
    original_subject: vars.original_subject,
    ask: vars.ask || 'an answer',
    minutes_waiting: String(vars.minutes_waiting),
    root_minute: String(vars.root_minute),
    followups_sent: String(vars.followups_sent),
    missed_calls: String(vars.missed_calls),
    step: String(vars.step),
    max_steps: String(vars.max_steps),
    mood_line: vars.mood_line ?? '',
  };
  return template.replace(/\{([a-z0-9_]+)\}/gi, (token, name: string) => {
    if (!KNOWN_PLACEHOLDERS.has(name)) return '';
    return values[name] ?? '';
  });
}

export function defaultTemplate(urgency: Urgency): string {
  return DEFAULT_TEMPLATES[urgency];
}

export function resolveConcreteApp(app: ChainApp, rootApp: string): ConcreteChainApp | null {
  const concrete = app === 'same' ? rootApp : app;
  return (CONCRETE_CHAIN_APPS as readonly string[]).includes(concrete)
    ? (concrete as ConcreteChainApp)
    : null;
}

export function resolveStep(
  config: EscalationConfig,
  stepNo: number,
  rootApp: string,
): ResolvedStep | null {
  if (stepNo < 1 || config.steps.length === 0) return null;
  const repeated = stepNo > config.steps.length;
  const base = config.steps[Math.min(stepNo, config.steps.length) - 1];
  if (!base) return null;
  const urgency = repeated ? raiseUrgency(base.urgency, 'final') : base.urgency;
  const appResolved = resolveConcreteApp(base.app, rootApp);
  if (!appResolved) return null;
  return { ...base, urgency, stepNo, repeated, appResolved };
}

export function chainSpanMinutes(config: EscalationConfig, rootApp: string): number {
  let total = 0;
  for (let stepNo = 1; stepNo <= config.max_steps; stepNo += 1) {
    const step = resolveStep(config, stepNo, rootApp);
    if (!step) continue;
    total += step.after_minutes;
    if (step.appResolved === 'phone_call') {
      const attempts = step.redial?.attempts ?? 1;
      const interval = step.redial?.interval_minutes ?? 2;
      total += Math.max(0, attempts - 1) * interval;
    }
  }
  return total;
}

export interface EscalationIssue {
  level: 'error' | 'warning';
  message: string;
}

export interface KnownInjectRef {
  key: string;
  trigger_time_minutes: number | null;
  condition_keys: readonly string[];
}

export function validateEscalation(input: {
  escalation: unknown;
  rootApp: string | null;
  rootStakeholderId: string | null;
  /** Null when the scenario could not be read. An array is the known ids. */
  stakeholderIds: readonly string[] | null;
  durationMinutes: number | null;
  rootKey: string | null;
  rootTriggerMinute: number | null;
  otherInjects: readonly KnownInjectRef[];
}): EscalationIssue[] {
  if (input.escalation == null) return [];
  const issues: EscalationIssue[] = [];
  const error = (message: string) => issues.push({ level: 'error', message });
  const warn = (message: string) => issues.push({ level: 'warning', message });
  if (!input.escalation || typeof input.escalation !== 'object' || Array.isArray(input.escalation)) {
    error('escalation must be an object');
    return issues;
  }
  const raw = input.escalation as Record<string, unknown>;
  const maxSteps = raw.max_steps;
  if (!Number.isInteger(maxSteps) || (maxSteps as number) < 1 || (maxSteps as number) > 6) {
    error('escalation.max_steps must be a whole number from 1 to 6');
  }
  if (raw.scope != null && raw.scope !== 'per_team' && raw.scope !== 'any_recipient') {
    error("escalation.scope must be 'per_team' or 'any_recipient'");
  }
  if (
    raw.stop_on != null &&
    raw.stop_on !== 'any_response' &&
    raw.stop_on !== 'relevant_response' &&
    raw.stop_on !== 'passed_response'
  ) {
    error("escalation.stop_on must be 'any_response', 'relevant_response' or 'passed_response'");
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    error('escalation.steps needs at least one step');
    return issues;
  }
  let previous: Urgency | null = null;
  raw.steps.forEach((step, index) => {
    const label = `escalation.steps[${index}]`;
    if (!step || typeof step !== 'object') {
      error(`${label} must be an object`);
      return;
    }
    const row = step as Record<string, unknown>;
    const after = row.after_minutes;
    if (!Number.isInteger(after) || (after as number) < 1 || (after as number) > 120) {
      error(`${label}.after_minutes must be a whole number from 1 to 120`);
    }
    const urgency = row.urgency;
    if (!isUrgency(urgency)) {
      error(`${label}.urgency must be ${URGENCIES.join(', ')}`);
    } else if (previous && urgencyRank(urgency) < urgencyRank(previous)) {
      error(`${label}.urgency decreases from ${previous}`);
    } else if (isUrgency(urgency)) {
      previous = urgency;
    }
    const app = row.app == null ? 'same' : row.app;
    if (typeof app !== 'string' || !(CHAIN_APPS as readonly string[]).includes(app)) {
      error(`${label}.app is not a chain channel`);
    } else {
      const concrete = resolveConcreteApp(app as ChainApp, input.rootApp ?? '');
      if (!concrete) error(`${label}.app resolves to a channel chains cannot use`);
      const stakeholder = stakeholderForStep(row, input.rootStakeholderId);
      if (
        (concrete === 'npc_dm' || concrete === 'phone_call') &&
        !stakeholder
      ) {
        error(`${label} needs a stakeholder (the root's, or sender_stakeholder_id)`);
      } else if (stakeholder && input.stakeholderIds && !input.stakeholderIds.includes(stakeholder)) {
        error(`${label} stakeholder "${stakeholder}" is not in this scenario`);
      }
    }
    if (row.sender_stakeholder_id != null && typeof row.sender_stakeholder_id !== 'string') {
      error(`${label}.sender_stakeholder_id must be a string`);
    }
    if (typeof row.brief === 'string' && row.brief.length > 300) {
      error(`${label}.brief must be at most 300 characters`);
    }
    if (row.content_mode != null && row.content_mode !== 'template' && row.content_mode !== 'ai') {
      error(`${label}.content_mode must be 'template' or 'ai'`);
    }
    if (row.redial != null) {
      const redialError = redialProblem(row.redial);
      if (redialError) error(`${label}.redial ${redialError}`);
    }
  });

  const parsed = parseEscalation(raw);
  if (parsed && input.durationMinutes != null && Number.isFinite(input.durationMinutes)) {
    const span = chainSpanMinutes(parsed, input.rootApp ?? 'email');
    const start = input.rootTriggerMinute ?? 0;
    if (start + span > input.durationMinutes) {
      error(
        `Escalation runs to minute ${start + span}, past the scenario duration of ${input.durationMinutes}`,
      );
    }
  }
  const publishKey = publishKeyOf(raw.on_exhausted);
  if (publishKey) {
    const target = input.otherInjects.find((inject) => inject.key === publishKey);
    if (!target) error(`on_exhausted.publish_inject_key "${publishKey}" does not match an inject`);
    else if (target.trigger_time_minutes != null) {
      error(`on_exhausted.publish_inject_key "${publishKey}" must be a conditional inject`);
    }
  }
  if (input.rootKey) {
    const chaser = input.otherInjects.some((inject) =>
      inject.condition_keys.some((key) => isDoubleChaser(key, input.rootKey as string)),
    );
    if (chaser) {
      warn(
        `Another inject already chases ${input.rootKey} with unresponded or email_unreplied. The chain and that inject both follow up.`,
      );
    }
  }
  return issues;
}

function stakeholderForStep(step: Record<string, unknown>, rootStakeholderId: string | null): string | null {
  if (typeof step.sender_stakeholder_id === 'string' && step.sender_stakeholder_id.trim()) {
    return step.sender_stakeholder_id.trim();
  }
  return rootStakeholderId;
}

function redialProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'must be an object';
  const row = value as Record<string, unknown>;
  if (row.attempts != null && (!Number.isInteger(row.attempts) || (row.attempts as number) < 1 || (row.attempts as number) > 6)) {
    return 'attempts must be from 1 to 6';
  }
  if (
    row.interval_minutes != null &&
    (!Number.isInteger(row.interval_minutes) ||
      (row.interval_minutes as number) < 1 ||
      (row.interval_minutes as number) > 30)
  ) {
    return 'interval_minutes must be from 1 to 30';
  }
  return null;
}

function publishKeyOf(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const key = (value as { publish_inject_key?: unknown }).publish_inject_key;
  return typeof key === 'string' && key.trim() ? key.trim() : null;
}

function isDoubleChaser(key: string, rootKey: string): boolean {
  const body = key.split('|')[0] ?? '';
  return body.startsWith(`unresponded:${rootKey}:`) || body.startsWith(`email_unreplied:${rootKey}:`);
}

export function parseEscalation(value: unknown): EscalationConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) return null;
  const steps: ChainStepSpec[] = [];
  for (const step of raw.steps) {
    if (!step || typeof step !== 'object') return null;
    const row = step as Record<string, unknown>;
    if (!Number.isInteger(row.after_minutes)) return null;
    if (!isUrgency(row.urgency)) return null;
    const app = (row.app == null ? 'same' : row.app) as ChainApp;
    if (!(CHAIN_APPS as readonly string[]).includes(app)) return null;
    const redial = parseRedial(row.redial);
    steps.push({
      after_minutes: row.after_minutes as number,
      urgency: row.urgency,
      app,
      content_mode: row.content_mode === 'ai' ? 'ai' : 'template',
      ...(typeof row.template === 'string' ? { template: row.template } : {}),
      ...(typeof row.brief === 'string' ? { brief: row.brief.slice(0, 300) } : {}),
      ...(typeof row.sender_stakeholder_id === 'string'
        ? { sender_stakeholder_id: row.sender_stakeholder_id }
        : {}),
      ...(typeof row.target_team === 'string' ? { target_team: row.target_team } : {}),
      ...(typeof row.cc_team === 'string' ? { cc_team: row.cc_team } : {}),
      ...(redial ? { redial } : {}),
    });
  }
  const maxSteps = Number.isInteger(raw.max_steps) ? (raw.max_steps as number) : steps.length;
  const scope = raw.scope === 'any_recipient' ? 'any_recipient' : 'per_team';
  const stopOn = (STOP_ON as readonly string[]).includes(String(raw.stop_on))
    ? (raw.stop_on as StopOn)
    : 'any_response';
  const publish = publishKeyOf(raw.on_exhausted);
  return {
    max_steps: Math.min(6, Math.max(1, maxSteps)),
    scope,
    stop_on: stopOn,
    stop_on_contact: raw.stop_on_contact == null ? true : raw.stop_on_contact === true,
    steps,
    ...(publish ? { on_exhausted: { publish_inject_key: publish } } : {}),
  };
}

function parseRedial(value: unknown): ChainRedial | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const attempts = Number.isInteger(row.attempts) ? (row.attempts as number) : 1;
  const interval = Number.isInteger(row.interval_minutes) ? (row.interval_minutes as number) : 2;
  return {
    attempts: Math.min(6, Math.max(1, attempts)),
    interval_minutes: Math.min(30, Math.max(1, interval)),
    ...(row.voicemail_each === true ? { voicemail_each: true } : {}),
    ...(row.stop_on_contact === false ? { stop_on_contact: false } : {}),
  };
}

function isUrgency(value: unknown): value is Urgency {
  return typeof value === 'string' && (URGENCIES as readonly string[]).includes(value);
}

export interface ChainLedgerFields {
  chainRootDeliveryId?: string | null;
  chainRootKey?: string | null;
  chainStep?: number | null;
  urgency?: Urgency | null;
  escalation?: EscalationConfig | null;
}

/** Fields a delivery adapter copies from delivery_config. A chain step never starts another chain. */
export function chainLedgerFields(config: unknown): ChainLedgerFields {
  if (!config || typeof config !== 'object') return {};
  const record = config as { chain?: unknown; escalation?: unknown };
  const chain = readChainLink(record.chain);
  if (chain) {
    return {
      chainRootDeliveryId: chain.root_delivery_id,
      chainRootKey: chain.root_key,
      chainStep: chain.step,
      urgency: chain.urgency,
    };
  }
  const escalation = parseEscalation(record.escalation);
  return escalation ? { escalation } : {};
}

export interface ChainLink {
  chain_id: string;
  root_delivery_id: string;
  root_key: string;
  step: number;
  urgency: Urgency;
  thread_id?: string;
  replied_to_id?: string;
}

export function readChainLink(value: unknown): ChainLink | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.root_delivery_id !== 'string' || typeof row.root_key !== 'string') return null;
  if (!Number.isInteger(row.step) || !isUrgency(row.urgency)) return null;
  return {
    chain_id: typeof row.chain_id === 'string' ? row.chain_id : '',
    root_delivery_id: row.root_delivery_id,
    root_key: row.root_key,
    step: row.step as number,
    urgency: row.urgency,
    ...(typeof row.thread_id === 'string' ? { thread_id: row.thread_id } : {}),
    ...(typeof row.replied_to_id === 'string' ? { replied_to_id: row.replied_to_id } : {}),
  };
}

export interface ChainResponseFact {
  id?: string;
  minute: number;
  team: string | null;
  user_id: string | null;
  judgement_status: string;
  judgement: { addresses_inject?: boolean; passed?: boolean } | null;
  delivery_id: string;
  inject_key: string;
  chain_step: number | null;
  chain_root_delivery_id: string | null;
  chain_root_key: string | null;
  recipient_teams: string[];
  fallback_reason: string | null;
}

export interface CallGroupFact {
  finished: boolean;
  finish_minute: number | null;
  answered: boolean;
}

export interface ChainClock {
  scope: ChainScope;
  scope_team: string | null;
  scope_role: string | null;
  root_key: string;
  root_delivery_id: string;
  stakeholder_id: string | null;
  stop_on: StopOn;
  stop_on_contact: boolean;
  steps_sent: number;
  max_steps: number;
  last_step_delivered_minute: number;
  next_due_minute: number | null;
  waiting_on_call_group_id: string | null;
  hold_through_minute: number | null;
  root_minute: number;
  root_app: string;
  config: EscalationConfig;
}

export type ChainDecision =
  | { kind: 'stop'; reason: string; responseId?: string; stoppedAfterStep: number }
  | { kind: 'cancel'; reason: 'session_ended' }
  | {
      kind: 'wait';
      held?: boolean;
      nextDueMinute?: number;
      holdThroughMinute?: number | null;
      clearCall?: boolean;
      lastStepMinute?: number;
    }
  | { kind: 'send'; stepNo: number; clearCall?: boolean; lastStepMinute?: number }
  | { kind: 'exhaust' }
  | { kind: 'reset'; nextDueMinute: number };

const ENDED_SESSION = new Set(['completed', 'cancelled', 'ended']);

export function decideChainAction(input: {
  chain: ChainClock;
  responses: readonly ChainResponseFact[];
  contactMinute: number | null;
  callGroup: CallGroupFact | null;
  elapsed: number;
  sessionStatus: string;
  gaveUpStopChains?: boolean;
  held: boolean;
  rolePlayerIds?: readonly string[];
}): ChainDecision {
  const chain = input.chain;
  if (ENDED_SESSION.has(input.sessionStatus)) return { kind: 'cancel', reason: 'session_ended' };
  if (input.gaveUpStopChains) {
    return { kind: 'stop', reason: 'gave_up', stoppedAfterStep: chain.steps_sent };
  }
  const scoped = input.responses.filter((response) => responseInScope(response, chain, input.rolePlayerIds ?? []));
  const fromReplies = stopFromReplies(chain, scoped, input.elapsed);
  if (fromReplies) return fromReplies;
  if (
    chain.stop_on_contact &&
    chain.stakeholder_id &&
    input.contactMinute != null &&
    input.contactMinute >= chain.root_minute
  ) {
    return { kind: 'stop', reason: 'contact_elsewhere', stoppedAfterStep: chain.steps_sent };
  }

  let working = chain;
  let clearCall = false;
  let lastStepMinute: number | undefined;
  if (chain.waiting_on_call_group_id) {
    const group = input.callGroup;
    if (!group) return { kind: 'wait' };
    if (group.answered) {
      return { kind: 'stop', reason: 'response', stoppedAfterStep: chain.steps_sent };
    }
    if (!group.finished) return { kind: 'wait' };
    const finish = group.finish_minute ?? input.elapsed;
    const nextDue = finish + upcomingAfter(working);
    if (input.elapsed < nextDue) {
      return {
        kind: 'wait',
        clearCall: true,
        lastStepMinute: finish,
        nextDueMinute: nextDue,
      };
    }
    working = {
      ...working,
      waiting_on_call_group_id: null,
      last_step_delivered_minute: finish,
      next_due_minute: nextDue,
    };
    clearCall = true;
    lastStepMinute = finish;
  }

  if (input.held) {
    const held = holdDecision(working, input.elapsed);
    return { ...held, ...(clearCall ? { clearCall, lastStepMinute } : {}) };
  }

  if (working.steps_sent >= working.max_steps) {
    const last = resolveStep(working.config, Math.max(working.steps_sent, 1), working.root_app);
    const wait = last?.after_minutes ?? 10;
    if (input.elapsed >= working.last_step_delivered_minute + wait) return { kind: 'exhaust' };
    return { kind: 'wait', ...(clearCall ? { clearCall, lastStepMinute } : {}) };
  }

  const due = working.next_due_minute ?? working.last_step_delivered_minute;
  if (input.elapsed < due) {
    return { kind: 'wait', ...(clearCall ? { clearCall, lastStepMinute } : {}) };
  }
  return {
    kind: 'send',
    stepNo: working.steps_sent + 1,
    ...(clearCall ? { clearCall, lastStepMinute } : {}),
  };
}

function holdDecision(chain: ChainClock, elapsed: number): ChainDecision {
  const through = chain.hold_through_minute;
  if (through == null || elapsed > through) {
    const delta = through == null ? 1 : elapsed - through;
    const nextDue = (chain.next_due_minute ?? elapsed) + delta;
    return { kind: 'wait', held: true, nextDueMinute: nextDue, holdThroughMinute: elapsed };
  }
  return { kind: 'wait', held: true };
}

function responseInScope(
  response: ChainResponseFact,
  chain: ChainClock,
  rolePlayerIds: readonly string[],
): boolean {
  const linked =
    response.delivery_id === chain.root_delivery_id ||
    response.chain_root_delivery_id === chain.root_delivery_id;
  const rootFamily =
    response.chain_step == null && response.inject_key === chain.root_key;
  const followUp =
    response.chain_step != null &&
    (response.chain_root_key === chain.root_key || response.inject_key === chain.root_key);
  if (chain.scope === 'any_recipient') return linked || rootFamily || followUp;
  const sameChain = linked || (followUp && response.chain_root_delivery_id === chain.root_delivery_id);
  const sameTeamRoot = rootFamily && teamMatches(response.recipient_teams, chain.scope_team);
  if (!sameChain && !sameTeamRoot && !(followUp && linked)) return false;
  if (chain.scope_role) {
    const rolePlayer = response.user_id != null && rolePlayerIds.includes(response.user_id);
    const fallback = Boolean(response.fallback_reason);
    const teamReply = fallback && teamMatches([response.team ?? ''], chain.scope_team);
    return rolePlayer || teamReply;
  }
  if (!chain.scope_team) return true;
  return teamMatches([response.team ?? ''], chain.scope_team);
}

function teamMatches(teams: readonly string[], scopeTeam: string | null): boolean {
  if (!scopeTeam) return true;
  const slug = slugifyTeamName(scopeTeam);
  return teams.some((team) => slugifyTeamName(team) === slug);
}

function stopFromReplies(
  chain: ChainClock,
  responses: readonly ChainResponseFact[],
  elapsed: number,
): ChainDecision | null {
  if (responses.length === 0) return null;
  const ordered = [...responses].sort((a, b) => a.minute - b.minute || (a.id ?? '').localeCompare(b.id ?? ''));
  if (chain.stop_on === 'any_response') {
    const hit = ordered[0];
    return hit
      ? { kind: 'stop', reason: 'response', responseId: hit.id, stoppedAfterStep: chain.steps_sent }
      : null;
  }
  if (chain.stop_on === 'relevant_response') {
    for (const response of ordered) {
      if (response.judgement_status === 'done') {
        if (response.judgement?.addresses_inject === true) {
          return {
            kind: 'stop',
            reason: 'relevant_response',
            responseId: response.id,
            stoppedAfterStep: chain.steps_sent,
          };
        }
        continue;
      }
      if (elapsed - response.minute >= UNJUDGED_GRACE_MINUTES) {
        return {
          kind: 'stop',
          reason: 'relevant_response',
          responseId: response.id,
          stoppedAfterStep: chain.steps_sent,
        };
      }
    }
    return null;
  }
  let reset: ChainResponseFact | null = null;
  for (const response of ordered) {
    if (response.judgement_status === 'done' && response.judgement?.passed === true) {
      return {
        kind: 'stop',
        reason: 'passed_response',
        responseId: response.id,
        stoppedAfterStep: chain.steps_sent,
      };
    }
    const failed =
      response.judgement_status === 'done' && response.judgement?.passed === false;
    const gaveUpJudging =
      response.judgement_status !== 'done' &&
      response.judgement_status !== 'pending' &&
      response.judgement_status !== 'queued' &&
      elapsed - response.minute >= UNJUDGED_GRACE_MINUTES;
    if (failed || gaveUpJudging) reset = response;
  }
  if (!reset) return null;
  const nextDue = reset.minute + upcomingAfter(chain);
  if (chain.next_due_minute === nextDue) return null;
  return { kind: 'reset', nextDueMinute: nextDue };
}

function upcomingAfter(chain: ChainClock): number {
  if (chain.steps_sent >= chain.max_steps) {
    const last = resolveStep(chain.config, Math.max(chain.steps_sent, 1), chain.root_app);
    return last?.after_minutes ?? 10;
  }
  const next = resolveStep(chain.config, chain.steps_sent + 1, chain.root_app);
  return next?.after_minutes ?? 10;
}

/**
 * After a step is sent. More than one full interval late, the next due minute
 * is counted from now. Otherwise it stays on the original schedule.
 */
export function nextDueAfterSend(input: {
  elapsed: number;
  nextDueMinute: number | null;
  sentAfterMinutes: number;
  followingAfterMinutes: number;
}): number {
  const due = input.nextDueMinute ?? input.elapsed;
  const overdue = input.elapsed - due;
  if (overdue > input.sentAfterMinutes) return input.elapsed + input.followingAfterMinutes;
  return due + input.followingAfterMinutes;
}

export function textLimit(app: ConcreteChainApp): number {
  if (app === 'email') return 900;
  if (app === 'social_feed') return 260;
  if (app === 'phone_call') return 600;
  return 280;
}

export function appNoun(app: ConcreteChainApp): string {
  if (app === 'email') return 'email';
  if (app === 'phone_call') return 'phone call';
  if (app === 'social_feed') return 'social post';
  if (app === 'group_chat') return 'chat message';
  return 'text message';
}

export function splitEmailSubject(text: string, fallback: string): { subject: string; body: string } {
  const lines = text.split('\n');
  const subjectLine = lines.find((line) => line.startsWith('Subject:'));
  if (!subjectLine) return { subject: fallback, body: text.trim() };
  return {
    subject: subjectLine.replace(/^Subject:\s*/, '').trim() || fallback,
    body: lines.filter((line) => !line.startsWith('Subject:')).join('\n').trim(),
  };
}

export function composeFollowUp(input: {
  app: ConcreteChainApp;
  urgency: Urgency;
  text: string;
  originalSubject: string;
}): { title: string; content: string; subject: string } {
  const effects = urgencyEffects(input.urgency);
  if (input.app === 'email') {
    const fallback = applyUrgencyPrefix(`Re: ${input.originalSubject || 'your message'}`, effects.emailSubjectPrefix);
    const split = splitEmailSubject(input.text, fallback);
    const subject = applyUrgencyPrefix(split.subject, effects.emailSubjectPrefix);
    const content = `Subject: ${subject}\n${split.body}`.trim();
    return { title: subject, content, subject };
  }
  const body =
    input.app === 'group_chat' || input.app === 'npc_dm' || input.app === 'messenger_dm'
      ? applyUrgencyPrefix(input.text.trim(), effects.chatPrefix)
      : input.text.trim();
  const title = body.split('\n')[0]?.slice(0, 120) || 'Follow-up';
  return { title, content: body, subject: title };
}

export interface ChainSnapshot {
  chain_id: string;
  scope_team: string | null;
  scope_role: string | null;
  status: 'active' | 'stopped' | 'exhausted' | 'cancelled';
  steps_sent: number;
  max_steps: number;
  max_urgency: Urgency | null;
  stopped_reason: string | null;
  stopped_minute: number | null;
  stopped_after_step: number | null;
}

export function maxUrgencySent(config: EscalationConfig, stepsSent: number, rootApp: string): Urgency | null {
  let best: Urgency | null = null;
  for (let stepNo = 1; stepNo <= stepsSent; stepNo += 1) {
    const step = resolveStep(config, stepNo, rootApp);
    if (!step) continue;
    if (!best || urgencyRank(step.urgency) > urgencyRank(best)) best = step.urgency;
  }
  return best;
}

export function evaluateChainKey(input: {
  id: string;
  args: string[];
  team?: string;
  role?: string;
  chains: readonly ChainSnapshot[];
}): { met: boolean; detail: string } {
  const scoped = input.chains.filter((chain) => chainInKeyScope(chain, input.team, input.role));
  const n = Number(input.args[1]);
  switch (input.id) {
    case 'chain_active':
      return flag(scoped.some((chain) => chain.status === 'active'), 'active', scoped);
    case 'chain_stopped':
      return flag(
        scoped.some(
          (chain) => chain.status === 'stopped' && chain.stopped_reason != null && RESPONSE_STOPS.has(chain.stopped_reason),
        ),
        'stopped by a reply',
        scoped,
      );
    case 'chain_exhausted':
      return flag(scoped.some((chain) => chain.status === 'exhausted'), 'exhausted', scoped);
    case 'chain_step_reached':
      return flag(scoped.some((chain) => chain.steps_sent >= n), `step ${n}`, scoped);
    case 'followups_sent_gte': {
      const sum = scoped.reduce((total, chain) => total + chain.steps_sent, 0);
      return { met: sum >= n, detail: `${sum} follow-ups sent` };
    }
    case 'chain_stopped_by_step':
      return flag(
        scoped.some(
          (chain) =>
            chain.status === 'stopped' &&
            chain.stopped_reason != null &&
            RESPONSE_STOPS.has(chain.stopped_reason) &&
            (chain.stopped_after_step ?? chain.steps_sent) <= n,
        ),
        `stopped by step ${n}`,
        scoped,
      );
    case 'urgency_reached': {
      const target = input.args[1];
      if (!isUrgency(target)) return { met: false, detail: 'Unknown urgency' };
      return flag(
        scoped.some((chain) => chain.max_urgency != null && urgencyRank(chain.max_urgency) >= urgencyRank(target)),
        target,
        scoped,
      );
    }
    default:
      return { met: false, detail: 'Unknown chain key' };
  }
}

function chainInKeyScope(chain: ChainSnapshot, team?: string, role?: string): boolean {
  if (role) return chain.scope_role === role;
  if (team) {
    if (chain.scope_team == null) return true;
    return slugifyTeamName(chain.scope_team) === team;
  }
  return true;
}

function flag(met: boolean, label: string, chains: readonly ChainSnapshot[]): { met: boolean; detail: string } {
  if (chains.length === 0) return { met: false, detail: 'No chain' };
  return { met, detail: met ? label : `Not ${label}` };
}

export function followUpSystemSuffix(input: {
  appNoun: string;
  recipientTeam: string;
  urgency: Urgency;
  brief: string;
  minutesWaiting: number;
  followupsSent: number;
  missedCalls: number;
  limit: number;
}): string {
  return [
    `Write ONE follow-up ${input.appNoun} to the ${input.recipientTeam} team. Urgency: ${input.urgency}.`,
    `Brief: ${input.brief || 'Ask again for the answer you still need.'}`,
    `Facts: you first contacted them ${input.minutesWaiting} minutes ago; follow-ups already sent: ${input.followupsSent}; missed calls: ${input.missedCalls}.`,
    `Keep it under ${input.limit} characters. Never mention a simulation.`,
    'Return JSON { "subject"?: string, "text": string }.',
  ].join(' ');
}

export function isResponseStop(reason: string | null): boolean {
  return reason != null && RESPONSE_STOPS.has(reason);
}

/**
 * A lost step claim is left alone until the row is this old. That is long enough
 * for the process that inserted it to finish publishing, including a deploy overlap.
 */
export const STEP_CLAIM_ABANDON_MS = 60_000;

/**
 * Stable id for the runtime inject of one chain step. A second insert of the same
 * step hits the primary key and reuses this row instead of delivering a copy.
 */
export function runtimeStepInjectId(chainId: string, stepNo: number): string {
  const digest = createHash('sha256').update(`escalation-step:${chainId}:${stepNo}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type StepMaterialisation = 'create' | 'resume' | 'publish_existing' | 'stop';

/**
 * Who may create or publish a step inject.
 * A lost claim with no inject id stops. The owner that inserted the step row
 * is the only sender until the row is old enough to be abandoned.
 */
export type ExhaustPublishOutcome = 'no_key' | 'published' | 'unresolved' | 'transient' | 'deferred';

/**
 * A consequence key that matches no conditional inject closes the chain once.
 * A transient publish failure, or a tick that is already at the publish cap, retries.
 */
export function planExhaustPublish(outcome: ExhaustPublishOutcome): 'retry' | 'mark' | 'mark_unresolved' {
  if (outcome === 'transient' || outcome === 'deferred') return 'retry';
  if (outcome === 'unresolved') return 'mark_unresolved';
  return 'mark';
}

export function planStepMaterialisation(input: {
  claim: 'won' | 'lost' | 'unavailable';
  existingInjectId: string | null;
  stepAgeMs: number | null;
  abandonAfterMs?: number;
}): StepMaterialisation {
  if (input.claim === 'unavailable') return 'stop';
  if (input.claim === 'won') return 'create';
  if (input.existingInjectId) return 'publish_existing';
  const age = input.stepAgeMs ?? 0;
  const abandon = input.abandonAfterMs ?? STEP_CLAIM_ABANDON_MS;
  if (age >= abandon) return 'resume';
  return 'stop';
}
