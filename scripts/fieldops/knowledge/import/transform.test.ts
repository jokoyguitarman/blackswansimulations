import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assignDoctrineSourceKey,
  collectInlineSources,
  fullDate,
  hospitalBeds,
  httpsUrl,
  overlaySpread,
  responseNumbers,
  urlAlreadyDrafted,
} from './transforms.js';

describe('knowledge transforms', () => {
  it('picks the latest beds year and leaves sg_hosp_wh empty', () => {
    const picked = hospitalBeds([
      { param: 'beds_2019', value: 100 },
      { param: 'beds_latest', value: 9 },
      { param: 'beds_2024', value: 1200 },
      { param: 'acute_and_community_beds_2024', value: 50 },
    ]);
    assert.deepEqual(picked, { beds: 1200, bedsYear: 2024 });
    assert.deepEqual(
      hospitalBeds([
        { param: 'beds_latest', value: null },
        { param: 'address', value: 'x' },
      ]),
      { beds: null, bedsYear: null },
    );
  });

  it('fills response-standard numbers from values', () => {
    const numbers = responseNumbers([
      { param: 'respond_within_s', value: 480 },
      { param: 'target_share_pct', value: 90 },
      { param: 'measured_from', value: 'sometimes' },
    ]);
    assert.equal(numbers.respond_within_s, 480);
    assert.equal(numbers.target_share_pct, 90);
    assert.equal(numbers.measured_from, null);
  });

  it('drops partial dates and non-https URLs', () => {
    assert.equal(fullDate('2012-09-14'), '2012-09-14');
    assert.equal(fullDate('2004-12'), null);
    assert.equal(fullDate('2015'), null);
    assert.equal(fullDate('n.d.'), null);
    assert.equal(httpsUrl('https://example.test/a'), 'https://example.test/a');
    assert.equal(httpsUrl('http://example.test/a'), null);
  });

  it('derives doctrine source keys and splits a collision', () => {
    const used = new Map<string, string>();
    const first = assignDoctrineSourceKey('https://Example.com/Path', used);
    const same = assignDoctrineSourceKey('https://Example.com/Path', used);
    const collision = assignDoctrineSourceKey('https://example.com/path/', used);
    assert.equal(first, same);
    assert.match(first, /^[a-z0-9][a-z0-9_.:-]{2,119}$/);
    assert.notEqual(collision, first);
    assert.match(collision, /-[0-9a-f]{8}$/);
  });

  it('collects agency-unit URLs and skips nodes that already have a source key', () => {
    const sources = collectInlineSources(
      {
        sources: [{ title: 'Agency page', url: 'https://example.test/agency' }],
        units: [
          {
            sources: [
              { title: 'Gurkha reply', url: 'https://example.test/gurkha' },
              { source_key: 'scdf_dart_2026', url: 'https://example.test/dart' },
            ],
          },
        ],
      },
      { sources: [{ source_key: 'file_source', url: 'https://example.test/file' }] },
    );
    assert.deepEqual(
      sources.map((source) => source.url),
      ['https://example.test/agency', 'https://example.test/gurkha'],
    );
  });

  it('treats only an identical URL as already drafted', () => {
    const drafts = [{ url: 'https://example.test/dart' }];
    assert.equal(urlAlreadyDrafted('https://example.test/dart', drafts), true);
    assert.equal(urlAlreadyDrafted('https://example.test/Dart', drafts), false);
    assert.equal(urlAlreadyDrafted('dart', drafts), false);
  });

  it('keeps planning values where the research patch is null', () => {
    const row = overlaySpread(
      {
        material_key: 'contents_retail',
        label: 'Retail contents',
        hrrpua_kw_m2: 250,
        heat_release: 'medium',
        soot_yield: 0.01,
        source_ref: 'planning',
        source_note: 'planning note',
      },
      {
        hrrpua_kw_m2: null,
        heat_release: 'fast',
        soot_yield: null,
        source_ref: 'patch',
        source_note: 'patch note',
      },
    );
    assert.equal(row.hrrpua_kw_m2, 250);
    assert.equal(row.soot_yield, 0.01);
    assert.equal(row.heat_release, 'fast');
    assert.equal(row.label, 'Retail contents');
    assert.equal(row.source_ref, 'planning | patch');
    assert.equal(row.source_note, 'patch note | planning note');
  });
});
