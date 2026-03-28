import { supabase } from './supabase';

/**
 * API Client - Centralized API calls with authentication
 * Separation of concerns: All API logic in one place
 */

// Get API base URL from environment variable
const API_BASE_URL = import.meta.env.VITE_API_URL || '';

// Helper function to build API URLs
const apiUrl = (path: string) => {
  // Remove leading slash if present, then add it back
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (API_BASE_URL) {
    // If API_BASE_URL is set, use it (remove trailing slash if present)
    const base = API_BASE_URL.replace(/\/$/, '');
    return `${base}${cleanPath}`;
  }
  // Otherwise use relative path (for local development with proxy)
  return cleanPath;
};

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
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return {} as T;
  }
  return response.json();
};

export const api = {
  // Scenarios
  scenarios: {
    list: async () => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown[] }>(
        await fetch(apiUrl('/api/scenarios'), { headers }),
      );
    },
    get: async (id: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(apiUrl(`/api/scenarios/${id}`), { headers }),
      );
    },
    create: async (data: unknown) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(apiUrl('/api/scenarios'), {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
    update: async (id: string, data: unknown) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(apiUrl(`/api/scenarios/${id}`), {
          method: 'PATCH',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
    delete: async (id: string) => {
      const headers = await getAuthHeaders();
      return handleResponse(
        await fetch(apiUrl(`/api/scenarios/${id}`), { method: 'DELETE', headers }),
      );
    },
    /** Generate vicinity and layout map images, upload to storage, update scenario URLs. */
    generateMaps: async (id: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(apiUrl(`/api/scenarios/${id}/generate-maps`), {
          method: 'POST',
          headers,
        }),
      );
    },
    /** Get condition_keys and keyword_patterns for scenario (for TrainerEnvironmentalTruths). */
    getConditionConfig: async (id: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: {
          condition_keys: Array<{ key: string; meaning: string; team?: string }>;
          keyword_patterns: Array<{ category: string; keywords: string[]; state_key?: string }>;
          scenario_type?: string;
        };
      }>(await fetch(apiUrl(`/api/scenarios/${id}/condition-config`), { headers }));
    },
    /** Get all injects for a scenario (trainer only). */
    getInjects: async (id: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Array<{
          id: string;
          scenario_id: string;
          trigger_time_minutes: number | null;
          trigger_condition: string | null;
          type: string;
          title: string;
          content: string;
          severity: string;
          inject_scope: string;
          target_teams: string[] | null;
          requires_response: boolean;
          conditions_to_appear: unknown;
          conditions_to_cancel: string[] | null;
          eligible_after_minutes: number | null;
          objective_penalty: unknown;
          state_effect: unknown;
          display_order: number | null;
        }>;
      }>(await fetch(apiUrl(`/api/scenarios/${id}/injects`), { headers }));
    },
    /** Get all teams for a scenario (trainer only). */
    getTeams: async (id: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Array<{
          id: string;
          scenario_id: string;
          team_name: string;
          team_description: string;
          min_participants: number;
          max_participants: number;
        }>;
      }>(await fetch(apiUrl(`/api/scenarios/${id}/teams`), { headers }));
    },
    /** Get all map pin locations for a scenario (trainer only). */
    getScenarioLocations: async (id: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Array<{
          id: string;
          scenario_id: string;
          location_type: string;
          label: string;
          coordinates: { lat?: number; lng?: number };
          conditions?: Record<string, unknown>;
          display_order: number;
        }>;
      }>(await fetch(apiUrl(`/api/scenarios/${id}/locations`), { headers }));
    },
    /** Get all environmental seeds for a scenario (trainer only). */
    getSeeds: async (id: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Array<{
          id: string;
          scenario_id: string;
          variant_label: string;
          seed_data: Record<string, unknown>;
          display_order: number;
        }>;
      }>(await fetch(apiUrl(`/api/scenarios/${id}/seeds`), { headers }));
    },
    getScenarioHazards: async (id: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Array<{
          id: string;
          scenario_id: string;
          hazard_type: string;
          location_lat: number;
          location_lng: number;
          floor_level: string;
          properties: Record<string, unknown>;
          status: string;
          enriched_description?: string;
          fire_class?: string;
          debris_type?: string;
          resolution_requirements?: Record<string, unknown>;
          personnel_requirements?: Record<string, unknown>;
          equipment_requirements?: unknown[];
          deterioration_timeline?: Record<string, unknown>;
          appears_at_minutes: number;
        }>;
      }>(await fetch(apiUrl(`/api/scenarios/${id}/hazards`), { headers }));
    },
    getScenarioCasualties: async (id: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Array<{
          id: string;
          scenario_id: string;
          casualty_type: string;
          location_lat: number;
          location_lng: number;
          floor_level: string;
          headcount: number;
          conditions: Record<string, unknown>;
          status: string;
          appears_at_minutes: number;
        }>;
      }>(await fetch(apiUrl(`/api/scenarios/${id}/casualties`), { headers }));
    },
    getScenarioEquipment: async (id: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Array<{
          id: string;
          scenario_id: string;
          equipment_type: string;
          label: string;
          icon?: string;
          properties: Record<string, unknown>;
        }>;
      }>(await fetch(apiUrl(`/api/scenarios/${id}/equipment`), { headers }));
    },
    getScenarioFloorPlans: async (id: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Array<{
          id: string;
          scenario_id: string;
          floor_level: string;
          floor_label: string;
          plan_svg: string | null;
          plan_image_url: string | null;
          bounds: Record<string, unknown> | null;
          features: Array<{
            id: string;
            type: string;
            label: string;
            geometry?: Record<string, unknown>;
            properties?: Record<string, unknown>;
          }>;
          environmental_factors: Array<Record<string, unknown>>;
        }>;
      }>(await fetch(apiUrl(`/api/scenarios/${id}/floor-plans`), { headers }));
    },
    updatePinPositions: async (
      id: string,
      payload: {
        locations?: Array<{ id: string; lat: number; lng: number }>;
        hazards?: Array<{ id: string; lat: number; lng: number }>;
        casualties?: Array<{ id: string; lat: number; lng: number }>;
      },
    ) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ ok: boolean; warnings?: string[] }>(
        await fetch(apiUrl(`/api/scenarios/${id}/pins`), {
          method: 'PATCH',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      );
    },
  },

  // Sessions
  sessions: {
    list: async (page = 1, limit = 20) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown[]; count: number; page: number; limit: number }>(
        await fetch(apiUrl(`/api/sessions?page=${page}&limit=${limit}`), { headers }),
      );
    },
    get: async (id: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(apiUrl(`/api/sessions/${id}`), { headers }),
      );
    },
    getLocations: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Array<{
          id: string;
          scenario_id: string;
          location_type: string;
          label: string;
          coordinates: { lat?: number; lng?: number };
          conditions?: Record<string, unknown>;
          display_order?: number;
        }>;
        /** Insider categories the user has asked about this session; only those POI pins are shown. */
        map_revealed_categories?: string[];
      }>(await fetch(apiUrl(`/api/sessions/${sessionId}/locations`), { headers }));
    },
    getBackendActivity: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        activities: Array<{
          type: string;
          at: string;
          title?: string;
          reason?: string;
          step?: string;
          injectId?: string;
          summary?: string;
          matrix?: Record<string, Record<string, number>>;
          robustness_by_decision?: Record<string, number>;
          response_taxonomy?: Record<string, string>;
          analysis?: {
            overall?: string;
            matrix_reasoning?: string;
            robustness_reasoning?: string;
            raw_robustness_by_decision?: Record<string, number>;
            robustness_cap_detail?: Record<
              string,
              {
                raw: number;
                capped: number;
                severity: string;
                mismatch_kind: string;
                reason?: string;
              }
            >;
          };
          computed_band?: 'low' | 'medium' | 'high';
          factors?: Array<{ id: string; name: string; description: string; severity: string }>;
          de_escalation_factors?: Array<{ id: string; name: string; description: string }>;
          pathways?: Array<{
            pathway_id: string;
            trajectory: string;
            trigger_behaviours: string[];
          }>;
          de_escalation_pathways?: Array<{
            pathway_id: string;
            trajectory: string;
            mitigating_behaviours: string[];
            emerging_challenges?: string[];
          }>;
        }>;
        decisions?: Array<{
          id: string;
          title: string;
          executed_at: string | null;
          environmental_consistency?: {
            consistent?: boolean;
            mismatch_kind?: string;
            severity?: string;
            reason?: string;
          } | null;
        }>;
        sessionId: string;
      }>(await fetch(apiUrl(`/api/sessions/${sessionId}/backend-activity`), { headers }));
    },
    insiderAsk: async (sessionId: string, body: { content: string; channel_id?: string }) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: { answer: string; category: string; sources_used: string[]; show_map?: boolean };
      }>(
        await fetch(apiUrl(`/api/sessions/${sessionId}/insider/ask`), {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }),
      );
    },
    insiderHistory: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Array<{
          id: string;
          question_text: string;
          answer_snippet: string | null;
          asked_at: string;
          category?: string;
        }>;
      }>(await fetch(apiUrl(`/api/sessions/${sessionId}/insider/history`), { headers }));
    },
    hospitalList: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Array<{ id: string; label: string }>;
      }>(await fetch(apiUrl(`/api/sessions/${sessionId}/hospital/list`), { headers }));
    },
    hospitalAsk: async (sessionId: string, body: { hospital_id: string; content: string }) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: { answer: string };
      }>(
        await fetch(apiUrl(`/api/sessions/${sessionId}/hospital/ask`), {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }),
      );
    },
    create: async (data: unknown) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(apiUrl('/api/sessions'), {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
    update: async (id: string, data: unknown) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(apiUrl(`/api/sessions/${id}`), {
          method: 'PATCH',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
    join: async (id: string, role: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(apiUrl(`/api/sessions/${id}/join`), {
          method: 'POST',
          headers,
          body: JSON.stringify({ role }),
        }),
      );
    },
    addParticipant: async (sessionId: string, userId: string, role: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(apiUrl(`/api/sessions/${sessionId}/participants`), {
          method: 'POST',
          headers,
          body: JSON.stringify({ user_id: userId, role }),
        }),
      );
    },
    removeParticipant: async (sessionId: string, userId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ success: boolean }>(
        await fetch(apiUrl(`/api/sessions/${sessionId}/participants/${userId}`), {
          method: 'DELETE',
          headers,
        }),
      );
    },
    getAvailableUsers: async () => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown[] }>(
        await fetch(apiUrl('/api/sessions/users/available'), { headers }),
      );
    },
    markReady: async (sessionId: string, isReady: boolean) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(apiUrl(`/api/sessions/${sessionId}/ready`), {
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
      }>(await fetch(apiUrl(`/api/sessions/${sessionId}/ready-status`), { headers }));
    },
    inviteByEmail: async (sessionId: string, email: string, role: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown; isNewUser: boolean }>(
        await fetch(apiUrl(`/api/sessions/${sessionId}/invite`), {
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
        await fetch(apiUrl('/api/sessions/process-invitations'), {
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
        await fetch(apiUrl(`/api/sessions/${sessionId}/process-all-invitations`), {
          method: 'POST',
          headers,
        }),
      );
    },
  },

  // Placements (drag-and-drop map assets)
  placements: {
    list: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Array<{
          id: string;
          session_id: string;
          team_name: string;
          placed_by: string;
          asset_type: string;
          label: string;
          geometry: Record<string, unknown>;
          properties: Record<string, unknown>;
          placement_score: Record<string, number> | null;
          status: string;
          linked_decision_id: string | null;
          placed_at: string;
          updated_at: string;
          removed_at: string | null;
        }>;
      }>(await fetch(apiUrl(`/api/sessions/${sessionId}/placements`), { headers }));
    },
    create: async (
      sessionId: string,
      data: {
        team_name: string;
        asset_type: string;
        label?: string;
        geometry: Record<string, unknown>;
        properties?: Record<string, unknown>;
      },
    ) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Record<string, unknown>;
        warnings: string[];
      }>(
        await fetch(apiUrl(`/api/sessions/${sessionId}/placements`), {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
    update: async (
      sessionId: string,
      placementId: string,
      data: {
        geometry?: Record<string, unknown>;
        properties?: Record<string, unknown>;
        label?: string;
        linked_decision_id?: string;
      },
    ) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: Record<string, unknown> }>(
        await fetch(apiUrl(`/api/sessions/${sessionId}/placements/${placementId}`), {
          method: 'PATCH',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
    remove: async (sessionId: string, placementId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: Record<string, unknown> }>(
        await fetch(apiUrl(`/api/sessions/${sessionId}/placements/${placementId}`), {
          method: 'DELETE',
          headers,
        }),
      );
    },
  },

  // Hazards (interactive hazard assessment)
  hazards: {
    list: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Array<{
          id: string;
          scenario_id: string;
          session_id: string | null;
          hazard_type: string;
          location_lat: number;
          location_lng: number;
          floor_level: string;
          properties: Record<string, unknown>;
          assessment_criteria: unknown[];
          image_url: string | null;
          image_sequence: Array<{
            at_minutes: number;
            image_url: string;
            description: string;
          }> | null;
          current_image_url: string | null;
          current_description: string | null;
          status: string;
          appears_at_minutes: number;
        }>;
        elapsed_minutes: number;
      }>(await fetch(apiUrl(`/api/sessions/${sessionId}/hazards`), { headers }));
    },
    get: async (sessionId: string, hazardId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Record<string, unknown>;
      }>(await fetch(apiUrl(`/api/sessions/${sessionId}/hazards/${hazardId}`), { headers }));
    },
  },

  casualties: {
    list: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Array<{
          id: string;
          scenario_id: string;
          session_id: string | null;
          casualty_type: string;
          location_lat: number;
          location_lng: number;
          floor_level: string;
          headcount: number;
          conditions: Record<string, unknown>;
          status: string;
          assigned_team: string | null;
          appears_at_minutes: number;
          updated_at: string;
        }>;
        elapsed_minutes: number;
      }>(await fetch(apiUrl(`/api/sessions/${sessionId}/casualties`), { headers }));
    },
    get: async (sessionId: string, casualtyId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Record<string, unknown>;
      }>(await fetch(apiUrl(`/api/sessions/${sessionId}/casualties/${casualtyId}`), { headers }));
    },
    update: async (
      sessionId: string,
      casualtyId: string,
      payload: {
        status?: string;
        assigned_team?: string;
        linked_decision_id?: string;
        location_lat?: number;
        location_lng?: number;
        conditions?: Record<string, unknown>;
      },
    ) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: Record<string, unknown> }>(
        await fetch(apiUrl(`/api/sessions/${sessionId}/casualties/${casualtyId}`), {
          method: 'PATCH',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      );
    },
    assess: async (
      sessionId: string,
      casualtyId: string,
      payload: { player_triage_color: string; team_name: string },
    ) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: Record<string, unknown> }>(
        await fetch(apiUrl(`/api/sessions/${sessionId}/casualties/${casualtyId}/assess`), {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      );
    },
  },

  marshalCheck: {
    check: async (sessionId: string, lat: number, lng: number) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: { has_marshal: boolean } }>(
        await fetch(apiUrl(`/api/sessions/${sessionId}/marshal-check?lat=${lat}&lng=${lng}`), {
          headers,
        }),
      );
    },
  },

  equipment: {
    list: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Array<{
          id: string;
          scenario_id: string;
          equipment_type: string;
          label: string;
          icon: string | null;
          properties: Record<string, unknown>;
        }>;
      }>(await fetch(apiUrl(`/api/sessions/${sessionId}/equipment`), { headers }));
    },
  },

  locations: {
    claim: async (sessionId: string, locationId: string, team_name: string, claimed_as: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: Record<string, unknown> }>(
        await fetch(apiUrl(`/api/sessions/${sessionId}/locations/${locationId}/claim`), {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ team_name, claimed_as }),
        }),
      );
    },
  },

  // Floor Plans (multi-floor maps)
  floorPlans: {
    list: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Array<{
          id: string;
          scenario_id: string;
          floor_level: string;
          floor_label: string;
          plan_svg: string | null;
          plan_image_url: string | null;
          bounds: Record<string, unknown> | null;
          features: Array<{
            id: string;
            type: string;
            label: string;
            geometry?: Record<string, unknown>;
            properties?: Record<string, unknown>;
          }>;
          environmental_factors: Array<Record<string, unknown>>;
        }>;
      }>(await fetch(apiUrl(`/api/sessions/${sessionId}/floor-plans`), { headers }));
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
          team_name?: string | null;
        };
      }>(await fetch(apiUrl(`/api/briefing/session/${sessionId}`), { headers }));
    },
  },

  // Channels & Messages
  channels: {
    list: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown[] }>(
        await fetch(apiUrl(`/api/channels/session/${sessionId}`), { headers }),
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
      }>(await fetch(apiUrl(`/api/channels/session/${sessionId}/dms`), { headers }));
    },
    getParticipants: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: Array<{
          id: string;
          full_name: string;
          role: string;
          agency_name?: string;
          team_name?: string;
        }>;
      }>(await fetch(apiUrl(`/api/channels/session/${sessionId}/participants`), { headers }));
    },
    createDM: async (sessionId: string, recipientId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: { id: string; recipient: { id: string; full_name: string; role: string } | null };
      }>(
        await fetch(apiUrl(`/api/channels/session/${sessionId}/dm`), {
          method: 'POST',
          headers,
          body: JSON.stringify({ recipient_id: recipientId }),
        }),
      );
    },
    getMessages: async (channelId: string, page = 1, limit = 50) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown[]; count: number }>(
        await fetch(apiUrl(`/api/channels/${channelId}/messages?page=${page}&limit=${limit}`), {
          headers,
        }),
      );
    },
    create: async (data: unknown) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(apiUrl('/api/channels'), {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
    sendMessage: async (channelId: string, content: string, messageType = 'text') => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(apiUrl(`/api/channels/${channelId}/messages`), {
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
        await fetch(apiUrl(`/api/decisions/session/${sessionId}`), { headers }),
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
      }>(
        await fetch(apiUrl(`/api/decisions/session/${sessionId}/available-participants`), {
          headers,
        }),
      );
    },
    create: async (data: unknown) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(apiUrl('/api/decisions'), {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
    approve: async (id: string, approved: boolean, comment?: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ success: boolean }>(
        await fetch(apiUrl(`/api/decisions/${id}/approve`), {
          method: 'POST',
          headers,
          body: JSON.stringify({ approved, comment }),
        }),
      );
    },
    execute: async (id: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(apiUrl(`/api/decisions/${id}/execute`), {
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
        await fetch(apiUrl(`/api/incidents/session/${sessionId}`), { headers }),
      );
    },
    get: async (id: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(apiUrl(`/api/incidents/${id}`), { headers }),
      );
    },
    create: async (data: unknown) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(apiUrl('/api/incidents'), {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
    update: async (id: string, data: unknown) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(apiUrl(`/api/incidents/${id}`), {
          method: 'PATCH',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
    assign: async (id: string, userId: string, notes?: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(apiUrl(`/api/incidents/${id}/assign`), {
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
        await fetch(apiUrl(`/api/incidents/session/${sessionId}/teams`), { headers }),
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
      }>(await fetch(apiUrl(`/api/incidents/session/${sessionId}/participants`), { headers }));
    },
    allocateResources: async (id: string, resources: Record<string, number>) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ success: boolean; message: string }>(
        await fetch(apiUrl(`/api/incidents/${id}/resources`), {
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
        await fetch(apiUrl(`/api/resources/session/${sessionId}`), { headers }),
      );
    },
    request: async (data: unknown) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(apiUrl('/api/resources/request'), {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
    updateRequest: async (id: string, data: unknown) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(apiUrl(`/api/resources/request/${id}`), {
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
        await fetch(apiUrl(`/api/injects?${params.toString()}`), { headers }),
      );
    },
    create: async (data: unknown) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(apiUrl('/api/injects'), {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
    publish: async (id: string, sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ success: boolean; message: string }>(
        await fetch(apiUrl(`/api/injects/${id}/publish`), {
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
        await fetch(apiUrl(`/api/events/session/${sessionId}?page=${page}&limit=${limit}`), {
          headers,
        }),
      );
    },
  },

  // Media
  media: {
    list: async (sessionId: string, page = 1, limit = 20) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown[]; count: number }>(
        await fetch(apiUrl(`/api/media/session/${sessionId}?page=${page}&limit=${limit}`), {
          headers,
        }),
      );
    },
    getSentiment: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown[] }>(
        await fetch(apiUrl(`/api/media/sentiment/session/${sessionId}`), { headers }),
      );
    },
    create: async (data: unknown) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(apiUrl('/api/media'), {
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
        await fetch(apiUrl(`/api/aar/session/${sessionId}`), { headers }),
      );
    },
    generate: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: unknown }>(
        await fetch(apiUrl(`/api/aar/session/${sessionId}/generate`), {
          method: 'POST',
          headers,
        }),
      );
    },
    export: async (sessionId: string, format: 'pdf' | 'excel') => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: { url: string; fileName: string; format: string } }>(
        await fetch(apiUrl(`/api/aar/session/${sessionId}/export?format=${format}`), {
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
      }>(await fetch(apiUrl(`/api/objectives/session/${sessionId}`), { headers }));
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
      }>(await fetch(apiUrl(`/api/objectives/session/${sessionId}/score`), { headers }));
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
      }>(await fetch(apiUrl(`/api/teams/session/${sessionId}`), { headers }));
    },
    assignTeam: async (sessionId: string, userId: string, teamName: string, teamRole?: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: { id: string; user_id: string; team_name: string; team_role?: string };
      }>(
        await fetch(apiUrl(`/api/teams/session/${sessionId}/assign`), {
          method: 'POST',
          headers,
          body: JSON.stringify({ user_id: userId, team_name: teamName, team_role: teamRole }),
        }),
      );
    },
    removeTeamAssignment: async (sessionId: string, userId: string, teamName: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ success: boolean; message: string }>(
        await fetch(apiUrl(`/api/teams/session/${sessionId}/assign`), {
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
      }>(await fetch(apiUrl(`/api/teams/scenario/${scenarioId}`), { headers }));
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
        await fetch(apiUrl(`/api/teams/scenario/${scenarioId}`), {
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
        await fetch(apiUrl('/api/ai/scenarios/generate'), {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
        }),
      );
    },
  },

  // War Room
  warroom: {
    suggestTeams: async (options: {
      prompt?: string;
      scenario_type?: string;
      setting?: string;
      terrain?: string;
      location?: string;
    }) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: {
          suggested_teams: Array<{
            team_name: string;
            team_description: string;
            min_participants?: number;
            max_participants?: number;
          }>;
          scenario_type?: string;
          setting?: string;
          terrain?: string;
          location?: string | null;
        };
      }>(
        await fetch(apiUrl('/api/warroom/suggest-teams'), {
          method: 'POST',
          headers,
          body: JSON.stringify(options),
        }),
      );
    },
    generate: async (options: {
      prompt?: string;
      scenario_type?: string;
      setting?: string;
      terrain?: string;
      location?: string;
      complexity_tier?: 'minimal' | 'standard' | 'full' | 'rich';
      duration_minutes?: number;
      teams?: Array<{
        team_name: string;
        team_description?: string;
        min_participants?: number;
        max_participants?: number;
      }>;
    }) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ data: { scenarioId: string } }>(
        await fetch(apiUrl('/api/warroom/generate'), {
          method: 'POST',
          headers,
          body: JSON.stringify(options),
        }),
      );
    },
    /** Stream progress events during generation. onProgress(phase, message) called for each step. */
    generateStream: async (
      options: {
        prompt?: string;
        scenario_type?: string;
        setting?: string;
        terrain?: string;
        location?: string;
        complexity_tier?: 'minimal' | 'standard' | 'full' | 'rich';
        duration_minutes?: number;
        teams?: Array<{
          team_name: string;
          team_description?: string;
          min_participants?: number;
          max_participants?: number;
        }>;
      },
      onProgress: (phase: string, message: string) => void,
    ): Promise<{ scenarioId: string }> => {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl('/api/warroom/generate-stream'), {
        method: 'POST',
        headers,
        body: JSON.stringify(options),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error('Streaming not supported');
      const decoder = new TextDecoder();
      let buffer = '';
      let result: { scenarioId: string } | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line) as {
              type: string;
              phase?: string;
              message?: string;
              data?: { scenarioId: string };
              error?: string;
            };
            if (obj.type === 'progress' && obj.phase && obj.message) {
              onProgress(obj.phase, obj.message);
            } else if (obj.type === 'done' && obj.data?.scenarioId) {
              result = { scenarioId: obj.data.scenarioId };
            } else if (obj.type === 'error') {
              throw new Error(obj.error || 'Generation failed');
            }
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }
      if (!result) throw new Error('No scenario ID returned');
      return result;
    },
  },

  // Join Link
  join: {
    getInfo: async (joinToken: string) => {
      // Public endpoint - no auth required
      return handleResponse<{
        data: {
          sessionTitle: string;
          teams: Array<{ id: string; team_name: string; team_description?: string }>;
        };
      }>(
        await fetch(apiUrl(`/api/join/${joinToken}`), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    },
    register: async (joinToken: string, displayName: string, teamName: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ sessionId: string }>(
        await fetch(apiUrl('/api/join/register'), {
          method: 'POST',
          headers,
          body: JSON.stringify({
            join_token: joinToken,
            display_name: displayName,
            team_name: teamName,
          }),
        }),
      );
    },
    regenerateToken: async (sessionId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: { join_token: string; join_enabled: boolean; join_expires_at: string };
      }>(
        await fetch(apiUrl(`/api/sessions/${sessionId}/regenerate-join-token`), {
          method: 'POST',
          headers,
        }),
      );
    },
    toggleEnabled: async (sessionId: string, joinEnabled: boolean) => {
      const headers = await getAuthHeaders();
      return handleResponse<{
        data: { join_token: string; join_enabled: boolean; join_expires_at: string };
      }>(
        await fetch(apiUrl(`/api/sessions/${sessionId}/join-link`), {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ join_enabled: joinEnabled }),
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
      }>(await fetch(apiUrl(`/api/notifications?${params.toString()}`), { headers }));
    },
    getUnreadCount: async (sessionId?: string) => {
      const headers = await getAuthHeaders();
      const params = sessionId ? `?session_id=${sessionId}` : '';
      return handleResponse<{ count: number }>(
        await fetch(apiUrl(`/api/notifications/unread/count${params}`), { headers }),
      );
    },
    markAsRead: async (notificationId: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ success: boolean }>(
        await fetch(apiUrl(`/api/notifications/${notificationId}/read`), {
          method: 'POST',
          headers,
        }),
      );
    },
    markAllAsRead: async (sessionId?: string) => {
      const headers = await getAuthHeaders();
      return handleResponse<{ success: boolean }>(
        await fetch(apiUrl('/api/notifications/read-all'), {
          method: 'POST',
          headers,
          body: JSON.stringify({ session_id: sessionId }),
        }),
      );
    },
  },
};
