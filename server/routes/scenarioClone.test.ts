import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { validate } from '../lib/validation.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import {
  cloneScenario,
  type CloneDb,
  type ClonePayload,
  type CloneQuery,
} from '../services/scenarioClone/cloneScenario.js';
import { cloneScenarioSchema, handleCloneScenario } from './scenarioClone.js';

const SOURCE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TRAINER = '11111111-1111-4111-8111-111111111111';
const PLAYER = '44444444-4444-4444-8444-444444444444';

interface FailRule {
  table: string;
  column: string;
  remaining: number;
}

class MemoryQuery implements CloneQuery {
  private mode: 'select' | 'insert' | 'update' = 'select';
  private filters: Array<{ kind: 'eq' | 'is'; column: string; value: unknown }> = [];
  private payload: unknown;

  constructor(
    private readonly db: MemoryDb,
    private readonly table: string,
  ) {}

  select(): this {
    return this;
  }

  insert(values: unknown): this {
    this.mode = 'insert';
    this.payload = values;
    return this;
  }

  update(values: Record<string, unknown>): this {
    this.mode = 'update';
    this.payload = values;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ kind: 'eq', column, value });
    return this;
  }

  is(column: string, value: null): this {
    this.filters.push({ kind: 'is', column, value });
    return this;
  }

  then<TResult1 = ClonePayload, TResult2 = never>(
    onFulfilled?: ((value: ClonePayload) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute('many')).then(onFulfilled, onRejected);
  }

  single(): Promise<ClonePayload> {
    return Promise.resolve(this.execute('one'));
  }

  maybeSingle(): Promise<ClonePayload> {
    return Promise.resolve(this.execute('maybe'));
  }

  private matches(row: Record<string, unknown>): boolean {
    return this.filters.every((filter) => {
      if (filter.kind === 'eq') return row[filter.column] === filter.value;
      return row[filter.column] == null;
    });
  }

  private execute(cardinality: 'many' | 'one' | 'maybe'): ClonePayload {
    const table = this.db.rows(this.table);
    if (this.mode === 'insert') {
      const fail = this.db.fail;
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload];
      if (
        fail &&
        fail.table === this.table &&
        fail.remaining > 0 &&
        incoming.some((row) => row && typeof row === 'object' && fail.column in (row as object))
      ) {
        fail.remaining -= 1;
        return {
          data: null,
          error: {
            code: '42703',
            message: `column "${fail.column}" of relation "${this.table}" does not exist`,
          },
        };
      }
      const stored = incoming.map((row) => {
        const copy = structuredClone(row) as Record<string, unknown>;
        if (typeof copy.id !== 'string') copy.id = randomUUID();
        return copy;
      });
      table.push(...stored);
      this.db.inserts.push(this.table);
      const data = cardinality === 'many' ? stored : stored[0];
      return { data, error: null };
    }

    const found = table.filter((row) => this.matches(row));
    if (this.mode === 'update') {
      const patch = structuredClone(this.payload) as Record<string, unknown>;
      for (const row of found) Object.assign(row, patch);
      return { data: structuredClone(found), error: null };
    }
    if (cardinality === 'many') return { data: structuredClone(found), error: null };
    if (found.length !== 1) {
      if (cardinality === 'maybe' && found.length === 0) return { data: null, error: null };
      return {
        data: null,
        error: {
          code: 'PGRST116',
          message: 'JSON object requested, multiple (or no) rows returned',
        },
      };
    }
    return { data: structuredClone(found[0]), error: null };
  }
}

class MemoryDb implements CloneDb {
  readonly tables = new Map<string, Record<string, unknown>[]>();
  readonly inserts: string[] = [];
  readonly rpcCalls: Array<Record<string, unknown>> = [];
  rpcMode:
    { kind: 'ok' } | { kind: 'schema'; code: string } | { kind: 'empty' } | { kind: 'constraint' } =
    {
      kind: 'schema',
      code: '42883',
    };
  fail: FailRule | null = null;

  rows(table: string): Record<string, unknown>[] {
    let bucket = this.tables.get(table);
    if (!bucket) {
      bucket = [];
      this.tables.set(table, bucket);
    }
    return bucket;
  }

  from(table: string): CloneQuery {
    return new MemoryQuery(this, table);
  }

