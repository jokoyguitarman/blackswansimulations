import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { getWebSocketService } from './websocketService.js';
import { computeSessionSentiment } from './sentimentSimService.js';

interface RegisteredNPC {
  handle: string;
  display_name: string;
  personality: string;
  bias: string;
}

const sessionNPCRegistry = new Map<string, Map<string, RegisteredNPC>>();

function getRegistry(sessionId: string): Map<string, RegisteredNPC> {
  if (!sessionNPCRegistry.has(sessionId)) {
    sessionNPCRegistry.set(sessionId, new Map());
  }
  return sessionNPCRegistry.get(sessionId)!;
}

function registerNPC(sessionId: string, npc: RegisteredNPC): void {
  getRegistry(sessionId).set(npc.handle, npc);
}

function getRegisteredNPCs(sessionId: string): RegisteredNPC[] {
  return Array.from(getRegistry(sessionId).values());
}

function loadDesignedPersonas(initialState: Record<string, unknown>, sessionId: string): void {
  const personas = (initialState.npc_personas || []) as Array<Record<string, unknown>>;
  for (const p of personas) {
    registerNPC(sessionId, {
      handle: String(p.handle || ''),
      display_name: String(p.name || ''),
      personality: String(p.personality || ''),
      bias: String(p.bias || 'none'),
    });
  }
}

async function callAI(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 2000,
  temperature = 0.85,
): Promise<Record<string, unknown> | null> {
  if (!env.openAiApiKey) return null;
  try {
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
          { role: 'user', content: userPrompt },
        ],
        temperature,
        max_completion_tokens: maxTokens,
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content);
  } catch (err) {
    logger.warn({ err }, 'Ambient AI call failed');
    return null;
  }
}

async function insertPost(
  sessionId: string,
  post: Record<string, unknown>,
  replyToId?: string,
): Promise<Record<string, unknown> | null> {
  const handle = String(post.author_handle || '@anon');
  const displayName = String(post.author_display_name || 'User');
  const content = String(post.content || '');

  registerNPC(sessionId, {
    handle,
    display_name: displayName,
    personality: String(post.personality || ''),
    bias: String(post.bias || 'none'),
  });

  const { data: inserted, error } = await supabaseAdmin
    .from('social_posts')
    .insert({
      session_id: sessionId,
      platform: 'x_twitter',
      author_handle: handle,
      author_display_name: displayName,
      author_type: String(post.author_type || 'npc_public'),
      content,
      hashtags: content.match(/#\w+/g) || [],
      reply_to_post_id: replyToId || null,
      sentiment: String(post.sentiment || 'neutral'),
      virality_score: Number(post.virality_score) || 0,
      content_flags: (post.content_flags as Record<string, unknown>) || {},
      like_count: 0,
      repost_count: 0,
      reply_count: 0,
      view_count: 0,
    })
    .select()
    .single();

  if (error) {
    logger.warn({ error, sessionId }, 'Failed to insert ambient post');
    return null;
  }

  if (replyToId) {
    const { data: parent } = await supabaseAdmin
      .from('social_posts')
      .select('reply_count')
      .eq('id', replyToId)
      .single();
    await supabaseAdmin
      .from('social_posts')
      .update({ reply_count: ((parent?.reply_count as number) || 0) + 1 })
      .eq('id', replyToId);
  }

  getWebSocketService().broadcastToSession(sessionId, {
    type: 'social_post.created',
    data: { post: inserted },
    timestamp: new Date().toISOString(),
  });

  return inserted;
}

// ─── Main entry point (called from inject scheduler) ────────────────────────

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

    const initialState = (scenario.initial_state || {}) as Record<string, unknown>;
    loadDesignedPersonas(initialState, sessionId);

    const sentiment = await computeSessionSentiment(sessionId);

    const { data: recentPosts } = await supabaseAdmin
      .from('social_posts')
      .select('content, author_handle, sentiment')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(10);

    const recentContext = (recentPosts || [])
      .map((p) => `${String(p.author_handle)}: ${String(p.content).substring(0, 80)}`)
      .join('\n');

    const knownNPCs = getRegisteredNPCs(sessionId);
    const npcList = knownNPCs
      .slice(0, 10)
      .map(
        (n) =>
          `${n.handle} (${n.display_name}): ${n.personality || 'regular user'}, bias: ${n.bias}`,
      )
      .join('\n');

    const result = await callAI(
      `You generate realistic social media posts for a crisis simulation. Make the feed feel ALIVE.

THE CRISIS: ${String(scenario.description).substring(0, 300)}
Sentiment: ${sentiment.overall}/100 (${sentiment.trend}). Elapsed: ${elapsedMinutes}min.

${npcList ? `KNOWN USERS (use these OR create new ones):\n${npcList}\n` : ''}

Recent feed:\n${recentContext || '(empty)'}

Generate 2-3 posts. Mix:
- 1-2 about the crisis (reactions, opinions, news sharing)
- 0-1 normal life or tangentially related posts
${elapsedMinutes < 5 ? '- Early crisis: confused, alarmed, asking what happened' : ''}
${elapsedMinutes > 20 ? '- Ongoing: opinions forming, blame emerging, some calling for calm' : ''}
${sentiment.overall < 40 ? '- Sentiment critical: more fear/anger' : ''}

Return ONLY valid JSON:
{ "posts": [{ "author_handle": "@user", "author_display_name": "Name", "author_type": "npc_public", "content": "text", "sentiment": "neutral|negative|supportive|hateful|inflammatory", "virality_score": 5, "content_flags": {} }] }`,
      'Generate ambient posts.',
      1500,
    );

    const postsArray = Array.isArray(result)
      ? result
      : ((result as Record<string, unknown>)?.posts as unknown[]);
    if (!Array.isArray(postsArray)) return;

    for (let i = 0; i < postsArray.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 2000 + Math.floor(Math.random() * 6000)));
      await insertPost(sessionId, postsArray[i] as Record<string, unknown>);
    }

    logger.info({ sessionId, count: postsArray.length, elapsedMinutes }, 'Ambient posts generated');

    await simulateThreadActivity(sessionId, String(scenario.description || ''));
    await simulateThreadActivity(sessionId, String(scenario.description || ''));

    if (Math.random() < 0.5) {
      await simulateThreadActivity(sessionId, String(scenario.description || ''));
    }

    await bumpOrganicEngagement(sessionId);
  } catch (err) {
    logger.error({ err, sessionId }, 'Ambient content generation failed');
  }
}

