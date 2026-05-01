import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

interface AppDef {
  id: string;
  label: string;
  icon: string;
  path: string;
  badge?: number;
  inDock?: boolean;
}

export default function HomeScreen() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [badges] = useState<Record<string, number>>({});
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);

  const hours = time.getHours();
  const minutes = time.getMinutes().toString().padStart(2, '0');
  const dateStr = time.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const apps: AppDef[] = [
    {
      id: 'social',
      label: 'X',
      icon: '/icons/icon-social.png',
      path: 'social',
      badge: badges.social,
      inDock: true,
    },
    {
      id: 'chat',
      label: 'TeamChat',
      icon: '/icons/icon-chat.png',
      path: 'chat',
      badge: badges.chat,
      inDock: true,
    },
    {
      id: 'email',
      label: 'Mail',
      icon: '/icons/icon-mail.png',
      path: 'email',
      badge: badges.email,
      inDock: true,
    },
    {
      id: 'news',
      label: 'News',
      icon: '/icons/icon-news.png',
      path: 'news',
      badge: badges.news,
      inDock: true,
    },
    { id: 'browser', label: 'FactCheck', icon: '/icons/icon-factcheck.png', path: 'browser' },
    { id: 'drafts', label: 'DraftPad', icon: '/icons/icon-drafts.png', path: 'drafts' },
  ];

  const gridApps = apps.filter((a) => !a.inDock);
  const dockApps = apps.filter((a) => a.inDock);

  return (
    <div
      className="h-full flex flex-col relative overflow-hidden"
      style={{
        backgroundImage: 'url(/icons/wallpaper.png)',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
    >
      {/* Time & Date Widget */}
      <div className="flex flex-col items-center pt-12 pb-6">
        <div
          className="text-white font-light tracking-tight"
          style={{
            fontSize: 72,
            lineHeight: 1,
            fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
          }}
        >
          {hours}:{minutes}
        </div>
        <div
          className="text-white/80 mt-1"
          style={{
            fontSize: 17,
            fontWeight: 500,
            letterSpacing: 0.3,
            fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
          }}
        >
          {dateStr}
        </div>
      </div>

      {/* App Grid */}
      <div className="flex-1 flex flex-col items-center justify-start px-6 pt-6">
        <div className="grid grid-cols-4 gap-x-5 gap-y-6">
          {apps.map((app) => (
            <button
              key={app.id}
              onClick={() => navigate(`/sim/${sessionId}/device/${app.path}`)}
              className="flex flex-col items-center gap-[6px] ios-btn-bounce"
            >
              <div className="relative">
                <div className="w-[62px] h-[62px] relative">
                  <img
                    src={app.icon}
                    alt={app.label}
                    className="w-full h-full superellipse-icon shadow-lg"
                    draggable={false}
                  />
                  {/* iOS-style inner highlight */}
                  <div
                    className="absolute inset-0 superellipse-icon pointer-events-none"
                    style={{
                      boxShadow: 'inset 0 0 0 0.5px rgba(255,255,255,0.15)',
                    }}
                  />
                </div>
                {!!app.badge && app.badge > 0 && (
                  <span
                    className="absolute -top-1 -right-1 min-w-[20px] h-[20px] bg-[#FF3B30] text-white text-[13px] font-bold rounded-full flex items-center justify-center px-1"
                    style={{ borderWidth: 2, borderColor: 'rgba(0,0,0,0.2)', borderStyle: 'solid' }}
                  >
                    {app.badge > 99 ? '99+' : app.badge}
                  </span>
                )}
              </div>
              <span
                className="text-white text-center truncate w-[68px]"
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  textShadow: '0 1px 3px rgba(0,0,0,0.5)',
                  fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
                }}
              >
                {app.label}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Page Indicator Dots */}
      <div className="flex items-center justify-center gap-1.5 py-2">
        <div className="w-[7px] h-[7px] rounded-full bg-white" />
        <div className="w-[7px] h-[7px] rounded-full bg-white/30" />
      </div>

      {/* Dock */}
      <div
        className="mx-2 mb-1 px-4 py-3"
        style={{
          background: 'rgba(30, 30, 30, 0.55)',
          backdropFilter: 'blur(30px)',
          WebkitBackdropFilter: 'blur(30px)',
          borderRadius: 28,
          borderTop: '0.5px solid rgba(255,255,255,0.1)',
        }}
      >
        <div className="flex items-center justify-around">
          {dockApps.map((app) => (
            <button
              key={app.id}
              onClick={() => navigate(`/sim/${sessionId}/device/${app.path}`)}
              className="flex flex-col items-center ios-btn-bounce"
            >
              <div className="relative">
                <div className="w-[58px] h-[58px] relative">
                  <img
                    src={app.icon}
                    alt={app.label}
                    className="w-full h-full superellipse-icon shadow-lg"
                    draggable={false}
                  />
                  <div
                    className="absolute inset-0 superellipse-icon pointer-events-none"
                    style={{ boxShadow: 'inset 0 0 0 0.5px rgba(255,255,255,0.12)' }}
                  />
                </div>
                {!!app.badge && app.badge > 0 && (
                  <span
                    className="absolute -top-1 -right-1 min-w-[20px] h-[20px] bg-[#FF3B30] text-white text-[13px] font-bold rounded-full flex items-center justify-center px-1"
                    style={{ borderWidth: 2, borderColor: 'rgba(0,0,0,0.3)', borderStyle: 'solid' }}
                  >
                    {app.badge > 99 ? '99+' : app.badge}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
