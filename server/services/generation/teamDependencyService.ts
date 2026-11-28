/**
 * War Room dependency map and its consequence injects.
 * Tests pass a fake client. The default client is the shared chat client.
 */

import { logger } from '../../lib/logger.js';
import { env } from '../../env.js';
import { limitConcurrency } from '../../lib/limitConcurrency.js';
import { stampGeneratedInjectKeys } from '../../lib/injectKey.js';
import { chatJson, systemUser } from '../ai/chatClient.js';
import { CONVERGENCE_SUMMARY_MAX_CHARS } from '../convergenceSummary.js';
import type { SocialInject } from '../socialCrisisGeneratorService.js';
import {
  matchTeamRef,
  sameTeam,
  askDependencyId,
  takenDependencyIds,
  type DependencyIdSource,
  type TeamDependencies,
  type TeamDependencyEdge,
} from '../../../shared/teamDependencies.js';
import { readDependencyEdges, validateDependencies } from '../dependencies/dependencyCore.js';
import { parseConditionKey } from '../conditions/conditionCatalog.js';
import {
  buildConsequenceInjects,
  checkTeamNaming,
  dependencyEdgeSummary,
  planDependencyMapCalls,
  postProcessDependencies,
  registerIntelEdges,
  signalTemplatePrompt,
  type GenerationTeam,
  type IntelRegistrationItem,
  type KnownInject,
  type MapCallPlan,
} from './teamDependenciesCore.js';

const CROSS_ORG_EDGES_PER_ORG = 2;

export interface DependencyChatRequest {
  system: string;
  user: string;
  label: 'generator.dependencyMap' | 'generator.dependencyConsequences';
  tier: 'standard';
  json: true;
}

export interface DependencyClient {
  complete(request: DependencyChatRequest): Promise<unknown>;
}

export interface DependencyCrisis {
  crisisType: string;
  duration: number;
  context?: string;
  country?: string;
  orgName?: string;
}

export interface DependencyStakeholder {
  id: string;
  name?: string | null;
}

export interface GenerateTeamDependenciesInput {
  teams: readonly GenerationTeam[];
  crisis: DependencyCrisis;
  facts: readonly string[];
  storylines: Record<string, SocialInject[]>;
  intelItems?: readonly IntelRegistrationItem[];
  stakeholders?: readonly DependencyStakeholder[];
}

export interface GenerateTeamDependenciesOptions {
  client?: DependencyClient;
  concurrency?: number;
  mapBatchTeams?: number;
  upstreamPerTeam?: number;
  consequenceBatch?: number;
  summaryBudget?: number;
}

export interface GenerateTeamDependenciesResult {
  team_dependencies: TeamDependencies;
  consequences: SocialInject[];
  positives: SocialInject[];
  asks: SocialInject[];
  summary: string;
  mapCalls: number;
  consequenceCalls: number;
}

export interface DependencyOrgSource {
  org_key: string;
  display_name: string;
  operation?: string;
  teams: ReadonlyArray<{
    team_name: string;
    team_uid?: string;
    function_key?: string;
    description?: string;
  }>;
}

export interface DependencyCharterSource {
  team_name: string;
  mission?: string;
  function_key?: string | null;
  org_key?: string | null;
  expected_actions?: readonly unknown[] | null;
}

const defaultClient: DependencyClient = {
  async complete(request) {
    return chatJson({
      tier: 'standard',
      json: true,
      messages: systemUser(request.system, request.user),
      maxTokens: request.label === 'generator.dependencyMap' ? 4000 : 6000,
      temperature: 0.7,
      timeoutMs: 240_000,
      retry: { attempts: 3, baseDelayMs: 750 },
      growOnTruncation: true,
      label: request.label,
    });
  },
};

