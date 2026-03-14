/**
 * Checkpoint 2: Environmental consistency evaluation.
 * Compares a decision's details to the scenario's layout/environment ground truth.
 * Used to fire environmental mismatch injects, skip positive objective progress, and cap robustness.
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { publishInjectToSession } from '../routes/injects.js';
import type { Server as SocketServer } from 'socket.io';

export type EnvironmentalConsistencySeverity = 'low' | 'medium' | 'high';
export type EnvironmentalConsistencyErrorType =
  | 'capacity'
  | 'location'
  | 'flow'
  | 'space_contention'
  | 'other';

/** When consistent is false: "contradiction" = wrong vs ground truth; "below_standard" = correct but short of sector standard. */
export type EnvironmentalMismatchKind = 'contradiction' | 'below_standard';

/** When the decision is route-related: effect on counters (clear = fast/managed, slow = slower/congested but valid, congested = blocked/unmanaged or clearly suboptimal). */
export type RouteEffect = 'clear' | 'slow' | 'congested';

export interface EnvironmentalConsistencyResult {
  consistent: boolean;
  severity?: EnvironmentalConsistencySeverity;
  error_type?: EnvironmentalConsistencyErrorType;
  /** Set when consistent is false: contradiction = factual error vs ground truth; below_standard = meets ground truth but below sector standard. */
  mismatch_kind?: EnvironmentalMismatchKind;
  reason?: string;
  /** When the decision is route-related (evacuation, triage, transport): used for counter pressure in inject scheduler. */
  route_effect?: RouteEffect | null;
}

/** Scenario location row (map pin) for building ground truth from same data the Insider uses. */
interface ScenarioLocationRow {
  label?: string | null;
  location_type?: string | null;
  conditions?: Record<string, unknown> | null;
  display_order?: number | null;
}

/** Site area from insider_knowledge.site_areas (triage candidates). */
interface SiteAreaForGroundTruth {
  capacity_lying?: number;
  capacity_standing?: number;
  label?: string;
}

/** Session route row (from current_state.environmental_state.routes) for ground truth. */
interface SessionRouteRow {
  label?: string;
  problem?: string | null;
  managed?: boolean;
  travel_time_minutes?: number | null;
}

/**
 * Build environment ground truth summary for the evaluator.
 * Includes (1) full layout_ground_truth (exits with status/congestion, zones, blast_site) so traffic/blockages
 * are in ground truth even if the Insider does not mention them; (2) all Insider-visible data (triage candidates
 * from scenario_locations + site_areas, evacuation holding areas, routes, hospitals) so decisions that follow
 * Insider intel are not falsely flagged; (3) current route status from session (label, problem, managed, travel_time).
 * Ground truth ⊇ Insider knowledge; ground truth can have more (e.g. congestion).
 */
