/**
 * Personal-post attribution for the ledger, team signals and the social report.
 * Flag off: the queries and the credited rows are the ones master issues
 * (posted_by_user_id, author_type player). Flag on: user_id for a personal
 * post, posted_by_user_id for a page post, once each.
 * Expected values are derived from that master behaviour, not from the new branch.
 */

import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { env } from '../../env.js';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { buildSocialSectionsData } from '../aarSocialSectionService.js';
import { buildSocialMediaAARData } from '../aarSocialMediaService.js';
import { buildPlayerLedger } from '../playerLedgerService.js';
import {
  loadTeamSignalFacts,
  resetTeamSignalAggregatesForTests,
  resetTeamSignalAttributionEpochForTests,
  signalGradePlayerId,
} from '../conditions/teamSignalService.js';
import { collectSignals } from '../director/directorSignals.js';
import { evaluateInjectConditions } from '../conditionEvaluatorService.js';
import { evaluateDependency, nextState, type ActiveTeam } from '../dependencies/dependencyCore.js';
import { emptyDependencyState } from '../dependencies/dependencyConditionsCore.js';
import { readDependencyEdge } from '../../../shared/teamDependencies.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const SCENARIO = '22222222-2222-4222-8222-222222222222';
const U1 = '33333333-3333-4333-8333-333333333333';
const U2 = '44444444-4444-4444-8444-444444444444';
const LEGAL_UID = '55555555-5555-4555-8555-555555555555';
const COMMS_UID = '66666666-6666-4666-8666-666666666666';
const START = '2026-11-28T12:00:00.000Z';
const EPOCH_ISO = '2026-11-28T13:00:00.000Z';
const EPOCH = Date.parse(EPOCH_ISO);

/** Copied from playerLedgerService. The flag-off select must stay this string. */
const LEDGER_POSTS =
  'id, posted_by_user_id, author_display_name, content, sop_compliance_score, sentiment, reply_to_post_id, created_at';
const LEDGER_EMAILS = 'id, sent_by_player_id, subject, body_text, sop_compliance_score, created_at';
const LEDGER_DMS = 'id, sender_handle, sender_display_name, content, created_at';

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const saved = {
  peace: env.enablePeacePeriod,
  topic: env.enableTopicAwareReplies,
  attribution: env.teamScorePostAttributionFix,
};

interface Op {
  op: string;
  column?: string;
  value?: unknown;
  operator?: string;
  ascending?: boolean;
}

interface LoggedQuery {
  table: string;
  select: string;
  ops: Op[];
}

const log: LoggedQuery[] = [];
let failAggregates = false;

function grade(overall: number): Record<string, number> {
  return {
    overall,
    accuracy: overall,
    tone: overall,
    cultural_sensitivity: overall,
    persuasiveness: overall,
  };
}

function socialPost(row: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: SESSION,
    reply_to_post_id: null,
    sentiment: 'neutral',
    view_count: 0,
    like_count: 0,
    post_format: 'text',
    content_flags: {},
    requires_response: false,
    responded_at: null,
    author_display_name: 'Ada',
    ...row,
    sop_compliance_score: grade(Number(row.overall)),
  };
}

