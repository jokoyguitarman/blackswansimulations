import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from './supabase';

/**
 * Walk-up visitors at the D:NEXA booth (docs/booth/live-booth-spec.md) join through `dnx-` links. The
 * join page marks the session on this device, and the device shells then run in booth mode: a
 * full-screen phone on a real phone, and a sign-out after 10 minutes without a tap, after which only a
 * fresh scan of the booth's QR code lets the visitor back in. AI teammates and trainers never pass
 * through the join page, so their screens are unaffected.
 */
export const BOOTH_IDLE_MS = 10 * 60 * 1000;
export const BOOTH_ENDED_PATH = '/booth/ended';

const SESSIONS_KEY = 'booth_sessions';
const lastActiveKey = (sessionId: string) => `booth_last_active_${sessionId}`;

export function isBoothJoinToken(token: string | null | undefined): boolean {
  return typeof token === 'string' && token.startsWith('dnx-');
}

function boothSessions(): string[] {
  try {
    const ids = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]');
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch {
    return [];
  }
}

export function markBoothSession(sessionId: string): void {
  const ids = boothSessions().filter((id) => id !== sessionId);
  localStorage.setItem(SESSIONS_KEY, JSON.stringify([...ids, sessionId].slice(-20)));
  localStorage.setItem(lastActiveKey(sessionId), String(Date.now()));
}

export function isBoothSession(sessionId: string | undefined): boolean {
  return !!sessionId && boothSessions().includes(sessionId);
}

/** True on a phone-sized screen, in either orientation. */
export function usePhoneViewport(): boolean {
  const query = '(max-width: 500px), (max-height: 500px)';
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return matches;
}

/**
 * Booth visitors only: ends the visit after BOOTH_IDLE_MS without input, counting time the page was
 * closed or in the background, by signing out (which revokes the refresh token) and showing the
 * booth-ended page.
 */
export function useBoothIdleSignOut(sessionId: string | undefined): void {
  const navigate = useNavigate();
  useEffect(() => {
    if (!sessionId || !isBoothSession(sessionId)) return;
    const key = lastActiveKey(sessionId);
    let lastWrite = 0;
    let ended = false;

    const touch = () => {
      const now = Date.now();
      if (now - lastWrite < 5000) return;
      lastWrite = now;
      localStorage.setItem(key, String(now));
    };

    const end = async () => {
      if (ended) return;
      ended = true;
      localStorage.removeItem(key);
      localStorage.setItem(
        SESSIONS_KEY,
        JSON.stringify(boothSessions().filter((id) => id !== sessionId)),
      );
      // Leave the protected route first, or signing out would bounce the visitor to the login page.
      navigate(BOOTH_ENDED_PATH, { replace: true });
      try {
        await supabase.auth.signOut();
      } catch {
        await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
      }
    };

    const check = () => {
      const last = Number(localStorage.getItem(key) || 0);
      if (last && Date.now() - last >= BOOTH_IDLE_MS) void end();
    };

    check();
    if (ended) return;
    if (!localStorage.getItem(key)) localStorage.setItem(key, String(Date.now()));

    const events = ['pointerdown', 'touchstart', 'keydown', 'wheel', 'scroll'] as const;
    for (const e of events) window.addEventListener(e, touch, { capture: true, passive: true });
    const onVisibility = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(check, 15_000);

    return () => {
      for (const e of events) window.removeEventListener(e, touch, { capture: true });
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(timer);
    };
  }, [sessionId, navigate]);
}