  rpc(fn: string, args: Record<string, unknown>): Promise<ClonePayload> {
    this.rpcCalls.push({ fn, ...args });
    if (this.rpcMode.kind === 'schema') {
      return Promise.resolve({
        data: null,
        error: {
          code: this.rpcMode.code,
          message: `clone_scenario unavailable (${this.rpcMode.code})`,
        },
      });
    }
    if (this.rpcMode.kind === 'constraint') {
      return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } });
    }
    if (this.rpcMode.kind === 'empty') return Promise.resolve({ data: null, error: null });
    const source = this.rows('scenarios').find((row) => row.id === args.p_scenario_id);
    if (!source) return Promise.resolve({ data: null, error: null });
    const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    this.rows('scenarios').push({
      id,
      title: args.p_title,
      initial_state: structuredClone(source.initial_state),
      is_active: false,
      created_by: args.p_user_id,
    });
    return Promise.resolve({ data: id, error: null });
  }
}

function seed(db: MemoryDb): void {
  db.rows('scenarios').push({
    id: SOURCE,
    title: 'Harbour leak',
    description: 'A tank farm post is spreading',
    category: 'social_media_crisis',
    difficulty: 'advanced',
    duration_minutes: 90,
    objectives: ['contain'],
    initial_state: {
      orgs: [{ org_key: 'primary', display_name: 'Harbour Co' }],
      org_page: { orgs: [{ org_key: 'primary', display_name: 'Harbour Co' }] },
    },
    briefing: 'Hold the line',
    blueprint: { lanes: 2 },
    setup_edits_used: 2,
    role_specific_briefs: {},
  });
  db.rows('scenario_teams').push(
    {
      id: 'team-live',
      scenario_id: SOURCE,
      team_uid: 'uid-press',
      team_name: 'Press Desk',
      charter: { mission: 'Inform' },
      org_key: 'primary',
      function_key: 'comms',
      valid_from: '2020-01-01T00:00:00.000Z',
      retired_at: null,
      retired_by_edit: null,
      superseded_by: null,
    },
    {
      id: 'team-old',
      scenario_id: SOURCE,
      team_uid: 'uid-old',
      team_name: 'Press Desk (old)',
      valid_from: '2019-01-01T00:00:00.000Z',
      retired_at: '2025-06-01T00:00:00.000Z',
      retired_by_edit: 'edit-1',
      superseded_by: 'team-live',
    },
  );
  const escalation = {
    max_steps: 2,
    scope: 'per_team',
    stop_on: 'any_response',
    steps: [{ after_minutes: 5, urgency: 'follow_up' }],
  };
  const mood = { recovery: 'none', rungs: [{ id: 'calm' }] };
  db.rows('scenario_injects').push(
    {
      id: 'inject-live',
      scenario_id: SOURCE,
      session_id: null,
      retired_at: null,
      retired_by_edit: 'edit-stale',
      superseded_by: 'inject-should-not-carry',
      valid_from: '2020-01-01T00:00:00.000Z',
      title: 'Tank photo',
      content: 'A photo is circulating',
      type: 'social_post',
      conditions_to_appear: { all: ['sentiment_below_30'] },
      conditions_to_cancel: ['inject_fired:correction'],
      eligible_after_minutes: 12,
      generation_source: 'war_room',
      required_gate_id: 'gate-source',
      required_gate_not_met_id: 'gate-source-not-met',
      state_effect: { social_state: { sentiment: -1 } },
      delivery_config: {
        app: 'social_feed',
        inject_key: 'harbour_post',
        escalation,
        mood_ladder: mood,
      },
    },
    {
      id: 'inject-retired',
      scenario_id: SOURCE,
      session_id: null,
      retired_at: '2025-06-01T00:00:00.000Z',
      title: 'Retired post',
      delivery_config: { inject_key: 'retired_post' },
    },
    {
      id: 'inject-runtime',
      scenario_id: SOURCE,
      session_id: 'session-9',
      retired_at: null,
      title: 'Runtime copy',
      delivery_config: { inject_key: 'runtime_post' },
    },
  );
  db.rows('scenario_objectives').push(
    {
      id: 'obj-live',
      scenario_id: SOURCE,
      objective_id: 'contain',
      objective_name: 'Contain',
      retired_at: null,
    },
    {
      id: 'obj-old',
      scenario_id: SOURCE,
      objective_id: 'old',
      objective_name: 'Old',
      retired_at: '2025-01-01T00:00:00.000Z',
    },
  );
  db.rows('sop_definitions').push({
    id: 'sop-1',
    scenario_id: SOURCE,
    sop_name: 'Holding statement',
    steps: [{ id: 'draft' }],
  });
  db.rows('scenario_hazards').push(
    {
      id: 'hazard-parent',
      scenario_id: SOURCE,
      session_id: null,
      hazard_type: 'fire',
      parent_pin_id: null,
    },
    {
      id: 'hazard-child',
      scenario_id: SOURCE,
      session_id: null,
      hazard_type: 'smoke',
      parent_pin_id: 'hazard-parent',
    },
    {
      id: 'hazard-live',
      scenario_id: SOURCE,
      session_id: 'session-9',
      hazard_type: 'runtime',
      parent_pin_id: null,
    },
  );
  db.rows('scenario_casualties').push(
    {
      id: 'casualty-1',
      scenario_id: SOURCE,
      session_id: null,
      casualty_type: 'patient',
      parent_pin_id: 'hazard-parent',
    },
    { id: 'casualty-live', scenario_id: SOURCE, session_id: 'session-9', casualty_type: 'crowd' },
  );
  db.rows('scenario_equipment').push({
    id: 'equip-1',
    scenario_id: SOURCE,
    equipment_type: 'extinguisher',
    label: 'Foam',
  });
  db.rows('scenario_floor_plans').push({
    id: 'floor-1',
    scenario_id: SOURCE,
    floor_level: 'G',
    floor_label: 'Ground',
  });
  db.rows('rts_scene_configs').push({
    id: 'scene-1',
    scenario_id: SOURCE,
    name: 'Tank farm',
    building_polygon: [],
    created_by: 'author-1',
  });
  db.rows('scenario_setup_edits').push({ id: 'edit-1', scenario_id: SOURCE, status: 'applied' });
  db.rows('sessions').push({ id: 'session-9', scenario_id: SOURCE, status: 'completed' });
}

