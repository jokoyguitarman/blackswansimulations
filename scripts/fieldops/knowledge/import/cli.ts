import path from 'node:path';
import { loadSeeds } from './classify.js';
import { annotateIssues } from './issues.js';
import { buildManifest, manifestDifferences, readManifest, writeManifest } from './manifest.js';
import { formatReport, validationReport } from './report.js';
import { applyBulkReview, applyFileReview, type ReviewDecisionInput } from './reviewEdit.js';
import { redact, resolveDbTarget, SafetyError } from './safety.js';
import { promote } from './promote/index.js';
import { stage } from './stage.js';
import { status } from './status.js';
import { verifyKnowledge } from './verify.js';

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

async function main(): Promise<number> {
  const command = process.argv[2];
  try {
    if (command === 'manifest') manifestCommand();
    else if (command === 'validate') validateCommand();
    else if (command === 'review') reviewCommand();
    else if (command === 'stage') await stageCommand();
    else if (command === 'promote') await promoteCommand();
    else if (command === 'status') await statusCommand();
    else if (command === 'verify') await verifyCommand();
    else {
      console.error(
        'Usage: npm run knowledge -- manifest|validate|review|stage|promote|status|verify ...',
      );
      return 1;
    }
    return 0;
  } catch (error) {
    console.error(redact(error instanceof Error ? error.message : 'command failed'));
    if (error instanceof SafetyError) return 3;
    if (isDatabaseError(error)) return 2;
    return 1;
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

async function stageCommand(): Promise<void> {
  if (has('dry-run') && has('apply'))
    throw new Error('stage accepts only one of --dry-run or --apply');
  const apply = has('apply');
  const target = resolveDbTarget({ apply, confirmProject: arg('confirm-project') });
  await stage({
    dir: seedsDir(),
    folders: flags('folder'),
    apply,
    allowManifestDrift: has('allow-manifest-drift'),
    target,
  });
}

async function promoteCommand(): Promise<void> {
  if (has('dry-run') && has('apply'))
    throw new Error('promote accepts only one of --dry-run or --apply');
  const apply = has('apply');
  const target = resolveDbTarget({ apply, confirmProject: arg('confirm-project') });
  await promote({
    apply,
    allowUnscreenedDoctrines: has('allow-unscreened-doctrines'),
    libraries: flags('library'),
    target,
  });
}

async function verifyCommand(): Promise<void> {
  if (has('dry-run') && has('apply'))
    throw new Error('verify accepts only one of --dry-run or --apply');
  const apply = has('apply');
  const target = resolveDbTarget({ apply, confirmProject: arg('confirm-project') });
  await verifyKnowledge({
    apply,
    verifierEmail: arg('verifier-email'),
    verifierUserId: arg('verifier-user-id'),
    target,
  });
}

async function statusCommand(): Promise<void> {
  const target = resolveDbTarget({ apply: false, confirmProject: arg('confirm-project') });
  const report = await status(target, arg('library'));
  if (has('json')) console.log(JSON.stringify(report, null, 2));
  else console.log(JSON.stringify(report));
}

function isDatabaseError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && (code.startsWith('E') || /^[0-9A-Z]{5}$/.test(code));
}

void main().then((code) => {
  process.exit(code);
});
