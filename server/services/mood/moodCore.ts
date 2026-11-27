/**
 * Wait profile, mood ladder and the text block an NPC speaks from.
 * No database and no network. Persistence and consequences live in moodService.
 */

import { slugifyTeamName } from '../../../shared/conditionKeyGrammar.js';
import { moodScope, waitMinutesExcludingHeld } from '../roles/roleCore.js';

export const MOOD_RECOVERIES = ['none', 'one_rung_per_good_reply', 'reset_on_good_reply'] as const;
export type MoodRecovery = (typeof MOOD_RECOVERIES)[number];

export const RUNG_ID_RE = /^[a-z_]{2,30}$/;
export const MAX_RUNGS = 8;
export const MAX_SCRIPT_LINES = 3;
export const MAX_SCRIPT_CHARS = 300;

export interface WaitProfile {
  at_minute: number;
  episode_anchor_minute: number | null;
  wait_minutes: number;
  missed_calls: number;
  unanswered_messages: number;
  followups_sent: number;
  prior_tones: string[];
  prior_failed: number;
  prior_passed: number;
  gave_up_after: number;
}

export interface MoodCond {
  wait_minutes_gte?: number | 'gave_up_after';
  missed_calls_gte?: number;
  unanswered_messages_gte?: number;
  followups_sent_gte?: number;
  prior_tone_in?: string[];
  prior_failed_gte?: number;
  prior_passed_gte?: number;
}

export interface MoodWhen {
  all?: MoodCond[];
  any?: MoodCond[];
}

export type MoodConsequence =
  | { type: 'publish_inject'; inject_key: string }
  | { type: 'verdict_lock'; value: 'keep' }
  | { type: 'persuadability'; value: string }
  | { type: 'grievance_append'; text: string }
  | { type: 'stop_chains' }
  | { type: 'notify_trainer'; message?: string };

export interface MoodRung {
  id: string;
  label: string;
  when: MoodWhen;
  reply_style: string;
  script: { opening: string | null; lines: string[] };
  consequences: MoodConsequence[];
  variant_of?: 'escalated';
  terminal?: boolean;
}

export interface MoodLadder {
  gave_up_after_minutes: number | null;
  escalated_variant: string;
  recovery: MoodRecovery;
  rungs: MoodRung[];
}

export interface MoodDeliveryFact {
  delivery_id: string;
  stakeholder_id: string | null;
  /** Set when a chain step was sent by someone other than the delivery's stakeholder. */
  step_stakeholder_id?: string | null;
  channel: string;
  delivered_minute: number;
  call_state?: string | null;
  chain_step?: number | null;
  target_role_id?: string | null;
  line_team?: string | null;
  recipient_teams?: string[];
  missed_reason?: string | null;
  fallback_reason?: string | null;
  responses?: readonly MoodResponseFact[];
}

export interface MoodResponseFact {
  minute: number;
  team: string | null;
  user_id: string | null;
  judgement_status?: string | null;
  judgement?: { tone?: string; passed?: boolean } | null;
  id?: string;
}

export interface HeldInterval {
  start: number;
  end: number;
}

export interface HoldSnapshot {
  wait_minutes: number;
  missed_calls: number;
  unanswered_messages: number;
  followups_sent: number;
}

export interface MoodLockState {
  verdict?: 'keep';
  verdict_rung?: string;
  persuadability?: string;
  grievance_append?: string[];
  stop_chains?: boolean;
  pending_recovery_steps?: number;
}

export interface ClaimState {
  fired: string[];
  locks: MoodLockState;
}

export interface CurrentMood {
  rungId: string | null;
  /** Good replies judged since the last interaction. Each one can drop a rung. */
  pendingRecoverySteps?: number;
  /**
   * Profile captured when recovery last landed. The rung stays down until
   * the wait gets worse than this snapshot.
   */
  baseline?: HoldSnapshot | null;
}

