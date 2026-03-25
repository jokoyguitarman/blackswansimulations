import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';

const router = Router();

// GET /sessions/:id/floor-plans — list floor plans for the session's scenario
router.get('/sessions/:id/floor-plans', requireAuth, async (req, res) => {
  try {
    const { id: sessionId } = req.params;

    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id')
      .eq('id', sessionId)
      .single();

    if (!session) return res.status(404).json({ error: 'Session not found' });

    const { data: plans, error } = await supabaseAdmin
      .from('scenario_floor_plans')
      .select('*')
      .eq('scenario_id', session.scenario_id)
      .order('floor_level', { ascending: true });

    if (error) {
      logger.error({ error, sessionId }, 'Failed to fetch floor plans');
      return res.status(500).json({ error: 'Failed to fetch floor plans' });
    }

    return res.json({ data: plans ?? [] });
  } catch (err) {
    logger.error({ err }, 'Unexpected error in GET floor-plans');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /sessions/:id/floor-plans/:floorLevel — get a specific floor plan
router.get('/sessions/:id/floor-plans/:floorLevel', requireAuth, async (req, res) => {
  try {
    const { id: sessionId, floorLevel } = req.params;

    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id')
      .eq('id', sessionId)
      .single();

    if (!session) return res.status(404).json({ error: 'Session not found' });

    const { data: plan, error } = await supabaseAdmin
      .from('scenario_floor_plans')
      .select('*')
      .eq('scenario_id', session.scenario_id)
      .eq('floor_level', floorLevel)
      .single();

    if (error || !plan) {
      return res.status(404).json({ error: 'Floor plan not found' });
    }

    return res.json({ data: plan });
  } catch (err) {
    logger.error({ err }, 'Unexpected error in GET floor-plan detail');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
