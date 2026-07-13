import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';

/**
 * Fixed team catalog for the social media crisis module.
 *
 * The four team names are a closed set: every downstream consumer (assignment,
 * routing, grading, scoring, dashboards) validates against this catalog or the
 * scenario's persisted scenario_teams rows. Charters are copied onto
 * scenario_teams at compile time so trainers can tweak wording per scenario
 * without code changes; the catalog entries below are the canonical defaults.
 */

export const FIXED_TEAM_NAMES = ['Communications', 'Procurement', 'Sales', 'Legal'] as const;

export type FixedTeamName = (typeof FIXED_TEAM_NAMES)[number];

export interface TeamExpectedAction {
  action_id: string;
  description: string;
  /** Must match a player_actions.action_type value. */
  detection_action_type: string;
  /** Optional loose match against player_actions.metadata (all keys must match). */
  detection_hints?: Record<string, unknown>;
  timing_benchmark_minutes: number | null;
  /** Relative contribution to the team's task-completion score. */
  weight: number;
  tier: 1 | 2 | 3;
}

export interface TeamCharter {
  team_name: FixedTeamName;
  mission: string;
  responsibilities: string[];
  expected_actions: TeamExpectedAction[];
  scoring_rubric: string;
  out_of_lane: string[];
  min_participants: number;
  max_participants: number;
}

