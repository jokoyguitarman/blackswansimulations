/**
 * Trainer controls and the countdown/expiry sweep. Publishing claims the
 * proposal row with a conditional status update, then writes one runtime inject.
 */

import {
  modeSwitchEffect,
  modeWithinCeiling,
  needsTrainerApproval,
  parseDirectorMode,
  resolveDirectorMode,
  suggestionExpiresAt,
  type DirectorMode,
  type DirectorSeverity,
} from '../../../shared/directorModes.js';
import { directorPanel, type DirectorPanelModel } from '../../../shared/directorPanel.js';
import {
  applyCrossTeamGuards,
  type CrossTeamGuardEnv,
  type DepthTrigger,
  type RecentCrossTeamTrigger,
  type TeamDelivery,
} from '../conditions/crossTeamCore.js';
import type { TriggerRecordInput } from '../conditions/injectTriggerService.js';
import {
  checkProposal,
  type FairnessState,
  type GuardContext,
  type GuardrailResult,
  type ParsedProposal,
} from './directorCore.js';
import { logger } from '../../lib/logger.js';
import {
  buildDirectorInject,
  countdownIsStale,
  publishedCapEvents,
  type DirectorNpc,
  type DirectorPerson,
} from './directorPublish.js';
import {
  addSnooze,
  armPublishSlots,
  directorIsPaused,
  noteProposalSettled,
  setDirectorPaused,
  snoozedTeams,
  sweepThisTick,
  takePublishSlot,
} from './directorRuntime.js';
import type { Signal } from './directorSignals.js';

export interface ConsoleProposal {
  id: string;
  sessionId: string;
  seq: number;
  minute: number;
  status: string;
  mode: 'suggest' | 'auto' | null;
  reason: string | null;
  proposal: ParsedProposal | null;
  signals: Signal[];
  guardrails: GuardrailResult[];
  consistencyStatus: string | null;
  fairness: FairnessState | null;
  autoPublishAt: string | null;
  createdAt: string;
  fairnessOverride: boolean;
  injectId: string | null;
}

export interface SessionDirector {
  id: string;
  scenarioId: string;
  trainerId: string | null;
  directorMode: string | null;
  elapsedMinutes: number;
}

export interface ProposalPatch {
  status?: string;
  proposal?: ParsedProposal | null;
  guardrails?: GuardrailResult[];
  reason?: string | null;
  decidedBy?: string | null;
  decidedAt?: string | null;
  vetoReason?: string | null;
  fairnessOverride?: boolean;
  injectId?: string | null;
  editBefore?: unknown;
  editAfter?: unknown;
  autoPublishAt?: string | null;
}

export interface PublishFacts {
  scenarioId: string;
  guard: GuardContext;
  recent: RecentCrossTeamTrigger[];
  deliveries: TeamDelivery[];
  triggersByKey: Record<string, DepthTrigger | undefined>;
  people: DirectorPerson[];
  npcs: DirectorNpc[];
  stakeholderNames: Record<string, string>;
}

export interface ApproveEdits {
  title?: string;
  content?: string;
  target_teams?: string[];
  app?: ParsedProposal['app'];
  severity?: ParsedProposal['severity'];
  response_rubric?: ParsedProposal['response_rubric'];
  fairness_override_reason?: string;
}

export type CommandResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; error: string };

export interface DirectorSettings {
  enabled: boolean;
  modeMax: DirectorMode;
  defaultMode: DirectorMode;
  autoMaxSeverity: DirectorSeverity;
  graceSeconds: number;
  ttlMinutes: number;
  tolerance: number;
  budgetLimit: number;
  crossTeam: CrossTeamGuardEnv;
}

