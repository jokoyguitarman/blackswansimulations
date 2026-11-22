import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { describe, it } from 'node:test';
import {
  KNOWLEDGE_CHECKS,
  VALID_ROWS,
  violatingRow,
} from '../../../../server/lib/fieldOps/knowledgeSchemas.js';
import { buildManifest, writeManifest } from './manifest.js';
import { promote } from './promote/index.js';
import { stage } from './stage.js';
import { verifyKnowledge } from './verify.js';

const JSON_COLUMNS: Record<string, string[]> = {
  fieldops_threat_profiles: ['parameters', 'environment'],
  fieldops_release_agents: ['tiers'],
  fieldops_hospitals: ['stated_values'],
  fieldops_capacity_aggregates: ['stated_values'],
  fieldops_response_standards: ['stated_values'],
  fieldops_knowledge_reference_values: ['value', 'provenance', 'worked_example'],
  doctrine_versions: ['content'],
};

function localUrl(): string | null {
  const url = process.env.KNOWLEDGE_DB_URL;
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') return null;
    return url;
  } catch {
    return null;
  }
}

function withDatabase(url: string, database: string): string {
  const next = new URL(url);
  next.pathname = `/${database}`;
  return next.toString();
}

async function recreate(url: string, database: string): Promise<string> {
  const admin = new pg.Client({ connectionString: withDatabase(url, 'postgres') });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.query(`CREATE DATABASE ${database}`);
  } finally {
    await admin.end();
  }
  const fixture = withDatabase(url, database);
  const dump = execFileSync(
    'pg_dump',
    ['--schema-only', '--no-owner', '--no-privileges', '-d', url],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const target = new URL(fixture);
  execFileSync('psql', ['-q', '-d', fixture, '-v', 'ON_ERROR_STOP=1'], {
    input: dump,
    env: { ...process.env, PGPASSWORD: decodeURIComponent(target.password) },
  });
  const client = new pg.Client({ connectionString: fixture });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO public.team_archetypes (key, label)
       VALUES ('fire_rescue', 'Fire rescue') ON CONFLICT DO NOTHING`,
    );
  } finally {
    await client.end();
  }
  return fixture;
}

async function insertRow(
  client: pg.Client,
  table: string,
  row: Record<string, unknown>,
): Promise<void> {
  const columns = Object.keys(row).filter((column) => row[column] !== undefined);
  const json = new Set(JSON_COLUMNS[table] ?? []);
  const values = columns.map((column) =>
    json.has(column) && row[column] != null ? JSON.stringify(row[column]) : row[column],
  );
  const placeholders = columns.map((column, index) =>
    json.has(column) ? `$${index + 1}::jsonb` : `$${index + 1}`,
  );
  await client.query(
    `INSERT INTO public.${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
    values,
  );
}

const REVIEW = {
  decision: 'approved',
  reviewer_name: 'Jokoy Tabbada',
  reviewer_qualification: 'Project owner qualification for the fixture',
  decided_on: '2026-11-22',
};

function movementFile(value: number): Record<string, unknown> {
  return {
    library: 'movement',
    review_status: 'reviewed',
    rows: [
      {
        param_key: 'fixture_walk',
        label: 'Walk',
        applies_to: 'walking',
        value,
        unit: 'm_s',
        plausible_low: 0.5,
        plausible_high: 2,
        source_ref: 'fixture source',
        source_note: 'fixture note',
        source_keys: [],
        review: REVIEW,
      },
    ],
  };
}

function agentFile(weight: number, decision: 'approved' | 'rejected'): Record<string, unknown> {
  return {
    library: 'threats',
    review_status: 'reviewed',
    rows: [
      {
        agent_key: 'chlorine',
        label: 'Chlorine',
        molecular_weight: weight,
        density_ratio: 2.5,
        tiers: [],
        irritant: true,
        source_ref: 'fixture source',
        source_note: 'fixture note',
        source_keys: [],
        review: { ...REVIEW, decision },
      },
    ],
  };
}

function writeSeeds(dir: string, files: Record<string, unknown>): void {
  for (const [relative, document] of Object.entries(files)) {
    const absolute = path.join(dir, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, `${JSON.stringify(document, null, 2)}\n`);
  }
  writeManifest(dir, buildManifest(dir, '2026-11-22'));
}

