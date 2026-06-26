import { z } from 'zod';

/**
 * The Scenario Blueprint is the structured intermediate representation extracted
 * from a trainer's design document. It is deliberately FORMAT-AGNOSTIC:
 *  - every section is optional / best-effort,
 *  - `alignment` and stage names are open strings (not hard enums) so a trainer's
 *    own taxonomy is never force-fit,
 *  - anything that cannot be placed lands in `unmapped_directives` (never dropped),
 *  - `coverage`/`structure_confidence` drive the honor-vs-generate fallback.
 *
 * The zod schema is lenient (defaults everywhere) so a partial or slightly
 * malformed LLM response still parses into a usable object.
 */

const factionSchema = z.object({
  id: z.string().default(''),
  name: z.string().default(''),
  // OPEN vocabulary. Suggested values: hostile | amplifier | defender | media |
  // authority | wildcard | opportunist | insider | analyst -- but not enforced.
  alignment: z.string().default(''),
  emotional_drivers: z.array(z.string()).default([]),
  behaviour_patterns: z.array(z.string()).default([]),
  typical_narratives: z.array(z.string()).default([]),
  escalation_triggers: z.array(z.string()).default([]),
  deescalation_triggers: z.array(z.string()).default([]),
  tone_guidance: z.string().default(''),
  headcount_hint: z.number().optional(),
  confidence: z.number().default(0),
});

const timelineStageSchema = z.object({
  stage: z.string().default(''),
  description: z.string().default(''),
  order: z.number().default(0),
});

const escalationTierSchema = z.object({
  name: z.string().default(''),
  indicators: z.array(z.string()).default([]),
});

const trainerConceptSchema = z.object({
  name: z.string().default(''),
  items: z.array(z.string()).default([]),
});

const unmappedDirectiveSchema = z.object({
  source_excerpt: z.string().default(''),
  note: z.string().default(''),
});

const warningSchema = z.object({
  field: z.string().default(''),
  issue: z.string().default(''),
  suggested_fix: z.array(z.string()).optional(),
});

export const scenarioBlueprintSchema = z.object({
  premise: z
    .object({
      summary: z.string().default(''),
      crisis_type: z.string().default(''),
      setting: z.string().default(''),
      confidence: z.number().default(0),
    })
    .default({ summary: '', crisis_type: '', setting: '', confidence: 0 }),
  factions: z.array(factionSchema).default([]),
  timeline: z.array(timelineStageSchema).default([]),
  escalation_model: z
    .object({ tiers: z.array(escalationTierSchema).default([]) })
    .default({ tiers: [] }),
  narrative_mutations: z.array(z.string()).default([]),
  objectives: z.array(z.string()).default([]),
  participant_decisions: z.array(z.string()).default([]),
  ground_rules: z.array(z.string()).default([]),
  safety_constraints: z.array(z.string()).default([]),
  advanced_injects: z.array(z.string()).default([]),
  // Discovery + never-lose
  detected_framework_kind: z.string().default(''),
  trainer_concepts: z.array(trainerConceptSchema).default([]),
  unmapped_directives: z.array(unmappedDirectiveSchema).default([]),
  raw_excerpts: z.record(z.string(), z.string()).default({}),
  warnings: z.array(warningSchema).default([]),
  // Scoring
  crisis_cluster: z.string().default(''),
  structure_confidence: z.number().default(0),
  coverage: z.record(z.string(), z.number()).default({}),
});

export type ScenarioBlueprint = z.infer<typeof scenarioBlueprintSchema>;
export type BlueprintFaction = z.infer<typeof factionSchema>;

/** A fully-empty, valid blueprint. Used for the no-document path (fallback). */
export function emptyBlueprint(): ScenarioBlueprint {
  return scenarioBlueprintSchema.parse({});
}

/**
 * Parse an arbitrary (LLM-produced) object into a valid blueprint, filling
 * defaults for anything missing. Returns the empty blueprint if the input is
 * unusable, so callers never crash on a bad model response.
 */
export function coerceBlueprint(input: unknown): ScenarioBlueprint {
  const result = scenarioBlueprintSchema.safeParse(input ?? {});
  return result.success ? result.data : emptyBlueprint();
}

/** True when the document meaningfully populated a structured blueprint. */
export function hasUsableStructure(bp: ScenarioBlueprint, minConfidence: number): boolean {
  return bp.structure_confidence >= minConfidence;
}