describe('POST /api/scenarios/:id/clone', { concurrency: false }, () => {
  const db = new MemoryDb();
  let server: Server;
  let base: string;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.post(
      '/api/scenarios/:id/clone',
      (req, _res, next) => {
        const role = req.header('x-role');
        if (role) {
          (req as AuthenticatedRequest).user = {
            id: req.header('x-user') || TRAINER,
            role,
          };
        }
        next();
      },
      validate(cloneScenarioSchema),
      (req, res) => {
        void handleCloneScenario(req as AuthenticatedRequest, res, db);
      },
    );
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(() => {
    db.tables.clear();
    db.inserts.length = 0;
    db.rpcCalls.length = 0;
    db.fail = null;
    db.rpcMode = { kind: 'schema', code: '42883' };
    seed(db);
  });

  function clones(table: string): Record<string, unknown>[] {
    return db.rows(table).filter((row) => row.scenario_id !== SOURCE && row.id !== SOURCE);
  }

  async function post(id: string, body?: unknown, role = 'trainer', user = TRAINER) {
    const res = await fetch(`${base}/api/scenarios/${id}/clone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-role': role, 'x-user': user },
      body: body === undefined ? '{}' : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  test('a fake RPC clones without the row copier, then stamps org identity', async () => {
    db.rpcMode = { kind: 'ok' };
    const res = await post(SOURCE, { title: 'Renamed harbour' });
    assert.equal(res.status, 201);
    assert.equal(res.json.message, 'Scenario cloned successfully');
    assert.equal((res.json.data as { id: string }).id, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    assert.deepEqual(db.rpcCalls[0], {
      fn: 'clone_scenario',
      p_scenario_id: SOURCE,
      p_user_id: TRAINER,
      p_title: 'Renamed harbour',
    });
    assert.equal(db.inserts.includes('scenario_teams'), false);
    assert.equal(db.inserts.includes('scenario_injects'), false);
    const stamped = db
      .rows('scenarios')
      .find((row) => row.id === 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const state = stamped?.initial_state as { orgs: Array<{ org_uid?: string }> };
    assert.equal(typeof state.orgs[0].org_uid, 'string');
  });

  test('a missing or schema-failing RPC falls back to a full active-row copy', async () => {
    for (const code of ['42883', 'PGRST202', '42703']) {
      db.tables.clear();
      db.inserts.length = 0;
      db.rpcCalls.length = 0;
      seed(db);
      db.rpcMode = { kind: 'schema', code };
      const res = await post(SOURCE);
      assert.equal(res.status, 201, code);
      const scenario = clones('scenarios')[0];
      assert.equal(scenario.title, 'Harbour leak (Copy)');
      assert.equal(scenario.setup_edits_used, 2);
      assert.deepEqual(scenario.blueprint, { lanes: 2 });
      assert.equal(scenario.is_active, false);
      assert.equal(scenario.created_by, TRAINER);
      const state = scenario.initial_state as {
        orgs: Array<{ org_uid: string }>;
        org_page: { orgs: Array<{ org_uid: string }> };
      };
      assert.equal(state.org_page.orgs[0].org_uid, state.orgs[0].org_uid);

      assert.deepEqual(
        clones('scenario_teams').map((row) => row.team_name),
        ['Press Desk'],
      );
      const team = clones('scenario_teams')[0];
      assert.equal(team.team_uid, 'uid-press');
      assert.notEqual(team.valid_from, '2020-01-01T00:00:00.000Z');
      assert.equal(team.retired_by_edit, null);
      assert.equal(team.superseded_by, null);

      const injects = clones('scenario_injects');
      assert.deepEqual(
        injects.map((row) => (row.delivery_config as { inject_key: string }).inject_key),
        ['harbour_post'],
      );
      const config = injects[0].delivery_config as {
        escalation: { max_steps: number };
        mood_ladder: { recovery: string };
      };
      assert.equal(config.escalation.max_steps, 2);
      assert.equal(config.mood_ladder.recovery, 'none');
      assert.deepEqual(injects[0].conditions_to_appear, { all: ['sentiment_below_30'] });
      assert.deepEqual(injects[0].conditions_to_cancel, ['inject_fired:correction']);
      assert.equal(injects[0].generation_source, 'war_room');
      assert.equal(injects[0].session_id, null);
      assert.equal(injects[0].retired_by_edit, null);
      assert.equal(injects[0].superseded_by, null);
      assert.equal(injects[0].retired_at, null);
      assert.equal(injects[0].required_gate_id, null);
      assert.equal(injects[0].required_gate_not_met_id, null);

      assert.deepEqual(
        clones('scenario_objectives').map((row) => row.objective_id),
        ['contain'],
      );
      assert.equal(clones('sop_definitions')[0].sop_name, 'Holding statement');
      const hazards = clones('scenario_hazards');
      assert.deepEqual(hazards.map((row) => row.hazard_type).sort(), ['fire', 'smoke']);
      const parent = hazards.find((row) => row.hazard_type === 'fire');
      const child = hazards.find((row) => row.hazard_type === 'smoke');
      assert.equal(child?.parent_pin_id, parent?.id);
      assert.notEqual(child?.parent_pin_id, 'hazard-parent');
      assert.equal(clones('scenario_casualties')[0].parent_pin_id, parent?.id);
      assert.equal(clones('scenario_equipment')[0].label, 'Foam');
      assert.equal(clones('scenario_floor_plans')[0].floor_label, 'Ground');
      assert.equal(clones('rts_scene_configs')[0].created_by, TRAINER);
      assert.equal(db.inserts.includes('scenario_setup_edits'), false);
      assert.equal(db.inserts.includes('sessions'), false);
    }
  });

  test('a constraint failure does not fall back, and a missing scenario is 404', async () => {
    db.rpcMode = { kind: 'constraint' };
    const denied = await post(SOURCE);
    assert.equal(denied.status, 500);
    assert.equal(db.inserts.length, 0);

    db.rpcMode = { kind: 'empty' };
    const missing = await post(SOURCE);
    assert.equal(missing.status, 404);

    db.rpcMode = { kind: 'schema', code: '42883' };
    const absent = await post('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    assert.equal(absent.status, 404);
  });

  test('players cannot clone, and an empty title is rejected', async () => {
    const player = await post(SOURCE, {}, 'participant', PLAYER);
    assert.equal(player.status, 403);
    assert.equal(db.rpcCalls.length, 0);

    const empty = await post(SOURCE, { title: '' });
    assert.equal(empty.status, 400);
  });

  test('a missing setup_edits_used column is stripped and the rest of the clone still lands', async () => {
    db.fail = { table: 'scenarios', column: 'setup_edits_used', remaining: 1 };
    const result = await cloneScenario(db, { scenarioId: SOURCE, userId: TRAINER, title: null });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const scenario = db.rows('scenarios').find((row) => row.id === result.id);
    assert.equal(scenario && 'setup_edits_used' in scenario, false);
    assert.equal(clones('scenario_teams').length, 1);
    assert.equal(clones('scenario_injects').length, 1);
  });
});
