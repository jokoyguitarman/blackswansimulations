import { env } from '../../env.js';
import { limitConcurrency } from '../../lib/limitConcurrency.js';
import type { SocialInject } from '../socialCrisisGeneratorService.js';
import { EMPTY_DECISION } from '../warroomBuild/assemble.js';
import { listDeltaCalls, stageOfCall, type DeltaCall, type DeltaStageName } from './deltaCalls.js';
import type { BriefDiff } from './affectedLayers.js';
import {
  downgradeReferencedRetires,
  filterConditions,
  retireRevision,
  reviseFromSource,
  SUBSTITUTION_REASON,
  substitutePair,
  substituteText,
  type RevisionSource,
  type SetupFlag,
  type SetupRevision,
} from './briefRevisionCore.js';
import { executeCall } from './deltaCallHandlers.js';
import type {
  DeltaBuildContext,
  DeltaGenerators,
  DeltaInject,
  SetupEditStageOutput,
  TextUpdate,
} from './deltaBuildTypes.js';
import { blankGenerated } from './deltaBuildTypes.js';
import {
  activeKeys,
  flagFor,
  keyOf,
  stampNew,
  storyDiff,
  toSource,
  type RunState,
} from './deltaRunShared.js';
import { revisePeaceForEdit } from './peaceDelta.js';

export type { DeltaCall, DeltaStageName } from './deltaCalls.js';
export { listDeltaCalls, stageOfCall } from './deltaCalls.js';

export interface DeltaCarry {
  briefDiff: BriefDiff | null;
  swapPremise: string | null;
  /** Inject keys retired by earlier stages. Later stages must not treat them as active. */
  retiredKeys: string[];
}

export interface DeltaStageHooks {
  /** Trainer-facing build log, the same channel the create-mode peace step uses. */
  warn?: (message: string) => void;
}

export async function runDeltaStage(
  stage: DeltaStageName,
  ctx: DeltaBuildContext,
  generators: DeltaGenerators,
  carry?: DeltaCarry,
  hooks?: DeltaStageHooks,
): Promise<SetupEditStageOutput> {
  const state = startState(ctx, carry);
  let diff = carry?.briefDiff ?? null;
  const premise = carry?.swapPremise ?? ctx.plan.primary_swap?.story.premise ?? null;

  if (stage === 'characters') {
    const structural = listDeltaCalls(ctx, null).filter(
      (call) => stageOfCall(call) === 'characters',
    );
    if (structural.some((call) => call.op === 'brief_diff')) {
      diff = enrichDiff(
        await generators.briefDiff({
          oldBrief: briefText(ctx, 'old'),
          newBrief: briefText(ctx, 'new'),
          factSheet: ctx.fact_sheet,
          layers: [...new Set(ctx.injects.map((inject) => inject.layer))].sort(),
        }),
        premise,
      );
    }
    await runCalls(
      structural.filter((call) => call.op === 'personas'),
      ctx,
      generators,
      diff,
      state,
    );
    const after = listDeltaCalls(ctx, diff).filter(
      (call) =>
        stageOfCall(call) === 'characters' &&
        (call.op === 'fact_sheet' || call.op === 'persona_groups'),
    );
    await runCalls(after, ctx, generators, diff, state);
    if (ctx.delta.brief_changed) state.setup_source_update = ctx.edited.crisis;
  } else {
    const calls = listDeltaCalls(ctx, diff).filter((call) => stageOfCall(call) === stage);
    if (stage === 'storyline' && diff && diff.severity !== 'cosmetic') {
      const revised = new Set(
        listDeltaCalls(ctx, diff)
          .filter((call) => call.op === 'revise_layer')
          .map((call) => (call.op === 'revise_layer' ? call.layer : '')),
      );
      state.revisions.push(...substitutionRevisions(ctx, diff, revised));
      state.flags.push(...substitutionFlags(ctx, diff));
    }
    if (stage === 'pages') {
      state.text_updates.push(...textUpdates(ctx));
      if (diff && diff.severity !== 'cosmetic') {
        const revisedPages = new Set(
          calls.filter((call) => call.op === 'page_history').map((call) => call.org_key),
        );
        state.flags.push(...pageSubstitutionFlags(ctx, diff, revisedPages));
      }
    }
    await runCalls(calls, ctx, generators, diff, state);
  }

  if (stage === 'pages') {
    const peace = await revisePeaceForEdit(ctx, state.generated.pages, hooks?.warn);
    if (peace) state.peace_period = peace;
  }

  if (stage !== 'characters') await regenerateStageBranches(ctx, generators, diff, state);
  state.revisions = downgradeReferencedRetires(
    state.revisions,
    handEditedSources(ctx, state),
    sourceMap(ctx),
    ctx.edit_number,
  );
  scrubGeneratedConditions(ctx, state);
  return finish(
    ctx,
    state,
    stage === 'characters' ? diff : null,
    stage === 'characters' ? premise : null,
  );
}