export function dependencyTeamsFrom(input: {
  orgs?: readonly DependencyOrgSource[];
  storylineTeams?: readonly string[];
  charters?: readonly DependencyCharterSource[];
}): GenerationTeam[] {
  const charters = new Map((input.charters ?? []).map((charter) => [charter.team_name, charter]));
  const teams: GenerationTeam[] = [];
  const seen = new Set<string>();
  const push = (team: GenerationTeam) => {
    if (!team.team_name.trim() || team.team_name === 'Shared' || seen.has(team.team_name)) return;
    seen.add(team.team_name);
    const charter = charters.get(team.team_name);
    const duties = dutiesFrom(charter?.expected_actions);
    teams.push({
      ...team,
      function_name: team.function_name || charter?.function_key || null,
      mission: team.mission || charter?.mission || null,
      org_key: team.org_key || charter?.org_key || null,
      ...(duties ? { duties } : {}),
    });
  };
  for (const org of input.orgs ?? []) {
    for (const team of org.teams) {
      push({
        team_name: team.team_name,
        team_uid: team.team_uid ?? null,
        org_key: org.org_key,
        org_name: org.display_name,
        function_name: team.function_key,
        mission: team.description,
        playable: org.operation !== 'ai',
      });
    }
  }
  if (teams.length === 0) {
    for (const name of input.storylineTeams ?? []) push({ team_name: name, playable: true });
  }
  return teams;
}

export function intelItemsFromInjects(
  intelInjects: Record<string, SocialInject[]>,
  intelGates: readonly SocialInject[] = [],
): IntelRegistrationItem[] {
  const items: IntelRegistrationItem[] = [];
  for (const [holder, injects] of Object.entries(intelInjects)) {
    for (const inject of injects) {
      const config = inject.delivery_config;
      const key = typeof config?.intel_key === 'string' ? config.intel_key : '';
      if (!key) continue;
      const needed = Array.isArray(config.intel_needed_by)
        ? config.intel_needed_by.filter((name): name is string => typeof name === 'string')
        : [];
      items.push({
        intel_key: key,
        holder_team: holder,
        needed_by: needed,
        trigger_time_minutes: inject.trigger_time_minutes ?? null,
        deadline_minutes: intelDeadline(key, intelGates),
        summary: typeof config.intel_summary === 'string' ? config.intel_summary : inject.title,
      });
    }
  }
  return items;
}

function intelDeadline(key: string, gates: readonly SocialInject[]): number | null {
  for (const gate of gates) {
    const appear = [
      ...(gate.conditions_to_appear && 'all' in gate.conditions_to_appear
        ? gate.conditions_to_appear.all
        : []),
      ...(gate.conditions_to_appear && 'conditions' in gate.conditions_to_appear
        ? (gate.conditions_to_appear.conditions ?? [])
        : []),
    ];
    const matches = appear.some((condition) => {
      const parsed = parseConditionKey(condition);
      return !('error' in parsed) && parsed.def.id === 'intel_missing' && parsed.args[0] === key;
    });
    if (matches && typeof gate.eligible_after_minutes === 'number')
      return gate.eligible_after_minutes;
  }
  return null;
}

export interface GenerateDependencyDeltaInput extends GenerateTeamDependenciesInput {
  /** Teams this edit adds. Only edges that touch one of them are kept. */
  addedTeams: readonly GenerationTeam[];
  /** Edges already on the scenario. Their ids are reserved and they count toward the cap. */
  existingEdges?: readonly TeamDependencyEdge[];
  /** Injects whose conditions or cause.dep_id already reserve a dependency id. */
  idSources?: readonly DependencyIdSource[];
}

/**
 * Map and consequence calls for a setup edit, limited to edges that touch an
 * added team. Existing edges are not sent to the consequence call.
 */
export async function generateDependencyDelta(
  input: GenerateDependencyDeltaInput,
  options: GenerateTeamDependenciesOptions = {},
): Promise<GenerateTeamDependenciesResult> {
  const added = input.addedTeams.filter((team) => team.playable !== false && team.team_name.trim());
  if (added.length === 0) return emptyDependencyResult();
  const teams = mergeRoster(input.teams, added);
  return runTeamDependencyGeneration({ ...input, teams }, options, {
    addedTeams: added,
    existingEdges: input.existingEdges ?? [],
    idSources: input.idSources ?? [],
  });
}

interface DependencyFocus {
  addedTeams: readonly GenerationTeam[];
  existingEdges: readonly TeamDependencyEdge[];
  idSources: readonly DependencyIdSource[];
}

export async function generateTeamDependencies(
  input: GenerateTeamDependenciesInput,
  options: GenerateTeamDependenciesOptions = {},
): Promise<GenerateTeamDependenciesResult> {
  return runTeamDependencyGeneration(input, options);
}

