import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { getWebSocketService } from './websocketService.js';
import { logger } from '../lib/logger.js';
import { EXTREMIST_HANDLES } from './extremistDoctrine.js';

export interface SocialState {
  total_posts: number;
  player_post_count: number;
  npc_harmful_post_count: number;
  /** @deprecated Use npc_harmful_post_count */
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
  stakeholder_statement_issued: boolean;
  /** @deprecated Use stakeholder_statement_issued */
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

  player_posted_creative_format: boolean;
  player_posted_official_statement: boolean;
  impression_dominance_ratio: number;

  // Semantic signals (aggregated from AI content grading)
  signal_acknowledged_affected_parties: boolean;
  signal_no_collective_blame: boolean;
  signal_includes_actionable_guidance: boolean;
  signal_includes_safety_info: boolean;
  signal_avoids_harmful_amplification: boolean;
  signal_cites_verified_sources: boolean;
  signal_promotes_constructive_dialogue: boolean;
  signal_addresses_specific_claims: boolean;
  /** @deprecated Use signal_acknowledged_affected_parties */ signal_acknowledged_victims: boolean;
  /** @deprecated Use signal_includes_actionable_guidance */ signal_includes_support_resources: boolean;
  /** @deprecated Use signal_includes_safety_info */ signal_includes_safety_guidance: boolean;
  /** @deprecated Use signal_avoids_harmful_amplification */ signal_avoided_group_targeting: boolean;
  /** @deprecated Use signal_cites_verified_sources */ signal_includes_links_to_sources: boolean;
  /** @deprecated Use signal_promotes_constructive_dialogue */ signal_calls_for_unity: boolean;
  /** @deprecated Use signal_addresses_specific_claims */ signal_addresses_specific_misinfo: boolean;

  // Action-pattern flags
  player_used_leader_amplification: boolean;
  player_executed_multi_platform_blitz: boolean;
  player_used_strategic_silence: boolean;
  player_pinned_verified_update: boolean;
  player_is_actively_moderating: boolean;
  /** @deprecated Use player_is_actively_moderating */
  player_is_actively_moderating_hate_speech: boolean;
  player_message_is_consistent_across_channels: boolean;
  player_message_inconsistent_across_channels: boolean;

  dimension_labels?: {
    public_trust: string;
    community_safety: string;
    narrative_control: string;
    escalation_risk: string;
  };
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
        'id, author_type, author_handle, content_flags, sentiment, is_flagged_by_player, reply_to_post_id, created_at, inject_id, sop_compliance_score, virality_score, content, view_count, post_format, platform',
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
  let dimensionLabels:
    | {
        public_trust: string;
        community_safety: string;
        narrative_control: string;
        escalation_risk: string;
      }
    | undefined;

  if (scenarioId) {
    const { data: scenario } = await supabaseAdmin
      .from('scenarios')
      .select('initial_state')
      .eq('id', scenarioId)
      .single();

    const is = (scenario?.initial_state || {}) as Record<string, unknown>;
    const personas = (is.npc_personas || []) as Array<Record<string, unknown>>;
    npcHandles = new Set(personas.map((p) => String(p.handle || '')).filter(Boolean));

    const dl = is.dimension_labels as Record<string, string> | undefined;
    if (dl) {
      dimensionLabels = {
        public_trust: dl.public_trust || 'Public Trust',
        community_safety: dl.community_safety || 'Stakeholder Confidence',
        narrative_control: dl.narrative_control || 'Narrative Control',
        escalation_risk: dl.escalation_risk || 'Escalation Risk',
      };
    }
  }

  // Antagonist (rival) org pages post hostile content as official_account; weight
  // them like designed NPCs (3x). Protagonist ally pages count toward player dominance.
  const antagonistHandles = new Set<string>();
  const protagonistHandles = new Set<string>();
  {
    const { data: orgRows } = await supabaseAdmin
      .from('sim_org_pages')
      .select('page_handle, role')
      .eq('session_id', sessionId);
    for (const r of orgRows || []) {
      const h = String(r.page_handle || '');
      if (!h) continue;
      if (String(r.role) === 'antagonist') antagonistHandles.add(h);
      else protagonistHandles.add(h);
    }
  }

  const topLevelPosts = allPosts.filter((p) => !p.reply_to_post_id);
  const playerReplies = allPosts.filter((p) => p.author_type === 'player' && !!p.reply_to_post_id);
  const playerRepliedToIds = new Set(playerReplies.map((p) => String(p.reply_to_post_id)));
  const flaggedIds = new Set(
    allActions.filter((a) => a.action_type === 'post_flagged').map((a) => String(a.target_id)),
  );

  const hasHarmfulFlags = (p: (typeof allPosts)[number]): boolean => {
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
  };

