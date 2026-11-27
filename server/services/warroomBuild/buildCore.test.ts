import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  PAGES_SKIP_WARNING,
  canonicalHash,
  charactersReadyLine,
  classifyStageError,
  formatProgress,
  initialStageStates,
  markDone,
  markFailed,
  markInterrupted,
  markRunning,
  markSkipped,
  nextStage,
  resetForResume,
  restartLine,
  stageStartedLine,
  stakeholdersReadyLine,
  toView,
} from './buildCore.js';
import {
  buildRequestSchema,
  type BuildRow,
  type BuildStage,
  type StageStates,
} from './buildTypes.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:00:01.500Z';

function org(name: string) {
  return {
    display_name: name,
    country: 'Singapore',
    is_primary: true,
    team_roster: [{ team_name: 'Communications' }],
  };
}

describe('C1 nextStage', () => {
  test('follows the order, skips done and skipped, and returns null when all are complete', () => {
    const states = initialStageStates();
    assert.equal(nextStage(states), 'characters');

    states.characters = { status: 'done', attempts: 1 };
    assert.equal(nextStage(states), 'storyline');

    states.storyline = { status: 'skipped', attempts: 1 };
    assert.equal(nextStage(states), 'convergence');

    states.convergence = { status: 'failed', attempts: 1 };
    assert.equal(nextStage(states), 'convergence');

    states.convergence = { status: 'done', attempts: 1 };
    states.pages = { status: 'skipped', attempts: 1 };
    assert.equal(nextStage(states), null);
  });
});

describe('C2 markRunning', () => {
  test('increments attempts and sets started_at without mutating its input', () => {
    const input = initialStageStates();
    input.storyline = { status: 'pending', attempts: 1 };
    const frozen = structuredClone(input);
    const out = markRunning(input, 'storyline', T0);
    assert.equal(out.storyline.status, 'running');
    assert.equal(out.storyline.attempts, 2);
    assert.equal(out.storyline.started_at, T0);
    assert.equal(out.characters.status, 'pending');
    assert.equal(out.characters.attempts, 0);
    out.storyline.attempts = 99;
    out.characters.status = 'failed';
    assert.deepEqual(input, frozen);
  });
});

describe('C3 markFailed and markInterrupted', () => {
  test('touch only the named stage', () => {
    const running = markRunning(markDone(initialStageStates(), 'characters', T1), 'storyline', T0);
    const failed = markFailed(running, 'storyline', 'boom', T1);
    assert.equal(failed.storyline.status, 'failed');
    assert.equal(failed.storyline.error, 'boom');
    assert.equal(failed.storyline.ms, 1500);
    assert.deepEqual(failed.characters, running.characters);
    assert.deepEqual(failed.convergence, running.convergence);
    assert.deepEqual(failed.pages, running.pages);
    assert.equal(running.storyline.status, 'running');

    const interrupted = markInterrupted(running, 'storyline', T1);
    assert.equal(interrupted.storyline.status, 'interrupted');
    assert.equal(interrupted.storyline.error, undefined);
    assert.deepEqual(interrupted.characters, running.characters);
    assert.deepEqual(interrupted.convergence, running.convergence);
    assert.deepEqual(interrupted.pages, running.pages);
    assert.notEqual(interrupted.characters, running.characters);
  });
});

describe('C4 resetForResume', () => {
  test('turns failed and interrupted into pending and keeps done and skipped', () => {
    const states: StageStates = {
      characters: { status: 'done', attempts: 1, ms: 10, started_at: T0, finished_at: T1 },
      storyline: { status: 'failed', attempts: 2, error: 'rate limit', started_at: T0 },
      convergence: { status: 'interrupted', attempts: 1, started_at: T0 },
      pages: { status: 'skipped', attempts: 1, error: PAGES_SKIP_WARNING },
    };
    const reset = resetForResume(states);
    assert.deepEqual(reset.characters, states.characters);
    assert.deepEqual(reset.pages, states.pages);
    assert.deepEqual(reset.storyline, { status: 'pending', attempts: 2 });
    assert.deepEqual(reset.convergence, { status: 'pending', attempts: 1 });
    assert.equal(states.storyline.status, 'failed');
  });
});

describe('C5 canonicalHash', () => {
  test('is stable under key reordering and undefined fields, and changes when an organisation is added', () => {
    const base = {
      crisis_type: 'Plant fire',
      context: undefined,
      organisations: [org('Meridian')],
      auto_antagonist: true,
    };
    const reordered = {
      auto_antagonist: true,
      organisations: [
        {
          team_roster: [{ team_name: 'Communications' }],
          is_primary: true,
          country: 'Singapore',
          display_name: 'Meridian',
        },
      ],
      crisis_type: 'Plant fire',
    };
    assert.equal(canonicalHash(base), canonicalHash(reordered));
    const added = {
      ...reordered,
      organisations: [
        ...reordered.organisations,
        { ...org('Meridian Malaysia'), is_primary: false },
      ],
    };
    assert.notEqual(canonicalHash(base), canonicalHash(added));
    const parsed = buildRequestSchema.parse({
      crisis_type: 'Plant fire',
      organisations: [org('Meridian')],
    });
    assert.equal(canonicalHash(parsed), canonicalHash({ ...parsed }));
  });
});

