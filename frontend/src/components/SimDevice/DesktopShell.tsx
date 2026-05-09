import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import FacebookFeedApp from './FacebookFeedApp';
import EmailApp from './EmailApp';
import NewsApp from './NewsApp';
import GroupChatApp from './GroupChatApp';
import FactCheckBrowser from './FactCheckBrowser';
import DraftPadApp from './DraftPadApp';
import ZDesktopLayout from './ZDesktopLayout';

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

const APP_REGISTRY: Record<
  string,
  {
    title: string;
    icon: string;
    iconImg?: string;
    component: React.FC;
    defaultWidth?: number;
    defaultHeight?: number;
  }
> = {
  social: {
    title: 'Z',
    icon: 'Z',
    iconImg: '/icons/icon-social.png',
    component: ZDesktopLayout,
    defaultWidth: 900,
    defaultHeight: 600,
  },
  facebook: {
    title: 'Fakebook',
    icon: 'fk',
    iconImg: '/icons/icon-facebook.png',
    component: FacebookFeedApp,
    defaultWidth: 900,
    defaultHeight: 600,
  },
  email: {
    title: 'Mail',
    icon: '✉',
    iconImg: '/icons/icon-mail.png',
    component: EmailApp,
    defaultWidth: 500,
    defaultHeight: 550,
  },
  news: {
    title: 'News',
    icon: '📰',
    iconImg: '/icons/icon-news.png',
    component: NewsApp,
    defaultWidth: 480,
    defaultHeight: 580,
  },
  chat: {
    title: 'TeamChat',
    icon: '💬',
    iconImg: '/icons/icon-chat.png',
    component: GroupChatApp,
    defaultWidth: 420,
    defaultHeight: 550,
  },
  browser: {
    title: 'FactCheck',
    icon: '🔍',
    iconImg: '/icons/icon-factcheck.png',
    component: FactCheckBrowser,
    defaultWidth: 600,
    defaultHeight: 550,
  },
  drafts: {
    title: 'DraftPad',
    icon: '📝',
    iconImg: '/icons/icon-drafts.png',
    component: DraftPadApp,
    defaultWidth: 480,
    defaultHeight: 500,
  },
};

