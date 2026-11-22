import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { describe, it } from 'node:test';
import { buildManifest, writeManifest } from './manifest.js';
import { SafetyError } from './safety.js';
import { stage } from './stage.js';

const MINI = path.resolve(import.meta.dirname, '__fixtures__/mini');
const MINI_FILE = '_incoming/blast-effects/human-vulnerability.pending.json';
const STORE = '/cursor/stores/bc-dd814976-2bda-4cfb-92e8-2402418d2ccf/docs/knowledge-seeds';

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

async function ensureDatabase(url: string, database: string): Promise<void> {
  const admin = new pg.Client({ connectionString: withDatabase(url, 'postgres') });
  await admin.connect();
  try {
    const found = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (found.rowCount === 0) await admin.query(`CREATE DATABASE ${database}`);
  } finally {
    await admin.end();
  }
  const fixtureUrl = withDatabase(url, database);
  const client = new pg.Client({ connectionString: fixtureUrl });
  await client.connect();
  try {
    const ready = await client.query(
      `SELECT to_regclass('public.fieldops_knowledge_records') AS name`,
    );
    if (ready.rows[0]?.name) return;
  } finally {
    await client.end();
  }
  const source = new URL(url);
  const target = new URL(fixtureUrl);
  const dump = execFileSync(
    'pg_dump',
    ['--schema-only', '--no-owner', '--no-privileges', '-d', url],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  execFileSync('psql', ['-d', fixtureUrl, '-v', 'ON_ERROR_STOP=1'], {
    input: dump,
    env: {
      ...process.env,
      PGPASSWORD: decodeURIComponent(target.password || source.password),
    },
  });
}

function copyMini(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'knowledge-mini-'));
  cpSync(MINI, dir, { recursive: true });
  writeManifest(dir, buildManifest(dir, '2026-11-22'));
  return dir;
}

function materialiseSeeds(): string | null {
  const fromEnv = process.env.KNOWLEDGE_SEEDS_DIR;
  if (fromEnv && statSync(fromEnv, { throwIfNoEntry: false })?.isDirectory()) return fromEnv;
  const repo = path.resolve('scripts/fieldops/seeds');
  if (statSync(repo, { throwIfNoEntry: false })?.isDirectory()) return repo;
  if (!statSync(STORE, { throwIfNoEntry: false })?.isDirectory()) return null;
  const dest = mkdtempSync(path.join(tmpdir(), 'knowledge-seeds-'));
  for (const folder of readdirSync(STORE)) {
    const source = path.join(STORE, folder);
    if (!statSync(source).isDirectory()) continue;
    cpSync(source, path.join(dest, '_incoming', folder), { recursive: true });
  }
  writeManifest(dest, buildManifest(dest, '2026-11-22'));
  return dest;
}

describe('knowledge stage safety', () => {
  it('I12 exits 3 before connecting when the target is shared and unconfirmed', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/fieldops/knowledge/import/cli.ts', 'stage', '--apply'],
      {
        cwd: path.resolve(import.meta.dirname, '../../../..'),
        env: {
          ...process.env,
          KNOWLEDGE_TARGET: 'shared',
          KNOWLEDGE_DB_URL: 'postgresql://postgres:secret@127.0.0.1:1/none',
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 3);
    assert.match(result.stderr, /confirm-project/);
    assert.doesNotMatch(result.stderr, /ECONNREFUSED/);
  });

  it('a dirty manifest exits 3 before connecting', async () => {
    const dir = copyMini();
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      files: { sha256: string }[];
    };
    manifest.files[0]!.sha256 = '0'.repeat(64);
    writeManifest(dir, manifest as never);
    await assert.rejects(
      () =>
        stage({
          dir,
          folders: ['blast-effects'],
          apply: false,
          allowManifestDrift: false,
          target: { url: 'postgresql://postgres:secret@127.0.0.1:1/none', target: 'local' },
        }),
      (error: unknown) => error instanceof SafetyError && /manifest drift/.test(error.message),
    );
  });
});

