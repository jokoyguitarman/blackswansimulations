import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { validate } from '../lib/validation.js';
import { assertSessionOwner } from '../lib/access.js';
import { logger } from '../lib/logger.js';
import { DEPENDENCY_ID } from '../../shared/teamDependencies.js';
import {
  holdDependency,
  listSessionDependencies,
  sessionMinute,
  waiveDependency,
  type DependencyCommandResult,
  type DependencySession,
} from '../services/dependencies/dependencyService.js';
import { loadTrainerPanel } from '../services/crossTeam/trainerPanelService.js';

const router = Router();

const listParams = z.object({ params: z.object({ id: z.string().uuid() }) });
const depParams = z.object({
  params: z.object({
    id: z.string().uuid(),
    depId: z.string().regex(DEPENDENCY_ID, 'depId must be a dependency id'),
  }),
});

function isStaff(role: string | undefined): boolean {
  return role === 'admin' || role === 'trainer';
}

async function openSession(
  id: string,
  user: { id: string; role?: string },
): Promise<
  { ok: true; session: DependencySession } | { ok: false; status: number; error: string }
> {
  if (!isStaff(user.role)) return { ok: false, status: 403, error: 'Access denied' };
  const access = await assertSessionOwner(id, user, 'id, trainer_id, scenario_id, start_time');
  if (!access.ok) return access;
  const row = access.session as
    { scenario_id?: unknown; start_time?: unknown; trainer_id?: unknown } | undefined;
  if (!row || typeof row.scenario_id !== 'string') {
    return { ok: false, status: 404, error: 'Session not found' };
  }
  return {
    ok: true,
    session: {
      id,
      scenario_id: row.scenario_id,
      trainer_id: typeof row.trainer_id === 'string' ? row.trainer_id : null,
      start_time: typeof row.start_time === 'string' ? row.start_time : null,
    },
  };
}

function commandError(result: Extract<DependencyCommandResult, { ok: false }>): {
  status: number;
  error: string;
} {
  if (result.reason === 'missing') return { status: 404, error: 'Dependency not found' };
  if (result.reason === 'disabled')
    return { status: 409, error: 'Cross-team dependencies are off' };
  return { status: 503, error: 'Dependency states are not available' };
}

router.get(
  '/:id/dependencies/panel',
  requireAuth,
  validate(listParams),
  async (req: AuthenticatedRequest, res) => {
    try {
      const opened = await openSession(req.params.id, req.user!);
      if (!opened.ok) return res.status(opened.status).json({ error: opened.error });
      res.json({ data: await loadTrainerPanel(opened.session) });
    } catch (err) {
      logger.error({ err }, 'GET /sessions/:id/dependencies/panel failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.get(
  '/:id/dependencies',
  requireAuth,
  validate(listParams),
  async (req: AuthenticatedRequest, res) => {
    try {
      const opened = await openSession(req.params.id, req.user!);
      if (!opened.ok) return res.status(opened.status).json({ error: opened.error });
      res.json({ data: await listSessionDependencies(opened.session) });
    } catch (err) {
      logger.error({ err }, 'GET /sessions/:id/dependencies failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.post(
  '/:id/dependencies/:depId/waive',
  requireAuth,
  validate(depParams),
  async (req: AuthenticatedRequest, res) => {
    try {
      const opened = await openSession(req.params.id, req.user!);
      if (!opened.ok) return res.status(opened.status).json({ error: opened.error });
      const result = await waiveDependency(
        opened.session,
        req.params.depId,
        req.user!.id,
        sessionMinute(opened.session.start_time),
      );
      if (!result.ok) {
        const failure = commandError(result);
        return res.status(failure.status).json({ error: failure.error });
      }
      res.json({ data: result.state });
    } catch (err) {
      logger.error({ err }, 'POST /sessions/:id/dependencies/:depId/waive failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.post(
  '/:id/dependencies/:depId/hold',
  requireAuth,
  validate(depParams),
  async (req: AuthenticatedRequest, res) => {
    try {
      const opened = await openSession(req.params.id, req.user!);
      if (!opened.ok) return res.status(opened.status).json({ error: opened.error });
      const result = await holdDependency(
        opened.session,
        req.params.depId,
        sessionMinute(opened.session.start_time),
      );
      if (!result.ok) {
        const failure = commandError(result);
        return res.status(failure.status).json({ error: failure.error });
      }
      res.json({ data: result.state });
    } catch (err) {
      logger.error({ err }, 'POST /sessions/:id/dependencies/:depId/hold failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export { router as dependenciesRouter };
