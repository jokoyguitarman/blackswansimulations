/**
 * Counter Catalog — hardcoded master list of decision flags that the AI
 * evaluator checks every player decision against.
 *
 * Replaces the GPT-generated `_counter_definitions` with a deterministic,
 * scenario-type-tagged catalog.  Live numeric counters (patients triaged,
 * fires active, etc.) remain in `liveCounterService.ts`; this file only
 * defines decision-driven boolean toggles and numeric increments.
 *
 * Each entry is tagged with `scenario_types` — either `'all'` (applies
 * everywhere) or a list of scenario-type IDs from the template directory.
 */

export interface CatalogFlag {
  key: string;
  label: string;
  type: 'boolean' | 'number';
  behavior: 'decision_toggle' | 'decision_increment';
  visible_to: 'all' | 'trainer_only';
  scenario_types: 'all' | string[];
}

export interface CatalogEntry {
  stateKey: string;
  teamPattern: RegExp;
  flags: CatalogFlag[];
}

const TERRORISM_TYPES = [
  'bombing',
  'bombing_mall',
  'car_bomb',
  'suicide_bombing',
  'active_shooter',
  'open_field_shooting',
  'knife_attack',
  'vehicle_ramming',
  'gas_attack',
  'arson',
  'infrastructure_attack',
];

const BOMB_TYPES = ['bombing', 'bombing_mall', 'car_bomb', 'suicide_bombing'];

export const COUNTER_CATALOG: CatalogEntry[] = [
  // ── Evacuation ──────────────────────────────────────────────
  {
    stateKey: 'evacuation_state',
    teamPattern: /evacuation|evac/i,
    flags: [
      {
        key: 'zone_identification_decided',
        label: 'Zone Identification',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'trainer_only',
        scenario_types: 'all',
      },
      {
        key: 'flow_control_decided',
        label: 'Flow Control Established',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'all',
        scenario_types: 'all',
      },
      {
        key: 'marshals_deployed',
        label: 'Marshals / Stewards Deployed',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'all',
        scenario_types: 'all',
      },
      {
        key: 'coordination_with_triage',
        label: 'Coordination with Triage',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'trainer_only',
        scenario_types: 'all',
      },
      {
        key: 'assembly_point_established',
        label: 'Assembly Point Established',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'all',
        scenario_types: 'all',
      },
      {
        key: 'evacuation_routes_announced',
        label: 'Evacuation Routes Announced',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'all',
        scenario_types: 'all',
      },
      {
        key: 'special_needs_plan',
        label: 'Special Needs Considered',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'trainer_only',
        scenario_types: 'all',
      },
    ],
  },

  // ── Medical Triage ──────────────────────────────────────────
  {
    stateKey: 'triage_state',
    teamPattern: /triage|medical/i,
    flags: [
      {
        key: 'prioritisation_decided',
        label: 'Triage Prioritisation Set',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'trainer_only',
        scenario_types: 'all',
      },
      {
        key: 'supply_request_made',
        label: 'Supply Request Made',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'trainer_only',
        scenario_types: 'all',
      },
      {
        key: 'triage_zone_established',
        label: 'Triage Zone Established',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'all',
        scenario_types: 'all',
      },
      {
        key: 'patient_privacy_decided',
        label: 'Patient Privacy Managed',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'trainer_only',
        scenario_types: 'all',
      },
      {
        key: 'perimeter_security_decided',
        label: 'Triage Perimeter Security',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'trainer_only',
        scenario_types: 'all',
      },
      {
        key: 'mass_casualty_declared',
        label: 'Mass Casualty Declared',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'all',
        scenario_types: TERRORISM_TYPES,
      },
      {
        key: 'hospital_coordination',
        label: 'Hospital Coordination Initiated',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'all',
        scenario_types: 'all',
      },
    ],
  },

  // ── Fire / Rescue ───────────────────────────────────────────
  {
    stateKey: 'fire_rescue_state',
    teamPattern: /fire|hazmat|hazard|rescue/i,
    flags: [
      {
        key: 'hot_zone_declared',
        label: 'Hot Zone Declared',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'all',
        scenario_types: 'all',
      },
      {
        key: 'warm_zone_established',
        label: 'Warm Zone Established',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'all',
        scenario_types: 'all',
      },
      {
        key: 'cold_zone_established',
        label: 'Cold Zone Established',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'all',
        scenario_types: 'all',
      },
      {
        key: 'sar_initiated',
        label: 'Search & Rescue Initiated',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'all',
        scenario_types: 'all',
      },
      {
        key: 'structural_assessment_requested',
        label: 'Structural Assessment Requested',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'trainer_only',
        scenario_types: ['bombing', 'bombing_mall', 'infrastructure_attack', 'car_bomb'],
      },
      {
        key: 'hazmat_containment_started',
        label: 'HAZMAT Containment Started',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'all',
        scenario_types: ['gas_attack', 'biohazard', 'nuclear_plant_leak', 'poisoning'],
      },
      {
        key: 'ventilation_managed',
        label: 'Ventilation Managed',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'trainer_only',
        scenario_types: ['gas_attack', 'arson', 'bombing_mall'],
      },
    ],
  },

  // ── Bomb Squad / EOD ────────────────────────────────────────
  {
    stateKey: 'bomb_squad_state',
    teamPattern: /bomb|eod|explosive/i,
    flags: [
      {
        key: 'secondary_sweep_complete',
        label: 'Secondary Device Sweep Complete',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'all',
        scenario_types: BOMB_TYPES,
      },
      {
        key: 'exclusion_zone_established',
        label: 'Exclusion Zone Established',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'all',
        scenario_types: BOMB_TYPES,
      },
      {
        key: 'render_safe_started',
        label: 'Render-Safe Procedure Started',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'all',
        scenario_types: BOMB_TYPES,
      },
      {
        key: 'forensic_evidence_preserved',
        label: 'Forensic Evidence Preserved',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'trainer_only',
        scenario_types: BOMB_TYPES,
      },
    ],
  },

  // ── Media & Communications ──────────────────────────────────
  {
    stateKey: 'media_state',
    teamPattern: /media|communi/i,
    flags: [
      {
        key: 'first_statement_issued',
        label: 'First Statement Issued',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'all',
        scenario_types: 'all',
      },
      {
        key: 'spokesperson_designated',
        label: 'Spokesperson Designated',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'all',
        scenario_types: 'all',
      },
      {
        key: 'victim_dignity_respected',
        label: 'Victim Dignity Respected',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'trainer_only',
        scenario_types: 'all',
      },
      {
        key: 'regular_updates_planned',
        label: 'Regular Updates Planned',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'all',
        scenario_types: 'all',
      },
      {
        key: 'press_conference_held',
        label: 'Press Conference Held',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'all',
        scenario_types: 'all',
      },
      {
        key: 'camera_placement_decided',
        label: 'Camera Placement Decided',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'all',
        scenario_types: 'all',
      },
      {
        key: 'media_holding_area_established',
        label: 'Media Holding Area Established',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'all',
        scenario_types: 'all',
      },
      {
        key: 'social_media_monitoring',
        label: 'Social Media Monitoring',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'trainer_only',
        scenario_types: 'all',
      },
      {
        key: 'statements_issued',
        label: 'Statements Issued',
        type: 'number',
        behavior: 'decision_increment',
        visible_to: 'all',
        scenario_types: 'all',
      },
      {
        key: 'misinformation_addressed_count',
        label: 'Misinformation Addressed',
        type: 'number',
        behavior: 'decision_increment',
        visible_to: 'all',
        scenario_types: 'all',
      },
      {
        key: 'content_drafts_submitted',
        label: 'Content Drafts Submitted',
        type: 'number',
        behavior: 'decision_increment',
        visible_to: 'all',
        scenario_types: 'all',
      },
    ],
  },

  // ── Pursuit / Investigation ─────────────────────────────────
  {
    stateKey: 'pursuit_state',
    teamPattern: /pursuit|investigation|police|intelligence/i,
    flags: [
      {
        key: 'suspect_localised',
        label: 'Suspect Localised',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'all',
        scenario_types: TERRORISM_TYPES,
      },
      {
        key: 'perimeter_established',
        label: 'Containment Perimeter',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'all',
        scenario_types: TERRORISM_TYPES,
      },
      {
        key: 'cctv_reviewed',
        label: 'CCTV Reviewed',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'trainer_only',
        scenario_types: 'all',
      },
      {
        key: 'witness_statements_collected',
        label: 'Witness Statements Collected',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'trainer_only',
        scenario_types: 'all',
      },
      {
        key: 'intel_shared_with_teams',
        label: 'Intel Shared with Teams',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'trainer_only',
        scenario_types: 'all',
      },
    ],
  },

  // ── Negotiation (hostage/siege scenarios) ───────────────────
  {
    stateKey: 'negotiation_state',
    teamPattern: /negotiat/i,
    flags: [
      {
        key: 'contact_established',
        label: 'Contact Established',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'all',
        scenario_types: ['hostage_siege', 'kidnapping', 'hijacking'],
      },
      {
        key: 'demands_assessed',
        label: 'Demands Assessed',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'trainer_only',
        scenario_types: ['hostage_siege', 'kidnapping', 'hijacking'],
      },
      {
        key: 'rapport_building',
        label: 'Rapport Building Started',
        type: 'boolean',
        behavior: 'decision_toggle',
        visible_to: 'trainer_only',
        scenario_types: ['hostage_siege', 'kidnapping', 'hijacking'],
      },
    ],
  },
];

