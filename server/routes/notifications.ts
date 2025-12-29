import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { validate } from '../lib/validation.js';
import {
  markNotificationAsRead,
  markAllNotificationsAsRead,
  getUnreadNotificationCount,
} from '../services/notificationService.js';

const router = Router();

const markReadSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

// Get notifications for current user
router.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    const { session_id, read, limit = 50 } = req.query;

    let query = supabaseAdmin
      .from('notifications')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(Number(limit));

    if (session_id) {
      query = query.eq('session_id', session_id as string);
    }

    if (read !== undefined) {
      query = query.eq('read', read === 'true');
    }

    const { data, error } = await query;

    if (error) {
      logger.error({ error, userId: user.id }, 'Failed to fetch notifications');
      return res.status(500).json({ error: 'Failed to fetch notifications' });
    }

    res.json({ data: data || [] });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /notifications');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get unread notification count
router.get('/unread/count', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    const { session_id } = req.query;

    const count = await getUnreadNotificationCount(
      user.id,
      session_id ? (session_id as string) : undefined,
    );

    res.json({ count });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /notifications/unread/count');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mark notification as read
router.post(
  '/:id/read',
  requireAuth,
  validate(markReadSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const user = req.user!;

      const success = await markNotificationAsRead(id, user.id);

      if (!success) {
        return res.status(500).json({ error: 'Failed to mark notification as read' });
      }

      res.json({ success: true });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /notifications/:id/read');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Mark all notifications as read
router.post('/read-all', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    const { session_id } = req.body;

    const success = await markAllNotificationsAsRead(user.id, session_id);

    if (!success) {
      return res.status(500).json({ error: 'Failed to mark all notifications as read' });
    }

    res.json({ success: true });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /notifications/read-all');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as notificationsRouter };
