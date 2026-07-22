import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';

/**
 * AAR Export Service
 * Generates PDF and Excel exports for AAR reports
 */

const SECTION_LABELS: Record<string, string> = {
  executive: 'Executive overview',
  decisions: 'Decisions and scoring history',
  matrices: 'Impact matrices',
  injects_published: 'Injects published',
  injects_cancelled: 'Injects cancelled',
  coordination: 'Coordination and communication',
  escalation: 'Escalation factors and pathways',
  incident_response: 'Incident–Response pairs',
  insider_usage: 'Insider information usage',
  team_metrics: 'Team metrics over time',
  resource_requests: 'Resource requests and transfers',
  pathway_outcomes: 'Pathway outcomes',
  information_analysis: 'Information-sharing analysis',
  recommendations: 'Key takeaways and recommendations',
  // Social media crisis report sections
  social_executive: 'Executive summary',
  social_timeline: 'Crisis timeline reconstruction',
  social_public_comms: 'Public communications review',
  social_team_communications: 'Team deep-dive: Communications',
  social_team_procurement: 'Team deep-dive: Procurement',
  social_team_sales: 'Team deep-dive: Sales',
  social_team_legal: 'Team deep-dive: Legal',
  social_information_flow: 'Cross-team information flow',
  social_misinformation: 'Misinformation and moderation',
  social_sentiment: 'Sentiment journey and turning points',
  social_crisis_standards: 'Crisis communication standards',
  social_player_performance: 'Individual player performance',
  social_recommendations: 'Key takeaways and recommendations',
};