export default function DesktopShell() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [windows, setWindows] = useState<WindowState[]>([]);
  const [time, setTime] = useState(new Date());
  const [nextZ, setNextZ] = useState(100);
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
    const appDef = APP_REGISTRY[appId];
    const w = appDef?.defaultWidth || 480;
    const h = appDef?.defaultHeight || 600;
    const maxX = Math.max(0, window.innerWidth - w - 20);
    const maxY = Math.max(0, window.innerHeight - h - 60);
    const newWindow: WindowState = {
      id: crypto.randomUUID(),
      app: appId,
      title: appDef?.title || appId,
      x: Math.min(120 + offset, maxX),
      y: Math.min(30 + offset, maxY),
      width: Math.min(w, window.innerWidth - 40),
      height: Math.min(h, window.innerHeight - 80),
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

  const dragRef = useRef<{
    windowId: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const resizeRef = useRef<{
    windowId: string;
    startX: number;
    startY: number;
    origW: number;
    origH: number;
  } | null>(null);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (dragRef.current) {
      const { windowId, startX, startY, origX, origY } = dragRef.current;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      setWindows((prev) =>
        prev.map((w) => (w.id === windowId ? { ...w, x: origX + dx, y: origY + dy } : w)),
      );
    }
    if (resizeRef.current) {
      const { windowId, startX, startY, origW, origH } = resizeRef.current;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      setWindows((prev) =>
        prev.map((w) =>
          w.id === windowId
            ? { ...w, width: Math.max(320, origW + dx), height: Math.max(200, origH + dy) }
            : w,
        ),
      );
    }
  }, []);

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
    resizeRef.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  function startDrag(e: React.MouseEvent, windowId: string) {
    const win = windows.find((w) => w.id === windowId);
    if (!win) return;
    dragRef.current = {
      windowId,
      startX: e.clientX,
      startY: e.clientY,
      origX: win.x,
      origY: win.y,
    };
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    bringToFront(windowId);
  }

  function startResize(e: React.MouseEvent, windowId: string) {
    e.stopPropagation();
    const win = windows.find((w) => w.id === windowId);
    if (!win) return;
    resizeRef.current = {
      windowId,
      startX: e.clientX,
      startY: e.clientY,
      origW: win.width,
      origH: win.height,
    };
    document.body.style.cursor = 'nwse-resize';
    document.body.style.userSelect = 'none';
    bringToFront(windowId);
  }

  return (
    <div
      className="h-screen w-screen flex flex-col overflow-hidden"
      style={{
        backgroundImage: 'url(/icons/wallpaper.png)',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
    >
      {/* Desktop Area */}
      <div className="flex-1 relative overflow-hidden">
        {/* Desktop Icons */}
        <div
          className="absolute top-6 left-6 grid grid-cols-2 gap-x-6 gap-y-4"
          style={{ zIndex: 1 }}
        >
          {Object.entries(APP_REGISTRY).map(([id, app]) => (
            <button
              key={id}
              onDoubleClick={() => openApp(id)}
              className="flex flex-col items-center gap-1.5 w-20 p-2 rounded-xl hover:bg-white/15 transition-colors group"
            >
              <div
                className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform overflow-hidden"
                style={{ backgroundColor: 'rgba(30,30,30,0.6)', backdropFilter: 'blur(8px)' }}
              >
                {app.iconImg ? (
                  <img
                    src={app.iconImg}
                    alt={app.title}
                    className="w-full h-full object-cover rounded-2xl"
                  />
                ) : (
                  <span className="text-xl">{app.icon}</span>
                )}
              </div>
              <span
                className="text-[11px] font-medium text-center leading-tight"
                style={{ color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}
              >
                {app.title}
              </span>
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
                  backgroundColor: '#1C1C1E',
                  border: '1px solid rgba(255,255,255,0.1)',
                }}
                className="rounded-xl shadow-2xl flex flex-col overflow-hidden"
                onMouseDown={() => bringToFront(win.id)}
              >
                {/* Title Bar (draggable) */}
                <div
                  className="h-9 flex items-center justify-between px-3 flex-shrink-0 cursor-grab active:cursor-grabbing select-none"
                  style={{
                    backgroundColor: '#1C1C1E',
                    borderBottom: '1px solid rgba(255,255,255,0.08)',
                  }}
                  onMouseDown={(e) => startDrag(e, win.id)}
                >
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => closeWindow(win.id)}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="w-3 h-3 rounded-full hover:brightness-110 transition"
                      style={{ backgroundColor: '#FF5F57' }}
                    />
                    <button
                      onClick={() => minimizeWindow(win.id)}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="w-3 h-3 rounded-full hover:brightness-110 transition"
                      style={{ backgroundColor: '#FEBC2E' }}
                    />
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#28C840' }} />
                  </div>
                  <div className="flex items-center gap-2">
                    {APP_REGISTRY[win.app]?.iconImg ? (
                      <img src={APP_REGISTRY[win.app].iconImg} alt="" className="w-4 h-4 rounded" />
                    ) : (
                      <span className="text-xs">{APP_REGISTRY[win.app]?.icon}</span>
                    )}
                    <span className="text-xs text-gray-300 font-medium">{win.title}</span>
                  </div>
                  <div className="w-[52px]" />
                </div>

                {/* Window Content */}
                <div className="flex-1 overflow-hidden">
                  <AppComponent />
                </div>

                {/* Resize Handle - bottom edge */}
                <div
                  className="absolute bottom-0 left-0 right-0 h-2 cursor-ns-resize"
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    startResize(e, win.id);
                  }}
                  style={{ zIndex: 10 }}
                />
                {/* Resize Handle - right edge */}
                <div
                  className="absolute top-0 right-0 bottom-0 w-2 cursor-ew-resize"
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    startResize(e, win.id);
                  }}
                  style={{ zIndex: 10 }}
                />
                {/* Resize Handle - corner */}
                <div
                  className="absolute bottom-0 right-0 w-5 h-5 cursor-nwse-resize"
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    startResize(e, win.id);
                  }}
                  style={{ zIndex: 11 }}
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 12 12"
                    className="absolute bottom-1 right-1 opacity-60"
                  >
                    <path
                      d="M11 1L1 11M11 5L5 11M11 9L9 11"
                      stroke="#9CA3AF"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
              </div>
            );
          })}
      </div>

      {/* Taskbar */}
      <div
        className="h-12 flex items-center px-3 gap-1"
        style={{
          backgroundColor: 'rgba(28,28,30,0.85)',
          backdropFilter: 'blur(20px)',
          borderTop: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <button
          onClick={() => navigate(`/sim/${sessionId}/device/home`)}
          className="px-3 py-1.5 text-[11px] text-gray-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors font-medium"
        >
          📱 Phone
        </button>
        <div className="w-px h-6 mx-1" style={{ backgroundColor: 'rgba(255,255,255,0.1)' }} />
        {Object.entries(APP_REGISTRY).map(([id, app]) => (
          <button
            key={id}
            onClick={() => openApp(id)}
            className={`px-2.5 py-1.5 text-[11px] rounded-lg transition-colors flex items-center gap-1.5 font-medium ${
              windows.some((w) => w.app === id)
                ? 'text-white'
                : 'text-gray-400 hover:text-white hover:bg-white/10'
            }`}
            style={
              windows.some((w) => w.app === id) ? { backgroundColor: 'rgba(255,255,255,0.12)' } : {}
            }
          >
            {app.iconImg ? (
              <img src={app.iconImg} alt="" className="w-4 h-4 rounded" />
            ) : (
              <span>{app.icon}</span>
            )}
            {app.title}
          </button>
        ))}
        <div className="flex-1" />
        <span className="text-[11px] font-medium" style={{ color: 'rgba(255,255,255,0.5)' }}>
          {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
    </div>
  );
}
