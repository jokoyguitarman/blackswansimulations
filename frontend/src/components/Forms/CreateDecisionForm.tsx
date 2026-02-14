import { useState } from 'react';
import { api } from '../../lib/api';

interface CreateDecisionFormProps {
  sessionId: string;
  onClose: () => void;
  onSuccess?: () => void;
}

export const CreateDecisionForm = ({ sessionId, onClose, onSuccess }: CreateDecisionFormProps) => {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    title: '',
    description: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      await api.decisions.create({
        session_id: sessionId,
        ...formData,
        required_approvers: [], // Streamlined: no approvals; creator executes immediately
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
