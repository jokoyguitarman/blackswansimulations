import { useState, useEffect } from 'react';
import { api } from '../../lib/api';

/**
 * Assign Incident Modal Component - Client-side only
 * Separation of concerns: UI for assigning incidents to agencies and teams
 */

interface Incident {
  id: string;
  title: string;
  session_id?: string;
  assignments?: Array<{
    assignment_type?: string;
    user_id?: string;
    agency_role?: string;
    assigned_at: string;
    notes?: string;
    assigned_user?: {
      id: string;
      full_name: string;
    };
  }>;
}

interface Participant {
  id: string;
  name: string;
  role: string;
}

interface AssignIncidentModalProps {
  incident: Incident;
  sessionId: string;
  onClose: () => void;
  onSuccess: () => void;
}

export const AssignIncidentModal = ({
  incident,
  sessionId,
  onClose,
  onSuccess,
}: AssignIncidentModalProps) => {
  const [loading, setLoading] = useState(false);
  const [selectedValue, setSelectedValue] = useState('');
  const [notes, setNotes] = useState('');
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [participantsLoading, setParticipantsLoading] = useState(true);

  // Fetch participants for the session
  useEffect(() => {
    const fetchParticipants = async () => {
      try {
        const result = await api.incidents.getParticipants(sessionId);
        setParticipants(result.data || []);
      } catch (error) {
        console.error('Failed to fetch participants:', error);
      } finally {
        setParticipantsLoading(false);
      }
    };

    if (sessionId) {
      fetchParticipants();
    }
  }, [sessionId]);

  // Get existing assignments (user IDs)
  const existingUserIds =
    incident.assignments
      ?.filter((a) => !a.assignment_type || (a as any).user_id) // Filter for user assignments
      .map((a) => (a as any).user_id || '')
      .filter((id: string) => !!id) || [];

  const availableParticipants = participants.filter((p) => !existingUserIds.includes(p.id));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedValue) return;

    setLoading(true);
    try {
      await api.incidents.assign(incident.id, selectedValue, notes || undefined);
      onSuccess();
    } catch (error) {
      console.error('Failed to assign incident:', error);
      alert('Failed to assign incident');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="military-border bg-robotic-gray-300 p-8 max-w-lg w-full">
        <div className="flex justify-between items-start mb-4">
          <h2 className="text-xl terminal-text uppercase">[ASSIGN_INCIDENT]</h2>
          <button onClick={onClose} className="text-robotic-orange hover:text-robotic-yellow">
            [CLOSE]
          </button>
        </div>

        <div className="mb-4">
          <p className="text-sm terminal-text text-robotic-yellow/70 mb-2">
            Incident: <span className="font-semibold">{incident.title}</span>
          </p>
        </div>

        {existingUserIds.length > 0 && (
          <div className="mb-4 p-3 bg-robotic-gray-200 border border-robotic-yellow/30">
            <p className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-2">
              [CURRENT_ASSIGNMENTS]
            </p>
            <div className="flex flex-wrap gap-2">
              {incident.assignments
                ?.filter((a) => !a.assignment_type || (a as any).user_id) // Filter for user assignments
                .map((a, idx) => {
                  const assignment = a as any;
                  const userName =
                    assignment.assigned_user?.full_name || assignment.user_id || 'Unknown';
                  return (
                    <span
                      key={`user-${idx}`}
                      className="text-xs terminal-text px-2 py-1 bg-robotic-gray-300 border border-robotic-yellow/30"
                    >
                      {userName}
                    </span>
                  );
                })}
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm terminal-text text-robotic-yellow/70 uppercase mb-2">
              [ASSIGN_TO_PLAYER] *
            </label>
            <select
              value={selectedValue}
              onChange={(e) => setSelectedValue(e.target.value)}
              required
              disabled={participantsLoading}
              className="w-full military-input terminal-text text-sm px-4 py-2"
            >
              <option value="">
                {participantsLoading ? 'Loading participants...' : 'Select player...'}
              </option>
              {availableParticipants.map((participant) => {
                const roleDisplay = participant.role
                  .replace(/_/g, ' ')
                  .replace(/\b\w/g, (l) => l.toUpperCase());
                const displayText = `${participant.name} (${roleDisplay})`;
                return (
                  <option key={participant.id} value={participant.id}>
                    {displayText}
                  </option>
                );
              })}
            </select>
            {!participantsLoading && availableParticipants.length === 0 && (
              <p className="text-xs terminal-text text-robotic-yellow/50 mt-2">
                {participants.length === 0
                  ? 'No participants available in this session'
                  : 'All available participants have been assigned'}
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm terminal-text text-robotic-yellow/70 uppercase mb-2">
              [NOTES] (Optional)
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="w-full military-input terminal-text text-sm px-4 py-2"
              placeholder="Add assignment notes..."
            />
          </div>

          <div className="flex gap-4 pt-4 border-t border-robotic-yellow/30">
            <button
              type="button"
              onClick={onClose}
              className="military-button px-6 py-3 flex-1 border-robotic-gray-200 text-robotic-gray-50"
            >
              [CANCEL]
            </button>
            <button
              type="submit"
              disabled={loading || !selectedValue || availableParticipants.length === 0}
              className="military-button px-6 py-3 flex-1 disabled:opacity-50"
            >
              {loading ? '[ASSIGNING...]' : '[ASSIGN]'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
