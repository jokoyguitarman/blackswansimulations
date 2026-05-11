import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { getWebSocketService } from './websocketService.js';
import {
  notifyPostReply,
  notifyPostLike,
  notifyMention,
  extractMentions,
} from './socialNotificationService.js';

interface NPCPersona {
  handle: string;
  name: string;
  type: string;
  personality: string;
  bias: string;
  follower_count: number;
  specific_claims: string[];
}

export async function triggerNPCReactions(
  sessionId: string,
  playerPost: Record<string, unknown>,
): Promise<void> {
  if (!env.openAiApiKey) return;

  try {
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id')
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

    const postFormat = String(playerPost.post_format || 'text');
    const isReply = !!playerPost.reply_to_post_id;

    // Fetch thread context if this is a reply
    let threadContext = '';
    if (isReply) {
      const { data: parentPost } = await supabaseAdmin
        .from('social_posts')
        .select('content, author_handle, author_display_name, author_type')
        .eq('id', String(playerPost.reply_to_post_id))
        .single();

      if (parentPost) {
        const { data: threadReplies } = await supabaseAdmin
          .from('social_posts')
          .select('content, author_handle')
          .eq('reply_to_post_id', String(playerPost.reply_to_post_id))
          .order('created_at', { ascending: true })
          .limit(10);

        threadContext = `\n\nTHREAD CONTEXT:\nOriginal post by ${parentPost.author_handle}: "${String(parentPost.content).substring(0, 200)}"`;
        if (threadReplies && threadReplies.length > 0) {
          threadContext +=
            '\nPrevious replies:\n' +
            threadReplies
              .map((r) => `  ${r.author_handle}: "${String(r.content).substring(0, 100)}"`)
              .join('\n');
        }

        // Identify which specific comment the player is responding to via @mention
        const playerContent = String(playerPost.content || '');
        const mentionMatch = playerContent.match(/^(@[\w._]+)/);
        if (mentionMatch) {
          const targetHandle = mentionMatch[1];
          const targetReply = (threadReplies || [])
            .reverse()
            .find((r) => r.author_handle === targetHandle);
          if (targetReply) {
            threadContext += `\n\nThe player is SPECIFICALLY responding to ${targetHandle}'s comment: "${String(targetReply.content).substring(0, 200)}"`;
            threadContext += `\nNPCs should respond in context of THIS specific exchange, not the general thread.`;
          }
        }

        threadContext += `\n\nThe player just replied in this thread. NPCs who are part of this conversation should respond directly to what the player said, continuing the argument/discussion.`;
      }
    }

    // Higher probability for thread replies -- NPCs should almost always respond in threads
    const probabilityBoost = isReply ? 2.0 : 1.0;

    const reactingNPCs: Array<{ persona: NPCPersona; reactionType: string }> = [];

    for (const persona of personas) {
      const roll = Math.random();

      if (persona.bias && persona.bias !== 'none') {
        const threshold = (postFormat === 'humor_meme' ? 0.5 : 0.3) * probabilityBoost;
        if (roll < Math.min(threshold, 0.9)) {
          reactingNPCs.push({ persona, reactionType: 'attack' });
        }
      } else if (persona.type === 'npc_media') {
        const threshold =
          (postFormat === 'official_statement'
            ? 0.7
            : postFormat === 'humor_meme' || postFormat === 'video_concept'
              ? 0.8
              : 0.2) * probabilityBoost;
        if (roll < Math.min(threshold, 0.9)) {
          reactingNPCs.push({ persona, reactionType: 'cover' });
        }
      } else if (
        /supportive|community|interfaith|unity|advocate|defender|moderate|balanced|reasonable/i.test(
          persona.personality,
        )
      ) {
        if (roll < Math.min(0.6 * probabilityBoost, 0.9)) {
          reactingNPCs.push({ persona, reactionType: 'support' });
        }
      } else if (persona.type === 'npc_politician' || persona.type === 'npc_influencer') {
        if (roll < Math.min(0.4 * probabilityBoost, 0.9)) {
          const grade = (playerPost.sop_compliance_score as Record<string, unknown>) || {};
          const overall = Number(grade.overall) || 50;
          reactingNPCs.push({
            persona,
            reactionType: overall > 60 ? 'support' : overall < 40 ? 'attack' : 'neutral',
          });
        }
      }
    }

    // For thread replies, guarantee at least 1 NPC responds
    if (isReply && reactingNPCs.length === 0 && personas.length > 0) {
      const randomPersona = personas[Math.floor(Math.random() * personas.length)];
      reactingNPCs.push({
        persona: randomPersona,
        reactionType: randomPersona.bias && randomPersona.bias !== 'none' ? 'attack' : 'neutral',
      });
    }

    const selected = reactingNPCs.slice(0, Math.min(isReply ? 2 : 3, reactingNPCs.length));
    if (selected.length === 0) return;

    const npcContext = selected
      .map(
        (s) =>
          `${s.persona.handle} (${s.persona.name}): ${s.persona.personality}, bias: ${s.persona.bias}, type: ${s.persona.type}. React with: ${s.reactionType}`,
      )
      .join('\n');

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
            content: `You are generating NPC reactions to a player's social media post during a crisis simulation.

The player posted a ${postFormat} format post. Their handle is ${String(playerPost.author_handle || '@player')}. Generate realistic reactions from these NPCs:

${npcContext}

Reaction types:
- "attack": hostile reply -- twist their words, mock them, double down on misinformation, accuse them of bias
- "cover": media-style coverage -- neutral to positive news angle about the response team's communication
- "support": endorsing reply or repost with supportive commentary, OR just "like" the post
- "neutral": ambiguous reaction that could go either way

IMPORTANT RULES:
- When replying, START the reply by tagging the player: "${String(playerPost.author_handle || '@player')} ..." so they get notified
- Some NPCs can just LIKE the post instead of replying. Use action: "like" for this.
- Supportive NPCs are more likely to like; hostile NPCs are more likely to reply attacking.

Crisis context: ${String(scenario.description || '').substring(0, 300)}
${threadContext}

Each reaction should be 1-3 sentences, feel like a real social media reply/post. Stay in character.${isReply ? ' Since this is a thread reply, respond DIRECTLY to what the player said -- argue, agree, counter, or react to their specific words.' : ''}
If the player attached media (photo/video), the description is shown as [Attached media: ...]. React to the visual content as if you can see it -- reference what it shows, comment on its impact, or use it to fuel your argument.

Return ONLY valid JSON:
{ "reactions": [{ "author_handle": "@exact_handle", "author_display_name": "Exact Name", "author_type": "npc_public|npc_media|npc_politician|npc_influencer", "content": "reaction text", "sentiment": "negative|supportive|neutral|hateful", "is_reply": true, "action": "reply|repost_with_comment|new_post|like" }] }`,
          },
          {
            role: 'user',
            content: `Player post by ${String(playerPost.author_handle)}:\n"${String(playerPost.content || '')}"${playerPost.image_prompt ? `\n\n[Attached media: ${String(playerPost.image_prompt)}]` : ''}`,
          },
        ],
        temperature: 0.85,
        max_completion_tokens: 1500,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) return;

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return;

    const parsed = JSON.parse(content);
    const reactions = (parsed.reactions || []) as Array<Record<string, unknown>>;

    const postPlatform = String(playerPost.platform || 'x_twitter');
    const playerHandle = String(playerPost.author_handle || '@player');

    for (let i = 0; i < reactions.length; i++) {
      // Thread replies get faster responses (10-30s), top-level posts get 30s-3min
      const delay = isReply
        ? 10000 + Math.floor(Math.random() * 20000)
        : 30000 + Math.floor(Math.random() * 150000);
      setTimeout(
        async () => {
          try {
            const reaction = reactions[i];
            const actionType = String(reaction.action || 'reply');
            const npcName = String(reaction.author_display_name || 'NPC');
            const npcHandle = String(reaction.author_handle || '@npc');

            // Handle "like" action -- NPC likes the player's post
            if (actionType === 'like') {
              await supabaseAdmin
                .from('social_posts')
                .update({ like_count: ((playerPost.like_count as number) || 0) + 1 })
                .eq('id', playerPost.id);

              // Notify player about the NPC like
              void notifyPostLike(sessionId, playerHandle, npcName, 'like', postPlatform);

              getWebSocketService().broadcastToSession(sessionId, {
                type: 'social_posts.engagement_update',
                data: {
                  updates: [
                    {
                      id: playerPost.id,
                      like_count: ((playerPost.like_count as number) || 0) + 1,
                    },
                  ],
                },
                timestamp: new Date().toISOString(),
              });

              logger.info({ sessionId, npcHandle, playerPostId: playerPost.id }, 'NPC liked post');
              return;
            }

            // Handle reply/repost/new_post actions
            const replyContent = String(reaction.content || '');

            const { data: inserted, error } = await supabaseAdmin
              .from('social_posts')
              .insert({
                session_id: sessionId,
                platform: postPlatform,
                author_handle: npcHandle,
                author_display_name: npcName,
                author_type: String(reaction.author_type || 'npc_public'),
                content: replyContent,
                reply_to_post_id:
                  actionType === 'reply' || reaction.is_reply
                    ? String(playerPost.reply_to_post_id || playerPost.id)
                    : null,
                sentiment: String(reaction.sentiment || 'neutral'),
                hashtags: replyContent.match(/#\w+/g) || [],
                like_count: 0,
                repost_count: 0,
                reply_count: 0,
                view_count: 0,
                virality_score: 0,
                content_flags: {},
              })
              .select()
              .single();

            if (error) {
              logger.warn({ error }, 'Failed to insert NPC reaction');
              return;
            }

            if (actionType === 'reply' || reaction.is_reply) {
              const parentId = String(playerPost.reply_to_post_id || playerPost.id);
              const { data: parentRow } = await supabaseAdmin
                .from('social_posts')
                .select('reply_count')
                .eq('id', parentId)
                .single();
              if (parentRow) {
                await supabaseAdmin
                  .from('social_posts')
                  .update({ reply_count: ((parentRow.reply_count as number) || 0) + 1 })
                  .eq('id', parentId);
              }

              // Notify player about the NPC reply (use thread root as post_id, NPC reply as highlight)
              void notifyPostReply(
                sessionId,
                npcName,
                playerHandle,
                String(playerPost.reply_to_post_id || playerPost.id),
                replyContent,
                postPlatform,
                inserted.id,
              );
            }

            // Check for @mentions in the NPC reply and notify mentioned players
            const mentions = extractMentions(replyContent);
            for (const mentionedHandle of mentions) {
              if (mentionedHandle !== npcHandle) {
                void notifyMention(sessionId, mentionedHandle, npcName, replyContent, postPlatform);
              }
            }

            getWebSocketService().broadcastToSession(sessionId, {
              type: 'social_post.created',
              data: { post: inserted },
              timestamp: new Date().toISOString(),
            });

            logger.info(
              { sessionId, npcHandle, reactionType: actionType, playerPostId: playerPost.id },
              'NPC reaction posted',
            );
          } catch (err) {
            logger.warn({ err }, 'NPC reaction delivery failed');
          }
        },
        delay * (i + 1),
      );
    }

    logger.info(
      { sessionId, playerPostId: playerPost.id, reactionCount: reactions.length },
      'NPC reactions scheduled',
    );
  } catch (err) {
    logger.error({ err, sessionId }, 'NPC reaction trigger failed');
  }
}
