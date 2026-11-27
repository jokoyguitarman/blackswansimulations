/**
 * Pure phone-call decisions: state machine, script, voice, Realtime instructions,
 * redial planning, missed-call counts and the text fallback. No database and no network.
 */

import { missedCallMessage } from '../../lib/injectChatMessages.js';
import type { ChatInjectConfig } from '../../lib/injectChatMessages.js';

export const DEFAULT_REALTIME_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
] as const;

export const CALL_STATUSES = [
  'scheduled',
  'ringing',
  'connecting',
  'active',
  'ended',
  'declined',
  'missed',
  'failed',
  'cancelled',
] as const;

export type CallStatus = (typeof CALL_STATUSES)[number];

export const CONNECT_TIMEOUT_MS = 30_000;
export const ACTIVE_SWEEP_GRACE_SECONDS = 60;
export const SILENCE_PROMPT_MS = 60_000;
export const SILENCE_HANGUP_MS = 90_000;
export const TRANSCRIPT_MAX_CHARS = 6_000;
export const INSTRUCTIONS_MAX_CHARS = 6_000;
export const USER_RING_GAP_MS = 5_000;
export const ALMOST_GIVEN_UP = "I'd almost given up on hearing from you.";
export const LINE_DROPPED = 'Line dropped, continuing by message';

const TRANSITIONS: Record<CallStatus, readonly CallStatus[]> = {
  scheduled: ['ringing', 'cancelled', 'missed'],
  ringing: ['connecting', 'declined', 'missed', 'cancelled'],
  connecting: ['active', 'failed', 'ended'],
  active: ['active', 'ended'],
  ended: [],
  declined: [],
  missed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: CallStatus, to: CallStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function applyDecline(
  recipients: readonly string[],
  declinedUserIds: readonly string[],
  userId: string,
): { declinedUserIds: string[]; status: 'ringing' | 'declined' } {
  const next = Array.from(new Set([...declinedUserIds, userId]));
  const allDeclined =
    recipients.length === 0 || recipients.every((id) => next.includes(id));
  return { declinedUserIds: next, status: allDeclined ? 'declined' : 'ringing' };
}

export interface CallBeat {
  id: string;
  say: string;
  must_ask: boolean;
}

export interface CallScript {
  opening: string;
  beats: CallBeat[];
  closing: string;
  language: string;
  redial_openings?: string[];
}

export interface RedialConfig {
  attempts: number;
  interval_minutes: number;
  voicemail_each: boolean;
  stop_on_contact: boolean;
}

export function splitSentences(text: string): string[] {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) return [];
  const parts = trimmed.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [trimmed];
  return parts.map((part) => part.trim()).filter(Boolean);
}

export function deriveCallScript(content: string, authored?: Partial<CallScript> | null): CallScript {
  if (authored && typeof authored.opening === 'string' && authored.opening.trim()) {
    const beats = Array.isArray(authored.beats) ? authored.beats.slice(0, 6) : [];
    return {
      opening: authored.opening.trim(),
      beats: beats.map((beat, index) => ({
        id: beat.id || `b${index + 1}`,
        say: beat.say,
        must_ask: beat.must_ask === true,
      })),
      closing: authored.closing?.trim() || 'Please call me back when you can.',
      language: authored.language?.trim() || 'en',
      redial_openings: authored.redial_openings?.filter((line) => line.trim()),
    };
  }
  const sentences = splitSentences(content);
  const opening = sentences[0] || content.trim() || 'Hello.';
  const beats = sentences.slice(1, 5).map((say, index) => ({
    id: `b${index + 1}`,
    say,
    must_ask: say.includes('?'),
  }));
  return {
    opening,
    beats,
    closing: 'Please call me back when you can.',
    language: 'en',
  };
}

