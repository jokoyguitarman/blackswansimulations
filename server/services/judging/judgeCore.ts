/**
 * Rubric, prompt, validation and coalescing for inject-reply judgements.
 * No database, no network, no provider keys. The service calls chatJson.
 */

import { z } from 'zod';
import type { JudgementV1 } from '../ledger/injectLedgerCore.js';

export const JUDGE_TONES = [
  'empathetic',
  'professional',
  'apologetic',
  'defensive',
  'dismissive',
  'hostile',
  'evasive',
  'neutral',
] as const;

export type JudgeTone = (typeof JUDGE_TONES)[number];

export const SCORE_DIMENSIONS = ['accuracy', 'empathy', 'clarity', 'professionalism'] as const;

export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

export const INJECT_PROMPT_CHARS = 1200;
export const RESPONSE_PROMPT_CHARS = 2000;
export const COALESCE_WINDOW_MS = 20_000;
export const JUDGE_TIMEOUT_MS = 15_000;
/** After this, a `scheduled` mark no longer hides a row from the sweep. */
export const SCHEDULED_STALE_MS = COALESCE_WINDOW_MS + JUDGE_TIMEOUT_MS;
export const JUDGE_ATTEMPTS = 2;

const EMPATHETIC_RELATIONSHIPS = new Set(['community', 'client', 'union']);
const COALESCE_CHANNELS = new Set(['chat', 'npc_dm', 'messenger_dm']);

const GENERIC_CRITERIA = [
  "Acknowledges the sender's message and concern",
  'Responds to what the sender asked for',
  'Consistent with the confirmed facts; introduces no unverified claims',
  'States a next step or commitment',
] as const;

export const JUDGE_SYSTEM_PROMPT = `You are an assessor in a crisis-communications training exercise. You judge ONE player response to ONE
message the player received. Be strict and literal: judge only what the response actually says.
Never invent content. Quote evidence verbatim from the response (max 120 characters per quote).

Return ONLY JSON matching this schema:
{
  "addresses_inject": boolean,        // does the response actually deal with the received message?
  "relevance": integer 0-100,
  "criteria": [ { "id": "c1", "met": boolean, "evidence": string|null } ],   // one entry per criterion, same order
  "asks_answered": [ { "id": "a1", "answered": boolean } ],                 // one per ask, same order (may be empty)
  "tone": "empathetic"|"professional"|"apologetic"|"defensive"|"dismissive"|"hostile"|"evasive"|"neutral",
  "tone_confidence": number 0-1,
  "scores": { "accuracy": 0-100, "empathy": 0-100, "clarity": 0-100, "professionalism": 0-100 },
  "factual_errors": [string],         // contradictions of the confirmed facts, max 3
  "risky_admissions": [string],       // admissions of liability or disclosure of withheld info, max 3
  "commitments": [string],            // concrete promises made, max 3
  "summary": string                   // <= 200 characters, plain English, for the trainer
}`;

export interface ResponseRubric {
  asks: string[];
  criteria: string[];
  expected_tone: string[];
  pass_threshold: number;
}

export interface RubricInject {
  content?: string | null;
  delivery_config?: {
    response_rubric?: unknown;
    author_type?: string | null;
    sender_name?: string | null;
    author_display_name?: string | null;
  } | null;
  stakeholder?: { relationship?: string | null; name?: string | null } | null;
}

export interface RubricFactSheet {
  confirmed_facts?: readonly string[] | null;
}

export type JudgeChannelLabel = 'email' | 'chat' | 'dm' | 'call' | 'social';

export interface JudgePromptInput {
  channel: string;
  senderName?: string | null;
  relationship?: string | null;
  injectContent?: string | null;
  teamName?: string | null;
  attribution?: string | null;
  responseText?: string | null;
  facts?: readonly string[] | null;
  rubric: ResponseRubric;
}

export interface CoalesceRow {
  id: string;
  deliveryId: string;
  userId: string | null;
  channel: string;
  atMs: number;
  text: string;
}

export interface CoalesceJob {
  responseId: string;
  text: string;
  sourceIds: string[];
}

export interface CoalescePlan {
  jobs: CoalesceJob[];
  skipped: Array<{ id: string; into: string }>;
}

export type JudgeChatResult =
  | { kind: 'ok'; raw: unknown; model: string }
  | { kind: 'budget_denied' }
  | { kind: 'unavailable' }
  | { kind: 'failed' };

export interface JudgeChatRequest {
  sessionId: string;
  call: boolean;
  system: string;
  user: string;
}

