/**
 * Player-surface route registry (§7.3). Pure: no Supabase.
 *
 * `player` acts as a participant. `staff` is the trainer console (page assign,
 * seize, post-as, channel create, and a trainer-type channel post).
 *
 * Mark-read on emails, news, messenger and channels is `player`. The session
 * access freeze returns 409 for those after the session ends. Drafts, calls,
 * notification read and media preview are also `player`, but that freeze does
 * not cover them. This registry does not extend it.
 *
 * Inject publish is not on these routers.
 */

export type RouterId =
  | 'socialMedia'
  | 'socialMessenger'
  | 'channels'
  | 'socialGroups'
  | 'socialEvents'
  | 'simCalls'
  | 'playerDrafts'
  | 'notifications';

export type SessionBind =
  | { kind: 'param'; name: string }
  | { kind: 'body'; name: string; optional?: boolean }
  | { kind: 'query'; name: string; optional?: boolean }
  | { kind: 'row'; table: string; idParam: string; idColumn?: string }
  | { kind: 'none' };

export interface SurfaceRoute {
  router: RouterId;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  bind: SessionBind;
  /** Absent on GET. */
  class?: 'player' | 'staff';
  /** A player route becomes staff when the loaded row's column equals this value. */
  staffWhen?: { column: string; equals: string };
  /** The class could reasonably be the other one. Listed for review before the guard flag is turned on. */
  uncertain?: boolean;
}

export const SURFACE_ROUTER_FILES: Record<RouterId, string> = {
  socialMedia: 'server/routes/socialMedia.ts',
  socialMessenger: 'server/routes/socialMessenger.ts',
  channels: 'server/routes/channels.ts',
  socialGroups: 'server/routes/socialGroups.ts',
  socialEvents: 'server/routes/socialEvents.ts',
  simCalls: 'server/routes/simCalls.ts',
  playerDrafts: 'server/routes/playerDrafts.ts',
  notifications: 'server/routes/notifications.ts',
};

/**
 * GETs that do not check the session. Adding a check would change behaviour,
 * so they stay as they are. The registry guard test fails if this list drifts
 * from the route files.
 */
export const GETS_WITHOUT_SESSION_CHECK: Array<{
  router: RouterId;
  path: string;
  reason: string;
}> = [
  {
    router: 'socialMedia',
    path: '/media/preview/:previewId',
    reason:
      'In-memory media preview with no session id. A session check would change who can poll a preview.',
  },
  {
    router: 'notifications',
    path: '/',
    reason:
      "The signed-in user's own notifications. session_id is an optional filter, not an access key.",
  },
  {
    router: 'notifications',
    path: '/unread/count',
    reason: "The signed-in user's own unread count. session_id is an optional filter.",
  },
];

/** GET writes that are lazy seeding, not player-visible state. They are not skipped. */
export const GET_LAZY_SEEDS: Array<{ router: RouterId; path: string; calls: string[] }> = [
  {
    router: 'channels',
    path: '/session/:sessionId',
    calls: ['createDefaultChannels', 'ensureTeamChannels'],
  },
];

type Method = SurfaceRoute['method'];

function route(
  router: RouterId,
  method: Method,
  path: string,
  bind: SessionBind,
  routeClass?: 'player' | 'staff',
  extra?: Pick<SurfaceRoute, 'staffWhen' | 'uncertain'>,
): SurfaceRoute {
  return {
    router,
    method,
    path,
    bind,
    ...(routeClass ? { class: routeClass } : {}),
    ...extra,
  };
}

const param = (name: string): SessionBind => ({ kind: 'param', name });
const body = (name: string, optional?: boolean): SessionBind =>
  optional ? { kind: 'body', name, optional: true } : { kind: 'body', name };
const query = (name: string, optional?: boolean): SessionBind =>
  optional ? { kind: 'query', name, optional: true } : { kind: 'query', name };
const row = (table: string, idParam: string, idColumn?: string): SessionBind =>
  idColumn ? { kind: 'row', table, idParam, idColumn } : { kind: 'row', table, idParam };
