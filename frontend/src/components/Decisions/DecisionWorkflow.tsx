import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { api } from '../../lib/api';
import { useWebSocket } from '../../hooks/useWebSocket';
import { CreateDecisionForm } from '../Forms/CreateDecisionForm';

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
  required_approvers?: string[];
  created_at: string;
  executed_at?: string;
  creator?: {
    id: string;
    full_name: string;
    role: string;
  };
  proposed_by?: string;
  response_to_incident_id?: string;
  steps?: DecisionStep[];
  environmental_consistency?: {
    consistent?: boolean;
    mismatch_kind?: string;
    severity?: string;
    reason?: string;
    feedback?: string;
    specific?: boolean;
    missing_details?: string[];
    error_type?: string;
    consequence_title?: string;
    rejected?: boolean;
    rejection_reason?: string;
  } | null;
  evaluation_reasoning?: {
    env_prerequisite?: string;
    editorial_review?: {
      verdict: string;
      score: number;
      feedback: string;
      editor_name: string;
      platform_notes?: string;
      dimensions?: Record<string, number>;
    };
    editorial_revision_count?: number;
  } | null;
  ai_classification?: {
    category?: string;
    keywords?: string[];
    semantic_tags?: string[];
  } | null;
}

interface DecisionWorkflowProps {
  sessionId: string;
  filterTeam?: string;
  hideCreateButton?: boolean;
  showEvaluation?: boolean;
}

