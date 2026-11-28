import type { PeaceFeed } from '../../../shared/peaceFeed.js';
import type { FactSheet, SocialInject } from '../socialCrisisGeneratorService.js';
import { emptyBriefDiff, type BriefDiff } from './affectedLayers.js';
import {
  allocateFreshKeys,
  stampEditGen,
  substitutePair,
  type RevisionSource,
  type SetupFlag,
  type SetupRevision,
} from './briefRevisionCore.js';
import type {
  DeltaBuildContext,
  DeltaInject,
  GeneratedRows,
  NarrativeUpdate,
  ObjectiveUpdate,
  StakeholderTextUpdate,
  TextUpdate,
} from './deltaBuildTypes.js';
import type { SetupCrisis } from './setupSnapshotCore.js';

/** Mutable output of one setup-edit stage. Call handlers and the stage runner share it. */
export interface RunState {
  revisions: SetupRevision[];
  flags: SetupFlag[];
  generated: GeneratedRows;
  text_updates: TextUpdate[];
  narrative_update: NarrativeUpdate | null;
  objective_updates: ObjectiveUpdate[];
  setup_source_update: SetupCrisis | null;
  stakeholder_updates: StakeholderTextUpdate[];
  priorRetired: Set<string>;
  factSheet?: FactSheet;
  peace_period?: PeaceFeed;
}

export function stampNew(
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
    ...state.generated.dependency_injects.map(keyOf),
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
    return {
      ...inject,
      gen_layer: layer,
      delivery_config: row.delivery_config as SocialInject['delivery_config'],
    };
  });
}

export function flagFor(inject: DeltaInject, diff: BriefDiff, ctx: DeltaBuildContext): SetupFlag {
  const provenance = inject.provenance === 'unverified' ? 'unverified' : 'hand_edited';
  const swap = ctx.plan.primary_swap;
  const reason =
    inject.provenance === 'unverified'
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
    ...(suggestion.changed
      ? { suggestion: { title: suggestion.title, content: suggestion.content } }
      : {}),
  };
}

export function toSource(inject: DeltaInject, diff: BriefDiff | null): RevisionSource {
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

export function activeKeys(ctx: DeltaBuildContext, state: RunState): Set<string> {
  const retired = new Set(
    state.revisions
      .filter((revision) => revision.decision === 'retire')
      .map((revision) => revision.inject_key),
  );
  for (const key of state.priorRetired) retired.add(key);
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

export function keyOf(inject: { delivery_config?: { inject_key?: unknown } | null }): string {
  const key = inject.delivery_config?.inject_key;
  return typeof key === 'string' ? key : '';
}

export function storyDiff(diff: BriefDiff | null, ctx: DeltaBuildContext, forceStory: boolean): BriefDiff {
  const base = diff ?? (ctx.plan.primary_swap ? swapOnlyDiff(ctx) : emptyBriefDiff('facts'));
  if (forceStory && ctx.plan.primary_swap && base.severity !== 'story') {
    return { ...base, severity: 'story' };
  }
  return base;
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
