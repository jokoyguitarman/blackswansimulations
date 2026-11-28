/**
 * Session gate for social reads and the concluded-session write freeze.
 * Routes call these and return when the result is null (the response is already sent).
 */

import type { Response } from 'express';
import { assertSessionAccess, type AccessUser } from './access.js';
import { supabaseAdmin } from './supabaseAdmin.js';
import { getControlledOrgPage } from '../services/orgPageService.js';
import { isSessionStaff, pageHandlesForInbox, playerWriteBlock } from './socialAccess.js';

export interface SocialSession {
  id: string;
  trainer_id: string | null;
  status: string | null;
}

const SESSION_COLUMNS = 'id, trainer_id, status';

function asSession(
  row: { id?: unknown; trainer_id?: unknown; status?: unknown } | undefined,
): SocialSession | null {
  if (!row || typeof row.id !== 'string') return null;
  return {
    id: row.id,
    trainer_id: typeof row.trainer_id === 'string' ? row.trainer_id : null,
    status: typeof row.status === 'string' ? row.status : null,
  };
}

/** Admin, the trainer who ran the session, or a participant. */
export async function requireSocialRead(
  res: Response,
  sessionId: string | null | undefined,
  user: AccessUser,
): Promise<SocialSession | null> {
  const access = await assertSessionAccess(sessionId, user, SESSION_COLUMNS);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return null;
  }
  const session = asSession(access.session);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return null;
  }
  return session;
}

/** Same people as a read, and players cannot write once the session has ended. */
export async function requirePlayerWrite(
  res: Response,
  sessionId: string | null | undefined,
  user: AccessUser,
): Promise<SocialSession | null> {
  const session = await requireSocialRead(res, sessionId, user);
  if (!session) return null;
  const block = playerWriteBlock(user, session);
  if (block) {
    res.status(block.status).json({ error: block.error, code: block.code });
    return null;
  }
  return session;
}

/** Admin or the trainer who ran this session. Other trainers are refused. */
export async function requireSocialStaff(
  res: Response,
  sessionId: string | null | undefined,
  user: AccessUser,
): Promise<SocialSession | null> {
  const session = await requireSocialRead(res, sessionId, user);
  if (!session) return null;
  if (!isSessionStaff(user, session)) {
    res.status(403).json({ error: 'Access denied' });
    return null;
  }
  return session;
}

/**
 * Page handles this caller may see in messenger.
 * Players: the page they control on this platform, or none.
 * Staff: every org page on this platform in the session.
 */
export async function loadInboxPageHandles(
  sessionId: string,
  user: AccessUser,
  session: { trainer_id: string | null },
  platform: string,
): Promise<string[]> {
  const staff = isSessionStaff(user, session);
  if (staff) {
    const { data } = await supabaseAdmin
      .from('sim_org_pages')
      .select('page_handle')
      .eq('session_id', sessionId)
      .eq('platform', platform);
    return pageHandlesForInbox({
      staff: true,
      controlledHandles: [],
      sessionPageHandles: (data ?? []).map((row) =>
        String((row as { page_handle?: string }).page_handle ?? ''),
      ),
    });
  }
  const controlled = await getControlledOrgPage(sessionId, user.id, platform);
  return pageHandlesForInbox({
    staff: false,
    controlledHandles: controlled?.page_handle ? [controlled.page_handle] : [],
    sessionPageHandles: [],
  });
}
