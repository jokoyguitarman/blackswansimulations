/**
 * Organisation-name matching shared by the wizard and the footprint guard rail.
 * Pure: no imports, so both the frontend (`@shared/orgNames`) and the server
 * (`../../shared/orgNames.js`) can use it.
 */

/** Lowercase, accents and bracketed text dropped, punctuation collapsed:
 *  "Ministry of Human Resources (MOHR)" -> "ministry of human resources". */
export function normaliseOrgName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The same organisation written two ways: equal once normalised, or the shorter
 *  (8+ characters) appearing as whole words inside the longer. */
export function sameOrganisationName(a: string, b: string): boolean {
  const x = normaliseOrgName(a);
  const y = normaliseOrgName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < 8) return false;
  return ` ${long} `.includes(` ${short} `);
}
