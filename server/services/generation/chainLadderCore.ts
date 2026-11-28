/**
 * Pure post-processing for generated escalation chains, redials and mood
 * ladders (WP8 §8.6). A bad model item is repaired or dropped here. Nothing
 * in this module talks to the network or the database.
 */

import { hashString } from '../calls/callCore.js';
import { isValidInjectKey } from '../../lib/injectKey.js';
import { parseConditionKey } from '../conditions/conditionCatalog.js';
import {
  CHAIN_APPS,
  URGENCIES,
  chainSpanMinutes,
  defaultTemplate,
  resolveConcreteApp,
  urgencyRank,
  validateEscalation,
  type ChainApp,
  type EscalationConfig,
  type Urgency,
} from '../escalation/escalationCore.js';
import {
  RUNG_ID_RE,
  defaultLadderFor,
  validateMoodLadder,
  type MoodConsequence,
  type MoodLadder,
  type MoodRung,
  type MoodWhen,
} from '../mood/moodCore.js';

const CHAIN_ROOT_APPS = new Set([
  'email',
  'group_chat',
  'npc_dm',
  'messenger_dm',
  'phone_call',
  'social_feed',
]);

const STAKEHOLDER_MESSAGE_APPS = new Set(['email', 'phone_call', 'messenger_dm', 'npc_dm']);

const CHASE_WITH_WINDOW = [
  'unresponded',
  'email_unreplied',
  'dm_unanswered',
  'chat_unanswered',
  'call_unreturned',
  'call_missed_count',
];

const CONSEQUENCE_TYPES = new Set([
  'publish_inject',
  'verdict_lock',
  'persuadability',
  'grievance_append',
  'stop_chains',
  'notify_trainer',
]);

const SENIOR_TITLE =
  /\b(chief|director|head|president|minister|chair|secretary|vp|vice|lead|commissioner)\b/i;
const ANGRY_PERSONA = /\b(activist|campaigner|organiser|organizer|protest)\b/i;
const DISAPPOINTED_PERSONA = /\b(elder|pastor|imam|priest|chaplain|retired|grandparent)\b/i;

export interface ChainStakeholder {
  id: string;
  name?: string | null;
  organisation?: string | null;
  title?: string | null;
  relationship?: string | null;
  persuadability?: string | null;
  tier?: string | null;
  personality?: string | null;
  stance?: string | null;
  owning_team?: string | null;
  mood_ladder?: unknown;
}

export interface ChainRepairContext {
  rootKey: string;
  rootApp: string;
  rootStakeholderId: string | null;
  rootTriggerMinute: number | null;
  durationMinutes: number;
  stakeholders: readonly ChainStakeholder[];
  /** Conditional inject keys already in the scenario. Used to keep on_exhausted. */
  conditionalKeys?: ReadonlySet<string>;
}

export interface ChainRepairResult {
  escalation: EscalationConfig | null;
  repairs: string[];
  dropped: boolean;
}

export interface LadderRepairResult {
  ladder: MoodLadder;
  repairs: string[];
}

export interface ChaseBranch {
  conditions_to_appear?: { all?: string[]; conditions?: string[] } | null;
  conditions_to_cancel?: string[] | null;
  delivery_config?: {
    branch?: unknown;
    parent_inject_key?: unknown;
    app?: unknown;
    inject_key?: unknown;
    stakeholder_id?: unknown;
    redial?: unknown;
    escalation?: unknown;
    [key: string]: unknown;
  } | null;
}

interface LooseStep {
  after_minutes: number;
  urgency: Urgency;
  app: ChainApp;
  template: string;
  brief?: string;
  content_mode: 'template' | 'ai';
  sender_stakeholder_id?: string;
  providedUrgency: Urgency;
  providedMinutes: number | null;
}

export function callerRedials(
  stakeholder: { persuadability?: string | null; relationship?: string | null } | null | undefined,
): boolean {
  if (!stakeholder) return false;
  const relationship = (stakeholder.relationship ?? '').toLowerCase();
  if (relationship === 'media' || relationship === 'community' || relationship === 'union') return true;
  const persuadability = stakeholder.persuadability ?? 'medium';
  return persuadability === 'low' || persuadability === 'medium';
}

/** Root phone injects. Low or medium persuadability, and media, community or union, redial. */
export function redialForCaller(
  stakeholder: { persuadability?: string | null; relationship?: string | null } | null | undefined,
  injectKey: string,
): { attempts: number; interval_minutes?: number } {
  if (!callerRedials(stakeholder)) return { attempts: 1 };
  const hash = hashString(injectKey || 'call');
  return {
    attempts: hash % 2 === 0 ? 2 : 3,
    interval_minutes: 2 + (hash % 3),
  };
}

