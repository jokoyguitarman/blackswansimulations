import { logger } from '../../lib/logger.js';
import {
  triggerNPCReactions,
  type NpcReactionOptions,
  type TopicReactionResult,
} from '../npcReactionService.js';
import { triggerNPCDMReply, type NpcDmReplyOptions } from '../npcMessengerService.js';
import {
  triggerNPCEmailReply,
  type NpcEmailReplyOptions,
  type PlayerEmail,
} from '../npcEmailReplyService.js';
import { gradeIfCrisisActivity, type GradeRuntime } from './gradeIfCrisisActivity.js';
import { gradeOutboundEmail, type OutboundEmailGradeRuntime } from './gradeOutboundEmail.js';
import { updateTopicRow, writePlayerChannelTopic } from './channelTopicLabel.js';
import type { TopicLabel } from './topicPromptCore.js';
import { channelPhase } from './channelPromptShared.js';

export interface PlayerReactionSource {
  sessionId: string;
  post: Record<string, unknown>;
  userId: string;
  content: string;
  postFormat: string | undefined;
  imagePrompt: string | undefined;
  replyToPostId: string | undefined;
  postAsPage: boolean;
}

export function writePlayerTopic(
  postId: string,
  checked: { label: TopicLabel; confidence: number | null; bridgeTopic: string },
): Promise<{ columnsAvailable: boolean }> {
  return updateTopicRow('social_posts', postId, {
    topic_class: checked.label,
    topic_confidence: checked.confidence,
    topic_bridge: checked.bridgeTopic || null,
  });
}

/**
 * Player posts only. Runs the reaction call, stores its label, then grades.
 * NPC engines keep calling `triggerNPCReactions` and never reach this.
 * The returned promise is not awaited by the route.
 */
export async function gradePlayerPostFromReactions(
  source: PlayerReactionSource,
  options?: NpcReactionOptions,
  runtime?: GradeRuntime,
): Promise<void> {
  let topic: TopicReactionResult | null = null;
  try {
    topic = await triggerNPCReactions(source.sessionId, source.post, options);
  } catch (err) {
    logger.error({ err, sessionId: source.sessionId }, 'NPC reaction trigger failed');
  }
  const classified = topic?.label ?? 'unclassified';
  const wrote = await writePlayerTopic(String(source.post.id || ''), {
    label: classified,
    confidence: topic?.confidence ?? null,
    bridgeTopic: topic?.bridgeTopic ?? '',
  });
  await gradeIfCrisisActivity(
    {
      sessionId: source.sessionId,
      postId: String(source.post.id || ''),
      userId: source.userId,
      content: source.content,
      postFormat: source.postFormat,
      imagePrompt: source.imagePrompt,
      replyToPostId: source.replyToPostId,
      postAsPage: source.postAsPage,
      topicAware: true,
      label: wrote.columnsAvailable ? classified : 'unclassified',
      phase: options?.phase ?? 'crisis',
      postKind: topic?.postKind ?? 'crisis',
      columnsAvailable: wrote.columnsAvailable,
    },
    runtime,
  );
}

export function reactAndGradePlayerPost(
  source: PlayerReactionSource,
  options?: NpcReactionOptions,
): void {
  void gradePlayerPostFromReactions(source, options).catch((err) => {
    logger.warn({ err }, 'Auto-grade failed (non-critical)');
  });
}

/**
 * Player DMs only. The messenger route calls this when topic replies and AI are on.
 * `triggerNPCDMReply` itself never writes a label.
 */
export async function labelPlayerDmFromReply(
  sessionId: string,
  threadId: string,
  recipientHandle: string,
  playerMessage: string,
  playerUserId: string,
  playerMessageId: string,
  options?: NpcDmReplyOptions,
): Promise<void> {
  let topic = null;
  try {
    topic = await triggerNPCDMReply(
      sessionId,
      threadId,
      recipientHandle,
      playerMessage,
      playerUserId,
      {
        ...options,
        playerMessageId,
      },
    );
  } catch (err) {
    logger.warn({ err, sessionId, threadId }, 'NPC DM reply failed');
  }
  if (!topic) return;
  await writePlayerChannelTopic('sim_direct_messages', topic.rowId, topic.label);
}

export function replyAndLabelPlayerDm(
  sessionId: string,
  threadId: string,
  recipientHandle: string,
  playerMessage: string,
  playerUserId: string,
  playerMessageId: string,
  options?: NpcDmReplyOptions,
): void {
  void labelPlayerDmFromReply(
    sessionId,
    threadId,
    recipientHandle,
    playerMessage,
    playerUserId,
    playerMessageId,
    options,
  ).catch((err) => {
    logger.warn({ err, sessionId, threadId }, 'NPC DM reply failed');
  });
}

/**
 * Player emails to an NPC only. Stores the reply's label, then grades.
 * The route calls this when topic replies and AI are on. Flag off keeps grading in the route.
 */
export async function gradePlayerEmailFromReply(
  sessionId: string,
  playerEmail: PlayerEmail,
  options?: NpcEmailReplyOptions,
  runtime?: OutboundEmailGradeRuntime,
): Promise<void> {
  let topic = null;
  try {
    topic = await triggerNPCEmailReply(sessionId, playerEmail, options);
  } catch (err) {
    logger.error(
      { err, sessionId, playerEmailId: playerEmail.id },
      'NPC email reply trigger failed',
    );
  }
  const label = topic?.label ?? 'unclassified';
  const wrote = await writePlayerChannelTopic('sim_emails', playerEmail.id, label);
  await gradeOutboundEmail(
    {
      sessionId,
      emailId: playerEmail.id,
      userId: playerEmail.sender_user_id ?? '',
      subject: playerEmail.subject,
      bodyText: playerEmail.body_text,
      topicAware: true,
      label: wrote.columnsAvailable ? label : 'unclassified',
      phase: channelPhase(options?.phase),
      postKind: 'crisis',
      columnsAvailable: wrote.columnsAvailable,
    },
    runtime,
  );
}

export function replyAndGradePlayerEmail(
  sessionId: string,
  playerEmail: PlayerEmail,
  options?: NpcEmailReplyOptions,
): void {
  void gradePlayerEmailFromReply(sessionId, playerEmail, options).catch((err) => {
    logger.warn({ err, emailId: playerEmail.id }, 'Outbound email grading failed');
  });
}
