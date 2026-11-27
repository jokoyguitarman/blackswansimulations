import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { handleFor } from '../lib/identity.js';
import { chatJson } from './ai/chatClient.js';
import { getWebSocketService } from './websocketService.js';
import { resolveTeamMembers } from './teamCharterService.js';
import { ensureNpcDirectChannel } from './channelService.js';
import { buildMessengerDmRows, type MessengerRecipient } from './dm/dmDeliveryCore.js';
import {
  groupChatMessage,
  phoneCallMessage,
  phoneCaller,
  selectInjectTeamChannels,
  UNKNOWN_CALLER,
  type NpcChatMessage,
} from '../lib/injectChatMessages.js';
import { injectKeyOf, isValidInjectKey } from '../lib/injectKey.js';
import { recordDelivery, type RecordDeliveryInput } from './ledger/injectLedgerService.js';
import { chainLedgerFields } from './escalation/escalationCore.js';
import { startInjectCall } from './calls/callService.js';
import { routeRoleMessage } from './roles/messageRouting.js';
import {
  chatInjectIdColumnMissing,
  directMessageInjectIdColumnMissing,
  ledgerErrorCode,
  markChatInjectIdColumnMissing,
  markDirectMessageInjectIdColumnMissing,
} from './ledger/ledgerSchema.js';

export interface DeliveryConfig {
  app: 'social_feed' | 'group_chat' | 'email' | 'news' | 'phone_call' | 'messenger_dm' | 'npc_dm';
  platform?: string;
  author_handle?: string;
  author_display_name?: string;
  author_type?: string;
  virality_score?: number;
  content_flags?: Record<string, unknown>;
  engagement_seed?: { likes?: number; reposts?: number; replies?: number };
  spawn_replies?: number;
  reply_sentiment_distribution?: Record<string, number>;
  // Email-specific
  from_address?: string;
  from_name?: string;
  priority?: string;
  email_category?: string;
  /** Team that owns this stakeholder relationship — universal emails carrying
   * this land only in that team's inboxes (customer/partner mail -> Stakeholder
   * Engagement, investor mail -> Shareholder Engagement, press -> Communications,
   * regulators -> Legal). */
  stakeholder_team?: string;
  // News-specific
  outlet_name?: string;
  headline?: string;
  category?: string;
  // Chat-specific
  sender_name?: string;
  channel_type?: string;
  // Stakeholder contacts contract (docs/stakeholder-contacts-contract.md §4)
  /** Character this inject is issued by (initial_state.stakeholders[].id). */
  stakeholder_id?: string;
  /** Organisation the inject is FOR — scopes private delivery to that org's members. */
  org_key?: string;
  /** Country whose feed / news this content belongs in (social_feed / news only). */
  country?: string;
  /** Stable slug conditions use. Invalid values fall back to the inject id. */
  inject_key?: string;
  /** Minutes after delivery in which a chat message can still count as the reply. */
  response_window_minutes?: number;
  /** Root inject only. Chain steps omit this and set `chain` instead. */
  escalation?: unknown;
  chain?: {
    chain_id?: string;
    root_delivery_id: string;
    root_key: string;
    step: number;
    urgency: 'reminder' | 'follow_up' | 'urgent' | 'final' | 'escalated';
    thread_id?: string;
    replied_to_id?: string;
  };
}

/** Chat-line fallback when the Phone app is off or migration 269 is not applied. */

export interface TeamTargeting {
  /** Resolved member user ids; null means universal delivery. */
  playerIds: string[] | null;
  teamNames: string[];
  mention?: string;
  targetRoleId?: string | null;
  lineTeam?: string | null;
  fallbackReason?: string | null;
}

/**
 * Resolve a team-scoped inject's target_teams into concrete player ids at
 * publish time so the existing per-player read filters do the rest.
 *
 * Returns null for universal delivery. Returns { playerIds: [] } when the
 * targeted team(s) have no members — callers must NOT fall back to
 * session-wide delivery (that would leak team-only content); the inject is
 * reported to the trainer as undeliverable instead.
 */
async function resolveInjectTargeting(
  sessionId: string,
  injectScope: string | undefined,
  targetTeams: string[] | undefined,
  orgKey?: string | null,
): Promise<TeamTargeting | null> {
  const teamScoped = injectScope === 'team_specific' && !!targetTeams && targetTeams.length > 0;
  if (!teamScoped && !orgKey) return null;

  let playerIds: string[] | null = teamScoped
    ? await resolveTeamMembers(sessionId, targetTeams!, { orgKey })
    : null;

  // Contract §4.1: `delivery_config.org_key` restricts delivery to that organisation's members.
  if (orgKey) {
    try {
      const { getOrgMemberUserIds } = await import('./orgRegistryService.js');
      const orgMembers = new Set(await getOrgMemberUserIds(sessionId, orgKey));
      playerIds = playerIds ? playerIds.filter((id) => orgMembers.has(id)) : Array.from(orgMembers);
    } catch (err) {
      logger.warn(
        { err, sessionId, orgKey },
        'org_key targeting failed; falling back to team targeting',
      );
    }
  }

  return {
    playerIds: playerIds ?? [],
    teamNames: teamScoped ? targetTeams! : [orgKey ? `org:${orgKey}` : 'all'],
  };
}

