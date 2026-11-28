import { getAuthHeaders } from './api';
import { buildViewAsRoster, type ViewAsPlayer } from './viewAsRoster';

const API_BASE = import.meta.env?.VITE_API_URL || '';

function apiUrl(path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return API_BASE ? `${API_BASE.replace(/\/$/, '')}${clean}` : clean;
}

export interface StaffViewPayload {
  players: ViewAsPlayer[];
  viewedBy: string[];
}

/**
 * Probe GET /sessions/:id/staff-view. Null when the flag is off (404) or the
 * caller cannot spectate. Does not send view-as headers.
 */
export async function loadStaffView(sessionId: string): Promise<StaffViewPayload | null> {
  const headers = await getAuthHeaders();
  const probe = await fetch(apiUrl(`/api/sessions/${sessionId}/staff-view`), { headers });
  if (probe.status !== 200) return null;
  const body: unknown = await probe.json();
  const [teamsRes, pagesRes] = await Promise.all([
    fetch(apiUrl(`/api/teams/session/${sessionId}`), { headers }),
    fetch(apiUrl(`/api/social/pages/session/${sessionId}`), { headers }),
  ]);
  const teams = teamsRes.ok ? await teamsRes.json() : null;
  const pages = pagesRes.ok ? await pagesRes.json() : null;
  const viewedBy = readViewedBy(body);
  return {
    players: buildViewAsRoster({ players: body, teams, pages }),
    viewedBy,
  };
}

function readViewedBy(body: unknown): string[] {
  if (!body || typeof body !== 'object' || !('data' in body)) return [];
  const data = (body as { data: unknown }).data;
  if (!data || typeof data !== 'object' || !('viewed_by' in data)) return [];
  const names = (data as { viewed_by: unknown }).viewed_by;
  if (!Array.isArray(names)) return [];
  return names.filter((name): name is string => typeof name === 'string' && name.trim() !== '');
}
