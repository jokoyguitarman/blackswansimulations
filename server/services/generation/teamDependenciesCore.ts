/**
 * Pure dependency-map post-processing. No database and no network.
 * The model picks signal templates; this module turns them into condition
 * keys, team refs and consequence injects.
 */

import { logger } from '../../lib/logger.js';
import { allocateInjectKey, isValidInjectKey } from '../../lib/injectKey.js';
import { CATALOG_ACTION_TYPES, parseConditionKey } from '../conditions/conditionCatalog.js';
import { DECISION_CATEGORIES } from '../decisions/decisionTypes.js';
import { isDeliveryApp, typeForApp, type DeliveryApp } from './responseBranchesCore.js';
import { readAuthoredRubric } from '../judging/judgeCore.js';
import { slugifyTeamName } from '../../../shared/conditionKeyGrammar.js';
import { dependencyEdgeBudget, dependencyMapCallCount } from '../../../shared/buildEstimate.js';
import {
  DEPENDENCY_ID,
  DEPENDENCY_KINDS,
  DEPENDENCY_SEVERITIES,
  consequenceInjectDraft,
  matchTeamRef,
  sameTeam,
  type DependencyKind,
  type DependencySeverity,
  type TeamDependencyEdge,
  type TeamRef,
} from '../../../shared/teamDependencies.js';
import type { SocialInject } from '../socialCrisisGeneratorService.js';

/** Generated lag is clamped to this range (authored edges may use 0–30). */
const LAG_MIN = 2;
const LAG_MAX = 15;
const LAG_DEFAULT = 5;
const REPLY_MINUTES_MIN = 1;
const REPLY_MINUTES_MAX = 240;
const REPLY_MINUTES_DEFAULT = 10;
const SILENT_MINUTES_MIN = 5;
const SILENT_MINUTES_MAX = 60;
const SILENT_MINUTES_DEFAULT = 10;
const CONTENT_SCORE_DEFAULT = 45;
const ASK_MINUTE_DEFAULT = 12;
const INTEL_TRIGGER_DEFAULT = 8;
const INTEL_WINDOW_DEFAULT = 10;

export const SIGNAL_TEMPLATES = [
  'no_reply',
  'poor_reply',
  'duty_missed',
  'silent',
  'content_failed',
  'decision',
  'restraint_action',
  'intel',
] as const;

export type SignalTemplateName = (typeof SIGNAL_TEMPLATES)[number];

const PUBLIC_APPS = new Set(['social_feed', 'news']);
const ASK_APPS = new Set<DeliveryApp>(['email', 'group_chat', 'phone_call']);
const INJECT_KEY_TEMPLATES = new Set<SignalTemplateName>(['no_reply', 'poor_reply']);

const ACTION_TYPES = new Set<string>(CATALOG_ACTION_TYPES);
const DECISION_SET = new Set<string>(DECISION_CATEGORIES);

export interface GenerationTeam {
  team_name: string;
  team_uid?: string | null;
  org_key?: string | null;
  org_name?: string | null;
  function_name?: string | null;
  mission?: string | null;
  /** Omitted means playable. */
  playable?: boolean;
  /**
   * Charter duties. `undefined` means the caller did not supply a roster, so a
   * `duty_missed` action id is kept. An array is authoritative.
   */
  duties?: readonly TeamDuty[];
}

export interface TeamDuty {
  action_id: string;
  timing_benchmark_minutes?: number | null;
}

export interface KnownInject {
  inject_key?: string | null;
  title?: string | null;
  trigger_time_minutes?: number | null;
}

export interface DependencyBudget {
  /** Max edges in which one team is downstream. */
  upstreamPerTeam: number;
  /** Max edges kept. Defaults to ceil(1.5 × playable teams). */
  maxEdges?: number;
}

export interface PostProcessDependenciesResult {
  edges: TeamDependencyEdge[];
  asks: SocialInject[];
  consequences: SocialInject[];
  positives: SocialInject[];
  dropped: Array<{ id?: string; reason: string }>;
}

export interface IntelRegistrationItem {
  intel_key: string;
  holder_team: string;
  needed_by: readonly string[];
  trigger_time_minutes?: number | null;
  deadline_minutes?: number | null;
  summary?: string | null;
}

export interface MapCallPlan {
  kind: 'all' | 'intra' | 'cross';
  orgKey: string | null;
  orgName: string | null;
  teams: GenerationTeam[];
}

export interface TeamNaming {
  namesTeam: boolean;
  matches: string[];
}

