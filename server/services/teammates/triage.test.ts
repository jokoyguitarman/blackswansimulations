import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { intellectToParams } from './intellect.js';
import { createBoard, createMemory, claim } from './memory.js';
import type { Situation, TaggedPost } from './perception.js';
import type { SimEmail, Draft, DmThread } from './apiClient.js';
import { allowedKinds, functionOf, triage, type TriageRolls } from './triage.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-09-20T08:00:00Z');

/** Named draws pinned per test. Defaults: never idle, always counter, never neglect, no mischief. */
const rolls = (over: Partial<Record<keyof TriageRolls, number>> = {}): TriageRolls => ({
  idle: () => over.idle ?? 0.99,
  counter: () => over.counter ?? 0,
  neglect: () => over.neglect ?? 0.99,
  mischief: () => over.mischief ?? 0.99,
});
const steady = rolls();

function post(over: Partial<TaggedPost> = {}): TaggedPost {
  return {
    id: over.id ?? 'post-1',
    platform: 'x_twitter',
    user_id: null,
    author_handle: 'truthseeker88',
    author_display_name: 'Truth Seeker',
    author_type: 'npc_public',
    content: 'They are hiding the missing money!',
    reply_to_post_id: null,
    content_flags: { is_misinformation: true },
    virality_score: 70,
    requires_response: false,
    responded_at: null,
    reply_count: 0,
    created_at: new Date(NOW - 120_000).toISOString(),
    tags: ['FALSE-CLAIM'],
    harmful: true,
    handledByTeam: false,
    ageMinutes: 2,
    ...over,
  };
}

function email(over: Partial<SimEmail> = {}): SimEmail {
  return {
    id: over.id ?? 'email-1',
    direction: 'inbound',
    from_address: 'reporter@straitstimes.sim',
    from_name: 'Reporter',
    to_addresses: ['team@crisisresponse.sim'],
    subject: 'Deadline 10 minutes: comment on allegations',
    body_text: 'We are publishing at 8:10. Any comment?',
    replied_to_id: null,
    thread_id: null,
    sent_by_player_id: null,
    recipient_user_ids: null,
    is_read: false,
    priority: 'high',
    created_at: new Date(NOW - 60_000).toISOString(),
    ...over,
  };
}

function draft(over: Partial<Draft> = {}): Draft {
  return {
    id: over.id ?? 'draft-1',
    author_id: 'human-comms',
    author_name: 'Nurul',
    team_name: 'Legal',
    title: 'Holding statement',
    content_text: 'We are aware...',
    content_html: '<p>We are aware...</p>',
    status: 'in_review',
    submitted_at: new Date(NOW - 30_000).toISOString(),
    reviewed_by: null,
    review_note: null,
    updated_at: new Date(NOW - 30_000).toISOString(),
    ...over,
  };
}

function dm(over: Partial<DmThread> = {}): DmThread {
  return {
    thread_id: over.thread_id ?? 'thread-1',
    latest_message: {
      id: 'msg-1',
      thread_id: over.thread_id ?? 'thread-1',
      sender_handle: '@customer',
      sender_display_name: 'Customer',
      recipient_handle: '@amp',
      content: 'Is my refund coming?',
      is_read: false,
      created_at: new Date(NOW - 60_000).toISOString(),
    },
    unread_count: 1,
    other_participant: { handle: '@customer', display_name: 'Customer' },
    is_org_page_thread: true,
    ...over,
  };
}

