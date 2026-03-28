import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';

const router = Router();

router.get('/sessions/:id/equipment', requireAuth, async (req, res) => {
  try {
    const { id: sessionId } = req.params;

    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id')
      .eq('id', sessionId)
      .single();

    if (!session) return res.status(404).json({ error: 'Session not found' });

    const { data: equipment, error } = await supabaseAdmin
      .from('scenario_equipment')
      .select('*')
      .eq('scenario_id', session.scenario_id)
      .order('equipment_type');

    if (error) {
      logger.error({ error, sessionId }, 'Failed to fetch equipment');
      return res.status(500).json({ error: 'Failed to fetch equipment' });
    }

    return res.json({ data: equipment ?? [] });
  } catch (err) {
    logger.error({ err }, 'Unexpected error in GET equipment');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
