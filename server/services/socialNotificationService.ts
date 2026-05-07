import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { getWebSocketService } from './websocketService.js';
import { logger } from '../lib/logger.js';

async function findPlayerUserIdByHandle(sessionId: string, handle: string): Promise<string | null> {
  const { data: allPlayers } = await supabaseAdmin
    .from('player_actions')
    .select('player_id')
    .eq('session_id', sessionId)
    .limit(50);

  if (!allPlayers) return null;

  const uniqueIds = [...new Set(allPlayers.map((p) => p.player_id))];

  for (const playerId of uniqueIds) {
    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('id, username')
      .eq('id', playerId)
      .single();

    if (!profile) continue;

    const playerHandle = `@${(profile.username || profile.id.slice(0, 8)).replace(/[@.\s+]/g, '_').toLowerCase()}`;
    if (playerHandle === handle) return profile.id;
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
      metadata: { post_id: parentPostId, platform, replier: replyAuthorName },
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
