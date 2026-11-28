import assert from 'node:assert/strict';
import test from 'node:test';
import { countdownLabel, directorPanel, fairnessFilled } from './directorPanel.js';

const now = new Date('2026-11-28T12:00:00.000Z');

test('directorPanel shows a countdown card, fairness bars and the budget', () => {
  const panel = directorPanel({
    enabled: true,
    mode: 'auto',
    modeMax: 'auto',
    scenarioMode: 'auto',
    sessionMode: null,
    paused: false,
    budgetUsed: 6,
    budgetLimit: 20,
    tolerance: 2,
    fairness: [
      { team: 'Ops', negative: 4, share: 1.75, over: true },
      { team: 'Legal', negative: 0, share: 1.75, over: false },
    ],
    proposals: [
      {
        id: 'p1',
        seq: 3,
        minute: 27,
        status: 'proposed',
        reason: 'Legal has been silent for 12 min',
        autoPublishAt: new Date(now.getTime() + 42_000).toISOString(),
        proposal: {
          kind: 'consequence',
          title: 'Comment on the Bay 3 incident',
          content: 'Please comment.',
          severity: 'medium',
          app: 'email',
          target_teams: ['Legal'],
          sender: { stakeholder_id: 'stk_maria' },
        },
        guardrails: [{ id: 'consistent', ok: true, detail: 'consistent' }],
        consistencyStatus: 'consistent',
      },
      {
        id: 'old',
        seq: 1,
        minute: 10,
        status: 'vetoed',
        reason: null,
        autoPublishAt: null,
        proposal: {
          title: 'Gone',
          content: 'Gone',
          target_teams: ['Ops'],
          app: 'email',
          severity: 'low',
        },
        guardrails: [],
        consistencyStatus: null,
      },
    ],
    stakeholderNames: { stk_maria: 'Maria Tan' },
    now,
  });
  assert.equal(panel.cards.length, 1);
  assert.equal(panel.cards[0]?.sender, 'Maria Tan');
  assert.equal(panel.cards[0]?.countdownLabel, '0:42');
  assert.equal(panel.cards[0]?.needsApproval, false);
  assert.match(panel.cards[0]?.checks ?? '', /consistent/);
  assert.equal(panel.fairness[0]?.filled, 4);
  assert.equal(panel.fairness[1]?.filled, 0);
  assert.equal(fairnessFilled(2), 2);
  assert.equal(countdownLabel(5), '0:05');
});

test('a disabled director renders no cards', () => {
  const panel = directorPanel({
    enabled: false,
    mode: 'off',
    modeMax: 'off',
    scenarioMode: null,
    sessionMode: null,
    paused: false,
    budgetUsed: 0,
    budgetLimit: 20,
    tolerance: 2,
    fairness: [],
    proposals: [
      {
        id: 'p1',
        seq: 1,
        minute: 12,
        status: 'proposed',
        reason: 'quiet',
        autoPublishAt: null,
        proposal: { title: 'Hidden', content: 'Hidden', target_teams: ['Legal'] },
        guardrails: [],
        consistencyStatus: null,
      },
    ],
    now,
  });
  assert.equal(panel.enabled, false);
  assert.equal(panel.cards.length, 0);
});
