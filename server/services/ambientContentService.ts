import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { getWebSocketService } from './websocketService.js';
import { computeSessionSentiment } from './sentimentSimService.js';

export async function generateAmbientPosts(sessionId: string): Promise<void> {
  if (!env.openAiApiKey) return;

  try {
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id, start_time, current_state')
      .eq('id', sessionId)
      .single();

    if (!session?.start_time) return;

    const elapsedMinutes = Math.floor(
      (Date.now() - new Date(session.start_time).getTime()) / 60000,
    );

    const { data: scenario } = await supabaseAdmin
      .from('scenarios')
      .select('title, description, initial_state')
      .eq('id', session.scenario_id)
      .single();

    if (!scenario) return;

    const sentiment = await computeSessionSentiment(sessionId);

    const { data: recentPosts } = await supabaseAdmin
      .from('social_posts')
      .select('content, author_handle, sentiment')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(10);

    const recentContext = (recentPosts || [])
      .map((p) => `${p.author_handle}: ${p.content.substring(0, 100)}`)
      .join('\n');

    const initialState = (scenario.initial_state || {}) as Record<string, unknown>;
    const npcPersonas = (initialState.npc_personas || []) as Array<Record<string, unknown>>;
    const npcContext =
      npcPersonas.length > 0
        ? npcPersonas
            .slice(0, 8)
            .map((p) => `${p.handle} (${p.name}): ${p.personality}, bias: ${p.bias}`)
            .join('\n')
        : '';

    const systemPrompt = `You generate realistic social media posts for a crisis simulation exercise. Your job is to make the social media feed feel ALIVE and REAL -- like an actual X/Twitter timeline during a crisis.

THE CRISIS: ${scenario.description}

Current sentiment: ${sentiment.overall}/100 (${sentiment.trend})
Elapsed time: ${elapsedMinutes} minutes since the incident.
Hate speech volume: ${sentiment.hate_speech_volume} posts
Supportive volume: ${sentiment.supportive_volume} posts

${npcContext ? `AVAILABLE NPC PERSONAS (use these or create new random users):\n${npcContext}\n` : ''}

Recent posts already on the feed:
${recentContext || '(empty feed)'}

Generate 3-5 realistic social media posts. The mix should include:
- 1-2 posts ABOUT the crisis (reactions, opinions, sharing news, expressing concern or anger)
- 1 post that is NORMAL LIFE (someone posting about food, work, sports, weather -- unrelated to the crisis, to make the feed feel real)
- 1 post that is TANGENTIALLY related (e.g. "traffic is crazy near the station" or "schools are sending kids home early")
${sentiment.overall < 40 ? '- Include 1 more fearful/angry post -- sentiment is critically low' : ''}
${sentiment.overall > 60 ? '- Include 1 more calm/supportive post -- sentiment is recovering' : ''}
${elapsedMinutes < 5 ? '- This is the FIRST MINUTES of the crisis. Posts should be confused, alarmed, sharing breaking news, asking what happened.' : ''}
${elapsedMinutes > 20 ? '- The crisis has been ongoing for 20+ minutes. Posts should show opinions forming, blame emerging, some people calling for calm.' : ''}

Use realistic handles, display names, and posting styles. Vary the follower counts (some posts from accounts with 50 followers, some with 5000). Include hashtags where natural.

Return ONLY valid JSON:
{ "posts": [{
  "author_handle": "@username",
  "author_display_name": "Display Name",
  "author_type": "npc_public",
  "content": "Post content with #hashtags",
  "sentiment": "neutral|negative|supportive|hateful|inflammatory|positive",
  "virality_score": 5-80,
  "content_flags": { "is_misinformation": false, "is_hate_speech": false }
}] }`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.openAiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5.2',
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: 'Generate ambient social media posts for the current moment in the crisis.',
          },
        ],
        temperature: 0.8,
        max_completion_tokens: 1024,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) return;

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return;
    }

    const postsArray = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown>).posts;
    if (!Array.isArray(postsArray)) return;

    for (const post of postsArray) {
      const hashtags = (post.content as string).match(/#\w+/g) || [];
      const { data: inserted, error } = await supabaseAdmin
        .from('social_posts')
        .insert({
          session_id: sessionId,
          platform: 'x_twitter',
          author_handle: post.author_handle,
          author_display_name: post.author_display_name,
          author_type: post.author_type || 'npc_public',
          content: post.content,
          hashtags,
          sentiment: post.sentiment || 'neutral',
          virality_score: post.virality_score || 20,
          content_flags: post.content_flags || {},
          like_count: Math.floor(Math.random() * 200),
          repost_count: Math.floor(Math.random() * 50),
          reply_count: Math.floor(Math.random() * 30),
          view_count: Math.floor(Math.random() * 2000),
        })
        .select()
        .single();

      if (!error && inserted) {
        getWebSocketService().broadcastToSession(sessionId, {
          type: 'social_post.created',
          data: { post: inserted },
          timestamp: new Date().toISOString(),
        });
      }
    }

    logger.info({ sessionId, count: postsArray.length, elapsedMinutes }, 'Ambient posts generated');
  } catch (err) {
    logger.error({ err, sessionId }, 'Ambient content generation failed');
  }
}
