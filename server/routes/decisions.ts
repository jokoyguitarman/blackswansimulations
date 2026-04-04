import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { validate } from '../lib/validation.js';
import { getWebSocketService } from '../services/websocketService.js';
import { logAndBroadcastEvent } from '../services/eventService.js';
import {
  updateStateOnDecisionExecution,
  updateTeamStateFromDecision,
} from '../services/scenarioStateService.js';
import { classifyDecision, shouldCancelScheduledInject } from '../services/aiService.js';
import { evaluateAllObjectivesForSession } from '../services/objectiveTrackingService.js';
// Gate evaluation imports removed — gates still evaluate on the scheduler for AAR,
// but no longer drive player-facing inject publishing or objective skipping in the decision flow.
import { evaluateDecisionAgainstEnvironment } from '../services/environmentalConsistencyService.js';
import { evaluateEnvironmentalPrerequisite } from '../services/environmentalPrerequisiteService.js';
import {
  evaluateEnvironmentalManagementIntentAndUpdateState,
  recordSpaceClaim,
} from '../services/environmentalConditionManagementService.js';
import { evaluateStateEffectManagementAndUpdateState } from '../services/stateEffectManagementService.js';
import {
  updateTeamHeatMeter,
  generateDecisionConsequence,
  nudgePublicSentiment,
} from '../services/heatMeterService.js';
import { applyDecisionCasualtyEffects } from '../services/decisionCasualtyEffectsService.js';
import { evaluateTransportOutcome } from '../services/transportOutcomeService.js';
import { extractAndPlaceInfrastructureFromText } from '../services/demoAIAgentService.js';
import { teamConsultedInsiderBefore } from '../services/incidentDecisionGradingService.js';
import { publishInjectToSession } from './injects.js';
import { evaluateDecisionBasedTriggers } from '../services/injectTriggerService.js';
import {
  createNotification,
  createNotificationsForUsers,
} from '../services/notificationService.js';
import { env } from '../env.js';
import { io } from '../index.js';

const router = Router();

const createDecisionSchema = z.object({
  body: z.object({
    session_id: z.string().uuid(),
    response_to_incident_id: z.string().uuid().optional().nullable(),
    title: z.string().max(200).optional(),
    description: z.string().min(1),
    decision_type: z
      .enum([
        'public_statement',
        'resource_allocation',
        'emergency_declaration',
        'policy_change',
        'coordination_order',
      ])
      .optional(),
    required_approvers: z.array(z.string().uuid()).default([]),
    resources_needed: z.record(z.string(), z.unknown()).optional(),
  }),
});

const approveDecisionSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    approved: z.boolean(),
    comment: z.string().optional(),
  }),
});

