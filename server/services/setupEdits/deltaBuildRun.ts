import { env } from '../../env.js';
import { limitConcurrency } from '../../lib/limitConcurrency.js';
import type { ObjectiveDef, SocialInject } from '../socialCrisisGeneratorService.js';
import { affectedLayers, mentionsBriefChange, type BriefDiff } from './affectedLayers.js';
import {
  allocateFreshKeys,
  clampTriggerTime,
  downgradeReferencedRetires,
  filterConditions,
  keepRevision,
  mentionsCentreRole,
  mergeFactSheet,
  retireRevision,
  reviseFromSource,
  stampEditGen,
  substitutePair,
  substituteText,
  type RevisionSource,
  type SetupFlag,
  type SetupRevision,
} from './briefRevisionCore.js';
import type {
  DeltaBuildContext,
  DeltaGenerators,
  DeltaInject,
  GeneratedRows,
  LayerRevisionResult,
  NarrativeUpdate,
  ObjectiveUpdate,
  SetupEditStageOutput,
  StakeholderTextUpdate,
  TextUpdate,
} from './deltaBuildTypes.js';
import { blankGenerated } from './deltaBuildTypes.js';
import type { SetupCrisis } from './setupSnapshotCore.js';

export type DeltaStageName = 'characters' | 'storyline' | 'convergence' | 'pages';

const EMPTY_DECISION = { leakiness: 0.5, labour_signal: false, product_safety_signal: false };

export interface DeltaCarry {
  briefDiff: BriefDiff | null;
  swapPremise: string | null;
}

/** Every AI call this edit needs once the brief diff is known. `diff` null plans only structural work. */
export function listDeltaCalls(ctx: DeltaBuildContext, diff: BriefDiff | null): DeltaCall[] {
  const calls: DeltaCall[] = [];
  const { delta, plan } = ctx;
  const swap = plan.primary_swap;

  if (delta.brief_changed || swap) calls.push({ op: 'brief_diff' });
  for (const country of delta.new_countries) calls.push({ op: 'personas', country });
  if (diff && diff.severity !== 'cosmetic') calls.push({ op: 'fact_sheet' });
  if (diff && (diff.new_groups?.length ?? 0) > 0) calls.push({ op: 'persona_groups' });

  for (const team of delta.added_teams) {
    calls.push({ op: 'charter', team_name: team.team_name, org_key: team.org_key });
    calls.push({
      op: 'team_storyline',
      team_name: team.team_name,
      org_key: team.org_key,
      country: orgCountry(ctx, team.org_key),
    });
  }
  for (const orgKey of delta.added_orgs) calls.push({ op: 'stakeholders', org_key: orgKey });
  for (const orgKey of delta.added_pressure) calls.push({ op: 'spokesperson', org_key: orgKey });
  if (delta.added_teams.length > 0) calls.push({ op: 'convergence_delta' });

  const layers = new Set<string>();
  if (diff && diff.severity !== 'cosmetic') {
    for (const layer of affectedLayers(diff, ctx.injects)) {
      if (!layer.startsWith('branch:')) layers.add(layer);
    }
  }
  if (swap) layers.add('backbone');
  const moved = new Map(delta.relocated_orgs.map((org) => [org.org_key, org.to_country]));
  for (const [orgKey, country] of moved) {
    for (const team of ctx.teams) {
      if (team.org_key !== orgKey) continue;
      layers.add(`team:${team.team_uid}`);
      void country;
    }
  }
  if (swap) {
    const keys = new Set(
      [swap.old_primary_key, swap.new_primary_previous_key].filter((key): key is string => !!key),
    );
    for (const team of ctx.teams) {
      if (!team.org_key || !keys.has(team.org_key)) continue;
      const layer = `team:${team.team_uid}`;
      const owned = ctx.injects.filter(
        (inject) => inject.layer === layer && inject.provenance === 'ai_owned',
      );
      if (owned.some((inject) => mentionsCentreRole(`${inject.title}\n${inject.content}`))) {
        layers.add(layer);
      }
    }
  }
  for (const layer of [...layers].sort()) {
    const teamUid = layer.startsWith('team:') ? layer.slice('team:'.length) : '';
    const team = ctx.teams.find((item) => item.team_uid === teamUid);
    const country = team?.org_key ? moved.get(team.org_key) : undefined;
    calls.push({ op: 'revise_layer', layer, ...(country ? { country } : {}) });
  }

  if (diff && diff.severity !== 'cosmetic' && stakeholdersAffected(ctx, diff)) {
    calls.push({ op: 'stakeholder_text' });
  }
  if (swap || diff?.severity === 'story') calls.push({ op: 'narrative' });

  const history = new Set<string>();
  for (const org of delta.relocated_orgs) history.add(org.org_key);
  if (swap?.new_primary_previous_key) history.add(swap.new_primary_previous_key);
  if (diff?.severity === 'story') {
    for (const page of ctx.pages) {
      if (mentionsBriefChange(page.historyText, diff)) history.add(page.org_key);
    }
  }
  for (const orgKey of [...history].sort()) {
    calls.push({
      op: 'page_history',
      org_key: orgKey,
      ...(moved.get(orgKey) ? { country: moved.get(orgKey) } : {}),
    });
  }

  const pageOrgs = [...delta.added_orgs, ...delta.added_rivals, ...delta.added_pressure];
  const size = Math.max(1, ctx.page_batch_size);
  for (let i = 0; i < pageOrgs.length; i += size) {
    calls.push({ op: 'pages', org_keys: pageOrgs.slice(i, i + size) });
  }
  return calls;
}

