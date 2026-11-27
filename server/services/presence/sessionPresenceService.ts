import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import {
  BOOT_GRACE_SECONDS,
} from '../calls/lineCore.js';
import {
  createPresenceMap,
  presenceExpire,
  presenceIsOnline,
  presenceJoin,
  presenceLeave,
  type PresenceMap,
  type PresenceNotice,
} from './presenceCore.js';

const map: PresenceMap = createPresenceMap();
const sockets = new Map<string, { userId: string; sessions: Set<string> }>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const startedAt = Date.now();
const listeners = new Set<(notice: PresenceNotice) => void>();

export function onPresence(listener: (notice: PresenceNotice) => void): void {
  listeners.add(listener);
}

export function presenceEnginesOn(): boolean {
  return env.runBackgroundEngines;
}

export function inBootGrace(now = Date.now()): boolean {
  return now - startedAt < BOOT_GRACE_SECONDS * 1000;
}

export function sessionUserOnline(sessionId: string, userId: string, graceSeconds = 60, now = Date.now()): boolean {
  return presenceIsOnline(map, sessionId, userId, now, graceSeconds * 1000);
}

export function noteSessionJoin(sessionId: string, userId: string | undefined, socketId: string): void {
  if (!sessionId || !userId) return;
  const socket = sockets.get(socketId) ?? { userId, sessions: new Set<string>() };
  socket.userId = userId;
  socket.sessions.add(sessionId);
  sockets.set(socketId, socket);
  clearTimer(sessionId, userId);
  const notice = presenceJoin(map, sessionId, userId, Date.now());
  if (notice) publish(notice);
}

export function noteSessionLeave(sessionId: string, userId: string | undefined, socketId: string): void {
  if (!sessionId || !userId) return;
  const socket = sockets.get(socketId);
  socket?.sessions.delete(sessionId);
  presenceLeave(map, sessionId, userId, Date.now());
  arm(sessionId, userId);
}

export function noteSocketGone(socketId: string, userId: string | undefined): void {
  const socket = sockets.get(socketId);
  const sessions = socket?.sessions ?? new Set<string>();
  const owner = userId ?? socket?.userId;
  sockets.delete(socketId);
  if (!owner) return;
  const now = Date.now();
  for (const sessionId of sessions) {
    presenceLeave(map, sessionId, owner, now);
    arm(sessionId, owner);
  }
}

function arm(sessionId: string, userId: string): void {
  const key = `${sessionId}:${userId}`;
  clearTimer(sessionId, userId);
  const graceMs = 60_000;
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      for (const notice of presenceExpire(map, Date.now(), graceMs, inBootGrace())) {
        publish(notice);
      }
    }, graceMs),
  );
}

function clearTimer(sessionId: string, userId: string): void {
  const key = `${sessionId}:${userId}`;
  const timer = timers.get(key);
  if (!timer) return;
  clearTimeout(timer);
  timers.delete(key);
}

function publish(notice: PresenceNotice): void {
  if (notice.type === 'presence.offline' && !presenceEnginesOn()) return;
  for (const listener of listeners) {
    try {
      listener(notice);
    } catch (err) {
      logger.warn({ err, event: notice.type }, 'presence listener failed');
    }
  }
}
