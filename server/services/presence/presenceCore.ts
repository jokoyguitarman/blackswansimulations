/**
 * In-memory session presence. A user is online while a socket is joined to the
 * session room, and for offline_grace_seconds after the last socket leaves.
 * `presence.offline` fires once, when the grace expires, and not again until
 * they have been online in between.
 */

export interface PresenceUser {
  sockets: number;
  lastSeen: number;
  offlineSince: number | null;
  offlineEmitted: boolean;
}

export type PresenceMap = Map<string, Map<string, PresenceUser>>;

export interface PresenceNotice {
  type: 'presence.online' | 'presence.offline';
  sessionId: string;
  userId: string;
  at: number;
}

export function createPresenceMap(): PresenceMap {
  return new Map();
}

export function presenceJoin(map: PresenceMap, sessionId: string, userId: string, now: number): PresenceNotice | null {
  const users = usersOf(map, sessionId);
  const current = users.get(userId);
  const wasOnline = current ? current.sockets > 0 || current.offlineSince == null : false;
  const next: PresenceUser = {
    sockets: (current?.sockets ?? 0) + 1,
    lastSeen: now,
    offlineSince: null,
    offlineEmitted: false,
  };
  users.set(userId, next);
  if (wasOnline && current && current.sockets > 0) return null;
  if (current && current.sockets === 0 && current.offlineSince == null) return null;
  return { type: 'presence.online', sessionId, userId, at: now };
}

export function presenceLeave(map: PresenceMap, sessionId: string, userId: string, now: number): void {
  const users = map.get(sessionId);
  const current = users?.get(userId);
  if (!current) return;
  const sockets = Math.max(0, current.sockets - 1);
  users?.set(userId, {
    sockets,
    lastSeen: now,
    offlineSince: sockets === 0 ? null : current.offlineSince,
    offlineEmitted: sockets === 0 ? false : current.offlineEmitted,
  });
}

/** Call on a timer and on each sweep. Boot grace suppresses the offline event. */
export function presenceExpire(
  map: PresenceMap,
  now: number,
  graceMs: number,
  bootGrace: boolean,
): PresenceNotice[] {
  if (bootGrace) return [];
  const notices: PresenceNotice[] = [];
  for (const [sessionId, users] of map) {
    for (const [userId, user] of users) {
      if (user.sockets > 0) continue;
      if (now - user.lastSeen < graceMs) continue;
      if (user.offlineEmitted) continue;
      user.offlineSince = user.lastSeen;
      user.offlineEmitted = true;
      notices.push({ type: 'presence.offline', sessionId, userId, at: now });
    }
  }
  return notices;
}

export function presenceIsOnline(
  map: PresenceMap,
  sessionId: string,
  userId: string,
  now: number,
  graceMs: number,
): boolean {
  const user = map.get(sessionId)?.get(userId);
  if (!user) return false;
  if (user.sockets > 0) return true;
  return now - user.lastSeen < graceMs;
}

function usersOf(map: PresenceMap, sessionId: string): Map<string, PresenceUser> {
  let users = map.get(sessionId);
  if (!users) {
    users = new Map();
    map.set(sessionId, users);
  }
  return users;
}
