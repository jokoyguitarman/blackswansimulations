import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { getWebSocketService } from './websocketService.js';
import { logger } from '../lib/logger.js';
import { generateAmbientPosts } from './ambientContentService.js';

// ─── Platform Configuration ─────────────────────────────────────────────────

interface PlatformParams {
  recency_brackets: Array<{ max_minutes: number; decay: number }>;
  interaction_weights: Record<string, number>;
  base_engagement_rate: number;
  video_boost: number;
}

const PLATFORM_CONFIG: Record<string, PlatformParams> = {
  x_twitter: {
    recency_brackets: [
      { max_minutes: 3, decay: 1.0 },
      { max_minutes: 10, decay: 0.8 },
      { max_minutes: 20, decay: 0.5 },
      { max_minutes: 40, decay: 0.25 },
      { max_minutes: Infinity, decay: 0.1 },
    ],
    interaction_weights: { like: 1, repost: 5, reply: 3 },
    base_engagement_rate: 0.02,
    video_boost: 1.3,
  },
  facebook: {
    recency_brackets: [
      { max_minutes: 5, decay: 1.0 },
      { max_minutes: 15, decay: 0.9 },
      { max_minutes: 30, decay: 0.7 },
      { max_minutes: 60, decay: 0.5 },
      { max_minutes: Infinity, decay: 0.2 },
    ],
    interaction_weights: { like: 1, share: 4, comment: 4 },
    base_engagement_rate: 0.015,
    video_boost: 2.0,
  },
};

function getPlatformConfig(platform: string): PlatformParams {
  return PLATFORM_CONFIG[platform] || PLATFORM_CONFIG.x_twitter;
}

// ─── Format Multipliers ─────────────────────────────────────────────────────

const FORMAT_MULTIPLIER: Record<string, number> = {
  text: 1.0,
  official_statement: 0.9,
  infographic: 1.5,
  humor_meme: 3.0,
  video_concept: 4.0,
  personal_story: 2.0,
};

// ─── Content Engagement Rates ───────────────────────────────────────────────

function getContentEngagementRates(sentiment: string): { likeRate: number; repostRate: number } {
  switch (sentiment) {
    case 'hateful':
    case 'inflammatory':
      return { likeRate: 0.03 + Math.random() * 0.02, repostRate: 0.01 + Math.random() * 0.01 };
    case 'negative':
      return { likeRate: 0.02 + Math.random() * 0.02, repostRate: 0.01 };
    case 'supportive':
    case 'positive':
      return { likeRate: 0.01 + Math.random() * 0.01, repostRate: 0.005 + Math.random() * 0.005 };
    default:
      return { likeRate: 0.005 + Math.random() * 0.005, repostRate: 0.003 };
  }
}

// ─── Core Helpers ────────────────────────────────────────────────────────────

function getRecencyDecay(minutesSinceCreation: number, platform: string): number {
  const config = getPlatformConfig(platform);
  for (const bracket of config.recency_brackets) {
    if (minutesSinceCreation < bracket.max_minutes) return bracket.decay;
  }
  return 0.05;
}

function deriveBaseRate(authorType: string, followerCount: number, postFormat: string): number {
  let base: number;
  switch (authorType) {
    case 'npc_media':
    case 'npc_influencer':
      base = Math.max(200, followerCount * 0.03);
      break;
    case 'npc_politician':
      base = Math.max(300, followerCount * 0.025);
      break;
    case 'npc_public':
      base = Math.max(20, followerCount * 0.02);
      break;
    case 'official_account':
      base = 100 + Math.random() * 50;
      break;
    case 'player':
    default:
      base = 15 + Math.random() * 15;
      break;
  }
  return base * (FORMAT_MULTIPLIER[postFormat] || 1.0);
}

function getSuppressionFactor(flagCount: number, reported: boolean, removed: boolean): number {
  if (removed) return 0;
  if (reported) return 0.2;
  if (flagCount >= 2) return 0.4;
  if (flagCount === 1) return 0.7;
  return 1.0;
}

// ─── Per-session tick counter ────────────────────────────────────────────────

const sessionTickCounters = new Map<string, number>();

function getAndIncrementTick(sessionId: string): number {
  const current = sessionTickCounters.get(sessionId) || 0;
  sessionTickCounters.set(sessionId, current + 1);
  return current + 1;
}

// ─── Main Engagement Tick ────────────────────────────────────────────────────

