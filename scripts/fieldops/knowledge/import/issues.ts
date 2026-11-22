import {
  DANGLING_THREAT_KEYS,
  folderOf,
  MISSING_MOVEMENT_KEYS,
  SOURCE_FOLDER_ORDER,
} from './registry.js';
import { asArray, asRecord, isFullDate, isOwnerReview } from './review.js';
import type { ClassifiedRecord, Issue, LoadedFile } from './types.js';

const INJURY_ONSETS = new Set(['lethal_onset', 'serious_injury_onset', 'minor_injury_onset']);
const STRUCTURAL_SCALE_RULES = new Set(['pool_chemical_mix', 'ammonia_plant_rupture']);
const PAIRED_MATERIALS = new Set(['rdx_c4', 'petn_semtex']);
const NO_TARGET_WARNING = 'no_target_param';

const RELEASE_COMPARE_KEYS = [
  'label',
  'cas_number',
  'molecular_weight',
  'density_ratio',
  'boiling_point_c',
  'lfl_pct',
  'ufl_pct',
  'tier_scheme',
  'tiers',
  'toxic_load_n',
  'irritant',
] as const;

export interface SourceFact {
  filePath: string;
  folder: string;
  title: string;
  publisher: string;
  url: string | null;
  accessedOn: string | null;
  accessStatus: string | null;
  blocked: boolean;
}

export function annotateIssues(files: LoadedFile[]): void {
  const sources = indexSources(files);
  const threatKeys = new Set<string>();
  for (const file of files) {
    for (const record of file.records) {
      if (record.targetTable === 'fieldops_threat_profiles' && record.recordKind === 'table_row') {
        threatKeys.add(record.recordKey);
      }
    }
  }
  const agents = new Map<string, ClassifiedRecord[]>();
  for (const file of files) {
    for (const record of file.records) {
      record.issues = issuesForRecord(record, file, sources, threatKeys);
      if (record.targetTable === 'fieldops_release_agents' && record.recordKind === 'table_row') {
        const list = agents.get(record.recordKey) ?? [];
        list.push(record);
        agents.set(record.recordKey, list);
      }
    }
  }
  for (const group of agents.values()) {
    if (group.length < 2) continue;
    const comparable = group.map((record) => canonicalCompare(record));
    const distinct = new Set(comparable);
    if (distinct.size < 2) continue;
    const live = group.filter((record) => record.review.state !== 'rejected');
    if (live.length < 2) continue;
    const liveValues = new Set(live.map((record) => canonicalCompare(record)));
    if (liveValues.size < 2) continue;
    const approved = live.filter(
      (record) => record.review.state === 'approved' || record.review.state === 'amended',
    );
    const severity: Issue['severity'] = approved.length >= 2 ? 'blocker' : 'warning';
    for (const record of live) {
      record.issues.push({
        code: 'conflicting_approved_records',
        severity,
        detail: record.recordKey,
      });
    }
  }
  for (const file of files) {
    if (!file.entry.path.endsWith('movement-parameters.pending.json')) continue;
    const present = new Set(
      file.records
        .filter((record) => record.recordKind === 'table_row')
        .map((record) => record.recordKey),
    );
    const host = file.records.find((record) => record.recordKind === 'table_row');
    if (!host) continue;
    for (const key of MISSING_MOVEMENT_KEYS) {
      if (present.has(key)) continue;
      host.issues.push({ code: 'movement_key_missing', severity: 'warning', detail: key });
    }
  }
  for (const [key, facts] of sources) {
    if (facts.length < 2) continue;
    const titles = new Set(facts.map((fact) => fact.title));
    const urls = new Set(facts.map((fact) => fact.url ?? ''));
    const publishers = new Set(facts.map((fact) => fact.publisher));
    if (titles.size < 2 && urls.size < 2 && publishers.size < 2) continue;
    for (const file of files) {
      for (const record of file.records) {
        if (record.recordKind === 'source' && record.recordKey === key) {
          record.issues.push({ code: 'source_key_variant', severity: 'warning', detail: key });
        }
      }
    }
  }
}

