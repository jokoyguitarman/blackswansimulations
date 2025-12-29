import { supabase } from './supabase';

/**
 * API Client - Centralized API calls with authentication
 * Separation of concerns: All API logic in one place
 */

const getAuthHeaders = async () => {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    throw new Error('Not authenticated');
  }
  return {
    Authorization: `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
  };
};

const handleResponse = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));

    // Log full error for debugging
    console.error('API Error Response:', {
      status: response.status,
      statusText: response.statusText,
      error: error,
    });

    // Provide user-friendly messages for common HTTP errors
    let errorMessage = error.error || `HTTP ${response.status}`;

    // Include details if available
    if (error.details) {
      errorMessage += `: ${error.details}`;
    }

    if (response.status === 429) {
      errorMessage = error.error || 'Rate limit exceeded. Please wait a moment and try again.';
    } else if (response.status === 401) {
      errorMessage = error.error || 'Authentication failed. Please log in again.';
    } else if (response.status === 403) {
      errorMessage = error.error || 'You do not have permission to perform this action.';
    } else if (response.status === 500) {
      errorMessage = error.error || 'Server error. Please try again later.';
      if (error.details) {
        errorMessage = `${error.error || 'Server error'}: ${error.details}`;
      }
    }

    throw new Error(errorMessage);
  }
  return response.json();
};

export const api = {
  // Scenarios
  scenarios: {
    list: async () => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown[] }>(await fetch('/api/scenarios', { headers }));
    },
    get: async (id: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(await fetch(`/api/scenarios/${id}`, { headers }));
    },
    create: async (data: unknown) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch('/api/scenarios', {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
    update: async (id: string, data: unknown) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(`/api/scenarios/${id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
    delete: async (id: string) => {
      const headers = await getAuthHeaders();
      return handleResponse(await fetch(`/api/scenarios/${id}`, { method: 'DELETE', headers }));
    },
  },

  // Sessions
  sessions: {
    list: async (page = 1, limit = 20) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown[]; count: number; page: number; limit: number }>(
        await fetch(`/api/sessions?page=${page}&limit=${limit}`, { headers }),
      );
    },
    get: async (id: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(await fetch(`/api/sessions/${id}`, { headers }));
    },
    create: async (data: unknown) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch('/api/sessions', {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
    update: async (id: string, data: unknown) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(`/api/sessions/${id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
    join: async (id: string, role: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(`/api/sessions/${id}/join`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ role }),
        }),
      );
    },
    addParticipant: async (sessionId: string, userId: string, role: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(`/api/sessions/${sessionId}/participants`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ user_id: userId, role }),
        }),
      );
    },
    removeParticipant: async (sessionId: string, userId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ success: boolean }>(
        await fetch(`/api/sessions/${sessionId}/participants/${userId}`, {
          method: 'DELETE',
          headers,
        }),
      );
    },
    getAvailableUsers: async () => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown[] }>(
        await fetch('/api/sessions/users/available', { headers }),
      );
    },
    markReady: async (sessionId: string, isReady: boolean) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(`/api/sessions/${sessionId}/ready`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ is_ready: isReady }),
        }),
      );
    },
    getReadyStatus: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: { total: number; ready: number; all_ready: boolean; participants: unknown[] };
      }>(await fetch(`/api/sessions/${sessionId}/ready-status`, { headers }));
    },
    inviteByEmail: async (sessionId: string, email: string, role: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown; isNewUser: boolean }>(
        await fetch(`/api/sessions/${sessionId}/invite`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ email, role }),
        }),
      );
    },
    processInvitations: async () => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: { processed: number; totalInvitations: number; participants: unknown[] };
      }>(
        await fetch('/api/sessions/process-invitations', {
          method: 'POST',
          headers,
        }),
      );
    },
    processAllInvitations: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: { processed: number; totalInvitations: number; participants: unknown[] };
      }>(
        await fetch(`/api/sessions/${sessionId}/process-all-invitations`, {
          method: 'POST',
          headers,
        }),
      );
    },
  },

  // Briefing
  briefing: {
    get: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: {
          general_briefing: string;
          role_specific_briefing: string | null;
          scenario_title: string;
          user_role: string | null;
        };
      }>(await fetch(`/api/briefing/session/${sessionId}`, { headers }));
    },
  },

  // Channels & Messages
  channels: {
    list: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown[] }>(
        await fetch(`/api/channels/session/${sessionId}`, { headers }),
      );
    },
    getDMs: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Array<{
          id: string;
          recipient: { id: string; full_name: string; role: string } | null;
          last_message: { content: string; created_at: string } | null;
        }>;
      }>(await fetch(`/api/channels/session/${sessionId}/dms`, { headers }));
    },
    getParticipants: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Array<{ id: string; full_name: string; role: string; agency_name?: string }>;
      }>(await fetch(`/api/channels/session/${sessionId}/participants`, { headers }));
    },
    createDM: async (sessionId: string, recipientId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: { id: string; recipient: { id: string; full_name: string; role: string } | null };
      }>(
        await fetch(`/api/channels/session/${sessionId}/dm`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ recipient_id: recipientId }),
        }),
      );
    },
    getMessages: async (channelId: string, page = 1, limit = 50) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown[]; count: number }>(
        await fetch(`/api/channels/${channelId}/messages?page=${page}&limit=${limit}`, { headers }),
      );
    },
    create: async (data: unknown) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch('/api/channels', {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
    sendMessage: async (channelId: string, content: string, messageType = 'text') => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(`/api/channels/${channelId}/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ content, message_type: messageType }),
        }),
      );
    },
  },

  // Decisions
  decisions: {
    list: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown[] }>(
        await fetch(`/api/decisions/session/${sessionId}`, { headers }),
      );
    },
    getAvailableParticipants: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Array<{
          id: string;
          name: string;
          role: string;
        }>;
      }>(await fetch(`/api/decisions/session/${sessionId}/available-participants`, { headers }));
    },
    create: async (data: unknown) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch('/api/decisions', {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
    approve: async (id: string, approved: boolean, comment?: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ success: boolean }>(
        await fetch(`/api/decisions/${id}/approve`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ approved, comment }),
        }),
      );
    },
    execute: async (id: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(`/api/decisions/${id}/execute`, {
          method: 'POST',
          headers,
        }),
      );
    },
  },

  // Incidents
  incidents: {
    list: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown[] }>(
        await fetch(`/api/incidents/session/${sessionId}`, { headers }),
      );
    },
    get: async (id: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(await fetch(`/api/incidents/${id}`, { headers }));
    },
    create: async (data: unknown) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch('/api/incidents', {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
    update: async (id: string, data: unknown) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(`/api/incidents/${id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
    assign: async (id: string, userId: string, notes?: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(`/api/incidents/${id}/assign`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            user_id: userId,
            notes,
          }),
        }),
      );
    },
    getAvailableTeams: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: Array<{ team_name: string }> }>(
        await fetch(`/api/incidents/session/${sessionId}/teams`, { headers }),
      );
    },
    getParticipants: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Array<{
          id: string;
          name: string;
          role: string;
        }>;
      }>(await fetch(`/api/incidents/session/${sessionId}/participants`, { headers }));
    },
    allocateResources: async (id: string, resources: Record<string, number>) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ success: boolean; message: string }>(
        await fetch(`/api/incidents/${id}/resources`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ resources }),
        }),
      );
    },
  },

  // Resources
  resources: {
    get: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: { resources: unknown[]; requests: unknown[] } }>(
        await fetch(`/api/resources/session/${sessionId}`, { headers }),
      );
    },
    request: async (data: unknown) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch('/api/resources/request', {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
    updateRequest: async (id: string, data: unknown) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(`/api/resources/request/${id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
  },

  // Injects
  injects: {
    list: async (scenarioId?: string, sessionId?: string) => {
      const headers = await getAuthHeaders();
      const params = new URLSearchParams();
      if (scenarioId) params.append('scenario_id', scenarioId);
      if (sessionId) params.append('session_id', sessionId);
      return handleResponse<{ data: unknown[] }>(
        await fetch(`/api/injects?${params.toString()}`, { headers }),
      );
    },
    create: async (data: unknown) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch('/api/injects', {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
    publish: async (id: string, sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ success: boolean; message: string }>(
        await fetch(`/api/injects/${id}/publish`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ session_id: sessionId }),
        }),
      );
    },
  },

  // Events
  events: {
    list: async (sessionId: string, page = 1, limit = 50) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown[]; count: number }>(
        await fetch(`/api/events/session/${sessionId}?page=${page}&limit=${limit}`, { headers }),
      );
    },
  },

  // Media
  media: {
    list: async (sessionId: string, page = 1, limit = 20) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown[]; count: number }>(
        await fetch(`/api/media/session/${sessionId}?page=${page}&limit=${limit}`, { headers }),
      );
    },
    getSentiment: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown[] }>(
        await fetch(`/api/media/sentiment/session/${sessionId}`, { headers }),
      );
    },
    create: async (data: unknown) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch('/api/media', {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
  },

  // AAR
  aar: {
    get: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(`/api/aar/session/${sessionId}`, { headers }),
      );
    },
    generate: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(`/api/aar/session/${sessionId}/generate`, {
          method: 'POST',
          headers,
        }),
      );
    },
    export: async (sessionId: string, format: 'pdf' | 'excel') => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: { url: string; fileName: string; format: string } }>(
        await fetch(`/api/aar/session/${sessionId}/export?format=${format}`, {
          method: 'POST',
          headers,
        }),
      );
    },
  },

  // Objectives
  objectives: {
    getProgress: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Array<{
          id: string;
          session_id: string;
          objective_id: string;
          objective_name: string;
          progress_percentage: number;
          status: 'not_started' | 'in_progress' | 'completed' | 'failed';
          score: number | null;
          metrics: Record<string, unknown>;
          weight: number;
        }>;
      }>(await fetch(`/api/objectives/session/${sessionId}`, { headers }));
    },
    getScore: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: {
          overall_score: number;
          objective_scores: Array<{
            objective_id: string;
            objective_name: string;
            score: number;
            weight: number;
            status: string;
          }>;
          success_level: 'Excellent' | 'Good' | 'Adequate' | 'Needs Improvement';
        };
      }>(await fetch(`/api/objectives/session/${sessionId}/score`, { headers }));
    },
  },

  // Teams
  teams: {
    getSessionTeams: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Array<{
          id: string;
          user_id: string;
          team_name: string;
          team_role?: string;
          user?: { id: string; full_name: string; role: string };
        }>;
      }>(await fetch(`/api/teams/session/${sessionId}`, { headers }));
    },
    assignTeam: async (sessionId: string, userId: string, teamName: string, teamRole?: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: { id: string; user_id: string; team_name: string; team_role?: string };
      }>(
        await fetch(`/api/teams/session/${sessionId}/assign`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ user_id: userId, team_name: teamName, team_role: teamRole }),
        }),
      );
    },
    removeTeamAssignment: async (sessionId: string, userId: string, teamName: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ success: boolean; message: string }>(
        await fetch(`/api/teams/session/${sessionId}/assign`, {
          method: 'DELETE',
          headers,
          body: JSON.stringify({ user_id: userId, team_name: teamName }),
        }),
      );
    },
    getScenarioTeams: async (scenarioId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Array<{
          id: string;
          team_name: string;
          team_description?: string;
          required_roles?: string[];
        }>;
      }>(await fetch(`/api/teams/scenario/${scenarioId}`, { headers }));
    },
    createScenarioTeam: async (
      scenarioId: string,
      teamName: string,
      teamDescription?: string,
      requiredRoles?: string[],
      minParticipants?: number,
      maxParticipants?: number,
    ) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: { id: string; team_name: string } }>(
        await fetch(`/api/teams/scenario/${scenarioId}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            team_name: teamName,
            team_description: teamDescription,
            required_roles: requiredRoles,
            min_participants: minParticipants,
            max_participants: maxParticipants,
          }),
        }),
      );
    },
  },

  // AI
  ai: {
    generateScenario: async (data: unknown) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch('/api/ai/scenarios/generate', {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
  },

  // Notifications
  notifications: {
    list: async (sessionId?: string, read?: boolean, limit = 50) => {
      const headers = await getAuthHeaders();
      const params = new URLSearchParams();
      if (sessionId) params.append('session_id', sessionId);
      if (read !== undefined) params.append('read', String(read));
      params.append('limit', String(limit));
      return handleResponse<{
        data: Array<{
          id: string;
          session_id: string;
          user_id: string;
          type: string;
          title: string;
          message: string;
          priority: 'low' | 'medium' | 'high' | 'critical';
          read: boolean;
          read_at: string | null;
          metadata: Record<string, unknown>;
          action_url: string | null;
          created_at: string;
        }>;
      }>(await fetch(`/api/notifications?${params.toString()}`, { headers }));
    },
    getUnreadCount: async (sessionId?: string) => {
      const headers = await getAuthHeaders();
      const params = sessionId ? `?session_id=${sessionId}` : '';
      return handleResponse<{ count: number }>(
        await fetch(`/api/notifications/unread/count${params}`, { headers }),
      );
    },
    markAsRead: async (notificationId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ success: boolean }>(
        await fetch(`/api/notifications/${notificationId}/read`, {
          method: 'POST',
          headers,
        }),
      );
    },
    markAllAsRead: async (sessionId?: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ success: boolean }>(
        await fetch('/api/notifications/read-all', {
          method: 'POST',
          headers,
          body: JSON.stringify({ session_id: sessionId }),
        }),
      );
    },
  },
};
