import type { BuildLogLine, BuildView } from './buildStatus';

const API_BASE = import.meta.env.VITE_API_URL || '';

function apiUrl(path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return API_BASE ? `${API_BASE}${clean}` : clean;
}

const ROOT = '/api/warroom/social-crisis/builds';

export interface BuildApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
  code: string | null;
  /** Present on 409 BUILD_ACTIVE. */
  buildId: string | null;
  /** Raw JSON, so a 400 can be pinned onto Setup. */
  body: unknown;
}

export type HeaderSource = () => Promise<Record<string, string>>;

async function call<T>(
  path: string,
  headers: HeaderSource,
  init?: RequestInit,
): Promise<BuildApiResult<T>> {
  try {
    const res = await fetch(apiUrl(path), { ...init, headers: await headers() });
    const body = (await res.json().catch(() => null)) as {
      data?: T;
      error?: string;
      code?: string;
      build_id?: string;
    } | null;
    return {
      ok: res.ok,
      status: res.status,
      data: body?.data ?? null,
      error: typeof body?.error === 'string' ? body.error : null,
      code: typeof body?.code === 'string' ? body.code : null,
      buildId: typeof body?.build_id === 'string' ? body.build_id : null,
      body,
    };
  } catch {
    return {
      ok: false,
      status: 0,
      data: null,
      error: 'Network error',
      code: null,
      buildId: null,
      body: null,
    };
  }
}

export interface StartBuildBody {
  draft_id: string;
  idempotency_key: string;
  request: Record<string, unknown>;
  replace_active?: boolean;
}

export function startBuild(
  body: StartBuildBody,
  headers: HeaderSource,
): Promise<BuildApiResult<{ build: BuildView; outcome: 'created' | 'replayed' | 'attached' }>> {
  return call(ROOT, headers, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function getBuild(
  id: string,
  after: number,
  headers: HeaderSource,
): Promise<BuildApiResult<{ build: BuildView; log: BuildLogLine[]; next_after: number }>> {
  // A deploy that accepts the socket and never answers must become a transient
  // miss, not a spinner that waits for the browser's default.
  const signal = AbortSignal.timeout(12_000);
  return call(`${ROOT}/${id}?after=${after}`, headers, { signal });
}

export function getLatestBuild(
  draftId: string,
  headers: HeaderSource,
): Promise<BuildApiResult<{ build: BuildView | null }>> {
  return call(`${ROOT}?draft_id=${encodeURIComponent(draftId)}`, headers);
}

export function getReview(
  id: string,
  headers: HeaderSource,
): Promise<BuildApiResult<Record<string, unknown>>> {
  return call(`${ROOT}/${id}/review`, headers);
}

export function resumeBuild(
  id: string,
  headers: HeaderSource,
): Promise<BuildApiResult<{ build: BuildView }>> {
  return call(`${ROOT}/${id}/resume`, headers, { method: 'POST', body: '{}' });
}

export function cancelBuild(
  id: string,
  headers: HeaderSource,
): Promise<BuildApiResult<{ build: BuildView }>> {
  return call(`${ROOT}/${id}/cancel`, headers, { method: 'POST', body: '{}' });
}
