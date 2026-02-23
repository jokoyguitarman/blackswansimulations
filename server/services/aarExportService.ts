import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';

/**
 * AAR Export Service
 * Generates PDF and Excel exports for AAR reports
 */

interface AARData {
  aar: {
    id: string;
    session_id: string;
    summary: string;
    key_metrics?: Record<string, unknown>;
    key_decisions?: Array<Record<string, unknown>>;
    timeline_summary?: Array<Record<string, unknown>>;
    ai_insights?: Array<Record<string, unknown>>;
    generated_at: string;
  };
  scores: Array<Record<string, unknown>>;
  metrics: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
  session: Record<string, unknown>;
}

/** Event types to exclude from export (match TimelineFeed.tsx). */
const EXCLUDED_EVENT_TYPES = ['ai_step_start', 'ai_step_end', 'inject_cancelled'];

function getEventType(e: Record<string, unknown>): string {
  return (e.event_type ?? e.type) as string;
}

function cellValue(v: unknown): string {
  if (v == null) return '';
  if (typeof v !== 'object') return String(v);
  const s = JSON.stringify(v);
  return s.length > 500 ? s.slice(0, 497) + '...' : s;
}

/**
 * Human-readable string for key_metrics / metric_value in exports (no raw JSON).
 * Primitives as-is; objects as "key=value; ..." with optional length cap.
 */
function readableValue(v: unknown, maxLen = 400): string {
  if (v == null) return '';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return v.length === 0 ? '—' : `${v.length} items`;
  const entries = Object.entries(v as Record<string, unknown>);
  const parts = entries.map(([k, val]) => {
    if (val == null) return `${k}=`;
    if (typeof val !== 'object') return `${k}=${val}`;
    if (Array.isArray(val)) return `${k}=${val.length} items`;
    return `${k}=[nested]`;
  });
  let s = parts.join('; ');
  if (s.length > maxLen) s = s.slice(0, maxLen - 3) + '...';
  return s;
}

/**
 * Generate Excel export for AAR
 */
export async function generateExcel(aarData: AARData): Promise<Buffer> {
  try {
    const wb = new ExcelJS.Workbook();
    const { aar, scores, metrics, events, decisions } = aarData;
    const filteredEvents = (events ?? []).filter(
      (e) => !EXCLUDED_EVENT_TYPES.includes(getEventType(e as Record<string, unknown>)),
    );

    // Sheet: Summary
    const summarySheet = wb.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 1 }] });
    summarySheet.getColumn(1).width = 80;
    summarySheet.addRow(['After-Action Review']);
    summarySheet.addRow(['Generated', aar.generated_at]);
    summarySheet.addRow([]);
    summarySheet.addRow(['Summary']);
    summarySheet.addRow([aar.summary || '']);

    // Sheet: Key metrics
    if (aar.key_metrics && Object.keys(aar.key_metrics).length > 0) {
      const kmSheet = wb.addWorksheet('Key metrics');
      kmSheet.addRow(['Metric', 'Value']);
      for (const [k, v] of Object.entries(aar.key_metrics)) {
        kmSheet.addRow([k, readableValue(v)]);
      }
    }

    // Sheet: Scores
    if (scores.length > 0) {
      const scoreSheet = wb.addWorksheet('Scores');
      const first = scores[0] as Record<string, unknown>;
      const participant = first.participant as Record<string, unknown> | undefined;
      const headers = participant
        ? ['Participant', 'Role', ...Object.keys(first).filter((k) => k !== 'participant')]
        : Object.keys(first);
      scoreSheet.addRow(headers);
      for (const row of scores) {
        const r = row as Record<string, unknown>;
        const p = r.participant as Record<string, unknown> | undefined;
        const values = p
          ? [
              cellValue(p.full_name ?? p.fullName),
              cellValue(p.role),
              ...Object.keys(r)
                .filter((k) => k !== 'participant')
                .map((k) => cellValue(r[k])),
            ]
          : Object.keys(r).map((k) => cellValue(r[k]));
        scoreSheet.addRow(values);
      }
    }

    // Sheet: Decisions
    if (decisions.length > 0) {
      const decSheet = wb.addWorksheet('Decisions');
      const headers = Object.keys(decisions[0] as Record<string, unknown>);
      decSheet.addRow(headers);
      for (const row of decisions) {
        decSheet.addRow(headers.map((h) => cellValue((row as Record<string, unknown>)[h])));
      }
    }

    // Sheet: Events (filtered; exclude AI step and inject_cancelled)
    if (filteredEvents.length > 0) {
      const evSheet = wb.addWorksheet('Events');
      const headers = Object.keys(filteredEvents[0] as Record<string, unknown>);
      evSheet.addRow(headers);
      for (const row of filteredEvents.slice(0, 500)) {
        evSheet.addRow(headers.map((h) => cellValue((row as Record<string, unknown>)[h])));
      }
      if (filteredEvents.length > 500) {
        evSheet.addRow([`... and ${filteredEvents.length - 500} more events`]);
      }
    }

    // Sheet: Metrics
    if (metrics.length > 0) {
      const metSheet = wb.addWorksheet('Metrics');
      metSheet.addRow(['metric_type', 'metric_name', 'metric_value']);
      for (const m of metrics) {
        const r = m as Record<string, unknown>;
        metSheet.addRow([
          cellValue(r.metric_type),
          cellValue(r.metric_name),
          readableValue(r.metric_value),
        ]);
      }
    }

    const buffer = await wb.xlsx.writeBuffer();
    return Buffer.from(buffer);
  } catch (err) {
    logger.error({ error: err }, 'generateExcel failed');
    throw err;
  }
}

