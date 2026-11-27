import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  idleCallState,
  simCallReducer,
  type IncomingCall,
} from '../src/components/SimDevice/PhoneApp/simCallState';

const incoming: IncomingCall = {
  call_id: 'call-1',
  caller_name: 'Pastor Daniel',
  caller_number: '+60 9300 6062',
  ring_deadline_at: '2026-11-27T12:00:30.000Z',
};

test('an incoming call rings, a taken call clears, and the end state is kept', () => {
  const ringing = simCallReducer(idleCallState, { type: 'sim_call.ringing', data: incoming });
  assert.deepEqual(ringing, { kind: 'ringing', call: incoming, callWaiting: false });

  const taken = simCallReducer(ringing, { type: 'sim_call.taken', data: { call_id: 'call-1' } });
  assert.deepEqual(taken, { kind: 'idle' });

  const live = simCallReducer(ringing, { type: 'answered', callId: 'call-1', mode: 'voice' });
  const ended = simCallReducer(live, { type: 'sim_call.ended', data: { call_id: 'call-1', status: 'ended' } });
  assert.deepEqual(ended, { kind: 'ended', callId: 'call-1', status: 'ended' });
});

test('a busy user sees call waiting, with no answer path', () => {
  const waiting = simCallReducer(idleCallState, {
    type: 'sim_call.ringing',
    data: { ...incoming, call_waiting: true },
  });
  assert.equal(waiting.kind, 'ringing');
  if (waiting.kind === 'ringing') assert.equal(waiting.callWaiting, true);

  const inCall = simCallReducer(idleCallState, { type: 'answered', callId: 'other', mode: 'text' });
  const queued = simCallReducer(inCall, { type: 'sim_call.ringing', data: incoming });
  assert.deepEqual(queued, { kind: 'ringing', call: incoming, callWaiting: true });
});
