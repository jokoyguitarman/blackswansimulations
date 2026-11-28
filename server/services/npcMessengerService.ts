import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { skipForPeace } from '../lib/peaceGate.js';
import { chatJson } from './ai/chatClient.js';
import { getWebSocketService } from './websocketService.js';
import { randomUUID } from 'crypto';
import { formatDmConversation } from './topic/channelPromptShared.js';
import { buildLegacyDmReplyMessages } from './topic/legacyChannelPrompts.js';
import {
  asModelRecord,
  buildTopicDmMessages,
  channelPhase,
  channelTopicResult,
  screenChannelReply,
  screenStakeholderReply,
  singleResponderStance,
  type ChannelChatClient,
  type ChannelPhase,
  type ChannelScreenResult,
  type ChannelTopicResult,
} from './topic/channelTopicCore.js';
import { leakTermsFromInitialState } from './topic/topicPromptCore.js';

interface NPCPersona {
  handle: string;
  name: string;
  type: string;
  personality: string;
  bias?: string | null;
  follower_count: number;
  specific_claims: string[];
  tier?: string;
}

interface GeneratedDM {
  sender_handle: string;
  sender_display_name: string;
  sender_type: string;
  recipient_handle: string;
  content: string;
  urgency: 'low' | 'medium' | 'high';
}

async function findOrCreateThread(
  sessionId: string,
  senderHandle: string,
  recipientHandle: string,
): Promise<string> {
  const { data: existing } = await supabaseAdmin
    .from('sim_direct_messages')
    .select('thread_id')
    .eq('session_id', sessionId)
    .or(
      `and(sender_handle.eq.${senderHandle},recipient_handle.eq.${recipientHandle}),and(sender_handle.eq.${recipientHandle},recipient_handle.eq.${senderHandle})`,
    )
    .limit(1)
    .single();

  return existing?.thread_id || randomUUID();
}

async function resolveRecipientUserId(
  sessionId: string,
  recipientHandle: string,
): Promise<string | null> {
  const { data: participants } = await supabaseAdmin
    .from('session_participants')
    .select('user_id, user:user_profiles(full_name)')
    .eq('session_id', sessionId);

  if (!participants) return null;

  for (const p of participants) {
    const profile = p.user as unknown as { full_name: string } | null;
    if (!profile?.full_name) continue;
    const handle = `@${profile.full_name.replace(/[@.\s+,]/g, '_').toLowerCase()}`;
    if (handle === recipientHandle) return p.user_id;
  }

  return null;
}

async function npcMessagesSkipPeace(sessionId: string): Promise<boolean> {
  if (!env.enablePeacePeriod) return false;
  const { data } = await supabaseAdmin
    .from('sessions')
    .select('start_time')
    .eq('id', sessionId)
    .maybeSingle();
  return skipForPeace({ start_time: data?.start_time ?? null });
}

