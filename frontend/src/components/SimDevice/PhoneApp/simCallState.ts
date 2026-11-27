/** Overlay state for an incoming or live simulated call. Pure, so the transitions can be tested. */

export interface IncomingCall {
  call_id: string;
  caller_name: string;
  caller_number?: string | null;
  ring_deadline_at?: string;
  call_waiting?: boolean;
  line_team?: string | null;
  direction?: string;
}

export type SimCallUiState =
  | { kind: 'idle' }
  | { kind: 'ringing'; call: IncomingCall; callWaiting: boolean }
  | { kind: 'in_call'; callId: string; mode: 'voice' | 'text' }
  | { kind: 'ended'; callId: string; status: string };

export type SimCallUiEvent =
  | { type: 'sim_call.ringing'; data: IncomingCall }
  | { type: 'sim_call.taken'; data: { call_id: string } }
  | { type: 'sim_call.ended'; data: { call_id: string; status?: string } }
  | { type: 'answered'; callId: string; mode: 'voice' | 'text' }
  | { type: 'busy' }
  | { type: 'dismiss' };

export const idleCallState: SimCallUiState = { kind: 'idle' };

export function simCallReducer(state: SimCallUiState, event: SimCallUiEvent): SimCallUiState {
  if (event.type === 'sim_call.ringing') {
    const callWaiting = state.kind === 'in_call' || event.data.call_waiting === true;
    return { kind: 'ringing', call: event.data, callWaiting };
  }
  if (event.type === 'sim_call.taken') {
    if (state.kind === 'ringing' && state.call.call_id === event.data.call_id) return idleCallState;
    return state;
  }
  if (event.type === 'sim_call.ended') {
    const id = event.data.call_id;
    if (state.kind === 'ringing' && state.call.call_id === id) {
      return { kind: 'ended', callId: id, status: event.data.status ?? 'ended' };
    }
    if (state.kind === 'in_call' && state.callId === id) {
      return { kind: 'ended', callId: id, status: event.data.status ?? 'ended' };
    }
    return state;
  }
  if (event.type === 'answered') {
    return { kind: 'in_call', callId: event.callId, mode: event.mode };
  }
  if (event.type === 'busy') {
    if (state.kind === 'ringing') return { ...state, callWaiting: true };
    return state;
  }
  if (event.type === 'dismiss') return idleCallState;
  return state;
}
