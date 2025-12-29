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
  user?: {
    id: string;
    full_name: string;
    role: string;
  };
}

export const TeamAssignmentModal = ({
  sessionId,
  onClose,
  onSuccess,
}: TeamAssignmentModalProps) => {
  const [loading, setLoading] = useState(true);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [teamAssignments, setTeamAssignments] = useState<TeamAssignment[]>([]);
  const [availableTeams] = useState<string[]>([
    'evacuation',
    'triage',
    'media',
    'communications',
    'logistics',
    'command',
    'medical',
    'security',
  ]);
  const [newTeamName, setNewTeamName] = useState('');
  const [selectedParticipant, setSelectedParticipant] = useState<string | null>(null);
  const [selectedTeam, setSelectedTeam] = useState<string>('');

  useEffect(() => {
    loadData();
  }, [sessionId]);

  const loadData = async () => {
    try {
      setLoading(true);

      // Load participants
      const sessionResult = await api.sessions.get(sessionId);
      const session = sessionResult.data as any;
      if (session?.participants) {
        setParticipants(session.participants);
      }

      // Load team assignments
      const teamsResult = await api.teams.getSessionTeams(sessionId);
      setTeamAssignments(teamsResult.data || []);
    } catch (error) {
      console.error('Failed to load team assignment data:', error);
      alert('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handleAssignTeam = async () => {
    if (!selectedParticipant || !selectedTeam) {
      alert('Please select a participant and team');
      return;
    }

    try {
      await api.teams.assignTeam(sessionId, selectedParticipant, selectedTeam);
      await loadData();
      setSelectedParticipant(null);
      setSelectedTeam('');
      if (onSuccess) onSuccess();
    } catch (error) {
      console.error('Failed to assign team:', error);
      alert('Failed to assign team');
    }
  };

  const handleRemoveAssignment = async (userId: string, teamName: string) => {
    if (!confirm(`Remove ${teamName} assignment?`)) return;

    try {
      await api.teams.removeTeamAssignment(sessionId, userId, teamName);
      await loadData();
      if (onSuccess) onSuccess();
    } catch (error) {
      console.error('Failed to remove team assignment:', error);
      alert('Failed to remove team assignment');
    }
  };

  const getUserTeams = (userId: string): string[] => {
    return teamAssignments
      .filter((assignment) => assignment.user_id === userId)
      .map((assignment) => assignment.team_name);
  };

  const getUserName = (userId: string): string => {
    const participant = participants.find((p) => p.user_id === userId);
    if (participant?.user?.full_name) return participant.user.full_name;
    return userId;
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

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="military-border bg-robotic-gray-300 p-8 max-w-4xl w-full max-h-[90vh] overflow-y-auto">
        <h2 className="text-xl terminal-text uppercase mb-6">[TEAM_ASSIGNMENTS]</h2>

        {/* Assign New Team */}
        <div className="mb-6 p-4 military-border">
          <h3 className="text-sm terminal-text uppercase text-robotic-yellow mb-4">
            [ASSIGN_TEAM]
          </h3>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
                [PARTICIPANT]
              </label>
              <select
                value={selectedParticipant || ''}
                onChange={(e) => setSelectedParticipant(e.target.value)}
                className="w-full px-4 py-3 military-input terminal-text"
              >
                <option value="">Select participant</option>
                {participants.map((p) => (
                  <option key={p.user_id} value={p.user_id}>
                    {getUserName(p.user_id)} ({p.role})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
                [TEAM]
              </label>
              <select
                value={selectedTeam}
                onChange={(e) => setSelectedTeam(e.target.value)}
                className="w-full px-4 py-3 military-input terminal-text"
              >
                <option value="">Select team</option>
                {availableTeams.map((team) => (
                  <option key={team} value={team}>
                    {team.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <button
                onClick={handleAssignTeam}
                disabled={!selectedParticipant || !selectedTeam}
                className="military-button px-6 py-3 w-full disabled:opacity-50"
              >
                [ASSIGN]
              </button>
            </div>
          </div>
        </div>

        {/* Current Assignments */}
        <div>
          <h3 className="text-sm terminal-text uppercase text-robotic-yellow mb-4">
            [CURRENT_ASSIGNMENTS]
          </h3>
          <div className="space-y-3">
            {participants.map((participant) => {
              const userTeams = getUserTeams(participant.user_id);
              if (userTeams.length === 0) return null;

              return (
                <div key={participant.user_id} className="military-border p-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <h4 className="text-sm terminal-text font-semibold">
                        {getUserName(participant.user_id)}
                      </h4>
                      <p className="text-xs terminal-text text-robotic-yellow/70">
                        Role: {participant.role}
                      </p>
                    </div>
                    <div className="flex-1 ml-4">
                      <div className="flex flex-wrap gap-2">
                        {userTeams.map((teamName) => {
                          const assignment = teamAssignments.find(
                            (a) => a.user_id === participant.user_id && a.team_name === teamName,
                          );
                          return (
                            <div
                              key={teamName}
                              className="flex items-center gap-2 px-3 py-1 military-border bg-robotic-gray-200"
                            >
                              <span className="text-xs terminal-text">
                                {teamName.toUpperCase()}
                              </span>
                              {assignment?.team_role && (
                                <span className="text-xs terminal-text text-robotic-yellow/70">
                                  ({assignment.team_role})
                                </span>
                              )}
                              <button
                                onClick={() =>
                                  handleRemoveAssignment(participant.user_id, teamName)
                                }
                                className="text-xs terminal-text text-robotic-orange hover:text-robotic-red"
                              >
                                [X]
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            {participants.every((p) => getUserTeams(p.user_id).length === 0) && (
              <p className="text-xs terminal-text text-robotic-yellow/50 text-center py-8">
                No team assignments yet
              </p>
            )}
          </div>
        </div>

        <div className="flex gap-4 pt-4 border-t border-robotic-yellow/30 mt-6">
          <button onClick={onClose} className="military-button px-6 py-3 flex-1">
            [CLOSE]
          </button>
        </div>
      </div>
    </div>
  );
};
