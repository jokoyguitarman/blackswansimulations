import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { getWebSocketService } from './websocketService.js';
import { randomUUID } from 'crypto';

interface NPCPersona {
  handle: string;
  name: string;
  type: string;
  personality: string;
  bias: string;
  follower_count: number;
  specific_claims: string[];
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
    const handle = `@${profile.full_name.replace(/[@.\s+]/g, '_').toLowerCase()}`;
    if (handle === recipientHandle) return p.user_id;
  }

  return null;
}

export async function triggerNPCMessages(sessionId: string): Promise<void> {
  if (!env.openAiApiKey) return;

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
        handle: `@${name.replace(/[@.\s+]/g, '_').toLowerCase()}`,
      };
    });

    // Spam guard: skip if too many DMs already exist for this session
    const { count: existingCount } = await supabaseAdmin
      .from('sim_direct_messages')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', sessionId);

    if ((existingCount || 0) > 15) {
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

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.openAiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5.2',
        messages: [
          {
            role: 'system',
            content: `You are generating NPC direct messages to players during a crisis simulation. NPCs may privately DM players to create pressure, share tips, request comments, or express concern.

Crisis context: ${String(scenario.description || '').substring(0, 400)}

NPC personas:
${personaList}

Player handles in this session: ${playerHandles}

Current crisis metrics: ${crisisMetrics}

Types of DMs NPCs might send:
- Journalist requesting an official comment or interview
- Key stakeholder seeking guidance or expressing frustration
- Concerned citizen or affected party asking what's being done
- Anonymous tipster sharing unverified information
- Threatening or hostile message from an aggressive persona
- Ally or advocate offering support or sharing useful intel

RULES:
- Only generate 1-3 messages total (or 0 if the situation doesn't warrant it).
- Each message should be 1-3 sentences and feel authentic to the sender's personality.
- Messages should create meaningful decision pressure for the player.
- sender_handle and sender_display_name must match an NPC from the persona list.
- sender_type must match the NPC's type.
- recipient_handle must be one of the player handles listed.
- urgency reflects how time-sensitive the message feels.

Return ONLY valid JSON:
{ "messages": [{ "sender_handle": "@exact_handle", "sender_display_name": "Exact Name", "sender_type": "npc_public|npc_media|npc_politician|npc_influencer", "recipient_handle": "@player_handle", "content": "message text", "urgency": "low|medium|high" }] }

If no messages are warranted right now, return: { "messages": [] }`,
          },
          {
            role: 'user',
            content: 'Generate NPC direct messages for the current crisis state.',
          },
        ],
        temperature: 0.85,
        max_completion_tokens: 1000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status, sessionId }, 'OpenAI DM generation request failed');
      return;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return;

    const parsed = JSON.parse(content);
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
