/**
 * Pure consequence-director decisions. No database access.
 * Tie-breaks use mulberry32(seed XOR wake sequence).
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  PRESSURE_WINDOW_MINUTES,
  referencedInjectKeys,
  type TeamDelivery,
} from '../conditions/crossTeamCore.js';
import {
  collectSignals,
  sameTeamName,
  type DirectorSignalState,
  type PreviousWake,
  type Signal,
  type SignalKind,
} from './directorSignals.js';

export const PROMPT_VERSION = 'director-propose-1';
export const OBSERVATION_CHAR_CAP = 6000;
const END_BUFFER_MINUTES = 5;
const SHORT_CONTENT_APPS = new Set(['group_chat', 'npc_dm', 'messenger_dm', 'social_feed']);
const PUBLIC_APPS = new Set(['social_feed', 'news']);
const STAKEHOLDER_APPS = new Set(['npc_dm', 'phone_call']);
const SOFT_GUARD_IDS = new Set(['entity', 'number', 'duplicate', 'conflict', 'unverified']);
const QUALIFYING = new Set<SignalKind>(['relief', 'duty_done', 'dependency_met']);
const SEVERITY_WEIGHT = { low: 1, medium: 2, high: 3 } as const;
const SEVERITY_RANK = { low: 1, medium: 2, high: 3 } as const;
const META_WORD = /\b(simulation|exercise|trainer|training|inject|scenario|ai|score)\b/i;

export const DIRECTOR_SYSTEM_PROMPT = `You are the live director of a crisis-response TRAINING exercise. Teams are playing; you decide whether ONE
new in-world event should happen now because of what the teams did or did not do. Most wakes need no event.
Rules:
- Stay in the world. Never mention a simulation, exercise, trainer, AI, score or inject.
- Use only the facts, people, organisations and places listed. Never invent a person, number, date or fact.
- Do not contradict, repeat or pre-empt an upcoming authored inject.
- Effects follow causes: say which signals and which teams caused the event. The event lands on the team that
  would realistically feel it, often a DIFFERENT team from the one that caused it.
- You may name another team (for example "your operations team") only in email, chat, DM or phone events
  to the organisation's own teams. Social posts and news never name internal teams.
- Prefer variety of channel and sender. Severity is low, medium or high (never critical).
- Good work deserves consequences too: a "relief" event (thanks, cooperation, an easier path) is allowed.
- Do not target a team listed as busy, protected or over its quota.
- Prefer a team below its share when the causes are comparable.
Return ONLY JSON:
{ "act": boolean, "reason": string,
  "proposal": null | { "kind": "consequence|escalation|opportunity|relief",
    "cause": { "signal_ids": ["..."], "source_teams": ["..."] },
    "target_teams": ["..."], "target_role_id": null,
    "app": "email|group_chat|phone_call|npc_dm|messenger_dm|social_feed|news",
    "sender": { "stakeholder_id": "..." } | { "npc_handle": "..." },
    "title": "...", "content": "...", "severity": "low|medium|high",
    "requires_response": boolean,
    "response_rubric": null | { "asks": [], "criteria": [], "expected_tone": [], "pass_threshold": 2 },
    "follow_up": null | { "if_unanswered_minutes": 5, "content": "..." } } }`;

const APPS = [
  'email',
  'group_chat',
  'phone_call',
  'npc_dm',
  'messenger_dm',
  'social_feed',
  'news',
] as const;
const KINDS = ['consequence', 'escalation', 'opportunity', 'relief'] as const;
const SEVERITIES = ['low', 'medium', 'high'] as const;

const proposalSchema = z
  .object({
    kind: z.enum(KINDS),
    cause: z
      .object({
        signal_ids: z.array(z.string().min(1)).min(1),
        source_teams: z.array(z.string()),
      })
      .strict(),
    target_teams: z.array(z.string().min(1)).min(1),
    target_role_id: z.string().min(1).nullable(),
    app: z.enum(APPS),
    sender: z.union([
      z.object({ stakeholder_id: z.string().min(1) }).strict(),
      z.object({ npc_handle: z.string().min(1) }).strict(),
    ]),
    title: z.string().min(1).max(120),
    content: z.string().min(1),
    severity: z.enum(SEVERITIES),
    requires_response: z.boolean(),
    response_rubric: z
      .object({
        asks: z.array(z.string()).max(8),
        criteria: z.array(z.string()).max(8),
        expected_tone: z.array(z.string()).max(8),
        pass_threshold: z.number().int().min(1).max(8),
      })
      .strict()
      .nullable(),
    follow_up: z
      .object({
        if_unanswered_minutes: z.number().positive(),
        content: z.string().min(1),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type ParsedProposal = z.infer<typeof proposalSchema>;
export type DirectorMode = 'off' | 'suggest' | 'auto';
export type ProposalStatus =
  | 'proposed'
  | 'approved'
  | 'edited'
  | 'vetoed'
  | 'expired'
  | 'auto_published'
  | 'rejected_guardrail'
  | 'no_action'
  | 'failed'
  | 'budget_denied';

export interface WakeClock {
  minute: number;
  duration: number;
  paused: boolean;
  mode: DirectorMode;
  lastWakeMinute: number | null;
  startMinute: number;
  tickMinutes: number;
  minGapMinutes: number;
}

export interface WakeDecision {
  wake: boolean;
  log: boolean;
  /** Why this tick did or did not call. */
  reason:
    | 'signals'
    | 'periodic'
    | 'off'
    | 'paused'
    | 'before_start'
    | 'ending'
    | 'gap'
    | 'no_lull'
    | 'quiet';
  wakeReason: 'signals' | 'periodic' | null;
}

export interface DirectorTeam {
  name: string;
  slug?: string;
  org?: string;
  functionName?: string;
  members?: string[];
  size?: number;
  staffed?: boolean;
  playable?: boolean;
  active?: boolean;
}

export interface ExposureEvent {
  minute: number;
  team: string;
  kind: 'consequence' | 'escalation' | 'opportunity' | 'relief';
  severity: 'low' | 'medium' | 'high';
}

export interface FairnessTeam {
  team: string;
  size: number;
  staffed: boolean;
  negative_load: number;
  positive_load: number;
  fair_share: number;
  size_scale: number;
  relief_owed: boolean;
  over_cap: boolean;
}

export interface FairnessState {
  teams: FairnessTeam[];
  tolerance: number;
  last_third: boolean;
  mean_negative: number;
  minute: number;
  duration: number;
}

