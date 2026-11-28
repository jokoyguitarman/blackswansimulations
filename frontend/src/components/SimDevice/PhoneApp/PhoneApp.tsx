import React, { useEffect, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { useWebSocket } from '../../../hooks/useWebSocket';
import { readAppIntent } from '../../../lib/appIntents';
import InCallScreen from './InCallScreen';
import { WhenWritable } from '../surfaceReadOnly';
import RecentsList from './RecentsList';
import { api } from '../../../lib/api';
import {
  browserCanCall,
  callbackCall,
  loadBadge,
  loadCall,
  loadCalls,
  markRecentsViewed,
  stashConnect,
  type CallSummary,
  type CallTurn,
} from './phoneClient';

// The node test runner compiles JSX to React.createElement.
void React;

export default function PhoneApp() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const location = useLocation();
  const intent = readAppIntent('phone', location.search);
  const initialTab =
    intent?.tab === 'missed' || new URLSearchParams(location.search).get('tab') === 'missed'
      ? 'missed'
      : 'all';
  const [filter, setFilter] = useState<'all' | 'missed'>(initialTab);
  const [calls, setCalls] = useState<CallSummary[]>([]);
  const [badge, setBadge] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(intent?.call ?? null);
  const [detail, setDetail] = useState<(CallSummary & { turns: CallTurn[] }) | null>(null);
  const [headerNote, setHeaderNote] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    void Promise.all([api.sessions.getCallLines(sessionId), api.sessions.getRoles(sessionId)])
      .then(([lines, roles]) => {
        const held = lines.data.flatMap((line) =>
          line.holders.map((holder) => `${line.team_name} line · held by ${holder.name}`),
        );
        const mine = roles.data.map(
          (role) =>
            `${role.title}: ${role.players.map((player) => player.name).join(', ') || 'unassigned'}`,
        );
        const note = [...held, ...mine].slice(0, 4).join(' · ');
        setHeaderNote(note || null);
      })
      .catch(() => setHeaderNote(null));
  }, [sessionId]);

  async function refresh() {
    if (!sessionId) return;
    const [next, missed] = await Promise.all([loadCalls(sessionId), loadBadge(sessionId)]);
    setCalls(next);
    setBadge(missed);
  }

  useEffect(() => {
    void refresh();
    if (sessionId && filter === 'missed') {
      void markRecentsViewed(sessionId).then(() => setBadge(0));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, filter]);

  useWebSocket({
    sessionId: sessionId || '',
    enabled: Boolean(sessionId),
    eventTypes: ['sim_call.missed', 'sim_call.ended', 'sim_call.ringing'],
    onEvent: () => {
      void refresh();
    },
  });

  useEffect(() => {
    if (!activeId) {
      setDetail(null);
      return;
    }
    void loadCall(activeId).then(setDetail);
  }, [activeId]);

  if (!sessionId) return null;

  if (
    activeId &&
    (detail?.status === 'active' || detail?.status === 'connecting' || intent?.call === activeId)
  ) {
    return (
      <InCallScreen sessionId={sessionId} callId={activeId} onClose={() => setActiveId(null)} />
    );
  }

  if (detail && activeId) {
    return (
      <div className="flex h-full flex-col bg-white text-[#172033]">
        <button
          type="button"
          className="px-4 pt-4 text-left text-sm text-sky-600"
          onClick={() => setActiveId(null)}
        >
          Recents
        </button>
        <div className="px-4 py-3">
          <h2 className="text-xl font-semibold">{detail.caller_name}</h2>
          <p className="text-sm text-black/50">
            {detail.status}
            {detail.answered_by_name ? ` · answered by ${detail.answered_by_name}` : ''}
            {detail.caller_missed_count > 1 ? ` · ${detail.caller_missed_count} missed` : ''}
          </p>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto px-4 pb-4 text-sm">
          {(detail.turns ?? []).map((turn) => (
            <p key={turn.seq}>
              <span className="font-semibold">{turn.speaker === 'player' ? 'YOU' : 'CALLER'}:</span>{' '}
              {turn.text}
            </p>
          ))}
          {(detail.turns ?? []).length === 0 && <p className="text-black/40">No transcript.</p>}
        </div>
        {detail.can_callback && (
          <WhenWritable>
            <button
              type="button"
              className="m-4 rounded-full bg-[#34C759] py-3 text-sm font-semibold text-white"
              onClick={() => void placeCallback(detail)}
            >
              Call back
            </button>
          </WhenWritable>
        )}
      </div>
    );
  }

  return (
    <RecentsList
      calls={calls}
      filter={filter}
      onFilter={setFilter}
      missedCount={badge}
      onOpen={(call) => setActiveId(call.id)}
      onCallback={(call) => void placeCallback(call)}
      headerNote={headerNote}
    />
  );

  async function placeCallback(call: CallSummary) {
    const result = await callbackCall(call.id, browserCanCall());
    if (result.status !== 200 || !result.body.mode || !result.body.call_id) return;
    stashConnect(result.body.call_id, result.body);
    setActiveId(result.body.call_id);
    void refresh();
  }
}
