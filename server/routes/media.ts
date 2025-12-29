import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { validate, schemas } from '../lib/validation.js';
import { logAndBroadcastEvent } from '../services/eventService.js';
import { io } from '../index.js';

const router = Router();

const createMediaPostSchema = z.object({
  body: z.object({
    session_id: z.string().uuid(),
    source: z.string().min(1).max(200),
    headline: z.string().min(1).max(500),
    content: z.string().min(1),
    sentiment: z.enum(['positive', 'neutral', 'negative', 'critical']),
    is_misinformation: z.boolean().default(false),
  }),
});

// Get media posts for a session
router.get(
  '/session/:sessionId',
  requireAuth,
  validate(schemas.pagination),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { sessionId } = req.params;
      const { page, limit } = req.query;
      const offset = (Number(page) - 1) * Number(limit);
      const user = req.user!;

      // Verify session access
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
          .select('*')
          .eq('session_id', sessionId)
          .eq('user_id', user.id)
          .single();

        if (!participant) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }

      const { data, error, count } = await supabaseAdmin
        .from('media_posts')
        .select(
          'id, session_id, source, headline, content, sentiment, is_misinformation, created_at, platform, author, reach, engagement, ai_generated',
          { count: 'exact' },
        )
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .range(offset, offset + Number(limit) - 1);

      if (error) {
        logger.error({ error, sessionId }, 'Failed to fetch media posts');
        return res.status(500).json({ error: 'Failed to fetch media posts' });
      }

      res.json({
        data,
        count,
        page: Number(page),
        limit: Number(limit),
        totalPages: count ? Math.ceil(count / Number(limit)) : 0,
      });
    } catch (err) {
      logger.error({ error: err }, 'Error in GET /media/session/:sessionId');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Get sentiment snapshots for a session
router.get('/sentiment/session/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
    const user = req.user!;

    // Verify session access
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
        .select('*')
        .eq('session_id', sessionId)
        .eq('user_id', user.id)
        .single();

      if (!participant) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const { data, error } = await supabaseAdmin
      .from('sentiment_snapshots')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (error) {
      logger.error({ error, sessionId }, 'Failed to fetch sentiment snapshots');
      return res.status(500).json({ error: 'Failed to fetch sentiment snapshots' });
    }

    res.json({ data });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /media/sentiment/session/:sessionId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create media post (trainers only - for AI-generated content)
router.post(
  '/',
  requireAuth,
  validate(createMediaPostSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const { session_id, source, headline, content, sentiment, is_misinformation } = req.body;

      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can create media posts' });
      }

      // Map source to platform for backward compatibility
      // Derive platform from source name if possible, otherwise default to 'news'
      const platformMap: Record<string, string> = {
        'News Media': 'news',
        Twitter: 'twitter',
        Facebook: 'facebook',
        'Citizen Report': 'citizen_report',
        'Political News': 'news',
      };
      const platform = platformMap[source] || 'news';
      // Use source as author for backward compatibility (or could use a default)
      const author = source;

      const { data, error } = await supabaseAdmin
        .from('media_posts')
        .insert({
          session_id,
          source,
          headline,
          content,
          sentiment,
          is_misinformation,
          platform, // Keep for backward compatibility
          author, // Keep for backward compatibility
        })
        .select()
        .single();

      if (error) {
        logger.error({ error, userId: user.id }, 'Failed to create media post');
        return res.status(500).json({ error: 'Failed to create media post' });
      }

      // Log and broadcast event
      await logAndBroadcastEvent(
        io,
        session_id,
        'media_post',
        {
          media_id: data.id,
          source,
          headline,
          sentiment,
          is_misinformation,
        },
        user.id,
      );

      logger.info({ mediaId: data.id, userId: user.id }, 'Media post created');
      res.status(201).json({ data });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /media');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export { router as mediaRouter };