function situation(over: Partial<Situation> = {}, team = 'Communications'): Situation {
  const canPost = team === 'Communications';
  return {
    now: NOW,
    elapsedMinutes: 10,
    me: {
      userId: 'bot-1',
      displayName: 'Nurul Aisyah Rahim',
      handle: '@nurul_aisyah_rahim',
      address: 'nurul.aisyah.rahim@crisisresponse.sim',
      teamName: team,
      isPageHolder: canPost,
      pageHandle: canPost ? '@amp' : null,
      pageName: canPost ? 'AMP' : null,
    },
    charter: {
      team_name: team,
      function_key: team,
      org_key: null,
      mission: 'm',
      responsibilities: [],
      out_of_lane: [],
      tasks: [],
      expected_actions: [],
      can_post_publicly: canPost,
      scoring_rubric: '',
    },
    facts: {
      orgName: 'AMP',
      confirmed: ['One initiative affected'],
      unconfirmed: [],
      guidelines: [],
    },
    feed: [],
    harmful: [],
    needsResponse: [],
    emails: { unanswered: [], unread: [], intel: [], all: [] },
    dms: [],
    chat: {
      teamChannelId: 'chan-team',
      allTeamsChannelId: 'chan-all',
      recent: [],
      mentions: [],
      nudges: [],
    },
    drafts: { toReview: [], mine: [], approvedUnpublished: [], changesRequested: [] },
    news: [],
    gauges: {
      public_trust: 60,
      community_safety: 60,
      narrative_control: 60,
      escalation_risk: 30,
      sentiment_score: 0,
    },
    officialStatements: [],
    lastOfficialStatementAt: NOW - 5 * 60_000,
    teammates: [],
    teams: new Map([
      ['Communications', []],
      [
        'Legal',
        [
          {
            user_id: 'human-legal',
            full_name: 'Grace',
            team_name: 'Legal',
            address: 'grace@crisisresponse.sim',
            isMe: false,
          },
        ],
      ],
    ]),
    publicVoiceTeam: 'Communications',
    intelToRelay: [],
    ...over,
  };
}

const expert = intellectToParams(85);
const novice = intellectToParams(0);

// ---------------------------------------------------------------------------
// Lane gating
// ---------------------------------------------------------------------------

