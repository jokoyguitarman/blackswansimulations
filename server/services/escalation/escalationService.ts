/**
 * Database side of escalation chains. Missing migration 272 turns the feature off
 * for the rest of the process; callers keep serving the tick and the routes.
 */

import type { Server as SocketServer } from 'socket.io';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../env.js';
import { getWebSocketService } from '../websocketService.js';
import { chatJson } from '../ai/chatClient.js';
import { publishInjectToSession } from '../../routes/injects.js';
import { sessionMinuteAt, type CommsState, type CommsDelivery } from '../ledger/injectLedgerCore.js';
import { collectConditionKeys } from '../conditions/conditionCatalog.js';
import { buildCharacterPrompt, loadScenarioCtx } from '../stakeholderReplyService.js';
import { findById } from '../stakeholderService.js';
import { chainScopeForRole, chainStepHeld } from '../roles/roleCore.js';
import { rolePlayersById } from '../roles/roleService.js';
import { inBootGrace, sessionUserOnline } from '../presence/sessionPresenceService.js';
import { loadCallPolicy } from '../calls/lineService.js';
import {
  composeFollowUp,
  decideChainAction,
  defaultTemplate,
  extractAsk,
  followUpSystemSuffix,
  maxUrgencySent,
  nextDueAfterSend,
  parseEscalation,
  planExhaustPublish,
  planStepMaterialisation,
  renderChainTemplate,
  resolveStep,
  runtimeStepInjectId,
  textLimit,
  appNoun,
  urgencyEffects,
  validateEscalation,
  type ChainClock,
  type ChainDecision,
  type ChainResponseFact,
  type ChainSnapshot,
  type EscalationConfig,
  type EscalationIssue,
  type KnownInjectRef,
  type TemplateVars,
} from './escalationCore.js';
import {
  escalationChainsUnavailable,
  isEscalationSchemaMissing,
  noteEscalationUnavailable,
} from './escalationSchema.js';

export interface ChainStepStore {
  claim(step: {
    chainId: string;
    stepNo: number;
    urgency: string;
    app: string;
    contentMode: string;
  }): Promise<'claimed' | 'exists' | 'unavailable'>;
  /** The step row after a lost insert. Age is how long ago it was claimed. */
  existingStep(chainId: string, stepNo: number): Promise<{ injectId: string | null; ageMs: number } | null>;
  /**
   * Insert the runtime inject. `exists` means this deterministic id is already stored.
   * `failed` means the row was not written and must not be published.
   */
  insertInject(row: Record<string, unknown>): Promise<'inserted' | 'exists' | 'failed'>;
  /**
   * Set inject_id only while it is null. False means another sender owns the step.
   */
  attachInject(chainId: string, stepNo: number, injectId: string): Promise<boolean>;
  publish(injectId: string): Promise<void>;
}

export interface StepDraft {
  chainId: string;
  stepNo: number;
  urgency: string;
  app: string;
  contentMode: string;
  inject: Record<string, unknown>;
}

/**
 * The insert that returns a new step row is the only sender allowed to create the
 * inject. A conflicting claim stops. An abandoned row (no inject id, old enough)
 * may be resumed through the same deterministic inject id.
 */
export async function sendStep(draft: StepDraft, store: ChainStepStore): Promise<{ created: boolean; injectId: string | null }> {
  const claim = await store.claim({
    chainId: draft.chainId,
    stepNo: draft.stepNo,
    urgency: draft.urgency,
    app: draft.app,
    contentMode: draft.contentMode,
  });
  const existing = claim === 'claimed' ? null : await store.existingStep(draft.chainId, draft.stepNo);
  const plan = planStepMaterialisation({
    claim: claim === 'claimed' ? 'won' : claim === 'exists' ? 'lost' : 'unavailable',
    existingInjectId: existing?.injectId ?? null,
    stepAgeMs: existing?.ageMs ?? null,
  });
  if (plan === 'stop') return { created: false, injectId: null };
  if (plan === 'publish_existing') {
    if (!existing?.injectId) return { created: false, injectId: null };
    await store.publish(existing.injectId);
    return { created: false, injectId: existing.injectId };
  }
  const injectId = runtimeStepInjectId(draft.chainId, draft.stepNo);
  const wrote = await store.insertInject({ ...draft.inject, id: injectId });
  if (wrote === 'failed') return { created: false, injectId: null };
  const attached = await store.attachInject(draft.chainId, draft.stepNo, injectId);
  if (!attached) return { created: false, injectId: null };
  await store.publish(injectId);
  return { created: wrote === 'inserted', injectId };
}

