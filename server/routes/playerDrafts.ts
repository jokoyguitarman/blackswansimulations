import { Router } from 'express';
import { z } from 'zod';
import sanitizeHtml, { type IOptions } from 'sanitize-html';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { validate } from '../lib/validation.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { assertSessionAccess, getCallerTeams, type AccessUser } from '../lib/access.js';
import {
  getCatalogCharter,
  getPlayerTeamContext,
  getPlayerTeamName,
} from '../services/teamCharterService.js';
import { recordPlayerAction } from '../services/sopCheckerService.js';
import { gradePlayerContent } from '../services/contentGraderService.js';

const router = Router();

type DraftStatus = 'draft' | 'in_review' | 'approved' | 'changes_requested';

interface DraftRow {
  id: string;
  session_id: string;
  author_id: string;
  team_name: string | null;
  title: string;
  content_html: string;
  content_text: string;
  status: DraftStatus;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  last_grade: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

const sanitizeOptions: IOptions = {
  allowedTags: ['p', 'br', 'strong', 'em', 'u', 's', 'h1', 'h2', 'ul', 'ol', 'li'],
  allowedAttributes: {
    p: ['style', 'data-doc-style'],
    h1: ['style', 'data-doc-style'],
    h2: ['style', 'data-doc-style'],
    span: ['style'],
  },
  allowedStyles: {
    '*': {
      'text-align': [/^(?:left|right|center|justify)$/],
      'font-size': [/^(?:11|14|18|24)px$/],
    },
  },
  disallowedTagsMode: 'discard',
  allowedSchemes: [],
};

function sanitizeDraftHtml(html: string): string {
  return sanitizeHtml(html, sanitizeOptions);
}

function plainTextFromHtml(html: string): string {
  const withLineBreaks = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|h1|h2|li)>/gi, '\n');
  return sanitizeHtml(withLineBreaks, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replaceAll('\u0000', '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const listDraftsSchema = z.object({
  params: z.object({ sessionId: z.string().uuid() }),
});

const draftIdSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

const createDraftSchema = z.object({
  body: z.object({
    session_id: z.string().uuid(),
    title: z.string().trim().min(1).max(200).optional(),
  }),
});

const updateDraftSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z
    .object({
      title: z.string().trim().min(1).max(200).optional(),
      content_html: z.string().max(250_000).optional(),
    })
    .refine((body) => body.title !== undefined || body.content_html !== undefined, {
      message: 'At least one editable field is required',
    }),
});

const reviewDraftSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    verdict: z.enum(['approve', 'request_changes']),
    note: z.string().trim().max(2000).optional(),
  }),
});

async function loadDraft(id: string): Promise<DraftRow | null> {
  const { data, error } = await supabaseAdmin
    .from('player_drafts')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return null;
  return data as DraftRow;
}

async function enrichDrafts(drafts: DraftRow[]): Promise<Array<Record<string, unknown>>> {
  const profileIds = Array.from(
    new Set(
      drafts.flatMap((draft) =>
        [draft.author_id, draft.reviewed_by].filter((id): id is string => Boolean(id)),
      ),
    ),
  );

  const nameById = new Map<string, string>();
  if (profileIds.length > 0) {
    const { data: profiles } = await supabaseAdmin
      .from('user_profiles')
      .select('id, full_name')
      .in('id', profileIds);
    for (const profile of profiles || []) {
      nameById.set(String(profile.id), String(profile.full_name || 'Unknown'));
    }
  }

  return drafts.map((draft) => ({
    ...draft,
    author_name: nameById.get(draft.author_id) || 'Unknown',
    reviewed_by_name: draft.reviewed_by ? nameById.get(draft.reviewed_by) || 'Unknown' : null,
  }));
}

async function authorizeDraftRead(
  draft: DraftRow,
  user: AccessUser,
): Promise<
  | { ok: true; isSessionOwner: boolean; callerTeams: string[] }
  | { ok: false; status: number; error: string }
> {
  const access = await assertSessionAccess(draft.session_id, user, 'id, trainer_id, scenario_id');
  if (!access.ok) return access;

  const isSessionOwner = user.role === 'admin' || Boolean(access.session?.trainer_id === user.id);
  if (isSessionOwner || draft.author_id === user.id) {
    return { ok: true, isSessionOwner, callerTeams: [] };
  }

  const callerTeams = await getCallerTeams(draft.session_id, user);
  if (draft.team_name && callerTeams.includes(draft.team_name)) {
    return { ok: true, isSessionOwner: false, callerTeams };
  }

  return { ok: false, status: 403, error: 'You do not have access to this document' };
}

