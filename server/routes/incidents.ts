import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { validate, schemas } from '../lib/validation.js';
import { getWebSocketService } from '../services/websocketService.js';
import { logAndBroadcastEvent } from '../services/eventService.js';
import {
  createNotificationsForRoles,
  createNotification,
  createNotificationsForUsers,
} from '../services/notificationService.js';
import { io } from '../index.js';

/**
 * Incidents Routes - Server-side only
 * Separation of concerns: All incident-related API logic
 */

const router = Router();

const createIncidentSchema = z.object({
  body: z.object({
    session_id: z.string().uuid(),
    title: z.string().min(1).max(200),
    description: z.string().min(1),
    location_lat: z.number().optional(),
    location_lng: z.number().optional(),
    type: z.string().min(1),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    casualty_count: z.number().int().nonnegative().optional(),
  }),
});

const updateIncidentSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().min(1).optional(),
    status: z
      .enum([
        'reported',
        'acknowledged',
        'responding',
        'resolved',
        'active',
        'under_control',
        'contained',
      ])
      .optional(),
    severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    location_lat: z.number().optional(),
    location_lng: z.number().optional(),
    casualty_count: z.number().int().nonnegative().optional(),
    assigned_to: z.string().uuid().nullable().optional(),
  }),
});

const assignIncidentSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    user_id: z.string().uuid(),
    notes: z.string().optional(),
  }),
});

const allocateResourcesSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    resources: z.record(z.string(), z.number().int().positive()),
  }),
});

