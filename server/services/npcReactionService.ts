import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { chatJson, type ChatOptions } from './ai/chatClient.js';
import { getWebSocketService } from './websocketService.js';
import {
  notifyPostReply,
  notifyPostLike,
  notifyMention,
  extractMentions,
} from './socialNotificationService.js';
import { buildLegacyReactionMessages } from './topic/legacyReactionPrompt.js';
import { formatPersonaReactionLine, isCompetitorPersona } from './topic/reactionPromptShared.js';
import {
  assignBridgeStances,
  buildTopicAwareReactionPrompt,
  checkTopicReplies,
  leakTermsFromInitialState,
  type BridgeStance,
  type PostKind,
  type TopicLabel,
  type TopicPhase,
} from './topic/topicPromptCore.js';
import {
  isTopicSchemaMissing,
  noteTopicSchemaMissing,
  topicSchemaMissing,
} from './topic/topicColumns.js';

export interface ReactionChatResult {
  reactions?: Array<Record<string, unknown>>;
  classification?: unknown;
}

export interface ReactionChatClient {
  chatJson(
    options: Pick<
      ChatOptions,
      'tier' | 'json' | 'temperature' | 'maxTokens' | 'label' | 'messages'
    >,
  ): Promise<ReactionChatResult | null>;
}

export interface NpcReactionOptions {
  /** WP3 passes `peace`. Until then every caller leaves this unset, which is crisis. */
  phase?: TopicPhase;
  client?: ReactionChatClient;
}

/** What the reaction call decided. Null when topic replies are off, or the call threw. */
export interface TopicReactionResult {
  label: TopicLabel;
  confidence: number | null;
  bridgeTopic: string;
  postKind: PostKind;
}

interface NPCPersona {
  handle: string;
  name: string;
  type: string;
  personality: string;
  bias: string;
  follower_count: number;
  specific_claims: string[];
  tier?: string;
}

const PARENT_COLUMNS = 'content, author_handle, author_display_name, author_type' as const;
const PARENT_WITH_KIND =
  'content, author_handle, author_display_name, author_type, topic_kind' as const;

interface ParentPostRow {
  content: string;
  author_handle: string;
  author_display_name?: string | null;
  author_type?: string | null;
  topic_kind?: string | null;
}

/** Flag off uses the same column list as before. topic_kind is only requested when the feature is on. */
async function loadParentPost(id: string, withTopicKind: boolean): Promise<ParentPostRow | null> {
  if (!withTopicKind) {
    const { data } = await supabaseAdmin
      .from('social_posts')
      .select(PARENT_COLUMNS)
      .eq('id', id)
      .single();
    return data;
  }
  const wide = await supabaseAdmin
    .from('social_posts')
    .select(PARENT_WITH_KIND)
    .eq('id', id)
    .single();
  if (wide.error && isTopicSchemaMissing(wide.error)) {
    noteTopicSchemaMissing();
    const fallback = await supabaseAdmin
      .from('social_posts')
      .select(PARENT_COLUMNS)
      .eq('id', id)
      .single();
    return fallback.data;
  }
  if (wide.error || !wide.data) return null;
  return wide.data as ParentPostRow;
}

function unclassifiedTopic(postKind: PostKind): TopicReactionResult {
  return { label: 'unclassified', confidence: null, bridgeTopic: '', postKind };
}

