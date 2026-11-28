/**
 * Who may read a social session, and which page inboxes they may open.
 *
 * Players belong to one session and see only the organisation pages they control.
 * A trainer sees the sessions they ran. An admin sees every session.
 * No Supabase here: routes load the session, then call these checks.
 */

export interface SocialActor {
  id: string;
  role?: string | null;
}

export interface SocialSessionRef {
  trainer_id?: string | null;
  status?: string | null;
}

export const SESSION_CONCLUDED_CODE = 'SESSION_CONCLUDED';

export const SESSION_CONCLUDED_ERROR =
  'This session has ended. Players can no longer post, comment, message, email, or act as a page.';

const CONCLUDED = new Set(['completed', 'cancelled']);

/** Owning trainer or an admin. Any other trainer is not staff for this session. */
export function isSessionStaff(user: SocialActor, session: SocialSessionRef): boolean {
  return user.role === 'admin' || (!!user.id && session.trainer_id === user.id);
}

export function isConcludedStatus(status: string | null | undefined): boolean {
  return !!status && CONCLUDED.has(status);
}

/** Default on. Set CONCLUDED_SESSION_WRITE_FREEZE=false to allow player writes after the end. */
export function concludedWriteFreezeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONCLUDED_SESSION_WRITE_FREEZE !== 'false';
}

export interface ConcludedWriteBlock {
  status: 409;
  code: typeof SESSION_CONCLUDED_CODE;
  error: string;
}

/**
 * Player writes on a completed or cancelled session.
 * The session's trainer and admins are not blocked (their reads are unaffected either way).
 */
export function playerWriteBlock(
  user: SocialActor,
  session: SocialSessionRef,
  env: NodeJS.ProcessEnv = process.env,
): ConcludedWriteBlock | null {
  if (!concludedWriteFreezeEnabled(env)) return null;
  if (!isConcludedStatus(session.status)) return null;
  if (isSessionStaff(user, session)) return null;
  return { status: 409, code: SESSION_CONCLUDED_CODE, error: SESSION_CONCLUDED_ERROR };
}

/** Drop handles that could break out of a quoted PostgREST filter. */
export function safeSocialHandle(handle: string | null | undefined): string | null {
  if (typeof handle !== 'string') return null;
  const trimmed = handle.trim();
  if (!trimmed || /["\\]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Page handles merged into a messenger inbox.
 * Players get the pages they control, never "whatever page was inserted first".
 * Session staff get every page in the session.
 */
export function pageHandlesForInbox(input: {
  staff: boolean;
  controlledHandles: Array<string | null | undefined>;
  sessionPageHandles: Array<string | null | undefined>;
}): string[] {
  const source = input.staff ? input.sessionPageHandles : input.controlledHandles;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const handle of source) {
    const safe = safeSocialHandle(handle);
    if (!safe || seen.has(safe)) continue;
    seen.add(safe);
    out.push(safe);
  }
  return out;
}

/** PostgREST `.or()` clause for personal threads plus the allowed page inboxes. */
export function messengerHandleFilter(playerHandle: string, pageHandles: string[]): string {
  const handles: string[] = [];
  const player = safeSocialHandle(playerHandle);
  if (player) handles.push(player);
  for (const handle of pageHandles) {
    const safe = safeSocialHandle(handle);
    if (safe && !handles.includes(safe)) handles.push(safe);
  }
  const parts: string[] = [];
  for (const handle of handles) {
    parts.push(`sender_handle.eq."${handle}"`, `recipient_handle.eq."${handle}"`);
  }
  return parts.join(',');
}

/** A direct thread is visible when the caller is staff, or a party, or controls the page. */
export function directThreadVisible(input: {
  staff: boolean;
  playerHandle: string;
  pageHandles: string[];
  senderHandle: string | null | undefined;
  recipientHandle: string | null | undefined;
}): boolean {
  if (input.staff) return true;
  const allowed = new Set<string>();
  const player = safeSocialHandle(input.playerHandle);
  if (player) allowed.add(player);
  for (const handle of input.pageHandles) {
    const safe = safeSocialHandle(handle);
    if (safe) allowed.add(safe);
  }
  const sender = input.senderHandle ?? '';
  const recipient = input.recipientHandle ?? '';
  return allowed.has(sender) || allowed.has(recipient);
}