export const TEAM_CATALOG: Record<FixedTeamName, TeamCharter> = {
  Communications: {
    team_name: 'Communications',
    mission:
      'Own all public-facing communication for the organisation. You speak for the organisation on social media and to the press.',
    responsibilities: [
      'Monitor the social feed and flag misinformation early',
      'Draft and publish the official statement addressing the crisis',
      'Respond to press and media inquiries arriving by email',
      'Counter harmful narratives on the feed with verified facts',
      'Keep all public messaging consistent, calm, and factual',
    ],
    expected_actions: [
      {
        action_id: 'comms_monitor_flag',
        description: 'Flag harmful or misleading posts on the feed',
        detection_action_type: 'post_flagged',
        timing_benchmark_minutes: 10,
        weight: 15,
        tier: 1,
      },
      {
        action_id: 'comms_flag_misinfo',
        description: 'Identify and flag misinformation specifically',
        detection_action_type: 'misinfo_flagged',
        timing_benchmark_minutes: 15,
        weight: 15,
        tier: 1,
      },
      {
        action_id: 'comms_official_statement',
        description: 'Publish an official statement addressing the crisis',
        detection_action_type: 'post_created',
        detection_hints: { post_format: 'official_statement' },
        timing_benchmark_minutes: 30,
        weight: 35,
        tier: 2,
      },
      {
        action_id: 'comms_press_response',
        description: 'Respond to press inquiries by email',
        detection_action_type: 'email_sent',
        timing_benchmark_minutes: 25,
        weight: 20,
        tier: 2,
      },
      {
        action_id: 'comms_counter_narrative',
        description: 'Reply publicly to harmful narratives with verified facts',
        detection_action_type: 'reply_posted',
        timing_benchmark_minutes: 20,
        weight: 15,
        tier: 2,
      },
    ],
    scoring_rubric:
      'Judge as public-facing crisis communication: empathetic, authoritative tone; only verified facts; no amplification of harmful content; clear calls to action; timeliness of the official response. Penalise defensiveness, speculation, and quoting harmful claims verbatim.',
    out_of_lane: [
      'Making legal commitments or admissions — route to Legal for review first',
      'Promising specific remedies to individual customers — that is Sales territory',
      'Negotiating with suppliers — hand to Procurement',
    ],
    min_participants: 1,
    max_participants: 4,
  },
  Procurement: {
    team_name: 'Procurement',
    mission:
      'Manage the organisation\u2019s suppliers and supply chain. You keep operations factual and stop supplier panic from feeding the crisis.',
    responsibilities: [
      'Respond to supplier emails and pressure during the crisis',
      'Verify supply-chain related claims against the confirmed fact sheet',
      'Feed verified operational facts to Communications for public use',
      'Plan continuity: alternatives, timelines, and mitigations',
      'Stay out of public channels — you do not post publicly',
    ],
    expected_actions: [
      {
        action_id: 'proc_supplier_response',
        description: 'Respond to supplier and partner emails',
        detection_action_type: 'email_sent',
        timing_benchmark_minutes: 20,
        weight: 35,
        tier: 2,
      },
      {
        action_id: 'proc_read_intel',
        description: 'Read incoming operational and supplier emails promptly',
        detection_action_type: 'email_read',
        timing_benchmark_minutes: 10,
        weight: 15,
        tier: 1,
      },
      {
        action_id: 'proc_fact_check',
        description: 'Verify supply-chain claims against confirmed facts',
        detection_action_type: 'fact_checked',
        timing_benchmark_minutes: 25,
        weight: 25,
        tier: 2,
      },
      {
        action_id: 'proc_escalate',
        description: 'Escalate verified operational impacts to the wider team',
        detection_action_type: 'chat_message_sent',
        timing_benchmark_minutes: 30,
        weight: 25,
        tier: 3,
      },
    ],
    scoring_rubric:
      'Judge as supplier/partner communication: clarity, factual precision, continuity planning, and calm professionalism under pressure. Reward realistic commitments and verified timelines. Penalise public-facing posting, over-promising to suppliers, and unverified operational claims.',
    out_of_lane: [
      'Posting on public social media — escalate facts to Communications instead',
      'Legal interpretation of contracts — route to Legal',
      'Direct customer promises — that is Sales territory',
    ],
    min_participants: 1,
    max_participants: 3,
  },
  Sales: {
    team_name: 'Sales',
    mission:
      'Manage customer expectations directly. You are the human face of the organisation to worried customers, one conversation at a time.',
    responsibilities: [
      'Reply to customer direct messages and comments',
      'Set honest expectations without over-promising',
      'Stay consistent with the official line from Communications',
      'Escalate complaints with legal risk to Legal',
      'De-escalate angry customers with empathy and facts',
    ],
    expected_actions: [
      {
        action_id: 'sales_dm_response',
        description: 'Respond to customer direct messages',
        detection_action_type: 'dm_sent',
        timing_benchmark_minutes: 15,
        weight: 30,
        tier: 1,
      },
      {
        action_id: 'sales_comment_response',
        description: 'Reply to customer comments and complaints on the feed',
        detection_action_type: 'reply_posted',
        timing_benchmark_minutes: 20,
        weight: 30,
        tier: 2,
      },
      {
        action_id: 'sales_customer_email',
        description: 'Answer customer emails',
        detection_action_type: 'email_sent',
        timing_benchmark_minutes: 25,
        weight: 20,
        tier: 2,
      },
      {
        action_id: 'sales_escalate',
        description: 'Escalate legal-risk complaints to the wider team',
        detection_action_type: 'chat_message_sent',
        timing_benchmark_minutes: 30,
        weight: 20,
        tier: 3,
      },
    ],
    scoring_rubric:
      'Judge as direct customer communication: empathy first, honest expectation-setting, consistency with the official organisational line, and de-escalation skill. Penalise over-promising (refunds, timelines, guarantees not confirmed in the fact sheet), dismissiveness, and contradicting official messaging.',
    out_of_lane: [
      'Publishing official statements — that is Communications territory',
      'Admitting fault or liability — route to Legal first',
      'Committing to supply/delivery dates without Procurement confirmation',
    ],
    min_participants: 1,
    max_participants: 3,
  },
  Legal: {
    team_name: 'Legal',
    mission:
      'You are the organisation\u2019s legal counsel. You protect the organisation from legal exposure while the crisis unfolds.',
    responsibilities: [
      'Review public drafts before anything is published',
      'Respond to regulator and legal-threat emails',
      'File fact-based disputes and takedown requests on provably false content',
      'Flag any public messaging that admits liability',
      'Advise the other teams on legal risk in their channels',
    ],
    expected_actions: [
      {
        action_id: 'legal_regulator_response',
        description: 'Respond to regulator and legal-threat emails',
        detection_action_type: 'email_sent',
        timing_benchmark_minutes: 25,
        weight: 30,
        tier: 2,
      },
      {
        action_id: 'legal_dispute',
        description: 'File a fact-based dispute or takedown on provably false content',
        detection_action_type: 'dispute_filed',
        timing_benchmark_minutes: 35,
        weight: 30,
        tier: 3,
      },
      {
        action_id: 'legal_fact_check',
        description: 'Verify claims against the confirmed fact sheet before advising',
        detection_action_type: 'fact_checked',
        timing_benchmark_minutes: 20,
        weight: 15,
        tier: 1,
      },
      {
        action_id: 'legal_review_advice',
        description: 'Advise the team on drafts and legal risk',
        detection_action_type: 'chat_message_sent',
        timing_benchmark_minutes: 30,
        weight: 25,
        tier: 2,
      },
    ],
    scoring_rubric:
      'Judge as legal counsel output: legal accuracy, precise risk flagging, protection of the organisation, and factual discipline. Reward identifying admissions of liability and defamation risks. Heavily penalise making public commitments, admissions of fault, or legal conclusions not supported by confirmed facts.',
    out_of_lane: [
      'Publishing public statements yourself — approve them, then Communications publishes',
      'Making customer service promises — that is Sales territory',
      'Operational supplier decisions — that is Procurement territory',
    ],
    min_participants: 1,
    max_participants: 2,
  },
};

