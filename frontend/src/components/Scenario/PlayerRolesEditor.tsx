import { useState } from 'react';

export interface EditorRole {
  role_id: string;
  title: string;
  team_name: string;
  description: string;
  max_per_session: number;
}

export function readPlayerRoles(initialState: Record<string, unknown>): EditorRole[] {
  const raw = initialState.player_roles;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const roleId = typeof row.role_id === 'string' ? row.role_id : '';
    const title = typeof row.title === 'string' ? row.title : '';
    const team = typeof row.team_name === 'string' ? row.team_name : '';
    if (!roleId || !title || !team) return [];
    return [
      {
        role_id: roleId,
        title,
        team_name: team,
        description: typeof row.description === 'string' ? row.description : '',
        max_per_session: typeof row.max_per_session === 'number' ? row.max_per_session : 1,
      },
    ];
  });
}

function roleIdFromTitle(title: string, taken: string[]): string {
  let base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (base.length < 2) base = 'role';
  let id = base;
  let n = 2;
  while (taken.includes(id)) {
    const suffix = `_${n}`;
    id = `${base.slice(0, 40 - suffix.length)}${suffix}`;
    n += 1;
  }
  return id;
}

export function PlayerRolesSection({
  initialState,
  saveInitialState,
  teamList,
  injectList,
  locked,
}: {
  initialState: Record<string, unknown>;
  saveInitialState: (mutate: (state: Record<string, unknown>) => Record<string, unknown>) => Promise<unknown>;
  teamList: Array<{ team_name: string }>;
  injectList: Array<{ id: string; title: string; delivery_config?: Record<string, unknown> | null }>;
  locked: boolean;
}) {
  const roles = readPlayerRoles(initialState);
  const [title, setTitle] = useState('');
  const [team, setTeam] = useState(teamList[0]?.team_name ?? '');
  const [description, setDescription] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(1);
  const [error, setError] = useState<string | null>(null);

  async function save(next: EditorRole[]) {
    await saveInitialState((state) => ({
      ...state,
      player_roles: next,
      call_coverage_gate: 'enforce',
    }));
  }

  return (
    <section className="wr-map" aria-labelledby="scenario-roles-title">
      <h2 id="scenario-roles-title" className="text-sm font-extrabold">
        Player roles
      </h2>
      <p className="text-xs text-muted mb-2">
        Storylines address these by role id. Titles are display text and are never matched.
      </p>
      {roles.length === 0 && <p className="text-xs text-muted">No roles yet.</p>}
      <ul className="space-y-1 mb-3">
        {roles.map((role) => (
          <li key={role.role_id} className="text-xs flex items-center justify-between gap-2">
            <span>
              <b>{role.title}</b> · {role.role_id} · {role.team_name} · up to {role.max_per_session}
            </span>
            <button
              type="button"
              className="text-danger"
              disabled={locked}
              onClick={() => {
                const used = injectList.filter(
                  (inject) => inject.delivery_config?.target_role_id === role.role_id,
                );
                if (used.length > 0) {
                  setError(
                    `Can’t delete ${role.title}. It is used by: ${used.map((inject) => inject.title).join(', ')}`,
                  );
                  return;
                }
                setError(null);
                void save(roles.filter((item) => item.role_id !== role.role_id));
              }}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input
          className="text-xs border rounded px-2 py-1"
          placeholder="Title, e.g. Head of Customer Service"
          value={title}
          disabled={locked}
          onChange={(event) => setTitle(event.target.value)}
        />
        <select className="text-xs border rounded px-2 py-1" value={team} disabled={locked} onChange={(event) => setTeam(event.target.value)}>
          {teamList.map((item) => (
            <option key={item.team_name} value={item.team_name}>
              {item.team_name}
            </option>
          ))}
        </select>
        <input
          className="text-xs border rounded px-2 py-1"
          placeholder="Description"
          value={description}
          disabled={locked}
          onChange={(event) => setDescription(event.target.value)}
        />
        <input
          className="text-xs border rounded px-2 py-1"
          type="number"
          min={1}
          max={8}
          value={maxPlayers}
          disabled={locked}
          onChange={(event) => setMaxPlayers(Number(event.target.value) || 1)}
        />
      </div>
      <button
        type="button"
        className="wr-btn mt-2"
        disabled={locked || !title.trim() || !team}
        onClick={() => {
          const role_id = roleIdFromTitle(title, roles.map((role) => role.role_id));
          setError(null);
          void save([
            ...roles,
            { role_id, title: title.trim(), team_name: team, description: description.trim(), max_per_session: maxPlayers },
          ]).then(() => {
            setTitle('');
            setDescription('');
          });
        }}
      >
        Add role
      </button>
      {error && <p className="text-xs text-danger mt-2">{error}</p>}
    </section>
  );
}

const ROUTABLE = new Set(['phone_call', 'email', 'npc_dm', 'messenger_dm', 'group_chat']);

export interface SendToValue {
  mode: 'team' | 'role' | 'ring_all';
  roleId: string;
  fallback: 'none' | 'line' | 'line_after_minutes';
  minutes: number;
}

export function InjectSendTo({
  app,
  roles,
  targetTeams,
  value,
  onChange,
}: {
  app: string;
  roles: EditorRole[];
  targetTeams: string[];
  value: SendToValue;
  onChange: (next: SendToValue) => void;
}) {
  if (!ROUTABLE.has(app)) return null;
  const role = roles.find((item) => item.role_id === value.roleId);
  const mismatch = value.mode === 'role' && role && targetTeams.length > 0 && !targetTeams.includes(role.team_name);
  return (
    <fieldset className="mt-2 text-xs">
      <legend className="font-medium mb-1">Send to</legend>
      <label className="mr-3">
        <input type="radio" checked={value.mode === 'team'} onChange={() => onChange({ ...value, mode: 'team' })} /> Team
      </label>
      <label className="mr-3">
        <input type="radio" checked={value.mode === 'role'} onChange={() => onChange({ ...value, mode: 'role', roleId: value.roleId || roles[0]?.role_id || '' })} /> Role
      </label>
      <label>
        <input type="radio" checked={value.mode === 'ring_all'} onChange={() => onChange({ ...value, mode: 'ring_all' })} /> Everyone in targeted teams (legacy)
      </label>
      {value.mode === 'role' && (
        <div className="mt-2">
          <select
            className="border rounded px-2 py-1"
            value={value.roleId}
            onChange={(event) => onChange({ ...value, roleId: event.target.value })}
          >
            {roles.map((item) => (
              <option key={item.role_id} value={item.role_id}>
                {item.title}
              </option>
            ))}
          </select>
          <div className="mt-2">
            If the role’s player is away:
            <label className="block">
              <input type="radio" checked={value.fallback === 'none'} onChange={() => onChange({ ...value, fallback: 'none' })} /> keep it for them
            </label>
            <label className="block">
              <input type="radio" checked={value.fallback === 'line'} onChange={() => onChange({ ...value, fallback: 'line' })} /> send to the team line instead
            </label>
            <label className="block">
              <input
                type="radio"
                checked={value.fallback === 'line_after_minutes'}
                onChange={() => onChange({ ...value, fallback: 'line_after_minutes' })}
              />{' '}
              send to the team line after
              <input
                className="mx-1 w-12 border rounded px-1"
                type="number"
                min={1}
                max={60}
                value={value.minutes}
                onChange={(event) => onChange({ ...value, minutes: Number(event.target.value) || 10 })}
              />
              min
            </label>
          </div>
          {!role && <p className="text-danger mt-1">Choose a role that exists on this scenario.</p>}
          {mismatch && (
            <p className="text-warning mt-1">
              {role?.title} is on {role?.team_name}, which is not one of the targeted teams. The role still receives it.
            </p>
          )}
        </div>
      )}
    </fieldset>
  );
}