async function reportUndeliverableInject(
  sessionId: string,
  injectId: string,
  injectTitle: string,
  teamNames: string[],
): Promise<void> {
  logger.warn(
    { sessionId, injectId, teamNames },
    'Team-scoped inject has no team members; withheld from session (trainer alerted)',
  );
  try {
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('trainer_id')
      .eq('id', sessionId)
      .single();
    await supabaseAdmin.from('session_events').insert({
      session_id: sessionId,
      event_type: 'trainer_alert',
      description: `Undeliverable inject "${injectTitle}": no players assigned to ${teamNames.join(', ')}`,
      actor_id: session?.trainer_id || null,
      metadata: { inject_id: injectId, target_teams: teamNames, reason: 'unstaffed_team' },
    });
    if (session?.trainer_id) {
      getWebSocketService().emitToUser(session.trainer_id, {
        type: 'inject.undeliverable',
        data: { inject_id: injectId, title: injectTitle, target_teams: teamNames },
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err) {
    logger.error({ err, sessionId, injectId }, 'Failed to report undeliverable inject');
  }
}

/**
 * Broadcast a scoped event only to the targeted players plus the trainer,
 * instead of the whole session room (no cross-team leakage over websockets).
 */
async function emitScoped(
  sessionId: string,
  playerIds: string[] | null,
  event: { type: string; data: Record<string, unknown>; timestamp: string },
): Promise<void> {
  const ws = getWebSocketService();
  if (!playerIds) {
    ws.broadcastToSession(sessionId, event);
    return;
  }
  const recipients = new Set(playerIds);
  try {
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('trainer_id')
      .eq('id', sessionId)
      .single();
    if (session?.trainer_id) recipients.add(session.trainer_id);
  } catch {
    /* trainer lookup best-effort */
  }
  for (const userId of recipients) {
    ws.emitToUser(userId, event);
  }
}

/**
 * Who will actually receive this inject in their apps. Mirrors the targeting `routeInjectToApp`
 * and `routeToEmail` apply (team scope, org_key for private apps, the email `stakeholder_team`
 * routing preference), so notifications can follow delivery instead of announcing a private
 * email to the whole session (docs/session-bugfix-spec-2026-09-20.md §14).
 *
 * Returns null for session-wide delivery, [] when the target teams are unstaffed (undeliverable —
 * nobody should be notified), otherwise the concrete recipient user ids.
 */
export async function resolveInjectRecipients(
  sessionId: string,
  inject: {
    delivery_config: DeliveryConfig | null;
    inject_scope?: string;
    target_teams?: string[] | null;
  },
): Promise<string[] | null> {
  const config = inject.delivery_config;
  if (!config) return null;
  const privateApp = isPrivateDeliveryApp(config.app);
  const targeting = await resolveInjectTargeting(
    sessionId,
    inject.inject_scope,
    inject.target_teams ?? undefined,
    privateApp ? (config.org_key ?? null) : null,
  );
  if (targeting) return targeting.playerIds ?? [];
  if (config.app === 'email' && config.stakeholder_team) {
    try {
      const members = await resolveTeamMembers(sessionId, [config.stakeholder_team]);
      if (members.length > 0) return members;
    } catch (err) {
      logger.debug({ err, sessionId }, 'stakeholder_team recipient resolution failed');
    }
  }
  return null;
}

export async function routeInjectToApp(
  sessionId: string,
  injectId: string,
  inject: {
    title: string;
    content: string;
    type: string;
    severity: string;
    delivery_config: DeliveryConfig | null;
    requires_response?: boolean;
    trigger_time_minutes?: number | null;
    inject_scope?: string;
    target_teams?: string[];
  },
): Promise<void> {
  const config = inject.delivery_config;
  if (!config?.app) return;

  try {
    // org_key only scopes private delivery (email / phone / chat / DMs). Public content
    // (social_feed / news) is public; its visibility is governed by `country` (contract §4.1).
    const privateApp = isPrivateDeliveryApp(config.app);
    let targeting = await resolveInjectTargeting(
      sessionId,
      inject.inject_scope,
      inject.target_teams,
      privateApp ? (config.org_key ?? null) : null,
    );

    if (targeting && targeting.playerIds && targeting.playerIds.length === 0) {
      await reportUndeliverableInject(sessionId, injectId, inject.title, targeting.teamNames);
      return;
    }

    const roleRoute = await routeRoleMessage({
      sessionId,
      app: config.app,
      config: config as unknown as Record<string, unknown>,
      teamNames: targeting?.teamNames ?? inject.target_teams ?? [],
      resolvedUserIds: targeting?.playerIds ?? null,
    });
    if (roleRoute?.playerIds && roleRoute.playerIds.length === 0) {
      await reportUndeliverableInject(sessionId, injectId, inject.title, roleRoute.teamNames);
      return;
    }
    if (roleRoute) {
      targeting = {
        playerIds: roleRoute.playerIds,
        teamNames: roleRoute.teamNames.length > 0 ? roleRoute.teamNames : (targeting?.teamNames ?? []),
        mention: roleRoute.mention,
        targetRoleId: roleRoute.targetRoleId,
        lineTeam: roleRoute.lineTeam,
        fallbackReason: roleRoute.fallbackReason ?? null,
      };
    }

    switch (config.app) {
      case 'social_feed':
        await routeToSocialFeed(sessionId, injectId, inject, config, targeting);
        break;
      case 'email':
        await routeToEmail(sessionId, injectId, inject, config, targeting);
        break;
      case 'news':
        await routeToNews(sessionId, injectId, inject, config);
        break;
      case 'group_chat':
        await routeToGroupChat(sessionId, injectId, inject, config, targeting);
        break;
      case 'phone_call':
        await routeToPhoneCall(sessionId, injectId, inject, config, targeting);
        break;
      case 'messenger_dm':
        await routeToMessengerDm(sessionId, injectId, inject, config, targeting);
        break;
      case 'npc_dm':
        await routeToNpcDm(sessionId, injectId, inject, config, targeting);
        break;
      default:
        logger.warn({ app: config.app, injectId }, 'Unknown delivery_config app');
    }
  } catch (err) {
    logger.error({ err, sessionId, injectId, app: config.app }, 'Feed engine routing failed');
  }
}

async function routeToSocialFeed(
  sessionId: string,
  injectId: string,
  inject: { title: string; content: string; severity: string; requires_response?: boolean },
  config: DeliveryConfig,
  targeting: TeamTargeting | null = null,
): Promise<void> {
  const hashtags = inject.content.match(/#\w+/g) || [];
  const seed = config.engagement_seed || {};

  // Fallback: if no author specified, pick a random NPC from the scenario
  let authorHandle = config.author_handle || '';
  let authorName = config.author_display_name || '';
  let authorType = config.author_type || 'npc_public';

  if (!authorHandle || authorHandle === '@system' || !authorName || authorName === 'System') {
    try {
      const { data: sessionRow } = await supabaseAdmin
        .from('sessions')
        .select('scenario_id')
        .eq('id', sessionId)
        .single();
      if (sessionRow?.scenario_id) {
        const { data: scenario } = await supabaseAdmin
          .from('scenarios')
          .select('initial_state')
          .eq('id', sessionRow.scenario_id)
          .single();
        const personas = ((scenario?.initial_state as Record<string, unknown>)?.npc_personas ||
          []) as Array<Record<string, unknown>>;
        if (personas.length > 0) {
          const picked = personas[Math.floor(Math.random() * personas.length)];
          authorHandle = String(picked.handle || '@npc');
          authorName = String(picked.name || 'NPC');
          authorType = String(picked.type || 'npc_public');
        }
      }
    } catch {
      /* use defaults */
    }
    if (!authorHandle || authorHandle === '@system') authorHandle = '@npc_user';
    if (!authorName || authorName === 'System') authorName = 'User';
  }

  const { data: post, error } = await supabaseAdmin
    .from('social_posts')
    .insert({
      session_id: sessionId,
      inject_id: injectId,
      platform: config.platform || 'x_twitter',
      author_handle: authorHandle,
      author_display_name: authorName,
      author_type: authorType,
      content: inject.content,
      hashtags,
      like_count: seed.likes || 0,
      repost_count: seed.reposts || 0,
      reply_count: seed.replies || 0,
      view_count: Math.floor((seed.likes || 0) * 3.5),
      sentiment: determineSentiment(config.content_flags),
      content_flags: config.content_flags || {},
      virality_score: config.virality_score || 0,
      requires_response: inject.requires_response || false,
      media_urls: (config as unknown as Record<string, unknown>).media_urls || [],
      // Team-scoped injects deliver only to the resolved team members via the
      // existing per-player targeting filter.
      ...(targeting?.playerIds
        ? { target_player_ids: targeting.playerIds, is_surfaced_to_session: false }
        : {}),
      // Contract §4.1: country-scoped feed visibility (column from migration 202).
      ...(config.country ? { country: config.country } : {}),
    })
    .select()
    .single();

  if (error) {
    logger.error({ error, sessionId, injectId }, 'Failed to create social post from inject');
    return;
  }

  await emitScoped(sessionId, targeting?.playerIds ?? null, {
    type: 'social_post.created',
    data: { post },
    timestamp: new Date().toISOString(),
  });

  logger.info({ sessionId, injectId, postId: post.id }, 'Inject routed to social feed');

  if (shouldLedgerSocial(inject.requires_response, config)) {
    await ledgerDelivery({
      sessionId,
      injectId,
      injectKey: injectKeyOf({ id: injectId, delivery_config: config }),
      channel: 'social',
      refTable: 'social_posts',
      refId: String(post.id),
      recipientUserIds: targeting?.playerIds ?? null,
      recipientTeams: targeting?.teamNames ?? [],
      stakeholderId: config.stakeholder_id ?? null,
      senderName: authorName,
      requiresResponse: inject.requires_response === true,
      responseWindowMinutes: responseWindowMinutes(config),
      deliveredAt: timestampOf(post.created_at),
    }, config);
  }

  if (config.spawn_replies && config.spawn_replies > 0 && env.aiEnabled) {
    void spawnNPCReplies(sessionId, post, config).catch((err) =>
      logger.warn({ err, postId: post.id }, 'Failed to spawn NPC replies'),
    );
  }
}

async function spawnNPCReplies(
  sessionId: string,
  parentPost: Record<string, unknown>,
  config: DeliveryConfig,
): Promise<void> {
  const count = Math.min(config.spawn_replies || 3, 8);
  const dist = config.reply_sentiment_distribution || {
    neutral: 0.5,
    negative: 0.3,
    supportive: 0.2,
  };

  const { data: scenario } = await supabaseAdmin
    .from('sessions')
    .select('scenarios!inner(initial_state)')
    .eq('id', sessionId)
    .single();

  const initialState = ((scenario as Record<string, unknown>)?.scenarios as Record<string, unknown>)
    ?.initial_state as Record<string, unknown> | undefined;
  const npcPersonas = (initialState?.npc_personas || []) as Array<Record<string, unknown>>;
  const npcContext = npcPersonas
    .slice(0, 6)
    .map((p) => `${String(p.handle)} (${String(p.name)}): ${String(p.personality)}`)
    .join('; ');

  try {
    const parsed = await chatJson<Record<string, unknown> | Array<Record<string, unknown>>>({
      tier: 'standard',
      json: true,
      temperature: 0.85,
      maxTokens: 2000,
      label: 'feedEngine.replies',
      messages: [
        {
          role: 'system',
          content: `Generate ${count} realistic reply tweets to a social media post. The replies should feel like real X/Twitter replies during a crisis.

Sentiment distribution: ${Object.entries(dist)
            .map(([k, v]) => `${k}: ${Math.round(Number(v) * 100)}%`)
            .join(', ')}

${npcContext ? `Available personas: ${npcContext}` : ''}

Each reply should be 1-3 sentences. Include a mix of reactions: agreement, disagreement, emotional responses, questions, sharing personal experiences.

Return ONLY valid JSON:
{ "replies": [{ "author_handle": "@username", "author_display_name": "Name", "content": "reply text", "sentiment": "neutral|negative|supportive|hateful|inflammatory" }] }`,
        },
        {
          role: 'user',
          content: `Original post by ${String(parentPost.author_handle)}:\n"${String(parentPost.content)}"`,
        },
      ],
    });

    if (!parsed) return;
    const replies: Array<Record<string, unknown>> = Array.isArray(parsed)
      ? parsed
      : ((parsed.replies as Array<Record<string, unknown>> | undefined) ?? []);

    const replyBatch = replies.slice(0, count);
    for (let ri = 0; ri < replyBatch.length; ri++) {
      if (ri > 0) await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 4000)));
      const reply = replyBatch[ri];
      const { data: replyPost, error: replyErr } = await supabaseAdmin
        .from('social_posts')
        .insert({
          session_id: sessionId,
          platform: String(parentPost.platform || config.platform || 'x_twitter'),
          author_handle: reply.author_handle || '@anon_user',
          author_display_name: reply.author_display_name || 'Anonymous',
          author_type: 'npc_public',
          content: reply.content,
          reply_to_post_id: parentPost.id,
          sentiment: reply.sentiment || 'neutral',
          like_count: Math.floor(Math.random() * 50),
          repost_count: Math.floor(Math.random() * 10),
          reply_count: 0,
          view_count: Math.floor(Math.random() * 500),
          hashtags: (reply.content as string).match(/#\w+/g) || [],
          content_flags: {},
          virality_score: Math.floor(Math.random() * 30),
        })
        .select()
        .single();

      if (!replyErr && replyPost) {
        await supabaseAdmin
          .from('social_posts')
          .update({ reply_count: ((parentPost.reply_count as number) || 0) + 1 })
          .eq('id', parentPost.id);

        getWebSocketService().broadcastToSession(sessionId, {
          type: 'social_post.created',
          data: { post: replyPost },
          timestamp: new Date().toISOString(),
        });
      }
    }

    logger.info(
      { sessionId, parentPostId: parentPost.id, repliesSpawned: replies.length },
      'NPC replies spawned',
    );
  } catch (err) {
    logger.error({ err, sessionId }, 'NPC reply generation failed');
  }
}

export const VALID_EMAIL_CATEGORIES = new Set([
  'general',
  'verified_facts',
  'communication_boundaries',
  'approval_chain',
  'legal_advisory',
  'stakeholder_priority',
  'resource_authorization',
  'sitrep_request',
  'stand_down_pivot',
  'leak_notice',
]);

export function sanitizeEmailCategory(category: string | undefined | null): string {
  if (category && VALID_EMAIL_CATEGORIES.has(category)) return category;
  return 'general';
}

async function routeToEmail(
  sessionId: string,
  injectId: string,
  inject: { title: string; content: string; requires_response?: boolean },
  config: DeliveryConfig,
  targeting: TeamTargeting | null = null,
): Promise<void> {
  const lines = inject.content.split('\n');
  const subjectLine = lines.find((l) => l.startsWith('Subject:'));
  const subject = subjectLine ? subjectLine.replace('Subject:', '').trim() : inject.title;
  const bodyText = lines
    .filter((l) => !l.startsWith('Subject:'))
    .join('\n')
    .trim();

  // Stakeholder routing: a universal email tagged with the team that owns
  // this stakeholder relationship lands only in that team's inboxes. Unlike
  // team_specific intel, this is a routing preference, not a secret — when
  // the tagged team is unstaffed the email falls back to session-wide
  // delivery instead of being withheld.
  let effectiveTargeting = targeting;
  if (!effectiveTargeting && config.stakeholder_team) {
    try {
      const members = await resolveTeamMembers(sessionId, [config.stakeholder_team]);
      if (members.length > 0) {
        effectiveTargeting = { playerIds: members, teamNames: [config.stakeholder_team] };
        logger.info(
          { sessionId, injectId, stakeholderTeam: config.stakeholder_team },
          'Email routed to stakeholder-owning team',
        );
      }
    } catch (err) {
      logger.warn(
        { err, sessionId, injectId },
        'Stakeholder team resolution failed; delivering session-wide',
      );
    }
  }

  const { data: email, error } = await supabaseAdmin
    .from('sim_emails')
    .insert({
      session_id: sessionId,
      inject_id: injectId,
      direction: 'inbound',
      from_address: config.from_address || 'system@sim.local',
      from_name: config.from_name || 'System',
      to_addresses: ['team@crisisresponse.sim'],
      subject,
      body_html: `<p>${bodyText.replace(/\n/g, '</p><p>')}</p>`,
      body_text: bodyText,
      priority: config.priority || 'normal',
      email_category: sanitizeEmailCategory(config.email_category),
      ...(config.chain?.thread_id
        ? {
            thread_id: config.chain.thread_id,
            replied_to_id: config.chain.replied_to_id ?? config.chain.thread_id,
          }
        : {}),
      // Team-scoped emails are addressed to the resolved members only; null
      // means visible to the whole session (legacy behaviour).
      ...(effectiveTargeting?.playerIds
        ? {
            recipient_user_ids: effectiveTargeting.playerIds,
            target_teams: effectiveTargeting.teamNames,
          }
        : {}),
    })
    .select()
    .single();

  if (error) {
    logger.error({ error, sessionId, injectId }, 'Failed to create email from inject');
    return;
  }

  const recipientTeams =
    effectiveTargeting?.teamNames && effectiveTargeting.teamNames.length > 0
      ? effectiveTargeting.teamNames
      : config.stakeholder_team
        ? [config.stakeholder_team]
        : [];
  await ledgerDelivery({
    sessionId,
    injectId,
    injectKey: injectKeyOf({ id: injectId, delivery_config: config }),
    channel: 'email',
    refTable: 'sim_emails',
    refId: String(email.id),
    threadId: config.chain?.thread_id ?? String(email.id),
    ...roleLedger(effectiveTargeting),
    recipientUserIds: effectiveTargeting?.playerIds ?? null,
    recipientTeams,
    stakeholderId: config.stakeholder_id ?? null,
    senderName: config.from_name || 'System',
    requiresResponse: inject.requires_response === true,
    responseWindowMinutes: responseWindowMinutes(config),
    deliveredAt: timestampOf(email.created_at),
  }, config);

  await emitScoped(sessionId, effectiveTargeting?.playerIds ?? null, {
    type: 'sim_email.received',
    data: { email },
    timestamp: new Date().toISOString(),
  });

  logger.info({ sessionId, injectId, emailId: email.id }, 'Inject routed to email');
}

async function routeToNews(
  sessionId: string,
  injectId: string,
  inject: { title: string; content: string },
  config: DeliveryConfig,
): Promise<void> {
  const { data: article, error } = await supabaseAdmin
    .from('sim_news_articles')
    .insert({
      session_id: sessionId,
      inject_id: injectId,
      outlet_name: config.outlet_name || 'News Wire',
      headline: config.headline || inject.title,
      body: inject.content,
      category: config.category || 'breaking',
      // Contract §4.1: country-scoped News visibility (column from migration 202).
      ...(config.country ? { country: config.country } : {}),
    })
    .select()
    .single();

  if (error) {
    logger.error({ error, sessionId, injectId }, 'Failed to create news article from inject');
    return;
  }

  await ledgerDelivery({
    sessionId,
    injectId,
    injectKey: injectKeyOf({ id: injectId, delivery_config: config }),
    channel: 'news',
    refTable: 'sim_news_articles',
    refId: String(article.id),
    recipientUserIds: null,
    recipientTeams: [],
    stakeholderId: config.stakeholder_id ?? null,
    senderName: config.outlet_name || 'News Wire',
    requiresResponse: false,
    responseWindowMinutes: responseWindowMinutes(config),
  }, config);

  getWebSocketService().broadcastToSession(sessionId, {
    type: 'news_article.published',
    data: { article },
    timestamp: new Date().toISOString(),
  });

  logger.info({ sessionId, injectId, articleId: article.id }, 'Inject routed to news');

  const outletName = config.outlet_name || 'News Wire';
  const outletHandle =
    '@' +
    outletName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '');
  const headline = config.headline || inject.title;
  const category = config.category || 'breaking';
  const categoryLabel = category === 'breaking' ? 'BREAKING' : category.toUpperCase();
  const snippet = inject.content.substring(0, 150);

  const xContent = `${categoryLabel}: ${headline}\n\nnews.sim/${article.id.slice(0, 8)}`;
  const fbContent = `📰 ${headline}\n\n"${snippet}..."\n\n— ${outletName}`;

  const sharedArticleFlags = {
    shared_article: {
      id: article.id,
      headline,
      outlet_name: outletName,
      snippet,
      category,
    },
  };

  const platforms = [
    { platform: 'x_twitter', content: xContent },
    { platform: 'facebook', content: fbContent },
  ];

  for (const { platform, content: postContent } of platforms) {
    const { data: socialPost, error: spError } = await supabaseAdmin
      .from('social_posts')
      .insert({
        session_id: sessionId,
        inject_id: injectId,
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
        ...(config.country ? { country: config.country } : {}),
      })
      .select()
      .single();

    if (spError) {
      logger.warn({ error: spError, platform }, 'Failed to dual-publish news to social feed');
    } else if (socialPost) {
      getWebSocketService().broadcastToSession(sessionId, {
        type: 'social_post.created',
        data: { post: socialPost },
        timestamp: new Date().toISOString(),
      });
    }
  }
}

async function routeToGroupChat(
  sessionId: string,
  injectId: string,
  inject: { content: string; requires_response?: boolean },
  config: DeliveryConfig,
  targeting: TeamTargeting | null = null,
): Promise<void> {
  const spoken = targeting?.mention ? { ...inject, content: `${targeting.mention}${inject.content}` } : inject;
  const channels = await postNpcChatMessage(
    sessionId,
    injectId,
    groupChatMessage(spoken, config),
    config.channel_type,
    targeting,
    { requiresResponse: inject.requires_response === true, config },
  );
  logger.info({ sessionId, injectId, channels }, 'Inject routed to group chat');
}

/**
 * Persist an NPC line in the chat channels an inject targets and broadcast it. Team- or
 * org-scoped injects land in the `team` channels of the targeted players (there is no org-wide
 * channel); otherwise the session channel by type. Returns the number of channels written.
 */
async function postNpcChatMessage(
  sessionId: string,
  injectId: string,
  message: NpcChatMessage,
  channelType: string | undefined,
  targeting: TeamTargeting | null,
  options: { requiresResponse: boolean; config: DeliveryConfig },
): Promise<number> {
  const { data: trainer } = await supabaseAdmin
    .from('sessions')
    .select('trainer_id')
    .eq('id', sessionId)
    .single();
  if (!trainer) return 0;

  let channels: Array<{ id: string; team_name: string | null }> = [];
  if (targeting?.playerIds && targeting.playerIds.length > 0) {
    const { data: teamRows } = await supabaseAdmin
      .from('session_teams')
      .select('team_name')
      .eq('session_id', sessionId)
      .in('user_id', targeting.playerIds);
    const teamNames = selectInjectTeamChannels(
      (teamRows ?? []).map((r) => String((r as { team_name: string }).team_name)),
      targeting.teamNames,
    );
    if (teamNames.length > 0) {
      const { ensureTeamChannels } = await import('./channelService.js');
      await ensureTeamChannels(sessionId, trainer.trainer_id as string | null);
      const { data: teamChannels } = await supabaseAdmin
        .from('chat_channels')
        .select('id, team_name')
        .eq('session_id', sessionId)
        .eq('type', 'team')
        .in('team_name', teamNames);
      channels = (teamChannels ?? []).map((c) => ({
        id: String((c as { id: string }).id),
        team_name: ((c as { team_name?: string | null }).team_name as string | null) ?? null,
      }));
    }
    // Team-only content must not fall back to a session-wide channel.
    if (channels.length === 0) {
      logger.warn(
        { sessionId, injectId, teamNames: targeting.teamNames },
        'No team channel for scoped chat inject; not delivered',
      );
      return 0;
    }
  } else {
    const type = channelType || 'public';
    const { data: channel } = await supabaseAdmin
      .from('chat_channels')
      .select('id, team_name')
      .eq('session_id', sessionId)
      .eq('type', type)
      .limit(1)
      .maybeSingle();
    if (!channel) {
      logger.warn({ sessionId, injectId, channelType: type }, 'No channel found for chat inject');
      return 0;
    }
    channels = [
      {
        id: String(channel.id),
        team_name: (channel.team_name as string | null) ?? null,
      },
    ];
  }

  // The NPC speaks as itself (migration 199: sender_id may be null when a stakeholder sender is
  // set). Never attribute NPC lines to the trainer's account
  // (docs/session-bugfix-spec-2026-09-20.md §1).
  let written = 0;
  for (const channel of channels) {
    const { data: row, error } = await insertNpcChatRow(
      {
        channel_id: channel.id,
        session_id: sessionId,
        sender_id: null,
        ...message,
      },
      injectId,
    );

    if (error || !row) {
      logger.error(
        { error, sessionId, injectId, channelId: channel.id },
        'Failed to create chat message from inject',
      );
      continue;
    }
    await ledgerDelivery({
      sessionId,
      injectId,
      injectKey: injectKeyOf({ id: injectId, delivery_config: options.config }),
      channel: 'chat',
      refTable: 'chat_messages',
      refId: String(row.id),
      chatChannelId: channel.id,
      recipientUserIds: targeting?.playerIds ?? null,
      recipientTeams: targeting?.targetRoleId
        ? []
        : channel.team_name
          ? [channel.team_name]
          : (targeting?.teamNames ?? []),
      ...roleLedger(targeting),
      stakeholderId: options.config.stakeholder_id ?? null,
      senderName: message.sender_display_name,
      requiresResponse: options.requiresResponse,
      responseWindowMinutes: responseWindowMinutes(options.config),
      deliveredAt: timestampOf(row.created_at),
    }, options.config);
    written++;
    getWebSocketService().messageSent(channel.id, row);
  }
  return written;
}

/**
 * Migration 268 adds `chat_messages.inject_id`. Until that column exists, PostgREST
 * rejects the insert; the chat line is saved again without it.
 */
async function insertNpcChatRow(
  row: Record<string, unknown>,
  injectId: string,
): Promise<{ data: Record<string, unknown> | null; error: { code?: string } | null }> {
  const payload = chatInjectIdColumnMissing() ? row : { ...row, inject_id: injectId };
  const first = await supabaseAdmin.from('chat_messages').insert(payload).select().single();
  if (!first.error && first.data) {
    return { data: first.data as Record<string, unknown>, error: null };
  }
  const code = ledgerErrorCode(first.error);
  if (!chatInjectIdColumnMissing() && (code === '42703' || code === 'PGRST204')) {
    markChatInjectIdColumnMissing();
    const second = await supabaseAdmin.from('chat_messages').insert(row).select().single();
    return {
      data: (second.data as Record<string, unknown> | null) ?? null,
      error: second.error,
    };
  }
  return { data: null, error: first.error };
}

async function routeToPhoneCall(
  sessionId: string,
  injectId: string,
  inject: { title: string; content: string; requires_response?: boolean },
  config: DeliveryConfig,
  targeting: TeamTargeting | null = null,
): Promise<void> {
  if (env.simPhoneApp !== 'off') {
    const started = await startInjectCall(
      sessionId,
      {
        id: injectId,
        title: inject.title,
        content: inject.content,
        requires_response: inject.requires_response,
        delivery_config: config as unknown as Record<string, unknown>,
      },
      targeting,
    );
    if (started === 'started') {
      logger.info({ sessionId, injectId }, 'Inject routed to phone call');
      return;
    }
  }
  await deliverPhoneChatLine(sessionId, injectId, inject, config, targeting);
}

/** PR 136 path: a persisted chat line, used when the Phone app is off or the call tables are absent. */
async function deliverPhoneChatLine(
  sessionId: string,
  injectId: string,
  inject: { title: string; content: string; requires_response?: boolean },
  config: DeliveryConfig,
  targeting: TeamTargeting | null,
): Promise<void> {
  const caller = phoneCaller(config);
  await emitScoped(sessionId, targeting?.playerIds ?? null, {
    type: 'phone_call.incoming',
    data: {
      inject_id: injectId,
      caller_name: caller.name ?? UNKNOWN_CALLER,
      title: inject.title,
      caller_number: caller.number,
      dialogue: inject.content,
    },
    timestamp: new Date().toISOString(),
  });
  const channels = await postNpcChatMessage(
    sessionId,
    injectId,
    phoneCallMessage(inject, config),
    config.channel_type,
    targeting,
    { requiresResponse: inject.requires_response === true, config },
  );
  logger.info({ sessionId, injectId, channels }, 'Inject routed to phone call chat line');
}

export async function deliverMissedCallLine(input: {
  sessionId: string;
  injectId: string;
  inject: { id?: string; title: string; content: string; requires_response?: boolean };
  config: DeliveryConfig;
  targeting: TeamTargeting | null;
  message: NpcChatMessage;
}): Promise<number> {
  return postNpcChatMessage(
    input.sessionId,
    input.injectId,
    input.message,
    input.config.channel_type,
    input.targeting,
    { requiresResponse: input.inject.requires_response === true, config: input.config },
  );
}

function isPrivateDeliveryApp(app: DeliveryConfig['app']): boolean {
  return (
    app === 'email' ||
    app === 'phone_call' ||
    app === 'group_chat' ||
    app === 'messenger_dm' ||
    app === 'npc_dm'
  );
}

/**
 * Team- or org-scoped DMs go to those players. A session-wide DM goes to every participant,
 * matching a null result from resolveInjectRecipients (notify everyone).
 */
async function dmRecipientUserIds(
  sessionId: string,
  targeting: TeamTargeting | null,
): Promise<string[]> {
  if (targeting?.playerIds && targeting.playerIds.length > 0) {
    return [...new Set(targeting.playerIds)];
  }
  if (targeting) return [];
  const { data, error } = await supabaseAdmin
    .from('session_participants')
    .select('user_id')
    .eq('session_id', sessionId);
  if (error) {
    logger.warn({ error, sessionId }, 'Failed to load DM recipients');
    return [];
  }
  return [...new Set((data ?? []).map((row) => row.user_id).filter((id): id is string => !!id))];
}

async function loadDmProfiles(
  userIds: string[],
): Promise<Array<{ userId: string; displayName: string }>> {
  if (userIds.length === 0) return [];
  const { data, error } = await supabaseAdmin
    .from('user_profiles')
    .select('id, full_name')
    .in('id', userIds);
  if (error) {
    logger.warn({ error }, 'Failed to load DM recipient names');
  }
  const names = new Map<string, string>();
  for (const row of data ?? []) {
    const id = String((row as { id: string }).id);
    const fullName = (row as { full_name?: string | null }).full_name;
    if (typeof fullName === 'string' && fullName.trim()) names.set(id, fullName.trim());
  }
  return userIds.map((userId) => ({
    userId,
    displayName: names.get(userId) || 'Player',
  }));
}

async function findMessengerThread(
  sessionId: string,
  senderHandle: string,
  recipientHandle: string,
): Promise<string | null> {
  if (/["\\]/.test(senderHandle) || /["\\]/.test(recipientHandle)) return null;
  const { data, error } = await supabaseAdmin
    .from('sim_direct_messages')
    .select('thread_id')
    .eq('session_id', sessionId)
    .or(
      `and(sender_handle.eq."${senderHandle}",recipient_handle.eq."${recipientHandle}"),and(sender_handle.eq."${recipientHandle}",recipient_handle.eq."${senderHandle}")`,
    )
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.warn({ error, sessionId }, 'Messenger thread lookup failed; opening a new thread');
    return null;
  }
  const threadId = data?.thread_id;
  return typeof threadId === 'string' && threadId ? threadId : null;
}

