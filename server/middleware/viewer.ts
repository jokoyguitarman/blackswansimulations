import type { RequestHandler, Response } from 'express';
import type { AuthenticatedRequest } from './auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { canSpectate } from '../lib/socialAccess.js';
import { recordStaffView } from '../lib/staffViewAudit.js';
import {
  lookupSurfaceRoute,
  type RouterId,
  type SessionBind,
  type SurfaceRoute,
} from '../lib/surfaceRoutes.js';
import {
  VIEW_AS_DENIED,
  VIEW_AS_SESSION_MISMATCH,
  getSideEffectAllowed,
  hasStaffRole,
  isLiveSession,
  isWriteMethod,
  parseViewHeaders,
  spectatorWriteBlock,
  staffPlayerActionBlock,
  type ViewerMode,
} from '../lib/viewerDecision.js';

export type { ViewerMode };
export { getSideEffectAllowed };

const ROUTER = Symbol('staffViewerRouter');

export interface ViewerUser {
  id: string;
  email?: string;
  role?: string;
  agency?: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
}

export interface ViewerContext {
  realUser: ViewerUser;
  subject: ViewerUser | null;
  mode: ViewerMode;
  sessionId: string | null;
}

interface Marked {
  [ROUTER]?: RouterId;
}

type Resolved =
  | { kind: 'none' }
  | { kind: 'absent' }
  | { kind: 'missing' }
  | { kind: 'error' }
  | { kind: 'id'; id: string; staffOverride: boolean };

type LoadedSession =
  | { kind: 'ok'; row: { id: string; trainer_id: string | null; status: string | null } }
  | { kind: 'missing' }
  | { kind: 'error' };

/** Read at call time so a test can prove the flags-off path without reloading the process. */
export function staffViewAsEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  return source.ENABLE_STAFF_VIEW_AS === 'true';
}

export function staffPlayerActionGuardEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  return source.STAFF_PLAYER_ACTION_GUARD === 'true';
}

/**
 * Mount once, ahead of the routes, on every player-surface router.
 * With both flags off this does not read the request and does not query.
 */
export function staffViewer(routerId: RouterId): RequestHandler {
  return (req, _res, next) => {
    if (!staffViewAsEnabled() && !staffPlayerActionGuardEnabled()) {
      next();
      return;
    }
    (req as Marked)[ROUTER] = routerId;
    next();
  };
}

/**
 * Called at the end of `requireAuth`, after `req.user` is the token user.
 * Returns false synchronously when both flags are off (no header read, no query).
 * Returns true once a response has been sent.
 */
export function applyMountedViewer(
  req: AuthenticatedRequest,
  res: Response,
): false | Promise<boolean> {
  if (!staffViewAsEnabled() && !staffPlayerActionGuardEnabled()) return false;
  const routerId = (req as Marked)[ROUTER];
  if (!routerId) return false;
  return enforceViewer(req, res, routerId);
}

async function enforceViewer(
  req: AuthenticatedRequest,
  res: Response,
  routerId: RouterId,
): Promise<boolean> {
  try {
    const user = req.user;
    if (!user) return false;
    const pattern =
      typeof (req as { route?: { path?: string } }).route?.path === 'string'
        ? (req as { route: { path: string } }).route.path
        : req.path;
    const route = lookupSurfaceRoute(routerId, req.method, pattern);
    if (!route) return false;

    if (staffViewAsEnabled()) {
      const headers = parseViewHeaders({
        session: req.get('X-Sim-Session') ?? undefined,
        viewAs: req.get('X-Sim-View-As') ?? undefined,
        spectator: req.get('X-Sim-Spectator') ?? undefined,
      });
      if (headers.type === 'error') {
        res.status(headers.status).json({ error: headers.error, code: headers.code });
        return true;
      }
      if (headers.type === 'view_as' || headers.type === 'spectator') {
        return spectate(req, res, route, user, headers);
      }
    }

    if (
      staffPlayerActionGuardEnabled() &&
      route.class === 'player' &&
      isWriteMethod(req.method) &&
      hasStaffRole(user.role)
    ) {
      return blockStaffPlayerAction(req, res, route, user);
    }
    return false;
  } catch (err) {
    logger.error({ err }, 'Staff viewer failed');
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    return true;
  }
}

async function spectate(
  req: AuthenticatedRequest,
  res: Response,
  route: SurfaceRoute,
  user: NonNullable<AuthenticatedRequest['user']>,
  headers:
    | { type: 'view_as'; sessionId: string; subjectId: string }
    | { type: 'spectator'; sessionId: string },
): Promise<boolean> {
  const resolved = await resolveBind(route, req);
  if (resolved.kind === 'error') {
    res.status(500).json({ error: 'Internal server error' });
    return true;
  }
  if (resolved.kind === 'missing') {
    res.status(404).json({ error: 'Not found' });
    return true;
  }
  if (resolved.kind === 'id' && resolved.id !== headers.sessionId) {
    res.status(400).json({
      error: 'X-Sim-Session does not match this request',
      code: VIEW_AS_SESSION_MISMATCH,
    });
    return true;
  }

  const session = await loadSession(headers.sessionId);
  if (session.kind === 'error') {
    res.status(500).json({ error: 'Internal server error' });
    return true;
  }
  if (session.kind === 'missing') {
    res.status(404).json({ error: 'Session not found' });
    return true;
  }
  if (!canSpectate(user, session.row)) {
    res.status(403).json({
      error: 'You cannot view this session as that participant',
      code: VIEW_AS_DENIED,
    });
    return true;
  }

  const realUser = toViewerUser(user);
  let subject: ViewerUser | null = null;
  const mode: 'view_as' | 'spectator' = headers.type === 'view_as' ? 'view_as' : 'spectator';
  if (headers.type === 'view_as') {
    const playing = await isParticipant(session.row.id, headers.subjectId);
    if (playing === 'error') {
      res.status(500).json({ error: 'Internal server error' });
      return true;
    }
    if (playing === 'no') {
      res.status(403).json({
        error: 'You cannot view this session as that participant',
        code: VIEW_AS_DENIED,
      });
      return true;
    }
    subject = await loadSubject(headers.subjectId);
    req.user = subject;
  }

  req.viewer = { realUser, subject, mode, sessionId: session.row.id };
  await recordStaffView({
    sessionId: session.row.id,
    staffUserId: realUser.id,
    subjectUserId: headers.type === 'view_as' ? headers.subjectId : null,
    mode,
  });
  const block = spectatorWriteBlock(mode, req.method);
  if (block) {
    res.status(block.status).json({ error: block.error, code: block.code });
    return true;
  }
  return false;
}

