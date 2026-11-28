/**
 * Peace-lane hook. The scheduler calls this and returns while the session
 * is in peace. The publisher is the production hook; tests install a spy.
 */

import { publishPeaceFeed } from './peacePublisher.js';

export interface PeaceLaneSession {
  id: string;
  start_time?: string | null;
  opened_at?: string | null;
}

export type PeaceLaneHook = (session: PeaceLaneSession) => Promise<void>;

let hook: PeaceLaneHook = publishPeaceFeed;

export async function runPeaceLane(session: PeaceLaneSession): Promise<void> {
  await hook(session);
}

/** Tests install a spy. Passing null restores the publisher. */
export function setPeaceLaneHookForTests(next: PeaceLaneHook | null): void {
  hook = next ?? publishPeaceFeed;
}
