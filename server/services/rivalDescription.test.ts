import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOrganisations, type OrganisationInput } from './scenarioOrgModel.js';
import {
  RIVAL_DESCRIPTION_MAX,
  TRAINER_STANCE_INSTRUCTION,
  competitorPromptLine,
  competitorPromptSection,
  stanceFromTrainer,
} from './rivalDescription.js';

const roster = [
  { team_name: 'Communications', is_public_voice: true },
  { team_name: 'Legal' },
];
const orgs: OrganisationInput[] = [
  { display_name: 'Sigma Logistics', country: 'Singapore', is_primary: true, team_roster: roster },
];

describe('rival prompt lines', () => {
  test('a description is quoted and the prompt is told to follow it', () => {
    const line = competitorPromptLine(
      {
        name: 'Apex',
        country: 'Singapore',
        city: 'Jurong',
        description: 'Safer\nalternative',
      },
      0,
    );
    assert.equal(
      line,
      '  COMPETITOR 1 [ref C1]: Apex — Jurong, Singapore\n    Trainer\'s description: Safer alternative',
    );
    const section = competitorPromptSection([
      { name: 'Apex', country: 'Singapore', description: 'Safer alternative' },
      { name: 'Bare Rival', country: 'Malaysia' },
    ]);
    assert.match(section, /COMPETITOR 1 \[ref C1\]: Apex — Singapore\n {4}Trainer's description: Safer alternative/);
    assert.match(section, /COMPETITOR 2 \[ref C2\]: Bare Rival — Malaysia/);
    assert.ok(section.endsWith(TRAINER_STANCE_INSTRUCTION));
    assert.match(TRAINER_STANCE_INSTRUCTION, /follow it/i);
  });

  test('a blank description adds no trainer line and no follow instruction', () => {
    const section = competitorPromptSection([
      { name: 'Bare Rival', country: 'Malaysia', description: '   \n  ' },
    ]);
    assert.equal(section, '  COMPETITOR 1 [ref C1]: Bare Rival — Malaysia');
    assert.equal(competitorPromptSection([]), '');
  });
});

describe('stance merge', () => {
  test('a non-empty trainer description wins, including its line breaks', () => {
    const written = 'Undercuts on price.\nClaims a cleaner safety record.';
    assert.equal(stanceFromTrainer('AI wrote this', written), written);
    assert.equal(stanceFromTrainer('AI wrote this', '   '), 'AI wrote this');
    assert.equal(stanceFromTrainer('AI wrote this', undefined), 'AI wrote this');
    assert.equal(stanceFromTrainer('   ', undefined), undefined);
    assert.equal(stanceFromTrainer(null, undefined), undefined);
  });

  test('the description is what initial_state.org_page.orgs[].stance stores', () => {
    const description = 'Positions itself as the safer, more transparent alternative';
    assert.ok(description.length <= RIVAL_DESCRIPTION_MAX);
    const validated = validateOrganisations(orgs, [
      { name: 'Apex Systems', country: 'Singapore', description: `  ${description}  ` },
    ]);
    assert.ok(validated.ok);
    if (!validated.ok) return;
    const stance = stanceFromTrainer('AI wrote this', validated.competitors[0].description);
    const initial_state = {
      org_page: {
        orgs: [
          {
            org_key: validated.competitors[0].org_key,
            role: 'antagonist' as const,
            display_name: validated.competitors[0].name,
            stance,
          },
        ],
      },
    };
    assert.equal(initial_state.org_page.orgs[0].stance, description);
    assert.match(validated.competitors[0].org_key, /^org_antagonist_/);
  });
});