export interface MoodSelection {
  rung: MoodRung;
  index: number;
  reason: 'matched' | 'held' | 'recovery' | 'terminal';
  /** Keep the recovered rung until the wait profile gets worse. */
  hold: boolean;
  /** The held snapshot is stale because new waiting has accrued. */
  clearHold: boolean;
}

export interface MoodIssue {
  level: 'error';
  message: string;
}

const MISSED_CALL_STATES = new Set(['missed', 'declined']);

function rung(
  id: string,
  label: string,
  when: MoodWhen,
  replyStyle: string,
  opening: string | null,
  lines: string[],
  consequences: MoodConsequence[],
  extra?: { variant_of?: 'escalated'; terminal?: boolean },
): MoodRung {
  return {
    id,
    label,
    when,
    reply_style: replyStyle,
    script: { opening, lines },
    consequences,
    ...extra,
  };
}

/** The spec ladder, without the press `publish_inject` (that one is authored). */
export const DEFAULT_MOOD_LADDER: MoodLadder = {
  gave_up_after_minutes: null,
  escalated_variant: 'angry',
  recovery: 'one_rung_per_good_reply',
  rungs: [
    rung('calm', 'Calm', {}, 'Polite and patient.', null, [], []),
    rung(
      'impatient',
      'Impatient',
      { any: [{ wait_minutes_gte: 5 }, { missed_calls_gte: 1 }, { unanswered_messages_gte: 2 }] },
      'Clipped and businesslike. Mentions the wait once.',
      "I've been trying to reach you.",
      ['I need an answer today.'],
      [],
    ),
    rung(
      'upset',
      'Upset',
      {
        any: [
          { wait_minutes_gte: 12 },
          { missed_calls_gte: 2 },
          { followups_sent_gte: 2 },
          { prior_tone_in: ['dismissive', 'evasive'] },
        ],
      },
      'Hurt and frustrated. Says plainly they feel ignored.',
      "I've called you {missed_calls} times. People here feel ignored.",
      ['Why did nobody pick up?'],
      [{ type: 'persuadability', value: 'low' }],
    ),
    rung(
      'angry',
      'Angry',
      {
        any: [
          { wait_minutes_gte: 20 },
          { missed_calls_gte: 3 },
          { prior_tone_in: ['hostile', 'defensive'] },
          { prior_failed_gte: 2 },
        ],
      },
      'Angry but not abusive. Short sentences. Demands a named person and a time.',
      'Finally. {wait_minutes} minutes. Who is actually in charge?',
      [],
      [{ type: 'verdict_lock', value: 'keep' }, { type: 'notify_trainer' }],
      { variant_of: 'escalated' },
    ),
    rung(
      'disappointed',
      'Disappointed',
      { any: [{ wait_minutes_gte: 20 }, { missed_calls_gte: 3 }, { prior_failed_gte: 2 }] },
      'Quiet, sad, resigned. Says they expected better from this organisation.',
      'I had hoped you would call sooner.',
      [],
      [{ type: 'verdict_lock', value: 'keep' }],
      { variant_of: 'escalated' },
    ),
    rung(
      'gave_up',
      'Gave up',
      { all: [{ wait_minutes_gte: 'gave_up_after' }] },
      'Cold and final. Says they stopped waiting and have taken it elsewhere.',
      "I stopped waiting. I've spoken to the press.",
      [],
      [{ type: 'stop_chains' }, { type: 'verdict_lock', value: 'keep' }],
      { terminal: true },
    ),
  ],
};

export function defaultLadderFor(persuadability: string | null | undefined): MoodLadder {
  const variant = persuadability === 'low' ? 'angry' : 'disappointed';
  return {
    ...DEFAULT_MOOD_LADDER,
    escalated_variant: variant,
    rungs: DEFAULT_MOOD_LADDER.rungs.map((item) => ({
      ...item,
      when: { ...item.when, all: item.when.all?.map((cond) => ({ ...cond })), any: item.when.any?.map((cond) => ({ ...cond })) },
      script: { opening: item.script.opening, lines: [...item.script.lines] },
      consequences: item.consequences.map((consequence) => ({ ...consequence })),
    })),
  };
}

