import { askDependencyId } from '../../../shared/teamDependencies.js';
import type { ObjectiveDef, SocialInject } from '../socialCrisisGeneratorService.js';
import type { BriefDiff } from './affectedLayers.js';
import {
  clampTriggerTime,
  filterConditions,
  keepRevision,
  LAYER_PROMPT_CHARS,
  MAX_GATES,
  MAX_LAYER_INJECTS,
  MAX_NEW_GROUP_PERSONAS,
  MAX_SHARED_INJECTS,
  mergeFactSheet,
  retireRevision,
  reviseFromSource,
  substitutePair,
} from './briefRevisionCore.js';
import type { DeltaCall } from './deltaCalls.js';
import type {
  DeltaBuildContext,
  DeltaGenerators,
  LayerRevisionResult,
  ObjectiveUpdate,
} from './deltaBuildTypes.js';
import {
  activeKeys,
  flagFor,
  keyOf,
  stampNew,
  storyDiff,
  toSource,
  type RunState,
} from './deltaRunShared.js';

interface CallEnv {
  ctx: DeltaBuildContext;
  generators: DeltaGenerators;
  diff: BriefDiff | null;
  state: RunState;
}

type CallHandlers = {
  [K in DeltaCall['op']]: (call: Extract<DeltaCall, { op: K }>, env: CallEnv) => Promise<void>;
};

/**
 * One handler per call kind. `brief_diff` is run by the characters stage before
 * this table; a call that still arrives here does nothing, as the old chain did.
 * A missing or mis-typed handler is a compile error.
 */
const callHandlers: CallHandlers = {
  brief_diff: async () => {},
  personas: runPersonas,
  persona_groups: runPersonaGroups,
  fact_sheet: runFactSheet,
  charter: runCharter,
  team_storyline: runTeamStoryline,
  stakeholders: runStakeholders,
  spokesperson: runSpokesperson,
  revise_layer: runReviseLayer,
  stakeholder_text: runStakeholderText,
  dependency_delta: runDependencyDelta,
  convergence_delta: runConvergenceDelta,
  narrative: runNarrative,
  pages: runPages,
  page_history: runPageHistory,
};

export async function executeCall(
  call: DeltaCall,
  ctx: DeltaBuildContext,
  generators: DeltaGenerators,
  diff: BriefDiff | null,
  state: RunState,
): Promise<void> {
  const env = { ctx, generators, diff, state };
  switch (call.op) {
    case 'brief_diff':
      return callHandlers.brief_diff(call, env);
    case 'personas':
      return callHandlers.personas(call, env);
    case 'persona_groups':
      return callHandlers.persona_groups(call, env);
    case 'fact_sheet':
      return callHandlers.fact_sheet(call, env);
    case 'charter':
      return callHandlers.charter(call, env);
    case 'team_storyline':
      return callHandlers.team_storyline(call, env);
    case 'stakeholders':
      return callHandlers.stakeholders(call, env);
    case 'spokesperson':
      return callHandlers.spokesperson(call, env);
    case 'revise_layer':
      return callHandlers.revise_layer(call, env);
    case 'stakeholder_text':
      return callHandlers.stakeholder_text(call, env);
    case 'dependency_delta':
      return callHandlers.dependency_delta(call, env);
    case 'convergence_delta':
      return callHandlers.convergence_delta(call, env);
    case 'narrative':
      return callHandlers.narrative(call, env);
    case 'pages':
      return callHandlers.pages(call, env);
    case 'page_history':
      return callHandlers.page_history(call, env);
    default: {
      const unreachable: never = call;
      return unreachable;
    }
  }
}

async function runPersonas(call: Extract<DeltaCall, { op: 'personas' }>, env: CallEnv): Promise<void> {
  const personas = await env.generators.generatePersonas({ ctx: env.ctx, country: call.country });
  env.state.generated.personas.push(...personas);
}

