import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFParse } from 'pdf-parse';
import {
  CURRENT_AGREEMENT_VERSION,
  agreementInfo,
  fitFontSize,
  loadAgreementTemplate,
  renderAgreement,
  unsupportedCharacters,
} from './template.js';

const input = {
  version: CURRENT_AGREEMENT_VERSION,
  reference: 'PCA-TEST2345',
  issuedAt: new Date('2026-09-23T02:00:00Z'),
  fullName: 'Jane Tan Mei Ling',
  email: 'jane.tan@example.com',
  contactNumber: '+65 9123 4567',
  address: '10 Anson Road, Singapore 079903',
};

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const parser = new PDFParse({ data: bytes.slice() });
  try {
    const { pages } = await parser.getText();
    return pages.map((p) => p.text);
  } finally {
    await parser.destroy();
  }
}

describe('renderAgreement (current committed template)', () => {
  test('keeps every page and prints the reference on each one', async () => {
    const { meta } = await loadAgreementTemplate();
    const rendered = await renderAgreement(input);
    assert.equal(rendered.pageCount, meta.pageCount);

    const pages = await pageTexts(rendered.bytes);
    assert.equal(pages.length, meta.pageCount);
    for (const text of pages) assert.match(text, /PCA-TEST2345/);
  });

  test('fills in the applicant details and leaves no placeholders behind', async () => {
    const pages = await pageTexts((await renderAgreement(input)).bytes);
    const all = pages.join('\n');
    for (const value of [input.fullName, input.email, input.contactNumber, input.address]) {
      assert.ok(all.includes(value), `expected "${value}" in the agreement`);
    }
    assert.doesNotMatch(all, /\[(FULL NAME|EMAIL ADDRESS|CONTACT NUMBER|ADDRESS|DATE)\]/);
  });

  test('the same input renders byte-identical output, different input does not', async () => {
    const first = await renderAgreement(input);
    const again = await renderAgreement(input);
    const other = await renderAgreement({ ...input, contactNumber: '+65 8000 0000' });
    assert.equal(first.sha256, again.sha256);
    assert.notEqual(first.sha256, other.sha256);
  });

  test('describes the fields the current version needs', async () => {
    const { meta } = await loadAgreementTemplate();
    const info = agreementInfo(meta);
    assert.equal(info.version, CURRENT_AGREEMENT_VERSION);
    assert.ok(info.fields.includes('full_name'));
    assert.ok(info.fields.includes('email'));
    assert.equal(new Set(info.fields).size, info.fields.length);
  });
});

describe('fitFontSize', () => {
  const font = { widthOfTextAtSize: (text: string, size: number) => text.length * size * 0.5 };

  test('keeps the preferred size when the text fits', () => {
    assert.equal(fitFontSize(font, 'short', 10.5, 200), 10.5);
  });

  test('shrinks long text until it fits', () => {
    const text = 'x'.repeat(45);
    const size = fitFontSize(font, text, 10.5, 200);
    assert.ok(size < 10.5);
    assert.ok(font.widthOfTextAtSize(text, size) <= 200);
  });

  test('never goes below the minimum', () => {
    assert.equal(fitFontSize(font, 'x'.repeat(500), 10.5, 200), 7);
    assert.equal(fitFontSize(font, 'x'.repeat(500), 7, 200, 5), 5);
  });
});

describe('unsupportedCharacters', () => {
  test('accepts Latin names with diacritics', async () => {
    assert.deepEqual(await unsupportedCharacters('Nguyễn Thị Hương'), []);
    assert.deepEqual(await unsupportedCharacters("Zoë O'Brien-Müller"), []);
  });

  test('flags characters the agreement font cannot draw', async () => {
    assert.deepEqual(await unsupportedCharacters('陈大文'), ['陈', '大', '文']);
  });
});