export async function runEngagementTick(sessionId: string): Promise<void> {
  const tickNumber = getAndIncrementTick(sessionId);
  const now = Date.now();

  try {
    const { data: activePosts } = await supabaseAdmin
      .from('social_posts')
      .select(
        'id, author_type, author_handle, content, sentiment, post_format, platform, ' +
          'like_count, repost_count, reply_count, view_count, virality_score, ' +
          'impression_pool, engagement_rate, content_flags, ' +
          'reply_to_post_id, created_at, platform_removed, sop_compliance_score',
      )
      .eq('session_id', sessionId)
      .eq('platform_removed', false)
      .gte('created_at', new Date(now - 45 * 60 * 1000).toISOString())
      .is('reply_to_post_id', null);

    if (!activePosts || activePosts.length === 0) return;

    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id')
      .eq('id', sessionId)
      .single();

    const npcFollowerCounts = new Map<string, number>();
    if (session?.scenario_id) {
      const { data: scenario } = await supabaseAdmin
        .from('scenarios')
        .select('initial_state')
        .eq('id', session.scenario_id)
        .single();
      const personas = ((scenario?.initial_state as Record<string, unknown>)?.npc_personas ||
        []) as Array<Record<string, unknown>>;
      for (const p of personas) {
        npcFollowerCounts.set(String(p.handle || ''), Number(p.follower_count) || 500);
      }
    }

    const { data: recentFlags } = await supabaseAdmin
      .from('social_post_flags')
      .select('post_id')
      .in(
        'post_id',
        activePosts.map((p) => p.id),
      );

    const flagCounts = new Map<string, number>();
    for (const f of recentFlags || []) {
      flagCounts.set(f.post_id, (flagCounts.get(f.post_id) || 0) + 1);
    }

    const { data: recentPlayerLikes } = await supabaseAdmin
      .from('social_post_likes')
      .select('post_id, created_at')
      .in(
        'post_id',
        activePosts.map((p) => p.id),
      );

    const playerLikesPerPost = new Map<string, number>();
    for (const l of recentPlayerLikes || []) {
      playerLikesPerPost.set(l.post_id, (playerLikesPerPost.get(l.post_id) || 0) + 1);
    }

    const { data: playerActions } = await supabaseAdmin
      .from('player_actions')
      .select('action_type, target_id, content, metadata, created_at')
      .eq('session_id', sessionId)
      .in('action_type', ['post_reposted', 'post_reported']);

    const playerRepostsPerPost = new Map<string, number>();
    const reportedPosts = new Set<string>();
    for (const a of playerActions || []) {
      if (a.action_type === 'post_reposted' && a.target_id) {
        playerRepostsPerPost.set(a.target_id, (playerRepostsPerPost.get(a.target_id) || 0) + 1);
      }
      if (a.action_type === 'post_reported' && a.target_id) {
        reportedPosts.add(a.target_id);
      }
    }

    // Detect team rally: 2+ distinct player likes on the same post
    const teamRallyPosts = new Set<string>();
    const likesByPost = new Map<string, Set<string>>();
    for (const l of recentPlayerLikes || []) {
      if (!likesByPost.has(l.post_id)) likesByPost.set(l.post_id, new Set());
      // Each like row is from a distinct player due to UNIQUE constraint
      likesByPost.get(l.post_id)!.add(l.post_id);
    }
    // Count unique player likes (each row = 1 distinct player)
    for (const [postId] of likesByPost) {
      const likeCount = playerLikesPerPost.get(postId) || 0;
      if (likeCount >= 2) teamRallyPosts.add(postId);
    }

    // Check for amplification: community leader contacted -> boost player posts
    let leaderAmplificationActive = false;
    {
      const { data: leaderActions } = await supabaseAdmin
        .from('player_actions')
        .select('action_type, content, target_id')
        .eq('session_id', sessionId)
        .eq('action_type', 'email_sent');

      leaderAmplificationActive = (leaderActions || []).some((a) =>
        /leader|imam|pastor|rabbi|priest|community|interfaith/i.test(
          String(a.content || '') + String(a.target_id || ''),
        ),
      );
    }

    const updates: Array<{ id: string; changes: Record<string, number | boolean> }> = [];
    const logEntries: Array<Record<string, unknown>> = [];

    for (const post of activePosts) {
      const ageMs = now - new Date(post.created_at).getTime();
      const ageMinutes = ageMs / 60000;
      const platform = post.platform || 'x_twitter';
      const postFormat = post.post_format || 'text';
      const followerCount = npcFollowerCounts.get(post.author_handle) || 500;

      const baseRate = deriveBaseRate(post.author_type, followerCount, postFormat);
      const recencyDecay = getRecencyDecay(ageMinutes, platform);
      const flagCount = flagCounts.get(post.id) || 0;
      const isReported = reportedPosts.has(post.id);
      const suppression = getSuppressionFactor(flagCount, isReported, post.platform_removed);

      // Engagement velocity: player interactions count 5x
      const pLikes = playerLikesPerPost.get(post.id) || 0;
      const pReposts = playerRepostsPerPost.get(post.id) || 0;
      const playerInteractions = pLikes + pReposts;
      const npcInteractions = Math.max(0, (post.like_count || 0) - pLikes);
      const velocity =
        ageMinutes > 0
          ? (playerInteractions * 5 + npcInteractions * 0.1) / Math.max(1, ageMinutes)
          : 0;

      let algorithmBoost = 1.0 + Math.min(velocity * 0.5, 10.0);

      // Team rally bonus
      if (teamRallyPosts.has(post.id)) {
        algorithmBoost *= 3.0;
      }

      // Leader amplification: boost player posts with extra impression pool
      let leaderBoost = 0;
      if (leaderAmplificationActive && post.author_type === 'player') {
        leaderBoost = 5000 + Math.floor(Math.random() * 10000);
      }

      // Social proof snowball
      const socialProof = 1.0 + Math.log10(Math.max(1, post.like_count || 1)) * 0.3;

      // Grade-based quality multiplier for player posts
      let qualityMultiplier = 1.0;
      if (post.author_type === 'player' && post.sop_compliance_score) {
        const grade = post.sop_compliance_score as Record<string, unknown>;
        const overall = Number(grade.overall) || 50;
        qualityMultiplier = overall / 50;
      }

      // Calculate new impressions this tick
      const rawImpressions =
        baseRate * algorithmBoost * recencyDecay * suppression * qualityMultiplier;
      const newImpressions = Math.floor(Math.max(0, rawImpressions));

      // NPC organic engagement from new impressions
      const { likeRate, repostRate } = getContentEngagementRates(post.sentiment || 'neutral');
      const npcLikes = Math.floor(newImpressions * likeRate * socialProof);
      const npcReposts = Math.floor(newImpressions * repostRate * socialProof);

      // Update impression pool based on engagement rate
      let currentPool = (post.impression_pool || 0) + leaderBoost;
      const totalEngagementThisTick = pLikes + pReposts + npcLikes + npcReposts;
      const currentEngagementRate =
        newImpressions > 0 ? totalEngagementThisTick / newImpressions : 0;

      let algorithmAction: string;
      if (suppression === 0) {
        algorithmAction = 'removed';
        currentPool = 0;
      } else if (suppression < 0.5) {
        algorithmAction = 'suppress';
        currentPool = Math.floor(currentPool * 0.5);
      } else if (currentEngagementRate > 0.03) {
        algorithmAction = 'expand';
        currentPool = Math.floor(currentPool * 1.5) + newImpressions;
      } else if (currentEngagementRate > 0.01) {
        algorithmAction = 'sustain';
        currentPool = currentPool + Math.floor(newImpressions * 0.5);
      } else {
        algorithmAction = 'contract';
        currentPool = Math.floor(currentPool * 0.6);
      }

      // Compute new virality score (used for feed ordering)
      const newVirality = Math.round(
        Math.min(
          100,
          (currentEngagementRate * 1000 + Math.log10(Math.max(1, currentPool)) * 10) * recencyDecay,
        ),
      );

      const newViews = (post.view_count || 0) + newImpressions;
      const newLikes = (post.like_count || 0) + npcLikes;
      const newReposts = (post.repost_count || 0) + npcReposts;

      updates.push({
        id: post.id,
        changes: {
          view_count: newViews,
          like_count: newLikes,
          repost_count: newReposts,
          impression_pool: currentPool,
          engagement_rate: Math.round(currentEngagementRate * 10000) / 10000,
          virality_score: newVirality,
        },
      });

      logEntries.push({
        post_id: post.id,
        session_id: sessionId,
        tick_number: tickNumber,
        impressions_added: newImpressions,
        npc_likes_added: npcLikes,
        npc_reposts_added: npcReposts,
        player_likes_added: pLikes,
        player_reposts_added: pReposts,
        engagement_rate: Math.round(currentEngagementRate * 10000) / 10000,
        algorithm_action: algorithmAction,
        impression_pool_after: currentPool,
        virality_score_after: newVirality,
      });
    }

    // Batch update posts
    for (const up of updates) {
      await supabaseAdmin.from('social_posts').update(up.changes).eq('id', up.id);
    }

    // Batch insert engagement log
    if (logEntries.length > 0) {
      await supabaseAdmin.from('post_engagement_log').insert(logEntries);
    }

    // Broadcast engagement updates to frontend
    if (updates.length > 0) {
      getWebSocketService().broadcastToSession(sessionId, {
        type: 'social_posts.engagement_update',
        data: {
          updates: updates.map((u) => ({
            id: u.id,
            like_count: u.changes.like_count,
            view_count: u.changes.view_count,
            repost_count: u.changes.repost_count,
            virality_score: u.changes.virality_score,
          })),
        },
        timestamp: new Date().toISOString(),
      });
    }

    // Run ambient content generation as a sub-step
    await generateAmbientPosts(sessionId);

    logger.debug(
      { sessionId, tickNumber, postsProcessed: activePosts.length },
      'Engagement tick completed',
    );
  } catch (err) {
    logger.error({ err, sessionId }, 'Engagement algorithm tick failed');
  }
}

export function resetTickCounter(sessionId: string): void {
  sessionTickCounters.delete(sessionId);
}
