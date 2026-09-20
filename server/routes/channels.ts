import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { validate, schemas } from '../lib/validation.js';
import { logAndBroadcastEvent } from '../services/eventService.js';
import { getWebSocketService } from '../services/websocketService.js';
import {
  createNotification,
  createNotificationsForUsers,
} from '../services/notificationService.js';
import { createDefaultChannels, ensureTeamChannels } from '../services/channelService.js';
import { assertSessionAccess } from '../lib/access.js';
import {
  assertChannelAccess,
  listAccessibleChannels,
  getChannelMemberIds,
  toChannelRow,
  type ChannelRow,
} from '../lib/channelAccess.js';
import { io } from '../index.js';

/**
 * Chat overview enrichment shared by the channel list and the DM list: last message preview and
 * unread count per channel, computed from one batch of recent messages + the caller's read
 * cursors (runtime plan §2.4).
 */
async function buildChannelOverview(
  sessionId: string,
  userId: string,
  channelIds: string[],
): Promise<
  Map<
    string,
    {
      last_message: { content: string; created_at: string; sender_name: string } | null;
      unread_count: number;
    }
  >
> {
  const overview = new Map<
    string,
    {
      last_message: { content: string; created_at: string; sender_name: string } | null;
      unread_count: number;
    }
  >();
  for (const id of channelIds) overview.set(id, { last_message: null, unread_count: 0 });
  if (channelIds.length === 0) return overview;

  const [{ data: messages }, { data: reads }] = await Promise.all([
    supabaseAdmin
      .from('chat_messages')
      // '*' so sender_stakeholder_id / sender_display_name (migration 199) are optional.
      .select('*, sender:user_profiles!chat_messages_sender_id_fkey(full_name)')
      .eq('session_id', sessionId)
      .in('channel_id', channelIds)
      .order('created_at', { ascending: false })
      .limit(500),
    supabaseAdmin
      .from('chat_channel_reads')
      .select('channel_id, last_read_at')
      .eq('user_id', userId)
      .in('channel_id', channelIds),
  ]);

  const lastReadByChannel = new Map<string, number>();
  for (const r of reads ?? []) {
    const row = r as { channel_id: string; last_read_at: string };
    lastReadByChannel.set(row.channel_id, new Date(row.last_read_at).getTime());
  }

  for (const m of messages ?? []) {
    const row = m as Record<string, unknown>;
    const channelId = String(row.channel_id);
    const entry = overview.get(channelId);
    if (!entry) continue;
    const createdAt = String(row.created_at);
    if (!entry.last_message) {
      const sender = row.sender as { full_name?: string } | null;
      entry.last_message = {
        content: String(row.content ?? ''),
        created_at: createdAt,
        sender_name: String(row.sender_display_name || sender?.full_name || 'Unknown'),
      };
    }
    const isOwn = row.sender_id === userId;
    const lastRead = lastReadByChannel.get(channelId) ?? 0;
    if (!isOwn && new Date(createdAt).getTime() > lastRead && entry.unread_count < 99) {
      entry.unread_count += 1;
    }
  }
  return overview;
}

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

    // Self-heal: default channels if none exist, and one `team` channel per assigned team.
    const { count: channelCount } = await supabaseAdmin
      .from('chat_channels')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', sessionId)
      .not('type', 'in', '("direct","npc_direct","team")');
    if (!channelCount) {
      logger.info({ sessionId }, 'No channels found — auto-creating defaults');
      await createDefaultChannels(sessionId, session.trainer_id ?? user.id);
    }
    await ensureTeamChannels(sessionId, session.trainer_id ?? null);

    // Only channels the caller may read (team channels for members / trainer; Trainer Channel
    // for trainers only).
    const { channels } = await listAccessibleChannels(sessionId, {
      id: user.id,
      role: user.role,
    });

    const [overview, teamIdentity] = await Promise.all([
      buildChannelOverview(
        sessionId,
        user.id,
        channels.map((c) => c.id),
      ),
      (async () => {
        try {
          const { getSessionTeams } = await import('../services/orgRegistryService.js');
          return new Map((await getSessionTeams(sessionId)).map((t) => [t.team_name, t]));
        } catch {
          return new Map<string, { function_key: string | null; org_key: string | null }>();
        }
      })(),
    ]);

    const memberCounts = await Promise.all(
      channels.map(async (c) => (await getChannelMemberIds(c)).length),
    );

    const data = channels.map((c, i) => {
      const identity = c.team_name ? teamIdentity.get(c.team_name) : undefined;
      const ov = overview.get(c.id)!;
      return {
        id: c.id,
        session_id: c.session_id,
        name: c.name,
        type: c.type,
        role_filter: c.role_filter,
        created_at: c.created_at,
        team_name: c.team_name,
        function_key: identity?.function_key ?? null,
        org_key: identity?.org_key ?? null,
        member_count: memberCounts[i],
        last_message: ov.last_message,
        unread_count: ov.unread_count,
      };
    });

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

    // Get all direct message channels (human + NPC) for the session; members filtered in JS.
    const { data: allDmChannels, error: channelsError } = await supabaseAdmin
      .from('chat_channels')
      .select('*')
      .eq('session_id', sessionId)
      .in('type', ['direct', 'npc_direct'])
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
    const dmChannels = (allDmChannels || []).filter((channel: Record<string, unknown>) => {
      const members = (channel.members as string[]) || [];
      return Array.isArray(members) && members.includes(user.id);
    });

    const overview = await buildChannelOverview(
      sessionId,
      user.id,
      dmChannels.map((c) => String((c as Record<string, unknown>).id)),
    );

    // NPC DMs (type npc_direct) are enriched with the stakeholder's player-visible record.
    let stakeholderById = new Map<string, unknown>();
    if (dmChannels.some((c) => (c as Record<string, unknown>).type === 'npc_direct')) {
      try {
        const { getVisibleStakeholders } = await import('../services/stakeholderService.js');
        const { toPlayerVisible } = await import('../lib/stakeholderContract.js');
        const visible = await getVisibleStakeholders(sessionId, user.id, {
          asTrainer: session.trainer_id === user.id || user.role === 'admin',
        });
        stakeholderById = new Map(visible.map((s) => [s.id, toPlayerVisible(s)]));
      } catch {
        /* stakeholder service unavailable → recipient stays null */
      }
    }

    // Enrich with recipient info (resilient - one failure doesn't break all)
    const enrichedChannels = await Promise.all(
      dmChannels.map(async (channel: Record<string, unknown>) => {
        try {
          const ov = overview.get(String(channel.id)) ?? { last_message: null, unread_count: 0 };

          if (channel.type === 'npc_direct') {
            const stakeholder = stakeholderById.get(String(channel.stakeholder_id ?? '')) ?? null;
            return {
              ...channel,
              recipient: null,
              stakeholder,
              last_message: ov.last_message,
              unread_count: ov.unread_count,
            };
          }

          const members = (channel.members as string[]) || [];
          const recipientId = members.find((id: string) => id !== user.id);

          if (!recipientId) {
            return { ...channel, recipient: null, last_message: null, unread_count: 0 };
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

          return {
            ...channel,
            recipient: recipient || null,
            last_message: ov.last_message,
            unread_count: ov.unread_count,
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
      const allSessionParticipants = (participants || []).map((p: Record<string, unknown>) => {
        const user = p.user as {
          id: string;
          full_name: string;
          role: string;
          agency_name?: string;
        } | null;
        return {
          id: p.user_id,
          ...(user || {}),
        };
      });

      if (session.trainer_id) {
        const { data: trainerProfile } = await supabaseAdmin
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

      // Enrich participants with team names
      const participantIds = allSessionParticipants.map((p) => p.id).filter(Boolean) as string[];
      if (participantIds.length > 0) {
        const { data: teamRows } = await supabaseAdmin
          .from('session_teams')
          .select('user_id, team_name')
          .eq('session_id', sessionId)
          .in('user_id', participantIds);
        const userTeamMap = new Map<string, string>();
        for (const row of teamRows ?? []) {
          const r = row as { user_id: string; team_name: string };
          if (!userTeamMap.has(r.user_id)) userTeamMap.set(r.user_id, r.team_name);
        }
        // Contract §5.2: expose function / org identity next to the team name.
        let identityByTeam = new Map<
          string,
          { function_key: string | null; org_key: string | null }
        >();
        try {
          const { getSessionTeams } = await import('../services/orgRegistryService.js');
          identityByTeam = new Map(
            (await getSessionTeams(sessionId)).map((t) => [
              t.team_name,
              { function_key: t.function_key, org_key: t.org_key },
            ]),
          );
        } catch {
          /* identity enrichment is best-effort */
        }
        for (const p of allSessionParticipants) {
          const teamName = userTeamMap.get(p.id as string);
          if (teamName) {
            const rec = p as Record<string, unknown>;
            rec.team_name = teamName;
            const identity = identityByTeam.get(teamName);
            rec.function_key = identity?.function_key ?? null;
            rec.org_key = identity?.org_key ?? null;
          }
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

      // Verify the CALLER belongs to the session (trainer/admin/participant).
      const access = await assertSessionAccess(sessionId, user);
      if (!access.ok) {
        return res.status(access.status).json({ error: access.error });
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

      const existingChannel = (allDMChannels || []).find((channel: Record<string, unknown>) => {
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

      // One rule for every channel type (team membership, DM membership, trainer channel…).
      const channelAccess = await assertChannelAccess(channelId, user);
      if (!channelAccess.ok) {
        return res.status(channelAccess.status).json({ error: channelAccess.error });
      }
      const channel = channelAccess.channel;

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

      // Enrich messages with team names from session_teams
      const messagesArr = data?.reverse() || [];
      if (messagesArr.length > 0 && channel.session_id) {
        const senderIds = [
          ...new Set(
            messagesArr.map((m: Record<string, unknown>) => m.sender_id as string).filter(Boolean),
          ),
        ];
        if (senderIds.length > 0) {
          const { data: teamRows } = await supabaseAdmin
            .from('session_teams')
            .select('user_id, team_name')
            .eq('session_id', channel.session_id)
            .in('user_id', senderIds);
          const userTeamMap = new Map<string, string>();
          for (const row of teamRows ?? []) {
            const r = row as { user_id: string; team_name: string };
            if (!userTeamMap.has(r.user_id)) userTeamMap.set(r.user_id, r.team_name);
          }
          for (const msg of messagesArr) {
            const m = msg as Record<string, unknown>;
            const sender = m.sender as Record<string, unknown> | null;
            const teamName = userTeamMap.get(m.sender_id as string);
            if (sender && teamName) {
              sender.team_name = teamName;
            }
          }
        }
      }

      // NPC-authored rows (migration 199) carry no user sender; synthesise one from the stakeholder.
      for (const msg of messagesArr) {
        const m = msg as Record<string, unknown>;
        if (!m.sender && m.sender_stakeholder_id) {
          m.sender = {
            id: `stk:${m.sender_stakeholder_id}`,
            full_name: String(m.sender_display_name || 'Contact'),
            role: 'npc',
          };
        }
      }

      res.json({
        data: messagesArr,
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

// Members of a channel (names, roles, team identity) — runtime plan §2.4
router.get('/:channelId/members', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { channelId } = req.params;
    const user = req.user!;
    const access = await assertChannelAccess(channelId, user);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const channel = access.channel;

    const memberIds = await getChannelMemberIds(channel);
    if (memberIds.length === 0) return res.json({ data: [] });

    const [{ data: profiles }, { data: session }, { data: teamRows }] = await Promise.all([
      supabaseAdmin.from('user_profiles').select('id, full_name, role').in('id', memberIds),
      supabaseAdmin
        .from('sessions')
        .select('trainer_id')
        .eq('id', channel.session_id)
        .maybeSingle(),
      supabaseAdmin
        .from('session_teams')
        .select('user_id, team_name')
        .eq('session_id', channel.session_id)
        .in('user_id', memberIds),
    ]);

    let identityByTeam = new Map<string, { function_key: string | null; org_key: string | null }>();
    try {
      const { getSessionTeams } = await import('../services/orgRegistryService.js');
      identityByTeam = new Map(
        (await getSessionTeams(channel.session_id)).map((t) => [
          t.team_name,
          { function_key: t.function_key, org_key: t.org_key },
        ]),
      );
    } catch {
      /* best-effort */
    }

    const teamByUser = new Map<string, string>();
    for (const r of teamRows ?? []) {
      const row = r as { user_id: string; team_name: string };
      if (!teamByUser.has(row.user_id)) teamByUser.set(row.user_id, row.team_name);
    }
    const trainerId = (session?.trainer_id as string | null) ?? null;

    const data = (profiles ?? [])
      .map((p) => {
        const row = p as { id: string; full_name: string; role: string };
        const teamName = teamByUser.get(row.id) ?? null;
        const identity = teamName ? identityByTeam.get(teamName) : undefined;
        return {
          id: row.id,
          full_name: row.full_name,
          role: row.role,
          team_name: teamName,
          function_key: identity?.function_key ?? null,
          org_key: identity?.org_key ?? null,
          is_trainer: row.id === trainerId,
        };
      })
      .sort(
        (a, b) =>
          Number(b.is_trainer) - Number(a.is_trainer) || a.full_name.localeCompare(b.full_name),
      );

    res.json({ data });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /channels/:channelId/members');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Read cursor (unread badges) — runtime plan §2.4
router.post('/:channelId/read', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { channelId } = req.params;
    const user = req.user!;
    const access = await assertChannelAccess(channelId, user);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const { error } = await supabaseAdmin
      .from('chat_channel_reads')
      .upsert(
        { channel_id: channelId, user_id: user.id, last_read_at: new Date().toISOString() },
        { onConflict: 'channel_id,user_id' },
      );
    if (error) {
      logger.warn({ error, channelId, userId: user.id }, 'Failed to update read cursor');
      return res.status(500).json({ error: 'Failed to update read cursor' });
    }
    res.status(204).end();
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /channels/:channelId/read');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create or get an NPC (stakeholder) DM channel — runtime plan §3.3
router.post(
  '/session/:sessionId/npc-dm',
  requireAuth,
  validate(
    z.object({
      params: z.object({ sessionId: z.string().uuid() }),
      body: z.object({ stakeholder_id: z.string().min(1).max(120) }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { sessionId } = req.params;
      const user = req.user!;
      const { stakeholder_id } = req.body as { stakeholder_id: string };

      const access = await assertSessionAccess(sessionId, user);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      const isTrainer = access.session?.trainer_id === user.id || user.role === 'admin';

      const { canUserSeeStakeholder } = await import('../services/stakeholderService.js');
      const { toPlayerVisible } = await import('../lib/stakeholderContract.js');
      const stakeholder = await canUserSeeStakeholder(sessionId, user.id, stakeholder_id, {
        asTrainer: isTrainer,
      });
      // Never reveal that a stakeholder exists to someone who may not see them.
      if (!stakeholder) return res.status(404).json({ error: 'Contact not found' });

      const { data: existingRows } = await supabaseAdmin
        .from('chat_channels')
        .select('*')
        .eq('session_id', sessionId)
        .eq('type', 'npc_direct')
        .eq('stakeholder_id', stakeholder_id);
      const existing = (existingRows ?? []).find((c) =>
        ((c as { members?: string[] }).members ?? []).includes(user.id),
      );
      if (existing) {
        return res.json({
          data: {
            ...toChannelRow(existing as Record<string, unknown>),
            stakeholder: toPlayerVisible(stakeholder),
          },
        });
      }

      const { data: created, error } = await supabaseAdmin
        .from('chat_channels')
        .insert({
          session_id: sessionId,
          name: stakeholder.name,
          type: 'npc_direct',
          stakeholder_id: stakeholder.id,
          members: [user.id],
          created_by: user.id,
        })
        .select('*')
        .single();
      if (error || !created) {
        logger.error(
          { error, sessionId, stakeholderId: stakeholder_id },
          'Failed to create NPC DM',
        );
        return res.status(500).json({ error: 'Failed to create conversation' });
      }
      res.status(201).json({
        data: {
          ...toChannelRow(created as Record<string, unknown>),
          stakeholder: toPlayerVisible(stakeholder),
        },
      });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /channels/session/:sessionId/npc-dm');
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

      // One rule for every channel type (team membership, DM membership, trainer channel…).
      const channelAccess = await assertChannelAccess(channelId, user);
      if (!channelAccess.ok) {
        return res.status(channelAccess.status).json({ error: channelAccess.error });
      }
      const channel: ChannelRow = channelAccess.channel;

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

      // NPC DM: hand the message to the stakeholder engine (in-character reply + reconsideration).
      if (channel.type === 'npc_direct' && channel.stakeholder_id) {
        void (async () => {
          try {
            const { onTeamChatMessage } = await import('../services/stakeholderReplyService.js');
            await onTeamChatMessage({
              sessionId: channel.session_id,
              channelId,
              stakeholderId: channel.stakeholder_id!,
              userId: user.id,
              content,
              messageId: messageData.id as string,
            });
          } catch (err) {
            logger.warn({ err, channelId }, 'Stakeholder chat reply failed');
          }
        })();
      }

      // Create notifications for message recipients
      try {
        if (channel.type === 'direct') {
          // For direct messages, notify the other participant
          const recipientId = channel.members.find((id) => id !== user.id);

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
                channel_type: channel.type,
                message_id: messageData.id,
              },
              actionUrl: `/sessions/${channel.session_id}#chat`,
            });
          }
        } else if (channel.type !== 'npc_direct') {
          // Channel messages notify the channel's members (team channels → that team only;
          // trainer channel → trainer; org-wide channels → every participant), never the sender.
          const memberIds = (await getChannelMemberIds(channel)).filter((id) => id !== user.id);

          // Single bulk insert + per-user socket emit. The previous per-member
          // createNotification loop cost one sequential DB round-trip per
          // participant (~100 at large sessions), which dominated this route's
          // response time under load.
          await createNotificationsForUsers(memberIds, {
            sessionId: channel.session_id,
            type: 'chat_message',
            title: `New message in ${channel.name || 'channel'}`,
            message: `${senderData.full_name || 'Unknown'}: ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`,
            priority: 'low',
            metadata: {
              channel_id: channelId,
              channel_type: channel.type,
              team_name: channel.team_name,
              message_id: messageData.id,
            },
            actionUrl: `/sessions/${channel.session_id}#chat`,
          });
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