async function runTeamDependencyGeneration(
  input: GenerateTeamDependenciesInput,
  options: GenerateTeamDependenciesOptions = {},
  focus?: DependencyFocus,
): Promise<GenerateTeamDependenciesResult> {
  const client = options.client ?? defaultClient;
  const concurrency = options.concurrency ?? env.warroomGenConcurrency;
  const batchTeams = options.mapBatchTeams ?? env.warroomDependencyMapBatchTeams;
  const upstreamPerTeam = options.upstreamPerTeam ?? env.warroomDependencyUpstreamPerTeam;
  const consequenceBatch = Math.max(
    1,
    options.consequenceBatch ?? env.warroomDependencyConsequenceBatch,
  );
  const summaryBudget = options.summaryBudget ?? CONVERGENCE_SUMMARY_MAX_CHARS;
  const duration = input.crisis.duration > 0 ? input.crisis.duration : 60;
  const known = stampStorylineKeys(input.storylines);
  const addedNames = new Set((focus?.addedTeams ?? []).map((team) => team.team_name));
  const plans = planDependencyMapCalls(input.teams, batchTeams).filter(
    (plan) => !focus || plan.teams.some((team) => addedNames.has(team.team_name)),
  );
  const cap = upstreamPerTeam;
  const mapRaw = await limitConcurrency(plans, concurrency, async (plan) => {
    const request: DependencyChatRequest = {
      system: mapSystemPrompt(cap),
      user: mapUserPrompt(plan, input, known, summaryBudget, focus),
      label: 'generator.dependencyMap',
      tier: 'standard',
      json: true,
    };
    try {
      const raw = await client.complete(request);
      const edges = Array.isArray(asRecord(raw)?.edges) ? (asRecord(raw)?.edges as unknown[]) : [];
      return plan.kind === 'cross' ? capCrossOrgEdges(edges, input.teams) : edges;
    } catch (err) {
      logger.warn(
        { err, event: 'dependency_map_failed', kind: plan.kind },
        'Dependency map call failed',
      );
      return [];
    }
  });

  const processed = postProcessDependencies(
    { edges: mapRaw.flat() },
    input.teams,
    known,
    duration,
    {
      upstreamPerTeam: cap,
      ...(focus
        ? {
            takenIds: takenDependencyIds(focus.existingEdges, focus.idSources),
            existingEdges: focus.existingEdges,
          }
        : {}),
    },
    input.stakeholders,
  );
  if (processed.dropped.length > 0) {
    logger.warn(
      { event: 'dependency_edges_dropped', dropped: processed.dropped.length },
      'Dropped dependency edges that failed post-processing',
    );
  }

  const edgesForConsequences = focus
    ? processed.edges.filter((edge) => edgeTouchesAdded(edge, focus.addedTeams))
    : processed.edges;
  const keptEdgeIds = new Set(edgesForConsequences.map((edge) => edge.id));
  const asks = focus
    ? processed.asks.filter((ask) => keptEdgeIds.has(askDependencyId(ask)))
    : processed.asks;
  const batches = chunk(edgesForConsequences, consequenceBatch);
  const teamNames = input.teams.map((team) => team.team_name);
  const taken = new Set<string>([
    ...known.map((inject) => inject.inject_key).filter((key): key is string => !!key),
    ...processed.asks.flatMap((inject) =>
      inject.delivery_config.inject_key ? [inject.delivery_config.inject_key] : [],
    ),
  ]);
  const built = await limitConcurrency(batches, concurrency, async (batch) => {
    const request: DependencyChatRequest = {
      system: consequenceSystemPrompt(),
      user: consequenceUserPrompt(batch, input),
      label: 'generator.dependencyConsequences',
      tier: 'standard',
      json: true,
    };
    let raw: unknown = null;
    try {
      raw = await client.complete(request);
    } catch (err) {
      logger.warn(
        { err, event: 'dependency_consequences_failed' },
        'Dependency consequence call failed',
      );
    }
    const consequences: SocialInject[] = [];
    const positives: SocialInject[] = [];
    for (const edge of batch) {
      const rows = buildConsequenceInjects(edge, raw, taken, input.stakeholders);
      edge.consequence_keys = [];
      for (const inject of rows.consequences) {
        const kept = await repairNaming(inject, teamNames, client);
        if (!kept) continue;
        consequences.push(kept);
        if (kept.delivery_config.inject_key)
          edge.consequence_keys.push(kept.delivery_config.inject_key);
      }
      for (const inject of rows.positives) {
        const kept = await repairNaming(inject, teamNames, client);
        if (kept) positives.push(kept);
      }
    }
    return { consequences, positives };
  });

  const intel = focus
    ? []
    : registerIntelEdges(
        input.intelItems ?? [],
        new Set(edgesForConsequences.map((edge) => edge.id)),
        input.teams,
        duration,
      );
  const edges = [...edgesForConsequences, ...intel];
  const consequences = built.flatMap((batch) => batch.consequences);
  const positives = built.flatMap((batch) => batch.positives);
  return {
    team_dependencies: { v: 1, edges },
    consequences,
    positives,
    asks,
    summary: dependencyEdgeSummary(edges),
    mapCalls: plans.length,
    consequenceCalls: batches.length,
  };
}