export interface DirectorCommandDeps {
  now(): Date;
  settings(): DirectorSettings;
  budgetUsed(sessionId: string): number;
  loadSession(sessionId: string): Promise<SessionDirector | 'missing' | null>;
  scenarioMode(scenarioId: string): Promise<string | null>;
  listProposals(sessionId: string): Promise<ConsoleProposal[] | 'missing'>;
  dueProposals(
    sessionId: string,
    nowIso: string,
    createdBeforeIso: string,
  ): Promise<ConsoleProposal[] | 'missing'>;
  /** Effective mode after the env ceiling. `missing` means migration 279 is absent. */
  resolvedMode(sessionId: string): Promise<DirectorMode | 'missing'>;
  stakeholderNames(scenarioId: string): Promise<Record<string, string>>;
  updateProposal(
    id: string,
    expectStatus: string,
    patch: ProposalPatch,
  ): Promise<'updated' | 'lost' | 'missing'>;
  setSessionMode(sessionId: string, mode: DirectorMode): Promise<'ok' | 'missing' | 'error'>;
  expirePending(sessionId: string): Promise<string[] | 'missing'>;
  convertCountdowns(sessionId: string): Promise<string[] | 'missing'>;
  publishFacts(sessionId: string, minute: number): Promise<PublishFacts | null>;
  insertInject(row: Record<string, unknown>): Promise<{ id: string } | null>;
  publishInject(injectId: string, sessionId: string, userId: string): Promise<void>;
  recordTrigger(input: TriggerRecordInput): Promise<void>;
  emit(trainerId: string | null, type: string, data: Record<string, unknown>): void;
  requestWake(
    sessionId: string,
    actorId: string,
    body: { team?: string; hint?: string },
  ): Promise<CommandResult>;
}

export interface DirectorCommands {
  get(sessionId: string): Promise<CommandResult>;
  patch(
    sessionId: string,
    actorId: string,
    body: { mode?: DirectorMode; pause?: boolean },
  ): Promise<CommandResult>;
  approve(
    sessionId: string,
    proposalId: string,
    actorId: string,
    edits: ApproveEdits,
  ): Promise<CommandResult>;
  veto(
    sessionId: string,
    proposalId: string,
    actorId: string,
    reason?: string,
  ): Promise<CommandResult>;
  hold(sessionId: string, proposalId: string): Promise<CommandResult>;
  request(
    sessionId: string,
    actorId: string,
    body: { team?: string; hint?: string },
  ): Promise<CommandResult>;
  snooze(sessionId: string, body: { team: string; minutes?: number }): Promise<CommandResult>;
  sweep(input: {
    sessionId: string;
    elapsedMinutes: number;
    trainerId: string | null;
    remainingCap: number;
  }): Promise<void>;
}

const PUBLISH_GUARDS = ['cap', 'target', 'pile_on', 'fairness'] as const;

export function createDirectorCommands(deps: DirectorCommandDeps): DirectorCommands {
  return {
    get: (sessionId) => getConsole(deps, sessionId),
    patch: (sessionId, actorId, body) => patchConsole(deps, sessionId, actorId, body),
    approve: (sessionId, proposalId, actorId, edits) =>
      approveProposal(deps, sessionId, proposalId, actorId, edits),
    veto: (sessionId, proposalId, actorId, reason) =>
      vetoProposal(deps, sessionId, proposalId, actorId, reason),
    request: (sessionId, actorId, body) => requestDirector(deps, sessionId, actorId, body),
    hold: (sessionId, proposalId) => holdProposal(deps, sessionId, proposalId),
    snooze: (sessionId, body) => snoozeTeam(deps, sessionId, body),
    sweep: (input) => sweepSession(deps, input),
  };
}

async function getConsole(deps: DirectorCommandDeps, sessionId: string): Promise<CommandResult> {
  const settings = deps.settings();
  const empty = panelBody(deps, sessionId, settings, 'off', null, null, [], null);
  if (!settings.enabled) return ok(empty);
  const session = await deps.loadSession(sessionId);
  if (session === 'missing' || session == null) return ok({ ...empty, unavailable: true });
  const scenarioMode = parseDirectorMode(await deps.scenarioMode(session.scenarioId));
  const mode = resolveDirectorMode(
    settings,
    { mode: session.directorMode },
    { mode: scenarioMode },
  );
  const rows = await deps.listProposals(sessionId);
  if (rows === 'missing') return ok({ ...empty, unavailable: true });
  const latest = [...rows].reverse().find((row) => row.fairness);
  const names = await deps.stakeholderNames(session.scenarioId);
  return ok(
    panelBody(
      deps,
      sessionId,
      settings,
      mode,
      parseDirectorMode(session.directorMode),
      scenarioMode,
      rows,
      latest?.fairness ?? null,
      names,
    ),
  );
}

