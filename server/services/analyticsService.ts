import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';

/**
 * Analytics Service
 * Calculates metrics for AAR reports including decision latency, communication metrics,
 * coordination scores, and compliance rates
 */

export interface DecisionLatencyMetrics {
  avg_minutes: number;
  min_minutes: number;
  max_minutes: number;
  median_minutes: number;
  p95_minutes: number;
  total_decisions: number;
  by_type: Record<
    string,
    {
      avg_minutes: number;
      count: number;
    }
  >;
}

export interface CommunicationMetrics {
  total_messages: number;
  messages_per_participant: Record<string, number>;
  avg_response_time_minutes: number;
  inter_agency_message_count: number;
  communication_delays: Array<{
    channel_id: string;
    channel_name: string;
    first_response_minutes: number;
  }>;
}

export interface CoordinationMetrics {
  overall_score: number; // 0-100
  inter_agency_interactions: number;
  cross_agency_approvals: number;
  inter_agency_messages: number;
}

export interface ComplianceMetrics {
  rate: number; // percentage
  total_required: number;
  approved: number;
  rejected: number;
  by_type: Record<
    string,
    {
      required: number;
      approved: number;
      rate: number;
    }
  >;
}

/**
 * Calculate decision latency metrics
 */
export async function calculateDecisionLatency(sessionId: string): Promise<DecisionLatencyMetrics> {
  try {
    // Get all executed or approved decisions with their steps
    const { data: decisions, error: decisionsError } = await supabaseAdmin
      .from('decisions')
      .select('id, type, created_at, executed_at, status, proposed_by')
      .eq('session_id', sessionId)
      .in('status', ['executed', 'approved']);

    if (decisionsError) {
      logger.error(
        { error: decisionsError, sessionId },
        'Failed to fetch decisions for latency calculation',
      );
      throw decisionsError;
    }

    // Get decision steps to find approval times
    // Note: decision_steps doesn't have session_id directly, need to filter by decision_id
    const decisionIds = (decisions || []).map((d) => d.id);
    const { data: steps, error: stepsError } =
      decisionIds.length > 0
        ? await supabaseAdmin
            .from('decision_steps')
            .select('decision_id, status, created_at, timestamp')
            .in('decision_id', decisionIds)
            .in('status', ['approved', 'executed'])
        : { data: [], error: null };

    if (stepsError) {
      logger.error(
        { error: stepsError, sessionId },
        'Failed to fetch decision steps for latency calculation',
      );
      throw stepsError;
    }

    const latencies: number[] = [];
    const latenciesByType: Record<string, number[]> = {};

    for (const decision of decisions || []) {
      const decisionCreatedAt = new Date(decision.created_at).getTime();
      let decisionCompletedAt: number | null = null;

      // Use executed_at if available, otherwise find latest approval step
      if (decision.executed_at) {
        decisionCompletedAt = new Date(decision.executed_at).getTime();
      } else {
        const decisionSteps = steps?.filter((s) => s.decision_id === decision.id) || [];
        if (decisionSteps.length > 0) {
          const latestStep = decisionSteps.reduce((latest, step) => {
            const stepTime = new Date(step.timestamp || step.created_at).getTime();
            const latestTime = new Date(latest.timestamp || latest.created_at).getTime();
            return stepTime > latestTime ? step : latest;
          });
          decisionCompletedAt = new Date(latestStep.timestamp || latestStep.created_at).getTime();
        }
      }

      if (decisionCompletedAt) {
        const latencyMinutes = (decisionCompletedAt - decisionCreatedAt) / (1000 * 60);
        latencies.push(latencyMinutes);

        const decisionType = decision.type || 'unknown';
        if (!latenciesByType[decisionType]) {
          latenciesByType[decisionType] = [];
        }
        latenciesByType[decisionType].push(latencyMinutes);
      }
    }

    // Calculate statistics
    const sortedLatencies = [...latencies].sort((a, b) => a - b);
    const avg = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
    const min = sortedLatencies.length > 0 ? sortedLatencies[0] : 0;
    const max = sortedLatencies.length > 0 ? sortedLatencies[sortedLatencies.length - 1] : 0;
    const median =
      sortedLatencies.length > 0 ? sortedLatencies[Math.floor(sortedLatencies.length / 2)] : 0;
    const p95Index = Math.floor(sortedLatencies.length * 0.95);
    const p95 = sortedLatencies.length > 0 ? sortedLatencies[p95Index] : 0;

    // Calculate by type
    const byType: Record<string, { avg_minutes: number; count: number }> = {};
    for (const [type, typeLatencies] of Object.entries(latenciesByType)) {
      byType[type] = {
        avg_minutes: typeLatencies.reduce((a, b) => a + b, 0) / typeLatencies.length,
        count: typeLatencies.length,
      };
    }

    return {
      avg_minutes: avg,
      min_minutes: min,
      max_minutes: max,
      median_minutes: median,
      p95_minutes: p95,
      total_decisions: latencies.length,
      by_type: byType,
    };
  } catch (err) {
    logger.error({ error: err, sessionId }, 'Error calculating decision latency metrics');
    throw err;
  }
}

