import { Router, type NextFunction, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { customAlphabet } from 'nanoid';
import { z } from 'zod';
import { requireAdmin, requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { validate } from '../lib/validation.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import {
  isOpenAgreementStatus,
  OPEN_AGREEMENT_STATUSES,
  type AdminAgreementList,
  type AdminAgreementView,
  type AdminTrainerAgreement,
  type MyAgreementResponse,
  type TrainerAgreement,
  type TrainerAgreementPurpose,
  type TrainerAgreementStatus,
} from '../../shared/trainerAgreements.js';
import {
  CURRENT_AGREEMENT_VERSION,
  agreementFileName,
  agreementInfo,
  loadAgreementTemplate,
  renderAgreement,
  unsupportedCharacters,
} from '../services/trainerAgreements/template.js';
import {
  InvalidUploadError,
  inspectSignedUpload,
} from '../services/trainerAgreements/inspectUpload.js';
import {
  canPerform,
  statusAfter,
  statusesAllowing,
  type AgreementAction,
} from '../services/trainerAgreements/status.js';
import {
  PROMOTABLE_ROLES,
  PromotionBlockedError,
  getProfileRole,
  promoteToTrainer,
} from '../services/trainerAgreements/promote.js';
import {
  sendAgreementDecisionEmail,
  sendAgreementReceivedEmail,
  sendAgreementSubmittedNotificationEmail,
} from '../services/emailService.js';

/**
 * Consultant Agreement: trainer applications and signed agreements.
 *
 * A participant applies by saving their details, which issues the agreement pre-filled with them;
 * they upload the signed PDF and an admin decides. Approval is the only self-service route to the
 * trainer role. Trainers who already have access file their agreement through the same endpoints.
 *
 * SECURITY: the table and bucket are service-role only, so every ownership and role check is
 * enforced here. Signed files are served only as short-lived signed URLs on the storage domain.
 */

const router = Router();

const BUCKET = 'trainer-agreements';
const SIGNED_URL_SECONDS = 300;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const DECIDED_LIST_LIMIT = 50;
const newReference = () => `PCA-${customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 8)()}`;

interface AgreementRow {
  id: string;
  user_id: string;
  purpose: TrainerAgreementPurpose;
  status: TrainerAgreementStatus;
  agreement_version: string;
  reference: string;
  full_name: string;
  email: string;
  contact_number: string | null;
  address: string | null;
  organisation: string | null;
  issued_at: string;
  issued_pdf_sha256: string | null;
  signed_file_path: string | null;
  signed_file_sha256: string | null;
  signed_file_pages: number | null;
  signed_file_has_reference: boolean | null;
  submitted_at: string | null;
  attached_by: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  decision_emailed_at: string | null;
  created_at: string;
  updated_at: string;
}

const toApplicantView = (row: AgreementRow): TrainerAgreement => ({
  id: row.id,
  purpose: row.purpose,
  status: row.status,
  agreement_version: row.agreement_version,
  reference: row.reference,
  full_name: row.full_name,
  email: row.email,
  contact_number: row.contact_number,
  address: row.address,
  organisation: row.organisation,
  issued_at: row.issued_at,
  submitted_at: row.submitted_at,
  reviewed_at: row.reviewed_at,
  review_note: row.review_note,
  has_signed_copy: Boolean(row.signed_file_path),
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const table = () => supabaseAdmin.from('trainer_agreements');

async function getRow(id: string): Promise<AgreementRow | null> {
  const { data, error } = await table().select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as AgreementRow | null) ?? null;
}

async function getOpenRow(userId: string): Promise<AgreementRow | null> {
  const { data, error } = await table()
    .select('*')
    .eq('user_id', userId)
    .in('status', [...OPEN_AGREEMENT_STATUSES])
    .maybeSingle();
  if (error) throw error;
  return (data as AgreementRow | null) ?? null;
}

async function getUserRows(userId: string): Promise<AgreementRow[]> {
  const { data, error } = await table()
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data as AgreementRow[] | null) ?? [];
}

const latestApproved = (rows: AgreementRow[]): AgreementRow | null =>
  rows
    .filter((r) => r.status === 'approved')
    .sort((a, b) => (b.reviewed_at ?? '').localeCompare(a.reviewed_at ?? ''))[0] ?? null;

const purposeForRole = (role: string | undefined): TrainerAgreementPurpose | null =>
  role === 'participant' ? 'application' : role === 'trainer' ? 'existing_trainer' : null;

async function signedFileUrl(path: string): Promise<string> {
  const { data, error } = await supabaseAdmin.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_SECONDS);
  if (error || !data?.signedUrl) throw error ?? new Error('No signed URL returned');
  return data.signedUrl;
}

