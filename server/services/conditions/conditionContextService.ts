/**
 * One condition-evaluation context for the inject scheduler and the trainer
 * orchestration panel. Both call assembleConditionEvaluationContext so a key
 * means the same thing in both places.
 */

import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { activeTemplateInjects } from '../../lib/templateRows.js';
import { logger } from '../../lib/logger.js';
import type { EvaluationContext } from '../conditionEvaluatorService.js';

export interface ConditionContextSession {
  id: string;
  scenario_id: string;
  start_time?: string | null;
  current_state?: Record<string, unknown> | null;
}

export interface ConditionContextOptions {
  elapsedMinutes?: number;
  currentState?: Record<string, unknown>;
  conditionSources?: ReadonlyArray<{
    conditions_to_appear?: unknown;
    conditions_to_cancel?: unknown;
  }>;
}

interface DecisionRow {
  id: string;
  title?: string | null;
  description?: string | null;
  type?: string | null;
}

interface EventRow {
  metadata?: unknown;
}

interface GateRow {
  id: string;
  gate_id: string;
}

interface GateProgressRow {
  gate_id: string;
  status: string;
}

interface KeyedInjectRow {
  id: string;
  inject_key: string;
}

export interface ConditionContextParts {
  sessionId: string;
  scenarioId: string;
  elapsedMinutes: number;
  currentState: Record<string, unknown>;
  decisions: readonly DecisionRow[];
  publishedEvents: readonly EventRow[];
  cancelledEvents: readonly EventRow[];
  gates: readonly GateRow[];
  gateProgress: readonly GateProgressRow[];
  placedAssetsCount: number;
  keyedInjects: readonly KeyedInjectRow[];
}

const INJECT_KEY_PREFIXES = ['inject_published:', 'inject_cancelled:'];

export function sessionElapsedMinutes(
  startTime: string | null | undefined,
  now = Date.now(),
): number {
  if (!startTime) return 0;
  const start = new Date(startTime).getTime();
  if (Number.isNaN(start)) return 0;
  return Math.floor((now - start) / 60000);
}

