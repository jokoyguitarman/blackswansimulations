/**
 * POST /scenarios/:id/peace-feed generates the pre-crisis feed for a scenario
 * that already exists. GET is how the editor learns the flag: 404 when
 * ENABLE_PEACE_PERIOD is off, the same way setup edits and teammate bots hide.
 */

import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import { validate } from '../lib/validation.js';
import { assertScenarioOwner, type AccessResult, type AccessUser } from '../lib/access.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { canEditScenario, type EditabilityResult } from '../services/scenarioEditService.js';
import {
  PEACE_OFFSET_TAIL_SECONDS,
  PEACE_PERIOD_DEFAULT_SECONDS,
  PEACE_PERIOD_MAX_SECONDS,
  usablePeaceFeed,
} from '../services/generation/peaceFeedCore.js';
import {
  castFromParts,
  crisisBriefForLeakTerms,
  generatePeaceFeed,
  type GeneratePeaceFeedInput,
  type GeneratePeaceFeedResult,
} from '../services/generation/peaceFeedService.js';
import type { PeaceFeed } from '../../shared/peaceFeed.js';

const SOCIAL = 'social_media_crisis';

const scenarioParams = z.object({
  params: z.object({ id: z.string().uuid() }),
});

const patchBody = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z
    .object({
      seconds: z.number().int().min(0).max(PEACE_PERIOD_MAX_SECONDS).optional(),
      enabled: z.boolean().optional(),
    })
    .refine((body) => body.seconds !== undefined || body.enabled !== undefined, {
      message: 'seconds or enabled is required',
    }),
});

export interface PeaceScenarioRow {
  category: string | null;
  initial_state: Record<string, unknown> | null;
}

export interface PeaceFeedRouteDeps {
  periodEnabled: () => boolean;
  authMiddleware: RequestHandler;
  assertOwner: (scenarioId: string, user: AccessUser) => Promise<AccessResult>;
  canEdit: (scenarioId: string, user: { id: string; role?: string }) => Promise<EditabilityResult>;
  loadScenario: (scenarioId: string) => Promise<PeaceScenarioRow | null>;
  savePeacePeriod: (scenarioId: string, peace: PeaceFeed | null) => Promise<void>;
  generate: (
    input: GeneratePeaceFeedInput,
  ) => Promise<GeneratePeaceFeedResult>;
}

function unavailable(res: Response): void {
  res.status(404).json({ error: 'Not found', code: 'PEACE_PERIOD_UNAVAILABLE' });
}

function locked(res: Response, reason: EditabilityResult['reason']): void {
  res.status(423).json({
    error:
      reason === 'live_session'
        ? 'A session on this scenario is currently live. Editing resumes when it ends.'
        : 'No session launch credits remaining. Editing is locked until credits are topped up.',
    code: 'SCENARIO_LOCKED',
  });
}

function confirmedFacts(initial: Record<string, unknown>): unknown {
  const factSheet = initial.fact_sheet;
  if (!factSheet || typeof factSheet !== 'object') return undefined;
  return (factSheet as { confirmed_facts?: unknown }).confirmed_facts;
}

async function loadScenarioRow(scenarioId: string): Promise<PeaceScenarioRow | null> {
  const { data, error } = await supabaseAdmin
    .from('scenarios')
    .select('category, initial_state, description, briefing')
    .eq('id', scenarioId)
    .maybeSingle<{
      category: string | null;
      initial_state: Record<string, unknown> | null;
      description: string | null;
      briefing: string | null;
    }>();
  if (error) {
    logger.error({ error, scenarioId }, 'Failed to load scenario for peace feed');
    throw new Error(`Scenario lookup failed: ${error.message}`);
  }
  if (!data) return null;
  const initial = { ...(data.initial_state ?? {}) };
  if (typeof data.description === 'string' && initial.description == null) {
    initial.description = data.description;
  }
  if (typeof data.briefing === 'string' && initial.briefing == null) {
    initial.briefing = data.briefing;
  }
  return { category: data.category, initial_state: initial };
}

async function savePeacePeriod(scenarioId: string, peace: PeaceFeed | null): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from('scenarios')
    .select('initial_state')
    .eq('id', scenarioId)
    .maybeSingle<{ initial_state: Record<string, unknown> | null }>();
  if (error || !data) {
    throw new Error(error?.message || 'Scenario not found');
  }
  const next = { ...(data.initial_state ?? {}) };
  if (peace) next.peace_period = peace;
  else delete next.peace_period;
  const { error: updateError } = await supabaseAdmin
    .from('scenarios')
    .update({ initial_state: next })
    .eq('id', scenarioId);
  if (updateError) throw new Error(updateError.message);
}

