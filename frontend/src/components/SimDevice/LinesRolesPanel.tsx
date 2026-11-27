import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

/** Trainer console: who holds each line and role, and what to do when someone is unreachable. */
export function LinesRolesPanel({ sessionId }: { sessionId: string }) {
  const [lines, setLines] = useState<Array<{ team_name: string; holders: Array<{ user_id: string; name: string; online: boolean; source: string }>; unattended_since: string | null }>>([]);
  const [roles, setRoles] = useState<Array<{ role_id: string; title: string; team_name: string; players: Array<{ user_id: string; name: string; online: boolean }> }>>([]);
  const [note, setNote] = useState<string | null>(null);

  async function refresh() {
    const [lineResult, roleResult] = await Promise.all([
      api.sessions.getCallLines(sessionId),
      api.sessions.getRoles(sessionId),
    ]);
    setLines(lineResult.data);
    setRoles(roleResult.data);
  }

  useEffect(() => {
    if (!sessionId) return;
    void refresh().catch(() => setNote('Lines and roles are unavailable until migration 271 is applied.'));
  }, [sessionId]);

  return (
    <section className="rounded-xl border border-black/10 bg-white p-4">
      <h3 className="text-sm font-semibold text-[#172033]">Lines & roles</h3>
      {note && <p className="mt-2 text-xs text-black/50">{note}</p>}
      <ul className="mt-2 space-y-2 text-xs">
        {lines.map((line) => (
          <li key={line.team_name} className="rounded-lg bg-black/[0.03] px-3 py-2">
            <div className="font-medium">
              Line {line.team_name}
              {line.unattended_since ? ' · unattended' : ''}
            </div>
            <div className="text-black/60">
              {line.holders.length === 0
                ? '— no holder —'
                : line.holders.map((holder) => `${holder.online ? '●' : '○'} ${holder.name}${holder.source === 'lobby_autofill' || holder.source === 'auto_reassign' ? ' (auto)' : ''}`).join('  ')}
            </div>
          </li>
        ))}
        {roles.map((role) => {
          const offline = role.players.length > 0 && role.players.every((player) => !player.online);
          return (
            <li key={role.role_id} className="rounded-lg bg-black/[0.03] px-3 py-2">
              <div className="font-medium">
                Role {role.title}
                {offline ? ' · unreachable' : ''}
              </div>
              <div className="text-black/60">
                {role.players.length === 0
                  ? '— nobody —'
                  : role.players.map((player) => `${player.online ? '●' : '○'} ${player.name}`).join('  ')}
              </div>
              {offline && (
                <button
                  type="button"
                  className="mt-1 text-sky-700"
                  onClick={() => {
                    void api.sessions.rerouteRole(sessionId, role.role_id).then(() => {
                      setNote(`Rerouted pending contact for ${role.title}.`);
                      return refresh();
                    });
                  }}
                >
                  Reroute pending to the {role.team_name} line
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
