import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { computeTeamScores } from './teamScoreService.js';

export interface SocialMediaAARData {
  response_timeline: Array<{
    timestamp: string;
    event_type: string;
    description: string;
    response_time_minutes?: number;
    was_responded: boolean;
  }>;
  sop_compliance: {
    steps_completed: number;
    steps_total: number;
    steps_overdue: number;
    completion_percentage: number;
    details: Array<{
      step_name: string;
      status: string;
      completed_at?: string;
      time_limit_minutes?: number;
    }>;
  };
  content_quality: {
    posts_created: number;
    average_accuracy: number;
    average_tone: number;
    average_sensitivity: number;
    average_persuasiveness: number;
    average_overall: number;
    graded_responses: Array<{
      content: string;
      grade: Record<string, unknown>;
      created_at: string;
    }>;
  };
  sentiment_trajectory: Array<{
    recorded_at: string;
    sentiment_score: number;
    media_attention: number;
    political_pressure: number;
  }>;
  missed_opportunities: Array<{
    post_id: string;
    content: string;
    sentiment: string;
    requires_response: boolean;
    was_responded: boolean;
  }>;
  coordination_metrics: {
    total_chat_messages: number;
    total_emails_sent: number;
    total_player_actions: number;
    actions_by_type: Record<string, number>;
    avg_internal_messages_before_response: number;
  };
  strategic_scorecard: {
    tier1_count: number;
    tier2_count: number;
    tier3_count: number;
    strategic_ratio: number;
    total_actions: number;
  };
  sentiment_dimensions: {
    final_public_trust: number;
    final_community_safety: number;
    final_narrative_control: number;
    final_escalation_risk: number;
    final_overall: number;
  };
  doctrine_compliance: {
    benchmarks_met: number;
    benchmarks_missed: number;
    benchmarks_total: number;
    details: Array<{
      action: string;
      status: string;
      timing: string;
    }>;
  };
  format_analysis: Array<{
    post_id: string;
    post_format: string;
    content_preview: string;
    grade: Record<string, unknown>;
    peak_views: number;
    peak_likes: number;
    engagement_trajectory: Array<{ tick: number; views: number; likes: number }>;
  }>;
  impression_dominance: {
    player_total_views: number;
    hostile_total_views: number;
    ratio: number;
  };
  /** Per-team debrief for the fixed response teams. Empty for teamless (legacy) scenarios. */
  team_performance: Array<{
    team_name: string;
    mission: string;
    member_count: number;
    composite_score: number | null;
    content_quality: number | null;
    task_completion: number | null;
    role_fit: number | null;
    collaboration: number | null;
    intel_held: number;
    intel_shared_count: number;
    tasks_done: number;
    tasks_total: number;
    task_outcomes: Array<{
      description: string;
      status: string;
      on_time: boolean | null;
    }>;
    members: Array<{
      display_name: string;
      graded_items: number;
      avg_overall: number | null;
      avg_role_fit: number | null;
    }>;
    best_artifact: { content: string; overall: number } | null;
    worst_artifact: { content: string; overall: number } | null;
  }>;
  /**
   * Stakeholder pre-emption (docs/stakeholder-runtime-plan.md §3.6): planned stakeholder actions
   * that were withdrawn, revised or held because players engaged the stakeholder first.
   */
  stakeholder_preemption: Array<{
    team: string | null;
    contributing_teams: string[];
    stakeholder_name: string;
    inject_title: string;
    verdict: 'cancel' | 'modify' | 'delay';
    at_minute: number | null;
    reason: string;
    criteria_met: number[];
  }>;
  /**
   * Organic executive decisions (docs/executive-decisions-organic-plan.md §6.8): what leadership
   * decided by communicating, who was told, who found out, the formal notice (if any), and the
   * reactions that fired / were softened / withdrawn — with the team credited.
   */
  executive_decisions: Array<{
    decision_id: string;
    summary: string;
    category: string;
    at_minute: number;
    decided_by: string | null;
    by_trainer: boolean;
    org_key: string | null;
    status: string;
    informed: string[];
    should_know_not_told: string[];
    found_out: Array<{ actor: string; via: string; at_minute: number }>;
    notice: {
      at_minute: number;
      order_ok: boolean;
      before_leak: boolean;
      tone_grade: number | null;
      coverage: number;
    } | null;
    reactions: Array<{
      actor: string;
      channel: string;
      title: string;
      planned_minute: number;
      fired_minute: number | null;
      outcome: 'fired' | 'withdrawn' | 'softened' | 'held' | 'pending';
    }>;
    public_effect: { posts: number; articles: number };
  }>;
}