// Get available teams for incident assignment in a session
router.get('/session/:sessionId/teams', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
    const user = req.user!;

    // Verify session access
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('id, trainer_id, scenario_id')
      .eq('id', sessionId)
      .maybeSingle();

    if (sessionError) {
      logger.error({ error: sessionError, sessionId }, 'Failed to fetch session');
      return res.status(500).json({ error: 'Failed to fetch session' });
    }

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.trainer_id !== user.id && user.role !== 'admin') {
      const { data: participant } = await supabaseAdmin
        .from('session_participants')
        .select('*')
        .eq('session_id', sessionId)
        .eq('user_id', user.id)
        .single();

      if (!participant) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    // Get teams that have participants assigned (from session_teams table)
    const { data: teamAssignments, error: teamsError } = await supabaseAdmin
      .from('session_teams')
      .select('team_name')
      .eq('session_id', sessionId);

    if (teamsError) {
      logger.error({ error: teamsError, sessionId }, 'Failed to fetch team assignments');
      return res.status(500).json({ error: 'Failed to fetch team assignments' });
    }

    // Get unique team names that have at least one participant assigned
    const uniqueTeamNames = [...new Set((teamAssignments || []).map((a: any) => a.team_name))];

    // Return teams as simple array, sorted alphabetically
    const teams = uniqueTeamNames.sort().map((teamName) => ({
      team_name: teamName,
    }));

    res.json({ data: teams });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /incidents/session/:sessionId/teams');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get participants (users) for a session (for incident assignment)
router.get(
  '/session/:sessionId/participants',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const { sessionId } = req.params;
      const user = req.user!;

      // Verify session access
      const { data: session, error: sessionError } = await supabaseAdmin
        .from('sessions')
        .select('id, trainer_id')
        .eq('id', sessionId)
        .maybeSingle();

      if (sessionError) {
        logger.error({ error: sessionError, sessionId }, 'Failed to fetch session');
        return res.status(500).json({ error: 'Failed to fetch session' });
      }

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.trainer_id !== user.id && user.role !== 'admin') {
        const { data: participant } = await supabaseAdmin
          .from('session_participants')
          .select('*')
          .eq('session_id', sessionId)
          .eq('user_id', user.id)
          .single();

        if (!participant) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }

      // Get all participants with their user info and roles
      const { data: participants, error: participantsError } = await supabaseAdmin
        .from('session_participants')
        .select('user_id, role, user:user_profiles(id, full_name)')
        .eq('session_id', sessionId);

      if (participantsError) {
        logger.error({ error: participantsError, sessionId }, 'Failed to fetch participants');
        return res.status(500).json({ error: 'Failed to fetch participants' });
      }

      if (!participants || participants.length === 0) {
        return res.json({ data: [] });
      }

      // Format: [{ id: '...', name: 'John Doe', role: 'police_commander' }]
      const users = participants
        .map((p: any) => {
          const user = p.user as { id: string; full_name: string } | null;
          if (!user || !user.id) return null;

          // Filter out trainer and admin roles
          const role = p.role as string;
          if (!role || role === 'trainer' || role === 'admin') return null;

          return {
            id: user.id,
            name: user.full_name || 'Unknown',
            role: role,
          };
        })
        .filter((u: any): u is { id: string; name: string; role: string } => u !== null)
        .sort((a, b) => {
          // Sort by role first, then by name
          const roleCompare = a.role.localeCompare(b.role);
          if (roleCompare !== 0) return roleCompare;
          return a.name.localeCompare(b.name);
        });

      res.json({ data: users });
    } catch (err) {
      logger.error({ error: err }, 'Error in GET /incidents/session/:sessionId/participants');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Get incidents for a session
router.get('/session/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
    const user = req.user!;

    // Verify session access
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('id, trainer_id')
      .eq('id', sessionId)
      .maybeSingle();

    if (sessionError) {
      logger.error({ error: sessionError, sessionId }, 'Failed to fetch session');
      return res.status(500).json({ error: 'Failed to fetch session' });
    }

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.trainer_id !== user.id && user.role !== 'admin') {
      const { data: participant } = await supabaseAdmin
        .from('session_participants')
        .select('*')
        .eq('session_id', sessionId)
        .eq('user_id', user.id)
        .single();

      if (!participant) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const { data, error } = await supabaseAdmin
      .from('incidents')
      .select(
        `
        *,
        reported_by:user_profiles!incidents_reported_by_fkey(id, full_name, role),
        assigned_to_user:user_profiles!incidents_assigned_to_fkey(id, full_name, role),
        assignments:incident_assignments(
          assignment_type, 
          user_id, 
          agency_role, 
          assigned_at, 
          notes, 
          unassigned_at,
          assigned_user:user_profiles!incident_assignments_user_id_fkey(id, full_name)
        )
      `,
      )
      .eq('session_id', sessionId)
      .order('reported_at', { ascending: false });

    if (error) {
      logger.error({ error, sessionId }, 'Failed to fetch incidents');
      return res.status(500).json({ error: 'Failed to fetch incidents' });
    }

    // Filter incidents based on inject scope and user's role/team
    // Trainers and admins see ALL incidents (no filtering)
    let filteredIncidents = data || [];

    // Only apply filtering for non-trainer/non-admin users
    if (user.role !== 'trainer' && user.role !== 'admin') {
      // Get all inject IDs from incidents that have inject_id
      const incidentInjectIds = (data || [])
        .map((incident: any) => incident.inject_id)
        .filter((id: string | null) => id !== null && id !== undefined);

      logger.debug(
        {
          totalIncidents: (data || []).length,
          incidentsWithInjectId: incidentInjectIds.length,
          incidentInjectIds,
          sampleIncidents: (data || []).slice(0, 3).map((inc: any) => ({
            id: inc.id,
            title: inc.title,
            inject_id: inc.inject_id,
          })),
        },
        'Checking incidents for inject_id',
      );

      // Fetch injects for incidents that were created from injects
      let injectsMap = new Map();
      if (incidentInjectIds.length > 0) {
        const { data: injects, error: injectsError } = await supabaseAdmin
          .from('scenario_injects')
          .select('id, inject_scope, target_teams, affected_roles')
          .in('id', incidentInjectIds);

        if (injectsError) {
          logger.error(
            { error: injectsError, incidentInjectIds },
            'Failed to fetch injects for incidents',
          );
        }

        if (injects) {
          injects.forEach((inject: any) => {
            injectsMap.set(inject.id, inject);
          });
          logger.debug(
            {
              fetchedInjects: injects.length,
              injectsMap: Array.from(injectsMap.entries()).map(([id, inj]: [string, any]) => ({
                id,
                scope: inj.inject_scope,
                targetTeams: inj.target_teams,
              })),
            },
            'Fetched injects for incidents',
          );
        }
      }

      filteredIncidents = (data || []).filter((incident: any) => {
        // Check if incident is assigned to user's role
        const assignments = incident.assignments || [];
        const isAssignedToUserRole = assignments.some(
          (assignment: any) =>
            assignment.agency_role === user.role &&
            assignment.assignment_type === 'agency_role' &&
            !assignment.unassigned_at,
        );

        if (isAssignedToUserRole) {
          logger.debug(
            {
              incidentId: incident.id,
              title: incident.title,
              userRole: user.role,
            },
            'Incident included: assigned to user role',
          );
          return true;
        }

        // Incidents without inject_id are always visible (manually created incidents)
        if (!incident.inject_id) {
          logger.debug(
            { incidentId: incident.id, title: incident.title },
            'Incident included: no inject_id (manually created)',
          );
          return true;
        }

        // Get the inject that created this incident
        const inject = injectsMap.get(incident.inject_id);
        if (!inject) {
          // If inject not found, show incident (safe default for data integrity issues)
          logger.warn(
            { incidentId: incident.id, injectId: incident.inject_id },
            'Inject not found for incident, showing incident',
          );
          return true;
        }

        const scope = inject.inject_scope || 'universal';
        const targetTeams = inject.target_teams || [];
        const affectedRoles = inject.affected_roles || [];

        logger.debug(
          {
            incidentId: incident.id,
            injectId: incident.inject_id,
            scope,
            targetTeams,
            affectedRoles,
            userRole: user.role,
          },
          'Filtering incident by inject scope',
        );

        // Universal injects: visible to all
        if (scope === 'universal') {
          logger.debug({ incidentId: incident.id }, 'Incident included: universal scope');
          return true;
        }

        // Role-specific injects: check if user's role is in affected_roles
        if (scope === 'role_specific') {
          if (Array.isArray(affectedRoles) && affectedRoles.length > 0) {
            const isVisible = affectedRoles.includes(user.role);
            logger.debug(
              {
                incidentId: incident.id,
                isVisible,
                userRole: user.role,
                affectedRoles,
              },
              'Incident role-specific check',
            );
            return isVisible;
          }
          // If no affected_roles specified, don't show (safe default)
          logger.debug(
            { incidentId: incident.id },
            'Incident excluded: no affected_roles specified',
          );
          return false;
        }

        // Unknown scope, don't show (safe default)
        logger.debug({ incidentId: incident.id, scope }, 'Incident excluded: unknown scope');
        return false;
      });

      logger.debug(
        {
          userId: user.id,
          role: user.role,
          totalIncidents: (data || []).length,
          filteredIncidents: filteredIncidents.length,
          incidentsWithInjectId: incidentInjectIds.length,
        },
        'Filtered incidents by inject scope/role',
      );
    } else {
      // Trainers/admins see all incidents
      logger.debug(
        {
          userId: user.id,
          role: user.role,
          totalIncidents: (data || []).length,
        },
        'Trainer/Admin: Showing all incidents (no filtering)',
      );
    }

    res.json({ data: filteredIncidents });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /incidents/session/:sessionId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single incident
router.get('/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const user = req.user!;

    const { data, error } = await supabaseAdmin
      .from('incidents')
      .select(
        `
        *,
        reported_by:user_profiles!incidents_reported_by_fkey(id, full_name, role),
        assigned_to_user:user_profiles!incidents_assigned_to_fkey(id, full_name, role),
        assignments:incident_assignments(agency_role, assigned_at, notes),
        updates:incident_updates(status, notes, created_at, updated_by:user_profiles(id, full_name, role))
      `,
      )
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Incident not found' });
    }

    // Verify access
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('id, trainer_id')
      .eq('id', data.session_id)
      .single();

    if (session?.trainer_id !== user.id && user.role !== 'admin') {
      const { data: participant } = await supabaseAdmin
        .from('session_participants')
        .select('*')
        .eq('session_id', data.session_id)
        .eq('user_id', user.id)
        .single();

      if (!participant) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    res.json({ data });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /incidents/:id');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create incident
router.post(
  '/',
  requireAuth,
  validate(createIncidentSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const {
        session_id,
        title,
        description,
        location_lat,
        location_lng,
        type,
        severity,
        casualty_count,
      } = req.body;

      // Verify session access
      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('id, status')
        .eq('id', session_id)
        .single();

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.status !== 'in_progress') {
        return res.status(400).json({ error: 'Session is not active' });
      }

      const { data, error } = await supabaseAdmin
        .from('incidents')
        .insert({
          session_id,
          title,
          description,
          location_lat: location_lat || null,
          location_lng: location_lng || null,
          type,
          severity,
          casualty_count: casualty_count || 0,
          reported_by: user.id,
          status: 'active',
        })
        .select(
          `
        *,
        reported_by:user_profiles!incidents_reported_by_fkey(id, full_name, role)
      `,
        )
        .single();

      if (error) {
        logger.error({ error, userId: user.id }, 'Failed to create incident');
        return res.status(500).json({ error: 'Failed to create incident' });
      }

      // Create initial status update
      await supabaseAdmin.from('incident_updates').insert({
        incident_id: data.id,
        status: 'active',
        updated_by: user.id,
        notes: 'Incident created',
      });

      // Fetch assignments for WebSocket broadcast
      const { data: assignments } = await supabaseAdmin
        .from('incident_assignments')
        .select('assignment_type, agency_role, assigned_at, notes')
        .eq('incident_id', data.id)
        .is('unassigned_at', null);

      // Broadcast incident created event with full data including assignments
      getWebSocketService().incidentCreated(session_id, {
        ...data,
        assignments: assignments || [],
      });

      // Log event
      await logAndBroadcastEvent(
        io,
        session_id,
        'incident',
        {
          incident_id: data.id,
          title: data.title,
          severity: data.severity,
          type: data.type,
          reporter: {
            id: user.id,
            full_name: data.reported_by?.full_name || 'Unknown',
            role: user.role || data.reported_by?.role || 'unknown',
          },
        },
        user.id,
      );

      // Notify all participants about new incident
      try {
        const priorityMap: Record<string, 'low' | 'medium' | 'high' | 'critical'> = {
          low: 'low',
          medium: 'medium',
          high: 'high',
          critical: 'critical',
        };
        const priority = priorityMap[severity] || 'medium';

        const { data: participants } = await supabaseAdmin
          .from('session_participants')
          .select('user_id')
          .eq('session_id', session_id);

        if (participants && participants.length > 0) {
          const userIds = participants.map((p) => p.user_id).filter((id): id is string => !!id);
          await createNotificationsForUsers(userIds, {
            sessionId: session_id,
            type: 'incident_reported',
            title: `New ${severity} Incident: ${title}`,
            message: description.substring(0, 200) + (description.length > 200 ? '...' : ''),
            priority,
            metadata: {
              incident_id: data.id,
            },
            actionUrl: `/sessions/${session_id}#cop`,
          });
        }
      } catch (notifErr) {
        logger.error(
          { error: notifErr, incidentId: data.id },
          'Error creating notifications for incident',
        );
        // Don't throw - notification failure shouldn't block incident creation
      }

      logger.info({ incidentId: data.id, userId: user.id }, 'Incident created');
      res.status(201).json({ data });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /incidents');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Update incident
router.patch(
  '/:id',
  requireAuth,
  validate(updateIncidentSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const user = req.user!;
      const updates = req.body;

      // Get incident
      const { data: incident } = await supabaseAdmin
        .from('incidents')
        .select('*')
        .eq('id', id)
        .single();

      if (!incident) {
        return res.status(404).json({ error: 'Incident not found' });
      }

      // Build update object
      const updateData: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };

      if (updates.title !== undefined) updateData.title = updates.title;
      if (updates.description !== undefined) updateData.description = updates.description;
      if (updates.status !== undefined) {
        updateData.status = updates.status;
        if (updates.status === 'resolved' || updates.status === 'contained') {
          updateData.resolved_at = new Date().toISOString();
        }
      }
      if (updates.severity !== undefined) updateData.severity = updates.severity;
      if (updates.location_lat !== undefined) updateData.location_lat = updates.location_lat;
      if (updates.location_lng !== undefined) updateData.location_lng = updates.location_lng;
      if (updates.casualty_count !== undefined) updateData.casualty_count = updates.casualty_count;
      if (updates.assigned_to !== undefined) {
        updateData.assigned_to = updates.assigned_to;
        if (updates.assigned_to) {
          updateData.assigned_at = new Date().toISOString();
        } else {
          updateData.assigned_at = null;
        }
      }

      const { data, error } = await supabaseAdmin
        .from('incidents')
        .update(updateData)
        .eq('id', id)
        .select(
          `
        *,
        reported_by:user_profiles!incidents_reported_by_fkey(id, full_name, role),
        assigned_to_user:user_profiles!incidents_assigned_to_fkey(id, full_name, role)
      `,
        )
        .single();

      if (error) {
        logger.error(
          {
            error,
            errorCode: error.code,
            errorMessage: error.message,
            errorDetails: error.details,
            errorHint: error.hint,
            incidentId: id,
            userId: user.id,
            updates,
          },
          'Failed to update incident',
        );
        return res.status(500).json({ error: 'Failed to update incident' });
      }

      // Fetch assignments for WebSocket broadcast
      const { data: assignments } = await supabaseAdmin
        .from('incident_assignments')
        .select('assignment_type, agency_role, assigned_at, notes')
        .eq('incident_id', id)
        .is('unassigned_at', null);

      // Create status update if status changed
      if (updates.status && updates.status !== incident.status) {
        const { error: updateError } = await supabaseAdmin.from('incident_updates').insert({
          incident_id: id,
          status: updates.status,
          updated_by: user.id,
          notes: `Status changed from ${incident.status} to ${updates.status}`,
        });

        if (updateError) {
          logger.error({ error: updateError, incidentId: id }, 'Failed to create incident update');
          // Don't fail the whole request, just log the error
        }
      }

      // Broadcast incident updated event (non-blocking) with full data including assignments
      try {
        getWebSocketService().incidentUpdated(incident.session_id, {
          ...data,
          assignments: assignments || [],
        });
      } catch (wsError) {
        logger.warn(
          { error: wsError, incidentId: id },
          'Failed to broadcast incident update via WebSocket, continuing anyway',
        );
      }

      // Log event (non-blocking)
      try {
        await logAndBroadcastEvent(
          io,
          incident.session_id,
          'incident',
          {
            incident_id: id,
            status: updates.status || incident.status,
            updated_by: { id: user.id, role: user.role },
          },
          user.id,
        );
      } catch (eventError) {
        logger.warn(
          { error: eventError, incidentId: id },
          'Failed to log incident update event, continuing anyway',
        );
      }

      logger.info({ incidentId: id, userId: user.id }, 'Incident updated');
      res.json({ data });
    } catch (err) {
      const user = req.user;
      logger.error(
        {
          error: err,
          errorMessage: err instanceof Error ? err.message : String(err),
          errorStack: err instanceof Error ? err.stack : undefined,
          incidentId: req.params?.id,
          userId: user?.id,
          updates: req.body,
        },
        'Error in PATCH /incidents/:id',
      );
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Assign incident to a specific user (player)
router.post(
  '/:id/assign',
  requireAuth,
  validate(assignIncidentSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const user = req.user!;
      const { user_id, notes } = req.body;

      if (!user_id) {
        return res.status(400).json({ error: 'user_id must be provided' });
      }

      // Get incident
      const { data: incident } = await supabaseAdmin
        .from('incidents')
        .select('*')
        .eq('id', id)
        .single();

      if (!incident) {
        return res.status(404).json({ error: 'Incident not found' });
      }

      // Verify the user is a participant in the session
      const { data: participant } = await supabaseAdmin
        .from('session_participants')
        .select('user_id')
        .eq('session_id', incident.session_id)
        .eq('user_id', user_id)
        .single();

      if (!participant) {
        return res.status(400).json({ error: 'User is not a participant in this session' });
      }

      // Check if active assignment already exists
      const { data: existing } = await supabaseAdmin
        .from('incident_assignments')
        .select('*')
        .eq('incident_id', id)
        .eq('user_id', user_id)
        .is('unassigned_at', null)
        .maybeSingle();

      if (existing) {
        return res.status(400).json({ error: 'Incident already assigned to this user' });
      }

      // Check if there's an old unassigned assignment we should reactivate
      const { data: oldAssignment } = await supabaseAdmin
        .from('incident_assignments')
        .select('*')
        .eq('incident_id', id)
        .eq('user_id', user_id)
        .not('unassigned_at', 'is', null)
        .maybeSingle();

      let assignment;
      let error;

      if (oldAssignment) {
        // Reactivate the old assignment
        const { data: updated, error: updateError } = await supabaseAdmin
          .from('incident_assignments')
          .update({
            assigned_by: user.id,
            assigned_at: new Date().toISOString(),
            unassigned_at: null,
            notes: notes || oldAssignment.notes || null,
          })
          .eq('id', oldAssignment.id)
          .select()
          .single();

        assignment = updated;
        error = updateError;
      } else {
        // Create new assignment
        const { data: inserted, error: insertError } = await supabaseAdmin
          .from('incident_assignments')
          .insert({
            incident_id: id,
            assignment_type: 'user',
            user_id: user_id,
            agency_role: null,
            team_name: null,
            assigned_by: user.id,
            notes: notes || null,
          })
          .select()
          .single();

        assignment = inserted;
        error = insertError;
      }

      if (error) {
        logger.error(
          {
            error,
            errorCode: error.code,
            errorMessage: error.message,
            errorDetails: error.details,
            errorHint: error.hint,
            incidentId: id,
            assignedUserId: user_id,
            userId: user.id,
          },
          'Failed to assign incident',
        );
        return res.status(500).json({ error: 'Failed to assign incident' });
      }

      // Get updated incident
      const { data: updatedIncident, error: fetchError } = await supabaseAdmin
        .from('incidents')
        .select(
          `
        *,
        assignments:incident_assignments(assignment_type, user_id, assigned_at, notes, assigned_user:user_profiles!incident_assignments_user_id_fkey(id, full_name))
      `,
        )
        .eq('id', id)
        .single();

      if (fetchError) {
        logger.warn(
          { error: fetchError, incidentId: id },
          'Failed to fetch updated incident, using original',
        );
      }

      // Fetch assignments for WebSocket broadcast
      const { data: assignments } = await supabaseAdmin
        .from('incident_assignments')
        .select(
          'assignment_type, user_id, assigned_at, notes, assigned_user:user_profiles!incident_assignments_user_id_fkey(id, full_name)',
        )
        .eq('incident_id', id)
        .is('unassigned_at', null);

      // Broadcast incident updated event (non-blocking) with full data including assignments
      try {
        getWebSocketService().incidentUpdated(incident.session_id, {
          ...(updatedIncident || incident),
          assignments: assignments || [],
        });
      } catch (wsError) {
        logger.warn(
          { error: wsError, incidentId: id },
          'Failed to broadcast incident update via WebSocket, continuing anyway',
        );
      }

      // Log event (non-blocking)
      try {
        await logAndBroadcastEvent(
          io,
          incident.session_id,
          'incident',
          {
            incident_id: id,
            action: 'assigned',
            assignment_type: 'user',
            assigned_user_id: user_id,
            assigned_by: { id: user.id, role: user.role },
          },
          user.id,
        );
      } catch (eventError) {
        logger.warn(
          { error: eventError, incidentId: id },
          'Failed to log incident assignment event, continuing anyway',
        );
      }

      // Notify the specific user
      try {
        await createNotificationsForUsers([user_id], {
          sessionId: incident.session_id,
          type: 'incident_assigned',
          title: 'Incident Assigned to You',
          message: `You have been assigned to incident: "${incident.title}"`,
          priority:
            incident.severity === 'critical'
              ? 'critical'
              : incident.severity === 'high'
                ? 'high'
                : 'medium',
          metadata: {
            incident_id: id,
          },
          actionUrl: `/sessions/${incident.session_id}#cop`,
        });
      } catch (notifErr) {
        logger.error(
          { error: notifErr, incidentId: id, assignedUserId: user_id },
          'Error creating notification for incident assignment',
        );
        // Don't throw - notification failure shouldn't block assignment
      }

      logger.info(
        {
          incidentId: id,
          assignedUserId: user_id,
          userId: user.id,
        },
        'Incident assigned to user',
      );
      res.json({ data: assignment });
    } catch (err) {
      const user = req.user;
      logger.error(
        {
          error: err,
          errorMessage: err instanceof Error ? err.message : String(err),
          errorStack: err instanceof Error ? err.stack : undefined,
          incidentId: req.params?.id,
          userId: user?.id,
          body: req.body,
        },
        'Error in POST /incidents/:id/assign',
      );
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Allocate resources to incident
router.post(
  '/:id/resources',
  requireAuth,
  validate(allocateResourcesSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const user = req.user!;
      const { resources } = req.body;

      // Get incident
      const { data: incident } = await supabaseAdmin
        .from('incidents')
        .select('*')
        .eq('id', id)
        .single();

      if (!incident) {
        return res.status(404).json({ error: 'Incident not found' });
      }

      // This is a placeholder - actual resource allocation would update agency_resources
      // For now, we'll just log it and broadcast the event
      // Full resource allocation logic would be in Phase 5

      // Broadcast incident updated event
      getWebSocketService().incidentUpdated(incident.session_id, incident);

      // Log event
      await logAndBroadcastEvent(
        io,
        incident.session_id,
        'incident',
        {
          incident_id: id,
          action: 'resources_allocated',
          resources,
          allocated_by: { id: user.id, role: user.role },
        },
        user.id,
      );

      logger.info(
        { incidentId: id, resources, userId: user.id },
        'Resources allocated to incident',
      );
      res.json({ success: true, message: 'Resources allocated' });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /incidents/:id/resources');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export { router as incidentsRouter };
