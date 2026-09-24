import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PDFDocument, rgb, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { AgreementFieldKey, AgreementInfo } from '../../../shared/trainerAgreements.js';

/**
 * The Prophyion Consultant Agreement as a personalised PDF.
 *
 * Each version lives in server/assets/consultant-agreement/<version>/ as the Word export with its
 * placeholders removed (agreement.pdf) plus where each value goes (fields.json), both produced by
 * `npm run agreement:build`. Earlier versions stay so agreements already issued can be re-rendered.
 */

export const CURRENT_AGREEMENT_VERSION = '2026-09';

const ASSETS_DIR = path.join(process.cwd(), 'server', 'assets');
const FONT_FILE = path.join(ASSETS_DIR, 'fonts', 'NotoSans-Regular.ttf');
/** A fixed subset name; pdf-lib otherwise adds a random suffix and no two renders match. */
const FONT_NAME = 'ProphyionNotoSans';
const MIN_FIELD_SIZE = 7;
const MIN_FOOTER_SIZE = 5;
const FOOTER_NAME_LIMIT = 60;
const INK = rgb(0.09, 0.13, 0.2);
const MUTED = rgb(0.42, 0.45, 0.5);

export interface AgreementTemplateField {
  key: AgreementFieldKey;
  /** Zero-based page index. */
  page: number;
  /** Left edge and baseline, in PDF points from the bottom-left corner. */
  x: number;
  y: number;
  size: number;
  maxWidth: number;
}

export interface AgreementTemplate {
  version: string;
  title: string;
  pageCount: number;
  pageSize: [number, number];
  fields: AgreementTemplateField[];
  footer: { x: number; y: number; size: number; maxWidth: number };
}

export const agreementDir = (version: string): string =>
  path.join(ASSETS_DIR, 'consultant-agreement', version);

interface LoadedTemplate {
  meta: AgreementTemplate;
  pdf: Uint8Array;
}

const templates = new Map<string, Promise<LoadedTemplate>>();
let fontBytes: Promise<Uint8Array> | null = null;
let fontCodePoints: Promise<Set<number>> | null = null;

export function loadAgreementTemplate(
  version: string = CURRENT_AGREEMENT_VERSION,
): Promise<LoadedTemplate> {
  let loaded = templates.get(version);
  if (!loaded) {
    loaded = (async () => {
      const dir = agreementDir(version);
      const [metaRaw, pdf] = await Promise.all([
        readFile(path.join(dir, 'fields.json'), 'utf-8'),
        readFile(path.join(dir, 'agreement.pdf')),
      ]);
      return { meta: JSON.parse(metaRaw) as AgreementTemplate, pdf: new Uint8Array(pdf) };
    })();
    loaded.catch(() => templates.delete(version));
    templates.set(version, loaded);
  }
  return loaded;
}

function loadFontBytes(): Promise<Uint8Array> {
  if (!fontBytes) {
    fontBytes = readFile(FONT_FILE).then((buffer) => new Uint8Array(buffer));
    fontBytes.catch(() => {
      fontBytes = null;
    });
  }
  return fontBytes;
}

export function agreementInfo(meta: AgreementTemplate): AgreementInfo {
  return {
    version: meta.version,
    title: meta.title,
    pageCount: meta.pageCount,
    fields: [...new Set(meta.fields.map((f) => f.key))],
  };
}

/** Characters in `text` the agreement font cannot draw, e.g. Chinese characters in a name. */
export async function unsupportedCharacters(text: string): Promise<string[]> {
  if (!fontCodePoints) {
    fontCodePoints = loadFontBytes().then((bytes) => new Set(fontkit.create(bytes).characterSet));
    fontCodePoints.catch(() => {
      fontCodePoints = null;
    });
  }
  const supported = await fontCodePoints;
  const missing = new Set<string>();
  for (const char of text) {
    if (/\s/.test(char)) continue;
    if (!supported.has(char.codePointAt(0)!)) missing.add(char);
  }
  return [...missing];
}

/** Largest size up to `preferred` at which `text` fits in `maxWidth`, but never below `min`. */
export function fitFontSize(
  font: Pick<PDFFont, 'widthOfTextAtSize'>,
  text: string,
  preferred: number,
  maxWidth: number,
  min: number = MIN_FIELD_SIZE,
): number {
  const width = font.widthOfTextAtSize(text, preferred);
  if (width <= maxWidth) return preferred;
  return Math.max(min, Math.floor(((preferred * maxWidth) / width) * 100) / 100);
}

export const formatAgreementDate = (date: Date): string =>
  date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Singapore',
  });

export interface AgreementRenderInput {
  version: string;
  reference: string;
  issuedAt: Date;
  fullName: string;
  email: string;
  contactNumber: string | null;
  address: string | null;
}

export interface RenderedAgreement {
  bytes: Uint8Array;
  sha256: string;
  pageCount: number;
}

export const agreementFileName = (reference: string): string =>
  `Prophyion-Consultant-Agreement-${reference}.pdf`;

/**
 * Write the applicant's details into the template and put the reference line on every page.
 * The same input always produces the same bytes, so an issued agreement can be re-rendered and
 * matched against the hash recorded when it was issued.
 */
export async function renderAgreement(input: AgreementRenderInput): Promise<RenderedAgreement> {
  const { meta, pdf } = await loadAgreementTemplate(input.version);
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(await loadFontBytes(), { subset: true, customName: FONT_NAME });
  const pages = doc.getPages();
  const issued = formatAgreementDate(input.issuedAt);

  const values: Record<AgreementFieldKey, string | null> = {
    full_name: input.fullName,
    email: input.email,
    contact_number: input.contactNumber,
    address: input.address,
    agreement_date: issued,
  };

  for (const field of meta.fields) {
    const value = values[field.key]?.trim();
    if (!value) continue;
    const page = pages[field.page];
    if (!page) {
      throw new Error(
        `Agreement ${meta.version} places ${field.key} on missing page ${field.page}`,
      );
    }
    page.drawText(value, {
      x: field.x,
      y: field.y,
      size: fitFontSize(font, value, field.size, field.maxWidth),
      font,
      color: INK,
    });
  }

  const name =
    input.fullName.length > FOOTER_NAME_LIMIT
      ? `${input.fullName.slice(0, FOOTER_NAME_LIMIT - 1)}…`
      : input.fullName;
  pages.forEach((page, index) => {
    const line = `${meta.title} v${meta.version} · Ref ${input.reference} · Issued to ${name} on ${issued} · Page ${index + 1} of ${pages.length}`;
    page.drawText(line, {
      x: meta.footer.x,
      y: meta.footer.y,
      size: fitFontSize(font, line, meta.footer.size, meta.footer.maxWidth, MIN_FOOTER_SIZE),
      font,
      color: MUTED,
    });
  });

  doc.setTitle(`${meta.title} (${input.reference})`);
  doc.setAuthor('Prophyion');
  doc.setSubject(`Issued to ${input.fullName} <${input.email}> on ${issued}`);
  doc.setKeywords([input.reference, `v${meta.version}`]);
  doc.setCreator('Prophyion platform');
  doc.setProducer('Prophyion platform');
  doc.setCreationDate(input.issuedAt);
  doc.setModificationDate(input.issuedAt);

  const bytes = await doc.save();
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    pageCount: pages.length,
  };
}
