import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LOG_TRUNCATED } from './buildStore.js';
import { MemoryBuildStore } from './buildStore.js';
import { buildRequestSchema, type BuildRequest } from './buildTypes.js';
import { ManualClock } from './buildService.js';
import { canonicalHash } from './buildCore.js';

function request(crisis = 'Plant fire'): BuildRequest {
  return buildRequestSchema.parse({
    crisis_type: crisis,
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

function args(clock: ManualClock, patch: Record<string, unknown> = {}) {
  const req = (patch.request as BuildRequest) ?? request();
  return {
    draftId: 'draft-1',
    userId: 'user-1',
    pool: 'pool-a',
    idempotencyKey: 'key-1',
    replaceActive: false,
    maxActivePerUser: 10,
    ...patch,
    request: (patch.request as BuildRequest) ?? req,
    requestHash: canonicalHash((patch.request as BuildRequest) ?? req),
  };
}

describe('MemoryBuildStore matches the migration 267 functions', () => {
  test('claim takes the oldest queued build and ignores a live lease', async () => {
    const clock = new ManualClock();
    const store = new MemoryBuildStore(() => clock.now());
    const first = await store.start(args(clock, { idempotencyKey: 'a', draftId: 'd1' }));
    clock.advance(1000);
    const second = await store.start(args(clock, { idempotencyKey: 'b', draftId: 'd2' }));
    const claimed = await store.claim('pool-a', 'instance-a', 60);
    assert.equal(claimed?.id, first.buildId);
    assert.equal(claimed?.status, 'running');
    assert.ok(claimed?.lease_token);
    assert.equal(claimed?.interruptions, 0);
    const other = await store.claim('pool-a', 'instance-b', 60);
    assert.equal(other?.id, second.buildId);
    const none = await store.claim('pool-a', 'instance-c', 60);
    assert.equal(none, null);
    const again = await store.claim('pool-a', 'instance-c', 60);
    assert.equal(again, null);
  });

  test('an expired running lease is reclaimed and interruptions increment', async () => {
    const clock = new ManualClock();
    const store = new MemoryBuildStore(() => clock.now());
    const started = await store.start(args(clock));
    const first = await store.claim('pool-a', 'instance-a', 60);
    assert.ok(first?.lease_token);
    clock.advance(61_000);
    const second = await store.claim('pool-a', 'instance-b', 60);
    assert.equal(second?.id, started.buildId);
    assert.equal(second?.interruptions, 1);
    assert.notEqual(second?.lease_token, first?.lease_token);
    assert.equal(second?.lease_owner, 'instance-b');
  });

  test('completeStage and renew honour the lease token', async () => {
    const clock = new ManualClock();
    const store = new MemoryBuildStore(() => clock.now());
    await store.start(args(clock));
    const claimed = await store.claim('pool-a', 'instance-a', 60);
    const token = claimed!.lease_token!;
    assert.equal(await store.renewLease(claimed!.id, 'other-token', 60), 'lost');
    assert.equal(await store.renewLease(claimed!.id, token, 60), 'ok');
    const states = claimed!.stage_states;
    assert.equal(
      await store.completeStage({
        buildId: claimed!.id,
        leaseToken: 'other-token',
        stage: 'characters',
        attempt: 1,
        output: { personas: [] },
        stageStates: states,
        nextStage: 'storyline',
        finalStatus: null,
      }),
      false,
    );
    assert.deepEqual(await store.getOutputs(claimed!.id), {});
    assert.equal(
      await store.completeStage({
        buildId: claimed!.id,
        leaseToken: token,
        stage: 'characters',
        attempt: 1,
        output: { personas: [{ handle: 'ada' }] },
        stageStates: states,
        nextStage: 'storyline',
        finalStatus: null,
      }),
      true,
    );
    const outputs = await store.getOutputs(claimed!.id);
    assert.deepEqual(outputs.characters, { personas: [{ handle: 'ada' }] });
    const row = await store.get(claimed!.id);
    assert.equal(row?.current_stage, 'storyline');
    assert.equal(row?.lease_token, token);
    await store.requestCancel(claimed!.id, 'user');
    assert.equal(await store.renewLease(claimed!.id, token, 60), 'cancel_requested');
  });

  test('claim finalises a cancel-requested build whose owner is gone', async () => {
    const clock = new ManualClock();
    const store = new MemoryBuildStore(() => clock.now());
    const queued = await store.start(args(clock, { draftId: 'queued', idempotencyKey: 'q' }));
    await store.requestCancel(queued.buildId!, 'user');
    clock.advance(1000);
    await store.start(args(clock, { draftId: 'running', idempotencyKey: 'r' }));
    const running = await store.claim('pool-a', 'instance-a', 60);
    assert.notEqual(running?.id, queued.buildId);
    await store.requestCancel(running!.id, 'user');
    clock.advance(61_000);
    const next = await store.claim('pool-a', 'instance-b', 60);
    assert.equal(next, null);
    const queuedRow = await store.get(queued.buildId!);
    const runningRow = await store.get(running!.id);
    assert.equal(queuedRow?.status, 'cancelled');
    assert.equal(runningRow?.status, 'cancelled');
    assert.equal(runningRow?.lease_token, null);
    const untouched = await store.start(
      args(clock, { draftId: 'other', idempotencyKey: 'o', pool: 'pool-b' }),
    );
    await store.requestCancel(untouched.buildId!, 'user');
    await store.claim('pool-a', 'instance-b', 60);
    assert.equal((await store.get(untouched.buildId!))?.status, 'queued');
  });

  test('the log keeps 500 lines and then says it was truncated', async () => {
    const store = new MemoryBuildStore();
    const started = await store.start(args(new ManualClock()));
    const id = started.buildId!;
    await store.appendLog(
      id,
      Array.from({ length: 520 }, (_, index) => ({
        stage: 'storyline',
        kind: 'progress' as const,
        message: `line ${index}`,
      })),
    );
    const log = await store.listLog(id, 0, 600);
    assert.equal(log.length, 500);
    assert.equal(log[499]?.message, LOG_TRUNCATED);
    assert.equal(log[498]?.message, 'line 498');
    const extra = await store.appendLog(id, [
      { stage: 'storyline', kind: 'progress', message: 'later' },
    ]);
    assert.deepEqual(extra, []);
  });
});
