import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from './websocketService.js';

export interface SentimentState {
  overall: number;
  hate_speech_volume: number;
  misinformation_volume: number;
  supportive_volume: number;
  trend: 'rising' | 'falling' | 'stable';
}

export async function computeSessionSentiment(sessionId: string): Promise<SentimentState> {
  const { data: posts } = await supabaseAdmin
    .from('social_posts')
    .select('sentiment, virality_score, content_flags, is_flagged_by_player, responded_at')
    .eq('session_id', sessionId);

  if (!posts || posts.length === 0) {
    return {
      overall: 65,
      hate_speech_volume: 0,
      misinformation_volume: 0,
      supportive_volume: 0,
      trend: 'stable',
    };
  }

  let hateCount = 0;
  let misinfoCount = 0;
  let supportiveCount = 0;
  let negativePressure = 0;
  let positivePressure = 0;

  for (const post of posts) {
    const flags = (post.content_flags || {}) as Record<string, unknown>;
    const virality = Number(post.virality_score) || 0;
    const weight = virality / 100;

    if (post.sentiment === 'hateful' || post.sentiment === 'inflammatory') {
      hateCount++;
      negativePressure += 5 * weight;
      if (post.responded_at) negativePressure -= 2 * weight;
    } else if (post.sentiment === 'supportive' || post.sentiment === 'positive') {
      supportiveCount++;
      positivePressure += 3 * weight;
    } else if (post.sentiment === 'negative') {
      negativePressure += 2 * weight;
    }

    if (flags.is_misinformation) {
      misinfoCount++;
      negativePressure += 3 * weight;
      if (post.is_flagged_by_player) negativePressure -= 1.5 * weight;
    }
  }

  const baseline = 65;
  const raw = baseline - negativePressure + positivePressure;
  const overall = Math.max(0, Math.min(100, Math.round(raw)));

  const { data: prevSnapshots } = await supabaseAdmin
    .from('sentiment_snapshots')
    .select('sentiment_score')
    .eq('session_id', sessionId)
    .order('recorded_at', { ascending: false })
    .limit(2);

  let trend: 'rising' | 'falling' | 'stable' = 'stable';
  if (prevSnapshots && prevSnapshots.length > 0) {
    const prev = prevSnapshots[0].sentiment_score;
    if (overall > prev + 3) trend = 'rising';
    else if (overall < prev - 3) trend = 'falling';
  }

  await supabaseAdmin.from('sentiment_snapshots').insert({
    session_id: sessionId,
    sentiment_score: overall,
    media_attention: Math.min(100, Math.round((hateCount + misinfoCount) * 8)),
    political_pressure: Math.min(100, Math.round(negativePressure * 2)),
  });

  const state: SentimentState = {
    overall,
    hate_speech_volume: hateCount,
    misinformation_volume: misinfoCount,
    supportive_volume: supportiveCount,
    trend,
  };

  getWebSocketService().broadcastToSession(sessionId, {
    type: 'sentiment.updated',
    data: { ...state },
    timestamp: new Date().toISOString(),
  });

  return state;
}

export async function applySentimentImpact(
  sessionId: string,
  impact: number,
  reason: string,
): Promise<void> {
  logger.info({ sessionId, impact, reason }, 'Applying sentiment impact');
  const state = await computeSessionSentiment(sessionId);

  await supabaseAdmin.from('session_events').insert({
    session_id: sessionId,
    event_type: 'status_update',
    description: `Sentiment impact: ${impact > 0 ? '+' : ''}${impact} (${reason}). Overall: ${state.overall}`,
    metadata: { sentiment_impact: impact, reason, resulting_score: state.overall },
  });
}
