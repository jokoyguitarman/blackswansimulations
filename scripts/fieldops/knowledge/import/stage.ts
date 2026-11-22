import { readFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256Buffer, sha256Hex } from './canonical.js';
import { loadSeeds, type LoadResult } from './classify.js';
import { beginImport, withClient } from './db.js';
import { annotateIssues, issueSummary } from './issues.js';
import { derivedPhysicsRunId, derivedResponderRunId, seedRunId } from './ids.js';
import { buildManifest, manifestDifferences, readManifest } from './manifest.js';
import { DANGLING_THREAT_KEYS, folderOf, MISSING_MOVEMENT_KEYS, REGISTRY } from './registry.js';
import { fileReleased } from './review.js';
import { finishRun, startRun } from './runLog.js';
import { SafetyError, type DbTarget } from './safety.js';
import { seedRunFigures, type SeedRunFigures } from './seedRunCounts.js';
import type { ClassifiedRecord, LoadedFile } from './types.js';
import type pg from 'pg';

const UNACCESSED_SOURCES = [
  'nfpa-855',
  'ul-9540a',
  'nfpa-13',
  'nfpa-30b',
  'ccps-2010-vce-bleve',
  'sfpe-handbook-2016',
  'tno-yellow-book-cpr14e',
  'bre-bd2552-2010',
  'cpfprts',
];

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StageOptions {
  dir: string;
  folders: string[];
  apply: boolean;
  allowManifestDrift: boolean;
  target: DbTarget;
}

export interface StageCounts {
  files: number;
  records: number;
  inserted: number;
  changed: number;
  unchanged: number;
  missing: number;
  blockers: number;
  warnings: number;
}

