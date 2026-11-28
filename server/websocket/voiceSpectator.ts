/**
 * Voice events from a socket that is not in the call. Applied only when
 * ENABLE_STAFF_VIEW_AS is on. With the flag off every event is allowed,
 * which is today's behaviour.
 */

export type VoiceMembership = 'member' | 'outsider' | 'unknown';

export function allowVoiceInitiate(enabled: boolean, sessionParticipant: boolean): boolean {
  if (!enabled) return true;
  return sessionParticipant;
}

/**
 * `unknown` means the call is not in this process (a restart, or a signal
 * that arrived first). The caller then checks `voice_calls.participants`.
 */
export function allowVoiceSignal(
  enabled: boolean,
  membership: VoiceMembership,
  dbMember: boolean | null,
): boolean {
  if (!enabled) return true;
  if (membership === 'member') return true;
  if (membership === 'outsider') return false;
  return dbMember === true;
}
