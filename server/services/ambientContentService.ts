import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { getWebSocketService } from './websocketService.js';
import { computeSessionSentiment } from './sentimentSimService.js';
import {
  generatePostImage,
  generateVideo,
  generateVideoThumbnail,
} from './mediaGenerationService.js';
import { triggerNPCMessages } from './npcMessengerService.js';
import { normalizeOrgPages } from './socialCrisisGeneratorService.js';

interface RegisteredNPC {
  handle: string;
  display_name: string;
  personality: string;
  bias: string;
  tier?: 'key' | 'background';
  normal_interests?: string[];
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

function getKeyNPCs(sessionId: string): RegisteredNPC[] {
  return getRegisteredNPCs(sessionId).filter((n) => n.tier === 'key' || !n.tier);
}

function getBackgroundNPCs(sessionId: string): RegisteredNPC[] {
  return getRegisteredNPCs(sessionId).filter((n) => n.tier === 'background');
}

function loadDesignedPersonas(initialState: Record<string, unknown>, sessionId: string): void {
  const personas = (initialState.npc_personas || []) as Array<Record<string, unknown>>;
  for (const p of personas) {
    registerNPC(sessionId, {
      handle: String(p.handle || ''),
      display_name: String(p.name || ''),
      personality: String(p.personality || ''),
      bias: String(p.bias || 'none'),
      tier: (p.tier as 'key' | 'background') || 'key',
      normal_interests: Array.isArray(p.normal_interests)
        ? (p.normal_interests as string[]).map(String)
        : [],
    });
  }
}

// ─── Reaction Distribution ──────────────────────────────────────────────────

function getReactionSummary(sentiment: string, likeCount: number): string[] {
  if (likeCount === 0) return [];
  const distributions: Record<string, [string, number][]> = {
    positive: [
      ['like', 0.6],
      ['love', 0.25],
      ['wow', 0.1],
      ['haha', 0.05],
    ],
    supportive: [
      ['like', 0.5],
      ['love', 0.35],
      ['wow', 0.1],
      ['haha', 0.05],
    ],
    negative: [
      ['angry', 0.5],
      ['sad', 0.2],
      ['wow', 0.15],
      ['like', 0.1],
      ['haha', 0.05],
    ],
    hateful: [
      ['angry', 0.6],
      ['sad', 0.15],
      ['wow', 0.1],
      ['like', 0.1],
      ['haha', 0.05],
    ],
    inflammatory: [
      ['angry', 0.45],
      ['wow', 0.2],
      ['sad', 0.15],
      ['haha', 0.1],
      ['like', 0.1],
    ],
    neutral: [
      ['like', 0.7],
      ['wow', 0.15],
      ['love', 0.1],
      ['sad', 0.05],
    ],
    humorous: [
      ['haha', 0.6],
      ['like', 0.25],
      ['love', 0.1],
      ['wow', 0.05],
    ],
  };
  const dist = distributions[sentiment] || distributions.neutral;
  const types: string[] = [];
  for (const [type, weight] of dist) {
    if (Math.floor(likeCount * weight) >= 1) types.push(type);
  }
  return types.length > 0 ? types : ['like'];
}

// ─── Player Bubble Assignment ────────────────────────────────────────────────

const playerBubbles = new Map<string, Map<string, string[]>>();
const playerCycleIndex = new Map<string, number>();

function getPlayerBubble(sessionId: string, playerId: string): string[] {
  return playerBubbles.get(sessionId)?.get(playerId) || [];
}

function getBubbleNPCs(sessionId: string, playerId: string): RegisteredNPC[] {
  const handles = getPlayerBubble(sessionId, playerId);
  const registry = getRegistry(sessionId);
  return handles.map((h) => registry.get(h)).filter(Boolean) as RegisteredNPC[];
}

async function assignPlayerBubbles(sessionId: string): Promise<void> {
  if (playerBubbles.has(sessionId) && (playerBubbles.get(sessionId)?.size ?? 0) > 0) return;

  const { data: participants } = await supabaseAdmin
    .from('session_participants')
    .select('user_id, demographics')
    .eq('session_id', sessionId);

  if (!participants || participants.length === 0) return;

  const keyNpcs = getKeyNPCs(sessionId);
  const bgNpcs = getBackgroundNPCs(sessionId);
  const sessionBubbles = new Map<string, string[]>();

  // Shared key NPCs that all players get (media + wildcard types)
  const sharedKeyHandles = keyNpcs
    .filter((n) => n.bias === 'none' || /media|journalist|news/i.test(n.personality))
    .slice(0, 3)
    .map((n) => n.handle);

  for (const participant of participants) {
    const playerId = String(participant.user_id);
    const demo = (participant.demographics || {}) as Record<string, string>;
    const bubble: string[] = [...sharedKeyHandles];

    // Assign 3-5 key NPCs based on a hash of player demographics
    const demoHash = simpleHash(
      `${playerId}_${demo.race || ''}_${demo.age_bracket || ''}_${demo.gender || ''}`,
    );
    const availableKey = keyNpcs.filter((n) => !sharedKeyHandles.includes(n.handle));
    const keyCount = 3 + (demoHash % 3);
    for (let i = 0; i < Math.min(keyCount, availableKey.length); i++) {
      const idx = (demoHash + i * 7) % availableKey.length;
      if (!bubble.includes(availableKey[idx].handle)) {
        bubble.push(availableKey[idx].handle);
      }
    }

    // Assign 10-12 background NPCs using deterministic shuffle
    const bgCount = 10 + (demoHash % 3);
    const shuffled = [...bgNpcs].sort((a, b) => {
      const ha = simpleHash(`${playerId}_${a.handle}`);
      const hb = simpleHash(`${playerId}_${b.handle}`);
      return ha - hb;
    });
    for (let i = 0; i < Math.min(bgCount, shuffled.length); i++) {
      bubble.push(shuffled[i].handle);
    }

    sessionBubbles.set(playerId, bubble);
  }

  playerBubbles.set(sessionId, sessionBubbles);
  logger.info(
    {
      sessionId,
      players: sessionBubbles.size,
      avgBubbleSize: Math.round(
        [...sessionBubbles.values()].reduce((s, b) => s + b.length, 0) / sessionBubbles.size,
      ),
    },
    'Player NPC bubbles assigned',
  );
}

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

// ─── Branded History Seeding ─────────────────────────────────────────────────

const seededSessions = new Set<string>();

/**
 * Upsert the org page rows (one per platform per org) for a session from its
 * initial_state.org_page config. Safe to call multiple times. Does not seed
 * branded history posts.
 */
export async function seedOrgPages(
  sessionId: string,
  initialState: Record<string, unknown>,
): Promise<void> {
  const orgPage = initialState?.org_page as Record<string, unknown> | undefined;
  if (!orgPage) return;

  const orgs = normalizeOrgPages(orgPage);
  for (const org of orgs) {
    if (org.facebook) {
      await supabaseAdmin.from('sim_org_pages').upsert(
        {
          session_id: sessionId,
          org_key: org.org_key,
          is_primary: org.is_primary,
          platform: 'facebook',
          page_name: String(org.facebook.page_name || 'Organization'),
          page_handle: String(org.facebook.page_handle || '@Organization'),
          page_bio: String(org.facebook.page_bio || ''),
          follower_count: Number(org.facebook.follower_count) || 50000,
          page_logo_url: String(org.facebook.page_logo_url || ''),
          verified: true,
        },
        { onConflict: 'session_id,platform,org_key' },
      );
    }

    if (org.x_twitter) {
      await supabaseAdmin.from('sim_org_pages').upsert(
        {
          session_id: sessionId,
          org_key: org.org_key,
          is_primary: org.is_primary,
          platform: 'x_twitter',
          page_name: String(org.x_twitter.page_name || 'Organization'),
          page_handle: String(org.x_twitter.page_handle || '@Org'),
          page_bio: String(org.x_twitter.page_bio || ''),
          follower_count: Number(org.x_twitter.follower_count) || 30000,
          page_logo_url: String(org.x_twitter.page_logo_url || ''),
          verified: true,
        },
        { onConflict: 'session_id,platform,org_key' },
      );
    }
  }
}

async function seedBrandedHistory(
  sessionId: string,
  initialState: Record<string, unknown>,
  sessionStartTime: string,
): Promise<void> {
  if (seededSessions.has(sessionId)) return;

  const orgPage = initialState.org_page as Record<string, unknown> | undefined;
  if (!orgPage) {
    seededSessions.add(sessionId);
    return;
  }

  const { count } = await supabaseAdmin
    .from('social_posts')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId)
    .eq('is_branded_history', true);