// Brand palette used by the social report cover (matches the app theme).
const PDF_COLORS = {
  navy: '#1E3A5F',
  navyStrong: '#102A49',
  amber: '#D97706',
  green: '#15803D',
  red: '#B91C1C',
  track: '#E4DFD4',
  muted: '#64748B',
  ink: '#172033',
};

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
    report_format?: string;
    sections?: Record<string, { data: unknown; analysis: string | null }>;
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

    // Sheets: Section-based AAR (when report_format is sections)
    const sections = aar.report_format === 'sections' ? aar.sections : undefined;
    if (sections && typeof sections === 'object') {
      for (const [key, entry] of Object.entries(sections)) {
        if (!entry) continue;
        const label = SECTION_LABELS[key] ?? key;
        const sheetName = (label.replace(/[\]\\/*?:[\]]/g, '_').replace(/\s+/g, ' ') || key).slice(
          0,
          31,
        );
        const sheet = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
        sheet.getColumn(1).width = 80;
        if (entry.analysis) {
          sheet.addRow([label]);
          sheet.addRow([]);
          sheet.addRow(['Analysis']);
          sheet.addRow([entry.analysis]);
          sheet.addRow([]);
        }
        if (entry.data != null) {
          sheet.addRow(['Data']);
          if (Array.isArray(entry.data)) {
            if (entry.data.length > 0) {
              const first = entry.data[0] as Record<string, unknown>;
              const headers = Object.keys(first);
              sheet.addRow(headers);
              for (const row of entry.data.slice(0, 100)) {
                sheet.addRow(headers.map((h) => cellValue((row as Record<string, unknown>)[h])));
              }
              if (entry.data.length > 100) {
                sheet.addRow([`... and ${entry.data.length - 100} more rows`]);
              }
            }
          } else if (typeof entry.data === 'object') {
            const obj = entry.data as Record<string, unknown>;
            if (obj.questions && Array.isArray(obj.questions)) {
              sheet.addRow(['Questions']);
              const qHeaders = ['question_text', 'category', 'asked_by', 'asked_at'];
              sheet.addRow(qHeaders);
              for (const q of obj.questions as Array<Record<string, unknown>>) {
                sheet.addRow(qHeaders.map((h) => cellValue(q[h])));
              }
            }
            if (obj.gaps && Array.isArray(obj.gaps)) {
              sheet.addRow([]);
              sheet.addRow(['Gaps (incidents with intel but no consultation)']);
              sheet.addRow(['incident_id', 'incident_title', 'decision_id']);
              for (const g of obj.gaps as Array<Record<string, unknown>>) {
                sheet.addRow([
                  cellValue(g.incident_id),
                  cellValue(g.incident_title),
                  cellValue(g.decision_id),
                ]);
              }
            }
            if (!obj.questions && !obj.gaps) {
              sheet.addRow([readableValue(entry.data)]);
            }
          }
        }
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
 * Social report PDF cover: verdict block, final dimension bars and the
 * sentiment trajectory polyline, drawn with pdfkit vector ops. Returns true
 * when a cover was drawn (social sections present) so the caller starts the
 * standard content on a fresh page.
 */
function drawSocialPdfCover(doc: InstanceType<typeof PDFDocument>, aar: AARData['aar']): boolean {
  const sections = aar.report_format === 'sections' ? aar.sections : undefined;
  const exec = sections?.social_executive?.data as Record<string, unknown> | undefined;
  if (!exec) return false;

  const num = (v: unknown): number | null => (typeof v === 'number' && !Number.isNaN(v) ? v : null);
  const left = 50;
  const width = 512;

  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .fillColor(PDF_COLORS.amber)
    .text('SOCIAL MEDIA CRISIS  ·  AFTER-ACTION REPORT', left, 56, {
      width,
      characterSpacing: 1,
    });
  doc
    .fontSize(23)
    .fillColor(PDF_COLORS.navyStrong)
    .text(String(exec.scenario_title || 'After-Action Report'), left, 74, { width });

  const meta: string[] = [`Generated ${new Date(aar.generated_at).toLocaleString()}`];
  if (num(exec.duration_minutes) != null) meta.push(`${exec.duration_minutes} minutes`);
  if (num(exec.participant_count) != null) meta.push(`${exec.participant_count} participants`);
  if (exec.org_name) meta.push(String(exec.org_name));
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(PDF_COLORS.muted)
    .text(meta.join('   ·   '), left, doc.y + 6, { width });

  let y = doc.y + 16;

  // Verdict strip
  const composite = num(exec.overall_composite);
  const counts = (exec.headline_counts || {}) as Record<string, unknown>;
  doc.roundedRect(left, y, width, 54, 6).fill('#F4F1EB');
  if (composite != null) {
    doc
      .font('Helvetica-Bold')
      .fontSize(26)
      .fillColor(PDF_COLORS.navy)
      .text(String(composite), left + 18, y + 13);
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(PDF_COLORS.muted)
      .text('/ 100 final composite', left + 62, y + 26);
  } else {
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor(PDF_COLORS.navy)
      .text('Final report', left + 18, y + 21);
  }
  const rightBits: string[] = [];
  if (num(counts.intel_dependencies) != null && Number(counts.intel_dependencies) > 0) {
    rightBits.push(`Intel shared ${counts.intel_shared}/${counts.intel_dependencies}`);
  }
  rightBits.push(
    `Consequences +${counts.positive_consequences ?? 0} / -${counts.negative_consequences ?? 0}`,
  );
  if (num(counts.graded_player_posts) != null) {
    rightBits.push(`${counts.graded_player_posts} graded posts`);
  }
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(PDF_COLORS.ink)
    .text(rightBits.join('\n'), left + width - 200, y + 10, { width: 190, align: 'right' });
  y += 72;

  // Final outcome dimension bars
  const dimensions = (exec.final_dimensions || []) as Array<Record<string, unknown>>;
  if (dimensions.length > 0) {
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(PDF_COLORS.navy)
      .text('Final outcome dimensions', left, y);
    y += 20;
    for (const dim of dimensions) {
      const value = Math.max(0, Math.min(100, num(dim.value) ?? 0));
      const lowerIsBetter = dim.lower_is_better === true;
      const good = lowerIsBetter ? value < 30 : value > 60;
      const bad = lowerIsBetter ? value > 60 : value < 30;
      const color = good ? PDF_COLORS.green : bad ? PDF_COLORS.red : PDF_COLORS.amber;
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(PDF_COLORS.ink)
        .text(String(dim.label || dim.key || ''), left, y, { width: 175 });
      doc.roundedRect(left + 185, y + 1, 250, 8, 4).fill(PDF_COLORS.track);
      if (value > 0) {
        doc.roundedRect(left + 185, y + 1, Math.max(8, (value / 100) * 250), 8, 4).fill(color);
      }
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(color)
        .text(String(Math.round(value)), left + 448, y, { width: 40, align: 'right' });
      y += 20;
    }
    y += 8;
  }

  // Sentiment trajectory polyline
  const sentimentData = sections?.social_sentiment?.data as Record<string, unknown> | undefined;
  const trajectory = ((sentimentData?.trajectory || []) as Array<Record<string, unknown>>)
    .map((p) => ({ t: num(p.t_plus_min), v: num(p.sentiment_score) }))
    .filter((p): p is { t: number; v: number } => p.t != null && p.v != null);
  if (trajectory.length >= 2) {
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(PDF_COLORS.navy)
      .text('Public sentiment over simulated time', left, y);
    y += 18;

    const chartX = left + 28;
    const chartW = width - 28;
    const chartH = 150;
    const chartY = y;
    const maxT = Math.max(...trajectory.map((p) => p.t), 1);
    const toX = (t: number) => chartX + (t / maxT) * chartW;
    const toY = (v: number) => chartY + chartH - (Math.max(0, Math.min(100, v)) / 100) * chartH;

    // Grid + axis labels
    for (const gridValue of [0, 50, 100]) {
      const gy = toY(gridValue);
      doc
        .moveTo(chartX, gy)
        .lineTo(chartX + chartW, gy)
        .lineWidth(0.5)
        .strokeColor(gridValue === 50 ? '#CFC7B9' : PDF_COLORS.track)
        .stroke();
      doc
        .font('Helvetica')
        .fontSize(7)
        .fillColor(PDF_COLORS.muted)
        .text(String(gridValue), left, gy - 3, { width: 22, align: 'right' });
    }

    // Consequence markers (vertical lines)
    const consequences = ((sentimentData?.consequences || []) as Array<Record<string, unknown>>)
      .map((c) => ({ t: num(c.t_plus_min), positive: c.is_positive === true }))
      .filter((c): c is { t: number; positive: boolean } => c.t != null);
    for (const c of consequences.slice(0, 12)) {
      doc
        .moveTo(toX(c.t), chartY)
        .lineTo(toX(c.t), chartY + chartH)
        .lineWidth(0.75)
        .dash(2, { space: 2 })
        .strokeColor(c.positive ? PDF_COLORS.green : PDF_COLORS.red)
        .stroke()
        .undash();
    }

    // The line itself
    doc.moveTo(toX(trajectory[0].t), toY(trajectory[0].v));
    for (const p of trajectory.slice(1)) doc.lineTo(toX(p.t), toY(p.v));
    doc.lineWidth(1.8).strokeColor(PDF_COLORS.navy).stroke();

    // X labels + legend
    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor(PDF_COLORS.muted)
      .text('T+0', chartX, chartY + chartH + 4)
      .text(`T+${Math.round(maxT)} min`, chartX + chartW - 50, chartY + chartH + 4, {
        width: 50,
        align: 'right',
      });
    doc
      .fontSize(7)
      .fillColor(PDF_COLORS.muted)
      .text(
        'Navy line: sentiment score (0-100). Dashed markers: positive (green) / negative (red) consequence events.',
        left,
        chartY + chartH + 16,
        { width },
      );
  }

  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(PDF_COLORS.muted)
    .text('Full section-by-section analysis follows on the next pages.', left, 742, {
      width,
      align: 'center',
    });
  return true;
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

      // Social crisis reports open with a designed cover (verdict, dimension
      // bars, sentiment chart); the standard content continues on page 2.
      if (drawSocialPdfCover(doc, aar)) {
        doc.addPage();
      }
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
        doc.moveDown(1);
      }

      // Section-based AAR (when report_format is sections)
      const sections = aar.report_format === 'sections' ? aar.sections : undefined;
      if (sections && typeof sections === 'object') {
        for (const [key, entry] of Object.entries(sections)) {
          if (!entry) continue;
          const label = SECTION_LABELS[key] ?? key;
          doc.fontSize(12).text(label, { continued: false });
          doc.moveDown(0.3);
          if (entry.analysis) {
            doc.fontSize(10).text(entry.analysis, { align: 'justify' });
            doc.moveDown(0.5);
          }
          if (entry.data != null) {
            doc.fontSize(9);
            if (Array.isArray(entry.data) && entry.data.length > 0) {
              const first = entry.data[0] as Record<string, unknown>;
              const cols = Object.keys(first);
              const colW = 70;
              let x = 50;
              let rowY = doc.y;
              cols.forEach((c) => {
                doc.text(String(c).slice(0, 12), x, rowY, { width: colW });
                x += colW;
              });
              rowY += 12;
              for (const row of entry.data.slice(0, 15)) {
                x = 50;
                cols.forEach((col) => {
                  doc.text(cellValue((row as Record<string, unknown>)[col]).slice(0, 25), x, rowY, {
                    width: colW,
                  });
                  x += colW;
                });
                rowY += 12;
              }
              doc.y = rowY;
              if (entry.data.length > 15) {
                doc.text(`... and ${entry.data.length - 15} more rows`);
              }
            } else if (typeof entry.data === 'object') {
              const obj = entry.data as Record<string, unknown>;
              if (obj.questions && Array.isArray(obj.questions)) {
                doc.text('Questions:', { continued: false });
                for (const q of (obj.questions as Array<Record<string, unknown>>).slice(0, 10)) {
                  doc.text(`  ${cellValue(q.question_text)} (${cellValue(q.category)})`);
                }
              }
              if (obj.gaps && Array.isArray(obj.gaps)) {
                doc.text('Gaps:', { continued: false });
                for (const g of obj.gaps as Array<Record<string, unknown>>) {
                  doc.text(`  ${cellValue(g.incident_title)}`);
                }
              }
            }
            doc.moveDown(0.5);
          }
          doc.moveDown(1);
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
