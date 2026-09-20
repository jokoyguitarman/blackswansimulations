/**
 * Organisation registry + team identity resolution (contract §5).
 *
 * Reads `initial_state.orgs[]` (canonical), falling back to `org_page.orgs[]`, then to one
 * implicit organisation. Resolves a team's function / org / country through
 * `scenario_teams.function_key` / `.org_key` (migration 197, generator-owned) — selected with
 * `*` so the code works before those columns exist.
 */
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import {
  cachedByScenario,
  getScenarioSnapshot,
  getSessionScenarioId,
  type ScenarioSnapshot,
} from '../lib/scenarioCache.js';
import {
  OrgRegistrySchema,
  CountriesSchema,
  resolveTeamFunction,
  type OrgRegistryEntry,
  type CountryEntry,
  type TeamIdentity,
} from '../lib/stakeholderContract.js';

export const IMPLICIT_ORG_KEY = 'primary';

interface OrgPageLite {
  org_key: string;
  display_name: string;
  is_primary: boolean;
  role: 'protagonist' | 'antagonist';
  country?: string;
  city?: string;
  facebook?: { page_handle?: string };
  x_twitter?: { page_handle?: string };
}

/**
 * Minimal mirror of `normalizeOrgPages` (generator-owned) so this runtime module does not import
 * the generator: accepts the multi-org `orgs[]` shape or the legacy single-org shape.
 */
function normalizeOrgPagesLite(orgPage: unknown): OrgPageLite[] {
  if (!orgPage || typeof orgPage !== 'object') return [];
  const op = orgPage as Record<string, unknown>;
  const orgs = op.orgs;
  if (Array.isArray(orgs) && orgs.length > 0) {
    const list = orgs.map((raw, i) => {
      const o = (raw ?? {}) as Record<string, unknown>;
      const fb = o.facebook as Record<string, unknown> | undefined;
      const x = o.x_twitter as Record<string, unknown> | undefined;
      return {
        org_key: String(o.org_key || (o.is_primary ? IMPLICIT_ORG_KEY : `org_${i + 1}`)),
        display_name: String(o.display_name || fb?.page_name || x?.page_name || 'Organization'),
        is_primary: !!o.is_primary,
        role: o.role === 'antagonist' ? 'antagonist' : 'protagonist',
        country: typeof o.country === 'string' ? o.country : undefined,
        city: typeof o.city === 'string' ? o.city : undefined,
        facebook: fb ? { page_handle: fb.page_handle as string | undefined } : undefined,
        x_twitter: x ? { page_handle: x.page_handle as string | undefined } : undefined,
      } satisfies OrgPageLite;
    });
    if (!list.some((o) => o.is_primary)) list[0].is_primary = true;
    return list;
  }
  const fb = op.facebook as Record<string, unknown> | undefined;
  const x = op.x_twitter as Record<string, unknown> | undefined;
  if (fb || x) {
    return [
      {
        org_key: IMPLICIT_ORG_KEY,
        display_name: String(fb?.page_name || x?.page_name || 'Organization'),
        is_primary: true,
        role: 'protagonist',
        facebook: fb ? { page_handle: fb.page_handle as string | undefined } : undefined,
        x_twitter: x ? { page_handle: x.page_handle as string | undefined } : undefined,
      },
    ];
  }
  return [];
}

// ─── Registry ────────────────────────────────────────────────────────────────

function deriveRegistry(snapshot: ScenarioSnapshot): OrgRegistryEntry[] {
  const state = snapshot.initial_state;

  const explicit = state.orgs;
  if (Array.isArray(explicit) && explicit.length > 0) {
    const parsed = OrgRegistrySchema.safeParse(explicit);
    if (parsed.success) return parsed.data;
    logger.warn(
      { scenarioId: snapshot.id, issues: parsed.error.issues.slice(0, 5) },
      'initial_state.orgs[] failed validation; deriving registry from org_page instead',
    );
  }

  const pages = normalizeOrgPagesLite(state.org_page);
  if (pages.length > 0) {
    return pages.map((p) => ({
      org_key: p.org_key,
      display_name: p.display_name,
      country: p.country ?? null,
      city: p.city,
      side: p.role,
      is_primary: p.is_primary,
    }));
  }

  return [
    {
      org_key: IMPLICIT_ORG_KEY,
      display_name: String(state.org_name || snapshot.title || 'Organization'),
      country: null,
      side: 'protagonist',
      is_primary: true,
    },
  ];
}

