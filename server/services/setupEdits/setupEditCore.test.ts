import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { canonicalJson } from '../../../shared/canonicalJson.js';
import {
  canOpen,
  emptySetupBaselineHash,
  isSetupEditSchemaMissing,
  historyForViewer,
  openEditOf,
  remainingEdits,
} from './setupEditCore.js';

describe('setup edit allowance', () => {
  test('remaining counts, including a trainer who has used the limit', () => {
    assert.equal(remainingEdits(0, 3, false), 3);
    assert.equal(remainingEdits(2, 3, false), 1);
    assert.equal(remainingEdits(3, 3, false), 0);
    assert.equal(remainingEdits(4, 3, false), 0);
    assert.equal(canOpen(0, 3, false), true);
    assert.equal(canOpen(2, 3, false), true);
    assert.equal(canOpen(3, 3, false), false);
    assert.equal(canOpen(4, 3, false), false);
  });

  test('trainers do not receive abandoned or failed edits', () => {
    const rows = [
      { id: 'open', status: 'open' },
      { id: 'applied', status: 'applied' },
      { id: 'abandoned', status: 'abandoned' },
      { id: 'failed', status: 'failed' },
    ];
    assert.deepEqual(
      historyForViewer(rows, false).map((row) => row.id),
      ['open', 'applied'],
    );
    assert.deepEqual(
      historyForViewer(rows, true).map((row) => row.id),
      ['open', 'applied', 'abandoned', 'failed'],
    );
  });

  test('admins are unlimited', () => {
    assert.equal(remainingEdits(0, 3, true), null);
    assert.equal(remainingEdits(3, 3, true), null);
    assert.equal(remainingEdits(100, 0, true), null);
    assert.equal(canOpen(3, 3, true), true);
    assert.equal(canOpen(0, 0, true), true);
  });

  test('a limit of 0 leaves a trainer nothing to open', () => {
    assert.equal(remainingEdits(0, 0, false), 0);
    assert.equal(canOpen(0, 0, false), false);
    assert.equal(canOpen(0, 0, true), true);
  });

  test('canOpen agrees with a positive remaining count', () => {
    for (const [used, limit] of [
      [0, 3],
      [2, 3],
      [3, 3],
      [0, 0],
      [1, 0],
    ] as const) {
      assert.equal(canOpen(used, limit, false), remainingEdits(used, limit, false) !== 0);
    }
  });

  test('the in-flight edit is the open or applying row', () => {
    const edits = [
      { id: 'new', status: 'applied' },
      { id: 'open', status: 'open' },
    ];
    assert.equal(openEditOf(edits)?.id, 'open');
    assert.equal(openEditOf([{ id: 'done', status: 'abandoned' }]), null);
    assert.equal(openEditOf([{ id: 'busy', status: 'applying' }])?.id, 'busy');
  });

  test('schema-missing codes are recognised and other errors are not', () => {
    for (const code of ['42P01', '42703', '42883', 'PGRST202', 'PGRST204', 'PGRST205']) {
      assert.equal(isSetupEditSchemaMissing({ code }), true);
    }
    assert.equal(isSetupEditSchemaMissing({ code: '23505' }), false);
    assert.equal(isSetupEditSchemaMissing(new Error('nope')), false);
    assert.equal(isSetupEditSchemaMissing(null), false);
  });

  test('the empty baseline hash is SHA-256 of canonical {}', () => {
    assert.equal(canonicalJson({}), '{}');
    assert.equal(
      emptySetupBaselineHash(),
      '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
  });
});

describe('setup edit count stays in SQL', () => {
  const sql = readFileSync(
    new URL('../../../migrations/274_scenario_setup_edits.sql', import.meta.url),
    'utf8',
  );
  const service = readFileSync(new URL('./setupEditService.ts', import.meta.url), 'utf8');
  const route = readFileSync(
    new URL('../../routes/scenarioSetupEdits.ts', import.meta.url),
    'utf8',
  );

  test('the migration stores the empty baseline hash and does not touch later migrations', () => {
    assert.match(sql, new RegExp(emptySetupBaselineHash()));
    assert.match(sql, /NOT APPLIED/);
    assert.doesNotMatch(
      sql,
      /inject_deliveries|inject_responses|sim_calls|session_role_assignments|escalation_chains|stakeholder_moods/,
    );
  });

  test('only count_scenario_setup_edit writes setup_edits_used', () => {
    const openAt = sql.indexOf('FUNCTION public.open_scenario_setup_edit');
    const countAt = sql.indexOf('FUNCTION public.count_scenario_setup_edit');
    assert.ok(openAt > 0 && countAt > openAt);
    const openFn = sql.slice(openAt, countAt);
    const countFn = sql.slice(countAt);
    assert.doesNotMatch(openFn, /setup_edits_used\s*=/);
    assert.match(countFn, /setup_edits_used\s*=\s*setup_edits_used\s*\+\s*1/);
    assert.match(countFn, /counted\s*=\s*false/);
    assert.match(countFn, /counted\s*=\s*true/);

    for (const src of [service, route]) {
      assert.doesNotMatch(src, /setup_edits_used\s*=/);
      assert.doesNotMatch(src, /setup_edits_used\s*\+/);
      assert.doesNotMatch(src, /count_scenario_setup_edit/);
    }
    assert.match(service, /open_scenario_setup_edit/);
    assert.match(service, /status:\s*'abandoned'/);
  });
});
