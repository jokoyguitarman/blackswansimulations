import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { chatJson } from './ai/chatClient.js';
import { loadSessionTopicPhase } from './peace/sessionTopicPhase.js';
import { getWebSocketService } from './websocketService.js';
import { sanitizeEmailCategory } from './feedEngineService.js';
import { pickResponders, resolveStakeholderRecipients } from '../lib/stakeholderRecipients.js';
import {
  emailFallbackRespondent,
  formatEmailFacts,
  formatEmailThread,
  type EmailHistoryRow,
} from './topic/channelPromptShared.js';
import { buildLegacyEmailReplyMessages } from './topic/legacyChannelPrompts.js';
import {
  asModelRecord,
  buildTopicEmailMessages,
  channelPhase,
  channelTopicResult,
  screenChannelReply,
  screenStakeholderReply,
  singleResponderStance,
  type ChannelChatClient,
  type ChannelPhase,
  type ChannelScreenResult,
  type ChannelTopicResult,
} from './topic/channelTopicCore.js';
import { leakTermsFromInitialState } from './topic/topicPromptCore.js';

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

export interface PlayerEmail {
  id: string;
  to_addresses: string[];
  subject: string;
  body_text: string;
  from_name: string;
  from_address: string;
  replied_to_id: string | null;
  thread_id: string | null;
  /** Author of the player email. */
  sender_user_id?: string | null;
  cc_addresses?: string[];
  /** Other session players the player email was delivered to (To + Cc, sender excluded). */
  player_recipients?: Array<{ user_id: string; address: string }>;
}

/** Who an NPC reply to `playerEmail` is delivered to: the author plus every other session
 *  player the author addressed (To or Cc), so CC'd players see the answer. */
