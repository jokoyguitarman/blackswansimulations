import { parseAuthLinkError, type AuthLinkError } from '@shared/authLinkError';

const STORAGE_KEY = 'prophyion_auth_link_error';
const ERROR_PARAMS = ['error', 'error_code', 'error_description'];

/**
 * Supabase reports an email link it will not honour (expired, or already used) in the address, and
 * the app's own redirects would drop it before anyone read it. main.tsx imports this first, before
 * the Supabase client starts up, so the error is kept for the sign-in page and the address is
 * cleaned.
 */
function captureFromAddress(): void {
  try {
    const found = parseAuthLinkError(window.location.hash, window.location.search);
    if (!found) return;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(found));
    const url = new URL(window.location.href);
    for (const key of ERROR_PARAMS) url.searchParams.delete(key);
    window.history.replaceState(null, '', url.pathname + url.search);
  } catch {
    // Storage or history unavailable: the person just does not see the notice.
  }
}

captureFromAddress();

/** The bad-link error captured when this page loaded, if any. */
export function readAuthLinkError(): AuthLinkError | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthLinkError) : null;
  } catch {
    return null;
  }
}

export function clearAuthLinkError(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}