/**
 * Calculate communication metrics
 */
export async function calculateCommunicationMetrics(
  sessionId: string,
): Promise<CommunicationMetrics> {
  try {
    // Get all messages for the session
    const { data: messages, error: messagesError } = await supabaseAdmin
      .from('chat_messages')
      .select('id, sender_id, channel_id, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (messagesError) {
      logger.error(
        { error: messagesError, sessionId },
        'Failed to fetch messages for communication metrics',
      );
      throw messagesError;
    }

    // Get channel information to identify inter-agency channels
    const { data: channels, error: channelsError } = await supabaseAdmin
      .from('chat_channels')
      .select('id, name, type')
      .eq('session_id', sessionId);

    if (channelsError) {
      logger.error(
        { error: channelsError, sessionId },
        'Failed to fetch channels for communication metrics',
      );
      throw channelsError;
    }

    // Get session participants to identify roles
    const { data: participants, error: participantsError } = await supabaseAdmin
      .from('session_participants')
      .select('user_id, role')
      .eq('session_id', sessionId);

    if (participantsError) {
      logger.error(
        { error: participantsError, sessionId },
        'Failed to fetch participants for communication metrics',
      );
      throw participantsError;
    }

    // Count messages per participant
    const messagesPerParticipant: Record<string, number> = {};
    const participantRoleMap: Record<string, string> = {};

    for (const participant of participants || []) {
      messagesPerParticipant[participant.user_id] = 0;
      participantRoleMap[participant.user_id] = participant.role;
    }

    for (const message of messages || []) {
      if (messagesPerParticipant[message.sender_id] !== undefined) {
        messagesPerParticipant[message.sender_id]++;
      }
    }

    // Calculate average response time (time between messages in same channel)
    const channelMessages: Record<string, Array<{ time: number; sender_id: string }>> = {};
    for (const message of messages || []) {
      if (!channelMessages[message.channel_id]) {
        channelMessages[message.channel_id] = [];
      }
      channelMessages[message.channel_id].push({
        time: new Date(message.created_at).getTime(),
        sender_id: message.sender_id,
      });
    }

    const responseTimes: number[] = [];
    for (const channelId in channelMessages) {
      const channelMsgs = channelMessages[channelId];
      for (let i = 1; i < channelMsgs.length; i++) {
        const timeDiff = (channelMsgs[i].time - channelMsgs[i - 1].time) / (1000 * 60); // minutes
        if (timeDiff < 1440) {
          // Ignore gaps > 24 hours (likely not responses)
          responseTimes.push(timeDiff);
        }
      }
    }

    const avgResponseTime =
      responseTimes.length > 0
        ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
        : 0;

    // Calculate inter-agency messages (messages in channels with multiple roles or inter-agency channels)
    const interAgencyChannelIds = new Set(
      (channels || [])
        .filter((c) => c.type === 'inter_agency' || c.type === 'command')
        .map((c) => c.id),
    );

    let interAgencyMessageCount = 0;
    const channelFirstResponse: Record<
      string,
      { channelName: string; firstResponseMinutes: number }
    > = {};

    for (const message of messages || []) {
      if (interAgencyChannelIds.has(message.channel_id)) {
        interAgencyMessageCount++;

        // Track first response time per channel
        if (!channelFirstResponse[message.channel_id]) {
          const channel = channels?.find((c) => c.id === message.channel_id);
          const session = await supabaseAdmin
            .from('sessions')
            .select('start_time')
            .eq('id', sessionId)
            .single();

          if (session.data?.start_time) {
            const sessionStart = new Date(session.data.start_time).getTime();
            const messageTime = new Date(message.created_at).getTime();
            const firstResponseMinutes = (messageTime - sessionStart) / (1000 * 60);
            channelFirstResponse[message.channel_id] = {
              channelName: channel?.name || 'Unknown',
              firstResponseMinutes,
            };
          }
        }
      }
    }

    const communicationDelays = Object.values(channelFirstResponse).map((info) => ({
      channel_id:
        Object.keys(channelFirstResponse).find((k) => channelFirstResponse[k] === info) || '',
      channel_name: info.channelName,
      first_response_minutes: info.firstResponseMinutes,
    }));

    return {
      total_messages: messages?.length || 0,
      messages_per_participant: messagesPerParticipant,
      avg_response_time_minutes: avgResponseTime,
      inter_agency_message_count: interAgencyMessageCount,
      communication_delays: communicationDelays,
    };
  } catch (err) {
    logger.error({ error: err, sessionId }, 'Error calculating communication metrics');
    throw err;
  }
}

