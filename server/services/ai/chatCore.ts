/**
 * Provider-agnostic core of the shared chat client (docs/AWS_BEDROCK_MIGRATION_v2.md §7.2).
 *
 * Pure functions only: no env, no logger, no network. `chatClient.ts` binds these to the
 * process configuration. Kept separate so the request-shape rules (tier -> model, ceiling
 * key, temperature policy, structured-output format, JSON repair) are unit-testable without
 * the Supabase-backed `env` module.
 */

export type AiProvider = 'openai' | 'bedrock';
export type AiTier = 'fast' | 'standard' | 'vision';
export type AiTemperaturePolicy = 'auto' | 'pass' | 'strip';

export type ChatRole = 'system' | 'user' | 'assistant';
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };
export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[];
}

export interface JsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
}

export interface ProviderConfig {
  provider: AiProvider;
  /** OpenAI key (openai mode). */
  openAiApiKey?: string;
  /** Bedrock API key (bedrock mode). */
  aiApiKey?: string;
  /** Bedrock OpenAI-compatible base URL, e.g. https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1 */
  aiBaseUrl?: string;
  bedrockModels: Record<AiTier, string>;
  temperaturePolicy: AiTemperaturePolicy;
  fastMinCompletionTokens: number;
}

export const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

/**
 * What each tier means while AI_PROVIDER=openai. These are the models the call sites used
 * before the migration, so openai mode stays behaviour-neutral for the majority of sites;
 * sites that used gpt-5.1 / gpt-5.5 / gpt-4 pass `openaiModel` for exact parity.
 */
export const OPENAI_TIER_MODELS: Record<AiTier, string> = {
  fast: 'gpt-4o-mini',
  standard: 'gpt-5.2',
  vision: 'gpt-5.1',
};

/**
 * Models that reject any non-default `temperature` with HTTP 400. gpt-5.5 is proven
 * (contentGraderService silently fell back to a default grade until the parameter was
 * removed). GPT-5.6 on Bedrock is assumed to behave the same until smoke check 8.3 says
 * otherwise; o-series reasoning models never accepted it.
 */
const TEMPERATURE_REJECTING_MODELS: RegExp[] = [/gpt-5\.5/i, /gpt-5\.6/i, /(^|[^a-z])o[1-9](-|$)/i];

export function modelRejectsTemperature(model: string): boolean {
  return TEMPERATURE_REJECTING_MODELS.some((re) => re.test(model));
}

export interface ResolveOptions {
  /** Exact model id on the ACTIVE provider (e.g. the bots' TEAMMATE_BOTS_MODEL_* overrides). */
  modelOverride?: string;
  /** Exact OpenAI model to use while provider=openai (migration parity); ignored on Bedrock. */
  openaiModel?: string;
}

export interface ResolvedTarget {
  provider: AiProvider;
  url: string;
  apiKey: string;
  model: string;
}

/** Resolve URL, key and model for a tier. Throws when the active provider has no key. */
export function resolveTarget(
  config: ProviderConfig,
  tier: AiTier,
  opts: ResolveOptions = {},
): ResolvedTarget {
  if (config.provider === 'bedrock') {
    if (!config.aiApiKey || !config.aiBaseUrl) {
      throw new Error('AI_PROVIDER=bedrock requires AI_API_KEY and AI_BASE_URL');
    }
    return {
      provider: 'bedrock',
      url: `${config.aiBaseUrl.replace(/\/+$/, '')}/chat/completions`,
      apiKey: config.aiApiKey,
      model: opts.modelOverride ?? config.bedrockModels[tier],
    };
  }
  if (!config.openAiApiKey) throw new Error('OPENAI_API_KEY is not configured');
  return {
    provider: 'openai',
    url: OPENAI_CHAT_URL,
    apiKey: config.openAiApiKey,
    model: opts.modelOverride ?? opts.openaiModel ?? OPENAI_TIER_MODELS[tier],
  };
}

export interface BodyOptions {
  tier: AiTier;
  messages: ChatMessage[];
  json?: boolean | JsonSchemaSpec;
  maxTokens?: number;
  temperature?: number;
  /** When true, a `json_schema` request is downgraded to `json_object` + inlined schema. */
  schemaFallback?: boolean;
}

export interface RequestBody {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  response_format?:
    | { type: 'json_object' }
    | {
        type: 'json_schema';
        json_schema: { name: string; strict: true; schema: Record<string, unknown> };
      };
}

/**
 * Build the wire body. Rules:
 * - Ceiling: `max_completion_tokens` everywhere, except openai-mode gpt-4* models keep
 *   `max_tokens` so the request is byte-identical to what those sites send today.
 * - Fast-tier floor under Bedrock (`fastMinCompletionTokens`), see §8.4.
 * - Temperature policy: pass / strip / auto (auto drops it for models that 400 on it).
 * - Structured output: json_object, or strict json_schema with an optional downgrade that
 *   inlines the schema into the system prompt (ported from teammates/llmQueue.ts).
 */
