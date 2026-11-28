import { Router, type RequestHandler, type Response } from 'express';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import { validate, schemas } from '../lib/validation.js';
import { assertScenarioOwner, type AccessResult, type AccessUser } from '../lib/access.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import {
  listAppliedSetupChanges,
  type AppliedSetupChange,
} from '../services/setupEdits/setupEditService.js';

export interface SetupChangeSession {
  scenario_id: string | null;
  created_at: string | null;
}

export interface SessionSetupChangesDeps {
  enabled: () => boolean;
  authMiddleware: RequestHandler;
  loadSession: (sessionId: string) => Promise<SetupChangeSession | null>;
  assertOwner: (scenarioId: string, user: AccessUser) => Promise<AccessResult>;
  listChanges: (
    scenarioId: string,
    createdAt: string,
  ) => Promise<{ available: boolean; changes: AppliedSetupChange[] }>;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function loadSessionRow(sessionId: string): Promise<SetupChangeSession | null> {
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id, created_at')
    .eq('id', sessionId)
    .maybeSingle<{ scenario_id: string | null; created_at: string | null }>();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Applied setup edits newer than the session. Only the scenario owner or an
 * admin may read them. A missing migration or a flag that is off answers an
 * empty list so the lobby notice stays quiet.
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
      const session = await deps.loadSession(req.params.id);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      const scenarioId = textOf(session.scenario_id);
      const createdAt = textOf(session.created_at);
      if (!scenarioId || !createdAt) {
        res.json({ changes: [] });
        return;
      }
      const owner = await deps.assertOwner(scenarioId, user);
      if (!owner.ok) {
        res.status(owner.status).json({ error: owner.error });
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
  loadSession: loadSessionRow,
  assertOwner: assertScenarioOwner,
  listChanges: listAppliedSetupChanges,
});
