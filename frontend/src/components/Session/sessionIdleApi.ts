import { supabase } from '../../lib/supabase';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

function apiUrl(path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (API_BASE_URL) return `${API_BASE_URL.replace(/\/$/, '')}${cleanPath}`;
  return cleanPath;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session?.access_token || ''}`,
  };
}

/** POST /api/sessions/:id/keepalive. Resolves when the server accepts the press. */
export async function sendKeepalive(sessionId: string): Promise<void> {
  const headers = await getAuthHeaders();
  const response = await fetch(apiUrl(`/api/sessions/${sessionId}/keepalive`), {
    method: 'POST',
    headers,
  });
  if (!response.ok) {
    throw new Error(`keepalive failed: ${response.status}`);
  }
}
