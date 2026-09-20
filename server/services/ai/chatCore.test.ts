import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HourlyBudget,
  OPENAI_CHAT_URL,
  buildRequestBody,
  isRetryableStatus,
  modelRejectsTemperature,
  parseJsonLoose,
  repairTruncatedJson,
  resolveTarget,
  type ProviderConfig,
} from './chatCore.js';

const openai: ProviderConfig = {
  provider: 'openai',
  openAiApiKey: 'sk-test',
  bedrockModels: {
    fast: 'us.openai.gpt-5.6-luna',
    standard: 'us.openai.gpt-5.6-terra',
    vision: 'us.openai.gpt-5.6-terra',
  },
  temperaturePolicy: 'auto',
  fastMinCompletionTokens: 0,
};

const bedrock: ProviderConfig = {
  ...openai,
  provider: 'bedrock',
  aiApiKey: 'bedrock-key',
  aiBaseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/',
  fastMinCompletionTokens: 256,
};

const messages = [
  { role: 'system' as const, content: 'sys' },
  { role: 'user' as const, content: 'usr' },
];

test('openai mode resolves tiers to the pre-migration model names', () => {
  assert.equal(resolveTarget(openai, 'fast').model, 'gpt-4o-mini');
  assert.equal(resolveTarget(openai, 'standard').model, 'gpt-5.2');
  assert.equal(resolveTarget(openai, 'vision').model, 'gpt-5.1');
  assert.equal(resolveTarget(openai, 'fast').url, OPENAI_CHAT_URL);
  assert.equal(resolveTarget(openai, 'fast').apiKey, 'sk-test');
});

test('openai mode honours the parity override; bedrock ignores it', () => {
  assert.equal(resolveTarget(openai, 'standard', { openaiModel: 'gpt-5.5' }).model, 'gpt-5.5');
  assert.equal(
    resolveTarget(bedrock, 'standard', { openaiModel: 'gpt-5.5' }).model,
    'us.openai.gpt-5.6-terra',
  );
  assert.equal(
    resolveTarget(bedrock, 'fast', { modelOverride: 'us.openai.gpt-5.6-sol' }).model,
    'us.openai.gpt-5.6-sol',
  );
});

