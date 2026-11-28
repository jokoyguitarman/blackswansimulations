import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import type { Response } from 'express';
import { logger } from '../lib/logger.js';
import { validate } from '../lib/validation.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { hasCredit, isAdmin } from '../services/creditService.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { resolveOrganisations } from '../services/multiOrgPipeline.js';
import { toView } from '../services/warroomBuild/buildCore.js';
import { BuildServiceError } from '../services/warroomBuild/buildErrors.js';
import {
  buildRequestSchema,
  type BuildRequest,
  type BuildRow,
} from '../services/warroomBuild/buildTypes.js';
import type { StartResult } from '../services/warroomBuild/buildStore.js';
import type { BuildView, ReviewPayload } from '../services/warroomBuild/buildTypes.js';
import { env } from '../env.js';
import {
  isDurableSchemaMissing,
  noteDurableBuildsUnavailable,
} from '../services/warroomBuild/schemaError.js';
import { warroomBuildService } from '../services/warroomBuild/runtime.js';

const NO_SCENARIO_CREDITS_BODY = {
  error: 'No scenario credits. Invoice a client from Clients & billing to unlock the War Room.',
  code: 'NO_SCENARIO_CREDITS',
};

const UNAVAILABLE_BODY = {
  error: 'Durable builds unavailable',
  code: 'DURABLE_BUILDS_UNAVAILABLE',
};

export interface DraftRecord {
  id: string;
  created_by: string | null;
}

export interface WarroomBuildApi {
  /**
   * Same idempotency key for a draft returns outcome `replayed` and the original
   * build, even when the request body differs. A new key with the same request
   * hash attaches to the active build.
   */
  start(input: {
    draftId: string;
    userId: string;
    request: BuildRequest;
    idempotencyKey: string;
    replaceActive?: boolean;
  }): Promise<StartResult>;
  get(
    buildId: string,
    after?: number,
  ): Promise<{ build: BuildView; log: unknown[]; next_after: number } | null>;
  getRow(buildId: string): Promise<BuildRow | null>;
  latestForDraft(draftId: string): Promise<BuildRow | null>;
  review(buildId: string): Promise<ReviewPayload>;
  resume(buildId: string): Promise<BuildRow>;
  cancel(buildId: string): Promise<BuildRow | null>;
}

export interface WarroomBuildsRouterDeps {
  enabled: (req?: Request) => boolean;
  authMiddleware: RequestHandler;
  /** Sends 403 or 402 and returns false when the caller may not spend AI. */
  credit: (req: AuthenticatedRequest, res: Response) => Promise<boolean>;
  service: WarroomBuildApi;
  loadDraft: (draftId: string) => Promise<DraftRecord | null>;
  organisationsOk: (
    request: BuildRequest,
  ) => { ok: true } | { ok: false; message: string; code: string; details: unknown };
}

function unavailable(res: Response): void {
  noteDurableBuildsUnavailable();
  res.status(501).json(UNAVAILABLE_BODY);
}

export { isDurableSchemaMissing };

function sendServiceError(res: Response, err: BuildServiceError): void {
  if (err.code === 'BUILD_NOT_FOUND') {
    res.status(404).json({ error: 'Build not found', code: 'BUILD_NOT_FOUND' });
    return;
  }
  if (err.code === 'BUILD_ACTIVE') {
    res.status(409).json({
      error: 'A build is already running for this draft.',
      code: 'BUILD_ACTIVE',
    });
    return;
  }
  if (err.code === 'BUILD_NOT_RESUMABLE') {
    res.status(409).json({ error: err.message, code: 'BUILD_NOT_RESUMABLE' });
    return;
  }
  if (err.code === 'BUILD_NOT_DONE') {
    res.status(409).json({ error: err.message, code: 'BUILD_NOT_DONE' });
    return;
  }
  res.status(500).json({ error: 'Internal Server Error' });
}

function canAccess(user: { id: string; role?: string }, createdBy: string | null): boolean {
  if (isAdmin(user)) return true;
  return createdBy != null && createdBy === user.id;
}

