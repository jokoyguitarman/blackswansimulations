import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { validate, schemas } from '../lib/validation.js';
import { createDefaultChannels } from '../services/channelService.js';
import { sendInvitationEmail, sendPendingInvitationEmail } from '../services/emailService.js';
import { initializeSessionObjectives } from '../services/objectiveTrackingService.js';

const router = Router();

// Validation schemas
const createSessionSchema = z.object({
  body: z.object({
    scenario_id: z.string().uuid(),
    scheduled_start_time: z.string().datetime().optional(),
    trainer_instructions: z.string().max(5000).optional(),
  }),
});

const updateSessionSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    status: z.enum(['scheduled', 'in_progress', 'paused', 'completed', 'cancelled']).optional(),
    trainer_instructions: z.string().max(5000).optional(),
    scheduled_start_time: z.string().datetime().optional(),
    auto_complete_on_objectives: z.boolean().optional(),
  }),
});

const joinSessionSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    role: z.string(),
  }),
});

// Get all sessions
router.get(
  '/',
  requireAuth,
  validate(schemas.pagination),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const { page, limit } = req.query;
      const offset = (Number(page) - 1) * Number(limit);

      logger.info(
        {
          userId: user.id,
          role: user.role,
          page,
          limit,
          offset,
        },
        'Fetching sessions list',
      );

      let query = supabaseAdmin
        .from('sessions')
        .select(
          '*, scenarios(*), trainer:user_profiles!sessions_trainer_id_fkey(*), session_participants(*, user:user_profiles(*))',
          { count: 'exact' },
        )
        .order('created_at', { ascending: false });

      // Non-trainers only see sessions they're part of
      if (user.role !== 'trainer' && user.role !== 'admin') {
        logger.info(
          { userId: user.id },
          'Non-trainer: fetching sessions from session_participants',
        );
        const { data: participantSessions, error: participantError } = await supabaseAdmin
          .from('session_participants')
          .select('session_id')
          .eq('user_id', user.id);

        if (participantError) {
          logger.error(
            { error: participantError, userId: user.id },
            'Failed to fetch participant sessions',
          );
          return res.status(500).json({ error: 'Failed to fetch participant sessions' });
        }

        logger.info(
          {
            userId: user.id,
            participantSessionsCount: participantSessions?.length || 0,
            sessionIds: participantSessions?.map((p) => p.session_id) || [],
          },
          'Participant sessions found',
        );

        const sessionIds = participantSessions?.map((p) => p.session_id) || [];
        if (sessionIds.length > 0) {
          query = query.in('id', sessionIds);
        } else {
          // No sessions found, return empty result
          logger.info({ userId: user.id }, 'No participant sessions found, returning empty result');
          return res.json({
            data: [],
            count: 0,
            page: Number(page),
            limit: Number(limit),
            totalPages: 0,
          });
        }
      } else {
        logger.info({ userId: user.id, role: user.role }, 'Trainer/Admin: fetching all sessions');
      }

      // Apply pagination after filtering
      query = query.range(offset, offset + Number(limit) - 1);

      const { data, error, count } = await query;

      if (error) {
        logger.error(
          {
            error: error.message || error,
            errorCode: error.code,
            errorDetails: error.details,
            errorHint: error.hint,
            userId: user.id,
            role: user.role,
          },
          'Failed to fetch sessions - query error',
        );
        return res.status(500).json({
          error: 'Failed to fetch sessions',
          details: error.message || 'Unknown error',
          code: error.code,
        });
      }

      logger.info(
        {
          userId: user.id,
          role: user.role,
          sessionsCount: data?.length || 0,
          totalCount: count || 0,
          page,
          limit,
        },
        'Sessions fetched successfully',
      );

      res.json({
        data,
        count,
        page: Number(page),
        limit: Number(limit),
        totalPages: count ? Math.ceil(count / Number(limit)) : 0,
      });
    } catch (err) {
      logger.error(
        {
          error: err instanceof Error ? err.message : err,
          stack: err instanceof Error ? err.stack : undefined,
          userId: req.user?.id,
        },
        'Error in GET /sessions - exception',
      );
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Process accepted invitations for current user (fixes cases where trigger didn't run)
// MUST be before /:id routes
router.post('/process-invitations', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;

    // Get user email from request (set by auth middleware)
    const userEmail = user.email;

    if (!userEmail) {
      logger.warn({ userId: user.id }, 'processInvitations: User email not found in auth context');
      return res.status(400).json({ error: 'User email not found' });
    }

    // Normalize email to lowercase for case-insensitive matching
    const normalizedEmail = userEmail.toLowerCase().trim();

    logger.info(
      {
        userId: user.id,
        userEmail,
        normalizedEmail,
      },
      'Processing invitations for user',
    );

    // Find all pending OR accepted invitations for this email (case-insensitive)
    // Fetch all and filter in code since Supabase client doesn't support case-insensitive queries directly
    const { data: allInvitations, error: invitationsError } = await supabaseAdmin
      .from('session_invitations')
      .select('*')
      .in('status', ['pending', 'accepted'])
      .gt('expires_at', new Date().toISOString());

    if (invitationsError) {
      logger.error(
        {
          error: invitationsError,
          userId: user.id,
          userEmail: normalizedEmail,
        },
        'Failed to fetch invitations',
      );
      return res.status(500).json({ error: 'Failed to fetch invitations' });
    }

    // Filter invitations by email (case-insensitive)
    const invitations =
      allInvitations?.filter((inv) => inv.email?.toLowerCase().trim() === normalizedEmail) || [];

    logger.info(
      {
        userId: user.id,
        invitationCount: invitations?.length || 0,
        invitations:
          invitations?.map((inv) => ({
            id: inv.id,
            session_id: inv.session_id,
            email: inv.email,
            status: inv.status,
          })) || [],
      },
      'Found invitations for user',
    );

    if (!invitations || invitations.length === 0) {
      logger.info(
        {
          userId: user.id,
          userEmail: normalizedEmail,
        },
        'No invitations found for user',
      );
      return res.json({
        data: {
          processed: 0,
          message: 'No pending or accepted invitations found',
        },
      });
    }

    // Accept any pending invitations first
    const pendingInvitations = invitations.filter((inv) => inv.status === 'pending');
    if (pendingInvitations.length > 0) {
      // Update pending invitations (match by normalized email)
      const pendingInvitationIds = pendingInvitations.map((inv) => inv.id);
      if (pendingInvitationIds.length > 0) {
        const { error: updateError } = await supabaseAdmin
          .from('session_invitations')
          .update({
            status: 'accepted',
            accepted_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .in('id', pendingInvitationIds);

        if (updateError) {
          logger.error(
            { error: updateError, userId: user.id },
            'Failed to accept pending invitations',
          );
        } else {
          logger.info(
            { userId: user.id, count: pendingInvitations.length },
            'Accepted pending invitations',
          );
          // Update local invitation objects to reflect accepted status
          invitations.forEach((inv) => {
            if (inv.status === 'pending') {
              inv.status = 'accepted';
              inv.accepted_at = new Date().toISOString();
            }
          });
        }
      }
    }

    // Add user to sessions they were invited to (for both pending and accepted)
    const addedParticipants = [];
    for (const invitation of invitations) {
      const { data: existing, error: existingError } = await supabaseAdmin
        .from('session_participants')
        .select('*')
        .eq('session_id', invitation.session_id)
        .eq('user_id', user.id)
        .maybeSingle();

      if (existingError) {
        logger.error(
          {
            error: existingError,
            sessionId: invitation.session_id,
            userId: user.id,
          },
          'Error checking existing participant',
        );
        continue; // Skip this invitation if we can't check
      }

      if (!existing) {
        const { data: participant, error: participantError } = await supabaseAdmin
          .from('session_participants')
          .insert({
            session_id: invitation.session_id,
            user_id: user.id,
            role: invitation.role,
          })
          .select()
          .single();

        if (participantError) {
          logger.error(
            {
              error: participantError,
              sessionId: invitation.session_id,
              userId: user.id,
              invitationStatus: invitation.status,
            },
            'Failed to add participant',
          );
        } else {
          addedParticipants.push(participant);
          logger.info(
            {
              userId: user.id,
              sessionId: invitation.session_id,
              role: invitation.role,
            },
            'Added participant to session',
          );
        }
      } else {
        logger.debug(
          {
            userId: user.id,
            sessionId: invitation.session_id,
          },
          'Participant already exists in session',
        );
      }
    }

    logger.info(
      {
        userId: user.id,
        processed: addedParticipants.length,
        totalInvitations: invitations.length,
        pendingAccepted: pendingInvitations.length,
      },
      'Processed invitations',
    );

    res.json({
      data: {
        processed: addedParticipants.length,
        totalInvitations: invitations.length,
        pendingAccepted: pendingInvitations.length,
        participants: addedParticipants,
      },
    });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /sessions/process-invitations');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all users (for trainer to select participants) - MUST be before /:id routes
router.get('/users/available', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;

    // Only trainers can list users
    if (user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Only trainers can list users' });
    }

    const { data, error } = await supabaseAdmin
      .from('user_profiles')
      .select('id, full_name, email, role, agency_name')
      .order('full_name');

    if (error) {
      logger.error({ error, userId: user.id }, 'Failed to fetch users');
      return res.status(500).json({ error: 'Failed to fetch users' });
    }

    res.json({ data: data || [] });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /sessions/users/available');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single session
router.get('/:id', requireAuth, validate(schemas.id), async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const user = req.user!;

    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('*, scenarios(*), trainer:user_profiles!sessions_trainer_id_fkey(*)')
      .eq('id', id)
      .single();

    if (sessionError) {
      if (sessionError.code === 'PGRST116') {
        return res.status(404).json({ error: 'Session not found' });
      }
      logger.error({ error: sessionError, sessionId: id }, 'Failed to fetch session');
      return res.status(500).json({ error: 'Failed to fetch session' });
    }

    // Check if user has access
    if (user.role !== 'trainer' && user.role !== 'admin') {
      const { data: participant } = await supabaseAdmin
        .from('session_participants')
        .select('*')
        .eq('session_id', id)
        .eq('user_id', user.id)
        .single();

      if (!participant) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    // Get participants
    const { data: participants, error: participantsError } = await supabaseAdmin
      .from('session_participants')
      .select('*, user:user_profiles(*)')
      .eq('session_id', id);

    if (participantsError) {
      logger.error({ error: participantsError, sessionId: id }, 'Failed to fetch participants');
    }

    logger.info(
      {
        sessionId: id,
        userId: user.id,
        participantsCount: participants?.length || 0,
        participants:
          participants?.map((p) => ({
            user_id: p.user_id,
            role: p.role,
            user_name: p.user?.full_name || 'Unknown',
          })) || [],
      },
      'Session loaded with participants',
    );

    res.json({ data: { ...session, participants: participants || [] } });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /sessions/:id');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create session (trainers only)
router.post(
  '/',
  requireAuth,
  validate(createSessionSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const { scenario_id, scheduled_start_time, trainer_instructions } = req.body;

      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can create sessions' });
      }

      // Get scenario initial state
      const { data: scenario } = await supabaseAdmin
        .from('scenarios')
        .select('initial_state')
        .eq('id', scenario_id)
        .single();

      if (!scenario) {
        return res.status(404).json({ error: 'Scenario not found' });
      }

      const { data, error } = await supabaseAdmin
        .from('sessions')
        .insert({
          scenario_id,
          trainer_id: user.id,
          status: 'scheduled',
          current_state: scenario.initial_state || {},
          scheduled_start_time: scheduled_start_time || null,
          trainer_instructions: trainer_instructions || null,
        })
        .select()
        .single();

      if (error) {
        logger.error({ error, userId: user.id }, 'Failed to create session');
        return res.status(500).json({ error: 'Failed to create session' });
      }

      // Create default channels for the session
      await createDefaultChannels(data.id, user.id);

      logger.info({ sessionId: data.id, userId: user.id }, 'Session created');
      res.status(201).json({ data });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /sessions');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Update session status
router.patch(
  '/:id',
  requireAuth,
  validate(updateSessionSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const user = req.user!;
      const { status, trainer_instructions, scheduled_start_time, auto_complete_on_objectives } =
        req.body;

      // Check if user is trainer of this session
      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('trainer_id, start_time')
        .eq('id', id)
        .single();

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.trainer_id !== user.id && user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }

      const updates: Record<string, unknown> = {};
      if (status !== undefined) updates.status = status;
      if (trainer_instructions !== undefined) updates.trainer_instructions = trainer_instructions;
      if (scheduled_start_time !== undefined) updates.scheduled_start_time = scheduled_start_time;
      if (auto_complete_on_objectives !== undefined)
        updates.auto_complete_on_objectives = auto_complete_on_objectives;

      if (status === 'in_progress' && !session.start_time) {
        updates.start_time = new Date().toISOString();

        // Initialize objectives when session starts
        try {
          await initializeSessionObjectives(id);
        } catch (objectiveError) {
          // Don't block session start if objective initialization fails
          logger.error(
            { error: objectiveError, sessionId: id },
            'Failed to initialize session objectives, continuing with session start',
          );
        }
      }
      if (status === 'completed' || status === 'cancelled') {
        updates.end_time = new Date().toISOString();
      }

      const { data, error } = await supabaseAdmin
        .from('sessions')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) {
        logger.error({ error, sessionId: id }, 'Failed to update session');
        return res.status(500).json({ error: 'Failed to update session' });
      }

      logger.info({ sessionId: id, status, userId: user.id }, 'Session updated');
      res.json({ data });
    } catch (err) {
      logger.error({ error: err }, 'Error in PATCH /sessions/:id');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Add participant to session (trainer only)
const addParticipantSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    user_id: z.string().uuid(),
    role: z.enum([
      'defence',
      'health',
      'civil',
      'utilities',
      'intelligence',
      'ngo',
      'public_information_officer',
      'police_commander',
      'legal_oversight',
    ]),
  }),
});

router.post(
  '/:id/participants',
  requireAuth,
  validate(addParticipantSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const user = req.user!;
      const { user_id, role } = req.body;

      // Only trainers can add participants
      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can add participants' });
      }

      // Check if user is trainer of this session
      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('trainer_id, status')
        .eq('id', id)
        .single();

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.trainer_id !== user.id && user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Check if user exists
      const { data: targetUser } = await supabaseAdmin
        .from('user_profiles')
        .select('id')
        .eq('id', user_id)
        .single();

      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Check if already a participant
      const { data: existing } = await supabaseAdmin
        .from('session_participants')
        .select('*')
        .eq('session_id', id)
        .eq('user_id', user_id)
        .single();

      if (existing) {
        // Update role if already exists
        const { data, error } = await supabaseAdmin
          .from('session_participants')
          .update({ role })
          .eq('session_id', id)
          .eq('user_id', user_id)
          .select('*, user:user_profiles(*)')
          .single();

        if (error) {
          logger.error({ error, sessionId: id, userId: user_id }, 'Failed to update participant');
          return res.status(500).json({ error: 'Failed to update participant' });
        }

        logger.info(
          { sessionId: id, userId: user_id, role, trainerId: user.id },
          'Participant role updated',
        );
        return res.json({ data });
      }

      // Add participant
      const { data, error } = await supabaseAdmin
        .from('session_participants')
        .insert({
          session_id: id,
          user_id,
          role,
        })
        .select('*, user:user_profiles(*)')
        .single();

      if (error) {
        logger.error({ error, sessionId: id, userId: user_id }, 'Failed to add participant');
        return res.status(500).json({ error: 'Failed to add participant' });
      }

      logger.info(
        { sessionId: id, userId: user_id, role, trainerId: user.id },
        'Participant added',
      );

      // Get participant user details for email
      const { data: participantUser } = await supabaseAdmin
        .from('user_profiles')
        .select('email, full_name')
        .eq('id', user_id)
        .single();

      // Get session and trainer details for email
      const { data: sessionDetails } = await supabaseAdmin
        .from('sessions')
        .select('*, scenarios(title), trainer:user_profiles!sessions_trainer_id_fkey(full_name)')
        .eq('id', id)
        .single();

      // Send invitation email (non-blocking)
      if (participantUser?.email && sessionDetails) {
        sendInvitationEmail({
          to: participantUser.email,
          toName: participantUser.full_name || 'Participant',
          sessionTitle: sessionDetails.scenarios?.title || 'Simulation Session',
          scenarioTitle: sessionDetails.scenarios?.title || 'Unknown Scenario',
          assignedRole: role,
          sessionId: id,
          scheduledStartTime: sessionDetails.scheduled_start_time || undefined,
          trainerName: (sessionDetails.trainer as { full_name?: string })?.full_name || 'Trainer',
        }).catch((err) => {
          logger.error({ error: err }, 'Failed to send invitation email (non-blocking)');
        });
      }

      res.status(201).json({ data });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /sessions/:id/participants');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Remove participant from session (trainer only)
const removeParticipantSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
    userId: z.string().uuid(),
  }),
});

router.delete(
  '/:id/participants/:userId',
  requireAuth,
  validate(removeParticipantSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id, userId } = req.params;
      const user = req.user!;

      // Only trainers can remove participants
      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can remove participants' });
      }

      // Check if user is trainer of this session
      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('trainer_id')
        .eq('id', id)
        .single();

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.trainer_id !== user.id && user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { error } = await supabaseAdmin
        .from('session_participants')
        .delete()
        .eq('session_id', id)
        .eq('user_id', userId);

      if (error) {
        logger.error({ error, sessionId: id, userId }, 'Failed to remove participant');
        return res.status(500).json({ error: 'Failed to remove participant' });
      }

      logger.info({ sessionId: id, userId, trainerId: user.id }, 'Participant removed');
      res.json({ success: true });
    } catch (err) {
      logger.error({ error: err }, 'Error in DELETE /sessions/:id/participants/:userId');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Invite user by email (even if not registered)
const inviteByEmailSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    email: z.string().email(),
    role: z.enum([
      'defence',
      'health',
      'civil',
      'utilities',
      'intelligence',
      'ngo',
      'public_information_officer',
      'police_commander',
      'legal_oversight',
    ]),
  }),
});