export async function triggerNPCReactions(
  sessionId: string,
  playerPost: Record<string, unknown>,
  options?: NpcReactionOptions,
): Promise<TopicReactionResult | null> {
  const client = options?.client;
  if (!env.aiEnabled && !client) return null;

  const topicAware = env.enableTopicAwareReplies;
  const phase: TopicPhase = options?.phase ?? 'crisis';

  try {
    let topicPostKind: PostKind = 'crisis';
    let parentForPrompt: ParentPostRow | null = null;
    let threadReplyRows: Array<{ authorHandle: string; content: string }> = [];
    let addressedComment: { handle: string; content: string } | null = null;
    const bail = (postKind: PostKind = topicPostKind): TopicReactionResult | null =>
      topicAware ? unclassifiedTopic(postKind) : null;

    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id')
      .eq('id', sessionId)
      .single();

    if (!session?.scenario_id) return bail();

    const { data: scenario } = await supabaseAdmin
      .from('scenarios')
      .select('description, initial_state')
      .eq('id', session.scenario_id)
      .single();

    if (!scenario) return bail();

    const initialState = (scenario.initial_state || {}) as Record<string, unknown>;
    const allPersonas = (initialState.npc_personas || []) as Array<
      NPCPersona & { country?: string | null }
    >;
    if (allPersonas.length === 0) return bail();
    // Contract §5.3: reactions come from personas in the post's country (the player's org
    // country for top-level posts; the row's own country when already stamped).
    const postCountry =
      (typeof playerPost.country === 'string' && playerPost.country) ||
      (await import('./orgRegistryService.js')
        .then((m) =>
          playerPost.user_id
            ? m.getUserCountry(sessionId, String(playerPost.user_id))
            : Promise.resolve(null),
        )
        .catch(() => null));
    const { selectPersonaPool } = await import('./orgRegistryService.js');
    const personas: NPCPersona[] = selectPersonaPool(allPersonas, postCountry);
    const orgName = String(initialState.org_name || '');

    const postFormat = String(playerPost.post_format || 'text');
    const isReply = !!playerPost.reply_to_post_id;

    // Fetch thread context if this is a reply
    let threadContext = '';
    if (isReply) {
      const parentPost = await loadParentPost(
        String(playerPost.reply_to_post_id),
        topicAware && !topicSchemaMissing(),
      );

      if (parentPost) {
        parentForPrompt = parentPost;
        if (parentPost.topic_kind === 'normal' || parentPost.topic_kind === 'crisis') {
          topicPostKind = parentPost.topic_kind;
        }
        const { data: threadReplies } = await supabaseAdmin
          .from('social_posts')
          .select('content, author_handle')
          .eq('reply_to_post_id', String(playerPost.reply_to_post_id))
          .order('created_at', { ascending: true })
          .limit(10);

        threadContext = `\n\nTHREAD CONTEXT:\nOriginal post by ${parentPost.author_handle}: "${String(parentPost.content).substring(0, 200)}"`;
        threadReplyRows = (threadReplies || []).map((r) => ({
          authorHandle: String(r.author_handle),
          content: String(r.content).substring(0, 100),
        }));
        if (threadReplies && threadReplies.length > 0) {
          threadContext +=
            '\nPrevious replies:\n' +
            threadReplies
              .map((r) => `  ${r.author_handle}: "${String(r.content).substring(0, 100)}"`)
              .join('\n');
        }

        // Identify which specific comment the player is responding to via @mention
        const playerContent = String(playerPost.content || '');
        const mentionMatch = playerContent.match(/^(@[\w._]+)/);
        if (mentionMatch) {
          const targetHandle = mentionMatch[1];
          const targetReply = (threadReplies || [])
            .reverse()
            .find((r) => r.author_handle === targetHandle);
          if (targetReply) {
            const addressed = String(targetReply.content).substring(0, 200);
            addressedComment = { handle: targetHandle, content: addressed };
            threadContext += `\n\nThe player is SPECIFICALLY responding to ${targetHandle}'s comment: "${addressed}"`;
            threadContext += `\nNPCs should respond in context of THIS specific exchange, not the general thread.`;
          }
        }

        threadContext += `\n\nThe player just replied in this thread. NPCs who are part of this conversation should respond directly to what the player said, continuing the argument/discussion.`;
      }
    }

    const probabilityBoost = isReply ? 2.0 : 1.0;
    const isOfficialPagePost = String(playerPost.author_type) === 'official_account';
    const reactingNPCs: Array<{ persona: NPCPersona; reactionType: string }> = [];

    for (const persona of personas) {
      const roll = Math.random();

      if (!isOfficialPagePost && !isReply) {
        // Personal profile post: only public NPCs and biased NPCs react
        // Media, politicians, influencers do NOT react to random people's posts
        if (
          persona.type === 'npc_media' ||
          persona.type === 'npc_politician' ||
          persona.type === 'npc_influencer'
        ) {
          continue;
        }
      }

      if (isCompetitorPersona(persona)) {
        const threshold = isOfficialPagePost ? 0.9 : 0.5;
        if (roll < Math.min(threshold * probabilityBoost, 0.95)) {
          reactingNPCs.push({ persona, reactionType: 'position' });
        }
      } else if (persona.bias && persona.bias !== 'none') {
        const threshold =
          (postFormat === 'humor_meme' ? 0.8 : isOfficialPagePost ? 0.8 : 0.7) * probabilityBoost;
        if (roll < Math.min(threshold, 0.95)) {
          reactingNPCs.push({ persona, reactionType: 'attack' });
        }
      } else if (persona.type === 'npc_media') {
        const grade = (playerPost.sop_compliance_score as Record<string, unknown>) || {};
        const overall = Number(grade.overall) || 50;
        const threshold = isOfficialPagePost
          ? 0.9
          : postFormat === 'official_statement'
            ? 0.85
            : postFormat === 'humor_meme' || postFormat === 'video_concept'
              ? 0.85
              : 0.5;
        if (roll < Math.min(threshold * probabilityBoost, 0.95)) {
          reactingNPCs.push({
            persona,
            reactionType: overall > 60 ? 'cover' : overall < 35 ? 'attack' : 'cover',
          });
        }
      } else if (
        /supportive|community|advocate|defender|moderate|balanced|reasonable/i.test(
          persona.personality,
        )
      ) {
        if (roll < Math.min(0.85 * probabilityBoost, 0.95)) {
          reactingNPCs.push({ persona, reactionType: 'support' });
        }
      } else if (persona.type === 'npc_politician' || persona.type === 'npc_influencer') {
        if (roll < Math.min((isOfficialPagePost ? 0.85 : 0.7) * probabilityBoost, 0.95)) {
          const grade = (playerPost.sop_compliance_score as Record<string, unknown>) || {};
          const overall = Number(grade.overall) || 50;
          reactingNPCs.push({
            persona,
            reactionType: overall > 60 ? 'support' : overall < 40 ? 'attack' : 'neutral',
          });
        }
      }
    }

    if (isReply && reactingNPCs.length === 0 && personas.length > 0) {
      const randomPersona = personas[Math.floor(Math.random() * personas.length)];
      reactingNPCs.push({
        persona: randomPersona,
        reactionType: randomPersona.bias && randomPersona.bias !== 'none' ? 'attack' : 'neutral',
      });
    }

    const maxReactions = isOfficialPagePost ? 8 : isReply ? 5 : 6;
    const selected = reactingNPCs.slice(0, Math.min(maxReactions, reactingNPCs.length));
    if (selected.length === 0) return bail();

    // Official crisis communication (a holding statement or any post published
    // as the org page) draws substantive scrutiny, not sarcasm: NPCs must
    // engage with what the statement says and fails to say. The fact sheet
    // grounds those critiques in the scenario's actual open questions.
    const isOfficialComms = postFormat === 'official_statement' || isOfficialPagePost;
    let officialScrutinyBlock = '';
    if (isOfficialComms) {
      const factSheet = (initialState.fact_sheet || {}) as {
        confirmed_facts?: string[];
        unconfirmed_claims?: Array<{ claim?: string; status?: string }>;
      };
      const confirmed = (factSheet.confirmed_facts || []).slice(0, 6).join('; ');
      const circulating = (factSheet.unconfirmed_claims || [])
        .slice(0, 5)
        .map((c) => `"${String(c.claim || '')}" (${String(c.status || 'UNVERIFIED')})`)
        .join('; ');

      officialScrutinyBlock = `
OFFICIAL STATEMENT SCRUTINY (this post is official crisis communication${orgName ? ` from ${orgName}` : ''}):
- React to the CONTENT of the statement, not to the fact that it exists. Quote or paraphrase its specific wording when challenging it.
- Point out concrete gaps: which public questions it leaves unanswered, missing numbers/timelines/affected scope, no cause, no remedy, no time for the next update.
- If it makes claims, ask what verifies them. If it is vague, name precisely WHAT is missing instead of mocking the vagueness.
- Do NOT use sarcasm, memes, or one-line dunks on this post. Pressure comes from pointed questions and specific criticism a comms team would have to answer.
- Supportive/neutral NPCs should acknowledge what the statement DID answer and ask a follow-up, not cheerlead blindly.${
        circulating
          ? `\n- Claims currently circulating that the public wants addressed: ${circulating}`
          : ''
      }${confirmed ? `\n- Publicly known confirmed facts NPCs may cite: ${confirmed}` : ''}
`;
    }

    const playerHandleForPrompt = String(playerPost.author_handle || '@player');
    const crisisDescription = String(scenario.description || '').substring(0, 300);
    const playerContent = String(playerPost.content || '');
    const imagePrompt = playerPost.image_prompt ? String(playerPost.image_prompt) : undefined;
    const stances = topicAware
      ? assignBridgeStances(selected, String(playerPost.id || ''), {
          authorIsPage: isOfficialPagePost,
          stayShare: env.topicBridgeStayShare,
        })
      : [];
    const stanceByHandle = new Map<string, BridgeStance>(
      stances.map((row) => [row.handle, row.stance]),
    );
    const prompted = topicAware
      ? buildTopicAwareReactionPrompt({
          phase,
          postFormat,
          playerHandle: playerHandleForPrompt,
          playerContent,
          imagePrompt,
          authorIsPage: isOfficialPagePost,
          orgName,
          topicKind: topicPostKind,
          parent: parentForPrompt
            ? {
                content: String(parentForPrompt.content).substring(0, 200),
                authorHandle: String(parentForPrompt.author_handle),
                authorDisplayName: String(parentForPrompt.author_display_name || ''),
                authorType: String(parentForPrompt.author_type || ''),
                topicKind: topicPostKind,
              }
            : null,
          threadReplies: threadReplyRows,
          addressedComment,
          personas: selected.map((entry) => ({
            handle: entry.persona.handle,
            name: entry.persona.name,
            personality: entry.persona.personality,
            bias: entry.persona.bias,
            type: entry.persona.type,
            reactionType: entry.reactionType,
            stance: stanceByHandle.get(entry.persona.handle) || 'stay',
          })),
          crisisDescription,
          officialScrutinyBlock,
          isOfficialComms,
          isReply,
        })
      : buildLegacyReactionMessages({
          postFormat,
          playerHandle: playerHandleForPrompt,
          npcContext: selected
            .map((entry) => formatPersonaReactionLine(entry.persona, entry.reactionType))
            .join('\n'),
          isOfficialComms,
          officialScrutinyBlock,
          crisisDescription,
          orgName,
          threadContext,
          isReply,
          playerContent,
          imagePrompt,
          userHandle: String(playerPost.author_handle),
        });

    const request = {
      tier: 'standard' as const,
      json: true as const,
      temperature: 0.95,
      maxTokens: 1500,
      label: 'npcReaction.generate',
      messages: [
        { role: 'system' as const, content: prompted.system },
        { role: 'user' as const, content: prompted.user },
      ],
    };
    const parsed = client
      ? await client.chatJson(request)
      : await chatJson<ReactionChatResult>(request);

    if (!parsed) return bail();
    let reactions = (parsed.reactions || []) as Array<Record<string, unknown>>;
    let topic: TopicReactionResult | null = null;

    if (topicAware) {
      const leakTerms = leakTermsFromInitialState(initialState);
      const checked = checkTopicReplies({
        classification: parsed.classification,
        reactions,
        stances: stanceByHandle,
        leakTerms,
        postKind: topicPostKind,
        isReply,
        minConfidence: env.topicBridgeMinConfidence,
      });
      reactions = checked.reactions;
      topic = {
        label: checked.label,
        confidence: checked.confidence,
        bridgeTopic: checked.bridgeTopic,
        postKind: topicPostKind,
      };
      const logged = new Set<string>();
      for (const drop of checked.dropped) {
        if (logged.has(drop.handle)) continue;
        logged.add(drop.handle);
        logger.info(
          { sessionId, playerPostId: playerPost.id, handle: drop.handle },
          'Dropped topic reply that matched leak terms',
        );
      }
    }

    const postPlatform = String(playerPost.platform || 'x_twitter');
    const playerHandle = String(playerPost.author_handle || '@player');

    for (let i = 0; i < reactions.length; i++) {
      // Thread replies get faster responses (10-30s), top-level posts get 30s-3min
      const delay = isReply
        ? 3000 + Math.floor(Math.random() * 7000)
        : 5000 + Math.floor(Math.random() * 25000);
      setTimeout(
        async () => {
          try {
            const reaction = reactions[i];
            const actionType = String(reaction.action || 'reply');
            const npcName = String(reaction.author_display_name || 'NPC');
            const npcHandle = String(reaction.author_handle || '@npc');

            // Handle "like" action -- NPC likes the player's post
            if (actionType === 'like') {
              await supabaseAdmin
                .from('social_posts')
                .update({ like_count: ((playerPost.like_count as number) || 0) + 1 })
                .eq('id', playerPost.id);

              // Notify player about the NPC like
              void notifyPostLike(
                sessionId,
                playerHandle,
                npcName,
                'like',
                postPlatform,
                isOfficialPagePost,
                String(playerPost.id),
              );

              getWebSocketService().broadcastToSession(sessionId, {
                type: 'social_posts.engagement_update',
                data: {
                  updates: [
                    {
                      id: playerPost.id,
                      like_count: ((playerPost.like_count as number) || 0) + 1,
                    },
                  ],
                },
                timestamp: new Date().toISOString(),
              });

              logger.info({ sessionId, npcHandle, playerPostId: playerPost.id }, 'NPC liked post');
              return;
            }

            // Handle reply/repost/new_post actions
            let replyContent = String(reaction.content || '');

            // For reply actions, ensure content uses @handle[commentId] format for proper threading
            if (actionType === 'reply' || reaction.is_reply) {
              const playerHandle = String(playerPost.author_handle || '@player');
              const playerCommentId = String(playerPost.id);
              const hasThreadTag = /^@[\w._-]+\[/.test(replyContent);
              if (!hasThreadTag) {
                const hasMention = replyContent.startsWith(playerHandle);
                if (hasMention) {
                  replyContent = `${playerHandle}[${playerCommentId}] ${replyContent.slice(playerHandle.length).trimStart()}`;
                } else {
                  replyContent = `${playerHandle}[${playerCommentId}] ${replyContent}`;
                }
              }
            }

            const topLevelPostId = String(playerPost.reply_to_post_id || playerPost.id);

            const { data: inserted, error } = await supabaseAdmin
              .from('social_posts')
              .insert({
                session_id: sessionId,
                platform: postPlatform,
                author_handle: npcHandle,
                author_display_name: npcName,
                author_type: String(reaction.author_type || 'npc_public'),
                content: replyContent,
                reply_to_post_id:
                  actionType === 'reply' || reaction.is_reply ? topLevelPostId : null,
                sentiment: String(reaction.sentiment || 'neutral'),
                hashtags: replyContent.match(/#\w+/g) || [],
                like_count: 0,
                repost_count: 0,
                reply_count: 0,
                view_count: 0,
                virality_score: 0,
                content_flags: {},
              })
              .select()
              .single();

            if (error) {
              logger.warn({ error }, 'Failed to insert NPC reaction');
              return;
            }

            if (actionType === 'reply' || reaction.is_reply) {
              const { data: parentRow } = await supabaseAdmin
                .from('social_posts')
                .select('reply_count')
                .eq('id', topLevelPostId)
                .single();
              if (parentRow) {
                await supabaseAdmin
                  .from('social_posts')
                  .update({ reply_count: ((parentRow.reply_count as number) || 0) + 1 })
                  .eq('id', topLevelPostId);
              }

              void notifyPostReply(
                sessionId,
                npcName,
                String(playerPost.author_handle || ''),
                topLevelPostId,
                replyContent,
                postPlatform,
                inserted.id,
                isOfficialPagePost,
              );
            }

            // Check for @mentions in the NPC reply and notify mentioned players
            const mentions = extractMentions(replyContent);
            for (const mentionedHandle of mentions) {
              if (mentionedHandle !== npcHandle) {
                void notifyMention(
                  sessionId,
                  mentionedHandle,
                  npcName,
                  replyContent,
                  postPlatform,
                  isOfficialPagePost,
                );
              }
            }

            getWebSocketService().broadcastToSession(sessionId, {
              type: 'social_post.created',
              data: { post: inserted },
              timestamp: new Date().toISOString(),
            });

            logger.info(
              { sessionId, npcHandle, reactionType: actionType, playerPostId: playerPost.id },
              'NPC reaction posted',
            );
          } catch (err) {
            logger.warn({ err }, 'NPC reaction delivery failed');
          }
        },
        delay * (i + 1),
      );
    }

    logger.info(
      { sessionId, playerPostId: playerPost.id, reactionCount: reactions.length },
      'NPC reactions scheduled',
    );
    return topic;
  } catch (err) {
    logger.error({ err, sessionId }, 'NPC reaction trigger failed');
    return null;
  }
}
