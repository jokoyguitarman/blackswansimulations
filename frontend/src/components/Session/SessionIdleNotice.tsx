import { useRef, useState } from 'react';
import { useWebSocket } from '../../hooks/useWebSocket';
import { sendKeepalive } from './sessionIdleApi';
import { idleNoticeCopy, idleNoticeReducer, type IdleNoticeState } from './sessionIdleNoticeModel';

interface IdleNoticeSettings {
  idleEndMinutes: number;
  idleWarnMinutes: number;
  maxHours: number;
}

const UNSET: IdleNoticeSettings = { idleEndMinutes: 0, idleWarnMinutes: 0, maxHours: 0 };

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function formatIdleTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Warning and end banner for one session. The events carry the three settings. */
export function SessionIdleNotice({
  sessionId,
  role,
}: {
  sessionId: string;
  role: 'trainer' | 'player';
}) {
  const [state, setState] = useState<IdleNoticeState>({ kind: 'hidden' });
  const [settings, setSettings] = useState<IdleNoticeSettings>(UNSET);
  const [acked, setAcked] = useState(false);
  const [sending, setSending] = useState(false);
  const eventEpoch = useRef(0);

  useWebSocket({
    sessionId,
    eventTypes: ['session.idle_warning', 'session.idle_cleared', 'session.auto_ended'],
    onEvent: (event) => {
      eventEpoch.current += 1;
      setAcked(false);
      const data = event.data ?? {};
      setSettings((prev) => ({
        idleEndMinutes: finiteNumber(data.idle_end_minutes, prev.idleEndMinutes),
        idleWarnMinutes: finiteNumber(data.idle_warn_minutes, prev.idleWarnMinutes),
        maxHours: finiteNumber(data.max_hours, prev.maxHours),
      }));
      setState((prev) => idleNoticeReducer(prev, { type: event.type, data }));
    },
  });

  const onStillHere = async () => {
    if (sending) return;
    const mark = eventEpoch.current;
    setSending(true);
    try {
      await sendKeepalive(sessionId);
      if (eventEpoch.current === mark) setAcked(true);
    } catch {
      setAcked(false);
    } finally {
      setSending(false);
    }
  };

  const copy = idleNoticeCopy(state, { role, ...settings, formatTime: formatIdleTime });
  const showThanks = acked && state.kind !== 'ended';
  if (showThanks) {
    return (
      <div
        role="status"
        className="flex w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-amber-100 px-4 py-2 text-center text-sm text-amber-950"
      >
        <span>Thanks, the session continues.</span>
      </div>
    );
  }
  if (!copy) return null;

  return (
    <div
      role={state.kind === 'ended' ? 'alert' : 'status'}
      className={`flex w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2 text-center text-sm ${
        state.kind === 'ended' ? 'bg-red-100 text-red-950' : 'bg-amber-100 text-amber-950'
      }`}
    >
      <span>{copy.text}</span>
      {copy.action === 'still_here' ? (
        <button
          type="button"
          className="inline-flex items-center rounded border border-current px-2 py-1 text-xs font-medium disabled:opacity-60"
          disabled={sending}
          onClick={() => void onStillHere()}
        >
          I'm still here
        </button>
      ) : null}
      {copy.action === 'open_aar' ? (
        <a className="font-medium underline" href={`/sessions/${sessionId}/aar`}>
          Open the After-Action Review
        </a>
      ) : null}
    </div>
  );
}
