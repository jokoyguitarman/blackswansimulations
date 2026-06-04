import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { getWebSocketService } from './websocketService.js';
import { createHash } from 'crypto';

interface WatchdogSessionState {
  lastScanAt: Date;
  lastPostTimestamp: string;
  cooldownUntil: Date;
  totalPostsCreated: number;
  previousIssues: Set<string>;
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

interface WatchdogResult {
  issue_found: boolean;
  issue_type: string;
  evidence: string;
  challenge_post: string;
  persona: 'legal_analyst' | 'fact_checker' | 'investigative_journalist';
  severity: 'low' | 'medium' | 'high';
  reasoning: string;
  news_articles?: NewsArticle[];
  npc_reactions?: NpcReaction[];
}

interface FactSheet {
  confirmed_facts: string[];
  unconfirmed_claims: Array<{
    claim: string;
    status: string;
    truth?: string;
    spread_by?: string[];
  }>;
}

const SCAN_INTERVAL_MS = 120_000;
const COOLDOWN_MS = 4 * 60_000;
const MIN_NEW_STATEMENTS = 1;
const MAX_POSTS_PER_SESSION = 5;

const NPC_PERSONAS = {
  legal_analyst: {
    handle: '@CrisisLawReview',
    displayName: 'Crisis Law Review',
    authorType: 'npc_media',
  },
  fact_checker: {
    handle: '@FactCheckNow',
    displayName: 'FactCheck Now',
    authorType: 'npc_media',
  },
  investigative_journalist: {
    handle: '@InvestigativeDesk',
    displayName: 'The Investigative Desk',
    authorType: 'npc_media',
  },
} as const;

const SYSTEM_PROMPT = `You are a sharp legal analyst and investigative fact-checker scrutinizing public statements made by a crisis response team. You have access to the confirmed facts of the situation and a complete timeline of their prior statements and outbound emails.

Your job is to find:
1. CONTRADICTIONS: Statements that contradict their own previous statements or emails
2. FACTUAL ERRORS: Claims that contradict the confirmed facts of the situation
3. LEGAL EXPOSURE: Statements that could create legal liability (admissions of guilt, promises they cannot keep, statements that waive legal protections, accepting blame prematurely)
4. OMISSIONS: Deliberate omission of known facts that the public already knows about
5. INCONSISTENCIES: Timeline discrepancies, conflicting numbers, shifting narratives, or tone-deaf messaging

IMPORTANT CALIBRATION:
- Only flag genuinely problematic issues. A vague or cautious statement is NOT an issue -- that is actually good crisis comms.
- Contradictions must be clear and specific (quote both contradicting statements).
- Legal exposure must reference actual legal principles (consumer protection, defamation, liability, negligence).
- Omissions must reference specific confirmed facts that the public would expect to hear about.
- Do NOT flag routine professional statements, empathetic language, or standard crisis responses.

If you find an issue:
1. Write a challenging social media post (2-4 sentences) from one of these personas:
   - legal_analyst: Highlights liability risks with legal terminology
   - fact_checker: Spots contradictions and quotes both statements side by side
   - investigative_journalist: Points out omissions, asks probing questions
2. Generate 1-2 news articles covering the inconsistency/issue (breaking news + optional analysis)
3. Generate 2-3 NPC social media reactions from outraged citizens, legal commentators, or media watchdogs

If the statements are factually sound, legally safe, and internally consistent, set issue_found to false.

Return ONLY valid JSON:
{
  "issue_found": true or false,
  "issue_type": "contradiction|factual_error|legal_exposure|omission|inconsistency",
  "evidence": "Quote the specific statements that create the issue with their timestamps (empty string if none)",
  "challenge_post": "The challenging social media post 2-4 sentences (empty string if none)",
  "persona": "legal_analyst|fact_checker|investigative_journalist",
  "severity": "low|medium|high",
  "reasoning": "Detailed explanation of why this is problematic (empty string if none)",
  "news_articles": [
    {
      "outlet_name": "News outlet name",
      "headline": "Sensational headline about the inconsistency",
      "subheadline": "Optional subheadline",
      "body": "Full news article (3-5 paragraphs, professional news style, quote the contradicting statements, include expert commentary)",
      "category": "breaking or analysis"
    }
  ],
  "npc_reactions": [
    {
      "author_handle": "@handle",
      "author_display_name": "Display Name",
      "content": "Outraged or concerned reaction (1-2 sentences)",
      "platform": "x_twitter or facebook",
      "sentiment": "negative or inflammatory"
    }
  ]
}

When issue_found is false, omit or leave news_articles and npc_reactions as empty arrays.`;

class StatementWatchdogService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private sessionStates = new Map<string, WatchdogSessionState>();

