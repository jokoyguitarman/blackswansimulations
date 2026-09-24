/**
 * Builds one version of the Consultant Agreement template.
 *
 *   npm run agreement:build 2026-09
 *   npx tsx scripts/consultant-agreement/build-template.ts 2026-09 [--skip-export] [--force]
 *
 * Input:  server/assets/consultant-agreement/<version>/source.docx, the Word master. Every value
 *         the platform fills in is a placeholder such as [FULL NAME], alone in its own table cell.
 * Output: agreement.pdf and fields.json next to the master, and a filled sample in tmp/ to check
 *         by eye before committing.
 *
 * Word exports the master twice (export-pdf.ps1): as written, and with the placeholders removed.
 * The first export shows where each placeholder sat; the second is what applicants receive. This
 * needs Windows with Microsoft Word, unless --skip-export is given and both exports already sit in
 * tmp/consultant-agreement/<version>/.
 *
 * A built version is never rebuilt without --force: agreements already issued are re-rendered from
 * it and must stay identical to what was signed, so changes go into a new version folder.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { format, resolveConfig } from 'prettier';
import type { AgreementFieldKey } from '../../shared/trainerAgreements.js';
import {
  agreementDir,
  renderAgreement,
  type AgreementTemplate,
  type AgreementTemplateField,
} from '../../server/services/trainerAgreements/template.js';

const PLACEHOLDERS: Record<string, AgreementFieldKey> = {
  '[FULL NAME]': 'full_name',
  '[EMAIL ADDRESS]': 'email',
  '[CONTACT NUMBER]': 'contact_number',
  '[ADDRESS]': 'address',
  '[DATE]': 'agreement_date',
};
const REQUIRED_FIELDS: AgreementFieldKey[] = ['full_name', 'email'];
const TITLE = 'Prophyion Consultant Agreement';
/** The value column of both tables runs to the 1-inch right margin, less the cell padding. */
const RIGHT_MARGIN = 72;
const CELL_PADDING = 6;
const FOOTER = { x: 72, y: 18, size: 7 };
/** Word must print nothing below this height: the reference line goes there. */
const FOOTER_ZONE_TOP = 30;
const POSITION_TOLERANCE = 0.5;
/** Other text on the same line closer than this means the placeholder sits inside a sentence. */
const INLINE_GAP = 4;

interface TextItem {
  page: number;
  str: string;
  x: number;
  y: number;
  width: number;
  size: number;
}

interface ExtractedPdf {
  items: TextItem[];
  pageCount: number;
  pageSize: [number, number];
}

interface LocatedPlaceholder {
  key: AgreementFieldKey;
  placeholder: string;
  page: number;
  x: number;
  y: number;
  size: number;
  itemIndexes: number[];
}

function fail(message: string): never {
  console.error(`\nAgreement build failed: ${message}\n`);
  process.exit(1);
}

const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

function parseArgs(): { version: string; skipExport: boolean; force: boolean } {
  const args = process.argv.slice(2);
  const version = args.find((arg) => !arg.startsWith('--'));
  if (!version || !/^\d{4}-\d{2}[a-z0-9-]*$/.test(version)) {
    fail('pass the version folder name, e.g. npm run agreement:build 2026-09');
  }
  return {
    version,
    skipExport: args.includes('--skip-export'),
    force: args.includes('--force'),
  };
}

async function extract(file: string): Promise<ExtractedPdf> {
  const doc = await getDocument({
    data: new Uint8Array(readFileSync(file)),
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;
  const items: TextItem[] = [];
  let pageSize: [number, number] = [0, 0];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    if (n === 1) {
      const { width, height } = page.getViewport({ scale: 1 });
      pageSize = [width, height];
    }
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!('str' in item) || item.str.trim() === '') continue;
      const [, , c, d, e, f] = item.transform as number[];
      items.push({
        page: n - 1,
        str: item.str,
        x: e,
        y: f,
        width: item.width,
        size: Math.hypot(c, d),
      });
    }
  }
  const pageCount = doc.numPages;
  await doc.destroy();
  return { items, pageCount, pageSize };
}