/**
 * Calculate coordination score
 */
export async function calculateCoordinationScore(sessionId: string): Promise<CoordinationMetrics> {
  try {
    // Get decisions and identify cross-agency approvals
    const { data: decisions, error: decisionsError } = await supabaseAdmin
      .from('decisions')
      .select('id, proposed_by, type')
      .eq('session_id', sessionId);

    if (decisionsError) {
      logger.error(
        { error: decisionsError, sessionId },
        'Failed to fetch decisions for coordination score',
      );
      throw decisionsError;
    }

    // Get decision steps to find approvers
    // Note: decision_steps doesn't have session_id directly, need to join through decisions
    const { data: decisionsList } = await supabaseAdmin
      .from('decisions')
      .select('id')
      .eq('session_id', sessionId);

    const decisionIds = (decisionsList || []).map((d) => d.id);

    const { data: steps, error: stepsError } =
      decisionIds.length > 0
        ? await supabaseAdmin
            .from('decision_steps')
            .select('decision_id, user_id, status')
            .in('decision_id', decisionIds)
            .eq('status', 'approved')
        : { data: [], error: null };

    if (stepsError) {
      logger.error(
        { error: stepsError, sessionId },
        'Failed to fetch decision steps for coordination score',
      );
      throw stepsError;
    }

    // Get participants to map user IDs to roles
    const { data: participants, error: participantsError } = await supabaseAdmin
      .from('session_participants')
      .select('user_id, role')
      .eq('session_id', sessionId);

    if (participantsError) {
      logger.error(
        { error: participantsError, sessionId },
        'Failed to fetch participants for coordination score',
      );
      throw participantsError;
    }

    const participantRoleMap: Record<string, string> = {};
    for (const participant of participants || []) {
      participantRoleMap[participant.user_id] = participant.role;
    }

    // Count cross-agency approvals (approver from different role than proposer)
    let crossAgencyApprovals = 0;
    for (const step of steps || []) {
      const decision = decisions?.find((d) => d.id === step.decision_id);
      if (decision && step.user_id) {
        const proposerRole = participantRoleMap[decision.proposed_by];
        const approverRole = participantRoleMap[step.user_id];
        if (proposerRole && approverRole && proposerRole !== approverRole) {
          crossAgencyApprovals++;
        }
      }
    }

    // Get inter-agency messages (from communication metrics)
    const commMetrics = await calculateCommunicationMetrics(sessionId);
    const interAgencyMessages = commMetrics.inter_agency_message_count;

    // Calculate coordination score (0-100)
    // Based on: cross-agency approvals (weight: 50%) and inter-agency messages (weight: 50%)
    // Normalize to 0-100 scale
    const maxExpectedApprovals = (decisions?.length || 0) * 0.5; // Assume 50% should be cross-agency
    const maxExpectedMessages = (participants?.length || 0) * 20; // Assume 20 messages per participant

    const approvalScore =
      maxExpectedApprovals > 0
        ? Math.min(100, (crossAgencyApprovals / maxExpectedApprovals) * 100)
        : 0;
    const messageScore =
      maxExpectedMessages > 0
        ? Math.min(100, (interAgencyMessages / maxExpectedMessages) * 100)
        : 0;

    const overallScore = approvalScore * 0.5 + messageScore * 0.5;

    return {
      overall_score: Math.round(overallScore),
      inter_agency_interactions: crossAgencyApprovals + interAgencyMessages,
      cross_agency_approvals: crossAgencyApprovals,
      inter_agency_messages: interAgencyMessages,
    };
  } catch (err) {
    logger.error({ error: err, sessionId }, 'Error calculating coordination score');
    throw err;
  }
}