async function insertMessengerRow(
  row: Record<string, unknown>,
  injectId: string,
): Promise<Record<string, unknown> | null> {
  const payload = directMessageInjectIdColumnMissing() ? row : { ...row, inject_id: injectId };
  const first = await supabaseAdmin.from('sim_direct_messages').insert(payload).select().single();
  if (!first.error && first.data) return first.data as Record<string, unknown>;
  const code = ledgerErrorCode(first.error);
  if (!directMessageInjectIdColumnMissing() && (code === '42703' || code === 'PGRST204')) {
    markDirectMessageInjectIdColumnMissing();
    const second = await supabaseAdmin.from('sim_direct_messages').insert(row).select().single();
    if (!second.error && second.data) return second.data as Record<string, unknown>;
    logger.error({ error: second.error, injectId }, 'Failed to insert messenger DM');
    return null;
  }
  logger.error({ error: first.error, injectId }, 'Failed to insert messenger DM');
  return null;
}

async function routeToMessengerDm(
  sessionId: string,
  injectId: string,
  inject: { content: string; requires_response?: boolean },
  config: DeliveryConfig,
  targeting: TeamTargeting | null,
): Promise<void> {
  const senderHandle = config.author_handle?.trim();
  if (!senderHandle) {
    logger.warn(
      { sessionId, injectId, event: 'messenger_dm_missing_handle' },
      'messenger_dm inject has no author_handle; not delivered',
    );
    return;
  }
  const userIds = await dmRecipientUserIds(sessionId, targeting);
  if (userIds.length === 0) {
    logger.warn({ sessionId, injectId }, 'messenger_dm inject has no recipients; not delivered');
    return;
  }
  const profiles = await loadDmProfiles(userIds);
  const recipients: MessengerRecipient[] = [];
  for (const profile of profiles) {
    const handle = handleFor(profile.displayName);
    recipients.push({
      userId: profile.userId,
      handle,
      threadId: await findMessengerThread(sessionId, senderHandle, handle),
    });
  }
  const rows = buildMessengerDmRows(inject, config, recipients, () => randomUUID());
  let written = 0;
  for (const row of rows) {
    const inserted = await insertMessengerRow(
      {
        session_id: sessionId,
        thread_id: row.thread_id,
        sender_handle: row.sender_handle,
        sender_display_name: row.sender_display_name,
        sender_type: row.sender_type,
        recipient_handle: row.recipient_handle,
        recipient_user_id: row.recipient_user_id,
        content: row.content,
        media_urls: [],
        is_read: false,
        platform: row.platform,
      },
      injectId,
    );
    if (!inserted) continue;
    await ledgerDelivery({
      sessionId,
      injectId,
      injectKey: injectKeyOf({ id: injectId, delivery_config: config }),
      channel: 'messenger_dm',
      refTable: 'sim_direct_messages',
      refId: String(inserted.id),
      threadId: row.thread_id,
      recipientUserIds: targeting?.playerIds ?? null,
      recipientTeams: targeting?.targetRoleId ? [] : (targeting?.teamNames ?? []),
      ...roleLedger(targeting),
      stakeholderId: config.stakeholder_id ?? null,
      senderName: row.sender_display_name,
      requiresResponse: inject.requires_response === true,
      responseWindowMinutes: responseWindowMinutes(config),
      deliveredAt: timestampOf(inserted.created_at),
    }, config);
    await emitScoped(sessionId, [row.recipient_user_id], {
      type: 'messenger.received',
      data: { user_id: row.recipient_user_id, message: inserted },
      timestamp: new Date().toISOString(),
    });
    written++;
  }
  logger.info({ sessionId, injectId, written }, 'Inject routed to messenger DM');
}

