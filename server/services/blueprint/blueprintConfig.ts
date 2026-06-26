/**
 * Centralized model / token configuration for the document-driven blueprint
 * feature. Keeping every knob here means model or limit changes are a one-line
 * edit rather than a hunt across services.
 *
 * Text generation standardizes on a single model with a generous completion
 * ceiling (a ceiling, not a target -- billing is on actual output tokens, so
 * the headroom only prevents truncation on dense documents).
 */

export const BLUEPRINT_TEXT_MODEL = 'gpt-5.2';

/** Default completion ceiling for blueprint calls. Per-call overrides allowed. */
export const BLUEPRINT_MAX_COMPLETION_TOKENS = 10000;

/**
 * Extraction runs COLD on purpose: it transcribes the trainer's document
 * faithfully rather than inventing, so a high temperature would hallucinate
 * factions/triggers the document never contained.
 */
export const BLUEPRINT_EXTRACTION_TEMPERATURE = 0.2;

/**
 * Map-reduce chunking for documents that exceed a single comfortable prompt.
 * Sized so typical trainer documents (10-25k chars) extract in ONE chunk with no
 * internal truncation; only larger docs are split, and then section-aware so a
 * faction is never cut mid-section.
 */
export const BLUEPRINT_CHUNK_CHARS = 25000;
export const BLUEPRINT_CHUNK_OVERLAP_CHARS = 1000;

/** Bounded parallelism for per-chunk extraction so we never fan out unbounded. */
export const BLUEPRINT_MAX_PARALLEL_CHUNKS = 4;

/** Coverage at or above this counts a section as "honored" by the trainer doc. */
export const BLUEPRINT_HONOR_THRESHOLD = 0.5;

/** Below this overall structure score, fall back to the raw-excerpt floor. */
export const BLUEPRINT_MIN_STRUCTURE_CONFIDENCE = 0.15;

// ─── Runtime Scenario Director (Phase 5) ─────────────────────────────────────

/** Completion ceiling for a single Director decision (small, bounded output). */
export const DIRECTOR_MAX_COMPLETION_TOKENS = 1200;

/** Some improvisation, but grounded. */
export const DIRECTOR_TEMPERATURE = 0.5;

/**
 * Minimum sim-minutes between Director actions, tightening as escalation rises
 * (mirrors the extremist hive cadence so the feed never floods).
 */
export function directorGapMinutes(escalationRisk: number): number {
  if (escalationRisk >= 60) return 3;
  if (escalationRisk >= 35) return 6;
  return 9;
}

/** Let the crisis breathe before the Director starts acting. */
export const DIRECTOR_MIN_ELAPSED_MINUTES = 2;