/** Lines the map prompt may quote. Syntax only; the model fills the blanks. */
export function signalTemplatePrompt(): string {
  return [
    'no_reply + inject_key + minutes → unresponded:<inject_key>:<minutes>|team=@upstream (met by a relevant reply)',
    'poor_reply + inject_key → reply_failed:<inject_key>|team=@upstream (met when a reply passes)',
    'duty_missed + action_id → duty_missed:<action_id>|team=@upstream (met when the duty is done)',
    'silent + minutes → team_silent:<minutes>|team=@upstream (minutes from 5 to 60)',
    'content_failed + n + score → content_failed:<n>:<score>|team=@upstream',
    'decision + category → decision_made:<category>|team=@upstream (category: workforce, operations, public_position, legal_action, commercial, governance, other)',
    'restraint_action + action_type + count → action_count_gte:<action_type>:<count>|team=@upstream',
    'intel + intel_key → intel_missing:<intel_key> (met by intel_shared:<intel_key>; no team scope)',
    'A signal may set "scope" to "@downstream" when the reply belongs to a downstream team.',
  ].join('\n');
}

/**
 * One map call at or below the batch size. Above it, one call per organisation
 * that has at least two playable teams, plus one cross-organisation call.
 */
export function planDependencyMapCalls(
  teams: readonly GenerationTeam[],
  batchTeams: number,
): MapCallPlan[] {
  const playable = teams.filter((team) => team.playable !== false && team.team_name.trim());
  if (playable.length < 2) return [];
  const batch = Math.max(1, Math.floor(batchTeams));
  const orgCount = new Set(playable.map((team) => team.org_key || team.org_name || '_scenario'))
    .size;
  if (dependencyMapCallCount(playable.length, orgCount, batch) <= 1) {
    return [{ kind: 'all', orgKey: null, orgName: null, teams: [...playable] }];
  }
  const groups = new Map<string, GenerationTeam[]>();
  for (const team of playable) {
    const key = team.org_key || team.org_name || '_scenario';
    const list = groups.get(key) ?? [];
    list.push(team);
    groups.set(key, list);
  }
  const intra = [...groups.entries()].filter(([, list]) => list.length >= 2);
  if (intra.length === 0 || groups.size < 2) {
    return [{ kind: 'all', orgKey: null, orgName: null, teams: [...playable] }];
  }
  const plans: MapCallPlan[] = intra.map(([key, list]) => ({
    kind: 'intra' as const,
    orgKey: key,
    orgName: list[0]?.org_name || key,
    teams: list,
  }));
  plans.push({ kind: 'cross', orgKey: null, orgName: null, teams: [...playable] });
  return plans;
}

export function dependencyEdgeSummary(edges: readonly TeamDependencyEdge[]): string {
  return edges
    .map((edge) => {
      const down = edge.downstream.map((team) => team.team_name).join(', ');
      return `${edge.upstream.team_name} → ${down}: ${edge.deliverable} (${edge.kind}, lag ${edge.lag_minutes})`;
    })
    .join('\n');
}

/**
 * Public channels (social_feed, news) must not name a team. Internal channels may.
 * A multi-word or distinctive name matches in full, case-insensitively, on a word
 * boundary. A single generic word such as "Operations" matches only in a possessive
 * or as "the Operations team", so ordinary prose does not drop the consequence.
 */
export function checkTeamNaming(
  inject: {
    title?: string | null;
    content?: string | null;
    app?: string | null;
    delivery_config?: { app?: unknown } | null;
  },
  teamNames: readonly string[],
): TeamNaming {
  const app = text(inject.app) ?? text(inject.delivery_config?.app);
  if (!app || !PUBLIC_APPS.has(app)) return { namesTeam: false, matches: [] };
  const haystack = `${inject.title ?? ''}\n${inject.content ?? ''}`;
  const matches = teamNames.filter((name) => nameMentions(haystack, name));
  return { namesTeam: matches.length > 0, matches };
}