router.post(
  '/:id/invite',
  requireAuth,
  validate(inviteByEmailSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const user = req.user!;
      const { email, role } = req.body;

      // Only trainers can invite
      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can invite participants' });
      }

      // Check if user is trainer of this session
      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('trainer_id, status')
        .eq('id', id)
        .single();

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.trainer_id !== user.id && user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Normalize email to lowercase for case-insensitive matching
      const normalizedInviteEmail = email.toLowerCase().trim();

      // Check if user already exists (case-insensitive email match)
      const { data: allUsers } = await supabaseAdmin.from('user_profiles').select('id, email');

      const existingUser = allUsers?.find(
        (u) => u.email?.toLowerCase().trim() === normalizedInviteEmail,
      );

      // If user exists, add them as participant directly
      if (existingUser) {
        // Check if already a participant
        const { data: existingParticipant } = await supabaseAdmin
          .from('session_participants')
          .select('*')
          .eq('session_id', id)
          .eq('user_id', existingUser.id)
          .single();

        if (existingParticipant) {
          // Update role if already exists
          const { data, error } = await supabaseAdmin
            .from('session_participants')
            .update({ role })
            .eq('session_id', id)
            .eq('user_id', existingUser.id)
            .select('*, user:user_profiles(*)')
            .single();

          if (error) {
            logger.error(
              { error, sessionId: id, userId: existingUser.id },
              'Failed to update participant',
            );
            return res.status(500).json({ error: 'Failed to update participant' });
          }

          // Send invitation email
          const { data: sessionDetails } = await supabaseAdmin
            .from('sessions')
            .select(
              '*, scenarios(title), trainer:user_profiles!sessions_trainer_id_fkey(full_name)',
            )
            .eq('id', id)
            .single();

          const { data: participantUser } = await supabaseAdmin
            .from('user_profiles')
            .select('email, full_name')
            .eq('id', existingUser.id)
            .single();

          if (participantUser?.email && sessionDetails) {
            sendInvitationEmail({
              to: participantUser.email,
              toName: participantUser.full_name || 'Participant',
              sessionTitle: sessionDetails.scenarios?.title || 'Simulation Session',
              scenarioTitle: sessionDetails.scenarios?.title || 'Unknown Scenario',
              assignedRole: role,
              sessionId: id,
              scheduledStartTime: sessionDetails.scheduled_start_time || undefined,
              trainerName:
                (sessionDetails.trainer as { full_name?: string })?.full_name || 'Trainer',
            }).catch((err) => {
              logger.error({ error: err }, 'Failed to send invitation email (non-blocking)');
            });
          }

          logger.info(
            { sessionId: id, userId: existingUser.id, role, trainerId: user.id },
            'Participant role updated via invite',
          );
          return res.json({ data, isNewUser: false });
        }

        // Add as new participant
        const { data, error } = await supabaseAdmin
          .from('session_participants')
          .insert({
            session_id: id,
            user_id: existingUser.id,
            role,
          })
          .select('*, user:user_profiles(*)')
          .single();

        if (error) {
          logger.error(
            { error, sessionId: id, userId: existingUser.id },
            'Failed to add participant',
          );
          return res.status(500).json({ error: 'Failed to add participant' });
        }

        // Send invitation email
        const { data: sessionDetails } = await supabaseAdmin
          .from('sessions')
          .select('*, scenarios(title), trainer:user_profiles!sessions_trainer_id_fkey(full_name)')
          .eq('id', id)
          .single();

        const { data: participantUser } = await supabaseAdmin
          .from('user_profiles')
          .select('email, full_name')
          .eq('id', existingUser.id)
          .single();

        if (participantUser?.email && sessionDetails) {
          sendInvitationEmail({
            to: participantUser.email,
            toName: participantUser.full_name || 'Participant',
            sessionTitle: sessionDetails.scenarios?.title || 'Simulation Session',
            scenarioTitle: sessionDetails.scenarios?.title || 'Unknown Scenario',
            assignedRole: role,
            sessionId: id,
            scheduledStartTime: sessionDetails.scheduled_start_time || undefined,
            trainerName: (sessionDetails.trainer as { full_name?: string })?.full_name || 'Trainer',
          }).catch((err) => {
            logger.error({ error: err }, 'Failed to send invitation email (non-blocking)');
          });
        }

        logger.info(
          { sessionId: id, userId: existingUser.id, role, trainerId: user.id },
          'Participant added via invite',
        );
        return res.json({ data, isNewUser: false });
      }

      // User doesn't exist - create pending invitation
      // Check if invitation already exists (case-insensitive)
      const { data: allInvitationsForSession } = await supabaseAdmin
        .from('session_invitations')
        .select('*')
        .eq('session_id', id)
        .eq('status', 'pending');

      const existingInvitation = allInvitationsForSession?.find(
        (inv) => inv.email?.toLowerCase().trim() === normalizedInviteEmail,
      );

      if (existingInvitation) {
        // Update existing invitation
        const { data, error } = await supabaseAdmin
          .from('session_invitations')
          .update({
            role,
            expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
            updated_at: new Date().toISOString(),
          })
          .eq('id', existingInvitation.id)
          .select()
          .single();

        if (error) {
          logger.error({ error, sessionId: id, email }, 'Failed to update invitation');
          return res.status(500).json({ error: 'Failed to update invitation' });
        }

        // Send invitation email
        const { data: sessionDetails } = await supabaseAdmin
          .from('sessions')
          .select('*, scenarios(title), trainer:user_profiles!sessions_trainer_id_fkey(full_name)')
          .eq('id', id)
          .single();

        if (sessionDetails && data) {
          sendPendingInvitationEmail({
            to: email,
            sessionTitle: sessionDetails.scenarios?.title || 'Simulation Session',
            scenarioTitle: sessionDetails.scenarios?.title || 'Unknown Scenario',
            assignedRole: role,
            invitationToken: data.invitation_token,
            scheduledStartTime: sessionDetails.scheduled_start_time || undefined,
            trainerName: (sessionDetails.trainer as { full_name?: string })?.full_name || 'Trainer',
          })
            .then((success) => {
              if (success) {
                logger.info({ email, sessionId: id }, 'Pending invitation email sent successfully');
              } else {
                logger.warn({ email, sessionId: id }, 'Pending invitation email failed to send');
              }
            })
            .catch((err) => {
              logger.error(
                { error: err, email, sessionId: id },
                'Failed to send pending invitation email (non-blocking)',
              );
            });
        } else {
          logger.warn(
            { sessionId: id, email, hasSessionDetails: !!sessionDetails, hasData: !!data },
            'Cannot send email - missing session details or invitation data',
          );
        }

        logger.info({ sessionId: id, email, role, trainerId: user.id }, 'Invitation updated');
        return res.json({ data, isNewUser: true });
      }

      // Create new invitation (store email in lowercase for consistent matching)
      const { data, error } = await supabaseAdmin
        .from('session_invitations')
        .insert({
          session_id: id,
          email: normalizedInviteEmail,
          role,
          invited_by: user.id,
        })
        .select()
        .single();

      if (error) {
        logger.error({ error, sessionId: id, email }, 'Failed to create invitation');
        return res.status(500).json({ error: 'Failed to create invitation' });
      }

      // Send invitation email
      const { data: sessionDetails } = await supabaseAdmin
        .from('sessions')
        .select('*, scenarios(title), trainer:user_profiles!sessions_trainer_id_fkey(full_name)')
        .eq('id', id)
        .single();

      if (sessionDetails && data) {
        sendPendingInvitationEmail({
          to: email,
          sessionTitle: sessionDetails.scenarios?.title || 'Simulation Session',
          scenarioTitle: sessionDetails.scenarios?.title || 'Unknown Scenario',
          assignedRole: role,
          invitationToken: data.invitation_token,
          scheduledStartTime: sessionDetails.scheduled_start_time || undefined,
          trainerName: (sessionDetails.trainer as { full_name?: string })?.full_name || 'Trainer',
        })
          .then((success) => {
            if (success) {
              logger.info({ email, sessionId: id }, 'Pending invitation email sent successfully');
            } else {
              logger.warn({ email, sessionId: id }, 'Pending invitation email failed to send');
            }
          })
          .catch((err) => {
            logger.error(
              { error: err, email, sessionId: id },
              'Failed to send pending invitation email (non-blocking)',
            );
          });
      } else {
        logger.warn(
          { sessionId: id, email, hasSessionDetails: !!sessionDetails, hasData: !!data },
          'Cannot send email - missing session details or invitation data',
        );
      }

      logger.info({ sessionId: id, email, role, trainerId: user.id }, 'Pending invitation created');
      res.status(201).json({ data, isNewUser: true });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /sessions/:id/invite');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Mark participant as ready
const markReadySchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    is_ready: z.boolean(),
  }),
});

