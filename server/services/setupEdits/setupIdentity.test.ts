import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  validateOrganisations,
  type OrganisationIdentityOptions,
  type OrganisationInput,
  type OrganisationsValidation,
} from '../scenarioOrgModel.js';
import { computeDelta } from './setupDeltaCore.js';
import type { SetupCrisis, SetupSnapshot } from './setupSnapshotCore.js';

const crisis: SetupCrisis = {
  crisis_type: 'Plant fire',
  context: '',
  uploaded_doc_name: null,
  uploaded_doc_text_hash: null,
  country: 'Singapore',
  org_name: 'Sigma Logistics',
  duration: 60,
  auto_antagonist: true,
};

function roster(uids?: [string, string]): OrganisationInput['team_roster'] {
  return [
    {
      team_name: 'Communications',
      is_public_voice: true,
      ...(uids ? { team_uid: uids[0] } : {}),
    },
    { team_name: 'Legal', ...(uids ? { team_uid: uids[1] } : {}) },
  ];
}

const primary: OrganisationInput = {
  org_key: 'primary',
  org_uid: 'uid-primary',
  display_name: 'Sigma Logistics',
  short_name: 'SIG',
  country: 'Singapore',
  is_primary: true,
  team_roster: roster(['uid-comms', 'uid-legal']),
};

const second: OrganisationInput = {
  org_key: 'org_sigma_my',
  org_uid: 'uid-second',
  display_name: 'Sigma Malaysia',
  short_name: 'SM',
  country: 'Malaysia',
  is_primary: false,
  team_roster: roster(['uid-comms-my', 'uid-legal-my']),
};

const singleIdentity: OrganisationIdentityOptions = {
  baseline_org_keys: ['primary'],
  baseline_primary_org_key: 'primary',
  teams: [
    {
      team_uid: 'uid-comms',
      team_name: 'Communications',
      org_key: 'primary',
      function_key: 'Communications',
    },
    { team_uid: 'uid-legal', team_name: 'Legal', org_key: 'primary', function_key: 'Legal' },
  ],
};

const multiIdentity: OrganisationIdentityOptions = {
  baseline_org_keys: ['primary', 'org_sigma_my'],
  baseline_primary_org_key: 'primary',
  teams: [
    ...singleIdentity.teams!,
    {
      team_uid: 'uid-comms-my',
      team_name: 'Communications — SM',
      org_key: 'org_sigma_my',
      function_key: 'Communications',
    },
    {
      team_uid: 'uid-legal-my',
      team_name: 'Legal — SM',
      org_key: 'org_sigma_my',
      function_key: 'Legal',
    },
  ],
};

function mustOk(result: OrganisationsValidation): Extract<OrganisationsValidation, { ok: true }> {
  assert.equal(result.ok, true, result.ok ? '' : `${result.code}: ${result.message}`);
  if (!result.ok) throw new Error('unreachable');
  return result;
}

function toSnapshot(result: Extract<OrganisationsValidation, { ok: true }>): SetupSnapshot {
  return {
    crisis,
    organisations: result.orgs.map((org) => ({
      org_uid: org.org_uid ?? '',
      org_key: org.org_key,
      display_name: org.display_name,
      short_name: org.short_name,
      country: org.country,
      ...(org.city ? { city: org.city } : {}),
      kind: org.kind,
      operation: org.operation,
      is_primary: org.is_primary,
      ...(org.facebook_handle ? { facebook_handle: org.facebook_handle } : {}),
      ...(org.x_handle ? { x_handle: org.x_handle } : {}),
      teams: org.teams.map((team) => ({
        team_uid: team.team_uid ?? '',
        team_name: team.team_name,
        function_key: team.function_key,
        description: team.description,
        is_custom: team.is_custom,
        is_public_voice: team.is_public_voice,
      })),
    })),
    pressure_organisations: [],
    competitors: result.competitors.map((rival) => ({
      org_uid: '',
      org_key: rival.org_key,
      name: rival.name,
      country: rival.country,
      ...(rival.description ? { description: rival.description } : {}),
      auto_generated: false,
    })),
    inject_keys: [],
    multi_org: result.multiOrg,
  };
}

