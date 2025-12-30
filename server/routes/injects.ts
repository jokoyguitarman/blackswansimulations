import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { validate } from '../lib/validation.js';
import { getWebSocketService } from '../services/websocketService.js';
import {
  createNotificationsForRoles,
  createNotificationsForUsers,
} from '../services/notificationService.js';
import { logAndBroadcastEvent } from '../services/eventService.js';
import type { Server as SocketServer } from 'socket.io';

const router = Router();

/**
 * Publish an inject to a session (reusable function for manual and automatic publishing)
 * @param injectId - The ID of the inject to publish
 * @param sessionId - The ID of the session to publish to
 * @param userId - The ID of the user publishing (trainer_id for auto-publish, user.id for manual)
 * @param io - Socket.io server instance for broadcasting events
 * @returns Promise that resolves when inject is published
 */
export async function publishInjectToSession(
  injectId: string,
  sessionId: string,
  userId: string,
  io: SocketServer,
): Promise<void> {
  logger.info({ injectId, sessionId, userId }, 'publishInjectToSession called');

  // Get inject
  const { data: inject, error: injectError } = await supabaseAdmin
    .from('scenario_injects')
    .select('*')
    .eq('id', injectId)
    .single();

  if (injectError) {
    logger.error({ error: injectError, injectId }, 'Failed to fetch inject');
    throw new Error(`Failed to fetch inject: ${injectError.message}`);
  }

  if (!inject) {
    logger.error({ injectId }, 'Inject not found');
    throw new Error(`Inject not found: ${injectId}`);
  }

  // Verify session exists
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('id, status, trainer_id')
    .eq('id', sessionId)
    .single();

  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  // Create session event for the inject
  // Note: session_events table uses: actor_id (not created_by), metadata (not event_data), description (required)
  const { data: event, error: eventError } = await supabaseAdmin
    .from('session_events')
    .insert({
      session_id: sessionId,
      event_type: 'inject',
      description: `Inject published: ${inject.title}`,
      actor_id: userId,
      metadata: {
        inject_id: injectId,
        type: inject.type,
        title: inject.title,
        content: inject.content,
        severity: inject.severity,
        affected_roles: inject.affected_roles || [],
        inject_scope: ((inject as Record<string, unknown>).inject_scope as string) || 'universal',
        target_teams: ((inject as Record<string, unknown>).target_teams as string[] | null) || null,
      },
    })
    .select()
    .single();

  if (eventError) {
    logger.error(
      {
        error: eventError,
        errorCode: eventError.code,
        errorMessage: eventError.message,
        errorDetails: eventError.details,
        errorHint: eventError.hint,
        injectId,
        sessionId,
        userId,
      },
      'Failed to create session event for inject',
    );
    throw new Error(`Failed to create session event: ${eventError.message}`);
  }

  if (!event) {
    logger.error({ injectId, sessionId, userId }, 'Session event insert returned no data');
    throw new Error('Failed to create session event: No data returned');
  }

  // Broadcast inject published event via WebSocket service
  // Include scope information so frontend can filter appropriately
  getWebSocketService().injectPublished(sessionId, {
    inject_id: injectId,
    type: inject.type,
    title: inject.title,
    content: inject.content,
    severity: inject.severity,
    affected_roles: inject.affected_roles || [],
    inject_scope: ((inject as Record<string, unknown>).inject_scope as string) || 'universal',
    target_teams: ((inject as Record<string, unknown>).target_teams as string[] | null) || null,
  });

  // Broadcast generic event (the session_events insert was already done above)
  // We just need to broadcast it, not log it again
  // Note: Frontend should filter based on inject_scope
  try {
    io.to(`session:${sessionId}`).emit('event', {
      type: 'inject.published',
      data: {
        inject_id: injectId,
        type: inject.type,
        title: inject.title,
        severity: inject.severity,
        inject_scope: inject.inject_scope || 'universal',
        affected_roles: inject.affected_roles || [],
        target_teams: inject.target_teams || null,
      },
      timestamp: new Date().toISOString(),
    });
    logger.debug(
      { sessionId, injectId, inject_scope: inject.inject_scope },
      'Inject event broadcasted',
    );
  } catch (broadcastErr) {
    logger.error({ error: broadcastErr, sessionId, injectId }, 'Error broadcasting inject event');
    // Don't throw - event is already logged, broadcast failure is non-critical
  }

  // Create notifications for affected users
  try {
    const injectScope = ((inject as Record<string, unknown>).inject_scope as string) || 'universal';
    const affectedRoles = inject.affected_roles || [];
    const targetTeams =
      ((inject as Record<string, unknown>).target_teams as string[] | null) || null;

    // Determine priority based on severity
    const priorityMap: Record<string, 'low' | 'medium' | 'high' | 'critical'> = {
      low: 'low',
      medium: 'medium',
      high: 'high',
      critical: 'critical',
    };
    const priority = priorityMap[inject.severity] || 'medium';

    if (injectScope === 'universal') {
      // Notify all participants in the session
      const { data: participants } = await supabaseAdmin
        .from('session_participants')
        .select('user_id')
        .eq('session_id', sessionId);

      if (participants && participants.length > 0) {
        const userIds = participants.map((p) => p.user_id).filter((id): id is string => !!id);
        await createNotificationsForUsers(userIds, {
          sessionId,
          type: 'inject_published',
          title: `New ${inject.type.replace('_', ' ')}: ${inject.title}`,
          message: inject.content.substring(0, 200) + (inject.content.length > 200 ? '...' : ''),
          priority,
          metadata: {
            inject_id: injectId,
          },
          actionUrl: `/sessions/${sessionId}#injects`,
        });
      }
    } else if (injectScope === 'role_specific' && affectedRoles.length > 0) {
      // Notify users with specific roles
      await createNotificationsForRoles(sessionId, affectedRoles, {
        type: 'inject_published',
        title: `New ${inject.type.replace('_', ' ')}: ${inject.title}`,
        message: inject.content.substring(0, 200) + (inject.content.length > 200 ? '...' : ''),
        priority,
        metadata: {
          inject_id: injectId,
        },
        actionUrl: `/sessions/${sessionId}#injects`,
      });
    } else if (
      injectScope === 'team_specific' &&
      targetTeams &&
      Array.isArray(targetTeams) &&
      targetTeams.length > 0
    ) {
      // Notify users in specific teams
      // Note: This assumes teams are stored in session_participants or a teams table
      // For now, we'll notify by role if teams map to roles
      // You may need to adjust this based on your team structure
      const { data: participants } = await supabaseAdmin
        .from('session_participants')
        .select('user_id, user_profiles!inner(role)')
        .eq('session_id', sessionId);

      if (participants && participants.length > 0) {
        // Filter participants by team (assuming teams are roles for now)
        const userIds = participants
          .filter((p) => {
            const role = ((p.user_profiles as Record<string, unknown>)?.role as string) || '';
            return role && targetTeams.includes(role);
          })
          .map((p) => p.user_id)
          .filter((id): id is string => !!id);

        if (userIds.length > 0) {
          await createNotificationsForUsers(userIds, {
            sessionId,
            type: 'inject_published',
            title: `New ${inject.type.replace('_', ' ')}: ${inject.title}`,
            message: inject.content.substring(0, 200) + (inject.content.length > 200 ? '...' : ''),
            priority,
            metadata: {
              inject_id: injectId,
            },
            actionUrl: `/sessions/${sessionId}#injects`,
          });
        }
      }
    }
  } catch (notifErr) {
    logger.error(
      { error: notifErr, sessionId, injectId },
      'Error creating notifications for inject',
    );
    // Don't throw - notification failure shouldn't block inject publishing
  }

  // If inject requires response, automatically create an incident
  if (inject.requires_response) {
    try {
      // Map inject type to incident type
      const incidentTypeMap: Record<string, string> = {
        field_update: 'operational',
        intel_brief: 'intelligence',
        media_report: 'media',
        citizen_call: 'civilian',
        resource_shortage: 'logistics',
        weather_change: 'environmental',
        political_pressure: 'political',
      };
      const incidentType = incidentTypeMap[inject.type] || 'general';

      // Create incident from inject
      const { data: incident, error: incidentError } = await supabaseAdmin
        .from('incidents')
        .insert({
          session_id: sessionId,
          title: inject.title,
          description: inject.content,
          type: incidentType,
          severity: inject.severity,
          status: 'active',
          reported_by: userId,
          inject_id: injectId, // Track which inject created this incident
          // Location can be extracted from content later or left null
          location_lat: null,
          location_lng: null,
        })
        .select()
        .single();

      if (incidentError) {
        logger.error(
          {
            error: incidentError,
            errorCode: incidentError.code,
            errorMessage: incidentError.message,
            errorDetails: incidentError.details,
            errorHint: incidentError.hint,
            injectId,
            sessionId,
            userId,
          },
          'Failed to create incident from inject',
        );
        // Don't fail the inject publish if incident creation fails
      } else if (incident) {
        // Create initial status update
        await supabaseAdmin.from('incident_updates').insert({
          incident_id: incident.id,
          status: 'active',
          updated_by: userId,
          notes: `Incident automatically created from inject: ${inject.title}`,
        });

        // Fetch full incident with relations for WebSocket broadcast
        const { data: fullIncident } = await supabaseAdmin
          .from('incidents')
          .select(
            `
            *,
            reported_by:user_profiles!incidents_reported_by_fkey(id, full_name, role)
          `,
          )
          .eq('id', incident.id)
          .single();

        // Broadcast incident created event
        getWebSocketService().incidentCreated(sessionId, fullIncident || incident);

        // Log incident creation event in session_events
        // Note: session_events table uses: actor_id (not created_by), metadata (not event_data), description (required)
        try {
          await supabaseAdmin.from('session_events').insert({
            session_id: sessionId,
            event_type: 'incident',
            description: `Incident created from inject: ${incident.title}`,
            actor_id: userId,
            metadata: {
              incident_id: incident.id,
              title: incident.title,
              type: incident.type,
              severity: incident.severity,
              created_from_inject: true,
              inject_id: injectId,
            },
          });

          // Broadcast the event
          io.to(`session:${sessionId}`).emit('event', {
            type: 'incident',
            data: {
              incident_id: incident.id,
              title: incident.title,
              type: incident.type,
              severity: incident.severity,
              created_from_inject: true,
              inject_id: injectId,
            },
            timestamp: new Date().toISOString(),
          });
          logger.debug(
            { sessionId, incidentId: incident.id },
            'Incident event logged and broadcasted',
          );
        } catch (eventErr) {
          logger.error(
            { error: eventErr, sessionId, incidentId: incident.id },
            'Error logging incident event',
          );
          // Don't throw - incident is created, event logging failure is non-critical
        }

        logger.info(
          {
            injectId,
            incidentId: incident.id,
            sessionId,
          },
          'Incident automatically created from inject',
        );
      }
    } catch (incidentErr) {
      logger.error({ error: incidentErr, injectId }, 'Error creating incident from inject');
      // Don't fail the inject publish if incident creation fails
    }
  }

  // Create media post for media-related inject types
  const mediaInjectTypes = ['media_report', 'citizen_call', 'political_pressure'];
  if (mediaInjectTypes.includes(inject.type)) {
    try {
      // Map inject type to media source and platform
      const sourceMap: Record<string, string> = {
        media_report: 'News Media',
        citizen_call: 'Citizen Report',
        political_pressure: 'Political News',
      };
      const platformMap: Record<string, string> = {
        media_report: 'news',
        citizen_call: 'citizen_report',
        political_pressure: 'news',
      };

      const source = sourceMap[inject.type] || 'News Media';
      const platform = platformMap[inject.type] || 'news';
      const author = source; // Use source as author for backward compatibility

      // Default sentiment to neutral (could be enhanced to extract from inject metadata)
      const sentiment = 'neutral';

      // Check if inject has ai_generated field
      const aiGenerated = ((inject as Record<string, unknown>).ai_generated as boolean) || false;

      // Create media post
      const { data: mediaPost, error: mediaError } = await supabaseAdmin
        .from('media_posts')
        .insert({
          session_id: sessionId,
          source,
          headline: inject.title,
          content: inject.content,
          sentiment,
          is_misinformation: false, // Default to false, could be enhanced
          platform, // For backward compatibility
          author, // For backward compatibility
          ai_generated: aiGenerated,
        })
        .select()
        .single();

      if (mediaError) {
        logger.error(
          {
            error: mediaError,
            errorCode: mediaError.code,
            errorMessage: mediaError.message,
            injectId,
            sessionId,
          },
          'Failed to create media post from inject',
        );
        // Don't fail the inject publish if media post creation fails
      } else if (mediaPost) {
        // Broadcast media post event via WebSocket
        await logAndBroadcastEvent(
          io,
          sessionId,
          'media_post',
          {
            media_id: mediaPost.id,
            source,
            headline: inject.title,
            sentiment,
            is_misinformation: false,
          },
          userId,
        );

        logger.info(
          {
            injectId,
            mediaPostId: mediaPost.id,
            sessionId,
          },
          'Media post automatically created from inject',
        );
      }
    } catch (mediaErr) {
      logger.error({ error: mediaErr, injectId }, 'Error creating media post from inject');
      // Don't fail the inject publish if media post creation fails
    }
  }

  logger.info({ injectId, sessionId, userId }, 'Inject published');
}

