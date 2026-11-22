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

/** Tables created by 261, 262 and 263. Their SQL revokes anon and authenticated. */
const REVOKED_FROM_API = [
  'fieldops_unit_kinds',
  'fieldops_equipment',
  'fieldops_unit_equipment',
  'fieldops_response_standards',
  'fieldops_hospitals',
  'fieldops_hospital_specialties',
  'fieldops_capacity_aggregates',
  'fieldops_knowledge_import_runs',
  'fieldops_seed_files',
  'fieldops_knowledge_records',
  'fieldops_knowledge_record_history',
  'fieldops_knowledge_reference_values',
  'fieldops_library_row_history',
];

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
    'applies 221-263 twice, lets service_role select, and refuses anon on 261-263',
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

        // Spec M3: service_role can select every new table. Supabase's default
        // grants give it that access; the copied SQL does not GRANT it itself.
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE service_role');
        for (const table of tables.rows) {
          await client.query(`SELECT 1 FROM public.${quoteIdent(table.relname)} LIMIT 1`);
        }
        await client.query('ROLLBACK');

        // anon and authenticated are revoked on 261, 262 and 263. PR #23's
        // twelve tables still keep Supabase's default table grants, so this
        // test does not claim those are denied.
        for (const role of ['anon', 'authenticated']) {
          for (const name of REVOKED_FROM_API) {
            await client.query('BEGIN');
            await assert.rejects(
              client.query(
                `SET LOCAL ROLE ${role}; SELECT 1 FROM public.${quoteIdent(name)} LIMIT 1`,
              ),
              /permission denied/i,
            );
            await client.query('ROLLBACK');
          }
        }
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