/**
 * Compile uses a document the convergence stage already produced.
 * When that document is missing and nothing was stamped, it generates one.
 */
export async function resolveTeamDependencies(
  existing: unknown,
  input: GenerateTeamDependenciesInput,
  options: GenerateTeamDependenciesOptions = {},
): Promise<GenerateTeamDependenciesResult | null> {
  const read = readDependencyEdges(existing);
  if (!('error' in read)) {
    const validated = validateDependencies(read.edges, [], [], null);
    const schemaError = validated.issues.some((issue) => issue.code === 'MO-DEP-001');
    if (!schemaError) {
      return {
        team_dependencies: { v: 1, edges: validated.edges },
        consequences: [],
        positives: [],
        asks: [],
        summary: dependencyEdgeSummary(validated.edges),
        mapCalls: 0,
        consequenceCalls: 0,
      };
    }
  }
  const playable = input.teams.filter((team) => team.playable !== false);
  if (playable.length < 2) return null;
  return generateTeamDependencies(input, options);
}

export interface CompileDependencyInput {
  existing: unknown;
  orgs?: readonly DependencyOrgSource[] | null;
  storylines: Record<string, SocialInject[]>;
  charters?: readonly DependencyCharterSource[];
  crisis: DependencyCrisis;
  facts: readonly string[];
  stakeholders?: readonly DependencyStakeholder[];
  gates?: readonly SocialInject[];
  client?: DependencyClient;
}

/** Persist a dependency document already produced, or generate one at compile. */
export async function resolveCompileDependencies(input: CompileDependencyInput): Promise<{
  document: TeamDependencies;
  storylines: Record<string, SocialInject[]>;
  added: SocialInject[];
} | null> {
  const storylines = input.storylines;
  const teams = dependencyTeamsFrom({
    orgs: input.orgs ?? undefined,
    storylineTeams: Object.keys(storylines).filter((name) => name !== 'Shared'),
    charters: input.charters,
  });
  const resolved = await resolveTeamDependencies(
    input.existing,
    {
      teams,
      crisis: input.crisis,
      facts: input.facts,
      storylines,
      intelItems: intelItemsFromInjects(storylines, input.gates ?? []),
      stakeholders: input.stakeholders,
    },
    input.client ? { client: input.client } : {},
  );
  if (!resolved) return null;
  const next = { ...storylines };
  for (const ask of resolved.asks) {
    const team = ask.target_teams[0];
    if (!team) continue;
    next[team] = [...(next[team] ?? []), ask];
  }
  return {
    document: resolved.team_dependencies,
    storylines: next,
    added: [...resolved.consequences, ...resolved.positives],
  };
}

function mapSystemPrompt(cap: number): string {
  return `You design the team interdependencies of a crisis-response exercise. Teams: one per line below, with their organisation, function and mission. A dependency is something one team (upstream) must deliver — information, a decision, an approval, a resource, an action, coverage, or restraint (not doing something) — that other teams (downstream, 1 to 3) need to do their own job in THIS crisis. For each dependency choose how it breaks, using only these signal templates:
${signalTemplatePrompt()}
and bind each template to an existing upstream inject from the storylines (by inject_key), or ask for a new short "ask" inject to the upstream team. Rules: every team appears in at least one dependency; no team has more than ${cap} upstream dependencies; dependencies cross organisations where it is realistic; never invent a team.
Return ONLY JSON: { "edges": [ { "id": "dep_...", "kind": "information|decision|approval|resource|action|coverage|restraint", "upstream": "<team name>", "downstream": ["..."], "deliverable": "...", "why": "...", "signals": [ { "template": "no_reply|poor_reply|duty_missed|silent|content_failed|decision|restraint_action|intel", "inject_key": "...", "minutes": 10, "action_id": "...", "action_type": "...", "count": 1, "n": 1, "score": 45, "category": "...", "intel_key": "...", "scope": "@upstream|@downstream" } ], "met_signal": null, "due": { "by_minute": 20 }, "lag_minutes": 5, "severity": "low|medium|high", "needs_ask": null } ] }`;
}