function buildGroundTruthSummary(
  insiderKnowledge: Record<string, unknown>,
  scenarioLocations?: ScenarioLocationRow[] | null,
  sessionRoutes?: SessionRouteRow[],
): string {
  const layout = insiderKnowledge.layout_ground_truth as
    | {
        evacuee_count?: number;
        exits?: Array<{ id?: string; label?: string; flow_per_min?: number; status?: string }>;
        zones?: Array<{ id?: string; label?: string; capacity?: number; type?: string }>;
        blast_site?: Record<string, unknown>;
      }
    | undefined;
  const parts: string[] = [];

  // 1) Full layout (exits with status/congestion, zones, evacuee_count, blast_site) — can include info Insider doesn't show
  if (layout) {
    if (layout.evacuee_count != null) parts.push(`Evacuees: ${layout.evacuee_count}`);
    if (layout.exits?.length)
      parts.push(
        `Exits: ${layout.exits.map((e) => `${e.label ?? e.id ?? 'Exit'}${e.flow_per_min != null ? ` ${e.flow_per_min}/min` : ''}${e.status ? ` [${e.status}]` : ''}`).join('; ')}`,
      );
    if (layout.zones?.length)
      parts.push(
        `Zones/areas: ${layout.zones.map((z) => `${z.label ?? z.id ?? 'Zone'}${z.capacity != null ? ` capacity ${z.capacity}` : ''}${z.type ? ` type ${z.type}` : ''}`).join('; ')}`,
      );
    if (layout.blast_site && typeof layout.blast_site === 'object') {
      const desc = (layout.blast_site as { description?: string }).description;
      if (desc) parts.push(`Blast/cordon: ${desc}`);
    }
  }

  // 2) Triage zone candidates (same as Insider triage_site: scenario_locations area/triage_site + site_areas)
  const siteAreas = (insiderKnowledge.site_areas ?? []) as SiteAreaForGroundTruth[];
  const triageLocations = (scenarioLocations ?? []).filter(
    (loc) => loc.location_type === 'area' || loc.location_type === 'triage_site',
  );
  if (triageLocations.length > 0) {
    const triageLines = triageLocations.map((loc, i) => {
      const label = loc.label ?? `Area ${i + 1}`;
      const cond = (loc.conditions ?? {}) as Record<string, unknown>;
      const sa = siteAreas[i];
      const lying = (cond.capacity_lying as number) ?? sa?.capacity_lying;
      const standing = (cond.capacity_standing as number) ?? sa?.capacity_standing;
      const distBlast = cond.distance_from_blast_m as number | undefined;
      const cap = [lying != null && `lying ${lying}`, standing != null && `standing ${standing}`]
        .filter(Boolean)
        .join(', ');
      const distPart = distBlast != null ? `${distBlast} m from blast` : '';
      const inner = [cap, distPart].filter(Boolean).join(', ');
      return inner ? `${label} (${inner})` : label;
    });
    parts.push(`Triage zone candidates (valid for decisions): ${triageLines.join('; ')}`);
  }

  // 3) Evacuation holding areas (same as Insider evacuation_holding)
  const evacHolding = (scenarioLocations ?? []).filter(
    (loc) => loc.location_type === 'evacuation_holding',
  );
  if (evacHolding.length > 0) {
    const evacLines = evacHolding.map((loc) => {
      const label = loc.label ?? 'Unknown';
      const cond = (loc.conditions ?? {}) as Record<string, unknown>;
      const cap = cond.capacity as number | undefined;
      const distBlast = cond.distance_from_blast_m as number | undefined;
      const evacParts: string[] = [];
      if (cap != null) evacParts.push(`capacity ${cap}`);
      if (distBlast != null) evacParts.push(`${distBlast} m from blast`);
      return evacParts.length ? `${label} (${evacParts.join(', ')})` : label;
    });
    parts.push(`Evacuation holding areas (valid for decisions): ${evacLines.join('; ')}`);
  }

  // 2b) Fallback: new-model candidate spaces with potential_uses (when no typed pins found)
  if (triageLocations.length === 0 && evacHolding.length === 0) {
    const candidateSpaces = (scenarioLocations ?? []).filter((loc) => {
      const cond = (loc.conditions ?? {}) as Record<string, unknown>;
      return Array.isArray(cond.potential_uses);
    });
    if (candidateSpaces.length > 0) {
      const spaceLines = candidateSpaces.map((loc) => {
        const label = loc.label ?? 'Space';
        const cond = (loc.conditions ?? {}) as Record<string, unknown>;
        const propParts: string[] = [];
        if (cond.area_m2 != null) propParts.push(`${cond.area_m2}m²`);
        if (cond.capacity_persons != null) propParts.push(`cap ${cond.capacity_persons}`);
        if (cond.has_water !== undefined) propParts.push(cond.has_water ? 'water' : 'no water');
        if (cond.has_electricity !== undefined)
          propParts.push(cond.has_electricity ? 'power' : 'no power');
        if (cond.has_shelter !== undefined) propParts.push(cond.has_shelter ? 'sheltered' : 'open');
        if (cond.vehicle_access !== undefined)
          propParts.push(cond.vehicle_access ? 'vehicle access' : 'no vehicle access');
        if (cond.distance_from_incident_m != null)
          propParts.push(`${cond.distance_from_incident_m}m from incident`);
        const uses = Array.isArray(cond.potential_uses)
          ? (cond.potential_uses as string[]).join('/')
          : '';
        const inner = propParts.join(', ');
        return `${label} (${inner})${uses ? ` [potential: ${uses}]` : ''}`;
      });
      parts.push(`Candidate operational spaces: ${spaceLines.join('; ')}`);
    }
  }

  // 2c) Site requirements from standards (what each operational area type needs physically)
  const siteReqs = insiderKnowledge.site_requirements as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (siteReqs && Object.keys(siteReqs).length > 0) {
    const reqLines = Object.entries(siteReqs).map(([useType, req]) => {
      const props: string[] = [];
      if (req.min_area_m2 != null) props.push(`min ${req.min_area_m2}m²`);
      if (req.min_capacity != null) props.push(`min cap ${req.min_capacity}`);
      if (req.requires_water) props.push('needs water');
      if (req.requires_electricity) props.push('needs power');
      if (req.requires_shelter) props.push('needs shelter');
      if (req.requires_vehicle_access) props.push('needs vehicle access');
      if (req.max_distance_from_incident_m != null)
        props.push(`max ${req.max_distance_from_incident_m}m from incident`);
      return `${useType}: ${props.join(', ')}`;
    });
    parts.push(`Site requirements (standards): ${reqLines.join('; ')}`);
  }

  // 2d) POI pin conditions (hospital capacities, police capabilities)
  const poiPins = (scenarioLocations ?? []).filter(
    (loc) =>
      loc.location_type === 'hospital' ||
      loc.location_type === 'police_station' ||
      loc.location_type === 'fire_station',
  );
  if (poiPins.length > 0) {
    const poiLines = poiPins.map((loc) => {
      const label = loc.label ?? 'Facility';
      const cond = (loc.conditions ?? {}) as Record<string, unknown>;
      const propParts: string[] = [];
      if (cond.distance_from_incident_m != null)
        propParts.push(`${cond.distance_from_incident_m}m`);
      if (cond.estimated_response_time_min != null)
        propParts.push(`~${cond.estimated_response_time_min}min response`);
      if (cond.bed_capacity != null) propParts.push(`${cond.bed_capacity} beds`);
      if (cond.emergency_beds_available != null)
        propParts.push(`${cond.emergency_beds_available} emergency beds`);
      if (cond.trauma_center_level) propParts.push(String(cond.trauma_center_level));
      if (cond.available_officers_estimate != null)
        propParts.push(`~${cond.available_officers_estimate} officers`);
      if (cond.appliance_count != null) propParts.push(`${cond.appliance_count} appliances`);
      return propParts.length ? `${label} (${propParts.join(', ')})` : label;
    });
    parts.push(`Nearby facilities (enriched): ${poiLines.join('; ')}`);
  }

  // 4) Emergency routes (same as Insider routes)
  const osm = insiderKnowledge.osm_vicinity as
    | {
        emergency_routes?: Array<{
          description?: string;
          highway_type?: string;
          one_way?: boolean;
        }>;
        hospitals?: Array<{ name?: string; address?: string }>;
      }
    | undefined;
  if (osm?.emergency_routes?.length) {
    const routeLines = osm.emergency_routes.map(
      (r) => `${r.description ?? 'Route'}${r.one_way ? ' [one-way]' : ''}`,
    );
    parts.push(`Emergency routes: ${routeLines.join('; ')}`);
  }

  // 5) Hospitals from OSM (fallback when no enriched POI pins)
  if (poiPins.length === 0 && osm?.hospitals?.length) {
    const hospitalNames = osm.hospitals.map((h) => h.name ?? 'Unknown').join(', ');
    parts.push(`Nearby hospitals: ${hospitalNames}`);
  }

  // 6) Current route status from session (congestion, managed, travel time) — used to cap robustness and set route_effect
  if (sessionRoutes?.length) {
    const routeLines = sessionRoutes.map((r) => {
      const label = r.label ?? 'Route';
      const status = r.problem?.trim() || 'clear';
      const managed = r.managed === true ? 'managed' : 'unmanaged';
      const min = r.travel_time_minutes != null ? `${r.travel_time_minutes} min` : '? min';
      return `${label} – ${status}, ${managed}, ${min}`;
    });
    parts.push(`Current route status: ${routeLines.join('; ')}`);
  }

  return parts.length > 0 ? parts.join('. ') : '';
}