describe('C6 formatProgress', () => {
  test('yields the §5.4 strings and drops heartbeats', () => {
    assert.equal(formatProgress({ type: 'heartbeat' }), null);
    assert.equal(
      formatProgress({ type: 'progress', message: 'Preparing charters' }),
      'Preparing charters',
    );
    assert.equal(
      formatProgress({
        type: 'org_progress',
        org_key: 'org_my',
        stage: 'charters',
        detail: '3 teams',
      }),
      '[org_my] charters ready — 3 teams',
    );
    assert.equal(
      formatProgress({ type: 'org_progress', org_key: 'org_my', stage: 'cast', detail: '' }),
      '[org_my] cast ready',
    );
    assert.equal(
      formatProgress({ type: 'team_complete', team: 'Legal', inject_count: 15 }),
      'Legal storyline ready (15 injects)',
    );
    assert.equal(formatProgress({ type: 'complete' }), null);
    assert.equal(charactersReadyLine(40), '40 characters and a fact sheet ready');
    assert.equal(
      stakeholdersReadyLine(6, 2),
      '6 stakeholder contacts created (2 with a live concern)',
    );
    assert.equal(stageStartedLine('characters', 1), 'Characters started');
    assert.equal(stageStartedLine('storyline', 2), 'Storyline started (attempt 2)');
    assert.equal(
      restartLine('storyline'),
      'The server is restarting — the build will continue from the Storyline stage.',
    );
    assert.equal(
      PAGES_SKIP_WARNING,
      'Organisation pages could not be generated — the scenario compiles without them.',
    );
  });
});

describe('C7 toView', () => {
  const unfinished: StageStates = {
    characters: { status: 'done', attempts: 1, ms: 10 },
    storyline: { status: 'failed', attempts: 1, error: 'nope' },
    convergence: { status: 'pending', attempts: 0 },
    pages: { status: 'pending', attempts: 0 },
  };

  function row(
    status: BuildRow['status'],
    cancel: BuildRow['cancel_reason'],
    states = unfinished,
  ): BuildRow {
    return {
      id: 'build-1',
      draft_id: 'draft-1',
      created_by: 'user-1',
      pool: 'dev',
      status,
      current_stage: 'storyline',
      stage_states: states,
      request: buildRequestSchema.parse({
        crisis_type: 'Plant fire',
        organisations: [org('Meridian')],
      }),
      request_hash: 'abc',
      idempotency_key: 'key-1',
      error: status === 'failed' ? 'nope' : null,
      error_code: status === 'failed' ? 'stage_failed' : null,
      cancel_requested_at: cancel ? T0 : null,
      cancel_reason: cancel,
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
      interruptions: 0,
      last_seen_at: T0,
      log_count: 0,
      compile_status: null,
      compile_heartbeat_at: null,
      credit_ledger_id: null,
      credit_invoice_id: null,
      scenario_id: null,
      started_at: T0,
      finished_at: null,
      created_at: T0,
      updated_at: T0,
    };
  }

  test('resumable and resume_from are correct for each status and cancel reason', () => {
    const cases: Array<{
      status: BuildRow['status'];
      cancel: BuildRow['cancel_reason'];
      resumable: boolean;
      resume_from: BuildStage | null;
    }> = [
      { status: 'queued', cancel: null, resumable: false, resume_from: null },
      { status: 'running', cancel: null, resumable: false, resume_from: null },
      { status: 'succeeded', cancel: null, resumable: false, resume_from: null },
      { status: 'paused', cancel: null, resumable: true, resume_from: 'storyline' },
      { status: 'paused', cancel: 'unwatched', resumable: true, resume_from: 'storyline' },
      { status: 'failed', cancel: null, resumable: true, resume_from: 'storyline' },
      { status: 'failed', cancel: 'user', resumable: true, resume_from: 'storyline' },
      { status: 'cancelled', cancel: 'user', resumable: true, resume_from: 'storyline' },
      { status: 'cancelled', cancel: 'replaced', resumable: false, resume_from: null },
      { status: 'paused', cancel: 'replaced', resumable: false, resume_from: null },
      { status: 'failed', cancel: 'replaced', resumable: false, resume_from: null },
    ];
    for (const entry of cases) {
      const view = toView(row(entry.status, entry.cancel));
      assert.equal(view.resumable, entry.resumable, `${entry.status}/${entry.cancel}`);
      assert.equal(view.resume_from, entry.resume_from, `${entry.status}/${entry.cancel}`);
    }

    const done: StageStates = {
      characters: { status: 'done', attempts: 1 },
      storyline: { status: 'done', attempts: 1 },
      convergence: { status: 'done', attempts: 1 },
      pages: { status: 'skipped', attempts: 1 },
    };
    const finished = toView(row('failed', null, done));
    assert.equal(finished.resumable, true);
    assert.equal(finished.resume_from, null);
    assert.equal(finished.stages.storyline.error, undefined);
    assert.deepEqual(finished.compile, { status: null, scenario_id: null });
  });
});

describe('classifyStageError', () => {
  test('uses the legacy rate-limit wording with the stage label', () => {
    const classified = classifyStageError({ status: 429, message: 'slow down' }, 'storyline');
    assert.equal(classified.error_code, 'stage_failed');
    assert.equal(
      classified.error,
      'The AI provider rate-limited the Storyline stage — the server is busy (a live session shares the same quota). Wait a minute and retry.',
    );
  });
});

describe('markSkipped', () => {
  test('sets skipped and the warning on the named stage only', () => {
    const running = markRunning(initialStageStates(), 'pages', T0);
    const skipped = markSkipped(running, 'pages', PAGES_SKIP_WARNING, T1);
    assert.equal(skipped.pages.status, 'skipped');
    assert.equal(skipped.pages.error, PAGES_SKIP_WARNING);
    assert.equal(skipped.characters.status, 'pending');
    assert.equal(running.pages.status, 'running');
  });
});