export async function triggerNPCMessages(sessionId: string): Promise<void> {
  if (!env.aiEnabled) return;
  if (await npcMessagesSkipPeace(sessionId)) return;

  try {
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id, current_state')
      .eq('id', sessionId)
      .single();

    if (!session?.scenario_id) return;

    const { data: scenario } = await supabaseAdmin
      .from('scenarios')
      .select('description, initial_state')
      .eq('id', session.scenario_id)
      .single();

    if (!scenario) return;

    const initialState = (scenario.initial_state || {}) as Record<string, unknown>;
    const personas = (initialState.npc_personas || []) as NPCPersona[];
    if (personas.length === 0) return;
    const orgName = String(initialState.org_name || '');
    const orgPageData = initialState.org_page as Record<string, unknown> | undefined;
    const orgFb = orgPageData?.facebook as Record<string, string> | undefined;
    const orgPageHandle = orgFb?.page_handle || '';
    const orgPageName = orgFb?.page_name || '';

    // Fetch all session participants with their profiles
    const { data: participants } = await supabaseAdmin
      .from('session_participants')
      .select('user_id, user:user_profiles(full_name)')
      .eq('session_id', sessionId);

    if (!participants || participants.length === 0) return;

    const playerList = participants.map((p) => {
      const profile = p.user as unknown as { full_name: string } | null;
      const name = profile?.full_name || 'Player';
      return {
        user_id: p.user_id,
        name,
        handle: `@${name.replace(/[@.\s+,]/g, '_').toLowerCase()}`,
      };
    });

    // Spam guard: skip if too many DMs already exist for this session
    const { count: existingCount } = await supabaseAdmin
      .from('sim_direct_messages')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', sessionId);

    if ((existingCount || 0) > 100) {
      logger.debug({ sessionId, existingCount }, 'NPC DM limit reached, skipping');
      return;
    }

    const socialState = ((session.current_state || {}) as Record<string, unknown>).social_state as
      | Record<string, unknown>
      | undefined;

    const personaList = personas
      .map(
        (p) =>
          `${p.handle} (${p.name}): type=${p.type}, personality="${p.personality}", bias=${p.bias}`,
      )
      .join('\n');

    const playerHandles = playerList.map((p) => p.handle).join(', ');

    const crisisMetrics = socialState
      ? `Sentiment: ${socialState.sentiment_score ?? 'unknown'}, Escalation risk: ${socialState.escalation_risk ?? 'unknown'}, Public trust: ${socialState.public_trust ?? 'unknown'}, Stakeholder confidence: ${socialState.community_safety ?? 'unknown'}`
      : 'No metrics available yet';

    const parsed = await chatJson<{ messages?: GeneratedDM[] }>({
      tier: 'standard',
      json: true,
      temperature: 0.85,
      maxTokens: 1000,
      label: 'npcMessenger.generateDms',
      messages: [
        {
          role: 'system',
          content: `You are generating NPC direct messages during a crisis simulation. NPCs may privately DM the organization's page or individual players.

Crisis context: ${String(scenario.description || '').substring(0, 400)}${orgName ? `\nOrganization: ${orgName}` : ''}

NPC personas:
${personaList}

Player handles in this session: ${playerHandles}
${orgPageHandle ? `Organization page handle: ${orgPageHandle} (${orgPageName})` : ''}

Current crisis metrics: ${crisisMetrics}

RECIPIENT RULES:
${orgPageHandle ? `- Journalists, media outlets, regulators, affected customers, and organizations should DM the ORGANIZATION PAGE (${orgPageHandle}) -- they would contact the official account, not a random employee.` : ''}
- Anonymous tipsters, allies, hostile/threatening personas, and internal colleagues should DM individual PLAYER handles -- they target people, not brands.
- recipient_handle must be ${orgPageHandle ? `either "${orgPageHandle}" (org page) or ` : ''}one of the player handles listed.

RULES:
- Generate 2-5 messages total (or 0 if the situation doesn't warrant it).
- Each message should be 1-3 sentences and feel authentic to the sender's personality.
- Messages should create meaningful decision pressure.
- sender_handle and sender_display_name must match an NPC from the persona list.
- sender_type must match the NPC's type.

Return ONLY valid JSON:
{ "messages": [{ "sender_handle": "@exact_handle", "sender_display_name": "Exact Name", "sender_type": "npc_public|npc_media|npc_politician|npc_influencer", "recipient_handle": "@recipient", "content": "message text", "urgency": "low|medium|high" }] }

If no messages are warranted right now, return: { "messages": [] }`,
        },
        {
          role: 'user',
          content: 'Generate NPC direct messages for the current crisis state.',
        },
      ],
    });

    if (!parsed) {
      logger.warn({ sessionId }, 'NPC DM generation request failed');
      return;
    }

    const messages = (parsed.messages || []) as GeneratedDM[];

    if (messages.length === 0) return;

    for (let i = 0; i < messages.length; i++) {
      const delay = 1000 + Math.floor(Math.random() * 3000);
      setTimeout(
        async () => {
          try {
            const msg = messages[i];
            const threadId = await findOrCreateThread(
              sessionId,
              msg.sender_handle,
              msg.recipient_handle,
            );
            const recipientUserId = await resolveRecipientUserId(sessionId, msg.recipient_handle);

            const { data: inserted, error } = await supabaseAdmin
              .from('sim_direct_messages')
              .insert({
                session_id: sessionId,
                thread_id: threadId,
                sender_handle: msg.sender_handle,
                sender_display_name: msg.sender_display_name,
                sender_type: msg.sender_type || 'npc_public',
                recipient_handle: msg.recipient_handle,
                recipient_user_id: recipientUserId,
                content: msg.content,
                media_urls: [],
                is_read: false,
                platform: 'facebook',
              })
              .select()
              .single();

            if (error) {
              logger.warn({ error, sessionId }, 'Failed to insert NPC DM');
              return;
            }

            if (recipientUserId) {
              getWebSocketService().broadcastToSession(sessionId, {
                type: 'messenger.received',
                data: { user_id: recipientUserId, message: inserted },
                timestamp: new Date().toISOString(),
              });
            }

            logger.info(
              {
                sessionId,
                sender: msg.sender_handle,
                recipient: msg.recipient_handle,
                urgency: msg.urgency,
              },
              'NPC DM delivered',
            );
          } catch (err) {
            logger.warn({ err, sessionId }, 'NPC DM delivery failed');
          }
        },
        delay * (i + 1),
      );
    }

    logger.info({ sessionId, messageCount: messages.length }, 'NPC direct messages scheduled');
  } catch (err) {
    logger.warn({ err, sessionId }, 'NPC message trigger failed');
  }
}

