import { useState, useRef, useEffect } from 'react';
import { useNotifications } from '../../contexts/NotificationContext';
import { useNavigate } from 'react-router-dom';

/**
 * Notification Bell Component - Expandable notification dropdown
 * Replaces the banner with a bell icon that expands to show notifications
 */

export const NotificationBell = () => {
  const { notifications, markAsRead, markAllAsRead, unreadCount, loadNotifications } =
    useNotifications();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [isOpen]);

  // Load notifications when dropdown opens
  useEffect(() => {
    if (isOpen) {
      loadNotifications();
    }
  }, [isOpen, loadNotifications]);

  // Filter and sort notifications
  const sortedNotifications = [...notifications]
    .sort((a, b) => {
      // Unread first
      if (a.read !== b.read) {
        return a.read ? 1 : -1;
      }
      // Then by priority
      const priorityOrder: Record<string, number> = {
        critical: 0,
        high: 1,
        medium: 2,
        low: 3,
      };
      return (priorityOrder[a.priority] || 99) - (priorityOrder[b.priority] || 99);
    })
    .slice(0, 20); // Limit to 20 most recent

  // Helper function to normalize action URLs
  const normalizeActionUrl = (
    actionUrl: string | null,
    notification: (typeof notifications)[0],
  ): string | null => {
    if (!actionUrl) return null;

    if (actionUrl.startsWith('/sessions/')) {
      return actionUrl;
    }

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

    return `/sessions/${notification.session_id}`;
  };

  const getPriorityStyles = (priority: string) => {
    switch (priority) {
      case 'critical':
        return 'border-l-4 border-red-500 bg-red-900/20';
      case 'high':
        return 'border-l-4 border-robotic-orange bg-robotic-orange/10';
      case 'medium':
        return 'border-l-4 border-robotic-yellow bg-robotic-yellow/10';
      case 'low':
        return 'border-l-4 border-green-500 bg-green-900/20';
      default:
        return 'border-l-4 border-robotic-gray-50 bg-robotic-gray-200/20';
    }
  };

  const getIcon = (priority: string) => {
    switch (priority) {
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

  const handleNotificationClick = (notification: (typeof notifications)[0]) => {
    const normalizedUrl = normalizeActionUrl(notification.action_url, notification);
    if (normalizedUrl) {
      navigate(normalizedUrl);
    }
    if (!notification.read) {
      markAsRead(notification.id);
    }
    setIsOpen(false);
  };

  const handleMarkAllRead = async () => {
    await markAllAsRead();
  };

  const toggleDropdown = () => {
    setIsOpen(!isOpen);
  };

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Bell Icon Button */}
      <button
        onClick={toggleDropdown}
        className="relative px-3 py-2 text-robotic-yellow hover:bg-robotic-yellow/10 transition-all border border-robotic-yellow/50 hover:border-robotic-yellow"
        aria-label="Notifications"
      >
        <span className="text-xl">🔔</span>
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 bg-robotic-orange text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center border border-robotic-yellow">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown Panel */}
      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-96 max-h-[600px] overflow-y-auto military-border bg-robotic-gray-300 border-robotic-yellow shadow-lg z-[9999]">
          {/* Header */}
          <div className="p-4 border-b border-robotic-yellow/30 flex items-center justify-between">
            <h3 className="text-sm terminal-text uppercase text-robotic-yellow">[NOTIFICATIONS]</h3>
            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllRead}
                className="text-xs terminal-text text-robotic-yellow/70 hover:text-robotic-yellow uppercase"
              >
                [MARK ALL READ]
              </button>
            )}
          </div>

          {/* Notifications List */}
          <div className="max-h-[500px] overflow-y-auto">
            {sortedNotifications.length === 0 ? (
              <div className="p-6 text-center">
                <p className="text-sm terminal-text text-robotic-yellow/50">[NO NOTIFICATIONS]</p>
              </div>
            ) : (
              <div className="divide-y divide-robotic-yellow/20">
                {sortedNotifications.map((notification) => (
                  <div
                    key={notification.id}
                    className={`p-4 hover:bg-robotic-yellow/5 cursor-pointer transition-colors ${
                      !notification.read ? getPriorityStyles(notification.priority) : ''
                    } ${notification.read ? 'opacity-70' : ''}`}
                    onClick={() => handleNotificationClick(notification)}
                  >
                    <div className="flex items-start gap-3">
                      <span className="text-xl flex-shrink-0">
                        {getIcon(notification.priority)}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h4 className="text-sm terminal-text font-semibold uppercase text-robotic-yellow">
                            {notification.title}
                          </h4>
                          {!notification.read && (
                            <span className="w-2 h-2 bg-robotic-orange rounded-full flex-shrink-0"></span>
                          )}
                        </div>
                        <p className="text-xs terminal-text text-robotic-yellow/80 mb-2">
                          {notification.message}
                        </p>
                        <div className="flex items-center justify-between">
                          <span className="text-xs terminal-text text-robotic-yellow/50 uppercase">
                            {notification.priority}
                          </span>
                          {notification.action_url && (
                            <span className="text-xs terminal-text text-robotic-yellow/70">
                              [CLICK TO VIEW]
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
