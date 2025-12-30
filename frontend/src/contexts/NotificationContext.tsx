import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
  useRef,
} from 'react';
import { useLocation } from 'react-router-dom';
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

export const NotificationProvider = ({
  children,
  sessionId: propSessionId,
}: NotificationProviderProps) => {
  const { user } = useAuth();
  const location = useLocation();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);

  // Extract session ID from route if we're in a session view
  const routeSessionId = location.pathname.match(/^\/sessions\/([^/]+)/)?.[1];
  const currentSessionId = propSessionId || routeSessionId;

  // Load notifications from backend
  const loadNotifications = useCallback(
    async (sessionIdOverride?: string) => {
      if (!user) return;

      const targetSessionId = sessionIdOverride || currentSessionId;
      setLoading(true);
      try {
        const result = await api.notifications.list(targetSessionId, false, 50);
        // Filter notifications to only show ones for the current session (if in a session)
        const filteredNotifications = targetSessionId
          ? (result.data || []).filter((n) => n.session_id === targetSessionId)
          : result.data || [];
        setNotifications(filteredNotifications);
      } catch (error) {
        console.error('Failed to load notifications:', error);
      } finally {
        setLoading(false);
      }
    },
    [user, currentSessionId],
  );

  // Load unread count
  const refreshUnreadCount = useCallback(
    async (sessionIdOverride?: string) => {
      if (!user) return;

      try {
        const targetSessionId = sessionIdOverride || currentSessionId;
        const result = await api.notifications.getUnreadCount(targetSessionId);
        setUnreadCount(result.count || 0);
      } catch (error) {
        console.error('Failed to load unread count:', error);
      }
    },
    [user, currentSessionId],
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
    async (sessionIdOverride?: string) => {
      try {
        const targetSessionId = sessionIdOverride || currentSessionId;
        await api.notifications.markAllAsRead(targetSessionId);
        setNotifications((prev) =>
          prev.map((n) => ({ ...n, read: true, read_at: new Date().toISOString() })),
        );
        setUnreadCount(0);
      } catch (error) {
        console.error('Failed to mark all notifications as read:', error);
      }
    },
    [currentSessionId],
  );

  // Track previous session ID to detect changes
  const prevSessionIdRef = useRef<string | undefined>(currentSessionId);

  // Load notifications when user logs in
  useEffect(() => {
    if (user) {
      loadNotifications();
      refreshUnreadCount();
    }
  }, [user, loadNotifications, refreshUnreadCount]);

  // Reload notifications when session changes
  useEffect(() => {
    if (user && prevSessionIdRef.current !== currentSessionId) {
      prevSessionIdRef.current = currentSessionId;
      // Clear old notifications and load new ones for the current session
      setNotifications([]);
      loadNotifications();
      refreshUnreadCount();
    }
  }, [user, currentSessionId, loadNotifications, refreshUnreadCount]);

  // Listen for new notifications via WebSocket
  useWebSocket({
    sessionId: currentSessionId || '',
    eventTypes: ['notification.created'],
    onEvent: async (event: WebSocketEvent) => {
      if (event.type === 'notification.created' && event.data?.notification) {
        const newNotification = event.data.notification as Notification;

        // Only add if it's for the current user and current session (if in a session)
        if (newNotification.user_id === user?.id) {
          // If we're in a session view, only show notifications for that session
          if (currentSessionId && newNotification.session_id !== currentSessionId) {
            return;
          }

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
    enabled: !!user,
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
