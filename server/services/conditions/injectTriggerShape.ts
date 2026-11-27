/**
 * An inject is timed or conditional, never both. Decision-driven injects
 * (trigger_condition set, no clock time) are a third shape and stay valid
 * without conditions_to_appear.
 */

export type InjectTriggerShape = 'ok' | 'timed_with_conditions' | 'conditional_without_conditions';

export function conditionsToAppearIsEmpty(value: unknown): boolean {
  return collectAppearKeys(value).length === 0;
}

export function validateInjectTriggerShape(row: {
  trigger_time_minutes?: number | null;
  trigger_condition?: string | null;
  conditions_to_appear?: unknown;
}): InjectTriggerShape {
  const timed = row.trigger_time_minutes != null;
  const hasConditions = !conditionsToAppearIsEmpty(row.conditions_to_appear);
  const hasTriggerCondition =
    typeof row.trigger_condition === 'string' && row.trigger_condition.trim() !== '';
  if (timed && hasConditions) return 'timed_with_conditions';
  if (!timed && !hasTriggerCondition && !hasConditions) return 'conditional_without_conditions';
  return 'ok';
}

const TRIGGER_SHAPE_FIELDS = [
  'trigger_time_minutes',
  'trigger_condition',
  'conditions_to_appear',
] as const;

/** Shape is checked only when the PATCH names one of the three trigger fields. */
export function shouldValidateTriggerShape(patchBody: object): boolean {
  return TRIGGER_SHAPE_FIELDS.some((field) =>
    Object.prototype.hasOwnProperty.call(patchBody, field),
  );
}

export type PatchTriggerDecision = InjectTriggerShape | 'unchanged';

/**
 * A delivery_config-only (or title/content) patch of a row that already has
 * both a time and conditions is left alone. Setting one of the trigger fields
 * re-checks the merged row.
 */
export function triggerShapeForPatch(
  existing: {
    trigger_time_minutes?: number | null;
    trigger_condition?: string | null;
    conditions_to_appear?: unknown;
  },
  patchBody: object,
): PatchTriggerDecision {
  if (!shouldValidateTriggerShape(patchBody)) return 'unchanged';
  const patch = patchBody as Record<string, unknown>;
  const pick = <T>(field: string, stored: T): T =>
    Object.prototype.hasOwnProperty.call(patch, field) ? (patch[field] as T) : stored;
  return validateInjectTriggerShape({
    trigger_time_minutes: pick('trigger_time_minutes', existing.trigger_time_minutes ?? null),
    trigger_condition: pick('trigger_condition', existing.trigger_condition ?? null),
    conditions_to_appear: pick('conditions_to_appear', existing.conditions_to_appear),
  });
}

function collectAppearKeys(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value))
    return value.filter((k): k is string => typeof k === 'string' && k.trim() !== '');
  if (typeof value !== 'object') return [];
  const record = value as { all?: unknown; conditions?: unknown };
  const list = Array.isArray(record.all)
    ? record.all
    : Array.isArray(record.conditions)
      ? record.conditions
      : [];
  return list.filter((k): k is string => typeof k === 'string' && k.trim() !== '');
}
