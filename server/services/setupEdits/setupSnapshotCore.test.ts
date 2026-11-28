import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { canonicalJson } from '../../../shared/canonicalJson.js';
import { stampOrgIdentity } from '../../lib/templateRows.js';
import {
  baselineHash,
  draftInputFromSnapshot,
  hashUploadedDocument,
  materializeLegacyPrimary,
  setupSourceFromCompile,
  snapshotFromScenario,
  stableOrgUid,
  type ScenarioSnapshotSource,
  type SetupSnapshot,
} from './setupSnapshotCore.js';

function multiOrgSource(): ScenarioSnapshotSource {
  return {
    scenario: {
      description: 'ignored when setup_source exists',
      briefing: 'ignored',
      duration_minutes: 90,
      initial_state: {
        org_name: 'Acme',
        country: 'Singapore',
        setup_source: {
          crisis_type: 'Plant fire',
          context: 'Night shift',
          uploaded_doc_name: 'brief.pdf',
          uploaded_doc_text_hash: 'abc',
          country: 'Singapore',
          org_name: 'Acme',
          duration: 60,
          auto_antagonist: false,
        },
        orgs: [
          {
            org_uid: 'uid-acme',
            org_key: 'primary',
            display_name: 'Acme',
            short_name: 'ACME',
            country: 'Singapore',
            city: 'Jurong',
            kind: 'company',
            side: 'protagonist',
            is_primary: true,
            operation: 'players',
          },
          {
            org_uid: 'uid-my',
            org_key: 'org_acme_my',
            display_name: 'Acme Malaysia',
            short_name: 'AM',
            country: 'Malaysia',
            city: 'Johor Bahru',
            kind: 'office',
            side: 'protagonist',
            operation: 'ai',
          },
          {
            org_uid: 'uid-union',
            org_key: 'org_pressure_union_my',
            display_name: 'Harbour Union',
            country: 'Malaysia',
            kind: 'union',
            side: 'pressure',
          },
          {
            org_uid: 'uid-rival',
            org_key: 'org_antagonist_rival_0',
            display_name: 'Rival Co',
            country: 'Singapore',
            side: 'antagonist',
          },
        ],
        org_page: {
          orgs: [
            {
              org_uid: 'uid-acme',
              org_key: 'primary',
              display_name: 'Acme',
              role: 'protagonist',
              is_primary: true,
              facebook: { page_handle: '@acme' },
              x_twitter: { page_handle: '@acme_x' },
            },
            {
              org_uid: 'uid-union',
              org_key: 'org_pressure_union_my',
              role: 'pressure',
              display_name: 'Harbour Union',
              posture: {
                mandate: 'A public inquiry',
                register: 'advocacy',
                targets_org_keys: ['org_acme_my'],
              },
            },
            {
              org_uid: 'uid-rival',
              org_key: 'org_antagonist_rival_0',
              role: 'antagonist',
              display_name: 'Rival Co',
              stance: 'Positions itself as the safer alternative',
              auto_generated: false,
              facebook: { page_handle: '@rival' },
            },
            {
              org_uid: 'uid-auto',
              org_key: 'org_antagonist_auto_1',
              role: 'antagonist',
              display_name: 'Invented Rival',
              country: 'Singapore',
              stance: 'Feeds the rumour',
              auto_generated: true,
            },
          ],
        },
      },
    },
    teams: [
      {
        id: 'row-legal',
        team_uid: 'uid-legal',
        team_name: 'Legal',
        team_description: 'Advise the company',
        org_key: 'primary',
        function_key: 'Legal',
        charter: { is_custom: false, can_post_publicly: false },
      },
      {
        id: 'row-comms',
        team_uid: 'uid-comms',
        team_name: 'Communications — ACME',
        team_description: 'Speak for Acme',
        org_key: 'primary',
        function_key: 'Communications',
        charter: { is_custom: false, can_post_publicly: true },
      },
      {
        id: 'row-my-comms',
        team_uid: 'uid-my-comms',
        team_name: 'Communications — AM',
        org_key: 'org_acme_my',
        function_key: 'Communications',
        charter: { is_custom: false, can_post_publicly: true },
      },
      {
        id: 'row-my-legal',
        team_uid: 'uid-my-legal',
        team_name: 'Legal — AM',
        org_key: 'org_acme_my',
        function_key: 'Legal',
      },
    ],
    injects: [
      { id: '11111111-1111-4111-8111-111111111111', delivery_config: { inject_key: 'plant_alert' } },
      { id: '22222222-2222-4222-8222-222222222222', delivery_config: {} },
    ],
  };
}