function issuesForRecord(
  record: ClassifiedRecord,
  file: LoadedFile,
  sources: Map<string, SourceFact[]>,
  threatKeys: Set<string>,
): Issue[] {
  const issues: Issue[] = [];
  const payload = asRecord(record.payload) ?? {};
  const rejected = record.review.state === 'rejected';
  const blocker = (code: string, detail?: string) => {
    issues.push({ code, severity: rejected ? 'warning' : 'blocker', detail });
  };
  const warning = (code: string, detail?: string) =>
    issues.push({ code, severity: 'warning', detail });

  if (record.review.state === 'pending' && record.review.stored && incomplete(record)) {
    blocker('incomplete_review');
  }

  if (record.targetTable === 'fieldops_explosive_materials' && record.recordKind === 'table_row') {
    if (payload.tnt_eq_pressure == null) blocker('null_not_null:tnt_eq_pressure');
    if (payload.tnt_eq_impulse == null) blocker('null_not_null:tnt_eq_impulse');
    if (PAIRED_MATERIALS.has(record.recordKey)) warning('paired_material_label');
  }

  if (record.targetTable === 'fieldops_injury_thresholds' && INJURY_ONSETS.has(record.recordKey)) {
    if (payload.metric !== 'effective_overpressure_kpa') blocker('sql_check:metric');
  }

  if (
    STRUCTURAL_SCALE_RULES.has(record.recordKey) &&
    payload.threshold === 2 &&
    payload.trigger === 'structural_state'
  ) {
    blocker('threshold_scale_mismatch');
  }

  if (record.recordKind === 'source') {
    const fact = factFromRecord(record);
    if (fact.blocked) {
      const ownerApproved = isOwnerReview(record.review);
      issues.push({
        code: 'source_not_accessed',
        severity: ownerApproved || rejected ? 'warning' : 'blocker',
        detail: record.recordKey,
      });
    }
    if (record.filePath.endsWith('sources.sg.json')) warning('source_shape_variant');
    if (payload.access_status === 'not_reread' || payload.read_status === 'cited_not_read')
      warning('source_not_fully_read');
    const published = payload.published_on ?? payload.published;
    if (typeof published === 'string' && !isFullDate(published))
      warning('published_partial', published);
    if (typeof payload.url === 'string' && payload.url.startsWith('http://'))
      warning('url_not_https');
  }

  if (
    record.recordKind === 'table_row' ||
    record.recordKind === 'reference' ||
    record.recordKind === 'curve_table'
  ) {
    const located = sourceProblems(record, sources);
    for (const problem of located) {
      if (problem.code === 'no_located_source' && isOwnerReview(record.review)) {
        warning('unlocated_source_promoted', problem.detail);
        if (!record.assumedFields.includes('source not accessed'))
          record.assumedFields.push('source not accessed');
      } else if (
        problem.code === 'locator_too_long' &&
        (record.recordKind === 'reference' || record.recordKind === 'curve_table')
      ) {
        warning('locator_too_long', problem.detail);
      } else if (problem.severity === 'blocker') blocker(problem.code, problem.detail);
      else warning(problem.code, problem.detail);
    }
  }

  if (
    record.provenance &&
    record.provenance.run_id == null &&
    (record.filePath.includes('physics-movement/') || record.filePath.includes('responder-units/'))
  ) {
    if (record.recordKind !== 'run' && record.recordKind !== 'source') warning('run_id_derived');
  }
  if (
    record.recordKind === 'run' &&
    record.payload &&
    asRecord(record.payload)?.brief_hash == null
  ) {
    warning('brief_hash_derived');
  }
  if (record.filePath.includes('responder-units/') && record.ordinal === 0)
    warning('brief_hash_derived');

  if (record.targetTable === 'fieldops_response_standards') {
    const params = valueParams(payload);
    if (
      !params.has('respond_within_s') &&
      !params.has('answer_within_s') &&
      !params.has('target_share_pct')
    ) {
      warning(NO_TARGET_WARNING);
    }
    if (
      record.recordKey === 'sg_airport_rffs_response' &&
      payload.scope === 'airport' &&
      !payload.site_bound &&
      asArray(payload.incident_types).length === 0
    ) {
      warning('site_bound_expected');
    }
  }

  if (
    record.targetTable === 'fieldops_hospitals' ||
    record.targetTable === 'fieldops_capacity_aggregates'
  ) {
    if (payload.source_ref == null || payload.source_note == null) warning('derived_source_text');
  }
  if (record.targetTable === 'fieldops_hospitals') {
    if (payload.osm_id == null) warning('osm_id_missing');
    if (!bedsYear(payload)) warning('beds_unknown');
  }

  if (record.targetTable === 'fieldops_threat_profiles') warning('threat_params_unchecked');

  const citedThreats = citedThreatKeys(record, payload);
  for (const key of citedThreats) {
    if (
      !threatKeys.has(key) ||
      DANGLING_THREAT_KEYS.includes(key as (typeof DANGLING_THREAT_KEYS)[number])
    ) {
      if (!threatKeys.has(key)) warning('dangling_reference', key);
    }
  }

  if (record.recordKind === 'register_agency' && payload.verify === 'to verify')
    warning('register_entry_to_verify');

  if (record.recordKind === 'doctrine_seed') {
    const content = asRecord(payload.content);
    if (content && 'use_of_force' in content) warning('use_of_force_withheld');
    warning('save_screen_unavailable');
  }

  if (
    record.ordinal === 0 &&
    record.review.state === 'pending' &&
    !fileHasReview(file, record) &&
    record.filePath.includes('responder-units/') &&
    file.entry.format !== 'sources_v0' &&
    file.entry.format !== 'run_manifest_v0'
  ) {
    // D17 is informational (section 12 severity "—"): one note per data file, not a promotion blocker.
    warning('no_review_block');
  }

  return issues;
}

