import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';

// Note: PDF and Excel generation are placeholder implementations
// To enable exports, install: npm install pdfkit exceljs

/**
 * AAR Export Service
 * Generates PDF and Excel exports for AAR reports
 */

interface AARData {
  aar: {
    id: string;
    session_id: string;
    summary: string;
    key_metrics: Record<string, unknown>;
    key_decisions: Array<Record<string, unknown>>;
    timeline_summary: Array<Record<string, unknown>>;
    ai_insights: Array<Record<string, unknown>>;
    generated_at: string;
  };
  scores: Array<Record<string, unknown>>;
  metrics: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
  session: Record<string, unknown>;
}

/**
 * Generate PDF export for AAR
 * Note: This is a placeholder implementation. In production, use pdfkit or Puppeteer
 */
export async function generatePDF(aarData: AARData): Promise<Buffer> {
  // TODO: Implement PDF generation using pdfkit or Puppeteer
  // For now, return a placeholder
  logger.warn('PDF generation not yet implemented');
  throw new Error(
    'PDF generation not yet implemented. Please use Excel export or implement pdfkit/puppeteer.',
  );
}

/**
 * Generate Excel export for AAR
 * Note: This is a placeholder implementation. In production, use ExcelJS
 */
export async function generateExcel(aarData: AARData): Promise<Buffer> {
  // TODO: Implement Excel generation using ExcelJS
  // For now, return a placeholder
  logger.warn('Excel generation not yet implemented');
  throw new Error('Excel generation not yet implemented. Please install exceljs package.');
}

/**
 * Upload export file to Supabase Storage and return signed URL
 */
export async function uploadExportToStorage(
  fileBuffer: Buffer,
  fileName: string,
  contentType: string,
): Promise<string> {
  try {
    // Upload to Supabase Storage bucket 'aar-exports'
    const { data, error } = await supabaseAdmin.storage
      .from('aar-exports')
      .upload(fileName, fileBuffer, {
        contentType,
        upsert: true,
      });

    if (error) {
      logger.error({ error, fileName }, 'Failed to upload export to storage');
      throw error;
    }

    // Get public URL (or signed URL for private buckets)
    const { data: urlData } = supabaseAdmin.storage.from('aar-exports').getPublicUrl(data.path);

    logger.info({ fileName, path: data.path }, 'Export uploaded to storage');
    return urlData.publicUrl;
  } catch (err) {
    logger.error({ error: err, fileName }, 'Error uploading export to storage');
    throw err;
  }
}

/**
 * Generate signed URL for export file (if bucket is private)
 */
export async function getSignedExportUrl(
  filePath: string,
  expiresIn: number = 3600,
): Promise<string> {
  try {
    const { data, error } = await supabaseAdmin.storage
      .from('aar-exports')
      .createSignedUrl(filePath, expiresIn);

    if (error) {
      logger.error({ error, filePath }, 'Failed to create signed URL for export');
      throw error;
    }

    return data.signedUrl;
  } catch (err) {
    logger.error({ error: err, filePath }, 'Error creating signed URL for export');
    throw err;
  }
}