export function postProcessDependencies(
  model: unknown,
  teams: readonly GenerationTeam[],
  injects: readonly KnownInject[],
  durationMinutes: number,
  budget: Partial<DependencyBudget> = {},
  stakeholders?: readonly ConsequenceStakeholder[],
): PostProcessDependenciesResult {
  const duration = finiteMinutes(durationMinutes, 60);
  const playable = teams.filter((team) => team.playable !== false && team.team_name.trim());
  const upstreamCap = Math.max(1, Math.floor(budget.upstreamPerTeam ?? 3));
  const maxEdges = Math.max(
    0,
    Math.floor(budget.maxEdges ?? dependencyEdgeBudget(playable.length, upstreamCap)),
  );
  const known = new Map<string, KnownInject>();
  for (const inject of injects) {
    const key = text(inject.inject_key);
    if (key && isValidInjectKey(key) && !known.has(key)) known.set(key, inject);
  }
  const takenIds = new Set<string>();
  const takenInjectKeys = new Set<string>(known.keys());
  const dropped: PostProcessDependenciesResult['dropped'] = [];
  const record = asRecord(model);
  const rawEdges = Array.isArray(record?.edges) ? record.edges : [];
  const drafted: Array<{ edge: TeamDependencyEdge; ask: SocialInject | null }> = [];

  for (const raw of rawEdges) {
    const built = buildEdge(raw, playable, known, takenIds, takenInjectKeys, duration, dropped);
    if (built) drafted.push(built);
  }

  const selected = selectEdges(drafted, playable, upstreamCap, maxEdges, dropped);
  const asks = selected.flatMap((item) => (item.ask ? [item.ask] : []));
  const consequences: SocialInject[] = [];
  const positives: SocialInject[] = [];
  for (const item of selected) {
    const built = buildConsequenceInjects(item.edge, model, takenInjectKeys, stakeholders);
    item.edge.consequence_keys = built.consequences.flatMap((inject) => {
      const key = inject.delivery_config.inject_key;
      return key ? [key] : [];
    });
    consequences.push(...built.consequences);
    positives.push(...built.positives);
  }
  return { edges: selected.map((item) => item.edge), asks, consequences, positives, dropped };
}

export interface ConsequenceStakeholder {
  id: string;
  name?: string | null;
}

export function buildConsequenceInjects(
  edge: TeamDependencyEdge,
  model: unknown,
  taken: Set<string> = new Set(),
  stakeholders?: readonly ConsequenceStakeholder[],
): { consequences: SocialInject[]; positives: SocialInject[] } {
  const record = asRecord(model);
  const rows = Array.isArray(record?.consequences) ? record.consequences : [];
  const positiveRows = Array.isArray(record?.positives) ? record.positives : [];
  const layer = `dependency:${edge.id}`;
  const consequences: SocialInject[] = [];
  const seenDown = new Set<string>();
  for (const raw of rows) {
    const row = asRecord(raw);
    if (!row || !sameEdge(row.edge_id, edge.id)) continue;
    const downstream = matchRef(text(row.downstream) ?? '', edge.downstream);
    if (!downstream || seenDown.has(downstream.team_name)) continue;
    const content = text(row.content);
    if (!content) continue;
    seenDown.add(downstream.team_name);
    const title = text(row.title) || `${edge.deliverable} (${downstream.team_name})`;
    const app = consequenceApp(row.app, row.sender, stakeholders);
    const injectKey = allocateInjectKey(text(row.inject_key), title, taken);
    const rubric = readAuthoredRubric(row.response_rubric);
    const { trigger_time_minutes: _minute, ...drafted } = consequenceInjectDraft({
      edge,
      team: downstream.team_name,
      injectKey,
      title,
      content,
    });
    consequences.push({
      ...drafted,
      type: typeForApp(app),
      severity: severityOf(row.severity, edge.severity),
      requires_response: row.requires_response === true,
      gen_layer: layer,
      delivery_config: {
        ...drafted.delivery_config,
        app,
        gen: { layer },
        ...senderFields(row.sender, stakeholders),
        ...(rubric ? { response_rubric: rubric } : {}),
      },
    });
  }
  const positives: SocialInject[] = [];
  for (const raw of positiveRows) {
    const row = asRecord(raw);
    if (!row || !sameEdge(row.edge_id, edge.id)) continue;
    const content = text(row.content);
    if (!content) continue;
    const downstream = matchRef(text(row.downstream) ?? '', edge.downstream) ?? edge.downstream[0];
    if (!downstream) continue;
    const title = text(row.title) || `${edge.deliverable} delivered`;
    const app = consequenceApp(row.app, row.sender, stakeholders);
    const injectKey = allocateInjectKey(text(row.inject_key), title, taken);
    const {
      conditions_to_cancel: _cancel,
      trigger_time_minutes: _minute,
      ...positive
    } = consequenceInjectDraft({
      edge,
      team: downstream.team_name,
      injectKey,
      title,
      content,
    });
    positives.push({
      ...positive,
      type: typeForApp(app),
      severity: severityOf(row.severity, 'low'),
      requires_response: false,
      conditions_to_appear: { all: [`dependency_met:${edge.id}`] },
      gen_layer: layer,
      delivery_config: {
        ...positive.delivery_config,
        app,
        gen: { layer },
        ...senderFields(row.sender, stakeholders),
      },
    });
    break;
  }
  return { consequences, positives };
}

