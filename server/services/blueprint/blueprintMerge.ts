import { BLUEPRINT_CHUNK_CHARS, BLUEPRINT_CHUNK_OVERLAP_CHARS } from './blueprintConfig.js';
import { emptyBlueprint, type ScenarioBlueprint, type BlueprintFaction } from './blueprintTypes.js';

/**
 * Pure (no network, no env) blueprint helpers: chunking, merge of per-chunk
 * partials, and coverage/structure scoring. Isolated here so they can be unit
 * tested directly and so the orchestration service stays thin.
 */

/**
 * Fixed-window splitter (last resort): used only for a single block that is
 * itself larger than `size` and has no internal boundary to break on.
 */
function hardSplit(text: string, size: number, overlap: number): string[] {
  const step = Math.max(1, size - overlap);
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += step) {
    chunks.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
  }
  return chunks;
}

/**
 * Split a document into blocks at section/paragraph boundaries (blank lines),
 * so headers stay attached to their content rather than being cut mid-sentence.
 */
function splitIntoBlocks(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
}

/**
 * Split text into chunks for extraction.
 *  - Empty -> [].
 *  - Fits in one chunk (<= size) -> [text]  (typical trainer docs; no truncation).
 *  - Larger -> SECTION-AWARE: pack whole paragraphs/sections greedily up to size,
 *    breaking only at blank-line boundaries (never mid-sentence). A single block
 *    bigger than `size` falls back to a fixed-window hard split.
 */
export function chunkText(
  text: string,
  size = BLUEPRINT_CHUNK_CHARS,
  overlap = BLUEPRINT_CHUNK_OVERLAP_CHARS,
): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= size) return [trimmed];

  const blocks = splitIntoBlocks(trimmed);
  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const block of blocks) {
    if (block.length > size) {
      // Oversized single section: flush, then hard-split this block.
      flush();
      for (const piece of hardSplit(block, size, overlap)) chunks.push(piece);
      continue;
    }
    if (current && current.length + block.length + 2 > size) {
      // Carry a small tail of the previous chunk for cross-boundary context.
      const tail = overlap > 0 ? current.slice(-overlap) : '';
      flush();
      current = tail ? `${tail}\n\n${block}` : block;
    } else {
      current = current ? `${current}\n\n${block}` : block;
    }
  }
  flush();
  return chunks;
}

const norm = (s: string): string => s.trim().toLowerCase();

/** Union of string arrays, de-duplicated case-insensitively, original casing kept. */
export function unionStrings(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of list) {
      const value = raw.trim();
      if (!value) continue;
      const key = norm(value);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
  }
  return out;
}

function mergeFactions(parts: ScenarioBlueprint[]): BlueprintFaction[] {
  const byKey = new Map<string, BlueprintFaction>();
  for (const part of parts) {
    for (const faction of part.factions) {
      const key = norm(faction.id || faction.name);
      if (!key) continue;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { ...faction });
        continue;
      }
      existing.emotional_drivers = unionStrings(
        existing.emotional_drivers,
        faction.emotional_drivers,
      );
      existing.behaviour_patterns = unionStrings(
        existing.behaviour_patterns,
        faction.behaviour_patterns,
      );
      existing.typical_narratives = unionStrings(
        existing.typical_narratives,
        faction.typical_narratives,
      );
      existing.escalation_triggers = unionStrings(
        existing.escalation_triggers,
        faction.escalation_triggers,
      );
      existing.deescalation_triggers = unionStrings(
        existing.deescalation_triggers,
        faction.deescalation_triggers,
      );
      existing.alignment = existing.alignment || faction.alignment;
      existing.tone_guidance = existing.tone_guidance || faction.tone_guidance;
      existing.name = existing.name || faction.name;
      existing.headcount_hint = existing.headcount_hint ?? faction.headcount_hint;
      existing.confidence = Math.max(existing.confidence, faction.confidence);
    }
  }
  return Array.from(byKey.values());
}