export interface UpcomingInject {
  key: string;
  title: string;
  content: string;
  minute: number;
  target_teams: string[];
}

export interface ObservationInput {
  title: string;
  crisisType: string;
  minute: number;
  duration: number;
  brief: string;
  facts: string[];
  falseClaims: string[];
  teams: DirectorTeam[];
  dependencies: Array<{
    id: string;
    upstream: string;
    downstream: string[];
    deliverable: string;
    status: string;
    since?: number | null;
  }>;
  recentByTeam: Array<{
    team: string;
    deliveries: number;
    unanswered: number;
    replies: string;
    dutiesMissed: number;
    silence: boolean;
    decisions: number;
  }>;
  moods: Array<{ stakeholder: string; scope: string; rung: string }>;
  upcoming: UpcomingInject[];
  recentUnscripted: Array<{ minute: number; target: string; title: string }>;
  exposure: Array<{ team: string; director: number; crossTeam: number }>;
  signals: Signal[];
  cast: Array<{ id: string; name: string }>;
  npcs: Array<{ handle: string }>;
  protectedTeams: string[];
  busyTeams: string[];
}

export interface DirectorObservation {
  text: string;
  sha256: string;
  brief: string;
  title: string;
  minute: number;
  duration: number;
  upcoming: string[];
  fairness_line: string;
}

export interface GuardText {
  team: string;
  minute: number;
  title: string;
  content: string;
}

export interface GuardContext {
  minute: number;
  duration: number;
  mode: 'suggest' | 'auto';
  intensity: 'low' | 'medium' | 'high';
  per15: number;
  perTeam30: number;
  maxSeverity: 'low' | 'medium' | 'high';
  pressureMax: number;
  teams: DirectorTeam[];
  protectedTeams: string[];
  allowedApps: string[];
  roleIds: string[];
  stakeholders: Array<{ id: string; name: string }>;
  npcs: Array<{ handle: string; name?: string }>;
  orgs: string[];
  brief: string;
  facts: string[];
  recentTexts: GuardText[];
  upcoming: UpcomingInject[];
  capEvents: ExposureEvent[];
  deliveries: TeamDelivery[];
  unansweredByTeam: Record<string, number>;
  /** Absent means presence was not supplied, so the online clause is not applied. */
  onlineByTeam?: Record<string, number>;
  priorLowMediumTeams: string[];
  authoredKeysByTeam: Record<string, string[]>;
  signals: Signal[];
  fairness: FairnessState;
  /** G10 in suggest mode. Auto always runs the check. */
  consistencyEnabled: boolean;
  consistency?: ConsistencyRecord | null;
}

export interface ConsistencyRecord {
  status: 'consistent' | 'conflict' | 'unverified' | 'skipped';
  reason?: string;
  prompt?: string;
  answer?: unknown;
}

export interface GuardrailResult {
  id: string;
  ok: boolean;
  detail: string;
  inputs?: unknown;
  warning?: boolean;
}

export interface GuardrailReport {
  ok: boolean;
  rejected: boolean;
  failure: GuardrailResult | null;
  results: GuardrailResult[];
  warnings: GuardrailResult[];
}

export interface DirectorLimits {
  temperature: number;
  per15: number;
  perTeam30: number;
  maxSeverity: 'low' | 'medium' | 'high';
  tolerance: number;
  consistencyEnabled: boolean;
  pressureMax: number;
  intensity: 'low' | 'medium' | 'high';
  budget: number;
}

export interface QuietLog {
  minute: number;
  reason: string;
}

export interface DirectorTurnInput {
  clock: WakeClock;
  signalState: DirectorSignalState;
  previousWake: PreviousWake | null;
  teams: DirectorTeam[];
  loadEvents: ExposureEvent[];
  deliveries: TeamDelivery[];
  pendingByTeam: Record<string, number>;
  observation: ObservationInput;
  guard: Omit<
    GuardContext,
    'fairness' | 'signals' | 'consistency' | 'consistencyEnabled' | 'minute' | 'duration' | 'mode'
  >;
  limits: DirectorLimits;
  seed: bigint;
  wakeSeq: number;
  budgetKey: string;
  lastQuiet: QuietLog | null;
}

export interface DirectorDraft {
  log: boolean;
  status: ProposalStatus | null;
  wake_reason: 'signals' | 'periodic' | 'trainer_request' | null;
  reason: string | null;
  minute: number;
  signals: Signal[];
  observation: DirectorObservation | null;
  promptText: string | null;
  promptVersion: string | null;
  focus_id: string | null;
  fairness: FairnessState | null;
  proposal: ParsedProposal | null;
  guardrails: GuardrailResult[];
  consistency: ConsistencyRecord | null;
  raw_output: unknown;
  mode: 'suggest' | 'auto' | null;
  inject_id: null;
  seed: bigint;
  temperature: number | null;
  provider_seed_applied: boolean | null;
  tokens_in: number | null;
  tokens_out: number | null;
  model: string | null;
}

export interface PreparedWake {
  call: boolean;
  draft: DirectorDraft;
  prompt: { system: string; user: string } | null;
  guard: GuardContext | null;
}

export interface DirectorModelReply {
  budgetDenied?: boolean;
  failed?: boolean;
  parsed?: unknown;
  model?: string | null;
  providerSeedApplied?: boolean;
  tokensIn?: number | null;
  tokensOut?: number | null;
}

export interface DirectorClient {
  propose(request: {
    system: string;
    user: string;
    seed: number;
    temperature: number;
    budgetKey: string;
    budgetLimit: number;
  }): Promise<DirectorModelReply>;
  consistency(request: {
    system: string;
    user: string;
    budgetKey: string;
    budgetLimit: number;
  }): Promise<DirectorModelReply>;
}

export type ModelOutcome =
  | { kind: 'none' }
  | {
      kind: 'budget_denied' | 'failed' | 'output';
      raw?: unknown;
      model?: string | null;
      providerSeedApplied?: boolean;
      tokensIn?: number | null;
      tokensOut?: number | null;
    };

export function directorSeed(sessionId: string, scenarioId: string, salt: string): bigint {
  const digest = createHash('sha256').update(`${sessionId}|${scenarioId}|${salt}`, 'utf8').digest();
  return BigInt.asIntN(64, digest.readBigUInt64BE(0));
}

/** 32-bit value OpenAI accepts as a JSON integer. Bedrock does not receive it. */
export function modelSeed(seed: bigint): number {
  return Number(BigInt.asUintN(32, seed));
}