/** Stand-in for chatJson. Tests pass a fake; the service passes the real client. */
export interface JudgeChatClient {
  complete(request: JudgeChatRequest): Promise<JudgeChatResult>;
}

export type JudgeTerminalStatus = 'done' | 'failed' | 'budget_denied' | 'skipped';

export interface JudgeOutcome {
  status: JudgeTerminalStatus;
  judgement: JudgementV1 | null;
  model: string | null;
}

const criterionSchema = z.object({
  id: z.string().optional(),
  met: z.boolean(),
  evidence: z.union([z.string(), z.null()]).optional(),
});

const askSchema = z.object({
  id: z.string().optional(),
  answered: z.boolean(),
});

const judgePayloadSchema = z.object({
  addresses_inject: z.boolean(),
  relevance: z.number(),
  criteria: z.array(criterionSchema),
  asks_answered: z.array(askSchema).optional(),
  tone: z.enum(JUDGE_TONES),
  tone_confidence: z.number(),
  scores: z.object({
    accuracy: z.number(),
    empathy: z.number(),
    clarity: z.number(),
    professionalism: z.number(),
  }),
  factual_errors: z.array(z.string()).optional(),
  risky_admissions: z.array(z.string()).optional(),
  commitments: z.array(z.string()).optional(),
  summary: z.string(),
});

export function isCoalesceChannel(channel: string): boolean {
  return COALESCE_CHANNELS.has(channel);
}

export function judgeChannelLabel(channel: string): JudgeChannelLabel {
  if (channel === 'email') return 'email';
  if (channel === 'chat') return 'chat';
  if (channel === 'npc_dm' || channel === 'messenger_dm') return 'dm';
  if (channel === 'call') return 'call';
  return 'social';
}

export function extractQuestionAsks(content: string, max = 3): string[] {
  const asks: string[] = [];
  for (const match of content.matchAll(/[^?\n]*\?/g)) {
    const text = match[0].replace(/\s+/g, ' ').trim();
    if (text.length <= 1) continue;
    asks.push(text);
    if (asks.length >= max) break;
  }
  return asks;
}

/** Four generic criteria. The fact sheet is quoted in the prompt, not copied into the criteria. */
export function deriveGenericRubric(
  inject: RubricInject,
  _factSheet?: RubricFactSheet | null,
): ResponseRubric {
  const relationship = inject.stakeholder?.relationship?.trim().toLowerCase() ?? '';
  const publicNpc = inject.delivery_config?.author_type === 'npc_public';
  const expected_tone = ['professional'];
  if (EMPATHETIC_RELATIONSHIPS.has(relationship) || publicNpc) expected_tone.push('empathetic');
  return {
    asks: extractQuestionAsks(inject.content ?? ''),
    criteria: [...GENERIC_CRITERIA],
    expected_tone,
    pass_threshold: 3,
  };
}

/** Reject a rubric that does not match the authored schema. Null means "use the generic rubric". */
export function responseRubricError(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'response_rubric must be an object';
  const record = raw as Record<string, unknown>;
  if (
    !Array.isArray(record.criteria) ||
    record.criteria.length === 0 ||
    record.criteria.some((item) => typeof item !== 'string' || item.trim() === '')
  ) {
    return 'response_rubric.criteria must be a non-empty list of strings';
  }
  if (
    record.asks !== undefined &&
    (!Array.isArray(record.asks) || record.asks.some((item) => typeof item !== 'string'))
  ) {
    return 'response_rubric.asks must be a list of strings';
  }
  if (
    !Array.isArray(record.expected_tone) ||
    record.expected_tone.length === 0 ||
    record.expected_tone.some(
      (tone) => typeof tone !== 'string' || !(JUDGE_TONES as readonly string[]).includes(tone),
    )
  ) {
    return 'response_rubric.expected_tone must list tones the judge understands';
  }
  const threshold = record.pass_threshold;
  if (
    typeof threshold !== 'number' ||
    !Number.isInteger(threshold) ||
    threshold < 1 ||
    threshold > record.criteria.length
  ) {
    return 'response_rubric.pass_threshold must be an integer from 1 to the number of criteria';
  }
  return null;
}