describe('allowedKinds / functionOf', () => {
  test('public-voice team may reply, post and (as page holder) publish statements', () => {
    const sit = situation();
    assert.equal(functionOf(sit), 'public_voice');
    const kinds = allowedKinds(sit, expert);
    assert.ok(kinds.has('reply'));
    assert.ok(kinds.has('post'));
    assert.ok(kinds.has('statement'));
    assert.ok(!kinds.has('repost'));
  });

  test('a drilled Legal bot never posts publicly, an untrained one may', () => {
    const sit = situation({}, 'Legal');
    assert.equal(functionOf(sit), 'legal');
    const drilled = allowedKinds(sit, expert);
    assert.ok(!drilled.has('post'));
    assert.ok(!drilled.has('reply'));
    assert.ok(drilled.has('dispute'));
    const untrained = allowedKinds(sit, novice);
    assert.ok(untrained.has('post'));
    assert.ok(untrained.has('reply'));
  });

  test('non-voice teams only reply when undrilled', () => {
    const sit = situation({}, 'Stakeholder Engagement');
    assert.equal(functionOf(sit), 'other');
    assert.ok(!allowedKinds(sit, expert).has('reply'));
    assert.ok(allowedKinds(sit, intellectToParams(50)).has('reply'));
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe('triage ordering', () => {
  test('a document awaiting my review outranks an urgent email, which outranks a harmful post', () => {
    const sit = situation(
      {
        drafts: { toReview: [draft()], mine: [], approvedUnpublished: [], changesRequested: [] },
        emails: { unanswered: [email()], unread: [email()], intel: [], all: [email()] },
        harmful: [post()],
        feed: [post()],
      },
      'Legal',
    );
    const items = triage({
      sit,
      params: expert,
      mem: createMemory(),
      board: null,
      isLead: false,
      rolls: steady,
    });
    assert.equal(items[0].kind, 'draft_review');
    assert.equal(items[1].kind, 'email_reply');
    assert.equal(items[2].kind, 'dispute', 'Legal counters misinformation with a dispute');
  });

  test('trainer nudges go to the very top', () => {
    const sit = situation({
      chat: {
        teamChannelId: 'c',
        allTeamsChannelId: 'a',
        recent: [],
        mentions: [],
        nudges: [
          {
            id: 'm1',
            sender_id: 'trainer',
            content: 'Nurul, publish the holding statement now',
            created_at: new Date(NOW).toISOString(),
            sender: { id: 'trainer', full_name: 'Trainer', role: 'trainer' },
          },
        ],
      },
      drafts: {
        toReview: [draft({ team_name: 'Communications' })],
        mine: [],
        approvedUnpublished: [],
        changesRequested: [],
      },
    });
    const items = triage({
      sit,
      params: expert,
      mem: createMemory(),
      board: null,
      isLead: false,
      rolls: steady,
    });
    assert.equal(items[0].kind, 'chat');
    assert.match(items[0].reason, /trainer instruction/);
  });

  test('page holder with no statement after T+3 wants one; routes it through Legal when Legal is staffed', () => {
    const sit = situation({ lastOfficialStatementAt: null, elapsedMinutes: 5 });
    const items = triage({
      sit,
      params: expert,
      mem: createMemory(),
      board: null,
      isLead: false,
      rolls: steady,
    });
    const first = items[0];
    assert.equal(first.kind, 'draft_create', 'publish gate: draft for Legal review first');
    assert.match(first.reason, /no official statement/);
  });

  test('page holder publishes directly when Legal is unstaffed', () => {
    const sit = situation({
      lastOfficialStatementAt: null,
      elapsedMinutes: 5,
      teams: new Map([['Communications', []]]),
    });
    const items = triage({
      sit,
      params: expert,
      mem: createMemory(),
      board: null,
      isLead: false,
      rolls: steady,
    });
    assert.equal(items[0].kind, 'statement');
  });

  test('an approved document is published as-is with its wording', () => {
    const approved = draft({
      id: 'd-ok',
      status: 'approved',
      author_id: 'bot-1',
      team_name: 'Communications',
      content_text: 'APPROVED TEXT',
    });
    const sit = situation({
      drafts: {
        toReview: [],
        mine: [approved],
        approvedUnpublished: [approved],
        changesRequested: [],
      },
    });
    const items = triage({
      sit,
      params: expert,
      mem: createMemory(),
      board: null,
      isLead: false,
      rolls: steady,
    });
    assert.equal(items[0].kind, 'statement');
    assert.equal(items[0].targetId, 'd-ok');
    assert.equal(items[0].context, 'APPROVED TEXT');
  });
});

// ---------------------------------------------------------------------------
// Coordination and degradation
// ---------------------------------------------------------------------------

describe('triage coordination', () => {
  test('targets claimed by a teammate are skipped', () => {
    const board = createBoard('Communications');
    claim(board, 'post-1', { by: 'bot-2', byName: 'Daniel', kind: 'reply', at: NOW });
    const sit = situation({ harmful: [post()], feed: [post()] });
    const items = triage({
      sit,
      params: expert,
      mem: createMemory(),
      board,
      isLead: false,
      rolls: steady,
    });
    assert.ok(!items.some((it) => it.targetId === 'post-1'), 'claimed post is not offered');
  });

  test('intel relay is offered to a coordinating bot and hidden from a lone wolf', () => {
    const rel = {
      email: email({ id: 'intel-1', inject_id: 'inj-1', subject: 'Supplier audit result' }),
      entry: {
        intel_key: 'audit',
        holder_team: 'Communications',
        needed_by: ['Legal'],
        detection_keywords: [],
        summary: 'Audit result',
        source_inject_id: 'inj-1',
        source_title: 'Audit',
        trigger_time_minutes: 5,
        deadline_minutes: 20,
      },
      recipients: [
        {
          user_id: 'human-legal',
          full_name: 'Grace',
          team_name: 'Legal',
          address: 'grace@crisisresponse.sim',
          isMe: false,
        },
      ],
    };
    const sit = situation({ intelToRelay: [rel] });
    const coordinated = triage({
      sit,
      params: expert,
      mem: createMemory(),
      board: null,
      isLead: false,
      rolls: steady,
    });
    assert.ok(
      coordinated.some(
        (it) => it.kind === 'email_forward' && it.to?.[0] === 'grace@crisisresponse.sim',
      ),
    );
    const lone = triage({
      sit,
      params: novice,
      mem: createMemory(),
      board: null,
      isLead: false,
      rolls: steady,
    });
    assert.ok(!lone.some((it) => it.kind === 'email_forward'));
  });

  test('the team lead posts a plan early; others do not', () => {
    const board = createBoard('Communications');
    const sit = situation();
    const lead = triage({
      sit,
      params: expert,
      mem: createMemory(),
      board,
      isLead: true,
      rolls: steady,
    });
    assert.ok(lead.some((it) => it.kind === 'chat' && it.targetId === 'plan'));
    const member = triage({
      sit,
      params: expert,
      mem: createMemory(),
      board,
      isLead: false,
      rolls: steady,
    });
    assert.ok(!member.some((it) => it.targetId === 'plan'));
  });

  test('novice mostly ignores harmful posts and may engage with them instead', () => {
    const sit = situation({ harmful: [post()], feed: [post()] });
    // counter draw 0.5 >= novice counterRate 0.05 -> not countered; no mischief.
    const ignoring = triage({
      sit,
      params: novice,
      mem: createMemory(),
      board: null,
      isLead: false,
      rolls: rolls({ counter: 0.5 }),
    });
    assert.ok(
      !ignoring.some((it) => it.kind === 'reply' || it.kind === 'flag'),
      'counterRate gate not tripped',
    );
    // mischief draw 0 -> out-of-lane post and engaging with the harmful post.
    const engaging = triage({
      sit,
      params: novice,
      mem: createMemory(),
      board: null,
      isLead: false,
      rolls: rolls({ counter: 0.5, mischief: 0 }),
    });
    assert.ok(
      engaging.some(
        (it) => (it.kind === 'like' || it.kind === 'repost') && it.targetId === 'post-1',
      ),
    );
    assert.ok(
      engaging.some((it) => it.kind === 'post'),
      'novice on the voice team weighs in publicly',
    );
  });

  test('idle bias drops mid-priority work but keeps urgent desk items', () => {
    const sit = situation(
      {
        drafts: { toReview: [draft()], mine: [], approvedUnpublished: [], changesRequested: [] },
        harmful: [post()],
        feed: [post()],
      },
      'Legal',
    );
    const items = triage({
      sit,
      params: intellectToParams(30),
      mem: createMemory(),
      board: null,
      isLead: false,
      rolls: rolls({ idle: 0 }),
    });
    assert.equal(items[0].kind, 'draft_review', 'urgent desk item survives the idle filter');
    assert.ok(
      !items.some((it) => it.kind === 'dispute' || it.kind === 'flag'),
      'mid-priority countering dropped',
    );
    assert.equal(items[items.length - 1].kind, 'idle');
  });

  test('DMs and already-handled targets', () => {
    const mem = createMemory();
    mem.handled.add('thread-1');
    const sit = situation({ dms: [dm(), dm({ thread_id: 'thread-2' })] });
    const items = triage({ sit, params: expert, mem, board: null, isLead: false, rolls: steady });
    const dmItems = items.filter((it) => it.kind === 'dm_reply');
    assert.equal(dmItems.length, 1);
    assert.equal(dmItems[0].targetId, 'thread-2');
    assert.equal(dmItems[0].recipientHandle, '@customer');
  });

  test('always ends with idle so a turn never has nothing to pick', () => {
    const sit = situation();
    const items = triage({
      sit,
      params: expert,
      mem: createMemory(),
      board: null,
      isLead: false,
      rolls: steady,
    });
    assert.equal(items[items.length - 1].kind, 'idle');
  });
});