async function runPersonaGroups(call: Extract<DeltaCall, { op: 'persona_groups' }>, env: CallEnv): Promise<void> {
  const groups = (env.diff?.new_groups ?? []).slice(0, MAX_NEW_GROUP_PERSONAS);
  const personas = await env.generators.generatePersonaGroups({ ctx: env.ctx, groups });
  env.state.generated.personas.push(...personas.slice(0, MAX_NEW_GROUP_PERSONAS));
}

async function runFactSheet(call: Extract<DeltaCall, { op: 'fact_sheet' }>, env: CallEnv): Promise<void> {
  const { ctx, generators, diff, state } = env;
  if (!diff) return;
  const revised = await generators.reviseFactSheet({
    factSheet: ctx.fact_sheet,
    diff,
    appendOnly: ctx.fact_sheet_trainer_edited,
  });
  state.factSheet = mergeFactSheet(ctx.fact_sheet, revised, diff, ctx.fact_sheet_trainer_edited);
}

async function runCharter(call: Extract<DeltaCall, { op: 'charter' }>, env: CallEnv): Promise<void> {
  const charter = await env.generators.generateCharter({
    ctx: env.ctx,
    teamName: call.team_name,
    orgKey: call.org_key,
  });
  env.state.generated.charters.push({
    ...charter,
    team_name: call.team_name,
    org_key: call.org_key,
  });
}

async function runTeamStoryline(call: Extract<DeltaCall, { op: 'team_storyline' }>, env: CallEnv): Promise<void> {
  const { ctx, generators, state } = env;
  const injects = await generators.generateTeamStoryline({
    ctx,
    teamName: call.team_name,
    orgKey: call.org_key,
    country: call.country,
  });
  const layer = `team:${teamUid(ctx, call.team_name) || call.team_name}`;
  state.generated.team_storylines[call.team_name] = stampNew(ctx, injects, layer, state);
}

async function runStakeholders(call: Extract<DeltaCall, { op: 'stakeholders' }>, env: CallEnv): Promise<void> {
  const { ctx, generators, state } = env;
  const result = await generators.generateStakeholders({ ctx, orgKey: call.org_key });
  state.generated.stakeholders.push(...result.stakeholders);
  state.generated.stakeholder_injects.push(
    ...stampNew(ctx, result.injects, `stakeholder:${call.org_key}`, state),
  );
}

async function runSpokesperson(call: Extract<DeltaCall, { op: 'spokesperson' }>, env: CallEnv): Promise<void> {
  const { ctx, generators, state } = env;
  const result = await generators.generateSpokesperson({ ctx, orgKey: call.org_key });
  if (result.stakeholder) state.generated.stakeholders.push(result.stakeholder);
  state.generated.spokespersons.push({
    org_key: call.org_key,
    stakeholder_id: result.stakeholder?.id,
  });
  state.generated.pressure_injects.push(
    ...stampNew(ctx, result.injects, `pressure:${call.org_key}`, state),
  );
}

async function runReviseLayer(call: Extract<DeltaCall, { op: 'revise_layer' }>, env: CallEnv): Promise<void> {
  const { ctx, generators, diff, state } = env;
  if (!diff && !ctx.plan.primary_swap && !call.country) return;
  const brief = storyDiff(diff, ctx, call.layer === 'backbone' && !!ctx.plan.primary_swap);
  applyLayer(
    ctx,
    state,
    call.layer,
    brief,
    await generators.reviseLayer({
      layer: call.layer,
      owned: promptInjects(ctx, call.layer, 'ai_owned', brief),
      handEdited: promptInjects(ctx, call.layer, 'context', brief),
      diff: brief,
      country: call.country,
    }),
  );
}

async function runStakeholderText(call: Extract<DeltaCall, { op: 'stakeholder_text' }>, env: CallEnv): Promise<void> {
  const { ctx, generators, diff, state } = env;
  if (!diff) return;
  const updated = await generators.reviseStakeholderText({
    stakeholders: ctx.stakeholders.map((stakeholder) => ({
      id: stakeholder.id,
      grievance: stakeholder.grievance,
      knowledge: stakeholder.knowledge,
    })),
    diff,
  });
  state.stakeholder_updates.push(...updated);
}

