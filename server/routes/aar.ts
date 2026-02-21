import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import {
  calculateDecisionLatency,
  calculateCommunicationMetrics,
  calculateCoordinationScore,
  calculateComplianceRate,
  storeAARMetrics,
} from '../services/analyticsService.js';
import {
  calculateParticipantScores,
  storeParticipantScores,
} from '../services/participantScoreService.js';
import { calculateSessionScore } from '../services/objectiveTrackingService.js';
import { generateAARSummary, generateAARInsights } from '../services/aarAiService.js';
import * as aarExportService from '../services/aarExportService.js';
import { env } from '../env.js';

const router = Router();

// Get AAR report for a session
router.get('/session/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
    const user = req.user!;

    // Verify session access
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('id, trainer_id, status')
      .eq('id', sessionId)
      .single();

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Only trainers can view AAR, or if session is completed
    if (session.trainer_id !== user.id && user.role !== 'admin') {
      if (session.status !== 'completed') {
        return res.status(403).json({ error: 'AAR only available after session completion' });
      }
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

    // Get AAR report
    const { data: aar } = await supabaseAdmin
      .from('aar_reports')
      .select('*')
      .eq('session_id', sessionId)
      .single();

    // Get participant scores (linked to AAR report)
    const { data: scores } = aar
      ? await supabaseAdmin
          .from('participant_scores')
          .select('*, participant:user_profiles!participant_scores_participant_id_fkey(*)')
          .eq('aar_report_id', aar.id)
      : { data: null };

    // Get AAR metrics
    const { data: metrics } = aar
      ? await supabaseAdmin.from('aar_metrics').select('*').eq('aar_report_id', aar.id)
      : { data: null };

    // Get all events for timeline
    const { data: events } = await supabaseAdmin
      .from('session_events')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    // Get all decisions
    const { data: decisions } = await supabaseAdmin
      .from('decisions')
      .select('*')
      .eq('session_id', sessionId);

    // Get impact matrix evaluations (AI ratings per decision / inter-team impact)
    const { data: impactMatrices } = await supabaseAdmin
      .from('session_impact_matrix')
      .select(
        'id, evaluated_at, matrix, robustness_by_decision, escalation_factors_snapshot, analysis, response_taxonomy',
      )
      .eq('session_id', sessionId)
      .order('evaluated_at', { ascending: true });

    // Get escalation factors and pathways (7-stage escalation system)
    const [{ data: escalationFactors }, { data: escalationPathways }] = await Promise.all([
      supabaseAdmin
        .from('session_escalation_factors')
        .select('id, evaluated_at, factors')
        .eq('session_id', sessionId)
        .order('evaluated_at', { ascending: true }),
      supabaseAdmin
        .from('session_escalation_pathways')
        .select('id, evaluated_at, pathways')
        .eq('session_id', sessionId)
        .order('evaluated_at', { ascending: true }),
    ]);

    res.json({
      data: {
        aar: aar || null,
        scores: scores || [],
        metrics: metrics || [],
        events: events || [],
        decisions: decisions || [],
        impact_matrices: impactMatrices || [],
        escalation_factors: escalationFactors || [],
        escalation_pathways: escalationPathways || [],
        session,
      },
    });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /aar/session/:sessionId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Generate AAR report (trainers only)
router.post('/session/:sessionId/generate', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
    const user = req.user!;

    if (user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Only trainers can generate AAR reports' });
    }

    // Verify session exists and is completed
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('id, status, trainer_id')
      .eq('id', sessionId)
      .single();

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.trainer_id !== user.id && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (session.status !== 'completed') {
      return res.status(400).json({ error: 'Session must be completed to generate AAR' });
    }

    // Get all session data for AAR
    const { data: events } = await supabaseAdmin
      .from('session_events')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    const { data: decisions } = await supabaseAdmin
      .from('decisions')
      .select('*')
      .eq('session_id', sessionId);

    const { data: participants } = await supabaseAdmin
      .from('session_participants')
      .select('*, user:user_profiles(*)')
      .eq('session_id', sessionId);

    // Calculate metrics
    logger.info({ sessionId }, 'Calculating AAR metrics...');
    const decisionLatency = await calculateDecisionLatency(sessionId);
    const communication = await calculateCommunicationMetrics(sessionId);
    const coordination = await calculateCoordinationScore(sessionId);
    const compliance = await calculateComplianceRate(sessionId);

    // Get objective scores if available
    let objectiveScore = null;
    try {
      objectiveScore = await calculateSessionScore(sessionId);
    } catch (objectiveError) {
      logger.warn(
        { error: objectiveError, sessionId },
        'Failed to calculate objective scores, continuing without them',
      );
    }

    // Build key_metrics object
    const keyMetrics: Record<string, unknown> = {
      decision_latency: {
        avg_minutes: decisionLatency.avg_minutes,
        min_minutes: decisionLatency.min_minutes,
        max_minutes: decisionLatency.max_minutes,
        median_minutes: decisionLatency.median_minutes,
        p95_minutes: decisionLatency.p95_minutes,
        total_decisions: decisionLatency.total_decisions,
        by_type: decisionLatency.by_type,
      },
      communication: {
        total_messages: communication.total_messages,
        avg_response_time_minutes: communication.avg_response_time_minutes,
        inter_agency_message_count: communication.inter_agency_message_count,
        communication_delays: communication.communication_delays,
      },
      coordination: {
        overall_score: coordination.overall_score,
        inter_agency_interactions: coordination.inter_agency_interactions,
        cross_agency_approvals: coordination.cross_agency_approvals,
        inter_agency_messages: coordination.inter_agency_messages,
      },
      compliance: {
        rate: compliance.rate,
        total_required: compliance.total_required,
        approved: compliance.approved,
        rejected: compliance.rejected,
        by_type: compliance.by_type,
      },
    };

    if (objectiveScore) {
      keyMetrics.objectives = {
        overall_score: objectiveScore.overall_score,
        success_level: objectiveScore.success_level,
        objective_scores: objectiveScore.objective_scores,
      };
    }

    // Generate summary (simplified - AI summary will be added in Phase 5)
    const summary = `Session completed with ${events?.length || 0} events, ${decisions?.length || 0} decisions, and ${participants?.length || 0} participants. Average decision latency: ${decisionLatency.avg_minutes.toFixed(1)} minutes. Coordination score: ${coordination.overall_score}/100.`;

    // Create or update AAR report
    const { data: existingAar } = await supabaseAdmin
      .from('aar_reports')
      .select('*')
      .eq('session_id', sessionId)
      .single();

    const aarData = {
      session_id: sessionId,
      summary,
      key_metrics: keyMetrics,
      key_decisions: decisions || [],
      timeline_summary:
        events?.map((e) => ({
          time: e.created_at,
          type: e.event_type,
          data: e.event_data,
        })) || [],
      recommendations: [],
      ai_insights: [],
      generated_at: new Date().toISOString(),
      generated_by: user.id,
    };

    let aar;
    if (existingAar) {
      const { data: updated } = await supabaseAdmin
        .from('aar_reports')
        .update(aarData)
        .eq('id', existingAar.id)
        .select()
        .single();
      aar = updated;
    } else {
      const { data: created } = await supabaseAdmin
        .from('aar_reports')
        .insert(aarData)
        .select()
        .single();
      aar = created;
    }

    if (!aar) {
      return res.status(500).json({ error: 'Failed to create or update AAR report' });
    }

    // Store detailed metrics in aar_metrics table
    try {
      await storeAARMetrics(aar.id, {
        decisionLatency,
        communication,
        coordination,
        compliance,
      });
    } catch (metricsError) {
      logger.error(
        { error: metricsError, aarId: aar.id },
        'Failed to store AAR metrics, continuing...',
      );
      // Don't fail the entire request if metrics storage fails
    }

    // Calculate and store participant scores
    try {
      const participantScores = await calculateParticipantScores(sessionId, aar.id);
      await storeParticipantScores(aar.id, participantScores);
      logger.info(
        { sessionId, participantCount: participantScores.length },
        'Participant scores calculated and stored',
      );
    } catch (scoresError) {
      logger.error(
        { error: scoresError, sessionId },
        'Failed to calculate participant scores, continuing...',
      );
      // Don't fail the entire request if participant scoring fails
    }

    // Generate AI summary if OpenAI API key is configured
    if (env.openAiApiKey) {
      try {
        // Get session start/end times and scenario_id
        const { data: sessionDetails } = await supabaseAdmin
          .from('sessions')
          .select('start_time, end_time, scenario_id')
          .eq('id', sessionId)
          .single();

        const durationMinutes =
          sessionDetails?.start_time && sessionDetails?.end_time
            ? (new Date(sessionDetails.end_time).getTime() -
                new Date(sessionDetails.start_time).getTime()) /
              (1000 * 60)
            : 0;

        // Fetch scenario, objectives, injects, and escalation data for AAR context
        const scenarioId = sessionDetails?.scenario_id ?? null;
        const [
          scenarioRes,
          objectivesRes,
          injectEventsRes,
          escalationFactorsRes,
          escalationPathwaysRes,
          impactMatricesRes,
        ] = await Promise.all([
          scenarioId
            ? supabaseAdmin
                .from('scenarios')
                .select('id, title, description')
                .eq('id', scenarioId)
                .single()
            : { data: null },
          supabaseAdmin
            .from('scenario_objective_progress')
            .select('objective_id, objective_name, status, progress_percentage')
            .eq('session_id', sessionId),
          supabaseAdmin
            .from('session_events')
            .select('created_at, metadata')
            .eq('session_id', sessionId)
            .eq('event_type', 'inject')
            .order('created_at', { ascending: true }),
          supabaseAdmin
            .from('session_escalation_factors')
            .select('evaluated_at, factors')
            .eq('session_id', sessionId)
            .order('evaluated_at', { ascending: false })
            .limit(20),
          supabaseAdmin
            .from('session_escalation_pathways')
            .select('evaluated_at, pathways')
            .eq('session_id', sessionId)
            .order('evaluated_at', { ascending: false })
            .limit(20),
          supabaseAdmin
            .from('session_impact_matrix')
            .select(
              'evaluated_at, matrix, robustness_by_decision, escalation_factors_snapshot, analysis, response_taxonomy',
            )
            .eq('session_id', sessionId)
            .order('evaluated_at', { ascending: false })
            .limit(20),
        ]);

        const scenario = scenarioRes.data;
        const objectivesList = objectivesRes.data ?? [];
        const injectEvents = injectEventsRes.data ?? [];
        const escalationFactorsList = escalationFactorsRes.data ?? [];
        const escalationPathwaysList = escalationPathwaysRes.data ?? [];
        const impactMatricesList = impactMatricesRes.data ?? [];

        const injectsOccurred = injectEvents.map(
          (e: { created_at: string; metadata: Record<string, unknown> | null }) => {
            const meta = e.metadata ?? {};
            return {
              at: e.created_at,
              type: (meta.type as string) ?? undefined,
              title: (meta.title as string) ?? undefined,
              content: typeof meta.content === 'string' ? meta.content.slice(0, 500) : undefined,
            };
          },
        );

        const sessionDataForAI = {
          sessionId,
          durationMinutes,
          participantCount: participants?.length || 0,
          eventCount: events?.length || 0,
          decisionCount: decisions?.length || 0,
          decisions: (decisions || []).map(
            (d: {
              title: string;
              type: string;
              status: string;
              created_at: string;
              description?: string;
              executed_at?: string;
            }) => ({
              title: d.title,
              type: d.type,
              status: d.status,
              created_at: d.created_at,
              description: d.description,
              executed_at: d.executed_at,
            }),
          ),
          keyMetrics: keyMetrics as Record<string, unknown>,
          scenarioDescription: scenario?.description ?? undefined,
          scenarioTitle: scenario?.title ?? undefined,
          objectives: objectivesList.map(
            (o: { objective_name?: string; status?: string; progress_percentage?: number }) => ({
              objective_name: o.objective_name,
              status: o.status,
              progress_percentage: o.progress_percentage,
            }),
          ),
          injectsOccurred,
          escalationFactors: escalationFactorsList.map(
            (r: { evaluated_at: string; factors: unknown }) => ({
              evaluated_at: r.evaluated_at,
              factors: (r.factors ?? []) as Array<{
                id: string;
                name: string;
                description: string;
                severity: string;
              }>,
            }),
          ),
          escalationPathways: escalationPathwaysList.map(
            (r: { evaluated_at: string; pathways: unknown }) => ({
              evaluated_at: r.evaluated_at,
              pathways: (r.pathways ?? []) as Array<{
                pathway_id: string;
                trajectory: string;
                trigger_behaviours: string[];
              }>,
            }),
          ),
          impactMatrices: impactMatricesList.map(
            (m: {
              evaluated_at: string;
              matrix: unknown;
              robustness_by_decision?: unknown;
              escalation_factors_snapshot?: unknown;
              analysis?: unknown;
              response_taxonomy?: unknown;
            }) => ({
              evaluated_at: m.evaluated_at,
              matrix: (m.matrix ?? {}) as Record<string, Record<string, number>>,
              robustness_by_decision: (m.robustness_by_decision ?? {}) as Record<string, number>,
              escalation_factors_snapshot: m.escalation_factors_snapshot,
              analysis: m.analysis as
                | { overall?: string; matrix_reasoning?: string; robustness_reasoning?: string }
                | undefined,
              response_taxonomy: m.response_taxonomy,
            }),
          ),
        };

        const aiSummary = await generateAARSummary(sessionDataForAI, env.openAiApiKey);

        // Update AAR with AI summary
        await supabaseAdmin
          .from('aar_reports')
          .update({
            summary: aiSummary,
          })
          .eq('id', aar.id);

        // Generate structured insights
        try {
          const aiInsights = await generateAARInsights(sessionDataForAI, env.openAiApiKey);

          // Update AAR with AI insights
          await supabaseAdmin
            .from('aar_reports')
            .update({
              ai_insights: aiInsights,
            })
            .eq('id', aar.id);
        } catch (insightsError) {
          logger.warn(
            { error: insightsError, sessionId },
            'Failed to generate AI insights, continuing with summary only',
          );
        }

        logger.info({ sessionId }, 'AI summary and insights generated');
      } catch (aiError) {
        logger.warn(
          { error: aiError, sessionId },
          'Failed to generate AI summary, using basic summary',
        );
        // Continue with basic summary if AI fails
      }
    } else {
      logger.info({ sessionId }, 'OpenAI API key not configured, skipping AI summary generation');
    }

    // Fetch updated AAR with AI content
    const { data: updatedAar } = await supabaseAdmin
      .from('aar_reports')
      .select('*')
      .eq('id', aar.id)
      .single();

    logger.info({ sessionId, userId: user.id }, 'AAR report generated with metrics');
    res.json({ data: updatedAar || aar });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /aar/session/:sessionId/generate');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Export AAR report (trainers only)
router.post('/session/:sessionId/export', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
    const { format } = req.query; // 'pdf' or 'excel'
    const user = req.user!;

    if (user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Only trainers can export AAR reports' });
    }

    // Verify session exists and is completed
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('id, status, trainer_id')
      .eq('id', sessionId)
      .single();

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.trainer_id !== user.id && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get AAR report
    const { data: aar } = await supabaseAdmin
      .from('aar_reports')
      .select('*')
      .eq('session_id', sessionId)
      .single();

    if (!aar) {
      return res.status(404).json({ error: 'AAR report not found. Please generate it first.' });
    }

    // Get all related data
    const { data: scores } = await supabaseAdmin
      .from('participant_scores')
      .select('*, participant:user_profiles!participant_scores_participant_id_fkey(*)')
      .eq('aar_report_id', aar.id);

    const { data: metrics } = await supabaseAdmin
      .from('aar_metrics')
      .select('*')
      .eq('aar_report_id', aar.id);

    const { data: events } = await supabaseAdmin
      .from('session_events')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    const { data: decisions } = await supabaseAdmin
      .from('decisions')
      .select('*')
      .eq('session_id', sessionId);

    const aarData = {
      aar,
      scores: scores || [],
      metrics: metrics || [],
      events: events || [],
      decisions: decisions || [],
      session,
    };

    // Generate export
    const exportFormat = format === 'pdf' ? 'pdf' : 'excel';

    try {
      const { generatePDF, generateExcel, uploadExportToStorage } = aarExportService;

      const fileBuffer =
        exportFormat === 'pdf' ? await generatePDF(aarData) : await generateExcel(aarData);

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const extension = exportFormat === 'pdf' ? 'pdf' : 'xlsx';
      const fileName = `aar-${sessionId}-${timestamp}.${extension}`;
      const contentType =
        exportFormat === 'pdf'
          ? 'application/pdf'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

      const url = await uploadExportToStorage(fileBuffer, fileName, contentType);

      logger.info(
        { sessionId, format: exportFormat, fileName },
        'AAR export generated and uploaded',
      );
      res.json({ data: { url, fileName, format: exportFormat } });
    } catch (exportError) {
      logger.error(
        { error: exportError, sessionId, format: exportFormat },
        'Failed to generate export',
      );
      return res.status(500).json({
        error: `Export generation failed: ${exportError instanceof Error ? exportError.message : 'Unknown error'}`,
      });
    }
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /aar/session/:sessionId/export');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as aarRouter };
