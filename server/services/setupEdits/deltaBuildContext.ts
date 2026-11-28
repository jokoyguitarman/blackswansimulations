import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/canonicalJson.js';
import { env } from '../../env.js';
import { inferLayer, injectProvenance, type LayerTeam } from '../../lib/injectFingerprint.js';
import { injectKeyOf } from '../../lib/injectKey.js';
import { logger } from '../../lib/logger.js';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import type { Stakeholder } from '../../lib/stakeholderContract.js';
import type { FactSheet, NPCPersona, ObjectiveDef } from '../socialCrisisGeneratorService.js';
import type { BuildRequest } from '../warroomBuild/buildTypes.js';
import type { DeltaBuildContext, DeltaInject, DeltaPage } from './deltaBuildTypes.js';
import { asSnapshot, hashPlan } from './prepareSetupEditBuild.js';
import { loadRemapState } from './remapPlanLoader.js';
import { planRemap, type PlannerInject } from './remapPlanner.js';
import { isSetupEditSchemaMissing } from './setupEditCore.js';
import { noteSetupEditsUnavailable } from './setupEditService.js';
import { computeDelta, type SetupDelta } from './setupDeltaCore.js';
import { snapshotFromDraftInput } from './setupSnapshotCore.js';
import type { SetupEditBuildSource } from './prepareSetupEditBuild.js';

let objectiveWarn = false;

export function resetDeltaContextWarningForTests(): void {
  objectiveWarn = false;
}

export type LoadedSetupEdit =
  | { available: false }
  | { available: true; source: SetupEditBuildSource | null };

/** The open edit, its draft, and the rows the remap planner reads. */
export async function loadSetupEditSource(editId: string): Promise<LoadedSetupEdit> {
  const edit = await supabaseAdmin
    .from('scenario_setup_edits')
    .select('id, scenario_id, status, draft_id, baseline, edit_number')
    .eq('id', editId)
    .maybeSingle<{
      id: string;
      scenario_id: string;
      status: string;
      draft_id: string | null;
      baseline: unknown;
      edit_number: number | null;
    }>();
  if (edit.error) {
    if (isSetupEditSchemaMissing(edit.error)) {
      noteSetupEditsUnavailable();
      return { available: false };
    }
    throw new Error(edit.error.message);
  }
  if (!edit.data) return { available: true, source: null };
  let draftInput: unknown = null;
  if (edit.data.draft_id) {
    const draft = await supabaseAdmin
      .from('warroom_wizard_drafts')
      .select('input')
      .eq('id', edit.data.draft_id)
      .maybeSingle<{ input: unknown }>();
    if (draft.error) {
      if (isSetupEditSchemaMissing(draft.error)) {
        noteSetupEditsUnavailable();
        return { available: false };
      }
      throw new Error(draft.error.message);
    }
    draftInput = draft.data?.input ?? null;
  }
  let remap;
  try {
    remap = await loadRemapState(edit.data.scenario_id);
  } catch (err) {
    if (isSetupEditSchemaMissing(err)) {
      noteSetupEditsUnavailable();
      return { available: false };
    }
    throw err;
  }
  return {
    available: true,
    source: {
      edit: edit.data,
      draft_input: draftInput,
      remap,
    },
  };
}

