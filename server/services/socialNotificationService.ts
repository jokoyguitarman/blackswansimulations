import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { getWebSocketService } from './websocketService.js';
import { logger } from '../lib/logger.js';

async function findPlayerUserIdByHandle(sessionId: string, handle: string): Promise<string | null> {
  // Look up the player's user_id directly from their posts in this session
  const { data: playerPosts } = await supabaseAdmin
    .from('social_posts')
    .select('user_id')
    .eq('session_id', sessionId)
    .eq('author_handle', handle)
    .eq('author_type', 'player')
    .not('user_id', 'is', null)
    .limit(1);

  if (playerPosts?.[0]?.user_id) return playerPosts[0].user_id as string;

  // Page post lookup: official_account posts store the real user in posted_by_user_id
  const { data: pagePosts } = await supabaseAdmin
    .from('social_posts')
    .select('posted_by_user_id')
    .eq('session_id', sessionId)
    .eq('author_handle', handle)
    .eq('author_type', 'official_account')
    .not('posted_by_user_id', 'is', null)
    .limit(1);

  if (pagePosts?.[0]?.posted_by_user_id) return pagePosts[0].posted_by_user_id as string;

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

async function findAllSessionParticipantIds(sessionId: string): Promise<string[]> {
  const { data: participants } = await supabaseAdmin
    .from('session_participants')
    .select('user_id')
    .eq('session_id', sessionId);
  return (participants || []).map((p) => p.user_id as string);
}

function stripThreadTag(content: string): string {
  return content.replace(/^@[\w._-]+\[[^\]]+\]\s*/, '');
}

export async function notifyPostReply(
  sessionId: string,
  replyAuthorName: string,
  parentAuthorHandle: string,
  parentPostId: string,
  replyContent: string,
  platform: string = 'x_twitter',
  highlightPostId?: string,
  isPageNotification: boolean = false,
): Promise<void> {
  try {
    const userIds = isPageNotification
      ? await findAllSessionParticipantIds(sessionId)
      : ([await findPlayerUserIdByHandle(sessionId, parentAuthorHandle)].filter(
          Boolean,
        ) as string[]);
    if (userIds.length === 0) return;

    const title = `${replyAuthorName} replied to your post`;
    const message = stripThreadTag(replyContent).substring(0, 200);
    const metadata = {
      post_id: parentPostId,
      highlight_post_id: highlightPostId || null,
      platform,
      replier: replyAuthorName,
      is_page_notification: isPageNotification,
    };

    const rows = userIds.map((uid) => ({
      session_id: sessionId,
      user_id: uid,
      type: 'social_reply',
      title,
      message,
      priority: 'medium',
      metadata,
    }));

    const { error } = await supabaseAdmin.from('notifications').insert(rows);
    if (error) {
      logger.warn({ error }, 'Failed to create reply notification');
      return;
    }

    for (const uid of userIds) {
      getWebSocketService().broadcastToSession(sessionId, {
        type: 'notification.created',
        data: {
          user_id: uid,
          notification_type: 'social_reply',
          platform,
          title,
          metadata: {
            post_id: parentPostId,
            highlight_post_id: highlightPostId || null,
            platform,
            is_page_notification: isPageNotification,
          },
        },
        timestamp: new Date().toISOString(),
      });
    }
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
  isPageNotification: boolean = false,
): Promise<void> {
  try {
    const userIds = isPageNotification
      ? await findAllSessionParticipantIds(sessionId)
      : ([await findPlayerUserIdByHandle(sessionId, postAuthorHandle)].filter(Boolean) as string[]);
    if (userIds.length === 0) return;

    const reactionLabel =
      reactionType === 'like'
        ? 'liked'
        : reactionType === 'love'
          ? 'loved'
          : `reacted ${reactionType} to`;

    const title = `${likerName} ${reactionLabel} your post`;
    const metadata = {
      platform,
      liker: likerName,
      reaction_type: reactionType,
      is_page_notification: isPageNotification,
    };

    const rows = userIds.map((uid) => ({
      session_id: sessionId,
      user_id: uid,
      type: 'social_like',
      title,
      message: title,
      priority: 'low',
      metadata,
    }));

    const { error } = await supabaseAdmin.from('notifications').insert(rows);
    if (error) {
      logger.warn({ error }, 'Failed to create like notification');
      return;
    }

    for (const uid of userIds) {
      getWebSocketService().broadcastToSession(sessionId, {
        type: 'notification.created',
        data: {
          user_id: uid,
          notification_type: 'social_like',
          platform,
          title,
          metadata: { is_page_notification: isPageNotification },
        },
        timestamp: new Date().toISOString(),
      });
    }
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
  isPageNotification: boolean = false,
): Promise<void> {
  try {
    const userIds = isPageNotification
      ? await findAllSessionParticipantIds(sessionId)
      : ([await findPlayerUserIdByHandle(sessionId, mentionedHandle)].filter(Boolean) as string[]);
    if (userIds.length === 0) return;

    const title = `${mentionerName} mentioned you`;
    const message = stripThreadTag(postContent).substring(0, 200);
    const metadata = {
      platform,
      mentioner: mentionerName,
      is_page_notification: isPageNotification,
    };

    const rows = userIds.map((uid) => ({
      session_id: sessionId,
      user_id: uid,
      type: 'social_mention',
      title,
      message,
      priority: 'medium',
      metadata,
    }));

    const { error } = await supabaseAdmin.from('notifications').insert(rows);
    if (error) {
      logger.warn({ error }, 'Failed to create mention notification');
      return;
    }

    for (const uid of userIds) {
      getWebSocketService().broadcastToSession(sessionId, {
        type: 'notification.created',
        data: {
          user_id: uid,
          notification_type: 'social_mention',
          platform,
          title,
          metadata: { is_page_notification: isPageNotification },
        },
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err) {
    logger.warn({ err }, 'Mention notification failed');
  }
}

export function extractMentions(content: string): string[] {
  const matches = content.match(/@[\w._]+/g);
  return matches || [];
}
