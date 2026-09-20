/**
 * Organic executive decisions — ledger (docs/executive-decisions-organic-plan.md §3.2, §6.7).
 * Reuses 203's session_decisions as the head row; `detail` JSONB (205) carries everything the
 * cascade needs. Falls back to in-memory detail + knowledge when 205 is not yet applied, with a
 * loud one-time log.
 */
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import type { DecisionDetail, DecisionRecord, KnowledgeEntry } from './decisionTypes.js';

let detailColumnSupported: boolean | null = null;
let knowledgeTableSupported: boolean | null = null;
let eventsTableSupported: boolean | null = null;

const memoryDetail = new Map<string, DecisionDetail>(); // decisionId → detail
const memoryKnowledge = new Map<string, Map<string, KnowledgeEntry>>(); // decisionId → actorKey → entry
const memoryEvents = new Map<string, DecisionEvent[]>(); // sessionId → events

export interface DecisionEvent {
  id: string;
  session_id: string;
  decision_id: string;
  parent_id: string | null;
  kind:
    | 'detected'
    | 'told'
    | 'found_out'
    | 'notice_sent'
    | 'reaction_planned'
    | 'reaction_fired'
    | 'reaction_softened'
    | 'reaction_withdrawn'
    | 'reaction_delayed'
    | 'public_effect'
    | 'dismissed'
    | 'reversed';
  actor_kind: string | null;
  actor_id: string | null;
  at_minute: number;
  ref_table: string | null;
  ref_id: string | null;
  summary: string;
  created_at: string;
}

function missingColumn(msg: string | undefined): boolean {
  return /could not find the '.*' column|column .* does not exist|schema cache/i.test(msg || '');
}
function missingTable(msg: string | undefined): boolean {
  return /relation .* does not exist|could not find the table|schema cache/i.test(msg || '');
}

// ─── Head rows ───────────────────────────────────────────────────────────────

export async function insertDecision(input: {
  sessionId: string;
  orgKey: string | null;
  decisionKey: string;
  title: string;
  recordedBy: string;
  teamName: string | null;
  recordedAtMinute: number;
  recordedByTrainer: boolean;
  detail: DecisionDetail;
}): Promise<DecisionRecord | null> {
  const base = {
    session_id: input.sessionId,
    org_key: input.orgKey ?? 'primary',
    decision_key: input.decisionKey,
    title: input.title.slice(0, 200),
    recorded_by: input.recordedBy,
    team_name: input.teamName ?? 'Executive',
    scope: input.detail.scope.subject || null,
    rationale: input.detail.summary,
    recorded_at_minute: Math.round(input.recordedAtMinute),
    recorded_by_trainer: input.recordedByTrainer,
  };
  let row: Record<string, unknown> | null = null;
  if (detailColumnSupported !== false) {
    const { data, error } = await supabaseAdmin
      .from('session_decisions')
      .insert({ ...base, detail: input.detail, status: 'active' })
      .select('*')
      .single();
    if (!error && data) {
      detailColumnSupported = true;
      row = data as Record<string, unknown>;
    } else if (error && missingColumn(error.message)) {
      logger.error(
        'session_decisions.detail missing — apply migrations/205 (decision detail kept in memory)',
      );
      detailColumnSupported = false;
    } else if (error) {
      logger.warn({ error }, 'session_decisions insert failed');
      return null;
    }
  }
  if (!row) {
    const { data, error } = await supabaseAdmin
      .from('session_decisions')
      .insert(base)
      .select('*')
      .single();
    if (error || !data) {
      logger.warn({ error }, 'session_decisions insert failed (base)');
      return null;
    }
    row = data as Record<string, unknown>;
    memoryDetail.set(String(row.id), input.detail);
  }
  return toRecord(row);
}