  if ((count || 0) > 0) {
    seededSessions.add(sessionId);
    return;
  }

  const orgs = normalizeOrgPages(orgPage);
  const primary = orgs.find((o) => o.is_primary) || orgs[0];
  // Branded history is a flat list authored by the primary org.
  const fb = primary?.facebook;
  const tw = primary?.x_twitter;
  const history = (orgPage.branded_history || []) as Array<Record<string, unknown>>;

  await seedOrgPages(sessionId, initialState);

  const startTime = new Date(sessionStartTime).getTime();

  for (const post of history) {
    const platform = String(post.platform || 'facebook');
    const pageConfig = platform === 'facebook' ? fb : tw;
    if (!pageConfig) continue;

    const daysAgo = Number(post.days_ago) || 7;
    const backdatedTime = new Date(startTime - daysAgo * 24 * 60 * 60 * 1000);
    const baseLikes = 50 + Math.floor(Math.random() * 200);

    const { data: inserted } = await supabaseAdmin
      .from('social_posts')
      .insert({
        session_id: sessionId,
        platform,
        author_handle: String(pageConfig.page_handle || '@Org'),
        author_display_name: String(pageConfig.page_name || 'Organization'),
        author_type: 'official_account',
        content: String(post.content || ''),
        post_format: String(post.post_format || 'text'),
        sentiment: 'positive',
        virality_score: 20 + Math.floor(Math.random() * 30),
        content_flags: {},
        like_count: baseLikes,
        repost_count: Math.floor(baseLikes * 0.15),
        reply_count: Math.floor(baseLikes * 0.05),
        view_count: baseLikes * 5 + Math.floor(Math.random() * 1000),
        reaction_summary: getReactionSummary('positive', baseLikes),
        is_branded_history: true,
        created_at: backdatedTime.toISOString(),
      })
      .select('id')
      .single();

    const mediaDesc = String(post.media_description || '');
    if (mediaDesc && inserted?.id) {
      void (async () => {
        try {
          const postFormat = String(post.post_format || 'text');
          const isVideo =
            /video|clip|footage|recording/i.test(mediaDesc) || postFormat === 'video_concept';
          let url: string | null = null;

          if (isVideo) {
            url = await generateVideoThumbnail(mediaDesc);
          } else {
            const style = postFormat === 'infographic' ? 'infographic' : 'social_media_photo';
            url = await generatePostImage(mediaDesc, style);
          }

          if (url) {
            await supabaseAdmin
              .from('social_posts')
              .update({ media_urls: [url] })
              .eq('id', inserted.id);
          }
        } catch (err) {
          logger.warn({ err, postId: inserted.id }, 'Branded history media generation failed');
        }
      })();
    }
  }

  seededSessions.add(sessionId);
  logger.info({ sessionId, historyCount: history.length }, 'Branded history seeded');

  // Seed comments on branded history posts (non-blocking)
  const seededPostIds = history
    .map((_, i) => i)
    .filter((i) => {
      const platform = String(history[i].platform || 'facebook');
      return platform === 'facebook' ? !!fb : !!tw;
    });
  if (seededPostIds.length > 0) {
    void seedBrandedComments(sessionId, initialState);
  }
}

