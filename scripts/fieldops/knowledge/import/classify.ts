import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256Buffer, sha256Hex } from './canonical.js';
import { derivedPhysicsRunId } from './ids.js';
import { folderOf, REGISTRY } from './registry.js';
import { asArray, asRecord, normaliseReview } from './review.js';
import { SCHEMA_BY_FORMAT } from './schemas/asFound.js';
import type {
  ClassifiedRecord,
  Library,
  LoadedFile,
  RecordKind,
  RegistryEntry,
  TargetTable,
} from './types.js';

export interface LoadResult {
  files: LoadedFile[];
  errors: string[];
}

export function loadSeeds(
  dir: string,
  options: { allowUnknown?: boolean; folders?: readonly string[] } = {},
): LoadResult {
  const errors: string[] = [];
  const present = listJsonFiles(dir);
  const known = new Set(REGISTRY.map((entry) => entry.path));
  for (const relative of present) {
    if (known.has(relative)) continue;
    const message = `UNKNOWN_SEED_FILE ${relative}`;
    if (options.allowUnknown) errors.push(`skipped ${message}`);
    else errors.push(message);
  }
  const files: LoadedFile[] = [];
  for (const entry of REGISTRY) {
    if (
      options.folders &&
      options.folders.length > 0 &&
      !options.folders.includes(folderOf(entry.path))
    ) {
      continue;
    }
    const absolutePath = path.join(dir, entry.path);
    if (!present.includes(entry.path)) continue;
    let bytes: Buffer;
    try {
      bytes = readFileSync(absolutePath);
    } catch (error) {
      errors.push(`${entry.path}: ${error instanceof Error ? error.message : 'unreadable'}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch (error) {
      errors.push(`${entry.path}: ${error instanceof Error ? error.message : 'invalid JSON'}`);
      continue;
    }
    const schema = SCHEMA_BY_FORMAT[entry.format];
    const result = schema.safeParse(parsed);
    if (!result.success) {
      const detail = result.error.issues
        .slice(0, 4)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      errors.push(`${entry.path}: schema ${entry.format} (${detail})`);
      continue;
    }
    const document = result.data as Record<string, unknown>;
    files.push({
      entry,
      absolutePath,
      bytes,
      sha256: sha256Buffer(bytes),
      document,
      records: classifyDocument(entry, document),
    });
  }
  return {
    files,
    errors: options.allowUnknown ? errors.filter((e) => !e.startsWith('skipped')) : errors,
  };
}

export function classifyDocument(
  entry: RegistryEntry,
  document: Record<string, unknown>,
): ClassifiedRecord[] {
  const records: ClassifiedRecord[] = [];
  let ordinal = 0;
  const push = (
    record: Omit<ClassifiedRecord, 'ordinal' | 'filePath' | 'library' | 'issues'> & {
      library?: Library;
    },
  ) => {
    records.push({
      ...record,
      filePath: entry.path,
      library: record.library ?? entry.library,
      ordinal: ordinal++,
      issues: [],
    });
  };
  const seenSubjects = new Map<string, number>();

  if (entry.format === 'doctrine_seed_v1') {
    const stem = fileStem(entry.path);
    push(
      build(entry, document, document, 'doctrine_seed', stem, 'doctrines', stem, {
        keepProvenance: true,
      }),
    );
    return records;
  }
  if (entry.format === 'agency_register_v1') {
    for (const agency of asArray(document.agencies)) {
      const row = asRecord(agency);
      if (!row) continue;
      const key = String(row.key ?? '');
      push(build(entry, document, row, 'register_agency', key, 'team_archetype_aliases', key));
      for (const unit of asArray(row.units)) {
        const unitRow = asRecord(unit);
        if (!unitRow) continue;
        const unitKey = `${key}/${String(unitRow.key ?? '')}`;
        push(build(entry, document, unitRow, 'register_unit', unitKey, null, null));
      }
    }
    return records;
  }
  if (entry.format === 'doctrine_review_v0') {
    for (const review of asArray(document.reviews)) {
      const row = asRecord(review);
      if (!row) continue;
      const seed = String(row.seed ?? '').replace(/\.json$/, '');
      push(build(entry, document, row, 'doctrine_review', seed, null, null));
    }
    return records;
  }
  if (entry.format === 'run_manifest_v0') {
    const runId =
      typeof document.run_id === 'string' && document.run_id.length > 0
        ? document.run_id
        : derivedPhysicsRunId();
    push(build(entry, document, document, 'run', runId, null, null, { keepProvenance: true }));
    pushNotes(push, entry, document, seenSubjects);
    return records;
  }
  if (entry.format === 'blast_curves_v0') {
    pushRows(push, entry, document, 'reference');
    for (const geometry of Object.keys(asRecord(document.curves_spec_shape) ?? {}).sort()) {
      const node = asRecord(asRecord(document.curves_spec_shape)?.[geometry]);
      if (!node) continue;
      const recordKey = `curves_spec_shape.${geometry}`;
      push(
        build(
          entry,
          document,
          node,
          'curve_table',
          recordKey,
          'fieldops_knowledge_reference_values',
          `kb_curves_spec_shape_${geometry}`,
          {
            provenanceOverride: asRecord(document.curves_spec_shape_provenance),
          },
        ),
      );
    }
    for (const geometry of Object.keys(asRecord(document.lookup_tables) ?? {}).sort()) {
      const node = asRecord(asRecord(document.lookup_tables)?.[geometry]);
      if (!node) continue;
      const recordKey = `lookup_tables.${geometry}`;
      push(
        build(
          entry,
          document,
          node,
          'curve_table',
          recordKey,
          'fieldops_knowledge_reference_values',
          `kb_lookup_table_${geometry}`,
        ),
      );
    }
    for (const oracle of asArray(document.oracles)) {
      const row = asRecord(oracle);
      if (!row) continue;
      push(build(entry, document, row, 'oracle', String(row.id ?? ''), null, null));
    }
    pushNotes(push, entry, document, seenSubjects);
    return records;
  }
  if (entry.format === 'worked_examples_v0') {
    for (const item of asArray(document.cases_10kg_tnt)) {
      const row = asRecord(item);
      if (!row) continue;
      push(build(entry, document, row, 'worked_example', String(row.case_id ?? ''), null, null));
    }
    for (const name of [
      'threshold_radii_10kg_tnt',
      'ac6_9_cube_root_check',
      'o3_standoff_card_sanity',
    ] as const) {
      const row = asRecord(document[name]);
      if (!row) continue;
      push(build(entry, document, row, 'worked_example', name, null, null));
    }
    for (const item of asArray(document.other_oracles)) {
      const row = asRecord(item);
      if (!row) continue;
      push(build(entry, document, row, 'worked_example', String(row.case_id ?? ''), null, null));
    }
    const examples = asRecord(document.examples);
    if (examples) {
      for (const key of Object.keys(examples)) {
        const row = asRecord(examples[key]);
        if (!row) continue;
        push(build(entry, document, row, 'worked_example', key, null, null));
      }
    }
    pushNotes(push, entry, document, seenSubjects);
    return records;
  }

  const primaryKind: RecordKind =
    entry.format === 'sources_v0'
      ? 'source'
      : entry.path.endsWith('equipment-not-representable.json')
        ? 'not_representable'
        : entry.path.endsWith('security-units.sg.json')
          ? 'register_unit'
          : 'table_row';
  if (
    entry.format === 'table_rows_v0' ||
    entry.format === 'planning_rows_v0' ||
    entry.format === 'responder_rows_v0'
  ) {
    for (const item of asArray(document.rows)) {
      const row = asRecord(item);
      if (!row) continue;
      const key = primaryKey(entry, row);
      const target = targetFor(entry, row, key);
      push(build(entry, document, row, primaryKind, key, target.table, target.key));
    }
    for (const item of asArray(document.reference_rows)) {
      const row = asRecord(item);
      if (!row) continue;
      push(referenceRecord(entry, document, row));
    }
  } else if (entry.format === 'reference_rows_v0') {
    for (const item of asArray(document.rows)) {
      const row = asRecord(item);
      if (!row) continue;
      push(referenceRecord(entry, document, row));
    }
  } else if (entry.format === 'sources_v0') {
    for (const item of asArray(document.rows)) {
      const row = asRecord(item);
      if (!row) continue;
      const key = String(row.source_key ?? '');
      push(build(entry, document, row, 'source', key, 'fieldops_knowledge_sources', key));
    }
  }
  pushNotes(push, entry, document, seenSubjects);
  return records;
}

function referenceRecord(
  entry: RegistryEntry,
  document: Record<string, unknown>,
  row: Record<string, unknown>,
): Omit<ClassifiedRecord, 'ordinal' | 'filePath' | 'library' | 'issues'> {
  const key = String(row.ref_key ?? '');
  const gap = row.value === null;
  return build(
    entry,
    document,
    row,
    gap ? 'gap' : 'reference',
    key,
    gap ? null : 'fieldops_knowledge_reference_values',
    gap ? null : key,
  );
}

function pushRows(
  push: (record: Omit<ClassifiedRecord, 'ordinal' | 'filePath' | 'library' | 'issues'>) => void,
  entry: RegistryEntry,
  document: Record<string, unknown>,
  kind: 'reference',
): void {
  for (const item of asArray(document.rows)) {
    const row = asRecord(item);
    if (!row) continue;
    push(referenceRecord(entry, document, row));
    void kind;
  }
}

function pushNotes(
  push: (record: Omit<ClassifiedRecord, 'ordinal' | 'filePath' | 'library' | 'issues'>) => void,
  entry: RegistryEntry,
  document: Record<string, unknown>,
  seen: Map<string, number>,
): void {
  for (const item of asArray(document.uncovered)) {
    const row = asRecord(item);
    if (!row) continue;
    const subject = String(row.subject ?? '');
    push(build(entry, document, row, 'uncovered', subjectKey('u', subject, seen), null, null));
  }
  for (const item of asArray(document.refused)) {
    const row = asRecord(item);
    if (!row) continue;
    const subject = String(row.subject ?? '');
    push(build(entry, document, row, 'refused', subjectKey('r', subject, seen), null, null));
  }
}

function subjectKey(prefix: 'u' | 'r', subject: string, seen: Map<string, number>): string {
  const base = `${prefix}_${sha256Hex(subject).slice(0, 12)}`;
  const next = (seen.get(base) ?? 0) + 1;
  seen.set(base, next);
  return next === 1 ? base : `${base}_${next}`;
}

interface BuildOptions {
  keepProvenance?: boolean;
  provenanceOverride?: Record<string, unknown> | null;
}

function build(
  entry: RegistryEntry,
  document: Record<string, unknown>,
  node: Record<string, unknown>,
  kind: RecordKind,
  recordKey: string,
  targetTable: TargetTable | null,
  targetKey: string | null,
  options: BuildOptions = {},
): Omit<ClassifiedRecord, 'ordinal' | 'filePath' | 'library' | 'issues'> {
  const provenance =
    options.provenanceOverride !== undefined
      ? options.provenanceOverride
      : asRecord(node.provenance);
  const review = normaliseReview(document, entry, recordKey, node);
  const payload = { ...node };
  delete payload.review;
  delete payload._review;
  delete payload.review_notes;
  if (!options.keepProvenance) delete payload.provenance;
  const evidence = reviewEvidence(document, node, recordKey);
  const flags = flagFields(document, recordKey);
  return {
    recordKind: kind,
    recordKey,
    country: countryOf(node, document),
    targetTable,
    targetKey,
    payload,
    payloadSha256: sha256Hex(canonicalJson(payload)),
    provenance,
    reviewEvidence: evidence,
    draftedBy:
      provenance?.drafted_by === 'agent' || provenance?.drafted_by === 'person'
        ? provenance.drafted_by
        : null,
    confidence: confidenceOf(provenance?.confidence),
    assumedFields: uniqueStrings([...stringArray(provenance?.assumed_fields), ...flags.assumed]),
    toVerify: stringArray(provenance?.to_verify),
    unverifiedFields: uniqueStrings([
      ...stringArray(provenance?.unverified_fields),
      ...flags.unverified,
    ]),
    withheldFields: stringArray(provenance?.withheld_fields),
    sourceKeys: sourceKeysOf(node, provenance),
    review,
  };
}

function reviewEvidence(
  document: Record<string, unknown>,
  node: Record<string, unknown>,
  recordKey: string,
): Record<string, unknown> | null {
  const flags = asRecord(document.review_flags);
  const evidence: Record<string, unknown> = {};
  if ('_review' in node) evidence._review = node._review;
  if (flags && recordKey in flags) evidence.review_flags = flags[recordKey];
  if ('review_notes' in node) evidence.review_notes = node.review_notes;
  return Object.keys(evidence).length > 0 ? evidence : null;
}

function flagFields(
  document: Record<string, unknown>,
  recordKey: string,
): { assumed: string[]; unverified: string[] } {
  const flags = document.review_flags;
  const list =
    flags && typeof flags === 'object' && !Array.isArray(flags)
      ? (flags as Record<string, unknown>)[recordKey]
      : undefined;
  const assumed: string[] = [];
  const unverified: string[] = [];
  if (!Array.isArray(list)) return { assumed, unverified };
  for (const item of list) {
    if (typeof item !== 'string') continue;
    if (item.startsWith('Assumed: '))
      assumed.push(...item.slice('Assumed: '.length).split(', ').filter(Boolean));
    if (item.startsWith('Unverified: ')) unverified.push(item.slice('Unverified: '.length));
  }
  return { assumed, unverified };
}

function sourceKeysOf(
  node: Record<string, unknown>,
  provenance: Record<string, unknown> | null,
): string[] {
  const keys = new Set<string>();
  for (const key of stringArray(node.source_keys)) keys.add(key);
  for (const source of asArray(provenance?.sources)) {
    const row = asRecord(source);
    const key = row && typeof row.source_key === 'string' ? row.source_key : '';
    if (key) keys.add(key);
  }
  for (const value of asArray(node.values)) {
    const row = asRecord(value);
    const key = row && typeof row.source_key === 'string' ? row.source_key : '';
    if (key) keys.add(key);
  }
  for (const specialty of asArray(node.specialties)) {
    const row = asRecord(specialty);
    const key = row && typeof row.source_key === 'string' ? row.source_key : '';
    if (key) keys.add(key);
  }
  return [...keys].filter(Boolean).sort();
}

function primaryKey(entry: RegistryEntry, row: Record<string, unknown>): string {
  if (entry.path.endsWith('unit-equipment.json')) return `${row.kind_key}/${row.equipment_key}`;
  if (entry.path.endsWith('building-items.json'))
    return `${row.type_key}/${row.kind_key}/${row.location_kind}`;
  const field = keyField(entry);
  return String(row[field] ?? '');
}

function keyField(entry: RegistryEntry): string {
  if (entry.targetTable === 'fieldops_unit_kinds') return 'kind_key';
  if (entry.targetTable === 'fieldops_equipment') return 'equipment_key';
  if (entry.targetTable === 'fieldops_spread_materials') return 'material_key';
  if (entry.targetTable === 'fieldops_release_agents') return 'agent_key';
  if (entry.targetTable === 'fieldops_threat_profiles') return 'threat_key';
  if (entry.targetTable === 'fieldops_movement_parameters') return 'param_key';
  if (entry.targetTable === 'fieldops_incident_types') return 'incident_type';
  if (entry.targetTable === 'fieldops_building_types') return 'type_key';
  if (entry.targetTable === 'fieldops_hazard_item_kinds') return 'kind_key';
  if (entry.targetTable === 'fieldops_hazard_interactions') return 'rule_key';
  if (entry.targetTable === 'fieldops_explosive_materials') return 'material_key';
  if (entry.targetTable === 'fieldops_injury_thresholds') return 'threshold_key';
  if (
    entry.targetTable === 'fieldops_response_standards' ||
    entry.targetTable === 'fieldops_hospitals'
  )
    return 'key';
  if (
    entry.path.endsWith('equipment-not-representable.json') ||
    entry.path.endsWith('security-units.sg.json')
  )
    return 'key';
  return 'key';
}

function targetFor(
  entry: RegistryEntry,
  row: Record<string, unknown>,
  key: string,
): { table: TargetTable | null; key: string | null } {
  if (!entry.targetTable) return { table: null, key: null };
  if (entry.targetTable === 'fieldops_hospitals') {
    return row.scope === 'hospital'
      ? { table: 'fieldops_hospitals', key }
      : { table: 'fieldops_capacity_aggregates', key };
  }
  return { table: entry.targetTable, key };
}

function countryOf(
  node: Record<string, unknown>,
  document: Record<string, unknown>,
): string | null {
  const fromRow = node.country;
  if (typeof fromRow === 'string' && /^[A-Z]{2}$/.test(fromRow)) return fromRow;
  if (fromRow === null) return null;
  const fromFile = document.country;
  if (typeof fromFile === 'string' && /^[A-Z]{2}$/.test(fromFile)) return fromFile;
  return null;
}

function confidenceOf(value: unknown): 'high' | 'medium' | 'low' | null {
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  return null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function fileStem(relativePath: string): string {
  const base = relativePath.split('/').pop() ?? relativePath;
  return base.endsWith('.json') ? base.slice(0, -5) : base;
}

function listJsonFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string, prefix: string) => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === 'manifest.json' || name === 'manifest.received.json') continue;
      const absolute = path.join(current, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const info = statSync(absolute);
      if (info.isDirectory()) walk(absolute, relative);
      else if (name.endsWith('.json')) found.push(relative);
    }
  };
  walk(dir, '');
  return found.sort();
}

export function countByKind(records: ClassifiedRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) counts[record.recordKind] = (counts[record.recordKind] ?? 0) + 1;
  return counts;
}
