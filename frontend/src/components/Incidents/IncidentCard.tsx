import { useState, useRef, useEffect } from 'react';
import { api } from '../../lib/api';

/**
 * Incident Card Component - Client-side only
 * Separation of concerns: UI for displaying a single incident
 */

interface Incident {
  id: string;
  title: string;
  description: string;
  type: string;
  severity: string;
  status: string;
  location_lat?: number | null;
  location_lng?: number | null;
  casualty_count?: number;
  reported_at: string;
  updated_at: string;
  /** Which team(s) this incident is for (from inject scope/target_teams). Set by API. */
  for_teams_display?: string;
  /** When false, incident is status-update only; do not show [DECISION] button. */
  requires_response?: boolean;
  /** Origin of the inject that created this incident */
  generation_source?: string | null;
  reported_by?: {
    id: string;
    full_name: string;
    role: string;
  };
  assigned_to_user?: {
    id: string;
    full_name: string;
    role: string;
  };
  assignments?: Array<{
    assignment_type?: string;
    user_id?: string;
    agency_role?: string;
    assigned_at: string;
    notes?: string;
    assigned_user?: {
      id: string;
      full_name: string;
    };
  }>;
}

interface IncidentCardProps {
  incident: Incident;
  onUpdate: () => void;
  isSelected?: boolean;
  onSelect?: () => void;
  /** When user clicks Decision, open create-decision flow for this incident */
  onDecisionClick?: (incidentId: string) => void;
  /** True if this incident already has an executed decision (show "Done" instead of "Decision") */
  hasExecutedDecision?: boolean;
  /** Trainers can see the decision indicator but cannot click it */
  isTrainer?: boolean;
}

const SOURCE_BADGE: Record<string, { label: string; color: string }> = {
  pathway_outcome: {
    label: 'PATHWAY',
    color: 'border-amber-400/60 text-amber-400/80 bg-amber-400/10',
  },
  inaction_penalty: { label: 'INACTION', color: 'border-red-400/60 text-red-400/80 bg-red-400/10' },
  decision_response: {
    label: 'CONSEQUENCE',
    color: 'border-cyan-400/60 text-cyan-400/80 bg-cyan-400/10',
  },
  war_room: {
    label: 'WAR ROOM',
    color: 'border-purple-400/60 text-purple-400/80 bg-purple-400/10',
  },
  trainer: { label: 'TRAINER', color: 'border-blue-400/60 text-blue-400/80 bg-blue-400/10' },
};

export const IncidentCard = ({
  incident,
  onUpdate,
  isSelected,
  onSelect,
  onDecisionClick,
  hasExecutedDecision,
  isTrainer,
}: IncidentCardProps) => {
  // const { user } = useAuth(); // Unused - keeping for potential future use
  const [updating, setUpdating] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const descriptionRef = useRef<HTMLDivElement>(null);

  // When expanded, scroll the description into view so long content (e.g. impact matrix text) is visible
  useEffect(() => {
    if (isExpanded && descriptionRef.current) {
      descriptionRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [isExpanded]);

  const handleStatusChange = async (newStatus: string) => {
    setUpdating(true);
    try {
      await api.incidents.update(incident.id, { status: newStatus });
      onUpdate();
    } catch (error) {
      console.error('Failed to update incident status:', error);
      alert('Failed to update incident status');
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div
      className={`military-border p-4 transition-all cursor-pointer ${
        isSelected ? 'border-robotic-yellow bg-robotic-yellow/10' : 'hover:border-robotic-yellow'
      }`}
      onClick={onSelect}
    >
      <div className="flex justify-between items-start mb-2">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <h4 className="text-sm terminal-text font-semibold">{incident.title}</h4>
            {incident.generation_source && SOURCE_BADGE[incident.generation_source] && (
              <span
                className={`px-1.5 py-0.5 text-[10px] terminal-text border whitespace-nowrap ${SOURCE_BADGE[incident.generation_source].color}`}
              >
                {SOURCE_BADGE[incident.generation_source].label}
              </span>
            )}
          </div>
          <div ref={descriptionRef} className="text-xs terminal-text text-robotic-yellow/70 mb-2">
            {incident.description.length > 150 ? (
              <>
                <p className={isExpanded ? 'whitespace-pre-wrap break-words' : 'line-clamp-2'}>
                  {incident.description}
                </p>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsExpanded(!isExpanded);
                  }}
                  className="text-xs terminal-text text-robotic-yellow/70 hover:text-robotic-yellow mt-1 uppercase"
                >
                  {isExpanded ? '[SHOW LESS]' : '[SHOW MORE]'}
                </button>
              </>
            ) : (
              <p className="whitespace-pre-wrap break-words">{incident.description}</p>
            )}
          </div>
          <div className="flex flex-wrap gap-2 text-xs terminal-text text-robotic-yellow/50">
            <span>For: {incident.for_teams_display ?? 'All teams'}</span>
            {incident.casualty_count !== undefined && incident.casualty_count > 0 && (
              <span>Casualties: {incident.casualty_count}</span>
            )}
            {incident.location_lat && incident.location_lng && (
              <span>
                📍 {incident.location_lat.toFixed(4)}, {incident.location_lng.toFixed(4)}
              </span>
            )}
            {incident.assigned_to_user && (
              <span>Assigned to: {incident.assigned_to_user.full_name}</span>
            )}
          </div>
          {incident.assignments && incident.assignments.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {incident.assignments.map((assignment, idx) => {
                const displayValue =
                  (assignment as any).assigned_user?.full_name ||
                  (assignment as any).user_id ||
                  assignment.agency_role ||
                  'Unknown';

                return (
                  <span
                    key={idx}
                    className="text-xs terminal-text px-2 py-1 bg-robotic-gray-200 border border-robotic-yellow/30"
                    title={assignment.notes || undefined}
                  >
                    {typeof displayValue === 'string' && displayValue.includes('_')
                      ? displayValue.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
                      : displayValue}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-robotic-yellow/30">
        {onDecisionClick != null &&
          incident.requires_response !== false &&
          (hasExecutedDecision ? (
            <span
              className="px-3 py-1 text-xs terminal-text border border-green-400/50 text-green-400/80 bg-green-400/10 whitespace-nowrap cursor-default"
              title="This incident has already been addressed with a decision"
            >
              [DONE]
            </span>
          ) : isTrainer ? (
            <span
              className="px-3 py-1 text-xs terminal-text border border-robotic-yellow/40 text-robotic-yellow/40 whitespace-nowrap cursor-not-allowed"
              title="Requires a player decision"
            >
              [DECISION]
            </span>
          ) : (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDecisionClick(incident.id);
              }}
              className="px-3 py-1 text-xs terminal-text border border-robotic-yellow text-robotic-yellow hover:bg-robotic-yellow/10 whitespace-nowrap"
            >
              [DECISION]
            </button>
          ))}
        {incident.status === 'under_control' && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleStatusChange('resolved');
            }}
            disabled={updating}
            className="px-3 py-1 text-xs terminal-text border border-green-400 text-green-400 hover:bg-green-400/10 disabled:opacity-50 whitespace-nowrap"
          >
            [RESOLVE]
          </button>
        )}
      </div>
    </div>
  );
};
