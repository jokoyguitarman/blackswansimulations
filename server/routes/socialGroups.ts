import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from '../services/websocketService.js';
import { recordPlayerAction } from '../services/sopCheckerService.js';

const router = Router();

// ─── List Groups for a Session ───────────────────────────────────────────────

router.get('/session/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
    const platformFilter = req.query.platform as string | undefined;

    let query = supabaseAdmin
      .from('sim_groups')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false });

    if (platformFilter) {
      query = query.eq('platform', platformFilter);
    }

    const { data, error } = await query;

    if (error) {
      logger.error({ error, sessionId }, 'Failed to fetch groups');
      return res.status(500).json({ error: 'Failed to fetch groups' });
    }

    res.json({ data });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /groups/session/:sessionId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Get Posts in a Group ────────────────────────────────────────────────────

router.get('/:groupId/posts', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { groupId } = req.params;
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    const {
      data: topLevelPosts,
      error,
      count,
    } = await supabaseAdmin
      .from('sim_group_posts')
      .select('*', { count: 'exact' })
      .eq('group_id', groupId)
      .is('reply_to_post_id', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      logger.error({ error, groupId }, 'Failed to fetch group posts');
      return res.status(500).json({ error: 'Failed to fetch group posts' });
    }

    const postIds = (topLevelPosts || []).map((p) => p.id);

    let replies: typeof topLevelPosts = [];
    if (postIds.length > 0) {
      const { data: replyData } = await supabaseAdmin
        .from('sim_group_posts')
        .select('*')
        .in('reply_to_post_id', postIds)
        .order('created_at', { ascending: true });
      replies = replyData || [];
    }

    const repliesByParent = new Map<string, typeof replies>();
    for (const reply of replies) {
      const parentId = reply.reply_to_post_id as string;
      if (!repliesByParent.has(parentId)) {
        repliesByParent.set(parentId, []);
      }
      repliesByParent.get(parentId)!.push(reply);
    }

    const postsWithReplies = (topLevelPosts || []).map((post) => ({
      ...post,
      replies: repliesByParent.get(post.id) || [],
    }));

    res.json({ data: postsWithReplies, count, page, limit });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /groups/:groupId/posts');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Player Posts in a Group ─────────────────────────────────────────────────

router.post('/:groupId/posts', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    const { groupId } = req.params;
    const { session_id, content } = req.body;

    if (!session_id || !content) {
      return res.status(400).json({ error: 'session_id and content are required' });
    }

    let playerName = user.metadata?.full_name as string | undefined;
    if (!playerName) {
      const { data: profile } = await supabaseAdmin
        .from('user_profiles')
        .select('full_name')
        .eq('id', user.id)
        .single();
      playerName = profile?.full_name || undefined;
    }
    const displayName = playerName || user.email || 'Player';
    const handle = `@${(playerName || user.email || user.id.slice(0, 8)).replace(/[@.\s+]/g, '_').toLowerCase()}`;

    const { data: post, error } = await supabaseAdmin
      .from('sim_group_posts')
      .insert({
        group_id: groupId,
        session_id,
        author_handle: handle,
        author_display_name: displayName,
        author_type: 'player',
        content,
      })
      .select()
      .single();

    if (error) {
      logger.error({ error, userId: user.id }, 'Failed to create group post');
      return res.status(500).json({ error: 'Failed to create group post' });
    }

    getWebSocketService().broadcastToSession(session_id, {
      type: 'group_post.created',
      data: { post },
      timestamp: new Date().toISOString(),
    });

    await recordPlayerAction(session_id, user.id, 'group_post_created', post.id, content);

    res.status(201).json({ data: post });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /groups/:groupId/posts');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Player Joins a Group ────────────────────────────────────────────────────

router.post('/:groupId/join', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    const { groupId } = req.params;
    const { session_id } = req.body;

    const { data: group, error: fetchError } = await supabaseAdmin
      .from('sim_groups')
      .select('id, member_count, session_id')
      .eq('id', groupId)
      .single();

    if (fetchError || !group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const { error: updateError } = await supabaseAdmin
      .from('sim_groups')
      .update({ member_count: (group.member_count || 0) + 1 })
      .eq('id', groupId);

    if (updateError) {
      logger.error({ error: updateError, groupId }, 'Failed to join group');
      return res.status(500).json({ error: 'Failed to join group' });
    }

    const effectiveSessionId = session_id || group.session_id;
    await recordPlayerAction(effectiveSessionId, user.id, 'group_joined', groupId, null);

    res.json({ success: true });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /groups/:groupId/join');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Like a Group Post ───────────────────────────────────────────────────────

router.post('/:groupId/posts/:postId/like', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { postId } = req.params;

    const { data: post, error: fetchError } = await supabaseAdmin
      .from('sim_group_posts')
      .select('id, like_count')
      .eq('id', postId)
      .single();

    if (fetchError || !post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const { error: updateError } = await supabaseAdmin
      .from('sim_group_posts')
      .update({ like_count: (post.like_count || 0) + 1 })
      .eq('id', postId);

    if (updateError) {
      logger.error({ error: updateError, postId }, 'Failed to like group post');
      return res.status(500).json({ error: 'Failed to like post' });
    }

    res.json({ success: true });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /groups/:groupId/posts/:postId/like');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as socialGroupsRouter };
