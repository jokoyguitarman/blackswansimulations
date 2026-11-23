import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { redact, type DbTarget } from './safety.js';

export const IMPORTER_VERSION = 'knowledge-seed-1';

export interface RunLogStart {
  id: string;
  command: 'stage' | 'promote' | 'verify';
  mode: 'dry_run' | 'apply';
  target: 'local' | 'shared';
  seedsDir: string;
  folders: string[];
  libraries: string[];
  manifestSha256: string | null;
  args: Record<string, unknown>;
}

export async function startRun(target: DbTarget, input: Omit<RunLogStart, 'id'>): Promise<string> {
  const id = randomUUID();
  const client = new pg.Client({ connectionString: target.url });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO public.fieldops_knowledge_import_runs
        (id, command, mode, status, target, seeds_dir, folders, libraries, git_sha, importer_version, manifest_sha256, args)
       VALUES ($1, $2, $3, 'running', $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [
        id,
        input.command,
        input.mode,
        input.target,
        input.seedsDir.slice(0, 300),
        input.folders,
        input.libraries,
        gitSha(),
        IMPORTER_VERSION,
        input.manifestSha256,
        JSON.stringify(input.args),
      ],
    );
  } finally {
    await client.end();
  }
  return id;
}

export async function finishRun(
  target: DbTarget,
  id: string,
  status: 'succeeded' | 'failed' | 'rolled_back',
  counts: Record<string, unknown>,
  issueSummary: Record<string, number>,
  error?: string,
): Promise<void> {
  const client = new pg.Client({ connectionString: target.url });
  await client.connect();
  try {
    await client.query(
      `UPDATE public.fieldops_knowledge_import_runs
          SET status = $2, finished_at = now(), counts = $3::jsonb, issue_summary = $4::jsonb, error = $5
        WHERE id = $1`,
      [
        id,
        status,
        JSON.stringify(counts),
        JSON.stringify(issueSummary),
        error ? redact(error).slice(0, 4000) : null,
      ],
    );
  } finally {
    await client.end();
  }
}

function gitSha(): string | null {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}