/**
 * Intel items become ordinary information edges. The intel gates themselves
 * are not part of this result and are left unchanged. Holder and needed-by
 * teams are resolved on the playable roster when one is supplied; an item
 * that does not resolve is skipped.
 */
export function registerIntelEdges(
  items: readonly IntelRegistrationItem[],
  takenIds: ReadonlySet<string> = new Set(),
  teams?: readonly GenerationTeam[],
  durationMinutes?: number,
): TeamDependencyEdge[] {
  const taken = new Set(takenIds);
  const playable = teams?.filter((team) => team.playable !== false && team.team_name.trim());
  const duration =
    typeof durationMinutes === 'number' && Number.isFinite(durationMinutes) && durationMinutes > 0
      ? Math.floor(durationMinutes)
      : null;
  const edges: TeamDependencyEdge[] = [];
  for (const item of items) {
    const key = slugKey(item.intel_key);
    const holderName = text(item.holder_team);
    if (!key || !holderName) continue;
    const holder = playable ? resolveTeam(holderName, playable) : null;
    if (playable && !holder) {
      logger.warn(
        { event: 'intel_dependency_skipped', intel_key: key, holder: holderName },
        'Skipped an intel dependency whose holder is not a playable team',
      );
      continue;
    }
    const neededNames = [
      ...new Set(item.needed_by.map((name) => text(name)).filter((name): name is string => !!name)),
    ];
    const downstream: TeamRef[] = [];
    for (const name of neededNames) {
      if (playable) {
        const team = resolveTeam(name, playable);
        if (!team || (holder && teamIdentity(teamRef(team)) === teamIdentity(teamRef(holder))))
          continue;
        downstream.push(teamRef(team));
      } else if (!sameTeam(name, holderName)) {
        downstream.push(refOf(name));
      }
      if (downstream.length === 3) break;
    }
    if (downstream.length === 0) {
      if (playable) {
        logger.warn(
          { event: 'intel_dependency_skipped', intel_key: key, holder: holderName },
          'Skipped an intel dependency with no playable downstream team',
        );
      }
      continue;
    }
    const id = allocateDependencyId(`dep_intel_${key}`, `intel ${key}`, taken);
    if (!id) continue;
    const trigger = finiteMinutes(item.trigger_time_minutes, INTEL_TRIGGER_DEFAULT);
    const deadline = finiteMinutes(item.deadline_minutes, trigger + INTEL_WINDOW_DEFAULT);
    const lag = clampInt(deadline - trigger, LAG_MIN, LAG_MAX, LAG_DEFAULT);
    const summary = text(item.summary) || `Fact ${key} reaches the teams that need it`;
    const dueMinute =
      duration == null ? Math.max(0, deadline) : clampInt(deadline, 0, duration, deadline);
    edges.push({
      id,
      kind: 'information',
      upstream: holder ? teamRef(holder) : refOf(holderName),
      downstream,
      deliverable: summary.slice(0, 500),
      why: summary.slice(0, 2000),
      due: { by_minute: dueMinute },
      broken_when: { all: [`intel_missing:${key}`] },
      met_when: { all: [`intel_shared:${key}`] },
      lag_minutes: lag,
      severity: 'high',
      consequence_keys: [],
      source: 'intel',
    });
  }
  return edges;
}