export function applyPhoneRedials<T extends ChaseBranch>(
  injects: readonly T[],
  stakeholders: readonly ChainStakeholder[],
): void {
  const byId = new Map(stakeholders.map((stakeholder) => [stakeholder.id, stakeholder]));
  for (const inject of injects) {
    const config = inject.delivery_config;
    if (!config || config.app !== 'phone_call') continue;
    const id = typeof config.stakeholder_id === 'string' ? config.stakeholder_id : '';
    const key = typeof config.inject_key === 'string' ? config.inject_key : '';
    config.redial = redialForCaller(id ? byId.get(id) : undefined, key);
  }
}

export function isChainRoot(inject: {
  requires_response?: boolean;
  delivery_config?: Record<string, unknown> | null;
}): boolean {
  const config = inject.delivery_config;
  if (!config) return false;
  if (typeof config.branch === 'string' && config.branch) return false;
  if (config.chain && typeof config.chain === 'object') return false;
  const app = config.app;
  if (typeof app !== 'string' || !CHAIN_ROOT_APPS.has(app)) return false;
  const stakeholderId = text(config.stakeholder_id) ?? '';
  const named = isNamedNpc(config);
  if (!stakeholderId && !named) return false;
  if (inject.requires_response === true) return true;
  return Boolean(stakeholderId) && STAKEHOLDER_MESSAGE_APPS.has(app);
}

export function postProcessEscalation(raw: unknown, ctx: ChainRepairContext): ChainRepairResult {
  const repaired = repairEscalation(raw, ctx);
  if (repaired && acceptChain(repaired.config, ctx)) {
    return { escalation: repaired.config, repairs: repaired.repairs, dropped: false };
  }
  const synthesized = synthesizeEscalation(ctx);
  if (synthesized && acceptChain(synthesized, ctx)) {
    return {
      escalation: synthesized,
      repairs: [...(repaired?.repairs ?? []), 'synthesized'],
      dropped: false,
    };
  }
  return {
    escalation: null,
    repairs: [...(repaired?.repairs ?? []), 'dropped'],
    dropped: true,
  };
}

export function isChaseCondition(key: string, parentKey: string): boolean {
  const body = key.split('|')[0] ?? '';
  if (body === `call_missed:${parentKey}` || body === `call_declined:${parentKey}`) return true;
  return CHASE_WITH_WINDOW.some((id) => body.startsWith(`${id}:${parentKey}:`));
}

export function countChasers(
  parentKey: string,
  branches: readonly ChaseBranch[],
  hasChain: boolean,
): number {
  let count = hasChain ? 1 : 0;
  for (const branch of branches) {
    if (appearOf(branch).some((key) => isChaseCondition(key, parentKey))) count += 1;
  }
  return count;
}

/**
 * When a chain exists, drop the other no_reply chasers for that key and keep
 * the final consequence. The chain is the only remaining chaser; on_exhausted
 * publishes the consequence.
 */
export function pruneDoubleChase<T extends ChaseBranch>(
  branches: readonly T[],
  chains: ReadonlyMap<string, EscalationConfig>,
): T[] {
  const dropped = new Set<T>();
  const droppedKeys = new Set<string>();
  for (const [parentKey, escalation] of chains) {
    const noReply = branches.filter(
      (branch) =>
        branch.delivery_config?.branch === 'no_reply' &&
        branch.delivery_config?.parent_inject_key === parentKey,
    );
    if (noReply.length === 0) continue;
    const final = pickFinalConsequence(noReply);
    const finalKey = text(final.delivery_config?.inject_key);
    if (!finalKey) continue;
    for (const branch of noReply) {
      if (branch === final) continue;
      dropped.add(branch);
      const key = text(branch.delivery_config?.inject_key);
      if (key) droppedKeys.add(key);
    }
    retargetConsequence(final, parentKey, droppedKeys);
    escalation.on_exhausted = { publish_inject_key: finalKey };
  }
  return branches.filter((branch) => !dropped.has(branch));
}

/**
 * Stakeholder tier in the contract is `principal` (the default) or `roster`.
 * The spec's "key" stakeholder is principal. `key` is accepted if a caller
 * still sends it. Roster stakeholders are included only when the cast has
 * 8 or fewer people.
 */
export function stakeholdersForLadders<T extends { tier?: string | null }>(
  stakeholders: readonly T[],
): T[] {
  if (stakeholders.length <= 8) return [...stakeholders];
  return stakeholders.filter((stakeholder) => stakeholder.tier !== 'roster');
}

export function escalatedVariantFor(stakeholder: ChainStakeholder): 'angry' | 'disappointed' {
  const relationship = (stakeholder.relationship ?? '').toLowerCase();
  const blob = `${stakeholder.title ?? ''} ${stakeholder.personality ?? ''} ${stakeholder.stance ?? ''}`;
  if (relationship === 'union' || ANGRY_PERSONA.test(blob)) return 'angry';
  if (relationship === 'partner' || DISAPPOINTED_PERSONA.test(blob)) return 'disappointed';
  if (stakeholder.persuadability === 'low') return 'angry';
  return 'disappointed';
}

export function gaveUpMinutes(durationMinutes: number): number | null {
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 1) return null;
  return Math.min(30, Math.max(1, Math.floor(durationMinutes) - 1));
}

