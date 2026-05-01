import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';
import { validate } from '../lib/validation.js';
import {
  generateNPCsAndFactSheet,
  suggestSocialCrisisTeams,
  generateAllTeamStorylines,
  generateConvergenceLayer,
  researchBestPractices,
  buildSOPFromResearch,
  assemblePayload,
  type NPCPersona,
  type FactSheet,
  type TeamDef,
  type SocialInject,
  type ResearchGuidelines,
} from '../services/socialCrisisGeneratorService.js';
import { persistSocialCrisisScenario } from '../services/socialCrisisPersistenceService.js';

const router = Router();

// Step 2: Generate NPCs + Fact Sheet + Communities
router.post(
  '/generate-npcs',
  requireAuth,
  validate(
    z.object({
      body: z.object({
        crisis_type: z.string(),
        context: z.string().default(''),
        country: z.string().default('Singapore'),
        location: z.string().default(''),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { crisis_type, context, country, location } = req.body;
      const result = await generateNPCsAndFactSheet(crisis_type, context, country, location);
      res.json({ data: result });
    } catch (err) {
      logger.error({ err }, 'Failed to generate NPCs');
      res.status(500).json({ error: 'Failed to generate NPCs and fact sheet' });
    }
  },
);

// Step 3: Suggest teams (kept for compatibility)
router.post(
  '/suggest-teams',
  requireAuth,
  validate(
    z.object({
      body: z.object({
        crisis_type: z.string(),
        communities: z.array(z.string()),
        context: z.string().default(''),
        country: z.string().default('Singapore'),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { crisis_type, communities, context, country } = req.body;
      const teams = await suggestSocialCrisisTeams(crisis_type, communities, context, country);
      res.json({ data: teams });
    } catch (err) {
      logger.error({ err }, 'Failed to suggest teams');
      res.status(500).json({ error: 'Failed to suggest teams' });
    }
  },
);

// Step 4: Generate per-team storylines (NDJSON streaming)
router.post(
  '/generate-storylines',
  requireAuth,
  validate(
    z.object({
      body: z.object({
        crisis_type: z.string(),
        location: z.string(),
        country: z.string().default('Singapore'),
        context: z.string().default(''),
        duration: z.number().default(60),
        teams: z.array(
          z.object({
            team_name: z.string(),
            team_description: z.string(),
            min_participants: z.number().default(1),
            max_participants: z.number().default(4),
          }),
        ),
        personas: z.array(z.unknown()),
        fact_sheet: z.object({
          confirmed_facts: z.array(z.string()),
          unconfirmed_claims: z.array(z.unknown()),
        }),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { crisis_type, location, country, context, duration, teams, personas, fact_sheet } =
        req.body;

      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Transfer-Encoding', 'chunked');

      const crisisContext = { crisisType: crisis_type, location, country, context, duration };

      const storylines = await generateAllTeamStorylines(
        teams as TeamDef[],
        crisisContext,
        personas as NPCPersona[],
        fact_sheet as FactSheet,
        (teamName: string, injectCount: number) => {
          res.write(
            JSON.stringify({ type: 'team_complete', team: teamName, inject_count: injectCount }) +
              '\n',
          );
        },
      );

      res.write(JSON.stringify({ type: 'complete', storylines }) + '\n');
      res.end();
    } catch (err) {
      logger.error({ err }, 'Failed to generate storylines');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to generate storylines' });
      } else {
        res.write(
          JSON.stringify({ type: 'error', message: 'Failed to generate storylines' }) + '\n',
        );
        res.end();
      }
    }
  },
);

// Step 5: Generate convergence layer
router.post(
  '/generate-convergence',
  requireAuth,
  validate(
    z.object({
      body: z.object({
        crisis_type: z.string(),
        location: z.string(),
        country: z.string().default('Singapore'),
        context: z.string().default(''),
        duration: z.number().default(60),
        team_storylines: z.record(z.string(), z.unknown()),
        personas: z.array(z.unknown()),
        fact_sheet: z.object({
          confirmed_facts: z.array(z.string()),
          unconfirmed_claims: z.array(z.unknown()),
        }),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    try {
      const {
        crisis_type,
        location,
        country,
        context,
        duration,
        team_storylines,
        personas,
        fact_sheet,
      } = req.body;
      const crisisContext = { crisisType: crisis_type, location, country, context, duration };

      const result = await generateConvergenceLayer(
        team_storylines as Record<string, SocialInject[]>,
        personas as NPCPersona[],
        fact_sheet as FactSheet,
        crisisContext,
      );

      res.json({ data: result });
    } catch (err) {
      logger.error({ err }, 'Failed to generate convergence');
      res.status(500).json({ error: 'Failed to generate convergence layer' });
    }
  },
);

// Step 6: Research best practices
router.post(
  '/research',
  requireAuth,
  validate(
    z.object({
      body: z.object({
        crisis_type: z.string(),
        context: z.string().default(''),
        teams: z.array(
          z.object({
            team_name: z.string(),
            team_description: z.string(),
            min_participants: z.number().default(1),
            max_participants: z.number().default(4),
          }),
        ),
        team_storylines: z.record(z.string(), z.unknown()),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    try {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Transfer-Encoding', 'chunked');

      const { crisis_type, context, teams, team_storylines } = req.body;

      const research = await researchBestPractices(
        crisis_type,
        context,
        teams as TeamDef[],
        team_storylines as Record<string, SocialInject[]>,
        (teamName: string) => {
          res.write(JSON.stringify({ type: 'team_research_complete', team: teamName }) + '\n');
        },
      );

      res.write(JSON.stringify({ type: 'complete', research }) + '\n');
      res.end();
    } catch (err) {
      logger.error({ err }, 'Failed to research best practices');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to research best practices' });
      } else {
        res.write(JSON.stringify({ type: 'error', message: 'Research failed' }) + '\n');
        res.end();
      }
    }
  },
);

// Step 7: Compile and persist
router.post(
  '/compile',
  requireAuth,
  validate(
    z.object({
      body: z.object({
        narrative: z.object({ title: z.string(), description: z.string(), briefing: z.string() }),
        teams: z.array(
          z.object({
            team_name: z.string(),
            team_description: z.string(),
            min_participants: z.number().default(1),
            max_participants: z.number().default(4),
          }),
        ),
        objectives: z.array(z.unknown()),
        personas: z.array(z.unknown()),
        fact_sheet: z.object({
          confirmed_facts: z.array(z.string()),
          unconfirmed_claims: z.array(z.unknown()),
        }),
        communities: z.array(z.string()),
        team_storylines: z.record(z.string(), z.unknown()),
        shared_injects: z.array(z.unknown()),
        convergence_gates: z.array(z.unknown()),
        research: z.unknown(),
        duration: z.number().default(60),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can compile scenarios' });
      }

      const body = req.body;
      const sop = buildSOPFromResearch(body.research as ResearchGuidelines);

      const payload = assemblePayload(
        body.narrative,
        body.teams as TeamDef[],
        body.objectives as Array<{
          objective_id: string;
          objective_name: string;
          description: string;
          weight: number;
        }>,
        body.personas as NPCPersona[],
        body.fact_sheet as FactSheet,
        body.communities,
        body.team_storylines as Record<string, SocialInject[]>,
        body.shared_injects as SocialInject[],
        body.convergence_gates as SocialInject[],
        body.research as ResearchGuidelines,
        sop,
        body.duration,
      );

      const scenarioId = await persistSocialCrisisScenario(payload, user.id);

      res.json({
        data: {
          scenario_id: scenarioId,
          title: payload.scenario.title,
          inject_count:
            payload.time_injects.length +
            payload.condition_injects.length +
            payload.decision_injects.length,
        },
      });
    } catch (err) {
      logger.error({ err }, 'Social crisis compile failed');
      res.status(500).json({ error: 'Compilation failed' });
    }
  },
);

// Keep old endpoints for backward compatibility
router.post('/suggest-communities', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { crisis_type, context, country, location } = req.body;
    const result = await generateNPCsAndFactSheet(
      crisis_type || '',
      context || '',
      country || 'Singapore',
      location || '',
    );
    res.json({ data: result.communities });
  } catch (err) {
    logger.error({ err }, 'Failed to suggest communities');
    res.status(500).json({ error: 'Failed' });
  }
});

router.post('/generate-sop', requireAuth, async (_req: AuthenticatedRequest, res) => {
  const sop = buildSOPFromResearch({
    per_team: [],
    group_wide: {
      coordination_guidelines: [],
      escalation_protocols: [],
      timing_benchmarks: {},
      case_studies: [],
    },
  });
  res.json({ data: sop });
});

router.post('/generate-personas', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { crisis_type, context, country, location } = req.body;
    const result = await generateNPCsAndFactSheet(
      crisis_type || '',
      context || '',
      country || 'Singapore',
      location || '',
    );
    res.json({ data: result.personas });
  } catch (err) {
    logger.error({ err }, 'Failed to generate personas');
    res.status(500).json({ error: 'Failed' });
  }
});

router.post('/generate-factsheet', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { crisis_type, context, country, location } = req.body;
    const result = await generateNPCsAndFactSheet(
      crisis_type || '',
      context || '',
      country || 'Singapore',
      location || '',
    );
    res.json({ data: result.factSheet });
  } catch (err) {
    logger.error({ err }, 'Failed to generate factsheet');
    res.status(500).json({ error: 'Failed' });
  }
});

export { router as socialCrisisWarroomRouter };
