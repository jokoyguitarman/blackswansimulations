import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { validate } from '../lib/validation.js';
import { getWebSocketService } from '../services/websocketService.js';
import { recordPlayerAction } from '../services/sopCheckerService.js';
import { gradePlayerContent } from '../services/contentGraderService.js';
import { markPostResponded } from '../services/responseTrackerService.js';
import { evaluateSOPCompliance } from '../services/sopCheckerService.js';
import { computeSessionSentiment } from '../services/sentimentSimService.js';
import { triggerNPCReactions } from '../services/npcReactionService.js';
import { notifyPostReply, notifyPostLike } from '../services/socialNotificationService.js';
import { getControlledOrgPage, getControlledOrgKey } from '../services/orgPageService.js';
import {
  generatePostImage,
  generateVideo,
  generateVideoThumbnail,
  getImageStyleForFormat,
} from '../services/mediaGenerationService.js';
import {
  evaluateConditionKey,
  type EvaluationContext,
} from '../services/conditionEvaluatorService.js';
import { deriveEmailAddress } from '../services/npcEmailReplyService.js';
import { adjudicateDispute } from '../services/contentDisputeService.js';

const router = Router();

/**
 * Surface a targeted post (echo-chamber / NPC-bubble) to the entire session.
 *
 * When a player engages (react / flag / comment / repost) with a post that was only
 * visible to them (target_player_ids) or their demographic (target_demographics), the
 * post is promoted so the whole team can rally and fact-check it together. The original
 * targeting is preserved for after-action review; an is_surfaced_to_session flag drives
 * visibility. Idempotent: a post is only surfaced once.
 */
