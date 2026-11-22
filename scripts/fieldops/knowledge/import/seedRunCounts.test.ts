import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { seedRunFigures } from './seedRunCounts.js';

describe('seedRunFigures', () => {
  it('reads counts, distinct_sources and the refused list for a one-library run', () => {
    const hazards = seedRunFigures(
      { counts: { sources_cited: 41, rows_refused: 0 }, refused: [{}, {}, {}, {}, {}, {}] },
      [
        { library: 'building_hazards', recordKind: 'source' },
        { library: 'building_hazards', recordKind: 'table_row' },
      ],
      'building_hazards',
      ['building_hazards'],
    );
    assert.equal(hazards.sourcesCited, 41);
    assert.equal(hazards.rowsRefused, 6);
    assert.equal(hazards.rowsDrafted, 2);

    const doctrines = seedRunFigures(
      { counts: { distinct_sources: 42, rows_refused: 0 } },
      [{ library: 'doctrines', recordKind: 'doctrine_seed' }],
      'doctrines',
      ['doctrines'],
    );
    assert.equal(doctrines.sourcesCited, 42);
    assert.equal(doctrines.rowsRefused, 0);

    const smoke = seedRunFigures(
      { counts: { rows_drafted: 68, sources_cited: 34, rows_refused: 0 } },
      [{ library: 'fire_smoke_tenability', recordKind: 'reference' }],
      'fire_smoke_tenability',
      ['fire_smoke_tenability'],
    );
    assert.equal(smoke.sourcesCited, 34);
    assert.equal(smoke.rowsDrafted, 68);
  });

  it('does not copy a multi-library run total onto every library', () => {
    const document = { rows_drafted: 105, rows_refused: 3, sources_cited: 32 };
    const records = [
      { library: 'threats', recordKind: 'source' },
      { library: 'threats', recordKind: 'source' },
      { library: 'threats', recordKind: 'table_row' },
      { library: 'spread', recordKind: 'table_row' },
      { library: 'movement', recordKind: 'table_row' },
    ];
    const libraries = ['threats', 'spread', 'movement'];
    const threats = seedRunFigures(document, records, 'threats', libraries);
    const spread = seedRunFigures(document, records, 'spread', libraries);
    assert.deepEqual(threats, { rowsDrafted: 3, rowsRefused: 0, sourcesCited: 2 });
    assert.deepEqual(spread, { rowsDrafted: 1, rowsRefused: 0, sourcesCited: 0 });
    assert.notEqual(threats.rowsDrafted, 105);
    assert.notEqual(spread.sourcesCited, 32);
  });

  it('does not stamp a folder total onto a second library', () => {
    const document = {
      counts: { sources_cited: 41, rows_refused: 0 },
      refused: [{}, {}, {}, {}, {}, {}],
    };
    const records = [
      { library: 'building_hazards', recordKind: 'source' },
      { library: 'building_hazards', recordKind: 'refused' },
      { library: 'threats', recordKind: 'table_row' },
    ];
    const libraries = ['building_hazards', 'threats'];
    const hazards = seedRunFigures(document, records, 'building_hazards', libraries);
    const threats = seedRunFigures(document, records, 'threats', libraries);
    assert.equal(hazards.sourcesCited, 1);
    assert.equal(hazards.rowsRefused, 1);
    assert.equal(threats.sourcesCited, 0);
    assert.equal(threats.rowsDrafted, 1);
  });

  it('counts responder sources from staging when there is no run.json', () => {
    const records = [
      { library: 'units', recordKind: 'source' },
      { library: 'units', recordKind: 'table_row' },
      { library: 'hospitals', recordKind: 'table_row' },
    ];
    const units = seedRunFigures({}, records, 'units', ['units', 'hospitals']);
    assert.equal(units.sourcesCited, 1);
    assert.equal(units.rowsDrafted, 2);
  });
});
