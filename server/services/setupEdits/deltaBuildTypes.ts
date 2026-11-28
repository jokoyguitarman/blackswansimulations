import type { Stakeholder } from '../../lib/stakeholderContract.js';
import type { NPCPersona, FactSheet, ObjectiveDef, SocialInject } from '../socialCrisisGeneratorService.js';
import type { TeamCharterWire } from '../warroomBuild/wireSchemas.js';
import type { BriefDiff } from './affectedLayers.js';
import type { SetupFlag, SetupRevision } from './briefRevisionCore.js';
import type { RemapPlan } from './remapPlanner.js';
import type { SetupDelta } from './setupDeltaCore.js';
import type { PeaceFeed } from '../../../shared/peaceFeed.js';
import type { TeamDependencyEdge } from '../../../shared/teamDependencies.js';
import { usablePeaceFeed } from '../generation/peaceFeedCore.js';
import { asRecord, textOf } from './jsonValue.js';
import type { SetupCrisis, SetupSnapshot } from './setupSnapshotCore.js';

/**
 * What a setup-edit build stores on `warroom_build_outputs` for WP10.
 * The build never writes the scenario. WP10 reads every stage and applies:
 *
 * - `revisions[]` — one row per inject the brief pass kept, revised, or retired.
 *   `accepted` is true (decision O5). A Review rejection sets it false; the
 *   original row then stays active and unretired (`applyRevisionDecision`).
 *   `write: 'cow'` retires the source and inserts `new` under the same
 *   `inject_key` when the row has history. `write: 'in_place'` updates the
 *   source. `write: 'retire'` retires it. `write: 'none'` changes nothing.
 *   `new.delivery_config` keeps `inject_key`, `app`, `response_rubric` and
 *   `mood_ladder`. `carried.escalation` tells WP10 to copy chain rows on `cow`.
 *   `new.delivery_config.gen` is `{ layer, edit, hash }`.
 * - `flags[]` — hand-edited or unverified injects that contradict the new brief.
 *   They are not rewritten. `suggestion` is the deterministic rename, if any.
 * - `generated` — new rows only (personas, charters, storylines, stakeholders,
 *   shared injects, gates, pages, branches, up to 3 injects per revised layer).
 *   Existing rows are not copied here.
 * - `text_updates` — rival stance, pressure mandate, and team description.
 *   No AI call.
 * - `narrative_update` / `objective_updates` — severity `story` or a primary swap.
 *   `briefing_kept` means WP10 leaves the trainer's briefing. Objectives with
 *   session scores are `cow`; the rest are `in_place`.
 * - `setup_source_update` — the edited brief, including a cosmetic change.
 * - `stakeholder_updates` — grievance and knowledge only.
 * - `brief_diff` — the characters stage only, so later stages do not call again.
 * - `skipped` — the stage had nothing to generate or revise.
 *
 * `decision_context` and dimension labels on these outputs are placeholders.
 * WP10 must not write them. `player_roles` and `call_coverage_gate` are absent.
 */

export interface DeltaInject {
  id: string;
  inject_key: string;
  layer: string;
  title: string;
  content: string;
  trigger_time_minutes: number | null;
  conditions_to_appear?: unknown;
  conditions_to_cancel?: unknown;
  delivery_config: Record<string, unknown>;
  generation_source: string | null;
  provenance: 'ai_owned' | 'hand_edited' | 'unverified';
  has_history: boolean;
  requires_response: boolean;
  target_teams: string[];
  type: string;
  severity: string;
  inject_scope: string;
  app: string;
}

export interface DeltaTeam {
  team_uid: string;
  team_name: string;
  org_key: string | null;
}

export interface DeltaStakeholder {
  id: string;
  name: string;
  grievance: string;
  knowledge: string[];
  org_key: string | null;
}

export interface DeltaPage {
  org_key: string;
  display_name: string;
  historyText: string;
  history: unknown;
  is_primary: boolean;
}

export interface DeltaBuildContext {
  /** The edit must still be open when a stage starts. Absent in pure unit fixtures, which are treated as open. */
  edit_status?: string;
  edit_number: number;
  delta: SetupDelta;
  plan: RemapPlan;
  edited: SetupSnapshot;
  /** The brief before this edit. The diff call compares it with `edited.crisis`. */
  baseline_crisis: { crisis_type: string; context: string };
  injects: DeltaInject[];
  teams: DeltaTeam[];
  stakeholders: DeltaStakeholder[];
  personas: NPCPersona[];
  fact_sheet: FactSheet;
  fact_sheet_trainer_edited: boolean;
  briefing: string;
  briefing_trainer_edited: boolean;
  narrative: { title: string; description: string; briefing: string };
  objectives: Array<ObjectiveDef & { has_scores: boolean }>;
  pages: DeltaPage[];
  taken_handles: string[];
  taken_emails: string[];
  taken_stakeholder_ids: string[];
  active_keys: string[];
  page_batch_size: number;
}