// ─── Thread simulator (NPC-to-NPC conversations) ───────────────────────────

async function simulateThreadActivity(sessionId: string, crisisDescription: string): Promise<void> {
  const { data: postsWithReplies } = await supabaseAdmin
    .from('social_posts')
    .select('id, content, author_handle, author_display_name, reply_count')
    .eq('session_id', sessionId)
    .is('reply_to_post_id', null)
    .gt('reply_count', 0)
    .order('reply_count', { ascending: false })
    .limit(5);

  const { data: postsWithoutReplies } = await supabaseAdmin
    .from('social_posts')
    .select('id, content, author_handle, author_display_name, reply_count')
    .eq('session_id', sessionId)
    .is('reply_to_post_id', null)
    .eq('reply_count', 0)
    .order('created_at', { ascending: false })
    .limit(5);

  const candidates = [...(postsWithReplies || []), ...(postsWithoutReplies || [])];
  if (candidates.length === 0) return;

  const targetPost = candidates[Math.floor(Math.random() * candidates.length)];

  const { data: existingReplies } = await supabaseAdmin
    .from('social_posts')
    .select('id, content, author_handle, author_display_name')
    .eq('session_id', sessionId)
    .eq('reply_to_post_id', targetPost.id)
    .order('created_at', { ascending: true })
    .limit(15);

  const threadParticipants = new Map<string, string>();
  threadParticipants.set(String(targetPost.author_handle), String(targetPost.author_display_name));
  for (const r of existingReplies || []) {
    threadParticipants.set(String(r.author_handle), String(r.author_display_name));
  }

  const threadContext = [
    `ORIGINAL POST by ${String(targetPost.author_handle)}: "${String(targetPost.content).substring(0, 200)}"`,
    ...(existingReplies || []).map(
      (r) => `  REPLY by ${String(r.author_handle)}: "${String(r.content).substring(0, 150)}"`,
    ),
  ].join('\n');

  const participantList = Array.from(threadParticipants.entries())
    .map(([handle, name]) => {
      const reg = getRegistry(sessionId).get(handle);
      return `${handle} (${name})${reg?.personality ? `: ${reg.personality}` : ''}${reg?.bias && reg.bias !== 'none' ? `, bias: ${reg.bias}` : ''}`;
    })
    .join('\n');

  const knownNPCs = getRegisteredNPCs(sessionId)
    .slice(0, 5)
    .filter((n) => !threadParticipants.has(n.handle))
    .map((n) => `${n.handle} (${n.display_name}): ${n.personality}`)
    .join('\n');

  const result = await callAI(
    `You are simulating a social media comment thread during a crisis.

THREAD SO FAR:
${threadContext}

USERS ALREADY IN THIS THREAD:
${participantList}

${knownNPCs ? `OTHER KNOWN USERS WHO COULD JOIN:\n${knownNPCs}\n` : ''}

Generate 2-3 new replies to continue this thread. Rules:
- 70% chance: pick someone ALREADY in the thread to reply again (stay in character!)
- 30% chance: introduce ONE new commenter (either from known users or create a new one)
- If a user is already in the thread, you MUST use their EXACT handle and display name
- Replies can be to the original post OR to another reply (arguments, agreements, corrections)
- Characters should stay consistent with their personality and bias
- Make it feel like a real argument/discussion -- people interrupt each other, quote each other, get emotional
- 1-2 sentences per reply

Crisis context: ${crisisDescription.substring(0, 200)}

Return ONLY valid JSON:
{ "replies": [{ "author_handle": "@exact_handle", "author_display_name": "Exact Name", "content": "reply text", "sentiment": "neutral|negative|supportive|hateful" }] }`,
    'Continue the thread conversation.',
    1000,
  );

  const replies = (result?.replies as Array<Record<string, unknown>>) || [];

  for (let i = 0; i < replies.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1000 + Math.floor(Math.random() * 3000)));
    const reply = replies[i];
    await insertPost(sessionId, reply, targetPost.id as string);
  }

  if (replies.length > 0) {
    logger.info(
      { sessionId, postId: targetPost.id, newReplies: replies.length },
      'Thread activity simulated',
    );
  }
}