const none: SessionBind = { kind: 'none' };
const sessionParam = param('sessionId');
const sessionBody = body('session_id');

const trainerChannel = {
  staffWhen: { column: 'type', equals: 'trainer' },
  uncertain: true,
} as const;

export const SURFACE_ROUTES: SurfaceRoute[] = [
  // socialMedia
  route('socialMedia', 'GET', '/posts/session/:sessionId', sessionParam),
  route('socialMedia', 'GET', '/posts/:postId', row('social_posts', 'postId')),
  route('socialMedia', 'POST', '/posts', sessionBody, 'player'),
  route('socialMedia', 'POST', '/posts/:postId/like', row('social_posts', 'postId'), 'player'),
  route('socialMedia', 'DELETE', '/posts/:postId/like', row('social_posts', 'postId'), 'player'),
  route('socialMedia', 'GET', '/posts/:postId/reactions', row('social_posts', 'postId')),
  route('socialMedia', 'POST', '/posts/:postId/flag', row('social_posts', 'postId'), 'player'),
  route('socialMedia', 'POST', '/posts/:postId/report', row('social_posts', 'postId'), 'player'),
  route('socialMedia', 'POST', '/posts/:postId/repost', row('social_posts', 'postId'), 'player'),
  route('socialMedia', 'GET', '/emails/session/:sessionId', sessionParam),
  route('socialMedia', 'POST', '/emails/:emailId/read', row('sim_emails', 'emailId'), 'player'),
  route('socialMedia', 'POST', '/emails', sessionBody, 'player'),
  route('socialMedia', 'GET', '/contacts/session/:sessionId', sessionParam),
  route('socialMedia', 'GET', '/contacts/session/:sessionId/search', sessionParam),
  route('socialMedia', 'GET', '/emails/contacts/session/:sessionId', sessionParam),
  route('socialMedia', 'GET', '/news/session/:sessionId', sessionParam),
  route(
    'socialMedia',
    'POST',
    '/news/:articleId/read',
    row('sim_news_articles', 'articleId'),
    'player',
  ),
  route('socialMedia', 'POST', '/disputes', sessionBody, 'player'),
  route('socialMedia', 'GET', '/disputes/session/:sessionId', sessionParam),
  route('socialMedia', 'GET', '/ledger/session/:sessionId', sessionParam),
  route('socialMedia', 'GET', '/team-scores/session/:sessionId', sessionParam),
  route('socialMedia', 'GET', '/intel-status/session/:sessionId', sessionParam),
  route('socialMedia', 'GET', '/my-team/session/:sessionId', sessionParam),
  route('socialMedia', 'GET', '/sop/session/:sessionId', sessionParam),
  route('socialMedia', 'GET', '/sentiment/session/:sessionId', sessionParam),
  route('socialMedia', 'GET', '/actions/session/:sessionId', sessionParam),
  route('socialMedia', 'POST', '/grade', sessionBody, 'player'),
  route('socialMedia', 'GET', '/state/session/:sessionId', sessionParam),
  route('socialMedia', 'POST', '/demographics', sessionBody, 'player'),
  route('socialMedia', 'GET', '/demographics/session/:sessionId', sessionParam),
  route('socialMedia', 'GET', '/handles/session/:sessionId', sessionParam),
  route('socialMedia', 'POST', '/action', sessionBody, 'player'),
  route('socialMedia', 'GET', '/trending/session/:sessionId', sessionParam),
  route('socialMedia', 'GET', '/suggested/session/:sessionId', sessionParam),
  route('socialMedia', 'POST', '/media/preview', none, 'player', { uncertain: true }),
  route('socialMedia', 'GET', '/media/preview/:previewId', none),
  route('socialMedia', 'GET', '/orchestration/session/:sessionId', sessionParam),
  route('socialMedia', 'GET', '/org-page/session/:sessionId', sessionParam),
  route('socialMedia', 'GET', '/pages/session/:sessionId', sessionParam),
  route('socialMedia', 'GET', '/my-page/session/:sessionId', sessionParam),
  route('socialMedia', 'POST', '/pages/session/:sessionId/assign', sessionParam, 'staff'),
  route('socialMedia', 'DELETE', '/pages/session/:sessionId/assign', sessionParam, 'staff'),
  route('socialMedia', 'POST', '/pages/session/:sessionId/post-as', sessionParam, 'staff'),
  route('socialMedia', 'POST', '/pages/session/:sessionId/seize', sessionParam, 'staff'),
  route('socialMedia', 'GET', '/my-activity/session/:sessionId', sessionParam),

  // socialMessenger
  route('socialMessenger', 'GET', '/threads/:sessionId', sessionParam),
  route(
    'socialMessenger',
    'GET',
    '/thread/:threadId',
    row('sim_direct_messages', 'threadId', 'thread_id'),
  ),
  route('socialMessenger', 'POST', '/send', sessionBody, 'player'),
  route(
    'socialMessenger',
    'POST',
    '/:messageId/read',
    row('sim_direct_messages', 'messageId'),
    'player',
  ),
  route('socialMessenger', 'GET', '/unread-count/:sessionId', sessionParam),

  // channels
  route('channels', 'GET', '/session/:sessionId', sessionParam),
  route('channels', 'GET', '/session/:sessionId/dms', sessionParam),
  route('channels', 'GET', '/session/:sessionId/participants', sessionParam),
  route('channels', 'POST', '/session/:sessionId/dm', sessionParam, 'player'),
  route('channels', 'GET', '/:channelId/messages', row('chat_channels', 'channelId')),
  route('channels', 'GET', '/:channelId/members', row('chat_channels', 'channelId')),
  route('channels', 'POST', '/:channelId/read', row('chat_channels', 'channelId'), 'player'),
  route('channels', 'POST', '/session/:sessionId/npc-dm', sessionParam, 'player', {
    uncertain: true,
  }),
  route('channels', 'POST', '/', sessionBody, 'staff'),
  route(
    'channels',
    'POST',
    '/:channelId/messages',
    row('chat_channels', 'channelId'),
    'player',
    trainerChannel,
  ),

  // socialGroups
  route('socialGroups', 'GET', '/session/:sessionId', sessionParam),
  route('socialGroups', 'GET', '/:groupId/posts', row('sim_groups', 'groupId')),
  route('socialGroups', 'POST', '/:groupId/posts', row('sim_groups', 'groupId'), 'player'),
  route('socialGroups', 'POST', '/:groupId/join', row('sim_groups', 'groupId'), 'player'),
  route(
    'socialGroups',
    'POST',
    '/:groupId/posts/:postId/like',
    row('sim_group_posts', 'postId'),
    'player',
  ),

  // socialEvents
  route('socialEvents', 'GET', '/session/:sessionId', sessionParam),
  route('socialEvents', 'GET', '/:eventId', row('sim_events', 'eventId')),
  route('socialEvents', 'POST', '/', sessionBody, 'player'),
  route('socialEvents', 'POST', '/:eventId/respond', row('sim_events', 'eventId'), 'player'),
  route('socialEvents', 'POST', '/:eventId/discuss', row('sim_events', 'eventId'), 'player'),

  // simCalls
  route('simCalls', 'GET', '/session/:sessionId/badge', sessionParam),
  route('simCalls', 'POST', '/session/:sessionId/recents-viewed', sessionParam, 'player'),
  route('simCalls', 'GET', '/session/:sessionId', sessionParam),
  route('simCalls', 'GET', '/:callId', row('sim_calls', 'callId')),
  route('simCalls', 'POST', '/:callId/answer', row('sim_calls', 'callId'), 'player'),
  route('simCalls', 'POST', '/:callId/decline', row('sim_calls', 'callId'), 'player'),
  route('simCalls', 'POST', '/:callId/attach', row('sim_calls', 'callId'), 'player'),
  route('simCalls', 'POST', '/:callId/transcript', row('sim_calls', 'callId'), 'player'),
  route('simCalls', 'POST', '/:callId/text-turn', row('sim_calls', 'callId'), 'player'),
  route('simCalls', 'POST', '/:callId/hangup', row('sim_calls', 'callId'), 'player'),
  route('simCalls', 'POST', '/:callId/callback', row('sim_calls', 'callId'), 'player'),
  route('simCalls', 'POST', '/:callId/state', row('sim_calls', 'callId'), 'player'),

  // playerDrafts
  route('playerDrafts', 'GET', '/session/:sessionId', sessionParam),
  route('playerDrafts', 'GET', '/:id', row('player_drafts', 'id')),
  route('playerDrafts', 'POST', '/', sessionBody, 'player'),
  route('playerDrafts', 'PATCH', '/:id', row('player_drafts', 'id'), 'player'),
  route('playerDrafts', 'POST', '/:id/submit', row('player_drafts', 'id'), 'player'),
  route('playerDrafts', 'POST', '/:id/review', row('player_drafts', 'id'), 'player', {
    uncertain: true,
  }),
  route('playerDrafts', 'POST', '/:id/grade', row('player_drafts', 'id'), 'player', {
    uncertain: true,
  }),
  route('playerDrafts', 'DELETE', '/:id', row('player_drafts', 'id'), 'player', {
    uncertain: true,
  }),

  // notifications
  route('notifications', 'GET', '/', query('session_id', true)),
  route('notifications', 'GET', '/unread/count', query('session_id', true)),
  route('notifications', 'POST', '/:id/read', row('notifications', 'id'), 'player'),
  route('notifications', 'POST', '/read-all', body('session_id', true), 'player', {
    uncertain: true,
  }),
];

