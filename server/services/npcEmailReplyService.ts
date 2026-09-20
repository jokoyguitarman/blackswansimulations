import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { chatJson } from './ai/chatClient.js';
import { getWebSocketService } from './websocketService.js';
import { sanitizeEmailCategory } from './feedEngineService.js';
import { pickResponders, resolveStakeholderRecipients } from '../lib/stakeholderRecipients.js';

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
  /** Author of the player email; the NPC reply is addressed to them only. */
  sender_user_id?: string | null;
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

// ─── Legacy reply budgets (docs/session-bugfix-spec-2026-09-20.md §11) ───────

/** NPC replies per email thread (legacy persona path). */
const LEGACY_THREAD_CAP = 6;
/** NPC replies per sending player per window (legacy path). */
const LEGACY_PER_SENDER_CAP = 4;
/** Session ceiling per window — applies to automated (bot) senders only. */
const LEGACY_SESSION_CEILING = 40;
const LEGACY_WINDOW_MS = 5 * 60 * 1000;

async function isBotUser(userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const { data } = await supabaseAdmin
    .from('user_profiles')
    .select('is_bot')
    .eq('id', userId)
    .maybeSingle();
  return !!(data as { is_bot?: boolean } | null)?.is_bot;
}

/**
 * Per-sender budget first (a chatty player is throttled on their own), then a session ceiling
 * that only automated senders are subject to — a human's message is never dropped because bots
 * generated the traffic.
 */
async function legacyReplyBudgetExceeded(
  sessionId: string,
  senderUserId: string | null,
): Promise<boolean> {
  const since = new Date(Date.now() - LEGACY_WINDOW_MS).toISOString();

  if (senderUserId) {
    const { data: recentOutbound } = await supabaseAdmin
      .from('sim_emails')
      .select('id')
      .eq('session_id', sessionId)
      .eq('direction', 'outbound')
      .eq('sent_by_player_id', senderUserId)
      .gte('created_at', new Date(Date.now() - 2 * LEGACY_WINDOW_MS).toISOString());
    const ids = (recentOutbound ?? []).map((r) => String((r as { id: string }).id));
    if (ids.length > 0) {
      const { count: perSender } = await supabaseAdmin
        .from('sim_emails')
        .select('id', { count: 'exact', head: true })
        .eq('session_id', sessionId)
        .eq('direction', 'inbound')
        .is('inject_id', null)
        .in('replied_to_id', ids)
        .gte('created_at', since);
      if ((perSender ?? 0) >= LEGACY_PER_SENDER_CAP) {
        logger.debug(
          { sessionId, senderUserId },
          `NPC email per-sender limit reached (${LEGACY_PER_SENDER_CAP}/5min), skipping`,
        );
        return true;
      }
    }
  }

  if (!(await isBotUser(senderUserId))) return false;

  const { count: recentNpcCount } = await supabaseAdmin
    .from('sim_emails')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId)
    .eq('direction', 'inbound')
    .is('inject_id', null)
    .is('sent_by_player_id', null)
    .gte('created_at', since);
  if ((recentNpcCount ?? 0) >= LEGACY_SESSION_CEILING) {
    logger.debug(
      { sessionId, senderUserId },
      `NPC email session ceiling reached for bot traffic (${LEGACY_SESSION_CEILING}/5min), skipping`,
    );
    return true;
  }
  return false;
}

// ─── Multi-recipient stakeholder mail (contract v3.2, handover §10.5 R1) ─────

type StakeholderRec = import('../lib/stakeholderContract.js').Stakeholder;

