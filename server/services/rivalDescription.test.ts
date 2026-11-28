import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { competitorsSchema } from './warroomBuild/wireSchemas.js';
import {
  RIVAL_DESCRIPTION_MAX,
  TRAINER_STANCE_INSTRUCTION,
  competitorPromptLine,
  competitorPromptSection,
  stanceFromTrainer,
} from './rivalDescription.js';

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
});

describe('rival description length', () => {
  test('600 characters is checked after trimming', () => {
    const body = 'd'.repeat(RIVAL_DESCRIPTION_MAX);
    const accepted = competitorsSchema.safeParse([
      { name: 'Apex', country: 'Singapore', description: `  ${body}\n` },
    ]);
    assert.equal(accepted.success, true);
    if (!accepted.success) return;
    assert.equal(accepted.data[0].description, body);
    assert.ok(`  ${body}\n`.length > RIVAL_DESCRIPTION_MAX);

    const rejected = competitorsSchema.safeParse([
      {
        name: 'Apex',
        country: 'Singapore',
        description: ` ${'d'.repeat(RIVAL_DESCRIPTION_MAX + 1)} `,
      },
    ]);
    assert.equal(rejected.success, false);
  });
});
