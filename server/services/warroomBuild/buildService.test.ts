import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { chat, type ChatMessage } from '../ai/chatClient.js';
import { runWithAbortSignal } from '../ai/abortContext.js';
import { env } from '../../env.js';
import { assembleReview } from './assemble.js';
import { formatProgress, restartLine } from './buildCore.js';
import { BuildService, ManualClock } from './buildService.js';
import { MemoryBuildStore } from './buildStore.js';
import type { StageRunner } from './stageRunners.js';
import { buildRequestSchema, type BuildRequest, type BuildStage } from './buildTypes.js';

env.aiEnabled = true;
env.openAiApiKey = 'test-key-not-a-secret';

const progressLine = formatProgress({ type: 'team_complete', team: 'Legal', inject_count: 15 })!;

function request(crisis = 'Plant fire'): BuildRequest {
  return buildRequestSchema.parse({
    crisis_type: crisis,
    context: 'A fire at the Johor plant.',
    country: 'Singapore',
    organisations: [
      {
        display_name: 'Meridian',
        country: 'Singapore',
        is_primary: true,
        team_roster: [{ team_name: 'Communications' }],
      },
    ],
  });
}

const charactersOut = {
  personas: [
    {
      handle: 'ada',
      name: 'Ada',
      type: 'npc_public' as const,
      personality: '',
      bias: '',
      follower_count: 1,
      backstory: '',
      posting_pattern: '',
      specific_claims: [] as string[],
    },
  ],
  fact_sheet: { confirmed_facts: ['the plant burned'], unconfirmed_claims: [] },
  communities: ['Johor'],
  countries: [{ name: 'Singapore' }],
  per_country_counts: { Singapore: 1 },
};

const storylineOut = {
  injects: [
    {
      type: 'social_post',
      title: 'backbone',
      content: 'backbone',
      severity: 'low',
      inject_scope: 'universal',
      target_teams: [] as string[],
      delivery_config: { app: 'social_feed' as const },
    },
  ],
  team_storylines: {},
  team_charters: [],
  stakeholders: [],
  stakeholder_injects: [],
  persona_twins: [],
  orgs: [],
  sop_steps: [],
  decision_context: { leakiness: 0.5, labour_signal: false, product_safety_signal: false },
  pressure_organisations: [],
};

const convergenceOut = {
  sharedInjects: [],
  convergenceGates: [],
  narrative: { title: 'Fire', description: 'A fire.', briefing: 'Brief.' },
  objectives: [],
  dimensionLabels: { public_trust: 'Public trust' },
  intel_injects: {},
};

const pagesOut = {
  org_page: { page_name: 'Meridian' },
  orgs: [],
  countries: [],
  pressure_injects: [],
  persona_twins: [],
};

interface HarnessOptions {
  instanceId?: string;
  store?: MemoryBuildStore;
  clock?: ManualClock;
  maxConcurrent?: number;
  maxActivePerUser?: number;
  runners?: Partial<Record<BuildStage, StageRunner>>;
}

function harness(options: HarnessOptions = {}) {
  const clock = options.clock ?? new ManualClock();
  const store = options.store ?? new MemoryBuildStore(() => clock.now());
  const calls = { characters: 0, storyline: 0, convergence: 0, pages: 0 };
  const order: BuildStage[] = [];
  const runners: Record<BuildStage, StageRunner> = {
    characters: async (_input, ctx) => {
      calls.characters += 1;
      order.push('characters');
      ctx.log('progress', '1 characters and a fact sheet ready');
      return charactersOut;
    },
    storyline: async (_input, ctx) => {
      calls.storyline += 1;
      order.push('storyline');
      ctx.log('progress', progressLine);
      return storylineOut;
    },
    convergence: async () => {
      calls.convergence += 1;
      order.push('convergence');
      return convergenceOut;
    },
    pages: async () => {
      calls.pages += 1;
      order.push('pages');
      return pagesOut;
    },
    ...options.runners,
  };
  const service = new BuildService({
    store,
    runners,
    pool: 'pool-a',
    instanceId: options.instanceId ?? 'A',
    clock,
    maxConcurrent: options.maxConcurrent,
    maxActivePerUser: options.maxActivePerUser ?? 10,
  });
  return { clock, store, calls, order, service, runners };
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('timed out waiting for the build');
}

