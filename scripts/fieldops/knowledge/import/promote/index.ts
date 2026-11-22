import { failedChecks } from '../../../../../server/lib/fieldOps/knowledgeSchemas.js';
import { normaliseTeamText } from '../../../../../shared/fieldOps/matching.js';
import { canonicalJson, sha256Hex } from '../canonical.js';
import { beginImport, withClient } from '../db.js';
import { contentWithoutUseOfForce, forceRoleSatisfied } from '../review.js';
import { finishRun, startRun } from '../runLog.js';
import type { DbTarget } from '../safety.js';
import {
  assignDoctrineSourceKey,
  cut,
  fullDate,
  hospitalBeds,
  httpsUrl,
  mapLibraries,
  overlaySpread,
  responseNumbers,
  sourceRefFromTitles,
  valuesNote,
} from '../transforms.js';
import type { NormalisedReview } from '../types.js';
import { PROMOTE_ORDER } from './order.js';
import type pg from 'pg';

const FOLDER_ORDER = [
  'doctrines',
  'responder-units',
  'building-hazards',
  'physics-movement',
  'blast-effects',
  'fire-smoke-tenability',
  'planning',
];

const SPREAD_LOG: Record<string, string> = {
  fieldops_spread_materials: 'materials',
  fieldops_release_agents: 'agents',
  fieldops_threat_profiles: 'threats',
  fieldops_movement_parameters: 'movement',
  fieldops_incident_types: 'incident_types',
  fieldops_building_types: 'building_types',
  fieldops_hazard_item_kinds: 'item_kinds',
  fieldops_building_items: 'building_items',
  fieldops_hazard_interactions: 'interactions',
};

const PHYSICS_LOG = new Set(['fieldops_explosive_materials', 'fieldops_injury_thresholds']);

const VERSION: Record<string, string | null> = {
  fieldops_explosive_materials: 'version',
  fieldops_injury_thresholds: 'version',
  fieldops_unit_equipment: null,
  fieldops_hospital_specialties: null,
  fieldops_capacity_aggregates: null,
  fieldops_knowledge_sources: null,
  team_archetype_aliases: null,
};

const JSON_COLUMNS: Record<string, string[]> = {
  fieldops_threat_profiles: ['parameters', 'environment'],
  fieldops_release_agents: ['tiers'],
  fieldops_hospitals: ['stated_values'],
  fieldops_capacity_aggregates: ['stated_values'],
  fieldops_response_standards: ['stated_values'],
  fieldops_knowledge_reference_values: ['value', 'provenance', 'worked_example'],
};

const FOREIGN: Record<string, { column: string; table: string; optional?: boolean }[]> = {
  fieldops_building_types: [
    { column: 'contents_key', table: 'fieldops_spread_materials' },
    { column: 'frame_key', table: 'fieldops_spread_materials' },
  ],
  fieldops_hazard_item_kinds: [
    { column: 'contents_key', table: 'fieldops_spread_materials', optional: true },
  ],
  fieldops_building_items: [
    { column: 'type_key', table: 'fieldops_building_types' },
    { column: 'kind_key', table: 'fieldops_hazard_item_kinds' },
  ],
  fieldops_hazard_interactions: [{ column: 'kind_key', table: 'fieldops_hazard_item_kinds' }],
  fieldops_unit_kinds: [{ column: 'archetype_key', table: 'team_archetypes' }],
  fieldops_unit_equipment: [
    { column: 'kind_key', table: 'fieldops_unit_kinds' },
    { column: 'equipment_key', table: 'fieldops_equipment' },
  ],
};

export interface PromoteOptions {
  apply: boolean;
  allowUnscreenedDoctrines: boolean;
  libraries: string[];
  target: DbTarget;
  /** Test seam. Runs inside the transaction after the writes and before commit. */
  afterWrite?: (client: pg.Client) => Promise<void>;
}

export interface PromoteCounts {
  selected: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  sources: number;
  doctrines: number;
  aliases: number;
}

interface Staged {
  id: string;
  file_path: string;
  record_kind: string;
  record_key: string;
  library: string;
  country: string | null;
  target_table: string;
  target_key: string | null;
  approved_payload: Record<string, unknown>;
  approved_payload_sha256: string;
  source_keys: string[];
  provenance: Record<string, unknown> | null;
  assumed_fields: string[];
  to_verify: string[];
  confidence: string | null;
  seed_run_id: string | null;
  reviewer_name: string | null;
  reviewer_qualification: string | null;
  decided_on: string | null;
  review: Record<string, unknown> | null;
}

interface Warning {
  code: string;
  detail?: string;
}

interface Planned {
  table: string;
  key: string;
  rows: Record<string, unknown>[];
  specialties: Record<string, unknown>[];
  records: Staged[];
  warnings: Warning[];
}

