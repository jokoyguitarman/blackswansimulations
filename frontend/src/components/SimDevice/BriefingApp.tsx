import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { supabase } from '../../lib/supabase';
import { DESKTOP_CLOSE_APP_EVENT } from '../../lib/deviceNav';
import { websocketClient } from '../../lib/websocketClient';
import { crisisBriefLocked, showCrisisBriefSection } from '../../lib/briefingLock';
import { BriefingCrisisSection } from './BriefingCrisisSection';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';
function apiUrl(path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (API_BASE_URL) return `${API_BASE_URL.replace(/\/$/, '')}${cleanPath}`;
  return cleanPath;
}

export interface MyTeamBriefing {
  team_name: string;
  mission: string | null;
  responsibilities: string[];
  out_of_lane: string[];
}

export interface BoothBriefing {
  situation: string;
  goals: string | null;
}

/** The player's team charter for the session, or null when they have no team. */
export async function fetchMyTeam(sessionId: string): Promise<MyTeamBriefing | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const res = await fetch(apiUrl(`/api/social/my-team/session/${sessionId}`), {
    headers: { Authorization: `Bearer ${session?.access_token || ''}` },
  });
  if (!res.ok) return null;
  const json = await res.json();
  return (json.data as MyTeamBriefing | null) ?? null;
}

interface BriefingPayload {
  booth: BoothBriefing | null;
  general: string | null;
  crisisStartsAt: string | null;
}

function useBriefingPayload(sessionId: string | undefined): BriefingPayload | null {
  const [payload, setPayload] = useState<BriefingPayload | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    api.briefing
      .get(sessionId)
      .then((result) => {
        if (cancelled) return;
        setPayload({
          booth: result.data.booth ?? null,
          general: result.data.general_briefing ?? null,
          crisisStartsAt: result.data.crisis_starts_at ?? null,
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  return payload;
}

/** Booth worlds only: the opening situation and the goals every team shares. Null elsewhere. */
export function useBoothBriefing(sessionId: string | undefined): BoothBriefing | null {
  const payload = useBriefingPayload(sessionId);
  return useMemo(() => {
    if (!payload?.booth) return null;
    const locked = crisisBriefLocked({ crisis_starts_at: payload.crisisStartsAt });
    if (!locked) return payload.booth;
    return { situation: '', goals: null };
  }, [payload]);
}

const LABEL = 'text-[11px] font-semibold uppercase tracking-wider mb-1.5';

/** The desktop's Briefing window: the same briefing the phone shows on its home screen. */
export default function BriefingApp() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const briefing = useBriefingPayload(sessionId);
  const booth = briefing?.booth ?? null;
  const [team, setTeam] = useState<MyTeamBriefing | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [crisisOpened, setCrisisOpened] = useState(false);
  const clock = briefing ? { crisis_starts_at: briefing.crisisStartsAt } : null;
  const peaceClock = showCrisisBriefSection(clock);
  const locked = peaceClock && !crisisOpened && crisisBriefLocked(clock, now);

  useEffect(() => {
    if (!sessionId) return;
    return websocketClient.on('session.crisis_started', (event) => {
      const data = event.data as { session_id?: string } | undefined;
      if (!data?.session_id || data.session_id === sessionId) setCrisisOpened(true);
    });
  }, [sessionId]);

  useEffect(() => {
    if (!briefing?.crisisStartsAt || crisisOpened) return;
    const delay = Date.parse(briefing.crisisStartsAt) - Date.now();
    if (!Number.isFinite(delay) || delay <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [briefing?.crisisStartsAt, crisisOpened]);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    fetchMyTeam(sessionId)
      .then((t) => {
        if (!cancelled) setTeam(t);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const close = () =>
    window.dispatchEvent(
      new CustomEvent(DESKTOP_CLOSE_APP_EVENT, { detail: { appId: 'briefing' } }),
    );

  return (
    <div
      className="h-full flex flex-col"
      style={{
        backgroundColor: '#1C1C1E',
        color: '#fff',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <div className="flex-1 overflow-y-auto px-6 pt-5 pb-4 space-y-5">
        {loading ? (
          <p className="text-[13px]" style={{ color: 'rgba(255,255,255,0.6)' }}>
            Loading your briefing…
          </p>
        ) : !team ? (
          <p className="text-[13px]" style={{ color: 'rgba(255,255,255,0.6)' }}>
            You are not on a team in this simulation.
          </p>
        ) : (
          <>
            <div>
              <div className={LABEL} style={{ color: 'rgba(255,255,255,0.4)' }}>
                Your team
              </div>
              <h2 className="text-[18px] font-semibold mb-1">{team.team_name}</h2>
              {team.mission && (
                <p
                  className="text-[13px] leading-relaxed"
                  style={{ color: 'rgba(255,255,255,0.7)' }}
                >
                  {team.mission}
                </p>
              )}
            </div>

            {booth?.situation && !locked && (
              <div>
                <div className={LABEL} style={{ color: 'rgba(255,255,255,0.4)' }}>
                  What's going on
                </div>
                <p
                  className="text-[13px] leading-relaxed"
                  style={{ color: 'rgba(255,255,255,0.85)' }}
                >
                  {booth.situation}
                </p>
              </div>
            )}

            {team.responsibilities.length > 0 && (
              <div>
                <div className={LABEL} style={{ color: 'rgba(255,255,255,0.4)' }}>
                  Your responsibilities
                </div>
                <ul className="space-y-1.5">
                  {team.responsibilities.map((r, i) => (
                    <li
                      key={i}
                      className="text-[13px] leading-snug flex gap-2"
                      style={{ color: 'rgba(255,255,255,0.85)' }}
                    >
                      <span style={{ color: '#0A84FF' }}>•</span>
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {team.out_of_lane.length > 0 && (
              <div>
                <div className={LABEL} style={{ color: 'rgba(255,255,255,0.4)' }}>
                  Escalate, don't do
                </div>
                <ul className="space-y-1.5">
                  {team.out_of_lane.map((o, i) => (
                    <li
                      key={i}
                      className="text-[13px] leading-snug flex gap-2"
                      style={{ color: 'rgba(255,255,255,0.65)' }}
                    >
                      <span style={{ color: '#FF9F0A' }}>→</span>
                      <span>{o}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {peaceClock && (
              <BriefingCrisisSection
                locked={locked}
                text={locked ? null : briefing?.general ?? null}
              />
            )}

            {booth?.goals && !locked && (
              <div>
                <div className={LABEL} style={{ color: 'rgba(255,255,255,0.4)' }}>
                  What every team must do
                </div>
                <p
                  className="text-[13px] leading-relaxed"
                  style={{ color: 'rgba(255,255,255,0.75)' }}
                >
                  {booth.goals}
                </p>
              </div>
            )}
          </>
        )}
      </div>
      <div className="px-6 pb-5 pt-2">
        <button
          onClick={close}
          className="w-full py-2.5 rounded-xl text-[14px] font-semibold text-white border-0"
          style={{ backgroundColor: '#0A84FF' }}
        >
          Got it
        </button>
      </div>
    </div>
  );
}