export type DeltaCall =
  | { op: 'brief_diff' }
  | { op: 'fact_sheet' }
  | { op: 'personas'; country: string }
  | { op: 'persona_groups' }
  | { op: 'charter'; team_name: string; org_key: string }
  | { op: 'team_storyline'; team_name: string; org_key: string; country?: string }
  | { op: 'stakeholders'; org_key: string }
  | { op: 'spokesperson'; org_key: string }
  | { op: 'revise_layer'; layer: string; country?: string }
  | { op: 'stakeholder_text' }
  | { op: 'convergence_delta' }
  | { op: 'narrative' }
  | { op: 'pages'; org_keys: string[] }
  | { op: 'page_history'; org_key: string; country?: string };

export function stageOfCall(call: DeltaCall): DeltaStageName {
  if (call.op === 'revise_layer') {
    if (call.layer === 'shared' || call.layer === 'gate') return 'convergence';
    if (call.layer.startsWith('pressure:')) return 'pages';
    return 'storyline';
  }
  if (call.op === 'convergence_delta' || call.op === 'narrative') return 'convergence';
  if (call.op === 'pages' || call.op === 'page_history') return 'pages';
  if (
    call.op === 'brief_diff' ||
    call.op === 'fact_sheet' ||
    call.op === 'personas' ||
    call.op === 'persona_groups'
  ) {
    return 'characters';
  }
  return 'storyline';
}

