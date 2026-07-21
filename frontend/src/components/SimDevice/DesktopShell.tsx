import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import FacebookFeedApp from './FacebookFeedApp';
import EmailApp from './EmailApp';
import NewsApp from './NewsApp';
import GroupChatApp from './GroupChatApp';
import { WordAppDesktop } from './WordApp/WordApp';
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
  maximized: boolean;
}

const MIN_WIDTH = 320;
const MIN_HEIGHT = 200;
const TITLE_BAR_HEIGHT = 36;

// Show mac traffic lights on Apple devices, Windows-style caption buttons everywhere else
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/i.test(navigator.userAgent);

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
  drafts: {
    title: 'Docs',
    icon: 'W',
    iconImg: '/icons/icon-docs.svg',
    component: WordAppDesktop,
    defaultWidth: 1000,
    defaultHeight: 680,
  },
};

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const RESIZE_CURSORS: Record<ResizeDir, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

// Hit areas for resizing. Top corners are kept small so they don't eat clicks
// meant for the caption buttons in the title bar.
const RESIZE_HANDLES: { dir: ResizeDir; className: string }[] = [
  { dir: 'n', className: 'top-0 left-2 right-2 h-1 cursor-ns-resize' },
  { dir: 's', className: 'bottom-0 left-3 right-3 h-1.5 cursor-ns-resize' },
  { dir: 'w', className: 'left-0 top-2 bottom-3 w-1.5 cursor-ew-resize' },
  { dir: 'e', className: 'right-0 top-2 bottom-3 w-1.5 cursor-ew-resize' },
  { dir: 'nw', className: 'top-0 left-0 w-2 h-2 cursor-nwse-resize' },
  { dir: 'ne', className: 'top-0 right-0 w-2 h-2 cursor-nesw-resize' },
  { dir: 'sw', className: 'bottom-0 left-0 w-3 h-3 cursor-nesw-resize' },
  { dir: 'se', className: 'bottom-0 right-0 w-4 h-4 cursor-nwse-resize' },
];

