import { z, type ZodType } from 'zod';
import type { SeedFormat } from '../types.js';

/**
 * As-found shapes (spec section 10.3, Appendix B). Unknown keys are kept.
 * Value rules live in the checks, not here.
 */

const str = z.string().nullable().optional();
const num = z.number().nullable().optional();

export const sourceRefSchema = z.looseObject({
  source_key: z.string().min(1).optional(),
  title: str,
  publisher: str,
  url: str,
  locator: str,
  quoted_phrase: str,
  published: str,
  accessed_at: str,
  language: str,
  terms_note: str,
});

export const provenanceSchema = z.looseObject({
  drafted_by: z.enum(['agent', 'person']).optional(),
  run_id: z.string().uuid().nullable().optional(),
  sources: z.array(sourceRefSchema).optional(),
  confidence: z.enum(['high', 'medium', 'low']).nullable().optional(),
  assumed_fields: z.array(z.string()).optional(),
  to_verify: z.array(z.string()).optional(),
  unverified_fields: z.array(z.string()).optional(),
  withheld_fields: z.array(z.string()).optional(),
});

export const rowReviewSchema = z.looseObject({
  state: str,
  decision: z.enum(['approved', 'amended', 'rejected']).nullable().optional(),
  reviewer_name: str,
  reviewer_qualification: str,
  decided_on: str,
  notes: str,
});

export const referenceRowSchema = z.looseObject({
  ref_key: z.string(),
  topic: z.string(),
  value: z
    .union([
      z.number(),
      z.string(),
      z.boolean(),
      z.array(z.unknown()),
      z.record(z.string(), z.unknown()),
      z.null(),
    ])
    .optional(),
  unit: z.string(),
  note: str,
  formula: str,
  spec_ref: str,
  extends: str,
  worked_example: z.record(z.string(), z.unknown()).nullable().optional(),
  provenance: provenanceSchema.optional(),
  review: rowReviewSchema.optional(),
});

export const sourcesFileRowSchema = z.looseObject({
  source_key: z.string(),
  title: z.string(),
  publisher: z.string(),
  url: str,
  published_on: str,
  published: str,
  accessed_on: str,
  accessed: str,
  language: z.string(),
  terms_note: z.string(),
  content_hash: str,
  review_interval_days: num,
  next_review_due: str,
  libraries: z.array(z.string()).optional(),
  status: str,
  access_status: str,
  read_status: str,
  kind: str,
});

const headerFields = {
  file: str,
  schema_version: num,
  library: str,
  format: str,
  country: str,
  prepared_by: str,
  prepared_on: str,
  review_status: str,
  seed_status: str,
  provenance: provenanceSchema.optional(),
  review: z.looseObject({}).optional(),
  review_flags: z.record(z.string(), z.array(z.string())).optional(),
};

export const tableRowsFileSchema = z.looseObject({
  ...headerFields,
  rows: z.array(z.looseObject({})),
  reference_rows: z.array(referenceRowSchema).optional(),
  uncovered: z.array(z.looseObject({})).optional(),
  refused: z.array(z.looseObject({})).optional(),
});

export const referenceRowsFileSchema = z.looseObject({
  ...headerFields,
  rows: z.array(referenceRowSchema),
  uncovered: z.array(z.looseObject({})).optional(),
  refused: z.array(z.looseObject({})).optional(),
});

export const blastCurvesFileSchema = z.looseObject({
  ...headerFields,
  rows: z.array(referenceRowSchema),
  curves_spec_shape: z.record(z.string(), z.looseObject({})),
  lookup_tables: z.record(z.string(), z.looseObject({})),
  oracles: z.array(z.looseObject({})),
  uncovered: z.array(z.looseObject({})).optional(),
  refused: z.array(z.looseObject({})).optional(),
});

export const workedExamplesFileSchema = z.looseObject({
  ...headerFields,
  cases_10kg_tnt: z.array(z.looseObject({})).optional(),
  other_oracles: z.array(z.looseObject({})).optional(),
  examples: z.record(z.string(), z.looseObject({})).optional(),
  threshold_radii_10kg_tnt: z.looseObject({}).optional(),
  ac6_9_cube_root_check: z.looseObject({}).optional(),
  o3_standoff_card_sanity: z.looseObject({}).optional(),
});

export const responderRowsFileSchema = z.looseObject({
  ...headerFields,
  rows: z.array(z.looseObject({})),
});

export const sourcesFileSchema = z.looseObject({
  ...headerFields,
  rows: z.array(sourcesFileRowSchema),
});

export const runManifestFileSchema = z.looseObject({
  run_id: z.string().uuid().nullable().optional(),
  run_kind: str,
  library: str,
  libraries: z.array(z.string()).optional(),
  review_status: str,
  uncovered: z.union([z.array(z.looseObject({})), z.number()]).optional(),
  refused: z.union([z.array(z.looseObject({})), z.number()]).optional(),
});

export const agencyRegisterFileSchema = z.looseObject({
  format: str,
  country: z.string(),
  agencies: z.array(z.looseObject({})),
  provenance: provenanceSchema.optional(),
  review: z.looseObject({}).optional(),
});

export const doctrineSeedFileSchema = z.looseObject({
  format: str,
  archetype_key: z.string(),
  title: z.string(),
  applies_to: z.array(z.string()),
  source: z.string(),
  country: z.string(),
  agency_name: z.string(),
  provenance: provenanceSchema.optional(),
  content: z.looseObject({}),
  review: z.looseObject({}).optional(),
});

export const doctrineReviewFileSchema = z.looseObject({
  ...headerFields,
  reviews: z.array(z.looseObject({})),
});

export const planningRowsFileSchema = tableRowsFileSchema;

export const SCHEMA_BY_FORMAT: Record<SeedFormat, ZodType> = {
  table_rows_v0: tableRowsFileSchema,
  reference_rows_v0: referenceRowsFileSchema,
  blast_curves_v0: blastCurvesFileSchema,
  worked_examples_v0: workedExamplesFileSchema,
  responder_rows_v0: responderRowsFileSchema,
  sources_v0: sourcesFileSchema,
  run_manifest_v0: runManifestFileSchema,
  agency_register_v1: agencyRegisterFileSchema,
  doctrine_seed_v1: doctrineSeedFileSchema,
  doctrine_review_v0: doctrineReviewFileSchema,
  planning_rows_v0: planningRowsFileSchema,
};