async function removeStoredFile(path: string): Promise<void> {
  const { error } = await supabaseAdmin.storage.from(BUCKET).remove([path]);
  if (error) logger.warn({ error, path }, 'Could not remove a stored agreement file');
}

async function expectedPages(version: string): Promise<number | null> {
  try {
    return (await loadAgreementTemplate(version)).meta.pageCount;
  } catch {
    return null;
  }
}

async function sendAgreementPdf(res: Response, row: AgreementRow, download: boolean) {
  const rendered = await renderAgreement({
    version: row.agreement_version,
    reference: row.reference,
    issuedAt: new Date(row.issued_at),
    fullName: row.full_name,
    email: row.email,
    contactNumber: row.contact_number,
    address: row.address,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `${download ? 'attachment' : 'inline'}; filename="${agreementFileName(row.reference)}"`,
  );
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', String(rendered.bytes.length));
  res.end(Buffer.from(rendered.bytes));
}

const handleError = (err: unknown, res: Response, where: string): void => {
  const error = err as Error;
  logger.error({ error: error?.message, stack: error?.stack }, `Error in ${where}`);
  if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
};

// Keyed by account, so these must run after requireAuth.
const perUserLimit = (max: number, error: string) =>
  rateLimit({
    windowMs: 60 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error },
    keyGenerator: (req) => `user:${(req as AuthenticatedRequest).user?.id ?? 'unknown'}`,
  });
const documentLimiter = perUserLimit(60, 'Too many downloads. Please try again in a little while.');
const uploadLimiter = perUserLimit(10, 'Too many uploads. Please try again in an hour.');

const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
}).single('file');

const singlePdf = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
  uploadPdf(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      res.status(400).json({
        error:
          err.code === 'LIMIT_FILE_SIZE'
            ? 'The file is larger than 10 MB. Please upload a smaller PDF.'
            : 'Please upload a single PDF file.',
      });
      return;
    }
    if (err) {
      next(err);
      return;
    }
    next();
  });
};

// ---------------------------------------------------------------------------
// Public: the agreement version currently issued
// ---------------------------------------------------------------------------

router.get('/current', async (_req, res) => {
  try {
    const { meta } = await loadAgreementTemplate();
    res.json({ data: agreementInfo(meta) });
  } catch (err) {
    handleError(err, res, 'GET /trainer-agreements/current');
  }
});

// ---------------------------------------------------------------------------
// The signed-in user's own agreement
// ---------------------------------------------------------------------------

router.get('/mine', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const [rows, { meta }] = await Promise.all([
      getUserRows(req.user!.id),
      loadAgreementTemplate(),
    ]);
    const current = rows[0] ?? null;
    const onFile = latestApproved(rows);
    const data: MyAgreementResponse = {
      agreement: agreementInfo(meta),
      current: current ? toApplicantView(current) : null,
      onFile: onFile ? toApplicantView(onFile) : null,
    };
    res.json({ data });
  } catch (err) {
    handleError(err, res, 'GET /trainer-agreements/mine');
  }
});

const detailsSchema = z.object({
  body: z.object({
    full_name: z.string().trim().min(2, 'Enter your full legal name').max(120),
    contact_number: z
      .string()
      .trim()
      .min(6, 'Enter a contact number')
      .max(30)
      .regex(/^\+?[\d\s().-]+$/, 'Use digits, spaces and + ( ) - only'),
    address: z.string().trim().max(200).nullish(),
    organisation: z.string().trim().max(200).nullish(),
  }),
});

