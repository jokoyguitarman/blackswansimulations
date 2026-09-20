/**
 * Device-aware navigation for the simulated apps (docs/session-bugfix-spec-2026-09-20.md §7).
 *
 * The same app components render as full-screen routes on the phone (`/sim/:id/device/<app>`) and
 * as windows on the desktop (`/sim/:id/desktop`). "Home", "Back out of the app" and cross-app links
 * therefore mean different things: on the phone they navigate; on the desktop they must close the
 * window or open another window — never navigate, which would drop the player into phone mode.
 * The only way to leave the desktop is the explicit "mobile view" control in the shell.
 */
import { useCallback, useMemo } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { isDesktopPath, openAppWithIntent, type AppIntentParams } from './appIntents';

export const DESKTOP_CLOSE_APP_EVENT = 'sim:desktop-close-app';

export interface DeviceNav {
  isDesktop: boolean;
  /** `/sim/:sessionId` */
  base: string;
  /** Phone: go to the home screen. Desktop: close this app's window. */
  goHome: () => void;
  /** Phone: navigate to the app (query params carry the intent). Desktop: open/raise its window. */
  openApp: (appId: string, params?: AppIntentParams) => void;
}

export function useDeviceNav(appId: string): DeviceNav {
  const navigate = useNavigate();
  const location = useLocation();
  const { sessionId } = useParams<{ sessionId: string }>();
  const isDesktop = isDesktopPath(location.pathname);
  const base = `/sim/${sessionId ?? ''}`;

  const goHome = useCallback(() => {
    if (isDesktop) {
      window.dispatchEvent(new CustomEvent(DESKTOP_CLOSE_APP_EVENT, { detail: { appId } }));
      return;
    }
    navigate(`${base}/device/home`);
  }, [appId, base, isDesktop, navigate]);

  const openApp = useCallback(
    (target: string, params: AppIntentParams = {}) =>
      openAppWithIntent(navigate, base, location.pathname, target, params),
    [base, location.pathname, navigate],
  );

  return useMemo(() => ({ isDesktop, base, goHome, openApp }), [isDesktop, base, goHome, openApp]);
}