export async function sendNPCDirectMessage(
  sessionId: string,
  senderHandle: string,
  senderName: string,
  senderType: string,
  recipientHandle: string,
  recipientUserId: string | null,
  content: string,
  platform: string = 'facebook',
): Promise<void> {
  try {
    const threadId = await findOrCreateThread(sessionId, senderHandle, recipientHandle);

    const { data: inserted, error } = await supabaseAdmin
      .from('sim_direct_messages')
      .insert({
        session_id: sessionId,
        thread_id: threadId,
        sender_handle: senderHandle,
        sender_display_name: senderName,
        sender_type: senderType,
        recipient_handle: recipientHandle,
        recipient_user_id: recipientUserId,
        content,
        media_urls: [],
        is_read: false,
        platform,
      })
      .select()
      .single();

    if (error) {
      logger.warn({ error, sessionId, senderHandle }, 'Failed to send scripted NPC DM');
      return;
    }

    if (recipientUserId) {
      getWebSocketService().broadcastToSession(sessionId, {
        type: 'messenger.received',
        data: { user_id: recipientUserId, message: inserted },
        timestamp: new Date().toISOString(),
      });
    }

    logger.info({ sessionId, senderHandle, recipientHandle }, 'Scripted NPC DM sent');
  } catch (err) {
    logger.warn({ err, sessionId, senderHandle }, 'Scripted NPC DM failed');
  }
}

interface DmThreadRow {
  id?: string;
  sender_handle: string;
  recipient_handle: string;
  content: string;
  recipient_user_id: string | null;
}

/**
 * Flag off is master's query: oldest 10, no id. Flag on loads the latest 10 and
 * returns them oldest-first so the prompt reads in order and includes the new message.
 */
async function loadDmThread(threadId: string, topicAware: boolean): Promise<DmThreadRow[]> {
  if (!topicAware) {
    const { data } = await supabaseAdmin
      .from('sim_direct_messages')
      .select('sender_handle, recipient_handle, content, recipient_user_id')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true })
      .limit(10);
    return data ?? [];
  }
  const { data } = await supabaseAdmin
    .from('sim_direct_messages')
    .select('id, sender_handle, recipient_handle, content, recipient_user_id')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: false })
    .limit(10);
  return [...(data ?? [])].reverse();
}

