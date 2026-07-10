import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
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
  generateOrgPageConfig,
  buildSOPFromResearch,
  assemblePayload,
  type NPCPersona,
  type FactSheet,
  type TeamDef,
  type SocialInject,
} from '../services/socialCrisisGeneratorService.js';
import { RESPONSE_STANDARDS } from '../config/responseStandards.js';
import { persistSocialCrisisScenario } from '../services/socialCrisisPersistenceService.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { env } from '../env.js';
import { extractBlueprint } from '../services/blueprint/blueprintExtractionService.js';
import { emptyBlueprint, coerceBlueprint } from '../services/blueprint/blueprintTypes.js';
import { getOrResearchTeamDoctrines } from '../services/doctrineCacheService.js';
import { generatePostImage } from '../services/mediaGenerationService.js';
import { hasCredit, consumeCredit, refundCredit, isAdmin } from '../services/creditService.js';
import type { Response, NextFunction } from 'express';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const router = Router();

/**
 * Credit gate for cost-incurring social-crisis Warroom steps: trainer role
 * required, and non-admins need >= 1 scenario credit to run the AI generator
 * steps. The credit itself is only consumed at /compile. Only admins bypass.
 */
const NO_SCENARIO_CREDITS_BODY = {
  error: 'No scenario credits. Invoice a client from Clients & billing to unlock the War Room.',
  code: 'NO_SCENARIO_CREDITS',
};