router.post(
  '/:id/ready',
  requireAuth,
  validate(markReadySchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const user = req.user!;
      const { is_ready } = req.body;

      // Check if user is a participant
      const { data: participant } = await supabaseAdmin
        .from('session_participants')
        .select('*')
        .eq('session_id', id)
        .eq('user_id', user.id)
        .single();

      if (!participant) {
        return res.status(403).json({ error: 'You are not a participant in this session' });
      }

      // Update ready status
      const updates: Record<string, unknown> = { is_ready };

      // Set joined_lobby_at if first time joining lobby
      if (!participant.joined_lobby_at) {
        updates.joined_lobby_at = new Date().toISOString();
      }

      const { data, error } = await supabaseAdmin
        .from('session_participants')
        .update(updates)
        .eq('session_id', id)
        .eq('user_id', user.id)
        .select()
        .single();

      if (error) {
        logger.error({ error, sessionId: id, userId: user.id }, 'Failed to update ready status');
        return res.status(500).json({ error: 'Failed to update ready status' });
      }

      logger.info({ sessionId: id, userId: user.id, is_ready }, 'Participant ready status updated');
      res.json({ data });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /sessions/:id/ready');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Check if all participants are ready (for trainer)
router.get(
  '/:id/ready-status',
  requireAuth,
  validate(schemas.id),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const user = req.user!;

      // Only trainer can check ready status
      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('trainer_id')
        .eq('id', id)
        .single();

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.trainer_id !== user.id && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainer can check ready status' });
      }

      // Get all participants and their ready status
      const { data: participants } = await supabaseAdmin
        .from('session_participants')
        .select('user_id, is_ready, user:user_profiles(full_name)')
        .eq('session_id', id);

      const totalParticipants = participants?.length || 0;
      const readyParticipants = participants?.filter((p) => p.is_ready).length || 0;
      const allReady = totalParticipants > 0 && readyParticipants === totalParticipants;

      res.json({
        data: {
          total: totalParticipants,
          ready: readyParticipants,
          all_ready: allReady,
          participants: participants || [],
        },
      });
    } catch (err) {
      logger.error({ error: err }, 'Error in GET /sessions/:id/ready-status');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Join session (self-join for non-trainers)
router.post(
  '/:id/join',
  requireAuth,
  validate(joinSessionSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const user = req.user!;
      const { role } = req.body;

      // Check if session exists and is joinable
      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('status')
        .eq('id', id)
        .single();

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.status === 'completed' || session.status === 'cancelled') {
        return res.status(400).json({ error: 'Session is not active' });
      }

      // Check if already joined
      const { data: existing } = await supabaseAdmin
        .from('session_participants')
        .select('*')
        .eq('session_id', id)
        .eq('user_id', user.id)
        .single();

      if (existing) {
        return res.status(400).json({ error: 'Already joined this session' });
      }

      // Add participant
      const { data, error } = await supabaseAdmin
        .from('session_participants')
        .insert({
          session_id: id,
          user_id: user.id,
          role,
        })
        .select()
        .single();

      if (error) {
        logger.error({ error, sessionId: id, userId: user.id }, 'Failed to join session');
        return res.status(500).json({ error: 'Failed to join session' });
      }

      logger.info({ sessionId: id, userId: user.id, role }, 'User joined session');
      res.status(201).json({ data });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /sessions/:id/join');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Manually process all pending invitations for a session (trainer only)
router.post('/:id/process-all-invitations', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const user = req.user!;

    // Only trainers can process invitations
    if (user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Only trainers can process invitations' });
    }

    // Check if user is trainer of this session
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('trainer_id')
      .eq('id', id)
      .single();

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.trainer_id !== user.id && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get all pending/accepted invitations for this session
    const { data: invitations, error: invitationsError } = await supabaseAdmin
      .from('session_invitations')
      .select('*')
      .eq('session_id', id)
      .in('status', ['pending', 'accepted'])
      .gt('expires_at', new Date().toISOString());

    if (invitationsError) {
      logger.error({ error: invitationsError, sessionId: id }, 'Failed to fetch invitations');
      return res.status(500).json({ error: 'Failed to fetch invitations' });
    }

    if (!invitations || invitations.length === 0) {
      return res.json({
        data: {
          processed: 0,
          message: 'No pending or accepted invitations found',
        },
      });
    }

    // For each invitation, check if user exists and add them as participant
    const processed = [];
    const errors = [];
    const skipped = [];

    for (const invitation of invitations) {
      const normalizedEmail = invitation.email?.toLowerCase().trim();
      if (!normalizedEmail) continue;

      // Find user by email (case-insensitive)
      const { data: allUsers } = await supabaseAdmin.from('user_profiles').select('id, email');

      const matchingUser = allUsers?.find((u) => u.email?.toLowerCase().trim() === normalizedEmail);

      if (!matchingUser) {
        logger.debug({ email: normalizedEmail, sessionId: id }, 'User not found for invitation');
        skipped.push({
          email: normalizedEmail,
          reason: 'User profile not found - user needs to sign up first',
        });
        continue; // User doesn't exist yet, skip
      }

      // Check if user exists in auth.users (they need to be able to log in)
      const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(matchingUser.id);
      if (!authUser || !authUser.user) {
        logger.warn(
          { email: normalizedEmail, userId: matchingUser.id, sessionId: id },
          'User profile exists but not in auth.users - user cannot log in',
        );
        skipped.push({
          email: normalizedEmail,
          reason:
            'User profile exists but not registered in auth system - user needs to complete signup',
        });
        continue;
      }

      // Check if already a participant
      const { data: existingParticipant } = await supabaseAdmin
        .from('session_participants')
        .select('*')
        .eq('session_id', id)
        .eq('user_id', matchingUser.id)
        .maybeSingle();

      if (existingParticipant) {
        logger.debug({ userId: matchingUser.id, sessionId: id }, 'User already a participant');
        continue; // Already a participant
      }

      // Add as participant
      const { data: participant, error: participantError } = await supabaseAdmin
        .from('session_participants')
        .insert({
          session_id: id,
          user_id: matchingUser.id,
          role: invitation.role,
        })
        .select('*, user:user_profiles(*)')
        .single();

      if (participantError) {
        logger.error(
          {
            error: participantError,
            email: normalizedEmail,
            userId: matchingUser.id,
            sessionId: id,
          },
          'Failed to add participant',
        );
        errors.push({ email: normalizedEmail, error: participantError.message });
      } else {
        processed.push(participant);
        logger.info(
          {
            userId: matchingUser.id,
            email: normalizedEmail,
            sessionId: id,
            role: invitation.role,
          },
          'Added participant from invitation',
        );
      }

      // Update invitation status to accepted
      await supabaseAdmin
        .from('session_invitations')
        .update({
          status: 'accepted',
          accepted_at: new Date().toISOString(),
        })
        .eq('id', invitation.id);
    }

    logger.info(
      {
        sessionId: id,
        trainerId: user.id,
        processed: processed.length,
        totalInvitations: invitations.length,
        errors: errors.length,
      },
      'Processed all invitations for session',
    );

    res.json({
      data: {
        processed: processed.length,
        totalInvitations: invitations.length,
        participants: processed,
        errors: errors.length > 0 ? errors : undefined,
      },
    });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /sessions/:id/process-all-invitations');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as sessionsRouter };
