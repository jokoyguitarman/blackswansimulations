import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CONDITION_CATALOG } from '../server/services/conditions/conditionCatalog.js';
import { formatConditionKey, parseCatalogCondition } from './conditionKeyGrammar.js';
import {
  applyAnySugar,
  crossTeamTeamsOf,
  dependencyCatalogEntries,
  expandPlaceholders,
  resolveTeamRef,
  type ActiveTeam,
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
    assert.deepEqual(applyAnySugar(applyAnySugar(edge.broken_when)), applyAnySugar(edge.broken_when));
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
    assert.equal(
      resolveTeamRef({ team_uid: null, team_name: 'Legal' }, TEAMS),
      'Legal',
    );
    assert.equal(
      resolveTeamRef({ team_uid: null, team_name: 'operations control' }, TEAMS),
      'Operations Control',
    );
    assert.equal(
      resolveTeamRef({ team_uid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', team_name: 'Operations' }, TEAMS),
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
