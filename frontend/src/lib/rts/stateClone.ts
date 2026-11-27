/**
 * Deep copy of an engine's state. Plain objects, arrays, maps, sets and
 * typed arrays are copied, and an object reached twice is copied once, so
 * the copy keeps the original's aliasing. Objects in `shared` are kept by
 * reference. An instance of a class in `classes` keeps its prototype.
 *
 * Anything else, a function, a weak collection or an unknown class, throws.
 * A field the copy cannot carry would let the copy step differently from
 * the original, and that must fail loudly rather than drift.
 */
export function cloneState<T>(
  root: T,
  shared: ReadonlySet<object>,
  classes: ReadonlySet<abstract new (...args: never[]) => unknown>,
): T {
  const copies = new Map<object, unknown>();
  const copy = (value: unknown): unknown => {
    if (typeof value === 'function') throw new Error('cloneState: cannot copy a function');
    if (value === null || typeof value !== 'object') return value;
    if (shared.has(value)) return value;
    const known = copies.get(value);
    if (known !== undefined) return known;
    if (value instanceof Map) {
      const out = new Map();
      copies.set(value, out);
      for (const [k, v] of value) out.set(copy(k), copy(v));
      return out;
    }
    if (value instanceof Set) {
      const out = new Set();
      copies.set(value, out);
      for (const v of value) out.add(copy(v));
      return out;
    }
    if (ArrayBuffer.isView(value)) {
      if (value instanceof DataView) throw new Error('cloneState: cannot copy a DataView');
      const out = (value as unknown as { slice: () => unknown }).slice();
      copies.set(value, out);
      return out;
    }
    if (Array.isArray(value)) {
      const out: unknown[] = new Array(value.length);
      copies.set(value, out);
      for (let i = 0; i < value.length; i++) if (i in value) out[i] = copy(value[i]);
      return out;
    }
    const proto = Object.getPrototypeOf(value) as { constructor?: unknown } | null;
    const plain = proto === Object.prototype || proto === null;
    if (!plain && !classes.has(proto?.constructor as abstract new (...args: never[]) => unknown)) {
      const name = (proto?.constructor as { name?: string } | undefined)?.name ?? 'unknown';
      throw new Error(`cloneState: cannot copy a ${name}`);
    }
    const out = Object.create(proto) as Record<string, unknown>;
    copies.set(value, out);
    for (const key of Object.keys(value)) {
      out[key] = copy((value as Record<string, unknown>)[key]);
    }
    return out;
  };
  return copy(root) as T;
}