router.put(
  '/mine',
  requireAuth,
  validate(detailsSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const purpose = purposeForRole(user.role);
      if (!purpose) {
        return res.status(403).json({
          error:
            user.role === 'admin'
              ? 'Admin accounts do not sign the Consultant Agreement.'
              : `This account cannot apply to become a consultant. Please contact ${env.trainerApplicationsNotifyEmail}.`,
        });
      }
      if (!user.email) {
        return res.status(400).json({ error: 'Your account has no email address.' });
      }

      const fullName = req.body.full_name as string;
      const contactNumber = req.body.contact_number as string;
      const address = (req.body.address as string | null | undefined) || null;
      const organisation = (req.body.organisation as string | null | undefined) || null;

      const { meta } = await loadAgreementTemplate();
      if (agreementInfo(meta).fields.includes('address') && !address) {
        return res
          .status(400)
          .json({ error: 'Enter your address. It is printed on the agreement.' });
      }
      const unprintable = await unsupportedCharacters(`${fullName} ${address ?? ''} ${user.email}`);
      if (unprintable.length > 0) {
        return res.status(400).json({
          error: `The agreement cannot print ${unprintable.slice(0, 5).join(' ')}. Please write your name and address in English letters, as they appear on your NRIC or passport.`,
        });
      }

      const rows = await getUserRows(user.id);
      const open = rows.find((r) => isOpenAgreementStatus(r.status)) ?? null;
      if (open && !canPerform('edit_details', open.status)) {
        return res.status(409).json({
          error:
            'Your agreement is with us for review, so your details cannot be changed right now.',
        });
      }
      if (!open && purpose === 'existing_trainer') {
        if (latestApproved(rows)?.agreement_version === CURRENT_AGREEMENT_VERSION) {
          return res.status(409).json({ error: 'Your signed agreement is already on file.' });
        }
      }

      for (let attempt = 0; attempt < 2; attempt++) {
        const issuedAt = new Date();
        const reference = open?.reference ?? newReference();
        const rendered = await renderAgreement({
          version: CURRENT_AGREEMENT_VERSION,
          reference,
          issuedAt,
          fullName,
          email: user.email,
          contactNumber,
          address,
        });
        const issued = {
          full_name: fullName,
          email: user.email,
          contact_number: contactNumber,
          address,
          organisation,
          agreement_version: CURRENT_AGREEMENT_VERSION,
          issued_at: issuedAt.toISOString(),
          issued_pdf_sha256: rendered.sha256,
          updated_at: issuedAt.toISOString(),
        };

        if (open) {
          const { data, error } = await table()
            .update(issued)
            .eq('id', open.id)
            .in('status', statusesAllowing('edit_details'))
            .select('*')
            .maybeSingle();
          if (error) throw error;
          if (!data) {
            return res.status(409).json({
              error:
                'Your agreement changed while you were editing. Reload the page and try again.',
            });
          }
          logger.info({ userId: user.id, agreementId: open.id }, 'Consultant agreement re-issued');
          return res.json({ data: toApplicantView(data as AgreementRow) });
        }

        const { data, error } = await table()
          .insert({ ...issued, user_id: user.id, purpose, reference, status: 'awaiting_signature' })
          .select('*')
          .single();
        if (!error) {
          const row = data as AgreementRow;
          logger.info(
            { userId: user.id, agreementId: row.id, reference, purpose },
            'Consultant agreement issued',
          );
          return res.status(201).json({ data: toApplicantView(row) });
        }
        // 23505 on the reference is a one-in-a-trillion collision: draw again. On the open-row
        // index it means another request started an agreement first.
        if (error.code === '23505' && /reference/.test(error.message) && attempt === 0) continue;
        if (error.code === '23505') {
          return res.status(409).json({
            error: 'You already have an agreement in progress. Reload the page to continue it.',
          });
        }
        throw error;
      }
      throw new Error('Could not draw a unique agreement reference');
    } catch (err) {
      handleError(err, res, 'PUT /trainer-agreements/mine');
    }
  },
);