describe('setup edit identities', () => {
  test('a rival removed from the middle keeps the later rivals keys', () => {
    const rivals = [
      { name: 'Alpha Rival', country: 'Singapore', org_key: 'org_antagonist_alpha_0', description: 'First' },
      { name: 'Beta Rival', country: 'Singapore', org_key: 'org_antagonist_beta_1', description: 'Second' },
      { name: 'Gamma Rival', country: 'Malaysia', org_key: 'org_antagonist_gamma_2', description: 'Third' },
    ];
    const identities: OrganisationIdentityOptions = {
      ...multiIdentity,
      baseline_org_keys: [
        ...multiIdentity.baseline_org_keys,
        'org_antagonist_alpha_0',
        'org_antagonist_beta_1',
        'org_antagonist_gamma_2',
      ],
    };
    const edited = mustOk(
      validateOrganisations(
        [primary, second],
        [rivals[0], rivals[2]],
        [],
        identities,
      ),
    );
    assert.deepEqual(
      edited.competitors.map((rival) => rival.org_key),
      ['org_antagonist_alpha_0', 'org_antagonist_gamma_2'],
    );
  });

  test('a renamed team keeps its team_uid', () => {
    const edited = mustOk(
      validateOrganisations(
        [
          {
            ...primary,
            team_roster: [
              {
                team_name: 'Media Desk',
                description: 'Handles the public message',
                is_custom: true,
                is_public_voice: true,
                team_uid: 'uid-comms',
              },
              { team_name: 'Legal', team_uid: 'uid-legal' },
            ],
          },
        ],
        [],
        [],
        singleIdentity,
      ),
    );
    const renamed = edited.orgs[0].teams.find((team) => team.team_uid === 'uid-comms');
    assert.ok(renamed);
    assert.equal(renamed.team_name, 'Media Desk');
    assert.equal(renamed.team_uid, 'uid-comms');
  });

  test('single-to-multi keeps bare names unless the option is on', () => {
    const added: OrganisationInput = {
      display_name: 'Northwind Freight',
      country: 'Malaysia',
      is_primary: false,
      team_roster: roster(),
    };
    const off = mustOk(validateOrganisations([primary, added], [], [], singleIdentity));
    const primaryOff = off.orgs.find((org) => org.org_key === 'primary');
    assert.ok(primaryOff);
    assert.deepEqual(
      primaryOff.teams.map((team) => team.team_name),
      ['Communications', 'Legal'],
    );
    const on = mustOk(
      validateOrganisations([primary, added], [], [], {
        ...singleIdentity,
        compose_existing_team_names: true,
      }),
    );
    const primaryOn = on.orgs.find((org) => org.org_key === 'primary');
    assert.deepEqual(
      primaryOn?.teams.map((team) => team.team_name),
      ['Communications — SIG', 'Legal — SIG'],
    );
  });

  test('removing the primary fails without make_primary and passes with it', () => {
    const removed = validateOrganisations([second], [], [], multiIdentity);
    assert.equal(removed.ok, false);
    if (removed.ok) return;
    assert.equal(removed.code, 'MO-EDIT-001');
    assert.match(removed.message, /Make another organisation primary first/);

    const swapped = mustOk(
      validateOrganisations([second], [], [], { ...multiIdentity, make_primary: 'org_sigma_my' }),
    );
    const next = swapped.orgs.find((org) => org.is_primary);
    assert.equal(next?.org_key, 'org_sigma_my');
    assert.equal(next?.org_uid, 'uid-second');
  });

  test('make_primary on an AI-operated organisation fails MO-ORG-007', () => {
    const result = validateOrganisations(
      [primary, { ...second, operation: 'ai' }],
      [],
      [],
      { ...multiIdentity, make_primary: 'org_sigma_my' },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'MO-ORG-007');
  });

  test('make_primary on a newly added organisation gives primary_swap.to_is_new', () => {
    const fresh: OrganisationInput = {
      org_key: 'org_fresh_handle',
      org_uid: 'uid-fresh',
      display_name: 'Fresh Office',
      short_name: 'FR',
      country: 'Malaysia',
      is_primary: false,
      team_roster: roster(),
    };
    const baseline = mustOk(validateOrganisations([primary], [], [], singleIdentity));
    const edited = mustOk(
      validateOrganisations([primary, fresh], [], [], {
        ...singleIdentity,
        make_primary: 'org_fresh_handle',
      }),
    );
    const next = edited.orgs.find((org) => org.is_primary);
    assert.ok(next);
    assert.equal(next.org_uid, 'uid-fresh');
    assert.notEqual(next.org_key, 'primary');
    assert.equal(
      edited.orgs.find((org) => org.org_key === 'primary')?.is_primary,
      false,
    );
    const delta = computeDelta(toSnapshot(baseline), toSnapshot(edited));
    assert.deepEqual(delta.primary_swap, {
      from_org_uid: 'uid-primary',
      to_org_uid: 'uid-fresh',
      to_is_new: true,
    });
  });

  test('renaming onto an active name fails, and onto a retired name passes', () => {
    const ontoActive = validateOrganisations(
      [
        {
          ...primary,
          team_roster: [
            { team_name: 'Legal', is_public_voice: true, team_uid: 'uid-comms' },
            { team_name: 'Legal', team_uid: 'uid-legal' },
          ],
        },
      ],
      [],
      [],
      singleIdentity,
    );
    assert.equal(ontoActive.ok, false);
    if (!ontoActive.ok) assert.equal(ontoActive.code, 'MO-TEAM-001');

    const ontoRetired = mustOk(
      validateOrganisations(
        [
          {
            ...primary,
            team_roster: [
              {
                team_name: 'Archive Desk',
                description: 'Keeps the retired public record',
                is_custom: true,
                is_public_voice: true,
                team_uid: 'uid-comms',
              },
              { team_name: 'Legal', team_uid: 'uid-legal' },
            ],
          },
        ],
        [],
        [],
        singleIdentity,
      ),
    );
    const renamed = ontoRetired.orgs[0].teams.find((team) => team.team_uid === 'uid-comms');
    assert.equal(renamed?.team_name, 'Archive Desk');
  });

  test('a new organisation key avoids baseline and retired keys', () => {
    const added: OrganisationInput = {
      display_name: 'Fresh Office',
      short_name: 'FR',
      country: 'Malaysia',
      is_primary: false,
      team_roster: roster(),
    };
    const result = mustOk(
      validateOrganisations([primary, added], [], [], {
        ...singleIdentity,
        retired_org_keys: ['org_fr_my'],
      }),
    );
    const created = result.orgs.find((org) => org.org_uid !== 'uid-primary');
    assert.ok(created);
    assert.equal(created.org_key, 'org_fr_my_2');
    assert.notEqual(created.org_key, 'primary');
  });
});
