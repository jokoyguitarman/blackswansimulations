import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { modeWithinCeiling, type DirectorMode } from '@shared/directorModes';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

function apiUrl(path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  if (API_BASE_URL) return `${API_BASE_URL.replace(/\/$/, '')}${clean}`;
  return clean;
}

interface DirectorView {
  enabled?: boolean;
  mode?: DirectorMode;
  modeMax?: DirectorMode;
  scenarioMode?: DirectorMode | null;
}

/**
 * Lobby control for the session's director mode. Hidden when the director is off.
 */
export function DirectorModeSelect({ sessionId }: { sessionId: string }) {
  const [view, setView] = useState<DirectorView | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void load(sessionId).then((data) => {
      if (!cancelled) setView(data);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (!view?.enabled) return null;
  const ceiling = view.modeMax ?? 'auto';
  const selected = view.mode ?? view.scenarioMode ?? 'auto';
  const modes: DirectorMode[] = ['off', 'suggest', 'auto'];

  return (
    <div className="wr-map">
      <div className="wr-sech" style={{ margin: '0 0 8px' }}>
        <h2>AI director</h2>
        <p>Auto publishes after a short veto window. Suggest waits for you. Off stays quiet.</p>
      </div>
      <div className="flex flex-wrap gap-3 text-sm">
        {modes.map((mode) => (
            <label key={mode} className="inline-flex items-center gap-1 capitalize">
              <input
                type="radio"
                name="lobby-director-mode"
                checked={selected === mode}
                disabled={!modeWithinCeiling(mode, ceiling) || saving}
                onChange={() => {
                  setSaving(true);
                  void save(sessionId, mode)
                    .then((data) => {
                      if (data) setView(data);
                    })
                    .finally(() => setSaving(false));
                }}
              />
              {mode}
            </label>
        ))}
      </div>
    </div>
  );
}

async function headers(): Promise<Record<string, string> | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;
  return {
    Authorization: `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
  };
}

async function load(sessionId: string): Promise<DirectorView | null> {
  const auth = await headers();
  if (!auth) return null;
  const response = await fetch(apiUrl(`/api/sessions/${sessionId}/director`), { headers: auth });
  if (!response.ok) return null;
  const body = (await response.json()) as { data?: DirectorView };
  return body.data ?? null;
}

async function save(sessionId: string, mode: DirectorMode): Promise<DirectorView | null> {
  const auth = await headers();
  if (!auth) return null;
  const response = await fetch(apiUrl(`/api/sessions/${sessionId}/director`), {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { data?: DirectorView };
  return body.data ?? null;
}