function panelBody(
  deps: DirectorCommandDeps,
  sessionId: string,
  settings: DirectorSettings,
  mode: DirectorMode,
  sessionMode: DirectorMode | null,
  scenarioMode: DirectorMode | null,
  rows: ConsoleProposal[],
  fairness: FairnessState | null,
  stakeholderNames: Record<string, string> = {},
): DirectorPanelModel & { unavailable?: boolean } {
  return directorPanel({
    enabled: settings.enabled,
    mode,
    modeMax: settings.modeMax,
    scenarioMode,
    sessionMode,
    paused: directorIsPaused(sessionId),
    budgetUsed: deps.budgetUsed(sessionId),
    budgetLimit: settings.budgetLimit,
    tolerance: fairness?.tolerance ?? settings.tolerance,
    fairness: (fairness?.teams ?? []).map((team) => ({
      team: team.team,
      negative: team.negative_load,
      share: team.fair_share,
      over: team.over_cap,
    })),
    proposals: rows.map(panelRow),
    stakeholderNames,
    now: deps.now(),
  });
}

function panelRow(row: ConsoleProposal) {
  return {
    id: row.id,
    seq: row.seq,
    minute: row.minute,
    status: row.status,
    reason: row.reason,
    autoPublishAt: row.autoPublishAt,
    proposal: row.proposal,
    guardrails: row.guardrails,
    consistencyStatus: row.consistencyStatus,
  };
}

async function patchConsole(
  deps: DirectorCommandDeps,
  sessionId: string,
  _actorId: string,
  body: { mode?: DirectorMode; pause?: boolean },
): Promise<CommandResult> {
  const settings = deps.settings();
  if (!settings.enabled) return fail(409, 'AI director is off');
  const session = await deps.loadSession(sessionId);
  if (session === 'missing') return fail(503, 'AI director is not available');
  if (!session) return fail(404, 'Session not found');
  if (body.pause != null) setDirectorPaused(sessionId, body.pause);
  if (body.mode) {
    if (!modeWithinCeiling(body.mode, settings.modeMax)) {
      return fail(422, `Mode ${body.mode} is above DIRECTOR_MODE_MAX`);
    }
    const scenarioMode = await deps.scenarioMode(session.scenarioId);
    const from = resolveDirectorMode(
      settings,
      { mode: session.directorMode },
      { mode: scenarioMode },
    );
    const saved = await deps.setSessionMode(sessionId, body.mode);
    if (saved === 'missing') return fail(503, 'AI director is not available');
    if (saved === 'error') return fail(503, 'Director mode was not saved');
    const to = resolveDirectorMode(settings, { mode: body.mode }, { mode: scenarioMode });
    const effect = modeSwitchEffect(from, to);
    if (effect === 'expire_pending') {
      const ids = await deps.expirePending(sessionId);
      if (ids === 'missing') return fail(503, 'AI director is not available');
      for (const id of ids) {
        noteProposalSettled(sessionId);
        deps.emit(session.trainerId, 'director.expired', { session_id: sessionId, proposal_id: id });
      }
    } else if (effect === 'convert_countdowns') {
      const ids = await deps.convertCountdowns(sessionId);
      if (ids === 'missing') return fail(503, 'AI director is not available');
    }
  }
  return getConsole(deps, sessionId);
}