function replyDelivery(playerEmail: PlayerEmail): {
  cc_addresses: string[];
  recipient_user_ids?: string[];
} {
  const others = (playerEmail.player_recipients ?? []).filter(
    (p) => p.user_id !== playerEmail.sender_user_id,
  );
  const ids = [
    ...(playerEmail.sender_user_id ? [playerEmail.sender_user_id] : []),
    ...others.map((p) => p.user_id),
  ];
  const uniqueIds = Array.from(new Set(ids));
  const ccAddrs = Array.from(
    new Map(others.map((p) => [p.address.toLowerCase(), p.address])).values(),
  );
  return {
    cc_addresses: ccAddrs,
    ...(uniqueIds.length > 0 ? { recipient_user_ids: uniqueIds } : {}),
  };
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
          ...replyDelivery(playerEmail),
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

export interface NpcEmailReplyOptions {
  phase?: ChannelPhase;
  client?: ChannelChatClient;
}

export async function triggerNPCEmailReply(
  sessionId: string,
  playerEmail: PlayerEmail,
  options?: NpcEmailReplyOptions,
): Promise<ChannelTopicResult | null> {
  if (!env.aiEnabled) return null;

  const phase = channelPhase(options?.phase ?? (await loadSessionTopicPhase(sessionId)));
  const topicAware = env.enableTopicAwareReplies;
  const finish = (screen: ChannelScreenResult | null = null) =>
    channelTopicResult(topicAware, playerEmail.id, screen);
  let outcome: ChannelScreenResult | null = null;

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
      return finish();
    }

    // Load scenario context
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id')
      .eq('id', sessionId)
      .single();

    if (!session?.scenario_id) return finish();

    const { data: scenario } = await supabaseAdmin
      .from('scenarios')
      .select('description, initial_state')
      .eq('id', session.scenario_id)
      .single();

    if (!scenario) return finish();

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
    if (!toAddress) return finish();

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
        const topic =
          topicAware || phase === 'peace'
            ? {
                phase,
                thread: `Subject: ${playerEmail.subject}\n${playerEmail.body_text}`,
                isReply: Boolean(playerEmail.replied_to_id || playerEmail.thread_id),
              }
            : undefined;
        const messageCtx = {
          sessionId,
          channel: 'email' as const,
          userId: playerEmail.sender_user_id ?? '',
          content: playerEmail.body_text,
          subject: playerEmail.subject,
          refTable: 'sim_emails',
          refId: playerEmail.id,
          ...(topic ? { topic } : {}),
          ...(options?.client ? { client: options.client } : {}),
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
            let text = plan.text;
            if (topic) {
              const screened = screenStakeholderReply({
                phase,
                classification: plan.classification,
                replyText: plan.text,
                authorHandle: s.handle,
                leakTerms: leakTermsFromInitialState(initialState),
                playerText: playerEmail.body_text,
                isReply: topic.isReply === true,
                minConfidence: env.topicBridgeMinConfidence,
              });
              text = screened.replyText;
              if (screened.dropped) return;
            }
            if (!plan.should_reply || !text) return;
            const replyPlan = text === plan.text ? plan : { ...plan, text };
            const delayMs =
              Math.max(10, Math.min(90, plan.delay_seconds)) * 1000 + (idx + 1) * 25_000;
            scheduleStakeholderEmailReply({
              sessionId,
              stakeholder: s,
              plan: replyPlan,
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
            let plan = await planPromise;
            let screened: ChannelScreenResult | null = null;
            if (topic) {
              screened = screenStakeholderReply({
                phase,
                classification: plan.classification,
                replyText: plan.text,
                authorHandle: primary.handle,
                leakTerms: leakTermsFromInitialState(initialState),
                playerText: playerEmail.body_text,
                isReply: topic.isReply === true,
                minConfidence: env.topicBridgeMinConfidence,
              });
              outcome = screened;
              plan = { ...plan, text: screened.replyText };
              if (screened.dropped) {
                logger.info(
                  { sessionId, stakeholderId: primary.id },
                  'Dropped topic reply that matched leak terms',
                );
                return finish(screened);
              }
            }
            if (!plan.should_reply || !plan.text) {
              logger.debug(
                { sessionId, stakeholderId: primary.id },
                'Stakeholder chose not to reply by email',
              );
              return finish(screened);
            }
            scheduleStakeholderEmailReply({
              sessionId,
              stakeholder: primary,
              plan,
              playerEmail,
              delayMs: Math.max(10, Math.min(90, plan.delay_seconds)) * 1000,
              recordNpcReply,
            });
            return finish(screened);
          }
        } else if (primary?.kind === 'group') {
          return finish(); // a distribution list never answers itself; sampled members reply above
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
      return finish();
    }

    if (await legacyReplyBudgetExceeded(sessionId, playerEmail.sender_user_id ?? null))
      return finish();

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

    // Load thread context. Flag off keeps master's oldest-10 query. Flag on loads the latest 3.
    let history: EmailHistoryRow[] = [];
    if (playerEmail.replied_to_id || playerEmail.thread_id) {
      const lookupId = playerEmail.thread_id || playerEmail.replied_to_id;
      const { data: threadEmails } = topicAware
        ? await supabaseAdmin
            .from('sim_emails')
            .select('from_name, from_address, direction, subject, body_text, created_at')
            .eq('session_id', sessionId)
            .or(`thread_id.eq.${lookupId},replied_to_id.eq.${lookupId},id.eq.${lookupId}`)
            .order('created_at', { ascending: false })
            .limit(3)
        : await supabaseAdmin
            .from('sim_emails')
            .select('from_name, from_address, direction, subject, body_text, created_at')
            .eq('session_id', sessionId)
            .or(`thread_id.eq.${lookupId},replied_to_id.eq.${lookupId},id.eq.${lookupId}`)
            .order('created_at', { ascending: true })
            .limit(10);
      const rows = topicAware ? [...(threadEmails ?? [])].reverse() : (threadEmails ?? []);
      history = rows.map((row) => ({
        from_name: row.from_name,
        direction: row.direction ?? '',
        subject: row.subject,
        body_text: row.body_text ?? '',
      }));
    }
    const threadContext = formatEmailThread(topicAware ? [] : history);
    const factsContext = formatEmailFacts(factSheet);

    // Build AI prompt
    const respondentInfo = useAiFallback
      ? emailFallbackRespondent(toAddress, phase === 'peace' ? 'peace' : 'crisis')
      : `You are ${respondentName} (${respondentAddress}).
${respondentRole ? `Role/Title: ${respondentRole}` : ''}
${respondentPersonality ? `Personality: ${respondentPersonality}` : ''}`;

    const emailInput = {
      respondentInfo,
      crisisDescription: String(scenario.description || ''),
      orgName,
      factsContext,
      threadContext,
      isMedia: isMediaNPC,
      fromName: playerEmail.from_name,
      fromAddress: playerEmail.from_address,
      toAddress,
      ccAddresses: playerEmail.cc_addresses,
      subject: playerEmail.subject,
      body: playerEmail.body_text,
    };
    const stanceSource = personas.find((persona) => persona.handle === respondentHandle);
    const emailStance = topicAware
      ? singleResponderStance(
          {
            handle: stanceSource?.handle || respondentHandle || toAddress,
            type: stanceSource?.type || respondentType || 'npc_public',
            personality: stanceSource?.personality || respondentPersonality || '',
            bias: stanceSource?.bias ?? '',
          },
          playerEmail.id,
          env.topicBridgeStayShare,
        ).stance
      : 'stay';
    const prompted = topicAware
      ? buildTopicEmailMessages({
          ...emailInput,
          phase,
          history,
          stanceLine: `${stanceSource?.handle || respondentHandle || toAddress} (${respondentName || toAddress}): ${stanceSource?.personality || respondentPersonality}, bias: ${stanceSource?.bias || 'none'}, type: ${stanceSource?.type || respondentType || 'npc_public'}. If bridge: ${emailStance}.`,
        })
      : buildLegacyEmailReplyMessages({ ...emailInput, phase });
    const request = {
      tier: 'standard' as const,
      json: true as const,
      temperature: 0.8,
      maxTokens: isMediaNPC ? 4000 : 1000,
      label: 'npcEmailReply.generate',
      messages: [
        { role: 'system' as const, content: prompted.system },
        { role: 'user' as const, content: prompted.user },
      ],
    };
    const parsed = asModelRecord(
      options?.client ? await options.client.chatJson(request) : await chatJson(request),
    );

    if (!parsed) {
      logger.warn({ sessionId }, 'NPC email reply request failed or returned no JSON');
      return finish();
    }

    let personaScreen: ChannelScreenResult | null = null;
    if (topicAware || phase === 'peace') {
      personaScreen = screenChannelReply({
        phase,
        classification: parsed.classification,
        replyText: String(parsed.body || ''),
        authorHandle: stanceSource?.handle || respondentHandle || toAddress,
        stance: emailStance,
        leakTerms: leakTermsFromInitialState(initialState),
        playerText: `${playerEmail.subject}\n${playerEmail.body_text}`,
        isReply: Boolean(playerEmail.replied_to_id || playerEmail.thread_id),
        minConfidence: env.topicBridgeMinConfidence,
      });
      outcome = personaScreen;
      parsed.body = personaScreen.replyText;
      if (personaScreen.dropped) {
        logger.info(
          { sessionId, playerEmailId: playerEmail.id },
          'Dropped topic reply that matched leak terms',
        );
        return finish(personaScreen);
      }
    }

    if (!parsed.should_reply) {
      logger.debug(
        { sessionId, toAddress, emailId: playerEmail.id },
        'AI decided no reply warranted',
      );
      return finish(personaScreen);
    }

    const replyBody = String(parsed.body || '');
    if (!replyBody.trim()) return finish(personaScreen);

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
            // Author plus every other player on the original To/Cc, so a CC
            // stays on the thread when the NPC answers.
            ...replyDelivery(playerEmail),
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
    return finish(outcome);
  } catch (err) {
    logger.error(
      { err, sessionId, playerEmailId: playerEmail.id },
      'NPC email reply trigger failed',
    );
    return finish(outcome);
  }
}
