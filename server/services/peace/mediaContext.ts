import type { TopicPhase } from '../topic/topicPromptCore.js';

/**
 * Crisis text given to the image and video models. Peace sends none.
 * Any other phase keeps today's slice of the scenario description.
 */
export function mediaScenarioContext(
  phase: TopicPhase | undefined,
  description: string | null | undefined,
): string | undefined {
  if (phase === 'peace') return undefined;
  if (!description) return undefined;
  const text = description.substring(0, 200);
  return text.length > 0 ? text : undefined;
}