export interface NpcDmReplyOptions {
  phase?: ChannelPhase;
  client?: ChannelChatClient;
  /** The player's message row. The topic path labels this id. */
  playerMessageId?: string;
}

export async function triggerNPCDMReply(
  sessionId: string,
  threadId: string,
  recipientHandle: string,
  playerMessage: string,
  playerUserId?: string,
  options?: NpcDmReplyOptions,
): Promise<ChannelTopicResult | null> {
  if (!env.aiEnabled) return null;

  const phase = channelPhase(options?.phase);
  const topicAware = env.enableTopicAwareReplies;
  const playerMessageId = options?.playerMessageId ?? '';
  const finish = (screen: ChannelScreenResult | null = null) =>
    channelTopicResult(topicAware, playerMessageId, screen);
  let outcome: ChannelScreenResult | null = null;

  try {
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id')
      .eq('id', sessionId)
      .single();

    if (!session?.scenario_id) return finish();

    const { data: scenario } = await supabaseAdmin
      .from('scenarios')
      .select('description, initial_state')
      .eq('id', session.scenario_id)
      .single();

    if (!scenario) return finish();

    const initialState = (scenario.initial_state || {}) as Record<string, unknown>;
    const personas = (initialState.npc_personas || []) as NPCPersona[];

    const threadRows = await loadDmThread(threadId, topicAware);
    const isReply = topicAware ? threadRows.some((row) => row.id !== playerMessageId) : false;
    const conversation = formatDmConversation(threadRows);
    const topic = topicAware
      ? { phase, thread: conversation || playerMessage, isReply }
      : undefined;

    // Stakeholder record (contract §3): in-character reply from the record + inject verdicts.
    if (env.enableStakeholderEngine) {
      const { findByHandle } = await import('./stakeholderService.js');
      const stakeholder = await findByHandle(session.scenario_id, recipientHandle);
      if (stakeholder) {
        const playerHandle =
          threadRows.find((m) => m.sender_handle !== stakeholder.handle)?.sender_handle ||
          threadRows[0]?.recipient_handle ||
          '';
        const userId =
          playerUserId ||
          threadRows.find((m) => m.recipient_user_id)?.recipient_user_id ||
          (await resolveRecipientUserId(sessionId, playerHandle));
        if (!userId) return finish();

        const { handlePlayerMessage, recordNpcReply } =
          await import('./stakeholderReplyService.js');
        const plan = await handlePlayerMessage({
          sessionId,
          stakeholder,
          channel: 'messenger',
          userId,
          content: playerMessage,
          refTable: 'sim_direct_messages',
          refId: null,
          topic,
        });
        let replyText = plan.text;
        let screened: ChannelScreenResult | null = null;
        if (topic) {
          screened = screenStakeholderReply({
            phase,
            classification: plan.classification,
            replyText: plan.text,
            authorHandle: stakeholder.handle,
            leakTerms: leakTermsFromInitialState(initialState),
            playerText: playerMessage,
            isReply,
            minConfidence: env.topicBridgeMinConfidence,
          });
          outcome = screened;
          replyText = screened.replyText;
          if (screened.dropped) {
            logger.info(
              { sessionId, threadId, handle: stakeholder.handle },
              'Dropped topic reply that matched leak terms',
            );
            return finish(screened);
          }
        }
        if (!plan.should_reply || !replyText) return finish(screened);

        const senderType =
          stakeholder.relationship === 'media'
            ? 'npc_media'
            : stakeholder.relationship === 'regulator'
              ? 'npc_politician'
              : 'npc_public';
        const { data: inserted, error } = await supabaseAdmin
          .from('sim_direct_messages')
          .insert({
            session_id: sessionId,
            thread_id: threadId,
            sender_handle: stakeholder.handle,
            sender_display_name: stakeholder.name,
            sender_type: senderType,
            recipient_handle: playerHandle,
            recipient_user_id: userId,
            content: replyText,
            platform: 'facebook',
          })
          .select()
          .single();
        if (!error && inserted) {
          getWebSocketService().broadcastToSession(sessionId, {
            type: 'messenger.received',
            data: { user_id: userId, message: inserted },
            timestamp: new Date().toISOString(),
          });
          await recordNpcReply({
            sessionId,
            stakeholderId: stakeholder.id,
            channel: 'messenger',
            content: replyText,
            refTable: 'sim_direct_messages',
            refId: String(inserted.id),
          });
          logger.info(
            { sessionId, stakeholderId: stakeholder.id, threadId },
            'Stakeholder DM reply sent',
          );
        }
        return finish(screened);
      }
    }

    const npc = personas.find((p) => p.handle === recipientHandle);
    if (!npc) return finish();

    const orgName = String(initialState.org_name || '');

    const replyToHandle =
      threadRows.find((m) => m.sender_handle !== npc.handle)?.sender_handle ||
      threadRows[0]?.recipient_handle ||
      '';

    const dmInput = {
      handle: npc.handle,
      name: npc.name,
      personality: npc.personality,
      bias: npc.bias,
      type: npc.type,
      crisisDescription: String(scenario.description || ''),
      orgName,
      conversation,
      playerMessage,
    };
    const dmStance = topicAware
      ? singleResponderStance(
          {
            handle: npc.handle,
            type: npc.type,
            personality: npc.personality ?? '',
            bias: npc.bias ?? '',
            tier: npc.tier,
          },
          playerMessageId || threadId,
          env.topicBridgeStayShare,
        ).stance
      : 'stay';
    const prompted = topicAware
      ? buildTopicDmMessages({ ...dmInput, phase, stance: dmStance })
      : buildLegacyDmReplyMessages(dmInput);
    const request = {
      tier: 'standard' as const,
      json: true as const,
      temperature: 0.85,
      maxTokens: 300,
      label: 'npcMessenger.reply',
      messages: [
        { role: 'system' as const, content: prompted.system },
        { role: 'user' as const, content: prompted.user },
      ],
    };
    const parsed = asModelRecord(
      options?.client ? await options.client.chatJson(request) : await chatJson(request),
    );

    if (!parsed) return finish();
    let replyText = String(parsed.reply || '');
    let personaScreen: ChannelScreenResult | null = null;
    if (topicAware) {
      personaScreen = screenChannelReply({
        phase,
        classification: parsed.classification,
        replyText,
        authorHandle: npc.handle,
        stance: dmStance,
        leakTerms: leakTermsFromInitialState(initialState),
        playerText: playerMessage,
        isReply,
        minConfidence: env.topicBridgeMinConfidence,
      });
      outcome = personaScreen;
      replyText = personaScreen.replyText;
      if (personaScreen.dropped) {
        logger.info(
          { sessionId, threadId, handle: npc.handle },
          'Dropped topic reply that matched leak terms',
        );
        return finish(personaScreen);
      }
    }
    if (!replyText) return finish(personaScreen);

    const { data: inserted, error } = await supabaseAdmin
      .from('sim_direct_messages')
      .insert({
        session_id: sessionId,
        thread_id: threadId,
        sender_handle: npc.handle,
        sender_display_name: npc.name,
        sender_type: npc.type || 'npc_public',
        recipient_handle: replyToHandle,
        content: replyText,
        platform: 'facebook',
      })
      .select()
      .single();

    if (!error && inserted) {
      getWebSocketService().broadcastToSession(sessionId, {
        type: 'messenger.received',
        data: { message: inserted },
        timestamp: new Date().toISOString(),
      });
      logger.info({ sessionId, npcHandle: npc.handle, threadId }, 'NPC DM reply sent');
    }
    return finish(outcome);
  } catch (err) {
    logger.warn({ err, sessionId, threadId }, 'NPC DM reply failed');
    return finish(outcome);
  }
}
