import path from 'node:path';
import { loadSeeds } from './classify.js';
import { annotateIssues } from './issues.js';
import { buildManifest, manifestDifferences, readManifest, writeManifest } from './manifest.js';
import { formatReport, validationReport } from './report.js';
import { applyBulkReview, applyFileReview, type ReviewDecisionInput } from './reviewEdit.js';

const DEFAULT_DIR = 'scripts/fieldops/seeds';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function flags(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === `--${name}` && process.argv[index + 1])
      values.push(process.argv[index + 1] as string);
  }
  return values;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function seedsDir(): string {
  return path.resolve(arg('dir') ?? process.env.KNOWLEDGE_SEEDS_DIR ?? DEFAULT_DIR);
}

function decisionInput(): ReviewDecisionInput {
  const decision = arg('decision');
  const reviewer = arg('reviewer');
  const qualification = arg('qualification');
  const date = arg('date');
  if (decision !== 'approved' && decision !== 'amended' && decision !== 'rejected') {
    throw new Error('review requires --decision approved|amended|rejected');
  }
  if (!reviewer || !qualification || !date) {
    throw new Error('review requires --reviewer, --qualification and --date');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date must be YYYY-MM-DD');
  const notes = arg('notes') ?? '';
  if (decision === 'amended' && notes.trim().length === 0)
    throw new Error('amended requires --notes');
  return { decision, reviewer, qualification, date, notes };
}

function main(): void {
  const command = process.argv[2];
  try {
    if (command === 'manifest') manifestCommand();
    else if (command === 'validate') validateCommand();
    else if (command === 'review') reviewCommand();
    else {
      console.error('Usage: npm run knowledge -- manifest|validate|review ...');
      process.exit(1);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

function manifestCommand(): void {
  const dir = seedsDir();
  const generatedOn = arg('date') ?? new Date().toISOString().slice(0, 10);
  if (has('write') === has('check')) {
    console.error('manifest requires exactly one of --write or --check');
    process.exit(1);
  }
  const actual = buildManifest(dir, generatedOn);
  if (has('write')) {
    const existingDate = readExistingDate(dir);
    writeManifest(dir, { ...actual, generated_on: existingDate ?? generatedOn });
    console.log(`wrote ${actual.files.length} files`);
    return;
  }
  const expected = readManifest(dir);
  const diffs = manifestDifferences(expected, { ...actual, generated_on: expected.generated_on });
  if (diffs.length > 0) {
    for (const diff of diffs) console.error(diff);
    process.exit(1);
  }
  console.log(`manifest ok (${actual.files.length} files)`);
}

function readExistingDate(dir: string): string | null {
  try {
    return readManifest(dir).generated_on;
  } catch {
    return null;
  }
}

function validateCommand(): void {
  const loaded = loadSeeds(seedsDir(), {
    allowUnknown: has('allow-unknown'),
    folders: flags('folder'),
  });
  if (loaded.errors.length > 0) {
    for (const error of loaded.errors) console.error(error);
    process.exit(1);
  }
  annotateIssues(loaded.files);
  const report = validationReport(loaded.files);
  if (has('json')) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report));
}

function reviewCommand(): void {
  const input = decisionInput();
  const dir = seedsDir();
  if (has('bulk')) {
    const touched = applyBulkReview(dir, input, flags('folder'));
    console.log(`reviewed ${touched.length} files`);
    return;
  }
  const file = arg('file');
  const key = arg('key');
  if (!file || !key) {
    console.error('review requires --bulk or --file and --key');
    process.exit(1);
  }
  applyFileReview(dir, file, key, input, has('release'));
  console.log(`reviewed ${file} ${key}`);
}

main();