const POSTS: Array<Record<string, unknown>> = [
  socialPost({
    id: 'post-personal',
    author_type: 'player',
    user_id: U1,
    posted_by_user_id: null,
    content: 'personal one',
    overall: 70,
    created_at: '2026-11-28T12:10:00.000Z',
  }),
  socialPost({
    id: 'post-page',
    author_type: 'official_account',
    user_id: U1,
    posted_by_user_id: U1,
    content: 'page one',
    overall: 40,
    created_at: '2026-11-28T12:20:00.000Z',
  }),
  socialPost({
    id: 'post-page-mid',
    author_type: 'official_account',
    user_id: U2,
    posted_by_user_id: U2,
    author_display_name: 'Bo',
    content: 'page mid',
    overall: 30,
    created_at: '2026-11-28T12:25:00.000Z',
  }),
  socialPost({
    id: 'post-both',
    author_type: 'player',
    user_id: U1,
    posted_by_user_id: U1,
    content: 'both same',
    overall: 55,
    created_at: '2026-11-28T12:30:00.000Z',
  }),
  socialPost({
    id: 'post-split',
    author_type: 'player',
    user_id: U1,
    posted_by_user_id: U2,
    content: 'both split',
    overall: 90,
    created_at: '2026-11-28T12:40:00.000Z',
  }),
  socialPost({
    id: 'post-personal-2',
    author_type: 'player',
    user_id: U2,
    posted_by_user_id: null,
    author_display_name: 'Bo',
    content: 'personal two',
    overall: 20,
    created_at: '2026-11-28T12:50:00.000Z',
  }),
  socialPost({
    id: 'post-npc',
    author_type: 'npc_public',
    user_id: null,
    posted_by_user_id: null,
    author_display_name: 'Sam',
    content: 'npc rumour',
    overall: 10,
    created_at: '2026-11-28T12:55:00.000Z',
  }),
  socialPost({
    id: 'post-later',
    author_type: 'player',
    user_id: U1,
    posted_by_user_id: null,
    content: 'personal later',
    overall: 80,
    created_at: '2026-11-28T13:20:00.000Z',
  }),
  socialPost({
    id: 'post-late-miss',
    author_type: 'player',
    user_id: U2,
    posted_by_user_id: null,
    author_display_name: 'Bo',
    content: 'late miss',
    overall: 25,
    created_at: '2026-11-28T13:30:00.000Z',
  }),
];

const TABLES: Record<string, Array<Record<string, unknown>>> = {
  social_posts: POSTS,
  sim_emails: [],
  sim_direct_messages: [],
  player_actions: [
    {
      id: 'action-1',
      session_id: SESSION,
      player_id: U1,
      action_type: 'email_sent',
      team_at_action: 'Legal',
      target_id: null,
      content: 'Sent the note',
      metadata: { kind: 'statement' },
      sop_step_matched: null,
      created_at: '2026-11-28T12:15:00.000Z',
    },
  ],
  content_dispute_requests: [],
  sentiment_snapshots: [],
  session_events: [],
  session_teams: [
    { session_id: SESSION, user_id: U1, team_name: 'Legal', assigned_at: START },
    { session_id: SESSION, user_id: U2, team_name: 'Communications', assigned_at: START },
  ],
  session_participants: [],
  user_profiles: [
    { id: U1, full_name: 'Ada', is_bot: false },
    { id: U2, full_name: 'Bo', is_bot: false },
  ],
  sessions: [
    {
      id: SESSION,
      scenario_id: SCENARIO,
      start_time: START,
      end_time: '2026-11-28T14:00:00.000Z',
      created_at: START,
      trainer_id: U1,
      current_state: {},
    },
  ],
  scenarios: [
    {
      id: SCENARIO,
      title: 'Drill',
      description: 'A drill',
      initial_state: { org_name: 'Northwind', player_roles: [] },
    },
  ],
  scenario_teams: [
    {
      scenario_id: SCENARIO,
      team_name: 'Communications',
      function_key: 'comms',
      team_description: 'Speak for the organisation',
      charter: { mission: 'Hold the public line' },
      expected_actions: [],
    },
    {
      scenario_id: SCENARIO,
      team_name: 'Legal',
      function_key: 'legal',
      team_description: 'Counsel',
      charter: { mission: 'Keep the line lawful' },
      expected_actions: [
        {
          action_id: 'review_statement',
          detection_action_type: 'email_sent',
          detection_hints: { kind: 'statement' },
          timing_benchmark_minutes: 30,
        },
      ],
    },
  ],
  scenario_injects: [],
  sim_org_pages: [],
  post_engagement_log: [],
  inject_responses: [],
  chat_messages: [],
  session_decisions: [],
};

function matches(row: Record<string, unknown>, op: Op): boolean {
  if (op.op === 'eq') return row[op.column ?? ''] === op.value;
  if (op.op === 'neq') return row[op.column ?? ''] !== op.value;
  if (op.op === 'in') return (op.value as unknown[]).includes(row[op.column ?? '']);
  if (op.op === 'is') {
    return op.value == null ? row[op.column ?? ''] == null : row[op.column ?? ''] === op.value;
  }
  if (op.op === 'not' && op.operator === 'is') {
    return op.value == null ? row[op.column ?? ''] != null : row[op.column ?? ''] !== op.value;
  }
  if (op.op === 'contains' && op.value && typeof op.value === 'object') {
    const haystack = row[op.column ?? ''];
    if (!haystack || typeof haystack !== 'object') return false;
    return Object.entries(op.value as Record<string, unknown>).every(
      ([key, value]) => (haystack as Record<string, unknown>)[key] === value,
    );
  }
  return true;
}