export function readAuthoredRubric(raw: unknown): ResponseRubric | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const criteria = cleanStrings(record.criteria);
  if (criteria.length === 0) return null;
  const tones = cleanStrings(record.expected_tone).filter((tone): tone is JudgeTone =>
    (JUDGE_TONES as readonly string[]).includes(tone),
  );
  const threshold = record.pass_threshold;
  const pass_threshold =
    typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 1
      ? Math.floor(threshold)
      : Math.min(3, criteria.length);
  return {
    asks: cleanStrings(record.asks),
    criteria,
    expected_tone: tones.length > 0 ? tones : ['professional'],
    pass_threshold,
  };
}

export function resolveRubric(
  inject: RubricInject,
  factSheet?: RubricFactSheet | null,
): { rubric: ResponseRubric; source: 'authored' | 'generic' } {
  const authored = readAuthoredRubric(inject.delivery_config?.response_rubric);
  if (authored) return { rubric: authored, source: 'authored' };
  return { rubric: deriveGenericRubric(inject, factSheet), source: 'generic' };
}

export function buildJudgeUserMessage(input: JudgePromptInput): string {
  const label = judgeChannelLabel(input.channel);
  const inject = clip(input.injectContent ?? '', INJECT_PROMPT_CHARS, 'head');
  const response = clip(
    input.responseText ?? '',
    RESPONSE_PROMPT_CHARS,
    label === 'call' ? 'tail' : 'head',
  );
  const relationship = input.relationship?.trim();
  const sender = input.senderName?.trim() || 'the sender';
  const team = input.teamName?.trim() || 'unknown';
  const heuristic =
    input.attribution === 'chat_heuristic' ? '; heuristic attribution: this may be unrelated' : '';
  const relation = relationship ? `, stakeholder relationship: ${relationship}` : '';
  return [
    `CHANNEL: ${label}`,
    `RECEIVED MESSAGE (from ${sender}${relation}):`,
    `"""${inject}"""`,
    `PLAYER RESPONSE (by a member of team ${team}${heuristic}):`,
    `"""${response}"""`,
    `CONFIRMED FACTS: ${formatFacts(input.facts ?? [])}`,
    `ASKS: ${formatNamed('a', input.rubric.asks)}`,
    `CRITERIA: ${formatNamed('c', input.rubric.criteria)}`,
    `EXPECTED TONE: {${input.rubric.expected_tone.join(', ')}}`,
  ].join('\n');
}