async function approveProposal(
  deps: DirectorCommandDeps,
  sessionId: string,
  proposalId: string,
  actorId: string,
  edits: ApproveEdits,
): Promise<CommandResult> {
  const rows = await deps.listProposals(sessionId);
  if (rows === 'missing') return fail(503, 'AI director is not available');
  const row = rows.find((item) => item.id === proposalId);
  if (!row || !row.proposal) return fail(404, 'Proposal not found');
  if (row.status !== 'proposed') return fail(409, 'Proposal is no longer pending');
  const settings = deps.settings();
  const nowMs = deps.now().getTime();
  const expired = row.autoPublishAt
    ? countdownIsStale(row.autoPublishAt, nowMs, settings.graceSeconds, settings.ttlMinutes)
    : suggestionExpiresAt(row.createdAt, settings.ttlMinutes) <= nowMs;
  if (expired) return fail(409, 'This suggestion has expired');
  const live = await deps.resolvedMode(sessionId);
  if (live === 'missing') return fail(503, 'AI director is not available');
  if (live === 'off') return fail(409, 'AI director is off');
  const session = await deps.loadSession(sessionId);
  if (session === 'missing') return fail(503, 'AI director is not available');
  if (!session) return fail(404, 'Session not found');
  const edited = applyEdits(row.proposal, edits);
  const changed = JSON.stringify(edited) !== JSON.stringify(row.proposal);
  if (changed && row.autoPublishAt) {
    await deps.updateProposal(proposalId, 'proposed', { autoPublishAt: null });
    row.autoPublishAt = null;
  }
  const facts = await deps.publishFacts(sessionId, session.elapsedMinutes);
  if (!facts) return fail(503, 'AI director could not read the session');
  const override = Boolean(edits.fairness_override_reason?.trim());
  const guard: GuardContext = {
    ...facts.guard,
    mode: row.mode === 'auto' ? 'auto' : 'suggest',
    minute: session.elapsedMinutes,
    protectedTeams: [
      ...facts.guard.protectedTeams,
      ...snoozedTeams(sessionId, deps.now().getTime()),
    ],
  };
  const report = checkProposal(edited, guard, {
    skipConsistency: true,
    fairnessOverride: override,
  });
  if (!report.ok) return fail(422, report.failure?.detail ?? 'Proposal failed a guardrail');
  const parsed = edited as ParsedProposal;
  const blocked = crossTeamBlock(deps, row, parsed, facts, session.elapsedMinutes);
  if (blocked) return fail(409, blocked);
  if (!takePublishSlot(sessionId)) return fail(409, 'The publish cap for this tick is full');
  const status = changed ? 'edited' : 'approved';
  const claimed = await deps.updateProposal(proposalId, 'proposed', {
    status,
    proposal: parsed,
    guardrails: report.results,
    decidedBy: actorId,
    decidedAt: deps.now().toISOString(),
    fairnessOverride: override,
    editBefore: changed ? row.proposal : null,
    editAfter:
      changed || override
        ? { ...parsed, fairness_override_reason: edits.fairness_override_reason ?? null }
        : null,
    reason: row.reason,
  });
  if (claimed === 'missing') return fail(503, 'AI director is not available');
  if (claimed === 'lost') return fail(409, 'Proposal is no longer pending');
  const published = await commitPublish(deps, {
    row: { ...row, proposal: parsed, mode: row.mode },
    session,
    actorId,
    status,
    facts,
    minute: session.elapsedMinutes,
  });
  if (!published.ok) return published;
  return ok({ id: proposalId, status, inject_id: published.injectId });
}

async function vetoProposal(
  deps: DirectorCommandDeps,
  sessionId: string,
  proposalId: string,
  actorId: string,
  reason?: string,
): Promise<CommandResult> {
  const session = await deps.loadSession(sessionId);
  if (session === 'missing') return fail(503, 'AI director is not available');
  if (!session) return fail(404, 'Session not found');
  const claimed = await deps.updateProposal(proposalId, 'proposed', {
    status: 'vetoed',
    decidedBy: actorId,
    decidedAt: deps.now().toISOString(),
    vetoReason: reason ?? null,
    autoPublishAt: null,
  });
  if (claimed === 'missing') return fail(503, 'AI director is not available');
  if (claimed === 'lost') return fail(409, 'Proposal is no longer pending');
  noteProposalSettled(sessionId);
  deps.emit(session.trainerId, 'director.rejected', {
    session_id: sessionId,
    proposal_id: proposalId,
    reason: reason ?? 'vetoed',
  });
  return ok({ id: proposalId, status: 'vetoed' });
}

async function requestDirector(
  deps: DirectorCommandDeps,
  sessionId: string,
  actorId: string,
  body: { team?: string; hint?: string },
): Promise<CommandResult> {
  const mode = await deps.resolvedMode(sessionId);
  if (mode === 'missing') return fail(503, 'AI director is not available');
  if (mode === 'off') return fail(409, 'AI director is off');
  return deps.requestWake(sessionId, actorId, body);
}

