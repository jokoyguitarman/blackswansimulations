import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { buildCommsResponsesSection } from '../aarCommsResponses.js';
import { isKnownConditionKey } from '../conditions/conditionCatalog.js';
import { compositeScore, contentBreakdown, directorRefsFromResponses, isDirectorInjectKey } from '../teamScoreService.js';
import { isAiOwned } from '../../lib/injectFingerprint.js';
import { createDirectorRouter } from '../../routes/director.js';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import type { RequestHandler } from 'express';
import { timelineOriginFor } from '../../../shared/crossTeamPanel.js';
import {
  buildUnscriptedTable,
  decisionMinuteOf,
  fairnessSummary,
  parseStoredFairness,
  promotionConditions,
  replayStatusOf,
  unscriptedNotesFrom,
  unscriptedSentence,
  type UnscriptedProposalInput,
} from './directorAarCore.js';
import { buildPromotedTemplate } from './directorPublish.js';
import {
  replayDirectorSession,
  type ReplayRow,
} from './directorReplay.js';
import {
  runDirectorTurn,
  type DirectorClient,
  type DirectorTurnInput,
} from './directorCore.js';
import type { Signal } from './directorSignals.js';
import type { ParsedProposal } from './directorCore.js';

const silence: Signal = {
  id: 'team_silent:legal:10',
  kind: 'team_silent',
  team: 'Legal',
  minute: 12,
  detail: 'Legal has been silent for 12 min',
  depth: 1,
  keys: ['team_silent:10|team=legal'],
  notable: true,
};

const mood: Signal = {
  id: 'mood:stk_maria:Legal:angry:12',
  kind: 'mood',
  team: 'Legal',
  minute: 12,
  detail: 'Maria Tan is angry toward Legal',
  depth: 1,
  keys: [],
  notable: true,
};

function proposal(overrides: Partial<ParsedProposal> = {}): ParsedProposal {
  return {
    kind: 'consequence',
    cause: { signal_ids: [silence.id], source_teams: ['Legal'] },
    target_teams: ['Communications'],
    target_role_id: null,
    app: 'email',
    sender: { stakeholder_id: 'stk_maria' },
    title: 'Comment on the Bay 3 incident',
    content: 'I understand your communications team is waiting on a statement.',
    severity: 'medium',
    requires_response: true,
    response_rubric: null,
    follow_up: null,
    ...overrides,
  };
}

test('promotion keeps catalogue signal keys and times the rest', () => {
  const templates = new Set(['bay3_mail']);
  const mapped = promotionConditions(
    [silence, mood],
    [silence.id, mood.id],
    27,
    isKnownConditionKey,
    templates,
  );
  assert.deepEqual(mapped.conditions_to_appear, { all: ['team_silent:10|team=legal'] });
  assert.equal(mapped.trigger_time_minutes, null);

  const timed = promotionConditions([mood], [mood.id], 27, isKnownConditionKey, templates);
  assert.equal(timed.conditions_to_appear, null);
  assert.equal(timed.trigger_time_minutes, 27);

  const unknown = promotionConditions(
    [{ id: 'custom', keys: ['not_a_catalogue_key'] }],
    ['custom'],
    18,
    isKnownConditionKey,
    templates,
  );
  assert.equal(unknown.trigger_time_minutes, 18);

  const reply = promotionConditions(
    [
      {
        id: 'reply',
        keys: [
          'reply_failed:dir_3|team=communications',
          'reply_failed:no_such_inject|team=communications',
          'reply_failed:bay3_mail|team=communications',
        ],
      },
    ],
    ['reply'],
    27,
    isKnownConditionKey,
    new Set(['bay3_mail', 'dir_3']),
  );
  assert.deepEqual(reply.conditions_to_appear, {
    all: ['reply_failed:bay3_mail|team=communications'],
  });

  const onlyDirector = promotionConditions(
    [{ id: 'reply', keys: ['reply_failed:dir_3|team=communications'] }],
    ['reply'],
    27,
    isKnownConditionKey,
    new Set(['dir_3']),
  );
  assert.equal(onlyDirector.conditions_to_appear, null);
  assert.equal(onlyDirector.trigger_time_minutes, 27);
});

