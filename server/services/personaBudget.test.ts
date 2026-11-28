import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { personasForCountryCount } from './personaBudget.js';

describe('persona budget', () => {
  test('3 countries get 200 each', () => {
    assert.equal(personasForCountryCount(3), 200);
  });

  test('10 countries get 80 each', () => {
    assert.equal(personasForCountryCount(10), 80);
  });

  test('30 countries get 40 each', () => {
    assert.equal(personasForCountryCount(30), 40);
  });
});
