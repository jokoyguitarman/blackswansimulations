import { fingerprintInject, type GenStamp } from '../../lib/injectFingerprint.js';
import { isValidInjectKey, slugifyInjectTitle, stampGeneratedInjectKeys } from '../../lib/injectKey.js';
import type { BriefDiff } from './affectedLayers.js';
import type { FactSheet } from '../socialCrisisGeneratorService.js';

/** A revised trigger may move at most this far unless the diff severity is `story`. */
export const TRIGGER_CLAMP_MINUTES = 15;

const CENTRE_ROLE =
  /at the cent(?:re|er)|cent(?:re|er) of (?:the |this )?(?:crisis|story)|organisation at the cent(?:re|er)|organization at the cent(?:re|er)|the company in crisis/i;

export interface RevisionFields {
  title: string;
  content: string;
  trigger_time_minutes?: number;
  conditions_to_appear?: unknown;
  conditions_to_cancel?: unknown;
  severity?: string;
  type?: string;
  inject_scope?: string;
  target_teams?: string[];
  delivery_config: Record<string, unknown>;
}

export interface SetupRevision {
  inject_id: string;
  inject_key: string;
  layer: string;
  decision: 'keep' | 'revise' | 'retire';
  reason: string;
  /** Decision O5. Review sets this false to keep the original row. */
  accepted: boolean;
  /** How an accepted revise or retire is written. `keep` is `none`. */
  write: 'none' | 'in_place' | 'cow' | 'retire';
  new?: RevisionFields;
  carried: {
    response_rubric?: unknown;
    mood_ladder?: unknown;
    /** Chains stay addressable by inject_key. WP10 copies chain rows on `cow`. */
    escalation: true;
  };
}

export interface SetupFlag {
  inject_id: string;
  inject_key?: string;
  reason: string;
  provenance: 'hand_edited' | 'unverified';
  suggestion?: { title?: string; content?: string };
}

export interface RevisionSource {
  id: string;
  inject_key: string;
  layer: string;
  title: string;
  content: string;
  trigger_time_minutes: number | null;
  conditions_to_appear?: unknown;
  conditions_to_cancel?: unknown;
  delivery_config: Record<string, unknown>;
  has_history: boolean;
  type?: string;
  severity?: string;
  inject_scope?: string;
  target_teams?: string[];
  app: string;
}

export function mentionsCentreRole(text: string): boolean {
  return CENTRE_ROLE.test(text);
}

