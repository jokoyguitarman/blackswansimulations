import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { causeDepth } from '../conditions/crossTeamCore.js';
import {
  buildDirectorPrompt,
  buildObservation,
  capsFor,
  checkProposal,
  chooseFocus,
  DIRECTOR_SYSTEM_PROMPT,
  directorSeed,
  fairnessState,
  formatFairnessLine,
  runDirectorTurn,
  shouldWake,
  teamInLull,
  type DirectorClient,
  type DirectorDraft,
  type DirectorLimits,
  type DirectorTeam,
  type DirectorTurnInput,
  type ExposureEvent,
  type FairnessState,
  type GuardContext,
  type ObservationInput,
  type ParsedProposal,
  type WakeClock,
} from './directorCore.js';
import { collectSignals, type Signal } from './directorSignals.js';
import { replayDirectorSession, type ReplayRow } from './directorReplay.js';
import {
  resetDirectorProcessState,
  runDirector,
  type DirectorStore,
  type DirectorTickInput,
} from './directorService.js';

const dir = dirname(fileURLToPath(import.meta.url));

function clock(overrides: Partial<WakeClock> = {}): WakeClock {
  return {
    minute: 20,
    duration: 60,
    paused: false,
    mode: 'auto',
    lastWakeMinute: null,
    startMinute: 5,
    tickMinutes: 10,
    minGapMinutes: 4,
    ...overrides,
  };
}

function signal(partial: Partial<Signal> & Pick<Signal, 'id' | 'kind' | 'team'>): Signal {
  return {
    minute: 18,
    detail: partial.kind,
    depth: 1,
    keys: [],
    notable: true,
    ...partial,
  };
}

function proposal(overrides: Partial<ParsedProposal> = {}): ParsedProposal {
  return {
    kind: 'consequence',
    cause: { signal_ids: ['team_silent:legal'], source_teams: ['Legal'] },
    target_teams: ['Legal'],
    target_role_id: null,
    app: 'email',
    sender: { stakeholder_id: 'stk_maria' },
    title: 'Holding update',
    content: 'Please send the holding statement today.',
    severity: 'low',
    requires_response: false,
    response_rubric: null,
    follow_up: null,
    ...overrides,
  };
}

function teamsOf(...names: string[]): DirectorTeam[] {
  return names.map((name) => ({ name, staffed: true, playable: true, active: true, size: 4 }));
}

function fairnessFor(
  names: string[],
  history: ExposureEvent[] = [],
  minute = 20,
  duration = 60,
): FairnessState {
  return fairnessState(teamsOf(...names), history, { tolerance: 2, minute, duration });
}

function ctx(overrides: Partial<GuardContext> = {}): GuardContext {
  const names = overrides.teams?.map((team) => team.name) ?? ['Legal'];
  return {
    minute: 20,
    duration: 60,
    mode: 'auto',
    intensity: 'medium',
    per15: 2,
    perTeam30: 1,
    maxSeverity: 'high',
    pressureMax: 6,
    teams: teamsOf(...names),
    protectedTeams: [],
    allowedApps: [
      'email',
      'group_chat',
      'phone_call',
      'npc_dm',
      'messenger_dm',
      'social_feed',
      'news',
    ],
    roleIds: ['legal_head'],
    stakeholders: [{ id: 'stk_maria', name: 'Maria Tan' }],
    npcs: [{ handle: 'harbour_desk', name: 'Harbour Desk' }],
    orgs: ['Harbour Authority'],
    brief: 'A spill closed Bay 3.',
    facts: ['Bay 3 is closed', 'The spill started this morning'],
    recentTexts: [],
    upcoming: [],
    capEvents: [],
    deliveries: [],
    unansweredByTeam: {},
    priorLowMediumTeams: [],
    authoredKeysByTeam: {},
    signals: [signal({ id: 'team_silent:legal', kind: 'team_silent', team: 'Legal' })],
    fairness: fairnessFor(names),
    consistencyEnabled: true,
    consistency: null,
    ...overrides,
  };
}

function observationInput(overrides: Partial<ObservationInput> = {}): ObservationInput {
  return {
    title: 'Harbour spill',
    crisisType: 'contamination',
    minute: 20,
    duration: 60,
    brief: 'A spill closed Bay 3.',
    facts: ['Bay 3 is closed'],
    falseClaims: [],
    teams: teamsOf('Legal'),
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
    ...overrides,
  };
}

const limits: DirectorLimits = {
  temperature: 0.4,
  per15: 2,
  perTeam30: 1,
  maxSeverity: 'high',
  tolerance: 2,
  consistencyEnabled: true,
  pressureMax: 6,
  intensity: 'medium',
  budget: 20,
};

