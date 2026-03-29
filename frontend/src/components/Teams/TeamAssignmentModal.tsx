import { useState, useEffect } from 'react';
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
  const [availableTeams, setAvailableTeams] = useState<string[]>([]);
  const [pendingChanges, setPendingChanges] = useState<PendingChange[]>([]);

  useEffect(() => {
    loadData();
  }, [sessionId]);

  const loadData = async () => {
    try {
      setLoading(true);
      const sessionResult = await api.sessions.get(sessionId);
      const session = sessionResult.data as { participants?: Participant[]; scenario_id?: string };
      if (session?.participants) {
        setParticipants(session.participants);
      }

      const scenarioId = session?.scenario_id;
      if (scenarioId) {
        const scenarioTeamsResult = await api.teams.getScenarioTeams(scenarioId);
        const teamNames = (scenarioTeamsResult.data ?? []).map((t) => t.team_name);
        setAvailableTeams(teamNames);
      } else {
        setAvailableTeams([]);
      }

      const teamsResult = await api.teams.getSessionTeams(sessionId);
      setTeamAssignments(teamsResult.data || []);
    } catch (error) {
      console.error('Failed to load team assignment data:', error);
      alert('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const getUserName = (userId: string): string => {
    const participant = participants.find((p) => p.user_id === userId);
    return participant?.user?.full_name ?? userId;
  };

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

  const handleSaveAll = async () => {
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

  const handleCancel = () => {
    setPendingChanges([]);
    onClose();
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
        <div className="military-border bg-robotic-gray-300 p-8">
          <p className="terminal-text text-robotic-yellow">Loading...</p>
        </div>
      </div>
    );
  }

  const unassigned = participants.filter((p) => getEffectiveTeams(p.user_id).length === 0);
  const assigned = participants.filter((p) => getEffectiveTeams(p.user_id).length > 0);

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="military-border bg-robotic-gray-300 p-6 max-w-5xl w-full max-h-[90vh] flex flex-col">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl terminal-text uppercase">[TEAM_ASSIGNMENTS]</h2>
          {pendingChanges.length > 0 && (
            <span className="text-xs terminal-text text-robotic-orange px-2 py-1 border border-robotic-orange/50 rounded">
              {pendingChanges.length} unsaved change{pendingChanges.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 space-y-1 pr-1">
          {/* Header row */}
          <div
            className="grid gap-2 items-center sticky top-0 bg-robotic-gray-300 z-10 py-2 border-b border-robotic-yellow/30"
            style={{ gridTemplateColumns: `200px repeat(${availableTeams.length}, 1fr)` }}
          >
            <div className="text-xs terminal-text text-robotic-yellow/60 uppercase">
              Participant
            </div>
            {availableTeams.map((team) => (
              <div
                key={team}
                className="text-xs terminal-text text-robotic-yellow/60 uppercase text-center truncate px-1"
                title={team}
              >
                {team}
              </div>
            ))}
          </div>

          {/* Participant rows */}
          {participants.map((participant) => {
            const effectiveTeams = getEffectiveTeams(participant.user_id);

            return (
              <div
                key={participant.user_id}
                className="grid gap-2 items-center py-2 border-b border-robotic-yellow/10"
                style={{ gridTemplateColumns: `200px repeat(${availableTeams.length}, 1fr)` }}
              >
                <div className="min-w-0">
                  <div className="text-sm terminal-text font-medium truncate">
                    {getUserName(participant.user_id)}
                  </div>
                  {effectiveTeams.length === 0 && (
                    <div className="text-[10px] terminal-text text-robotic-yellow/40">
                      unassigned
                    </div>
                  )}
                </div>

                {availableTeams.map((team) => {
                  const isActive = effectiveTeams.includes(team);
                  const hasPending = pendingChanges.some(
                    (c) => c.userId === participant.user_id && c.teamName === team,
                  );

                  return (
                    <div key={team} className="flex justify-center">
                      <button
                        onClick={() => handleToggleTeam(participant.user_id, team)}
                        className={`w-8 h-8 rounded border text-xs font-bold transition-all ${
                          isActive
                            ? hasPending
                              ? 'border-green-500 bg-green-500/30 text-green-300 ring-1 ring-green-400/50'
                              : 'border-robotic-yellow bg-robotic-yellow/20 text-robotic-yellow'
                            : hasPending
                              ? 'border-red-500/60 bg-red-500/10 text-red-400 ring-1 ring-red-400/30 line-through'
                              : 'border-robotic-yellow/20 text-robotic-yellow/30 hover:border-robotic-yellow/40 hover:bg-robotic-yellow/5'
                        }`}
                        title={
                          isActive
                            ? `Remove ${getUserName(participant.user_id)} from ${team}`
                            : `Assign ${getUserName(participant.user_id)} to ${team}`
                        }
                      >
                        {isActive ? '✓' : ''}
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Summary */}
        {(unassigned.length > 0 || assigned.length > 0) && (
          <div className="flex gap-4 text-[10px] terminal-text text-robotic-yellow/50 mt-3 pt-2 border-t border-robotic-yellow/20">
            <span>{assigned.length} assigned</span>
            {unassigned.length > 0 && (
              <span className="text-robotic-orange/70">{unassigned.length} unassigned</span>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-4 pt-4 mt-2 border-t border-robotic-yellow/30 flex-shrink-0">
          <button
            onClick={handleSaveAll}
            disabled={saving}
            className={`military-button px-6 py-3 flex-1 ${
              pendingChanges.length > 0 ? '' : 'opacity-70'
            } disabled:opacity-50`}
          >
            {saving
              ? '[SAVING...]'
              : pendingChanges.length > 0
                ? `[SAVE ${pendingChanges.length} CHANGE${pendingChanges.length !== 1 ? 'S' : ''}]`
                : '[CLOSE]'}
          </button>
          {pendingChanges.length > 0 && (
            <button
              onClick={handleCancel}
              disabled={saving}
              className="military-button-outline px-6 py-3 flex-1 border border-robotic-orange text-robotic-orange disabled:opacity-50"
            >
              [DISCARD_CHANGES]
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
