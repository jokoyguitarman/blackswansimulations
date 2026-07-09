import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Game-type-aware session lifecycle for the load-test harness.
 *
 * - field + demo bots:   POST /api/demo/start (session with sim_mode = null,
 *                        optional scripted/AI bots generating activity)
 * - field without bots / social: the regular sessions API, which derives
 *   sim_mode from the scenario category — required for social mode so the
 *   feed engine, NPC repliers and watchdog actually run.
 */

export type Gametype = 'field' | 'social';
export type DemoMode = 'off' | 'scripted' | 'ai';

export interface ApiClient {
  baseUrl: string;
  token: string;
}

export interface SessionHandle {
  sessionId: string;
  gametype: Gametype;
  createdVia: 'demo' | 'sessions';
  scenarioId: string;
  scenarioTitle: string;
  probeChannelId: string;
}

export async function apiFetch<T>(
  api: ApiClient,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${api.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${api.token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

interface ScenarioPick {
  id: string;
  title: string;
}

export async function pickScenario(
  admin: SupabaseClient,
  gametype: Gametype,
  explicitId?: string,
): Promise<ScenarioPick> {
  if (explicitId) {
    const { data, error } = await admin
      .from('scenarios')
      .select('id, title, category')
      .eq('id', explicitId)
      .single();
    if (error || !data) throw new Error(`Scenario ${explicitId} not found`);
    return { id: data.id, title: data.title };
  }

  if (gametype === 'social') {
    const { data, error } = await admin
      .from('scenarios')
      .select('id, title')
      .eq('category', 'social_media_crisis')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(`Scenario lookup failed: ${error.message}`);
    if (!data?.length) {
      throw new Error(
        'No social_media_crisis scenario found. Create one with the Social Crisis Wizard first.',
      );
    }
    return { id: data[0].id, title: data[0].title };
  }

  // Field: needs a scenario that has teams (demo/start requires them, and they
  // represent the real field-ops setup).
  const { data: teamRows, error: teamsErr } = await admin
    .from('scenario_teams')
    .select('scenario_id');
  if (teamsErr) throw new Error(`Scenario teams lookup failed: ${teamsErr.message}`);
  const ids = [...new Set((teamRows ?? []).map((r: { scenario_id: string }) => r.scenario_id))];
  if (ids.length === 0) {
    throw new Error(
      'No scenario with teams found. Seed a demo scenario first (see demo/README.md).',
    );
  }
  const { data, error } = await admin
    .from('scenarios')
    .select('id, title')
    .in('id', ids)
    .neq('category', 'social_media_crisis')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`Scenario lookup failed: ${error.message}`);
  if (!data?.length) throw new Error('No field-ops scenario with teams found.');
  return { id: data[0].id, title: data[0].title };
}

async function findProbeChannel(admin: SupabaseClient, sessionId: string): Promise<string> {
  const { data, error } = await admin
    .from('chat_channels')
    .select('id, name, type')
    .eq('session_id', sessionId);
  if (error || !data?.length) {
    throw new Error(`No channels found for session ${sessionId}: ${error?.message ?? 'empty'}`);
  }
  // Prefer the all-hands channel; probes broadcast to the whole session room
  // regardless, this only determines where the chat rows land.
  const preferred =
    data.find((c) => c.type === 'inter_agency') ??
    data.find((c) => c.type === 'public') ??
    data.find((c) => c.type !== 'trainer' && c.type !== 'direct') ??
    data[0];
  return preferred.id;
}

export async function createSession(
  api: ApiClient,
  admin: SupabaseClient,
  gametype: Gametype,
  demoMode: DemoMode,
  scenario: ScenarioPick,
  log: (msg: string) => void,
): Promise<SessionHandle> {
  let sessionId: string;
  let createdVia: 'demo' | 'sessions';

  if (gametype === 'field' && demoMode !== 'off') {
    log(`Starting field demo session (mode=${demoMode}) on scenario "${scenario.title}"...`);
    const res = await apiFetch<{ data: { sessionId: string } }>(api, 'POST', '/api/demo/start', {
      scenarioId: scenario.id,
      mode: demoMode,
    });
    sessionId = res.data.sessionId;
    createdVia = 'demo';
  } else {
    log(`Creating ${gametype} session on scenario "${scenario.title}"...`);
    const created = await apiFetch<{ data: { id: string; sim_mode: string | null } }>(
      api,
      'POST',
      '/api/sessions',
      { scenario_id: scenario.id },
    );
    sessionId = created.data.id;
    if (gametype === 'social' && created.data.sim_mode !== 'social_media') {
      throw new Error(
        `Session ${sessionId} was created without sim_mode='social_media' — the scenario is ` +
          `not a social crisis scenario, so the social engines would stay dormant.`,
      );
    }
    await apiFetch(api, 'PATCH', `/api/sessions/${sessionId}`, { status: 'in_progress' });
    createdVia = 'sessions';
  }

  const probeChannelId = await findProbeChannel(admin, sessionId);
  log(`Session ${sessionId} running (via ${createdVia}), probe channel ${probeChannelId}`);

  return {
    sessionId,
    gametype,
    createdVia,
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    probeChannelId,
  };
}

export async function teardownSession(
  api: ApiClient,
  handle: SessionHandle,
  log: (msg: string) => void,
): Promise<void> {
  try {
    if (handle.createdVia === 'demo') {
      await apiFetch(api, 'POST', '/api/demo/stop', { sessionId: handle.sessionId });
    } else {
      await apiFetch(api, 'PATCH', `/api/sessions/${handle.sessionId}`, { status: 'completed' });
    }
    log(`Session ${handle.sessionId} closed.`);
  } catch (err) {
    log(`WARNING: failed to close session ${handle.sessionId}: ${(err as Error).message}`);
  }
}
