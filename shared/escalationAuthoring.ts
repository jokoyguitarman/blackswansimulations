/**
 * Escalation-chain authoring: steps, templates, urgency and validation.
 * Shared by the server runtime and the scenario editor. No database access.
 */

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

export const CHAIN_PLACEHOLDERS = [
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
] as const;

const KNOWN_PLACEHOLDERS = new Set<string>(CHAIN_PLACEHOLDERS);

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
  return template.replace(/\{([a-z0-9_]+)\}/gi, (_token, name: string) => {
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
      inject.condition_keys.some((key) => escalationChasesKey(key, input.rootKey as string)),
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

export function escalationChasesKey(key: string, rootKey: string): boolean {
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

export function isUrgency(value: unknown): value is Urgency {
  return typeof value === 'string' && (URGENCIES as readonly string[]).includes(value);
}