export function isKnownTeam(name: string): name is FixedTeamName {
  return (FIXED_TEAM_NAMES as readonly string[]).includes(name);
}

export function getCatalogCharter(name: string): TeamCharter | null {
  return isKnownTeam(name) ? TEAM_CATALOG[name] : null;
}

/** TeamDef-compatible shape consumed by assemblePayload / persistence. */
export function buildFixedTeamDefs(): Array<{
  team_name: string;
  team_description: string;
  min_participants: number;
  max_participants: number;
}> {
  return FIXED_TEAM_NAMES.map((name) => {
    const c = TEAM_CATALOG[name];
    return {
      team_name: c.team_name,
      team_description: c.mission,
      min_participants: c.min_participants,
      max_participants: c.max_participants,
    };
  });
}

/**
 * Derive StrategicActionBenchmark-shaped entries from team charters so the
 * existing AAR doctrine-compliance section keeps working with fixed teams.
 */
export function benchmarksFromCharters(charters: TeamCharter[]): Array<{
  action_id: string;
  description: string;
  tier: 1 | 2 | 3;
  team: string;
  doctrine_source: string;
  detection_action_type: string;
  timing_benchmark_minutes: number | null;
  sentiment_dimension: string;
  impact_if_done: number;
  impact_if_missed: number;
  consequence_if_done: string;
  consequence_if_missed: string;
}> {
  const dimensionByTeam: Record<string, string> = {
    Communications: 'narrative_control',
    Procurement: 'community_safety',
    Sales: 'public_trust',
    Legal: 'escalation_risk',
  };

  return charters.flatMap((charter) =>
    charter.expected_actions.map((action) => ({
      action_id: action.action_id,
      description: action.description,
      tier: action.tier,
      team: charter.team_name,
      doctrine_source: 'Team charter',
      detection_action_type: action.detection_action_type,
      timing_benchmark_minutes: action.timing_benchmark_minutes,
      sentiment_dimension: dimensionByTeam[charter.team_name] || 'public_trust',
      impact_if_done: action.tier + 2,
      impact_if_missed: -(action.tier + 1),
      consequence_if_done: `${charter.team_name} fulfilled: ${action.description}`,
      consequence_if_missed: `${charter.team_name} missed: ${action.description}`,
    })),
  );
}

// ─── Runtime resolution ──────────────────────────────────────────────────────

export interface TeamContext {
  team_name: string;
  /** Null when the team has no charter (legacy/unknown team) — callers fall back to generic behaviour. */
  charter: {
    mission: string;
    responsibilities: string[];
    scoring_rubric: string;
    out_of_lane: string[];
    expected_actions: TeamExpectedAction[];
  } | null;
}

/**
 * Resolve a player's team and charter for a session.
 *
 * Returns null (never throws) when the player is unassigned or the session has
 * no scenario. Every caller must treat null as "behave exactly as before the
 * teams feature existed" (generic grading, universal content only).
 *
 * Legacy multi-team rows resolve deterministically to the earliest assignment.
 */
