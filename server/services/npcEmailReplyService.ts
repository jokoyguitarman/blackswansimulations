import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { getWebSocketService } from './websocketService.js';
import { sanitizeEmailCategory } from './feedEngineService.js';

interface NPCPersona {
  handle: string;
  name: string;
  type: string;
  personality: string;
  bias: string;
  follower_count: number;
  specific_claims: string[];
  backstory: string;
}

interface SenderRecord {
  from_address: string;
  from_name: string;
  email_category: string | null;
}

interface PlayerEmail {
  id: string;
  to_addresses: string[];
  subject: string;
  body_text: string;
  from_name: string;
  from_address: string;
  replied_to_id: string | null;
  thread_id: string | null;
}

const VALID_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);

function sanitizePriority(p: string | undefined | null): string {
  if (p && VALID_PRIORITIES.has(p)) return p;
  return 'normal';
}

/**
 * Match a to_address against known inbound senders (exact match).
 */
function findExactSenderMatch(
  toAddress: string,
  senderRegistry: SenderRecord[],
): SenderRecord | null {
  const lower = toAddress.toLowerCase();
  return senderRegistry.find((s) => s.from_address.toLowerCase() === lower) || null;
}

/**
 * Fuzzy-match a to_address against NPC persona names.
 * Derives plausible email-address fragments from names and checks overlap.
 */
function findFuzzyPersonaMatch(toAddress: string, personas: NPCPersona[]): NPCPersona | null {
  const lower = toAddress.toLowerCase();
  const localPart = lower.split('@')[0] || '';

  for (const persona of personas) {
    if (persona.type === 'npc_public' && (persona as { tier?: string }).tier === 'background')
      continue;

    const nameTokens = persona.name
      .toLowerCase()
      .replace(/[^a-z\s]/g, '')
      .split(/\s+/)
      .filter((t) => t.length > 2);

    const matchCount = nameTokens.filter(
      (token) => localPart.includes(token) || lower.includes(token),
    ).length;

    if (matchCount >= 2 || (nameTokens.length === 1 && matchCount === 1)) {
      return persona;
    }

    const handleClean = persona.handle.replace('@', '').toLowerCase();
    if (localPart.includes(handleClean) || handleClean.includes(localPart.replace(/[._]/g, ''))) {
      return persona;
    }
  }
  return null;
}

/**
 * Derive a plausible email address from an NPC persona name.
 */
export function deriveEmailAddress(persona: {
  name: string;
  handle: string;
  type: string;
}): string {
  const nameParts = persona.name
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .split(/\s+/)
    .filter(Boolean);

  const localPart =
    nameParts.length >= 2
      ? `${nameParts[0]}.${nameParts[1]}`
      : nameParts[0] || persona.handle.replace('@', '');

  if (persona.type === 'npc_media') return `${localPart}@media.sim`;
  if (persona.type === 'npc_politician') return `${localPart}@gov.sim`;
  if (persona.type === 'npc_influencer') return `${localPart}@contacts.sim`;
  return `${localPart}@contacts.sim`;
}