function wakingTurn(overrides: Partial<DirectorTurnInput> = {}): DirectorTurnInput {
  return {
    clock: clock(),
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
    teams: teamsOf('Legal'),
    loadEvents: [],
    deliveries: [{ team: 'Legal', minute: 19, timed: false }],
    pendingByTeam: {},
    observation: observationInput(),
    guard: {
      intensity: 'medium',
      per15: 2,
      perTeam30: 1,
      maxSeverity: 'high',
      pressureMax: 6,
      teams: teamsOf('Legal'),
      protectedTeams: [],
      allowedApps: [
        'email',
        'group_chat',
        'phone_call',
        'npc_dm',
        'messenger_dm',
        'social_feed',
        'news',
      ],
      roleIds: ['legal_head'],
      stakeholders: [{ id: 'stk_maria', name: 'Maria Tan' }],
      npcs: [{ handle: 'harbour_desk' }],
      orgs: ['Harbour Authority'],
      brief: 'A spill closed Bay 3.',
      facts: ['Bay 3 is closed', 'The spill started this morning'],
      recentTexts: [],
      upcoming: [],
      capEvents: [],
      deliveries: [{ team: 'Legal', minute: 19, timed: false }],
      unansweredByTeam: {},
      priorLowMediumTeams: [],
      authoredKeysByTeam: {},
    },
    limits,
    seed: 7n,
    wakeSeq: 1,
    budgetKey: 'director:test',
    lastQuiet: null,
    ...overrides,
  };
}

function countingClient(
  parsed: unknown,
  consistency: { verdict?: string; reason?: string; failed?: boolean; budgetDenied?: boolean } = {
    verdict: 'consistent',
    reason: 'holds',
  },
): DirectorClient & { proposes: number; checks: number } {
  const client = {
    proposes: 0,
    checks: 0,
    async propose() {
      client.proposes += 1;
      return {
        parsed,
        model: 'fake-director',
        providerSeedApplied: true,
        tokensIn: 10,
        tokensOut: 4,
      };
    },
    async consistency() {
      client.checks += 1;
      if (consistency.failed || consistency.budgetDenied) return consistency;
      return { parsed: consistency, model: 'fake-fast' };
    },
  };
  return client;
}