test('a promoted template is trainer-owned, stamped promoted, and AI-owned only when unedited', () => {
  const shared = {
    scenarioId: 'scenario-1',
    proposalId: '33333333-3333-4333-8333-333333333333',
    minute: 27,
    proposal: proposal(),
    signals: [silence],
    people: [{ id: 'stk_maria', name: 'Maria Tan', email: 'maria@paper.test' }],
    npcs: [],
    takenKeys: new Set<string>(),
  };
  const fresh = buildPromotedTemplate({ ...shared, edited: false });
  assert.equal(fresh.generation_source, 'trainer');
  assert.equal(fresh.session_id, null);
  assert.equal(fresh.trigger_time_minutes, null);
  assert.deepEqual(fresh.conditions_to_appear, { all: ['team_silent:10|team=legal'] });
  assert.deepEqual(fresh.target_teams, ['Communications']);
  const config = fresh.delivery_config as {
    app: string;
    from_name: string;
    gen: { layer: string; edit: number; hash?: string };
    promoted_from: string;
  };
  assert.equal(config.app, 'email');
  assert.equal(config.from_name, 'Maria Tan');
  assert.equal(config.gen.layer, 'promoted');
  assert.equal(config.gen.edit, 0);
  assert.equal(config.promoted_from, shared.proposalId);
  assert.equal((config.gen as { stakeholder_id?: string }).stakeholder_id, 'stk_maria');
  assert.equal((fresh.delivery_config as { cause?: { kind?: string } }).cause?.kind, 'authored');
  assert.equal(isAiOwned(fresh), true);

  const changed = buildPromotedTemplate({
    ...shared,
    edited: true,
    proposal: proposal({ content: 'A trainer rewrote this.' }),
  });
  const changedGen = (changed.delivery_config as { gen: { edit: number; hash?: string } }).gen;
  assert.equal(changedGen.edit, 1);
  assert.equal(changedGen.hash, undefined);
  assert.equal(isAiOwned(changed), false);

  const fallback = buildPromotedTemplate({
    ...shared,
    edited: false,
    minute: 27,
    proposal: proposal({ cause: { signal_ids: [mood.id], source_teams: ['Legal'] } }),
    signals: [mood],
  });
  assert.equal(fallback.trigger_time_minutes, 27);
  assert.equal(fallback.conditions_to_appear, null);

  const collided = buildPromotedTemplate({
    ...shared,
    edited: false,
    takenKeys: new Set(['comment_on_the_bay_3_incident']),
  });
  const collidedKey = (collided.delivery_config as { inject_key: string }).inject_key;
  assert.equal(collidedKey, 'comment_on_the_bay_3_incident_2');
});

test('the composite is identical with and without the content breakdown', () => {
  const refs = directorRefsFromResponses([
    { ref_table: 'sim_emails', ref_id: 'email-1', inject_key: 'dir_3' },
    { ref_table: 'social_posts', ref_id: 'post-1', inject_key: 'bay3_mail' },
    { ref_table: 'sim_emails', ref_id: 'email-2', inject_key: 'dirX3' },
  ]);
  assert.deepEqual([...refs], ['sim_emails:email-1']);
  assert.equal(isDirectorInjectKey('dir_4'), true);
  const authored = 80;
  const unscripted = 40;
  const legacyQuality = Math.round((authored + unscripted) / 2);
  const parts = { tasks: 70, role: 60, collaboration: 50 };
  const legacy = compositeScore({ content: legacyQuality, ...parts });
  const split = contentBreakdown(
    [
      { refId: 'social_posts:post-1', overall: authored },
      { refId: 'sim_emails:email-1', overall: unscripted },
    ],
    refs,
  );
  const withBreakdown = compositeScore({ content: split.quality, ...parts });
  assert.equal(withBreakdown, legacy);
  assert.equal(split.quality, legacyQuality);
  assert.deepEqual(split.breakdown.authored, { items: 1, avg: authored });
  assert.deepEqual(split.breakdown.unscripted, { items: 1, avg: unscripted });
});

test('the director sentence uses the decision minute', () => {
  const start = '2026-11-28T12:00:00.000Z';
  const decided = '2026-11-28T12:20:00.000Z';
  assert.equal(decisionMinuteOf(decided, start, 12), 20);
  const notes = unscriptedNotesFrom([
    {
      seq: 2,
      status: 'approved',
      reason: 'Legal has been silent for 12 min',
      approver: 'Aisha',
      edited: true,
      decisionMinute: decisionMinuteOf(decided, start, 12),
    },
    {
      seq: 3,
      status: 'auto_published',
      reason: 'a lull',
      approver: 'auto',
      edited: false,
      decisionMinute: 27,
    },
  ]);
  assert.equal(
    notes.dir_2,
    'proposed by the AI director because Legal has been silent for 12 min; approved by Aisha at T+20 (edited)',
  );
  assert.equal(notes.dir_3, 'proposed by the AI director because a lull; auto-published');
  assert.equal(
    unscriptedSentence({ reason: 'silence', minute: 20, approver: 'Aisha', edited: false }),
    'proposed by the AI director because silence; approved by Aisha at T+20',
  );
  assert.equal(parseStoredFairness({ teams: [{ team: 'Legal' }] }), null);
  assert.equal(parseStoredFairness({ teams: [{ team: 'Legal', negative_load: 2, positive_load: 1 }] })?.teams[0]?.negative_load, 2);
});

