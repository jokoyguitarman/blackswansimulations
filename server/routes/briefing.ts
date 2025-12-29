import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { validate, schemas } from '../lib/validation.js';

const router = Router();

// Get briefing for a session (participants only)
router.get(
  '/session/:id',
  requireAuth,
  validate(schemas.id),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const user = req.user!;

      // Get session and verify access
      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('scenario_id, trainer_id')
        .eq('id', id)
        .single();

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Check if user has access (trainer or participant)
      if (session.trainer_id !== user.id && user.role !== 'admin') {
        const { data: participant } = await supabaseAdmin
          .from('session_participants')
          .select('role')
          .eq('session_id', id)
          .eq('user_id', user.id)
          .single();

        if (!participant) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }

      // Get scenario with briefing
      const { data: scenario } = await supabaseAdmin
        .from('scenarios')
        .select('briefing, role_specific_briefs, title, description')
        .eq('id', session.scenario_id)
        .single();

      if (!scenario) {
        return res.status(404).json({ error: 'Scenario not found' });
      }

      // Get user's role in this session
      let userRole: string | null = null;
      if (session.trainer_id !== user.id && user.role !== 'admin') {
        const { data: participant } = await supabaseAdmin
          .from('session_participants')
          .select('role')
          .eq('session_id', id)
          .eq('user_id', user.id)
          .single();
        userRole = participant?.role || null;
      }

      // Get role-specific briefing if available
      const roleSpecificBrief =
        userRole && scenario.role_specific_briefs
          ? (scenario.role_specific_briefs as Record<string, string>)[userRole] || null
          : null;

      res.json({
        data: {
          general_briefing: scenario.briefing || scenario.description,
          role_specific_briefing: roleSpecificBrief,
          scenario_title: scenario.title,
          user_role: userRole,
        },
      });
    } catch (err) {
      logger.error({ error: err }, 'Error in GET /briefing/session/:id');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export { router as briefingRouter };
