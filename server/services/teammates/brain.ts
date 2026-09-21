import { env } from '../../env.js';
import { bandRules, type BotParams } from './intellect.js';
import { callJson } from './llmQueue.js';
import { openCommitments, type BotMemory } from './memory.js';
import type { Situation } from './perception.js';
import type { TriageItem } from './triage.js';
import type { BotAction, BotPersona } from './types.js';

/**
 * The player brain (docs/ai-teammate-bots-plan.md §9.3).
 *
 * Triage has already decided what is worth doing; the model picks among the top
 * items and writes the copy, under a strict JSON schema. High intellect adds the
 * game's own grading dimensions and watchdog ladder to the prompt and runs a
 * critique-and-revise pass on high-stakes artefacts. Every path has a template
 * fallback so an LLM outage never stalls a bot.
 */

export interface BrainInput {
  sit: Situation;
  params: BotParams;
  mem: BotMemory;
  persona: BotPersona;
  shortlist: TriageItem[];
  /** Whether the planner is on. When off, the model chooses freely from the feed (legacy). */
  plannerOn: boolean;
  sessionId: string;
}

export interface BrainStats {
  calls: number;
  fallbacks: number;
  critiques: number;
  lastError: string | null;
}

export const brainStats: BrainStats = { calls: 0, fallbacks: 0, critiques: 0, lastError: null };

const SHORTLIST_SIZE = 4;

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

const GRADING_NOTES = [
  'HOW YOUR WORK IS GRADED (the game scores every public post and email):',
  '- accuracy (only confirmed facts; label rumours as unverified), tone, cultural sensitivity,',
  '  persuasiveness, completeness, clarity; official statements also score authority and call-to-action;',
  '  role fit (did you act within your charter).',
  '- Official statements are judged on posture: reactive (denies) < defensive < accommodative (accepts',
  '  responsibility, does what is required) < proactive (anticipates, does more). Aim for proactive.',
  '- The watchdog penalises silence at T+20 and T+35, contradicting an earlier statement, and',
  '  repeating a false claim without labelling it false.',
  '- Team score = content quality + completing charter tasks on time + role fit + relaying intel.',
].join('\n');

function charterBlock(sit: Situation, params: BotParams): string {
  const c = sit.charter;
  if (!c)
    return `Your team: ${sit.me.teamName ?? 'unassigned'}. No charter is available; use judgement.`;
  const lines = [
    `Your team: ${c.team_name}${c.function_key && c.function_key !== c.team_name ? ` (${c.function_key})` : ''}.`,
    c.mission ? `Mission: ${c.mission}` : '',
    c.responsibilities.length
      ? `Responsibilities:\n${c.responsibilities.map((r) => `- ${r}`).join('\n')}`
      : '',
    c.out_of_lane.length
      ? `OUT OF LANE (never do these):\n${c.out_of_lane.map((r) => `- ${r}`).join('\n')}`
      : '',
    c.tasks.length
      ? `Expected of your team during this exercise:\n${c.tasks.map((t) => `- ${t}`).join('\n')}`
      : '',
  ];
  if (params.knowsRubric && c.expected_actions.length) {
    lines.push(
      'Timing benchmarks (do these by the minute shown):\n' +
        c.expected_actions
          .filter((a) => a.timing_benchmark_minutes !== null)
          .map((a) => `- T+${a.timing_benchmark_minutes}: ${a.description}`)
          .join('\n'),
    );
    if (c.scoring_rubric) lines.push(`Scoring rubric: ${c.scoring_rubric}`);
  }
  lines.push(
    c.can_post_publicly
      ? sit.me.isPageHolder
        ? `You control the official page (${sit.me.pageName ?? sit.me.pageHandle}). Official statements are published as the page.`
        : 'Your team owns the public voice, but a teammate holds the official page; you post as yourself and feed them.'
      : 'Your team does NOT speak publicly for the organisation. Public replies are out of lane; escalate instead.',
  );
  return lines.filter(Boolean).join('\n');
}