/**
 * Generate PDF export for AAR
 */
export async function generatePDF(aarData: AARData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const chunks: Buffer[] = [];
      const doc = new PDFDocument({ margin: 50 });
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const { aar, scores, metrics, events, decisions } = aarData;
      const filteredEvents = (events ?? []).filter(
        (e) => !EXCLUDED_EVENT_TYPES.includes(getEventType(e as Record<string, unknown>)),
      );

      doc.fontSize(18).text('After-Action Review', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(10).text(`Generated: ${aar.generated_at}`, { align: 'center' });
      doc.moveDown(1);

      doc.fontSize(12).text('Summary', { continued: false });
      doc.fontSize(10).text(aar.summary || 'No summary.', { align: 'justify' });
      doc.moveDown(1);

      if (aar.key_metrics && Object.keys(aar.key_metrics).length > 0) {
        doc.fontSize(12).text('Key metrics', { continued: false });
        doc.moveDown(0.3);
        doc.fontSize(10);
        for (const [k, v] of Object.entries(aar.key_metrics)) {
          doc.text(`${k}: ${readableValue(v)}`);
        }
        doc.moveDown(1);
      }

      if (scores.length > 0) {
        doc.fontSize(12).text('Participant scores', { continued: false });
        doc.moveDown(0.3);
        const cols = ['Participant', 'Role', 'Coordination', 'Leadership', 'Decisions', 'Messages'];
        const colW = 70;
        let x = 50;
        const rowY = doc.y;
        doc.fontSize(9);
        cols.forEach((c) => {
          doc.text(c, x, rowY, { width: colW });
          x += colW;
        });
        doc.y = rowY + 14;
        for (const row of scores) {
          const r = row as Record<string, unknown>;
          const p = r.participant as Record<string, unknown> | undefined;
          const name = p ? cellValue(p.full_name ?? p.fullName) : '';
          const role = p ? cellValue(p.role) : cellValue(r.role);
          x = 50;
          [
            name,
            role,
            r.coordination_score,
            r.leadership_score,
            r.decisions_proposed,
            r.communications_sent,
          ].forEach((v) => {
            doc.text(cellValue(v), x, doc.y, { width: colW });
            x += colW;
          });
          doc.y += 14;
        }
        doc.moveDown(1);
      }

      if (filteredEvents.length > 0) {
        doc.fontSize(12).text('Events', { continued: false });
        doc.moveDown(0.3);
        doc.fontSize(9);
        for (const row of filteredEvents.slice(0, 50)) {
          const r = row as Record<string, unknown>;
          doc.text(
            `${cellValue(r.event_type ?? r.type)}: ${cellValue(r.description ?? r.title ?? JSON.stringify(r))}`,
          );
          doc.moveDown(0.2);
        }
        if (filteredEvents.length > 50) {
          doc.text(`... and ${filteredEvents.length - 50} more events`);
        }
        doc.moveDown(1);
      }

      if (decisions.length > 0) {
        doc.fontSize(12).text('Decisions', { continued: false });
        doc.moveDown(0.3);
        doc.fontSize(9);
        for (const row of decisions.slice(0, 50)) {
          const r = row as Record<string, unknown>;
          doc.text(`${cellValue(r.title)} (${cellValue(r.type)}) - ${cellValue(r.status)}`);
          doc.moveDown(0.2);
        }
        if (decisions.length > 50) {
          doc.text(`... and ${decisions.length - 50} more decisions`);
        }
        doc.moveDown(1);
      }

      if (metrics.length > 0) {
        doc.fontSize(12).text('Metrics', { continued: false });
        doc.moveDown(0.3);
        doc.fontSize(9);
        for (const m of metrics.slice(0, 20)) {
          const r = m as Record<string, unknown>;
          doc.text(
            `${cellValue(r.metric_type)} / ${cellValue(r.metric_name)}: ${readableValue(r.metric_value)}`,
          );
        }
        if (metrics.length > 20) {
          doc.text(`... and ${metrics.length - 20} more metrics`);
        }
      }

      doc.end();
    } catch (err) {
      logger.error({ error: err }, 'generatePDF failed');
      reject(err);
    }
  });
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
