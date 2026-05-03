import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { getWebSocketService } from './websocketService.js';

export interface SocialState {
  total_posts: number;
  player_post_count: number;
  npc_hate_post_count: number;
  unaddressed_hate_count: number;
  unaddressed_misinfo_count: number;
  oldest_unaddressed_hate_minutes: number;
  oldest_unaddressed_misinfo_minutes: number;
  counter_narratives_published: number;
  misinformation_flagged_count: number;

  sentiment_score: number;
  public_trust: number;
  community_safety: number;
  narrative_control: number;
  escalation_risk: number;

  community_leader_contacted: boolean;
  interfaith_statement_issued: boolean;
  platform_reports_filed: number;
  official_statement_drafted: boolean;
  official_statement_published: boolean;
  rally_call_active: boolean;

  sop_monitor_completed: boolean;
  sop_assess_completed: boolean;
  sop_fact_check_completed: boolean;
  sop_escalate_completed: boolean;
  sop_draft_completed: boolean;
  sop_publish_completed: boolean;
  sop_monitor_overdue: boolean;
  sop_assess_overdue: boolean;
  sop_draft_overdue: boolean;
  sop_publish_overdue: boolean;

  tier1_reactive_actions: number;
  tier2_strategic_actions: number;
  tier3_advanced_actions: number;
  strategic_ratio: number;
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

export async function computeSocialState(
  sessionId: string,
  elapsedMinutes: number,
): Promise<SocialState> {
  const now = Date.now();

  const [postsResult, actionsResult, gradeResult] = await Promise.all([
    supabaseAdmin
      .from('social_posts')
      .select(
        'id, author_type, author_handle, content_flags, sentiment, is_flagged_by_player, reply_to_post_id, created_at, inject_id, sop_compliance_score, virality_score, content',
      )
      .eq('session_id', sessionId),
    supabaseAdmin
      .from('player_actions')
      .select('action_type, target_id, content, metadata, sop_step_matched, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true }),
    supabaseAdmin
      .from('social_posts')
      .select('sop_compliance_score')
      .eq('session_id', sessionId)
      .eq('author_type', 'player')
      .not('sop_compliance_score', 'is', null),
  ]);

  const allPosts = postsResult.data || [];
  const allActions = actionsResult.data || [];
  const gradedPosts = gradeResult.data || [];

  const { data: sessionRow } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id, current_state')
    .eq('id', sessionId)
    .single();

  const scenarioId = sessionRow?.scenario_id;
  let npcHandles: Set<string> = new Set();

  if (scenarioId) {
    const { data: scenario } = await supabaseAdmin
      .from('scenarios')
      .select('initial_state')
      .eq('id', scenarioId)
      .single();

    const is = (scenario?.initial_state || {}) as Record<string, unknown>;
    const personas = (is.npc_personas || []) as Array<Record<string, unknown>>;
    npcHandles = new Set(personas.map((p) => String(p.handle || '')).filter(Boolean));
  }

  const topLevelPosts = allPosts.filter((p) => !p.reply_to_post_id);
  const playerReplies = allPosts.filter((p) => p.author_type === 'player' && !!p.reply_to_post_id);
  const playerRepliedToIds = new Set(playerReplies.map((p) => String(p.reply_to_post_id)));
  const flaggedIds = new Set(
    allActions.filter((a) => a.action_type === 'post_flagged').map((a) => String(a.target_id)),
  );

  const harmfulPosts = topLevelPosts.filter((p) => {
    if (p.author_type === 'player') return false;
    const flags = (p.content_flags || {}) as Record<string, unknown>;
    return !!(
      flags.is_hate_speech ||
      flags.is_misinformation ||
      flags.is_racist ||
      flags.incites_violence
    );
  });

  const unattendedPosts = harmfulPosts.filter(
    (p) => !playerRepliedToIds.has(p.id) && !flaggedIds.has(p.id) && !p.is_flagged_by_player,
  );

  let weightedHatePenalty = 0;
  let oldestHateMinutes = 0;
  let oldestMisinfoMinutes = 0;
  let unaddressedHateCount = 0;
  let unaddressedMisinfoCount = 0;

  for (const post of unattendedPosts) {
    const flags = (post.content_flags || {}) as Record<string, unknown>;
    const ageMs = now - new Date(post.created_at).getTime();
    const ageMinutes = ageMs / 60000;
    const isDesignedNPC = !!post.inject_id || npcHandles.has(String(post.author_handle));
    const weight = isDesignedNPC ? 3 : 1;

    let ageTier = 0;
    if (ageMinutes < 2) ageTier = 0;
    else if (ageMinutes < 5) ageTier = 1;
    else if (ageMinutes < 10) ageTier = 2;
    else if (ageMinutes < 15) ageTier = 3;
    else ageTier = 4;

    weightedHatePenalty += ageTier * weight;

    if (flags.is_hate_speech || flags.is_racist || flags.incites_violence) {
      unaddressedHateCount++;
      if (ageMinutes > oldestHateMinutes) oldestHateMinutes = ageMinutes;
    }
    if (flags.is_misinformation) {
      unaddressedMisinfoCount++;
      if (ageMinutes > oldestMisinfoMinutes) oldestMisinfoMinutes = ageMinutes;
    }
  }

  const playerPosts = allPosts.filter((p) => p.author_type === 'player');
  const playerPostCount = playerPosts.length;
  const counterNarratives = playerPosts.filter((p) => !p.reply_to_post_id).length;
  const misinfoFlagged = flaggedIds.size;

  let tier1 = 0,
    tier2 = 0,
    tier3 = 0;
  for (const action of allActions) {
    if (TIER1_ACTIONS.includes(action.action_type)) tier1++;
    else if (TIER2_ACTIONS.includes(action.action_type)) tier2++;
    else if (TIER3_ACTIONS.includes(action.action_type)) tier3++;
  }
  const totalActions = tier1 + tier2 + tier3;
  const strategicRatio = totalActions > 0 ? (tier2 + tier3) / totalActions : 0;

  const communityLeaderContacted = allActions.some(
    (a) =>
      a.action_type === 'email_sent' &&
      /leader|imam|pastor|rabbi|priest|community|interfaith/i.test(
        String(a.content || '') + String(a.target_id || ''),
      ),
  );
  const officialDrafted = allActions.some((a) => a.action_type === 'draft_created');
  const officialPublished = allActions.some((a) => a.action_type === 'draft_published');
  const platformReports = allActions.filter((a) => a.action_type === 'post_reported').length;

  const rallyPosts = unattendedPosts.filter((p) => {
    const flags = (p.content_flags || {}) as Record<string, unknown>;
    return (
      !!flags.incites_violence || /rally|gather|march|patrol|meet up/i.test(String(p.content || ''))
    );
  });
  const rallyCallActive = rallyPosts.length > 0;

  let avgGradeAccuracy = 0,
    avgGradeTone = 0,
    avgGradeSensitivity = 0,
    avgGradePersuasiveness = 0;
  if (gradedPosts.length > 0) {
    let sumA = 0,
      sumT = 0,
      sumS = 0,
      sumP = 0;
    for (const gp of gradedPosts) {
      const g = (gp.sop_compliance_score || {}) as Record<string, number>;
      sumA += g.accuracy || 0;
      sumT += g.tone || 0;
      sumS += g.cultural_sensitivity || 0;
      sumP += g.persuasiveness || 0;
    }
    avgGradeAccuracy = sumA / gradedPosts.length;
    avgGradeTone = sumT / gradedPosts.length;
    avgGradeSensitivity = sumS / gradedPosts.length;
    avgGradePersuasiveness = sumP / gradedPosts.length;
  }

  let publicTrust = 50;
  publicTrust += avgGradeAccuracy > 0 ? (avgGradeAccuracy - 50) / 5 : 0;
  publicTrust += allActions.filter((a) => a.action_type === 'fact_checked').length * 3;
  publicTrust -= unaddressedMisinfoCount * 2;
  if (oldestMisinfoMinutes > 10) publicTrust -= Math.floor(oldestMisinfoMinutes / 5) * 2;

  let communitySafety = 40;
  communitySafety += communityLeaderContacted ? 15 : 0;
  communitySafety += avgGradeSensitivity > 0 ? (avgGradeSensitivity - 50) / 5 : 0;
  communitySafety += avgGradeTone > 0 ? (avgGradeTone - 50) / 8 : 0;
  const fearPosts = allPosts.filter(
    (p) => p.sentiment === 'negative' && p.author_type !== 'player' && !p.reply_to_post_id,
  );
  communitySafety -= Math.min(fearPosts.length, 10) * 1.5;
  if (rallyCallActive) communitySafety -= 10;

  let narrativeControl = 30;
  narrativeControl += counterNarratives * 8;
  narrativeControl += officialPublished ? 15 : 0;
  narrativeControl += avgGradePersuasiveness > 0 ? (avgGradePersuasiveness - 50) / 5 : 0;
  narrativeControl -= weightedHatePenalty * 0.8;
  if (strategicRatio < 0.2 && totalActions > 5) narrativeControl -= 3;

  let escalationRisk = 20;
  escalationRisk += rallyPosts.length * 12;
  const violencePosts = unattendedPosts.filter((p) => {
    const flags = (p.content_flags || {}) as Record<string, unknown>;
    return !!flags.incites_violence;
  });
  escalationRisk += violencePosts.length * 8;
  escalationRisk -= platformReports * 3;
  escalationRisk -= allActions.filter((a) => a.action_type === 'post_reported').length * 2;

  publicTrust = Math.max(0, Math.min(100, Math.round(publicTrust)));
  communitySafety = Math.max(0, Math.min(100, Math.round(communitySafety)));
  narrativeControl = Math.max(0, Math.min(100, Math.round(narrativeControl)));
  escalationRisk = Math.max(0, Math.min(100, Math.round(escalationRisk)));

  const sentimentScore = Math.round(
    0.25 * publicTrust +
      0.25 * communitySafety +
      0.3 * narrativeControl +
      0.2 * (100 - escalationRisk),
  );

  const sopActions = new Set(
    allActions.filter((a) => a.sop_step_matched).map((a) => a.sop_step_matched),
  );

  const sopTimeLimits: Record<string, number> = {};
  if (scenarioId) {
    const { data: sops } = await supabaseAdmin
      .from('sop_definitions')
      .select('steps')
      .eq('scenario_id', scenarioId)
      .limit(1);
    if (sops && sops.length > 0) {
      const steps = (sops[0].steps || []) as Array<{
        step_id: string;
        time_limit_minutes?: number;
      }>;
      for (const s of steps) {
        if (s.time_limit_minutes) sopTimeLimits[s.step_id] = s.time_limit_minutes;
      }
    }
  }

  const sopCompleted = (stepId: string) =>
    sopActions.has(stepId) || allActions.some((a) => a.sop_step_matched === stepId);
  const sopOverdue = (stepId: string) =>
    !sopCompleted(stepId) &&
    sopTimeLimits[stepId] != null &&
    elapsedMinutes > sopTimeLimits[stepId];

  const state: SocialState = {
    total_posts: allPosts.length,
    player_post_count: playerPostCount,
    npc_hate_post_count: harmfulPosts.length,
    unaddressed_hate_count: unaddressedHateCount,
    unaddressed_misinfo_count: unaddressedMisinfoCount,
    oldest_unaddressed_hate_minutes: Math.round(oldestHateMinutes),
    oldest_unaddressed_misinfo_minutes: Math.round(oldestMisinfoMinutes),
    counter_narratives_published: counterNarratives,
    misinformation_flagged_count: misinfoFlagged,

    sentiment_score: sentimentScore,
    public_trust: publicTrust,
    community_safety: communitySafety,
    narrative_control: narrativeControl,
    escalation_risk: escalationRisk,

    community_leader_contacted: communityLeaderContacted,
    interfaith_statement_issued: communityLeaderContacted && officialPublished,
    platform_reports_filed: platformReports,
    official_statement_drafted: officialDrafted,
    official_statement_published: officialPublished,
    rally_call_active: rallyCallActive,

    sop_monitor_completed: sopCompleted('monitor'),
    sop_assess_completed: sopCompleted('assess'),
    sop_fact_check_completed: sopCompleted('fact_check'),
    sop_escalate_completed: sopCompleted('escalate'),
    sop_draft_completed: sopCompleted('draft'),
    sop_publish_completed: sopCompleted('publish'),
    sop_monitor_overdue: sopOverdue('monitor'),
    sop_assess_overdue: sopOverdue('assess'),
    sop_draft_overdue: sopOverdue('draft'),
    sop_publish_overdue: sopOverdue('publish'),

    tier1_reactive_actions: tier1,
    tier2_strategic_actions: tier2,
    tier3_advanced_actions: tier3,
    strategic_ratio: Math.round(strategicRatio * 100) / 100,
  };

  const currentState = (sessionRow?.current_state as Record<string, unknown>) || {};
  const updatedState = { ...currentState, social_state: state };

  await supabaseAdmin.from('sessions').update({ current_state: updatedState }).eq('id', sessionId);

  getWebSocketService().broadcastToSession(sessionId, {
    type: 'social_state.updated',
    data: { ...state },
    timestamp: new Date().toISOString(),
  });

  return state;
}