router.get(
  '/mine/document',
  requireAuth,
  documentLimiter,
  async (req: AuthenticatedRequest, res) => {
    try {
      const rows = (await getUserRows(req.user!.id)).filter((r) => !r.attached_by);
      const row = rows.find((r) => isOpenAgreementStatus(r.status)) ?? latestApproved(rows);
      if (!row) {
        return res.status(404).json({ error: 'No agreement has been issued to you yet.' });
      }
      await sendAgreementPdf(res, row, req.query.download === '1');
    } catch (err) {
      handleError(err, res, 'GET /trainer-agreements/mine/document');
    }
  },
);

router.post(
  '/mine/signed',
  requireAuth,
  uploadLimiter,
  singlePdf,
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: 'Choose the signed agreement PDF to upload.' });
      }

      const open = await getOpenRow(user.id);
      if (!open) {
        return res
          .status(404)
          .json({ error: 'Start your application before uploading a signed agreement.' });
      }
      if (!canPerform('upload', open.status)) {
        return res
          .status(409)
          .json({ error: 'Your signed agreement is already with us for review.' });
      }

      let inspection;
      try {
        inspection = await inspectSignedUpload(file.buffer, open.reference);
      } catch (err) {
        if (err instanceof InvalidUploadError) return res.status(400).json({ error: err.message });
        throw err;
      }

      const path = `${user.id}/${open.id}/signed-${Date.now()}.pdf`;
      const { error: uploadError } = await supabaseAdmin.storage
        .from(BUCKET)
        .upload(path, file.buffer, { contentType: 'application/pdf', upsert: false });
      if (uploadError) {
        logger.error(
          { error: uploadError, agreementId: open.id },
          'Signed agreement upload failed',
        );
        return res
          .status(500)
          .json({ error: 'We could not store your file. Please try again in a moment.' });
      }

      const now = new Date().toISOString();
      const { data, error } = await table()
        .update({
          status: statusAfter('upload'),
          signed_file_path: path,
          signed_file_sha256: inspection.sha256,
          signed_file_pages: inspection.pageCount,
          signed_file_has_reference: inspection.hasReference,
          submitted_at: now,
          updated_at: now,
        })
        .eq('id', open.id)
        .in('status', statusesAllowing('upload'))
        .select('*')
        .maybeSingle();
      if (error || !data) {
        await removeStoredFile(path);
        if (error) throw error;
        return res.status(409).json({
          error: 'Your agreement changed while uploading. Reload the page and try again.',
        });
      }
      if (open.signed_file_path) await removeStoredFile(open.signed_file_path);

      const row = data as AgreementRow;
      logger.info(
        {
          userId: user.id,
          agreementId: row.id,
          reference: row.reference,
          pages: inspection.pageCount,
          hasReference: inspection.hasReference,
        },
        'Signed consultant agreement submitted',
      );
      res.json({ data: toApplicantView(row) });

      // The upload is stored, so email only adds reassurance and a nudge to the team; it runs
      // after responding so a slow mail server never holds the applicant up.
      const pages = await expectedPages(row.agreement_version);
      void Promise.all([
        sendAgreementReceivedEmail({
          to: user.email ?? row.email,
          toName: row.full_name,
          reference: row.reference,
          purpose: row.purpose,
        }),
        sendAgreementSubmittedNotificationEmail({
          reference: row.reference,
          purpose: row.purpose,
          fullName: row.full_name,
          email: row.email,
          contactNumber: row.contact_number,
          organisation: row.organisation,
          address: row.address,
          pageCount: inspection.pageCount,
          expectedPages: pages,
          hasReference: inspection.hasReference,
        }),
      ]).catch((error: unknown) =>
        logger.error({ error, agreementId: row.id }, 'Agreement submission emails failed'),
      );
    } catch (err) {
      handleError(err, res, 'POST /trainer-agreements/mine/signed');
    }
  },
);