  start(): void {
    if (this.isRunning) {
      logger.warn('StatementWatchdogService is already running');
      return;
    }

    if (!env.openAiApiKey) {
      logger.warn('OpenAI API key not configured, statement watchdog will not run');
      return;
    }

    this.isRunning = true;
    this.intervalId = setInterval(() => {
      this.scanActiveSessions();
    }, SCAN_INTERVAL_MS);

    logger.info(
      'StatementWatchdogService started (every 2min, social_media sessions only, GPT-5.2)',
    );
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    this.sessionStates.clear();
    logger.info('StatementWatchdogService stopped');
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
            'Statement watchdog scan failed for session',
          );
        }
      }
    } catch (err) {
      logger.error({ error: err }, 'Error in StatementWatchdogService.scanActiveSessions');
    }
  }

  private async scanSession(sessionId: string, scenarioId: string | null): Promise<void> {
    const state = this.sessionStates.get(sessionId);

    if (state) {
      if (state.totalPostsCreated >= MAX_POSTS_PER_SESSION) return;
      if (Date.now() < state.cooldownUntil.getTime()) return;
    }

    const sinceTimestamp =
      state?.lastPostTimestamp || new Date(Date.now() - 5 * 60_000).toISOString();

    // Fetch NEW player/official statements since last scan
    const { data: newStatements } = await supabaseAdmin
      .from('social_posts')
      .select('id, content, created_at, author_handle, author_display_name, author_type')
      .eq('session_id', sessionId)
      .in('author_type', ['official_account', 'player'])
      .gt('created_at', sinceTimestamp)
      .order('created_at', { ascending: true });

    if (!newStatements || newStatements.length < MIN_NEW_STATEMENTS) {
      if (newStatements && newStatements.length > 0) {
        this.updateState(sessionId, newStatements[newStatements.length - 1].created_at, state);
      }
      return;
    }

    // Load ALL prior player statements for contradiction detection
    const { data: allStatements } = await supabaseAdmin
      .from('social_posts')
      .select('content, created_at, author_handle, author_type')
      .eq('session_id', sessionId)
      .in('author_type', ['official_account', 'player'])
      .order('created_at', { ascending: true })
      .limit(100);

    // Load outbound emails
    const { data: outboundEmails } = await supabaseAdmin
      .from('sim_emails')
      .select('subject, body_text, created_at, to_addresses')
      .eq('session_id', sessionId)
      .eq('direction', 'outbound')
      .order('created_at', { ascending: true })
      .limit(30);

    // Load scenario fact sheet
    let factSheet: FactSheet = { confirmed_facts: [], unconfirmed_claims: [] };
    let crisisContext = 'A social media crisis';

    if (scenarioId) {
      const { data: scenario } = await supabaseAdmin
        .from('scenarios')
        .select('title, initial_state')
        .eq('id', scenarioId)
        .single();

      if (scenario) {
        const initialState = (scenario.initial_state || {}) as Record<string, unknown>;
        factSheet = (initialState.fact_sheet as FactSheet) || factSheet;
        crisisContext =
          `${scenario.title || 'Crisis'}. ${String(initialState.crisis_description || initialState.context || '')}`.trim();
      }
    }

    // Build the full context for the LLM
    const factsContext =
      factSheet.confirmed_facts.length > 0
        ? `CONFIRMED FACTS:\n${factSheet.confirmed_facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}`
        : 'No confirmed facts available.';

    const claimsContext =
      factSheet.unconfirmed_claims.length > 0
        ? `\n\nKNOWN FALSE/UNCONFIRMED CLAIMS:\n${factSheet.unconfirmed_claims.map((c) => `- "${c.claim}" (Status: ${c.status}${c.truth ? `, Truth: ${c.truth}` : ''})`).join('\n')}`
        : '';

    const statementsTimeline = (allStatements || [])
      .map(
        (s) =>
          `[${new Date(s.created_at).toLocaleTimeString()}] ${s.author_handle}: "${s.content}"`,
      )
      .join('\n');

    const emailsTimeline =
      (outboundEmails || []).length > 0
        ? `\n\nOUTBOUND EMAILS SENT:\n${(outboundEmails || []).map((e) => `[${new Date(e.created_at).toLocaleTimeString()}] To: ${e.to_addresses.join(', ')} | Subject: ${e.subject}\n${e.body_text.substring(0, 300)}`).join('\n---\n')}`
        : '';

    const newStatementsText = newStatements
      .map(
        (s) =>
          `[${new Date(s.created_at).toLocaleTimeString()}] ${s.author_handle} (${s.author_type}): "${s.content}"`,
      )
      .join('\n');

    const userPrompt = `Crisis scenario: ${crisisContext.substring(0, 800)}

${factsContext}${claimsContext}

COMPLETE TIMELINE OF TEAM'S PUBLIC STATEMENTS:
${statementsTimeline || '(No prior statements)'}${emailsTimeline}

--- NEW STATEMENTS TO ANALYZE (posted since last check) ---
${newStatementsText}

Analyze the NEW statements above against the confirmed facts, known claims, and the team's prior statement history. Is there any contradiction, factual error, legal exposure, omission, or inconsistency?`;

    const result = await this.callAI(userPrompt);

    const lastTimestamp = newStatements[newStatements.length - 1].created_at;

    if (result?.issue_found && result.challenge_post) {
      // Dedup: hash the evidence to avoid re-flagging same issue
      const issueHash = createHash('md5')
        .update(result.evidence || '')
        .digest('hex');
      if (state?.previousIssues.has(issueHash)) {
        this.updateState(sessionId, lastTimestamp, state);
        return;
      }

      // Find the most relevant new statement to reply to
      const targetPost = newStatements[newStatements.length - 1];

      await this.createChallengeCascade(sessionId, result, targetPost?.id || null);

      const currentState = this.sessionStates.get(sessionId);
      const previousIssues = currentState?.previousIssues || new Set<string>();
      previousIssues.add(issueHash);

      this.sessionStates.set(sessionId, {
        lastScanAt: new Date(),
        lastPostTimestamp: lastTimestamp,
        cooldownUntil: new Date(Date.now() + COOLDOWN_MS),
        totalPostsCreated: (currentState?.totalPostsCreated || 0) + 1,
        previousIssues,
      });

      logger.info(
        {
          sessionId,
          issueType: result.issue_type,
          severity: result.severity,
          persona: result.persona,
        },
        'Statement watchdog: challenge post created',
      );
    } else {
      this.updateState(sessionId, lastTimestamp, state);
    }
  }

  private updateState(
    sessionId: string,
    lastPostTimestamp: string,
    existing?: WatchdogSessionState,
  ): void {
    this.sessionStates.set(sessionId, {
      lastScanAt: new Date(),
      lastPostTimestamp,
      cooldownUntil: existing?.cooldownUntil || new Date(0),
      totalPostsCreated: existing?.totalPostsCreated || 0,
      previousIssues: existing?.previousIssues || new Set(),
    });
  }

  private async callAI(userPrompt: string): Promise<WatchdogResult | null> {
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
          temperature: 0.6,
          max_completion_tokens: 10000,
          response_format: { type: 'json_object' },
        }),
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, 'Statement watchdog LLM call failed');
        return null;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) return null;

      return JSON.parse(content) as WatchdogResult;
    } catch (err) {
      logger.error({ error: err }, 'Statement watchdog AI call error');
      return null;
    }
  }

  private async createChallengeCascade(
    sessionId: string,
    result: WatchdogResult,
    replyToPostId: string | null,
  ): Promise<void> {
    const persona = NPC_PERSONAS[result.persona] || NPC_PERSONAS.fact_checker;
    const viralityScore = result.severity === 'high' ? 75 : result.severity === 'medium' ? 50 : 30;
    const likeCount = Math.floor(Math.random() * 150) + 30;
    const hashtags = this.getHashtags(result.issue_type);

    // 1. Post challenge on X/Twitter (immediate)
    const { data: xPost } = await supabaseAdmin
      .from('social_posts')
      .insert({
        session_id: sessionId,
        platform: 'x_twitter',
        author_handle: persona.handle,
        author_display_name: persona.displayName,
        author_type: persona.authorType,
        content: `${result.challenge_post}\n\n${hashtags.join(' ')}`,
        reply_to_post_id: replyToPostId,
        sentiment: 'negative',
        virality_score: viralityScore,
        content_flags: {
          watchdog: true,
          issue_type: result.issue_type,
          evidence: result.evidence?.substring(0, 500),
        },
        requires_response: true,
        like_count: likeCount,
        repost_count: Math.floor(likeCount * 0.5),
        view_count: Math.floor(likeCount * 20),
        hashtags,
      })
      .select()
      .single();

    if (xPost) {
      // Increment reply_count on the player's post that's being challenged
      if (replyToPostId) {
        const { data: targetPost } = await supabaseAdmin
          .from('social_posts')
          .select('reply_count')
          .eq('id', replyToPostId)
          .single();
        await supabaseAdmin
          .from('social_posts')
          .update({ reply_count: ((targetPost?.reply_count as number) || 0) + 1 })
          .eq('id', replyToPostId);
      }

      getWebSocketService().broadcastToSession(sessionId, {
        type: 'social_post.created',
        data: { post: xPost },
        timestamp: new Date().toISOString(),
      });
    }

    // 2. Cross-post to Facebook (10s delay)
    setTimeout(async () => {
      try {
        const { data: fbPost } = await supabaseAdmin
          .from('social_posts')
          .insert({
            session_id: sessionId,
            platform: 'facebook',
            author_handle: persona.handle,
            author_display_name: persona.displayName,
            author_type: persona.authorType,
            content: `${result.challenge_post}\n\n${hashtags.join(' ')}`,
            sentiment: 'negative',
            virality_score: viralityScore,
            content_flags: { watchdog: true, issue_type: result.issue_type },
            requires_response: true,
            like_count: Math.floor(likeCount * 1.2),
            repost_count: Math.floor(likeCount * 0.3),
            view_count: Math.floor(likeCount * 25),
            hashtags,
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
        logger.warn({ err, sessionId }, 'Watchdog: failed to cross-post to Facebook');
      }
    }, 10_000);

    // 3. Insert news articles (staggered 30-120s)
    const articles = result.news_articles || [];
    for (let i = 0; i < articles.length; i++) {
      const article = articles[i];
      const articleDelay = (30 + i * 50) * 1000 + Math.floor(Math.random() * 30_000);

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
            { sessionId, headline: article.headline },
            'Statement watchdog: news article published',
          );
        } catch (err) {
          logger.warn({ err, sessionId }, 'Watchdog: failed to insert news article');
        }
      }, articleDelay);
    }

    // 4. NPC reactions (staggered 20-70s)
    const reactions = result.npc_reactions || [];
    for (let i = 0; i < reactions.length; i++) {
      const reaction = reactions[i];
      const reactionDelay = (20 + i * 15) * 1000 + Math.floor(Math.random() * 15_000);

      setTimeout(async () => {
        try {
          const isReply = xPost && reaction.platform === 'x_twitter' && Math.random() > 0.4;

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
              virality_score: Math.floor(Math.random() * 25) + 10,
              reply_to_post_id: isReply ? xPost.id : null,
              like_count: Math.floor(Math.random() * 40) + 5,
              repost_count: Math.floor(Math.random() * 15),
              view_count: Math.floor(Math.random() * 800) + 100,
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
          logger.warn({ err, sessionId }, 'Watchdog: failed to insert NPC reaction');
        }
      }, reactionDelay);
    }

    logger.info(
      {
        sessionId,
        persona: result.persona,
        articlesCount: articles.length,
        reactionsCount: reactions.length,
      },
      'Statement watchdog: challenge cascade initiated',
    );
  }

  private getHashtags(issueType: string): string[] {
    switch (issueType) {
      case 'contradiction':
        return ['#factcheck', '#contradiction', '#receipts'];
      case 'factual_error':
        return ['#factcheck', '#misinformation', '#correction'];
      case 'legal_exposure':
        return ['#legalrisk', '#crisiscomms', '#liability'];
      case 'omission':
        return ['#accountability', '#transparency', '#whatareyouhiding'];
      case 'inconsistency':
        return ['#inconsistent', '#shiftingnarrative', '#crisiscomms'];
      default:
        return ['#factcheck', '#crisiscomms'];
    }
  }
}

let serviceInstance: StatementWatchdogService | null = null;

export function initializeStatementWatchdog(): StatementWatchdogService {
  if (!serviceInstance) {
    serviceInstance = new StatementWatchdogService();
  }
  return serviceInstance;
}