function tokenValue(row: Record<string, unknown>, token: string): unknown {
  const alias = /^([A-Za-z0-9_]+):(.+)$/.exec(token);
  if (!alias) return row[token];
  const expr = alias[2];
  if (expr === 'sop_compliance_score->>overall') {
    const score = row.sop_compliance_score;
    if (!score || typeof score !== 'object') return null;
    const overall = (score as { overall?: unknown }).overall;
    return overall == null ? null : String(overall);
  }
  if (expr === 'created_at.min()' || expr === 'created_at.max()') return row.created_at;
  return null;
}

function project(row: Record<string, unknown>, select: string): Record<string, unknown> {
  if (select.trim() === '*') return { ...row };
  const out: Record<string, unknown> = {};
  for (const part of select.split(',')) {
    const token = part.trim();
    if (
      !token ||
      token.includes('.count()') ||
      token.includes('.min()') ||
      token.includes('.max()')
    ) {
      continue;
    }
    const alias = /^([A-Za-z0-9_]+):(.+)$/.exec(token);
    const name = alias ? alias[1] : token;
    out[name] = tokenValue(row, token);
  }
  return out;
}

function aggregate(
  rows: Array<Record<string, unknown>>,
  select: string,
): Array<Record<string, unknown>> {
  const tokens = select
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const groups = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const group: Record<string, unknown> = {};
    const aggs: Array<{ name: string; kind: 'count' | 'min' | 'max'; value: unknown }> = [];
    for (const token of tokens) {
      const alias = /^([A-Za-z0-9_]+):(.+)$/.exec(token);
      const name = alias ? alias[1] : token;
      const expr = alias ? alias[2] : '';
      if (expr === 'id.count()') aggs.push({ name, kind: 'count', value: 1 });
      else if (expr === 'created_at.min()') aggs.push({ name, kind: 'min', value: row.created_at });
      else if (expr === 'created_at.max()') aggs.push({ name, kind: 'max', value: row.created_at });
      else group[name] = tokenValue(row, token);
    }
    const key = JSON.stringify(group);
    const existing = groups.get(key);
    if (!existing) {
      const next = { ...group };
      for (const agg of aggs) next[agg.name] = agg.kind === 'count' ? 1 : agg.value;
      groups.set(key, next);
      continue;
    }
    for (const agg of aggs) {
      if (agg.kind === 'count') existing[agg.name] = Number(existing[agg.name] ?? 0) + 1;
      if (agg.kind === 'min' && String(agg.value) < String(existing[agg.name]))
        existing[agg.name] = agg.value;
      if (agg.kind === 'max' && String(agg.value) > String(existing[agg.name]))
        existing[agg.name] = agg.value;
    }
  }
  return [...groups.values()];
}

function runQuery(
  table: string,
  select: string,
  ops: Op[],
): {
  data: unknown;
  error: { code: string; message: string } | null;
  count: number | null;
} {
  const aggregateSelect =
    select.includes('.count()') || select.includes('.min()') || select.includes('.max()');
  if (failAggregates && aggregateSelect) {
    return { data: null, error: { code: 'PGRST123', message: 'aggregates disabled' }, count: null };
  }
  let rows = (TABLES[table] ?? []).filter((row) => ops.every((op) => matches(row, op)));
  const order = ops.find((op) => op.op === 'order');
  if (order?.column) {
    const column = order.column;
    rows = [...rows].sort((a, b) => {
      const compared = String(a[column] ?? '').localeCompare(String(b[column] ?? ''));
      return order.ascending === false ? -compared : compared;
    });
  }
  const limit = ops.find((op) => op.op === 'limit');
  if (!aggregateSelect && limit) rows = rows.slice(0, Number(limit.value));
  let data: unknown = aggregateSelect
    ? aggregate(rows, select)
    : rows.map((row) => project(row, select));
  if (aggregateSelect && limit) data = (data as unknown[]).slice(0, Number(limit.value));
  const list = data as unknown[];
  return { data, error: null, count: list.length };
}