export function postProcessMoodLadder(
  raw: unknown,
  input: { stakeholder: ChainStakeholder; goPublicKey: string; durationMinutes: number },
): LadderRepairResult {
  const variant = escalatedVariantFor(input.stakeholder);
  const repaired = repairLadder(raw, input, variant);
  if (repaired && validateMoodLadder({ ladder: repaired.ladder }).length === 0) return repaired;
  return {
    ladder: fallbackLadder(input, variant),
    repairs: [...(repaired?.repairs ?? []), 'synthesized'],
  };
}

export function goPublicKeyFor(stakeholderId: string, taken: Set<string>): string {
  const slug = stakeholderId.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 46);
  const base = `goes_public_${slug || 'stakeholder'}`.slice(0, 60).replace(/_+$/g, '');
  if (isValidInjectKey(base) && !taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let n = 2; n < 1000; n++) {
    const suffix = `_${n}`;
    const candidate = `${base.slice(0, 60 - suffix.length)}${suffix}`;
    if (isValidInjectKey(candidate) && !taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  const fallback = `goes_public_${taken.size}`;
  taken.add(fallback);
  return fallback;
}

/**
 * Press article, not a stakeholder-authored post. Attaching stakeholder_id
 * would require a persona twin and matching author fields, and a miss there
 * fails the whole compile.
 */
export function goPublicInject(
  stakeholder: ChainStakeholder,
  injectKey: string,
  copy?: { title?: string; content?: string },
): {
  trigger_time_minutes: null;
  type: string;
  title: string;
  content: string;
  severity: string;
  inject_scope: string;
  target_teams: string[];
  requires_response: false;
  conditions_to_appear: { all: string[] };
  eligible_after_minutes: number;
  delivery_config: Record<string, unknown>;
} {
  const name = stakeholder.name?.trim() || stakeholder.id;
  const title = copy?.title?.trim() || `${name} goes public`;
  const content =
    copy?.content?.trim() || `${name} stopped waiting for an answer and spoke to the press.`;
  return {
    trigger_time_minutes: null,
    type: 'news_article',
    title,
    content,
    severity: 'high',
    inject_scope: 'universal',
    target_teams: [],
    requires_response: false,
    conditions_to_appear: { all: [`stakeholder_gave_up:${stakeholder.id}`] },
    eligible_after_minutes: 0,
    delivery_config: {
      app: 'news',
      inject_key: injectKey,
      outlet_name: 'City Desk',
      headline: title,
      author_display_name: 'City Desk',
      author_type: 'npc_media',
    },
  };
}

export function teamsMissingCrossChannelChain(
  injects: readonly {
    target_teams?: readonly string[] | null;
    requires_response?: boolean;
    delivery_config?: Record<string, unknown> | null;
  }[],
  stakeholders: readonly ChainStakeholder[],
): string[] {
  const byId = new Map(stakeholders.map((stakeholder) => [stakeholder.id, stakeholder]));
  const heavy = new Set<string>();
  for (const inject of injects) {
    if (!isChainRoot(inject)) continue;
    const id = text(inject.delivery_config?.stakeholder_id);
    const stakeholder = id ? byId.get(id) : undefined;
    for (const team of teamsOf(inject.target_teams, stakeholder)) heavy.add(team);
  }
  const missing: string[] = [];
  for (const team of heavy) {
    const covered = injects.some((inject) => {
      const parsed = escalationOf(inject.delivery_config?.escalation);
      if (!parsed) return false;
      const app = typeof inject.delivery_config?.app === 'string' ? inject.delivery_config.app : '';
      if (!isCrossChannel(app, parsed)) return false;
      const id = text(inject.delivery_config?.stakeholder_id);
      return teamsOf(inject.target_teams, id ? byId.get(id) : undefined).includes(team);
    });
    if (!covered) missing.push(team);
  }
  return missing;
}

function repairEscalation(
  raw: unknown,
  ctx: ChainRepairContext,
): { config: EscalationConfig; repairs: string[] } | null {
  const record = asRecord(raw);
  if (!record || !Array.isArray(record.steps) || record.steps.length === 0) return null;
  const repairs = new Set<string>();
  const hasStakeholder = knownRoot(ctx);
  const loose: LooseStep[] = [];
  for (const step of record.steps) {
    const row = asRecord(step);
    if (!row) continue;
    const providedMinutes = Number.isFinite(Number(row.after_minutes))
      ? Math.floor(Number(row.after_minutes))
      : null;
    const minutes = clampInterval(row.after_minutes);
    if (providedMinutes == null || providedMinutes !== minutes) repairs.add('interval');
    const providedUrgency = asUrgency(row.urgency) ?? 'follow_up';
    const sender = text(row.sender_stakeholder_id);
    let keptSender: string | undefined;
    if (sender) {
      if (!ctx.stakeholders.some((stakeholder) => stakeholder.id === sender)) {
        repairs.add('sender');
      } else if (sender !== ctx.rootStakeholderId) {
        keptSender = sender;
      }
    }
    const template = scrubTemplate(text(row.template) ?? defaultTemplate(providedUrgency));
    const brief = text(row.brief)?.slice(0, 300);
    loose.push({
      after_minutes: minutes,
      urgency: providedUrgency,
      app: coerceChainApp(row.app, ctx.rootApp, hasStakeholder),
      template,
      ...(brief ? { brief } : {}),
      content_mode: row.content_mode === 'ai' && brief ? 'ai' : 'template',
      ...(keptSender ? { sender_stakeholder_id: keptSender } : {}),
      providedUrgency,
      providedMinutes,
    });
  }
  if (loose.length === 0) return null;
  let steps = loose;
  if (steps.length > 4) {
    steps = [...steps.slice(0, 3), steps[steps.length - 1]];
    repairs.add('step_count');
  }
  if (steps.length === 1) {
    steps = [fillerStep(ctx, hasStakeholder), steps[0]];
    repairs.add('step_count');
  }
  ensureLastStep(steps, ctx, repairs);
  ensureChannelChange(steps, ctx.rootApp, repairs);
  raiseUrgencies(steps, repairs);
  const config = toConfig(steps, ctx, publishKey(record, ctx));
  if (!shrinkToFit(config, ctx)) return null;
  return { config, repairs: [...repairs] };
}

function synthesizeEscalation(ctx: ChainRepairContext): EscalationConfig | null {
  const hasStakeholder = knownRoot(ctx);
  const senior = hasStakeholder ? seniorColleague(ctx.rootStakeholderId, ctx.stakeholders) : null;
  const textApp = safeTextApp(ctx.rootApp, hasStakeholder);
  const phoneOrMail: ChainApp =
    hasStakeholder && ctx.rootApp !== 'phone_call' ? 'phone_call' : safeTextApp(textApp, false);
  const last = senior
    ? {
        app: 'email' as ChainApp,
        urgency: 'escalated' as Urgency,
        sender_stakeholder_id: senior.id,
        template: defaultTemplate('escalated'),
      }
    : {
        app: 'social_feed' as ChainApp,
        urgency: 'escalated' as Urgency,
        template:
          'I asked {recipient_team} and I am still waiting. {ask}',
      };
  const plans: Array<Array<{ app: ChainApp; urgency: Urgency; sender_stakeholder_id?: string; template: string }>> =
    [
      [
        { app: textApp, urgency: 'follow_up', template: defaultTemplate('follow_up') },
        { app: phoneOrMail, urgency: 'urgent', template: defaultTemplate('urgent') },
        last,
      ],
      [
        { app: textApp, urgency: 'follow_up', template: defaultTemplate('follow_up') },
        last,
      ],
    ];
  for (const plan of plans) {
    const steps: LooseStep[] = plan.map((step) => ({
      after_minutes: 5,
      urgency: step.urgency,
      app: step.app,
      template: step.template,
      content_mode: 'template' as const,
      ...(step.sender_stakeholder_id ? { sender_stakeholder_id: step.sender_stakeholder_id } : {}),
      providedUrgency: step.urgency,
      providedMinutes: 5,
    }));
    ensureChannelChange(steps, ctx.rootApp, new Set());
    raiseUrgencies(steps, new Set());
    const config = toConfig(steps, ctx, null);
    if (shrinkToFit(config, ctx) && acceptChain(config, ctx)) return config;
  }
  return null;
}

function toConfig(
  steps: readonly LooseStep[],
  ctx: ChainRepairContext,
  publish: string | null,
): EscalationConfig {
  const stakeholder = stakeholderOf(ctx);
  const built = steps.map((step) => {
    const redial =
      resolveConcreteApp(step.app, ctx.rootApp) === 'phone_call'
        ? chainStepRedial(stakeholder)
        : undefined;
    return {
      after_minutes: step.after_minutes,
      urgency: step.urgency,
      app: step.app,
      content_mode: step.content_mode,
      ...(step.content_mode === 'ai' && step.brief ? { brief: step.brief } : { template: step.template }),
      ...(step.sender_stakeholder_id ? { sender_stakeholder_id: step.sender_stakeholder_id } : {}),
      ...(redial ? { redial } : {}),
    };
  });
  return {
    max_steps: built.length,
    scope: 'per_team',
    stop_on: 'any_response',
    stop_on_contact: Boolean(ctx.rootStakeholderId),
    steps: built,
    ...(publish ? { on_exhausted: { publish_inject_key: publish } } : {}),
  };
}

function acceptChain(config: EscalationConfig, ctx: ChainRepairContext): boolean {
  if (!shrinkToFit(config, ctx)) return false;
  return escalationErrors(config, ctx).length === 0;
}

function escalationErrors(config: EscalationConfig, ctx: ChainRepairContext): string[] {
  const { on_exhausted: _ignored, ...rest } = config;
  return validateEscalation({
    escalation: rest,
    rootApp: ctx.rootApp,
    rootStakeholderId: ctx.rootStakeholderId,
    stakeholderIds: ctx.stakeholders.map((stakeholder) => stakeholder.id),
    durationMinutes: ctx.durationMinutes > 0 ? ctx.durationMinutes : null,
    rootKey: ctx.rootKey,
    rootTriggerMinute: ctx.rootTriggerMinute,
    otherInjects: [],
  })
    .filter((issue) => issue.level === 'error')
    .map((issue) => issue.message);
}

function shrinkToFit(config: EscalationConfig, ctx: ChainRepairContext): boolean {
  if (!(ctx.durationMinutes > 0)) return true;
  const available = ctx.durationMinutes - (ctx.rootTriggerMinute ?? 0);
  if (available <= 0) return false;
  let guard = 0;
  while (chainSpanMinutes(config, ctx.rootApp) > available) {
    const largest = [...config.steps].sort((a, b) => b.after_minutes - a.after_minutes)[0];
    if (!largest || largest.after_minutes <= 3) return false;
    largest.after_minutes -= 1;
    guard += 1;
    if (guard > 500) return false;
  }
  return true;
}

function ensureLastStep(steps: LooseStep[], ctx: ChainRepairContext, repairs: Set<string>): void {
  const last = steps[steps.length - 1];
  if (!last) return;
  const concrete = resolveConcreteApp(last.app, ctx.rootApp);
  const senior =
    Boolean(last.sender_stakeholder_id) && last.sender_stakeholder_id !== ctx.rootStakeholderId;
  if (senior || concrete === 'social_feed') {
    last.urgency = 'escalated';
    return;
  }
  const colleague = knownRoot(ctx)
    ? seniorColleague(ctx.rootStakeholderId, ctx.stakeholders)
    : null;
  if (colleague) {
    last.app = 'email';
    last.sender_stakeholder_id = colleague.id;
    last.urgency = 'escalated';
    last.template = last.template || defaultTemplate('escalated');
  } else {
    last.app = 'social_feed';
    delete last.sender_stakeholder_id;
    last.urgency = 'escalated';
    last.template = 'I asked {recipient_team} and I am still waiting. {ask}';
  }
  repairs.add('last_step');
}

function ensureChannelChange(steps: LooseStep[], rootApp: string, repairs: Set<string>): void {
  if (steps.some((step) => resolveConcreteApp(step.app, rootApp) !== rootApp)) return;
  const target = steps.length > 1 ? 0 : steps.length - 1;
  steps[target].app = rootApp === 'messenger_dm' ? 'email' : 'messenger_dm';
  repairs.add('channel');
}

function raiseUrgencies(steps: LooseStep[], repairs: Set<string>): void {
  let previous = -1;
  for (const step of steps) {
    const rank = urgencyRank(step.urgency);
    if (rank < previous) {
      step.urgency = steps[steps.indexOf(step) - 1]?.urgency ?? step.urgency;
      repairs.add('urgency');
    }
    if (step.urgency !== step.providedUrgency) repairs.add('urgency');
    previous = urgencyRank(step.urgency);
  }
}

function fillerStep(ctx: ChainRepairContext, hasStakeholder: boolean): LooseStep {
  const app = safeTextApp(ctx.rootApp, hasStakeholder);
  return {
    after_minutes: 5,
    urgency: 'follow_up',
    app,
    template: defaultTemplate('follow_up'),
    content_mode: 'template',
    providedUrgency: 'follow_up',
    providedMinutes: 5,
  };
}

function chainStepRedial(
  stakeholder: ChainStakeholder | null,
): { attempts: number; interval_minutes: number } {
  if (!callerRedials(stakeholder)) return { attempts: 1, interval_minutes: 2 };
  return { attempts: 2, interval_minutes: 2 };
}

function publishKey(record: Record<string, unknown>, ctx: ChainRepairContext): string | null {
  const exhausted = asRecord(record.on_exhausted);
  const key = text(exhausted?.publish_inject_key);
  if (!key || !ctx.conditionalKeys?.has(key)) return null;
  return key;
}

function pickFinalConsequence<T extends ChaseBranch>(branches: readonly T[]): T {
  for (let index = branches.length - 1; index >= 0; index -= 1) {
    const app = branches[index]?.delivery_config?.app;
    if (app === 'social_feed' || app === 'news') return branches[index];
  }
  return branches[branches.length - 1];
}

function retargetConsequence(branch: ChaseBranch, parentKey: string, droppedKeys: ReadonlySet<string>): void {
  const next = appearOf(branch).filter(
    (key) => !isChaseCondition(key, parentKey) && !mentionsAny(key, droppedKeys),
  );
  branch.conditions_to_appear = {
    all: next.length > 0 ? next : [`chain_exhausted:${parentKey}`],
  };
  if (Array.isArray(branch.conditions_to_cancel)) {
    branch.conditions_to_cancel = branch.conditions_to_cancel.filter((key) => !mentionsAny(key, droppedKeys));
  }
}

function appearOf(branch: ChaseBranch): string[] {
  const appear = branch.conditions_to_appear;
  if (!appear) return [];
  if (Array.isArray(appear.all)) return appear.all;
  if (Array.isArray(appear.conditions)) return appear.conditions;
  return [];
}

function mentionsAny(key: string, injectKeys: ReadonlySet<string>): boolean {
  if (injectKeys.size === 0) return false;
  const parsed = parseConditionKey(key);
  if ('error' in parsed) return false;
  return (parsed.def.params ?? []).some(
    (param, index) => param.type === 'inject_key' && injectKeys.has(parsed.args[index] ?? ''),
  );
}

function repairLadder(
  raw: unknown,
  input: { stakeholder: ChainStakeholder; goPublicKey: string; durationMinutes: number },
  variant: 'angry' | 'disappointed',
): LadderRepairResult | null {
  const record = asRecord(raw);
  if (!record || !Array.isArray(record.rungs)) return null;
  const repairs = new Set<string>();
  const used = new Set<string>();
  const rungs: MoodRung[] = [];
  for (const item of record.rungs) {
    const row = asRecord(item);
    if (!row) continue;
    const id = uniqueRungId(sanitizeRungId(text(row.id) ?? '', `rung`), used);
    rungs.push(normalizeRung(row, id));
  }
  if (rungs.length === 0) return null;
  if (rungs[0]?.terminal) {
    rungs.unshift(baseRung(input.stakeholder));
    repairs.add('base_rung');
  }
  if (rungs[0] && !whenEmpty(rungs[0].when)) {
    rungs[0].when = {};
    repairs.add('first_when');
  }
  if (rungs[0]) rungs[0].terminal = false;
  const terminalIndexes = rungs
    .map((rung, index) => (rung.terminal ? index : -1))
    .filter((index) => index >= 0);
  if (terminalIndexes.length > 1) {
    const keep = terminalIndexes[terminalIndexes.length - 1];
    rungs.forEach((rung, index) => {
      if (index !== keep) delete rung.terminal;
    });
    repairs.add('terminal_last');
  }
  const terminalAt = rungs.findIndex((rung) => rung.terminal);
  if (terminalAt === -1) {
    rungs.push(terminalRung(input.goPublicKey, input.stakeholder));
    repairs.add('terminal_last');
  } else if (terminalAt !== rungs.length - 1) {
    const [terminal] = rungs.splice(terminalAt, 1);
    rungs.push(terminal);
    repairs.add('terminal_last');
  }
  if (rungs.length > 8) {
    const last = rungs[rungs.length - 1];
    rungs.splice(1, rungs.length - 2, ...rungs.slice(1, 7));
    if (rungs[rungs.length - 1] !== last) rungs[rungs.length - 1] = last;
    repairs.add('rung_count');
  }
  ensureVariant(rungs, variant, repairs);
  const terminal = rungs[rungs.length - 1];
  if (terminal) {
    terminal.terminal = true;
    terminal.consequences = [
      ...terminal.consequences.filter((consequence) => consequence.type !== 'publish_inject'),
      { type: 'publish_inject', inject_key: input.goPublicKey },
    ];
  }
  for (const rung of rungs) clampScript(rung);
  const gaveUp = chooseGaveUp(record.gave_up_after_minutes, input.durationMinutes);
  if (gaveUp.changed) repairs.add('gave_up_after');
  const ladder: MoodLadder = {
    gave_up_after_minutes: gaveUp.value,
    escalated_variant: variant,
    recovery: recoveryOf(record.recovery),
    rungs,
  };
  return { ladder, repairs: [...repairs] };
}

function fallbackLadder(
  input: { stakeholder: ChainStakeholder; goPublicKey: string; durationMinutes: number },
  variant: 'angry' | 'disappointed',
): MoodLadder {
  const ladder = defaultLadderFor(variant === 'angry' ? 'low' : 'high');
  const name = input.stakeholder.name?.trim() || 'I';
  const last = ladder.rungs[ladder.rungs.length - 1];
  if (last) {
    last.consequences = [
      ...last.consequences.filter((consequence) => consequence.type !== 'publish_inject'),
      { type: 'publish_inject', inject_key: input.goPublicKey },
      { type: 'stop_chains' },
    ];
    if (!last.script.opening) last.script.opening = `${name} stopped waiting.`;
  }
  for (const rung of ladder.rungs) {
    rung.when = cleanWhen(rung.when);
    if (rung.script.lines.length === 0 && rung.script.opening && rung.id !== 'calm') {
      rung.script.lines = [rung.script.opening];
    }
    clampScript(rung);
  }
  if (ladder.rungs[0]) ladder.rungs[0].when = {};
  ladder.gave_up_after_minutes = gaveUpMinutes(input.durationMinutes);
  ladder.escalated_variant = variant;
  return ladder;
}

function ensureVariant(rungs: MoodRung[], variant: 'angry' | 'disappointed', repairs: Set<string>): void {
  const existing = rungs.find((rung) => rung.id === variant);
  if (existing) {
    existing.variant_of = 'escalated';
    return;
  }
  const rung = normalizeRung(
    {
      id: variant,
      label: variant === 'angry' ? 'Angry' : 'Disappointed',
      when: { any: [{ wait_minutes_gte: 20 }, { missed_calls_gte: 3 }] },
      reply_style:
        variant === 'angry'
          ? 'Angry but not abusive. Short sentences.'
          : 'Quiet and resigned. Says they expected better.',
      script: {
        opening: variant === 'angry' ? 'Who is actually in charge?' : 'I had hoped you would call sooner.',
        lines: ['I need a named person and a time.'],
      },
      consequences: [{ type: 'verdict_lock', value: 'keep' }],
      variant_of: 'escalated',
    },
    variant,
  );
  const terminalAt = rungs.findIndex((item) => item.terminal);
  if (terminalAt >= 0) rungs.splice(terminalAt, 0, rung);
  else rungs.push(rung);
  repairs.add('variant');
}

function baseRung(stakeholder: ChainStakeholder): MoodRung {
  const name = stakeholder.name?.trim() || 'Hello';
  return {
    id: 'calm',
    label: 'Calm',
    when: {},
    reply_style: 'Polite and patient.',
    script: { opening: `${name} here.`, lines: ['I can wait a little.'] },
    consequences: [],
  };
}

function terminalRung(goPublicKey: string, stakeholder: ChainStakeholder): MoodRung {
  const name = stakeholder.name?.trim() || 'I';
  return {
    id: 'gave_up',
    label: 'Gave up',
    when: { all: [{ wait_minutes_gte: 'gave_up_after' }] },
    reply_style: 'Cold and final. Says they stopped waiting.',
    script: {
      opening: `${name} stopped waiting.`,
      lines: ['I have taken this to the press.'],
    },
    consequences: [
      { type: 'publish_inject', inject_key: goPublicKey },
      { type: 'stop_chains' },
    ],
    terminal: true,
  };
}

function normalizeRung(row: Record<string, unknown>, id: string): MoodRung {
  const script = asRecord(row.script) ?? {};
  const lines = Array.isArray(script.lines)
    ? script.lines.filter((line): line is string => typeof line === 'string' && line.trim() !== '')
    : [];
  const consequences = Array.isArray(row.consequences)
    ? row.consequences
        .map((item) => normalizeConsequence(item))
        .filter((item): item is MoodConsequence => item != null)
    : [];
  return {
    id,
    label: text(row.label) ?? id.replace(/_/g, ' '),
    when: whenOf(row.when),
    reply_style: text(row.reply_style) ?? 'Speaks in character.',
    script: {
      opening: text(script.opening),
      lines,
    },
    consequences,
    ...(row.variant_of === 'escalated' ? { variant_of: 'escalated' as const } : {}),
    ...(row.terminal === true ? { terminal: true } : {}),
  };
}

function normalizeConsequence(value: unknown): MoodConsequence | null {
  const row = asRecord(value);
  if (!row || typeof row.type !== 'string' || !CONSEQUENCE_TYPES.has(row.type)) return null;
  if (row.type === 'publish_inject') {
    const key = text(row.inject_key);
    return key ? { type: 'publish_inject', inject_key: key } : null;
  }
  if (row.type === 'verdict_lock') return { type: 'verdict_lock', value: 'keep' };
  if (row.type === 'persuadability') {
    const persuadability = text(row.value) ?? 'low';
    return { type: 'persuadability', value: persuadability };
  }
  if (row.type === 'grievance_append') {
    return { type: 'grievance_append', text: text(row.text) ?? '' };
  }
  if (row.type === 'stop_chains') return { type: 'stop_chains' };
  return { type: 'notify_trainer', ...(text(row.message) ? { message: text(row.message) ?? undefined } : {}) };
}

function clampScript(rung: MoodRung): void {
  if (rung.script.opening && rung.script.opening.length > 300) {
    rung.script.opening = rung.script.opening.slice(0, 300);
  }
  rung.script.lines = rung.script.lines.slice(0, 2).map((line) => line.slice(0, 300));
  if (rung.script.lines.length === 0 && rung.script.opening) {
    rung.script.lines = [rung.script.opening];
  } else if (rung.id !== 'calm' && rung.script.lines.length === 0) {
    rung.script.opening = 'I have been waiting.';
    rung.script.lines = ['I have been waiting.'];
  }
}

function chooseGaveUp(
  raw: unknown,
  durationMinutes: number,
): { value: number | null; changed: boolean } {
  const fit = gaveUpMinutes(durationMinutes);
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) {
    if (!(durationMinutes > 1) || raw < durationMinutes) return { value: raw, changed: false };
  }
  if (raw == null && (!(durationMinutes > 0) || 30 < durationMinutes)) {
    return { value: null, changed: false };
  }
  return { value: fit, changed: true };
}

