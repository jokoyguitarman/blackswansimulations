import { useEffect, useState } from 'react';
import { useWebSocket } from '../../hooks/useWebSocket';
import { loadCalls, type CallSummary, type CallTurn } from './PhoneApp/phoneClient';

/** Trainer view of calls that are ringing or connected, with live captions. */
export function LiveCallsPanel({ sessionId }: { sessionId: string }) {
  const [calls, setCalls] = useState<CallSummary[]>([]);
  const [turns, setTurns] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const pull = () => {
      void loadCalls(sessionId).then((rows) => {
        if (cancelled) return;
        setCalls(rows.filter((call) => call.status === 'ringing' || call.status === 'connecting' || call.status === 'active'));
      });
    };
    pull();
    const interval = setInterval(pull, 10000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [sessionId]);

  useWebSocket({
    sessionId,
    enabled: Boolean(sessionId),
    eventTypes: ['sim_call.turn', 'sim_call.state', 'sim_call.ended', 'sim_call.ringing'],
    onEvent: (event) => {
      const data = event.data as { call_id?: string; turn?: CallTurn; status?: string };
      if (event.type === 'sim_call.turn' && data.call_id && data.turn) {
        const label = data.turn.speaker === 'player' ? 'YOU' : 'CALLER';
        setTurns((current) => ({ ...current, [data.call_id!]: `${label}: ${data.turn!.text}` }));
      }
      if (event.type === 'sim_call.ringing' || event.type === 'sim_call.ended' || event.type === 'sim_call.state') {
        void loadCalls(sessionId).then((rows) => {
          setCalls(rows.filter((call) => call.status === 'ringing' || call.status === 'connecting' || call.status === 'active'));
        });
      }
    },
  });

  return (
    <section className="rounded-xl border border-black/10 bg-white p-4">
      <h3 className="text-sm font-semibold text-[#172033]">Live calls</h3>
      {calls.length === 0 && <p className="mt-2 text-xs text-black/40">No calls in progress.</p>}
      <ul className="mt-2 space-y-2">
        {calls.map((call) => (
          <li key={call.id} className="rounded-lg bg-black/[0.03] px-3 py-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{call.caller_name}</span>
              <span className="text-black/50">
                {call.status}
                {call.mode ? ` · ${call.mode}` : ''}
                {call.answered_by_name ? ` · ${call.answered_by_name}` : ''}
              </span>
            </div>
            {turns[call.id] && <p className="mt-1 text-black/70">{turns[call.id]}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
