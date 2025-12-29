import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { calculateCommunicationMetrics, calculateCoordinationScore } from './analyticsService.js';

/**
 * Participant Score Service
 * Calculates individual participant performance scores for AAR reports
 */

export interface ParticipantScore {
  user_id: string;
  role: string;
  decisions_proposed: number;
  communications_sent: number;
  avg_response_time_minutes: number;
  coordination_score: number; // 0-100
  leadership_score: number; // 0-100
}

/**
 * Calculate participant scores for all participants in a session
 */
export async function calculateParticipantScores(
  sessionId: string,
  aarReportId: string,
): Promise<ParticipantScore[]> {
  try {
    // Get all participants for the session
    const { data: participants, error: participantsError } = await supabaseAdmin
      .from('session_participants')
      .select('user_id, role')
      .eq('session_id', sessionId);

    if (participantsError) {
      logger.error(
        { error: participantsError, sessionId },
        'Failed to fetch participants for scoring',
      );
      throw participantsError;
    }

    if (!participants || participants.length === 0) {
      return [];
    }

    // Get communication metrics (includes messages per participant)
    const commMetrics = await calculateCommunicationMetrics(sessionId);
    const coordinationMetrics = await calculateCoordinationScore(sessionId);

    // Get all decisions proposed by each participant
    const { data: decisions, error: decisionsError } = await supabaseAdmin
      .from('decisions')
      .select('id, proposed_by, status, created_at, executed_at')
      .eq('session_id', sessionId);

    if (decisionsError) {
      logger.error(
        { error: decisionsError, sessionId },
        'Failed to fetch decisions for participant scoring',
      );
      throw decisionsError;
    }

    // Get decision steps to calculate leadership score (decisions approved)
    const decisionIds = (decisions || []).map((d) => d.id);
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
        'Failed to fetch decision steps for participant scoring',
      );
      throw stepsError;
    }

    // Get all messages to calculate response times per participant
    const { data: messages, error: messagesError } = await supabaseAdmin
      .from('chat_messages')
      .select('id, sender_id, created_at, channel_id')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (messagesError) {
      logger.error(
        { error: messagesError, sessionId },
        'Failed to fetch messages for participant scoring',
      );
      throw messagesError;
    }

    // Build participant role map
    const participantRoleMap: Record<string, string> = {};
    for (const participant of participants) {
      participantRoleMap[participant.user_id] = participant.role;
    }

    // Calculate scores for each participant
    const scores: ParticipantScore[] = [];

    for (const participant of participants) {
      const userId = participant.user_id;
      const role = participant.role;

      // Count decisions proposed
      const decisionsProposed = (decisions || []).filter((d) => d.proposed_by === userId).length;

      // Count communications sent
      const communicationsSent = commMetrics.messages_per_participant[userId] || 0;

      // Calculate average response time for this participant
      const participantMessages = (messages || []).filter((m) => m.sender_id === userId);
      const participantResponseTimes: number[] = [];

      // Group messages by channel and calculate response times
      const channelMessages: Record<string, Array<{ time: number }>> = {};
      for (const message of participantMessages) {
        if (!channelMessages[message.channel_id]) {
          channelMessages[message.channel_id] = [];
        }
        channelMessages[message.channel_id].push({
          time: new Date(message.created_at).getTime(),
        });
      }

      for (const channelId in channelMessages) {
        const channelMsgs = channelMessages[channelId];
        // Get all messages in this channel (including from other participants)
        const allChannelMessages = (messages || [])
          .filter((m) => m.channel_id === channelId)
          .map((m) => ({ time: new Date(m.created_at).getTime(), sender_id: m.sender_id }))
          .sort((a, b) => a.time - b.time);

        // Calculate time between this participant's message and the previous message
        for (let i = 0; i < allChannelMessages.length; i++) {
          if (allChannelMessages[i].sender_id === userId && i > 0) {
            const timeDiff =
              (allChannelMessages[i].time - allChannelMessages[i - 1].time) / (1000 * 60); // minutes
            if (timeDiff < 1440) {
              // Ignore gaps > 24 hours
              participantResponseTimes.push(timeDiff);
            }
          }
        }
      }

      const avgResponseTime =
        participantResponseTimes.length > 0
          ? participantResponseTimes.reduce((a, b) => a + b, 0) / participantResponseTimes.length
          : 0;

      // Calculate coordination score (0-100)
      // Based on: inter-agency message participation and cross-agency approvals received/given
      const participantInterAgencyMessages = (messages || []).filter((m) => {
        if (m.sender_id !== userId) return false;
        // Check if message is in inter-agency channel or to different role
        // For simplicity, use the coordination metrics overall score scaled by participation
        // This is a simplified approach - could be enhanced with more detailed analysis
        return true; // Will scale by overall coordination
      }).length;

      const totalInterAgencyMessages = coordinationMetrics.inter_agency_messages;
      const coordinationScore =
        totalInterAgencyMessages > 0 && (messages || []).length > 0
          ? Math.min(
              100,
              Math.round(
                (participantInterAgencyMessages / totalInterAgencyMessages) *
                  coordinationMetrics.overall_score *
                  1.2,
              ),
            )
          : Math.round(coordinationMetrics.overall_score * 0.5);

      // Calculate leadership score (0-100)
      // Based on: decisions proposed and approved (high weight), approvals received from others (medium weight)
      const participantDecisions = (decisions || []).filter((d) => d.proposed_by === userId);
      const approvedDecisions = participantDecisions.filter(
        (d) => d.status === 'approved' || d.status === 'executed',
      ).length;

      // Decisions approved by this participant (they were an approver)
      const approvalsGiven = (steps || []).filter((s) => s.user_id === userId).length;

      // Calculate leadership components
      const decisionLeadershipScore =
        participantDecisions.length > 0
          ? (approvedDecisions / participantDecisions.length) * 100
          : 0;

      const approvalActivityScore = Math.min(100, approvalsGiven * 10); // Max 10 approvals = 100

      // Weighted combination: 60% decision leadership, 30% approval activity, 10% communication volume
      const communicationVolumeScore = Math.min(100, (communicationsSent / 20) * 100); // Max 20 messages = 100

      const leadershipScore = Math.round(
        decisionLeadershipScore * 0.6 +
          approvalActivityScore * 0.3 +
          communicationVolumeScore * 0.1,
      );

      scores.push({
        user_id: userId,
        role,
        decisions_proposed: decisionsProposed,
        communications_sent: communicationsSent,
        avg_response_time_minutes: Math.round(avgResponseTime * 100) / 100, // Round to 2 decimal places
        coordination_score: Math.max(0, Math.min(100, coordinationScore)),
        leadership_score: Math.max(0, Math.min(100, leadershipScore)),
      });
    }

    return scores;
  } catch (err) {
    logger.error({ error: err, sessionId }, 'Error calculating participant scores');
    throw err;
  }
}

