import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';
import { validate } from '../lib/validation.js';
import {
  suggestAffectedCommunities,
  suggestSocialCrisisTeams,
  generateSOPAndGuidelines,
  generateNPCPersonas,
  generateFactSheet,
  generateFullScenario,
} from '../services/socialCrisisGeneratorService.js';
import { persistSocialCrisisScenario } from '../services/socialCrisisPersistenceService.js';

const router = Router();

router.post(
  '/suggest-communities',
  requireAuth,
  validate(
    z.object({
      body: z.object({
        crisis_type: z.string(),
        context: z.string().optional(),
        country: z.string().default('Singapore'),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { crisis_type, context, country } = req.body;
      const communities = await suggestAffectedCommunities(crisis_type, context || '', country);
      res.json({ data: communities });
    } catch (err) {
      logger.error({ err }, 'Failed to suggest communities');
      res.status(500).json({ error: 'Failed to suggest communities' });
    }
  },
);

router.post(
  '/suggest-teams',
  requireAuth,
  validate(
    z.object({ body: z.object({ crisis_type: z.string(), communities: z.array(z.string()) }) }),
  ),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { crisis_type, communities } = req.body;
      const teams = await suggestSocialCrisisTeams(crisis_type, communities);
      res.json({ data: teams });
    } catch (err) {
      logger.error({ err }, 'Failed to suggest teams');
      res.status(500).json({ error: 'Failed to suggest teams' });
    }
  },
);

router.post(
  '/generate-sop',
  requireAuth,
  validate(
    z.object({
      body: z.object({
        crisis_type: z.string(),
        communities: z.array(z.string()),
        teams: z.array(z.object({ team_name: z.string() })),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { crisis_type, communities, teams } = req.body;
      const sop = await generateSOPAndGuidelines(crisis_type, communities, teams);
      res.json({ data: sop });
    } catch (err) {
      logger.error({ err }, 'Failed to generate SOP');
      res.status(500).json({ error: 'Failed to generate SOP' });
    }
  },
);

router.post(
  '/generate-personas',
  requireAuth,
  validate(
    z.object({
      body: z.object({
        crisis_type: z.string(),
        communities: z.array(z.string()),
        country: z.string().default('Singapore'),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { crisis_type, communities, country } = req.body;
      const personas = await generateNPCPersonas(crisis_type, communities, country);
      res.json({ data: personas });
    } catch (err) {
      logger.error({ err }, 'Failed to generate personas');
      res.status(500).json({ error: 'Failed to generate personas' });
    }
  },
);

router.post(
  '/generate-factsheet',
  requireAuth,
  validate(
    z.object({
      body: z.object({
        crisis_type: z.string(),
        location: z.string(),
        context: z.string().optional(),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { crisis_type, location, context } = req.body;
      const factSheet = await generateFactSheet(crisis_type, location, context || '');
      res.json({ data: factSheet });
    } catch (err) {
      logger.error({ err }, 'Failed to generate fact sheet');
      res.status(500).json({ error: 'Failed to generate fact sheet' });
    }
  },
);

const compileSchema = z.object({
  body: z.object({
    crisis_type: z.string(),
    location: z.string(),
    country: z.string().default('Singapore'),
    context: z.string().optional(),
    communities: z.array(z.string()),
    teams: z.array(
      z.object({
        team_name: z.string(),
        team_description: z.string(),
        min_participants: z.number().default(1),
        max_participants: z.number().default(4),
      }),
    ),
    sop: z.object({
      sop_name: z.string(),
      description: z.string(),
      steps: z.array(z.unknown()),
      response_time_limit_minutes: z.number(),
      content_guidelines: z.unknown(),
    }),
    personas: z.array(z.unknown()),
    fact_sheet: z.object({
      confirmed_facts: z.array(z.string()),
      unconfirmed_claims: z.array(z.unknown()),
    }),
    duration_minutes: z.number().default(60),
    difficulty: z.string().default('intermediate'),
  }),
});

router.post(
  '/compile',
  requireAuth,
  validate(compileSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can compile scenarios' });
      }

      const body = req.body;

      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Transfer-Encoding', 'chunked');

      const writeProgress = (phase: string, message: string) => {
        res.write(JSON.stringify({ type: 'progress', phase, message }) + '\n');
      };

      const payload = await generateFullScenario({
        crisisType: body.crisis_type,
        location: body.location,
        country: body.country,
        context: body.context || '',
        communities: body.communities,
        teams: body.teams,
        sop: body.sop as Parameters<typeof generateFullScenario>[0]['sop'],
        personas: body.personas as Parameters<typeof generateFullScenario>[0]['personas'],
        factSheet: body.fact_sheet as Parameters<typeof generateFullScenario>[0]['factSheet'],
        durationMinutes: body.duration_minutes,
        difficulty: body.difficulty,
        onProgress: writeProgress,
      });

      writeProgress('persisting', 'Saving scenario to database...');

      const scenarioId = await persistSocialCrisisScenario(payload, user.id);

      res.write(
        JSON.stringify({
          type: 'complete',
          scenario_id: scenarioId,
          title: payload.scenario.title,
          inject_count:
            payload.time_injects.length +
            payload.condition_injects.length +
            payload.decision_injects.length,
        }) + '\n',
      );
      res.end();
    } catch (err) {
      logger.error({ err }, 'Social crisis compile failed');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Compilation failed' });
      } else {
        res.write(JSON.stringify({ type: 'error', message: 'Compilation failed' }) + '\n');
        res.end();
      }
    }
  },
);

export { router as socialCrisisWarroomRouter };
