import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { assertSessionAccess } from '../lib/access.js';

const router = Router();

function stripZoneGroundTruth(hazard: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...hazard };
  delete copy.zones;
  return copy;
}

// GET /sessions/:id/hazards — list hazards visible at current game time
router.get('/sessions/:id/hazards', requireAuth, async (req, res) => {
  try {
    const { id: sessionId } = req.params;
    const user = (req as AuthenticatedRequest).user;
    if (!user?.id) return res.status(401).json({ error: 'Not authenticated' });

    // Get session to find scenario_id and elapsed time
    const access = await assertSessionAccess(
      sessionId,
      user,
      'scenario_id, start_time, current_state',
    );
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const session = access.session as unknown as {
      scenario_id: string;
      start_time: string | null;
      current_state: unknown;
    };

    const elapsedMinutes = session.start_time
      ? Math.floor((Date.now() - new Date(session.start_time).getTime()) / 60000)
      : 0;

    // Fetch hazards: scenario-level (session_id IS NULL) + session-level
    const { data: hazards, error } = await supabaseAdmin
      .from('scenario_hazards')
      .select('*')
      .eq('session_id', sessionId)
      .eq('scenario_id', session.scenario_id)
      .lte('appears_at_minutes', elapsedMinutes)
      .order('appears_at_minutes', { ascending: true });

    if (error) {
      logger.error({ error, sessionId }, 'Failed to fetch hazards');
      return res.status(500).json({ error: 'Failed to fetch hazards' });
    }

    // For time-evolving hazards, pick the current image from the sequence
    const enriched = (hazards ?? []).map((h) => {
      const seq = h.image_sequence as Array<{
        at_minutes: number;
        image_url: string;
        description: string;
      }> | null;
      if (seq?.length) {
        const currentFrame = [...seq]
          .filter((f) => f.at_minutes <= elapsedMinutes)
          .sort((a, b) => b.at_minutes - a.at_minutes)[0];
        if (currentFrame) {
          return {
            ...h,
            current_image_url: currentFrame.image_url,
            current_description: currentFrame.description,
          };
        }
      }
      return { ...h, current_image_url: h.image_url, current_description: null };
    });

    const includeZones = req.query.include_zones === 'true';
    const responseData = includeZones ? enriched : enriched.map(stripZoneGroundTruth);
    return res.json({ data: responseData, elapsed_minutes: elapsedMinutes });
  } catch (err) {
    logger.error({ err }, 'Unexpected error in GET hazards');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /sessions/:id/hazards/:hazardId — get single hazard detail
router.get('/sessions/:id/hazards/:hazardId', requireAuth, async (req, res) => {
  try {
    const { id: sessionId, hazardId } = req.params;
    const user = (req as AuthenticatedRequest).user;
    if (!user?.id) return res.status(401).json({ error: 'Not authenticated' });

    const access = await assertSessionAccess(sessionId, user);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const { data: hazard, error } = await supabaseAdmin
      .from('scenario_hazards')
      .select('*')
      .eq('id', hazardId)
      .eq('session_id', sessionId)
      .single();

    if (error || !hazard) {
      return res.status(404).json({ error: 'Hazard not found' });
    }

    return res.json({ data: stripZoneGroundTruth(hazard as Record<string, unknown>) });
  } catch (err) {
    logger.error({ err }, 'Unexpected error in GET hazard detail');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