const createInjectSchema = z.object({
  body: z.object({
    scenario_id: z.string().uuid().optional().nullable(),
    session_id: z.string().uuid().optional().nullable(),
    trigger_time_minutes: z.number().int().nonnegative().optional().nullable(),
    trigger_condition: z.string().optional().nullable(),
    type: z.enum([
      'media_report',
      'field_update',
      'citizen_call',
      'intel_brief',
      'resource_shortage',
      'weather_change',
      'political_pressure',
    ]),
    title: z.string().min(1).max(200),
    content: z.string().min(1),
    affected_roles: z.array(z.string()).default([]),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    requires_response: z.boolean().default(false),
    inject_scope: z.enum(['universal', 'role_specific', 'team_specific']).default('universal'),
    target_teams: z.array(z.string()).optional().nullable(),
    requires_coordination: z.boolean().default(false),
  }),
});

const publishInjectSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    session_id: z.string().uuid(),
  }),
});

// Get injects for scenario or session (filtered by role/team)
router.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { scenario_id, session_id } = req.query;
    const user = req.user!;

    if (!scenario_id && !session_id) {
      return res.status(400).json({ error: 'scenario_id or session_id required' });
    }

    let query = supabaseAdmin.from('scenario_injects').select('*');

    if (scenario_id) {
      query = query.eq('scenario_id', scenario_id as string);
    }

    let finalScenarioId: string | undefined;
    if (session_id) {
      // Get scenario_id from session
      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('scenario_id')
        .eq('id', session_id as string)
        .single();

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      finalScenarioId = session.scenario_id;
      query = query.eq('scenario_id', finalScenarioId);
    }

    // Fetch all injects first (we'll filter in code for complex logic)
    const { data: allInjects, error } = await query.order('trigger_time_minutes', {
      ascending: true,
    });

    if (error) {
      logger.error({ error }, 'Failed to fetch injects');
      return res.status(500).json({ error: 'Failed to fetch injects' });
    }

    // Filter injects based on inject_scope and user's role/team
    // Trainers and admins see ALL injects (no filtering)
    let filteredInjects = allInjects || [];

    // Only apply filtering for non-trainer/non-admin users
    if (user.role !== 'trainer' && user.role !== 'admin') {
      // If this is for a session (not just scenario view), apply role/team filtering
      if (session_id && allInjects) {
        // Get user's teams for this session
        const { data: userTeams } = await supabaseAdmin
          .from('session_teams')
          .select('team_name')
          .eq('session_id', session_id as string)
          .eq('user_id', user.id);

        const userTeamNames = userTeams?.map((t) => t.team_name) || [];

        filteredInjects = allInjects.filter((inject: Record<string, unknown>) => {
          // AI-generated injects: only visible to the decision maker who triggered them
          if (inject.ai_generated && inject.triggered_by_user_id) {
            return inject.triggered_by_user_id === user.id;
          }

          const scope = (inject.inject_scope as string) || 'universal';

          // Universal injects: visible to all
          if (scope === 'universal') {
            return true;
          }

          // Role-specific injects: check if user's role is in affected_roles
          if (scope === 'role_specific') {
            const affectedRoles = (inject.affected_roles as string[]) || [];
            if (Array.isArray(affectedRoles) && affectedRoles.length > 0) {
              return affectedRoles.includes(user.role);
            }
            // If no affected_roles specified, don't show (safe default)
            return false;
          }

          // Team-specific injects: check if user is in one of the target teams
          if (scope === 'team_specific') {
            const targetTeams = (inject.target_teams as string[]) || [];
            if (Array.isArray(targetTeams) && targetTeams.length > 0) {
              return targetTeams.some((team: string) => userTeamNames.includes(team));
            }
            // If no target_teams specified, don't show (safe default)
            return false;
          }

          // Unknown scope, don't show (safe default)
          return false;
        });

        logger.debug(
          {
            userId: user.id,
            role: user.role,
            teams: userTeamNames,
            totalInjects: allInjects.length,
            filteredInjects: filteredInjects.length,
          },
          'Filtered injects by role/team',
        );
      }
    } else {
      // Trainers/admins see all injects
      logger.debug(
        {
          userId: user.id,
          role: user.role,
          totalInjects: allInjects?.length || 0,
        },
        'Trainer/Admin: Showing all injects (no filtering)',
      );
    }

    res.json({ data: filteredInjects });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /injects');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create inject (trainers only)
