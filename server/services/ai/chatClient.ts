/**
 * Shared chat-completions client (docs/AWS_BEDROCK_MIGRATION_v2.md §7.2).
 *
 * The only module that knows a provider URL, API key or model id. Call sites pass a tier
 * (`fast` | `standard` | `vision`) and intent (`maxTokens`, `temperature`, `json`); the
 * client resolves the provider from `AI_PROVIDER`, normalises the request shape, applies the
 * temperature policy, retries 429/5xx, aborts on timeout, parses JSON tolerantly and logs
 * provider / tier / model / latency / token usage (never prompt content).
 *
 * With AI_PROVIDER=openai the emitted request matches what the call sites sent before the
 * migration (same URL, key, model names and ceiling key), so the refactor is
 * behaviour-neutral until the variable is flipped.
 */

import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import {
  HourlyBudget,
  SerialQueue,
  buildRequestBody,
  isRetryableStatus,
  parseJsonLoose,
  resolveTarget,
  type AiTier,
  type ChatMessage,
  type JsonSchemaSpec,
  type ProviderConfig,
  type RequestBody,
  type ResolvedTarget,
} from './chatCore.js';

export type { AiTier, ChatMessage, ChatRole, ContentPart, JsonSchemaSpec } from './chatCore.js';
export { parseJsonLoose, repairTruncatedJson } from './chatCore.js';

export interface ChatOptions {
  tier: AiTier;
  messages: ChatMessage[];
  /** `true` -> response_format json_object; a spec -> strict json_schema (with automatic json_object fallback). */
  json?: boolean | JsonSchemaSpec;
  /** Completion ceiling. Emitted as max_completion_tokens (max_tokens for openai-mode gpt-4* parity). */
  maxTokens?: number;
  /** Subject to AI_TEMPERATURE_POLICY; dropped for models that reject it. */
  temperature?: number;
  /** Per-request abort; defaults to AI_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Retries on 429/5xx/network/timeout. Default 3 attempts, 750ms * attempt backoff. */
  retry?: { attempts?: number; baseDelayMs?: number };
  /** Exact OpenAI model while AI_PROVIDER=openai (migration parity for gpt-5.1 / gpt-5.5 / gpt-4 sites). Ignored on Bedrock. */
  openaiModel?: string;
  /** Exact model id on the active provider (e.g. TEAMMATE_BOTS_MODEL_* overrides). */
  modelOverride?: string;
  /** Per-key hourly budget (e.g. a session id). Requires `budgetLimit`. */
  budgetKey?: string;
  budgetLimit?: number;
  /** Run through the global sequential queue (one in flight, short pause between calls). */
  serialize?: boolean;
  /** Short caller name for logs and stats, e.g. "npcMessenger.generateDms". */
  label?: string;
  /** Throw AiCallError instead of returning null on failure. */
  throwOnError?: boolean;
  /**
   * When the reply is cut off (finish_reason=length) and does not parse, retry once with a
   * 1.6x completion budget (ported from warroomAiService.callOpenAi).
   */
  growOnTruncation?: boolean;
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatResult {
  content: string;
  finishReason?: string;
  usage?: ChatUsage;
  model: string;
  provider: 'openai' | 'bedrock';
  raw: unknown;
}

export class AiCallError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly detail?: string,
    public readonly label?: string,
  ) {
    super(message);
    this.name = 'AiCallError';
  }
}

export interface AiCallStats {
  calls: number;
  failures: number;
  budgetDenied: number;
  lastError: string | null;
}

const statsByLabel = new Map<string, AiCallStats>();
const totals: AiCallStats = { calls: 0, failures: 0, budgetDenied: 0, lastError: null };
const budgets = new HourlyBudget();
const queue = new SerialQueue(800);

function bump(
  label: string | undefined,
  field: keyof Omit<AiCallStats, 'lastError'>,
  err?: string,
) {
  totals[field]++;
  if (err) totals.lastError = err;
  if (!label) return;
  let s = statsByLabel.get(label);
  if (!s) {
    s = { calls: 0, failures: 0, budgetDenied: 0, lastError: null };
    statsByLabel.set(label, s);
  }
  s[field]++;
  if (err) s.lastError = err;
}

