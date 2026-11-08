export type IdleNoticeState =
  | { kind: 'hidden' }
  | { kind: 'warning'; reason: 'idle' | 'max_duration'; endsAt: string }
  | { kind: 'ended'; reason: 'idle' | 'max_duration' };

function isReason(value: unknown): value is 'idle' | 'max_duration' {
  return value === 'idle' || value === 'max_duration';
}

/** session.idle_warning shows the warning, session.idle_cleared hides an idle warning only, session.auto_ended shows the end. */
export function idleNoticeReducer(
  state: IdleNoticeState,
  event: { type: string; data: Record<string, unknown> },
): IdleNoticeState {
  if (event.type === 'session.idle_cleared') {
    if (state.kind === 'warning' && state.reason === 'idle') return { kind: 'hidden' };
    return state;
  }
  if (event.type === 'session.idle_warning') {
    const endsAt = event.data.ends_at;
    if (isReason(event.data.reason) && typeof endsAt === 'string') {
      return { kind: 'warning', reason: event.data.reason, endsAt };
    }
    return state;
  }
  if (event.type === 'session.auto_ended' && isReason(event.data.reason)) {
    return { kind: 'ended', reason: event.data.reason };
  }
  return state;
}

/** The banner's words, from the state, the settings in the event and the viewer's role. */
export function idleNoticeCopy(
  state: IdleNoticeState,
  input: {
    role: 'trainer' | 'player';
    idleEndMinutes: number;
    idleWarnMinutes: number;
    maxHours: number;
    formatTime: (iso: string) => string;
  },
): { text: string; action: 'still_here' | 'open_aar' | null } | null {
  if (state.kind === 'hidden') return null;
  if (state.kind === 'warning' && state.reason === 'idle') {
    const quietFor = input.idleEndMinutes - input.idleWarnMinutes;
    return {
      text: `No player activity for ${quietFor} minutes. This session ends automatically at ${input.formatTime(state.endsAt)} unless someone acts.`,
      action: 'still_here',
    };
  }
  if (state.kind === 'warning') {
    return {
      text: `This session reaches its ${input.maxHours}-hour limit at ${input.formatTime(state.endsAt)} and will end then.`,
      action: null,
    };
  }
  const action = input.role === 'trainer' ? 'open_aar' : null;
  if (state.reason === 'idle') {
    return {
      text: `This session has ended: no player activity for ${input.idleEndMinutes} minutes.`,
      action,
    };
  }
  return {
    text: `This session has ended: it reached its ${input.maxHours}-hour limit.`,
    action,
  };
}
