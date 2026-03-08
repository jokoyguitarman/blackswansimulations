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
import { evaluateLocationReferenceIntent } from './decisionEvaluationAiService.js';
import { evaluateRouteManagementIntent } from './decisionEvaluationAiService.js';

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

/** Incident context for scoping prerequisite checks (e.g. skip corridor check when incident is not evacuation-related). */
export type IncidentContext = { title: string; description: string } | null | undefined;

function incidentSuggestsEvacuationOrRoute(incident: IncidentContext): boolean {
  if (!incident?.title && !incident?.description) return true; // no context => run check
  const text = `${incident.title ?? ''} ${incident.description ?? ''}`.toLowerCase();
  return /evacuat|exit|route|corridor|congestion|bottleneck/i.test(text);
}

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

/** First segment of a route label (before "–" or "(") for mention matching; e.g. "Bishan Street 13 – north to hospital zone" → "Bishan Street 13". */
function firstSegmentOfLabel(label: string): string {
  const trimmed = (label || '').trim();
  const dash = trimmed.indexOf('–');
  const paren = trimmed.indexOf('(');
  const end = Math.min(dash >= 0 ? dash : trimmed.length, paren >= 0 ? paren : trimmed.length);
  return trimmed.slice(0, end).trim();
}

/**
 * Returns true if the decision text (case-insensitive) refers to the route: full label, route_id, or first segment of label.
 */
function decisionMentionsRoute(
  decisionText: string,
  route: { label?: string; route_id?: string },
): boolean {
  const lower = decisionText.toLowerCase();
  const label = (route.label || '').trim();
  const labelLower = label.toLowerCase();
  if (labelLower && lower.includes(labelLower)) return true;
  const routeId = (route.route_id || '').trim();
  if (routeId && lower.includes(routeId.toLowerCase())) return true;
  const segment = firstSegmentOfLabel(label);
  if (segment.length >= 3 && lower.includes(segment.toLowerCase())) return true;
  return false;
}

/** Patterns indicating the decision proposes to manage or clear the route/corridor before using it. */
const MANAGE_FIRST_PATTERNS = [
  /\bmanage\s+and\s+clear\b/i,
  /\bclear\s+.*\s+before\b/i,
  /\bbefore\s+routing\b/i,
  /\bbefore\s+use\b/i,
  /\bactively\s+manage\b/i,
  /\bdeploy\s+marshals\s+to\b/i,
  /\bclear\s+the\s+corridor\b/i,
  /\bclear\s+.*\s+corridor\b/i,
  /\bmanage\s+.*\s+traffic\b/i,
  /\bclear\s+.*\s+traffic\b/i,
  /\bmanage\s+.*\s+before\b/i,
  /\bclear\s+.*\s+before\b/i,
];

/**
 * Returns true if, in a window around each mention of the route in the decision, there is phrasing that the team will manage/clear the route first.
 */