export async function updateDecisionDetail(
  decisionId: string,
  detail: DecisionDetail,
  status?: DecisionRecord['status'],
): Promise<void> {
  memoryDetail.set(decisionId, detail);
  if (detailColumnSupported === false) return;
  const { error } = await supabaseAdmin
    .from('session_decisions')
    .update({ detail, ...(status ? { status } : {}) })
    .eq('id', decisionId);
  if (error) {
    if (missingColumn(error.message)) detailColumnSupported = false;
    else logger.warn({ error, decisionId }, 'session_decisions detail update failed');
  }
}

export async function listDecisions(sessionId: string): Promise<DecisionRecord[]> {
  const { data, error } = await supabaseAdmin
    .from('session_decisions')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  if (error) {
    logger.warn({ error, sessionId }, 'session_decisions list failed');
    return [];
  }
  return ((data || []) as Array<Record<string, unknown>>)
    .map(toRecord)
    .filter((r): r is DecisionRecord => !!r);
}

export async function getDecision(decisionId: string): Promise<DecisionRecord | null> {
  const { data } = await supabaseAdmin
    .from('session_decisions')
    .select('*')
    .eq('id', decisionId)
    .maybeSingle();
  return data ? toRecord(data as Record<string, unknown>) : null;
}

export async function existingDecisionKeys(sessionId: string): Promise<Set<string>> {
  const { data } = await supabaseAdmin
    .from('session_decisions')
    .select('decision_key')
    .eq('session_id', sessionId);
  return new Set((data || []).map((d) => String(d.decision_key)));
}

function toRecord(row: Record<string, unknown>): DecisionRecord | null {
  const id = String(row.id || '');
  if (!id) return null;
  const detail =
    (row.detail && typeof row.detail === 'object' && Object.keys(row.detail as object).length > 0
      ? (row.detail as DecisionDetail)
      : memoryDetail.get(id)) ??
    emptyDetail(String(row.rationale || row.title || ''), Number(row.recorded_at_minute) || 0);
  return {
    id,
    session_id: String(row.session_id),
    org_key: row.org_key ? String(row.org_key) : null,
    decision_key: String(row.decision_key),
    title: String(row.title || ''),
    recorded_by: row.recorded_by ? String(row.recorded_by) : null,
    team_name: row.team_name ? String(row.team_name) : null,
    recorded_at_minute: Number(row.recorded_at_minute) || 0,
    recorded_by_trainer: !!row.recorded_by_trainer,
    status: (['active', 'dismissed', 'reversed'] as const).includes(row.status as 'active')
      ? (row.status as DecisionRecord['status'])
      : 'active',
    detail,
    recorded_at: String(row.created_at || row.effective_at || new Date().toISOString()),
  };
}

function emptyDetail(summary: string, minute: number): DecisionDetail {
  return {
    summary,
    category: 'other',
    confidence: 1,
    finality: 'final',
    scope: { org_key: null, country: null, site_key: null, subject: '' },
    affected_stakeholder_ids: [],
    should_know_functions: [],
    should_know_stakeholder_ids: [],
    informed: [],
    sources: [],
    reverses_decision_id: null,
    detected_at_minute: minute,
    author_user_id: null,
    author_team: null,
    author_function: null,
  };
}

// ─── Knowledge ───────────────────────────────────────────────────────────────

export async function loadKnowledge(
  sessionId: string,
  decisionId: string,
): Promise<Map<string, KnowledgeEntry>> {
  if (knowledgeTableSupported !== false) {
    const { data, error } = await supabaseAdmin
      .from('decision_knowledge')
      .select(
        'actor_kind, actor_id, state, learned_from, learned_via, at_minute, ref_table, ref_id',
      )
      .eq('session_id', sessionId)
      .eq('decision_id', decisionId);
    if (!error) {
      knowledgeTableSupported = true;
      const map = new Map<string, KnowledgeEntry>();
      for (const r of (data || []) as Array<Record<string, unknown>>) {
        const e: KnowledgeEntry = {
          actor_kind: r.actor_kind as KnowledgeEntry['actor_kind'],
          actor_id: String(r.actor_id),
          state: r.state as KnowledgeEntry['state'],
          learned_from: r.learned_from ? String(r.learned_from) : null,
          learned_via: (r.learned_via as KnowledgeEntry['learned_via']) ?? null,
          at_minute: Number(r.at_minute) || 0,
          ref_table: r.ref_table ? String(r.ref_table) : null,
          ref_id: r.ref_id ? String(r.ref_id) : null,
        };
        map.set(`${e.actor_kind}:${e.actor_id}`, e);
      }
      // merge memory (in case of a mid-session migration)
      for (const [k, v] of memoryKnowledge.get(decisionId) || []) if (!map.has(k)) map.set(k, v);
      return map;
    }
    if (missingTable(error.message)) {
      logger.error(
        'decision_knowledge table missing — apply migrations/205 (knowledge kept in memory)',
      );
      knowledgeTableSupported = false;
    } else {
      logger.warn({ error }, 'decision_knowledge load failed');
    }
  }
  return new Map(memoryKnowledge.get(decisionId) || []);
}