async function holdProposal(
  deps: DirectorCommandDeps,
  sessionId: string,
  proposalId: string,
): Promise<CommandResult> {
  const mode = await deps.resolvedMode(sessionId);
  if (mode === 'missing') return fail(503, 'AI director is not available');
  if (mode === 'off') return fail(409, 'AI director is off');
  const claimed = await deps.updateProposal(proposalId, 'proposed', { autoPublishAt: null });
  if (claimed === 'missing') return fail(503, 'AI director is not available');
  if (claimed === 'lost') return fail(409, 'Proposal is no longer pending');
  return ok({ id: proposalId, held: true });
}

async function snoozeTeam(
  deps: DirectorCommandDeps,
  sessionId: string,
  body: { team: string; minutes?: number },
): Promise<CommandResult> {
  const session = await deps.loadSession(sessionId);
  if (session === 'missing') return fail(503, 'AI director is not available');
  if (!session) return fail(404, 'Session not found');
  const team = body.team.trim();
  if (!team) return fail(422, 'Team is required');
  const minutes = body.minutes ?? 10;
  addSnooze(sessionId, team, minutes, deps.now().getTime());
  return ok({ team, minutes });
}

async function sweepSession(
  deps: DirectorCommandDeps,
  input: { sessionId: string; elapsedMinutes: number; trainerId: string | null; remainingCap: number },
): Promise<void> {
  if (!sweepThisTick(input.sessionId)) return;
  const mode = await deps.resolvedMode(input.sessionId);
  if (mode === 'missing') return;
  if (mode === 'off') {
    await expirePending(deps, input.sessionId, input.trainerId);
    return;
  }
  if (mode === 'suggest') await deps.convertCountdowns(input.sessionId);
  armPublishSlots(input.sessionId, input.remainingCap);
  const now = deps.now();
  const ttl = deps.settings().ttlMinutes;
  const createdBefore = new Date(now.getTime() - ttl * 60_000).toISOString();
  const due = await deps.dueProposals(input.sessionId, now.toISOString(), createdBefore);
  if (due === 'missing' || due.length === 0) return;
  const session = await deps.loadSession(input.sessionId);
  if (session === 'missing' || session == null) return;
  const facts = await deps.publishFacts(input.sessionId, input.elapsedMinutes);
  if (!facts) return;
  const trainerId = session.trainerId ?? input.trainerId;
  for (const row of due) {
    try {
      await sweepOne(deps, row, { ...input, trainerId, now, ttl, mode, session, facts });
    } catch (err) {
      await deps.updateProposal(row.id, 'auto_published', { status: 'failed' }).catch(() => 'lost');
      await deps.updateProposal(row.id, 'proposed', { status: 'failed' }).catch(() => 'lost');
      noteProposalSettled(input.sessionId);
      logger.warn({ err, proposalId: row.id }, 'director publish failed');
    }
  }
}

async function expirePending(
  deps: DirectorCommandDeps,
  sessionId: string,
  trainerId: string | null,
): Promise<void> {
  const ids = await deps.expirePending(sessionId);
  if (ids === 'missing') return;
  for (const id of ids) {
    noteProposalSettled(sessionId);
    deps.emit(trainerId, 'director.expired', { session_id: sessionId, proposal_id: id });
  }
}

