import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { env } from '../../env.js';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { resetTemplateVersioningForTests } from '../../lib/templateRows.js';
import { resetPeaceColumnsForTests } from '../../lib/peaceSchema.js';
import { resetTopicSchemaForTests } from '../topic/topicColumns.js';
import { MASTER_EMAIL_GRADE_SELECT, MASTER_POST_GRADE_SELECT } from './crisisActivityCore.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const SCENARIO = '22222222-2222-4222-8222-222222222222';
const PLAYER = '33333333-3333-4333-8333-333333333333';
const START = '2026-06-01T12:00:00.000Z';
const END = '2026-06-01T13:00:00.000Z';

/**
 * Master-equivalent results for this fixture, with every flag off:
 * the personal post (posted_by_user_id null) does not score, the legacy
 * post does, and the 11:57 reply completes the duty and the SOP step.
 * Content 90, role 80, tasks 100, no collaboration:
 * (90×0.45 + 80×0.15 + 100×0.3) / 0.9 = 92.
 */
const MASTER_COMPOSITE = 92;

interface LoggedQuery {
  table: string;
  select: string;
  eqs: Array<[string, unknown]>;
  nots: Array<[string, string, unknown]>;
  gtes: Array<[string, unknown]>;
}

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalFlags = {
  peace: env.enablePeacePeriod,
  topic: env.enableTopicAwareReplies,
  attribution: env.teamScorePostAttributionFix,
};

const posts = [
  {
    id: 'p-personal',
    session_id: SESSION,
    author_type: 'player',
    user_id: PLAYER,
    posted_by_user_id: null,
    content: 'personal',
    created_at: '2026-06-01T12:10:00.000Z',
    reply_to_post_id: null,
    sop_compliance_score: { overall: 80, role_fit: 50 },
    sentiment: 'neutral',
    author_display_name: 'Sam',
  },
  {
    id: 'p-legacy',
    session_id: SESSION,
    author_type: 'player',
    user_id: PLAYER,
    posted_by_user_id: PLAYER,
    content: 'statement',
    created_at: '2026-06-01T12:20:00.000Z',
    reply_to_post_id: null,
    sop_compliance_score: { overall: 90, role_fit: 80 },
    sentiment: 'neutral',
    author_display_name: 'Sam',
  },
];

const actions = [
  {
    id: 'a1',
    session_id: SESSION,
    player_id: PLAYER,
    action_type: 'reply_posted',
    team_at_action: 'Communications',
    target_id: null,
    content: 'hi',
    metadata: {},
    sop_step_matched: 'assess',
    created_at: '2026-06-01T11:57:00.000Z',
  },
];

const teams = [
  {
    team_name: 'Communications',
    team_description: '',
    function_key: 'Communications',
    charter: { mission: 'Speak' },
    expected_actions: [
      {
        action_id: 'reply',
        description: 'Reply',
        tier: 1,
        weight: 1,
        detection_action_type: 'reply_posted',
        timing_benchmark_minutes: 30,
      },
    ],
  },
];

const sessionRow = {
  id: SESSION,
  scenario_id: SCENARIO,
  start_time: START,
  end_time: END,
  trainer_id: PLAYER,
  created_at: START,
  current_state: {},
};

function rowsFor(table: string): unknown[] {
  if (table === 'scenario_teams') return teams;
  if (table === 'session_teams') {
    return [{ user_id: PLAYER, team_name: 'Communications', assigned_at: START }];
  }
  if (table === 'session_participants') return [{ user_id: PLAYER, role: 'player' }];
  if (table === 'user_profiles') return [{ id: PLAYER, full_name: 'Sam', is_bot: false }];
  if (table === 'social_posts') return posts;
  if (table === 'player_actions') return actions;
  if (table === 'sop_definitions') {
    return [
      {
        scenario_id: SCENARIO,
        steps: [{ step_id: 'assess', name: 'Assess', time_limit_minutes: 10 }],
      },
    ];
  }
  if (table === 'scenarios') {
    return [{ id: SCENARIO, title: 'Drill', description: 'A drill', initial_state: {} }];
  }
  return [];
}

function one(table: string): unknown {
  if (table === 'sessions') return sessionRow;
  if (table === 'scenarios') return rowsFor(table)[0] ?? null;
  return rowsFor(table)[0] ?? null;
}

