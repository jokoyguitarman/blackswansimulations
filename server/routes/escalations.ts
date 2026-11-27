import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { validate } from '../lib/validation.js';
import { assertSessionOwner } from '../lib/access.js';
import { logger } from '../lib/logger.js';
import { listEscalations, stopEscalation } from '../services/escalation/escalationService.js';

const router = Router();

const listParams = z.object({ params: z.object({ id: z.string().uuid() }) });

router.get('/:id/escalations', requireAuth, validate(listParams), async (req: AuthenticatedRequest, res) => {
  try {
    const access = await assertSessionOwner(req.params.id, req.user!);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    res.json({ data: await listEscalations(req.params.id) });
  } catch (err) {
    logger.error({ err }, 'GET /sessions/:id/escalations failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

const stopParams = z.object({
  params: z.object({ id: z.string().uuid(), chainId: z.string().uuid() }),
});

router.post(
  '/:id/escalations/:chainId/stop',
  requireAuth,
  validate(stopParams),
  async (req: AuthenticatedRequest, res) => {
    try {
      const access = await assertSessionOwner(req.params.id, req.user!);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      const stopped = await stopEscalation({
        sessionId: req.params.id,
        chainId: req.params.chainId,
        trainerId: req.user!.id,
      });
      if (!stopped) return res.status(404).json({ error: 'Chain not found' });
      res.status(204).end();
    } catch (err) {
      logger.error({ err }, 'POST /sessions/:id/escalations/:chainId/stop failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export { router as escalationsRouter };
