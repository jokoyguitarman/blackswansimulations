import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { canonicalJson } from '@shared/canonicalJson';
import { hashBuildRequest, makeBuildRequest } from '../src/lib/buildRequest';
import {
  buildCardFor,
  claimPollTick,
  classifyLatestFetch,
  classifyMutation,
  classifyPollStop,
  classifyReview,
  emptyPollState,
  mapToWizardStage,
  nextPollDelayMs,
  reducePoll,
  shouldClearIdempotencyKey,
  stageMark,
  type BuildLogLine,
  type BuildView,
  type PollState,
} from '../src/lib/buildStatus';

function line(seq: number, message: string): BuildLogLine {
  return { seq, stage: 'storyline', kind: 'progress', message, at: '2026-01-01T00:00:00.000Z' };
}

function view(patch: Partial<BuildView> = {}): BuildView {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    draft_id: '22222222-2222-4222-8222-222222222222',
    status: 'running',
    current_stage: 'storyline',
    stages: {
      characters: { status: 'done', attempts: 1 },
      storyline: { status: 'running', attempts: 1, error: 'The model is busy.' },
      convergence: { status: 'pending', attempts: 0 },
      pages: { status: 'pending', attempts: 0 },
    },
    error: null,
    error_code: null,
    cancel_reason: null,
    interruptions: 0,
    request_hash: 'abc',
    resumable: false,
    resume_from: 'storyline',
    compile: { status: null, scenario_id: null },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    finished_at: null,
    ...patch,
  };
}

describe('reducePoll', () => {
  test('F1 log lines dedupe by seq across overlapping polls', () => {
    const first = reducePoll(emptyPollState(), {
      type: 'poll_ok',
      log: [line(1, 'Characters started'), line(2, 'Characters ready')],
      nextAfter: 2,
    });
    const second = reducePoll(first, {
      type: 'poll_ok',
      log: [line(2, 'Characters ready'), line(3, 'Legal storyline ready (15 injects)')],
      nextAfter: 3,
    });
    assert.deepEqual(
      second.log.map((entry) => entry.seq),
      [1, 2, 3],
    );
    assert.equal(second.nextAfter, 3);
    assert.equal(second.log.filter((entry) => entry.seq === 2).length, 1);
  });

  test('F2 poll errors never fail the build and reconnecting clears on the next ok', () => {
    let state: PollState = emptyPollState();
    for (let n = 0; n < 10; n += 1) state = reducePoll(state, { type: 'poll_error' });
    assert.equal(state.consecutiveErrors, 10);
    assert.equal(state.reconnecting, true);
    assert.equal(state.log.length, 0);
    assert.equal('failure' in state, false);
    const recovered = reducePoll(state, {
      type: 'poll_ok',
      log: [line(4, 'still going')],
      nextAfter: 4,
    });
    assert.equal(recovered.reconnecting, false);
    assert.equal(recovered.consecutiveErrors, 0);
    assert.equal(recovered.log.length, 1);
    const one = reducePoll(emptyPollState(), { type: 'poll_error' });
    assert.equal(one.reconnecting, false);
    const two = reducePoll(one, { type: 'poll_error' });
    assert.equal(two.reconnecting, true);
  });

  test('a deploy blip is reconnecting immediately and backs off', () => {
    const once = reducePoll(emptyPollState(), { type: 'poll_error', transient: true });
    assert.equal(once.reconnecting, true);
    assert.equal(once.log.length, 0);
    assert.equal('failure' in once, false);
    assert.equal(nextPollDelayMs(0, false), 2000);
    assert.equal(nextPollDelayMs(1, false), 2000);
    assert.equal(nextPollDelayMs(2, false), 4000);
    assert.equal(nextPollDelayMs(3, false), 8000);
    assert.equal(nextPollDelayMs(6, false), 15000);
    assert.equal(nextPollDelayMs(2, true), 15000);
    const back = reducePoll(once, { type: 'poll_ok', log: [line(8, 'still going')], nextAfter: 8 });
    assert.equal(back.reconnecting, false);
    assert.equal(back.consecutiveErrors, 0);
  });
});