export async function getOrgRegistry(scenarioId: string): Promise<OrgRegistryEntry[]> {
  return cachedByScenario('orgRegistry', scenarioId, deriveRegistry, []);
}

export async function getProtagonistOrgs(scenarioId: string): Promise<OrgRegistryEntry[]> {
  return (await getOrgRegistry(scenarioId)).filter((o) => o.side === 'protagonist');
}

export async function getCountries(scenarioId: string): Promise<CountryEntry[]> {
  return cachedByScenario(
    'countries',
    scenarioId,
    async (snapshot) => {
      const explicit = snapshot.initial_state.countries;
      if (Array.isArray(explicit) && explicit.length > 0) {
        const parsed = CountriesSchema.safeParse(explicit);
        if (parsed.success) return parsed.data;
      }
      const registry = deriveRegistry(snapshot);
      const names = new Set<string>();
      for (const o of registry) if (o.country) names.add(o.country);
      return Array.from(names).map((name) => ({ name }));
    },
    [],
  );
}

/** True when the scenario has more than one protagonist organisation (multi-office / multi-agency). */
export async function isMultiOrg(scenarioId: string): Promise<boolean> {
  return (await getProtagonistOrgs(scenarioId)).length > 1;
}

export async function orgCountry(
  scenarioId: string,
  orgKey: string | null,
): Promise<string | null> {
  if (!orgKey) return null;
  const registry = await getOrgRegistry(scenarioId);
  return registry.find((o) => o.org_key === orgKey)?.country ?? null;
}

/**
 * Country of an org page, by `org_page.orgs[].org_key` or by either platform's page handle.
 * Used to stamp page-originated posts (contract §4.1).
 */
export async function orgCountryForPage(
  scenarioId: string,
  orgKeyOrHandle: string,
): Promise<string | null> {
  const snapshot = await getScenarioSnapshot(scenarioId);
  if (!snapshot) return null;
  const registry = await getOrgRegistry(scenarioId);
  const direct = registry.find((o) => o.org_key === orgKeyOrHandle);
  if (direct) return direct.country ?? null;

  const pages = normalizeOrgPagesLite(snapshot.initial_state.org_page);
  const needle = orgKeyOrHandle.toLowerCase();
  const page = pages.find(
    (p) =>
      p.facebook?.page_handle?.toLowerCase() === needle ||
      p.x_twitter?.page_handle?.toLowerCase() === needle,
  );
  if (!page) return null;
  return registry.find((o) => o.org_key === page.org_key)?.country ?? null;
}

// ─── Teams ───────────────────────────────────────────────────────────────────

export interface SessionTeam extends TeamIdentity {
  scenario_team_id: string | null;
  member_user_ids: string[];
}

interface ScenarioTeamRow {
  id: string;
  team_name: string;
  function_key?: string | null;
  org_key?: string | null;
}

async function loadScenarioTeams(scenarioId: string): Promise<ScenarioTeamRow[]> {
  return cachedByScenario(
    'scenarioTeams',
    scenarioId,
    async () => {
      // '*' on purpose: tolerates the 197 columns not existing yet (they read as undefined → null).
      const { data, error } = await supabaseAdmin
        .from('scenario_teams')
        .select('*')
        .eq('scenario_id', scenarioId);
      if (error) {
        logger.warn({ error, scenarioId }, 'orgRegistry: failed to load scenario_teams');
        return [];
      }
      return (data ?? []).map((r) => {
        const row = r as Record<string, unknown>;
        return {
          id: String(row.id),
          team_name: String(row.team_name),
          function_key: (row.function_key as string | null | undefined) ?? null,
          org_key: (row.org_key as string | null | undefined) ?? null,
        };
      });
    },
    [],
  );
}

/**
 * Every team present in the session (from `session_teams`) plus every scenario-defined team,
 * each with its identity and current members.
 */