async function runDependencyDelta(call: Extract<DeltaCall, { op: 'dependency_delta' }>, env: CallEnv): Promise<void> {
  const { ctx, generators, state } = env;
  const result = await generators.dependencyDelta({
    ctx,
    addedTeams: ctx.delta.added_teams,
    existingEdges: ctx.team_dependencies,
  });
  const consequences = stampDependencyInjects(ctx, result.consequences, state);
  const positives = stampDependencyInjects(ctx, result.positives, state);
  state.generated.dependency_injects.push(...consequences, ...positives);
  const askRenames: Array<{ depId: string; from: string; to: string }> = [];
  const takenAskKeys = new Set(ctx.active_keys);
  for (const existing of Object.values(state.generated.team_storylines).flat()) {
    const key = keyOf(existing);
    if (key) takenAskKeys.add(key);
  }
  for (const ask of result.asks) {
    const team = ask.target_teams[0] ?? '';
    if (!team) continue;
    const before = keyOf(ask);
    const depId = askDependencyId(ask);
    const colliding = !!before && takenAskKeys.has(before);
    const prepared = colliding
      ? { ...ask, delivery_config: { ...ask.delivery_config, inject_key: undefined } }
      : ask;
    const layer = `team:${teamUid(ctx, team) || team}`;
    const stamped = stampNew(ctx, [prepared], layer, state);
    const after = keyOf(stamped[0] ?? ask);
    if (after) takenAskKeys.add(after);
    if (depId && before && after && before !== after) {
      askRenames.push({ depId, from: before, to: after });
    }
    state.generated.team_storylines[team] = [
      ...(state.generated.team_storylines[team] ?? []),
      ...stamped,
    ];
  }
  const rebound = askRenames.reduce(
    (edges, rename) =>
      edges.map((edge) =>
        edge.id === rename.depId ? rewriteEdgeInjectKey(edge, rename.from, rename.to) : edge,
      ),
    result.edges,
  );
  state.generated.dependency_edges.push(...syncConsequenceKeys(rebound, consequences));
}

async function runConvergenceDelta(call: Extract<DeltaCall, { op: 'convergence_delta' }>, env: CallEnv): Promise<void> {
  const { ctx, generators, state } = env;
  const result = await generators.convergenceDelta({
    newTeams: ctx.delta.added_teams.map((team) => team.team_name),
    existingTeams: ctx.teams.map((team) => team.team_name),
    crisis: ctx.edited.crisis.crisis_type,
  });
  state.generated.shared_injects.push(
    ...stampNew(ctx, result.shared.slice(0, MAX_SHARED_INJECTS), 'shared', state),
  );
  state.generated.gates.push(...stampNew(ctx, result.gates.slice(0, MAX_GATES), 'gate', state));
}

async function runNarrative(call: Extract<DeltaCall, { op: 'narrative' }>, env: CallEnv): Promise<void> {
  const { ctx, generators, diff, state } = env;
  const brief = storyDiff(diff, ctx, !!ctx.plan.primary_swap);
  const result = await generators.reviseNarrative({
    narrative: {
      title: ctx.narrative.title,
      description: ctx.narrative.description,
      briefing: ctx.briefing_trainer_edited ? ctx.briefing : ctx.narrative.briefing,
    },
    objectives: ctx.objectives,
    diff: brief,
    keepBriefing: ctx.briefing_trainer_edited,
  });
  state.narrative_update = {
    title: result.narrative.title,
    description: result.narrative.description,
    briefing: ctx.briefing_trainer_edited ? ctx.briefing : result.narrative.briefing,
    briefing_kept: ctx.briefing_trainer_edited,
  };
  state.objective_updates.push(...objectiveUpdates(ctx, result.objectives));
}

async function runPages(call: Extract<DeltaCall, { op: 'pages' }>, env: CallEnv): Promise<void> {
  const orgs = call.org_keys.map((orgKey) => pageSubject(env.ctx, orgKey));
  const pages = await env.generators.generatePages({ ctx: env.ctx, orgs });
  env.state.generated.pages.push(...pages);
}