/** Reads the scenario and the edit. The build does not write either. */
export async function loadDeltaBuildContext(request: BuildRequest): Promise<DeltaBuildContext> {
  if (!request.setup_edit_id) throw new Error('SETUP_EDIT_ID_REQUIRED');
  const loaded = await loadSetupEditSource(request.setup_edit_id);
  if (!loaded.available) throw new Error('SETUP_EDITS_UNAVAILABLE');
  const source = loaded.source;
  if (!source) throw new Error('SETUP_EDIT_NOT_FOUND');
  if (source.edit.status !== 'open') throw new Error('SETUP_EDIT_NOT_OPEN');
  const baseline = asSnapshot(source.edit.baseline);
  if (!baseline) throw new Error('SETUP_EDIT_NOT_READY');
  const edited = snapshotFromDraftInput(source.draft_input, baseline);
  const delta: SetupDelta = isDelta(request.delta) ? request.delta : computeDelta(baseline, edited);
  const remap = source.remap;
  const plan = planRemap({
    delta,
    edited,
    initial_state: remap.initial_state,
    teams: remap.teams,
    injects: remap.injects,
    sessions: remap.sessions,
  });
  if (request.plan_hash && hashPlan(plan) !== request.plan_hash) {
    throw new Error('SETUP_EDIT_PLAN_STALE');
  }

  const scenario = await supabaseAdmin
    .from('scenarios')
    .select('title, description, briefing, initial_state')
    .eq('id', source.edit.scenario_id)
    .maybeSingle<{
      title: string | null;
      description: string | null;
      briefing: string | null;
      initial_state: unknown;
    }>();
  if (scenario.error) throw new Error(scenario.error.message);
  const state = asRecord(scenario.data?.initial_state) ?? asRecord(remap.initial_state) ?? {};
  const factSheet = asFactSheet(state.fact_sheet);
  const briefing = scenario.data?.briefing ?? '';
  const setup = asRecord(state.setup_source);
  const scored = await objectiveIdsWithScores(source.edit.scenario_id);
  const objectives = await loadObjectives(source.edit.scenario_id, state, scored);
  const removedTeams = new Set(
    plan.teams.retire.filter((row) => row.reason === 'removed').map((row) => row.team_uid),
  );
  const removedInjects = new Set(plan.injects.retire.map((row) => row.inject_id));
  const teams = remap.teams
    .filter((team) => !removedTeams.has(team.team_uid))
    .map((team) => ({
      team_uid: team.team_uid,
      team_name: team.team_name,
      org_key: team.org_key,
    }));
  const layerTeams: LayerTeam[] = teams.map((team) => ({
    team_name: team.team_name,
    team_uid: team.team_uid,
  }));
  const injects = remap.injects
    .filter((inject) => !removedInjects.has(inject.id))
    .map((inject) => toDeltaInject(inject, layerTeams));
  const personas = asPersonas(state.npc_personas);
  const loadedStakeholders = asStakeholders(state.stakeholders);

  return {
    edit_status: source.edit.status,
    edit_number: source.edit.edit_number ?? 1,
    delta,
    plan,
    edited,
    baseline_crisis: {
      crisis_type: baseline.crisis.crisis_type,
      context: baseline.crisis.context,
    },
    injects,
    teams,
    stakeholders: loadedStakeholders.map(({ handle: _handle, email: _email, ...stakeholder }) => stakeholder),
    personas,
    fact_sheet: factSheet,
    fact_sheet_trainer_edited: stampedDiffers(canonicalJson(factSheet), text(setup?.fact_sheet_hash)),
    briefing,
    briefing_trainer_edited: stampedDiffers(briefing.trim(), text(setup?.briefing_hash)),
    narrative: {
      title: scenario.data?.title ?? '',
      description: scenario.data?.description ?? '',
      briefing,
    },
    objectives,
    pages: pagesFrom(state),
    taken_handles: [
      ...personas.map((persona) => persona.handle),
      ...loadedStakeholders.map((stakeholder) => stakeholder.handle),
    ].filter((handle) => handle.length > 0),
    taken_emails: loadedStakeholders.map((stakeholder) => stakeholder.email).filter((email) => email.length > 0),
    taken_stakeholder_ids: loadedStakeholders.map((stakeholder) => stakeholder.id),
    active_keys: injects.map((inject) => inject.inject_key).filter((key) => key.length > 0),
    page_batch_size: env.warroomOrgPageBatch,
    peace_period: state.peace_period,
    org_page: state.org_page,
  };
}

function toDeltaInject(inject: PlannerInject, teams: LayerTeam[]): DeltaInject {
  const config = inject.delivery_config ?? {};
  const gen = asRecord(config.gen);
  const layer = text(gen?.layer) || inferLayer({ ...inject, delivery_config: config }, teams);
  const app = text(config.app) || 'social_feed';
  return {
    id: inject.id,
    inject_key: injectKeyOf({ id: inject.id, delivery_config: config }),
    layer,
    title: inject.title ?? '',
    content: inject.content ?? '',
    trigger_time_minutes: inject.trigger_time_minutes ?? null,
    conditions_to_appear: inject.conditions_to_appear,
    conditions_to_cancel: inject.conditions_to_cancel,
    delivery_config: config,
    generation_source: inject.generation_source ?? null,
    provenance: injectProvenance({ ...inject, delivery_config: config }),
    has_history: inject.has_history,
    requires_response: inject.requires_response === true,
    target_teams: inject.target_teams ?? [],
    type: inject.type ?? 'social_post',
    severity: inject.severity ?? 'medium',
    inject_scope: inject.inject_scope ?? 'universal',
    app,
  };
}

function pagesFrom(state: Record<string, unknown>): DeltaPage[] {
  const page = asRecord(state.org_page);
  const orgs = Array.isArray(page?.orgs) ? page.orgs : [];
  return orgs.flatMap((raw) => {
    const org = asRecord(raw);
    if (!org) return [];
    const orgKey = text(org.org_key);
    if (!orgKey) return [];
    const history = org.branded_history ?? [];
    return [
      {
        org_key: orgKey,
        display_name: text(org.display_name) || orgKey,
        history,
        historyText: historyText(history),
        is_primary: org.is_primary === true || orgKey === 'primary',
      },
    ];
  });
}