function rowFrom(draft: DirectorDraft, seq: number): ReplayRow {
  return {
    seq,
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
}

test('shouldWake stays quiet before the start, near the end, while paused, and when off', () => {
  const notable = [signal({ id: 'silence', kind: 'team_silent', team: 'Legal' })];
  assert.equal(
    shouldWake(clock({ minute: 4 }), notable, { lull: false, fairnessImbalance: false }).reason,
    'before_start',
  );
  assert.equal(
    shouldWake(clock({ minute: 55 }), notable, { lull: false, fairnessImbalance: false }).reason,
    'ending',
  );
  assert.equal(
    shouldWake(clock({ paused: true }), notable, { lull: true, fairnessImbalance: true }).reason,
    'paused',
  );
  assert.equal(
    shouldWake(clock({ mode: 'off' }), notable, { lull: true, fairnessImbalance: true }).wake,
    false,
  );

  const tooSoon = shouldWake(clock({ minute: 12, lastWakeMinute: 10 }), notable, {
    lull: false,
    fairnessImbalance: false,
  });
  assert.equal(tooSoon.wake, false);
  assert.equal(tooSoon.reason, 'gap');
  const ready = shouldWake(clock({ minute: 14, lastWakeMinute: 10 }), notable, {
    lull: false,
    fairnessImbalance: false,
  });
  assert.equal(ready.wake, true);
  assert.equal(ready.reason, 'signals');

  const quiet = shouldWake(clock({ minute: 20, lastWakeMinute: 10 }), [], {
    lull: false,
    fairnessImbalance: false,
  });
  assert.equal(quiet.wake, false);
  assert.equal(quiet.reason, 'no_lull');
  const lull = shouldWake(clock({ minute: 20, lastWakeMinute: 10 }), [], {
    lull: true,
    fairnessImbalance: false,
  });
  assert.equal(lull.wake, true);
  assert.equal(lull.reason, 'periodic');
  assert.equal(
    teamInLull({
      teams: teamsOf('Legal'),
      deliveries: [{ team: 'Legal', minute: 19 }],
      pendingByTeam: {},
      minute: 20,
    }),
    false,
  );
  assert.equal(
    teamInLull({
      teams: teamsOf('Legal'),
      deliveries: [{ team: 'Legal', minute: 8 }],
      pendingByTeam: { legal: 0 },
      minute: 20,
    }),
    true,
  );
});

test('collectSignals skips a planned decision and keeps a broken dependency depth', () => {
  const triggers = {
    dir_1: {
      cause_depth: 2,
      origin: 'director',
      source_teams: ['Communications'],
      target_teams: ['Legal'],
    },
  };
  const signals = collectSignals(
    {
      minute: 20,
      dependency_state: {
        dep_legal: {
          status: 'broken',
          broken_minute: 18,
          upstream: 'Legal',
          downstream: ['Communications'],
          deliverable: 'Approval of the holding statement',
          evidence: [{ key: 'reply_failed:dir_1|team=legal' }],
        },
      },
      triggers_by_key: triggers,
      active_plans: [{ team_slug: 'legal', category: 'public_position' }],
      comms: {
        decisions: [
          { team_slug: 'legal', category: 'public_position', minute: 12 },
          { team_slug: 'comms', category: 'operations', minute: 14 },
        ],
        decisions_enabled: true,
        decisions_known: true,
        team_labels: { legal: 'Legal', comms: 'Communications', ops: 'Operations' },
        duties: { ops: [{ action_id: 'headcount', benchmark_minute: 10, completed_minute: null }] },
        duties_known: true,
        team_activity: { legal: { last_minute: 4 } },
        team_activity_known: true,
        content_grades: { comms: [40, 80] },
        content_grades_known: true,
      },
      silence_minutes: 10,
    },
    null,
  );
  const dependency = signals.find((row) => row.kind === 'dependency_broken');
  assert.ok(dependency);
  assert.equal(dependency.depth, causeDepth(['reply_failed:dir_1|team=legal'], triggers));
  assert.ok(dependency.depth > 1);
  assert.equal(
    signals.some((row) => row.kind === 'decision' && row.id.includes('legal')),
    false,
  );
  assert.equal(
    signals.some((row) => row.kind === 'decision' && row.id.includes('comms')),
    true,
  );
  assert.equal(
    signals.some((row) => row.kind === 'duty_missed'),
    true,
  );
  assert.equal(
    signals.some((row) => row.kind === 'team_silent'),
    true,
  );
  assert.equal(
    signals.some((row) => row.kind === 'content_failed'),
    true,
  );
  assert.equal(
    collectSignals({ minute: 20, comms: { decisions: [] } }, null).some(
      (row) => row.kind === 'dependency_broken',
    ),
    false,
  );
});

test('buildObservation stays within 6000 characters and keeps upcoming authored injects', () => {
  const teams = Array.from({ length: 40 }, (_, index) => ({
    name: `Response Team ${index + 1}`,
    org: 'Harbour Authority',
    functionName: 'Field coordination and public information',
    members: ['Alex Morgan', 'Blair Chen', 'Casey Singh'],
    staffed: true,
    playable: true,
    size: 3,
  }));
  const observation = buildObservation(
    observationInput({
      teams,
      facts: Array.from(
        { length: 8 },
        (_, index) => `Confirmed fact number ${index + 1} about the closure`,
      ),
      upcoming: [
        {
          key: 'authored_bay_update',
          title: 'Bay update',
          content: 'A short note',
          minute: 25,
          target_teams: ['Response Team 1'],
        },
      ],
    }),
    'teams below their share: none; teams at their cap: none',
  );
  assert.ok(observation.text.length <= 6000);
  assert.match(observation.text, /UPCOMING AUTHORED INJECTS/);
  assert.match(observation.text, /authored_bay_update/);
});

test('each guardrail has a passing and a failing fixture', () => {
  const base = ctx();
  assert.equal(checkProposal(proposal(), base).ok, true);
  assert.equal(
    checkProposal({ ...proposal(), kind: 'nope' } as unknown, base).failure?.id,
    'invalid',
  );
  assert.equal(
    checkProposal({ ...proposal(), app: 'group_chat', content: 'a'.repeat(281) }, base).failure?.id,
    'invalid',
  );

  assert.equal(
    checkProposal(
      proposal(),
      ctx({
        capEvents: [
          { minute: 18, team: 'Communications', kind: 'consequence', severity: 'low' },
          { minute: 19, team: 'Communications', kind: 'consequence', severity: 'low' },
        ],
        perTeam30: 5,
      }),
    ).failure?.id,
    'cap',
  );
  assert.equal(
    checkProposal(
      proposal(),
      ctx({
        capEvents: [{ minute: 10, team: 'Legal', kind: 'consequence', severity: 'low' }],
        per15: 5,
      }),
    ).failure?.id,
    'cap',
  );
  assert.equal(
    checkProposal(proposal({ severity: 'high' }), ctx({ maxSeverity: 'medium' })).failure?.id,
    'cap',
  );

  assert.equal(checkProposal(proposal({ target_teams: ['Ghost'] }), base).failure?.id, 'target');
  assert.equal(checkProposal(proposal(), ctx({ protectedTeams: ['Legal'] })).failure?.id, 'target');
  assert.equal(
    checkProposal(proposal({ target_role_id: 'missing_role' }), base).failure?.id,
    'target',
  );

  assert.equal(
    checkProposal(
      proposal(),
      ctx({
        deliveries: [15, 16, 17, 18, 19, 20].map((minute) => ({
          team: 'Legal',
          minute,
          timed: false,
        })),
      }),
    ).failure?.id,
    'pile_on',
  );
  assert.equal(
    checkProposal(proposal(), ctx({ unansweredByTeam: { legal: 3 } })).failure?.id,
    'pile_on',
  );

  assert.equal(
    checkProposal(proposal({ sender: { stakeholder_id: 'nobody' } }), base).failure?.id,
    'sender',
  );
  assert.equal(
    checkProposal(proposal({ app: 'npc_dm', sender: { npc_handle: 'harbour_desk' } }), base).failure
      ?.id,
    'sender',
  );
  assert.equal(
    checkProposal(proposal(), ctx({ allowedApps: ['group_chat'] })).failure?.id,
    'sender',
  );

  assert.equal(
    checkProposal(proposal({ content: 'This is a simulation of the closure.' }), base).failure?.id,
    'meta',
  );
  assert.equal(
    checkProposal(proposal({ app: 'social_feed', content: 'Legal has not replied yet.' }), base)
      .failure?.id,
    'team_named_publicly',
  );

  assert.equal(
    checkProposal(proposal({ content: 'John Smith asked for a comment.' }), base).failure?.id,
    'entity',
  );
  assert.equal(
    checkProposal(proposal({ content: 'Maria Tan asked for a comment.' }), base).ok,
    true,
  );
  assert.equal(
    checkProposal(proposal({ content: 'The figure is 14 today.' }), base).failure?.id,
    'number',
  );
  assert.equal(
    checkProposal(
      proposal(),
      ctx({
        upcoming: [
          {
            key: 'same',
            title: 'Holding update',
            content: 'Please send the holding statement today.',
            minute: 22,
            target_teams: ['Legal'],
          },
        ],
      }),
    ).failure?.id,
    'duplicate',
  );

  const heavy = fairnessFor(
    ['Operations', 'Communications', 'Legal'],
    [
      { minute: 10, team: 'Operations', kind: 'consequence', severity: 'high' },
      { minute: 12, team: 'Operations', kind: 'consequence', severity: 'high' },
      { minute: 8, team: 'Communications', kind: 'consequence', severity: 'low' },
      { minute: 9, team: 'Legal', kind: 'consequence', severity: 'low' },
    ],
  );
  const three = ctx({
    teams: teamsOf('Operations', 'Communications', 'Legal'),
    fairness: heavy,
    signals: [signal({ id: 'duty', kind: 'duty_missed', team: 'Operations' })],
  });
  assert.equal(
    checkProposal(
      proposal({
        target_teams: ['Operations'],
        cause: { signal_ids: ['duty'], source_teams: ['Operations'] },
      }),
      three,
    ).failure?.id,
    'fairness',
  );
  assert.equal(
    checkProposal(
      proposal({
        kind: 'relief',
        target_teams: ['Operations'],
        cause: { signal_ids: ['duty'], source_teams: ['Operations'] },
      }),
      three,
    ).results.find((row) => row.id === 'fairness')?.ok,
    true,
  );

  assert.equal(checkProposal(proposal({ severity: 'high' }), base).failure?.id, 'severity_step');
  assert.equal(
    checkProposal(proposal({ severity: 'high' }), ctx({ priorLowMediumTeams: ['Legal'] })).ok,
    true,
  );
});

test('auto rejects every failure and an unverified consistency check, suggest keeps later checks as warnings', async () => {
  const failures = [
    checkProposal({ ...proposal(), title: '' }, ctx()),
    checkProposal(proposal({ content: 'This is a simulation of the closure.' }), ctx()),
    checkProposal(proposal({ content: 'John Smith asked for a comment.' }), ctx()),
    checkProposal(proposal({ content: 'The figure is 14 today.' }), ctx()),
    checkProposal(
      proposal(),
      ctx({
        upcoming: [
          {
            key: 'same',
            title: 'Holding update',
            content: 'Please send the holding statement today.',
            minute: 22,
            target_teams: ['Legal'],
          },
        ],
      }),
    ),
    checkProposal(
      proposal(),
      ctx({ consistency: { status: 'conflict', reason: 'The date disagrees.' } }),
    ),
    checkProposal(
      proposal(),
      ctx({ consistency: { status: 'unverified', reason: 'budget_denied' } }),
    ),
  ];
  for (const report of failures) assert.equal(report.rejected, true);

  const suggest = ctx({ mode: 'suggest' });
  for (const raw of [
    proposal({ content: 'John Smith asked for a comment.' }),
    proposal({ content: 'The figure is 14 today.' }),
  ]) {
    const report = checkProposal(raw, suggest);
    assert.equal(report.rejected, false);
    assert.ok(report.warnings.length > 0);
  }
  const warned = checkProposal(proposal(), {
    ...suggest,
    consistency: { status: 'conflict', reason: 'dates' },
  });
  assert.equal(warned.rejected, false);
  assert.equal(
    warned.warnings.some((row) => row.id === 'conflict'),
    true,
  );
  assert.equal(
    checkProposal(proposal({ content: 'This is a simulation of the closure.' }), suggest).rejected,
    true,
  );

  const unverified = countingClient(
    { act: true, reason: 'Legal went quiet', proposal: proposal() },
    { failed: true },
  );
  const denied = countingClient(
    { act: true, reason: 'Legal went quiet', proposal: proposal() },
    { budgetDenied: true },
  );
  const failedDraft = await runDirectorTurn(wakingTurn(), unverified);
  const deniedDraft = await runDirectorTurn(wakingTurn(), denied);
  assert.equal(failedDraft.status, 'rejected_guardrail');
  assert.equal(
    failedDraft.guardrails.some((row) => row.id === 'unverified'),
    true,
  );
  assert.equal(failedDraft.inject_id, null);
  assert.equal(deniedDraft.status, 'rejected_guardrail');
  assert.equal(
    deniedDraft.guardrails.some((row) => row.id === 'unverified' && row.detail === 'budget_denied'),
    true,
  );
  assert.equal(deniedDraft.inject_id, null);

  const suggestClient = countingClient(
    {
      act: true,
      reason: 'show the trainer',
      proposal: proposal({ content: 'John Smith asked for a comment.' }),
    },
    { verdict: 'conflict', reason: 'unknown person' },
  );
  const shown = await runDirectorTurn(
    wakingTurn({
      clock: clock({ mode: 'suggest' }),
      limits: { ...limits, consistencyEnabled: true },
    }),
    suggestClient,
  );
  assert.equal(shown.status, 'proposed');
  assert.equal(
    shown.guardrails.some((row) => row.warning && row.id === 'entity'),
    true,
  );
  assert.equal(
    shown.guardrails.some((row) => row.warning && row.id === 'conflict'),
    true,
  );
});

test('fairness balances load, size, relief and the last third', () => {
  const history: ExposureEvent[] = [
    { minute: 10, team: 'Operations', kind: 'consequence', severity: 'high' },
    { minute: 12, team: 'Operations', kind: 'consequence', severity: 'high' },
    { minute: 8, team: 'Communications', kind: 'consequence', severity: 'low' },
    { minute: 9, team: 'Legal', kind: 'consequence', severity: 'low' },
  ];
  const state = fairnessState(teamsOf('Operations', 'Communications', 'Legal'), history, {
    tolerance: 2,
    minute: 20,
    duration: 60,
  });
  const operations = state.teams.find((team) => team.team === 'Operations');
  assert.equal(operations?.negative_load, 6);
  assert.equal(state.teams.find((team) => team.team === 'Communications')?.negative_load, 1);
  assert.equal(operations?.over_cap, true);

  const scaled = fairnessState(
    [
      { name: 'Small', size: 2, staffed: true, playable: true, active: true },
      { name: 'Large', size: 8, staffed: true, playable: true, active: true },
    ],
    ['Small', 'Large'].flatMap((team) => [
      { minute: 1, team, kind: 'consequence' as const, severity: 'high' as const },
      { minute: 2, team, kind: 'consequence' as const, severity: 'low' as const },
    ]),
    { tolerance: 2, minute: 10, duration: 60 },
  );
  assert.equal(scaled.teams.find((team) => team.team === 'Small')?.size_scale, 0.75);
  assert.equal(scaled.teams.find((team) => team.team === 'Large')?.size_scale, 1.25);
  assert.equal(scaled.teams.find((team) => team.team === 'Small')?.fair_share, 3);
  assert.equal(scaled.teams.find((team) => team.team === 'Large')?.fair_share, 5);

  const owed = fairnessState(
    teamsOf('Operations'),
    [{ minute: 5, team: 'Operations', kind: 'consequence', severity: 'high' }],
    { tolerance: 2, minute: 20, duration: 60 },
  );
  assert.equal(owed.teams[0]?.relief_owed, true);
  assert.equal(
    chooseFocus(
      [
        signal({ id: 'duty', kind: 'duty_missed', team: 'Operations' }),
        signal({ id: 'thanks', kind: 'relief', team: 'Operations' }),
      ],
      owed,
      1n,
      1,
      20,
    ),
    'thanks',
  );

  const late = fairnessState(teamsOf('Operations', 'Communications', 'Legal'), history, {
    tolerance: 2,
    minute: 40,
    duration: 60,
  });
  assert.equal(late.last_third, true);
  assert.equal(late.teams.find((team) => team.team === 'Operations')?.over_cap, false);
  const relaxed = checkProposal(
    proposal({
      target_teams: ['Operations'],
      cause: { signal_ids: ['duty'], source_teams: ['Operations'] },
    }),
    ctx({ minute: 40, teams: teamsOf('Operations', 'Communications', 'Legal'), fairness: late }),
  );
  assert.equal(relaxed.results.find((row) => row.id === 'fairness')?.ok, true);
  assert.deepEqual(capsFor('low', { per15: 2, perTeam30: 1 }), { per15: 1, perTeam30: 1 });
  assert.deepEqual(capsFor('high', { per15: 2, perTeam30: 1 }), { per15: 3, perTeam30: 2 });
});

test('the same seed and wake produce the same decisions, and the director does not call Math.random', () => {
  assert.equal(
    directorSeed('session-a', 'scenario-a', 'salt'),
    directorSeed('session-a', 'scenario-a', 'salt'),
  );
  assert.notEqual(
    directorSeed('session-a', 'scenario-a', 'salt'),
    directorSeed('session-b', 'scenario-a', 'salt'),
  );
  const fairness = fairnessFor(['Legal', 'Communications']);
  const tied = [
    signal({ id: 'duty-a', kind: 'duty_missed', team: 'Legal', minute: 12 }),
    signal({ id: 'duty-b', kind: 'duty_missed', team: 'Communications', minute: 12 }),
  ];
  const observation = observationInput({ teams: teamsOf('Legal', 'Communications') });
  const guard = ctx({ teams: teamsOf('Legal', 'Communications'), fairness });
  const once = () => ({
    focus: chooseFocus(tied, fairness, 99n, 4, 20),
    text: buildObservation(observation, formatFairnessLine(fairness)).text,
    guards: checkProposal(proposal(), guard).results.map((row) => ({
      id: row.id,
      ok: row.ok,
      warning: row.warning ?? false,
    })),
  });
  const first = once();
  for (let run = 0; run < 100; run += 1) assert.deepEqual(once(), first);

  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
    const source = readFileSync(join(dir, name), 'utf8');
    assert.equal(source.includes('Math.random'), false, name);
  }
});