function install(): void {
  log.length = 0;
  (supabaseAdmin as { from: (table: string) => unknown }).from = (table: string) => {
    let select = '*';
    let head = false;
    const ops: Op[] = [];
    const builder: Record<string, unknown> = {};
    const record = (op: Op) => {
      ops.push(op);
      return proxy;
    };
    builder.select = (columns: string, options?: { head?: boolean }) => {
      select = columns;
      head = options?.head === true;
      log.push({ table, select, ops });
      return proxy;
    };
    builder.eq = (column: string, value: unknown) => record({ op: 'eq', column, value });
    builder.neq = (column: string, value: unknown) => record({ op: 'neq', column, value });
    builder.in = (column: string, value: unknown[]) =>
      record({ op: 'in', column, value: [...value] });
    builder.is = (column: string, value: unknown) => record({ op: 'is', column, value });
    builder.not = (column: string, operator: string, value: unknown) =>
      record({ op: 'not', column, operator, value });
    builder.contains = (column: string, value: unknown) =>
      record({ op: 'contains', column, value });
    builder.order = (column: string, options?: { ascending?: boolean }) =>
      record({ op: 'order', column, ascending: options?.ascending !== false });
    builder.limit = (value: number) => record({ op: 'limit', value });
    const result = () => runQuery(table, select, ops);
    builder.maybeSingle = async () => {
      const payload = result();
      const rows = (payload.data as unknown[]) ?? [];
      return { data: rows[0] ?? null, error: payload.error };
    };
    builder.single = async () => {
      const payload = result();
      const rows = (payload.data as unknown[]) ?? [];
      return { data: rows[0] ?? null, error: payload.error };
    };
    builder.then = (resolve: (value: unknown) => unknown, reject?: (err: unknown) => unknown) => {
      const payload = result();
      const body = head
        ? { data: null, error: payload.error, count: payload.count }
        : { data: payload.data, error: payload.error, count: payload.count };
      return Promise.resolve(body).then(resolve, reject);
    };
    const proxy = new Proxy(builder, {
      get(target, prop) {
        if (prop in target) return target[prop as string];
        if (typeof prop !== 'string') return undefined;
        return () => proxy;
      },
    });
    return proxy;
  };
}

function postsOf(queries: LoggedQuery[]): LoggedQuery[] {
  return queries.filter((query) => query.table === 'social_posts');
}

function withoutPosts(queries: LoggedQuery[]): LoggedQuery[] {
  return queries.filter((query) => query.table !== 'social_posts');
}

function sortedGrades(grades: Record<string, number[]>): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const key of Object.keys(grades).sort()) out[key] = [...grades[key]].sort((a, b) => a - b);
  return out;
}

function below(grades: Record<string, number[]>, team: string, score: number): number {
  return (grades[team] ?? []).filter((grade) => grade < score).length;
}

function ledgerView(players: Awaited<ReturnType<typeof buildPlayerLedger>>['players']) {
  return players.map((player) => ({
    player_id: player.player_id,
    display_name: player.display_name,
    team_name: player.team_name,
    entries: player.entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      content: entry.content,
      overall: entry.grade && typeof entry.grade.overall === 'number' ? entry.grade.overall : null,
    })),
  }));
}

const TEAMS: ActiveTeam[] = [
  { team_uid: LEGAL_UID, team_name: 'Legal', playable: true },
  { team_uid: COMMS_UID, team_name: 'Communications', playable: true },
];

function dependencyEdge() {
  const read = readDependencyEdge({
    id: 'dep_legal_line_comms',
    kind: 'approval',
    upstream: { team_uid: LEGAL_UID, team_name: 'Legal' },
    downstream: [{ team_uid: COMMS_UID, team_name: 'Communications' }],
    deliverable: 'A public line that holds up',
    why: 'Communications repeats the line Legal cleared',
    due: { by_minute: 20 },
    broken_when: { all: ['content_failed:1:50|team=legal'] },
    lag_minutes: 5,
    severity: 'high',
    consequence_keys: ['comms_follows_up'],
    source: 'war_room',
  });
  if ('error' in read) throw new Error(read.error);
  return read.edge;
}

