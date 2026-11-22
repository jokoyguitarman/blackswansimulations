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
    const ref = options.confirmProject;
    if (!ref || !url.includes(ref)) {
      throw new SafetyError('shared target requires --confirm-project matching the database URL');
    }
    return { url, target: 'shared' };
  }
  if (!isLocalDatabase(url)) {
    throw new SafetyError('KNOWLEDGE_DB_URL is not a local database');
  }
  return { url, target: 'local' };
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
