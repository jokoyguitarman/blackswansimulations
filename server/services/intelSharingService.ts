import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { recordPlayerAction } from './sopCheckerService.js';
import type { PlayerDirectoryEntry } from './playerDirectoryService.js';

/**
 * Cross-team intel sharing detection.
 *
 * The generator plants "intel" emails: team-scoped inject emails whose
 * delivery_config carries intel_key / intel_needed_by / detection_keywords.
 * This service derives the intel manifest from scenario_injects at runtime
 * (no stored copy — trainer edits in the scenario editor stay authoritative)
 * and detects when players relay that intel to the team that needs it:
 *
 *  - deterministically, when an intel email is forwarded to a member of a
 *    needed team (recordIntelShareFromForward, called from POST /emails);
 *  - by keyword fingerprint, when a player writes the facts in their own
 *    words in a player-to-player email or the shared group chat
 *    (detectIntelSharing, called from computeSocialState each tick).
 *
 * Each detection records a single intel_shared player action per intel key;
 * social_state.shared_intel_keys then drives the intel_shared:/intel_missing:
 * gate conditions, team scoring, the trainer dashboard, and the AAR.
 */

export interface IntelManifestEntry {
  intel_key: string;
  holder_team: string;
  needed_by: string[];
  detection_keywords: string[];
  summary: string;
  source_inject_id: string;
  source_title: string;
  trigger_time_minutes: number | null;
  /** Sharing deadline = the paired intel_missing gate's eligible_after_minutes. */
  deadline_minutes: number | null;
}

interface ManifestCacheEntry {
  manifest: IntelManifestEntry[];
  fetchedAt: number;
}

const MANIFEST_CACHE_TTL_MS = 60_000;
const manifestCache = new Map<string, ManifestCacheEntry>();

export async function getIntelManifest(scenarioId: string): Promise<IntelManifestEntry[]> {
  const cached = manifestCache.get(scenarioId);
  if (cached && Date.now() - cached.fetchedAt < MANIFEST_CACHE_TTL_MS) return cached.manifest;

  try {
    const { data: injects } = await supabaseAdmin
      .from('scenario_injects')
      .select(
        'id, title, target_teams, trigger_time_minutes, delivery_config, conditions_to_appear, eligible_after_minutes',
      )
      .eq('scenario_id', scenarioId);

    const rows = injects || [];

    // Deadlines come from the paired negative gates (intel_missing:<key>).
    const deadlineByKey = new Map<string, number>();
    for (const inj of rows) {
      const conds = inj.conditions_to_appear as { conditions?: string[] } | null;
      for (const cond of conds?.conditions || []) {
        if (typeof cond === 'string' && cond.startsWith('intel_missing:')) {
          const key = cond.slice('intel_missing:'.length);
          if (key && inj.eligible_after_minutes != null) {
            deadlineByKey.set(key, Number(inj.eligible_after_minutes));
          }
        }
      }
    }

    const manifest: IntelManifestEntry[] = [];
    const seen = new Set<string>();
    for (const inj of rows) {
      const dc = (inj.delivery_config || {}) as Record<string, unknown>;
      const key = typeof dc.intel_key === 'string' ? dc.intel_key : '';
      if (!key || seen.has(key)) continue;
      const neededBy = Array.isArray(dc.intel_needed_by)
        ? (dc.intel_needed_by as unknown[]).map(String).filter(Boolean)
        : [];
      // Keywords may be empty (trainer cleared them): the entry stays in the
      // manifest so forward detection, gates, and status still work — only
      // free-text content matching is disabled for it.
      const keywords = Array.isArray(dc.detection_keywords)
        ? (dc.detection_keywords as unknown[]).map(String).filter((k) => k.trim().length >= 2)
        : [];
      if (neededBy.length === 0) continue;
      seen.add(key);
      manifest.push({
        intel_key: key,
        holder_team: ((inj.target_teams as string[] | null) || [])[0] || 'Unknown',
        needed_by: neededBy,
        detection_keywords: keywords,
        summary: typeof dc.intel_summary === 'string' ? dc.intel_summary : '',
        source_inject_id: inj.id as string,
        source_title: (inj.title as string) || key,
        trigger_time_minutes:
          inj.trigger_time_minutes != null ? Number(inj.trigger_time_minutes) : null,
        deadline_minutes: deadlineByKey.get(key) ?? null,
      });
    }

    manifestCache.set(scenarioId, { manifest, fetchedAt: Date.now() });
    return manifest;
  } catch (err) {
    logger.error({ err, scenarioId }, 'Failed to derive intel manifest');
    return [];
  }
}