  const isDesignedNPCPost = (p: (typeof allPosts)[number]): boolean => {
    const handle = String(p.author_handle);
    return (
      !!p.inject_id ||
      npcHandles.has(handle) ||
      antagonistHandles.has(handle) ||
      EXTREMIST_HANDLES.has(handle)
    );
  };

  // Top-level harmful posts (any non-player author) PLUS in-thread harmful
  // replies authored by DESIGNED NPCs (hive / antagonist / scenario personas /
  // inject-sourced). Ordinary NPC pile-on replies carry no harmful flags, and
  // player replies are excluded, so only deliberate agitator replies count.
  const harmfulTopLevel = topLevelPosts.filter(
    (p) => p.author_type !== 'player' && hasHarmfulFlags(p),
  );
  const harmfulDesignedReplies = allPosts.filter(
    (p) =>
      !!p.reply_to_post_id &&
      p.author_type !== 'player' &&
      hasHarmfulFlags(p) &&
      isDesignedNPCPost(p),
  );
  const harmfulPosts = [...harmfulTopLevel, ...harmfulDesignedReplies];

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
    const handle = String(post.author_handle);
    const isDesignedNPC =
      !!post.inject_id ||
      npcHandles.has(handle) ||
      antagonistHandles.has(handle) ||
      EXTREMIST_HANDLES.has(handle);
    const weight = isDesignedNPC ? 3 : 1;

    let ageTier = 0;
    if (ageMinutes < 2) ageTier = 0;
    else if (ageMinutes < 5) ageTier = 1;
    else if (ageMinutes < 10) ageTier = 2;
    else if (ageMinutes < 15) ageTier = 3;
    else ageTier = 4;

    weightedHatePenalty += ageTier * weight;

    if (
      flags.is_hate_speech ||
      flags.is_racist ||
      flags.incites_violence ||
      flags.is_harmful_narrative ||
      flags.is_inflammatory
    ) {
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
      /leader|imam|pastor|rabbi|priest|community|interfaith|ceo|chairman|director|regulator|commissioner|spokesperson|counsel|attorney|board|stakeholder|governor|mayor|minister/i.test(
        String(a.content || '') + String(a.target_id || ''),
      ),
  );
  const officialDrafted = allActions.some((a) => a.action_type === 'draft_created');
  const officialPublished = allActions.some((a) => a.action_type === 'draft_published');
  const platformReports = allActions.filter((a) => a.action_type === 'post_reported').length;

