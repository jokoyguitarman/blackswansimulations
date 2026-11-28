/**
 * leak_terms stay on the stored scenario. Player-facing copies drop them.
 * The editor's peace-feed route is the one place a trainer still reads them.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Copy `peace_period` without `leak_terms`. Other keys, including the posts, stay. */
export function withoutPeaceLeakTerms<T>(value: T): T {
  const record = asRecord(value);
  if (!record || !('peace_period' in record)) return value;
  const peace = asRecord(record.peace_period);
  if (!peace || !('leak_terms' in peace)) return value;
  const nextPeace: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(peace)) {
    if (key === 'leak_terms') continue;
    nextPeace[key] = item;
  }
  return { ...record, peace_period: nextPeace } as T;
}

/** Session payloads carry the scenario snapshot on `current_state`. */
export function withoutSessionLeakTerms<T extends Record<string, unknown>>(payload: T): T {
  const state = payload.current_state;
  if (!asRecord(state)) return payload;
  return { ...payload, current_state: withoutPeaceLeakTerms(state) };
}
