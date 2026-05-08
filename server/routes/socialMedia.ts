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

const router = Router();

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

    let postsQuery = supabaseAdmin
      .from('social_posts')
      .select('*', { count: 'exact' })
      .eq('session_id', sessionId)
      .eq('platform_removed', false);

    if (platformFilter) {
      postsQuery = postsQuery.eq('platform', platformFilter);
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
        .select('post_id, reaction_type')
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

    const likedPostIds = new Set((likesResult.data || []).map((l) => l.post_id));
    const reactionByPost = new Map<string, string>();
    for (const l of likesResult.data || []) {
      reactionByPost.set(l.post_id, String(l.reaction_type || 'like'));
    }
    const flaggedPostIds = new Set((flagsResult.data || []).map((f) => f.post_id));
    const playerDemographics = (participantResult.data?.demographics || null) as Record<
      string,
      string
    > | null;

    const enrichedData = (data || [])
      .filter((post) => {
        if (!post.target_demographics) return true;
        if (!playerDemographics) return true;
        const target = post.target_demographics as Record<string, string | string[]>;
        return Object.entries(target).every(([key, vals]) => {
          const playerVal = playerDemographics[key];
          if (!playerVal) return true;
          if (Array.isArray(vals)) return vals.includes(playerVal);
          return vals === playerVal;
        });
      })
      .map((post) => ({
        ...post,
        liked_by_me: likedPostIds.has(post.id),
        my_reaction: reactionByPost.get(post.id) || null,
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
      } = req.body;

      const hashtags = content.match(/#\w+/g) || [];

      const { data: post, error } = await supabaseAdmin
        .from('social_posts')
        .insert({
          session_id,
          platform,
          author_handle: `@${(user.email || user.id.slice(0, 8)).replace(/[@.\s+]/g, '_').toLowerCase()}`,
          author_display_name: (user.metadata?.full_name as string) || user.email || 'Player',
          author_type: 'player',
          content,
          hashtags,
          reply_to_post_id: reply_to_post_id || null,
          sentiment: 'neutral',
          post_format: post_format || 'text',
          image_prompt: image_prompt || null,
          media_urls: media_url ? [media_url] : null,
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
        await recordPlayerAction(session_id, user.id, 'reply_posted', reply_to_post_id, content);

        // Notify the parent post author about the reply
        const { data: parentForNotif } = await supabaseAdmin
          .from('social_posts')
          .select('author_handle, author_type, platform')
          .eq('id', reply_to_post_id)
          .single();
        if (parentForNotif && parentForNotif.author_type === 'player') {
          void notifyPostReply(
            session_id,
            (user.metadata?.full_name as string) || user.email || 'Player',
            parentForNotif.author_handle,
            reply_to_post_id,
            content,
            parentForNotif.platform || platform,
          );
        }

        // Trigger NPC reactions to player replies on NPC posts (non-blocking)
        void triggerNPCReactions(session_id, post).catch((err) =>
          logger.warn({ err, postId: post.id }, 'NPC reply reaction failed (non-critical)'),
        );
      } else {
        await recordPlayerAction(session_id, user.id, 'post_created', post.id, content, {
          post_format: post_format || 'text',
        });
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

            if (isVideo) {
              // Generate actual video (10s for UGC-style)
              mediaUrl = await generateVideo(promptText, 10, '16:9');
              // Fall back to thumbnail if video gen fails
              if (!mediaUrl) mediaUrl = await generateVideoThumbnail(promptText);
            } else {
              const style = imageStyle || 'social_media_photo';
              mediaUrl = await generatePostImage(promptText, style);
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

    const { data: existing } = await supabaseAdmin
      .from('social_post_likes')
      .select('id, reaction_type')
      .eq('post_id', postId)
      .eq('player_id', user.id)
      .single();

    if (existing) {
      if (existing.reaction_type !== reactionType) {
        await supabaseAdmin
          .from('social_post_likes')
          .update({ reaction_type: reactionType })
          .eq('id', existing.id);
      }
      return res.json({ success: true, updated: true, reaction_type: reactionType });
    }

    await supabaseAdmin
      .from('social_post_likes')
      .insert({ post_id: postId, player_id: user.id, reaction_type: reactionType });

    const { data: post } = await supabaseAdmin
      .from('social_posts')
      .select('like_count, session_id')
      .eq('id', postId)
      .single();

    if (post) {
      await supabaseAdmin
        .from('social_posts')
        .update({ like_count: (post.like_count || 0) + 1 })
        .eq('id', postId);

      await recordPlayerAction(post.session_id, user.id, 'post_liked', postId, null, {
        reaction_type: reactionType,
      });

      // Notify the post author about the like
      const { data: likedPost } = await supabaseAdmin
        .from('social_posts')
        .select('author_handle, author_type, platform')
        .eq('id', postId)
        .single();
      if (likedPost && likedPost.author_type === 'player') {
        void notifyPostLike(
          post.session_id,
          likedPost.author_handle,
          (user.metadata?.full_name as string) || user.email || 'Player',
          reactionType,
          likedPost.platform || 'x_twitter',
        );
      }
    }

    res.json({ success: true });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /social/posts/:postId/like');
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
      .select('session_id')
      .eq('id', postId)
      .single();

    if (!post) return res.status(404).json({ error: 'Post not found' });

    await supabaseAdmin.from('social_post_flags').insert({ post_id: postId, player_id: user.id });

    await supabaseAdmin
      .from('social_posts')
      .update({ is_flagged_by_player: true })
      .eq('id', postId);

    await recordPlayerAction(post.session_id, user.id, 'post_flagged', postId, null, {}, 'monitor');

    getWebSocketService().broadcastToSession(post.session_id, {
      type: 'social_post.flagged',
      data: { post_id: postId, flagged_by: user.id },
      timestamp: new Date().toISOString(),
    });

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
        author_handle: `@${(user.email || user.id.slice(0, 8)).replace(/[@.\s+]/g, '_').toLowerCase()}`,
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

    res.status(201).json({ data: repost });
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
      .select('session_id')
      .eq('id', emailId)
      .single();

    if (!email) return res.status(404).json({ error: 'Email not found' });

    await supabaseAdmin.from('sim_emails').update({ is_read: true }).eq('id', emailId);

    await recordPlayerAction(email.session_id, user.id, 'email_read', emailId, null);

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

      const { data: email, error } = await supabaseAdmin
        .from('sim_emails')
        .insert({
          session_id,
          direction: 'outbound',
          from_address: `${(user.email || 'player').replace(/@.*/, '').replace(/\s+/g, '.')}@harmony.gov.sg`,
          from_name: (user.metadata?.full_name as string) || user.email || 'Player',
          to_addresses,
          cc_addresses: cc_addresses || [],
          subject,
          body_html: `<p>${body_text.replace(/\n/g, '</p><p>')}</p>`,
          body_text,
          replied_to_id: replied_to_id || null,
          thread_id: replied_to_id || null,
          sent_by_player_id: user.id,
        })
        .select()
        .single();

      if (error) return res.status(500).json({ error: 'Failed to send email' });

      await recordPlayerAction(session_id, user.id, 'email_sent', email.id, body_text);

      getWebSocketService().broadcastToSession(session_id, {
        type: 'sim_email.sent',
        data: { email },
        timestamp: new Date().toISOString(),
      });

      res.status(201).json({ data: email });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /social/emails');
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

    await recordPlayerAction(article.session_id, user.id, 'news_read', articleId, null);
    res.json({ success: true });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /social/news/:articleId/read');
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
      const { session_id, content, post_id, hateful_post_content } = req.body;

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

export { router as socialMediaRouter };
