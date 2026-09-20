import { useCallback, useEffect, useState } from 'react';
import { api, type TeammateBotsView } from '../../lib/api';
import { websocketClient } from '../../lib/websocketClient';
import { BotBadge } from '../UI/BotBadge';
import { IntellectSlider } from './IntellectSlider';

/**
 * Lobby card: add an AI teammate to any team with one click, remove with one
 * click, and set the single session-wide intellect slider
 * (docs/ai-teammate-bots-plan.md §10.1). Trainer-only; hidden when the server
 * says the feature is off (404).
 */

interface Props {
  sessionId: string;
  sessionStatus: string;
  onChanged?: () => void;
}

export function AITeammatesPanel({ sessionId, sessionStatus, onChanged }: Props) {
  const [view, setView] = useState<TeammateBotsView | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busyTeam, setBusyTeam] = useState<string | null>(null);
  const [busyBot, setBusyBot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const finished = sessionStatus === 'completed' || sessionStatus === 'cancelled';

  const load = useCallback(async () => {
    try {
      const res = await api.bots.get(sessionId);
      setView(res.data);
      setHidden(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 404 = feature disabled on this server; anything else is shown inline.
      if (/not enabled|404/i.test(msg)) setHidden(true);
      else setError(msg);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), 15_000);
    const unsub = websocketClient.on('teammate_bots.settings_updated', (event) => {
      const intellect = (event.data as { intellect?: number } | undefined)?.intellect;
      if (typeof intellect === 'number') {
        setView((v) => (v ? { ...v, intellect } : v));
      }
    });
    return () => {
      clearInterval(interval);
      unsub();
    };
  }, [load]);

  if (hidden) return null;

  const addBot = async (teamName: string) => {
    setBusyTeam(teamName);
    setError(null);
    try {
      await api.bots.add(sessionId, teamName);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyTeam(null);
    }
  };

  const removeBot = async (userId: string) => {
    setBusyBot(userId);
    setError(null);
    try {
      await api.bots.remove(sessionId, userId);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyBot(null);
    }
  };

  const setIntellect = async (value: number) => {
    try {
      await api.bots.setIntellect(sessionId, value);
      setView((v) => (v ? { ...v, intellect: value } : v));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const total = view?.bots.length ?? 0;
  const max = view?.max_per_session ?? 0;
  const atCap = total >= max;

  return (
    <div className="bg-surface-2 border border-border rounded-lg p-4 mt-4">
      <div className="flex justify-between items-start gap-4 mb-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold uppercase tracking-wide text-brand">AI teammates</h3>
            <span className="text-[10px] text-muted">
              {total} / {max}
            </span>
            {view?.running && (
              <span className="text-[10px] font-bold uppercase text-success">playing</span>
            )}
          </div>
          <p className="text-xs text-muted mt-1">
            Fill empty seats with AI players. They join as ordinary participants, stay in their
            team&apos;s lane and play at the intellect you set here.
          </p>
        </div>
      </div>

      {view && (
        <div className="mb-4">
          <IntellectSlider value={view.intellect} onCommit={setIntellect} disabled={finished} />
        </div>
      )}

      {error && (
        <div className="border-l-4 border-danger bg-danger/10 rounded-md px-3 py-2 mb-3 text-xs text-ink">
          {error}
        </div>
      )}

      {!view ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : view.teams.length === 0 ? (
        <p className="text-xs text-muted">
          This scenario has no teams defined, so there are no seats to fill.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {view.teams.map((team) => {
            const bots = view.bots.filter((b) => b.team_name === team.team_name);
            const teamFull =
              team.max_participants !== null && team.members >= team.max_participants;
            const disabled = finished || atCap || teamFull || busyTeam === team.team_name;
            return (
              <div key={team.team_name} className="border border-border rounded-md p-3 bg-surface">
                <div className="flex items-center justify-between mb-2 gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-bold uppercase tracking-wide text-brand truncate">
                      {team.team_name}
                    </div>
                    <div className="text-[10px] text-muted">
                      {team.members - team.bots} human{team.members - team.bots === 1 ? '' : 's'} ·{' '}
                      {team.bots} bot{team.bots === 1 ? '' : 's'}
                      {team.max_participants !== null ? ` · cap ${team.max_participants}` : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => addBot(team.team_name)}
                    disabled={disabled}
                    className="military-button-outline px-3 py-1 text-xs whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                    title={
                      teamFull
                        ? 'Team is at its cap. Raise max participants in the scenario.'
                        : atCap
                          ? `At most ${max} AI teammates per session`
                          : 'Add an AI teammate to this team'
                    }
                  >
                    {busyTeam === team.team_name ? 'Adding…' : '+ Add bot'}
                  </button>
                </div>
                {bots.length === 0 ? (
                  <div className="text-[11px] text-muted">No AI teammates on this team.</div>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {bots.map((b) => (
                      <span
                        key={b.user_id}
                        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 pl-2 pr-1 py-0.5 text-xs text-ink"
                      >
                        {b.display_name}
                        <BotBadge />
                        <button
                          onClick={() => removeBot(b.user_id)}
                          disabled={busyBot === b.user_id || finished}
                          className="ml-0.5 rounded-full w-4 h-4 leading-4 text-center text-muted hover:text-danger disabled:opacity-50"
                          title="Remove this AI teammate"
                          aria-label={`Remove ${b.display_name}`}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
