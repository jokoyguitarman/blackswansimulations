import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';

/**
 * In-sim email directory for session participants.
 *
 * Every participant gets a deterministic simulated address derived from their
 * full name (e.g. "John Doe" -> john.doe@crisisresponse.sim). The same
 * directory is used when sending (from_address), when resolving to/cc
 * addresses to concrete player ids, and by the contacts endpoint — so
 * player-to-player mail always round-trips.
 */

/** Legacy platform-wide domain; still accepted on resolution so mail stored before the per-org
 *  domains keeps round-tripping (docs/session-bugfix-spec-2026-09-20.md §10.3). */
export const SIM_EMAIL_DOMAIN = 'crisisresponse.sim';

export interface PlayerDirectoryEntry {
  user_id: string;
  full_name: string;
  /** `<local>@<organisation domain>` — the address shown and used from now on. */
  address: string;
  /** `<local>@crisisresponse.sim` — accepted on inbound resolution only. */
  legacy_address: string;
  team_name: string | null;
  org_key: string | null;
}

function localPartFromName(fullName: string): string {
  const cleaned = fullName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '.');
  return cleaned || 'player';
}

function domainSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 24) || 'org'
  );
}

/**
 * Email domain per organisation for this session (§10.3): the most common domain among that
 * organisation's `internal` stakeholders (so teammates and internal NPCs share a domain), else a
 * slug of the organisation's short/display name + `.sim`, else the legacy platform domain.
 * `default` is the primary protagonist's domain, used for players without a team/org.
 */
export async function getSessionEmailDomains(
  sessionId: string,
): Promise<{ byOrgKey: Map<string, string>; default: string }> {
  const byOrgKey = new Map<string, string>();
  let fallback = SIM_EMAIL_DOMAIN;
  try {
    const { getSessionScenarioId } = await import('../lib/scenarioCache.js');
    const scenarioId = await getSessionScenarioId(sessionId);
    if (!scenarioId) return { byOrgKey, default: fallback };
    const [{ getOrgRegistry }, { getStakeholders }] = await Promise.all([
      import('./orgRegistryService.js'),
      import('./stakeholderService.js'),
    ]);
    const [orgs, stakeholders] = await Promise.all([
      getOrgRegistry(scenarioId),
      getStakeholders(scenarioId).catch(() => []),
    ]);

    // Domain votes from internal stakeholders, per org.
    const votes = new Map<string, Map<string, number>>();
    for (const s of stakeholders) {
      if (s.relationship !== 'internal' || !s.org_key) continue;
      const domain = s.email.split('@')[1]?.toLowerCase();
      if (!domain) continue;
      const m = votes.get(s.org_key) ?? new Map<string, number>();
      m.set(domain, (m.get(domain) ?? 0) + 1);
      votes.set(s.org_key, m);
    }
    for (const org of orgs) {
      if (org.side !== 'protagonist') continue;
      const voted = votes.get(org.org_key);
      const top = voted ? [...voted.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] : undefined;
      byOrgKey.set(org.org_key, top ?? `${domainSlug(org.short_name || org.display_name)}.sim`);
    }
    const primary =
      orgs.find((o) => o.side === 'protagonist' && o.is_primary) ??
      orgs.find((o) => o.side === 'protagonist');
    if (primary) fallback = byOrgKey.get(primary.org_key) ?? fallback;
  } catch (err) {
    logger.debug({ err, sessionId }, 'Session email domains unavailable; using legacy domain');
  }
  return { byOrgKey, default: fallback };
}

export async function getSessionPlayerDirectory(
  sessionId: string,
): Promise<PlayerDirectoryEntry[]> {
  try {
    const [{ data: participants }, { data: teamRows }, domains, orgByTeam] = await Promise.all([
      supabaseAdmin
        .from('session_participants')
        .select('user_id, user:user_profiles(full_name)')
        .eq('session_id', sessionId),
      supabaseAdmin.from('session_teams').select('user_id, team_name').eq('session_id', sessionId),
      getSessionEmailDomains(sessionId),
      (async () => {
        try {
          const { getSessionTeams } = await import('./orgRegistryService.js');
          return new Map(
            (await getSessionTeams(sessionId)).map((t) => [t.team_name, t.org_key ?? null]),
          );
        } catch {
          return new Map<string, string | null>();
        }
      })(),
    ]);

    const teamByUser = new Map<string, string>();
    for (const row of teamRows || []) {
      if (!teamByUser.has(row.user_id as string)) {
        teamByUser.set(row.user_id as string, row.team_name as string);
      }
    }

    // Deterministic collision handling: stable order by user_id, then suffix
    // duplicate local parts with .2, .3, ...
    const sorted = [...(participants || [])].sort((a, b) =>
      String(a.user_id).localeCompare(String(b.user_id)),
    );

    const usedLocalParts = new Map<string, number>();
    const directory: PlayerDirectoryEntry[] = [];
    for (const p of sorted) {
      const profile = p.user as unknown as { full_name: string } | null;
      const fullName = profile?.full_name || 'Player';
      const base = localPartFromName(fullName);
      const count = usedLocalParts.get(base) || 0;
      usedLocalParts.set(base, count + 1);
      const localPart = count === 0 ? base : `${base}.${count + 1}`;
      const teamName = teamByUser.get(p.user_id as string) || null;
      const orgKey = teamName ? (orgByTeam.get(teamName) ?? null) : null;
      const domain = (orgKey && domains.byOrgKey.get(orgKey)) || domains.default;
      directory.push({
        user_id: p.user_id as string,
        full_name: fullName,
        address: `${localPart}@${domain}`,
        legacy_address: `${localPart}@${SIM_EMAIL_DOMAIN}`,
        team_name: teamName,
        org_key: orgKey,
      });
    }
    return directory;
  } catch (err) {
    logger.error({ err, sessionId }, 'Failed to build session player directory');
    return [];
  }
}

/** Resolve a set of addresses to directory entries (case-insensitive; legacy domain accepted). */
export function resolveAddressesToPlayers(
  addresses: string[],
  directory: PlayerDirectoryEntry[],
): PlayerDirectoryEntry[] {
  const wanted = new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean));
  return directory.filter(
    (entry) =>
      wanted.has(entry.address.toLowerCase()) || wanted.has(entry.legacy_address.toLowerCase()),
  );
}