export async function startChainForDelivery(input: {
  sessionId: string;
  deliveryId: string;
  injectId: string;
  injectKey: string;
  deliveredMinute: number;
  recipientTeams: string[];
  stakeholderId: string | null;
  targetRoleId: string | null;
  lineTeam: string | null;
  escalation: EscalationConfig;
}): Promise<void> {
  if (chainsOff()) return;
  try {
    const { data: inject, error } = await supabaseAdmin
      .from('scenario_injects')
      .select('id, scenario_id, title, content, type, severity, inject_scope, target_teams, delivery_config')
      .eq('id', input.injectId)
      .maybeSingle();
    if (isEscalationSchemaMissing(error)) {
      noteEscalationUnavailable();
      return;
    }
    const deliveryConfig = (inject?.delivery_config ?? {}) as Record<string, unknown>;
    if (deliveryConfig.chain) return;
    const config = input.escalation;
    if (config.steps.length === 0) return;
    const stakeholderId =
      input.stakeholderId ??
      (typeof deliveryConfig.stakeholder_id === 'string' ? deliveryConfig.stakeholder_id : null);
    const roleId = input.targetRoleId ?? (typeof deliveryConfig.target_role_id === 'string' ? deliveryConfig.target_role_id : null);
    let scopeTeam: string | null =
      config.scope === 'any_recipient'
        ? null
        : input.recipientTeams.length === 1
          ? input.recipientTeams[0]
          : input.lineTeam ?? input.recipientTeams[0] ?? null;
    let scopeRole: string | null = null;
    let scope = config.scope;
    if (roleId) {
      const scoped = chainScopeForRole(roleId, input.lineTeam || scopeTeam || input.recipientTeams[0] || '');
      scopeTeam = scoped.scope_team || null;
      scopeRole = scoped.scope_role;
      scope = 'per_team';
    }
    const { escalation: _ignored, chain: _chain, ...rootConfig } = deliveryConfig;
    const stored = {
      ...config,
      scope,
      scope_role: scopeRole,
      root: {
        minute: input.deliveredMinute,
        title: String(inject?.title ?? 'Follow-up'),
        content: String(inject?.content ?? ''),
        app: typeof rootConfig.app === 'string' ? rootConfig.app : 'email',
        type: String(inject?.type ?? 'message'),
        severity: String(inject?.severity ?? 'medium'),
        inject_scope: String(inject?.inject_scope ?? 'universal'),
        target_teams: Array.isArray(inject?.target_teams) ? inject.target_teams : input.recipientTeams,
        scenario_id: String(inject?.scenario_id ?? ''),
        delivery_config: rootConfig,
      },
    };
    const { error: insertError } = await supabaseAdmin.from('escalation_chains').insert({
      session_id: input.sessionId,
      root_delivery_id: input.deliveryId,
      root_inject_id: input.injectId,
      root_key: input.injectKey,
      scope_team: scopeTeam,
      stakeholder_id: stakeholderId,
      config: stored,
      status: 'active',
      steps_sent: 0,
      max_steps: config.max_steps,
      last_step_delivered_minute: input.deliveredMinute,
      next_due_minute: input.deliveredMinute + config.steps[0].after_minutes,
    });
    if (insertError?.code === '23505') return;
    if (isEscalationSchemaMissing(insertError)) {
      noteEscalationUnavailable();
      return;
    }
    if (insertError) {
      logger.warn({ err: insertError, deliveryId: input.deliveryId }, 'escalation chain was not started');
    }
  } catch (err) {
    if (isEscalationSchemaMissing(err)) noteEscalationUnavailable();
    else logger.warn({ err, deliveryId: input.deliveryId }, 'escalation chain was not started');
  }
}

export async function loadChainIndex(sessionId: string): Promise<Record<string, ChainSnapshot[]>> {
  if (chainsOff()) return {};
  try {
    const { data, error } = await supabaseAdmin
      .from('escalation_chains')
      .select('id, root_key, scope_team, config, status, steps_sent, max_steps, stopped_reason, stopped_minute')
      .eq('session_id', sessionId);
    if (isEscalationSchemaMissing(error)) {
      noteEscalationUnavailable();
      return {};
    }
    if (error || !data) return {};
    const index: Record<string, ChainSnapshot[]> = {};
    for (const row of data) {
      const stored = storedConfig(row.config);
      const snapshot: ChainSnapshot = {
        chain_id: String(row.id),
        scope_team: (row.scope_team as string | null) ?? null,
        scope_role: stored?.scope_role ?? null,
        status: row.status as ChainSnapshot['status'],
        steps_sent: Number(row.steps_sent ?? 0),
        max_steps: Number(row.max_steps ?? 0),
        max_urgency: stored
          ? maxUrgencySent(stored, Number(row.steps_sent ?? 0), stored.root?.app ?? 'email')
          : null,
        stopped_reason: (row.stopped_reason as string | null) ?? null,
        stopped_minute: (row.stopped_minute as number | null) ?? null,
        stopped_after_step: row.status === 'stopped' ? Number(row.steps_sent ?? 0) : null,
      };
      (index[String(row.root_key)] ??= []).push(snapshot);
    }
    return index;
  } catch (err) {
    if (isEscalationSchemaMissing(err)) noteEscalationUnavailable();
    return {};
  }
}

export async function runEscalationChains(input: {
  sessionId: string;
  scenarioId: string;
  trainerId: string | null;
  status: string;
  startTime: string | null;
  elapsedMinutes: number;
  comms: CommsState | null;
  remainingCap: number;
  io: SocketServer | null;
}): Promise<void> {
  if (chainsOff()) return;
  try {
    const { data, error } = await supabaseAdmin
      .from('escalation_chains')
      .select('*')
      .eq('session_id', input.sessionId)
      .eq('status', 'active');
    if (isEscalationSchemaMissing(error)) {
      noteEscalationUnavailable();
      return;
    }
    if (error || !data || data.length === 0) return;
    const rows = [...data].sort((a, b) => {
      const due = Number(a.next_due_minute ?? 0) - Number(b.next_due_minute ?? 0);
      return due || String(a.root_key).localeCompare(String(b.root_key));
    });
    const roles = await rolePlayersById(input.sessionId).catch(() => ({
      players: {} as Record<string, string[]>,
      teams: {} as Record<string, string>,
      names: {} as Record<string, string>,
      vacated: [] as string[],
    }));
    const policy = await loadCallPolicy(input.sessionId).catch(() => ({ offline_grace_seconds: 60 }));
    let remaining = input.remainingCap;
    for (const row of rows) {
      const stored = storedConfig(row.config);
      const parsed = parseEscalation(row.config);
      if (!stored?.root || !parsed) continue;
      const clock = clockFrom(row, parsed, stored);
      const decision = decideChainAction({
        chain: clock,
        responses: responsesFor(input.comms, clock.root_key),
        contactMinute: contactMinute(input.comms, clock.stakeholder_id),
        callGroup: clock.waiting_on_call_group_id
          ? await loadCallGroup(clock.waiting_on_call_group_id, input.startTime, input.elapsedMinutes)
          : null,
        elapsed: input.elapsedMinutes,
        sessionStatus: input.status,
        gaveUpStopChains: gaveUp(input.comms, clock),
        held: roleHeld(input.sessionId, clock.scope_role, roles.players, policy.offline_grace_seconds),
        rolePlayerIds: clock.scope_role ? roles.players[clock.scope_role] ?? [] : [],
      });
      const spent = await applyDecision({
        row,
        stored,
        clock,
        decision,
        elapsed: input.elapsedMinutes,
        sessionId: input.sessionId,
        scenarioId: input.scenarioId,
        trainerId: input.trainerId,
        startTime: input.startTime,
        comms: input.comms,
        io: input.io,
        remaining,
      });
      remaining -= spent;
    }
  } catch (err) {
    if (isEscalationSchemaMissing(err)) noteEscalationUnavailable();
    else logger.warn({ err, sessionId: input.sessionId }, 'escalation chain tick failed');
  }
}

