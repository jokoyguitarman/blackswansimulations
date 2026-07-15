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

  // const toggleTeam = (team: string) => { // Unused - keeping for potential future use
  // Function commented out as it's currently unused
  // const toggleTeam = (team: string) => {
  //   if (formData.target_teams.includes(team)) {
  //     setFormData({
  //       ...formData,
  //       target_teams: formData.target_teams.filter((t) => t !== team),
  //     });
  //   } else {
  //     setFormData({
  //       ...formData,
  //       target_teams: [...formData.target_teams, team],
  //     });
  //   }
  // };

  return (
    <div className="fixed inset-0 bg-ink/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-surface border border-border rounded-2xl shadow-lg max-w-3xl w-full flex flex-col max-h-[90vh] overflow-hidden">
        <div className="flex-shrink-0 px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-lg font-bold text-brand">Create inject</h2>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
            <div>
              <label className="block text-xs terminal-text text-ink mb-2">Title</label>
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
              <label className="block text-xs terminal-text text-ink mb-2">Content</label>
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
                <label className="block text-xs terminal-text text-ink mb-2">Type</label>
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
                <label className="block text-xs terminal-text text-ink mb-2">Severity</label>
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
                <label className="block text-xs terminal-text text-ink mb-2">
                  Trigger time minutes (optional)
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
                <label className="block text-xs terminal-text text-ink mb-2">
                  Requires response
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
              <label className="block text-xs terminal-text text-ink mb-2">Affected roles</label>
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
                      {role.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())}
                    </span>
                  </label>
                ))}
              </div>
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
              {loading ? 'Creating…' : 'Create inject'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