function buildEdge(
  raw: unknown,
  teams: readonly GenerationTeam[],
  known: ReadonlyMap<string, KnownInject>,
  takenIds: Set<string>,
  takenInjectKeys: Set<string>,
  duration: number,
  dropped: PostProcessDependenciesResult['dropped'],
): { edge: TeamDependencyEdge; ask: SocialInject | null } | null {
  const row = asRecord(raw);
  if (!row) {
    dropped.push({ reason: 'edge was not an object' });
    return null;
  }
  const upstream = resolveTeam(row.upstream, teams);
  if (!upstream || upstream.playable === false) {
    dropped.push({
      id: text(row.id) ?? undefined,
      reason: 'upstream team is unknown or not playable',
    });
    return null;
  }
  const downstream = downstreamTeams(row.downstream, teams, upstream);
  if (downstream.length === 0) {
    dropped.push({
      id: text(row.id) ?? undefined,
      reason: 'downstream team is unknown, not playable, or the same as upstream',
    });
    return null;
  }
  const deliverable = text(row.deliverable);
  if (!deliverable) {
    dropped.push({ id: text(row.id) ?? undefined, reason: 'deliverable is empty' });
    return null;
  }
  const id = allocateDependencyId(row.id, `${upstream.team_name}_${deliverable}`, takenIds);
  if (!id) {
    dropped.push({ reason: 'dependency id could not be allocated' });
    return null;
  }
  const kind = kindOf(row.kind);
  if (!kind) {
    dropped.push({ id, reason: `kind "${text(row.kind) ?? ''}" is not a dependency kind` });
    takenIds.delete(id);
    return null;
  }
  const ask = buildAsk(row.needs_ask, upstream, id, duration, takenInjectKeys);
  const knownWithAsk = new Map(known);
  const askKey = ask?.delivery_config.inject_key ?? null;
  if (ask && askKey) {
    knownWithAsk.set(askKey, {
      inject_key: askKey,
      title: ask.title,
      trigger_time_minutes: ask.trigger_time_minutes ?? null,
    });
  }
  const duties = upstream.duties;
  const signals = Array.isArray(row.signals) ? row.signals : [];
  const broken: string[] = [];
  for (const signal of signals) {
    const key = signalToKey(signal, 'broken', askKey, knownWithAsk, duties);
    if (key) broken.push(key);
  }
  if (broken.length === 0) {
    dropped.push({ id, reason: 'no usable break signal' });
    takenIds.delete(id);
    if (askKey) takenInjectKeys.delete(askKey);
    return null;
  }
  const metKey =
    row.met_signal === null
      ? null
      : row.met_signal
        ? signalToKey(row.met_signal, 'met', askKey, knownWithAsk, duties)
        : defaultMetKey(signals, askKey, knownWithAsk, duties);
  const boundKey = firstInjectKey(broken) ?? askKey;
  const due = fixDue(row.due, duration, knownWithAsk, boundKey, signalMinutes(signals));
  const edge: TeamDependencyEdge = {
    id,
    kind,
    upstream: teamRef(upstream),
    downstream: downstream.map(teamRef),
    deliverable: deliverable.slice(0, 500),
    why: (text(row.why) ?? '').slice(0, 2000),
    due,
    broken_when: broken.length === 1 ? { all: broken } : { threshold: 1, conditions: broken },
    met_when: metKey ? { all: [metKey] } : null,
    lag_minutes: clampInt(row.lag_minutes, LAG_MIN, LAG_MAX, LAG_DEFAULT),
    severity: severityOf(row.severity, 'medium'),
    consequence_keys: [],
    source: 'war_room',
  };
  return { edge, ask };
}

function selectEdges(
  drafted: Array<{ edge: TeamDependencyEdge; ask: SocialInject | null }>,
  teams: readonly GenerationTeam[],
  upstreamCap: number,
  maxEdges: number,
  dropped: PostProcessDependenciesResult['dropped'],
): Array<{ edge: TeamDependencyEdge; ask: SocialInject | null }> {
  const kept: Array<{ edge: TeamDependencyEdge; ask: SocialInject | null }> = [];
  const downCount = new Map<string, number>();
  const covered = new Set<string>();
  const canTake = (edge: TeamDependencyEdge): boolean => {
    if (kept.length >= maxEdges) return false;
    return edge.downstream.every((team) => (downCount.get(teamIdentity(team)) ?? 0) < upstreamCap);
  };
  const take = (item: { edge: TeamDependencyEdge; ask: SocialInject | null }) => {
    kept.push(item);
    for (const team of item.edge.downstream) {
      const id = teamIdentity(team);
      downCount.set(id, (downCount.get(id) ?? 0) + 1);
    }
    covered.add(teamIdentity(item.edge.upstream));
    for (const team of item.edge.downstream) covered.add(teamIdentity(team));
  };
  const deferred: typeof drafted = [];
  for (const item of drafted) {
    const names = [item.edge.upstream, ...item.edge.downstream];
    const coversNew = names.some((team) => !covered.has(teamIdentity(team)));
    if (coversNew && canTake(item.edge)) take(item);
    else deferred.push(item);
  }
  for (const item of deferred) {
    if (canTake(item.edge)) take(item);
    else {
      dropped.push({
        id: item.edge.id,
        reason:
          kept.length >= maxEdges
            ? 'edge budget is full'
            : `downstream team already has ${upstreamCap} upstream dependencies`,
      });
    }
  }
  if (teams.length >= 3) {
    const missing = teams.filter((team) => !covered.has(teamIdentity(teamRef(team))));
    for (const team of missing) {
      dropped.push({ reason: `${team.team_name} is not in any dependency` });
    }
  }
  return kept;
}