describe('buildCardFor', () => {
  test('F3 each status and cancel reason uses the section 6 wording', () => {
    const failed = buildCardFor(
      view({
        status: 'failed',
        error_code: 'stage_failed',
        resumable: true,
        current_stage: 'storyline',
        resume_from: 'storyline',
      }),
      'characters',
    );
    assert.equal(failed?.heading, 'The Storyline stage failed');
    assert.equal(
      failed?.body,
      'The model is busy. Retry continues from the Storyline stage; the stages before it are kept.',
    );
    assert.deepEqual(failed?.actions, ['retry', 'start_over']);
    assert.equal(failed?.primaryLabel, 'Retry from Storyline');

    const interrupted = buildCardFor(
      view({
        status: 'failed',
        error_code: 'interrupted_too_often',
        interruptions: 4,
        resumable: true,
        resume_from: 'storyline',
      }),
      'characters',
    );
    assert.equal(interrupted?.heading, 'The Storyline stage was interrupted repeatedly');
    assert.equal(
      interrupted?.body,
      'The server restarted 4 times while building. Retry continues from the Storyline stage.',
    );

    const paused = buildCardFor(
      view({
        status: 'paused',
        cancel_reason: 'unwatched',
        resumable: true,
        resume_from: 'convergence',
        current_stage: 'convergence',
      }),
      'storyline',
    );
    assert.equal(paused?.heading, 'Build paused');
    assert.equal(
      paused?.body,
      "Paused after the Storyline stage because this build wasn't open for 45 minutes, to save AI usage. Resume continues from the Convergence stage.",
    );
    assert.deepEqual(paused?.actions, ['resume', 'start_over']);

    const cancelled = buildCardFor(
      view({
        status: 'cancelled',
        cancel_reason: 'user',
        resumable: true,
        resume_from: 'storyline',
      }),
      'characters',
    );
    assert.equal(cancelled?.heading, 'Build cancelled');
    assert.equal(cancelled?.body, 'Resume continues from the Storyline stage, or start over.');

    assert.equal(
      buildCardFor(view({ status: 'cancelled', cancel_reason: 'replaced' }), null),
      null,
    );
    assert.equal(buildCardFor(view({ status: 'running' }), null), null);
    assert.equal(buildCardFor(view({ status: 'succeeded', current_stage: null }), null), null);

    const changed = buildCardFor(
      view({ status: 'failed', error_code: 'stage_failed', resumable: true }),
      'characters',
      { setupChanged: true },
    );
    const poisoned = buildCardFor(
      view({
        status: 'failed',
        error_code: 'interrupted_too_often',
        interruptions: 4,
        resumable: true,
        current_stage: 'storyline',
        resume_from: 'storyline',
        stages: {
          characters: { status: 'done', attempts: 1 },
          storyline: { status: 'failed', attempts: 1 },
          convergence: { status: 'pending', attempts: 0 },
          pages: { status: 'pending', attempts: 0 },
        },
      }),
      'characters',
    );
    assert.equal(poisoned?.heading, 'The Storyline stage was interrupted repeatedly');
    assert.equal(poisoned?.actions[0], 'retry');
    assert.equal(poisoned?.primaryLabel, 'Retry from Storyline');

    assert.equal(changed?.primaryLabel, 'Build again');
    assert.ok(changed?.body.includes('Setup changed since this build'));
    assert.deepEqual(changed?.actions, ['build_again', 'start_over']);
  });
});

