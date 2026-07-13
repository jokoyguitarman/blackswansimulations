import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';

/**
 * Per-player "AI judgement ledger" for a social-media crisis session.
 *
 * Aggregates every player-authored artifact (posts, replies, emails, DMs) and
 * discrete action, attaches the AI judgement that already lives alongside it
 * (the full ContentGrade in sop_compliance_score, or the dispute verdict), and
 * groups everything by player. The sentiment trajectory + consequence markers
 * are returned alongside so the trainer dashboard can approximately correlate an
 * action to the score/sentiment movement that followed it.
 *
 * Works for both live and completed sessions (everything is read from
 * persisted rows; no status gate).
 */

export type LedgerEntryKind = 'post' | 'reply' | 'email' | 'dm' | 'action';

export interface LedgerEntry {
  id: string;
  kind: LedgerEntryKind;
  timestamp: string;
  content: string;
  /** Full ContentGrade JSON when the artifact was AI-graded, else null. */
  grade: Record<string, unknown> | null;
  action_type?: string;
  target_id?: string | null;
  metadata?: Record<string, unknown> | null;
  sop_step?: string | null;
  /** Dispute adjudication verdict, when this entry is a content dispute. */
  dispute?: {
    status: string;
    verdict_reason: string | null;
    ai_confidence: number | null;
  } | null;
  /** Post sentiment label (for player posts), when present. */
  sentiment?: string | null;
}

export interface LedgerPlayer {
  player_id: string;
  display_name: string;
  /** Fixed-team membership (Communications/Procurement/Sales/Legal) or null when unassigned. */
  team_name: string | null;
  entries: LedgerEntry[];
}

export interface PlayerLedger {
  players: LedgerPlayer[];
  sentiment_trajectory: Array<{ recorded_at: string; sentiment_score: number }>;
  consequences: Array<{
    id: string;
    created_at: string;
    description: string;
    is_positive: boolean;
  }>;
}

// Action types already represented as their own content entries (post/reply/
// email/dm) or that are too noisy to surface; skip to avoid duplication.
const SKIP_ACTION_TYPES = new Set([
  'dm_sent',
  'post_created',
  'reply_posted',
  'email_sent',
  'content_graded',
  'dispute_filed',
  'dispute_upheld',
  'dispute_rejected',
]);

