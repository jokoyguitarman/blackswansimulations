import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { computeDelta, type SetupDelta } from './setupDeltaCore.js';
import type {
  SetupCrisis,
  SetupSnapshot,
  SnapshotCompetitor,
  SnapshotOrg,
  SnapshotPressure,
  SnapshotTeam,
} from './setupSnapshotCore.js';

const crisis: SetupCrisis = {
  crisis_type: 'Plant fire',
  context: 'Night shift',
  uploaded_doc_name: null,
  uploaded_doc_text_hash: null,
  country: 'Singapore',
  org_name: 'Acme',
  duration: 60,
  auto_antagonist: true,
};

function team(partial: Partial<SnapshotTeam> & Pick<SnapshotTeam, 'team_uid' | 'team_name'>): SnapshotTeam {
  return {
    function_key: partial.function_key ?? partial.team_name,
    description: partial.description ?? '',
    is_custom: partial.is_custom ?? false,
    is_public_voice: partial.is_public_voice ?? false,
    ...partial,
  };
}

function org(partial: Partial<SnapshotOrg> & Pick<SnapshotOrg, 'org_uid' | 'org_key' | 'display_name'>): SnapshotOrg {
  return {
    short_name: partial.short_name ?? 'ORG',
    country: partial.country ?? 'Singapore',
    kind: partial.kind ?? 'company',
    operation: partial.operation ?? 'players',
    is_primary: partial.is_primary ?? false,
    teams: partial.teams ?? [
      team({ team_uid: `${partial.org_uid}-a`, team_name: 'Communications', is_public_voice: true }),
      team({ team_uid: `${partial.org_uid}-b`, team_name: 'Legal' }),
    ],
    ...partial,
  };
}

function pressure(partial: Partial<SnapshotPressure> & Pick<SnapshotPressure, 'org_key'>): SnapshotPressure {
  return {
    org_uid: partial.org_uid ?? partial.org_key,
    display_name: partial.display_name ?? partial.org_key,
    country: partial.country ?? 'Singapore',
    targets_org_keys: partial.targets_org_keys ?? ['primary'],
    ...partial,
  };
}

function rival(partial: Partial<SnapshotCompetitor> & Pick<SnapshotCompetitor, 'org_key' | 'name'>): SnapshotCompetitor {
  return {
    org_uid: partial.org_uid ?? partial.org_key,
    country: partial.country ?? 'Singapore',
    auto_generated: partial.auto_generated ?? false,
    ...partial,
  };
}

function snapshot(partial: Partial<SetupSnapshot> = {}): SetupSnapshot {
  const organisations = partial.organisations ?? [
    org({
      org_uid: 'uid-acme',
      org_key: 'primary',
      display_name: 'Acme',
      short_name: 'ACME',
      is_primary: true,
    }),
  ];
  return {
    crisis: partial.crisis ?? crisis,
    organisations,
    pressure_organisations: partial.pressure_organisations ?? [],
    competitors: partial.competitors ?? [],
    inject_keys: partial.inject_keys ?? [],
    multi_org: partial.multi_org ?? organisations.length > 1,
  };
}

function changed<K extends keyof SetupDelta>(delta: SetupDelta, key: K): SetupDelta[K] {
  return delta[key];
}

