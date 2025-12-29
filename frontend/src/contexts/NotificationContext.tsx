import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { api } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { type WebSocketEvent } from '../lib/websocketClient';
import { useAuth } from './AuthContext';

/**
 * Notification Context - Integrates with backend notifications
 * Separation of concerns: Notification state management with backend sync
 */

export type NotificationPriority = 'critical' | 'high' | 'medium' | 'low';

export interface Notification {
  id: string;
  session_id: string;
  user_id: string;
  type: string;
  title: string;
  message: string;
  priority: NotificationPriority;
  read: boolean;
  read_at: string | null;
  metadata: Record<string, unknown>;
  action_url: string | null;
  created_at: string;
}

interface NotificationContextType {
  notifications: Notification[];
  unreadCount: number;
  loading: boolean;
  loadNotifications: (sessionId?: string) => Promise<void>;
  markAsRead: (notificationId: string) => Promise<void>;
  markAllAsRead: (sessionId?: string) => Promise<void>;
  refreshUnreadCount: (sessionId?: string) => Promise<void>;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

export const useNotifications = () => {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error('useNotifications must be used within NotificationProvider');
  }
  return context;
};

interface NotificationProviderProps {
  children: ReactNode;
  sessionId?: string;
}

export const NotificationProvider = ({ children, sessionId }: NotificationProviderProps) => {
  const { user } = useAuth();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);

  // Load notifications from backend
  const loadNotifications = useCallback(
    async (currentSessionId?: string) => {
      if (!user) return;

      setLoading(true);
      try {
        const result = await api.notifications.list(currentSessionId || sessionId, false, 50);
        setNotifications(result.data || []);
      } catch (error) {
        console.error('Failed to load notifications:', error);
      } finally {
        setLoading(false);
      }
    },
    [user, sessionId],
  );

  // Load unread count
  const refreshUnreadCount = useCallback(
    async (currentSessionId?: string) => {
      if (!user) return;

      try {
        const result = await api.notifications.getUnreadCount(currentSessionId || sessionId);
        setUnreadCount(result.count || 0);
      } catch (error) {
        console.error('Failed to load unread count:', error);
      }
    },
    [user, sessionId],
  );

  // Mark notification as read
  const markAsRead = useCallback(async (notificationId: string) => {
    try {
      await api.notifications.markAsRead(notificationId);
      setNotifications((prev) =>
        prev.map((n) =>
          n.id === notificationId ? { ...n, read: true, read_at: new Date().toISOString() } : n,
        ),
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch (error) {
      console.error('Failed to mark notification as read:', error);
    }
  }, []);

  // Mark all notifications as read
  const markAllAsRead = useCallback(
    async (currentSessionId?: string) => {
      try {
        await api.notifications.markAllAsRead(currentSessionId || sessionId);
        setNotifications((prev) =>
          prev.map((n) => ({ ...n, read: true, read_at: new Date().toISOString() })),
        );
        setUnreadCount(0);
      } catch (error) {
        console.error('Failed to mark all notifications as read:', error);
      }
    },
    [sessionId],
  );

  // Initial load
  useEffect(() => {
    if (user) {
      loadNotifications();
      refreshUnreadCount();
    }
  }, [user, loadNotifications, refreshUnreadCount]);

  // Listen for new notifications via WebSocket
  useWebSocket({
    sessionId: sessionId || '',
    eventTypes: ['notification.created'],
    onEvent: async (event: WebSocketEvent) => {
      if (event.type === 'notification.created' && event.data?.notification) {
        const newNotification = event.data.notification as Notification;

        // Only add if it's for the current user
        if (newNotification.user_id === user?.id) {
          setNotifications((prev) => {
            // Check if notification already exists
            if (prev.some((n) => n.id === newNotification.id)) {
              return prev;
            }
            // Add to front if critical, otherwise to end
            if (newNotification.priority === 'critical') {
              return [newNotification, ...prev];
            }
            return [...prev, newNotification];
          });
          setUnreadCount((prev) => prev + 1);
        }
      }
    },
    enabled: !!user && !!sessionId,
  });

  return (
    <NotificationContext.Provider
      value={{
        notifications,
        unreadCount,
        loading,
        loadNotifications,
        markAsRead,
        markAllAsRead,
        refreshUnreadCount,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
};