test('replay matches a stored wake and reports one mismatch when an observation field changes', async () => {
  const input = wakingTurn();
  const client = countingClient({ act: false, reason: 'wait', proposal: null });
  const draft = await runDirectorTurn(input, client);
  const row = rowFrom(draft, 1);
  const clean = replayDirectorSession([row], { wakes: { 1: input } });
  assert.equal(clean.ok, true, JSON.stringify(clean.mismatches));
  assert.ok(row.observation);
  const mutated: ReplayRow = {
    ...row,
    observation: { ...row.observation, brief: `${row.observation.brief}!` },
  };
  const drifted = replayDirectorSession([mutated], { wakes: { 1: input } });
  assert.equal(drifted.mismatches.length, 1);
  assert.equal(drifted.mismatches[0]?.seq, 1);
  assert.equal(drifted.mismatches[0]?.field, 'observation.brief');
});

test('a declined model, a denied budget and a quiet tick are stored without an inject', async () => {
  const quietClient = countingClient({ act: false, reason: 'nothing to add', proposal: null });
  const quiet = await runDirectorTurn(wakingTurn(), quietClient);
  assert.equal(quiet.status, 'no_action');
  assert.equal(quiet.proposal, null);
  assert.equal(quiet.inject_id, null);
  assert.equal(quietClient.proposes, 1);
  assert.equal(quietClient.checks, 0);

  const budget: DirectorClient = {
    async propose() {
      return { budgetDenied: true };
    },
    async consistency() {
      throw new Error('consistency should not run');
    },
  };
  const denied = await runDirectorTurn(wakingTurn(), budget);
  assert.equal(denied.status, 'budget_denied');
  assert.equal(denied.inject_id, null);

  let calls = 0;
  const idle: DirectorClient = {
    async propose() {
      calls += 1;
      return { parsed: null, failed: true };
    },
    async consistency() {
      return { parsed: null };
    },
  };
  const noLull = await runDirectorTurn(
    wakingTurn({
      clock: clock({ minute: 20, lastWakeMinute: 0 }),
      signalState: {
        minute: 20,
        comms: {
          team_activity: { legal: { last_minute: 19 } },
          team_activity_known: true,
          team_labels: { legal: 'Legal' },
        },
      },
      deliveries: [{ team: 'Legal', minute: 19, timed: false }],
    }),
    idle,
  );
  assert.equal(noLull.status, 'no_action');
  assert.equal(noLull.reason, 'no_lull');
  assert.equal(calls, 0);

  const off = await runDirectorTurn(wakingTurn({ clock: clock({ mode: 'off' }) }), idle);
  assert.equal(off.log, false);
  assert.equal(calls, 0);
});

