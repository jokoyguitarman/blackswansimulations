import { logger } from '../../lib/logger.js';

/** Missing column or relation. PostgREST uses PGRST204 for a column the schema cache lacks. */
const SCHEMA_CODES = new Set(['42P01', '42703', 'PGRST204']);

export function topicErrorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export function isTopicSchemaMissing(err: unknown): boolean {
  const code = topicErrorCode(err);
  return code != null && SCHEMA_CODES.has(code);
}

let warned = false;

/** One warning per process. Further missing-column errors stay quiet. */
export function noteTopicSchemaMissing(): boolean {
  if (warned) return false;
  warned = true;
  logger.warn(
    { event: 'topic_columns_unavailable' },
    'Topic labels are off because migration 282 is not applied',
  );
  return true;
}

export function topicSchemaMissing(): boolean {
  return warned;
}

export function resetTopicSchemaForTests(): void {
  warned = false;
}

export type TopicKind = 'normal' | 'crisis';

/** Empty when the flag is off or the kind is omitted, so the insert matches today's row. */
export function topicKindColumns(
  enabled: boolean,
  kind: TopicKind | undefined,
  schemaMissing: boolean,
): { topic_kind?: TopicKind } {
  if (!enabled || schemaMissing || !kind) return {};
  return { topic_kind: kind };
}

const TOPIC_KEYS = ['topic_kind', 'topic_class', 'topic_confidence', 'topic_bridge'] as const;

export function rowHasTopicColumn(row: Record<string, unknown>): boolean {
  return TOPIC_KEYS.some((key) => row[key] !== undefined);
}

export function stripTopicColumns(row: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'topic_kind' || key === 'topic_class' || key === 'topic_confidence' || key === 'topic_bridge') {
      continue;
    }
    next[key] = value;
  }
  return next;
}

/**
 * Runs an insert. On a missing topic column, warns once and retries without those columns.
 * With no topic columns in the row, this is a single insert.
 */
export async function insertSocialPost<T>(
  row: Record<string, unknown>,
  exec: (payload: Record<string, unknown>) => PromiseLike<{ data: T; error: unknown }>,
  /**
   * Which errors mean "the topic columns are not there". The default treats
   * every missing-column code that way. A peace insert passes a narrower check
   * so a missing `peace_ref` is not recorded as migration 282.
   */
  topicColumnMissing: (err: unknown) => boolean = isTopicSchemaMissing,
): Promise<{ data: T; error: unknown }> {
  const first = await exec(row);
  if (first.error && rowHasTopicColumn(row) && topicColumnMissing(first.error)) {
    noteTopicSchemaMissing();
    return exec(stripTopicColumns(row));
  }
  return first;
}
