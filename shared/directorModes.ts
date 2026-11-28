/**
 * Director mode resolution and the pending-proposal schedule.
 * No environment access: callers pass the values they read.
 */

export type DirectorMode = 'off' | 'suggest' | 'auto';
export type DirectorSeverity = 'low' | 'medium' | 'high';

const MODE_RANK: Record<DirectorMode, number> = { off: 0, suggest: 1, auto: 2 };
const SEVERITY_RANK: Record<DirectorSeverity, number> = { low: 1, medium: 2, high: 3 };

export interface DirectorModeEnv {
  enabled: boolean;
  /** Ops ceiling. A higher session or scenario mode is lowered to this. */
  modeMax: DirectorMode;
  /** Used when neither the session nor the scenario sets a mode. */
  defaultMode: DirectorMode;
}

export function parseDirectorMode(value: unknown): DirectorMode | null {
  if (value === 'off' || value === 'suggest' || value === 'auto') return value;
  return null;
}

export function parseDirectorSeverity(value: unknown): DirectorSeverity | null {
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  return null;
}

/**
 * `DIRECTOR_ENABLED` off → `off`.
 * Otherwise session override, then scenario default, then `DIRECTOR_DEFAULT_MODE`.
 * The result is capped by `DIRECTOR_MODE_MAX`.
 */
export function resolveDirectorMode(
  env: DirectorModeEnv,
  session: { mode?: string | null } | null | undefined,
  scenario: { mode?: string | null } | null | undefined,
): DirectorMode {
  if (!env.enabled) return 'off';
  const ceiling = parseDirectorMode(env.modeMax) ?? 'auto';
  const fallback = parseDirectorMode(env.defaultMode) ?? 'auto';
  const chosen =
    parseDirectorMode(session?.mode) ?? parseDirectorMode(scenario?.mode) ?? fallback;
  return MODE_RANK[chosen] > MODE_RANK[ceiling] ? ceiling : chosen;
}

/** A trainer may set a mode only when it is at or below the ops ceiling. */
export function modeWithinCeiling(mode: DirectorMode, ceiling: DirectorMode): boolean {
  const cap = parseDirectorMode(ceiling) ?? 'auto';
  return MODE_RANK[mode] <= MODE_RANK[cap];
}

/** `high` inside auto (above `DIRECTOR_AUTO_MAX_SEVERITY`) waits for approval. */
export function needsTrainerApproval(
  mode: DirectorMode,
  severity: DirectorSeverity,
  autoMaxSeverity: DirectorSeverity,
): boolean {
  if (mode !== 'auto') return true;
  return SEVERITY_RANK[severity] > SEVERITY_RANK[autoMaxSeverity];
}

export type ModeSwitchEffect = 'none' | 'convert_countdowns' | 'expire_pending';

/**
 * Auto → suggest clears countdowns (they become suggestions).
 * Any mode → off expires every pending proposal.
 */
export function modeSwitchEffect(from: DirectorMode, to: DirectorMode): ModeSwitchEffect {
  if (from === to) return 'none';
  if (to === 'off') return 'expire_pending';
  if (from === 'auto' && to === 'suggest') return 'convert_countdowns';
  return 'none';
}

export function suggestionExpiresAt(createdAt: string, ttlMinutes: number): number {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return 0;
  return created + ttlMinutes * 60_000;
}
