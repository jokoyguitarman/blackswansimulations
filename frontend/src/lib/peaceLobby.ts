import { PEACE_PERIOD_DEFAULT_SECONDS, PEACE_PERIOD_MAX_SECONDS } from '@shared/peaceFeed';

export interface LobbyPeace {
  seconds: number;
}

/**
 * The lobby control is for the trainer starting a social session whose
 * payload already carries a peace offer. No network probe: the flag-off
 * session response simply omits `peace`.
 */
export function lobbyPeaceVisible(input: {
  social: boolean;
  trainer: boolean;
  peace: LobbyPeace | null | undefined;
}): boolean {
  if (!input.social || !input.trainer || !input.peace) return false;
  return Number.isFinite(input.peace.seconds);
}

export function lobbyPeaceMinutes(peace: LobbyPeace | null | undefined): number {
  const seconds =
    peace && Number.isFinite(peace.seconds) ? Number(peace.seconds) : PEACE_PERIOD_DEFAULT_SECONDS;
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
