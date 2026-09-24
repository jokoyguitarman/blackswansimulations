import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { PDFParse } from 'pdf-parse';

/** Below this many non-space characters the PDF is treated as a scan with no text layer. */
const MIN_TEXT_FOR_REFERENCE_CHECK = 50;

/** The upload is not a usable PDF; the message is safe to show the uploader. */
export class InvalidUploadError extends Error {}

export interface SignedUploadInspection {
  pageCount: number;
  /** Whether the agreement reference appears in the file's text; null when it can't be read. */
  hasReference: boolean | null;
  sha256: string;
}

/**
 * Check a signed agreement upload. Only an unreadable file is rejected: the page count and the
 * reference check are hints for the reviewer, because a scanned printout has no text to search.
 */
export async function inspectSignedUpload(
  buffer: Buffer,
  reference: string | null,
): Promise<SignedUploadInspection> {
  // Readers accept the header anywhere in the first kilobyte, after stray leading bytes.
  if (buffer.subarray(0, 1024).indexOf('%PDF-') === -1) {
    throw new InvalidUploadError('Please upload the signed agreement as a PDF file.');
  }

  let pageCount: number;
  try {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
    pageCount = doc.getPageCount();
  } catch {
    throw new InvalidUploadError(
      "We couldn't open that PDF. Please export or scan it again and upload the new file.",
    );
  }
  if (pageCount < 1) {
    throw new InvalidUploadError('That PDF has no pages. Please upload the signed agreement.');
  }

  return {
    pageCount,
    hasReference: reference ? await containsReference(buffer, reference) : null,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

async function containsReference(buffer: Buffer, reference: string): Promise<boolean | null> {
  // A copy: the parser may transfer the bytes it is given to its worker.
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const { text } = await parser.getText();
    const compact = text.replace(/\s+/g, '').toUpperCase();
    if (compact.length < MIN_TEXT_FOR_REFERENCE_CHECK) return null;
    return compact.includes(reference.replace(/\s+/g, '').toUpperCase());
  } catch {
    return null;
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}