test('the prompt keeps the trainer, scores and the word simulation out of the world text', () => {
  const input = {
    ...observationInput({ brief: 'Bay 3 is closed and the morning shift is on site.' }),
    trainerName: 'Ada Lovelace',
    teamScores: 'Ops 99',
  } as ObservationInput;
  const fairness = fairnessFor(['Legal']);
  const prompt = buildDirectorPrompt(buildObservation(input, formatFairnessLine(fairness)));
  assert.equal(prompt.system, DIRECTOR_SYSTEM_PROMPT);
  assert.equal(prompt.user.includes('Ada Lovelace'), false);
  assert.equal(prompt.user.includes('Ops 99'), false);
  assert.doesNotMatch(prompt.user, /\bscores?\b/i);
  assert.doesNotMatch(prompt.user, /\bsimulation\b/i);
  const rulesAt = prompt.system.indexOf('\nRules:\n');
  assert.ok(rulesAt > 0);
  assert.doesNotMatch(prompt.system.slice(0, rulesAt), /\bsimulation\b/i);
  assert.match(prompt.system.slice(rulesAt), /\bsimulation\b/);
});

test('a broken dependency on the tick becomes a director signal', () => {
  const signals = collectSignals(
    {
      minute: 23,
      dependency_state: {
        dep_ops_headcount_comms: {
          status: 'broken',
          broken_minute: 18,
          met_minute: null,
          recovered_minute: null,
          upstream: 'Operations',
          downstream: ['Communications'],
          deliverable: 'Confirmed headcount for Bay 3',
        },
      },
    },
    null,
  );
  const broken = signals.find((row) => row.kind === 'dependency_broken');
  assert.ok(broken);
  assert.equal(broken.team, 'Operations');
  assert.match(broken.detail, /Confirmed headcount for Bay 3/);
  assert.equal(broken.id, 'dependency_broken:dep_ops_headcount_comms');
});

