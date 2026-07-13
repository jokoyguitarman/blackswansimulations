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
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="text-lg text-ink mb-2 animate-pulse">Loading</div>
          <div className="text-xs text-muted">Loading scenarios…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="bg-surface border border-border rounded-xl shadow-sm p-6 mb-6">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-2xl font-extrabold text-brand mb-1">Scenario library</h1>
              <p className="text-sm text-muted">
                {scenarios.length} scenario{scenarios.length !== 1 ? 's' : ''} available
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link
                to="/dashboard"
                className="px-5 py-2.5 text-sm font-semibold rounded-lg border border-border-strong text-brand hover:bg-surface-2 transition-all"
              >
                Dashboard
              </Link>
              <Link
                to="/sessions"
                className="px-5 py-2.5 text-sm font-semibold rounded-lg border border-border-strong text-brand hover:bg-surface-2 transition-all"
              >
                Sessions
              </Link>
              {isTrainer && (
                <>
                  <Link
                    to="/clients"
                    className="px-5 py-2.5 text-sm font-semibold rounded-lg border border-border-strong text-brand hover:bg-surface-2 transition-all"
                  >
                    Clients &amp; billing
                  </Link>
                  <Link to="/warroom" className="military-button px-5 py-2.5 text-sm">
                    War Room
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Scenarios Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {scenarios.map((scenario) => {
            const isSocialCrisis = scenario.category === 'social_media_crisis';

            return (
              <div
                key={scenario.id}
                className={`bg-surface border border-border border-t-4 rounded-xl shadow-sm p-6 cursor-pointer transition-all hover:shadow-md ${
                  isSocialCrisis
                    ? 'border-t-accent hover:border-accent'
                    : 'border-t-brand hover:border-brand'
                }`}
                onClick={() => handleViewScenario(scenario)}
              >
                {/* Type ribbon + status */}
                <div className="flex items-center justify-between mb-3">
                  <span
                    className={`inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full ${
                      isSocialCrisis ? 'bg-accent/10 text-accent' : 'bg-brand/10 text-brand'
                    }`}
                  >
                    <span aria-hidden>{isSocialCrisis ? '📱' : '🗺️'}</span>
                    {isSocialCrisis ? 'Social media crisis' : 'Field operations'}
                  </span>
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xs font-bold uppercase tracking-wide px-2 py-0.5 rounded-full ${
                        scenario.is_active
                          ? 'bg-success/10 text-success'
                          : 'bg-surface-2 text-muted'
                      }`}
                    >
                      {scenario.is_active ? 'Active' : 'Draft'}
                    </span>
                    {isTrainer && (
                      <button
                        onClick={(e) => handleDeleteScenario(e, scenario)}
                        disabled={deleting === scenario.id}
                        className="text-xs font-semibold px-2 py-0.5 rounded-md border border-danger/40 text-danger hover:bg-danger/10 transition-all disabled:opacity-40"
                        title="Delete scenario and all related data"
                      >
                        {deleting === scenario.id ? '…' : 'Delete'}
                      </button>
                    )}
                  </div>
                </div>

                <h3 className="text-lg font-bold text-ink mb-2">{scenario.title}</h3>
                <p className="text-sm mb-4 line-clamp-3 text-muted">{scenario.description}</p>
                <div className="flex flex-wrap gap-2 mb-4">
                  {isSocialCrisis ? (
                    <>
                      <span className="text-xs font-medium px-2 py-0.5 bg-accent/10 text-accent rounded">
                        Crisis response
                      </span>
                      <span className="text-xs font-medium px-2 py-0.5 bg-surface-2 text-muted rounded">
                        {scenario.duration_minutes} min
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="text-xs font-medium px-2 py-0.5 bg-brand/10 text-brand rounded capitalize">
                        {scenario.category}
                      </span>
                      <span className="text-xs font-medium px-2 py-0.5 bg-surface-2 text-muted rounded capitalize">
                        {scenario.difficulty}
                      </span>
                      <span className="text-xs font-medium px-2 py-0.5 bg-surface-2 text-muted rounded">
                        {scenario.duration_minutes} min
                      </span>
                    </>
                  )}
                </div>
                <div className="text-xs text-muted">
                  {scenario.objectives.length} objective
                  {scenario.objectives.length !== 1 ? 's' : ''}
                </div>
              </div>
            );
          })}
        </div>

        {scenarios.length === 0 && (
          <div className="bg-surface border border-border rounded-xl shadow-sm p-12 text-center">
            <p className="text-lg text-muted mb-2">No scenarios available</p>
            {isTrainer && (
              <p className="text-sm text-muted">Create your first scenario to get started</p>
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
        <div className="fixed inset-0 bg-ink/40 flex items-center justify-center z-50 p-4">
          <div className="bg-surface border border-border rounded-2xl shadow-lg p-8 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-start mb-4">
              <h2 className="text-xl font-bold text-brand">{selectedScenario.title}</h2>
              <button
                onClick={() => setSelectedScenario(null)}
                className="text-muted hover:text-ink text-lg"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <h3 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
                  Description
                </h3>
                <p className="text-sm text-ink">{selectedScenario.description}</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <h3 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
                    Category
                  </h3>
                  <p className="text-sm text-ink capitalize">{selectedScenario.category}</p>
                </div>
                <div>
                  <h3 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
                    Difficulty
                  </h3>
                  <p className="text-sm text-ink capitalize">{selectedScenario.difficulty}</p>
                </div>
                <div>
                  <h3 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
                    Duration
                  </h3>
                  <p className="text-sm text-ink">{selectedScenario.duration_minutes} minutes</p>
                </div>
              </div>
              {selectedScenario.objectives.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
                    Objectives
                  </h3>
                  <ul className="list-disc list-inside space-y-1">
                    {selectedScenario.objectives.map((obj, idx) => (
                      <li key={idx} className="text-sm text-ink">
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