describe('knowledge stage on a local database', () => {
  const url = localUrl();

  it(
    'I1, I3 and I11',
    { skip: url ? false : 'KNOWLEDGE_DB_URL is not a local database' },
    async () => {
      assert.ok(url);
      await ensureDatabase(url, 'knowledge_fixture');
      const fixture = withDatabase(url, 'knowledge_fixture');
      const previous = process.env.KNOWLEDGE_TARGET;
      process.env.KNOWLEDGE_TARGET = 'local';
      const dir = copyMini();
      const client = new pg.Client({ connectionString: fixture });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('fieldops.allow_delete', 'on', true)`);
        await client.query(
          `DELETE FROM public.fieldops_knowledge_record_history
          WHERE record_id IN (SELECT id FROM public.fieldops_knowledge_records WHERE file_path = $1)`,
          [MINI_FILE],
        );
        await client.query(`DELETE FROM public.fieldops_knowledge_records WHERE file_path = $1`, [
          MINI_FILE,
        ]);
        await client.query(`DELETE FROM public.fieldops_seed_files WHERE file_path = $1`, [
          MINI_FILE,
        ]);
        await client.query('COMMIT');

        const before = await counts(client);
        const dry = await stage({
          dir,
          folders: ['blast-effects'],
          apply: false,
          allowManifestDrift: false,
          target: { url: fixture, target: 'local' },
        });
        const afterDry = await counts(client);
        assert.deepEqual(afterDry, before);
        const dryLog = await client.query<{ status: string }>(
          `SELECT status FROM public.fieldops_knowledge_import_runs WHERE id = $1`,
          [dry.runId],
        );
        assert.equal(dryLog.rows[0]?.status, 'rolled_back');

        const first = await stage({
          dir,
          folders: ['blast-effects'],
          apply: true,
          allowManifestDrift: false,
          target: { url: fixture, target: 'local' },
        });
        assert.equal(first.counts.inserted, 1);
        assert.equal(first.counts.changed, 0);
        const history = await historyCount(client, MINI_FILE);
        assert.equal(history, 1);
        const staged = await client.query<{
          review_state: string;
          sha256: string;
          record_count: number;
        }>(
          `SELECT r.review_state, f.sha256, f.record_count
           FROM public.fieldops_knowledge_records r
           JOIN public.fieldops_seed_files f ON f.file_path = r.file_path
          WHERE r.file_path = $1`,
          [MINI_FILE],
        );
        assert.equal(staged.rows[0]?.review_state, 'pending');
        assert.equal(staged.rows[0]?.record_count, 1);
        assert.equal(staged.rows[0]?.sha256.length, 64);

        const second = await stage({
          dir,
          folders: ['blast-effects'],
          apply: true,
          allowManifestDrift: false,
          target: { url: fixture, target: 'local' },
        });
        assert.equal(second.counts.changed, 0);
        assert.equal(second.counts.inserted, 0);
        assert.equal(second.counts.unchanged, 1);
        assert.equal(await historyCount(client, MINI_FILE), history);

        await assert.rejects(
          client.query(`DELETE FROM public.fieldops_knowledge_records WHERE file_path = $1`, [
            MINI_FILE,
          ]),
          /allow_delete/,
        );
        await client.query('BEGIN');
        await client.query(`SELECT set_config('fieldops.allow_delete', 'on', true)`);
        const removed = await client.query(
          `DELETE FROM public.fieldops_knowledge_records WHERE file_path = $1`,
          [MINI_FILE],
        );
        assert.equal(removed.rowCount, 1);
        await client.query('ROLLBACK');
        const stillThere = await client.query(
          `SELECT count(*)::int AS records FROM public.fieldops_knowledge_records WHERE file_path = $1`,
          [MINI_FILE],
        );
        assert.equal(stillThere.rows[0]?.records, 1);
      } finally {
        process.env.KNOWLEDGE_TARGET = previous;
        await client.end();
      }
    },
  );

  it(
    'I2 stages the research files and a second apply changes nothing',
    {
      skip: url ? false : 'KNOWLEDGE_DB_URL is not a local database',
    },
    async () => {
      assert.ok(url);
      const dir = materialiseSeeds();
      if (!dir) return;
      process.env.KNOWLEDGE_TARGET = 'local';
      const target = { url, target: 'local' as const };
      const first = await stage({
        dir,
        folders: [],
        apply: true,
        allowManifestDrift: false,
        target,
      });
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        const records = await client.query<{ records: number; pending: number }>(
          `SELECT count(*)::int AS records, count(*) FILTER (WHERE review_state = 'pending')::int AS pending
           FROM public.fieldops_knowledge_records WHERE missing_since IS NULL`,
        );
        const expected = first.counts.records;
        assert.ok(expected === 1064 || expected === 1093 || expected === 1097);
        assert.equal(records.rows[0]?.records, expected);
        if (expected === 1064 || expected === 1093)
          assert.equal(records.rows[0]?.pending, expected);
        const files = await client.query<{
          file_path: string;
          sha256: string;
          record_count: number;
        }>(
          `SELECT file_path, sha256, record_count FROM public.fieldops_seed_files WHERE missing_since IS NULL`,
        );
        const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
          files: { path: string; sha256: string; records: Record<string, number> }[];
        };
        assert.equal(files.rowCount, manifest.files.length);
        for (const file of manifest.files) {
          const row = files.rows.find((item) => item.file_path === file.path);
          assert.ok(row, file.path);
          assert.equal(row.sha256, file.sha256);
          const count = Object.values(file.records).reduce((sum, value) => sum + value, 0);
          assert.equal(row.record_count, count);
        }
        const runs = await client.query<{ pairs: number }>(
          `SELECT count(*)::int AS pairs FROM (
           SELECT DISTINCT library, COALESCE(source_run_id::text, id::text) FROM public.fieldops_seed_runs
         ) pairs`,
        );
        assert.ok((runs.rows[0]?.pairs ?? 0) >= 5);
        for (const key of [
          'crouch_speed_factor',
          'pool_fire',
          'source:nfpa-855',
          'doctrine_force_ceilings',
        ]) {
          const gap = await client.query(
            `SELECT 1 FROM public.fieldops_knowledge_coverage WHERE subject_key = $1 AND status = 'gap'`,
            [key],
          );
          assert.equal(gap.rowCount, 1, key);
        }
        const history = await client.query<{ rows: number }>(
          `SELECT count(*)::int AS rows FROM public.fieldops_knowledge_record_history`,
        );
        const second = await stage({
          dir,
          folders: [],
          apply: true,
          allowManifestDrift: false,
          target,
        });
        const historyAfter = await client.query<{ rows: number }>(
          `SELECT count(*)::int AS rows FROM public.fieldops_knowledge_record_history`,
        );
        assert.equal(second.counts.changed, 0);
        assert.equal(historyAfter.rows[0]?.rows, history.rows[0]?.rows);
      } finally {
        await client.end();
      }
    },
  );
});

async function counts(client: pg.Client): Promise<Record<string, number>> {
  const result = await client.query<{ name: string; rows: number }>(`
    SELECT 'records' AS name, count(*)::int AS rows FROM public.fieldops_knowledge_records
    UNION ALL SELECT 'files', count(*)::int FROM public.fieldops_seed_files
    UNION ALL SELECT 'runs', count(*)::int FROM public.fieldops_seed_runs
    UNION ALL SELECT 'coverage', count(*)::int FROM public.fieldops_knowledge_coverage
    UNION ALL SELECT 'history', count(*)::int FROM public.fieldops_knowledge_record_history
  `);
  return Object.fromEntries(result.rows.map((row) => [row.name, row.rows]));
}

async function historyCount(client: pg.Client, filePath: string): Promise<number> {
  const result = await client.query<{ rows: number }>(
    `SELECT count(*)::int AS rows FROM public.fieldops_knowledge_record_history
      WHERE record_id IN (SELECT id FROM public.fieldops_knowledge_records WHERE file_path = $1)`,
    [filePath],
  );
  return result.rows[0]?.rows ?? 0;
}