export function resolveGaveUpAfter(ladder: MoodLadder, callbackWindowMinutes: number): number {
  return ladder.gave_up_after_minutes ?? callbackWindowMinutes;
}

export function moodScopeForDelivery(delivery: MoodDeliveryFact): string {
  const teams = delivery.recipient_teams ?? [];
  return moodScope({
    roleId: delivery.target_role_id,
    team: delivery.line_team || (teams.length === 1 ? teams[0] : null),
  });
}

function scopesEqual(left: string, right: string): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.startsWith('role:') || right.startsWith('role:')) return false;
  const a = slugifyTeamName(left);
  const b = slugifyTeamName(right);
  return Boolean(a) && a === b;
}

function fromStakeholder(delivery: MoodDeliveryFact, stakeholderId: string): boolean {
  return delivery.stakeholder_id === stakeholderId || delivery.step_stakeholder_id === stakeholderId;
}

function isMissedAttempt(delivery: MoodDeliveryFact): boolean {
  if (delivery.channel !== 'call') return false;
  const state = delivery.call_state ?? null;
  if (state === 'cancelled' || state === 'scheduled') return false;
  if (state && MISSED_CALL_STATES.has(state)) return true;
  return false;
}

function responseCloses(
  response: MoodResponseFact,
  delivery: MoodDeliveryFact,
  scope: string,
  rolePlayerIds: readonly string[],
): boolean {
  if (scope.startsWith('role:')) {
    const rolePlayer = response.user_id != null && rolePlayerIds.includes(response.user_id);
    const team = delivery.line_team || delivery.recipient_teams?.[0] || '';
    const fallback = Boolean(delivery.fallback_reason) && Boolean(response.team) && scopesEqual(response.team ?? '', team);
    return rolePlayer || fallback;
  }
  if (!scope) return true;
  return Boolean(response.team) && scopesEqual(response.team ?? '', scope);
}

function inEpisode(delivery: MoodDeliveryFact): boolean {
  if (delivery.channel !== 'call') return true;
  return delivery.call_state !== 'cancelled' && delivery.call_state !== 'scheduled';
}

function judgedResponses(
  deliveries: readonly MoodDeliveryFact[],
  stakeholderId: string,
  scope: string,
  rolePlayerIds: readonly string[],
  atMinute: number,
): MoodResponseFact[] {
  const rows: MoodResponseFact[] = [];
  for (const delivery of deliveries) {
    if (delivery.delivered_minute > atMinute) continue;
    if (!fromStakeholder(delivery, stakeholderId) || !scopesEqual(moodScopeForDelivery(delivery), scope)) continue;
    for (const response of delivery.responses ?? []) {
      if (response.minute > atMinute) continue;
      if (!responseCloses(response, delivery, scope, rolePlayerIds)) continue;
      if (response.judgement_status !== 'done' || !response.judgement) continue;
      rows.push(response);
    }
  }
  return rows.sort((a, b) => b.minute - a.minute || (b.id ?? '').localeCompare(a.id ?? ''));
}

