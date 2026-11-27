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