test('repeating signals keep a stable id until a later onset', () => {
  const firstSilence = collectSignals(
    {
      minute: 12,
      silence_minutes: 10,
      comms: { team_activity: { legal: { last_minute: null } }, team_activity_known: true },
    },
    null,
  ).find((row) => row.kind === 'team_silent');
  const laterSilence = collectSignals(
    {
      minute: 30,
      silence_minutes: 10,
      comms: { team_activity: { legal: { last_minute: 20 } }, team_activity_known: true },
    },
    { minute: 12, signal_ids: [firstSilence?.id ?? ''] },
  ).find((row) => row.kind === 'team_silent');
  assert.equal(firstSilence?.id, 'team_silent:legal:10');
  assert.equal(laterSilence?.id, 'team_silent:legal:30');

  const firstGrade = collectSignals(
    { minute: 10, comms: { content_grades: { legal: [10] }, content_grades_known: true } },
    null,
  );
  const sameGrade = collectSignals(
    { minute: 14, comms: { content_grades: { legal: [10] }, content_grades_known: true } },
    { minute: 10, signal_ids: firstGrade.map((row) => row.id) },
  );
  const extraGrade = collectSignals(
    { minute: 16, comms: { content_grades: { legal: [10, 20] }, content_grades_known: true } },
    { minute: 14, signal_ids: firstGrade.map((row) => row.id) },
  );
  assert.equal(
    sameGrade.some((row) => row.kind === 'content_failed'),
    false,
  );
  assert.equal(
    extraGrade.some((row) => row.kind === 'content_failed'),
    true,
  );

  const angry = collectSignals(
    {
      minute: 8,
      comms: {
        moods: [
          { stakeholder_id: 'stk_maria', scope_team: 'Legal', rung_id: 'angry', entered_minute: 8 },
        ],
      },
    },
    null,
  );
  const stillAngry = collectSignals(
    {
      minute: 12,
      comms: {
        moods: [
          { stakeholder_id: 'stk_maria', scope_team: 'Legal', rung_id: 'angry', entered_minute: 8 },
        ],
      },
    },
    { minute: 8, signal_ids: angry.map((row) => row.id) },
  );
  const angryAgain = collectSignals(
    {
      minute: 20,
      comms: {
        moods: [
          {
            stakeholder_id: 'stk_maria',
            scope_team: 'Legal',
            rung_id: 'angry',
            entered_minute: 19,
          },
        ],
      },
    },
    { minute: 12, signal_ids: angry.map((row) => row.id) },
  );
  assert.equal(
    stillAngry.some((row) => row.kind === 'mood'),
    false,
  );
  assert.equal(
    angryAgain.some((row) => row.kind === 'mood'),
    true,
  );
});