export function buildRequestBody(
  config: ProviderConfig,
  target: ResolvedTarget,
  opts: BodyOptions,
): RequestBody {
  let messages = opts.messages;
  const body: RequestBody = { model: target.model, messages };

  if (opts.maxTokens != null) {
    let ceiling = Math.max(1, Math.round(opts.maxTokens));
    if (
      target.provider === 'bedrock' &&
      opts.tier === 'fast' &&
      config.fastMinCompletionTokens > 0
    ) {
      ceiling = Math.max(ceiling, config.fastMinCompletionTokens);
    }
    if (target.provider === 'openai' && /^gpt-4/i.test(target.model)) {
      body.max_tokens = ceiling;
    } else {
      body.max_completion_tokens = ceiling;
    }
  }

  if (opts.temperature != null) {
    const policy = config.temperaturePolicy;
    const send =
      policy === 'pass'
        ? true
        : policy === 'strip'
          ? false
          : !modelRejectsTemperature(target.model);
    if (send) body.temperature = opts.temperature;
  }

  if (opts.json) {
    if (opts.json === true || opts.schemaFallback) {
      if (opts.json !== true && opts.schemaFallback) {
        const spec = opts.json;
        messages = messages.map((m, i) =>
          i === 0 && m.role === 'system' && typeof m.content === 'string'
            ? {
                ...m,
                content: `${m.content}\n\nReply with a single JSON object matching this schema:\n${JSON.stringify(spec.schema)}`,
              }
            : m,
        );
        if (!(messages[0]?.role === 'system')) {
          messages = [
            {
              role: 'system',
              content: `Reply with a single JSON object matching this schema:\n${JSON.stringify(spec.schema)}`,
            },
            ...messages,
          ];
        }
        body.messages = messages;
      }
      body.response_format = { type: 'json_object' };
    } else {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: opts.json.name, strict: true, schema: opts.json.schema },
      };
    }
  }

  return body;
}

// ---------------------------------------------------------------------------
// Tolerant JSON handling
// ---------------------------------------------------------------------------

/**
 * Close any unterminated strings / brackets in a truncated JSON document so it parses.
 * Moved here from warroomAiService.ts (which re-exports it).
 */
export function repairTruncatedJson(raw: string): string {
  let s = raw.trim();
  s = s.replace(/,\s*$/, '');

  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (const ch of s) {
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    if (ch === '}' || ch === ']') stack.pop();
  }
  if (inString) s += '"';
  while (stack.length > 0) {
    const opener = stack.pop();
    s = s.replace(/,\s*$/, '');
    s += opener === '{' ? '}' : ']';
  }
  return s;
}

/**
 * Parse a model reply as JSON, tolerating prose or markdown fences around it and, as a
 * last resort, truncation. Returns null when nothing parseable is found.
 */
export function parseJsonLoose<T = unknown>(content: string): T | null {
  const trimmed = content.trim();
  const attempts: string[] = [trimmed];

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) attempts.push(fenced[1].trim());

  const firstObj = trimmed.indexOf('{');
  const firstArr = trimmed.indexOf('[');
  const start =
    firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
  if (start !== -1) {
    const closer = trimmed[start] === '{' ? '}' : ']';
    const end = trimmed.lastIndexOf(closer);
    if (end > start) attempts.push(trimmed.slice(start, end + 1));
    attempts.push(trimmed.slice(start));
  }

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // try next candidate
    }
  }
  for (const candidate of attempts) {
    try {
      return JSON.parse(repairTruncatedJson(candidate)) as T;
    } catch {
      // try next candidate
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-key hourly budgets (ported from teammates/llmQueue.ts, bots plan D11)
// ---------------------------------------------------------------------------

export interface BudgetStatus {
  used: number;
  limit: number;
  resetsInMs: number;
}

export class HourlyBudget {
  private readonly windows = new Map<string, { windowStart: number; used: number }>();
  constructor(private readonly windowMs = 60 * 60 * 1000) {}

  /** Consume one unit for `key`; false when the limit for this window is already spent. */
  take(key: string, limit: number, now = Date.now()): boolean {
    let w = this.windows.get(key);
    if (!w || now - w.windowStart >= this.windowMs) {
      w = { windowStart: now, used: 0 };
      this.windows.set(key, w);
    }
    if (w.used >= limit) return false;
    w.used++;
    return true;
  }

  status(key: string, limit: number, now = Date.now()): BudgetStatus {
    const w = this.windows.get(key);
    if (!w || now - w.windowStart >= this.windowMs) {
      return { used: 0, limit, resetsInMs: this.windowMs };
    }
    return { used: w.used, limit, resetsInMs: this.windowMs - (now - w.windowStart) };
  }

  forget(key: string): void {
    this.windows.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Global sequential queue (ported from teammates/llmQueue.ts)
// ---------------------------------------------------------------------------

export class SerialQueue {
  private readonly tasks: Array<() => Promise<void>> = [];
  private draining = false;
  constructor(private readonly interCallPauseMs = 800) {}

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.tasks.push(async () => {
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        }
      });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.tasks.length > 0) {
        const task = this.tasks.shift()!;
        await task();
        if (this.tasks.length > 0 && this.interCallPauseMs > 0) {
          await new Promise((r) => setTimeout(r, this.interCallPauseMs));
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

/** True for statuses the client retries (rate limits and upstream failures). */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}