/** Whole-word, case-preserving replacement. Longer names are applied first. */
export function substituteText(text: string, renames: readonly { from: string; to: string }[]): string {
  const ordered = [...renames]
    .filter((rename) => rename.from.trim().length > 0 && rename.from !== rename.to)
    .sort((a, b) => b.from.length - a.from.length);
  let out = text;
  for (const rename of ordered) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRegExp(rename.from)}(?![\\p{L}\\p{N}_])`,
      'giu',
    );
    out = out.replace(pattern, (match) => preserveCase(match, rename.to));
  }
  return out;
}

export function substitutePair(
  title: string,
  content: string,
  renames: readonly { from: string; to: string }[],
): { title: string; content: string; changed: boolean } {
  const nextTitle = substituteText(title, renames);
  const nextContent = substituteText(content, renames);
  return {
    title: nextTitle,
    content: nextContent,
    changed: nextTitle !== title || nextContent !== content,
  };
}

export function clampTriggerTime(
  original: number | null | undefined,
  next: number | null | undefined,
  severity: BriefDiff['severity'],
): number | undefined {
  if (next == null || !Number.isFinite(next)) {
    return original == null ? undefined : original;
  }
  if (severity === 'story') return next;
  const base = original == null || !Number.isFinite(original) ? next : original;
  const low = base - TRIGGER_CLAMP_MINUTES;
  const high = base + TRIGGER_CLAMP_MINUTES;
  return Math.min(high, Math.max(low, next));
}

export function conditionsMentionKey(conditions: unknown, injectKey: string): boolean {
  if (!injectKey) return false;
  return flattenStrings(conditions).some((value) => conditionBodyMentions(value, injectKey));
}

/** Drop condition strings that name an inject key outside the active set. */
export function filterConditions(conditions: unknown, activeKeys: ReadonlySet<string>): unknown {
  if (conditions == null) return conditions;
  if (typeof conditions === 'string') {
    return referencedKeys(conditions).every((key) => activeKeys.has(key)) ? conditions : undefined;
  }
  if (Array.isArray(conditions)) {
    return conditions.filter((item) => {
      if (typeof item !== 'string') return true;
      return referencedKeys(item).every((key) => activeKeys.has(key));
    });
  }
  if (typeof conditions === 'object') {
    const record = conditions as Record<string, unknown>;
    const copy: Record<string, unknown> = { ...record };
    if (Array.isArray(record.all)) copy.all = filterConditions(record.all, activeKeys);
    if (Array.isArray(record.conditions)) copy.conditions = filterConditions(record.conditions, activeKeys);
    return copy;
  }
  return conditions;
}

export function carryDeliveryConfig(
  original: Record<string, unknown>,
  next: Record<string, unknown> | undefined,
  injectKey: string,
  app: string,
): Record<string, unknown> {
  const merged = { ...(next ?? {}) };
  merged.inject_key = injectKey;
  merged.app = app;
  if ('response_rubric' in original) merged.response_rubric = original.response_rubric;
  if ('mood_ladder' in original) merged.mood_ladder = original.mood_ladder;
  if ('parent_response_rubric' in original) merged.parent_response_rubric = original.parent_response_rubric;
  return merged;
}

export function stampEditGen(
  row: {
    title?: string | null;
    content?: string | null;
    type?: string | null;
    severity?: string | null;
    trigger_time_minutes?: number | null;
    target_teams?: string[] | null;
    inject_scope?: string | null;
    conditions_to_appear?: unknown;
    conditions_to_cancel?: unknown;
    delivery_config: Record<string, unknown>;
  },
  layer: string,
  edit: number,
): { delivery_config: Record<string, unknown>; gen: GenStamp } {
  const delivery = { ...row.delivery_config };
  delete delivery.gen;
  const hash = fingerprintInject({ ...row, delivery_config: delivery });
  const gen: GenStamp = { layer, edit, hash };
  return { delivery_config: { ...delivery, gen }, gen };
}

export function allocateFreshKeys<T extends { title?: string | null; delivery_config?: object | null }>(
  injects: readonly T[],
  taken: readonly string[],
): Array<Omit<T, 'delivery_config'> & { delivery_config: Record<string, unknown> }> {
  const seeds = taken.filter(isValidInjectKey).map((key) => ({
    title: key,
    delivery_config: { inject_key: key },
  }));
  const stamped = stampGeneratedInjectKeys([...seeds, ...injects]);
  return stamped.slice(seeds.length) as Array<
    Omit<T, 'delivery_config'> & { delivery_config: Record<string, unknown> }
  >;
}

export function slugForTitle(title: string): string {
  return slugifyInjectTitle(title);
}

/**
 * A retire the model asked for becomes a revise when a surviving hand-edited
 * inject's conditions name that key. The original text is kept.
 */
export function downgradeReferencedRetires(
  revisions: SetupRevision[],
  handEdited: readonly { conditions_to_appear?: unknown; conditions_to_cancel?: unknown; retired?: boolean }[],
  sources: ReadonlyMap<string, RevisionSource>,
  edit: number,
): SetupRevision[] {
  const surviving = handEdited.filter((inject) => !inject.retired);
  return revisions.map((revision) => {
    if (revision.decision !== 'retire') return revision;
    const referenced = surviving.some(
      (inject) =>
        conditionsMentionKey(inject.conditions_to_appear, revision.inject_key) ||
        conditionsMentionKey(inject.conditions_to_cancel, revision.inject_key),
    );
    if (!referenced) return revision;
    const source = sources.get(revision.inject_id);
    const reason = `${revision.reason} Kept because a hand-edited inject still references it.`;
    if (!source) {
      return { ...revision, decision: 'revise', write: 'in_place', reason };
    }
    return reviseFromSource(source, reason, {}, edit);
  });
}

export function reviseFromSource(
  source: RevisionSource,
  reason: string,
  patch: Partial<RevisionFields> = {},
  edit = 1,
): SetupRevision {
  const title = patch.title ?? source.title;
  const content = patch.content ?? source.content;
  const time = patch.trigger_time_minutes ?? (source.trigger_time_minutes ?? undefined);
  const delivery = carryDeliveryConfig(source.delivery_config, patch.delivery_config, source.inject_key, source.app);
  const fields: RevisionFields = {
    title,
    content,
    ...(time != null ? { trigger_time_minutes: time } : {}),
    conditions_to_appear: patch.conditions_to_appear ?? source.conditions_to_appear,
    conditions_to_cancel: patch.conditions_to_cancel ?? source.conditions_to_cancel,
    severity: patch.severity ?? source.severity,
    type: patch.type ?? source.type,
    inject_scope: patch.inject_scope ?? source.inject_scope,
    target_teams: patch.target_teams ?? source.target_teams,
    delivery_config: delivery,
  };
    const stamped = stampEditGen(
    {
      title: fields.title,
      content: fields.content,
      type: fields.type,
      severity: fields.severity,
      trigger_time_minutes: fields.trigger_time_minutes,
      target_teams: fields.target_teams,
      inject_scope: fields.inject_scope,
      conditions_to_appear: fields.conditions_to_appear,
      conditions_to_cancel: fields.conditions_to_cancel,
      delivery_config: fields.delivery_config,
    },
    source.layer,
    edit,
  );
  fields.delivery_config = stamped.delivery_config;
  return {
    inject_id: source.id,
    inject_key: source.inject_key,
    layer: source.layer,
    decision: 'revise',
    reason,
    accepted: true,
    write: source.has_history ? 'cow' : 'in_place',
    new: fields,
    carried: carriedOf(source.delivery_config),
  };
}

export function retireRevision(source: RevisionSource, reason: string): SetupRevision {
  return {
    inject_id: source.id,
    inject_key: source.inject_key,
    layer: source.layer,
    decision: 'retire',
    reason,
    accepted: true,
    write: 'retire',
    carried: carriedOf(source.delivery_config),
  };
}

export function keepRevision(source: RevisionSource, reason: string): SetupRevision {
  return {
    inject_id: source.id,
    inject_key: source.inject_key,
    layer: source.layer,
    decision: 'keep',
    reason,
    accepted: true,
    write: 'none',
    carried: carriedOf(source.delivery_config),
  };
}

export interface RevisionApplication {
  active: Record<string, unknown>;
  retired: boolean;
  accepted: boolean;
}

/**
 * O5. An accepted revise or retire is the default. A Review rejection returns
 * the original row, still active, with nothing retired.
 */
export function applyRevisionDecision(
  original: Record<string, unknown>,
  revision: Pick<SetupRevision, 'decision' | 'accepted' | 'write' | 'new'>,
  choice?: 'accept' | 'reject',
): RevisionApplication {
  const accept = choice ? choice === 'accept' : revision.accepted !== false;
  if (!accept || revision.decision === 'keep' || revision.write === 'none') {
    return { active: original, retired: false, accepted: accept && revision.decision === 'keep' };
  }
  if (revision.decision === 'retire' || revision.write === 'retire') {
    return { active: original, retired: true, accepted: true };
  }
  const next: Record<string, unknown> = { ...original, ...(revision.new ?? {}) };
  if (revision.write === 'cow') {
    const successor = { ...next };
    delete successor.id;
    return { active: successor, retired: true, accepted: true };
  }
  return { active: next, retired: false, accepted: true };
}

export function mergeFactSheet(
  current: FactSheet,
  revised: FactSheet,
  diff: BriefDiff,
  trainerEdited: boolean,
): FactSheet {
  if (trainerEdited) {
    return {
      ...current,
      confirmed_facts: uniqueStrings([...current.confirmed_facts, ...revised.confirmed_facts]),
      unconfirmed_claims: appendClaims(current.unconfirmed_claims, revised.unconfirmed_claims),
      crisis_cluster: current.crisis_cluster ?? revised.crisis_cluster,
    };
  }
  const removed = new Set(
    diff.fact_changes
      .filter((change) => change.kind === 'remove' || change.kind === 'change')
      .map((change) => norm(change.old))
      .filter((value) => value.length > 0),
  );
  const kept = current.confirmed_facts.filter((fact) => !removed.has(norm(fact)));
  const additions = diff.fact_changes
    .filter((change) => change.kind === 'add' || change.kind === 'change')
    .map((change) => change.new?.trim() ?? '')
    .filter((fact) => fact.length > 0);
  const fromModel = revised.confirmed_facts.filter((fact) =>
    additions.some((added) => norm(fact) === norm(added) || fact.toLowerCase().includes(added.toLowerCase())),
  );
  return {
    ...current,
    confirmed_facts: uniqueStrings([...kept, ...(fromModel.length > 0 ? fromModel : additions)]),
    crisis_cluster: revised.crisis_cluster ?? current.crisis_cluster,
    unconfirmed_claims: current.unconfirmed_claims,
  };
}

function carriedOf(config: Record<string, unknown>): SetupRevision['carried'] {
  return {
    escalation: true,
    ...(config.response_rubric !== undefined ? { response_rubric: config.response_rubric } : {}),
    ...(config.mood_ladder !== undefined ? { mood_ladder: config.mood_ladder } : {}),
  };
}

function conditionBodyMentions(value: string, injectKey: string): boolean {
  return referencedKeys(value).includes(injectKey);
}

function referencedKeys(value: string): string[] {
  const body = value.split('|')[0] ?? value;
  const parts = body.split(':');
  if (parts.length < 2) return [];
  return parts.slice(1).map((part) => part.trim()).filter((part) => isValidInjectKey(part));
}

function flattenStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => flattenStrings(item));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((item) => flattenStrings(item));
  }
  return [];
}

function preserveCase(match: string, replacement: string): string {
  if (match !== match.toLowerCase() && match === match.toUpperCase()) return replacement.toUpperCase();
  const first = match.charAt(0);
  if (first === first.toUpperCase() && match.slice(1) === match.slice(1).toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  if (match === match.toLowerCase()) return replacement.toLowerCase();
  return replacement;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = norm(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function appendClaims(
  current: FactSheet['unconfirmed_claims'],
  extra: FactSheet['unconfirmed_claims'],
): FactSheet['unconfirmed_claims'] {
  const seen = new Set(current.map((claim) => norm(claim.claim)));
  const out = [...current];
  for (const claim of extra) {
    const key = norm(claim.claim);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(claim);
  }
  return out;
}

function norm(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}
