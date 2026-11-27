/**
 * Background judging of inject replies. Routes and the scheduler tick only enqueue;
 * the model call runs later, on an in-process queue, and a missing ledger is a no-op.
 */

import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { AiCallError, chatJson, systemUser } from '../ai/chatClient.js';
import { resolveTarget, type AiTier, type ProviderConfig } from '../ai/chatCore.js';
import { formatTranscript, type TranscriptTurn } from '../calls/callCore.js';
import { failLedger, isLedgerSchemaMissing, ledgerTablesMissing } from '../ledger/ledgerSchema.js';
import {
  SCHEDULED_STALE_MS,
  buildJudgeUserMessage,
  isCoalesceChannel,
  judgeWithClient,
  planCoalesce,
  releaseUnwrittenBurstIds,
  resolveRubric,
  sweepKeepsScheduledHold,
  type CoalesceRow,
  type JudgeChatClient,
  type JudgeChatResult,
  type JudgeOutcome,
  type RubricFactSheet,
  type RubricInject,
} from './judgeCore.js';

const SESSION_LIMIT = 2;
const GLOBAL_LIMIT = 8;
const SWEEP_LIMIT = 10;
const SWEEP_AGE_MS = 60_000;
const COALESCE_WINDOW_MS = 20_000;
const OPEN_STATUSES = ['pending', 'queued'];

interface ResponseRecord {
  id: string;
  session_id: string;
  delivery_id: string;
  inject_id: string;
  channel: string;
  attribution: string;
  team_name: string | null;
  user_id: string | null;
  content_excerpt: string | null;
  judgement_status: string;
  meta: Record<string, unknown> | null;
  responded_at: string;
  ref_id: string | null;
}

interface QueuedJob {
  sessionId: string;
  responseId: string;
  /** Ids admitted to this chat/DM burst. Absent for a single reply. */
  admitted?: readonly string[];
}

const queue: QueuedJob[] = [];
const scheduled = new Set<string>();
const groupLocks = new Set<string>();
let globalActive = 0;
const sessionActive = new Map<string, number>();
const bursts = new Map<string, { startedAt: number; timer: ReturnType<typeof setTimeout> }>();
const burstMembers = new Map<string, Set<string>>();
const budgetLoggedAt = new Map<string, number>();
let callTurnsWarned = false;

const RESPONSE_COLUMNS =
  'id, session_id, delivery_id, inject_id, channel, attribution, team_name, user_id, content_excerpt, judgement_status, meta, responded_at, ref_id';

/**
 * Schedule a judgement. Returns immediately. Chat and DM rows from the same
 * player and delivery wait together for up to 20 seconds so one reply is judged.
 */
export function enqueueJudgement(responseId: string, opts?: { immediate?: boolean }): void {
  if (!responseId || ledgerTablesMissing()) return;
  void admit(responseId, opts?.immediate === true).catch((err) => {
    scheduled.delete(responseId);
    logger.warn(
      { err, responseId, event: 'judge_enqueue_failed' },
      'Could not enqueue a reply judgement',
    );
  });
}

/** Each scheduler tick. Not awaited by the tick: a slow read must not delay publishing. */
export function sweepPendingJudgements(sessionId: string): void {
  if (!sessionId || ledgerTablesMissing()) return;
  void sweepSession(sessionId).catch((err) => {
    logger.warn({ err, sessionId, event: 'judge_sweep_failed' }, 'Reply judgement sweep failed');
  });
}

async function admit(responseId: string, immediate: boolean): Promise<void> {
  if (scheduled.has(responseId)) {
    if (!immediate) return;
    scheduled.delete(responseId);
  }
  const row = await loadResponse(responseId);
  if (!row || !OPEN_STATUSES.includes(row.judgement_status)) return;
  if (!env.aiEnabled) {
    await markTerminal(
      row,
      { status: 'skipped', judgement: null, model: null },
      { skip_reason: 'ai_disabled' },
    );
    return;
  }
  scheduled.add(responseId);
  if (!immediate && isCoalesceChannel(row.channel) && row.user_id) {
    holdBurst(row);
    return;
  }
  pushJob({ sessionId: row.session_id, responseId });
}