function recoveryOf(value: unknown): MoodLadder['recovery'] {
  if (value === 'none' || value === 'one_rung_per_good_reply' || value === 'reset_on_good_reply') {
    return value;
  }
  return 'one_rung_per_good_reply';
}

function whenOf(value: unknown): MoodWhen {
  const record = asRecord(value);
  if (!record) return {};
  const when: MoodWhen = {};
  if (Array.isArray(record.all)) when.all = record.all.filter(isCond) as MoodWhen['all'];
  if (Array.isArray(record.any)) when.any = record.any.filter(isCond) as MoodWhen['any'];
  return when;
}

function isCond(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanWhen(when: MoodWhen): MoodWhen {
  const next: MoodWhen = {};
  if (when.all && when.all.length > 0) next.all = when.all;
  if (when.any && when.any.length > 0) next.any = when.any;
  return next;
}

function whenEmpty(when: MoodWhen): boolean {
  return (when.all == null || when.all.length === 0) && (when.any == null || when.any.length === 0);
}

function sanitizeRungId(raw: string, fallback: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30)
    .replace(/_+$/g, '');
  return RUNG_ID_RE.test(slug) ? slug : fallback;
}

function uniqueRungId(base: string, used: Set<string>): string {
  let id = RUNG_ID_RE.test(base) ? base : 'rung';
  let n = 2;
  while (used.has(id)) {
    const suffix = `_${n}`;
    id = `${(RUNG_ID_RE.test(base) ? base : 'rung').slice(0, 30 - suffix.length)}${suffix}`;
    n += 1;
  }
  used.add(id);
  return id;
}