export const DecisionWorkflow = ({
  sessionId,
  filterTeam = 'none',
  hideCreateButton = false,
  showEvaluation = true,
}: DecisionWorkflowProps) => {
  const { user } = useAuth();
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDecision, setSelectedDecision] = useState<Decision | null>(null);
  const [expandedDecisions, setExpandedDecisions] = useState<Set<string>>(new Set());
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [revisionDecision, setRevisionDecision] = useState<Decision | null>(null);
  const [userTeamMap, setUserTeamMap] = useState<Map<string, string>>(new Map());

  // Load team mappings for filtering
  useEffect(() => {
    const loadTeams = async () => {
      try {
        const result = await api.teams.getSessionTeams(sessionId);
        const map = new Map<string, string>();
        for (const t of result.data ?? []) {
          map.set(t.user_id, t.team_name);
        }
        setUserTeamMap(map);
      } catch {
        /* non-critical */
      }
    };
    loadTeams();
  }, [sessionId]);

  // Initial load
  useEffect(() => {
    loadDecisions();
  }, [sessionId]);

  // Poll for AI evaluation results on recently-executed decisions
  useEffect(() => {
    const hasAwaitingEval = decisions.some(
      (d) => d.status === 'executed' && !d.environmental_consistency && d.executed_at,
    );
    if (!hasAwaitingEval) return;
    const timer = setInterval(loadDecisions, 5000);
    return () => clearInterval(timer);
  }, [decisions, sessionId]);

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
        return 'bg-accent/10 text-ink border-border';
      case 'rejected':
        return 'bg-accent/10 text-accent border-accent';
      case 'pending':
        return 'bg-surface-2 text-muted border-border';
      default:
        return 'bg-surface-2 text-muted border-border';
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
          <div className="text-sm terminal-text text-muted animate-pulse">Loading decisions…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="military-border p-4">
        <div className="flex justify-between items-start gap-4">
          <div>
            <h3 className="text-lg terminal-text">Decision queue</h3>
            <p className="text-xs terminal-text text-muted mt-1">
              Respond to incidents from the Incidents panel, or create pre-emptive decisions below.
            </p>
          </div>
          {!hideCreateButton && (
            <button
              onClick={() => setShowCreateForm(true)}
              className="military-button px-4 py-2 text-xs terminal-text whitespace-nowrap border-success text-success hover:bg-success/10"
            >
              Create decision
            </button>
          )}
        </div>
      </div>

      {showCreateForm && (
        <CreateDecisionForm
          sessionId={sessionId}
          onClose={() => setShowCreateForm(false)}
          onSuccess={() => {
            loadDecisions();
            setShowCreateForm(false);
          }}
        />
      )}

      {revisionDecision && (
        <CreateDecisionForm
          sessionId={sessionId}
          incidentId={revisionDecision.response_to_incident_id}
          prefillDescription={revisionDecision.description}
          editorialFeedback={
            revisionDecision.evaluation_reasoning?.editorial_review
              ? {
                  editor_name: revisionDecision.evaluation_reasoning.editorial_review.editor_name,
                  feedback: revisionDecision.evaluation_reasoning.editorial_review.feedback,
                  score: revisionDecision.evaluation_reasoning.editorial_review.score,
                  verdict: revisionDecision.evaluation_reasoning.editorial_review.verdict,
                }
              : undefined
          }
          responseType="media_statement"
          onClose={() => setRevisionDecision(null)}
          onSuccess={() => {
            loadDecisions();
            setRevisionDecision(null);
          }}
        />
      )}

      <div className="space-y-3">
        {decisions
          .filter((decision) => {
            if (filterTeam === 'none') return true;
            if (!decision.proposed_by) return filterTeam === 'All teams';
            const team = userTeamMap.get(decision.proposed_by);
            if (filterTeam === 'All teams') return !team;
            return team === filterTeam;
          })
          .map((decision) => (
            <div
              key={decision.id}
              className="military-border p-4 cursor-pointer hover:border-accent transition-all"
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
              <div className="text-xs terminal-text text-muted mb-2">
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
                      className="text-xs terminal-text text-muted hover:text-ink mt-1"
                    >
                      {expandedDecisions.has(decision.id) ? 'Show less' : 'Show more'}
                    </button>
                  </>
                ) : (
                  <p>{decision.description}</p>
                )}
              </div>
              {/* AI Evaluation Feedback — trainer only */}
              {showEvaluation &&
                decision.status === 'executed' &&
                decision.environmental_consistency &&
                (() => {
                  const ec = decision.environmental_consistency;
                  const isRejected = ec.rejected === true;
                  const hasEnvIssue = !ec.consistent;
                  const hasSpecificityIssue = ec.specific === false;

                  const borderClass = isRejected
                    ? 'border-danger bg-danger/10 text-danger'
                    : hasEnvIssue
                      ? 'border-danger bg-danger/10 text-danger'
                      : hasSpecificityIssue
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-success bg-success/10 text-success';

                  const badge = isRejected
                    ? '✗ Rejected'
                    : hasEnvIssue && ec.mismatch_kind === 'below_standard'
                      ? '⚠ Below Standard'
                      : hasEnvIssue
                        ? '✗ Issue Detected'
                        : hasSpecificityIssue
                          ? '⚠ Lacks Specificity'
                          : '✓ Meets Standards';

                  return (
                    <div className={`mt-2 p-2 rounded border text-xs terminal-text ${borderClass}`}>
                      <span className="font-bold">{badge}</span>
                      {ec.severity && <span className="ml-2 opacity-70">[{ec.severity}]</span>}
                      {ec.consequence_title && (
                        <span className="ml-2 opacity-80 italic">{ec.consequence_title}</span>
                      )}
                      {(ec.feedback || ec.reason || ec.rejection_reason) && (
                        <p className="mt-1 opacity-90">
                          {ec.rejection_reason || ec.feedback || ec.reason}
                        </p>
                      )}
                    </div>
                  );
                })()}
              {showEvaluation &&
                decision.status === 'executed' &&
                !decision.environmental_consistency &&
                decision.executed_at && (
                  <div className="mt-2 p-2 rounded border border-border bg-accent/10 text-xs terminal-text text-muted">
                    ⏳ Awaiting AI evaluation…
                  </div>
                )}

              {decision.evaluation_reasoning?.editorial_review &&
                (() => {
                  const er = decision.evaluation_reasoning.editorial_review;
                  const revCount = decision.evaluation_reasoning.editorial_revision_count ?? 0;
                  const borderClass =
                    er.verdict === 'approved'
                      ? 'border-success bg-success/10 text-success'
                      : er.verdict === 'rejected'
                        ? 'border-danger bg-danger/10 text-danger'
                        : 'border-accent bg-accent/10 text-accent';
                  const badge =
                    er.verdict === 'approved'
                      ? `✓ Approved (${er.score}/10)`
                      : er.verdict === 'rejected'
                        ? `✗ Rejected (${er.score}/10)`
                        : `⚠ Revision Requested (${er.score}/10)`;
                  return (
                    <div className={`mt-2 p-2 rounded border text-xs terminal-text ${borderClass}`}>
                      <span className="font-bold">{badge}</span>
                      {revCount > 0 && (
                        <span className="ml-2 opacity-70">[Revision #{revCount}]</span>
                      )}
                      <p className="mt-1 opacity-80 italic">{er.editor_name}</p>
                      <p className="mt-1 opacity-90">{er.feedback}</p>
                      {er.platform_notes && (
                        <p className="mt-1 opacity-70">Platform: {er.platform_notes}</p>
                      )}
                      {er.verdict !== 'approved' && decision.proposed_by === user?.id && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setRevisionDecision(decision);
                          }}
                          className="mt-2 px-3 py-1 text-xs terminal-text border border-accent text-accent hover:bg-accent/10"
                        >
                          Revise statement
                        </button>
                      )}
                    </div>
                  );
                })()}

              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
                <div className="text-xs terminal-text text-muted">
                  {decision.decision_type} • {decision.creator?.full_name || 'Unknown'}
                </div>
                {canApprove(decision) && (
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleApprove(decision.id, true);
                      }}
                      className="px-3 py-1 text-xs terminal-text border border-border text-ink hover:bg-accent/10"
                    >
                      Approve
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleApprove(decision.id, false);
                      }}
                      className="px-3 py-1 text-xs terminal-text border border-accent text-accent hover:bg-accent/10"
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        {decisions.length === 0 && (
          <div className="military-border p-8 text-center">
            <p className="text-sm terminal-text text-muted">No decisions yet</p>
          </div>
        )}
      </div>

      {/* Decision Detail Modal */}
      {selectedDecision && (
        <div className="fixed inset-0 bg-ink/40 flex items-center justify-center z-50 p-4">
          <div className="military-border bg-surface p-8 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-start mb-4">
              <h2 className="text-xl terminal-text">{selectedDecision.title}</h2>
              <button
                onClick={() => setSelectedDecision(null)}
                className="text-accent hover:text-ink"
              >
                Close
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <h3 className="text-sm terminal-text text-muted mb-2">Description</h3>
                <p className="text-sm terminal-text">{selectedDecision.description}</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <h3 className="text-sm terminal-text text-muted mb-2">Type</h3>
                  <p className="text-sm terminal-text">{selectedDecision.decision_type}</p>
                </div>
                <div>
                  <h3 className="text-sm terminal-text text-muted mb-2">Status</h3>
                  <p className="text-sm terminal-text">{selectedDecision.status}</p>
                </div>
              </div>
              {((selectedDecision.steps && selectedDecision.steps.length > 0) ||
                (selectedDecision.required_approvers &&
                  selectedDecision.required_approvers.length > 0)) && (
                <div>
                  <h3 className="text-sm terminal-text text-muted mb-2">Approval progress</h3>
                  <div className="space-y-2">
                    {selectedDecision.steps && selectedDecision.steps.length > 0 ? (
                      selectedDecision.steps
                        .sort((a, b) => a.step_order - b.step_order)
                        .map((step) => (
                          <div
                            key={step.id}
                            className={`flex items-center justify-between p-2 border ${
                              step.status === 'approved'
                                ? 'border-success bg-success/10'
                                : step.status === 'rejected'
                                  ? 'border-danger bg-danger/10'
                                  : 'border-border bg-surface-2'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-xs terminal-text text-muted">
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
                                <span className="text-xs terminal-text text-success">
                                  ✓ Approved
                                </span>
                              )}
                              {step.status === 'rejected' && (
                                <span className="text-xs terminal-text text-danger">
                                  ✗ Rejected
                                </span>
                              )}
                              {step.status === 'pending' && (
                                <span className="text-xs terminal-text text-muted">Pending</span>
                              )}
                              {step.approver && (
                                <span className="text-xs terminal-text text-muted">
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
                          <span key={idx} className="text-xs terminal-text px-2 py-1 bg-surface-2">
                            {role}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              )}
              {/* AI Evaluation Detail — trainer only */}
              {showEvaluation &&
                selectedDecision.status === 'executed' &&
                selectedDecision.environmental_consistency &&
                (() => {
                  const ec = selectedDecision.environmental_consistency;
                  const isRejected = ec.rejected === true;
                  const hasEnvIssue = !ec.consistent;
                  const hasSpecificityIssue = ec.specific === false;

                  const borderClass = isRejected
                    ? 'border-danger bg-danger/10'
                    : hasEnvIssue
                      ? 'border-danger bg-danger/10'
                      : hasSpecificityIssue
                        ? 'border-accent bg-accent/10'
                        : 'border-success bg-success/10';

                  const textClass =
                    isRejected || hasEnvIssue
                      ? 'text-danger'
                      : hasSpecificityIssue
                        ? 'text-accent'
                        : 'text-success';

                  const statusText = isRejected
                    ? '✗ Action Rejected'
                    : hasEnvIssue && ec.mismatch_kind === 'below_standard'
                      ? '⚠ Below Standard — does not meet sector/response standards'
                      : hasEnvIssue
                        ? '✗ Issue detected — decision conflicts with ground conditions'
                        : hasSpecificityIssue
                          ? '⚠ Lacks Specificity — decision needs more operational detail'
                          : '✓ Decision meets standards and is operationally sound';

                  return (
                    <div className={`p-3 rounded border ${borderClass}`}>
                      <h3 className="text-sm terminal-text text-muted mb-2">AI evaluation</h3>
                      <div className={`text-sm terminal-text ${textClass}`}>
                        <span className="font-bold">{statusText}</span>
                        {ec.severity && (
                          <span className="ml-2 opacity-70">(Severity: {ec.severity})</span>
                        )}
                      </div>
                      {ec.consequence_title && (
                        <p className="mt-1 text-xs terminal-text text-muted italic">
                          {ec.consequence_title}
                        </p>
                      )}
                      {(ec.rejection_reason || ec.feedback || ec.reason) && (
                        <p className="mt-2 text-xs terminal-text text-ink">
                          {ec.rejection_reason || ec.feedback || ec.reason}
                        </p>
                      )}
                      {selectedDecision.evaluation_reasoning?.env_prerequisite && (
                        <p className="mt-2 text-xs terminal-text text-muted border-t border-border pt-2">
                          {selectedDecision.evaluation_reasoning.env_prerequisite}
                        </p>
                      )}
                    </div>
                  );
                })()}
              {showEvaluation &&
                selectedDecision.status === 'executed' &&
                !selectedDecision.environmental_consistency &&
                selectedDecision.executed_at && (
                  <div className="p-3 rounded border border-border bg-accent/10">
                    <p className="text-xs terminal-text text-muted">
                      ⏳ AI evaluation in progress…
                    </p>
                  </div>
                )}

              {canApprove(selectedDecision) && (
                <div className="flex flex-col sm:flex-row gap-2 sm:gap-4 pt-4 border-t border-border">
                  <button
                    onClick={() => handleApprove(selectedDecision.id, true)}
                    className="military-button px-6 py-3 flex-1 whitespace-nowrap"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => handleApprove(selectedDecision.id, false)}
                    className="military-button-outline px-6 py-3 flex-1 border border-accent text-accent whitespace-nowrap"
                  >
                    Reject
                  </button>
                </div>
              )}
              {(selectedDecision.status === 'approved' ||
                (selectedDecision.status === 'proposed' &&
                  (selectedDecision.creator?.id === user?.id ||
                    selectedDecision.proposed_by === user?.id))) && (
                <div className="pt-4 border-t border-border">
                  <button
                    onClick={() => handleExecute(selectedDecision.id)}
                    className="military-button px-6 py-3 w-full border-success text-success hover:bg-success/10"
                  >
                    Execute decision
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
