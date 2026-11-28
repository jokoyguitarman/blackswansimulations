import { randomUUID } from 'node:crypto';
import { stampOrgIdentity } from '../../lib/templateRows.js';

/**
 * Column lists for POST /api/scenarios/:id/clone.
 *
 * The SQL function in migrations/276_clone_scenario.sql is the transactional
 * copy. This module is the TypeScript fallback used when that function is
 * absent or fails because a column is missing. Both lists are the schema after
 * migrations <=267 plus 274 and 275. Migrations 268–273 add no columns to
 * scenarios, scenario_injects, or scenario_teams.
 *
 * A new column is copied only when it is added here and in 276. valid_from is
 * the clone's current time. retired_by_edit and superseded_by are cleared.
 * required_gate_id and required_gate_not_met_id are set null: scenario_gates
 * are not copied, and the scheduler only sees the clone's own gates.
 * created_at and updated_at are left to the column default.
 */

/** Copied from the source scenario. id, created_at, updated_at, created_by and is_active are not. */
export const SCENARIO_COPIED_COLUMNS = [
  'description',
  'category',
  'difficulty',
  'duration_minutes',
  'objectives',
  'initial_state',
  'briefing',
  'role_specific_briefs',
  'center_lat',
  'center_lng',
  'vicinity_radius_meters',
  'vicinity_map_url',
  'layout_image_url',
  'insider_knowledge',
  'sweep_device_pool',
  'blueprint',
  'setup_edits_used',
] as const;

export const SCENARIO_SOURCE_COLUMNS = ['id', 'title', ...SCENARIO_COPIED_COLUMNS] as const;

/**
 * Team columns the social-crisis compile writes, plus the other template
 * columns a clone must keep (counter definitions, the investigative flag).
 * scenario_id is rewritten. valid_from / retire columns are reset by the shaper.
 */
export const TEAM_CLONE_COLUMNS = [
  'team_uid',
  'team_name',
  'team_description',
  'required_roles',
  'min_participants',
  'max_participants',
  'org_key',
  'function_key',
  'charter',
  'expected_actions',
  'scoring_rubric',
  'counter_definitions',
  'is_investigative',
] as const;

/**
 * Inject columns the social-crisis compile writes (gen_layer is not a column;
 * it is folded into delivery_config.gen before insert), plus every other
 * template column. session_id, valid_from and the retire columns are reset.
 */
export const INJECT_CLONE_COLUMNS = [
  'trigger_time_minutes',
  'trigger_condition',
  'type',
  'title',
  'content',
  'affected_roles',
  'severity',
  'requires_response',
  'ai_generated',
  'inject_scope',
  'target_teams',
  'requires_coordination',
  'triggered_by_user_id',
  'required_gate_id',
  'required_gate_not_met_id',
  'conditions_to_appear',
  'conditions_to_cancel',
  'eligible_after_minutes',
  'objective_penalty',
  'state_effect',
  'generation_source',
  'delivery_config',
  'response_type',
] as const;

/** id plus the clone list. Apply and the remap loader select this set. */
export const TEAM_ROW_COLUMNS = ['id', ...TEAM_CLONE_COLUMNS] as const;
export const INJECT_ROW_COLUMNS = ['id', ...INJECT_CLONE_COLUMNS] as const;

export const OBJECTIVE_CLONE_COLUMNS = [
  'objective_id',
  'objective_name',
  'description',
  'success_criteria',
  'weight',
] as const;

export const SOP_CLONE_COLUMNS = [
  'sop_name',
  'description',
  'steps',
  'response_time_limit_minutes',
  'escalation_rules',
  'approval_chain',
  'content_guidelines',
] as const;

export const HAZARD_CLONE_COLUMNS = [
  'hazard_type',
  'location_lat',
  'location_lng',
  'floor_level',
  'properties',
  'assessment_criteria',
  'image_url',
  'image_sequence',
  'status',
  'appears_at_minutes',
  'resolution_requirements',
  'personnel_requirements',
  'equipment_requirements',
  'deterioration_timeline',
  'enriched_description',
  'fire_class',
  'debris_type',
  'zones',
  'detonation_deadline',
  'spawn_condition',
  'stud_id',
] as const;

