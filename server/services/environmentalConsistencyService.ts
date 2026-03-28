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
  /** false when the decision lacks operational specificity (missing locations, ratios, protocols, timelines). */
  specific?: boolean;
  /** Short phrases describing what is missing (e.g. "exit names", "marshal-to-evacuee ratio"). */
  missing_details?: string[];
  /** AI-generated in-world consequence narrative describing what happens because of the decision's shortcomings. */
  feedback?: string;
  /** AI-generated short in-world title for the consequence inject (e.g. "Overcrowding at Assembly North"). */
  consequence_title?: string;
  /** true when the decision proposes a forbidden/dangerous action (e.g. detonating a bomb, attacking people). */
  rejected?: boolean;
  /** In-world explanation of why the forbidden action cannot be carried out. */
  rejection_reason?: string;
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

  // 1b) Exits from scenario_locations (may include exits not in layout_ground_truth)
  const exitLocations = (scenarioLocations ?? []).filter((loc) => loc.location_type === 'exit');
  if (exitLocations.length > 0) {
    const layoutExitLabels = new Set(
      (layout?.exits ?? []).map((e) => (e.label ?? '').toLowerCase()).filter(Boolean),
    );
    const extraExits = exitLocations.filter(
      (loc) => !layoutExitLabels.has((loc.label ?? '').toLowerCase()),
    );
    if (extraExits.length > 0) {
      const extraLines = extraExits.map((loc) => {
        const label = loc.label ?? 'Exit';
        const cond = (loc.conditions ?? {}) as Record<string, unknown>;
        const flowParts: string[] = [];
        if (cond.flow_per_min != null) flowParts.push(`${cond.flow_per_min}/min`);
        if (cond.status) flowParts.push(`[${cond.status}]`);
        if (cond.width_m != null) flowParts.push(`width ${cond.width_m}m`);
        return flowParts.length ? `${label} ${flowParts.join(' ')}` : label;
      });
      parts.push(`Additional exits (from map): ${extraLines.join('; ')}`);
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

  // 7) Entry/exit claims
  const entryExitLocations = (scenarioLocations ?? []).filter((loc) => {
    const cond = (loc.conditions ?? {}) as Record<string, unknown>;
    return cond.pin_category === 'entry_exit';
  });
  if (entryExitLocations.length > 0) {
    const eeParts = entryExitLocations.map((loc) => {
      const label = loc.label ?? 'Point';
      const claimed = (loc as Record<string, unknown>).claimed_by_team;
      const claimedAs = (loc as Record<string, unknown>).claimed_as;
      if (claimed) return `${label}: claimed by ${claimed} as ${claimedAs}`;
      return `${label}: unclaimed`;
    });
    parts.push(`Entry/exit points: ${eeParts.join('; ')}`);
  }

  // 8) Team workflow expectations
  const workflows = insiderKnowledge.team_workflows as
    | Record<
        string,
        { endgame?: string; steps?: string[]; personnel_ratios?: Record<string, string> }
      >
    | undefined;
  if (workflows && Object.keys(workflows).length > 0) {
    const wfParts = Object.entries(workflows).map(([team, wf]) => {
      const stepsStr = wf.steps?.length ? ` Steps: ${wf.steps.join(' → ')}` : '';
      const ratios = wf.personnel_ratios
        ? ` Ratios: ${Object.entries(wf.personnel_ratios)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}`
        : '';
      return `${team}: endgame="${wf.endgame || 'unspecified'}"${stepsStr}${ratios}`;
    });
    parts.push(`Team workflows: ${wfParts.join('; ')}`);
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
  qualityFailureCount?: number,
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

    // Detect hazard-response decisions and load hazard research data
    let hazardStandardsBlock = '';
    const hazardMatch = decision.description.match(/^\[Hazard Response:\s*(.+?)\]/);
    if (hazardMatch) {
      const hazardTypeRaw = hazardMatch[1].trim().replace(/\s+/g, '_').toLowerCase();
      const { data: matchingHazards } = await supabaseAdmin
        .from('scenario_hazards')
        .select(
          'hazard_type, enriched_description, resolution_requirements, personnel_requirements, equipment_requirements, properties',
        )
        .eq('scenario_id', scenarioId)
        .ilike('hazard_type', `%${hazardTypeRaw}%`)
        .limit(3);

      if (matchingHazards?.length) {
        const parts: string[] = [];
        for (const h of matchingHazards) {
          const lines: string[] = [];
          lines.push(`Hazard type: ${(h.hazard_type as string).replace(/_/g, ' ')}`);
          if (h.enriched_description) {
            lines.push(`Situation: ${h.enriched_description}`);
          }
          const reqs = h.resolution_requirements as Record<string, unknown> | null;
          if (reqs && Object.keys(reqs).length > 0) {
            lines.push(`Resolution requirements: ${JSON.stringify(reqs)}`);
          }
          const personnel = h.personnel_requirements as Record<string, unknown> | null;
          if (personnel && Object.keys(personnel).length > 0) {
            lines.push(`Personnel requirements: ${JSON.stringify(personnel)}`);
          }
          const equipment = h.equipment_requirements as unknown[] | null;
          if (equipment && equipment.length > 0) {
            lines.push(`Equipment requirements: ${JSON.stringify(equipment)}`);
          }
          const props = (h.properties ?? {}) as Record<string, unknown>;
          const propEntries = Object.entries(props).filter(
            ([k]) => !['deterioration_stage', 'minutes_unaddressed'].includes(k),
          );
          if (propEntries.length > 0) {
            lines.push(`Properties: ${propEntries.map(([k, v]) => `${k}: ${v}`).join(', ')}`);
          }
          parts.push(lines.join('\n'));
        }
        hazardStandardsBlock = `HAZARD RESPONSE STANDARDS (the player is responding to this hazard — evaluate their response against these requirements):\n${parts.join('\n---\n')}\n\n`;
      }
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

    const systemPrompt = `You are an expert crisis management evaluator. Given a decision (title and description), the scenario's ENVIRONMENT GROUND TRUTH, and any team doctrines/sector standards, evaluate TWO dimensions: (A) ENVIRONMENTAL CONSISTENCY and (B) OPERATIONAL SPECIFICITY.${incidentBlock}

IMPORTANT — HAZARD RESPONSE EVALUATION: When "HAZARD RESPONSE STANDARDS" are provided, the decision is a direct response to a specific hazard. You MUST evaluate whether the proposed response meets the hazard's resolution requirements, personnel requirements, and equipment requirements. A vague or incomplete response that does not specify the correct equipment, personnel, approach method, or containment procedure should be marked specific: false. A response that proposes incorrect equipment or procedures for the hazard type (e.g. water on a Class B fire) should be marked consistent: false with mismatch_kind "contradiction".

=== (A) ENVIRONMENTAL CONSISTENCY ===
Determine if the decision's details are consistent with the environment.

Rules:
- consistent: true if the decision does not contradict the ground truth and (when sector standards exist) either meets them or uses a pragmatic option that matches ground truth.
- consistent: false only when (a) the decision contradicts ground truth, or (b) the decision is clearly dangerous (e.g. capacity a small fraction of need with no mitigation). Do NOT set consistent false merely for being below a sector standard (e.g. 125% evacuee capacity) when the decision correctly uses an existing area and the shortfall is a realistic constraint.
- Contradiction: Use mismatch_kind "contradiction" ONLY when the decision explicitly states a fact about a specific location, exit, or route that differs from ground truth (e.g. "North has capacity 200" when ground truth says 50; "use Exit X" when X does not exist). Do NOT infer a stated fact from other numbers in the text (e.g. "1000 evacuees" or "100" elsewhere); only attribute a capacity or location claim to a place if the decision clearly assigns that number to that place.
- Below_standard: Use mismatch_kind "below_standard" when the decision uses correct names and capacities from ground truth but total capacity is below evacuee count or sector standard, or when the decision describes mitigation (waves, overflow, staging) without claiming total capacity is adequate. Do NOT treat "using available areas and managing in waves/overflow" as claiming adequate capacity; treat shortfall as below_standard.
- Do not invent contradictions: If the decision correctly states a capacity for a location (e.g. "Vacant Lot E standing capacity 500" and ground truth says Lot E has standing 500), set consistent: true. Only set contradiction if the decision states a different number for that location (e.g. "Lot E has 100 lying" when ground truth says Lot E has 50 lying).
- severity: "low" = minor (e.g. 60 in 50-capacity area); "medium" = clear contradiction (e.g. wrong exit, 100 in 50); "high" = dangerous/impossible (e.g. 200 in 50, non-existent exit). For below_standard use "low" or "medium" only. NEVER combine severity "high" with mismatch_kind "below_standard".
- error_type: "capacity" | "location" | "flow" | "other" (if consistent is false).
- reason: when consistent is false, write the reason as an IN-WORLD CONSEQUENCE — describe what is happening on the ground as a result of the decision, following the ESCALATION LEVEL provided in the user prompt. Do NOT tell the player what they should have done or what is wrong with their plan. Describe only what is unfolding:
  - ESCALATION 0: minor operational friction (e.g. "Evacuees are spilling out of the north assembly area — capacity has been exceeded. Volunteers are struggling to manage the overflow.").
  - ESCALATION 1: significant in-world problem (e.g. "A crush incident is developing at Assembly North. Several elderly evacuees have fallen and are being trampled. Medical teams are being called.").
  - ESCALATION 2+: critical in-world damage (e.g. "Multiple casualties confirmed at the overcrowded assembly area. Emergency services cannot reach the injured through the crowd. The evacuation corridor has collapsed."). Be severe and scenario-specific.
- consequence_title: when consistent is false, provide a short (3-8 word) in-world event headline for the consequence, as if it were a field report. E.g. "Crush incident at Assembly North", "Wrong exit causing evacuee confusion", "Route blocked by debris". Do NOT use titles like "Decision contradicts ground conditions".
- Routes: If "Current route status" is in the ground truth, use it. If the decision uses a route that is congested, blocked, or unmanaged without proposing to manage/clear it first, set consistent: false with appropriate severity and error_type "flow" or "location". If the decision chooses a significantly slower route when a faster one is available, set consistent: false (or below_standard) with severity and reason.
- route_effect (when the decision is route-related: evacuation, triage, transport, convoy): "clear" = uses a fast/managed route; "slow" = uses a slower or congested route but still valid; "congested" = uses a blocked/unmanaged route or clearly suboptimal. Omit or null when the decision does not involve route choice.

Sector standards (e.g. 125% assembly capacity, triage ratios) are best-practice targets, not absolute requirements. Only use them to set consistent false when the decision also contradicts ground truth or is clearly dangerous. If the decision correctly uses a real area/capacity from ground truth but that capacity is below the standard, set mismatch_kind "below_standard" and severity "low" or "medium".

CRITICAL: If a location EXISTS in ground truth and the decision uses its CORRECT capacity but that capacity is insufficient for the need, that is ALWAYS "below_standard", NEVER "contradiction". "contradiction" is reserved for factual errors (wrong numbers, non-existent locations).

=== (B) OPERATIONAL SPECIFICITY ===
Evaluate whether this decision is OPERATIONALLY SPECIFIC enough to be executed on the ground. A decision must name concrete details relevant to the team's role and the doctrines/standards provided.

Specificity requirements by team role:
- Evacuation: specific exit names/IDs, flow control method, marshal-to-evacuee ratios, staging/assembly areas, ground zero perimeter distance, phased evacuation order if applicable
- Triage: named triage zones/areas, triage protocol (e.g. START, SALT, Triage Sieve), staff-to-patient ratios, casualty categorisation zones (Red/Yellow/Green), transport priorities and destination hospitals
- Media: named spokesperson, statement content or key messages, press conference location or channel, information update frequency, misinformation rebuttal points

If sector standards or team doctrines are provided, the decision MUST address the key thresholds and requirements they specify. A decision that gives correct general instructions but omits the operational specifics listed above is NOT specific.

Set "specific": false when the decision gives general/vague instructions without naming the concrete details above. Set "specific": true when the decision names enough specifics to be executed without further clarification.

CRITICAL RULE: Do NOT tell the player what is missing, what they should have done, or what details are needed. Instead, describe the IN-WORLD CONSEQUENCE of their vague orders — what is happening on the ground because the orders lacked specifics.

When "specific" is false, the "feedback" MUST be an in-world consequence narrative matching the ESCALATION LEVEL:
- ESCALATION 0 (first offence): minor friction from unclear orders. E.g. "Evacuees are scattered across multiple exits with no marshals directing flow. A bottleneck has formed at the main gate and stretcher teams cannot get through." Use the scenario's actual locations and constraints.
- ESCALATION 1 (second offence): significant in-world problem. E.g. "Without clear prioritisation, a walking wounded patient was treated ahead of a critical bleed case. The critical patient's condition has deteriorated rapidly and field medics are calling for guidance." Be scenario-specific.
- ESCALATION 2+ (third offence onward): critical in-world damage. E.g. "The continued lack of structured direction has led to preventable deaths. Field teams are demoralised and some volunteers have walked off." Be severe and scenario-specific.

When "specific" is false:
- "missing_details": array of 2-5 short phrases naming what is missing internally (e.g. ["exit names and IDs", "marshal-to-evacuee ratio"]). These are for internal scoring only and will NOT be shown to the player.
- "feedback": one paragraph (2-4 sentences) — an in-world consequence narrative. Describe what IS happening, not what SHOULD happen. Reference the actual scenario environment — do NOT be generic.
- "consequence_title": a short (3-8 word) in-world event title for this consequence, as if it were a field report headline. E.g. "Bottleneck forming at main gate", "Triage delays causing patient deterioration", "No power at forward treatment site". Do NOT use titles like "Missing details" or "Operational detail needed".

=== (C) SAFETY GUARDRAILS ===
Certain actions are ABSOLUTELY FORBIDDEN regardless of context. If the decision proposes any of these, set "rejected": true with a "rejection_reason" and skip sections A and B entirely.

FORBIDDEN ACTIONS:
- Directly handling, detonating, disarming, or triggering explosive devices (players must call bomb disposal / EOD teams, not handle ordnance themselves)
- Intentionally causing harm to people (attacking, shooting, assaulting individuals)
- Ordering emergency services to stand down, withdraw, or leave without authorisation
- Actions that deliberately endanger civilians (e.g. herding people toward a known blast zone, opening cordons into hazardous areas)
- Impersonating emergency services or claiming authority the team does not possess (e.g. "we are the police")

If the decision describes contacting or requesting bomb disposal teams, EOD, SPF, or SCDF to handle a suspicious device, that is ALLOWED and should NOT be rejected.

When "rejected" is true, set "rejection_reason" to an in-world explanation of why the action cannot be carried out (e.g. "C2E committee members do not have the authority or capability to handle explosive ordnance. Contact the bomb disposal unit via 995/SPF and establish a cordon."). Set consistent: false, severity: "high", specific: false.

=== OUTPUT FORMAT ===

Return ONLY valid JSON:
{
  "rejected": boolean (true ONLY if a forbidden action was proposed; omit or false otherwise),
  "rejection_reason": "..." (only if rejected is true),
  "consistent": boolean,
  "mismatch_kind": "contradiction"|"below_standard" (only if consistent is false),
  "severity": "low"|"medium"|"high" (only if consistent is false),
  "error_type": "capacity"|"location"|"flow"|"other" (only if consistent is false),
  "reason": "..." (only if consistent is false — in-world consequence, NOT an explanation of what went wrong),
  "consequence_title": "..." (short in-world event headline when consistent is false OR specific is false),
  "route_effect": "clear"|"slow"|"congested"|null (when decision is route-related),
  "specific": boolean,
  "missing_details": ["..."] (only if specific is false — internal use, NOT shown to player),
  "feedback": "..." (only if specific is false — in-world consequence narrative, NOT instructions)
}`;

    const incidentUserBlock =
      incident?.title != null || incident?.description != null
        ? `\nINCIDENT (this decision is in response to):\nTitle: ${incident.title ?? ''}\nDescription: ${incident.description ?? ''}\n\n`
        : '';

    const sectorStandardsLine = sectorStandards
      ? `Sector standards (if any): ${sectorStandards}\n\n`
      : '';
    const teamRoleLine = teamName ? `TEAM ROLE: ${teamName}\n\n` : '';
    const escalationLevel = qualityFailureCount ?? 0;
    const escalationLine = `ESCALATION LEVEL: ${escalationLevel} (${escalationLevel === 0 ? 'first offence — minor operational friction' : escalationLevel === 1 ? 'second offence — significant in-world problems' : 'third+ offence — critical in-world damage and casualties'})\n\n`;
    const userPrompt = `ENVIRONMENT GROUND TRUTH: ${groundTruthSummary}

${hazardStandardsBlock}${sectorStandardsLine}${teamRoleLine}${escalationLine}${incidentUserBlock}DECISION:
Title: ${decision.title}
Description: ${decision.description}

Evaluate ALL THREE dimensions — apply the ESCALATION LEVEL above to ALL output. ALL "reason" and "feedback" text must be IN-WORLD CONSEQUENCES only. NEVER tell the player what is wrong, what they should do, or what is missing. Describe only what is happening on the ground as a result:
(C) SAFETY GUARDRAILS: First check — does this decision propose a forbidden action? If yes, set rejected: true with rejection_reason and skip A and B.
(A) CONSISTENCY: Only treat as contradiction if the decision explicitly states a specific fact that contradicts the ground truth for that place or route; otherwise prefer consistent or below_standard. When consistent is false, write "reason" as an in-world consequence of the error (NOT an explanation). Also provide a "consequence_title" (short field-report headline).
(B) SPECIFICITY: Does this decision contain enough operational detail (named locations, quantities, ratios, protocols, timelines) to be executed on-scene? Apply the specificity requirements for the TEAM ROLE specified above. If it gives general instructions without concrete specifics, set specific: false with missing_details (internal), feedback (in-world consequence), and consequence_title (field-report headline).

Return JSON only.`;

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
        max_tokens: 1024,
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
      consequence_title?: string;
      route_effect?: string | null;
      specific?: boolean;
      missing_details?: string[];
      feedback?: string;
    };

    const routeEffect =
      parsed.route_effect === 'clear' ||
      parsed.route_effect === 'slow' ||
      parsed.route_effect === 'congested'
        ? (parsed.route_effect as RouteEffect)
        : undefined;

    const specific = parsed.specific !== false;
    const missing_details = Array.isArray(parsed.missing_details)
      ? (parsed.missing_details as unknown[]).filter((d): d is string => typeof d === 'string')
      : [];
    const feedback =
      typeof parsed.feedback === 'string' && parsed.feedback.trim()
        ? parsed.feedback.trim()
        : undefined;
    const consequence_title =
      typeof parsed.consequence_title === 'string' && parsed.consequence_title.trim()
        ? parsed.consequence_title.trim()
        : undefined;

    const consistent = parsed.consistent === true;
    if (consistent) {
      return {
        consistent: true,
        route_effect: routeEffect ?? null,
        specific,
        missing_details: specific ? undefined : missing_details,
        feedback: specific ? undefined : feedback,
        consequence_title: specific ? undefined : consequence_title,
      };
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
      consequence_title: consequence_title ?? undefined,
      route_effect: routeEffect ?? null,
      specific,
      missing_details: specific ? undefined : missing_details,
      feedback: specific ? undefined : feedback,
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
