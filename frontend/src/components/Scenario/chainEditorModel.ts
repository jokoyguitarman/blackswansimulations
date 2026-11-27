import {
  CHAIN_APPS,
  parseEscalation,
  validateEscalation,
  type ChainApp,
  type ChainScope,
  type EscalationConfig,
  type EscalationIssue,
  type KnownInjectRef,
  type StopOn,
  type Urgency,
} from '@shared/escalationAuthoring';

export const CHASEABLE_APPS = [
  'email',
  'group_chat',
  'npc_dm',
  'messenger_dm',
  'phone_call',
  'social_feed',
] as const;

export type ChaseableApp = (typeof CHASEABLE_APPS)[number];

export function isChaseableApp(app: string): app is ChaseableApp {
  return (CHASEABLE_APPS as readonly string[]).includes(app);
}

export interface ChainStepDraft {
  after_minutes: number;
  urgency: Urgency;
  app: ChainApp;
  content_mode: 'template' | 'ai';
  template: string;
  brief: string;
  sender_stakeholder_id: string;
  target_team: string;
  cc_team: string;
  redial_attempts: number;
  redial_interval: number;
}

export interface EscalationDraft {
  enabled: boolean;
  max_steps: number;
  scope: ChainScope;
  stop_on: StopOn;
  stop_on_contact: boolean;
  steps: ChainStepDraft[];
  publish_inject_key: string;
}

export interface RedialDraft {
  ring_seconds: number;
  extra_rings: number;
  interval_minutes: number;
  stop_on_contact: boolean;
  voicemail_each: boolean;
}

export function blankStep(previous?: ChainStepDraft): ChainStepDraft {
  const urgency = previous?.urgency ?? 'follow_up';
  return {
    after_minutes: 5,
    urgency,
    app: 'same',
    content_mode: 'template',
    template: '',
    brief: '',
    sender_stakeholder_id: '',
    target_team: '',
    cc_team: '',
    redial_attempts: 1,
    redial_interval: 2,
  };
}

export function escalationDraftFrom(value: unknown, hasStakeholder: boolean): EscalationDraft {
  const parsed = parseEscalation(value);
  if (!parsed) {
    return {
      enabled: false,
      max_steps: 1,
      scope: 'per_team',
      stop_on: 'any_response',
      stop_on_contact: hasStakeholder,
      steps: [blankStep()],
      publish_inject_key: '',
    };
  }
  return {
    enabled: true,
    max_steps: parsed.max_steps,
    scope: parsed.scope,
    stop_on: parsed.stop_on,
    stop_on_contact: parsed.stop_on_contact,
    publish_inject_key: parsed.on_exhausted?.publish_inject_key ?? '',
    steps: parsed.steps.map((step) => ({
      after_minutes: step.after_minutes,
      urgency: step.urgency,
      app: step.app,
      content_mode: step.content_mode,
      template: step.template ?? '',
      brief: step.brief ?? '',
      sender_stakeholder_id: step.sender_stakeholder_id ?? '',
      target_team: step.target_team ?? '',
      cc_team: step.cc_team ?? '',
      redial_attempts: step.redial?.attempts ?? 1,
      redial_interval: step.redial?.interval_minutes ?? 2,
    })),
  };
}

export function escalationDraftIssues(input: {
  draft: EscalationDraft;
  rootApp: string;
  rootStakeholderId: string | null;
  stakeholderIds: readonly string[];
  durationMinutes: number | null;
  rootKey: string | null;
  rootTriggerMinute: number | null;
  otherInjects: readonly KnownInjectRef[];
}): EscalationIssue[] {
  if (!input.draft.enabled) return [];
  return validateEscalation({
    escalation: escalationConfigFromDraft(input.draft),
    rootApp: input.rootApp,
    rootStakeholderId: input.rootStakeholderId,
    stakeholderIds: input.stakeholderIds,
    durationMinutes: input.durationMinutes,
    rootKey: input.rootKey,
    rootTriggerMinute: input.rootTriggerMinute,
    otherInjects: input.otherInjects,
  });
}

