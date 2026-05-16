import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from '../services/websocketService.js';
import { recordPlayerAction } from '../services/sopCheckerService.js';
import { randomUUID } from 'crypto';

const router = Router();

// ─── List Conversation Threads ───────────────────────────────────────────────

router.get('/threads/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
    const user = req.user!;
    const platformFilter = req.query.platform as string | undefined;

    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('full_name')
      .eq('id', user.id)
      .single();

    const playerName =
      (user.metadata?.full_name as string) || profile?.full_name || user.email || 'Player';
    const playerHandle = `@${playerName.replace(/[@.\s+,]/g, '_').toLowerCase()}`;

    let query = supabaseAdmin
      .from('sim_direct_messages')
      .select('*')
      .eq('session_id', sessionId)
      .or(`sender_handle.eq."${playerHandle}",recipient_handle.eq."${playerHandle}"`);

    if (platformFilter) {
      query = query.eq('platform', platformFilter);
    }

    query = query.order('created_at', { ascending: false });

    const { data: messages, error } = await query;

    if (error) {
      logger.error({ error, sessionId }, 'Failed to fetch DM threads');
      return res.status(500).json({ error: 'Failed to fetch DM threads' });
    }

    const threadMap = new Map<
      string,
      {
        thread_id: string;
        latest_message: (typeof messages)[0];
        unread_count: number;
        other_participant: { handle: string; display_name: string };
      }
    >();

    for (const msg of messages || []) {
      const existing = threadMap.get(msg.thread_id);
      const isIncoming = msg.recipient_handle === playerHandle;
      const otherHandle = isIncoming ? msg.sender_handle : msg.recipient_handle;
      const otherDisplayName = isIncoming ? msg.sender_display_name : otherHandle;

      if (!existing) {
        threadMap.set(msg.thread_id, {
          thread_id: msg.thread_id,
          latest_message: msg,
          unread_count: isIncoming && !msg.is_read ? 1 : 0,
          other_participant: { handle: otherHandle, display_name: otherDisplayName },
        });
      } else {
        if (new Date(msg.created_at) > new Date(existing.latest_message.created_at)) {
          existing.latest_message = msg;
        }
        if (isIncoming && !msg.is_read) {
          existing.unread_count += 1;
        }
        if (
          !existing.other_participant.display_name ||
          existing.other_participant.display_name === existing.other_participant.handle
        ) {
          if (otherDisplayName && otherDisplayName !== otherHandle) {
            existing.other_participant.display_name = otherDisplayName;
          }
        }
      }
    }

    const threads = Array.from(threadMap.values()).sort(
      (a, b) =>
        new Date(b.latest_message.created_at).getTime() -
        new Date(a.latest_message.created_at).getTime(),
    );

    res.json({ data: threads });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /messenger/threads/:sessionId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Get Thread Messages ─────────────────────────────────────────────────────

router.get('/thread/:threadId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { threadId } = req.params;

    const { data, error } = await supabaseAdmin
      .from('sim_direct_messages')
      .select('*')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true });

    if (error) {
      logger.error({ error, threadId }, 'Failed to fetch thread messages');
      return res.status(500).json({ error: 'Failed to fetch thread messages' });
    }

    res.json({ data: data || [] });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /messenger/thread/:threadId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Send Direct Message ─────────────────────────────────────────────────────

router.post('/send', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    const { session_id, recipient_handle, content, platform } = req.body;

    if (!session_id || !recipient_handle || !content) {
      return res
        .status(400)
        .json({ error: 'session_id, recipient_handle, and content are required' });
    }

    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('full_name')
      .eq('id', user.id)
      .single();

    const playerName =
      (user.metadata?.full_name as string) || profile?.full_name || user.email || 'Player';
    const senderHandle = `@${playerName.replace(/[@.\s+,]/g, '_').toLowerCase()}`;

    // Find existing thread between these two handles in this session
    const { data: existingThread } = await supabaseAdmin
      .from('sim_direct_messages')
      .select('thread_id')
      .eq('session_id', session_id)
      .or(
        `and(sender_handle.eq.${senderHandle},recipient_handle.eq.${recipient_handle}),and(sender_handle.eq.${recipient_handle},recipient_handle.eq.${senderHandle})`,
      )
      .limit(1)
      .single();

    const threadId = existingThread?.thread_id || randomUUID();

    const { data: message, error } = await supabaseAdmin
      .from('sim_direct_messages')
      .insert({
        session_id,
        thread_id: threadId,
        sender_handle: senderHandle,
        sender_display_name: playerName,
        sender_type: 'player',
        recipient_handle,
        recipient_user_id: null,
        content,
        media_urls: null,
        is_read: false,
        platform: platform || 'facebook',
      })
      .select()
      .single();

    if (error) {
      logger.error({ error, userId: user.id }, 'Failed to send DM');
      return res.status(500).json({ error: 'Failed to send message' });
    }

    getWebSocketService().broadcastToSession(session_id, {
      type: 'messenger.received',
      data: { message },
      timestamp: new Date().toISOString(),
    });

    await recordPlayerAction(session_id, user.id, 'dm_sent', message.id, content);

    res.status(201).json({ data: message });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /messenger/send');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Mark Message as Read ────────────────────────────────────────────────────

router.post('/:messageId/read', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { messageId } = req.params;

    const { data: msg } = await supabaseAdmin
      .from('sim_direct_messages')
      .select('id, session_id')
      .eq('id', messageId)
      .single();

    if (!msg) return res.status(404).json({ error: 'Message not found' });

    const { error } = await supabaseAdmin
      .from('sim_direct_messages')
      .update({ is_read: true })
      .eq('id', messageId);

    if (error) {
      logger.error({ error, messageId }, 'Failed to mark message as read');
      return res.status(500).json({ error: 'Failed to mark message as read' });
    }

    res.json({ success: true });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /messenger/:messageId/read');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Unread Count ────────────────────────────────────────────────────────────

router.get('/unread-count/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
    const user = req.user!;
    const platformFilter = req.query.platform as string | undefined;

    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('full_name')
      .eq('id', user.id)
      .single();

    const playerName =
      (user.metadata?.full_name as string) || profile?.full_name || user.email || 'Player';
    const playerHandle = `@${playerName.replace(/[@.\s+,]/g, '_').toLowerCase()}`;

    let query = supabaseAdmin
      .from('sim_direct_messages')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', sessionId)
      .eq('recipient_handle', playerHandle)
      .eq('is_read', false);

    if (platformFilter) {
      query = query.eq('platform', platformFilter);
    }

    const { count, error } = await query;

    if (error) {
      logger.error({ error, sessionId }, 'Failed to fetch unread DM count');
      return res.status(500).json({ error: 'Failed to fetch unread count' });
    }

    res.json({ data: { unread_count: count || 0 } });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /messenger/unread-count/:sessionId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as socialMessengerRouter };
