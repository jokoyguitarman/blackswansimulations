import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { classifyDocument } from './classify.js';
import { REGISTRY } from './registry.js';
import { asArray, asRecord, isUseOfForceDoctrine } from './review.js';
import type { RegistryEntry, ReviewState } from './types.js';

export interface ReviewDecisionInput {
  decision: ReviewState;
  reviewer: string;
  qualification: string;
  date: string;
  notes: string;
}

const R1_FOLDERS = new Set([
  'physics-movement',
  'blast-effects',
  'fire-smoke-tenability',
  'planning',
]);

export function applyBulkReview(
  dir: string,
  input: ReviewDecisionInput,
  folders?: readonly string[],
): string[] {
  const touched: string[] = [];
  for (const entry of REGISTRY) {
    const top = entry.path.startsWith('planning/') ? 'planning' : entry.path.split('/')[1];
    if (folders && folders.length > 0 && top && !folders.includes(top)) continue;
    const absolute = path.join(dir, entry.path);
    let raw: string;
    try {
      raw = readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    const document = JSON.parse(raw) as Record<string, unknown>;
    const changed = applyReviewDocument(document, entry, input, null);
    if (!changed) continue;
    writeJson(absolute, document);
    touched.push(entry.path);
  }
  return touched;
}

export function applyFileReview(
  dir: string,
  relativePath: string,
  recordKey: string,
  input: ReviewDecisionInput,
  release: boolean,
): void {
  const entry = REGISTRY.find((item) => item.path === relativePath);
  if (!entry) throw new Error(`UNKNOWN_SEED_FILE ${relativePath}`);
  const absolute = path.join(dir, relativePath);
  const document = JSON.parse(readFileSync(absolute, 'utf8')) as Record<string, unknown>;
  applyReviewDocument(document, entry, input, recordKey, release);
  writeJson(absolute, document);
}

function applyReviewDocument(
  document: Record<string, unknown>,
  entry: RegistryEntry,
  input: ReviewDecisionInput,
  onlyKey: string | null,
  release = true,
): boolean {
  const records = classifyDocument(entry, document);
  let changed = false;
  const r3 = entry.format === 'doctrine_seed_v1' || entry.format === 'agency_register_v1';
  if (r3) {
    if (
      onlyKey !== null &&
      onlyKey !== records[0]?.recordKey &&
      entry.format === 'doctrine_seed_v1'
    ) {
      // A doctrine file has one decision. The key is the stem.
    }
    changed = writeR3(document, entry, input) || changed;
  } else {
    for (const record of records) {
      if (onlyKey !== null && record.recordKey !== onlyKey) continue;
      if (onlyKey === null && hasStoredDecision(record.review.stored)) continue;
      const node = findNode(document, entry, record.recordKey, record.recordKind);
      if (node && usesRowReview(entry, record.recordKind)) {
        writeR1(node, input);
      } else {
        writeR2(document, record.recordKey, input);
      }
      changed = true;
    }
  }
  if (release) {
    releaseHeader(document, entry);
    changed = true;
  }
  return changed;
}

function hasStoredDecision(stored: Record<string, unknown>): boolean {
  const decision = stored.decision ?? stored.status;
  return (
    decision === 'approved' ||
    decision === 'amended' ||
    decision === 'rejected' ||
    decision === 'approved_for_import'
  );
}

function usesRowReview(entry: RegistryEntry, kind: string): boolean {
  const top = entry.path.startsWith('planning/') ? 'planning' : (entry.path.split('/')[1] ?? '');
  if (!R1_FOLDERS.has(top)) return false;
  if (kind === 'curve_table' || kind === 'run' || kind === 'source') return false;
  return true;
}

function writeR1(node: Record<string, unknown>, input: ReviewDecisionInput): void {
  const review = asRecord(node.review) ?? {};
  review.state = 'reviewed';
  review.decision = input.decision;
  review.reviewer_name = input.reviewer;
  review.reviewer_qualification = input.qualification;
  review.decided_on = input.date;
  review.notes = input.notes;
  node.review = review;
}

function writeR2(
  document: Record<string, unknown>,
  recordKey: string,
  input: ReviewDecisionInput,
): void {
  const review = asRecord(document.review) ?? {};
  review.reviewer_name = input.reviewer;
  review.reviewer_qualification = input.qualification;
  review.reviewed_on = input.date;
  const decisions = asRecord(review.row_decisions) ?? {};
  const existing = asRecord(decisions[recordKey]) ?? {};
  if (existing.decision && existing.decision === input.decision && existing.notes === input.notes) {
    review.row_decisions = decisions;
    document.review = review;
    return;
  }
  existing.decision = input.decision;
  existing.notes = input.notes;
  decisions[recordKey] = existing;
  review.row_decisions = decisions;
  document.review = review;
}

function writeR3(
  document: Record<string, unknown>,
  entry: RegistryEntry,
  input: ReviewDecisionInput,
): boolean {
  const review = asRecord(document.review) ?? {};
  if (
    review.status === 'approved_for_import' &&
    review.reviewer === input.reviewer &&
    review.reviewed_at === input.date &&
    input.decision === 'approved'
  ) {
    return false;
  }
  const status = input.decision === 'approved' ? 'approved_for_import' : input.decision;
  review.status = status;
  review.reviewer = input.reviewer;
  review.reviewed_at = input.date;
  review.reviewer_role = 'country';
  const base =
    'Owner approval and verification of 22 Nov 2026; stands for the free-text required roles';
  const force = isUseOfForceDoctrine(entry.path)
    ? '; use-of-force block withheld pending a legal, police_service or military_service reviewer (AC1.59).'
    : '.';
  const sentence = `${base}${force}`;
  const notes = typeof review.notes === 'string' ? review.notes : '';
  if (!notes.includes(sentence))
    review.notes = notes.length > 0 ? `${notes} ${sentence}` : sentence;
  const history = asArray(review.history);
  history.push({
    date: input.date,
    reviewer: input.reviewer,
    reviewer_role: 'country',
    decision: status,
  });
  review.history = history;
  document.review = review;
  return true;
}

function releaseHeader(document: Record<string, unknown>, entry: RegistryEntry): void {
  if (entry.format === 'doctrine_seed_v1' || entry.format === 'agency_register_v1') return;
  document.review_status = 'reviewed';
  if ('seed_status' in document) document.seed_status = 'REVIEWED';
}

function findNode(
  document: Record<string, unknown>,
  entry: RegistryEntry,
  recordKey: string,
  kind: string,
): Record<string, unknown> | null {
  if (kind === 'curve_table' || kind === 'run') return null;
  if (entry.format === 'worked_examples_v0') {
    for (const name of [
      'threshold_radii_10kg_tnt',
      'ac6_9_cube_root_check',
      'o3_standoff_card_sanity',
    ] as const) {
      if (name === recordKey) return asRecord(document[name]);
    }
    const examples = asRecord(document.examples);
    if (examples && recordKey in examples) return asRecord(examples[recordKey]);
  }
  const arrays = [
    'rows',
    'reference_rows',
    'oracles',
    'cases_10kg_tnt',
    'other_oracles',
    'uncovered',
    'refused',
    'reviews',
  ];
  for (const name of arrays) {
    for (const item of asArray(document[name])) {
      const row = asRecord(item);
      if (!row) continue;
      if (matches(entry, row, recordKey, kind)) return row;
    }
  }
  return null;
}

function matches(
  entry: RegistryEntry,
  row: Record<string, unknown>,
  recordKey: string,
  kind: string,
): boolean {
  if (kind === 'source') return row.source_key === recordKey;
  if (kind === 'reference' || kind === 'gap') return row.ref_key === recordKey;
  if (kind === 'oracle' || kind === 'worked_example')
    return row.case_id === recordKey || row.id === recordKey;
  if (kind === 'doctrine_review')
    return String(row.seed ?? '').replace(/\.json$/, '') === recordKey;
  if (kind === 'uncovered' || kind === 'refused') return false;
  if (entry.path.endsWith('unit-equipment.json'))
    return `${row.kind_key}/${row.equipment_key}` === recordKey;
  if (entry.path.endsWith('building-items.json'))
    return `${row.type_key}/${row.kind_key}/${row.location_kind}` === recordKey;
  const fields = [
    'kind_key',
    'equipment_key',
    'material_key',
    'agent_key',
    'threat_key',
    'param_key',
    'incident_type',
    'type_key',
    'rule_key',
    'threshold_key',
    'key',
  ];
  return fields.some((field) => row[field] === recordKey);
}

export function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