/**
 * Return the subset of catalog flags relevant to a set of team names
 * and optionally filtered by scenario type.
 */
export function getFlagsForTeams(
  teamNames: string[],
  scenarioType?: string | null,
): { stateKey: string; flags: CatalogFlag[] }[] {
  const result: { stateKey: string; flags: CatalogFlag[] }[] = [];

  for (const entry of COUNTER_CATALOG) {
    const matches = teamNames.some((t) => entry.teamPattern.test(t));
    if (!matches) continue;

    const filtered = entry.flags.filter((f) => {
      if (f.scenario_types === 'all') return true;
      if (!scenarioType) return true;
      return f.scenario_types.includes(scenarioType);
    });

    if (filtered.length > 0) {
      result.push({ stateKey: entry.stateKey, flags: filtered });
    }
  }

  return result;
}

/**
 * Convert catalog flags into the StateKeyCandidate shape expected by
 * `evaluateStateKeysWithAI()`.
 */
export function catalogFlagsToCandidates(
  entries: { stateKey: string; flags: CatalogFlag[] }[],
): Array<{
  key: string;
  label: string;
  behavior: string;
  type: string;
  stateKey: string;
}> {
  const candidates: Array<{
    key: string;
    label: string;
    behavior: string;
    type: string;
    stateKey: string;
  }> = [];

  for (const { stateKey, flags } of entries) {
    for (const flag of flags) {
      candidates.push({
        key: flag.key,
        label: flag.label,
        behavior: flag.behavior,
        type: flag.type,
        stateKey,
      });
    }
  }

  return candidates;
}