function holdBurst(row: ResponseRecord): void {
  const key = groupKey(row);
  const members = burstMembers.get(key) ?? new Set<string>();
  members.add(row.id);
  burstMembers.set(key, members);
  const now = Date.now();
  const existing = bursts.get(key);
  if (existing && now - existing.startedAt < COALESCE_WINDOW_MS) return;
  const timer = setTimeout(() => {
    const admitted = [...(burstMembers.get(key) ?? new Set([row.id]))];
    burstMembers.delete(key);
    bursts.delete(key);
    pushJob({ sessionId: row.session_id, responseId: row.id, admitted });
  }, COALESCE_WINDOW_MS);
  timer.unref?.();
  bursts.set(key, { startedAt: now, timer });
}

function pushJob(job: QueuedJob): void {
  queue.push(job);
  pump();
}

function pump(): void {
  for (let index = 0; index < queue.length; index++) {
    if (globalActive >= GLOBAL_LIMIT) return;
    const job = queue[index];
    if (!job) continue;
    const active = sessionActive.get(job.sessionId) ?? 0;
    if (active >= SESSION_LIMIT) continue;
    queue.splice(index, 1);
    index -= 1;
    globalActive += 1;
    sessionActive.set(job.sessionId, active + 1);
    void runJob(job).finally(() => {
      globalActive -= 1;
      const left = (sessionActive.get(job.sessionId) ?? 1) - 1;
      if (left <= 0) sessionActive.delete(job.sessionId);
      else sessionActive.set(job.sessionId, left);
      scheduled.delete(job.responseId);
      pump();
    });
  }
}

async function runJob(job: QueuedJob): Promise<void> {
  try {
    await judgeResponse(job);
  } catch (err) {
    logger.warn(
      { err, responseId: job.responseId, event: 'judge_job_failed' },
      'Reply judgement stopped before it could be stored',
    );
  }
}

async function judgeResponse(job: QueuedJob): Promise<void> {
  const written: string[] = [];
  try {
    await judgeLoaded(job, written);
  } finally {
    if (job.admitted?.length) releaseUnwrittenBurstIds(scheduled, job.admitted, written);
  }
}

async function judgeLoaded(job: QueuedJob, written: string[]): Promise<void> {
  const row = await loadResponse(job.responseId);
  if (!row || !OPEN_STATUSES.includes(row.judgement_status)) return;
  if (!env.aiEnabled) {
    await markTerminal(
      row,
      { status: 'skipped', judgement: null, model: null },
      { skip_reason: 'ai_disabled' },
    );
    written.push(row.id);
    return;
  }
  if (!isCoalesceChannel(row.channel) || !row.user_id) {
    await judgeSingle(row, row.content_excerpt ?? '');
    return;
  }
  const key = groupKey(row);
  if (groupLocks.has(key)) return;
  groupLocks.add(key);
  const admitted = job.admitted?.length ? [...job.admitted] : [row.id];
  try {
    const siblings = await loadOpenSiblings(row);
    const byId = new Map(siblings.map((item) => [item.id, item]));
    if (!byId.has(row.id)) byId.set(row.id, row);
    for (const id of admitted) {
      if (byId.has(id)) continue;
      const loaded = await loadResponse(id);
      if (loaded && OPEN_STATUSES.includes(loaded.judgement_status)) byId.set(id, loaded);
    }
    const rows = [...byId.values()];
    const plan = planCoalesce(rows.map(toCoalesceRow));
    const burstJob = plan.jobs.find((item) => item.sourceIds.includes(row.id));
    if (!burstJob) return;
    const target = rows.find((item) => item.id === burstJob.responseId) ?? row;
    const stored = await judgeSingle(target, burstJob.text);
    if (!stored) return;
    written.push(target.id);
    for (const skip of plan.skipped) {
      if (skip.into !== burstJob.responseId) continue;
      const earlier = rows.find((item) => item.id === skip.id);
      if (!earlier) continue;
      await markTerminal(
        earlier,
        { status: 'skipped', judgement: null, model: null },
        { coalesced_into: burstJob.responseId },
      );
      written.push(earlier.id);
    }
  } finally {
    groupLocks.delete(key);
  }
}

