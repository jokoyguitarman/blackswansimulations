import { createHash } from 'node:crypto';

const DROP = new Set([
  'id',
  'status',
  'row_version',
  'version',
  'review_state',
  'created_by',
  'updated_by',
  'created_at',
  'updated_at',
]);

export const DATASET_TABLES = {
  physics: [
    'fieldops_explosive_materials',
    'fieldops_injury_thresholds',
    'fieldops_device_presets',
  ],
  spread: [
    'fieldops_spread_materials',
    'fieldops_spread_hazards',
    'fieldops_spread_exposure',
    'fieldops_spread_weather_effects',
  ],
  catalogue: [
    'fieldops_building_types',
    'fieldops_hazard_item_kinds',
    'fieldops_building_items',
    'fieldops_hazard_interactions',
  ],
  threats: [
    'fieldops_release_agents',
    'fieldops_threat_profiles',
    'fieldops_movement_parameters',
    'fieldops_incident_types',
  ],
} as const;

export type DatasetLibrary = keyof typeof DATASET_TABLES;

const KEYS: Record<string, string[]> = {
  fieldops_explosive_materials: ['material_key'],
  fieldops_injury_thresholds: ['threshold_key'],
  fieldops_device_presets: ['preset_key'],
  fieldops_spread_materials: ['material_key'],
  fieldops_spread_hazards: ['hazard_key'],
  fieldops_spread_exposure: ['exposure_key'],
  fieldops_spread_weather_effects: ['weather_condition'],
  fieldops_building_types: ['type_key'],
  fieldops_hazard_item_kinds: ['kind_key'],
  fieldops_building_items: ['type_key', 'kind_key', 'location_kind'],
  fieldops_hazard_interactions: ['rule_key'],
  fieldops_release_agents: ['agent_key'],
  fieldops_threat_profiles: ['threat_key'],
  fieldops_movement_parameters: ['param_key'],
  fieldops_incident_types: ['incident_type'],
};

/** First 16 hex characters of the canonical active rows. Numbers lose trailing zeros. */
export function datasetVersionOf(
  library: DatasetLibrary,
  rowsByTable: Record<string, Record<string, unknown>[]>,
): string {
  const payload = DATASET_TABLES[library].map((table) => ({
    table,
    rows: [...(rowsByTable[table] ?? [])]
      .map(normaliseRow)
      .sort((a, b) => keyOf(table, a).localeCompare(keyOf(table, b))),
  }));
  return createHash('sha256').update(canonical(payload), 'utf8').digest('hex').slice(0, 16);
}

function normaliseRow(row: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) {
    if (DROP.has(key)) continue;
    next[key] = normaliseValue(row[key]);
  }
  return next;
}

function normaliseValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' || (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value))) {
    return trimNumber(String(value));
  }
  if (Array.isArray(value)) return value.map(normaliseValue);
  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      next[key] = normaliseValue((value as Record<string, unknown>)[key]);
    }
    return next;
  }
  return value;
}

function trimNumber(value: string): string {
  const negative = value.startsWith('-');
  const body = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = body.split('.');
  const trimmedWhole = (whole ?? '0').replace(/^0+(?=\d)/, '') || '0';
  const trimmedFraction = fraction.replace(/0+$/, '');
  const text = trimmedFraction ? `${trimmedWhole}.${trimmedFraction}` : trimmedWhole;
  return negative && text !== '0' ? `-${text}` : text;
}

function keyOf(table: string, row: Record<string, unknown>): string {
  return (KEYS[table] ?? ['id']).map((key) => String(row[key] ?? '')).join('/');
}

function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return 'null';
}