export async function triggerNPCEmailReply(
  sessionId: string,
  playerEmail: PlayerEmail,
): Promise<void> {
  if (!env.openAiApiKey) return;

  try {
    // Anti-loop: check if this email already got an NPC reply
    const { count: existingReplies } = await supabaseAdmin
      .from('sim_emails')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', sessionId)
      .eq('direction', 'inbound')
      .eq('replied_to_id', playerEmail.id);

    if ((existingReplies || 0) > 0) {
      logger.debug({ emailId: playerEmail.id }, 'NPC email reply already exists, skipping');
      return;
    }

    // Anti-loop: rate-limit NPC replies per thread (max 3)
    const threadId = playerEmail.thread_id || playerEmail.replied_to_id || playerEmail.id;
    const { count: threadNpcCount } = await supabaseAdmin
      .from('sim_emails')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', sessionId)
      .eq('direction', 'inbound')
      .is('inject_id', null)
      .or(`thread_id.eq.${threadId},replied_to_id.eq.${threadId}`);

    if ((threadNpcCount || 0) >= 6) {
      logger.debug({ threadId }, 'NPC email thread reply limit reached (6), skipping');
      return;
    }

    // Anti-loop: session-wide rate limit (max 5 NPC replies in last 5 minutes)
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { count: recentNpcCount } = await supabaseAdmin
      .from('sim_emails')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', sessionId)
      .eq('direction', 'inbound')
      .is('inject_id', null)
      .is('sent_by_player_id', null)
      .gte('created_at', fiveMinAgo);

    if ((recentNpcCount || 0) >= 10) {
      logger.debug({ sessionId }, 'NPC email session rate limit reached (10/5min), skipping');
      return;
    }

    // Load scenario context
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
    const orgName = String(initialState.org_name || '');
    const factSheet = initialState.fact_sheet as {
      confirmed_facts?: string[];
      unconfirmed_claims?: Array<{ claim: string; status: string; truth: string }>;
    } | null;

    // Build sender registry from previous inbound emails
    const { data: inboundEmails } = await supabaseAdmin
      .from('sim_emails')
      .select('from_address, from_name, email_category')
      .eq('session_id', sessionId)
      .eq('direction', 'inbound')
      .order('created_at', { ascending: false });

    const senderRegistry: SenderRecord[] = [];
    const seenAddresses = new Set<string>();
    for (const e of inboundEmails || []) {
      const addr = (e.from_address as string).toLowerCase();
      if (!seenAddresses.has(addr)) {
        seenAddresses.add(addr);
        senderRegistry.push({
          from_address: e.from_address as string,
          from_name: e.from_name as string,
          email_category: e.email_category as string | null,
        });
      }
    }

    // Match recipient
    const toAddress = playerEmail.to_addresses[0];
    if (!toAddress) return;

    let respondentName: string | null = null;
    let respondentAddress: string | null = null;
    let respondentPersonality = '';
    let respondentRole = '';
    let respondentType = '';
    let respondentHandle = '';
    let useAiFallback = false;

    // Step 1: exact match against sender registry
    const exactMatch = findExactSenderMatch(toAddress, senderRegistry);
    if (exactMatch) {
      respondentName = exactMatch.from_name;
      respondentAddress = exactMatch.from_address;
      respondentRole = exactMatch.from_name;
    }

    // Step 2: fuzzy match against NPC personas
    if (!respondentName) {
      const fuzzyMatch = findFuzzyPersonaMatch(toAddress, personas);
      if (fuzzyMatch) {
        respondentName = fuzzyMatch.name;
        respondentAddress = deriveEmailAddress(fuzzyMatch);
        respondentPersonality = fuzzyMatch.personality;
        respondentRole = `${fuzzyMatch.name} (${fuzzyMatch.type.replace('npc_', '')})`;
        respondentType = fuzzyMatch.type;
        respondentHandle = fuzzyMatch.handle;
      }
    }

    // Step 3: AI fallback for unknown addresses
    if (!respondentName) {
      useAiFallback = true;
      respondentAddress = toAddress;
    }

    // Find persona details for known respondents
    if (respondentName && !respondentPersonality) {
      const matchedPersona = personas.find(
        (p) =>
          p.name.toLowerCase() === respondentName!.toLowerCase() ||
          respondentName!.toLowerCase().includes(p.name.toLowerCase()),
      );
      if (matchedPersona) {
        respondentPersonality = matchedPersona.personality;
        if (!respondentType) respondentType = matchedPersona.type;
        if (!respondentHandle) respondentHandle = matchedPersona.handle;
      }
    }

    // Detect if recipient is media (for publication capability)
    const isMediaNPC =
      respondentType === 'npc_media' ||
      toAddress.includes('@media.') ||
      toAddress.includes('@news.') ||
      toAddress.includes('@press.');

    // Load thread context
    let threadContext = '';
    if (playerEmail.replied_to_id || playerEmail.thread_id) {
      const lookupId = playerEmail.thread_id || playerEmail.replied_to_id;
      const { data: threadEmails } = await supabaseAdmin
        .from('sim_emails')
        .select('from_name, from_address, direction, subject, body_text, created_at')
        .eq('session_id', sessionId)
        .or(`thread_id.eq.${lookupId},replied_to_id.eq.${lookupId},id.eq.${lookupId}`)
        .order('created_at', { ascending: true })
        .limit(10);

      if (threadEmails && threadEmails.length > 0) {
        threadContext =
          '\n\nEMAIL THREAD HISTORY (oldest first):\n' +
          threadEmails
            .map(
              (e) =>
                `[${e.direction === 'inbound' ? 'FROM' : 'TO'}: ${e.from_name}] Subject: ${e.subject}\n${String(e.body_text).substring(0, 300)}`,
            )
            .join('\n---\n');
      }
    }

    // Build fact sheet context
    let factsContext = '';
    if (factSheet) {
      const confirmed = (factSheet.confirmed_facts || []).slice(0, 6).join('; ');
      const claims = (factSheet.unconfirmed_claims || [])
        .slice(0, 4)
        .map((c) => `"${c.claim}" (${c.status})`)
        .join('; ');
      if (confirmed || claims) {
        factsContext = `\n\nFACT SHEET:\nConfirmed: ${confirmed}\nUnverified claims: ${claims}`;
      }
    }

    // Build AI prompt
    const respondentInfo = useAiFallback
      ? `The player is emailing "${toAddress}". Based on the crisis context and this email address, determine:
1. Whether someone at this address would realistically respond (set should_reply to false if not)
2. Who that person would be (invent a realistic name and title)
3. How they would respond given the crisis situation`
      : `You are ${respondentName} (${respondentAddress}).
${respondentRole ? `Role/Title: ${respondentRole}` : ''}
${respondentPersonality ? `Personality: ${respondentPersonality}` : ''}`;

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
            content: `You are generating an NPC email reply during a crisis simulation. The player sent an email and you must respond in character.

${respondentInfo}

Crisis context: ${String(scenario.description || '').substring(0, 400)}${orgName ? `\nOrganization under crisis: ${orgName}` : ''}
${factsContext}
${threadContext}

RULES:
- Reply in character as this specific person. Use appropriate formality for email.
- If this is a senior leader/executive, your reply should reflect authority — approve/deny requests, give directives, set constraints.
- If this is a community leader or external contact, reflect their concerns and needs.
- If this is media, be professional and guarded.
- Keep the reply realistic: 2-6 sentences for quick replies, longer for substantive responses.
- Determine if this email even warrants a reply (a "thank you" or FYI email might not need one).
- Assign an email_category if your reply is a directive. Valid categories: "general", "holding_statement", "communication_boundaries", "approval_chain", "legal_advisory", "stakeholder_priority", "sitrep_request", "resource_authorization", "messaging_framework", "stand_down_pivot".
- Assign a delay_seconds (10-90) based on how busy this person would realistically be. Executives: 30-90s. Community leaders: 15-60s. Media: 10-30s.
- Do NOT contradict confirmed facts from the fact sheet.
${
  isMediaNPC
    ? `
MEDIA/JOURNALIST PUBLICATION RULES:
- You are a journalist who can PUBLISH articles based on information from sources.
- If the player is providing you with information, a press release, or asking you to cover something:
  - If the information is vague or unverified, ask clarifying questions (who confirmed this? what is the timeline? can you provide official documentation or quotes?)
  - If you have enough solid, newsworthy information to write a story, set "should_publish" to true
  - You should typically require at least 2 email exchanges before publishing unless the info is extremely clear and newsworthy on first contact
  - Be skeptical -- ask for specifics, timelines, official confirmation, quotable statements
  - When publishing, write a professional news article with headline, subheadline, and body
  - Quote the source appropriately: "a spokesperson for [org]", "according to the crisis response team", etc.
  - Your reply email should mention that the story will be published shortly
- If the player is just asking a question (not providing info for publication), respond normally without publishing.
`
    : ''
}
Return ONLY valid JSON:
{
  "should_reply": true,
  "delay_seconds": 30,
  "from_name": "Respondent Name",
  "from_address": "respondent@example.com",
  "subject": "RE: ...",
  "body": "Reply text here...",
  "email_category": "general",
  "priority": "normal"${
    isMediaNPC
      ? `,
  "should_publish": false,
  "article": {
    "headline": "Headline if publishing",
    "subheadline": "Optional subheadline",
    "body": "Full news article body text if publishing",
    "category": "breaking|developing|analysis"
  }`
      : ''
  }
}`,
          },
          {
            role: 'user',
            content: `Player email from ${playerEmail.from_name} (${playerEmail.from_address}):\nTo: ${toAddress}\nSubject: ${playerEmail.subject}\n\n${playerEmail.body_text}`,
          },
        ],
        temperature: 0.8,
        max_completion_tokens: isMediaNPC ? 4000 : 1000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status, sessionId }, 'OpenAI email reply request failed');
      return;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch {
      logger.warn(
        { sessionId, content: content.substring(0, 200) },
        'Failed to parse NPC email reply JSON',
      );
      return;
    }

    if (!parsed.should_reply) {
      logger.debug(
        { sessionId, toAddress, emailId: playerEmail.id },
        'AI decided no reply warranted',
      );
      return;
    }

    const replyBody = String(parsed.body || '');
    if (!replyBody.trim()) return;

    const replyFromName = respondentName || String(parsed.from_name || 'System');
    const replyFromAddress = respondentAddress || String(parsed.from_address || toAddress);
    const replySubject = String(parsed.subject || `RE: ${playerEmail.subject}`);
    const delayMs = Math.max(10, Math.min(90, Number(parsed.delay_seconds) || 30)) * 1000;

    // Schedule delayed delivery
    setTimeout(async () => {
      try {
        const replyThreadId = playerEmail.thread_id || playerEmail.replied_to_id || playerEmail.id;

        const { data: inserted, error } = await supabaseAdmin
          .from('sim_emails')
          .insert({
            session_id: sessionId,
            direction: 'inbound',
            from_address: replyFromAddress,
            from_name: replyFromName,
            to_addresses: [playerEmail.from_address],
            subject: replySubject,
            body_html: `<p>${replyBody.replace(/\n/g, '</p><p>')}</p>`,
            body_text: replyBody,
            priority: sanitizePriority(String(parsed.priority || 'normal')),
            email_category: sanitizeEmailCategory(String(parsed.email_category || 'general')),
            replied_to_id: playerEmail.id,
            thread_id: replyThreadId,
            inject_id: null,
            sent_by_player_id: null,
          })
          .select()
          .single();

        if (error) {
          logger.error(
            { error, sessionId, playerEmailId: playerEmail.id },
            'Failed to insert NPC email reply',
          );
          return;
        }

        getWebSocketService().broadcastToSession(sessionId, {
          type: 'sim_email.received',
          data: { email: inserted },
          timestamp: new Date().toISOString(),
        });

        logger.info(
          {
            sessionId,
            playerEmailId: playerEmail.id,
            replyId: inserted.id,
            from: replyFromName,
            delayMs,
          },
          'NPC email reply delivered',
        );

        // Media publication: if the journalist decided to publish, create article + social post
        if (isMediaNPC && parsed.should_publish && parsed.article) {
          const articleData = parsed.article as Record<string, unknown>;
          const headline = String(articleData.headline || '');
          const articleBody = String(articleData.body || '');

          if (headline && articleBody) {
            const publishDelay = (60 + Math.floor(Math.random() * 120)) * 1000;

            setTimeout(async () => {
              try {
                const { data: article, error: articleError } = await supabaseAdmin
                  .from('sim_news_articles')
                  .insert({
                    session_id: sessionId,
                    outlet_name: replyFromName || 'News Wire',
                    headline,
                    subheadline: String(articleData.subheadline || '') || null,
                    body: articleBody,
                    category: String(articleData.category || 'breaking'),
                  })
                  .select()
                  .single();

                if (articleError) {
                  logger.warn(
                    { error: articleError, sessionId },
                    'Failed to create media publication article',
                  );
                  return;
                }

                // Journalist shares article on social media
                const socialContent = `BREAKING: ${headline}\n\n${articleBody.substring(0, 200)}...\n\nFull story available.`;
                const { data: post, error: postError } = await supabaseAdmin
                  .from('social_posts')
                  .insert({
                    session_id: sessionId,
                    platform: 'x_twitter',
                    author_handle: respondentHandle || '@NewsWire',
                    author_display_name: replyFromName || 'News Wire',
                    author_type: 'npc_media',
                    content: socialContent,
                    sentiment: 'neutral',
                    virality_score: 60,
                    requires_response: false,
                    like_count: Math.floor(Math.random() * 100) + 20,
                    repost_count: Math.floor(Math.random() * 50) + 10,
                    view_count: Math.floor(Math.random() * 3000) + 500,
                    hashtags: ['#breaking', '#news'],
                  })
                  .select()
                  .single();

                if (!postError && post) {
                  getWebSocketService().broadcastToSession(sessionId, {
                    type: 'social_post.created',
                    data: { post },
                    timestamp: new Date().toISOString(),
                  });
                }

                logger.info(
                  { sessionId, articleId: article?.id, headline, journalist: replyFromName },
                  'Media NPC published article from player email exchange',
                );
              } catch (pubErr) {
                logger.warn({ err: pubErr, sessionId }, 'Media publication failed');
              }
            }, publishDelay);

            logger.info(
              { sessionId, headline, publishDelayMs: publishDelay, journalist: replyFromName },
              'Media NPC article publication scheduled',
            );
          }
        }
      } catch (insertErr) {
        logger.warn(
          { err: insertErr, sessionId, playerEmailId: playerEmail.id },
          'NPC email reply delivery failed',
        );
      }
    }, delayMs);

    logger.info(
      {
        sessionId,
        playerEmailId: playerEmail.id,
        respondent: replyFromName,
        delayMs,
      },
      'NPC email reply scheduled',
    );
  } catch (err) {
    logger.error(
      { err, sessionId, playerEmailId: playerEmail.id },
      'NPC email reply trigger failed',
    );
  }
}
