import type { RegistryEntry } from './types.js';

const DOCTRINE_STEMS = [
  'sg_caas.transport_operator',
  'sg_cag_aes.fire_rescue',
  'sg_lta.transport_operator',
  'sg_mha.ministry_liaison',
  'sg_moh.hospital_ed',
  'sg_nea.utilities',
  'sg_pub.utilities',
  'sg_saf.bomb_disposal_eod',
  'sg_saf.cbrn_defence',
  'sg_saf.military_support',
  'sg_scdf.fire_rescue',
  'sg_scdf.incident_command',
  'sg_scdf.medical_triage',
  'sg_spf.evacuation_crowd',
  'sg_spf.police_security',
  'sg_spf_cid.pursuit_investigation',
  'sg_spf_soc.tactical_response',
] as const;

/** Doctrines whose content.use_of_force is withheld until a legal, police or military reviewer (A7). */
export const USE_OF_FORCE_STEMS = [
  'sg_spf.police_security',
  'sg_spf_soc.tactical_response',
  'sg_saf.military_support',
] as const;

/**
 * Section 7, with the planning file first (section 10.5).
 * Paths are relative to the seeds directory.
 */
export const REGISTRY: readonly RegistryEntry[] = [
  {
    path: 'planning/spread-materials.planning.json',
    format: 'planning_rows_v0',
    library: 'spread',
    targetTable: 'fieldops_spread_materials',
  },
  {
    path: '_incoming/responder-units/unit-kinds.json',
    format: 'table_rows_v0',
    library: 'units',
    targetTable: 'fieldops_unit_kinds',
  },
  {
    path: '_incoming/responder-units/unit-kinds-vessels.json',
    format: 'table_rows_v0',
    library: 'units',
    targetTable: 'fieldops_unit_kinds',
  },
  {
    path: '_incoming/responder-units/equipment.json',
    format: 'table_rows_v0',
    library: 'units',
    targetTable: 'fieldops_equipment',
  },
  {
    path: '_incoming/responder-units/unit-equipment.json',
    format: 'table_rows_v0',
    library: 'units',
    targetTable: 'fieldops_unit_equipment',
  },
  {
    path: '_incoming/responder-units/equipment-not-representable.json',
    format: 'responder_rows_v0',
    library: 'units',
    targetTable: null,
  },
  {
    path: '_incoming/responder-units/security-units.sg.json',
    format: 'responder_rows_v0',
    library: 'doctrines',
    targetTable: null,
  },
  {
    path: '_incoming/responder-units/response-standards.sg.json',
    format: 'responder_rows_v0',
    library: 'units',
    targetTable: 'fieldops_response_standards',
  },
  {
    path: '_incoming/responder-units/hospital-capacity.sg.json',
    format: 'responder_rows_v0',
    library: 'hospitals',
    targetTable: 'fieldops_hospitals',
  },
  {
    path: '_incoming/responder-units/sources.sg.json',
    format: 'sources_v0',
    library: 'units',
    targetTable: 'fieldops_knowledge_sources',
  },
  {
    path: '_incoming/physics-movement/spread-materials.pending.json',
    format: 'table_rows_v0',
    library: 'spread',
    targetTable: 'fieldops_spread_materials',
  },
  {
    path: '_incoming/physics-movement/release-agents.pending.json',
    format: 'table_rows_v0',
    library: 'threats',
    targetTable: 'fieldops_release_agents',
  },
  {
    path: '_incoming/physics-movement/threat-profiles.pending.json',
    format: 'table_rows_v0',
    library: 'threats',
    targetTable: 'fieldops_threat_profiles',
  },
  {
    path: '_incoming/physics-movement/movement-parameters.pending.json',
    format: 'table_rows_v0',
    library: 'movement',
    targetTable: 'fieldops_movement_parameters',
  },
  {
    path: '_incoming/physics-movement/incident-types.pending.json',
    format: 'table_rows_v0',
    library: 'threats',
    targetTable: 'fieldops_incident_types',
  },
  {
    path: '_incoming/physics-movement/exposure-reference.pending.json',
    format: 'reference_rows_v0',
    library: 'spread',
    targetTable: 'fieldops_knowledge_reference_values',
  },
  {
    path: '_incoming/physics-movement/sources.pending.json',
    format: 'sources_v0',
    library: 'threats',
    targetTable: 'fieldops_knowledge_sources',
  },
  {
    path: '_incoming/physics-movement/run.json',
    format: 'run_manifest_v0',
    library: 'threats',
    targetTable: null,
  },
  {
    path: '_incoming/building-hazards/building-types.json',
    format: 'table_rows_v0',
    library: 'building_hazards',
    targetTable: 'fieldops_building_types',
  },
  {
    path: '_incoming/building-hazards/hazard-item-kinds.json',
    format: 'table_rows_v0',
    library: 'building_hazards',
    targetTable: 'fieldops_hazard_item_kinds',
  },
  {
    path: '_incoming/building-hazards/building-items.json',
    format: 'table_rows_v0',
    library: 'building_hazards',
    targetTable: 'fieldops_building_items',
  },
  {
    path: '_incoming/building-hazards/hazard-interactions.json',
    format: 'table_rows_v0',
    library: 'building_hazards',
    targetTable: 'fieldops_hazard_interactions',
  },
  {
    path: '_incoming/building-hazards/release-agents.json',
    format: 'table_rows_v0',
    library: 'threats',
    targetTable: 'fieldops_release_agents',
  },
  {
    path: '_incoming/building-hazards/sources.json',
    format: 'sources_v0',
    library: 'building_hazards',
    targetTable: 'fieldops_knowledge_sources',
  },
  {
    path: '_incoming/building-hazards/run.json',
    format: 'run_manifest_v0',
    library: 'building_hazards',
    targetTable: null,
  },
  {
    path: '_incoming/doctrines/sg/agencies.json',
    format: 'agency_register_v1',
    library: 'doctrines',
    targetTable: 'team_archetype_aliases',
  },
  ...DOCTRINE_STEMS.map((stem): RegistryEntry => ({
    path: `_incoming/doctrines/sg/${stem}.json`,
    format: 'doctrine_seed_v1',
    library: 'doctrines',
    targetTable: 'doctrines',
  })),
  {
    path: '_incoming/doctrines/playbook-review.pending.json',
    format: 'doctrine_review_v0',
    library: 'doctrines',
    targetTable: null,
  },
  {
    path: '_incoming/doctrines/run.json',
    format: 'run_manifest_v0',
    library: 'doctrines',
    targetTable: null,
  },
  {
    path: '_incoming/blast-effects/explosive-materials.pending.json',
    format: 'table_rows_v0',
    library: 'blast_effects',
    targetTable: 'fieldops_explosive_materials',
  },
  {
    path: '_incoming/blast-effects/injury-thresholds.pending.json',
    format: 'table_rows_v0',
    library: 'blast_effects',
    targetTable: 'fieldops_injury_thresholds',
  },
  {
    path: '_incoming/blast-effects/blast-curves.pending.json',
    format: 'blast_curves_v0',
    library: 'blast_effects',
    targetTable: 'fieldops_knowledge_reference_values',
  },
  {
    path: '_incoming/blast-effects/human-vulnerability.pending.json',
    format: 'reference_rows_v0',
    library: 'blast_effects',
    targetTable: 'fieldops_knowledge_reference_values',
  },
  {
    path: '_incoming/blast-effects/structural-damage.pending.json',
    format: 'reference_rows_v0',
    library: 'blast_effects',
    targetTable: 'fieldops_knowledge_reference_values',
  },
  {
    path: '_incoming/blast-effects/vapour-cloud-and-fireball.pending.json',
    format: 'reference_rows_v0',
    library: 'blast_effects',
    targetTable: 'fieldops_knowledge_reference_values',
  },
  {
    path: '_incoming/blast-effects/fragments-and-safety-distances.pending.json',
    format: 'reference_rows_v0',
    library: 'blast_effects',
    targetTable: 'fieldops_knowledge_reference_values',
  },
  {
    path: '_incoming/blast-effects/indoor-effects.pending.json',
    format: 'reference_rows_v0',
    library: 'blast_effects',
    targetTable: 'fieldops_knowledge_reference_values',
  },
  {
    path: '_incoming/blast-effects/worked-examples.pending.json',
    format: 'worked_examples_v0',
    library: 'blast_effects',
    targetTable: null,
  },
  {
    path: '_incoming/blast-effects/sources.json',
    format: 'sources_v0',
    library: 'blast_effects',
    targetTable: 'fieldops_knowledge_sources',
  },
  {
    path: '_incoming/blast-effects/run.json',
    format: 'run_manifest_v0',
    library: 'blast_effects',
    targetTable: null,
  },
  {
    path: '_incoming/fire-smoke-tenability/smoke-movement.pending.json',
    format: 'reference_rows_v0',
    library: 'fire_smoke_tenability',
    targetTable: 'fieldops_knowledge_reference_values',
  },
  {
    path: '_incoming/fire-smoke-tenability/fire-growth-spread.pending.json',
    format: 'reference_rows_v0',
    library: 'fire_smoke_tenability',
    targetTable: 'fieldops_knowledge_reference_values',
  },
  {
    path: '_incoming/fire-smoke-tenability/tenability-response.pending.json',
    format: 'reference_rows_v0',
    library: 'fire_smoke_tenability',
    targetTable: 'fieldops_knowledge_reference_values',
  },
  {
    path: '_incoming/fire-smoke-tenability/outdoor-evacuation.pending.json',
    format: 'reference_rows_v0',
    library: 'fire_smoke_tenability',
    targetTable: 'fieldops_knowledge_reference_values',
  },
  {
    path: '_incoming/fire-smoke-tenability/worked-examples.pending.json',
    format: 'worked_examples_v0',
    library: 'fire_smoke_tenability',
    targetTable: null,
  },
  {
    path: '_incoming/fire-smoke-tenability/sources.json',
    format: 'sources_v0',
    library: 'fire_smoke_tenability',
    targetTable: 'fieldops_knowledge_sources',
  },
  {
    path: '_incoming/fire-smoke-tenability/run.json',
    format: 'run_manifest_v0',
    library: 'fire_smoke_tenability',
    targetTable: null,
  },
];