export async function stage(
  options: StageOptions,
): Promise<{ counts: StageCounts; issues: Record<string, number>; runId: string }> {
  if (!options.allowManifestDrift) assertManifest(options.dir);
  const loaded = loadSeeds(options.dir, { folders: options.folders });
  if (loaded.errors.length > 0) throw new Error(loaded.errors.join('\n'));
  annotateIssues(loaded.files);
  const issues = issueSummary(loaded.files);
  const libraries = [...new Set(loaded.files.map((file) => file.entry.library))].sort();
  const folders = stagedFolders(loaded, options.folders);
  const runId = await startRun(options.target, {
    command: 'stage',
    mode: options.apply ? 'apply' : 'dry_run',
    target: options.target.target,
    seedsDir: options.dir,
    folders,
    libraries,
    manifestSha256: manifestSha256(options.dir),
    args: { apply: options.apply, allowManifestDrift: options.allowManifestDrift },
  });
  try {
    const counts = await withClient(options.target, async (client) => {
      try {
        await beginImport(client, runId);
        const result = await writeStage(client, loaded, runId, folders);
        if (options.apply) await client.query('COMMIT');
        else await client.query('ROLLBACK');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
    await finishRun(
      options.target,
      runId,
      options.apply ? 'succeeded' : 'rolled_back',
      { ...counts },
      issues,
    );
    console.log(
      `stage ${options.apply ? 'apply' : 'dry-run'}: files ${counts.files}, records ${counts.records}, inserted ${counts.inserted}, changed ${counts.changed}, unchanged ${counts.unchanged}, missing ${counts.missing}, blockers ${counts.blockers}, warnings ${counts.warnings}`,
    );
    return { counts, issues, runId };
  } catch (error) {
    await finishRun(
      options.target,
      runId,
      'failed',
      {},
      issues,
      error instanceof Error ? error.message : 'stage failed',
    );
    throw error;
  }
}

function assertManifest(dir: string): void {
  let expected;
  try {
    expected = readManifest(dir);
  } catch (error) {
    throw new SafetyError(error instanceof Error ? error.message : 'manifest unreadable');
  }
  const actual = buildManifest(dir, expected.generated_on);
  const diffs = manifestDifferences(expected, actual);
  if (diffs.length > 0) throw new SafetyError(`manifest drift: ${diffs.slice(0, 8).join('; ')}`);
}

function stagedFolders(loaded: LoadResult, requested: string[]): string[] {
  if (requested.length > 0) return [...requested];
  if (loaded.files.length === 0) return [];
  return [...new Set(REGISTRY.map((entry) => folderOf(entry.path)))];
}

async function writeStage(
  client: pg.Client,
  loaded: LoadResult,
  runId: string,
  folders: string[],
): Promise<StageCounts> {
  const counts: StageCounts = {
    files: loaded.files.length,
    records: loaded.files.reduce((sum, file) => sum + file.records.length, 0),
    inserted: 0,
    changed: 0,
    unchanged: 0,
    missing: 0,
    blockers: 0,
    warnings: 0,
  };
  for (const file of loaded.files) {
    for (const record of file.records) {
      counts.blockers += record.issues.filter((issue) => issue.severity === 'blocker').length;
      counts.warnings += record.issues.filter((issue) => issue.severity === 'warning').length;
    }
    await upsertFile(client, file, runId);
  }
  const runs = seedRuns(loaded.files);
  for (const run of runs) await upsertSeedRun(client, run);
  const researchByFolder = new Map(runs.map((run) => [run.folder, run.researchRunId]));
  const seen = new Map<string, Set<string>>();
  for (const file of loaded.files) {
    const keys = new Set<string>();
    for (const record of file.records) {
      keys.add(`${record.recordKind}\t${record.recordKey}`);
      const outcome = await upsertRecord(client, file, record, runId, runs, researchByFolder);
      counts[outcome] += 1;
    }
    seen.set(file.entry.path, keys);
  }
  counts.missing += await markMissingRecords(client, loaded.files, seen);
  counts.missing += await markMissingFiles(client, loaded.files, folders);
  await writeCoverage(client, loaded.files, runs);
  return counts;
}

async function upsertFile(client: pg.Client, file: LoadedFile, runId: string): Promise<void> {
  await client.query(
    `INSERT INTO public.fieldops_seed_files
      (file_path, folder, library, format, sha256, byte_size, header, header_review_status, released, file_review,
       record_count, first_import_run_id, last_import_run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11, $12, $12)
     ON CONFLICT (file_path) DO UPDATE SET
       folder = EXCLUDED.folder, library = EXCLUDED.library, format = EXCLUDED.format, sha256 = EXCLUDED.sha256,
       byte_size = EXCLUDED.byte_size, header = EXCLUDED.header, header_review_status = EXCLUDED.header_review_status,
       released = EXCLUDED.released, file_review = EXCLUDED.file_review, record_count = EXCLUDED.record_count,
       last_import_run_id = EXCLUDED.last_import_run_id, last_seen_at = now(), missing_since = NULL`,
    [
      file.entry.path,
      folderOf(file.entry.path),
      file.entry.library,
      file.entry.format,
      file.sha256,
      file.bytes.length,
      JSON.stringify(headerOf(file.document)),
      typeof file.document.review_status === 'string'
        ? file.document.review_status.slice(0, 40)
        : null,
      fileReleased(file.document, file.entry),
      file.document.review && !Array.isArray(file.document.review)
        ? JSON.stringify(file.document.review)
        : null,
      file.records.length,
      runId,
    ],
  );
}

interface SeedRunRow {
  id: string;
  library: string;
  researchRunId: string;
  folder: string;
  runKind: string;
  agentModel: string;
  briefKey: string | null;
  briefHash: string;
  outputHash: string;
  rowsDrafted: number;
  rowsRefused: number;
  sourcesCited: number;
  startedAt: string;
  finishedAt: string | null;
  notes: string;
}

function seedRuns(files: LoadedFile[]): SeedRunRow[] {
  const byFolder = new Map<string, LoadedFile[]>();
  for (const file of files) {
    const folder = folderOf(file.entry.path);
    const list = byFolder.get(folder) ?? [];
    list.push(file);
    byFolder.set(folder, list);
  }
  const rows: SeedRunRow[] = [];
  for (const [folder, folderFiles] of byFolder) {
    const ordered = [...folderFiles].sort((a, b) => (a.entry.path < b.entry.path ? -1 : 1));
    const research = researchRunIdForFolder(folder, ordered);
    if (!research || !UUID_TEXT.test(research)) continue;
    const outputHash = sha256Hex(ordered.map((file) => file.sha256).join(''));
    const runFile = ordered.find((file) => file.entry.format === 'run_manifest_v0');
    const records = ordered.flatMap((file) => file.records);
    const libraries = [...new Set(records.map((record) => record.library))];
    for (const library of libraries) {
      const figures = seedRunFigures(runFile?.document ?? {}, records, library, libraries);
      rows.push(runRow(folder, library, research, outputHash, runFile, ordered, figures));
    }
  }
  return rows;
}

function runRow(
  folder: string,
  library: string,
  research: string,
  outputHash: string,
  runFile: LoadedFile | undefined,
  folderFiles: LoadedFile[],
  figures: SeedRunFigures,
): SeedRunRow {
  const document = runFile?.document ?? {};
  const synthetic = folder === 'responder-units';
  const briefHash =
    typeof document.brief_hash === 'string' && /^[0-9a-f]{64}$/.test(document.brief_hash)
      ? document.brief_hash
      : runFile
        ? sha256Hex(canonicalJson(document))
        : outputHash;
  const model = cut(
    stringOf(document.agent_model) ??
      stringOf(folderFiles[0]?.document.prepared_by) ??
      'research agent',
    120,
  );
  const started =
    timestampOf(document.started_at) ?? dateStamp(stringOf(folderFiles[0]?.document.prepared_on));
  const note = stringOf(document.note) ?? stringOf(document.brief_note) ?? '';
  return {
    id: seedRunId(research, library),
    library,
    researchRunId: research,
    folder,
    runKind: runKindOf(document.run_kind),
    agentModel: model.length >= 2 ? model : 'research agent',
    briefKey: briefKeyOf(document),
    briefHash,
    outputHash,
    rowsDrafted: figures.rowsDrafted,
    rowsRefused: figures.rowsRefused,
    sourcesCited: figures.sourcesCited,
    startedAt: started,
    finishedAt: synthetic ? started : timestampOf(document.finished_at),
    notes: cut(
      `Research run ${research} from ${folder}. brief_hash is the run manifest hash: no brief file existed. ${note}`.trim(),
      2000,
    ),
  };
}

function researchRunIdForFolder(folder: string, files: LoadedFile[]): string | null {
  if (folder === 'physics-movement') return derivedPhysicsRunId();
  if (folder === 'responder-units') return derivedResponderRunId();
  const run = files.find((file) => file.entry.format === 'run_manifest_v0');
  const id = run && typeof run.document.run_id === 'string' ? run.document.run_id : null;
  return id;
}

async function upsertSeedRun(client: pg.Client, run: SeedRunRow): Promise<void> {
  await client.query(
    `INSERT INTO public.fieldops_seed_runs
      (id, library, run_kind, agent_model, brief_key, brief_hash, output_hash, rows_drafted, rows_refused,
       sources_cited, started_at, finished_at, notes, source_run_id, source_folder)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (id) DO UPDATE SET
       agent_model = EXCLUDED.agent_model, brief_key = EXCLUDED.brief_key, brief_hash = EXCLUDED.brief_hash,
       output_hash = EXCLUDED.output_hash, rows_drafted = EXCLUDED.rows_drafted, rows_refused = EXCLUDED.rows_refused,
       sources_cited = EXCLUDED.sources_cited, finished_at = EXCLUDED.finished_at, notes = EXCLUDED.notes,
       source_run_id = EXCLUDED.source_run_id, source_folder = EXCLUDED.source_folder
     WHERE (public.fieldops_seed_runs.agent_model, public.fieldops_seed_runs.brief_key,
            public.fieldops_seed_runs.brief_hash, public.fieldops_seed_runs.output_hash,
            public.fieldops_seed_runs.rows_drafted, public.fieldops_seed_runs.rows_refused,
            public.fieldops_seed_runs.sources_cited, public.fieldops_seed_runs.finished_at,
            public.fieldops_seed_runs.notes, public.fieldops_seed_runs.source_run_id,
            public.fieldops_seed_runs.source_folder)
       IS DISTINCT FROM (EXCLUDED.agent_model, EXCLUDED.brief_key, EXCLUDED.brief_hash, EXCLUDED.output_hash,
                         EXCLUDED.rows_drafted, EXCLUDED.rows_refused, EXCLUDED.sources_cited, EXCLUDED.finished_at,
                         EXCLUDED.notes, EXCLUDED.source_run_id, EXCLUDED.source_folder)`,
    [
      run.id,
      run.library,
      run.runKind,
      run.agentModel,
      run.briefKey,
      run.briefHash,
      run.outputHash,
      run.rowsDrafted,
      run.rowsRefused,
      run.sourcesCited,
      run.startedAt,
      run.finishedAt,
      run.notes,
      run.researchRunId,
      run.folder,
    ],
  );
}

async function upsertRecord(
  client: pg.Client,
  file: LoadedFile,
  record: ClassifiedRecord,
  runId: string,
  runs: SeedRunRow[],
  researchByFolder: Map<string, string>,
): Promise<'inserted' | 'changed' | 'unchanged'> {
  const research = researchRunId(file, record, researchByFolder);
  const seed = research
    ? runs.find((run) => run.researchRunId === research && run.library === record.library)
    : undefined;
  const existing = await client.query<{
    payload_sha256: string;
    review_state: string;
    reviewer_name: string | null;
    decided_on: string | null;
    review: Record<string, unknown>;
    missing_since: Date | null;
  }>(
    `SELECT payload_sha256, review_state, reviewer_name, decided_on::text, review, missing_since
       FROM public.fieldops_knowledge_records
      WHERE file_path = $1 AND record_kind = $2 AND record_key = $3`,
    [record.filePath, record.recordKind, record.recordKey],
  );
  const previous = existing.rows[0];
  const reviewSame =
    previous &&
    previous.review_state === record.review.state &&
    stableJson(previous.review) === stableJson(record.review.stored);
  if (
    previous &&
    previous.payload_sha256 === record.payloadSha256 &&
    reviewSame &&
    !previous.missing_since
  ) {
    await client.query(
      `UPDATE public.fieldops_knowledge_records SET last_import_run_id = $4
        WHERE file_path = $1 AND record_kind = $2 AND record_key = $3`,
      [record.filePath, record.recordKind, record.recordKey, runId],
    );
    return 'unchanged';
  }
  const payloadChanged = Boolean(previous && previous.payload_sha256 !== record.payloadSha256);
  const wasApproved = previous?.review_state === 'approved' || previous?.review_state === 'amended';
  const sameApproval =
    previous?.reviewer_name === record.review.reviewerName &&
    (previous?.decided_on ?? null) === (record.review.decidedOn ?? null);
  const pendingChange = payloadChanged && wasApproved && sameApproval;
  const state = pendingChange ? 'pending' : record.review.state;
  const writeApproval = !pendingChange && (state === 'approved' || state === 'amended');
  const name = fit(record.review.reviewerName, 2, 120);
  const qualification = fit(record.review.reviewerQualification, 2, 300);
  await client.query(
    `INSERT INTO public.fieldops_knowledge_records
      (file_path, record_kind, record_key, ordinal, library, country, target_table, target_key, payload, payload_sha256,
       provenance, review_evidence, drafted_by, confidence, assumed_fields, to_verify, unverified_fields, withheld_fields,
       source_keys, seed_run_id, review_state, review, reviewer_name, reviewer_qualification, decided_on,
       approved_payload, approved_payload_sha256, approved_at, pending_change, issues, blocker_count, warning_count,
       first_import_run_id, last_import_run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,
             $23,$24,$25,$26::jsonb,$27, CASE WHEN $26::jsonb IS NULL THEN NULL ELSE now() END, $28,$29::jsonb,$30,$31,$32,$32)
     ON CONFLICT (file_path, record_kind, record_key) DO UPDATE SET
       ordinal = EXCLUDED.ordinal, library = EXCLUDED.library, country = EXCLUDED.country,
       target_table = EXCLUDED.target_table, target_key = EXCLUDED.target_key,
       payload = EXCLUDED.payload, payload_sha256 = EXCLUDED.payload_sha256,
       provenance = EXCLUDED.provenance, review_evidence = EXCLUDED.review_evidence,
       drafted_by = EXCLUDED.drafted_by, confidence = EXCLUDED.confidence,
       assumed_fields = EXCLUDED.assumed_fields, to_verify = EXCLUDED.to_verify,
       unverified_fields = EXCLUDED.unverified_fields, withheld_fields = EXCLUDED.withheld_fields,
       source_keys = EXCLUDED.source_keys, seed_run_id = EXCLUDED.seed_run_id,
       review_state = EXCLUDED.review_state, review = EXCLUDED.review,
       reviewer_name = EXCLUDED.reviewer_name, reviewer_qualification = EXCLUDED.reviewer_qualification,
       decided_on = EXCLUDED.decided_on,
       approved_payload = CASE WHEN $33 THEN fieldops_knowledge_records.approved_payload ELSE EXCLUDED.approved_payload END,
       approved_payload_sha256 = CASE WHEN $33 THEN fieldops_knowledge_records.approved_payload_sha256 ELSE EXCLUDED.approved_payload_sha256 END,
       approved_at = CASE WHEN $33 THEN fieldops_knowledge_records.approved_at ELSE EXCLUDED.approved_at END,
       pending_change = EXCLUDED.pending_change, issues = EXCLUDED.issues,
       blocker_count = EXCLUDED.blocker_count, warning_count = EXCLUDED.warning_count,
       last_import_run_id = EXCLUDED.last_import_run_id, missing_since = NULL`,
    [
      record.filePath,
      record.recordKind,
      record.recordKey,
      record.ordinal,
      record.library,
      record.country,
      record.targetTable,
      record.targetKey,
      JSON.stringify(record.payload),
      record.payloadSha256,
      record.provenance ? JSON.stringify(record.provenance) : null,
      record.reviewEvidence ? JSON.stringify(record.reviewEvidence) : null,
      record.draftedBy,
      record.confidence,
      record.assumedFields,
      record.toVerify,
      record.unverifiedFields,
      record.withheldFields,
      record.sourceKeys,
      seed?.id ?? null,
      state,
      JSON.stringify(record.review.stored),
      name,
      qualification,
      record.review.decidedOn,
      writeApproval ? JSON.stringify(record.payload) : null,
      writeApproval ? record.payloadSha256 : null,
      pendingChange,
      JSON.stringify(record.issues),
      record.issues.filter((issue) => issue.severity === 'blocker').length,
      record.issues.filter((issue) => issue.severity === 'warning').length,
      runId,
      pendingChange,
    ],
  );
  return previous ? 'changed' : 'inserted';
}

function researchRunId(
  file: LoadedFile,
  record: ClassifiedRecord,
  researchByFolder: Map<string, string>,
): string | null {
  const fromRow = record.provenance?.run_id;
  if (typeof fromRow === 'string' && UUID_TEXT.test(fromRow)) return fromRow;
  const folder = folderOf(file.entry.path);
  if (folder === 'physics-movement') return derivedPhysicsRunId();
  if (folder === 'responder-units') return derivedResponderRunId();
  return researchByFolder.get(folder) ?? null;
}

async function markMissingRecords(
  client: pg.Client,
  files: LoadedFile[],
  seen: Map<string, Set<string>>,
): Promise<number> {
  let missing = 0;
  for (const file of files) {
    const rows = await client.query<{ record_kind: string; record_key: string }>(
      `SELECT record_kind, record_key FROM public.fieldops_knowledge_records
        WHERE file_path = $1 AND missing_since IS NULL`,
      [file.entry.path],
    );
    const present = seen.get(file.entry.path) ?? new Set<string>();
    for (const row of rows.rows) {
      if (present.has(`${row.record_kind}\t${row.record_key}`)) continue;
      await client.query(
        `UPDATE public.fieldops_knowledge_records SET missing_since = now()
          WHERE file_path = $1 AND record_kind = $2 AND record_key = $3 AND missing_since IS NULL`,
        [file.entry.path, row.record_kind, row.record_key],
      );
      missing += 1;
    }
  }
  return missing;
}

async function markMissingFiles(
  client: pg.Client,
  files: LoadedFile[],
  folders: string[],
): Promise<number> {
  if (folders.length === 0) return 0;
  const present = files.map((file) => file.entry.path);
  const result = await client.query(
    `UPDATE public.fieldops_seed_files SET missing_since = now()
      WHERE folder = ANY($1::text[])
        AND NOT (file_path = ANY($2::text[]))
        AND missing_since IS NULL`,
    [folders, present.length > 0 ? present : ['']],
  );
  return result.rowCount ?? 0;
}

async function writeCoverage(
  client: pg.Client,
  files: LoadedFile[],
  runs: SeedRunRow[],
): Promise<void> {
  const runFor = (folder: string, library: string) =>
    runs.find((run) => run.folder === folder && run.library === library)?.id ?? null;
  for (const file of files) {
    const folder = folderOf(file.entry.path);
    const country = headerCountry(file.document);
    for (const record of file.records) {
      if (record.recordKind !== 'uncovered' && record.recordKind !== 'gap') continue;
      const payload = record.payload as Record<string, unknown>;
      const subject = cut(
        String(
          record.recordKind === 'gap'
            ? (payload.ref_key ?? record.recordKey)
            : (payload.subject ?? record.recordKey),
        ),
        120,
      );
      const note = cut(String(payload.why ?? payload.note ?? ''), 400);
      const checked = Array.isArray(payload.sources_checked)
        ? payload.sources_checked.length
        : Array.isArray(payload.checked)
          ? payload.checked.length
          : 0;
      await gap(
        client,
        record.library,
        country,
        subject,
        note,
        checked,
        runFor(folder, record.library),
      );
    }
  }
  const movement = files.find((file) =>
    file.entry.path.endsWith('movement-parameters.pending.json'),
  );
  if (movement) {
    const country = headerCountry(movement.document);
    for (const key of MISSING_MOVEMENT_KEYS) {
      await gap(
        client,
        'movement',
        country,
        key,
        'missing movement parameter',
        0,
        runFor('physics-movement', 'movement'),
      );
    }
  }
  const threats = files.find((file) => file.entry.path.endsWith('threat-profiles.pending.json'));
  if (threats) {
    const present = new Set(threats.records.map((record) => record.recordKey));
    const country = headerCountry(threats.document);
    for (const key of DANGLING_THREAT_KEYS) {
      if (present.has(key)) continue;
      await gap(
        client,
        'threats',
        country,
        key,
        'dangling threat key',
        0,
        runFor('physics-movement', 'threats'),
      );
    }
  }
  const sources = files.find((file) => file.entry.path.endsWith('building-hazards/sources.json'));
  if (sources) {
    const country = headerCountry(sources.document) ?? 'SG';
    for (const key of UNACCESSED_SOURCES) {
      await gap(
        client,
        'building_hazards',
        country,
        `source:${key}`,
        'not accessed',
        0,
        runFor('building-hazards', 'building_hazards'),
      );
    }
  }
  if (files.some((file) => folderOf(file.entry.path) === 'doctrines')) {
    await gap(
      client,
      'doctrines',
      'SG',
      'doctrine_force_ceilings',
      'use-of-force ceilings are not seeded',
      0,
      runFor('doctrines', 'doctrines'),
    );
  }
}

async function gap(
  client: pg.Client,
  library: string,
  country: string | null,
  subject: string,
  note: string,
  sourcesChecked: number,
  runId: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO public.fieldops_knowledge_coverage
      (library, country, subject_key, status, note, sources_checked, last_run_id)
     VALUES ($1, $2, $3, 'gap', NULLIF($4, ''), $5, $6)
     ON CONFLICT (library, COALESCE(country, '--'), subject_key) DO UPDATE
       SET note = EXCLUDED.note, sources_checked = EXCLUDED.sources_checked,
           last_run_id = EXCLUDED.last_run_id, updated_at = now()
     WHERE public.fieldops_knowledge_coverage.status <> 'covered'
       AND (public.fieldops_knowledge_coverage.note, public.fieldops_knowledge_coverage.sources_checked,
            public.fieldops_knowledge_coverage.last_run_id)
           IS DISTINCT FROM (EXCLUDED.note, EXCLUDED.sources_checked, EXCLUDED.last_run_id)`,
    [library, country, subject, note, sourcesChecked, runId],
  );
}

function headerOf(document: Record<string, unknown>): Record<string, unknown> {
  const skip = new Set([
    'rows',
    'reference_rows',
    'uncovered',
    'refused',
    'oracles',
    'agencies',
    'reviews',
    'examples',
    'cases_10kg_tnt',
    'other_oracles',
    'curves_spec_shape',
    'lookup_tables',
  ]);
  const header: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (!skip.has(key)) header[key] = value;
  }
  return header;
}

function headerCountry(document: Record<string, unknown>): string | null {
  return typeof document.country === 'string' && /^[A-Z]{2}$/.test(document.country)
    ? document.country
    : null;
}

function manifestSha256(dir: string): string | null {
  try {
    return sha256Buffer(readFileSync(path.join(dir, 'manifest.json')));
  } catch {
    return null;
  }
}

function briefKeyOf(document: Record<string, unknown>): string | null {
  const direct = stringOf(document.brief_key);
  if (direct && /^[a-z][a-z0-9_]{1,63}$/.test(direct)) return direct;
  for (const list of [document.brief_keys, document.briefs]) {
    if (!Array.isArray(list)) continue;
    const first = list.find(
      (item) => typeof item === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(item),
    );
    if (typeof first === 'string') return first;
  }
  return null;
}

function runKindOf(value: unknown): string {
  return value === 'agent' || value === 'person' || value === 'import' ? value : 'agent';
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function timestampOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function dateStamp(value: string | null): string {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
  return new Date().toISOString();
}

function cut(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function fit(value: string | null, min: number, max: number): string | null {
  if (!value) return null;
  const trimmed = value.length <= max ? value : value.slice(0, max);
  return trimmed.length >= min ? trimmed : null;
}

function stableJson(value: unknown): string {
  return canonicalJson(JSON.parse(JSON.stringify(value ?? null)) as unknown);
}
