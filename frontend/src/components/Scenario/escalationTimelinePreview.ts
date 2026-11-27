import {
  resolveStep,
  type EscalationConfig,
  type ResolvedStep,
} from '@shared/escalationAuthoring';

export interface TimelineNames {
  senderName?: (id: string) => string;
  publishTitle?: (key: string) => string;
}

function urgencyWord(urgency: ResolvedStep['urgency']): string {
  return urgency === 'follow_up' ? 'follow-up' : urgency;
}

function appWord(app: ResolvedStep['appResolved']): string {
  if (app === 'npc_dm' || app === 'messenger_dm') return 'text';
  if (app === 'group_chat') return 'chat';
  if (app === 'social_feed') return 'post';
  if (app === 'phone_call') return 'call';
  return 'email';
}

function stepLabel(step: ResolvedStep, names: TimelineNames): string {
  const word = urgencyWord(step.urgency);
  const plain = step.urgency === 'reminder' || step.urgency === 'follow_up';
  if (step.appResolved === 'phone_call') {
    const attempts = step.redial?.attempts ?? 1;
    const call = `call ×${attempts}`;
    return plain ? `${word} ${call}` : `${call} (${word})`;
  }
  if (step.sender_stakeholder_id && step.appResolved === 'email') {
    const who = names.senderName?.(step.sender_stakeholder_id) ?? step.sender_stakeholder_id;
    const whom = step.cc_team || step.target_team;
    return whom ? `${who} emails ${whom}` : `${who} emails`;
  }
  const channel = appWord(step.appResolved);
  return plain ? `${word} ${channel}` : `${channel} (${word})`;
}

/**
 * Offsets are minutes after the root delivery. A call step is marked when it
 * starts; the next step waits until the call group finishes (redials included).
 * A max_steps past the authored list repeats the last step at urgency final or higher.
 * The exhausted publish is one last interval after that finish.
 */
export function escalationTimelineSentence(
  config: EscalationConfig,
  rootApp: string,
  names: TimelineNames = {},
): string {
  const markers = ['T+0 root'];
  let cursor = 0;
  let lastAfter = 10;
  for (let stepNo = 1; stepNo <= config.max_steps; stepNo += 1) {
    const step = resolveStep(config, stepNo, rootApp);
    if (!step) continue;
    cursor += step.after_minutes;
    markers.push(`+${cursor} ${stepLabel(step, names)}`);
    if (step.appResolved === 'phone_call') {
      const attempts = step.redial?.attempts ?? 1;
      const interval = step.redial?.interval_minutes ?? 2;
      cursor += Math.max(0, attempts - 1) * interval;
    }
    lastAfter = step.after_minutes;
  }
  const key = config.on_exhausted?.publish_inject_key;
  if (key) {
    cursor += lastAfter;
    const title = names.publishTitle?.(key) ?? key;
    markers.push(`+${cursor} "${title}"`);
  }
  return `${markers.join(' → ')} (all relative to delivery; stops at the first reply)`;
}
