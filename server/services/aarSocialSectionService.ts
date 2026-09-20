import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { buildSocialMediaAARData } from './aarSocialMediaService.js';
import { buildPlayerLedger } from './playerLedgerService.js';
import { getIntelStatus, type IntelStatusEntry } from './intelSharingService.js';
import type { SectionEntry } from './aarSectionService.js';
import { resolveTeamFunction } from '../lib/stakeholderContract.js';

/**
 * Social-crisis section-based AAR (mirrors aarSectionService for field-ops).
 *
 * buildSocialSectionsData assembles one deterministic, token-capped payload
 * per section from the session's full record (graded artifacts, player
 * ledger, intel-sharing outcomes, watchdog scans, sentiment snapshots,
 * consequence events). generateSocialAarReport then makes ONE dedicated AI
 * call per section — the multi-call architecture that guarantees every team
 * and every artifact is actually analysed — persisting after each call so the
 * frontend can reveal sections progressively.
 */

export const SOCIAL_AAR_SECTION_KEYS = [
  'social_executive',
  'social_timeline',
  'social_public_comms',
  'social_team_executive',
  'social_team_communications',
  'social_team_shareholder',
  'social_team_stakeholder',
  'social_team_legal',
  // retired presets — only emitted for scenarios compiled before Sep 2026
  'social_team_procurement',
  'social_team_sales',
  'social_team_other',
  'social_information_flow',
  'social_misinformation',
  'social_sentiment',
  'social_crisis_standards',
  'social_player_performance',
  'social_recommendations',
] as const;

export type SocialAARSectionKey = (typeof SOCIAL_AAR_SECTION_KEYS)[number];

export type SocialSectionsMap = Partial<Record<SocialAARSectionKey, SectionEntry>>;

export const SOCIAL_SECTION_LABELS: Record<SocialAARSectionKey, string> = {
  social_executive: 'Executive summary',
  social_timeline: 'Crisis timeline reconstruction',
  social_public_comms: 'Public communications review',
  social_team_executive: 'Team deep-dive: Executive',
  social_team_communications: 'Team deep-dive: Communications',
  social_team_shareholder: 'Team deep-dive: Shareholder Engagement',
  social_team_stakeholder: 'Team deep-dive: Stakeholder Engagement',
  social_team_legal: 'Team deep-dive: Legal',
  social_team_procurement: 'Team deep-dive: Procurement',
  social_team_sales: 'Team deep-dive: Sales',
  social_team_other: 'Team deep-dive: other teams',
  social_information_flow: 'Cross-team information flow',
  social_misinformation: 'Misinformation and moderation',
  social_sentiment: 'Sentiment journey and turning points',
  social_crisis_standards: 'Crisis communication standards',
  social_player_performance: 'Individual player performance',
  social_recommendations: 'Key takeaways and recommendations',
};

/**
 * Team deep-dive sections are keyed by team FUNCTION (contract §5.2). The four catalog functions
 * and Executive get their own section; every other function lands in `social_team_other`.
 * Several teams sharing a section (multi-org, or several custom teams) become one block each.
 */
const TEAM_SECTION_BY_FUNCTION: Record<string, SocialAARSectionKey> = {
  Executive: 'social_team_executive',
  Communications: 'social_team_communications',
  'Shareholder Engagement': 'social_team_shareholder',
  'Stakeholder Engagement': 'social_team_stakeholder',
  Legal: 'social_team_legal',
  // retired presets keep their own sections so legacy scenarios review unchanged
  Procurement: 'social_team_procurement',
  Sales: 'social_team_sales',
};

function teamSectionFor(teamFunction: string): SocialAARSectionKey {
  return TEAM_SECTION_BY_FUNCTION[teamFunction] ?? 'social_team_other';
}