const compiled = new Map<string, { regex: RegExp; literals: number }>();

function compile(path: string): { regex: RegExp; literals: number } {
  const cached = compiled.get(path);
  if (cached) return cached;
  let literals = 0;
  const body = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) return '([^/]+)';
      if (segment.length > 0) literals += 1;
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  const entry = { regex: new RegExp(`^${body}$`), literals };
  compiled.set(path, entry);
  return entry;
}

/** Exact pattern match, or the most specific pattern that matches a concrete path. */
export function lookupSurfaceRoute(
  routerId: string,
  method: string,
  pathOrPattern: string,
): SurfaceRoute | undefined {
  const upper = method.toUpperCase();
  const exact = SURFACE_ROUTES.find(
    (entry) => entry.router === routerId && entry.method === upper && entry.path === pathOrPattern,
  );
  if (exact) return exact;
  let best: { route: SurfaceRoute; literals: number; length: number } | undefined;
  for (const entry of SURFACE_ROUTES) {
    if (entry.router !== routerId || entry.method !== upper) continue;
    const pattern = compile(entry.path);
    if (!pattern.regex.test(pathOrPattern)) continue;
    if (
      !best ||
      pattern.literals > best.literals ||
      (pattern.literals === best.literals && entry.path.length > best.length)
    ) {
      best = { route: entry, literals: pattern.literals, length: entry.path.length };
    }
  }
  return best?.route;
}

export function registrySummary(): {
  routes: number;
  gets: number;
  nonGet: number;
  player: number;
  staff: number;
  uncertain: Array<{ method: string; router: string; path: string }>;
} {
  const gets = SURFACE_ROUTES.filter((entry) => entry.method === 'GET');
  const writes = SURFACE_ROUTES.filter((entry) => entry.method !== 'GET');
  return {
    routes: SURFACE_ROUTES.length,
    gets: gets.length,
    nonGet: writes.length,
    player: writes.filter((entry) => entry.class === 'player').length,
    staff: writes.filter((entry) => entry.class === 'staff').length,
    uncertain: SURFACE_ROUTES.filter((entry) => entry.uncertain).map((entry) => ({
      method: entry.method,
      router: entry.router,
      path: entry.path,
    })),
  };
}