export function prng(seed: bigint, wakeSeq: number): () => number {
  const mixed = seed ^ BigInt(wakeSeq);
  return mulberry32(Number(BigInt.asUintN(32, mixed)));
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function capsFor(
  intensity: 'low' | 'medium' | 'high',
  base: { per15: number; perTeam30: number },
): { per15: number; perTeam30: number } {
  const factor = intensity === 'low' ? 0.5 : intensity === 'high' ? 1.5 : 1;
  return {
    per15: Math.max(1, Math.round(base.per15 * factor)),
    perTeam30: Math.max(1, Math.round(base.perTeam30 * factor)),
  };
}

export function shouldWake(
  clock: WakeClock,
  signals: readonly Signal[],
  situation: { lull: boolean; fairnessImbalance: boolean },
): WakeDecision {
  if (clock.mode === 'off') return { wake: false, log: false, reason: 'off', wakeReason: null };
  if (clock.paused) return { wake: false, log: false, reason: 'paused', wakeReason: null };
  if (clock.minute < clock.startMinute) {
    return { wake: false, log: false, reason: 'before_start', wakeReason: null };
  }
  if (clock.duration > 0 && clock.minute >= clock.duration - END_BUFFER_MINUTES) {
    return { wake: false, log: false, reason: 'ending', wakeReason: null };
  }
  const since = clock.lastWakeMinute == null ? null : clock.minute - clock.lastWakeMinute;
  const gapOk = since == null || since >= clock.minGapMinutes;
  const tickOk = since == null || since >= clock.tickMinutes;
  const notable = signals.some((signal) => signal.notable);
  if (notable && gapOk) return { wake: true, log: true, reason: 'signals', wakeReason: 'signals' };
  if (tickOk && (situation.lull || situation.fairnessImbalance)) {
    return { wake: true, log: true, reason: 'periodic', wakeReason: 'periodic' };
  }
  if (tickOk) return { wake: false, log: true, reason: 'no_lull', wakeReason: 'periodic' };
  if (notable) return { wake: false, log: false, reason: 'gap', wakeReason: null };
  return { wake: false, log: false, reason: 'quiet', wakeReason: null };
}

export function fairnessState(
  teams: readonly DirectorTeam[],
  history: readonly ExposureEvent[],
  options: { tolerance: number; minute: number; duration: number },
): FairnessState {
  const staffed = teams
    .filter((team) => team.staffed !== false && team.playable !== false && team.active !== false)
    .map((team) => team.name)
    .sort((a, b) => a.localeCompare(b));
  const unique = [...new Set(staffed)];
  const lastThird = options.duration > 0 && options.minute >= options.duration * (2 / 3);
  const loads = unique.map((team) => {
    const events = history.filter((event) => sameTeamName(event.team, team));
    const negative = events
      .filter((event) => event.kind === 'consequence' || event.kind === 'escalation')
      .reduce((sum, event) => sum + (SEVERITY_WEIGHT[event.severity] ?? 0), 0);
    const positive = events
      .filter((event) => event.kind === 'relief' || event.kind === 'opportunity')
      .reduce((sum, event) => sum + (SEVERITY_WEIGHT[event.severity] ?? 0), 0);
    const size = teamSize(teams, team);
    return { team, negative, positive, size };
  });
  const meanNegative =
    loads.length === 0 ? 0 : loads.reduce((sum, row) => sum + row.negative, 0) / loads.length;
  const meanSize =
    loads.length === 0 ? 1 : loads.reduce((sum, row) => sum + row.size, 0) / loads.length;
  const rows: FairnessTeam[] = loads.map((row) => {
    const sizeScale = clamp(row.size / (meanSize || 1), 0.75, 1.25);
    const fairShare = meanNegative * sizeScale;
    const over = !lastThird && row.negative > fairShare + options.tolerance;
    return {
      team: row.team,
      size: row.size,
      staffed: true,
      negative_load: row.negative,
      positive_load: row.positive,
      fair_share: fairShare,
      size_scale: sizeScale,
      relief_owed: Math.floor(row.negative / 3) > row.positive,
      over_cap: over,
    };
  });
  return {
    teams: rows,
    tolerance: options.tolerance,
    last_third: lastThird,
    mean_negative: meanNegative,
    minute: options.minute,
    duration: options.duration,
  };
}

export function formatFairnessLine(fairness: FairnessState): string {
  const below = fairness.teams
    .filter((team) => team.negative_load < team.fair_share)
    .map((team) => team.team);
  const capped = fairness.teams.filter((team) => team.over_cap).map((team) => team.team);
  return `teams below their share: ${below.join(', ') || 'none'}; teams at their cap: ${capped.join(', ') || 'none'}`;
}

export function chooseFocus(
  signals: readonly Signal[],
  fairness: FairnessState,
  seed: bigint,
  wakeSeq: number,
  minute: number,
): string | null {
  const pool = signals.filter((signal) => signal.team.trim() !== '');
  if (pool.length === 0) return null;
  const scored = pool.map((signal) => ({ signal, score: focusScore(signal, fairness, minute) }));
  const best = Math.max(...scored.map((row) => row.score));
  const top = scored
    .filter((row) => row.score === best)
    .map((row) => row.signal)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const only = top[0];
  if (!only) return null;
  if (top.length === 1) return only.id;
  const index = Math.min(top.length - 1, Math.floor(prng(seed, wakeSeq)() * top.length));
  return top[index]?.id ?? only.id;
}

export function teamInLull(input: {
  teams: readonly DirectorTeam[];
  deliveries: readonly TeamDelivery[];
  pendingByTeam: Readonly<Record<string, number>>;
  minute: number;
  windowMinutes?: number;
}): boolean {
  const window = input.windowMinutes ?? 10;
  return input.teams.some((team) => {
    if (team.staffed === false || team.playable === false) return false;
    const recent = input.deliveries.some(
      (delivery) =>
        sameTeamName(delivery.team, team.name) &&
        input.minute - delivery.minute >= 0 &&
        input.minute - delivery.minute < window,
    );
    const pending = pendingOf(input.pendingByTeam, team.name);
    return !recent && pending === 0;
  });
}

export function fairnessImbalance(fairness: FairnessState, signals: readonly Signal[]): boolean {
  return fairness.teams.some((team) => {
    const wellBelow = team.negative_load + fairness.tolerance < team.fair_share;
    const hasSignal = signals.some((signal) => sameTeamName(signal.team, team.team));
    return wellBelow && hasSignal;
  });
}

export function nonTimedPressure(
  team: string,
  minute: number,
  deliveries: readonly TeamDelivery[],
): number {
  let count = 0;
  for (const delivery of deliveries) {
    if (delivery.timed) continue;
    const age = minute - delivery.minute;
    if (age < 0 || age > PRESSURE_WINDOW_MINUTES) continue;
    if (sameTeamName(delivery.team, team)) count += 1;
  }
  return count;
}

export function buildObservation(
  input: ObservationInput,
  fairnessLine: string,
): DirectorObservation {
  const limits = {
    brief: 600,
    facts: 8,
    claims: 5,
    deps: 40,
    moods: 30,
    recent: 5,
    teamDetail: true,
  };
  let text = renderObservation(input, fairnessLine, limits);
  const relax: Array<() => void> = [
    () => {
      limits.recent = 2;
    },
    () => {
      limits.moods = 6;
    },
    () => {
      limits.deps = 8;
    },
    () => {
      limits.facts = 4;
    },
    () => {
      limits.claims = 2;
    },
    () => {
      limits.brief = 200;
    },
    () => {
      limits.teamDetail = false;
    },
  ];
  for (const step of relax) {
    if (text.length <= OBSERVATION_CHAR_CAP) break;
    step();
    text = renderObservation(input, fairnessLine, limits);
  }
  if (text.length > OBSERVATION_CHAR_CAP) {
    const marker = 'UPCOMING AUTHORED INJECTS';
    const at = text.indexOf(marker);
    const tail = at >= 0 ? text.slice(at) : '';
    const headBudget = Math.max(0, OBSERVATION_CHAR_CAP - tail.length - 1);
    text = `${text.slice(0, headBudget)}\n${tail}`.slice(0, OBSERVATION_CHAR_CAP);
  }
  const brief = input.brief.slice(0, limits.brief);
  return {
    text,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    brief,
    title: input.title,
    minute: input.minute,
    duration: input.duration,
    upcoming: [...input.upcoming].sort(upcomingOrder).map((inject) => inject.key),
    fairness_line: fairnessLine,
  };
}

export function buildDirectorPrompt(observation: DirectorObservation): {
  system: string;
  user: string;
} {
  return { system: DIRECTOR_SYSTEM_PROMPT, user: observation.text };
}

export function checkProposal(
  raw: unknown,
  ctx: GuardContext,
  options?: { stopBefore?: 'fairness' },
): GuardrailReport {
  const results: GuardrailResult[] = [];
  let rejected = false;
  const stop = () => rejected;

  const push = (result: GuardrailResult) => {
    if (stop()) return;
    if (!result.ok && !isHard(result.id, ctx.mode)) {
      results.push({ ...result, warning: true });
      return;
    }
    results.push(result);
    if (!result.ok) rejected = true;
  };

  const parsed = proposalSchema.safeParse(raw);
  if (!parsed.success) {
    push({
      id: 'invalid',
      ok: false,
      detail: parsed.error.issues[0]?.message ?? 'Invalid proposal',
      inputs: { issues: parsed.error.issues.slice(0, 4) },
    });
    return report(results);
  }
  const proposal = parsed.data;
  const contentLimit = SHORT_CONTENT_APPS.has(proposal.app) ? 280 : 1200;
  if (proposal.content.length > contentLimit) {
    push({
      id: 'invalid',
      ok: false,
      detail: `Content is longer than ${contentLimit} characters`,
      inputs: { length: proposal.content.length, contentLimit },
    });
    return report(results);
  }
  push({ id: 'invalid', ok: true, detail: 'Schema accepted' });

  const scaled = capsFor(ctx.intensity, { per15: ctx.per15, perTeam30: ctx.perTeam30 });
  const sessionCount = ctx.capEvents.filter((event) =>
    inWindow(ctx.minute, event.minute, 15),
  ).length;
  const teamCount = (team: string) =>
    ctx.capEvents.filter(
      (event) => sameTeamName(event.team, team) && inWindow(ctx.minute, event.minute, 30),
    ).length;
  const overTeam = proposal.target_teams.find((team) => teamCount(team) >= scaled.perTeam30);
  const severityOver = SEVERITY_RANK[proposal.severity] > SEVERITY_RANK[ctx.maxSeverity];
  if (sessionCount >= scaled.per15 || overTeam || severityOver) {
    push({
      id: 'cap',
      ok: false,
      detail: severityOver
        ? `Severity ${proposal.severity} is above ${ctx.maxSeverity}`
        : 'Director cap reached',
      inputs: {
        sessionCount,
        per15: scaled.per15,
        overTeam: overTeam ?? null,
        perTeam30: scaled.perTeam30,
      },
    });
  } else {
    push({
      id: 'cap',
      ok: true,
      detail: 'Within caps',
      inputs: { sessionCount, per15: scaled.per15 },
    });
  }

  const targetProblem = targetFailure(proposal, ctx);
  push(
    targetProblem ?? { id: 'target', ok: true, detail: 'Targets are active, playable and staffed' },
  );

  const pile = pileFailure(proposal, ctx);
  push(pile ?? { id: 'pile_on', ok: true, detail: 'Target is under the pressure ceiling' });

  const sender = senderFailure(proposal, ctx);
  push(sender ?? { id: 'sender', ok: true, detail: 'Sender and channel are allowed' });

  const naming = namingFailure(proposal, ctx);
  push(naming ?? { id: 'meta', ok: true, detail: 'Wording stays in the world' });

  const entity = entityFailure(proposal, ctx);
  push(entity ?? { id: 'entity', ok: true, detail: 'Names match the cast and the brief' });

  const number = numberFailure(proposal, ctx);
  push(number ?? { id: 'number', ok: true, detail: 'Numbers are already in the record' });

  const duplicate = duplicateFailure(proposal, ctx);
  push(
    duplicate ?? {
      id: 'duplicate',
      ok: true,
      detail: 'Not a repeat of a recent or upcoming event',
    },
  );

  if (options?.stopBefore === 'fairness') return report(results);

  if (ctx.consistency && ctx.consistency.status !== 'skipped') {
    if (ctx.consistency.status === 'consistent') {
      push({
        id: 'consistent',
        ok: true,
        detail: ctx.consistency.reason ?? 'Consistent with the facts',
      });
    } else if (ctx.consistency.status === 'conflict') {
      push({
        id: 'conflict',
        ok: false,
        detail: ctx.consistency.reason ?? 'Contradicts the record',
        inputs: { answer: ctx.consistency.answer ?? null },
      });
    } else {
      push({
        id: 'unverified',
        ok: false,
        detail: ctx.consistency.reason ?? 'Consistency check did not complete',
      });
    }
  }

  const fairnessFail = fairnessFailure(proposal, ctx);
  push(fairnessFail ?? { id: 'fairness', ok: true, detail: 'Target is within its fair share' });

  const step = severityStepFailure(proposal, ctx);
  push(step ?? { id: 'severity_step', ok: true, detail: 'Severity follows an earlier event' });

  return report(results);
}

export function prepareDirectorWake(input: DirectorTurnInput): PreparedWake {
  const signals = collectSignals(input.signalState, input.previousWake);
  const fairness = fairnessState(input.teams, input.loadEvents, {
    tolerance: input.limits.tolerance,
    minute: input.clock.minute,
    duration: input.clock.duration,
  });
  const lull = teamInLull({
    teams: input.teams,
    deliveries: input.deliveries,
    pendingByTeam: input.pendingByTeam,
    minute: input.clock.minute,
  });
  const decision = shouldWake(input.clock, signals, {
    lull,
    fairnessImbalance: fairnessImbalance(fairness, signals),
  });
  const mode = input.clock.mode === 'off' ? null : input.clock.mode;
  const base = blankDraft(input, signals, mode);
  if (!decision.wake && !decision.log)
    return { call: false, draft: base, prompt: null, guard: null };
  if (!decision.wake && decision.log && repeatedQuiet(input, decision.reason)) {
    return { call: false, draft: base, prompt: null, guard: null };
  }

  const fairnessLine = formatFairnessLine(fairness);
  const observation = buildObservation(
    { ...input.observation, minute: input.clock.minute, duration: input.clock.duration, signals },
    fairnessLine,
  );
  const focus = chooseFocus(signals, fairness, input.seed, input.wakeSeq, input.clock.minute);
  const prompt = buildDirectorPrompt(observation);
  const guard = assembleGuard(input, signals, fairness);
  const draft: DirectorDraft = {
    ...base,
    log: true,
    status: decision.wake ? null : 'no_action',
    wake_reason: decision.wakeReason,
    reason: decision.wake ? null : decision.reason,
    observation,
    promptText: `${prompt.system}\n\n${prompt.user}`,
    promptVersion: PROMPT_VERSION,
    focus_id: focus,
    fairness,
    temperature: input.limits.temperature,
  };
  if (!decision.wake) {
    draft.raw_output = { reason: decision.reason };
    return { call: false, draft, prompt: null, guard };
  }
  return { call: true, draft, prompt, guard };
}

export function finalizeDirectorWake(
  prepared: PreparedWake,
  model: ModelOutcome,
  consistency: ConsistencyRecord | null,
): DirectorDraft {
  const draft = { ...prepared.draft };
  if (!prepared.call || !prepared.guard || !prepared.prompt) return draft;
  draft.model = model.kind === 'none' ? null : (model.model ?? null);
  draft.provider_seed_applied = model.kind === 'none' ? null : (model.providerSeedApplied ?? null);
  draft.tokens_in = model.kind === 'none' ? null : (model.tokensIn ?? null);
  draft.tokens_out = model.kind === 'none' ? null : (model.tokensOut ?? null);
  if (model.kind === 'budget_denied') {
    draft.status = 'budget_denied';
    draft.reason = 'budget_denied';
    draft.raw_output = { reason: 'budget_denied' };
    return draft;
  }
  if (model.kind === 'failed' || model.kind === 'none') {
    draft.status = 'failed';
    draft.reason = 'model_failed';
    draft.raw_output = model.kind === 'failed' ? (model.raw ?? null) : null;
    return draft;
  }
  draft.raw_output = model.raw ?? null;
  const outer = z
    .object({ act: z.boolean(), reason: z.string(), proposal: z.unknown().nullable() })
    .safeParse(model.raw);
  if (!outer.success) {
    draft.status = 'failed';
    draft.reason = 'unparseable';
    return draft;
  }
  if (!outer.data.act) {
    draft.status = 'no_action';
    draft.reason = outer.data.reason;
    draft.proposal = null;
    draft.inject_id = null;
    return draft;
  }
  const parsed = proposalSchema.safeParse(outer.data.proposal);
  if (!parsed.success) {
    const failure: GuardrailResult = {
      id: 'invalid',
      ok: false,
      detail: parsed.error.issues[0]?.message ?? 'Invalid proposal',
    };
    draft.guardrails = [failure];
    draft.status = 'rejected_guardrail';
    draft.reason = failure.detail;
    draft.proposal = null;
    return draft;
  }
  const required = consistencyRequired(prepared.guard, parsed.data);
  const applied = required
    ? (consistency ?? { status: 'unverified' as const, reason: 'missing' })
    : null;
  const report = checkProposal(parsed.data, {
    ...prepared.guard,
    signals: prepared.draft.signals,
    consistency: applied,
  });
  draft.proposal = parsed.data;
  draft.guardrails = report.results;
  draft.consistency = applied;
  draft.inject_id = null;
  if (report.rejected) {
    draft.status = 'rejected_guardrail';
    draft.reason = report.failure?.detail ?? report.failure?.id ?? 'rejected';
  } else {
    draft.status = 'proposed';
    draft.reason = outer.data.reason;
  }
  return draft;
}

export function consistencyRequired(guard: GuardContext, proposal: unknown): boolean {
  if (guard.mode === 'suggest' && !guard.consistencyEnabled) return false;
  if (!proposalSchema.safeParse(proposal).success) return false;
  const pre = checkProposal(proposal, { ...guard, consistency: null }, { stopBefore: 'fairness' });
  return !pre.rejected;
}

export async function runDirectorTurn(
  input: DirectorTurnInput,
  client: DirectorClient,
): Promise<DirectorDraft> {
  const prepared = prepareDirectorWake(input);
  if (!prepared.call || !prepared.prompt || !prepared.guard) return prepared.draft;
  const reply = await client.propose({
    system: prepared.prompt.system,
    user: prepared.prompt.user,
    seed: modelSeed(input.seed),
    temperature: input.limits.temperature,
    budgetKey: input.budgetKey,
    budgetLimit: input.limits.budget,
  });
  const model = toModel(reply);
  if (model.kind !== 'output') return finalizeDirectorWake(prepared, model, null);
  const outer = z
    .object({ act: z.boolean(), reason: z.string(), proposal: z.unknown().nullable() })
    .safeParse(model.raw);
  const proposal =
    outer.success && outer.data.act ? proposalSchema.safeParse(outer.data.proposal) : null;
  let consistency: ConsistencyRecord | null = null;
  if (proposal?.success && consistencyRequired(prepared.guard, proposal.data)) {
    const prompt = consistencyPrompt(proposal.data, prepared.guard);
    const checked = await client.consistency({
      system: prompt.system,
      user: prompt.user,
      budgetKey: input.budgetKey,
      budgetLimit: input.limits.budget,
    });
    consistency = interpretConsistency(checked, `${prompt.system}\n\n${prompt.user}`);
  }
  return finalizeDirectorWake(prepared, model, consistency);
}

export function consistencyPrompt(
  proposal: ParsedProposal,
  guard: GuardContext,
): { system: string; user: string } {
  const facts = guard.facts.slice(0, 8).join('\n');
  const upcoming = guard.upcoming.map((inject) => `${inject.key}: ${inject.title}`).join('\n');
  return {
    system:
      'You check one proposed in-world message against confirmed facts and upcoming authored events. ' +
      'Say whether the message contradicts them. Return ONLY JSON: {"verdict":"consistent"|"conflict","reason":"..."}',
    user: `CONFIRMED FACTS:\n${facts || '(none)'}\nUPCOMING:\n${upcoming || '(none)'}\nMESSAGE:\n${proposal.title}\n${proposal.content}`,
  };
}

function interpretConsistency(reply: DirectorModelReply, prompt: string): ConsistencyRecord {
  if (reply.budgetDenied)
    return { status: 'unverified', reason: 'budget_denied', prompt, answer: null };
  if (reply.failed || reply.parsed == null)
    return { status: 'unverified', reason: 'call_failed', prompt, answer: reply.parsed ?? null };
  const parsed = z
    .object({ verdict: z.string(), reason: z.string().optional() })
    .safeParse(reply.parsed);
  if (!parsed.success)
    return { status: 'unverified', reason: 'unreadable', prompt, answer: reply.parsed };
  if (parsed.data.verdict === 'consistent') {
    return { status: 'consistent', reason: parsed.data.reason, prompt, answer: reply.parsed };
  }
  if (parsed.data.verdict === 'conflict') {
    return { status: 'conflict', reason: parsed.data.reason, prompt, answer: reply.parsed };
  }
  return { status: 'unverified', reason: 'unreadable', prompt, answer: reply.parsed };
}

function toModel(reply: DirectorModelReply): ModelOutcome {
  const meta = {
    model: reply.model,
    providerSeedApplied: reply.providerSeedApplied,
    tokensIn: reply.tokensIn,
    tokensOut: reply.tokensOut,
  };
  if (reply.budgetDenied) return { kind: 'budget_denied', ...meta };
  if (reply.failed || reply.parsed == null)
    return { kind: 'failed', raw: reply.parsed ?? null, ...meta };
  return { kind: 'output', raw: reply.parsed, ...meta };
}

function assembleGuard(
  input: DirectorTurnInput,
  signals: Signal[],
  fairness: FairnessState,
): GuardContext {
  const mode = input.clock.mode === 'suggest' ? 'suggest' : 'auto';
  return {
    ...input.guard,
    minute: input.clock.minute,
    duration: input.clock.duration,
    mode,
    signals,
    fairness,
    consistency: null,
    consistencyEnabled: input.limits.consistencyEnabled,
  };
}

function blankDraft(
  input: DirectorTurnInput,
  signals: Signal[],
  mode: 'suggest' | 'auto' | null,
): DirectorDraft {
  return {
    log: false,
    status: null,
    wake_reason: null,
    reason: null,
    minute: input.clock.minute,
    signals,
    observation: null,
    promptText: null,
    promptVersion: null,
    focus_id: null,
    fairness: null,
    proposal: null,
    guardrails: [],
    consistency: null,
    raw_output: null,
    mode,
    inject_id: null,
    seed: input.seed,
    temperature: null,
    provider_seed_applied: null,
    tokens_in: null,
    tokens_out: null,
    model: null,
  };
}

function repeatedQuiet(input: DirectorTurnInput, reason: string): boolean {
  const last = input.lastQuiet;
  if (!last || last.reason !== reason) return false;
  return input.clock.minute - last.minute < input.clock.tickMinutes;
}

function focusScore(signal: Signal, fairness: FairnessState, minute: number): number {
  const team = fairness.teams.find((row) => sameTeamName(row.team, signal.team));
  let score = Math.max(0, 20 - Math.max(0, minute - signal.minute));
  if (team?.relief_owed && QUALIFYING.has(signal.kind)) score += 1000;
  if (team && team.negative_load < team.fair_share) score += 10;
  return score;
}

function teamSize(teams: readonly DirectorTeam[], name: string): number {
  const team = teams.find((row) => sameTeamName(row.name, name));
  if (team?.size != null && team.size > 0) return team.size;
  const members = team?.members?.length ?? 0;
  return members > 0 ? members : 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pendingOf(pending: Readonly<Record<string, number>>, team: string): number {
  for (const [name, count] of Object.entries(pending)) {
    if (sameTeamName(name, team)) return count;
  }
  return 0;
}

function inWindow(now: number, then: number, windowMinutes: number): boolean {
  const age = now - then;
  return age >= 0 && age <= windowMinutes;
}

function isHard(id: string, mode: 'suggest' | 'auto'): boolean {
  if (mode === 'auto') return id !== 'consistent';
  return !SOFT_GUARD_IDS.has(id);
}

function report(results: GuardrailResult[]): GuardrailReport {
  const failure = results.find((result) => !result.ok && !result.warning) ?? null;
  const warnings = results.filter((result) => result.warning);
  return { ok: failure == null, rejected: failure != null, failure, results, warnings };
}

function targetFailure(proposal: ParsedProposal, ctx: GuardContext): GuardrailResult | null {
  for (const name of proposal.target_teams) {
    const team = ctx.teams.find((row) => sameTeamName(row.name, name));
    if (!team || team.active === false) {
      return {
        id: 'target',
        ok: false,
        detail: `${name} is not an active team`,
        inputs: { team: name },
      };
    }
    if (team.playable === false) {
      return {
        id: 'target',
        ok: false,
        detail: `${name} is not a player team`,
        inputs: { team: name },
      };
    }
    if (team.staffed === false) {
      return { id: 'target', ok: false, detail: `${name} has no players`, inputs: { team: name } };
    }
    if (ctx.protectedTeams.some((protectedName) => sameTeamName(protectedName, name))) {
      return { id: 'target', ok: false, detail: `${name} is protected`, inputs: { team: name } };
    }
  }
  if (proposal.target_role_id && !ctx.roleIds.includes(proposal.target_role_id)) {
    return {
      id: 'target',
      ok: false,
      detail: `Role ${proposal.target_role_id} is not in this scenario`,
      inputs: { role: proposal.target_role_id },
    };
  }
  return null;
}

function pileFailure(proposal: ParsedProposal, ctx: GuardContext): GuardrailResult | null {
  for (const name of proposal.target_teams) {
    const pressure = nonTimedPressure(name, ctx.minute, ctx.deliveries);
    if (pressure >= ctx.pressureMax) {
      return {
        id: 'pile_on',
        ok: false,
        detail: `${name} already has ${pressure} deliveries in 10 minutes`,
        inputs: { team: name, pressure, max: ctx.pressureMax },
      };
    }
    const unanswered = countFor(ctx.unansweredByTeam, name);
    if (unanswered >= 3) {
      return {
        id: 'pile_on',
        ok: false,
        detail: `${name} has ${unanswered} unanswered requests`,
        inputs: { team: name, unanswered },
      };
    }
    if (proposal.requires_response && ctx.onlineByTeam && countFor(ctx.onlineByTeam, name) === 0) {
      return {
        id: 'pile_on',
        ok: false,
        detail: `${name} has no one online to answer`,
        inputs: { team: name, online: 0 },
      };
    }
  }
  return null;
}

function senderFailure(proposal: ParsedProposal, ctx: GuardContext): GuardrailResult | null {
  if ('stakeholder_id' in proposal.sender) {
    const id = proposal.sender.stakeholder_id;
    if (!ctx.stakeholders.some((row) => row.id === id)) {
      return {
        id: 'sender',
        ok: false,
        detail: `Stakeholder ${id} is not in the cast`,
        inputs: { stakeholder_id: id },
      };
    }
  } else {
    const handle = proposal.sender.npc_handle;
    if (!ctx.npcs.some((row) => row.handle === handle)) {
      return {
        id: 'sender',
        ok: false,
        detail: `NPC ${handle} is not in the cast`,
        inputs: { npc_handle: handle },
      };
    }
  }
  if (STAKEHOLDER_APPS.has(proposal.app) && !('stakeholder_id' in proposal.sender)) {
    return {
      id: 'sender',
      ok: false,
      detail: `${proposal.app} needs a stakeholder sender`,
      inputs: { app: proposal.app },
    };
  }
  if (ctx.allowedApps.length > 0 && !ctx.allowedApps.includes(proposal.app)) {
    return {
      id: 'sender',
      ok: false,
      detail: `${proposal.app} is not an allowed channel`,
      inputs: { app: proposal.app },
    };
  }
  return null;
}

function namingFailure(proposal: ParsedProposal, ctx: GuardContext): GuardrailResult | null {
  const text = `${proposal.title}\n${proposal.content}`;
  if (META_WORD.test(text)) {
    return {
      id: 'meta',
      ok: false,
      detail: 'The text names the exercise machinery',
      inputs: { app: proposal.app },
    };
  }
  if (PUBLIC_APPS.has(proposal.app)) {
    const named = ctx.teams.find((team) => mentionsName(text, team.name));
    if (named) {
      return {
        id: 'team_named_publicly',
        ok: false,
        detail: `${named.name} is named in a public event`,
        inputs: { team: named.name, app: proposal.app },
      };
    }
  }
  return null;
}

function entityFailure(proposal: ParsedProposal, ctx: GuardContext): GuardrailResult | null {
  const corpus = [
    ctx.brief,
    ...ctx.facts,
    ...ctx.stakeholders.map((row) => row.name),
    ...ctx.npcs.flatMap((row) => [row.handle, row.name ?? '']),
    ...ctx.orgs,
    ...ctx.teams.map((team) => team.name),
    ...ctx.recentTexts.map((row) => `${row.title} ${row.content}`),
    ...ctx.upcoming.map((row) => `${row.title} ${row.content}`),
  ]
    .join('\n')
    .toLowerCase();
  const text = `${proposal.title}\n${proposal.content}`;
  const unknown = capitalisedPhrases(text).find((phrase) => !corpus.includes(phrase.toLowerCase()));
  if (!unknown) return null;
  return {
    id: 'entity',
    ok: false,
    detail: `Unknown name "${unknown}"`,
    inputs: { phrase: unknown },
  };
}

function numberFailure(proposal: ParsedProposal, ctx: GuardContext): GuardrailResult | null {
  const corpus = [
    ctx.brief,
    ...ctx.facts,
    ...ctx.recentTexts.map((row) => `${row.title} ${row.content}`),
  ].join('\n');
  const missing = significantNumbers(`${proposal.title}\n${proposal.content}`).find(
    (value) => !corpusHasNumber(corpus, value),
  );
  if (!missing) return null;
  return {
    id: 'number',
    ok: false,
    detail: `The number ${missing} is not in the facts`,
    inputs: { number: missing },
  };
}

function duplicateFailure(proposal: ParsedProposal, ctx: GuardContext): GuardrailResult | null {
  const tokens = tokenSet(`${proposal.title} ${proposal.content}`);
  const recent = ctx.recentTexts.filter(
    (row) =>
      proposal.target_teams.some((team) => sameTeamName(team, row.team)) &&
      inWindow(ctx.minute, row.minute, 30),
  );
  const candidates = [
    ...recent.map((row) => `${row.title} ${row.content}`),
    ...ctx.upcoming.map((row) => `${row.title} ${row.content}`),
  ];
  const hit = candidates.find((text) => jaccard(tokens, tokenSet(text)) >= 0.6);
  if (!hit) return null;
  return {
    id: 'duplicate',
    ok: false,
    detail: 'Too close to a recent or upcoming event',
    inputs: { sample: hit.slice(0, 80) },
  };
}

function fairnessFailure(proposal: ParsedProposal, ctx: GuardContext): GuardrailResult | null {
  if (proposal.kind === 'relief' || ctx.fairness.last_third) return null;
  const over = proposal.target_teams.find((name) =>
    ctx.fairness.teams.some((team) => sameTeamName(team.team, name) && team.over_cap),
  );
  if (!over) return null;
  return {
    id: 'fairness',
    ok: false,
    detail: `${over} is above its fair share of unscripted pressure`,
    inputs: { team: over },
  };
}

function severityStepFailure(proposal: ParsedProposal, ctx: GuardContext): GuardrailResult | null {
  if (proposal.severity !== 'high') return null;
  const causeRefs = new Set<string>();
  for (const id of proposal.cause.signal_ids) {
    const signal = ctx.signals.find((row) => row.id === id);
    for (const key of signal?.keys ?? []) {
      for (const ref of referencedInjectKeys(key)) causeRefs.add(ref);
    }
  }
  for (const name of proposal.target_teams) {
    if (ctx.priorLowMediumTeams.some((team) => sameTeamName(team, name))) continue;
    const authored = keysFor(ctx.authoredKeysByTeam, name);
    if (authored.some((key) => causeRefs.has(key))) continue;
    return {
      id: 'severity_step',
      ok: false,
      detail: `${name} has not had a lighter event about this cause`,
      inputs: { team: name },
    };
  }
  return null;
}

function countFor(map: Readonly<Record<string, number>>, team: string): number {
  for (const [name, count] of Object.entries(map)) {
    if (sameTeamName(name, team)) return count;
  }
  return 0;
}

function keysFor(map: Readonly<Record<string, string[]>>, team: string): string[] {
  for (const [name, keys] of Object.entries(map)) {
    if (sameTeamName(name, team)) return keys;
  }
  return [];
}

function mentionsName(text: string, name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 2) return false;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?:[^A-Za-z0-9]|$)`, 'i').test(text);
}

function capitalisedPhrases(text: string): string[] {
  return [...new Set(text.match(/\b[A-Z][A-Za-z'’.-]*(?:\s+[A-Z][A-Za-z'’.-]*)+\b/g) ?? [])];
}

function significantNumbers(text: string): string[] {
  const stripped = text
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/gi, ' ')
    .replace(/\b\d{1,2}\s*(?:am|pm)\b/gi, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*(?:minutes|minute|mins|min)\b/gi, ' ');
  return stripped.match(/\d+(?:\.\d+)?/g) ?? [];
}

function corpusHasNumber(corpus: string, value: string): boolean {
  const escaped = value.replace(/\./g, '\\.');
  return new RegExp(`(?:^|\\D)${escaped}(?:\\D|$)`).test(corpus);
}

function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 1),
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function renderObservation(
  input: ObservationInput,
  fairnessLine: string,
  limits: {
    brief: number;
    facts: number;
    claims: number;
    deps: number;
    moods: number;
    recent: number;
    teamDetail: boolean;
  },
): string {
  const teams = input.teams
    .filter((team) => team.playable !== false && team.staffed !== false)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const lines = [
    `SCENARIO: ${input.title}; crisis ${input.crisisType}; minute ${input.minute} of ${input.duration}.`,
    `BRIEF: ${input.brief.slice(0, limits.brief)}`,
    `CONFIRMED FACTS: ${input.facts.slice(0, limits.facts).join(' | ')}`,
    `FALSE CLAIMS IN CIRCULATION: ${input.falseClaims.slice(0, limits.claims).join(' | ')}`,
    'ORGS AND TEAMS (playable, staffed):',
    ...teams.map((team) => teamLine(team, limits.teamDetail)),
    'DEPENDENCIES:',
    ...input.dependencies
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, limits.deps)
      .map(
        (edge) =>
          `${edge.upstream} → ${edge.downstream.join(', ')}: ${edge.deliverable} (${edge.status}${edge.since != null ? ` since T+${edge.since}` : ''})`,
      ),
    'LAST 15 MINUTES, PER TEAM:',
    ...input.recentByTeam
      .slice()
      .sort((a, b) => a.team.localeCompare(b.team))
      .map(
        (row) =>
          `${row.team}: deliveries ${row.deliveries}, unanswered ${row.unanswered}, replies ${row.replies}, duties missed ${row.dutiesMissed}, silence ${row.silence ? 'yes' : 'no'}, decisions ${row.decisions}`,
      ),
    'STAKEHOLDER MOODS (non-calm):',
    ...input.moods
      .slice()
      .sort((a, b) => `${a.stakeholder}:${a.scope}`.localeCompare(`${b.stakeholder}:${b.scope}`))
      .slice(0, limits.moods)
      .map((mood) => `${mood.stakeholder} · ${mood.scope || 'session'} · ${mood.rung}`),
    'UPCOMING AUTHORED INJECTS (next 20 min):',
    ...input.upcoming
      .slice()
      .sort(upcomingOrder)
      .map((inject) => `${inject.key} · ${inject.title} · ${inject.target_teams.join(', ')}`),
    'RECENT UNSCRIPTED EVENTS:',
    ...input.recentUnscripted
      .slice()
      .sort((a, b) => a.minute - b.minute || a.title.localeCompare(b.title))
      .slice(-limits.recent)
      .map((event) => `T+${event.minute} · ${event.target} · ${event.title}`),
    'EXPOSURE SO FAR:',
    ...input.exposure
      .slice()
      .sort((a, b) => a.team.localeCompare(b.team))
      .map((row) => `${row.team}: director ${row.director}, cross-team ${row.crossTeam}`),
    'SIGNALS THIS WAKE:',
    ...input.signals
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((signal) => `${signal.id} · ${signal.kind} · ${signal.team} · ${signal.detail}`),
    'CAST YOU MAY VOICE:',
    ...input.cast
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((person) => `${person.id} ${person.name}`),
    ...input.npcs
      .slice()
      .sort((a, b) => a.handle.localeCompare(b.handle))
      .map((npc) => npc.handle),
    `FAIRNESS: ${fairnessLine}; protected: ${input.protectedTeams.slice().sort().join(', ') || 'none'}; busy: ${input.busyTeams.slice().sort().join(', ') || 'none'}`,
  ];
  return lines.join('\n');
}

function teamLine(team: DirectorTeam, detail: boolean): string {
  const members = detail
    ? (team.members ?? []).slice(0, 4).join(', ') ||
      `${team.size ?? team.members?.length ?? 0} members`
    : `${team.size ?? 0} members`;
  const org = team.org ?? '';
  const duty = detail ? (team.functionName ?? '') : '';
  return `${team.name} · ${org} · ${duty} · ${members}`;
}

function upcomingOrder(a: UpcomingInject, b: UpcomingInject): number {
  return a.minute - b.minute || a.key.localeCompare(b.key);
}
