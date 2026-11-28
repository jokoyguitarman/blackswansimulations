import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import { validate } from '../lib/validation.js';
import { assertScenarioOwner, type AccessResult, type AccessUser } from '../lib/access.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { isAdmin } from '../services/creditService.js';
import { canEditScenario, type EditabilityResult } from '../services/scenarioEditService.js';
import {
  applySetupEdit,
  createApplyDeps,
  type ApplySetupEditRequest,
  type ApplySetupEditResult,
} from '../services/setupEdits/applySetupEdit.js';
import { planOpenSetupEdit, type PlanSetupEditResult } from '../services/setupEdits/planSetupEdit.js';
import type { OrphanResolution } from '../services/setupEdits/remapPlanner.js';
import {
  setupEditService,
  type AttachDraftContext,
  type AttachDraftResult,
} from '../services/setupEdits/setupEditService.js';
import {
  historyForViewer,
  openEditOf,
  remainingEdits,
  type AbandonSetupEditResult,
  type OpenSetupEditResult,
  type SetupEditSnapshot,
  type SetupEditSummary,
} from '../services/setupEdits/setupEditCore.js';

const SOCIAL = 'social_media_crisis';

const scenarioParams = z.object({
  params: z.object({ id: z.string().uuid() }),
});

const abandonParams = z.object({
  params: z.object({
    id: z.string().uuid(),
    editId: z.string().uuid(),
  }),
});

const orphanDecision = z.object({
  choice: z.enum(['keep', 'retire', 'retarget', 'reassign', 'move_to_retired', 'clear', 'remove']),
  inject_key: z.string().optional(),
  team_name: z.string().optional(),
  org_keys: z.array(z.string()).optional(),
});

const applyBody = z.object({
  params: z.object({
    id: z.string().uuid(),
    editId: z.string().uuid(),
  }),
  body: z.object({
    build_id: z.string().uuid(),
    orphan_decisions: z.record(z.string(), orphanDecision).optional(),
    rejected_revisions: z.array(z.string().min(1).max(80)).max(500).optional(),
  }),
});

const planBody = z.object({
  params: z.object({
    id: z.string().uuid(),
    editId: z.string().uuid(),
  }),
  body: z
    .object({
      resolutions: z.record(z.string(), orphanDecision).optional(),
      draft_input: z.unknown().optional(),
    })
    .optional(),
});

export interface SetupEditApi {
  get(scenarioId: string): Promise<SetupEditSnapshot>;
  open(scenarioId: string, user: { id: string; role?: string }): Promise<OpenSetupEditResult>;
  abandon(scenarioId: string, editId: string): Promise<AbandonSetupEditResult>;
  attachOpenedDraft(
    scenarioId: string,
    editId: string,
    ctx: AttachDraftContext,
  ): Promise<AttachDraftResult>;
}

export interface ScenarioSetupEditsDeps {
  enabled: () => boolean;
  limit: () => number;
  authMiddleware: RequestHandler;
  assertOwner: (scenarioId: string, user: AccessUser) => Promise<AccessResult>;
  loadCategory: (scenarioId: string) => Promise<string | null>;
  canEdit: (scenarioId: string, user: { id: string; role?: string }) => Promise<EditabilityResult>;
  service: SetupEditApi;
  apply: (request: ApplySetupEditRequest) => Promise<ApplySetupEditResult>;
  plan: (request: {
    scenarioId: string;
    editId: string;
    resolutions?: Record<string, OrphanResolution>;
    draftInput?: unknown;
  }) => Promise<PlanSetupEditResult>;
}

function unavailable(res: Response): void {
  res.status(404).json({ error: 'Not found', code: 'SETUP_EDITS_UNAVAILABLE' });
}

function locked(res: Response, reason: EditabilityResult['reason']): void {
  res.status(423).json({
    error:
      reason === 'live_session'
        ? 'A session on this scenario is currently live. Editing resumes when it ends.'
        : 'No session launch credits remaining. Editing is locked until credits are topped up.',
    code: 'SCENARIO_LOCKED',
  });
}

function allowanceBody(
  limit: number,
  user: { role?: string },
  snapshot: Extract<SetupEditSnapshot, { available: true; found: true }> | null,
): {
  enabled: boolean;
  limit: number;
  used: number;
  remaining: number | null;
  open_edit: SetupEditSummary | null;
  history: SetupEditSummary[];
} {
  if (!snapshot) {
    return {
      enabled: false,
      limit,
      used: 0,
      remaining: remainingEdits(0, limit, isAdmin(user)),
      open_edit: null,
      history: [],
    };
  }
  const admin = isAdmin(user);
  return {
    enabled: true,
    limit,
    used: snapshot.used,
    remaining: remainingEdits(snapshot.used, limit, admin),
    open_edit: openEditOf(snapshot.edits),
    history: historyForViewer(snapshot.edits, admin),
  };
}