function factsBlock(sit: Situation, params: BotParams): string {
  const f = sit.facts;
  const parts = [
    'CONFIRMED FACTS (the only things you may state as fact):',
    ...(f.confirmed.length ? f.confirmed.map((x) => `- ${x}`) : ['- (none provided yet)']),
    '',
    'CLAIMS CIRCULATING THAT ARE NOT SUPPORTED BY EVIDENCE:',
    ...(f.unconfirmed.length ? f.unconfirmed.map((x) => `- ${x}`) : ['- (none listed)']),
  ];
  if (params.factDiscipline >= 0.6 && f.guidelines.length) {
    parts.push(
      '',
      'Best-practice guidelines for this crisis:',
      ...f.guidelines.map((g) => `- ${g}`),
    );
  }
  return parts.join('\n');
}

function memoryBlock(sit: Situation, mem: BotMemory): string {
  const parts: string[] = [];
  const recentStatements = mem.statements.slice(-2);
  if (recentStatements.length) {
    parts.push(
      'YOUR PRIOR OFFICIAL STATEMENTS (never contradict these):',
      ...recentStatements.map(
        (s) => `- [${minutesAgo(s.at, sit)} min ago] ${s.text.replace(/\s+/g, ' ').slice(0, 320)}`,
      ),
    );
  }
  const open = openCommitments(mem, sit.now);
  if (open.length) {
    parts.push('COMMITMENTS YOU MADE PUBLICLY:', ...open.map((c) => `- ${c.text}`));
  }
  const lastGrade = mem.grades[mem.grades.length - 1];
  if (lastGrade) {
    parts.push(
      `YOUR LAST GRADED ARTEFACT scored ${Math.round(lastGrade.overall)}/100.` +
        (lastGrade.improvements.length
          ? ` Improve: ${lastGrade.improvements.slice(0, 3).join('; ')}`
          : ''),
    );
  }
  if (mem.recentActions.length) {
    parts.push('WHAT YOU DID RECENTLY:', ...mem.recentActions.slice(-6).map((a) => `- ${a}`));
  }
  return parts.join('\n');
}

function minutesAgo(at: number, sit: Situation): number {
  return Math.max(0, Math.round((sit.now - at) / 60_000));
}

export function systemPrompt(input: BrainInput): string {
  const { sit, params, persona } = input;
  const parts = [
    `You are ${persona.fullName}. ${persona.persona}`,
    `You work at ${sit.facts.orgName} in Singapore and you are playing your real job in a live crisis-response exercise.`,
    '',
    charterBlock(sit, params),
    '',
    bandRules(params),
    '',
    factsBlock(sit, params),
  ];
  if (params.knowsRubric) parts.push('', GRADING_NOTES);
  const mem = memoryBlock(sit, input.mem);
  if (mem) parts.push('', mem);
  parts.push(
    '',
    'STYLE: write like a real Singaporean professional on a phone or laptop: plain English, no emoji,',
    'no hashtags unless natural, no markdown. Never mention that this is a simulation or an exercise.',
    params.factDiscipline >= 0.6
      ? 'Never invent numbers, names or events that are not in the CONFIRMED FACTS.'
      : '',
    'Team chat is internal and informal; emails are formal; public posts are careful.',
  );
  return parts.filter((p) => p !== undefined).join('\n');
}

function gaugesLine(sit: Situation): string {
  const g = sit.gauges;
  const f = (v: number | null) => (v === null ? '-' : String(Math.round(v)));
  return `Gauges: trust ${f(g.public_trust)}, safety ${f(g.community_safety)}, narrative control ${f(g.narrative_control)}, escalation risk ${f(g.escalation_risk)}.`;
}

function feedLines(sit: Situation, max = 10): string {
  return sit.feed
    .slice(0, max)
    .map(
      (p) =>
        `[${p.id.slice(0, 8)}] @${String(p.author_handle ?? '').replace(/^@+/, '')}${p.tags.length ? ` <${p.tags.join(',')}>` : ''}: ${p.content.replace(/\s+/g, ' ').slice(0, 200)}`,
    )
    .join('\n');
}

