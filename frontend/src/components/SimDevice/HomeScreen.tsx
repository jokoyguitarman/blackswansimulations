import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { api } from '../../lib/api';

interface AppIcon {
  id: string;
  name: string;
  icon: string;
  path: string;
  color: string;
  badge?: number;
}

export default function HomeScreen() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [badges, setBadges] = useState<Record<string, number>>({});
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
          title: (scenarioData?.title as string) || 'Crisis Simulation',
          description: (scenarioData?.description as string) || '',
        });
      }
    } catch {
      /* ignore */
    }
  }

  const apps: AppIcon[] = [
    {
      id: 'social',
      name: 'SocialFeed',
      icon: '𝕏',
      path: 'social',
      color: 'bg-black',
      badge: badges.social,
    },
    {
      id: 'chat',
      name: 'TeamChat',
      icon: '💬',
      path: 'chat',
      color: 'bg-green-600',
      badge: badges.chat,
    },
    {
      id: 'email',
      name: 'Email',
      icon: '✉️',
      path: 'email',
      color: 'bg-blue-600',
      badge: badges.email,
    },
    { id: 'news', name: 'News', icon: '📰', path: 'news', color: 'bg-red-600', badge: badges.news },
    { id: 'browser', name: 'FactCheck', icon: '🔍', path: 'browser', color: 'bg-purple-600' },
    { id: 'drafts', name: 'DraftPad', icon: '📝', path: 'drafts', color: 'bg-yellow-600' },
  ];

  return (
    <div className="h-full flex flex-col bg-gradient-to-b from-gray-900 via-gray-800 to-gray-900 text-white">
      {/* Scenario Banner */}
      <div className="px-6 pt-4 pb-2">
        <h2 className="text-lg font-semibold truncate">{scenario?.title || 'Loading...'}</h2>
        <p className="text-xs text-gray-400 truncate">{scenario?.description?.substring(0, 80)}</p>
      </div>

      {/* App Grid */}
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="grid grid-cols-3 gap-6">
          {apps.map((app) => (
            <button
              key={app.id}
              onClick={() => navigate(`/sim/${sessionId}/device/${app.path}`)}
              className="flex flex-col items-center gap-2 group"
            >
              <div className="relative">
                <div
                  className={`w-16 h-16 ${app.color} rounded-2xl flex items-center justify-center text-2xl shadow-lg group-hover:scale-110 transition-transform`}
                >
                  {app.icon}
                </div>
                {app.badge && app.badge > 0 && (
                  <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                    {app.badge > 99 ? '99+' : app.badge}
                  </span>
                )}
              </div>
              <span className="text-xs text-gray-300 group-hover:text-white transition-colors">
                {app.name}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* User Info */}
      <div className="px-6 pb-4 text-center">
        <p className="text-xs text-gray-500">Logged in as {user?.displayName || 'Player'}</p>
      </div>
    </div>
  );
}
