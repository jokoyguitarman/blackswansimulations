import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectSetupIssues,
  competitorField,
  isSendablePressureOrg,
  issuesFromServer,
  orgField,
  pickIssue,
  pressureField,
  teamField,
  type SetupIssue,
  type SetupSnapshot,
} from '../src/components/Scenario/setupValidation';
import type { RosterEntry } from '../src/components/Scenario/OrganisationRosterBuilder';
import { validateOrganisations } from '../../server/services/scenarioOrgModel.js';
import {
  competitorsSchema,
  organisationsSchema,
  pressureOrganisationsSchema,
} from '../../server/services/multiOrgPipeline.js';

const preset = (team_name: string): RosterEntry => ({
  team_name,
  description: '',
  is_custom: false,
  is_public_voice: team_name === 'Communications',
});
const custom = (
  team_name: string,
  description = 'Handles franchisee contracts and dealer complaints',
): RosterEntry => ({ team_name, description, is_custom: true, is_public_voice: false });

function base(): SetupSnapshot {
  return {
    brief:
      'A fire at the Johor plant injured six workers; the union says safety warnings were ignored for months.',
    primary: {
      name: 'Meridian Technologies',
      country: 'Singapore',
      city: '',
      kind: 'company',
      roster: [preset('Communications'), preset('Legal'), preset('Stakeholder Engagement')],
    },
    extras: [
      {
        id: 'org_a',
        display_name: 'Meridian Malaysia',
        short_name: '',
        country: 'Malaysia',
        city: 'Johor Bahru',
        kind: 'office',
        facebook_handle: '',
        x_handle: '',
        team_roster: [preset('Communications'), preset('Legal')],
      },
    ],
    pressure: [
      {
        id: 'prs_a',
        display_name: 'Ministry of Human Resources',
        kind: 'regulator',
        country: 'Malaysia',
        city: '',
        register: 'statutory',
        wants: '',
        facebook_handle: '',
        x_handle: '',
      },
    ],
    competitors: [{ name: 'Apex Systems', country: 'Singapore' }],
  };
}

const errors = (s: SetupSnapshot) => collectSetupIssues(s).filter((i) => i.severity === 'error');
const warnings = (s: SetupSnapshot) =>
  collectSetupIssues(s).filter((i) => i.severity === 'warning');
const on = (issues: SetupIssue[], field: string) => issues.filter((i) => i.field === field);

/** The payload the wizard sends (organisationsPayload / competitorsPayload / pressure payload). */
function payloadOf(s: SetupSnapshot) {
  const roster = (r: RosterEntry[]) =>
    r.map((t) => ({
      team_name: t.team_name.trim(),
      description: t.description.trim() || undefined,
      is_custom: t.is_custom,
      is_public_voice: t.is_public_voice,
    }));
  return {
    organisations: [
      {
        display_name: s.primary.name.trim() || 'Organisation',
        short_name: s.primary.shortName?.trim() || undefined,
        country: s.primary.country,
        city: s.primary.city.trim() || undefined,
        kind: s.primary.kind,
        is_primary: true,
        team_roster: roster(s.primary.roster),
      },
      ...s.extras.map((o) => ({
        display_name: o.display_name.trim(),
        short_name: o.short_name.trim() || undefined,
        country: o.country,
        city: o.city.trim() || undefined,
        kind: o.kind,
        facebook_handle: o.facebook_handle.trim() || undefined,
        x_handle: o.x_handle.trim() || undefined,
        is_primary: false,
        operation: o.operation === 'ai' ? ('ai' as const) : ('players' as const),
        team_roster: roster(o.team_roster),
      })),
    ],
    competitors: s.competitors.map((c) => ({
      name: c.name.trim(),
      country: c.country,
      facebook_handle: c.facebook_handle || undefined,
      x_handle: c.x_handle || undefined,
    })),
    pressure_organisations: s.pressure.filter(isSendablePressureOrg).map((p) => ({
      display_name: p.display_name.trim(),
      kind: p.kind,
      country: p.country,
      city: p.city.trim() || undefined,
      register: p.register,
      wants: p.wants.trim() || undefined,
      facebook_handle: p.facebook_handle.trim() || undefined,
      x_handle: p.x_handle.trim() || undefined,
    })),
  };
}