export const CASUALTY_CLONE_COLUMNS = [
  'casualty_type',
  'location_lat',
  'location_lng',
  'floor_level',
  'headcount',
  'conditions',
  'status',
  'assigned_team',
  'linked_decision_id',
  'appears_at_minutes',
  'player_triage_color',
  'assessed_by',
  'assessed_at_minutes',
  'destination_lat',
  'destination_lng',
  'destination_label',
  'movement_speed_mpm',
  'destination_reached_status',
  'spawn_condition',
] as const;

export const EQUIPMENT_CLONE_COLUMNS = [
  'equipment_type',
  'label',
  'icon',
  'properties',
  'applicable_teams',
] as const;

export const FLOOR_PLAN_CLONE_COLUMNS = [
  'floor_level',
  'floor_label',
  'plan_svg',
  'plan_image_url',
  'bounds',
  'features',
  'environmental_factors',
] as const;

export const SCENE_CLONE_COLUMNS = [
  'name',
  'building_polygon',
  'building_name',
  'center_lat',
  'center_lng',
  'exits',
  'interior_walls',
  'hazard_zones',
  'stairwells',
  'blast_site',
  'casualty_clusters',
  'planted_items',
  'wall_inspection_points',
  'wall_photo_urls',
  'casualty_image_urls',
  'pedestrian_count',
  'enrichment_result',
  'levels',
  'placed_objects',
] as const;

/** Step 4 of the clone. Copied only when the table exists. Never session rows. */
export const OPTIONAL_CLONE_TABLES = [
  'scenario_objectives',
  'sop_definitions',
  'scenario_hazards',
  'scenario_casualties',
  'scenario_equipment',
  'scenario_floor_plans',
  'rts_scene_configs',
] as const;

const SCHEMA_CODES = new Set(['42P01', '42703', '42883', 'PGRST202', 'PGRST204', 'PGRST205']);

const MISSING_COLUMN =
  /column "?([a-z_][a-z0-9_]*)"? of relation|column "?([a-z_][a-z0-9_]*)"? does not exist|could not find the '([a-z_][a-z0-9_]*)' column/i;

export interface CloneFailure {
  code?: string;
  message?: string;
  details?: string;
}

export function isCloneSchemaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as CloneFailure).code;
  if (typeof code === 'string' && SCHEMA_CODES.has(code)) return true;
  const message = `${(err as CloneFailure).message ?? ''} ${(err as CloneFailure).details ?? ''}`;
  return /clone_scenario/i.test(message) && /does not exist|schema cache/i.test(message);
}

export function missingColumnName(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const failure = err as CloneFailure;
  const message = `${failure.message ?? ''} ${failure.details ?? ''}`;
  const match = MISSING_COLUMN.exec(message);
  const name = match?.[1] || match?.[2] || match?.[3] || '';
  return name ? name.toLowerCase() : null;
}

export function resolveCloneTitle(
  sourceTitle: string,
  requested: string | null | undefined,
): string {
  const trimmed = requested?.trim() ?? '';
  if (trimmed) return trimmed;
  return `${sourceTitle} (Copy)`;
}

export function isRetired(row: Record<string, unknown>): boolean {
  return row.retired_at != null && row.retired_at !== '';
}

export function isSessionRow(row: Record<string, unknown>): boolean {
  return row.session_id != null && row.session_id !== '';
}

function pick(row: Record<string, unknown>, columns: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of columns) {
    if (!Object.prototype.hasOwnProperty.call(row, column)) continue;
    const value = row[column];
    out[column] = value != null && typeof value === 'object' ? structuredClone(value) : value;
  }
  return out;
}

function versionResets(nowIso: string): Record<string, unknown> {
  return {
    valid_from: nowIso,
    retired_at: null,
    retired_by_edit: null,
    retire_reason: null,
    superseded_by: null,
  };
}

export function cloneScenarioInsert(
  source: Record<string, unknown>,
  input: { title: string; createdBy: string },
): Record<string, unknown> {
  const row = pick(source, SCENARIO_COPIED_COLUMNS);
  row.title = input.title;
  row.created_by = input.createdBy;
  row.is_active = false;
  if ('initial_state' in row) row.initial_state = stampOrgIdentity(row.initial_state);
  return row;
}