/** Persist and broadcast a stakeholder's email reply after `delayMs`, then log it. */
function scheduleStakeholderEmailReply(args: {
  sessionId: string;
  stakeholder: StakeholderRec;
  plan: import('./stakeholderReconsiderationService.js').ReplyPlan;
  playerEmail: PlayerEmail;
  delayMs: number;
  recordNpcReply: (typeof import('./stakeholderReplyService.js'))['recordNpcReply'];
}): void {
  const { sessionId, stakeholder, plan, playerEmail, delayMs, recordNpcReply } = args;
  const subject =
    plan.subject ||
    (playerEmail.subject.startsWith('RE:') ? playerEmail.subject : `RE: ${playerEmail.subject}`);
  setTimeout(async () => {
    try {
      const replyThreadId = playerEmail.thread_id || playerEmail.replied_to_id || playerEmail.id;
      const { data: inserted, error } = await supabaseAdmin
        .from('sim_emails')
        .insert({
          session_id: sessionId,
          direction: 'inbound',
          from_address: stakeholder.email,
          from_name: stakeholder.name,
          to_addresses: [playerEmail.from_address],
          subject,
          body_html: `<p>${plan.text.replace(/\n/g, '</p><p>')}</p>`,
          body_text: plan.text,
          priority: 'normal',
          email_category: sanitizeEmailCategory(
            stakeholder.relationship === 'internal' ? 'verified_facts' : 'general',
          ),
          replied_to_id: playerEmail.id,
          thread_id: replyThreadId,
          inject_id: null,
          sent_by_player_id: null,
          ...(playerEmail.sender_user_id
            ? { recipient_user_ids: [playerEmail.sender_user_id] }
            : {}),
        })
        .select()
        .single();
      if (error || !inserted) {
        logger.error(
          { error, sessionId, playerEmailId: playerEmail.id, stakeholderId: stakeholder.id },
          'Failed to insert stakeholder email reply',
        );
        return;
      }
      getWebSocketService().broadcastToSession(sessionId, {
        type: 'sim_email.received',
        data: { email: inserted },
        timestamp: new Date().toISOString(),
      });
      await recordNpcReply({
        sessionId,
        stakeholderId: stakeholder.id,
        channel: 'email',
        content: `Subject: ${subject}\n${plan.text}`,
        refTable: 'sim_emails',
        refId: String(inserted.id),
      });
      logger.info(
        { sessionId, stakeholderId: stakeholder.id, replyId: inserted.id },
        'Stakeholder email reply delivered',
      );
    } catch (err) {
      logger.warn(
        { err, sessionId, playerEmailId: playerEmail.id, stakeholderId: stakeholder.id },
        'Stakeholder email reply delivery failed',
      );
    }
  }, delayMs);
}