export async function getSessionTeams(sessionId: string): Promise<SessionTeam[]> {
  const scenarioId = await getSessionScenarioId(sessionId);
  const scenarioTeams = scenarioId ? await loadScenarioTeams(scenarioId) : [];
  const registry = scenarioId ? await getOrgRegistry(scenarioId) : [];

  const { data: assignments } = await supabaseAdmin
    .from('session_teams')
    .select('user_id, team_name')
    .eq('session_id', sessionId);

  const membersByTeam = new Map<string, Set<string>>();
  for (const a of assignments ?? []) {
    const r = a as { user_id: string; team_name: string };
    if (!membersByTeam.has(r.team_name)) membersByTeam.set(r.team_name, new Set());
    membersByTeam.get(r.team_name)!.add(r.user_id);
  }

  const byName = new Map<string, SessionTeam>();
  for (const t of scenarioTeams) {
    byName.set(t.team_name, {
      scenario_team_id: t.id,
      team_name: t.team_name,
      function_key: t.function_key ?? null,
      org_key: t.org_key ?? null,
      country: registry.find((o) => o.org_key === t.org_key)?.country ?? null,
      member_user_ids: Array.from(membersByTeam.get(t.team_name) ?? []),
    });
  }
  // Legacy / custom teams that exist only as assignments.
  for (const [teamName, members] of membersByTeam) {
    if (!byName.has(teamName)) {
      byName.set(teamName, {
        scenario_team_id: null,
        team_name: teamName,
        function_key: null,
        org_key: null,
        country: null,
        member_user_ids: Array.from(members),
      });
    }
  }
  return Array.from(byName.values());
}

/** A player's team identity, or null when unassigned. Earliest assignment wins (legacy multi-rows). */
export async function getTeamIdentity(
  sessionId: string,
  userId: string,
): Promise<TeamIdentity | null> {
  const { data: rows } = await supabaseAdmin
    .from('session_teams')
    .select('team_name, assigned_at')
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .order('assigned_at', { ascending: true })
    .limit(1);
  const teamName =
    rows && rows.length > 0 ? String((rows[0] as { team_name: string }).team_name) : null;
  if (!teamName) return null;

  const teams = await getSessionTeams(sessionId);
  const team = teams.find((t) => t.team_name === teamName);
  if (team) {
    const { team_name, function_key, org_key, country } = team;
    return { team_name, function_key, org_key, country };
  }
  return { team_name: teamName, function_key: null, org_key: null, country: null };
}

/** Identity for a team by name within a session (null when unknown). */
export async function getTeamIdentityByName(
  sessionId: string,
  teamName: string,
): Promise<TeamIdentity | null> {
  const teams = await getSessionTeams(sessionId);
  const team = teams.find((t) => t.team_name === teamName);
  if (!team) return null;
  const { team_name, function_key, org_key, country } = team;
  return { team_name, function_key, org_key, country };
}

/** Teams whose function (function_key ?? team_name) equals `fn`, optionally restricted to an org. */
export async function getTeamsByFunction(
  sessionId: string,
  fn: string,
  orgKey?: string | null,
): Promise<SessionTeam[]> {
  const teams = await getSessionTeams(sessionId);
  return teams.filter(
    (t) =>
      (resolveTeamFunction(t) === fn || t.team_name === fn) &&
      (orgKey == null || t.org_key == null || t.org_key === orgKey),
  );
}

/** Users on teams belonging to `orgKey` (teams with a null org_key belong to every org). */
export async function getOrgMemberUserIds(sessionId: string, orgKey: string): Promise<string[]> {
  const teams = await getSessionTeams(sessionId);
  const ids = new Set<string>();
  for (const t of teams) {
    if (t.org_key === null || t.org_key === orgKey) for (const u of t.member_user_ids) ids.add(u);
  }
  return Array.from(ids);
}

export async function getUserCountry(sessionId: string, userId: string): Promise<string | null> {
  const identity = await getTeamIdentity(sessionId, userId);
  return identity?.country ?? null;
}

// ─── Personas by country (contract §5.3) ─────────────────────────────────────

const MIN_POOL = 5;

/** Personas usable for `country`: untagged personas are global; tiny pools fall back to everyone. */
export function selectPersonaPool<T extends { country?: string | null }>(
  personas: T[],
  country: string | null | undefined,
): T[] {
  if (!country) return personas;
  const pool = personas.filter((p) => !p.country || p.country === country);
  return pool.length >= MIN_POOL ? pool : personas;
}
