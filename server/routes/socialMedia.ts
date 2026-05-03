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

const router = Router();

// ─── Social Posts ────────────────────────────────────────────────────────────

router.get('/posts/session/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
    const user = req.user!;
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    const [postsResult, likesResult, flagsResult] = await Promise.all([
      supabaseAdmin
        .from('social_posts')
        .select('*', { count: 'exact' })
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1),
      supabaseAdmin.from('social_post_likes').select('post_id').eq('player_id', user.id),
      supabaseAdmin.from('social_post_flags').select('post_id').eq('player_id', user.id),
    ]);

    const { data, error, count } = postsResult;

    if (error) {
      logger.error({ error, sessionId }, 'Failed to fetch social posts');
      return res.status(500).json({ error: 'Failed to fetch social posts' });
    }

    const likedPostIds = new Set((likesResult.data || []).map((l) => l.post_id));
    const flaggedPostIds = new Set((flagsResult.data || []).map((f) => f.post_id));

    const enrichedData = (data || []).map((post) => ({
      ...post,
      liked_by_me: likedPostIds.has(post.id),
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
    content: z.string().min(1).max(500),
    reply_to_post_id: z.string().uuid().optional(),
    platform: z
      .enum(['x_twitter', 'facebook', 'instagram', 'tiktok', 'reddit', 'forum'])
      .default('x_twitter'),
  }),
});

router.post(
  '/posts',
  requireAuth,
  validate(createPostSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const { session_id, content, reply_to_post_id, platform } = req.body;

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
      } else {
        await recordPlayerAction(session_id, user.id, 'post_created', post.id, content);
      }

      // Auto-grade replies to harmful posts
      if (reply_to_post_id) {
        void (async () => {
          try {
            const { data: parentPost } = await supabaseAdmin
              .from('social_posts')
              .select('content, content_flags, session_id')
              .eq('id', reply_to_post_id)
              .single();

            if (!parentPost) return;
            const flags = (parentPost.content_flags || {}) as Record<string, unknown>;
            const isHarmful = !!(
              flags.is_hate_speech ||
              flags.is_misinformation ||
              flags.is_racist ||
              flags.incites_violence
            );
            if (!isHarmful) return;

            const { data: sessionData } = await supabaseAdmin
              .from('sessions')
              .select('scenario_id')
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

            const { gradePlayerContent } = await import('../services/contentGraderService.js');
            const grade = await gradePlayerContent(content, {
              crisis_description: scenario.description || '',
              confirmed_facts: confirmedFacts,
              hateful_post_being_addressed: String(parentPost.content || ''),
              research_guidelines: flatGuidelines.slice(0, 5),
            });

            await supabaseAdmin
              .from('social_posts')
              .update({ sop_compliance_score: grade })
              .eq('id', post.id);

            logger.info(
              { postId: post.id, overall: grade.overall },
              'Auto-graded reply to harmful post',
            );
          } catch (gradeErr) {
            logger.warn({ err: gradeErr }, 'Auto-grade failed (non-critical)');
          }
        })();
      }

      getWebSocketService().broadcastToSession(session_id, {
        type: 'social_post.created',
        data: { post },
        timestamp: new Date().toISOString(),
      });

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

    const { data: existing } = await supabaseAdmin
      .from('social_post_likes')
      .select('id')
      .eq('post_id', postId)
      .eq('player_id', user.id)
      .single();

    if (existing) {
      return res.json({ success: true, already_liked: true });
    }

    await supabaseAdmin.from('social_post_likes').insert({ post_id: postId, player_id: user.id });

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

      await recordPlayerAction(post.session_id, user.id, 'post_liked', postId, null);
    }

    res.json({ success: true });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /social/posts/:postId/like');
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

export { router as socialMediaRouter };
