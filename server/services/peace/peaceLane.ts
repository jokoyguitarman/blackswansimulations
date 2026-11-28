/**
 * Peace-lane hook. WP3 publishes the feed and calls
 * `runEngagementTick(sessionId, { ambient: false })` from here.
 * WP1 leaves the hook empty.
 */

export interface PeaceLaneSession {
  id: string;
  start_time?: string | null;
  opened_at?: string | null;
}

export type PeaceLaneHook = (session: PeaceLaneSession) => Promise<void>;

const emptyHook: PeaceLaneHook = async () => {};

let hook: PeaceLaneHook = emptyHook;

export async function runPeaceLane(session: PeaceLaneSession): Promise<void> {
  await hook(session);
}

/** Tests install a spy. Production keeps the empty hook. */
export function setPeaceLaneHookForTests(next: PeaceLaneHook | null): void {
  hook = next ?? emptyHook;
}