export function computeWaitProfile(input: {
  stakeholderId: string;
  scope: string;
  atMinute: number;
  deliveries: readonly MoodDeliveryFact[];
  gaveUpAfter: number;
  rolePlayerIds?: readonly string[];
  heldIntervals?: readonly HeldInterval[];
}): WaitProfile {
  const rolePlayerIds = input.rolePlayerIds ?? [];
  const scoped = input.deliveries
    .filter((delivery) => inEpisode(delivery))
    .filter((delivery) => fromStakeholder(delivery, input.stakeholderId) && scopesEqual(moodScopeForDelivery(delivery), input.scope))
    .filter((delivery) => delivery.delivered_minute <= input.atMinute)
    .sort((a, b) => a.delivered_minute - b.delivered_minute || a.delivery_id.localeCompare(b.delivery_id));

  let open: MoodDeliveryFact[] = [];
  for (const delivery of scoped) {
    const closed = (delivery.responses ?? []).some(
      (response) => response.minute <= input.atMinute && responseCloses(response, delivery, input.scope, rolePlayerIds),
    );
    if (closed) {
      open = [];
      continue;
    }
    open.push(delivery);
  }

  const anchor = open[0]?.delivered_minute ?? null;
  const roleScope = input.scope.startsWith('role:');
  const wait =
    anchor == null
      ? 0
      : roleScope
        ? waitMinutesExcludingHeld({
            elapsedMinutes: input.atMinute,
            firstContactMinute: anchor,
            heldIntervals: input.heldIntervals ?? [],
          })
        : Math.max(0, input.atMinute - anchor);

  const recent = judgedResponses(input.deliveries, input.stakeholderId, input.scope, rolePlayerIds, input.atMinute).slice(0, 3);
  const tones = recent.map((response) => response.judgement?.tone).filter((tone): tone is string => Boolean(tone));
  return {
    at_minute: input.atMinute,
    episode_anchor_minute: anchor,
    wait_minutes: wait,
    missed_calls: open.filter(isMissedAttempt).length,
    unanswered_messages: open.filter((delivery) => delivery.channel !== 'call').length,
    followups_sent: open.filter((delivery) => delivery.chain_step != null).length,
    prior_tones: tones,
    prior_failed: recent.filter((response) => response.judgement?.passed === false).length,
    prior_passed: recent.filter((response) => response.judgement?.passed === true).length,
    gave_up_after: input.gaveUpAfter,
  };
}

export function activeRungs(ladder: MoodLadder): MoodRung[] {
  return ladder.rungs.filter((item) => item.variant_of !== 'escalated' || item.id === ladder.escalated_variant);
}

function condHolds(cond: MoodCond, profile: WaitProfile): boolean {
  if (cond.wait_minutes_gte != null) {
    const threshold = cond.wait_minutes_gte === 'gave_up_after' ? profile.gave_up_after : cond.wait_minutes_gte;
    return profile.wait_minutes >= threshold;
  }
  if (cond.missed_calls_gte != null) return profile.missed_calls >= cond.missed_calls_gte;
  if (cond.unanswered_messages_gte != null) return profile.unanswered_messages >= cond.unanswered_messages_gte;
  if (cond.followups_sent_gte != null) return profile.followups_sent >= cond.followups_sent_gte;
  if (cond.prior_tone_in != null) return Boolean(profile.prior_tones[0] && cond.prior_tone_in.includes(profile.prior_tones[0]));
  if (cond.prior_failed_gte != null) return profile.prior_failed >= cond.prior_failed_gte;
  if (cond.prior_passed_gte != null) return profile.prior_passed >= cond.prior_passed_gte;
  return false;
}

export function whenHolds(when: MoodWhen | null | undefined, profile: WaitProfile): boolean {
  if (!when) return true;
  const hasAll = Array.isArray(when.all);
  const hasAny = Array.isArray(when.any);
  if (!hasAll && !hasAny) return true;
  const allOk = !hasAll || (when.all ?? []).every((cond) => condHolds(cond, profile));
  const anyOk = !hasAny || (when.any ?? []).some((cond) => condHolds(cond, profile));
  return allOk && anyOk;
}

