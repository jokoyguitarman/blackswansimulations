/**
 * Library card lock. A live session locks everyone. Admins skip the
 * session-credit lock, matching canEditScenario and CreateSessionModal.
 * An unknown balance (null) stays editable; the server still enforces.
 */
export type ScenarioLockState = 'editable' | 'locked-live' | 'locked-credits' | 'draft';

export interface ScenarioLockInput {
  is_active: boolean;
  summary?: { live_session_id?: string | null } | null;
}

export function scenarioLockState(
  scenario: ScenarioLockInput,
  isAdmin: boolean,
  sessionCredits: number | null,
): ScenarioLockState {
  if (scenario.summary?.live_session_id) return 'locked-live';
  if (!scenario.is_active) return 'draft';
  if (!isAdmin && sessionCredits === 0) return 'locked-credits';
  return 'editable';
}
