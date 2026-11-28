import type { Request, RequestHandler, Response } from 'express';
import type { AuthenticatedRequest } from './auth.js';
import { findSessionParticipant } from '../lib/access.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { canSpectate } from '../lib/socialAccess.js';
import { loadSocialSession } from '../lib/socialSessionGuard.js';
import { recordStaffView } from '../lib/staffViewAudit.js';
import {
  lookupSurfaceRoute,
  SURFACE_ROUTER_FILES,
  type RouterId,
  type SessionBind,
  type SurfaceRoute,
} from '../lib/surfaceRoutes.js';
import {
  STAFF_PLAYER_ACTION_BLOCKED,
  VIEW_AS_DENIED,
  VIEW_AS_SESSION_MISMATCH,
  getSideEffectAllowed,
  hasStaffRole,
  isLiveSession,
  isWriteMethod,
  parseViewHeaders,
  spectatorWriteBlock,
  staffPlayerActionBlock,
  staffPlayerActionGuardEnabled,
  staffViewAsEnabled,
  type ViewerMode,
} from '../lib/viewerDecision.js';
import {
  mergeViewerSubject,
  type ViewerAccount,
  type ViewerProfile,
} from '../lib/viewerSubject.js';

export type { ViewerMode };
export { getSideEffectAllowed, staffPlayerActionGuardEnabled, staffViewAsEnabled };

type RequestUser = NonNullable<AuthenticatedRequest['user']>;

export interface ViewerContext {
  realUser: RequestUser;
  subject: RequestUser | null;
  mode: ViewerMode;
  sessionId: string | null;
}

const mountedRouter = new WeakMap<Request, RouterId>();

type Resolved =
  | { kind: 'none' }
  | { kind: 'absent' }
  | { kind: 'missing' }
  | { kind: 'error' }
  | { kind: 'id'; id: string; staffOverride: boolean };

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
    mountedRouter.set(req, routerId);
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
  const routerId = mountedRouter.get(req);
  if (!routerId || !(routerId in SURFACE_ROUTER_FILES)) return false;
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
    const pattern = req.route?.path ?? req.path;
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
  user: RequestUser,
  headers:
    | { type: 'view_as'; sessionId: string; subjectId: string }
    | { type: 'spectator'; sessionId: string },
): Promise<boolean> {
  const session = await loadSocialSession(headers.sessionId);
  if (session.kind === 'error') {
    res.status(500).json({ error: 'Internal server error' });
    return true;
  }
  if (session.kind === 'missing') {
    res.status(404).json({ error: 'Session not found' });
    return true;
  }
  if (!canSpectate(user, session.session)) {
    res.status(403).json({
      error: 'You cannot view this session as that participant',
      code: VIEW_AS_DENIED,
    });
    return true;
  }

  const mode: 'view_as' | 'spectator' = headers.type === 'view_as' ? 'view_as' : 'spectator';
  const resolved = await resolveBind(route, req);
  if (resolved.kind === 'error') {
    res.status(500).json({ error: 'Internal server error' });
    return true;
  }
  if (resolved.kind === 'absent' || resolved.kind === 'none') {
    return unboundFrame(res, mode, req.method);
  }
  if (resolved.kind === 'missing') {
    res.status(404).json({ error: 'Not found' });
    return true;
  }
  if (resolved.id !== headers.sessionId) {
    res.status(400).json({
      error: 'X-Sim-Session does not match this request',
      code: VIEW_AS_SESSION_MISMATCH,
    });
    return true;
  }

  let subject: RequestUser | null = null;
  if (headers.type === 'view_as') {
    const playing = await findSessionParticipant(session.session.id, headers.subjectId);
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
    subject = await loadViewerSubject(headers.subjectId);
    req.user = subject;
  }

  req.viewer = { realUser: user, subject, mode, sessionId: session.session.id };
  await recordStaffView({
    sessionId: session.session.id,
    staffUserId: user.id,
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

/** A frame with no route session does not swap identity. Writes are still read-only. */
function unboundFrame(res: Response, mode: 'view_as' | 'spectator', method: string): boolean {
  const block = spectatorWriteBlock(mode, method);
  if (block) {
    res.status(block.status).json({ error: block.error, code: block.code });
    return true;
  }
  res.status(400).json({
    error: 'X-Sim-Session does not match this request',
    code: VIEW_AS_SESSION_MISMATCH,
  });
  return true;
}

function denyStaffPlayerAction(res: Response): boolean {
  const block = staffPlayerActionBlock({
    method: 'POST',
    routeClass: 'player',
    staffRole: true,
    live: true,
    participant: false,
  });
  res.status(block?.status ?? 403).json({
    error:
      block?.error ?? 'Staff cannot take player actions in a live session they are not playing',
    code: block?.code ?? STAFF_PLAYER_ACTION_BLOCKED,
  });
  return true;
}

async function blockStaffPlayerAction(
  req: AuthenticatedRequest,
  res: Response,
  route: SurfaceRoute,
  user: RequestUser,
): Promise<boolean> {
  const resolved = await resolveBind(route, req);
  if (resolved.kind === 'error') return denyStaffPlayerAction(res);
  if (resolved.kind !== 'id' || resolved.staffOverride) return false;
  const session = await loadSocialSession(resolved.id);
  if (session.kind === 'error') return denyStaffPlayerAction(res);
  if (session.kind !== 'ok' || !isLiveSession(session.session.status)) return false;
  const playing = await findSessionParticipant(session.session.id, user.id);
  if (playing === 'yes') return false;
  return denyStaffPlayerAction(res);
}

function readLocated(
  bind: Extract<SessionBind, { kind: 'param' | 'body' | 'query' }>,
  req: AuthenticatedRequest,
): unknown {
  if (bind.kind === 'param') return req.params[bind.name];
  if (bind.kind === 'body') return req.body?.[bind.name];
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
    const sessionId = field(data, 'session_id');
    if (typeof sessionId !== 'string') return { kind: 'missing' };
    const staffOverride = route.staffWhen
      ? String(field(data, route.staffWhen.column) ?? '') === route.staffWhen.equals
      : false;
    return { kind: 'id', id: sessionId, staffOverride };
  } catch {
    return { kind: 'error' };
  }
}

function field(row: unknown, key: string): unknown {
  if (typeof row !== 'object' || row === null) return undefined;
  if (!Object.prototype.hasOwnProperty.call(row, key)) return undefined;
  return Reflect.get(row, key);
}

/**
 * The participant `requireAuth` would build. Profile name first; an empty name
 * falls through to auth metadata and email so messenger handles stay the player's.
 */
export async function loadViewerSubject(id: string): Promise<RequestUser> {
  const [account, profile] = await Promise.all([readAccount(id), readProfile(id)]);
  return mergeViewerSubject(id, account, profile);
}

async function readAccount(id: string): Promise<ViewerAccount | null> {
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(id);
    if (error || !data?.user) return null;
    return {
      email: data.user.email ?? null,
      app_metadata: recordOf(data.user.app_metadata),
      user_metadata: recordOf(data.user.user_metadata),
    };
  } catch {
    return null;
  }
}

async function readProfile(id: string): Promise<ViewerProfile | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('user_profiles')
      .select('role, agency_name, full_name')
      .eq('id', id)
      .maybeSingle();
    if (error || !data) return null;
    return {
      role: stringField(data, 'role'),
      agency_name: stringField(data, 'agency_name'),
      full_name: stringField(data, 'full_name'),
    };
  } catch {
    return null;
  }
}

function stringField(row: unknown, key: string): string | null {
  const value = field(row, key);
  return typeof value === 'string' ? value : null;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}
