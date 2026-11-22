import pg from 'pg';
import type { DbTarget } from './safety.js';

export async function withClient<T>(
  target: DbTarget,
  run: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: target.url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

export async function beginImport(client: pg.Client, importRunId: string): Promise<void> {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query(`SELECT set_config('fieldops.import_run_id', $1, true)`, [importRunId]);
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('fieldops_knowledge_import'))`);
}