function chatLines(sit: Situation, max = 8): string {
  return sit.chat.recent
    .slice(-max)
    .map(
      (m) =>
        `${m.sender?.full_name ?? 'someone'}: ${(m.content ?? '').replace(/\s+/g, ' ').slice(0, 160)}`,
    )
    .join('\n');
}

const ITEM_GUIDANCE: Record<string, string> = {
  statement:
    'Write the official statement (120-220 words): what is confirmed, what is unverified, what we are doing, when the next update comes. Accept responsibility where the facts support it.',
  post: 'Write a short public post as yourself (under 280 characters).',
  reply:
    'Write a public reply (under 280 characters): correct the claim with a confirmed fact, no insults, no repeating the false claim as if true.',
  email_reply:
    'Write the email body (80-200 words), formal, answering what was asked, promising only what the facts support. Put a subject in `subject` (or leave null to reuse "Re: ...").',
  email_forward:
    'Write a two-sentence cover note explaining why the recipient team needs this and what they should do with it.',
  dm_reply:
    'Write a direct message reply (under 400 characters), warm, specific, no over-promising.',
  draft_create:
    'Write the document text (120-260 words) that will go to review before publication. Put the title in `subject`.',
  draft_review:
    'Set `verdict` to approve or request_changes and write the review note in `text` (1-3 sentences: legal risk, factual accuracy, commitments).',
  chat: 'Write one to three sentences of chat. If someone asked you something or messaged you privately, answer THEM specifically (what you know, what you will do, by when). If the item is TEAM PLAN, list who does what next. If STATUS UPDATE, one line on what you are handling.',
  dispute:
    'Write the factual rebuttal that will be submitted with the dispute (2-4 sentences citing confirmed facts).',
  report: 'Optionally write a one-line reason for the report.',
  flag: 'No text needed.',
  like: 'No text needed.',
  repost: 'No text needed.',
  read_news: 'No text needed.',
  email_read: 'No text needed.',
  fact_check: 'No text needed.',
  escalate: 'Write one sentence describing what you are escalating and to whom.',
  idle: 'No text needed.',
};

export function userPrompt(input: BrainInput): string {
  const { sit, shortlist } = input;
  const list = shortlist
    .slice(0, SHORTLIST_SIZE)
    .map(
      (it, i) =>
        `${i + 1}. ${it.kind.toUpperCase()} — ${it.reason}${it.context ? `\n   ${it.context.replace(/\s+/g, ' ').slice(0, 700)}` : ''}\n   -> ${ITEM_GUIDANCE[it.kind] ?? ''}`,
    )
    .join('\n');
  return [
    `Elapsed: T+${sit.elapsedMinutes} minutes. ${gaugesLine(sit)}`,
    '',
    'ON YOUR DESK (most urgent first):',
    list || '(nothing specific — monitor)',
    '',
    'RECENT FEED:',
    feedLines(sit) || '(quiet)',
    '',
    'RECENT TEAM CHAT:',
    chatLines(sit) || '(quiet)',
    '',
    `Choose ONE item by number (1-${Math.min(SHORTLIST_SIZE, shortlist.length)}), or 0 to keep monitoring, and write the text it needs.`,
    'Prefer the most urgent item unless a lower one is clearly more valuable right now.',
  ].join('\n');
}

const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    choice: { type: 'integer', description: '1-based index into the desk list, or 0 to monitor' },
    text: { type: ['string', 'null'] },
    subject: { type: ['string', 'null'] },
    verdict: { type: ['string', 'null'], enum: ['approve', 'request_changes', null] },
    reason: { type: 'string' },
  },
  required: ['choice', 'text', 'subject', 'verdict', 'reason'],
  additionalProperties: false,
} as const;

interface DecisionOut {
  choice: number;
  text: string | null;
  subject: string | null;
  verdict: 'approve' | 'request_changes' | null;
  reason: string;
}

const NEEDS_TEXT = new Set([
  'statement',
  'post',
  'reply',
  'email_reply',
  'email_forward',
  'dm_reply',
  'draft_create',
  'draft_review',
  'chat',
  'dispute',
  'escalate',
]);

