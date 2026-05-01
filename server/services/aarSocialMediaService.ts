import { supabaseAdmin } from '../lib/supabaseAdmin.js';

export interface SocialMediaAARData {
  response_timeline: Array<{
    timestamp: string;
    event_type: string;
    description: string;
    response_time_minutes?: number;
    was_responded: boolean;
  }>;
  sop_compliance: {
    steps_completed: number;
    steps_total: number;
    steps_overdue: number;
    completion_percentage: number;
    details: Array<{
      step_name: string;
      status: string;
      completed_at?: string;
      time_limit_minutes?: number;
    }>;
  };
  content_quality: {
    posts_created: number;
    average_accuracy: number;
    average_tone: number;
    average_sensitivity: number;
    average_persuasiveness: number;
    average_overall: number;
    graded_responses: Array<{
      content: string;
      grade: Record<string, unknown>;
      created_at: string;
    }>;
  };
  sentiment_trajectory: Array<{
    recorded_at: string;
    sentiment_score: number;
    media_attention: number;
    political_pressure: number;
  }>;
  missed_opportunities: Array<{
    post_id: string;
    content: string;
    sentiment: string;
    requires_response: boolean;
    was_responded: boolean;
  }>;
  coordination_metrics: {
    total_chat_messages: number;
    total_emails_sent: number;
    total_player_actions: number;
    actions_by_type: Record<string, number>;
    avg_internal_messages_before_response: number;
  };
}

export async function buildSocialMediaAARData(sessionId: string): Promise<SocialMediaAARData> {
  const [postsResult, emailsResult, actionsResult, sentimentResult, messagesResult] =
    await Promise.all([
      supabaseAdmin
        .from('social_posts')
        .select('*')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true }),
      supabaseAdmin
        .from('sim_emails')
        .select('*')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true }),
      supabaseAdmin
        .from('player_actions')
        .select('*')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true }),
      supabaseAdmin
        .from('sentiment_snapshots')
        .select('*')
        .eq('session_id', sessionId)
        .order('recorded_at', { ascending: true }),
      supabaseAdmin.from('chat_messages').select('id').eq('session_id', sessionId),
    ]);

  const posts = postsResult.data || [];
  const emails = emailsResult.data || [];
  const actions = actionsResult.data || [];
  const sentimentSnapshots = sentimentResult.data || [];
  const totalMessages = messagesResult.data?.length || 0;

  const responsePosts = posts.filter((p: Record<string, unknown>) => p.requires_response === true);
  const responseTimeline = responsePosts.map((p: Record<string, unknown>) => {
    const createdAt = new Date(p.created_at as string);
    const respondedAt = p.responded_at ? new Date(p.responded_at as string) : null;
    const responseTimeMinutes = respondedAt
      ? (respondedAt.getTime() - createdAt.getTime()) / 60000
      : undefined;

    return {
      timestamp: p.created_at as string,
      event_type: (p.content_flags as Record<string, unknown>)?.is_hate_speech
        ? 'hate_speech'
        : (p.content_flags as Record<string, unknown>)?.is_misinformation
          ? 'misinformation'
          : 'general',
      description: (p.content as string).substring(0, 100),
      response_time_minutes: responseTimeMinutes
        ? Math.round(responseTimeMinutes * 10) / 10
        : undefined,
      was_responded: !!p.responded_at,
    };
  });

  const playerPosts = posts.filter(
    (p: Record<string, unknown>) => p.author_type === 'player' && p.sop_compliance_score,
  );
  const grades = playerPosts.map((p: Record<string, unknown>) => {
    const grade = (p.sop_compliance_score || {}) as Record<string, number>;
    return {
      content: (p.content as string).substring(0, 200),
      grade: p.sop_compliance_score as Record<string, unknown>,
      created_at: p.created_at as string,
      accuracy: grade.accuracy || 0,
      tone: grade.tone || 0,
      sensitivity: grade.cultural_sensitivity || 0,
      persuasiveness: grade.persuasiveness || 0,
      overall: grade.overall || 0,
    };
  });

  const avgGrades =
    grades.length > 0
      ? {
          accuracy: Math.round(grades.reduce((s, g) => s + g.accuracy, 0) / grades.length),
          tone: Math.round(grades.reduce((s, g) => s + g.tone, 0) / grades.length),
          sensitivity: Math.round(grades.reduce((s, g) => s + g.sensitivity, 0) / grades.length),
          persuasiveness: Math.round(
            grades.reduce((s, g) => s + g.persuasiveness, 0) / grades.length,
          ),
          overall: Math.round(grades.reduce((s, g) => s + g.overall, 0) / grades.length),
        }
      : { accuracy: 0, tone: 0, sensitivity: 0, persuasiveness: 0, overall: 0 };

  const missed = posts.filter(
    (p: Record<string, unknown>) => p.requires_response && !p.responded_at,
  );

  const actionsByType: Record<string, number> = {};
  for (const action of actions) {
    const type = action.action_type as string;
    actionsByType[type] = (actionsByType[type] || 0) + 1;
  }

  const outboundEmails = emails.filter((e: Record<string, unknown>) => e.direction === 'outbound');

  return {
    response_timeline: responseTimeline,
    sop_compliance: {
      steps_completed: 0,
      steps_total: 0,
      steps_overdue: 0,
      completion_percentage: 0,
      details: [],
    },
    content_quality: {
      posts_created: playerPosts.length,
      average_accuracy: avgGrades.accuracy,
      average_tone: avgGrades.tone,
      average_sensitivity: avgGrades.sensitivity,
      average_persuasiveness: avgGrades.persuasiveness,
      average_overall: avgGrades.overall,
      graded_responses: grades.map((g) => ({
        content: g.content,
        grade: g.grade,
        created_at: g.created_at,
      })),
    },
    sentiment_trajectory: sentimentSnapshots.map((s: Record<string, unknown>) => ({
      recorded_at: s.recorded_at as string,
      sentiment_score: s.sentiment_score as number,
      media_attention: s.media_attention as number,
      political_pressure: s.political_pressure as number,
    })),
    missed_opportunities: missed.map((p: Record<string, unknown>) => ({
      post_id: p.id as string,
      content: (p.content as string).substring(0, 200),
      sentiment: (p.sentiment as string) || 'unknown',
      requires_response: true,
      was_responded: false,
    })),
    coordination_metrics: {
      total_chat_messages: totalMessages,
      total_emails_sent: outboundEmails.length,
      total_player_actions: actions.length,
      actions_by_type: actionsByType,
      avg_internal_messages_before_response: 0,
    },
  };
}