router.get('/mine/signed', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const rows = (await getUserRows(req.user!.id)).filter((r) => r.signed_file_path);
    const row = rows.find((r) => isOpenAgreementStatus(r.status)) ?? latestApproved(rows);
    if (!row?.signed_file_path) {
      return res.status(404).json({ error: 'You have not uploaded a signed agreement yet.' });
    }
    res.json({ data: { url: await signedFileUrl(row.signed_file_path) } });
  } catch (err) {
    handleError(err, res, 'GET /trainer-agreements/mine/signed');
  }
});

// ---------------------------------------------------------------------------
// Admin review
// ---------------------------------------------------------------------------

const viewOf = (status: TrainerAgreementStatus): AdminAgreementView =>
  status === 'submitted'
    ? 'review'
    : status === 'awaiting_signature' || status === 'changes_requested'
      ? 'in_progress'
      : 'decided';

const listSchema = z.object({
  query: z.object({ view: z.enum(['review', 'in_progress', 'decided']).default('review') }),
});

router.get(
  '/admin',
  requireAuth,
  requireAdmin,
  validate(listSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const view = req.query.view as AdminAgreementView;
      const { data, error } = await table().select('*');
      if (error) throw error;
      const rows = (data as AgreementRow[] | null) ?? [];

      const counts: Record<AdminAgreementView, number> = { review: 0, in_progress: 0, decided: 0 };
      for (const row of rows) counts[viewOf(row.status)]++;

      const inView = rows.filter((r) => viewOf(r.status) === view);
      if (view === 'review') {
        inView.sort((a, b) => (a.submitted_at ?? '').localeCompare(b.submitted_at ?? ''));
      } else if (view === 'in_progress') {
        inView.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      } else {
        inView.sort((a, b) => (b.reviewed_at ?? '').localeCompare(a.reviewed_at ?? ''));
      }
      const items = view === 'decided' ? inView.slice(0, DECIDED_LIST_LIMIT) : inView;

      const profileIds = [
        ...new Set(items.flatMap((r) => [r.user_id, r.reviewed_by].filter(Boolean) as string[])),
      ];
      const profiles = new Map<string, { role: string | null; name: string | null }>();
      if (profileIds.length > 0) {
        const { data: profileRows, error: profileError } = await supabaseAdmin
          .from('user_profiles')
          .select('id, role, full_name, username')
          .in('id', profileIds);
        if (profileError) throw profileError;
        for (const p of profileRows ?? []) {
          profiles.set(p.id as string, {
            role: (p.role as string | null) ?? null,
            name: ((p.full_name as string | null) || (p.username as string | null)) ?? null,
          });
        }
      }

      const versions = [...new Set(items.map((r) => r.agreement_version))];
      const pagesByVersion = new Map(
        await Promise.all(versions.map(async (v) => [v, await expectedPages(v)] as const)),
      );

      const list: AdminAgreementList = {
        counts,
        items: items.map(
          (row): AdminTrainerAgreement => ({
            ...toApplicantView(row),
            user_id: row.user_id,
            user_role: profiles.get(row.user_id)?.role ?? null,
            signed_file_pages: row.signed_file_pages,
            signed_file_has_reference: row.signed_file_has_reference,
            expected_pages: pagesByVersion.get(row.agreement_version) ?? null,
            was_attached: Boolean(row.attached_by),
            reviewed_by_name: row.reviewed_by
              ? (profiles.get(row.reviewed_by)?.name ?? null)
              : null,
            decision_emailed_at: row.decision_emailed_at,
          }),
        ),
      };
      res.json({ data: list });
    } catch (err) {
      handleError(err, res, 'GET /trainer-agreements/admin');
    }
  },
);

const idSchema = z.object({ params: z.object({ id: z.string().uuid('Invalid ID format') }) });

router.get(
  '/admin/:id/signed',
  requireAuth,
  requireAdmin,
  validate(idSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const row = await getRow(req.params.id);
      if (!row?.signed_file_path) {
        return res
          .status(404)
          .json({ error: 'No signed copy has been uploaded for this agreement.' });
      }
      res.json({ data: { url: await signedFileUrl(row.signed_file_path) } });
    } catch (err) {
      handleError(err, res, 'GET /trainer-agreements/admin/:id/signed');
    }
  },
);

