import { PEACE_PERIOD_DEFAULT_SECONDS, PEACE_PERIOD_MAX_SECONDS } from '@shared/peaceFeed';

export interface LobbyPeaceFeed {
  seconds?: number;
  enabled?: boolean;
  posts?: unknown[];
}

/** The lobby control is for a trainer starting a social session that has a feed. */
export function lobbyPeaceVisible(input: {
  social: boolean;
  trainer: boolean;
  probeStatus: number | null;
  feed: LobbyPeaceFeed | null;
}): boolean {
  if (!input.social || !input.trainer) return false;
  if (input.probeStatus == null || input.probeStatus === 404) return false;
  if (!input.feed || !Array.isArray(input.feed.posts) || input.feed.posts.length === 0) return false;
  if (input.feed.enabled === false) return false;
  return true;
}

export function lobbyPeaceMinutes(feed: LobbyPeaceFeed | null): number {
  const seconds =
    feed && Number.isFinite(feed.seconds) ? Number(feed.seconds) : PEACE_PERIOD_DEFAULT_SECONDS;
  return Math.max(0, Math.round(seconds / 60));
}

/**
 * Seconds sent on the start PATCH. Undefined means the control is hidden and
 * the field is omitted. Off sends 0. On clamps the minutes field.
 */
export function lobbyPeaceSeconds(input: {
  shown: boolean;
  enabled: boolean;
  minutes: number;
}): number | undefined {
  if (!input.shown) return undefined;
  if (!input.enabled) return 0;
  const minutes = Number.isFinite(input.minutes) ? Math.floor(input.minutes) : 0;
  const seconds = Math.max(0, minutes) * 60;
  return Math.min(PEACE_PERIOD_MAX_SECONDS, seconds);
}
