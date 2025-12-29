import { useState, useEffect } from 'react';
import { api } from '../../lib/api';

interface CreateDecisionFormProps {
  sessionId: string;
  onClose: () => void;
  onSuccess?: () => void;
}

export const CreateDecisionForm = ({ sessionId, onClose, onSuccess }: CreateDecisionFormProps) => {
  const [loading, setLoading] = useState(false);
  const [availableParticipants, setAvailableParticipants] = useState<
    Array<{ id: string; name: string; role: string }>
  >([]);
  const [loadingParticipants, setLoadingParticipants] = useState(true);
  const [participantsError, setParticipantsError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    required_approvers: [] as string[], // Now stores user IDs
  });

  // Fetch available participants on mount
  useEffect(() => {
    const fetchAvailableParticipants = async () => {
      try {
        setLoadingParticipants(true);
        setParticipantsError(null);
        const response = await api.decisions.getAvailableParticipants(sessionId);
        setAvailableParticipants(response.data || []);
      } catch (error) {
        console.error('Failed to fetch available participants:', error);
        setParticipantsError(
          error instanceof Error ? error.message : 'Failed to load available participants',
        );
      } finally {
        setLoadingParticipants(false);
      }
    };

    fetchAvailableParticipants();
  }, [sessionId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      await api.decisions.create({
        session_id: sessionId,
        ...formData,
      });

      if (onSuccess) {
        onSuccess();
      }
      onClose();
    } catch (error) {
      console.error('Failed to create decision:', error);
      alert('Failed to create decision');
    } finally {
      setLoading(false);
    }
  };

  const toggleApprover = (userId: string) => {
    if (formData.required_approvers.includes(userId)) {
      setFormData({
        ...formData,
        required_approvers: formData.required_approvers.filter((id) => id !== userId),
      });
    } else {
      setFormData({
        ...formData,
        required_approvers: [...formData.required_approvers, userId],
      });
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="military-border bg-robotic-gray-300 p-8 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <h2 className="text-xl terminal-text uppercase mb-6">[CREATE_DECISION]</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
              [TITLE]
            </label>
            <input
              type="text"
              required
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              className="w-full px-4 py-3 military-input terminal-text"
              placeholder="Decision Title"
            />
          </div>

          <div>
            <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
              [DESCRIPTION]
            </label>
            <textarea
              required
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              className="w-full px-4 py-3 military-input terminal-text"
              rows={4}
              placeholder="Detailed decision description..."
            />
          </div>

          <div>
            <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
              [REQUIRED_APPROVERS]
            </label>
            {loadingParticipants ? (
              <div className="text-xs terminal-text text-robotic-yellow/70 py-4">
                [LOADING_AVAILABLE_PARTICIPANTS...]
              </div>
            ) : participantsError ? (
              <div className="text-xs terminal-text text-robotic-orange py-4">
                [ERROR]: {participantsError}
              </div>
            ) : availableParticipants.length === 0 ? (
              <div className="text-xs terminal-text text-robotic-yellow/70 py-4">
                [NO_AVAILABLE_APPROVERS] No participants found in this session.
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {availableParticipants.map((participant) => {
                  const roleDisplay = participant.role
                    .replace(/_/g, ' ')
                    .replace(/\b\w/g, (l) => l.toUpperCase());
                  return (
                    <label key={participant.id} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formData.required_approvers.includes(participant.id)}
                        onChange={() => toggleApprover(participant.id)}
                        className="w-4 h-4"
                      />
                      <span className="text-xs terminal-text">
                        {participant.name} ({roleDisplay})
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex gap-4 pt-4 border-t border-robotic-yellow/30">
            <button
              type="submit"
              disabled={loading}
              className="military-button px-6 py-3 flex-1 disabled:opacity-50"
            >
              {loading ? '[CREATING...]' : '[CREATE_DECISION]'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="military-button px-6 py-3 flex-1 border-robotic-orange text-robotic-orange"
            >
              [CANCEL]
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