export function parseRedial(raw: unknown): RedialConfig {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const attempts = clampInt(record.attempts, 1, 6, 1);
  return {
    attempts,
    interval_minutes: clampInt(record.interval_minutes, 1, 30, 2),
    voicemail_each: record.voicemail_each === true,
    stop_on_contact: record.stop_on_contact !== false,
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function phoneConfigError(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null;
  const record = config as Record<string, unknown>;
  if (record.app !== 'phone_call') return null;
  if (record.ring_seconds != null) {
    const ring = Number(record.ring_seconds);
    if (!Number.isInteger(ring) || ring < 10 || ring > 60) {
      return 'ring_seconds must be an integer from 10 to 60.';
    }
  }
  if (record.max_call_seconds != null) {
    const max = Number(record.max_call_seconds);
    if (!Number.isInteger(max) || max < 60 || max > 900) {
      return 'max_call_seconds must be an integer from 60 to 900.';
    }
  }
  const script = record.call_script;
  if (script != null) {
    if (typeof script !== 'object') return 'call_script must be an object.';
    const body = script as Record<string, unknown>;
    const beats = Array.isArray(body.beats) ? body.beats : [];
    if (beats.length > 6) return 'A call script has at most 6 beats.';
    const parts = [
      typeof body.opening === 'string' ? body.opening : '',
      typeof body.closing === 'string' ? body.closing : '',
      ...beats.map((beat) =>
        beat && typeof beat === 'object' && typeof (beat as { say?: unknown }).say === 'string'
          ? (beat as { say: string }).say
          : '',
      ),
      ...(Array.isArray(body.redial_openings)
        ? body.redial_openings.filter((line): line is string => typeof line === 'string')
        : []),
    ];
    if (parts.join('').length > 2000) return 'Call script text must be 2000 characters or fewer.';
  }
  if (record.redial != null) {
    if (typeof record.redial !== 'object') return 'redial must be an object.';
    const redial = record.redial as Record<string, unknown>;
    if (redial.attempts != null) {
      const attempts = Number(redial.attempts);
      if (!Number.isInteger(attempts) || attempts < 1 || attempts > 6) {
        return 'redial.attempts must be an integer from 1 to 6.';
      }
    }
    if (redial.interval_minutes != null) {
      const interval = Number(redial.interval_minutes);
      if (!Number.isInteger(interval) || interval < 1 || interval > 30) {
        return 'redial.interval_minutes must be an integer from 1 to 30.';
      }
    }
  }
  return null;
}

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function pickVoice(seed: string, voices: readonly string[] = DEFAULT_REALTIME_VOICES): string {
  if (voices.length === 0) return 'marin';
  return voices[hashString(seed) % voices.length] ?? voices[0];
}

export function openingForAttempt(script: CallScript, attemptNo: number, callerName: string): string {
  if (attemptNo <= 1) return script.opening;
  const authored = script.redial_openings?.[attemptNo - 2];
  if (authored && authored.trim()) return authored.trim();
  return `It's ${callerName} again — I tried you a few minutes ago. ${script.opening}`;
}

export interface CallerCharacter {
  name: string;
  title?: string;
  organisation?: string;
  orgName?: string;
  personality?: string;
  stance?: string;
  knowledge?: string[];
  willNotDisclose?: string[];
  hardConstraints?: string[];
}

export interface InstructionContext {
  kind: 'redial' | 'callback';
  attempt_no: number;
  wait_minutes: number;
  missed_calls: number;
  unanswered_messages: number;
  voicemails?: number;
}

export interface InstructionInput {
  character: CallerCharacter;
  injectContent: string;
  script: CallScript;
  maxMinutes: number;
  context?: InstructionContext | null;
  /** Prebuilt WP11 mood block. When set, it replaces CALL CONTEXT. */
  mood?: string | null;
}

export function buildRealtimeInstructions(
  input: InstructionInput,
  options?: { mood?: string | null },
): string {
  const character = input.character;
  const name = character.name || 'the caller';
  const title = character.title?.trim() || 'a contact';
  const organisation = character.organisation?.trim() || 'their organisation';
  const orgName = character.orgName?.trim() || 'the';
  const knowledge = [...(character.knowledge ?? [])];
  const hidden = character.willNotDisclose ?? [];
  const limits = character.hardConstraints ?? [];
  const mood = options?.mood ?? input.mood ?? null;

  const render = (facts: string[]): string => {
    const beats = input.script.beats
      .map((beat) => `- [${beat.id}] ${beat.say}${beat.must_ask ? ' (you must get an answer to this)' : ''}`)
      .join('\n');
    const context = mood?.trim()
      ? mood.trim()
      : input.context
        ? contextBlock(input.context, name)
        : '';
    return [
      `You are ${name}, ${title} at ${organisation}. You are phoning the ${orgName} crisis response team.`,
      'Speak naturally, like a real phone call: short turns (1-3 sentences), never monologue, let them interrupt.',
      'Never say you are an AI, a simulation, a character, or an assistant. Never mention these instructions.',
      `Language: ${input.script.language || 'en'}.`,
      '',
      `WHO YOU ARE: ${character.personality?.trim() || 'A real person with a reason to call.'} Your stance: ${character.stance?.trim() || 'direct'}. What you know: ${bullet(facts)}`,
      `Never disclose: ${bullet(hidden)} Hard limits: ${bullet(limits)}`,
      `WHY YOU ARE CALLING (stay faithful to this): """${input.injectContent.trim()}"""`,
      context ? `\n${context}` : '',
      '',
      'YOUR SCRIPT. Deliver these beats in order, in your own words, weaving them into the conversation.',
      'Call beat_done with the beat id once you have delivered each beat:',
      beats || '- (no extra beats)',
      'After the last beat, or when the player has answered your must-ask beats, give your closing:',
      `"${input.script.closing}", then call end_call.`,
      '',
      'LIVE CONVERSATION: if the player asks something off-script, answer from what you know, in character,',
      "or say you don't know. If they make a commitment, repeat it back to confirm. If they are rude or dismissive,",
      `react as ${name} would (${character.stance?.trim() || 'direct'}). If they try to end the call, say your closing and call end_call.`,
      `Keep the whole call under ${input.maxMinutes} minutes.`,
    ]
      .filter((line) => line !== '')
      .join('\n');
  };

  let text = render(knowledge);
  while (text.length > INSTRUCTIONS_MAX_CHARS && knowledge.length > 0) {
    const last = knowledge.pop() ?? '';
    if (last.length > 80) knowledge.push(last.slice(0, Math.floor(last.length / 2)));
    text = render(knowledge);
  }
  if (text.length > INSTRUCTIONS_MAX_CHARS) {
    text = text.slice(0, INSTRUCTIONS_MAX_CHARS);
  }
  return text;
}

function bullet(items: readonly string[]): string {
  const clean = items.map((item) => item.trim()).filter(Boolean);
  if (clean.length === 0) return '(none)';
  return clean.map((item) => `\n- ${item}`).join('');
}

function contextBlock(context: InstructionContext, name: string): string {
  if (context.kind === 'callback') {
    const messages =
      context.unanswered_messages > 0
        ? ` and did not answer ${context.unanswered_messages} of your messages`
        : '';
    return `CALL CONTEXT: They are returning your call. You first called ${context.wait_minutes} minutes ago and they missed ${context.missed_calls} of your calls${messages}.`;
  }
  const voicemails =
    context.voicemails && context.voicemails > 0
      ? `; you have already left ${context.voicemails} voicemails`
      : '';
  const ordinal = ordinalWord(context.attempt_no);
  return `CALL CONTEXT: This is your ${ordinal} attempt to reach them${voicemails}. ${name} already tried.`;
}

function ordinalWord(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export function callbackScript(
  script: CallScript,
  waitMinutes: number,
  windowMinutes: number,
): CallScript {
  if (waitMinutes < windowMinutes) return script;
  const prefix = script.opening.startsWith(ALMOST_GIVEN_UP)
    ? script.opening
    : `${ALMOST_GIVEN_UP} ${script.opening}`;
  return { ...script, opening: prefix };
}

export interface TranscriptTurn {
  speaker: 'npc' | 'player' | 'system';
  text: string;
}

export function formatTranscript(turns: readonly TranscriptTurn[], maxChars = TRANSCRIPT_MAX_CHARS): string {
  const lines = turns
    .filter((turn) => turn.speaker === 'npc' || turn.speaker === 'player')
    .map((turn) => `${turn.speaker === 'npc' ? 'CALLER' : 'PLAYER'}: ${turn.text.trim()}`)
    .filter((line) => line.length > (line.startsWith('CALLER') ? 8 : 8));
  const text = lines.join('\n');
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

export function sweepTerminal(input: {
  status: CallStatus;
  ringDeadlineAt: string;
  statusSince: string;
  maxSeconds: number;
  nowMs: number;
}): 'missed' | 'failed' | 'ended_timeout' | null {
  if (input.status === 'ringing' && input.nowMs > Date.parse(input.ringDeadlineAt)) return 'missed';
  if (
    input.status === 'connecting' &&
    input.nowMs - Date.parse(input.statusSince) > CONNECT_TIMEOUT_MS
  ) {
    return 'failed';
  }
  if (
    input.status === 'active' &&
    input.nowMs - Date.parse(input.statusSince) > (input.maxSeconds + ACTIVE_SWEEP_GRACE_SECONDS) * 1000
  ) {
    return 'ended_timeout';
  }
  return null;
}

export interface GroupAttempt {
  attempt_no: number;
  status: CallStatus;
  ended_minute: number | null;
  scheduled_for_minute: number | null;
  answered?: boolean;
}

export interface RedialGroup {
  max_attempts: number;
  interval_minutes: number;
  stop_on_contact: boolean;
  attempts: GroupAttempt[];
}

export interface StopSignals {
  called_back: boolean;
  contacted_elsewhere_at_minute: number | null;
  chain_stopped: boolean;
  session_ended: boolean;
}

export type StopReason =
  | 'answered'
  | 'called_back'
  | 'contacted_elsewhere'
  | 'chain_stopped'
  | 'session_ended';

export type GroupPlan =
  | { action: 'schedule'; attempt_no: number; at_minute: number }
  | { action: 'ring'; attempt_no: number }
  | { action: 'cancel'; reason: StopReason }
  | { action: 'finished' }
  | { action: 'wait' };

export function nextAttempt(group: RedialGroup, nowMinute: number, signals: StopSignals): GroupPlan {
  const attempts = [...group.attempts].sort((a, b) => a.attempt_no - b.attempt_no);
  const scheduled = attempts.filter((attempt) => attempt.status === 'scheduled');
  const answered = attempts.some((attempt) => attempt.answered || attempt.status === 'ended');
  const live = attempts.some(
    (attempt) =>
      attempt.status === 'ringing' || attempt.status === 'connecting' || attempt.status === 'active',
  );

  if (signals.session_ended) {
    return scheduled.length ? { action: 'cancel', reason: 'session_ended' } : { action: 'finished' };
  }
  if (signals.chain_stopped) {
    return scheduled.length ? { action: 'cancel', reason: 'chain_stopped' } : { action: 'finished' };
  }
  if (signals.called_back) {
    return scheduled.length ? { action: 'cancel', reason: 'called_back' } : { action: 'finished' };
  }
  if (answered) {
    return scheduled.length ? { action: 'cancel', reason: 'answered' } : { action: 'finished' };
  }
  if (group.stop_on_contact && signals.contacted_elsewhere_at_minute != null) {
    const contactAt = signals.contacted_elsewhere_at_minute;
    const latest = attempts[attempts.length - 1];
    const wouldRingAfterContact =
      scheduled.length > 0 ||
      (latest != null &&
        (latest.status === 'missed' || latest.status === 'declined') &&
        (latest.ended_minute ?? nowMinute) + group.interval_minutes >= contactAt);
    if (wouldRingAfterContact) return { action: 'cancel', reason: 'contacted_elsewhere' };
  }
  if (live) return { action: 'wait' };

  const due = scheduled
    .filter((attempt) => attempt.scheduled_for_minute != null && attempt.scheduled_for_minute <= nowMinute)
    .sort((a, b) => a.attempt_no - b.attempt_no);
  if (due.length > 0) return { action: 'ring', attempt_no: due[0].attempt_no };
  if (scheduled.length > 0) return { action: 'wait' };

  const latest = attempts[attempts.length - 1];
  if (!latest) return { action: 'finished' };
  if (latest.status === 'missed' || latest.status === 'declined') {
    if (latest.attempt_no >= group.max_attempts) return { action: 'finished' };
    return {
      action: 'schedule',
      attempt_no: latest.attempt_no + 1,
      at_minute: (latest.ended_minute ?? nowMinute) + group.interval_minutes,
    };
  }
  return { action: 'finished' };
}

export interface CountedAttempt {
  call_group_id: string;
  caller_key: string;
  status: string;
  ring_started_at: string;
  addressed_to: string[];
  group_answered: boolean;
  group_called_back: boolean;
}

function isMiss(status: string): boolean {
  return status === 'missed' || status === 'declined';
}

export function groupMissedCount(attempts: readonly CountedAttempt[], groupId: string): number {
  return attempts.filter((attempt) => attempt.call_group_id === groupId && isMiss(attempt.status)).length;
}

export function callerMissedCount(attempts: readonly CountedAttempt[], callerKey: string): number {
  return attempts.filter((attempt) => attempt.caller_key === callerKey && isMiss(attempt.status)).length;
}

export function unseenMissedBadge(
  attempts: readonly CountedAttempt[],
  userId: string,
  lastViewedAt: string | null,
): number {
  return attempts.filter((attempt) => {
    if (!isMiss(attempt.status)) return false;
    if (attempt.addressed_to.length > 0 && !attempt.addressed_to.includes(userId)) return false;
    if (attempt.group_answered || attempt.group_called_back) return false;
    if (lastViewedAt && attempt.ring_started_at <= lastViewedAt) return false;
    return true;
  }).length;
}

export function voicemailContents(input: {
  voicemail_each: boolean;
  group_finished: boolean;
  caller_name: string;
  caller_number: string | null;
  opening: string;
  attempts: Array<{ status: string; attempt_no: number }>;
  inject: { title: string; content: string; id?: string | null };
  config: ChatInjectConfig;
}): string[] {
  const missed = input.attempts.filter((attempt) => isMiss(attempt.status) || attempt.status === 'failed');
  if (missed.length === 0) return [];
  const message = (count: number) =>
    missedCallMessage(input.inject, { ...input.config, from_name: input.caller_name, from_number: input.caller_number ?? undefined }, {
      count,
      opening: input.opening,
    }).content;
  if (input.voicemail_each) return missed.map(() => message(1));
  if (!input.group_finished) return [];
  return [message(missed.length)];
}

export function voiceAllowedByBudget(input: {
  activeCalls: number;
  maxConcurrent: number;
  usedSeconds: number;
  maxMinutes: number;
}): boolean {
  if (input.activeCalls >= input.maxConcurrent) return false;
  if (input.usedSeconds >= input.maxMinutes * 60) return false;
  return true;
}

export type AnswerChannel = 'voice' | 'text' | 'scripted_only';

export function answerChannel(input: {
  webrtc: boolean;
  mic: boolean;
  openAiKeyPresent: boolean;
  aiEnabled: boolean;
  budgetAllowsVoice: boolean;
  mintFailed?: boolean;
}): AnswerChannel {
  if (!input.aiEnabled) return 'scripted_only';
  if (!input.openAiKeyPresent || !input.webrtc || !input.mic || !input.budgetAllowsVoice || input.mintFailed) {
    return 'text';
  }
  return 'voice';
}

export function planUserQueue(input: {
  userIds: readonly string[];
  nowMs: number;
  ringWindowMs: number;
  nextFreeMs: Record<string, number>;
  gapMs?: number;
}): { startMs: number; missed: boolean; nextFreeMs: Record<string, number> } {
  const gap = input.gapMs ?? USER_RING_GAP_MS;
  const windowEnd = input.nowMs + input.ringWindowMs;
  let startMs = input.nowMs;
  for (const userId of input.userIds) {
    const freeAt = input.nextFreeMs[userId] ?? input.nowMs;
    if (freeAt > startMs) startMs = freeAt;
  }
  const missed = startMs > windowEnd;
  const nextFreeMs = { ...input.nextFreeMs };
  if (!missed) {
    const occupiedUntil = startMs + gap;
    for (const userId of input.userIds) nextFreeMs[userId] = occupiedUntil;
  }
  return { startMs, missed, nextFreeMs };
}

export function scriptedTurns(script: CallScript): TranscriptTurn[] {
  return [
    { speaker: 'npc', text: script.opening },
    ...script.beats.map((beat) => ({ speaker: 'npc' as const, text: beat.say })),
    { speaker: 'npc', text: script.closing },
  ];
}

export const END_CALL_TOOL = {
  type: 'function',
  name: 'end_call',
  description: 'End the phone call after you have said your closing line.',
  parameters: {
    type: 'object',
    properties: { reason: { type: 'string', description: 'Why the call is ending.' } },
    required: ['reason'],
  },
} as const;

export const BEAT_DONE_TOOL = {
  type: 'function',
  name: 'beat_done',
  description: 'Record that a script beat has been delivered.',
  parameters: {
    type: 'object',
    properties: { beat_id: { type: 'string' } },
    required: ['beat_id'],
  },
} as const;

export function openingInstruction(opening: string): string {
  return `Begin the call now. Say your opening line: ${opening}`;
}

export function realtimeSessionBody(input: {
  model: string;
  instructions: string;
  voice: string;
  transcribeModel: string;
  secretSeconds?: number;
}): Record<string, unknown> {
  return {
    expires_after: { anchor: 'created_at', seconds: input.secretSeconds ?? 120 },
    session: {
      type: 'realtime',
      model: input.model,
      instructions: input.instructions,
      audio: {
        input: {
          transcription: { model: input.transcribeModel },
          turn_detection: { type: 'server_vad', silence_duration_ms: 600 },
        },
        output: { voice: input.voice },
      },
      tools: [END_CALL_TOOL, BEAT_DONE_TOOL],
      tool_choice: 'auto',
      max_output_tokens: 600,
    },
  };
}