async function seedBrandedComments(
  sessionId: string,
  initialState: Record<string, unknown>,
): Promise<void> {
  try {
    const personas = (initialState.npc_personas || []) as Array<Record<string, unknown>>;
    if (personas.length === 0) return;

    const { data: brandedPosts } = await supabaseAdmin
      .from('social_posts')
      .select('id, content, platform, author_display_name, created_at, sentiment')
      .eq('session_id', sessionId)
      .eq('is_branded_history', true)
      .order('created_at', { ascending: true })
      .limit(20);

    if (!brandedPosts || brandedPosts.length === 0) return;

    const npcList = personas
      .slice(0, 15)
      .map((p) => `${p.handle} (${p.name}): ${String(p.personality || '').substring(0, 60)}`)
      .join('\n');

    const postSummaries = brandedPosts
      .map(
        (p, i) =>
          `Post ${i + 1} [${p.id}] by ${p.author_display_name}: "${String(p.content).substring(0, 100)}"`,
      )
      .join('\n');

    const result = await callAI(
      `Generate realistic comments on these pre-crisis social media posts from a company page. These are normal brand posts before any crisis hit.

POSTS:
${postSummaries}

AVAILABLE NPC COMMENTERS:
${npcList}

For EACH post, generate 2-4 comments. Comments should feel natural:
- Supportive customers praising products/services
- Questions about availability, pricing, or details
- Casual reactions ("Nice!", "Love this!", "When is this available?")
- Occasional skeptic or competitor mention
- 1-2 sentences each, casual social media tone

Return ONLY valid JSON:
{ "comments": [{ "post_id": "exact_post_id_from_above", "author_handle": "@npc_handle", "author_display_name": "NPC Name", "content": "comment text", "sentiment": "supportive|neutral|negative" }] }`,
      'Generate branded history comments.',
      4000,
      0.9,
    );

    const comments = (result?.comments as Array<Record<string, unknown>>) || [];
    const commentCounts: Record<string, number> = {};

    for (const comment of comments) {
      const postId = String(comment.post_id || '');
      const parentPost = brandedPosts.find((p) => p.id === postId);
      if (!parentPost) continue;

      const backdateOffset = Math.floor(Math.random() * 3600000 * 6);
      const commentTime = new Date(new Date(parentPost.created_at).getTime() + backdateOffset);

      await supabaseAdmin.from('social_posts').insert({
        session_id: sessionId,
        platform: parentPost.platform,
        author_handle: String(comment.author_handle || '@user'),
        author_display_name: String(comment.author_display_name || 'User'),
        author_type: 'npc_public',
        content: String(comment.content || ''),
        reply_to_post_id: postId,
        sentiment: String(comment.sentiment || 'neutral'),
        virality_score: 0,
        content_flags: {},
        like_count: Math.floor(Math.random() * 5),
        reaction_summary: Math.random() < 0.5 ? ['like'] : [],
        created_at: commentTime.toISOString(),
      });

      commentCounts[postId] = (commentCounts[postId] || 0) + 1;
    }

    for (const [postId, count] of Object.entries(commentCounts)) {
      await supabaseAdmin.from('social_posts').update({ reply_count: count }).eq('id', postId);
    }

    logger.info({ sessionId, commentCount: comments.length }, 'Branded history comments seeded');
  } catch (err) {
    logger.warn({ err, sessionId }, 'Branded history comment seeding failed (non-critical)');
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
  platform: string = 'x_twitter',
  scenarioContext?: string,
  targetPlayerIds?: string[],
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

  const imagePrompt = String(post.image_prompt || '');
  const existingMedia = (post.media_urls as string[]) || [];

  const { data: inserted, error } = await supabaseAdmin
    .from('social_posts')
    .insert({
      session_id: sessionId,
      platform: String(post.platform || platform),
      author_handle: handle,
      author_display_name: displayName,
      author_type: String(post.author_type || 'npc_public'),
      content,
      hashtags: content.match(/#\w+/g) || [],
      reply_to_post_id: replyToId || null,
      sentiment: String(post.sentiment || 'neutral'),
      virality_score: Number(post.virality_score) || 0,
      content_flags: (post.content_flags as Record<string, unknown>) || {},
      media_urls: existingMedia.length > 0 ? existingMedia : [],
      like_count: 0,
      repost_count: 0,
      reply_count: 0,
      view_count: 0,
      ...(targetPlayerIds && targetPlayerIds.length > 0
        ? { target_player_ids: targetPlayerIds }
        : {}),
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

  const postEvent = {
    type: 'social_post.created',
    data: {
      post: inserted,
      ...(targetPlayerIds && targetPlayerIds.length > 0
        ? { target_player_ids: targetPlayerIds }
        : {}),
    },
    timestamp: new Date().toISOString(),
  };
  getWebSocketService().broadcastToSession(sessionId, postEvent);

  // Generate media if the AI included an image_prompt (non-blocking)
  if (imagePrompt && inserted) {
    void (async () => {
      try {
        const isVideo = /video|clip|footage|recording/i.test(imagePrompt);
        let url: string | null = null;

        if (isVideo) {
          url = await generateVideo(imagePrompt, 10, '16:9', scenarioContext);
          if (!url) url = await generateVideoThumbnail(imagePrompt);
        } else {
          url = await generatePostImage(imagePrompt, 'evidence_photo', scenarioContext);
        }

        if (url) {
          const mediaUrls = [url];
          await supabaseAdmin
            .from('social_posts')
            .update({ media_urls: mediaUrls })
            .eq('id', inserted.id);
          getWebSocketService().broadcastToSession(sessionId, {
            type: 'social_post.media_updated',
            data: { post_id: inserted.id, media_urls: mediaUrls },
            timestamp: new Date().toISOString(),
          });
          logger.info({ postId: inserted.id, isVideo }, 'NPC ambient media generated');
        }
      } catch (imgErr) {
        logger.warn({ imgErr }, 'NPC ambient media generation failed (non-critical)');
      }
    })();
  }

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
    const orgName = String(initialState.org_name || '');
    loadDesignedPersonas(initialState, sessionId);
    await assignPlayerBubbles(sessionId);
    await seedBrandedHistory(sessionId, initialState, session.start_time);

    const sentiment = await computeSessionSentiment(sessionId);
    const socialState = ((session.current_state || {}) as Record<string, unknown>).social_state as
      | Record<string, unknown>
      | undefined;

    const { data: recentPosts } = await supabaseAdmin
      .from('social_posts')
      .select('content, author_handle, sentiment')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(10);

    const recentContext = (recentPosts || [])
      .map((p) => `${String(p.author_handle)}: ${String(p.content).substring(0, 80)}`)
      .join('\n');

    // Use only key NPCs for shared posts (keeps prompt manageable)
    const keyNPCsForPrompt = getKeyNPCs(sessionId);
    const npcList = keyNPCsForPrompt
      .map(
        (n) =>
          `${n.handle} (${n.display_name}): ${n.personality || 'regular user'}, bias: ${n.bias}`,
      )
      .join('\n');

    const result = await callAI(
      `You generate realistic social media posts for a crisis simulation. Make the feed feel ALIVE.

THE CRISIS: ${String(scenario.description).substring(0, 300)}${orgName ? `\nOrganization: ${orgName}` : ''}
Current situation:
- Overall sentiment: ${socialState?.sentiment_score ?? sentiment.overall}/100
- Public trust: ${socialState?.public_trust ?? 50}/100
- Stakeholder confidence: ${socialState?.community_safety ?? 40}/100
- Narrative control: ${socialState?.narrative_control ?? 30}/100
- Escalation risk: ${socialState?.escalation_risk ?? 20}/100
- Unaddressed harmful posts: ${socialState?.unaddressed_hate_count ?? 0}
- Organized pressure/rally calls active: ${socialState?.rally_call_active ? 'YES' : 'no'}

${Number(socialState?.narrative_control ?? 30) < 30 ? 'NARRATIVE CONTROL IS LOW: Generate more hostile posts, misinformation, and damaging narratives. The response team is losing control of the conversation.' : ''}
${Number(socialState?.community_safety ?? 40) < 30 ? 'STAKEHOLDER CONFIDENCE IS LOW: Generate posts from affected stakeholders expressing fear, frustration, loss of trust, and demands for accountability.' : ''}
${Number(socialState?.escalation_risk ?? 20) > 70 ? 'ESCALATION RISK IS HIGH: Generate posts organizing collective action — boycotts, protests, petitions, regulatory complaints, or other pressure campaigns.' : ''}
${Number(socialState?.narrative_control ?? 30) > 60 ? 'NARRATIVE IS STABILIZING: Reduce hostile post frequency. More neutral and supportive voices emerging.' : ''}
Elapsed: ${elapsedMinutes}min.

${npcList ? `KNOWN USERS (use these OR create new ones):\n${npcList}\n` : ''}

Recent feed:\n${recentContext || '(empty)'}

Generate 1-2 posts from major voices. IMPORTANT: Use a DIFFERENT author for each post. These are the KEY crisis posts that ALL players will see. Focus on major developments, breaking news, or high-impact reactions.
Only crisis-related content in these shared posts.
${elapsedMinutes < 5 ? '- Early crisis: confused, alarmed, asking what happened' : ''}
${elapsedMinutes > 20 ? '- Ongoing: opinions forming, blame emerging, some calling for calm' : ''}
${sentiment.overall < 40 ? '- Sentiment critical: more fear/anger' : ''}

For 1 out of every 3 posts, include an "image_prompt" field with a short description of a photo, meme, or video the user would attach. For video content, start the description with "video clip:" or "footage:" (e.g. "footage: shaky phone recording of crowd running from train station"). Leave image_prompt as "" for text-only posts.

IMPORTANT: For each post, set "content_flags" based on the content:
- is_harmful_narrative: true if the post spreads damaging narratives (hate speech, boycott incitement, defamatory claims, scapegoating, doxxing, stock manipulation, etc.)
- is_misinformation: true if the post spreads false or unverified claims as fact
- is_inflammatory: true if the post is designed to provoke outrage, panic, or extreme reactions
- incites_violence: true if the post calls for violence, vigilante action, or physical harm
- is_organized_pressure: true if the post organizes collective action against the crisis subject (boycotts, protests, class actions, petitions, mass unsubscribes, etc.)
Leave content_flags as {} for neutral, factual, or supportive posts.

Return ONLY valid JSON:
{ "posts": [{ "author_handle": "@user", "author_display_name": "Name", "author_type": "npc_public", "content": "text", "sentiment": "neutral|negative|supportive|hateful|inflammatory", "virality_score": 5, "content_flags": {}, "image_prompt": "" }] }`,
      'Generate ambient posts.',
      1500,
    );

    const postsArray = Array.isArray(result)
      ? result
      : ((result as Record<string, unknown>)?.posts as unknown[]);
    if (!Array.isArray(postsArray)) return;

    const mediaContext = String(scenario.description || '').substring(0, 200);
    for (let i = 0; i < postsArray.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 2000 + Math.floor(Math.random() * 6000)));
      await insertPost(
        sessionId,
        postsArray[i] as Record<string, unknown>,
        undefined,
        'x_twitter',
        mediaContext,
      );
    }

    logger.info({ sessionId, count: postsArray.length, elapsedMinutes }, 'Ambient posts generated');

    // Generate 1-2 Facebook-specific ambient posts
    await generateFacebookAmbientPosts(
      sessionId,
      String(scenario.description || ''),
      elapsedMinutes,
      keyNPCsForPrompt,
      socialState,
    );

    // Generate demographic-targeted echo chamber posts (legacy)
    await generateEchoChamberPosts(sessionId, String(scenario.description || ''), elapsedMinutes);

    // Generate per-player bubble posts (round-robin 2-3 players per tick)
    await generatePlayerBubblePosts(
      sessionId,
      String(scenario.description || ''),
      elapsedMinutes,
      sentiment,
      socialState,
    );

    await simulateThreadActivity(sessionId, String(scenario.description || ''), 'x_twitter');
    await simulateThreadActivity(sessionId, String(scenario.description || ''), 'x_twitter');
    await simulateThreadActivity(sessionId, String(scenario.description || ''), 'x_twitter');
    await simulateThreadActivity(sessionId, String(scenario.description || ''), 'x_twitter');
    await simulateThreadActivity(sessionId, String(scenario.description || ''), 'x_twitter');
    await simulateThreadActivity(sessionId, String(scenario.description || ''), 'x_twitter');
    await simulateThreadActivity(sessionId, String(scenario.description || ''), 'facebook');
    await simulateThreadActivity(sessionId, String(scenario.description || ''), 'facebook');
    await simulateThreadActivity(sessionId, String(scenario.description || ''), 'facebook');
    await simulateThreadActivity(sessionId, String(scenario.description || ''), 'facebook');
    await simulateThreadActivity(sessionId, String(scenario.description || ''), 'facebook');
    await simulateThreadActivity(sessionId, String(scenario.description || ''), 'facebook');

    // Generate group activity and events
    await generateGroupActivity(
      sessionId,
      String(scenario.description || ''),
      keyNPCsForPrompt,
      socialState,
    ).catch((err) =>
      logger.warn({ err, sessionId }, 'Group activity generation failed (non-critical)'),
    );

    if (Math.random() < 0.3 || Number(socialState?.escalation_risk ?? 20) > 50) {
      await generateEventIfNeeded(sessionId, String(scenario.description || ''), socialState).catch(
        (err) => logger.warn({ err, sessionId }, 'Event generation failed (non-critical)'),
      );
    }

    // Trigger NPC DMs to players
    void triggerNPCMessages(sessionId).catch((err) =>
      logger.warn({ err, sessionId }, 'NPC DM generation failed (non-critical)'),
    );
  } catch (err) {
    logger.error({ err, sessionId }, 'Ambient content generation failed');
  }
}

// ─── Facebook Ambient Posts ──────────────────────────────────────────────────

async function generateFacebookAmbientPosts(
  sessionId: string,
  crisisDescription: string,
  elapsedMinutes: number,
  knownNPCs: RegisteredNPC[],
  socialState: Record<string, unknown> | undefined,
): Promise<void> {
  if (!env.openAiApiKey) return;

  try {
    const npcList = knownNPCs
      .map((n) => `${n.handle} (${n.display_name}): ${n.personality || 'regular user'}`)
      .join('\n');

    const result = await callAI(
      `You generate realistic FACEBOOK posts for a crisis simulation. Facebook posts are DIFFERENT from tweets:
- Longer (2-5 sentences), more personal and emotional
- No hashtags (or very few)
- Written like someone sharing with friends/family, not broadcasting
- Often start with personal reactions ("I can't believe...", "My heart goes out to...", "This is what happens when...")
- May reference Facebook Groups or community pages

THE CRISIS: ${crisisDescription.substring(0, 300)}
Sentiment: ${socialState?.sentiment_score ?? 50}/100
Elapsed: ${elapsedMinutes}min

${npcList ? `KNOWN USERS (use these OR create new ones):\n${npcList}\n` : ''}

Generate 3-5 Facebook posts. Use a DIFFERENT author for each post -- rotate through the NPC list. These should feel different from what's on Twitter. Facebook posts are longer (3-6 sentences), more personal, and more emotional.

IMPORTANT: Facebook is a very visual platform. At least 2 out of 3 posts MUST include an "image_prompt" field with a description of the image or video. For video content, start the description with "video clip:" or "footage:" (e.g. "video clip: CCTV-style overhead view of emergency responders at station entrance"). Only leave image_prompt as "" for purely text-based status updates.

For each post, set "content_flags" based on the content:
- is_harmful_narrative: true if the post spreads damaging narratives (hate speech, boycott incitement, defamatory claims, scapegoating, etc.)
- is_misinformation: true if spreading false or unverified claims
- is_inflammatory: true if designed to provoke outrage, panic, or extreme reactions
- incites_violence: true if calling for violence or vigilante action
- is_organized_pressure: true if organizing collective action (boycotts, protests, class actions, petitions, etc.)
Leave content_flags as {} for neutral/supportive posts.

Return ONLY valid JSON:
{ "posts": [{ "author_handle": "@user", "author_display_name": "Name", "author_type": "npc_public", "content": "text", "sentiment": "neutral|negative|supportive|hateful|inflammatory", "virality_score": 5, "platform": "facebook", "content_flags": {}, "image_prompt": "" }] }`,
      'Generate Facebook ambient posts.',
      1000,
    );

    const postsArray = Array.isArray(result)
      ? result
      : ((result as Record<string, unknown>)?.posts as unknown[]);
    if (!Array.isArray(postsArray)) return;

    for (let i = 0; i < postsArray.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 2000 + Math.floor(Math.random() * 4000)));
      const fbPost = postsArray[i] as Record<string, unknown>;
      fbPost.platform = 'facebook';
      await insertPost(
        sessionId,
        fbPost,
        undefined,
        'facebook',
        crisisDescription.substring(0, 200),
      );
    }

    if (postsArray.length > 0) {
      logger.info({ sessionId, count: postsArray.length }, 'Facebook ambient posts generated');
    }
  } catch (err) {
    logger.warn({ err, sessionId }, 'Facebook ambient post generation failed (non-critical)');
  }
}