function mapUserPrompt(
  plan: MapCallPlan,
  input: GenerateTeamDependenciesInput,
  known: readonly KnownInject[],
  summaryBudget: number,
  focus?: DependencyFocus,
): string {
  const lines = plan.teams.map(teamLine);
  const storyline = storylineBlock(input.storylines, plan, known);
  const body = [
    `Crisis: ${input.crisis.crisisType}`,
    input.crisis.orgName ? `Organisation: ${input.crisis.orgName}` : '',
    input.crisis.country ? `Country: ${input.crisis.country}` : '',
    `Duration: ${input.crisis.duration} minutes`,
    input.crisis.context ? `Context: ${input.crisis.context}` : '',
    `Confirmed facts: ${input.facts.slice(0, 8).join('; ')}`,
    plan.kind === 'intra'
      ? `This call is only for dependencies inside ${plan.orgName}. Do not name a team from outside this list.`
      : plan.kind === 'cross'
        ? `This call is only for dependencies that cross organisations. Return at most ${CROSS_ORG_EDGES_PER_ORG} edges per organisation.`
        : 'Dependencies may cross organisations where that is realistic.',
    'Teams:',
    ...lines,
    dutyBlock(plan.teams),
    'Storyline injects already written:',
    storyline || '(none)',
    focusNote(focus),
  ]
    .filter(Boolean)
    .join('\n');
  if (plan.kind !== 'cross' || body.length <= summaryBudget) return body;
  const cap = Math.max(0, Math.floor(summaryBudget));
  return body.slice(0, cap);
}

function consequenceSystemPrompt(): string {
  return `You write the consequences of a broken team dependency in a crisis-response exercise.

For each dependency, write one consequence for every downstream team named below. A consequence lands where a real one would: a reporter emails Communications, angry callers reach Customer Service, a regulator writes to Legal. Internal emails, group chats and phone calls may name the team that let them down. Public posts (social_feed) and news articles never name an internal team.

For one edge in three, also write an optional positive beat that appears when the dependency is met on time. Use a sender id from the stakeholder list. Never invent a person.

Return ONLY JSON:
{ "consequences": [ { "edge_id": "dep_...", "downstream": "<team name>", "title": "...", "content": "...", "app": "email|group_chat|phone_call|social_feed|news", "sender": "stk_...", "severity": "low|medium|high", "requires_response": false } ], "positives": [ { "edge_id": "dep_...", "downstream": "<team name>", "title": "...", "content": "...", "app": "email|group_chat", "sender": "stk_...", "severity": "low" } ] }`;
}

function consequenceUserPrompt(
  edges: readonly TeamDependencyEdge[],
  input: GenerateTeamDependenciesInput,
): string {
  const described = edges.map((edge) => ({
    id: edge.id,
    kind: edge.kind,
    upstream: edge.upstream.team_name,
    downstream: edge.downstream.map((team) => team.team_name),
    deliverable: edge.deliverable,
    why: edge.why,
    lag_minutes: edge.lag_minutes,
    severity: edge.severity,
  }));
  return [
    `Crisis: ${input.crisis.crisisType}`,
    `Duration: ${input.crisis.duration} minutes`,
    input.crisis.context ? `Context: ${input.crisis.context}` : '',
    `Confirmed facts: ${input.facts.slice(0, 8).join('; ')}`,
    `Stakeholders: ${JSON.stringify((input.stakeholders ?? []).map((stakeholder) => ({ id: stakeholder.id, name: stakeholder.name ?? '' })))}`,
    `Dependencies:\n${JSON.stringify(described)}`,
    'Public posts and news never name internal teams. Internal channels may.',
  ]
    .filter(Boolean)
    .join('\n');
}

