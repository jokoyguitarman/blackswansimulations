import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from '../services/websocketService.js';

const router = Router();

router.post('/sessions/:id/locations/:locationId/claim', requireAuth, async (req, res) => {
  try {
    const { id: sessionId, locationId } = req.params;
    const { team_name, claimed_as, claim_exclusivity } = req.body as {
      team_name: string;
      claimed_as: string;
      claim_exclusivity?: string;
    };

    if (!team_name || !claimed_as) {
      return res.status(400).json({ error: 'team_name and claimed_as are required' });
    }

    const { data: loc, error: fetchError } = await supabaseAdmin
      .from('scenario_locations')
      .select('*')
      .eq('id', locationId)
      .single();

    if (fetchError || !loc) {
      return res.status(404).json({ error: 'Location not found' });
    }

    if (loc.claimed_by_team) {
      return res.status(409).json({
        error: `Already claimed by ${loc.claimed_by_team} as ${loc.claimed_as}`,
      });
    }

    const claimable = (loc.claimable_by as string[]) ?? [];
    if (claimable.length > 0 && !claimable.includes('all') && !claimable.includes(team_name)) {
      return res.status(403).json({ error: `${team_name} cannot claim this location` });
    }

    const updatePayload: Record<string, unknown> = {
      claimed_by_team: team_name,
      claimed_as,
    };
    if (claim_exclusivity === 'exclusive' || claim_exclusivity === 'shared') {
      updatePayload.claim_exclusivity = claim_exclusivity;
    }

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('scenario_locations')
      .update(updatePayload)
      .eq('id', locationId)
      .select()
      .single();

    if (updateError) {
      logger.error({ error: updateError, locationId }, 'Failed to claim location');
      return res.status(500).json({ error: 'Failed to claim location' });
    }

    try {
      getWebSocketService().locationClaimed(sessionId, updated as Record<string, unknown>);
    } catch (wsErr) {
      logger.warn({ error: wsErr, sessionId, locationId }, 'Failed to broadcast location.claimed');
    }

    return res.json({ data: updated });
  } catch (err) {
    logger.error({ err }, 'Unexpected error in POST location claim');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