export async function runDeltaBuild(
  ctx: DeltaBuildContext,
  generators: DeltaGenerators,
  hooks?: DeltaStageHooks,
): Promise<Record<DeltaStageName, SetupEditStageOutput>> {
  const characters = await runDeltaStage('characters', ctx, generators, undefined, hooks);
  const afterCharacters = retiredKeysOf(characters);
  const storyline = await runDeltaStage('storyline', ctx, generators, {
    briefDiff: characters.brief_diff,
    swapPremise: characters.swap_premise,
    retiredKeys: afterCharacters,
  }, hooks);
  const afterStoryline = [...afterCharacters, ...retiredKeysOf(storyline)];
  const convergence = await runDeltaStage('convergence', ctx, generators, {
    briefDiff: characters.brief_diff,
    swapPremise: characters.swap_premise,
    retiredKeys: afterStoryline,
  }, hooks);
  const pages = await runDeltaStage('pages', ctx, generators, {
    briefDiff: characters.brief_diff,
    swapPremise: characters.swap_premise,
    retiredKeys: [...afterStoryline, ...retiredKeysOf(convergence)],
  }, hooks);
  return { characters, storyline, convergence, pages };
}

async function runCalls(
  calls: DeltaCall[],
  ctx: DeltaBuildContext,
  generators: DeltaGenerators,
  diff: BriefDiff | null,
  state: RunState,
): Promise<void> {
  await limitConcurrency(calls, env.warroomGenConcurrency, async (call) => {
    await executeCall(call, ctx, generators, diff, state);
  });
}