export function usesInjectKeyConditions(
  sources: ReadonlyArray<{ conditions_to_appear?: unknown; conditions_to_cancel?: unknown }>,
): boolean {
  for (const source of sources) {
    for (const key of keysOf(source.conditions_to_appear, source.conditions_to_cancel)) {
      if (INJECT_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
    }
  }
  return false;
}

export function assembleConditionEvaluationContext(
  parts: ConditionContextParts,
): EvaluationContext {
  const publishedScenarioInjectIds: string[] = [];
  const publishedInjectKeysOrTags: string[] = [];
  for (const event of parts.publishedEvents) {
    const meta = (event.metadata ?? {}) as { inject_id?: string; title?: string; tags?: string[] };
    if (meta.inject_id) publishedScenarioInjectIds.push(meta.inject_id);
    if (meta.title) publishedInjectKeysOrTags.push(meta.title);
    if (Array.isArray(meta.tags)) publishedInjectKeysOrTags.push(...meta.tags);
  }

  const cancelledScenarioInjectIds: string[] = [];
  for (const event of parts.cancelledEvents) {
    const injectId = (event.metadata as { inject_id?: string } | null)?.inject_id;
    if (injectId) cancelledScenarioInjectIds.push(injectId);
  }

  const knownGateIds = new Set(parts.gates.map((gate) => gate.gate_id));
  const gateStatusByGateId: Record<string, 'pending' | 'met' | 'not_met'> = {};
  for (const row of parts.gateProgress) {
    if (!knownGateIds.has(row.gate_id)) continue;
    if (row.status === 'pending' || row.status === 'met' || row.status === 'not_met') {
      gateStatusByGateId[row.gate_id] = row.status;
    }
  }

  const injectIdsByKey: Record<string, string[]> = {};
  for (const row of parts.keyedInjects) {
    if (!row.inject_key) continue;
    (injectIdsByKey[row.inject_key] ??= []).push(row.id);
  }

  return {
    sessionId: parts.sessionId,
    scenarioId: parts.scenarioId,
    elapsedMinutes: parts.elapsedMinutes,
    currentState: parts.currentState,
    executedDecisions: parts.decisions.map((decision) => ({
      id: decision.id,
      title: decision.title ?? '',
      description: decision.description ?? '',
      decision_type: decision.type ?? undefined,
    })),
    publishedScenarioInjectIds,
    publishedInjectKeysOrTags,
    gateStatusByGateId,
    placedAssetsCount: parts.placedAssetsCount,
    cancelledScenarioInjectIds,
    injectIdsByKey,
  };
}

export async function buildConditionEvaluationContext(
  session: ConditionContextSession,
  opts: ConditionContextOptions = {},
): Promise<EvaluationContext> {
  const elapsedMinutes = opts.elapsedMinutes ?? sessionElapsedMinutes(session.start_time);
  const currentState = opts.currentState ?? session.current_state ?? {};
  const sources = opts.conditionSources ?? [];

  const [
    gatesResult,
    progressResult,
    publishedResult,
    cancelledResult,
    decisionsResult,
    placedResult,
  ] = await Promise.all([
    supabaseAdmin
      .from('scenario_gates')
      .select('id, gate_id')
      .eq('scenario_id', session.scenario_id),
    supabaseAdmin
      .from('session_gate_progress')
      .select('gate_id, status')
      .eq('session_id', session.id),
    supabaseAdmin
      .from('session_events')
      .select('metadata')
      .eq('session_id', session.id)
      .eq('event_type', 'inject'),
    supabaseAdmin
      .from('session_events')
      .select('metadata')
      .eq('session_id', session.id)
      .eq('event_type', 'inject_cancelled'),
    supabaseAdmin
      .from('decisions')
      .select('id, title, description, type')
      .eq('session_id', session.id)
      .eq('status', 'executed'),
    supabaseAdmin
      .from('placed_assets')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', session.id),
  ]);

  if (publishedResult.error) {
    throw new Error(`Failed to load published injects: ${publishedResult.error.message}`);
  }

  const keyedInjects: KeyedInjectRow[] = [];
  const sessionFilterId = /^[0-9a-f-]{36}$/i.test(session.id) ? session.id : null;
  if (sessionFilterId && usesInjectKeyConditions(sources)) {
    try {
      const { data: keyed } = await activeTemplateInjects(
        supabaseAdmin
          .from('scenario_injects')
          .select('id, delivery_config')
          .eq('scenario_id', session.scenario_id)
          .or(`session_id.is.null,session_id.eq.${sessionFilterId}`)
          .not('delivery_config->>inject_key', 'is', null),
      );
      for (const row of keyed ?? []) {
        const injectKey = String(
          ((row.delivery_config as Record<string, unknown>) ?? {}).inject_key ?? '',
        );
        if (!injectKey) continue;
        keyedInjects.push({ id: String(row.id), inject_key: injectKey });
      }
    } catch (err) {
      logger.debug({ err, sessionId: session.id }, 'inject_key index unavailable');
    }
  }

  return assembleConditionEvaluationContext({
    sessionId: session.id,
    scenarioId: session.scenario_id,
    elapsedMinutes,
    currentState,
    decisions: (decisionsResult.data ?? []) as DecisionRow[],
    publishedEvents: (publishedResult.data ?? []) as EventRow[],
    cancelledEvents: (cancelledResult.data ?? []) as EventRow[],
    gates: (gatesResult.data ?? []) as GateRow[],
    gateProgress: (progressResult.data ?? []) as GateProgressRow[],
    placedAssetsCount: placedResult.count ?? 0,
    keyedInjects,
  });
}

function keysOf(appear: unknown, cancel: unknown): string[] {
  const keys: string[] = [];
  const pushAll = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const key of value) if (typeof key === 'string') keys.push(key);
  };
  if (Array.isArray(appear)) pushAll(appear);
  else if (appear && typeof appear === 'object') {
    const record = appear as { all?: unknown; any?: unknown; conditions?: unknown };
    pushAll(record.all);
    pushAll(record.any);
    pushAll(record.conditions);
  }
  pushAll(cancel);
  return keys;
}
