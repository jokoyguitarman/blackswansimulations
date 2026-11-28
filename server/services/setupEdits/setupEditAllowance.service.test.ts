import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { SETUP_EDIT_HISTORY_LIMIT } from './setupEditCore.js';
import { listSetupEditAllowances } from './setupEditService.js';

const TRAINER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const OWN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FOREIGN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FIELD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const SCENARIOS = [
  { id: OWN, setup_edits_used: 1, created_by: TRAINER, category: 'social_media_crisis' },
  { id: FOREIGN, setup_edits_used: 2, created_by: OTHER, category: 'social_media_crisis' },
  { id: FIELD, setup_edits_used: 0, created_by: TRAINER, category: 'terrorism' },
];

const EDITS = [
  {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    scenario_id: OWN,
    opened_by: null,
    opened_by_admin: false,
    status: 'applied',
    edit_number: 1,
    counted: true,
    error: null,
    created_at: '2026-02-01T00:00:00.000Z',
    applied_at: '2026-02-01T00:00:00.000Z',
    draft_id: null,
    applied_summary: null,
  },
  {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    scenario_id: FOREIGN,
    opened_by: null,
    opened_by_admin: false,
    status: 'applied',
    edit_number: 1,
    counted: true,
    error: null,
    created_at: '2026-02-02T00:00:00.000Z',
    applied_at: '2026-02-02T00:00:00.000Z',
    draft_id: null,
    applied_summary: null,
  },
];

interface Recorded {
  table: string;
  ops: Array<{ name: string; args: unknown[] }>;
}

const originalFrom = supabaseAdmin.from;
let calls: Recorded[] = [];

function install(): void {
  calls = [];
  supabaseAdmin.from = ((table: string) => {
    const call: Recorded = { table, ops: [] };
    calls.push(call);
    const query: Record<string, unknown> = {};
    const note = (name: string) => (...args: unknown[]) => {
      call.ops.push({ name, args });
      return query;
    };
    query.select = note('select');
    query.eq = note('eq');
    query.in = note('in');
    query.order = note('order');
    query.limit = note('limit');
    query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(answer(call)).then(resolve, reject);
    return query;
  }) as typeof supabaseAdmin.from;
}

function answer(call: Recorded): { data: unknown; error: null } {
  if (call.table === 'scenarios') {
    const ids = call.ops.find((op) => op.name === 'in')?.args[1];
    const wanted = new Set(Array.isArray(ids) ? ids : []);
    return { data: SCENARIOS.filter((row) => wanted.has(row.id)), error: null };
  }
  if (call.table === 'scenario_setup_edits') {
    const scenarioId = call.ops.find((op) => op.name === 'eq' && op.args[0] === 'scenario_id')
      ?.args[1];
    return { data: EDITS.filter((row) => row.scenario_id === scenarioId), error: null };
  }
  return { data: [], error: null };
}

afterEach(() => {
  supabaseAdmin.from = originalFrom;
});

describe('listSetupEditAllowances', () => {
  test('a trainer only receives social scenarios they created, one limited read each', async () => {
    const previous = logger.level;
    logger.level = 'silent';
    install();
    try {
      const trainer = await listSetupEditAllowances([OWN, FOREIGN, FIELD], {
        id: TRAINER,
        role: 'trainer',
      });
      assert.equal(trainer.available, true);
      if (!trainer.available) return;
      assert.deepEqual(Object.keys(trainer.byId), [OWN]);
      assert.equal(trainer.byId[OWN]?.used, 1);
      assert.equal(trainer.byId[OWN]?.edits.length, 1);
      assert.equal(trainer.byId[FOREIGN], undefined);
      assert.equal(trainer.byId[FIELD], undefined);

      const admin = await listSetupEditAllowances([OWN, FOREIGN, FIELD], {
        id: OTHER,
        role: 'admin',
      });
      assert.equal(admin.available, true);
      if (!admin.available) return;
      assert.deepEqual(Object.keys(admin.byId).sort(), [OWN, FOREIGN]);
      assert.equal(admin.byId[FIELD], undefined);

      const history = calls.filter((call) => call.table === 'scenario_setup_edits');
      assert.equal(history.length, 3);
      for (const call of history) {
        assert.equal(
          call.ops.some((op) => op.name === 'in' && op.args[0] === 'scenario_id'),
          false,
        );
        const limited = call.ops.find((op) => op.name === 'limit');
        assert.equal(limited?.args[0], SETUP_EDIT_HISTORY_LIMIT);
        const scenarioId = call.ops.find((op) => op.name === 'eq')?.args[1];
        assert.equal(scenarioId === FIELD, false);
      }
      assert.deepEqual(
        history.map((call) => call.ops.find((op) => op.name === 'eq')?.args[1]).sort(),
        [OWN, OWN, FOREIGN],
      );
    } finally {
      logger.level = previous;
    }
  });
});
