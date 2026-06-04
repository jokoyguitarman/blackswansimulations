import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { getWebSocketService } from './websocketService.js';

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

IMPORTANT: Only flag genuinely spinnable content. Normal professional discussion about the crisis (even if it mentions challenges or uncertainties) is NOT scandalous. You need something that a real tabloid journalist would actually run with.

If you find something spinnable, write a sensational social media post about it (1-3 sentences, written as a journalist breaking news). If nothing is worth reporting, set scandal_found to false.

Return ONLY valid JSON:
{
  "scandal_found": true or false,
  "source_quote": "the exact quote or paraphrase being spun (empty string if none)",
  "spin_post": "The sensational post text (empty string if none)",
  "severity": "low or medium or high",
  "reasoning": "brief note on why this is spinnable (empty string if none)"
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

    logger.info('ChatSurveillanceService started (every 90s, social_media sessions only)');
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
        .select('id, scenario_id, sim_mode')
        .eq('status', 'in_progress')
        .eq('sim_mode', 'social_media')
        .not('start_time', 'is', null);

      if (error || !sessions || sessions.length === 0) return;

      for (const session of sessions) {
        try {
          await this.scanSession(session.id, session.scenario_id);
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

  private async scanSession(sessionId: string, scenarioId: string | null): Promise<void> {
    const state = this.sessionStates.get(sessionId);

    if (state) {
      if (state.totalPostsCreated >= MAX_POSTS_PER_SESSION) return;
      if (Date.now() < state.cooldownUntil.getTime()) return;
    }

    const sinceTimestamp =
      state?.lastMessageTimestamp || new Date(Date.now() - 5 * 60_000).toISOString();

    const { data: messages, error: msgError } = await supabaseAdmin
      .from('chat_messages')
      .select('id, content, sender_id, created_at, channel_id')
      .eq('session_id', sessionId)
      .gt('created_at', sinceTimestamp)
      .order('created_at', { ascending: true })
      .limit(50);

    if (msgError || !messages || messages.length < MIN_MESSAGES_TO_SCAN) {
      if (messages && messages.length > 0) {
        this.updateState(sessionId, messages[messages.length - 1].created_at, state);
      }
      return;
    }

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

    const userPrompt = `Crisis scenario: ${crisisContext.substring(0, 500)}

Here are the latest internal team communications (leaked):

${transcript}

Analyze these communications. Is there anything that could be spun as scandalous or damaging if leaked to the press?`;

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
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.7,
          max_completion_tokens: 500,
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

  private async createScandalPost(sessionId: string, result: ScandalResult): Promise<void> {
    const viralityScore = result.severity === 'high' ? 80 : result.severity === 'medium' ? 50 : 30;
    const likeCount = Math.floor(Math.random() * 200) + 50;

    const postContent = `LEAKED: ${result.spin_post}\n\n(Source: anonymous insider within the crisis response team)\n\n#leaked #crisis #breaking`;

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
