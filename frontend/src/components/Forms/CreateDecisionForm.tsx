import { useState } from 'react';
import { api } from '../../lib/api';
import { VoiceMicButton } from '../VoiceMicButton';

interface CreateDecisionFormProps {
  sessionId: string;
  /** Incident this decision responds to. Omit for pre-emptive decisions. */
  incidentId?: string;
  onClose: () => void;
  onSuccess?: () => void;
}

export const CreateDecisionForm = ({
  sessionId,
  incidentId,
  onClose,
  onSuccess,
}: CreateDecisionFormProps) => {
  const [loading, setLoading] = useState(false);
  const [description, setDescription] = useState('');

  const isPreemptive = !incidentId;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const payload: Record<string, unknown> = {
        session_id: sessionId,
        description,
        required_approvers: [],
      };
      if (incidentId) {
        payload.response_to_incident_id = incidentId;
      }

      const result = await api.decisions.create(payload);
      const created = result?.data as { id: string } | undefined;
      if (!created?.id) {
        alert('Decision was created but could not execute. Please execute it from the list.');
        onSuccess?.();
        onClose();
        return;
      }
      await api.decisions.execute(created.id);

      onSuccess?.();
      onClose();
    } catch (error) {
      console.error('Failed to create or execute decision:', error);
      const message =
        error instanceof Error ? error.message : 'Failed to create or execute decision';
      alert(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="military-border bg-robotic-gray-300 p-8 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <h2 className="text-xl terminal-text uppercase mb-6">
          {isPreemptive ? '[PRE-EMPTIVE_DECISION]' : '[RESPOND_TO_INCIDENT]'}
        </h2>
        {isPreemptive && (
          <p className="text-xs terminal-text text-robotic-yellow/60 mb-4">
            This decision is not in response to a specific incident. Use this to establish
            pre-emptive measures, protocols, or resource allocations proactively.
          </p>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
              [DESCRIPTION]
            </label>
            <div className="relative">
              <textarea
                required
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full px-4 py-3 pr-12 military-input terminal-text"
                rows={4}
                placeholder={
                  isPreemptive
                    ? 'Describe your pre-emptive decision, protocol, or resource allocation...'
                    : 'Type or speak your decision...'
                }
              />
              <VoiceMicButton
                onTranscript={(text) => setDescription((prev) => (prev ? `${prev} ${text}` : text))}
                disabled={loading}
                className="absolute bottom-2 right-2"
              />
            </div>
          </div>

          <div className="flex gap-4 pt-4 border-t border-robotic-yellow/30">
            <button
              type="submit"
              disabled={loading}
              className="military-button px-6 py-3 flex-1 border-green-400 text-green-400 hover:bg-green-400/10 disabled:opacity-50"
            >
              {loading ? '[EXECUTING...]' : '[EXECUTE_DECISION]'}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="military-button-outline px-6 py-3 flex-1 border border-robotic-orange text-robotic-orange disabled:opacity-50"
            >
              [CANCEL]
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
