/** An inject row the scenario editor already keeps in memory. */
export interface ScenarioInjectRow {
  id: string;
  trigger_time_minutes: number | null;
  trigger_condition: string | null;
  conditions_to_appear?: unknown;
  conditions_to_cancel?: unknown;
  eligible_after_minutes?: number | null;
  type: string;
  title: string;
  content: string;
  severity: string;
  inject_scope: string;
  target_teams: string[] | null;
  requires_response?: boolean;
  delivery_config?: Record<string, unknown> | null;
  generation_source?: string;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === 'string');
}

/** The create/update inject response, read field by field. */
export function readScenarioInject(value: unknown): ScenarioInjectRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.title !== 'string') return null;
  const config = row.delivery_config;
  return {
    id: row.id,
    title: row.title,
    content: typeof row.content === 'string' ? row.content : '',
    type: typeof row.type === 'string' ? row.type : 'email',
    severity: typeof row.severity === 'string' ? row.severity : 'medium',
    inject_scope: typeof row.inject_scope === 'string' ? row.inject_scope : 'team_specific',
    target_teams: stringList(row.target_teams),
    trigger_time_minutes:
      typeof row.trigger_time_minutes === 'number' ? row.trigger_time_minutes : null,
    trigger_condition: typeof row.trigger_condition === 'string' ? row.trigger_condition : null,
    conditions_to_appear: row.conditions_to_appear,
    conditions_to_cancel: row.conditions_to_cancel,
    eligible_after_minutes:
      typeof row.eligible_after_minutes === 'number' ? row.eligible_after_minutes : null,
    requires_response: row.requires_response === true,
    delivery_config:
      config && typeof config === 'object' && !Array.isArray(config)
        ? (config as Record<string, unknown>)
        : null,
    ...(typeof row.generation_source === 'string'
      ? { generation_source: row.generation_source }
      : {}),
  };
}
