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
  generateUnifiedStoryline,
  generateStrategyWindows,
  researchBestPractices,
  generateOrgPageConfig,
  buildSOPFromResearch,
  assemblePayload,
  adaptTeamCharters,
  synthesizeTeamCharter,
  type NPCPersona,
  type FactSheet,
  type TeamDef,
  type SocialInject,
} from '../services/socialCrisisGeneratorService.js';
import {
  TEAM_CATALOG,
  FIXED_TEAM_NAMES,
  SENTIMENT_DIMENSIONS,
  benchmarksFromCharters,
  getCatalogCharter,
  sanitizeExpectedActions,
  genericExpectedActions,
  type TeamCharter,
} from '../services/teamCharterService.js';
import { RESPONSE_STANDARDS } from '../config/responseStandards.js';
import {
  persistSocialCrisisScenario,
  MIGRATION_197_HINT,
} from '../services/socialCrisisPersistenceService.js';
import { setupSourceFromCompile } from '../services/setupEdits/setupSnapshotCore.js';
import {
  resolveOrganisations,
  crisisContextFrom,
  runNpcsPipeline,
  runStorylinePipeline,
  runConvergencePipeline,
  runOrgPagePipeline,
  buildCompileArtifacts,
  logCompileSummary,
  attachResponseBranches,
} from '../services/multiOrgPipeline.js';
import {
  organisationsSchema,
  competitorsSchema,
  pressureOrganisationsSchema,
  teamRosterSchema,
  teamCharterWireSchema,
  type TeamCharterWire,
} from '../services/warroomBuild/wireSchemas.js';
import { describeGenerationFailure } from '../services/warroomBuild/buildCore.js';
import { MultiOrgValidationError } from '../services/scenarioValidationService.js';
import {
  EXECUTIVE_CHARTER,
  type OrganisationInput,
  type CompetitorInput,
  type PressureOrgInput,
} from '../services/scenarioOrgModel.js';
import { inferCrisisFootprint } from '../services/crisisFootprintService.js';
import type { Stakeholder } from '../lib/stakeholderContract.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { env } from '../env.js';
import { RIVAL_DESCRIPTION_MAX } from '../services/rivalDescription.js';
import { extractBlueprint } from '../services/blueprint/blueprintExtractionService.js';
import { emptyBlueprint, coerceBlueprint } from '../services/blueprint/blueprintTypes.js';
import { getOrResearchTeamDoctrines } from '../services/doctrineCacheService.js';
import { generatePostImage } from '../services/mediaGenerationService.js';
import { runWithAbortSignal } from '../services/ai/abortContext.js';
import { hasCredit, consumeCredit, refundCredit, isAdmin } from '../services/creditService.js';
import { beginCompileCharge, failCompileCharge } from '../services/warroomBuild/compileCharge.js';
import { SupabaseBuildStore } from '../services/warroomBuild/buildStore.js';
import {
  applyCompiledPeaceFeed,
  crisisBriefForLeakTerms,
} from '../services/generation/peaceFeedService.js';
import type { Response, NextFunction } from 'express';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const compileBuilds = new SupabaseBuildStore();

/**
 * The fenced success missed, so this scenario is not the build's. Remove it.
 * Returns the scenario the winning compile stored, or this id when the delete
 * itself failed. Null means the client should follow the build: the winner has
 * not stored a scenario yet.
 *
 * A heartbeat write can commit and still lose its response. This process then
 * holds a stale heartbeat and deletes the only scenario, because that row looks
 * the same as a takeover that has not stored one yet. The charge is kept, and a
 * compile after 90 seconds reuses it.
 */
async function dropOrphanScenario(scenarioId: string, buildId: string): Promise<string | null> {
  const { error } = await supabaseAdmin.from('scenarios').delete().eq('id', scenarioId);
  if (error) {
    logger.error({ err: error, scenarioId, buildId }, 'compile_orphan_scenario_delete_failed');
    return scenarioId;
  }
  logger.warn({ scenarioId, buildId }, 'compile_orphan_scenario');
  try {
    const fresh = await compileBuilds.get(buildId);
    return fresh?.scenario_id ?? null;
  } catch (err) {
    logger.warn({ err, buildId }, 'compile_orphan_reread_failed');
    return null;
  }
}

/** The ledger points at a scenario only after that scenario is the build's. */
async function attachLedgerScenario(ledgerId: string, scenarioId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('credit_ledger')
    .update({ scenario_id: scenarioId })
    .eq('id', ledgerId);
  if (error) {
    logger.warn({ err: error, ledgerId, scenarioId }, 'compile_ledger_scenario_failed');
  }
}

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

// ─── Team roster (presets + trainer-defined custom teams) ───────────────────

interface RosterEntry {
  team_name: string;
  description?: string;
  is_custom?: boolean;
  is_public_voice?: boolean;
}

const DEFAULT_ROSTER: RosterEntry[] = FIXED_TEAM_NAMES.map((n) => ({
  team_name: n,
  is_custom: false,
  is_public_voice: n === 'Communications',
}));

/**
 * Validate a trainer-supplied roster: at least 2 unique teams, presets must match
 * catalog names, customs need a description, and exactly one team holds the
 * public voice (defaulted to Communications, else the first team).
 */
