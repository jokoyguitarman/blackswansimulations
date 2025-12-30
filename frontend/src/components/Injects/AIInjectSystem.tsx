import { useState, useEffect } from 'react';
import { useRoleVisibility } from '../../hooks/useRoleVisibility';
import { api } from '../../lib/api';
import { CreateInjectForm } from '../Forms/CreateInjectForm';

interface Inject {
  id: string;
  title: string;
  content: string;
  type: string;
  severity: string;
  trigger_time_minutes: number | null;
  affected_roles: string[];
  requires_response: boolean;
  ai_generated: boolean;
  inject_scope?: 'universal' | 'role_specific' | 'team_specific';
  target_teams?: string[] | null;
  requires_coordination?: boolean;
}

interface AIInjectSystemProps {
  sessionId: string;
  scenarioId: string;
}

export const AIInjectSystem = ({ sessionId, scenarioId }: AIInjectSystemProps) => {
  const { isTrainer } = useRoleVisibility();
  const [injects, setInjects] = useState<Inject[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [expandedInjects, setExpandedInjects] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadInjects();
  }, [scenarioId]);

  const loadInjects = async () => {
    try {
      const result = await api.injects.list(undefined, sessionId);
      setInjects(result.data as Inject[]);
    } catch (error) {
      console.error('Failed to load injects:', error);
    } finally {
      setLoading(false);
    }
  };

  const handlePublishInject = async (injectId: string) => {
    if (!confirm('Publish this inject to the session?')) return;

    try {
      await api.injects.publish(injectId, sessionId);
      alert('Inject published successfully');
      loadInjects();
    } catch (error) {
      console.error('Failed to publish inject:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to publish inject';
      console.error('Full error details:', error);
      alert(`Failed to publish inject: ${errorMessage}`);
    }
  };

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical':
        return 'bg-robotic-orange/20 text-robotic-orange border-robotic-orange';
      case 'high':
        return 'bg-robotic-yellow/20 text-robotic-yellow border-robotic-yellow';
      case 'medium':
        return 'bg-robotic-gray-50 text-robotic-gray-50 border-robotic-gray-50';
      default:
        return 'bg-robotic-gray-200 text-robotic-gray-200 border-robotic-gray-200';
    }
  };

  if (!isTrainer) {
    return (
      <div className="military-border p-6">
        <p className="text-sm terminal-text text-robotic-yellow/50">
          [ACCESS_DENIED] Only trainers can manage AI injects
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="military-border p-6">
        <div className="text-center">
          <div className="text-sm terminal-text text-robotic-yellow/50 animate-pulse">
            [LOADING_INJECTS]
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="military-border p-4 flex justify-between items-center">
        <h3 className="text-lg terminal-text uppercase">[AI_INJECTS] Event Injector</h3>
        <button
          onClick={() => setShowCreateModal(true)}
          className="military-button px-4 py-2 text-sm"
        >
          [CREATE_INJECT]
        </button>
      </div>

      <div className="space-y-3">
        {injects.map((inject) => (
          <div key={inject.id} className="military-border p-4 overflow-hidden">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-2 mb-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h4 className="text-sm terminal-text font-semibold">{inject.title}</h4>
                  {inject.ai_generated && (
                    <span className="text-xs terminal-text text-robotic-yellow/50">
                      [AI_GENERATED]
                    </span>
                  )}
                </div>
                <div className="text-xs terminal-text text-robotic-yellow/70 mb-2">
                  {inject.content.length > 150 ? (
                    <>
                      <p className={expandedInjects.has(inject.id) ? '' : 'line-clamp-2'}>
                        {inject.content}
                      </p>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedInjects((prev) => {
                            const next = new Set(prev);
                            if (next.has(inject.id)) {
                              next.delete(inject.id);
                            } else {
                              next.add(inject.id);
                            }
                            return next;
                          });
                        }}
                        className="text-xs terminal-text text-robotic-yellow/70 hover:text-robotic-yellow mt-1 uppercase"
                      >
                        {expandedInjects.has(inject.id) ? '[SHOW LESS]' : '[SHOW MORE]'}
                      </button>
                    </>
                  ) : (
                    <p>{inject.content}</p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 text-xs terminal-text text-robotic-yellow/50">
                  <span>[{inject.type}]</span>
                  <span className={`px-2 py-1 border ${getSeverityColor(inject.severity)}`}>
                    {inject.severity.toUpperCase()}
                  </span>
                  {inject.trigger_time_minutes !== null && (
                    <span>[TRIGGER] {inject.trigger_time_minutes}min</span>
                  )}
                  {inject.requires_response && <span>[REQUIRES_RESPONSE]</span>}
                  <span className="px-2 py-0.5 military-border bg-robotic-gray-200">
                    [
                    {inject.inject_scope === 'universal'
                      ? 'UNIVERSAL'
                      : inject.inject_scope === 'role_specific'
                        ? 'ROLE-SPECIFIC'
                        : inject.inject_scope === 'team_specific'
                          ? 'TEAM-SPECIFIC'
                          : 'UNIVERSAL'}
                    ]
                  </span>
                  {inject.inject_scope === 'team_specific' &&
                    inject.target_teams &&
                    inject.target_teams.length > 0 && (
                      <span>Teams: {inject.target_teams.join(', ').toUpperCase()}</span>
                    )}
                  {inject.requires_coordination && (
                    <span className="text-robotic-orange">[REQUIRES_COORDINATION]</span>
                  )}
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handlePublishInject(inject.id);
                }}
                className="military-button px-4 py-2 text-sm whitespace-nowrap flex-shrink-0"
              >
                [PUBLISH]
              </button>
            </div>
          </div>
        ))}
        {injects.length === 0 && (
          <div className="military-border p-8 text-center">
            <p className="text-sm terminal-text text-robotic-yellow/50">
              [NO_INJECTS] No injects available
            </p>
          </div>
        )}
      </div>

      {/* Create Inject Modal */}
      {showCreateModal && (
        <CreateInjectForm
          sessionId={sessionId}
          scenarioId={scenarioId}
          onClose={() => setShowCreateModal(false)}
          onSuccess={loadInjects}
        />
      )}
    </div>
  );
};