async function runPageHistory(call: Extract<DeltaCall, { op: 'page_history' }>, env: CallEnv): Promise<void> {
  const { ctx, generators, diff, state } = env;
  const page = ctx.pages.find((item) => item.org_key === call.org_key);
  const brief = storyDiff(
    diff,
    ctx,
    call.org_key === ctx.plan.primary_swap?.new_primary_previous_key,
  );
  const history = await generators.revisePageHistory({
    orgKey: call.org_key,
    history: page?.history ?? [],
    diff: brief,
    country: call.country,
  });
  state.generated.pages.push({ org_key: call.org_key, branded_history: history });
}

function applyLayer(
  ctx: DeltaBuildContext,
  state: RunState,
  layer: string,
  diff: BriefDiff,
  result: LayerRevisionResult,
): void {
  const byId = new Map(
    ctx.injects.filter((inject) => inject.layer === layer).map((inject) => [inject.id, inject]),
  );
  for (const decision of result.decisions) {
    const inject = byId.get(decision.inject_id);
    if (!inject) continue;
    if (inject.provenance !== 'ai_owned') {
      state.flags.push(flagFor(inject, diff, ctx));
      continue;
    }
    const source = toSource(inject, diff);
    if (decision.decision === 'keep') {
      state.revisions.push(keepRevision(source, decision.reason || 'Unchanged.'));
      continue;
    }
    if (decision.decision === 'retire') {
      state.revisions.push(
        retireRevision(source, decision.reason || 'Retired by the brief revision.'),
      );
      continue;
    }
    const time = clampTriggerTime(
      inject.trigger_time_minutes,
      decision.trigger_time_minutes,
      diff.severity,
    );
    const active = activeKeys(ctx, state);
    state.revisions.push(
      reviseFromSource(
        source,
        decision.reason || 'Revised for the brief.',
        {
          title: decision.title ?? source.title,
          content: decision.content ?? source.content,
          ...(time != null ? { trigger_time_minutes: time } : {}),
          conditions_to_appear: filterConditions(
            decision.conditions_to_appear ?? source.conditions_to_appear,
            active,
          ),
          conditions_to_cancel: filterConditions(
            decision.conditions_to_cancel ?? source.conditions_to_cancel,
            active,
          ),
        },
        ctx.edit_number,
      ),
    );
  }
  for (const inject of ctx.injects) {
    if (inject.layer !== layer || inject.provenance === 'ai_owned') continue;
    if (state.flags.some((flag) => flag.inject_id === inject.id)) continue;
    state.flags.push(flagFor(inject, diff, ctx));
  }
  const fresh = (result.new_injects ?? []).slice(0, MAX_LAYER_INJECTS);
  state.generated.layer_injects.push(...stampNew(ctx, fresh, layer, state));
}

function objectiveUpdates(ctx: DeltaBuildContext, objectives: ObjectiveDef[]): ObjectiveUpdate[] {
  return objectives.map((objective) => {
    const current = ctx.objectives.find((item) => item.objective_id === objective.objective_id);
    return {
      objective_id: objective.objective_id,
      write: current?.has_scores ? 'cow' : 'in_place',
      fields: {
        objective_name: objective.objective_name,
        description: objective.description,
        weight: objective.weight,
      },
    };
  });
}

function promptInjects(
  ctx: DeltaBuildContext,
  layer: string,
  mode: 'ai_owned' | 'context',
  diff: BriefDiff,
): Array<{
  id: string;
  inject_key: string;
  title: string;
  content: string;
  trigger_time_minutes: number | null;
  conditions_to_appear?: unknown;
  conditions_to_cancel?: unknown;
}> {
  return ctx.injects
    .filter((inject) => inject.layer === layer)
    .filter((inject) =>
      mode === 'ai_owned' ? inject.provenance === 'ai_owned' : inject.provenance !== 'ai_owned',
    )
    .map((inject) => {
      const substituted =
        mode === 'ai_owned' && diff.severity !== 'cosmetic'
          ? substitutePair(inject.title, inject.content, diff.renamed_entities)
          : { title: inject.title, content: inject.content, changed: false };
      return {
        id: inject.id,
        inject_key: inject.inject_key,
        title: substituted.title,
        content: substituted.content.slice(0, LAYER_PROMPT_CHARS),
        trigger_time_minutes: inject.trigger_time_minutes,
        conditions_to_appear: inject.conditions_to_appear,
        conditions_to_cancel: inject.conditions_to_cancel,
      };
    });
}