export function cloneTeamRows(
  rows: readonly Record<string, unknown>[],
  scenarioId: string,
  nowIso: string,
): Record<string, unknown>[] {
  const cloned: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (isRetired(row)) continue;
    cloned.push({
      ...pick(row, TEAM_CLONE_COLUMNS),
      scenario_id: scenarioId,
      ...versionResets(nowIso),
    });
  }
  return cloned;
}

export function cloneInjectRows(
  rows: readonly Record<string, unknown>[],
  scenarioId: string,
  nowIso: string,
): Record<string, unknown>[] {
  const cloned: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (isRetired(row) || isSessionRow(row)) continue;
    cloned.push({
      ...pick(row, INJECT_CLONE_COLUMNS),
      scenario_id: scenarioId,
      session_id: null,
      // Gates belong to the source scenario and are not copied. Leaving the
      // ids set would stop these injects from firing on the clone.
      required_gate_id: null,
      required_gate_not_met_id: null,
      ...versionResets(nowIso),
    });
  }
  return cloned;
}

export function cloneObjectiveRows(
  rows: readonly Record<string, unknown>[],
  scenarioId: string,
): Record<string, unknown>[] {
  const cloned: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (isRetired(row)) continue;
    cloned.push({ ...pick(row, OBJECTIVE_CLONE_COLUMNS), scenario_id: scenarioId });
  }
  return cloned;
}

export function cloneColumnRows(
  rows: readonly Record<string, unknown>[],
  columns: readonly string[],
  scenarioId: string,
): Record<string, unknown>[] {
  return rows
    .filter((row) => !isSessionRow(row) && !isRetired(row))
    .map((row) => ({ ...pick(row, columns), scenario_id: scenarioId }));
}

export interface HazardClone {
  rows: Record<string, unknown>[];
  /** New hazard id to its new parent id, applied after the insert so the FK sees the parent. */
  parentLinks: Array<{ id: string; parentId: string }>;
  idMap: Map<string, string>;
}

export function cloneHazardRows(
  rows: readonly Record<string, unknown>[],
  scenarioId: string,
): HazardClone {
  const template = rows.filter((row) => !isSessionRow(row));
  const idMap = new Map<string, string>();
  for (const row of template) {
    if (typeof row.id === 'string') idMap.set(row.id, randomUUID());
  }
  const parentLinks: Array<{ id: string; parentId: string }> = [];
  const cloned = template.map((row) => {
    const id = typeof row.id === 'string' ? idMap.get(row.id) : randomUUID();
    const parent = typeof row.parent_pin_id === 'string' ? idMap.get(row.parent_pin_id) : undefined;
    if (id && parent) parentLinks.push({ id, parentId: parent });
    return {
      ...pick(row, HAZARD_CLONE_COLUMNS),
      id,
      scenario_id: scenarioId,
      session_id: null,
      parent_pin_id: null,
    };
  });
  return { rows: cloned, parentLinks, idMap };
}

export function cloneCasualtyRows(
  rows: readonly Record<string, unknown>[],
  scenarioId: string,
  hazardIds: ReadonlyMap<string, string>,
): Record<string, unknown>[] {
  const cloned: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (isSessionRow(row)) continue;
    const parent =
      typeof row.parent_pin_id === 'string' ? hazardIds.get(row.parent_pin_id) : undefined;
    cloned.push({
      ...pick(row, CASUALTY_CLONE_COLUMNS),
      scenario_id: scenarioId,
      session_id: null,
      parent_pin_id: parent ?? null,
    });
  }
  return cloned;
}

export function cloneSceneRows(
  rows: readonly Record<string, unknown>[],
  scenarioId: string,
  createdBy: string,
): Record<string, unknown>[] {
  return rows.map((row) => ({
    ...pick(row, SCENE_CLONE_COLUMNS),
    scenario_id: scenarioId,
    created_by: createdBy,
  }));
}

export function injectKeyOf(row: Record<string, unknown>): string | null {
  const config = row.delivery_config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const key = (config as Record<string, unknown>).inject_key;
  return typeof key === 'string' ? key : null;
}
