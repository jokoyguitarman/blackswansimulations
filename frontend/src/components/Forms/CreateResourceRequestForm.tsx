import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { api } from '../../lib/api';

interface CreateResourceRequestFormProps {
  sessionId: string;
  onClose: () => void;
  onSuccess?: () => void;
}

export const CreateResourceRequestForm = ({
  sessionId,
  onClose,
  onSuccess,
}: CreateResourceRequestFormProps) => {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [agencies, setAgencies] = useState<string[]>([]);
  const [formData, setFormData] = useState({
    resource_type: '',
    quantity: 1,
    from_agency: '',
    to_agency: user?.agency || '',
    conditions: '',
  });

  useEffect(() => {
    // Load available agencies (simplified - in production, fetch from API)
    setAgencies([
      'DEFENCE',
      'POLICE',
      'HEALTH',
      'CIVIL_GOVERNMENT',
      'UTILITIES',
      'NGO',
      'INTELLIGENCE',
    ]);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      await api.resources.request({
        session_id: sessionId,
        ...formData,
      });

      if (onSuccess) {
        onSuccess();
      }
      onClose();
    } catch (error) {
      console.error('Failed to create resource request:', error);
      alert('Failed to create resource request');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-ink/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-surface border border-border rounded-2xl shadow-lg max-w-2xl w-full flex flex-col max-h-[90vh] overflow-hidden">
        <div className="flex-shrink-0 px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-lg font-bold text-brand">Request resources</h2>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
            <div>
              <label className="block text-xs terminal-text text-ink mb-2">Resource type</label>
              <input
                type="text"
                required
                value={formData.resource_type}
                onChange={(e) => setFormData({ ...formData, resource_type: e.target.value })}
                className="w-full px-4 py-3 military-input terminal-text"
                placeholder="e.g., Medical Supplies, Personnel, Vehicles"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs terminal-text text-ink mb-2">Quantity</label>
                <input
                  type="number"
                  required
                  min={1}
                  value={formData.quantity}
                  onChange={(e) => setFormData({ ...formData, quantity: parseInt(e.target.value) })}
                  className="w-full px-4 py-3 military-input terminal-text"
                />
              </div>

              <div>
                <label className="block text-xs terminal-text text-ink mb-2">From agency</label>
                <select
                  required
                  value={formData.from_agency}
                  onChange={(e) => setFormData({ ...formData, from_agency: e.target.value })}
                  className="w-full px-4 py-3 military-input terminal-text"
                >
                  <option value="">Select agency…</option>
                  {agencies
                    .filter((agency) => agency !== formData.to_agency)
                    .map((agency) => (
                      <option key={agency} value={agency}>
                        {agency}
                      </option>
                    ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs terminal-text text-ink mb-2">
                Conditions (optional)
              </label>
              <textarea
                value={formData.conditions}
                onChange={(e) => setFormData({ ...formData, conditions: e.target.value })}
                className="w-full px-4 py-3 military-input terminal-text"
                rows={3}
                placeholder="Any conditions or requirements..."
              />
            </div>
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
              disabled={loading}
              className="military-button px-6 py-3 disabled:opacity-50"
            >
              {loading ? 'Submitting…' : 'Submit request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
