import { useState, useEffect } from 'react';
import { useRoleVisibility } from '../hooks/useRoleVisibility';
import { api } from '../lib/api';
import { CreateScenarioForm } from '../components/Forms/CreateScenarioForm';

interface Scenario {
  id: string;
  title: string;
  description: string;
  category: string;
  difficulty: string;
  duration_minutes: number;
  objectives: string[];
  is_active: boolean;
  created_at: string;
}

export const Scenarios = () => {
  const { isTrainer } = useRoleVisibility();
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedScenario, setSelectedScenario] = useState<Scenario | null>(null);

  useEffect(() => {
    loadScenarios();
  }, []);

  const loadScenarios = async () => {
    try {
      const result = await api.scenarios.list();
      setScenarios((result.data || []) as Scenario[]);
    } catch (error) {
      console.error('Failed to load scenarios:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateScenario = () => {
    setShowCreateModal(true);
  };

  const handleViewScenario = (scenario: Scenario) => {
    setSelectedScenario(scenario);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center scanline">
        <div className="text-center">
          <div className="text-lg terminal-text mb-2 animate-pulse">[LOADING]</div>
          <div className="text-xs terminal-text text-robotic-yellow/50">Loading scenarios...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen scanline">
      <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="military-border p-6 mb-6">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-2xl terminal-text uppercase tracking-wider mb-2">
                [SCENARIOS] Scenario Library
              </h1>
              <p className="text-xs terminal-text text-robotic-yellow/70">
                {scenarios.length} scenario{scenarios.length !== 1 ? 's' : ''} available
              </p>
            </div>
            {isTrainer && (
              <button onClick={handleCreateScenario} className="military-button px-6 py-3">
                [CREATE_SCENARIO]
              </button>
            )}
          </div>
        </div>

        {/* Scenarios Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {scenarios.map((scenario) => (
            <div
              key={scenario.id}
              className="military-border p-6 cursor-pointer hover:border-robotic-orange transition-all"
              onClick={() => handleViewScenario(scenario)}
            >
              <div className="flex justify-between items-start mb-4">
                <h3 className="text-lg terminal-text uppercase">{scenario.title}</h3>
                <span
                  className={`text-xs terminal-text px-2 py-1 ${
                    scenario.is_active
                      ? 'bg-robotic-yellow/20 text-robotic-yellow'
                      : 'bg-robotic-gray-200 text-robotic-gray-50'
                  }`}
                >
                  {scenario.is_active ? 'ACTIVE' : 'DRAFT'}
                </span>
              </div>
              <p className="text-sm terminal-text text-robotic-yellow/70 mb-4 line-clamp-3">
                {scenario.description}
              </p>
              <div className="flex flex-wrap gap-2 mb-4">
                <span className="text-xs terminal-text text-robotic-yellow/50">
                  [{scenario.category.toUpperCase()}]
                </span>
                <span className="text-xs terminal-text text-robotic-yellow/50">
                  [{scenario.difficulty.toUpperCase()}]
                </span>
                <span className="text-xs terminal-text text-robotic-yellow/50">
                  [{scenario.duration_minutes}MIN]
                </span>
              </div>
              <div className="text-xs terminal-text text-robotic-yellow/50">
                {scenario.objectives.length} objective{scenario.objectives.length !== 1 ? 's' : ''}
              </div>
            </div>
          ))}
        </div>

        {scenarios.length === 0 && (
          <div className="military-border p-12 text-center">
            <p className="text-lg terminal-text text-robotic-yellow/50 mb-2">
              [NO_SCENARIOS] No scenarios available
            </p>
            {isTrainer && (
              <p className="text-sm terminal-text text-robotic-yellow/30">
                Create your first scenario to get started
              </p>
            )}
          </div>
        )}
      </div>

      {/* Create Scenario Modal */}
      {showCreateModal && (
        <CreateScenarioForm onClose={() => setShowCreateModal(false)} onSuccess={loadScenarios} />
      )}

      {/* View Scenario Modal - TODO: Implement */}
      {selectedScenario && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="military-border bg-robotic-gray-300 p-8 max-w-4xl w-full max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-start mb-4">
              <h2 className="text-xl terminal-text uppercase">{selectedScenario.title}</h2>
              <button
                onClick={() => setSelectedScenario(null)}
                className="text-robotic-orange hover:text-robotic-yellow"
              >
                [CLOSE]
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <h3 className="text-sm terminal-text text-robotic-yellow/70 uppercase mb-2">
                  [DESCRIPTION]
                </h3>
                <p className="text-sm terminal-text">{selectedScenario.description}</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <h3 className="text-sm terminal-text text-robotic-yellow/70 uppercase mb-2">
                    [CATEGORY]
                  </h3>
                  <p className="text-sm terminal-text">{selectedScenario.category}</p>
                </div>
                <div>
                  <h3 className="text-sm terminal-text text-robotic-yellow/70 uppercase mb-2">
                    [DIFFICULTY]
                  </h3>
                  <p className="text-sm terminal-text">{selectedScenario.difficulty}</p>
                </div>
                <div>
                  <h3 className="text-sm terminal-text text-robotic-yellow/70 uppercase mb-2">
                    [DURATION]
                  </h3>
                  <p className="text-sm terminal-text">
                    {selectedScenario.duration_minutes} minutes
                  </p>
                </div>
                <div>
                  <h3 className="text-sm terminal-text text-robotic-yellow/70 uppercase mb-2">
                    [STATUS]
                  </h3>
                  <p className="text-sm terminal-text">
                    {selectedScenario.is_active ? 'ACTIVE' : 'DRAFT'}
                  </p>
                </div>
              </div>
              {selectedScenario.objectives.length > 0 && (
                <div>
                  <h3 className="text-sm terminal-text text-robotic-yellow/70 uppercase mb-2">
                    [OBJECTIVES]
                  </h3>
                  <ul className="list-disc list-inside space-y-1">
                    {selectedScenario.objectives.map((obj, idx) => (
                      <li key={idx} className="text-sm terminal-text">
                        {obj}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
