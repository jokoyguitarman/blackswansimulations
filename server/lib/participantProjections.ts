// server/lib/participantProjections.ts. WS0. Pure: no database access.
import type { AccessUser } from './access.js';

/** Columns of rts_scene_configs a participant may receive (master 10.8 item 12). */
export const PARTICIPANT_SCENE_FIELDS = [
  'id',
  'scenario_id',
  'name',
  'building_polygon',
  'building_name',
  'center_lat',
  'center_lng',
  'exits',
  'interior_walls',
  'stairwells',
  'updated_at',
  // WS4's runtime columns (migrations 233 and 234; master 10.8 item 28). Absent until those are
  // applied; schema_version is 1 on every scene the legacy editor saves.
  'schema_version',
  'involved_layouts',
  'crowd_zones',
  'crowd_headcount',
] as const;

/** WS4's authoring columns: never on a projection (master 10.8 item 28). The test checks the overlap is empty. */
export const SCENE_AUTHORING_FIELDS = ['authored', 'site_snapshot', 'draft_id'] as const;

/** Keys kept inside each array column; everything else (photos, descriptions) is dropped. */
export const PARTICIPANT_SCENE_ITEM_FIELDS = {
  exits: ['id', 'center', 'pos', 'width', 'edgeIndex', 'status', 'exitType'],
  interior_walls: ['id', 'start', 'end', 'hasDoor', 'doorWidth', 'doorPosition', 'material'],
  stairwells: ['id', 'pos', 'connectsFloors', 'blocked'],
} as const;

export type ParticipantScene = Partial<
  Record<(typeof PARTICIPANT_SCENE_FIELDS)[number], unknown>
> & {
  /** v2 rows only: WS4's RuntimeScenePhoto entries, signed for 900 seconds. */
  photos?: readonly unknown[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function projectItemList(value: unknown, keys: readonly string[]): unknown[] {
  if (!Array.isArray(value)) return [];
  const items: unknown[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const copy: Record<string, unknown> = {};
    for (const key of keys) {
      if (key in item) copy[key] = item[key];
    }
    items.push(copy);
  }
  return items;
}

/**
 * Allow-list projection; a column added later is absent unless a spec adds it here on purpose.
 * options.photos is attached as `photos` only when row.schema_version === 2.
 */
export function projectSceneForParticipant(
  row: Record<string, unknown> | null,
  options?: { photos?: readonly unknown[] },
): ParticipantScene | null {
  if (row === null) return null;
  const projected: ParticipantScene = {};
  for (const field of PARTICIPANT_SCENE_FIELDS) {
    if (!(field in row)) continue;
    const itemFields = itemFieldsFor(field);
    projected[field] = itemFields ? projectItemList(row[field], itemFields) : row[field];
  }
  if (row.schema_version === 2 && options?.photos !== undefined) {
    projected.photos = options.photos;
  }
  return projected;
}

function itemFieldsFor(field: (typeof PARTICIPANT_SCENE_FIELDS)[number]): readonly string[] | null {
  if (field === 'exits' || field === 'interior_walls' || field === 'stairwells') {
    return PARTICIPANT_SCENE_ITEM_FIELDS[field];
  }
  return null;
}

/** conditions keys that answer the game: the true triage colour and the ideal response. */
export const CASUALTY_ANSWER_KEYS = [
  'triage_color',
  'triage_category',
  'treatment_requirements',
  'transport_prerequisites',
  'contraindications',
  'ideal_response_sequence',
  'required_ppe',
  'required_equipment',
  'expected_time_to_treat_minutes',
  'recommended_transport',
  'deterioration_timeline',
] as const;

/** Columns of scenario_casualties a participant may receive. */
export const PARTICIPANT_CASUALTY_FIELDS = [
  'id',
  'scenario_id',
  'session_id',
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
  'created_at',
  'updated_at',
] as const;

/** Column allow-list, then conditions minus CASUALTY_ANSWER_KEYS (P0.2). */
export function projectCasualtyForParticipant(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of PARTICIPANT_CASUALTY_FIELDS) {
    if (!(field in row)) continue;
    if (field === 'conditions' && isPlainObject(row.conditions)) {
      const cleaned: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row.conditions)) {
        if (!(CASUALTY_ANSWER_KEYS as readonly string[]).includes(key)) cleaned[key] = value;
      }
      projected.conditions = cleaned;
      continue;
    }
    projected[field] = row[field];
  }
  return projected;
}

/** The session's trainer or an admin: the audience that may see a session's answer key. */
export function canSeeSessionAnswerKey(
  user: AccessUser,
  session: { trainer_id: string | null },
): boolean {
  return user.role === 'admin' || (session.trainer_id !== null && session.trainer_id === user.id);
}

/** The scenario's creator or an admin: the audience that may see a scenario's scene row whole. */
export function canSeeScenarioAnswerKey(
  user: AccessUser,
  scenario: { created_by: string | null },
): boolean {
  return user.role === 'admin' || (scenario.created_by !== null && scenario.created_by === user.id);
}
