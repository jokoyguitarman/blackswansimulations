import assert from 'node:assert/strict';
import test from 'node:test';
import { applyLiveMode } from './directorPublish.js';
import {
  DIRECTOR_SCENARIO_CACHE_MS,
  ensureDirectorSeed,
  invalidateDirectorSession,
  resetDirectorProcessState,
  runDirector,
  scheduleDirectorWake,
  type DirectorStore,
  type DirectorTickInput,
} from './directorService.js';
import type { DirectorDraft } from './directorCore.js';
import type { DirectorClient } from './directorCore.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const scenarioId = '22222222-2222-4222-8222-222222222222';

function tick(): DirectorTickInput {
  return {
    sessionId,
    scenarioId,
    trainerId: '33333333-3333-4333-8333-333333333333',
    status: 'in_progress',
    elapsedMinutes: 20,
    durationMinutes: 60,
    comms: {
      moods: [{ stakeholder_id: 'stk_maria', scope_team: 'Legal', rung_id: 'angry', entered_minute: 18 }],
    } as unknown as DirectorTickInput['comms'],
  };
}

function store(): DirectorStore {
  return {
    async loadHistory() {
      return [];
    },
    async loadSession() {
      return { director_mode: null, director_seed: '1' };
    },
    async loadScenario() {
      return {
        title: 'Harbour spill',
        category: 'social_media_crisis',
        description: 'A spill closed Bay 3.',
        briefing: '',
        duration: 60,
        initial: { stakeholders: [{ id: 'stk_maria', name: 'Maria Tan' }] },
      };
    },
    async loadTriggers() {
      return [];
    },
    async loadDeliveries() {
      return [];
    },
    async loadActivePlans() {
      return [];
    },
    async loadTeams() {
      return [{ name: 'Legal' }];
    },
    async loadMemberships() {
      return [{ user_id: '44444444-4444-4444-8444-444444444444', team_name: 'Legal' }];
    },
    async loadUpcoming() {
      return [];
    },
    async loadStakeholders() {
      return [{ id: 'stk_maria', name: 'Maria Tan', email: 'maria@straits.example' }];
    },
    async saveSeed() {
      return 'ok';
    },
    async insertProposal() {
      return 'ok';
    },
    async insertEvent() {},
  };
}