/** Merge per-chunk partial blueprints into one, de-duplicating across chunks. */
export function mergeBlueprints(parts: ScenarioBlueprint[]): ScenarioBlueprint {
  const merged = emptyBlueprint();
  if (parts.length === 0) return merged;

  merged.factions = mergeFactions(parts);

  // Timeline: dedupe by stage name, keep first description, then sort by order.
  const stageByKey = new Map<string, { stage: string; description: string; order: number }>();
  for (const part of parts) {
    for (const t of part.timeline) {
      const key = norm(t.stage);
      if (!key) continue;
      const existing = stageByKey.get(key);
      if (!existing) stageByKey.set(key, { ...t });
      else existing.description = existing.description || t.description;
    }
  }
  merged.timeline = Array.from(stageByKey.values()).sort((a, b) => a.order - b.order);

  // Escalation tiers: dedupe by name, union indicators.
  const tierByKey = new Map<string, { name: string; indicators: string[] }>();
  for (const part of parts) {
    for (const tier of part.escalation_model.tiers) {
      const key = norm(tier.name);
      if (!key) continue;
      const existing = tierByKey.get(key);
      if (!existing) tierByKey.set(key, { ...tier });
      else existing.indicators = unionStrings(existing.indicators, tier.indicators);
    }
  }
  merged.escalation_model = { tiers: Array.from(tierByKey.values()) };

  merged.narrative_mutations = unionStrings(...parts.map((p) => p.narrative_mutations));
  merged.objectives = unionStrings(...parts.map((p) => p.objectives));
  merged.participant_decisions = unionStrings(...parts.map((p) => p.participant_decisions));
  merged.ground_rules = unionStrings(...parts.map((p) => p.ground_rules));
  merged.safety_constraints = unionStrings(...parts.map((p) => p.safety_constraints));
  merged.advanced_injects = unionStrings(...parts.map((p) => p.advanced_injects));

  // Option A fields: array fields union; constraints dedupe by area; tone is first non-empty.
  merged.incident_types = unionStrings(...parts.map((p) => p.incident_types));
  merged.cross_stakeholder_dynamics = unionStrings(
    ...parts.map((p) => p.cross_stakeholder_dynamics),
  );
  merged.example_vignettes = unionStrings(...parts.map((p) => p.example_vignettes));
  const constraintByKey = new Map<string, { area: string; consideration: string }>();
  for (const part of parts) {
    for (const c of part.cross_cutting_constraints) {
      const key = norm(c.area || c.consideration);
      if (!key) continue;
      const existing = constraintByKey.get(key);
      if (!existing) constraintByKey.set(key, { ...c });
      else existing.consideration = existing.consideration || c.consideration;
    }
  }
  merged.cross_cutting_constraints = Array.from(constraintByKey.values());
  merged.global_tone_guidance =
    parts.map((p) => p.global_tone_guidance).find((v) => v.trim()) || '';

  // Trainer concepts: union items per concept name.
  const conceptByKey = new Map<string, { name: string; items: string[] }>();
  for (const part of parts) {
    for (const concept of part.trainer_concepts) {
      const key = norm(concept.name);
      if (!key) continue;
      const existing = conceptByKey.get(key);
      if (!existing) conceptByKey.set(key, { name: concept.name, items: [...concept.items] });
      else existing.items = unionStrings(existing.items, concept.items);
    }
  }
  merged.trainer_concepts = Array.from(conceptByKey.values());

  // Catch-all + warnings: concat, dedupe by content.
  const seenUnmapped = new Set<string>();
  for (const part of parts) {
    for (const d of part.unmapped_directives) {
      const key = norm(`${d.source_excerpt}|${d.note}`);
      if (key === '|' || seenUnmapped.has(key)) continue;
      seenUnmapped.add(key);
      merged.unmapped_directives.push(d);
    }
  }
  const seenWarn = new Set<string>();
  for (const part of parts) {
    for (const w of part.warnings) {
      const key = norm(`${w.field}|${w.issue}`);
      if (key === '|' || seenWarn.has(key)) continue;
      seenWarn.add(key);
      merged.warnings.push(w);
    }
  }

  // Premise / scalars: take the most confident / first non-empty.
  const premise = parts
    .map((p) => p.premise)
    .reduce((best, cur) => (cur.confidence > best.confidence ? cur : best), parts[0].premise);
  merged.premise = { ...premise };
  merged.detected_framework_kind =
    parts.map((p) => p.detected_framework_kind).find((v) => v.trim()) || '';
  merged.crisis_cluster = parts.map((p) => p.crisis_cluster).find((v) => v.trim()) || '';

  return merged;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Heuristic per-section completeness (0..1) used to drive honor-vs-generate. */
export function scoreCoverage(bp: ScenarioBlueprint): Record<string, number> {
  return {
    premise: bp.premise.crisis_type.trim() ? 1 : 0,
    factions: clamp01(bp.factions.length / 3),
    timeline: clamp01(bp.timeline.length / 4),
    escalation_model: clamp01(bp.escalation_model.tiers.length / 2),
    narrative_mutations: clamp01(bp.narrative_mutations.length / 3),
    objectives: clamp01(bp.objectives.length / 2),
    participant_decisions: clamp01(bp.participant_decisions.length / 2),
    incident_types: clamp01(bp.incident_types.length / 2),
    cross_cutting_constraints: clamp01(bp.cross_cutting_constraints.length / 2),
    cross_stakeholder_dynamics: clamp01(bp.cross_stakeholder_dynamics.length / 2),
    global_tone_guidance: bp.global_tone_guidance.trim() ? 1 : 0,
    example_vignettes: clamp01(bp.example_vignettes.length / 2),
  };
}

/** Overall confidence that the document fit a structured shape at all. */
export function scoreStructure(bp: ScenarioBlueprint): number {
  const coverage = scoreCoverage(bp);
  return clamp01(0.3 * coverage.premise + 0.4 * coverage.factions + 0.3 * coverage.timeline);
}