function signalContext(facts: Awaited<ReturnType<typeof loadTeamSignalFacts>>) {
  return {
    sessionId: SESSION,
    scenarioId: SCENARIO,
    elapsedMinutes: 90,
    currentState: { comms_state: facts },
    executedDecisions: [],
    publishedScenarioInjectIds: [],
  };
}

beforeEach(() => {
  env.enablePeacePeriod = false;
  env.enableTopicAwareReplies = false;
  env.teamScorePostAttributionFix = false;
  failAggregates = false;
  resetTeamSignalAggregatesForTests();
  resetTeamSignalAttributionEpochForTests(null);
  install();
});

after(() => {
  supabaseAdmin.from = originalFrom;
  env.enablePeacePeriod = saved.peace;
  env.enableTopicAwareReplies = saved.topic;
  env.teamScorePostAttributionFix = saved.attribution;
  resetTeamSignalAggregatesForTests();
  resetTeamSignalAttributionEpochForTests(null);
});

describe('post attribution consumers, flag off', () => {
  test('ledger queries and credited rows match master', async () => {
    const ledger = await buildPlayerLedger(SESSION);
    assert.deepEqual(
      log.map((query) => ({ table: query.table, select: query.select, ops: query.ops })),
      [
        {
          table: 'social_posts',
          select: LEDGER_POSTS,
          ops: [
            { op: 'eq', column: 'session_id', value: SESSION },
            { op: 'eq', column: 'author_type', value: 'player' },
          ],
        },
        {
          table: 'sim_emails',
          select: LEDGER_EMAILS,
          ops: [
            { op: 'eq', column: 'session_id', value: SESSION },
            { op: 'not', column: 'sent_by_player_id', operator: 'is', value: null },
          ],
        },
        {
          table: 'sim_direct_messages',
          select: LEDGER_DMS,
          ops: [
            { op: 'eq', column: 'session_id', value: SESSION },
            { op: 'eq', column: 'sender_type', value: 'player' },
          ],
        },
        {
          table: 'player_actions',
          select:
            'id, player_id, action_type, target_id, content, metadata, sop_step_matched, created_at',
          ops: [
            { op: 'eq', column: 'session_id', value: SESSION },
            { op: 'order', column: 'created_at', ascending: true },
          ],
        },
        {
          table: 'content_dispute_requests',
          select: 'id, requested_by, target_id, status, verdict_reason, ai_confidence, created_at',
          ops: [{ op: 'eq', column: 'session_id', value: SESSION }],
        },
        {
          table: 'sentiment_snapshots',
          select: 'recorded_at, sentiment_score',
          ops: [
            { op: 'eq', column: 'session_id', value: SESSION },
            { op: 'order', column: 'recorded_at', ascending: true },
          ],
        },
        {
          table: 'session_events',
          select: 'id, description, metadata, created_at',
          ops: [
            { op: 'eq', column: 'session_id', value: SESSION },
            { op: 'eq', column: 'event_type', value: 'consequence_inject' },
            { op: 'order', column: 'created_at', ascending: true },
          ],
        },
        {
          table: 'session_teams',
          select: 'user_id, team_name, assigned_at',
          ops: [
            { op: 'eq', column: 'session_id', value: SESSION },
            { op: 'order', column: 'assigned_at', ascending: true },
          ],
        },
        {
          table: 'user_profiles',
          select: 'id, full_name, is_bot',
          ops: [{ op: 'in', column: 'id', value: [U1, U2] }],
        },
      ],
    );
    // Master credits a player post only when posted_by_user_id is set, and never
    // reads a page post. Personal posts and page posts are absent.
    assert.deepEqual(ledgerView(ledger.players), [
      {
        player_id: U1,
        display_name: 'Ada',
        team_name: 'Legal',
        entries: [{ id: 'post-both', kind: 'post', content: 'both same', overall: 55 }],
      },
      {
        player_id: U2,
        display_name: 'Bo',
        team_name: 'Communications',
        entries: [{ id: 'post-split', kind: 'post', content: 'both split', overall: 90 }],
      },
    ]);
  });

  test('team-signal grade query and scores match master, aggregate and scan', async () => {
    const aggregated = await loadTeamSignalFacts(SESSION, START);
    const aggregatePosts = postsOf(log);
    assert.deepEqual(aggregatePosts, [
      {
        table: 'social_posts',
        select: 'posted_by_user_id, overall:sop_compliance_score->>overall, n:id.count()',
        ops: [
          { op: 'eq', column: 'session_id', value: SESSION },
          { op: 'not', column: 'posted_by_user_id', operator: 'is', value: null },
          { op: 'not', column: 'sop_compliance_score', operator: 'is', value: null },
          { op: 'limit', value: 2001 },
          { op: 'eq', column: 'author_type', value: 'player' },
        ],
      },
    ]);
    const expected = { communications: [90], legal: [55] };
    assert.deepEqual(sortedGrades(aggregated.content_grades), expected);
    assert.equal(aggregated.duties.legal?.[0]?.completed_minute, 15);
    assert.equal(aggregated.team_activity.legal?.last_minute, 15);

    resetTeamSignalAggregatesForTests();
    failAggregates = true;
    log.length = 0;
    const scanned = await loadTeamSignalFacts(SESSION, START);
    assert.ok(
      postsOf(log).some(
        (query) =>
          query.select === 'posted_by_user_id, overall:sop_compliance_score->>overall' &&
          query.ops.some(
            (op) => op.op === 'eq' && op.column === 'author_type' && op.value === 'player',
          ) &&
          query.ops.some(
            (op) => op.op === 'not' && op.column === 'posted_by_user_id' && op.value == null,
          ),
      ),
    );
    assert.deepEqual(sortedGrades(scanned.content_grades), expected);
    assert.deepEqual(scanned.duties, aggregated.duties);
    assert.deepEqual(scanned.team_activity, aggregated.team_activity);
  });

  test('social report queries and best, worst and grade average match master', async () => {
    const report = await buildSocialMediaAARData(SESSION);
    const feed = postsOf(log).find((query) => query.select === '*');
    assert.ok(feed);
    assert.deepEqual(feed.ops, [
      { op: 'eq', column: 'session_id', value: SESSION },
      { op: 'order', column: 'created_at', ascending: true },
    ]);
    const gradeQuery = postsOf(log).find(
      (query) => query.select === 'id, posted_by_user_id, sop_compliance_score',
    );
    assert.ok(gradeQuery);
    assert.deepEqual(gradeQuery.ops, [
      { op: 'eq', column: 'session_id', value: SESSION },
      { op: 'eq', column: 'author_type', value: 'player' },
      { op: 'not', column: 'sop_compliance_score', operator: 'is', value: null },
    ]);
    // Author-type player only. Page posts are not in the average. 70+55+90+20+80+25 = 340.
    assert.equal(report.content_quality.posts_created, 6);
    assert.equal(report.content_quality.average_overall, 57);
    const legal = report.team_performance.find((team) => team.team_name === 'Legal');
    const comms = report.team_performance.find((team) => team.team_name === 'Communications');
    assert.deepEqual(legal?.best_artifact, { content: 'both same', overall: 55 });
    assert.deepEqual(legal?.worst_artifact, { content: 'page one', overall: 40 });
    assert.deepEqual(comms?.best_artifact, { content: 'both split', overall: 90 });
    assert.deepEqual(comms?.worst_artifact, { content: 'page mid', overall: 30 });

    log.length = 0;
    const sections = await buildSocialSectionsData(SESSION);
    const players = (
      sections.social_player_performance?.data as {
        players: Array<{
          display_name: string;
          graded_items: number;
          best_artifact: { content: string } | null;
        }>;
      }
    ).players;
    assert.deepEqual(
      players.map((player) => ({
        name: player.display_name,
        graded: player.graded_items,
        best: player.best_artifact?.content ?? null,
      })),
      [
        { name: 'Ada', graded: 1, best: 'both same' },
        { name: 'Bo', graded: 1, best: 'both split' },
      ],
    );
    assert.equal(
      postsOf(log).some((query) => query.select === '*' && query.ops[0]?.value === SESSION),
      true,
    );
  });
});

