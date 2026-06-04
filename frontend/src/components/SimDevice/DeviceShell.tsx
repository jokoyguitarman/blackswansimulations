import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Outlet, useParams, useNavigate, useLocation } from 'react-router-dom';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useAuth } from '../../contexts/AuthContext';
import { PageModeProvider, usePageMode } from '../../contexts/PageModeContext';
import { supabase } from '../../lib/supabase';
import { NotificationBanner, type NotificationItem } from './NotificationBanner';
import { NotificationCenter } from './NotificationCenter';
import '../../styles/device-sim.css';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

function apiUrl(path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (API_BASE_URL) return `${API_BASE_URL.replace(/\/$/, '')}${cleanPath}`;
  return cleanPath;
}

async function getAuthHeaders() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session?.access_token || ''}`,
  };
}

interface WSEvent {
  type: string;
  data?: Record<string, unknown>;
  timestamp?: string;
}

function mapEventToNotification(event: WSEvent, sessionId: string): NotificationItem | null {
  const ts = event.timestamp || new Date().toISOString();
  const id = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (event.type === 'notification.created') {
    // Handle two data formats:
    // 1. notificationService: { notification: { id, type, title, message, ... } }
    // 2. socialNotificationService: { user_id, notification_type, title, platform, ... }
    const raw = (event.data || {}) as Record<string, unknown>;
    const notif = (raw.notification || raw) as Record<string, unknown>;
    const notifType = String(notif.type || notif.notification_type || '');
    const dbId = String(notif.id || '') || null;
    const title = String(notif.title || 'Notification');
    const message = String(notif.message || '');
    const platform = String(notif.platform || '');

    const topMetadata = (notif.metadata || {}) as Record<string, unknown>;
    const isPageNotification = !!topMetadata.is_page_notification;

    let appId = 'home';
    let appName = 'System';
    let appIcon = '/icons/icon-chat.png';
    let route = `/sim/${sessionId}/device/home`;

    if (notifType === 'chat_message') {
      appId = 'chat';
      appName = 'TeamChat';
      appIcon = '/icons/icon-chat.png';
      route = `/sim/${sessionId}/device/chat`;
    } else if (
      notifType === 'social_reply' ||
      notifType === 'social_like' ||
      notifType === 'social_mention' ||
      notifType === 'social_repost'
    ) {
      const metadata = (notif.metadata || {}) as Record<string, unknown>;
      const postId = String(metadata.post_id || metadata.highlight_post_id || '');
      appId = platform === 'facebook' ? 'facebook' : 'social';
      appName = platform === 'facebook' ? 'Fakebook' : 'Z';
      appIcon = platform === 'facebook' ? '/icons/icon-facebook.png' : '/icons/icon-social.png';
      const appPath = platform === 'facebook' ? 'facebook' : 'social';
      route = postId
        ? `/sim/${sessionId}/device/${appPath}?post=${postId}`
        : `/sim/${sessionId}/device/${appPath}`;
    } else if (notifType === 'inject_published') {
      appId = 'news';
      appName = 'News';
      appIcon = '/icons/icon-news.png';
      route = `/sim/${sessionId}/device/news`;
    } else if (
      notifType === 'decision_approval_required' ||
      notifType === 'decision_approved' ||
      notifType === 'decision_rejected'
    ) {
      appId = 'home';
      appName = 'Decisions';
      appIcon = '/icons/icon-chat.png';
      route = `/sim/${sessionId}/device/home`;
    } else if (notifType === 'incident_reported' || notifType === 'incident_assigned') {
      appId = 'home';
      appName = 'Incidents';
      appIcon = '/icons/icon-news.png';
      route = `/sim/${sessionId}/device/home`;
    } else if (notifType === 'system_alert') {
      appId = 'home';
      appName = 'System';
      appIcon = '/icons/icon-news.png';
      route = `/sim/${sessionId}/device/home`;
    }

    return {
      id: dbId || id,
      dbId,
      appId,
      appIcon,
      appName,
      title,
      body: message,
      timestamp: String(notif.created_at || ts),
      route,
      isPageNotification,
    };
  }

  if (event.type === 'sim_email.received') {
    const email = (event.data?.email || {}) as Record<string, unknown>;
    const fromName = String(email.from_name || 'Unknown');
    const subject = String(email.subject || 'New email');
    return {
      id,
      dbId: null,
      appId: 'email',
      appIcon: '/icons/icon-mail.png',
      appName: 'Mail',
      title: fromName,
      body: subject,
      timestamp: ts,
      route: `/sim/${sessionId}/device/email`,
    };
  }

  if (event.type === 'inject.published') {
    const inject = (event.data?.inject || {}) as Record<string, unknown>;
    const title = String(inject.title || 'Breaking News');
    return {
      id,
      dbId: null,
      appId: 'news',
      appIcon: '/icons/icon-news.png',
      appName: 'News',
      title: 'Breaking',
      body: title,
      timestamp: ts,
      route: `/sim/${sessionId}/device/news`,
    };
  }

  return null;
}

export default function DeviceShell() {
  return (
    <PageModeProvider>
      <DeviceShellInner />
    </PageModeProvider>
  );
}

function DeviceShellInner() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { isPageMode } = usePageMode();
  const [time, setTime] = useState(new Date());

  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [bannerQueue, setBannerQueue] = useState<NotificationItem[]>([]);
  const [activeBanner, setActiveBanner] = useState<NotificationItem | null>(null);
  const [centerExpanded, setCenterExpanded] = useState(false);
  const processedIdsRef = useRef<Set<string>>(new Set());
  const initialFetchDoneRef = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);

  // Fetch existing unread notifications on mount
  useEffect(() => {
    if (!sessionId || initialFetchDoneRef.current) return;
    initialFetchDoneRef.current = true;

    (async () => {
      try {
        const headers = await getAuthHeaders();
        const res = await fetch(
          apiUrl(`/api/notifications?session_id=${sessionId}&read=false&limit=50`),
          { headers },
        );
        if (!res.ok) return;
        const result = await res.json();
        const data = (result.data || []) as Array<Record<string, unknown>>;

        const items: NotificationItem[] = [];
        for (const row of data) {
          const notifId = String(row.id || '');
          processedIdsRef.current.add(notifId);

          const mapped = mapEventToNotification(
            {
              type: 'notification.created',
              data: { notification: row },
              timestamp: String(row.created_at || ''),
            },
            sessionId,
          );
          if (mapped) items.push(mapped);
        }
        setNotifications(items);
      } catch {
        /* ignore */
      }
    })();
  }, [sessionId]);

  // WebSocket listener for live notifications
  useWebSocket({
    sessionId: sessionId || '',
    eventTypes: ['notification.created', 'sim_email.received'],
    onEvent: useCallback(
      (event: WSEvent) => {
        if (!sessionId) return;

        // For notification.created: only show if it's meant for THIS user
        if (event.type === 'notification.created') {
          const notif = (event.data?.notification || event.data || {}) as Record<string, unknown>;
          const targetUserId = String(notif.user_id || '');
          if (targetUserId && user?.id && targetUserId !== user.id) return;

          const dbId = String(notif.id || '');
          if (dbId && processedIdsRef.current.has(dbId)) return;
          if (dbId) processedIdsRef.current.add(dbId);
        }

        const item = mapEventToNotification(event, sessionId);
        if (!item) return;

        // Don't show banner if user is already on the target app
        const currentPath = window.location.pathname;
        if (item.route && currentPath.endsWith(item.appId)) return;

        setBannerQueue((prev) => [...prev, item]);
      },
      [sessionId, user?.id],
    ),
    enabled: !!sessionId,
  });

  // Process banner queue: show next banner when none is active
  useEffect(() => {
    if (activeBanner || bannerQueue.length === 0) return;
    const [next, ...rest] = bannerQueue;
    setActiveBanner(next);
    setBannerQueue(rest);
  }, [activeBanner, bannerQueue]);

  const handleBannerDismiss = useCallback(() => {
    if (activeBanner) {
      // Move to notification center if it has a dbId (persisted)
      if (activeBanner.dbId) {
        setNotifications((prev) => {
          if (prev.some((n) => n.id === activeBanner.id)) return prev;
          return [activeBanner, ...prev];
        });
      }
    }
    setActiveBanner(null);
  }, [activeBanner]);

  const handleBannerTap = useCallback(
    async (notification: NotificationItem) => {
      // Mark as read server-side
      if (notification.dbId) {
        try {
          const headers = await getAuthHeaders();
          await fetch(apiUrl(`/api/notifications/${notification.dbId}/read`), {
            method: 'POST',
            headers,
          });
        } catch {
          /* ignore */
        }
      }

      setActiveBanner(null);
      setNotifications((prev) => prev.filter((n) => n.id !== notification.id));
      navigate(notification.route);
    },
    [navigate],
  );

  const handleCenterTap = useCallback(
    async (notification: NotificationItem) => {
      if (notification.dbId) {
        try {
          const headers = await getAuthHeaders();
          await fetch(apiUrl(`/api/notifications/${notification.dbId}/read`), {
            method: 'POST',
            headers,
          });
        } catch {
          /* ignore */
        }
      }

      setNotifications((prev) => prev.filter((n) => n.id !== notification.id));
      setCenterExpanded(false);
      navigate(notification.route);
    },
    [navigate],
  );

  const handleClearAll = useCallback(async () => {
    if (sessionId) {
      try {
        const headers = await getAuthHeaders();
        await fetch(apiUrl('/api/notifications/read-all'), {
          method: 'POST',
          headers,
          body: JSON.stringify({ session_id: sessionId }),
        });
      } catch {
        /* ignore */
      }
    }
    setNotifications([]);
    setCenterExpanded(false);
  }, [sessionId]);

  const filteredNotifications = useMemo(
    () =>
      notifications.filter((n) =>
        isPageMode ? n.isPageNotification === true : n.isPageNotification !== true,
      ),
    [notifications, isPageMode],
  );

  const hours = time.getHours();
  const minutes = time.getMinutes().toString().padStart(2, '0');
  const timeStr = `${hours}:${minutes}`;

  return (
    <div className="min-h-screen bg-[#1a1a2e] flex items-center justify-center p-4 device-sim">
      <div className="relative" style={{ width: 393, height: 852 }}>
        {/* Phone Frame */}
        <svg
          width="430"
          height="882"
          viewBox="0 0 430 882"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          style={{ position: 'absolute', top: -15, left: -18.5, pointerEvents: 'none' }}
        >
          <path
            d="M2 73C2 32.68 34.68 0 75 0H357C397.32 0 430 32.68 430 73V809C430 849.32 397.32 882 357 882H75C34.68 882 2 849.32 2 809V73Z"
            fill="#404040"
          />
          <path
            d="M0 171C0 170.45 0.45 170 1 170H3V204H1C0.45 204 0 203.55 0 203V171Z"
            fill="#4a4a4a"
          />
          <path
            d="M1 234C1 233.45 1.45 233 2 233H3.5V300H2C1.45 300 1 299.55 1 299V234Z"
            fill="#4a4a4a"
          />
          <path
            d="M1 319C1 318.45 1.45 318 2 318H3.5V385H2C1.45 385 1 384.55 1 384V319Z"
            fill="#4a4a4a"
          />
          <path
            d="M430 279H432C432.55 279 433 279.45 433 280V384C433 384.55 432.55 385 432 385H430V279Z"
            fill="#4a4a4a"
          />
          <path
            d="M6 74C6 35.34 37.34 4 76 4H356C394.66 4 426 35.34 426 74V808C426 846.66 394.66 878 356 878H76C37.34 878 6 846.66 6 808V74Z"
            fill="#1C1C1E"
          />
          <rect x="21" y="19" width="390" height="844" rx="55" ry="55" fill="#000000" />
          <path
            d="M154 48.5C154 38.28 162.28 30 172.5 30H259.5C269.72 30 278 38.28 278 48.5C278 58.72 269.72 67 259.5 67H172.5C162.28 67 154 58.72 154 48.5Z"
            fill="#1C1C1E"
          />
          <circle cx="259.5" cy="48.5" r="5.5" fill="#2C2C2E" />
          <circle cx="259.5" cy="48.5" r="3.5" fill="#1C1C1E" />
        </svg>

        {/* Screen Content Area */}
        <div
          className="absolute overflow-hidden bg-black"
          style={{
            top: 0,
            left: 0,
            width: 393,
            height: 852,
            borderRadius: 47,
            clipPath: 'inset(0 round 47px)',
          }}
        >
          {/* Status Bar */}
          <div
            className="ios-status-bar relative z-50 flex items-center justify-between px-8 text-white"
            style={{ height: 54, paddingTop: 14 }}
          >
            <span className="text-[15px] font-semibold tracking-tight">{timeStr}</span>
            <div className="flex items-center gap-[5px]">
              <svg width="17" height="12" viewBox="0 0 17 12" fill="white">
                <rect x="0" y="9" width="3" height="3" rx="0.5" opacity="1" />
                <rect x="4.5" y="6" width="3" height="6" rx="0.5" opacity="1" />
                <rect x="9" y="3" width="3" height="9" rx="0.5" opacity="1" />
                <rect x="13.5" y="0" width="3" height="12" rx="0.5" opacity="0.3" />
              </svg>
              <span className="text-[12px] font-semibold ml-0.5">5G</span>
              <svg width="16" height="12" viewBox="0 0 16 12" fill="white" className="ml-0.5">
                <path d="M8 11.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
                <path
                  d="M4.05 7.95a5.5 5.5 0 017.9 0"
                  stroke="white"
                  strokeWidth="1.5"
                  fill="none"
                  strokeLinecap="round"
                />
                <path
                  d="M1.3 5.2a9 9 0 0113.4 0"
                  stroke="white"
                  strokeWidth="1.5"
                  fill="none"
                  strokeLinecap="round"
                />
              </svg>
              <svg width="27" height="13" viewBox="0 0 27 13" className="ml-1">
                <rect
                  x="0"
                  y="0.5"
                  width="23"
                  height="12"
                  rx="3.5"
                  stroke="white"
                  strokeOpacity="0.35"
                  fill="none"
                />
                <rect x="1.5" y="2" width="17" height="9" rx="2" fill="#34C759" />
                <path
                  d="M24 4.5C25.1 4.5 26 5.4 26 6.5C26 7.6 25.1 8.5 24 8.5V4.5Z"
                  fill="white"
                  fillOpacity="0.4"
                />
              </svg>
            </div>
          </div>

          {/* App Content */}
          <div
            className="flex-1 overflow-hidden app-content-enter"
            style={{ height: 852 - 54 - 34 }}
            key={location.pathname}
          >
            <Outlet />
          </div>

          {/* Notification Banner (overlays everything) */}
          <NotificationBanner
            notification={activeBanner}
            onDismiss={handleBannerDismiss}
            onTap={handleBannerTap}
          />

          {/* Notification Center (pill + expandable list) */}
          {!activeBanner && (
            <NotificationCenter
              notifications={filteredNotifications}
              expanded={centerExpanded}
              onToggle={() => setCenterExpanded((e) => !e)}
              onTap={handleCenterTap}
              onClear={handleClearAll}
            />
          )}

          {/* Home Indicator */}
          <div
            className="absolute bottom-0 left-0 right-0 flex items-center justify-center"
            style={{ height: 34 }}
          >
            <button
              onClick={() => navigate(`/sim/${sessionId}/device/home`)}
              className="rounded-full bg-white/30 hover:bg-white/50 transition-colors"
              style={{ width: 134, height: 5 }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
