/**
 * One canonical JSON for a build request hash (durable scenario builds §3).
 * Object keys are sorted recursively, `undefined` object fields are dropped,
 * and arrays keep their order (an `undefined` element becomes JSON null).
 */
export function canonicalJson(value: unknown): string {
  const canon = canonicalize(value);
  return JSON.stringify(canon === undefined ? null : canon);
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      const next = canonicalize(item);
      return next === undefined ? null : next;
    });
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const next = canonicalize(obj[key]);
    if (next !== undefined) out[key] = next;
  }
  return out;
}
