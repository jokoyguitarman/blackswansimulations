import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useRoleVisibility } from '../hooks/useRoleVisibility';
import { api } from '../lib/api';

import { ScenarioDetailView } from '../components/Scenario/ScenarioDetailView';

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

  const [selectedScenario, setSelectedScenario] = useState<Scenario | null>(null);
  const [detailScenarioId, setDetailScenarioId] = useState<string | null>(null);

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

  const [deleting, setDeleting] = useState<string | null>(null);

  const handleViewScenario = (scenario: Scenario) => {
    if (isTrainer) {
      setDetailScenarioId(scenario.id);
    } else {
      setSelectedScenario(scenario);
    }
  };

  const handleDeleteScenario = async (e: React.MouseEvent, scenario: Scenario) => {
    e.stopPropagation();
    if (
      !window.confirm(
        `Delete "${scenario.title}" and ALL related sessions, injects, teams, and locations? This cannot be undone.`,
      )
    )
      return;
    setDeleting(scenario.id);
    try {
      await api.scenarios.delete(scenario.id);
      setScenarios((prev) => prev.filter((s) => s.id !== scenario.id));
    } catch (err) {
      console.error('Failed to delete scenario:', err);
      alert('Failed to delete scenario. Check the console for details.');
    } finally {
      setDeleting(null);
    }
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
              <div className="flex gap-3">
                <Link
                  to="/warroom"
                  className="px-6 py-3 text-xs terminal-text uppercase border border-robotic-yellow text-robotic-yellow hover:bg-robotic-yellow/10 transition-all"
                >
                  [WAR_ROOM]
                </Link>
              </div>
            )}
          </div>
        </div>

        {/* Scenarios Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {scenarios.map((scenario) => {
            const isSocialCrisis = scenario.category === 'social_media_crisis';

            return (
              <div
                key={scenario.id}
                className={`p-6 cursor-pointer transition-all ${
                  isSocialCrisis
                    ? 'border border-blue-500/30 bg-gradient-to-br from-blue-950/40 to-purple-950/30 rounded-xl hover:border-blue-400/50'
                    : 'military-border hover:border-robotic-orange'
                }`}
                onClick={() => handleViewScenario(scenario)}
              >
                <div className="flex justify-between items-start mb-4">
                  <div className="flex items-center gap-2">
                    {isSocialCrisis && <span className="text-xl">📱</span>}
                    <h3
                      className={`text-lg ${isSocialCrisis ? 'text-blue-100 font-semibold' : 'terminal-text uppercase'}`}
                    >
                      {scenario.title}
                    </h3>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xs px-2 py-1 ${
                        isSocialCrisis
                          ? 'bg-blue-500/20 text-blue-300 rounded'
                          : scenario.is_active
                            ? 'bg-robotic-yellow/20 text-robotic-yellow terminal-text'
                            : 'bg-robotic-gray-200 text-robotic-gray-50 terminal-text'
                      }`}
                    >
                      {isSocialCrisis ? 'SOCIAL MEDIA' : scenario.is_active ? 'ACTIVE' : 'DRAFT'}
                    </span>
                    {isTrainer && (
                      <button
                        onClick={(e) => handleDeleteScenario(e, scenario)}
                        disabled={deleting === scenario.id}
                        className="text-xs terminal-text px-2 py-1 border border-red-600/50 text-red-500 hover:bg-red-600/20 hover:text-red-400 transition-all disabled:opacity-40"
                        title="Delete scenario and all related data"
                      >
                        {deleting === scenario.id ? '...' : 'DEL'}
                      </button>
                    )}
                  </div>
                </div>
                <p
                  className={`text-sm mb-4 line-clamp-3 ${
                    isSocialCrisis ? 'text-blue-200/70' : 'terminal-text text-robotic-yellow/70'
                  }`}
                >
                  {scenario.description}
                </p>
                <div className="flex flex-wrap gap-2 mb-4">
                  {isSocialCrisis ? (
                    <>
                      <span className="text-xs px-2 py-0.5 bg-purple-500/20 text-purple-300 rounded">
                        Crisis Response
                      </span>
                      <span className="text-xs px-2 py-0.5 bg-gray-500/20 text-gray-300 rounded">
                        {scenario.duration_minutes}min
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="text-xs terminal-text text-robotic-yellow/50">
                        [{scenario.category.toUpperCase()}]
                      </span>
                      <span className="text-xs terminal-text text-robotic-yellow/50">
                        [{scenario.difficulty.toUpperCase()}]
                      </span>
                      <span className="text-xs terminal-text text-robotic-yellow/50">
                        [{scenario.duration_minutes}MIN]
                      </span>
                    </>
                  )}
                </div>
                <div
                  className={`text-xs ${isSocialCrisis ? 'text-blue-300/50' : 'terminal-text text-robotic-yellow/50'}`}
                >
                  {scenario.objectives.length} objective
                  {scenario.objectives.length !== 1 ? 's' : ''}
                </div>
              </div>
            );
          })}
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

      {/* Trainer full detail view */}
      {detailScenarioId && (
        <ScenarioDetailView
          scenarioId={detailScenarioId}
          onClose={() => setDetailScenarioId(null)}
        />
      )}

      {/* Participant brief-only modal */}
      {selectedScenario && !isTrainer && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="military-border bg-robotic-gray-300 p-8 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
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