/** Aggregate counters, or those for one label. */
export function stats(label?: string): AiCallStats {
  if (!label) return { ...totals };
  return {
    ...(statsByLabel.get(label) ?? { calls: 0, failures: 0, budgetDenied: 0, lastError: null }),
  };
}

export function budgetStatus(key: string, limit: number) {
  return budgets.status(key, limit);
}

export function forgetBudget(key: string): void {
  budgets.forget(key);
}

function providerConfig(): ProviderConfig {
  return {
    provider: env.aiProvider,
    openAiApiKey: env.openAiApiKey,
    aiApiKey: env.aiApiKey,
    aiBaseUrl: env.aiBaseUrl,
    bedrockModels: {
      fast: env.aiModelFast,
      standard: env.aiModelStandard,
      vision: env.aiModelVision,
    },
    temperaturePolicy: env.aiTemperaturePolicy,
    fastMinCompletionTokens: env.aiFastMinCompletionTokens,
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface RawCompletion {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  usage?: ChatUsage;
  error?: { message?: string };
}

/**
 * One HTTP attempt. Returns the parsed completion, or an AiCallError describing why it
 * failed (the caller decides whether to retry).
 */
async function post(
  target: ResolvedTarget,
  body: RequestBody,
  timeoutMs: number,
  label?: string,
): Promise<
  { ok: true; data: RawCompletion } | { ok: false; error: AiCallError; retryable: boolean }
> {
  try {
    const response = await fetch(target.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${target.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let message = `${target.provider} chat completion failed: HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text) as RawCompletion;
        if (parsed.error?.message) message = parsed.error.message;
      } catch {
        // keep the generic message
      }
      return {
        ok: false,
        error: new AiCallError(message, response.status, text.slice(0, 500), label),
        retryable: isRetryableStatus(response.status),
      };
    }
    const data = (await response.json()) as RawCompletion;
    return { ok: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isAbort =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ok: false,
      error: new AiCallError(
        isAbort ? `timed out after ${timeoutMs}ms` : message,
        undefined,
        undefined,
        label,
      ),
      retryable: true,
    };
  }
}

function fail(opts: ChatOptions, error: AiCallError): null {
  bump(opts.label, 'failures', error.message);
  logger.warn(
    { label: opts.label, status: error.status, detail: error.detail, err: error.message },
    'ai.chat failed',
  );
  if (opts.throwOnError) throw error;
  return null;
}

/**
 * Chat completion. Returns null on any failure (or throws when `throwOnError`), never
 * partially-parsed content. Sites that previously checked `if (!env.openAiApiKey)` should
 * gate on `env.aiEnabled`; the client also returns null when the active provider has no key.
 */
export async function chat(opts: ChatOptions): Promise<ChatResult | null> {
  if (!env.aiEnabled) {
    return fail(
      opts,
      new AiCallError(
        'AI is not configured for the active provider',
        undefined,
        undefined,
        opts.label,
      ),
    );
  }

  if (opts.budgetKey && opts.budgetLimit != null) {
    if (!budgets.take(opts.budgetKey, opts.budgetLimit)) {
      bump(opts.label, 'budgetDenied');
      return opts.throwOnError
        ? Promise.reject(new AiCallError('hourly AI budget exhausted', 429, undefined, opts.label))
        : null;
    }
  }

  const run = () => execute(opts);
  return opts.serialize ? queue.enqueue(run) : run();
}

async function execute(opts: ChatOptions): Promise<ChatResult | null> {
  const config = providerConfig();
  let target: ResolvedTarget;
  try {
    target = resolveTarget(config, opts.tier, {
      modelOverride: opts.modelOverride,
      openaiModel: opts.openaiModel,
    });
  } catch (err) {
    return fail(
      opts,
      new AiCallError(
        err instanceof Error ? err.message : String(err),
        undefined,
        undefined,
        opts.label,
      ),
    );
  }

  const attempts = Math.max(1, opts.retry?.attempts ?? 3);
  const baseDelay = opts.retry?.baseDelayMs ?? 750;
  const timeoutMs = opts.timeoutMs ?? env.aiTimeoutMs;
  let maxTokens = opts.maxTokens;
  let schemaFallback = false;
  let grewOnce = false;

  bump(opts.label, 'calls');
  const startedAt = Date.now();

  for (let attempt = 1; ; attempt++) {
    const body = buildRequestBody(config, target, {
      tier: opts.tier,
      messages: opts.messages,
      json: opts.json,
      maxTokens,
      temperature: opts.temperature,
      schemaFallback,
    });

    const result = await post(target, body, timeoutMs, opts.label);

    if (!result.ok) {
      // Strict json_schema not accepted -> retry once with json_object + inlined schema.
      if (
        !schemaFallback &&
        opts.json &&
        opts.json !== true &&
        result.error.status != null &&
        result.error.status >= 400 &&
        result.error.status < 500 &&
        result.error.status !== 429
      ) {
        schemaFallback = true;
        logger.info(
          { label: opts.label, model: target.model },
          'ai.chat json_schema rejected; using json_object fallback',
        );
        continue;
      }
      if (result.retryable && attempt < attempts) {
        await sleep(baseDelay * attempt);
        continue;
      }
      return fail(opts, result.error);
    }

    const choice = result.data.choices?.[0];
    const content = choice?.message?.content;
    const finishReason = choice?.finish_reason;
    const latencyMs = Date.now() - startedAt;

    if (typeof content !== 'string' || content.trim().length === 0) {
      if (finishReason === 'length' && opts.growOnTruncation && !grewOnce && maxTokens) {
        grewOnce = true;
        maxTokens = Math.round(maxTokens * 1.6);
        logger.info(
          { label: opts.label, maxTokens },
          'ai.chat empty truncated reply; growing budget',
        );
        continue;
      }
      return fail(
        opts,
        new AiCallError(
          'empty completion',
          undefined,
          `finish_reason=${finishReason ?? 'n/a'}`,
          opts.label,
        ),
      );
    }

    // Truncated JSON that does not repair -> one retry with a bigger budget.
    if (opts.json && opts.growOnTruncation && !grewOnce && finishReason === 'length' && maxTokens) {
      if (parseJsonLoose(content) == null) {
        grewOnce = true;
        maxTokens = Math.round(maxTokens * 1.6);
        logger.info(
          { label: opts.label, maxTokens },
          'ai.chat truncated JSON did not repair; growing budget',
        );
        continue;
      }
    }

    logger.info(
      {
        label: opts.label,
        provider: target.provider,
        tier: opts.tier,
        model: target.model,
        latencyMs,
        finishReason,
        usage: result.data.usage,
        attempt,
      },
      'ai.chat',
    );

    return {
      content,
      finishReason,
      usage: result.data.usage,
      model: target.model,
      provider: target.provider,
      raw: result.data,
    };
  }
}

/**
 * Chat completion parsed as JSON with tolerant extraction and truncation repair. Forces
 * `json: true` when the caller did not ask for a structured format. Returns null when the
 * reply is not parseable (logged), or throws when `throwOnError`.
 */
export async function chatJson<T = Record<string, unknown>>(opts: ChatOptions): Promise<T | null> {
  const result = await chat({ ...opts, json: opts.json ?? true });
  if (!result) return null;
  const parsed = parseJsonLoose<T>(result.content);
  if (parsed == null) {
    const error = new AiCallError(
      `JSON parse failed (finish_reason=${result.finishReason ?? 'n/a'}, length=${result.content.length})`,
      undefined,
      undefined,
      opts.label,
    );
    bump(opts.label, 'failures', error.message);
    logger.warn(
      { label: opts.label, model: result.model, finishReason: result.finishReason },
      'ai.chatJson unparseable reply',
    );
    if (opts.throwOnError) throw error;
    return null;
  }
  return parsed;
}

/** Convenience for the very common system + user prompt pair. */
export function systemUser(system: string, user: string): ChatMessage[] {
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
