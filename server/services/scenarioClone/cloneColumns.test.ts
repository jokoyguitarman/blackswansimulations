import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  CASUALTY_CLONE_COLUMNS,
  EQUIPMENT_CLONE_COLUMNS,
  FLOOR_PLAN_CLONE_COLUMNS,
  HAZARD_CLONE_COLUMNS,
  INJECT_CLONE_COLUMNS,
  OBJECTIVE_CLONE_COLUMNS,
  OPTIONAL_CLONE_TABLES,
  SCENE_CLONE_COLUMNS,
  SCENARIO_COPIED_COLUMNS,
  SOP_CLONE_COLUMNS,
  TEAM_CLONE_COLUMNS,
  cloneCasualtyRows,
  cloneHazardRows,
  cloneInjectRows,
  cloneScenarioInsert,
  cloneTeamRows,
  injectKeyOf,
  isCloneSchemaError,
  resolveCloneTitle,
} from './cloneColumns.js';

const PERSISTENCE = new URL('../../services/socialCrisisPersistenceService.ts', import.meta.url);
const MIGRATION = new URL('../../../migrations/276_clone_scenario.sql', import.meta.url);

function rowKeys(block: string, indents: number[]): string[] {
  const keys = new Set<string>();
  for (const line of block.split('\n')) {
    const match = /^( *)([a-z_][a-z0-9_]*):/.exec(line);
    if (!match || !indents.includes(match[1].length)) continue;
    keys.add(match[2]);
  }
  return [...keys];
}

function insertColumns(sql: string, table: string): string[] {
  const marker = `INSERT INTO public.${table} (`;
  const start = sql.indexOf(marker);
  assert.notEqual(start, -1, table);
  const end = sql.indexOf(')', start);
  return sql
    .slice(start + marker.length, end)
    .split(',')
    .map((column) => column.trim())
    .filter(Boolean);
}

const NOW = '2026-11-28T02:00:00.000Z';

function socialFixture() {
  const scenario: Record<string, unknown> = {
    id: 'scenario-1',
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
    role_specific_briefs: { editor: 'Stay factual' },
  };
  const teams: Record<string, unknown>[] = [
    {
      id: 'team-live',
      team_uid: 'uid-press',
      team_name: 'Press Desk',
      team_description: 'Public voice',
      required_roles: [],
      min_participants: 1,
      max_participants: 4,
      org_key: 'primary',
      function_key: 'comms',
      charter: { mission: 'Inform' },
      expected_actions: ['post'],
      scoring_rubric: 'clarity',
      valid_from: '2020-01-01T00:00:00.000Z',
      retired_at: null,
      retired_by_edit: null,
      superseded_by: null,
    },
    {
      id: 'team-old',
      team_uid: 'uid-old',
      team_name: 'Press Desk (old)',
      valid_from: '2019-01-01T00:00:00.000Z',
      retired_at: '2025-06-01T00:00:00.000Z',
      retired_by_edit: 'edit-1',
      retire_reason: 'renamed',
      superseded_by: 'team-live',
    },
  ];
  const escalation = {
    max_steps: 2,
    scope: 'per_team',
    stop_on: 'any_response',
    steps: [{ after_minutes: 5, urgency: 'follow_up' }],
  };
  const mood = { recovery: 'none', rungs: [{ id: 'calm', label: 'Calm' }] };
  const injects: Record<string, unknown>[] = [
    {
      id: 'inject-live',
      session_id: null,
      retired_at: null,
      retired_by_edit: 'edit-stale',
      superseded_by: 'inject-should-not-carry',
      valid_from: '2020-01-01T00:00:00.000Z',
      title: 'Tank photo',
      content: 'A photo is circulating',
      type: 'social_post',
      severity: 'high',
      requires_response: true,
      conditions_to_appear: { all: ['sentiment_below_30'] },
      conditions_to_cancel: ['inject_fired:correction'],
      eligible_after_minutes: 12,
      state_effect: { social_state: { sentiment: -1 } },
      generation_source: 'war_room',
      required_gate_id: 'gate-source',
      required_gate_not_met_id: 'gate-source-not-met',
      delivery_config: {
        app: 'social_feed',
        inject_key: 'harbour_post',
        escalation,
        mood_ladder: mood,
      },
    },
    {
      id: 'inject-retired',
      session_id: null,
      retired_at: '2025-06-01T00:00:00.000Z',
      title: 'Retired post',
      delivery_config: { inject_key: 'retired_post' },
    },
    {
      id: 'inject-runtime',
      session_id: 'session-1',
      retired_at: null,
      title: 'Runtime copy',
      delivery_config: { inject_key: 'runtime_post' },
    },
  ];
  return { scenario, teams, injects, escalation, mood };
}