async function judgeSingle(row: ResponseRecord, text: string): Promise<boolean> {
  const transcript = await responseText(row, text);
  if (!transcript.trim()) {
    await markTerminal(
      row,
      { status: 'skipped', judgement: null, model: null },
      { skip_reason: 'no_text' },
    );
    return true;
  }
  const context = await loadContext(row);
  if (!context) return false;
  const { rubric, source } = resolveRubric(context.inject, context.facts);
  const userMessage = buildJudgeUserMessage({
    channel: row.channel,
    senderName: context.senderName,
    relationship: context.relationship,
    injectContent: context.inject.content,
    teamName: row.team_name,
    attribution: row.attribution,
    responseText: transcript,
    facts: context.facts.confirmed_facts,
    rubric,
  });
  const outcome = await judgeWithClient({
    sessionId: row.session_id,
    call: row.channel === 'call',
    userMessage,
    rubric,
    rubricSource: source,
    client: modelClient(row.session_id),
  });
  if (outcome.status === 'budget_denied') noteBudgetDenied(row.session_id);
  await markTerminal(row, outcome, null);
  return true;
}

function modelClient(sessionId: string): JudgeChatClient {
  return {
    async complete(request): Promise<JudgeChatResult> {
      const tier: AiTier = request.call ? 'standard' : 'fast';
      try {
        const parsed = await chatJson({
          tier,
          messages: systemUser(request.system, request.user),
          json: true,
          temperature: 0,
          maxTokens: request.call ? 700 : 450,
          timeoutMs: 15_000,
          retry: { attempts: 2 },
          label: request.call ? 'judge.call' : 'judge.response',
          budgetKey: `judge:${sessionId}`,
          budgetLimit: env.judgeBudgetPerSessionHour,
          throwOnError: true,
        });
        if (parsed == null) return { kind: 'failed' };
        return { kind: 'ok', raw: parsed, model: modelFor(tier) };
      } catch (err) {
        if (err instanceof AiCallError && err.message === 'hourly AI budget exhausted') {
          return { kind: 'budget_denied' };
        }
        if (err instanceof AiCallError && /not configured/i.test(err.message)) {
          return { kind: 'unavailable' };
        }
        return { kind: 'failed' };
      }
    },
  };
}

function modelFor(tier: AiTier): string {
  try {
    return resolveTarget(providerConfig(), tier).model;
  } catch {
    return tier;
  }
}

function providerConfig(): ProviderConfig {
  return {
    provider: env.aiProvider,
    openAiApiKey: env.openAiApiKey,
    aiApiKey: env.aiApiKey,
    aiBaseUrl: env.aiBaseUrl,
    bedrockModels: {
      fast: env.aiModelFast,
      standard: env.aiModelStandard,
      vision: env.aiModelVision,
    },
    temperaturePolicy: env.aiTemperaturePolicy,
    fastMinCompletionTokens: env.aiFastMinCompletionTokens,
  };
}

async function sweepSession(sessionId: string): Promise<void> {
  if (ledgerTablesMissing()) return;
  const cutoff = new Date(Date.now() - SWEEP_AGE_MS).toISOString();
  try {
    const { data, error } = await supabaseAdmin
      .from('inject_responses')
      .select('id, judgement_status, created_at')
      .eq('session_id', sessionId)
      .in('judgement_status', OPEN_STATUSES)
      .lt('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(SWEEP_LIMIT);
    if (failLedger(error, 'judge.sweep')) return;
    const now = Date.now();
    for (const row of data ?? []) {
      const id = String(row.id);
      const createdAt = Date.parse(String(row.created_at ?? ''));
      const ageMs = Number.isFinite(createdAt) ? now - createdAt : SCHEDULED_STALE_MS;
      if (
        sweepKeepsScheduledHold({
          scheduled: scheduled.has(id),
          ageMs,
          staleAfterMs: SCHEDULED_STALE_MS,
        })
      ) {
        continue;
      }
      enqueueJudgement(id, { immediate: true });
    }
  } catch (err) {
    failLedger(err, 'judge.sweep');
  }
}

async function loadResponse(id: string): Promise<ResponseRecord | null> {
  if (ledgerTablesMissing()) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from('inject_responses')
      .select(RESPONSE_COLUMNS)
      .eq('id', id)
      .maybeSingle();
    if (failLedger(error, 'judge.load')) return null;
    return data ? asResponse(data) : null;
  } catch (err) {
    failLedger(err, 'judge.load');
    return null;
  }
}

