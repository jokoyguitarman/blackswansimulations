import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../../../..');

/** SHA-256 of each PR #23 file at 4fe0096. Spec section 5.2. */
const PR23_SHA256: Record<string, string> = {
  '221_team_archetypes.sql': '932931d95da21994be404dd7fea27c4855063d5fb7dca815d806b8ff492b474b',
  '222_doctrines.sql': '45ec945a8f124a69b4241e2278ee147a1a7a5e9a3f2cfea5fdc47e1684269683',
  '223_doctrine_usage_reports_events.sql':
    '0f29ae8333b83727cf1e4dd390190086f87ad4b02e74d9c92c1bc84256a412fb',
  '224_doctrine_queue_indexes.sql':
    'e59228179f9fae4cc7936780c5c075561cf697bd0198c29d1ca82be8bd4c3254',
  '239_fieldops_explosive_materials.sql':
    '918175e0891fa5bf488d3743065a874b9cc471cb2b82ec24b270789a9b2a9dd4',
  '240_fieldops_injury_thresholds.sql':
    'b9376c151c94f87cff9505f0778be72c8c881917c7e5ab348c8f1c6181a796f7',
  '242_fieldops_physics_reviews.sql':
    '92902577cf1cbb1bd6f0e8ca55cfb07145889cc16ddae5db40fdb806084bb971',
  '250_fieldops_spread_library.sql':
    '9197ccef18eff94484a0d97652c1530734e100c1d84f664cc9f5b929cbbe3a21',
  '257_fieldops_building_hazards.sql':
    'c863b077a98238ad949278d2d16284ac6ff77e88339c64f3681818e6a5201a6e',
  '258_fieldops_threats_agents_movement.sql':
    'e5bed73e3a42dba006f33ba3557daeeb4af513bd455b23472109a8e574c6e286',
  '259_fieldops_knowledge_provenance.sql':
    '91c03a63591a338bb8d19995e053e4db00f1dcb74b856d955efb799470afcab8',
};

const BODY_261_SHA256 = '58c5eda8aef0b73354080c86e159505d75675bbc8dca839d06ee9c0821620eb9';

/** Lines 103–226 of PR #23's migration 254 block: the D54/D56 passages. */
export function bodyOf261(sql: string): string {
  const start = sql.indexOf('-- Added 22 Nov 2026 (D54, W56)');
  const endMarker =
    'REVOKE ALL ON TABLE public.fieldops_capacity_aggregates FROM PUBLIC, anon, authenticated;\n';
  const end = sql.indexOf(endMarker);
  assert.ok(start >= 0 && end > start, '261 body markers');
  return sql.slice(start, end + endMarker.length);
}

describe('knowledge migration checksums (U9)', () => {
  for (const [file, expected] of Object.entries(PR23_SHA256)) {
    test(`${file} matches the 4fe0096 SHA-256`, () => {
      const bytes = readFileSync(path.join(ROOT, 'migrations', file));
      const hash = createHash('sha256').update(bytes).digest('hex');
      assert.equal(hash, expected);
    });
  }

  test('261 body equals the 254 D54/D56 slice', () => {
    const sql = readFileSync(
      path.join(ROOT, 'migrations', '261_fieldops_units_hospitals_library.sql'),
      'utf8',
    );
    const body = bodyOf261(sql);
    assert.equal(body.split('\n').length - 1, 124);
    assert.equal(createHash('sha256').update(body).digest('hex'), BODY_261_SHA256);
    assert.equal(body.endsWith('\n'), true);
  });
});
