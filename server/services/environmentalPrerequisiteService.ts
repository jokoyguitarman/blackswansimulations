/**
 * Step 5: Environmental prerequisite gate.
 * Checks (1) facility-capacity: decision references a hospital/police/fire_station area that is at capacity;
 * (2) location-condition gate: decision references a scenario location that is "bad" and not yet managed.
 * Route-related failures (unmanaged/congested route) are handled by the environmental consistency service
 * (ground truth + AI); no separate corridor-traffic check here.
 * Returns same shape as EnvironmentalConsistencyResult so the decision execute flow can apply the same
 * penalties (inject, robustness cap, objective skip/penalty).
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import type { EnvironmentalConsistencyResult } from './environmentalConsistencyService.js';
import {
  evaluatePrerequisiteReferences,
  evaluatePrerequisiteConflict,
  evaluateLocationReferenceIntent,
} from './decisionEvaluationAiService.js';

/** Flip to false to revert to the old structured-matching prerequisite prompt. */
const USE_NARRATIVE_PREREQUISITE = true;

/** Facility (hospital/police/fire_station) in environmental_state.areas; used for capacity gate. */
export type AreaRow = {
  area_id?: string;
  label?: string;
  type?: 'hospital' | 'police' | 'fire_station';
  at_capacity?: boolean;
  problem?: string;
  active?: boolean;
  managed?: boolean;
  aliases?: string[];
};

type LocationConditions = { suitability?: string; unsuitable?: boolean; cleared?: boolean };

/** Incident context for scoping prerequisite checks. */
export type IncidentContext = { title: string; description: string } | null | undefined;

/** Negation patterns: decision is saying to avoid / not use the location rather than use it. */
const NEGATION_PATTERNS = [
  /\bavoid\b/i,
  /\bdo\s+not\s+use\b/i,
  /\bdon'?t\s+use\b/i,
  /\bexclude\b/i,
  /\bnot\s+use\b/i,
  /\bskip\b/i,
  /\bdo\s+not\s+(?:use|deploy|designate)\b/i,
  /\bunsuitable\b/i,
  /\bpoor\s+(?:suitability|conditions)\b/i,
  /\bblocked\b/i,
  /\bcongestion\b/i,
  /\bsmoke\s+exposure\b/i,
  /\bdue\s+to\b/i,
];

/**
 * Returns true if the decision mentions the location in a negative context (e.g. "avoid Lot D", "do not use Lot D").
 * In that case we should not fail the prerequisite for "referencing without clearance".
 */
function decisionMentionsLocationNegatively(decisionText: string, locationLabel: string): boolean {
  const lower = decisionText.toLowerCase();
  const labelLower = locationLabel.toLowerCase().trim();
  if (!labelLower) return false;
  const windowLen = 120;
  let idx = lower.indexOf(labelLower);
  while (idx !== -1) {
    const start = Math.max(0, idx - windowLen);
    const end = Math.min(lower.length, idx + labelLower.length + windowLen);
    const window = lower.slice(start, end);
    if (NEGATION_PATTERNS.some((re) => re.test(window))) return true;
    idx = lower.indexOf(labelLower, idx + 1);
  }
  return false;
}

export interface EnvironmentalPrerequisiteEvaluationResult {
  result: EnvironmentalConsistencyResult | null;
  /** When AI was used (pass or fail), short summary for persistence on decisions.evaluation_reasoning. */
  evaluationReason?: string;
}

/**
 * Evaluate environmental prerequisite (corridor traffic + location-condition gate).
 * Returns result null if no prerequisite failure; otherwise result that the caller
 * can use as environmental_consistency (same penalties apply).
 * When openAiApiKey is set and AI is used, evaluationReason is set for AAR/trainer visibility.
 */
