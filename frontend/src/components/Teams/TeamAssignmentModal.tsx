import { useState, useEffect, useMemo } from 'react';
import { api } from '../../lib/api';

interface TeamAssignmentModalProps {
  sessionId: string;
  onClose: () => void;
  onSuccess?: () => void;
}

interface Participant {
  user_id: string;
  role: string;
  user?: {
    id: string;
    full_name: string;
    role: string;
  };
}

interface TeamAssignment {
  id: string;
  user_id: string;
  team_name: string;
  team_role?: string;
}

interface ScenarioTeam {
  team_name: string;
  team_description?: string | null;
  min_participants?: number | null;
  max_participants?: number | null;
}

interface PendingChange {
  type: 'add' | 'remove';
  userId: string;
  teamName: string;
}

export const TeamAssignmentModal = ({
  sessionId,
  onClose,
  onSuccess,
}: TeamAssignmentModalProps) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [teamAssignments, setTeamAssignments] = useState<TeamAssignment[]>([]);
  const [scenarioTeams, setScenarioTeams] = useState<ScenarioTeam[]>([]);
  const [isSocialSim, setIsSocialSim] = useState(false);

  // Multi-team mode (field ops): granular add/remove changes.
  const [pendingChanges, setPendingChanges] = useState<PendingChange[]>([]);
  // Single-team mode (social crisis): one team per player, pending selection map.
  const [pendingTeamByUser, setPendingTeamByUser] = useState<Record<string, string | null>>({});

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const loadData = async () => {
    try {
      setLoading(true);
      const sessionResult = await api.sessions.get(sessionId);
      const session = sessionResult.data as {
        participants?: Participant[];
        scenario_id?: string;
        sim_mode?: string;
        trainer_id?: string;
      };
      const trainerId = session?.trainer_id;
      if (session?.participants) {
        setParticipants(session.participants.filter((p) => p.user_id !== trainerId));
      }
      setIsSocialSim(session?.sim_mode === 'social_media');

      const scenarioId = session?.scenario_id;
      if (scenarioId) {
        const scenarioTeamsResult = await api.teams.getScenarioTeams(scenarioId);
        setScenarioTeams((scenarioTeamsResult.data ?? []) as ScenarioTeam[]);
      } else {
        setScenarioTeams([]);
      }

      const teamsResult = await api.teams.getSessionTeams(sessionId);
      setTeamAssignments(teamsResult.data || []);
      setPendingChanges([]);
      setPendingTeamByUser({});
    } catch (error) {
      console.error('Failed to load team assignment data:', error);
      alert('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const availableTeams = useMemo(() => scenarioTeams.map((t) => t.team_name), [scenarioTeams]);

  const teamByName = useMemo(() => {
    const map = new Map<string, ScenarioTeam>();
    for (const t of scenarioTeams) map.set(t.team_name, t);
    return map;
  }, [scenarioTeams]);

  const getUserName = (userId: string): string => {
    const participant = participants.find((p) => p.user_id === userId);
    return participant?.user?.full_name ?? userId;
  };

  /* ─── Single-team mode (social crisis) ─────────────────────────────── */

  const serverTeamOf = (userId: string): string | null => {
    const rows = teamAssignments.filter((a) => a.user_id === userId);
    return rows.length > 0 ? rows[0].team_name : null;
  };

  const effectiveTeamOf = (userId: string): string | null => {
    if (userId in pendingTeamByUser) return pendingTeamByUser[userId];
    return serverTeamOf(userId);
  };

  const handleSelectTeam = (userId: string, teamName: string) => {
    const current = effectiveTeamOf(userId);
    const next = current === teamName ? null : teamName;
    setPendingTeamByUser((prev) => {
      const updated = { ...prev };
      if (next === serverTeamOf(userId)) {
        delete updated[userId];
      } else {
        updated[userId] = next;
      }
      return updated;
    });
  };

  const headcount = (teamName: string): number =>
    participants.filter((p) => effectiveTeamOf(p.user_id) === teamName).length;

  const singleModeChanges = Object.keys(pendingTeamByUser).length;

  const autoBalance = () => {
    const unassignedIds = participants
      .filter((p) => effectiveTeamOf(p.user_id) === null)
      .map((p) => p.user_id);
    if (unassignedIds.length === 0 || availableTeams.length === 0) return;

    const counts = new Map<string, number>(availableTeams.map((t) => [t, headcount(t)]));
    const updates: Record<string, string> = {};
    for (const userId of unassignedIds) {
      // Fill the team furthest below its minimum first, then the smallest team
      // that still has capacity, then simply the smallest.
      let best: string | null = null;
      let bestScore = Infinity;
      for (const teamName of availableTeams) {
        const team = teamByName.get(teamName);
        const count = counts.get(teamName) || 0;
        const max = team?.max_participants ?? Infinity;
        const min = team?.min_participants ?? 1;
        const overMax = count >= max ? 1000 : 0;
        const belowMin = count < min ? -100 : 0;
        const score = count + overMax + belowMin;
        if (score < bestScore) {
          bestScore = score;
          best = teamName;
        }
      }
      if (best) {
        updates[userId] = best;
        counts.set(best, (counts.get(best) || 0) + 1);
      }
    }
    setPendingTeamByUser((prev) => ({ ...prev, ...updates }));
  };

  const saveSingleMode = async () => {
    setSaving(true);
    const errors: string[] = [];
    for (const [userId, teamName] of Object.entries(pendingTeamByUser)) {
      try {
        if (teamName === null) {
          const current = serverTeamOf(userId);
          if (current) {
            await api.teams.removeTeamAssignment(sessionId, userId, current);
          }
        } else {
          // The server enforces move semantics (deletes other rows) for
          // social sessions, so a single assign call is sufficient.
          await api.teams.assignTeam(sessionId, userId, teamName);
        }
      } catch {
        errors.push(`${getUserName(userId)} → ${teamName ?? 'unassigned'}`);
      }
    }
    setSaving(false);
    if (errors.length > 0) {
      alert(`Some changes failed:\n${errors.join('\n')}`);
    }
    setPendingTeamByUser({});
    onSuccess?.();
    onClose();
  };

  /* ─── Multi-team mode (field ops) — original behaviour ─────────────── */

  const getEffectiveTeams = (userId: string): string[] => {
    const serverTeams = teamAssignments.filter((a) => a.user_id === userId).map((a) => a.team_name);
    const result = new Set(serverTeams);
    for (const change of pendingChanges) {
      if (change.userId !== userId) continue;
      if (change.type === 'add') result.add(change.teamName);
      if (change.type === 'remove') result.delete(change.teamName);
    }
    return Array.from(result);
  };

  const isTeamAssignedOnServer = (userId: string, teamName: string): boolean => {
    return teamAssignments.some((a) => a.user_id === userId && a.team_name === teamName);
  };

  const handleToggleTeam = (userId: string, teamName: string) => {
    const currentlyAssigned = getEffectiveTeams(userId).includes(teamName);
    setPendingChanges((prev) => {
      const filtered = prev.filter((c) => !(c.userId === userId && c.teamName === teamName));
      if (currentlyAssigned) {
        if (isTeamAssignedOnServer(userId, teamName)) {
          return [...filtered, { type: 'remove', userId, teamName }];
        }
        return filtered;
      } else {
        if (!isTeamAssignedOnServer(userId, teamName)) {
          return [...filtered, { type: 'add', userId, teamName }];
        }
        return filtered;
      }
    });
  };

  const saveMultiMode = async () => {
    if (pendingChanges.length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    const errors: string[] = [];
    for (const change of pendingChanges) {
      try {
        if (change.type === 'add') {
          await api.teams.assignTeam(sessionId, change.userId, change.teamName);
        } else {
          await api.teams.removeTeamAssignment(sessionId, change.userId, change.teamName);
        }
      } catch {
        const name = getUserName(change.userId);
        errors.push(`${change.type === 'add' ? 'Assign' : 'Remove'} ${name} → ${change.teamName}`);
      }
    }
    setSaving(false);
    if (errors.length > 0) {
      alert(`Some changes failed:\n${errors.join('\n')}`);
    }
    setPendingChanges([]);
    onSuccess?.();
    onClose();
  };

  /* ─── Render ────────────────────────────────────────────────────────── */

  const changeCount = isSocialSim ? singleModeChanges : pendingChanges.length;

  const handleSaveAll = () => {
    if (changeCount === 0) {
      onClose();
      return;
    }
    if (isSocialSim) void saveSingleMode();
    else void saveMultiMode();
  };

  const handleCancel = () => {
    setPendingChanges([]);
    setPendingTeamByUser({});
    onClose();
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-ink/40 flex items-center justify-center z-50">
        <div className="bg-surface border border-border rounded-2xl shadow-lg p-8">
          <p className="terminal-text text-ink">Loading…</p>
        </div>
      </div>
    );
  }

  const unassignedCount = isSocialSim
    ? participants.filter((p) => effectiveTeamOf(p.user_id) === null).length
    : participants.filter((p) => getEffectiveTeams(p.user_id).length === 0).length;
  const assignedCount = participants.length - unassignedCount;

  return (
    <div className="fixed inset-0 bg-ink/40 flex items-center justify-center z-50 p-4">
      <div className="bg-surface border border-border rounded-2xl shadow-lg p-6 max-w-5xl w-full max-h-[90vh] flex flex-col">
        <div className="flex justify-between items-center mb-1">
          <h2 className="text-xl terminal-text">Team assignments</h2>
          <div className="flex items-center gap-2">
            {isSocialSim && (
              <button
                onClick={autoBalance}
                disabled={saving || unassignedCount === 0}
                className="text-xs terminal-text px-3 py-1.5 border border-accent text-accent rounded hover:bg-accent/10 disabled:opacity-40 disabled:cursor-not-allowed"
                title="Distribute unassigned players evenly across the teams"
              >
                Auto-balance
              </button>
            )}
            {changeCount > 0 && (
              <span className="text-xs terminal-text text-accent px-2 py-1 border border-accent/50 rounded">
                {changeCount} unsaved change{changeCount !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>
        {isSocialSim && (
          <p className="text-[10px] terminal-text text-muted mb-4">
            One team per player. Each team has its own storyline pressure, tasks, and scoring rubric
            — hover a team name for its mission.
          </p>
        )}

        <div className="flex-1 overflow-y-auto min-h-0 space-y-1 pr-1 mt-2">
          {/* Header row */}
          <div
            className="grid gap-2 items-center sticky top-0 bg-surface z-10 py-2 border-b border-border"
            style={{ gridTemplateColumns: `200px repeat(${availableTeams.length}, 1fr)` }}
          >
            <div className="text-xs terminal-text text-muted uppercase">Participant</div>
            {availableTeams.map((team) => {
              const def = teamByName.get(team);
              const count = isSocialSim ? headcount(team) : undefined;
              const min = def?.min_participants ?? 1;
              const max = def?.max_participants ?? null;
              const understaffed = isSocialSim && (count || 0) < min;
              return (
                <div key={team} className="text-center px-1" title={def?.team_description || team}>
                  <div className="text-xs terminal-text text-muted uppercase truncate">{team}</div>
                  {isSocialSim && (
                    <div
                      className={`text-[9px] terminal-text ${
                        understaffed ? 'text-danger' : 'text-muted'
                      }`}
                    >
                      {count}/{max ?? '∞'}
                      {understaffed ? ' · unstaffed' : ''}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Participant rows */}
          {participants.map((participant) => {
            const effectiveSingle = isSocialSim ? effectiveTeamOf(participant.user_id) : null;
            const effectiveMulti = isSocialSim ? [] : getEffectiveTeams(participant.user_id);
            const isUnassigned = isSocialSim
              ? effectiveSingle === null
              : effectiveMulti.length === 0;

            return (
              <div
                key={participant.user_id}
                className="grid gap-2 items-center py-2 border-b border-border"
                style={{ gridTemplateColumns: `200px repeat(${availableTeams.length}, 1fr)` }}
              >
                <div className="min-w-0">
                  <div className="text-sm terminal-text font-medium truncate">
                    {getUserName(participant.user_id)}
                  </div>
                  {isUnassigned && (
                    <div className="text-[10px] terminal-text text-danger">unassigned</div>
                  )}
                </div>

                {availableTeams.map((team) => {
                  const isActive = isSocialSim
                    ? effectiveSingle === team
                    : effectiveMulti.includes(team);
                  const hasPending = isSocialSim
                    ? participant.user_id in pendingTeamByUser &&
                      (pendingTeamByUser[participant.user_id] === team ||
                        (serverTeamOf(participant.user_id) === team &&
                          pendingTeamByUser[participant.user_id] !== team))
                    : pendingChanges.some(
                        (c) => c.userId === participant.user_id && c.teamName === team,
                      );

                  return (
                    <div key={team} className="flex justify-center">
                      <button
                        onClick={() =>
                          isSocialSim
                            ? handleSelectTeam(participant.user_id, team)
                            : handleToggleTeam(participant.user_id, team)
                        }
                        className={`w-8 h-8 border text-xs font-bold transition-all ${
                          isSocialSim ? 'rounded-full' : 'rounded'
                        } ${
                          isActive
                            ? hasPending
                              ? 'border-success bg-success/20 text-success ring-1 ring-success/50'
                              : 'border-accent bg-accent/10 text-accent'
                            : hasPending
                              ? 'border-danger/60 bg-danger/10 text-danger ring-1 ring-danger/30'
                              : 'border-border text-muted hover:border-accent/40 hover:bg-accent/5'
                        }`}
                        title={
                          isActive
                            ? `Remove ${getUserName(participant.user_id)} from ${team}`
                            : `Assign ${getUserName(participant.user_id)} to ${team}`
                        }
                      >
                        {isActive ? (isSocialSim ? '●' : '✓') : ''}
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Summary */}
        {(unassignedCount > 0 || assignedCount > 0) && (
          <div className="flex gap-4 text-[10px] terminal-text text-muted mt-3 pt-2 border-t border-border">
            <span>{assignedCount} assigned</span>
            {unassignedCount > 0 && (
              <span className="text-danger">
                {unassignedCount} unassigned
                {isSocialSim ? ' — they will miss team-specific content and scoring' : ''}
              </span>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-4 pt-4 mt-2 border-t border-border flex-shrink-0">
          <button
            onClick={handleSaveAll}
            disabled={saving}
            className={`military-button px-6 py-3 flex-1 ${
              changeCount > 0 ? '' : 'opacity-70'
            } disabled:opacity-50`}
          >
            {saving
              ? 'Saving…'
              : changeCount > 0
                ? `Save ${changeCount} change${changeCount !== 1 ? 's' : ''}`
                : 'Close'}
          </button>
          {changeCount > 0 && (
            <button
              onClick={handleCancel}
              disabled={saving}
              className="military-button-outline px-6 py-3 flex-1 border border-accent text-accent disabled:opacity-50"
            >
              Discard changes
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