test('a slow director wake does not delay the tick or run twice', async () => {
  resetDirectorProcessState();
  let calls = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client: DirectorClient = {
    async propose() {
      calls += 1;
      await gate;
      return { parsed: { act: false, reason: 'quiet', proposal: null } };
    },
    async consistency() {
      return { parsed: { verdict: 'consistent', reason: 'ok' } };
    },
  };
  const options = { store: store(), client, enabled: true, aiEnabled: true };
  const started = Date.now();
  const first = scheduleDirectorWake(tick(), options);
  const elapsed = Date.now() - started;
  const second = scheduleDirectorWake(tick(), options);
  assert.equal(first, true);
  assert.equal(second, false);
  assert.ok(elapsed < 100, `tick waited ${elapsed}ms`);
  const deadline = Date.now() + 500;
  while (calls < 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(calls, 1);
  release();
  await new Promise((resolve) => setTimeout(resolve, 40));
});

function quietClient(calls: { n: number }): DirectorClient {
  return {
    async propose() {
      calls.n += 1;
      return { parsed: { act: false, reason: 'quiet', proposal: null } };
    },
    async consistency() {
      return { parsed: { verdict: 'consistent', reason: 'ok' } };
    },
  };
}

test('a failed history read skips the wake instead of calling the model', async () => {
  resetDirectorProcessState();
  const calls = { n: 0 };
  let readable = false;
  let scenarios = 0;
  const backing = store();
  backing.loadHistory = async () => (readable ? [] : null);
  const scenario = await store().loadScenario(scenarioId);
  backing.loadScenario = async () => {
    scenarios += 1;
    return scenario;
  };
  const options = { store: backing, client: quietClient(calls), enabled: true, aiEnabled: true };
  await runDirector(tick(), options);
  await runDirector(tick(), options);
  assert.equal(calls.n, 0);
  assert.equal(scenarios, 0);
  readable = true;
  await runDirector(tick(), options);
  assert.equal(calls.n, 1);
  assert.equal(scenarios, 1);
});

test('scenario text stays cached until it expires or a session starts', async () => {
  resetDirectorProcessState();
  let loads = 0;
  let now = 1_000;
  const backing = store();
  const scenario = await store().loadScenario(scenarioId);
  backing.loadScenario = async () => {
    loads += 1;
    return scenario && { ...scenario, title: `Brief ${loads}` };
  };
  const options = {
    store: backing,
    client: quietClient({ n: 0 }),
    enabled: true,
    aiEnabled: true,
    now: () => now,
  };
  await runDirector(tick(), options);
  await runDirector(tick(), options);
  assert.equal(loads, 1);
  now += DIRECTOR_SCENARIO_CACHE_MS;
  await runDirector(tick(), options);
  assert.equal(loads, 2);
  await ensureDirectorSeed(sessionId, scenarioId);
  await runDirector(tick(), options);
  assert.equal(loads, 3);
});

test('switching a cached off session to auto wakes on the next tick', async () => {
  resetDirectorProcessState();
  const calls = { n: 0 };
  let mode: string | null = 'off';
  let historyReads = 0;
  const backing = store();
  backing.loadHistory = async () => {
    historyReads += 1;
    return [];
  };
  backing.loadSession = async () => ({ director_mode: mode, director_seed: '1' });
  const options = { store: backing, client: quietClient(calls), enabled: true, aiEnabled: true };
  await runDirector(tick(), options);
  assert.equal(calls.n, 0);
  assert.equal(historyReads, 1);
  mode = 'auto';
  await runDirector(tick(), options);
  assert.equal(calls.n, 0);
  assert.equal(historyReads, 1);
  invalidateDirectorSession(sessionId);
  await runDirector(tick(), options);
  assert.equal(calls.n, 1);
  assert.equal(historyReads, 2);
});

test('a hung or failed wake releases the session lock', async () => {
  resetDirectorProcessState();
  let releaseHold = () => {};
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  const hanging: DirectorClient = {
    async propose() {
      await hold;
      return { parsed: { act: false, reason: 'late', proposal: null } };
    },
    async consistency() {
      return { parsed: { verdict: 'consistent', reason: 'ok' } };
    },
  };
  const first = scheduleDirectorWake(tick(), {
    store: store(),
    client: hanging,
    enabled: true,
    aiEnabled: true,
    wakeLockMs: 30,
  });
  assert.equal(first, true);
  assert.equal(
    scheduleDirectorWake(tick(), { store: store(), client: quietClient({ n: 0 }), enabled: true, aiEnabled: true }),
    false,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const afterTimeout = scheduleDirectorWake(tick(), {
    store: store(),
    client: quietClient({ n: 0 }),
    enabled: true,
    aiEnabled: true,
  });
  assert.equal(afterTimeout, true);
  releaseHold();
  await new Promise((resolve) => setTimeout(resolve, 30));

  resetDirectorProcessState();
  const failing: DirectorClient = {
    async propose() {
      throw new Error('model down');
    },
    async consistency() {
      return { parsed: null, failed: true };
    },
  };
  assert.equal(
    scheduleDirectorWake(tick(), { store: store(), client: failing, enabled: true, aiEnabled: true }),
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    scheduleDirectorWake(tick(), { store: store(), client: quietClient({ n: 0 }), enabled: true, aiEnabled: true }),
    true,
  );
});

test('a wake that started in auto does not store a countdown after the mode turns off', async () => {
  const draft = {
    status: 'proposed',
    mode: 'auto',
    proposal: { severity: 'medium' },
  } as DirectorDraft;
  assert.equal(applyLiveMode(draft, 'off').status, 'expired');
  assert.equal(applyLiveMode(draft, 'suggest').mode, 'suggest');
  assert.equal(applyLiveMode(draft, 'auto').mode, 'auto');

  resetDirectorProcessState();
  let mode: string | null = 'auto';
  const stored: { row: Record<string, unknown> | null } = { row: null };
  const backing = store();
  backing.loadSession = async () => ({ director_mode: mode, director_seed: '1' });
  backing.insertProposal = async (row) => {
    stored.row = row;
    return 'ok';
  };
  const client: DirectorClient = {
    async propose() {
      mode = 'off';
      return {
        parsed: {
          act: true,
          reason: 'Legal has been silent',
          proposal: {
            kind: 'consequence',
            cause: { signal_ids: ['mood:stk_maria'], source_teams: ['Legal'] },
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
          },
        },
      };
    },
    async consistency() {
      return { parsed: { verdict: 'consistent', reason: 'ok' } };
    },
  };
  await runDirector(tick(), { store: backing, client, enabled: true, aiEnabled: true });
  assert.equal(stored.row?.status, 'expired');
  assert.equal(stored.row?.auto_publish_at, null);
});
