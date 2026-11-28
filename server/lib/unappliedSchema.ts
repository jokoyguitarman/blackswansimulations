/** PostgREST / Postgres codes for a migration that has not been applied. */

const SCHEMA_CODES = new Set(['42P01', '42703', 'PGRST204', 'PGRST205']);

export function errorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export function isUnappliedSchema(err: unknown): boolean {
  const code = errorCode(err);
  return code != null && SCHEMA_CODES.has(code);
}
