import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
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
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, right: 0 });

  // Calculate dropdown position when opening or scrolling
  const updateDropdownPosition = () => {
    if (buttonRef.current) {
      const buttonRect = buttonRef.current.getBoundingClientRect();
      setDropdownPosition({
        top: buttonRect.bottom + window.scrollY + 8, // 8px = mt-2 equivalent
        right: window.innerWidth - buttonRect.right,
      });
    }
  };

  useEffect(() => {
    if (isOpen) {
      updateDropdownPosition();
      // Update position on scroll and resize
      window.addEventListener('scroll', updateDropdownPosition, true);
      window.addEventListener('resize', updateDropdownPosition);
      return () => {
        window.removeEventListener('scroll', updateDropdownPosition, true);
        window.removeEventListener('resize', updateDropdownPosition);
      };
    }
  }, [isOpen]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
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
        return 'border-l-4 border-danger bg-danger/10';
      case 'high':
        return 'border-l-4 border-accent bg-accent/10';
      case 'medium':
        return 'border-l-4 border-warning bg-warning/10';
      case 'low':
        return 'border-l-4 border-success bg-success/10';
      default:
        return 'border-l-4 border-border bg-surface-2';
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

  const dropdownContent = isOpen ? (
    <div
      ref={dropdownRef}
      className="fixed w-96 max-h-[600px] overflow-y-auto bg-surface border border-border rounded-xl shadow-lg z-[9999]"
      style={{
        top: `${dropdownPosition.top}px`,
        right: `${dropdownPosition.right}px`,
      }}
    >
      {/* Header */}
      <div className="p-4 border-b border-border flex items-center justify-between">
        <h3 className="text-sm font-bold uppercase tracking-wide text-brand">Notifications</h3>
        {unreadCount > 0 && (
          <button
            onClick={handleMarkAllRead}
            className="text-xs font-semibold text-brand hover:text-accent"
          >
            Mark all read
          </button>
        )}
      </div>

      {/* Notifications List */}
      <div className="max-h-[500px] overflow-y-auto">
        {sortedNotifications.length === 0 ? (
          <div className="p-6 text-center">
            <p className="text-sm text-muted">No notifications</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {sortedNotifications.map((notification) => (
              <div
                key={notification.id}
                className={`p-4 hover:bg-surface-2 cursor-pointer transition-colors ${
                  !notification.read ? getPriorityStyles(notification.priority) : ''
                } ${notification.read ? 'opacity-70' : ''}`}
                onClick={() => handleNotificationClick(notification)}
              >
                <div className="flex items-start gap-3">
                  <span className="text-xl flex-shrink-0">{getIcon(notification.priority)}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className="text-sm font-bold text-ink">{notification.title}</h4>
                      {!notification.read && (
                        <span className="w-2 h-2 bg-accent rounded-full flex-shrink-0"></span>
                      )}
                    </div>
                    <p className="text-xs text-muted mb-2">{notification.message}</p>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted uppercase">{notification.priority}</span>
                      {notification.action_url && (
                        <span className="text-xs text-brand font-medium">Click to view</span>
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
  ) : null;

  return (
    <>
      {/* Bell Icon Button */}
      <button
        ref={buttonRef}
        onClick={toggleDropdown}
        className="relative w-9 h-9 rounded-lg flex items-center justify-center text-white bg-white/10 hover:bg-white/20 transition-all flex-none"
        aria-label="Notifications"
      >
        {/* Inline SVG instead of the bell emoji: emoji fonts (especially on
            Windows) have unpredictable metrics and overflow the 36px box. */}
        <svg
          className="w-5 h-5"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"
          />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 bg-accent text-white text-[10px] font-bold rounded-full px-1.5 min-w-[18px] h-[18px] flex items-center justify-center">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown Panel - Rendered via Portal */}
      {isOpen && createPortal(dropdownContent, document.body)}
    </>
  );
};