/**
 * Calculate compliance rate
 */
export async function calculateComplianceRate(sessionId: string): Promise<ComplianceMetrics> {
  try {
    // Get all decisions for the session
    const { data: decisionsList } = await supabaseAdmin
      .from('decisions')
      .select('id')
      .eq('session_id', sessionId);

    const decisionIds = (decisionsList || []).map((d) => d.id);

    // Get all decisions that require approval (have decision steps)
    const { data: steps, error: stepsError } =
      decisionIds.length > 0
        ? await supabaseAdmin
            .from('decision_steps')
            .select('decision_id, status, role')
            .in('decision_id', decisionIds)
        : { data: [], error: null };

    if (stepsError) {
      logger.error(
        { error: stepsError, sessionId },
        'Failed to fetch decision steps for compliance rate',
      );
      throw stepsError;
    }

    // Group steps by decision and required approver role
    const decisionsByRole: Record<string, Array<{ decisionId: string; status: string }>> = {};

    for (const step of steps || []) {
      const role = step.role || 'general';
      if (!decisionsByRole[role]) {
        decisionsByRole[role] = [];
      }
      // Check if we already have this decision for this role
      const existing = decisionsByRole[role].find((d) => d.decisionId === step.decision_id);
      if (!existing) {
        decisionsByRole[role].push({
          decisionId: step.decision_id,
          status: step.status,
        });
      }
    }

    // Calculate compliance by type
    const byType: Record<string, { required: number; approved: number; rate: number }> = {};
    let totalRequired = 0;
    let totalApproved = 0;

    for (const [role, decisionList] of Object.entries(decisionsByRole)) {
      const required = decisionList.length;
      const approved = decisionList.filter((d) => d.status === 'approved').length;
      totalRequired += required;
      totalApproved += approved;

      byType[role] = {
        required,
        approved,
        rate: required > 0 ? (approved / required) * 100 : 0,
      };
    }

    const overallRate = totalRequired > 0 ? (totalApproved / totalRequired) * 100 : 0;

    return {
      rate: overallRate,
      total_required: totalRequired,
      approved: totalApproved,
      rejected: totalRequired - totalApproved,
      by_type: byType,
    };
  } catch (err) {
    logger.error({ error: err, sessionId }, 'Error calculating compliance rate');
    throw err;
  }
}

/**
 * Store metrics in aar_metrics table
 */
export async function storeAARMetrics(
  aarReportId: string,
  metrics: {
    decisionLatency?: DecisionLatencyMetrics;
    communication?: CommunicationMetrics;
    coordination?: CoordinationMetrics;
    compliance?: ComplianceMetrics;
  },
): Promise<void> {
  try {
    const metricsToStore: Array<{
      aar_report_id: string;
      metric_type: string;
      metric_name: string;
      metric_value: unknown;
    }> = [];

    if (metrics.decisionLatency) {
      metricsToStore.push({
        aar_report_id: aarReportId,
        metric_type: 'decision_latency',
        metric_name: 'overall',
        metric_value: metrics.decisionLatency,
      });
    }

    if (metrics.communication) {
      metricsToStore.push({
        aar_report_id: aarReportId,
        metric_type: 'communication',
        metric_name: 'overall',
        metric_value: metrics.communication,
      });
    }

    if (metrics.coordination) {
      metricsToStore.push({
        aar_report_id: aarReportId,
        metric_type: 'coordination',
        metric_name: 'overall',
        metric_value: metrics.coordination,
      });
    }

    if (metrics.compliance) {
      metricsToStore.push({
        aar_report_id: aarReportId,
        metric_type: 'compliance',
        metric_name: 'overall',
        metric_value: metrics.compliance,
      });
    }

    if (metricsToStore.length > 0) {
      const { error } = await supabaseAdmin.from('aar_metrics').insert(metricsToStore);

      if (error) {
        logger.error({ error, aarReportId }, 'Failed to store AAR metrics');
        throw error;
      }
    }

    logger.info({ aarReportId, metricCount: metricsToStore.length }, 'Stored AAR metrics');
  } catch (err) {
    logger.error({ error: err, aarReportId }, 'Error storing AAR metrics');
    throw err;
  }
}