const TIER1_ACTIONS = ['reply_posted', 'post_liked', 'post_reposted', 'post_flagged', 'news_read'];
const TIER2_ACTIONS = [
  'post_created',
  'draft_created',
  'draft_published',
  'fact_checked',
  'email_read',
];
const TIER3_ACTIONS = [
  'email_sent',
  'escalated',
  'draft_submitted_for_approval',
  'draft_approved',
  'call_answered',
];

export async function buildSocialMediaAARData(sessionId: string): Promise<SocialMediaAARData> {
  const [postsResult, emailsResult, actionsResult, sentimentResult, messagesResult, sessionResult] =
    await Promise.all([
      supabaseAdmin
        .from('social_posts')
        .select('*')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true }),
      supabaseAdmin
        .from('sim_emails')
        .select('*')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true }),
      supabaseAdmin
        .from('player_actions')
        .select('*')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true }),
      supabaseAdmin
        .from('sentiment_snapshots')
        .select('*')
        .eq('session_id', sessionId)
        .order('recorded_at', { ascending: true }),
      supabaseAdmin.from('chat_messages').select('id').eq('session_id', sessionId),
      supabaseAdmin
        .from('sessions')
        .select('current_state, scenario_id, created_at')
        .eq('id', sessionId)
        .single(),
    ]);

  const posts = postsResult.data || [];
  const emails = emailsResult.data || [];
  const actions = actionsResult.data || [];
  const sentimentSnapshots = sentimentResult.data || [];
  const totalMessages = messagesResult.data?.length || 0;

  const responsePosts = posts.filter((p: Record<string, unknown>) => p.requires_response === true);
  const responseTimeline = responsePosts.map((p: Record<string, unknown>) => {
    const createdAt = new Date(p.created_at as string);
    const respondedAt = p.responded_at ? new Date(p.responded_at as string) : null;
    const responseTimeMinutes = respondedAt
      ? (respondedAt.getTime() - createdAt.getTime()) / 60000
      : undefined;

    return {
      timestamp: p.created_at as string,
      event_type:
        (p.content_flags as Record<string, unknown>)?.is_hate_speech ||
        (p.content_flags as Record<string, unknown>)?.is_harmful_narrative
          ? 'harmful_narrative'
          : (p.content_flags as Record<string, unknown>)?.is_misinformation
            ? 'misinformation'
            : (p.content_flags as Record<string, unknown>)?.is_inflammatory
              ? 'inflammatory'
              : (p.content_flags as Record<string, unknown>)?.is_organized_pressure
                ? 'organized_pressure'
                : 'general',
      description: (p.content as string).substring(0, 100),
      response_time_minutes: responseTimeMinutes
        ? Math.round(responseTimeMinutes * 10) / 10
        : undefined,
      was_responded: !!p.responded_at,
    };
  });

  const playerPosts = posts.filter(
    (p: Record<string, unknown>) => p.author_type === 'player' && p.sop_compliance_score,
  );
  const grades = playerPosts.map((p: Record<string, unknown>) => {
    const grade = (p.sop_compliance_score || {}) as Record<string, number>;
    return {
      content: (p.content as string).substring(0, 200),
      grade: p.sop_compliance_score as Record<string, unknown>,
      created_at: p.created_at as string,
      accuracy: grade.accuracy || 0,
      tone: grade.tone || 0,
      sensitivity: grade.cultural_sensitivity || 0,
      persuasiveness: grade.persuasiveness || 0,
      overall: grade.overall || 0,
    };
  });

  const avgGrades =
    grades.length > 0
      ? {
          accuracy: Math.round(grades.reduce((s, g) => s + g.accuracy, 0) / grades.length),
          tone: Math.round(grades.reduce((s, g) => s + g.tone, 0) / grades.length),
          sensitivity: Math.round(grades.reduce((s, g) => s + g.sensitivity, 0) / grades.length),
          persuasiveness: Math.round(
            grades.reduce((s, g) => s + g.persuasiveness, 0) / grades.length,
          ),
          overall: Math.round(grades.reduce((s, g) => s + g.overall, 0) / grades.length),
        }
      : { accuracy: 0, tone: 0, sensitivity: 0, persuasiveness: 0, overall: 0 };

  const missed = posts.filter(
    (p: Record<string, unknown>) => p.requires_response && !p.responded_at,
  );

  const actionsByType: Record<string, number> = {};
  for (const action of actions) {
    const type = action.action_type as string;
    actionsByType[type] = (actionsByType[type] || 0) + 1;
  }

  const outboundEmails = emails.filter((e: Record<string, unknown>) => e.direction === 'outbound');

  const session = sessionResult.data as Record<string, unknown> | null;
  const currentState = (session?.current_state || {}) as Record<string, unknown>;
  const socialState = (currentState.social_state || {}) as Record<string, unknown>;

  // Strategic benchmarks come from the LIVE scenario row so trainer edits and
  // compile output genuinely shape the debrief. (Previously read from
  // sessions.scenario_data, a column that was never written — benchmarks were
  // silently empty in every AAR.)
  let initialState: Record<string, unknown> = {};
  if (session?.scenario_id) {
    const { data: scenarioRow, error: scenarioErr } = await supabaseAdmin
      .from('scenarios')
      .select('initial_state')
      .eq('id', session.scenario_id as string)
      .single();
    if (scenarioErr) {
      logger.warn(
        { error: scenarioErr, sessionId },
        'AAR: failed to load scenario initial_state; benchmarks section will be empty',
      );
    } else {
      initialState = (scenarioRow?.initial_state || {}) as Record<string, unknown>;
    }
  }

  let tier1 = 0,
    tier2 = 0,
    tier3 = 0;
  for (const action of actions) {
    const type = action.action_type as string;
    if (TIER1_ACTIONS.includes(type)) tier1++;
    else if (TIER2_ACTIONS.includes(type)) tier2++;
    else if (TIER3_ACTIONS.includes(type)) tier3++;
  }
  const totalTiered = tier1 + tier2 + tier3;
  const strategicRatio =
    totalTiered > 0 ? Math.round(((tier2 + tier3) / totalTiered) * 100) / 100 : 0;

  const benchmarks = (initialState.strategic_benchmarks || []) as Array<Record<string, unknown>>;
  const sessionStartedAt = session
    ? new Date(((session as Record<string, unknown>).created_at as string) || 0)
    : null;
  const doctrineDetails: Array<{ action: string; status: string; timing: string }> = [];
  let benchmarksMet = 0;
  let benchmarksMissed = 0;
  for (const bm of benchmarks) {
    const detectionType = bm.detection_action_type as string;
    const timingLimit = bm.timing_benchmark_minutes as number | null;
    const matchingAction = actions.find(
      (a: Record<string, unknown>) => a.action_type === detectionType,
    );
    if (matchingAction) {
      const actionTime = new Date(matchingAction.created_at as string);
      const elapsedMin = sessionStartedAt
        ? (actionTime.getTime() - sessionStartedAt.getTime()) / 60000
        : 0;
      const withinTime = timingLimit == null || elapsedMin <= timingLimit;
      if (withinTime) {
        benchmarksMet++;
        doctrineDetails.push({
          action: bm.description as string,
          status: 'met',
          timing: `${Math.round(elapsedMin)}min`,
        });
      } else {
        benchmarksMissed++;
        doctrineDetails.push({
          action: bm.description as string,
          status: 'late',
          timing: `${Math.round(elapsedMin)}min (limit: ${timingLimit}min)`,
        });
      }
    } else {
      benchmarksMissed++;
      doctrineDetails.push({
        action: bm.description as string,
        status: 'missed',
        timing: timingLimit != null ? `limit was ${timingLimit}min` : 'no limit',
      });
    }
  }

  // Build format analysis from player posts with engagement logs
  const formattedPosts = posts.filter(
    (p: Record<string, unknown>) =>
      p.author_type === 'player' && p.post_format && p.post_format !== 'text',
  );

  const formatAnalysis: SocialMediaAARData['format_analysis'] = [];
  for (const fp of formattedPosts) {
    const { data: engLogs } = await supabaseAdmin
      .from('post_engagement_log')
      .select('tick_number, impressions_added, npc_likes_added')
      .eq('post_id', fp.id as string)
      .order('tick_number', { ascending: true });

    formatAnalysis.push({
      post_id: fp.id as string,
      post_format: fp.post_format as string,
      content_preview: (fp.content as string).substring(0, 200),
      grade: (fp.sop_compliance_score || {}) as Record<string, unknown>,
      peak_views: (fp.view_count as number) || 0,
      peak_likes: (fp.like_count as number) || 0,
      engagement_trajectory: (engLogs || []).map((l: Record<string, unknown>) => ({
        tick: l.tick_number as number,
        views: l.impressions_added as number,
        likes: l.npc_likes_added as number,
      })),
    });
  }

  // Impression dominance. Protagonist ally pages count toward player views.
  const { data: orgRows } = await supabaseAdmin
    .from('sim_org_pages')
    .select('page_handle, role')
    .eq('session_id', sessionId);
  const protagonistPageHandles = new Set(
    (orgRows || [])
      .filter((r: Record<string, unknown>) => String(r.role) !== 'antagonist')
      .map((r: Record<string, unknown>) => String(r.page_handle || '')),
  );
  const playerViews = posts
    .filter(
      (p: Record<string, unknown>) =>
        p.author_type === 'player' ||
        (p.author_type === 'official_account' &&
          protagonistPageHandles.has(String(p.author_handle))),
    )
    .reduce((s: number, p: Record<string, unknown>) => s + (Number(p.view_count) || 0), 0);
  const hostileViews = posts
    .filter((p: Record<string, unknown>) => {
      const flags = (p.content_flags || {}) as Record<string, unknown>;
      return !!(
        flags.is_hate_speech ||
        flags.is_harmful_narrative ||
        flags.is_misinformation ||
        flags.is_racist ||
        flags.is_inflammatory ||
        flags.incites_violence ||
        flags.is_organized_pressure
      );
    })
    .reduce((s: number, p: Record<string, unknown>) => s + (Number(p.view_count) || 0), 0);

  // Per-team debrief (fixed teams). Reuses the live team-score rollup; adds
  // each team's best/worst graded artifact for the trainer's talking points.
  let teamPerformance: SocialMediaAARData['team_performance'] = [];
  try {
    const teamReport = await computeTeamScores(sessionId);
    teamPerformance = teamReport.teams.map((team) => {
      const memberIds = new Set(team.members.map((m) => m.user_id));

      let best: { content: string; overall: number } | null = null;
      let worst: { content: string; overall: number } | null = null;
      const consider = (author: unknown, content: unknown, score: unknown) => {
        if (!author || !memberIds.has(String(author))) return;
        const grade = (score || {}) as Record<string, unknown>;
        const overall = Number(grade.overall);
        if (Number.isNaN(overall)) return;
        const preview = String(content || '').substring(0, 200);
        if (!best || overall > best.overall) best = { content: preview, overall };
        if (!worst || overall < worst.overall) worst = { content: preview, overall };
      };
      for (const p of posts) {
        consider(p.posted_by_user_id, p.content, p.sop_compliance_score);
      }
      for (const e of emails) {
        consider(
          e.sent_by_player_id,
          `${e.subject || ''}\n${e.body_text || ''}`,
          e.sop_compliance_score,
        );
      }

      return {
        team_name: team.team_name,
        mission: team.mission,
        member_count: team.member_count,
        composite_score: team.composite_score,
        content_quality: team.content_quality,
        task_completion: team.task_completion,
        role_fit: team.role_fit,
        collaboration: team.collaboration,
        intel_held: team.intel_held,
        intel_shared_count: team.intel_shared_count,
        tasks_done: team.tasks_done,
        tasks_total: team.tasks_total,
        task_outcomes: team.tasks.map((t) => ({
          description: t.description,
          status: t.status,
          on_time: t.on_time,
        })),
        members: team.members.map((m) => ({
          display_name: m.display_name,
          graded_items: m.graded_items,
          avg_overall: m.avg_overall,
          avg_role_fit: m.avg_role_fit,
        })),
        best_artifact: best,
        worst_artifact: worst,
      };
    });
  } catch {
    /* teamless/legacy scenario or scoring failure — AAR still renders */
  }

  return {
    response_timeline: responseTimeline,
    sop_compliance: {
      steps_completed: 0,
      steps_total: 0,
      steps_overdue: 0,
      completion_percentage: 0,
      details: [],
    },
    content_quality: {
      posts_created: playerPosts.length,
      average_accuracy: avgGrades.accuracy,
      average_tone: avgGrades.tone,
      average_sensitivity: avgGrades.sensitivity,
      average_persuasiveness: avgGrades.persuasiveness,
      average_overall: avgGrades.overall,
      graded_responses: grades.map((g) => ({
        content: g.content,
        grade: g.grade,
        created_at: g.created_at,
      })),
    },
    sentiment_trajectory: sentimentSnapshots.map((s: Record<string, unknown>) => ({
      recorded_at: s.recorded_at as string,
      sentiment_score: s.sentiment_score as number,
      media_attention: s.media_attention as number,
      political_pressure: s.political_pressure as number,
    })),
    missed_opportunities: missed.map((p: Record<string, unknown>) => ({
      post_id: p.id as string,
      content: (p.content as string).substring(0, 200),
      sentiment: (p.sentiment as string) || 'unknown',
      requires_response: true,
      was_responded: false,
    })),
    coordination_metrics: {
      total_chat_messages: totalMessages,
      total_emails_sent: outboundEmails.length,
      total_player_actions: actions.length,
      actions_by_type: actionsByType,
      avg_internal_messages_before_response: 0,
    },
    strategic_scorecard: {
      tier1_count: tier1,
      tier2_count: tier2,
      tier3_count: tier3,
      strategic_ratio: strategicRatio,
      total_actions: totalTiered,
    },
    sentiment_dimensions: {
      final_public_trust: (socialState.public_trust as number) ?? 50,
      final_community_safety: (socialState.community_safety as number) ?? 50,
      final_narrative_control: (socialState.narrative_control as number) ?? 50,
      final_escalation_risk: (socialState.escalation_risk as number) ?? 50,
      final_overall: (socialState.sentiment_score as number) ?? 50,
    },
    doctrine_compliance: {
      benchmarks_met: benchmarksMet,
      benchmarks_missed: benchmarksMissed,
      benchmarks_total: benchmarks.length,
      details: doctrineDetails,
    },
    format_analysis: formatAnalysis,
    impression_dominance: {
      player_total_views: playerViews,
      hostile_total_views: hostileViews,
      ratio:
        hostileViews > 0
          ? Math.round((playerViews / hostileViews) * 100) / 100
          : playerViews > 0
            ? 999
            : 0,
    },
    team_performance: teamPerformance,
    stakeholder_preemption: await buildStakeholderPreemption(sessionId),
    executive_decisions: await buildExecutiveDecisions(sessionId),
  };
}