async function regenerateStageBranches(
  ctx: DeltaBuildContext,
  generators: DeltaGenerators,
  diff: BriefDiff | null,
  state: RunState,
): Promise<void> {
  const brief = storyDiff(diff, ctx, false);
  const revised = state.revisions.filter((revision) => revision.decision === 'revise');
  const substituted = revised.filter((revision) => revision.origin === 'substitution');
  const modelled = revised.filter((revision) => revision.origin !== 'substitution');
  for (const parent of substituted) {
    for (const child of childBranches(ctx, parent.inject_key)) {
      if (state.revisions.some((revision) => revision.inject_id === child.id)) continue;
      if (child.provenance !== 'ai_owned') {
        state.flags.push(flagFor(child, brief, ctx));
        continue;
      }
      const next = substitutePair(child.title, child.content, brief.renamed_entities);
      if (!next.changed) continue;
      const revision = reviseFromSource(
        toSource({ ...child, title: next.title, content: next.content }, null),
        SUBSTITUTION_REASON,
        { title: next.title, content: next.content },
        ctx.edit_number,
      );
      revision.origin = 'substitution';
      state.revisions.push(revision);
    }
  }
  const parents = new Map<string, string>();
  for (const revision of modelled) {
    const source = ctx.injects.find((inject) => inject.id === revision.inject_id);
    if (!source) continue;
    const children = childBranches(ctx, source.inject_key);
    if (source.requires_response || children.some((child) => child.provenance === 'ai_owned')) {
      parents.set(source.inject_key, revision.new?.title ?? source.title);
    }
  }
  for (const inject of [
    ...state.generated.layer_injects,
    ...Object.values(state.generated.team_storylines).flat(),
  ]) {
    if (!inject.requires_response) continue;
    const key = keyOf(inject);
    if (key) parents.set(key, inject.title);
  }
  const retired = state.revisions.filter((revision) => revision.decision === 'retire');
  const retireParents = new Set<string>([
    ...retired.map((revision) => revision.inject_key),
    ...parents.keys(),
  ]);
  for (const parent of retireParents) {
    for (const child of childBranches(ctx, parent)) {
      if (state.revisions.some((revision) => revision.inject_id === child.id)) continue;
      if (child.provenance !== 'ai_owned') {
        state.flags.push(flagFor(child, brief, ctx));
        continue;
      }
      state.revisions.push(
        retireRevision(toSource(child, brief), 'Branch of a revised or retired parent.'),
      );
    }
  }
  const entries = [...parents.entries()];
  if (entries.length === 0) return;
  const branches = await limitConcurrency(
    entries,
    env.warroomGenConcurrency,
    async ([parentKey, parentTitle]) =>
      generators.regenerateBranches({ parentKey, parentTitle, diff: brief }),
  );
  for (let i = 0; i < entries.length; i++) {
    const parentKey = entries[i]?.[0];
    if (!parentKey) continue;
    const withParent = (branches[i] ?? []).map((inject) => ({
      ...inject,
      delivery_config: { ...(inject.delivery_config ?? {}), parent_inject_key: parentKey },
    }));
    state.generated.branches.push(...stampNew(ctx, withParent, `branch:${parentKey}`, state));
  }
}

function substitutionRevisions(
  ctx: DeltaBuildContext,
  diff: BriefDiff,
  revisedLayers: ReadonlySet<string>,
): SetupRevision[] {
  const out: SetupRevision[] = [];
  for (const inject of ctx.injects) {
    if (inject.provenance !== 'ai_owned') continue;
    if (revisedLayers.has(inject.layer)) continue;
    const next = substitutePair(inject.title, inject.content, diff.renamed_entities);
    if (!next.changed) continue;
    const revision = reviseFromSource(
      toSource({ ...inject, title: next.title, content: next.content }, null),
      SUBSTITUTION_REASON,
      { title: next.title, content: next.content },
      ctx.edit_number,
    );
    revision.origin = 'substitution';
    out.push(revision);
  }
  return out;
}

function substitutionFlags(ctx: DeltaBuildContext, diff: BriefDiff): SetupFlag[] {
  const out: SetupFlag[] = [];
  for (const inject of ctx.injects) {
    if (inject.provenance === 'ai_owned') continue;
    const next = substitutePair(inject.title, inject.content, diff.renamed_entities);
    if (!next.changed) continue;
    out.push({
      inject_id: inject.id,
      inject_key: inject.inject_key,
      provenance: inject.provenance === 'unverified' ? 'unverified' : 'hand_edited',
      reason: 'A renamed entity appears in content that was not rewritten.',
      suggestion: { title: next.title, content: next.content },
    });
  }
  return out;
}

function pageSubstitutionFlags(
  ctx: DeltaBuildContext,
  diff: BriefDiff,
  revisedPages: ReadonlySet<string>,
): SetupFlag[] {
  return ctx.pages
    .filter((page) => !revisedPages.has(page.org_key))
    .flatMap((page) => {
      const next = substituteText(page.historyText, diff.renamed_entities);
      if (next === page.historyText) return [];
      return [
        {
          inject_id: `page:${page.org_key}`,
          reason: 'A renamed entity appears in this page history.',
          provenance: 'hand_edited' as const,
          suggestion: { content: next },
        },
      ];
    });
}

