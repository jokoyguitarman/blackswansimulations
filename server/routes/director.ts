import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { validate } from '../lib/validation.js';
import { assertSessionOwner } from '../lib/access.js';
import { logger } from '../lib/logger.js';
import { replayStoredSession } from '../services/director/directorService.js';

const router = Router();

const replayParams = z.object({ params: z.object({ id: z.string().uuid() }) });

router.get(
  '/:id/director/replay',
  requireAuth,
  validate(replayParams),
  async (req: AuthenticatedRequest, res) => {
    try {
      const access = await assertSessionOwner(req.params.id, req.user!);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      const report = await replayStoredSession(req.params.id);
      res.json({ data: report });
    } catch (err) {
      logger.error({ err }, 'GET /sessions/:id/director/replay failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export { router as directorRouter };
