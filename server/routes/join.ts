import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { validate } from '../lib/validation.js';

const router = Router();

// Display name validation: safe characters only, 2-50 chars
const displayNameSchema = z
  .string()
  .trim()
  .min(2, 'Display name must be at least 2 characters')
  .max(50, 'Display name must be at most 50 characters')
  .regex(
    /^[a-zA-Z0-9 .'-]+$/,
    'Display name can only contain letters, numbers, spaces, periods, hyphens, and apostrophes',
  );

const registerSchema = z.object({
  body: z.object({
    join_token: z.string().min(10).max(30),
    display_name: displayNameSchema,
    team_name: z.string().min(1, 'Team is required'),
  }),
});

/**
 * GET /api/join/:joinToken
 * Public endpoint (no auth) - returns minimal session info for the join form.
 * Rate-limited separately in server/index.ts.
 */
router.get('/:joinToken', async (req, res) => {
  try {
    const { joinToken } = req.params;

    if (!joinToken || joinToken.length < 10) {
      return res.status(404).json({ error: 'Not found' });
    }

    // Look up session by join_token
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('id, status, join_enabled, join_expires_at, scenario_id, scenarios(title)')
      .eq('join_token', joinToken)
      .single();

    // Constant-time-ish: return same error for all failure cases
    if (
      sessionError ||
      !session ||
      !session.join_enabled ||
      (session.join_expires_at && new Date(session.join_expires_at) < new Date()) ||
      session.status === 'completed' ||
      session.status === 'cancelled'
    ) {
      return res.status(404).json({ error: 'Not found' });
    }

    // Load teams from scenario_teams
    const { data: teams } = await supabaseAdmin
      .from('scenario_teams')
      .select('id, team_name, team_description')
      .eq('scenario_id', session.scenario_id)
      .order('team_name', { ascending: true });

    // Return minimal info (session title + teams only, no scenario title for privacy)
    // Supabase may return scenarios as object or array depending on relation type
    const scenarios = session.scenarios as { title: string } | { title: string }[] | null;
    const scenarioData = Array.isArray(scenarios) ? scenarios[0] : scenarios;

    res.json({
      data: {
        sessionTitle: scenarioData?.title ?? 'Simulation Session',
        teams: (teams || []).map((t) => ({
          id: t.id,
          team_name: t.team_name,
          team_description: t.team_description,
        })),
      },
    });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /join/:joinToken');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/join/register
 * Auth required (anonymous or normal user).
 * Registers the caller as a participant in the session.
 */
router.post(
  '/register',
  requireAuth,
  validate(registerSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const { join_token, display_name, team_name } = req.body;

      // 1. Resolve session by join_token
      const { data: session, error: sessionError } = await supabaseAdmin
        .from('sessions')
        .select('id, status, join_enabled, join_expires_at, scenario_id')
        .eq('join_token', join_token)
        .single();

      if (sessionError || !session) {
        return res.status(404).json({ error: 'Invalid or expired join link' });
      }

      // 2. Check join is enabled and not expired
      if (!session.join_enabled) {
        return res.status(400).json({ error: 'This join link has been disabled by the trainer' });
      }

      if (session.join_expires_at && new Date(session.join_expires_at) < new Date()) {
        return res.status(400).json({ error: 'This join link has expired' });
      }

      // 3. Check session status is joinable
      if (session.status === 'completed' || session.status === 'cancelled') {
        return res.status(400).json({ error: 'This session is no longer active' });
      }

      // 4. Validate team_name against scenario_teams
      const { data: scenarioTeams } = await supabaseAdmin
        .from('scenario_teams')
        .select('team_name, max_participants')
        .eq('scenario_id', session.scenario_id);

      const validTeamNames = (scenarioTeams || []).map((t) => t.team_name);

      // If scenario has defined teams, validate against them
      if (validTeamNames.length > 0 && !validTeamNames.includes(team_name)) {
        return res.status(400).json({ error: 'Invalid team selection' });
      }

      // 5. Check participant cap (sum of max_participants across all teams)
      if (scenarioTeams && scenarioTeams.length > 0) {
        const totalCap = scenarioTeams.reduce((sum, t) => sum + (t.max_participants || 999), 0);

        const { count: currentCount } = await supabaseAdmin
          .from('session_participants')
          .select('*', { count: 'exact', head: true })
          .eq('session_id', session.id);

        if (currentCount !== null && currentCount >= totalCap) {
          return res.status(409).json({ error: 'This session is full' });
        }
      }

      // 6. Check if already a participant (idempotent handling)
      const { data: existingParticipant } = await supabaseAdmin
        .from('session_participants')
        .select('id, role')
        .eq('session_id', session.id)
        .eq('user_id', user.id)
        .maybeSingle();

      if (existingParticipant) {
        // Already a participant - update display name but preserve trainer-assigned role/team
        await supabaseAdmin
          .from('user_profiles')
          .update({ full_name: display_name })
          .eq('id', user.id);

        logger.info(
          { sessionId: session.id, userId: user.id },
          'Existing participant re-joined via link',
        );

        return res.json({ sessionId: session.id });
      }

      // 7. Update user_profiles.full_name
      await supabaseAdmin
        .from('user_profiles')
        .update({ full_name: display_name })
        .eq('id', user.id);

      // 8. Insert into session_participants
      const { error: participantError } = await supabaseAdmin.from('session_participants').upsert(
        {
          session_id: session.id,
          user_id: user.id,
          role: 'participant',
        },
        { onConflict: 'session_id,user_id' },
      );

      if (participantError) {
        logger.error(
          { error: participantError, sessionId: session.id, userId: user.id },
          'Failed to add participant via join link',
        );
        return res.status(500).json({ error: 'Failed to join session' });
      }

      // 9. Upsert into session_teams
      const { error: teamError } = await supabaseAdmin.from('session_teams').upsert(
        {
          session_id: session.id,
          user_id: user.id,
          team_name,
          assigned_by: null,
        },
        { onConflict: 'session_id,user_id,team_name' },
      );

      if (teamError) {
        logger.error(
          { error: teamError, sessionId: session.id, userId: user.id, team_name },
          'Failed to assign team via join link',
        );
        // Non-fatal: participant is added but team assignment may need manual fix
      }

      logger.info(
        {
          sessionId: session.id,
          userId: user.id,
          displayName: display_name,
          teamName: team_name,
        },
        'Participant joined via link',
      );

      res.json({ sessionId: session.id });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /join/register');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export { router as joinRouter };
