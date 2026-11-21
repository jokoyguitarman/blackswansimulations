import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  computePageCoverage,
  pageCoverageMessage,
  type CoverageControllerInput,
  type CoveragePageInput,
  type CoverageParticipantInput,
} from '../../shared/sessionPageCoverage.js';

const people = (
  ids: string[],
  extras: Partial<CoverageParticipantInput> = {},
): CoverageParticipantInput[] => ids.map((user_id) => ({ user_id, full_name: user_id, ...extras }));

function orgRows(keys: string[], patch: Partial<CoveragePageInput> = {}): CoveragePageInput[] {
  const pages: CoveragePageInput[] = [];
  for (const org_key of keys) {
    pages.push({
      org_key,
      display_name: org_key,
      role: 'protagonist',
      is_primary: org_key === 'primary',
      ...patch,
    });
    pages.push({
      org_key,
      page_name: `${org_key} x`,
      role: 'protagonist',
      ...patch,
    });
  }
  return pages;
}

describe('session page coverage', () => {
  test('no pages is covered', () => {
    const result = computePageCoverage({ pages: [], controllers: [], participants: [] });
    assert.equal(result.covered, true);
    assert.deepEqual(result.pages, []);
    assert.deepEqual(result.uncovered, []);
  });

  test('five protagonist orgs with a controller each are covered and de-duplicated', () => {
    const keys = ['primary', 'health', 'port', 'media', 'finance'];
    const controllers: CoverageControllerInput[] = keys.map((org_key, i) => ({
      user_id: `u${i}`,
      org_key,
    }));
    const result = computePageCoverage({
      pages: orgRows(keys),
      controllers,
      participants: people(keys.map((_, i) => `u${i}`)),
    });
    assert.equal(result.covered, true);
    assert.equal(result.pages.length, 5);
    assert.deepEqual(result.uncovered, []);
  });

  test('a missing controller leaves exactly that org uncovered', () => {
    const keys = ['primary', 'health', 'port'];
    const result = computePageCoverage({
      pages: orgRows(keys),
      controllers: [
        { user_id: 'u0', org_key: 'primary' },
        { user_id: 'u1', org_key: 'health' },
      ],
      participants: people(['u0', 'u1', 'u2']),
    });
    assert.equal(result.covered, false);
    assert.deepEqual(
      result.uncovered.map((p) => p.org_key),
      ['port'],
    );
  });

  test('antagonist, pressure, AI-operated and AI control pages are never required', () => {
    const result = computePageCoverage({
      pages: [
        { org_key: 'rival', display_name: 'Rival', role: 'antagonist' },
        { org_key: 'union', display_name: 'Union', role: 'pressure' },
        { org_key: 'office', display_name: 'Office', role: 'protagonist', operation: 'ai' },
        { org_key: 'seized', display_name: 'Seized', role: 'protagonist', control_mode: 'ai' },
        { org_key: 'ours', display_name: 'Ours', role: 'protagonist' },
      ],
      controllers: [{ user_id: 'u1', org_key: 'ours' }],
      participants: people(['u1']),
    });
    assert.equal(result.covered, true);
    assert.deepEqual(
      result.pages.map((p) => p.org_key),
      ['ours'],
    );
  });

  test('a controller who is not a participant does not count', () => {
    const result = computePageCoverage({
      pages: [{ org_key: 'ours', display_name: 'Ours', role: 'protagonist' }],
      controllers: [{ user_id: 'ghost', org_key: 'ours' }],
      participants: people(['u1']),
    });
    assert.equal(result.covered, false);
    assert.equal(result.uncovered[0]?.org_key, 'ours');
  });

  test('observers and the trainer do not count', () => {
    const result = computePageCoverage({
      pages: [
        { org_key: 'a', display_name: 'A', role: 'protagonist' },
        { org_key: 'b', display_name: 'B', role: 'protagonist' },
      ],
      controllers: [
        { user_id: 'obs', org_key: 'a' },
        { user_id: 'trainer', org_key: 'b' },
      ],
      participants: [
        { user_id: 'obs', role: 'observer', full_name: 'Observer' },
        { user_id: 'trainer', full_name: 'Trainer' },
        { user_id: 'player', full_name: 'Player' },
      ],
      trainerId: 'trainer',
    });
    assert.equal(result.covered, false);
    assert.equal(
      result.pages.every((p) => p.assignees.length === 0),
      true,
    );
  });

  test('a bot participant counts', () => {
    const result = computePageCoverage({
      pages: [{ org_key: 'ours', display_name: 'Ours', role: 'protagonist' }],
      controllers: [{ user_id: 'bot', org_key: 'ours' }],
      participants: [{ user_id: 'bot', full_name: 'Ada', is_bot: true }],
    });
    assert.equal(result.covered, true);
    assert.equal(result.pages[0]?.assignees[0]?.is_bot, true);
    assert.equal(result.pages[0]?.assignees[0]?.full_name, 'Ada');
  });

  test('two controllers on one page leave the other page uncovered', () => {
    const result = computePageCoverage({
      pages: [
        { org_key: 'a', display_name: 'A', role: 'protagonist' },
        { org_key: 'b', display_name: 'B', role: 'protagonist' },
      ],
      controllers: [
        { user_id: 'u1', org_key: 'a' },
        { user_id: 'u2', org_key: 'a' },
      ],
      participants: people(['u1', 'u2']),
    });
    assert.equal(result.pages.length, 2);
    assert.equal(result.pages.find((p) => p.org_key === 'a')?.assignees.length, 2);
    assert.deepEqual(
      result.uncovered.map((p) => p.org_key),
      ['b'],
    );
  });

  test('duplicate controller rows do not duplicate assignees', () => {
    const result = computePageCoverage({
      pages: [{ org_key: 'a', display_name: 'A', role: 'protagonist' }],
      controllers: [
        { user_id: 'u1', org_key: 'a' },
        { user_id: 'u1', org_key: 'a' },
      ],
      participants: people(['u1']),
    });
    assert.equal(result.pages[0]?.assignees.length, 1);
  });

  test('the primary page sorts first', () => {
    const result = computePageCoverage({
      pages: [
        { org_key: 'b', display_name: 'Beta', role: 'protagonist' },
        { org_key: 'a', display_name: 'Alpha', role: 'protagonist', is_primary: true },
      ],
      controllers: [],
      participants: [],
    });
    assert.deepEqual(
      result.pages.map((p) => p.org_key),
      ['a', 'b'],
    );
  });

  test('pageCoverageMessage names up to three pages', () => {
    assert.equal(pageCoverageMessage([]), '');
    assert.equal(
      pageCoverageMessage([{ display_name: 'Ministry' }]),
      "Can't start yet: 1 page has nobody assigned (Ministry). Assign a player or an AI teammate to every page.",
    );
    assert.equal(
      pageCoverageMessage([{ display_name: 'Ministry' }, { display_name: 'Port Authority' }]),
      "Can't start yet: 2 pages have nobody assigned (Ministry, Port Authority). Assign a player or an AI teammate to every page.",
    );
    assert.equal(
      pageCoverageMessage(['A', 'B', 'C', 'D', 'E'].map((display_name) => ({ display_name }))),
      "Can't start yet: 5 pages have nobody assigned (A, B, C and 2 more). Assign a player or an AI teammate to every page.",
    );
  });
});