router.get(
  '/admin/:id/document',
  requireAuth,
  requireAdmin,
  validate(idSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const row = await getRow(req.params.id);
      if (!row || row.attached_by) {
        return res
          .status(404)
          .json({ error: 'This agreement was not issued through the platform.' });
      }
      await sendAgreementPdf(res, row, false);
    } catch (err) {
      handleError(err, res, 'GET /trainer-agreements/admin/:id/document');
    }
  },
);

type Decision = Extract<AgreementAction, 'approve' | 'request_changes' | 'reject'>;
const DECISION_EMAIL: Record<Decision, 'approved' | 'changes_requested' | 'rejected'> = {
  approve: 'approved',
  request_changes: 'changes_requested',
  reject: 'rejected',
};

/** Record the decision only if nobody else got there first. Returns the updated row, or null. */
async function claimDecision(
  row: AgreementRow,
  action: Decision,
  adminId: string,
  note: string | null,
): Promise<AgreementRow | null> {
  const now = new Date().toISOString();
  const { data, error } = await table()
    .update({
      status: statusAfter(action),
      reviewed_by: adminId,
      reviewed_at: now,
      review_note: note,
      decision_emailed_at: null,
      updated_at: now,
    })
    .eq('id', row.id)
    .in('status', statusesAllowing(action))
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return (data as AgreementRow | null) ?? null;
}

async function emailDecision(row: AgreementRow, action: Decision): Promise<boolean> {
  const { data: account } = await supabaseAdmin.auth.admin.getUserById(row.user_id);
  const emailed = await sendAgreementDecisionEmail({
    to: account?.user?.email ?? row.email,
    toName: row.full_name,
    reference: row.reference,
    purpose: row.purpose,
    decision: DECISION_EMAIL[action],
    note: row.review_note,
  });
  if (emailed) {
    await table().update({ decision_emailed_at: new Date().toISOString() }).eq('id', row.id);
  }
  return emailed;
}

const optionalNoteSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid ID format') }),
  body: z.object({ note: z.string().trim().max(2000).nullish() }),
});
const requiredNoteSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid ID format') }),
  body: z.object({
    note: z.string().trim().min(1, 'Say what needs to change').max(2000),
  }),
});

const STATUS_WORDS: Record<TrainerAgreementStatus, string> = {
  awaiting_signature: 'still waiting for a signed copy',
  submitted: 'waiting for review',
  changes_requested: 'waiting for the applicant to make changes',
  approved: 'already approved',
  rejected: 'already rejected',
};

function decisionRoute(action: Decision) {
  return async (req: AuthenticatedRequest, res: Response) => {
    try {
      const admin = req.user!;
      const note = (req.body.note as string | null | undefined) || null;
      const row = await getRow(req.params.id);
      if (!row) return res.status(404).json({ error: 'Agreement not found.' });
      if (!canPerform(action, row.status)) {
        return res.status(409).json({ error: `This agreement is ${STATUS_WORDS[row.status]}.` });
      }

      const promoting = action === 'approve' && row.purpose === 'application';
      if (promoting) {
        const role = await getProfileRole(row.user_id);
        if (!PROMOTABLE_ROLES.includes(role as (typeof PROMOTABLE_ROLES)[number])) {
          return res.status(409).json({ error: new PromotionBlockedError(role).message });
        }
      }

      const decided = await claimDecision(row, action, admin.id, note);
      if (!decided) {
        return res.status(409).json({
          error: 'Someone else has already dealt with this agreement. Reload to see the latest.',
        });
      }

      let promoted = false;
      if (promoting) {
        try {
          promoted = (await promoteToTrainer(row.user_id)) === 'promoted';
        } catch (err) {
          // Put the agreement back so the approval can be retried once the account is fixed.
          await table()
            .update({
              status: row.status,
              reviewed_by: row.reviewed_by,
              reviewed_at: row.reviewed_at,
              review_note: row.review_note,
              updated_at: new Date().toISOString(),
            })
            .eq('id', row.id)
            .eq('status', decided.status);
          if (err instanceof PromotionBlockedError) {
            return res.status(409).json({ error: err.message });
          }
          throw err;
        }
      }

      const emailed = await emailDecision(decided, action);
      logger.info(
        { adminId: admin.id, agreementId: row.id, userId: row.user_id, action, promoted, emailed },
        'Consultant agreement decision recorded',
      );
      res.json({ data: { status: decided.status, promoted, emailed } });
    } catch (err) {
      handleError(err, res, `POST /trainer-agreements/admin/:id/${action}`);
    }
  };
}