const scenarioCreditGate = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const user = req.user!;
  if (user.role !== 'trainer' && user.role !== 'admin') {
    res.status(403).json({ error: 'Only trainers can use the War Room' });
    return;
  }
  if (!isAdmin(user) && !(await hasCredit(user.id, 'scenario'))) {
    res.status(402).json(NO_SCENARIO_CREDITS_BODY);
    return;
  }
  next();
};

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
  scenarioCreditGate,
  validate(
    z.object({
      body: z.object({
        crisis_type: z.string(),
        context: z.string().default(''),
        country: z.string().default('Singapore'),
        location: z.string().default(''),
        org_name: z.string().optional(),
        blueprint: z.unknown().optional(),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    const { crisis_type, context, country, location, org_name, blueprint } = req.body;
    const jobId = `npc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    aiJobs.set(jobId, { status: 'generating', startedAt: Date.now() });
    res.json({ job_id: jobId, status: 'generating' });

    void (async () => {
      try {
        const result = await generateNPCsAndFactSheet(
          crisis_type,
          context,
          country,
          location,
          org_name,
          env.enableDocumentBlueprint && blueprint ? coerceBlueprint(blueprint) : null,
        );
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
  scenarioCreditGate,
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
  scenarioCreditGate,
  validate(
    z.object({
      body: z.object({
        crisis_type: z.string(),
        country: z.string().default('Singapore'),
        context: z.string().default(''),
        org_name: z.string().optional(),
        duration: z.number().default(60),
        personas: z.array(z.unknown()),
        fact_sheet: z.object({
          confirmed_facts: z.array(z.string()),
          unconfirmed_claims: z.array(z.unknown()),
        }),
        blueprint: z.unknown().optional(),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { crisis_type, country, context, duration, personas, fact_sheet, org_name, blueprint } =
        req.body;

      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Transfer-Encoding', 'chunked');

      const crisisContext = {
        crisisType: crisis_type,
        country,
        context,
        duration,
        orgName: org_name,
      };

      const injects = await generateUnifiedStoryline(
        crisisContext,
        personas as NPCPersona[],
        fact_sheet as FactSheet,
        (msg: string) => {
          res.write(JSON.stringify({ type: 'progress', message: msg }) + '\n');
        },
        env.enableDocumentBlueprint && blueprint ? coerceBlueprint(blueprint) : null,
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

// Step 4: Generate per-team storylines (NDJSON streaming) -- kept for backward compatibility
router.post(
  '/generate-storylines',
  requireAuth,
  scenarioCreditGate,
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
  scenarioCreditGate,
  validate(
    z.object({
      body: z.object({
        crisis_type: z.string(),
        location: z.string(),
        country: z.string().default('Singapore'),
        context: z.string().default(''),
        org_name: z.string().optional(),
        duration: z.number().default(60),
        team_storylines: z.record(z.string(), z.unknown()),
        personas: z.array(z.unknown()),
        fact_sheet: z.object({
          confirmed_facts: z.array(z.string()),
          unconfirmed_claims: z.array(z.unknown()),
        }),
        blueprint: z.unknown().optional(),
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
      blueprint,
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
          env.enableDocumentBlueprint && blueprint ? coerceBlueprint(blueprint) : null,
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
  scenarioCreditGate,
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
        org_name: z.string().optional(),
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
        dimension_labels: z
          .object({
            public_trust: z.string(),
            community_safety: z.string(),
            narrative_control: z.string(),
            escalation_risk: z.string(),
          })
          .optional(),
        org_page: z.unknown().optional(),
        duration: z.number().default(60),
        blueprint: z.unknown().optional(),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    if (user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Only trainers can compile scenarios' });
    }

    // The compile consumes the scenario credit. Consume up-front (race-safe)
    // before starting the async job; refund if compilation fails.
    let creditInvoiceId: string | null = null;
    let creditLedgerId: string | null = null;
    if (!isAdmin(user)) {
      const consume = await consumeCredit(user.id, 'scenario', 'scenario_generated');
      if (!consume.ok) {
        return res.status(402).json(NO_SCENARIO_CREDITS_BODY);
      }
      creditInvoiceId = consume.fundingInvoiceId ?? null;
      creditLedgerId = consume.ledgerId ?? null;
    }

    const jobId = `compile_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    aiJobs.set(jobId, { status: 'generating', startedAt: Date.now() });
    res.json({ job_id: jobId, status: 'generating' });

    const body = req.body;

    void (async () => {
      try {
        const sop = buildSOPFromResearch(RESPONSE_STANDARDS);

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
          RESPONSE_STANDARDS,
          sop,
          body.duration,
          strategyWindows,
          body.storyline_injects as SocialInject[] | undefined,
          body.dimension_labels || null,
          (body.org_page as
            | import('../services/socialCrisisGeneratorService.js').OrgPageConfig
            | undefined) || null,
          body.org_name || undefined,
          env.enableDocumentBlueprint && body.blueprint ? coerceBlueprint(body.blueprint) : null,
        );

        if (body.country) {
          (payload.scenario.initial_state as Record<string, unknown>).country = body.country;
        }

        const scenarioId = await persistSocialCrisisScenario(payload, user.id);

        // Backfill the scenario id onto the credit spend row for auditing.
        if (creditLedgerId) {
          await supabaseAdmin
            .from('credit_ledger')
            .update({ scenario_id: scenarioId })
            .eq('id', creditLedgerId);
        }

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
        if (creditLedgerId) {
          await refundCredit(user.id, 'scenario', creditInvoiceId);
        }
        aiJobs.set(jobId, { status: 'failed', error: 'Compilation failed', startedAt: Date.now() });
      }
    })();
  },
);

// Keep old endpoints for backward compatibility
router.post(
  '/suggest-communities',
  requireAuth,
  scenarioCreditGate,
  async (req: AuthenticatedRequest, res) => {
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
  },
);

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

router.post(
  '/generate-personas',
  requireAuth,
  scenarioCreditGate,
  async (req: AuthenticatedRequest, res) => {
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
  },
);

router.post(
  '/generate-factsheet',
  requireAuth,
  scenarioCreditGate,
  async (req: AuthenticatedRequest, res) => {
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
  },
);

// Generate org page identity and branded history
router.post(
  '/generate-org-page',
  requireAuth,
  scenarioCreditGate,
  validate(
    z.object({
      body: z.object({
        crisis_description: z.string(),
        country: z.string().default('Singapore'),
        org_name: z.string().optional(),
        logo_url: z.string().optional(),
        allies: z
          .array(
            z.object({
              name: z.string(),
              facebook_handle: z.string().optional(),
              x_handle: z.string().optional(),
            }),
          )
          .optional(),
        competitors: z
          .array(
            z.object({
              name: z.string(),
              facebook_handle: z.string().optional(),
              x_handle: z.string().optional(),
            }),
          )
          .optional(),
        auto_antagonist: z.boolean().optional(),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    try {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Transfer-Encoding', 'chunked');

      const {
        crisis_description,
        country,
        org_name,
        logo_url,
        allies,
        competitors,
        auto_antagonist,
      } = req.body;

      const orgPage = await generateOrgPageConfig(
        crisis_description,
        country,
        org_name,
        (msg: string) => {
          res.write(JSON.stringify({ type: 'progress', message: msg }) + '\n');
        },
        logo_url,
        { allies, competitors, auto_antagonist },
      );

      res.write(JSON.stringify({ type: 'complete', org_page: orgPage }) + '\n');
      res.end();
    } catch (err) {
      logger.error({ err }, 'Failed to generate org page config');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Org page generation failed' });
      } else {
        res.write(JSON.stringify({ type: 'error', message: 'Org page generation failed' }) + '\n');
        res.end();
      }
    }
  },
);

// Brand logo upload: store in Supabase Storage and return public URL
router.post(
  '/upload-brand-logo',
  requireAuth,
  upload.single('file'),
  async (req: AuthenticatedRequest, res) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const allowedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
      if (!allowedTypes.includes(file.mimetype)) {
        return res.status(400).json({ error: 'Only PNG, JPG, WebP, and GIF images are accepted' });
      }

      const ext = file.originalname.split('.').pop() || 'png';
      const fileName = `brand-logos/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

      const bucketName = 'sim-media';
      const { error: bucketErr } = await supabaseAdmin.storage.getBucket(bucketName);
      if (bucketErr) {
        await supabaseAdmin.storage.createBucket(bucketName, {
          public: true,
          fileSizeLimit: 50 * 1024 * 1024,
        });
      }

      const { error: uploadErr } = await supabaseAdmin.storage
        .from(bucketName)
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
          cacheControl: '3600',
        });

      if (uploadErr) {
        logger.error({ error: uploadErr }, 'Failed to upload brand logo');
        return res.status(500).json({ error: 'Failed to upload logo' });
      }

      const { data: urlData } = supabaseAdmin.storage.from(bucketName).getPublicUrl(fileName);
      res.json({ url: urlData.publicUrl });
    } catch (err) {
      logger.error({ err }, 'Error in POST /upload-brand-logo');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Document upload: extract text from PDF, DOCX, or TXT
router.post(
  '/upload-document',
  requireAuth,
  upload.single('file'),
  async (req: AuthenticatedRequest, res) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const ext = file.originalname.split('.').pop()?.toLowerCase();
      let text = '';
      const MAX_CHARS = 50000;

      if (ext === 'pdf' || file.mimetype === 'application/pdf') {
        const pdfParseModule = await import('pdf-parse');
        const pdfParse = (pdfParseModule as Record<string, unknown>).default || pdfParseModule;
        const parsed = await (pdfParse as (buf: Buffer) => Promise<{ text: string }>)(file.buffer);
        text = parsed.text;
      } else if (
        ext === 'docx' ||
        file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ) {
        const mammoth = await import('mammoth');
        const result = await mammoth.extractRawText({ buffer: file.buffer });
        text = result.value;
      } else if (ext === 'txt' || file.mimetype === 'text/plain') {
        text = file.buffer.toString('utf-8');
      } else {
        return res.status(400).json({ error: 'Unsupported file type. Use PDF, DOCX, or TXT.' });
      }

      const truncated = text.length > MAX_CHARS;
      if (truncated) {
        text = text.slice(0, MAX_CHARS);
      }

      const wordCount = text.split(/\s+/).filter(Boolean).length;

      res.json({ text, word_count: wordCount, truncated });
    } catch (err) {
      logger.error({ err }, 'Document upload/parse failed');
      res.status(500).json({ error: 'Failed to parse document' });
    }
  },
);

// Extract a structured Scenario Blueprint from raw document text (async job).
// Feature-flagged: when disabled, returns an empty blueprint so the wizard
// transparently falls back to today's raw-text behavior.
router.post(
  '/extract-blueprint',
  requireAuth,
  scenarioCreditGate,
  validate(
    z.object({
      body: z.object({
        text: z.string().default(''),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    const { text } = req.body;
    const jobId = `bp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (!env.enableDocumentBlueprint) {
      aiJobs.set(jobId, {
        status: 'completed',
        data: { blueprint: emptyBlueprint(), enabled: false },
        startedAt: Date.now(),
      });
      return res.json({ job_id: jobId, status: 'completed', enabled: false });
    }

    aiJobs.set(jobId, { status: 'generating', startedAt: Date.now() });
    res.json({ job_id: jobId, status: 'generating', enabled: true });

    void (async () => {
      try {
        const blueprint = await extractBlueprint(text || '');
        aiJobs.set(jobId, {
          status: 'completed',
          data: { blueprint, enabled: true },
          startedAt: Date.now(),
        });
        logger.info({ jobId }, 'Blueprint extraction completed');
      } catch (err) {
        logger.error({ err, jobId }, 'Blueprint extraction failed');
        aiJobs.set(jobId, {
          status: 'failed',
          error: 'Failed to extract blueprint',
          startedAt: Date.now(),
        });
      }
    })();
  },
);

export { router as socialCrisisWarroomRouter };
