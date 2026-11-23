import { createHash } from 'node:crypto';
import { LIBRARIES, type Library } from './types.js';

const DESIGN_FIRE = [
  'hrrpua_kw_m2',
  'heat_of_combustion_mj_kg',
  'soot_yield',
  'co_yield',
  'heat_release',
] as const;

const LIBRARY_MAP: Record<string, Library> = {
  physics: 'blast_effects',
  smoke: 'fire_smoke_tenability',
  responder_units: 'units',
  responder_equipment: 'units',
};

export function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function fullDate(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

export function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('https://') || value.length > 1000) return null;
  return value;
}

/** Latest `beds_YYYY` numeric value. `beds_latest` and other names never fill beds. */
export function hospitalBeds(values: unknown[]): { beds: number | null; bedsYear: number | null } {
  let year = -1;
  let beds: number | null = null;
  for (const item of values) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const match = /^beds_(\d{4})$/.exec(typeof row.param === 'string' ? row.param : '');
    if (!match || typeof row.value !== 'number' || !Number.isFinite(row.value)) continue;
    const next = Number(match[1]);
    if (next >= year) {
      year = next;
      beds = Math.round(row.value);
    }
  }
  return year < 0 ? { beds: null, bedsYear: null } : { beds, bedsYear: year };
}

export function responseNumbers(values: unknown[]): {
  respond_within_s: number | null;
  answer_within_s: number | null;
  target_share_pct: number | null;
  measured_from: string | null;
} {
  const byParam = new Map<string, unknown>();
  for (const item of values) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.param === 'string') byParam.set(row.param, row.value);
  }
  const number = (name: string): number | null => {
    const value = byParam.get(name);
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const measured = byParam.get('measured_from');
  return {
    respond_within_s: number('respond_within_s'),
    answer_within_s: number('answer_within_s'),
    target_share_pct: number('target_share_pct'),
    measured_from:
      measured === 'call_receipt' || measured === 'dispatch' || measured === 'unknown'
        ? measured
        : null,
  };
}

export function doctrineSourceKey(url: string): string {
  let host = '';
  let pathname = '';
  try {
    const parsed = new URL(url);
    host = parsed.host;
    pathname = parsed.pathname;
  } catch {
    host = url;
  }
  const folded = `doc.${host}${pathname}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const key = folded.length > 120 ? folded.slice(0, 120).replace(/-+$/g, '') : folded;
  return key.length >= 3 ? key : `doc-${key || 'source'}`;
}

/** Same derived key from two different URLs gains an 8-hex suffix. */
export function assignDoctrineSourceKey(url: string, used: Map<string, string>): string {
  const key = doctrineSourceKey(url);
  const owner = used.get(key);
  if (!owner || owner === url) {
    used.set(key, url);
    return key;
  }
  const suffix = createHash('sha256').update(url, 'utf8').digest('hex').slice(0, 8);
  const room = 120 - suffix.length - 1;
  const next = `${key.slice(0, room).replace(/-+$/g, '')}-${suffix}`;
  used.set(next, url);
  return next;
}

export function mapLibraries(values: unknown[]): Library[] {
  const out = new Set<Library>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const mapped = LIBRARY_MAP[value] ?? value;
    if ((LIBRARIES as readonly string[]).includes(mapped)) out.add(mapped as Library);
  }
  return [...out].sort();
}

/**
 * Planning row is the base. A research patch overlays only its non-null design-fire columns.
 * Planning values stay where the patch is null.
 */
export function overlaySpread(
  planning: Record<string, unknown>,
  patch: Record<string, unknown> | null,
): Record<string, unknown> {
  const row: Record<string, unknown> = { ...planning };
  if (!patch) return row;
  for (const key of DESIGN_FIRE) {
    if (patch[key] != null) row[key] = patch[key];
  }
  row.label = planning.label;
  row.source_ref = cut(`${text(planning.source_ref)} | ${text(patch.source_ref)}`, 300);
  row.source_note = cut(`${text(patch.source_note)} | ${text(planning.source_note)}`, 400);
  return row;
}

export function sourceRefFromTitles(keys: string[], titles: Map<string, string>): string {
  const names = [
    ...new Set(
      keys.map((key) => titles.get(key)).filter((title): title is string => Boolean(title)),
    ),
  ];
  if (names.length === 0) return cut(keys.join(', ') || 'seed', 300);
  const head = names.slice(0, 2).join('; ');
  const more = names.length > 2 ? ` and ${names.length - 2} more` : '';
  return cut(`${head}${more}`, 300);
}

export function valuesNote(payload: Record<string, unknown>, values: unknown[]): string {
  const notes = payload.review_notes;
  if (Array.isArray(notes) && typeof notes[0] === 'string' && notes[0].trim())
    return cut(notes[0], 400);
  const params = values
    .map((item) =>
      item && typeof item === 'object' ? (item as Record<string, unknown>).param : null,
    )
    .filter((param): param is string => typeof param === 'string');
  return cut(`Values: ${params.join(', ')}`, 400);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Inline sources on a doctrine or an agency register, including each unit.
 * A node that already names a `source_key` is a file source, not a derived one.
 */
export function collectInlineSources(
  payload: unknown,
  provenance: unknown,
): Record<string, unknown>[] {
  const body = asRecord(payload);
  const prov = asRecord(provenance);
  const nodes = [
    ...asList(prov?.sources),
    ...asList(asRecord(body?.provenance)?.sources),
    ...asList(body?.sources),
    ...asList(body?.units).flatMap((unit) => asList(asRecord(unit)?.sources)),
  ];
  return nodes.filter((source): source is Record<string, unknown> => {
    const row = asRecord(source);
    return Boolean(row && !text(row.source_key) && text(row.url));
  });
}

/** Exact URL match against a file-source draft. A substring or a different case does not match. */
export function urlAlreadyDrafted(url: string, drafts: readonly { url?: unknown }[]): boolean {
  return drafts.some((row) => row.url === url);
}
