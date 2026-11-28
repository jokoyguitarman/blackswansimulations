import { env } from '../../env.js';
import { openedAtOf, selectSession } from '../../lib/peaceSchema.js';
import { sessionPhase } from '../../lib/sessionPhase.js';
import type { TopicPhase } from '../topic/topicPromptCore.js';

/**
 * Phase for a reply call. With the peace flag off this returns `crisis`
 * and does not read the session, so the reply queries stay as they are today.
 * DM and email cores (WP5) should pass this value as their optional `phase`.
 */
export async function loadSessionTopicPhase(sessionId: string, now = Date.now()): Promise<TopicPhase> {
  if (!env.enablePeacePeriod) return 'crisis';
  const { data, error } = await selectSession<{
    start_time: string | null;
    opened_at?: string | null;
  }>('start_time', (query) => query.eq('id', sessionId).maybeSingle());
  if (error || !data?.start_time) return 'crisis';
  return sessionPhase(
    { start_time: data.start_time, opened_at: openedAtOf(data) },
    now,
  );
}
