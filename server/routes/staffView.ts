import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { canSpectate } from '../lib/socialAccess.js';
import { loadSocialSession } from '../lib/socialSessionGuard.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { listStaffViews } from '../lib/staffViewAudit.js';
import { displayNameOf } from '../lib/identity.js';
import { staffViewAsEnabled, VIEW_AS_DENIED } from '../lib/viewerDecision.js';
import { viewedByLabels, type ViewerProfile } from '../lib/viewerSubject.js';
import { loadViewerSubject } from '../middleware/viewer.js';
import { logger } from '../lib/logger.js';

const router = Router();

const uuid = z.string().uuid();

export interface ViewAsPlayerName {
  user_id: string;
  name: string;
}

/**
 * Staff view-as capability. 404 while ENABLE_STAFF_VIEW_AS is off, before any
 * session read, so the trainer console can probe and hide.
 * Admins also receive "Viewed by". A missing audit table leaves that list empty.
 */
router.get('/:id/staff-view', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (!staffViewAsEnabled()) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const parsed = uuid.safeParse(req.params.id);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed' });
    return;
  }
  const sessionId = parsed.data;
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: 'Missing authorization header' });
    return;
  }

  try {
    const loaded = await loadSocialSession(sessionId);
    if (loaded.kind === 'error') {
      res.status(500).json({ error: 'Internal server error' });
      return;
    }
    if (loaded.kind === 'missing') {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (!canSpectate(user, loaded.session)) {
      res.status(403).json({
        error: 'You cannot view this session',
        code: VIEW_AS_DENIED,
      });
      return;
    }

    const players = await listPlayerNames(sessionId);
    const viewedBy = user.role === 'admin' ? await adminViewedBy(sessionId) : [];
    res.json({ data: { players, viewed_by: viewedBy } });
  } catch (err) {
    logger.error({ err, sessionId }, 'Staff view roster failed');
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

async function listPlayerNames(sessionId: string): Promise<ViewAsPlayerName[]> {
  const { data, error } = await supabaseAdmin
    .from('session_participants')
    .select('user_id')
    .eq('session_id', sessionId);
  if (error) throw error;
  const ids = (data ?? [])
    .map((row) => row.user_id)
    .filter((id): id is string => typeof id === 'string');
  if (ids.length === 0) return [];

  const { data: profiles, error: profileError } = await supabaseAdmin
    .from('user_profiles')
    .select('id, role, agency_name, full_name')
    .in('id', ids);
  if (profileError) throw profileError;

  const byId = new Map<string, ViewerProfile>();
  for (const row of profiles ?? []) {
    if (typeof row.id !== 'string') continue;
    byId.set(row.id, {
      role: typeof row.role === 'string' ? row.role : null,
      agency_name: typeof row.agency_name === 'string' ? row.agency_name : null,
      full_name: typeof row.full_name === 'string' ? row.full_name : null,
    });
  }

  const players: ViewAsPlayerName[] = [];
  for (const id of ids) {
    const profile = byId.get(id) ?? null;
    const profileName = profile?.full_name?.trim() ?? '';
    const name = profileName ? profileName : displayNameOf(await loadViewerSubject(id));
    players.push({ user_id: id, name });
  }
  return players;
}

async function adminViewedBy(sessionId: string): Promise<string[]> {
  const stamps = await listStaffViews(sessionId);
  if (stamps.length === 0) return [];
  const ids = [...new Set(stamps.map((row) => row.staffUserId))];
  const { data, error } = await supabaseAdmin
    .from('user_profiles')
    .select('id, full_name')
    .in('id', ids);
  if (error) return viewedByLabels(stamps, new Map());
  const names = new Map<string, string>();
  for (const row of data ?? []) {
    if (typeof row.id !== 'string') continue;
    const fullName = typeof row.full_name === 'string' ? row.full_name.trim() : '';
    if (fullName) names.set(row.id, fullName);
  }
  return viewedByLabels(stamps, names);
}

export const staffViewRouter = router;