function incomplete(record: ClassifiedRecord): boolean {
  const stored = record.review.stored;
  const decision = stored.decision ?? stored.status;
  if (decision == null || decision === 'pending') return false;
  return record.review.state === 'pending';
}

function fileHasReview(file: LoadedFile, record: ClassifiedRecord): boolean {
  return Boolean(record.review.stored && Object.keys(record.review.stored).length > 0);
}

function sourceProblems(record: ClassifiedRecord, sources: Map<string, SourceFact[]>): Issue[] {
  const provenance = record.provenance;
  const cited = asArray(provenance?.sources)
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null);
  const keys = record.sourceKeys;
  if (cited.length === 0 && keys.length === 0) return [];
  const issues: Issue[] = [];
  let blocked = 0;
  let ok = 0;
  let longLocator = false;
  const seen = new Set<string>();
  const consider = (key: string | null, locator: unknown) => {
    if (key) seen.add(key);
    const facts = key ? sources.get(key) : undefined;
    const sourceBlocked = !facts || facts.every((fact) => fact.blocked);
    const literal = locator === 'not accessed';
    const missingLocator = cited.length > 0 && (locator == null || locator === '' || literal);
    const tooLong = typeof locator === 'string' && locator.length > 120;
    if (tooLong) longLocator = true;
    if (sourceBlocked || literal) blocked += 1;
    else if (tooLong && record.recordKind === 'table_row') blocked += 1;
    else ok += 1;
    if (record.recordKind === 'table_row' && missingLocator && !sourceBlocked) {
      issues.push({ code: literal ? 'no_located_source' : 'locator_missing', severity: 'blocker' });
    }
    if (key && !facts)
      issues.push({ code: 'unknown_source_key', severity: 'blocker', detail: key });
  };
  if (cited.length > 0) {
    for (const source of cited)
      consider(typeof source.source_key === 'string' ? source.source_key : null, source.locator);
  } else {
    for (const key of keys) consider(key, null);
  }
  if (longLocator) issues.push({ code: 'locator_too_long', severity: 'warning' });
  if (ok === 0 && (blocked > 0 || keys.length > 0)) {
    issues.push({ code: 'no_located_source', severity: 'blocker' });
  } else if (blocked > 0 && ok > 0) {
    issues.push({ code: 'some_sources_unlocated', severity: 'warning' });
  }
  return issues;
}

