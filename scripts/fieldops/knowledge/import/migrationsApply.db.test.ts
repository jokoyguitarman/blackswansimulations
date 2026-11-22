import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { describe, it } from 'node:test';

const ORDER = [
  '221',
  '222',
  '223',
  '224',
  '239',
  '240',
  '242',
  '250',
  '257',
  '258',
  '259',
  '261',
  '262',
  '263',
];

const MIGRATIONS = path.resolve(import.meta.dirname, '../../../..', 'migrations');

function localUrl(): string | null {
  const url = process.env.KNOWLEDGE_DB_URL;
  if (!url) return null;
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') return null;
  return url;
}

function migrationFiles(): string[] {
  const names = readdirSync(MIGRATIONS);
  return ORDER.map((prefix) => {
    const name = names.find((file) => file.startsWith(`${prefix}_`) && file.endsWith('.sql'));
    if (!name) throw new Error(`missing migration ${prefix}`);
    return path.join(MIGRATIONS, name);
  });
}

async function applyAll(client: pg.Client): Promise<void> {
  for (const file of migrationFiles()) {
    await client.query(readFileSync(file, 'utf8'));
  }
}

async function snapshot(client: pg.Client): Promise<string> {
  const result = await client.query<{ def: string }>(`
    SELECT md5(string_agg(def, E'\\n' ORDER BY def)) AS def FROM (
      SELECT format('t %s %s', c.relname, c.relrowsecurity) AS def
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
      UNION ALL
      SELECT format('c %s %s %s', table_name, column_name, data_type)
        FROM information_schema.columns WHERE table_schema = 'public'
      UNION ALL
      SELECT format('x %s %s', conrelid::regclass, pg_get_constraintdef(oid))
        FROM pg_constraint WHERE connamespace = 'public'::regnamespace
      UNION ALL
      SELECT format('i %s', indexdef) FROM pg_indexes WHERE schemaname = 'public'
      UNION ALL
      SELECT format('g %s %s', tgrelid::regclass, pg_get_triggerdef(oid))
        FROM pg_trigger WHERE NOT tgisinternal
      UNION ALL
      SELECT format('p %s %s', polrelid::regclass, polname)
        FROM pg_policy
    ) defs
  `);
  return result.rows[0]?.def ?? '';
}

describe('knowledge migrations on a local database', () => {
  const url = localUrl();

  it(
    'applies 221-263 twice, keeps the catalog, and refuses anon',
    { skip: url ? false : 'KNOWLEDGE_DB_URL unset or not local' },
    async () => {
      assert.ok(url);
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        await applyAll(client);
        const first = await snapshot(client);
        await applyAll(client);
        const second = await snapshot(client);
        assert.equal(second, first);

        const triggers = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pg_trigger WHERE tgname = 'trg_fieldops_row_history' AND NOT tgisinternal`,
        );
        assert.equal(triggers.rows[0]?.count, '24');

        const tables = await client.query<{ relname: string }>(`
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind = 'r'
           AND c.relrowsecurity
           AND (c.relname LIKE 'fieldops_%' OR c.relname LIKE 'doctrine%' OR c.relname LIKE 'team_archetype%')
      `);
        assert.ok(tables.rows.length >= 24);
        for (const role of ['anon', 'authenticated']) {
          for (const table of tables.rows) {
            await client.query('BEGIN');
            await assert.rejects(
              client.query(
                `SET LOCAL ROLE ${role}; SELECT 1 FROM public.${quoteIdent(table.relname)} LIMIT 1`,
              ),
              /permission denied/i,
            );
            await client.query('ROLLBACK');
          }
        }

        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE service_role');
        await client.query('SELECT 1 FROM public.fieldops_seed_files LIMIT 1');
        await client.query('ROLLBACK');

        await client.query('BEGIN');
        await assert.rejects(
          client.query(
            `SET LOCAL ROLE service_role; SELECT 1 FROM public.fieldops_unit_kinds LIMIT 1`,
          ),
          /permission denied/i,
        );
        await client.query('ROLLBACK');
      } finally {
        await client.end();
      }
    },
  );
});

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unexpected table ${name}`);
  return name;
}