const SOCIAL_SECTION_INSTRUCTIONS: Record<SocialAARSectionKey, string> = {
  social_executive:
    'Write the executive verdict of this social-media crisis exercise: how the crisis unfolded, whether the response succeeded, and the single most important lesson. Reference the final outcome dimensions by their scenario-specific labels, the team composite scores, and the intel-sharing outcome. If stakeholder_preemption is non-empty, credit the teams that reached stakeholders before those stakeholders acted (name the stakeholder and what was withdrawn or revised, with T+ minutes). If executive_decisions is non-empty, name each leadership decision (T+), who was told and who found out on their own, and whether the organisation communicated it in the right order before it leaked — this is usually the decisive lesson. If organisations is non-empty (several organisations took part), compare them briefly by avg_composite and name the strongest and weakest organisation with the team that drove each. End with a one-sentence overall verdict.',
  social_timeline:
    'Reconstruct the session chronologically in phases (opening, escalation, turning point, resolution). Pair each pressure beat (inject, watchdog challenge, consequence) with the team response that followed — or note the silence. Cite T+ minutes throughout. Identify the single most consequential moment.',
  social_public_comms:
    'Assess every published statement and reply: quality (use the stored grade dimensions), timing, consistency across platforms, and reach versus hostile content (impression dominance). Quote the strongest and weakest artifacts with their scores. Judge whether format choices (statement, thread reply, creative) matched the moment.',
  social_team_executive:
    "This is the dedicated review of the EXECUTIVE team (leadership). Executives do not pick decisions from a menu; they decide by communicating — emails, chat messages, calls and statements in the ledger. Read those artifacts and messages as their decisions: what was decided, when (T+), to whom it was communicated, with what scope and rationale. If executive_decisions is non-empty, it is the detected record of those decisions: for each, judge HOW it was communicated — who was told directly (informed), who should have known but was not told (should_know_not_told), who found out by rumour or from the press (found_out, with via and T+), whether a formal notice went out in the right order (representatives before employees) and before any leak (notice), and which reactions fired versus were softened / withdrawn because a team reached the stakeholder first (reactions). State clearly (1) whether decisions were timely, scoped and explained, (2) whether the right functions and stakeholders were looped in before the consequences reached them, (3) what they should have done differently, and (4) one note per member. If several organisations are present (teams[]), assess each organisation's executive team separately and then compare. Cite T+ times.",
  social_team_communications:
    'This is the dedicated review of the COMMUNICATIONS team. Using their complete task record, artifacts with grades, member ledger, and role-fit signals: state clearly (1) what they did well, (2) what they should have done differently, and (3) one member-level note per member. Quote specific artifacts with T+ times and scores. Coaching tone, specific and fair.',
  social_team_shareholder:
    'This is the dedicated review of the SHAREHOLDER ENGAGEMENT team (investor relations: shareholders, board, analysts, lenders). Using their complete task record, investor-facing artifacts with grades, member ledger, intel they held/shared, and role-fit signals: state clearly (1) what they did well, (2) what they should have done differently, and (3) one member-level note per member. Assess disclosure discipline (nothing selective, nothing forward-looking beyond confirmed facts), factual precision, calm authority, and whether material developments were escalated and relayed to the teams that needed them. Cite T+ times.',
  social_team_stakeholder:
    'This is the dedicated review of the STAKEHOLDER ENGAGEMENT team (customers, clients, partners, suppliers, affected communities). Using their complete task record, stakeholder-facing artifacts with grades, member ledger, and role-fit signals: state clearly (1) what they did well, (2) what they should have done differently, and (3) one member-level note per member. Assess empathy, honesty of expectations, de-escalation, escalation discipline, and consistency with the official line. Cite T+ times.',
  social_team_procurement:
    'This is the dedicated review of the PROCUREMENT team. Using their complete task record, artifacts with grades, member ledger, intel they held/shared, and role-fit signals: state clearly (1) what they did well, (2) what they should have done differently, and (3) one member-level note per member. Pay special attention to whether verified facts they received were relayed to teams that needed them. Cite T+ times.',
  social_team_sales:
    'This is the dedicated review of the SALES team. Using their complete task record, customer-facing artifacts with grades, member ledger, and role-fit signals: state clearly (1) what they did well, (2) what they should have done differently, and (3) one member-level note per member. Assess empathy, honesty of expectations, escalation discipline, and consistency with the official line. Cite T+ times.',
  social_team_legal:
    'This is the dedicated review of the LEGAL team. Using their complete task record, regulator/dispute artifacts with grades, member ledger, and role-fit signals: state clearly (1) what they did well, (2) what they should have done differently, and (3) one member-level note per member. Assess review timeliness, dispute quality, and risk flagging. Cite T+ times.',
  social_team_other:
    'This is the dedicated review of the teams outside the preset functions (teams[] — one block per team, e.g. Fleet Operations, Driver Relations, Investigations). For EACH team, using its mission, complete task record, artifacts with grades, member ledger and role-fit signals: state clearly (1) what it did well, (2) what it should have done differently, and (3) one member-level note per member. Judge each team against its own charter, not against the preset functions. Cite T+ times.',
  social_information_flow:
    'Assess how information moved (or failed to move) across teams: every intel dependency with its holder, deadline, share time and consequence; email/chat coordination volume; escalations. Connect withheld or late intel to the public consequences it caused. Name the strongest and weakest handoff.',
  social_misinformation:
    'Assess rumour control: response latency on harmful posts, what was never addressed and its reach, report precision (valid vs frivolous flags), and dispute outcomes. Distinguish activity from effectiveness. Name the most damaging unaddressed claim.',
  social_sentiment:
    'Interpret the sentiment trajectory: identify each turning point and attribute it to a specific player action, published artifact, consequence inject, or failure to act (cite T+ minutes). Explain the final position of each outcome dimension. State what actually drove recovery or decline — specificity of content, timing, or coordination.',
  social_crisis_standards:
    'Evaluate the response against crisis-communication doctrine: the watchdog final posture (transparency, consistency, RDAP, victim-centring) and each doctrine benchmark met/late/missed with its timing. Reference the Rule of Three (tell the truth, tell it all, tell it fast) where the data supports it.',
  social_player_performance:
    'Give each named player a short, fair assessment: their strongest contribution (quote it with score), their growth area, and their overall pattern (volume vs quality, lane discipline). Base every claim on the ledger data provided. Do not rank players against each other; coach them individually.',
  social_recommendations:
    'Synthesise all section analyses into 3-5 prioritised, actionable recommendations for the next exercise. Each must reference the specific section evidence it comes from and describe a concrete behaviour change, not a platitude.',
};