describe('clone column lists', () => {
  test('the fallback copies every team and inject column social-crisis compile writes', () => {
    const src = readFileSync(PERSISTENCE, 'utf8');
    const teamBlock = src.slice(
      src.indexOf('const teamRows = teams.map'),
      src.indexOf('const droppedTeamColumns'),
    );
    const injectBlock = src.slice(
      src.indexOf('const allInjects = ['),
      src.indexOf('const stampedInjects'),
    );
    const teamKeys = rowKeys(teamBlock, [10]).filter((key) => key !== 'scenario_id');
    const injectKeys = rowKeys(injectBlock, [8, 12]).filter(
      (key) => key !== 'scenario_id' && key !== 'gen_layer',
    );
    assert.ok(teamKeys.includes('team_uid'));
    assert.ok(teamKeys.includes('charter'));
    assert.ok(injectKeys.includes('delivery_config'));
    assert.ok(injectKeys.includes('conditions_to_appear'));
    assert.ok(injectKeys.includes('conditions_to_cancel'));
    assert.ok(injectKeys.includes('eligible_after_minutes'));
    assert.ok(injectKeys.includes('state_effect'));
    assert.ok(injectKeys.includes('generation_source'));
    assert.ok(injectKeys.includes('trigger_condition'));
    assert.match(injectBlock, /\.\.\.sanitizeTeamTargeting\(/);
    injectKeys.push('inject_scope', 'target_teams');

    for (const key of teamKeys)
      assert.ok((TEAM_CLONE_COLUMNS as readonly string[]).includes(key), key);
    for (const key of injectKeys) {
      assert.ok((INJECT_CLONE_COLUMNS as readonly string[]).includes(key), key);
    }
    assert.equal((INJECT_CLONE_COLUMNS as readonly string[]).includes('gen_layer'), false);
  });

  test('migration 276 inserts the same columns and skips 268-273 objects', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    assert.match(sql, /NOT APPLIED/);
    assert.match(sql, /SET search_path = public, pg_temp/);
    assert.doesNotMatch(sql, /SECURITY DEFINER/);
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION public\.clone_scenario\(UUID, UUID, TEXT\)\s+TO service_role/,
    );
    assert.match(sql, /FROM PUBLIC, anon, authenticated/);

    assert.deepEqual(
      new Set(insertColumns(sql, 'scenarios')),
      new Set(['title', ...SCENARIO_COPIED_COLUMNS, 'created_by', 'is_active']),
    );
    assert.deepEqual(
      new Set(insertColumns(sql, 'scenario_teams')),
      new Set([
        'scenario_id',
        ...TEAM_CLONE_COLUMNS,
        'valid_from',
        'retired_at',
        'retired_by_edit',
        'retire_reason',
        'superseded_by',
      ]),
    );
    assert.deepEqual(
      new Set(insertColumns(sql, 'scenario_injects')),
      new Set([
        'scenario_id',
        ...INJECT_CLONE_COLUMNS,
        'session_id',
        'valid_from',
        'retired_at',
        'retired_by_edit',
        'retire_reason',
        'superseded_by',
      ]),
    );
    assert.deepEqual(
      new Set(insertColumns(sql, 'scenario_objectives')),
      new Set(['scenario_id', ...OBJECTIVE_CLONE_COLUMNS]),
    );
    assert.deepEqual(
      new Set(insertColumns(sql, 'sop_definitions')),
      new Set(['scenario_id', ...SOP_CLONE_COLUMNS]),
    );
    assert.deepEqual(
      new Set(insertColumns(sql, 'scenario_hazards')),
      new Set(['id', 'scenario_id', 'session_id', ...HAZARD_CLONE_COLUMNS, 'parent_pin_id']),
    );
    assert.deepEqual(
      new Set(insertColumns(sql, 'scenario_casualties')),
      new Set(['scenario_id', 'session_id', ...CASUALTY_CLONE_COLUMNS, 'parent_pin_id']),
    );
    assert.deepEqual(
      new Set(insertColumns(sql, 'scenario_equipment')),
      new Set(['scenario_id', ...EQUIPMENT_CLONE_COLUMNS]),
    );
    assert.deepEqual(
      new Set(insertColumns(sql, 'scenario_floor_plans')),
      new Set(['scenario_id', ...FLOOR_PLAN_CLONE_COLUMNS]),
    );
    assert.deepEqual(
      new Set(insertColumns(sql, 'rts_scene_configs')),
      new Set(['scenario_id', ...SCENE_CLONE_COLUMNS, 'created_by']),
    );

    const teamsSql = sql.slice(
      sql.indexOf('INSERT INTO public.scenario_teams'),
      sql.indexOf('INSERT INTO public.scenario_injects'),
    );
    assert.match(teamsSql, /now\(\)/);
    assert.doesNotMatch(teamsSql, /t\.valid_from/);
    assert.match(teamsSql, /t\.retired_at IS NULL/);
    const injectSql = sql.slice(
      sql.indexOf('INSERT INTO public.scenario_injects'),
      sql.indexOf('DROP TABLE IF EXISTS pg_temp.clone_hazard_map'),
    );
    assert.match(injectSql, /now\(\)/);
    assert.doesNotMatch(injectSql, /i\.valid_from/);
    assert.doesNotMatch(injectSql, /i\.required_gate_id/);
    assert.doesNotMatch(injectSql, /i\.required_gate_not_met_id/);
    assert.match(injectSql, /i\.session_id IS NULL/);
    assert.match(injectSql, /i\.retired_at IS NULL/);
    assert.match(sql, /o\.retired_at IS NULL/);
    assert.match(sql, /h\.session_id IS NULL/);
    assert.match(sql, /c\.session_id IS NULL/);
    for (const table of OPTIONAL_CLONE_TABLES) {
      assert.match(sql, new RegExp(`to_regclass\\('public\\.${table}'\\)`));
    }
    for (const name of [
      'inject_deliveries',
      'inject_responses',
      'sim_calls',
      'sim_direct_messages',
      'session_role_assignments',
      'session_call_lines',
      'session_call_takers',
      'escalation_chains',
      'escalation_chain_steps',
      'stakeholder_moods',
      'scenario_setup_edits',
    ]) {
      assert.equal(sql.includes(name), false, name);
    }
  });

  test('schema-missing codes are the ones that fall back from the RPC', () => {
    for (const code of ['42883', 'PGRST202', '42703', '42P01', 'PGRST204', 'PGRST205']) {
      assert.equal(isCloneSchemaError({ code, message: 'nope' }), true, code);
    }
    assert.equal(isCloneSchemaError({ code: '23505', message: 'duplicate key' }), false);
    assert.equal(resolveCloneTitle('Harbour leak', '  '), 'Harbour leak (Copy)');
    assert.equal(resolveCloneTitle('Harbour leak', ' Renamed '), 'Renamed');
  });
});

