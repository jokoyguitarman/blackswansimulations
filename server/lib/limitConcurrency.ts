import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * One build shares one limiter (see `withConcurrencyLimit`). A fan-out that
 * itself fans out must not keep a slot while it waits for its children: that
 * deadlocks once every slot is held by a parent. The nested map gives the
 * parent slot back for the duration of the children, so every AI call in the
 * build draws from the same cap.
 */
type Hold = { holds: boolean };

export interface ConcurrencyLimiter {
  readonly limit: number;
  map<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]>;
}

function normaliseLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) return 1;
  return Math.floor(limit);
}

export function createConcurrencyLimiter(limit: number): ConcurrencyLimiter {
  const cap = normaliseLimit(limit);
  let active = 0;
  const waiters: Array<() => void> = [];
  const hold = new AsyncLocalStorage<Hold>();

  const acquire = (): Promise<void> => {
    if (active < cap) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      waiters.push(() => {
        active += 1;
        resolve();
      });
    });
  };

  const release = (): void => {
    active -= 1;
    const next = waiters.shift();
    if (next) next();
  };

  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    const current = hold.getStore();
    if (current?.holds) return fn();
    await acquire();
    try {
      return await hold.run({ holds: true }, fn);
    } finally {
      release();
    }
  };

  const map = async <T, R>(
    items: readonly T[],
    fn: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> => {
    const parent = hold.getStore();
    // Synchronous: two nested maps started together must not both release the one parent slot.
    const nested = Boolean(parent?.holds);
    if (parent && nested) parent.holds = false;
    if (nested) release();
    try {
      const body = async (): Promise<R[]> => {
        const results = new Array<R>(items.length);
        await Promise.all(
          items.map(async (item, index) => {
            results[index] = await run(() => fn(item, index));
          }),
        );
        return results;
      };
      return nested ? await hold.run({ holds: false }, body) : await body();
    } finally {
      if (nested) {
        await acquire();
        if (parent) parent.holds = true;
      }
    }
  };

  return { limit: cap, map };
}

const buildLimiter = new AsyncLocalStorage<ConcurrencyLimiter>();

export function currentConcurrencyLimiter(): ConcurrencyLimiter | undefined {
  return buildLimiter.getStore();
}

/** Caps every `limitConcurrency` call inside `fn` with one shared limiter. */
export function withConcurrencyLimit<T>(limit: number, fn: () => Promise<T>): Promise<T> {
  if (buildLimiter.getStore()) return fn();
  return buildLimiter.run(createConcurrencyLimiter(limit), fn);
}

/**
 * Run `fn` over `items` with at most `limit` calls in flight. Results keep input
 * order. The returned promise rejects with the first rejection, like `Promise.all`,
 * and does not cancel work already running. Inside `withConcurrencyLimit`, every
 * call shares that build's limiter and `limit` is ignored.
 */
export async function limitConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const shared = buildLimiter.getStore();
  if (shared) return shared.map(items, fn);
  return createConcurrencyLimiter(limit).map(items, fn);
}