async function routeToNpcDm(
  sessionId: string,
  injectId: string,
  inject: { content: string; requires_response?: boolean },
  config: DeliveryConfig,
  targeting: TeamTargeting | null,
): Promise<void> {
  const stakeholderId = config.stakeholder_id?.trim();
  if (!stakeholderId) {
    logger.warn(
      { sessionId, injectId, event: 'npc_dm_missing_stakeholder' },
      'npc_dm inject has no stakeholder_id; not delivered',
    );
    return;
  }
  const userIds = await dmRecipientUserIds(sessionId, targeting);
  if (userIds.length === 0) {
    logger.warn({ sessionId, injectId }, 'npc_dm inject has no recipients; not delivered');
    return;
  }
  const drafted = groupChatMessage(inject, config);
  let written = 0;
  for (const userId of userIds) {
    const channel = await ensureNpcDirectChannel(sessionId, userId, stakeholderId);
    if (!channel) continue;
    const message =
      drafted.sender_display_name === 'NPC'
        ? { ...drafted, sender_display_name: channel.name }
        : drafted;
    const { data: row, error } = await insertNpcChatRow(
      {
        channel_id: channel.id,
        session_id: sessionId,
        sender_id: null,
        ...message,
      },
      injectId,
    );
    if (error || !row) {
      logger.error({ error, sessionId, injectId, userId }, 'Failed to create NPC DM from inject');
      continue;
    }
    await ledgerDelivery({
      sessionId,
      injectId,
      injectKey: injectKeyOf({ id: injectId, delivery_config: config }),
      channel: 'npc_dm',
      refTable: 'chat_messages',
      refId: String(row.id),
      chatChannelId: channel.id,
      recipientUserIds: targeting?.playerIds ?? null,
      recipientTeams: targeting?.targetRoleId ? [] : (targeting?.teamNames ?? []),
      ...roleLedger(targeting),
      stakeholderId,
      senderName: message.sender_display_name,
      requiresResponse: inject.requires_response === true,
      responseWindowMinutes: responseWindowMinutes(config),
      deliveredAt: timestampOf(row.created_at),
    }, config);
    getWebSocketService().emitToUser(userId, {
      type: 'message.sent',
      data: { message: row },
      timestamp: new Date().toISOString(),
    });
    written++;
  }
  logger.info({ sessionId, injectId, written }, 'Inject routed to NPC DM');
}