export async function triggerNPCEmailReply(
  sessionId: string,
  playerEmail: PlayerEmail,
): Promise<void> {
  if (!env.aiEnabled) return;

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

    // Step 0: stakeholder records (contract §3, v3.2 groups/roster; handover §10.5 R1).
    // EVERY recipient that resolves to a stakeholder is logged as contacted — principals, roster
    // members, and distribution lists expanded to their members — so a mass notice really
    // notifies everyone. Replies come from a bounded sample (principals first, then a few roster
    // members). The primary recipient keeps its legacy semantics: a media stakeholder falls
    // through to the article-publishing path below; anything else is answered from the record.
    let mediaStakeholder: import('../lib/stakeholderContract.js').Stakeholder | null = null;
    if (env.enableStakeholderEngine) {
      const { findByEmail, findById } = await import('./stakeholderService.js');
      const { handlePlayerMessage, appendPlayerMessage, recordNpcReply } =
        await import('./stakeholderReplyService.js');
      const recipients = await resolveStakeholderRecipients(
        playerEmail.to_addresses,
        (addr) => findByEmail(session.scenario_id, addr),
        (id) => findById(session.scenario_id, id),
      );

      if (recipients.primary || recipients.all.length > 0) {
        const messageCtx = {
          sessionId,
          channel: 'email' as const,
          userId: playerEmail.sender_user_id ?? '',
          content: playerEmail.body_text,
          subject: playerEmail.subject,
          refTable: 'sim_emails',
          refId: playerEmail.id,
        };
        const primary = recipients.primary;
        const responders = pickResponders(recipients.all, primary, playerEmail.id);
        const responderIds = new Set(responders.map((s) => s.id));

        // Everyone else just learns of the message (log only, no model call).
        for (const s of recipients.all) {
          if (responderIds.has(s.id) || s.id === primary?.id) continue;
          void appendPlayerMessage({ ...messageCtx, stakeholder: s }).catch(() => undefined);
        }
        // Groups are logged as contacted too (so `wasContacted(group)` holds); they never reply.
        if (primary?.kind === 'group') {
          void appendPlayerMessage({ ...messageCtx, stakeholder: primary }).catch(() => undefined);
        }

        // Sampled non-primary responders: staggered so a mass notice does not answer in unison.
        responders.forEach((s, idx) => {
          if (s.id === primary?.id) return;
          void (async () => {
            const plan = await handlePlayerMessage({ ...messageCtx, stakeholder: s });
            if (s.relationship === 'media') return; // verdicts + log only for cc'd journalists
            if (!plan.should_reply) return;
            const delayMs =
              Math.max(10, Math.min(90, plan.delay_seconds)) * 1000 + (idx + 1) * 25_000;
            scheduleStakeholderEmailReply({
              sessionId,
              stakeholder: s,
              plan,
              playerEmail,
              delayMs,
              recordNpcReply,
            });
          })().catch((err) =>
            logger.warn(
              { err, sessionId, stakeholderId: s.id },
              'Sampled stakeholder reply failed',
            ),
          );
        });

        if (primary && primary.kind !== 'group') {
          const planPromise = handlePlayerMessage({ ...messageCtx, stakeholder: primary });
          if (primary.relationship === 'media') {
            mediaStakeholder = primary;
            respondentName = primary.name;
            respondentAddress = primary.email;
            respondentPersonality = primary.personality;
            respondentRole = [primary.title, primary.organisation].filter(Boolean).join(', ');
            respondentType = 'npc_media';
            respondentHandle = primary.handle;
            void planPromise; // verdicts + log only; the legacy call below writes the reply
          } else {
            const plan = await planPromise;
            if (!plan.should_reply) {
              logger.debug(
                { sessionId, stakeholderId: primary.id },
                'Stakeholder chose not to reply by email',
              );
              return;
            }
            scheduleStakeholderEmailReply({
              sessionId,
              stakeholder: primary,
              plan,
              playerEmail,
              delayMs: Math.max(10, Math.min(90, plan.delay_seconds)) * 1000,
              recordNpcReply,
            });
            return;
          }
        } else if (primary?.kind === 'group') {
          return; // a distribution list never answers itself; sampled members reply above
        }
        // `!primary` (first address is a legacy persona, later ones are stakeholders): the
        // stakeholders are handled; the persona still gets its legacy reply below.
      }
    }

    // ── Legacy-path budgets (docs/session-bugfix-spec-2026-09-20.md §11) ──────────────────────
    // These sit AFTER the stakeholder step on purpose: workbook contacts are never starved by the
    // legacy budget, and a human's mail is never dropped because of automated (bot) traffic.

    // Anti-loop: rate-limit NPC replies per thread
    const threadId = playerEmail.thread_id || playerEmail.replied_to_id || playerEmail.id;
    const { count: threadNpcCount } = await supabaseAdmin
      .from('sim_emails')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', sessionId)
      .eq('direction', 'inbound')
      .is('inject_id', null)
      .or(`thread_id.eq.${threadId},replied_to_id.eq.${threadId}`);

    if ((threadNpcCount || 0) >= LEGACY_THREAD_CAP) {
      logger.debug(
        { threadId },
        `NPC email thread reply limit reached (${LEGACY_THREAD_CAP}), skipping`,
      );
      return;
    }

    if (await legacyReplyBudgetExceeded(sessionId, playerEmail.sender_user_id ?? null)) return;

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
2. Who that person would be (invent a realistic name and title — if this is an internal/organisational address, the respondent is GROUND-LEVEL OPERATIONAL STAFF such as a duty manager, shift supervisor, or operations coordinator, never a C-suite executive)
3. How they would respond given the crisis situation`
      : `You are ${respondentName} (${respondentAddress}).
${respondentRole ? `Role/Title: ${respondentRole}` : ''}
${respondentPersonality ? `Personality: ${respondentPersonality}` : ''}`;

    const parsed = await chatJson<Record<string, unknown>>({
      tier: 'standard',
      json: true,
      temperature: 0.8,
      maxTokens: isMediaNPC ? 4000 : 1000,
      label: 'npcEmailReply.generate',
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
- If this is an internal colleague or supervisor, reply at WORKING LEVEL (duty manager, ops coordinator, shift lead): share verified facts, request status, flag operational constraints. C-suite executives do not personally answer email during a crisis — if the address clearly belongs to an executive, the reply comes from their operations desk or assistant on their behalf. Internal replies must NEVER provide draft statements, talking points, suggested messaging, or PR strategy.
- If this is a community leader or external contact, reflect their concerns and needs.
- If this is media, be professional and guarded.
- Keep the reply realistic: 2-6 sentences for quick replies, longer for substantive responses.
- Determine if this email even warrants a reply (a "thank you" or FYI email might not need one).
- Assign an email_category for your reply. Valid categories: "general", "verified_facts", "sitrep_request", "leak_notice". Use "verified_facts" only to share confirmed information; use "general" for press/external correspondence; do NOT issue communication red lines, approval chains, or comms-process instructions.
- Assign a delay_seconds (10-90) based on how busy this person would realistically be. Executives: 30-90s. Community leaders: 15-60s. Media: 10-30s.
- Do NOT contradict confirmed facts from the fact sheet.
- ANTI-COACHING: If you are a senior leader, executive, or internal authority, you must NEVER tell the team what to say publicly, provide draft statements, talking points, suggested messaging, approved language, or PR strategy. You may share verified facts, set constraints (what NOT to do), request updates, and authorize resources — but the team must craft their own public response.
${
  isMediaNPC
    ? `
MEDIA/JOURNALIST PUBLICATION RULES (1-2 STEPS MAX — do NOT gatekeep):
- You are a journalist who PUBLISHES quickly based on whatever the source provides.
- If the player's email contains ANY usable information, a statement, or a request to cover something: set "should_publish" to true on this FIRST email. Do NOT demand documentation, multiple confirmations, or quotable statements as a precondition.
- Only send ONE clarifying reply (without publishing) if the email contains NO usable information at all (e.g. it is purely a question to you). After that single exchange, publish with whatever you have.
- Publish based ONLY on what the player actually provided. If the info is incomplete, vague, or unverified, write a SHORTER, more speculative or critical article that reflects the gaps — e.g. note that "[the organization] did not provide specifics", "key questions remain unanswered", or lean on unverified public claims. Incomplete or weak input MUST result in an incomplete or unflattering article, not a request for more.
- When publishing, write a professional news article with headline, subheadline, and body. Quote the source appropriately ("a spokesperson for [org]", "according to the crisis response team").
- Your reply email should mention the story is being published.
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
    });

    if (!parsed) {
      logger.warn({ sessionId }, 'NPC email reply request failed or returned no JSON');
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
            // Private correspondence: the reply lands only in the author's
            // inbox instead of the whole session (legacy NULL behaviour).
            ...(playerEmail.sender_user_id
              ? { recipient_user_ids: [playerEmail.sender_user_id] }
              : {}),
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

        // Media stakeholders: keep the cross-channel memory consistent (contract §7 item 7).
        if (mediaStakeholder) {
          try {
            const { recordNpcReply } = await import('./stakeholderReplyService.js');
            await recordNpcReply({
              sessionId,
              stakeholderId: mediaStakeholder.id,
              channel: 'email',
              content: `Subject: ${replySubject}\n${replyBody}`,
              refTable: 'sim_emails',
              refId: String(inserted.id),
            });
          } catch {
            /* non-critical */
          }
        }

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

                getWebSocketService().broadcastToSession(sessionId, {
                  type: 'news_article.published',
                  data: { article },
                  timestamp: new Date().toISOString(),
                });

                const outletName = replyFromName || 'News Wire';
                const outletHandle = respondentHandle || '@news_wire';
                const snippet = articleBody.substring(0, 150);
                const category = String(articleData.category || 'breaking');
                const categoryLabel = category === 'breaking' ? 'BREAKING' : category.toUpperCase();

                const sharedArticleFlags = {
                  shared_article: {
                    id: article.id,
                    headline,
                    outlet_name: outletName,
                    snippet,
                    category,
                  },
                };

                const socialPlatforms = [
                  {
                    platform: 'x_twitter',
                    content: `${categoryLabel}: ${headline}\n\nnews.sim/${article.id.slice(0, 8)}`,
                  },
                  {
                    platform: 'facebook',
                    content: `📰 ${headline}\n\n"${snippet}..."\n\n— ${outletName}`,
                  },
                ];

                for (const { platform, content: postContent } of socialPlatforms) {
                  const { data: post, error: postError } = await supabaseAdmin
                    .from('social_posts')
                    .insert({
                      session_id: sessionId,
                      platform,
                      author_handle: outletHandle,
                      author_display_name: outletName,
                      author_type: 'npc_media',
                      content: postContent,
                      shared_article_id: article.id,
                      content_flags: sharedArticleFlags,
                      sentiment: 'neutral',
                      hashtags: ['#BreakingNews'],
                      virality_score: 60 + Math.floor(Math.random() * 30),
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