// ─── Echo Chamber Posts (demographic-targeted) ──────────────────────────────

async function generateEchoChamberPosts(
  sessionId: string,
  crisisDescription: string,
  elapsedMinutes: number,
): Promise<void> {
  if (!env.openAiApiKey) return;

  try {
    const { data: participants } = await supabaseAdmin
      .from('session_participants')
      .select('demographics')
      .eq('session_id', sessionId)
      .not('demographics', 'is', null);

    if (!participants || participants.length === 0) return;

    const demographicClusters = new Map<string, Record<string, string>>();
    for (const p of participants) {
      const demo = p.demographics as Record<string, string>;
      if (!demo?.race) continue;
      const key = `${demo.race}_${demo.age_bracket || 'any'}`;
      if (!demographicClusters.has(key)) {
        demographicClusters.set(key, demo);
      }
    }

    if (demographicClusters.size === 0) return;

    // Generate 1 echo chamber post per demographic cluster (max 3)
    let count = 0;
    for (const [, demographics] of demographicClusters) {
      if (count >= 3) break;

      const result = await callAI(
        `You generate a social media post tailored for a specific demographic echo chamber during a crisis simulation. The post should feel like content this person would naturally see in their feed -- culturally specific language, references, and concerns.

Demographic: race=${demographics.race || 'any'}, age=${demographics.age_bracket || 'any'}, religion=${demographics.religion || 'any'}

Crisis: ${crisisDescription.substring(0, 200)}
Elapsed: ${elapsedMinutes} minutes

Generate 1 post that reflects what this demographic group would be saying/sharing about the crisis. It should feel organic to their social media bubble.

Return ONLY valid JSON:
{ "post": { "author_handle": "@user", "author_display_name": "Name", "author_type": "npc_public", "content": "text", "sentiment": "neutral|negative|supportive|hateful", "virality_score": 10 } }`,
        'Generate echo chamber post.',
        800,
      );

      if (result?.post) {
        const post = result.post as Record<string, unknown>;
        const echoPlatform = Math.random() < 0.4 ? 'facebook' : 'x_twitter';
        const { data: inserted, error } = await supabaseAdmin
          .from('social_posts')
          .insert({
            session_id: sessionId,
            platform: echoPlatform,
            author_handle: String(post.author_handle || '@echo_user'),
            author_display_name: String(post.author_display_name || 'User'),
            author_type: 'npc_public',
            content: String(post.content || ''),
            hashtags: String(post.content || '').match(/#\w+/g) || [],
            sentiment: String(post.sentiment || 'neutral'),
            virality_score: Number(post.virality_score) || 10,
            target_demographics: { race: demographics.race },
            like_count: 0,
            repost_count: 0,
            reply_count: 0,
            view_count: 0,
            content_flags: {},
          })
          .select()
          .single();

        if (!error && inserted) {
          getWebSocketService().broadcastToMatchingPlayers(
            sessionId,
            { race: demographics.race },
            {
              type: 'social_post.created',
              data: { post: inserted },
              timestamp: new Date().toISOString(),
            },
          );
        }
      }
      count++;
    }

    if (count > 0) {
      logger.info({ sessionId, echoChamberPosts: count }, 'Echo chamber posts generated');
    }
  } catch (err) {
    logger.warn({ err, sessionId }, 'Echo chamber post generation failed (non-critical)');
  }
}

// ─── Per-player bubble posts ────────────────────────────────────────────────

async function generatePlayerBubblePosts(
  sessionId: string,
  crisisDescription: string,
  elapsedMinutes: number,
  sentiment: { overall: number },
  socialState: Record<string, unknown> | undefined,
): Promise<void> {
  if (!env.openAiApiKey) return;

  const sessionBubbles = playerBubbles.get(sessionId);
  if (!sessionBubbles || sessionBubbles.size === 0) return;

  const playerIds = Array.from(sessionBubbles.keys());
  const cycleIdx = playerCycleIndex.get(sessionId) || 0;
  const playersPerTick = Math.min(3, playerIds.length);

  for (let i = 0; i < playersPerTick; i++) {
    const idx = (cycleIdx + i) % playerIds.length;
    const playerId = playerIds[idx];
    const bubbleNpcs = getBubbleNPCs(sessionId, playerId);
    if (bubbleNpcs.length === 0) continue;

    const npcListStr = bubbleNpcs
      .map((n) => {
        const interests = n.normal_interests?.length
          ? ` [interests: ${n.normal_interests.join(', ')}]`
          : '';
        return `${n.handle} (${n.display_name}): ${n.personality || 'regular user'}, bias: ${n.bias}${interests}`;
      })
      .join('\n');

    const normalTopics = bubbleNpcs
      .flatMap((n) => n.normal_interests || [])
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 10);

    const result = await callAI(
      `You generate social media posts for a specific player's personalized feed in a crisis simulation. These posts should feel like what this person would naturally see in their social media bubble.

THE CRISIS: ${crisisDescription.substring(0, 300)}
Elapsed: ${elapsedMinutes}min. Sentiment: ${socialState?.sentiment_score ?? sentiment.overall}/100.

NPCs IN THIS PLAYER'S BUBBLE:
${npcListStr}

CONTENT MIX — generate exactly 3 posts:
- 2 posts should be crisis-related: reactions, opinions, news sharing, demands, or commentary about the crisis. Each from a different NPC.
- 1 post should be NORMAL LIFE: an NPC posting about their regular interests (${normalTopics.join(', ')}) as if the crisis isn't the only thing happening. This makes the feed feel like real social media.

For crisis posts, set content_flags as appropriate:
- is_harmful_narrative, is_misinformation, is_inflammatory, incites_violence, is_organized_pressure
Leave content_flags as {} for neutral, supportive, or normal life posts.

Return ONLY valid JSON:
{ "posts": [{ "author_handle": "@user", "author_display_name": "Name", "author_type": "npc_public", "content": "text", "sentiment": "neutral|negative|supportive|hateful|inflammatory", "virality_score": 5, "content_flags": {}, "image_prompt": "" }] }`,
      `Generate bubble posts for player feed.`,
      1500,
      0.9,
    );

    const posts = ((result as Record<string, unknown>)?.posts as unknown[]) || [];
    if (!Array.isArray(posts)) continue;

    const platform = Math.random() < 0.6 ? 'x_twitter' : 'facebook';
    const mediaCtx = crisisDescription.substring(0, 200);

    for (const p of posts.slice(0, 3)) {
      await new Promise((r) => setTimeout(r, 1000 + Math.floor(Math.random() * 3000)));
      await insertPost(sessionId, p as Record<string, unknown>, undefined, platform, mediaCtx, [
        playerId,
      ]);
    }
  }

  playerCycleIndex.set(sessionId, cycleIdx + playersPerTick);
}

