import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { chat, type ChatMessage } from './chatClient.js';
import { runWithAbortSignal } from './abortContext.js';

// Keep provider calls off the network. A real key in the environment is replaced
// so a missed stub cannot send it. chat() reads these at call time.
logger.level = 'silent';
env.aiEnabled = true;
env.openAiApiKey = 'test-key-not-a-secret';

const messages: ChatMessage[] = [{ role: 'user', content: 'ping' }];
const realFetch = globalThis.fetch;

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for fetch');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Reject when the request signal aborts, the way undici fetch does.
 * A ref'd interval stands in for the socket so AbortSignal.timeout (unref'd)
 * still fires before the event loop goes idle.
 */
function hangUntilAbort(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    const keepAlive = setInterval(() => {}, 1_000);
    const fail = () => {
      clearInterval(keepAlive);
      const reason = signal?.reason;
      if (reason instanceof Error) {
        reject(reason);
        return;
      }
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    };
    if (!signal) return;
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

test('X1 aborted ALS signal makes chat return null without calling fetch', async () => {
  const ac = new AbortController();
  ac.abort();
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    throw new Error('fetch should not be called');
  }) as typeof fetch;
  try {
    const result = await runWithAbortSignal(ac.signal, () =>
      chat({
        tier: 'fast',
        messages,
        retry: { attempts: 3, baseDelayMs: 1 },
        label: 'x1',
      }),
    );
    assert.equal(result, null);
    assert.equal(calls, 0);
  } finally {
    restoreFetch();
  }
});

test('X2 aborting during fetch returns null with no retry', async () => {
  const ac = new AbortController();
  let calls = 0;
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    calls += 1;
    return hangUntilAbort(init);
  }) as typeof fetch;
  try {
    const pending = runWithAbortSignal(ac.signal, () =>
      chat({
        tier: 'fast',
        messages,
        timeoutMs: 60_000,
        retry: { attempts: 4, baseDelayMs: 5 },
        label: 'x2',
      }),
    );
    await waitFor(() => calls >= 1);
    ac.abort();
    const result = await pending;
    assert.equal(result, null);
    assert.equal(calls, 1);
  } finally {
    restoreFetch();
  }
});

test('X3 without ALS a timeout is retried', async () => {
  let calls = 0;
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    calls += 1;
    return hangUntilAbort(init);
  }) as typeof fetch;
  try {
    const result = await chat({
      tier: 'fast',
      messages,
      timeoutMs: 40,
      retry: { attempts: 2, baseDelayMs: 1 },
      label: 'x3',
    });
    assert.equal(result, null);
    assert.equal(calls, 2);
  } finally {
    restoreFetch();
  }
});

test('X4 the signal propagates through Promise.all of two chat calls', async () => {
  const ac = new AbortController();
  let calls = 0;
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    calls += 1;
    return hangUntilAbort(init);
  }) as typeof fetch;
  try {
    const pending = runWithAbortSignal(ac.signal, () =>
      Promise.all([
        chat({
          tier: 'fast',
          messages,
          timeoutMs: 60_000,
          retry: { attempts: 4, baseDelayMs: 5 },
          label: 'x4a',
        }),
        chat({
          tier: 'fast',
          messages,
          timeoutMs: 60_000,
          retry: { attempts: 4, baseDelayMs: 5 },
          label: 'x4b',
        }),
      ]),
    );
    await waitFor(() => calls >= 2);
    ac.abort();
    const [a, b] = await pending;
    assert.equal(a, null);
    assert.equal(b, null);
    assert.equal(calls, 2);
  } finally {
    restoreFetch();
  }
});
