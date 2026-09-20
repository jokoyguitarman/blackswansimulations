/**
 * Scenario library data — kept out of lib/api.ts on purpose (another agent has that file in
 * flight). Same auth + base-URL conventions as api.ts.
 */
import { supabase } from './supabase';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

const url = (path: string) => {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return API_BASE_URL ? `${API_BASE_URL.replace(/\/$/, '')}${clean}` : clean;
};

const headers = async () => {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');
  return { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' };
};

export interface ScenarioSummaryOrg {
  org_key: string;
  name: string;
  country: string | null;
  side: 'protagonist' | 'antagonist' | 'pressure';
  operation?: 'players' | 'ai';
  is_primary?: boolean;
  kind?: string;
}

export interface ScenarioSummary {
  teams: number;
  injects: number;
  contacts: number;
  crowd: number;
  orgs: ScenarioSummaryOrg[];
  live_session_id: string | null;
  live_session_started_at: string | null;
  sessions_run: number;
  last_session_at: string | null;
}

export interface LibraryScenario {
  id: string;
  title: string;
  description: string;
  category: string;
  difficulty: string;
  duration_minutes: number;
  objectives: string[];
  is_active: boolean;
  created_at: string;
  country?: string | null;
  initial_state?: Record<string, unknown> | null;
  summary?: ScenarioSummary;
}

export async function listScenariosWithSummary(): Promise<LibraryScenario[]> {
  const res = await fetch(url('/api/scenarios?include=summary'), { headers: await headers() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const json = (await res.json()) as { data: LibraryScenario[] };
  return json.data ?? [];
}

export async function getSessionCredits(): Promise<number | null> {
  try {
    const res = await fetch(url('/api/billing/credits'), { headers: await headers() });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { session?: number } };
    return typeof json.data?.session === 'number' ? json.data.session : null;
  } catch {
    return null;
  }
}

/** POST /api/scenarios/:id/clone — copies the scenario with its template injects. */
export async function cloneScenario(id: string, title?: string): Promise<{ id: string } | null> {
  const res = await fetch(url(`/api/scenarios/${id}/clone`), {
    method: 'POST',
    headers: await headers(),
    body: JSON.stringify(title ? { title } : {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const json = (await res.json()) as { data?: { id?: string } };
  return json.data?.id ? { id: json.data.id } : null;
}

export interface PeekInject {
  id: string;
  title: string;
  type: string;
  trigger_time_minutes: number | null;
  trigger_condition: string | null;
  delivery_config: Record<string, unknown> | null;
  target_teams?: string[] | null;
}

export async function getScenarioInjectsPeek(id: string): Promise<PeekInject[]> {
  const res = await fetch(url(`/api/scenarios/${id}/injects`), { headers: await headers() });
  if (!res.ok) return [];
  const json = (await res.json()) as { data: PeekInject[] };
  return json.data ?? [];
}

export interface PeekTeam {
  id: string;
  team_name: string;
  team_description?: string | null;
  org_key?: string | null;
  function_key?: string | null;
  charter?: Record<string, unknown> | null;
}

export async function getScenarioTeamsPeek(id: string): Promise<PeekTeam[]> {
  const res = await fetch(url(`/api/scenarios/${id}/teams`), { headers: await headers() });
  if (!res.ok) return [];
  const json = (await res.json()) as { data: PeekTeam[] };
  return json.data ?? [];
}
