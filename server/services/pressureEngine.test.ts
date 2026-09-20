import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chooseMove, type PageProgress } from './pressureEngineService.js';

const p = (over: Partial<PageProgress> = {}): PageProgress => ({
  minutesSinceLastPost: Infinity,
  rung: 0,
  maxRung: 3,
  spokespersonContacted: false,
  latestVerdict: null,
  hqPublished: false,
  contradictionSeen: false,
  stoodDown: false,
  decisionTouched: false,
  escalationRisk: 30,
  ...over,
});

describe('pressure registers', () => {
  test('ignored → statement, then demand with deadline, then climbs the ladder, then stops', () => {
    assert.equal(chooseMove('advocacy', p()), 'statement');
    assert.equal(chooseMove('advocacy', p({ rung: 1 })), 'demand_with_deadline');
    assert.equal(chooseMove('advocacy', p({ rung: 2 })), 'escalate_rung');
    assert.equal(chooseMove('advocacy', p({ rung: 3 })), 'skip');
  });
  test('cadence: too soon → skip; engaged pages post less often; hot sessions faster', () => {
    assert.equal(chooseMove('advocacy', p({ minutesSinceLastPost: 3 })), 'skip');
    assert.equal(
      chooseMove('advocacy', p({ minutesSinceLastPost: 9, rung: 1 })),
      'demand_with_deadline',
    );
    assert.equal(
      chooseMove('advocacy', p({ minutesSinceLastPost: 9, rung: 1, spokespersonContacted: true })),
      'skip',
      'engaged cadence is 14',
    );
    assert.equal(
      chooseMove('advocacy', p({ minutesSinceLastPost: 7, rung: 1, escalationRisk: 70 })),
      'demand_with_deadline',
      'hot → 0.75x',
    );
  });
  test('engaged + judge softened or withdrew → stand down once, then silence', () => {
    assert.equal(
      chooseMove('advocacy', p({ rung: 2, spokespersonContacted: true, latestVerdict: 'cancel' })),
      'stand_down',
    );
    assert.equal(
      chooseMove('statutory', p({ rung: 1, spokespersonContacted: true, latestVerdict: 'modify' })),
      'stand_down',
    );
    assert.equal(
      chooseMove(
        'advocacy',
        p({ rung: 3, spokespersonContacted: true, latestVerdict: 'cancel', stoodDown: true }),
      ),
      'skip',
    );
  });
  test('engaged but only delayed → acknowledge progress; a decision touching the target escalates', () => {
    assert.equal(
      chooseMove('grassroots', p({ rung: 1, spokespersonContacted: true, latestVerdict: 'delay' })),
      'acknowledge_progress',
    );
    assert.equal(chooseMove('political', p({ rung: 1, decisionTouched: true })), 'escalate_rung');
  });
  test('regulators correct the record but never amplify; contradiction only after a first statement', () => {
    assert.equal(
      chooseMove('statutory', p({ rung: 1, contradictionSeen: true })),
      'correct_record',
    );
    assert.equal(chooseMove('statutory', p({ rung: 0, contradictionSeen: true })), 'statement');
    const moves = new Set<string>();
    for (let rung = 0; rung <= 3; rung++)
      for (const v of [null, 'keep', 'delay'] as const)
        moves.add(chooseMove('statutory', p({ rung, latestVerdict: v })));
    assert.ok(!Array.from(moves).some((m) => /amplify|dunk|insinuate/.test(m)));
  });
});

describe('aligned register (AI-operated office)', () => {
  test('HQ silent → one local holding statement, then wait', () => {
    assert.equal(chooseMove('aligned', p()), 'aligned_holding_statement');
    assert.equal(chooseMove('aligned', p({ rung: 1 })), 'skip');
  });
  test('HQ published → mirror it once or twice, never demand', () => {
    assert.equal(chooseMove('aligned', p({ hqPublished: true })), 'aligned_follow_hq');
    assert.equal(chooseMove('aligned', p({ hqPublished: true, rung: 1 })), 'aligned_follow_hq');
    assert.equal(chooseMove('aligned', p({ hqPublished: true, rung: 2 })), 'skip');
  });
  test('inaccurate claim about the site → clarify', () => {
    assert.equal(chooseMove('aligned', p({ contradictionSeen: true, rung: 2 })), 'aligned_clarify');
  });
});
