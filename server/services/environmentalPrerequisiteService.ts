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
import { evaluateLocationReferenceIntent } from './decisionEvaluationAiService.js';

type RouteRow = { route_id?: string; label?: string; managed?: boolean; active?: boolean };

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
    const envState = currentState.environmental_state as
      | {
          routes?: RouteRow[];
          areas?: AreaRow[];
        }
      | undefined;
    const locationState = currentState.location_state as
      | Record<string, { managed?: boolean }>
      | undefined;

    const decisionText = `${decision.title ?? ''} ${decision.description ?? ''}`.trim();

    // --- (1) Facility-capacity gate: decision references a hospital/police area that is at capacity ---
    const areasRaw = envState?.areas;
    const areas = Array.isArray(areasRaw) ? areasRaw : [];
    const decisionLower = decisionText.toLowerCase();
    for (const area of areas) {
      const type = area.type;
      const isFacility = type === 'hospital' || type === 'police' || type === 'fire_station';
      if (!isFacility) continue;

      const label = (area.label ?? '').toLowerCase();
      const aliases = Array.isArray(area.aliases)
        ? area.aliases.map((a) => String(a).toLowerCase())
        : [];
      const mentioned =
        (label && decisionLower.includes(label)) ||
        aliases.some((a) => a && decisionLower.includes(a));

      if (!mentioned) continue;

      const atCapacity = area.at_capacity === true;
      const hasProblem = Boolean(area.problem) && area.managed !== true;
      if (!atCapacity && !hasProblem) continue;

      const displayLabel = area.label || area.area_id || 'facility';
      // Use neutral wording without hints (e.g. no "divert to X or Y") so players must think of alternatives
      const reason =
        type === 'hospital'
          ? `${displayLabel} is at full capacity at the moment, causing further delay to delivering your patients.`
          : type === 'police' || type === 'fire_station'
            ? `${displayLabel} is at full capacity; your plan cannot rely on this facility.`
            : area.problem?.trim() ||
              `${displayLabel} reports at full capacity. Your plan cannot rely on this facility; consider alternatives.`;
      return {
        result: { consistent: false, severity: 'medium', error_type: 'capacity', reason },
      };
    }

    // --- (1b) Space contention gate: decision references a candidate space claimed by another team ---
    const { data: locations, error: locErr } = await supabaseAdmin
      .from('scenario_locations')
      .select('id, scenario_id, location_type, label, conditions')
      .eq('scenario_id', scenarioId);

    if (locations && locations.length > 0) {
      const teamName = decision.team_name;
      for (const loc of locations) {
        const label = (loc as { label?: string }).label ?? '';
        const cond = (loc.conditions as Record<string, unknown>) ?? {};
        const isCandidateSpace =
          cond.pin_category === 'candidate_space' || Array.isArray(cond.potential_uses);

        if (!isCandidateSpace) continue;
        if (!label || !decisionLower.includes(label.toLowerCase())) continue;
        if (decisionMentionsLocationNegatively(decisionText, label)) continue;

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
          const reason = `${label} is already being used as a ${claim.claimed_as ?? 'designated area'} by ${claim.claimed_by}${claim.claimed_at_minutes != null ? ` (claimed at T+${claim.claimed_at_minutes})` : ''}. You need to coordinate with them or choose a different location.`;
          return {
            result: {
              consistent: false,
              severity: 'medium',
              error_type: 'space_contention',
              reason,
            },
          };
        }
      }
    }

    // --- (2) Location-condition gate: decision references a bad location not yet managed ---
    if (locErr || !locations?.length) return { result: null, evaluationReason };

    const badLocationsInScope: Array<{ label: string; location_type: string }> = [];
    for (const loc of locations) {
      const label = (loc as { label?: string }).label ?? '';
      const locType = (loc as { location_type?: string }).location_type ?? '';
      const conditions = (loc.conditions as LocationConditions) ?? {};
      const isBad =
        conditions.suitability === 'low' ||
        conditions.unsuitable === true ||
        (conditions.cleared === false &&
          (conditions.suitability === 'poor' || Boolean(conditions.unsuitable)));

      if (!isBad) continue;

      const labelMatch = label && decisionLower.includes(label.toLowerCase());
      const typeMatch =
        (locType === 'triage_site' && /triage|site/.test(decisionLower)) ||
        (locType === 'evacuation' && /evacuat/.test(decisionLower)) ||
        (locType === 'exit' && /\bexit\b/.test(decisionLower)) ||
        (locType === 'blast_site' && /blast|epicentre|epicenter/.test(decisionLower)) ||
        (locType === 'pathway' && /\bpathway\b/.test(decisionLower)) ||
        (locType === 'cordon' && /\bcordon\b/.test(decisionLower)) ||
        (locType === 'parking' && /\bparking\b/.test(decisionLower));

      // New-model: check if potential_uses matches the decision context
      const potentialUses = (conditions as Record<string, unknown>).potential_uses;
      const usesMatch =
        !typeMatch &&
        Array.isArray(potentialUses) &&
        (potentialUses as string[]).some((use) => decisionLower.includes(use.replace(/_/g, ' ')));

      if (!labelMatch && !typeMatch && !usesMatch) continue;

      const managed = locationState?.[loc.id]?.managed === true;
      if (managed) continue;

      badLocationsInScope.push({ label, location_type: locType });
    }

    if (badLocationsInScope.length > 0 && openAiApiKey) {
      const aiResult = await evaluateLocationReferenceIntent(
        { decisionText, badLocations: badLocationsInScope, incidentContext: incident ?? undefined },
        openAiApiKey,
      );
      if (aiResult !== null) {
        if (aiResult.referencesBadLocationPositively) {
          const firstLabel =
            badLocationsInScope[0]?.label || badLocationsInScope[0]?.location_type || 'location';
          const reason =
            aiResult.reason?.slice(0, 400) ??
            `The location "${firstLabel}" has poor suitability or conditions that have not been cleared or managed. The decision references this location without prior clearance.`;
          return {
            result: { consistent: false, severity: 'medium', error_type: 'location', reason },
            evaluationReason: reason,
          };
        }
        evaluationReason =
          (evaluationReason ? `${evaluationReason} ` : '') +
          (aiResult.reason ??
            'Location: passed – decision only references bad locations in a rejecting way.');
        return { result: null, evaluationReason };
      }
    }

    // Fallback: existing keyword logic per location
    for (const loc of locations) {
      const label = (loc as { label?: string }).label ?? '';
      const locType = (loc as { location_type?: string }).location_type ?? '';
      const conditions = (loc.conditions as LocationConditions) ?? {};
      const isBad =
        conditions.suitability === 'low' ||
        conditions.unsuitable === true ||
        (conditions.cleared === false &&
          (conditions.suitability === 'poor' || Boolean(conditions.unsuitable)));

      if (!isBad) continue;

      const labelMatch = label && decisionLower.includes(label.toLowerCase());
      const typeMatch =
        (locType === 'triage_site' && /triage|site/.test(decisionLower)) ||
        (locType === 'evacuation' && /evacuat/.test(decisionLower)) ||
        (locType === 'exit' && /\bexit\b/.test(decisionLower)) ||
        (locType === 'blast_site' && /blast|epicentre|epicenter/.test(decisionLower)) ||
        (locType === 'pathway' && /\bpathway\b/.test(decisionLower)) ||
        (locType === 'cordon' && /\bcordon\b/.test(decisionLower)) ||
        (locType === 'parking' && /\bparking\b/.test(decisionLower));

      const potentialUses = (conditions as Record<string, unknown>).potential_uses;
      const usesMatch =
        !typeMatch &&
        Array.isArray(potentialUses) &&
        (potentialUses as string[]).some((use) => decisionLower.includes(use.replace(/_/g, ' ')));

      if (!labelMatch && !typeMatch && !usesMatch) continue;

      const managed = locationState?.[loc.id]?.managed === true;
      if (managed) continue;

      if (labelMatch && decisionMentionsLocationNegatively(decisionText, label)) continue;

      const reason = `The location "${label || locType}" has poor suitability or conditions that have not been cleared or managed. The decision references this location without prior clearance.`;
      return { result: { consistent: false, severity: 'medium', error_type: 'location', reason } };
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