async function buildExecutiveDecisions(
  sessionId: string,
): Promise<SocialMediaAARData['executive_decisions']> {
  try {
    const { listDecisions, listDecisionEvents, loadKnowledge } =
      await import('./decisions/decisionLedger.js');
    const { getSessionScenarioId } = await import('../lib/scenarioCache.js');
    const { getStakeholders } = await import('./stakeholderService.js');
    const [decisions, events, scenarioId] = await Promise.all([
      listDecisions(sessionId),
      listDecisionEvents(sessionId),
      getSessionScenarioId(sessionId),
    ]);
    if (decisions.length === 0) return [];
    const stakeholders = scenarioId ? await getStakeholders(scenarioId) : [];
    const nameOf = new Map(stakeholders.map((s) => [s.id, `${s.name} (${s.title})`]));
    const label = (kind: string, id: string) =>
      kind === 'stakeholder' ? (nameOf.get(id) ?? id) : id;
    const out: SocialMediaAARData['executive_decisions'] = [];
    for (const d of decisions) {
      const knowledge = await loadKnowledge(sessionId, d.id);
      const mine = events.filter((e) => e.decision_id === d.id);
      const outcomeFor = (injectId: string | null | undefined, fired: boolean) => {
        if (!injectId) return fired ? 'fired' : 'pending';
        const v = mine.filter((e) => e.ref_id === injectId);
        if (v.some((e) => e.kind === 'reaction_withdrawn')) return 'withdrawn';
        if (v.some((e) => e.kind === 'reaction_softened')) return 'softened';
        if (!fired && v.some((e) => e.kind === 'reaction_delayed')) return 'held';
        return fired ? 'fired' : 'pending';
      };
      const nodes = d.detail.plan?.nodes ?? [];
      const publicNodes = nodes.filter(
        (n) =>
          n.fired_at_minute != null &&
          (n.kind === 'public' ||
            n.channel === 'social_post' ||
            n.channel === 'page_statement' ||
            n.channel === 'news'),
      );
      out.push({
        decision_id: d.id,
        summary: d.detail.summary,
        category: d.detail.category,
        at_minute: d.detail.detected_at_minute,
        decided_by: d.team_name,
        by_trainer: d.recorded_by_trainer,
        org_key: d.org_key,
        status: d.status,
        informed: d.detail.informed.map((a) => label(a.actor_kind, a.actor_id)),
        should_know_not_told: d.detail.should_know_stakeholder_ids
          .filter((id) => {
            const k = knowledge.get(`stakeholder:${id}`);
            return !k || (k.learned_via !== 'direct_message' && k.learned_via !== 'formal_notice');
          })
          .map((id) => nameOf.get(id) ?? id),
        found_out: Array.from(knowledge.values())
          .filter(
            (k) =>
              k.learned_via === 'internal_relay' ||
              k.learned_via === 'grievance_relay' ||
              k.learned_via === 'public_exposure',
          )
          .filter(
            (k) =>
              k.actor_kind === 'stakeholder' &&
              stakeholders.find((s) => s.id === k.actor_id)?.tier !== 'roster',
          )
          .map((k) => ({
            actor: nameOf.get(k.actor_id) ?? k.actor_id,
            via: k.learned_via || 'unknown',
            at_minute: k.at_minute,
          })),
        notice: d.detail.notice
          ? {
              at_minute: d.detail.notice.at_minute,
              order_ok: d.detail.notice.order_ok,
              before_leak: d.detail.notice.before_leak,
              tone_grade: d.detail.notice.tone_grade,
              coverage: d.detail.notice.coverage,
            }
          : null,
        reactions: nodes
          .filter((n) => n.kind !== 'relay')
          .map((n) => ({
            actor: n.actor_kind === 'page' ? n.actor_id : (nameOf.get(n.actor_id) ?? n.actor_id),
            channel: n.channel,
            title: n.content.title,
            planned_minute: d.detail.detected_at_minute + n.delay_minutes,
            fired_minute: n.fired_at_minute ?? null,
            outcome: outcomeFor(n.inject_id, n.fired_at_minute != null) as
              | 'fired'
              | 'withdrawn'
              | 'softened'
              | 'held'
              | 'pending',
          })),
        public_effect: {
          posts: publicNodes.filter((n) => n.channel !== 'news').length,
          articles: publicNodes.filter((n) => n.channel === 'news').length,
        },
      });
    }
    return out;
  } catch (err) {
    logger.warn({ err, sessionId }, 'buildExecutiveDecisions failed');
    return [];
  }
}

