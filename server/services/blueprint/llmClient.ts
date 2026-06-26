import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { BLUEPRINT_MAX_COMPLETION_TOKENS, BLUEPRINT_TEXT_MODEL } from './blueprintConfig.js';

/**
 * Single OpenAI JSON client for the blueprint feature.
 *
 * This intentionally does NOT touch the existing per-service `callAI` copies
 * (antagonist/hive/ambient/generator) -- consolidating those is a separate PR.
 * It exists so the new code has one place that owns model choice, the
 * completion ceiling, retry/backoff, and tolerant parsing.
 */

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_ATTEMPTS = 3;

export interface OpenAiJsonOptions {
  system: string;
  user: string;
  /** Defaults to the standard blueprint model. */
  model?: string;
  /** Completion ceiling (not a target). Defaults to the configured maximum. */
  maxTokens?: number;
  temperature?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Extract a JSON object from a model response, tolerating accidental prose or
 * markdown fences around it. Returns null when nothing parseable is found so a
 * single bad response degrades to a coverage gap rather than throwing.
 */
function parseJsonLoose(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // Fall through to brace extraction.
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Call the chat completions API expecting a JSON object back. Retries transient
 * failures (network errors, 429, 5xx) with backoff. Returns null on
 * unrecoverable failure or when the key is absent, never throws.
 */
export async function openAiJson(
  options: OpenAiJsonOptions,
): Promise<Record<string, unknown> | null> {
  if (!env.openAiApiKey) return null;

  const {
    system,
    user,
    model = BLUEPRINT_TEXT_MODEL,
    maxTokens = BLUEPRINT_MAX_COMPLETION_TOKENS,
    temperature = 0.2,
  } = options;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(OPENAI_CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.openAiApiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature,
          max_completion_tokens: maxTokens,
          response_format: { type: 'json_object' },
        }),
      });

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < MAX_ATTEMPTS) {
          await sleep(attempt * 750);
          continue;
        }
        logger.warn({ status: response.status, attempt }, 'Blueprint LLM call returned non-OK');
        return null;
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) return null;
      return parseJsonLoose(content);
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) {
        await sleep(attempt * 750);
        continue;
      }
      logger.error({ err, attempt }, 'Blueprint LLM call failed');
      return null;
    }
  }
  return null;
}
