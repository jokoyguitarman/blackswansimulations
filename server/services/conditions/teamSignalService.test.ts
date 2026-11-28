import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { dutiesByTeam, type ObservedAction } from '../teamTasksCore.js';
import { gradesByTeam, latestActivity, type GradeHit } from './teamSignalsCore.js';
import {
  ACTIVITY_SCAN_CAP,
  loadTeamSignalFacts,
  resetTeamSignalAggregatesForTests,
} from './teamSignalService.js';
import { activityMinute } from '../../lib/peaceGate.js';
import { slugifyTeamName } from '../../../shared/conditionKeyGrammar.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const SCENARIO = '22222222-2222-4222-8222-222222222222';
const PLAYER = '33333333-3333-4333-8333-333333333333';
const COMMS = '44444444-4444-4444-8444-444444444444';
const TRAINER = '55555555-5555-4555-8555-555555555555';
const START = '2026-11-28T12:00:00.000Z';

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

const rawActions: ObservedAction[] = [
  {
    player_id: PLAYER,
    action_type: 'email_sent',
    team_at_action: 'Legal',
    metadata: { kind: 'other' },
    created_at: '2026-11-28T12:04:00.000Z',
  },
  {
    player_id: PLAYER,
    action_type: 'social_post',
    team_at_action: 'Legal',
    metadata: null,
    created_at: '2026-11-28T12:09:00.000Z',
  },
  {
    player_id: PLAYER,
    action_type: 'email_sent',
    team_at_action: 'Legal',
    metadata: { kind: 'statement' },
    created_at: '2026-11-28T12:12:00.000Z',
  },
  {
    player_id: PLAYER,
    action_type: 'email_sent',
    team_at_action: 'Legal',
    metadata: { kind: 'statement' },
    created_at: '2026-11-28T12:18:00.000Z',
  },
];

const dutyGroups = [
  {
    team_at_action: 'Legal',
    player_id: PLAYER,
    action_type: 'email_sent',
    metadata: { kind: 'other' },
    first_at: '2026-11-28T12:04:00.000Z',
  },
  {
    team_at_action: 'Legal',
    player_id: PLAYER,
    action_type: 'social_post',
    metadata: null,
    first_at: '2026-11-28T12:09:00.000Z',
  },
  {
    team_at_action: 'Legal',
    player_id: PLAYER,
    action_type: 'email_sent',
    metadata: { kind: 'statement' },
    first_at: '2026-11-28T12:12:00.000Z',
  },
];

const gradeRows = [
  { posted_by_user_id: PLAYER, sop_compliance_score: { overall: 40 } },
  { posted_by_user_id: PLAYER, sop_compliance_score: { overall: 80 } },
  { posted_by_user_id: PLAYER, sop_compliance_score: { overall: 40 } },
  { posted_by_user_id: COMMS, sop_compliance_score: { overall: 30 } },
];

const gradeCounts = [
  { posted_by_user_id: PLAYER, overall: 40, n: 2 },
  { posted_by_user_id: PLAYER, overall: 80, n: 1 },
  { posted_by_user_id: COMMS, overall: 30, n: 1 },
];

const chatRows = [
  { session_id: SESSION, sender_id: COMMS, created_at: '2026-11-28T12:03:00.000Z', type: 'text' },
  { session_id: SESSION, sender_id: TRAINER, created_at: '2026-11-28T12:40:00.000Z', type: 'text' },
  {
    session_id: SESSION,
    sender_id: PLAYER,
    created_at: '2026-11-28T12:50:00.000Z',
    type: 'system',
  },
];

interface BuiltQuery {
  eqs: Array<[string, unknown]>;
  ins: Array<[string, unknown[]]>;
  neqs: Array<[string, unknown]>;
  order?: { column: string; ascending: boolean };
  limit?: number;
}

function applyQuery(
  rows: Array<Record<string, unknown>>,
  query: BuiltQuery,
): Array<Record<string, unknown>> {
  let out = rows.filter((row) => {
    if (query.eqs.some(([column, value]) => row[column] !== value)) return false;
    if (query.neqs.some(([column, value]) => row[column] === value)) return false;
    if (query.ins.some(([column, values]) => !values.includes(row[column]))) return false;
    return true;
  });
  if (query.order) {
    const { column, ascending } = query.order;
    out = [...out].sort((a, b) => {
      const compared = String(a[column] ?? '').localeCompare(String(b[column] ?? ''));
      return ascending ? compared : -compared;
    });
  }
  if (query.limit != null) out = out.slice(0, query.limit);
  return out;
}

const chatMax = [
  { sender_id: COMMS, last_at: '2026-11-28T12:03:00.000Z' },
  { sender_id: TRAINER, last_at: '2026-11-28T12:40:00.000Z' },
];

const actionMax = [
  { team_at_action: 'Legal', player_id: PLAYER, last_at: '2026-11-28T12:18:00.000Z' },
];

