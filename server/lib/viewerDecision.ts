/**
 * Pure spectator decisions. No Supabase. The middleware applies these after it
 * has loaded the session; with both flags off it never calls them.
 */

export type ViewerMode = 'self' | 'spectator' | 'view_as' | 'sandbox';

export const VIEW_AS_DENIED = 'VIEW_AS_DENIED';
export const SPECTATOR_READ_ONLY = 'SPECTATOR_READ_ONLY';
export const STAFF_PLAYER_ACTION_BLOCKED = 'STAFF_PLAYER_ACTION_BLOCKED';
export const VIEW_AS_SESSION_MISMATCH = 'VIEW_AS_SESSION_MISMATCH';

export interface ViewerDenial {
  status: 400 | 403;
  code: string;
  error: string;
}

export type ParsedViewHeaders =
  | { type: 'self' }
  | { type: 'view_as'; sessionId: string; subjectId: string }
  | { type: 'spectator'; sessionId: string }
  | { type: 'error'; status: 400; code: typeof VIEW_AS_SESSION_MISMATCH; error: string };

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Header meaning when view-as is enabled. The caller does not invoke this when the flag is off. */
export function parseViewHeaders(input: {
  session?: string;
  viewAs?: string;
  spectator?: string;
}): ParsedViewHeaders {
  const sessionId = clean(input.session);
  const viewAs = clean(input.viewAs);
  const spectator = clean(input.spectator);
  if (!viewAs && spectator !== '1') return { type: 'self' };
  if (!sessionId) {
    return {
      type: 'error',
      status: 400,
      code: VIEW_AS_SESSION_MISMATCH,
      error: 'X-Sim-Session is required',
    };
  }
  if (viewAs) return { type: 'view_as', sessionId, subjectId: viewAs };
  return { type: 'spectator', sessionId };
}

export function isWriteMethod(method: string): boolean {
  const upper = method.toUpperCase();
  return upper !== 'GET' && upper !== 'HEAD';
}

/** A live session is one currently in progress. Lobby, pause and concluded are not. */
export function isLiveSession(status: string | null | undefined): boolean {
  return status === 'in_progress';
}

/** The role `assertControlsOrgPage` and `assertTeamMembership` treat as staff. */
export function hasStaffRole(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'trainer';
}

/**
 * Rule 1. View-as and spectator frames cannot write. Sandbox mode (WP9) may write;
 * this build never enters that mode.
 */
export function spectatorWriteBlock(mode: ViewerMode, method: string): ViewerDenial | null {
  if (mode !== 'view_as' && mode !== 'spectator') return null;
  if (!isWriteMethod(method)) return null;
  return {
    status: 403,
    code: SPECTATOR_READ_ONLY,
    error: 'Spectators cannot change the session',
  };
}

/**
 * Rule 2. A trainer or admin who is not playing cannot take a player action in a
 * live session. Staff-class routes (assign, seize, post-as, trainer channel) stay open.
 */
export function staffPlayerActionBlock(input: {
  method: string;
  routeClass: 'player' | 'staff' | undefined;
  staffRole: boolean;
  live: boolean;
  participant: boolean;
}): ViewerDenial | null {
  if (!isWriteMethod(input.method)) return null;
  if (input.routeClass !== 'player') return null;
  if (!input.staffRole || !input.live || input.participant) return null;
  return {
    status: 403,
    code: STAFF_PLAYER_ACTION_BLOCKED,
    error: 'Staff cannot take player actions in a live session they are not playing',
  };
}

/** Player-visible GET writes run only for the caller's own session. Undefined mode is today's request. */
export function getSideEffectAllowed(mode: ViewerMode | undefined): boolean {
  return mode == null || mode === 'self';
}
