import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';

interface CreateSessionModalProps {
  scenarios: Array<{ id: string; title: string }>;
  onClose: () => void;
  onSuccess: () => void;
}

export const CreateSessionModal = ({ scenarios, onClose, onSuccess }: CreateSessionModalProps) => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdminUser = user?.role === 'admin';
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    scenario_id: '',
    scheduled_start_time: '',
    trainer_instructions: '',
  });

  // Payment portal: creating a session consumes one session credit (2 are
  // granted per paid invoice - a pre- and a post-training game). Admins
  // bypass. Server enforces regardless; this is UX.
  const [sessionCredits, setSessionCredits] = useState<number | null>(null);
  useEffect(() => {
    if (isAdminUser) return;
    api.billing
      .getCredits()
      .then((res) => setSessionCredits(res.data.session))
      .catch(() => setSessionCredits(null)); // unknown -> don't block; server enforces
  }, [isAdminUser]);

  const outOfCredits = !isAdminUser && sessionCredits === 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.scenario_id) return;

    setLoading(true);
    setError(null);
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
    } catch (err) {
      console.error('Failed to create session:', err);
      const message = err instanceof Error ? err.message : 'Failed to create session';
      if (message.includes('session credit')) {
        setSessionCredits(0);
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-ink/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-surface border border-border rounded-2xl shadow-lg max-w-2xl w-full flex flex-col max-h-[90vh] overflow-hidden">
        <div className="flex-shrink-0 px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-lg font-bold text-brand">Create session</h2>
          {!isAdminUser && sessionCredits !== null && (
            <span
              className={`text-[11px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full ${
                sessionCredits > 0 ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'
              }`}
            >
              Session credits: {sessionCredits}
            </span>
          )}
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
            {outOfCredits && (
              <div className="bg-warning/10 border border-warning/40 rounded-lg p-4">
                <div className="text-sm font-bold text-ink mb-1">No session credits left</div>
                <p className="text-xs text-muted mb-2">
                  Session credits are granted when a client pays an engagement invoice (2 per
                  engagement - a pre- and a post-training game).
                </p>
                <Link to="/clients" className="text-xs font-semibold text-brand underline">
                  Go to Clients &amp; billing →
                </Link>
              </div>
            )}

            {error && !outOfCredits && (
              <div className="bg-danger/10 border border-danger/40 rounded-lg p-3 text-xs text-danger">
                {error}
              </div>
            )}

            <div>
              <label className="block text-xs terminal-text text-ink mb-2">Select scenario *</label>
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
              <label className="block text-xs terminal-text text-ink mb-2">
                Scheduled start time (optional)
              </label>
              <input
                type="datetime-local"
                value={formData.scheduled_start_time}
                onChange={(e) => setFormData({ ...formData, scheduled_start_time: e.target.value })}
                className="w-full px-4 py-3 military-input terminal-text"
              />
              <p className="text-xs terminal-text text-muted mt-1">
                Participants will see this time in their invitation. You can start early if needed.
              </p>
            </div>

            <div>
              <label className="block text-xs terminal-text text-ink mb-2">
                Trainer instructions (optional)
              </label>
              <textarea
                value={formData.trainer_instructions}
                onChange={(e) => setFormData({ ...formData, trainer_instructions: e.target.value })}
                className="w-full px-4 py-3 military-input terminal-text"
                rows={4}
                placeholder="Final instructions for participants before the session starts..."
                maxLength={5000}
              />
              <p className="text-xs terminal-text text-muted mt-1">
                These instructions will be visible in the lobby before the session starts.
              </p>
            </div>

            {!isAdminUser && sessionCredits !== null && sessionCredits > 0 && (
              <p className="text-[11px] terminal-text text-muted">
                Creating this session uses 1 of {sessionCredits} session credit
                {sessionCredits === 1 ? '' : 's'}.
              </p>
            )}
          </div>

          <div className="flex-shrink-0 flex justify-end gap-3 px-6 py-4 border-t border-border bg-surface-2">
            <button
              type="button"
              onClick={onClose}
              className="military-button-outline px-6 py-3 border border-accent text-accent"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !formData.scenario_id || outOfCredits}
              className="military-button px-6 py-3 disabled:opacity-50"
            >
              {loading ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