// ─── Thread simulator (NPC-to-NPC conversations) ───────────────────────────

async function simulateThreadActivity(
  sessionId: string,
  crisisDescription: string,
  platform: string = 'x_twitter',
): Promise<void> {
  const queryWith = supabaseAdmin
    .from('social_posts')
    .select('id, content, author_handle, author_display_name, reply_count, platform')
    .eq('session_id', sessionId)
    .eq('platform', platform)
    .is('reply_to_post_id', null)
    .gt('reply_count', 0)
    .order('reply_count', { ascending: false })
    .limit(5);

  const queryWithout = supabaseAdmin
    .from('social_posts')
    .select('id, content, author_handle, author_display_name, reply_count, platform')
    .eq('session_id', sessionId)
    .eq('platform', platform)
    .is('reply_to_post_id', null)
    .eq('reply_count', 0)
    .order('created_at', { ascending: false })
    .limit(5);

  const recentCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const queryRecent = supabaseAdmin
    .from('social_posts')
    .select('id, content, author_handle, author_display_name, reply_count, platform')
    .eq('session_id', sessionId)
    .eq('platform', platform)
    .is('reply_to_post_id', null)
    .gte('created_at', recentCutoff)
    .lt('reply_count', 5)
    .order('created_at', { ascending: false })
    .limit(3);

  const [{ data: postsWithReplies }, { data: postsWithoutReplies }, { data: recentPosts }] =
    await Promise.all([queryWith, queryWithout, queryRecent]);

  const seenIds = new Set<string>();
  const candidates = [
    ...(recentPosts || []),
    ...(postsWithReplies || []),
    ...(postsWithoutReplies || []),
  ].filter((p) => {
    if (seenIds.has(p.id as string)) return false;
    seenIds.add(p.id as string);
    return true;
  });
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
    `ORIGINAL POST [${targetPost.id}] by ${String(targetPost.author_handle)}: "${String(targetPost.content).substring(0, 200)}"`,
    ...(existingReplies || []).map(
      (r) =>
        `  REPLY [${r.id}] by ${String(r.author_handle)}: "${String(r.content).substring(0, 150)}"`,
    ),
  ].join('\n');

  const participantList = Array.from(threadParticipants.entries())
    .map(([handle, name]) => {
      const reg = getRegistry(sessionId).get(handle);
      return `${handle} (${name})${reg?.personality ? `: ${reg.personality}` : ''}${reg?.bias && reg.bias !== 'none' ? `, bias: ${reg.bias}` : ''}`;
    })
    .join('\n');

  const knownNPCs = getRegisteredNPCs(sessionId)
    .filter((n) => !threadParticipants.has(n.handle))
    .map((n) => `${n.handle} (${n.display_name}): ${n.personality}`)
    .join('\n');

  const isNormalLifePost = !/crisis|recall|scandal|outbreak|incident|emergency|breaking/i.test(
    String(targetPost.content),
  );

  const result = await callAI(
    `You are simulating a social media comment thread during a crisis simulation.

THREAD SO FAR:
${threadContext}

USERS ALREADY IN THIS THREAD:
${participantList}

${knownNPCs ? `OTHER KNOWN USERS WHO COULD JOIN:\n${knownNPCs}\n` : ''}

Generate 3-5 new replies to continue this thread. Rules:
- 70% chance: pick someone ALREADY in the thread to reply again (stay in character!)
- 30% chance: introduce ONE new commenter (either from known users or create a new one)
- If a user is already in the thread, you MUST use their EXACT handle and display name
- Replies can be to the original post OR to another reply
- Characters should stay consistent with their personality and bias
- Make it feel like a real argument/discussion -- people interrupt each other, quote each other, get emotional
- 1-2 sentences per reply
${isNormalLifePost ? '- This is a NORMAL LIFE post (not crisis-related). Keep comments casual and on-topic (e.g. food opinions, sports banter, daily life chatter).' : ''}

THREADING FORMAT:
- When replying to the ORIGINAL POST, just write the reply text normally
- When replying to ANOTHER REPLY in the thread, start your reply with: @their_handle[their_reply_id] your reply text
- Use the exact reply IDs from the thread above

Crisis context: ${crisisDescription.substring(0, 200)}

Return ONLY valid JSON:
{ "replies": [{ "author_handle": "@exact_handle", "author_display_name": "Exact Name", "content": "reply text", "sentiment": "neutral|negative|supportive|hateful" }] }`,
    'Continue the thread conversation.',
    1000,
  );

  const replies = (result?.replies as Array<Record<string, unknown>>) || [];

  for (let i = 0; i < replies.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 500 + Math.floor(Math.random() * 1500)));
    const reply = replies[i];
    await insertPost(
      sessionId,
      reply,
      targetPost.id as string,
      platform,
      crisisDescription.substring(0, 200),
    );
  }

  if (replies.length > 0) {
    logger.info(
      { sessionId, postId: targetPost.id, newReplies: replies.length, platform },
      'Thread activity simulated',
    );
  }
}

