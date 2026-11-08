/** Missing or non-integer values use the fallback; integers are clamped to [min, max]. */
export function readIntSetting(
  raw: string | undefined,
  bounds: { fallback: number; min: number; max: number },
): number {
  if (raw === undefined) return bounds.fallback;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return bounds.fallback;
  const value = Number(trimmed);
  if (!Number.isInteger(value)) return bounds.fallback;
  return Math.min(bounds.max, Math.max(bounds.min, value));
}
