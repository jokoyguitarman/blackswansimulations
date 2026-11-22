import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KNOWLEDGE_CHECKS, VALID_ROWS, failedChecks, violatingRow } from './knowledgeChecks.js';

describe('knowledge promotion schemas', () => {
  it('accepts one valid row per typed table and rejects one value per CHECK', () => {
    for (const table of Object.keys(VALID_ROWS)) {
      assert.deepEqual(failedChecks(table, VALID_ROWS[table] ?? {}), [], table);
    }
    const tables = new Set(Object.keys(VALID_ROWS));
    for (const check of KNOWLEDGE_CHECKS) {
      if (!tables.has(check.table)) continue;
      const row = violatingRow(check.table, check.name);
      assert.ok(failedChecks(check.table, row).includes(check.name), check.name);
    }
  });
});