export function selectRung(ladder: MoodLadder, profile: WaitProfile, current?: CurrentMood | null): MoodSelection {
  const rungs = activeRungs(ladder);
  const base = rungs[0];
  if (!base) {
    throw new Error('A mood ladder needs a base rung');
  }
  let candidate = 0;
  rungs.forEach((item, index) => {
    if (whenHolds(item.when, profile)) candidate = index;
  });
  const currentIndex = current?.rungId ? rungs.findIndex((item) => item.id === current.rungId) : -1;
  if (currentIndex >= 0 && rungs[currentIndex]?.terminal) {
    return { rung: rungs[currentIndex], index: currentIndex, reason: 'terminal', hold: false, clearHold: false };
  }
  if (currentIndex < 0) {
    return { rung: rungs[candidate], index: candidate, reason: 'matched', hold: false, clearHold: false };
  }
  let index = currentIndex;
  let reason: MoodSelection['reason'] = 'held';
  const steps = current?.pendingRecoverySteps ?? 0;
  let recovered = false;
  if (steps > 0 && ladder.recovery !== 'none') {
    if (ladder.recovery === 'reset_on_good_reply') index = 0;
    else index = Math.max(0, currentIndex - Math.max(1, steps));
    recovered = true;
    reason = 'recovery';
  }
  const grew = waitingWorsened(current?.baseline, profile);
  const heldDown = (recovered || Boolean(current?.baseline)) && !grew;
  if (candidate > index && !heldDown) {
    index = candidate;
    reason = 'matched';
  }
  return {
    rung: rungs[index] ?? base,
    index,
    reason,
    hold: recovered && !grew,
    clearHold: Boolean(current?.baseline) && grew,
  };
}

export function holdSnapshot(profile: WaitProfile): HoldSnapshot {
  return {
    wait_minutes: profile.wait_minutes,
    missed_calls: profile.missed_calls,
    unanswered_messages: profile.unanswered_messages,
    followups_sent: profile.followups_sent,
  };
}

/** True when the wait itself got worse, not merely because an old `when` still matches. */
export function waitingWorsened(baseline: HoldSnapshot | null | undefined, profile: WaitProfile): boolean {
  if (!baseline) return false;
  return (
    profile.wait_minutes > baseline.wait_minutes ||
    profile.missed_calls > baseline.missed_calls ||
    profile.unanswered_messages > baseline.unanswered_messages ||
    profile.followups_sent > baseline.followups_sent
  );
}

/** Append a consequence id only when it is absent, and merge locks instead of replacing them. */
export function commitClaim(state: ClaimState, id: string, patch: MoodLockState): { won: boolean; state: ClaimState } {
  if (state.fired.includes(id)) return { won: false, state };
  return {
    won: true,
    state: {
      fired: [...state.fired, id],
      locks: mergeLocks(state.locks, patch),
    },
  };
}

export function mergeLocks(current: MoodLockState, patch: MoodLockState): MoodLockState {
  const grievance = [...(current.grievance_append ?? [])];
  for (const line of patch.grievance_append ?? []) {
    if (!grievance.includes(line)) grievance.push(line);
  }
  return {
    ...current,
    ...patch,
    grievance_append: grievance.length > 0 ? grievance : current.grievance_append,
    pending_recovery_steps:
      patch.pending_recovery_steps !== undefined ? patch.pending_recovery_steps : current.pending_recovery_steps,
  };
}

/**
 * Claim, then publish. A failed publish releases the claim so the next tick retries.
 * A claim that is already held does not publish again; `inject_publications` is the
 * second guard if a released claim is published twice.
 */
export function applyPublishInject(input: {
  fired: readonly string[];
  id: string;
  publish: () => boolean;
}): { fired: string[]; published: boolean; released: boolean } {
  if (input.fired.includes(input.id)) {
    return { fired: [...input.fired], published: false, released: false };
  }
  let ok = false;
  try {
    ok = input.publish();
  } catch {
    ok = false;
  }
  if (!ok) {
    return {
      fired: input.fired.filter((item) => item !== input.id),
      published: false,
      released: true,
    };
  }
  return { fired: [...input.fired, input.id], published: true, released: false };
}

/** A good reply adds a recovery step and leaves every other lock in place. */
export function addPendingRecovery(locks: MoodLockState, steps = 1): MoodLockState {
  return {
    ...locks,
    pending_recovery_steps: (locks.pending_recovery_steps ?? 0) + steps,
  };
}

export function consequenceId(rungId: string, index: number): string {
  return `${rungId}:${index}`;
}

