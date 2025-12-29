import { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useRealtime } from '../../hooks/useRealtime';
import { supabase } from '../../lib/supabase';
import { CreateIncidentForm } from '../Forms/CreateIncidentForm';
import { IncidentCard } from './IncidentCard';
import { AssignIncidentModal } from './AssignIncidentModal';

/**
 * Incidents Panel Component - Client-side only
 * Separation of concerns: UI for displaying and managing incidents
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

interface IncidentsPanelProps {
  sessionId: string;
  selectedIncidentId?: string | null;
  onIncidentSelect?: (incidentId: string | null) => void;
}

export const IncidentsPanel = ({
  sessionId,
  selectedIncidentId,
  onIncidentSelect,
}: IncidentsPanelProps) => {
  // const { user } = useAuth(); // Unused - keeping for potential future use
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedIncident, setSelectedIncident] = useState<Incident | null>(null);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterSeverity, setFilterSeverity] = useState<string>('all');

  // Initial load
  useEffect(() => {
    loadIncidents();
  }, [sessionId]);

  // Supabase Realtime subscription for instant incident updates
  useRealtime<{
    id: string;
    session_id: string;
    title: string;
    description: string;
    type: string;
    severity: string;
    status: string;
    location_lat: number | null;
    location_lng: number | null;
    casualty_count: number | null;
    reported_by: string;
    assigned_to: string | null;
    inject_id: string | null;
    reported_at: string;
    updated_at: string;
  }>({
    table: 'incidents',
    filter: sessionId ? `session_id=eq.${sessionId}` : undefined,
    onInsert: async (payload) => {
      // Fetch related data (reported_by, assigned_to_user, assignments)
      try {
        const [reportedByResult, assignedToResult, assignmentsResult] = await Promise.all([
          payload.reported_by
            ? supabase
                .from('user_profiles')
                .select('id, full_name, role')
                .eq('id', payload.reported_by)
                .single()
            : Promise.resolve({ data: null }),
          payload.assigned_to
            ? supabase
                .from('user_profiles')
                .select('id, full_name, role')
                .eq('id', payload.assigned_to)
                .single()
            : Promise.resolve({ data: null }),
          supabase
            .from('incident_assignments')
            .select(
              'assignment_type, user_id, agency_role, assigned_at, notes, assigned_user:user_profiles!incident_assignments_user_id_fkey(id, full_name)',
            )
            .eq('incident_id', payload.id)
            .is('unassigned_at', null),
        ]);

        const incident: Incident = {
          id: payload.id,
          title: payload.title,
          description: payload.description,
          type: payload.type,
          severity: payload.severity,
          status: payload.status,
          location_lat: payload.location_lat,
          location_lng: payload.location_lng,
          casualty_count: payload.casualty_count || undefined,
          reported_at: payload.reported_at,
          updated_at: payload.updated_at,
          reported_by: reportedByResult.data
            ? {
                id: reportedByResult.data.id,
                full_name: reportedByResult.data.full_name,
                role: reportedByResult.data.role,
              }
            : undefined,
          assigned_to_user: assignedToResult.data
            ? {
                id: assignedToResult.data.id,
                full_name: assignedToResult.data.full_name,
                role: assignedToResult.data.role,
              }
            : undefined,
          assignments: assignmentsResult.data?.map((a: any) => ({
            assignment_type: a.assignment_type,
            user_id: a.user_id,
            agency_role: a.agency_role,
            assigned_at: a.assigned_at,
            notes: a.notes,
            assigned_user: a.assigned_user
              ? {
                  id: a.assigned_user.id,
                  full_name: a.assigned_user.full_name,
                }
              : undefined,
          })),
        };

        // Add incident optimistically
        setIncidents((prev) => {
          const exists = prev.some((i) => i.id === incident.id);
          if (exists) return prev;
          return [...prev, incident];
        });
      } catch (error) {
        console.error('Failed to fetch related data for new incident:', error);
        // Still add the incident with basic data
        const incident: Incident = {
          id: payload.id,
          title: payload.title,
          description: payload.description,
          type: payload.type,
          severity: payload.severity,
          status: payload.status,
          location_lat: payload.location_lat,
          location_lng: payload.location_lng,
          casualty_count: payload.casualty_count || undefined,
          reported_at: payload.reported_at,
          updated_at: payload.updated_at,
        };
        setIncidents((prev) => {
          const exists = prev.some((i) => i.id === incident.id);
          if (exists) return prev;
          return [...prev, incident];
        });
      }
    },
    onUpdate: async (payload) => {
      // Update existing incident
      try {
        const [reportedByResult, assignedToResult, assignmentsResult] = await Promise.all([
          payload.reported_by
            ? supabase
                .from('user_profiles')
                .select('id, full_name, role')
                .eq('id', payload.reported_by)
                .single()
            : Promise.resolve({ data: null }),
          payload.assigned_to
            ? supabase
                .from('user_profiles')
                .select('id, full_name, role')
                .eq('id', payload.assigned_to)
                .single()
            : Promise.resolve({ data: null }),
          supabase
            .from('incident_assignments')
            .select(
              'assignment_type, user_id, agency_role, assigned_at, notes, assigned_user:user_profiles!incident_assignments_user_id_fkey(id, full_name)',
            )
            .eq('incident_id', payload.id)
            .is('unassigned_at', null),
        ]);

        const updatedIncident: Incident = {
          id: payload.id,
          title: payload.title,
          description: payload.description,
          type: payload.type,
          severity: payload.severity,
          status: payload.status,
          location_lat: payload.location_lat,
          location_lng: payload.location_lng,
          casualty_count: payload.casualty_count || undefined,
          reported_at: payload.reported_at,
          updated_at: payload.updated_at,
          reported_by: reportedByResult.data
            ? {
                id: reportedByResult.data.id,
                full_name: reportedByResult.data.full_name,
                role: reportedByResult.data.role,
              }
            : undefined,
          assigned_to_user: assignedToResult.data
            ? {
                id: assignedToResult.data.id,
                full_name: assignedToResult.data.full_name,
                role: assignedToResult.data.role,
              }
            : undefined,
          assignments: assignmentsResult.data?.map((a: any) => ({
            assignment_type: a.assignment_type,
            user_id: a.user_id,
            agency_role: a.agency_role,
            assigned_at: a.assigned_at,
            notes: a.notes,
            assigned_user: a.assigned_user
              ? {
                  id: a.assigned_user.id,
                  full_name: a.assigned_user.full_name,
                }
              : undefined,
          })),
        };

        setIncidents((prev) =>
          prev.map((incident) => (incident.id === updatedIncident.id ? updatedIncident : incident)),
        );
      } catch (error) {
        console.error('Failed to fetch related data for updated incident:', error);
        // Still update with basic data
        const updatedIncident: Incident = {
          id: payload.id,
          title: payload.title,
          description: payload.description,
          type: payload.type,
          severity: payload.severity,
          status: payload.status,
          location_lat: payload.location_lat,
          location_lng: payload.location_lng,
          casualty_count: payload.casualty_count || undefined,
          reported_at: payload.reported_at,
          updated_at: payload.updated_at,
        };
        setIncidents((prev) =>
          prev.map((incident) => (incident.id === updatedIncident.id ? updatedIncident : incident)),
        );
      }
    },
    enabled: !!sessionId,
  });

  // Subscribe to incident_assignments for assignment changes
  // Note: We subscribe without filter and check incident_id in handler since Realtime doesn't support subqueries
  useRealtime<{
    id: string;
    incident_id: string;
    assignment_type: string;
    agency_role: string | null;
    assigned_at: string;
    notes: string | null;
    unassigned_at: string | null;
  }>({
    table: 'incident_assignments',
    onInsert: async (payload) => {
      // Check if this assignment is for an incident in our session
      const incident = incidents.find((i) => i.id === payload.incident_id);
      if (!incident) {
        // Incident not in our list, might be from another session - skip
        return;
      }

      // Update incident's assignments
      if (payload.unassigned_at) return; // Skip if already unassigned

      setIncidents((prev) =>
        prev.map((incident) => {
          if (incident.id === payload.incident_id) {
            const newAssignment = {
              agency_role: payload.agency_role || '',
              assigned_at: payload.assigned_at,
              notes: payload.notes || undefined,
            } as Incident['assignments'] extends (infer U)[] ? U : never;
            return {
              ...incident,
              assignments: [...(incident.assignments || []), newAssignment],
            };
          }
          return incident;
        }),
      );
    },
    onUpdate: async (payload) => {
      // Check if this assignment is for an incident in our session
      const incident = incidents.find((i) => i.id === payload.incident_id);
      if (!incident) {
        return;
      }

      // Reload assignments for the incident
      try {
        const { data: assignments } = await supabase
          .from('incident_assignments')
          .select(
            'assignment_type, user_id, agency_role, assigned_at, notes, assigned_user:user_profiles!incident_assignments_user_id_fkey(id, full_name)',
          )
          .eq('incident_id', payload.incident_id)
          .is('unassigned_at', null);

        setIncidents((prev) =>
          prev.map((incident) => {
            if (incident.id === payload.incident_id) {
              return {
                ...incident,
                assignments: assignments?.map((a: any) => ({
                  assignment_type: a.assignment_type as string | undefined,
                  user_id: a.user_id as string | undefined,
                  agency_role: a.agency_role as string | undefined,
                  assigned_at: a.assigned_at as string,
                  notes: (a.notes || undefined) as string | undefined,
                  assigned_user: a.assigned_user
                    ? {
                        id: a.assigned_user.id,
                        full_name: a.assigned_user.full_name,
                      }
                    : undefined,
                })) as Incident['assignments'],
              };
            }
            return incident;
          }),
        );
      } catch (error) {
        console.error('Failed to reload assignments:', error);
      }
    },
    enabled: !!sessionId,
  });

  // Keep WebSocket as fallback
  useWebSocket({
    sessionId,
    eventTypes: ['incident.created', 'incident.updated'],
    onEvent: async () => {
      // Fallback: reload if Realtime didn't catch it
      await loadIncidents();
    },
    enabled: !!sessionId,
  });

  const loadIncidents = async () => {
    try {
      const result = await api.incidents.list(sessionId);
      setIncidents(result.data as Incident[]);
    } catch (error) {
      console.error('Failed to load incidents:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateSuccess = () => {
    setShowCreateModal(false);
    loadIncidents();
  };

  const handleAssign = (incident: Incident) => {
    setSelectedIncident(incident);
    setShowAssignModal(true);
  };

  const handleAssignSuccess = () => {
    setShowAssignModal(false);
    setSelectedIncident(null);
    loadIncidents();
  };

  // Filter incidents
  const filteredIncidents = incidents.filter((incident) => {
    if (filterStatus !== 'all' && incident.status !== filterStatus) return false;
    if (filterSeverity !== 'all' && incident.severity !== filterSeverity) return false;
    return true;
  });

  if (loading) {
    return (
      <div className="military-border p-6">
        <div className="text-center">
          <div className="text-sm terminal-text text-robotic-yellow/50 animate-pulse">
            [LOADING_INCIDENTS]
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="military-border p-4 flex justify-between items-center">
        <h3 className="text-lg terminal-text uppercase">[INCIDENTS] Active Incidents</h3>
        <button
          onClick={() => setShowCreateModal(true)}
          className="military-button px-4 py-2 text-sm"
        >
          [CREATE_INCIDENT]
        </button>
      </div>

      {/* Filters */}
      <div className="military-border p-4 flex gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-xs terminal-text text-robotic-yellow/70 uppercase">[STATUS]</label>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="military-input terminal-text text-sm px-3 py-1"
          >
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="under_control">Under Control</option>
            <option value="contained">Contained</option>
            <option value="resolved">Resolved</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs terminal-text text-robotic-yellow/70 uppercase">
            [SEVERITY]
          </label>
          <select
            value={filterSeverity}
            onChange={(e) => setFilterSeverity(e.target.value)}
            className="military-input terminal-text text-sm px-3 py-1"
          >
            <option value="all">All</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </div>
      </div>

      {/* Incidents List */}
      <div className="space-y-3">
        {filteredIncidents.map((incident) => (
          <IncidentCard
            key={incident.id}
            incident={incident}
            onAssign={() => handleAssign(incident)}
            onUpdate={loadIncidents}
            isSelected={selectedIncidentId === incident.id}
            onSelect={() => onIncidentSelect?.(incident.id)}
          />
        ))}
        {filteredIncidents.length === 0 && (
          <div className="military-border p-8 text-center">
            <p className="text-sm terminal-text text-robotic-yellow/50">
              {incidents.length === 0
                ? '[NO_INCIDENTS] No incidents reported yet'
                : '[NO_MATCHES] No incidents match the selected filters'}
            </p>
          </div>
        )}
      </div>

      {/* Create Incident Modal */}
      {showCreateModal && (
        <CreateIncidentForm
          sessionId={sessionId}
          onClose={() => setShowCreateModal(false)}
          onSuccess={handleCreateSuccess}
        />
      )}

      {/* Assign Incident Modal */}
      {showAssignModal && selectedIncident && (
        <AssignIncidentModal
          incident={selectedIncident}
          sessionId={sessionId}
          onClose={() => {
            setShowAssignModal(false);
            setSelectedIncident(null);
          }}
          onSuccess={handleAssignSuccess}
        />
      )}
    </div>
  );
};
