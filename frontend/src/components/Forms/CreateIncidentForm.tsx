import { useState } from 'react';
import { api } from '../../lib/api';

/**
 * Create Incident Form Component - Client-side only
 * Separation of concerns: UI for creating incidents
 */

interface CreateIncidentFormProps {
  sessionId: string;
  onClose: () => void;
  onSuccess: () => void;
}

export const CreateIncidentForm = ({ sessionId, onClose, onSuccess }: CreateIncidentFormProps) => {
  // const { user } = useAuth(); // Unused - keeping for potential future use
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    type: '',
    severity: 'medium' as 'low' | 'medium' | 'high' | 'critical',
    location_lat: '',
    location_lng: '',
    casualty_count: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      await api.incidents.create({
        session_id: sessionId,
        title: formData.title,
        description: formData.description,
        type: formData.type,
        severity: formData.severity,
        location_lat: formData.location_lat ? parseFloat(formData.location_lat) : undefined,
        location_lng: formData.location_lng ? parseFloat(formData.location_lng) : undefined,
        casualty_count: formData.casualty_count ? parseInt(formData.casualty_count, 10) : undefined,
      });

      onSuccess();
    } catch (error) {
      console.error('Failed to create incident:', error);
      alert('Failed to create incident');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="military-border bg-robotic-gray-300 p-8 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-start mb-4">
          <h2 className="text-xl terminal-text uppercase">[CREATE_INCIDENT]</h2>
          <button onClick={onClose} className="text-robotic-orange hover:text-robotic-yellow">
            [CLOSE]
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm terminal-text text-robotic-yellow/70 uppercase mb-2">
              [TITLE] *
            </label>
            <input
              type="text"
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              required
              className="w-full military-input terminal-text text-sm px-4 py-2"
              placeholder="e.g., Explosion at Main Entrance"
            />
          </div>

          <div>
            <label className="block text-sm terminal-text text-robotic-yellow/70 uppercase mb-2">
              [DESCRIPTION] *
            </label>
            <textarea
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              required
              rows={4}
              className="w-full military-input terminal-text text-sm px-4 py-2"
              placeholder="Describe the incident..."
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm terminal-text text-robotic-yellow/70 uppercase mb-2">
                [TYPE] *
              </label>
              <input
                type="text"
                value={formData.type}
                onChange={(e) => setFormData({ ...formData, type: e.target.value })}
                required
                className="w-full military-input terminal-text text-sm px-4 py-2"
                placeholder="e.g., Explosion, Fire, Vehicle"
              />
            </div>

            <div>
              <label className="block text-sm terminal-text text-robotic-yellow/70 uppercase mb-2">
                [SEVERITY] *
              </label>
              <select
                value={formData.severity}
                onChange={(e) =>
                  setFormData({ ...formData, severity: e.target.value as typeof formData.severity })
                }
                required
                className="w-full military-input terminal-text text-sm px-4 py-2"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm terminal-text text-robotic-yellow/70 uppercase mb-2">
                [LATITUDE]
              </label>
              <input
                type="number"
                step="any"
                value={formData.location_lat}
                onChange={(e) => setFormData({ ...formData, location_lat: e.target.value })}
                className="w-full military-input terminal-text text-sm px-4 py-2"
                placeholder="1.2931"
              />
            </div>

            <div>
              <label className="block text-sm terminal-text text-robotic-yellow/70 uppercase mb-2">
                [LONGITUDE]
              </label>
              <input
                type="number"
                step="any"
                value={formData.location_lng}
                onChange={(e) => setFormData({ ...formData, location_lng: e.target.value })}
                className="w-full military-input terminal-text text-sm px-4 py-2"
                placeholder="103.8558"
              />
            </div>

            <div>
              <label className="block text-sm terminal-text text-robotic-yellow/70 uppercase mb-2">
                [CASUALTIES]
              </label>
              <input
                type="number"
                min="0"
                value={formData.casualty_count}
                onChange={(e) => setFormData({ ...formData, casualty_count: e.target.value })}
                className="w-full military-input terminal-text text-sm px-4 py-2"
                placeholder="0"
              />
            </div>
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
              disabled={loading}
              className="military-button px-6 py-3 flex-1 disabled:opacity-50"
            >
              {loading ? '[CREATING...]' : '[CREATE_INCIDENT]'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
