import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { validate, schemas } from '../lib/validation.js';
import { logAndBroadcastEvent } from '../services/eventService.js';
import { getWebSocketService } from '../services/websocketService.js';
import { createNotification } from '../services/notificationService.js';
import { io } from '../index.js';

const router = Router();

const createChannelSchema = z.object({
  body: z.object({
    session_id: z.string().uuid(),
    name: z.string().min(1).max(100),
    type: z.enum([
      'private',
      'inter_agency',
      'command',
      'public',
      'trainer',
      'role_specific',
      'direct',
    ]),
    role_filter: z.string().optional(),
  }),
});

const createDMSchema = z.object({
  params: z.object({
    sessionId: z.string().uuid(),
  }),
  body: z.object({
    recipient_id: z.string().uuid(),
  }),
});

const createMessageSchema = z.object({
  params: z.object({
    channelId: z.string().uuid(),
  }),
  body: z.object({
    content: z.string().min(1).max(5000),
    message_type: z.enum(['text', 'system', 'sitrep', 'alert']).default('text'),
  }),
});

// Get channels for a session (excludes direct messages - use /dms endpoint for those)
router.get('/session/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
    const user = req.user!;

    // Verify user has access to session
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('id, trainer_id')
      .eq('id', sessionId)
      .single();

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Check if user is trainer or participant
    if (session.trainer_id !== user.id && user.role !== 'admin') {
      const { data: participant } = await supabaseAdmin
        .from('session_participants')
        .select('*')
        .eq('session_id', sessionId)
        .eq('user_id', user.id)
        .single();

      if (!participant) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    // Get all channels except direct messages
    const { data, error } = await supabaseAdmin
      .from('chat_channels')
      .select('*')
      .eq('session_id', sessionId)
      .neq('type', 'direct')
      .order('created_at', { ascending: true });

    if (error) {
      logger.error({ error, sessionId }, 'Failed to fetch channels');
      return res.status(500).json({ error: 'Failed to fetch channels' });
    }

    res.json({ data });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /channels/session/:sessionId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get direct message conversations for a user in a session
router.get('/session/:sessionId/dms', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
    const user = req.user!;

    // Verify user has access to session
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('id, trainer_id')
      .eq('id', sessionId)
      .maybeSingle();

    if (sessionError) {
      logger.error(
        {
          error: sessionError,
          errorCode: sessionError.code,
          errorMessage: sessionError.message,
          errorDetails: sessionError.details,
          errorHint: sessionError.hint,
          sessionId,
        },
        'Failed to fetch session',
      );
      return res
        .status(500)
        .json({ error: 'Failed to fetch session', details: sessionError.message });
    }

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Check if user is trainer or participant
    if (session.trainer_id !== user.id && user.role !== 'admin') {
      const { data: participant, error: participantError } = await supabaseAdmin
        .from('session_participants')
        .select('*')
        .eq('session_id', sessionId)
        .eq('user_id', user.id)
        .maybeSingle();

      if (participantError) {
        logger.error(
          {
            error: participantError,
            errorCode: participantError.code,
            errorMessage: participantError.message,
            sessionId,
            userId: user.id,
          },
          'Failed to check participant status',
        );
        return res
          .status(500)
          .json({ error: 'Failed to verify access', details: participantError.message });
      }

      if (!participant) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    // Get all direct message channels for the session (filter members in JavaScript)
    const { data: allDmChannels, error: channelsError } = await supabaseAdmin
      .from('chat_channels')
      .select('*')
      .eq('session_id', sessionId)
      .eq('type', 'direct')
      .order('created_at', { ascending: false });

    if (channelsError) {
      logger.error(
        {
          error: channelsError,
          errorCode: channelsError.code,
          errorMessage: channelsError.message,
          errorDetails: channelsError.details,
          errorHint: channelsError.hint,
          sessionId,
          userId: user.id,
        },
        'Failed to fetch DM channels',
      );
      return res
        .status(500)
        .json({ error: 'Failed to fetch DM channels', details: channelsError.message });
    }

    // Filter channels where user is a member (members is JSONB array)
    const dmChannels = (allDmChannels || []).filter((channel: any) => {
      const members = (channel.members as string[]) || [];
      return Array.isArray(members) && members.includes(user.id);
    });

    // Enrich with recipient info (resilient - one failure doesn't break all)
    const enrichedChannels = await Promise.all(
      dmChannels.map(async (channel: any) => {
        try {
          const members = (channel.members as string[]) || [];
          const recipientId = members.find((id: string) => id !== user.id);

          if (!recipientId) {
            return { ...channel, recipient: null, last_message: null };
          }

          const { data: recipient, error: recipientError } = await supabaseAdmin
            .from('user_profiles')
            .select('id, full_name, role, agency_name')
            .eq('id', recipientId)
            .maybeSingle();

          if (recipientError) {
            logger.warn(
              {
                error: recipientError,
                recipientId,
                channelId: channel.id,
                userId: user.id,
              },
              'Failed to fetch recipient info for DM channel',
            );
          }

          // Get last message for preview
          const { data: lastMessage, error: messageError } = await supabaseAdmin
            .from('chat_messages')
            .select('content, created_at')
            .eq('channel_id', channel.id)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (messageError) {
            logger.warn(
              {
                error: messageError,
                channelId: channel.id,
                userId: user.id,
              },
              'Failed to fetch last message for DM channel',
            );
          }

          return {
            ...channel,
            recipient: recipient || null,
            last_message: lastMessage || null,
          };
        } catch (enrichError) {
          logger.error(
            {
              error: enrichError,
              channelId: channel.id,
              userId: user.id,
            },
            'Error enriching DM channel',
          );
          // Return channel without enrichment rather than failing completely
          return { ...channel, recipient: null, last_message: null };
        }
      }),
    );

    res.json({ data: enrichedChannels });
  } catch (err) {
    logger.error(
      {
        error: err,
        errorMessage: err instanceof Error ? err.message : String(err),
        errorStack: err instanceof Error ? err.stack : undefined,
        sessionId: req.params.sessionId,
        userId: req.user?.id,
      },
      'Error in GET /channels/session/:sessionId/dms',
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get session participants for DM user list
router.get(
  '/session/:sessionId/participants',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const { sessionId } = req.params;
      const user = req.user!;

      // Verify user has access to session
      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('id, trainer_id')
        .eq('id', sessionId)
        .single();

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Check if user is trainer or participant
      if (session.trainer_id !== user.id && user.role !== 'admin') {
        const { data: participant } = await supabaseAdmin
          .from('session_participants')
          .select('*')
          .eq('session_id', sessionId)
          .eq('user_id', user.id)
          .single();

        if (!participant) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }

      // Get all participants including the trainer
      const { data: participants, error } = await supabaseAdmin
        .from('session_participants')
        .select('user_id, user:user_profiles(id, full_name, role, agency_name)')
        .eq('session_id', sessionId);

      if (error) {
        logger.error({ error, sessionId }, 'Failed to fetch participants');
        return res.status(500).json({ error: 'Failed to fetch participants' });
      }

      // Add trainer to participants list if not already there
      let allSessionParticipants = (participants || []).map((p: any) => ({
        id: p.user_id,
        ...p.user,
      }));

      if (session.trainer_id) {
        const { data: trainerProfile, error: trainerError } = await supabaseAdmin
          .from('user_profiles')
          .select('id, full_name, role, agency_name')
          .eq('id', session.trainer_id)
          .single();

        if (trainerProfile && !allSessionParticipants.some((p) => p.id === trainerProfile.id)) {
          allSessionParticipants.push({
            id: trainerProfile.id,
            full_name: trainerProfile.full_name,
            role: trainerProfile.role,
            agency_name: trainerProfile.agency_name,
          });
        }
      }

      res.json({
        data: allSessionParticipants,
      });
    } catch (err) {
      logger.error({ error: err }, 'Error in GET /channels/session/:sessionId/participants');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Create or get direct message channel
router.post(
  '/session/:sessionId/dm',
  requireAuth,
  validate(createDMSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { sessionId } = req.params;
      const user = req.user!;
      const { recipient_id } = req.body;

      if (user.id === recipient_id) {
        return res.status(400).json({ error: 'Cannot create DM with yourself' });
      }

      // Verify user has access to session
      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('id, trainer_id')
        .eq('id', sessionId)
        .single();

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Verify recipient is a participant
      const { data: recipient, error: recipientError } = await supabaseAdmin
        .from('session_participants')
        .select('*')
        .eq('session_id', sessionId)
        .eq('user_id', recipient_id)
        .maybeSingle();

      if (recipientError) {
        logger.error(
          { error: recipientError, sessionId, recipientId: recipient_id },
          'Failed to check recipient',
        );
        return res.status(500).json({ error: 'Failed to verify recipient' });
      }

      if (!recipient) {
        return res.status(404).json({ error: 'Recipient is not a participant in this session' });
      }

      // Check if DM channel already exists
      // Members array is sorted, so we need to check both possible orders
      const membersArray = [user.id, recipient_id].sort();
      const { data: allDMChannels } = await supabaseAdmin
        .from('chat_channels')
        .select('*')
        .eq('session_id', sessionId)
        .eq('type', 'direct');

      const existingChannel = (allDMChannels || []).find((channel: any) => {
        const channelMembers = (channel.members as string[]) || [];
        if (channelMembers.length !== 2) return false;
        const sortedChannelMembers = [...channelMembers].sort();
        return (
          sortedChannelMembers[0] === membersArray[0] && sortedChannelMembers[1] === membersArray[1]
        );
      });

      if (existingChannel) {
        // Get recipient info
        const { data: recipientInfo } = await supabaseAdmin
          .from('user_profiles')
          .select('id, full_name, role, agency_name')
          .eq('id', recipient_id)
          .maybeSingle();

        return res.json({
          data: {
            ...existingChannel,
            recipient: recipientInfo || null,
          },
        });
      }

      // Create new DM channel
      const { data: newChannel, error } = await supabaseAdmin
        .from('chat_channels')
        .insert({
          session_id: sessionId,
          name: `DM: ${user.id} & ${recipient_id}`, // Internal name, not shown to users
          type: 'direct',
          members: membersArray,
        })
        .select()
        .single();

      if (error) {
        logger.error(
          {
            error,
            errorCode: error.code,
            errorMessage: error.message,
            errorDetails: error.details,
            errorHint: error.hint,
            sessionId,
            userId: user.id,
            recipientId: recipient_id,
          },
          'Failed to create DM channel',
        );

        // Check if it's a constraint violation (migration not run)
        if (error.code === '23514' || error.message?.includes('check constraint')) {
          return res.status(500).json({
            error:
              'Direct messaging not enabled. Please run migration 017_add_direct_messaging.sql',
            details: error.message,
          });
        }

        return res
          .status(500)
          .json({ error: 'Failed to create DM channel', details: error.message });
      }

      // Get recipient info
      const { data: recipientInfo } = await supabaseAdmin
        .from('user_profiles')
        .select('id, full_name, role, agency_name')
        .eq('id', recipient_id)
        .maybeSingle();

      logger.info(
        { channelId: newChannel.id, userId: user.id, recipientId: recipient_id },
        'DM channel created',
      );
      res.status(201).json({
        data: {
          ...newChannel,
          recipient: recipientInfo || null,
        },
      });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /channels/session/:sessionId/dm');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Get messages for a channel
router.get(
  '/:channelId/messages',
  requireAuth,
  validate(schemas.pagination),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { channelId } = req.params;
      const { page, limit } = req.query;
      const offset = (Number(page) - 1) * Number(limit);
      const user = req.user!;

      // Verify user has access to channel
      const { data: channel, error: channelError } = await supabaseAdmin
        .from('chat_channels')
        .select('session_id, type, members')
        .eq('id', channelId)
        .maybeSingle();

      if (channelError) {
        logger.error(
          {
            error: channelError,
            errorCode: channelError.code,
            errorMessage: channelError.message,
            channelId,
          },
          'Failed to fetch channel',
        );
        return res
          .status(500)
          .json({ error: 'Failed to fetch channel', details: channelError.message });
      }

      if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
      }

      // Check access based on channel type
      if (channel.type === 'direct') {
        // For direct messages, verify user is a member
        const members = (channel.members as string[]) || [];
        if (!Array.isArray(members) || !members.includes(user.id)) {
          return res.status(403).json({ error: 'Access denied' });
        }
      } else if (channel.type === 'private' || channel.type === 'role_specific') {
        // Additional access checks needed
      }

      const { data, error, count } = await supabaseAdmin
        .from('chat_messages')
        .select('*, sender:user_profiles!chat_messages_sender_id_fkey(id, full_name, role)', {
          count: 'exact',
        })
        .eq('channel_id', channelId)
        .order('created_at', { ascending: false })
        .range(offset, offset + Number(limit) - 1);

      if (error) {
        logger.error(
          {
            error,
            errorCode: error.code,
            errorMessage: error.message,
            errorDetails: error.details,
            errorHint: error.hint,
            channelId,
          },
          'Failed to fetch messages',
        );
        return res.status(500).json({ error: 'Failed to fetch messages', details: error.message });
      }

      res.json({
        data: data?.reverse() || [],
        count,
        page: Number(page),
        limit: Number(limit),
        totalPages: count ? Math.ceil(count / Number(limit)) : 0,
      });
    } catch (err) {
      logger.error(
        {
          error: err,
          errorMessage: err instanceof Error ? err.message : String(err),
          errorStack: err instanceof Error ? err.stack : undefined,
          channelId: req.params.channelId,
          userId: req.user?.id,
        },
        'Error in GET /channels/:channelId/messages',
      );
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Create channel (trainers only)
router.post(
  '/',
  requireAuth,
  validate(createChannelSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const { session_id, name, type, role_filter } = req.body;

      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can create channels' });
      }

      const { data, error } = await supabaseAdmin
        .from('chat_channels')
        .insert({
          session_id,
          name,
          type,
          role_filter,
        })
        .select()
        .single();

      if (error) {
        logger.error({ error, userId: user.id }, 'Failed to create channel');
        return res.status(500).json({ error: 'Failed to create channel' });
      }

      logger.info({ channelId: data.id, userId: user.id }, 'Channel created');
      res.status(201).json({ data });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /channels');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Send message
router.post(
  '/:channelId/messages',
  requireAuth,
  validate(createMessageSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { channelId } = req.params;
      const user = req.user!;
      const { content, message_type } = req.body;

      // Verify channel access
      const { data: channel } = await supabaseAdmin
        .from('chat_channels')
        .select('session_id, type, members')
        .eq('id', channelId)
        .single();

      if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
      }

      // For direct messages, verify user is a member
      if (channel.type === 'direct') {
        const members = (channel.members as string[]) || [];
        if (!members.includes(user.id)) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }

      // Insert message first
      const { data: insertedMessage, error: insertError } = await supabaseAdmin
        .from('chat_messages')
        .insert({
          channel_id: channelId,
          session_id: channel.session_id,
          sender_id: user.id,
          content,
          type: message_type || 'text',
        })
        .select('*')
        .single();

      if (insertError) {
        logger.error(
          {
            error: insertError,
            errorCode: insertError.code,
            errorMessage: insertError.message,
            errorDetails: insertError.details,
            errorHint: insertError.hint,
            channelId,
            userId: user.id,
          },
          'Failed to insert message',
        );
        return res
          .status(500)
          .json({ error: 'Failed to send message', details: insertError.message });
      }

      // Fetch message with sender join separately
      const { data, error: selectError } = await supabaseAdmin
        .from('chat_messages')
        .select('*, sender:user_profiles!chat_messages_sender_id_fkey(id, full_name, role)')
        .eq('id', insertedMessage.id)
        .single();

      // If join fails, use the inserted message without sender info (insert was successful)
      const messageData = data || insertedMessage;

      if (selectError) {
        logger.warn(
          {
            error: selectError,
            messageId: insertedMessage.id,
            channelId,
            userId: user.id,
          },
          'Message inserted but failed to fetch sender info',
        );
      }

      logger.info({ messageId: insertedMessage.id, channelId, userId: user.id }, 'Message sent');

      // Ensure sender data exists with fallback
      const senderData = messageData.sender || {
        id: user.id,
        full_name: 'Unknown',
        role: user.role || 'unknown',
      };

      // Broadcast message via WebSocket service (non-blocking)
      try {
        getWebSocketService().messageSent(channelId, messageData);
      } catch (wsError) {
        logger.warn(
          {
            error: wsError,
            messageId: insertedMessage.id,
            channelId,
          },
          'Failed to broadcast message via WebSocket',
        );
      }

      // Log event (non-blocking)
      try {
        await logAndBroadcastEvent(
          io,
          channel.session_id,
          'message',
          {
            channel_id: channelId,
            message_id: messageData.id,
            sender: senderData,
            content: messageData.content,
          },
          user.id,
        );
      } catch (eventError) {
        logger.warn(
          {
            error: eventError,
            messageId: insertedMessage.id,
            channelId,
          },
          'Failed to log message event',
        );
      }

      // Create notifications for message recipients
      try {
        if (channel.type === 'direct') {
          // For direct messages, notify the other participant
          const members = (channel.members as string[]) || [];
          const recipientId = members.find((id) => id !== user.id);

          if (recipientId) {
            await createNotification({
              sessionId: channel.session_id,
              userId: recipientId,
              type: 'chat_message',
              title: `New message from ${senderData.full_name || 'Unknown'}`,
              message: content.substring(0, 100) + (content.length > 100 ? '...' : ''),
              priority: 'low',
              metadata: {
                channel_id: channelId,
                message_id: messageData.id,
              },
              actionUrl: `/sessions/${channel.session_id}#chat`,
            });
          }
        } else {
          // For channel messages, notify all members except the sender
          // Get channel members (for role_specific channels, get users with that role)
          let memberIds: string[] = [];

          if (channel.type === 'role_specific') {
            // Get users with the role specified in the channel
            // This assumes role is stored somewhere - you may need to adjust based on your schema
            const { data: participants } = await supabaseAdmin
              .from('session_participants')
              .select('user_id, user_profiles!inner(role)')
              .eq('session_id', channel.session_id);

            // Filter by role if channel has role_filter
            // Note: You may need to adjust this based on how role_specific channels work
            memberIds = (participants || [])
              .map((p) => p.user_id)
              .filter((id): id is string => !!id && id !== user.id);
          } else {
            // For public/inter_agency/command channels, notify all session participants
            const { data: participants } = await supabaseAdmin
              .from('session_participants')
              .select('user_id')
              .eq('session_id', channel.session_id);

            memberIds = (participants || [])
              .map((p) => p.user_id)
              .filter((id): id is string => !!id && id !== user.id);
          }

          // Create notifications for all members (batch)
          for (const memberId of memberIds) {
            await createNotification({
              sessionId: channel.session_id,
              userId: memberId,
              type: 'chat_message',
              title: `New message in ${channel.name || 'channel'}`,
              message: `${senderData.full_name || 'Unknown'}: ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`,
              priority: 'low',
              metadata: {
                channel_id: channelId,
                message_id: messageData.id,
              },
              actionUrl: `/sessions/${channel.session_id}#chat`,
            });
          }
        }
      } catch (notifErr) {
        logger.error(
          { error: notifErr, channelId, messageId: insertedMessage.id },
          'Error creating notifications for message',
        );
        // Don't throw - notification failure shouldn't block message sending
      }

      res.status(201).json({ data: messageData });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /channels/:channelId/messages');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export { router as channelsRouter };
