/**
 * Cross-app intents inside the simulated device.
 *
 * On the phone, apps are routes and intents travel as query params (?compose_to=…, ?channel=…).
 * On the desktop, apps are windows rendered without props, so an intent is parked here and the
 * shell is asked (via a DOM event) to open the window; the app consumes the intent on mount.
 *
 * `openAppWithIntent` picks the right mechanism from the current pathname.
 */
export type AppIntentParams = Record<string, string>;

const pending = new Map<string, AppIntentParams>();

export const DESKTOP_OPEN_APP_EVENT = 'sim:desktop-open-app';

export function setAppIntent(appId: string, params: AppIntentParams): void {
  pending.set(appId, params);
}

/** Read-and-clear. */
export function consumeAppIntent(appId: string): AppIntentParams | null {
  const p = pending.get(appId) ?? null;
  pending.delete(appId);
  return p;
}

export function isDesktopPath(pathname: string): boolean {
  return pathname.includes('/desktop');
}

/**
 * @param navigate  react-router navigate
 * @param base      `/sim/:sessionId` prefix
 */
export function openAppWithIntent(
  navigate: (to: string) => void,
  base: string,
  pathname: string,
  appId: string,
  params: AppIntentParams,
): void {
  if (isDesktopPath(pathname)) {
    setAppIntent(appId, params);
    window.dispatchEvent(new CustomEvent(DESKTOP_OPEN_APP_EVENT, { detail: { appId } }));
    return;
  }
  const qs = new URLSearchParams(params).toString();
  navigate(`${base}/device/${appId}${qs ? `?${qs}` : ''}`);
}

/** Intent params from the query string (phone) or the parked intent (desktop). */
export function readAppIntent(appId: string, search: string): AppIntentParams | null {
  const fromQuery = new URLSearchParams(search);
  const params: AppIntentParams = {};
  fromQuery.forEach((v, k) => {
    params[k] = v;
  });
  if (Object.keys(params).length > 0) return params;
  return consumeAppIntent(appId);
}