export async function getPlayerTeamContext(
  sessionId: string,
  userId: string,
): Promise<TeamContext | null> {
  try {
    const { data: rows } = await supabaseAdmin
      .from('session_teams')
      .select('team_name, assigned_at')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .order('assigned_at', { ascending: true });

    if (!rows || rows.length === 0) return null;

    if (rows.length > 1) {
      logger.warn(
        { sessionId, userId, teams: rows.map((r) => r.team_name) },
        'Player has multiple team assignments; using earliest (legacy data)',
      );
    }

    const teamName = rows[0].team_name as string;

    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id')
      .eq('id', sessionId)
      .single();

    if (!session?.scenario_id) return { team_name: teamName, charter: null };

    const { data: teamRow } = await supabaseAdmin
      .from('scenario_teams')
      .select('team_name, team_description, charter, expected_actions, scoring_rubric')
      .eq('scenario_id', session.scenario_id)
      .eq('team_name', teamName)
      .maybeSingle();

    if (!teamRow) {
      logger.warn(
        { sessionId, userId, teamName },
        'Assigned team not found in scenario_teams; falling back to generic behaviour',
      );
      return { team_name: teamName, charter: null };
    }

    const charterJson = (teamRow.charter || {}) as Record<string, unknown>;
    const catalogFallback = getCatalogCharter(teamName);

    const mission =
      (charterJson.mission as string) ||
      (teamRow.team_description as string) ||
      catalogFallback?.mission ||
      '';
    const scoringRubric =
      (teamRow.scoring_rubric as string) || catalogFallback?.scoring_rubric || '';

    if (!mission && !scoringRubric) {
      return { team_name: teamName, charter: null };
    }

    return {
      team_name: teamName,
      charter: {
        mission,
        responsibilities:
          (charterJson.responsibilities as string[]) || catalogFallback?.responsibilities || [],
        scoring_rubric: scoringRubric,
        out_of_lane: (charterJson.out_of_lane as string[]) || catalogFallback?.out_of_lane || [],
        expected_actions:
          (teamRow.expected_actions as TeamExpectedAction[]) ||
          catalogFallback?.expected_actions ||
          [],
      },
    };
  } catch (err) {
    logger.error({ err, sessionId, userId }, 'getPlayerTeamContext failed; returning null');
    return null;
  }
}

// Short-lived cache for per-action team stamping (recordPlayerAction runs on
// every player action; membership changes rarely). Invalidated on assignment.
const teamNameCache = new Map<string, { value: string | null; expires: number }>();
const TEAM_CACHE_TTL_MS = 60_000;

/**
 * Cached lookup of a player's team name (null when unassigned). Used to stamp
 * player_actions.team_at_action. Never throws.
 */
export async function getPlayerTeamName(sessionId: string, userId: string): Promise<string | null> {
  const key = `${sessionId}:${userId}`;
  const cached = teamNameCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;

  let value: string | null = null;
  try {
    const { data: rows } = await supabaseAdmin
      .from('session_teams')
      .select('team_name, assigned_at')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .order('assigned_at', { ascending: true })
      .limit(1);
    value = rows && rows.length > 0 ? (rows[0].team_name as string) : null;
  } catch (err) {
    logger.error({ err, sessionId, userId }, 'getPlayerTeamName failed');
  }

  teamNameCache.set(key, { value, expires: Date.now() + TEAM_CACHE_TTL_MS });
  return value;
}

/** Invalidate the cached team for a player (call after assignment changes). */
export function invalidatePlayerTeamCache(sessionId: string, userId: string): void {
  teamNameCache.delete(`${sessionId}:${userId}`);
}

/** Resolve the user ids of all members of the given teams in a session. */
export async function resolveTeamMembers(
  sessionId: string,
  teamNames: string[],
): Promise<string[]> {
  if (!teamNames || teamNames.length === 0) return [];
  try {
    const { data: rows } = await supabaseAdmin
      .from('session_teams')
      .select('user_id')
      .eq('session_id', sessionId)
      .in('team_name', teamNames);
    return Array.from(new Set((rows || []).map((r) => r.user_id as string)));
  } catch (err) {
    logger.error({ err, sessionId, teamNames }, 'resolveTeamMembers failed');
    return [];
  }
}
