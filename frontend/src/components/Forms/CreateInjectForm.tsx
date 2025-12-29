import { useState } from 'react';
import { api } from '../../lib/api';

interface CreateInjectFormProps {
  sessionId: string;
  scenarioId: string;
  onClose: () => void;
  onSuccess?: () => void;
}

export const CreateInjectForm = ({
  sessionId,
  scenarioId,
  onClose,
  onSuccess,
}: CreateInjectFormProps) => {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    title: '',
    content: '',
    type: 'field_update',
    severity: 'medium',
    trigger_time_minutes: null as number | null,
    trigger_condition: '',
    affected_roles: [] as string[],
    requires_response: false,
    inject_scope: 'universal' as 'universal' | 'role_specific' | 'team_specific',
    target_teams: [] as string[],
    requires_coordination: false,
  });

  const ROLES = [
    'defence_liaison',
    'police_commander',
    'public_information_officer',
    'health_director',
    'civil_government',
    'utility_manager',
    'intelligence_analyst',
    'ngo_liaison',
  ];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      await api.injects.create({
        session_id: sessionId,
        scenario_id: scenarioId,
        ...formData,
        trigger_time_minutes: formData.trigger_time_minutes || undefined,
        trigger_condition: formData.trigger_condition || undefined,
        target_teams:
          formData.inject_scope === 'team_specific' && formData.target_teams.length > 0
            ? formData.target_teams
            : undefined,
      });

      if (onSuccess) {
        onSuccess();
      }
      onClose();
    } catch (error) {
      console.error('Failed to create inject:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to create inject';
      alert(`Failed to create inject: ${errorMessage}`);
    } finally {
      setLoading(false);
    }
  };

  const toggleRole = (role: string) => {
    if (formData.affected_roles.includes(role)) {
      setFormData({
        ...formData,
        affected_roles: formData.affected_roles.filter((r) => r !== role),
      });
    } else {
      setFormData({
        ...formData,
        affected_roles: [...formData.affected_roles, role],
      });
    }
  };

  const toggleTeam = (team: string) => {
    if (formData.target_teams.includes(team)) {
      setFormData({
        ...formData,
        target_teams: formData.target_teams.filter((t) => t !== team),
      });
    } else {
      setFormData({
        ...formData,
        target_teams: [...formData.target_teams, team],
      });
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="military-border bg-robotic-gray-300 p-8 max-w-3xl w-full max-h-[90vh] overflow-y-auto">
        <h2 className="text-xl terminal-text uppercase mb-6">[CREATE_INJECT]</h2>
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
              placeholder="Inject Title"
            />
          </div>

          <div>
            <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
              [CONTENT]
            </label>
            <textarea
              required
              value={formData.content}
              onChange={(e) => setFormData({ ...formData, content: e.target.value })}
              className="w-full px-4 py-3 military-input terminal-text"
              rows={4}
              placeholder="Inject content/details..."
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
                [TYPE]
              </label>
              <select
                value={formData.type}
                onChange={(e) => setFormData({ ...formData, type: e.target.value })}
                className="w-full px-4 py-3 military-input terminal-text"
              >
                <option value="media_report">Media Report</option>
                <option value="field_update">Field Update</option>
                <option value="citizen_call">Citizen Call</option>
                <option value="intel_brief">Intel Brief</option>
                <option value="resource_shortage">Resource Shortage</option>
                <option value="weather_change">Weather Change</option>
                <option value="political_pressure">Political Pressure</option>
              </select>
            </div>

            <div>
              <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
                [SEVERITY]
              </label>
              <select
                value={formData.severity}
                onChange={(e) => setFormData({ ...formData, severity: e.target.value })}
                className="w-full px-4 py-3 military-input terminal-text"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
                [TRIGGER_TIME_MINUTES] (Optional)
              </label>
              <input
                type="number"
                min={0}
                value={formData.trigger_time_minutes || ''}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    trigger_time_minutes: e.target.value ? parseInt(e.target.value) : null,
                  })
                }
                className="w-full px-4 py-3 military-input terminal-text"
                placeholder="Auto-trigger at X minutes"
              />
            </div>

            <div>
              <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
                [REQUIRES_RESPONSE]
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.requires_response}
                  onChange={(e) =>
                    setFormData({ ...formData, requires_response: e.target.checked })
                  }
                  className="w-4 h-4"
                />
                <span className="text-xs terminal-text">Requires player response</span>
              </label>
            </div>
          </div>

          <div>
            <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
              [AFFECTED_ROLES]
            </label>
            <div className="grid grid-cols-2 gap-2">
              {ROLES.map((role) => (
                <label key={role} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.affected_roles.includes(role)}
                    onChange={() => toggleRole(role)}
                    className="w-4 h-4"
                  />
                  <span className="text-xs terminal-text">
                    {role.replace(/_/g, ' ').toUpperCase()}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex gap-4 pt-4 border-t border-robotic-yellow/30">
            <button
              type="submit"
              disabled={loading}
              className="military-button px-6 py-3 flex-1 disabled:opacity-50"
            >
              {loading ? '[CREATING...]' : '[CREATE_INJECT]'}
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
