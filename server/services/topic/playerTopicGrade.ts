import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import {
  triggerNPCReactions,
  type NpcReactionOptions,
  type TopicReactionResult,
} from '../npcReactionService.js';
import { gradeIfCrisisActivity, type GradeRuntime } from './gradeIfCrisisActivity.js';
import {
  isTopicSchemaMissing,
  noteTopicSchemaMissing,
  topicSchemaMissing,
} from './topicColumns.js';
import type { TopicLabel } from './topicPromptCore.js';

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

export async function writePlayerTopic(
  postId: string,
  checked: { label: TopicLabel; confidence: number | null; bridgeTopic: string },
): Promise<{ columnsAvailable: boolean }> {
  if (!postId || topicSchemaMissing()) return { columnsAvailable: false };
  const { error } = await supabaseAdmin
    .from('social_posts')
    .update({
      topic_class: checked.label,
      topic_confidence: checked.confidence,
      topic_bridge: checked.bridgeTopic || null,
    })
    .eq('id', postId);
  if (error && isTopicSchemaMissing(error)) {
    noteTopicSchemaMissing();
    return { columnsAvailable: false };
  }
  if (error) {
    logger.warn({ error, postId }, 'Failed to store topic class');
    return { columnsAvailable: true };
  }
  return { columnsAvailable: true };
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