async function loadScenarioCategory(scenarioId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('scenarios')
    .select('category')
    .eq('id', scenarioId)
    .maybeSingle<{ category: string | null }>();
  if (error) {
    logger.error({ error, scenarioId }, 'Failed to load scenario category');
    throw new Error(`Scenario lookup failed: ${error.message}`);
  }
  return data?.category ?? null;
}

/**
 * Setup-edit allowance routes. The flag off answers 404. A missing migration
 * answers a disabled allowance on GET and 404 on writes, without throwing.
 */
export function createScenarioSetupEditsRouter(deps: ScenarioSetupEditsDeps): Router {
  const router = Router({ mergeParams: true });

  router.get('/', deps.authMiddleware, validate(scenarioParams), async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Missing authorization header' });
        return;
      }
      if (user.role !== 'trainer' && user.role !== 'admin') {
        res.status(403).json({ error: 'Only trainers can edit a scenario setup' });
        return;
      }
      if (!deps.enabled()) {
        unavailable(res);
        return;
      }
      const owner = await deps.assertOwner(req.params.id, user);
      if (!owner.ok) {
        res.status(owner.status).json({ error: owner.error });
        return;
      }
      const snapshot = await deps.service.get(req.params.id);
      if (!snapshot.available) {
        res.json(allowanceBody(deps.limit(), user, null));
        return;
      }
      if (!snapshot.found) {
        res.status(404).json({ error: 'Scenario not found' });
        return;
      }
      res.json(allowanceBody(deps.limit(), user, snapshot));
    } catch (err) {
      logger.error({ err }, 'Setup edit allowance failed');
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  router.post('/', deps.authMiddleware, validate(scenarioParams), async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Missing authorization header' });
        return;
      }
      if (user.role !== 'trainer' && user.role !== 'admin') {
        res.status(403).json({ error: 'Only trainers can edit a scenario setup' });
        return;
      }
      if (!deps.enabled()) {
        unavailable(res);
        return;
      }
      const owner = await deps.assertOwner(req.params.id, user);
      if (!owner.ok) {
        res.status(owner.status).json({ error: owner.error });
        return;
      }
      const category = await deps.loadCategory(req.params.id);
      if (category == null) {
        res.status(404).json({ error: 'Scenario not found' });
        return;
      }
      if (category !== SOCIAL) {
        res.status(404).json({
          error: 'Setup edits apply to social-crisis scenarios only.',
          code: 'SETUP_EDIT_UNAVAILABLE',
        });
        return;
      }
      const editability = await deps.canEdit(req.params.id, user);
      if (!editability.editable) {
        locked(res, editability.reason);
        return;
      }
      const opened = await deps.service.open(req.params.id, user);
      if (!opened.available) {
        unavailable(res);
        return;
      }
      if (opened.outcome === 'opened' && opened.editId) {
        const allowance = await deps.service.get(req.params.id);
        const used = allowance.available && allowance.found ? allowance.used : 0;
        let attached: AttachDraftResult;
        try {
          attached = await deps.service.attachOpenedDraft(req.params.id, opened.editId, {
            userId: user.id,
            remaining: remainingEdits(used, deps.limit(), isAdmin(user)),
          });
        } catch (err) {
          await deps.service.abandon(req.params.id, opened.editId).catch(() => undefined);
          throw err;
        }
        if (!attached.available) {
          await deps.service.abandon(req.params.id, opened.editId);
          unavailable(res);
          return;
        }
        if (!attached.ok) {
          await deps.service.abandon(req.params.id, opened.editId);
          if (attached.reason === 'conflict') {
            res.status(409).json({
              error: 'The scenario was saved while the setup edit was opening. Open it again.',
              code: 'SETUP_EDIT_CONFLICT',
            });
            return;
          }
          res.status(attached.reason === 'not_found' ? 404 : 500).json({
            error:
              attached.reason === 'not_found'
                ? 'Scenario not found'
                : 'Could not open the setup draft',
          });
          return;
        }
        res.status(201).json({
          edit_id: opened.editId,
          outcome: 'opened',
          draft_id: attached.draftId,
          baseline_hash: attached.baselineHash,
        });
        return;
      }
      if (opened.outcome === 'existing') {
        const allowance = await deps.service.get(req.params.id);
        const open =
          allowance.available && allowance.found ? openEditOf(allowance.edits) : null;
        res.status(200).json({
          edit_id: opened.editId,
          outcome: 'existing',
          draft_id: open?.draft_id ?? null,
        });
        return;
      }
      if (opened.outcome === 'busy') {
        res.status(409).json({
          error: 'Another setup edit is already in progress for this scenario.',
          code: 'SETUP_EDIT_BUSY',
          edit_id: opened.editId,
        });
        return;
      }
      if (opened.outcome === 'limit_reached') {
        res.status(403).json({
          error: 'All setup edits for this scenario have been used.',
          code: 'SETUP_EDIT_LIMIT',
        });
        return;
      }
      res.status(404).json({ error: 'Scenario not found' });
    } catch (err) {
      logger.error({ err }, 'Setup edit open failed');
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  router.post(
    '/:editId/abandon',
    deps.authMiddleware,
    validate(abandonParams),
    async (req, res) => {
      try {
        const user = (req as AuthenticatedRequest).user;
        if (!user) {
          res.status(401).json({ error: 'Missing authorization header' });
          return;
        }
        if (user.role !== 'trainer' && user.role !== 'admin') {
          res.status(403).json({ error: 'Only trainers can edit a scenario setup' });
          return;
        }
        if (!deps.enabled()) {
          unavailable(res);
          return;
        }
        const owner = await deps.assertOwner(req.params.id, user);
        if (!owner.ok) {
          res.status(owner.status).json({ error: owner.error });
          return;
        }
        const result = await deps.service.abandon(req.params.id, req.params.editId);
        if (!result.available) {
          unavailable(res);
          return;
        }
        if (result.outcome === 'abandoned') {
          res.json({ edit_id: req.params.editId, status: 'abandoned' });
          return;
        }
        if (result.outcome === 'not_found') {
          res.status(404).json({ error: 'Setup edit not found' });
          return;
        }
        res.status(409).json({
          error: 'Only an open setup edit can be abandoned.',
          code: 'SETUP_EDIT_NOT_OPEN',
        });
      } catch (err) {
        logger.error({ err }, 'Setup edit abandon failed');
        res.status(500).json({ error: 'Internal Server Error' });
      }
    },
  );

  router.post('/:editId/plan', deps.authMiddleware, validate(planBody), async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Missing authorization header' });
        return;
      }
      if (user.role !== 'trainer' && user.role !== 'admin') {
        res.status(403).json({ error: 'Only trainers can edit a scenario setup' });
        return;
      }
      if (!deps.enabled()) {
        unavailable(res);
        return;
      }
      const owner = await deps.assertOwner(req.params.id, user);
      if (!owner.ok) {
        res.status(owner.status).json({ error: owner.error });
        return;
      }
      const category = await deps.loadCategory(req.params.id);
      if (category == null) {
        res.status(404).json({ error: 'Scenario not found' });
        return;
      }
      if (category !== SOCIAL) {
        res.status(404).json({
          error: 'Setup edits apply to social-crisis scenarios only.',
          code: 'SETUP_EDIT_UNAVAILABLE',
        });
        return;
      }
      const editability = await deps.canEdit(req.params.id, user);
      if (!editability.editable) {
        locked(res, editability.reason);
        return;
      }
      const body = (req.body ?? {}) as { resolutions?: Record<string, OrphanResolution>; draft_input?: unknown };
      const result = await deps.plan({
        scenarioId: req.params.id,
        editId: req.params.editId,
        resolutions: body.resolutions,
        draftInput: body.draft_input,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error, code: result.code });
        return;
      }
      res.json({ plan: result.plan, targets: result.targets });
    } catch (err) {
      logger.error({ err }, 'Setup edit plan failed');
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  router.post('/:editId/apply', deps.authMiddleware, validate(applyBody), async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Missing authorization header' });
        return;
      }
      if (user.role !== 'trainer' && user.role !== 'admin') {
        res.status(403).json({ error: 'Only trainers can edit a scenario setup' });
        return;
      }
      if (!deps.enabled()) {
        unavailable(res);
        return;
      }
      const owner = await deps.assertOwner(req.params.id, user);
      if (!owner.ok) {
        res.status(owner.status).json({ error: owner.error });
        return;
      }
      const category = await deps.loadCategory(req.params.id);
      if (category == null) {
        res.status(404).json({ error: 'Scenario not found' });
        return;
      }
      if (category !== SOCIAL) {
        res.status(404).json({
          error: 'Setup edits apply to social-crisis scenarios only.',
          code: 'SETUP_EDIT_UNAVAILABLE',
        });
        return;
      }
      const editability = await deps.canEdit(req.params.id, user);
      if (!editability.editable) {
        locked(res, editability.reason);
        return;
      }
      const decisions = (req.body.orphan_decisions ?? {}) as Record<string, OrphanResolution>;
      const result = await deps.apply({
        scenarioId: req.params.id,
        editId: req.params.editId,
        user,
        buildId: req.body.build_id,
        orphanDecisions: decisions,
        rejectedRevisionIds: req.body.rejected_revisions ?? [],
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error, code: result.code });
        return;
      }
      res.json({
        summary: result.summary,
        remaining: result.remaining,
        scheduled_sessions: result.scheduled_sessions,
      });
    } catch (err) {
      logger.error({ err }, 'Setup edit apply failed');
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  return router;
}

export const scenarioSetupEditsRouter = createScenarioSetupEditsRouter({
  enabled: () => env.scenarioSetupEdits,
  limit: () => env.scenarioSetupEditLimit,
  authMiddleware: requireAuth,
  assertOwner: assertScenarioOwner,
  loadCategory: loadScenarioCategory,
  canEdit: canEditScenario,
  service: setupEditService,
  apply: (request) => applySetupEdit(request, createApplyDeps()),
  plan: (request) => planOpenSetupEdit(request),
});
