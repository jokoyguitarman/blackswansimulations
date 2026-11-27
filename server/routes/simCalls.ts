import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { validate } from '../lib/validation.js';
import { assertSessionAccess } from '../lib/access.js';
import { callService, type CallActor, type CallApi } from '../services/calls/callService.js';

const capabilities = z.object({
  webrtc: z.boolean(),
  mic: z.boolean(),
});

const answerSchema = z.object({
  params: z.object({ callId: z.string().uuid() }),
  body: z.object({ capabilities }),
});

const attachSchema = z.object({
  params: z.object({ callId: z.string().uuid() }),
  body: z.object({
    openai_call_id: z.string().min(1).max(200),
    first_audio_ms: z.number().nonnegative().optional(),
  }),
});

const transcriptSchema = z.object({
  params: z.object({ callId: z.string().uuid() }),
  body: z.object({
    turns: z
      .array(
        z.object({
          seq: z.number().int().positive().optional(),
          speaker: z.enum(['npc', 'player', 'system']),
          text: z.string().min(1).max(4000),
          at: z.string().optional(),
        }),
      )
      .max(20),
  }),
});

const textSchema = z.object({
  params: z.object({ callId: z.string().uuid() }),
  body: z.object({ text: z.string().max(1000) }),
});

const callIdSchema = z.object({
  params: z.object({ callId: z.string().uuid() }),
});

const sessionSchema = z.object({
  params: z.object({ sessionId: z.string().uuid() }),
});

const stateSchema = z.object({
  params: z.object({ callId: z.string().uuid() }),
  body: z.object({ first_audio_ms: z.number().nonnegative() }),
});

export interface SimCallsRouterDeps {
  auth: RequestHandler;
  service: CallApi;
  access: (
    sessionId: string,
    user: CallActor,
  ) => Promise<{ ok: true } | { ok: false; status: number; error: string }>;
}

export function createSimCallsRouter(deps: SimCallsRouterDeps = defaultDeps()): Router {
  const router = Router();
  const auth = deps.auth;

  router.get('/session/:sessionId/badge', auth, validate(sessionSchema), async (req: AuthenticatedRequest, res) => {
    const actor = userOf(req);
    const access = await deps.access(req.params.sessionId, actor);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const body = await deps.service.badge(req.params.sessionId, actor);
    res.json(body);
  });

  router.post(
    '/session/:sessionId/recents-viewed',
    auth,
    validate(sessionSchema),
    async (req: AuthenticatedRequest, res) => {
      const actor = userOf(req);
      const access = await deps.access(req.params.sessionId, actor);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      await deps.service.markViewed(req.params.sessionId, actor);
      res.status(204).end();
    },
  );

  router.get('/session/:sessionId', auth, validate(sessionSchema), async (req: AuthenticatedRequest, res) => {
    const actor = userOf(req);
    const access = await deps.access(req.params.sessionId, actor);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const data = await deps.service.list(req.params.sessionId, actor);
    res.json({ data });
  });

  router.get('/:callId', auth, validate(callIdSchema), async (req: AuthenticatedRequest, res) => {
    const result = await deps.service.get(req.params.callId, userOf(req));
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    const access = await deps.access(result.body.session_id, userOf(req));
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    res.json({ data: result.body });
  });

  router.post('/:callId/answer', auth, validate(answerSchema), async (req: AuthenticatedRequest, res) => {
    const result = await guarded(deps, req, () =>
      deps.service.answer(req.params.callId, userOf(req), req.body.capabilities),
    );
    send(res, result);
  });

  router.post('/:callId/decline', auth, validate(callIdSchema), async (req: AuthenticatedRequest, res) => {
    const result = await guarded(deps, req, () => deps.service.decline(req.params.callId, userOf(req)));
    send(res, result);
  });

  router.post('/:callId/attach', auth, validate(attachSchema), async (req: AuthenticatedRequest, res) => {
    const result = await guarded(deps, req, () => deps.service.attach(req.params.callId, userOf(req), req.body));
    send(res, result);
  });

  router.post('/:callId/transcript', auth, validate(transcriptSchema), async (req: AuthenticatedRequest, res) => {
    const result = await guarded(deps, req, () =>
      deps.service.transcript(req.params.callId, userOf(req), req.body.turns),
    );
    send(res, result);
  });

  router.post('/:callId/text-turn', auth, validate(textSchema), async (req: AuthenticatedRequest, res) => {
    const result = await guarded(deps, req, () =>
      deps.service.textTurn(req.params.callId, userOf(req), req.body.text),
    );
    send(res, result);
  });

  router.post('/:callId/hangup', auth, validate(callIdSchema), async (req: AuthenticatedRequest, res) => {
    const result = await guarded(deps, req, () => deps.service.hangup(req.params.callId, userOf(req)));
    send(res, result);
  });

  router.post('/:callId/callback', auth, validate(answerSchema), async (req: AuthenticatedRequest, res) => {
    const result = await guarded(deps, req, () =>
      deps.service.callback(req.params.callId, userOf(req), req.body.capabilities),
    );
    send(res, result);
  });

  router.post('/:callId/state', auth, validate(stateSchema), async (req: AuthenticatedRequest, res) => {
    const result = await guarded(deps, req, () =>
      deps.service.reportAudio(req.params.callId, userOf(req), req.body.first_audio_ms),
    );
    send(res, result);
  });

  return router;
}

function userOf(req: AuthenticatedRequest): CallActor {
  return { id: req.user!.id, role: req.user?.role };
}

async function guarded(
  deps: SimCallsRouterDeps,
  req: AuthenticatedRequest,
  run: () => Promise<{ ok: true; status: number; body: unknown } | { ok: false; status: number; error: string }>,
) {
  const preview = await deps.service.get(req.params.callId, userOf(req));
  if (!preview.ok) return preview;
  const access = await deps.access(preview.body.session_id, userOf(req));
  if (!access.ok) return { ok: false as const, status: access.status, error: access.error };
  return run();
}

function send(
  res: { status: (code: number) => { json: (body: unknown) => void; end: () => void } },
  result: { ok: true; status: number; body: unknown } | { ok: false; status: number; error: string },
): void {
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  if (result.status === 204) {
    res.status(204).end();
    return;
  }
  res.status(result.status).json(result.body);
}

function defaultDeps(): SimCallsRouterDeps {
  return {
    auth: requireAuth as RequestHandler,
    service: callService,
    async access(sessionId, user) {
      const result = await assertSessionAccess(sessionId, user);
      if (!result.ok) return result;
      return { ok: true };
    },
  };
}

export const simCallsRouter = createSimCallsRouter();
