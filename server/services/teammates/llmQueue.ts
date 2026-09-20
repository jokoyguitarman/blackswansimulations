import { env } from '../../env.js';
import {
  budgetStatus as clientBudgetStatus,
  chatJson,
  forgetBudget as clientForgetBudget,
  stats as clientStats,
  systemUser,
} from '../ai/chatClient.js';

/**
 * LLM access for the AI teammate bots (docs/ai-teammate-bots-plan.md D11 / §11).
 *
 * Thin wrapper over the shared chat client, which now owns the behaviour this module used
 * to implement itself: one global sequential queue with a short pause between calls, a
 * per-session hourly budget, a 45 s abort, strict `json_schema` output with an automatic
 * `json_object` + inlined-schema fallback, and per-label call statistics. When a session's
 * budget is exhausted the caller receives `null` and falls back to its heuristics until the
 * hour rolls over.
 */

const CALL_TIMEOUT_MS = 45_000;
const STATS_LABEL = 'teammates';

export function budgetStatus(sessionId: string): {
  used: number;
  limit: number;
  resetsInMs: number;
} {
  return clientBudgetStatus(sessionId, env.teammateBotsMaxLlmPerHour);
}

export function forgetBudget(sessionId: string): void {
  clientForgetBudget(sessionId);
}

export interface JsonCall {
  sessionId: string;
  tier: 'fast' | 'strong';
  system: string;
  user: string;
  /** JSON schema for structured output (strict). */
  schemaName: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}

export interface LlmStats {
  calls: number;
  failures: number;
  budgetDenied: number;
  lastError: string | null;
}

/** Live view of the bots' call counters (backed by the shared client's per-label stats). */
export const llmStats: LlmStats = {
  get calls() {
    return clientStats(STATS_LABEL).calls;
  },
  get failures() {
    return clientStats(STATS_LABEL).failures;
  },
  get budgetDenied() {
    return clientStats(STATS_LABEL).budgetDenied;
  },
  get lastError() {
    return clientStats(STATS_LABEL).lastError;
  },
};

/**
 * Structured JSON completion. Returns null (never throws) when AI is not configured,
 * the budget is spent, the request fails or the reply is not valid JSON.
 */
export async function callJson<T = Record<string, unknown>>(call: JsonCall): Promise<T | null> {
  if (!env.aiEnabled) return null;
  const strong = call.tier === 'strong';
  return chatJson<T>({
    tier: strong ? 'standard' : 'fast',
    modelOverride: strong ? env.teammateBotsModelStrong : env.teammateBotsModelFast,
    messages: systemUser(call.system, call.user),
    json: { name: call.schemaName, schema: call.schema },
    maxTokens: call.maxTokens ?? 900,
    timeoutMs: CALL_TIMEOUT_MS,
    retry: { attempts: 1 },
    budgetKey: call.sessionId,
    budgetLimit: env.teammateBotsMaxLlmPerHour,
    serialize: true,
    label: STATS_LABEL,
  });
}
