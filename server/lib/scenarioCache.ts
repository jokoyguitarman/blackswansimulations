/**
 * Scenario-derived data cache, keyed on (scenario_id, scenarios.updated_at).
 *
 * The `update_scenarios_updated_at` trigger (migration 001) bumps `updated_at` on every write,
 * so post-compile edits to `initial_state` between sessions are picked up automatically —
 * contract §7 item 10. A short re-check window avoids one PK lookup per call on hot paths.
 */
import { supabaseAdmin } from './supabaseAdmin.js';
import { logger } from './logger.js';

export interface ScenarioSnapshot {
  id: string;
  updated_at: string;
  title: string;
  description: string;
  initial_state: Record<string, unknown>;
}

interface SnapshotEntry {
  snapshot: ScenarioSnapshot;
  checkedAt: number;
}

const UPDATED_AT_RECHECK_MS = 5_000;

const snapshots = new Map<string, SnapshotEntry>();
// namespace → scenarioId → { updatedAt, value }
const derived = new Map<string, Map<string, { updatedAt: string; value: unknown }>>();

async function fetchSnapshot(scenarioId: string): Promise<ScenarioSnapshot | null> {
  const { data, error } = await supabaseAdmin
    .from('scenarios')
    .select('id, updated_at, title, description, initial_state')
    .eq('id', scenarioId)
    .maybeSingle();
  if (error) {
    logger.warn({ error, scenarioId }, 'scenarioCache: failed to fetch scenario');
    return null;
  }
  if (!data) return null;
  return {
    id: data.id as string,
    updated_at: String(data.updated_at ?? ''),
    title: String(data.title ?? ''),
    description: String(data.description ?? ''),
    initial_state: ((data.initial_state as Record<string, unknown> | null) ?? {}) as Record<
      string,
      unknown
    >,
  };
}

/** Current scenario row, refreshed whenever `updated_at` changes. Null when the scenario is gone. */
export async function getScenarioSnapshot(scenarioId: string): Promise<ScenarioSnapshot | null> {
  const now = Date.now();
  const entry = snapshots.get(scenarioId);
  if (entry && now - entry.checkedAt < UPDATED_AT_RECHECK_MS) return entry.snapshot;

  if (entry) {
    const { data } = await supabaseAdmin
      .from('scenarios')
      .select('updated_at')
      .eq('id', scenarioId)
      .maybeSingle();
    const updatedAt = String(data?.updated_at ?? '');
    if (data && updatedAt === entry.snapshot.updated_at) {
      entry.checkedAt = now;
      return entry.snapshot;
    }
  }

  const fresh = await fetchSnapshot(scenarioId);
  if (!fresh) {
    snapshots.delete(scenarioId);
    return null;
  }
  snapshots.set(scenarioId, { snapshot: fresh, checkedAt: now });
  return fresh;
}

/**
 * Compute-once-per-version helper. `loader` runs whenever the scenario's `updated_at` differs
 * from the cached value for this namespace.
 */
export async function cachedByScenario<T>(
  namespace: string,
  scenarioId: string,
  loader: (snapshot: ScenarioSnapshot) => T | Promise<T>,
  fallback: T,
): Promise<T> {
  const snapshot = await getScenarioSnapshot(scenarioId);
  if (!snapshot) return fallback;

  let store = derived.get(namespace);
  if (!store) {
    store = new Map();
    derived.set(namespace, store);
  }
  const hit = store.get(scenarioId);
  if (hit && hit.updatedAt === snapshot.updated_at) return hit.value as T;

  try {
    const value = await loader(snapshot);
    store.set(scenarioId, { updatedAt: snapshot.updated_at, value });
    return value;
  } catch (err) {
    logger.warn({ err, namespace, scenarioId }, 'scenarioCache: loader failed; using fallback');
    return fallback;
  }
}

/** Drop every cached value for a scenario (tests / explicit invalidation). */
export function invalidateScenario(scenarioId: string): void {
  snapshots.delete(scenarioId);
  for (const store of derived.values()) store.delete(scenarioId);
}

/** Resolve a session's scenario id (small, uncached — sessions rarely change scenario). */
export async function getSessionScenarioId(sessionId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id')
    .eq('id', sessionId)
    .maybeSingle();
  return (data?.scenario_id as string | null) ?? null;
}