function dependencyLayerOf(inject: SocialInject): string | null {
  const config = inject.delivery_config as { gen?: { layer?: unknown } };
  if (typeof config.gen?.layer === 'string' && config.gen.layer) return config.gen.layer;
  return inject.gen_layer || null;
}

function stampDependencyInjects(
  ctx: DeltaBuildContext,
  injects: SocialInject[],
  state: RunState,
): SocialInject[] {
  return injects.flatMap((inject) => {
    const layer = dependencyLayerOf(inject);
    if (!layer) return [];
    return stampNew(ctx, [inject], layer, state);
  });
}

function rewriteEdgeInjectKey(
  edge: DeltaBuildContext['team_dependencies'][number],
  from: string,
  to: string,
): DeltaBuildContext['team_dependencies'][number] {
  if (!from || from === to) return edge;
  const due =
    'after_inject_key' in edge.due && edge.due.after_inject_key === from
      ? { ...edge.due, after_inject_key: to }
      : edge.due;
  return {
    ...edge,
    due,
    broken_when: rewriteConditionKeys(edge.broken_when, from, to) as typeof edge.broken_when,
    met_when: edge.met_when
      ? (rewriteConditionKeys(edge.met_when, from, to) as typeof edge.met_when)
      : edge.met_when,
  };
}

function rewriteConditionKeys(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return replaceInjectKeyToken(value, from, to);
  if (Array.isArray(value)) return value.map((item) => rewriteConditionKeys(item, from, to));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const copy: Record<string, unknown> = { ...record };
  for (const field of ['all', 'any', 'conditions'] as const) {
    if (Array.isArray(record[field])) copy[field] = rewriteConditionKeys(record[field], from, to);
  }
  return copy;
}

function replaceInjectKeyToken(key: string, from: string, to: string): string {
  if (key === from) return to;
  return key
    .split(':')
    .map((part) => {
      const [head, ...rest] = part.split('|');
      if (head !== from) return part;
      return [to, ...rest].join('|');
    })
    .join(':');
}

function syncConsequenceKeys(
  edges: DeltaBuildContext['team_dependencies'],
  consequences: readonly SocialInject[],
): DeltaBuildContext['team_dependencies'] {
  return edges.map((edge) => {
    const keys = consequences.flatMap((inject) => {
      const key = keyOf(inject);
      return dependencyLayerOf(inject) === `dependency:${edge.id}` && key ? [key] : [];
    });
    return keys.length > 0 ? { ...edge, consequence_keys: keys } : edge;
  });
}

function teamUid(ctx: DeltaBuildContext, teamName: string): string {
  return ctx.teams.find((team) => team.team_name === teamName)?.team_uid ?? '';
}

function pageSubject(
  ctx: DeltaBuildContext,
  orgKey: string,
): { org_key: string; name: string; role: 'ally' | 'rival' | 'pressure'; description?: string } {
  if (ctx.delta.added_pressure.includes(orgKey)) {
    const org = ctx.edited.pressure_organisations.find((item) => item.org_key === orgKey);
    return {
      org_key: orgKey,
      name: org?.display_name ?? orgKey,
      role: 'pressure',
      description: org?.wants,
    };
  }
  if (ctx.delta.added_rivals.includes(orgKey)) {
    const org = ctx.edited.competitors.find((item) => item.org_key === orgKey);
    return {
      org_key: orgKey,
      name: org?.name ?? orgKey,
      role: 'rival',
      description: org?.description,
    };
  }
  const org = ctx.edited.organisations.find((item) => item.org_key === orgKey);
  return { org_key: orgKey, name: org?.display_name ?? orgKey, role: 'ally' };
}
