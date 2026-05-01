import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from './websocketService.js';
import { applySentimentImpact } from './sentimentSimService.js';

export async function checkResponseDeadlines(sessionId: string): Promise<void> {
  const now = new Date();

  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('start_time')
    .eq('id', sessionId)
    .single();

  if (!session?.start_time) return;

  const { data: pendingPosts } = await supabaseAdmin
    .from('social_posts')
    .select('id, inject_id, response_deadline_minutes, created_at, responded_at')
    .eq('session_id', sessionId)
    .eq('requires_response', true)
    .is('responded_at', null)
    .not('response_deadline_minutes', 'is', null);

  if (!pendingPosts || pendingPosts.length === 0) return;

  for (const post of pendingPosts) {
    const createdAt = new Date(post.created_at);
    const deadlineMs = (post.response_deadline_minutes || 10) * 60 * 1000;
    const deadlineAt = new Date(createdAt.getTime() + deadlineMs);

    if (now > deadlineAt) {
      logger.warn(
        { sessionId, postId: post.id, deadlineMinutes: post.response_deadline_minutes },
        'Response deadline exceeded',
      );

      await applySentimentImpact(
        sessionId,
        -10,
        `Response deadline missed for post ${post.id.slice(0, 8)}`,
      );

      getWebSocketService().broadcastToSession(sessionId, {
        type: 'response_deadline.missed',
        data: { post_id: post.id, deadline_minutes: post.response_deadline_minutes },
        timestamp: now.toISOString(),
      });

      await supabaseAdmin.from('session_events').insert({
        session_id: sessionId,
        event_type: 'status_update',
        description: `Response deadline missed: post ${post.id.slice(0, 8)} exceeded ${post.response_deadline_minutes} minute limit`,
        metadata: { post_id: post.id, type: 'response_deadline_missed' },
      });
    }
  }

  const { data: pendingEmails } = await supabaseAdmin
    .from('sim_emails')
    .select('id, inject_id, created_at')
    .eq('session_id', sessionId)
    .eq('direction', 'inbound')
    .eq('is_read', false);

  if (pendingEmails && pendingEmails.length > 0) {
    for (const email of pendingEmails) {
      const createdAt = new Date(email.created_at);
      const unreadMinutes = (now.getTime() - createdAt.getTime()) / 60000;
      if (unreadMinutes > 15) {
        getWebSocketService().broadcastToSession(sessionId, {
          type: 'email.unread_warning',
          data: { email_id: email.id, unread_minutes: Math.round(unreadMinutes) },
          timestamp: now.toISOString(),
        });
      }
    }
  }
}

export async function markPostResponded(
  sessionId: string,
  postId: string,
  responsePostId: string,
): Promise<void> {
  await supabaseAdmin
    .from('social_posts')
    .update({
      responded_at: new Date().toISOString(),
      player_response_id: responsePostId,
    })
    .eq('id', postId)
    .eq('session_id', sessionId);

  logger.info({ sessionId, postId, responsePostId }, 'Post marked as responded');
}