export async function listEscalations(sessionId: string): Promise<Record<string, unknown>[]> {
  if (chainsOff()) return [];
  const { data, error } = await supabaseAdmin
    .from('escalation_chains')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  if (isEscalationSchemaMissing(error)) {
    noteEscalationUnavailable();
    return [];
  }
  if (error || !data) return [];
  const ids = data.map((row) => String(row.id));
  const steps = ids.length
    ? await supabaseAdmin
        .from('escalation_chain_steps')
        .select('chain_id, step_no, urgency, app, delivered_minute, inject_id')
        .in('chain_id', ids)
    : { data: [], error: null };
  if (isEscalationSchemaMissing(steps.error)) {
    noteEscalationUnavailable();
    return [];
  }
  const byChain = new Map<string, Record<string, unknown>[]>();
  for (const step of steps.data ?? []) {
    const list = byChain.get(String(step.chain_id)) ?? [];
    list.push({
      step_no: step.step_no,
      urgency: step.urgency,
      app: step.app,
      delivered_minute: step.delivered_minute,
      inject_id: step.inject_id,
    });
    byChain.set(String(step.chain_id), list);
  }
  return data.map((row) => {
    const stored = storedConfig(row.config);
    return {
      chain_id: row.id,
      root_key: row.root_key,
      root_title: stored?.root?.title ?? null,
      scope_team: row.scope_team,
      stakeholder_id: row.stakeholder_id,
      status: row.status,
      steps_sent: row.steps_sent,
      max_steps: row.max_steps,
      next_due_minute: row.next_due_minute,
      steps: (byChain.get(String(row.id)) ?? []).sort(
        (a, b) => Number(a.step_no) - Number(b.step_no),
      ),
      ...(row.stopped_reason ? { stopped_reason: row.stopped_reason } : {}),
      ...(row.stopped_minute != null ? { stopped_minute: row.stopped_minute } : {}),
    };
  });
}