// ---------------------------------------------------------------------------
// Decide
// ---------------------------------------------------------------------------

export async function decide(input: BrainInput): Promise<BotAction> {
  const { shortlist, params } = input;
  if (shortlist.length === 0) return { kind: 'idle', reason: 'nothing to do', source: 'triage' };

  // No model: deterministic top item with template copy.
  if (!env.aiEnabled) return fallback(input, shortlist[0], 'ai disabled');

  brainStats.calls++;
  const tier: 'fast' | 'strong' =
    params.modelTier === 'strong' && highStakes(shortlist[0].kind) ? 'strong' : 'fast';
  const out = await callJson<DecisionOut>({
    sessionId: input.sessionId,
    tier,
    system: systemPrompt(input),
    user: userPrompt(input),
    schemaName: 'teammate_decision',
    schema: DECISION_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 700,
  });
  if (!out) return fallback(input, shortlist[0], 'model unavailable');

  const idx = Number(out.choice);
  if (idx === 0) return { kind: 'idle', reason: out.reason || 'monitoring', source: 'llm' };
  const item =
    shortlist[Math.min(SHORTLIST_SIZE, shortlist.length) >= idx && idx > 0 ? idx - 1 : -1];
  if (!item) return fallback(input, shortlist[0], `invalid choice ${out.choice}`);

  let text = clean(out.text);
  if (NEEDS_TEXT.has(item.kind) && !text) {
    // Approved-draft statements carry their own wording.
    if (item.kind === 'statement' && item.context) text = item.context;
    else return fallback(input, item, 'empty text');
  }
  if (item.kind === 'statement' && item.targetId && item.context) {
    // Publish the Legal-approved wording as-is.
    text = item.context;
  }

  const action: BotAction = {
    kind: item.kind,
    targetId: item.targetId ?? null,
    text,
    subject: clean(out.subject) ?? item.subject ?? null,
    to: item.to ?? null,
    verdict: item.kind === 'draft_review' ? (out.verdict ?? 'approve') : null,
    channelId: item.channelId ?? null,
    reason: out.reason || item.reason,
    source: 'llm',
  };
  if (item.recipientHandle) action.targetId = item.targetId;

  if (params.critiquePass && env.teammateBotsCritique && highStakes(item.kind) && action.text) {
    action.text = await critique(input, item, action.text);
  }
  return action;
}

function highStakes(kind: string): boolean {
  return (
    kind === 'statement' ||
    kind === 'draft_create' ||
    kind === 'email_reply' ||
    kind === 'draft_review'
  );
}

const CRITIQUE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer' },
    problems: { type: 'array', items: { type: 'string' } },
    revised_text: { type: 'string' },
  },
  required: ['score', 'problems', 'revised_text'],
  additionalProperties: false,
} as const;

/** Second pass: score the draft against the rubric and revise once. */
export async function critique(input: BrainInput, item: TriageItem, text: string): Promise<string> {
  brainStats.critiques++;
  const out = await callJson<{ score: number; problems: string[]; revised_text: string }>({
    sessionId: input.sessionId,
    tier: 'strong',
    system: [
      "You are the organisation's toughest crisis-communications editor and its lawyer.",
      GRADING_NOTES,
      '',
      factsBlock(input.sit, input.params),
      '',
      'Score the draft 0-100 against those dimensions, list concrete problems, then return a revised',
      "version that fixes them while keeping the author's intent, length and register. Do not add facts",
      'that are not confirmed. Keep every commitment the author made unless it is unsafe.',
    ].join('\n'),
    user: `ARTEFACT TYPE: ${item.kind}\nPURPOSE: ${item.reason}\n\nDRAFT:\n${text}`,
    schemaName: 'teammate_critique',
    schema: CRITIQUE_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 900,
  });
  const revised = clean(out?.revised_text);
  return revised && revised.length > 40 ? revised : text;
}

// ---------------------------------------------------------------------------
// Fallbacks
// ---------------------------------------------------------------------------

