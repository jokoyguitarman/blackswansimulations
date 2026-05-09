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
  generateUnifiedStoryline,
  generateStrategyWindows,
  researchBestPractices,
  researchGeneralBestPractices,
  buildSOPFromResearch,
  assemblePayload,
  type NPCPersona,
  type FactSheet,
  type TeamDef,
  type SocialInject,
  type ResearchGuidelines,
} from '../services/socialCrisisGeneratorService.js';
import { persistSocialCrisisScenario } from '../services/socialCrisisPersistenceService.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { getOrResearchTeamDoctrines } from '../services/doctrineCacheService.js';
import { generatePostImage } from '../services/mediaGenerationService.js';

const router = Router();

// In-memory job store for async AI generation tasks
const aiJobs = new Map<
  string,
  {
    status: 'generating' | 'completed' | 'failed';
    data?: unknown;
    error?: string;
    startedAt: number;
  }
>();
setInterval(
  () => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [key, job] of aiJobs) {
      if (job.startedAt < cutoff) aiJobs.delete(key);
    }
  },
  5 * 60 * 1000,
);

// Step 2: Generate NPCs + Fact Sheet + Communities (async)
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
    const { crisis_type, context, country, location } = req.body;
    const jobId = `npc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    aiJobs.set(jobId, { status: 'generating', startedAt: Date.now() });
    res.json({ job_id: jobId, status: 'generating' });

    void (async () => {
      try {
        const result = await generateNPCsAndFactSheet(crisis_type, context, country, location);
        aiJobs.set(jobId, { status: 'completed', data: result, startedAt: Date.now() });
        logger.info({ jobId }, 'NPC generation completed');
      } catch (err) {
        logger.error({ err, jobId }, 'NPC generation failed');
        aiJobs.set(jobId, {
          status: 'failed',
          error: 'Failed to generate NPCs and fact sheet',
          startedAt: Date.now(),
        });
      }
    })();
  },
);

// Poll for any async AI job status
router.get('/job-status/:jobId', requireAuth, async (req: AuthenticatedRequest, res) => {
  const { jobId } = req.params;
  const job = aiJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  if (job.status === 'completed') {
    return res.json({ status: 'completed', data: job.data });
  }
  if (job.status === 'failed') {
    return res.json({ status: 'failed', error: job.error });
  }
  return res.json({ status: 'generating' });
});

// Keep old NPC-specific status path for compatibility
router.get('/generate-npcs/status/:jobId', requireAuth, async (req: AuthenticatedRequest, res) => {
  const { jobId } = req.params;
  const job = aiJobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'completed') return res.json({ status: 'completed', data: job.data });
  if (job.status === 'failed') return res.json({ status: 'failed', error: job.error });
  return res.json({ status: 'generating' });
});

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

// Step 3b: Generate unified storyline (no teams -- NDJSON streaming)
router.post(
  '/generate-storyline',
  requireAuth,
  validate(
    z.object({
      body: z.object({
        crisis_type: z.string(),
        country: z.string().default('Singapore'),
        context: z.string().default(''),
        duration: z.number().default(60),
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
      const { crisis_type, country, context, duration, personas, fact_sheet } = req.body;

      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Transfer-Encoding', 'chunked');

      const crisisContext = { crisisType: crisis_type, country, context, duration };

      const injects = await generateUnifiedStoryline(
        crisisContext,
        personas as NPCPersona[],
        fact_sheet as FactSheet,
        (msg: string) => {
          res.write(JSON.stringify({ type: 'progress', message: msg }) + '\n');
        },
      );

      res.write(JSON.stringify({ type: 'complete', injects }) + '\n');
      res.end();
    } catch (err) {
      logger.error({ err }, 'Failed to generate unified storyline');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to generate storyline' });
      } else {
        res.write(JSON.stringify({ type: 'error', message: 'Storyline generation failed' }) + '\n');
        res.end();
      }
    }
  },
);

// Step 5b: Research general best practices (no teams)
router.post(
  '/research-general',
  requireAuth,
  validate(
    z.object({
      body: z.object({
        crisis_type: z.string(),
        context: z.string().default(''),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    try {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Transfer-Encoding', 'chunked');

      const { crisis_type, context } = req.body;

      const research = await researchGeneralBestPractices(crisis_type, context, (msg: string) => {
        res.write(JSON.stringify({ type: 'progress', message: msg }) + '\n');
      });

      res.write(JSON.stringify({ type: 'complete', research }) + '\n');
      res.end();
    } catch (err) {
      logger.error({ err }, 'Failed to research general best practices');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Research failed' });
      } else {
        res.write(JSON.stringify({ type: 'error', message: 'Research failed' }) + '\n');
        res.end();
      }
    }
  },
);

// Step 4: Generate per-team storylines (NDJSON streaming) -- kept for backward compatibility
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

// Step 5: Generate convergence layer (async)
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
    const jobId = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    aiJobs.set(jobId, { status: 'generating', startedAt: Date.now() });
    res.json({ job_id: jobId, status: 'generating' });

    void (async () => {
      try {
        const crisisContext = { crisisType: crisis_type, location, country, context, duration };
        const result = await generateConvergenceLayer(
          team_storylines as Record<string, SocialInject[]>,
          personas as NPCPersona[],
          fact_sheet as FactSheet,
          crisisContext,
        );
        aiJobs.set(jobId, { status: 'completed', data: result, startedAt: Date.now() });
        logger.info({ jobId }, 'Convergence generation completed');
      } catch (err) {
        logger.error({ err, jobId }, 'Convergence generation failed');
        aiJobs.set(jobId, {
          status: 'failed',
          error: 'Failed to generate convergence layer',
          startedAt: Date.now(),
        });
      }
    })();
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

      const research = await getOrResearchTeamDoctrines(
        teams as TeamDef[],
        crisis_type,
        context,
        team_storylines as Record<string, Array<Record<string, unknown>>>,
        async (ct, cx, ts, sl, onComplete) => {
          return researchBestPractices(
            ct,
            cx,
            ts as TeamDef[],
            sl as unknown as Record<string, SocialInject[]>,
            onComplete,
          );
        },
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
        crisis_type: z.string().optional().default(''),
        teams: z
          .array(
            z.object({
              team_name: z.string(),
              team_description: z.string(),
              min_participants: z.number().default(1),
              max_participants: z.number().default(4),
            }),
          )
          .optional()
          .default([]),
        country: z.string().optional().default('Singapore'),
        objectives: z.array(z.unknown()),
        personas: z.array(z.unknown()),
        fact_sheet: z.object({
          confirmed_facts: z.array(z.string()),
          unconfirmed_claims: z.array(z.unknown()),
        }),
        communities: z.array(z.string()),
        team_storylines: z.record(z.string(), z.unknown()).optional().default({}),
        storyline_injects: z.array(z.unknown()).optional(),
        shared_injects: z.array(z.unknown()),
        convergence_gates: z.array(z.unknown()),
        research: z.unknown(),
        duration: z.number().default(60),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    if (user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Only trainers can compile scenarios' });
    }

    const jobId = `compile_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    aiJobs.set(jobId, { status: 'generating', startedAt: Date.now() });
    res.json({ job_id: jobId, status: 'generating' });

    const body = req.body;

    void (async () => {
      try {
        const sop = buildSOPFromResearch(body.research as ResearchGuidelines);

        let strategyWindows;
        try {
          strategyWindows = await generateStrategyWindows(
            {
              crisisType: body.crisis_type || '',
              location: '',
              country: body.country || 'Singapore',
              context: '',
              duration: body.duration,
            },
            body.personas as NPCPersona[],
            body.fact_sheet as FactSheet,
          );
          logger.info({ windowCount: strategyWindows?.length || 0 }, 'Strategy windows generated');
        } catch (swErr) {
          logger.warn({ swErr }, 'Strategy windows generation failed (non-critical)');
        }

        const payload = assemblePayload(
          body.narrative,
          (body.teams || []) as TeamDef[],
          body.objectives as Array<{
            objective_id: string;
            objective_name: string;
            description: string;
            weight: number;
          }>,
          body.personas as NPCPersona[],
          body.fact_sheet as FactSheet,
          body.communities,
          (body.team_storylines || {}) as Record<string, SocialInject[]>,
          body.shared_injects as SocialInject[],
          body.convergence_gates as SocialInject[],
          body.research as ResearchGuidelines,
          sop,
          body.duration,
          strategyWindows,
          body.storyline_injects as SocialInject[] | undefined,
        );

        if (body.country) {
          (payload.scenario.initial_state as Record<string, unknown>).country = body.country;
        }

        const scenarioId = await persistSocialCrisisScenario(payload, user.id);

        // Pre-generate images in background (doesn't block compile result)
        const personas = body.personas as NPCPersona[];
        void (async () => {
          try {
            const allPrompts: Array<{ handle: string; prompt: string; style: string }> = [];
            for (const p of personas) {
              for (const ip of p.image_prompts || []) {
                if (ip) {
                  const style = p.bias && p.bias !== 'none' ? 'evidence_photo' : 'news_photo';
                  allPrompts.push({ handle: p.handle, prompt: ip, style });
                }
              }
            }
            const limited = allPrompts.slice(0, 10);
            const imagesByHandle = new Map<string, string[]>();
            for (const item of limited) {
              const url = await generatePostImage(
                item.prompt,
                item.style as 'evidence_photo' | 'news_photo' | 'meme',
              );
              if (url) {
                if (!imagesByHandle.has(item.handle)) imagesByHandle.set(item.handle, []);
                imagesByHandle.get(item.handle)!.push(url);
              }
            }
            if (imagesByHandle.size > 0) {
              const { data: injects } = await supabaseAdmin
                .from('scenario_injects')
                .select('id, delivery_config')
                .eq('scenario_id', scenarioId)
                .not('delivery_config', 'is', null);
              for (const inject of injects || []) {
                const dc = (inject.delivery_config || {}) as Record<string, unknown>;
                const handle = String(dc.author_handle || '');
                const urls = imagesByHandle.get(handle);
                if (urls && urls.length > 0) {
                  const imageUrl = urls.shift();
                  if (imageUrl) {
                    dc.media_urls = [imageUrl];
                    await supabaseAdmin
                      .from('scenario_injects')
                      .update({ delivery_config: dc })
                      .eq('id', inject.id);
                  }
                }
              }
            }
          } catch (imgErr) {
            logger.warn({ imgErr, scenarioId }, 'NPC image pre-generation failed (non-critical)');
          }
        })();

        aiJobs.set(jobId, {
          status: 'completed',
          data: {
            scenario_id: scenarioId,
            title: payload.scenario.title,
            inject_count:
              payload.time_injects.length +
              payload.condition_injects.length +
              payload.decision_injects.length,
          },
          startedAt: Date.now(),
        });
        logger.info({ jobId, scenarioId }, 'Compile completed');
      } catch (err) {
        logger.error({ err, jobId }, 'Social crisis compile failed');
        aiJobs.set(jobId, { status: 'failed', error: 'Compilation failed', startedAt: Date.now() });
      }
    })();
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
