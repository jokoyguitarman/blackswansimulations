import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { getWebSocketService } from './websocketService.js';

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
    const postContent = String(playerPost.content || '');

    // Determine which NPCs react based on type and bias
    const reactingNPCs: Array<{ persona: NPCPersona; reactionType: string }> = [];

    for (const persona of personas) {
      const roll = Math.random();

      if (persona.bias && persona.bias !== 'none') {
        // Hostile persona
        const threshold = postFormat === 'humor_meme' ? 0.5 : 0.3;
        if (roll < threshold) {
          reactingNPCs.push({ persona, reactionType: 'attack' });
        }
      } else if (persona.type === 'npc_media') {
        // Media coverage for official statements and creative content
        const threshold =
          postFormat === 'official_statement'
            ? 0.7
            : postFormat === 'humor_meme' || postFormat === 'video_concept'
              ? 0.8
              : 0.2;
        if (roll < threshold) {
          reactingNPCs.push({ persona, reactionType: 'cover' });
        }
      } else if (/supportive|community|interfaith|unity/i.test(persona.personality)) {
        if (roll < 0.6) {
          reactingNPCs.push({ persona, reactionType: 'support' });
        }
      } else if (persona.type === 'npc_politician' || persona.type === 'npc_influencer') {
        // Wildcard -- reacts based on content quality grade if available
        if (roll < 0.4) {
          const grade = (playerPost.sop_compliance_score as Record<string, unknown>) || {};
          const overall = Number(grade.overall) || 50;
          reactingNPCs.push({
            persona,
            reactionType: overall > 60 ? 'support' : overall < 40 ? 'attack' : 'neutral',
          });
        }
      }
    }

    // Limit to 1-3 reactions
    const selected = reactingNPCs.slice(0, Math.min(3, reactingNPCs.length));
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

The player posted a ${postFormat} format post. Generate realistic reactions from these NPCs:

${npcContext}

Reaction types:
- "attack": hostile reply -- twist their words, mock them, double down on misinformation, accuse them of bias
- "cover": media-style coverage -- neutral to positive news angle about the response team's communication
- "support": endorsing reply or repost with supportive commentary
- "neutral": ambiguous reaction that could go either way

Crisis context: ${String(scenario.description || '').substring(0, 300)}

Each reaction should be 1-3 sentences, feel like a real social media reply/post. Stay in character.

Return ONLY valid JSON:
{ "reactions": [{ "author_handle": "@exact_handle", "author_display_name": "Exact Name", "author_type": "npc_public|npc_media|npc_politician|npc_influencer", "content": "reaction text", "sentiment": "negative|supportive|neutral|hateful", "is_reply": true, "action": "reply|repost_with_comment|new_post" }] }`,
          },
          {
            role: 'user',
            content: `Player post by ${String(playerPost.author_handle)}:\n"${postContent}"`,
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

    for (let i = 0; i < reactions.length; i++) {
      // Stagger delivery: 30s to 3min between reactions
      const delay = 30000 + Math.floor(Math.random() * 150000);
      setTimeout(
        async () => {
          try {
            const reaction = reactions[i];
            const isReply = reaction.action === 'reply' || reaction.is_reply;

            const { data: inserted, error } = await supabaseAdmin
              .from('social_posts')
              .insert({
                session_id: sessionId,
                platform: playerPost.platform || 'x_twitter',
                author_handle: String(reaction.author_handle || '@npc'),
                author_display_name: String(reaction.author_display_name || 'NPC'),
                author_type: String(reaction.author_type || 'npc_public'),
                content: String(reaction.content || ''),
                reply_to_post_id: isReply ? playerPost.id : null,
                sentiment: String(reaction.sentiment || 'neutral'),
                hashtags: String(reaction.content || '').match(/#\w+/g) || [],
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

            if (isReply) {
              await supabaseAdmin
                .from('social_posts')
                .update({
                  reply_count: ((playerPost.reply_count as number) || 0) + 1,
                })
                .eq('id', playerPost.id);
            }

            getWebSocketService().broadcastToSession(sessionId, {
              type: 'social_post.created',
              data: { post: inserted },
              timestamp: new Date().toISOString(),
            });

            logger.info(
              {
                sessionId,
                npcHandle: reaction.author_handle,
                reactionType: reaction.action,
                playerPostId: playerPost.id,
              },
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