async function buildStakeholderPreemption(
  sessionId: string,
): Promise<SocialMediaAARData['stakeholder_preemption']> {
  try {
    const [{ data: events }, { data: session }] = await Promise.all([
      supabaseAdmin
        .from('session_events')
        .select('event_type, description, metadata, created_at')
        .eq('session_id', sessionId)
        .in('event_type', ['inject_cancelled', 'inject_modified', 'inject_delayed'])
        .order('created_at', { ascending: true }),
      supabaseAdmin.from('sessions').select('start_time').eq('id', sessionId).maybeSingle(),
    ]);
    const startMs = session?.start_time ? new Date(session.start_time as string).getTime() : null;
    const out: SocialMediaAARData['stakeholder_preemption'] = [];
    for (const e of events ?? []) {
      const meta = (e.metadata as Record<string, unknown>) ?? {};
      if (meta.source !== 'stakeholder') continue;
      if (e.event_type === 'inject_cancelled' && meta.reason === 'modified') continue; // twin of inject_modified
      const verdict =
        e.event_type === 'inject_cancelled'
          ? 'cancel'
          : e.event_type === 'inject_modified'
            ? 'modify'
            : 'delay';
      const title = String(e.description ?? '')
        .replace(/^Inject withdrawn by [^:]+:\s*/, '')
        .replace(/^[^"]*"([^"]+)".*$/, '$1')
        .split(' — ')[0];
      out.push({
        team: (meta.credited_team as string | null) ?? null,
        contributing_teams: (meta.contributing_teams as string[]) ?? [],
        stakeholder_name: String(meta.stakeholder_name ?? meta.stakeholder_id ?? 'Stakeholder'),
        inject_title: title,
        verdict,
        at_minute:
          startMs != null
            ? Math.round((new Date(e.created_at as string).getTime() - startMs) / 60000)
            : null,
        reason: String(meta.reason ?? ''),
        criteria_met: (meta.criteria_met as number[]) ?? [],
      });
    }
    return out;
  } catch {
    return [];
  }
}
