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
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="military-border bg-robotic-gray-300 p-8 max-w-2xl w-full">
        <h2 className="text-xl terminal-text uppercase mb-6">[REQUEST_RESOURCES]</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
              [RESOURCE_TYPE]
            </label>
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
              <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
                [QUANTITY]
              </label>
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
              <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
                [FROM_AGENCY]
              </label>
              <select
                required
                value={formData.from_agency}
                onChange={(e) => setFormData({ ...formData, from_agency: e.target.value })}
                className="w-full px-4 py-3 military-input terminal-text"
              >
                <option value="">Select agency...</option>
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
            <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
              [CONDITIONS] (Optional)
            </label>
            <textarea
              value={formData.conditions}
              onChange={(e) => setFormData({ ...formData, conditions: e.target.value })}
              className="w-full px-4 py-3 military-input terminal-text"
              rows={3}
              placeholder="Any conditions or requirements..."
            />
          </div>

          <div className="flex gap-4 pt-4 border-t border-robotic-yellow/30">
            <button
              type="submit"
              disabled={loading}
              className="military-button px-6 py-3 flex-1 disabled:opacity-50"
            >
              {loading ? '[SUBMITTING...]' : '[SUBMIT_REQUEST]'}
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
