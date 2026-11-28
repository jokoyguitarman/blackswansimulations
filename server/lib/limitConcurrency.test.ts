import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { limitConcurrency, withConcurrencyLimit } from './limitConcurrency.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('limitConcurrency', () => {
  test('preserves input order when later items finish first', async () => {
    const out = await limitConcurrency([1, 2, 3, 4], 2, async (n) => {
      await delay((5 - n) * 15);
      return n * 10;
    });
    assert.deepEqual(out, [10, 20, 30, 40]);
  });

  test('in-flight calls never exceed the limit', async () => {
    let current = 0;
    let max = 0;
    await limitConcurrency(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      async () => {
        current += 1;
        max = Math.max(max, current);
        await delay(20);
        current -= 1;
      },
    );
    assert.equal(max, 3);
  });

  test('the first rejection propagates', async () => {
    await assert.rejects(
      () =>
        limitConcurrency([1, 2, 3], 2, async (n) => {
          if (n === 1) throw new Error('first');
          await delay(40);
          return n;
        }),
      (err: unknown) => err instanceof Error && err.message === 'first',
    );
  });

  test('a shared build limiter caps nested fan-outs together', async () => {
    let current = 0;
    let max = 0;
    const touch = async () => {
      current += 1;
      max = Math.max(max, current);
      await delay(10);
      current -= 1;
    };
    const done = withConcurrencyLimit(3, () =>
      limitConcurrency(
        Array.from({ length: 8 }, (_, i) => i),
        3,
        () =>
          limitConcurrency(
            Array.from({ length: 6 }, (_, i) => i),
            3,
            () => touch(),
          ),
      ),
    );
    const outcome = await Promise.race([
      done.then(() => 'ok' as const),
      delay(2000).then(() => 'deadlock' as const),
    ]);
    assert.equal(outcome, 'ok');
    assert.ok(max <= 3);
    assert.ok(max >= 2);
  });
});