  const rallyPosts = unattendedPosts.filter((p) => {
    const flags = (p.content_flags || {}) as Record<string, unknown>;
    return (
      !!flags.incites_violence ||
      !!flags.is_organized_pressure ||
      /rally|gather|march|patrol|meet up|boycott|protest|class.action|petition|walkout|strike/i.test(
        String(p.content || ''),
      )
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

  // Impression-dominance-based narrative control. Protagonist ally pages
  // (official_account posts on the players' side) count toward player views.
  const allyPagePosts = allPosts.filter(
    (p) => p.author_type === 'official_account' && protagonistHandles.has(String(p.author_handle)),
  );
  const playerTotalViews =
    playerPosts.reduce((s, p) => s + (Number(p.view_count) || 0), 0) +
    allyPagePosts.reduce((s, p) => s + (Number(p.view_count) || 0), 0);
  const hostileTotalViews = harmfulPosts.reduce((s, p) => s + (Number(p.view_count) || 0), 0);
  const impressionRatio =
    hostileTotalViews > 0 ? playerTotalViews / hostileTotalViews : playerTotalViews > 0 ? 2.0 : 0;

  let narrativeControl = 20 + Math.min(impressionRatio, 2.0) * 30;
  narrativeControl += officialPublished ? 10 : 0;
  narrativeControl += avgGradePersuasiveness > 0 ? (avgGradePersuasiveness - 50) / 5 : 0;
  narrativeControl -= weightedHatePenalty * 0.5;

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

  // Reweighted composite: narrative_control at 40%
  let sentimentScore = Math.round(
    0.2 * publicTrust +
      0.2 * communitySafety +
      0.4 * narrativeControl +
      0.2 * (100 - escalationRisk),
  );

  // Strategic ratio multiplier
  if (strategicRatio > 0.4 && totalActions > 5) sentimentScore = Math.round(sentimentScore * 1.1);
  if (strategicRatio < 0.2 && totalActions > 5) sentimentScore = Math.round(sentimentScore * 0.85);
  sentimentScore = Math.max(0, Math.min(100, sentimentScore));

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

  // Strategy pattern detection bonuses (must be after sopCompleted is defined)
  const factCheckAction = allActions.find((a) => a.action_type === 'fact_checked');
  const factCheckThenPost =
    !!factCheckAction &&
    allActions.some(
      (a) =>
        a.action_type === 'post_created' &&
        new Date(a.created_at) > new Date(factCheckAction.created_at),
    );
  const draftApprovePublish =
    sopCompleted('draft') && sopCompleted('approve') && sopCompleted('publish');
  if (factCheckThenPost) narrativeControl += 5;
  if (draftApprovePublish) narrativeControl += 5;
  narrativeControl = Math.max(0, Math.min(100, Math.round(narrativeControl)));

  const state: SocialState = {
    total_posts: allPosts.length,
    player_post_count: playerPostCount,
    npc_harmful_post_count: harmfulPosts.length,
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
    stakeholder_statement_issued: communityLeaderContacted && officialPublished,
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

    player_posted_creative_format: playerPosts.some((p) =>
      ['humor_meme', 'video_concept'].includes(String(p.post_format || '')),
    ),
    player_posted_official_statement: playerPosts.some(
      (p) => String(p.post_format || '') === 'official_statement',
    ),
    impression_dominance_ratio: Math.round(impressionRatio * 100) / 100,

    // Aggregate semantic signals from graded player posts (reads both new and legacy signal names)
    ...(() => {
      const signalDefaults = {
        signal_acknowledged_affected_parties: false,
        signal_no_collective_blame: false,
        signal_includes_actionable_guidance: false,
        signal_includes_safety_info: false,
        signal_avoids_harmful_amplification: false,
        signal_cites_verified_sources: false,
        signal_promotes_constructive_dialogue: false,
        signal_addresses_specific_claims: false,
        signal_acknowledged_victims: false,
        signal_includes_support_resources: false,
        signal_includes_safety_guidance: false,
        signal_avoided_group_targeting: false,
        signal_includes_links_to_sources: false,
        signal_calls_for_unity: false,
        signal_addresses_specific_misinfo: false,
      };
      for (const gp of gradedPosts) {
        const score = (gp.sop_compliance_score || {}) as Record<string, unknown>;
        const signals = (score.signals || {}) as Record<string, boolean>;
        if (signals.acknowledged_affected_parties || signals.acknowledged_victims) {
          signalDefaults.signal_acknowledged_affected_parties = true;
          signalDefaults.signal_acknowledged_victims = true;
        }
        if (signals.no_collective_blame) signalDefaults.signal_no_collective_blame = true;
        if (signals.includes_actionable_guidance || signals.includes_support_resources) {
          signalDefaults.signal_includes_actionable_guidance = true;
          signalDefaults.signal_includes_support_resources = true;
        }
        if (signals.includes_safety_info || signals.includes_safety_guidance) {
          signalDefaults.signal_includes_safety_info = true;
          signalDefaults.signal_includes_safety_guidance = true;
        }
        if (signals.avoids_harmful_amplification || signals.avoided_group_targeting) {
          signalDefaults.signal_avoids_harmful_amplification = true;
          signalDefaults.signal_avoided_group_targeting = true;
        }
        if (signals.cites_verified_sources || signals.includes_links_to_sources) {
          signalDefaults.signal_cites_verified_sources = true;
          signalDefaults.signal_includes_links_to_sources = true;
        }
        if (signals.promotes_constructive_dialogue || signals.calls_for_unity) {
          signalDefaults.signal_promotes_constructive_dialogue = true;
          signalDefaults.signal_calls_for_unity = true;
        }
        if (signals.addresses_specific_claims || signals.addresses_specific_misinfo) {
          signalDefaults.signal_addresses_specific_claims = true;
          signalDefaults.signal_addresses_specific_misinfo = true;
        }
      }
      return signalDefaults;
    })(),

    // Action-pattern flags
    player_used_leader_amplification: communityLeaderContacted,
    player_executed_multi_platform_blitz: (() => {
      const hasXPost = playerPosts.some(
        (p) => String(p.platform || '') === 'x_twitter' && !p.reply_to_post_id,
      );
      const hasFBPost = playerPosts.some(
        (p) => String(p.platform || '') === 'facebook' && !p.reply_to_post_id,
      );
      return hasXPost && hasFBPost;
    })(),
    player_used_strategic_silence: (() => {
      const hostileCount = harmfulPosts.length;
      return hostileCount > 3 && tier1 < hostileCount * 0.5;
    })(),
    player_pinned_verified_update: playerPosts.some(
      (p) => String(p.post_format || '') === 'official_statement',
    ),
    player_is_actively_moderating: misinfoFlagged > 2,
    player_is_actively_moderating_hate_speech: misinfoFlagged > 2,
    player_message_is_consistent_across_channels: (() => {
      const xPosts = playerPosts.filter(
        (p) => String(p.platform || '') === 'x_twitter' && !p.reply_to_post_id,
      );
      const fbPosts = playerPosts.filter(
        (p) => String(p.platform || '') === 'facebook' && !p.reply_to_post_id,
      );
      if (xPosts.length === 0 || fbPosts.length === 0) return false;
      return true;
    })(),
    player_message_inconsistent_across_channels: false,

    dimension_labels: dimensionLabels,
  };

  const currentState = (sessionRow?.current_state as Record<string, unknown>) || {};
  const updatedState = { ...currentState, social_state: state };

  await supabaseAdmin.from('sessions').update({ current_state: updatedState }).eq('id', sessionId);

  getWebSocketService().broadcastToSession(sessionId, {
    type: 'social_state.updated',
    data: { ...state },
    timestamp: new Date().toISOString(),
  });

  void evaluateConsequenceTriggers(sessionId, state, elapsedMinutes).catch((err) =>
    logger.warn({ err, sessionId }, 'Consequence trigger evaluation failed'),
  );

  return state;
}

const previousStates = new Map<string, Record<string, unknown>>();

export async function evaluateConsequenceTriggers(
  sessionId: string,
  state: SocialState,
  elapsedMinutes: number,
): Promise<void> {
  const { generateConsequenceInject } = await import('./ambientContentService.js');

  const prev = (previousStates.get(sessionId) || {}) as Partial<SocialState>;
  previousStates.set(sessionId, { ...state });

  if (
    state.oldest_unaddressed_hate_minutes > 10 &&
    (prev.oldest_unaddressed_hate_minutes || 0) <= 10
  ) {
    void generateConsequenceInject(
      sessionId,
      'hate_unaddressed_10min',
      'A concerned stakeholder posts about feeling abandoned. Harmful content has been circulating for over 10 minutes with no official response or flagging from the response team.',
      'negative',
      false,
    );
  }

  if (
    state.oldest_unaddressed_misinfo_minutes > 10 &&
    (prev.oldest_unaddressed_misinfo_minutes || 0) <= 10
  ) {
    void generateConsequenceInject(
      sessionId,
      'misinfo_unaddressed_10min',
      'Someone shares the unaddressed misinformation as if it were confirmed fact. "Just saw that [the false claim] is true! Why isn\'t anyone saying anything?"',
      'negative',
      false,
    );
  }

  if (
    elapsedMinutes > 20 &&
    !state.official_statement_published &&
    prev.official_statement_published === undefined
  ) {
    void generateConsequenceInject(
      sessionId,
      'no_statement_20min',
      'A journalist or media commentator notes that 20 minutes have passed since the crisis began and there has been no official response from the response team.',
      'negative',
      false,
    );
  }

  if (elapsedMinutes > 35 && !state.official_statement_published) {
    void generateConsequenceInject(
      sessionId,
      'no_statement_35min',
      'A senior journalist tweets about the conspicuous silence from the official response team, questioning whether anyone is managing the situation at all.',
      'inflammatory',
      false,
    );
  }

  if (
    state.strategic_ratio < 0.2 &&
    state.tier1_reactive_actions > 6 &&
    (prev.tier1_reactive_actions || 0) <= 6
  ) {
    void generateConsequenceInject(
      sessionId,
      'trench_warfare',
      'A media observer notes that the response team seems to be stuck replying to individual posts rather than publishing an official coordinated response.',
      'negative',
      false,
    );
  }

  if (state.rally_call_active && !prev.rally_call_active) {
    void generateConsequenceInject(
      sessionId,
      'rally_gaining_traction',
      'People are sharing and responding positively to a call for organized collective action. The movement is gaining traction online.',
      'inflammatory',
      false,
    );
  }

  if (state.community_leader_contacted && !prev.community_leader_contacted) {
    void generateConsequenceInject(
      sessionId,
      'leader_contacted',
      'A key stakeholder posts a message of support and calm after being contacted by the response team. They thank the team for reaching out and urge the public to remain measured.',
      'supportive',
      true,
    );
  }

  if (state.official_statement_published && !prev.official_statement_published) {
    void generateConsequenceInject(
      sessionId,
      'statement_published',
      'A news outlet or verified media account shares the official statement from the response team, noting it as the first official response to the crisis.',
      'positive',
      true,
    );
  }

  if (state.narrative_control > 50 && (prev.narrative_control || 0) <= 50) {
    void generateConsequenceInject(
      sessionId,
      'narrative_recovering',
      'A regular citizen posts something supportive: "Finally seeing some clarity in this feed. Facts matter. Don\'t let the noise drown out the truth."',
      'supportive',
      true,
    );
  }

  if (state.narrative_control < 20 && (prev.narrative_control || 0) >= 20) {
    void generateConsequenceInject(
      sessionId,
      'narrative_collapsing',
      'The hostile narrative is now dominant. Concerned stakeholders are expressing alarm. Mainstream media is covering the growing public backlash spiraling out of control.',
      'negative',
      false,
    );
  }
}
