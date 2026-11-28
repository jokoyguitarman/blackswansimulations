/** The player a staff shell is reading as. Null everywhere else, including the trainer console. */
export interface ViewAsFrame {
  sessionId: string;
  userId: string;
  name: string;
}

let frame: ViewAsFrame | null = null;
let generation = 0;
const listeners = new Set<() => void>();

function sameFrame(a: ViewAsFrame | null, b: ViewAsFrame | null): boolean {
  if (a == null || b == null) return a === b;
  return a.sessionId === b.sessionId && a.userId === b.userId && a.name === b.name;
}

export function setViewAsFrame(next: ViewAsFrame | null): void {
  if (sameFrame(frame, next)) return;
  frame = next;
  for (const listener of listeners) listener();
}

/**
 * The shell publishes the frame during render. A newer shell (device to desktop)
 * retains it before the previous shell's unmount release runs.
 */
export function retainViewAsFrame(next: ViewAsFrame | null): number {
  generation += 1;
  setViewAsFrame(next);
  return generation;
}

export function releaseViewAsFrame(claim: number): void {
  if (claim === generation) setViewAsFrame(null);
}

export function currentViewAsFrame(): ViewAsFrame | null {
  return frame;
}

export function viewAsSubjectId(): string | null {
  return frame?.userId ?? null;
}

export function subscribeViewAsFrame(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function viewAsRequestHeaders(current: ViewAsFrame): Record<string, string> {
  return {
    'X-Sim-Session': current.sessionId,
    'X-Sim-View-As': current.userId,
  };
}

/**
 * Returns the same object when no view-as shell is open, so a player request
 * keeps today's headers and nothing else.
 */
export function withViewAsHeaders(headers: Record<string, string>): Record<string, string> {
  if (!frame) return headers;
  return { ...headers, ...viewAsRequestHeaders(frame) };
}

/** Socket filters compare against the subject while a view-as shell is open. */
export function shellFilterUserId(
  subjectId: string | null,
  authUserId: string | null | undefined,
): string | null {
  return subjectId ?? authUserId ?? null;
}

/**
 * `messenger.received` with no target is the player's own outbound DM.
 * With no signed-in id, today's shell does not drop the event.
 */
export function messengerEventForUser(
  targetUserId: string,
  viewerUserId: string | null | undefined,
): boolean {
  if (!targetUserId) return false;
  if (!viewerUserId) return true;
  return targetUserId === viewerUserId;
}
