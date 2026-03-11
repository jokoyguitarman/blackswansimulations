import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';
import { validate } from '../lib/validation.js';
import {
  generateAndPersistWarroomScenario,
  type WarroomProgressPhase,
} from '../services/warroomService.js';
import { env } from '../env.js';

const router = Router();

function writeProgress(
  res: import('express').Response,
  phase: WarroomProgressPhase,
  message: string,
) {
  res.write(JSON.stringify({ type: 'progress', phase, message }) + '\n');
}

const generateSchema = z.object({
  body: z.object({
    prompt: z.string().max(2000).optional(),
    scenario_type: z
      .enum([
        'open_field_shooting',
        'knife_attack',
        'gas_attack',
        'kidnapping',
        'car_bomb',
        'bombing_mall',
      ])
      .optional(),
    setting: z
      .enum(['beach', 'subway', 'mall', 'resort', 'hotel', 'train', 'open_field'])
      .optional(),
    terrain: z
      .enum(['jungle', 'mountain', 'coastal', 'desert', 'urban', 'rural', 'swamp', 'island'])
      .optional(),
    location: z.string().max(500).optional(),
    complexity_tier: z.enum(['minimal', 'standard', 'full', 'rich']).optional(),
  }),
});

router.post(
  '/generate',
  requireAuth,
  validate(generateSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const { prompt, scenario_type, setting, terrain, location, complexity_tier } = req.body;

      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can use the War Room' });
      }

      if (!env.openAiApiKey) {
        return res.status(500).json({ error: 'OpenAI API key not configured' });
      }

      if (!prompt && !scenario_type) {
        return res
          .status(400)
          .json({ error: 'Provide either prompt or scenario_type (with setting, terrain)' });
      }

      logger.info(
        { userId: user.id, prompt: prompt?.slice(0, 50), scenario_type, setting, terrain },
        'War Room generate requested',
      );

      const { scenarioId } = await generateAndPersistWarroomScenario(
        {
          prompt,
          scenario_type,
          setting,
          terrain,
          location,
          complexity_tier,
        },
        env.openAiApiKey,
        user.id,
      );

      logger.info({ userId: user.id, scenarioId }, 'War Room scenario created');
      res.json({ data: { scenarioId } });
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      logger.error({ error: error.message }, 'Error in POST /warroom/generate');

      const statusCode =
        error.statusCode && error.statusCode >= 400 && error.statusCode < 600
          ? error.statusCode
          : 500;

      res.status(statusCode).json({
        error: error.message || 'Failed to generate scenario',
      });
    }
  },
);

// Streaming generate: same as /generate but streams progress events as NDJSON
// Support both with and without trailing slash for proxy/CDN compatibility
router.post(
  ['/generate-stream', '/generate-stream/'],
  requireAuth,
  validate(generateSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const { prompt, scenario_type, setting, terrain, location, complexity_tier } = req.body;

      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can use the War Room' });
      }

      if (!env.openAiApiKey) {
        return res.status(500).json({ error: 'OpenAI API key not configured' });
      }

      if (!prompt && !scenario_type) {
        return res
          .status(400)
          .json({ error: 'Provide either prompt or scenario_type (with setting, terrain)' });
      }

      logger.info(
        { userId: user.id, prompt: prompt?.slice(0, 50), scenario_type, setting, terrain },
        'War Room generate-stream requested',
      );

      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.flushHeaders?.();

      const onProgress = (phase: WarroomProgressPhase, message: string) => {
        writeProgress(res, phase, message);
        res.flushHeaders?.();
      };

      const { scenarioId } = await generateAndPersistWarroomScenario(
        {
          prompt,
          scenario_type,
          setting,
          terrain,
          location,
          complexity_tier,
        },
        env.openAiApiKey,
        user.id,
        onProgress,
      );

      res.write(JSON.stringify({ type: 'done', data: { scenarioId } }) + '\n');
      logger.info({ userId: user.id, scenarioId }, 'War Room scenario created (stream)');
      res.end();
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      logger.error({ error: error.message }, 'Error in POST /warroom/generate-stream');
      if (!res.headersSent) {
        const statusCode =
          error.statusCode && error.statusCode >= 400 && error.statusCode < 600
            ? error.statusCode
            : 500;
        res.status(statusCode).json({
          error: error.message || 'Failed to generate scenario',
        });
      } else {
        res.write(
          JSON.stringify({
            type: 'error',
            error: error.message || 'Failed to generate scenario',
          }) + '\n',
        );
        res.end();
      }
    }
  },
);

export { router as warroomRouter };