async function repairNaming(
  inject: SocialInject,
  teamNames: readonly string[],
  client: DependencyClient,
): Promise<SocialInject | null> {
  const hit = checkTeamNaming(inject, teamNames);
  if (!hit.namesTeam) return inject;
  let raw: unknown = null;
  try {
    raw = await client.complete({
      system:
        'Rewrite one crisis inject. Public posts and news never name internal teams. Return ONLY JSON: { "title": "...", "content": "..." }',
      user: `Do not name these teams: ${teamNames.join(', ')}. The previous draft named ${hit.matches.join(', ')}.\nApp: ${inject.delivery_config.app}\nTitle: ${inject.title}\nContent: ${inject.content}`,
      label: 'generator.dependencyConsequences',
      tier: 'standard',
      json: true,
    });
  } catch (err) {
    logger.warn(
      { err, event: 'dependency_naming_retry_failed', title: inject.title },
      'Naming retry failed',
    );
  }
  const row = asRecord(raw);
  const title =
    typeof row?.title === 'string' && row.title.trim() ? row.title.trim() : inject.title;
  const content = typeof row?.content === 'string' ? row.content.trim() : '';
  const next = content ? { ...inject, title, content } : null;
  if (!next || checkTeamNaming(next, teamNames).namesTeam) {
    logger.warn(
      {
        event: 'dependency_consequence_dropped_names_team',
        title: inject.title,
        teams: hit.matches,
      },
      'Dropped a public consequence that named an internal team',
    );
    return null;
  }
  return next;
}

function stampStorylineKeys(storylines: Record<string, SocialInject[]>): KnownInject[] {
  const flat = Object.values(storylines).flat();
  const stamped = stampGeneratedInjectKeys(flat);
  stamped.forEach((row, index) => {
    const original = flat[index];
    if (!original) return;
    original.delivery_config = {
      ...original.delivery_config,
      inject_key:
        typeof row.delivery_config.inject_key === 'string'
          ? row.delivery_config.inject_key
          : undefined,
    };
  });
  return flat.flatMap((inject) => {
    const key = inject.delivery_config?.inject_key;
    if (typeof key !== 'string') return [];
    return [
      {
        inject_key: key,
        title: inject.title,
        trigger_time_minutes: inject.trigger_time_minutes ?? null,
      },
    ];
  });
}

function capCrossOrgEdges(edges: readonly unknown[], teams: readonly GenerationTeam[]): unknown[] {
  const counts = new Map<string, number>();
  const kept: unknown[] = [];
  for (const raw of edges) {
    const filtered = dropSameOrgEdge(raw, teams);
    if (!filtered) continue;
    const row = asRecord(filtered);
    const upstream = matchTeamRef({ team_uid: null, team_name: upstreamName(row) }, teams);
    const org = upstream ? orgId(upstream) : '';
    const used = counts.get(org) ?? 0;
    if (org && used >= CROSS_ORG_EDGES_PER_ORG) continue;
    if (org) counts.set(org, used + 1);
    kept.push(filtered);
  }
  return kept;
}

/** A cross-org call keeps an edge only when some downstream team is in another organisation. */
function dropSameOrgEdge(raw: unknown, teams: readonly GenerationTeam[]): unknown | null {
  const row = asRecord(raw);
  if (!row) return raw;
  const upstream = matchTeamRef({ team_uid: null, team_name: upstreamName(row) }, teams);
  const upOrg = upstream ? orgId(upstream) : '';
  const names = downstreamNames(row.downstream);
  if (!upOrg || names.length === 0) return raw;
  const cross = names.filter((name) => {
    const team = matchTeamRef({ team_uid: null, team_name: name }, teams);
    if (!team) return true;
    const org = orgId(team);
    return !org || org !== upOrg;
  });
  if (cross.length === 0) return null;
  if (cross.length === names.length) return raw;
  return { ...row, downstream: cross };
}

function upstreamName(row: Record<string, unknown> | null): string {
  if (!row) return '';
  if (typeof row.upstream === 'string') return row.upstream;
  return text(asRecord(row.upstream)?.team_name) ?? text(asRecord(row.upstream)?.name) ?? '';
}

function downstreamNames(raw: unknown): string[] {
  const listed = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  return listed.flatMap((item) => {
    if (typeof item === 'string' && item.trim()) return [item.trim()];
    const name = text(asRecord(item)?.team_name) ?? text(asRecord(item)?.name);
    return name ? [name] : [];
  });
}