// ─── Consequence Inject Generator ───────────────────────────────────────────

const consequenceCooldowns = new Map<string, Map<string, number>>();

function isOnCooldown(sessionId: string, triggerId: string, cooldownMs = 300000): boolean {
  const sessionCooldowns = consequenceCooldowns.get(sessionId);
  if (!sessionCooldowns) return false;
  const lastFired = sessionCooldowns.get(triggerId);
  if (!lastFired) return false;
  return Date.now() - lastFired < cooldownMs;
}

function setCooldown(sessionId: string, triggerId: string): void {
  if (!consequenceCooldowns.has(sessionId)) {
    consequenceCooldowns.set(sessionId, new Map());
  }
  consequenceCooldowns.get(sessionId)!.set(triggerId, Date.now());
}

export async function generateConsequenceInject(
  sessionId: string,
  triggerId: string,
  description: string,
  sentiment: string,
  isPositive: boolean,
): Promise<void> {
  if (!env.openAiApiKey) return;
  if (isOnCooldown(sessionId, triggerId)) return;

  setCooldown(sessionId, triggerId);

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
          {
            role: 'system',
            content: `Generate a single realistic social media post that serves as an organic consequence in a crisis simulation. The post should feel natural -- like a real person reacting to the situation. Keep it 1-3 sentences. Do NOT mention that this is a simulation.

Return ONLY valid JSON: { "author_handle": "@handle", "author_display_name": "Name", "content": "post text", "author_type": "npc_public|npc_media" }`,
          },
          { role: 'user', content: description },
        ],
        temperature: 0.8,
        max_completion_tokens: 500,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) return;

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return;

    const post = JSON.parse(content);

    await new Promise((r) => setTimeout(r, 2000 + Math.floor(Math.random() * 4000)));

    const consequencePlatform = Math.random() < 0.3 ? 'facebook' : 'x_twitter';
    const { data: inserted, error } = await supabaseAdmin
      .from('social_posts')
      .insert({
        session_id: sessionId,
        platform: consequencePlatform,
        author_handle: post.author_handle || '@consequence_npc',
        author_display_name: post.author_display_name || 'Observer',
        author_type: post.author_type || 'npc_public',
        content: post.content,
        hashtags: (post.content as string).match(/#\w+/g) || [],
        sentiment: sentiment,
        like_count: 0,
        repost_count: 0,
        reply_count: 0,
        view_count: 0,
        content_flags: {},
        virality_score: isPositive ? 40 : 60,
      })
      .select()
      .single();

    if (!error && inserted) {
      getWebSocketService().broadcastToSession(sessionId, {
        type: 'social_post.created',
        data: { post: inserted },
        timestamp: new Date().toISOString(),
      });

      await supabaseAdmin.from('session_events').insert({
        session_id: sessionId,
        event_type: 'consequence_inject',
        description: `Consequence: ${triggerId} - ${isPositive ? 'positive' : 'negative'}`,
        metadata: {
          trigger_id: triggerId,
          is_positive: isPositive,
          post_id: inserted.id,
          post_content: post.content,
          consequence_description: description,
        },
      });

      logger.info(
        { sessionId, triggerId, isPositive, postId: inserted.id },
        'Consequence inject fired',
      );
    }
  } catch (err) {
    logger.warn({ err, sessionId, triggerId }, 'Consequence inject generation failed');
  }
}

