import { directorGapMinutes, DIRECTOR_MIN_ELAPSED_MINUTES } from './blueprintConfig.js';
import type { ScenarioBlueprint } from './blueprintTypes.js';

/**
 * Pure (no DB, no LLM, no env) decision helpers for the Scenario Director, kept
 * separate so the run-or-skip logic and stage mapping are unit-testable.
 */

export interface TimelineStage {
  stage: string;
  description: string;
  order: number;
}

/**
 * Map elapsed minutes onto the blueprint timeline. Stages are spread evenly
 * across the session duration in `order`. Returns null when there is no usable
 * timeline (caller then lets the LLM infer a stage or skips).
 */
export function stageForElapsed(
  timeline: TimelineStage[],
  elapsedMinutes: number,
  durationMinutes: number,
): TimelineStage | null {
  if (!timeline || timeline.length === 0) return null;
  const ordered = [...timeline].sort((a, b) => a.order - b.order);
  const duration = durationMinutes > 0 ? durationMinutes : 60;
  const ratio = Math.max(0, Math.min(0.999, elapsedMinutes / duration));
  const idx = Math.min(ordered.length - 1, Math.floor(ratio * ordered.length));
  return ordered[idx];
}

export interface DirectorGateInput {
  enabled: boolean;
  isSocialSession: boolean;
  hasUsableBlueprint: boolean;
  elapsedMinutes: number;
  minutesSinceLastAction: number | null; // null = never acted this session
  escalationRisk: number;
}

/**
 * The single run-or-skip decision. The Director acts only when the feature is
 * enabled, the session is a social-crisis session, a usable blueprint exists,
 * the crisis has had a moment to breathe, and the cadence gap has elapsed.
 */
export function shouldDirectorAct(input: DirectorGateInput): boolean {
  if (!input.enabled) return false;
  if (!input.isSocialSession) return false;
  if (!input.hasUsableBlueprint) return false;
  if (input.elapsedMinutes < DIRECTOR_MIN_ELAPSED_MINUTES) return false;
  if (input.minutesSinceLastAction === null) return true; // never acted yet
  return input.minutesSinceLastAction >= directorGapMinutes(input.escalationRisk);
}

/** Hostile/agitator-aligned factions are the ones the Director can voice. */
export function hostileFactions(blueprint: ScenarioBlueprint): ScenarioBlueprint['factions'] {
  const aggressive = new Set(['hostile', 'amplifier', 'opportunist', 'provocateur', 'extremist']);
  return blueprint.factions.filter((f) => aggressive.has(f.alignment.trim().toLowerCase()));
}
