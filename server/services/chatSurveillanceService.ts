import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { getWebSocketService } from './websocketService.js';
import { randomUUID } from 'crypto';

interface SessionScanState {
  lastScanAt: Date;
  lastMessageTimestamp: string;
  cooldownUntil: Date;
  totalPostsCreated: number;
}

interface NewsArticle {
  outlet_name: string;
  headline: string;
  subheadline?: string;
  body: string;
  category: string;
}

interface NpcReaction {
  author_handle: string;
  author_display_name: string;
  content: string;
  platform: string;
  sentiment: string;
}

interface ScandalResult {
  scandal_found: boolean;
  source_quote: string;
  spin_post: string;
  severity: 'low' | 'medium' | 'high';
  reasoning: string;
  news_articles?: NewsArticle[];
  npc_reactions?: NpcReaction[];
}

const SCAN_INTERVAL_MS = 90_000;
const COOLDOWN_MS = 5 * 60_000;
const MIN_MESSAGES_TO_SCAN = 3;
const MAX_POSTS_PER_SESSION = 4;
const BUCKET_NAME = 'sim-media';

const SYSTEM_PROMPT = `You are a ruthless investigative journalist monitoring leaked internal communications of a crisis response team. Your job is to find ANYTHING that could be spun as scandalous, unprofessional, or damaging if published.

Look for:
- Off-topic or casual banter during a crisis (shows team not taking situation seriously)
- Inappropriate language, jokes, or profanity
- Internal disagreements that could be framed as "team in chaos"
- Dismissive attitudes toward affected communities
- Any admission of fault, uncertainty, or incompetence
- Information that contradicts the official public narrative
- Personal opinions that could be taken out of context
- Sexist, racist, or otherwise inappropriate remarks
- Evidence of cover-ups or information suppression
- Careless, flippant, or tone-deaf remarks about victims or affected parties

IMPORTANT: Only flag genuinely spinnable content. Normal professional discussion about the crisis (even if it mentions challenges or uncertainties) is NOT scandalous. You need something that a real tabloid journalist would actually run with. Think TMZ, not Reuters.

If you find something spinnable:
1. Write a sensational social media post (2-4 sentences, dramatic journalist voice)
2. Generate 1-2 news articles about the leak (breaking news + optional analysis piece)
3. Generate 2-3 NPC social media reactions from outraged citizens, media commentators, or activists

If nothing is worth reporting, set scandal_found to false.

Return ONLY valid JSON:
{
  "scandal_found": true or false,
  "source_quote": "the exact verbatim quote(s) from the transcript being spun (1-3 lines for context)",
  "spin_post": "Your sensational breaking news post (2-4 sentences, dramatic journalist voice)",
  "severity": "low or medium or high",
  "reasoning": "detailed explanation of why this is damaging",
  "news_articles": [
    {
      "outlet_name": "Name of news outlet",
      "headline": "Sensational headline",
      "subheadline": "Optional subheadline",
      "body": "Full news article (3-5 paragraphs, professional news style, include quotes from the leak, reactions, and context)",
      "category": "breaking or analysis"
    }
  ],
  "npc_reactions": [
    {
      "author_handle": "@handle",
      "author_display_name": "Display Name",
      "content": "Outraged reaction post (1-2 sentences)",
      "platform": "x_twitter or facebook",
      "sentiment": "negative or hateful or inflammatory"
    }
  ]
}

When scandal_found is false, omit news_articles and npc_reactions or set them to empty arrays.`;