async function sweepOne(
  deps: DirectorCommandDeps,
  row: ConsoleProposal,
  input: {
    sessionId: string;
    elapsedMinutes: number;
    trainerId: string | null;
    now: Date;
    ttl: number;
    mode: DirectorMode;
    session: SessionDirector;
    facts: PublishFacts;
  },
): Promise<void> {
  const kind = dueKind(row, input.now.getTime(), input.ttl);
  if (kind === 'wait' || !row.proposal) return;
  const settings = deps.settings();
  if (
    row.autoPublishAt &&
    countdownIsStale(row.autoPublishAt, input.now.getTime(), settings.graceSeconds, settings.ttlMinutes)
  ) {
    await settle(deps, row, input.trainerId, 'expired', 'Countdown expired before it could publish');
    return;
  }
  if (kind === 'expire' || input.mode === 'suggest') {
    if (kind === 'expire' || suggestionExpiresAt(row.createdAt, input.ttl) <= input.now.getTime()) {
      await settle(deps, row, input.trainerId, 'expired', 'Suggestion expired');
    }
    return;
  }
  if (directorIsPaused(input.sessionId)) {
    await settle(deps, row, input.trainerId, 'expired', 'Countdown ended while the director was paused');
    return;
  }
  const guard: GuardContext = { ...input.facts.guard, mode: 'auto', minute: input.elapsedMinutes };
  const report = checkProposal(row.proposal, guard, { only: PUBLISH_GUARDS });
  if (!report.ok) {
    await settle(
      deps,
      row,
      input.trainerId,
      'rejected_guardrail',
      report.failure?.detail ?? 'Guardrail failed at publish',
      report.results,
    );
    return;
  }
  const blocked = crossTeamBlock(deps, row, row.proposal, input.facts, input.elapsedMinutes);
  if (blocked === 'cascade_cap') {
    await settle(deps, row, input.trainerId, 'rejected_guardrail', blocked);
    return;
  }
  if (blocked) return;
  if (!takePublishSlot(input.sessionId)) return;
  const claimed = await deps.updateProposal(row.id, 'proposed', {
    status: 'auto_published',
    decidedAt: input.now.toISOString(),
    guardrails: report.results,
  });
  if (claimed !== 'updated') return;
  const published = await commitPublish(deps, {
    row,
    session: input.session,
    actorId: null,
    status: 'auto_published',
    facts: input.facts,
    minute: input.elapsedMinutes,
  });
  if (published.ok && row.proposal) {
    input.facts.guard.capEvents.push(
      ...publishedCapEvents([
        { status: 'auto_published', minute: input.elapsedMinutes, proposal: row.proposal },
      ]),
    );
  }
}

async function settle(
  deps: DirectorCommandDeps,
  row: ConsoleProposal,
  trainerId: string | null,
  status: 'expired' | 'rejected_guardrail',
  reason: string,
  guardrails?: GuardrailResult[],
): Promise<void> {
  const claimed = await deps.updateProposal(row.id, 'proposed', {
    status,
    reason,
    ...(guardrails ? { guardrails } : {}),
    autoPublishAt: null,
    decidedAt: deps.now().toISOString(),
  });
  if (claimed !== 'updated') return;
  noteProposalSettled(row.sessionId);
  deps.emit(trainerId, status === 'expired' ? 'director.expired' : 'director.rejected', {
    session_id: row.sessionId,
    proposal_id: row.id,
    seq: row.seq,
    reason,
  });
}

async function commitPublish(
  deps: DirectorCommandDeps,
  input: {
    row: ConsoleProposal;
    session: SessionDirector;
    actorId: string | null;
    status: string;
    facts: PublishFacts;
    minute: number;
  },
): Promise<{ ok: true; injectId: string } | { ok: false; status: number; error: string }> {
  const proposal = input.row.proposal;
  if (!proposal) return fail(422, 'Proposal is empty');
  const mode = input.row.mode === 'auto' ? 'auto' : 'suggest';
  const draft = buildDirectorInject({
    scenarioId: input.facts.scenarioId,
    sessionId: input.session.id,
    proposalId: input.row.id,
    seq: input.row.seq,
    minute: input.minute,
    mode,
    approvedBy: input.actorId,
    proposal,
    signals: input.row.signals,
    triggersByKey: input.facts.triggersByKey,
    people: input.facts.people,
    npcs: input.facts.npcs,
  });
  const inserted = await deps.insertInject(draft.row);
  if (!inserted) {
    await deps.updateProposal(input.row.id, input.status, { status: 'proposed', injectId: null });
    return fail(503, 'Could not create the inject');
  }
  const userId = input.actorId ?? input.session.trainerId ?? input.session.id;
  try {
    await deps.publishInject(inserted.id, input.session.id, userId);
    await deps.recordTrigger({
      sessionId: input.session.id,
      injectId: inserted.id,
      origin: 'director',
      minute: input.minute,
      injectKey: draft.injectKey,
      metKeys: draft.metKeys,
      keyDetails: input.row.signals.flatMap((signal) =>
        signal.keys.map((key) => ({
          key,
          label: signal.kind,
          detail: signal.detail,
          teams: [signal.team],
        })),
      ),
      sourceTeams: draft.sourceTeams,
      targetTeams: draft.targetTeams,
      causeDepth: draft.causeDepth,
      parentInjectKeys: draft.parentInjectKeys,
    });
  } catch (err) {
    await deps.updateProposal(input.row.id, input.status, {
      status: 'failed',
      injectId: inserted.id,
    });
    noteProposalSettled(input.session.id);
    logger.warn({ err, proposalId: input.row.id }, 'director inject publish failed');
    return fail(503, 'Publishing the inject failed');
  }
  await deps.updateProposal(input.row.id, input.status, { injectId: inserted.id });
  noteProposalSettled(input.session.id);
  deps.emit(input.session.trainerId, 'director.published', {
    session_id: input.session.id,
    proposal_id: input.row.id,
    inject_id: inserted.id,
    seq: input.row.seq,
    status: input.status,
  });
  return { ok: true, injectId: inserted.id };
}