// ─── Small utilities ─────────────────────────────────────────────────────────

function trunc(value: unknown, max: number): string {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function downsample<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const step = rows.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(rows[Math.floor(i * step)]);
  const last = rows[rows.length - 1];
  if (out[out.length - 1] !== last) out[out.length - 1] = last;
  return out;
}

function gradeNumber(grade: Record<string, unknown> | null, key: string): number | null {
  const v = grade?.[key];
  return typeof v === 'number' && !Number.isNaN(v) ? Math.round(v) : null;
}

// ─── Section data assembly ───────────────────────────────────────────────────

interface TimelineEvent {
  t_plus_min: number | null;
  type: string;
  title: string;
  detail?: string;
  tone?: 'positive' | 'negative' | 'neutral';
}

export async function buildSocialSectionsData(sessionId: string): Promise<SocialSectionsMap> {
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('start_time, end_time, created_at, current_state, scenario_id')
    .eq('id', sessionId)
    .single();

  const startIso = (session?.start_time as string) || (session?.created_at as string) || null;
  const startMs = startIso ? new Date(startIso).getTime() : null;
  const endMs = session?.end_time ? new Date(session.end_time as string).getTime() : Date.now();
  const durationMinutes = startMs ? Math.max(0, Math.round((endMs - startMs) / 60000)) : null;
  const tPlus = (iso: string | null | undefined): number | null =>
    startMs && iso ? Math.max(0, Math.round((new Date(iso).getTime() - startMs) / 60000)) : null;

  let scenarioTitle = '';
  let scenarioDescription = '';
  let orgName = '';
  let dimensionLabels: Record<string, string> = {
    public_trust: 'Public Trust',
    community_safety: 'Stakeholder Confidence',
    narrative_control: 'Narrative Control',
    escalation_risk: 'Escalation Risk',
  };
  if (session?.scenario_id) {
    const { data: scenario } = await supabaseAdmin
      .from('scenarios')
      .select('title, description, initial_state')
      .eq('id', session.scenario_id as string)
      .single();
    scenarioTitle = String(scenario?.title || '');
    scenarioDescription = trunc(scenario?.description, 700);
    const is = (scenario?.initial_state || {}) as Record<string, unknown>;
    orgName = String(is.org_name || '');
    const dl = is.dimension_labels as Record<string, string> | undefined;
    if (dl) dimensionLabels = { ...dimensionLabels, ...dl };
  }

  const [
    social,
    ledger,
    intelStatus,
    { data: injectEvents },
    { data: watchdogPosts },
    { data: disputes },
    { count: participantCount },
  ] = await Promise.all([
    buildSocialMediaAARData(sessionId),
    buildPlayerLedger(sessionId),
    getIntelStatus(sessionId).catch(() => [] as IntelStatusEntry[]),
    supabaseAdmin
      .from('session_events')
      .select('event_type, description, metadata, created_at')
      .eq('session_id', sessionId)
      .in('event_type', ['inject', 'inject_cancelled'])
      .order('created_at', { ascending: true }),
    supabaseAdmin
      .from('social_posts')
      .select('content, content_flags, created_at')
      .eq('session_id', sessionId)
      .contains('content_flags', { watchdog: true })
      .order('created_at', { ascending: true }),
    supabaseAdmin
      .from('content_dispute_requests')
      .select('status, verdict_reason, ai_confidence, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true }),
    supabaseAdmin
      .from('session_participants')
      .select('user_id', { count: 'exact', head: true })
      .eq('session_id', sessionId),
  ]);

  const socialState = ((session?.current_state as Record<string, unknown>)?.social_state ||
    {}) as Record<string, unknown>;
  const crisisStandards = ((session?.current_state as Record<string, unknown>)?.crisis_standards ||
    {}) as Record<string, unknown>;

  const dims = social.sentiment_dimensions;
  const finalDimensions = [
    { key: 'public_trust', label: dimensionLabels.public_trust, value: dims.final_public_trust },
    {
      key: 'community_safety',
      label: dimensionLabels.community_safety,
      value: dims.final_community_safety,
    },
    {
      key: 'narrative_control',
      label: dimensionLabels.narrative_control,
      value: dims.final_narrative_control,
    },
    {
      key: 'escalation_risk',
      label: dimensionLabels.escalation_risk,
      value: dims.final_escalation_risk,
      lower_is_better: true,
    },
  ];

  // Team identity (contract §5.2): function and organisation per team, plus the org registry, so
  // composed names ("Communications — PNP") resolve to their function and their organisation.
  type TeamIdentityLite = {
    function_key: string | null;
    org_key: string | null;
    org_display: string | null;
    country: string | null;
  };
  const identityByTeamName = new Map<string, TeamIdentityLite>();
  let orgRegistry: Array<{
    org_key: string;
    display_name: string;
    country: string | null;
    side: string;
    is_primary?: boolean;
  }> = [];
  try {
    const { getSessionTeams, getOrgRegistry } = await import('./orgRegistryService.js');
    const { getSessionScenarioId } = await import('../lib/scenarioCache.js');
    const scenarioId = await getSessionScenarioId(sessionId);
    orgRegistry = scenarioId ? await getOrgRegistry(scenarioId) : [];
    for (const t of await getSessionTeams(sessionId)) {
      const org = t.org_key ? orgRegistry.find((o) => o.org_key === t.org_key) : undefined;
      identityByTeamName.set(t.team_name, {
        function_key: t.function_key,
        org_key: t.org_key,
        org_display: org?.display_name ?? null,
        country: t.country,
      });
    }
  } catch {
    /* single-org / legacy: everything resolves by exact team name */
  }
  const identityOf = (teamName: string): TeamIdentityLite =>
    identityByTeamName.get(teamName) ?? {
      function_key: null,
      org_key: null,
      org_display: null,
      country: null,
    };
  const functionOf = (teamName: string): string =>
    resolveTeamFunction({ team_name: teamName, function_key: identityOf(teamName).function_key });

  const teamComposites = social.team_performance.map((t) => ({
    team_name: t.team_name,
    function_key: functionOf(t.team_name),
    org_key: identityOf(t.team_name).org_key,
    org_display: identityOf(t.team_name).org_display,
    composite: t.composite_score,
    content_quality: t.content_quality,
    task_completion: t.task_completion,
    role_fit: t.role_fit,
    collaboration: t.collaboration,
    member_count: t.member_count,
    tasks_done: t.tasks_done,
    tasks_total: t.tasks_total,
  }));
  const compositeValues = teamComposites
    .map((t) => t.composite)
    .filter((v): v is number => v != null);
  const overallComposite =
    compositeValues.length > 0
      ? Math.round(compositeValues.reduce((s, v) => s + v, 0) / compositeValues.length)
      : null;

  // Per-organisation roll-up (multi-org scenarios only): average composite over that org's
  // scored teams, so "HQ vs Johor office" is a first-class comparison in the executive summary.
  const protagonistOrgs = orgRegistry.filter((o) => o.side === 'protagonist');
  const organisations =
    protagonistOrgs.length > 1
      ? protagonistOrgs.map((o) => {
          const teams = teamComposites.filter((t) => t.org_key === o.org_key);
          const scored = teams.map((t) => t.composite).filter((v): v is number => v != null);
          return {
            org_key: o.org_key,
            display_name: o.display_name,
            country: o.country ?? null,
            is_primary: !!o.is_primary,
            team_count: teams.length,
            staffed_team_count: teams.filter((t) => t.member_count > 0).length,
            avg_composite: scored.length
              ? Math.round(scored.reduce((s, v) => s + v, 0) / scored.length)
              : null,
            teams: teams.map((t) => ({
              team_name: t.team_name,
              function_key: t.function_key,
              composite: t.composite,
            })),
          };
        })
      : [];

  const consequences = ledger.consequences.map((c) => ({
    t_plus_min: tPlus(c.created_at),
    description: trunc(c.description, 180),
    is_positive: c.is_positive,
  }));

  const sections: SocialSectionsMap = {};

  // 1. Executive summary — also the data source for the report's visual layer
  // (gauges, team bars, donut), so it carries the full at-a-glance rollup.
  sections.social_executive = {
    data: {
      scenario_title: scenarioTitle,
      scenario_description: scenarioDescription,
      org_name: orgName,
      duration_minutes: durationMinutes,
      participant_count: participantCount ?? ledger.players.length,
      overall_composite: overallComposite,
      final_overall_sentiment: dims.final_overall,
      final_dimensions: finalDimensions,
      teams: teamComposites,
      // Multi-org only (empty otherwise): per-organisation averages for side-by-side comparison.
      organisations,
      strategic_scorecard: social.strategic_scorecard,
      impression_dominance: social.impression_dominance,
      // Planned stakeholder actions withdrawn / revised / held because players engaged first.
      stakeholder_preemption: social.stakeholder_preemption ?? [],
      // Organic executive decisions: what leadership decided, who was told, what followed.
      executive_decisions: social.executive_decisions ?? [],
      headline_counts: {
        graded_player_posts: social.content_quality.posts_created,
        emails_sent: social.coordination_metrics.total_emails_sent,
        chat_messages: social.coordination_metrics.total_chat_messages,
        total_player_actions: social.coordination_metrics.total_player_actions,
        positive_consequences: consequences.filter((c) => c.is_positive).length,
        negative_consequences: consequences.filter((c) => !c.is_positive).length,
        watchdog_challenges: (watchdogPosts || []).length,
        intel_dependencies: intelStatus.length,
        intel_shared: intelStatus.filter((i) => i.shared).length,
        intel_missed: intelStatus.filter((i) => !i.shared && i.deadline_missed).length,
      },
    },
    analysis: null,
  };

  // 2. Timeline reconstruction
  const timelineEvents: TimelineEvent[] = [];
  for (const e of injectEvents || []) {
    const meta = (e.metadata || {}) as Record<string, unknown>;
    if (e.event_type === 'inject') {
      timelineEvents.push({
        t_plus_min: tPlus(e.created_at as string),
        type: 'inject_published',
        title: trunc(meta.title || e.description, 120),
        detail: meta.severity ? `severity: ${String(meta.severity)}` : undefined,
        tone: 'neutral',
      });
    } else {
      timelineEvents.push({
        t_plus_min: tPlus(e.created_at as string),
        type: 'inject_cancelled',
        title: trunc(meta.reason || e.description || 'Inject cancelled', 140),
        tone: 'neutral',
      });
    }
  }
  for (const w of watchdogPosts || []) {
    const flags = (w.content_flags || {}) as Record<string, unknown>;
    timelineEvents.push({
      t_plus_min: tPlus(w.created_at as string),
      type: 'watchdog_challenge',
      title: trunc(w.content, 140),
      detail: flags.issue_type ? `issue: ${String(flags.issue_type)}` : undefined,
      tone: 'negative',
    });
  }
  for (const c of ledger.consequences) {
    timelineEvents.push({
      t_plus_min: tPlus(c.created_at),
      type: c.is_positive ? 'positive_consequence' : 'negative_consequence',
      title: trunc(c.description, 140),
      tone: c.is_positive ? 'positive' : 'negative',
    });
  }
  for (const player of ledger.players) {
    for (const entry of player.entries) {
      if ((entry.kind === 'post' || entry.kind === 'email') && entry.grade) {
        timelineEvents.push({
          t_plus_min: tPlus(entry.timestamp),
          type: entry.kind === 'post' ? 'player_post' : 'player_email',
          title: trunc(entry.content, 120),
          detail: `${player.team_name || 'Unassigned'} · ${player.display_name} · grade ${gradeNumber(entry.grade, 'overall') ?? '—'}`,
          tone: 'neutral',
        });
      }
    }
  }
  for (const item of intelStatus) {
    if (item.shared) {
      timelineEvents.push({
        t_plus_min: item.shared_at_minutes,
        type: 'intel_shared',
        title: `Intel "${item.source_title}" relayed to ${item.needed_by.join(', ')}`,
        detail: item.shared_by_team
          ? `by ${item.shared_by_team} (${item.shared_via || 'shared'})`
          : undefined,
        tone: 'positive',
      });
    } else if (item.deadline_missed) {
      timelineEvents.push({
        t_plus_min: item.deadline_minutes,
        type: 'intel_deadline_missed',
        title: `Intel "${item.source_title}" never left ${item.holder_team}`,
        detail: `needed by ${item.needed_by.join(', ')}`,
        tone: 'negative',
      });
    }
  }
  timelineEvents.sort((a, b) => (a.t_plus_min ?? 0) - (b.t_plus_min ?? 0));
  sections.social_timeline = {
    data: {
      duration_minutes: durationMinutes,
      events: downsample(timelineEvents, 60),
    },
    analysis: null,
  };

  // 3. Public communications review
  const publicArtifacts: Array<Record<string, unknown>> = [];
  for (const player of ledger.players) {
    for (const entry of player.entries) {
      if (entry.kind !== 'post' && entry.kind !== 'reply') continue;
      publicArtifacts.push({
        t_plus_min: tPlus(entry.timestamp),
        kind: entry.kind,
        author: player.display_name,
        team: player.team_name,
        content: trunc(entry.content, 240),
        overall: gradeNumber(entry.grade, 'overall'),
        accuracy: gradeNumber(entry.grade, 'accuracy'),
        tone: gradeNumber(entry.grade, 'tone'),
        persuasiveness: gradeNumber(entry.grade, 'persuasiveness'),
        feedback: trunc(entry.grade?.feedback, 180),
      });
    }
  }
  publicArtifacts.sort((a, b) => ((a.t_plus_min as number) ?? 0) - ((b.t_plus_min as number) ?? 0));
  sections.social_public_comms = {
    data: {
      average_grades: {
        accuracy: social.content_quality.average_accuracy,
        tone: social.content_quality.average_tone,
        sensitivity: social.content_quality.average_sensitivity,
        persuasiveness: social.content_quality.average_persuasiveness,
        overall: social.content_quality.average_overall,
      },
      impression_dominance: social.impression_dominance,
      format_analysis: social.format_analysis.slice(0, 10).map((f) => ({
        format: f.post_format,
        content_preview: trunc(f.content_preview, 160),
        overall: gradeNumber(f.grade as Record<string, unknown>, 'overall'),
        peak_views: f.peak_views,
        peak_likes: f.peak_likes,
      })),
      artifacts: publicArtifacts.slice(0, 40),
    },
    analysis: null,
  };

  // 4-7. Per-team deep dives. Sections are keyed by team FUNCTION (contract §5.2): a team named
  // "Communications — PNP" with function_key "Communications" lands in the Communications
  // section; Executive teams get their own section; every other function lands in
  // `social_team_other`. Several teams sharing a section become one block each.
  const teamBlocksBySection = new Map<SocialAARSectionKey, Array<Record<string, unknown>>>();
  for (const team of social.team_performance) {
    const teamFunction = functionOf(team.team_name);
    const key = teamSectionFor(teamFunction);
    const identity = identityOf(team.team_name);
    const unstaffed = team.member_count === 0;
    const members = ledger.players.filter((p) => p.team_name === team.team_name);
    const memberDetails = members.map((p) => {
      const entries = p.entries.slice(0, 22).map((entry) => ({
        t_plus_min: tPlus(entry.timestamp),
        kind: entry.kind,
        action_type: entry.action_type,
        content: trunc(entry.content, 200),
        overall: gradeNumber(entry.grade, 'overall'),
        role_fit: gradeNumber(entry.grade, 'role_fit'),
        feedback: trunc(entry.grade?.feedback, 140),
        dispute: entry.dispute
          ? { status: entry.dispute.status, reason: trunc(entry.dispute.verdict_reason, 120) }
          : undefined,
      }));
      return { display_name: p.display_name, entry_count: p.entries.length, entries };
    });
    const outOfLane: Array<Record<string, unknown>> = [];
    for (const p of members) {
      for (const entry of p.entries) {
        const signals = (entry.grade?.signals || {}) as Record<string, unknown>;
        const roleFit = gradeNumber(entry.grade, 'role_fit');
        if (signals.within_mandate === false || (roleFit != null && roleFit < 50)) {
          outOfLane.push({
            t_plus_min: tPlus(entry.timestamp),
            author: p.display_name,
            content: trunc(entry.content, 160),
            role_fit: roleFit,
          });
        }
      }
    }
    const teamIntel = intelStatus
      .filter((i) => i.holder_team === team.team_name || i.needed_by.includes(team.team_name))
      .map((i) => ({
        title: i.source_title,
        role: i.holder_team === team.team_name ? 'holder' : 'recipient',
        needed_by: i.needed_by,
        shared: i.shared,
        shared_at_minutes: i.shared_at_minutes,
        deadline_minutes: i.deadline_minutes,
        deadline_missed: i.deadline_missed,
      }));
    const block: Record<string, unknown> = {
      team_name: team.team_name,
      function_key: teamFunction,
      org_key: identity.org_key,
      org_display: identity.org_display,
      country: identity.country,
      unstaffed,
      mission: team.mission,
      scores: {
        composite: team.composite_score,
        content_quality: team.content_quality,
        task_completion: team.task_completion,
        role_fit: team.role_fit,
        collaboration: team.collaboration,
      },
      task_outcomes: team.task_outcomes,
      members: memberDetails,
      member_summaries: team.members,
      intel: teamIntel,
      out_of_lane: outOfLane.slice(0, 8),
      best_artifact: team.best_artifact,
      worst_artifact: team.worst_artifact,
      stakeholder_preemption: (social.stakeholder_preemption ?? []).filter(
        (p) => p.team === team.team_name || p.contributing_teams.includes(team.team_name),
      ),
      ...(teamFunction === 'Executive'
        ? {
            executive_decisions: (social.executive_decisions ?? []).filter(
              (d) =>
                d.decided_by === team.team_name ||
                (!d.decided_by && identity.org_key == null) ||
                d.org_key === identity.org_key,
            ),
          }
        : {}),
    };
    if (!teamBlocksBySection.has(key)) teamBlocksBySection.set(key, []);
    teamBlocksBySection.get(key)!.push(block);
  }
  for (const [key, blocks] of teamBlocksBySection) {
    // Custom functions always render as a grouped section (one block per team) so the section
    // title stays stable; preset functions group only when several organisations share them.
    if (blocks.length === 1 && key !== 'social_team_other') {
      sections[key] = { data: blocks[0], analysis: null };
    } else {
      const distinctOrgs = new Set(blocks.map((b) => b.org_key ?? null));
      sections[key] = {
        data: {
          team_name:
            key === 'social_team_other'
              ? `Other teams (${blocks.map((b) => b.team_name).join(', ')})`
              : `${blocks[0].function_key} (${blocks.map((b) => b.team_name).join(', ')})`,
          function_key: key === 'social_team_other' ? 'other' : blocks[0].function_key,
          multi_org: distinctOrgs.size > 1,
          teams: blocks,
        },
        analysis: null,
      };
    }
  }

  // 8. Cross-team information flow
  const emailsByTeam: Record<string, number> = {};
  for (const p of ledger.players) {
    const teamName = p.team_name || 'Unassigned';
    emailsByTeam[teamName] =
      (emailsByTeam[teamName] || 0) + p.entries.filter((e) => e.kind === 'email').length;
  }
  sections.social_information_flow = {
    data: {
      intel_items: intelStatus.map((i) => ({
        title: i.source_title,
        summary: trunc(i.summary, 160),
        holder_team: i.holder_team,
        needed_by: i.needed_by,
        arrived_at_minutes: i.trigger_time_minutes,
        deadline_minutes: i.deadline_minutes,
        shared: i.shared,
        shared_at_minutes: i.shared_at_minutes,
        shared_by_team: i.shared_by_team,
        shared_via: i.shared_via,
        deadline_missed: i.deadline_missed,
      })),
      emails_sent_by_team: emailsByTeam,
      total_chat_messages: social.coordination_metrics.total_chat_messages,
      escalations: (socialState.tier3_advanced_actions as number) ?? null,
      negative_consequences: consequences.filter((c) => !c.is_positive),
    },
    analysis: null,
  };

  // 9. Misinformation and moderation
  sections.social_misinformation = {
    data: {
      response_timeline: social.response_timeline.slice(0, 30),
      missed_opportunities: social.missed_opportunities.slice(0, 15),
      reports: {
        total: (socialState.total_reports as number) ?? 0,
        valid: (socialState.valid_reports as number) ?? 0,
        invalid: (socialState.invalid_reports as number) ?? 0,
        precision: (socialState.report_precision as number) ?? null,
      },
      misinformation_flagged: (socialState.misinformation_flagged_count as number) ?? 0,
      final_unaddressed: {
        hate: (socialState.unaddressed_hate_count as number) ?? 0,
        misinformation: (socialState.unaddressed_misinfo_count as number) ?? 0,
      },
      disputes: (disputes || []).map((d) => ({
        t_plus_min: tPlus(d.created_at as string),
        status: String(d.status),
        verdict_reason: trunc(d.verdict_reason, 160),
        ai_confidence: d.ai_confidence != null ? Number(d.ai_confidence) : null,
      })),
    },
    analysis: null,
  };

  // 10. Sentiment journey — also feeds the report's line chart.
  sections.social_sentiment = {
    data: {
      trajectory: downsample(social.sentiment_trajectory, 40).map((s) => ({
        t_plus_min: tPlus(s.recorded_at),
        sentiment_score: s.sentiment_score,
        media_attention: s.media_attention,
        political_pressure: s.political_pressure,
      })),
      final_dimensions: finalDimensions,
      final_overall_sentiment: dims.final_overall,
      consequences,
    },
    analysis: null,
  };

  // 11. Crisis communication standards
  sections.social_crisis_standards = {
    data: {
      final_posture: crisisStandards,
      doctrine_compliance: social.doctrine_compliance,
      watchdog_challenges: (watchdogPosts || []).map((w) => {
        const flags = (w.content_flags || {}) as Record<string, unknown>;
        return {
          t_plus_min: tPlus(w.created_at as string),
          issue_type: flags.issue_type ? String(flags.issue_type) : null,
          evidence: trunc(flags.evidence, 200),
          post: trunc(w.content, 160),
        };
      }),
    },
    analysis: null,
  };

  // 12. Individual player performance
  sections.social_player_performance = {
    data: {
      players: ledger.players.map((p) => {
        const graded = p.entries.filter((e) => e.grade && typeof e.grade.overall === 'number');
        const avg = (key: string) => {
          const values = graded
            .map((e) => gradeNumber(e.grade, key))
            .filter((v): v is number => v != null);
          return values.length > 0
            ? Math.round(values.reduce((s, v) => s + v, 0) / values.length)
            : null;
        };
        let best: Record<string, unknown> | null = null;
        let worst: Record<string, unknown> | null = null;
        for (const e of graded) {
          const overall = gradeNumber(e.grade, 'overall');
          if (overall == null) continue;
          if (!best || overall > (best.overall as number)) {
            best = {
              content: trunc(e.content, 180),
              overall,
              feedback: trunc(e.grade?.feedback, 140),
            };
          }
          if (!worst || overall < (worst.overall as number)) {
            worst = {
              content: trunc(e.content, 180),
              overall,
              feedback: trunc(e.grade?.feedback, 140),
            };
          }
        }
        const counts: Record<string, number> = {};
        for (const e of p.entries) {
          const k = e.kind === 'action' ? e.action_type || 'action' : e.kind;
          counts[k] = (counts[k] || 0) + 1;
        }
        return {
          display_name: p.display_name,
          team_name: p.team_name,
          total_entries: p.entries.length,
          graded_items: graded.length,
          avg_overall: avg('overall'),
          avg_role_fit: avg('role_fit'),
          counts_by_kind: counts,
          best_artifact: best,
          worst_artifact: worst,
          disputes_filed: p.entries.filter((e) => e.dispute).length,
        };
      }),
    },
    analysis: null,
  };

  // 13. Recommendations — data is synthesised from the other analyses at call
  // time (buildSocialRecommendationsContext); keep a note for the raw view.
  sections.social_recommendations = {
    data: {
      note: 'Synthesised from the analyses of all other report sections.',
      section_count: SOCIAL_AAR_SECTION_KEYS.length - 1,
    },
    analysis: null,
  };

  return sections;
}

// ─── Per-section AI analysis ─────────────────────────────────────────────────

const MAX_SECTION_DATA_CHARS = 14000;
const MAX_RECOMMENDATIONS_CONTEXT_CHARS = 24000;

export function buildSocialRecommendationsContext(sections: SocialSectionsMap): unknown {
  const blocks: Array<{
    sectionKey: string;
    label: string;
    analysis: string | null;
    dataSummary?: string;
  }> = [];
  let total = 0;
  for (const key of SOCIAL_AAR_SECTION_KEYS) {
    if (key === 'social_recommendations') continue;
    const entry = sections[key];
    if (!entry) continue;
    const block = {
      sectionKey: key,
      label: SOCIAL_SECTION_LABELS[key],
      analysis: entry.analysis ?? null,
      dataSummary:
        entry.data != null && typeof entry.data === 'object'
          ? JSON.stringify(entry.data).slice(0, 600)
          : undefined,
    };
    const len = JSON.stringify(block).length;
    if (total + len > MAX_RECOMMENDATIONS_CONTEXT_CHARS) break;
    blocks.push(block);
    total += len;
  }
  return { sourceSections: blocks };
}

export async function generateSocialSectionAnalysis(
  sectionKey: SocialAARSectionKey,
  sectionData: unknown,
  context: { sessionId: string; scenarioTitle?: string; orgName?: string },
  openAiApiKey: string,
): Promise<string> {
  const label = SOCIAL_SECTION_LABELS[sectionKey];
  const instruction = SOCIAL_SECTION_INSTRUCTIONS[sectionKey];
  const isRecommendations = sectionKey === 'social_recommendations';

  const systemPrompt = isRecommendations
    ? `You are an expert crisis-communication trainer writing the final takeaways of an after-action review for a social-media crisis simulation. Below you will receive the analyses of every other report section. ${instruction} Write for the trainer AND the trainees: direct, specific, professional.`
    : `You are an expert crisis-communication trainer writing the "${label}" section of an after-action review for a social-media crisis simulation${context.orgName ? ` involving ${context.orgName}` : ''}. The data below is the complete factual record for this section — cite specific T+ minutes, names, scores and quotes from it. Interpret and assess; never repeat raw tables. ${instruction} Write 2-4 tight paragraphs for the trainer AND the trainees: direct, specific, professional. No headings, no bullet lists except in the recommendations section.`;

  const dataJson =
    typeof sectionData === 'string'
      ? sectionData
      : JSON.stringify(sectionData, null, 1).slice(0, MAX_SECTION_DATA_CHARS);

  const userPrompt = `Session: ${context.sessionId}${context.scenarioTitle ? `; Scenario: ${context.scenarioTitle}` : ''}\n\n${isRecommendations ? 'Analyses from the other report sections' : `Data for ${label}`}:\n${dataJson}\n\nWrite the ${isRecommendations ? 'recommendations' : 'analysis'} now.`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openAiApiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-5.2',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.4,
      max_completion_tokens: isRecommendations ? 1200 : 1800,
    }),
  });

  if (!response.ok) {
    const errBody = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    throw new Error(errBody?.error?.message || `OpenAI ${response.status}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') throw new Error('No content from OpenAI');
  return content.trim();
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Full social AAR pipeline: build all section data, persist it immediately
 * (charts render even before/without AI), then run one AI call per section,
 * persisting after each so the frontend can poll and reveal progressively.
 * Never throws — a failed section keeps analysis null and the loop continues.
 */
export async function generateSocialAarReport(
  sessionId: string,
  aarReportId: string,
  openAiApiKey: string | undefined,
): Promise<void> {
  let sections = await buildSocialSectionsData(sessionId);

  await supabaseAdmin
    .from('aar_reports')
    .update({ report_format: 'sections', sections })
    .eq('id', aarReportId);

  const executiveData = (sections.social_executive?.data || {}) as Record<string, unknown>;
  const context = {
    sessionId,
    scenarioTitle: (executiveData.scenario_title as string) || undefined,
    orgName: (executiveData.org_name as string) || undefined,
  };

  if (!openAiApiKey) {
    logger.info({ sessionId }, 'Social AAR: no OpenAI key, section data stored without analysis');
    return;
  }

  for (const key of SOCIAL_AAR_SECTION_KEYS) {
    const entry = sections[key];
    if (!entry?.data) continue;

    const entryData = entry.data as Record<string, unknown>;
    if (entryData.unstaffed === true) {
      sections = {
        ...sections,
        [key]: {
          ...entry,
          analysis:
            'This team was unstaffed for the session, so no team analysis applies. Consider staffing it in the next exercise to cover its charter.',
        },
      };
      await supabaseAdmin.from('aar_reports').update({ sections }).eq('id', aarReportId);
      continue;
    }

    const sectionData =
      key === 'social_recommendations' ? buildSocialRecommendationsContext(sections) : entry.data;

    try {
      const analysis = await generateSocialSectionAnalysis(key, sectionData, context, openAiApiKey);
      sections = { ...sections, [key]: { ...entry, analysis } };
      await supabaseAdmin.from('aar_reports').update({ sections }).eq('id', aarReportId);
    } catch (err) {
      logger.warn(
        { err, sessionId, sectionKey: key },
        'Social AAR section analysis failed, leaving null',
      );
    }
  }

  const executiveAnalysis = sections.social_executive?.analysis;
  if (executiveAnalysis && executiveAnalysis.trim()) {
    await supabaseAdmin
      .from('aar_reports')
      .update({ summary: executiveAnalysis })
      .eq('id', aarReportId);
  }

  logger.info({ sessionId }, 'Social AAR section report generated');
}