function fallback(input: BrainInput, item: TriageItem, why: string): BotAction {
  brainStats.fallbacks++;
  brainStats.lastError = why;
  const { sit, params } = input;
  const fact = sit.facts.confirmed[0];
  const drilled = params.laneDiscipline >= 0.85;
  const template = (): string | null => {
    switch (item.kind) {
      case 'statement':
        return (
          item.context ??
          (drilled
            ? `We are aware of the claims circulating about ${sit.facts.orgName}. Here is what we can confirm now: ${fact ?? 'an internal review is under way'}. We have also seen claims that are not supported by evidence, and we will address them directly. Services continue as normal. We will publish a verified update within the hour.`
            : `We are aware of recent online discussion and we take all feedback seriously. ${sit.facts.orgName} has always acted with integrity. We ask the public not to speculate while we look into the matter.`)
        );
      case 'reply':
        return drilled
          ? `This claim is not supported by evidence. What is confirmed: ${fact ?? 'the matter is under review and services continue as scheduled'}. We will keep publishing verified updates.`
          : 'We are looking into this and will share more when we can.';
      case 'post':
        return drilled
          ? `Update from ${sit.facts.orgName}: ${fact ?? 'we are reviewing the situation'}. More to follow.`
          : 'A lot of what is being said online right now is simply unfair to the people who work here.';
      case 'email_reply':
        return drilled
          ? `Thank you for your message. What we can confirm at this stage: ${fact ?? 'an internal review is under way and services continue as scheduled'}. We are not able to comment on unverified claims. We will send a further update within the hour and are happy to take questions in the meantime.`
          : 'Thank you for reaching out. We are looking into this and will revert as soon as we can.';
      case 'email_forward':
        return 'Forwarding this to you because it falls in your lane. Please review and let the team know what you need from us.';
      case 'dm_reply':
        return drilled
          ? `Thanks for reaching out. ${fact ?? 'We are reviewing the situation and services continue as normal'}. If you have a specific concern I can help with, tell me and I will follow up directly.`
          : 'Thanks for your message, we are looking into it.';
      case 'draft_create':
        return `Holding statement.\n\n${sit.facts.orgName} is aware of the claims circulating about our operations. What we can confirm: ${fact ?? 'an internal review is under way'}. Claims beyond this are not supported by evidence and we will address them directly. Our services continue as scheduled. We will publish a verified update within the hour.`;
      case 'draft_review':
        return 'Reviewed. No admissions of liability, no unverified claims stated as fact. Approved for publication.';
      case 'chat':
        if (item.targetId === 'plan')
          return drilled
            ? 'Plan for the next 15 minutes: I take the inbox and anything addressed to us; second seat monitors the feed and flags false claims; everything legal-risk goes to Legal before it goes out. Shout if you need a fact confirmed.'
            : 'Anyone know what we are supposed to be saying about this?';
        if (item.targetId === 'status')
          return drilled
            ? 'Monitoring my lane; nothing needing escalation this minute.'
            : 'Still catching up on the feed.';
        if (item.context?.startsWith('Flag for the team'))
          return `${item.context.slice(0, 260)} — needs a factual counter from the voice team.`;
        if (item.context?.startsWith('PRIVATE 1:1 CHAT'))
          return drilled
            ? `Got your message. What I can confirm right now: ${fact ?? 'the matter is under review'}. I'll come back to you here as soon as I have more.`
            : 'Saw this, will get back to you.';
        return drilled ? 'Noted. Handling it now and will report back here.' : 'Noted.';
      case 'dispute':
        return `This content is inaccurate. Confirmed position: ${fact ?? 'the matter is under formal review'}. Requesting correction or removal on that basis.`;
      case 'escalate':
        return 'Escalating a legal-risk item to Legal for review before any public response.';
      default:
        return null;
    }
  };
  return {
    kind: item.kind,
    targetId: item.targetId ?? null,
    text: template(),
    subject: item.subject ?? null,
    to: item.to ?? null,
    verdict: item.kind === 'draft_review' ? 'approve' : null,
    channelId: item.channelId ?? null,
    reason: `${item.reason} (fallback: ${why})`,
    source: 'fallback',
  };
}

function clean(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t.length ? t.slice(0, 2000) : null;
}
