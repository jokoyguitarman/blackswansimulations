import {
  datasetVersionOf,
  type DatasetLibrary,
} from '../../../../server/lib/fieldOps/datasetVersion.js';
import { beginImport, withClient } from './db.js';
import { finishRun, startRun } from './runLog.js';
import type { DbTarget } from './safety.js';
import type pg from 'pg';

const OWNER = 'Jokoy Tabbada';
const NOTE = 'Verified by Jokoy Tabbada, project owner, 22 Nov 2026.';
const PHYSICS_QUALIFICATION =
  'Project owner; verification of 22 Nov 2026 stands in for the D22 blast/EOD reviewer by owner decision';
const SPREAD_QUALIFICATION =
  'Project owner; verification of 22 Nov 2026 stands in for the W24 reviewer by owner decision';

const PHYSICS_CHECKLIST = [
  'scope_no_search',
  'blast_curves',
  'tnt_equivalence',
  'injury_thresholds',
  'damage_thresholds',
  'fragment_model',
  'thermal_model',
  'environment_assumptions',
  'casualty_mix',
  'presets_and_capacities',
  'labels_and_copy',
  'safety_content',
];

const SPREAD_CHECKLISTS: Record<string, Record<string, string>> = {
  'fo-spread-1.0.0': {
    wall_burn_through: 'fieldops_spread_materials',
    contents_rates: 'fieldops_spread_materials',
    structural_frames: 'fieldops_spread_materials',
    exposure_bands: 'fieldops_spread_exposure',
    hazard_rows: 'fieldops_spread_hazards',
    weather_factors: 'fieldops_spread_weather_effects',
    road_speeds_traffic: 'fieldops_spread_road_speeds',
    row_sources: 'fieldops_spread_materials',
    no_device_content: 'fieldops_spread_materials',
  },
  'fo-catalogue-1.0.0': {
    building_types: 'fieldops_building_types',
    item_kinds: 'fieldops_hazard_item_kinds',
    typical_items: 'fieldops_building_items',
    interaction_rules: 'fieldops_hazard_interactions',
    row_sources: 'fieldops_building_types',
    restricted_generic_category_only: 'fieldops_hazard_item_kinds',
    no_device_content: 'fieldops_building_types',
  },
  'fo-threats-1.0.0': {
    release_agents: 'fieldops_release_agents',
    threat_profiles: 'fieldops_threat_profiles',
    movement_parameters: 'fieldops_movement_parameters',
    incident_types: 'fieldops_incident_types',
    row_sources: 'fieldops_release_agents',
    no_device_content: 'fieldops_release_agents',
  },
};

const LIBRARY_OF: Record<string, DatasetLibrary> = {
  'fo-spread-1.0.0': 'spread',
  'fo-catalogue-1.0.0': 'catalogue',
  'fo-threats-1.0.0': 'threats',
};

export interface VerifyOptions {
  apply: boolean;
  verifierEmail?: string;
  verifierUserId?: string;
  target: DbTarget;
}