// ─── Group Activity Generation ───────────────────────────────────────────────

async function generateGroupActivity(
  sessionId: string,
  crisisDescription: string,
  knownNPCs: RegisteredNPC[],
  socialState: Record<string, unknown> | undefined,
): Promise<void> {
  if (!env.openAiApiKey) return;

  const { data: groups } = await supabaseAdmin
    .from('sim_groups')
    .select('id, name, group_type, member_count')
    .eq('session_id', sessionId);

  if (!groups || groups.length === 0) {
    await initializeGroups(sessionId, crisisDescription);
    return;
  }

  const targetGroup = groups[Math.floor(Math.random() * groups.length)];

  const { data: recentPosts } = await supabaseAdmin
    .from('sim_group_posts')
    .select('content, author_handle')
    .eq('group_id', targetGroup.id)
    .order('created_at', { ascending: false })
    .limit(5);

  const recentContext = (recentPosts || [])
    .map((p) => `${p.author_handle}: "${String(p.content).substring(0, 80)}"`)
    .join('\n');

  const npcList = knownNPCs
    .slice(0, 8)
    .map((n) => `${n.handle} (${n.display_name}): ${n.personality}`)
    .join('\n');

  const result = await callAI(
    `You generate posts for a Facebook GROUP during a crisis simulation.

GROUP: "${targetGroup.name}" (${targetGroup.group_type}, ${targetGroup.member_count} members)
CRISIS: ${crisisDescription.substring(0, 200)}
Escalation risk: ${Number(socialState?.escalation_risk ?? 20)}/100
Narrative control: ${Number(socialState?.narrative_control ?? 30)}/100

KNOWN NPCs:\n${npcList}

${recentContext ? `RECENT POSTS IN GROUP:\n${recentContext}\n` : 'This group has no posts yet. Start the conversation.'}

Generate 1-2 posts that members would write in this group. Make them feel authentic to the group type and the specific crisis described above:
- community: concerned stakeholders, sharing info, asking questions
- religious: community support, solidarity, mutual aid
- neighborhood: safety concerns, local coordination, updates
- activism: calls to action, organizing, sharing evidence, pressure campaigns
- official: announcements, verified information, official guidance

Return ONLY valid JSON:
{ "posts": [{ "author_handle": "@handle", "author_display_name": "Name", "author_type": "npc_public", "content": "post text" }] }`,
    'Generate group posts.',
    800,
  );

  const posts = (result?.posts as Array<Record<string, unknown>>) || [];

  for (const post of posts.slice(0, 2)) {
    const { error } = await supabaseAdmin.from('sim_group_posts').insert({
      group_id: targetGroup.id,
      session_id: sessionId,
      author_handle: String(post.author_handle || '@group_member'),
      author_display_name: String(post.author_display_name || 'Group Member'),
      author_type: String(post.author_type || 'npc_public'),
      content: String(post.content || ''),
      media_urls: [],
      like_count: Math.floor(Math.random() * 5),
      reply_count: 0,
    });

    if (error) {
      logger.warn({ error }, 'Failed to insert group post');
    }
  }

  if (posts.length > 0) {
    getWebSocketService().broadcastToSession(sessionId, {
      type: 'group_post.created',
      data: { group_id: targetGroup.id, count: posts.length },
      timestamp: new Date().toISOString(),
    });
    logger.info(
      { sessionId, groupId: targetGroup.id, count: posts.length },
      'Group activity generated',
    );
  }
}

