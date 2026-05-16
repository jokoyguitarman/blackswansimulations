import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { getWebSocketService } from './websocketService.js';
import { logger } from '../lib/logger.js';

async function findPlayerUserIdByHandle(sessionId: string, handle: string): Promise<string | null> {
  // Look up the player's user_id directly from their posts in this session
  const { data: playerPost } = await supabaseAdmin
    .from('social_posts')
    .select('user_id')
    .eq('session_id', sessionId)
    .eq('author_handle', handle)
    .eq('author_type', 'player')
    .not('user_id', 'is', null)
    .limit(1)
    .single();

  if (playerPost?.user_id) return playerPost.user_id as string;

  // Fallback: check session_participants
  const { data: participants } = await supabaseAdmin
    .from('session_participants')
    .select('user_id')
    .eq('session_id', sessionId);

  if (!participants) return null;

  for (const p of participants) {
    const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(p.user_id);
    if (!authUser?.user) continue;
    const email = authUser.user.email || '';
    const constructedHandle = `@${(email || p.user_id.slice(0, 8)).replace(/[@.\s+,]/g, '_').toLowerCase()}`;
    if (constructedHandle === handle) return p.user_id;
  }

  return null;
}

export async function notifyPostReply(
  sessionId: string,
  replyAuthorName: string,
  parentAuthorHandle: string,
  parentPostId: string,
  replyContent: string,
  platform: string = 'x_twitter',
  highlightPostId?: string,
): Promise<void> {
  try {
    const userId = await findPlayerUserIdByHandle(sessionId, parentAuthorHandle);
    if (!userId) return;

    const { error } = await supabaseAdmin.from('notifications').insert({
      session_id: sessionId,
      user_id: userId,
      type: 'social_reply',
      title: `${replyAuthorName} replied to your post`,
      message: replyContent.substring(0, 200),
      priority: 'medium',
      metadata: {
        post_id: parentPostId,
        highlight_post_id: highlightPostId || null,
        platform,
        replier: replyAuthorName,
      },
    });

    if (error) {
      logger.warn({ error }, 'Failed to create reply notification');
      return;
    }

    getWebSocketService().broadcastToSession(sessionId, {
      type: 'notification.created',
      data: {
        user_id: userId,
        notification_type: 'social_reply',
        platform,
        title: `${replyAuthorName} replied to your post`,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn({ err }, 'Reply notification failed');
  }
}

export async function notifyPostLike(
  sessionId: string,
  postAuthorHandle: string,
  likerName: string,
  reactionType: string = 'like',
  platform: string = 'x_twitter',
): Promise<void> {
  try {
    const userId = await findPlayerUserIdByHandle(sessionId, postAuthorHandle);
    if (!userId) return;

    const reactionLabel =
      reactionType === 'like'
        ? 'liked'
        : reactionType === 'love'
          ? 'loved'
          : `reacted ${reactionType} to`;

    const { error } = await supabaseAdmin.from('notifications').insert({
      session_id: sessionId,
      user_id: userId,
      type: 'social_like',
      title: `${likerName} ${reactionLabel} your post`,
      message: `${likerName} ${reactionLabel} your post`,
      priority: 'low',
      metadata: { platform, liker: likerName, reaction_type: reactionType },
    });

    if (error) {
      logger.warn({ error }, 'Failed to create like notification');
      return;
    }

    getWebSocketService().broadcastToSession(sessionId, {
      type: 'notification.created',
      data: {
        user_id: userId,
        notification_type: 'social_like',
        platform,
        title: `${likerName} ${reactionLabel} your post`,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn({ err }, 'Like notification failed');
  }
}

export async function notifyMention(
  sessionId: string,
  mentionedHandle: string,
  mentionerName: string,
  postContent: string,
  platform: string = 'x_twitter',
): Promise<void> {
  try {
    const userId = await findPlayerUserIdByHandle(sessionId, mentionedHandle);
    if (!userId) return;

    const { error } = await supabaseAdmin.from('notifications').insert({
      session_id: sessionId,
      user_id: userId,
      type: 'social_mention',
      title: `${mentionerName} mentioned you`,
      message: postContent.substring(0, 200),
      priority: 'medium',
      metadata: { platform, mentioner: mentionerName },
    });

    if (error) {
      logger.warn({ error }, 'Failed to create mention notification');
      return;
    }

    getWebSocketService().broadcastToSession(sessionId, {
      type: 'notification.created',
      data: {
        user_id: userId,
        notification_type: 'social_mention',
        platform,
        title: `${mentionerName} mentioned you`,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn({ err }, 'Mention notification failed');
  }
}

export function extractMentions(content: string): string[] {
  const matches = content.match(/@[\w._]+/g);
  return matches || [];
}
