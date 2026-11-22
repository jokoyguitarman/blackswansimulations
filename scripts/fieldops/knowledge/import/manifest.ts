import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { countByKind, loadSeeds } from './classify.js';
import { annotateIssues } from './issues.js';

export interface ManifestFile {
  path: string;
  sha256: string;
  bytes: number;
  format: string;
  library: string;
  records: Record<string, number>;
}

export interface Manifest {
  format: 'fieldops_seed_manifest_v1';
  generated_on: string;
  files: ManifestFile[];
}

export function buildManifest(dir: string, generatedOn: string): Manifest {
  const loaded = loadSeeds(dir);
  if (loaded.errors.length > 0) {
    throw new Error(loaded.errors.join('\n'));
  }
  annotateIssues(loaded.files);
  return {
    format: 'fieldops_seed_manifest_v1',
    generated_on: generatedOn,
    files: loaded.files.map((file) => ({
      path: file.entry.path,
      sha256: file.sha256,
      bytes: file.bytes.length,
      format: file.entry.format,
      library: file.entry.library,
      records: countByKind(file.records),
    })),
  };
}

export function readManifest(dir: string): Manifest {
  const raw = readFileSync(path.join(dir, 'manifest.json'), 'utf8');
  return JSON.parse(raw) as Manifest;
}

export function writeManifest(dir: string, manifest: Manifest): void {
  writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Compare file entries. generated_on is kept from the written manifest and is not a drift. */
export function manifestDifferences(expected: Manifest, actual: Manifest): string[] {
  const diffs: string[] = [];
  if (expected.format !== actual.format)
    diffs.push(`format ${expected.format} != ${actual.format}`);
  const expectedByPath = new Map(expected.files.map((file) => [file.path, file]));
  const actualByPath = new Map(actual.files.map((file) => [file.path, file]));
  for (const [filePath, file] of expectedByPath) {
    const found = actualByPath.get(filePath);
    if (!found) {
      diffs.push(`missing ${filePath}`);
      continue;
    }
    if (found.sha256 !== file.sha256) diffs.push(`${filePath} sha256`);
    if (found.bytes !== file.bytes) diffs.push(`${filePath} bytes`);
    if (found.format !== file.format) diffs.push(`${filePath} format`);
    if (found.library !== file.library) diffs.push(`${filePath} library`);
    if (JSON.stringify(found.records) !== JSON.stringify(file.records))
      diffs.push(`${filePath} records`);
  }
  for (const filePath of actualByPath.keys()) {
    if (!expectedByPath.has(filePath)) diffs.push(`unexpected ${filePath}`);
  }
  return diffs;
}
