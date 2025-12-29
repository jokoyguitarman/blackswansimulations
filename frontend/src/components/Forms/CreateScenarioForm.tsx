import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { useRoleVisibility } from '../../hooks/useRoleVisibility';

interface CreateScenarioFormProps {
  onClose: () => void;
  onSuccess?: () => void;
}

export const CreateScenarioForm = ({ onClose, onSuccess }: CreateScenarioFormProps) => {
  const navigate = useNavigate();
  const { isTrainer } = useRoleVisibility();
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [showAIGenerator, setShowAIGenerator] = useState(false);
  const [aiPrompt, setAiPrompt] = useState({
    context: '',
    specific_requirements: '',
  });
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    category: 'custom',
    difficulty: 'intermediate',
    duration_minutes: 60,
    objectives: [''],
    briefing: '',
    roleSpecificBriefs: {} as Record<string, string>,
  });
  const [showRoleBriefs, setShowRoleBriefs] = useState(false);
  const [suggestedInjects, setSuggestedInjects] = useState<
    Array<{
      trigger_time_minutes: number;
      type: string;
      title: string;
      content: string;
      severity: string;
      affected_roles: string[];
    }>
  >([]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      await api.scenarios.create({
        ...formData,
        objectives: formData.objectives.filter((obj) => obj.trim() !== ''),
        initial_state: {},
        briefing: formData.briefing || undefined,
        role_specific_briefs:
          Object.keys(formData.roleSpecificBriefs).length > 0
            ? formData.roleSpecificBriefs
            : undefined,
        suggested_injects: suggestedInjects.length > 0 ? suggestedInjects : undefined,
      });

      if (onSuccess) {
        onSuccess();
      }
      onClose();
      navigate(`/scenarios`);
    } catch (error) {
      console.error('Failed to create scenario:', error);
      alert('Failed to create scenario');
    } finally {
      setLoading(false);
    }
  };

  const addObjective = () => {
    setFormData({ ...formData, objectives: [...formData.objectives, ''] });
  };

  const updateObjective = (index: number, value: string) => {
    const newObjectives = [...formData.objectives];
    newObjectives[index] = value;
    setFormData({ ...formData, objectives: newObjectives });
  };

  const removeObjective = (index: number) => {
    const newObjectives = formData.objectives.filter((_, i) => i !== index);
    setFormData({ ...formData, objectives: newObjectives.length > 0 ? newObjectives : [''] });
  };

  const handleAIGenerate = async () => {
    setGenerating(true);
    try {
      const result = await api.ai.generateScenario({
        category: formData.category,
        difficulty: formData.difficulty,
        duration_minutes: formData.duration_minutes,
        context: aiPrompt.context || undefined,
        specific_requirements: aiPrompt.specific_requirements || undefined,
      });

      const generated = result.data as {
        title: string;
        description: string;
        objectives: string[];
        initial_state: Record<string, unknown>;
        suggested_injects?: Array<{
          trigger_time_minutes: number;
          type: string;
          title: string;
          content: string;
          severity: string;
          affected_roles: string[];
        }>;
      };

      // Populate form with generated data
      setFormData({
        ...formData,
        title: generated.title,
        description: generated.description,
        objectives: generated.objectives.length > 0 ? generated.objectives : [''],
      });

      // Store suggested injects for later use
      if (generated.suggested_injects && generated.suggested_injects.length > 0) {
        setSuggestedInjects(generated.suggested_injects);
      }

      setShowAIGenerator(false);
      alert(
        `Scenario generated! ${generated.suggested_injects?.length || 0} suggested injects included. Review and edit as needed before saving.`,
      );
    } catch (error) {
      console.error('Failed to generate scenario:', error);
      alert('Failed to generate scenario. Please check your OpenAI API key configuration.');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="military-border bg-robotic-gray-300 p-8 max-w-3xl w-full max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl terminal-text uppercase">[CREATE_SCENARIO]</h2>
          {isTrainer && (
            <button
              type="button"
              onClick={() => setShowAIGenerator(!showAIGenerator)}
              className="px-4 py-2 text-xs terminal-text uppercase border border-robotic-yellow text-robotic-yellow hover:bg-robotic-yellow/10 transition-all"
            >
              {showAIGenerator ? '[HIDE_AI]' : '[AI_GENERATE]'}
            </button>
          )}
        </div>

        {/* AI Generator Panel */}
        {showAIGenerator && isTrainer && (
          <div className="military-border p-6 mb-6 bg-robotic-yellow/10 border-robotic-yellow">
            <h3 className="text-sm terminal-text uppercase mb-4 text-robotic-yellow">
              [AI_SCENARIO_GENERATOR]
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
                  [CONTEXT] (Optional)
                </label>
                <textarea
                  value={aiPrompt.context}
                  onChange={(e) => setAiPrompt({ ...aiPrompt, context: e.target.value })}
                  className="w-full px-4 py-3 military-input terminal-text"
                  rows={3}
                  placeholder="e.g., 'A major city during peak hours', 'Rural area with limited resources'..."
                />
              </div>
              <div>
                <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
                  [SPECIFIC_REQUIREMENTS] (Optional)
                </label>
                <textarea
                  value={aiPrompt.specific_requirements}
                  onChange={(e) =>
                    setAiPrompt({ ...aiPrompt, specific_requirements: e.target.value })
                  }
                  className="w-full px-4 py-3 military-input terminal-text"
                  rows={2}
                  placeholder="e.g., 'Must involve cyber attack', 'Should test resource sharing between agencies'..."
                />
              </div>
              <div className="flex gap-4">
                <button
                  type="button"
                  onClick={handleAIGenerate}
                  disabled={generating}
                  className="military-button px-6 py-3 flex-1 disabled:opacity-50"
                >
                  {generating ? '[GENERATING...]' : '[GENERATE_SCENARIO]'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowAIGenerator(false)}
                  className="military-button px-6 py-3 flex-1 border-robotic-orange text-robotic-orange"
                >
                  [CANCEL]
                </button>
              </div>
              {generating && (
                <div className="text-center py-4">
                  <div className="text-sm terminal-text text-robotic-yellow/70 animate-pulse">
                    [AI_THINKING] Generating scenario with AI...
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Basic scenario fields - will be auto-filled by AI if used */}
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
              placeholder="Scenario Title"
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
              placeholder="Detailed scenario description..."
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
                [CATEGORY]
              </label>
              <select
                value={formData.category}
                onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                className="w-full px-4 py-3 military-input terminal-text"
              >
                <option value="cyber">Cyber</option>
                <option value="infrastructure">Infrastructure</option>
                <option value="civil_unrest">Civil Unrest</option>
                <option value="natural_disaster">Natural Disaster</option>
                <option value="health_emergency">Health Emergency</option>
                <option value="terrorism">Terrorism</option>
                <option value="custom">Custom</option>
              </select>
            </div>

            <div>
              <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
                [DIFFICULTY]
              </label>
              <select
                value={formData.difficulty}
                onChange={(e) => setFormData({ ...formData, difficulty: e.target.value })}
                className="w-full px-4 py-3 military-input terminal-text"
              >
                <option value="beginner">Beginner</option>
                <option value="intermediate">Intermediate</option>
                <option value="advanced">Advanced</option>
                <option value="expert">Expert</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
              [DURATION_MINUTES]
            </label>
            <input
              type="number"
              required
              min={15}
              max={480}
              value={formData.duration_minutes}
              onChange={(e) =>
                setFormData({ ...formData, duration_minutes: parseInt(e.target.value) })
              }
              className="w-full px-4 py-3 military-input terminal-text"
            />
          </div>

          <div>
            <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
              [OBJECTIVES]
            </label>
            <div className="space-y-2">
              {formData.objectives.map((obj, index) => (
                <div key={index} className="flex gap-2">
                  <input
                    type="text"
                    value={obj}
                    onChange={(e) => updateObjective(index, e.target.value)}
                    className="flex-1 px-4 py-2 military-input terminal-text"
                    placeholder={`Objective ${index + 1}`}
                  />
                  {formData.objectives.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeObjective(index)}
                      className="px-3 py-2 text-robotic-orange border border-robotic-orange hover:bg-robotic-orange/10"
                    >
                      [X]
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={addObjective}
                className="text-xs terminal-text text-robotic-yellow hover:text-robotic-orange"
              >
                [+ ADD_OBJECTIVE]
              </button>
            </div>
          </div>

          {/* Briefing Section */}
          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
                [BRIEFING_MATERIALS]
              </label>
              <button
                type="button"
                onClick={() => setShowRoleBriefs(!showRoleBriefs)}
                className="text-xs terminal-text text-robotic-yellow hover:text-robotic-orange"
              >
                {showRoleBriefs ? '[HIDE_ROLE_BRIEFS]' : '[ADD_ROLE_BRIEFS]'}
              </button>
            </div>
            <textarea
              value={formData.briefing}
              onChange={(e) => setFormData({ ...formData, briefing: e.target.value })}
              className="w-full px-4 py-3 military-input terminal-text"
              rows={6}
              placeholder="General briefing material visible to all participants..."
            />
            <p className="text-xs terminal-text text-robotic-yellow/50 mt-1">
              This briefing will be visible to all participants before the session starts.
            </p>

            {/* Role-Specific Briefs */}
            {showRoleBriefs && (
              <div className="mt-4 space-y-3">
                <p className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-2">
                  [ROLE_SPECIFIC_BRIEFINGS]
                </p>
                {[
                  'defence',
                  'health',
                  'civil',
                  'utilities',
                  'intelligence',
                  'ngo',
                  'public_information_officer',
                  'police_commander',
                  'legal_oversight',
                ].map((role) => (
                  <div key={role}>
                    <label className="block text-xs terminal-text text-robotic-yellow/70 mb-1">
                      {role.toUpperCase().replace('_', ' ')}
                    </label>
                    <textarea
                      value={formData.roleSpecificBriefs[role] || ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          roleSpecificBriefs: {
                            ...formData.roleSpecificBriefs,
                            [role]: e.target.value,
                          },
                        })
                      }
                      className="w-full px-4 py-2 military-input terminal-text text-sm"
                      rows={3}
                      placeholder={`Briefing specific to ${role.replace('_', ' ')} role...`}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Show suggested injects if available */}
          {suggestedInjects.length > 0 && (
            <div className="military-border p-4 bg-robotic-yellow/10 border-robotic-yellow">
              <h3 className="text-sm terminal-text uppercase mb-3 text-robotic-yellow">
                [AI_SUGGESTED_INJECTS] {suggestedInjects.length} Suggested Event Injections
              </h3>
              <p className="text-xs terminal-text text-robotic-yellow/70 mb-3">
                These injects will be created automatically when you save this scenario.
              </p>
              <div className="space-y-2 max-h-40 overflow-y-auto">
                {suggestedInjects.map((inject, idx) => (
                  <div key={idx} className="military-border p-2 bg-robotic-gray-300">
                    <div className="flex justify-between items-start">
                      <div className="flex-1">
                        <div className="text-xs terminal-text font-semibold">{inject.title}</div>
                        <div className="text-xs terminal-text text-robotic-yellow/50">
                          [{inject.type}] • {inject.trigger_time_minutes}min • {inject.severity}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-4 pt-4 border-t border-robotic-yellow/30">
            <button
              type="submit"
              disabled={loading}
              className="military-button px-6 py-3 flex-1 disabled:opacity-50"
            >
              {loading ? '[CREATING...]' : '[CREATE_SCENARIO]'}
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