// Memoized so app content doesn't re-render on every mousemove while dragging/resizing
const WindowContent = React.memo(function WindowContent({ appId }: { appId: string }) {
  const AppComponent = APP_REGISTRY[appId]?.component;
  if (!AppComponent) return null;
  return <AppComponent />;
});

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

  const desktopRef = useRef<HTMLDivElement>(null);

  const getDesktopSize = useCallback(() => {
    return {
      w: desktopRef.current?.clientWidth ?? window.innerWidth,
      h: desktopRef.current?.clientHeight ?? window.innerHeight - 48,
    };
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
      maximized: false,
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

  function toggleMaximize(windowId: string) {
    setWindows((prev) =>
      prev.map((w) => (w.id === windowId ? { ...w, maximized: !w.maximized } : w)),
    );
    bringToFront(windowId);
  }

  function bringToFront(windowId: string) {
    setWindows((prev) => prev.map((w) => (w.id === windowId ? { ...w, zIndex: nextZ } : w)));
    setNextZ((z) => z + 1);
  }

  // Windows-style taskbar behavior: click opens, focuses, or minimizes the focused app
  function handleTaskbarClick(appId: string) {
    const win = windows.find((w) => w.app === appId);
    if (!win || win.minimized) {
      openApp(appId);
      return;
    }
    const visible = windows.filter((w) => !w.minimized);
    const topZ = Math.max(...visible.map((w) => w.zIndex));
    if (win.zIndex === topZ) {
      minimizeWindow(win.id);
    } else {
      bringToFront(win.id);
    }
  }

  const dragRef = useRef<{
    windowId: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    // Set when dragging a maximized window: restore it once the pointer actually moves
    restorePending?: { width: number };
  } | null>(null);
  const resizeRef = useRef<{
    windowId: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
    dir: ResizeDir;
  } | null>(null);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (dragRef.current) {
        const drag = dragRef.current;
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;

        if (drag.restorePending) {
          // Ignore accidental jitter; a plain click on the title bar shouldn't un-maximize
          if (Math.abs(dx) + Math.abs(dy) < 5) return;
          const { w: dw } = getDesktopSize();
          const width = drag.restorePending.width;
          // Restore under the cursor, keeping its relative position on the title bar
          const newX = Math.round(e.clientX - width * (e.clientX / Math.max(1, dw)));
          const newY = Math.max(0, e.clientY - TITLE_BAR_HEIGHT / 2);
          setWindows((prev) =>
            prev.map((w) =>
              w.id === drag.windowId ? { ...w, maximized: false, x: newX, y: newY } : w,
            ),
          );
          dragRef.current = {
            windowId: drag.windowId,
            startX: e.clientX,
            startY: e.clientY,
            origX: newX,
            origY: newY,
          };
          return;
        }

        const { w: dw, h: dh } = getDesktopSize();
        setWindows((prev) =>
          prev.map((w) => {
            if (w.id !== drag.windowId) return w;
            // Keep at least part of the title bar reachable
            const newX = Math.min(Math.max(drag.origX + dx, -(w.width - 80)), dw - 80);
            const newY = Math.min(Math.max(drag.origY + dy, 0), dh - TITLE_BAR_HEIGHT);
            return { ...w, x: newX, y: newY };
          }),
        );
      }
      if (resizeRef.current) {
        const { windowId, startX, startY, origX, origY, origW, origH, dir } = resizeRef.current;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        setWindows((prev) =>
          prev.map((w) => {
            if (w.id !== windowId) return w;
            let { x, y, width, height } = { x: origX, y: origY, width: origW, height: origH };
            if (dir.includes('e')) width = Math.max(MIN_WIDTH, origW + dx);
            if (dir.includes('s')) height = Math.max(MIN_HEIGHT, origH + dy);
            if (dir.includes('w')) {
              width = Math.max(MIN_WIDTH, origW - dx);
              x = origX + origW - width;
            }
            if (dir.includes('n')) {
              height = Math.max(MIN_HEIGHT, origH - dy);
              y = origY + origH - height;
              if (y < 0) {
                height += y;
                y = 0;
              }
            }
            return { ...w, x, y, width, height };
          }),
        );
      }
    },
    [getDesktopSize],
  );

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
    // Only the primary button drags
    if (e.button !== 0) return;
    const win = windows.find((w) => w.id === windowId);
    if (!win) return;
    dragRef.current = {
      windowId,
      startX: e.clientX,
      startY: e.clientY,
      origX: win.x,
      origY: win.y,
      restorePending: win.maximized ? { width: win.width } : undefined,
    };
    document.body.style.cursor = IS_MAC ? 'grabbing' : 'default';
    document.body.style.userSelect = 'none';
    bringToFront(windowId);
  }

  function startResize(e: React.MouseEvent, windowId: string, dir: ResizeDir) {
    e.stopPropagation();
    if (e.button !== 0) return;
    const win = windows.find((w) => w.id === windowId);
    if (!win || win.maximized) return;
    resizeRef.current = {
      windowId,
      startX: e.clientX,
      startY: e.clientY,
      origX: win.x,
      origY: win.y,
      origW: win.width,
      origH: win.height,
      dir,
    };
    document.body.style.cursor = RESIZE_CURSORS[dir];
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
      <div ref={desktopRef} className="flex-1 relative overflow-hidden">
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
            if (!APP_REGISTRY[win.app]) return null;
            const appDef = APP_REGISTRY[win.app];

            return (
              <div
                key={win.id}
                style={
                  win.maximized
                    ? {
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        right: 0,
                        bottom: 0,
                        zIndex: win.zIndex,
                        backgroundColor: '#1C1C1E',
                      }
                    : {
                        position: 'absolute',
                        left: win.x,
                        top: win.y,
                        width: win.width,
                        height: win.height,
                        zIndex: win.zIndex,
                        backgroundColor: '#1C1C1E',
                        border: '1px solid rgba(255,255,255,0.1)',
                      }
                }
                className={`${win.maximized ? '' : 'rounded-xl'} shadow-2xl flex flex-col overflow-hidden`}
                onMouseDown={() => bringToFront(win.id)}
              >
                {/* Title Bar (drag to move, double-click to maximize/restore) */}
                <div
                  className={`h-9 flex items-center flex-shrink-0 select-none pl-3 ${
                    IS_MAC ? 'pr-3 cursor-grab active:cursor-grabbing' : 'cursor-default'
                  }`}
                  style={{
                    backgroundColor: '#1C1C1E',
                    borderBottom: '1px solid rgba(255,255,255,0.08)',
                  }}
                  onMouseDown={(e) => startDrag(e, win.id)}
                  onDoubleClick={() => toggleMaximize(win.id)}
                >
                  {IS_MAC ? (
                    <>
                      {/* macOS traffic lights */}
                      <div
                        className="flex items-center gap-1.5 group/tl"
                        onMouseDown={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                      >
                        <button
                          title="Close"
                          onClick={() => closeWindow(win.id)}
                          className="w-3 h-3 rounded-full hover:brightness-110 transition flex items-center justify-center"
                          style={{ backgroundColor: '#FF5F57' }}
                        >
                          <svg
                            width="8"
                            height="8"
                            viewBox="0 0 10 10"
                            className="opacity-0 group-hover/tl:opacity-100 transition-opacity"
                          >
                            <path
                              d="M2.5 2.5l5 5M7.5 2.5l-5 5"
                              stroke="rgba(0,0,0,0.6)"
                              strokeWidth="1.4"
                              strokeLinecap="round"
                            />
                          </svg>
                        </button>
                        <button
                          title="Minimize"
                          onClick={() => minimizeWindow(win.id)}
                          className="w-3 h-3 rounded-full hover:brightness-110 transition flex items-center justify-center"
                          style={{ backgroundColor: '#FEBC2E' }}
                        >
                          <svg
                            width="8"
                            height="8"
                            viewBox="0 0 10 10"
                            className="opacity-0 group-hover/tl:opacity-100 transition-opacity"
                          >
                            <path
                              d="M2 5h6"
                              stroke="rgba(0,0,0,0.6)"
                              strokeWidth="1.4"
                              strokeLinecap="round"
                            />
                          </svg>
                        </button>
                        <button
                          title={win.maximized ? 'Restore' : 'Maximize'}
                          onClick={() => toggleMaximize(win.id)}
                          className="w-3 h-3 rounded-full hover:brightness-110 transition flex items-center justify-center"
                          style={{ backgroundColor: '#28C840' }}
                        >
                          <svg
                            width="8"
                            height="8"
                            viewBox="0 0 10 10"
                            className="opacity-0 group-hover/tl:opacity-100 transition-opacity"
                          >
                            <path
                              d="M5 2v6M2 5h6"
                              stroke="rgba(0,0,0,0.6)"
                              strokeWidth="1.4"
                              strokeLinecap="round"
                            />
                          </svg>
                        </button>
                      </div>
                      <div className="flex-1 flex items-center justify-center gap-2 min-w-0">
                        {appDef.iconImg ? (
                          <img src={appDef.iconImg} alt="" className="w-4 h-4 rounded" />
                        ) : (
                          <span className="text-xs">{appDef.icon}</span>
                        )}
                        <span className="text-xs text-gray-300 font-medium truncate">
                          {win.title}
                        </span>
                      </div>
                      <div className="w-[52px] flex-shrink-0" />
                    </>
                  ) : (
                    <>
                      {/* Windows-style: icon + title on the left, caption buttons on the right */}
                      <div className="flex items-center gap-2 min-w-0">
                        {appDef.iconImg ? (
                          <img src={appDef.iconImg} alt="" className="w-4 h-4 rounded" />
                        ) : (
                          <span className="text-xs">{appDef.icon}</span>
                        )}
                        <span className="text-xs text-gray-300 font-medium truncate">
                          {win.title}
                        </span>
                      </div>
                      <div className="flex-1" />
                      <div
                        className="flex h-full flex-shrink-0"
                        onMouseDown={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                      >
                        <button
                          title="Minimize"
                          onClick={() => minimizeWindow(win.id)}
                          className="w-11 h-full flex items-center justify-center text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
                        >
                          <svg width="10" height="10" viewBox="0 0 10 10">
                            <path d="M1 5.5h8" stroke="currentColor" strokeWidth="1" />
                          </svg>
                        </button>
                        <button
                          title={win.maximized ? 'Restore Down' : 'Maximize'}
                          onClick={() => toggleMaximize(win.id)}
                          className="w-11 h-full flex items-center justify-center text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
                        >
                          {win.maximized ? (
                            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                              <path d="M3 2.5V1h6v6H7.5" stroke="currentColor" strokeWidth="1" />
                              <rect
                                x="1"
                                y="3"
                                width="6"
                                height="6"
                                stroke="currentColor"
                                strokeWidth="1"
                              />
                            </svg>
                          ) : (
                            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                              <rect
                                x="1"
                                y="1"
                                width="8"
                                height="8"
                                stroke="currentColor"
                                strokeWidth="1"
                              />
                            </svg>
                          )}
                        </button>
                        <button
                          title="Close"
                          onClick={() => closeWindow(win.id)}
                          className="w-11 h-full flex items-center justify-center text-gray-300 hover:bg-[#E81123] hover:text-white transition-colors"
                        >
                          <svg width="10" height="10" viewBox="0 0 10 10">
                            <path
                              d="M1 1l8 8M9 1l-8 8"
                              stroke="currentColor"
                              strokeWidth="1"
                              strokeLinecap="round"
                            />
                          </svg>
                        </button>
                      </div>
                    </>
                  )}
                </div>

                {/* Window Content */}
                <div className="flex-1 overflow-hidden">
                  <WindowContent appId={win.app} />
                </div>

                {/* Resize handles (all edges + corners) */}
                {!win.maximized && (
                  <>
                    {RESIZE_HANDLES.map((h) => (
                      <div
                        key={h.dir}
                        className={`absolute ${h.className}`}
                        style={{ zIndex: h.dir.length === 2 ? 11 : 10 }}
                        onMouseDown={(e) => startResize(e, win.id, h.dir)}
                      />
                    ))}
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 12 12"
                      className="absolute bottom-1 right-1 opacity-60 pointer-events-none"
                      style={{ zIndex: 12 }}
                    >
                      <path
                        d="M11 1L1 11M11 5L5 11M11 9L9 11"
                        stroke="#9CA3AF"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  </>
                )}
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
        {Object.entries(APP_REGISTRY).map(([id, app]) => {
          const appWindows = windows.filter((w) => w.app === id);
          const isOpen = appWindows.length > 0;
          const isMinimized = isOpen && appWindows.every((w) => w.minimized);
          return (
            <button
              key={id}
              onClick={() => handleTaskbarClick(id)}
              className={`px-2.5 py-1.5 text-[11px] rounded-lg transition-colors flex items-center gap-1.5 font-medium ${
                isOpen ? 'text-white' : 'text-gray-400 hover:text-white hover:bg-white/10'
              }`}
              style={
                isOpen
                  ? {
                      backgroundColor: isMinimized
                        ? 'rgba(255,255,255,0.06)'
                        : 'rgba(255,255,255,0.12)',
                    }
                  : {}
              }
            >
              {app.iconImg ? (
                <img src={app.iconImg} alt="" className="w-4 h-4 rounded" />
              ) : (
                <span>{app.icon}</span>
              )}
              {app.title}
            </button>
          );
        })}
        <div className="flex-1" />
        <span className="text-[11px] font-medium" style={{ color: 'rgba(255,255,255,0.5)' }}>
          {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
    </div>
  );
}
