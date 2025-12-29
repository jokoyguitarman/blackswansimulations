import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
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
    assignment_type?: 'agency_role';
    agency_role?: string;
    assigned_at: string;
    notes?: string;
  }>;
}

interface IncidentCardProps {
  incident: Incident;
  onAssign: () => void;
  onUpdate: () => void;
  isSelected?: boolean;
  onSelect?: () => void;
}

export const IncidentCard = ({
  incident,
  onAssign,
  onUpdate,
  isSelected,
  onSelect,
}: IncidentCardProps) => {
  const { user } = useAuth();
  const [updating, setUpdating] = useState(false);

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical':
        return 'bg-red-900/20 text-red-400 border-red-400';
      case 'high':
        return 'bg-robotic-orange/20 text-robotic-orange border-robotic-orange';
      case 'medium':
        return 'bg-robotic-yellow/20 text-robotic-yellow border-robotic-yellow';
      case 'low':
        return 'bg-robotic-gray-200 text-robotic-gray-50 border-robotic-gray-200';
      default:
        return 'bg-robotic-gray-200 text-robotic-gray-50 border-robotic-gray-200';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'resolved':
      case 'contained':
        return 'bg-green-900/20 text-green-400 border-green-400';
      case 'under_control':
        return 'bg-robotic-yellow/20 text-robotic-yellow border-robotic-yellow';
      case 'active':
        return 'bg-robotic-orange/20 text-robotic-orange border-robotic-orange';
      default:
        return 'bg-robotic-gray-200 text-robotic-gray-50 border-robotic-gray-200';
    }
  };

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
          <div className="flex items-center gap-2 mb-1">
            <h4 className="text-sm terminal-text font-semibold">{incident.title}</h4>
            <span
              className={`text-xs terminal-text px-2 py-1 border ${getSeverityColor(incident.severity)}`}
            >
              {incident.severity.toUpperCase()}
            </span>
            <span
              className={`text-xs terminal-text px-2 py-1 border ${getStatusColor(incident.status)}`}
            >
              {incident.status.toUpperCase().replace('_', ' ')}
            </span>
          </div>
          <p className="text-xs terminal-text text-robotic-yellow/70 mb-2 line-clamp-2">
            {incident.description}
          </p>
          <div className="flex flex-wrap gap-2 text-xs terminal-text text-robotic-yellow/50">
            <span>[{incident.type}]</span>
            {incident.casualty_count !== undefined && incident.casualty_count > 0 && (
              <span>Casualties: {incident.casualty_count}</span>
            )}
            {incident.location_lat && incident.location_lng && (
              <span>
                📍 {incident.location_lat.toFixed(4)}, {incident.location_lng.toFixed(4)}
              </span>
            )}
            {incident.reported_by && (
              <span>
                Reported by: {incident.reported_by.full_name} [{incident.reported_by.role}]
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
                  assignment.assigned_user?.full_name ||
                  assignment.user_id ||
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
      <div className="flex gap-2 mt-3 pt-3 border-t border-robotic-yellow/30">
        <button
          onClick={onAssign}
          className="px-3 py-1 text-xs terminal-text border border-robotic-yellow text-robotic-yellow hover:bg-robotic-yellow/10"
        >
          [ASSIGN]
        </button>
        {incident.status === 'active' && (
          <>
            <button
              onClick={() => handleStatusChange('under_control')}
              disabled={updating}
              className="px-3 py-1 text-xs terminal-text border border-robotic-yellow text-robotic-yellow hover:bg-robotic-yellow/10 disabled:opacity-50"
            >
              [UNDER_CONTROL]
            </button>
            <button
              onClick={() => handleStatusChange('contained')}
              disabled={updating}
              className="px-3 py-1 text-xs terminal-text border border-green-400 text-green-400 hover:bg-green-400/10 disabled:opacity-50"
            >
              [CONTAINED]
            </button>
          </>
        )}
        {incident.status === 'under_control' && (
          <button
            onClick={() => handleStatusChange('resolved')}
            disabled={updating}
            className="px-3 py-1 text-xs terminal-text border border-green-400 text-green-400 hover:bg-green-400/10 disabled:opacity-50"
          >
            [RESOLVE]
          </button>
        )}
      </div>
    </div>
  );
};