describe('build service', () => {
  test('S1 happy path runs the four stages once and logs progress', async () => {
    const { service, store, order } = harness();
    const started = await service.start({
      draftId: 'draft-1',
      userId: 'user-1',
      request: request(),
      idempotencyKey: 'key-1',
    });
    await service.whenIdle();
    const row = await store.get(started.buildId!);
    assert.equal(row?.status, 'succeeded');
    assert.deepEqual(order, ['characters', 'storyline', 'convergence', 'pages']);
    const outputs = await store.getOutputs(started.buildId!);
    assert.ok(outputs.characters);
    assert.ok(outputs.storyline);
    assert.ok(outputs.convergence);
    assert.ok(outputs.pages);
    const viewed = await service.get(started.buildId!, 0);
    assert.ok(viewed?.log.some((line) => line.message === progressLine));
  });

  test('S2 disconnect and resume: the build finishes with no further polls', async () => {
    let releaseCharacters: () => void = () => undefined;
    const { service, store, calls } = harness({
      runners: {
        characters: async (_input, ctx) => {
          calls.characters += 1;
          await new Promise<void>((resolve) => {
            releaseCharacters = resolve;
          });
          ctx.log('progress', '1 characters and a fact sheet ready');
          return charactersOut;
        },
      },
    });
    const started = await service.start({
      draftId: 'draft-1',
      userId: 'user-1',
      request: request(),
      idempotencyKey: 'key-1',
    });
    const id = started.buildId!;
    await service.get(id);
    await service.get(id);
    releaseCharacters();
    await service.whenIdle();
    const row = await store.get(id);
    assert.equal(row?.status, 'succeeded');
    assert.equal(calls.characters, 1);
    assert.equal(calls.storyline, 1);
    assert.equal(calls.convergence, 1);
    assert.equal(calls.pages, 1);
    const full = await service.get(id, 0);
    assert.equal(full?.log[0]?.seq, 1);
    assert.ok((full?.log.length ?? 0) > 1);
    const review = await service.review(id);
    assert.deepEqual(review, assembleReview(row!.request, await store.getOutputs(id)));
  });

  test('S3 SIGTERM mid-stage lets the other instance finish from storyline', async () => {
    let storylineSignal: AbortSignal | undefined;
    const calls = { characters: 0, storyline: 0 };
    const {
      service: owner,
      store,
      clock,
    } = harness({
      instanceId: 'A',
      runners: {
        characters: async () => {
          calls.characters += 1;
          return charactersOut;
        },
        storyline: async (_input, ctx) => {
          calls.storyline += 1;
          storylineSignal = ctx.signal;
          await new Promise((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
          });
          return storylineOut;
        },
      },
    });
    const started = await owner.start({
      draftId: 'draft-1',
      userId: 'user-1',
      request: request(),
      idempotencyKey: 'key-1',
    });
    const id = started.buildId!;
    await waitFor(async () => calls.storyline === 1);
    const token = (await store.get(id))?.lease_token;
    const writes: string[] = [];
    let armed = false;
    const original = store.completeStage.bind(store);
    store.completeStage = async (stageArgs) => {
      if (armed) writes.push(stageArgs.leaseToken);
      return original(stageArgs);
    };
    await owner.shutdown();
    armed = true;
    assert.equal(storylineSignal?.aborted, true);
    const paused = await store.get(id);
    assert.equal(paused?.status, 'queued');
    assert.equal(paused?.lease_token, null);
    assert.equal(paused?.interruptions, 1);
    assert.equal(paused?.stage_states.storyline.status, 'interrupted');
    assert.equal(paused?.stage_states.characters.status, 'done');
    assert.ok((await store.getOutputs(id)).characters);
    const log = await store.listLog(id, 0, 200);
    assert.ok(log.some((line) => line.message === restartLine('storyline')));

    const other = harness({
      instanceId: 'B',
      store,
      clock,
      runners: {
        characters: async () => {
          calls.characters += 1;
          return charactersOut;
        },
        storyline: async () => {
          calls.storyline += 1;
          return storylineOut;
        },
      },
    });
    await other.service.tick();
    await other.service.whenIdle();
    const done = await store.get(id);
    assert.equal(done?.status, 'succeeded');
    assert.equal(done?.stage_states.storyline.attempts, 2);
    assert.equal(calls.characters, 1);
    assert.equal(writes.includes(token ?? ''), false);
  });

  test('S4 a crash without SIGTERM expires the lease and rejects a late write', async () => {
    let releaseOwner: () => void = () => undefined;
    let releaseOther: () => void = () => undefined;
    let storyCalls = 0;
    const storyline: StageRunner = async () => {
      storyCalls += 1;
      if (storyCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseOwner = resolve;
        });
      } else {
        await new Promise<void>((resolve) => {
          releaseOther = resolve;
        });
      }
      return storylineOut;
    };
    const {
      service: owner,
      store,
      clock,
    } = harness({
      instanceId: 'A',
      runners: { storyline },
    });
    const started = await owner.start({
      draftId: 'draft-1',
      userId: 'user-1',
      request: request(),
      idempotencyKey: 'key-1',
    });
    const id = started.buildId!;
    await waitFor(async () => storyCalls === 1);
    const ownerToken = (await store.get(id))!.lease_token!;
    let ownerWrite: boolean | undefined;
    const original = store.completeStage.bind(store);
    store.completeStage = async (stageArgs) => {
      const wrote = await original(stageArgs);
      if (stageArgs.leaseToken === ownerToken && stageArgs.stage === 'storyline')
        ownerWrite = wrote;
      return wrote;
    };
    clock.advance(61_000);
    const other = harness({ instanceId: 'B', store, clock, runners: { storyline } });
    await other.service.tick();
    await waitFor(async () => storyCalls === 2);
    const reclaimed = await store.get(id);
    assert.equal(reclaimed?.interruptions, 1);
    assert.equal(reclaimed?.lease_owner, 'B');
    assert.equal((await store.getOutputs(id)).storyline, undefined);
    releaseOwner();
    await owner.whenIdle();
    assert.equal(ownerWrite, false);
    assert.equal((await store.getOutputs(id)).storyline, undefined);
    releaseOther();
    await other.service.whenIdle();
    assert.equal((await store.get(id))?.status, 'succeeded');
    assert.equal((await store.getOutputs(id)).characters !== undefined, true);
  });

  test('S5 a renewing owner keeps the build for five simulated minutes', async () => {
    let release: () => void = () => undefined;
    const {
      service: owner,
      store,
      clock,
      calls,
    } = harness({
      instanceId: 'A',
      runners: {
        storyline: async (_input, ctx) => {
          calls.storyline += 1;
          await new Promise<void>((resolve, reject) => {
            release = resolve;
            ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
          });
          return storylineOut;
        },
      },
    });
    const other = harness({ instanceId: 'B', store, clock });
    const started = await owner.start({
      draftId: 'draft-1',
      userId: 'user-1',
      request: request(),
      idempotencyKey: 'key-1',
    });
    await waitFor(async () => calls.storyline === 1);
    for (let step = 0; step < 20; step += 1) {
      clock.advance(15_000);
      await owner.tick();
      await other.service.tick();
    }
    const row = await store.get(started.buildId!);
    assert.equal(row?.lease_owner, 'A');
    assert.equal(row?.status, 'running');
    assert.equal(calls.storyline, 1);
    release();
  });

  test('two resumes at once run the failed stage once', async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const { service } = harness({
      runners: {
        storyline: async () => {
          calls += 1;
          if (calls === 1) throw Object.assign(new Error('slow down'), { status: 429 });
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return storylineOut;
        },
      },
    });
    const started = await service.start({
      draftId: 'draft-1',
      userId: 'user-1',
      request: request(),
      idempotencyKey: 'key-1',
    });
    await service.whenIdle();
    const id = started.buildId!;
    const resumed = await Promise.all([service.resume(id), service.resume(id)]);
    assert.equal(resumed.length, 2);
    await waitFor(async () => calls >= 2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    release();
    await service.whenIdle();
  });

  test('an unwatched pause names the last finished stage, not the one about to run', async () => {
    const { service, store, clock } = harness({
      runners: {
        storyline: async (_input, ctx) => {
          await new Promise((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
          });
          return storylineOut;
        },
      },
    });
    const started = await service.start({
      draftId: 'draft-1',
      userId: 'user-1',
      request: request(),
      idempotencyKey: 'key-1',
    });
    const id = started.buildId!;
    await waitFor(async () => (await store.get(id))?.stage_states.storyline.status === 'running');
    await service.shutdown();
    clock.advance(46 * 60 * 1000);
    let storylineAgain = 0;
    const next = harness({
      store,
      clock,
      runners: {
        storyline: async () => {
          storylineAgain += 1;
          return storylineOut;
        },
      },
    });
    await next.service.tick();
    await next.service.whenIdle();
    assert.equal((await store.get(id))?.status, 'paused');
    assert.equal(storylineAgain, 0);
    const log = await store.listLog(id, 0, 200);
    assert.ok(log.some((line) => line.message.includes('after the Characters stage')));
    assert.equal(
      log.some((line) => line.message.includes('after the Storyline stage')),
      false,
    );
  });

  test('shutdown releases a runner that ignores the abort within 5 seconds', async () => {
    const { service, store } = harness({
      runners: {
        characters: async () => new Promise(() => undefined),
      },
    });
    const started = await service.start({
      draftId: 'draft-1',
      userId: 'user-1',
      request: request(),
      idempotencyKey: 'key-1',
    });
    const began = Date.now();
    await service.shutdown();
    const elapsed = Date.now() - began;
    assert.ok(elapsed < 5_000, `shutdown took ${elapsed}ms`);
    assert.ok(elapsed >= 2_500, `shutdown returned in ${elapsed}ms without waiting out the runner`);
    const row = await store.get(started.buildId!);
    assert.equal(row?.status, 'queued');
    assert.equal(row?.lease_token, null);
    assert.equal(row?.stage_states.characters.status, 'interrupted');
  });

  test('S6 a storyline failure resumes from storyline only', async () => {
    let failed = false;
    const { service, store, calls } = harness({
      runners: {
        storyline: async (_input, ctx) => {
          calls.storyline += 1;
          if (!failed) {
            failed = true;
            throw Object.assign(new Error('slow down'), { status: 429 });
          }
          ctx.log('progress', progressLine);
          return storylineOut;
        },
      },
    });
    const started = await service.start({
      draftId: 'draft-1',
      userId: 'user-1',
      request: request(),
      idempotencyKey: 'key-1',
    });
    await service.whenIdle();
    const failedRow = await store.get(started.buildId!);
    assert.equal(failedRow?.status, 'failed');
    assert.equal(failedRow?.error_code, 'stage_failed');
    assert.match(failedRow?.error ?? '', /rate-limited the Storyline stage/);
    assert.equal(calls.characters, 1);
    assert.equal(calls.convergence, 0);
    await service.resume(started.buildId!);
    await service.whenIdle();
    const done = await store.get(started.buildId!);
    assert.equal(done?.status, 'succeeded');
    assert.equal(calls.characters, 1);
    assert.equal(calls.storyline, 2);
    assert.equal(calls.convergence, 1);
    assert.equal(calls.pages, 1);
  });

  test('S7 a pages failure is skipped and the build succeeds', async () => {
    const { service, store, calls } = harness({
      runners: {
        pages: async () => {
          calls.pages += 1;
          throw new Error('image provider failed');
        },
      },
    });
    const started = await service.start({
      draftId: 'draft-1',
      userId: 'user-1',
      request: request(),
      idempotencyKey: 'key-1',
    });
    await service.whenIdle();
    const row = await store.get(started.buildId!);
    assert.equal(row?.status, 'succeeded');
    assert.equal(row?.stage_states.pages.status, 'skipped');
    assert.equal(calls.convergence, 1);
    assert.equal(calls.pages, 1);
    const log = await store.listLog(started.buildId!, 0, 200);
    assert.ok(
      log.some((line) => line.kind === 'warning' && line.message.includes('compiles without them')),
    );
  });

  test('S8 cancel aborts the owner at once and the other instance at the next renewal', async () => {
    let ownerSignal: AbortSignal | undefined;
    let release: () => void = () => undefined;
    const {
      service: owner,
      store,
      clock,
    } = harness({
      instanceId: 'A',
      runners: {
        storyline: async (_input, ctx) => {
          ownerSignal = ctx.signal;
          await new Promise<void>((resolve, reject) => {
            release = resolve;
            ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
          });
          return storylineOut;
        },
      },
    });
    const started = await owner.start({
      draftId: 'draft-1',
      userId: 'user-1',
      request: request(),
      idempotencyKey: 'key-1',
    });
    const id = started.buildId!;
    await waitFor(async () => ownerSignal !== undefined);
    await owner.cancel(id);
    const cancelled = await store.get(id);
    assert.equal(cancelled?.status, 'cancelled');
    assert.equal(ownerSignal?.aborted, true);
    assert.equal((await store.getOutputs(id)).storyline, undefined);
    assert.ok((await store.getOutputs(id)).characters);
    const fetches = { n: 0 };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetches.n += 1;
      return new Response('no');
    };
    try {
      const messages: ChatMessage[] = [{ role: 'user', content: 'ping' }];
      const result = await runWithAbortSignal(ownerSignal!, () =>
        chat({ tier: 'fast', messages, timeoutMs: 1000 }),
      );
      assert.equal(result, null);
      assert.equal(fetches.n, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
    void release;

    let otherSignal: AbortSignal | undefined;
    const second = harness({
      instanceId: 'A',
      store,
      clock,
      runners: {
        storyline: async (_input, ctx) => {
          otherSignal = ctx.signal;
          await new Promise((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
          });
          return storylineOut;
        },
      },
    });
    const again = await second.service.start({
      draftId: 'draft-2',
      userId: 'user-1',
      request: request(),
      idempotencyKey: 'key-2',
    });
    await waitFor(async () => otherSignal !== undefined);
    const remote = harness({ instanceId: 'B', store, clock });
    await remote.service.cancel(again.buildId!);
    assert.equal((await store.get(again.buildId!))?.status, 'running');
    clock.advance(15_000);
    await second.service.tick();
    await second.service.whenIdle();
    assert.equal((await store.get(again.buildId!))?.status, 'cancelled');
    assert.equal((await store.getOutputs(again.buildId!)).storyline, undefined);
  });

  test('S9 an unwatched build pauses at the next stage boundary', async () => {
    let release: () => void = () => undefined;
    const { service, store, clock, calls } = harness({
      runners: {
        storyline: async () => {
          calls.storyline += 1;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return storylineOut;
        },
      },
    });
    const started = await service.start({
      draftId: 'draft-1',
      userId: 'user-1',
      request: request(),
      idempotencyKey: 'key-1',
    });
    await waitFor(async () => calls.storyline === 1);
    clock.advance(46 * 60 * 1000);
    release();
    await service.whenIdle();
    const paused = await store.get(started.buildId!);
    assert.equal(paused?.status, 'paused');
    assert.equal(paused?.cancel_reason, 'unwatched');
    assert.equal(calls.convergence, 0);
    await service.resume(started.buildId!);
    await service.whenIdle();
    const done = await store.get(started.buildId!);
    assert.equal(done?.status, 'succeeded');
    assert.equal(calls.convergence, 1);
    assert.equal(calls.characters, 1);
  });

  test('S10 four interruptions on claim fails the build', async () => {
    let calls = 0;
    const clock = new ManualClock();
    const store = new MemoryBuildStore(() => clock.now());
    const runners = {
      characters: (async (_input, ctx) => {
        calls += 1;
        await new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
        });
        return charactersOut;
      }) satisfies StageRunner,
    };
    const first = harness({ store, clock, runners: { characters: runners.characters } });
    const started = await first.service.start({
      draftId: 'draft-1',
      userId: 'user-1',
      request: request(),
      idempotencyKey: 'key-1',
    });
    await waitFor(async () => calls === 1);
    await first.service.shutdown();
    for (let round = 0; round < 3; round += 1) {
      const next = harness({ store, clock, runners: { characters: runners.characters } });
      await next.service.tick();
      await waitFor(async () => calls === round + 2);
      await next.service.shutdown();
    }
    assert.equal((await store.get(started.buildId!))?.interruptions, 4);
    const last = harness({ store, clock, runners: { characters: runners.characters } });
    await last.service.tick();
    const failed = await store.get(started.buildId!);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.error_code, 'interrupted_too_often');
    assert.equal(calls, 4);
  });

  test('S11 idempotency replays, attaches, conflicts, and serialises concurrent starts', async () => {
    let release: () => void = () => undefined;
    const { service, store } = harness({
      runners: {
        characters: async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return charactersOut;
        },
      },
    });
    const req = request();
    const first = await service.start({
      draftId: 'draft-1',
      userId: 'user-1',
      request: req,
      idempotencyKey: 'key-a',
    });
    const replayed = await service.start({
      draftId: 'draft-1',
      userId: 'user-1',
      request: req,
      idempotencyKey: 'key-a',
    });
    assert.equal(replayed.outcome, 'replayed');
    assert.equal(replayed.buildId, first.buildId);
    const attached = await service.start({
      draftId: 'draft-1',
      userId: 'user-1',
      request: req,
      idempotencyKey: 'key-b',
    });
    assert.equal(attached.outcome, 'attached');
    assert.equal(attached.buildId, first.buildId);
    const conflict = await service.start({
      draftId: 'draft-1',
      userId: 'user-1',
      request: request('A different fire'),
      idempotencyKey: 'key-c',
    });
    assert.equal(conflict.outcome, 'conflict');
    assert.equal(conflict.buildId, first.buildId);
    const replaced = await service.start({
      draftId: 'draft-1',
      userId: 'user-1',
      request: request('A different fire'),
      idempotencyKey: 'key-d',
      replaceActive: true,
    });
    assert.equal(replaced.outcome, 'created');
    assert.notEqual(replaced.buildId, first.buildId);
    const old = await store.get(first.buildId!);
    assert.equal(old?.cancel_reason, 'replaced');
    assert.ok(old?.cancel_requested_at);

    release();
    const concurrent = harness({
      runners: {
        characters: async () => new Promise(() => undefined),
      },
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        concurrent.service.start({
          draftId: 'draft-race',
          userId: 'user-2',
          request: request(`Fire ${index}`),
          idempotencyKey: `race-${index}`,
        }),
      ),
    );
    assert.equal(results.filter((result) => result.outcome === 'created').length, 1);
    assert.equal(results.filter((result) => result.outcome === 'conflict').length, 9);
  });

  test('S12 the concurrency cap leaves the third build queued', async () => {
    const releases: Array<() => void> = [];
    const { service, store, calls } = harness({
      maxConcurrent: 2,
      runners: {
        characters: async (_input, ctx) => {
          calls.characters += 1;
          await new Promise<void>((resolve, reject) => {
            releases.push(resolve);
            ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
          });
          return charactersOut;
        },
      },
    });
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const started = await service.start({
        draftId: `draft-${index}`,
        userId: 'user-1',
        request: request(),
        idempotencyKey: `key-${index}`,
      });
      ids.push(started.buildId!);
    }
    assert.equal((await store.get(ids[0]!))?.status, 'running');
    assert.equal((await store.get(ids[1]!))?.status, 'running');
    assert.equal((await store.get(ids[2]!))?.status, 'queued');
    releases[0]?.();
    await waitFor(async () => (await store.get(ids[0]!))?.status === 'succeeded');
    await service.tick();
    await waitFor(async () => calls.characters === 3);
    assert.equal((await store.get(ids[2]!))?.status, 'running');
  });

  test('S13 sweep deletes old terminal builds and keeps active ones', async () => {
    const { service, store, clock } = harness();
    const finished = await service.start({
      draftId: 'draft-old',
      userId: 'user-1',
      request: request(),
      idempotencyKey: 'old',
    });
    await service.whenIdle();
    let hold: () => void = () => undefined;
    const active = harness({
      store,
      clock,
      runners: {
        characters: async () => {
          await new Promise<void>((resolve) => {
            hold = resolve;
          });
          return charactersOut;
        },
      },
    });
    const running = await active.service.start({
      draftId: 'draft-live',
      userId: 'user-1',
      request: request(),
      idempotencyKey: 'live',
    });
    clock.advance(8 * 24 * 60 * 60 * 1000);
    const removed = await service.sweep();
    assert.equal(removed, 1);
    assert.equal(await store.get(finished.buildId!), null);
    assert.equal((await store.get(running.buildId!))?.status, 'running');
    hold();
  });
});
