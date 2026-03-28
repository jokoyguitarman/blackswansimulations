import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { hasMarshalProximity } from '../services/exitFlowService.js';

const router = Router();

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

router.get('/sessions/:id/casualties', requireAuth, async (req, res) => {
  try {
    const { id: sessionId } = req.params;

    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id, start_time')
      .eq('id', sessionId)
      .single();

    if (!session) return res.status(404).json({ error: 'Session not found' });

    const elapsedMinutes = session.start_time
      ? Math.floor((Date.now() - new Date(session.start_time).getTime()) / 60000)
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

/**
 * Triage assessment: player tags a casualty with a triage color at the scene.
 * Requires a medic/first-aider asset within proximity of the casualty.
 */
router.post('/sessions/:id/casualties/:casualtyId/assess', requireAuth, async (req, res) => {
  try {
    const { id: sessionId, casualtyId } = req.params;
    const { player_triage_color, team_name } = req.body as {
      player_triage_color: string;
      team_name: string;
    };

    const validColors = ['green', 'yellow', 'red', 'black'];
    if (!validColors.includes(player_triage_color)) {
      return res
        .status(400)
        .json({ error: `Invalid triage color. Must be one of: ${validColors.join(', ')}` });
    }
    if (!team_name) {
      return res.status(400).json({ error: 'team_name is required' });
    }

    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id, start_time')
      .eq('id', sessionId)
      .single();
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const elapsedMinutes = session.start_time
      ? Math.floor((Date.now() - new Date(session.start_time).getTime()) / 60000)
      : 0;

    const { data: casualty, error: casError } = await supabaseAdmin
      .from('scenario_casualties')
      .select('id, location_lat, location_lng, status, conditions')
      .eq('id', casualtyId)
      .single();

    if (casError || !casualty) {
      return res.status(404).json({ error: 'Casualty not found' });
    }

    // Check proximity: at least one medical-type asset within 80m
    const { data: nearbyAssets } = await supabaseAdmin
      .from('placed_assets')
      .select('id, asset_type, geometry')
      .eq('session_id', sessionId)
      .eq('status', 'active');

    const MEDIC_TYPES = [
      'medic',
      'paramedic',
      'doctor',
      'nurse',
      'emt',
      'first_aider',
      'triage_officer',
    ];
    let hasMedic = false;
    for (const asset of nearbyAssets ?? []) {
      const assetLower = (asset.asset_type as string).toLowerCase();
      if (!MEDIC_TYPES.some((t) => assetLower.includes(t))) continue;
      const geom = asset.geometry as Record<string, unknown>;
      if (geom.type === 'Point') {
        const coords = geom.coordinates as number[];
        const dist = haversineM(casualty.location_lat, casualty.location_lng, coords[1], coords[0]);
        if (dist < 80) {
          hasMedic = true;
          break;
        }
      }
    }

    if (!hasMedic) {
      return res.status(400).json({
        error:
          'No medical personnel within range. Deploy a medic or first aider near this casualty first.',
      });
    }

    const newStatus = casualty.status === 'undiscovered' ? 'identified' : casualty.status;

    const { data: updated, error } = await supabaseAdmin
      .from('scenario_casualties')
      .update({
        player_triage_color,
        assessed_by: team_name,
        assessed_at_minutes: elapsedMinutes,
        status: newStatus,
        updated_at: new Date().toISOString(),
      })
      .eq('id', casualtyId)
      .select()
      .single();

    if (error) {
      logger.error({ error, casualtyId }, 'Failed to assess casualty');
      return res.status(500).json({ error: 'Failed to update assessment' });
    }

    return res.json({ data: updated });
  } catch (err) {
    logger.error({ err }, 'Unexpected error in POST assess casualty');
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