describe('mapToWizardStage', () => {
  test('F4 each status maps onto the existing stage strip', () => {
    assert.deepEqual(mapToWizardStage(view({ status: 'queued', current_stage: 'characters' })), {
      buildStage: 'characters',
      buildError: null,
    });
    assert.deepEqual(mapToWizardStage(view({ status: 'running', current_stage: 'storyline' })), {
      buildStage: 'storyline',
      buildError: null,
    });
    assert.deepEqual(mapToWizardStage(view({ status: 'succeeded', current_stage: null })), {
      buildStage: 'done',
      buildError: null,
    });
    assert.deepEqual(mapToWizardStage(view({ status: 'failed', current_stage: 'storyline' })), {
      buildStage: 'storyline',
      buildError: 'storyline',
    });
    assert.deepEqual(
      mapToWizardStage(
        view({ status: 'paused', current_stage: 'convergence', resume_from: 'convergence' }),
      ),
      { buildStage: 'convergence', buildError: null },
    );
    assert.deepEqual(
      mapToWizardStage(view({ status: 'cancelled', current_stage: 'pages', resume_from: 'pages' })),
      { buildStage: 'pages', buildError: null },
    );
  });
});

describe('stageMark', () => {
  test('a requeued build keeps finished stages and continues the interrupted one', () => {
    const restarted = view({
      status: 'queued',
      current_stage: 'storyline',
      resume_from: 'storyline',
      stages: {
        characters: { status: 'done', attempts: 1 },
        storyline: { status: 'interrupted', attempts: 1 },
        convergence: { status: 'pending', attempts: 0 },
        pages: { status: 'pending', attempts: 0 },
      },
    });
    assert.equal(stageMark(restarted, 'characters'), 'done');
    assert.equal(stageMark(restarted, 'storyline'), 'continuing');
    assert.equal(stageMark(restarted, 'convergence'), 'queued');
    const claimed = view({
      ...restarted,
      status: 'running',
      stages: {
        ...restarted.stages,
        storyline: { status: 'running', attempts: 2 },
      },
    });
    assert.equal(stageMark(claimed, 'characters'), 'done');
    assert.equal(stageMark(claimed, 'storyline'), 'running');
  });
});

describe('deploy gap on the other build calls', () => {
  test('getLatestBuild, startBuild, getReview and resumeBuild retry 0/408/502-504', () => {
    for (const status of [0, 408, 502, 503, 504]) {
      assert.equal(classifyLatestFetch(status, false), 'retry');
      assert.equal(classifyMutation(status), 'retry');
      assert.equal(classifyReview(status, false), 'retry');
      assert.equal(shouldClearIdempotencyKey(status), false);
      assert.equal(classifyPollStop(status), null);
    }
  });

  test('a real answer clears the idempotency key and does not retry', () => {
    for (const status of [200, 202, 400, 401, 403, 409, 429, 500, 501]) {
      assert.equal(shouldClearIdempotencyKey(status), true);
      assert.equal(classifyMutation(status), 'settled');
    }
    assert.equal(classifyLatestFetch(501, false), 'unavailable');
    assert.equal(classifyLatestFetch(200, false), 'missing');
    assert.equal(classifyLatestFetch(200, true), 'ready');
    assert.equal(classifyReview(200, true), 'apply');
    assert.equal(classifyReview(500, false), 'failed');
  });

  test('polling stops on 404, 403 and 501, and a wake does not overlap a tick', () => {
    assert.equal(classifyPollStop(404), 'lost');
    assert.equal(classifyPollStop(403), 'denied');
    assert.equal(classifyPollStop(501), 'unavailable');
    assert.equal(classifyPollStop(502), null);
    assert.equal(claimPollTick(false), 'run');
    assert.equal(claimPollTick(true), 'queue');
  });
});

describe('hashBuildRequest', () => {
  test('matches the server hash and ignores key order', async () => {
    const request = makeBuildRequest({
      crisis_type: 'Plant fire',
      organisations: [{ display_name: 'Meridian', country: 'Singapore' }],
    });
    const reordered = { duration: 60, ...request, crisis_type: request.crisis_type };
    const hex = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
    assert.equal(await hashBuildRequest(request), hex(request));
    assert.equal(await hashBuildRequest(reordered), await hashBuildRequest(request));
    const extra = makeBuildRequest({
      crisis_type: 'Plant fire',
      organisations: [
        { display_name: 'Meridian', country: 'Singapore' },
        { display_name: 'Harbour', country: 'Malaysia' },
      ],
    });
    assert.notEqual(await hashBuildRequest(extra), await hashBuildRequest(request));
  });
});