/** Item indexes grouped into lines: same page, baselines within 1pt, left to right. */
function groupLines(items: TextItem[]): number[][] {
  const order = items
    .map((_, i) => i)
    .sort(
      (i, j) => items[i].page - items[j].page || items[j].y - items[i].y || items[i].x - items[j].x,
    );
  const lines: number[][] = [];
  for (const i of order) {
    const line = lines[lines.length - 1];
    const anchor = line ? items[line[0]] : undefined;
    if (anchor && anchor.page === items[i].page && Math.abs(anchor.y - items[i].y) <= 1)
      line.push(i);
    else lines.push([i]);
  }
  return lines.map((line) => line.sort((i, j) => items[i].x - items[j].x));
}

function locatePlaceholders(items: TextItem[]): LocatedPlaceholder[] {
  const located: LocatedPlaceholder[] = [];
  for (const line of groupLines(items)) {
    let text = '';
    const starts: number[] = [];
    for (const i of line) {
      starts.push(text.length);
      text += items[i].str;
    }
    for (const [placeholder, key] of Object.entries(PLACEHOLDERS)) {
      for (let at = text.indexOf(placeholder); at !== -1; at = text.indexOf(placeholder, at + 1)) {
        const end = at + placeholder.length;
        const covered = line
          .map((itemIndex, k) => ({
            itemIndex,
            start: starts[k],
            end: starts[k] + items[itemIndex].str.length,
          }))
          .filter((span) => span.start < end && span.end > at);
        const first = items[covered[0].itemIndex];
        const pageLabel = `page ${first.page + 1}`;

        const sharesRun = covered.some(
          (span) =>
            (
              text.slice(span.start, Math.max(span.start, at)) +
              text.slice(Math.min(span.end, end), span.end)
            ).trim() !== '',
        );
        if (sharesRun) {
          fail(
            `${placeholder} on ${pageLabel} shares a text run with other text. Put it alone in its own table cell.`,
          );
        }

        const firstSpan = covered[0];
        const x0 = first.x + (at - firstSpan.start) * (first.width / first.str.length);
        const last = items[covered[covered.length - 1].itemIndex];
        const x1 = last.x + last.width;
        const coveredIndexes = covered.map((span) => span.itemIndex);
        const crowded = line.some(
          (i) =>
            !coveredIndexes.includes(i) &&
            items[i].x < x1 + INLINE_GAP &&
            items[i].x + items[i].width > x0 - INLINE_GAP,
        );
        if (crowded) {
          fail(
            `${placeholder} on ${pageLabel} sits inside a sentence. Put it alone in its own table cell.`,
          );
        }

        located.push({
          key,
          placeholder,
          page: first.page,
          x: x0,
          y: first.y,
          size: first.size,
          itemIndexes: coveredIndexes,
        });
      }
    }
  }
  return located;
}

const byPosition = (a: TextItem, b: TextItem) =>
  a.page - b.page || round(b.y, 1) - round(a.y, 1) || a.x - b.x;

function checkLayoutUnchanged(expected: TextItem[], actual: TextItem[]): void {
  const want = [...expected].sort(byPosition);
  const got = [...actual].sort(byPosition);
  if (want.length !== got.length) {
    fail(
      `removing the placeholders changed the text layout (${want.length} text runs before, ${got.length} after).`,
    );
  }
  want.forEach((a, k) => {
    const b = got[k];
    const moved =
      a.page !== b.page ||
      a.str !== b.str ||
      Math.abs(a.x - b.x) > POSITION_TOLERANCE ||
      Math.abs(a.y - b.y) > POSITION_TOLERANCE;
    if (moved) {
      fail(
        `removing the placeholders moved "${a.str}" on page ${a.page + 1} ` +
          `(${round(a.x)}, ${round(a.y)} became "${b.str}" at ${round(b.x)}, ${round(b.y)} on page ${b.page + 1}). ` +
          'Keep each placeholder alone in a table cell so the rest of the document does not reflow.',
      );
    }
  });
}

