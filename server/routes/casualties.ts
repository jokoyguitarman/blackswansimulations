import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { hasMarshalProximity } from '../services/exitFlowService.js';

const router = Router();

router.get('/sessions/:id/casualties', requireAuth, async (req, res) => {
  try {
    const { id: sessionId } = req.params;

    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id, started_at')
      .eq('id', sessionId)
      .single();

    if (!session) return res.status(404).json({ error: 'Session not found' });

    const elapsedMinutes = session.started_at
      ? Math.floor((Date.now() - new Date(session.started_at).getTime()) / 60000)
      : 0;

    const { data: casualties, error } = await supabaseAdmin
      .from('scenario_casualties')
      .select('*')
      .or(`session_id.is.null,session_id.eq.${sessionId}`)
      .eq('scenario_id', session.scenario_id)
      .lte('appears_at_minutes', elapsedMinutes)
      .order('appears_at_minutes', { ascending: true });

    if (error) {
      logger.error({ error, sessionId }, 'Failed to fetch casualties');
      return res.status(500).json({ error: 'Failed to fetch casualties' });
    }

    return res.json({ data: casualties ?? [], elapsed_minutes: elapsedMinutes });
  } catch (err) {
    logger.error({ err }, 'Unexpected error in GET casualties');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/sessions/:id/casualties/:casualtyId', requireAuth, async (req, res) => {
  try {
    const { casualtyId } = req.params;

    const { data: casualty, error } = await supabaseAdmin
      .from('scenario_casualties')
      .select('*')
      .eq('id', casualtyId)
      .single();

    if (error || !casualty) {
      return res.status(404).json({ error: 'Casualty not found' });
    }

    return res.json({ data: casualty });
  } catch (err) {
    logger.error({ err }, 'Unexpected error in GET casualty detail');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/sessions/:id/casualties/:casualtyId', requireAuth, async (req, res) => {
  try {
    const { casualtyId } = req.params;
    const { status, assigned_team, linked_decision_id, location_lat, location_lng, conditions } =
      req.body as {
        status?: string;
        assigned_team?: string;
        linked_decision_id?: string;
        location_lat?: number;
        location_lng?: number;
        conditions?: Record<string, unknown>;
      };

    const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (status) updatePayload.status = status;
    if (assigned_team !== undefined) updatePayload.assigned_team = assigned_team;
    if (linked_decision_id !== undefined) updatePayload.linked_decision_id = linked_decision_id;
    if (location_lat !== undefined) updatePayload.location_lat = location_lat;
    if (location_lng !== undefined) updatePayload.location_lng = location_lng;
    if (conditions !== undefined) updatePayload.conditions = conditions;

    if (
      !updatePayload.status &&
      !updatePayload.assigned_team &&
      !updatePayload.linked_decision_id &&
      location_lat === undefined &&
      location_lng === undefined &&
      conditions === undefined
    ) {
      return res.status(400).json({ error: 'No update fields provided' });
    }

    const { data: updated, error } = await supabaseAdmin
      .from('scenario_casualties')
      .update(updatePayload)
      .eq('id', casualtyId)
      .select()
      .single();

    if (error) {
      logger.error({ error, casualtyId }, 'Failed to update casualty');
      return res.status(500).json({ error: 'Failed to update casualty' });
    }

    return res.json({ data: updated });
  } catch (err) {
    logger.error({ err }, 'Unexpected error in PATCH casualty');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/sessions/:id/marshal-check', requireAuth, async (req, res) => {
  try {
    const { id: sessionId } = req.params;
    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);

    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ error: 'lat and lng query params required' });
    }

    const hasMarshal = await hasMarshalProximity(sessionId, lat, lng);
    return res.json({ data: { has_marshal: hasMarshal } });
  } catch (err) {
    logger.error({ err }, 'Unexpected error in GET marshal-check');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