const BY_PATH = new Map(REGISTRY.map((entry) => [entry.path, entry]));

export function registryEntry(relativePath: string): RegistryEntry | undefined {
  return BY_PATH.get(relativePath);
}

export function folderOf(relativePath: string): string {
  const parts = relativePath.split('/');
  if (parts[0] === '_incoming' && parts[1]) return parts[1];
  if (parts[0] === 'planning') return 'planning';
  return parts[0] ?? relativePath;
}

/** Source-merge folder order, section 8.13. */
export const SOURCE_FOLDER_ORDER = [
  'doctrines',
  'responder-units',
  'building-hazards',
  'physics-movement',
  'blast-effects',
  'fire-smoke-tenability',
] as const;

export const MISSING_MOVEMENT_KEYS = [
  'breathing_height_crawling',
  'breathing_height_standing',
  'crouch_extinction_per_m',
  'crouch_speed_factor',
  'crush_density',
  'door_leak_gap_mm',
  'orifice_coefficient',
  'reroute_extinction_per_m',
  'smoke_speed_floor_factor',
  'smoke_up_factor',
  'stair_fire_heat_s',
  'stair_travel_factor',
  'tenable_temp_head_c',
  'turn_back_permille',
  'water_slow_depth_m',
  'water_stop_depth_m',
] as const;

export const DANGLING_THREAT_KEYS = [
  'pool_fire',
  'jet_fire',
  'flash_fire',
  'vce_low_congestion',
  'bleve_fireball',
  'vessel_burst',
  'toxic_release_indoor',
] as const;
