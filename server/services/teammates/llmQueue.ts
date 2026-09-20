import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';

/**
 * One sequential LLM queue for every bot in the process, with a per-session
 * hourly budget (docs/ai-teammate-bots-plan.md D11 / §11).
 *
 * Sequential + a short pause between calls keeps a room full of bots from
 * bursting the OpenAI rate limit (the same shape as DemoActionDispatcher's
 * evaluation queue). When a session's budget is exhausted the caller receives
 * `null` and falls back to its heuristics until the hour rolls over.
 */

const INTER_CALL_PAUSE_MS = 800;
const CALL_TIMEOUT_MS = 45_000;

interface QueueTask {
  run: () => Promise<void>;
}

const queue: QueueTask[] = [];
let draining = false;

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({
      run: async () => {
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        }
      },
    });
    void drain();
  });
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const task = queue.shift()!;
      await task.run();
      if (queue.length > 0) await new Promise((r) => setTimeout(r, INTER_CALL_PAUSE_MS));
    }
  } finally {
    draining = false;
  }
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

interface Budget {
  windowStart: number;
  used: number;
}

const budgets = new Map<string, Budget>();
const HOUR_MS = 60 * 60 * 1000;

function takeBudget(sessionId: string): boolean {
  const now = Date.now();
  let b = budgets.get(sessionId);
  if (!b || now - b.windowStart >= HOUR_MS) {
    b = { windowStart: now, used: 0 };
    budgets.set(sessionId, b);
  }
  if (b.used >= env.teammateBotsMaxLlmPerHour) return false;
  b.used++;
  return true;
}

export function budgetStatus(sessionId: string): {
  used: number;
  limit: number;
  resetsInMs: number;
} {
  const b = budgets.get(sessionId);
  const now = Date.now();
  if (!b || now - b.windowStart >= HOUR_MS) {
    return { used: 0, limit: env.teammateBotsMaxLlmPerHour, resetsInMs: HOUR_MS };
  }
  return {
    used: b.used,
    limit: env.teammateBotsMaxLlmPerHour,
    resetsInMs: HOUR_MS - (now - b.windowStart),
  };
}

export function forgetBudget(sessionId: string): void {
  budgets.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

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

export const llmStats: LlmStats = { calls: 0, failures: 0, budgetDenied: 0, lastError: null };

/**
 * Structured JSON completion. Returns null (never throws) when the key is missing,
 * the budget is spent, the request fails or the reply is not valid JSON.
 */
export async function callJson<T = Record<string, unknown>>(call: JsonCall): Promise<T | null> {
  if (!env.openAiApiKey) return null;
  if (!takeBudget(call.sessionId)) {
    llmStats.budgetDenied++;
    return null;
  }
  const model = call.tier === 'strong' ? env.teammateBotsModelStrong : env.teammateBotsModelFast;

  return enqueue(async () => {
    llmStats.calls++;
    const body = {
      model,
      messages: [
        { role: 'system', content: call.system },
        { role: 'user', content: call.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: call.schemaName, strict: true, schema: call.schema },
      },
      max_completion_tokens: call.maxTokens ?? 900,
    };
    let text = await post(body);
    if (text === null) {
      // Some models reject json_schema; retry once with json_object and the schema inlined.
      text = await post({
        ...body,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `${call.system}\n\nReply with a single JSON object matching this schema:\n${JSON.stringify(call.schema)}`,
          },
          { role: 'user', content: call.user },
        ],
      });
    }
    if (text === null) {
      llmStats.failures++;
      return null;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      llmStats.failures++;
      llmStats.lastError = 'invalid JSON in completion';
      return null;
    }
  });
}

async function post(body: Record<string, unknown>): Promise<string | null> {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.openAiApiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      llmStats.lastError = `HTTP ${res.status}: ${detail}`;
      logger.warn({ status: res.status, detail, model: body.model }, 'teammates: LLM call failed');
      return null;
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    return typeof content === 'string' && content.trim() ? content : null;
  } catch (err) {
    llmStats.lastError = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, 'teammates: LLM call threw');
    return null;
  }
}
