import { useEffect, useRef, useState } from 'react';
import { useWebSocket } from '../../../hooks/useWebSocket';
import type { CallTurn } from './phoneClient';
import {
  connectRealtimeVoice,
  hangupCall,
  loadCall,
  phoneApiUrl,
  phoneAuthHeaders,
  sendTextTurn,
  takeConnect,
  type ConnectAnswer,
} from './phoneClient';

interface Props {
  sessionId: string;
  callId: string;
  onClose: () => void;
}

export default function InCallScreen({ sessionId, callId, onClose }: Props) {
  const [caller, setCaller] = useState('Call');
  const [mode, setMode] = useState<'voice' | 'text'>('text');
  const [turns, setTurns] = useState<CallTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [muted, setMuted] = useState(false);
  const [ended, setEnded] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const voice = useRef<{ hangup: () => void; mute: (muted: boolean) => void } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const started = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const detail = await loadCall(callId).catch(() => null);
      if (cancelled) return;
      if (detail) {
        setCaller(detail.caller_name);
        setTurns(detail.turns ?? []);
        if (detail.mode) setMode(detail.mode);
        if (detail.status === 'ended' || detail.status === 'missed' || detail.status === 'declined') setEnded(true);
      }
      if (started.current) return;
      started.current = true;
      const connect = takeConnect(callId);
      if (connect?.mode === 'text') {
        setMode('text');
        if (connect.opening) {
          setTurns((current) =>
            current.some((turn) => turn.text === connect.opening)
              ? current
              : [...current, { seq: 0, speaker: 'npc', text: connect.opening, at: new Date().toISOString() }],
          );
        }
        if (connect.ended) setEnded(true);
        return;
      }
      if (connect?.mode === 'voice') await startVoice(connect);
    })();
    return () => {
      cancelled = true;
      voice.current?.hangup();
    };
    // The connect stash is read once per call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId]);

  useWebSocket({
    sessionId,
    eventTypes: ['sim_call.turn', 'sim_call.state', 'sim_call.ended'],
    onEvent: (event) => {
      const data = event.data as { call_id?: string; turn?: CallTurn; mode?: 'voice' | 'text'; relay?: boolean };
      if (data.call_id !== callId) return;
      if (event.type === 'sim_call.turn' && data.turn) setTurns((current) => [...current, data.turn!]);
      if (event.type === 'sim_call.state' && data.mode) setMode(data.mode);
      if (event.type === 'sim_call.state' && data.relay) void dropToText();
      if (event.type === 'sim_call.ended') setEnded(true);
    },
  });

  async function startVoice(connect: Extract<ConnectAnswer, { mode: 'voice' }>) {
    setMode('voice');
    const startedAt = Date.now();
    const link = await connectRealtimeVoice({
      answer: connect,
      onRemoteTrack: (stream) => {
        if (audioRef.current) {
          audioRef.current.srcObject = stream;
          audioRef.current.play().catch(() => undefined);
        }
      },
      onEvent: () => undefined,
      onFailure: () => void dropToText(),
    });
    voice.current = link;
    if (!link.callId) return;
    await fetchAttach(callId, link.callId, Date.now() - startedAt);
  }

  async function dropToText() {
    setMode('text');
    const result = await sendTextTurn(callId, '');
    if (result.reply) {
      setTurns((current) => [
        ...current,
        { seq: current.length + 1, speaker: 'system', text: result.reply, at: new Date().toISOString() },
      ]);
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || ended) return;
    setDraft('');
    setTurns((current) => [
      ...current,
      { seq: current.length + 1, speaker: 'player', text, at: new Date().toISOString() },
    ]);
    const result = await sendTextTurn(callId, text);
    if (result.reply) {
      setTurns((current) => [
        ...current,
        { seq: current.length + 1, speaker: 'npc', text: result.reply, at: new Date().toISOString() },
      ]);
    }
    if (result.ended) setEnded(true);
  }

  async function end() {
    voice.current?.hangup();
    await hangupCall(callId);
    setEnded(true);
    onClose();
  }

  const clock = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;

  return (
    <div className="flex h-full flex-col bg-[#111] text-white">
      <audio ref={audioRef} autoPlay />
      <header className="px-4 pb-2 pt-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{caller}</h2>
          <span className="text-sm tabular-nums text-white/70">{clock}</span>
        </div>
        <p className="mt-1 text-xs text-emerald-300">
          ● Connected ({mode === 'voice' ? 'voice' : 'text — voice unavailable'})
        </p>
      </header>
      <div className="mx-3 flex-1 space-y-2 overflow-y-auto rounded-2xl bg-white/5 p-3 text-sm">
        {turns.map((turn) => (
          <p key={`${turn.seq}-${turn.at}`} className={turn.speaker === 'player' ? 'text-sky-200' : 'text-white/90'}>
            <span className="font-semibold">
              {turn.speaker === 'player' ? 'YOU' : turn.speaker === 'system' ? 'LINE' : 'CALLER'}:
            </span>{' '}
            {turn.text}
          </p>
        ))}
        {turns.length === 0 && <p className="text-white/40">Connecting…</p>}
      </div>
      {mode === 'text' && !ended && (
        <form
          className="flex gap-2 px-3 pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={1000}
            placeholder="Message"
            className="flex-1 rounded-full bg-white/10 px-4 py-2 text-sm outline-none"
          />
          <button type="submit" className="rounded-full bg-sky-500 px-4 text-sm font-semibold">
            Send
          </button>
        </form>
      )}
      <div className="flex items-center justify-center gap-6 px-4 py-4">
        {mode === 'voice' && (
          <button
            type="button"
            className="rounded-full bg-white/10 px-4 py-2 text-sm"
            onClick={() => {
              const next = !muted;
              setMuted(next);
              voice.current?.mute(next);
            }}
          >
            {muted ? 'Unmute' : 'Mute'}
          </button>
        )}
        <button type="button" onClick={() => void end()} className="rounded-full bg-[#FF3B30] px-6 py-3 text-sm font-semibold">
          End
        </button>
      </div>
    </div>
  );
}

async function fetchAttach(callId: string, openaiCallId: string, firstAudioMs: number): Promise<void> {
  await fetch(phoneApiUrl(`/api/calls/${callId}/attach`), {
    method: 'POST',
    headers: await phoneAuthHeaders(),
    body: JSON.stringify({ openai_call_id: openaiCallId, first_audio_ms: firstAudioMs }),
  });
}
