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

/** Map-reduce chunking for documents that exceed a single comfortable prompt. */
export const BLUEPRINT_CHUNK_CHARS = 6000;
export const BLUEPRINT_CHUNK_OVERLAP_CHARS = 400;

/** Bounded parallelism for per-chunk extraction so we never fan out unbounded. */
export const BLUEPRINT_MAX_PARALLEL_CHUNKS = 4;

/** Coverage at or above this counts a section as "honored" by the trainer doc. */
export const BLUEPRINT_HONOR_THRESHOLD = 0.5;

/** Below this overall structure score, fall back to the raw-excerpt floor. */
export const BLUEPRINT_MIN_STRUCTURE_CONFIDENCE = 0.15;