async function oneDraftResponse(draft: DraftRow): Promise<Record<string, unknown>> {
  return (await enrichDrafts([draft]))[0];
}

// ─── List visible documents ──────────────────────────────────────────────────

router.get(
  '/session/:sessionId',
  requireAuth,
  validate(listDraftsSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const { sessionId } = req.params;
      const access = await assertSessionAccess(sessionId, user, 'id, trainer_id');
      if (!access.ok) return res.status(access.status).json({ error: access.error });

      const { data, error } = await supabaseAdmin
        .from('player_drafts')
        .select('*')
        .eq('session_id', sessionId)
        .order('updated_at', { ascending: false });

      if (error) {
        logger.error({ error, sessionId }, 'Failed to list player drafts');
        return res.status(500).json({ error: 'Failed to load documents' });
      }

      const allDrafts = (data || []) as DraftRow[];
      const isSessionOwner =
        user.role === 'admin' || Boolean(access.session?.trainer_id === user.id);

      let visible = allDrafts;
      if (!isSessionOwner) {
        const teams = await getCallerTeams(sessionId, user);
        visible = allDrafts.filter(
          (draft) =>
            draft.author_id === user.id ||
            Boolean(draft.team_name && teams.includes(draft.team_name)),
        );
      }

      return res.json({ data: await enrichDrafts(visible) });
    } catch (err) {
      logger.error({ err }, 'Error in GET /drafts/session/:sessionId');
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── Get one document ────────────────────────────────────────────────────────

router.get('/:id', requireAuth, validate(draftIdSchema), async (req: AuthenticatedRequest, res) => {
  try {
    const draft = await loadDraft(req.params.id);
    if (!draft) return res.status(404).json({ error: 'Document not found' });

    const access = await authorizeDraftRead(draft, req.user!);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    return res.json({ data: await oneDraftResponse(draft) });
  } catch (err) {
    logger.error({ err }, 'Error in GET /drafts/:id');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Create ──────────────────────────────────────────────────────────────────

router.post(
  '/',
  requireAuth,
  validate(createDraftSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const { session_id, title } = req.body;
      const access = await assertSessionAccess(session_id, user);
      if (!access.ok) return res.status(access.status).json({ error: access.error });

      const teamName = await getPlayerTeamName(session_id, user.id);
      const { data, error } = await supabaseAdmin
        .from('player_drafts')
        .insert({
          session_id,
          author_id: user.id,
          team_name: teamName,
          title: title || 'Untitled document',
        })
        .select('*')
        .single();

      if (error || !data) {
        logger.error({ error, sessionId: session_id, userId: user.id }, 'Failed to create draft');
        return res.status(500).json({ error: 'Failed to create document' });
      }

      const draft = data as DraftRow;
      await recordPlayerAction(
        session_id,
        user.id,
        'draft_created',
        draft.id,
        null,
        { title: draft.title, team_name: teamName },
        'draft',
      );

      return res.status(201).json({ data: await oneDraftResponse(draft) });
    } catch (err) {
      logger.error({ err }, 'Error in POST /drafts');
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── Autosave / rename (author only) ─────────────────────────────────────────

router.patch(
  '/:id',
  requireAuth,
  validate(updateDraftSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const draft = await loadDraft(req.params.id);
      if (!draft) return res.status(404).json({ error: 'Document not found' });

      const access = await assertSessionAccess(draft.session_id, user);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      if (draft.author_id !== user.id) {
        return res.status(403).json({ error: 'Only the document author can edit it' });
      }

      const updates: Record<string, unknown> = {};
      if (req.body.title !== undefined) updates.title = req.body.title;
      if (req.body.content_html !== undefined) {
        const safeHtml = sanitizeDraftHtml(req.body.content_html);
        updates.content_html = safeHtml;
        updates.content_text = plainTextFromHtml(safeHtml);

        if (draft.status !== 'draft') {
          updates.status = 'draft';
          updates.submitted_at = null;
          updates.reviewed_by = null;
          updates.reviewed_at = null;
          updates.review_note = null;
        }
      }

      const { data, error } = await supabaseAdmin
        .from('player_drafts')
        .update(updates)
        .eq('id', draft.id)
        .eq('author_id', user.id)
        .select('*')
        .single();

      if (error || !data) {
        logger.error({ error, draftId: draft.id }, 'Failed to save draft');
        return res.status(500).json({ error: 'Failed to save document' });
      }

      return res.json({ data: await oneDraftResponse(data as DraftRow) });
    } catch (err) {
      logger.error({ err }, 'Error in PATCH /drafts/:id');
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── Submit for optional review ──────────────────────────────────────────────

router.post(
  '/:id/submit',
  requireAuth,
  validate(draftIdSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const draft = await loadDraft(req.params.id);
      if (!draft) return res.status(404).json({ error: 'Document not found' });

      const access = await assertSessionAccess(draft.session_id, user);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      if (draft.author_id !== user.id) {
        return res.status(403).json({ error: 'Only the author can submit this document' });
      }
      if (!draft.content_text.trim()) {
        return res.status(400).json({ error: 'Write some content before submitting' });
      }
      if (draft.status === 'in_review') {
        return res.status(409).json({ error: 'Document is already in review' });
      }

      const { data, error } = await supabaseAdmin
        .from('player_drafts')
        .update({
          status: 'in_review',
          submitted_at: new Date().toISOString(),
          reviewed_by: null,
          reviewed_at: null,
          review_note: null,
        })
        .eq('id', draft.id)
        .eq('author_id', user.id)
        .select('*')
        .single();

      if (error || !data) {
        return res.status(500).json({ error: 'Failed to submit document' });
      }

      await recordPlayerAction(
        draft.session_id,
        user.id,
        'draft_submitted_for_approval',
        draft.id,
        draft.content_text.slice(0, 200),
        { title: draft.title, team_name: draft.team_name },
        'draft',
      );

      return res.json({ data: await oneDraftResponse(data as DraftRow) });
    } catch (err) {
      logger.error({ err }, 'Error in POST /drafts/:id/submit');
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── Team review ─────────────────────────────────────────────────────────────

router.post(
  '/:id/review',
  requireAuth,
  validate(reviewDraftSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const draft = await loadDraft(req.params.id);
      if (!draft) return res.status(404).json({ error: 'Document not found' });

      const access = await authorizeDraftRead(draft, user);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      if (draft.author_id === user.id) {
        return res.status(403).json({ error: 'Authors cannot review their own document' });
      }
      if (!access.isSessionOwner) {
        if (!draft.team_name || !access.callerTeams.includes(draft.team_name)) {
          return res.status(403).json({ error: 'Only a teammate can review this document' });
        }
      }
      if (draft.status !== 'in_review') {
        return res.status(409).json({ error: 'Document is not currently in review' });
      }

      const approved = req.body.verdict === 'approve';
      const { data, error } = await supabaseAdmin
        .from('player_drafts')
        .update({
          status: approved ? 'approved' : 'changes_requested',
          reviewed_by: user.id,
          reviewed_at: new Date().toISOString(),
          review_note: req.body.note || null,
        })
        .eq('id', draft.id)
        .eq('status', 'in_review')
        .select('*')
        .single();

      if (error || !data) {
        return res.status(500).json({ error: 'Failed to review document' });
      }

      if (approved) {
        await recordPlayerAction(
          draft.session_id,
          user.id,
          'draft_approved',
          draft.id,
          req.body.note || null,
          {
            title: draft.title,
            author_id: draft.author_id,
            document_team: draft.team_name,
          },
          'draft',
        );
      }

      return res.json({ data: await oneDraftResponse(data as DraftRow) });
    } catch (err) {
      logger.error({ err }, 'Error in POST /drafts/:id/review');
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── AI Editor grade ─────────────────────────────────────────────────────────

router.post(
  '/:id/grade',
  requireAuth,
  validate(draftIdSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const draft = await loadDraft(req.params.id);
      if (!draft) return res.status(404).json({ error: 'Document not found' });

      const access = await authorizeDraftRead(draft, user);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      if (!draft.content_text.trim()) {
        return res.status(400).json({ error: 'Write some content before grading' });
      }

      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('scenario_id, start_time')
        .eq('id', draft.session_id)
        .single();
      if (!session?.scenario_id) {
        return res.status(404).json({ error: 'Scenario not found' });
      }

      const { data: scenario } = await supabaseAdmin
        .from('scenarios')
        .select('description, initial_state')
        .eq('id', session.scenario_id)
        .single();

      const initialState = (scenario?.initial_state || {}) as Record<string, unknown>;
      const factSheet = (initialState.fact_sheet || {}) as Record<string, unknown>;
      const confirmedFacts = (factSheet.confirmed_facts || []) as string[];
      const researchTeams = ((initialState.research_guidelines as Record<string, unknown>)
        ?.per_team || []) as Array<{
        guidelines?: Array<{ best_practice: string; source_basis: string }>;
      }>;
      const researchGuidelines = researchTeams.flatMap((team) => team.guidelines || []).slice(0, 5);
      const elapsedMinutes = session.start_time
        ? Math.max(0, Math.floor((Date.now() - new Date(session.start_time).getTime()) / 60_000))
        : undefined;
      // Grade against the team stamped on the document at creation, not the
      // author's current assignment (they may have been reassigned mid-session).
      let gradeTeam:
        | {
            team_name: string;
            mission: string;
            scoring_rubric: string;
            out_of_lane: string[];
          }
        | undefined;
      if (draft.team_name) {
        const { data: teamRow } = await supabaseAdmin
          .from('scenario_teams')
          .select('team_description, charter, scoring_rubric')
          .eq('scenario_id', session.scenario_id)
          .eq('team_name', draft.team_name)
          .maybeSingle();
        const charterJson = (teamRow?.charter || {}) as Record<string, unknown>;
        const catalog = getCatalogCharter(draft.team_name);
        const mission =
          (charterJson.mission as string) || teamRow?.team_description || catalog?.mission || '';
        const scoringRubric = teamRow?.scoring_rubric || catalog?.scoring_rubric || '';
        if (mission || scoringRubric) {
          gradeTeam = {
            team_name: draft.team_name,
            mission,
            scoring_rubric: scoringRubric,
            out_of_lane: (charterJson.out_of_lane as string[]) || catalog?.out_of_lane || [],
          };
        }
      } else {
        const currentTeam = await getPlayerTeamContext(draft.session_id, draft.author_id);
        if (currentTeam?.charter) {
          gradeTeam = {
            team_name: currentTeam.team_name,
            mission: currentTeam.charter.mission,
            scoring_rubric: currentTeam.charter.scoring_rubric,
            out_of_lane: currentTeam.charter.out_of_lane,
          };
        }
      }

      const grade = await gradePlayerContent(draft.content_text, {
        crisis_description: scenario?.description || 'Crisis simulation',
        confirmed_facts: confirmedFacts,
        research_guidelines: researchGuidelines,
        post_format: 'official_statement',
        elapsed_minutes: elapsedMinutes,
        org_name: (initialState.org_name as string) || undefined,
        team_charter: gradeTeam,
      });

      await supabaseAdmin.from('player_drafts').update({ last_grade: grade }).eq('id', draft.id);

      await recordPlayerAction(
        draft.session_id,
        user.id,
        'content_graded',
        draft.id,
        draft.content_text.slice(0, 200),
        {
          title: draft.title,
          author_id: draft.author_id,
          document_team: draft.team_name,
        },
        'draft',
      );

      return res.json({ data: grade });
    } catch (err) {
      logger.error({ err }, 'Error in POST /drafts/:id/grade');
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── Delete ──────────────────────────────────────────────────────────────────

router.delete(
  '/:id',
  requireAuth,
  validate(draftIdSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const draft = await loadDraft(req.params.id);
      if (!draft) return res.status(404).json({ error: 'Document not found' });

      const access = await authorizeDraftRead(draft, user);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      if (draft.author_id !== user.id && !access.isSessionOwner) {
        return res
          .status(403)
          .json({ error: 'Only the author or trainer can delete this document' });
      }

      const { error } = await supabaseAdmin.from('player_drafts').delete().eq('id', draft.id);
      if (error) return res.status(500).json({ error: 'Failed to delete document' });
      return res.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'Error in DELETE /drafts/:id');
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export { router as playerDraftsRouter };