export async function saveKnowledge(
  sessionId: string,
  decisionId: string,
  changed: KnowledgeEntry[],
): Promise<void> {
  if (changed.length === 0) return;
  const mem = memoryKnowledge.get(decisionId) || new Map<string, KnowledgeEntry>();
  for (const e of changed) mem.set(`${e.actor_kind}:${e.actor_id}`, e);
  memoryKnowledge.set(decisionId, mem);
  if (knowledgeTableSupported === false) return;
  const { error } = await supabaseAdmin.from('decision_knowledge').upsert(
    changed.map((e) => ({
      session_id: sessionId,
      decision_id: decisionId,
      actor_kind: e.actor_kind,
      actor_id: e.actor_id,
      state: e.state,
      learned_from: e.learned_from,
      learned_via: e.learned_via,
      at_minute: Math.round(e.at_minute),
      ref_table: e.ref_table ?? null,
      ref_id: e.ref_id ?? null,
    })),
    { onConflict: 'session_id,decision_id,actor_kind,actor_id' },
  );
  if (error) {
    if (missingTable(error.message)) knowledgeTableSupported = false;
    else logger.warn({ error, decisionId }, 'decision_knowledge upsert failed');
  }
}

// ─── Events ──────────────────────────────────────────────────────────────────

export async function addDecisionEvent(
  e: Omit<DecisionEvent, 'id' | 'created_at'>,
): Promise<DecisionEvent> {
  const local: DecisionEvent = {
    ...e,
    id: `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    created_at: new Date().toISOString(),
  };
  if (eventsTableSupported !== false) {
    const { data, error } = await supabaseAdmin
      .from('decision_events')
      .insert({
        session_id: e.session_id,
        decision_id: e.decision_id,
        parent_id: e.parent_id && !e.parent_id.startsWith('mem_') ? e.parent_id : null,
        kind: e.kind,
        actor_kind: e.actor_kind,
        actor_id: e.actor_id,
        at_minute: Math.round(e.at_minute),
        ref_table: e.ref_table,
        ref_id: e.ref_id,
        summary: e.summary.slice(0, 500),
      })
      .select('id, created_at')
      .single();
    if (!error && data) {
      eventsTableSupported = true;
      return { ...local, id: String(data.id), created_at: String(data.created_at) };
    }
    if (error && missingTable(error.message)) {
      logger.error('decision_events table missing — apply migrations/205 (events kept in memory)');
      eventsTableSupported = false;
    } else if (error) {
      logger.warn({ error }, 'decision_events insert failed');
    }
  }
  const list = memoryEvents.get(e.session_id) || [];
  list.push(local);
  memoryEvents.set(e.session_id, list);
  return local;
}

export async function listDecisionEvents(sessionId: string): Promise<DecisionEvent[]> {
  const mem = memoryEvents.get(sessionId) || [];
  if (eventsTableSupported === false) return mem;
  const { data, error } = await supabaseAdmin
    .from('decision_events')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  if (error) {
    if (missingTable(error.message)) eventsTableSupported = false;
    return mem;
  }
  return [...((data || []) as DecisionEvent[]), ...mem];
}
