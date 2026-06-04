import { useEffect, useState } from 'react';

export interface NotificationItem {
  id: string;
  dbId: string | null;
  appId: string;
  appIcon: string;
  appName: string;
  title: string;
  body: string;
  timestamp: string;
  route: string;
  isPageNotification?: boolean;
}

interface NotificationBannerProps {
  notification: NotificationItem | null;
  onDismiss: () => void;
  onTap: (notification: NotificationItem) => void;
}

export function NotificationBanner({ notification, onDismiss, onTap }: NotificationBannerProps) {
  const [dismissing, setDismissing] = useState(false);

  useEffect(() => {
    if (!notification) return;
    setDismissing(false);

    const timer = setTimeout(() => {
      setDismissing(true);
      setTimeout(onDismiss, 200);
    }, 5000);

    return () => clearTimeout(timer);
  }, [notification?.id]);

  if (!notification) return null;

  const handleTap = () => {
    setDismissing(true);
    setTimeout(() => onTap(notification), 100);
  };

  const timeLabel = (() => {
    const diff = Date.now() - new Date(notification.timestamp).getTime();
    if (diff < 60000) return 'now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return `${Math.floor(diff / 3600000)}h ago`;
  })();

  return (
    <div
      className="absolute left-0 right-0 flex justify-center px-2"
      style={{ top: 56, zIndex: 9000, pointerEvents: 'none' }}
    >
      <button
        onClick={handleTap}
        className={`w-full rounded-[14px] px-3.5 py-3 flex items-start gap-3 text-left transition-all ${
          dismissing ? 'ios-notification-dismiss' : 'ios-notification-banner'
        }`}
        style={{
          pointerEvents: 'auto',
          background: 'rgba(30,30,30,0.88)',
          backdropFilter: 'saturate(180%) blur(20px)',
          WebkitBackdropFilter: 'saturate(180%) blur(20px)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
        }}
      >
        <img
          src={notification.appIcon}
          alt=""
          className="w-[24px] h-[24px] rounded-[6px] flex-shrink-0 mt-0.5"
          draggable={false}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-semibold text-white truncate">
              {notification.appName}
            </span>
            <span className="text-[12px] text-[#8E8E93] flex-shrink-0">{timeLabel}</span>
          </div>
          <p className="text-[13px] text-[#ABABAB] mt-0.5 line-clamp-2 leading-tight">
            {notification.title}
            {notification.body ? `: ${notification.body}` : ''}
          </p>
        </div>
      </button>
    </div>
  );
}