export function consequencesToFire(
  rung: MoodRung,
  alreadyFired: readonly string[],
): Array<{ id: string; consequence: MoodConsequence }> {
  const fired = new Set(alreadyFired);
  const due: Array<{ id: string; consequence: MoodConsequence }> = [];
  rung.consequences.forEach((consequence, index) => {
    const id = consequenceId(rung.id, index);
    if (!fired.has(id)) due.push({ id, consequence });
  });
  return due;
}

/** Two callers sharing `fired` each take a consequence at most once. */
export function claimConsequences(
  rung: MoodRung,
  fired: readonly string[],
): { ids: string[]; next: string[] } {
  const due = consequencesToFire(rung, fired);
  const ids = due.map((item) => item.id);
  return { ids, next: [...fired, ...ids] };
}

export function renderMoodPlaceholders(text: string, profile: WaitProfile): string {
  return text.replace(/\{(wait_minutes|missed_calls|unanswered_messages|followups_sent)\}/g, (_token, name: string) => {
    const value = profile[name as keyof WaitProfile];
    return typeof value === 'number' ? String(value) : '';
  });
}

export function buildMoodBlock(
  rung: MoodRung,
  profile: WaitProfile,
  _stakeholder: { name?: string | null },
  options: { channel?: string; includeScript?: boolean; recovery?: MoodRecovery },
): string {
  const lines: string[] = [`YOUR MOOD RIGHT NOW: ${rung.label}. ${rung.reply_style}`];
  const facts: string[] = [];
  if (profile.wait_minutes > 0) {
    facts.push(`you first contacted them ${profile.wait_minutes} minutes ago.`);
  }
  if (profile.missed_calls > 0) facts.push(`${profile.missed_calls} of your calls went unanswered.`);
  if (profile.unanswered_messages > 0) facts.push(`${profile.unanswered_messages} of your messages got no reply.`);
  if (profile.prior_tones[0]) facts.push(`The last time they replied, they came across as ${profile.prior_tones[0]}.`);
  if (facts.length > 0) {
    lines.push(`WHY YOU FEEL THIS WAY (facts, do not exaggerate): ${facts.join(' ')}`);
  }
  const opening = rung.script.opening ? renderMoodPlaceholders(rung.script.opening, profile) : '';
  if (options.includeScript && opening) {
    lines.push(`OPEN WITH (in your own words): "${opening}"`);
  }
  if (options.includeScript && rung.script.lines.length > 0) {
    const worked = rung.script.lines.map((line) => `- ${renderMoodPlaceholders(line, profile)}`).join(' ');
    lines.push(`WORK THESE IN: ${worked}`);
  }
  if (!options.includeScript && opening) {
    lines.push(`You may let this show, in your own words: "${opening}"`);
  }
  lines.push('Let the mood show in your word choice and pacing. Never be abusive, never threaten violence.');
  lines.push(
    `Never say "${rung.label}" to them, and never say the word mood. The label is for you, not for them to hear.`,
  );
  const recovery = options.recovery ?? 'none';
  if (rung.terminal) {
    lines.push('You have already acted on your own (see opening). Do not take it back.');
  } else if (recovery !== 'none') {
    lines.push('If they apologise sincerely and give a concrete answer, you may soften a little.');
  }
  return lines.join('\n');
}

export function isBaseRung(ladder: MoodLadder, rungId: string): boolean {
  return activeRungs(ladder)[0]?.id === rungId;
}

export function mergeLadders(base: MoodLadder, override: unknown): MoodLadder {
  const parsed = asLadder(override);
  if (!parsed) return base;
  const rungs = base.rungs.map((item) => ({
    ...item,
    script: { opening: item.script.opening, lines: [...item.script.lines] },
    consequences: [...item.consequences],
  }));
  for (const item of parsed.rungs) {
    const index = rungs.findIndex((existing) => existing.id === item.id);
    if (index >= 0) rungs[index] = item;
    else rungs.push(item);
  }
  return {
    gave_up_after_minutes:
      parsed.gave_up_after_minutes !== undefined ? parsed.gave_up_after_minutes : base.gave_up_after_minutes,
    escalated_variant: parsed.escalated_variant || base.escalated_variant,
    recovery: parsed.recovery || base.recovery,
    rungs,
  };
}

