import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';
import { validate } from '../lib/validation.js';
import { generateScenario } from '../services/aiService.js';
import { env } from '../env.js';

const router = Router();

const generateScenarioSchema = z.object({
  body: z.object({
    category: z.enum([
      'cyber',
      'infrastructure',
      'civil_unrest',
      'natural_disaster',
      'health_emergency',
      'terrorism',
      'custom',
    ]),
    difficulty: z.enum(['beginner', 'intermediate', 'advanced', 'expert']),
    duration_minutes: z.number().int().positive().min(15).max(480),
    context: z.string().max(1000).optional(),
    specific_requirements: z.string().max(1000).optional(),
  }),
});

// Generate scenario with AI (trainers only)
router.post(
  '/scenarios/generate',
  requireAuth,
  validate(generateScenarioSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const { category, difficulty, duration_minutes, context, specific_requirements } = req.body;

      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can generate scenarios with AI' });
      }

      if (!env.openAiApiKey) {
        return res.status(500).json({ error: 'OpenAI API key not configured' });
      }

      logger.info(
        { userId: user.id, category, difficulty, duration_minutes },
        'Generating scenario with AI',
      );

      const generated = await generateScenario(
        {
          category,
          difficulty,
          duration_minutes,
          context,
          specific_requirements,
        },
        env.openAiApiKey,
      );

      logger.info({ userId: user.id }, 'Scenario generated successfully');
      res.json({ data: generated });
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      logger.error(
        { error: error.message, statusCode: error.statusCode },
        'Error in POST /ai/scenarios/generate',
      );

      // Preserve status code from OpenAI API errors (e.g., 429 rate limit)
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

export { router as aiRouter };
