/** Refusals that exit 3 before a connection is opened. Spec sections 4.4 and 10.2. */

export class SafetyError extends Error {
  readonly exitCode = 3 as const;
}

export interface DbTarget {
  url: string;
  target: 'local' | 'shared';
}

export function resolveDbTarget(options: { apply: boolean; confirmProject?: string }): DbTarget {
  const url = process.env.KNOWLEDGE_DB_URL;
  if (!url) throw new SafetyError('KNOWLEDGE_DB_URL is not set');
  const requested = process.env.KNOWLEDGE_TARGET;
  if (options.apply && requested !== 'local' && requested !== 'shared') {
    throw new SafetyError('--apply requires KNOWLEDGE_TARGET=local or KNOWLEDGE_TARGET=shared');
  }
  if (requested === 'shared') {
    const ref = options.confirmProject ?? '';
    if (!confirmProjectMatches(url, ref)) {
      throw new SafetyError(
        'shared target requires --confirm-project equal to the project ref in the database host (db.<ref>.supabase.co) or the pooler user (postgres.<ref>)',
      );
    }
    return { url, target: 'shared' };
  }
  if (!isLocalDatabase(url)) {
    throw new SafetyError('KNOWLEDGE_DB_URL is not a local database');
  }
  return { url, target: 'local' };
}

/** True when `ref` is the project ref in `db.<ref>.supabase.co` or the user `postgres.<ref>`. */
export function confirmProjectMatches(url: string, ref: string): boolean {
  if (!ref || /\s/.test(ref)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const wanted = ref.toLowerCase();
  if (parsed.hostname.toLowerCase() === `db.${wanted}.supabase.co`) return true;
  let user = parsed.username;
  try {
    user = decodeURIComponent(parsed.username);
  } catch {
    user = parsed.username;
  }
  return user.toLowerCase() === `postgres.${wanted}`;
}

export function redact(message: string): string {
  const url = process.env.KNOWLEDGE_DB_URL;
  const hidden = url ? message.split(url).join('[redacted]') : message;
  return hidden.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted]');
}

export function isLocalDatabase(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}