async function main(): Promise<void> {
  const { version, skipExport, force } = parseArgs();
  const assets = agreementDir(version);
  const source = path.join(assets, 'source.docx');
  if (!existsSync(source)) fail(`no Word master at ${source}`);
  if (existsSync(path.join(assets, 'agreement.pdf')) && !force) {
    fail(
      `agreement ${version} is already built. Put changes in a new version folder, or pass ` +
        '--force only if no agreement has been issued from this version yet.',
    );
  }

  const work = path.join(process.cwd(), 'tmp', 'consultant-agreement', version);
  mkdirSync(work, { recursive: true });
  const withPlaceholdersPdf = path.join(work, 'with-placeholders.pdf');
  const blankPdf = path.join(work, 'agreement.pdf');

  if (!skipExport) {
    console.log('Exporting the Word master to PDF (twice)...');
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'export-pdf.ps1');
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-Source',
        source,
        '-WithPlaceholders',
        withPlaceholdersPdf,
        '-Blank',
        blankPdf,
        '-Placeholders',
        Object.keys(PLACEHOLDERS).join('|'),
      ],
      { stdio: 'inherit' },
    );
  }
  if (!existsSync(withPlaceholdersPdf) || !existsSync(blankPdf)) {
    fail(`expected ${withPlaceholdersPdf} and ${blankPdf}`);
  }

  const withPlaceholders = await extract(withPlaceholdersPdf);
  const blank = await extract(blankPdf);
  const [pageWidth] = blank.pageSize;

  if (withPlaceholders.pageCount !== blank.pageCount) {
    fail(
      `removing the placeholders changed the page count (${withPlaceholders.pageCount} to ${blank.pageCount}).`,
    );
  }
  const leftovers = blank.items.filter((item) =>
    Object.keys(PLACEHOLDERS).some((p) => item.str.includes(p)),
  );
  if (leftovers.length > 0) {
    fail(`Word left placeholders in the blank export: ${leftovers.map((i) => i.str).join(', ')}`);
  }

  const located = locatePlaceholders(withPlaceholders.items);
  for (const key of REQUIRED_FIELDS) {
    if (!located.some((l) => l.key === key)) fail(`the master has no placeholder for ${key}.`);
  }

  const placeholderItems = new Set(located.flatMap((l) => l.itemIndexes));
  checkLayoutUnchanged(
    withPlaceholders.items.filter((_, i) => !placeholderItems.has(i)),
    blank.items,
  );

  const inFooterZone = blank.items.filter((item) => item.y < FOOTER_ZONE_TOP);
  if (inFooterZone.length > 0) {
    fail(
      `the bottom ${FOOTER_ZONE_TOP}pt of the page is reserved for the reference line, but Word prints ` +
        inFooterZone.map((i) => `"${i.str}" on page ${i.page + 1}`).join(', '),
    );
  }

  const fields: AgreementTemplateField[] = located.map((l) => ({
    key: l.key,
    page: l.page,
    x: round(l.x),
    y: round(l.y),
    size: round(l.size, 1),
    maxWidth: round(pageWidth - RIGHT_MARGIN - CELL_PADDING - l.x),
  }));
  const meta: AgreementTemplate = {
    version,
    title: TITLE,
    pageCount: blank.pageCount,
    pageSize: [round(blank.pageSize[0]), round(blank.pageSize[1])],
    fields,
    footer: { ...FOOTER, maxWidth: round(pageWidth - FOOTER.x * 2) },
  };

  const fieldsFile = path.join(assets, 'fields.json');
  copyFileSync(blankPdf, path.join(assets, 'agreement.pdf'));
  writeFileSync(
    fieldsFile,
    await format(JSON.stringify(meta, null, 2), {
      ...(await resolveConfig(fieldsFile)),
      parser: 'json',
    }),
  );

  const sample = await renderAgreement({
    version,
    reference: 'PCA-SAMPLE00',
    issuedAt: new Date('2026-09-23T02:00:00Z'),
    fullName: 'Jane Tan Mei Ling',
    email: 'jane.tan@example.com',
    contactNumber: '+65 9123 4567',
    address: '10 Anson Road, #20-05 International Plaza, Singapore 079903',
  });
  const samplePdf = path.join(work, 'agreement-sample.pdf');
  writeFileSync(samplePdf, sample.bytes);

  console.log(`\nAgreement ${version}: ${meta.pageCount} pages, ${fields.length} fields`);
  for (const l of located) {
    console.log(
      `  ${l.placeholder.padEnd(17)} -> ${l.key.padEnd(15)} page ${l.page + 1}, x ${round(l.x)}, y ${round(l.y)}, ${round(l.size, 1)}pt`,
    );
  }
  console.log(
    `\nWrote ${path.relative(process.cwd(), path.join(assets, 'agreement.pdf'))} and fields.json`,
  );
  console.log(
    `Check the filled sample before committing: ${path.relative(process.cwd(), samplePdf)}\n`,
  );
}

main().catch((err: unknown) =>
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err)),
);