function roleLedger(targeting: TeamTargeting | null | undefined): {
  targetRoleId: string | null;
  lineTeam: string | null;
  fallbackReason: string | null;
} {
  return {
    targetRoleId: targeting?.targetRoleId ?? null,
    lineTeam: targeting?.lineTeam ?? null,
    fallbackReason: targeting?.fallbackReason ?? null,
  };
}

function responseWindowMinutes(config: DeliveryConfig): number | null {
  const value = config.response_window_minutes;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function shouldLedgerSocial(
  requiresResponse: boolean | undefined,
  config: DeliveryConfig,
): boolean {
  if (requiresResponse) return true;
  return typeof config.inject_key === 'string' && isValidInjectKey(config.inject_key);
}

function timestampOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function ledgerDelivery(
  input: RecordDeliveryInput,
  config?: DeliveryConfig | null,
): Promise<void> {
  try {
    await recordDelivery({ ...input, ...chainLedgerFields(config) });
  } catch (err) {
    logger.warn(
      { err, injectId: input.injectId, refId: input.refId },
      'ledger delivery record failed',
    );
  }
}

function determineSentiment(flags: Record<string, unknown> | undefined): string {
  if (!flags) return 'neutral';
  if (flags.is_hate_speech || flags.incites_violence) return 'hateful';
  if (flags.is_racist || flags.is_inflammatory || flags.is_harmful_narrative) return 'inflammatory';
  if (flags.is_misinformation || flags.is_organized_pressure) return 'negative';
  return 'neutral';
}
