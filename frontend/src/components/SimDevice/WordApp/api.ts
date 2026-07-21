import { supabase } from '../../../lib/supabase';
import type { ContentGrade, DraftDocument } from './types';

const API_BASE_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

function apiUrl(path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return API_BASE_URL ? `${API_BASE_URL}${clean}` : clean;
}

async function authHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session?.access_token || ''}`,
  };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = await authHeaders();
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'The document service is unavailable');
  }
  return payload.data as T;
}

export function listDrafts(sessionId: string): Promise<DraftDocument[]> {
  return request<DraftDocument[]>(`/api/drafts/session/${sessionId}`);
}

export function getDraft(id: string): Promise<DraftDocument> {
  return request<DraftDocument>(`/api/drafts/${id}`);
}

export function createDraft(sessionId: string, title?: string): Promise<DraftDocument> {
  return request<DraftDocument>('/api/drafts', {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId, title }),
  });
}

export function updateDraft(
  id: string,
  patch: { title?: string; content_html?: string },
): Promise<DraftDocument> {
  return request<DraftDocument>(`/api/drafts/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function submitDraft(id: string): Promise<DraftDocument> {
  return request<DraftDocument>(`/api/drafts/${id}/submit`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function reviewDraft(
  id: string,
  verdict: 'approve' | 'request_changes',
  note?: string,
): Promise<DraftDocument> {
  return request<DraftDocument>(`/api/drafts/${id}/review`, {
    method: 'POST',
    body: JSON.stringify({ verdict, note }),
  });
}

export function gradeDraft(id: string): Promise<ContentGrade> {
  return request<ContentGrade>(`/api/drafts/${id}/grade`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function deleteDraft(id: string): Promise<void> {
  await request<unknown>(`/api/drafts/${id}`, { method: 'DELETE' });
}