async function surfacePostToSession(
  postId: string,
  sessionId: string,
  userId: string,
): Promise<void> {
  try {
    const { data: post } = await supabaseAdmin
      .from('social_posts')
      .select('target_player_ids, target_demographics, is_surfaced_to_session')
      .eq('id', postId)
      .single();

    if (!post) return;
    const wasTargeted = !!(post.target_player_ids || post.target_demographics);
    if (!wasTargeted || post.is_surfaced_to_session) return;

    const { data: updated, error } = await supabaseAdmin
      .from('social_posts')
      .update({
        is_surfaced_to_session: true,
        surfaced_by: userId,
        surfaced_at: new Date().toISOString(),
      })
      .eq('id', postId)
      .eq('is_surfaced_to_session', false)
      .select()
      .single();

    if (error || !updated) return;

    getWebSocketService().broadcastToSession(sessionId, {
      type: 'social_post.surfaced',
      data: { post: updated, surfaced_by: userId },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn({ err, postId, sessionId }, 'Failed to surface post to session (non-critical)');
  }
}

// ─── Social Posts ────────────────────────────────────────────────────────────

router.get('/posts/session/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
    const user = req.user!;
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const sortMode = (req.query.sort as string) || 'algorithm';
    const platformFilter = req.query.platform as string | undefined;
    const authorTypeFilter = req.query.author_type as string | undefined;
    const topLevelOnly = req.query.top_level_only === 'true';

    let postsQuery = supabaseAdmin
      .from('social_posts')
      .select('*', { count: 'exact' })
      .eq('session_id', sessionId)
      .eq('platform_removed', false);

    if (platformFilter) {
      postsQuery = postsQuery.eq('platform', platformFilter);
    }

    if (authorTypeFilter) {
      postsQuery = postsQuery.eq('author_type', authorTypeFilter);
    }

    if (topLevelOnly) {
      postsQuery = postsQuery.is('reply_to_post_id', null);
    }

    if (sortMode === 'chronological') {
      postsQuery = postsQuery.order('created_at', { ascending: false });
    } else {
      postsQuery = postsQuery.order('virality_score', { ascending: false });
    }

    postsQuery = postsQuery.range(offset, offset + limit - 1);

    const [postsResult, likesResult, flagsResult, participantResult] = await Promise.all([
      postsQuery,
      supabaseAdmin
        .from('social_post_likes')
        .select('post_id, reaction_type, reacted_as')
        .eq('player_id', user.id),
      supabaseAdmin.from('social_post_flags').select('post_id').eq('player_id', user.id),
      supabaseAdmin
        .from('session_participants')
        .select('demographics')
        .eq('session_id', sessionId)
        .eq('user_id', user.id)
        .single(),
    ]);

    const { data, error, count } = postsResult;

    if (error) {
      logger.error({ error, sessionId }, 'Failed to fetch social posts');
      return res.status(500).json({ error: 'Failed to fetch social posts' });
    }

    const personalLikes = (likesResult.data || []).filter(
      (l) => (l.reacted_as || 'personal') === 'personal',
    );
    const pageLikes = (likesResult.data || []).filter((l) => l.reacted_as === 'page');
    const likedPostIds = new Set(personalLikes.map((l) => l.post_id));
    const reactionByPost = new Map<string, string>();
    for (const l of personalLikes) {
      reactionByPost.set(l.post_id, String(l.reaction_type || 'like'));
    }
    const pageLikedPostIds = new Set(pageLikes.map((l) => l.post_id));
    const pageReactionByPost = new Map<string, string>();
    for (const l of pageLikes) {
      pageReactionByPost.set(l.post_id, String(l.reaction_type || 'like'));
    }
    const flaggedPostIds = new Set((flagsResult.data || []).map((f) => f.post_id));
    const playerDemographics = (participantResult.data?.demographics || null) as Record<
      string,
      string
    > | null;

    const isTrainerOrAdmin = user.role === 'trainer' || user.role === 'admin';

    const filteredData = (data || []).filter((post) => {
      if (isTrainerOrAdmin) return true;
      if (post.is_surfaced_to_session) return true;
      if (post.target_player_ids) {
        return (post.target_player_ids as string[]).includes(user.id);
      }
      if (post.target_demographics) {
        if (!playerDemographics) return true;
        const target = post.target_demographics as Record<string, string | string[]>;
        return Object.entries(target).every(([key, vals]) => {
          const playerVal = playerDemographics[key];
          if (!playerVal) return true;
          if (Array.isArray(vals)) return vals.includes(playerVal);
          return vals === playerVal;
        });
      }
      return true;
    });

    const postIds = filteredData.map((p) => p.id);
    const reactionTypesMap = new Map<string, string[]>();
    if (postIds.length > 0) {
      const { data: allReactions } = await supabaseAdmin
        .from('social_post_likes')
        .select('post_id, reaction_type')
        .in('post_id', postIds);
      for (const r of allReactions || []) {
        const pid = r.post_id as string;
        const rt = String(r.reaction_type || 'like');
        const existing = reactionTypesMap.get(pid);
        if (!existing) {
          reactionTypesMap.set(pid, [rt]);
        } else if (!existing.includes(rt)) {
          existing.push(rt);
        }
      }
    }

    const enrichedData = filteredData.map((post) => ({
      ...post,
      liked_by_me: likedPostIds.has(post.id),
      my_reaction: reactionByPost.get(post.id) || null,
      page_liked_by_me: pageLikedPostIds.has(post.id),
      page_reaction: pageReactionByPost.get(post.id) || null,
      reaction_types: reactionTypesMap.get(post.id) || [],
      flagged_by_me: flaggedPostIds.has(post.id),
    }));

    res.json({ data: enrichedData, count, page, limit });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /social/posts/session/:sessionId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/posts/:postId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { postId } = req.params;

    const { data: post, error } = await supabaseAdmin
      .from('social_posts')
      .select('*')
      .eq('id', postId)
      .single();

    if (error || !post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const { data: replies } = await supabaseAdmin
      .from('social_posts')
      .select('*')
      .eq('reply_to_post_id', postId)
      .order('created_at', { ascending: true });

    res.json({ data: { ...post, replies: replies || [] } });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /social/posts/:postId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

const createPostSchema = z.object({
  body: z.object({
    session_id: z.string().uuid(),
    content: z.string().min(1).max(2000),
    reply_to_post_id: z.string().uuid().optional(),
    image_prompt: z.string().max(500).optional(),
    media_url: z.string().url().optional(),
    platform: z
      .enum(['x_twitter', 'facebook', 'instagram', 'tiktok', 'reddit', 'forum'])
      .default('x_twitter'),
    post_format: z
      .enum([
        'text',
        'official_statement',
        'infographic',
        'humor_meme',
        'video_concept',
        'personal_story',
      ])
      .default('text'),
    post_as_page: z.boolean().optional().default(false),
    shared_article_id: z.string().uuid().optional(),
    content_flags: z.record(z.string(), z.unknown()).optional(),
    share_stance: z.enum(['support', 'neutral', 'criticize', 'fake_news']).optional(),
  }),
});

router.post(
  '/posts',
  requireAuth,
  validate(createPostSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const {
        session_id,
        content,
        reply_to_post_id,
        platform,
        post_format,
        image_prompt,
        media_url,
        post_as_page,
        shared_article_id,
        content_flags,
        share_stance,
      } = req.body;

      const hashtags = content.match(/#\w+/g) || [];

      let playerName = user.metadata?.full_name as string | undefined;
      if (!playerName) {
        const { data: profile } = await supabaseAdmin
          .from('user_profiles')
          .select('full_name')
          .eq('id', user.id)
          .single();
        playerName = profile?.full_name || undefined;
      }
      const personalDisplayName = playerName || user.email || 'Player';
      const personalHandle = `@${(playerName || user.email || user.id.slice(0, 8)).replace(/[@.\s+,]/g, '_').toLowerCase()}`;

      let authorHandle = personalHandle;
      let authorDisplayName = personalDisplayName;
      let authorType = 'player';
      let postedByUserId: string | null = null;
      let postedByDisplayName: string | null = null;

      if (post_as_page) {
        const orgPage = await getControlledOrgPage(session_id, user.id, platform);
        if (!orgPage) {
          return res
            .status(403)
            .json({ error: 'You do not control a page on this platform for this session' });
        }
        authorHandle = orgPage.page_handle;
        authorDisplayName = orgPage.page_name;
        authorType = 'official_account';
        postedByUserId = user.id;
        postedByDisplayName = personalDisplayName;
      }

      const initialViralityScore = reply_to_post_id
        ? 0
        : post_as_page
          ? 50 + Math.floor(Math.random() * 20)
          : 35 + Math.floor(Math.random() * 15);

      const { data: post, error } = await supabaseAdmin
        .from('social_posts')
        .insert({
          session_id,
          platform,
          user_id: user.id,
          author_handle: authorHandle,
          author_display_name: authorDisplayName,
          author_type: authorType,
          content,
          hashtags,
          reply_to_post_id: reply_to_post_id || null,
          sentiment: 'neutral',
          post_format: post_format || 'text',
          image_prompt: image_prompt || null,
          media_urls: media_url ? [media_url] : null,
          virality_score: initialViralityScore,
          ...(shared_article_id ? { shared_article_id } : {}),
          ...(content_flags || share_stance
            ? {
                content_flags: {
                  ...(content_flags || {}),
                  ...(share_stance ? { share_stance } : {}),
                },
              }
            : {}),
          ...(postedByUserId
            ? { posted_by_user_id: postedByUserId, posted_by_display_name: postedByDisplayName }
            : {}),
        })
        .select()
        .single();

      if (error) {
        logger.error({ error, userId: user.id }, 'Failed to create social post');
        return res.status(500).json({ error: 'Failed to create post' });
      }

      if (reply_to_post_id) {
        const { data: parentPost } = await supabaseAdmin
          .from('social_posts')
          .select('reply_count')
          .eq('id', reply_to_post_id)
          .single();
        if (parentPost) {
          await supabaseAdmin
            .from('social_posts')
            .update({ reply_count: (parentPost.reply_count || 0) + 1 })
            .eq('id', reply_to_post_id);
        }
        await markPostResponded(session_id, reply_to_post_id, post.id);

        // Commenting on a targeted post surfaces the parent to the whole team.
        await surfacePostToSession(reply_to_post_id, session_id, user.id);

        // Check if replying to harmful content -> assess SOP step
        const { data: parentFlags } = await supabaseAdmin
          .from('social_posts')
          .select('content_flags')
          .eq('id', reply_to_post_id)
          .single();
        const pFlags = (parentFlags?.content_flags || {}) as Record<string, unknown>;
        const isHarmfulReply = !!(
          pFlags.is_hate_speech ||
          pFlags.hate_speech ||
          pFlags.is_harmful_narrative ||
          pFlags.is_misinformation ||
          pFlags.misinformation ||
          pFlags.inflammatory ||
          pFlags.is_inflammatory ||
          pFlags.threatening ||
          pFlags.incites_violence ||
          pFlags.is_organized_pressure
        );
        await recordPlayerAction(
          session_id,
          user.id,
          'reply_posted',
          reply_to_post_id,
          content,
          {},
          isHarmfulReply ? 'assess' : null,
        );

        // Notify the parent post author about the reply
        const { data: parentForNotif } = await supabaseAdmin
          .from('social_posts')
          .select('author_handle, author_type, platform')
          .eq('id', reply_to_post_id)
          .single();
        if (
          parentForNotif &&
          (parentForNotif.author_type === 'player' ||
            parentForNotif.author_type === 'official_account')
        ) {
          const isPageNotif = parentForNotif.author_type === 'official_account';
          void notifyPostReply(
            session_id,
            authorDisplayName,
            parentForNotif.author_handle,
            reply_to_post_id,
            content,
            parentForNotif.platform || platform,
            undefined,
            isPageNotif,
          );
        }

        // Trigger NPC reactions to player replies on NPC posts (non-blocking)
        void triggerNPCReactions(session_id, post).catch((err) =>
          logger.warn({ err, postId: post.id }, 'NPC reply reaction failed (non-critical)'),
        );
      } else {
        const publishStep = post_format === 'official_statement' ? 'publish' : null;
        await recordPlayerAction(
          session_id,
          user.id,
          'post_created',
          post.id,
          content,
          {
            post_format: post_format || 'text',
          },
          publishStep,
        );
      }

      // Auto-grade ALL player posts (replies and top-level)
      void (async () => {
        try {
          const { data: sessionData } = await supabaseAdmin
            .from('sessions')
            .select('scenario_id, start_time')
            .eq('id', session_id)
            .single();
          if (!sessionData) return;

          const { data: scenario } = await supabaseAdmin
            .from('scenarios')
            .select('description, initial_state')
            .eq('id', sessionData.scenario_id)
            .single();
          if (!scenario) return;

          const is = (scenario.initial_state || {}) as Record<string, unknown>;
          const factSheet = (is.fact_sheet || {}) as Record<string, unknown>;
          const confirmedFacts = (factSheet.confirmed_facts || []) as string[];
          const researchGuidelines = ((is.research_guidelines as Record<string, unknown>)
            ?.per_team || []) as Array<{
            guidelines: Array<{ best_practice: string; source_basis: string }>;
          }>;
          const flatGuidelines = researchGuidelines.flatMap((t) => t.guidelines || []);

          let parentContent: string | undefined;
          if (reply_to_post_id) {
            const { data: parentPost } = await supabaseAdmin
              .from('social_posts')
              .select('content')
              .eq('id', reply_to_post_id)
              .single();
            parentContent = parentPost ? String(parentPost.content || '') : undefined;
          }

          const elapsedMinutes = sessionData.start_time
            ? Math.floor((Date.now() - new Date(sessionData.start_time).getTime()) / 60000)
            : undefined;

          const { gradePlayerContent } = await import('../services/contentGraderService.js');
          const grade = await gradePlayerContent(content, {
            crisis_description: scenario.description || '',
            confirmed_facts: confirmedFacts,
            hateful_post_being_addressed: parentContent,
            research_guidelines: flatGuidelines.slice(0, 5),
            post_format: post_format || 'text',
            is_official_page_post: post_as_page || false,
            elapsed_minutes: elapsedMinutes,
            image_prompt: image_prompt || undefined,
          });

          await supabaseAdmin
            .from('social_posts')
            .update({ sop_compliance_score: grade })
            .eq('id', post.id);

          if (grade.overall >= 70) {
            const { generateConsequenceInject } =
              await import('../services/ambientContentService.js');
            void generateConsequenceInject(
              session_id,
              'player_good_response',
              `A player posted a high-quality ${post_format || 'text'} response (scored ${grade.overall}/100). Generate a supportive reaction amplifying the good response.`,
              'supportive',
              true,
            );
          } else if (grade.overall < 40) {
            const { generateConsequenceInject } =
              await import('../services/ambientContentService.js');
            void generateConsequenceInject(
              session_id,
              'player_poor_response',
              `A player posted a poor ${post_format || 'text'} response (scored ${grade.overall}/100). Generate a skeptical reaction questioning the response quality.`,
              'negative',
              false,
            );
          }

          logger.info(
            { postId: post.id, overall: grade.overall, format: post_format },
            'Auto-graded player post',
          );
        } catch (gradeErr) {
          logger.warn({ err: gradeErr }, 'Auto-grade failed (non-critical)');
        }
      })();

      getWebSocketService().broadcastToSession(session_id, {
        type: 'social_post.created',
        data: { post },
        timestamp: new Date().toISOString(),
      });

      // Trigger NPC reactions to player top-level posts (non-blocking)
      if (!reply_to_post_id) {
        void triggerNPCReactions(session_id, post).catch((err) =>
          logger.warn({ err, postId: post.id }, 'NPC reaction trigger failed (non-critical)'),
        );
      }

      // Generate media for creative format posts or when player provides an image prompt
      // Skip if media_url already provided (pre-generated via preview)
      const imageStyle = getImageStyleForFormat(post_format || 'text');
      const shouldGenerateMedia =
        !media_url && ((imageStyle && !reply_to_post_id) || !!image_prompt);
      if (shouldGenerateMedia) {
        void (async () => {
          try {
            const promptText = image_prompt || content;
            const isVideo = post_format === 'video_concept';
            let mediaUrl: string | null = null;

            // Fetch scenario context for realistic media generation
            let mediaScenarioContext: string | undefined;
            const { data: mediaSession } = await supabaseAdmin
              .from('sessions')
              .select('scenario_id')
              .eq('id', session_id)
              .single();
            if (mediaSession?.scenario_id) {
              const { data: mediaScenario } = await supabaseAdmin
                .from('scenarios')
                .select('description')
                .eq('id', mediaSession.scenario_id)
                .single();
              mediaScenarioContext = mediaScenario?.description?.substring(0, 200) || undefined;
            }

            if (isVideo) {
              mediaUrl = await generateVideo(promptText, 10, '16:9', mediaScenarioContext);
              if (!mediaUrl) mediaUrl = await generateVideoThumbnail(promptText);
            } else {
              const style = imageStyle || 'social_media_photo';
              mediaUrl = await generatePostImage(promptText, style, mediaScenarioContext);
            }

            if (mediaUrl) {
              const mediaUrls = [mediaUrl];
              await supabaseAdmin
                .from('social_posts')
                .update({ media_urls: mediaUrls })
                .eq('id', post.id);

              getWebSocketService().broadcastToSession(session_id, {
                type: 'social_post.media_updated',
                data: { post_id: post.id, media_urls: mediaUrls },
                timestamp: new Date().toISOString(),
              });

              logger.info(
                { postId: post.id, format: post_format, isVideo, hasImagePrompt: !!image_prompt },
                'Player post media generated',
              );
            }
          } catch (imgErr) {
            logger.warn({ imgErr, postId: post.id }, 'Player post media generation failed');
          }
        })();
      }

      res.status(201).json({ data: post });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /social/posts');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.post('/posts/:postId/like', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    const { postId } = req.params;
    const reactionType = req.body?.reaction_type || 'like';
    const postAsPage = req.body?.post_as_page || false;
    const reactedAs = postAsPage ? 'page' : 'personal';

    if (postAsPage) {
      const post = await supabaseAdmin
        .from('social_posts')
        .select('session_id')
        .eq('id', postId)
        .single();
      const sid = post.data?.session_id as string | undefined;
      const orgKey = sid ? await getControlledOrgKey(sid, user.id) : null;
      if (!orgKey) {
        return res.status(403).json({ error: 'You do not control a page in this session' });
      }
    }

    const { data: existing } = await supabaseAdmin
      .from('social_post_likes')
      .select('id, reaction_type')
      .eq('post_id', postId)
      .eq('player_id', user.id)
      .eq('reacted_as', reactedAs)
      .single();

    if (existing) {
      if (existing.reaction_type !== reactionType) {
        await supabaseAdmin
          .from('social_post_likes')
          .update({ reaction_type: reactionType })
          .eq('id', existing.id);
      }
      return res.json({
        success: true,
        updated: true,
        reaction_type: reactionType,
        reacted_as: reactedAs,
      });
    }

    await supabaseAdmin.from('social_post_likes').insert({
      post_id: postId,
      player_id: user.id,
      reaction_type: reactionType,
      reacted_as: reactedAs,
    });

    const { data: post } = await supabaseAdmin
      .from('social_posts')
      .select('like_count, session_id')
      .eq('id', postId)
      .single();

    if (post) {
      const newLikeCount = (post.like_count || 0) + 1;
      await supabaseAdmin
        .from('social_posts')
        .update({ like_count: newLikeCount })
        .eq('id', postId);

      // Broadcast so other viewers update the count AND the reaction type live.
      getWebSocketService().broadcastToSession(post.session_id, {
        type: 'social_posts.engagement_update',
        data: { updates: [{ id: postId, like_count: newLikeCount, reaction_type: reactionType }] },
        timestamp: new Date().toISOString(),
      });

      await recordPlayerAction(post.session_id, user.id, 'post_liked', postId, null, {
        reaction_type: reactionType,
      });

      // Engaging with a targeted post surfaces it to the whole team.
      await surfacePostToSession(postId, post.session_id, user.id);

      // Notify the post author about the like
      const { data: likedPost } = await supabaseAdmin
        .from('social_posts')
        .select('author_handle, author_type, platform')
        .eq('id', postId)
        .single();
      if (
        likedPost &&
        (likedPost.author_type === 'player' || likedPost.author_type === 'official_account')
      ) {
        const isPageNotif = likedPost.author_type === 'official_account';
        void notifyPostLike(
          post.session_id,
          likedPost.author_handle,
          (user.metadata?.full_name as string) || user.email || 'Player',
          reactionType,
          likedPost.platform || 'x_twitter',
          isPageNotif,
          postId,
        );
      }
    }

    res.json({ success: true });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /social/posts/:postId/like');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/posts/:postId/like', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    const { postId } = req.params;
    const postAsPage = req.body?.post_as_page || false;
    const reactedAs = postAsPage ? 'page' : 'personal';

    const { data: existing } = await supabaseAdmin
      .from('social_post_likes')
      .select('id')
      .eq('post_id', postId)
      .eq('player_id', user.id)
      .eq('reacted_as', reactedAs)
      .single();

    if (!existing) {
      return res.json({ success: true, already_removed: true });
    }

    await supabaseAdmin.from('social_post_likes').delete().eq('id', existing.id);

    const { data: post } = await supabaseAdmin
      .from('social_posts')
      .select('like_count')
      .eq('id', postId)
      .single();

    if (post) {
      await supabaseAdmin
        .from('social_posts')
        .update({ like_count: Math.max(0, (post.like_count || 1) - 1) })
        .eq('id', postId);
    }

    res.json({ success: true });
  } catch (err) {
    logger.error({ error: err }, 'Error in DELETE /social/posts/:postId/like');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/posts/:postId/reactions', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { postId } = req.params;

    const { data, error } = await supabaseAdmin
      .from('social_post_likes')
      .select('reaction_type')
      .eq('post_id', postId);

    if (error) return res.status(500).json({ error: 'Failed to fetch reactions' });

    const counts: Record<string, number> = {};
    for (const row of data || []) {
      const rt = (row.reaction_type as string) || 'like';
      counts[rt] = (counts[rt] || 0) + 1;
    }

    res.json({ data: counts });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /social/posts/:postId/reactions');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/posts/:postId/flag', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    const { postId } = req.params;

    const { data: existing } = await supabaseAdmin
      .from('social_post_flags')
      .select('id')
      .eq('post_id', postId)
      .eq('player_id', user.id)
      .single();

    if (existing) {
      return res.json({ success: true, already_flagged: true });
    }

    const { data: post } = await supabaseAdmin
      .from('social_posts')
      .select('session_id, content_flags')
      .eq('id', postId)
      .single();

    if (!post) return res.status(404).json({ error: 'Post not found' });

    await supabaseAdmin.from('social_post_flags').insert({ post_id: postId, player_id: user.id });

    await supabaseAdmin
      .from('social_posts')
      .update({ is_flagged_by_player: true })
      .eq('id', postId);

    // Flagging misinformation also counts as fact_check SOP step
    const flagFlags = (post.content_flags || {}) as Record<string, unknown>;
    const isMisinfoFlag = !!(flagFlags.is_misinformation || flagFlags.misinformation);
    await recordPlayerAction(post.session_id, user.id, 'post_flagged', postId, null, {}, 'monitor');
    if (isMisinfoFlag) {
      await recordPlayerAction(
        post.session_id,
        user.id,
        'misinfo_flagged',
        postId,
        null,
        {},
        'fact_check',
      );
    }

    getWebSocketService().broadcastToSession(post.session_id, {
      type: 'social_post.flagged',
      data: { post_id: postId, flagged_by: user.id },
      timestamp: new Date().toISOString(),
    });

    // Engaging with a targeted post surfaces it to the whole team.
    await surfacePostToSession(postId, post.session_id, user.id);

    res.json({ success: true });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /social/posts/:postId/flag');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/posts/:postId/repost', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    const { postId } = req.params;
    const { session_id } = req.body;

    const { data: original } = await supabaseAdmin
      .from('social_posts')
      .select('*')
      .eq('id', postId)
      .single();

    if (!original) return res.status(404).json({ error: 'Post not found' });

    const { data: repost, error } = await supabaseAdmin
      .from('social_posts')
      .insert({
        session_id: session_id || original.session_id,
        platform: original.platform,
        author_handle: `@${((user.metadata?.full_name as string) || user.email || user.id.slice(0, 8)).replace(/[@.\s+,]/g, '_').toLowerCase()}`,
        author_display_name: (user.metadata?.full_name as string) || user.email || 'Player',
        author_type: 'player',
        content: original.content,
        is_repost: true,
        original_post_id: postId,
        sentiment: original.sentiment,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: 'Failed to repost' });

    await supabaseAdmin
      .from('social_posts')
      .update({ repost_count: (original.repost_count || 0) + 1 })
      .eq('id', postId);

    await recordPlayerAction(original.session_id, user.id, 'post_reposted', postId, null);

    // Reposting a targeted post surfaces the original to the whole team.
    await surfacePostToSession(postId, original.session_id, user.id);

    res.status(201).json({
      data: {
        ...repost,
        original_author_handle: original.author_handle,
        original_author_display_name: original.author_display_name,
      },
    });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /social/posts/:postId/repost');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Emails ──────────────────────────────────────────────────────────────────

router.get('/emails/session/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;

    const { data, error } = await supabaseAdmin
      .from('sim_emails')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: 'Failed to fetch emails' });
    res.json({ data });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /social/emails/session/:sessionId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/emails/:emailId/read', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    const { emailId } = req.params;

    const { data: email } = await supabaseAdmin
      .from('sim_emails')
      .select('session_id, email_category')
      .eq('id', emailId)
      .single();

    if (!email) return res.status(404).json({ error: 'Email not found' });

    await supabaseAdmin.from('sim_emails').update({ is_read: true }).eq('id', emailId);

    await recordPlayerAction(email.session_id, user.id, 'email_read', emailId, null);

    if (email.email_category === 'verified_facts') {
      await recordPlayerAction(
        email.session_id,
        user.id,
        'fact_checked',
        emailId,
        null,
        {},
        'fact_check',
      );
    }

    res.json({ success: true });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /social/emails/:emailId/read');
    res.status(500).json({ error: 'Internal server error' });
  }
});

const sendEmailSchema = z.object({
  body: z.object({
    session_id: z.string().uuid(),
    to_addresses: z.array(z.string()).min(1),
    cc_addresses: z.array(z.string()).optional(),
    subject: z.string().min(1).max(500),
    body_text: z.string().min(1),
    replied_to_id: z.string().uuid().optional(),
  }),
});

router.post(
  '/emails',
  requireAuth,
  validate(sendEmailSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const { session_id, to_addresses, cc_addresses, subject, body_text, replied_to_id } =
        req.body;

      // Resolve root thread_id: look up the parent's thread_id so
      // multi-reply chains all share the same root thread_id.
      let resolvedThreadId: string | null = null;
      if (replied_to_id) {
        const { data: parentEmail } = await supabaseAdmin
          .from('sim_emails')
          .select('thread_id')
          .eq('id', replied_to_id)
          .single();
        resolvedThreadId = parentEmail?.thread_id || replied_to_id;
      }

      const { data: email, error } = await supabaseAdmin
        .from('sim_emails')
        .insert({
          session_id,
          direction: 'outbound',
          from_address: `${(user.email || 'player').replace(/@.*/, '').replace(/\s+/g, '.')}@crisisresponse.sim`,
          from_name: (user.metadata?.full_name as string) || user.email || 'Player',
          to_addresses,
          cc_addresses: cc_addresses || [],
          subject,
          body_html: `<p>${body_text.replace(/\n/g, '</p><p>')}</p>`,
          body_text,
          replied_to_id: replied_to_id || null,
          thread_id: resolvedThreadId,
          sent_by_player_id: user.id,
        })
        .select()
        .single();

      if (error) return res.status(500).json({ error: 'Failed to send email' });

      await recordPlayerAction(
        session_id,
        user.id,
        'email_sent',
        email.id,
        body_text,
        {},
        'escalate',
      );

      getWebSocketService().broadcastToSession(session_id, {
        type: 'sim_email.sent',
        data: { email },
        timestamp: new Date().toISOString(),
      });

      // Trigger NPC reply if the email is to an NPC (non-blocking)
      void (async () => {
        try {
          const { triggerNPCEmailReply } = await import('../services/npcEmailReplyService.js');
          const delay = 2000 + Math.floor(Math.random() * 3000);
          setTimeout(() => {
            void triggerNPCEmailReply(session_id, {
              id: email.id,
              to_addresses,
              subject,
              body_text,
              from_name: (user.metadata?.full_name as string) || user.email || 'Player',
              from_address: email.from_address,
              replied_to_id: replied_to_id || null,
              thread_id: resolvedThreadId,
            });
          }, delay);
        } catch {
          /* non-critical */
        }
      })();

      res.status(201).json({ data: email });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /social/emails');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── Email Contacts ──────────────────────────────────────────────────────────

router.get(
  '/emails/contacts/session/:sessionId',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const { sessionId } = req.params;

      // 1. Get unique inbound email senders (most recent first)
      const { data: inboundSenders } = await supabaseAdmin
        .from('sim_emails')
        .select('from_address, from_name')
        .eq('session_id', sessionId)
        .eq('direction', 'inbound')
        .order('created_at', { ascending: false });

      const contacts: Array<{
        address: string;
        name: string;
        source: string;
      }> = [];
      const seenAddresses = new Set<string>();

      for (const sender of inboundSenders || []) {
        const addr = (sender.from_address as string).toLowerCase();
        if (!seenAddresses.has(addr) && addr !== 'system@sim.local') {
          seenAddresses.add(addr);
          contacts.push({
            address: sender.from_address as string,
            name: sender.from_name as string,
            source: 'previous',
          });
        }
      }

      // 2. Get key NPC personas and derive email addresses
      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('scenario_id')
        .eq('id', sessionId)
        .single();

      if (session?.scenario_id) {
        const { data: scenario } = await supabaseAdmin
          .from('scenarios')
          .select('initial_state')
          .eq('id', session.scenario_id)
          .single();

        if (scenario?.initial_state) {
          const initialState = scenario.initial_state as Record<string, unknown>;
          const personas = (initialState.npc_personas || []) as Array<{
            handle: string;
            name: string;
            type: string;
            tier?: string;
          }>;

          const keyPersonas = personas.filter(
            (p) =>
              p.tier === 'key' ||
              p.type === 'npc_media' ||
              p.type === 'npc_politician' ||
              p.type === 'npc_influencer',
          );

          for (const persona of keyPersonas) {
            const derivedAddress = deriveEmailAddress(persona);

            if (!seenAddresses.has(derivedAddress.toLowerCase())) {
              seenAddresses.add(derivedAddress.toLowerCase());
              contacts.push({
                address: derivedAddress,
                name: persona.name,
                source: 'npc',
              });
            }
          }
        }
      }

      res.json({ data: contacts });
    } catch (err) {
      logger.error({ error: err }, 'Error in GET /social/emails/contacts/session/:sessionId');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── News ────────────────────────────────────────────────────────────────────

router.get('/news/session/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;

    const { data, error } = await supabaseAdmin
      .from('sim_news_articles')
      .select('*')
      .eq('session_id', sessionId)
      .order('published_at', { ascending: false });

    if (error) return res.status(500).json({ error: 'Failed to fetch news' });
    res.json({ data });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /social/news/session/:sessionId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/news/:articleId/read', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    const { articleId } = req.params;

    const { data: article } = await supabaseAdmin
      .from('sim_news_articles')
      .select('session_id')
      .eq('id', articleId)
      .single();

    if (!article) return res.status(404).json({ error: 'Article not found' });

    await recordPlayerAction(
      article.session_id,
      user.id,
      'news_read',
      articleId,
      null,
      {},
      'monitor',
    );
    res.json({ success: true });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /social/news/:articleId/read');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Content Disputes (fact-based takedown requests) ──────────────────────────

const createDisputeSchema = z.object({
  body: z.object({
    session_id: z.string().uuid(),
    target_type: z.enum(['article', 'post']),
    target_id: z.string().uuid(),
    claimed_falsehood: z.string().max(1000).optional().default(''),
    submitted_facts: z.string().max(2000).optional().default(''),
  }),
});

const MAX_PENDING_DISPUTES_PER_PLAYER = 5;

router.post(
  '/disputes',
  requireAuth,
  validate(createDisputeSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const { session_id, target_type, target_id, claimed_falsehood, submitted_facts } = req.body;

      // Verify the target exists and belongs to this session.
      const table = target_type === 'article' ? 'sim_news_articles' : 'social_posts';
      const { data: target } = await supabaseAdmin
        .from(table)
        .select('id, session_id')
        .eq('id', target_id)
        .single();

      if (!target || target.session_id !== session_id) {
        return res.status(404).json({ error: 'Disputed content not found in this session' });
      }

      // Anti-abuse: limit pending disputes per player.
      const { count: pendingCount } = await supabaseAdmin
        .from('content_dispute_requests')
        .select('id', { count: 'exact', head: true })
        .eq('session_id', session_id)
        .eq('requested_by', user.id)
        .eq('status', 'pending');

      if ((pendingCount || 0) >= MAX_PENDING_DISPUTES_PER_PLAYER) {
        return res
          .status(429)
          .json({ error: 'You have too many pending disputes. Wait for them to resolve.' });
      }

      // Prevent duplicate pending disputes on the same target by the same player.
      const { data: existing } = await supabaseAdmin
        .from('content_dispute_requests')
        .select('id')
        .eq('session_id', session_id)
        .eq('requested_by', user.id)
        .eq('target_id', target_id)
        .eq('status', 'pending')
        .limit(1);

      if (existing && existing.length > 0) {
        return res.json({ data: existing[0], already_pending: true });
      }

      const { data: dispute, error } = await supabaseAdmin
        .from('content_dispute_requests')
        .insert({
          session_id,
          requested_by: user.id,
          target_type,
          target_id,
          claimed_falsehood,
          submitted_facts,
        })
        .select()
        .single();

      if (error) {
        logger.error({ error, userId: user.id }, 'Failed to create content dispute');
        return res.status(500).json({ error: 'Failed to file dispute' });
      }

      await recordPlayerAction(
        session_id,
        user.id,
        'dispute_filed',
        target_id,
        claimed_falsehood,
        { target_type },
        'fact_check',
      );

      // Adjudicate asynchronously (non-blocking).
      void adjudicateDispute(dispute.id).catch((err) =>
        logger.warn({ err, disputeId: dispute.id }, 'Dispute adjudication trigger failed'),
      );

      res.status(201).json({ data: dispute });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /social/disputes');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.get('/disputes/session/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
    const { data, error } = await supabaseAdmin
      .from('content_dispute_requests')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: 'Failed to fetch disputes' });
    res.json({ data });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /social/disputes/session/:sessionId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── SOP & Sentiment ─────────────────────────────────────────────────────────

router.get('/sop/session/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;

    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id')
      .eq('id', sessionId)
      .single();

    if (!session) return res.status(404).json({ error: 'Session not found' });

    const compliance = await evaluateSOPCompliance(sessionId, session.scenario_id);
    res.json({ data: compliance });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /social/sop/session/:sessionId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/sentiment/session/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
    const sentiment = await computeSessionSentiment(sessionId);
    res.json({ data: sentiment });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /social/sentiment/session/:sessionId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Player Actions ──────────────────────────────────────────────────────────

router.get('/actions/session/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;

    const { data, error } = await supabaseAdmin
      .from('player_actions')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) return res.status(500).json({ error: 'Failed to fetch actions' });
    res.json({ data });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /social/actions/session/:sessionId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Content Grading ─────────────────────────────────────────────────────────

const gradeContentSchema = z.object({
  body: z.object({
    session_id: z.string().uuid(),
    content: z.string().min(1),
    post_id: z.string().uuid().optional(),
    hateful_post_content: z.string().optional(),
  }),
});

router.post(
  '/grade',
  requireAuth,
  validate(gradeContentSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const { session_id, content, post_id, hateful_post_content } = req.body;

      // Record draft SOP step when player grades content
      void recordPlayerAction(
        session_id,
        user.id,
        'content_graded',
        post_id || null,
        content?.substring(0, 200) || null,
        {},
        'draft',
      ).catch(() => {});

      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('scenario_id')
        .eq('id', session_id)
        .single();

      if (!session) return res.status(404).json({ error: 'Session not found' });

      const { data: scenario } = await supabaseAdmin
        .from('scenarios')
        .select('description')
        .eq('id', session.scenario_id)
        .single();

      const grade = await gradePlayerContent(content, {
        crisis_description: scenario?.description || 'Crisis simulation',
        confirmed_facts: [],
        hateful_post_being_addressed: hateful_post_content,
        post_format: req.body.post_format || 'text',
      });

      if (post_id) {
        await supabaseAdmin
          .from('social_posts')
          .update({ sop_compliance_score: grade })
          .eq('id', post_id);
      }

      res.json({ data: grade });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /social/grade');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.get('/state/session/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('current_state')
      .eq('id', sessionId)
      .single();

    if (!session) return res.status(404).json({ error: 'Session not found' });

    const socialState =
      ((session.current_state || {}) as Record<string, unknown>).social_state || {};
    res.json({ data: socialState });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /social/state/session/:sessionId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Player Demographics ─────────────────────────────────────────────────────

const demographicsSchema = z.object({
  body: z.object({
    session_id: z.string().uuid(),
    demographics: z.object({
      age_bracket: z.enum(['under_18', '18_25', '26_35', '36_50', '51_plus']).optional(),
      gender: z.enum(['male', 'female', 'other', 'prefer_not_to_say']).optional(),
      religion: z
        .enum([
          'buddhism',
          'christianity',
          'hinduism',
          'islam',
          'sikhism',
          'taoism',
          'none',
          'other',
        ])
        .optional(),
      race: z.string().max(50).optional(),
    }),
  }),
});

router.post(
  '/demographics',
  requireAuth,
  validate(demographicsSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const { session_id, demographics } = req.body;

      const { error } = await supabaseAdmin
        .from('session_participants')
        .update({ demographics })
        .eq('session_id', session_id)
        .eq('user_id', user.id);

      if (error) {
        logger.error({ error }, 'Failed to update demographics');
        return res.status(500).json({ error: 'Failed to update demographics' });
      }

      res.json({ success: true });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /social/demographics');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.get(
  '/demographics/session/:sessionId',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const { sessionId } = req.params;

      const { data, error } = await supabaseAdmin
        .from('session_participants')
        .select('demographics')
        .eq('session_id', sessionId)
        .eq('user_id', user.id)
        .single();

      if (error) return res.status(404).json({ error: 'Participant not found' });

      res.json({ data: data?.demographics || null });
    } catch (err) {
      logger.error({ error: err }, 'Error in GET /social/demographics/session/:sessionId');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── Handles for @mention autocomplete ───────────────────────────────────────

router.get('/handles/session/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;

    const { data: posts } = await supabaseAdmin
      .from('social_posts')
      .select('author_handle, author_display_name, author_type')
      .eq('session_id', sessionId)
      .limit(500);

    const handleMap = new Map<string, { handle: string; display_name: string; type: string }>();
    for (const p of posts || []) {
      if (!handleMap.has(p.author_handle)) {
        handleMap.set(p.author_handle, {
          handle: p.author_handle,
          display_name: p.author_display_name,
          type: p.author_type,
        });
      }
    }

    res.json({ data: Array.from(handleMap.values()) });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /social/handles/session/:sessionId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Player Action Recording ─────────────────────────────────────────────────

const actionSchema = z.object({
  body: z.object({
    session_id: z.string().uuid(),
    action_type: z.string().min(1).max(100),
    target_id: z.string().optional(),
    content: z.string().max(2000).optional(),
    sop_step: z.string().max(50).optional(),
  }),
});

router.post(
  '/action',
  requireAuth,
  validate(actionSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const { session_id, action_type, target_id, content, sop_step } = req.body;
      await recordPlayerAction(
        session_id,
        user.id,
        action_type,
        target_id || null,
        content || null,
        {},
        sop_step || null,
      );
      return res.json({ success: true });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /social/action');
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── Trending & Suggested (Desktop Widgets) ─────────────────────────────────

router.get('/trending/session/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;

    const { data: posts } = await supabaseAdmin
      .from('social_posts')
      .select(
        'hashtags, content, like_count, repost_count, view_count, author_handle, created_at, content_flags',
      )
      .eq('session_id', sessionId)
      .eq('platform', 'x_twitter')
      .eq('platform_removed', false);

    if (!posts || posts.length === 0) {
      return res.json({ data: { hashtags: [], topics: [] } });
    }

    // Aggregate hashtags
    const tagCounts = new Map<string, number>();
    for (const post of posts) {
      const tags = post.hashtags as string[] | null;
      if (Array.isArray(tags)) {
        for (const t of tags) {
          const normalized = t.toLowerCase();
          tagCounts.set(normalized, (tagCounts.get(normalized) || 0) + 1);
        }
      }
    }
    const sortedTags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([tag, count]) => ({ tag, count }));

    // Most engaged posts as "hot" topics (with post_id for click-through)
    const { data: postsWithId } = await supabaseAdmin
      .from('social_posts')
      .select('id, content, like_count, repost_count, view_count')
      .eq('session_id', sessionId)
      .eq('platform', 'x_twitter')
      .eq('platform_removed', false)
      .order('like_count', { ascending: false })
      .limit(5);

    const hotPosts = (postsWithId || []).slice(0, 5).map((p) => ({
      label:
        ((p.content as string) || '').substring(0, 60) +
        (((p.content as string) || '').length > 60 ? '...' : ''),
      count: (p.view_count || 0) as number,
      trend: 'hot',
      post_id: p.id,
    }));

    return res.json({
      data: {
        hashtags: sortedTags,
        topics: hotPosts,
        total_posts: posts.length,
      },
    });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /social/trending');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/suggested/session/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;

    // Get scenario from session
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id')
      .eq('id', sessionId)
      .single();

    if (!session) return res.status(404).json({ error: 'Session not found' });

    const { data: scenario } = await supabaseAdmin
      .from('scenarios')
      .select('initial_state')
      .eq('id', session.scenario_id)
      .single();

    if (!scenario) return res.json({ data: [] });

    const initialState = (scenario.initial_state || {}) as Record<string, unknown>;
    const personas = (initialState.npc_personas || []) as Array<Record<string, unknown>>;

    // Pick up to 5 random NPCs
    const shuffled = [...personas].sort(() => Math.random() - 0.5).slice(0, 5);
    const suggested = shuffled.map((p) => ({
      handle: String(p.handle || ''),
      display_name: String(p.name || p.display_name || ''),
      type: String(p.type || 'npc_public'),
      follower_count: Number(p.follower_count || 0),
      personality: String(p.personality || '').substring(0, 80),
    }));

    return res.json({ data: suggested });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /social/suggested');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Media Preview (Image/Video Generation) ─────────────────────────────────

const mediaPreviewSchema = z.object({
  body: z.object({
    prompt: z.string().min(1).max(500),
    media_type: z.enum(['image', 'video']),
    style: z.string().optional(),
    duration: z.number().min(5).max(15).optional(),
    aspect_ratio: z.enum(['16:9', '9:16', '1:1']).optional(),
  }),
});

router.post(
  '/media/preview',
  requireAuth,
  validate(mediaPreviewSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { prompt, media_type, style, duration, aspect_ratio } = req.body;

      if (media_type === 'video') {
        const videoDuration = Math.min(15, Math.max(5, duration || 10));
        const previewId = `vp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        void (async () => {
          try {
            const videoUrl = await generateVideo(prompt, videoDuration, aspect_ratio || '16:9');
            if (videoUrl) {
              // Store the result so the polling endpoint can find it
              videoPreviewCache.set(previewId, {
                status: 'completed',
                url: videoUrl,
                media_type: 'video',
              });
            } else {
              videoPreviewCache.set(previewId, {
                status: 'failed',
                url: null,
                media_type: 'video',
              });
            }
          } catch (err) {
            logger.error({ err, previewId }, 'Video preview generation failed');
            videoPreviewCache.set(previewId, { status: 'failed', url: null, media_type: 'video' });
          }
        })();

        videoPreviewCache.set(previewId, { status: 'generating', url: null, media_type: 'video' });
        return res.json({ preview_id: previewId, status: 'generating', media_type: 'video' });
      }

      // Image generation -- synchronous (fast enough)
      const imageUrl = await generatePostImage(prompt, style || 'social_media_photo');
      if (!imageUrl) {
        return res.status(500).json({ error: 'Image generation failed' });
      }

      return res.json({ preview_url: imageUrl, media_type: 'image', status: 'completed' });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /social/media/preview');
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// In-memory cache for video preview status (cleared after 30 min)
const videoPreviewCache = new Map<
  string,
  { status: string; url: string | null; media_type: string }
>();
setInterval(
  () => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [key] of videoPreviewCache) {
      if (parseInt(key.split('_')[1] || '0') < cutoff) videoPreviewCache.delete(key);
    }
  },
  5 * 60 * 1000,
);

router.get('/media/preview/:previewId', requireAuth, async (req: AuthenticatedRequest, res) => {
  const { previewId } = req.params;
  const entry = videoPreviewCache.get(previewId);
  if (!entry) {
    return res.status(404).json({ error: 'Preview not found' });
  }
  return res.json({
    preview_id: previewId,
    status: entry.status,
    preview_url: entry.url,
    media_type: entry.media_type,
  });
});

// ─── Orchestration Panel (Trainer) ───────────────────────────────────────────

router.get(
  '/orchestration/session/:sessionId',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const { sessionId } = req.params;

      // 1. Get session with scenario_id and current_state
      const { data: session, error: sessErr } = await supabaseAdmin
        .from('sessions')
        .select('id, scenario_id, current_state, start_time, status')
        .eq('id', sessionId)
        .single();

      if (sessErr || !session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const elapsedMinutes = session.start_time
        ? Math.round((Date.now() - new Date(session.start_time as string).getTime()) / 60000)
        : 0;

      // 2. Fetch all condition-driven injects for this scenario
      const { data: condInjects } = await supabaseAdmin
        .from('scenario_injects')
        .select(
          'id, title, severity, conditions_to_appear, conditions_to_cancel, eligible_after_minutes',
        )
        .eq('scenario_id', session.scenario_id)
        .not('conditions_to_appear', 'is', null)
        .is('trigger_time_minutes', null);

      if (!condInjects || condInjects.length === 0) {
        return res.json({ data: [] });
      }

      // 3. Fetch published and cancelled inject IDs
      const { data: publishedEvents } = await supabaseAdmin
        .from('session_events')
        .select('event_type, metadata, created_at')
        .eq('session_id', sessionId)
        .in('event_type', ['inject', 'inject_cancelled']);

      const publishedMap = new Map<string, string>();
      const cancelledSet = new Set<string>();
      for (const evt of publishedEvents ?? []) {
        const meta = evt.metadata as { inject_id?: string; reason?: string } | null;
        if (!meta?.inject_id) continue;
        if (
          (evt as Record<string, unknown>).event_type === 'inject_cancelled' ||
          meta.reason === 'condition_cancel_met'
        ) {
          cancelledSet.add(meta.inject_id);
        } else {
          publishedMap.set(meta.inject_id, evt.created_at as string);
        }
      }

      // 4. Fetch decisions for context
      const { data: allDecisions } = await supabaseAdmin
        .from('decisions')
        .select('id, title, description, type')
        .eq('session_id', sessionId)
        .eq('status', 'executed');

      // 5. Build evaluation context
      const currentState = (session.current_state as Record<string, unknown>) || {};
      const publishedKeysOrTags: string[] = [];
      for (const evt of publishedEvents ?? []) {
        const meta = evt.metadata as { title?: string; tags?: string[] } | null;
        if (meta?.title) publishedKeysOrTags.push(meta.title);
        if (meta?.tags) publishedKeysOrTags.push(...meta.tags);
      }

      const evalContext: EvaluationContext = {
        sessionId,
        scenarioId: session.scenario_id as string,
        elapsedMinutes,
        currentState,
        executedDecisions: (allDecisions ?? []).map((d) => ({
          id: d.id,
          title: d.title ?? '',
          description: d.description ?? '',
          decision_type: d.type as string | undefined,
        })),
        publishedScenarioInjectIds: [...publishedMap.keys()],
        publishedInjectKeysOrTags: publishedKeysOrTags,
      };

      // 6. Evaluate each inject's conditions individually
      const results = condInjects.map((inj) => {
        const condAppear = inj.conditions_to_appear as
          | { all: string[] }
          | { threshold: number; conditions: string[] }
          | null;

        let keys: string[] = [];
        let mode: 'all' | 'threshold' = 'all';
        let threshold: number | undefined;

        if (condAppear && 'all' in condAppear) {
          keys = condAppear.all || [];
          mode = 'all';
        } else if (condAppear && 'conditions' in condAppear) {
          keys = condAppear.conditions || [];
          mode = 'threshold';
          threshold = Math.max(1, condAppear.threshold ?? 1);
        }

        const conditions = keys.map((key) => ({
          key,
          met: evaluateConditionKey(key, evalContext),
        }));

        const metCount = conditions.filter((c) => c.met).length;

        let status: 'published' | 'cancelled' | 'eligible' | 'waiting';
        if (publishedMap.has(inj.id)) {
          status = 'published';
        } else if (cancelledSet.has(inj.id)) {
          status = 'cancelled';
        } else if (
          mode === 'all'
            ? metCount === keys.length && keys.length > 0
            : metCount >= (threshold ?? 1)
        ) {
          status = 'eligible';
        } else {
          status = 'waiting';
        }

        return {
          id: inj.id,
          title: inj.title,
          severity: inj.severity,
          status,
          published_at: publishedMap.get(inj.id) ?? undefined,
          conditions,
          met_count: metCount,
          total_count: keys.length,
          mode,
          threshold,
        };
      });

      // Sort: published first, then eligible, then waiting by met_count desc, then cancelled
      const statusOrder = { published: 0, eligible: 1, waiting: 2, cancelled: 3 };
      results.sort((a, b) => {
        const sDiff = statusOrder[a.status] - statusOrder[b.status];
        if (sDiff !== 0) return sDiff;
        return b.met_count - a.met_count;
      });

      return res.json({ data: results });
    } catch (err) {
      logger.error({ error: err }, 'Error in GET /social/orchestration/session/:sessionId');
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Get org page info for a session
router.get('/org-page/session/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
    const { data, error } = await supabaseAdmin
      .from('sim_org_pages')
      .select('*')
      .eq('session_id', sessionId);

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch org pages' });
    }

    res.json({ data: data || [] });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /social/org-page/session/:sessionId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper: group sim_org_pages rows into a per-org structure keyed by org_key
function groupOrgPages(rows: Array<Record<string, unknown>>) {
  const map = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const orgKey = String(row.org_key || 'primary');
    if (!map.has(orgKey)) {
      map.set(orgKey, {
        org_key: orgKey,
        is_primary: !!row.is_primary,
        role: String(row.role || 'protagonist'),
        control_mode: String(row.control_mode || 'player'),
        display_name: String(row.page_name || 'Organization'),
        facebook: null,
        x_twitter: null,
      });
    }
    const entry = map.get(orgKey)!;
    if (row.platform === 'facebook') entry.facebook = row;
    else if (row.platform === 'x_twitter') entry.x_twitter = row;
    if (row.is_primary) entry.is_primary = true;
    if (row.role) entry.role = String(row.role);
    if (row.control_mode) entry.control_mode = String(row.control_mode);
  }
  return Array.from(map.values());
}

// List org pages (grouped by org_key) and their controllers for a session
router.get('/pages/session/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
    const [pagesResult, controllersResult] = await Promise.all([
      supabaseAdmin.from('sim_org_pages').select('*').eq('session_id', sessionId),
      supabaseAdmin
        .from('session_page_controllers')
        .select('user_id, org_key')
        .eq('session_id', sessionId),
    ]);

    if (pagesResult.error) {
      return res.status(500).json({ error: 'Failed to fetch org pages' });
    }

    const grouped = groupOrgPages(pagesResult.data || []);
    const controllers = controllersResult.data || [];
    const withControllers = grouped.map((g) => ({
      ...g,
      controllers: controllers
        .filter((c) => c.org_key === g.org_key)
        .map((c) => c.user_id as string),
    }));

    res.json({ data: withControllers });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /social/pages/session/:sessionId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get the page (org) the current player controls for a session
router.get('/my-page/session/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
    const user = req.user!;

    const { data: controller } = await supabaseAdmin
      .from('session_page_controllers')
      .select('org_key')
      .eq('session_id', sessionId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (!controller?.org_key) {
      return res.json({ data: null });
    }

    const { data: rows } = await supabaseAdmin
      .from('sim_org_pages')
      .select('*')
      .eq('session_id', sessionId)
      .eq('org_key', controller.org_key);

    const grouped = groupOrgPages(rows || []);
    res.json({ data: grouped[0] || null });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /social/my-page/session/:sessionId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Assign a player to a page (trainer only). Each player controls at most one page.
router.post(
  '/pages/session/:sessionId/assign',
  requireAuth,
  validate(
    z.object({
      params: z.object({ sessionId: z.string().uuid() }),
      body: z.object({ user_id: z.string().uuid(), org_key: z.string().min(1) }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { sessionId } = req.params;
      const user = req.user!;
      const { user_id, org_key } = req.body;

      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can assign pages' });
      }

      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('id, trainer_id')
        .eq('id', sessionId)
        .single();
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (session.trainer_id !== user.id && user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Players may only control protagonist pages. Antagonist (rival) pages are
      // trainer/AI-driven and must never be assigned to a participant.
      const { data: targetPage } = await supabaseAdmin
        .from('sim_org_pages')
        .select('role')
        .eq('session_id', sessionId)
        .eq('org_key', org_key)
        .limit(1)
        .maybeSingle();
      if (!targetPage) {
        return res.status(404).json({ error: 'Org page not found for this session' });
      }
      if (String(targetPage.role) === 'antagonist') {
        return res
          .status(400)
          .json({ error: 'Antagonist (rival) pages cannot be assigned to players' });
      }

      const { data: assignment, error } = await supabaseAdmin
        .from('session_page_controllers')
        .upsert(
          { session_id: sessionId, user_id, org_key, assigned_by: user.id },
          { onConflict: 'session_id,user_id' },
        )
        .select()
        .single();

      if (error) {
        logger.error(
          { error, sessionId, userId: user_id, orgKey: org_key },
          'Failed to assign page',
        );
        return res.status(500).json({ error: 'Failed to assign page' });
      }

      res.status(201).json({ data: assignment });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /social/pages/session/:sessionId/assign');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Remove a player's page assignment (trainer only)
router.delete(
  '/pages/session/:sessionId/assign',
  requireAuth,
  validate(
    z.object({
      params: z.object({ sessionId: z.string().uuid() }),
      body: z.object({ user_id: z.string().uuid() }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { sessionId } = req.params;
      const user = req.user!;
      const { user_id } = req.body;

      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can remove page assignments' });
      }

      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('id, trainer_id')
        .eq('id', sessionId)
        .single();
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (session.trainer_id !== user.id && user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { error } = await supabaseAdmin
        .from('session_page_controllers')
        .delete()
        .eq('session_id', sessionId)
        .eq('user_id', user_id);

      if (error) {
        return res.status(500).json({ error: 'Failed to remove page assignment' });
      }

      res.json({ success: true });
    } catch (err) {
      logger.error({ error: err }, 'Error in DELETE /social/pages/session/:sessionId/assign');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Trainer takeover: post AS an antagonist (rival) org page (trainer only).
// Bypasses session_page_controllers (UNIQUE per user) so the trainer can drive
// multiple antagonist pages. Posts carry hostile content_flags so scoring counts them.
router.post(
  '/pages/session/:sessionId/post-as',
  requireAuth,
  validate(
    z.object({
      params: z.object({ sessionId: z.string().uuid() }),
      body: z.object({
        org_key: z.string().min(1),
        platform: z.enum(['x_twitter', 'facebook']),
        content: z.string().min(1),
        content_flags: z.record(z.string(), z.unknown()).optional(),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { sessionId } = req.params;
      const user = req.user!;
      const { org_key, platform, content, content_flags } = req.body;

      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can post as antagonist pages' });
      }

      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('id, trainer_id')
        .eq('id', sessionId)
        .single();
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (session.trainer_id !== user.id && user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { data: page } = await supabaseAdmin
        .from('sim_org_pages')
        .select('page_name, page_handle, role')
        .eq('session_id', sessionId)
        .eq('org_key', org_key)
        .eq('platform', platform)
        .maybeSingle();
      if (!page) return res.status(404).json({ error: 'Org page not found' });
      if (String(page.role) !== 'antagonist') {
        return res.status(400).json({ error: 'post-as is only for antagonist pages' });
      }

      const flags = (content_flags as Record<string, unknown>) || {
        is_harmful_narrative: true,
        is_inflammatory: true,
      };
      const sentiment =
        flags.is_hate_speech || flags.incites_violence
          ? 'hateful'
          : flags.is_inflammatory || flags.is_harmful_narrative
            ? 'inflammatory'
            : 'negative';
      const hashtags = (content.match(/#\w+/g) || []) as string[];

      const { data: post, error } = await supabaseAdmin
        .from('social_posts')
        .insert({
          session_id: sessionId,
          platform,
          author_handle: String(page.page_handle),
          author_display_name: String(page.page_name),
          author_type: 'official_account',
          content,
          hashtags,
          sentiment,
          content_flags: flags,
          virality_score: 55 + Math.floor(Math.random() * 25),
          posted_by_user_id: user.id,
          posted_by_display_name: 'Adversary Console',
        })
        .select()
        .single();

      if (error) {
        logger.error({ error, sessionId, org_key }, 'Failed to post as antagonist page');
        return res.status(500).json({ error: 'Failed to create post' });
      }

      getWebSocketService().broadcastToSession(sessionId, {
        type: 'social_post.created',
        data: { post },
        timestamp: new Date().toISOString(),
      });

      res.status(201).json({ data: post });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /social/pages/session/:sessionId/post-as');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Seize / release an antagonist page: toggle control_mode between ai and trainer.
router.post(
  '/pages/session/:sessionId/seize',
  requireAuth,
  validate(
    z.object({
      params: z.object({ sessionId: z.string().uuid() }),
      body: z.object({ org_key: z.string().min(1), control_mode: z.enum(['ai', 'trainer']) }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { sessionId } = req.params;
      const user = req.user!;
      const { org_key, control_mode } = req.body;

      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can seize pages' });
      }

      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('id, trainer_id')
        .eq('id', sessionId)
        .single();
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (session.trainer_id !== user.id && user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { error } = await supabaseAdmin
        .from('sim_org_pages')
        .update({ control_mode })
        .eq('session_id', sessionId)
        .eq('org_key', org_key)
        .eq('role', 'antagonist');

      if (error) {
        return res.status(500).json({ error: 'Failed to update control mode' });
      }

      res.json({ data: { org_key, control_mode } });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /social/pages/session/:sessionId/seize');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Get player's own activity for a session
router.get(
  '/my-activity/session/:sessionId',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const { sessionId } = req.params;
      const user = req.user!;

      const [postsResult, actionsResult] = await Promise.all([
        supabaseAdmin
          .from('social_posts')
          .select(
            'id, content, platform, author_type, author_handle, author_display_name, post_format, created_at, like_count, reply_count, view_count, posted_by_display_name',
          )
          .eq('session_id', sessionId)
          .eq('user_id', user.id)
          .order('created_at', { ascending: false }),
        supabaseAdmin
          .from('player_actions')
          .select('action_type, target_id, content, created_at')
          .eq('session_id', sessionId)
          .eq('player_id', user.id)
          .in('action_type', ['post_liked', 'post_reposted', 'reply_posted', 'post_flagged'])
          .order('created_at', { ascending: false })
          .limit(50),
      ]);

      res.json({
        posts: postsResult.data || [],
        actions: actionsResult.data || [],
      });
    } catch (err) {
      logger.error({ error: err }, 'Error in GET /social/my-activity');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export { router as socialMediaRouter };