function signalToKey(
  raw: unknown,
  pole: 'broken' | 'met',
  askKey: string | null,
  known: ReadonlyMap<string, KnownInject>,
  duties?: readonly TeamDuty[],
): string | null {
  const row = asRecord(raw);
  if (!row) return null;
  const template = text(row.template);
  if (!template || !isTemplate(template)) return null;
  const scope = row.scope === '@downstream' ? '@downstream' : '@upstream';
  const suffix = template === 'intel' ? '' : `|team=${scope}`;
  const injectKey = boundInjectKey(row, template, pole, askKey, known);
  if (template === 'no_reply') {
    if (!injectKey) return null;
    if (pole === 'met') return `responded_relevant:${injectKey}${suffix}`;
    const minutes = clampInt(
      row.minutes,
      REPLY_MINUTES_MIN,
      REPLY_MINUTES_MAX,
      REPLY_MINUTES_DEFAULT,
    );
    return `unresponded:${injectKey}:${minutes}${suffix}`;
  }
  if (template === 'poor_reply') {
    if (!injectKey) return null;
    return pole === 'met'
      ? `reply_passed:${injectKey}${suffix}`
      : `reply_failed:${injectKey}${suffix}`;
  }
  if (template === 'duty_missed') {
    const action = resolveDutyId(
      slugKey(text(row.action_id) ?? text(row.inject_key) ?? ''),
      duties,
    );
    if (!action) return null;
    return pole === 'met' ? `duty_done:${action}${suffix}` : `duty_missed:${action}${suffix}`;
  }
  if (template === 'silent') {
    if (pole === 'met') return null;
    return `team_silent:${clampInt(row.minutes, SILENT_MINUTES_MIN, SILENT_MINUTES_MAX, SILENT_MINUTES_DEFAULT)}${suffix}`;
  }
  if (template === 'content_failed') {
    if (pole === 'met') return null;
    const count = clampInt(row.n ?? row.count, 1, 100, 1);
    const score = clampInt(row.score, 0, 100, CONTENT_SCORE_DEFAULT);
    return `content_failed:${count}:${score}${suffix}`;
  }
  if (template === 'decision') {
    if (pole === 'met') return null;
    const category = text(row.category);
    if (!category || !DECISION_SET.has(category)) return null;
    return `decision_made:${category}${suffix}`;
  }
  if (template === 'restraint_action') {
    if (pole === 'met') return null;
    const action = text(row.action_type) ?? text(row.inject_key);
    if (!action || !ACTION_TYPES.has(action)) return null;
    return `action_count_gte:${action}:${clampInt(row.count ?? row.n, 1, 10000, 1)}${suffix}`;
  }
  const intel = slugKey(text(row.intel_key) ?? text(row.inject_key) ?? '');
  if (!intel) return null;
  return pole === 'met' ? `intel_shared:${intel}` : `intel_missing:${intel}`;
}

function defaultMetKey(
  signals: readonly unknown[],
  askKey: string | null,
  known: ReadonlyMap<string, KnownInject>,
  duties?: readonly TeamDuty[],
): string | null {
  for (const signal of signals) {
    const key = signalToKey(signal, 'met', askKey, known, duties);
    if (key) return key;
  }
  return null;
}

/**
 * `undefined` duties means no charter was supplied. A listed roster that does
 * not contain the id is repaired to the only real duty, or dropped.
 */
function resolveDutyId(action: string, duties: readonly TeamDuty[] | undefined): string | null {
  if (!duties) return action || null;
  const ids = duties
    .map((duty) => text(duty.action_id))
    .filter((id): id is string => !!id && /^[a-z0-9_]{1,60}$/.test(id));
  const match = action ? ids.find((id) => id === action || slugKey(id) === action) : undefined;
  if (match) return match;
  if (ids.length === 1) return ids[0];
  return null;
}

function boundInjectKey(
  row: Record<string, unknown>,
  template: SignalTemplateName,
  pole: 'broken' | 'met',
  askKey: string | null,
  known: ReadonlyMap<string, KnownInject>,
): string | null {
  const stated = text(row.inject_key);
  const valid = stated && isValidInjectKey(stated) ? stated : null;
  if (askKey && INJECT_KEY_TEMPLATES.has(template)) {
    if (pole === 'broken') return askKey;
    if (!valid || !known.has(valid)) return askKey;
  }
  if (valid && known.has(valid)) return valid;
  return null;
}