export function validateMoodLadder(input: {
  ladder: unknown;
  knownInjects?: ReadonlyArray<{ key: string; conditional: boolean }> | null;
}): MoodIssue[] {
  const issues: MoodIssue[] = [];
  const fail = (message: string) => issues.push({ level: 'error', message });
  if (!input.ladder || typeof input.ladder !== 'object' || Array.isArray(input.ladder)) {
    fail('mood_ladder must be an object.');
    return issues;
  }
  const record = input.ladder as Record<string, unknown>;
  const rungs = Array.isArray(record.rungs) ? record.rungs : null;
  if (!rungs) {
    fail('mood_ladder.rungs must be a list.');
    return issues;
  }
  if (rungs.length === 0) fail('A mood ladder needs a base rung.');
  if (rungs.length > MAX_RUNGS) fail(`A mood ladder has at most ${MAX_RUNGS} rungs.`);
  if (record.recovery != null && !MOOD_RECOVERIES.includes(record.recovery as MoodRecovery)) {
    fail('mood_ladder.recovery must be none, one_rung_per_good_reply or reset_on_good_reply.');
  }
  if (record.gave_up_after_minutes != null && record.gave_up_after_minutes !== undefined) {
    const minutes = Number(record.gave_up_after_minutes);
    if (!Number.isInteger(minutes) || minutes < 1) fail('gave_up_after_minutes must be a positive integer or null.');
  }
  const ids = new Set<string>();
  let terminals = 0;
  rungs.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      fail(`Rung ${index + 1} must be an object.`);
      return;
    }
    const rungRecord = raw as Record<string, unknown>;
    const id = typeof rungRecord.id === 'string' ? rungRecord.id : '';
    if (!RUNG_ID_RE.test(id)) fail(`Rung id "${id || index + 1}" must match ${RUNG_ID_RE}.`);
    else if (ids.has(id)) fail(`Duplicate rung id "${id}".`);
    else ids.add(id);
    const when = rungRecord.when;
    const emptyWhen = !when || (typeof when === 'object' && !Array.isArray(when) && Object.keys(when as object).length === 0);
    if (index === 0 && !emptyWhen) fail('The first rung\'s when must be {}.');
    if (rungRecord.terminal === true) {
      terminals += 1;
      if (index !== rungs.length - 1) fail('The terminal rung must be last.');
    }
    const script = rungRecord.script;
    const scriptRecord = script && typeof script === 'object' ? (script as Record<string, unknown>) : {};
    const lines = Array.isArray(scriptRecord.lines) ? scriptRecord.lines : [];
    if (lines.length > MAX_SCRIPT_LINES) fail(`Rung "${id || index + 1}" has more than ${MAX_SCRIPT_LINES} script lines.`);
    const texts = [
      typeof scriptRecord.opening === 'string' ? scriptRecord.opening : '',
      ...lines.filter((line): line is string => typeof line === 'string'),
    ];
    if (texts.some((text) => text.length > MAX_SCRIPT_CHARS)) {
      fail(`Rung "${id || index + 1}" has a script line longer than ${MAX_SCRIPT_CHARS} characters.`);
    }
    const consequences = Array.isArray(rungRecord.consequences) ? rungRecord.consequences : [];
    for (const consequence of consequences) {
      if (!consequence || typeof consequence !== 'object') {
        fail(`Rung "${id}" has a consequence that is not an object.`);
        continue;
      }
      const kind = (consequence as { type?: unknown }).type;
      if (kind === 'publish_inject') {
        const key = (consequence as { inject_key?: unknown }).inject_key;
        if (typeof key !== 'string' || !key) fail(`Rung "${id}" publish_inject needs an inject_key.`);
        else if (input.knownInjects) {
          const known = input.knownInjects.find((item) => item.key === key);
          if (!known) fail(`publish_inject key "${key}" does not exist.`);
          else if (!known.conditional) fail(`publish_inject key "${key}" must be a conditional inject.`);
        }
      } else if (
        kind !== 'verdict_lock' &&
        kind !== 'persuadability' &&
        kind !== 'grievance_append' &&
        kind !== 'stop_chains' &&
        kind !== 'notify_trainer'
      ) {
        fail(`Rung "${id}" has an unknown consequence.`);
      }
    }
  });
  if (terminals > 1) fail('A mood ladder has at most one terminal rung.');
  if (typeof record.escalated_variant === 'string' && record.escalated_variant && !ids.has(record.escalated_variant)) {
    fail(`escalated_variant "${record.escalated_variant}" is not a rung id.`);
  }
  return issues;
}