function historyText(history: unknown): string {
  if (!Array.isArray(history)) return '';
  return history
    .map((item) => text(asRecord(item)?.content))
    .filter((line) => line.length > 0)
    .join('\n');
}

async function loadObjectives(
  scenarioId: string,
  state: Record<string, unknown>,
  scored: Set<string>,
): Promise<Array<ObjectiveDef & { has_scores: boolean }>> {
  const fromState = Array.isArray(state.objectives) ? state.objectives : [];
  const rows = await readOptional('scenario_objectives', () =>
    supabaseAdmin
      .from('scenario_objectives')
      .select('objective_id, objective_name, description, weight')
      .eq('scenario_id', scenarioId),
  );
  const source = rows.length > 0 ? rows : fromState.map((item) => asRecord(item) ?? {});
  return source.map((row) => {
    const objective_id = text(row.objective_id) || 'objective';
    return {
      objective_id,
      objective_name: text(row.objective_name) || objective_id,
      description: text(row.description),
      weight: typeof row.weight === 'number' ? row.weight : Number(row.weight) || 25,
      has_scores: scored.has(objective_id),
    };
  });
}

async function objectiveIdsWithScores(scenarioId: string): Promise<Set<string>> {
  const sessions = await readOptional('sessions', () =>
    supabaseAdmin.from('sessions').select('id').eq('scenario_id', scenarioId),
  );
  const ids = sessions.map((row) => text(row.id)).filter((id) => id.length > 0);
  if (ids.length === 0) return new Set();
  const progress = await readOptional('scenario_objective_progress', () =>
    supabaseAdmin
      .from('scenario_objective_progress')
      .select('objective_id, score')
      .in('session_id', ids),
  );
  return new Set(
    progress
      .filter((row) => row.score != null)
      .map((row) => text(row.objective_id))
      .filter((id) => id.length > 0),
  );
}

async function readOptional(
  table: string,
  query: () => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>,
): Promise<Record<string, unknown>[]> {
  try {
    const result = await query();
    if (result.error) {
      if (isMissing(result.error)) {
        warnObjectives(table);
        return [];
      }
      throw new Error(result.error.message);
    }
    return Array.isArray(result.data) ? (result.data as Record<string, unknown>[]) : [];
  } catch (err) {
    if (isMissing(err)) {
      warnObjectives(table);
      return [];
    }
    throw err;
  }
}

function warnObjectives(table: string): void {
  if (objectiveWarn) return;
  objectiveWarn = true;
  logger.warn({ table }, 'setup_edit_objective_scores_unavailable');
}

function isMissing(err: unknown): boolean {
  return isSetupEditSchemaMissing(err);
}

function stampedDiffers(current: string, stamped: string): boolean {
  if (!stamped) return false;
  const hash = createHash('sha256').update(current).digest('hex');
  return hash !== stamped;
}

function asFactSheet(value: unknown): FactSheet {
  const row = asRecord(value);
  return {
    confirmed_facts: Array.isArray(row?.confirmed_facts)
      ? row.confirmed_facts.filter((item): item is string => typeof item === 'string')
      : [],
    unconfirmed_claims: Array.isArray(row?.unconfirmed_claims)
      ? (row.unconfirmed_claims as FactSheet['unconfirmed_claims'])
      : [],
    crisis_cluster:
      row?.crisis_cluster === 'victim' || row?.crisis_cluster === 'accidental' || row?.crisis_cluster === 'preventable'
        ? row.crisis_cluster
        : undefined,
  };
}

function asPersonas(value: unknown): NPCPersona[] {
  return Array.isArray(value) ? (value as NPCPersona[]) : [];
}

function asStakeholders(value: unknown): Array<DeltaBuildContext['stakeholders'][number] & { handle: string; email: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const row = raw as Partial<Stakeholder>;
    if (!row || typeof row.id !== 'string') return [];
    return [
      {
        id: row.id,
        name: typeof row.name === 'string' ? row.name : row.id,
        grievance: typeof row.grievance === 'string' ? row.grievance : '',
        knowledge: Array.isArray(row.knowledge)
          ? row.knowledge.filter((item): item is string => typeof item === 'string')
          : [],
        org_key: typeof row.org_key === 'string' ? row.org_key : null,
        handle: typeof row.handle === 'string' ? row.handle : '',
        email: typeof row.email === 'string' ? row.email : '',
      },
    ];
  });
}

function isDelta(value: unknown): value is SetupDelta {
  return !!value && typeof value === 'object' && !Array.isArray(value) && 'empty' in value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