router.post(
  '/admin/:id/approve',
  requireAuth,
  requireAdmin,
  validate(optionalNoteSchema),
  decisionRoute('approve'),
);
router.post(
  '/admin/:id/request-changes',
  requireAuth,
  requireAdmin,
  validate(requiredNoteSchema),
  decisionRoute('request_changes'),
);
router.post(
  '/admin/:id/reject',
  requireAuth,
  requireAdmin,
  validate(optionalNoteSchema),
  decisionRoute('reject'),
);

const attachSchema = z.object({
  params: z.object({ userId: z.string().uuid('Invalid ID format') }),
});

/** File a copy signed outside the platform (e.g. on paper) for a trainer. */
router.post(
  '/admin/trainers/:userId/attach',
  requireAuth,
  requireAdmin,
  validate(attachSchema),
  singlePdf,
  async (req: AuthenticatedRequest, res) => {
    try {
      const admin = req.user!;
      const { userId } = req.params;
      const file = req.file;
      if (!file)
        return res.status(400).json({ error: 'Choose the signed agreement PDF to attach.' });
      const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 2000) : '';

      const { data: profile, error: profileError } = await supabaseAdmin
        .from('user_profiles')
        .select('id, role, full_name, username, agency_name')
        .eq('id', userId)
        .maybeSingle();
      if (profileError) throw profileError;
      if (!profile) return res.status(404).json({ error: 'Trainer not found.' });
      if (profile.role !== 'trainer') {
        return res
          .status(409)
          .json({ error: 'Signed agreements can only be attached to trainer accounts.' });
      }
      if (await getOpenRow(userId)) {
        return res.status(409).json({
          error: 'This trainer has an agreement in progress. Review it under Pending applications.',
        });
      }

      let inspection;
      try {
        inspection = await inspectSignedUpload(file.buffer, null);
      } catch (err) {
        if (err instanceof InvalidUploadError) return res.status(400).json({ error: err.message });
        throw err;
      }

      const { data: account } = await supabaseAdmin.auth.admin.getUserById(userId);
      const id = randomUUID();
      const path = `${userId}/${id}/signed-${Date.now()}.pdf`;
      const { error: uploadError } = await supabaseAdmin.storage
        .from(BUCKET)
        .upload(path, file.buffer, { contentType: 'application/pdf', upsert: false });
      if (uploadError) {
        logger.error({ error: uploadError, userId }, 'Attaching a signed agreement failed');
        return res.status(500).json({ error: 'Could not store the file. Please try again.' });
      }

      const now = new Date().toISOString();
      const { error: insertError } = await table().insert({
        id,
        user_id: userId,
        purpose: 'existing_trainer',
        status: 'approved',
        agreement_version: CURRENT_AGREEMENT_VERSION,
        reference: newReference(),
        full_name: (profile.full_name as string | null) || (profile.username as string),
        email: account?.user?.email ?? (profile.username as string),
        organisation: (profile.agency_name as string | null) ?? null,
        issued_at: now,
        signed_file_path: path,
        signed_file_sha256: inspection.sha256,
        signed_file_pages: inspection.pageCount,
        signed_file_has_reference: null,
        submitted_at: now,
        attached_by: admin.id,
        reviewed_by: admin.id,
        reviewed_at: now,
        review_note: note || null,
      });
      if (insertError) {
        await removeStoredFile(path);
        throw insertError;
      }

      logger.info(
        { adminId: admin.id, userId, agreementId: id },
        'Signed agreement attached by admin',
      );
      res.status(201).json({ data: { id } });
    } catch (err) {
      handleError(err, res, 'POST /trainer-agreements/admin/trainers/:userId/attach');
    }
  },
);

export { router as trainerAgreementsRouter };