async function blockStaffPlayerAction(
  req: AuthenticatedRequest,
  res: Response,
  route: SurfaceRoute,
  user: NonNullable<AuthenticatedRequest['user']>,
): Promise<boolean> {
  const resolved = await resolveBind(route, req);
  if (resolved.kind === 'error' || resolved.kind !== 'id' || resolved.staffOverride) return false;
  const session = await loadSession(resolved.id);
  if (session.kind !== 'ok' || !isLiveSession(session.row.status)) return false;
  const playing = await isParticipant(session.row.id, user.id);
  if (playing !== 'no') return false;
  const block = staffPlayerActionBlock({
    method: req.method,
    routeClass: 'player',
    staffRole: true,
    live: true,
    participant: false,
  });
  if (!block) return false;
  res.status(block.status).json({ error: block.error, code: block.code });
  return true;
}

function toViewerUser(user: NonNullable<AuthenticatedRequest['user']>): ViewerUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    agency: user.agency,
    displayName: user.displayName,
    metadata: user.metadata,
  };
}

function readLocated(
  bind: Extract<SessionBind, { kind: 'param' | 'body' | 'query' }>,
  req: AuthenticatedRequest,
): unknown {
  if (bind.kind === 'param') return req.params[bind.name];
  if (bind.kind === 'body') {
    const body = req.body as Record<string, unknown> | undefined;
    return body?.[bind.name];
  }
  const value = req.query[bind.name];
  return Array.isArray(value) ? value[0] : value;
}

async function resolveBind(route: SurfaceRoute, req: AuthenticatedRequest): Promise<Resolved> {
  const bind = route.bind;
  if (bind.kind === 'none') return { kind: 'none' };
  if (bind.kind === 'param' || bind.kind === 'body' || bind.kind === 'query') {
    const raw = readLocated(bind, req);
    if (typeof raw !== 'string' || raw.trim() === '') {
      return bind.kind !== 'param' && bind.optional ? { kind: 'absent' } : { kind: 'missing' };
    }
    return { kind: 'id', id: raw.trim(), staffOverride: false };
  }

  const id = req.params[bind.idParam];
  if (typeof id !== 'string' || id.length === 0) return { kind: 'missing' };
  const column = bind.idColumn ?? 'id';
  const select = route.staffWhen ? `session_id, ${route.staffWhen.column}` : 'session_id';
  try {
    const { data, error } = await supabaseAdmin
      .from(bind.table)
      .select(select)
      .eq(column, id)
      .limit(1)
      .maybeSingle();
    if (error) return { kind: 'error' };
    const record = data as Record<string, unknown> | null;
    const sessionId = typeof record?.session_id === 'string' ? record.session_id : null;
    if (!sessionId) return { kind: 'missing' };
    const staffOverride = route.staffWhen
      ? String(record?.[route.staffWhen.column] ?? '') === route.staffWhen.equals
      : false;
    return { kind: 'id', id: sessionId, staffOverride };
  } catch {
    return { kind: 'error' };
  }
}

async function loadSession(id: string): Promise<LoadedSession> {
  try {
    const { data, error } = await supabaseAdmin
      .from('sessions')
      .select('id, trainer_id, status')
      .eq('id', id)
      .maybeSingle();
    if (error) return { kind: 'error' };
    const row = data as { id?: unknown; trainer_id?: unknown; status?: unknown } | null;
    if (!row || typeof row.id !== 'string') return { kind: 'missing' };
    return {
      kind: 'ok',
      row: {
        id: row.id,
        trainer_id: typeof row.trainer_id === 'string' ? row.trainer_id : null,
        status: typeof row.status === 'string' ? row.status : null,
      },
    };
  } catch {
    return { kind: 'error' };
  }
}

async function isParticipant(sessionId: string, userId: string): Promise<'yes' | 'no' | 'error'> {
  try {
    const { data, error } = await supabaseAdmin
      .from('session_participants')
      .select('user_id')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) return 'error';
    return data ? 'yes' : 'no';
  } catch {
    return 'error';
  }
}

async function loadSubject(id: string): Promise<ViewerUser> {
  try {
    const { data, error } = await supabaseAdmin
      .from('user_profiles')
      .select('role, agency_name, full_name')
      .eq('id', id)
      .maybeSingle();
    if (error || !data) return { id };
    const profile = data as { role?: unknown; agency_name?: unknown; full_name?: unknown };
    const fullName = typeof profile.full_name === 'string' ? profile.full_name.trim() : '';
    return {
      id,
      role: typeof profile.role === 'string' ? profile.role : undefined,
      agency: typeof profile.agency_name === 'string' ? profile.agency_name : undefined,
      displayName: fullName || undefined,
      metadata: {},
    };
  } catch {
    return { id };
  }
}