// Get available participants (users) for a session (for decision approvers)
// NOTE: This must come BEFORE /session/:sessionId to avoid route matching conflicts
router.get(
  '/session/:sessionId/available-participants',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const { sessionId } = req.params;
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

      // Get all participants with their user info and roles
      const { data: participants, error } = await supabaseAdmin
        .from('session_participants')
        .select('user_id, role, user:user_profiles(id, full_name)')
        .eq('session_id', sessionId);

      if (error) {
        logger.error({ error, sessionId }, 'Failed to fetch session participants');
        return res.status(500).json({ error: 'Failed to fetch available participants' });
      }

      if (!participants || participants.length === 0) {
        return res.json({ data: [] });
      }

      // Format: [{ id: '...', name: 'John Doe', role: 'police_commander' }]
      const users = participants
        .map((p: Record<string, unknown>) => {
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
        .filter((u): u is { id: string; name: string; role: string } => u !== null)
        .sort((a, b) => {
          // Sort by role first, then by name
          const roleCompare = a.role.localeCompare(b.role);
          if (roleCompare !== 0) return roleCompare;
          return a.name.localeCompare(b.name);
        });

      logger.info({ sessionId, participantCount: users.length }, 'Available participants fetched');
      res.json({ data: users });
    } catch (err) {
      logger.error(
        { error: err },
        'Error in GET /decisions/session/:sessionId/available-participants',
      );
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Get decisions for a session
router.get('/session/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
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

    // Get all decisions for the session
    const { data: allDecisions, error: decisionsError } = await supabaseAdmin
      .from('decisions')
      .select(
        `
        *, 
        creator:user_profiles!decisions_proposed_by_fkey(id, full_name, role)
      `,
      )
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false });

    if (decisionsError) {
      logger.error({ error: decisionsError, sessionId }, 'Failed to fetch decisions');
      return res.status(500).json({ error: 'Failed to fetch decisions' });
    }

    // Filter decisions to only show those where user is creator or has an approval step
    // Trainers and admins can see all decisions in their sessions
    const isTrainerOrAdmin = session.trainer_id === user.id || user.role === 'admin';

    let relevantDecisions = allDecisions || [];

    if (!isTrainerOrAdmin) {
      const decisionIds = (allDecisions || []).map((d: Record<string, unknown>) => d.id as string);

      if (decisionIds.length === 0) {
        relevantDecisions = [];
      } else {
        // Get the user's team(s) so teammates can see each other's decisions
        const { data: userTeamRows } = await supabaseAdmin
          .from('session_teams')
          .select('team_name')
          .eq('session_id', sessionId)
          .eq('user_id', user.id);
        const userTeamNames = (userTeamRows ?? []).map((r: { team_name: string }) => r.team_name);

        // Get all user_ids that share those teams
        const teammateIds = new Set<string>([user.id]);
        if (userTeamNames.length > 0) {
          const { data: teammateRows } = await supabaseAdmin
            .from('session_teams')
            .select('user_id')
            .eq('session_id', sessionId)
            .in('team_name', userTeamNames);
          for (const row of teammateRows ?? []) {
            teammateIds.add((row as { user_id: string }).user_id);
          }
        }

        // Get all decision IDs where the user has a step
        const { data: userSteps, error: stepsError } = await supabaseAdmin
          .from('decision_steps')
          .select('decision_id')
          .eq('user_id', user.id)
          .in('decision_id', decisionIds);

        if (stepsError) {
          logger.error(
            { error: stepsError, userId: user.id, sessionId },
            'Failed to fetch user decision steps',
          );
        }

        const userDecisionIds = new Set(
          (userSteps || []).map((step: { decision_id: string }) => step.decision_id),
        );

        // Filter: user can see if they or a teammate created it, OR they have an approval step
        relevantDecisions = (allDecisions || []).filter((decision: Record<string, unknown>) => {
          const isTeamDecision = teammateIds.has(decision.proposed_by as string);
          const hasStep = userDecisionIds.has(decision.id as string);
          return isTeamDecision || hasStep;
        });

        logger.info(
          {
            userId: user.id,
            sessionId,
            teams: userTeamNames,
            teammateCount: teammateIds.size,
            filteredCount: relevantDecisions.length,
            totalCount: allDecisions?.length || 0,
          },
          'Filtered decisions for user (team-aware)',
        );
      }
    }

    // Fetch steps for each relevant decision
    const decisionsWithSteps = await Promise.all(
      relevantDecisions.map(async (decision) => {
        const { data: steps } = await supabaseAdmin
          .from('decision_steps')
          .select(
            `
            *,
            approver:user_profiles!decision_steps_approved_by_fkey(id, full_name, role)
          `,
          )
          .eq('decision_id', decision.id)
          .order('step_order', { ascending: true });
        // Map database fields to frontend expected fields
        return {
          ...decision,
          decision_type: decision.type, // Map type to decision_type for frontend
          steps: steps || [],
        };
      }),
    );

    res.json({ data: decisionsWithSteps });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /decisions/session/:sessionId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create decision
router.post(
  '/',
  requireAuth,
  validate(createDecisionSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const {
        session_id,
        response_to_incident_id,
        title: titleInput,
        description,
        decision_type,
        required_approvers = [],
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

      if (response_to_incident_id) {
        const { data: incident, error: incidentError } = await supabaseAdmin
          .from('incidents')
          .select('id')
          .eq('id', response_to_incident_id)
          .eq('session_id', session_id)
          .single();

        if (incidentError || !incident) {
          return res
            .status(400)
            .json({ error: 'Incident not found or does not belong to this session' });
        }

        const { data: existingByUser } = await supabaseAdmin
          .from('decisions')
          .select('id')
          .eq('session_id', session_id)
          .eq('response_to_incident_id', response_to_incident_id)
          .eq('proposed_by', user.id)
          .limit(1)
          .maybeSingle();

        if (existingByUser) {
          return res.status(409).json({
            error:
              'You have already created a decision for this incident. Only one decision per incident per player is allowed.',
          });
        }
      }

      // Title is optional; derive from description when missing or empty (DB requires NOT NULL)
      const title =
        typeof titleInput === 'string' && titleInput.trim().length > 0
          ? titleInput.trim().slice(0, 200)
          : description.trim().slice(0, 80) + (description.trim().length > 80 ? '…' : '');

      const { data, error } = await supabaseAdmin
        .from('decisions')
        .insert({
          session_id,
          proposed_by: user.id,
          response_to_incident_id: response_to_incident_id || null,
          title,
          description,
          type: decision_type || null,
          status: 'proposed',
        })
        .select()
        .single();

      if (error) {
        logger.error({ error, userId: user.id }, 'Failed to create decision');
        return res.status(500).json({ error: 'Failed to create decision' });
      }

      // Get full decision with creator info for WebSocket and notifications
      const { data: fullDecision } = await supabaseAdmin
        .from('decisions')
        .select('*, creator:user_profiles!decisions_proposed_by_fkey(id, full_name, role)')
        .eq('id', data.id)
        .single();

      // Create approval steps for all required approvers (now user IDs)
      if (required_approvers.length > 0) {
        // Fetch roles for all approvers from session_participants
        const { data: participants, error: participantsError } = await supabaseAdmin
          .from('session_participants')
          .select('user_id, role')
          .eq('session_id', session_id)
          .in('user_id', required_approvers);

        if (participantsError) {
          logger.error(
            { error: participantsError, sessionId: session_id },
            'Failed to fetch approver roles',
          );
        }

        // Create a map of user_id to role
        const roleMap = new Map<string, string>();
        participants?.forEach((p: { user_id: string; role: string }) => {
          roleMap.set(p.user_id, p.role);
        });

        const steps = required_approvers.map((userId: string, index: number) => ({
          decision_id: data.id,
          user_id: userId,
          role: roleMap.get(userId) || 'unknown', // Fetch role from session_participants
          approver_role: roleMap.get(userId) || null, // Keep for backward compatibility
          step_order: index + 1,
          status: 'pending' as const,
          required: true,
        }));

        logger.info(
          {
            decisionId: data.id,
            stepsToCreate: steps.map((s: Record<string, unknown>) => ({
              user_id: s.user_id,
              role: s.role,
              step_order: s.step_order,
            })),
            requiredApprovers: required_approvers,
          },
          'Creating decision steps',
        );

        const { data: insertedSteps, error: stepsError } = await supabaseAdmin
          .from('decision_steps')
          .insert(steps)
          .select('id, decision_id, user_id, role');

        if (stepsError) {
          logger.error(
            { error: stepsError, decisionId: data.id, steps },
            'Failed to create decision steps',
          );
          return res.status(500).json({ error: 'Failed to create decision steps' });
        }

        logger.info(
          {
            decisionId: data.id,
            insertedStepsCount: insertedSteps?.length || 0,
            insertedSteps: insertedSteps?.map((s: Record<string, unknown>) => ({
              id: s.id,
              user_id: s.user_id,
              decision_id: s.decision_id,
            })),
          },
          'Decision steps created successfully',
        );

        // Notify specific users that they need to approve this decision
        try {
          await createNotificationsForUsers(required_approvers, {
            sessionId: session_id,
            type: 'decision_approval_required',
            title: 'Decision Approval Required',
            message: `${fullDecision?.creator?.full_name || 'A user'} has proposed a decision that requires your approval: "${title}"`,
            priority: 'high',
            metadata: {
              decision_id: data.id,
            },
            actionUrl: `/sessions/${session_id}#decisions`,
          });
        } catch (notifError) {
          logger.error(
            { error: notifError, decisionId: data.id },
            'Failed to create approval notifications',
          );
        }
      }

      // Map database fields to frontend expected fields
      const decisionResponse = fullDecision || data;
      const mappedDecision = {
        ...decisionResponse,
        decision_type: decisionResponse.type,
      };

      // Broadcast decision created event via WebSocket
      try {
        getWebSocketService().decisionProposed(session_id, mappedDecision);
      } catch (wsError) {
        logger.error(
          { error: wsError, decisionId: data.id },
          'Failed to broadcast decision creation via WebSocket',
        );
      }

      // Send response immediately
      logger.info({ decisionId: data.id, userId: user.id }, 'Decision created');
      res.status(201).json({ data: mappedDecision });

      // Log event in background (non-blocking)
      logAndBroadcastEvent(
        io,
        session_id,
        'decision',
        {
          decision_id: data.id,
          title: data.title,
          decision_type: data.type,
          status: data.status,
          creator: fullDecision?.creator || { id: user.id },
        },
        user.id,
      ).catch((eventError) => {
        logger.error(
          { error: eventError, decisionId: data.id },
          'Failed to log decision creation event',
        );
      });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /decisions');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Approve/reject decision
router.post(
  '/:id/approve',
  requireAuth,
  validate(approveDecisionSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const user = req.user!;
      const { approved, comment } = req.body;

      // Get decision
      const { data: decision } = await supabaseAdmin
        .from('decisions')
        .select('*')
        .eq('id', id)
        .single();

      if (!decision) {
        return res.status(404).json({ error: 'Decision not found' });
      }

      // Get pending steps
      const { data: steps } = await supabaseAdmin
        .from('decision_steps')
        .select('*')
        .eq('decision_id', id)
        .order('step_order', { ascending: true });

      // Find pending step for this specific user
      const pendingStep = steps?.find(
        (step) => step.status === 'pending' && step.user_id === user.id,
      );

      if (!pendingStep) {
        return res.status(400).json({ error: 'No pending approval step for you' });
      }

      // Update step
      await supabaseAdmin
        .from('decision_steps')
        .update({
          status: approved ? 'approved' : 'rejected',
          user_id: user.id,
          approved_by: user.id, // Migration added this column
          approved_at: new Date().toISOString(), // Migration added this column
          timestamp: new Date().toISOString(),
          comment,
        })
        .eq('id', pendingStep.id);

      // Update decision status
      let newStatus = decision.status;
      if (approved) {
        const { data: remainingSteps } = await supabaseAdmin
          .from('decision_steps')
          .select('*')
          .eq('decision_id', id)
          .eq('status', 'pending');

        if (!remainingSteps || remainingSteps.length === 0) {
          newStatus = 'approved';
          await supabaseAdmin.from('decisions').update({ status: 'approved' }).eq('id', id);
        }
      } else {
        newStatus = 'rejected';
        await supabaseAdmin.from('decisions').update({ status: 'rejected' }).eq('id', id);
      }

      // Get updated decision for WebSocket
      const { data: updatedDecision } = await supabaseAdmin
        .from('decisions')
        .select('*, creator:user_profiles!decisions_proposed_by_fkey(id, full_name, role)')
        .eq('id', id)
        .single();

      // Map database fields to frontend expected fields
      const mappedDecision = updatedDecision
        ? {
            ...updatedDecision,
            decision_type: updatedDecision.type,
          }
        : {
            ...decision,
            decision_type: decision.type,
          };

      // Broadcast decision update
      if (approved) {
        try {
          getWebSocketService().decisionApproved(decision.session_id, mappedDecision);
        } catch (wsError) {
          logger.error(
            { error: wsError, decisionId: id },
            'Failed to broadcast decision approval via WebSocket',
          );
        }

        // Notify decision creator that it was approved
        try {
          await createNotification({
            sessionId: decision.session_id,
            userId: decision.proposed_by,
            type: 'decision_approved',
            title: 'Decision Approved',
            message: `Your decision "${decision.title}" has been approved by ${user.role}.`,
            priority: 'medium',
            metadata: {
              decision_id: decision.id,
            },
            actionUrl: `/sessions/${decision.session_id}#decisions`,
          });
        } catch (notifError) {
          logger.error(
            { error: notifError, decisionId: id },
            'Failed to create approval notification',
          );
        }
      } else {
        try {
          getWebSocketService().decisionRejected(decision.session_id, mappedDecision);
        } catch (wsError) {
          logger.error(
            { error: wsError, decisionId: id },
            'Failed to broadcast decision rejection via WebSocket',
          );
        }

        // Notify decision creator that it was rejected
        try {
          await createNotification({
            sessionId: decision.session_id,
            userId: decision.proposed_by,
            type: 'decision_rejected',
            title: 'Decision Rejected',
            message: `Your decision "${decision.title}" has been rejected by ${user.role}.${comment ? ` Reason: ${comment}` : ''}`,
            priority: 'high',
            metadata: {
              decision_id: decision.id,
            },
            actionUrl: `/sessions/${decision.session_id}#decisions`,
          });
        } catch (notifError) {
          logger.error(
            { error: notifError, decisionId: id },
            'Failed to create rejection notification',
          );
        }
      }

      // Log event
      try {
        await logAndBroadcastEvent(
          io,
          decision.session_id,
          'decision',
          {
            decision_id: id,
            status: newStatus,
            approved,
            comment,
            approver: { id: user.id, role: user.role },
          },
          user.id,
        );
      } catch (eventError) {
        logger.error(
          { error: eventError, decisionId: id },
          'Failed to log decision approval event',
        );
      }

      logger.info({ decisionId: id, userId: user.id, approved }, 'Decision step updated');
      res.json({ success: true });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /decisions/:id/approve');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Background AI processing after a decision is executed.
// Runs asynchronously so the player gets an instant response.
async function processExecutedDecisionInBackground(
  decisionId: string,
  decision: Record<string, unknown>,
  userId: string,
  userRole: string,
) {
  const sessionId = decision.session_id as string;

  // --- Phase 1: State update (quick DB write) ---
  try {
    await updateStateOnDecisionExecution(sessionId, {
      id: decisionId,
      decision_type: (decision.type as string) || 'operational_action',
      title: (decision.title as string) ?? '',
      description: (decision.description as string) ?? '',
      resources_needed: decision.resources_needed as Record<string, unknown> | undefined,
      consequences: decision.consequences as Record<string, unknown> | undefined,
    });
  } catch (stateError) {
    logger.error({ error: stateError, decisionId }, 'Error updating scenario state, continuing');
  }

  // --- Phase 2: AI classification + team state + decision triggers ---
  let aiClassification: Awaited<ReturnType<typeof classifyDecision>> | null = null;
  if (env.openAiApiKey) {
    try {
      aiClassification = await classifyDecision(
        { title: decision.title as string, description: decision.description as string },
        env.openAiApiKey,
      );

      await supabaseAdmin
        .from('decisions')
        .update({
          type: (aiClassification as { primary_category?: string }).primary_category,
          ai_classification: aiClassification,
        })
        .eq('id', decisionId);

      // Update team state from classification
      try {
        const { data: authorTeams } = await supabaseAdmin
          .from('session_teams')
          .select('team_name')
          .eq('session_id', sessionId)
          .eq('user_id', decision.proposed_by as string);
        const authorTeamNames = (authorTeams ?? []).map((r: { team_name: string }) => r.team_name);
        const { data: sessionRow } = await supabaseAdmin
          .from('sessions')
          .select('start_time, scenario_id')
          .eq('id', sessionId)
          .single();
        const startTime = (sessionRow as { start_time?: string } | null)?.start_time;
        const elapsedMinutes = startTime
          ? Math.floor((Date.now() - new Date(startTime).getTime()) / 60000)
          : 0;
        await updateTeamStateFromDecision(
          sessionId,
          decisionId,
          authorTeamNames,
          aiClassification!,
          elapsedMinutes,
          {
            decisionTitle: (decision.title as string) ?? '',
            decisionDescription: (decision.description as string) ?? '',
            scenarioId: (sessionRow as { scenario_id?: string } | null)?.scenario_id ?? undefined,
          },
        );
      } catch (teamStateErr) {
        logger.error(
          { error: teamStateErr, decisionId },
          'Failed to update team state from decision',
        );
      }

      // Evaluate decision-based triggers
      if (io) {
        try {
          const { data: triggerAuthorTeams } = await supabaseAdmin
            .from('session_teams')
            .select('team_name')
            .eq('session_id', sessionId)
            .eq('user_id', decision.proposed_by as string);
          const triggerTeamName =
            (triggerAuthorTeams ?? []).length > 0
              ? (triggerAuthorTeams![0] as { team_name: string }).team_name
              : null;
          await evaluateDecisionBasedTriggers(
            sessionId,
            {
              id: decisionId,
              title: decision.title as string,
              description: decision.description as string,
            },
            aiClassification!,
            io,
            triggerTeamName,
          );
        } catch (triggerErr) {
          logger.error(
            { error: triggerErr, decisionId },
            'Decision-based trigger evaluation failed',
          );
        }
      }

      logger.info(
        {
          decisionId,
          classification: (aiClassification as { primary_category?: string }).primary_category,
        },
        'Decision classified by AI',
      );
    } catch (classificationError) {
      logger.error(
        { error: classificationError, decisionId },
        'AI classification or inject generation failed',
      );
    }
  }

  // --- Phase 3: Environmental consistency, quality checks, heat meter ---
  let authorTeamNames: string[] = [];
  try {
    const { data: authorTeams } = await supabaseAdmin
      .from('session_teams')
      .select('team_name')
      .eq('session_id', sessionId)
      .eq('user_id', decision.proposed_by as string);
    authorTeamNames = (authorTeams ?? []).map((r: { team_name: string }) => r.team_name);

    const { data: sessionRow } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id, trainer_id')
      .eq('id', sessionId)
      .single();
    const sessionScenarioId = (sessionRow as { scenario_id?: string } | null)?.scenario_id ?? null;
    const sessionTrainerId = (sessionRow as { trainer_id?: string } | null)?.trainer_id ?? null;

    let qualityFailureCount = 0;
    if (authorTeamNames.length > 0) {
      const { data: prevFailEvents, error: failCountErr } = await supabaseAdmin
        .from('session_events')
        .select('id')
        .eq('session_id', sessionId)
        .eq('event_type', 'quality_failure_inject_fired')
        .filter('metadata->>team', 'eq', authorTeamNames[0]);
      if (!failCountErr && prevFailEvents) {
        qualityFailureCount = prevFailEvents.length;
      }
    }

    const responseToIncidentIdForEnv = (decision as { response_to_incident_id?: string | null })
      .response_to_incident_id;
    let incidentContext: { title: string; description: string } | null = null;
    if (responseToIncidentIdForEnv) {
      const { data: incidentForEnv } = await supabaseAdmin
        .from('incidents')
        .select('title, description')
        .eq('id', responseToIncidentIdForEnv)
        .single();
      if (incidentForEnv) {
        incidentContext = {
          title: (incidentForEnv as { title?: string }).title ?? '',
          description: (incidentForEnv as { description?: string }).description ?? '',
        };
      }
    }

    // Pre-evaluation extraction: place infrastructure and record direction intent
    // from the decision text BEFORE the evaluator runs, so it sees the updated ground truth.
    const sessionScenarioIdForExtraction = (sessionRow as { scenario_id?: string } | null)
      ?.scenario_id;
    if (authorTeamNames.length > 0 && sessionScenarioIdForExtraction) {
      try {
        const { data: scenarioForCenter } = await supabaseAdmin
          .from('scenarios')
          .select('location_lat, location_lng')
          .eq('id', sessionScenarioIdForExtraction)
          .single();
        const extractionCenter =
          scenarioForCenter?.location_lat && scenarioForCenter?.location_lng
            ? {
                lat: Number(scenarioForCenter.location_lat),
                lng: Number(scenarioForCenter.location_lng),
              }
            : null;

        await extractAndPlaceInfrastructureFromText(
          sessionId,
          sessionScenarioIdForExtraction,
          authorTeamNames[0],
          decision.title as string,
          decision.description as string,
          extractionCenter,
        );
      } catch (extractErr) {
        logger.warn({ error: extractErr }, 'Pre-eval extraction failed for human player decision');
      }
    }

    // Run env consistency + env prerequisite in parallel (both are LLM calls)
    const [aiEnvResult, prereqOut] = await Promise.all([
      evaluateDecisionAgainstEnvironment(
        sessionId,
        {
          id: decision.id as string,
          title: decision.title as string,
          description: decision.description as string,
          type: (decision.type as string) ?? null,
        },
        env.openAiApiKey,
        incidentContext,
        authorTeamNames[0],
        qualityFailureCount,
      ),
      evaluateEnvironmentalPrerequisite(
        sessionId,
        {
          id: decision.id as string,
          title: decision.title as string,
          description: decision.description as string,
          type: (decision.type as string) ?? null,
          team_name: authorTeamNames[0] ?? undefined,
        },
        incidentContext,
        env.openAiApiKey,
      ),
    ]);
    const { result: prereqResult, evaluationReason: envPrereqReason } = prereqOut;
    const envResult = prereqResult && !prereqResult.consistent ? prereqResult : aiEnvResult;
    logger.info(
      {
        sessionId,
        decisionId,
        consistent: envResult.consistent,
        mismatch_kind: envResult.mismatch_kind ?? null,
        severity: envResult.severity ?? null,
        error_type: envResult.error_type ?? null,
        reason: envResult.reason ?? null,
        route_effect: envResult.route_effect ?? null,
      },
      `Environmental consistency: ${envResult.consistent ? 'consistent' : (envResult.mismatch_kind ?? 'inconsistent')}`,
    );
    await supabaseAdmin
      .from('decisions')
      .update({ environmental_consistency: envResult })
      .eq('id', decision.id as string);

    if (envPrereqReason != null) {
      await supabaseAdmin
        .from('decisions')
        .update({ evaluation_reasoning: { env_prerequisite: envPrereqReason } })
        .eq('id', decision.id as string);
    }

    // Quality failure inject logic
    type FailureType =
      | 'vague'
      | 'contradiction'
      | 'below_standard'
      | 'prereq'
      | 'rejected'
      | 'infrastructure_gap';
    let failureType: FailureType | null = null;
    let failureContent = '';

    const rejected = envResult.rejected === true || aiEnvResult.rejected === true;
    const rejectionReason = envResult.rejection_reason || aiEnvResult.rejection_reason || '';

    if (rejected && rejectionReason) {
      failureType = 'rejected';
      failureContent = rejectionReason;
    } else if (envResult.specific === false && envResult.feedback) {
      failureType = 'vague';
      failureContent = envResult.feedback;
    } else if (
      !envResult.consistent &&
      envResult.mismatch_kind === 'infrastructure_gap' &&
      envResult.reason
    ) {
      failureType = 'infrastructure_gap';
      failureContent = envResult.reason;
    } else if (
      !envResult.consistent &&
      envResult.mismatch_kind !== 'below_standard' &&
      envResult.mismatch_kind !== 'infrastructure_gap' &&
      envResult.reason
    ) {
      failureType = 'contradiction';
      failureContent = envResult.reason;
    } else if (
      !envResult.consistent &&
      envResult.mismatch_kind === 'below_standard' &&
      envResult.reason
    ) {
      failureType = 'below_standard';
      failureContent = envResult.reason;
    } else if (prereqResult && !prereqResult.consistent && prereqResult.reason) {
      failureType = 'prereq';
      failureContent = prereqResult.reason;
    }

    const FALLBACK_TITLES: Record<FailureType, string> = {
      vague: 'Field report — operational complications',
      contradiction: 'Field report — ground conditions',
      below_standard: 'Field report — standards shortfall',
      prereq: 'Field report — environmental constraint',
      rejected: 'Action cannot be carried out',
      infrastructure_gap: 'Field report — infrastructure not established',
    };

    if (
      failureType &&
      failureContent &&
      authorTeamNames.length > 0 &&
      sessionScenarioId &&
      sessionTrainerId &&
      io
    ) {
      try {
        if (env.openAiApiKey && failureType !== 'rejected') {
          const { data: allDecisionRows } = await supabaseAdmin
            .from('decisions')
            .select('title, description, type')
            .eq('session_id', sessionId)
            .eq('status', 'executed')
            .order('executed_at', { ascending: true })
            .limit(50);
          const allDecisions = (allDecisionRows ?? []).map((d) => ({
            title: (d as { title: string }).title ?? '',
            description: (d as { description: string }).description ?? '',
            type: (d as { type: string | null }).type,
          }));

          if (allDecisions.length > 0) {
            await supabaseAdmin.from('session_events').insert({
              session_id: sessionId,
              event_type: 'ai_step_start',
              description: `Checking if quality failure inject (${failureType}) can be cancelled for ${authorTeamNames[0]}`,
              actor_id: null,
              metadata: {
                step: 'quality_inject_cancellation',
                team: authorTeamNames[0],
                failure_type: failureType,
                decisions_checked: allDecisions.length,
              },
            });

            try {
              const cancelCheck = await shouldCancelScheduledInject(
                { title: failureContent.slice(0, 200), content: failureContent },
                allDecisions,
                env.openAiApiKey,
              );

              await supabaseAdmin.from('session_events').insert({
                session_id: sessionId,
                event_type: 'ai_step_end',
                description: cancelCheck.cancel
                  ? `Quality inject cancelled for ${authorTeamNames[0]}: ${cancelCheck.cancel_reason ?? 'prior decisions addressed concern'}`
                  : `Quality inject NOT cancelled for ${authorTeamNames[0]}: ${cancelCheck.cancel_reason ?? 'concern not addressed'}`,
                actor_id: null,
                metadata: {
                  step: 'quality_inject_cancellation',
                  team: authorTeamNames[0],
                  cancel: cancelCheck.cancel,
                  cancel_reason: cancelCheck.cancel_reason,
                },
              });

              if (cancelCheck.cancel) {
                logger.info(
                  {
                    decisionId,
                    team: authorTeamNames[0],
                    failureType,
                    cancel_reason: cancelCheck.cancel_reason,
                  },
                  'Quality failure inject cancelled — decisions addressed concern',
                );
                await updateTeamHeatMeter(sessionId, authorTeamNames[0], 'good');
                failureType = null;
                failureContent = '';
              }
            } catch (cancelErr) {
              logger.warn(
                { err: cancelErr, decisionId },
                'Quality failure cancellation check failed, proceeding with inject',
              );
            }
          }
        }

        if (failureType && failureContent) {
          const escalationIdx = Math.min(qualityFailureCount, 2);
          const injectSeverity: 'medium' | 'high' | 'critical' =
            failureType === 'rejected'
              ? 'critical'
              : escalationIdx >= 2
                ? 'critical'
                : escalationIdx >= 1
                  ? 'high'
                  : 'medium';
          const aiTitle = envResult.consequence_title || aiEnvResult.consequence_title;
          const titleBase = aiTitle || FALLBACK_TITLES[failureType];
          const injectTitle = `${titleBase} – ${authorTeamNames[0]} (${(decision.id as string).slice(0, 8)})`;

          const { data: qualityInject, error: qualityInsertErr } = await supabaseAdmin
            .from('scenario_injects')
            .insert({
              scenario_id: sessionScenarioId,
              session_id: sessionId,
              type: 'field_update',
              title: injectTitle,
              content: failureContent,
              severity: injectSeverity,
              inject_scope: 'team_specific',
              target_teams: [authorTeamNames[0]],
              requires_response: true,
              requires_coordination: false,
              ai_generated: true,
              generation_source: 'specificity_feedback',
            })
            .select()
            .single();

          if (qualityInsertErr) {
            logger.warn(
              { err: qualityInsertErr, decisionId, team: authorTeamNames[0] },
              'Quality failure inject insert failed',
            );
          }

          if (qualityInject) {
            await publishInjectToSession(qualityInject.id, sessionId, sessionTrainerId, io);
            await supabaseAdmin.from('session_events').insert({
              session_id: sessionId,
              event_type: 'quality_failure_inject_fired',
              description: `Quality failure (${failureType}) for ${authorTeamNames[0]} (escalation ${qualityFailureCount + 1})`,
              actor_id: null,
              metadata: {
                team: authorTeamNames[0],
                decision_id: decisionId,
                failure_type: failureType,
                escalation: qualityFailureCount + 1,
              },
            });
            logger.info(
              {
                sessionId,
                decisionId,
                team: authorTeamNames[0],
                failureType,
                escalation: qualityFailureCount + 1,
                severity: injectSeverity,
              },
              'Quality failure inject published',
            );
          }
        }
      } catch (qualityErr) {
        logger.warn(
          { err: qualityErr, sessionId, decisionId },
          'Failed to fire quality failure inject',
        );
      }
    }

    // Insider knowledge consultation check
    let noIntel = false;
    if (authorTeamNames.length > 0) {
      try {
        const { data: teamUserRows } = await supabaseAdmin
          .from('session_teams')
          .select('user_id')
          .eq('session_id', sessionId)
          .in('team_name', authorTeamNames);
        const teamUserIds = (teamUserRows ?? []).map((r: { user_id: string }) => r.user_id);
        const consulted = await teamConsultedInsiderBefore(
          sessionId,
          teamUserIds,
          new Date().toISOString(),
        );
        if (!consulted) {
          noIntel = true;
        }
      } catch (intelErr) {
        logger.warn({ err: intelErr, sessionId }, 'Insider knowledge check failed, continuing');
      }
    }

    // Heat meter
    if (authorTeamNames.length > 0) {
      let mistakeType: 'vague' | 'contradiction' | 'prereq' | 'no_intel' | 'rejected' | 'good' =
        'good';
      if (rejected) {
        mistakeType = 'rejected';
      } else if (envResult.specific === false) {
        mistakeType = 'vague';
      } else if (!envResult.consistent && envResult.mismatch_kind === 'infrastructure_gap') {
        mistakeType = 'prereq';
      } else if (
        !envResult.consistent &&
        envResult.mismatch_kind !== 'below_standard' &&
        envResult.mismatch_kind !== 'infrastructure_gap'
      ) {
        mistakeType = 'contradiction';
      } else if (!envResult.consistent) {
        mistakeType = 'prereq';
      } else if (noIntel) {
        mistakeType = 'no_intel';
      }
      try {
        const { heat_percentage } = await updateTeamHeatMeter(
          sessionId,
          authorTeamNames[0],
          mistakeType,
          io,
        );

        if (sessionScenarioId && sessionTrainerId && io) {
          const decisionTextForConsequence = `${(decision.title as string) ?? ''} ${(decision.description as string) ?? ''}`;
          await generateDecisionConsequence(
            sessionId,
            authorTeamNames[0],
            heat_percentage,
            sessionScenarioId,
            sessionTrainerId,
            io,
            decisionTextForConsequence,
          );
        }

        if (authorTeamNames[0] && /media|communi/i.test(authorTeamNames[0])) {
          await nudgePublicSentiment(
            sessionId,
            mistakeType,
            (decision.title as string) ?? '',
            (decision.description as string) ?? '',
          );
        }
      } catch (heatErr) {
        logger.warn(
          { err: heatErr, sessionId, team: authorTeamNames[0] },
          'Heat meter / pathway / sentiment update failed, continuing',
        );
      }
    }
  } catch (antiGamingErr) {
    logger.error(
      { error: antiGamingErr, decisionId },
      'Anti-gaming check failed, continuing with remaining processing',
    );
  }

  // --- Phase 4: Env management, space claims, state effects (can run in parallel) ---
  const bgTasks: Promise<unknown>[] = [];

  bgTasks.push(
    evaluateEnvironmentalManagementIntentAndUpdateState(
      sessionId,
      {
        id: decision.id as string,
        title: decision.title as string,
        description: decision.description as string,
        type: (decision.type as string) ?? null,
      },
      env.openAiApiKey,
    ).catch((err) =>
      logger.error({ error: err, decisionId }, 'Env condition management check failed'),
    ),
  );

  bgTasks.push(
    evaluateStateEffectManagementAndUpdateState(
      sessionId,
      {
        id: decisionId,
        title: decision.title as string,
        description: decision.description as string,
      },
      env.openAiApiKey,
      userId,
    ).catch((err) =>
      logger.error({ error: err, decisionId }, 'State effect management check failed'),
    ),
  );

  if (authorTeamNames.length > 0) {
    bgTasks.push(
      (async () => {
        const decisionLower =
          `${(decision.title as string) ?? ''} ${(decision.description as string) ?? ''}`.toLowerCase();
        const { data: claimSession } = await supabaseAdmin
          .from('sessions')
          .select('scenario_id')
          .eq('id', sessionId)
          .single();
        const claimScenarioId = (claimSession as { scenario_id?: string } | null)?.scenario_id;
        const { data: scLocations } = claimScenarioId
          ? await supabaseAdmin
              .from('scenario_locations')
              .select('id, label, conditions')
              .eq('scenario_id', claimScenarioId)
          : { data: null };

        if (scLocations && scLocations.length > 0) {
          const assignmentPatterns =
            /\b(set\s+up|establish|designate|use\s+as|deploy\s+at|create|place|position|station\s+at|locate|assign|convert|transform|operate)\b/i;
          if (assignmentPatterns.test(decisionLower)) {
            for (const loc of scLocations) {
              const cond = (loc.conditions as Record<string, unknown>) ?? {};
              const isCandidateSpace =
                cond.pin_category === 'candidate_space' || Array.isArray(cond.potential_uses);
              if (!isCandidateSpace) continue;

              const label = (loc.label ?? '').toLowerCase();
              if (!label || !decisionLower.includes(label)) continue;

              const usePatterns: Array<[RegExp, string]> = [
                [/triage/i, 'triage'],
                [/command\s*(post|center|centre)/i, 'command_post'],
                [/staging/i, 'staging'],
                [/evacuation|assembly/i, 'evacuation_assembly'],
                [/media/i, 'media_center'],
                [/negotiation/i, 'negotiation_post'],
                [/decontamination|decon/i, 'decontamination'],
                [/morgue|mortuary|casualty\s*collection/i, 'casualty_collection'],
                [/logistics|supply/i, 'logistics'],
              ];
              let claimedAs = 'designated_area';
              for (const [pattern, name] of usePatterns) {
                if (pattern.test(decisionLower)) {
                  claimedAs = name;
                  break;
                }
              }

              const { data: sessionForTime } = await supabaseAdmin
                .from('sessions')
                .select('current_state')
                .eq('id', sessionId)
                .single();
              const gameMinutes =
                ((
                  (sessionForTime as Record<string, unknown>)?.current_state as Record<
                    string,
                    unknown
                  >
                )?.game_time_minutes as number) ?? 0;

              await recordSpaceClaim(
                sessionId,
                loc.id as string,
                authorTeamNames[0],
                claimedAs,
                typeof gameMinutes === 'number' ? gameMinutes : 0,
                (loc as { label?: string }).label ?? undefined,
              );
              break;
            }
          }
        }
      })().catch((err) => logger.error({ error: err, decisionId }, 'Space claim recording failed')),
    );
  }

  // Casualty movement effects from decision text
  bgTasks.push(
    applyDecisionCasualtyEffects(
      sessionId,
      (decision.title as string) ?? '',
      (decision.description as string) ?? '',
      authorTeamNames[0] ?? null,
    ).catch((err) => logger.error({ error: err, decisionId }, 'Decision casualty effects failed')),
  );

  // Transport outcome evaluation (route conditions → outcome inject)
  if (authorTeamNames.length > 0) {
    bgTasks.push(
      evaluateTransportOutcome(
        sessionId,
        {
          id: decisionId,
          title: (decision.title as string) ?? '',
          description: (decision.description as string) ?? '',
          type: (decision.type as string) ?? null,
        },
        authorTeamNames[0],
        env.openAiApiKey,
        io,
      ).catch((err) =>
        logger.error({ error: err, decisionId }, 'Transport outcome evaluation failed'),
      ),
    );
  }

  // Objective evaluation (fire-and-forget)
  bgTasks.push(
    evaluateAllObjectivesForSession(sessionId, env.openAiApiKey).catch((err) =>
      logger.error({ error: err, decisionId, sessionId }, 'AI objective evaluation failed'),
    ),
  );

  // Notification + event logging
  bgTasks.push(
    createNotification({
      sessionId,
      userId: decision.proposed_by as string,
      type: 'decision_executed',
      title: 'Decision Executed',
      message: `Your decision "${decision.title}" has been executed.`,
      priority: 'medium',
      metadata: { decision_id: decisionId },
      actionUrl: `/sessions/${sessionId}#decisions`,
    }).catch((err) => logger.error({ error: err, decisionId }, 'Error creating notification')),
  );

  bgTasks.push(
    logAndBroadcastEvent(
      io,
      sessionId,
      'decision',
      {
        decision_id: decisionId,
        status: 'executed',
        executed_by: { id: userId, role: userRole },
      },
      userId,
    ).catch((err) => logger.error({ error: err, decisionId }, 'Error logging event')),
  );

  await Promise.allSettled(bgTasks);
  logger.info({ decisionId }, 'Background decision processing complete');
}

// Execute decision
router.post('/:id/execute', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const user = req.user!;

    logger.info({ decisionId: id, userId: user.id }, 'Decision execute endpoint called');

    // Get decision to verify it exists
    const { data: decision } = await supabaseAdmin
      .from('decisions')
      .select('*')
      .eq('id', id)
      .single();

    if (!decision) {
      return res.status(404).json({ error: 'Decision not found' });
    }

    // Allow execution if: status is 'approved' (legacy flow) OR status is 'proposed' and user is the creator (streamlined flow)
    const canExecute =
      decision.status === 'approved' ||
      (decision.status === 'proposed' && decision.proposed_by === user.id);

    if (!canExecute) {
      logger.warn(
        {
          decisionId: id,
          currentStatus: decision.status,
          attemptedBy: user.id,
        },
        'Attempted to execute decision without permission',
      );

      return res.status(400).json({
        error:
          decision.status === 'proposed'
            ? 'Only the decision creator can execute this decision'
            : 'Only approved decisions can be executed',
        currentStatus: decision.status,
      });
    }

    // Atomic update: only update if status matches (prevents race conditions)
    const statusFilter = decision.status === 'approved' ? 'approved' : 'proposed';
    let query = supabaseAdmin
      .from('decisions')
      .update({
        status: 'executed',
        executed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', statusFilter);

    if (statusFilter === 'proposed') {
      query = query.eq('proposed_by', user.id);
    }

    const { data: updatedDecision, error } = await query
      .select('*, creator:user_profiles!decisions_proposed_by_fkey(id, full_name, role)')
      .single();

    if (error) {
      logger.error({ error, decisionId: id }, 'Failed to execute decision');
      return res.status(500).json({ error: 'Failed to execute decision' });
    }

    if (!updatedDecision) {
      return res.status(400).json({
        error: 'Decision could not be executed (status may have changed)',
        currentStatus: decision.status,
      });
    }

    // Map database fields to frontend expected fields
    const mappedDecision = {
      ...updatedDecision,
      decision_type: updatedDecision.type,
    };

    // Broadcast instantly via WebSocket so other clients update
    try {
      getWebSocketService().decisionExecuted(decision.session_id, mappedDecision);
    } catch (wsError) {
      logger.error(
        { error: wsError, decisionId: id },
        'Error broadcasting decision executed event',
      );
    }

    // Send response immediately — player sees instant feedback
    logger.info(
      { decisionId: id, userId: user.id },
      'Decision executed — starting background processing',
    );
    res.json({ data: mappedDecision });

    // All AI processing, env checks, heat meter, etc. run in background
    processExecutedDecisionInBackground(id, decision, user.id, user.role ?? 'participant').catch(
      (err) => {
        logger.error({ error: err, decisionId: id }, 'Background decision processing failed');
      },
    );
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /decisions/:id/execute');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as decisionsRouter };
