import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resetDirectorProcessState,
  scheduleDirectorWake,
  type DirectorStore,
  type DirectorTickInput,
} from './directorService.js';
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
