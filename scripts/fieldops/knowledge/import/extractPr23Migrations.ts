/**
 * One-off extractor for the PR #23 migration blocks.
 * Spec: docs/spec-knowledge-seed-supabase-migration.md section 5.2.
 * Not part of the test list. Run once:
 *
 *   npx tsx scripts/fieldops/knowledge/import/extractPr23Migrations.ts --out migrations
 *
 * Source: origin/master when 4fe0096 is an ancestor (PR #23 merged), otherwise
 * that commit. Each file is one fenced sql block whose first line is
 * `-- Migration NNN`, with a single trailing newline. Exits 1 if any SHA-256
 * differs from the 4fe0096 value.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PR23_HEAD = '4fe0096eaab8c1cc8be1abab73d88da7f285f509';

interface MigrationSource {
  file: string;
  doc: string;
  number: number;
  sha256: string;
}

const SOURCES: readonly MigrationSource[] = [
  {
    file: '221_team_archetypes.sql',
    doc: 'docs/field-ops/02-teams-and-doctrines.md',
    number: 221,
    sha256: '932931d95da21994be404dd7fea27c4855063d5fb7dca815d806b8ff492b474b',
  },
  {
    file: '222_doctrines.sql',
    doc: 'docs/field-ops/02-teams-and-doctrines.md',
    number: 222,
    sha256: '45ec945a8f124a69b4241e2278ee147a1a7a5e9a3f2cfea5fdc47e1684269683',
  },
  {
    file: '223_doctrine_usage_reports_events.sql',
    doc: 'docs/field-ops/02-teams-and-doctrines.md',
    number: 223,
    sha256: '0f29ae8333b83727cf1e4dd390190086f87ad4b02e74d9c92c1bc84256a412fb',
  },
  {
    file: '224_doctrine_queue_indexes.sql',
    doc: 'docs/field-ops/02-teams-and-doctrines.md',
    number: 224,
    sha256: 'e59228179f9fae4cc7936780c5c075561cf697bd0198c29d1ca82be8bd4c3254',
  },
  {
    file: '239_fieldops_explosive_materials.sql',
    doc: 'docs/field-ops/07-device-and-physics.md',
    number: 239,
    sha256: '918175e0891fa5bf488d3743065a874b9cc471cb2b82ec24b270789a9b2a9dd4',
  },
  {
    file: '240_fieldops_injury_thresholds.sql',
    doc: 'docs/field-ops/07-device-and-physics.md',
    number: 240,
    sha256: 'b9376c151c94f87cff9505f0778be72c8c881917c7e5ab348c8f1c6181a796f7',
  },
  {
    file: '242_fieldops_physics_reviews.sql',
    doc: 'docs/field-ops/07-device-and-physics.md',
    number: 242,
    sha256: '92902577cf1cbb1bd6f0e8ca55cfb07145889cc16ddae5db40fdb806084bb971',
  },
  {
    file: '250_fieldops_spread_library.sql',
    doc: 'docs/field-ops/11-living-world.md',
    number: 250,
    sha256: '9197ccef18eff94484a0d97652c1530734e100c1d84f664cc9f5b929cbbe3a21',
  },
  {
    file: '257_fieldops_building_hazards.sql',
    doc: 'docs/field-ops/11-living-world.md',
    number: 257,
    sha256: 'c863b077a98238ad949278d2d16284ac6ff77e88339c64f3681818e6a5201a6e',
  },
  {
    file: '258_fieldops_threats_agents_movement.sql',
    doc: 'docs/field-ops/11-living-world.md',
    number: 258,
    sha256: 'e5bed73e3a42dba006f33ba3557daeeb4af513bd455b23472109a8e574c6e286',
  },
  {
    file: '259_fieldops_knowledge_provenance.sql',
    doc: 'docs/field-ops/11-living-world.md',
    number: 259,
    sha256: '91c03a63591a338bb8d19995e053e4db00f1dcb74b856d955efb799470afcab8',
  },
];

export function sha256Hex(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Bodies of fenced ```sql blocks, each ending with one newline. */
export function extractSqlBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const pattern = /```sql\n([\s\S]*?)```/g;
  for (const match of markdown.matchAll(pattern)) {
    const captured = match[1] ?? '';
    blocks.push(captured.endsWith('\n') ? captured : `${captured}\n`);
  }
  return blocks;
}

export function blockForMigration(markdown: string, number: number): string | null {
  const prefix = `-- Migration ${number}`;
  for (const block of extractSqlBlocks(markdown)) {
    const first = block.slice(0, block.indexOf('\n'));
    if (first.startsWith(prefix)) return block;
  }
  return null;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function pr23Merged(): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', PR23_HEAD, 'origin/master'], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function show(ref: string, doc: string): string {
  return execFileSync('git', ['show', `${ref}:${doc}`], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

function main(): void {
  const outDir = arg('out');
  if (!outDir) {
    console.error(
      'Usage: tsx scripts/fieldops/knowledge/import/extractPr23Migrations.ts --out migrations [--ref <git-ref>]',
    );
    process.exit(1);
  }
  const ref = arg('ref') ?? (pr23Merged() ? 'origin/master' : PR23_HEAD);
  mkdirSync(outDir, { recursive: true });
  console.log(`source ${ref}`);
  let failed = false;
  for (const source of SOURCES) {
    const markdown = show(ref, source.doc);
    const body = blockForMigration(markdown, source.number);
    if (!body) {
      console.error(`${source.file}: no sql block starting with -- Migration ${source.number}`);
      failed = true;
      continue;
    }
    const hash = sha256Hex(body);
    const destination = path.join(outDir, source.file);
    writeFileSync(destination, body);
    const ok = hash === source.sha256;
    console.log(
      `${source.file} ${hash} bytes=${Buffer.byteLength(body)} ${ok ? 'ok' : 'MISMATCH'}`,
    );
    if (!ok) {
      console.error(`${source.file}: expected ${source.sha256}`);
      failed = true;
    }
  }
  if (failed) {
    console.error(
      'A hash differs from 4fe0096. Stop: re-read the changed block before using these files.',
    );
    process.exit(1);
  }
}

const invokedDirectly = process.argv[1]?.endsWith('extractPr23Migrations.ts') ?? false;
if (invokedDirectly) main();