export function createPeaceFeedRouter(deps: PeaceFeedRouteDeps): Router {
  const router = Router({ mergeParams: true });

  async function gate(
    req: AuthenticatedRequest,
    res: Response,
    write: boolean,
  ): Promise<{ user: NonNullable<AuthenticatedRequest['user']>; row: PeaceScenarioRow } | null> {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Missing authorization header' });
      return null;
    }
    if (!deps.periodEnabled()) {
      unavailable(res);
      return null;
    }
    if (user.role !== 'trainer' && user.role !== 'admin') {
      res.status(403).json({ error: 'Access denied' });
      return null;
    }
    const owner = await deps.assertOwner(req.params.id, user);
    if (!owner.ok) {
      res.status(owner.status).json({ error: owner.error });
      return null;
    }
    const row = await deps.loadScenario(req.params.id);
    if (!row) {
      res.status(404).json({ error: 'Scenario not found' });
      return null;
    }
    if (row.category !== SOCIAL) {
      unavailable(res);
      return null;
    }
    if (write) {
      const editability = await deps.canEdit(req.params.id, user);
      if (!editability.editable) {
        locked(res, editability.reason);
        return null;
      }
    }
    return { user, row };
  }

  router.get('/', deps.authMiddleware, validate(scenarioParams), async (req, res) => {
    try {
      const opened = await gate(req as AuthenticatedRequest, res, false);
      if (!opened) return;
      const feed = usablePeaceFeed(opened.row.initial_state?.peace_period);
      res.json({ data: { peace_period: feed } });
    } catch (err) {
      logger.error({ err }, 'Peace feed read failed');
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  router.post('/', deps.authMiddleware, validate(scenarioParams), async (req, res) => {
    try {
      const opened = await gate(req as AuthenticatedRequest, res, true);
      if (!opened) return;
      const initial = opened.row.initial_state ?? {};
      const previous = usablePeaceFeed(initial.peace_period);
      const personas = Array.isArray(initial.npc_personas) ? initial.npc_personas : [];
      const seconds =
        previous && previous.seconds >= PEACE_OFFSET_TAIL_SECONDS
          ? previous.seconds
          : PEACE_PERIOD_DEFAULT_SECONDS;
      const result = await deps.generate({
        cast: castFromParts(personas, initial.org_page),
        crisisBrief: crisisBriefForLeakTerms({
          narrative: initial.description,
          briefing: initial.briefing,
          confirmedFacts: confirmedFacts(initial),
        }),
        seconds,
        enabled: previous ? previous.enabled !== false : true,
      });
      const feed = result.ok ? usablePeaceFeed(result.feed) : null;
      if (!feed) {
        const warning = result.ok ? 'Peace feed was not stored.' : result.warning;
        logger.warn({ scenarioId: req.params.id, warning }, 'peace feed regenerate stored nothing new');
        res.json({ data: { peace_period: previous, warning, generated: false } });
        return;
      }
      await deps.savePeacePeriod(req.params.id, feed);
      res.json({ data: { peace_period: feed, warning: null, generated: true } });
    } catch (err) {
      logger.error({ err }, 'Peace feed generation failed');
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  router.patch('/', deps.authMiddleware, validate(patchBody), async (req, res) => {
    try {
      const opened = await gate(req as AuthenticatedRequest, res, true);
      if (!opened) return;
      const current = usablePeaceFeed(opened.row.initial_state?.peace_period);
      if (!current) {
        res.status(409).json({
          error: 'Generate a peace feed before changing its settings.',
          code: 'PEACE_FEED_MISSING',
        });
        return;
      }
      const body = req.body as { seconds?: number; enabled?: boolean };
      const next: PeaceFeed = {
        ...current,
        ...(body.seconds !== undefined ? { seconds: body.seconds } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      };
      await deps.savePeacePeriod(req.params.id, next);
      res.json({ data: { peace_period: next } });
    } catch (err) {
      logger.error({ err }, 'Peace feed update failed');
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  return router;
}

export const peaceFeedRouter = createPeaceFeedRouter({
  periodEnabled: () => env.enablePeacePeriod,
  authMiddleware: requireAuth,
  assertOwner: assertScenarioOwner,
  canEdit: canEditScenario,
  loadScenario: loadScenarioRow,
  savePeacePeriod,
  generate: (input) => generatePeaceFeed(input),
});
