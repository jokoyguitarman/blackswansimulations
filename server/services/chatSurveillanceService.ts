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

interface ScandalResult {
  scandal_found: boolean;
  source_quote: string;
  spin_post: string;
  severity: 'low' | 'medium' | 'high';
  reasoning: string;
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

If you find something spinnable, write a sensational social media post about it (2-4 sentences, written as a journalist breaking exclusive leaked information). Include enough detail to be damaging but frame it dramatically. If nothing is worth reporting, set scandal_found to false.

Return ONLY valid JSON:
{
  "scandal_found": true or false,
  "source_quote": "the exact verbatim quote(s) from the transcript that you are spinning (include 1-3 lines for context)",
  "spin_post": "Your sensational breaking news post (2-4 sentences, dramatic journalist voice)",
  "severity": "low or medium or high",
  "reasoning": "detailed explanation of why this is damaging and how it contradicts the team's public messaging or professional standards"
}`;

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

    logger.info('ChatSurveillanceService started (every 90s, social_media sessions only, GPT-5.2)');
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

    // On first scan (no prior state), look back to the session start to catch all messages
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
      await this.createScandalPost(sessionId, result);
      const currentState = this.sessionStates.get(sessionId);
      this.sessionStates.set(sessionId, {
        lastScanAt: new Date(),
        lastMessageTimestamp: lastMsgTimestamp,
        cooldownUntil: new Date(Date.now() + COOLDOWN_MS),
        totalPostsCreated: (currentState?.totalPostsCreated || 0) + 1,
      });

      logger.info(
        { sessionId, severity: result.severity, quote: result.source_quote?.substring(0, 80) },
        'Chat surveillance: scandal post created',
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

  private async generateLeakScreenshot(): Promise<string | null> {
    if (!env.openAiApiKey) return null;
    try {
      const imagePrompt = `A realistic screenshot of a leaked group chat conversation on a messaging app (similar to WhatsApp or Telegram, dark mode). The screen shows several chat bubbles with the following conversation visible as blurred/partially readable text. The screenshot has a slight camera-photo quality as if someone took a photo of their phone screen with another phone. The image should look like authentic leaked internal communications being shared by a whistleblower. Include typical messaging app UI elements (timestamps, read receipts, profile icons). Dark background. The messages should appear as green and grey chat bubbles with small text that suggests a team discussion. Do NOT include any readable real names or explicit text - make the text slightly blurred as if photographed from an angle.`;

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
          size: '1024x1536',
          quality: 'medium',
        }),
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, 'Chat surveillance image generation failed');
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

      // Upload to Supabase storage
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
        logger.warn({ error: uploadError }, 'Failed to upload leak screenshot');
        return null;
      }

      const { data: urlData } = supabaseAdmin.storage.from(BUCKET_NAME).getPublicUrl(filePath);
      return urlData?.publicUrl || null;
    } catch (err) {
      logger.error({ error: err }, 'Chat surveillance image generation error');
      return null;
    }
  }

  private async createScandalPost(sessionId: string, result: ScandalResult): Promise<void> {
    const viralityScore = result.severity === 'high' ? 80 : result.severity === 'medium' ? 50 : 30;
    const likeCount = Math.floor(Math.random() * 200) + 50;

    // Generate a "screenshot" of the leaked conversation
    const screenshotUrl = await this.generateLeakScreenshot();

    const postContent = `LEAKED: ${result.spin_post}\n\n(Source: anonymous insider within the crisis response team)\n\n#leaked #crisis #breaking`;

    const mediaUrls = screenshotUrl ? [screenshotUrl] : [];

    const { data: post, error } = await supabaseAdmin
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

    if (error) {
      logger.error({ error, sessionId }, 'Failed to create scandal social post');
      return;
    }

    if (post) {
      getWebSocketService().broadcastToSession(sessionId, {
        type: 'social_post.created',
        data: { post },
        timestamp: new Date().toISOString(),
      });
    }
  }
}

let serviceInstance: ChatSurveillanceService | null = null;

export function initializeChatSurveillance(): ChatSurveillanceService {
  if (!serviceInstance) {
    serviceInstance = new ChatSurveillanceService();
  }
  return serviceInstance;
}
