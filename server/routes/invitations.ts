import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';

const router = Router();

/**
 * Get invitation details by token (public endpoint - no auth required)
 * Used for signup flow when user clicks invitation link
 */
router.get('/:token', async (req, res) => {
  try {
    const { token } = req.params;

    if (!token) {
      return res.status(400).json({ error: 'Invitation token required' });
    }

    // Get invitation details
    const { data: invitation, error } = await supabaseAdmin
      .from('session_invitations')
      .select(
        `
        *,
        sessions!inner(
          id,
          scenarios:scenarios!inner(
            title
          ),
          trainer:user_profiles!sessions_trainer_id_fkey(
            full_name
          )
        )
      `,
      )
      .eq('invitation_token', token)
      .eq('status', 'pending')
      .single();

    if (error || !invitation) {
      logger.warn({ error, token }, 'Invitation not found or invalid');
      return res.status(404).json({ error: 'Invitation not found or expired' });
    }

    // Check if invitation is expired
    if (new Date(invitation.expires_at) < new Date()) {
      logger.warn({ token, expiresAt: invitation.expires_at }, 'Invitation expired');
      return res.status(410).json({ error: 'Invitation has expired' });
    }

    const session = invitation.sessions as {
      id: string;
      scenarios: { title: string };
      trainer: { full_name: string };
    };

    res.json({
      data: {
        email: invitation.email,
        role: invitation.role,
        sessionTitle: session.scenarios.title,
        scenarioTitle: session.scenarios.title,
        trainerName: session.trainer.full_name || 'Trainer',
        sessionId: session.id,
      },
    });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /invitations/:token');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as invitationsRouter };
