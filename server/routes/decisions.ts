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
  selectAndPublishPathwayOutcome,
  nudgePublicSentiment,
} from '../services/heatMeterService.js';
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
    response_to_incident_id: z.string().uuid().optional(),
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
      // For regular participants, only show decisions they created or are assigned to approve
      const decisionIds = (allDecisions || []).map((d: Record<string, unknown>) => d.id as string);

      if (decisionIds.length === 0) {
        relevantDecisions = [];
      } else {
        // Get all decision IDs where the user has a step
        const { data: userSteps, error: stepsError } = await supabaseAdmin
          .from('decision_steps')
          .select('decision_id')
          .eq('user_id', user.id)
          .in('decision_id', decisionIds);

        if (stepsError) {
          logger.error(
            {
              error: stepsError,
              userId: user.id,
              sessionId,
              decisionIdsCount: decisionIds.length,
              decisionIds: decisionIds.slice(0, 5), // Log first 5 for debugging
            },
            'Failed to fetch user decision steps',
          );
        }

        const userDecisionIds = new Set(
          (userSteps || []).map((step: { decision_id: string }) => step.decision_id),
        );

        logger.info(
          {
            userId: user.id,
            sessionId,
            userStepsFound: userSteps?.length || 0,
            userDecisionIds: Array.from(userDecisionIds),
            totalDecisions: decisionIds.length,
            decisionsCreatedByUser: (allDecisions || []).filter(
              (d: Record<string, unknown>) => d.proposed_by === user.id,
            ).length,
          },
          'Filtering decisions for user',
        );

        // Filter decisions: user can see if they created it OR have a step in it
        relevantDecisions = (allDecisions || []).filter((decision: Record<string, unknown>) => {
          const isCreator = decision.proposed_by === user.id;
          const hasStep = userDecisionIds.has(decision.id as string);
          return isCreator || hasStep;
        });

        logger.info(
          {
            userId: user.id,
            sessionId,
            filteredCount: relevantDecisions.length,
            totalCount: allDecisions?.length || 0,
          },
          'Filtered decisions for user',
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
        required_approvers,
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
        decision_type: decisionResponse.type, // Map type to decision_type for frontend
      };

      // Broadcast decision created event
      try {
        getWebSocketService().decisionProposed(session_id, mappedDecision);
      } catch (wsError) {
        logger.error(
          { error: wsError, decisionId: data.id },
          'Failed to broadcast decision creation via WebSocket',
        );
      }

      // Log event
      try {
        await logAndBroadcastEvent(
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
        );
      } catch (eventError) {
        logger.error(
          { error: eventError, decisionId: data.id },
          'Failed to log decision creation event',
        );
      }

      logger.info({ decisionId: data.id, userId: user.id }, 'Decision created');
      res.status(201).json({ data: mappedDecision });
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

// Execute decision
router.post('/:id/execute', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const user = req.user!;

    // ═══════════════════════════════════════════════════════
    // CRITICAL: Use both logger AND console.log to ensure visibility
    // ═══════════════════════════════════════════════════════
    console.log('🔵 EXECUTE ENDPOINT CALLED', {
      decisionId: id,
      userId: user.id,
      timestamp: new Date().toISOString(),
    });
    logger.info(
      { decisionId: id, userId: user.id },
      'EXECUTE_ENDPOINT: Decision execute endpoint called',
    );

    // Get decision to verify it exists
    const { data: decision } = await supabaseAdmin
      .from('decisions')
      .select('*')
      .eq('id', id)
      .single();

    if (!decision) {
      console.log('🔴 DECISION NOT FOUND', { decisionId: id });
      return res.status(404).json({ error: 'Decision not found' });
    }

    console.log('🟡 DECISION FOUND', { decisionId: id, status: decision.status });

    // Allow execution if: status is 'approved' (legacy flow) OR status is 'proposed' and user is the creator (streamlined flow)
    const canExecute =
      decision.status === 'approved' ||
      (decision.status === 'proposed' && decision.proposed_by === user.id);

    if (!canExecute) {
      const { data: currentDecision } = await supabaseAdmin
        .from('decisions')
        .select('status')
        .eq('id', id)
        .single();

      logger.warn(
        {
          decisionId: id,
          currentStatus: currentDecision?.status,
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

    // Update scenario state based on decision execution
    try {
      await updateStateOnDecisionExecution(decision.session_id, {
        ...updatedDecision,
        decision_type: updatedDecision.type || 'operational_action',
      });
    } catch (stateError) {
      logger.error(
        { error: stateError, decisionId: id },
        'Error updating scenario state, continuing with decision execution',
      );
    }

    // After the state update section, before AI block:
    console.log('🟡 BEFORE AI BLOCK', { decisionId: id, hasOpenAiKey: !!env.openAiApiKey });
    logger.info(
      { decisionId: id, hasOpenAiKey: !!env.openAiApiKey },
      'BEFORE_AI_BLOCK: About to start AI processing',
    );

    // AI classifies decision and generates fresh injects
    try {
      console.log('🟡 INSIDE AI TRY', {
        decisionId: id,
        hasOpenAiKey: !!env.openAiApiKey,
        keyLength: env.openAiApiKey?.length || 0,
      });
      logger.info(
        { decisionId: id, hasOpenAiKey: !!env.openAiApiKey },
        'INSIDE_AI_TRY: Entered AI processing try-catch block',
      );

      if (env.openAiApiKey) {
        console.log('🟢 OPENAI KEY EXISTS', { decisionId: id, keyLength: env.openAiApiKey.length });
        logger.info({ decisionId: id }, 'OPENAI_KEY_FOUND: Proceeding with classification');

        // AI classifies decision
        const aiClassification = await classifyDecision(
          { title: decision.title, description: decision.description },
          env.openAiApiKey,
        );

        console.log('🟢 CLASSIFICATION COMPLETE', {
          decisionId: id,
          classification: aiClassification.primary_category,
        });
        logger.info(
          { decisionId: id, classification: aiClassification.primary_category },
          'CLASSIFICATION_SUCCESS: Decision classified',
        );

        // Store classification
        await supabaseAdmin
          .from('decisions')
          .update({
            type: aiClassification.primary_category, // For backward compatibility
            ai_classification: aiClassification,
          })
          .eq('id', id);

        // Phase 3: Update team state from decision (evacuation_state, triage_state, media_state)
        try {
          const { data: authorTeams } = await supabaseAdmin
            .from('session_teams')
            .select('team_name')
            .eq('session_id', decision.session_id)
            .eq('user_id', decision.proposed_by);
          const authorTeamNames = (authorTeams ?? []).map(
            (r: { team_name: string }) => r.team_name,
          );
          const { data: sessionRow } = await supabaseAdmin
            .from('sessions')
            .select('start_time, scenario_id')
            .eq('id', decision.session_id)
            .single();
          const startTime = (sessionRow as { start_time?: string } | null)?.start_time;
          const elapsedMinutes = startTime
            ? Math.floor((Date.now() - new Date(startTime).getTime()) / 60000)
            : 0;
          await updateTeamStateFromDecision(
            decision.session_id,
            id,
            authorTeamNames,
            aiClassification,
            elapsedMinutes,
            {
              decisionTitle: decision.title ?? '',
              decisionDescription: decision.description ?? '',
              scenarioId: (sessionRow as { scenario_id?: string } | null)?.scenario_id ?? undefined,
            },
          );
        } catch (teamStateErr) {
          logger.error(
            { error: teamStateErr, decisionId: id },
            'Failed to update team state from decision',
          );
        }

        // Phase 3: Evaluate decision-based triggers and auto-publish matching injects
        if (aiClassification && io) {
          try {
            // Resolve the decision-maker's team for inject scoping
            const { data: triggerAuthorTeams } = await supabaseAdmin
              .from('session_teams')
              .select('team_name')
              .eq('session_id', decision.session_id)
              .eq('user_id', decision.proposed_by);
            const triggerTeamName =
              (triggerAuthorTeams ?? []).length > 0
                ? (triggerAuthorTeams![0] as { team_name: string }).team_name
                : null;
            await evaluateDecisionBasedTriggers(
              decision.session_id,
              { id, title: decision.title, description: decision.description },
              aiClassification,
              io,
              triggerTeamName,
            );
          } catch (triggerErr) {
            logger.error(
              { error: triggerErr, decisionId: id },
              'Decision-based trigger evaluation failed',
            );
          }
        }

        // AI injects will be generated by the scheduled service every 5 minutes
        // based on all recent decisions and state, rather than immediately per decision
        logger.info(
          { decisionId: id, classification: aiClassification.primary_category },
          'Decision classified (AI injects will be generated by scheduled service every 5 minutes)',
        );
      } else {
        console.log('🔴 OPENAI KEY MISSING', { decisionId: id, envKey: env.openAiApiKey });
        logger.warn(
          { decisionId: id, hasKey: !!env.openAiApiKey },
          'OPENAI_KEY_MISSING: OpenAI API key not configured',
        );
      }
    } catch (classificationError) {
      console.error('🔴 AI ERROR', {
        decisionId: id,
        error:
          classificationError instanceof Error
            ? classificationError.message
            : String(classificationError),
      });
      logger.error(
        { error: classificationError, decisionId: id },
        'AI_ERROR: Error in AI classification or inject generation',
      );
    }

    logger.info({ decisionId: id }, 'AFTER_AI_BLOCK: Completed AI processing');

    let authorTeamNames: string[] = [];
    try {
      const { data: authorTeams } = await supabaseAdmin
        .from('session_teams')
        .select('team_name')
        .eq('session_id', decision.session_id)
        .eq('user_id', decision.proposed_by);
      authorTeamNames = (authorTeams ?? []).map((r: { team_name: string }) => r.team_name);

      const { data: sessionRow } = await supabaseAdmin
        .from('sessions')
        .select('scenario_id, trainer_id')
        .eq('id', decision.session_id)
        .single();
      const sessionScenarioId =
        (sessionRow as { scenario_id?: string } | null)?.scenario_id ?? null;
      const sessionTrainerId = (sessionRow as { trainer_id?: string } | null)?.trainer_id ?? null;

      // Count ALL previous quality failure injects for this team (unified escalation counter)
      let qualityFailureCount = 0;
      if (authorTeamNames.length > 0) {
        const { data: prevFailEvents, error: failCountErr } = await supabaseAdmin
          .from('session_events')
          .select('id')
          .eq('session_id', decision.session_id)
          .eq('event_type', 'quality_failure_inject_fired')
          .filter('metadata->>team', 'eq', authorTeamNames[0]);
        if (!failCountErr && prevFailEvents) {
          qualityFailureCount = prevFailEvents.length;
        }
      }

      // Load incident context for Checkpoint 2 when decision is incident-linked
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

      // Checkpoint 2: Environmental consistency + specificity (escalation-aware)
      const aiEnvResult = await evaluateDecisionAgainstEnvironment(
        decision.session_id,
        {
          id: decision.id,
          title: decision.title,
          description: decision.description,
          type: decision.type ?? null,
        },
        env.openAiApiKey,
        incidentContext,
        authorTeamNames[0],
        qualityFailureCount,
      );
      // Step 5: Environmental prerequisite (corridor traffic + location-condition + space contention gate); overrides AI result when failed
      const { result: prereqResult, evaluationReason: envPrereqReason } =
        await evaluateEnvironmentalPrerequisite(
          decision.session_id,
          {
            id: decision.id,
            title: decision.title,
            description: decision.description,
            type: decision.type ?? null,
            team_name: authorTeamNames[0] ?? undefined,
          },
          incidentContext,
          env.openAiApiKey,
        );
      const envResult = prereqResult && !prereqResult.consistent ? prereqResult : aiEnvResult;
      logger.info(
        {
          sessionId: decision.session_id,
          decisionId: decision.id,
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
        .eq('id', decision.id);

      // Persist evaluation reasoning (env prerequisite) for AAR/trainer visibility
      if (envPrereqReason != null) {
        await supabaseAdmin
          .from('decisions')
          .update({ evaluation_reasoning: { env_prerequisite: envPrereqReason } })
          .eq('id', decision.id);
      }

      // Unified quality failure inject: fire an escalating consequence for ANY quality issue
      type FailureType = 'vague' | 'contradiction' | 'below_standard' | 'prereq' | 'rejected';
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
        envResult.mismatch_kind !== 'below_standard' &&
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
          // --- Cancellation check: include ALL decisions (including the current one) ---
          if (env.openAiApiKey && failureType !== 'rejected') {
            const { data: allDecisionRows } = await supabaseAdmin
              .from('decisions')
              .select('title, description, type')
              .eq('session_id', decision.session_id)
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
                session_id: decision.session_id,
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
                  session_id: decision.session_id,
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
                      decisionId: decision.id,
                      team: authorTeamNames[0],
                      failureType,
                      cancel_reason: cancelCheck.cancel_reason,
                    },
                    'Quality failure inject cancelled — decisions addressed concern',
                  );
                  await updateTeamHeatMeter(decision.session_id, authorTeamNames[0], 'good');
                  failureType = null;
                  failureContent = '';
                }
              } catch (cancelErr) {
                logger.warn(
                  { err: cancelErr, decisionId: decision.id },
                  'Quality failure cancellation check failed, proceeding with inject',
                );
              }
            }
          }

          // --- Publish quality failure inject if not cancelled ---
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
            const injectTitle = `${titleBase} – ${authorTeamNames[0]} (${decision.id.slice(0, 8)})`;

            const { data: qualityInject, error: qualityInsertErr } = await supabaseAdmin
              .from('scenario_injects')
              .insert({
                scenario_id: sessionScenarioId,
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
                { err: qualityInsertErr, decisionId: decision.id, team: authorTeamNames[0] },
                'Quality failure inject insert failed',
              );
            }

            if (qualityInject) {
              await publishInjectToSession(
                qualityInject.id,
                decision.session_id,
                sessionTrainerId,
                io,
              );
              await supabaseAdmin.from('session_events').insert({
                session_id: decision.session_id,
                event_type: 'quality_failure_inject_fired',
                description: `Quality failure (${failureType}) for ${authorTeamNames[0]} (escalation ${qualityFailureCount + 1})`,
                actor_id: null,
                metadata: {
                  team: authorTeamNames[0],
                  decision_id: decision.id,
                  failure_type: failureType,
                  escalation: qualityFailureCount + 1,
                },
              });
              logger.info(
                {
                  sessionId: decision.session_id,
                  decisionId: decision.id,
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
            { err: qualityErr, sessionId: decision.session_id, decisionId: decision.id },
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
            .eq('session_id', decision.session_id)
            .in('team_name', authorTeamNames);
          const teamUserIds = (teamUserRows ?? []).map((r: { user_id: string }) => r.user_id);
          const consulted = await teamConsultedInsiderBefore(
            decision.session_id,
            teamUserIds,
            new Date().toISOString(),
          );
          if (!consulted) {
            noIntel = true;
          }
        } catch (intelErr) {
          logger.warn(
            { err: intelErr, sessionId: decision.session_id },
            'Insider knowledge check failed, continuing',
          );
        }
      }

      // Heat meter: determine mistake type from evaluation results
      if (authorTeamNames.length > 0) {
        let mistakeType: 'vague' | 'contradiction' | 'prereq' | 'no_intel' | 'rejected' | 'good' =
          'good';
        if (rejected) {
          mistakeType = 'rejected';
        } else if (envResult.specific === false) {
          mistakeType = 'vague';
        } else if (!envResult.consistent && envResult.mismatch_kind !== 'below_standard') {
          mistakeType = 'contradiction';
        } else if (!envResult.consistent) {
          mistakeType = 'prereq';
        } else if (noIntel) {
          mistakeType = 'no_intel';
        }
        try {
          const { heat_percentage } = await updateTeamHeatMeter(
            decision.session_id,
            authorTeamNames[0],
            mistakeType,
            io,
          );

          if (sessionScenarioId && sessionTrainerId && io) {
            await selectAndPublishPathwayOutcome(
              decision.session_id,
              authorTeamNames[0],
              heat_percentage,
              sessionScenarioId,
              sessionTrainerId,
              io,
            );
          }

          if (authorTeamNames[0] === 'media') {
            await nudgePublicSentiment(decision.session_id, mistakeType);
          }
        } catch (heatErr) {
          logger.warn(
            { err: heatErr, sessionId: decision.session_id, team: authorTeamNames[0] },
            'Heat meter / pathway / sentiment update failed, continuing',
          );
        }
      }
    } catch (antiGamingErr) {
      logger.error(
        { error: antiGamingErr, decisionId: id },
        'Anti-gaming check failed, continuing with objective tracking',
      );
    }

    // Environmental condition management: if decision credibly addressed an unmanaged route/location, mark it managed
    try {
      await evaluateEnvironmentalManagementIntentAndUpdateState(
        decision.session_id,
        {
          id: decision.id,
          title: decision.title,
          description: decision.description,
          type: decision.type ?? null,
        },
        env.openAiApiKey,
      );
    } catch (envMgmtErr) {
      logger.error(
        { error: envMgmtErr, decisionId: id },
        'Env condition management check failed, continuing',
      );
    }

    // Space claim recording: if decision references a candidate space and assigns a function, record the claim
    if (authorTeamNames.length > 0) {
      try {
        const decisionLower = `${decision.title ?? ''} ${decision.description ?? ''}`.toLowerCase();
        const { data: claimSession } = await supabaseAdmin
          .from('sessions')
          .select('scenario_id')
          .eq('id', decision.session_id)
          .single();
        const claimScenarioId = (claimSession as { scenario_id?: string } | null)?.scenario_id;
        const { data: scLocations } = claimScenarioId
          ? await supabaseAdmin
              .from('scenario_locations')
              .select('id, label, conditions')
              .eq('scenario_id', claimScenarioId)
          : { data: null };

        if (scLocations && scLocations.length > 0) {
          // Assignment keywords that suggest a team is assigning a function to a space
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

              // Determine what the space is being used as
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

              // Get current game time (minutes into scenario) from session state
              const { data: sessionForTime } = await supabaseAdmin
                .from('sessions')
                .select('current_state')
                .eq('id', decision.session_id)
                .single();
              const gameMinutes =
                ((
                  (sessionForTime as Record<string, unknown>)?.current_state as Record<
                    string,
                    unknown
                  >
                )?.game_time_minutes as number) ?? 0;

              await recordSpaceClaim(
                decision.session_id,
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
      } catch (claimErr) {
        logger.error(
          { error: claimErr, decisionId: id },
          'Space claim recording failed, continuing',
        );
      }
    }

    // State effect management: if decision credibly addresses an active state effect (e.g. exit congestion), mark it managed
    try {
      await evaluateStateEffectManagementAndUpdateState(
        decision.session_id,
        { id: decision.id, title: decision.title, description: decision.description },
        env.openAiApiKey,
        user.id,
      );
    } catch (stateEffErr) {
      logger.error(
        { error: stateEffErr, decisionId: id },
        'State effect management check failed, continuing',
      );
    }

    // Old keyword-based objective tracking removed — replaced by heat meter system above

    // Evaluate objectives with AI to determine if any are complete (non-blocking)
    try {
      // Run in background - don't await to avoid blocking decision execution
      evaluateAllObjectivesForSession(decision.session_id, env.openAiApiKey).catch((evalError) => {
        // Log but don't throw - this is a background process
        logger.error(
          { error: evalError, decisionId: id, sessionId: decision.session_id },
          'Error in AI objective evaluation, continuing without blocking',
        );
      });
    } catch (evalError) {
      // Log but don't block decision execution
      logger.error(
        { error: evalError, decisionId: id },
        'Error initiating AI objective evaluation, continuing with decision execution',
      );
    }

    // Broadcast decision executed event
    try {
      getWebSocketService().decisionExecuted(decision.session_id, mappedDecision);
    } catch (wsError) {
      logger.error(
        { error: wsError, decisionId: id },
        'Error broadcasting decision executed event',
      );
    }

    // Notify decision creator that it was executed
    try {
      await createNotification({
        sessionId: decision.session_id,
        userId: decision.proposed_by,
        type: 'decision_executed',
        title: 'Decision Executed',
        message: `Your decision "${decision.title}" has been executed.`,
        priority: 'medium',
        metadata: {
          decision_id: decision.id,
        },
        actionUrl: `/sessions/${decision.session_id}#decisions`,
      });
    } catch (notifError) {
      logger.error({ error: notifError, decisionId: id }, 'Error creating notification');
    }

    // Log event
    try {
      await logAndBroadcastEvent(
        io,
        decision.session_id,
        'decision',
        {
          decision_id: id,
          status: 'executed',
          executed_by: { id: user.id, role: user.role },
        },
        user.id,
      );
    } catch (eventError) {
      logger.error({ error: eventError, decisionId: id }, 'Error logging event');
    }

    console.log('🟢 EXECUTE COMPLETE', { decisionId: id });
    logger.info({ decisionId: id, userId: user.id }, 'Decision executed');
    res.json({ data: mappedDecision });
  } catch (err) {
    console.error('🔴 EXECUTE ERROR', { error: err instanceof Error ? err.message : String(err) });
    logger.error({ error: err }, 'Error in POST /decisions/:id/execute');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as decisionsRouter };
