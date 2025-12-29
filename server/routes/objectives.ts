import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import {
  getObjectiveProgress,
  calculateSessionScore,
  updateObjectiveProgress,
  addObjectivePenalty,
  addObjectiveBonus,
  initializeSessionObjectives,
} from '../services/objectiveTrackingService.js';

const router = Router();

// Get objective progress for a session
router.get('/session/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
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

    const progress = await getObjectiveProgress(sessionId);
    res.json({ data: progress });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /objectives/session/:sessionId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get session score
router.get('/session/:sessionId/score', requireAuth, async (req: AuthenticatedRequest, res) => {
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

    const score = await calculateSessionScore(sessionId);
    res.json({ data: score });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /objectives/session/:sessionId/score');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Initialize objectives for a session (trainer only)
router.post(
  '/session/:sessionId/initialize',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const { sessionId } = req.params;
      const user = req.user!;

      // Only trainers can initialize objectives
      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can initialize objectives' });
      }

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
        return res.status(403).json({ error: 'Access denied' });
      }

      await initializeSessionObjectives(sessionId);
      res.json({ success: true, message: 'Objectives initialized' });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /objectives/session/:sessionId/initialize');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Update objective progress (trainer only, or for automated tracking)
router.post('/session/:sessionId/update', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
    const { objective_id, progress_percentage, status, metrics, objective_name } = req.body;
    const user = req.user!;

    // Only trainers can manually update objectives
    if (user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Only trainers can update objectives' });
    }

    if (!objective_id || typeof progress_percentage !== 'number') {
      return res.status(400).json({ error: 'objective_id and progress_percentage required' });
    }

    await updateObjectiveProgress(sessionId, objective_id, progress_percentage, {
      status,
      metrics,
      objectiveName: objective_name,
    });

    res.json({ success: true });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /objectives/session/:sessionId/update');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as objectivesRouter };
