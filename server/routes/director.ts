import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { validate } from '../lib/validation.js';
import { assertSessionOwner } from '../lib/access.js';
import { logger } from '../lib/logger.js';
import { directorCommands, replayStoredSession } from '../services/director/directorService.js';
import {
  type ApproveEdits,
  type CommandResult,
  type DirectorCommands,
} from '../services/director/directorConsole.js';

const APPS = [
  'email',
  'group_chat',
  'phone_call',
  'npc_dm',
  'messenger_dm',
  'social_feed',
  'news',
] as const;

const sessionParams = z.object({ params: z.object({ id: z.string().uuid() }) });
const patchBody = z.object({
  body: z
    .object({
      mode: z.enum(['off', 'suggest', 'auto']).optional(),
      pause: z.boolean().optional(),
    })
    .refine((body) => body.mode != null || body.pause != null, { message: 'mode or pause is required' }),
});
const approveBody = z.object({
  params: z.object({ id: z.string().uuid(), pid: z.string().uuid() }),
  body: z
    .object({
      title: z.string().min(1).max(120).optional(),
      content: z.string().min(1).max(1200).optional(),
      target_teams: z.array(z.string().min(1)).max(8).optional(),
      app: z.enum(APPS).optional(),
      severity: z.enum(['low', 'medium', 'high']).optional(),
      response_rubric: z
        .object({
          asks: z.array(z.string()),
          criteria: z.array(z.string()),
          expected_tone: z.array(z.string()),
          pass_threshold: z.number(),
        })
        .strict()
        .nullable()
        .optional(),
      fairness_override_reason: z.string().min(1).max(500).optional(),
    })
    .optional()
    .default({}),
});
const vetoBody = z.object({
  params: z.object({ id: z.string().uuid(), pid: z.string().uuid() }),
  body: z.object({ reason: z.string().max(500).optional() }).optional().default({}),
});
const requestBody = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z
    .object({
      team: z.string().min(1).max(120).optional(),
      hint: z.string().max(300).optional(),
    })
    .optional()
    .default({}),
});
const snoozeBody = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    team: z.string().min(1).max(120),
    minutes: z.number().int().min(1).max(60).optional(),
  }),
});

export interface DirectorRouterDeps {
  auth: RequestHandler;
  access: (
    sessionId: string,
    user: { id: string; role?: string },
  ) => Promise<{ ok: true } | { ok: false; status: number; error: string }>;
  commands: DirectorCommands;
  replay: typeof replayStoredSession;
}

function isStaff(role: string | undefined): boolean {
  return role === 'admin' || role === 'trainer';
}

function send(res: { status: (code: number) => { json: (body: unknown) => void } }, result: CommandResult): void {
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(result.status).json(result.body);
}

export function createDirectorRouter(deps: DirectorRouterDeps): Router {
  const router = Router();

  router.get('/:id/director/replay', deps.auth, validate(sessionParams), async (req: AuthenticatedRequest, res) => {
    try {
      if (!isStaff(req.user?.role)) return res.status(403).json({ error: 'Access denied' });
      const access = await deps.access(req.params.id, req.user!);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      const report = await deps.replay(req.params.id);
      res.json({ data: report });
    } catch (err) {
      logger.error({ err }, 'GET /sessions/:id/director/replay failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/:id/director', deps.auth, validate(sessionParams), async (req: AuthenticatedRequest, res) => {
    try {
      if (!isStaff(req.user?.role)) return res.status(403).json({ error: 'Access denied' });
      const access = await deps.access(req.params.id, req.user!);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      send(res, await deps.commands.get(req.params.id));
    } catch (err) {
      logger.error({ err }, 'GET /sessions/:id/director failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch('/:id/director', deps.auth, validate(patchBody), async (req: AuthenticatedRequest, res) => {
    try {
      if (!isStaff(req.user?.role)) return res.status(403).json({ error: 'Access denied' });
      const access = await deps.access(req.params.id, req.user!);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      send(res, await deps.commands.patch(req.params.id, req.user!.id, req.body));
    } catch (err) {
      logger.error({ err }, 'PATCH /sessions/:id/director failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post(
    '/:id/director/proposals/:pid/approve',
    deps.auth,
    validate(approveBody),
    async (req: AuthenticatedRequest, res) => {
      try {
        if (!isStaff(req.user?.role)) return res.status(403).json({ error: 'Access denied' });
        const access = await deps.access(req.params.id, req.user!);
        if (!access.ok) return res.status(access.status).json({ error: access.error });
        send(
          res,
          await deps.commands.approve(
            req.params.id,
            req.params.pid,
            req.user!.id,
            (req.body ?? {}) as ApproveEdits,
          ),
        );
      } catch (err) {
        logger.error({ err }, 'POST /sessions/:id/director/proposals/:pid/approve failed');
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  );

  router.post(
    '/:id/director/proposals/:pid/veto',
    deps.auth,
    validate(vetoBody),
    async (req: AuthenticatedRequest, res) => {
      try {
        if (!isStaff(req.user?.role)) return res.status(403).json({ error: 'Access denied' });
        const access = await deps.access(req.params.id, req.user!);
        if (!access.ok) return res.status(access.status).json({ error: access.error });
        send(
          res,
          await deps.commands.veto(req.params.id, req.params.pid, req.user!.id, req.body?.reason),
        );
      } catch (err) {
        logger.error({ err }, 'POST /sessions/:id/director/proposals/:pid/veto failed');
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  );

  router.post('/:id/director/request', deps.auth, validate(requestBody), async (req: AuthenticatedRequest, res) => {
    try {
      if (!isStaff(req.user?.role)) return res.status(403).json({ error: 'Access denied' });
      const access = await deps.access(req.params.id, req.user!);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      send(res, await deps.commands.request(req.params.id, req.user!.id, req.body ?? {}));
    } catch (err) {
      logger.error({ err }, 'POST /sessions/:id/director/request failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/:id/director/snooze', deps.auth, validate(snoozeBody), async (req: AuthenticatedRequest, res) => {
    try {
      if (!isStaff(req.user?.role)) return res.status(403).json({ error: 'Access denied' });
      const access = await deps.access(req.params.id, req.user!);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      send(res, await deps.commands.snooze(req.params.id, req.body));
    } catch (err) {
      logger.error({ err }, 'POST /sessions/:id/director/snooze failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

function defaultDeps(): DirectorRouterDeps {
  return {
    auth: requireAuth as RequestHandler,
    async access(sessionId, user) {
      const result = await assertSessionOwner(sessionId, user);
      if (!result.ok) return result;
      return { ok: true };
    },
    commands: directorCommands,
    replay: replayStoredSession,
  };
}

export const directorRouter = createDirectorRouter(defaultDeps());