function orgId(team: GenerationTeam): string {
  return team.org_key || team.org_name || '';
}

function dutyBlock(teams: readonly GenerationTeam[]): string {
  const lines = teams.flatMap((team) => {
    if (!team.duties || team.duties.length === 0) return [];
    const duties = team.duties
      .map((duty) => {
        const id = duty.action_id.trim();
        if (!id) return '';
        return duty.timing_benchmark_minutes != null
          ? `${id} (benchmark ${duty.timing_benchmark_minutes} min)`
          : id;
      })
      .filter(Boolean);
    if (duties.length === 0) return [];
    return [`- ${team.team_name}: ${duties.join(', ')}`];
  });
  if (lines.length === 0) return '';
  return [
    'Charter duties (a duty_missed action_id must be one of these, not an invented id):',
    ...lines,
  ].join('\n');
}

function dutiesFrom(
  actions: readonly unknown[] | null | undefined,
): GenerationTeam['duties'] | undefined {
  if (!Array.isArray(actions)) return undefined;
  const duties: NonNullable<GenerationTeam['duties']>[number][] = [];
  for (const raw of actions) {
    const row = asRecord(raw);
    const id = typeof row?.action_id === 'string' ? row.action_id.trim() : '';
    if (!/^[a-z0-9_]{1,60}$/.test(id)) continue;
    const benchmark = row?.timing_benchmark_minutes;
    duties.push({
      action_id: id,
      timing_benchmark_minutes:
        typeof benchmark === 'number' && Number.isFinite(benchmark) ? benchmark : null,
    });
  }
  return duties;
}

function teamLine(team: GenerationTeam): string {
  return `- ${team.team_name} | org: ${team.org_name || team.org_key || 'scenario'} | function: ${team.function_name || 'unspecified'} | mission: ${(team.mission || '').replace(/\s+/g, ' ').slice(0, 240)}`;
}

function storylineBlock(
  storylines: Record<string, SocialInject[]>,
  plan: MapCallPlan,
  known: readonly KnownInject[],
): string {
  const names = new Set(plan.teams.map((team) => team.team_name));
  const byKey = new Map(known.map((inject) => [inject.inject_key, inject]));
  const lines: string[] = [];
  for (const [team, injects] of Object.entries(storylines)) {
    if (plan.kind !== 'cross' && team !== 'Shared' && !names.has(team)) continue;
    for (const inject of injects) {
      const key = inject.delivery_config?.inject_key;
      if (typeof key !== 'string' || !byKey.has(key)) continue;
      const minute =
        inject.trigger_time_minutes == null ? '?' : String(inject.trigger_time_minutes);
      lines.push(`- ${key} | ${team} | T+${minute} | ${inject.title}`);
    }
  }
  return lines.join('\n');
}

function focusNote(focus: DependencyFocus | undefined): string {
  if (!focus || focus.addedTeams.length === 0) return '';
  const names = focus.addedTeams.map((team) => team.team_name).join(', ');
  const existing =
    focus.existingEdges.length > 0
      ? `\nExisting dependencies, do not repeat them:\n${dependencyEdgeSummary(focus.existingEdges)}`
      : '';
  return `Only return dependencies that include at least one of these added teams: ${names}. Do not return a dependency that only connects the other teams.${existing}`;
}

function edgeTouchesAdded(edge: TeamDependencyEdge, added: readonly GenerationTeam[]): boolean {
  const refs = [edge.upstream, ...edge.downstream];
  return refs.some((ref) =>
    added.some(
      (team) =>
        (!!ref.team_uid && !!team.team_uid && ref.team_uid === team.team_uid) ||
        sameTeam(ref.team_name, team.team_name),
    ),
  );
}

function mergeRoster(
  teams: readonly GenerationTeam[],
  added: readonly GenerationTeam[],
): GenerationTeam[] {
  const seen = new Set(teams.map((team) => team.team_name));
  return [...teams, ...added.filter((team) => !seen.has(team.team_name))];
}

function emptyDependencyResult(): GenerateTeamDependenciesResult {
  return {
    team_dependencies: { v: 1, edges: [] },
    consequences: [],
    positives: [],
    asks: [],
    summary: '',
    mapCalls: 0,
    consequenceCalls: 0,
  };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    batches.push(items.slice(offset, offset + size));
  }
  return batches;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
