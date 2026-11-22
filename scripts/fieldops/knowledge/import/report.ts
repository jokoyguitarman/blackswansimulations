import { issueSummary } from './issues.js';
import type { ClassifiedRecord, LoadedFile } from './types.js';

export interface ValidationReport {
  records: number;
  byKind: Record<string, number>;
  byState: Record<string, number>;
  byLibrary: Record<string, number>;
  blockers: number;
  warnings: number;
  issues: Record<string, number>;
  files: number;
  derivedSources: number;
}

export function validationReport(files: LoadedFile[]): ValidationReport {
  const records = files.flatMap((file) => file.records);
  const byKind: Record<string, number> = {};
  const byState: Record<string, number> = {};
  const byLibrary: Record<string, number> = {};
  let blockers = 0;
  let warnings = 0;
  for (const record of records) {
    byKind[record.recordKind] = (byKind[record.recordKind] ?? 0) + 1;
    byState[record.review.state] = (byState[record.review.state] ?? 0) + 1;
    byLibrary[record.library] = (byLibrary[record.library] ?? 0) + 1;
    for (const issue of record.issues) {
      if (issue.severity === 'blocker') blockers += 1;
      else warnings += 1;
    }
  }
  return {
    records: records.length,
    byKind,
    byState,
    byLibrary,
    blockers,
    warnings,
    issues: issueSummary(files),
    files: files.length,
    derivedSources: derivedSourceCount(records),
  };
}

function derivedSourceCount(records: ClassifiedRecord[]): number {
  const urls = new Set<string>();
  const add = (sources: unknown) => {
    if (!Array.isArray(sources)) return;
    for (const source of sources) {
      if (
        source &&
        typeof source === 'object' &&
        typeof (source as { url?: unknown }).url === 'string'
      ) {
        urls.add((source as { url: string }).url);
      }
    }
  };
  for (const record of records) {
    if (
      record.recordKind !== 'doctrine_seed' &&
      record.recordKind !== 'register_agency' &&
      record.recordKind !== 'register_unit'
    )
      continue;
    const payload = record.payload;
    if (!payload || typeof payload !== 'object') continue;
    const body = payload as { provenance?: { sources?: unknown }; sources?: unknown };
    add(body.provenance?.sources);
    add(body.sources);
    add(record.provenance?.sources);
  }
  return urls.size;
}

export function formatReport(report: ValidationReport): string {
  const lines = [
    `files ${report.files}`,
    `records ${report.records}`,
    `states ${JSON.stringify(report.byState)}`,
    `kinds ${JSON.stringify(report.byKind)}`,
    `blockers ${report.blockers}`,
    `warnings ${report.warnings}`,
    `derived_sources ${report.derivedSources}`,
    'issues:',
  ];
  for (const [code, count] of Object.entries(report.issues).sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    lines.push(`  ${code} ${count}`);
  }
  return lines.join('\n');
}
