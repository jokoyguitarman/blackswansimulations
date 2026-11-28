/**
 * Scenario library data — kept out of lib/api.ts on purpose (another agent has that file in
 * flight). Same auth + base-URL conventions as api.ts.
 */
import { SETUP_EDIT_ALLOWANCE_IDS_MAX } from '@shared/setupEditAllowance';
import type { FrozenBaselineIdentity } from './editModeFlags';
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

export interface ScenarioCastMember {
  id?: string;
  name?: string;
  title?: string;
  org_key: string | null;
  page_org_key: string | null;
  relationship?: string;
}

/** First three organisations' principals, up to four each; `count` is the organisation's total. */
export interface ScenarioCastGroup {
  key: string;
  count: number;
  members: ScenarioCastMember[];
}

export interface ScenarioSummary {
  teams: number;
  injects: number;
  contacts: number;
  crowd: number;
  orgs: ScenarioSummaryOrg[];
  cast?: ScenarioCastGroup[];
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

export interface SetupEditHistoryEntry {
  id: string;
  status: 'open' | 'applying' | 'applied' | 'abandoned' | 'failed' | string;
  opened_by: string | null;
  opened_by_admin: boolean;
  opened_by_name: string | null;
  edit_number: number | null;
  counted: boolean;
  error: string | null;
  created_at: string;
  applied_at: string | null;
  draft_id: string | null;
  applied_summary: unknown;
  baseline_identity: FrozenBaselineIdentity | null;
}

export interface SetupEditAllowance {
  enabled: boolean;
  limit: number;
  used: number;
  remaining: number | null;
  open_edit: SetupEditHistoryEntry | null;
  history: SetupEditHistoryEntry[];
}

/**
 * GET /api/scenarios/:id/setup-edits. A 404 (flag off) or enabled:false
 * (migration 274 absent) means the library shows no button. Failures are
 * swallowed so a missing migration does not surface an error.
 */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function parseBaselineIdentity(value: unknown): FrozenBaselineIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const primary = typeof row.primary_org_key === 'string' ? row.primary_org_key.trim() : '';
  const orgKeys = stringList(row.org_keys);
  if (!primary || orgKeys.length === 0) return null;
  return { primary_org_key: primary, org_keys: orgKeys, team_uids: stringList(row.team_uids) };
}

function parseEditEntry(value: unknown): SetupEditHistoryEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string') return null;
  return {
    id: row.id,
    status: typeof row.status === 'string' ? row.status : 'open',
    opened_by: typeof row.opened_by === 'string' ? row.opened_by : null,
    opened_by_admin: row.opened_by_admin === true,
    opened_by_name: typeof row.opened_by_name === 'string' ? row.opened_by_name : null,
    edit_number: typeof row.edit_number === 'number' ? row.edit_number : null,
    counted: row.counted === true,
    error: typeof row.error === 'string' ? row.error : null,
    created_at: typeof row.created_at === 'string' ? row.created_at : '',
    applied_at: typeof row.applied_at === 'string' ? row.applied_at : null,
    draft_id: typeof row.draft_id === 'string' ? row.draft_id : null,
    applied_summary: row.applied_summary ?? null,
    baseline_identity: parseBaselineIdentity(row.baseline_identity),
  };
}

function parseEditHistory(value: unknown): SetupEditHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map(parseEditEntry).filter((row): row is SetupEditHistoryEntry => row != null);
}

function allowanceFromJson(json: Partial<SetupEditAllowance>): SetupEditAllowance | null {
  if (json.enabled !== true) return null;
  return {
    enabled: true,
    limit: typeof json.limit === 'number' ? json.limit : 0,
    used: typeof json.used === 'number' ? json.used : 0,
    remaining: typeof json.remaining === 'number' ? json.remaining : null,
    open_edit: parseEditEntry(json.open_edit),
    history: parseEditHistory(json.history),
  };
}

/**
 * One read for every social-crisis card. A 404 (flag off) or enabled:false
 * (migration 274 absent) means the library shows no buttons.
 */
export async function getSetupEditAllowances(
  ids: readonly string[],
): Promise<Record<string, SetupEditAllowance> | null> {
  if (ids.length === 0) return {};
  const out: Record<string, SetupEditAllowance> = {};
  try {
    for (let offset = 0; offset < ids.length; offset += SETUP_EDIT_ALLOWANCE_IDS_MAX) {
      const slice = ids.slice(offset, offset + SETUP_EDIT_ALLOWANCE_IDS_MAX);
      const res = await fetch(
        url(`/api/scenarios/setup-edits/allowances?ids=${encodeURIComponent(slice.join(','))}`),
        { headers: await headers() },
      );
      if (!res.ok) return null;
      const json = (await res.json()) as {
        enabled?: boolean;
        allowances?: Record<string, Partial<SetupEditAllowance>>;
      };
      if (json.enabled !== true || !json.allowances) return null;
      for (const [id, row] of Object.entries(json.allowances)) {
        const parsed = allowanceFromJson(row);
        if (parsed) out[id] = parsed;
      }
    }
    return out;
  } catch {
    return null;
  }
}

export async function getSetupEditAllowance(id: string): Promise<SetupEditAllowance | null> {
  try {
    const res = await fetch(url(`/api/scenarios/${id}/setup-edits`), { headers: await headers() });
    if (!res.ok) return null;
    const json = (await res.json()) as Partial<SetupEditAllowance>;
    const parsed = allowanceFromJson(json);
    if (parsed) return parsed;
    return {
      enabled: false,
      limit: typeof json.limit === 'number' ? json.limit : 0,
      used: 0,
      remaining: null,
      open_edit: null,
      history: [],
    };
  } catch {
    return null;
  }
}

export async function getScenarioTeamsPeek(id: string): Promise<PeekTeam[]> {
  const res = await fetch(url(`/api/scenarios/${id}/teams`), { headers: await headers() });
  if (!res.ok) return [];
  const json = (await res.json()) as { data: PeekTeam[] };
  return json.data ?? [];
}