export interface LayerDecision {
  inject_id: string;
  decision: 'keep' | 'revise' | 'retire';
  title?: string;
  content?: string;
  trigger_time_minutes?: number;
  conditions_to_appear?: unknown;
  conditions_to_cancel?: unknown;
  reason?: string;
}

export interface LayerRevisionResult {
  decisions: LayerDecision[];
  new_injects: SocialInject[];
}

export interface LayerPromptInject {
  id: string;
  inject_key: string;
  title: string;
  content: string;
  trigger_time_minutes: number | null;
  conditions_to_appear?: unknown;
  conditions_to_cancel?: unknown;
}

export interface DeltaGenerators {
  briefDiff(input: {
    oldBrief: string;
    newBrief: string;
    factSheet: FactSheet;
    /** Layer names already on the scenario, so the model's flags can match them. */
    layers: string[];
  }): Promise<BriefDiff>;
  reviseFactSheet(input: { factSheet: FactSheet; diff: BriefDiff; appendOnly: boolean }): Promise<FactSheet>;
  generatePersonas(input: { ctx: DeltaBuildContext; country: string }): Promise<NPCPersona[]>;
  generatePersonaGroups(input: { ctx: DeltaBuildContext; groups: string[] }): Promise<NPCPersona[]>;
  generateCharter(input: { ctx: DeltaBuildContext; teamName: string; orgKey: string }): Promise<TeamCharterWire>;
  generateTeamStoryline(input: {
    ctx: DeltaBuildContext;
    teamName: string;
    orgKey: string;
    country?: string;
  }): Promise<SocialInject[]>;
  generateStakeholders(input: {
    ctx: DeltaBuildContext;
    orgKey: string;
  }): Promise<{ stakeholders: Stakeholder[]; injects: SocialInject[] }>;
  generateSpokesperson(input: {
    ctx: DeltaBuildContext;
    orgKey: string;
  }): Promise<{ stakeholder: Stakeholder | null; injects: SocialInject[] }>;
  reviseLayer(input: {
    layer: string;
    owned: LayerPromptInject[];
    handEdited: LayerPromptInject[];
    diff: BriefDiff;
    country?: string;
  }): Promise<LayerRevisionResult>;
  reviseStakeholderText(input: {
    stakeholders: Array<{ id: string; grievance: string; knowledge: string[] }>;
    diff: BriefDiff;
  }): Promise<Array<{ id: string; grievance: string; knowledge: string[] }>>;
  convergenceDelta(input: {
    newTeams: string[];
    existingTeams: string[];
    crisis: string;
  }): Promise<{ shared: SocialInject[]; gates: SocialInject[] }>;
  reviseNarrative(input: {
    narrative: { title: string; description: string; briefing: string };
    objectives: ObjectiveDef[];
    diff: BriefDiff;
    keepBriefing: boolean;
  }): Promise<{
    narrative: { title: string; description: string; briefing: string };
    objectives: ObjectiveDef[];
  }>;
  regenerateBranches(input: { parentKey: string; parentTitle: string; diff: BriefDiff }): Promise<SocialInject[]>;
  generatePages(input: {
    ctx: DeltaBuildContext;
    orgs: Array<{ org_key: string; name: string; role: 'ally' | 'rival' | 'pressure'; description?: string }>;
  }): Promise<Array<Record<string, unknown>>>;
  revisePageHistory(input: {
    orgKey: string;
    history: unknown;
    diff: BriefDiff;
    country?: string;
  }): Promise<unknown>;
}

export interface GeneratedRows {
  personas: NPCPersona[];
  charters: TeamCharterWire[];
  team_storylines: Record<string, SocialInject[]>;
  stakeholders: Stakeholder[];
  stakeholder_injects: SocialInject[];
  spokespersons: Array<{ org_key: string; stakeholder_id?: string }>;
  shared_injects: SocialInject[];
  gates: SocialInject[];
  pressure_injects: SocialInject[];
  pages: Array<Record<string, unknown>>;
  branches: SocialInject[];
  layer_injects: SocialInject[];
  dependency_edges: TeamDependencyEdge[];
  dependency_injects: SocialInject[];
}

export interface TextUpdate {
  org_key: string;
  field: 'stance' | 'mandate' | 'team_description';
  team_uid?: string;
  value: string;
}

export interface NarrativeUpdate {
  title: string;
  description: string;
  briefing: string;
  briefing_kept: boolean;
}

export interface ObjectiveUpdate {
  objective_id: string;
  write: 'in_place' | 'cow';
  fields: { objective_name: string; description: string; weight: number };
}

export interface StakeholderTextUpdate {
  id: string;
  grievance: string;
  knowledge: string[];
}

