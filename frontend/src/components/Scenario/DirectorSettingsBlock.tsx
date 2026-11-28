import { useState } from 'react';
import type { DirectorMode } from '@shared/directorModes';

const APPS = ['email', 'group_chat', 'phone_call', 'npc_dm', 'messenger_dm', 'social_feed', 'news'] as const;

export interface DirectorSettings {
  mode?: DirectorMode;
  intensity?: 'low' | 'medium' | 'high';
  protected_teams?: Array<{ team_name?: string } | string>;
  allowed_apps?: string[];
  max_severity?: 'low' | 'medium' | 'high';
}

/**
 * Scenario default for the AI director, stored on initial_state.director.
 */
export function DirectorSettingsBlock({
  value,
  teams,
  locked,
  onSave,
}: {
  value: DirectorSettings | null;
  teams: string[];
  locked: boolean;
  onSave: (next: DirectorSettings) => Promise<void>;
}) {
  const [mode, setMode] = useState<DirectorMode | ''>(value?.mode ?? '');
  const [intensity, setIntensity] = useState(value?.intensity ?? 'medium');
  const [severity, setSeverity] = useState(value?.max_severity ?? 'high');
  const [apps, setApps] = useState<string[]>(
    value?.allowed_apps?.length ? value.allowed_apps : [...APPS],
  );
  const [protectedTeams, setProtectedTeams] = useState<string[]>(namesOf(value?.protected_teams));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <section className="mt-4 rounded border p-3" style={{ borderColor: '#E4DFD4' }} aria-label="AI director settings">
      <h3 className="text-sm font-bold" style={{ color: '#1E3A5F' }}>
        AI director
      </h3>
      <p className="text-[11px] mb-2" style={{ color: '#64748b' }}>
        Default for new sessions. A trainer can still change it in the lobby, and the ops ceiling can force it lower.
      </p>
      <div className="flex flex-wrap gap-3 text-xs">
        <label>
          Mode
          <select
            className="block mt-1 border rounded px-2 py-1"
            style={{ borderColor: '#E4DFD4' }}
            disabled={locked}
            value={mode}
            onChange={(event) => setMode(event.target.value as DirectorMode | '')}
          >
            <option value="">Auto (default)</option>
            <option value="auto">Auto</option>
            <option value="suggest">Suggest</option>
            <option value="off">Off</option>
          </select>
        </label>
        <label>
          Intensity
          <select
            className="block mt-1 border rounded px-2 py-1"
            style={{ borderColor: '#E4DFD4' }}
            disabled={locked}
            value={intensity}
            onChange={(event) => setIntensity(event.target.value as 'low' | 'medium' | 'high')}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
        <label>
          Max severity
          <select
            className="block mt-1 border rounded px-2 py-1"
            style={{ borderColor: '#E4DFD4' }}
            disabled={locked}
            value={severity}
            onChange={(event) => setSeverity(event.target.value as 'low' | 'medium' | 'high')}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
      </div>
      <div className="mt-2 text-xs">
        <div className="mb-1">Channels</div>
        <div className="flex flex-wrap gap-2">
          {APPS.map((app) => (
            <label key={app} className="inline-flex items-center gap-1">
              <input
                type="checkbox"
                disabled={locked}
                checked={apps.includes(app)}
                onChange={(event) => {
                  setApps((current) =>
                    event.target.checked ? [...current, app] : current.filter((item) => item !== app),
                  );
                }}
              />
              {app.replace('_', ' ')}
            </label>
          ))}
        </div>
      </div>
      {teams.length > 0 && (
        <div className="mt-2 text-xs">
          <div className="mb-1">Protected teams (no proposals)</div>
          <div className="flex flex-wrap gap-2">
            {teams.map((team) => (
              <label key={team} className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  disabled={locked}
                  checked={protectedTeams.includes(team)}
                  onChange={(event) => {
                    setProtectedTeams((current) =>
                      event.target.checked ? [...current, team] : current.filter((item) => item !== team),
                    );
                  }}
                />
                {team}
              </label>
            ))}
          </div>
        </div>
      )}
      <button
        type="button"
        className="mt-3 text-xs px-3 py-1.5 bg-brand text-white rounded disabled:opacity-40"
        disabled={locked || saving}
        onClick={() => {
          setSaving(true);
          setMsg(null);
          const next: DirectorSettings = {
            ...(mode ? { mode } : {}),
            intensity,
            max_severity: severity,
            allowed_apps: apps,
            protected_teams: protectedTeams.map((team_name) => ({ team_name })),
          };
          void onSave(next)
            .then(() => setMsg('Saved'))
            .catch((err: Error) => setMsg(err.message))
            .finally(() => setSaving(false));
        }}
      >
        Save director settings
      </button>
      {msg && <span className="ml-2 text-[11px]">{msg}</span>}
    </section>
  );
}

function namesOf(value: DirectorSettings['protected_teams']): string[] {
  if (!value) return [];
  return value
    .map((item) => (typeof item === 'string' ? item : item.team_name ?? ''))
    .filter(Boolean);
}
