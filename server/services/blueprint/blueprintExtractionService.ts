import { logger } from '../../lib/logger.js';
import { openAiJson } from './llmClient.js';
import {
  BLUEPRINT_EXTRACTION_TEMPERATURE,
  BLUEPRINT_MAX_PARALLEL_CHUNKS,
} from './blueprintConfig.js';
import { coerceBlueprint, emptyBlueprint, type ScenarioBlueprint } from './blueprintTypes.js';
import { chunkText, mergeBlueprints, scoreCoverage, scoreStructure } from './blueprintMerge.js';

/**
 * Two-pass, format-agnostic extraction of a Scenario Blueprint from raw document
 * text:
 *   Pass A (discovery)  -- classify the framework + the trainer's own concepts.
 *   Pass B (map-reduce) -- chunk the doc, extract each chunk against the standard
 *                          fields + discovered concepts, then merge.
 * Anything unplaceable is kept in `unmapped_directives`; the raw text is retained
 * for the raw-excerpt floor. Pure helpers live in blueprintMerge.ts.
 */

// Re-export pure helpers for convenience.
export { chunkText, mergeBlueprints, scoreCoverage, scoreStructure } from './blueprintMerge.js';

// ─── Orchestration (network) ────────────────────────────────────────────────

const DISCOVERY_SYSTEM = `You analyze crisis-simulation design documents. Read the document and identify, WITHOUT inventing anything:
1. detected_framework_kind: a short phrase describing how the trainer organized this document (e.g. "faction-roster + staged-timeline", "inject-timeline", "decision-tree", "rubric-first").
2. trainer_concepts: the trainer's OWN organizing concepts and their items (use the trainer's wording, not ours).
3. warnings: any internal inconsistencies (e.g. a timeline whose stage labels do not match the stated premise). Include a suggested_fix array when you can.
Return ONLY JSON: { "detected_framework_kind": "...", "trainer_concepts": [{ "name": "...", "items": ["..."] }], "warnings": [{ "field": "...", "issue": "...", "suggested_fix": ["..."] }] }`;

const extractionSystem = (frameworkKind: string): string =>
  `You extract a STRUCTURED blueprint from one chunk of a crisis-simulation design document. Transcribe faithfully; do NOT invent content that is not present. If something does not fit a field, put it in unmapped_directives with the source excerpt.

Detected framework: ${frameworkKind || 'unknown'}.

Return ONLY JSON with any of these keys you can populate from THIS chunk:
{
  "premise": { "summary": "...", "crisis_type": "...", "setting": "...", "confidence": 0.0 },
  "factions": [{ "id": "snake_case", "name": "...", "alignment": "hostile|amplifier|defender|media|authority|wildcard|opportunist|insider|analyst|...", "emotional_drivers": ["..."], "behaviour_patterns": ["..."], "typical_narratives": ["..."], "escalation_triggers": ["..."], "deescalation_triggers": ["..."], "tone_guidance": "...", "headcount_hint": 2, "confidence": 0.0 }],
  "timeline": [{ "stage": "...", "description": "...", "order": 1 }],
  "escalation_model": { "tiers": [{ "name": "Low|Medium|High|Critical|...", "indicators": ["..."] }] },
  "narrative_mutations": ["..."],
  "objectives": ["..."],
  "participant_decisions": ["..."],
  "ground_rules": ["..."],
  "safety_constraints": ["..."],
  "advanced_injects": ["..."],
  "incident_types": ["specific incident/sub-types this crisis could involve"],
  "cross_cutting_constraints": [{ "area": "legal|morale|investor|public_order|reputational|...", "consideration": "..." }],
  "cross_stakeholder_dynamics": ["how groups interact/escalate against each other"],
  "global_tone_guidance": "document-wide tone/realism guidance that applies across ALL factions",
  "example_vignettes": ["worked example scenes illustrating the dynamics"],
  "crisis_cluster": "victim|accidental|preventable",
  "unmapped_directives": [{ "source_excerpt": "...", "note": "why it did not fit a field" }]
}
Omit keys you cannot fill from this chunk. Never fetch external URLs; if the document references one, record it under unmapped_directives.`;

/** Run async tasks with bounded concurrency. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function extractBlueprint(rawText: string): Promise<ScenarioBlueprint> {
  const text = (rawText || '').trim();
  if (!text) return emptyBlueprint();

  // Pass A: discovery (one whole-document call; tolerant of failure).
  const discoveryRaw = await openAiJson({
    system: DISCOVERY_SYSTEM,
    user: text,
    temperature: BLUEPRINT_EXTRACTION_TEMPERATURE,
  });
  const discovery = coerceBlueprint(discoveryRaw);

  // Pass B: per-chunk extraction with bounded parallelism.
  const chunks = chunkText(text);
  const partials = await mapWithConcurrency(
    chunks,
    BLUEPRINT_MAX_PARALLEL_CHUNKS,
    async (chunk) => {
      const raw = await openAiJson({
        system: extractionSystem(discovery.detected_framework_kind),
        user: chunk,
        temperature: BLUEPRINT_EXTRACTION_TEMPERATURE,
      });
      return coerceBlueprint(raw);
    },
  );

  const merged = mergeBlueprints(partials.length > 0 ? partials : [emptyBlueprint()]);

  // Fold in discovery-only fields + never-lose raw excerpts.
  merged.detected_framework_kind =
    merged.detected_framework_kind || discovery.detected_framework_kind;
  merged.trainer_concepts =
    merged.trainer_concepts.length > 0 ? merged.trainer_concepts : discovery.trainer_concepts;
  for (const w of discovery.warnings) merged.warnings.push(w);
  merged.raw_excerpts = { full: text.slice(0, 12000) };

  merged.coverage = scoreCoverage(merged);
  merged.structure_confidence = scoreStructure(merged);

  logger.info(
    {
      factions: merged.factions.length,
      timeline: merged.timeline.length,
      unmapped: merged.unmapped_directives.length,
      structure_confidence: merged.structure_confidence,
    },
    'Blueprint extraction complete',
  );

  return merged;
}
