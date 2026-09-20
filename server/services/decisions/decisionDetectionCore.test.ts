import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isEligibleAuthor,
  passesPreFilter,
  normaliseDetection,
  shouldAct,
  slugForDecision,
  resolveInformedSet,
  informedFunctions,
  looksLikeFormalNotice,
  MIN_CONFIDENCE,
} from './decisionDetectionCore.js';

describe('eligibility (plan §1 answer #1)', () => {
  test('Executive may decide anything', () => {
    assert.equal(isEligibleAuthor('Executive'), true);
    assert.equal(isEligibleAuthor('Executive', 'workforce'), true);
    assert.equal(isEligibleAuthor('Executive', 'legal_action'), true);
  });
  test('Legal only for legal_action; Communications only for public_position', () => {
    assert.equal(isEligibleAuthor('Legal'), true); // eligible to be checked
    assert.equal(isEligibleAuthor('Legal', 'legal_action'), true);
    assert.equal(isEligibleAuthor('Legal', 'workforce'), false);
    assert.equal(isEligibleAuthor('Communications', 'public_position'), true);
    assert.equal(isEligibleAuthor('Communications', 'operations'), false);
  });
  test('other functions and unassigned authors are rejected', () => {
    assert.equal(isEligibleAuthor('Stakeholder Engagement'), false);
    assert.equal(isEligibleAuthor('Operations', 'operations'), false);
    assert.equal(isEligibleAuthor(null), false);
  });
});

describe('pre-filter', () => {
  test('short messages never pass', () => {
    assert.equal(passesPreFilter('We are closing Johor.'), false);
  });
  test('decision verbs pass; chatter does not', () => {
    assert.equal(
      passesPreFilter(
        'Team — we are suspending the Johor line for 30 days effective immediately. HR to follow up.',
      ),
      true,
    );
    assert.equal(
      passesPreFilter(
        'Good morning everyone, can someone send me the latest numbers from the Johor plant please?',
      ),
      false,
    );
  });
  test('a thread that already holds a candidate lets follow-ups through without a verb', () => {
    const text =
      'Yes. That is confirmed for all three shifts and the contractors as discussed earlier today.';
    assert.equal(passesPreFilter(text, false), false);
    assert.equal(passesPreFilter(text, true), true);
  });
});

describe('normalisation + act gate', () => {
  const known = new Set(['stk_a', 'stk_b']);
  const fns = new Set(['Executive', 'Legal', 'Communications', 'People Ops']);
  test('coerces bad values and drops unknown ids / functions', () => {
    const d = normaliseDetection(
      {
        is_decision: true,
        confidence: '0.91',
        finality: 'final',
        summary: '  Suspended the Johor line for 30 days. ',
        category: 'workforce',
        scope: { org_key: 'primary', country: 'Malaysia', subject: 'Johor line' },
        affected_stakeholder_ids: ['stk_a', 'ghost', 'stk_a'],
        should_know_functions: ['People Ops', 'Marketing'],
        should_know_stakeholder_ids: ['stk_b'],
        reverses: 'none',
      },
      known,
      fns,
    );
    assert.equal(d.confidence, 0.91);
    assert.equal(d.summary, 'Suspended the Johor line for 30 days.');
    assert.deepEqual(d.affected_stakeholder_ids, ['stk_a']);
    assert.deepEqual(d.should_know_functions, ['People Ops']);
    assert.equal(d.reverses, null);
    assert.equal(d.scope.site_key, null);
  });
  test('garbage in → safe non-decision out', () => {
    const d = normaliseDetection(null, known, fns);
    assert.equal(d.is_decision, false);
    assert.equal(d.confidence, 0);
    assert.equal(d.finality, 'exploratory');
    assert.equal(d.category, 'other');
  });
  test('only final + confident + eligible decisions act', () => {
    const base = normaliseDetection(
      {
        is_decision: true,
        confidence: 0.9,
        finality: 'final',
        summary: 'Closed the Johor depot for 30 days.',
        category: 'workforce',
      },
      known,
      fns,
    );
    assert.equal(shouldAct(base, 'Executive'), true);
    assert.equal(shouldAct({ ...base, finality: 'conditional' }, 'Executive'), false);
    assert.equal(shouldAct({ ...base, confidence: MIN_CONFIDENCE - 0.01 }, 'Executive'), false);
    assert.equal(shouldAct(base, 'Legal'), false, 'Legal cannot take a workforce decision');
    assert.equal(shouldAct({ ...base, category: 'legal_action' }, 'Legal'), true);
    assert.equal(shouldAct({ ...base, summary: 'x' }, 'Executive'), false);
  });
});

