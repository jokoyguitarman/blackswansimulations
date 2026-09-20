import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { requireAuth, requireStaff, type AuthenticatedRequest } from '../middleware/auth.js';
import { validate } from '../lib/validation.js';
import { assertSessionOwner } from '../lib/access.js';
import { addBot, removeBot } from '../services/teammates/enrol.js';
import { getTeammateBotService } from '../services/teammates/teammateBotService.js';
import { clampIntellect } from '../services/teammates/intellect.js';
import { getWebSocketService } from '../services/websocketService.js';

/**
 * AI teammate controls for one session (docs/ai-teammate-bots-plan.md §6.2).
 * Mounted at /api/sessions/:id/bots with mergeParams. Trainer/admin only; the
 * caller must own the session. Every route 404s when the feature is off so the
 * lobby can hide its card.
 */

const router = Router({ mergeParams: true });

const idParams = z.object({ id: z.string().uuid() });

router.use((req, res, next) => {
  if (!env.enableTeammateBots) {
    res.status(404).json({ error: 'AI teammates are not enabled' });
    return;
  }
  next();
});

router.use(requireAuth, requireStaff);

async function ownerGuard(
  req: AuthenticatedRequest,
): Promise<{ ok: true; sessionId: string } | { ok: false; status: number; error: string }> {
  const sessionId = String(req.params.id ?? '');
  const parsed = idParams.safeParse({ id: sessionId });
  if (!parsed.success) return { ok: false, status: 400, error: 'Invalid session id' };
  const access = await assertSessionOwner(sessionId, req.user!);
  if (!access.ok) return access;
  return { ok: true, sessionId };
}

// GET /  — bots, slider, runtime status
router.get('/', async (req: AuthenticatedRequest, res) => {
  try {
    const guard = await ownerGuard(req);
    if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
    const view = await getTeammateBotService().view(guard.sessionId);
    res.json({ data: view });
  } catch (err) {
    logger.error({ err }, 'Error in GET /sessions/:id/bots');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST / { team_name } — add one bot to a team
router.post(
  '/',
  validate(z.object({ body: z.object({ team_name: z.string().trim().min(1).max(120) }) })),
  async (req: AuthenticatedRequest, res) => {
    try {
      const guard = await ownerGuard(req);
      if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
      const result = await addBot(guard.sessionId, req.body.team_name, req.user!.id);
      if (!result.ok) {
        const status =
          result.error.code === 'not_found'
            ? 404
            : result.error.code === 'db'
              ? 500
              : result.error.code === 'cap' || result.error.code === 'team_full'
                ? 409
                : 400;
        return res.status(status).json({ error: result.error.message, code: result.error.code });
      }
      void getTeammateBotService().onBotsChanged(guard.sessionId);
      res.status(201).json({ data: result.bot });
    } catch (err) {
      logger.error({ err }, 'Error in POST /sessions/:id/bots');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// PATCH /settings { intellect } — the one slider
router.patch(
  '/settings',
  validate(z.object({ body: z.object({ intellect: z.number().int().min(0).max(100) }) })),
  async (req: AuthenticatedRequest, res) => {
    try {
      const guard = await ownerGuard(req);
      if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
      const intellect = clampIntellect(req.body.intellect);
      const { error } = await supabaseAdmin
        .from('sessions')
        .update({ bot_intellect: intellect })
        .eq('id', guard.sessionId);
      if (error) {
        logger.error({ error, sessionId: guard.sessionId }, 'Failed to update bot_intellect');
        return res.status(500).json({ error: 'Failed to update setting' });
      }
      getTeammateBotService().onIntellectChanged(guard.sessionId, intellect);
      try {
        getWebSocketService().broadcastToSession(guard.sessionId, {
          type: 'teammate_bots.settings_updated',
          data: { intellect },
          timestamp: new Date().toISOString(),
        });
      } catch {
        /* non-critical */
      }
      res.json({ data: { intellect } });
    } catch (err) {
      logger.error({ err }, 'Error in PATCH /sessions/:id/bots/settings');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// `validate` replaces req.params with the parsed object, so the merged session id must be listed too.
const userParam = z.object({
  params: z.object({ id: z.string().uuid(), userId: z.string().uuid() }),
});

// DELETE /:userId — remove a bot
router.delete('/:userId', validate(userParam), async (req: AuthenticatedRequest, res) => {
  try {
    const guard = await ownerGuard(req);
    if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
    const botUserId = String(req.params.userId);
    getTeammateBotService().stopBot(guard.sessionId, botUserId);
    const result = await removeBot(guard.sessionId, botUserId);
    if (!result.ok) {
      return res
        .status(result.error.code === 'not_found' ? 404 : 500)
        .json({ error: result.error.message, code: result.error.code });
    }
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Error in DELETE /sessions/:id/bots/:userId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:userId/pause | /resume
router.post('/:userId/pause', validate(userParam), async (req: AuthenticatedRequest, res) => {
  try {
    const guard = await ownerGuard(req);
    if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
    const ok = getTeammateBotService().pause(guard.sessionId, String(req.params.userId));
    if (!ok) return res.status(409).json({ error: 'That AI teammate is not running' });
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Error in POST /sessions/:id/bots/:userId/pause');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:userId/resume', validate(userParam), async (req: AuthenticatedRequest, res) => {
  try {
    const guard = await ownerGuard(req);
    if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
    const ok = getTeammateBotService().resume(guard.sessionId, String(req.params.userId));
    if (!ok) return res.status(409).json({ error: 'That AI teammate is not running' });
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Error in POST /sessions/:id/bots/:userId/resume');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:userId/nudge { text } — trainer instruction, also posted to the bot's team chat
router.post(
  '/:userId/nudge',
  validate(
    z.object({
      params: z.object({ id: z.string().uuid(), userId: z.string().uuid() }),
      body: z.object({ text: z.string().trim().min(1).max(600) }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    try {
      const guard = await ownerGuard(req);
      if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
      const botUserId = String(req.params.userId);
      const text = String(req.body.text);
      const ok = getTeammateBotService().nudge(guard.sessionId, botUserId, text);
      if (!ok) return res.status(409).json({ error: 'That AI teammate is not running' });

      // Mirror the instruction into the bot's team channel so the human team sees it too.
      try {
        const { data: teamRow } = await supabaseAdmin
          .from('session_teams')
          .select('team_name')
          .eq('session_id', guard.sessionId)
          .eq('user_id', botUserId)
          .limit(1)
          .maybeSingle();
        const teamName = (teamRow as { team_name?: string } | null)?.team_name;
        if (teamName) {
          const { data: channel } = await supabaseAdmin
            .from('chat_channels')
            .select('id')
            .eq('session_id', guard.sessionId)
            .eq('type', 'team')
            .eq('team_name', teamName)
            .maybeSingle();
          if (channel?.id) {
            const { data: message } = await supabaseAdmin
              .from('chat_messages')
              .insert({
                channel_id: channel.id,
                session_id: guard.sessionId,
                sender_id: req.user!.id,
                content: text,
                type: 'text',
              })
              .select('*, sender:user_profiles!chat_messages_sender_id_fkey(id, full_name, role)')
              .single();
            if (message)
              getWebSocketService().messageSent(
                String(channel.id),
                message as Record<string, unknown>,
              );
          }
        }
      } catch (mirrorErr) {
        logger.debug({ err: mirrorErr }, 'teammates: nudge mirror to chat failed');
      }
      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'Error in POST /sessions/:id/bots/:userId/nudge');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export { router as teammateBotsRouter };