/** What the server would answer: the route's 400 body, or null when it accepts. */
function serverRefusal(s: SetupSnapshot): { details: unknown[] } | null {
  const p = payloadOf(s);
  for (const [key, schema] of [
    ['organisations', organisationsSchema],
    ['competitors', competitorsSchema],
    ['pressure_organisations', pressureOrganisationsSchema],
  ] as const) {
    const parsed = schema.safeParse(p[key]);
    if (!parsed.success) {
      return {
        details: parsed.error.issues.map((e) => ({
          field: ['body', key, ...e.path].join('.'),
          message: e.message,
        })),
      };
    }
  }
  const result = validateOrganisations(
    structuredClone(p.organisations),
    p.competitors,
    p.pressure_organisations,
  );
  return result.ok ? null : { details: result.details };
}

describe('collectSetupIssues', () => {
  test('a complete setup has nothing to fix', () => {
    assert.deepEqual(collectSetupIssues(base()), []);
  });

  test('reports every problem at once, in page order', () => {
    const s = base();
    s.brief = 'Fire at plant';
    s.primary.roster = [...s.primary.roster, custom('')];
    s.pressure[0].display_name = '';
    s.competitors = [{ name: 'X', country: 'Singapore' }];
    const found = errors(s);
    assert.deepEqual(
      found.map((i) => i.scope),
      ['brief', 'org', 'pressure', 'rival'],
    );
    assert.match(found[0].message, /37 more/);
  });

  test('a custom team named after a preset is pinned to its name input (1 Oct failure)', () => {
    const s = base();
    s.extras[0].team_roster = [...s.extras[0].team_roster, custom('Stakeholder Engagement')];
    const [issue] = on(errors(s), teamField('org_a', 2, 'name'));
    assert.ok(issue);
    assert.match(issue.message, /"Stakeholder Engagement" is a preset team/);
    assert.match(issue.message, /Tick the Stakeholder Engagement card/);
  });

  test('a blank custom team is asked for a name, then a description (24 Sep failure)', () => {
    const s = base();
    s.primary.roster = [...s.primary.roster, custom('', '')];
    const found = errors(s);
    assert.equal(on(found, teamField('primary', 3, 'name')).length, 1);
    assert.equal(on(found, teamField('primary', 3, 'description')).length, 0);
    s.primary.roster[3] = custom('Youth Outreach', 'short');
    assert.match(on(errors(s), teamField('primary', 3, 'description'))[0].message, /at least 10/);
  });

  test('duplicates: team names (any case), the 40-character cut, organisation names', () => {
    const s = base();
    s.primary.roster = [
      ...s.primary.roster,
      custom('Youth Outreach'),
      custom('youth outreach'),
      custom('Regional Community Relations and Partnerships North'),
      custom('Regional Community Relations and Partnerships South'),
    ];
    s.extras[0].display_name = 'meridian technologies';
    const found = errors(s);
    assert.match(on(found, teamField('primary', 4, 'name'))[0].message, /already a team called/);
    assert.match(on(found, teamField('primary', 6, 'name'))[0].message, /first 40 characters/);
    assert.match(on(found, orgField('org_a', 'name'))[0].message, /already uses this name/);
  });

  test('a long custom name warns with the name it will get, without blocking', () => {
    const s = base();
    s.primary.roster = [
      ...s.primary.roster,
      custom('community engagement for the northern region'),
    ];
    assert.equal(errors(s).length, 0);
    const [w] = on(warnings(s), teamField('primary', 3, 'name'));
    assert.match(w.message, /"Community Engagement For The Northern Re"/);
  });

  test('countries not in the list, on organisations and pressure groups', () => {
    const s = base();
    s.extras[0].country = 'Atlantis';
    s.pressure[0].country = '';
    const found = errors(s);
    assert.match(on(found, orgField('org_a', 'country'))[0].message, /"Atlantis" isn't/);
    assert.match(on(found, pressureField('prs_a', 'country'))[0].message, /Pick a country/);
  });

  test('pressure group names must differ from every organisation and group', () => {
    const s = base();
    s.pressure.push({ ...s.pressure[0], id: 'prs_b', display_name: 'Meridian Malaysia' });
    assert.match(
      on(errors(s), pressureField('prs_b', 'name'))[0].message,
      /One of your organisations already uses this name/,
    );
  });

  test('likely duplicate pressure groups are flagged softly', () => {
    const s = base();
    s.pressure.push({ ...s.pressure[0], id: 'prs_b', display_name: 'Ministry of Manpower' });
    s.pressure.push({
      ...s.pressure[0],
      id: 'prs_c',
      kind: 'ngo',
      display_name: 'Ministry of Human Resources (Malaysia)',
    });
    assert.equal(errors(s).length, 0);
    assert.match(on(warnings(s), pressureField('prs_b', 'name'))[0].message, /also a regulator/);
    assert.match(on(warnings(s), pressureField('prs_c', 'name'))[0].message, /same body/);
  });

  test('public bodies set as a company get an amber nudge', () => {
    const s = base();
    s.extras[0].display_name = 'Western Mindanao Command';
    assert.match(on(warnings(s), orgField('org_a', 'kind'))[0].message, /Government agency/);
    s.extras[0].kind = 'agency';
    assert.equal(on(warnings(s), orgField('org_a', 'kind')).length, 0);
  });

  test('rivals: too short is an error, repeats and cross-side names are warnings', () => {
    const s = base();
    s.competitors = [
      { name: 'Apex Systems', country: 'Singapore' },
      { name: 'apex systems', country: 'Singapore' },
      { name: 'Meridian Malaysia', country: 'Malaysia' },
      { name: 'Q', country: 'Singapore' },
    ];
    assert.match(on(warnings(s), competitorField(1))[0].message, /listed twice/);
    assert.match(on(warnings(s), competitorField(2))[0].message, /one of your organisations/);
    assert.match(on(errors(s), competitorField(3))[0].message, /at least 2 characters/);
  });

  test('errors stay hidden until revealed; warnings always show', () => {
    const err: SetupIssue = {
      field: 'f',
      severity: 'error',
      scope: 'org',
      where: 'x',
      message: 'e',
    };
    const warn: SetupIssue = { ...err, severity: 'warning', message: 'w' };
    assert.equal(pickIssue([err], false), null);
    assert.equal(pickIssue([warn, err], false)?.message, 'w');
    assert.equal(pickIssue([warn, err], true)?.message, 'e');
  });
});

describe('client checks agree with the server', () => {
  const mutations: Record<string, (s: SetupSnapshot) => void> = {
    'custom team with a preset name': (s) => {
      s.extras[0].team_roster.push(custom('Stakeholder Engagement'));
    },
    'blank custom team': (s) => {
      s.primary.roster.push(custom('', ''));
    },
    'short custom description': (s) => {
      s.primary.roster.push(custom('Youth Outreach', 'kids'));
    },
    'custom team name over 60 characters': (s) => {
      s.primary.roster.push(custom('x'.repeat(61)));
    },
    'same custom team twice': (s) => {
      s.primary.roster.push(custom('Youth Outreach'), custom('youth outreach'));
    },
    'custom names sharing 40 characters': (s) => {
      s.primary.roster.push(
        custom('Regional Community Relations and Partnerships North'),
        custom('Regional Community Relations and Partnerships South'),
      );
    },
    'one team only': (s) => {
      s.extras[0].team_roster = [preset('Communications')];
    },
    'seven teams': (s) => {
      s.primary.roster.push(
        preset('Shareholder Engagement'),
        preset('Executive'),
        custom('Youth Outreach'),
        custom('Dealer Relations'),
      );
    },
    'duplicate organisation names': (s) => {
      s.extras[0].display_name = 'MERIDIAN TECHNOLOGIES';
    },
    'blank additional organisation': (s) => {
      s.extras[0].display_name = ' ';
    },
    'unknown country': (s) => {
      s.extras[0].country = 'Atlantis';
    },
    'city over 80 characters': (s) => {
      s.extras[0].city = 'c'.repeat(81);
    },
    'duplicate short names': (s) => {
      s.primary.shortName = 'MER';
      s.extras[0].short_name = 'mer';
    },
    'pressure group named like an organisation': (s) => {
      s.pressure[0].display_name = 'Meridian Malaysia';
    },
    'pressure group with an unknown country': (s) => {
      s.pressure[0].country = 'Atlantis';
    },
    'pressure demand over 300 characters': (s) => {
      s.pressure[0].wants = 'w'.repeat(301);
    },
    'one-letter rival': (s) => {
      s.competitors.push({ name: 'Q', country: 'Singapore' });
    },
    'rival with an unknown country': (s) => {
      s.competitors.push({ name: 'Orbit Ltd', country: 'Atlantis' });
    },
  };

  for (const [name, mutate] of Object.entries(mutations)) {
    test(`both refuse: ${name}`, () => {
      const s = base();
      mutate(s);
      assert.ok(serverRefusal(s), 'server should refuse');
      assert.ok(errors(s).length > 0, 'client should flag it');
    });
  }

  test('both accept the base setup and a 44-character custom name', () => {
    const s = base();
    assert.equal(serverRefusal(s), null);
    s.primary.roster.push(custom('community engagement for the northern region'));
    assert.equal(serverRefusal(s), null);
    assert.equal(errors(s).length, 0);
  });

  test('the client is deliberately stricter in three places', () => {
    // Unnamed headquarters with partners: the server would quietly call it "Organisation".
    const unnamed = base();
    unnamed.primary.name = '';
    // No public voice: the server picks one; the trainer should choose.
    const voiceless = base();
    voiceless.primary.roster = voiceless.primary.roster.map((t) => ({
      ...t,
      is_public_voice: false,
    }));
    // Blank pressure card: the wizard would silently drop it.
    const blankPressure = base();
    blankPressure.pressure[0].display_name = '';
    for (const s of [unnamed, voiceless, blankPressure]) {
      assert.equal(serverRefusal(s), null);
      assert.ok(errors(s).length > 0);
    }
  });
});

describe('issuesFromServer pins real server refusals to fields', () => {
  test('rule failures map by organisation and team name', () => {
    const s = base();
    s.extras[0].team_roster.push(custom('Stakeholder Engagement'));
    s.extras[0].team_roster.push(custom('Youth Outreach', 'kids'));
    const issues = issuesFromServer(serverRefusal(s), s);
    assert.ok(on(issues, teamField('org_a', 2, 'name'))[0].message.includes('preset name'));
    assert.ok(on(issues, teamField('org_a', 3, 'description'))[0].message.includes('min 10'));
  });

  test('organisation names containing dots still map', () => {
    const s = base();
    s.extras[0].display_name = 'St. John Ambulance Malaysia';
    s.extras[0].country = 'Atlantis';
    const issues = issuesFromServer(serverRefusal(s), s);
    assert.equal(on(issues, orgField('org_a', 'country')).length, 1);
  });

  test('schema failures map by index, with a readable message', () => {
    const s = base();
    s.extras[0].team_roster.push(custom('x'.repeat(61)));
    const [issue] = issuesFromServer(serverRefusal(s), s);
    assert.equal(issue.field, teamField('org_a', 2, 'name'));
    assert.equal(issue.message, 'Too long — 60 characters at most.');
  });

  test('pressure groups map past unnamed drafts the wizard does not send', () => {
    const s = base();
    s.pressure.unshift({ ...s.pressure[0], id: 'prs_blank', display_name: '' });
    s.pressure[1].wants = 'w'.repeat(301);
    const [issue] = issuesFromServer(serverRefusal(s), s);
    assert.equal(issue.field, pressureField('prs_a', 'wants'));
  });

  test('rivals, unmapped paths and bodies without details', () => {
    const s = base();
    s.competitors.push({ name: 'Q', country: 'Singapore' });
    const issues = issuesFromServer(serverRefusal(s), s);
    assert.equal(issues[0].field, competitorField(1));
    assert.equal(
      issuesFromServer({ details: [{ path: 'teams.Legal — X', message: 'm' }] }, s)[0].field,
      null,
    );
    assert.deepEqual(issuesFromServer({ error: 'Describe the crisis first' }, s), []);
  });
});
