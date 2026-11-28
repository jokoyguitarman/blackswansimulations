import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import {
  isTopicSchemaMissing,
  noteTopicSchemaMissing,
  topicSchemaMissing,
} from './topicColumns.js';
import type { TopicLabel } from './topicPromptCore.js';

export type ChannelTopicTable = 'sim_direct_messages' | 'sim_emails';

/**
 * Stores the label on the player's DM or email. NPC inserts never carry the column.
 * A missing 282 column warns once and leaves the row unchanged.
 */
export async function updateTopicRow(
  table: ChannelTopicTable | 'social_posts',
  rowId: string,
  patch: Record<string, unknown>,
): Promise<{ columnsAvailable: boolean }> {
  if (!rowId || topicSchemaMissing()) return { columnsAvailable: false };
  const { error } = await supabaseAdmin.from(table).update(patch).eq('id', rowId);
  if (error && isTopicSchemaMissing(error)) {
    noteTopicSchemaMissing();
    return { columnsAvailable: false };
  }
  if (error) {
    logger.warn({ error, table, rowId }, 'Failed to store topic class');
    return { columnsAvailable: true };
  }
  return { columnsAvailable: true };
}

export function writePlayerChannelTopic(
  table: ChannelTopicTable,
  rowId: string,
  label: TopicLabel,
): Promise<{ columnsAvailable: boolean }> {
  return updateTopicRow(table, rowId, { topic_class: label });
}