function asLadder(raw: unknown): MoodLadder | null {
  if (validateMoodLadder({ ladder: raw }).length > 0) return null;
  const record = raw as Record<string, unknown>;
  const rungs = (record.rungs as unknown[]).map((item) => normalizeRung(item as Record<string, unknown>));
  return {
    gave_up_after_minutes:
      record.gave_up_after_minutes == null ? null : Number(record.gave_up_after_minutes),
    escalated_variant: typeof record.escalated_variant === 'string' ? record.escalated_variant : 'disappointed',
    recovery: MOOD_RECOVERIES.includes(record.recovery as MoodRecovery)
      ? (record.recovery as MoodRecovery)
      : 'one_rung_per_good_reply',
    rungs,
  };
}

function normalizeRung(record: Record<string, unknown>): MoodRung {
  const when = record.when && typeof record.when === 'object' ? (record.when as MoodWhen) : {};
  const script = record.script && typeof record.script === 'object' ? (record.script as Record<string, unknown>) : {};
  const lines = Array.isArray(script.lines) ? script.lines.filter((line): line is string => typeof line === 'string') : [];
  const consequences = Array.isArray(record.consequences)
    ? (record.consequences.filter((item) => item && typeof item === 'object') as MoodConsequence[])
    : [];
  return {
    id: String(record.id),
    label: typeof record.label === 'string' && record.label.trim() ? record.label : String(record.id),
    when,
    reply_style: typeof record.reply_style === 'string' ? record.reply_style : '',
    script: {
      opening: typeof script.opening === 'string' && script.opening.trim() ? script.opening : null,
      lines,
    },
    consequences,
    ...(record.variant_of === 'escalated' ? { variant_of: 'escalated' as const } : {}),
    ...(record.terminal === true ? { terminal: true } : {}),
  };
}

export function ladderFromUnknown(raw: unknown, persuadability: string | null | undefined): MoodLadder {
  return asLadder(raw) ?? defaultLadderFor(persuadability);
}

/** First script line for a chain template's `{mood_line}`. Empty on the base rung. */
export function moodLineFor(ladder: MoodLadder, rung: MoodRung, profile: WaitProfile): string {
  if (isBaseRung(ladder, rung.id)) return '';
  const line = rung.script.lines[0];
  return line ? renderMoodPlaceholders(line, profile) : '';
}

/** While the role is held, the open interval's end is the next minute (the helper treats end as exclusive). */
export function extendHeldIntervals(
  intervals: readonly HeldInterval[],
  heldNow: boolean,
  minute: number,
): HeldInterval[] {
  const next = intervals.map((interval) => ({ ...interval }));
  if (!heldNow) return next;
  const end = minute + 1;
  const last = next[next.length - 1];
  if (last && last.end >= minute) {
    last.end = Math.max(last.end, end);
    return next;
  }
  next.push({ start: minute, end });
  return next;
}

export function moodStopKey(stakeholderId: string, scope: string): string {
  return `${stakeholderId}|${scope}`;
}