function validateRoster(
  input: RosterEntry[],
): { ok: true; roster: RosterEntry[] } | { ok: false; error: string } {
  const roster = input.map((r) => ({ ...r, team_name: r.team_name.trim() }));
  if (roster.length < 2) {
    return { ok: false, error: 'Choose at least 2 teams' };
  }
  const lower = roster.map((r) => r.team_name.toLowerCase());
  if (new Set(lower).size !== lower.length) {
    return { ok: false, error: 'Team names must be unique' };
  }
  for (const r of roster) {
    if (!r.team_name) return { ok: false, error: 'Every team needs a name' };
    const isPreset = (FIXED_TEAM_NAMES as readonly string[]).includes(r.team_name);
    if (r.is_custom && isPreset) {
      return { ok: false, error: `"${r.team_name}" is a preset name — rename the custom team` };
    }
    if (!r.is_custom && !isPreset) {
      return { ok: false, error: `Unknown preset team "${r.team_name}"` };
    }
    if (r.is_custom && !(r.description || '').trim()) {
      return { ok: false, error: `Custom team "${r.team_name}" needs a description` };
    }
  }
  const voices = roster.filter((r) => r.is_public_voice);
  if (voices.length > 1) {
    return { ok: false, error: 'Exactly one team can be designated as the public voice' };
  }
  if (voices.length === 0) {
    const comms = roster.find((r) => r.team_name === 'Communications');
    (comms ?? roster[0]).is_public_voice = true;
  }
  return { ok: true, roster };
}

/** Adapt preset charters + synthesize custom charters for the roster, in roster order. */
async function buildRosterCharters(
  roster: RosterEntry[],
  crisis: { crisisType: string; context: string; country: string; orgName?: string },
): Promise<TeamCharter[]> {
  const presetNames = roster.filter((r) => !r.is_custom).map((r) => r.team_name);
  const customs = roster.filter((r) => r.is_custom);

  const [presets, customCharters] = await Promise.all([
    presetNames.length > 0
      ? adaptTeamCharters(
          crisis.crisisType,
          crisis.context,
          crisis.country,
          crisis.orgName,
          presetNames,
        )
      : Promise.resolve([] as TeamCharter[]),
    Promise.all(
      customs.map((c) =>
        synthesizeTeamCharter(
          c.team_name,
          (c.description || '').trim(),
          crisis,
          !!c.is_public_voice,
        ),
      ),
    ),
  ]);

  const byName = new Map<string, TeamCharter>();
  for (const p of presets) byName.set(p.team_name, p);
  for (const c of customCharters) byName.set(c.team_name, c);

  return roster.map((r) => {
    const charter = byName.get(r.team_name);
    if (!charter) {
      // Should not happen (both branches cover the roster) — deterministic fallback.
      logger.error({ team: r.team_name }, 'Roster charter missing; using generic fallback');
      return {
        team_name: r.team_name,
        mission: (r.description || r.team_name).trim(),
        responsibilities: [],
        expected_actions: genericExpectedActions(r.team_name),
        scoring_rubric: '',
        out_of_lane: [],
        min_participants: 1,
        max_participants: 4,
        is_custom: !!r.is_custom,
        can_post_publicly: !!r.is_public_voice,
        sentiment_dimension: 'public_trust',
      } satisfies TeamCharter;
    }
    return { ...charter, can_post_publicly: !!r.is_public_voice, is_custom: !!r.is_custom };
  });
}

/** Full charter payload streamed to the wizard and round-tripped into compile. */
function charterWirePayload(c: TeamCharter) {
  return {
    team_name: c.team_name,
    mission: c.mission,
    responsibilities: c.responsibilities,
    out_of_lane: c.out_of_lane,
    scoring_rubric: c.scoring_rubric,
    expected_actions: c.expected_actions,
    min_participants: c.min_participants,
    max_participants: c.max_participants,
    is_custom: !!c.is_custom,
    can_post_publicly: !!c.can_post_publicly,
    sentiment_dimension: c.sentiment_dimension || 'public_trust',
  };
}

// Preset team cards for the wizard's roster builder (runtime catalog + Executive Leadership, §7A).
router.get('/team-catalog', requireAuth, (_req: AuthenticatedRequest, res) => {
  const presets = [...FIXED_TEAM_NAMES.map((name) => TEAM_CATALOG[name]), EXECUTIVE_CHARTER];
  res.json({
    data: presets.map((c) => ({
      team_name: c.team_name,
      mission: c.mission,
      responsibilities: c.responsibilities,
      min_participants: c.min_participants,
      max_participants: c.max_participants,
      default_public_voice: !!c.can_post_publicly,
      is_executive: c.team_name === EXECUTIVE_CHARTER.team_name,
    })),
  });
});

/** Knobs the wizard reads before Build so the cost line matches this process. */
router.get('/limits', requireAuth, (_req: AuthenticatedRequest, res) => {
  res.json({
    data: {
      large_build_confirm_calls: env.warroomLargeBuildConfirmCalls,
      org_page_batch: env.warroomOrgPageBatch,
      personas_total_max: env.socialPersonasTotalMax,
    },
  });
});

router.post(
  '/large-build-confirm',
  requireAuth,
  validate(
    z.object({
      body: z.object({
        calls: z.number().int().nonnegative(),
        player_teams: z.number().int().nonnegative(),
      }),
    }),
  ),
  (req: AuthenticatedRequest, res) => {
    logger.info(
      {
        event: 'build_large_confirmed',
        userId: req.user?.id,
        calls: req.body.calls,
        player_teams: req.body.player_teams,
      },
      'build_large_confirmed',
    );
    res.json({ data: { logged: true } });
  },
);

/**
 * Start an NDJSON stream and keep it alive. The generation routes hold one HTTP response open
 * for minutes while AI calls of 40–120s run back to back; Cloudflare (in front of onrender.com)
 * closes any response that goes 100s without bytes, and the browser then sees the stream end
 * with no `complete` line — a stage "fails" while the server logs nothing. A heartbeat every
 * 15s keeps the proxy happy; clients ignore the `heartbeat` type. Returns a stop function that
 * must be called before `res.end()`.
 */
function beginNdjson(res: import('express').Response): () => void {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const timer = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(JSON.stringify({ type: 'heartbeat', t: Date.now() }) + '\n');
    }
  }, 15_000);
  const stop = () => clearInterval(timer);
  res.on('close', stop);
  return stop;
}