test('bedrock mode builds the chat-completions URL from AI_BASE_URL and uses AI_API_KEY', () => {
  const t = resolveTarget(bedrock, 'fast');
  assert.equal(t.url, 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions');
  assert.equal(t.apiKey, 'bedrock-key');
  assert.equal(t.model, 'us.openai.gpt-5.6-luna');
});

test('missing keys throw with a clear message', () => {
  assert.throws(
    () => resolveTarget({ ...openai, openAiApiKey: undefined }, 'fast'),
    /OPENAI_API_KEY/,
  );
  assert.throws(() => resolveTarget({ ...bedrock, aiApiKey: undefined }, 'fast'), /AI_API_KEY/);
});

test('ceiling key: max_tokens for openai gpt-4*, max_completion_tokens otherwise', () => {
  const fast = buildRequestBody(openai, resolveTarget(openai, 'fast'), {
    tier: 'fast',
    messages,
    maxTokens: 150,
  });
  assert.equal(fast.max_tokens, 150);
  assert.equal(fast.max_completion_tokens, undefined);

  const std = buildRequestBody(openai, resolveTarget(openai, 'standard'), {
    tier: 'standard',
    messages,
    maxTokens: 1000,
  });
  assert.equal(std.max_completion_tokens, 1000);
  assert.equal(std.max_tokens, undefined);

  const legacy = buildRequestBody(openai, resolveTarget(openai, 'fast', { openaiModel: 'gpt-4' }), {
    tier: 'fast',
    messages,
    maxTokens: 800,
  });
  assert.equal(legacy.max_tokens, 800);

  const br = buildRequestBody(bedrock, resolveTarget(bedrock, 'standard'), {
    tier: 'standard',
    messages,
    maxTokens: 1000,
  });
  assert.equal(br.max_completion_tokens, 1000);
  assert.equal(br.max_tokens, undefined);
});

test('bedrock fast tier applies the completion floor; other tiers do not', () => {
  const fast = buildRequestBody(bedrock, resolveTarget(bedrock, 'fast'), {
    tier: 'fast',
    messages,
    maxTokens: 30,
  });
  assert.equal(fast.max_completion_tokens, 256);
  const std = buildRequestBody(bedrock, resolveTarget(bedrock, 'standard'), {
    tier: 'standard',
    messages,
    maxTokens: 30,
  });
  assert.equal(std.max_completion_tokens, 30);
});

test('temperature policy: auto passes for gpt-4o-mini / gpt-5.2 and strips for gpt-5.5 / gpt-5.6', () => {
  assert.equal(modelRejectsTemperature('gpt-4o-mini'), false);
  assert.equal(modelRejectsTemperature('gpt-5.2'), false);
  assert.equal(modelRejectsTemperature('gpt-5.5'), true);
  assert.equal(modelRejectsTemperature('us.openai.gpt-5.6-luna'), true);
  assert.equal(modelRejectsTemperature('o3-mini'), true);

  const passes = buildRequestBody(openai, resolveTarget(openai, 'standard'), {
    tier: 'standard',
    messages,
    temperature: 0.85,
  });
  assert.equal(passes.temperature, 0.85);
  const stripped = buildRequestBody(
    openai,
    resolveTarget(openai, 'standard', { openaiModel: 'gpt-5.5' }),
    { tier: 'standard', messages, temperature: 0.3 },
  );
  assert.equal(stripped.temperature, undefined);
  const bedrockStripped = buildRequestBody(bedrock, resolveTarget(bedrock, 'fast'), {
    tier: 'fast',
    messages,
    temperature: 0.2,
  });
  assert.equal(bedrockStripped.temperature, undefined);

  const forced = buildRequestBody(
    { ...bedrock, temperaturePolicy: 'pass' },
    resolveTarget(bedrock, 'fast'),
    { tier: 'fast', messages, temperature: 0.2 },
  );
  assert.equal(forced.temperature, 0.2);
  const never = buildRequestBody(
    { ...openai, temperaturePolicy: 'strip' },
    resolveTarget(openai, 'fast'),
    { tier: 'fast', messages, temperature: 0.2 },
  );
  assert.equal(never.temperature, undefined);
});

test('temperature is omitted entirely when the caller did not set one', () => {
  const body = buildRequestBody(openai, resolveTarget(openai, 'standard'), {
    tier: 'standard',
    messages,
  });
  assert.equal('temperature' in body, false);
});

test('structured output: json_object, strict json_schema, and the inlined-schema fallback', () => {
  const obj = buildRequestBody(openai, resolveTarget(openai, 'fast'), {
    tier: 'fast',
    messages,
    json: true,
  });
  assert.deepEqual(obj.response_format, { type: 'json_object' });

  const spec = { name: 'plan', schema: { type: 'object', properties: { a: { type: 'string' } } } };
  const strict = buildRequestBody(openai, resolveTarget(openai, 'fast'), {
    tier: 'fast',
    messages,
    json: spec,
  });
  assert.deepEqual(strict.response_format, {
    type: 'json_schema',
    json_schema: { name: 'plan', strict: true, schema: spec.schema },
  });
  assert.equal(strict.messages[0].content, 'sys');

  const fallback = buildRequestBody(openai, resolveTarget(openai, 'fast'), {
    tier: 'fast',
    messages,
    json: spec,
    schemaFallback: true,
  });
  assert.deepEqual(fallback.response_format, { type: 'json_object' });
  assert.match(String(fallback.messages[0].content), /matching this schema/);
  assert.match(String(fallback.messages[0].content), /"properties"/);
});

test('parseJsonLoose tolerates fences, prose and truncation', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Sure! ```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Here you go: {"a":[1,2]} thanks'), { a: [1, 2] });
  assert.deepEqual(parseJsonLoose('[{"a":1},{"b":2}]'), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(parseJsonLoose('{"items":[{"name":"x"},{"name":"y'), {
    items: [{ name: 'x' }, { name: 'y' }],
  });
  assert.equal(parseJsonLoose('no json here'), null);
});

test('repairTruncatedJson closes strings and brackets', () => {
  assert.equal(repairTruncatedJson('{"a":[1,2'), '{"a":[1,2]}');
  assert.equal(repairTruncatedJson('{"a":"unterminated'), '{"a":"unterminated"}');
  assert.equal(repairTruncatedJson('{"a":1,'), '{"a":1}');
});

test('hourly budget counts per key and resets after the window', () => {
  const b = new HourlyBudget(1000);
  assert.equal(b.take('s1', 2, 0), true);
  assert.equal(b.take('s1', 2, 10), true);
  assert.equal(b.take('s1', 2, 20), false);
  assert.deepEqual(b.status('s1', 2, 20), { used: 2, limit: 2, resetsInMs: 980 });
  assert.equal(b.take('s2', 2, 20), true);
  assert.equal(b.take('s1', 2, 1001), true);
  b.forget('s1');
  assert.deepEqual(b.status('s1', 2, 1002), { used: 0, limit: 2, resetsInMs: 1000 });
});

test('retryable statuses', () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(502), true);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(401), false);
});
