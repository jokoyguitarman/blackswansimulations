export const LIBRARIES = [
  'doctrines',
  'devices',
  'spread',
  'threats',
  'building_hazards',
  'movement',
  'units',
  'hospitals',
  'blast_effects',
  'fire_smoke_tenability',
] as const;
export type Library = (typeof LIBRARIES)[number];

export const RECORD_KINDS = [
  'table_row',
  'reference',
  'curve_table',
  'oracle',
  'worked_example',
  'source',
  'run',
  'register_agency',
  'register_unit',
  'doctrine_seed',
  'doctrine_review',
  'uncovered',
  'refused',
  'gap',
  'not_representable',
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export const FORMATS = [
  'table_rows_v0',
  'reference_rows_v0',
  'blast_curves_v0',
  'worked_examples_v0',
  'responder_rows_v0',
  'sources_v0',
  'run_manifest_v0',
  'agency_register_v1',
  'doctrine_seed_v1',
  'doctrine_review_v0',
  'planning_rows_v0',
] as const;
export type SeedFormat = (typeof FORMATS)[number];

export const TARGET_TABLES = [
  'fieldops_spread_materials',
  'fieldops_release_agents',
  'fieldops_threat_profiles',
  'fieldops_movement_parameters',
  'fieldops_incident_types',
  'fieldops_building_types',
  'fieldops_hazard_item_kinds',
  'fieldops_building_items',
  'fieldops_hazard_interactions',
  'fieldops_unit_kinds',
  'fieldops_equipment',
  'fieldops_unit_equipment',
  'fieldops_response_standards',
  'fieldops_hospitals',
  'fieldops_capacity_aggregates',
  'fieldops_explosive_materials',
  'fieldops_injury_thresholds',
  'fieldops_knowledge_sources',
  'fieldops_knowledge_reference_values',
  'doctrines',
  'team_archetype_aliases',
] as const;
export type TargetTable = (typeof TARGET_TABLES)[number];

export type ReviewState = 'pending' | 'approved' | 'amended' | 'rejected';

export interface Issue {
  code: string;
  severity: 'blocker' | 'warning';
  detail?: string;
}

export interface NormalisedReview {
  state: ReviewState;
  reviewerName: string | null;
  reviewerQualification: string | null;
  decidedOn: string | null;
  notes: string | null;
  reviewerRole: string | null;
  history: unknown[];
  requiredRoles: string[];
  /** The review object stored on the record, normalised from whichever convention applied. */
  stored: Record<string, unknown>;
}

export interface ClassifiedRecord {
  filePath: string;
  recordKind: RecordKind;
  recordKey: string;
  ordinal: number;
  library: Library;
  country: string | null;
  targetTable: TargetTable | null;
  targetKey: string | null;
  payload: unknown;
  payloadSha256: string;
  provenance: Record<string, unknown> | null;
  reviewEvidence: Record<string, unknown> | null;
  draftedBy: 'agent' | 'person' | null;
  confidence: 'high' | 'medium' | 'low' | null;
  assumedFields: string[];
  toVerify: string[];
  unverifiedFields: string[];
  withheldFields: string[];
  sourceKeys: string[];
  review: NormalisedReview;
  issues: Issue[];
}

export interface RegistryEntry {
  /** Path relative to the seeds directory. Also fieldops_seed_files.file_path. */
  path: string;
  format: SeedFormat;
  library: Library;
  /** Typed table for the file's primary rows. Null when the file has no typed target. */
  targetTable: TargetTable | null;
}

export interface LoadedFile {
  entry: RegistryEntry;
  absolutePath: string;
  bytes: Buffer;
  sha256: string;
  document: Record<string, unknown>;
  records: ClassifiedRecord[];
}