async function loadOpenSiblings(row: ResponseRecord): Promise<ResponseRecord[]> {
  const at = Date.parse(row.responded_at);
  const from = new Date((Number.isFinite(at) ? at : Date.now()) - COALESCE_WINDOW_MS).toISOString();
  const to = new Date((Number.isFinite(at) ? at : Date.now()) + COALESCE_WINDOW_MS).toISOString();
  try {
    const { data, error } = await supabaseAdmin
      .from('inject_responses')
      .select(RESPONSE_COLUMNS)
      .eq('delivery_id', row.delivery_id)
      .eq('user_id', row.user_id)
      .in('judgement_status', OPEN_STATUSES)
      .gte('responded_at', from)
      .lte('responded_at', to)
      .order('responded_at', { ascending: true })
      .limit(30);
    if (failLedger(error, 'judge.siblings')) return [row];
    return (data ?? []).map((item) => asResponse(item));
  } catch (err) {
    failLedger(err, 'judge.siblings');
    return [row];
  }
}

async function responseText(row: ResponseRecord, fallback: string): Promise<string> {
  if (row.channel !== 'call' || row.attribution !== 'call_transcript' || !row.ref_id)
    return fallback;
  const transcript = await loadCallTranscript(row.ref_id);
  return transcript ?? fallback;
}

async function loadCallTranscript(callId: string): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('sim_call_turns')
      .select('speaker, text, seq')
      .eq('call_id', callId)
      .order('seq', { ascending: true });
    if (error) {
      if (isLedgerSchemaMissing(error)) {
        noteCallTurnsUnavailable(error);
        return null;
      }
      failLedger(error, 'judge.transcript');
      return null;
    }
    const turns: TranscriptTurn[] = (data ?? []).flatMap((turn) => {
      const speaker = turn.speaker;
      if (speaker !== 'npc' && speaker !== 'player' && speaker !== 'system') return [];
      return [{ speaker, text: String(turn.text ?? '') }];
    });
    const text = formatTranscript(turns);
    return text || null;
  } catch (err) {
    if (isLedgerSchemaMissing(err)) {
      noteCallTurnsUnavailable(err);
      return null;
    }
    failLedger(err, 'judge.transcript');
    return null;
  }
}

function noteCallTurnsUnavailable(err: unknown): void {
  if (callTurnsWarned) return;
  callTurnsWarned = true;
  logger.warn(
    { err, event: 'judge_calls_unavailable' },
    'Call transcripts are judged from the stored excerpt until sim_call_turns exists',
  );
}

interface JudgeContext {
  inject: RubricInject;
  facts: RubricFactSheet;
  senderName: string;
  relationship: string | null;
}

async function loadContext(row: ResponseRecord): Promise<JudgeContext | null> {
  try {
    const [deliveryResult, injectResult, sessionResult] = await Promise.all([
      supabaseAdmin
        .from('inject_deliveries')
        .select('sender_name, stakeholder_id')
        .eq('id', row.delivery_id)
        .maybeSingle(),
      supabaseAdmin
        .from('scenario_injects')
        .select('content, delivery_config')
        .eq('id', row.inject_id)
        .maybeSingle(),
      supabaseAdmin.from('sessions').select('scenario_id').eq('id', row.session_id).maybeSingle(),
    ]);
    if (failLedger(deliveryResult.error, 'judge.delivery')) return null;
    if (failLedger(injectResult.error, 'judge.inject')) return null;
    if (failLedger(sessionResult.error, 'judge.session')) return null;

    const deliveryConfig = asRecord(injectResult.data?.delivery_config);
    const stakeholderId = stringOrNull(deliveryResult.data?.stakeholder_id);
    let facts: string[] = [];
    let relationship: string | null = null;
    const scenarioId = stringOrNull(sessionResult.data?.scenario_id);
    if (scenarioId) {
      const scenario = await readScenario(scenarioId, stakeholderId);
      facts = scenario.facts;
      relationship = scenario.relationship;
    }
    const senderName =
      stringOrNull(deliveryResult.data?.sender_name) ||
      stringOrNull(deliveryConfig.sender_name) ||
      stringOrNull(deliveryConfig.author_display_name) ||
      'the sender';
    return {
      inject: {
        content: stringOrNull(injectResult.data?.content),
        delivery_config: {
          response_rubric: deliveryConfig.response_rubric,
          author_type: stringOrNull(deliveryConfig.author_type),
          sender_name: stringOrNull(deliveryConfig.sender_name),
          author_display_name: stringOrNull(deliveryConfig.author_display_name),
        },
        stakeholder: relationship ? { relationship } : null,
      },
      facts: { confirmed_facts: facts },
      senderName,
      relationship,
    };
  } catch (err) {
    failLedger(err, 'judge.context');
    return null;
  }
}