async function initializeGroups(sessionId: string, crisisDescription: string): Promise<void> {
  if (!env.openAiApiKey) return;

  const result = await callAI(
    `Create 3-4 Facebook groups that would exist in a community experiencing this crisis:

CRISIS: ${crisisDescription.substring(0, 300)}

Generate community groups relevant to this scenario. Each group should serve a different purpose.

Return ONLY valid JSON:
{ "groups": [{ "name": "Group Name", "description": "Brief description", "group_type": "community|religious|neighborhood|activism|official", "member_count": 500 }] }`,
    'Create initial Facebook groups for the simulation.',
    600,
  );

  const groups = (result?.groups as Array<Record<string, unknown>>) || [];

  for (const group of groups.slice(0, 4)) {
    await supabaseAdmin.from('sim_groups').insert({
      session_id: sessionId,
      name: String(group.name || 'Community Group'),
      description: String(group.description || ''),
      group_type: String(group.group_type || 'community'),
      member_count: Number(group.member_count) || 200 + Math.floor(Math.random() * 1000),
      is_private: false,
      admin_handles: [],
      platform: 'facebook',
    });
  }

  if (groups.length > 0) {
    logger.info({ sessionId, count: groups.length }, 'Initialized Facebook groups');
  }
}

// ─── Event Generation ────────────────────────────────────────────────────────

async function generateEventIfNeeded(
  sessionId: string,
  crisisDescription: string,
  socialState: Record<string, unknown> | undefined,
): Promise<void> {
  if (!env.openAiApiKey) return;

  const { data: existingEvents } = await supabaseAdmin
    .from('sim_events')
    .select('id')
    .eq('session_id', sessionId);

  if ((existingEvents || []).length >= 5) return;

  const escalation = Number(socialState?.escalation_risk ?? 20);
  const narrative = Number(socialState?.narrative_control ?? 30);

  let eventContext = '';
  if (escalation > 60) {
    eventContext = 'The community is highly agitated. Generate a protest or safety patrol event.';
  } else if (narrative > 60) {
    eventContext =
      'The situation is stabilizing. Generate a solidarity or community meeting event.';
  } else {
    eventContext =
      'Generate an appropriate community event (vigil, meeting, or solidarity gathering).';
  }

  const result = await callAI(
    `Create a Facebook Event for a community during this crisis:

CRISIS: ${crisisDescription.substring(0, 200)}
${eventContext}

Event types: protest, vigil, community_meeting, safety_patrol, solidarity

Return ONLY valid JSON:
{ "event": { "title": "Event Title", "description": "What this event is about", "event_type": "protest|vigil|community_meeting|safety_patrol|solidarity", "location": "Location name", "event_date": "Tonight 8pm or Tomorrow 2pm etc", "organizer_handle": "@handle", "organizer_display_name": "Name", "organizer_type": "npc_public" } }`,
    'Create a Facebook event.',
    500,
  );

  const event = result?.event as Record<string, unknown> | undefined;
  if (!event) return;

  const { data: inserted, error } = await supabaseAdmin
    .from('sim_events')
    .insert({
      session_id: sessionId,
      title: String(event.title || 'Community Event'),
      description: String(event.description || ''),
      event_type: String(event.event_type || 'community_meeting'),
      location: String(event.location || 'TBD'),
      event_date: String(event.event_date || 'Soon'),
      organizer_handle: String(event.organizer_handle || '@organizer'),
      organizer_display_name: String(event.organizer_display_name || 'Community Organizer'),
      organizer_type: String(event.organizer_type || 'npc_public'),
      interested_count: Math.floor(Math.random() * 50) + 10,
      going_count: Math.floor(Math.random() * 20) + 5,
      platform: 'facebook',
    })
    .select()
    .single();

  if (error) {
    logger.warn({ error }, 'Failed to create event');
    return;
  }

  if (inserted) {
    getWebSocketService().broadcastToSession(sessionId, {
      type: 'event.created',
      data: { event: inserted },
      timestamp: new Date().toISOString(),
    });
    logger.info({ sessionId, eventId: inserted.id, type: event.event_type }, 'Event created');
  }
}
