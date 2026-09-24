import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { InvalidUploadError, inspectSignedUpload } from './inspectUpload.js';

const FILLER = [
  'Prophyion Consultant Agreement',
  'The Consultant shall use the Prophyion Technology professionally and lawfully.',
  'This Agreement is governed by the laws of Singapore.',
];

async function textPdf(lines: string[], pages = 1): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842]);
    lines.forEach((line, k) => page.drawText(line, { x: 50, y: 780 - k * 16, size: 11, font }));
  }
  return Buffer.from(await doc.save());
}

async function imageOnlyPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.drawRectangle({ x: 50, y: 50, width: 400, height: 600, color: rgb(0.9, 0.9, 0.9) });
  return Buffer.from(await doc.save());
}

describe('inspectSignedUpload', () => {
  test('rejects files that are not PDFs', async () => {
    await assert.rejects(
      inspectSignedUpload(Buffer.from('PK\u0003\u0004 this is a zip'), 'PCA-ABCD2345'),
      InvalidUploadError,
    );
  });

  test('rejects a PDF that cannot be opened', async () => {
    await assert.rejects(
      inspectSignedUpload(Buffer.from('%PDF-1.7\nnot really a pdf'), 'PCA-ABCD2345'),
      InvalidUploadError,
    );
  });

  test('counts pages and finds the reference in a digitally signed copy', async () => {
    const pdf = await textPdf([...FILLER, 'Ref PCA-ABCD2345 - Issued to Jane Tan'], 3);
    const result = await inspectSignedUpload(pdf, 'PCA-ABCD2345');
    assert.equal(result.pageCount, 3);
    assert.equal(result.hasReference, true);
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
  });

  test('reports a missing reference when the text does not contain it', async () => {
    const pdf = await textPdf([...FILLER, 'Ref PCA-OTHER999']);
    const result = await inspectSignedUpload(pdf, 'PCA-ABCD2345');
    assert.equal(result.hasReference, false);
  });

  test('cannot tell for a scan with no text layer', async () => {
    const result = await inspectSignedUpload(await imageOnlyPdf(), 'PCA-ABCD2345');
    assert.equal(result.pageCount, 1);
    assert.equal(result.hasReference, null);
  });

  test('skips the reference check when there is no reference to look for', async () => {
    const result = await inspectSignedUpload(await textPdf(FILLER), null);
    assert.equal(result.hasReference, null);
  });
});