describe('slugs', () => {
  test('stable, stop-word free, unique', () => {
    const taken = new Set<string>();
    const a = slugForDecision('We have decided to close the Johor depot for 30 days', taken);
    const b = slugForDecision('We have decided to close the Johor depot for 30 days', taken);
    assert.equal(a, 'close_johor_depot_30_days');
    assert.equal(b, 'close_johor_depot_30_days_2');
  });
});

describe('informed set', () => {
  const players = [
    {
      user_id: 'u_ceo',
      address: 'ceo@crisisresponse.sim',
      team_name: 'Executive — HQ',
      function_key: 'Executive',
    },
    {
      user_id: 'u_hr',
      address: 'hr.lead@crisisresponse.sim',
      team_name: 'People Ops — HQ',
      function_key: 'People Ops',
    },
    {
      user_id: 'u_comms',
      address: 'comms@crisisresponse.sim',
      team_name: 'Communications — HQ',
      function_key: 'Communications',
    },
  ];
  const byEmail = new Map([
    ['site.manager@slm.sim', { id: 'stk_site_mgr', kind: 'person' as const, members: [] }],
    [
      'all-staff.johor@slm.sim',
      { id: 'stk_list', kind: 'group' as const, members: ['stk_r1', 'stk_r2'] },
    ],
  ]);
  test('email to/cc → players (and their teams), stakeholders, groups expanded to members', () => {
    const informed = resolveInformedSet({
      addresses: [
        'HR.Lead@crisisresponse.sim',
        'site.manager@slm.sim',
        'all-staff.johor@slm.sim',
        'ceo@crisisresponse.sim',
      ],
      players,
      stakeholdersByEmail: byEmail,
      authorUserId: 'u_ceo',
      via: 'direct_message',
    });
    const keys = informed.map((a) => `${a.actor_kind}:${a.actor_id}`);
    assert.ok(keys.includes('player:u_hr'));
    assert.ok(keys.includes('team:People Ops — HQ'));
    assert.ok(keys.includes('stakeholder:stk_site_mgr'));
    assert.ok(keys.includes('group:stk_list'));
    assert.ok(keys.includes('stakeholder:stk_r1') && keys.includes('stakeholder:stk_r2'));
    assert.ok(!keys.includes('player:u_ceo'), 'author is not "told"');
    assert.ok(!keys.includes('team:Executive — HQ'));
  });
  test('chat: channel members become informed players/teams; NPC DM informs the stakeholder', () => {
    const informed = resolveInformedSet({
      addresses: [],
      players,
      stakeholdersByEmail: byEmail,
      channelMembers: [
        { user_id: 'u_ceo', team_name: 'Executive — HQ', function_key: 'Executive' },
        { user_id: 'u_comms', team_name: 'Communications — HQ', function_key: 'Communications' },
      ],
      directStakeholderId: 'stk_site_mgr',
      authorUserId: 'u_ceo',
      via: 'direct_message',
    });
    const keys = informed.map((a) => `${a.actor_kind}:${a.actor_id}`);
    assert.deepEqual(keys, [
      'player:u_comms',
      'team:Communications — HQ',
      'stakeholder:stk_site_mgr',
    ]);
    const fns = informedFunctions(informed, [
      { team_name: 'Communications — HQ', function_key: 'Communications' },
      { team_name: 'People Ops — HQ', function_key: 'People Ops' },
    ]);
    assert.deepEqual(Array.from(fns), ['Communications']);
  });
});

describe('formal notice heuristic (§6.6)', () => {
  const summary = 'Suspended the Johor production line for 30 days from Monday.';
  test('HR mail to the distribution list about the decision is a notice', () => {
    assert.equal(
      looksLikeFormalNotice(
        'Dear colleagues, as you may have heard, the Johor production line will be suspended for 30 days from Monday. Your pay continues; HR will meet every shift.',
        [{ relationship: 'internal', kind: 'group', title: 'Distribution list' }],
        summary,
      ),
      true,
    );
  });
  test('a mail to a journalist is not a notice; an unrelated mail to staff is not a notice', () => {
    assert.equal(
      looksLikeFormalNotice(
        'The Johor production line will be suspended for 30 days.',
        [{ relationship: 'media', kind: 'person', title: 'Reporter' }],
        summary,
      ),
      false,
    );
    assert.equal(
      looksLikeFormalNotice(
        'Reminder: the canteen closes early on Friday.',
        [{ relationship: 'internal', kind: 'group', title: 'Distribution list' }],
        summary,
      ),
      false,
    );
  });
});