test('timeline rows carry origin labels, including director notes on non-branch rows', () => {
  assert.equal(
    timelineOriginFor({
      event: 'delivered',
      trigger: { origin: 'timed', source_teams: ['Legal'], target_teams: ['Legal'] },
    }),
    'Authored (timed)',
  );
  assert.equal(timelineOriginFor({ event: 'chain_step' }), 'Escalation step');
  assert.equal(timelineOriginFor({ event: 'mood' }), 'Mood consequence');
  assert.equal(timelineOriginFor({ event: 'delivered' }), 'inferred');

  const section = buildCommsResponsesSection({
    injects: [
      { id: 'inj-dir', inject_key: 'dir_2', title: 'Reporter', requires_response: true },
      { id: 'inj-mail', inject_key: 'bay3_mail', title: 'Headcount', requires_response: true },
    ],
    deliveries: [
      {
        id: 'del-dir',
        inject_id: 'inj-dir',
        inject_key: 'dir_2',
        channel: 'email',
        delivered_minute: 27,
        requires_response: true,
        recipient_teams: ['Communications'],
      },
      {
        id: 'del-mail',
        inject_id: 'inj-mail',
        inject_key: 'bay3_mail',
        channel: 'email',
        delivered_minute: 8,
        requires_response: true,
        recipient_teams: ['Operations'],
      },
    ],
    triggers: [
      {
        inject_id: 'inj-dir',
        inject_key: 'dir_2',
        origin: 'director',
        source_teams: ['Legal'],
        target_teams: ['Communications'],
      },
      {
        inject_key: 'bay3_mail',
        origin: 'conditional',
        source_teams: ['Operations'],
        target_teams: ['Communications'],
      },
    ],
    chains: [
      {
        id: 'chain-1',
        root_key: 'bay3_mail',
        status: 'exhausted',
        steps_sent: 1,
        max_steps: 1,
        stopped_minute: 20,
      },
    ],
    steps: [
      { chain_id: 'chain-1', step_no: 1, urgency: 'follow_up', app: 'email', delivered_minute: 16 },
    ],
    moods: [
      {
        stakeholder_id: 'stk_maria',
        scope_team: 'Communications',
        rung_id: 'angry',
        history: [{ rung: 'angry', minute: 18, reason: 'no statement' }],
      },
    ],
    unscriptedNotes: {
      dir_2: unscriptedSentence({
        reason: 'Legal has been silent for 12 min',
        minute: 27,
        approver: 'auto',
        edited: false,
      }),
    },
  });

  const director = section.timeline.find((row) => row.event === 'delivered' && row.inject === 'dir_2');
  assert.equal(director?.origin, 'Unscripted (AI director)');
  assert.match(director?.origin_note ?? '', /auto-published/);
  assert.match(director?.origin_note ?? '', /Legal has been silent/);
  const mail = section.timeline.find((row) => row.event === 'delivered' && row.inject === 'bay3_mail');
  assert.equal(mail?.origin, 'Cross-team consequence');
  const step = section.timeline.find((row) => row.event === 'chain_step');
  assert.equal(step?.origin, 'Escalation step');
  const moodRow = section.timeline.find((row) => row.event === 'mood' && row.detail.includes('angry'));
  assert.equal(moodRow?.origin, 'Mood consequence');
});