/** Count distinct detection keywords present in the text (case-insensitive). */
function keywordHits(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) hits++;
  }
  return hits;
}

function contentMatchesIntel(text: string, entry: IntelManifestEntry): boolean {
  if (entry.detection_keywords.length === 0) return false;
  const required = Math.min(2, entry.detection_keywords.length);
  return keywordHits(text, entry.detection_keywords) >= required;
}

async function getSharedIntelKeys(sessionId: string): Promise<Set<string>> {
  const { data } = await supabaseAdmin
    .from('player_actions')
    .select('metadata')
    .eq('session_id', sessionId)
    .eq('action_type', 'intel_shared');
  const keys = new Set<string>();
  for (const row of data || []) {
    const key = (row.metadata as Record<string, unknown> | null)?.intel_key;
    if (typeof key === 'string' && key) keys.add(key);
  }
  return keys;
}

/**
 * Deterministic detection: a player forwarded an intel email. Called from
 * POST /emails when forwarded_email_id is present and player recipients were
 * resolved. Records intel_shared when a recipient belongs to a needed team.
 */
export async function recordIntelShareFromForward(
  sessionId: string,
  userId: string,
  forwardedEmailId: string,
  playerRecipients: PlayerDirectoryEntry[],
  newEmailId: string,
): Promise<void> {
  const { data: original } = await supabaseAdmin
    .from('sim_emails')
    .select('inject_id, session_id')
    .eq('id', forwardedEmailId)
    .single();
  if (!original?.inject_id || original.session_id !== sessionId) return;

  const { data: inject } = await supabaseAdmin
    .from('scenario_injects')
    .select('delivery_config')
    .eq('id', original.inject_id)
    .single();
  const dc = (inject?.delivery_config || {}) as Record<string, unknown>;
  const intelKey = typeof dc.intel_key === 'string' ? dc.intel_key : '';
  if (!intelKey) return;

  const neededBy = Array.isArray(dc.intel_needed_by)
    ? (dc.intel_needed_by as unknown[]).map(String)
    : [];
  const reachedTeams = playerRecipients
    .map((p) => p.team_name)
    .filter((t): t is string => !!t && neededBy.includes(t));
  if (reachedTeams.length === 0) return;

  const alreadyShared = await getSharedIntelKeys(sessionId);
  if (alreadyShared.has(intelKey)) return;

  await recordPlayerAction(sessionId, userId, 'intel_shared', newEmailId, null, {
    intel_key: intelKey,
    to_teams: Array.from(new Set(reachedTeams)),
    via: 'email_forward',
    forwarded_email_id: forwardedEmailId,
  });
  logger.info(
    { sessionId, userId, intelKey, reachedTeams },
    'Cross-team intel shared via email forward',
  );
}

/**
 * Keyword-fingerprint detection over free-text channels. Runs each social
 * state tick; cheap (no AI). Sources:
 *  - player-to-player emails: email_sent actions whose metadata carries
 *    recipient_teams (set by POST /emails) intersecting the needed teams;
 *  - the shared group chat: chat_messages from non-trainer senders (the
 *    channel is visible to every team, so a match reaches the needed team).
 * DMs and sim-group posts are deliberately out of scope for v1.
 *
 * Returns the full set of shared intel keys after detection.
 */
