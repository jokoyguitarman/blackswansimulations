/** Stable slug conditions use to name an inject. `^[a-z0-9_]{1,60}$`. */
const INJECT_KEY = /^[a-z0-9_]{1,60}$/;

export function isValidInjectKey(value: string): boolean {
  return INJECT_KEY.test(value);
}

/**
 * `delivery_config.inject_key` when it is a valid slug, otherwise `inj_` plus the
 * first 8 hex characters of the inject id. No backfill: existing rows use the fallback.
 */
export function injectKeyOf(inject: {
  id: string;
  delivery_config?: { inject_key?: unknown } | null;
}): string {
  const raw = inject.delivery_config?.inject_key;
  if (typeof raw === 'string' && isValidInjectKey(raw)) return raw;
  const hex = inject.id.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  return `inj_${(hex + '00000000').slice(0, 8)}`;
}

/** Lowercase slug of a title, at most 60 characters. Empty titles become `inject`. */
export function slugifyInjectTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
    .replace(/_+$/g, '');
  return isValidInjectKey(slug) ? slug : 'inject';
}

function allocateInjectKey(title: string, taken: Set<string>): string {
  const base = slugifyInjectTitle(title);
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let n = 2; n < 10000; n++) {
    const suffix = `_${n}`;
    const stem = base.slice(0, 60 - suffix.length).replace(/_+$/g, '') || 'inject';
    const candidate = `${stem}${suffix}`;
    if (isValidInjectKey(candidate) && !taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  const fallback = `inj_${taken.size.toString(16).padStart(8, '0')}`.slice(0, 60);
  taken.add(fallback);
  return fallback;
}

/**
 * Stamp `delivery_config.inject_key` on generated injects. An existing valid key is kept.
 * Collisions within the list, and any key passed in `taken`, get a `_2`, `_3` suffix.
 * Keys are unique per call. Apply passes every key that stays active so a new inject
 * cannot reuse one.
 */
export function stampGeneratedInjectKeys<
  T extends { title?: string | null; delivery_config?: object | null },
>(
  injects: readonly T[],
  options?: { taken?: readonly string[] },
): Array<Omit<T, 'delivery_config'> & { delivery_config: Record<string, unknown> }> {
  const taken = new Set<string>();
  for (const key of options?.taken ?? []) {
    if (isValidInjectKey(key)) taken.add(key);
  }
  for (const inject of injects) {
    const existing = configOf(inject).inject_key;
    if (typeof existing === 'string' && isValidInjectKey(existing)) taken.add(existing);
  }
  return injects.map((inject) => {
    const config = { ...configOf(inject) };
    const existing = typeof config.inject_key === 'string' ? config.inject_key : null;
    config.inject_key =
      existing && isValidInjectKey(existing)
        ? existing
        : allocateInjectKey(inject.title ?? '', taken);
    return { ...inject, delivery_config: config };
  });
}

function configOf(inject: { delivery_config?: object | null }): Record<string, unknown> {
  const config = inject.delivery_config;
  if (!config || typeof config !== 'object') return {};
  return { ...(config as Record<string, unknown>) };
}
