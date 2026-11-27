/**
 * Escalation-chain decisions and ledger fields.
 * Authoring checks, templates and urgency live in shared/escalationAuthoring.ts.
 * No database access. The service applies whatever this module returns.
 */

import { createHash } from 'node:crypto';
import { slugifyTeamName } from '../conditions/conditionCatalog.js';
import {
  applyUrgencyPrefix,
  isUrgency,
  parseEscalation,
  resolveStep,
  urgencyEffects,
  urgencyRank,
} from '../../../shared/escalationAuthoring.js';
import type {
  ChainScope,
  ConcreteChainApp,
  EscalationConfig,
  StopOn,
  Urgency,
} from '../../../shared/escalationAuthoring.js';

const RESPONSE_STOPS = new Set([
  'response',
  'relevant_response',
  'passed_response',
  'contact_elsewhere',
]);

const UNJUDGED_GRACE_MINUTES = 2;

export {
  URGENCIES,
  CHAIN_APPS,
  CONCRETE_CHAIN_APPS,
  STOP_ON,
  CHAIN_SCOPES,
  DEFAULT_TEMPLATES,
  CHAIN_PLACEHOLDERS,
  urgencyRank,
  raiseUrgency,
  urgencyEffects,
  applyUrgencyPrefix,
  extractAsk,
  renderChainTemplate,
  defaultTemplate,
  resolveConcreteApp,
  resolveStep,
  chainSpanMinutes,
  validateEscalation,
  parseEscalation,
  escalationChasesKey,
  isUrgency,
} from '../../../shared/escalationAuthoring.js';

export type {
  Urgency,
  ChainApp,
  ConcreteChainApp,
  StopOn,
  ChainScope,
  ChainRedial,
  ChainStepSpec,
  EscalationConfig,
  ResolvedStep,
  UrgencyEffects,
  TemplateVars,
  EscalationIssue,
  KnownInjectRef,
} from '../../../shared/escalationAuthoring.js';

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
