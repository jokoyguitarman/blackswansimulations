import { withClient } from './db.js';
import type { DbTarget } from './safety.js';

export async function status(target: DbTarget, library?: string): Promise<Record<string, unknown>> {
  return withClient(target, async (client) => {
    const states = await client.query(
      `SELECT library, record_kind, review_state, count(*)::int AS records
         FROM public.fieldops_knowledge_records
        WHERE ($1::text IS NULL OR library = $1)
        GROUP BY library, record_kind, review_state
        ORDER BY library, record_kind, review_state`,
      [library ?? null],
    );
    const blockers = await client.query(
      `SELECT issue->>'code' AS code, count(*)::int AS records
         FROM public.fieldops_knowledge_records, jsonb_array_elements(issues) AS issue
        WHERE issue->>'severity' = 'blocker' AND ($1::text IS NULL OR library = $1)
        GROUP BY issue->>'code' ORDER BY code`,
      [library ?? null],
    );
    const pending = await client.query(
      `SELECT count(*)::int AS records FROM public.fieldops_knowledge_records
        WHERE pending_change AND ($1::text IS NULL OR library = $1)`,
      [library ?? null],
    );
    const missing = await client.query(
      `SELECT count(*)::int AS records FROM public.fieldops_seed_files WHERE missing_since IS NOT NULL`,
    );
    const running = await client.query(
      `SELECT count(*)::int AS runs FROM public.fieldops_knowledge_import_runs WHERE status = 'running'`,
    );
    return {
      states: states.rows,
      blockers: blockers.rows,
      pending_change: pending.rows[0]?.records ?? 0,
      files_missing: missing.rows[0]?.records ?? 0,
      runs_still_running: running.rows[0]?.runs ?? 0,
    };
  });
}