export function planCoalesce(
  rows: readonly CoalesceRow[],
  windowMs = COALESCE_WINDOW_MS,
): CoalescePlan {
  const jobs: CoalesceJob[] = [];
  const skipped: Array<{ id: string; into: string }> = [];
  const groups = new Map<string, CoalesceRow[]>();

  for (const row of rows) {
    if (!isCoalesceChannel(row.channel) || !row.userId) {
      jobs.push({ responseId: row.id, text: row.text, sourceIds: [row.id] });
      continue;
    }
    const key = `${row.deliveryId}\0${row.userId}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  for (const list of groups.values()) {
    const ordered = [...list].sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
    let burst: CoalesceRow[] = [];
    const flush = () => {
      if (burst.length === 0) return;
      const last = burst[burst.length - 1];
      if (!last) return;
      jobs.push({
        responseId: last.id,
        text: burst
          .map((row) => row.text.trim())
          .filter((text) => text.length > 0)
          .join('\n'),
        sourceIds: burst.map((row) => row.id),
      });
      for (const earlier of burst.slice(0, -1)) skipped.push({ id: earlier.id, into: last.id });
      burst = [];
    };
    for (const row of ordered) {
      const prev = burst[burst.length - 1];
      if (prev && row.atMs - prev.atMs > windowMs) flush();
      burst.push(row);
    }
    flush();
  }

  return { jobs, skipped };
}

/**
 * Turn one model payload into a stored judgement. An unknown tone, or any other
 * schema miss, fails the judgement. Numbers are clamped; unknown fields are dropped.
 */
export function validateJudgeOutput(
  raw: unknown,
  rubric: ResponseRubric,
  source: 'authored' | 'generic',
): { ok: true; judgement: JudgementV1 } | { ok: false } {
  const parsed = judgePayloadSchema.safeParse(raw);
  if (!parsed.success) return { ok: false };
  const body = parsed.data;
  const criteria = rubric.criteria.map((_criterion, index) => {
    const item = body.criteria[index];
    const evidence = item?.evidence?.trim() ?? '';
    return {
      id: `c${index + 1}`,
      met: item?.met === true,
      evidence: evidence ? evidence.slice(0, 120) : null,
    };
  });
  const asks =
    body.asks_answered == null
      ? []
      : rubric.asks.map((_ask, index) => ({
          id: `a${index + 1}`,
          answered: body.asks_answered?.[index]?.answered === true,
        }));
  const risky = clipStrings(body.risky_admissions, 3);
  const criteriaMet = criteria.filter((item) => item.met).length;
  const addresses = body.addresses_inject;
  const judgement: JudgementV1 = {
    v: 1,
    addresses_inject: addresses,
    relevance: clampInt(body.relevance, 0, 100),
    criteria,
    asks_answered: asks,
    tone: body.tone,
    tone_confidence: clampUnit(body.tone_confidence),
    scores: {
      accuracy: clampInt(body.scores.accuracy, 0, 100),
      empathy: clampInt(body.scores.empathy, 0, 100),
      clarity: clampInt(body.scores.clarity, 0, 100),
      professionalism: clampInt(body.scores.professionalism, 0, 100),
    },
    factual_errors: clipStrings(body.factual_errors, 3),
    risky_admissions: risky,
    commitments: clipStrings(body.commitments, 3),
    summary: body.summary.trim().slice(0, 200),
    passed: criteriaMet >= rubric.pass_threshold && addresses && risky.length === 0,
    tone_ok: rubric.expected_tone.includes(body.tone),
    rubric_source: source,
    criteria_text: [...rubric.criteria],
  };
  return { ok: true, judgement };
}

/**
 * One model attempt, and at most one more when the reply is missing or invalid.
 * A denied budget or a disabled model stops immediately.
 */
export async function judgeWithClient(args: {
  sessionId: string;
  call: boolean;
  userMessage: string;
  rubric: ResponseRubric;
  rubricSource: 'authored' | 'generic';
  client: JudgeChatClient;
}): Promise<JudgeOutcome> {
  const request: JudgeChatRequest = {
    sessionId: args.sessionId,
    call: args.call,
    system: JUDGE_SYSTEM_PROMPT,
    user: args.userMessage,
  };
  for (let attempt = 1; attempt <= JUDGE_ATTEMPTS; attempt++) {
    let result: JudgeChatResult;
    try {
      result = await args.client.complete(request);
    } catch {
      result = { kind: 'failed' };
    }
    if (result.kind === 'budget_denied') {
      return { status: 'budget_denied', judgement: null, model: null };
    }
    if (result.kind === 'unavailable') {
      return { status: 'skipped', judgement: null, model: null };
    }
    if (result.kind === 'failed') continue;
    const validated = validateJudgeOutput(result.raw, args.rubric, args.rubricSource);
    if (validated.ok) {
      return { status: 'done', judgement: validated.judgement, model: result.model || null };
    }
  }
  return { status: 'failed', judgement: null, model: null };
}

/**
 * The burst job finished. Every admitted id leaves `scheduled`. Ids this job
 * did not write stay `queued` so the sweep can finish them without a restart.
 * Returns those unwritten ids.
 */
export function releaseUnwrittenBurstIds(
  scheduled: Set<string>,
  admitted: readonly string[],
  written: readonly string[],
): string[] {
  const done = new Set(written);
  const released: string[] = [];
  for (const id of admitted) {
    scheduled.delete(id);
    if (!done.has(id)) released.push(id);
  }
  for (const id of written) scheduled.delete(id);
  return released;
}

/** True while an in-memory schedule mark should keep the sweep from enqueueing this row. */
export function sweepKeepsScheduledHold(args: {
  scheduled: boolean;
  ageMs: number;
  staleAfterMs: number;
}): boolean {
  if (!args.scheduled) return false;
  return args.ageMs < args.staleAfterMs;
}

function clip(text: string, max: number, keep: 'head' | 'tail'): string {
  if (text.length <= max) return text;
  return keep === 'tail' ? text.slice(text.length - max) : text.slice(0, max);
}

function formatFacts(facts: readonly string[]): string {
  const lines = facts
    .slice(0, 8)
    .map((fact) => fact.replace(/\s+/g, ' ').trim())
    .filter((fact) => fact.length > 0);
  if (lines.length === 0) return '(none)';
  return `\n${lines.map((fact) => `- ${fact}`).join('\n')}`;
}

function formatNamed(prefix: string, items: readonly string[]): string {
  if (items.length === 0) return '{}';
  const parts = items.map(
    (item, index) => `${prefix}${index + 1}: ${item.replace(/\s+/g, ' ').trim()}`,
  );
  return `{${parts.join(', ')}}`;
}

function cleanStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function clipStrings(value: string[] | undefined, max: number): string[] {
  return (value ?? [])
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, max);
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
