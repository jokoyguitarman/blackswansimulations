import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import SocialFeedApp from './SocialFeedApp';
import EmailApp from './EmailApp';
import NewsApp from './NewsApp';
import GroupChatApp from './GroupChatApp';
import FactCheckBrowser from './FactCheckBrowser';
import DraftPadApp from './DraftPadApp';

interface WindowState {
  id: string;
  app: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  minimized: boolean;
}

const APP_REGISTRY: Record<string, { title: string; icon: string; component: React.FC }> = {
  social: { title: 'SocialFeed', icon: '𝕏', component: SocialFeedApp },
  email: { title: 'Email', icon: '✉️', component: EmailApp },
  news: { title: 'News', icon: '📰', component: NewsApp },
  chat: { title: 'TeamChat', icon: '💬', component: GroupChatApp },
  browser: { title: 'FactCheck', icon: '🔍', component: FactCheckBrowser },
  drafts: { title: 'DraftPad', icon: '📝', component: DraftPadApp },
};

export default function DesktopShell() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [windows, setWindows] = useState<WindowState[]>([]);
  const [time, setTime] = useState(new Date());
  const [nextZ, setNextZ] = useState(10);

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  function openApp(appId: string) {
    const existing = windows.find((w) => w.app === appId && !w.minimized);
    if (existing) {
      bringToFront(existing.id);
      return;
    }

    const minimized = windows.find((w) => w.app === appId && w.minimized);
    if (minimized) {
      setWindows((prev) =>
        prev.map((w) => (w.id === minimized.id ? { ...w, minimized: false, zIndex: nextZ } : w)),
      );
      setNextZ((z) => z + 1);
      return;
    }

    const offset = windows.length * 30;
    const newWindow: WindowState = {
      id: crypto.randomUUID(),
      app: appId,
      title: APP_REGISTRY[appId]?.title || appId,
      x: 80 + offset,
      y: 40 + offset,
      width: 480,
      height: 640,
      zIndex: nextZ,
      minimized: false,
    };
    setWindows((prev) => [...prev, newWindow]);
    setNextZ((z) => z + 1);
  }

  function closeWindow(windowId: string) {
    setWindows((prev) => prev.filter((w) => w.id !== windowId));
  }

  function minimizeWindow(windowId: string) {
    setWindows((prev) => prev.map((w) => (w.id === windowId ? { ...w, minimized: true } : w)));
  }

  function bringToFront(windowId: string) {
    setWindows((prev) => prev.map((w) => (w.id === windowId ? { ...w, zIndex: nextZ } : w)));
    setNextZ((z) => z + 1);
  }

  return (
    <div className="h-screen w-screen bg-gradient-to-br from-gray-900 via-blue-950 to-gray-900 flex flex-col overflow-hidden">
      {/* Desktop Area */}
      <div className="flex-1 relative">
        {/* Desktop Icons */}
        <div className="absolute top-4 left-4 grid grid-cols-1 gap-4">
          {Object.entries(APP_REGISTRY).map(([id, app]) => (
            <button
              key={id}
              onDoubleClick={() => openApp(id)}
              className="flex flex-col items-center gap-1 w-20 p-2 rounded-lg hover:bg-white/10 transition-colors group"
            >
              <div className="w-12 h-12 bg-gray-800 rounded-xl flex items-center justify-center text-xl shadow-lg group-hover:scale-110 transition-transform">
                {app.icon}
              </div>
              <span className="text-xs text-white/80 text-center">{app.title}</span>
            </button>
          ))}
        </div>

        {/* Windows */}
        {windows
          .filter((w) => !w.minimized)
          .map((win) => {
            const AppComponent = APP_REGISTRY[win.app]?.component;
            if (!AppComponent) return null;

            return (
              <div
                key={win.id}
                style={{
                  position: 'absolute',
                  left: win.x,
                  top: win.y,
                  width: win.width,
                  height: win.height,
                  zIndex: win.zIndex,
                }}
                className="bg-gray-900 rounded-lg shadow-2xl border border-gray-700 flex flex-col overflow-hidden"
                onMouseDown={() => bringToFront(win.id)}
              >
                {/* Title Bar */}
                <div className="h-8 bg-gray-800 flex items-center justify-between px-3 flex-shrink-0 cursor-move">
                  <div className="flex items-center gap-2">
                    <span className="text-xs">{APP_REGISTRY[win.app]?.icon}</span>
                    <span className="text-xs text-gray-300 font-medium">{win.title}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => minimizeWindow(win.id)}
                      className="w-3 h-3 rounded-full bg-yellow-500 hover:bg-yellow-400"
                    />
                    <button
                      onClick={() => closeWindow(win.id)}
                      className="w-3 h-3 rounded-full bg-red-500 hover:bg-red-400"
                    />
                  </div>
                </div>

                {/* Window Content */}
                <div className="flex-1 overflow-hidden">
                  <AppComponent />
                </div>
              </div>
            );
          })}
      </div>

      {/* Taskbar */}
      <div className="h-12 bg-gray-900/95 border-t border-gray-700 flex items-center px-4 gap-2">
        <button
          onClick={() => navigate(`/sim/${sessionId}/device/home`)}
          className="px-3 py-1 text-xs text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors"
        >
          Phone Mode
        </button>
        <div className="w-px h-6 bg-gray-700" />
        {Object.entries(APP_REGISTRY).map(([id, app]) => (
          <button
            key={id}
            onClick={() => openApp(id)}
            className={`px-3 py-1 text-xs rounded transition-colors flex items-center gap-1 ${
              windows.some((w) => w.app === id)
                ? 'bg-gray-700 text-white'
                : 'text-gray-400 hover:text-white hover:bg-gray-800'
            }`}
          >
            {app.icon} {app.title}
          </button>
        ))}
        <div className="flex-1" />
        <span className="text-xs text-gray-500">
          {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
    </div>
  );
}