// In-memory job store for async AI generation tasks
const aiJobs = new Map<
  string,
  {
    status: 'generating' | 'completed' | 'failed' | 'superseded';
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

// Step 1b: Crisis footprint (pressure plan §11) — proposals only, nothing persisted, no credit.
// The wizard calls it from Setup so a lazy trainer gets the implied offices, countries and
// pressure groups pre-ticked before the build starts.
router.post(
  '/footprint',
  requireAuth,
  validate(
    z.object({
      body: z.object({
        crisis_type: z.string().default(''),
        context: z.string().default(''),
        organisations: organisationsSchema.optional(),
        competitors: competitorsSchema.optional(),
        pressure_organisations: z
          .array(
            z.object({
              display_name: z.string().max(120),
              country: z.string().max(80),
              kind: z.string().max(40).optional(),
            }),
          )
          .optional(),
        dismissed: z
          .array(
            z.object({
              side: z.enum(['office', 'pressure']),
              name: z.string().max(120),
            }),
          )
          .max(50)
          .optional(),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    try {
      const orgsResult = resolveOrganisations(
        req.body.organisations as OrganisationInput[] | undefined,
        req.body.competitors as CompetitorInput[] | undefined,
      );
      if (orgsResult && !orgsResult.ok) {
        return res
          .status(400)
          .json({ error: orgsResult.message, code: orgsResult.code, details: orgsResult.details });
      }
      const text = `${req.body.crisis_type}. ${req.body.context}`.trim();
      if (text.replace(/\W/g, '').length < 20) {
        return res.status(400).json({ error: 'Describe the crisis first (a sentence or two).' });
      }
      const footprint = await inferCrisisFootprint(
        text,
        orgsResult && orgsResult.ok ? orgsResult.orgs : [],
        {
          existingPressure: req.body.pressure_organisations,
          dismissed: req.body.dismissed,
        },
      );
      res.json({ data: footprint });
    } catch (err) {
      logger.error({ err }, 'crisis_footprint_route_failed');
      res.status(500).json({ error: 'Footprint inference failed' });
    }
  },
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
        organisations: organisationsSchema.optional(),
        competitors: competitorsSchema.optional(),
        pressure_organisations: pressureOrganisationsSchema.optional(),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    const { crisis_type, context, country, location, org_name, blueprint } = req.body;

    // Multi-organisation path (contract §5): validate BEFORE starting the job.
    const orgsResult = resolveOrganisations(
      req.body.organisations as OrganisationInput[] | undefined,
      req.body.competitors as CompetitorInput[] | undefined,
      req.body.pressure_organisations as PressureOrgInput[] | undefined,
    );
    if (orgsResult && !orgsResult.ok) {
      logger.warn({ code: orgsResult.code, details: orgsResult.details }, 'org_validation_failed');
      return res
        .status(400)
        .json({ error: orgsResult.message, code: orgsResult.code, details: orgsResult.details });
    }

    const jobId = `npc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    aiJobs.set(jobId, { status: 'generating', startedAt: Date.now() });
    res.json({ job_id: jobId, status: 'generating' });

    void (async () => {
      try {
        if (orgsResult && orgsResult.ok) {
          const r = await runNpcsPipeline(orgsResult, crisisContextFrom(req.body));
          aiJobs.set(jobId, {
            status: 'completed',
            data: {
              personas: r.personas,
              factSheet: r.factSheet,
              fact_sheet: r.factSheet,
              communities: r.communities,
              countries: r.countries,
              per_country_counts: r.per_country_counts,
              footprint: r.footprint,
            },
            startedAt: Date.now(),
          });
          logger.info(
            { jobId, per_country_counts: r.per_country_counts },
            'NPC generation completed (multi-org)',
          );
          return;
        }
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
          error: describeGenerationFailure(err, 'characters and fact sheet'),
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
  if (job.status === 'superseded') {
    return res.json({ status: 'superseded', error: job.error });
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
        team_roster: teamRosterSchema.optional(),
        organisations: organisationsSchema.optional(),
        competitors: competitorsSchema.optional(),
        pressure_organisations: pressureOrganisationsSchema.optional(),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { crisis_type, country, context, duration, personas, fact_sheet, org_name, blueprint } =
        req.body;

      // Multi-organisation path (contract §5): organisations[] replaces the flat roster.
      const orgsResult = resolveOrganisations(
        req.body.organisations as OrganisationInput[] | undefined,
        req.body.competitors as CompetitorInput[] | undefined,
        req.body.pressure_organisations as PressureOrgInput[] | undefined,
      );
      if (orgsResult && !orgsResult.ok) {
        logger.warn(
          { code: orgsResult.code, details: orgsResult.details },
          'org_validation_failed',
        );
        return res
          .status(400)
          .json({ error: orgsResult.message, code: orgsResult.code, details: orgsResult.details });
      }
      if (orgsResult && orgsResult.ok) {
        const ac = new AbortController();
        res.on('close', () => {
          if (!res.writableEnded) ac.abort();
        });
        const stopHeartbeat = beginNdjson(res);
        const write = (msg: Record<string, unknown>) => {
          if (ac.signal.aborted || res.writableEnded) return;
          res.write(JSON.stringify(msg) + '\n');
        };
        try {
          const result = await runWithAbortSignal(ac.signal, () =>
            runStorylinePipeline(
              orgsResult,
              crisisContextFrom(req.body),
              personas as NPCPersona[],
              fact_sheet as FactSheet,
              env.enableDocumentBlueprint && blueprint ? coerceBlueprint(blueprint) : null,
              write,
            ),
          );
          if (ac.signal.aborted) {
            logger.info({ route: 'generate-storyline' }, 'generation_aborted_client_disconnected');
            return;
          }
          write({ type: 'complete', ...result });
        } catch (err) {
          if (ac.signal.aborted) {
            logger.info({ route: 'generate-storyline' }, 'generation_aborted_client_disconnected');
            return;
          }
          logger.error({ err }, 'Multi-org storyline generation failed');
          write({ type: 'error', message: 'Storyline generation failed' });
        } finally {
          stopHeartbeat();
          if (!ac.signal.aborted && !res.writableEnded) res.end();
        }
        return;
      }

      // Roster: trainer-selected presets + custom teams. Absent = the four
      // presets (backward compatible). Validate BEFORE switching to NDJSON.
      const rosterCheck = validateRoster(
        (req.body.team_roster as RosterEntry[] | undefined) ?? DEFAULT_ROSTER,
      );
      if (!rosterCheck.ok) {
        return res.status(400).json({ error: rosterCheck.error });
      }
      const roster = rosterCheck.roster;

      beginNdjson(res);

      const crisisContext = {
        crisisType: crisis_type,
        country,
        context,
        duration,
        orgName: org_name,
      };

      // Adapt preset charters and synthesize custom-team charters for this
      // crisis, then generate the universal backbone and the per-team
      // pressure arcs (one per roster team) in parallel.
      res.write(
        JSON.stringify({
          type: 'progress',
          message: `Preparing charters for ${roster.length} teams (${roster.filter((r) => r.is_custom).length} custom)...`,
        }) + '\n',
      );
      const charters = await buildRosterCharters(roster, {
        crisisType: crisis_type,
        context,
        country,
        orgName: org_name,
      });

      const fixedTeams: TeamDef[] = charters.map((c) => ({
        team_name: c.team_name,
        team_description: `${c.mission} Responsibilities: ${c.responsibilities.join('; ')}`,
        min_participants: c.min_participants,
        max_participants: c.max_participants,
      }));

      const teamCrisisContext = { ...crisisContext, location: '' };

      const [injects, teamStorylines] = await Promise.all([
        generateUnifiedStoryline(
          crisisContext,
          personas as NPCPersona[],
          fact_sheet as FactSheet,
          (msg: string) => {
            res.write(JSON.stringify({ type: 'progress', message: msg }) + '\n');
          },
          env.enableDocumentBlueprint && blueprint ? coerceBlueprint(blueprint) : null,
          // Teams enable stakeholder routing: shared-layer emails get tagged
          // with the team that owns each stakeholder relationship.
          fixedTeams,
        ),
        generateAllTeamStorylines(
          fixedTeams,
          teamCrisisContext,
          personas as NPCPersona[],
          fact_sheet as FactSheet,
          (teamName: string, injectCount: number) => {
            res.write(
              JSON.stringify({ type: 'team_complete', team: teamName, inject_count: injectCount }) +
                '\n',
            );
          },
        ),
      ]);

      res.write(
        JSON.stringify({
          type: 'complete',
          injects,
          team_storylines: teamStorylines,
          team_charters: charters.map(charterWirePayload),
        }) + '\n',
      );
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

      beginNdjson(res);

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
        // Multi-organisation (contract §5 / §7A): cross-org dependencies + decision layer.
        organisations: organisationsSchema.optional(),
        competitors: competitorsSchema.optional(),
        pressure_organisations: pressureOrganisationsSchema.optional(),
        team_charters: z.array(teamCharterWireSchema).optional(),
        stakeholders: z.array(z.unknown()).optional(),
        stakeholder_injects: z.array(z.unknown()).optional(),
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

    const orgsResult = resolveOrganisations(
      req.body.organisations as OrganisationInput[] | undefined,
      req.body.competitors as CompetitorInput[] | undefined,
      req.body.pressure_organisations as PressureOrgInput[] | undefined,
    );
    if (orgsResult && !orgsResult.ok) {
      logger.warn({ code: orgsResult.code, details: orgsResult.details }, 'org_validation_failed');
      return res
        .status(400)
        .json({ error: orgsResult.message, code: orgsResult.code, details: orgsResult.details });
    }

    const jobId = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    aiJobs.set(jobId, { status: 'generating', startedAt: Date.now() });
    res.json({ job_id: jobId, status: 'generating' });

    void (async () => {
      try {
        const crisisContext = { crisisType: crisis_type, location, country, context, duration };
        const data = await runConvergencePipeline(
          orgsResult && orgsResult.ok ? orgsResult : null,
          crisisContext,
          team_storylines as Record<string, SocialInject[]>,
          personas as NPCPersona[],
          fact_sheet as FactSheet,
          env.enableDocumentBlueprint && blueprint ? coerceBlueprint(blueprint) : null,
          jobId,
          {
            stakeholders: req.body.stakeholders as Stakeholder[] | undefined,
            stakeholderInjects: req.body.stakeholder_injects as SocialInject[] | undefined,
          },
        );
        aiJobs.set(jobId, { status: 'completed', data, startedAt: Date.now() });
      } catch (err) {
        logger.error({ err, jobId }, 'Convergence generation failed');
        aiJobs.set(jobId, {
          status: 'failed',
          error: describeGenerationFailure(err, 'convergence layer'),
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
    const ac = new AbortController();
    try {
      res.on('close', () => {
        if (!res.writableEnded) ac.abort();
      });
      beginNdjson(res);

      const { crisis_type, context, teams, team_storylines } = req.body;

      const research = await runWithAbortSignal(ac.signal, () =>
        getOrResearchTeamDoctrines(
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
            if (ac.signal.aborted || res.writableEnded) return;
            res.write(JSON.stringify({ type: 'team_research_complete', team: teamName }) + '\n');
          },
        ),
      );

      if (ac.signal.aborted) {
        logger.info({ route: 'research' }, 'generation_aborted_client_disconnected');
        return;
      }

      res.write(JSON.stringify({ type: 'complete', research }) + '\n');
      res.end();
    } catch (err) {
      if (ac.signal.aborted) {
        logger.info({ route: 'research' }, 'generation_aborted_client_disconnected');
        return;
      }
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
        context: z.string().optional().default(''),
        uploaded_doc_name: z.string().max(300).optional(),
        uploaded_doc_text: z.string().optional(),
        auto_antagonist: z.boolean().optional(),
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
        team_charters: z.array(teamCharterWireSchema).optional(),
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
        // Multi-organisation (contract §3 / §5). Server derives orgs[]/countries[] itself.
        organisations: organisationsSchema.optional(),
        competitors: competitorsSchema.optional(),
        pressure_organisations: pressureOrganisationsSchema.optional(),
        stakeholders: z.array(z.unknown()).optional(),
        stakeholder_injects: z.array(z.unknown()).optional(),
        // Cast-generated notification SOP steps + planner hints (organic-decisions plan §4.1).
        sop_steps: z.array(z.unknown()).optional(),
        decision_context: z.record(z.string(), z.unknown()).optional(),
        // Durable builds: one scenario credit per build. Omitted on the legacy path.
        build_id: z.string().uuid().optional(),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    if (user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Only trainers can compile scenarios' });
    }

    // Multi-organisation path: validate the organisations BEFORE consuming the credit.
    const compileOrgs = resolveOrganisations(
      req.body.organisations as OrganisationInput[] | undefined,
      req.body.competitors as CompetitorInput[] | undefined,
      req.body.pressure_organisations as PressureOrgInput[] | undefined,
    );
    if (compileOrgs && !compileOrgs.ok) {
      logger.warn(
        { code: compileOrgs.code, details: compileOrgs.details },
        'org_validation_failed',
      );
      return res.status(400).json({
        error: `Invalid organisations: ${compileOrgs.message}`,
        code: compileOrgs.code,
        details: compileOrgs.details,
      });
    }

    // Validate the team roster BEFORE consuming the credit so a bad roster
    // never costs the trainer anything. (No charters = legacy default four.)
    const compileClientCharters = (req.body.team_charters || []) as Array<
      Record<string, unknown> & { team_name: string; mission: string; responsibilities: string[] }
    >;
    let compileRoster: RosterEntry[] | null = null;
    if (!compileOrgs && compileClientCharters.length > 0) {
      const rosterCheck = validateRoster(
        compileClientCharters.map((c) => ({
          team_name: c.team_name,
          description: c.mission,
          is_custom:
            !!c.is_custom || !(FIXED_TEAM_NAMES as readonly string[]).includes(c.team_name.trim()),
          is_public_voice: !!c.can_post_publicly,
        })),
      );
      if (!rosterCheck.ok) {
        return res.status(400).json({ error: `Invalid team roster: ${rosterCheck.error}` });
      }
      compileRoster = rosterCheck.roster;
    }

    // The compile consumes the scenario credit. Without a build id this is the
    // legacy path: consume up-front and refund if compilation fails. With a
    // build id the charge is claimed on the build, once, and a crash reuses it.
    let creditInvoiceId: string | null = null;
    let creditLedgerId: string | null = null;
    const durableBuildId = (req.body.build_id as string | undefined) ?? null;
    let compileHeartbeatAt: string | null = null;
    if (durableBuildId) {
      try {
        const existingBuild = await compileBuilds.get(durableBuildId);
        if (existingBuild?.request.mode === 'setup_edit') {
          return res.status(400).json({
            error: 'A setup edit build is applied to the existing scenario and is not compiled.',
            code: 'SETUP_EDIT_BUILD',
          });
        }
        const begun = await beginCompileCharge({
          store: compileBuilds,
          buildId: durableBuildId,
          userId: user.id,
          isAdmin: isAdmin(user),
          now: new Date(),
          consume: async () => {
            const consumed = await consumeCredit(user.id, 'scenario', 'scenario_generated');
            if (!consumed.ok || !consumed.ledgerId) return { ok: false };
            return {
              ok: true,
              ledgerId: consumed.ledgerId,
              invoiceId: consumed.fundingInvoiceId ?? null,
            };
          },
          refund: (invoiceId) => refundCredit(user.id, 'scenario', invoiceId),
        });
        if (begun.outcome === 'not_found') {
          return res.status(404).json({ error: 'Build not found', code: 'BUILD_NOT_FOUND' });
        }
        if (begun.outcome === 'not_done') {
          return res.status(409).json({ error: 'Build is not finished', code: 'BUILD_NOT_DONE' });
        }
        if (begun.outcome === 'completed') {
          return res.status(200).json({
            job_id: null,
            status: 'completed',
            data: { scenario_id: begun.scenarioId },
          });
        }
        if (begun.outcome === 'in_progress') {
          return res.status(409).json({
            error: 'Compilation is already running — wait a moment and reopen this draft.',
            code: 'COMPILE_IN_PROGRESS',
          });
        }
        if (begun.outcome === 'no_credit') {
          return res.status(402).json(NO_SCENARIO_CREDITS_BODY);
        }
        if (begun.outcome === 'unavailable') {
          return res.status(503).json({
            error: 'Compile could not be claimed. Try again.',
            code: 'COMPILE_UNAVAILABLE',
          });
        }
        if (begun.outcome === 'setup_edit') {
          return res.status(400).json({
            error: 'A setup edit build is applied to the existing scenario and is not compiled.',
            code: 'SETUP_EDIT_BUILD',
          });
        }
        creditLedgerId = begun.ledgerId;
        creditInvoiceId = begun.invoiceId;
        compileHeartbeatAt = begun.heartbeatAt;
      } catch (err) {
        logger.error({ err, buildId: durableBuildId }, 'compile_claim_failed');
        return res.status(503).json({
          error: 'Compile could not be claimed. Try again.',
          code: 'COMPILE_UNAVAILABLE',
        });
      }
    } else if (!isAdmin(user)) {
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
      let myHeartbeat = compileHeartbeatAt;
      let timer: ReturnType<typeof setInterval> | null = null;
      if (durableBuildId && myHeartbeat) {
        timer = setInterval(() => {
          const expected = myHeartbeat;
          if (!expected) return;
          void compileBuilds
            .touchCompileHeartbeat(durableBuildId, expected, new Date())
            .then((next) => {
              if (next) myHeartbeat = next;
              else if (timer) clearInterval(timer);
            })
            .catch((err) => {
              // The update may have committed. myHeartbeat then stays on the
              // previous value, and the fence miss below can delete this
              // process's own scenario. See dropOrphanScenario.
              logger.warn({ err, buildId: durableBuildId }, 'compile_heartbeat_failed');
            });
        }, 30_000);
        timer.unref?.();
      }
      let scenarioWritten = false;
      let scenarioId = '';
      try {
        const sop = buildSOPFromResearch(RESPONSE_STANDARDS);

        // Team roster: presets keep their catalog machinery (expected actions,
        // weights) with client wording accepted; custom teams take the full
        // client charter but the scoring machinery is re-sanitized server-side
        // (detection types validated against the closed action vocabulary) so
        // a custom team can never be silently unscoreable. No charters sent =
        // legacy default: adapt the four presets.
        let teamCharters: TeamCharter[];
        // Multi-organisation artefacts (charters, registry, stakeholders, templates, personas).
        const multiArtifacts =
          compileOrgs && compileOrgs.ok
            ? buildCompileArtifacts(compileOrgs, {
                team_charters: body.team_charters as TeamCharterWire[] | undefined,
                stakeholders: body.stakeholders as Stakeholder[] | undefined,
                stakeholder_injects: body.stakeholder_injects as SocialInject[] | undefined,
                personas: body.personas as NPCPersona[],
                org_page:
                  (body.org_page as
                    | import('../services/socialCrisisGeneratorService.js').OrgPageConfig
                    | undefined) || null,
                sop_steps: body.sop_steps as
                  import('../services/socialCrisisGeneratorService.js').SOPStep[] | undefined,
                decision_context:
                  (body.decision_context as Record<string, unknown> | undefined) ?? null,
              })
            : null;
        if (multiArtifacts) {
          teamCharters = multiArtifacts.charters;
        } else if (compileRoster) {
          teamCharters = compileRoster.map((entry) => {
            const client = compileClientCharters.find(
              (c) => c.team_name.trim() === entry.team_name,
            )!;
            const base = getCatalogCharter(entry.team_name);
            const clientResponsibilities = Array.isArray(client.responsibilities)
              ? (client.responsibilities as unknown[])
                  .filter((r): r is string => typeof r === 'string')
                  .slice(0, 6)
              : [];

            if (base && !entry.is_custom) {
              return {
                ...base,
                mission: client.mission || base.mission,
                responsibilities:
                  clientResponsibilities.length > 0
                    ? clientResponsibilities
                    : base.responsibilities,
                is_custom: false,
                can_post_publicly: !!entry.is_public_voice,
              };
            }

            const dimension = String(client.sentiment_dimension || '');
            return {
              team_name: entry.team_name,
              mission: String(client.mission || '').trim() || entry.team_name,
              responsibilities: clientResponsibilities,
              out_of_lane: Array.isArray(client.out_of_lane)
                ? (client.out_of_lane as unknown[])
                    .filter((r): r is string => typeof r === 'string')
                    .slice(0, 4)
                : [],
              scoring_rubric:
                String(client.scoring_rubric || '').trim() ||
                `Judge as output of the "${entry.team_name}" team (${String(client.mission || '')}). Reward factual precision, professionalism, timeliness, and staying within the team's lane.`,
              expected_actions: sanitizeExpectedActions(client.expected_actions, entry.team_name),
              min_participants: 1,
              max_participants: Math.max(2, Math.min(6, Number(client.max_participants) || 4)),
              is_custom: true,
              can_post_publicly: !!entry.is_public_voice,
              sentiment_dimension: (SENTIMENT_DIMENSIONS as readonly string[]).includes(dimension)
                ? dimension
                : 'public_trust',
            } satisfies TeamCharter;
          });
        } else {
          teamCharters = await adaptTeamCharters(
            body.crisis_type || '',
            '',
            body.country || 'Singapore',
            body.org_name,
          );
        }

        const fixedTeams: TeamDef[] = teamCharters.map((c) => ({
          team_name: c.team_name,
          team_description: c.mission,
          min_participants: c.min_participants,
          max_participants: c.max_participants,
        }));

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

        // Cast-generated notification / consultation SOP steps ride the scenario SOP
        // (graded by the organic decision engine when a formal notice is detected).
        if (multiArtifacts && multiArtifacts.sop_steps.length > 0) {
          sop.steps = [...sop.steps, ...multiArtifacts.sop_steps];
        }

        const convergenceGates = (body.convergence_gates as SocialInject[]) ?? [];
        body.convergence_gates = convergenceGates;
        const strategyInjects: SocialInject[] = [];
        for (const window of strategyWindows ?? []) {
          if (window.success_injects) strategyInjects.push(...window.success_injects);
          if (window.backlash_injects) strategyInjects.push(...window.backlash_injects);
        }
        try {
          await attachResponseBranches({
            crisis: {
              crisisType: body.crisis_type || '',
              duration: body.duration,
              country: body.country || 'Singapore',
            },
            factSheet: body.fact_sheet as FactSheet,
            stakeholders:
              multiArtifacts?.stakeholders ??
              (body.stakeholders as Stakeholder[] | undefined) ??
              [],
            injects: [
              ...((body.storyline_injects as SocialInject[]) || []),
              ...Object.values(
                (body.team_storylines || {}) as Record<string, SocialInject[]>,
              ).flat(),
              ...((body.shared_injects as SocialInject[]) || []),
              ...convergenceGates,
              ...(multiArtifacts?.extraInjects ??
                ((body.stakeholder_injects as SocialInject[]) || [])),
              ...strategyInjects,
            ],
            branchSink: convergenceGates,
            stripCarry: true,
          });
        } catch (branchErr) {
          logger.warn({ branchErr }, 'Response branch generation failed (non-critical)');
        }

        const payload = assemblePayload(
          body.narrative,
          fixedTeams,
          body.objectives as Array<{
            objective_id: string;
            objective_name: string;
            description: string;
            weight: number;
          }>,
          (multiArtifacts ? multiArtifacts.personas : body.personas) as NPCPersona[],
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
          // Multi-org: pages with their keys repaired against the registry (MO-ORG-005).
          multiArtifacts
            ? multiArtifacts.orgPage
            : (body.org_page as
                import('../services/socialCrisisGeneratorService.js').OrgPageConfig | undefined) ||
                null,
          body.org_name || undefined,
          env.enableDocumentBlueprint && body.blueprint ? coerceBlueprint(body.blueprint) : null,
          multiArtifacts
            ? {
                orgs: multiArtifacts.registry,
                countries: multiArtifacts.countries,
                country: multiArtifacts.primaryCountry,
                stakeholders: multiArtifacts.stakeholders,
                extraInjects: multiArtifacts.extraInjects,
                ...(multiArtifacts.decision_context
                  ? { decision_context: multiArtifacts.decision_context }
                  : {}),
              }
            : undefined,
        );

        const initialState = payload.scenario.initial_state as Record<string, unknown>;
        if (body.country && !multiArtifacts) {
          initialState.country = body.country;
        }
        initialState.setup_source = setupSourceFromCompile({
          crisis_type: body.crisis_type,
          context: body.context,
          uploaded_doc_name: body.uploaded_doc_name,
          uploaded_doc_text: body.uploaded_doc_text,
          country: typeof initialState.country === 'string' ? initialState.country : body.country,
          org_name: body.org_name,
          duration: body.duration,
          auto_antagonist: body.auto_antagonist,
          fact_sheet: initialState.fact_sheet,
          briefing: typeof payload.scenario.briefing === 'string' ? payload.scenario.briefing : null,
        });

        // Charter-derived benchmarks keyed to the four fixed teams (consumed
        // by team scoring and the AAR doctrine-compliance section).
        (payload.scenario.initial_state as Record<string, unknown>).strategic_benchmarks =
          benchmarksFromCharters(teamCharters);

        // Peace feed. Off unless ENABLE_PEACE_FEED_BUILD_STAGE. A durable build
        // copies the feed on the pages output. The legacy path generates once
        // here. Neither path fails the compile.
        if (env.enablePeaceFeedBuildStage) {
          let storedFeed: unknown;
          if (durableBuildId) {
            try {
              storedFeed = (await compileBuilds.getOutputs(durableBuildId)).pages?.peace_period;
            } catch (peaceErr) {
              logger.warn(
                { err: peaceErr, buildId: durableBuildId },
                'peace feed output unreadable',
              );
            }
          }
          const personas = multiArtifacts ? multiArtifacts.personas : body.personas;
          await applyCompiledPeaceFeed({
            initialState,
            storedFeed,
            generate: !durableBuildId,
            personas: Array.isArray(personas) ? personas : [],
            orgPage: multiArtifacts ? multiArtifacts.orgPage : body.org_page,
            crisisBrief: crisisBriefForLeakTerms({
              crisisType: body.crisis_type,
              context: body.context,
              narrative: body.narrative?.description,
              confirmedFacts: (body.fact_sheet as FactSheet | undefined)?.confirmed_facts,
            }),
          });
        }

        // Persistence runs the contract §9 checklist first and throws MultiOrgValidationError
        // before writing anything; the trainer sees the failing rule (handled below).
        scenarioId = await persistSocialCrisisScenario(payload, user.id, teamCharters);
        scenarioWritten = true;
        if (multiArtifacts) {
          logCompileSummary(
            scenarioId,
            multiArtifacts,
            payload.time_injects.length +
              payload.condition_injects.length +
              payload.decision_injects.length,
          );
        }

        // A durable compile attaches the ledger only after the fenced write
        // lands, so a lost race cannot point the shared charge at a scenario
        // this process is about to delete. The legacy compile has no fence.
        if (creditLedgerId && !durableBuildId) {
          await attachLedgerScenario(creditLedgerId, scenarioId);
        }

        // Pre-generate images in background (doesn't block compile result)
        const personas = (multiArtifacts ? multiArtifacts.personas : body.personas) as NPCPersona[];
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

        let reportedScenarioId: string | null = scenarioId;
        if (durableBuildId && myHeartbeat) {
          try {
            const wrote = await compileBuilds.succeedCompile(
              durableBuildId,
              scenarioId,
              myHeartbeat,
            );
            if (wrote) {
              if (creditLedgerId) await attachLedgerScenario(creditLedgerId, scenarioId);
            } else {
              reportedScenarioId = await dropOrphanScenario(scenarioId, durableBuildId);
            }
          } catch (err) {
            // The scenario rows exist. Refunding here would hand the trainer a
            // free scenario, or race a process that has taken over the charge.
            logger.error(
              { err, buildId: durableBuildId, scenarioId },
              'compile_succeed_write_failed',
            );
          }
        }
        const injectCount =
          payload.time_injects.length +
          payload.condition_injects.length +
          payload.decision_injects.length;
        if (reportedScenarioId) {
          aiJobs.set(jobId, {
            status: 'completed',
            data: {
              scenario_id: reportedScenarioId,
              title: payload.scenario.title,
              inject_count: injectCount,
            },
            startedAt: Date.now(),
          });
          logger.info({ jobId, scenarioId: reportedScenarioId }, 'Compile completed');
        } else {
          aiJobs.set(jobId, {
            status: 'superseded',
            error: 'Another compile took this build. Reopen the draft to open its scenario.',
            startedAt: Date.now(),
          });
          logger.info({ jobId, buildId: durableBuildId }, 'compile_superseded');
        }
      } catch (err) {
        logger.error({ err, jobId }, 'Social crisis compile failed');
        if (!scenarioWritten) {
          try {
            if (durableBuildId && myHeartbeat) {
              await failCompileCharge({
                store: compileBuilds,
                buildId: durableBuildId,
                heartbeatAt: myHeartbeat,
                ledgerId: creditLedgerId,
                invoiceId: creditInvoiceId,
                refund: (invoiceId) => refundCredit(user.id, 'scenario', invoiceId),
              });
            } else if (creditLedgerId) {
              await refundCredit(user.id, 'scenario', creditInvoiceId);
            }
          } catch (settleErr) {
            logger.error({ err: settleErr, jobId }, 'compile_settle_failed');
          }
        } else {
          logger.error({ err, jobId, scenarioId }, 'compile_after_persist_failed');
          if (durableBuildId && myHeartbeat && scenarioId) {
            try {
              const wrote = await compileBuilds.succeedCompile(
                durableBuildId,
                scenarioId,
                myHeartbeat,
              );
              if (wrote) {
                if (creditLedgerId) await attachLedgerScenario(creditLedgerId, scenarioId);
              } else {
                const kept = await dropOrphanScenario(scenarioId, durableBuildId);
                if (!kept) {
                  aiJobs.set(jobId, {
                    status: 'superseded',
                    error:
                      'Another compile took this build. Reopen the draft to open its scenario.',
                    startedAt: Date.now(),
                  });
                  return;
                }
                scenarioId = kept;
              }
            } catch (writeErr) {
              logger.error(
                { err: writeErr, buildId: durableBuildId, scenarioId },
                'compile_succeed_write_failed',
              );
            }
          }
          aiJobs.set(jobId, {
            status: 'completed',
            data: { scenario_id: scenarioId, title: '', inject_count: 0 },
            startedAt: Date.now(),
          });
          return;
        }
        // Contract §9 violations surface their rule so the trainer/editor can act on them;
        // a lagging database migration is named rather than hidden behind a generic failure.
        const message = err instanceof Error ? err.message : '';
        const error =
          err instanceof MultiOrgValidationError
            ? `Compilation failed validation — ${err.code}: ${err.message.replace(/^MO-[A-Z]+-\d+:\s*/, '')}`
            : /migration 197/i.test(message)
              ? `Compilation failed: database ${MIGRATION_197_HINT}`
              : 'Compilation failed';
        aiJobs.set(jobId, { status: 'failed', error, startedAt: Date.now() });
      } finally {
        try {
          if (timer) clearInterval(timer);
        } catch (err) {
          logger.error({ err, jobId }, 'compile_heartbeat_stop_failed');
        }
      }
    })().catch((err) => {
      logger.error({ err, jobId }, 'compile_job_unhandled');
    });
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
              description: z.string().max(RIVAL_DESCRIPTION_MAX).optional(),
            }),
          )
          .optional(),
        auto_antagonist: z.boolean().optional(),
        organisations: organisationsSchema.optional(),
        competitors_with_country: competitorsSchema.optional(),
        pressure_organisations: pressureOrganisationsSchema.optional(),
        // For pressure-page statements (page identity + spokesperson) and posture grounding.
        stakeholders: z.array(z.unknown()).optional(),
        fact_sheet: z.unknown().optional(),
        crisis_type: z.string().optional(),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    const ac = new AbortController();
    try {
      // Multi-organisation path: every protagonist gets its own page in its own country;
      // competitors carry theirs; pressure orgs get AI-run pages; the registry is returned alongside.
      const orgsResult = resolveOrganisations(
        req.body.organisations as OrganisationInput[] | undefined,
        req.body.competitors_with_country as CompetitorInput[] | undefined,
        req.body.pressure_organisations as PressureOrgInput[] | undefined,
      );
      if (orgsResult && !orgsResult.ok) {
        logger.warn(
          { code: orgsResult.code, details: orgsResult.details },
          'org_validation_failed',
        );
        return res
          .status(400)
          .json({ error: orgsResult.message, code: orgsResult.code, details: orgsResult.details });
      }

      res.on('close', () => {
        if (!res.writableEnded) ac.abort();
      });
      beginNdjson(res);

      const {
        crisis_description,
        country,
        org_name,
        logo_url,
        allies,
        competitors,
        auto_antagonist,
      } = req.body;

      if (orgsResult && orgsResult.ok) {
        const r = await runWithAbortSignal(ac.signal, () =>
          runOrgPagePipeline(
            orgsResult,
            crisis_description,
            logo_url,
            auto_antagonist !== false,
            (msg: string) => {
              if (ac.signal.aborted || res.writableEnded) return;
              res.write(JSON.stringify({ type: 'progress', message: msg }) + '\n');
            },
            {
              stakeholders: ((req.body.stakeholders as Stakeholder[]) || []).filter(
                (s) => s && typeof s === 'object',
              ),
              factSheet: (req.body.fact_sheet as FactSheet | undefined) ?? null,
              crisis: crisisContextFrom({
                crisis_type: (req.body.crisis_type as string) || crisis_description.slice(0, 80),
                context: crisis_description,
                duration: 60,
                org_name,
              }),
            },
          ),
        );
        if (ac.signal.aborted) {
          logger.info({ route: 'generate-org-page' }, 'generation_aborted_client_disconnected');
          return;
        }
        res.write(
          JSON.stringify({
            type: 'complete',
            org_page: r.orgPage,
            orgs: r.orgs,
            countries: r.countries,
            pressure_injects: r.pressure_injects,
            persona_twins: r.persona_twins,
          }) + '\n',
        );
        res.end();
        return;
      }

      const orgPage = await runWithAbortSignal(ac.signal, () =>
        generateOrgPageConfig(
          crisis_description,
          country,
          org_name,
          (msg: string) => {
            if (ac.signal.aborted || res.writableEnded) return;
            res.write(JSON.stringify({ type: 'progress', message: msg }) + '\n');
          },
          logo_url,
          { allies, competitors, auto_antagonist },
        ),
      );

      if (ac.signal.aborted) {
        logger.info({ route: 'generate-org-page' }, 'generation_aborted_client_disconnected');
        return;
      }
      res.write(JSON.stringify({ type: 'complete', org_page: orgPage }) + '\n');
      res.end();
    } catch (err) {
      if (ac.signal.aborted) {
        logger.info({ route: 'generate-org-page' }, 'generation_aborted_client_disconnected');
        return;
      }
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
          error: describeGenerationFailure(err, 'blueprint extraction'),
          startedAt: Date.now(),
        });
      }
    })();
  },
);

export { router as socialCrisisWarroomRouter };