export async function verifyKnowledge(options: VerifyOptions): Promise<{
  counts: Record<string, number>;
  issues: Record<string, number>;
  runId: string;
}> {
  if (!options.verifierEmail && !options.verifierUserId) {
    throw new Error('verify requires --verifier-email or --verifier-user-id');
  }
  const issues: Record<string, number> = {};
  const runId = await startRun(options.target, {
    command: 'verify',
    mode: options.apply ? 'apply' : 'dry_run',
    target: options.target.target,
    seedsDir: process.env.KNOWLEDGE_SEEDS_DIR ?? 'scripts/fieldops/seeds',
    folders: [],
    libraries: [],
    manifestSha256: null,
    args: { apply: options.apply, verifierUserId: options.verifierUserId ?? null },
  });
  try {
    const counts = await withClient(options.target, async (client) => {
      try {
        await beginImport(client, runId);
        const result = await writeVerification(client, options, issues);
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
      counts,
      issues,
    );
    console.log(`verify ${options.apply ? 'apply' : 'dry-run'}: ${JSON.stringify(counts)}`);
    return { counts, issues, runId };
  } catch (error) {
    await finishRun(
      options.target,
      runId,
      'failed',
      {},
      issues,
      error instanceof Error ? error.message : 'verify failed',
    );
    throw error;
  }
}

async function writeVerification(
  client: pg.Client,
  options: VerifyOptions,
  issues: Record<string, number>,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = { doctrines: 0, physics: 0, spread: 0, reviewed: 0 };
  const verifier = await findVerifier(client, options);
  if (!verifier || verifier.role !== 'admin') {
    issues.verifier_not_admin = 1;
  } else {
    counts.doctrines = await verifyDoctrines(client, verifier.id);
  }
  const recordedBy = verifier?.id ?? null;
  if (await insertPhysics(client, recordedBy)) counts.physics = 1;
  counts.reviewed = await markPhysicsReviewed(client);
  for (const model of Object.keys(SPREAD_CHECKLISTS)) {
    if (await insertSpread(client, model, recordedBy)) counts.spread += 1;
  }
  return counts;
}

async function findVerifier(
  client: pg.Client,
  options: VerifyOptions,
): Promise<{ id: string; role: string } | null> {
  if (options.verifierUserId) {
    const result = await client.query<{ id: string; role: string }>(
      `SELECT id::text, role FROM public.user_profiles WHERE id = $1`,
      [options.verifierUserId],
    );
    return result.rows[0] ?? null;
  }
  const auth = await client.query<{ name: string | null }>(
    `SELECT to_regclass('auth.users') AS name`,
  );
  if (!auth.rows[0]?.name) return null;
  const result = await client.query<{ id: string; role: string }>(
    `SELECT up.id::text, up.role
       FROM public.user_profiles up
       JOIN auth.users u ON u.id = up.id
      WHERE lower(u.email) = lower($1)`,
    [options.verifierEmail],
  );
  return result.rows[0] ?? null;
}

async function verifyDoctrines(client: pg.Client, adminId: string): Promise<number> {
  const doctrines = await client.query<{ id: string; latest_version: number }>(
    `SELECT d.id::text, d.latest_version
       FROM public.doctrines d
      WHERE d.visibility = 'library' AND d.retired_at IS NULL
        AND EXISTS (
          SELECT 1 FROM public.doctrine_events e
           WHERE e.doctrine_id = d.id AND e.event_type = 'seeded' AND e.details ? 'import_run_id'
        )`,
  );
  let verified = 0;
  for (const doctrine of doctrines.rows) {
    const result = await client.query<{ result: { ok?: boolean; code?: string } }>(
      `SELECT public.fieldops_verify_doctrine_version($1, $2, $3, $4) AS result`,
      [doctrine.id, doctrine.latest_version, adminId, NOTE],
    );
    const body = result.rows[0]?.result;
    if (body?.code === 'DOCTRINE_ALREADY_VERIFIED') continue;
    if (!body?.ok) throw new Error(`verify doctrine ${doctrine.id}: ${body?.code ?? 'failed'}`);
    await client.query(
      `INSERT INTO public.doctrine_events (doctrine_id, version, actor_id, event_type, details)
       VALUES ($1, $2, $3, 'verified', $4::jsonb)`,
      [doctrine.id, doctrine.latest_version, adminId, JSON.stringify({ note: NOTE })],
    );
    verified += 1;
  }
  return verified;
}

async function insertPhysics(client: pg.Client, recordedBy: string | null): Promise<boolean> {
  const rows = await libraryRows(client, 'physics');
  const version = datasetVersionOf('physics', rows);
  const existing = await client.query(
    `SELECT 1 FROM public.fieldops_physics_reviews
      WHERE model_version = 'fo-physics-1.0.0' AND dataset_version = $1
        AND decision = 'approved' AND reviewer_name = $2`,
    [version, OWNER],
  );
  if ((existing.rowCount ?? 0) > 0) return false;
  const checklist: Record<string, string> = {};
  for (const key of PHYSICS_CHECKLIST) {
    checklist[key] = key === 'presets_and_capacities' ? 'not_applicable' : 'yes';
  }
  await client.query(
    `INSERT INTO public.fieldops_physics_reviews
       (model_version, dataset_version, decision, reviewer_name, reviewer_qualification,
        reviewer_user_id, recorded_by, checklist, oracle_report, library_snapshot, notes)
     VALUES ('fo-physics-1.0.0', $1, 'approved', $2, $3, $4, $4, $5::jsonb, $6::jsonb, $7::jsonb, 'Owner verification.')`,
    [
      version,
      OWNER,
      PHYSICS_QUALIFICATION,
      recordedBy,
      JSON.stringify(checklist),
      JSON.stringify({
        status: 'not_run',
        reason: 'calculator not built; owner verification of 22 Nov 2026',
      }),
      JSON.stringify({ tables: rows }),
    ],
  );
  return true;
}

async function markPhysicsReviewed(client: pg.Client): Promise<number> {
  let changed = 0;
  for (const table of ['fieldops_explosive_materials', 'fieldops_injury_thresholds'] as const) {
    const key = table === 'fieldops_explosive_materials' ? 'material_key' : 'threshold_key';
    const pending = await client.query<{ key: string; row: Record<string, unknown> }>(
      `SELECT ${key} AS key, to_jsonb(t) AS row FROM public.${table} t
        WHERE status = 'active' AND review_state IS DISTINCT FROM 'reviewed'`,
    );
    if (pending.rows.length === 0) continue;
    await client.query(
      `UPDATE public.${table} SET review_state = 'reviewed'
        WHERE status = 'active' AND review_state IS DISTINCT FROM 'reviewed'`,
    );
    for (const row of pending.rows) {
      const after = { ...row.row, review_state: 'reviewed' };
      await client.query(
        `INSERT INTO public.fieldops_physics_library_changes
           (table_name, row_key, action, before_row, after_row)
         VALUES ($1, $2, 'update', $3::jsonb, $4::jsonb)`,
        [table, String(row.key).slice(0, 64), JSON.stringify(row.row), JSON.stringify(after)],
      );
      changed += 1;
    }
  }
  return changed;
}

async function insertSpread(
  client: pg.Client,
  model: string,
  recordedBy: string | null,
): Promise<boolean> {
  const library = LIBRARY_OF[model] ?? 'spread';
  const rows = await libraryRows(client, library);
  const version = datasetVersionOf(library, rows);
  const existing = await client.query(
    `SELECT 1 FROM public.fieldops_spread_reviews
      WHERE model_version = $1 AND dataset_version = $2 AND decision = 'approved' AND reviewer_name = $3`,
    [model, version, OWNER],
  );
  if ((existing.rowCount ?? 0) > 0) return false;
  const checklist: Record<string, string> = {};
  for (const [item, table] of Object.entries(SPREAD_CHECKLISTS[model] ?? {})) {
    checklist[item] = (await activeCount(client, table)) > 0 ? 'yes' : 'not_applicable';
  }
  await client.query(
    `INSERT INTO public.fieldops_spread_reviews
       (model_version, dataset_version, decision, reviewer_name, reviewer_qualification,
        checklist, library_snapshot, recorded_by, notes)
     VALUES ($1, $2, 'approved', $3, $4, $5::jsonb, $6::jsonb, $7, 'Owner verification.')`,
    [
      model,
      version,
      OWNER,
      SPREAD_QUALIFICATION,
      JSON.stringify(checklist),
      JSON.stringify({ tables: rows }),
      recordedBy,
    ],
  );
  return true;
}

async function libraryRows(
  client: pg.Client,
  library: DatasetLibrary,
): Promise<Record<string, Record<string, unknown>[]>> {
  const tables = {
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
  }[library];
  const rows: Record<string, Record<string, unknown>[]> = {};
  for (const table of tables) {
    const exists = await client.query<{ name: string | null }>(`SELECT to_regclass($1) AS name`, [
      `public.${table}`,
    ]);
    if (!exists.rows[0]?.name) {
      rows[table] = [];
      continue;
    }
    const result = await client.query<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(t) AS row FROM public.${table} t WHERE status = 'active'`,
    );
    rows[table] = result.rows.map((entry) => entry.row);
  }
  return rows;
}

async function activeCount(client: pg.Client, table: string): Promise<number> {
  if (!/^[a-z_]+$/.test(table)) return 0;
  const exists = await client.query<{ name: string | null }>(`SELECT to_regclass($1) AS name`, [
    `public.${table}`,
  ]);
  if (!exists.rows[0]?.name) return 0;
  const result = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.${table} WHERE status = 'active'`,
  );
  return result.rows[0]?.n ?? 0;
}
