import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { api } from '../../lib/api';
import { CreateDecisionForm } from '../Forms/CreateDecisionForm';
import { useWebSocket } from '../../hooks/useWebSocket';

interface DecisionStep {
  id: string;
  user_id?: string;
  role?: string;
  approver_role?: string;
  step_order: number;
  status: string;
  approved_by?: string;
  approved_at?: string;
  comment?: string;
  approver?: {
    id: string;
    full_name: string;
    role: string;
  };
}

interface Decision {
  id: string;
  title: string;
  description: string;
  decision_type: string;
  status: string;
  required_approvers?: string[]; // Optional, deprecated - use steps instead
  created_at: string;
  creator?: {
    id: string;
    full_name: string;
    role: string;
  };
  proposed_by?: string;
  steps?: DecisionStep[];
}

interface DecisionWorkflowProps {
  sessionId: string;
}

export const DecisionWorkflow = ({ sessionId }: DecisionWorkflowProps) => {
  const { user } = useAuth();
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedDecision, setSelectedDecision] = useState<Decision | null>(null);
  const [expandedDecisions, setExpandedDecisions] = useState<Set<string>>(new Set());

  // Initial load
  useEffect(() => {
    loadDecisions();
  }, [sessionId]);

  // WebSocket subscription for real-time decision updates
  useWebSocket({
    sessionId,
    eventTypes: [
      'decision.proposed',
      'decision.approved',
      'decision.rejected',
      'decision.executed',
    ],
    onEvent: async () => {
      // Reload decisions when any decision event occurs
      await loadDecisions();
    },
    enabled: !!sessionId,
  });

  const loadDecisions = async () => {
    try {
      const result = await api.decisions.list(sessionId);
      setDecisions(result.data as Decision[]);
    } catch (error) {
      console.error('Failed to load decisions:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async (decisionId: string, approved: boolean) => {
    try {
      await api.decisions.approve(decisionId, approved);
      // Reload decisions to get updated status and steps
      await loadDecisions();
      setSelectedDecision(null);
    } catch (error) {
      console.error('Failed to approve decision:', error);
      // Even on error, reload to get latest state (decision might have been approved by someone else)
      await loadDecisions();
      // Only show alert if it's not the "no pending step" error (which means it was already approved)
      if (error instanceof Error && !error.message.includes('No pending approval step')) {
        alert('Failed to update decision');
      }
    }
  };

  const handleExecute = async (decisionId: string) => {
    try {
      await api.decisions.execute(decisionId);
      // Don't reload - WebSocket will handle the update
      setSelectedDecision(null);
    } catch (error) {
      console.error('Failed to execute decision:', error);
      alert('Failed to execute decision');
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'approved':
        return 'bg-robotic-yellow/20 text-robotic-yellow border-robotic-yellow';
      case 'rejected':
        return 'bg-robotic-orange/20 text-robotic-orange border-robotic-orange';
      case 'pending':
        return 'bg-robotic-gray-200 text-robotic-gray-50 border-robotic-gray-200';
      default:
        return 'bg-robotic-gray-200 text-robotic-gray-50 border-robotic-gray-200';
    }
  };

  const canApprove = (decision: Decision) => {
    // Only decisions that are proposed or under review can be approved
    if (decision.status !== 'proposed' && decision.status !== 'under_review') {
      return false;
    }

    // Check if user has a pending step for this decision
    if (decision.steps && decision.steps.length > 0) {
      return decision.steps.some((step) => step.status === 'pending' && step.user_id === user?.id);
    }

    // Fallback for old format (shouldn't happen but just in case)
    if (decision.required_approvers) {
      return decision.required_approvers.includes(user?.role || '');
    }

    return false;
  };

  if (loading) {
    return (
      <div className="military-border p-6">
        <div className="text-center">
          <div className="text-sm terminal-text text-robotic-yellow/50 animate-pulse">
            [LOADING_DECISIONS]
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="military-border p-4 flex justify-between items-center">
        <h3 className="text-lg terminal-text uppercase">[DECISIONS] Decision Queue</h3>
        <button
          onClick={() => setShowCreateModal(true)}
          className="military-button px-4 py-2 text-sm"
        >
          [CREATE_DECISION]
        </button>
      </div>

      <div className="space-y-3">
        {decisions.map((decision) => (
          <div
            key={decision.id}
            className="military-border p-4 cursor-pointer hover:border-robotic-yellow transition-all"
            onClick={() => setSelectedDecision(decision)}
          >
            <div className="flex justify-between items-start mb-2">
              <h4 className="text-sm terminal-text font-semibold">{decision.title}</h4>
              <span
                className={`text-xs terminal-text px-2 py-1 border ${getStatusColor(decision.status)}`}
              >
                {decision.status.toUpperCase()}
              </span>
            </div>
            <div className="text-xs terminal-text text-robotic-yellow/70 mb-2">
              {decision.description.length > 150 ? (
                <>
                  <p className={expandedDecisions.has(decision.id) ? '' : 'line-clamp-2'}>
                    {decision.description}
                  </p>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpandedDecisions((prev) => {
                        const next = new Set(prev);
                        if (next.has(decision.id)) {
                          next.delete(decision.id);
                        } else {
                          next.add(decision.id);
                        }
                        return next;
                      });
                    }}
                    className="text-xs terminal-text text-robotic-yellow/70 hover:text-robotic-yellow mt-1 uppercase"
                  >
                    {expandedDecisions.has(decision.id) ? '[SHOW LESS]' : '[SHOW MORE]'}
                  </button>
                </>
              ) : (
                <p>{decision.description}</p>
              )}
            </div>
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
              <div className="text-xs terminal-text text-robotic-yellow/50">
                [{decision.decision_type}] • {decision.creator?.full_name || 'Unknown'}
              </div>
              {canApprove(decision) && (
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleApprove(decision.id, true);
                    }}
                    className="px-3 py-1 text-xs terminal-text border border-robotic-yellow text-robotic-yellow hover:bg-robotic-yellow/10"
                  >
                    [APPROVE]
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleApprove(decision.id, false);
                    }}
                    className="px-3 py-1 text-xs terminal-text border border-robotic-orange text-robotic-orange hover:bg-robotic-orange/10"
                  >
                    [REJECT]
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
        {decisions.length === 0 && (
          <div className="military-border p-8 text-center">
            <p className="text-sm terminal-text text-robotic-yellow/50">
              [NO_DECISIONS] No decisions yet
            </p>
          </div>
        )}
      </div>

      {/* Decision Detail Modal */}
      {selectedDecision && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="military-border bg-robotic-gray-300 p-8 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-start mb-4">
              <h2 className="text-xl terminal-text uppercase">{selectedDecision.title}</h2>
              <button
                onClick={() => setSelectedDecision(null)}
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
                <p className="text-sm terminal-text">{selectedDecision.description}</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <h3 className="text-sm terminal-text text-robotic-yellow/70 uppercase mb-2">
                    [TYPE]
                  </h3>
                  <p className="text-sm terminal-text">{selectedDecision.decision_type}</p>
                </div>
                <div>
                  <h3 className="text-sm terminal-text text-robotic-yellow/70 uppercase mb-2">
                    [STATUS]
                  </h3>
                  <p className="text-sm terminal-text">{selectedDecision.status}</p>
                </div>
              </div>
              {((selectedDecision.steps && selectedDecision.steps.length > 0) ||
                (selectedDecision.required_approvers &&
                  selectedDecision.required_approvers.length > 0)) && (
                <div>
                  <h3 className="text-sm terminal-text text-robotic-yellow/70 uppercase mb-2">
                    [APPROVAL_PROGRESS]
                  </h3>
                  <div className="space-y-2">
                    {selectedDecision.steps && selectedDecision.steps.length > 0 ? (
                      selectedDecision.steps
                        .sort((a, b) => a.step_order - b.step_order)
                        .map((step) => (
                          <div
                            key={step.id}
                            className={`flex items-center justify-between p-2 border ${
                              step.status === 'approved'
                                ? 'border-green-400 bg-green-400/10'
                                : step.status === 'rejected'
                                  ? 'border-red-400 bg-red-400/10'
                                  : 'border-robotic-yellow/30 bg-robotic-gray-200'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-xs terminal-text text-robotic-yellow/70">
                                Step {step.step_order}:
                              </span>
                              <span className="text-xs terminal-text">
                                {step.approver_role ||
                                  step.role ||
                                  step.approver?.full_name ||
                                  'Unknown'}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              {step.status === 'approved' && (
                                <span className="text-xs terminal-text text-green-400">
                                  ✓ APPROVED
                                </span>
                              )}
                              {step.status === 'rejected' && (
                                <span className="text-xs terminal-text text-red-400">
                                  ✗ REJECTED
                                </span>
                              )}
                              {step.status === 'pending' && (
                                <span className="text-xs terminal-text text-robotic-yellow/50">
                                  PENDING
                                </span>
                              )}
                              {step.approver && (
                                <span className="text-xs terminal-text text-robotic-yellow/50">
                                  by {step.approver.full_name}
                                </span>
                              )}
                            </div>
                          </div>
                        ))
                    ) : selectedDecision.required_approvers &&
                      selectedDecision.required_approvers.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {selectedDecision.required_approvers.map((role, idx) => (
                          <span
                            key={idx}
                            className="text-xs terminal-text px-2 py-1 bg-robotic-gray-200"
                          >
                            {role}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              )}
              {canApprove(selectedDecision) && (
                <div className="flex flex-col sm:flex-row gap-2 sm:gap-4 pt-4 border-t border-robotic-yellow/30">
                  <button
                    onClick={() => handleApprove(selectedDecision.id, true)}
                    className="military-button px-6 py-3 flex-1 whitespace-nowrap"
                  >
                    [APPROVE]
                  </button>
                  <button
                    onClick={() => handleApprove(selectedDecision.id, false)}
                    className="military-button px-6 py-3 flex-1 border-robotic-orange text-robotic-orange whitespace-nowrap"
                  >
                    [REJECT]
                  </button>
                </div>
              )}
              {(selectedDecision.status === 'approved' ||
                (selectedDecision.status === 'proposed' &&
                  (selectedDecision.creator?.id === user?.id ||
                    selectedDecision.proposed_by === user?.id))) && (
                <div className="pt-4 border-t border-robotic-yellow/30">
                  <button
                    onClick={() => handleExecute(selectedDecision.id)}
                    className="military-button px-6 py-3 w-full border-green-400 text-green-400 hover:bg-green-400/10"
                  >
                    [EXECUTE_DECISION]
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Create Decision Modal */}
      {showCreateModal && (
        <CreateDecisionForm
          sessionId={sessionId}
          onClose={() => setShowCreateModal(false)}
          onSuccess={loadDecisions}
        />
      )}
    </div>
  );
};