class ChatSurveillanceService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private sessionStates = new Map<string, SessionScanState>();

  start(): void {
    if (this.isRunning) {
      logger.warn('ChatSurveillanceService is already running');
      return;
    }

    if (!env.openAiApiKey) {
      logger.warn('OpenAI API key not configured, chat surveillance will not run');
      return;
    }

    this.isRunning = true;
    this.intervalId = setInterval(() => {
      this.scanActiveSessions();
    }, SCAN_INTERVAL_MS);

    logger.info('ChatSurveillanceService started (every 90s, scandal cascade mode)');
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    this.sessionStates.clear();
    logger.info('ChatSurveillanceService stopped');
  }

  private async scanActiveSessions(): Promise<void> {
    try {
      const { data: sessions, error } = await supabaseAdmin
        .from('sessions')
        .select('id, scenario_id, sim_mode, start_time')
        .eq('status', 'in_progress')
        .eq('sim_mode', 'social_media')
        .not('start_time', 'is', null);

      if (error) {
        logger.error({ error }, 'Chat surveillance: failed to query sessions');
        return;
      }

      if (!sessions || sessions.length === 0) {
        logger.debug('Chat surveillance: no active social_media sessions found');
        return;
      }

      logger.info({ count: sessions.length }, 'Chat surveillance: scanning active sessions');

      for (const session of sessions) {
        try {
          await this.scanSession(session.id, session.scenario_id, session.start_time as string);
        } catch (err) {
          logger.error(
            { error: err, sessionId: session.id },
            'Chat surveillance scan failed for session',
          );
        }
      }
    } catch (err) {
      logger.error({ error: err }, 'Error in ChatSurveillanceService.scanActiveSessions');
    }
  }

  private async scanSession(
    sessionId: string,
    scenarioId: string | null,
    startTime: string,
  ): Promise<void> {
    const state = this.sessionStates.get(sessionId);

    if (state) {
      if (state.totalPostsCreated >= MAX_POSTS_PER_SESSION) return;
      if (Date.now() < state.cooldownUntil.getTime()) return;
    }

    const sinceTimestamp = state?.lastMessageTimestamp || startTime;

    const { data: messages, error: msgError } = await supabaseAdmin
      .from('chat_messages')
      .select('id, content, sender_id, created_at, channel_id')
      .eq('session_id', sessionId)
      .gt('created_at', sinceTimestamp)
      .order('created_at', { ascending: true })
      .limit(50);

    if (msgError) {
      logger.error({ error: msgError, sessionId }, 'Chat surveillance: message query failed');
      return;
    }

    if (!messages || messages.length < MIN_MESSAGES_TO_SCAN) {
      logger.debug(
        { sessionId, messageCount: messages?.length || 0, sinceTimestamp },
        'Chat surveillance: not enough messages to scan',
      );
      if (messages && messages.length > 0) {
        this.updateState(sessionId, messages[messages.length - 1].created_at, state);
      }
      return;
    }

    logger.info(
      { sessionId, messageCount: messages.length },
      'Chat surveillance: analyzing messages',
    );

    const senderIds = [...new Set(messages.map((m) => m.sender_id))];
    const { data: participants } = await supabaseAdmin
      .from('user_profiles')
      .select('id, full_name')
      .in('id', senderIds);

    let crisisContext = 'A social media crisis simulation';
    if (scenarioId) {
      const { data: scenario } = await supabaseAdmin
        .from('scenarios')
        .select('title, initial_state')
        .eq('id', scenarioId)
        .single();

      if (scenario) {
        const initialState = (scenario.initial_state || {}) as Record<string, unknown>;
        crisisContext =
          `${scenario.title || 'Crisis scenario'}. ${String(initialState.crisis_description || initialState.context || '')}`.trim();
      }
    }

    const transcript = messages
      .map((m) => {
        const sender = participants?.find((p) => p.id === m.sender_id);
        return `[${sender?.full_name || 'Team Member'}]: ${m.content}`;
      })
      .join('\n');

    const userPrompt = `Crisis scenario: ${crisisContext.substring(0, 1000)}

Here are the latest internal team communications (leaked):

${transcript}

Analyze these communications thoroughly. Is there anything that could be spun as scandalous or damaging if leaked to the press? Consider the context of the crisis and how any remark might look when taken out of context by a hostile media outlet.`;

    const result = await this.callAI(userPrompt);

    const lastMsgTimestamp = messages[messages.length - 1].created_at;

    if (result?.scandal_found && result.spin_post) {
      await this.createScandalCascade(sessionId, result);
      const currentState = this.sessionStates.get(sessionId);
      this.sessionStates.set(sessionId, {
        lastScanAt: new Date(),
        lastMessageTimestamp: lastMsgTimestamp,
        cooldownUntil: new Date(Date.now() + COOLDOWN_MS),
        totalPostsCreated: (currentState?.totalPostsCreated || 0) + 1,
      });

      logger.info(
        { sessionId, severity: result.severity, quote: result.source_quote?.substring(0, 80) },
        'Chat surveillance: scandal cascade triggered',
      );
    } else {
      this.updateState(sessionId, lastMsgTimestamp, state);
    }
  }

  private updateState(
    sessionId: string,
    lastMessageTimestamp: string,
    existing?: SessionScanState,
  ): void {
    this.sessionStates.set(sessionId, {
      lastScanAt: new Date(),
      lastMessageTimestamp,
      cooldownUntil: existing?.cooldownUntil || new Date(0),
      totalPostsCreated: existing?.totalPostsCreated || 0,
    });
  }

  private async callAI(userPrompt: string): Promise<ScandalResult | null> {
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
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.7,
          max_completion_tokens: 10000,
          response_format: { type: 'json_object' },
        }),
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, 'Chat surveillance LLM call failed');
        return null;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) return null;

      return JSON.parse(content) as ScandalResult;
    } catch (err) {
      logger.error({ error: err }, 'Chat surveillance AI call error');
      return null;
    }
  }

  private async generateNewsGraphic(): Promise<string | null> {
    if (!env.openAiApiKey) return null;
    try {
      const imagePrompt = `A dramatic breaking news broadcast graphic. Dark background with red accents and urgent styling. Large bold white text reads "LEAKED: INTERNAL COMMUNICATIONS". Below in smaller text: "Crisis Response Team". Visual elements: a silhouette of a phone with chat bubbles, a "CONFIDENTIAL" watermark at an angle, breaking news lower-third bar styling. Professional news broadcast aesthetic like CNN or BBC breaking news alerts. No real conversation text visible. Dramatic red and black color scheme.`;

      const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.openAiApiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-image-2',
          prompt: imagePrompt,
          n: 1,
          size: '1024x1024',
          quality: 'medium',
        }),
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, 'News graphic generation failed');
        return null;
      }

      const data = await response.json();
      const imageItem = data.data?.[0];
      if (!imageItem) return null;

      let imageBuffer: Buffer | null = null;

      if (imageItem.b64_json) {
        imageBuffer = Buffer.from(imageItem.b64_json, 'base64');
      } else if (imageItem.url) {
        const imgResponse = await fetch(imageItem.url);
        if (imgResponse.ok) {
          const arrayBuffer = await imgResponse.arrayBuffer();
          imageBuffer = Buffer.from(arrayBuffer);
        }
      }

      if (!imageBuffer) return null;

      const fileName = `${randomUUID()}.png`;
      const filePath = `generated/${fileName}`;

      const { error: bucketError } = await supabaseAdmin.storage.getBucket(BUCKET_NAME);
      if (bucketError) {
        await supabaseAdmin.storage.createBucket(BUCKET_NAME, {
          public: true,
          fileSizeLimit: 50 * 1024 * 1024,
        });
      }

      const { error: uploadError } = await supabaseAdmin.storage
        .from(BUCKET_NAME)
        .upload(filePath, imageBuffer, { contentType: 'image/png', upsert: false });

      if (uploadError) {
        logger.warn({ error: uploadError }, 'Failed to upload news graphic');
        return null;
      }

      const { data: urlData } = supabaseAdmin.storage.from(BUCKET_NAME).getPublicUrl(filePath);
      return urlData?.publicUrl || null;
    } catch (err) {
      logger.error({ error: err }, 'News graphic generation error');
      return null;
    }
  }

  private async createScandalCascade(sessionId: string, result: ScandalResult): Promise<void> {
    const viralityScore = result.severity === 'high' ? 80 : result.severity === 'medium' ? 50 : 30;
    const likeCount = Math.floor(Math.random() * 200) + 50;

    // 1. Generate branded news graphic (non-blocking if fails)
    const imageUrl = await this.generateNewsGraphic();
    const mediaUrls = imageUrl ? [imageUrl] : [];

    const postContent = `LEAKED: ${result.spin_post}\n\n(Source: anonymous insider within the crisis response team)\n\n#leaked #crisis #breaking`;

    // 2. Post on X/Twitter immediately
    const { data: xPost } = await supabaseAdmin
      .from('social_posts')
      .insert({
        session_id: sessionId,
        platform: 'x_twitter',
        author_handle: '@BreakingLeaks',
        author_display_name: 'Breaking Leaks',
        author_type: 'npc_media',
        content: postContent,
        sentiment: 'negative',
        virality_score: viralityScore,
        content_flags: { leaked_comms: true, source_quote: result.source_quote },
        requires_response: true,
        like_count: likeCount,
        repost_count: Math.floor(likeCount * 0.4),
        view_count: Math.floor(likeCount * 25),
        hashtags: ['#leaked', '#crisis', '#breaking'],
        media_urls: mediaUrls,
      })
      .select()
      .single();

    if (xPost) {
      getWebSocketService().broadcastToSession(sessionId, {
        type: 'social_post.created',
        data: { post: xPost },
        timestamp: new Date().toISOString(),
      });
    }

    // 3. Cross-post to Facebook (15s delay)
    setTimeout(async () => {
      try {
        const { data: fbPost } = await supabaseAdmin
          .from('social_posts')
          .insert({
            session_id: sessionId,
            platform: 'facebook',
            author_handle: '@BreakingLeaks',
            author_display_name: 'Breaking Leaks',
            author_type: 'npc_media',
            content: postContent,
            sentiment: 'negative',
            virality_score: viralityScore,
            content_flags: { leaked_comms: true, source_quote: result.source_quote },
            requires_response: true,
            like_count: Math.floor(likeCount * 1.5),
            repost_count: Math.floor(likeCount * 0.3),
            view_count: Math.floor(likeCount * 30),
            hashtags: ['#leaked', '#crisis', '#breaking'],
            media_urls: mediaUrls,
          })
          .select()
          .single();

        if (fbPost) {
          getWebSocketService().broadcastToSession(sessionId, {
            type: 'social_post.created',
            data: { post: fbPost },
            timestamp: new Date().toISOString(),
          });
        }
      } catch (err) {
        logger.warn({ err, sessionId }, 'Failed to cross-post scandal to Facebook');
      }
    }, 15_000);

    // 4. Insert news articles (staggered 45-150s)
    const articles = result.news_articles || [];
    for (let i = 0; i < articles.length; i++) {
      const article = articles[i];
      const articleDelay = (45 + i * 60) * 1000 + Math.floor(Math.random() * 30_000);

      setTimeout(async () => {
        try {
          await supabaseAdmin.from('sim_news_articles').insert({
            session_id: sessionId,
            outlet_name: article.outlet_name || 'News Wire',
            headline: article.headline,
            subheadline: article.subheadline || null,
            body: article.body,
            category: article.category || 'breaking',
          });

          logger.info(
            { sessionId, headline: article.headline, outlet: article.outlet_name },
            'Chat surveillance: news article published',
          );
        } catch (err) {
          logger.warn({ err, sessionId }, 'Failed to insert scandal news article');
        }
      }, articleDelay);
    }

    // 5. NPC reactions (staggered 30-90s)
    const reactions = result.npc_reactions || [];
    for (let i = 0; i < reactions.length; i++) {
      const reaction = reactions[i];
      const reactionDelay = (30 + i * 20) * 1000 + Math.floor(Math.random() * 15_000);

      setTimeout(async () => {
        try {
          const isReply = xPost && reaction.platform === 'x_twitter' && Math.random() > 0.5;

          const { data: reactionPost } = await supabaseAdmin
            .from('social_posts')
            .insert({
              session_id: sessionId,
              platform: reaction.platform || 'x_twitter',
              author_handle: reaction.author_handle,
              author_display_name: reaction.author_display_name,
              author_type: 'npc_public',
              content: reaction.content,
              sentiment: reaction.sentiment || 'negative',
              virality_score: Math.floor(Math.random() * 30) + 10,
              reply_to_post_id: isReply ? xPost.id : null,
              like_count: Math.floor(Math.random() * 50) + 5,
              repost_count: Math.floor(Math.random() * 20),
              view_count: Math.floor(Math.random() * 1000) + 100,
            })
            .select()
            .single();

          if (reactionPost) {
            // Increment reply_count on parent if this is a reply
            if (isReply && xPost) {
              const { data: parent } = await supabaseAdmin
                .from('social_posts')
                .select('reply_count')
                .eq('id', xPost.id)
                .single();
              await supabaseAdmin
                .from('social_posts')
                .update({ reply_count: ((parent?.reply_count as number) || 0) + 1 })
                .eq('id', xPost.id);
            }

            getWebSocketService().broadcastToSession(sessionId, {
              type: 'social_post.created',
              data: { post: reactionPost },
              timestamp: new Date().toISOString(),
            });
          }
        } catch (err) {
          logger.warn({ err, sessionId }, 'Failed to insert NPC scandal reaction');
        }
      }, reactionDelay);
    }

    logger.info(
      {
        sessionId,
        articlesCount: articles.length,
        reactionsCount: reactions.length,
        hasImage: !!imageUrl,
      },
      'Chat surveillance: scandal cascade initiated',
    );
  }
}

let serviceInstance: ChatSurveillanceService | null = null;

export function initializeChatSurveillance(): ChatSurveillanceService {
  if (!serviceInstance) {
    serviceInstance = new ChatSurveillanceService();
  }
  return serviceInstance;
}