test('the unscripted table, fairness summary and replay status come from fixtures', async () => {
  const published: UnscriptedProposalInput = {
    seq: 2,
    minute: 27,
    status: 'auto_published',
    reason: 'Legal has been silent for 12 min',
    proposal: {
      title: 'Comment on the Bay 3 incident',
      content: 'Waiting on a statement.',
      target_teams: ['Communications'],
      cause: { signal_ids: [silence.id], source_teams: ['Legal'] },
    },
    signals: [silence],
    guardrails: [{ id: 'meta', ok: true, detail: 'in world' }],
    fairness: {
      teams: [
        {
          team: 'Communications',
          size: 2,
          staffed: true,
          negative_load: 2,
          positive_load: 0,
          fair_share: 1,
          size_scale: 1,
          relief_owed: false,
          over_cap: false,
        },
      ],
      tolerance: 2,
      last_third: false,
      mean_negative: 1,
      minute: 27,
      duration: 60,
    },
    approverName: null,
    editBefore: null,
    editAfter: null,
    vetoReason: null,
    injectId: 'inject-1',
  };
  const edited: UnscriptedProposalInput = {
    ...published,
    seq: 3,
    minute: 30,
    status: 'edited',
    approverName: 'Aisha',
    editBefore: { title: 'Comment on the Bay 3 incident', content: 'Waiting on a statement.' },
    editAfter: { title: 'Comment on the Bay 3 incident', content: 'Can you confirm the headcount?' },
    proposal: {
      ...published.proposal,
      content: 'Can you confirm the headcount?',
      target_teams: ['Legal'],
    },
  };
  const vetoed: UnscriptedProposalInput = {
    ...published,
    seq: 4,
    minute: 32,
    status: 'vetoed',
    approverName: 'Aisha',
    vetoReason: 'too soon',
    injectId: null,
  };
  const table = buildUnscriptedTable([vetoed, published, edited]);
  assert.equal(table.events.length, 2);
  assert.equal(table.events[0]?.approver, 'auto');
  assert.equal(table.events[0]?.outcome, 'published');
  assert.equal(table.events[0]?.guardrails, 'all passed');
  assert.match(table.events[0]?.fairness ?? '', /Communications neg 2 pos 0/);
  assert.match(table.events[0]?.cause ?? '', /silent for 12 min/);
  assert.match(table.events[1]?.edits ?? '', /Waiting on a statement\. → Can you confirm the headcount\?/);
  assert.equal(table.events[1]?.approver, 'Aisha');
  assert.equal(table.withheld.length, 1);
  assert.equal(table.withheld[0]?.decision, 'Vetoed');
  assert.equal(table.withheld[0]?.outcome, 'too soon');

  const summary = fairnessSummary(
    [
      { name: 'Legal', size: 2, staffed: true, playable: true, active: true },
      { name: 'Communications', size: 2, staffed: true, playable: true, active: true },
      { name: 'Operations', size: 2, staffed: true, playable: true, active: true },
    ],
    [
      { minute: 27, team: 'Communications', kind: 'consequence', severity: 'medium' },
      { minute: 30, team: 'Legal', kind: 'relief', severity: 'low' },
    ],
    { tolerance: 2, minute: 60, duration: 60 },
  );
  const byTeam = Object.fromEntries(summary.map((row) => [row.team, row]));
  assert.equal(byTeam.Communications?.negative_load, 2);
  assert.equal(byTeam.Communications?.unscripted_events, 1);
  assert.equal(byTeam.Legal?.positive_load, 1);
  assert.equal(byTeam.Legal?.unscripted_events, 1);
  assert.equal(byTeam.Operations?.negative_load, 0);
  assert.equal(byTeam.Operations?.unscripted_events, 0);

  const input = replayTurn();
  const draft = await runDirectorTurn(input, quietClient());
  const row: ReplayRow = {
    seq: 1,
    minute: draft.minute,
    wake_reason: draft.wake_reason,
    status: draft.status,
    reason: draft.reason,
    signals: draft.signals,
    observation: draft.observation,
    focus_id: draft.focus_id,
    guardrails: draft.guardrails,
    fairness: draft.fairness,
    raw_output: draft.raw_output,
    consistency: draft.consistency,
  };
  const clean = replayDirectorSession([row], { wakes: { 1: input } });
  assert.deepEqual(replayStatusOf(clean), { available: true, ok: true, mismatches: 0 });
  const drifted = replayDirectorSession(
    [{ ...row, observation: row.observation ? { ...row.observation, brief: `${row.observation.brief}!` } : null }],
    { wakes: { 1: input } },
  );
  const status = replayStatusOf(drifted);
  assert.equal(status.available, true);
  assert.equal(status.ok, false);
  assert.equal(status.mismatches, 1);
  assert.deepEqual(replayStatusOf({ unavailable: true }), {
    available: false,
    ok: false,
    mismatches: 0,
  });
});