router.post(
  '/',
  requireAuth,
  validate(createInjectSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      logger.info({ userId: user.id, body: req.body }, 'Creating inject');
      const {
        scenario_id,
        session_id,
        trigger_time_minutes,
        trigger_condition,
        type,
        title,
        content,
        affected_roles,
        severity,
        requires_response,
      } = req.body;

      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can create injects' });
      }

      // If session_id provided, get scenario_id from session
      let finalScenarioId = scenario_id;
      if (session_id && !scenario_id) {
        const { data: session } = await supabaseAdmin
          .from('sessions')
          .select('scenario_id')
          .eq('id', session_id)
          .single();

        if (!session) {
          return res.status(404).json({ error: 'Session not found' });
        }

        finalScenarioId = session.scenario_id;
      }

      if (!finalScenarioId) {
        return res.status(400).json({ error: 'scenario_id or session_id required' });
      }

      // Prepare insert data
      const insertData: Record<string, unknown> = {
        scenario_id: finalScenarioId,
        trigger_time_minutes: trigger_time_minutes ?? null,
        trigger_condition: trigger_condition || null,
        type,
        title,
        content,
        affected_roles: affected_roles || [],
        severity,
        requires_response: requires_response ?? false,
        ai_generated: false,
      };

      logger.debug({ insertData, userId: user.id }, 'Inserting inject');

      const { data, error } = await supabaseAdmin
        .from('scenario_injects')
        .insert(insertData)
        .select()
        .single();

      if (error) {
        logger.error(
          {
            error,
            errorCode: error.code,
            errorMessage: error.message,
            errorDetails: error.details,
            errorHint: error.hint,
            userId: user.id,
            scenarioId: finalScenarioId,
            sessionId: session_id,
            insertData,
          },
          'Failed to create inject',
        );
        return res.status(500).json({
          error: 'Failed to create inject',
          details: error.message || 'Unknown error',
          code: error.code,
        });
      }

      logger.info({ injectId: data.id, userId: user.id }, 'Inject created');
      res.status(201).json({ data });
    } catch (err) {
      logger.error(
        {
          error: err,
          errorMessage: err instanceof Error ? err.message : String(err),
          errorStack: err instanceof Error ? err.stack : undefined,
          userId: req.user?.id,
          body: req.body,
        },
        'Error in POST /injects',
      );
      res.status(500).json({
        error: 'Internal server error',
        details: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  },
);

// Publish inject to session (trigger it)
router.post(
  '/:id/publish',
  (req, res, next) => {
    // Use both logger and console.log to ensure we see this
    const logData = {
      method: req.method,
      path: req.path,
      params: req.params,
      body: req.body,
      hasAuth: !!req.headers.authorization,
    };
    logger.info(logData, 'Publish inject route hit');
    console.log('[INJECT PUBLISH] Route hit:', logData); // Fallback log
    next();
  },
  requireAuth,
  validate(publishInjectSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      logger.info(
        {
          injectId: req.params.id,
          sessionId: req.body?.session_id,
          userId: req.user?.id,
          body: req.body,
        },
        'Publish inject request received',
      );

      const { id } = req.params;
      const user = req.user!;
      const { session_id } = req.body;

      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can publish injects' });
      }

      if (!session_id) {
        return res.status(400).json({ error: 'session_id required' });
      }

      // Verify session exists and user has access
      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('id, status, trainer_id')
        .eq('id', session_id)
        .single();

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.trainer_id !== user.id && user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Import io here to avoid circular dependency (index.ts loads routes after io is created)
      let io;
      try {
        const module = await import('../index.js');
        io = module.io;
        if (!io) {
          throw new Error('Socket.io server not initialized');
        }
      } catch (importError) {
        logger.error({ error: importError }, 'Failed to import io from index.js');
        return res.status(500).json({ error: 'Server configuration error' });
      }

      // Use the extracted function to publish
      try {
        await publishInjectToSession(id, session_id, user.id, io);
        logger.info(
          { injectId: id, sessionId: session_id, userId: user.id },
          'Inject published successfully',
        );
        res.json({ success: true, message: 'Inject published successfully' });
      } catch (publishError) {
        const error = publishError as Error;
        logger.error(
          {
            error: error.message,
            stack: error.stack,
            injectId: id,
            sessionId: session_id,
            userId: user.id,
            errorName: error.name,
            fullError: String(error),
          },
          'Error publishing inject',
        );
        console.error('[INJECT PUBLISH ERROR]', error); // Fallback log

        // Return appropriate error status based on error message
        if (error.message.includes('not found')) {
          return res.status(404).json({ error: error.message });
        }

        if (error.message.includes('Failed to create session event')) {
          return res.status(500).json({
            error: 'Failed to publish inject',
            details: error.message,
            hint: 'This might be due to a database constraint or missing required fields',
          });
        }

        res.status(500).json({
          error: 'Failed to publish inject',
          details: error.message,
          errorName: error.name,
        });
      }
    } catch (err) {
      const error = err as Error;
      logger.error(
        {
          error: error.message,
          stack: error.stack,
          userId: req.user?.id,
          body: req.body,
        },
        'Error in POST /injects/:id/publish',
      );

      res.status(500).json({
        error: 'Internal server error',
        details: error.message,
      });
    }
  },
);

export { router as injectsRouter };
