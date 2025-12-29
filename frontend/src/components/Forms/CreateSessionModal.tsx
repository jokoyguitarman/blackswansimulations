import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';

interface CreateSessionModalProps {
  scenarios: Array<{ id: string; title: string }>;
  onClose: () => void;
  onSuccess: () => void;
}

export const CreateSessionModal = ({ scenarios, onClose, onSuccess }: CreateSessionModalProps) => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    scenario_id: '',
    scheduled_start_time: '',
    trainer_instructions: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.scenario_id) return;

    setLoading(true);
    try {
      const result = await api.sessions.create({
        scenario_id: formData.scenario_id,
        scheduled_start_time: formData.scheduled_start_time || undefined,
        trainer_instructions: formData.trainer_instructions || undefined,
      });
      const session = result.data as { id: string };
      onSuccess();
      onClose();
      navigate(`/sessions/${session.id}`);
    } catch (error) {
      console.error('Failed to create session:', error);
      alert('Failed to create session');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="military-border bg-robotic-gray-300 p-8 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <h2 className="text-xl terminal-text uppercase mb-4">[CREATE_SESSION]</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
              [SELECT_SCENARIO] *
            </label>
            <select
              value={formData.scenario_id}
              onChange={(e) => setFormData({ ...formData, scenario_id: e.target.value })}
              className="w-full px-4 py-3 military-input terminal-text"
              required
            >
              <option value="">Select a scenario...</option>
              {scenarios.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>
                  {scenario.title}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
              [SCHEDULED_START_TIME] (Optional)
            </label>
            <input
              type="datetime-local"
              value={formData.scheduled_start_time}
              onChange={(e) => setFormData({ ...formData, scheduled_start_time: e.target.value })}
              className="w-full px-4 py-3 military-input terminal-text"
            />
            <p className="text-xs terminal-text text-robotic-yellow/50 mt-1">
              Participants will see this time in their invitation. You can start early if needed.
            </p>
          </div>

          <div>
            <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
              [TRAINER_INSTRUCTIONS] (Optional)
            </label>
            <textarea
              value={formData.trainer_instructions}
              onChange={(e) => setFormData({ ...formData, trainer_instructions: e.target.value })}
              className="w-full px-4 py-3 military-input terminal-text"
              rows={4}
              placeholder="Final instructions for participants before the session starts..."
              maxLength={5000}
            />
            <p className="text-xs terminal-text text-robotic-yellow/50 mt-1">
              These instructions will be visible in the lobby before the session starts.
            </p>
          </div>

          <div className="flex gap-4 pt-4 border-t border-robotic-yellow/30">
            <button
              type="submit"
              disabled={loading || !formData.scenario_id}
              className="military-button px-6 py-3 flex-1 disabled:opacity-50"
            >
              {loading ? '[CREATING...]' : '[CREATE]'}
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
