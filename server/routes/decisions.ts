import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { validate } from '../lib/validation.js';
import { getWebSocketService } from '../services/websocketService.js';
import { logAndBroadcastEvent } from '../services/eventService.js';
import { updateStateOnDecisionExecution } from '../services/scenarioStateService.js';
import { classifyDecision } from '../services/aiService.js';
import { generateAndPublishInjectFromDecision } from '../services/injectTriggerService.js';
import {
  trackDecisionImpactOnObjectives,
  evaluateAllObjectivesForSession,
} from '../services/objectiveTrackingService.js';
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
    title: z.string().min(1).max(200),
    description: z.string().min(1),
    decision_type: z
      .enum([
        'public_statement',
        'resource_allocation',
        'emergency_declaration',
        'policy_change',
        'coordination_order',
      ])
      .optional(), // Make optional - AI will classify on execution
    required_approvers: z.array(z.string().uuid()).default([]), // Now accepts user IDs instead of roles
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
      const { session_id, title, description, decision_type, required_approvers } = req.body;

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
        .from('decisions')
        .insert({
          session_id,
          proposed_by: user.id,
          title,
          description,
          type: decision_type || null, // Allow null - AI will populate on execution
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

    // Get decision to verify it exists
    const { data: decision } = await supabaseAdmin
      .from('decisions')
      .select('*')
      .eq('id', id)
      .single();

    if (!decision) {
      return res.status(404).json({ error: 'Decision not found' });
    }

    // Atomic update: Only update if status is 'approved'
    // This prevents race conditions by checking and updating in a single database operation
    const { data: updatedDecision, error } = await supabaseAdmin
      .from('decisions')
      .update({
        status: 'executed',
        executed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', 'approved') // Atomic check: only update if status is 'approved'
      .select('*, creator:user_profiles!decisions_proposed_by_fkey(id, full_name, role)')
      .single();

    if (error) {
      logger.error({ error, decisionId: id }, 'Failed to execute decision');
      return res.status(500).json({ error: 'Failed to execute decision' });
    }

    // If no rows were updated, it means the status wasn't 'approved'
    if (!updatedDecision) {
      // Get current status for better error message
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
        'Attempted to execute decision that is not approved',
      );

      return res.status(400).json({
        error: 'Only approved decisions can be executed',
        currentStatus: currentDecision?.status || 'unknown',
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

    // AI classifies decision and generates fresh injects
    try {
      if (env.openAiApiKey) {
        // AI classifies decision
        const aiClassification = await classifyDecision(
          { title: decision.title, description: decision.description },
          env.openAiApiKey,
        );

        // Store classification
        await supabaseAdmin
          .from('decisions')
          .update({
            type: aiClassification.primary_category, // For backward compatibility
            ai_classification: aiClassification,
          })
          .eq('id', id);

        // Generate and publish a fresh inject based on the decision
        await generateAndPublishInjectFromDecision(
          decision.session_id,
          {
            id: decision.id,
            title: decision.title,
            description: decision.description,
            type: decision.type || aiClassification.primary_category,
          },
          aiClassification,
          io,
        );

        logger.info(
          { decisionId: id, classification: aiClassification.primary_category },
          'Decision classified and fresh inject generated',
        );
      } else {
        logger.warn('OpenAI API key not configured, skipping decision classification');
      }
    } catch (classificationError) {
      // Don't block decision execution if classification fails
      logger.error(
        { error: classificationError, decisionId: id },
        'Error in AI classification or inject generation, continuing with decision execution',
      );
    }

    // Track decision impact on objectives
    try {
      await trackDecisionImpactOnObjectives(decision.session_id, {
        id: decision.id,
        title: decision.title,
        description: decision.description,
        type: decision.type || 'operational_action',
      });
    } catch (objectiveError) {
      // Don't block decision execution if objective tracking fails
      logger.error(
        { error: objectiveError, decisionId: id },
        'Error tracking decision impact on objectives, continuing with decision execution',
      );
    }

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

    logger.info({ decisionId: id, userId: user.id }, 'Decision executed');
    res.json({ data: mappedDecision });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /decisions/:id/execute');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as decisionsRouter };