describe('setup snapshot', () => {
  test('a multi-org scenario round-trips orgs, teams, pages and inject keys', () => {
    const snapshot = snapshotFromScenario(multiOrgSource());
    assert.equal(snapshot.multi_org, true);
    assert.equal(snapshot.crisis.crisis_type, 'Plant fire');
    assert.equal(snapshot.crisis.context, 'Night shift');
    assert.equal(snapshot.crisis.duration, 60);
    assert.equal(snapshot.crisis.auto_antagonist, false);
    assert.equal(snapshot.crisis.reconstructed, undefined);
    assert.deepEqual(
      snapshot.organisations.map((org) => ({
        org_uid: org.org_uid,
        org_key: org.org_key,
        display_name: org.display_name,
        short_name: org.short_name,
        country: org.country,
        city: org.city,
        kind: org.kind,
        operation: org.operation,
        is_primary: org.is_primary,
        facebook_handle: org.facebook_handle,
        x_handle: org.x_handle,
        teams: org.teams,
      })),
      [
        {
          org_uid: 'uid-acme',
          org_key: 'primary',
          display_name: 'Acme',
          short_name: 'ACME',
          country: 'Singapore',
          city: 'Jurong',
          kind: 'company',
          operation: 'players',
          is_primary: true,
          facebook_handle: '@acme',
          x_handle: '@acme_x',
          teams: [
            {
              team_uid: 'uid-comms',
              team_name: 'Communications — ACME',
              function_key: 'Communications',
              description: 'Speak for Acme',
              is_custom: false,
              is_public_voice: true,
            },
            {
              team_uid: 'uid-legal',
              team_name: 'Legal',
              function_key: 'Legal',
              description: 'Advise the company',
              is_custom: false,
              is_public_voice: false,
            },
          ],
        },
        {
          org_uid: 'uid-my',
          org_key: 'org_acme_my',
          display_name: 'Acme Malaysia',
          short_name: 'AM',
          country: 'Malaysia',
          city: 'Johor Bahru',
          kind: 'office',
          operation: 'ai',
          is_primary: false,
          facebook_handle: undefined,
          x_handle: undefined,
          teams: [
            {
              team_uid: 'uid-my-comms',
              team_name: 'Communications — AM',
              function_key: 'Communications',
              description: '',
              is_custom: false,
              is_public_voice: true,
            },
            {
              team_uid: 'uid-my-legal',
              team_name: 'Legal — AM',
              function_key: 'Legal',
              description: '',
              is_custom: false,
              is_public_voice: false,
            },
          ],
        },
      ],
    );
    assert.deepEqual(snapshot.inject_keys, ['inj_22222222', 'plant_alert']);
  });

  test('a legacy single-org scenario becomes one primary organisation', () => {
    const snapshot = snapshotFromScenario(
      {
        scenario: {
          description: 'Old brief',
          briefing: 'What we remember',
          duration_minutes: 45,
          initial_state: { org_name: 'Legacy Co', country: 'Singapore' },
        },
        teams: [
          { id: 'team-comms', team_name: 'Communications', org_key: null, function_key: 'Communications' },
          { id: 'team-legal', team_name: 'Legal', org_key: null, function_key: 'Legal' },
        ],
        injects: [],
      },
      { assignOrgUid: () => 'uid-legacy' },
    );
    assert.equal(snapshot.multi_org, false);
    assert.equal(snapshot.organisations.length, 1);
    const org = snapshot.organisations[0];
    assert.equal(org.org_key, 'primary');
    assert.equal(org.org_uid, 'uid-legacy');
    assert.equal(org.is_primary, true);
    assert.equal(org.display_name, 'Legacy Co');
    assert.equal(org.country, 'Singapore');
    assert.deepEqual(
      org.teams.map((team) => team.team_name),
      ['Communications', 'Legal'],
    );
    assert.equal(org.teams[0].team_uid, 'team-comms');
    assert.equal(snapshot.crisis.reconstructed, true);
    assert.equal(snapshot.crisis.crisis_type, 'Old brief');
    assert.equal(snapshot.crisis.context, 'What we remember');
    assert.equal(snapshot.crisis.duration, 45);
  });

  test('rival stance becomes the description and pressure mandate becomes wants', () => {
    const snapshot = snapshotFromScenario(multiOrgSource());
    const rival = snapshot.competitors.find((org) => org.org_key === 'org_antagonist_rival_0');
    const invented = snapshot.competitors.find((org) => org.org_key === 'org_antagonist_auto_1');
    assert.ok(rival);
    assert.equal(rival.description, 'Positions itself as the safer alternative');
    assert.equal(rival.auto_generated, false);
    assert.equal(rival.facebook_handle, '@rival');
    assert.equal(rival.org_uid, 'uid-rival');
    assert.ok(invented);
    assert.equal(invented.auto_generated, true);
    assert.equal(invented.description, 'Feeds the rumour');
    const pressure = snapshot.pressure_organisations[0];
    assert.equal(pressure.org_key, 'org_pressure_union_my');
    assert.equal(pressure.org_uid, 'uid-union');
    assert.equal(pressure.wants, 'A public inquiry');
    assert.equal(pressure.register, 'advocacy');
    assert.deepEqual(pressure.targets_org_keys, ['org_acme_my']);
  });

  test('an older scenario falls back to the build request, then to description and briefing', () => {
    const fromBuild = snapshotFromScenario({
      scenario: {
        description: 'Row description',
        briefing: 'Row briefing',
        duration_minutes: 45,
        initial_state: { org_name: 'Acme', country: 'Singapore' },
      },
      teams: [],
      injects: [],
      build_request: {
        crisis_type: 'From the build',
        context: 'Stored context',
        country: 'Malaysia',
        org_name: 'Build Org',
        duration: 30,
        auto_antagonist: false,
      },
    });
    assert.equal(fromBuild.crisis.reconstructed, undefined);
    assert.equal(fromBuild.crisis.crisis_type, 'From the build');
    assert.equal(fromBuild.crisis.context, 'Stored context');
    assert.equal(fromBuild.crisis.country, 'Malaysia');
    assert.equal(fromBuild.crisis.org_name, 'Build Org');
    assert.equal(fromBuild.crisis.auto_antagonist, false);

    const guessed = snapshotFromScenario({
      scenario: {
        description: 'Row description',
        briefing: 'Row briefing',
        duration_minutes: 45,
        initial_state: { org_name: 'Acme', country: 'Singapore' },
      },
      teams: [],
      injects: [],
    });
    assert.equal(guessed.crisis.reconstructed, true);
    assert.equal(guessed.crisis.crisis_type, 'Row description');
    assert.equal(guessed.crisis.context, 'Row briefing');
    assert.equal(guessed.crisis.org_name, 'Acme');
  });

  test('the baseline hash ignores inject keys and object key order', () => {
    const snapshot = snapshotFromScenario(multiOrgSource());
    const reshuffled: SetupSnapshot = {
      inject_keys: ['zzz', 'aaa'],
      multi_org: snapshot.multi_org,
      organisations: snapshot.organisations,
      pressure_organisations: snapshot.pressure_organisations,
      competitors: snapshot.competitors,
      crisis: {
        auto_antagonist: snapshot.crisis.auto_antagonist,
        duration: snapshot.crisis.duration,
        org_name: snapshot.crisis.org_name,
        country: snapshot.crisis.country,
        uploaded_doc_text_hash: snapshot.crisis.uploaded_doc_text_hash,
        uploaded_doc_name: snapshot.crisis.uploaded_doc_name,
        context: snapshot.crisis.context,
        crisis_type: snapshot.crisis.crisis_type,
      },
    };
    assert.equal(baselineHash(snapshot), baselineHash(reshuffled));
    const renamed: SetupSnapshot = {
      ...snapshot,
      organisations: snapshot.organisations.map((org, index) =>
        index === 0 ? { ...org, display_name: 'Renamed' } : org,
      ),
    };
    assert.notEqual(baselineHash(snapshot), baselineHash(renamed));
  });

  test('compile stores a document hash and not the document text', () => {
    const text = 'The full uploaded brief';
    const source = setupSourceFromCompile({
      crisis_type: 'Plant fire',
      context: 'Night shift',
      uploaded_doc_name: 'brief.pdf',
      uploaded_doc_text: text,
      country: 'Singapore',
      org_name: 'Acme',
      duration: 60,
      auto_antagonist: true,
    });
    assert.equal(source.uploaded_doc_text_hash, hashUploadedDocument(text));
    assert.equal(JSON.stringify(source).includes(text), false);
    assert.equal(setupSourceFromCompile({ uploaded_doc_text: '   ' }).uploaded_doc_text_hash, null);
  });

  test('a legacy page-only scenario gets a stable primary org_uid', () => {
    const legacy = {
      org_name: 'Legacy Co',
      country: 'Singapore',
      org_page: {
        facebook: { page_name: 'Legacy', page_handle: '@legacy', page_bio: '', follower_count: 1 },
        x_twitter: { page_name: 'Legacy', page_handle: '@legacy_x', page_bio: '', follower_count: 1 },
      },
    };
    const prepared = stampOrgIdentity(materializeLegacyPrimary(legacy, 'scenario-legacy'));
    const again = stampOrgIdentity(materializeLegacyPrimary(legacy, 'scenario-legacy'));
    assert.equal(canonicalJson(prepared), canonicalJson(again));
    const orgs = (prepared as unknown as { orgs: Array<{ org_uid: string; org_key: string }> }).orgs;
    assert.equal(orgs[0].org_key, 'primary');
    assert.equal(orgs[0].org_uid, stableOrgUid('scenario-legacy', 'primary'));
    const snapshot = snapshotFromScenario(
      {
        scenario: { description: 'Old brief', briefing: '', initial_state: prepared },
        teams: [],
        injects: [],
      },
      { assignOrgUid: (orgKey) => stableOrgUid('scenario-legacy', orgKey) },
    );
    assert.equal(snapshot.organisations[0].org_uid, orgs[0].org_uid);
    assert.equal(snapshot.organisations[0].facebook_handle, '@legacy');
    assert.notEqual(
      stableOrgUid('scenario-legacy', 'primary'),
      stableOrgUid('scenario-other', 'primary'),
    );
  });

  test('a page that already lists organisations is not given an orgs registry', () => {
    const pageUid = '11111111-1111-4111-8111-111111111111';
    const allyUid = '22222222-2222-4222-8222-222222222222';
    const state = {
      org_name: 'HQ',
      country: 'Singapore',
      org_page: {
        orgs: [
          {
            org_key: 'primary',
            org_uid: pageUid,
            display_name: 'HQ',
            is_primary: true,
            role: 'protagonist',
          },
          { org_key: 'org_ally_sg', org_uid: allyUid, display_name: 'Ally', role: 'protagonist' },
          { org_key: 'org_antagonist_rival_0', display_name: 'Rival', role: 'antagonist' },
        ],
      },
    };
    const materialized = materializeLegacyPrimary(state, 'scenario-pages');
    assert.equal(materialized, state);
    assert.equal(Object.hasOwn(materialized, 'orgs'), false);
    const prepared = stampOrgIdentity(materialized) as unknown as {
      orgs?: unknown;
      org_page: { orgs: Array<{ org_key: string; org_uid: string }> };
      org_key_history: Array<{ org_uid: string; org_key: string; until_edit: string | null }>;
    };
    assert.equal(prepared.orgs, undefined);
    assert.equal(prepared.org_page.orgs[0].org_uid, pageUid);
    assert.equal(prepared.org_page.orgs[1].org_uid, allyUid);
    const openPrimary = prepared.org_key_history.filter(
      (entry) => entry.org_key === 'primary' && entry.until_edit == null,
    );
    assert.equal(openPrimary.length, 1);
    assert.equal(openPrimary[0].org_uid, pageUid);
  });

  test('a missing org_uid is derived from that organisation key', () => {
    const snapshot = snapshotFromScenario(
      {
        scenario: {
          initial_state: {
            orgs: [
              {
                org_key: 'primary',
                display_name: 'Acme',
                country: 'Singapore',
                side: 'protagonist',
                is_primary: true,
              },
              {
                org_key: 'org_ally_sg',
                display_name: 'Ally',
                country: 'Singapore',
                side: 'protagonist',
              },
            ],
          },
        },
        teams: [],
        injects: [],
      },
      { assignOrgUid: (orgKey) => stableOrgUid('scenario-keys', orgKey) },
    );
    const [primary, ally] = snapshot.organisations;
    assert.equal(primary.org_uid, stableOrgUid('scenario-keys', 'primary'));
    assert.equal(ally.org_uid, stableOrgUid('scenario-keys', 'org_ally_sg'));
    assert.notEqual(primary.org_uid, ally.org_uid);
  });

  test('the edit draft uses wizard input keys and pins identities', () => {
    const snapshot = snapshotFromScenario(multiOrgSource());
    const input = draftInputFromSnapshot(snapshot, {
      edit_id: 'edit-1',
      scenario_id: 'scenario-1',
      scenario_title: 'Acme crisis',
      remaining: 2,
    });
    assert.equal(input.sim_mode, 'social_media');
    assert.equal(input.crisis_description, 'Plant fire');
    assert.equal(input.org_name, 'Acme');
    assert.equal(input.country, 'Singapore');
    assert.equal(input.context, 'Night shift');
    assert.equal(input.primary_org_key, 'primary');
    assert.equal(input.primary_org_uid, 'uid-acme');
    assert.equal(input.auto_antagonist, false);
    const roster = input.team_roster as Array<{ team_name: string; team_uid: string }>;
    assert.equal(roster[0].team_name, 'Communications');
    assert.equal(roster[0].team_uid, 'uid-comms');
    const extras = input.extra_organisations as Array<{ org_key: string; org_uid: string }>;
    assert.equal(extras.length, 1);
    assert.equal(extras[0].org_key, 'org_acme_my');
    assert.equal(extras[0].org_uid, 'uid-my');
    const rivals = input.competitor_entries as Array<{ org_key: string }>;
    assert.deepEqual(
      rivals.map((rival) => rival.org_key),
      ['org_antagonist_rival_0'],
    );
    assert.deepEqual(input.setup_edit, {
      edit_id: 'edit-1',
      scenario_id: 'scenario-1',
      scenario_title: 'Acme crisis',
      remaining: 2,
    });
    assert.equal(input.brief_reconstructed, undefined);
  });
});