describe('cloned social-crisis rows', () => {
  test('keeps teams, keys, conditions, escalation, mood and the used edit count', () => {
    const { scenario, teams, injects, escalation, mood } = socialFixture();
    const copied = cloneScenarioInsert(scenario, {
      title: 'Harbour leak (Copy)',
      createdBy: 'trainer-1',
    });
    const copiedTeams = cloneTeamRows(teams, 'clone-1', NOW);
    const copiedInjects = cloneInjectRows(injects, 'clone-1', NOW);

    assert.equal(copied.title, 'Harbour leak (Copy)');
    assert.equal(copied.created_by, 'trainer-1');
    assert.equal(copied.is_active, false);
    assert.equal(copied.setup_edits_used, 2);
    assert.deepEqual(copied.blueprint, { lanes: 2 });
    const state = copied.initial_state as {
      orgs: Array<{ org_uid: string; org_key: string }>;
      org_page: { orgs: Array<{ org_uid: string }> };
    };
    assert.equal(typeof state.orgs[0].org_uid, 'string');
    assert.equal(state.org_page.orgs[0].org_uid, state.orgs[0].org_uid);

    assert.deepEqual(
      copiedTeams.map((team) => team.team_name),
      ['Press Desk'],
    );
    assert.equal(copiedTeams[0].team_uid, 'uid-press');
    assert.equal(copiedTeams[0].valid_from, NOW);
    assert.equal(copiedTeams[0].retired_by_edit, null);
    assert.equal(copiedTeams[0].superseded_by, null);
    assert.deepEqual(copiedTeams[0].charter, { mission: 'Inform' });

    assert.deepEqual(copiedInjects.map(injectKeyOf), ['harbour_post']);
    assert.deepEqual(copiedInjects[0].conditions_to_appear, { all: ['sentiment_below_30'] });
    assert.deepEqual(copiedInjects[0].conditions_to_cancel, ['inject_fired:correction']);
    assert.equal(copiedInjects[0].eligible_after_minutes, 12);
    assert.equal(copiedInjects[0].generation_source, 'war_room');
    const config = copiedInjects[0].delivery_config as {
      escalation: unknown;
      mood_ladder: unknown;
    };
    assert.deepEqual(config.escalation, escalation);
    assert.deepEqual(config.mood_ladder, mood);
    assert.equal(copiedInjects[0].valid_from, NOW);
    assert.equal(copiedInjects[0].session_id, null);
    assert.equal(copiedInjects[0].retired_by_edit, null);
    assert.equal(copiedInjects[0].superseded_by, null);
    assert.equal(copiedInjects[0].retired_at, null);
    assert.equal(copiedInjects[0].required_gate_id, null);
    assert.equal(copiedInjects[0].required_gate_not_met_id, null);
  });

  test('drops retired rows and remaps hazard parent pins onto the clone', () => {
    const teams = cloneTeamRows(
      [
        { team_name: 'Live', retired_at: null, team_uid: 'u' },
        { team_name: 'Gone', retired_at: '2024-01-01T00:00:00.000Z', team_uid: 'old' },
      ],
      'clone-1',
      NOW,
    );
    assert.deepEqual(
      teams.map((team) => team.team_name),
      ['Live'],
    );

    const plan = cloneHazardRows(
      [
        { id: 'h1', session_id: null, hazard_type: 'fire', parent_pin_id: null },
        { id: 'h2', session_id: null, hazard_type: 'smoke', parent_pin_id: 'h1' },
        { id: 'h3', session_id: 'session-1', hazard_type: 'runtime', parent_pin_id: null },
      ],
      'clone-1',
    );
    assert.deepEqual(
      plan.rows.map((row) => row.hazard_type),
      ['fire', 'smoke'],
    );
    assert.equal(
      plan.rows.every((row) => row.session_id === null && row.parent_pin_id === null),
      true,
    );
    assert.deepEqual(plan.parentLinks, [
      { id: plan.idMap.get('h2'), parentId: plan.idMap.get('h1') },
    ]);
    const casualties = cloneCasualtyRows(
      [
        { session_id: null, casualty_type: 'patient', parent_pin_id: 'h1' },
        { session_id: 'session-1', casualty_type: 'crowd', parent_pin_id: 'h1' },
        { session_id: null, casualty_type: 'patient', parent_pin_id: 'missing' },
      ],
      'clone-1',
      plan.idMap,
    );
    assert.equal(casualties.length, 2);
    assert.equal(casualties[0].parent_pin_id, plan.idMap.get('h1'));
    assert.equal(casualties[1].parent_pin_id, null);
  });

  test('a clone stamps team_uid onto dependency edges that have only names', () => {
    const copied = cloneScenarioInsert(
      {
        title: 'Harbour',
        initial_state: {
          orgs: [{ org_key: 'primary', display_name: 'Acme' }],
          team_dependencies: {
            v: 1,
            edges: [
              {
                id: 'dep_names',
                upstream: { team_name: 'Press Desk' },
                downstream: [{ team_uid: 'uid-kept', team_name: 'Legal' }],
              },
            ],
          },
        },
      },
      {
        title: 'Harbour (Copy)',
        createdBy: 'trainer-1',
        teams: [
          { team_uid: 'uid-press', team_name: 'Press Desk' },
          { team_uid: 'uid-legal', team_name: 'Legal' },
        ],
      },
    );
    const state = copied.initial_state as {
      team_dependencies: {
        edges: Array<{
          upstream: { team_uid?: string };
          downstream: Array<{ team_uid?: string }>;
        }>;
      };
    };
    assert.equal(state.team_dependencies.edges[0]?.upstream.team_uid, 'uid-press');
    assert.equal(state.team_dependencies.edges[0]?.downstream[0]?.team_uid, 'uid-kept');
  });
});