function seniorColleague(
  rootId: string | null,
  stakeholders: readonly ChainStakeholder[],
): ChainStakeholder | null {
  const self = stakeholders.find((stakeholder) => stakeholder.id === rootId);
  if (!self?.organisation) return null;
  const org = self.organisation.trim().toLowerCase();
  return (
    stakeholders.find((stakeholder) => {
      if (stakeholder.id === self.id) return false;
      if ((stakeholder.organisation ?? '').trim().toLowerCase() !== org) return false;
      return SENIOR_TITLE.test(`${stakeholder.title ?? ''} ${stakeholder.name ?? ''}`);
    }) ?? null
  );
}

function knownRoot(ctx: ChainRepairContext): boolean {
  return Boolean(
    ctx.rootStakeholderId &&
      ctx.stakeholders.some((stakeholder) => stakeholder.id === ctx.rootStakeholderId),
  );
}

function stakeholderOf(ctx: ChainRepairContext): ChainStakeholder | null {
  if (!ctx.rootStakeholderId) return null;
  return ctx.stakeholders.find((stakeholder) => stakeholder.id === ctx.rootStakeholderId) ?? null;
}

function safeTextApp(rootApp: string, hasStakeholder: boolean): ChainApp {
  if (hasStakeholder && rootApp !== 'npc_dm') return 'npc_dm';
  if (rootApp !== 'messenger_dm') return 'messenger_dm';
  return 'email';
}

