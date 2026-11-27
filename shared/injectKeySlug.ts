/** Stable inject_key slug. Matches server/lib/injectKey.ts. `^[a-z0-9_]{1,60}$`. */

const INJECT_KEY = /^[a-z0-9_]{1,60}$/;

export function isInjectKey(value: string): boolean {
  return INJECT_KEY.test(value);
}

/** Lowercase slug of a title, at most 60 characters. Empty titles become `inject`. */
export function slugifyInjectTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
    .replace(/_+$/g, '');
  return isInjectKey(slug) ? slug : 'inject';
}

/** First free slug for a title. Collisions get `_2`, `_3`, and so on. */
export function uniqueInjectKey(title: string, taken: ReadonlySet<string>): string {
  const base = slugifyInjectTitle(title);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 10000; n++) {
    const suffix = `_${n}`;
    const stem = base.slice(0, 60 - suffix.length).replace(/_+$/g, '') || 'inject';
    const candidate = `${stem}${suffix}`;
    if (isInjectKey(candidate) && !taken.has(candidate)) return candidate;
  }
  return `inj_${taken.size.toString(16).padStart(8, '0')}`.slice(0, 60);
}