function buildAsk(
  raw: unknown,
  upstream: GenerationTeam,
  depId: string,
  duration: number,
  taken: Set<string>,
): SocialInject | null {
  if (raw == null) return null;
  const row = asRecord(raw);
  if (!row) return null;
  const content = text(row.content);
  const title = text(row.title);
  if (!content || !title) return null;
  const requested = text(row.app);
  const app: DeliveryApp =
    requested && isDeliveryApp(requested) && ASK_APPS.has(requested) ? requested : 'email';
  const injectKey = allocateInjectKey(null, title, taken);
  const trigger = clampInt(
    row.trigger_time_minutes,
    1,
    Math.max(1, duration),
    Math.min(ASK_MINUTE_DEFAULT, duration),
  );
  const layer = `dependency:${depId}`;
  return {
    trigger_time_minutes: trigger,
    type: typeForApp(app),
    title,
    content,
    severity: 'medium',
    inject_scope: 'team_specific',
    target_teams: [upstream.team_name],
    requires_response: true,
    gen_layer: layer,
    delivery_config: {
      app,
      inject_key: injectKey,
      gen: { layer },
    },
  };
}

function fixDue(
  raw: unknown,
  duration: number,
  known: ReadonlyMap<string, KnownInject>,
  boundKey: string | null,
  withinFallback: number,
): TeamDependencyEdge['due'] {
  const row = asRecord(raw);
  if (row && typeof row.by_minute === 'number') {
    return { by_minute: clampInt(row.by_minute, 0, duration, Math.min(20, duration)) };
  }
  const after = text(row?.after_inject_key) ?? (boundKey && known.has(boundKey) ? boundKey : null);
  if (after && isValidInjectKey(after) && known.has(after)) {
    const trigger = finiteMinutes(known.get(after)?.trigger_time_minutes, 0);
    let within = clampInt(row?.within_minutes, 0, duration, withinFallback);
    if (trigger + within > duration) within = Math.max(0, duration - trigger);
    return { after_inject_key: after, within_minutes: within };
  }
  return {
    by_minute: clampInt(row?.by_minute ?? withinFallback, 0, duration, Math.min(20, duration)),
  };
}

function downstreamTeams(
  raw: unknown,
  teams: readonly GenerationTeam[],
  upstream: GenerationTeam,
): GenerationTeam[] {
  const listed = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  const seen = new Set<string>([teamIdentity(teamRef(upstream))]);
  const kept: GenerationTeam[] = [];
  for (const item of listed) {
    const team = resolveTeam(item, teams);
    if (!team || team.playable === false) continue;
    const id = teamIdentity(teamRef(team));
    if (seen.has(id)) continue;
    seen.add(id);
    kept.push(team);
    if (kept.length === 3) break;
  }
  return kept;
}

function resolveTeam(raw: unknown, teams: readonly GenerationTeam[]): GenerationTeam | null {
  if (typeof raw === 'string') return matchTeamRef({ team_uid: null, team_name: raw }, teams);
  const row = asRecord(raw);
  const name = text(row?.team_name) ?? text(row?.name);
  if (!name) return null;
  return matchTeamRef({ team_uid: text(row?.team_uid), team_name: name }, teams);
}

function teamRef(team: GenerationTeam): TeamRef {
  return {
    team_uid: typeof team.team_uid === 'string' && team.team_uid ? team.team_uid : null,
    team_name: team.team_name,
  };
}

function refOf(name: string): TeamRef {
  return { team_uid: null, team_name: name };
}

function teamIdentity(ref: TeamRef): string {
  if (ref.team_uid) return `uid:${ref.team_uid}`;
  return `name:${slugifyTeamName(ref.team_name) || ref.team_name}`;
}

function matchRef(name: string, refs: readonly TeamRef[]): TeamRef | null {
  if (!name.trim()) return null;
  return matchTeamRef({ team_uid: null, team_name: name }, refs);
}

function kindOf(raw: unknown): DependencyKind | null {
  const value = text(raw);
  if (!value) return 'information';
  return (DEPENDENCY_KINDS as readonly string[]).includes(value) ? (value as DependencyKind) : null;
}

function severityOf(raw: unknown, fallback: DependencySeverity): DependencySeverity {
  const value = text(raw);
  if (value && (DEPENDENCY_SEVERITIES as readonly string[]).includes(value)) {
    return value as DependencySeverity;
  }
  return fallback;
}

function consequenceApp(
  raw: unknown,
  sender: unknown,
  stakeholders?: readonly ConsequenceStakeholder[],
): DeliveryApp {
  const value = text(raw);
  if (!value || !isDeliveryApp(value)) return 'email';
  if (value === 'npc_dm' && !stakeholderId(sender, stakeholders)) return 'email';
  return value;
}