function coerceChainApp(raw: unknown, rootApp: string, hasStakeholder: boolean): ChainApp {
  const app = raw == null ? 'same' : raw;
  if (typeof app !== 'string' || !(CHAIN_APPS as readonly string[]).includes(app)) {
    return hasStakeholder ? 'same' : safeTextApp(rootApp, false);
  }
  const concrete = resolveConcreteApp(app as ChainApp, rootApp);
  if (!concrete) return 'email';
  if ((concrete === 'npc_dm' || concrete === 'phone_call') && !hasStakeholder) {
    return rootApp === 'email' ? 'messenger_dm' : 'email';
  }
  return app as ChainApp;
}

function clampInterval(value: unknown): number {
  const minutes = Math.floor(Number(value));
  if (!Number.isFinite(minutes)) return 5;
  return Math.min(15, Math.max(3, minutes));
}

function asUrgency(value: unknown): Urgency | null {
  return typeof value === 'string' && (URGENCIES as readonly string[]).includes(value)
    ? (value as Urgency)
    : null;
}

function scrubTemplate(template: string): string {
  return template.replace(/\b\d+\s*(?:minutes?|mins?)\b/gi, '{minutes_waiting} minutes');
}

function isCrossChannel(rootApp: string, config: EscalationConfig): boolean {
  return config.steps.some((step) => resolveConcreteApp(step.app, rootApp) !== rootApp);
}

function escalationOf(value: unknown): EscalationConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const steps = (value as { steps?: unknown }).steps;
  if (!Array.isArray(steps) || steps.length === 0) return null;
  return value as EscalationConfig;
}

function teamsOf(
  targetTeams: readonly string[] | null | undefined,
  stakeholder: ChainStakeholder | undefined,
): string[] {
  const listed = (targetTeams ?? []).filter((team) => typeof team === 'string' && team.trim() !== '');
  if (listed.length > 0) return [...listed];
  return stakeholder?.owning_team ? [stakeholder.owning_team] : [];
}

function isNamedNpc(config: Record<string, unknown>): boolean {
  const authorType = typeof config.author_type === 'string' ? config.author_type : '';
  if (text(config.from_name) || text(config.sender_name)) return true;
  return Boolean(text(config.author_display_name)) && authorType.startsWith('npc');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
