import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CONDITION_CATALOG } from '../server/services/conditions/conditionCatalog.js';
import { formatConditionKey, parseCatalogCondition } from './conditionKeyGrammar.js';
import {
  applyAnySugar,
  consequenceAppearKey,
  consequenceCancelKeys,
  consequenceInjectDraft,
  dependencyIdInKey,
  crossTeamTeamsOf,
  dependencyCatalogEntries,
  backfillDependencyTeamUids,
  displayRef,
  editorCrossTeamProfile,
  expandPlaceholders,
  fromEditorModel,
  quickDependencyEdge,
  readDependencyCause,
  readTeamDependencies,
  refreshEdgeTeamNames,
  resolveTeamRef,
  takenDependencyIds,
  toEditorModel,
  uniqueDependencyId,
  type ActiveTeam,
  type TeamDependencyEdge,
  type TeamRef,
} from './teamDependencies.js';

const OPS = '6f1c0000-0000-4000-8000-000000000001';
const COMMS = 'a93e0000-0000-4000-8000-000000000002';
const LEGAL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const EXAMPLE = {
  v: 1,
  edges: [
    {
      id: 'dep_ops_headcount_comms',
      kind: 'information',
      upstream: { team_uid: OPS, team_name: 'Operations' },
      downstream: [{ team_uid: COMMS, team_name: 'Communications' }],
      deliverable: 'Confirmed headcount for Bay 3',
      why: "Communications can't publish a holding statement with figures without it",
      due: { after_inject_key: 'bay3_headcount_request', within_minutes: 10 },
      broken_when: {
        any: [
          'unresponded:bay3_headcount_request:10|team=@upstream',
          'reply_failed:bay3_headcount_request|team=@upstream',
        ],
      },
      met_when: { any: ['responded_relevant:bay3_headcount_request|team=@upstream'] },
      lag_minutes: 5,
      severity: 'high',
      consequence_keys: ['comms_reporter_presses_for_numbers'],
      source: 'war_room',
    },
  ],
};

const TEAMS: ActiveTeam[] = [
  { team_uid: OPS, team_name: 'Operations Control' },
  { team_uid: COMMS, team_name: 'Communications' },
  { team_uid: LEGAL, team_name: 'Legal' },
];

describe('team dependency schema', () => {
  test('the section 6.1 example normalises any to threshold 1', () => {
    const edge = EXAMPLE.edges[0]!;
    assert.deepEqual(applyAnySugar(edge.broken_when), {
      threshold: 1,
      conditions: [
        'unresponded:bay3_headcount_request:10|team=@upstream',
        'reply_failed:bay3_headcount_request|team=@upstream',
      ],
    });
    assert.deepEqual(applyAnySugar(edge.met_when), {
      threshold: 1,
      conditions: ['responded_relevant:bay3_headcount_request|team=@upstream'],
    });
    assert.deepEqual(
      applyAnySugar(applyAnySugar(edge.broken_when)),
      applyAnySugar(edge.broken_when),
    );
    assert.equal(edge.upstream.team_name, 'Operations');
    assert.equal(edge.lag_minutes, 5);
    assert.deepEqual(crossTeamTeamsOf(edge), {
      upstream: 'Operations',
      downstream: ['Communications'],
    });
  });

  test('catalog rows expose the dependency state keys', () => {
    const [row] = dependencyCatalogEntries(EXAMPLE.edges);
    assert.equal(row?.id, 'dep_ops_headcount_comms');
    assert.equal(row?.upstream, 'Operations');
    assert.deepEqual(row?.downstream, ['Communications']);
    assert.ok(row?.label.includes('Confirmed headcount for Bay 3'));
    assert.deepEqual(row?.state_keys, [
      'dependency_broken:dep_ops_headcount_comms',
      'dependency_broken_for:dep_ops_headcount_comms:5',
      'dependency_met:dep_ops_headcount_comms',
      'dependency_recovered:dep_ops_headcount_comms',
      'dependency_resolved:dep_ops_headcount_comms',
      'dependency_waived:dep_ops_headcount_comms',
    ]);
  });
});