describe('setup delta', () => {
  test('an unchanged setup is empty', () => {
    const base = snapshot();
    const delta = computeDelta(base, snapshot());
    assert.equal(delta.empty, true);
    assert.equal(delta.primary_swap, null);
    assert.equal(delta.brief_changed, false);
    assert.equal(delta.becomes_multi_org, false);
    for (const list of [
      delta.added_orgs,
      delta.added_teams,
      delta.added_pressure,
      delta.added_rivals,
      delta.removed_orgs,
      delta.removed_teams,
      delta.removed_pressure,
      delta.removed_rivals,
      delta.renamed_orgs,
      delta.renamed_teams,
      delta.relocated_orgs,
      delta.changed_text,
      delta.new_countries,
      delta.vacated_countries,
    ]) {
      assert.deepEqual(list, []);
    }
  });

  test('added_orgs and becomes_multi_org', () => {
    const base = snapshot();
    const edited = snapshot({
      organisations: [
        ...base.organisations,
        org({
          org_uid: 'uid-my',
          org_key: 'org_acme_my',
          display_name: 'Acme Malaysia',
          country: 'Malaysia',
        }),
      ],
    });
    const delta = computeDelta(base, edited);
    assert.deepEqual(delta.added_orgs, ['org_acme_my']);
    assert.equal(delta.becomes_multi_org, true);
    assert.deepEqual(delta.new_countries, ['Malaysia']);
    assert.equal(delta.empty, false);
  });

  test('added_teams', () => {
    const base = snapshot();
    const edited = snapshot({
      organisations: [
        org({
          org_uid: 'uid-acme',
          org_key: 'primary',
          display_name: 'Acme',
          is_primary: true,
          teams: [
            ...base.organisations[0].teams,
            team({ team_uid: 'uid-new', team_name: 'Finance' }),
          ],
        }),
      ],
    });
    assert.deepEqual(computeDelta(base, edited).added_teams, [
      { org_key: 'primary', team_name: 'Finance' },
    ]);
  });

  test('added_pressure and added_rivals', () => {
    const base = snapshot();
    const edited = snapshot({
      pressure_organisations: [pressure({ org_key: 'org_pressure_union_sg', wants: 'A hearing' })],
      competitors: [rival({ org_key: 'org_antagonist_rival_0', name: 'Rival Co' })],
    });
    const delta = computeDelta(base, edited);
    assert.deepEqual(delta.added_pressure, ['org_pressure_union_sg']);
    assert.deepEqual(delta.added_rivals, ['org_antagonist_rival_0']);
  });

  test('removed_orgs vacates the country', () => {
    const base = snapshot({
      organisations: [
        org({ org_uid: 'uid-acme', org_key: 'primary', display_name: 'Acme', is_primary: true }),
        org({
          org_uid: 'uid-my',
          org_key: 'org_acme_my',
          display_name: 'Acme Malaysia',
          country: 'Malaysia',
        }),
      ],
    });
    const edited = snapshot({ organisations: [base.organisations[0]] });
    const delta = computeDelta(base, edited);
    assert.deepEqual(delta.removed_orgs, ['org_acme_my']);
    assert.deepEqual(delta.vacated_countries, ['Malaysia']);
    assert.equal(delta.becomes_multi_org, false);
  });

  test('removed_teams', () => {
    const base = snapshot();
    const edited = snapshot({
      organisations: [
        org({
          org_uid: 'uid-acme',
          org_key: 'primary',
          display_name: 'Acme',
          is_primary: true,
          teams: [base.organisations[0].teams[0], team({ team_uid: 'uid-keep', team_name: 'Operations' })],
        }),
      ],
    });
    const delta = computeDelta(base, edited);
    assert.deepEqual(
      delta.removed_teams.filter((row) => row.team_uid === 'uid-acme-b'),
      [{ team_uid: 'uid-acme-b', team_name: 'Legal' }],
    );
  });

  test('removed_pressure and removed_rivals', () => {
    const base = snapshot({
      pressure_organisations: [pressure({ org_key: 'org_pressure_union_sg' })],
      competitors: [rival({ org_key: 'org_antagonist_rival_0', name: 'Rival Co' })],
    });
    const delta = computeDelta(base, snapshot());
    assert.deepEqual(delta.removed_pressure, ['org_pressure_union_sg']);
    assert.deepEqual(delta.removed_rivals, ['org_antagonist_rival_0']);
  });

  test('renamed_orgs includes a short-name change', () => {
    const base = snapshot();
    const edited = snapshot({
      organisations: [
        org({
          org_uid: 'uid-acme',
          org_key: 'primary',
          display_name: 'Acme Holdings',
          short_name: 'AH',
          is_primary: true,
          teams: base.organisations[0].teams,
        }),
      ],
    });
    assert.deepEqual(computeDelta(base, edited).renamed_orgs, [
      { org_key: 'primary', from: 'Acme', to: 'Acme Holdings', short_from: 'ACME', short_to: 'AH' },
    ]);
  });

  test('renamed_teams keeps the team uid', () => {
    const base = snapshot();
    const teams = base.organisations[0].teams.map((row) =>
      row.team_uid === 'uid-acme-a' ? { ...row, team_name: 'Media Desk' } : row,
    );
    const edited = snapshot({
      organisations: [
        org({
          org_uid: 'uid-acme',
          org_key: 'primary',
          display_name: 'Acme',
          is_primary: true,
          teams,
        }),
      ],
    });
    assert.deepEqual(computeDelta(base, edited).renamed_teams, [
      { team_uid: 'uid-acme-a', from: 'Communications', to: 'Media Desk' },
    ]);
  });

  test('relocated_orgs', () => {
    const base = snapshot();
    const edited = snapshot({
      organisations: [
        org({
          org_uid: 'uid-acme',
          org_key: 'primary',
          display_name: 'Acme',
          country: 'Malaysia',
          is_primary: true,
          teams: base.organisations[0].teams,
        }),
      ],
    });
    const delta = computeDelta(base, edited);
    assert.deepEqual(delta.relocated_orgs, [
      { org_key: 'primary', from_country: 'Singapore', to_country: 'Malaysia' },
    ]);
    assert.deepEqual(delta.new_countries, ['Malaysia']);
    assert.deepEqual(delta.vacated_countries, ['Singapore']);
  });

  test('changed_text records a team description without counting it as a rename', () => {
    const base = snapshot();
    const teams = base.organisations[0].teams.map((row) =>
      row.team_uid === 'uid-acme-a' ? { ...row, description: 'A new public voice' } : row,
    );
    const edited = snapshot({
      organisations: [
        org({
          org_uid: 'uid-acme',
          org_key: 'primary',
          display_name: 'Acme',
          is_primary: true,
          teams,
        }),
      ],
    });
    const delta = computeDelta(base, edited);
    assert.deepEqual(delta.changed_text, [
      { key: 'primary', field: 'description', team_uid: 'uid-acme-a' },
    ]);
    assert.deepEqual(delta.renamed_teams, []);
  });

  test('primary_swap uses org uids and marks an existing organisation as not new', () => {
    const base = snapshot({
      organisations: [
        org({ org_uid: 'uid-acme', org_key: 'primary', display_name: 'Acme', is_primary: true }),
        org({ org_uid: 'uid-my', org_key: 'org_acme_my', display_name: 'Acme Malaysia', country: 'Malaysia' }),
      ],
    });
    const edited = snapshot({
      organisations: [
        org({
          org_uid: 'uid-acme',
          org_key: 'primary',
          display_name: 'Acme',
          is_primary: false,
          teams: base.organisations[0].teams,
        }),
        org({
          org_uid: 'uid-my',
          org_key: 'org_acme_my',
          display_name: 'Acme Malaysia',
          country: 'Malaysia',
          is_primary: true,
          teams: base.organisations[1].teams,
        }),
      ],
    });
    assert.deepEqual(computeDelta(base, edited).primary_swap, {
      from_org_uid: 'uid-acme',
      to_org_uid: 'uid-my',
      to_is_new: false,
    });
  });

  test('brief_changed follows the crisis text and the document hash', () => {
    const base = snapshot();
    const edited = snapshot({
      crisis: { ...crisis, context: 'Day shift', uploaded_doc_text_hash: 'def' },
    });
    const delta = computeDelta(base, edited);
    assert.equal(delta.brief_changed, true);
    assert.equal(delta.empty, false);
    const countryOnly = snapshot({ crisis: { ...crisis, country: 'Malaysia', org_name: 'Other' } });
    assert.equal(computeDelta(base, countryOnly).brief_changed, false);
  });

  test('pressure target and country changes are not an empty delta', () => {
    const base = snapshot({
      pressure_organisations: [
        pressure({
          org_key: 'org_pressure_union_sg',
          country: 'Singapore',
          city: 'Jurong',
          kind: 'union',
          wants: 'A hearing',
          targets_org_keys: ['primary'],
          facebook_handle: '@union',
        }),
      ],
    });
    const edited = snapshot({
      pressure_organisations: [
        pressure({
          org_key: 'org_pressure_union_sg',
          country: 'Malaysia',
          city: 'Jurong',
          kind: 'union',
          wants: 'A hearing',
          targets_org_keys: ['org_acme_my'],
          facebook_handle: '@union',
        }),
      ],
    });
    const delta = computeDelta(base, edited);
    assert.equal(delta.empty, false);
    assert.deepEqual(delta.changed_text, [
      { key: 'org_pressure_union_sg', field: 'country' },
      { key: 'org_pressure_union_sg', field: 'targets_org_keys' },
    ]);
  });

  test('pressure city, kind and handles, and rival country and handles, are changed text', () => {
    const base = snapshot({
      pressure_organisations: [
        pressure({
          org_key: 'org_pressure_union_sg',
          city: 'Jurong',
          kind: 'union',
          x_handle: '@union_x',
        }),
      ],
      competitors: [
        rival({
          org_key: 'org_antagonist_rival_0',
          name: 'Rival Co',
          country: 'Singapore',
          facebook_handle: '@rival',
        }),
      ],
    });
    const edited = snapshot({
      pressure_organisations: [
        pressure({
          org_key: 'org_pressure_union_sg',
          city: 'Woodlands',
          kind: 'ngo',
          x_handle: '@union_new',
        }),
      ],
      competitors: [
        rival({
          org_key: 'org_antagonist_rival_0',
          name: 'Rival Co',
          country: 'Malaysia',
          facebook_handle: '@rival_my',
        }),
      ],
    });
    const delta = computeDelta(base, edited);
    assert.equal(delta.empty, false);
    assert.deepEqual(
      delta.changed_text.map((change) => change.field),
      ['city', 'kind', 'x_handle', 'country', 'facebook_handle'],
    );
  });

  test('a combined add, remove, rename and brief change', () => {
    const base = snapshot({
      organisations: [
        org({ org_uid: 'uid-acme', org_key: 'primary', display_name: 'Acme', is_primary: true }),
        org({ org_uid: 'uid-my', org_key: 'org_acme_my', display_name: 'Acme Malaysia', country: 'Malaysia' }),
      ],
      competitors: [rival({ org_key: 'org_antagonist_old', name: 'Old Rival' })],
    });
    const edited = snapshot({
      crisis: { ...crisis, crisis_type: 'Chemical fire' },
      organisations: [
        org({
          org_uid: 'uid-acme',
          org_key: 'primary',
          display_name: 'Acme Holdings',
          is_primary: true,
          teams: base.organisations[0].teams,
        }),
        org({ org_uid: 'uid-jp', org_key: 'org_acme_jp', display_name: 'Acme Japan', country: 'Japan' }),
      ],
      competitors: [rival({ org_key: 'org_antagonist_new', name: 'New Rival' })],
    });
    const delta = computeDelta(base, edited);
    assert.deepEqual(changed(delta, 'added_orgs'), ['org_acme_jp']);
    assert.deepEqual(delta.removed_orgs, ['org_acme_my']);
    assert.deepEqual(delta.renamed_orgs, [
      { org_key: 'primary', from: 'Acme', to: 'Acme Holdings' },
    ]);
    assert.equal(delta.brief_changed, true);
    assert.deepEqual(delta.removed_rivals, ['org_antagonist_old']);
    assert.deepEqual(delta.added_rivals, ['org_antagonist_new']);
    assert.equal(delta.empty, false);
  });
});
