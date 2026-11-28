import { Router, type RequestHandler, type Response } from 'express';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import { validate, schemas } from '../lib/validation.js';
import { assertSessionAccess, type AccessResult, type AccessUser } from '../lib/access.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import {
  listAppliedSetupChanges,
  type AppliedSetupChange,
} from '../services/setupEdits/setupEditService.js';

export interface SessionSetupChangesDeps {
  enabled: () => boolean;
  authMiddleware: RequestHandler;
  assertAccess: (sessionId: string, user: AccessUser) => Promise<AccessResult>;
  listChanges: (
    scenarioId: string,
    createdAt: string,
  ) => Promise<{ available: boolean; changes: AppliedSetupChange[] }>;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Applied setup edits newer than the session. A missing migration or a flag
 * that is off answers an empty list so the lobby notice stays quiet.
 */
export function createSessionSetupChangesRouter(deps: SessionSetupChangesDeps): Router {
  const router = Router({ mergeParams: true });

  router.get('/:id/setup-changes', deps.authMiddleware, validate(schemas.id), async (req, res: Response) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Missing authorization header' });
        return;
      }
      if (!deps.enabled()) {
        res.json({ changes: [] });
        return;
      }
      const access = await deps.assertAccess(req.params.id, user);
      if (!access.ok) {
        res.status(access.status).json({ error: access.error });
        return;
      }
      const scenarioId = textOf(access.session?.scenario_id);
      const createdAt = textOf(access.session?.created_at);
      if (!scenarioId || !createdAt) {
        res.json({ changes: [] });
        return;
      }
      const listed = await deps.listChanges(scenarioId, createdAt);
      res.json({ changes: listed.available ? listed.changes : [] });
    } catch (err) {
      logger.error({ err }, 'Session setup changes failed');
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  return router;
}

export const sessionSetupChangesRouter = createSessionSetupChangesRouter({
  enabled: () => env.scenarioSetupEdits,
  authMiddleware: requireAuth,
  assertAccess: (sessionId, user) =>
    assertSessionAccess(sessionId, user, 'id, trainer_id, scenario_id, created_at'),
  listChanges: listAppliedSetupChanges,
});
