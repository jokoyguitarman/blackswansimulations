import { env } from '../../env.js';
import { chatJson, systemUser } from '../ai/chatClient.js';
import { BLUEPRINT_MAX_COMPLETION_TOKENS, BLUEPRINT_TEXT_MODEL } from './blueprintConfig.js';

/**
 * JSON client for the blueprint feature.
 *
 * Thin wrapper over the shared chat client (server/services/ai/chatClient.ts), which owns
 * provider selection, retry/backoff and tolerant parsing. Kept so blueprint extraction and
 * the scenario director keep their call signature.
 */

export interface OpenAiJsonOptions {
  system: string;
  user: string;
  /** Exact model while AI_PROVIDER=openai. Defaults to the standard blueprint model. */
  model?: string;
  /** Completion ceiling (not a target). Defaults to the configured maximum. */
  maxTokens?: number;
  temperature?: number;
}

/**
 * Call the chat completions API expecting a JSON object back. Retries transient
 * failures (network errors, 429, 5xx) with backoff. Returns null on
 * unrecoverable failure or when AI is not configured, never throws.
 */
export async function openAiJson(
  options: OpenAiJsonOptions,
): Promise<Record<string, unknown> | null> {
  if (!env.aiEnabled) return null;

  const {
    system,
    user,
    model = BLUEPRINT_TEXT_MODEL,
    maxTokens = BLUEPRINT_MAX_COMPLETION_TOKENS,
    temperature = 0.2,
  } = options;

  return chatJson<Record<string, unknown>>({
    tier: 'standard',
    openaiModel: model,
    messages: systemUser(system, user),
    json: true,
    maxTokens,
    temperature,
    label: 'blueprint.openAiJson',
  });
}
