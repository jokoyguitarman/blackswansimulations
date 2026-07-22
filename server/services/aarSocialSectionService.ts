import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { buildSocialMediaAARData } from './aarSocialMediaService.js';
import { buildPlayerLedger } from './playerLedgerService.js';
import { getIntelStatus, type IntelStatusEntry } from './intelSharingService.js';
import type { SectionEntry } from './aarSectionService.js';

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
  'social_team_communications',
  'social_team_procurement',
  'social_team_sales',
  'social_team_legal',
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
  social_team_communications: 'Team deep-dive: Communications',
  social_team_procurement: 'Team deep-dive: Procurement',
  social_team_sales: 'Team deep-dive: Sales',
  social_team_legal: 'Team deep-dive: Legal',
  social_information_flow: 'Cross-team information flow',
  social_misinformation: 'Misinformation and moderation',
  social_sentiment: 'Sentiment journey and turning points',
  social_crisis_standards: 'Crisis communication standards',
  social_player_performance: 'Individual player performance',
  social_recommendations: 'Key takeaways and recommendations',
};

const TEAM_SECTION_BY_NAME: Record<string, SocialAARSectionKey> = {
  Communications: 'social_team_communications',
  Procurement: 'social_team_procurement',
  Sales: 'social_team_sales',
  Legal: 'social_team_legal',
};

const SOCIAL_SECTION_INSTRUCTIONS: Record<SocialAARSectionKey, string> = {
  social_executive:
    'Write the executive verdict of this social-media crisis exercise: how the crisis unfolded, whether the response succeeded, and the single most important lesson. Reference the final outcome dimensions by their scenario-specific labels, the team composite scores, and the intel-sharing outcome. End with a one-sentence overall verdict.',
  social_timeline:
    'Reconstruct the session chronologically in phases (opening, escalation, turning point, resolution). Pair each pressure beat (inject, watchdog challenge, consequence) with the team response that followed — or note the silence. Cite T+ minutes throughout. Identify the single most consequential moment.',
  social_public_comms:
    'Assess every published statement and reply: quality (use the stored grade dimensions), timing, consistency across platforms, and reach versus hostile content (impression dominance). Quote the strongest and weakest artifacts with their scores. Judge whether format choices (statement, thread reply, creative) matched the moment.',
  social_team_communications:
    'This is the dedicated review of the COMMUNICATIONS team. Using their complete task record, artifacts with grades, member ledger, and role-fit signals: state clearly (1) what they did well, (2) what they should have done differently, and (3) one member-level note per member. Quote specific artifacts with T+ times and scores. Coaching tone, specific and fair.',
  social_team_procurement:
    'This is the dedicated review of the PROCUREMENT team. Using their complete task record, artifacts with grades, member ledger, intel they held/shared, and role-fit signals: state clearly (1) what they did well, (2) what they should have done differently, and (3) one member-level note per member. Pay special attention to whether verified facts they received were relayed to teams that needed them. Cite T+ times.',
  social_team_sales:
    'This is the dedicated review of the SALES team. Using their complete task record, customer-facing artifacts with grades, member ledger, and role-fit signals: state clearly (1) what they did well, (2) what they should have done differently, and (3) one member-level note per member. Assess empathy, honesty of expectations, escalation discipline, and consistency with the official line. Cite T+ times.',
  social_team_legal:
    'This is the dedicated review of the LEGAL team. Using their complete task record, regulator/dispute artifacts with grades, member ledger, and role-fit signals: state clearly (1) what they did well, (2) what they should have done differently, and (3) one member-level note per member. Assess review timeliness, dispute quality, and risk flagging. Cite T+ times.',
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

  const teamComposites = social.team_performance.map((t) => ({
    team_name: t.team_name,
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
      strategic_scorecard: social.strategic_scorecard,
      impression_dominance: social.impression_dominance,
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

  // 4-7. Per-team deep dives
  for (const team of social.team_performance) {
    const key = TEAM_SECTION_BY_NAME[team.team_name];
    if (!key) continue;
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
    sections[key] = {
      data: {
        team_name: team.team_name,
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
      },
      analysis: null,
    };
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