describe('post attribution consumers, flag on', () => {
  beforeEach(() => {
    env.teamScorePostAttributionFix = true;
    resetTeamSignalAttributionEpochForTests(EPOCH);
  });

  test('each post is credited once, personal by user_id and page by posted_by_user_id', async () => {
    const ledger = await buildPlayerLedger(SESSION);
    assert.deepEqual(postsOf(log), [
      {
        table: 'social_posts',
        select: `${LEDGER_POSTS}, user_id, author_type`,
        ops: [
          { op: 'eq', column: 'session_id', value: SESSION },
          { op: 'in', column: 'author_type', value: ['player', 'official_account'] },
        ],
      },
    ]);
    const view = ledgerView(ledger.players);
    const ada = view.find((player) => player.player_id === U1);
    const bo = view.find((player) => player.player_id === U2);
    assert.deepEqual(
      ada?.entries.map((entry) => entry.id),
      ['post-personal', 'post-page', 'post-both', 'post-split', 'post-later'],
    );
    assert.deepEqual(
      bo?.entries.map((entry) => entry.id),
      ['post-page-mid', 'post-personal-2', 'post-late-miss'],
    );
    assert.equal(ada?.entries.filter((entry) => entry.id === 'post-both').length, 1);
    assert.equal(ada?.entries.filter((entry) => entry.id === 'post-split').length, 1);
    assert.equal(
      view.some((player) => player.entries.some((entry) => entry.id === 'post-npc')),
      false,
    );

    log.length = 0;
    const report = await buildSocialMediaAARData(SESSION);
    const feed = postsOf(log).find((query) => query.select === '*');
    assert.deepEqual(feed?.ops, [
      { op: 'eq', column: 'session_id', value: SESSION },
      { op: 'order', column: 'created_at', ascending: true },
    ]);
    // Six player-authored grades plus two page posts. The split post is one row.
    assert.equal(report.content_quality.posts_created, 8);
    assert.equal(report.content_quality.average_overall, 51);
    const legal = report.team_performance.find((team) => team.team_name === 'Legal');
    const comms = report.team_performance.find((team) => team.team_name === 'Communications');
    assert.deepEqual(legal?.best_artifact, { content: 'both split', overall: 90 });
    assert.deepEqual(legal?.worst_artifact, { content: 'page one', overall: 40 });
    assert.deepEqual(comms?.best_artifact, { content: 'page mid', overall: 30 });
    assert.deepEqual(comms?.worst_artifact, { content: 'personal two', overall: 20 });

    log.length = 0;
    const sections = await buildSocialSectionsData(SESSION);
    const players = (
      sections.social_player_performance?.data as {
        players: Array<{ display_name: string; graded_items: number }>;
      }
    ).players;
    assert.deepEqual(
      players.map((player) => ({ name: player.display_name, graded: player.graded_items })),
      [
        { name: 'Ada', graded: 5 },
        { name: 'Bo', graded: 3 },
      ],
    );
  });

  test('a live flag flip does not back-credit history into signals or dependencies', async () => {
    const offLog = [...log];
    env.teamScorePostAttributionFix = false;
    const before = await loadTeamSignalFacts(SESSION, START);
    const unchanged = withoutPosts(log.slice(offLog.length));

    env.teamScorePostAttributionFix = true;
    resetTeamSignalAttributionEpochForTests(EPOCH);
    log.length = 0;
    const guarded = await loadTeamSignalFacts(SESSION, START);
    assert.deepEqual(withoutPosts(log), unchanged);
    assert.deepEqual(
      postsOf(log).map((query) => ({ select: query.select, ops: query.ops })),
      [
        {
          select:
            'user_id, author_type, posted_by_user_id, created_at, overall:sop_compliance_score->>overall',
          ops: [
            { op: 'eq', column: 'session_id', value: SESSION },
            { op: 'eq', column: 'author_type', value: 'player' },
            { op: 'not', column: 'user_id', operator: 'is', value: null },
            { op: 'not', column: 'sop_compliance_score', operator: 'is', value: null },
            { op: 'limit', value: 2001 },
          ],
        },
        {
          select:
            'user_id, author_type, posted_by_user_id, created_at, overall:sop_compliance_score->>overall',
          ops: [
            { op: 'eq', column: 'session_id', value: SESSION },
            { op: 'eq', column: 'author_type', value: 'official_account' },
            { op: 'not', column: 'posted_by_user_id', operator: 'is', value: null },
            { op: 'not', column: 'sop_compliance_score', operator: 'is', value: null },
            { op: 'limit', value: 2001 },
          ],
        },
      ],
    );
    // History before the flag stays out. The new miss counts. The split post
    // follows user_id, so it leaves Communications.
    assert.deepEqual(sortedGrades(guarded.content_grades), {
      communications: [25],
      legal: [55, 80, 90],
    });
    assert.equal(below(guarded.content_grades, 'legal', 50), 0);
    assert.equal(below(guarded.content_grades, 'communications', 50), 1);
    assert.deepEqual(guarded.duties, before.duties);
    assert.deepEqual(guarded.team_activity, before.team_activity);

    resetTeamSignalAttributionEpochForTests(Date.parse(START));
    const opened = await loadTeamSignalFacts(SESSION, START);
    assert.equal(below(opened.content_grades, 'legal', 50), 1);
    assert.equal(below(opened.content_grades, 'communications', 50), 3);
    assert.deepEqual(opened.duties, before.duties);
    assert.deepEqual(opened.team_activity, before.team_activity);

    const edge = dependencyEdge();
    const guardedEval = evaluateDependency(edge, signalContext(guarded), TEAMS);
    const openedEval = evaluateDependency(edge, signalContext(opened), TEAMS);
    assert.equal(guardedEval.broken, false);
    assert.equal(nextState(emptyDependencyState(), guardedEval, 90).status, 'pending');
    assert.equal(openedEval.broken, true);
    assert.equal(nextState(emptyDependencyState(), openedEval, 90).status, 'broken');
    assert.equal(
      evaluateInjectConditions(
        { all: ['content_failed:1:50|team=legal'] },
        null,
        signalContext(guarded),
      ).status,
      'not_eligible',
    );
    assert.equal(
      evaluateInjectConditions(
        { all: ['content_failed:1:50|team=legal'] },
        null,
        signalContext(opened),
      ).status,
      'appear_met',
    );
    const guardedSignals = collectSignals(
      {
        minute: 90,
        comms: {
          content_grades: guarded.content_grades,
          content_grades_known: true,
          duties_known: false,
          team_activity_known: false,
          decisions_enabled: false,
        },
        content_failed: { count: 1, below: 50 },
      },
      null,
    ).filter((signal) => signal.kind === 'content_failed');
    const openedSignals = collectSignals(
      {
        minute: 90,
        comms: {
          content_grades: opened.content_grades,
          content_grades_known: true,
          duties_known: false,
          team_activity_known: false,
          decisions_enabled: false,
        },
        content_failed: { count: 1, below: 50 },
      },
      null,
    ).filter((signal) => signal.kind === 'content_failed');
    assert.deepEqual(
      guardedSignals.map((signal) => signal.id),
      ['content_failed:communications:1'],
    );
    assert.deepEqual(
      openedSignals.map((signal) => signal.id).sort(),
      ['content_failed:communications:3', 'content_failed:legal:1'].sort(),
    );
  });
});

test('back-credited grades count from the epoch, and an already-visible row keeps its user', () => {
  const before = '2026-11-28T12:10:00.000Z';
  assert.equal(
    signalGradePlayerId(
      { author_type: 'player', user_id: U1, posted_by_user_id: null, created_at: before },
      EPOCH,
    ),
    null,
  );
  assert.equal(
    signalGradePlayerId(
      { author_type: 'official_account', user_id: U1, posted_by_user_id: U1, created_at: before },
      EPOCH,
    ),
    null,
  );
  assert.equal(
    signalGradePlayerId(
      { author_type: 'player', user_id: U1, posted_by_user_id: null, created_at: EPOCH_ISO },
      EPOCH,
    ),
    U1,
  );
  assert.equal(
    signalGradePlayerId(
      { author_type: 'player', user_id: U1, posted_by_user_id: U2, created_at: before },
      EPOCH,
    ),
    U1,
  );
  assert.equal(
    signalGradePlayerId(
      { author_type: 'npc_public', user_id: U1, posted_by_user_id: U1, created_at: EPOCH_ISO },
      EPOCH,
    ),
    null,
  );
});