function textUpdates(ctx: DeltaBuildContext): TextUpdate[] {
  const out: TextUpdate[] = [];
  for (const change of ctx.delta.changed_text) {
    if (change.field === 'description' && change.team_uid) {
      const org = ctx.edited.organisations.find((item) => item.org_key === change.key);
      const team = org?.teams.find((item) => item.team_uid === change.team_uid);
      if (team) {
        out.push({
          org_key: change.key,
          field: 'team_description',
          team_uid: change.team_uid,
          value: team.description,
        });
      }
      continue;
    }
    if (change.field === 'description') {
      const rival = ctx.edited.competitors.find((item) => item.org_key === change.key);
      if (rival?.description) {
        out.push({ org_key: change.key, field: 'stance', value: rival.description });
      }
    }
    if (change.field === 'wants') {
      const pressure = ctx.edited.pressure_organisations.find(
        (item) => item.org_key === change.key,
      );
      if (typeof pressure?.wants === 'string') {
        out.push({ org_key: change.key, field: 'mandate', value: pressure.wants });
      }
    }
  }
  return out;
}

function childBranches(ctx: DeltaBuildContext, parentKey: string): DeltaInject[] {
  return ctx.injects.filter((inject) => inject.layer === `branch:${parentKey}`);
}

function handEditedSources(
  ctx: DeltaBuildContext,
  state: RunState,
): Array<{
  conditions_to_appear?: unknown;
  conditions_to_cancel?: unknown;
  retired?: boolean;
}> {
  const retired = new Set(ctx.plan.injects.retire.map((row) => row.inject_id));
  for (const revision of state.revisions) {
    if (revision.decision === 'retire') retired.add(revision.inject_id);
  }
  return ctx.injects
    .filter((inject) => inject.provenance !== 'ai_owned')
    .map((inject) => ({
      conditions_to_appear: inject.conditions_to_appear,
      conditions_to_cancel: inject.conditions_to_cancel,
      retired: retired.has(inject.id),
    }));
}

function sourceMap(ctx: DeltaBuildContext): Map<string, RevisionSource> {
  return new Map(ctx.injects.map((inject) => [inject.id, toSource(inject, null)]));
}

function enrichDiff(diff: BriefDiff, premise: string | null): BriefDiff {
  if (!premise || diff.added_premises.includes(premise)) return diff;
  return { ...diff, added_premises: [...diff.added_premises, premise] };
}

function briefText(ctx: DeltaBuildContext, which: 'old' | 'new'): string {
  const crisis = which === 'new' ? ctx.edited.crisis : ctx.baseline_crisis;
  return `${crisis.crisis_type}\n${crisis.context}`;
}

function orgName(ctx: DeltaBuildContext, orgKey: string): string {
  return (
    ctx.edited.organisations.find((org) => org.org_key === orgKey)?.display_name ??
    ctx.edited.pressure_organisations.find((org) => org.org_key === orgKey)?.display_name ??
    orgKey
  );
}

function startState(ctx: DeltaBuildContext, carry?: DeltaCarry): RunState {
  return {
    revisions: [],
    flags: [],
    generated: blankGenerated(),
    text_updates: [],
    narrative_update: null,
    objective_updates: [],
    setup_source_update: null,
    stakeholder_updates: [],
    priorRetired: new Set(carry?.retiredKeys ?? []),
    factSheet: ctx.fact_sheet,
  };
}

function retiredKeysOf(output: SetupEditStageOutput): string[] {
  return output.revisions
    .filter((revision) => revision.decision === 'retire')
    .map((revision) => revision.inject_key);
}