export async function evaluateEnvironmentalPrerequisite(
  sessionId: string,
  decision: {
    id: string;
    title: string;
    description: string;
    type: string | null;
    team_name?: string;
  },
  incident?: IncidentContext,
  openAiApiKey?: string,
): Promise<EnvironmentalPrerequisiteEvaluationResult> {
  let evaluationReason: string | undefined;
  try {
    const { data: session, error: sessionErr } = await supabaseAdmin
      .from('sessions')
      .select('id, scenario_id, current_state')
      .eq('id', sessionId)
      .single();

    if (sessionErr || !session) {
      logger.debug(
        { sessionId, error: sessionErr },
        'Session not found for environmental prerequisite',
      );
      return { result: null };
    }

    const scenarioId = (session as { scenario_id?: string }).scenario_id;
    if (!scenarioId) return { result: null };

    const currentState = (session.current_state as Record<string, unknown>) || {};
    const envState = currentState.environmental_state as { areas?: AreaRow[] } | undefined;
    const locationState = currentState.location_state as
      | Record<string, { managed?: boolean }>
      | undefined;

    const decisionText = `${decision.title ?? ''} ${decision.description ?? ''}`.trim();
    const decisionLower = decisionText.toLowerCase();

    // Build input lists for the AI prerequisite check
    const areasRaw = envState?.areas;
    const areas = Array.isArray(areasRaw) ? areasRaw : [];

    const capacityFacilities: Array<{ label: string; type: string }> = [];
    for (const area of areas) {
      const type = area.type;
      const isFacility = type === 'hospital' || type === 'police' || type === 'fire_station';
      if (!isFacility) continue;
      const atCapacity = area.at_capacity === true;
      const hasProblem = Boolean(area.problem) && area.managed !== true;
      if (!atCapacity && !hasProblem) continue;
      capacityFacilities.push({ label: area.label || area.area_id || 'facility', type: type! });
    }

    const { data: locations } = await supabaseAdmin
      .from('scenario_locations')
      .select('id, scenario_id, location_type, label, conditions')
      .eq('scenario_id', scenarioId);

    const claimedSpaces: Array<{ label: string; claimed_by: string; claimed_as: string }> = [];
    const badLocationsForAi: Array<{ label: string; location_type: string; condition: string }> =
      [];

    if (locations && locations.length > 0) {
      const teamName = decision.team_name;
      for (const loc of locations) {
        const label = (loc as { label?: string }).label ?? '';
        const cond = (loc.conditions as Record<string, unknown>) ?? {};
        const isCandidateSpace =
          cond.pin_category === 'candidate_space' || Array.isArray(cond.potential_uses);

        if (isCandidateSpace && label) {
          const locId = (loc as { id: string }).id;
          const claim = (
            locationState as
              | Record<
                  string,
                  { claimed_by?: string; claimed_as?: string; claimed_at_minutes?: number }
                >
              | undefined
          )?.[locId];
          if (
            claim?.claimed_by &&
            teamName &&
            claim.claimed_by.toLowerCase() !== teamName.toLowerCase()
          ) {
            claimedSpaces.push({
              label,
              claimed_by: claim.claimed_by,
              claimed_as: claim.claimed_as ?? 'designated area',
            });
          }
        }

        const locType = (loc as { location_type?: string }).location_type ?? '';
        const conditions = (loc.conditions as LocationConditions) ?? {};
        const isBad =
          conditions.suitability === 'low' ||
          conditions.unsuitable === true ||
          (conditions.cleared === false &&
            (conditions.suitability === 'poor' || Boolean(conditions.unsuitable)));
        if (isBad) {
          const managed = locationState?.[loc.id]?.managed === true;
          if (!managed) {
            const condDesc =
              conditions.suitability === 'low'
                ? 'low suitability'
                : conditions.unsuitable
                  ? 'unsuitable conditions'
                  : 'not cleared';
            badLocationsForAi.push({ label, location_type: locType, condition: condDesc });
          }
        }
      }
    }

    const hasItemsToCheck =
      capacityFacilities.length > 0 || claimedSpaces.length > 0 || badLocationsForAi.length > 0;

    // --- AI-based prerequisite check (primary path) ---
    if (hasItemsToCheck && openAiApiKey) {
      const aiParams = {
        decisionText,
        capacityFacilities,
        claimedSpaces,
        badLocations: badLocationsForAi,
        incidentContext: incident ?? undefined,
      };

      // --- v2: narrative / intent-based prompt ---
      if (USE_NARRATIVE_PREREQUISITE) {
        const conflict = await evaluatePrerequisiteConflict(aiParams, openAiApiKey);
        if (conflict !== null) {
          if (conflict.conflict && conflict.conflict_type) {
            evaluationReason = conflict.reason || 'Prerequisite conflict detected.';
            const reason = conflict.reason || 'Environmental prerequisite conflict.';
            return {
              result: {
                consistent: false,
                severity: 'medium',
                error_type: conflict.conflict_type,
                reason,
              },
              evaluationReason,
            };
          }
          evaluationReason =
            conflict.reason || 'Prerequisite: passed – no conflict with environment.';
          return { result: null, evaluationReason };
        }
        // conflict === null means API failure — fall through to keyword fallback below
      } else {
        // --- v1 (legacy): structured matching prompt ---
        const aiResult = await evaluatePrerequisiteReferences(aiParams, openAiApiKey);

        if (aiResult !== null) {
          if (aiResult.capacity_facility?.match && aiResult.capacity_facility.label) {
            const matchedLabel = aiResult.capacity_facility.label;
            const matchedArea = areas.find(
              (a) => (a.label ?? '').toLowerCase() === matchedLabel.toLowerCase(),
            );
            const type = matchedArea?.type ?? 'facility';
            const reason =
              type === 'hospital'
                ? `${matchedLabel} is at full capacity at the moment, causing further delay to delivering your patients.`
                : `${matchedLabel} is at full capacity; your plan cannot rely on this facility.`;
            evaluationReason = aiResult.reason ?? reason;
            return {
              result: { consistent: false, severity: 'medium', error_type: 'capacity', reason },
              evaluationReason,
            };
          }

          if (aiResult.claimed_space?.match && aiResult.claimed_space.label) {
            const sp = claimedSpaces.find(
              (s) => s.label.toLowerCase() === (aiResult.claimed_space!.label ?? '').toLowerCase(),
            );
            if (sp) {
              const reason = `${sp.label} is already being used as a ${sp.claimed_as} by ${sp.claimed_by}. You need to coordinate with them or choose a different location.`;
              evaluationReason = aiResult.reason ?? reason;
              return {
                result: {
                  consistent: false,
                  severity: 'medium',
                  error_type: 'space_contention',
                  reason,
                },
                evaluationReason,
              };
            }
          }

          if (aiResult.bad_location?.match && aiResult.bad_location.label) {
            const reason =
              aiResult.reason ??
              `The location "${aiResult.bad_location.label}" has poor suitability or conditions that have not been cleared or managed.`;
            evaluationReason = reason;
            return {
              result: { consistent: false, severity: 'medium', error_type: 'location', reason },
              evaluationReason,
            };
          }

          evaluationReason = aiResult.reason ?? 'Prerequisite: passed – no problematic references.';
          return { result: null, evaluationReason };
        }
      }
    }

    // --- Keyword fallback (when AI unavailable or fails) ---
    for (const fac of capacityFacilities) {
      const label = fac.label.toLowerCase();
      const area = areas.find((a) => (a.label ?? '').toLowerCase() === label);
      const aliases = Array.isArray(area?.aliases)
        ? area!.aliases!.map((a) => String(a).toLowerCase())
        : [];
      const mentioned =
        decisionLower.includes(label) || aliases.some((a) => a && decisionLower.includes(a));
      if (!mentioned) continue;
      const reason =
        fac.type === 'hospital'
          ? `${fac.label} is at full capacity at the moment, causing further delay to delivering your patients.`
          : `${fac.label} is at full capacity; your plan cannot rely on this facility.`;
      return {
        result: { consistent: false, severity: 'medium', error_type: 'capacity', reason },
      };
    }

    // Claimed-space check is AI-only (no keyword fallback) — intent matters
    // more than keyword presence, and false positives are worse than misses.

    if (badLocationsForAi.length > 0) {
      const badLocsFallback: Array<{ label: string; location_type: string }> = [];
      for (const bl of badLocationsForAi) {
        const labelMatch = bl.label && decisionLower.includes(bl.label.toLowerCase());
        if (!labelMatch) continue;
        if (decisionMentionsLocationNegatively(decisionText, bl.label)) continue;
        badLocsFallback.push(bl);
      }
      if (badLocsFallback.length > 0 && openAiApiKey) {
        const legacyAi = await evaluateLocationReferenceIntent(
          {
            decisionText,
            badLocations: badLocsFallback,
            incidentContext: incident ?? undefined,
          },
          openAiApiKey,
        );
        if (legacyAi?.referencesBadLocationPositively) {
          const reason =
            legacyAi.reason ??
            `The location "${badLocsFallback[0].label}" has poor conditions and has not been cleared.`;
          return {
            result: { consistent: false, severity: 'medium', error_type: 'location', reason },
            evaluationReason: reason,
          };
        }
      } else if (badLocsFallback.length > 0) {
        const reason = `The location "${badLocsFallback[0].label}" has poor suitability or conditions that have not been cleared or managed.`;
        return {
          result: { consistent: false, severity: 'medium', error_type: 'location', reason },
        };
      }
    }

    return { result: null, evaluationReason };
  } catch (err) {
    logger.warn(
      { err, sessionId, decisionId: decision.id },
      'Environmental prerequisite check failed, skipping',
    );
    return { result: null };
  }
}