/**
 * Evaluate whether a decision's details are consistent with the scenario's environment.
 * Uses scenario.insider_knowledge (layout_ground_truth). If no ground truth, returns consistent.
 * On AI failure/timeout, returns consistent to avoid blocking execute.
 * When incident is provided, only flag contradictions relevant to that incident; prefer consistent when the decision does not make layout-specific claims that contradict ground truth.
 */
export async function evaluateDecisionAgainstEnvironment(
  sessionId: string,
  decision: { id: string; title: string; description: string; type: string | null },
  openAiApiKey: string | undefined,
  incident?: { title: string; description: string } | null,
  teamName?: string,
): Promise<EnvironmentalConsistencyResult> {
  const consistentDefault: EnvironmentalConsistencyResult = { consistent: true };
  if (!openAiApiKey) return consistentDefault;

  try {
    const { data: session, error: sessionErr } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id, current_state')
      .eq('id', sessionId)
      .single();
    if (sessionErr || !session) {
      logger.debug(
        { sessionId, error: sessionErr },
        'Session not found for environmental consistency',
      );
      return consistentDefault;
    }

    const scenarioId = (session as { scenario_id: string }).scenario_id;
    const currentState = (session as { current_state?: Record<string, unknown> }).current_state as
      | Record<string, unknown>
      | undefined;
    const envState = currentState?.environmental_state as
      | {
          routes?: Array<{
            label?: string;
            problem?: string | null;
            managed?: boolean;
            travel_time_minutes?: number | null;
          }>;
        }
      | undefined;
    const sessionRoutes = Array.isArray(envState?.routes) ? envState.routes : [];
    const { data: scenario, error: scenarioErr } = await supabaseAdmin
      .from('scenarios')
      .select('id, description, insider_knowledge')
      .eq('id', scenarioId)
      .single();
    if (scenarioErr || !scenario) return consistentDefault;

    const insiderKnowledge = ((scenario as { insider_knowledge?: Record<string, unknown> })
      .insider_knowledge ?? {}) as Record<string, unknown>;

    // Fetch scenario_locations (same source as Insider) so ground truth includes all Insider-visible data
    const { data: scenarioLocations } = await supabaseAdmin
      .from('scenario_locations')
      .select('label, location_type, conditions, display_order')
      .eq('scenario_id', scenarioId)
      .order('display_order', { ascending: true });

    const groundTruthSummary = buildGroundTruthSummary(
      insiderKnowledge,
      scenarioLocations ?? null,
      sessionRoutes,
    );
    let sectorStandards: string | undefined;
    if (teamName) {
      const teamDoctrines = insiderKnowledge.team_doctrines as
        | Record<string, unknown[]>
        | undefined;
      if (
        teamDoctrines &&
        Array.isArray(teamDoctrines[teamName]) &&
        teamDoctrines[teamName].length > 0
      ) {
        const { standardsToPromptBlock } = await import('./warroomResearchService.js');
        sectorStandards = standardsToPromptBlock(
          teamDoctrines[teamName] as import('./warroomResearchService.js').StandardsFinding[],
        );
      }
    }
    if (!sectorStandards && typeof insiderKnowledge.sector_standards === 'string') {
      sectorStandards = insiderKnowledge.sector_standards;
    }
    if (!groundTruthSummary) {
      logger.debug(
        { sessionId, scenarioId: (scenario as { id: string }).id },
        'No layout ground truth for environmental check',
      );
      return consistentDefault;
    }

    const incidentBlock =
      incident?.title != null || incident?.description != null
        ? ` The decision is in response to a specific incident. Only flag contradictions that are RELEVANT to that incident (e.g. for "Journalists at triage", do not penalize lack of exit/layout claims; for "Evacuation route blocked", focus on route/exit/capacity claims). Prefer consistent: true when the decision does not make layout-specific claims that contradict ground truth. When consistent is false, phrase the reason as: "Given the incident (X), the decision proposed Y which contradicts ground truth Z."`
        : '';

    const systemPrompt = `You are an expert crisis management evaluator. Given a decision (title and description) and the scenario's ENVIRONMENT GROUND TRUTH, determine if the decision's details are consistent with that environment.${incidentBlock}

Rules:
- consistent: true if the decision does not contradict the ground truth and (when sector standards exist) either meets them or uses a pragmatic option that matches ground truth.
- consistent: false only when (a) the decision contradicts ground truth, or (b) the decision is clearly dangerous (e.g. capacity a small fraction of need with no mitigation). Do NOT set consistent false merely for being below a sector standard (e.g. 125% evacuee capacity) when the decision correctly uses an existing area and the shortfall is a realistic constraint.
- Contradiction: Use mismatch_kind "contradiction" ONLY when the decision explicitly states a fact about a specific location, exit, or route that differs from ground truth (e.g. "North has capacity 200" when ground truth says 50; "use Exit X" when X does not exist). Do NOT infer a stated fact from other numbers in the text (e.g. "1000 evacuees" or "100" elsewhere); only attribute a capacity or location claim to a place if the decision clearly assigns that number to that place.
- Below_standard: Use mismatch_kind "below_standard" when the decision uses correct names and capacities from ground truth but total capacity is below evacuee count or sector standard, or when the decision describes mitigation (waves, overflow, staging) without claiming total capacity is adequate. Do NOT treat "using available areas and managing in waves/overflow" as claiming adequate capacity; treat shortfall as below_standard.
- Do not invent contradictions: If the decision correctly states a capacity for a location (e.g. "Vacant Lot E standing capacity 500" and ground truth says Lot E has standing 500), set consistent: true. Only set contradiction if the decision states a different number for that location (e.g. "Lot E has 100 lying" when ground truth says Lot E has 50 lying).
- severity: "low" = minor (e.g. 60 in 50-capacity area); "medium" = clear contradiction (e.g. wrong exit, 100 in 50); "high" = dangerous/impossible (e.g. 200 in 50, non-existent exit). For below_standard use "low" or "medium" only. NEVER combine severity "high" with mismatch_kind "below_standard".
- error_type: "capacity" | "location" | "flow" | "other" (if consistent is false).
- reason: one clear sentence (e.g. for contradiction: "The assembly area North has a safe capacity of 50; your plan assumed 100." For below_standard: "The assembly area you designated (North capacity 200) is below the sector guideline of 125% of expected evacuees (1250); your plan uses the available option.").
- Routes: If "Current route status" is in the ground truth, use it. If the decision uses a route that is congested, blocked, or unmanaged without proposing to manage/clear it first, set consistent: false with appropriate severity and error_type "flow" or "location". If the decision chooses a significantly slower route when a faster one is available, set consistent: false (or below_standard) with severity and reason.
- route_effect (when the decision is route-related: evacuation, triage, transport, convoy): "clear" = uses a fast/managed route; "slow" = uses a slower or congested route but still valid; "congested" = uses a blocked/unmanaged route or clearly suboptimal. Omit or null when the decision does not involve route choice.

Sector standards (e.g. 125% assembly capacity, triage ratios) are best-practice targets, not absolute requirements. Only use them to set consistent false when the decision also contradicts ground truth or is clearly dangerous. If the decision correctly uses a real area/capacity from ground truth but that capacity is below the standard, set mismatch_kind "below_standard" and severity "low" or "medium".

CRITICAL: If a location EXISTS in ground truth and the decision uses its CORRECT capacity but that capacity is insufficient for the need, that is ALWAYS "below_standard", NEVER "contradiction". "contradiction" is reserved for factual errors (wrong numbers, non-existent locations).

Examples: (1) Decision says "Vacant Lot E standing capacity 500" and ground truth says Lot E (standing 500). Result: consistent true. (2) Decision says "Assembly North capacity 300" and ground truth says Assembly North capacity 200. Result: consistent false, mismatch_kind "contradiction". (3) Decision says "use Commercial Area for triage" and ground truth says Commercial Area capacity 80 but triage needs 100. Result: consistent false, mismatch_kind "below_standard", severity "medium".

Return ONLY valid JSON: { "consistent": boolean, "mismatch_kind": "contradiction"|"below_standard" (if consistent is false), "severity": "low"|"medium"|"high" (if consistent is false), "error_type": "capacity"|"location"|"flow"|"other" (if consistent is false), "reason": "..." (if consistent is false), "route_effect": "clear"|"slow"|"congested"|null (when decision is route-related) }`;

    const incidentUserBlock =
      incident?.title != null || incident?.description != null
        ? `\nINCIDENT (this decision is in response to):\nTitle: ${incident.title ?? ''}\nDescription: ${incident.description ?? ''}\n\n`
        : '';

    const sectorStandardsLine = sectorStandards
      ? `Sector standards (if any): ${sectorStandards}\n\n`
      : '';
    const userPrompt = `ENVIRONMENT GROUND TRUTH: ${groundTruthSummary}

${sectorStandardsLine}${incidentUserBlock}DECISION:
Title: ${decision.title}
Description: ${decision.description}

Only treat as contradiction if the decision explicitly states a specific fact that contradicts the ground truth for that place or route; otherwise prefer consistent or below_standard.

Is this decision consistent with the environment? Return JSON only.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 300,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      logger.warn(
        { status: response.status },
        'OpenAI API error in evaluateDecisionAgainstEnvironment',
      );
      return consistentDefault;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return consistentDefault;

    const parsed = JSON.parse(content) as {
      consistent?: boolean;
      mismatch_kind?: string;
      severity?: string;
      error_type?: string;
      reason?: string;
      route_effect?: string | null;
    };

    const routeEffect =
      parsed.route_effect === 'clear' ||
      parsed.route_effect === 'slow' ||
      parsed.route_effect === 'congested'
        ? (parsed.route_effect as RouteEffect)
        : undefined;

    const consistent = parsed.consistent === true;
    if (consistent) {
      return { consistent: true, route_effect: routeEffect ?? null };
    }

    const rawKind = (typeof parsed.mismatch_kind === 'string' ? parsed.mismatch_kind : '')
      .toLowerCase()
      .trim()
      .replace(/[\s-]+/g, '_');
    const mismatch_kind: EnvironmentalMismatchKind =
      rawKind === 'below_standard' ? 'below_standard' : 'contradiction';
    let severity = ['low', 'medium', 'high'].includes(parsed.severity ?? '')
      ? (parsed.severity as EnvironmentalConsistencySeverity)
      : 'medium';
    if (mismatch_kind === 'below_standard' && severity === 'high') {
      severity = 'medium';
    }
    const error_type = ['capacity', 'location', 'flow', 'space_contention', 'other'].includes(
      parsed.error_type ?? '',
    )
      ? (parsed.error_type as EnvironmentalConsistencyErrorType)
      : 'other';
    const reason =
      typeof parsed.reason === 'string' && parsed.reason.trim()
        ? parsed.reason.trim().slice(0, 500)
        : 'Decision details do not match current site conditions.';

    return {
      consistent: false,
      severity,
      error_type,
      mismatch_kind,
      reason,
      route_effect: routeEffect ?? null,
    };
  } catch (err) {
    logger.warn(
      { err, sessionId, decisionId: decision.id },
      'evaluateDecisionAgainstEnvironment failed, treating as consistent',
    );
    return consistentDefault;
  }
}

/**
 * Create and publish an environmental mismatch inject for the team(s) that made the decision.
 * Call when Checkpoint 2 returns consistent: false.
 */
/**
 * Publish environmental mismatch inject only for contradictions (wrong vs ground truth).
 * Below-standard (correct but short of sector guideline) is not announced; robustness cap still applies.
 */
export async function createAndPublishEnvironmentalMismatchInject(
  params: {
    sessionId: string;
    scenarioId: string;
    trainerId: string;
    authorTeamNames: string[];
    result: EnvironmentalConsistencyResult;
    decisionId: string;
  },
  io: SocketServer,
): Promise<void> {
  const { sessionId, scenarioId, trainerId, authorTeamNames, result } = params;
  if (result.consistent) return;
  if (result.mismatch_kind === 'below_standard') return; // no inject for below-standard only

  const title =
    result.error_type === 'capacity'
      ? 'Environmental mismatch: capacity'
      : result.error_type === 'location'
        ? 'Environmental mismatch: location or route'
        : result.error_type === 'flow'
          ? 'Environmental mismatch: flow or timing'
          : 'Decision at odds with site conditions';
  const content = result.reason ?? 'Decision details do not match current site conditions.';
  const severity = result.severity === 'high' ? 'high' : 'medium';
  const requiresResponse = result.severity === 'high' || result.severity === 'medium';
  const targetTeams = authorTeamNames.length > 0 ? authorTeamNames : null;
  const injectScope =
    targetTeams && targetTeams.length > 0 ? ('team_specific' as const) : ('universal' as const);

  try {
    const { data: createdInject, error: createError } = await supabaseAdmin
      .from('scenario_injects')
      .insert({
        scenario_id: scenarioId,
        trigger_time_minutes: null,
        trigger_condition: null,
        type: 'field_update',
        title,
        content,
        severity,
        affected_roles: [],
        inject_scope: injectScope,
        target_teams: targetTeams,
        requires_response: requiresResponse,
        requires_coordination: false,
        ai_generated: true,
        triggered_by_user_id: null,
      })
      .select()
      .single();

    if (createError) {
      logger.warn(
        { error: createError, sessionId },
        'Failed to create environmental mismatch inject',
      );
      return;
    }
    if (createdInject) {
      await publishInjectToSession(createdInject.id, sessionId, trainerId, io);
      logger.info(
        {
          sessionId,
          injectId: createdInject.id,
          severity: result.severity,
          error_type: result.error_type,
        },
        'Environmental mismatch inject published',
      );
    }
  } catch (err) {
    logger.warn({ err, sessionId }, 'Error publishing environmental mismatch inject');
  }
}
