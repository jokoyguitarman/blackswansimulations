import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { env } from '../env.js';
import {
  isPeaceSchemaMissing,
  markPeaceColumnsMissing,
  peaceColumnsMissing,
  resetPeaceColumnsForTests,
  selectWithOpenedAt,
  withOpenedAt,
} from './peaceSchema.js';

const original = env.enablePeacePeriod;

afterEach(() => {
  env.enablePeacePeriod = original;
  resetPeaceColumnsForTests();
});

describe('peace column select', () => {
  test('withOpenedAt returns the exact base string when the flag is off', () => {
    env.enablePeacePeriod = false;
    assert.equal(withOpenedAt('id, start_time'), 'id, start_time');
  });

  test('a missing 281 column is remembered, and a different missing column is not', async () => {
    env.enablePeacePeriod = true;
    assert.equal(withOpenedAt('id, start_time'), 'id, start_time, opened_at');
    assert.equal(isPeaceSchemaMissing({ code: '42703', message: 'column "team_uid" does not exist' }), false);
    assert.equal(
      isPeaceSchemaMissing({ code: 'PGRST204', message: "Could not find the 'opened_at' column" }),
      true,
    );

    const seen: string[] = [];
    const first = await selectWithOpenedAt('id, start_time', async (columns) => {
      seen.push(columns);
      if (columns.includes('opened_at')) {
        return { data: null, error: { code: 'PGRST204', message: "Could not find the 'opened_at' column" } };
      }
      return { data: { id: 's' }, error: null };
    });
    assert.deepEqual(seen, ['id, start_time, opened_at', 'id, start_time']);
    assert.deepEqual(first.data, { id: 's' });
    assert.equal(peaceColumnsMissing(), true);

    seen.length = 0;
    await selectWithOpenedAt('id, start_time', async (columns) => {
      seen.push(columns);
      return { data: { id: 's' }, error: null };
    });
    assert.deepEqual(seen, ['id, start_time']);
  });

  test('markPeaceColumnsMissing warns once', () => {
    markPeaceColumnsMissing();
    markPeaceColumnsMissing();
    assert.equal(peaceColumnsMissing(), true);
  });
});
