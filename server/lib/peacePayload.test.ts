import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withoutPeaceLeakTerms, withoutSessionLeakTerms } from './peacePayload.js';

test('player copies drop leak terms and keep the posts', () => {
  const state = {
    org_name: 'Dyson',
    peace_period: {
      seconds: 300,
      enabled: true,
      leak_terms: ['recall', 'battery fire'],
      posts: [{ ref: 'P1', content: 'Breakfast' }],
    },
  };
  const stripped = withoutPeaceLeakTerms(state);
  const peace = stripped.peace_period as { leak_terms?: unknown; posts: unknown[]; seconds: number };
  assert.equal('leak_terms' in peace, false);
  assert.equal(peace.seconds, 300);
  assert.equal(peace.posts.length, 1);
  assert.deepEqual(state.peace_period.leak_terms, ['recall', 'battery fire']);

  const session = withoutSessionLeakTerms({ id: 's', current_state: state, start_time: 't' });
  const current = session.current_state as { peace_period: { leak_terms?: unknown } };
  assert.equal('leak_terms' in current.peace_period, false);
  assert.equal(session.start_time, 't');
});

test('a payload with no peace feed is returned as it was', () => {
  const state = { org_name: 'Dyson' };
  assert.equal(withoutPeaceLeakTerms(state), state);
  assert.equal(withoutSessionLeakTerms({ id: 's' }).id, 's');
});