export interface SetupEditStageOutput {
  revisions: SetupRevision[];
  flags: SetupFlag[];
  generated: GeneratedRows;
  text_updates: TextUpdate[];
  narrative_update: NarrativeUpdate | null;
  objective_updates: ObjectiveUpdate[];
  setup_source_update: SetupCrisis | null;
  stakeholder_updates: StakeholderTextUpdate[];
  brief_diff: BriefDiff | null;
  swap_premise: string | null;
  skipped: boolean;
  personas: NPCPersona[];
  fact_sheet: FactSheet;
  communities: string[];
  countries: unknown[];
  injects: SocialInject[];
  team_storylines: Record<string, SocialInject[]>;
  team_charters: TeamCharterWire[];
  stakeholders: Stakeholder[];
  stakeholder_injects: SocialInject[];
  persona_twins: NPCPersona[];
  orgs: unknown[];
  sop_steps: unknown[];
  decision_context: { leakiness: number; labour_signal: boolean; product_safety_signal: boolean };
  pressure_organisations: Array<{ display_name: string; org_key: string; spokesperson_stakeholder_id?: string }>;
  sharedInjects: SocialInject[];
  convergenceGates: SocialInject[];
  narrative: { title: string; description: string; briefing: string } | null;
  objectives: ObjectiveDef[];
  dimensionLabels: null;
  org_page: { orgs: Array<Record<string, unknown>> } | null;
  pressure_injects: SocialInject[];
  /**
   * Pages stage only. `usablePeaceFeed` of `pages.peace_period`. When set, apply
   * writes it to `initial_state.peace_period` and drops the remap `/peace_period` patch.
   */
  peace_period?: PeaceFeed | null;
}

export function blankGenerated(): GeneratedRows {
  return {
    personas: [],
    charters: [],
    team_storylines: {},
    stakeholders: [],
    stakeholder_injects: [],
    spokespersons: [],
    shared_injects: [],
    gates: [],
    pressure_injects: [],
    pages: [],
    branches: [],
    layer_injects: [],
    dependency_edges: [],
    dependency_injects: [],
  };
}

const STAGE_NAMES = ['characters', 'storyline', 'convergence', 'pages'] as const;

/** The four stage rows, in pipeline order. Pages keeps a usable peace feed. */
export function stageOutputsFromRows(
  rows: ReadonlyArray<{ stage: string; output: unknown }>,
): SetupEditStageOutput[] {
  const byStage = new Map(rows.map((row) => [row.stage, row.output]));
  return STAGE_NAMES.map((stage) => stageOutputFromUnknown(byStage.get(stage), stage));
}

export function stageOutputFromUnknown(raw: unknown, stage: string): SetupEditStageOutput {
  const row = asRecord(raw) ?? {};
  const generated = asRecord(row.generated);
  const narrative = asRecord(row.narrative_update);
  const fact = asRecord(row.fact_sheet);
  return {
    revisions: Array.isArray(row.revisions) ? (row.revisions as SetupEditStageOutput['revisions']) : [],
    flags: Array.isArray(row.flags) ? (row.flags as SetupEditStageOutput['flags']) : [],
    generated: generated ? { ...blankGenerated(), ...(generated as Partial<GeneratedRows>) } : blankGenerated(),
    text_updates: Array.isArray(row.text_updates)
      ? (row.text_updates as SetupEditStageOutput['text_updates'])
      : [],
    narrative_update:
      narrative && typeof narrative.briefing === 'string'
        ? {
            title: textOf(narrative.title),
            description: textOf(narrative.description),
            briefing: narrative.briefing,
            briefing_kept: narrative.briefing_kept === true,
          }
        : null,
    objective_updates: Array.isArray(row.objective_updates)
      ? (row.objective_updates as SetupEditStageOutput['objective_updates'])
      : [],
    setup_source_update: (asRecord(row.setup_source_update) as SetupEditStageOutput['setup_source_update']) ?? null,
    stakeholder_updates: Array.isArray(row.stakeholder_updates)
      ? (row.stakeholder_updates as SetupEditStageOutput['stakeholder_updates'])
      : [],
    brief_diff: null,
    swap_premise: typeof row.swap_premise === 'string' ? row.swap_premise : null,
    skipped: row.skipped === true,
    personas: Array.isArray(row.personas) ? (row.personas as SetupEditStageOutput['personas']) : [],
    fact_sheet:
      fact && Array.isArray(fact.confirmed_facts)
        ? {
            confirmed_facts: fact.confirmed_facts.filter((item): item is string => typeof item === 'string'),
            unconfirmed_claims: Array.isArray(fact.unconfirmed_claims)
              ? (fact.unconfirmed_claims as FactSheet['unconfirmed_claims'])
              : [],
          }
        : { confirmed_facts: [], unconfirmed_claims: [] },
    communities: [],
    countries: [],
    injects: [],
    team_storylines: {},
    team_charters: [],
    stakeholders: [],
    stakeholder_injects: [],
    persona_twins: [],
    orgs: [],
    sop_steps: [],
    decision_context: { leakiness: 0, labour_signal: false, product_safety_signal: false },
    pressure_organisations: [],
    sharedInjects: [],
    convergenceGates: [],
    narrative: null,
    objectives: [],
    dimensionLabels: null,
    org_page: null,
    pressure_injects: [],
    ...(stage === 'pages' ? { peace_period: usablePeaceFeed(row.peace_period) } : {}),
  };
}