function stakeholderId(
  sender: unknown,
  stakeholders?: readonly ConsequenceStakeholder[],
): string | null {
  const value = text(sender);
  if (!value || !stakeholders) return null;
  return stakeholders.find((stakeholder) => stakeholder.id === value)?.id ?? null;
}

function senderFields(
  raw: unknown,
  stakeholders?: readonly ConsequenceStakeholder[],
): { stakeholder_id?: string; from_name?: string } {
  const sender = text(raw);
  if (!sender) return {};
  const id = stakeholderId(sender, stakeholders);
  if (id) return { stakeholder_id: id };
  if (!stakeholders && /^stk_[a-z0-9_]{1,76}$/.test(sender)) return { stakeholder_id: sender };
  return { from_name: sender };
}

function allocateDependencyId(raw: unknown, fallback: string, taken: Set<string>): string | null {
  const source = text(raw) ?? fallback;
  let slug = source
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) return null;
  if (!slug.startsWith('dep_')) slug = `dep_${slug}`;
  slug = slug.slice(0, 60).replace(/_+$/g, '');
  if (!DEPENDENCY_ID.test(slug)) return null;
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  for (let n = 2; n < 1000; n++) {
    const suffix = `_${n}`;
    const stem = slug.slice(0, 60 - suffix.length).replace(/_+$/g, '');
    const candidate = `${stem}${suffix}`;
    if (DEPENDENCY_ID.test(candidate) && !taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  return null;
}

function firstInjectKey(keys: readonly string[]): string | null {
  for (const key of keys) {
    const parsed = parseConditionKey(key, { allowPlaceholders: true });
    if ('error' in parsed) continue;
    const params = parsed.def.params ?? [];
    for (let index = 0; index < params.length; index++) {
      const arg = parsed.args[index];
      if (params[index]?.type === 'inject_key' && arg && isValidInjectKey(arg)) return arg;
    }
  }
  return null;
}

function signalMinutes(signals: readonly unknown[]): number {
  for (const signal of signals) {
    const minutes = asRecord(signal)?.minutes;
    if (typeof minutes === 'number' && Number.isFinite(minutes))
      return Math.max(1, Math.floor(minutes));
  }
  return 10;
}

function sameEdge(raw: unknown, id: string): boolean {
  return text(raw) === id;
}

/**
 * One-word team names that are ordinary English. A public post matches them only
 * in a possessive ("Operations'") or as "the Operations team".
 * Single-word entries of GENERATOR_PRESET_FUNCTIONS belong here (Communications,
 * Legal, Executive). Add a word when a new one-word function is introduced.
 */
const GENERIC_TEAM_WORDS = new Set([
  'operations',
  'operation',
  'ops',
  'legal',
  'communications',
  'communication',
  'comms',
  'security',
  'finance',
  'financial',
  'executive',
  'executives',
  'marketing',
  'logistics',
  'sales',
  'procurement',
  'support',
  'media',
  'press',
  'hr',
  'it',
  'compliance',
  'management',
  'admin',
  'administration',
  'facilities',
  'engineering',
  'product',
  'strategy',
  'governance',
  'risk',
  'audit',
  'customer',
  'service',
  'services',
]);

function nameMentions(haystack: string, teamName: string): boolean {
  const name = teamName.trim();
  if (name.length < 2) return false;
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 1 && GENERIC_TEAM_WORDS.has(parts[0].toLowerCase())) {
    return genericTeamMention(haystack, name);
  }
  const pattern = new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(name)}([^A-Za-z0-9]|$)`, 'i');
  return pattern.test(haystack);
}

function genericTeamMention(haystack: string, name: string): boolean {
  const token = escapeRegExp(name);
  const gap = '[^A-Za-z0-9]+';
  const possessive = new RegExp(`(?:^|[^A-Za-z0-9])${token}(?:'s|')(?![A-Za-z0-9])`, 'i');
  const role = 'team|department|unit|desk|staff|office|division|function';
  const named = new RegExp(
    `(?:^|[^A-Za-z0-9])(?:the${gap})?${token}${gap}(?:${role})(?![A-Za-z0-9])`,
    'i',
  );
  const ofTeam = new RegExp(
    `(?:^|[^A-Za-z0-9])(?:${role})${gap}of${gap}${token}(?![A-Za-z0-9])`,
    'i',
  );
  return possessive.test(haystack) || named.test(haystack) || ofTeam.test(haystack);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isTemplate(value: string): value is SignalTemplateName {
  return (SIGNAL_TEMPLATES as readonly string[]).includes(value);
}

function slugKey(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug.length > 0 && slug.length <= 60 ? slug : '';
}

function finiteMinutes(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return Math.min(max, Math.max(min, fallback));
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
