import { Router } from 'express';
import { requireAuth, requireStaff, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';

const router = Router();

// Trainer dashboard tiles. Same visibility as GET /api/scenarios and GET /api/sessions:
// trainers count their own scenarios and sessions, admins count everyone's.
router.get('/stats', requireAuth, requireStaff, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    const { data, error } = await supabaseAdmin
      .rpc('dashboard_stats', { p_trainer_id: user.role === 'admin' ? null : user.id })
      .single();

    if (error || !data) {
      logger.error({ error, userId: user.id }, 'Failed to load dashboard stats');
      return res.status(500).json({ error: 'Failed to load dashboard stats' });
    }

    const row = data as {
      scenarios: number;
      total_sessions: number;
      active_sessions: number;
      participants: number;
    };
    res.json({
      data: {
        scenarios: Number(row.scenarios),
        activeSessions: Number(row.active_sessions),
        totalSessions: Number(row.total_sessions),
        participants: Number(row.participants),
      },
    });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /dashboard/stats');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as dashboardRouter };
