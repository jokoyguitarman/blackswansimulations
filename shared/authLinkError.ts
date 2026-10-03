/**
 * Errors Supabase puts in the address when someone follows an email link it will not honour, for
 * example `/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`.
 * Shared so the rule can be tested; the app reads it before anything else touches the address.
 */

export interface AuthLinkError {
  code: string | null;
  description: string | null;
  /** The link has expired or was already used. Supabase reports both the same way. */
  expired: boolean;
}

/**
 * Read an email-link error from the address hash and query string, or null when there is none.
 * Requires an error code or description alongside `error`, so an unrelated `?error=` on some other
 * page is not mistaken for one.
 */
export function parseAuthLinkError(hash: string, search: string): AuthLinkError | null {
  const params = new URLSearchParams(search.replace(/^\?/, ''));
  for (const [key, value] of new URLSearchParams(hash.replace(/^#/, ''))) params.set(key, value);

  const error = params.get('error');
  const code = params.get('error_code');
  const description = params.get('error_description');
  if (!error || (!code && !description)) return null;

  return {
    code,
    description,
    expired: code === 'otp_expired' || /expired/i.test(description ?? ''),
  };
}