describe('knowledge promotion on a local database', () => {
  const url = localUrl();
  const skip = url ? false : 'KNOWLEDGE_DB_URL is not a local database';

  it('I4 promote with nothing approved writes nothing', { skip }, async () => {
    assert.ok(url);
    const fixture = await recreate(url, 'knowledge_i4');
    const result = await promote({
      apply: true,
      allowUnscreenedDoctrines: true,
      libraries: [],
      target: { url: fixture, target: 'local' },
    });
    assert.equal(result.counts.inserted, 0);
    assert.equal(result.counts.updated, 0);
    const client = new pg.Client({ connectionString: fixture });
    await client.connect();
    try {
      const log = await client.query<{ status: string }>(
        `SELECT status FROM public.fieldops_knowledge_import_runs WHERE id = $1`,
        [result.runId],
      );
      assert.equal(log.rows[0]?.status, 'succeeded');
      const rows = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.fieldops_movement_parameters`,
      );
      assert.equal(rows.rows[0]?.n, 0);
    } finally {
      await client.end();
    }
  });

  it(
    'I6 the database refuses every U4 invalid row and accepts the valid one',
    { skip },
    async () => {
      assert.ok(url);
      const fixture = await recreate(url, 'knowledge_i6');
      const client = new pg.Client({ connectionString: fixture });
      await client.connect();
      const accepted: string[] = [];
      const refused: string[] = [];
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO public.fieldops_seed_files
           (file_path, folder, library, format, sha256, byte_size, header, record_count)
         VALUES ('_incoming/blast-effects/i6.json', 'blast-effects', 'blast_effects', 'reference_rows_v0', $1, 2, '{}'::jsonb, 1)`,
          ['b'.repeat(64)],
        );
        const record = await client.query<{ id: string }>(
          `INSERT INTO public.fieldops_knowledge_records
           (file_path, record_kind, record_key, ordinal, library, payload, payload_sha256)
         VALUES ('_incoming/blast-effects/i6.json', 'reference', 'i6', 0, 'blast_effects', '{}'::jsonb, $1)
         RETURNING id::text`,
          ['a'.repeat(64)],
        );
        const recordId = record.rows[0]?.id;
        const doctrine = await client.query<{ id: string }>(
          `INSERT INTO public.doctrines (archetype_key, title, source, visibility, country, agency_name)
         VALUES ('fire_rescue', 'I6 parent', 'seeded', 'library', 'SG', 'I6') RETURNING id::text`,
        );
        const doctrineId = doctrine.rows[0]?.id;
        for (const check of KNOWLEDGE_CHECKS) {
          if (!VALID_ROWS[check.table]) continue;
          await client.query('SAVEPOINT i6');
          try {
            await parentsFor(client, check.table);
            const valid = dress(
              check.table,
              { ...(VALID_ROWS[check.table] ?? {}) },
              recordId,
              doctrineId,
            );
            await insertRow(client, check.table, valid);
            accepted.push(check.table);
          } catch (error) {
            throw new Error(
              `${check.table} valid row was refused: ${error instanceof Error ? error.message : error}`,
            );
          } finally {
            await client.query('ROLLBACK TO SAVEPOINT i6');
          }
          await client.query('SAVEPOINT i6');
          try {
            await parentsFor(client, check.table);
            const invalid = dress(
              check.table,
              violatingRow(check.table, check.name),
              recordId,
              doctrineId,
            );
            let failed = false;
            try {
              await insertRow(client, check.table, invalid);
            } catch {
              failed = true;
            }
            if (!failed) refused.push(check.name);
          } finally {
            await client.query('ROLLBACK TO SAVEPOINT i6');
          }
        }
        assert.deepEqual(refused, []);
        assert.ok(accepted.length > 20);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end();
      }
    },
  );

  it('I7 a changed approved value stays pending and is not promoted', { skip }, async () => {
    assert.ok(url);
    const fixture = await recreate(url, 'knowledge_i7');
    const dir = mkdtempSync(path.join(tmpdir(), 'knowledge-i7-'));
    const relative = '_incoming/physics-movement/movement-parameters.pending.json';
    writeSeeds(dir, { [relative]: movementFile(1.2) });
    const target = { url: fixture, target: 'local' as const };
    await stage({
      dir,
      folders: ['physics-movement'],
      apply: true,
      allowManifestDrift: false,
      target,
    });
    await promote({ apply: true, allowUnscreenedDoctrines: true, libraries: [], target });
    writeSeeds(dir, { [relative]: movementFile(1.4) });
    const restage = await stage({
      dir,
      folders: ['physics-movement'],
      apply: true,
      allowManifestDrift: false,
      target,
    });
    assert.equal(restage.counts.changed, 1);
    const client = new pg.Client({ connectionString: fixture });
    await client.connect();
    try {
      const pending = await client.query<{ pending_change: boolean; value: string }>(
        `SELECT r.pending_change, p.value::text AS value
           FROM public.fieldops_knowledge_records r
           JOIN public.fieldops_movement_parameters p ON p.param_key = 'fixture_walk'
          WHERE r.record_key = 'fixture_walk'`,
      );
      assert.equal(pending.rows[0]?.pending_change, true);
      assert.equal(Number(pending.rows[0]?.value), 1.2);
      await promote({ apply: true, allowUnscreenedDoctrines: true, libraries: [], target });
      const after = await client.query<{ value: string }>(
        `SELECT value::text AS value FROM public.fieldops_movement_parameters WHERE param_key = 'fixture_walk'`,
      );
      assert.equal(Number(after.rows[0]?.value), 1.2);
    } finally {
      await client.end();
    }
  });

  it('I8 conflicting approved rows are blocked until one is rejected', { skip }, async () => {
    assert.ok(url);
    const fixture = await recreate(url, 'knowledge_i8');
    const dir = mkdtempSync(path.join(tmpdir(), 'knowledge-i8-'));
    const physics = '_incoming/physics-movement/release-agents.pending.json';
    const building = '_incoming/building-hazards/release-agents.json';
    writeSeeds(dir, {
      [physics]: agentFile(70.9, 'approved'),
      [building]: agentFile(71, 'approved'),
    });
    const target = { url: fixture, target: 'local' as const };
    await stage({ dir, folders: [], apply: true, allowManifestDrift: false, target });
    await promote({ apply: true, allowUnscreenedDoctrines: true, libraries: [], target });
    const client = new pg.Client({ connectionString: fixture });
    await client.connect();
    try {
      const blocked = await client.query<{ n: number; issues: { code: string }[] }>(
        `SELECT blocker_count AS n, issues FROM public.fieldops_knowledge_records WHERE record_key = 'chlorine'`,
      );
      assert.equal(blocked.rows.length, 2);
      assert.ok(
        blocked.rows.every((row) =>
          row.issues.some((issue) => issue.code === 'conflicting_approved_records'),
        ),
      );
      const typed = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.fieldops_release_agents WHERE agent_key = 'chlorine'`,
      );
      assert.equal(typed.rows[0]?.n, 0);
    } finally {
      await client.end();
    }
    writeSeeds(dir, {
      [physics]: agentFile(70.9, 'approved'),
      [building]: agentFile(71, 'rejected'),
    });
    await stage({ dir, folders: [], apply: true, allowManifestDrift: false, target });
    await promote({ apply: true, allowUnscreenedDoctrines: true, libraries: [], target });
    const after = new pg.Client({ connectionString: fixture });
    await after.connect();
    try {
      const row = await after.query<{ weight: string }>(
        `SELECT molecular_weight::text AS weight FROM public.fieldops_release_agents WHERE agent_key = 'chlorine'`,
      );
      assert.equal(Number(row.rows[0]?.weight), 70.9);
    } finally {
      await after.end();
    }
  });

  it('I10 an error mid-promotion rolls the writes back and fails the run', { skip }, async () => {
    assert.ok(url);
    const fixture = await recreate(url, 'knowledge_i10');
    const dir = mkdtempSync(path.join(tmpdir(), 'knowledge-i10-'));
    writeSeeds(dir, {
      '_incoming/physics-movement/movement-parameters.pending.json': movementFile(1.2),
    });
    const target = { url: fixture, target: 'local' as const };
    await stage({
      dir,
      folders: ['physics-movement'],
      apply: true,
      allowManifestDrift: false,
      target,
    });
    await assert.rejects(() =>
      promote({
        apply: true,
        allowUnscreenedDoctrines: true,
        libraries: [],
        target,
        afterWrite: async () => {
          throw new Error('injected failure');
        },
      }),
    );
    const client = new pg.Client({ connectionString: fixture });
    await client.connect();
    try {
      const rows = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.fieldops_movement_parameters`,
      );
      assert.equal(rows.rows[0]?.n, 0);
      const log = await client.query<{ status: string }>(
        `SELECT status FROM public.fieldops_knowledge_import_runs WHERE command = 'promote' ORDER BY started_at DESC LIMIT 1`,
      );
      assert.equal(log.rows[0]?.status, 'failed');
    } finally {
      await client.end();
    }
  });

  it(
    'I5 and I9 the approved library is promoted once and a second run writes nothing',
    { skip },
    async () => {
      assert.ok(url);
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        const ready = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM public.fieldops_spread_materials WHERE material_key = 'contents_retail'`,
        );
        if ((ready.rows[0]?.n ?? 0) === 0) return;
        const retail = await client.query<{ hrr: string }>(
          `SELECT hrrpua_kw_m2::text AS hrr FROM public.fieldops_spread_materials WHERE material_key = 'contents_retail'`,
        );
        assert.equal(Number(retail.rows[0]?.hrr), 250);
        const standard = await client.query<{
          respond: number;
          share: string;
          scope: string;
          site: boolean;
        }>(
          `SELECT respond_within_s AS respond, target_share_pct::text AS share, scope, site_bound AS site
           FROM public.fieldops_response_standards WHERE standard_key = 'sg_fire_rescue_response'
          UNION ALL
         SELECT respond_within_s, target_share_pct::text, scope, site_bound
           FROM public.fieldops_response_standards WHERE standard_key = 'sg_airport_rffs_response'`,
        );
        const fire = standard.rows.find((row) => row.respond === 480);
        assert.ok(fire);
        assert.equal(Number(fire.share), 90);
        const changi = standard.rows.find((row) => row.scope === 'sg_cag_aes');
        assert.equal(changi?.site, true);
        const semtex = await client.query<{ confidence: string }>(
          `SELECT confidence FROM public.fieldops_explosive_materials WHERE material_key = 'semtex'`,
        );
        assert.equal(semtex.rows[0]?.confidence, 'low');
        const rejected = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM public.fieldops_explosive_materials
          WHERE material_key IN ('rdx_c4', 'petn_semtex', 'smokeless_powder')`,
        );
        assert.equal(rejected.rows[0]?.n, 0);
        const blocked = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM public.fieldops_knowledge_sources
          WHERE source_key IN ('nfpa-855','ul-9540a','nfpa-13','nfpa-30b','ccps-2010-vce-bleve','sfpe-handbook-2016','tno-yellow-book-cpr14e','bre-bd2552-2010','cpfprts')`,
        );
        assert.equal(blocked.rows[0]?.n, 0);
        const history = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM public.fieldops_library_row_history`,
        );
        const before = history.rows[0]?.n;
        const second = await promote({
          apply: true,
          allowUnscreenedDoctrines: true,
          libraries: [],
          target: { url, target: 'local' },
        });
        assert.equal(second.counts.inserted, 0);
        assert.equal(second.counts.updated, 0);
        const after = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM public.fieldops_library_row_history`,
        );
        assert.equal(after.rows[0]?.n, before);
      } finally {
        await client.end();
      }
    },
  );

  it(
    'I13 verify is idempotent and a movement change adds one threats review',
    { skip },
    async () => {
      assert.ok(url);
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        const admin = await client.query<{ id: string }>(
          `SELECT id::text FROM public.user_profiles WHERE role = 'admin' LIMIT 1`,
        );
        const adminId = admin.rows[0]?.id;
        if (!adminId) return;
        const target = { url, target: 'local' as const };
        await verifyKnowledge({ apply: true, verifierUserId: adminId, target });
        const again = await verifyKnowledge({ apply: true, verifierUserId: adminId, target });
        assert.equal(again.counts.physics ?? 0, 0);
        assert.equal(again.counts.spread ?? 0, 0);
        assert.equal(again.counts.doctrines ?? 0, 0);
        const before = await client.query<{ model: string; n: number }>(
          `SELECT model_version AS model, count(*)::int AS n FROM public.fieldops_spread_reviews GROUP BY 1`,
        );
        const beforeIds = new Set(
          (
            await client.query<{ id: string }>(
              `SELECT id::text FROM public.fieldops_spread_reviews`,
            )
          ).rows.map((row) => row.id),
        );
        const movement = await client.query<{ key: string; value: string }>(
          `SELECT param_key AS key, value::text AS value
           FROM public.fieldops_movement_parameters
          WHERE value + 0.01 <= plausible_high
          ORDER BY param_key LIMIT 1`,
        );
        const row = movement.rows[0];
        if (!row) return;
        await client.query(
          `UPDATE public.fieldops_movement_parameters SET value = value + 0.01 WHERE param_key = $1`,
          [row.key],
        );
        try {
          const changed = await verifyKnowledge({ apply: true, verifierUserId: adminId, target });
          assert.equal(changed.counts.spread, 1);
          assert.equal(changed.counts.physics ?? 0, 0);
          const after = await client.query<{ model: string; n: number }>(
            `SELECT model_version AS model, count(*)::int AS n FROM public.fieldops_spread_reviews GROUP BY 1`,
          );
          const threatsBefore =
            before.rows.find((item) => item.model === 'fo-threats-1.0.0')?.n ?? 0;
          const threatsAfter = after.rows.find((item) => item.model === 'fo-threats-1.0.0')?.n ?? 0;
          assert.equal(threatsAfter, threatsBefore + 1);
          for (const model of ['fo-spread-1.0.0', 'fo-catalogue-1.0.0']) {
            assert.equal(
              after.rows.find((item) => item.model === model)?.n,
              before.rows.find((item) => item.model === model)?.n,
            );
          }
        } finally {
          await client.query(
            `UPDATE public.fieldops_movement_parameters SET value = $2 WHERE param_key = $1`,
            [row.key, row.value],
          );
          const afterIds = await client.query<{ id: string }>(
            `SELECT id::text FROM public.fieldops_spread_reviews`,
          );
          const extra = afterIds.rows.map((item) => item.id).filter((id) => !beforeIds.has(id));
          if (extra.length > 0) {
            await client.query(
              `DELETE FROM public.fieldops_spread_reviews WHERE id = ANY($1::uuid[])`,
              [extra],
            );
          }
        }
      } finally {
        await client.end();
      }
    },
  );

  it(
    'I14 use of force stays out until a police_service approval is recorded',
    { skip },
    async () => {
      assert.ok(url);
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        const versions = await client.query<{ version: number; force: boolean; payload: boolean }>(
          `SELECT dv.version, (dv.content ? 'use_of_force') AS force,
                (r.approved_payload->'content' ? 'use_of_force') AS payload
           FROM public.doctrine_versions dv
           JOIN public.doctrines d ON d.id = dv.doctrine_id
           JOIN public.fieldops_knowledge_records r ON r.record_key = 'sg_spf.police_security'
          WHERE d.title = 'SPF: Police / Security response'
          ORDER BY dv.version`,
        );
        if (versions.rows.length === 0) return;
        assert.equal(versions.rows[0]?.force, false);
        assert.equal(versions.rows.at(-1)?.force, true);
        assert.equal(versions.rows[0]?.payload, true);
        const withheld = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM public.doctrine_versions dv
           JOIN public.doctrines d ON d.id = dv.doctrine_id
          WHERE d.archetype_key IN ('tactical_response', 'military_support')
            AND dv.version = d.latest_version AND dv.content ? 'use_of_force'`,
        );
        assert.equal(withheld.rows[0]?.n, 0);
      } finally {
        await client.end();
      }
    },
  );
});

