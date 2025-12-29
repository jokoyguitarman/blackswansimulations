import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from './websocketService.js';

export type NotificationType =
  | 'decision_approval_required'
  | 'decision_approved'
  | 'decision_rejected'
  | 'decision_executed'
  | 'inject_published'
  | 'incident_reported'
  | 'incident_assigned'
  | 'incident_updated'
  | 'chat_message'
  | 'resource_request'
  | 'resource_approved'
  | 'resource_rejected'
  | 'system_alert';

export type NotificationPriority = 'low' | 'medium' | 'high' | 'critical';

export interface NotificationMetadata {
  decision_id?: string;
  inject_id?: string;
  incident_id?: string;
  channel_id?: string;
  message_id?: string;
  resource_request_id?: string;
  [key: string]: unknown;
}

export interface CreateNotificationParams {
  sessionId: string;
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  priority?: NotificationPriority;
  metadata?: NotificationMetadata;
  actionUrl?: string;
}

/**
 * Create a notification for a user
 */
export async function createNotification(params: CreateNotificationParams): Promise<string | null> {
  try {
    const {
      sessionId,
      userId,
      type,
      title,
      message,
      priority = 'medium',
      metadata = {},
      actionUrl,
    } = params;

    const { data, error } = await supabaseAdmin
      .from('notifications')
      .insert({
        session_id: sessionId,
        user_id: userId,
        type,
        title,
        message,
        priority,
        metadata,
        action_url: actionUrl,
        read: false,
      })
      .select('id')
      .single();

    if (error) {
      logger.error({ error, params }, 'Failed to create notification');
      return null;
    }

    // Send WebSocket notification to the user
    getWebSocketService().notificationCreated(userId, {
      id: data.id,
      type,
      title,
      message,
      priority,
      metadata,
      action_url: actionUrl,
      created_at: new Date().toISOString(),
    });

    logger.debug({ notificationId: data.id, userId, type }, 'Notification created and sent');
    return data.id;
  } catch (err) {
    logger.error({ error: err, params }, 'Error creating notification');
    return null;
  }
}

/**
 * Create notifications for multiple users
 */
export async function createNotificationsForUsers(
  userIds: string[],
  params: Omit<CreateNotificationParams, 'userId'>,
): Promise<void> {
  try {
    const notifications = userIds.map((userId) => ({
      session_id: params.sessionId,
      user_id: userId,
      type: params.type,
      title: params.title,
      message: params.message,
      priority: params.priority || 'medium',
      metadata: params.metadata || {},
      action_url: params.actionUrl,
      read: false,
    }));

    const { error } = await supabaseAdmin.from('notifications').insert(notifications);

    if (error) {
      logger.error({ error, params, userIds }, 'Failed to create notifications for users');
      return;
    }

    // Send WebSocket notifications to all users
    const notificationData = {
      type: params.type,
      title: params.title,
      message: params.message,
      priority: params.priority || 'medium',
      metadata: params.metadata || {},
      action_url: params.actionUrl,
      created_at: new Date().toISOString(),
    };

    userIds.forEach((userId) => {
      getWebSocketService().notificationCreated(userId, notificationData);
    });

    logger.debug({ userIds: userIds.length, type: params.type }, 'Notifications created for users');
  } catch (err) {
    logger.error({ error: err, params, userIds }, 'Error creating notifications for users');
  }
}

/**
 * Create notifications for users by role
 * Uses session_participants.role instead of user_profiles.role
 */
export async function createNotificationsForRoles(
  sessionId: string,
  roles: string[],
  params: Omit<CreateNotificationParams, 'userId' | 'sessionId'>,
): Promise<void> {
  try {
    // Get all users with the specified roles in this session from session_participants
    const { data: participants, error: participantsError } = await supabaseAdmin
      .from('session_participants')
      .select('user_id, role')
      .eq('session_id', sessionId)
      .in('role', roles);

    if (participantsError) {
      logger.error(
        { error: participantsError, sessionId, roles },
        'Failed to fetch participants by role',
      );
      return;
    }

    if (!participants || participants.length === 0) {
      logger.debug({ sessionId, roles }, 'No participants found for roles');
      return;
    }

    const userIds = participants.map((p) => p.user_id).filter((id): id is string => !!id);

    if (userIds.length > 0) {
      await createNotificationsForUsers(userIds, { ...params, sessionId });
    }
  } catch (err) {
    logger.error(
      { error: err, sessionId, roles, params },
      'Error creating notifications for roles',
    );
  }
}

/**
 * Mark notification as read
 */
export async function markNotificationAsRead(
  notificationId: string,
  userId: string,
): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin
      .from('notifications')
      .update({
        read: true,
        read_at: new Date().toISOString(),
      })
      .eq('id', notificationId)
      .eq('user_id', userId);

    if (error) {
      logger.error({ error, notificationId, userId }, 'Failed to mark notification as read');
      return false;
    }

    return true;
  } catch (err) {
    logger.error({ error: err, notificationId, userId }, 'Error marking notification as read');
    return false;
  }
}

/**
 * Mark all notifications as read for a user
 */
export async function markAllNotificationsAsRead(
  userId: string,
  sessionId?: string,
): Promise<boolean> {
  try {
    let query = supabaseAdmin
      .from('notifications')
      .update({
        read: true,
        read_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('read', false);

    if (sessionId) {
      query = query.eq('session_id', sessionId);
    }

    const { error } = await query;

    if (error) {
      logger.error({ error, userId, sessionId }, 'Failed to mark all notifications as read');
      return false;
    }

    return true;
  } catch (err) {
    logger.error({ error: err, userId, sessionId }, 'Error marking all notifications as read');
    return false;
  }
}

/**
 * Get unread notification count for a user
 */
export async function getUnreadNotificationCount(
  userId: string,
  sessionId?: string,
): Promise<number> {
  try {
    let query = supabaseAdmin
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('read', false);

    if (sessionId) {
      query = query.eq('session_id', sessionId);
    }

    const { count, error } = await query;

    if (error) {
      logger.error({ error, userId, sessionId }, 'Failed to get unread notification count');
      return 0;
    }

    return count || 0;
  } catch (err) {
    logger.error({ error: err, userId, sessionId }, 'Error getting unread notification count');
    return 0;
  }
}