const startSchema = z.object({
  body: z.object({
    draft_id: z.string().uuid(),
    idempotency_key: z.string().uuid(),
    request: buildRequestSchema,
    replace_active: z.boolean().optional().default(false),
  }),
});

const idSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

const pollSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  query: z.object({
    after: z.coerce.number().int().nonnegative().optional(),
  }),
});

const listSchema = z.object({
  query: z.object({ draft_id: z.string().uuid() }),
});

/**
 * Durable build routes. `WARROOM_DURABLE_BUILDS` off, or a missing migration,
 * answers 501 and does not start work. The wizard is unchanged.
 */
export function createWarroomBuildsRouter(deps: WarroomBuildsRouterDeps): Router {
  const router = Router();

  router.use((req, res, next) => {
    if (!deps.enabled(req)) {
      unavailable(res);
      return;
    }
    next();
  });
  router.use(deps.authMiddleware);

  const guard = async (req: AuthenticatedRequest, res: Response): Promise<boolean> => {
    try {
      return await deps.credit(req, res);
    } catch (err) {
      if (isDurableSchemaMissing(err)) {
        unavailable(res);
        return false;
      }
      throw err;
    }
  };

  router.post('/', validate(startSchema), async (req: AuthenticatedRequest, res) => {
    if (!(await guard(req, res))) return;
    const user = req.user!;
    const body = req.body as {
      draft_id: string;
      idempotency_key: string;
      request: BuildRequest;
      replace_active: boolean;
    };
    const orgs = deps.organisationsOk(body.request);
    if (!orgs.ok) {
      res.status(400).json({ error: orgs.message, code: orgs.code, details: orgs.details });
      return;
    }
    try {
      const draft = await deps.loadDraft(body.draft_id);
      if (!draft) {
        res.status(404).json({ error: 'Draft not found' });
        return;
      }
      if (!canAccess(user, draft.created_by)) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }
      // `replayed` means this idempotency key already created the build. The
      // body is not compared again; the client retries the same press.
      const started = await deps.service.start({
        draftId: body.draft_id,
        userId: user.id,
        request: body.request,
        idempotencyKey: body.idempotency_key,
        replaceActive: body.replace_active,
      });
      if (started.outcome === 'limit') {
        res.status(429).json({
          error: 'You already have 2 builds running. Wait for one to finish or cancel it.',
          code: 'BUILD_LIMIT',
        });
        return;
      }
      if (started.outcome === 'conflict') {
        res.status(409).json({
          error: 'A build is already running for this draft.',
          code: 'BUILD_ACTIVE',
          build_id: started.buildId,
        });
        return;
      }
      const view = await deps.service.get(started.buildId!);
      const status = started.outcome === 'created' ? 202 : 200;
      res.status(status).json({ data: { build: view?.build, outcome: started.outcome } });
    } catch (err) {
      if (isDurableSchemaMissing(err)) {
        unavailable(res);
        return;
      }
      if (err instanceof BuildServiceError) {
        sendServiceError(res, err);
        return;
      }
      logger.error({ err }, 'warroom_build_start_failed');
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  router.get('/', validate(listSchema), async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    if (user.role !== 'trainer' && user.role !== 'admin') {
      res.status(403).json({ error: 'Only trainers can use the War Room' });
      return;
    }
    try {
      const draft = await deps.loadDraft(String(req.query.draft_id));
      if (!draft) {
        res.status(404).json({ error: 'Draft not found' });
        return;
      }
      if (!canAccess(user, draft.created_by)) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }
      const row = await deps.service.latestForDraft(draft.id);
      res.json({ data: { build: row ? toView(row) : null } });
    } catch (err) {
      if (isDurableSchemaMissing(err)) {
        unavailable(res);
        return;
      }
      logger.error({ err }, 'warroom_build_list_failed');
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  router.get('/:id/review', validate(idSchema), async (req: AuthenticatedRequest, res) => {
    await withBuild(deps, req, res, async (row) => {
      const review = await deps.service.review(row.id);
      res.json({ data: review });
    });
  });

  router.get('/:id', validate(pollSchema), async (req: AuthenticatedRequest, res) => {
    // §5.2 polls with the trainer role only. A trainer who spent their last
    // credit on something else must still be able to watch a build they started.
    const user = req.user!;
    if (user.role !== 'trainer' && user.role !== 'admin') {
      res.status(403).json({ error: 'Only trainers can use the War Room' });
      return;
    }
    await withBuild(deps, req, res, async (row) => {
      const after = Number(req.query.after ?? 0);
      const polled = await deps.service.get(row.id, after);
      res.json({ data: polled });
    });
  });

  router.post('/:id/resume', validate(idSchema), async (req: AuthenticatedRequest, res) => {
    if (!(await guard(req, res))) return;
    await withBuild(deps, req, res, async (row) => {
      const resumed = await deps.service.resume(row.id);
      res.json({ data: { build: toView(resumed) } });
    });
  });

  router.post('/:id/cancel', validate(idSchema), async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    if (user.role !== 'trainer' && user.role !== 'admin') {
      res.status(403).json({ error: 'Only trainers can use the War Room' });
      return;
    }
    await withBuild(deps, req, res, async (row) => {
      const cancelled = await deps.service.cancel(row.id);
      res.json({
        data: {
          build: cancelled ? toView(cancelled) : toView(row),
        },
      });
    });
  });

  return router;
}

async function withBuild(
  deps: WarroomBuildsRouterDeps,
  req: AuthenticatedRequest,
  res: Response,
  fn: (row: BuildRow) => Promise<void>,
): Promise<void> {
  const user = req.user!;
  try {
    const row = await deps.service.getRow(String(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'Build not found', code: 'BUILD_NOT_FOUND' });
      return;
    }
    if (!canAccess(user, row.created_by)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    await fn(row);
  } catch (err) {
    if (res.headersSent) return;
    if (isDurableSchemaMissing(err)) {
      unavailable(res);
      return;
    }
    if (err instanceof BuildServiceError) {
      sendServiceError(res, err);
      return;
    }
    logger.error({ err }, 'warroom_build_request_failed');
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

export async function loadWizardDraft(draftId: string): Promise<DraftRecord | null> {
  const { data, error } = await supabaseAdmin
    .from('warroom_wizard_drafts')
    .select('id, created_by')
    .eq('id', draftId)
    .maybeSingle();
  if (error) throw error;
  return data
    ? { id: String(data.id), created_by: data.created_by ? String(data.created_by) : null }
    : null;
}

export async function scenarioBuildCredit(
  req: AuthenticatedRequest,
  res: Response,
): Promise<boolean> {
  const user = req.user!;
  if (user.role !== 'trainer' && user.role !== 'admin') {
    res.status(403).json({ error: 'Only trainers can use the War Room' });
    return false;
  }
  if (!isAdmin(user) && !(await hasCredit(user.id, 'scenario'))) {
    res.status(402).json(NO_SCENARIO_CREDITS_BODY);
    return false;
  }
  return true;
}

export function organisationsGate(
  request: BuildRequest,
): ReturnType<WarroomBuildsRouterDeps['organisationsOk']> {
  const result = resolveOrganisations(
    request.organisations,
    request.competitors,
    request.pressure_organisations,
  );
  if (!result)
    return {
      ok: false,
      message: 'Add at least one organisation',
      code: 'ORG_REQUIRED',
      details: [],
    };
  if (!result.ok)
    return { ok: false, message: result.message, code: result.code, details: result.details };
  return { ok: true };
}

/** Mounted router. Tests use the factory with stubs instead of this wiring. */
export const warroomBuildsRouter = createWarroomBuildsRouter({
  enabled: () => env.warroomDurableBuilds,
  authMiddleware: requireAuth,
  credit: scenarioBuildCredit,
  service: warroomBuildService,
  loadDraft: loadWizardDraft,
  organisationsOk: organisationsGate,
});
