import { logger } from '../../lib/logger.js';

const SCHEMA_CODES = new Set(['42P01', '42883', 'PGRST202', 'PGRST205']);

/** PostgREST or Postgres reporting that migration 267 is not in this database. */
export function isDurableSchemaMissing(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return typeof code === 'string' && SCHEMA_CODES.has(code);
}

let unavailableLogged = false;

/** One line per process. Routes and the background loops share it. */
export function noteDurableBuildsUnavailable(): void {
  if (unavailableLogged) return;
  unavailableLogged = true;
  logger.warn('warroom_durable_builds_unavailable');
}