function minute(at: string, team: string): { team_slug: string; minute: number } | null {
  const value = activityMinute(START, at);
  const slug = slugifyTeamName(team);
  if (value == null || !slug) return null;
  return { team_slug: slug, minute: value };
}

function below(grades: Record<string, number[]>, team: string, score: number): number {
  return (grades[team] ?? []).filter((grade) => grade < score).length;
}

function sortedGrades(grades: Record<string, number[]>): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const key of Object.keys(grades).sort()) {
    out[key] = [...grades[key]].sort((a, b) => a - b);
  }
  return out;
}

describe('narrowed team-signal queries', () => {
  const selects: string[] = [];
  let aggregates = true;
  let aggregateCode = 'PGRST123';
  let chatSource = chatRows;

  after(() => {
    supabaseAdmin.from = originalFrom;
  });

  function install(): void {
    selects.length = 0;
    (supabaseAdmin as { from: (table: string) => unknown }).from = (table: string) => {
      let select = '';
      const query: BuiltQuery = { eqs: [], ins: [], neqs: [] };
      const builder: Record<string, unknown> = {};
      const self = () => builder;
      for (const method of ['is', 'not', 'or', 'gte', 'lte', 'gt', 'lt', 'filter']) {
        builder[method] = self;
      }
      builder.eq = (column: string, value: unknown) => {
        query.eqs.push([column, value]);
        return builder;
      };
      builder.neq = (column: string, value: unknown) => {
        query.neqs.push([column, value]);
        return builder;
      };
      builder.in = (column: string, values: unknown[]) => {
        query.ins.push([column, values]);
        return builder;
      };
      builder.order = (column: string, opts?: { ascending?: boolean }) => {
        query.order = { column, ascending: opts?.ascending !== false };
        return builder;
      };
      builder.limit = (n: number) => {
        query.limit = n;
        return builder;
      };
      builder.select = (cols: string) => {
        select = cols;
        selects.push(`${table} ${cols}`);
        return builder;
      };
      const payload = () => ({
        data: rowsFor(table, select, query),
        error: errorFor(table, select),
      });
      builder.maybeSingle = async () => payload();
      builder.then = (resolve: (value: unknown) => unknown, reject?: (err: unknown) => unknown) =>
        Promise.resolve(payload()).then(resolve, reject);
      return builder;
    };
  }

  function errorFor(table: string, select: string): { code: string; message: string } | null {
    if (aggregates) return null;
    if (select.includes('.min()') || select.includes('.max()') || select.includes('.count()')) {
      return { code: aggregateCode, message: `${table} aggregates disabled` };
    }
    return null;
  }

  function rowsFor(table: string, select: string, query: BuiltQuery): unknown {
    if (table === 'sessions') return { scenario_id: SCENARIO };
    if (table === 'scenarios') {
      return { initial_state: { player_roles: [{ role_id: 'legal_head', team_name: 'Legal' }] } };
    }
    if (table === 'scenario_teams') {
      return [
        {
          team_name: 'Legal',
          function_key: 'legal',
          expected_actions: [
            {
              action_id: 'legal_review_statement',
              detection_action_type: 'email_sent',
              detection_hints: { kind: 'statement' },
              timing_benchmark_minutes: 15,
            },
          ],
        },
        { team_name: 'Communications', function_key: 'comms', expected_actions: [] },
      ];
    }
    if (table === 'session_teams') {
      return [
        { user_id: PLAYER, team_name: 'Legal', assigned_at: START },
        { user_id: COMMS, team_name: 'Communications', assigned_at: START },
      ];
    }
    if (table === 'session_participants') return [{ user_id: TRAINER, role: 'trainer' }];
    if (table === 'session_decisions') return [];
    if (table === 'player_actions' && select.includes('created_at.min()')) return dutyGroups;
    if (table === 'player_actions' && select.includes('created_at.max()')) return actionMax;
    if (table === 'player_actions') return rawActions;
    if (table === 'chat_messages' && select.includes('created_at.max()')) return chatMax;
    if (table === 'chat_messages') return applyQuery(chatSource, query);
    if (table === 'social_posts' && select.includes('id.count()')) return gradeCounts;
    if (table === 'social_posts' && select.includes('->>overall')) {
      return gradeRows.map((row) => ({
        posted_by_user_id: row.posted_by_user_id,
        overall: (row.sop_compliance_score as { overall: number }).overall,
      }));
    }
    if (table === 'social_posts') return gradeRows;
    if (table === 'sim_emails') return [];
    return [];
  }

  test('aggregate reads match a full scan, including hint matching and score counts', async () => {
    resetTeamSignalAggregatesForTests();
    install();
    aggregates = true;
    const aggregated = await loadTeamSignalFacts(SESSION, START);
    assert.ok(
      selects.some((line) => line.includes('player_actions') && line.includes('created_at.min()')),
    );
    assert.ok(
      selects.some((line) => line.includes('player_actions') && line.includes('created_at.max()')),
    );
    assert.ok(
      selects.some((line) => line.includes('chat_messages') && line.includes('created_at.max()')),
    );
    assert.ok(selects.some((line) => line.includes('social_posts') && line.includes('id.count()')));
    assert.equal(
      selects.some((line) => line.startsWith('player_actions player_id, action_type')),
      false,
    );

    aggregates = false;
    const scanned = await loadTeamSignalFacts(SESSION, START);
    assert.ok(selects.some((line) => line.startsWith('player_actions player_id, action_type')));

    const expectedDuties = dutiesByTeam({
      teams: [
        {
          team_name: 'Legal',
          expected: [
            {
              action_id: 'legal_review_statement',
              detection_action_type: 'email_sent',
              detection_hints: { kind: 'statement' },
              timing_benchmark_minutes: 15,
            },
          ],
        },
      ],
      actions: rawActions,
      membersByTeam: new Map([['Legal', [PLAYER]]]),
      startMs: Date.parse(START),
    });
    assert.deepEqual(aggregated.duties, expectedDuties);
    assert.deepEqual(scanned.duties, expectedDuties);
    assert.equal(aggregated.duties.legal?.[0]?.completed_minute, 12);

    const hits = [
      minute('2026-11-28T12:18:00.000Z', 'Legal'),
      minute('2026-11-28T12:03:00.000Z', 'Communications'),
    ].filter((hit): hit is { team_slug: string; minute: number } => hit != null);
    const expectedActivity = latestActivity(hits);
    assert.deepEqual(aggregated.team_activity, expectedActivity);
    assert.deepEqual(scanned.team_activity, expectedActivity);

    const gradeHits: GradeHit[] = [
      { team_slug: 'legal', score: 40 },
      { team_slug: 'legal', score: 80 },
      { team_slug: 'legal', score: 40 },
      { team_slug: slugifyTeamName('Communications'), score: 30 },
    ];
    const expectedGrades = gradesByTeam(gradeHits);
    assert.deepEqual(sortedGrades(aggregated.content_grades), sortedGrades(expectedGrades));
    assert.deepEqual(sortedGrades(scanned.content_grades), sortedGrades(expectedGrades));
    for (const threshold of [40, 50, 80]) {
      assert.equal(
        below(aggregated.content_grades, 'legal', threshold),
        below(expectedGrades, 'legal', threshold),
      );
      assert.equal(
        below(scanned.content_grades, slugifyTeamName('Communications'), threshold),
        below(expectedGrades, slugifyTeamName('Communications'), threshold),
      );
    }
    assert.equal(aggregated.team_activity.legal?.last_minute === 50, false);
    assert.ok(selects.some((line) => line.includes('->>overall')));
    assert.equal(
      selects.some(
        (line) => line.includes('social_posts') && line.endsWith('sop_compliance_score'),
      ),
      false,
    );

    selects.length = 0;
    const again = await loadTeamSignalFacts(SESSION, START);
    assert.equal(
      selects.some(
        (line) => line.includes('.min()') || line.includes('.max()') || line.includes('.count()'),
      ),
      false,
    );
    assert.equal(selects.filter((line) => line.startsWith('chat_messages')).length, 1);
    assert.ok(selects.some((line) => line.includes('chat_messages sender_id, created_at')));
    assert.deepEqual(again.duties, expectedDuties);
    assert.deepEqual(again.team_activity, expectedActivity);
    assert.equal(again.team_activity_truncated, false);
  });

  test('a transient aggregate error is retried, and PGRST123 is not', async () => {
    resetTeamSignalAggregatesForTests();
    install();
    aggregates = false;
    aggregateCode = 'XX000';
    await loadTeamSignalFacts(SESSION, START);
    selects.length = 0;
    await loadTeamSignalFacts(SESSION, START);
    assert.equal(
      selects.some((line) => line.includes('.max()') || line.includes('.count()')),
      true,
    );

    resetTeamSignalAggregatesForTests();
    aggregates = false;
    aggregateCode = 'PGRST123';
    await loadTeamSignalFacts(SESSION, START);
    selects.length = 0;
    await loadTeamSignalFacts(SESSION, START);
    assert.equal(
      selects.some(
        (line) => line.includes('.min()') || line.includes('.max()') || line.includes('.count()'),
      ),
      false,
    );
  });

  test('one chat scan past the cap is truncated so silence stays unproved', async () => {
    resetTeamSignalAggregatesForTests();
    chatSource = Array.from({ length: ACTIVITY_SCAN_CAP + 1 }, (_, index) => ({
      session_id: SESSION,
      sender_id: COMMS,
      created_at: new Date(Date.parse('2026-11-28T12:00:00.000Z') + index * 1000).toISOString(),
      type: 'text',
    }));
    install();
    aggregates = false;
    aggregateCode = 'PGRST123';
    const facts = await loadTeamSignalFacts(SESSION, START);
    assert.equal(facts.team_activity_truncated, true);
    assert.equal(facts.team_activity_known, true);
    selects.length = 0;
    await loadTeamSignalFacts(SESSION, START);
    assert.equal(selects.filter((line) => line.startsWith('chat_messages')).length, 1);
    chatSource = chatRows;
  });
});
