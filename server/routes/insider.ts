import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { validate } from '../lib/validation.js';
import {
  classifyInsiderQuestion,
  buildSliceAnswer,
  buildMapOnlyResponse,
  type InsiderKnowledgeBlob,
} from '../services/insiderService.js';
import { getWebSocketService } from '../services/websocketService.js';
import { io } from '../index.js';
import { logAndBroadcastEvent } from '../services/eventService.js';

const router = Router();

// Restore sessionId from parent router (nested router overwrites req.params)
router.use((req, _res, next) => {
  const sessionId = (req as { insiderSessionId?: string }).insiderSessionId;
  if (sessionId) req.params.sessionId = sessionId;
  next();
});

const askSchema = z.object({
  params: z.object({
    sessionId: z.string().uuid(),
  }),
  body: z.object({
    content: z.string().min(1).max(2000),
    channel_id: z.string().uuid().optional(),
  }),
});

// Mounted at /:sessionId/insider so sessionId is in req.params
router.post(
  '/ask',
  (req, _res, next) => {
    const sid = (req as { insiderSessionId?: string }).insiderSessionId;
    if (sid) req.params.sessionId = sid;
    next();
  },
  requireAuth,
  validate(askSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const sessionId = req.params.sessionId;
      const user = req.user!;
      const { content, channel_id } = req.body;

      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('id, scenario_id, trainer_id')
        .eq('id', sessionId)
        .single();

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.trainer_id !== user.id && user.role !== 'admin') {
        const { data: participant } = await supabaseAdmin
          .from('session_participants')
          .select('user_id')
          .eq('session_id', sessionId)
          .eq('user_id', user.id)
          .single();
        if (!participant) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }

      const { data: scenario } = await supabaseAdmin
        .from('scenarios')
        .select('insider_knowledge, vicinity_map_url, layout_image_url')
        .eq('id', session.scenario_id)
        .single();

      if (!scenario) {
        return res.status(404).json({ error: 'Scenario not found' });
      }

      const knowledge = (scenario.insider_knowledge as InsiderKnowledgeBlob) || {};
      if (scenario.vicinity_map_url) knowledge.vicinity_map_url = scenario.vicinity_map_url;
      if (scenario.layout_image_url) knowledge.layout_image_url = scenario.layout_image_url;

      const category = classifyInsiderQuestion(content);
      const isMapRequest = category === 'map';
      const { answer, sources_used } = isMapRequest
        ? buildMapOnlyResponse(knowledge)
        : buildSliceAnswer(knowledge, category);

      const answerSnippet = answer.length > 500 ? answer.slice(0, 497) + '...' : answer;

      try {
        await supabaseAdmin.from('session_insider_qa').insert({
          session_id: sessionId,
          asked_by: user.id,
          channel_id: channel_id ?? null,
          question_text: content,
          category,
          answer_snippet: answerSnippet,
          sources_used,
        });
      } catch (qaErr) {
        logger.warn({ error: qaErr, sessionId }, 'Failed to insert session_insider_qa');
      }

      if (channel_id) {
        const { data: channel } = await supabaseAdmin
          .from('chat_channels')
          .select('id, session_id')
          .eq('id', channel_id)
          .single();

        if (channel) {
          const senderId = session.trainer_id;
          const { data: insertedMessage, error: insertError } = await supabaseAdmin
            .from('chat_messages')
            .insert({
              channel_id: channel_id,
              session_id: channel.session_id,
              sender_id: senderId,
              content: `**[Insider]**\n\n${answer}`,
              type: 'text',
            })
            .select('*')
            .single();

          if (!insertError && insertedMessage) {
            try {
              getWebSocketService().messageSent(channel_id, insertedMessage);
            } catch (wsErr) {
              logger.warn(
                { error: wsErr, channelId: channel_id },
                'Failed to broadcast Insider reply',
              );
            }
            try {
              await logAndBroadcastEvent(
                io,
                channel.session_id,
                'message',
                {
                  channel_id,
                  message_id: insertedMessage.id,
                  sender: { id: senderId, full_name: 'Insider', role: 'trainer' },
                  content: insertedMessage.content,
                },
                senderId,
              );
            } catch (eventErr) {
              logger.warn({ error: eventErr }, 'Failed to log Insider message event');
            }
          }
        }
      }

      res.json({
        data: {
          answer,
          category,
          sources_used,
        },
      });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /sessions/:sessionId/insider/ask');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// GET history: list session_insider_qa for this session (same access as /ask)
router.get(
  '/history',
  (req, _res, next) => {
    const sid = (req as { insiderSessionId?: string }).insiderSessionId;
    if (sid) req.params.sessionId = sid;
    next();
  },
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const sessionId = req.params.sessionId;
      const user = req.user!;

      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('id, trainer_id')
        .eq('id', sessionId)
        .single();

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.trainer_id !== user.id && user.role !== 'admin') {
        const { data: participant } = await supabaseAdmin
          .from('session_participants')
          .select('user_id')
          .eq('session_id', sessionId)
          .eq('user_id', user.id)
          .single();
        if (!participant) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }

      const { data: rows, error } = await supabaseAdmin
        .from('session_insider_qa')
        .select('id, question_text, answer_snippet, asked_at, category')
        .eq('session_id', sessionId)
        .order('asked_at', { ascending: true })
        .limit(100);

      if (error) {
        logger.warn({ error, sessionId }, 'Failed to fetch session_insider_qa history');
        return res.status(500).json({ error: 'Failed to load history' });
      }

      return res.json({ data: rows ?? [] });
    } catch (err) {
      logger.error({ error: err }, 'Error in GET /sessions/:sessionId/insider/history');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export { router as insiderRouter };