export async function buildPlayerLedger(sessionId: string): Promise<PlayerLedger> {
  const [postsRes, emailsRes, dmsRes, actionsRes, disputesRes, snapsRes, consRes, teamsRes] =
    await Promise.all([
      supabaseAdmin
        .from('social_posts')
        .select(
          'id, posted_by_user_id, author_display_name, content, sop_compliance_score, sentiment, reply_to_post_id, created_at',
        )
        .eq('session_id', sessionId)
        .eq('author_type', 'player'),
      supabaseAdmin
        .from('sim_emails')
        .select('id, sent_by_player_id, subject, body_text, sop_compliance_score, created_at')
        .eq('session_id', sessionId)
        .not('sent_by_player_id', 'is', null),
      supabaseAdmin
        .from('sim_direct_messages')
        .select('id, sender_handle, sender_display_name, content, created_at')
        .eq('session_id', sessionId)
        .eq('sender_type', 'player'),
      supabaseAdmin
        .from('player_actions')
        .select(
          'id, player_id, action_type, target_id, content, metadata, sop_step_matched, created_at',
        )
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true }),
      supabaseAdmin
        .from('content_dispute_requests')
        .select('id, requested_by, target_id, status, verdict_reason, ai_confidence, created_at')
        .eq('session_id', sessionId),
      supabaseAdmin
        .from('sentiment_snapshots')
        .select('recorded_at, sentiment_score')
        .eq('session_id', sessionId)
        .order('recorded_at', { ascending: true }),
      supabaseAdmin
        .from('session_events')
        .select('id, description, metadata, created_at')
        .eq('session_id', sessionId)
        .eq('event_type', 'consequence_inject')
        .order('created_at', { ascending: true }),
      supabaseAdmin
        .from('session_teams')
        .select('user_id, team_name, assigned_at')
        .eq('session_id', sessionId)
        .order('assigned_at', { ascending: true }),
    ]);

  const posts = postsRes.data || [];
  const emails = emailsRes.data || [];
  const dms = dmsRes.data || [];
  const actions = actionsRes.data || [];
  const disputes = disputesRes.data || [];
  const snaps = snapsRes.data || [];
  const consEvents = consRes.data || [];

  // Player -> team (earliest assignment wins if legacy multi-team rows exist).
  const teamByPlayer = new Map<string, string>();
  for (const t of teamsRes.data || []) {
    const pid = String(t.user_id);
    if (!teamByPlayer.has(pid)) teamByPlayer.set(pid, String(t.team_name));
  }

  // DM attribution: message id -> player id, via the dm_sent player_action.
  const dmAttribution = new Map<string, string>();
  for (const a of actions) {
    if (a.action_type === 'dm_sent' && a.target_id) {
      dmAttribution.set(String(a.target_id), String(a.player_id));
    }
  }

  // Collect every player id that authored something (plus team-assigned
  // players with no activity yet, so the trainer sees the full roster), then
  // resolve names.
  const playerIds = new Set<string>();
  for (const p of posts) if (p.posted_by_user_id) playerIds.add(String(p.posted_by_user_id));
  for (const e of emails) if (e.sent_by_player_id) playerIds.add(String(e.sent_by_player_id));
  for (const a of actions) if (a.player_id) playerIds.add(String(a.player_id));
  for (const d of disputes) if (d.requested_by) playerIds.add(String(d.requested_by));
  for (const d of dms) {
    const pid = dmAttribution.get(String(d.id));
    if (pid) playerIds.add(pid);
  }
  for (const pid of teamByPlayer.keys()) playerIds.add(pid);

  const nameById = new Map<string, string>();
  if (playerIds.size > 0) {
    const { data: profiles } = await supabaseAdmin
      .from('user_profiles')
      .select('id, full_name')
      .in('id', Array.from(playerIds));
    for (const pr of profiles || []) {
      nameById.set(String(pr.id), String(pr.full_name || 'Unknown'));
    }
  }

  const byPlayer = new Map<string, LedgerEntry[]>();
  for (const pid of teamByPlayer.keys()) byPlayer.set(pid, []);
  const push = (pid: string, entry: LedgerEntry) => {
    const list = byPlayer.get(pid);
    if (list) list.push(entry);
    else byPlayer.set(pid, [entry]);
  };

  for (const p of posts) {
    if (!p.posted_by_user_id) continue;
    push(String(p.posted_by_user_id), {
      id: String(p.id),
      kind: p.reply_to_post_id ? 'reply' : 'post',
      timestamp: String(p.created_at),
      content: String(p.content || ''),
      grade: (p.sop_compliance_score as Record<string, unknown>) || null,
      sentiment: p.sentiment ? String(p.sentiment) : null,
    });
  }

  for (const e of emails) {
    if (!e.sent_by_player_id) continue;
    const subject = e.subject ? `Subject: ${e.subject}\n\n` : '';
    push(String(e.sent_by_player_id), {
      id: String(e.id),
      kind: 'email',
      timestamp: String(e.created_at),
      content: subject + String(e.body_text || ''),
      grade: (e.sop_compliance_score as Record<string, unknown>) || null,
    });
  }

  for (const d of dms) {
    const pid = dmAttribution.get(String(d.id));
    if (!pid) continue;
    push(pid, {
      id: String(d.id),
      kind: 'dm',
      timestamp: String(d.created_at),
      content: String(d.content || ''),
      grade: null,
    });
  }

  for (const a of actions) {
    if (SKIP_ACTION_TYPES.has(String(a.action_type))) continue;
    push(String(a.player_id), {
      id: String(a.id),
      kind: 'action',
      timestamp: String(a.created_at),
      content: String(a.content || ''),
      grade: null,
      action_type: String(a.action_type),
      target_id: a.target_id ? String(a.target_id) : null,
      metadata: (a.metadata as Record<string, unknown>) || null,
      sop_step: a.sop_step_matched ? String(a.sop_step_matched) : null,
    });
  }

  // Disputes carry their own AI verdict; surface them with the reasoning.
  for (const d of disputes) {
    if (!d.requested_by) continue;
    push(String(d.requested_by), {
      id: `dispute-${d.id}`,
      kind: 'action',
      timestamp: String(d.created_at),
      content: '',
      grade: null,
      action_type: 'dispute_filed',
      target_id: d.target_id ? String(d.target_id) : null,
      dispute: {
        status: String(d.status),
        verdict_reason: d.verdict_reason ? String(d.verdict_reason) : null,
        ai_confidence: d.ai_confidence != null ? Number(d.ai_confidence) : null,
      },
    });
  }

  const players: LedgerPlayer[] = Array.from(byPlayer.entries())
    .map(([pid, entries]) => ({
      player_id: pid,
      display_name: nameById.get(pid) || 'Unknown',
      team_name: teamByPlayer.get(pid) || null,
      entries: entries.sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      ),
    }))
    .sort((a, b) => a.display_name.localeCompare(b.display_name));

  const consequences = consEvents.map((c) => ({
    id: String(c.id),
    created_at: String(c.created_at),
    description: String((c as Record<string, unknown>).description || ''),
    is_positive: !!(c.metadata as Record<string, unknown>)?.is_positive,
  }));

  logger.info(
    { sessionId, players: players.length, snapshots: snaps.length },
    'Built player judgement ledger',
  );

  return {
    players,
    sentiment_trajectory: snaps.map((s) => ({
      recorded_at: String(s.recorded_at),
      sentiment_score: Number(s.sentiment_score),
    })),
    consequences,
  };
}