test('the promote route returns the handler result', async () => {
  const app = express();
  app.use(express.json());
  let seen = '';
  app.use(
    '/api/sessions',
    createDirectorRouter({
      auth: ((req, _res, next) => {
        (req as AuthenticatedRequest).user = { id: 'owner', role: 'trainer' };
        next();
      }) as RequestHandler,
      async access() {
        return { ok: true };
      },
      commands: {
        get: async () => ({ ok: true, status: 200, body: {} }),
        patch: async () => ({ ok: true, status: 200, body: {} }),
        approve: async () => ({ ok: true, status: 200, body: {} }),
        veto: async () => ({ ok: true, status: 200, body: {} }),
        hold: async () => ({ ok: true, status: 200, body: {} }),
        request: async () => ({ ok: true, status: 200, body: {} }),
        snooze: async () => ({ ok: true, status: 200, body: {} }),
        sweep: async () => undefined,
      },
      async replay() {
        return { ok: true, mismatches: [] };
      },
      async promote(_sessionId, proposalId) {
        seen = proposalId;
        return { ok: true, status: 201, body: { data: { inject_id: 'new-inject' } } };
      },
    }),
  );
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const proposalId = '33333333-3333-4333-8333-333333333333';
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/sessions/11111111-1111-4111-8111-111111111111/director/proposals/${proposalId}/promote`,
    { method: 'POST' },
  );
  const json = (await response.json()) as { data?: { inject_id?: string } };
  server.close();
  assert.equal(response.status, 201);
  assert.equal(json.data?.inject_id, 'new-inject');
  assert.equal(seen, proposalId);
});

function quietClient(): DirectorClient {
  return {
    async propose() {
      return { parsed: { act: false, reason: 'nothing to add', proposal: null }, model: 'fake' };
    },
    async consistency() {
      return { parsed: { verdict: 'consistent', reason: 'holds' }, model: 'fake' };
    },
  };
}

function replayTurn(): DirectorTurnInput {
  const team = { name: 'Legal', size: 2, staffed: true, playable: true, active: true };
  return {
    clock: {
      minute: 20,
      duration: 60,
      paused: false,
      mode: 'auto',
      lastWakeMinute: null,
      startMinute: 5,
      tickMinutes: 10,
      minGapMinutes: 4,
    },
    signalState: {
      minute: 20,
      comms: {
        team_activity: { legal: { last_minute: 2 } },
        team_activity_known: true,
        team_labels: { legal: 'Legal' },
      },
      silence_minutes: 10,
    },
    previousWake: null,
    teams: [team],
    loadEvents: [],
    deliveries: [{ team: 'Legal', minute: 19, timed: false }],
    pendingByTeam: {},
    observation: {
      title: 'Harbour spill',
      crisisType: 'contamination',
      minute: 20,
      duration: 60,
      brief: 'A spill closed Bay 3.',
      facts: ['Bay 3 is closed'],
      falseClaims: [],
      teams: [team],
      dependencies: [],
      recentByTeam: [],
      moods: [],
      upcoming: [],
      recentUnscripted: [],
      exposure: [],
      signals: [],
      cast: [{ id: 'stk_maria', name: 'Maria Tan' }],
      npcs: [{ handle: 'harbour_desk' }],
      protectedTeams: [],
      busyTeams: [],
    },
    guard: {
      intensity: 'medium',
      per15: 2,
      perTeam30: 1,
      maxSeverity: 'high',
      pressureMax: 6,
      teams: [team],
      protectedTeams: [],
      allowedApps: ['email', 'group_chat', 'phone_call', 'npc_dm', 'messenger_dm', 'social_feed', 'news'],
      roleIds: [],
      stakeholders: [{ id: 'stk_maria', name: 'Maria Tan' }],
      npcs: [{ handle: 'harbour_desk' }],
      orgs: ['Harbour Authority'],
      brief: 'A spill closed Bay 3.',
      facts: ['Bay 3 is closed'],
      recentTexts: [],
      upcoming: [],
      capEvents: [],
      deliveries: [{ team: 'Legal', minute: 19, timed: false }],
      unansweredByTeam: {},
      priorLowMediumTeams: [],
      authoredKeysByTeam: {},
    },
    limits: {
      temperature: 0.4,
      per15: 2,
      perTeam30: 1,
      maxSeverity: 'high',
      tolerance: 2,
      consistencyEnabled: true,
      pressureMax: 6,
      intensity: 'medium',
      budget: 20,
    },
    seed: 7n,
    wakeSeq: 1,
    budgetKey: 'director:test',
    lastQuiet: null,
  };
}