export async function promote(
  options: PromoteOptions,
): Promise<{ counts: PromoteCounts; issues: Record<string, number>; runId: string }> {
  const issues: Record<string, number> = {};
  const runId = await startRun(options.target, {
    command: 'promote',
    mode: options.apply ? 'apply' : 'dry_run',
    target: options.target.target,
    seedsDir: process.env.KNOWLEDGE_SEEDS_DIR ?? 'scripts/fieldops/seeds',
    folders: [],
    libraries: options.libraries,
    manifestSha256: null,
    args: {
      apply: options.apply,
      allowUnscreenedDoctrines: options.allowUnscreenedDoctrines,
      libraries: options.libraries,
    },
  });
  try {
    const counts = await withClient(options.target, async (client) => {
      try {
        await beginImport(client, runId);
        const result = await writePromotion(client, options, runId, issues);
        if (options.afterWrite) await options.afterWrite(client);
        if (options.apply) await client.query('COMMIT');
        else await client.query('ROLLBACK');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
    await finishRun(
      options.target,
      runId,
      options.apply ? 'succeeded' : 'rolled_back',
      { ...counts },
      issues,
    );
    console.log(
      `promote ${options.apply ? 'apply' : 'dry-run'}: selected ${counts.selected}, inserted ${counts.inserted}, updated ${counts.updated}, unchanged ${counts.unchanged}, skipped ${counts.skipped}, sources ${counts.sources}, doctrines ${counts.doctrines}, aliases ${counts.aliases}, issues ${JSON.stringify(issues)}`,
    );
    return { counts, issues, runId };
  } catch (error) {
    await finishRun(
      options.target,
      runId,
      'failed',
      {},
      issues,
      error instanceof Error ? error.message : 'promote failed',
    );
    throw error;
  }
}

async function writePromotion(
  client: pg.Client,
  options: PromoteOptions,
  runId: string,
  issues: Record<string, number>,
): Promise<PromoteCounts> {
  const counts: PromoteCounts = {
    selected: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    sources: 0,
    doctrines: 0,
    aliases: 0,
  };
  const records = await loadRecords(client, options.libraries);
  counts.selected = records.length;
  const present = await loadPresent(client);
  const titles = new Map<string, string>();
  for (const record of records) {
    if (record.record_kind !== 'source') continue;
    const key = text(record.approved_payload.source_key);
    const title = text(record.approved_payload.title);
    if (key && title) titles.set(key, title);
  }
  const groups = new Map<string, Staged[]>();
  for (const record of records) {
    if (record.target_table === 'fieldops_knowledge_sources') continue;
    const key = `${record.target_table}\0${record.target_key ?? record.record_key}`;
    const list = groups.get(key) ?? [];
    list.push(record);
    groups.set(key, list);
  }
  const planned: Planned[] = [];
  for (const table of PROMOTE_ORDER) {
    if (table === 'fieldops_knowledge_sources') continue;
    if (table === 'doctrines' && !options.allowUnscreenedDoctrines) {
      const doctrines = records.filter((record) => record.target_table === 'doctrines');
      if (doctrines.length > 0) bump(issues, 'save_screen_unavailable', doctrines.length);
      counts.skipped += doctrines.length;
      continue;
    }
    for (const [groupKey, group] of groups) {
      if (!groupKey.startsWith(`${table}\0`)) continue;
      const built = buildGroup(table, group, issues, titles);
      if (!built) {
        counts.skipped += group.length;
        continue;
      }
      if (table === 'fieldops_incident_types' || table === 'fieldops_hazard_interactions') {
        built.warnings = built.warnings.filter((warning) => warning.code !== 'dangling_reference');
        const threatKeys =
          table === 'fieldops_incident_types'
            ? asStrings(built.rows[0]?.threat_keys)
            : [text(built.rows[0]?.threat_key)].filter(Boolean);
        for (const key of threatKeys) {
          if (!present.get('fieldops_threat_profiles')?.has(key)) {
            built.warnings.push({ code: 'dangling_reference', detail: key });
            bump(issues, 'dangling_reference');
          }
        }
      }
      const missing = missingForeign(table, built.rows[0] ?? {}, present);
      if (missing) {
        console.log(`promote fk ${built.key}: ${missing}`);
        await warn(client, group, 'fk_target_not_promoted', missing);
        bump(issues, 'fk_target_not_promoted');
        counts.skipped += group.length;
        continue;
      }
      const failed = built.rows.flatMap((row) =>
        table === 'team_archetype_aliases' || table === 'doctrines'
          ? []
          : failedChecks(table, withVersion(table, row)),
      );
      if (failed.length > 0) {
        await warn(client, group, `sql_check:${failed[0]}`, failed.join(','));
        bump(issues, 'sql_check');
        counts.skipped += group.length;
        console.log(`promote skip ${built.key}: ${failed.join(', ')}`);
        continue;
      }
      planned.push(built);
      const column = primary(table)[0];
      if (column) {
        const set = present.get(table) ?? new Set<string>();
        for (const row of built.rows) set.add(String(row[column]));
        present.set(table, set);
      }
    }
  }
  const blocked = blockedSourceKeys(records);
  const sources = buildSources(records, planned, blocked, issues);
  for (const source of sources) {
    const outcome = await writeRow(client, 'fieldops_knowledge_sources', source, runId);
    tally(counts, outcome);
    if (outcome !== 'unchanged') counts.sources += 1;
  }
  const imported = new Map<string, number>();
  for (const item of planned) {
    if (item.table === 'doctrines') {
      const outcome = await writeDoctrine(client, item, runId, issues);
      tally(counts, outcome);
      if (outcome !== 'unchanged') counts.doctrines += 1;
    } else if (item.table === 'team_archetype_aliases') {
      for (const row of item.rows) {
        const outcome = await writeAlias(client, row);
        tally(counts, outcome);
        if (outcome === 'inserted') counts.aliases += 1;
      }
    } else {
      for (const row of item.rows) {
        const outcome = await writeRow(client, item.table, row, runId);
        tally(counts, outcome);
      }
      if (item.table === 'fieldops_hospitals') await replaceSpecialties(client, item);
    }
    if (item.rows.length > 0 || item.table === 'doctrines') {
      await markPromoted(client, item, runId);
      await cover(client, item, runId);
      for (const record of item.records) {
        if (!record.seed_run_id) continue;
        imported.set(record.seed_run_id, (imported.get(record.seed_run_id) ?? 0) + 1);
      }
    }
  }
  for (const [id, count] of imported) {
    if (count > 0) {
      await client.query(
        `UPDATE public.fieldops_seed_runs SET rows_imported = rows_imported + $2 WHERE id = $1`,
        [id, count],
      );
    }
  }
  return counts;
}

async function loadRecords(client: pg.Client, libraries: string[]): Promise<Staged[]> {
  const result = await client.query<Staged>(
    `SELECT id::text, file_path, record_kind, record_key, library, country, target_table, target_key,
            approved_payload, approved_payload_sha256, source_keys, provenance, assumed_fields, to_verify,
            confidence, seed_run_id::text, reviewer_name, reviewer_qualification, decided_on::text, review
       FROM public.fieldops_knowledge_records
      WHERE review_state IN ('approved', 'amended')
        AND blocker_count = 0
        AND missing_since IS NULL
        AND target_table IS NOT NULL
        AND ($1::text[] IS NULL OR library = ANY($1::text[]))
      ORDER BY file_path, record_kind, record_key`,
    [libraries.length > 0 ? libraries : null],
  );
  return result.rows.map((row) => ({
    ...row,
    approved_payload: asObject(row.approved_payload),
    provenance: row.provenance ? asObject(row.provenance) : null,
    review: row.review ? asObject(row.review) : null,
    source_keys: row.source_keys ?? [],
    assumed_fields: row.assumed_fields ?? [],
    to_verify: row.to_verify ?? [],
  }));
}

async function loadPresent(client: pg.Client): Promise<Map<string, Set<string>>> {
  const present = new Map<string, Set<string>>();
  const tables: [string, string][] = [
    ['fieldops_spread_materials', 'material_key'],
    ['fieldops_release_agents', 'agent_key'],
    ['fieldops_threat_profiles', 'threat_key'],
    ['fieldops_building_types', 'type_key'],
    ['fieldops_hazard_item_kinds', 'kind_key'],
    ['fieldops_unit_kinds', 'kind_key'],
    ['fieldops_equipment', 'equipment_key'],
    ['fieldops_hospitals', 'hospital_key'],
    ['team_archetypes', 'key'],
  ];
  for (const [table, column] of tables) {
    const result = await client.query<{ key: string }>(
      `SELECT ${column} AS key FROM public.${table}`,
    );
    present.set(table, new Set(result.rows.map((row) => row.key)));
  }
  return present;
}

function buildGroup(
  table: string,
  group: Staged[],
  issues: Record<string, number>,
  titles: Map<string, string>,
): Planned | null {
  const ordered = [...group].sort(
    (a, b) =>
      folderRank(a.file_path) - folderRank(b.file_path) || a.file_path.localeCompare(b.file_path),
  );
  if (table === 'fieldops_spread_materials') return buildSpread(ordered, issues);
  if (table === 'doctrines') return buildDoctrine(ordered[0]!);
  if (table === 'team_archetype_aliases') return buildAliases(ordered[0]!);
  if (table === 'fieldops_hospitals') return buildHospital(ordered[0]!, titles, issues);
  if (table === 'fieldops_capacity_aggregates') return buildAggregate(ordered[0]!, titles);
  if (table === 'fieldops_response_standards') return buildStandard(ordered[0]!, titles);
  if (table === 'fieldops_knowledge_reference_values') return buildReference(ordered[0]!);
  if (table === 'fieldops_explosive_materials') return buildExplosive(ordered, issues);
  if (table === 'fieldops_injury_thresholds') return buildInjury(ordered, issues);
  return buildPlain(table, ordered, issues);
}

function buildSpread(group: Staged[], issues: Record<string, number>): Planned | null {
  const planning = group.filter((record) => isPlanning(record.file_path));
  const patches = group.filter((record) => !isPlanning(record.file_path));
  if (planning.length === 0) {
    bump(issues, 'base_row_not_approved', group.length);
    return null;
  }
  const base = mergeIdentical(planning, issues);
  if (!base) return null;
  const patch = patches.length > 0 ? mergeIdentical(patches, issues) : null;
  if (patches.length > 0 && !patch) return null;
  const overlaid = overlaySpread(base.approved_payload, patch ? patch.approved_payload : null);
  const row = materialRow(overlaid);
  return planned('fieldops_spread_materials', String(row.material_key), [row], group, []);
}

function buildPlain(
  table: string,
  group: Staged[],
  issues: Record<string, number>,
): Planned | null {
  const chosen = mergeIdentical(group, issues);
  if (!chosen) return null;
  const row = plainRow(table, chosen);
  const warnings: Warning[] = [];
  if (table === 'fieldops_threat_profiles') warnings.push({ code: 'threat_params_unchecked' });
  return planned(table, String(row[primary(table)[0] ?? 'id']), [row], group, warnings);
}

function buildExplosive(group: Staged[], issues: Record<string, number>): Planned | null {
  const chosen = mergeIdentical(group, issues);
  if (!chosen) return null;
  const payload = chosen.approved_payload;
  const row = {
    material_key: payload.material_key,
    label: payload.label,
    aliases: asStrings(payload.aliases),
    tnt_eq_pressure: payload.tnt_eq_pressure,
    tnt_eq_impulse: payload.tnt_eq_impulse,
    confidence: chosen.confidence ?? 'medium',
    is_unknown_default: payload.is_unknown_default === true,
    sort_order: payload.sort_order ?? 0,
    source_ref: cut(text(payload.source_ref) || 'seed', 300),
    review_state: 'unreviewed',
    status: 'active',
  };
  return planned('fieldops_explosive_materials', String(row.material_key), [row], group, []);
}

function buildInjury(group: Staged[], issues: Record<string, number>): Planned | null {
  const chosen = mergeIdentical(group, issues);
  if (!chosen) return null;
  const payload = chosen.approved_payload;
  const row = {
    threshold_key: payload.threshold_key,
    effect_class: payload.effect_class,
    band: payload.band,
    metric: payload.metric,
    value: payload.value,
    applies_to: payload.applies_to,
    label: payload.label,
    source_ref: cut(text(payload.source_ref) || 'seed', 300),
    review_state: 'unreviewed',
    status: 'active',
  };
  return planned('fieldops_injury_thresholds', String(row.threshold_key), [row], group, []);
}

function buildStandard(record: Staged, titles: Map<string, string>): Planned {
  const payload = record.approved_payload;
  const values = asArray(payload.values);
  const numbers = responseNumbers(values);
  const keys = sourceKeys(record);
  const row = {
    standard_key: payload.key ?? record.target_key,
    label: payload.label,
    country: payload.country ?? record.country,
    scope: payload.scope,
    incident_types: asStrings(payload.incident_types),
    ...numbers,
    stated_values: values,
    site_bound: payload.site_bound === true,
    source_keys: keys,
    source_ref: sourceRefFromTitles(keys, titles),
    source_note: valuesNote(payload, values),
    status: 'active',
  };
  return planned('fieldops_response_standards', String(row.standard_key), [row], [record], []);
}

function buildHospital(
  record: Staged,
  titles: Map<string, string>,
  issues: Record<string, number>,
): Planned | null {
  const payload = record.approved_payload;
  const values = asArray(payload.values);
  const beds = hospitalBeds(values);
  const location = Array.isArray(payload.location) ? payload.location : [];
  const keys = sourceKeys(record);
  const specialties = specialtiesOf(payload);
  if (specialties === null) {
    bump(issues, 'sql_check');
    return null;
  }
  const row = {
    hospital_key: payload.key ?? record.target_key,
    name: payload.name,
    country: payload.country ?? record.country,
    ownership: payload.ownership,
    cluster: payload.cluster ?? null,
    acute: payload.acute === true,
    emergency_department: payload.emergency_department === true,
    lat: typeof location[0] === 'number' ? location[0] : null,
    lng: typeof location[1] === 'number' ? location[1] : null,
    osm_id: payload.osm_id ?? null,
    beds: beds.beds,
    beds_year: beds.bedsYear,
    stated_values: values,
    source_keys: keys,
    source_ref: sourceRefFromTitles(keys, titles),
    source_note: valuesNote(payload, values),
    status: 'active',
  };
  const item = planned('fieldops_hospitals', String(row.hospital_key), [row], [record], []);
  item.specialties = specialties.map((entry) => ({ ...entry, hospital_key: row.hospital_key }));
  return item;
}

function buildAggregate(record: Staged, titles: Map<string, string>): Planned {
  const payload = record.approved_payload;
  const values = asArray(payload.values);
  const keys = sourceKeys(record);
  const row = {
    aggregate_key: payload.key ?? record.target_key,
    label: payload.label,
    country: payload.country ?? record.country,
    scope: payload.scope,
    stated_values: values,
    source_keys: keys,
    source_ref: sourceRefFromTitles(keys, titles),
    source_note: valuesNote(payload, values),
    status: 'active',
  };
  return planned('fieldops_capacity_aggregates', String(row.aggregate_key), [row], [record], []);
}

function buildReference(record: Staged): Planned | null {
  const payload = record.approved_payload;
  const curve = record.record_kind === 'curve_table';
  if (!curve && payload.value == null) return null;
  const row = {
    library: curve ? 'blast_effects' : record.library,
    ref_key: curve ? record.target_key : (payload.ref_key ?? record.target_key),
    topic: curve ? 'airblast_curve' : payload.topic,
    value: curve ? payload : payload.value,
    unit: curve ? 'see value' : payload.unit,
    formula: curve ? null : (payload.formula ?? null),
    note: cut(text(curve ? payload.relative_uncertainty_note : payload.note), 4000) || null,
    spec_ref: curve ? null : cut(text(payload.spec_ref), 400) || null,
    extends: curve ? null : cut(text(payload.extends), 400) || null,
    worked_example: curve ? null : (payload.worked_example ?? null),
    provenance: record.provenance ?? asObject(payload.provenance),
    confidence: record.confidence,
    assumed_fields: record.assumed_fields,
    to_verify: record.to_verify,
    source_keys: sourceKeys(record),
    record_id: record.id,
    status: 'active',
  };
  if (row.note === '') row.note = null;
  return planned(
    'fieldops_knowledge_reference_values',
    `${row.library}/${row.ref_key}`,
    [row],
    [record],
    [],
  );
}

function buildDoctrine(record: Staged): Planned {
  return planned('doctrines', record.record_key, [{}], [record], []);
}

function buildAliases(record: Staged): Planned {
  const payload = record.approved_payload;
  const allowed = new Set(asStrings(payload.archetype_keys));
  const rows: Record<string, unknown>[] = [];
  const warnings: Warning[] = [];
  for (const item of asArray(payload.aliases)) {
    const alias = asObject(item);
    const archetype = text(alias.archetype_key);
    if (!allowed.has(archetype)) continue;
    const phrase = normaliseTeamText(text(alias.phrase));
    if (phrase.length < 2 || phrase.length > 80) {
      warnings.push({ code: 'alias_too_short', detail: text(alias.phrase) });
      continue;
    }
    const kind = text(alias.kind);
    if (kind !== 'exact' && kind !== 'function' && kind !== 'organisation') continue;
    rows.push({
      archetype_key: archetype,
      phrase,
      kind,
      country: record.country,
      agency_name: payload.name,
      source: 'seeded',
      source_ref: cut(`sea/${record.country ?? 'XX'}/agencies.json#${text(payload.key)}`, 200),
      is_active: true,
    });
  }
  return planned('team_archetype_aliases', record.record_key, rows, [record], warnings);
}

function materialRow(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    material_key: payload.material_key,
    material_role: payload.material_role,
    label: payload.label,
    aliases: asStrings(payload.aliases),
    combustible: payload.combustible === true,
    flame_spread_m_min: payload.flame_spread_m_min ?? null,
    burn_duration_s: payload.burn_duration_s ?? null,
    extinguish_s: payload.extinguish_s ?? null,
    smoke_yield: payload.smoke_yield ?? 'none',
    heat_release: payload.heat_release ?? 'none',
    hrrpua_kw_m2: payload.hrrpua_kw_m2 ?? null,
    heat_of_combustion_mj_kg: payload.heat_of_combustion_mj_kg ?? null,
    soot_yield: payload.soot_yield ?? null,
    co_yield: payload.co_yield ?? null,
    critical_heat_flux_kw_m2: payload.critical_heat_flux_kw_m2 ?? null,
    thermal_response_kw_s05_m2: payload.thermal_response_kw_s05_m2 ?? null,
    lining_krhoc: payload.lining_krhoc ?? null,
    soot_yield_post_fo: payload.soot_yield_post_fo ?? null,
    co_yield_post_fo: payload.co_yield_post_fo ?? null,
    burn_through_s: payload.burn_through_s ?? null,
    smoke_leak: payload.smoke_leak ?? 0,
    gas_leak: payload.gas_leak ?? 0,
    glazed: payload.glazed === true,
    fire_resistance_min: payload.fire_resistance_min ?? null,
    creep_per_min: payload.creep_per_min ?? null,
    source_ref: cut(text(payload.source_ref) || 'seed', 300),
    source_note: cut(text(payload.source_note) || 'seed', 400),
    status: 'active',
  };
}

function plainRow(table: string, record: Staged): Record<string, unknown> {
  const payload = record.approved_payload;
  const keys = sourceKeys(record);
  const copy = (
    names: string[],
    defaults: Record<string, unknown> = {},
  ): Record<string, unknown> => {
    const row: Record<string, unknown> = { ...defaults, source_keys: keys, status: 'active' };
    for (const name of names) if (payload[name] !== undefined) row[name] = payload[name];
    if (typeof row.source_ref === 'string') row.source_ref = cut(row.source_ref, 300);
    if (typeof row.source_note === 'string') row.source_note = cut(row.source_note, 400);
    return row;
  };
  if (table === 'fieldops_release_agents') {
    return copy(
      [
        'agent_key',
        'label',
        'cas_number',
        'molecular_weight',
        'density_ratio',
        'boiling_point_c',
        'lfl_pct',
        'ufl_pct',
        'tier_scheme',
        'tiers',
        'toxic_load_n',
        'irritant',
        'source_ref',
        'source_note',
      ],
      { tiers: [], irritant: false, tier_scheme: null, toxic_load_n: null },
    );
  }
  if (table === 'fieldops_threat_profiles') {
    return copy(
      [
        'threat_key',
        'label',
        'category',
        'model',
        'parameters',
        'environment',
        'source_ref',
        'source_note',
      ],
      { parameters: {}, environment: [] },
    );
  }
  if (table === 'fieldops_movement_parameters') {
    return copy([
      'param_key',
      'label',
      'applies_to',
      'value',
      'unit',
      'plausible_low',
      'plausible_high',
      'source_ref',
      'source_note',
    ]);
  }
  if (table === 'fieldops_incident_types') {
    return copy(
      [
        'incident_type',
        'label',
        'type_group',
        'phase',
        'event_kind',
        'threat_keys',
        'responder_archetypes',
        'catalogue_needs',
        'template_file',
        'sensitivity',
        'briefing_note',
        'source_ref',
        'source_note',
      ],
      { catalogue_needs: [], threat_keys: [], responder_archetypes: [] },
    );
  }
  if (table === 'fieldops_building_types') {
    return copy(
      [
        'type_key',
        'label',
        'country',
        'place_classes',
        'building_tags',
        'priority',
        'storey_height_m',
        'basement_storey_height_m',
        'contents_key',
        'frame_key',
        'sprinklered_permille',
        'smoke_control',
        'facade_class',
        'external_spread_permille',
        'occupant_m2_per_person',
        'occupancy_by_hour',
        'familiarity',
        'sensitivity',
        'source_ref',
        'source_note',
      ],
      {
        place_classes: [],
        building_tags: [],
        occupancy_by_hour: [],
        smoke_control: false,
        country: null,
        occupant_m2_per_person: null,
      },
    );
  }
  if (table === 'fieldops_hazard_item_kinds') {
    return copy(
      [
        'kind_key',
        'label',
        'category',
        'phase',
        'agent_key',
        'contents_key',
        'threat_keys',
        'stored_pressure_bar',
        'flash_point_c',
        'mitigates',
        'activation_c',
        'rti',
        'sensitivity',
        'source_ref',
        'source_note',
      ],
      { threat_keys: [], agent_key: null, contents_key: null, mitigates: null, rti: null },
    );
  }
  if (table === 'fieldops_building_items') {
    return copy(
      [
        'type_key',
        'kind_key',
        'location_kind',
        'quantity_band',
        'quantity_low',
        'quantity_high',
        'quantity_unit',
        'likelihood_permille',
        'per_storey',
        'auto_place',
        'source_ref',
        'source_note',
      ],
      {
        quantity_low: null,
        quantity_high: null,
        quantity_unit: null,
        per_storey: false,
        auto_place: false,
      },
    );
  }
  if (table === 'fieldops_hazard_interactions') {
    return copy(
      [
        'rule_key',
        'kind_key',
        'trigger',
        'threshold',
        'effect',
        'threat_key',
        'agent_key',
        'delay_low_s',
        'delay_high_s',
        'probability_permille',
        'requires_ignition_source',
        'event_text',
        'source_ref',
        'source_note',
      ],
      { threat_key: null, agent_key: null, requires_ignition_source: false },
    );
  }
  if (table === 'fieldops_unit_kinds') {
    return copy(
      [
        'kind_key',
        'label',
        'country',
        'archetype_key',
        'mode',
        'crew',
        'default_count',
        'turnout_s',
        'observes_m',
        'asset_type',
        'tasks',
        'starts_from',
        'source_ref',
        'source_note',
      ],
      { tasks: [], starts_from: [], country: null },
    );
  }
  if (table === 'fieldops_equipment') {
    return copy(
      [
        'equipment_key',
        'label',
        'category',
        'capacity',
        'unit',
        'consumable',
        'source_ref',
        'source_note',
      ],
      { consumable: false },
    );
  }
  return {
    kind_key: payload.kind_key,
    equipment_key: payload.equipment_key,
    quantity: payload.quantity,
  };
}

function buildSources(
  records: Staged[],
  planned: Planned[],
  blocked: Set<string>,
  issues: Record<string, number>,
): Record<string, unknown>[] {
  const cited = new Map<string, Set<string>>();
  const remember = (key: string, library: string) => {
    if (!key || blocked.has(key)) return;
    const set = cited.get(key) ?? new Set<string>();
    set.add(library);
    cited.set(key, set);
  };
  for (const item of planned) {
    for (const record of item.records) {
      for (const key of sourceKeys(record)) remember(key, record.library);
    }
  }
  const byKey = new Map<string, Staged[]>();
  for (const record of records) {
    if (record.record_kind !== 'source') continue;
    const key = text(record.approved_payload.source_key);
    if (!cited.has(key) || blocked.has(key)) continue;
    const list = byKey.get(key) ?? [];
    list.push(record);
    byKey.set(key, list);
  }
  const used = new Map<string, string>();
  const drafts: Record<string, unknown>[] = [];
  for (const [key, group] of byKey) {
    const row = mergeSource(key, group, cited.get(key) ?? new Set(), false, issues);
    if (row) drafts.push(row);
  }
  for (const item of planned) {
    for (const record of item.records) {
      for (const source of inlineSources(record)) {
        const url = text(source.url);
        if (!url) continue;
        const key = assignDoctrineSourceKey(url, used);
        if (byKey.has(key) || blocked.has(key)) continue;
        const row = sourceFromInline(
          key,
          source,
          record,
          cited.get(key) ?? new Set([record.library]),
        );
        if (row) {
          drafts.push(row);
          byKey.set(key, []);
        }
      }
    }
  }
  return drafts;
}

function mergeSource(
  key: string,
  group: Staged[],
  libraries: Set<string>,
  doctrine: boolean,
  issues: Record<string, number>,
): Record<string, unknown> | null {
  const ordered = [...group].sort((a, b) => folderRank(a.file_path) - folderRank(b.file_path));
  const canonical =
    ordered.find((record) => record.approved_payload.canonical === true) ?? ordered[0];
  if (!canonical) return null;
  const payload = canonical.approved_payload;
  const accessed = ordered
    .map((record) => accessedOn(record.approved_payload))
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  if (!accessed) return null;
  const url = httpsUrl(payload.url);
  if (payload.url && !url) bump(issues, 'url_not_https');
  const published = fullDate(payload.published_on) ?? fullDate(payload.published);
  const givenNext = ordered
    .map((record) => fullDate(record.approved_payload.next_review_due))
    .filter((value): value is string => Boolean(value))
    .sort()[0];
  const interval = reviewInterval(payload, accessed, givenNext ?? null, doctrine);
  const next = givenNext ?? addDays(accessed, interval);
  const mapped = [
    ...new Set([
      ...mapLibraries(asArray(payload.libraries)),
      ...[...libraries].flatMap((library) => mapLibraries([library])),
    ]),
  ].sort();
  if (mapped.length === 0) return null;
  const title = cut(text(payload.title), 300);
  const publisher = cut(text(payload.publisher), 200);
  const terms = cut(text(payload.terms_note) || 'terms not stated', 300);
  if (title.length < 3 || publisher.length < 2 || terms.length < 3) return null;
  const status =
    payload.status === 'superseded' || payload.status === 'withdrawn' ? payload.status : 'active';
  return {
    source_key: key,
    title,
    publisher,
    url,
    published_on: published,
    accessed_on: accessed,
    language: /^[a-z]{2,3}$/.test(text(payload.language)) ? text(payload.language) : 'en',
    terms_note: terms,
    content_hash: /^[0-9a-f]{64}$/.test(text(payload.content_hash))
      ? text(payload.content_hash)
      : null,
    review_interval_days: interval,
    next_review_due: next,
    libraries: mapped,
    first_run_id: canonical.seed_run_id,
    status,
  };
}

function sourceFromInline(
  key: string,
  source: Record<string, unknown>,
  record: Staged,
  libraries: Set<string>,
): Record<string, unknown> | null {
  const accessed = accessedOn(source);
  if (!accessed) return null;
  const payload = {
    ...source,
    libraries: [...libraries],
    review_interval_days: undefined,
    status: 'active',
  };
  return mergeSource(
    key,
    [{ ...record, approved_payload: payload }],
    libraries,
    record.target_table === 'doctrines',
    {},
  );
}

function inlineSources(record: Staged): Record<string, unknown>[] {
  const payload = record.approved_payload;
  const fromProvenance = asArray(record.provenance?.sources).map(asObject);
  const nested = asArray(asObject(payload.provenance).sources).map(asObject);
  const own = asArray(payload.sources).map(asObject);
  return [...fromProvenance, ...nested, ...own].filter(
    (source) => !text(source.source_key) && text(source.url),
  );
}

async function writeDoctrine(
  client: pg.Client,
  item: Planned,
  runId: string,
  issues: Record<string, number>,
): Promise<'inserted' | 'updated' | 'unchanged'> {
  const record = item.records[0]!;
  const payload = record.approved_payload;
  const contentIn = asObject(payload.content);
  const review = reviewOf(record);
  const stripped = forceRoleSatisfied(review)
    ? contentIn
    : contentWithoutUseOfForce(contentIn).content;
  const withheld =
    'use_of_force' in contentIn && stripped !== contentIn && !('use_of_force' in stripped);
  if (withheld) {
    item.warnings.push({ code: 'use_of_force_withheld' });
    bump(issues, 'use_of_force_withheld');
  }
  const canonical = canonicalJson(stripped);
  const hash = sha256Hex(canonical);
  const bytes = Buffer.byteLength(canonical, 'utf8');
  const sources = asArray(asObject(payload.provenance).sources);
  const note = seedNote(
    sources,
    record.reviewer_name ?? 'reviewer',
    record.decided_on ?? '2026-11-22',
  );
  const applies = asStrings(payload.applies_to);
  const existing = await client.query<{ id: string; latest_version: number }>(
    `SELECT id::text, latest_version FROM public.doctrines
      WHERE archetype_key = $1 AND COALESCE(country, '') = COALESCE($2, '')
        AND lower(title) = lower($3) AND visibility = 'library' AND retired_at IS NULL`,
    [payload.archetype_key, payload.country ?? null, payload.title],
  );
  const current = existing.rows[0];
  let doctrineId = current?.id;
  let version = current?.latest_version ?? 1;
  let outcome: 'inserted' | 'updated' | 'unchanged' = 'unchanged';
  if (!current) {
    const created = await client.query<{
      result: { ok?: boolean; code?: string; doctrine_id?: string; version?: number };
    }>(
      `SELECT public.fieldops_create_doctrine(
         $1, $2, 'seeded', 'library', NULL, NULL, NULL, NULL, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, NULL
       ) AS result`,
      [
        payload.archetype_key,
        payload.title,
        applies,
        JSON.stringify(stripped),
        hash,
        bytes,
        asObject(payload.provenance).drafted_by === 'agent',
        note,
        [],
        payload.country ?? null,
        payload.agency_name ?? null,
      ],
    );
    const body = created.rows[0]?.result;
    if (!body?.ok || !body.doctrine_id) {
      throw new Error(`doctrine ${record.record_key}: ${body?.code ?? 'create failed'}`);
    }
    doctrineId = body.doctrine_id;
    version = body.version ?? 1;
    outcome = 'inserted';
  } else {
    const next = await client.query<{ result: { ok?: boolean; code?: string; version?: number } }>(
      `SELECT public.fieldops_create_doctrine_version(
         $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, NULL
       ) AS result`,
      [
        current.id,
        current.latest_version,
        payload.title,
        applies,
        JSON.stringify(stripped),
        hash,
        bytes,
        asObject(payload.provenance).drafted_by === 'agent',
        note,
        [],
      ],
    );
    const body = next.rows[0]?.result;
    if (body?.code === 'DOCTRINE_UNCHANGED') outcome = 'unchanged';
    else if (!body?.ok)
      throw new Error(`doctrine ${record.record_key}: ${body?.code ?? 'version failed'}`);
    else {
      version = body.version ?? current.latest_version + 1;
      outcome = 'updated';
    }
  }
  if (outcome !== 'unchanged' && doctrineId) {
    await client.query(
      `INSERT INTO public.doctrine_events (doctrine_id, version, event_type, details)
       VALUES ($1, $2, 'seeded', $3::jsonb)`,
      [
        doctrineId,
        version,
        JSON.stringify({
          file_path: record.file_path,
          content_hash: hash,
          import_run_id: runId,
          version,
        }),
      ],
    );
  }
  item.key = `${payload.archetype_key}/${payload.country ?? ''}/${text(payload.title)}`;
  return outcome;
}

async function writeAlias(
  client: pg.Client,
  row: Record<string, unknown>,
): Promise<'inserted' | 'updated' | 'unchanged'> {
  const present = await client.query(`SELECT 1 FROM public.team_archetypes WHERE key = $1`, [
    row.archetype_key,
  ]);
  if (present.rowCount === 0) return 'unchanged';
  const result = await client.query(
    `INSERT INTO public.team_archetype_aliases
       (archetype_key, phrase, kind, country, agency_name, source, source_ref, is_active)
     VALUES ($1, $2, $3, $4, $5, 'seeded', $6, true)
     ON CONFLICT (archetype_key, phrase, (COALESCE(country, ''))) DO NOTHING
     RETURNING archetype_key`,
    [row.archetype_key, row.phrase, row.kind, row.country, row.agency_name, row.source_ref],
  );
  return result.rowCount ? 'inserted' : 'unchanged';
}

async function writeRow(
  client: pg.Client,
  table: string,
  row: Record<string, unknown>,
  runId: string,
): Promise<'inserted' | 'updated' | 'unchanged'> {
  const keys = primary(table);
  const where = keys.map((column, index) => `${column} = $${index + 1}`).join(' AND ');
  const existing = await client.query<{ row: Record<string, unknown> }>(
    `SELECT to_jsonb(t) AS row FROM public.${table} t WHERE ${where}`,
    keys.map((column) => row[column]),
  );
  const before = existing.rows[0]?.row;
  const version = VERSION[table] === undefined ? 'row_version' : VERSION[table];
  if (!before) {
    await insertRow(client, table, row);
    await changeLog(client, table, row, null, 'seed', runId);
    return 'inserted';
  }
  if (sameRow(before, row)) return 'unchanged';
  await updateRow(client, table, row, keys, version);
  await changeLog(client, table, row, before, 'update', runId);
  return 'updated';
}

async function insertRow(
  client: pg.Client,
  table: string,
  row: Record<string, unknown>,
): Promise<void> {
  const columns = Object.keys(row).filter((column) => row[column] !== undefined);
  const values = columns.map((column) => bindValue(table, column, row[column]));
  const placeholders = columns.map((column, index) =>
    jsonColumn(table, column) ? `$${index + 1}::jsonb` : `$${index + 1}`,
  );
  await client.query(
    `INSERT INTO public.${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
    values,
  );
}

async function updateRow(
  client: pg.Client,
  table: string,
  row: Record<string, unknown>,
  keys: string[],
  version: string | null,
): Promise<void> {
  const columns = Object.keys(row).filter(
    (column) => !keys.includes(column) && row[column] !== undefined && column !== 'review_state',
  );
  const assignments = columns.map((column, index) =>
    jsonColumn(table, column) ? `${column} = $${index + 1}::jsonb` : `${column} = $${index + 1}`,
  );
  if (version) assignments.push(`${version} = t.${version} + 1`);
  const where = keys.map((column, index) => `t.${column} = $${columns.length + index + 1}`);
  await client.query(
    `UPDATE public.${table} AS t SET ${assignments.join(', ')} WHERE ${where.join(' AND ')}`,
    [
      ...columns.map((column) => bindValue(table, column, row[column])),
      ...keys.map((column) => row[column]),
    ],
  );
}

async function changeLog(
  client: pg.Client,
  table: string,
  row: Record<string, unknown>,
  before: Record<string, unknown> | null,
  action: 'seed' | 'update',
  runId: string,
): Promise<void> {
  const rowKey = primary(table)
    .map((column) => String(row[column] ?? ''))
    .join('/')
    .slice(
      0,
      table.startsWith('fieldops_explosive') || table.startsWith('fieldops_injury') ? 64 : 120,
    );
  if (SPREAD_LOG[table]) {
    await client.query(
      `INSERT INTO public.fieldops_spread_changes (table_name, row_key, action, row_before, row_after)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
      [
        SPREAD_LOG[table],
        rowKey,
        action,
        before ? JSON.stringify(before) : null,
        JSON.stringify(row),
      ],
    );
  }
  if (PHYSICS_LOG.has(table)) {
    await client.query(
      `INSERT INTO public.fieldops_physics_library_changes (table_name, row_key, action, before_row, after_row)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
      [table, rowKey, action, before ? JSON.stringify(before) : null, JSON.stringify(row)],
    );
  }
  void runId;
}

async function replaceSpecialties(client: pg.Client, item: Planned): Promise<void> {
  const hospital = text(item.rows[0]?.hospital_key);
  const roles = item.specialties.map((row) => text(row.role));
  await client.query(
    `DELETE FROM public.fieldops_hospital_specialties
      WHERE hospital_key = $1 AND NOT (role = ANY($2::text[]))`,
    [hospital, roles],
  );
  for (const specialty of item.specialties) {
    await client.query(
      `INSERT INTO public.fieldops_hospital_specialties
         (hospital_key, role, level, status, source_key, locator, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (hospital_key, role) DO UPDATE SET
         level = EXCLUDED.level, status = EXCLUDED.status, source_key = EXCLUDED.source_key,
         locator = EXCLUDED.locator, note = EXCLUDED.note
       WHERE (fieldops_hospital_specialties.level, fieldops_hospital_specialties.status,
              fieldops_hospital_specialties.source_key, fieldops_hospital_specialties.locator,
              fieldops_hospital_specialties.note)
             IS DISTINCT FROM (EXCLUDED.level, EXCLUDED.status, EXCLUDED.source_key, EXCLUDED.locator, EXCLUDED.note)`,
      [
        specialty.hospital_key,
        specialty.role,
        specialty.level ?? null,
        specialty.status,
        specialty.source_key ?? null,
        specialty.locator ?? null,
        specialty.note ?? null,
      ],
    );
  }
}

async function markPromoted(client: pg.Client, item: Planned, runId: string): Promise<void> {
  for (const record of item.records) {
    const extra = item.warnings.filter((warning) => warning.code !== 'dangling_reference' || true);
    await client.query(
      `UPDATE public.fieldops_knowledge_records
          SET promoted_at = COALESCE(promoted_at, now()),
              promoted_payload_sha256 = $2,
              promoted_import_run_id = $3,
              issues = issues || $4::jsonb,
              warning_count = warning_count + $5,
              assumed_fields = CASE
                WHEN $6 AND NOT ('source not accessed' = ANY(assumed_fields))
                  THEN assumed_fields || ARRAY['source not accessed']
                ELSE assumed_fields END
        WHERE id = $1
          AND promoted_payload_sha256 IS DISTINCT FROM $2`,
      [
        record.id,
        record.approved_payload_sha256,
        runId,
        JSON.stringify(
          extra.map((warning) => ({
            code: warning.code,
            severity: 'warning',
            detail: warning.detail,
          })),
        ),
        extra.length,
        extra.some((warning) => warning.code === 'unlocated_source_promoted'),
      ],
    );
  }
}

async function cover(client: pg.Client, item: Planned, runId: string): Promise<void> {
  const record = item.records[0];
  if (!record) return;
  const subject = cut(`${item.table}:${item.key}`, 120);
  await client.query(
    `INSERT INTO public.fieldops_knowledge_coverage (library, country, subject_key, status, last_run_id)
     VALUES ($1, $2, $3, 'covered', $4)
     ON CONFLICT (library, COALESCE(country, '--'), subject_key) DO UPDATE
       SET status = 'covered', updated_at = now()
     WHERE public.fieldops_knowledge_coverage.status <> 'covered'`,
    [record.library, record.country, subject, record.seed_run_id],
  );
}

async function warn(
  client: pg.Client,
  records: Staged[],
  code: string,
  detail?: string,
): Promise<void> {
  for (const record of records) {
    await client.query(
      `UPDATE public.fieldops_knowledge_records
          SET issues = issues || $2::jsonb,
              warning_count = warning_count + CASE WHEN issues @> $2::jsonb THEN 0 ELSE 1 END,
              blocker_count = blocker_count + CASE
                WHEN $3 AND NOT issues @> $2::jsonb THEN 1 ELSE 0 END
        WHERE id = $1`,
      [
        record.id,
        JSON.stringify([
          {
            code,
            severity:
              code.startsWith('sql_check') ||
              code === 'base_row_not_approved' ||
              code === 'conflicting_approved_records'
                ? 'blocker'
                : 'warning',
            detail,
          },
        ]),
        code.startsWith('sql_check') ||
          code === 'base_row_not_approved' ||
          code === 'conflicting_approved_records',
      ],
    );
  }
}

function mergeIdentical(group: Staged[], issues: Record<string, number>): Staged | null {
  if (group.length <= 1) return group[0] ?? null;
  const first = group[0]!;
  const base = comparable(first);
  for (const other of group.slice(1)) {
    const diff = Object.keys({ ...base, ...comparable(other) }).filter(
      (key) => !sameValue(base[key], comparable(other)[key]),
    );
    if (diff.length > 0) {
      bump(issues, 'conflicting_approved_records');
      return null;
    }
  }
  return first;
}

function comparable(record: Staged): Record<string, unknown> {
  const copy = { ...record.approved_payload };
  delete copy.source_keys;
  delete copy.source_ref;
  delete copy.source_note;
  return copy;
}

function specialtiesOf(payload: Record<string, unknown>): Record<string, unknown>[] | null {
  const seen = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  for (const item of asArray(payload.specialties)) {
    const entry = asObject(item);
    const role = text(entry.role);
    const status = text(entry.status);
    if (!role || seen.has(role)) return null;
    if (status !== 'sourced' && status !== 'unverified' && status !== 'assumed') return null;
    seen.add(role);
    rows.push({
      role,
      level: entry.level ?? null,
      status,
      source_key: entry.source_key ?? null,
      locator: entry.locator ?? null,
      note: entry.note ?? null,
    });
  }
  return rows;
}

function missingForeign(
  table: string,
  row: Record<string, unknown>,
  present: Map<string, Set<string>>,
): string | null {
  for (const link of FOREIGN[table] ?? []) {
    const value = row[link.column];
    if (value == null || value === '') {
      if (link.optional) continue;
      return link.column;
    }
    if (!present.get(link.table)?.has(String(value))) return `${link.table}.${value}`;
  }
  return null;
}

function blockedSourceKeys(records: Staged[]): Set<string> {
  const blocked = new Set<string>();
  for (const record of records) {
    if (record.record_kind !== 'source') continue;
    const payload = record.approved_payload;
    if (!accessedOn(payload) || payload.access_status === 'not_accessed_unverified') {
      blocked.add(text(payload.source_key));
    }
  }
  return blocked;
}

function sourceKeys(record: Staged): string[] {
  const payload = record.approved_payload;
  const fromValues = [...asArray(payload.values), ...asArray(payload.specialties)]
    .map((item) => text(asObject(item).source_key))
    .filter(Boolean);
  const fromProvenance = asArray(record.provenance?.sources)
    .map((item) => text(asObject(item).source_key))
    .filter(Boolean);
  return unique([
    ...(record.source_keys ?? []),
    ...asStrings(payload.source_keys),
    ...fromValues,
    ...fromProvenance,
  ]);
}

function reviewOf(record: Staged): NormalisedReview {
  const stored = record.review ?? {};
  return {
    state: 'approved',
    reviewerName: record.reviewer_name,
    reviewerQualification: record.reviewer_qualification,
    decidedOn: record.decided_on,
    notes: typeof stored.notes === 'string' ? stored.notes : null,
    reviewerRole: typeof stored.reviewer_role === 'string' ? stored.reviewer_role : null,
    history: Array.isArray(stored.history) ? stored.history : [],
    requiredRoles: [],
    stored,
  };
}

function seedNote(sources: unknown[], reviewer: string, reviewed: string): string {
  const first = asObject(sources[0]);
  const publisher = text(first.publisher) || 'unknown';
  const title = text(first.title) || 'untitled';
  const published = fullDate(first.published) ?? fullDate(first.published_on) ?? 'n.d.';
  const more = sources.length > 1 ? ` and ${sources.length - 1} more` : '';
  return cut(
    `Seeded from ${publisher}: ${title} (${published})${more}; reviewed by ${reviewer} on ${reviewed}.`,
    300,
  );
}

function planned(
  table: string,
  key: string,
  rows: Record<string, unknown>[],
  records: Staged[],
  warnings: Warning[],
): Planned {
  return { table, key, rows, specialties: [], records, warnings };
}

function withVersion(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const version = VERSION[table];
  if (version === null) return row;
  if (version) return { ...row, [version]: row[version] ?? 1 };
  return { ...row, row_version: row.row_version ?? 1 };
}

function primary(table: string): string[] {
  const keys: Record<string, string[]> = {
    fieldops_spread_materials: ['material_key'],
    fieldops_release_agents: ['agent_key'],
    fieldops_threat_profiles: ['threat_key'],
    fieldops_movement_parameters: ['param_key'],
    fieldops_incident_types: ['incident_type'],
    fieldops_building_types: ['type_key'],
    fieldops_hazard_item_kinds: ['kind_key'],
    fieldops_building_items: ['type_key', 'kind_key', 'location_kind'],
    fieldops_hazard_interactions: ['rule_key'],
    fieldops_unit_kinds: ['kind_key'],
    fieldops_equipment: ['equipment_key'],
    fieldops_unit_equipment: ['kind_key', 'equipment_key'],
    fieldops_response_standards: ['standard_key'],
    fieldops_hospitals: ['hospital_key'],
    fieldops_capacity_aggregates: ['aggregate_key'],
    fieldops_explosive_materials: ['material_key'],
    fieldops_injury_thresholds: ['threshold_key'],
    fieldops_knowledge_sources: ['source_key'],
    fieldops_knowledge_reference_values: ['library', 'ref_key'],
  };
  return keys[table] ?? ['id'];
}

function sameRow(before: Record<string, unknown>, row: Record<string, unknown>): boolean {
  return Object.keys(row).every(
    (key) => key === 'review_state' || sameValue(before[key], row[key]),
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left == null || right == null) return left == null && right == null;
  if (left instanceof Date)
    return sameValue(left.toISOString().slice(0, 10), String(right).slice(0, 10));
  if (right instanceof Date)
    return sameValue(String(left).slice(0, 10), right.toISOString().slice(0, 10));
  const a = asNumber(left);
  const b = asNumber(right);
  if (a !== null && b !== null) return a === b;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => sameValue(item, right[index]))
    );
  }
  if (typeof left === 'object' && typeof right === 'object') {
    const l = left as Record<string, unknown>;
    const r = right as Record<string, unknown>;
    const keys = new Set([...Object.keys(l), ...Object.keys(r)]);
    for (const key of keys) if (!sameValue(l[key], r[key])) return false;
    return true;
  }
  return false;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return null;
}

function jsonColumn(table: string, column: string): boolean {
  return (JSON_COLUMNS[table] ?? []).includes(column);
}

function bindValue(table: string, column: string, value: unknown): unknown {
  if (jsonColumn(table, column)) return value == null ? null : JSON.stringify(value);
  return value;
}

function folderRank(filePath: string): number {
  const folder = filePath.replace(/^_incoming\//, '').split('/')[0] ?? '';
  const index = FOLDER_ORDER.indexOf(folder);
  return index < 0 ? 50 : index;
}

function isPlanning(filePath: string): boolean {
  return filePath.replace(/^_incoming\//, '').startsWith('planning/');
}

function accessedOn(payload: Record<string, unknown>): string | null {
  return (
    fullDate(payload.accessed_on) ?? fullDate(payload.accessed) ?? fullDate(payload.accessed_at)
  );
}

function reviewInterval(
  payload: Record<string, unknown>,
  accessed: string,
  next: string | null,
  doctrine: boolean,
): number {
  if (typeof payload.review_interval_days === 'number')
    return clamp(payload.review_interval_days, 30, 1825);
  if (next)
    return clamp(Math.round((Date.parse(next) - Date.parse(accessed)) / 86_400_000), 30, 1825);
  return doctrine ? 180 : 365;
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function tally(counts: PromoteCounts, outcome: 'inserted' | 'updated' | 'unchanged'): void {
  counts[outcome] += 1;
}

function bump(issues: Record<string, number>, code: string, by = 1): void {
  issues[code] = (issues[code] ?? 0) + by;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStrings(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === 'string');
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}
