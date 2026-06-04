import type { NotificationItem } from './NotificationBanner';

interface NotificationCenterProps {
  notifications: NotificationItem[];
  expanded: boolean;
  onToggle: () => void;
  onTap: (notification: NotificationItem) => void;
  onClear: () => void;
}

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export function NotificationCenter({
  notifications,
  expanded,
  onToggle,
  onTap,
  onClear,
}: NotificationCenterProps) {
  if (notifications.length === 0 && !expanded) return null;

  if (!expanded) {
    return (
      <div
        className="absolute left-0 right-0 flex justify-center"
        style={{ top: 56, zIndex: 8000, pointerEvents: 'none' }}
      >
        <button
          onClick={onToggle}
          className="mt-1 px-3 py-1 rounded-full text-[11px] font-medium"
          style={{
            pointerEvents: 'auto',
            background: 'rgba(50,50,50,0.75)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            color: '#E0E0E0',
          }}
        >
          {notifications.length} notification{notifications.length !== 1 ? 's' : ''}
        </button>
      </div>
    );
  }

  return (
    <div
      className="absolute inset-0 flex flex-col"
      style={{ top: 54, zIndex: 8500, pointerEvents: 'none' }}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0"
        style={{ pointerEvents: 'auto', background: 'rgba(0,0,0,0.3)' }}
        onClick={onToggle}
      />

      {/* Panel */}
      <div
        className="relative notification-center-overlay rounded-b-2xl overflow-hidden flex flex-col"
        style={{
          pointerEvents: 'auto',
          maxHeight: '60%',
          background: 'rgba(30,30,30,0.92)',
          backdropFilter: 'saturate(180%) blur(20px)',
          WebkitBackdropFilter: 'saturate(180%) blur(20px)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 flex-shrink-0"
          style={{ borderBottom: '0.5px solid rgba(255,255,255,0.1)' }}
        >
          <span className="text-[15px] font-semibold text-white">
            Notifications ({notifications.length})
          </span>
          <button
            onClick={onClear}
            className="text-[13px] font-medium"
            style={{ color: '#007AFF' }}
          >
            Clear All
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {notifications.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-[14px] text-[#8E8E93]">No notifications</p>
            </div>
          ) : (
            notifications.map((notif) => (
              <button
                key={notif.id}
                onClick={() => onTap(notif)}
                className="w-full text-left flex items-start gap-3 px-4 py-3 active:bg-white/5 transition-colors"
                style={{ borderBottom: '0.5px solid rgba(255,255,255,0.06)' }}
              >
                <img
                  src={notif.appIcon}
                  alt=""
                  className="w-[28px] h-[28px] rounded-[7px] flex-shrink-0 mt-0.5"
                  draggable={false}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-semibold text-white truncate">
                      {notif.appName}
                    </span>
                    <span className="text-[11px] text-[#8E8E93] flex-shrink-0">
                      {timeAgo(notif.timestamp)}
                    </span>
                  </div>
                  <p className="text-[13px] text-[#CDCDCD] mt-0.5 font-medium truncate">
                    {notif.title}
                  </p>
                  {notif.body && (
                    <p className="text-[12px] text-[#8E8E93] mt-0.5 truncate">{notif.body}</p>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
