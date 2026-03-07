/**
 * Step 5: Environmental prerequisite gate.
 * Checks (1) corridor traffic: decision uses evacuation/vehicle/route while env has unmanaged routes;
 * (2) location-condition gate: decision references a scenario location that is "bad" and not yet managed.
 * Returns same shape as EnvironmentalConsistencyResult so the decision execute flow can apply the same
 * penalties (inject, robustness cap, objective skip/penalty).
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import type { EnvironmentalConsistencyResult } from './environmentalConsistencyService.js';

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

function isEvacuationOrRouteRelated(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /evacuat|vehicle|route|corridor|exit|convoy|deployment|traffic|congestion/.test(t) ||
    /\bexit\s+[a-z]|\broute\s+[a-z]/i.test(t)
  );
}

/**
 * Evaluate environmental prerequisite (corridor traffic + location-condition gate).
 * Returns null if no prerequisite failure; otherwise returns a result that the caller
 * can use as environmental_consistency (same penalties apply).
 */
export async function evaluateEnvironmentalPrerequisite(
  sessionId: string,
  decision: { id: string; title: string; description: string; type: string | null },
): Promise<EnvironmentalConsistencyResult | null> {
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
      return null;
    }

    const scenarioId = (session as { scenario_id?: string }).scenario_id;
    if (!scenarioId) return null;

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

    // --- (1) Corridor traffic: evacuation/vehicle decision + unmanaged route ---
    const routesRaw = envState?.routes;
    const routes = Array.isArray(routesRaw) ? routesRaw : [];
    const hasUnmanagedRoute = routes.some((r) => r.managed === false);
    if (hasUnmanagedRoute && isEvacuationOrRouteRelated(decisionText)) {
      const unmanagedLabels = routes
        .filter((r) => r.managed === false)
        .map((r) => r.label || r.route_id || 'route');
      return {
        consistent: false,
        severity: 'medium',
        error_type: 'flow',
        reason: `Corridor or route traffic is not yet managed (${unmanagedLabels.slice(0, 3).join(', ')}${unmanagedLabels.length > 3 ? '...' : ''}). The decision assumes use of routes that are still congested or unmanaged.`,
      };
    }

    // --- (2) Facility-capacity gate: decision references a hospital/police area that is at capacity ---
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
      const reason =
        area.problem?.trim() ||
        `${displayLabel} reports at full capacity. Your plan cannot rely on this facility; consider alternatives.`;
      return {
        consistent: false,
        severity: 'medium',
        error_type: 'capacity',
        reason,
      };
    }

    // --- (3) Location-condition gate: decision references a bad location not yet managed ---
    const { data: locations, error: locErr } = await supabaseAdmin
      .from('scenario_locations')
      .select('id, scenario_id, location_type, label, conditions')
      .eq('scenario_id', scenarioId);

    if (locErr || !locations?.length) return null;

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
      // Match by explicit location-type keywords only (no generic "location_type as phrase" to avoid matching every location of that type)
      const typeMatch =
        (locType === 'triage_site' && /triage|site/.test(decisionLower)) ||
        (locType === 'evacuation' && /evacuat/.test(decisionLower)) ||
        (locType === 'exit' && /\bexit\b/.test(decisionLower)) ||
        (locType === 'blast_site' && /blast|epicentre|epicenter/.test(decisionLower)) ||
        (locType === 'pathway' && /\bpathway\b/.test(decisionLower)) ||
        (locType === 'cordon' && /\bcordon\b/.test(decisionLower)) ||
        (locType === 'parking' && /\bparking\b/.test(decisionLower));

      if (!labelMatch && !typeMatch) continue;

      const managed = locationState?.[loc.id]?.managed === true;
      if (managed) continue;

      return {
        consistent: false,
        severity: 'medium',
        error_type: 'location',
        reason: `The location "${label || locType}" has poor suitability or conditions that have not been cleared or managed. The decision references this location without prior clearance.`,
      };
    }

    return null;
  } catch (err) {
    logger.warn(
      { err, sessionId, decisionId: decision.id },
      'Environmental prerequisite check failed, skipping',
    );
    return null;
  }
}