function decisionProposesManagingRouteFirst(
  decisionText: string,
  routeLabelOrSegment: string,
): boolean {
  const lower = decisionText.toLowerCase();
  const search = routeLabelOrSegment.toLowerCase().trim();
  if (!search) return false;
  const windowLen = 120;
  let idx = lower.indexOf(search);
  while (idx !== -1) {
    const start = Math.max(0, idx - windowLen);
    const end = Math.min(lower.length, idx + search.length + windowLen);
    const window = lower.slice(start, end);
    if (MANAGE_FIRST_PATTERNS.some((re) => re.test(window))) return true;
    idx = lower.indexOf(search, idx + 1);
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
  decision: { id: string; title: string; description: string; type: string | null },
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

    // --- (1) Corridor traffic: only fail when decision mentions an unmanaged route and does not propose managing/clearing it first ---
    const routesRaw = envState?.routes;
    const routes = Array.isArray(routesRaw) ? routesRaw : [];
    const unmanagedRoutes = routes.filter((r) => r.managed === false);
    const runCorridorCheck = incidentSuggestsEvacuationOrRoute(incident);
    if (
      runCorridorCheck &&
      unmanagedRoutes.length > 0 &&
      isEvacuationOrRouteRelated(decisionText)
    ) {
      const mentionedUnmanaged = unmanagedRoutes.filter((r) =>
        decisionMentionsRoute(decisionText, r),
      );
      if (mentionedUnmanaged.length === 0) {
        // Decision never mentions any unmanaged route — do not fail
      } else {
        const routeLabelsOrSegments = mentionedUnmanaged.map((r) => {
          const labelOrSegment = r.label || r.route_id || '';
          const segment = firstSegmentOfLabel(labelOrSegment);
          return segment.length >= 3 ? segment : labelOrSegment;
        });
        if (openAiApiKey && routeLabelsOrSegments.length > 0) {
          const aiResult = await evaluateRouteManagementIntent(
            { decisionText, unmanagedRouteLabelsOrSegments: routeLabelsOrSegments },
            openAiApiKey,
          );
          if (aiResult !== null) {
            if (!aiResult.proposesManagingBeforeUse) {
              const labels = mentionedUnmanaged.map((r) => r.label || r.route_id || 'route');
              const reason =
                aiResult.reason?.slice(0, 400) ??
                `Corridor or route traffic is not yet managed (${labels.slice(0, 3).join(', ')}${labels.length > 3 ? '...' : ''}). The decision assumes use of routes that are still congested or unmanaged.`;
              return {
                result: {
                  consistent: false,
                  severity: 'medium',
                  error_type: 'flow',
                  reason,
                },
                evaluationReason: reason,
              };
            }
            evaluationReason =
              (evaluationReason ? `${evaluationReason} ` : '') +
              (aiResult.reason ?? 'Route: passed – decision proposes managing corridor first.');
          } else {
            // Fallback: use keyword logic
            const stillFailing = mentionedUnmanaged.filter((r) => {
              const labelOrSegment = r.label || r.route_id || '';
              const segment = firstSegmentOfLabel(labelOrSegment);
              const search = segment.length >= 3 ? segment : labelOrSegment;
              return !decisionProposesManagingRouteFirst(decisionText, search);
            });
            if (stillFailing.length > 0) {
              const labels = stillFailing.map((r) => r.label || r.route_id || 'route');
              const reason = `Corridor or route traffic is not yet managed (${labels.slice(0, 3).join(', ')}${labels.length > 3 ? '...' : ''}). The decision assumes use of routes that are still congested or unmanaged.`;
              return {
                result: { consistent: false, severity: 'medium', error_type: 'flow', reason },
              };
            }
          }
        } else {
          const stillFailing = mentionedUnmanaged.filter((r) => {
            const labelOrSegment = r.label || r.route_id || '';
            const segment = firstSegmentOfLabel(labelOrSegment);
            const search = segment.length >= 3 ? segment : labelOrSegment;
            return !decisionProposesManagingRouteFirst(decisionText, search);
          });
          if (stillFailing.length > 0) {
            const labels = stillFailing.map((r) => r.label || r.route_id || 'route');
            const reason = `Corridor or route traffic is not yet managed (${labels.slice(0, 3).join(', ')}${labels.length > 3 ? '...' : ''}). The decision assumes use of routes that are still congested or unmanaged.`;
            return {
              result: { consistent: false, severity: 'medium', error_type: 'flow', reason },
            };
          }
        }
      }
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
        result: { consistent: false, severity: 'medium', error_type: 'capacity', reason },
      };
    }

    // --- (3) Location-condition gate: decision references a bad location not yet managed ---
    const { data: locations, error: locErr } = await supabaseAdmin
      .from('scenario_locations')
      .select('id, scenario_id, location_type, label, conditions')
      .eq('scenario_id', scenarioId);

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

      if (!labelMatch && !typeMatch) continue;

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

      if (!labelMatch && !typeMatch) continue;

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