/**
 * Store participant scores in the database
 */
export async function storeParticipantScores(
  aarReportId: string,
  scores: ParticipantScore[],
): Promise<void> {
  try {
    if (scores.length === 0) {
      return;
    }

    // Delete existing scores for this AAR report (in case of regeneration)
    const { error: deleteError } = await supabaseAdmin
      .from('participant_scores')
      .delete()
      .eq('aar_report_id', aarReportId);

    if (deleteError) {
      logger.error(
        { error: deleteError, aarReportId },
        'Failed to delete existing participant scores',
      );
      throw deleteError;
    }

    // Insert new scores
    const scoresToInsert = scores.map((score) => ({
      aar_report_id: aarReportId,
      user_id: score.user_id,
      role: score.role,
      decisions_proposed: score.decisions_proposed,
      communications_sent: score.communications_sent,
      avg_response_time_minutes: score.avg_response_time_minutes,
      coordination_score: score.coordination_score,
      leadership_score: score.leadership_score,
    }));

    const { error: insertError } = await supabaseAdmin
      .from('participant_scores')
      .insert(scoresToInsert);

    if (insertError) {
      logger.error({ error: insertError, aarReportId }, 'Failed to insert participant scores');
      throw insertError;
    }

    logger.info({ aarReportId, scoreCount: scores.length }, 'Stored participant scores');
  } catch (err) {
    logger.error({ error: err, aarReportId }, 'Error storing participant scores');
    throw err;
  }
}