export async function stopEscalation(input: {
  sessionId: string;
  chainId: string;
  trainerId: string | null;
}): Promise<boolean> {
  if (chainsOff()) return false;
  const { data, error } = await supabaseAdmin
    .from('escalation_chains')
    .select('id, status, waiting_on_call_group_id, root_key')
    .eq('id', input.chainId)
    .eq('session_id', input.sessionId)
    .maybeSingle();
  if (isEscalationSchemaMissing(error)) {
    noteEscalationUnavailable();
    return false;
  }
  if (!data || data.status !== 'active') return false;
  if (data.waiting_on_call_group_id) {
    await cancelScheduledRedials(String(data.waiting_on_call_group_id), 'chain_stopped', input.trainerId);
  }
  const minute = await currentMinute(input.sessionId);
  const { error: updateError } = await supabaseAdmin
    .from('escalation_chains')
    .update({
      status: 'stopped',
      stopped_reason: 'trainer',
      stopped_minute: minute,
      waiting_on_call_group_id: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.chainId)
    .eq('status', 'active');
  if (updateError) return false;
  emitTrainer(input.trainerId, 'escalation.stopped', {
    chain_id: input.chainId,
    reason: 'trainer',
    minute,
  });
  return true;
}

export async function cancelSessionChains(sessionId: string): Promise<void> {
  if (chainsOff()) return;
  try {
    const minute = await currentMinute(sessionId);
    const { error } = await supabaseAdmin
      .from('escalation_chains')
      .update({
        status: 'cancelled',
        stopped_reason: 'session_ended',
        stopped_minute: minute,
        waiting_on_call_group_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq('session_id', sessionId)
      .eq('status', 'active');
    if (isEscalationSchemaMissing(error)) noteEscalationUnavailable();
  } catch (err) {
    if (isEscalationSchemaMissing(err)) noteEscalationUnavailable();
  }
}

export async function inspectEscalation(input: {
  scenarioId: string;
  deliveryConfig: unknown;
  triggerTimeMinutes: number | null;
  injectId?: string | null;
}): Promise<EscalationIssue[]> {
  const record =
    input.deliveryConfig && typeof input.deliveryConfig === 'object'
      ? (input.deliveryConfig as Record<string, unknown>)
      : null;
  if (!record || record.escalation == null) return [];
  const loaded = await loadScenarioFacts(input.scenarioId, input.injectId ?? null);
  return validateEscalation({
    escalation: record.escalation,
    rootApp: typeof record.app === 'string' ? record.app : null,
    rootStakeholderId: typeof record.stakeholder_id === 'string' ? record.stakeholder_id : null,
    stakeholderIds: loaded.stakeholderIds,
    durationMinutes: loaded.durationMinutes,
    rootKey: typeof record.inject_key === 'string' ? record.inject_key : null,
    rootTriggerMinute: input.triggerTimeMinutes,
    otherInjects: loaded.injects,
  });
}

interface StoredRoot {
  minute: number;
  title: string;
  content: string;
  app: string;
  type: string;
  severity: string;
  inject_scope: string;
  target_teams: string[];
  scenario_id: string;
  delivery_config: Record<string, unknown>;
}

interface StoredChain extends EscalationConfig {
  scope_role?: string | null;
  root?: StoredRoot;
  _runtime?: { hold_through_minute?: number | null };
}

function storedConfig(value: unknown): StoredChain | null {
  const parsed = parseEscalation(value);
  if (!parsed || !value || typeof value !== 'object') return null;
  const raw = value as StoredChain;
  return {
    ...parsed,
    scope: raw.scope === 'any_recipient' ? 'any_recipient' : parsed.scope,
    scope_role: typeof raw.scope_role === 'string' ? raw.scope_role : null,
    root: raw.root,
    _runtime: raw._runtime,
  };
}

function clockFrom(row: Record<string, unknown>, config: EscalationConfig, stored: StoredChain): ChainClock {
  return {
    scope: config.scope,
    scope_team: (row.scope_team as string | null) ?? null,
    scope_role: stored.scope_role ?? null,
    root_key: String(row.root_key),
    root_delivery_id: String(row.root_delivery_id),
    stakeholder_id: (row.stakeholder_id as string | null) ?? null,
    stop_on: config.stop_on,
    stop_on_contact: config.stop_on_contact && Boolean(row.stakeholder_id),
    steps_sent: Number(row.steps_sent ?? 0),
    max_steps: Number(row.max_steps ?? config.max_steps),
    last_step_delivered_minute: Number(row.last_step_delivered_minute ?? 0),
    next_due_minute: (row.next_due_minute as number | null) ?? null,
    waiting_on_call_group_id: (row.waiting_on_call_group_id as string | null) ?? null,
    hold_through_minute: stored._runtime?.hold_through_minute ?? null,
    root_minute: stored.root?.minute ?? Number(row.last_step_delivered_minute ?? 0),
    root_app: stored.root?.app ?? 'email',
    config,
  };
}

function responsesFor(comms: CommsState | null, rootKey: string): ChainResponseFact[] {
  const deliveries = comms?.by_key?.[rootKey] ?? [];
  const facts: ChainResponseFact[] = [];
  for (const delivery of deliveries) {
    for (const response of delivery.responses) {
      facts.push({
        id: response.id,
        minute: response.minute,
        team: response.team,
        user_id: response.user_id,
        judgement_status: response.judgement_status,
        judgement: response.judgement,
        delivery_id: delivery.delivery_id,
        inject_key: delivery.inject_key,
        chain_step: delivery.chain_step,
        chain_root_delivery_id: delivery.chain_root_delivery_id ?? null,
        chain_root_key: delivery.chain_root_key,
        recipient_teams: delivery.recipient_teams,
        fallback_reason: delivery.fallback_reason ?? null,
      });
    }
  }
  return facts;
}

function contactMinute(comms: CommsState | null, stakeholderId: string | null): number | null {
  if (!comms || !stakeholderId) return null;
  const contact = comms.stakeholder_contacts?.[stakeholderId];
  if (!contact) return null;
  return contact.latest_minute ?? contact.first_minute;
}

function gaveUp(comms: CommsState | null, clock: ChainClock): boolean {
  const stops = comms?.mood_stops;
  if (!stops) return false;
  const keys = [
    clock.stakeholder_id,
    clock.scope_role ? `role:${clock.scope_role}` : null,
    clock.scope_team,
  ].filter((key): key is string => Boolean(key));
  return keys.some((key) => stops[key]?.stop_chains === true);
}

function roleHeld(
  sessionId: string,
  roleId: string | null,
  players: Record<string, string[]>,
  graceSeconds: number,
): boolean {
  if (!roleId || !env.runBackgroundEngines || inBootGrace()) return false;
  const assigned = players[roleId] ?? [];
  if (assigned.length === 0) return false;
  const offline = assigned.every((userId) => !sessionUserOnline(sessionId, userId, graceSeconds));
  return chainStepHeld({ roleTargeted: true, allPlayersOfflinePastGrace: offline });
}

async function applyDecision(input: {
  row: Record<string, unknown>;
  stored: StoredChain;
  clock: ChainClock;
  decision: ChainDecision;
  elapsed: number;
  sessionId: string;
  scenarioId: string;
  trainerId: string | null;
  startTime: string | null;
  comms: CommsState | null;
  io: SocketServer | null;
  remaining: number;
}): Promise<number> {
  const id = String(input.row.id);
  if (input.decision.kind === 'cancel') {
    await patchChain(id, {
      status: 'cancelled',
      stopped_reason: 'session_ended',
      stopped_minute: input.elapsed,
      waiting_on_call_group_id: null,
    });
    return 0;
  }
  if (input.decision.kind === 'stop') {
    if (input.clock.waiting_on_call_group_id) {
      await cancelScheduledRedials(input.clock.waiting_on_call_group_id, 'chain_stopped', input.trainerId);
    }
    await patchChain(id, {
      status: 'stopped',
      stopped_reason: input.decision.reason,
      stopped_by_response_id: input.decision.responseId ?? null,
      stopped_minute: input.elapsed,
      waiting_on_call_group_id: null,
    });
    emitTrainer(input.trainerId, 'escalation.stopped', {
      chain_id: id,
      reason: input.decision.reason,
      minute: input.elapsed,
    });
    return 0;
  }
  if (input.decision.kind === 'reset') {
    await patchChain(id, { next_due_minute: input.decision.nextDueMinute });
    return 0;
  }
  if (input.decision.kind === 'wait') {
    const patch: Record<string, unknown> = {};
    const stored = { ...input.stored };
    if (input.decision.clearCall) {
      patch.waiting_on_call_group_id = null;
      patch.last_step_delivered_minute = input.decision.lastStepMinute ?? input.clock.last_step_delivered_minute;
    }
    if (input.decision.nextDueMinute != null) patch.next_due_minute = input.decision.nextDueMinute;
    if (input.decision.held) {
      stored._runtime = { hold_through_minute: input.decision.holdThroughMinute ?? input.elapsed };
      patch.config = stored;
    } else if (stored._runtime?.hold_through_minute != null) {
      stored._runtime = { hold_through_minute: null };
      patch.config = stored;
    }
    if (Object.keys(patch).length > 0) await patchChain(id, patch);
    return 0;
  }
  if (input.decision.kind === 'exhaust') {
    const key = input.clock.config.on_exhausted?.publish_inject_key;
    const outcome = !key
      ? ('no_key' as const)
      : input.remaining <= 0
        ? ('deferred' as const)
        : await publishTemplateKey(input, key);
    const plan = planExhaustPublish(outcome);
    if (plan === 'retry') {
      if (outcome === 'transient') {
        logger.warn(
          { event: 'escalation_exhaust_retry', sessionId: input.sessionId, chainId: id, key },
          'Exhausted chain stays active until its consequence inject is published',
        );
      } else {
        logger.info(
          { event: 'escalation_publish_deferred', sessionId: input.sessionId, chainId: id },
          'Exhausted chain publish deferred to a later tick',
        );
      }
      return 0;
    }
    await patchChain(id, { status: 'exhausted', next_due_minute: null, waiting_on_call_group_id: null });
    if (plan === 'mark_unresolved') {
      logger.warn(
        { event: 'escalation_exhaust_unresolved', sessionId: input.sessionId, chainId: id, key },
        'Exhaust consequence does not match a conditional inject; the chain is exhausted',
      );
    }
    emitTrainer(input.trainerId, 'escalation.exhausted', {
      chain_id: id,
      root_key: input.clock.root_key,
      ...(plan === 'mark_unresolved' ? { unresolved_key: key } : {}),
    });
    return plan === 'mark' && key ? 1 : 0;
  }
  if (input.remaining <= 0) {
    logger.info(
      { event: 'escalation_publish_deferred', sessionId: input.sessionId, chainId: id, stepNo: input.decision.stepNo },
      'Chain step deferred to a later tick',
    );
    return 0;
  }
  const sent = await deliverStep(input, input.decision.stepNo);
  return sent ? 1 : 0;
}

async function deliverStep(
  input: {
    row: Record<string, unknown>;
    stored: StoredChain;
    clock: ChainClock;
    elapsed: number;
    sessionId: string;
    scenarioId: string;
    trainerId: string | null;
    comms: CommsState | null;
    io: SocketServer | null;
    decision: ChainDecision;
  },
  stepNo: number,
): Promise<boolean> {
  const root = input.stored.root;
  if (!root) return false;
  const step = resolveStep(input.clock.config, stepNo, root.app);
  if (!step) return false;
  const vars = templateVars(input, stepNo, root);
  const rendered = await renderFollowUp({
    sessionId: input.sessionId,
    scenarioId: root.scenario_id || input.scenarioId,
    step,
    vars,
    stakeholderId: step.sender_stakeholder_id ?? input.clock.stakeholder_id,
  });
  const composed = composeFollowUp({
    app: step.appResolved,
    urgency: step.urgency,
    text: rendered.text,
    originalSubject: vars.original_subject,
  });
  const effects = urgencyEffects(step.urgency);
  const teams = stepTeams(step, input.clock.scope_team, root.target_teams);
  const thread = step.appResolved === 'email' ? await emailThread(input.clock.root_delivery_id) : null;
  const base = { ...root.delivery_config };
  delete base.escalation;
  delete base.chain;
  const senderId = step.sender_stakeholder_id ?? (typeof base.stakeholder_id === 'string' ? base.stakeholder_id : null);
  const deliveryConfig: Record<string, unknown> = {
    ...base,
    app: step.appResolved,
    inject_key: `${input.clock.root_key}__s${stepNo}`,
    priority: step.appResolved === 'email' ? effects.emailPriority : base.priority,
    ...(senderId ? { stakeholder_id: senderId } : {}),
    ...(step.appResolved === 'phone_call'
      ? {
          redial: step.redial ?? { attempts: 1 },
          ring_seconds: clampRing(Number(base.ring_seconds ?? 30) + effects.ringSecondsExtra),
          target_role_id: input.clock.scope_role ?? base.target_role_id,
          role_fallback: base.role_fallback ?? 'none',
          call_target: base.call_target,
        }
      : {}),
    ...(input.clock.scope_role
      ? { target_role_id: input.clock.scope_role, role_fallback: base.role_fallback ?? 'none' }
      : {}),
    ...(step.appResolved === 'social_feed'
      ? {
          content_flags: { ...(base.content_flags as object | undefined), is_organized_pressure: false },
          virality_score: effects.viralityScore,
          ...(await socialAuthor(root.scenario_id || input.scenarioId, senderId)),
        }
      : {}),
    chain: {
      chain_id: String(input.row.id),
      root_delivery_id: input.clock.root_delivery_id,
      root_key: input.clock.root_key,
      step: stepNo,
      urgency: step.urgency,
      ...(thread?.threadId ? { thread_id: thread.threadId } : {}),
      ...(thread?.repliedToId ? { replied_to_id: thread.repliedToId } : {}),
    },
  };
  const draft: StepDraft = {
    chainId: String(input.row.id),
    stepNo,
    urgency: step.urgency,
    app: step.appResolved,
    contentMode: rendered.mode,
    inject: {
      scenario_id: root.scenario_id || input.scenarioId,
      session_id: input.sessionId,
      type: step.appResolved,
      title: composed.title,
      content: composed.content,
      severity: root.severity || 'medium',
      inject_scope: teams.length > 0 ? 'team_specific' : 'universal',
      target_teams: teams,
      trigger_time_minutes: null,
      conditions_to_appear: null,
      conditions_to_cancel: null,
      requires_response: true,
      ai_generated: rendered.mode === 'ai',
      generation_source: 'escalation_chain',
      delivery_config: deliveryConfig,
    },
  };
  const io = await resolveIo(input.io);
  const result = await sendStep(draft, supabaseStepStore(input.sessionId, input.trainerId, io));
  if (!result.injectId) return false;
  if (input.clock.steps_sent >= stepNo) return false;
  const groupId = step.appResolved === 'phone_call' ? await callGroupForInject(result.injectId) : null;
  const following = resolveStep(input.clock.config, stepNo + 1, root.app);
  const followingAfter =
    stepNo >= input.clock.max_steps ? step.after_minutes : following?.after_minutes ?? step.after_minutes;
  const nextDue = groupId
    ? null
    : nextDueAfterSend({
        elapsed: input.elapsed,
        nextDueMinute: input.clock.next_due_minute,
        sentAfterMinutes: step.after_minutes,
        followingAfterMinutes: followingAfter,
      });
  const stored = { ...input.stored, _runtime: { hold_through_minute: null } };
  await patchChain(String(input.row.id), {
    steps_sent: input.clock.steps_sent + 1,
    last_step_delivered_minute: input.elapsed,
    next_due_minute: nextDue,
    waiting_on_call_group_id: groupId,
    config: stored,
  });
  await supabaseAdmin
    .from('escalation_chain_steps')
    .update({ delivered_minute: input.elapsed, inject_id: result.injectId })
    .eq('chain_id', input.row.id)
    .eq('step_no', stepNo);
  emitTrainer(input.trainerId, 'escalation.step_sent', {
    chain_id: String(input.row.id),
    root_key: input.clock.root_key,
    step_no: stepNo,
    urgency: step.urgency,
    app: step.appResolved,
    scope_team: input.clock.scope_team,
  });
  return true;
}

function templateVars(
  input: { clock: ChainClock; elapsed: number; comms: CommsState | null },
  stepNo: number,
  root: StoredRoot,
): TemplateVars {
  const subject = emailSubject(root.content, root.title);
  const team = input.clock.scope_team || root.target_teams[0] || 'the team';
  return {
    sender_name: senderName(root),
    recipient_team: team,
    original_subject: subject,
    ask: extractAsk(root.content, root.title),
    minutes_waiting: Math.max(0, input.elapsed - input.clock.root_minute),
    root_minute: input.clock.root_minute,
    followups_sent: input.clock.steps_sent,
    missed_calls: missedCalls(input.comms, input.clock.root_key),
    step: stepNo,
    max_steps: input.clock.max_steps,
  };
}

async function renderFollowUp(input: {
  sessionId: string;
  scenarioId: string;
  step: NonNullable<ReturnType<typeof resolveStep>>;
  vars: TemplateVars;
  stakeholderId: string | null;
}): Promise<{ text: string; mode: 'template' | 'ai' }> {
  const fallback = () =>
    renderChainTemplate(input.step.template ?? defaultTemplate(input.step.urgency), {
      ...input.vars,
      ask: input.vars.ask || 'an answer',
    });
  if (input.step.content_mode !== 'ai') return { text: fallback(), mode: 'template' };
  try {
    const stakeholder = input.stakeholderId ? await findById(input.scenarioId, input.stakeholderId) : null;
    const ctx = await loadScenarioCtx(input.scenarioId);
    const character = stakeholder ? buildCharacterPrompt(stakeholder, [], ctx) : '';
    const suffix = followUpSystemSuffix({
      appNoun: appNoun(input.step.appResolved),
      recipientTeam: input.vars.recipient_team,
      urgency: input.step.urgency,
      brief: input.step.brief ?? '',
      minutesWaiting: input.vars.minutes_waiting,
      followupsSent: input.vars.followups_sent,
      missedCalls: input.vars.missed_calls,
      limit: textLimit(input.step.appResolved),
    });
    const parsed = await chatJson<{ subject?: string; text?: string }>({
      tier: 'fast',
      temperature: 0.7,
      maxTokens: 300,
      timeoutMs: 10000,
      label: 'escalation.followup',
      budgetKey: `escalation:${input.sessionId}`,
      budgetLimit: env.escalationAiBudgetPerSessionHour,
      messages: [
        { role: 'system', content: `${character}\n${suffix}`.trim() },
        { role: 'user', content: 'Write the follow-up now.' },
      ],
    });
    const text = typeof parsed?.text === 'string' ? parsed.text.trim() : '';
    if (!text) return { text: fallback(), mode: 'template' };
    const subject = typeof parsed?.subject === 'string' ? parsed.subject.trim() : '';
    const withSubject =
      input.step.appResolved === 'email' && subject && !text.startsWith('Subject:')
        ? `Subject: ${subject}\n${text}`
        : text;
    return { text: withSubject.slice(0, textLimit(input.step.appResolved) + 80), mode: 'ai' };
  } catch (err) {
    logger.warn({ err, sessionId: input.sessionId }, 'escalation follow-up fell back to the template');
    return { text: fallback(), mode: 'template' };
  }
}

function supabaseStepStore(sessionId: string, trainerId: string | null, io: SocketServer): ChainStepStore {
  return {
    async claim(step) {
      const { data, error } = await supabaseAdmin
        .from('escalation_chain_steps')
        .insert({
          chain_id: step.chainId,
          step_no: step.stepNo,
          urgency: step.urgency,
          app: step.app,
          content_mode: step.contentMode,
        })
        .select('step_no')
        .maybeSingle();
      if (error?.code === '23505') return 'exists';
      if (error || !data) {
        if (isEscalationSchemaMissing(error)) noteEscalationUnavailable();
        else if (error) logger.warn({ err: error, chainId: step.chainId }, 'escalation step was not claimed');
        return 'unavailable';
      }
      return 'claimed';
    },
    async existingStep(chainId, stepNo) {
      const { data } = await supabaseAdmin
        .from('escalation_chain_steps')
        .select('inject_id, created_at')
        .eq('chain_id', chainId)
        .eq('step_no', stepNo)
        .maybeSingle();
      if (!data) return null;
      const created = Date.parse(String(data.created_at ?? ''));
      const ageMs = Number.isFinite(created) ? Math.max(0, Date.now() - created) : 0;
      return { injectId: (data.inject_id as string | null) ?? null, ageMs };
    },
    async insertInject(row) {
      const { data, error } = await supabaseAdmin.from('scenario_injects').insert(row).select('id').maybeSingle();
      if (!error && data) return 'inserted';
      if (error?.code === '23505') return 'exists';
      logger.warn({ err: error, sessionId }, 'escalation runtime inject was not created');
      return 'failed';
    },
    async attachInject(chainId, stepNo, injectId) {
      const { data, error } = await supabaseAdmin
        .from('escalation_chain_steps')
        .update({ inject_id: injectId })
        .eq('chain_id', chainId)
        .eq('step_no', stepNo)
        .is('inject_id', null)
        .select('step_no');
      if (error) return false;
      return (data?.length ?? 0) > 0;
    },
    async publish(injectId) {
      await publishInjectToSession(injectId, sessionId, trainerId ?? injectId, io, { awaitDelivery: true });
    },
  };
}

async function publishTemplateKey(
  input: { scenarioId: string; sessionId: string; trainerId: string | null; io: SocketServer | null },
  key: string,
): Promise<'published' | 'unresolved' | 'transient'> {
  const { data, error } = await supabaseAdmin
    .from('scenario_injects')
    .select('id, trigger_time_minutes')
    .eq('scenario_id', input.scenarioId)
    .is('session_id', null)
    .eq('delivery_config->>inject_key', key)
    .limit(1)
    .maybeSingle();
  if (error) return 'transient';
  if (!data || data.trigger_time_minutes != null) return 'unresolved';
  try {
    const io = await resolveIo(input.io);
    await publishInjectToSession(String(data.id), input.sessionId, input.trainerId ?? String(data.id), io);
    return 'published';
  } catch (err) {
    logger.warn({ err, sessionId: input.sessionId, key }, 'exhaust inject publish failed');
    return 'transient';
  }
}

async function socialAuthor(
  scenarioId: string,
  stakeholderId: string | null,
): Promise<Record<string, string>> {
  if (!stakeholderId) return {};
  try {
    const stakeholder = await findById(scenarioId, stakeholderId);
    if (!stakeholder?.handle || !stakeholder.name) return {};
    return {
      author_handle: stakeholder.handle,
      author_display_name: stakeholder.name,
      author_type: 'npc_public',
    };
  } catch (err) {
    logger.warn({ err, scenarioId, stakeholderId }, 'social follow-up could not load its stakeholder');
    return {};
  }
}

async function emailThread(rootDeliveryId: string): Promise<{ threadId: string | null; repliedToId: string | null } | null> {
  const root = await supabaseAdmin
    .from('inject_deliveries')
    .select('channel, ref_id')
    .eq('id', rootDeliveryId)
    .maybeSingle();
  if (root.error || root.data?.channel !== 'email' || !root.data.ref_id) return null;
  const previous = await supabaseAdmin
    .from('inject_deliveries')
    .select('ref_id')
    .eq('chain_root_delivery_id', rootDeliveryId)
    .eq('channel', 'email')
    .order('delivered_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return {
    threadId: String(root.data.ref_id),
    repliedToId: previous.data?.ref_id ? String(previous.data.ref_id) : String(root.data.ref_id),
  };
}

async function callGroupForInject(injectId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('sim_calls')
    .select('call_group_id')
    .eq('inject_id', injectId)
    .order('attempt_no', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error || !data?.call_group_id) return null;
  return String(data.call_group_id);
}

async function loadCallGroup(
  groupId: string,
  startTime: string | null,
  elapsed: number,
): Promise<{ finished: boolean; finish_minute: number | null; answered: boolean }> {
  const { data, error } = await supabaseAdmin
    .from('sim_calls')
    .select('status, ended_at, answered_by')
    .eq('call_group_id', groupId);
  if (error || !data || data.length === 0) {
    return { finished: true, finish_minute: elapsed, answered: false };
  }
  const answered = data.some(
    (row) =>
      Boolean(row.answered_by) || row.status === 'ended' || row.status === 'connecting' || row.status === 'active',
  );
  const open = data.some((row) =>
    ['scheduled', 'ringing', 'connecting', 'active'].includes(String(row.status)),
  );
  let finish: number | null = null;
  for (const row of data) {
    if (!row.ended_at || !startTime) continue;
    const minute = sessionMinuteAt(startTime, String(row.ended_at));
    if (finish == null || minute > finish) finish = minute;
  }
  return { finished: !open, finish_minute: finish ?? elapsed, answered };
}

async function cancelScheduledRedials(groupId: string, reason: string, trainerId: string | null): Promise<void> {
  const { data } = await supabaseAdmin
    .from('sim_calls')
    .select('id, recipient_user_ids')
    .eq('call_group_id', groupId)
    .eq('status', 'scheduled');
  await supabaseAdmin
    .from('sim_calls')
    .update({ status: 'cancelled', end_reason: reason, ended_at: new Date().toISOString() })
    .eq('call_group_id', groupId)
    .eq('status', 'scheduled');
  const recipients = new Set<string>();
  if (trainerId) recipients.add(trainerId);
  for (const row of data ?? []) {
    for (const userId of (row.recipient_user_ids as string[] | null) ?? []) recipients.add(userId);
  }
  const payload = {
    type: 'sim_call.redial_cancelled',
    data: { call_group_id: groupId, reason },
    timestamp: new Date().toISOString(),
  };
  for (const userId of recipients) getWebSocketService().emitToUser(userId, payload);
}

async function patchChain(id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabaseAdmin
    .from('escalation_chains')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (isEscalationSchemaMissing(error)) noteEscalationUnavailable();
  else if (error) logger.warn({ err: error, chainId: id }, 'escalation chain update failed');
}

async function loadScenarioFacts(
  scenarioId: string,
  injectId: string | null,
): Promise<{ stakeholderIds: string[] | null; durationMinutes: number | null; injects: KnownInjectRef[] }> {
  try {
    const scenario = await supabaseAdmin
      .from('scenarios')
      .select('duration_minutes, initial_state')
      .eq('id', scenarioId)
      .maybeSingle();
    const injects = await supabaseAdmin
      .from('scenario_injects')
      .select('id, trigger_time_minutes, conditions_to_appear, conditions_to_cancel, delivery_config')
      .eq('scenario_id', scenarioId)
      .is('session_id', null);
    const stakeholders = (scenario.data?.initial_state as { stakeholders?: Array<{ id?: string }> } | null)
      ?.stakeholders;
    const ids = Array.isArray(stakeholders)
      ? stakeholders.map((row) => row?.id).filter((id): id is string => typeof id === 'string')
      : null;
    const known: KnownInjectRef[] = [];
    for (const row of injects.data ?? []) {
      if (injectId && row.id === injectId) continue;
      const config = row.delivery_config as { inject_key?: unknown } | null;
      const key = typeof config?.inject_key === 'string' ? config.inject_key : '';
      known.push({
        key,
        trigger_time_minutes: (row.trigger_time_minutes as number | null) ?? null,
        condition_keys: collectConditionKeys(row.conditions_to_appear, row.conditions_to_cancel),
      });
    }
    return {
      stakeholderIds: scenario.error ? null : ids,
      durationMinutes: (scenario.data?.duration_minutes as number | null) ?? null,
      injects: known.filter((row) => row.key),
    };
  } catch (err) {
    logger.warn({ err, scenarioId }, 'escalation validation could not read the scenario');
    return { stakeholderIds: null, durationMinutes: null, injects: [] };
  }
}

async function currentMinute(sessionId: string): Promise<number> {
  const { data } = await supabaseAdmin.from('sessions').select('start_time').eq('id', sessionId).maybeSingle();
  return sessionMinuteAt(data?.start_time as string | null, new Date().toISOString());
}

async function resolveIo(io: SocketServer | null): Promise<SocketServer> {
  if (io) return io;
  const imported = await import('../../index.js');
  return imported.io;
}

function emitTrainer(trainerId: string | null, type: string, data: Record<string, unknown>): void {
  if (!trainerId) return;
  getWebSocketService().emitToUser(trainerId, { type, data, timestamp: new Date().toISOString() });
}

function stepTeams(step: { target_team?: string; cc_team?: string }, scopeTeam: string | null, rootTeams: string[]): string[] {
  const primary = step.target_team ? [step.target_team] : scopeTeam ? [scopeTeam] : rootTeams;
  const extra = step.cc_team && !primary.includes(step.cc_team) ? [step.cc_team] : [];
  return [...primary, ...extra].filter(Boolean);
}

function emailSubject(content: string, title: string): string {
  const line = content.split('\n').find((row) => row.startsWith('Subject:'));
  if (!line) return title;
  return line.replace(/^Subject:\s*/, '').trim() || title;
}

function senderName(root: StoredRoot): string {
  const config = root.delivery_config;
  const name = config.from_name ?? config.sender_name ?? config.author_display_name;
  return typeof name === 'string' && name.trim() ? name : 'The sender';
}

function missedCalls(comms: CommsState | null, rootKey: string): number {
  const rows: CommsDelivery[] = comms?.by_key?.[rootKey] ?? [];
  return rows.filter(
    (row) => row.channel === 'call' && (row.call_state === 'missed' || row.call_state === 'declined'),
  ).length;
}

function clampRing(seconds: number): number {
  if (!Number.isFinite(seconds)) return 30;
  return Math.min(60, Math.max(10, Math.round(seconds)));
}

function chainsOff(): boolean {
  return escalationChainsUnavailable();
}
