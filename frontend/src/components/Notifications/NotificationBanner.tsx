import { useNotifications } from '../../contexts/NotificationContext';
import { useNavigate } from 'react-router-dom';

/**
 * Notification Banner Component - Displays backend notifications
 * Separation of concerns: UI for displaying notifications from backend
 */

export const NotificationBanner = () => {
  const { notifications, markAsRead, unreadCount } = useNotifications();
  const navigate = useNavigate();

  // Filter to show only unread notifications, sorted by priority
  const unreadNotifications = notifications
    .filter((n) => !n.read)
    .sort((a, b) => {
      const priorityOrder: Record<string, number> = {
        critical: 0,
        high: 1,
        medium: 2,
        low: 3,
      };
      return (priorityOrder[a.priority] || 99) - (priorityOrder[b.priority] || 99);
    });

  if (unreadNotifications.length === 0) {
    return null;
  }

  // Only show the highest priority notification
  const topNotification = unreadNotifications[0];

  // Helper function to normalize action URLs (handles legacy URLs)
  const normalizeActionUrl = (
    actionUrl: string | null,
    notification: typeof topNotification,
  ): string | null => {
    if (!actionUrl) return null;

    // If it's already a session-based URL, return as-is
    if (actionUrl.startsWith('/sessions/')) {
      return actionUrl;
    }

    // Handle legacy URLs - convert to session-based routes
    if (actionUrl.startsWith('/injects/')) {
      return `/sessions/${notification.session_id}#injects`;
    }

    if (actionUrl.startsWith('/incidents/')) {
      return `/sessions/${notification.session_id}#cop`;
    }

    if (actionUrl.startsWith('/decisions/')) {
      return `/sessions/${notification.session_id}#decisions`;
    }

    if (actionUrl.startsWith('/channels/')) {
      return `/sessions/${notification.session_id}#chat`;
    }

    // For any other legacy URL, just navigate to the session
    return `/sessions/${notification.session_id}`;
  };

  const getBannerStyles = () => {
    switch (topNotification.priority) {
      case 'critical':
        return 'bg-red-900 border-red-500 text-red-100';
      case 'high':
        return 'bg-robotic-orange/90 border-robotic-orange text-white';
      case 'medium':
        return 'bg-robotic-yellow/90 border-robotic-yellow text-robotic-gray-300';
      case 'low':
        return 'bg-green-900/90 border-green-500 text-green-100';
      default:
        return 'bg-robotic-gray-200 border-robotic-gray-50 text-robotic-yellow';
    }
  };

  const getIcon = () => {
    switch (topNotification.priority) {
      case 'critical':
        return '🚨';
      case 'high':
        return '⚠️';
      case 'medium':
        return '📢';
      case 'low':
        return 'ℹ️';
      default:
        return '📋';
    }
  };

  const handleAction = () => {
    const normalizedUrl = normalizeActionUrl(topNotification.action_url, topNotification);
    if (normalizedUrl) {
      navigate(normalizedUrl);
    }
    markAsRead(topNotification.id);
  };

  const handleClose = () => {
    markAsRead(topNotification.id);
  };

  return (
    <div
      className={`fixed top-0 left-0 right-0 z-50 military-border border-b-4 ${getBannerStyles()} p-4 shadow-lg`}
      role="alert"
    >
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 flex-1">
          <span className="text-2xl">{getIcon()}</span>
          <div className="flex-1">
            <h3 className="text-sm terminal-text font-semibold uppercase mb-1">
              {topNotification.title}
            </h3>
            <p className="text-xs terminal-text opacity-90">{topNotification.message}</p>
          </div>
          {unreadCount > 1 && (
            <span className="text-xs terminal-text opacity-70">+{unreadCount - 1} more</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {topNotification.action_url && (
            <button
              onClick={handleAction}
              className="px-3 py-1 text-xs terminal-text uppercase border border-current hover:bg-white/20 transition-colors"
            >
              [VIEW]
            </button>
          )}
          <button
            onClick={handleClose}
            className="px-2 py-1 text-xs terminal-text uppercase hover:bg-white/20 transition-colors"
            aria-label="Close notification"
          >
            [CLOSE]
          </button>
        </div>
      </div>
    </div>
  );
};