export async function detectIntelSharing(
  sessionId: string,
  scenarioId: string,
  actions: Array<{
    action_type: string;
    content: string | null;
    metadata: Record<string, unknown> | null;
    player_id?: string | null;
    created_at?: string;
  }>,
): Promise<string[]> {
  const manifest = await getIntelManifest(scenarioId);
  if (manifest.length === 0) return [];

  const alreadyShared = await getSharedIntelKeys(sessionId);
  const pending = manifest.filter((m) => !alreadyShared.has(m.intel_key));
  if (pending.length === 0) return Array.from(alreadyShared);

  const emailActions = actions.filter((a) => a.action_type === 'email_sent' && a.content);

  let chatMessages: Array<{ sender_id: string; content: string }> = [];
  let trainerId: string | null = null;
  try {
    const [{ data: session }, { data: chats }] = await Promise.all([
      supabaseAdmin.from('sessions').select('trainer_id').eq('id', sessionId).single(),
      supabaseAdmin
        .from('chat_messages')
        .select('sender_id, content')
        .eq('session_id', sessionId)
        .eq('type', 'text')
        .order('created_at', { ascending: true })
        .limit(500),
    ]);
    trainerId = (session?.trainer_id as string) || null;
    chatMessages = (chats || []) as Array<{ sender_id: string; content: string }>;
  } catch {
    /* chat scan is best-effort */
  }

  for (const entry of pending) {
    // (a) Player-to-player email whose recipients include a needed team.
    for (const action of emailActions) {
      const meta = action.metadata || {};
      const recipientTeams = Array.isArray(meta.recipient_teams)
        ? (meta.recipient_teams as unknown[]).map(String)
        : [];
      const reached = recipientTeams.filter((t) => entry.needed_by.includes(t));
      if (reached.length === 0) continue;
      if (!contentMatchesIntel(String(action.content), entry)) continue;

      await recordIntelShare(sessionId, action.player_id || null, entry, reached, 'email_content');
      alreadyShared.add(entry.intel_key);
      break;
    }
    if (alreadyShared.has(entry.intel_key)) continue;

    // (b) Shared group chat: visible to all teams, so a keyword match counts.
    for (const msg of chatMessages) {
      if (trainerId && msg.sender_id === trainerId) continue;
      if (!contentMatchesIntel(String(msg.content || ''), entry)) continue;
      await recordIntelShare(sessionId, msg.sender_id, entry, entry.needed_by, 'group_chat');
      alreadyShared.add(entry.intel_key);
      break;
    }
  }

  return Array.from(alreadyShared);
}

async function recordIntelShare(
  sessionId: string,
  sharerId: string | null,
  entry: IntelManifestEntry,
  reachedTeams: string[],
  via: string,
): Promise<void> {
  if (!sharerId) return;

  await recordPlayerAction(sessionId, sharerId, 'intel_shared', entry.source_inject_id, null, {
    intel_key: entry.intel_key,
    to_teams: Array.from(new Set(reachedTeams)),
    via,
  });
  logger.info(
    { sessionId, sharerId, intelKey: entry.intel_key, via },
    'Cross-team intel shared (content match)',
  );
}

export interface IntelStatusEntry extends IntelManifestEntry {
  shared: boolean;
  shared_at_minutes: number | null;
  shared_by_team: string | null;
  shared_via: string | null;
  deadline_missed: boolean;
}

/** Trainer-facing status: every intel item with its live shared/missed state. */
export async function getIntelStatus(
  sessionId: string,
  elapsedMinutes?: number,
): Promise<IntelStatusEntry[]> {
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id, start_time')
    .eq('id', sessionId)
    .single();
  if (!session?.scenario_id) return [];

  const manifest = await getIntelManifest(session.scenario_id as string);
  if (manifest.length === 0) return [];

  const startMs = session.start_time ? new Date(session.start_time as string).getTime() : null;
  const elapsed =
    elapsedMinutes ?? (startMs != null ? Math.floor((Date.now() - startMs) / 60000) : 0);

  const { data: shareActions } = await supabaseAdmin
    .from('player_actions')
    .select('metadata, team_at_action, created_at')
    .eq('session_id', sessionId)
    .eq('action_type', 'intel_shared')
    .order('created_at', { ascending: true });

  const shareByKey = new Map<
    string,
    { at_minutes: number | null; team: string | null; via: string | null }
  >();
  for (const row of shareActions || []) {
    const meta = (row.metadata || {}) as Record<string, unknown>;
    const key = typeof meta.intel_key === 'string' ? meta.intel_key : '';
    if (!key || shareByKey.has(key)) continue;
    shareByKey.set(key, {
      at_minutes:
        startMs != null && row.created_at
          ? Math.max(
              0,
              Math.round((new Date(row.created_at as string).getTime() - startMs) / 60000),
            )
          : null,
      team: (row.team_at_action as string) || null,
      via: typeof meta.via === 'string' ? meta.via : null,
    });
  }

  return manifest.map((entry) => {
    const share = shareByKey.get(entry.intel_key);
    return {
      ...entry,
      shared: !!share,
      shared_at_minutes: share?.at_minutes ?? null,
      shared_by_team: share?.team ?? null,
      shared_via: share?.via ?? null,
      deadline_missed:
        !share && entry.deadline_minutes != null && elapsed >= entry.deadline_minutes,
    };
  });
}