export async function runDeltaStage(
  stage: DeltaStageName,
  ctx: DeltaBuildContext,
  generators: DeltaGenerators,
  carry?: DeltaCarry,
): Promise<SetupEditStageOutput> {
  const state = startState(ctx);
  let diff = carry?.briefDiff ?? null;
  const premise = carry?.swapPremise ?? ctx.plan.primary_swap?.story.premise ?? null;

  if (stage === 'characters') {
    const structural = listDeltaCalls(ctx, null).filter((call) => stageOfCall(call) === 'characters');
    if (structural.some((call) => call.op === 'brief_diff')) {
      diff = enrichDiff(
        await generators.briefDiff({
          oldBrief: briefText(ctx, 'old'),
          newBrief: briefText(ctx, 'new'),
          factSheet: ctx.fact_sheet,
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
      (call) => stageOfCall(call) === 'characters' && (call.op === 'fact_sheet' || call.op === 'persona_groups'),
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

  state.revisions = downgradeReferencedRetires(
    state.revisions,
    handEditedSources(ctx),
    sourceMap(ctx),
    ctx.edit_number,
  );
  if (stage !== 'characters') await regenerateStageBranches(ctx, generators, diff, state);
  return finish(ctx, state, stage === 'characters' ? diff : null, stage === 'characters' ? premise : null);
}

export async function runDeltaBuild(
  ctx: DeltaBuildContext,
  generators: DeltaGenerators,
): Promise<Record<DeltaStageName, SetupEditStageOutput>> {
  const characters = await runDeltaStage('characters', ctx, generators);
  const carry: DeltaCarry = { briefDiff: characters.brief_diff, swapPremise: characters.swap_premise };
  const storyline = await runDeltaStage('storyline', ctx, generators, carry);
  const convergence = await runDeltaStage('convergence', ctx, generators, carry);
  const pages = await runDeltaStage('pages', ctx, generators, carry);
  return { characters, storyline, convergence, pages };
}

interface RunState {
  revisions: SetupRevision[];
  flags: SetupFlag[];
  generated: GeneratedRows;
  text_updates: TextUpdate[];
  narrative_update: NarrativeUpdate | null;
  objective_updates: ObjectiveUpdate[];
  setup_source_update: SetupCrisis | null;
  stakeholder_updates: StakeholderTextUpdate[];
  retiredBranchKeys: Set<string>;
  factSheet?: import('../socialCrisisGeneratorService.js').FactSheet;
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

async function executeCall(
  call: DeltaCall,
  ctx: DeltaBuildContext,
  generators: DeltaGenerators,
  diff: BriefDiff | null,
  state: RunState,
): Promise<void> {
  const crisis = ctx.edited.crisis.crisis_type;
  if (call.op === 'personas') {
    const personas = await generators.generatePersonas({
      country: call.country,
      crisis,
      takenHandles: ctx.taken_handles,
    });
    state.generated.personas.push(...personas.slice(0, 200));
    return;
  }
  if (call.op === 'persona_groups') {
    const groups = (diff?.new_groups ?? []).slice(0, 10);
    const personas = await generators.generatePersonaGroups({
      groups,
      crisis,
      takenHandles: [...ctx.taken_handles, ...state.generated.personas.map((persona) => persona.handle)],
    });
    state.generated.personas.push(...personas.slice(0, 10));
    return;
  }
  if (call.op === 'fact_sheet') {
    if (!diff) return;
    const revised = await generators.reviseFactSheet({
      factSheet: ctx.fact_sheet,
      diff,
      appendOnly: ctx.fact_sheet_trainer_edited,
    });
    state.factSheet = mergeFactSheet(ctx.fact_sheet, revised, diff, ctx.fact_sheet_trainer_edited);
    return;
  }
  if (call.op === 'charter') {
    const charter = await generators.generateCharter({
      teamName: call.team_name,
      orgName: orgName(ctx, call.org_key),
      crisis,
    });
    state.generated.charters.push({ ...charter, team_name: call.team_name, org_key: call.org_key });
    return;
  }
  if (call.op === 'team_storyline') {
    const injects = await generators.generateTeamStoryline({
      teamName: call.team_name,
      orgName: orgName(ctx, call.org_key),
      crisis,
      country: call.country,
    });
    const layer = `team:${teamUid(ctx, call.team_name) || call.team_name}`;
    state.generated.team_storylines[call.team_name] = stampNew(ctx, injects, layer, state);
    return;
  }
  if (call.op === 'stakeholders') {
    const result = await generators.generateStakeholders({
      orgKey: call.org_key,
      orgName: orgName(ctx, call.org_key),
      crisis,
      takenIds: ctx.taken_stakeholder_ids,
      takenEmails: ctx.taken_emails,
      takenHandles: ctx.taken_handles,
    });
    state.generated.stakeholders.push(...result.stakeholders);
    state.generated.stakeholder_injects.push(
      ...stampNew(ctx, result.injects, `stakeholder:${call.org_key}`, state),
    );
    return;
  }
  if (call.op === 'spokesperson') {
    const pressure = ctx.edited.pressure_organisations.find((org) => org.org_key === call.org_key);
    const result = await generators.generateSpokesperson({
      orgKey: call.org_key,
      name: pressure?.display_name ?? call.org_key,
      wants: pressure?.wants ?? '',
      crisis,
    });
    if (result.stakeholder) state.generated.stakeholders.push(result.stakeholder);
    state.generated.spokespersons.push({
      org_key: call.org_key,
      stakeholder_id: result.stakeholder?.id,
    });
    state.generated.pressure_injects.push(
      ...stampNew(ctx, result.injects, `pressure:${call.org_key}`, state),
    );
    return;
  }
  if (call.op === 'revise_layer') {
    if (!diff && !ctx.plan.primary_swap && !call.country) return;
    const brief = storyDiff(diff, ctx, call.layer === 'backbone' && !!ctx.plan.primary_swap);
    applyLayer(ctx, state, call.layer, call.country, brief, await generators.reviseLayer({
      layer: call.layer,
      owned: promptInjects(ctx, call.layer, 'ai_owned', brief),
      handEdited: promptInjects(ctx, call.layer, 'context', brief),
      diff: brief,
      country: call.country,
    }));
    return;
  }
  if (call.op === 'stakeholder_text') {
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
    return;
  }
  if (call.op === 'convergence_delta') {
    const result = await generators.convergenceDelta({
      newTeams: ctx.delta.added_teams.map((team) => team.team_name),
      existingTeams: ctx.teams.map((team) => team.team_name),
      crisis,
    });
    state.generated.shared_injects.push(...stampNew(ctx, result.shared.slice(0, 4), 'shared', state));
    state.generated.gates.push(...stampNew(ctx, result.gates.slice(0, 2), 'gate', state));
    return;
  }
  if (call.op === 'narrative') {
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
    return;
  }
  if (call.op === 'pages') {
    const orgs = call.org_keys.map((orgKey) => pageSubject(ctx, orgKey));
    const pages = await generators.generatePages({ orgs, crisis });
    state.generated.pages.push(...pages);
    return;
  }
  if (call.op === 'page_history') {
    const page = ctx.pages.find((item) => item.org_key === call.org_key);
    const brief = diff ?? swapOnlyDiff(ctx);
    const history = await generators.revisePageHistory({
      orgKey: call.org_key,
      history: page?.history ?? [],
      diff: storyDiff(brief, ctx, call.org_key === ctx.plan.primary_swap?.new_primary_previous_key),
      country: call.country,
    });
    state.generated.pages.push({ org_key: call.org_key, branded_history: history });
  }
}

function applyLayer(
  ctx: DeltaBuildContext,
  state: RunState,
  layer: string,
  _country: string | undefined,
  diff: BriefDiff,
  result: LayerRevisionResult,
): void {
  const byId = new Map(ctx.injects.filter((inject) => inject.layer === layer).map((inject) => [inject.id, inject]));
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
      state.revisions.push(retireRevision(source, decision.reason || 'Retired by the brief revision.'));
      continue;
    }
    const time = clampTriggerTime(inject.trigger_time_minutes, decision.trigger_time_minutes, diff.severity);
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
  const fresh = (result.new_injects ?? []).slice(0, 3);
  state.generated.layer_injects.push(...stampNew(ctx, fresh, layer, state));
}

async function regenerateStageBranches(
  ctx: DeltaBuildContext,
  generators: DeltaGenerators,
  diff: BriefDiff | null,
  state: RunState,
): Promise<void> {
  const brief = diff ?? (ctx.plan.primary_swap ? swapOnlyDiff(ctx) : null);
  if (!brief) return;
  const revised = state.revisions.filter((revision) => revision.decision === 'revise');
  const retired = state.revisions.filter((revision) => revision.decision === 'retire');
  const parents = new Map<string, string>();
  for (const revision of revised) {
    const source = ctx.injects.find((inject) => inject.id === revision.inject_id);
    if (!source) continue;
    if (source.requires_response || childBranches(ctx, source.inject_key).length > 0) {
      parents.set(source.inject_key, revision.new?.title ?? source.title);
    }
  }
  for (const inject of state.generated.layer_injects) {
    if (!inject.requires_response) continue;
    const key = keyOf(inject);
    if (key) parents.set(key, inject.title);
  }
  for (const inject of Object.values(state.generated.team_storylines).flat()) {
    if (!inject.requires_response) continue;
    const key = keyOf(inject);
    if (key) parents.set(key, inject.title);
  }
  const retireParents = new Set<string>([...retired.map((revision) => revision.inject_key), ...parents.keys()]);
  for (const parent of retireParents) {
    for (const child of childBranches(ctx, parent)) {
      if (state.revisions.some((revision) => revision.inject_id === child.id)) continue;
      state.revisions.push(retireRevision(toSource(child, brief), 'Branch of a revised or retired parent.'));
    }
  }
  const entries = [...parents.entries()];
  const branches = await limitConcurrency(entries, env.warroomGenConcurrency, async ([parentKey, parentTitle]) =>
    generators.regenerateBranches({ parentKey, parentTitle, diff: brief }),
  );
  for (let i = 0; i < entries.length; i++) {
    const parentKey = entries[i][0];
    const withParent = (branches[i] ?? []).map((inject) => ({
      ...inject,
      delivery_config: { ...(inject.delivery_config ?? {}), parent_inject_key: parentKey },
    }));
    state.generated.branches.push(...stampNew(ctx, withParent, `branch:${parentKey}`, state));
  }
}

function stampNew(
  ctx: DeltaBuildContext,
  injects: SocialInject[],
  layer: string,
  state: RunState,
): SocialInject[] {
  const taken = [
    ...ctx.active_keys,
    ...state.generated.layer_injects.map(keyOf),
    ...state.generated.shared_injects.map(keyOf),
    ...state.generated.gates.map(keyOf),
    ...state.generated.branches.map(keyOf),
    ...state.generated.stakeholder_injects.map(keyOf),
    ...state.generated.pressure_injects.map(keyOf),
    ...Object.values(state.generated.team_storylines).flat().map(keyOf),
  ].filter((key): key is string => !!key);
  const stamped = allocateFreshKeys(injects, taken);
  return stamped.map((inject) => {
    const delivery = inject.delivery_config;
    const row = stampEditGen(
      {
        title: inject.title,
        content: inject.content,
        type: inject.type,
        severity: inject.severity,
        trigger_time_minutes: inject.trigger_time_minutes,
        target_teams: inject.target_teams,
        inject_scope: inject.inject_scope,
        conditions_to_appear: inject.conditions_to_appear,
        conditions_to_cancel: inject.conditions_to_cancel,
        delivery_config: delivery,
      },
      layer,
      ctx.edit_number,
    );
    return { ...inject, gen_layer: layer, delivery_config: row.delivery_config as SocialInject['delivery_config'] };
  });
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
    out.push(
      reviseFromSource(
        toSource({ ...inject, title: next.title, content: next.content }, null),
        'Renamed entity substituted.',
        { title: next.title, content: next.content },
        ctx.edit_number,
      ),
    );
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
      const pressure = ctx.edited.pressure_organisations.find((item) => item.org_key === change.key);
      if (typeof pressure?.wants === 'string') {
        out.push({ org_key: change.key, field: 'mandate', value: pressure.wants });
      }
    }
  }
  return out;
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
    .filter((inject) => (mode === 'ai_owned' ? inject.provenance === 'ai_owned' : inject.provenance !== 'ai_owned'))
    .map((inject) => {
      const substituted =
        mode === 'ai_owned' && diff.severity !== 'cosmetic'
          ? substitutePair(inject.title, inject.content, diff.renamed_entities)
          : { title: inject.title, content: inject.content, changed: false };
      return {
        id: inject.id,
        inject_key: inject.inject_key,
        title: substituted.title,
        content: substituted.content.slice(0, 800),
        trigger_time_minutes: inject.trigger_time_minutes,
        conditions_to_appear: inject.conditions_to_appear,
        conditions_to_cancel: inject.conditions_to_cancel,
      };
    });
}

function flagFor(inject: DeltaInject, diff: BriefDiff, ctx: DeltaBuildContext): SetupFlag {
  const provenance = inject.provenance === 'unverified' ? 'unverified' : 'hand_edited';
  const swap = ctx.plan.primary_swap;
  const reason = inject.provenance === 'unverified'
    ? 'Unverified War Room row. The revision stays on the original.'
    : swap
      ? `${swap.story.premise} This hand-edited inject was left unchanged.`
      : 'Hand-edited content was left unchanged and may contradict the new brief.';
  const suggestion =
    diff.severity !== 'cosmetic'
      ? substitutePair(inject.title, inject.content, diff.renamed_entities)
      : { title: inject.title, content: inject.content, changed: false };
  return {
    inject_id: inject.id,
    inject_key: inject.inject_key,
    provenance,
    reason,
    ...(suggestion.changed ? { suggestion: { title: suggestion.title, content: suggestion.content } } : {}),
  };
}

function stakeholdersAffected(ctx: DeltaBuildContext, diff: BriefDiff): boolean {
  const layers = new Set(affectedLayers(diff, ctx.injects));
  return ctx.stakeholders.some(
    (stakeholder) =>
      layers.has(`stakeholder:${stakeholder.id}`) ||
      mentionsBriefChange(`${stakeholder.grievance}\n${stakeholder.knowledge.join('\n')}`, diff),
  );
}

function childBranches(ctx: DeltaBuildContext, parentKey: string): DeltaInject[] {
  return ctx.injects.filter((inject) => inject.layer === `branch:${parentKey}`);
}

function handEditedSources(ctx: DeltaBuildContext): Array<{
  conditions_to_appear?: unknown;
  conditions_to_cancel?: unknown;
  retired?: boolean;
}> {
  const retired = new Set(ctx.plan.injects.retire.map((row) => row.inject_id));
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

function toSource(inject: DeltaInject, diff: BriefDiff | null): RevisionSource {
  const substituted =
    diff && diff.severity !== 'cosmetic' && inject.provenance === 'ai_owned'
      ? substitutePair(inject.title, inject.content, diff.renamed_entities)
      : { title: inject.title, content: inject.content, changed: false };
  return {
    id: inject.id,
    inject_key: inject.inject_key,
    layer: inject.layer,
    title: substituted.title,
    content: substituted.content,
    trigger_time_minutes: inject.trigger_time_minutes,
    conditions_to_appear: inject.conditions_to_appear,
    conditions_to_cancel: inject.conditions_to_cancel,
    delivery_config: inject.delivery_config,
    has_history: inject.has_history,
    type: inject.type,
    severity: inject.severity,
    inject_scope: inject.inject_scope,
    target_teams: inject.target_teams,
    app: inject.app,
  };
}

function activeKeys(ctx: DeltaBuildContext, state: RunState): Set<string> {
  const retired = new Set(state.revisions.filter((revision) => revision.decision === 'retire').map((revision) => revision.inject_key));
  for (const row of ctx.plan.injects.retire) retired.add(row.inject_key);
  const keys = new Set(ctx.active_keys.filter((key) => !retired.has(key)));
  for (const inject of [
    ...state.generated.layer_injects,
    ...state.generated.shared_injects,
    ...state.generated.gates,
    ...state.generated.branches,
  ]) {
    const key = keyOf(inject);
    if (key) keys.add(key);
  }
  return keys;
}

function keyOf(inject: { delivery_config?: { inject_key?: unknown } | null }): string {
  const key = inject.delivery_config?.inject_key;
  return typeof key === 'string' ? key : '';
}

function enrichDiff(diff: BriefDiff, premise: string | null): BriefDiff {
  if (!premise || diff.added_premises.includes(premise)) return diff;
  return { ...diff, added_premises: [...diff.added_premises, premise] };
}

function storyDiff(diff: BriefDiff | null, ctx: DeltaBuildContext, forceStory: boolean): BriefDiff {
  const base = diff ?? swapOnlyDiff(ctx);
  if (!forceStory) return base;
  return base.severity === 'story' ? base : { ...base, severity: 'story' };
}

function swapOnlyDiff(ctx: DeltaBuildContext): BriefDiff {
  const premise = ctx.plan.primary_swap?.story.premise ?? '';
  return {
    severity: 'story',
    fact_changes: [],
    renamed_entities: [],
    added_premises: premise ? [premise] : [],
    removed_premises: [],
  };
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

function orgCountry(ctx: DeltaBuildContext, orgKey: string): string | undefined {
  return ctx.edited.organisations.find((org) => org.org_key === orgKey)?.country;
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
    return { org_key: orgKey, name: org?.display_name ?? orgKey, role: 'pressure', description: org?.wants };
  }
  if (ctx.delta.added_rivals.includes(orgKey)) {
    const org = ctx.edited.competitors.find((item) => item.org_key === orgKey);
    return { org_key: orgKey, name: org?.name ?? orgKey, role: 'rival', description: org?.description };
  }
  const org = ctx.edited.organisations.find((item) => item.org_key === orgKey);
  return { org_key: orgKey, name: org?.display_name ?? orgKey, role: 'ally' };
}

function startState(ctx: DeltaBuildContext): RunState & { factSheet?: import('../socialCrisisGeneratorService.js').FactSheet } {
  return {
    revisions: [],
    flags: [],
    generated: blankGenerated(),
    text_updates: [],
    narrative_update: null,
    objective_updates: [],
    setup_source_update: null,
    stakeholder_updates: [],
    retiredBranchKeys: new Set(),
    factSheet: ctx.fact_sheet,
  };
}

function finish(
  ctx: DeltaBuildContext,
  state: RunState & { factSheet?: import('../socialCrisisGeneratorService.js').FactSheet },
  diff: BriefDiff | null,
  premise: string | null,
): SetupEditStageOutput {
  const generated = state.generated;
  const factSheet = state.factSheet ?? ctx.fact_sheet;
  const storylineInjects = [
    ...Object.values(generated.team_storylines).flat(),
    ...generated.layer_injects,
    ...generated.stakeholder_injects,
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
  };
}
