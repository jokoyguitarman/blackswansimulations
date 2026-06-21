import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from '../services/websocketService.js';
import { assertSessionAccess, assertTeamMembership } from '../lib/access.js';

const router = Router();

router.post('/sessions/:id/locations/:locationId/claim', requireAuth, async (req, res) => {
  try {
    const { id: sessionId, locationId } = req.params;
    const user = (req as AuthenticatedRequest).user;
    if (!user?.id) return res.status(401).json({ error: 'Not authenticated' });

    const { team_name, claimed_as, claim_exclusivity } = req.body as {
      team_name: string;
      claimed_as: string;
      claim_exclusivity?: string;
    };

    if (!team_name || !claimed_as) {
      return res.status(400).json({ error: 'team_name and claimed_as are required' });
    }

    // Caller must belong to the session and may only claim for a team they're on.
    const access = await assertSessionAccess(sessionId, user);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const teamCheck = await assertTeamMembership(sessionId, user, team_name);
    if (!teamCheck.ok) return res.status(teamCheck.status).json({ error: teamCheck.error });

    const { data: loc, error: fetchError } = await supabaseAdmin
      .from('scenario_locations')
      .select('*')
      .eq('id', locationId)
      .single();

    if (fetchError || !loc) {
      return res.status(404).json({ error: 'Location not found' });
    }

    // Check for existing claim in THIS session (not on the shared scenario_locations row)
    const { data: existingClaim } = await supabaseAdmin
      .from('session_location_claims')
      .select('id, claimed_by_team, claimed_as')
      .eq('session_id', sessionId)
      .eq('location_id', locationId)
      .maybeSingle();

    if (existingClaim) {
      return res.status(409).json({
        error: `Already claimed by ${existingClaim.claimed_by_team} as ${existingClaim.claimed_as}`,
      });
    }

    const claimable = (loc.claimable_by as string[]) ?? [];
    if (claimable.length > 0 && !claimable.includes('all') && !claimable.includes(team_name)) {
      return res.status(403).json({ error: `${team_name} cannot claim this location` });
    }

    const claimRow: Record<string, unknown> = {
      session_id: sessionId,
      location_id: locationId,
      claimed_by_team: team_name,
      claimed_as,
    };
    if (claim_exclusivity === 'exclusive' || claim_exclusivity === 'shared') {
      claimRow.claim_exclusivity = claim_exclusivity;
    }

    const { error: insertError } = await supabaseAdmin
      .from('session_location_claims')
      .insert(claimRow);

    if (insertError) {
      logger.error({ error: insertError, locationId, sessionId }, 'Failed to claim location');
      return res.status(500).json({ error: 'Failed to claim location' });
    }

    // Return location data merged with the claim for frontend compatibility
    const merged = {
      ...loc,
      claimed_by_team: team_name,
      claimed_as,
      claim_exclusivity: claimRow.claim_exclusivity ?? null,
    };

    try {
      getWebSocketService().locationClaimed(sessionId, merged);
    } catch (wsErr) {
      logger.warn({ error: wsErr, sessionId, locationId }, 'Failed to broadcast location.claimed');
    }

    return res.json({ data: merged });
  } catch (err) {
    logger.error({ err }, 'Unexpected error in POST location claim');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