function crossTeamBlock(
  deps: DirectorCommandDeps,
  row: ConsoleProposal,
  proposal: ParsedProposal,
  facts: PublishFacts,
  minute: number,
): string | null {
  const draft = buildDirectorInject({
    scenarioId: facts.scenarioId,
    sessionId: row.sessionId,
    proposalId: row.id,
    seq: row.seq,
    minute,
    mode: row.mode === 'auto' ? 'auto' : 'suggest',
    approvedBy: null,
    proposal,
    signals: row.signals,
    triggersByKey: facts.triggersByKey,
    people: facts.people,
    npcs: facts.npcs,
  });
  const decision = applyCrossTeamGuards(
    [
      {
        id: row.id,
        inject_key: draft.injectKey,
        severity: proposal.severity,
        minute,
        source_teams: draft.sourceTeams,
        target_teams: draft.targetTeams,
        origin: 'director',
        cause_depth: draft.causeDepth,
        timed: false,
        met_keys: draft.metKeys,
      },
    ],
    facts.recent,
    facts.deliveries,
    deps.settings().crossTeam,
  );
  if (decision.publish.length > 0) return null;
  if (decision.cancel.length > 0) return 'cascade_cap';
  if (decision.hold.length > 0) return 'Cross-team loop held this event';
  return decision.defer[0]?.reason === 'pressure'
    ? 'The team is at the pressure ceiling'
    : 'The team is at the cross-team limit';
}

function dueKind(row: ConsoleProposal, nowMs: number, ttlMinutes: number): 'publish' | 'expire' | 'wait' {
  if (row.status !== 'proposed') return 'wait';
  if (row.autoPublishAt) {
    const at = Date.parse(row.autoPublishAt);
    return Number.isFinite(at) && at <= nowMs ? 'publish' : 'wait';
  }
  return suggestionExpiresAt(row.createdAt, ttlMinutes) <= nowMs ? 'expire' : 'wait';
}

function applyEdits(base: ParsedProposal, edits: ApproveEdits): ParsedProposal {
  return {
    ...base,
    ...(edits.title != null ? { title: edits.title } : {}),
    ...(edits.content != null ? { content: edits.content } : {}),
    ...(edits.target_teams != null ? { target_teams: edits.target_teams } : {}),
    ...(edits.app != null ? { app: edits.app } : {}),
    ...(edits.severity != null ? { severity: edits.severity } : {}),
    ...(edits.response_rubric !== undefined ? { response_rubric: edits.response_rubric } : {}),
  };
}

function ok(body: unknown): CommandResult {
  return { ok: true, status: 200, body: { data: body } };
}

function fail(status: number, error: string): { ok: false; status: number; error: string } {
  return { ok: false, status, error };
}

export function proposalNeedsCountdown(
  mode: 'suggest' | 'auto' | null,
  severity: ParsedProposal['severity'] | null,
  autoMax: DirectorSeverity,
): boolean {
  if (mode !== 'auto' || !severity) return false;
  return !needsTrainerApproval(mode, severity, autoMax);
}