describe('resolveTeamRef', () => {
  test('uid match beats a stale name', () => {
    const ref: TeamRef = { team_uid: OPS, team_name: 'Operations' };
    assert.equal(resolveTeamRef(ref, TEAMS), 'Operations Control');
  });

  test('name fallback when uid is null, then slug, and a removed team is null', () => {
    assert.equal(resolveTeamRef({ team_uid: null, team_name: 'Legal' }, TEAMS), 'Legal');
    assert.equal(
      resolveTeamRef({ team_uid: null, team_name: 'operations control' }, TEAMS),
      'Operations Control',
    );
    assert.equal(
      resolveTeamRef(
        { team_uid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', team_name: 'Operations' },
        TEAMS,
      ),
      null,
    );
    assert.equal(resolveTeamRef({ team_uid: null, team_name: 'Logistics' }, TEAMS), null);
  });
});

describe('dependency placeholders', () => {
  const key = 'unresponded:bay3_headcount_request:10|team=@upstream';

  test('placeholders parse only with the option and expand to a team slug', () => {
    const denied = parseCatalogCondition(key, CONDITION_CATALOG);
    assert.ok('error' in denied);
    if ('error' in denied) {
      assert.equal(denied.error, 'Placeholder scopes are only valid inside team dependencies');
    }
    const asSlug = parseCatalogCondition(key, CONDITION_CATALOG);
    assert.ok('error' in asSlug);

    const allowed = parseCatalogCondition(key, CONDITION_CATALOG, { allowPlaceholders: true });
    assert.ok(!('error' in allowed));
    if ('error' in allowed) return;
    assert.equal(allowed.scope?.team_placeholder, '@upstream');
    assert.equal(allowed.scope?.team, undefined);
    const formatted = formatConditionKey(allowed.def, allowed.args, allowed.scope);
    assert.deepEqual(formatted, { key });

    const downstream = parseCatalogCondition(
      'reply_failed:bay3_headcount_request|team=@downstream',
      CONDITION_CATALOG,
      { allowPlaceholders: true },
    );
    assert.ok(!('error' in downstream));
    if (!('error' in downstream)) assert.equal(downstream.scope?.team_placeholder, '@downstream');

    assert.equal(
      expandPlaceholders(key, { upstream: 'Operations' }),
      'unresponded:bay3_headcount_request:10|team=operations',
    );
    assert.equal(
      expandPlaceholders('reply_failed:bay3_headcount_request|team=@downstream', {
        downstream: 'Communications',
      }),
      'reply_failed:bay3_headcount_request|team=communications',
    );
    assert.equal(expandPlaceholders(key, {}), key);

    const silent = parseCatalogCondition('team_silent:12|team=@upstream', CONDITION_CATALOG, {
      allowPlaceholders: true,
    });
    assert.ok(!('error' in silent), 'error' in silent ? silent.error : '');
    if (!('error' in silent)) assert.equal(silent.scope?.team_placeholder, '@upstream');
    const silentDenied = parseCatalogCondition('team_silent:12|team=@upstream', CONDITION_CATALOG);
    assert.ok('error' in silentDenied);
  });
});

describe('dependency editor model', () => {
  test('the section 6.1 document round-trips through the editor, with any stored as threshold 1', () => {
    const read = readTeamDependencies(EXAMPLE);
    assert.ok(!('error' in read));
    if ('error' in read) return;
    const edge = read.dependencies.edges[0]!;
    assert.deepEqual(edge.broken_when, {
      threshold: 1,
      conditions: [
        'unresponded:bay3_headcount_request:10|team=@upstream',
        'reply_failed:bay3_headcount_request|team=@upstream',
      ],
    });
    const model = toEditorModel(edge);
    assert.equal(model.broken.quantifier, 'any');
    assert.equal(model.dueMode, 'after_inject');
    assert.equal(model.afterInjectKey, 'bay3_headcount_request');
    assert.equal(model.withinMinutes, 10);
    assert.equal(model.met?.quantifier, 'any');
    assert.deepEqual(fromEditorModel(model), edge);
    assert.deepEqual(toEditorModel(fromEditorModel(model)), model);

    const again = readTeamDependencies({ v: 1, edges: [fromEditorModel(model)] });
    assert.ok(!('error' in again));
    if ('error' in again) return;
    assert.deepEqual(again.dependencies.edges[0], edge);
  });

  test('a by-minute edge with no met conditions stays empty across a second pass', () => {
    const stored = {
      id: 'dep_ops_window',
      kind: 'action',
      upstream: { team_uid: OPS, team_name: 'Operations' },
      downstream: [{ team_uid: COMMS, team_name: 'Communications' }],
      deliverable: 'Bay closure',
      why: '',
      due: { by_minute: 20 },
      broken_when: { all: ['team_silent:8|team=@upstream'] },
      met_when: null,
      lag_minutes: 0,
      severity: 'low',
      consequence_keys: [],
      source: 'trainer',
    };
    const read = readTeamDependencies({ v: 1, edges: [stored] });
    assert.ok(!('error' in read));
    if ('error' in read) return;
    const model = toEditorModel(read.dependencies.edges[0]!);
    assert.equal(model.dueMode, 'by_minute');
    assert.equal(model.byMinute, 20);
    assert.equal(model.met, null);
    assert.equal(model.lagMinutes, 0);
    assert.deepEqual(fromEditorModel(model), read.dependencies.edges[0]);
    assert.deepEqual(toEditorModel(fromEditorModel(model)), model);
  });

  test('the fails-this action writes one edge that reloads unchanged', () => {
    const edge = quickDependencyEdge({
      id: 'dep_ops_bay3_headcount',
      injectKey: 'bay3_headcount_request',
      injectTitle: 'Bay 3 headcount',
      upstream: { team_uid: OPS, team_name: 'Operations' },
      downstream: { team_uid: COMMS, team_name: 'Communications' },
      withinMinutes: 10,
      lagMinutes: 5,
      consequenceKey: 'comms_reporter_presses_for_numbers',
    });
    const read = readTeamDependencies({ v: 1, edges: [edge] });
    assert.ok(!('error' in read));
    if ('error' in read) return;
    assert.deepEqual(read.dependencies.edges[0], edge);
    assert.deepEqual(fromEditorModel(toEditorModel(edge)), edge);
    assert.equal(consequenceAppearKey(edge), 'dependency_broken_for:dep_ops_bay3_headcount:5');
    assert.deepEqual(consequenceCancelKeys(edge.id), [
      'dependency_resolved:dep_ops_bay3_headcount',
      'dependency_waived:dep_ops_bay3_headcount',
    ]);
    assert.equal(readDependencyCause({ cause: { kind: 'dependency', dep_id: edge.id } }), edge.id);
    const taken = new Set([edge.id]);
    assert.equal(uniqueDependencyId('Bay 3 headcount', taken), 'dep_bay_3_headcount');
    assert.equal(
      dependencyIdInKey('dependency_broken_for:dep_bay_3_headcount:5'),
      'dep_bay_3_headcount',
    );
    assert.equal(dependencyIdInKey('dependency_waived:dep_bay_3_headcount'), 'dep_bay_3_headcount');
    assert.equal(dependencyIdInKey('unresponded:bay3_headcount_request:10|team=@upstream'), null);
    const draft = consequenceInjectDraft({
      edge,
      team: 'Communications',
      injectKey: 'comms_reporter_presses_for_numbers',
      title: 'Reporter presses for numbers',
      content: 'The figures never arrived.',
    });
    assert.deepEqual(draft.conditions_to_appear, {
      all: ['dependency_broken_for:dep_ops_bay3_headcount:5'],
    });
    assert.deepEqual(draft.conditions_to_cancel, [
      'dependency_resolved:dep_ops_bay3_headcount',
      'dependency_waived:dep_ops_bay3_headcount',
    ]);
    assert.deepEqual(draft.target_teams, ['Communications']);
    assert.deepEqual(draft.delivery_config.cause, {
      kind: 'dependency',
      dep_id: 'dep_ops_bay3_headcount',
    });
    assert.equal(
      uniqueDependencyId('dep_ops_bay3_headcount', new Set(['dep_dep_ops_bay3_headcount'])),
      'dep_dep_ops_bay3_headcount_2',
    );
  });

  test('a retired id is reserved from appear, from cancel, and from cause separately', () => {
    const fromAppear = takenDependencyIds(
      [],
      [{ conditions_to_appear: { all: ['dependency_broken_for:dep_from_appear:5'] } }],
    );
    assert.deepEqual([...fromAppear], ['dep_from_appear']);
    assert.equal(
      uniqueDependencyId(
        'Bay 3 headcount',
        takenDependencyIds(
          [],
          [{ conditions_to_appear: { any: ['dependency_broken_for:dep_bay_3_headcount:5'] } }],
        ),
      ),
      'dep_bay_3_headcount_2',
    );

    const fromCancel = takenDependencyIds(
      [],
      [{ conditions_to_cancel: ['dependency_waived:dep_from_cancel'] }],
    );
    assert.deepEqual([...fromCancel], ['dep_from_cancel']);

    const fromCause = takenDependencyIds(
      [],
      [
        {
          delivery_config: {
            cause: {
              kind: 'dependency',
              dep_id: 'dep_from_cause',
              note: 'dependency_broken:dep_not_this',
            },
          },
        },
      ],
    );
    assert.deepEqual([...fromCause], ['dep_from_cause']);
  });

  test('a renamed team shows its new name, and a removed team stays an orphan', () => {
    const read = readTeamDependencies(EXAMPLE);
    assert.ok(!('error' in read));
    if ('error' in read) return;
    const edge = read.dependencies.edges[0] as TeamDependencyEdge;
    const refreshed = refreshEdgeTeamNames(edge, TEAMS);
    assert.equal(refreshed.upstream.team_name, 'Operations Control');
    assert.equal(refreshed.upstream.team_uid, OPS);
    assert.equal(refreshed.downstream[0]?.team_name, 'Communications');
    assert.deepEqual(displayRef(edge.upstream, TEAMS), {
      name: 'Operations Control',
      removed: false,
    });
    assert.deepEqual(displayRef({ team_uid: null, team_name: 'Logistics' }, TEAMS), {
      name: 'Logistics',
      removed: true,
    });
    const orphan = refreshEdgeTeamNames(
      {
        ...edge,
        upstream: { team_uid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', team_name: 'Logistics' },
      },
      TEAMS,
    );
    assert.equal(orphan.upstream.team_name, 'Logistics');
    assert.equal(displayRef(orphan.upstream, TEAMS).removed, true);
  });

  test('a dependency consequence aimed at another team is cross-team', () => {
    const read = readTeamDependencies(EXAMPLE);
    assert.ok(!('error' in read));
    if ('error' in read) return;
    const edge = read.dependencies.edges[0]!;
    const profile = editorCrossTeamProfile({
      appearKeys: [consequenceAppearKey(edge)],
      targetTeams: ['Communications'],
      edges: [edge],
      teams: [{ team_uid: OPS, team_name: 'Operations' }, ...TEAMS.slice(1)],
    });
    assert.equal(profile.is_cross_team, true);
    assert.deepEqual(profile.source_teams, ['Operations']);
    const same = editorCrossTeamProfile({
      appearKeys: ['unresponded:bay3_headcount_request:10|team=operations'],
      targetTeams: ['Operations'],
      edges: [],
      teams: [{ team_uid: OPS, team_name: 'Operations' }],
    });
    assert.equal(same.is_cross_team, false);
  });
});

describe('backfillDependencyTeamUids', () => {
  test('stamps a missing uid from the roster and leaves an existing uid alone', () => {
    const state = {
      team_dependencies: {
        v: 1,
        edges: [
          {
            id: 'dep_names',
            upstream: { team_name: 'Legal' },
            downstream: [{ team_uid: 'uid-kept', team_name: 'Communications' }],
          },
        ],
      },
    };
    const teams = [
      { team_uid: 'uid-legal', team_name: 'Legal' },
      { team_uid: 'uid-comms', team_name: 'Communications' },
    ];
    const stamped = backfillDependencyTeamUids(state, teams);
    const upstream = stamped.team_dependencies.edges[0]?.upstream as { team_uid?: string };
    const downstream = stamped.team_dependencies.edges[0]?.downstream[0] as { team_uid?: string };
    assert.equal(upstream.team_uid, 'uid-legal');
    assert.equal(downstream.team_uid, 'uid-kept');
    const again = backfillDependencyTeamUids(stamped, teams);
    assert.equal(again, stamped);
  });
});
