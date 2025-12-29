import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { validate } from '../lib/validation.js';

const router = Router();

// Schema for team assignment
const assignTeamSchema = z.object({
  params: z.object({
    id: z.string().uuid(), // session_id
  }),
  body: z.object({
    user_id: z.string().uuid(),
    team_name: z.string().min(1),
    team_role: z.string().optional(),
  }),
});

const removeTeamAssignmentSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    user_id: z.string().uuid(),
    team_name: z.string().min(1),
  }),
});

// Get team assignments for a session
router.get('/session/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const user = req.user!;

    // Verify session exists and user has access
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('id, trainer_id')
      .eq('id', id)
      .single();

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Users can see their own assignments, trainers/admins can see all
    if (session.trainer_id !== user.id && user.role !== 'admin') {
      // Check if user is a participant
      const { data: participant } = await supabaseAdmin
        .from('session_participants')
        .select('*')
        .eq('session_id', id)
        .eq('user_id', user.id)
        .single();

      if (!participant) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Regular users only see their own assignments
      const { data: assignments, error } = await supabaseAdmin
        .from('session_teams')
        .select('*')
        .eq('session_id', id)
        .eq('user_id', user.id);

      if (error) {
        logger.error(
          { error, sessionId: id, errorCode: error.code, errorMessage: error.message },
          'Failed to fetch team assignments',
        );
        return res.status(500).json({ error: 'Failed to fetch team assignments' });
      }

      // Fetch user data separately
      if (assignments && assignments.length > 0) {
        const userIds = [...new Set(assignments.map((a: any) => a.user_id))];
        const { data: users } = await supabaseAdmin
          .from('user_profiles')
          .select('id, full_name, role')
          .in('id', userIds);

        const userMap = new Map(users?.map((u: any) => [u.id, u]) || []);
        const assignmentsWithUsers = assignments.map((a: any) => ({
          ...a,
          user: userMap.get(a.user_id) || null,
        }));

        return res.json({ data: assignmentsWithUsers });
      }

      return res.json({ data: assignments || [] });
    }

    // Trainers/admins see all assignments
    const { data: assignments, error } = await supabaseAdmin
      .from('session_teams')
      .select('*')
      .eq('session_id', id)
      .order('team_name', { ascending: true })
      .order('assigned_at', { ascending: true });

    if (error) {
      logger.error(
        {
          error,
          sessionId: id,
          errorCode: error.code,
          errorMessage: error.message,
          errorDetails: error.details,
          errorHint: error.hint,
        },
        'Failed to fetch team assignments',
      );
      return res.status(500).json({ error: 'Failed to fetch team assignments' });
    }

    // Fetch user data separately
    if (assignments && assignments.length > 0) {
      const userIds = [...new Set(assignments.map((a: any) => a.user_id))];
      const { data: users } = await supabaseAdmin
        .from('user_profiles')
        .select('id, full_name, role')
        .in('id', userIds);

      const userMap = new Map(users?.map((u: any) => [u.id, u]) || []);
      const assignmentsWithUsers = assignments.map((a: any) => ({
        ...a,
        user: userMap.get(a.user_id) || null,
      }));

      return res.json({ data: assignmentsWithUsers });
    }

    res.json({ data: assignments || [] });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /teams/session/:id');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Assign user to a team
router.post(
  '/session/:id/assign',
  requireAuth,
  validate(assignTeamSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const user = req.user!;
      const { user_id, team_name, team_role } = req.body;

      // Only trainers and admins can assign teams
      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can assign teams' });
      }

      // Verify session exists and user is trainer
      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('id, trainer_id')
        .eq('id', id)
        .single();

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.trainer_id !== user.id && user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Verify user is a participant in the session
      const { data: participant } = await supabaseAdmin
        .from('session_participants')
        .select('*')
        .eq('session_id', id)
        .eq('user_id', user_id)
        .single();

      if (!participant) {
        return res.status(400).json({ error: 'User is not a participant in this session' });
      }

      // Insert or update team assignment
      const { data: assignment, error } = await supabaseAdmin
        .from('session_teams')
        .upsert(
          {
            session_id: id,
            user_id,
            team_name,
            team_role: team_role || null,
            assigned_by: user.id,
          },
          {
            onConflict: 'session_id,user_id,team_name',
          },
        )
        .select()
        .single();

      if (error) {
        logger.error(
          { error, sessionId: id, userId: user_id, teamName: team_name },
          'Failed to assign team',
        );
        return res.status(500).json({ error: 'Failed to assign team' });
      }

      logger.info(
        { sessionId: id, userId: user_id, teamName: team_name, assignedBy: user.id },
        'Team assignment created',
      );

      res.status(201).json({ data: assignment });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /teams/session/:id/assign');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Remove team assignment
router.delete(
  '/session/:id/assign',
  requireAuth,
  validate(removeTeamAssignmentSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const user = req.user!;
      const { user_id, team_name } = req.body;

      // Only trainers and admins can remove team assignments
      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can remove team assignments' });
      }

      // Verify session exists and user is trainer
      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('id, trainer_id')
        .eq('id', id)
        .single();

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.trainer_id !== user.id && user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Delete team assignment
      const { error } = await supabaseAdmin
        .from('session_teams')
        .delete()
        .eq('session_id', id)
        .eq('user_id', user_id)
        .eq('team_name', team_name);

      if (error) {
        logger.error(
          { error, sessionId: id, userId: user_id, teamName: team_name },
          'Failed to remove team assignment',
        );
        return res.status(500).json({ error: 'Failed to remove team assignment' });
      }

      logger.info(
        { sessionId: id, userId: user_id, teamName: team_name, removedBy: user.id },
        'Team assignment removed',
      );

      res.json({ success: true, message: 'Team assignment removed' });
    } catch (err) {
      logger.error({ error: err }, 'Error in DELETE /teams/session/:id/assign');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Get scenario teams (team definitions for a scenario)
router.get('/scenario/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const user = req.user!;

    // Verify scenario exists
    const { data: scenario } = await supabaseAdmin
      .from('scenarios')
      .select('id, created_by')
      .eq('id', id)
      .single();

    if (!scenario) {
      return res.status(404).json({ error: 'Scenario not found' });
    }

    // Check access - trainers/admins or scenario creator
    if (scenario.created_by !== user.id && user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data: teams, error } = await supabaseAdmin
      .from('scenario_teams')
      .select('*')
      .eq('scenario_id', id)
      .order('team_name', { ascending: true });

    if (error) {
      logger.error({ error, scenarioId: id }, 'Failed to fetch scenario teams');
      return res.status(500).json({ error: 'Failed to fetch scenario teams' });
    }

    res.json({ data: teams || [] });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /teams/scenario/:id');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create scenario team definition
router.post(
  '/scenario/:id',
  requireAuth,
  validate(
    z.object({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({
        team_name: z.string().min(1),
        team_description: z.string().optional(),
        required_roles: z.array(z.string()).optional(),
        min_participants: z.number().int().positive().optional(),
        max_participants: z.number().int().positive().optional(),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const user = req.user!;
      const { team_name, team_description, required_roles, min_participants, max_participants } =
        req.body;

      // Only trainers and admins can create team definitions
      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can create team definitions' });
      }

      // Verify scenario exists
      const { data: scenario } = await supabaseAdmin
        .from('scenarios')
        .select('id, created_by')
        .eq('id', id)
        .single();

      if (!scenario) {
        return res.status(404).json({ error: 'Scenario not found' });
      }

      if (scenario.created_by !== user.id && user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { data: team, error } = await supabaseAdmin
        .from('scenario_teams')
        .insert({
          scenario_id: id,
          team_name,
          team_description: team_description || null,
          required_roles: required_roles || null,
          min_participants: min_participants || 1,
          max_participants: max_participants || null,
        })
        .select()
        .single();

      if (error) {
        logger.error(
          { error, scenarioId: id, teamName: team_name },
          'Failed to create scenario team',
        );
        return res.status(500).json({ error: 'Failed to create scenario team' });
      }

      logger.info(
        { scenarioId: id, teamName: team_name, userId: user.id },
        'Scenario team created',
      );

      res.status(201).json({ data: team });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /teams/scenario/:id');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export { router as teamsRouter };