// ─── Organic engagement bumps (no AI needed) ────────────────────────────────

async function bumpOrganicEngagement(sessionId: string): Promise<void> {
  try {
    const { data: allPosts } = await supabaseAdmin
      .from('social_posts')
      .select('id, like_count, repost_count, view_count, virality_score, reply_to_post_id')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(40);

    if (!allPosts || allPosts.length === 0) return;

    const topLevel = allPosts.filter((p) => !p.reply_to_post_id);
    const replies = allPosts.filter((p) => !!p.reply_to_post_id);

    const postsToBump = topLevel
      .sort(() => Math.random() - 0.5)
      .slice(0, 5 + Math.floor(Math.random() * 5));

    const updates: Array<{ id: string; changes: Record<string, number> }> = [];

    for (const post of postsToBump) {
      const virality = Number(post.virality_score) || 10;
      const likeBump = Math.floor(Math.random() * Math.max(2, virality / 5)) + 1;
      const viewBump = Math.floor(Math.random() * Math.max(20, virality * 2)) + 10;
      const repostBump = Math.random() < 0.3 ? Math.floor(Math.random() * 3) + 1 : 0;

      const newLikes = ((post.like_count as number) || 0) + likeBump;
      const newViews = ((post.view_count as number) || 0) + viewBump;
      const newReposts = ((post.repost_count as number) || 0) + repostBump;

      updates.push({
        id: post.id as string,
        changes: { like_count: newLikes, view_count: newViews, repost_count: newReposts },
      });
    }

    const repliesToBump = replies
      .sort(() => Math.random() - 0.5)
      .slice(0, 3 + Math.floor(Math.random() * 3));

    for (const reply of repliesToBump) {
      const likeBump = Math.floor(Math.random() * 5) + 1;
      const newLikes = ((reply.like_count as number) || 0) + likeBump;
      updates.push({ id: reply.id as string, changes: { like_count: newLikes } });
    }

    for (const up of updates) {
      await supabaseAdmin.from('social_posts').update(up.changes).eq('id', up.id);
    }

    getWebSocketService().broadcastToSession(sessionId, {
      type: 'social_posts.engagement_update',
      data: { updates: updates.map((u) => ({ id: u.id, ...u.changes })) },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn({ err, sessionId }, 'Organic engagement bump failed');
  }
}