function dress(
  table: string,
  row: Record<string, unknown>,
  recordId: string | undefined,
  doctrineId: string | undefined,
): Record<string, unknown> {
  const next = { ...row };
  if (table === 'doctrines' && !next.archetype_key) next.archetype_key = 'fire_rescue';
  if (table === 'doctrine_versions') next.doctrine_id = doctrineId;
  if (table === 'fieldops_knowledge_reference_values') next.record_id = recordId;
  if (table === 'team_archetype_aliases' && !next.archetype_key) next.archetype_key = 'fire_rescue';
  return next;
}

async function parentsFor(client: pg.Client, table: string): Promise<void> {
  const material = {
    material_role: 'wall',
    label: 'Parent',
    aliases: [],
    combustible: false,
    smoke_yield: 'none',
    heat_release: 'none',
    smoke_leak: 0,
    gas_leak: 0,
    glazed: false,
    source_ref: 'parent source',
    source_note: 'parent note',
    status: 'active',
  };
  if (
    table === 'fieldops_building_types' ||
    table === 'fieldops_hazard_item_kinds' ||
    table === 'fieldops_building_items'
  ) {
    await insertRow(client, 'fieldops_spread_materials', {
      ...material,
      material_key: 'contents_generic',
    });
    await insertRow(client, 'fieldops_spread_materials', {
      ...material,
      material_key: 'frame_unknown',
    });
  }
  if (table === 'fieldops_building_items' || table === 'fieldops_hazard_interactions') {
    await insertRow(client, 'fieldops_hazard_item_kinds', {
      ...(VALID_ROWS.fieldops_hazard_item_kinds ?? {}),
    });
  }
  if (table === 'fieldops_building_items') {
    await insertRow(client, 'fieldops_building_types', {
      ...(VALID_ROWS.fieldops_building_types ?? {}),
    });
  }
  if (table === 'fieldops_unit_equipment') {
    await insertRow(client, 'fieldops_unit_kinds', { ...(VALID_ROWS.fieldops_unit_kinds ?? {}) });
    await insertRow(client, 'fieldops_equipment', { ...(VALID_ROWS.fieldops_equipment ?? {}) });
  }
  if (table === 'fieldops_hospital_specialties') {
    await insertRow(client, 'fieldops_hospitals', { ...(VALID_ROWS.fieldops_hospitals ?? {}) });
  }
}