function scrubGeneratedConditions(ctx: DeltaBuildContext, state: RunState): void {
  const active = activeKeys(ctx, state);
  const scrub = (inject: SocialInject): SocialInject => ({
    ...inject,
    conditions_to_appear: filterConditions(
      inject.conditions_to_appear,
      active,
    ) as SocialInject['conditions_to_appear'],
    conditions_to_cancel: filterConditions(
      inject.conditions_to_cancel,
      active,
    ) as SocialInject['conditions_to_cancel'],
  });
  state.generated.layer_injects = state.generated.layer_injects.map(scrub);
  state.generated.shared_injects = state.generated.shared_injects.map(scrub);
  state.generated.gates = state.generated.gates.map(scrub);
  state.generated.branches = state.generated.branches.map(scrub);
  state.generated.stakeholder_injects = state.generated.stakeholder_injects.map(scrub);
  state.generated.pressure_injects = state.generated.pressure_injects.map(scrub);
  state.generated.dependency_injects = state.generated.dependency_injects.map(scrub);
  for (const [team, injects] of Object.entries(state.generated.team_storylines)) {
    state.generated.team_storylines[team] = injects.map(scrub);
  }
  for (const revision of state.revisions) {
    if (revision.decision !== 'revise' || !revision.new) continue;
    revision.new.conditions_to_appear = filterConditions(revision.new.conditions_to_appear, active);
    revision.new.conditions_to_cancel = filterConditions(revision.new.conditions_to_cancel, active);
  }
}

function finish(
  ctx: DeltaBuildContext,
  state: RunState,
  diff: BriefDiff | null,
  premise: string | null,
): SetupEditStageOutput {
  const generated = state.generated;
  const factSheet = state.factSheet ?? ctx.fact_sheet;
  const storylineInjects = [
    ...Object.values(generated.team_storylines).flat(),
    ...generated.layer_injects,
    ...generated.stakeholder_injects,
    ...generated.dependency_injects,
  ];
  const hasWork =
    state.revisions.length > 0 ||
    state.flags.length > 0 ||
    state.text_updates.length > 0 ||
    state.narrative_update != null ||
    state.objective_updates.length > 0 ||
    state.setup_source_update != null ||
    state.stakeholder_updates.length > 0 ||
    generated.personas.length > 0 ||
    generated.charters.length > 0 ||
    storylineInjects.length > 0 ||
    generated.shared_injects.length > 0 ||
    generated.gates.length > 0 ||
    generated.pages.length > 0 ||
    generated.branches.length > 0 ||
    generated.pressure_injects.length > 0 ||
    generated.dependency_edges.length > 0 ||
    generated.dependency_injects.length > 0 ||
    state.peace_period != null ||
    diff != null;
  return {
    revisions: state.revisions,
    flags: state.flags,
    generated,
    text_updates: state.text_updates,
    narrative_update: state.narrative_update,
    objective_updates: state.objective_updates,
    setup_source_update: state.setup_source_update,
    stakeholder_updates: state.stakeholder_updates,
    brief_diff: diff,
    swap_premise: premise,
    skipped: !hasWork,
    personas: generated.personas,
    fact_sheet: factSheet,
    communities: [],
    countries: [],
    injects: storylineInjects,
    team_storylines: generated.team_storylines,
    team_charters: generated.charters,
    stakeholders: generated.stakeholders,
    stakeholder_injects: [...generated.stakeholder_injects, ...generated.pressure_injects],
    persona_twins: [],
    orgs: [],
    sop_steps: [],
    decision_context: EMPTY_DECISION,
    pressure_organisations: generated.spokespersons.map((link) => ({
      display_name: orgName(ctx, link.org_key),
      org_key: link.org_key,
      spokesperson_stakeholder_id: link.stakeholder_id,
    })),
    sharedInjects: generated.shared_injects,
    convergenceGates: generated.gates,
    narrative: state.narrative_update
      ? {
          title: state.narrative_update.title,
          description: state.narrative_update.description,
          briefing: state.narrative_update.briefing,
        }
      : null,
    objectives: state.objective_updates.map((objective) => ({
      objective_id: objective.objective_id,
      objective_name: objective.fields.objective_name,
      description: objective.fields.description,
      weight: objective.fields.weight,
    })),
    dimensionLabels: null,
    org_page: generated.pages.length > 0 ? { orgs: generated.pages } : null,
    pressure_injects: generated.pressure_injects,
    ...(state.peace_period ? { peace_period: state.peace_period } : {}),
  };
}
