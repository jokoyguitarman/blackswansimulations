import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { api } from '../../lib/api';

interface AppDef {
  id: string;
  label: string;
  emoji: string;
  gradient: string;
  path: string;
  badge?: number;
  inDock?: boolean;
}

export default function HomeScreen() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [badges] = useState<Record<string, number>>({});
  const [scenario, setScenario] = useState<{ title: string; description: string } | null>(null);

  useEffect(() => {
    loadSessionInfo();
  }, [sessionId]);

  async function loadSessionInfo() {
    if (!sessionId) return;
    try {
      const result = await api.sessions.get(sessionId);
      if (result?.data) {
        const s = result.data as Record<string, unknown>;
        const scenarioData = s.scenario as Record<string, unknown> | undefined;
        setScenario({
          title: String(scenarioData?.title || 'Crisis Simulation'),
          description: String(scenarioData?.description || ''),
        });
      }
    } catch {
      /* ignore */
    }
  }

  const apps: AppDef[] = [
    {
      id: 'social',
      label: 'SocialFeed',
      emoji: '𝕏',
      gradient: 'bg-black',
      path: 'social',
      badge: badges.social,
      inDock: true,
    },
    {
      id: 'chat',
      label: 'TeamChat',
      emoji: '💬',
      gradient: 'bg-[#25D366]',
      path: 'chat',
      badge: badges.chat,
      inDock: true,
    },
    {
      id: 'email',
      label: 'Mail',
      emoji: '✉️',
      gradient: 'bg-[#007AFF]',
      path: 'email',
      badge: badges.email,
      inDock: true,
    },
    {
      id: 'news',
      label: 'News',
      emoji: '📰',
      gradient: 'bg-[#FF3B30]',
      path: 'news',
      badge: badges.news,
      inDock: true,
    },
    { id: 'browser', label: 'FactCheck', emoji: '🔍', gradient: 'bg-[#5856D6]', path: 'browser' },
    { id: 'drafts', label: 'DraftPad', emoji: '📝', gradient: 'bg-[#FF9500]', path: 'drafts' },
  ];

  const gridApps = apps.filter((a) => !a.inDock);
  const dockApps = apps.filter((a) => a.inDock);

  return (
    <div
      className="h-full flex flex-col relative overflow-hidden"
      style={{ background: 'linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)' }}
    >
      {/* Grid Apps */}
      <div className="flex-1 flex flex-col items-center justify-center px-8 pt-16">
        <div className="grid grid-cols-4 gap-x-6 gap-y-5">
          {apps.map((app) => (
            <button
              key={app.id}
              onClick={() => navigate(`/sim/${sessionId}/device/${app.path}`)}
              className="flex flex-col items-center gap-1.5 ios-btn-bounce"
            >
              <div className="relative">
                <div
                  className={`w-[60px] h-[60px] ${app.gradient} superellipse-icon flex items-center justify-center text-[28px] shadow-lg`}
                >
                  {app.emoji}
                </div>
                {!!app.badge && app.badge > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[20px] h-[20px] bg-[#FF3B30] text-white text-[13px] font-bold rounded-full flex items-center justify-center px-1 border-2 border-[#302b63]">
                    {app.badge > 99 ? '99+' : app.badge}
                  </span>
                )}
              </div>
              <span className="text-[11px] text-white/90 font-medium tracking-tight">
                {app.label}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Page Indicator */}
      <div className="flex items-center justify-center py-2">
        <div className="w-[6px] h-[6px] rounded-full bg-white/80" />
      </div>

      {/* Dock */}
      <div className="dock-blur mx-3 mb-1 rounded-[26px] px-5 py-3">
        <div className="flex items-center justify-around">
          {dockApps.map((app) => (
            <button
              key={app.id}
              onClick={() => navigate(`/sim/${sessionId}/device/${app.path}`)}
              className="flex flex-col items-center ios-btn-bounce"
            >
              <div className="relative">
                <div
                  className={`w-[60px] h-[60px] ${app.gradient} superellipse-icon flex items-center justify-center text-[28px] shadow-lg`}
                >
                  {app.emoji}
                </div>
                {!!app.badge && app.badge > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[20px] h-[20px] bg-[#FF3B30] text-white text-[13px] font-bold rounded-full flex items-center justify-center px-1 border-2 border-black/30">
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