async function readScenario(
  scenarioId: string,
  stakeholderId: string | null,
): Promise<{ facts: string[]; relationship: string | null }> {
  const { data, error } = await supabaseAdmin
    .from('scenarios')
    .select('initial_state')
    .eq('id', scenarioId)
    .maybeSingle();
  if (failLedger(error, 'judge.scenario') || !data) return { facts: [], relationship: null };
  const initial = asRecord(data.initial_state);
  const sheet = asRecord(initial.fact_sheet);
  const facts = Array.isArray(sheet.confirmed_facts)
    ? sheet.confirmed_facts.filter((item): item is string => typeof item === 'string')
    : [];
  let relationship: string | null = null;
  if (stakeholderId && Array.isArray(initial.stakeholders)) {
    for (const stakeholder of initial.stakeholders) {
      const record = asRecord(stakeholder);
      if (record.id === stakeholderId && typeof record.relationship === 'string') {
        relationship = record.relationship;
        break;
      }
    }
  }
  return { facts, relationship };
}

async function markTerminal(
  row: ResponseRecord,
  outcome: JudgeOutcome,
  metaPatch: Record<string, unknown> | null,
): Promise<void> {
  if (ledgerTablesMissing()) return;
  const patch: Record<string, unknown> = {
    judgement_status: outcome.status,
    judgement: outcome.judgement,
    judged_at: new Date().toISOString(),
  };
  if (outcome.model) patch.judge_model = outcome.model;
  if (metaPatch) patch.meta = { ...(row.meta ?? {}), ...metaPatch };
  try {
    const { error } = await supabaseAdmin
      .from('inject_responses')
      .update(patch)
      .eq('id', row.id)
      .in('judgement_status', OPEN_STATUSES);
    failLedger(error, 'judge.write');
    if (!error && outcome.status === 'done' && outcome.judgement?.passed === true) {
      const { noteGoodReply } = await import('../mood/moodService.js');
      await noteGoodReply(row.session_id, row.delivery_id);
    }
  } catch (err) {
    failLedger(err, 'judge.write');
  }
}

function noteBudgetDenied(sessionId: string): void {
  const now = Date.now();
  const previous = budgetLoggedAt.get(sessionId) ?? 0;
  if (now - previous < 60 * 60 * 1000) return;
  budgetLoggedAt.set(sessionId, now);
  logger.warn(
    { sessionId, event: 'judge_budget_denied' },
    'Reply judging budget is spent for this session-hour',
  );
}

function groupKey(row: ResponseRecord): string {
  return `${row.delivery_id}\0${row.user_id ?? ''}`;
}

function toCoalesceRow(row: ResponseRecord): CoalesceRow {
  const atMs = Date.parse(row.responded_at);
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    userId: row.user_id,
    channel: row.channel,
    atMs: Number.isFinite(atMs) ? atMs : 0,
    text: row.content_excerpt ?? '',
  };
}

function asResponse(value: Record<string, unknown>): ResponseRecord {
  return {
    id: String(value.id),
    session_id: String(value.session_id),
    delivery_id: String(value.delivery_id),
    inject_id: String(value.inject_id),
    channel: String(value.channel ?? ''),
    attribution: String(value.attribution ?? ''),
    team_name: stringOrNull(value.team_name),
    user_id: stringOrNull(value.user_id),
    content_excerpt: stringOrNull(value.content_excerpt),
    judgement_status: String(value.judgement_status ?? 'pending'),
    meta: asMeta(value.meta),
    responded_at: String(value.responded_at ?? ''),
    ref_id: stringOrNull(value.ref_id),
  };
}

function asMeta(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}
