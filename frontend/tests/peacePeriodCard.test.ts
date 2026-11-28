import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { peaceCardVisible } from '../src/lib/peacePeriodCard.ts';

describe('peace period editor card', () => {
  test('a 404, including the flag off, shows no card', () => {
    assert.equal(peaceCardVisible(null), false);
    assert.equal(peaceCardVisible(404), false);
  });

  test('a successful probe shows the card', () => {
    assert.equal(peaceCardVisible(200), true);
  });
});
