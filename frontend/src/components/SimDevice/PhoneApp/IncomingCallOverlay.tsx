import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useWebSocket } from '../../../hooks/useWebSocket';
import { openAppWithIntent } from '../../../lib/appIntents';
import {
  idleCallState,
  simCallReducer,
  type IncomingCall,
  type SimCallUiState,
} from './simCallState';
import { answerCall, browserCanCall, declineCall, stashConnect } from './phoneClient';

let audioUnlocked = false;
if (typeof window !== 'undefined') {
  const unlock = () => {
    audioUnlocked = true;
    window.removeEventListener('pointerdown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
}

/** Incoming-call sheet rendered above every app in the phone and the desktop. */
export default function IncomingCallOverlay() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [state, setState] = useState<SimCallUiState>(idleCallState);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useWebSocket({
    sessionId: sessionId || '',
    enabled: Boolean(sessionId),
    eventTypes: ['sim_call.ringing', 'sim_call.taken', 'sim_call.ended'],
    onEvent: (event) => {
      if (event.type === 'sim_call.ringing') {
        setState((current) =>
          simCallReducer(current, { type: 'sim_call.ringing', data: event.data as unknown as IncomingCall }),
        );
      } else if (event.type === 'sim_call.taken') {
        setState((current) =>
          simCallReducer(current, {
            type: 'sim_call.taken',
            data: event.data as { call_id: string },
          }),
        );
      } else if (event.type === 'sim_call.ended') {
        setState((current) =>
          simCallReducer(current, {
            type: 'sim_call.ended',
            data: event.data as { call_id: string; status?: string },
          }),
        );
      }
    },
  });

  const ringing = state.kind === 'ringing' ? state : null;

  useEffect(() => {
    if (!ringing?.call.ring_deadline_at) {
      setSecondsLeft(null);
      return;
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((Date.parse(ringing.call.ring_deadline_at!) - Date.now()) / 1000));
      setSecondsLeft(left);
    };
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [ringing]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (ringing && audioUnlocked) {
      audio.play().catch(() => undefined);
    } else {
      audio.pause();
      audio.currentTime = 0;
    }
  }, [ringing]);

  if (!sessionId || !ringing) return <audio ref={audioRef} src="/sounds/ringtone.mp3" loop preload="none" />;

  async function answer() {
    if (!ringing || ringing.callWaiting || busy) return;
    setBusy(true);
    const capabilities = browserCanCall();
    const result = await answerCall(ringing.call.call_id, capabilities);
    setBusy(false);
    if (result.status === 409) {
      setState((current) => simCallReducer(current, { type: 'busy' }));
      return;
    }
    if (result.status !== 200 || !result.body.mode) return;
    stashConnect(ringing.call.call_id, result.body);
    setState(simCallReducer(ringing, { type: 'answered', callId: ringing.call.call_id, mode: result.body.mode }));
    openAppWithIntent(navigate, `/sim/${sessionId}`, location.pathname, 'phone', {
      call: ringing.call.call_id,
    });
  }

  async function decline() {
    if (!ringing || busy) return;
    setBusy(true);
    await declineCall(ringing.call.call_id);
    setBusy(false);
    setState(idleCallState);
  }

  const mm = secondsLeft == null ? '' : `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;

  return (
    <div className="absolute inset-0 z-[80] flex items-end justify-center bg-black/55 p-4">
      <audio ref={audioRef} src="/sounds/ringtone.mp3" loop preload="auto" />
      <div className="w-full max-w-sm rounded-3xl bg-[#1c1c1e] px-6 pb-8 pt-8 text-center text-white shadow-2xl">
        <p className="text-xs uppercase tracking-[0.2em] text-white/60">
          {ringing.callWaiting ? 'Call waiting' : 'Incoming call'}
        </p>
        <div
          className="mx-auto mt-5 flex h-20 w-20 items-center justify-center rounded-full bg-white/10 text-3xl"
          style={{ animation: audioUnlocked ? undefined : 'phone-ring 0.6s ease-in-out infinite' }}
        >
          {ringing.call.caller_name.slice(0, 1)}
        </div>
        <h2 className="mt-4 text-2xl font-semibold">{ringing.call.caller_name}</h2>
        {ringing.call.role_title && (
          <p className="text-sm text-black/60">Call for {ringing.call.role_title}</p>
        )}
        {ringing.call.caller_number && <p className="mt-1 text-sm text-white/70">{ringing.call.caller_number}</p>}
        {ringing.call.line_team && <p className="mt-1 text-sm text-white/50">{ringing.call.line_team}</p>}
        <p className="mt-4 text-sm text-white/60">
          {ringing.callWaiting ? 'You are already on a call' : mm ? `ringing · ${mm} left` : 'ringing'}
        </p>
        <div className="mt-8 flex items-center justify-center gap-16">
          <button type="button" onClick={decline} className="flex flex-col items-center gap-2" aria-label="Decline">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[#FF3B30] text-2xl">✕</span>
            <span className="text-xs">Decline</span>
          </button>
          {!ringing.callWaiting && (
            <button type="button" onClick={answer} className="flex flex-col items-center gap-2" aria-label="Answer">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[#34C759] text-2xl">☎</span>
              <span className="text-xs">Answer</span>
            </button>
          )}
        </div>
      </div>
      <style>{`@keyframes phone-ring { 0%,100% { transform: rotate(0); } 25% { transform: rotate(-8deg); } 75% { transform: rotate(8deg); } }`}</style>
    </div>
  );
}
