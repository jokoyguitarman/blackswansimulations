import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { COUNTRIES } from '../../../shared/countries.js';
import { env } from '../../env.js';
import {
  validateOrganisations,
  type OrganisationInput,
  type RosterEntryInput,
} from '../scenarioOrgModel.js';
import { estimateBuildCalls } from './buildEstimate.js';
import {
  organisationsSchema,
  pressureOrganisationsSchema,
  teamRosterSchema,
} from './wireSchemas.js';

/**
 * Acceptance stand-in for a stubbed 20-organisation, 7-team build that compiles
 * and starts. Compile and session start write to Supabase, so this checks the
 * gates those steps share: wire validation, normalisation, and the pre-build
 * call estimate. It does not run the generation pipeline or open a session.
 */
describe('a 20-organisation cast with 7-team rosters', () => {
  const roster: RosterEntryInput[] = [
    { team_name: 'Communications', is_public_voice: true },
    { team_name: 'Legal' },
    { team_name: 'Stakeholder Engagement' },
    { team_name: 'Shareholder Engagement' },
    { team_name: 'Executive' },
    {
      team_name: 'Facilities',
      is_custom: true,
      description: 'Keeps each site running through the crisis',
    },
    {
      team_name: 'Security',
      is_custom: true,
      description: 'Protects people on site and the premises',
    },
  ];

  const organisations: OrganisationInput[] = COUNTRIES.slice(0, 20).map((country, index) => ({
    display_name: `${country.name} Response`,
    short_name: `C${index}`,
    country: country.name,
    is_primary: index === 0,
    operation: 'players' as const,
    team_roster: roster,
  }));

  test('validates, normalises, and estimates a build', () => {
    assert.equal(teamRosterSchema.safeParse(roster).success, true);
    assert.equal(organisationsSchema.safeParse(organisations).success, true);
    assert.equal(
      pressureOrganisationsSchema.safeParse([
        {
          display_name: 'Regional Watch',
          kind: 'ngo',
          country: 'Singapore',
          targets_org_keys: organisations.map((_, index) => `org_${index}`),
        },
      ]).success,
      true,
    );

    const result = validateOrganisations(organisations, []);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.orgs.length, 20);
    assert.equal(result.orgs[0].org_key, 'primary');
    assert.equal(result.orgs[0].operation, 'players');
    assert.ok(result.orgs.every((org) => org.teams.length === 7));
    const names = result.orgs.flatMap((org) => org.teams.map((team) => team.team_name));
    assert.equal(names.length, 140);
    assert.equal(new Set(names.map((name) => name.toLowerCase())).size, 140);
    assert.equal(new Set(result.orgs.map((org) => org.org_key)).size, 20);

    const calls = estimateBuildCalls({
      countries: 20,
      orgs: 20,
      teams: 140,
      customTeams: 40,
      alliesAndRivals: 19,
      pressureCountries: 0,
      pressureOrgs: 0,
      spilloverCountries: 0,
      injectsEstimate: 0,
    });
    assert.equal(
      calls,
      estimateBuildCalls({
        countries: new Set(result.orgs.map((org) => org.country)).size,
        orgs: result.orgs.length,
        teams: names.length,
        customTeams: result.orgs.reduce(
          (sum, org) => sum + org.teams.filter((team) => team.is_custom).length,
          0,
        ),
        alliesAndRivals: result.orgs.length - 1,
        pressureCountries: 0,
        pressureOrgs: 0,
        spilloverCountries: 0,
        injectsEstimate: 0,
      }),
    );
    assert.ok(calls > env.warroomLargeBuildConfirmCalls);
  });
});