export function escalationConfigFromDraft(draft: EscalationDraft): EscalationConfig {
  return {
    max_steps: draft.max_steps,
    scope: draft.scope,
    stop_on: draft.stop_on,
    stop_on_contact: draft.stop_on_contact,
    steps: draft.steps.map((step) => {
      const phone = step.app === 'phone_call';
      return {
        after_minutes: step.after_minutes,
        urgency: step.urgency,
        app: (CHAIN_APPS as readonly string[]).includes(step.app) ? step.app : 'same',
        content_mode: step.content_mode,
        ...(step.content_mode === 'template' && step.template.trim()
          ? { template: step.template }
          : {}),
        ...(step.content_mode === 'ai' && step.brief.trim() ? { brief: step.brief } : {}),
        ...(step.sender_stakeholder_id ? { sender_stakeholder_id: step.sender_stakeholder_id } : {}),
        ...(step.target_team ? { target_team: step.target_team } : {}),
        ...(step.cc_team ? { cc_team: step.cc_team } : {}),
        ...(phone
          ? {
              redial: {
                attempts: step.redial_attempts,
                interval_minutes: step.redial_interval,
              },
            }
          : {}),
      };
    }),
    ...(draft.publish_inject_key.trim()
      ? { on_exhausted: { publish_inject_key: draft.publish_inject_key.trim() } }
      : {}),
  };
}

export function redialDraftFrom(config: Record<string, unknown>): RedialDraft {
  const ring = config.ring_seconds;
  const redial =
    config.redial && typeof config.redial === 'object'
      ? (config.redial as Record<string, unknown>)
      : null;
  const attempts = redial && Number.isInteger(redial.attempts) ? (redial.attempts as number) : 1;
  const interval =
    redial && Number.isInteger(redial.interval_minutes) ? (redial.interval_minutes as number) : 2;
  return {
    ring_seconds: Number.isInteger(ring) ? (ring as number) : 30,
    extra_rings: Math.max(0, attempts - 1),
    interval_minutes: interval,
    stop_on_contact: redial ? redial.stop_on_contact !== false : true,
    voicemail_each: redial?.voicemail_each === true,
  };
}

/** Writes ring length and redial onto a phone inject, and clears them on other apps. */
export function applyPhoneDraft(
  config: Record<string, unknown>,
  app: string,
  draft: RedialDraft,
): void {
  if (app !== 'phone_call') {
    delete config.ring_seconds;
    delete config.redial;
    return;
  }
  config.ring_seconds = draft.ring_seconds;
  const attempts = draft.extra_rings + 1;
  const keep =
    attempts > 1 || draft.voicemail_each || draft.stop_on_contact === false || draft.interval_minutes !== 2;
  if (!keep) {
    delete config.redial;
    return;
  }
  config.redial = {
    attempts,
    interval_minutes: draft.interval_minutes,
    voicemail_each: draft.voicemail_each,
    stop_on_contact: draft.stop_on_contact,
  };
}

export function redialFieldErrors(draft: RedialDraft): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(draft.ring_seconds) || draft.ring_seconds < 10 || draft.ring_seconds > 60) {
    errors.push('ring_seconds must be an integer from 10 to 60.');
  }
  const attempts = draft.extra_rings + 1;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 6) {
    errors.push('redial.attempts must be an integer from 1 to 6.');
  }
  if (
    !Number.isInteger(draft.interval_minutes) ||
    draft.interval_minutes < 1 ||
    draft.interval_minutes > 30
  ) {
    errors.push('redial.interval_minutes must be an integer from 1 to 30.');
  }
  return errors;
}

export function conditionKeysOf(appear: unknown, cancel: unknown): string[] {
  const keys: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) keys.push(value.trim());
  };
  if (Array.isArray(appear)) {
    for (const key of appear) push(key);
  } else if (appear && typeof appear === 'object') {
    const record = appear as { all?: unknown; conditions?: unknown };
    if (Array.isArray(record.all)) for (const key of record.all) push(key);
    if (Array.isArray(record.conditions)) for (const key of record.conditions) push(key);
  }
  if (Array.isArray(cancel)) for (const key of cancel) push(key);
  return keys;
}