function indexSources(files: LoadedFile[]): Map<string, SourceFact[]> {
  const map = new Map<string, SourceFact[]>();
  const ordered = [...files].sort(
    (a, b) => folderRank(folderOf(a.entry.path)) - folderRank(folderOf(b.entry.path)),
  );
  for (const file of ordered) {
    for (const record of file.records) {
      if (record.recordKind !== 'source') continue;
      const fact = factFromRecord(record);
      const list = map.get(record.recordKey) ?? [];
      list.push(fact);
      map.set(record.recordKey, list);
    }
  }
  return map;
}

function factFromRecord(record: ClassifiedRecord): SourceFact {
  const payload = asRecord(record.payload) ?? {};
  const accessedRaw = payload.accessed_on ?? payload.accessed ?? null;
  const accessedOn =
    typeof accessedRaw === 'string' && isFullDate(accessedRaw) ? accessedRaw : null;
  const accessStatus = typeof payload.access_status === 'string' ? payload.access_status : null;
  const blocked = accessStatus === 'not_accessed_unverified' || accessedOn == null;
  return {
    filePath: record.filePath,
    folder: folderOf(record.filePath),
    title: typeof payload.title === 'string' ? payload.title : '',
    publisher: typeof payload.publisher === 'string' ? payload.publisher : '',
    url: typeof payload.url === 'string' ? payload.url : null,
    accessedOn,
    accessStatus,
    blocked,
  };
}

function folderRank(folder: string): number {
  const index = SOURCE_FOLDER_ORDER.indexOf(folder as (typeof SOURCE_FOLDER_ORDER)[number]);
  return index < 0 ? SOURCE_FOLDER_ORDER.length : index;
}

function canonicalCompare(record: ClassifiedRecord): string {
  const payload = asRecord(record.payload) ?? {};
  const picked: Record<string, unknown> = {};
  for (const key of RELEASE_COMPARE_KEYS) picked[key] = payload[key] ?? null;
  return JSON.stringify(picked);
}

function valueParams(payload: Record<string, unknown>): Set<string> {
  const params = new Set<string>();
  for (const value of asArray(payload.values)) {
    const row = asRecord(value);
    if (row && typeof row.param === 'string') params.add(row.param);
  }
  return params;
}

function bedsYear(payload: Record<string, unknown>): boolean {
  return asArray(payload.values).some((value) => {
    const row = asRecord(value);
    return Boolean(
      row &&
      typeof row.param === 'string' &&
      /^beds_\d{4}$/.test(row.param) &&
      typeof row.value === 'number',
    );
  });
}

function citedThreatKeys(record: ClassifiedRecord, payload: Record<string, unknown>): string[] {
  const keys: string[] = [];
  if (Array.isArray(payload.threat_keys)) {
    for (const key of payload.threat_keys) if (typeof key === 'string') keys.push(key);
  }
  if (typeof payload.threat_key === 'string' && payload.threat_key) keys.push(payload.threat_key);
  if (
    record.targetTable !== 'fieldops_hazard_item_kinds' &&
    record.targetTable !== 'fieldops_hazard_interactions' &&
    record.targetTable !== 'fieldops_incident_types'
  ) {
    return [];
  }
  return keys;
}

export function blockerCount(issues: Issue[]): number {
  return issues.filter((issue) => issue.severity === 'blocker').length;
}

export function warningCount(issues: Issue[]): number {
  return issues.filter((issue) => issue.severity === 'warning').length;
}

export function issueSummary(files: LoadedFile[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of files) {
    for (const record of file.records) {
      for (const issue of record.issues) counts[issue.code] = (counts[issue.code] ?? 0) + 1;
    }
  }
  return counts;
}
