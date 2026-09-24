/**
 * Dashboard tile counts — kept out of lib/api.ts on purpose (another agent has that file in
 * flight). Same auth + base-URL conventions as api.ts.
 */
import { supabase } from './supabase';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

const url = (path: string) => {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return API_BASE_URL ? `${API_BASE_URL.replace(/\/$/, '')}${clean}` : clean;
};

export interface DashboardStats {
  scenarios: number;
  activeSessions: number;
  totalSessions: number;
  participants: number;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');
  const res = await fetch(url('/api/dashboard/stats'), {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const json = (await res.json()) as { data: DashboardStats };
  return json.data;
}