describe('flags off: scoring and social AAR match master', () => {
  const log: LoggedQuery[] = [];

  after(() => {
    supabaseAdmin.from = originalFrom;
    env.enablePeacePeriod = originalFlags.peace;
    env.enableTopicAwareReplies = originalFlags.topic;
    env.teamScorePostAttributionFix = originalFlags.attribution;
    resetTemplateVersioningForTests();
    resetPeaceColumnsForTests();
    resetTopicSchemaForTests();
  });

  function install(): void {
    log.length = 0;
    env.enablePeacePeriod = false;
    env.enableTopicAwareReplies = false;
    env.teamScorePostAttributionFix = false;
    (supabaseAdmin as { from: (table: string) => unknown }).from = (table: string) => {
      const query: LoggedQuery = { table, select: '', eqs: [], nots: [], gtes: [] };
      let versioned = false;
      const builder: Record<string, unknown> = {};
      const self = () => builder;
      for (const method of [
        'neq',
        'in',
        'is',
        'or',
        'order',
        'limit',
        'lte',
        'gt',
        'lt',
        'filter',
        'like',
        'match',
        'contains',
        'range',
      ]) {
        builder[method] = self;
      }
      builder.lte = () => {
        versioned = true;
        return builder;
      };
      builder.or = () => {
        versioned = true;
        return builder;
      };
      builder.select = (columns: string) => {
        query.select = columns;
        log.push(query);
        return builder;
      };
      builder.eq = (column: string, value: unknown) => {
        query.eqs.push([column, value]);
        return builder;
      };
      builder.not = (column: string, operator: string, value: unknown) => {
        query.nots.push([column, operator, value]);
        return builder;
      };
      builder.gte = (column: string, value: unknown) => {
        query.gtes.push([column, value]);
        return builder;
      };
      const list = () => {
        let rows = rowsFor(table).filter((row) => {
          const record = row as Record<string, unknown>;
          if (
            query.eqs.some(
              ([column, value]) =>
                record[column] !== value && column !== 'scenario_id' && column !== 'session_id',
            )
          ) {
            return false;
          }
          if (
            query.nots.some(
              ([column, operator, value]) =>
                operator === 'is' && value === null && record[column] == null,
            )
          ) {
            return false;
          }
          return true;
        });
        if (table === 'social_posts' && query.eqs.some(([column]) => column === 'author_type')) {
          const author = query.eqs.find(([column]) => column === 'author_type')?.[1];
          rows = rows.filter((row) => (row as { author_type?: string }).author_type === author);
        }
        return rows;
      };
      const payload = () => {
        if (table === 'scenario_teams' && versioned) {
          return {
            data: null,
            error: { code: '42703', message: 'column valid_from does not exist' },
            count: null,
          };
        }
        return { data: list(), error: null, count: list().length };
      };
      builder.single = async () => ({ data: one(table), error: null });
      builder.maybeSingle = async () => ({ data: one(table), error: null });
      builder.then = (resolve: (value: unknown) => unknown, reject?: (err: unknown) => unknown) =>
        Promise.resolve(payload()).then(resolve, reject);
      return builder;
    };
  }

  test('team scores, SOP and the social AAR use the master queries and results', async () => {
    install();
    const { computeTeamScores } = await import('../teamScoreService.js');
    const { evaluateSOPCompliance } = await import('../sopCheckerService.js');
    const { buildSocialSectionsData } = await import('../aarSocialSectionService.js');

    const scores = await computeTeamScores(SESSION);
    const sop = await evaluateSOPCompliance(SESSION, SCENARIO);
    const sections = await buildSocialSectionsData(SESSION);

    const team = scores.teams[0];
    assert.ok(team);
    assert.equal(team.composite_score, MASTER_COMPOSITE);
    assert.equal(team.content_quality, 90);
    assert.equal(team.role_fit, 80);
    assert.equal(team.task_completion, 100);
    assert.equal(team.graded_items, 1);
    assert.equal(team.bridging_comments, undefined);
    assert.equal(team.tasks[0]?.status, 'done');
    assert.equal(team.tasks[0]?.completed_at, '2026-06-01T11:57:00.000Z');
    assert.equal(team.members[0]?.graded_items, 1);

    assert.equal(sop.length, 1);
    assert.equal(sop[0]?.status, 'completed');
    assert.equal(sop[0]?.completed_at, '2026-06-01T11:57:00.000Z');
    assert.deepEqual(sop[0]?.actions_taken, ['reply_posted']);

    assert.equal(sections.before_the_crisis, undefined);
    const recommendations = sections.social_recommendations?.data as { section_count?: number };
    assert.equal(recommendations.section_count, 19);
    const timeline = sections.social_timeline?.data as {
      events?: Array<{ t_plus_min: number | null; title?: string }>;
    };
    const statement = (timeline.events ?? []).find((event) => event.title === 'statement');
    assert.equal(statement?.t_plus_min, 20);

    const gradePosts = log.filter(
      (query) => query.table === 'social_posts' && query.select === MASTER_POST_GRADE_SELECT,
    );
    assert.ok(gradePosts.length >= 1);
    assert.deepEqual(
      gradePosts[0]?.eqs.find(([column]) => column === 'author_type'),
      ['author_type', 'player'],
    );
    assert.ok(
      gradePosts[0]?.nots.some(
        ([column, operator, value]) =>
          column === 'sop_compliance_score' && operator === 'is' && value === null,
      ),
    );
    const gradeEmails = log.filter(
      (query) => query.table === 'sim_emails' && query.select === MASTER_EMAIL_GRADE_SELECT,
    );
    assert.ok(gradeEmails.length >= 1);
    assert.ok(
      log.some(
        (query) =>
          query.table === 'player_actions' &&
          query.select === 'player_id, action_type, team_at_action, metadata, created_at',
      ),
    );
    assert.ok(
      log.some(
        (query) =>
          query.table === 'player_actions' &&
          query.select === 'action_type, sop_step_matched, created_at, metadata',
      ),
    );
    assert.equal(
      log.some((query) => /topic_class|topic_kind|peace_ref/.test(query.select)),
      false,
    );
    assert.equal(
      log.some((query) => query.gtes.length > 0),
      false,
    );
  });
});