test('a gated director tick reads history only, and a disabled director reads nothing', async () => {
  resetDirectorProcessState();
  const queries: string[] = [];
  const boom = async (name: string) => {
    queries.push(name);
    throw new Error(name);
  };
  const store = {
    async loadHistory() {
      queries.push('history');
      return [];
    },
    loadSession: () => boom('session'),
    loadScenario: () => boom('scenario'),
    loadTriggers: () => boom('triggers'),
    loadDeliveries: () => boom('deliveries'),
    loadActivePlans: () => boom('plans'),
    loadTeams: () => boom('teams'),
    loadMemberships: () => boom('memberships'),
    loadUpcoming: () => boom('upcoming'),
    saveSeed: () => boom('seed'),
    insertProposal: () => boom('insert'),
    insertEvent: () => boom('event'),
  } as DirectorStore;

  const tick = (overrides: Partial<DirectorTickInput> = {}): DirectorTickInput => ({
    sessionId: '11111111-1111-1111-1111-111111111111',
    scenarioId: '22222222-2222-2222-2222-222222222222',
    trainerId: '33333333-3333-3333-3333-333333333333',
    status: 'in_progress',
    elapsedMinutes: 2,
    durationMinutes: 60,
    comms: null,
    ...overrides,
  });

  const on = { store, enabled: true, aiEnabled: true };
  await runDirector(tick({ directorMode: 'off' }), on);
  await runDirector(tick(), { store, enabled: true, aiEnabled: false });
  await runDirector(tick(), { store, enabled: false, aiEnabled: true });
  assert.equal(queries.join(','), '');

  await runDirector(tick(), on);
  assert.equal(queries.join(','), 'history');

  queries.length = 0;
  await runDirector(tick({ elapsedMinutes: 56 }), on);
  await runDirector(tick({ elapsedMinutes: 30, status: 'paused' }), on);
  assert.equal(queries.join(','), 'history,history');

  queries.length = 0;
  store.loadHistory = async () => {
    queries.push('history');
    return [
      {
        seq: 1,
        minute: 18,
        status: 'no_action',
        reason: 'signals',
        signals: [],
        teams: [],
        kind: null,
        severity: null,
        title: null,
      },
    ];
  };
  await runDirector(
    tick({
      elapsedMinutes: 20,
      comms: {
        team_activity: { legal: { last_minute: 2 } },
        team_activity_known: true,
        team_labels: { legal: 'Legal' },
      } as unknown as DirectorTickInput['comms'],
    }),
    on,
  );
  assert.equal(queries.join(','), 'history');

  queries.length = 0;
  store.loadHistory = async () => {
    queries.push('history');
    return [
      {
        seq: 1,
        minute: 16,
        status: 'no_action',
        reason: 'no_lull',
        signals: [],
        teams: [],
        kind: null,
        severity: null,
        title: null,
      },
    ];
  };
  await runDirector(
    tick({
      elapsedMinutes: 20,
      comms: {
        team_activity: { legal: { last_minute: 19 } },
        team_activity_known: true,
      } as unknown as DirectorTickInput['comms'],
    }),
    on,
  );
  assert.equal(queries.join(','), 'history');

  queries.length = 0;
  store.loadHistory = async () => {
    queries.push('history');
    return 'missing';
  };
  await runDirector(tick({ elapsedMinutes: 20 }), on);
  assert.equal(queries.join(','), 'history');
  queries.length = 0;
  await runDirector(tick({ elapsedMinutes: 21 }), on);
  assert.equal(queries.join(','), '');
  resetDirectorProcessState();
});
