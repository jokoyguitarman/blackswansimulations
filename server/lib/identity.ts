/**
 * In-game identity helpers (docs/session-bugfix-spec-2026-09-20.md §10).
 *
 * One display name, one handle derivation, used by every surface that shows a player's name —
 * feed posts, reposts, Messenger, events, groups, email `from_name`, NPC prompts. The display name
 * comes from `user_profiles.full_name` (attached by `requireAuth` as `user.displayName`); Supabase
 * Auth `user_metadata.full_name` is a stale write-only cache and is only a last-resort fallback.
 */

export interface IdentityUser {
  id: string;
  email?: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
}

/** The name players and NPCs see. Never empty. */
export function displayNameOf(user: IdentityUser): string {
  const fromProfile = user.displayName?.trim();
  if (fromProfile) return fromProfile;
  const fromMeta = user.metadata?.full_name;
  if (typeof fromMeta === 'string' && fromMeta.trim()) return fromMeta.trim();
  const local = user.email?.split('@')[0]?.trim();
  return local || 'Player';
}

/**
 * `@handle` for feed / Messenger identities. Deliberately the legacy derivation (each of `@ . space
 * + ,` becomes one `_`, lowercased) so handles already stored on posts, DM threads and
 * notifications keep matching; `"` and `\` are also replaced because the value is interpolated
 * into PostgREST filters.
 */
export function handleFor(name: string): string {
  const slug = name.replace(/[@.\s+,"\\]/g, '_').toLowerCase();
  return `@${slug || 'player'}`;
}

/** First name for greetings ("Hi Kenneth"); falls back to the whole name. */
export function firstNameOf(name: string): string {
  const trimmed = name.trim();
  // "Yeo, Kenneth X." style → the part after the comma is the given name.
  if (trimmed.includes(',')) {
    const given = trimmed.split(',')[1]?.trim().split(/\s+/)[0];
    if (given) return given;
  }
  return trimmed.split(/\s+/)[0] || trimmed;
}
