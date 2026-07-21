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

export const SIM_EMAIL_DOMAIN = 'crisisresponse.sim';

export interface PlayerDirectoryEntry {
  user_id: string;
  full_name: string;
  address: string;
  team_name: string | null;
}

function localPartFromName(fullName: string): string {
  const cleaned = fullName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '.');
  return cleaned || 'player';
}

export async function getSessionPlayerDirectory(
  sessionId: string,
): Promise<PlayerDirectoryEntry[]> {
  try {
    const [{ data: participants }, { data: teamRows }] = await Promise.all([
      supabaseAdmin
        .from('session_participants')
        .select('user_id, user:user_profiles(full_name)')
        .eq('session_id', sessionId),
      supabaseAdmin.from('session_teams').select('user_id, team_name').eq('session_id', sessionId),
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
      directory.push({
        user_id: p.user_id as string,
        full_name: fullName,
        address: `${localPart}@${SIM_EMAIL_DOMAIN}`,
        team_name: teamByUser.get(p.user_id as string) || null,
      });
    }
    return directory;
  } catch (err) {
    logger.error({ err, sessionId }, 'Failed to build session player directory');
    return [];
  }
}

/** Resolve a set of addresses to directory entries (case-insensitive). */
export function resolveAddressesToPlayers(
  addresses: string[],
  directory: PlayerDirectoryEntry[],
): PlayerDirectoryEntry[] {
  const wanted = new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean));
  return directory.filter((entry) => wanted.has(entry.address.toLowerCase()));
}
