import type { Response } from 'express';
import { z } from 'zod';
import { logger } from '../lib/logger.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import {
  cloneScenario,
  scenarioCloneDb,
  type CloneDb,
} from '../services/scenarioClone/cloneScenario.js';

export const cloneScenarioSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    title: z.string().min(1).max(200).optional(),
  }),
});

/** Same card columns the library list returns. */
const CLONE_RESPONSE_COLUMNS =
  'id, title, description, category, difficulty, duration_minutes, objectives, is_active, created_at, country:initial_state->>country';

export async function handleCloneScenario(
  req: AuthenticatedRequest,
  res: Response,
  db: CloneDb = scenarioCloneDb,
): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Missing authorization header' });
      return;
    }
    if (user.role !== 'trainer' && user.role !== 'admin') {
      res.status(403).json({ error: 'Only trainers can clone scenarios' });
      return;
    }

    const requested = typeof req.body?.title === 'string' ? req.body.title : null;
    const result = await cloneScenario(db, {
      scenarioId: req.params.id,
      userId: user.id,
      title: requested,
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const loaded = await db
      .from('scenarios')
      .select(CLONE_RESPONSE_COLUMNS)
      .eq('id', result.id)
      .maybeSingle();
    if (loaded.error) {
      logger.error(
        { error: loaded.error, scenarioId: result.id },
        'Cloned scenario could not be reloaded',
      );
    }

    logger.info(
      {
        originalScenarioId: req.params.id,
        newScenarioId: result.id,
        userId: user.id,
        via: result.via,
      },
      'Scenario cloned successfully',
    );
    res.status(201).json({
      data: loaded.error ? null : loaded.data,
      message: 'Scenario cloned successfully',
    });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /scenarios/:id/clone');
    res.status(500).json({ error: 'Internal server error' });
  }
}
