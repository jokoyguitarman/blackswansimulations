import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { validate, schemas } from '../lib/validation.js';

const router = Router();

// Get events for a session (timeline)
router.get(
  '/session/:sessionId',
  requireAuth,
  validate(schemas.pagination),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { sessionId } = req.params;
      const { page, limit } = req.query;
      const offset = (Number(page) - 1) * Number(limit);
      const user = req.user!;

      // Verify session access
      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('id, trainer_id')
        .eq('id', sessionId)
        .single();

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

      // Query events - use actor_id instead of created_by
      const { data, error, count } = await supabaseAdmin
        .from('session_events')
        .select(
          `
        *,
        actor:user_profiles!session_events_actor_id_fkey(id, full_name, role)
      `,
          { count: 'exact' },
        )
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .range(offset, offset + Number(limit) - 1);

      if (error) {
        logger.error({ error, sessionId }, 'Failed to fetch events');
        return res.status(500).json({ error: 'Failed to fetch events' });
      }

      // Filter events based on inject scope and user's role/team
      // Trainers and admins see ALL events (no filtering)
      let filteredEvents = data || [];

      // Only apply filtering for non-trainer/non-admin users
      if (user.role !== 'trainer' && user.role !== 'admin') {
        // Get user's teams for this session
        const { data: userTeams } = await supabaseAdmin
          .from('session_teams')
          .select('team_name')
          .eq('session_id', sessionId)
          .eq('user_id', user.id);

        const userTeamNames = userTeams?.map((t) => t.team_name) || [];

        // Get all inject IDs from inject events that are missing scope metadata (old events)
        const injectEventIdsMissingScope = (data || [])
          .filter(
            (event: any) =>
              event.event_type === 'inject' &&
              event.metadata?.inject_id &&
              (!event.metadata?.inject_scope || event.metadata.inject_scope === 'universal'),
          )
          .map((event: any) => event.metadata.inject_id)
          .filter((id: string | null) => id !== null && id !== undefined);

        // Get all inject IDs from incident events that were created from injects
        const incidentEventInjectIds = (data || [])
          .filter(
            (event: any) =>
              event.event_type === 'incident' &&
              event.metadata?.created_from_inject === true &&
              event.metadata?.inject_id,
          )
          .map((event: any) => event.metadata.inject_id)
          .filter((id: string | null) => id !== null && id !== undefined);

        // Combine all inject IDs we need to fetch
        const allInjectIds = [
          ...new Set([...injectEventIdsMissingScope, ...incidentEventInjectIds]),
        ];

        // Fetch injects for events that need scope information
        let injectsMap = new Map();
        if (allInjectIds.length > 0) {
          const { data: injects } = await supabaseAdmin
            .from('scenario_injects')
            .select('id, inject_scope, target_teams, affected_roles')
            .in('id', allInjectIds);

          if (injects) {
            injects.forEach((inject: any) => {
              injectsMap.set(inject.id, inject);
            });
          }
        }

        filteredEvents = (data || []).filter((event: any) => {
          const metadata = event.metadata || {};

          // Handle inject events
          if (event.event_type === 'inject') {
            // If metadata doesn't have inject_scope, fetch from database (for old events)
            let scope = metadata.inject_scope;
            let targetTeams = metadata.target_teams || [];
            let affectedRoles = metadata.affected_roles || [];

            // Fallback: fetch inject from database if scope is missing
            if (!scope && metadata.inject_id) {
              const inject = injectsMap.get(metadata.inject_id);
              if (inject) {
                scope = inject.inject_scope || 'universal';
                targetTeams = inject.target_teams || [];
                affectedRoles = inject.affected_roles || [];
                logger.debug(
                  {
                    eventId: event.id,
                    injectId: metadata.inject_id,
                    fetchedScope: scope,
                  },
                  'Fetched inject scope from database for old event',
                );
              } else {
                scope = 'universal'; // Safe default if inject not found
              }
            } else {
              scope = scope || 'universal';
            }

            logger.debug(
              {
                eventId: event.id,
                eventType: event.event_type,
                injectScope: scope,
                targetTeams,
                affectedRoles,
                userRole: user.role,
                userTeams: userTeamNames,
                hasMetadata: !!metadata,
                metadataKeys: Object.keys(metadata),
                scopeFromMetadata: !!metadata.inject_scope,
              },
              'Filtering inject event',
            );

            // Universal injects: visible to all
            if (scope === 'universal') {
              logger.debug({ eventId: event.id }, 'Inject event included: universal scope');
              return true;
            }

            // Role-specific injects: check if user's role is in affected_roles
            if (scope === 'role_specific') {
              if (Array.isArray(affectedRoles) && affectedRoles.length > 0) {
                const isVisible = affectedRoles.includes(user.role);
                logger.debug(
                  {
                    eventId: event.id,
                    isVisible,
                    userRole: user.role,
                    affectedRoles,
                  },
                  'Inject event role-specific check',
                );
                return isVisible;
              }
              // If no affected_roles specified, don't show (safe default)
              logger.debug(
                { eventId: event.id },
                'Inject event excluded: no affected_roles specified',
              );
              return false;
            }

            // Team-specific injects: check if user is in one of the target teams
            if (scope === 'team_specific') {
              if (Array.isArray(targetTeams) && targetTeams.length > 0) {
                const isVisible = targetTeams.some((team: string) => userTeamNames.includes(team));
                logger.debug(
                  {
                    eventId: event.id,
                    isVisible,
                    userTeams: userTeamNames,
                    targetTeams,
                  },
                  'Inject event team-specific check',
                );
                return isVisible;
              }
              // If no target_teams specified, don't show (safe default)
              logger.debug(
                { eventId: event.id },
                'Inject event excluded: no target_teams specified',
              );
              return false;
            }

            // Unknown scope, don't show (safe default)
            logger.debug({ eventId: event.id, scope }, 'Inject event excluded: unknown scope');
            return false;
          }

          // Handle incident events created from injects
          if (
            event.event_type === 'incident' &&
            metadata.created_from_inject === true &&
            metadata.inject_id
          ) {
            const inject = injectsMap.get(metadata.inject_id);
            if (!inject) {
              // If inject not found, show event (safe default for data integrity issues)
              logger.warn(
                { eventId: event.id, injectId: metadata.inject_id },
                'Inject not found for incident event, showing event',
              );
              return true;
            }

            const scope = inject.inject_scope || 'universal';
            const targetTeams = inject.target_teams || [];
            const affectedRoles = inject.affected_roles || [];

            logger.debug(
              {
                eventId: event.id,
                eventType: event.event_type,
                injectId: metadata.inject_id,
                injectScope: scope,
                targetTeams,
                affectedRoles,
                userRole: user.role,
                userTeams: userTeamNames,
              },
              'Filtering incident event by inject scope',
            );

            // Universal injects: visible to all
            if (scope === 'universal') {
              logger.debug({ eventId: event.id }, 'Incident event included: universal scope');
              return true;
            }

            // Role-specific injects: check if user's role is in affected_roles
            if (scope === 'role_specific') {
              if (Array.isArray(affectedRoles) && affectedRoles.length > 0) {
                const isVisible = affectedRoles.includes(user.role);
                logger.debug(
                  {
                    eventId: event.id,
                    isVisible,
                    userRole: user.role,
                    affectedRoles,
                  },
                  'Incident event role-specific check',
                );
                return isVisible;
              }
              logger.debug(
                { eventId: event.id },
                'Incident event excluded: no affected_roles specified',
              );
              return false;
            }

            // Team-specific injects: check if user is in one of the target teams
            if (scope === 'team_specific') {
              if (Array.isArray(targetTeams) && targetTeams.length > 0) {
                const isVisible = targetTeams.some((team: string) => userTeamNames.includes(team));
                logger.debug(
                  {
                    eventId: event.id,
                    isVisible,
                    userTeams: userTeamNames,
                    targetTeams,
                  },
                  'Incident event team-specific check',
                );
                return isVisible;
              }
              logger.debug(
                { eventId: event.id },
                'Incident event excluded: no target_teams specified',
              );
              return false;
            }

            // Unknown scope, don't show (safe default)
            logger.debug({ eventId: event.id, scope }, 'Incident event excluded: unknown scope');
            return false;
          }

          // All other events (decisions, messages, resources, manually created incidents): always visible
          return true;
        });

        logger.debug(
          {
            userId: user.id,
            role: user.role,
            teams: userTeamNames,
            totalEvents: (data || []).length,
            filteredEvents: filteredEvents.length,
          },
          'Filtered events by inject scope/role/team',
        );
      } else {
        // Trainers/admins see all events
        logger.debug(
          {
            userId: user.id,
            role: user.role,
            totalEvents: (data || []).length,
          },
          'Trainer/Admin: Showing all events (no filtering)',
        );
      }

      // Transform events: map metadata to event_data and actor to creator for frontend compatibility
      const transformedData = filteredEvents.map((event: any) => ({
        ...event,
        event_data: event.metadata || {}, // Map metadata to event_data
        creator: event.actor || null, // Map actor to creator
        metadata: undefined, // Remove metadata to avoid confusion
        actor: undefined, // Remove actor to avoid confusion
      }));

      res.json({
        data: transformedData.reverse(),
        count,
        page: Number(page),
        limit: Number(limit),
        totalPages: count ? Math.ceil(count / Number(limit)) : 0,
      });
    } catch (err) {
      logger.error({ error: err }, 'Error in GET /events/session/:sessionId');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export { router as eventsRouter };
