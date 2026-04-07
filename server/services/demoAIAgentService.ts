import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import {
  getWebSocketService,
  type WebSocketEvent,
  type InternalEventHandler,
} from './websocketService.js';
import { DemoActionDispatcher, resolveBotUserId } from './demoActionDispatcher.js';
import { performSweep } from './bombSquadSweepService.js';
import { resolveScenarioCenter } from './scenarioCenterService.js';
import { haversineM, pointInPolygon } from './geoUtils.js';
import {
  generateStudGrids,
  snapCoordinate,
  getOccupiedStudIds,
  getCachedGrids,
  setCachedGrids,
} from './buildingStudService.js';
import type { OsmBuilding } from './osmVicinityService.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AIDifficultyLevel = 'novice' | 'intermediate' | 'advanced';

interface AgentPersona {
  botUserId: string;
  teamName: string;
  fullName: string;
  roleName: string;
  agencyName: string;
  teamDescription: string;
  doctrines: string;
}

interface AgentState {
  persona: AgentPersona;
  recentActions: string[];
  lastActionTs: number;
  pendingCooldown: boolean;
  actedThisCycle: boolean;
  lastActionWasPinResponse: boolean;
}

interface SessionAgents {
  sessionId: string;
  scenarioId: string;
  scenarioSummary: string;
  sectorStandards: string;
  incidentCenter: { lat: number; lng: number } | null;
  startedAt: number;
  agents: Map<string, AgentState>;
  channelId: string | null;
  eventHandler: InternalEventHandler;
  channelHandlers: Map<string, InternalEventHandler>;
  proactiveTimer: ReturnType<typeof setInterval> | null;
  scriptAware: boolean;
  scriptNextEventTs: number;
  stopped: boolean;
  cycleDecisionCount: number;
  lastInjectTs: number;
  difficulty: AIDifficultyLevel;
}

interface SingleAction {
  action: 'decision' | 'placement' | 'chat' | 'claim' | 'pin_response' | 'sweep_asset' | 'none';
  decision?: { title: string; description: string };
  placement?: {
    asset_type: string;
    label: string;
    geometry: { type: string; coordinates: unknown };
    properties?: Record<string, unknown>;
  };
  chat?: { content: string };
  claim?: {
    location_label: string;
    claimed_as: string;
    exclusivity?: string;
  };
  pin_response?: {
    target_id: string;
    target_type: 'casualty' | 'hazard';
    target_label: string;
    actions: string[];
    resources: Array<{ type: string; label: string; quantity: number }>;
    triage_color?: 'green' | 'yellow' | 'red' | 'black';
    description: string;
  };
  sweep_asset?: {
    asset_id: string;
    asset_label: string;
  };
}

interface AgentMultiResponse {
  actions: SingleAction[];
  reasoning?: string;
}

// ---------------------------------------------------------------------------
// Constants — tuned for realistic human-like pacing
// ---------------------------------------------------------------------------

const AGENT_THROTTLE_MS = 120_000; // 2 min cooldown per agent after acting
const AGENT_THROTTLE_PIN_MS = 45_000; // 45s cooldown after a pin_response (fast patient throughput)
const AGENT_THROTTLE_EARLY_MS = 60_000; // 60s cooldown during foundational phase (first 5 min)
const FOUNDATIONAL_PHASE_MINUTES = 5; // first N minutes: claiming exits and first infrastructure
const INTER_ACTION_BASE_MS = 3_000;
const INTER_ACTION_RANGE_MS = 3_000;
const HYBRID_DEFER_WINDOW_MS = 10_000;
const MAX_RECENT_ACTIONS = 15;
const AI_MODEL = 'gpt-4o-mini';
const MAX_VALIDATION_RETRIES = 2;
const PROACTIVE_INTERVAL_MS = 60_000; // 1 min between proactive ticks
const PROACTIVE_ACT_PROBABILITY = 0.85; // 85% chance per agent per tick (high throughput)
const PROACTIVE_ACT_PROBABILITY_EARLY = 0.95; // 95% during foundational phase
const KICKSTART_STAGGER_MS = 15_000; // 15s between kickstart agents
const KICKSTART_INITIAL_DELAY_MS = 8_000;
const INTER_AGENT_DELAY_MS = 6_000; // 6s stagger between sequential agent decisions
const INJECT_CYCLE_RESET_MS = 120_000; // auto-reset cycle budget after 2 min

// ---------------------------------------------------------------------------
// Action Classification — the "classify-first" step that determines what
// format/template the bot should use, preventing infrastructure spam and
// ensuring bots prioritise their core responsibilities.
// ---------------------------------------------------------------------------

type ActionClass =
  | 'claim_exit'
  | 'place_infrastructure'
  | 'patient_response'
  | 'hazard_response'
  | 'crowd_response'
  | 'sweep_asset'
  | 'inject_situational'
  | 'inject_stakeholder'
  | 'inject_media'
  | 'proactive_pin'
  | 'none';

interface ClassificationResult {
  actionClass: ActionClass;
  reason: string;
  targetPinId?: string;
  targetPinLabel?: string;
}

async function classifyActionRequired(
  teamKey: string,
  triggerEvent: WebSocketEvent,
  groundContext: {
    unclaimedExits: number;
    infrastructureComplete: boolean;
    pendingPatients: Array<{ id: string; label: string; status: string }>;
    pendingHazards: Array<{ id: string; label: string; status: string }>;
    pendingCrowds: Array<{ id: string; label: string; status: string }>;
    elapsedMinutes: number;
    infrastructurePendingCount: number;
  },
): Promise<ClassificationResult> {
  const isProactive =
    triggerEvent.type === 'proactive.tick' || triggerEvent.type === 'session.started';
  const injectText =
    !isProactive && triggerEvent.data ? JSON.stringify(triggerEvent.data).slice(0, 600) : '';

  // Phase 1: First 5 minutes — claim exits if any remain
  if (
    groundContext.elapsedMinutes < FOUNDATIONAL_PHASE_MINUTES &&
    groundContext.unclaimedExits > 0
  ) {
    return { actionClass: 'claim_exit', reason: 'Unclaimed exits available during startup' };
  }

  // Phase 1b: During startup, allow one infrastructure placement if exits are done
  if (
    groundContext.elapsedMinutes < FOUNDATIONAL_PHASE_MINUTES &&
    !groundContext.infrastructureComplete &&
    groundContext.unclaimedExits === 0 &&
    groundContext.infrastructurePendingCount > 0
  ) {
    return {
      actionClass: 'place_infrastructure',
      reason: 'First infrastructure item during startup phase',
    };
  }

  // If an inject is pending (not proactive), classify it
  if (!isProactive && injectText) {
    const classification = await classifyInjectWithAI(teamKey, injectText);

    // Post-classification jurisdiction guard: if the AI classifier returned an
    // action class outside this team's pin jurisdiction, remap to inject_situational
    // so the bot writes a domain-appropriate decision instead of attempting pin ops.
    const pinJurisdiction = TEAM_ALLOWED_PIN_TYPES[teamKey];
    const isPinClass =
      classification.actionClass === 'patient_response' ||
      classification.actionClass === 'hazard_response' ||
      classification.actionClass === 'crowd_response';
    if (isPinClass && !pinJurisdiction) {
      return {
        actionClass: 'inject_situational',
        reason: `Remapped from ${classification.actionClass}: ${teamKey} team has no pin jurisdiction — respond within your domain`,
      };
    }
    if (classification.actionClass === 'patient_response' && !pinJurisdiction?.has('casualty')) {
      return {
        actionClass: 'inject_situational',
        reason: `Remapped from patient_response: ${teamKey} team cannot interact with casualty pins — respond within your domain`,
      };
    }
    if (classification.actionClass === 'hazard_response' && !pinJurisdiction?.has('hazard')) {
      return {
        actionClass: 'inject_situational',
        reason: `Remapped from hazard_response: ${teamKey} team cannot interact with hazard pins — respond within your domain`,
      };
    }
    if (classification.actionClass === 'crowd_response' && !pinJurisdiction?.has('crowd')) {
      return {
        actionClass: 'inject_situational',
        reason: `Remapped from crowd_response: ${teamKey} team cannot interact with crowd pins — respond within your domain`,
      };
    }

    return classification;
  }

  // Patient and hazard pins are now handled deterministically by
  // injectSchedulerService.checkPatientQueue() and checkHazardQueue() —
  // no LLM classification needed for those. Only crowd pins remain here.
  const allowedPinTypes = TEAM_ALLOWED_PIN_TYPES[teamKey];
  if (allowedPinTypes) {
    if (allowedPinTypes.has('crowd') && groundContext.pendingCrowds.length > 0) {
      const target = groundContext.pendingCrowds[0];
      return {
        actionClass: 'crowd_response',
        reason: `Crowd needing direction: ${target.label}`,
        targetPinId: target.id,
        targetPinLabel: target.label,
      };
    }
  }

  // If infrastructure is still pending and no urgent pins, allow building
  if (!groundContext.infrastructureComplete && groundContext.infrastructurePendingCount > 0) {
    return {
      actionClass: 'place_infrastructure',
      reason: 'No urgent pins — continue building operating area',
    };
  }

  // Sweeps are handled deterministically by injectSchedulerService.checkSweepQueue()
  // — no LLM classification needed.

  return { actionClass: 'none', reason: 'Nothing actionable for this team right now' };
}

async function classifyInjectWithAI(
  teamKey: string,
  injectText: string,
): Promise<ClassificationResult> {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.openAiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 200,
        messages: [
          {
            role: 'system',
            content: `You classify crisis-exercise injects for the "${teamKey}" team.
Return JSON: { "actionClass": "<class>", "reason": "<one-line>" }

Classes:
- "patient_response" — inject describes an injured/sick person needing medical attention
- "hazard_response" — inject describes a fire, spill, explosion, structural collapse, or other hazard
- "crowd_response" — inject describes a crowd, evacuee group, or people needing direction
- "inject_media" — inject is about media activity, press, public statement, or communications
- "inject_stakeholder" — inject is about VIPs, diplomats, officials, government, families, religious leaders
- "inject_situational" — inject is about weather, intelligence, resource updates, operational changes
- "place_infrastructure" — inject explicitly says infrastructure is missing or needs establishment
- "none" — inject does not require action from this team

Rules:
- Media/journalists approaching are NOT casualties — classify as "inject_media" or "inject_situational"
- Bystanders filming/watching are NOT casualties — classify as "inject_situational"
- Diplomatic demands are "inject_stakeholder" NOT "patient_response"
- Only classify as "patient_response" if the inject describes actual physical injury or illness`,
          },
          { role: 'user', content: injectText },
        ],
      }),
    });
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content ?? '';
    const cleaned = raw
      .replace(/```json\s*/g, '')
      .replace(/```/g, '')
      .trim();
    const parsed = JSON.parse(cleaned) as { actionClass: string; reason: string };
    const validClasses: ActionClass[] = [
      'patient_response',
      'hazard_response',
      'crowd_response',
      'inject_media',
      'inject_stakeholder',
      'inject_situational',
      'place_infrastructure',
      'none',
    ];
    if (validClasses.includes(parsed.actionClass as ActionClass)) {
      return {
        actionClass: parsed.actionClass as ActionClass,
        reason: parsed.reason || 'AI classified',
      };
    }
    return {
      actionClass: 'inject_situational',
      reason: parsed.reason || 'Fallback classification',
    };
  } catch (err) {
    logger.warn({ err }, 'Inject classification AI call failed, falling back to situational');
    return { actionClass: 'inject_situational', reason: 'Classification failed — default' };
  }
}

// ---------------------------------------------------------------------------
// Hardcoded team scope — what each team is allowed to place / respond to.
// Keys are matched via .includes() against the lowercased team name.
// ---------------------------------------------------------------------------

const TEAM_ALLOWED_PLACEMENTS: Record<string, Set<string>> = {
  evacuation: new Set([
    'command_post',
    'inner_cordon',
    'outer_cordon',
    'roadblock',
    'observation_post',
    'hot_zone',
    'warm_zone',
    'cold_zone',
    'staging_area',
    'forward_command',
    'assembly_point',
    'marshal_post',
  ]),
  fire: new Set([
    'fire_truck',
    'water_supply',
    'forward_command',
    'hot_zone',
    'warm_zone',
    'cold_zone',
    'decontamination_zone',
    'staging_area',
    'command_post',
    'exclusion_zone',
    'inner_cordon',
  ]),
  triage: new Set([
    'triage_point',
    'field_hospital',
    'casualty_collection',
    'ambulance_staging',
    'helicopter_lz',
    'command_post',
    'inner_cordon',
  ]),
  media: new Set(['press_cordon', 'media_staging']),
  pursuit: new Set(['observation_post', 'command_post', 'staging_area']),
  bomb_squad: new Set(['exclusion_zone', 'staging_area', 'command_post']),
};

const TEAM_ALLOWED_PIN_TYPES: Record<string, Set<string>> = {
  triage: new Set(['casualty']),
  fire: new Set(['hazard', 'casualty']),
  evacuation: new Set(['crowd']),
  bomb_squad: new Set(['hazard']),
};

const EXTRACT_ONLY_TEAMS = new Set(['fire']);

// ---------------------------------------------------------------------------
// Operating Area Blueprint — standards-compliant site layout with capacity,
// personnel, and equipment requirements scaled to the scenario.
// ---------------------------------------------------------------------------

interface BlueprintItem {
  id: string;
  asset_type: string;
  label: string;
  geometry_type: 'point' | 'polygon';
  zone: 'hot' | 'warm' | 'cold' | 'boundary';
  radius_deg?: number;
  placement_hint: string; // where relative to incident center / zones
  personnel: Array<{ role: string; count: number; ppe?: string }>;
  equipment: string[];
  capacity?: number;
  description: string; // what the bot should say when placing this
  priority: number; // 1 = must place first, 2 = second, etc.
}

interface OperatingAreaBlueprint {
  team: string;
  items: BlueprintItem[];
  layout_rationale: string;
}

interface ScenarioMetrics {
  totalCasualties: number;
  totalCrowdSize: number;
  casualtyClusters: Array<{ lat: number; lng: number; count: number; zone: string }>;
  hazardCount: number;
  exitCount: number;
  exitLocations: Array<{ label: string; lat: number; lng: number }>;
  incidentCenter: { lat: number; lng: number };
  hotZoneRadius: number;
  warmZoneRadius: number;
  coldZoneRadius: number;
}

function generateTeamBlueprint(teamKey: string, metrics: ScenarioMetrics): OperatingAreaBlueprint {
  const c = metrics.incidentCenter;
  const items: BlueprintItem[] = [];

  switch (teamKey) {
    case 'triage': {
      const triagePointCount = Math.max(1, Math.ceil(metrics.totalCasualties / 15));
      const nursesPer = Math.max(2, Math.ceil(metrics.totalCasualties / triagePointCount / 5));
      const clusters =
        metrics.casualtyClusters.length > 0
          ? metrics.casualtyClusters
          : [{ lat: c.lat, lng: c.lng, count: metrics.totalCasualties, zone: 'warm' }];

      // 1. Triage station(s) FIRST — core sorting point before anything else
      for (let i = 0; i < triagePointCount; i++) {
        const patientsServed = Math.ceil(metrics.totalCasualties / triagePointCount);
        items.push({
          id: `triage_point_${i + 1}`,
          asset_type: 'triage_point',
          label: `Triage Station ${triagePointCount > 1 ? String.fromCharCode(65 + i) : ''}`.trim(),
          geometry_type: 'point',
          zone: 'warm',
          placement_hint:
            i === 0
              ? `Warm zone, offset ~80m from incident center, accessible for stretcher relay from hot zone`
              : `Warm zone, near secondary exit or casualty cluster, spaced from Triage Station A`,
          personnel: [
            {
              role: 'Triage Officer (START-certified)',
              count: 1,
              ppe: 'gloves, safety vest, N95 mask',
            },
            { role: 'Triage Nurse', count: nursesPer, ppe: 'gloves, safety vest, N95 mask' },
            {
              role: 'Triage Assistant',
              count: Math.max(1, Math.ceil(nursesPer / 2)),
              ppe: 'gloves, safety vest',
            },
          ],
          equipment: [
            `${patientsServed * 2} triage tags (START system)`,
            'trauma shears',
            'pulse oximeters',
            'blood pressure cuffs',
            'stethoscopes',
            `${patientsServed} emergency blankets`,
            'patient tracking board',
            'radio',
          ],
          capacity: patientsServed,
          description: `Triage station using START protocol. Capacity for ~${patientsServed} patients. Triage officer assigns RED/YELLOW/GREEN/BLACK tags and directs patients to appropriate treatment zones.`,
          priority: 1,
        });
      }

      // 2. Casualty Collection Point(s) — buffer at hot/warm boundary feeding into triage
      const ccpCount = Math.max(1, Math.min(clusters.length, 2));
      for (let i = 0; i < ccpCount; i++) {
        const cluster = clusters[i] || clusters[0];
        items.push({
          id: `casualty_collection_${i + 1}`,
          asset_type: 'casualty_collection',
          label:
            `Casualty Collection Point ${ccpCount > 1 ? String.fromCharCode(65 + i) : ''}`.trim(),
          geometry_type: 'point',
          zone: 'boundary',
          placement_hint: `Near hot/warm zone boundary, between incident and Triage Station, close to casualty cluster at [${cluster.lat}, ${cluster.lng}] (~${cluster.count} patients)`,
          personnel: [
            { role: 'Collection Officer', count: 1, ppe: 'helmet, safety vest, gloves' },
            {
              role: 'Stretcher Bearer',
              count: Math.max(2, Math.ceil(cluster.count / 5)),
              ppe: 'helmet, safety vest, gloves',
            },
          ],
          equipment: ['stretchers', 'spine boards', 'blankets', 'patient tracking tags', 'radio'],
          capacity: Math.ceil(cluster.count * 1.2),
          description: `Casualty collection point receiving patients extracted from hot zone. Feeds into Triage Station. Capacity for ~${Math.ceil(cluster.count * 1.2)} patients. Stretcher bearers staged for rapid extraction relay.`,
          priority: 2,
        });
      }

      // 3. Inner cordon around triage area
      items.push({
        id: 'triage_inner_cordon',
        asset_type: 'inner_cordon',
        label: 'Triage Operating Perimeter',
        geometry_type: 'polygon',
        zone: 'warm',
        radius_deg: 0.00015,
        placement_hint: `Circle around the triage station(s), radius ~15m, securing the medical operating area`,
        personnel: [{ role: 'Access Controller', count: 2, ppe: 'high-vis vest' }],
        equipment: ['barrier tape', 'portable barriers', 'access control signage'],
        description:
          'Controlled perimeter around triage area. Only medical personnel and authorized responders permitted inside. Prevents crowd interference with patient care.',
        priority: 3,
      });

      // 4. Treatment zones
      const redCount = Math.max(1, Math.ceil(metrics.totalCasualties * 0.2));
      const yellowCount = Math.max(1, Math.ceil(metrics.totalCasualties * 0.3));

      items.push({
        id: 'treatment_t1',
        asset_type: 'field_hospital',
        label: 'T1 Treatment Zone (Immediate/RED)',
        geometry_type: 'point',
        zone: 'warm',
        placement_hint: `Adjacent to triage station, warm zone — closest to ambulance staging for rapid transport`,
        personnel: [
          {
            role: 'Emergency Physician / Paramedic',
            count: Math.max(1, Math.ceil(redCount / 3)),
            ppe: 'gloves, N95, eye protection, gown',
          },
          {
            role: 'Trauma Nurse',
            count: Math.max(2, Math.ceil(redCount / 2)),
            ppe: 'gloves, N95, eye protection, gown',
          },
        ],
        equipment: [
          'advanced airway kits',
          `${redCount} IV setups with fluids`,
          'tourniquet kits',
          'chest seal kits',
          'portable defibrillators',
          'ventilators (portable)',
          'surgical supplies (emergency)',
          'blood products (if available)',
          'portable monitors',
        ],
        capacity: redCount,
        description: `T1 Immediate treatment zone for RED-tagged critical patients. Staffed for ${redCount} simultaneous critical cases. Full resuscitation capability.`,
        priority: 4,
      });

      items.push({
        id: 'treatment_t2',
        asset_type: 'field_hospital',
        label: 'T2 Treatment Zone (Delayed/YELLOW)',
        geometry_type: 'point',
        zone: 'warm',
        placement_hint: `Adjacent to triage station, warm zone — separate area from T1 to prevent cross-flow`,
        personnel: [
          { role: 'Paramedic', count: Math.max(1, Math.ceil(yellowCount / 5)), ppe: 'gloves, N95' },
          {
            role: 'EMT / Nurse',
            count: Math.max(2, Math.ceil(yellowCount / 4)),
            ppe: 'gloves, N95',
          },
        ],
        equipment: [
          `${yellowCount} splint sets`,
          `${yellowCount} wound dressing kits`,
          'IV setups',
          'pain management supplies',
          'portable monitors',
          'blankets',
        ],
        capacity: yellowCount,
        description: `T2 Delayed treatment zone for YELLOW-tagged patients with non-life-threatening but significant injuries. Capacity for ${yellowCount} patients.`,
        priority: 4,
      });

      // 5. Ambulance staging — last, in cold zone
      items.push({
        id: 'ambulance_staging',
        asset_type: 'ambulance_staging',
        label: 'Ambulance Staging & Transport Point',
        geometry_type: 'point',
        zone: 'cold',
        placement_hint: `Cold zone near road access, within 100m of T1 treatment zone for rapid loading`,
        personnel: [
          { role: 'Transport Coordinator', count: 1, ppe: 'high-vis vest, radio' },
          {
            role: 'Ambulance Crew',
            count: Math.max(2, Math.ceil(redCount / 2)) * 2,
            ppe: 'standard EMS PPE',
          },
        ],
        equipment: [
          `${Math.max(2, Math.ceil(redCount / 2))} ambulances staged`,
          'hospital capacity board (tracking bed availability)',
          'patient manifest forms',
          'radios',
        ],
        capacity: Math.max(2, Math.ceil(redCount / 2)),
        description: `Ambulance staging with ${Math.max(2, Math.ceil(redCount / 2))} units ready. Transport coordinator maintains hospital capacity board and rotates units to prevent bottleneck.`,
        priority: 5,
      });
      break;
    }

    case 'fire': {
      // Zone declarations — fire team draws hot/warm/cold zone boundaries first
      const hotR = metrics.hotZoneRadius / METERS_PER_DEG;
      const warmR = metrics.warmZoneRadius / METERS_PER_DEG;
      const coldR = metrics.coldZoneRadius / METERS_PER_DEG;

      items.push({
        id: 'zone_hot',
        asset_type: 'hot_zone',
        label: 'HOT ZONE (Exclusion)',
        geometry_type: 'polygon',
        zone: 'hot',
        radius_deg: hotR,
        placement_hint: `Concentric circle centered on incident [${c.lat}, ${c.lng}], radius ${metrics.hotZoneRadius}m — immediate danger area`,
        personnel: [{ role: 'Inner Cordon Guard', count: 2, ppe: 'full turnout gear' }],
        equipment: ['barrier tape', 'hazard signage'],
        description:
          'Hot zone boundary — immediate danger area. Only personnel in full PPE with buddy system. 2-in/2-out protocol enforced.',
        priority: 0,
      });

      items.push({
        id: 'zone_warm',
        asset_type: 'warm_zone',
        label: 'WARM ZONE (Buffer)',
        geometry_type: 'polygon',
        zone: 'warm',
        radius_deg: warmR,
        placement_hint: `Concentric circle centered on incident [${c.lat}, ${c.lng}], radius ${metrics.warmZoneRadius}m — decontamination and triage buffer`,
        personnel: [{ role: 'Access Controller', count: 2, ppe: 'high-vis vest' }],
        equipment: ['barrier tape', 'access control signage'],
        description:
          'Warm zone boundary — buffer area for decontamination, casualty collection, and triage operations. Controlled access only.',
        priority: 0,
      });

      items.push({
        id: 'zone_cold',
        asset_type: 'cold_zone',
        label: 'COLD ZONE (Support)',
        geometry_type: 'polygon',
        zone: 'cold',
        radius_deg: coldR,
        placement_hint: `Concentric circle centered on incident [${c.lat}, ${c.lng}], radius ${metrics.coldZoneRadius}m — safe support area for command posts and staging`,
        personnel: [{ role: 'Perimeter Marshal', count: 2, ppe: 'high-vis vest' }],
        equipment: ['barrier tape', 'perimeter signage'],
        description:
          'Cold zone boundary — safe area for all command posts, staging areas, assembly points, and logistics. All non-fire teams operate within this zone.',
        priority: 0,
      });

      items.push({
        id: 'forward_command',
        asset_type: 'forward_command',
        label: 'Hazards / Fire / Rescue Forward Command Post',
        geometry_type: 'point',
        zone: 'warm',
        placement_hint: `Warm zone, upwind from hazards, ~80m from incident center with clear line of sight`,
        personnel: [
          {
            role: 'Hazards / Fire / Rescue Sector Commander',
            count: 1,
            ppe: 'command vest, radio, helmet',
          },
          { role: 'Safety Officer', count: 1, ppe: 'full turnout gear, gas monitor' },
          { role: 'Communications Operator', count: 1, ppe: 'radio headset' },
        ],
        equipment: [
          'situation board',
          'accountability board (PAR tracking)',
          'multi-channel radio',
          'binoculars',
          'wind direction indicator',
          'maps',
        ],
        description:
          'Forward command post for Hazards / Fire / Rescue operations. Upwind position with accountability tracking for all personnel entering hot zone.',
        priority: 1,
      });

      items.push({
        id: 'staging_area',
        asset_type: 'staging_area',
        label: 'Hazards / Fire / Rescue Equipment Staging Area',
        geometry_type: 'polygon',
        zone: 'warm',
        radius_deg: 0.00027,
        placement_hint: `Warm zone, adjacent to forward command post, accessible to apparatus`,
        personnel: [
          { role: 'Staging Officer', count: 1, ppe: 'turnout gear' },
          {
            role: 'Firefighter / HAZMAT Tech',
            count: Math.max(4, metrics.hazardCount * 3),
            ppe: 'full turnout gear or Level B HAZMAT suit',
          },
        ],
        equipment: [
          `${Math.max(2, metrics.hazardCount)} SCBA sets with spare cylinders`,
          'hose lines and nozzles',
          'thermal imaging cameras',
          'chemical identification kits (HazCat, pH strips, RAD monitors)',
          'forcible entry tools',
          'portable lighting',
          'RIT (Rapid Intervention Team) pack',
          'rehabilitation supplies (water, electrolytes)',
        ],
        capacity: Math.max(4, metrics.hazardCount * 3),
        description: `Staging area with ${Math.max(4, metrics.hazardCount * 3)} responders ready for rotation into hot zone. Full SCBA and rehabilitation capability. 2-in/2-out protocol enforced.`,
        priority: 1,
      });

      // Operating perimeter around Hazards / Fire / Rescue staging and command area
      items.push({
        id: 'fire_operating_perimeter',
        asset_type: 'inner_cordon',
        label: 'Hazards / Fire / Rescue Operations Perimeter',
        geometry_type: 'polygon',
        zone: 'warm',
        radius_deg: 0.00045,
        placement_hint: `Circle around forward command post and staging area, radius ~50m, securing Hazards / Fire / Rescue operations zone`,
        personnel: [{ role: 'Perimeter Guard', count: 2, ppe: 'high-vis vest, helmet' }],
        equipment: ['portable barriers', 'barrier tape', 'hazard signage', 'access log'],
        description:
          'Controlled perimeter around Hazards / Fire / Rescue operations. Only personnel with appropriate PPE and accountability check-in may enter. Barriers prevent unauthorized access to hazardous area.',
        priority: 2,
      });

      if (metrics.hazardCount > 0) {
        const deconCapacity = Math.max(
          4,
          Math.ceil((metrics.totalCasualties + metrics.hazardCount * 3) / 3),
        );
        items.push({
          id: 'decontamination_zone',
          asset_type: 'decontamination_zone',
          label: 'Decontamination Corridor',
          geometry_type: 'point',
          zone: 'boundary',
          placement_hint: `On the hot/warm zone boundary, between the hazard area and the clean warm zone. Upwind.`,
          personnel: [
            { role: 'Decon Team Leader', count: 1, ppe: 'Level B HAZMAT suit' },
            {
              role: 'Decon Technician',
              count: Math.max(2, Math.ceil(deconCapacity / 4)),
              ppe: 'Level B HAZMAT suit, splash protection',
            },
            {
              role: 'Patient Handler (clean side)',
              count: Math.max(1, Math.ceil(deconCapacity / 6)),
              ppe: 'Level C (APR + splash protection)',
            },
          ],
          equipment: [
            `${Math.max(1, Math.ceil(deconCapacity / 4))} portable shower units`,
            'water supply (minimum 500L)',
            'chemical neutralization agents',
            'runoff containment pools',
            `${deconCapacity} sets of replacement clothing and blankets`,
            'patient modesty screens',
            'biomedical waste containers',
            'decontamination solution (soap, activated charcoal)',
          ],
          capacity: deconCapacity,
          description: `${Math.max(1, Math.ceil(deconCapacity / 4))}-lane decontamination corridor. Capacity: ${deconCapacity} persons/hour. All personnel and casualties exiting hot zone must pass through decon before entering clean area.`,
          priority: 3,
        });
      }

      // Water supply
      items.push({
        id: 'water_supply',
        asset_type: 'water_supply',
        label: 'Water Supply Point',
        geometry_type: 'point',
        zone: 'warm',
        placement_hint: `Near staging area, connected to nearest hydrant or tanker access`,
        personnel: [{ role: 'Pump Operator', count: 1, ppe: 'turnout gear' }],
        equipment: [
          'pump truck or portable pump',
          'supply hose (minimum 100m)',
          'hydrant wrench',
          'standpipe',
        ],
        description:
          'Water supply point maintaining continuous flow for fire suppression and decontamination operations.',
        priority: 3,
      });
      break;
    }

    case 'evacuation': {
      // Cordon and perimeter control (merged from former police/security role)
      const roadblockCount = Math.max(2, Math.min(metrics.exitCount, 4));

      items.push({
        id: 'outer_cordon',
        asset_type: 'outer_cordon',
        label: 'Outer Security Cordon',
        geometry_type: 'polygon',
        zone: 'cold',
        radius_deg: 0.000225,
        placement_hint: `Circle centered on incident [${c.lat}, ${c.lng}], radius ~25m, enclosing operational zones`,
        personnel: [
          {
            role: 'Cordon Officer',
            count: Math.max(4, roadblockCount * 2),
            ppe: 'high-vis vest, helmet',
          },
          { role: 'Cordon Supervisor', count: 1, ppe: 'high-vis vest, radio' },
        ],
        equipment: ['barrier tape', 'traffic cones', 'portable barriers', 'radios', 'flashlights'],
        description:
          'Outer security cordon controlling all access. All personnel and vehicles must pass through controlled entry points.',
        priority: 1,
      });

      for (let i = 0; i < roadblockCount; i++) {
        const exitLabel = metrics.exitLocations[i]?.label || `Access Point ${i + 1}`;
        items.push({
          id: `roadblock_${i + 1}`,
          asset_type: 'roadblock',
          label: `Checkpoint at ${exitLabel}`,
          geometry_type: 'point',
          zone: 'cold',
          placement_hint: metrics.exitLocations[i]
            ? `Near exit "${exitLabel}" at [${metrics.exitLocations[i].lat}, ${metrics.exitLocations[i].lng}]`
            : `At access point ${i + 1} on the outer cordon perimeter`,
          personnel: [{ role: 'Checkpoint Officer', count: 2, ppe: 'high-vis vest' }],
          equipment: ['vehicle barrier', 'ID check station', 'radio', 'stop sign'],
          description: `Checkpoint controlling access at ${exitLabel}. Officers verifying credentials for all inbound traffic.`,
          priority: 2,
        });
      }

      items.push({
        id: 'command_post',
        asset_type: 'command_post',
        label: 'Forward Command Post',
        geometry_type: 'point',
        zone: 'cold',
        placement_hint: `Cold zone, offset ~150m from incident center in safe direction`,
        personnel: [
          { role: 'Incident Commander', count: 1, ppe: 'command vest' },
          { role: 'Communications Officer', count: 1, ppe: 'radio headset' },
          { role: 'Scribe/Logger', count: 1 },
        ],
        equipment: [
          'command table',
          'situation board',
          'multi-channel radio',
          'maps',
          'laptop with CAD access',
        ],
        description:
          'Central command post for coordinating all operations, maintaining situational awareness, and inter-agency liaison.',
        priority: 2,
      });

      if (metrics.totalCasualties > 0) {
        items.push({
          id: 'inner_cordon',
          asset_type: 'inner_cordon',
          label: 'Inner Cordon (Hot Zone)',
          geometry_type: 'polygon',
          zone: 'hot',
          radius_deg: 0.00015,
          placement_hint: `Tight circle around incident center [${c.lat}, ${c.lng}], radius ~15m, containing the hot zone`,
          personnel: [
            {
              role: 'Inner Cordon Guard',
              count: Math.max(2, Math.ceil(metrics.hazardCount * 2)),
              ppe: 'helmet, radio',
            },
          ],
          equipment: ['barrier tape', 'scene logs'],
          description:
            'Inner cordon securing the hot zone. Only authorized emergency responders in appropriate PPE may enter.',
          priority: 1,
        });
      }

      // Assembly points and evacuation
      const assemblyCount = Math.max(
        1,
        Math.min(Math.ceil(metrics.totalCrowdSize / 100), metrics.exitCount, 3),
      );
      const marshalsPerPoint = Math.max(2, Math.ceil(metrics.totalCrowdSize / assemblyCount / 25));
      const crowdPerPoint = Math.ceil(metrics.totalCrowdSize / assemblyCount);

      for (let i = 0; i < assemblyCount; i++) {
        const exitRef = metrics.exitLocations[i];
        const exitLabel = exitRef?.label || `Exit ${i + 1}`;
        items.push({
          id: `assembly_point_${i + 1}`,
          asset_type: 'assembly_point',
          label:
            `Assembly Area ${assemblyCount > 1 ? String.fromCharCode(65 + i) : ''} (${exitLabel})`.trim(),
          geometry_type: 'point',
          zone: 'cold',
          placement_hint: exitRef
            ? `Cold zone near "${exitLabel}" at [${exitRef.lat}, ${exitRef.lng}], safe distance from incident`
            : `Cold zone, clear area near exit ${i + 1} with good visibility`,
          personnel: [
            { role: 'Assembly Marshal', count: marshalsPerPoint, ppe: 'high-vis vest, PA system' },
            {
              role: 'Registration Officer',
              count: Math.max(1, Math.ceil(marshalsPerPoint / 3)),
              ppe: 'high-vis vest',
            },
            { role: 'Welfare Officer', count: 1, ppe: 'high-vis vest' },
          ],
          equipment: [
            'PA system / megaphone',
            `registration clipboard/tablets for ${crowdPerPoint} evacuees`,
            `${Math.ceil(crowdPerPoint / 10)} water stations`,
            'first aid kit (basic)',
            `${Math.ceil(crowdPerPoint / 4)} emergency blankets`,
            'signage (multilingual if applicable)',
            'portable lighting',
            'radio for coordination with command',
          ],
          capacity: crowdPerPoint,
          description: `Assembly area near ${exitLabel} for ~${crowdPerPoint} evacuees. ${marshalsPerPoint} marshals managing registration, headcount, and welfare. Water and blankets available.`,
          priority: 1,
        });
      }

      // Assembly area perimeter to contain evacuees and prevent unauthorized re-entry
      items.push({
        id: 'assembly_perimeter',
        asset_type: 'inner_cordon',
        label: 'Assembly Area Perimeter',
        geometry_type: 'polygon',
        zone: 'cold',
        radius_deg: 0.00045,
        placement_hint: `Circle encompassing assembly areas, radius ~50m, preventing evacuees from wandering back toward danger zones`,
        personnel: [
          {
            role: 'Perimeter Marshal',
            count: Math.max(2, assemblyCount * 2),
            ppe: 'high-vis vest',
          },
        ],
        equipment: [
          'portable barriers',
          'crowd control barriers',
          'barrier tape',
          'directional signage',
        ],
        description:
          'Perimeter barriers around assembly areas preventing evacuees from re-entering the incident zone. Marshals direct foot traffic through controlled access points only.',
        priority: 2,
      });

      // Marshal staging
      items.push({
        id: 'marshal_staging',
        asset_type: 'staging_area',
        label: 'Evacuation Marshal Staging Post',
        geometry_type: 'point',
        zone: 'cold',
        placement_hint: `Cold zone, central location between assembly areas for rapid marshal deployment`,
        personnel: [
          { role: 'Evacuation Coordinator', count: 1, ppe: 'command vest, radio' },
          { role: 'Route Scout', count: Math.max(2, assemblyCount), ppe: 'high-vis vest, radio' },
        ],
        equipment: [
          'route maps',
          'bullhorns',
          'traffic wands',
          'spare high-vis vests',
          'headcount tally sheets',
        ],
        description:
          'Central coordination post for all evacuation marshals. Route scouts verify evacuation paths are clear before directing crowd flow.',
        priority: 3,
      });

      // Family reunification
      if (metrics.totalCrowdSize > 50) {
        items.push({
          id: 'reunification_point',
          asset_type: 'assembly_point',
          label: 'Family Reunification Center',
          geometry_type: 'point',
          zone: 'cold',
          placement_hint: `Cold zone, distinct from assembly areas, near public access but outside cordon if possible`,
          personnel: [
            {
              role: 'Reunification Officer',
              count: Math.max(1, Math.ceil(metrics.totalCrowdSize / 100)),
              ppe: 'high-vis vest',
            },
            { role: 'Crisis Counselor', count: 1 },
          ],
          equipment: [
            'registration tablets',
            'privacy screens',
            'seating',
            'water',
            'phone charging station',
            'information board',
          ],
          capacity: Math.ceil(metrics.totalCrowdSize * 0.3),
          description: `Family reunification center. Registered evacuees matched with waiting family members. Crisis counseling available.`,
          priority: 4,
        });
      }
      break;
    }

    case 'media': {
      items.push({
        id: 'press_cordon',
        asset_type: 'press_cordon',
        label: 'Media Access Cordon',
        geometry_type: 'polygon',
        zone: 'cold',
        radius_deg: 0.00027,
        placement_hint: `Cold zone, line-of-sight to incident area but safe distance (~200m from hot zone). Downwind.`,
        personnel: [
          { role: 'Public Information Officer (PIO)', count: 1, ppe: 'ID badge, radio' },
          {
            role: 'Media Liaison',
            count: Math.max(1, Math.ceil(metrics.totalCrowdSize / 200)),
            ppe: 'ID badge',
          },
        ],
        equipment: [
          'press credential verification station',
          'portable barriers',
          'signage (MEDIA ONLY)',
        ],
        description:
          'Controlled media access area with line-of-sight to incident. All media must present credentials and receive briefing on restricted areas.',
        priority: 1,
      });

      items.push({
        id: 'media_staging',
        asset_type: 'media_staging',
        label: 'Media Staging & Briefing Area',
        geometry_type: 'point',
        zone: 'cold',
        placement_hint: `Inside press cordon, with backdrop suitable for camera shots away from sensitive operations`,
        personnel: [
          { role: 'PIO / Spokesperson', count: 1, ppe: 'ID badge' },
          { role: 'Social Media Monitor', count: 1 },
          {
            role: 'Media Escort',
            count: Math.max(1, Math.ceil(metrics.totalCrowdSize / 300)),
            ppe: 'high-vis vest, ID',
          },
        ],
        equipment: [
          'press podium / briefing stand',
          'power outlets / generator for media equipment',
          'Wi-Fi hotspot',
          'printed fact sheets (timeline, casualty count, hotline)',
          'LCD screen for press conference visuals',
        ],
        description:
          'Media staging area with press briefing capability. PIO conducts regular updates. Social media monitored for misinformation.',
        priority: 2,
      });
      break;
    }

    case 'bomb_squad': {
      items.push({
        id: 'eod_staging',
        asset_type: 'staging_area',
        label: 'EOD Staging Area',
        geometry_type: 'point',
        zone: 'cold',
        placement_hint: `Cold zone, minimum 150m from incident center, hard-standing surface for robot deployment`,
        personnel: [
          { role: 'EOD Team Leader', count: 1, ppe: 'bomb suit (standby), radio, ID' },
          { role: 'EOD Technician', count: 2, ppe: 'bomb suit (standby), radio' },
          { role: 'Robot Operator', count: 1, ppe: 'radio' },
        ],
        equipment: [
          'EOD robot (ROV)',
          'portable X-ray unit',
          'standard water disruptor',
          'hard target disruptor',
          'blast shields',
          'bomb suit (×2)',
          'K9 explosive detection unit',
          'electronic countermeasure (ECM)',
          'total containment vessel (TCV)',
          'evidence collection kit',
          'detonation cord',
        ],
        description:
          'EOD staging area for equipment prep, robot deployment, and team briefings. All render-safe procedures initiated from here.',
        priority: 1,
      });

      items.push({
        id: 'eod_exclusion_zone',
        asset_type: 'exclusion_zone',
        label: 'Exclusion Zone (template)',
        geometry_type: 'polygon',
        zone: 'cold',
        radius_deg: 0.00045,
        placement_hint: `Deployed around each suspicious device. Max 50m radius exclusion zone.`,
        personnel: [{ role: 'Perimeter Guard', count: 4, ppe: 'high-vis vest, radio' }],
        equipment: ['barrier tape', 'portable barriers', 'megaphone'],
        description:
          'Exclusion zone established around each suspicious device. Radius based on container material and estimated yield. All personnel evacuated. Comms blackout enforced.',
        priority: 2,
      });
      break;
    }

    default:
      break;
  }

  const teamLabels: Record<string, string> = {
    evacuation: 'Evacuation',
    fire: 'Hazards / Fire / Rescue',
    triage: 'Medical Triage',
    media: 'Media & Communications',
    pursuit: 'Pursuit & Investigation',
    bomb_squad: 'Bomb Squad / EOD',
  };

  return {
    team: teamLabels[teamKey] || teamKey,
    items,
    layout_rationale: buildLayoutRationale(teamKey, metrics),
  };
}

function buildLayoutRationale(teamKey: string, m: ScenarioMetrics): string {
  switch (teamKey) {
    case 'triage':
      return `${m.totalCasualties} casualties across ${m.casualtyClusters.length || 1} cluster(s) → ${Math.max(1, Math.ceil(m.totalCasualties / 15))} triage station(s) needed. Build order: Triage Station (tent) FIRST → CCP at hot/warm boundary → Cordon around triage → T1/T2 Treatment zones → Ambulance Staging (cold zone). Patient flow: CCP → Triage → T1/T2 → Ambulance → Hospital.`;
    case 'evacuation':
      return `${m.exitCount} access points → ${Math.max(2, Math.min(m.exitCount, 4))} checkpoints needed. Outer cordon encloses all zones. Inner cordon secures hot zone. ${m.totalCrowdSize} people to evacuate → ${Math.max(1, Math.min(Math.ceil(m.totalCrowdSize / 100), m.exitCount, 3))} assembly areas (1 marshal per 25 evacuees). Crowd flow: incident area → exits → assembly areas → reunification.`;
    case 'fire':
      return `${m.hazardCount} active hazard(s) → staging for ${Math.max(4, m.hazardCount * 3)} responders with SCBA rotation. Decon corridor required between hot and warm zones. 2-in/2-out protocol.`;
    case 'media':
      return `Media cordon positioned in cold zone with line-of-sight. PIO conducts regular briefings to control narrative and prevent unauthorized access.`;
    case 'bomb_squad':
      return `EOD staging in cold zone (150m+). Sweep-first protocol: systematically sweep all operational areas placed by other teams. When suspicious device reported or discovered: establish exclusion zone (radius by container type), comms blackout, deploy robot, X-ray, select correct RSP, render safe, collect evidence, declare all-clear. LIVE DEVICES DETONATE AFTER 2 MINUTES.`;
    default:
      return '';
  }
}

// Backwards-compatible: returns just the required asset_type list from blueprint
function getRequiredInfraFromBlueprint(teamKey: string): string[] {
  const dummyMetrics: ScenarioMetrics = {
    totalCasualties: 10,
    totalCrowdSize: 100,
    casualtyClusters: [],
    hazardCount: 1,
    exitCount: 3,
    exitLocations: [],
    incidentCenter: { lat: 0, lng: 0 },
    hotZoneRadius: 50,
    warmZoneRadius: 150,
    coldZoneRadius: 300,
  };
  const bp = generateTeamBlueprint(teamKey, dummyMetrics);
  const priorityOne = bp.items.filter((i) => i.priority <= 2).map((i) => i.asset_type);
  return [...new Set(priorityOne)];
}

function getTeamScopeKey(teamName: string): string | null {
  const t = teamName.toLowerCase();

  // Canonical team name → slug mapping (handles display names and old legacy names)
  if (
    t.includes('pursuit') ||
    t.includes('investigat') ||
    t.includes('intelligence') ||
    t.includes('negotiat')
  )
    return 'pursuit';
  if (t.includes('bomb') || t.includes('eod') || t.includes('explosive ordnance'))
    return 'bomb_squad';
  if (
    t.includes('triage') ||
    t.includes('medical') ||
    t.includes('ems') ||
    t.includes('ambulance') ||
    t.includes('paramedic')
  )
    return 'triage';
  if (t.includes('fire') || t.includes('hazmat') || t.includes('hazard') || t.includes('rescue'))
    return 'fire';
  if (
    t.includes('media') ||
    t.includes('press') ||
    t.includes('pio') ||
    t.includes('communication')
  )
    return 'media';
  if (
    t.includes('evacu') ||
    t.includes('police') ||
    t.includes('security') ||
    t.includes('cordon') ||
    t.includes('crowd')
  )
    return 'evacuation';

  return null;
}

function isPlacementAllowedForTeam(teamName: string, assetType: string): boolean {
  const key = getTeamScopeKey(teamName);
  if (!key) return true;
  return TEAM_ALLOWED_PLACEMENTS[key].has(assetType);
}

function getRequiredInfrastructure(teamName: string): string[] {
  const key = getTeamScopeKey(teamName);
  if (!key) return [];
  return getRequiredInfraFromBlueprint(key);
}

async function loadScenarioMetrics(
  sessionId: string,
  scenarioId: string,
  incidentCenter: { lat: number; lng: number } | null,
): Promise<ScenarioMetrics> {
  const center = incidentCenter ?? { lat: 0, lng: 0 };
  const metrics: ScenarioMetrics = {
    totalCasualties: 0,
    totalCrowdSize: 0,
    casualtyClusters: [],
    hazardCount: 0,
    exitCount: 0,
    exitLocations: [],
    incidentCenter: center,
    hotZoneRadius: 50,
    warmZoneRadius: 150,
    coldZoneRadius: 300,
  };

  try {
    // Casualties — count and cluster
    const { data: casualties } = await supabaseAdmin
      .from('scenario_casualties')
      .select('casualty_type, headcount, location_lat, location_lng, status')
      .eq('session_id', sessionId)
      .in('status', [
        'undiscovered',
        'identified',
        'being_moved',
        'being_evacuated',
        'at_assembly',
        'endorsed_to_triage',
        'in_treatment',
      ]);

    const patients: Array<{ lat: number; lng: number; count: number }> = [];
    for (const c of (casualties ?? []) as Array<Record<string, unknown>>) {
      const hc = (c.headcount as number) || 1;
      const cType = c.casualty_type as string;
      if (cType === 'crowd' || cType === 'evacuee_group' || cType === 'convergent_crowd') {
        metrics.totalCrowdSize += hc;
      } else {
        metrics.totalCasualties += hc;
        patients.push({ lat: c.location_lat as number, lng: c.location_lng as number, count: hc });
      }
    }

    // Simple clustering — group patients within ~100m of each other
    const used = new Set<number>();
    for (let i = 0; i < patients.length; i++) {
      if (used.has(i)) continue;
      const cluster = {
        lat: patients[i].lat,
        lng: patients[i].lng,
        count: patients[i].count,
        zone: 'warm' as string,
      };
      used.add(i);
      for (let j = i + 1; j < patients.length; j++) {
        if (used.has(j)) continue;
        const dist = Math.sqrt(
          (patients[j].lat - cluster.lat) ** 2 + (patients[j].lng - cluster.lng) ** 2,
        );
        if (dist < 0.001) {
          cluster.lat =
            (cluster.lat * cluster.count + patients[j].lat * patients[j].count) /
            (cluster.count + patients[j].count);
          cluster.lng =
            (cluster.lng * cluster.count + patients[j].lng * patients[j].count) /
            (cluster.count + patients[j].count);
          cluster.count += patients[j].count;
          used.add(j);
        }
      }
      metrics.casualtyClusters.push(cluster);
    }

    // Hazards
    const { data: hazards } = await supabaseAdmin
      .from('scenario_hazards')
      .select('id')
      .eq('session_id', sessionId)
      .in('status', ['active', 'escalating']);
    metrics.hazardCount = (hazards ?? []).length;

    // Exits
    const { data: exits } = await supabaseAdmin
      .from('scenario_locations')
      .select('id, label, coordinates, location_type')
      .eq('scenario_id', scenarioId)
      .in('location_type', ['exit', 'entry', 'exit_entry', 'entry_exit']);

    metrics.exitCount = (exits ?? []).length;
    for (const e of (exits ?? []) as Array<Record<string, unknown>>) {
      const coords = e.coordinates as Record<string, unknown> | null;
      if (coords && coords.lat && coords.lng) {
        metrics.exitLocations.push({
          label: e.label as string,
          lat: coords.lat as number,
          lng: coords.lng as number,
        });
      }
    }

    // Zone radii from scenario_locations (incident_zone pins)
    const { data: zones } = await supabaseAdmin
      .from('scenario_locations')
      .select('label, conditions')
      .eq('scenario_id', scenarioId)
      .eq('pin_category', 'incident_zone');

    for (const z of (zones ?? []) as Array<Record<string, unknown>>) {
      const conds = z.conditions as Record<string, unknown> | null;
      const radius = (conds?.radius_m as number) || 0;
      const label = ((z.label as string) || '').toLowerCase();
      if (label.includes('hot') && radius > 0) metrics.hotZoneRadius = radius;
      else if (label.includes('warm') && radius > 0) metrics.warmZoneRadius = radius;
      else if (label.includes('cold') && radius > 0) metrics.coldZoneRadius = radius;
    }

    // Ensure minimums
    if (metrics.totalCasualties === 0 && metrics.totalCrowdSize === 0) {
      metrics.totalCasualties = 5;
      metrics.totalCrowdSize = 50;
    }
  } catch (err) {
    logger.debug({ error: err }, 'Failed to load scenario metrics for blueprint');
  }

  return metrics;
}

async function checkInfrastructureStatus(
  sessionId: string,
  teamName: string,
): Promise<{ ready: boolean; placed: string[]; missing: string[] }> {
  const required = getRequiredInfrastructure(teamName);
  if (required.length === 0) return { ready: true, placed: [], missing: [] };

  const { data } = await supabaseAdmin
    .from('placed_assets')
    .select('asset_type')
    .eq('session_id', sessionId)
    .eq('team_name', teamName)
    .eq('status', 'active')
    .in('asset_type', required);

  const placedSet = new Set(
    (data ?? []).map((a) => (a as Record<string, unknown>).asset_type as string),
  );
  const placed = required.filter((r) => placedSet.has(r));
  const missing = required.filter((r) => !placedSet.has(r));
  return { ready: missing.length === 0, placed, missing };
}

/** Meters-per-degree constant (approximate at equator; good enough for offsets). */
const METERS_PER_DEG = 111_000;

/** Minimum distance (meters) between any two bot-placed pins to prevent stacking. */
const MIN_PIN_DISTANCE_M = 100;

/**
 * Load all occupied coordinates in a session (placed assets, casualties, hazards, locations)
 * for coordinate deconfliction.
 */
async function loadOccupiedCoordinates(
  sessionId: string,
): Promise<Array<{ lat: number; lng: number }>> {
  const coords: Array<{ lat: number; lng: number }> = [];

  const [assetsRes, casualtiesRes, hazardsRes, locationsRes] = await Promise.all([
    supabaseAdmin
      .from('placed_assets')
      .select('geometry')
      .eq('session_id', sessionId)
      .eq('status', 'active'),
    supabaseAdmin
      .from('scenario_casualties')
      .select('location_lat, location_lng')
      .eq('session_id', sessionId),
    supabaseAdmin
      .from('scenario_hazards')
      .select('location_lat, location_lng')
      .eq('session_id', sessionId),
    supabaseAdmin.from('scenario_locations').select('coordinates').eq('session_id', sessionId),
  ]);

  for (const a of assetsRes.data ?? []) {
    const geo = (a as Record<string, unknown>).geometry as
      | { type?: string; coordinates?: unknown }
      | undefined;
    if (!geo?.coordinates) continue;
    if (geo.type === 'Point') {
      const [lng, lat] = geo.coordinates as [number, number];
      if (lat && lng) coords.push({ lat, lng });
    } else if (geo.type === 'Polygon') {
      const ring = (geo.coordinates as number[][][])?.[0];
      if (ring?.length > 0) {
        const avgLat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
        const avgLng = ring.reduce((s, c) => s + c[0], 0) / ring.length;
        coords.push({ lat: avgLat, lng: avgLng });
      }
    }
  }

  for (const c of casualtiesRes.data ?? []) {
    const r = c as Record<string, unknown>;
    const lat = Number(r.location_lat);
    const lng = Number(r.location_lng);
    if (lat && lng) coords.push({ lat, lng });
  }

  for (const h of hazardsRes.data ?? []) {
    const r = h as Record<string, unknown>;
    const lat = Number(r.location_lat);
    const lng = Number(r.location_lng);
    if (lat && lng) coords.push({ lat, lng });
  }

  for (const l of locationsRes.data ?? []) {
    const r = l as Record<string, unknown>;
    const coordsArr = r.coordinates as { lat?: number; lng?: number } | null;
    if (coordsArr?.lat && coordsArr?.lng) coords.push({ lat: coordsArr.lat, lng: coordsArr.lng });
  }

  return coords;
}

/**
 * Nudge a coordinate so it's at least `minDistM` meters from all occupied positions.
 * Uses a spiral outward search: each attempt moves the point further away in a
 * rotating direction until a clear spot is found (max 12 attempts).
 */
function deconflictCoordinate(
  lat: number,
  lng: number,
  occupied: Array<{ lat: number; lng: number }>,
  minDistM: number,
): { lat: number; lng: number } {
  const isClear = (pLat: number, pLng: number): boolean =>
    occupied.every((o) => haversineM(pLat, pLng, o.lat, o.lng) >= minDistM);

  if (isClear(lat, lng)) return { lat, lng };

  const offsetDeg = minDistM / METERS_PER_DEG;
  for (let attempt = 1; attempt <= 12; attempt++) {
    const angle = (2 * Math.PI * attempt) / 12 + Math.random() * 0.3;
    const dist = offsetDeg * (1 + attempt * 0.3);
    const newLat = lat + dist * Math.cos(angle);
    const newLng = lng + dist * Math.sin(angle);
    if (isClear(newLat, newLng)) return { lat: newLat, lng: newLng };
  }

  // Last resort: push directly away from the nearest occupied point
  let nearest = occupied[0];
  let nearestDist = Infinity;
  for (const o of occupied) {
    const d = haversineM(lat, lng, o.lat, o.lng);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = o;
    }
  }
  const dLat = lat - nearest.lat;
  const dLng = lng - nearest.lng;
  const mag = Math.sqrt(dLat * dLat + dLng * dLng) || 0.0001;
  const pushDeg = (minDistM * 1.2) / METERS_PER_DEG;
  return {
    lat: nearest.lat + (dLat / mag) * pushDeg,
    lng: nearest.lng + (dLng / mag) * pushDeg,
  };
}

/**
 * Generate a random coordinate within the specified zone ring around the incident center.
 * - 'hot': within hotZoneRadius of center
 * - 'warm': between hotZoneRadius and warmZoneRadius
 * - 'cold': between warmZoneRadius and coldZoneRadius
 * - 'boundary': near the hot/warm zone boundary
 */
/**
 * Load building stud grids for a scenario (cached), snap a coordinate to the
 * nearest vacant stud if it falls inside a building, and return the result.
 */
async function snapIfInsideBuilding(
  lat: number,
  lng: number,
  floor: string,
  scenarioId: string,
  sessionId: string,
): Promise<{ lat: number; lng: number }> {
  let grids = getCachedGrids(scenarioId);

  if (!grids) {
    try {
      const { data: sc } = await supabaseAdmin
        .from('scenarios')
        .select('insider_knowledge')
        .eq('id', scenarioId)
        .single();

      const ik = sc?.insider_knowledge as Record<string, unknown> | null;
      const osmVicinity = ik?.osm_vicinity as Record<string, unknown> | undefined;
      const buildings = osmVicinity?.buildings as OsmBuilding[] | undefined;

      if (buildings?.length) {
        grids = generateStudGrids(buildings);
        setCachedGrids(scenarioId, grids);
      }
    } catch {
      return { lat, lng };
    }
  }

  if (!grids?.length) return { lat, lng };

  const occupied = await getOccupiedStudIds(scenarioId, grids, sessionId);
  const snapped = snapCoordinate(lat, lng, floor, grids, occupied);
  return { lat: snapped.lat, lng: snapped.lng };
}

function randomCoordInZone(
  center: { lat: number; lng: number },
  zone: string,
  metrics: ScenarioMetrics,
): { lat: number; lng: number } {
  let minR: number;
  let maxR: number;

  switch (zone) {
    case 'hot':
      minR = 0;
      maxR = metrics.hotZoneRadius;
      break;
    case 'warm':
      minR = metrics.hotZoneRadius;
      maxR = metrics.warmZoneRadius;
      break;
    case 'cold':
      minR = metrics.warmZoneRadius;
      maxR = metrics.coldZoneRadius;
      break;
    case 'boundary':
      minR = Math.max(0, metrics.hotZoneRadius - 20);
      maxR = metrics.hotZoneRadius + 20;
      break;
    default:
      minR = metrics.warmZoneRadius;
      maxR = metrics.coldZoneRadius;
  }

  const radiusM = minR + Math.random() * (maxR - minR);
  const bearing = Math.random() * 2 * Math.PI;
  const offsetDeg = radiusM / METERS_PER_DEG;

  return {
    lat: center.lat + offsetDeg * Math.cos(bearing),
    lng: center.lng + offsetDeg * Math.sin(bearing),
  };
}

const ZONE_DECLARATION_TYPES = new Set(['hot_zone', 'warm_zone', 'cold_zone', 'hazard_zone']);

const ZONE_EXEMPT_TEAMS = new Set(['fire', 'bomb_squad']);

/** Check if drawn zone polygons exist for this session. */
async function hasDrawnZones(sessionId: string): Promise<boolean> {
  const { count } = await supabaseAdmin
    .from('placed_assets')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId)
    .eq('status', 'active')
    .in('asset_type', ['hot_zone', 'warm_zone', 'cold_zone']);
  return (count ?? 0) > 0;
}

/**
 * Resolve the effective zone for a team's asset placement.
 * If zone polygons have been drawn and the team is not fire/bomb_squad,
 * the zone is forced to 'cold' so all assets land outside the warm zone.
 */
function resolveEffectiveZone(zone: string, teamKey: string | null, zonesDrawn: boolean): string {
  if (!zonesDrawn) return zone;
  if (teamKey && ZONE_EXEMPT_TEAMS.has(teamKey)) return zone;
  return 'cold';
}

/** Clamp a cordon radius_deg to max 50m radius. Zone declaration types are exempt. */
function clampCordonRadius(radiusDeg: number, assetType?: string): number {
  if (assetType && ZONE_DECLARATION_TYPES.has(assetType)) return radiusDeg;
  const maxDeg = 50 / METERS_PER_DEG; // ~0.00045
  return Math.min(maxDeg, radiusDeg);
}

/** Full asset-type catalog: maps asset_type → geometry shape and default zone. */
const ASSET_TYPE_CATALOG: Record<
  string,
  { geometry: 'point' | 'polygon'; defaultZone: 'hot' | 'warm' | 'cold' }
> = {
  command_post: { geometry: 'point', defaultZone: 'cold' },
  triage_point: { geometry: 'point', defaultZone: 'warm' },
  field_hospital: { geometry: 'point', defaultZone: 'cold' },
  assembly_point: { geometry: 'point', defaultZone: 'cold' },
  decontamination_zone: { geometry: 'point', defaultZone: 'warm' },
  staging_area: { geometry: 'polygon', defaultZone: 'cold' },
  inner_cordon: { geometry: 'polygon', defaultZone: 'hot' },
  outer_cordon: { geometry: 'polygon', defaultZone: 'cold' },
  press_cordon: { geometry: 'polygon', defaultZone: 'cold' },
  media_staging: { geometry: 'polygon', defaultZone: 'cold' },
  hot_zone: { geometry: 'polygon', defaultZone: 'hot' },
  warm_zone: { geometry: 'polygon', defaultZone: 'warm' },
  cold_zone: { geometry: 'polygon', defaultZone: 'cold' },
  exclusion_zone: { geometry: 'polygon', defaultZone: 'hot' },
  roadblock: { geometry: 'polygon', defaultZone: 'cold' },
  casualty_collection: { geometry: 'point', defaultZone: 'warm' },
  observation_post: { geometry: 'point', defaultZone: 'cold' },
  ambulance_staging: { geometry: 'point', defaultZone: 'cold' },
  helicopter_lz: { geometry: 'point', defaultZone: 'cold' },
  fire_truck: { geometry: 'point', defaultZone: 'warm' },
  forward_command: { geometry: 'point', defaultZone: 'warm' },
  water_supply: { geometry: 'point', defaultZone: 'warm' },
  marshal_post: { geometry: 'point', defaultZone: 'cold' },
};

/**
 * Extract personnel mentions from decision text.
 * Looks for patterns like "3x medics", "2 paramedics", "deploying 5 marshals", etc.
 */
function extractPersonnelFromText(text: string): string[] {
  const personnel: string[] = [];
  const patterns = [
    /(\d+)\s*x?\s*(medic|paramedic|doctor|nurse|marshal|officer|guard|firefighter|responder|controller|specialist|technician|operator|coordinator|liaison|pio|spokesperson)s?/gi,
    /deploy(?:ing)?\s+(\d+)\s+([\w\s]+?)(?:\s+(?:in|at|to|with|for)\b)/gi,
    /staff(?:ed|ing)?\s+(?:with\s+)?(\d+)\s+([\w\s]+?)(?:\s+(?:in|at|to|with)\b)/gi,
  ];
  for (const p of patterns) {
    let match: RegExpExecArray | null;
    while ((match = p.exec(text)) !== null) {
      personnel.push(`${match[1]}x ${match[2].trim()}`);
    }
  }
  return personnel;
}

/**
 * Extract equipment mentions from decision text.
 * Looks for patterns like "barrier tape", "portable barriers", "stretchers", etc.
 */
function extractEquipmentFromText(text: string): string[] {
  const equipment: string[] = [];
  const knownEquipment = [
    'barrier tape',
    'portable barriers',
    'barriers',
    'barricades',
    'stretcher',
    'stretchers',
    'defibrillator',
    'first aid kit',
    'oxygen',
    'iv kit',
    'iv access',
    'splint',
    'tourniquet',
    'fire extinguisher',
    'hose',
    'breathing apparatus',
    'scba',
    'hazmat suit',
    'ppe',
    'helmet',
    'safety vest',
    'high-vis vest',
    'radio',
    'signage',
    'access control',
    'floodlights',
    'generator',
    'tent',
    'shelter',
    'blankets',
    'water supply',
    'megaphone',
    'loudspeaker',
    'cones',
    'traffic cones',
  ];
  const lower = text.toLowerCase();
  for (const eq of knownEquipment) {
    if (lower.includes(eq)) equipment.push(eq);
  }
  return [...new Set(equipment)];
}

/**
 * Extract "direct to" / transport intent from decision text.
 * Returns destination descriptions like "warm zone", "triage point", "Exit D", etc.
 */
function extractDirectionIntent(text: string): {
  action: string;
  destination: string;
} | null {
  const patterns = [
    /(?:transport|move|transfer|evacuate|extract|carry|direct)\s+(?:patient|casualt|victim|injured|crowd|evacuee|group)s?\s+(?:to|toward|towards)\s+(?:the\s+)?(.{5,80}?)(?:\.|,|$)/i,
    /(?:direct|guide|send|escort)\s+(?:to|toward|towards)\s+(?:the\s+)?(.{5,80}?)(?:\.|,|$)/i,
    /(?:hand\s*off|handover)\s+(?:to|at)\s+(?:the\s+)?(.{5,80}?)(?:\.|,|$)/i,
  ];
  for (const p of patterns) {
    const match = p.exec(text);
    if (match) {
      const verb = text.slice(match.index, match.index + 15).toLowerCase();
      const action = /transport|transfer|move/.test(verb)
        ? 'transport'
        : /extract|carry/.test(verb)
          ? 'extract'
          : /hand/i.test(verb)
            ? 'handoff'
            : 'direct_to';
      return { action, destination: match[1].trim() };
    }
  }
  return null;
}

/**
 * Use AI to judge whether a decision text describes infrastructure placement intent.
 * Returns an array of structured placements the team intends to create — or empty
 * array if the text is not about establishing infrastructure.
 *
 * This replaces fragile regex matching: the LLM understands context, synonyms,
 * implicit intent, and varied phrasings.
 */
async function aiExtractInfrastructureIntent(
  teamName: string,
  allowedAssetTypes: string[],
  alreadyPlacedTypes: string[],
  title: string,
  description: string,
  incidentCenter: { lat: number; lng: number },
): Promise<Array<{ asset_type: string; label: string; lat: number | null; lng: number | null }>> {
  try {
    const catalogDesc = allowedAssetTypes
      .map((t) => {
        const c = ASSET_TYPE_CATALOG[t];
        return c ? `  - ${t} (${c.geometry}, ${c.defaultZone} zone)` : `  - ${t}`;
      })
      .join('\n');

    const prompt = [
      'You are an intent-extraction engine for an emergency response simulation.',
      'Analyze the decision text below and determine if the team intends to ESTABLISH, SET UP, DEPLOY, or CREATE any physical infrastructure on the map.',
      '',
      'Infrastructure includes: command posts, triage points, cordons, perimeters, barriers, staging areas, assembly points, field hospitals, decontamination zones, observation posts, roadblocks, exclusion zones, etc.',
      '',
      'Things that are NOT infrastructure placement:',
      '- Treating/triaging a patient',
      '- Responding to media or press inquiries',
      '- Issuing statements or coordinating with other teams',
      '- Requesting resources without establishing a physical location',
      '- General situational awareness or assessment',
      '',
      `Team: ${teamName}`,
      `Incident center: [${incidentCenter.lat}, ${incidentCenter.lng}]`,
      '',
      `Allowed asset types for this team:`,
      catalogDesc,
      '',
      `Already placed by this team (do NOT duplicate): ${alreadyPlacedTypes.length > 0 ? alreadyPlacedTypes.join(', ') : 'none'}`,
      '',
      `Decision title: ${title}`,
      `Decision description: ${description}`,
      '',
      'If the decision describes establishing infrastructure, return a JSON object:',
      '{ "placements": [{ "asset_type": "...", "label": "Human-readable label", "lat": number_or_null, "lng": number_or_null }] }',
      '',
      'Rules:',
      '- Only return asset_types from the allowed list above.',
      '- Do NOT return asset_types already placed by this team.',
      '- If coordinates [lat, lng] appear in the text, extract them. Otherwise set lat/lng to null.',
      '- If the text does NOT describe infrastructure placement, return { "placements": [] }.',
      '- Maximum 4 placements per decision.',
      '- label should be descriptive (e.g. "Medical Triage Triage Station", "Evacuation Assembly Point near Gate B").',
    ].join('\n');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.openAiApiKey}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You extract infrastructure placement intents from emergency response decisions. Return valid JSON only. Be precise: only identify ESTABLISHMENT of physical structures/areas, not other operational actions.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 400,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      logger.warn(
        { status: response.status },
        'AI infrastructure extraction: OpenAI request failed',
      );
      return [];
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) return [];

    const parsed = JSON.parse(content) as Record<string, unknown>;
    const raw = Array.isArray(parsed.placements)
      ? parsed.placements
      : Array.isArray(parsed)
        ? parsed
        : [];

    return (raw as Array<Record<string, unknown>>)
      .filter(
        (p) =>
          typeof p.asset_type === 'string' &&
          allowedAssetTypes.includes(p.asset_type) &&
          !alreadyPlacedTypes.includes(p.asset_type),
      )
      .slice(0, 4)
      .map((p) => ({
        asset_type: p.asset_type as string,
        label: (p.label as string) || `${teamName} ${(p.asset_type as string).replace(/_/g, ' ')}`,
        lat: typeof p.lat === 'number' ? p.lat : null,
        lng: typeof p.lng === 'number' ? p.lng : null,
      }));
  } catch (err) {
    logger.warn({ error: err }, 'AI infrastructure extraction failed, returning empty');
    return [];
  }
}

/**
 * Pre-evaluation extraction service: uses AI to analyze decision text for infrastructure
 * placement, personnel/equipment details, and transport/direction intent BEFORE the
 * evaluator runs.
 *
 * 1. Infrastructure: AI judges intent and creates placed_assets with personnel/equipment
 * 2. Direction: records transport/handoff intent as a session_event for evaluator visibility
 *
 * Exported so both the demo dispatcher and human player decision route can call it.
 */
export async function extractAndPlaceInfrastructureFromText(
  sessionId: string,
  scenarioId: string,
  teamName: string,
  title: string,
  description: string,
  incidentCenter: { lat: number; lng: number } | null,
  placedBy?: string,
): Promise<number> {
  const rawText = `${title} ${description}`;
  const center = incidentCenter;
  if (!center) return 0;

  // --- Part 1: Extract and store personnel/equipment from decision text ---
  const personnel = extractPersonnelFromText(rawText);
  const equipment = extractEquipmentFromText(rawText);

  // --- Part 2: Extract direction/transport intent and record it ---
  const directionIntent = extractDirectionIntent(rawText);
  if (directionIntent) {
    try {
      await supabaseAdmin.from('session_events').insert({
        session_id: sessionId,
        event_type: 'direction_intent',
        metadata: {
          team: teamName,
          action: directionIntent.action,
          destination: directionIntent.destination,
          source_text: rawText.slice(0, 500),
        },
      });
      logger.info(
        {
          sessionId,
          teamName,
          action: directionIntent.action,
          destination: directionIntent.destination,
        },
        'Pre-eval extraction: recorded direction/transport intent',
      );
    } catch (err) {
      logger.warn({ error: err }, 'Pre-eval extraction: failed to record direction intent');
    }
  }

  // --- Part 3: AI-based infrastructure placement intent extraction ---
  const { data: existingAssets } = await supabaseAdmin
    .from('placed_assets')
    .select('asset_type, label, team_name')
    .eq('session_id', sessionId)
    .eq('status', 'active');
  const existingTeamAssets = new Set(
    (existingAssets ?? []).map(
      (a) =>
        `${(a as Record<string, unknown>).team_name}::${(a as Record<string, unknown>).asset_type}`,
    ),
  );

  const teamKey = getTeamScopeKey(teamName);
  const allowedTypes = teamKey
    ? Array.from(TEAM_ALLOWED_PLACEMENTS[teamKey] ?? [])
    : Object.keys(ASSET_TYPE_CATALOG);
  const alreadyPlaced = (existingAssets ?? [])
    .filter((a) => (a as Record<string, unknown>).team_name === teamName)
    .map((a) => (a as Record<string, unknown>).asset_type as string);

  const aiPlacements = await aiExtractInfrastructureIntent(
    teamName,
    allowedTypes,
    alreadyPlaced,
    title,
    description,
    center,
  );

  if (aiPlacements.length === 0) return 0;

  const metrics = await loadScenarioMetrics(sessionId, scenarioId, center);
  const zonesDrawn = await hasDrawnZones(sessionId);
  let placedCount = 0;

  for (const p of aiPlacements) {
    if (placedCount >= 4) break;
    if (!ASSET_TYPE_CATALOG[p.asset_type]) continue;
    if (existingTeamAssets.has(`${teamName}::${p.asset_type}`)) continue;
    if (!isPlacementAllowedForTeam(teamName, p.asset_type)) continue;

    const catalog = ASSET_TYPE_CATALOG[p.asset_type];

    let pointLat: number;
    let pointLng: number;

    if (p.lat != null && p.lng != null) {
      pointLat = Math.max(center.lat - 0.01, Math.min(center.lat + 0.01, p.lat));
      pointLng = Math.max(center.lng - 0.01, Math.min(center.lng + 0.01, p.lng));
    } else {
      const effectiveZone = resolveEffectiveZone(catalog.defaultZone, teamKey, zonesDrawn);
      const zoneCoord = randomCoordInZone(center, effectiveZone, metrics);
      pointLat = zoneCoord.lat;
      pointLng = zoneCoord.lng;
    }

    // Snap point placements to building studs if inside a building
    if (catalog.geometry === 'point') {
      const snapped = await snapIfInsideBuilding(pointLat, pointLng, 'G', scenarioId, sessionId);
      pointLat = snapped.lat;
      pointLng = snapped.lng;
    }

    let geometry: { type: string; coordinates: unknown };
    if (catalog.geometry === 'point') {
      geometry = { type: 'Point', coordinates: [pointLng, pointLat] };
    } else {
      const clampedR = clampCordonRadius(75 / METERS_PER_DEG, p.asset_type);
      const pts: [number, number][] = [];
      for (let i = 0; i < 12; i++) {
        const angle = (2 * Math.PI * i) / 12;
        pts.push([pointLng + clampedR * Math.cos(angle), pointLat + clampedR * Math.sin(angle)]);
      }
      pts.push(pts[0]);
      geometry = { type: 'Polygon', coordinates: [pts] };
    }

    const label = p.label || `${teamName} ${p.asset_type.replace(/_/g, ' ')}`;
    const properties: Record<string, unknown> = {};
    if (personnel.length > 0) properties.personnel = personnel;
    if (equipment.length > 0) properties.equipment = equipment;
    if (directionIntent) properties.direction_intent = directionIntent;

    const ZONE_CLASS_MAP: Record<string, string> = {
      hot_zone: 'hot',
      warm_zone: 'warm',
      cold_zone: 'cold',
    };
    if (p.asset_type in ZONE_CLASS_MAP)
      properties.zone_classification = ZONE_CLASS_MAP[p.asset_type];

    logger.info(
      { sessionId, teamName, assetType: p.asset_type, label, personnel, equipment },
      'Pre-eval placement (AI): auto-creating infrastructure from decision text',
    );

    if (!placedBy) {
      logger.warn(
        { sessionId, assetType: p.asset_type },
        'Pre-eval placement (AI): skipped — no placedBy user ID',
      );
      continue;
    }

    const { data: createdAsset, error } = await supabaseAdmin
      .from('placed_assets')
      .insert({
        session_id: sessionId,
        team_name: teamName,
        placed_by: placedBy,
        asset_type: p.asset_type,
        label,
        geometry,
        properties,
        status: 'active',
      })
      .select()
      .single();

    if (error || !createdAsset) {
      logger.warn(
        { error, sessionId, assetType: p.asset_type },
        'Pre-eval placement (AI): insert failed',
      );
    } else {
      existingTeamAssets.add(`${teamName}::${p.asset_type}`);
      placedCount++;

      try {
        getWebSocketService().broadcastToSession(sessionId, {
          type: 'placement.created',
          data: { placement: createdAsset, warnings: [] },
          timestamp: new Date().toISOString(),
        });
      } catch {
        /* non-blocking */
      }

      // Auto-create paired perimeter/barrier polygon for point assets
      if (catalog.geometry === 'point' && placedBy) {
        const perimCount = await autoCreatePairedPerimeter(
          sessionId,
          teamName,
          p.asset_type,
          pointLat,
          pointLng,
          placedBy,
        );
        if (perimCount > 0) placedCount += perimCount;
      }
    }
  }

  return placedCount;
}

/**
 * Resolve the anchor point for a cordon/perimeter polygon.
 * Incident-level cordons (inner_cordon, outer_cordon) anchor to the incident center.
 * Team-specific perimeters anchor to the team's already-placed point asset they enclose.
 */
const CORDON_ANCHOR_MAP: Record<
  string,
  { anchorTo: 'incident' | string[]; radiusDeg: number; label: string; assetType: string }
> = {
  inner_cordon: {
    anchorTo: 'incident',
    radiusDeg: 0.00015,
    label: 'Inner Cordon',
    assetType: 'inner_cordon',
  },
  outer_cordon: {
    anchorTo: 'incident',
    radiusDeg: 0.000225,
    label: 'Outer Security Cordon',
    assetType: 'outer_cordon',
  },
  triage_inner_cordon: {
    anchorTo: ['triage_point', 'field_hospital', 'casualty_collection'],
    radiusDeg: 0.00015,
    label: 'Triage Operating Perimeter',
    assetType: 'inner_cordon',
  },
  fire_operating_perimeter: {
    anchorTo: ['forward_command', 'command_post', 'staging_area'],
    radiusDeg: 0.00045,
    label: 'Operations Perimeter',
    assetType: 'inner_cordon',
  },
  assembly_perimeter: {
    anchorTo: ['assembly_point', 'marshal_post'],
    radiusDeg: 0.00045,
    label: 'Assembly Area Perimeter',
    assetType: 'inner_cordon',
  },
  press_cordon: {
    anchorTo: ['media_staging'],
    radiusDeg: 0.00027,
    label: 'Media Access Cordon',
    assetType: 'press_cordon',
  },
  command_post_perimeter: {
    anchorTo: ['command_post'],
    radiusDeg: 0.0003,
    label: 'Command Post Perimeter',
    assetType: 'inner_cordon',
  },
  ambulance_staging_perimeter: {
    anchorTo: ['ambulance_staging'],
    radiusDeg: 0.0003,
    label: 'Ambulance Staging Perimeter',
    assetType: 'inner_cordon',
  },
  helicopter_lz_perimeter: {
    anchorTo: ['helicopter_lz'],
    radiusDeg: 0.00045,
    label: 'Landing Zone Perimeter',
    assetType: 'exclusion_zone',
  },
  decon_perimeter: {
    anchorTo: ['decontamination_zone'],
    radiusDeg: 0.0003,
    label: 'Decontamination Perimeter',
    assetType: 'inner_cordon',
  },
  exclusion_zone: {
    anchorTo: 'incident',
    radiusDeg: 0.00045,
    label: 'Exclusion Zone',
    assetType: 'exclusion_zone',
  },
};

/**
 * Reverse lookup: for a given point asset_type, which perimeter entries anchor to it?
 * Built once from CORDON_ANCHOR_MAP.
 */
const POINT_TO_PERIMETER_MAP: Record<string, string[]> = (() => {
  const m: Record<string, string[]> = {};
  for (const [perimId, cfg] of Object.entries(CORDON_ANCHOR_MAP)) {
    if (cfg.anchorTo === 'incident') continue;
    for (const pointType of cfg.anchorTo) {
      (m[pointType] ??= []).push(perimId);
    }
  }
  return m;
})();

// Team-scoped overrides: when the same asset_type (e.g. inner_cordon) has different
// anchor requirements per team, the team-specific key takes priority.
const TEAM_CORDON_ANCHOR: Record<string, Record<string, { anchorTo: 'incident' | string[] }>> = {
  triage: {
    inner_cordon: { anchorTo: ['triage_point', 'field_hospital', 'casualty_collection'] },
  },
  fire: {
    inner_cordon: { anchorTo: ['forward_command', 'command_post', 'staging_area'] },
  },
  evacuation: {
    inner_cordon: { anchorTo: 'incident' },
  },
};

async function resolveCordonAnchor(
  assetType: string,
  blueprintId: string,
  sessionId: string,
  teamName: string,
  incidentCenter: { lat: number; lng: number },
): Promise<{ lat: number; lng: number } | null> {
  // Check team-scoped overrides first, then blueprint id, then asset type
  const teamKey = getTeamScopeKey(teamName);
  const teamOverride = teamKey ? TEAM_CORDON_ANCHOR[teamKey]?.[assetType] : undefined;
  const mapping = teamOverride ?? CORDON_ANCHOR_MAP[blueprintId] ?? CORDON_ANCHOR_MAP[assetType];

  if (!mapping) return null;

  if (mapping.anchorTo === 'incident') {
    return incidentCenter;
  }

  // Look up the team's already-placed point assets to find the anchor
  const anchorTypes = mapping.anchorTo as string[];
  const { data } = await supabaseAdmin
    .from('placed_assets')
    .select('asset_type, geometry')
    .eq('session_id', sessionId)
    .eq('team_name', teamName)
    .eq('status', 'active')
    .in('asset_type', anchorTypes);

  if (data && data.length > 0) {
    const asset = data[0] as Record<string, unknown>;
    const geo = asset.geometry as { type?: string; coordinates?: number[] } | null;
    if (geo?.type === 'Point' && Array.isArray(geo.coordinates) && geo.coordinates.length >= 2) {
      return { lat: geo.coordinates[1], lng: geo.coordinates[0] };
    }
  }

  // No anchor asset found — fall back to incident center
  return incidentCenter;
}

/**
 * Auto-create paired perimeter/barrier polygons when a point asset is placed.
 * Uses POINT_TO_PERIMETER_MAP to find which perimeters should surround the
 * given asset type, checks if they already exist, and creates them if not.
 * Returns the number of perimeters created.
 */
async function autoCreatePairedPerimeter(
  sessionId: string,
  teamName: string,
  placedAssetType: string,
  placedLat: number,
  placedLng: number,
  placedBy: string,
): Promise<number> {
  const perimeterIds = POINT_TO_PERIMETER_MAP[placedAssetType];
  if (!perimeterIds?.length) return 0;

  const { data: existing } = await supabaseAdmin
    .from('placed_assets')
    .select('asset_type, label')
    .eq('session_id', sessionId)
    .eq('team_name', teamName)
    .eq('status', 'active');
  const existingLabels = new Set(
    (existing ?? []).map((a) => (a as Record<string, unknown>).label as string),
  );

  let created = 0;
  for (const perimId of perimeterIds) {
    const cfg = CORDON_ANCHOR_MAP[perimId];
    if (!cfg) continue;

    if (existingLabels.has(cfg.label)) continue;

    const clampedR = clampCordonRadius(cfg.radiusDeg, cfg.assetType);
    const pts: [number, number][] = [];
    for (let i = 0; i < 12; i++) {
      const angle = (2 * Math.PI * i) / 12;
      pts.push([placedLng + clampedR * Math.cos(angle), placedLat + clampedR * Math.sin(angle)]);
    }
    pts.push(pts[0]);
    const geometry = { type: 'Polygon', coordinates: [pts] };

    const { data: createdAsset, error } = await supabaseAdmin
      .from('placed_assets')
      .insert({
        session_id: sessionId,
        team_name: teamName,
        placed_by: placedBy,
        asset_type: cfg.assetType,
        label: cfg.label,
        geometry,
        properties: { auto_paired_with: placedAssetType },
        status: 'active',
      })
      .select()
      .single();

    if (error || !createdAsset) {
      logger.warn(
        { error, sessionId, perimId, assetType: cfg.assetType },
        'autoCreatePairedPerimeter: insert failed',
      );
    } else {
      created++;
      logger.info(
        { sessionId, teamName, perimId, label: cfg.label, anchoredTo: placedAssetType },
        'autoCreatePairedPerimeter: auto-created perimeter for placed asset',
      );
      try {
        getWebSocketService().broadcastToSession(sessionId, {
          type: 'placement.created',
          data: { placement: createdAsset, warnings: [] },
          timestamp: new Date().toISOString(),
        });
      } catch {
        /* non-blocking */
      }
    }
  }
  return created;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DemoAIAgentService {
  private sessions = new Map<string, SessionAgents>();
  private dispatcher = new DemoActionDispatcher();

  async start(
    sessionId: string,
    scenarioId: string,
    options?: { scriptAware?: boolean; difficulty?: AIDifficultyLevel },
  ): Promise<boolean> {
    if (this.sessions.has(sessionId)) {
      logger.warn({ sessionId }, 'AI agents already running for session');
      return false;
    }

    if (!env.openAiApiKey) {
      logger.error({ sessionId }, 'AI agents require OPENAI_API_KEY');
      return false;
    }

    const context = await this.loadScenarioContext(scenarioId);
    if (!context) return false;

    const channelId = await this.dispatcher.getSessionChannelId(sessionId);
    const difficulty = options?.difficulty ?? 'intermediate';

    const session: SessionAgents = {
      sessionId,
      scenarioId,
      scenarioSummary: context.scenarioSummary,
      sectorStandards: context.sectorStandards,
      incidentCenter: context.incidentCenter,
      startedAt: Date.now(),
      agents: new Map(),
      channelId,
      eventHandler: () => {},
      channelHandlers: new Map(),
      proactiveTimer: null,
      scriptAware: options?.scriptAware ?? false,
      scriptNextEventTs: 0,
      stopped: false,
      cycleDecisionCount: 0,
      lastInjectTs: 0,
      difficulty,
    };

    for (const team of context.teams) {
      const botUserId = resolveBotUserId(team.team_name);
      const profile = await this.loadBotProfile(botUserId);

      session.agents.set(botUserId, {
        persona: {
          botUserId,
          teamName: team.team_name,
          fullName: profile?.full_name || team.team_name,
          roleName: profile?.role || team.team_name,
          agencyName: profile?.agency_name || team.team_name,
          teamDescription: team.description || '',
          doctrines: team.doctrines || '',
        },
        recentActions: [],
        lastActionTs: 0,
        pendingCooldown: false,
        actedThisCycle: false,
        lastActionWasPinResponse: false,
      });
    }

    const handler: InternalEventHandler = (event) => {
      if (session.stopped) return;
      this.handleSessionEvent(session, event).catch((err) => {
        logger.error({ error: err, sessionId, eventType: event.type }, 'AI agent event error');
      });
    };
    session.eventHandler = handler;
    getWebSocketService().onSessionEvent(sessionId, handler);

    if (channelId) {
      const chHandler: InternalEventHandler = (event) => {
        if (session.stopped) return;
        this.handleChannelEvent(session, event);
      };
      session.channelHandlers.set(channelId, chHandler);
      getWebSocketService().onChannelEvent(channelId, chHandler);
    }

    this.sessions.set(sessionId, session);
    logger.info({ sessionId, scenarioId, agentCount: session.agents.size }, 'AI agents started');

    this.runKickstart(session);

    session.proactiveTimer = setInterval(() => {
      if (session.stopped) return;
      this.proactiveTick(session).catch((err) => {
        logger.error({ error: err, sessionId }, 'AI agent proactive tick error');
      });
    }, PROACTIVE_INTERVAL_MS);

    return true;
  }

  stop(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.stopped = true;
    getWebSocketService().offSessionEvent(sessionId, session.eventHandler);
    for (const [chId, handler] of session.channelHandlers) {
      getWebSocketService().offChannelEvent(chId, handler);
    }
    if (session.proactiveTimer) {
      clearInterval(session.proactiveTimer);
      session.proactiveTimer = null;
    }
    this.sessions.delete(sessionId);
    logger.info({ sessionId }, 'AI agents stopped');
  }

  notifyUpcomingScriptEvent(sessionId: string, firesAtMs: number): void {
    const session = this.sessions.get(sessionId);
    if (session) session.scriptNextEventTs = firesAtMs;
  }

  isRunning(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Kickstart & Proactive loop
  // ---------------------------------------------------------------------------

  private runKickstart(session: SessionAgents): void {
    const agentEntries = Array.from(session.agents.entries());

    // ── PHASE 2: Infrastructure pass (place command posts, cordons, triage) ──
    const infraEvent: WebSocketEvent = {
      type: 'session.started',
      data: {
        message:
          'PHASE 2 — ESTABLISH INFRASTRUCTURE.\n' +
          'Exits have been claimed. Now establish your foundational infrastructure:\n' +
          '1. PLACE your COMMAND POST (point asset) at an appropriate staging location.\n' +
          '2. PLACE cordons, barricades, or perimeter assets your team is responsible for.\n' +
          '3. SET UP triage areas, evacuation holding points, or staging areas for your role.\n' +
          '4. Perform your initial SITUATION ASSESSMENT and communicate it to chat.\n' +
          'You MUST include at least ONE placement action. Describe coordinates precisely.',
      },
      timestamp: new Date().toISOString(),
    };

    session.cycleDecisionCount = 0;
    session.lastInjectTs = Date.now();

    // Phase 1: programmatic round-robin exit claiming (no AI involved)
    this.claimExitsRoundRobin(session, agentEntries).catch((err) => {
      logger.error({ error: err, sessionId: session.sessionId }, 'Kickstart exit claiming failed');
    });

    // Phase 2: all agents place infrastructure (staggered after claims finish)
    const phase2Start = KICKSTART_INITIAL_DELAY_MS + agentEntries.length * 5_000 + 15_000;

    for (let i = 0; i < agentEntries.length; i++) {
      const [, agentState] = agentEntries[i];
      const infraDelay = phase2Start + i * KICKSTART_STAGGER_MS + Math.random() * 5000;

      setTimeout(() => {
        if (session.stopped) return;
        agentState.lastActionTs = 0;
        agentState.actedThisCycle = false;
        this.generateAndExecuteActions(session, agentState, infraEvent).catch((err) => {
          logger.error(
            { error: err, botUserId: agentState.persona.botUserId },
            'AI agent kickstart infrastructure phase failed',
          );
        });
      }, infraDelay);
    }
  }

  private async proactiveTick(session: SessionAgents): Promise<void> {
    if (session.stopped) return;

    // Auto-reset cycle flags periodically
    const now = Date.now();
    if (session.lastInjectTs > 0 && now - session.lastInjectTs > INJECT_CYCLE_RESET_MS) {
      session.cycleDecisionCount = 0;
      for (const [, a] of session.agents) {
        a.actedThisCycle = false;
      }
      session.lastInjectTs = now;
    }

    const elapsed = this.getElapsedMinutes(session);

    const proactiveEvent: WebSocketEvent = {
      type: 'proactive.tick',
      data: {
        message: `${Math.floor(elapsed)} minutes into the exercise. Assess the current situation and take your next action if appropriate.`,
        elapsed_minutes: Math.floor(elapsed),
      },
      timestamp: new Date().toISOString(),
    };

    // Let ALL eligible agents act, staggered with delays between each
    const eligible = Array.from(session.agents.values()).filter(
      (a) => this.canAct(a, session) && !a.actedThisCycle,
    );
    if (eligible.length === 0) return;

    const isEarly = elapsed < FOUNDATIONAL_PHASE_MINUTES;
    const actProbability = isEarly ? PROACTIVE_ACT_PROBABILITY_EARLY : PROACTIVE_ACT_PROBABILITY;
    if (Math.random() > actProbability) return;

    // Shuffle for variety, then queue each with staggered delay
    for (let i = eligible.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
    }

    const runStaggered = async () => {
      for (let i = 0; i < eligible.length; i++) {
        if (session.stopped) return;
        const agent = eligible[i];
        if (!this.canAct(agent, session)) continue;

        if (i > 0) {
          await new Promise((resolve) => setTimeout(resolve, INTER_AGENT_DELAY_MS));
        }
        if (session.stopped) return;

        try {
          await this.generateAndExecuteActions(session, agent, proactiveEvent);
        } catch (err) {
          logger.error(
            { error: err, botUserId: agent.persona.botUserId },
            'AI agent proactive action failed',
          );
        }
      }
    };
    runStaggered().catch((err) => {
      logger.error({ error: err, sessionId: session.sessionId }, 'Staggered proactive run failed');
    });
  }

  // ---------------------------------------------------------------------------
  // Scenario context loader
  // ---------------------------------------------------------------------------

  private async loadScenarioContext(scenarioId: string): Promise<{
    scenarioSummary: string;
    sectorStandards: string;
    incidentCenter: { lat: number; lng: number } | null;
    teams: Array<{ team_name: string; description: string; doctrines: string }>;
  } | null> {
    try {
      const { data: scenario } = await supabaseAdmin
        .from('scenarios')
        .select('id, title, description, category, insider_knowledge')
        .eq('id', scenarioId)
        .single();

      if (!scenario) return null;

      const { data: teams } = await supabaseAdmin
        .from('scenario_teams')
        .select('team_name, team_description')
        .eq('scenario_id', scenarioId);

      const ik = (scenario as Record<string, unknown>).insider_knowledge as Record<
        string,
        unknown
      > | null;
      const sectorStandards = (ik?.sector_standards as string) || '';
      const teamDoctrines: Record<string, unknown> =
        (ik?.team_doctrines as Record<string, unknown>) || {};

      const { data: locations } = await supabaseAdmin
        .from('scenario_locations')
        .select('label, location_type, coordinates')
        .eq('scenario_id', scenarioId)
        .limit(15);

      const incidentCenter = await resolveScenarioCenter(scenarioId);

      const locationSummary = (locations ?? [])
        .map((l: Record<string, unknown>) => {
          const coords = l.coordinates as { lat?: number; lng?: number } | null;
          const coordStr =
            coords?.lat != null && coords?.lng != null ? ` at [${coords.lat}, ${coords.lng}]` : '';
          return `- ${l.label} (${l.location_type})${coordStr}`;
        })
        .join('\n');

      const scenarioSummary = [
        `Title: ${scenario.title}`,
        `Type: ${scenario.category || 'general'}`,
        scenario.description ? `Description: ${scenario.description}` : '',
        incidentCenter ? `Incident Center: [${incidentCenter.lat}, ${incidentCenter.lng}]` : '',
        locationSummary ? `Key Locations:\n${locationSummary}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      const teamList = (teams ?? []).map((t: Record<string, unknown>) => {
        const doctrineEntries = teamDoctrines[t.team_name as string] as
          | Array<{ title?: string; summary?: string }>
          | undefined;
        const doctrineText = doctrineEntries
          ? doctrineEntries.map((d) => `  - ${d.title || ''}: ${d.summary || ''}`).join('\n')
          : '';
        return {
          team_name: (t.team_name as string) || '',
          description: (t.team_description as string) || '',
          doctrines: doctrineText,
        };
      });

      return { scenarioSummary, sectorStandards, incidentCenter, teams: teamList };
    } catch (err) {
      logger.error({ error: err, scenarioId }, 'AI agents: failed to load scenario context');
      return null;
    }
  }

  private async loadBotProfile(
    botUserId: string,
  ): Promise<{ full_name: string; role: string; agency_name: string } | null> {
    try {
      const { data } = await supabaseAdmin
        .from('user_profiles')
        .select('full_name, role, agency_name')
        .eq('id', botUserId)
        .single();
      return data as { full_name: string; role: string; agency_name: string } | null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private async handleSessionEvent(session: SessionAgents, event: WebSocketEvent): Promise<void> {
    // Only react to inject.published — do NOT react to other bots' decisions/placements
    // to avoid the exponential feedback loop where each bot triggers all others.
    if (event.type !== 'inject.published') return;

    // New inject cycle: reset budget so agents can act again
    session.cycleDecisionCount = 0;
    session.lastInjectTs = Date.now();
    for (const [, agent] of session.agents) {
      agent.actedThisCycle = false;
    }

    logger.info(
      { sessionId: session.sessionId, eventType: event.type },
      'AI agents: new inject cycle started',
    );

    // Determine which teams this inject targets
    const injectData = (event.data as Record<string, unknown>)?.inject as
      | Record<string, unknown>
      | undefined;
    const targetTeams = (injectData?.target_teams as string[] | undefined) ?? [];
    const injectScope = (injectData?.inject_scope as string) ?? 'universal';
    const isUniversal = injectScope === 'universal' || targetTeams.length === 0;

    // Feedback injects (consequence, specificity, editorial) bypass the cooldown
    // throttle so the targeted team can respond immediately to its own feedback.
    const FEEDBACK_SOURCES = new Set([
      'specificity_feedback',
      'decision_consequence',
      'adversary_adaptation',
      'editorial_feedback',
      'protocol_violation',
    ]);
    const generationSource = (injectData?.generation_source as string) ?? '';
    const isFeedbackInject = FEEDBACK_SOURCES.has(generationSource);

    // Sequential agent responses with staggered delays: each agent waits for the
    // previous to finish so it can see what was already done and avoid duplicating actions.
    const agentEntries = Array.from(session.agents.entries());
    const runSequentially = async () => {
      let responded = 0;
      for (let i = 0; i < agentEntries.length; i++) {
        if (session.stopped) return;
        const [, agentState] = agentEntries[i];

        // Feedback injects bypass throttle for the targeted team
        const bypassThrottle =
          isFeedbackInject &&
          !isUniversal &&
          targetTeams.some((t) => {
            const tl = t.toLowerCase();
            const teamLower = agentState.persona.teamName.toLowerCase();
            return teamLower.includes(tl) || tl.includes(teamLower);
          });

        if (!bypassThrottle && !this.canAct(agentState, session)) continue;
        if (bypassThrottle && agentState.pendingCooldown) continue;

        // Skip agents whose team is not targeted by this inject (unless universal)
        if (!isUniversal) {
          const teamLower = agentState.persona.teamName.toLowerCase();
          const isTargeted = targetTeams.some((t) => {
            const tl = t.toLowerCase();
            return teamLower.includes(tl) || tl.includes(teamLower);
          });
          if (!isTargeted) {
            logger.debug(
              {
                botUserId: agentState.persona.botUserId,
                team: agentState.persona.teamName,
                targetTeams,
              },
              'AI agent: skipping inject not targeted at this team',
            );
            continue;
          }
        }

        // Universal injects go to ALL teams — no domain keyword filter.
        // Each team's classifier will determine the appropriate response for their domain.

        // Staggered delay between agents to avoid overloading
        if (responded > 0) {
          await new Promise((resolve) => setTimeout(resolve, INTER_AGENT_DELAY_MS));
        }

        if (session.stopped) return;

        try {
          await this.generateAndExecuteActions(session, agentState, event);
          responded++;
        } catch (err) {
          logger.error(
            { error: err, botUserId: agentState.persona.botUserId, eventType: event.type },
            'AI agent action failed',
          );
        }
      }
    };
    runSequentially().catch((err) => {
      logger.error({ error: err, sessionId: session.sessionId }, 'Sequential agent run failed');
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private handleChannelEvent(_session: SessionAgents, _event: WebSocketEvent): void {
    // no-op: chat responses disabled to prevent feedback loops
  }

  // ---------------------------------------------------------------------------
  // Ground-context loader for the classifier (structured, not stringified)
  // ---------------------------------------------------------------------------

  private async loadGroundContextForClassifier(
    session: SessionAgents,
    teamScopeKey: string | null,
  ): Promise<{
    unclaimedExits: number;
    infrastructureComplete: boolean;
    infrastructurePendingCount: number;
    pendingPatients: Array<{ id: string; label: string; status: string }>;
    pendingHazards: Array<{ id: string; label: string; status: string }>;
    pendingCrowds: Array<{ id: string; label: string; status: string }>;
  }> {
    const ground = await this.loadGroundSituation(
      session.sessionId,
      session.scenarioId,
      teamScopeKey || undefined,
    );

    const unclaimedExits = ground.claimableExits.filter(
      (e) => !e.claimStatus.startsWith('CLAIMED'),
    ).length;

    // Check infrastructure completeness
    let infrastructureComplete = true;
    let infrastructurePendingCount = 0;
    if (teamScopeKey) {
      const scenarioMetrics = await loadScenarioMetrics(
        session.sessionId,
        session.scenarioId,
        session.incidentCenter,
      );
      const blueprint = generateTeamBlueprint(teamScopeKey, scenarioMetrics);
      if (blueprint && blueprint.items.length > 0) {
        const { data: placedRaw } = await supabaseAdmin
          .from('placed_assets')
          .select('asset_type')
          .eq('session_id', session.sessionId)
          .eq(
            'team_name',
            Array.from(session.agents.values()).find(
              (a) => getTeamScopeKey(a.persona.teamName) === teamScopeKey,
            )?.persona.teamName || '',
          )
          .eq('status', 'active');
        const placedTypes = new Set(
          (placedRaw ?? []).map((a) => (a as Record<string, unknown>).asset_type as string),
        );
        const pending = blueprint.items.filter((item) => !placedTypes.has(item.asset_type));
        infrastructurePendingCount = pending.length;
        infrastructureComplete = pending.length === 0;
      }
    }

    // Parse structured pin data from the string lines
    const extractId = (line: string): string => {
      const m = line.match(/\[id:([^\]]+)\]/);
      return m ? m[1] : '';
    };
    const extractStatus = (line: string): string => {
      const m = line.match(/status:\s*(\S+)/);
      return m ? m[1] : 'unknown';
    };

    return {
      unclaimedExits,
      infrastructureComplete,
      infrastructurePendingCount,
      pendingPatients: ground.patients.map((p) => ({
        id: extractId(p),
        label: p.slice(0, 100),
        status: extractStatus(p),
      })),
      pendingHazards: ground.hazards.map((h) => ({
        id: extractId(h),
        label: h.slice(0, 100),
        status: extractStatus(h),
      })),
      pendingCrowds: ground.crowds.map((c) => ({
        id: extractId(c),
        label: c.slice(0, 100),
        status: extractStatus(c),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Core AI response generation — CLASSIFY-FIRST architecture
  // Step 1: classify what action is needed (fast AI or rules)
  // Step 2: generate focused prompt with the right format for that class
  // Step 3: execute the action
  // ---------------------------------------------------------------------------

  private async generateAndExecuteActions(
    session: SessionAgents,
    agent: AgentState,
    triggerEvent: WebSocketEvent,
  ): Promise<void> {
    if (session.stopped) return;
    if (!this.canAct(agent, session)) return;

    agent.lastActionTs = Date.now();
    agent.pendingCooldown = true;

    try {
      const teamScopeKey = getTeamScopeKey(agent.persona.teamName);

      // ── Step 1: CLASSIFY what action this agent should take ──
      const groundCtx = await this.loadGroundContextForClassifier(session, teamScopeKey);
      const classification = await classifyActionRequired(teamScopeKey || '', triggerEvent, {
        ...groundCtx,
        elapsedMinutes: this.getElapsedMinutes(session),
      });

      logger.info(
        {
          botUserId: agent.persona.botUserId,
          team: agent.persona.teamName,
          actionClass: classification.actionClass,
          reason: classification.reason,
        },
        'AI agent: action classified',
      );

      if (classification.actionClass === 'none') {
        agent.pendingCooldown = false;
        return;
      }

      // ── Step 2: Build focused prompt based on classification ──
      const systemPrompt = this.buildSystemPrompt(session, agent);
      const userPrompt = await this.buildClassifiedUserPrompt(
        session,
        agent,
        triggerEvent,
        classification,
      );

      // ── Step 3: Generate + validate + execute ──
      let actions: SingleAction[] = [];
      let attempt = 0;
      let rejectionContext = '';

      while (attempt < MAX_VALIDATION_RETRIES) {
        attempt++;
        const promptWithRejection =
          attempt === 1
            ? userPrompt
            : `${userPrompt}\n\n## ⛔ YOUR PREVIOUS RESPONSE WAS REJECTED (attempt ${attempt}/${MAX_VALIDATION_RETRIES}):\n${rejectionContext}\n\nYou MUST fix the issue described above. Submit a corrected response.`;

        const response = await this.callOpenAI(systemPrompt, promptWithRejection);
        if (!response) {
          agent.pendingCooldown = false;
          return;
        }

        actions = response.actions.filter((a) => a.action !== 'none');
        if (actions.length === 0) {
          agent.pendingCooldown = false;
          return;
        }

        const validation = await this.validateActions(session, agent, actions, triggerEvent);
        if (validation.valid) {
          break;
        }

        logger.info(
          { botUserId: agent.persona.botUserId, attempt, reason: validation.reason },
          'AI agent: response rejected by validator, retrying',
        );
        rejectionContext = validation.reason;

        if (attempt >= MAX_VALIDATION_RETRIES) {
          logger.info(
            { botUserId: agent.persona.botUserId },
            'AI agent: max retries reached, using context-aware fallback',
          );
          const fallbackActions = await this.generateContextAwareFallback(
            session,
            agent,
            classification,
          );
          if (fallbackActions) {
            actions = fallbackActions;
          }
          break;
        }
      }

      for (const action of actions.slice(0, 3)) {
        if (session.stopped) break;

        await this.executeSingleAction(session, agent, action, triggerEvent);

        if (action.action === 'decision' || action.action === 'pin_response') {
          session.cycleDecisionCount++;
        }

        const label =
          action.action === 'decision'
            ? `decision: ${action.decision?.title || ''}`
            : action.action === 'placement'
              ? `placement: ${action.placement?.asset_type} "${action.placement?.label}"`
              : action.action === 'claim'
                ? `claim: ${action.claim?.location_label} as ${action.claim?.claimed_as}`
                : action.action === 'pin_response'
                  ? `pin_response: ${action.pin_response?.target_type} "${action.pin_response?.target_label}" triage=${action.pin_response?.triage_color || 'none'}`
                  : action.action === 'sweep_asset'
                    ? `sweep_asset: "${action.sweep_asset?.asset_label}" (${action.sweep_asset?.asset_id?.slice(0, 8)})`
                    : action.action === 'chat'
                      ? `chat: ${action.chat?.content?.slice(0, 80) || ''}`
                      : action.action;

        agent.recentActions.push(`[${new Date().toISOString()}] ${label}`.slice(0, 200));

        if (actions.indexOf(action) < actions.length - 1) {
          await new Promise((r) =>
            setTimeout(r, INTER_ACTION_BASE_MS + Math.random() * INTER_ACTION_RANGE_MS),
          );
        }
      }

      agent.actedThisCycle = true;
      agent.lastActionWasPinResponse = actions.some((a) => a.action === 'pin_response');

      // AI-based placement extraction: if a decision was published but no placement was
      // included, use AI to analyze the decision intent and auto-create placements.
      const decisionAction = actions.find((a) => a.action === 'decision' && a.decision);
      if (decisionAction?.decision) {
        await this.aiExtractAndCreatePlacements(
          session,
          agent,
          decisionAction.decision.title,
          decisionAction.decision.description,
        );
      }

      // Fallback: if the bot mentioned claiming exits but didn't include a claim action,
      // try to auto-claim exits from the decision text
      const hasClaim = actions.some((a) => a.action === 'claim');
      if (!hasClaim && decisionAction?.decision) {
        await this.tryExtractClaimsFromDecision(
          session,
          agent,
          decisionAction.decision.title,
          decisionAction.decision.description,
        );
      }

      // Reasoning is logged inside the retry loop; no need to log again here

      while (agent.recentActions.length > MAX_RECENT_ACTIONS) {
        agent.recentActions.shift();
      }
    } catch (err) {
      logger.error(
        { error: err, botUserId: agent.persona.botUserId },
        'AI agent generateAndExecuteActions error',
      );
    } finally {
      agent.pendingCooldown = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Prompt builders
  // ---------------------------------------------------------------------------

  private buildSystemPrompt(session: SessionAgents, agent: AgentState): string {
    const { persona } = agent;
    const parts: string[] = [
      `You are ${persona.fullName}, ${persona.agencyName}, assigned to team "${persona.teamName}" in a live multi-agency crisis management exercise.`,
      '',
      '## Scenario',
      session.scenarioSummary,
    ];

    if (persona.teamDescription) {
      parts.push('', '## Your Team Brief', persona.teamDescription);
    }
    if (session.sectorStandards) {
      parts.push('', '## Sector Standards & Regulations', session.sectorStandards);
    }
    if (persona.doctrines) {
      parts.push('', '## Your Team Doctrines', persona.doctrines);
    }

    parts.push(
      '',
      '## How This Exercise Works',
      '',
      'Each turn you return 1-3 actions depending on the task. The user prompt will specify which actions are expected.',
      'Possible action types:',
      '1. DECISION — a single, focused tactical action',
      '2. PLACEMENT or CLAIM — a map action (infrastructure or exit claim)',
      '3. PIN_RESPONSE — interacting with a specific casualty, hazard, or crowd on the map',
      '4. CHAT — a short radio summary of what you did',
      '',
      '### ⚠️ ONE ACTION PER DECISION — CRITICAL',
      'Your decision must describe EXACTLY ONE tactical action. Do NOT bundle multiple actions.',
      '- WRONG: "Establish triage point AND treat burn victim AND set up decon zone"',
      '- RIGHT: "Establish Triage Point in Warm Zone" (then next turn: "Triage Burn Victim near Gate B")',
      'If your decision mentions infrastructure placement, your action MUST be a "placement" — NOT a pin_response.',
      'If your decision mentions treating/extracting a patient, your action MUST be a "pin_response" — NOT a placement.',
      '',
      '### DECISIONS (the only thing that counts)',
      'Decisions appear in the War Room panel and are scored. Placements/chat without a decision score ZERO.',
      '- title: Concise and specific to the SINGLE action (e.g. "Establish Inner Cordon" or "Triage Burn Victim")',
      '- description: 2-3 sentences about the ONE action. Reference location, resources, procedure.',
      '',
      '### ⚠️ PERSONNEL DEPLOYMENT — MANDATORY FOR EVERY OPERATIONAL AREA',
      'Every decision that establishes an operational area MUST include personnel deployment details:',
      '- WHO: specify role and count (e.g. "2x Paramedics", "4x Cordon Officers", "1x Triage Officer")',
      '- RATIO: if dealing with patients/evacuees, state the personnel-to-patient ratio (e.g. "1:3 medic-to-patient")',
      '- PPE: specify protective gear for the deployed personnel (e.g. "in full Level B PPE", "wearing high-vis vests")',
      '- EQUIPMENT: name the equipment they bring (e.g. "with stretchers, IV kits, and pulse oximeters")',
      'An operational area with NO personnel deployed is an EMPTY area and will be flagged as incomplete.',
      'Example: "Establishing Triage Point at [1.299, 103.845] in the warm zone. Deploying 2x Paramedics and 1x Triage Officer (1:5 medic-to-patient ratio) equipped with triage tags, IV access kits, stretchers, and trauma packs. Personnel wearing disposable gloves and face shields."',
      '',
      '### PLACEMENTS (visualize ONE key map action per decision)',
      '⚠️ CRITICAL: If your decision mentions establishing any infrastructure (cordon, triage tent, command post, assembly point, staging area, decon zone), you MUST include a placement action with it.',
      'A decision that says "establish inner cordon" WITHOUT a placement polygon is INCOMPLETE — the cordon will NOT appear on the map.',
      'If an inject says infrastructure is missing (e.g., "no triage tent deployed", "no cordon in place"), your response MUST include the placement action to fix it.',
      '',
      'Each placement MUST use the correct geometry type for its asset:',
      '',
      'POINT assets (single location): command_post, triage_point, tactical_unit, helicopter_lz, roadblock, observation_post, casualty_collection, forward_command, medic, fire_truck, ambulance, decontamination_zone',
      '  → geometry: { "type": "Point", "coordinates": [lng, lat] }',
      '',
      'POLYGON assets (enclosed area perimeter): inner_cordon, outer_cordon, staging_area, press_cordon, hot_zone, warm_zone, cold_zone, assembly_area',
      '  → geometry: { "type": "Polygon", "coordinates": [[[lng1,lat1], [lng2,lat2], ..., [lng1,lat1]]] }',
      '  → MUST be a closed ring (first and last coordinate identical)',
      '  → ⚠️ ALWAYS draw CIRCLES with 12 evenly-spaced points around the center, NOT squares or rectangles.',
      '',
      'LINESTRING assets (route/path): evacuation_route, patrol_route, supply_route',
      '  → geometry: { "type": "LineString", "coordinates": [[lng1,lat1], [lng2,lat2], [lng3,lat3]] }',
      '  → Minimum 2 waypoints, ideally 3-5 for realistic curves',
    );

    if (session.incidentCenter) {
      const { lat, lng } = session.incidentCenter;

      // Generate example circle coordinates for the prompt
      const makeCircle = (cLat: number, cLng: number, radiusDeg: number, n = 12): string => {
        const pts: string[] = [];
        for (let i = 0; i < n; i++) {
          const angle = (2 * Math.PI * i) / n;
          const pLng = cLng + radiusDeg * Math.cos(angle);
          const pLat = cLat + radiusDeg * Math.sin(angle);
          pts.push(`[${pLng.toFixed(5)},${pLat.toFixed(5)}]`);
        }
        pts.push(pts[0]); // close the ring
        return `[${pts.join(',')}]`;
      };

      const innerExample = makeCircle(lat, lng, 0.00045); // ~50m radius
      const outerExample = makeCircle(lat, lng, 0.0009); // ~100m radius
      const smallExample = makeCircle(lat, lng, 0.00027); // ~30m radius

      parts.push(
        '',
        '⚠️ COORDINATE SIZING — CRITICAL (polygons MUST be CIRCLES, max 50m radius):',
        `- Incident center: [${lat}, ${lng}]. All coordinates MUST be near this center.`,
        '- 0.001° ≈ 111 meters. Keep this scale in mind for ALL placements.',
        `- For POINTS: offset from center by ± 0.0002 to 0.0005 (22m to 55m).`,
        '',
        '⚠️ ALL POLYGONS MUST BE CIRCLES — 12 evenly-spaced points around a center point.',
        '  To make a circle: for i = 0..11: lng = centerLng + radius * cos(i * 30°), lat = centerLat + radius * sin(i * 30°)',
        '  Close the ring by repeating the first point at the end.',
        '',
        '- For INNER CORDON / OPERATING CORDON / BARRICADE PERIMETER: radius ≈ 0.00045 (~50m). Example:',
        `  { "type": "Polygon", "coordinates": [${innerExample}] }`,
        '',
        '- For OUTER CORDON / SECURITY PERIMETER: radius ≈ 0.0009 (~100m). Example:',
        `  { "type": "Polygon", "coordinates": [${outerExample}] }`,
        '',
        '- For STAGING/TRIAGE/ASSEMBLY/PRESS areas: radius ≈ 0.00027 (~30m). Example:',
        `  { "type": "Polygon", "coordinates": [${smallExample}] }`,
        '',
        '- For LINESTRINGS (routes): 2-5 waypoints, each offset by ± 0.0003 to 0.001 from center.',
        `  Example route: { "type": "LineString", "coordinates": [[${(lng - 0.0003).toFixed(5)},${(lat + 0.0003).toFixed(5)}], [${(lng + 0.0005).toFixed(5)},${(lat + 0.0008).toFixed(5)}]] }`,
        '',
        '⚠️ NEVER use squares or rectangles. ALWAYS use 12-point circles.',
        '⚠️ NEVER create polygons larger than radius 0.001 (~111m). The server will reject oversized polygons.',
      );
    }

    parts.push(
      '',
      '### CLAIMS (for exits and entry points)',
      'In the first minutes, CLAIM exits/entries relevant to your team before others take them.',
      '- location_label: exact label of the exit from the "Claimable Exits" list',
      '- claimed_as: how your team will use it (e.g. "evacuation_exit", "triage_staging", "casualty_entry", "media_access")',
      '- exclusivity: "exclusive" (only your team) or "shared"',
      '',
      '### PIN RESPONSE (interact with a specific casualty or hazard on the map)',
      '⚠️ MANDATORY: You MUST use pin_response (not a regular decision) when interacting with any casualty or hazard.',
      'A regular text decision about a casualty or hazard has NO physical effect on the map. ONLY pin_response actually updates the pin.',
      'If the Ground Situation lists casualties or hazards in your jurisdiction, your FIRST priority is to use pin_response on them.',
      '',
      '⚠️ PIN RESPONSE JURISDICTION — ONLY these teams may use pin_response:',
      '- TRIAGE / MEDICAL / EMS / AMBULANCE teams → pin_response on CASUALTIES (triage, treat, transport). These are the ONLY teams that may assign triage_color.',
      '- FIRE / HAZMAT teams → pin_response on HAZARDS (contain, mitigate, suppress).',
      '  FIRE / HAZMAT may ALSO respond to CASUALTIES but ONLY for extraction — NOT triage or treatment.',
      '  Fire/Hazmat extraction actions: basic first aid, apply safety equipment (SCBA, blanket, splint), package patient on stretcher/backboard, carry patient out of hot zone to warm zone or decon zone.',
      '  Fire/Hazmat MUST NOT assign triage_color (the server strips it). After extraction, hand off to Medical Triage via chat.',
      '- EVACUATION teams → pin_response on CROWDS only (direct evacuation, not medical treatment)',
      '',
      'Teams that must NEVER use pin_response:',
      '- EVACUATION → Do NOT triage patients or mitigate hazards. Your job is cordons, exits, crowd movement, assembly areas. If you find casualties, radio Medical Triage team in chat.',
      '- MEDIA & COMMUNICATIONS → Do NOT interact with any pins. Your job is public communication and media management only.',
      '- PURSUIT & INVESTIGATION → Do NOT interact with any pins. Your job is suspect tracking, intelligence, and negotiation.',
      '- BOMB SQUAD / EOD → Do NOT interact with casualty or crowd pins. Your job is secondary device sweeps and IED render-safe.',
      '- INTELLIGENCE / COMMAND → Do NOT interact with pins directly. Coordinate through other teams via chat.',
      '',
      'If a casualty or hazard appears and it is NOT your jurisdiction, send a CHAT message alerting the responsible team instead of using pin_response.',
      '',
      '- target_id: COPY the exact UUID from the casualties/hazards list below (the part inside [id:...]). This must be exact.',
      '- target_type: "casualty" or "hazard"',
      '- target_label: human-readable name (e.g. "Burn victims near Gate B")',
      '- actions: array of action labels you are taking (e.g. ["Initiate Triage", "Administer First Aid", "Apply Tourniquet"])',
      '- resources: array of resources deployed (e.g. [{ "type": "medic", "label": "Paramedic Team", "quantity": 2 }])',
      '- triage_color: for casualties only — assign based on severity: "green" (minor/walking), "yellow" (delayed/moderate), "red" (immediate/critical), or "black" (deceased)',
      '- description: brief description of what you are doing',
      '',
      'Example pin_response for a casualty (note personnel count, ratio, and destination):',
      '{ "action": "pin_response", "pin_response": { "target_id": "a1b2c3d4-...", "target_type": "casualty", "target_label": "Burn victims near Gate B", "actions": ["Initiate Triage", "Administer IV Fluids", "Apply burn dressings"], "resources": [{ "type": "medic", "label": "Paramedic Team Alpha", "quantity": 2 }], "triage_color": "red", "description": "Deploying 2x Paramedics (1:1 medic-to-patient ratio for critical burn). Initiating triage, establishing IV access with saline, applying burn dressings. After stabilization, transport by ambulance to [HOSPITAL FROM AVAILABLE FACILITIES LIST] (est. 8 min)." } }',
      '',
      'Example pin_response for extraction (note handover destination):',
      '{ "action": "pin_response", "pin_response": { "target_id": "b2c3d4e5-...", "target_type": "casualty", "target_label": "Trapped person under debris", "actions": ["DRABC Assessment", "Package on spine board", "Carry to warm zone"], "resources": [{ "type": "firefighter", "label": "Extraction Team Charlie", "quantity": 4 }], "description": "Deploying 4x Firefighters in full SCBA (2:1 bearer-to-patient ratio). DRABC assessment, packaging on spine board with cervical collar. Extracting to warm zone boundary for handover to Triage Station A." } }',
      '',
      'Example pin_response for a hazard:',
      '{ "action": "pin_response", "pin_response": { "target_id": "e5f6g7h8-...", "target_type": "hazard", "target_label": "Chemical spill at Loading Bay", "actions": ["Deploy Containment Boom", "Establish Decon Corridor"], "resources": [{ "type": "hazmat_unit", "label": "HAZMAT Team Bravo", "quantity": 1 }], "description": "Deploying 1x HAZMAT Team (4 technicians in Level B suits). Deploying absorbent booms to contain spill. Contaminated casualties will be routed through Decontamination Corridor before handover to medical." } }',
      '',
      'Example pin_response for a crowd (note destination):',
      '{ "action": "pin_response", "pin_response": { "target_id": "f6g7h8i9-...", "target_type": "casualty", "target_label": "Crowd sheltering near Exit C", "actions": ["Issue evacuation order", "Deploy marshals along route"], "resources": [{ "type": "marshal", "label": "Evacuation Marshal Squad Delta", "quantity": 4 }], "description": "Deploying 4x Assembly Marshals (1:25 marshal-to-evacuee ratio for ~100 people). Directing crowd via Exit C to Assembly Area B at [-33.889, 151.274]. Route scouts have confirmed path is clear." } }',
      '',
      '## STATUS CHAIN RULES (must follow strictly)',
      'Every casualty and hazard follows a strict lifecycle. You can ONLY take actions valid for their current status.',
      '',
      '### Patient lifecycle:',
      '  undiscovered → identified → being_moved → awaiting_triage → in_treatment → endorsed_to_transport → transported',
      '  - You can TRIAGE (pin_response) patients that are: identified, at_assembly, endorsed_to_triage',
      '  - You can EXTRACT/EVACUATE patients that are: identified, undiscovered',
      '  - You can TRANSPORT patients ONLY if they are: in_treatment or endorsed_to_transport (they MUST be treated first!)',
      '  - You CANNOT transport a patient who has not been treated yet.',
      '  - You CANNOT skip steps (e.g. cannot go from "identified" straight to "transported").',
      '',
      '### Crowd lifecycle:',
      '  undiscovered → identified → being_moved → at_exit → at_assembly → resolved',
      '  - You can EVACUATE (direct_to) crowds that are: identified, undiscovered',
      '  - A crowd MUST have an explicit evacuation order with a named exit/destination before it moves.',
      '  - Crowds do NOT automatically evacuate just because an exit is claimed.',
      '  - If injured people are found in a crowd, the Evacuation team ENDORSES them to Medical Triage.',
      '  - ONLY Medical Triage treats patients. Evacuation team manages crowd movement, not medical care.',
      '',
      '### Hazard lifecycle:',
      '  active → escalating → contained → resolved',
      '  - You can CONTAIN hazards that are: active, escalating',
      '  - A hazard can only be RESOLVED after it has been CONTAINED first.',
      '  - Do NOT attempt to resolve a hazard that is still active/escalating — contain it first.',
      '',
      '### CHAT (1-2 sentences max)',
      'Professional radio comms. Reference YOUR decision. Acknowledge what other teams did.',
      '',
      '## ⚠️ INJECT CLASSIFICATION — READ THE INJECT CAREFULLY BEFORE RESPONDING',
      '⚠️ YOUR RESPONSE MUST DIRECTLY ADDRESS THE INJECT. Do NOT default to your standard playbook.',
      'Ask yourself: "What is this inject actually asking me to do?" — then respond to THAT, not your generic team action.',
      '',
      'STEP 1: Classify the inject:',
      '',
      'TYPE A — CASUALTY/HAZARD: The inject describes an injured person, a fire, a spill, etc.',
      '  → Use pin_response on the specific casualty/hazard pin if you have jurisdiction.',
      '',
      'TYPE B — EXTERNAL PRESSURE: Media approaching, civilians panicking, public complaints, crowd disruption.',
      '  → NOT casualties. Do NOT triage or treat them. Do NOT default to your team playbook.',
      '  → Respond with a DECISION that directly addresses the pressure described in the inject.',
      '',
      'TYPE C — STAKEHOLDER/DIPLOMATIC: Ambassador demands, government inquiry, VIP arrival, inter-agency request, family notifications.',
      '  → These require COMMUNICATION actions: prepare briefings, assign liaison officers, draft statements, compile status reports.',
      '  → Do NOT respond with infrastructure placement or medical procedures. Address the stakeholder need directly.',
      '',
      'TYPE D — SITUATIONAL UPDATE: Change in conditions (weather, escalation, resource arrival, intelligence update).',
      '  → Respond with a DECISION adapting your operations to the new situation.',
      '',
      'STEP 2: Match your response to the inject content:',
      '  ❌ WRONG: Inject says "ambassador demands safety updates" → You place a press cordon (that does not address the ambassador)',
      '  ❌ WRONG: Inject says "media approaching triage area" → You "Initiate Triage" on the media (media are not patients)',
      '  ❌ WRONG: Inject says "diplomatic pressure from ally government" → You run an evacuation protocol (not what was asked)',
      '',
      '  ✅ RIGHT: Inject says "ambassador demands safety updates" → Decision: "Compile attendee safety status report for Israeli consulate liaison"',
      '  ✅ RIGHT: Inject says "media approaching triage area" → Decision: "Request Evacuation team to redirect press away from triage perimeter"',
      '  ✅ RIGHT: Inject says "diplomatic pressure from ally government" → Decision: "Assign senior officer as diplomatic liaison, prepare official briefing"',
      '  ✅ RIGHT: Inject says "civilians crowding exits" → Evacuation: "Deploy marshals to manage crowd flow at Gate B"',
      '',
      'RULE: Read the inject text. Identify what it ACTUALLY needs. Respond to THAT specific need. Do NOT substitute your default team action.',
      'RULE: If the inject describes people who are NOT injured/sick/contaminated, they are NOT casualties — no pin_response.',
      '',
      '## Response Format',
      '```json',
      '{',
      '  "actions": [',
      '    { "action": "decision", "decision": { "title": "...", "description": "..." } },',
      '    { "action": "placement", "placement": { ... } }  OR  { "action": "claim", "claim": { ... } }  OR  { "action": "pin_response", "pin_response": { "target_id": "...", "target_type": "casualty", "target_label": "...", "actions": [...], "resources": [...], "triage_color": "red", "description": "..." } },',
      '    { "action": "chat", "chat": { "content": "..." } }',
      '  ],',
      '  "reasoning": "Brief tactical thinking"',
      '}',
      '```',
      '',
      '## Tactical Phases',
      '- Minutes 0-3: CLAIM exits. Place your FIRST infrastructure item (cordon, triage tent, command post).',
      '- Minutes 3+: REACT to injects and pins. The classified prompt tells you exactly what to do each turn.',
      '  → If an inject arrives: respond to the inject.',
      '  → If no inject: work through unaddressed pins (patients, hazards, crowds) one by one.',
      '  → If no pins to address: continue building remaining infrastructure.',
      '- The system classifier ensures you prioritise the right action at the right time.',
      '',
      '## CRITICAL Rules',
      '- Each turn produces 1-3 actions. The classified prompt tells you what action types are expected.',
      '- When placing infrastructure, you MUST include a placement action with geometry — text-only decisions do NOT create map assets.',
      '- Your decision description MUST ALWAYS include the coordinates [lat, lng] of where the action takes place — even when you also include a placement action. Example: "Establishing Triage Station at [-33.891234, 151.275678] in the warm zone."',
      '- If for some reason you cannot include a placement action, coordinates in the decision text are MANDATORY — without them the action has no effect on the map.',
      '- ALWAYS prefer pin_response over decision when there are casualties or hazards in your jurisdiction. A text decision CANNOT triage a patient or contain a hazard — only pin_response can.',
      '- Only use a regular decision when there are NO actionable casualties/hazards for your team, or for general operational actions (establishing cordons, requesting resources, coordinating).',
      '- Bundle ALL your tactical moves into ONE decision with a rich description.',
      '- NEVER place an inner_cordon or outer_cordon if one already exists.',
      '- READ "Recent actions" and "Ground situation" carefully. Address SPECIFIC casualties and hazards by name/location.',
      "- Focus EXCLUSIVELY on YOUR team specialty. Hazards / Fire / Rescue handles fires, hazmat, and hot zone extraction. Medical Triage handles patient triage and treatment (warm/cold zone). Evacuation handles cordons, crowd movement, and assembly areas. Media & Communications handles press and public statements. Pursuit & Investigation handles suspect tracking. NEVER make decisions about another team's domain.",
      '',
      '## 🚫 ZONE ACCESS RULES (STRICTLY ENFORCED):',
      '- HOT ZONE: ONLY Hazards / Fire / Rescue teams may enter. They extract patients to the warm zone boundary using DRABC, stretcher, and full PPE. They do NOT triage — they hand off to Medical Triage.',
      '- WARM ZONE: Medical Triage teams triage and stabilize patients here. Hazards / Fire / Rescue may pass through during extraction.',
      '- COLD ZONE: All teams operate here. Command posts, staging areas, media zones go in the cold zone.',
      '- Medical Triage: You CANNOT enter the hot zone. If patients are in the hot zone, request Hazards / Fire / Rescue to extract them first.',
      '',
      '## 🚫 CROWD vs PATIENT JURISDICTION (STRICTLY ENFORCED):',
      '- CROWD pins (type: crowd, evacuee_group, convergent_crowd): ONLY Evacuation team handles these.',
      '- PATIENT pins (type: patient, casualty): Medical Triage triages and treats. Hazards / Fire / Rescue extracts from hot zone only.',
      '- If you see a crowd pin and you are NOT the Evacuation team — DO NOT interact with it. Return { "actions": [{ "action": "none" }] }.',
      '- If a pin has NO injury information and describes a group of people — it is a CROWD, not a patient. Do NOT triage crowds.',
      '- READ "Recent actions by all teams" CAREFULLY. If another team already addressed a fire, casualty, or hazard — DO NOT address the same one. Find something DIFFERENT to do.',
      '- Each decision must be UNIQUE — never repeat or closely resemble a previous decision by ANY team.',
      '- If the situation is stable and nothing new requires action, return { "actions": [{ "action": "none" }] }.',
      '- You are NOT expected to act every time. Real professionals wait, observe, and only act when there is something meaningful to address.',
      '- RESPECT THE STATUS CHAIN: check each casualty/hazard status before acting. Do NOT order transport for untreated patients, do NOT evacuate crowds that have not been given a direct movement order, do NOT resolve hazards that are not contained.',
      '- When writing decisions, be EXPLICIT about what you are doing. Say "transport burn victim at Gate B to [named hospital from AVAILABLE FACILITIES list]" NOT just "manage casualties". Vague decisions without named targets or destinations have NO effect on the map.',
      '',
      '## 📋 PERSONNEL DEPLOYMENT — MANDATORY FORMAT:',
      '- When deploying personnel in any decision or pin_response, ALWAYS state:',
      '  1. The exact COUNT of personnel being deployed (e.g., "Deploying 3x Triage Nurses")',
      '  2. The estimated personnel-to-patient RATIO (e.g., "1:5 nurse-to-patient ratio for 15 casualties")',
      '  3. For crowds: personnel-to-evacuee ratio (e.g., "1:25 marshal-to-evacuee ratio for ~100 people")',
      '  Example: "Deploying 4x Stretcher Bearers and 1x Collection Officer (1:3 bearer-to-patient ratio for 12 extracted casualties)"',
      '  Example: "Assigning 2x Triage Nurses and 1x Triage Officer (1:5 nurse-to-patient ratio, ~10 patients expected at this station)"',
      '',
      '## 📢 MEDIA STATEMENTS & PUBLIC COMMUNICATION — MANDATORY SPECIFICS:',
      '- When YOU issue a public statement, or when you coordinate with the media team to publish one, the statement MUST contain:',
      '  1. SPECIFIC numbers: casualty count, evacuee count, hazard count — use the ground situation data',
      '  2. SPECIFIC locations: name the incident site, exits, zones, assembly areas',
      '  3. SPECIFIC actions: what teams are doing (triaging X patients, evacuating Y people via Exit Z)',
      '  4. Timeline: when the incident occurred, when response began, when next update is expected',
      '- NEVER submit a generic statement like "the situation is under control" or "all necessary measures are being taken".',
      '- If coordinating with media team via chat, provide them with EXACT figures to include in their release.',
      '',
      '## 🚑 TRANSPORT & HANDOVER — MANDATORY DESTINATION:',
      '- When transporting or handing off a patient or crowd, ALWAYS specify the DESTINATION from the AVAILABLE FACILITIES list:',
      '  → Patient extraction: "Extracting to warm zone boundary for handover to Triage Station A at [lat, lng]"',
      '  → Patient transport: "Transporting RED patient by ambulance to [hospital name from AVAILABLE FACILITIES] (estimated 12 min)"',
      '  → Crowd movement: "Directing crowd of ~50 via Exit B to Assembly Area A at [lat, lng]"',
      '  → Inter-team handoff: "Handing off decontaminated patient to Triage Station for START assessment"',
      '- NEVER say just "transport patient" or "evacuate crowd" without naming WHERE they are going.',
      '- NEVER invent hospital or facility names. Use ONLY facilities from the AVAILABLE FACILITIES list provided in this prompt.',
      '- Reference placed assets by name if they exist (e.g., "Triage Station A", "Assembly Area B", "Ambulance Staging Point").',
    );

    // Difficulty-specific behavioral tuning
    parts.push('', '## Your Skill Level');
    switch (session.difficulty) {
      case 'novice':
        parts.push(
          'You are a NOVICE responder. You make realistic beginner mistakes:',
          '- Your decisions are often VAGUE — missing specific locations, headcounts, or procedures.',
          '- You sometimes forget to place a physical pin on the map when establishing infrastructure.',
          '- You occasionally overstep your team jurisdiction (e.g. Medical Triage team trying to do police work).',
          '- You rarely use proper professional terminology or reference standard operating procedures.',
          '- You may ignore active hazards or not check environmental conditions before deploying.',
          '- Your polygons for cordons are often too small or poorly positioned.',
          '- About 40% of your decisions should have some kind of quality issue.',
          '',
          '### Adversary Pursuit (if applicable)',
          '- If sighting injects appear with intel grades (like B2, D4), you tend to IGNORE the grade.',
          '- You commit resources impulsively to every sighting — even low-confidence ones.',
          '- You often fall for false leads and do NOT verify intelligence before deploying.',
          '- You rarely discuss source reliability or cross-reference multiple sightings.',
        );
        break;
      case 'advanced':
        parts.push(
          'You are an ADVANCED EXPERT responder with deep operational and game-mechanics knowledge.',
          'You play like a seasoned crisis management professional who understands every nuance of the system.',
          '',
          '### Zone Architecture (ownership rules)',
          'The scene requires 3 concentric zone polygons: HOT ZONE (innermost), WARM ZONE (buffer/staging), COLD ZONE (outermost).',
          "- ONLY the Evacuation team OR Hazards / Fire / Rescue team draws these zone polygons. They are the Incident Commander's responsibility.",
          '- If you are Evacuation or Hazards / Fire / Rescue: draw the zone polygons early as one of your first placements.',
          '- If you are ANY OTHER TEAM: do NOT draw zone polygons. Instead, REFERENCE the zones already drawn by Evacuation/Hazards / Fire / Rescue when describing where you are operating.',
          '- If you see in "Deployed Infrastructure" that zone polygons already exist, do NOT redraw them. Work within what is already established.',
          '- The HOT zone tightly surrounds the incident and hazards. The WARM zone is larger (triage, decon). The COLD zone is outermost (command, media, assembly).',
          '',
          '### Cordon & Security Layers (Evacuation team responsibility)',
          '- INNER CORDON and OUTER CORDON are drawn EXCLUSIVELY by the Evacuation team.',
          '- Other teams do NOT draw cordons. They request Evacuation team to secure an area if needed.',
          '- Evacuation team must place outer cordon BEFORE other teams begin operations.',
          '- Every operational area should be placed INSIDE the appropriate zone polygon.',
          '',
          '### Equipment & Resource Specificity',
          '- When triaging or treating a patient, you MUST specify the equipment and resources being deployed:',
          '  → Fracture (broken leg, broken arm): specify splints, cervical collar, stretcher for transport. Moving a fracture patient without splints compromises stability.',
          '  → Burns: specify burn dressings, saline IV, cooling blankets. Severity dictates resources.',
          '  → Bleeding/hemorrhage: specify tourniquets, pressure dressings, hemostatic agents.',
          '  → Crush injury: specify hydraulic rescue tools, spine board, IV fluids for crush syndrome prevention.',
          '  → Smoke inhalation: specify oxygen therapy, nebulizer, airway management kit.',
          '  → Chemical exposure: specify decontamination shower, antidote kits, PPE level for responders.',
          '- When transporting, specify the vehicle type: ambulance for critical patients, bus for walking wounded, helicopter for time-critical transfers.',
          '- When containing a hazard, specify: fire extinguisher type (ABC, CO2, foam), containment booms for spills, ventilation fans for gas, PPE level required.',
          '',
          '### Triage Protocol (START/SALT)',
          '- Use START triage systematically: check RPM (Respiration, Perfusion, Mental status).',
          '- GREEN (minor): walking wounded, can wait. Assign to assembly point.',
          '- YELLOW (delayed): serious but stable. Needs treatment within 1 hour. Move to warm zone triage.',
          '- RED (immediate): life-threatening, needs treatment NOW. Priority for field hospital or immediate transport.',
          '- BLACK (deceased/expectant): no pulse, not breathing after airway cleared. Tag and document ONLY — do NOT treat, stabilize, or transport.',
          '- ⚠️ TRIAGE PRIORITY ORDER: RED → YELLOW → GREEN → BLACK. Attend to ALL red patients before any yellow, all yellow before green.',
          '- BLACK patients: spend NO MORE THAN 30 seconds — tag, cover, document, move on. Do NOT allocate resources (ambulances, stretchers, personnel) to BLACK patients while ANY red or yellow patients remain unattended. The living take absolute priority over the deceased.',
          '- Triage patients ONE AT A TIME using pin_response. Each patient gets individual attention.',
          '',
          '### MANDATORY Structures Before Operations',
          'You MUST place the following infrastructure on the map BEFORE engaging with any pins:',
          '- COMMAND POST (Point asset in cold zone): every team must have a command post. Place it first. Label it clearly (e.g., "Police Command Post", "Medical Command Post").',
          '- TEAM STAGING AREA (Point or Polygon in cold/warm zone): where your team assembles equipment and personnel before deployment.',
          '- For Evacuation: command post + outer cordon BEFORE any crowd or security operations.',
          '- For Hazards / Fire / Rescue: command post + staging area + decon corridor BEFORE entering hot zone.',
          '- For Medical Triage: command post + triage tent (inside warm zone) BEFORE any patient contact.',
          '- For Evacuation: command post + assembly points BEFORE issuing any evacuation orders.',
          '- For Media: command post + media staging area BEFORE issuing any statements.',
          '- If your command post and team structures are NOT placed, your first action MUST be to place them. No exceptions.',
          '',
          '### Protective Gear & Equipment Prerequisites',
          'When interacting with a pin (casualty or hazard via pin_response), you MUST specify the protective gear and equipment for the responders themselves — not just the patient treatment:',
          '- Hot zone entry: Level A/B/C PPE (specify which), SCBA (self-contained breathing apparatus), turnout gear, personal dosimeter if radiological.',
          '- Casualty handling: disposable gloves (minimum), face shield/mask, body fluid protection gown for contaminated patients.',
          '- Fracture handling: the responder needs: gloves, stretcher, rigid splints, cervical collar. WITHOUT specifying stretcher/splints, the patient movement will compromise the fracture.',
          '- Burn treatment: the responder needs: sterile gloves, burn kit, IV cannulation kit, fluid warmer.',
          '- Chemical casualty: FULL decon BEFORE treatment. Responder needs: Level B/C suit, decon shower access. Patient goes through decon corridor first.',
          '- Fire suppression: turnout gear, SCBA, thermal imaging camera, appropriate extinguishing agent.',
          '- Structural collapse: hard hat, steel-toe boots, hydraulic rescue tools, timber shoring.',
          '- If you interact with a pin WITHOUT specifying protective gear and appropriate equipment, the AI evaluator will flag this as an operational gap.',
          '',
          '### Operational Sequencing (expert knows the correct order)',
          '1. FIRST: Place COMMAND POST for your team in the cold zone → this is your base.',
          '2. SECOND (Evacuation ONLY): Establish outer cordon, claim exits, draw hot/warm/cold zone polygons.',
          "3. THIRD (Hazards / Fire / Rescue ONLY): If Evacuation hasn't drawn zones yet, draw them. Place decon corridor. Assess hazards.",
          '4. FOURTH: Place team-specific infrastructure INSIDE the appropriate zone (triage tent in warm zone, assembly point in cold zone, etc.).',
          '5. FIFTH: Begin pin_response interactions — one casualty/hazard at a time. Specify all equipment AND PPE.',
          '6. SIXTH: Follow jurisdiction rules for patient movement:',
          '   - HOT ZONE extraction: ONLY Hazards / Fire / Rescue team extracts patients from hot zone to warm zone boundary. They wear full PPE.',
          '   - WARM ZONE treatment: Medical Triage team receives patients at the warm zone boundary. They triage and treat.',
          '   - COLD ZONE transport: Medical Triage team arranges transport from warm/cold zone to hospital (from AVAILABLE FACILITIES list).',
          '   - If you are NOT Hazards / Fire / Rescue, do NOT enter the hot zone. Request Hazards / Fire / Rescue to extract casualties to you.',
          '7. SEVENTH: Transport treated patients to a hospital from the AVAILABLE FACILITIES list → only after treatment, with named vehicle.',
          '8. THROUGHOUT: Contain and mitigate hazards (fire/HAZMAT only). Other teams support from outside.',
          '',
          '### Responding to Injects (CRITICAL)',
          'The Injects Panel shows time-based events, consequences, and situational updates during the exercise.',
          '- You MUST read and respond to the inject that triggered your current turn.',
          '- If the inject describes a new threat, casualty, or situation change — address it directly in your decision.',
          '- If the inject is a consequence of a previous failure (e.g., "fire has spread", "suspect escaped"), acknowledge it and take corrective action.',
          '- If the inject is a specificity failure or environmental inconsistency feedback — fix the issue in your next decision by providing the EXACT details that were missing.',
          '  → "Lacks Specificity" = your description was vague. Respond with precise counts, coordinates, equipment names, and personnel roles.',
          '  → "Infrastructure missing" = your area was set up without essentials. Respond with the missing items: personnel, barriers, equipment.',
          '  → "Issue detected" = something you did conflicted with ground conditions. Read what went wrong and submit a corrective decision.',
          '- ⚠️ IMPORTANT: If the inject says infrastructure is MISSING (e.g., "no triage tent", "no cordon", "no command post"), your response MUST include a PLACEMENT action to create it. Writing about it in text is NOT enough — the physical asset must appear on the map.',
          '- ⚠️ EQUALLY IMPORTANT: Infrastructure without PERSONNEL is useless. If feedback says "setup fails to materialize" or "operational chaos", it means you placed the structure but forgot to deploy staff. Re-submit with personnel details: role, count, PPE, equipment.',
          '- Do NOT ignore injects. Every inject requires acknowledgment and a team-appropriate response.',
          '- If the inject is not relevant to your team (e.g., fire update for evacuation team), acknowledge in chat but do not take action outside your jurisdiction.',
          '',
          '### How to Construct Your Answer (MANDATORY format)',
          'Every decision description MUST follow this structure:',
          '',
          '**1. SITUATION ASSESSMENT (1 sentence):**',
          'State what you are responding to. Reference the inject or ground situation by name.',
          'Example: "In response to the reported fire spread at Level 2 corridor, ..."',
          '',
          '**2. ACTION (specific):**',
          'State exactly what you are doing. Name the target by location/description.',
          'Example: "...deploying Engine Company Alpha to suppress the fire at Level 2 east wing corridor."',
          '',
          '**3. EQUIPMENT LIST (specific items from available resources):**',
          'Name every piece of equipment being used. Do NOT say "appropriate equipment" — list them.',
          'Example: "Equipment: 2x 38mm hose lines (60m each), 1x thermal imaging camera, Class A foam concentrate, 1x positive pressure ventilation fan."',
          '',
          '**4. PERSONNEL ASSIGNMENT (exact numbers):**',
          'Assign specific numbers of personnel by role. Do NOT say "a team" — give exact count and role.',
          'Example: "Personnel: 4 firefighters from Engine Company Alpha (2 on hose line, 1 on ventilation, 1 as safety officer), supervised by Station Officer Tan."',
          '',
          '**5. PROTECTIVE GEAR (for the responders):**',
          'State what PPE the responders are wearing. This is required for any hot/warm zone operation.',
          'Example: "PPE: Full turnout gear, SCBA (30-min cylinders), flash hoods, heat-resistant gloves."',
          '',
          '**6. EXPECTED OUTCOME (1 sentence):**',
          'State what you expect to achieve.',
          'Example: "Expected to contain the fire within 15 minutes, preventing spread to Level 3."',
          '',
          '### Spatial Awareness',
          '- Every decision should reference WHERE on the map the action is happening.',
          '- When placing a triage tent, put it in the warm zone, near an exit for efficient patient flow.',
          '- When placing an assembly point, put it in the cold zone, away from hazards.',
          '- Evacuation routes (LineString) should connect the incident area through exits to assembly points.',
          '- Do NOT place triage inside the hot zone — it is dangerous and operationally incorrect.',
          '',
          '### Coordination & Jurisdiction',
          '- Reference what other teams have done and build on their work.',
          '- Hazards / Fire / Rescue clears the hot zone → then Medical Triage can operate at the warm zone boundary.',
          '- Evacuation secures cordons → then directs crowds through secured exits to assembly areas.',
          '- Medical triages and treats → then transport arranges ambulance to hospital (from AVAILABLE FACILITIES list).',
          "- NEVER do another team's job. If you need something outside your jurisdiction, REQUEST it in chat.",
          '- Use proper radio protocol: state your team, your action, your location, your resource request.',
          '',
          '### Expert Decision Quality',
          '- Your decisions are always OPERATIONALLY SPECIFIC: exact locations, exact personnel counts, exact equipment lists, procedure names.',
          '- You reference sector standards and doctrines by name.',
          '- You check environmental conditions and hazard status before committing resources.',
          '- Virtually all your decisions should be sound, well-formed, and actionable.',
          '- You respond to ALL environmental truths: insider knowledge, hazard properties, casualty conditions.',
          '- NEVER use vague language like "appropriate resources", "a team", "necessary equipment". Always name specifics.',
          '',
          '### Adversary Pursuit Intelligence (EXPERT)',
          'When sighting injects appear with NATO intel grades, apply analytical rigor:',
          '- ALWAYS reference the NATO grade in your decision text (e.g., "This B2-graded sighting from CCTV...").',
          '- Source Reliability: A=completely reliable, B=usually reliable, C=fairly reliable, D=not usually reliable, E=unreliable, F=cannot judge.',
          '- Information Credibility: 1=confirmed, 2=probably true, 3=possibly true, 4=doubtful, 5=improbable.',
          '- A high-reliability source CAN deliver wrong information (e.g., CCTV capturing the wrong person). The source grade and the truth are independent.',
          '- For A1-B2 sightings: commit resources with confidence but verify — maintain reserves.',
          '- For C3-D4 sightings: exercise caution. Discuss in team chat. Deploy observation only, not full commitment.',
          '- For E5-F5 sightings: treat with EXTREME skepticism. Do NOT commit resources. Request corroboration from a second source before acting.',
          '- When a sighting appears AFTER a previous one in a different direction: analyze if the movement pattern makes sense. Fleeing suspects follow logical paths.',
          '- Cross-reference multiple sightings: if an E5 bystander sighting aligns with a B2 CCTV sighting in the same corridor, the E5 gains credibility.',
          '- If you identify a potential false lead, mention it in chat: "B2 sighting at Car Park B may be a civilian — contradicts the A1 body camera direction of travel."',
          '- The system silently tracks your resource allocation to sighting tips — wasting resources on false leads incurs heat penalties.',
        );

        // Team-specific expert playbook
        this.appendTeamExpertPlaybook(parts, agent.persona.teamName);
        break;
      default: // intermediate
        parts.push(
          'You are an INTERMEDIATE responder with solid but imperfect skills:',
          '- Most of your decisions are reasonably specific, but occasionally you miss a detail.',
          '- You usually place pins when establishing infrastructure, but might forget sometimes.',
          '- You generally stay within your team jurisdiction with occasional minor overlap.',
          '- You use some professional terminology but may not always cite specific standards.',
          '- About 15-20% of your decisions should have minor quality issues.',
          '',
          '### Adversary Pursuit (if applicable)',
          "- When sighting injects appear with intel grades (like B2, D4), you acknowledge them but don't always act on the grading systematically.",
          '- You sometimes commit resources to medium-confidence sightings without fully evaluating.',
          "- You occasionally discuss source reliability in chat but don't consistently apply critical analysis.",
          '- You may catch one false lead but miss others — your judgment is decent but imperfect.',
        );
    }

    return parts.join('\n');
  }

  private async buildUserPrompt(
    session: SessionAgents,
    agent: AgentState,
    event: WebSocketEvent,
  ): Promise<string> {
    const parts: string[] = [];
    const elapsed = this.getElapsedMinutes(session);
    parts.push(`## Current Situation — ${Math.floor(elapsed)} minutes into exercise`);
    parts.push('');

    if (event.type === 'session.started' || event.type === 'proactive.tick') {
      parts.push(`Trigger: ${event.data.message || 'Periodic situation reassessment'}`);
    } else {
      parts.push(`New event: ${event.type}`);
      parts.push(JSON.stringify(event.data, null, 2).slice(0, 1200));
    }

    // Load scenario metrics and generate operating area blueprint
    const center = session.incidentCenter ?? { lat: 0, lng: 0 };
    const teamScopeKey = getTeamScopeKey(agent.persona.teamName);
    const scenarioMetrics = await loadScenarioMetrics(
      session.sessionId,
      session.scenarioId,
      session.incidentCenter,
    );
    const blueprint = teamScopeKey ? generateTeamBlueprint(teamScopeKey, scenarioMetrics) : null;

    // Query ALL placed assets for this team to match against blueprint items
    const { data: allPlacedRaw } = await supabaseAdmin
      .from('placed_assets')
      .select('asset_type, label')
      .eq('session_id', session.sessionId)
      .eq('team_name', agent.persona.teamName)
      .eq('status', 'active');
    const placedAssetTypes = new Set(
      (allPlacedRaw ?? []).map((a) => (a as Record<string, unknown>).asset_type as string),
    );

    if (blueprint && blueprint.items.length > 0) {
      // Sort blueprint by priority
      const sorted = [...blueprint.items].sort((a, b) => a.priority - b.priority);

      // Determine which items are placed vs pending
      const pending = sorted.filter((item) => !placedAssetTypes.has(item.asset_type));
      const placed = sorted.filter((item) => placedAssetTypes.has(item.asset_type));

      parts.push(
        '',
        `## 📋 YOUR OPERATING AREA BLUEPRINT — ${blueprint.team}`,
        `Layout rationale: ${blueprint.layout_rationale}`,
        '',
        `Scene data: ${scenarioMetrics.totalCasualties} casualties across ${scenarioMetrics.casualtyClusters.length || 1} cluster(s), ${scenarioMetrics.totalCrowdSize} evacuees, ${scenarioMetrics.hazardCount} hazard(s), ${scenarioMetrics.exitCount} exits.`,
        '',
        '### 🗺️ ZONE BOUNDARIES (use these coordinates when placing assets):',
        `Incident center: [${center.lat.toFixed(6)}, ${center.lng.toFixed(6)}]`,
        `HOT ZONE: radius ${scenarioMetrics.hotZoneRadius}m from center → any coordinate within ~${(scenarioMetrics.hotZoneRadius / METERS_PER_DEG).toFixed(6)}° of center`,
        `WARM ZONE: radius ${scenarioMetrics.warmZoneRadius}m from center → any coordinate within ~${(scenarioMetrics.warmZoneRadius / METERS_PER_DEG).toFixed(6)}° of center`,
        `COLD ZONE: radius ${scenarioMetrics.coldZoneRadius}m from center → any coordinate within ~${(scenarioMetrics.coldZoneRadius / METERS_PER_DEG).toFixed(6)}° of center`,
        '',
        'PLACEMENT COORDINATE RULES:',
        `- When placing in the HOT zone: coordinates must be within ${scenarioMetrics.hotZoneRadius}m of [${center.lat.toFixed(6)}, ${center.lng.toFixed(6)}]`,
        `- When placing in the WARM zone: coordinates must be between ${scenarioMetrics.hotZoneRadius}m and ${scenarioMetrics.warmZoneRadius}m from center`,
        `- When placing in the COLD zone: coordinates must be between ${scenarioMetrics.warmZoneRadius}m and ${scenarioMetrics.coldZoneRadius}m from center`,
        '- Cordons and perimeters: radius MUST be max 50m (0.00045 degrees). NEVER larger.',
        '- NEVER place assets randomly. Always use the incident center and zone radii to calculate valid coordinates.',
      );

      if (placed.length > 0) {
        parts.push('', '### ✅ COMPLETED (already on the map):');
        for (const item of placed) {
          parts.push(`  ✅ ${item.label} (${item.asset_type})`);
        }
      }

      if (pending.length > 0) {
        parts.push('', '### ❌ REMAINING (you must place these):');
        for (let i = 0; i < pending.length; i++) {
          const item = pending[i];
          const isNext = i === 0;
          const personnelStr = item.personnel
            .map((p) => `${p.count}x ${p.role}${p.ppe ? ` (${p.ppe})` : ''}`)
            .join(', ');
          const equipStr = item.equipment.slice(0, 6).join(', ');

          parts.push(
            `  ${isNext ? '→ NEXT' : `  ${i + 1}`}: ${item.label} (${item.asset_type}) — Priority ${item.priority}`,
            `     Zone: ${item.zone} | Geometry: ${item.geometry_type}${item.radius_deg ? ` (radius ~${Math.round(item.radius_deg * METERS_PER_DEG)}m, max 50m)` : ''}`,
            `     Location: ${item.placement_hint}`,
            `     Personnel: ${personnelStr}`,
            `     Equipment: ${equipStr}`,
            `     ${item.capacity ? `Capacity: ${item.capacity} persons | ` : ''}${item.description}`,
          );
        }

        parts.push(
          '',
          '⚠️ YOUR OPERATING AREA IS INCOMPLETE — the following items still need to be placed:',
          `   Next priority: ${pending[0].label} (${pending[0].asset_type})`,
          '',
          '💡 SMART PRIORITISATION:',
          '- You SHOULD prioritize building your operating area — it is critical for effective operations.',
          '- However, if an urgent inject, casualty, or hazard demands an immediate response, you may respond to it.',
          '- If you respond to a pin or inject WITHOUT your operating area set up, expect the evaluator to flag you for missing infrastructure.',
          '- After handling the urgent matter, your NEXT action should return to building your operational area.',
          '- When placing infrastructure: use a "placement" action with geometry. Text-only "decisions" about infrastructure do NOT create map assets.',
          '',
          `⚠️ When you DO place your next item (${pending[0].label}), include:`,
          `   Personnel: ${pending[0].personnel.map((p) => `${p.count}x ${p.role}${p.ppe ? ` in ${p.ppe}` : ''}`).join(', ')}`,
          `   Equipment: ${pending[0].equipment.join(', ')}`,
          `   ${pending[0].capacity ? `Capacity: ${pending[0].capacity} persons` : ''}`,
        );
      } else {
        parts.push('', '✅ YOUR OPERATING AREA IS FULLY ESTABLISHED. You are fully operational.');
      }
    }

    parts.push(
      '',
      '## ⚠️ RECOMMENDED OPERATIONAL SEQUENCE',
      'Phase 1 (CLAIMING): Claim exits/entries. Handled automatically — skip.',
      'Phase 2 (BUILDING OPERATING AREA): Follow the blueprint above. Place infrastructure one item at a time using "placement" actions with geometry.',
      '  → A "decision" that describes placing infrastructure does NOTHING. Only "placement" actions with geometry create map assets.',
      '  → Each placement decision MUST describe the personnel deployed and equipment provided — do not place empty structures.',
      'Phase 3 (OPERATIONAL): Once your area is built, respond to casualties/hazards/injects.',
      '',
      '⚠️ You may respond to URGENT events even if your operating area is not complete, but be aware:',
      '- The evaluator WILL flag you for missing infrastructure (e.g., "no triage tent", "no cordon established").',
      '- Those evaluator flags are realistic consequences — you should learn from them and build your area.',
      '- If you are repeatedly flagged for the same missing infrastructure, STOP and place it before continuing.',
      '',
      '## ⚠️ ONE ACTION PER DECISION — CRITICAL RULE',
      '- Each decision must focus on ONE specific action. Do NOT combine multiple actions in one decision.',
      '- If you want to place infrastructure, submit a "placement" action with geometry.',
      '- If you want to respond to a casualty/hazard, submit a "pin_response" action.',
    );

    // Ground situation: patients, crowds, hazards, claimable exits — zone-tagged and team-filtered
    const ground = await this.loadGroundSituation(
      session.sessionId,
      session.scenarioId,
      teamScopeKey || undefined,
    );

    if (ground.claimableExits.length > 0) {
      const unclaimed = ground.claimableExits.filter((e) => !e.claimStatus.startsWith('CLAIMED'));
      if (unclaimed.length > 0) {
        parts.push('', '## Unclaimed Exits & Entries (available to claim):');
        for (const exit of unclaimed) {
          parts.push(`- "${exit.label}" (${exit.location_type}) — ${exit.claimStatus}`);
        }
      }
      const claimed = ground.claimableExits.filter((e) => e.claimStatus.startsWith('CLAIMED'));
      if (claimed.length > 0) {
        parts.push('', '## Already Claimed Exits (do NOT re-claim):');
        for (const exit of claimed) {
          parts.push(`- "${exit.label}" (${exit.location_type}) — ${exit.claimStatus}`);
        }
      }
    }

    // Only show pins if team is operational
    const isOperational =
      !blueprint || blueprint.items.every((item) => placedAssetTypes.has(item.asset_type));

    if (isOperational) {
      const tk = teamScopeKey || '';

      // Patients — already filtered by loadGroundSituation to only include team-relevant pins
      if (ground.patients.length > 0) {
        if (tk === 'fire') {
          parts.push(
            '',
            '## 🔥 HOT ZONE Patients (YOUR jurisdiction — extraction only):',
            '→ Extract these patients to the warm zone boundary. Basic DRABC, stretcher, full PPE.',
            '→ Do NOT triage or treat — hand off to Medical Triage team after extraction.',
          );
        } else if (tk === 'triage') {
          parts.push('', '## Patients awaiting triage/treatment (YOUR jurisdiction):');
        } else {
          parts.push('', '## Patients on scene:');
        }
        for (const p of ground.patients) parts.push(`- ${p}`);
      }

      // Crowds — only evacuation receives these from loadGroundSituation
      if (ground.crowds.length > 0) {
        parts.push(
          '',
          '## 👥 Crowds & Evacuee Groups (YOUR jurisdiction):',
          '→ Manage crowd movement, direct evacuees to assembly areas via claimed exits.',
          '→ If you discover INJURED individuals in a crowd, ENDORSE them to Medical Triage.',
          '  To endorse: submit a decision describing the injured person(s) and state you are',
          '  "endorsing to Medical Triage for assessment." This changes their status so the',
          '  Medical Triage team can see and treat them. Do NOT triage them yourself.',
        );
        for (const cr of ground.crowds) parts.push(`- ${cr}`);
      }

      // Hazards — already filtered by team in loadGroundSituation
      if (ground.hazards.length > 0) {
        if (tk === 'fire') {
          parts.push('', '## 🔥 Active Hazards (YOUR jurisdiction):');
        } else if (tk === 'bomb_squad') {
          parts.push('', '## 💣 Explosive Hazards (YOUR jurisdiction):');
        } else {
          parts.push('', '## Active Hazards:');
        }
        for (const h of ground.hazards) parts.push(`- ${h}`);
      }
    } else {
      const totalPins = ground.patients.length + ground.crowds.length + ground.hazards.length;
      if (totalPins > 0) {
        parts.push(
          '',
          `## ⚠️ There are ${ground.patients.length} patients, ${ground.crowds.length} crowds, and ${ground.hazards.length} hazards on the ground.`,
          '→ You CANNOT interact with them until your operating area blueprint is fully built.',
          '→ Focus on placing the NEXT item in your blueprint.',
        );
      }
    }

    // Sweepable assets — bomb squad only
    if (ground.sweepableAssets.length > 0) {
      parts.push(
        '',
        '## 🔍 SWEEPABLE ASSETS (use sweep_asset action to check for hidden devices):',
        "These are other teams' placed assets you can sweep. Un-swept assets may contain hidden bombs.",
      );
      for (const sa of ground.sweepableAssets) parts.push(`- ${sa}`);
    }

    // Available facilities — hospitals, placed operational assets (triage tents, field hospitals, etc.)
    if (ground.availableFacilities.length > 0) {
      parts.push(
        '',
        '## 🏥 AVAILABLE FACILITIES & DESTINATIONS (use ONLY these for transport/handover):',
        'You may ONLY transport patients or direct crowds to facilities listed below.',
        'Do NOT invent or assume hospital names — use ONLY what exists on the ground.',
      );
      for (const fac of ground.availableFacilities) parts.push(`- ${fac}`);
    } else {
      parts.push(
        '',
        '## 🏥 AVAILABLE FACILITIES: NONE YET',
        'No hospitals or operational areas have been placed on the map.',
        'If you need to transport a patient, you must FIRST establish a field hospital or triage tent.',
        'Do NOT invent hospital names. State that transport is pending facility setup.',
      );
    }

    const recentActivity = await this.loadRecentSessionActivity(session.sessionId);
    if (recentActivity.length > 0) {
      parts.push('', '## Recent actions by all teams:');
      for (const act of recentActivity.slice(0, 12)) {
        parts.push(`- ${act}`);
      }
    }

    if (agent.recentActions.length > 0) {
      parts.push('', '## Your previous actions (do not repeat):');
      for (const action of agent.recentActions.slice(-8)) {
        parts.push(`- ${action}`);
      }
    }

    // Show evaluator feedback on this bot's recent decisions so it can self-correct
    const ownFeedback = await this.loadOwnEvaluatorFeedback(
      session.sessionId,
      agent.persona.botUserId,
    );
    if (ownFeedback.length > 0) {
      parts.push(
        '',
        '## ⚠️ EVALUATOR FEEDBACK ON YOUR RECENT DECISIONS — READ AND FIX:',
        'The evaluator flagged issues with your previous decisions. You MUST address these in your next action:',
      );
      for (const fb of ownFeedback) {
        parts.push(`- ${fb}`);
      }
      parts.push(
        '→ If feedback says "setup fails to materialize": you forgot to deploy PERSONNEL. Re-submit with staff counts, roles, PPE, and equipment.',
        '→ If feedback says "lacks specificity": include exact coordinates, personnel counts, equipment names, and PPE.',
        '→ If feedback says an area is missing infrastructure: submit a PLACEMENT action to create it.',
      );
    }

    // Advanced mode: feed environmental truths, insider knowledge, placed assets
    if (session.difficulty === 'advanced') {
      const intel = await this.loadAdvancedIntelligence(session.sessionId, session.scenarioId);
      if (intel) parts.push('', intel);
    }

    // Difficulty-dependent: inject deliberate flaw directive for AI reviewer showcase
    const flawDirective = this.maybeInjectFlawDirective(session, agent);
    if (flawDirective) {
      parts.push('', flawDirective);
    }

    parts.push(
      '',
      'Return exactly 3 actions: 1 decision + 1 placement/claim + 1 chat. Bundle your tactical moves into the decision.',
    );

    return parts.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Classification-aware user prompt — focused format per action class
  // ---------------------------------------------------------------------------

  private async buildClassifiedUserPrompt(
    session: SessionAgents,
    agent: AgentState,
    event: WebSocketEvent,
    classification: ClassificationResult,
  ): Promise<string> {
    const parts: string[] = [];
    const elapsed = this.getElapsedMinutes(session);
    const center = session.incidentCenter ?? { lat: 0, lng: 0 };
    const teamScopeKey = getTeamScopeKey(agent.persona.teamName);

    parts.push(`## Current Situation — ${Math.floor(elapsed)} minutes into exercise`);

    const isProactive = event.type === 'proactive.tick' || event.type === 'session.started';
    if (!isProactive) {
      parts.push(`New event: ${event.type}`);
      parts.push(JSON.stringify(event.data, null, 2).slice(0, 1200));
    } else {
      parts.push(`Trigger: ${event.data.message || 'Periodic situation reassessment'}`);
    }

    parts.push(
      '',
      `## ACTION CLASSIFICATION: **${classification.actionClass.toUpperCase()}**`,
      `Reason: ${classification.reason}`,
    );

    // Load ground situation (always — all teams need situational awareness)
    const ground = await this.loadGroundSituation(
      session.sessionId,
      session.scenarioId,
      teamScopeKey || undefined,
    );

    // Load scenario metrics for zone/coordinate info
    const scenarioMetrics = await loadScenarioMetrics(
      session.sessionId,
      session.scenarioId,
      session.incidentCenter,
    );

    // Zone coordinate reference (always useful)
    parts.push(
      '',
      '### ZONE COORDINATES:',
      `Incident center: [${center.lat.toFixed(6)}, ${center.lng.toFixed(6)}]`,
      `HOT: ${scenarioMetrics.hotZoneRadius}m | WARM: ${scenarioMetrics.warmZoneRadius}m | COLD: ${scenarioMetrics.coldZoneRadius}m`,
    );

    // ------- Classification-specific instructions -------

    switch (classification.actionClass) {
      case 'claim_exit': {
        const unclaimed = ground.claimableExits.filter((e) => !e.claimStatus.startsWith('CLAIMED'));
        parts.push(
          '',
          '## YOUR TASK: Claim an exit/entry point',
          'Pick ONE unclaimed exit and claim it for your team.',
          '',
          '### Unclaimed exits:',
        );
        for (const exit of unclaimed) {
          parts.push(`- "${exit.label}" (${exit.location_type})`);
        }
        if (agent.recentActions.some((a) => a.includes('claim:'))) {
          parts.push(
            '',
            '⚠️ You already claimed an exit earlier. Pick a DIFFERENT one if any remain.',
          );
        }
        parts.push(
          '',
          'Return: 1 decision (describing why you claim this exit) + 1 claim + 1 chat.',
        );
        break;
      }

      case 'place_infrastructure': {
        const blueprint = teamScopeKey
          ? generateTeamBlueprint(teamScopeKey, scenarioMetrics)
          : null;
        const { data: placedRaw } = await supabaseAdmin
          .from('placed_assets')
          .select('asset_type')
          .eq('session_id', session.sessionId)
          .eq('team_name', agent.persona.teamName)
          .eq('status', 'active');
        const placedTypes = new Set(
          (placedRaw ?? []).map((a) => (a as Record<string, unknown>).asset_type as string),
        );

        if (blueprint) {
          const pending = blueprint.items
            .filter((item) => !placedTypes.has(item.asset_type))
            .sort((a, b) => a.priority - b.priority);

          if (pending.length > 0) {
            const next = pending[0];
            const personnelStr = next.personnel
              .map((p) => `${p.count}x ${p.role}${p.ppe ? ` (${p.ppe})` : ''}`)
              .join(', ');
            const equipStr = next.equipment.slice(0, 6).join(', ');

            parts.push(
              '',
              '## YOUR TASK: Place your next infrastructure item',
              `You must place: **${next.label}** (${next.asset_type})`,
              `Zone: ${next.zone} | Geometry: ${next.geometry_type}`,
              `Location hint: ${next.placement_hint}`,
              `Personnel: ${personnelStr}`,
              `Equipment: ${equipStr}`,
              next.capacity ? `Capacity: ${next.capacity} persons` : '',
              `Description: ${next.description}`,
              '',
              '⚠️ Your decision MUST include:',
              '1. Exact coordinates in the correct zone',
              '2. Personnel deployment with counts, roles, and PPE',
              '3. Equipment being provided',
              '',
              'Return: 1 decision + 1 placement (with geometry) + 1 chat.',
            );
          }
        }
        break;
      }

      case 'patient_response': {
        parts.push(
          '',
          '## YOUR TASK: Respond to a patient',
          '⚠️ You MUST use a pin_response action (not a regular decision) to interact with this patient.',
        );

        // Determine patient zone for zone-appropriate action restrictions
        const patientZone = classification.targetPinId
          ? ground.pinZoneMap.get(classification.targetPinId) || 'unknown'
          : 'unknown';

        if (classification.targetPinId) {
          parts.push(
            `Priority target: ${classification.targetPinLabel || 'patient'}`,
            `Target ID: ${classification.targetPinId}`,
            `Patient zone: ${patientZone.toUpperCase()}`,
          );

          // Zone-appropriate action restrictions
          if (patientZone === 'hot') {
            parts.push(
              '',
              '### 🔴 HOT ZONE PATIENT — EXTRACTION ONLY',
              '⛔ This patient is in the HOT ZONE. You CANNOT perform full triage or definitive treatment here.',
              '✅ ALLOWED actions in the HOT zone:',
              '  - DRABC (Danger-Response-Airway-Breathing-Circulation) rapid assessment',
              '  - Control life-threatening bleeding (tourniquet, direct pressure)',
              '  - Airway management (recovery position, jaw thrust)',
              '  - Rapid extrication / extraction from debris or danger',
              '  - Package patient onto stretcher / drag / carry',
              '  - Transport patient to WARM ZONE boundary for handoff to Medical Triage',
              '⛔ NOT ALLOWED in the HOT zone:',
              '  - Full triage assessment (START/SALT/JumpSTART)',
              '  - IV access / fluid resuscitation',
              '  - Detailed wound care / splinting / burn dressings (beyond immediate life-threat)',
              '  - Monitoring vitals over time',
              '  - Assigning triage tags (beyond initial "this patient needs immediate extraction")',
              '',
              '🎯 Your goal: GET THIS PATIENT OUT of the hot zone to the warm zone as fast as possible.',
              '   In your description, state: what you are extracting them from, how you are moving them,',
              '   where you are delivering them (warm zone coordinates or nearest triage point), and what',
              '   immediate life-saving interventions you applied during extraction.',
            );
          } else if (patientZone === 'warm') {
            parts.push(
              '',
              '### 🟡 WARM ZONE PATIENT — TRIAGE & STABILIZATION',
              '✅ ALLOWED actions in the WARM zone:',
              '  - Full triage assessment (START/SALT) and triage tag assignment',
              '  - Stabilization: IV access, fluid resuscitation, wound packing, splinting',
              '  - Monitoring vitals, pain management',
              '  - Decontamination (if chemical/HAZMAT scenario)',
              '  - Package for transport to COLD ZONE facility (triage tent, field hospital)',
              '⚠️ WARM zone is for STABILIZATION, not definitive care.',
              '   Once stable, the patient should be transported to a cold zone facility.',
              '   In your description, include: triage color, stabilization steps performed,',
              '   and destination facility for transport (pick from the AVAILABLE FACILITIES list).',
            );
          } else if (patientZone === 'cold') {
            parts.push(
              '',
              '### 🟢 COLD ZONE PATIENT — FULL TREATMENT & TRANSPORT',
              '✅ ALLOWED actions in the COLD zone:',
              '  - Definitive medical care, advanced treatment',
              '  - Re-triage / upgrade or downgrade triage status',
              '  - Prepare for hospital transport (ambulance, helicopter)',
              '  - Monitor and maintain until transport arrives',
              '   In your description, include: treatment performed, updated triage status,',
              '   and hospital transport plan (pick hospital from the AVAILABLE FACILITIES list).',
            );
          }

          // Load structured patient data for the target pin
          const patientDetail = await this.loadPatientDetail(
            session.sessionId,
            classification.targetPinId,
          );
          if (patientDetail) {
            parts.push('', '### 📋 PATIENT ASSESSMENT (follow this exactly):');
            if (patientDetail.name) {
              parts.push(
                `Patient: ${patientDetail.name}${patientDetail.age ? `, ${patientDetail.age}${patientDetail.sex}` : ''}`,
              );
            }
            if (patientDetail.role) {
              parts.push(`Role: ${patientDetail.role}`);
            }
            parts.push(`Status: ${patientDetail.status}`);
            parts.push(`Mobility: ${patientDetail.mobility}`);
            parts.push(`Consciousness: ${patientDetail.consciousness}`);
            parts.push(`Breathing: ${patientDetail.breathing}`);
            if (patientDetail.accessibility && patientDetail.accessibility !== 'open') {
              parts.push(
                `⚠️ Access: ${patientDetail.accessibility} — clear obstruction before treatment`,
              );
            }
            if (patientDetail.visibleDescription) {
              parts.push(`What you see: ${patientDetail.visibleDescription}`);
            }
            if (patientDetail.injuries.length > 0) {
              parts.push(
                `Injuries: ${patientDetail.injuries.map((i) => `${i.severity} ${i.type} (${i.body_part})`).join('; ')}`,
              );
            }
            if (patientDetail.idealSequence.length > 0) {
              parts.push('', '### 🔢 IDEAL RESPONSE SEQUENCE (follow this order):');
              for (const step of patientDetail.idealSequence) {
                parts.push(`  ${step.step}. ${step.action}: ${step.detail}`);
              }
              if (patientZone === 'hot') {
                parts.push(
                  '',
                  '⚠️ Because this patient is in the HOT ZONE, perform ONLY the extraction-related',
                  '   steps from the sequence above. Skip triage/treatment steps — those happen in the warm zone.',
                );
              }
            }
            if (patientDetail.treatmentReqs.length > 0) {
              if (patientZone === 'hot') {
                parts.push(
                  '',
                  '### 💊 TREATMENT (to be performed AFTER extraction to warm/cold zone):',
                );
              } else {
                parts.push('', '### 💊 REQUIRED TREATMENT:');
              }
              for (const t of patientDetail.treatmentReqs) {
                parts.push(`  - [${t.priority}] ${t.intervention} — ${t.reason}`);
              }
            }
            if (patientDetail.transportPrereqs.length > 0) {
              parts.push(
                '',
                '### 🚑 BEFORE TRANSPORT (must complete all):',
                ...patientDetail.transportPrereqs.map((p) => `  - ${p}`),
              );
            }
            if (patientDetail.requiredPpe.length > 0) {
              parts.push(`PPE required: ${patientDetail.requiredPpe.join(', ')}`);
            }
            if (patientDetail.requiredEquipment.length > 0) {
              parts.push(
                `Equipment needed: ${patientDetail.requiredEquipment.map((e) => `${e.item} x${e.quantity} (${e.purpose})`).join('; ')}`,
              );
            }
            if (patientDetail.contraindications.length > 0) {
              parts.push(`⛔ DO NOT: ${patientDetail.contraindications.join('; ')}`);
            }
            if (patientDetail.expectedMinutes) {
              parts.push(`Expected treatment time: ~${patientDetail.expectedMinutes} min`);
            }
            if (patientDetail.recommendedTransport) {
              parts.push(`🚑 Recommended transport: ${patientDetail.recommendedTransport}`);
            }
            if (patientDetail.deteriorationTimeline.length > 0) {
              parts.push('', '### ⚠️ DETERIORATION IF UNTREATED:');
              for (const d of patientDetail.deteriorationTimeline) {
                parts.push(`  +${d.at_minutes}min: ${d.description}`);
              }
            }
          }
        }
        parts.push('', '### Patients in your jurisdiction:');
        for (const p of ground.patients) parts.push(`- ${p}`);
        parts.push(
          '',
          '### Required pin_response format:',
          '- target_id: exact UUID from above',
          '- target_type: "casualty"',
          '- actions: list the SPECIFIC actions from the ideal response sequence above',
          '- resources: deployed personnel with counts and PPE from the requirements above',
          '- triage_color: "green"/"yellow"/"red"/"black" — assign based on injuries',
          patientZone === 'hot'
            ? '- description: describe your EXTRACTION plan — how you reach the patient, what life-saving interventions you apply, how you move them, and where in the warm zone you deliver them.'
            : '- description: follow the ideal response sequence step by step. Include personnel ratio, equipment used, and transport destination (MUST be from AVAILABLE FACILITIES list — do NOT invent names).',
          '',
          'Return: 1 pin_response + 1 chat. Do NOT include a placement action.',
        );
        break;
      }

      case 'hazard_response': {
        parts.push(
          '',
          '## YOUR TASK: Respond to a hazard',
          '⚠️ You MUST use a pin_response action (not a regular decision).',
        );
        if (classification.targetPinId) {
          parts.push(
            `Priority target: ${classification.targetPinLabel || 'hazard'}`,
            `Target ID: ${classification.targetPinId}`,
          );

          const hazardDetail = await this.loadHazardDetail(
            session.sessionId,
            classification.targetPinId,
          );
          if (hazardDetail) {
            parts.push('', '### 📋 HAZARD ASSESSMENT:');
            parts.push(`Type: ${hazardDetail.hazardType}`);
            parts.push(`Status: ${hazardDetail.status}`);
            if (hazardDetail.description) {
              parts.push(`Description: ${hazardDetail.description}`);
            }
            if (hazardDetail.idealSequence.length > 0) {
              parts.push('', '### 🔢 IDEAL RESPONSE SEQUENCE (follow this order):');
              for (const step of hazardDetail.idealSequence) {
                parts.push(
                  `  ${step.step}. ${step.action}: ${step.detail}${step.responsible_team ? ` [${step.responsible_team}]` : ''}`,
                );
              }
            }
            if (hazardDetail.equipmentReqs.length > 0) {
              parts.push('', '### 🔧 REQUIRED EQUIPMENT:');
              for (const e of hazardDetail.equipmentReqs) {
                parts.push(
                  `  - ${e.label || e.equipment_type} x${e.quantity}${e.critical ? ' (CRITICAL)' : ''}`,
                );
              }
            }
            if (hazardDetail.requiredPpe.length > 0) {
              parts.push(
                `PPE required: ${hazardDetail.requiredPpe.map((p) => `${p.item}${p.mandatory ? ' (mandatory)' : ''}`).join(', ')}`,
              );
            }
          }
        }
        parts.push('', '### Active hazards:');
        for (const h of ground.hazards) parts.push(`- ${h}`);
        parts.push(
          '',
          '### Required pin_response format:',
          '- target_id: exact UUID from above',
          '- target_type: "hazard"',
          '- actions: list the SPECIFIC containment/mitigation steps from the sequence above',
          '- resources: deployed units with counts and PPE from the requirements above',
          '- description: follow the ideal response sequence. Include equipment, approach, and safety measures.',
          '',
          'Return: 1 pin_response + 1 chat. Do NOT include a placement action.',
        );
        break;
      }

      case 'crowd_response': {
        parts.push(
          '',
          '## YOUR TASK: Direct a crowd/evacuee group',
          '⚠️ You MUST use a pin_response action.',
          '→ Direct evacuees to a named exit/assembly area.',
          '→ If you find INJURED people in the crowd, ENDORSE them to Medical Triage (describe in your chat).',
        );
        if (classification.targetPinId) {
          parts.push(
            `Priority target: ${classification.targetPinLabel || 'crowd'}`,
            `Target ID: ${classification.targetPinId}`,
          );
        }
        parts.push('', '### Crowds needing direction:');
        for (const cr of ground.crowds) parts.push(`- ${cr}`);

        const claimed = ground.claimableExits.filter((e) => e.claimStatus.startsWith('CLAIMED'));
        if (claimed.length > 0) {
          parts.push('', '### Claimed exits (direct crowds here):');
          for (const ex of claimed) {
            parts.push(`- "${ex.label}" — ${ex.claimStatus}`);
          }
        }
        parts.push('', 'Return: 1 pin_response + 1 chat. Do NOT include a placement action.');
        break;
      }

      // sweep_asset is handled deterministically by injectSchedulerService —
      // no LLM prompt case needed.

      case 'inject_media':
      case 'inject_stakeholder':
      case 'inject_situational': {
        const evtInjectData = !isProactive
          ? ((event.data as Record<string, unknown>)?.inject as Record<string, unknown> | undefined)
          : undefined;
        const evtResponseType = (evtInjectData?.response_type as string) ?? 'standard';
        const isMediaTeamBot = /media|communi/i.test(agent.persona.teamName);

        parts.push(
          '',
          `## YOUR TASK: Respond to this ${classification.actionClass.replace('inject_', '')} inject`,
          '⚠️ Read the inject carefully. Your response must DIRECTLY address what the inject describes.',
          '⚠️ Do NOT default to placing infrastructure or triaging patients unless the inject explicitly requires it.',
        );

        if (evtResponseType === 'media_statement' && isMediaTeamBot) {
          parts.push(
            '',
            '📋 THIS INJECT REQUIRES A PUBLIC STATEMENT. You are the media team — you must craft a detailed public statement.',
            'Your statement MUST include:',
            '1. SPOKESPERSON IDENTITY: State who is speaking and their role/authority.',
            '2. VERIFIED FACTS: Specific numbers (casualty count, evacuee count, hazard status) from the ground situation above.',
            '3. PUBLIC GUIDANCE: Clear instructions for the public (evacuate, avoid area, shelter, hotline).',
            '4. EMPATHY: Acknowledge victims and express concern.',
            '5. NEXT UPDATE: Commit to a follow-up timeline.',
            '6. Distinguish confirmed facts from preliminary information.',
            '',
            'Your statement will be reviewed by an editorial board before going live. Be specific and factual.',
          );
        } else if (evtResponseType === 'media_statement' && !isMediaTeamBot) {
          parts.push(
            '',
            '⚠️ THIS INJECT REQUIRES A PUBLIC STATEMENT — but you are NOT the media team.',
            'Your response MUST be coordination with the media team. Do NOT issue a public statement yourself.',
            'Frame your decision as: "Communicate to media team: [your verified operational facts]"',
            'Provide the media team with specific, verified information from your domain:',
            '- Specific numbers (patients treated, hazards contained, areas secured)',
            '- Operational status (what your team is doing right now)',
            '- Any information the public needs to know from your area of responsibility',
          );
        } else {
          parts.push(
            '',
            'Match your response to the inject:',
            '- Media inject → draft statement, manage press access, coordinate messaging',
            '- Stakeholder inject → assign liaison, prepare briefing, compile status report',
            '- Situational inject → adapt operations to new conditions',
          );
        }

        parts.push(
          '',
          'Return: 1 decision + 1 chat. Include placement ONLY if the inject explicitly requires infrastructure.',
        );
        break;
      }

      case 'proactive_pin': {
        // Same as patient/hazard/crowd but from proactive tick
        parts.push('', '## YOUR TASK: Proactively address an unresolved situation on the ground');
        if (ground.patients.length > 0 && teamScopeKey === 'triage') {
          parts.push('', '### Patients awaiting triage/treatment:');
          for (const p of ground.patients) parts.push(`- ${p}`);
          parts.push('', 'Use pin_response for the most critical patient.');
        }
        if (
          ground.hazards.length > 0 &&
          (teamScopeKey === 'fire' || teamScopeKey === 'bomb_squad')
        ) {
          parts.push('', '### Active hazards:');
          for (const h of ground.hazards) parts.push(`- ${h}`);
          parts.push('', 'Use pin_response for the most critical hazard.');
        }
        if (ground.crowds.length > 0 && teamScopeKey === 'evacuation') {
          parts.push('', '### Crowds needing direction:');
          for (const cr of ground.crowds) parts.push(`- ${cr}`);
          parts.push('', 'Use pin_response to direct the largest unmanaged crowd.');
        }
        parts.push('', 'Return: 1 pin_response + 1 chat.');
        break;
      }

      default:
        break;
    }

    // Previous actions (avoid repeats)
    if (agent.recentActions.length > 0) {
      parts.push('', '## Your previous actions (do not repeat):');
      for (const action of agent.recentActions.slice(-6)) {
        parts.push(`- ${action}`);
      }
    }

    // Evaluator feedback
    const ownFeedback = await this.loadOwnEvaluatorFeedback(
      session.sessionId,
      agent.persona.botUserId,
    );
    if (ownFeedback.length > 0) {
      parts.push('', '## ⚠️ EVALUATOR FEEDBACK (fix these issues):');
      for (const fb of ownFeedback) {
        parts.push(`- ${fb}`);
      }
    }

    // Recent session activity for context
    const recentActivity = await this.loadRecentSessionActivity(session.sessionId);
    if (recentActivity.length > 0) {
      parts.push('', '## Recent actions by all teams:');
      for (const act of recentActivity.slice(0, 8)) {
        parts.push(`- ${act}`);
      }
    }

    // Difficulty-dependent flaw directive
    const flawDirective = this.maybeInjectFlawDirective(session, agent);
    if (flawDirective) {
      parts.push('', flawDirective);
    }

    return parts.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Context-aware fallback — uses classification to determine fallback type
  // ---------------------------------------------------------------------------

  private async generateContextAwareFallback(
    session: SessionAgents,
    agent: AgentState,
    classification: ClassificationResult,
  ): Promise<SingleAction[] | null> {
    // For pin-response classes, generate a targeted pin_response fallback
    if (
      ['patient_response', 'hazard_response', 'crowd_response', 'proactive_pin'].includes(
        classification.actionClass,
      ) &&
      classification.targetPinId
    ) {
      const teamKey = getTeamScopeKey(agent.persona.teamName);
      const isPinResponse =
        classification.actionClass === 'patient_response' ||
        classification.actionClass === 'crowd_response';
      const targetType: 'casualty' | 'hazard' =
        classification.actionClass === 'hazard_response' ? 'hazard' : 'casualty';

      const triageColor = isPinResponse && teamKey === 'triage' ? 'yellow' : undefined;

      return [
        {
          action: 'pin_response',
          pin_response: {
            target_id: classification.targetPinId,
            target_type: targetType,
            target_label: classification.targetPinLabel || 'Target',
            actions:
              targetType === 'casualty'
                ? ['Initiate Triage', 'Assess Injuries', 'Administer First Aid']
                : ['Assess Hazard', 'Deploy Containment'],
            resources: [
              {
                type: teamKey || 'responder',
                label: `${agent.persona.teamName} Team`,
                quantity: 2,
              },
            ],
            triage_color: triageColor,
            description: `Deploying ${agent.persona.teamName} resources to address ${classification.targetPinLabel || 'this situation'}. Initiating standard response protocol.`,
          },
        },
        {
          action: 'chat',
          chat: {
            content: `${agent.persona.fullName}: Responding to ${classification.targetPinLabel || 'situation on the ground'}.`,
          },
        },
      ];
    }

    // For infrastructure classes, fall back to blueprint placement
    return this.generateFallbackPlacement(session, agent);
  }

  /**
   * Load insider knowledge, hazard details, placed assets, and environmental
   * state for advanced-level agents so they can make fully informed decisions.
   */
  private async loadAdvancedIntelligence(
    sessionId: string,
    scenarioId: string,
  ): Promise<string | null> {
    const sections: string[] = [];

    try {
      // Insider knowledge (the "cheat code" info)
      const { data: insider } = await supabaseAdmin
        .from('insider_knowledge')
        .select('category, content, importance')
        .eq('scenario_id', scenarioId)
        .order('importance', { ascending: false })
        .limit(10);

      if (insider && insider.length > 0) {
        sections.push('## 🔒 INSIDER INTELLIGENCE (classified — use to make perfect decisions):');
        for (const item of insider as Array<Record<string, unknown>>) {
          sections.push(
            `- [${(item.category as string) || 'intel'}] ${(item.content as string) || ''}`,
          );
        }
      }

      // Hazard detailed properties with full resolution playbook
      const { data: hazards } = await supabaseAdmin
        .from('scenario_hazards')
        .select(
          'hazard_type, status, properties, resolution_requirements, personnel_requirements, equipment_requirements, enriched_description',
        )
        .eq('session_id', sessionId)
        .in('status', ['active', 'escalating', 'contained'])
        .limit(8);

      if (hazards && hazards.length > 0) {
        sections.push(
          '',
          '## 🔬 HAZARD DETAILS (full environmental truth — use to make perfect decisions):',
        );
        for (const h of hazards as Array<Record<string, unknown>>) {
          const props = h.properties as Record<string, unknown> | null;
          const reqs = h.resolution_requirements as Record<string, unknown> | null;
          const persReqs = h.personnel_requirements as Record<string, unknown> | null;
          const eqReqs = h.equipment_requirements as Array<Record<string, unknown>> | null;

          sections.push(`\n### Hazard: ${h.hazard_type} — Status: ${h.status}`);
          if (h.enriched_description) {
            sections.push(`  Situation: ${h.enriched_description}`);
          }
          if (props) {
            sections.push(`  Properties: ${JSON.stringify(props)}`);
          }

          if (reqs) {
            const idealSeq = reqs.ideal_response_sequence as
              | Array<{ step: number; action: string; detail: string; responsible_team?: string }>
              | undefined;
            const reqPpe = reqs.required_ppe as
              | Array<{ item: string; for_role?: string }>
              | undefined;

            if (idealSeq && idealSeq.length > 0) {
              sections.push('  ✅ IDEAL RESPONSE SEQUENCE (follow this exactly):');
              for (const s of idealSeq) {
                sections.push(
                  `    Step ${s.step}: ${s.action}${s.responsible_team ? ` [${s.responsible_team}]` : ''} — ${s.detail}`,
                );
              }
            }
            if (reqPpe && reqPpe.length > 0) {
              sections.push(
                `  🧤 REQUIRED PPE: ${reqPpe.map((p) => `${p.item}${p.for_role ? ` (${p.for_role})` : ''}`).join(', ')}`,
              );
            }
            const safetyPrecautions = reqs.safety_precautions as string[] | undefined;
            if (safetyPrecautions && safetyPrecautions.length > 0) {
              sections.push(`  ⚠️ Safety precautions: ${safetyPrecautions.join('; ')}`);
            }
            if (reqs.approach_method) {
              sections.push(`  Approach method: ${reqs.approach_method}`);
            }
            if (reqs.estimated_resolution_minutes) {
              sections.push(
                `  Expected resolution time: ~${reqs.estimated_resolution_minutes} minutes`,
              );
            }
          }

          if (persReqs) {
            sections.push(
              `  Personnel: ${persReqs.primary_responder ?? 'unknown'} x${persReqs.minimum_count ?? '?'}${persReqs.specialist_needed ? `, specialist: ${persReqs.specialist_type}` : ''}${(persReqs.support_roles as string[])?.length ? `, support: ${(persReqs.support_roles as string[]).join(', ')}` : ''}`,
            );
          }

          if (eqReqs && eqReqs.length > 0) {
            sections.push(
              `  Equipment: ${eqReqs.map((e) => `${e.label || e.equipment_type} x${e.quantity}${e.critical ? ' [CRITICAL]' : ''}`).join(', ')}`,
            );
          }
        }
      }

      // Casualty detailed conditions with full ideal response playbook
      const { data: casualties } = await supabaseAdmin
        .from('scenario_casualties')
        .select('id, casualty_type, headcount, status, conditions')
        .eq('session_id', sessionId)
        .in('status', [
          'undiscovered',
          'identified',
          'endorsed_to_triage',
          'in_treatment',
          'being_moved',
          'being_evacuated',
          'at_assembly',
        ])
        .limit(15);

      if (casualties && casualties.length > 0) {
        const patients = (casualties as Array<Record<string, unknown>>).filter(
          (c) => c.casualty_type === 'patient',
        );
        const crowds = (casualties as Array<Record<string, unknown>>).filter(
          (c) => c.casualty_type === 'crowd' || c.casualty_type === 'evacuee_group',
        );
        const convergent = (casualties as Array<Record<string, unknown>>).filter(
          (c) => c.casualty_type === 'convergent_crowd',
        );

        if (patients.length > 0) {
          sections.push(
            '',
            '## 🏥 PATIENT DETAILS (full clinical truth — use to make perfect decisions):',
          );
          for (const c of patients) {
            const conds = (c.conditions ?? {}) as Record<string, unknown>;
            const idShort = (c.id as string).slice(0, 8);
            const patientName = (conds.name as string) || `Patient [${idShort}]`;
            const patientAge = conds.age as number | undefined;
            const patientSex = conds.sex as string | undefined;
            const patientRole = conds.role as string | undefined;
            sections.push(
              `\n### ${patientName}${patientAge ? `, ${patientAge}${patientSex ?? ''}` : ''} — Status: ${c.status}`,
            );
            if (patientRole) {
              sections.push(`  Role: ${patientRole}`);
            }
            sections.push(
              `  Triage: ${conds.triage_color ?? 'unassessed'}, Mobility: ${conds.mobility ?? 'unknown'}, Consciousness: ${conds.consciousness ?? 'unknown'}, Breathing: ${conds.breathing ?? 'unknown'}`,
            );

            const injuries = conds.injuries as
              | Array<{ type: string; severity: string; body_part: string }>
              | undefined;
            if (injuries?.length) {
              sections.push(
                `  Injuries: ${injuries.map((i) => `${i.severity} ${i.type} (${i.body_part})`).join('; ')}`,
              );
            }

            const treatReqs = conds.treatment_requirements as
              | Array<{ intervention: string; priority: string; reason: string }>
              | undefined;
            if (treatReqs?.length) {
              sections.push(
                `  Required treatment: ${treatReqs.map((t) => `${t.intervention} [${t.priority}] — ${t.reason}`).join('; ')}`,
              );
            }

            const transPrereqs = conds.transport_prerequisites as string[] | undefined;
            if (transPrereqs?.length) {
              sections.push(`  Before transport: ${transPrereqs.join(', ')}`);
            }

            const contraindications = conds.contraindications as string[] | undefined;
            if (contraindications?.length) {
              sections.push(`  ⛔ Do NOT: ${contraindications.join(', ')}`);
            }

            const idealSeq = conds.ideal_response_sequence as
              | Array<{ step: number; action: string; detail: string }>
              | undefined;
            if (idealSeq?.length) {
              sections.push('  ✅ IDEAL RESPONSE SEQUENCE (follow this exactly):');
              for (const s of idealSeq) {
                sections.push(`    Step ${s.step}: ${s.action} — ${s.detail}`);
              }
            }

            const reqPpe = conds.required_ppe as string[] | undefined;
            if (reqPpe?.length) {
              sections.push(`  🧤 PPE for responder: ${reqPpe.join(', ')}`);
            }

            const reqEquip = conds.required_equipment as
              | Array<{ item: string; quantity: number; purpose: string }>
              | undefined;
            if (reqEquip?.length) {
              sections.push(
                `  🔧 Equipment needed: ${reqEquip.map((e) => `${e.item} x${e.quantity} (${e.purpose})`).join('; ')}`,
              );
            }

            const expectedTime = conds.expected_time_to_treat_minutes as number | undefined;
            if (expectedTime) {
              sections.push(`  ⏱️ Expected treatment time: ~${expectedTime} minutes`);
            }

            const recTransport = conds.recommended_transport as string | undefined;
            if (recTransport) {
              sections.push(`  🚑 Recommended transport: ${recTransport}`);
            }

            const detTimeline = conds.deterioration_timeline as
              | Array<{ at_minutes: number; description: string }>
              | undefined;
            if (detTimeline?.length) {
              sections.push('  ⚠️ DETERIORATION IF UNTREATED:');
              for (const d of detTimeline) {
                sections.push(`    +${d.at_minutes}min: ${d.description}`);
              }
            }
          }
        }

        if (crowds.length > 0) {
          sections.push('', '## 👥 CROWD DETAILS (use to make perfect evacuation decisions):');
          for (const c of crowds) {
            const conds = (c.conditions ?? {}) as Record<string, unknown>;
            sections.push(
              `\n### Crowd (${c.headcount} people) — Status: ${c.status}, Behavior: ${conds.behavior ?? 'unknown'}`,
            );
            if (conds.visible_description) {
              sections.push(`  Visible: ${conds.visible_description}`);
            }
            if (conds.blocking_exit) {
              sections.push(`  ⚠️ Blocking exit: ${conds.blocking_exit}`);
            }
            if (conds.bottleneck) {
              sections.push('  ⚠️ Bottleneck risk: YES');
            }
            if (conds.movement_direction) {
              sections.push(`  Moving: ${conds.movement_direction}`);
            }

            const crowdIdealSeq = conds.ideal_response_sequence as
              | Array<{ step: number; action: string; detail: string }>
              | undefined;
            if (crowdIdealSeq?.length) {
              sections.push('  ✅ IDEAL CROWD MANAGEMENT SEQUENCE:');
              for (const s of crowdIdealSeq) {
                sections.push(`    Step ${s.step}: ${s.action} — ${s.detail}`);
              }
            }

            const crowdEquip = conds.required_equipment as
              | Array<{ item: string; quantity: number; purpose: string }>
              | undefined;
            if (crowdEquip?.length) {
              sections.push(
                `  Equipment: ${crowdEquip.map((e) => `${e.item} x${e.quantity} (${e.purpose})`).join('; ')}`,
              );
            }

            const crowdPersonnel = conds.required_personnel as
              | { role: string; count: number }
              | undefined;
            if (crowdPersonnel) {
              sections.push(`  Personnel: ${crowdPersonnel.count}x ${crowdPersonnel.role}`);
            }

            if (conds.management_priority) {
              sections.push(`  Priority: ${conds.management_priority}`);
            }
          }
        }

        if (convergent.length > 0) {
          sections.push('', '## 🚶 CONVERGENT CROWD DETAILS (arriving from outside):');
          for (const c of convergent) {
            const conds = (c.conditions ?? {}) as Record<string, unknown>;
            sections.push(
              `\n### ${conds.crowd_origin ?? 'Unknown'} group (${c.headcount} people) — Status: ${c.status}, Behavior: ${conds.behavior ?? 'unknown'}`,
            );
            if (conds.visible_description) {
              sections.push(`  Visible: ${conds.visible_description}`);
            }
            if (conds.obstruction_risk) {
              sections.push(`  Obstruction risk: ${conds.obstruction_risk}`);
            }

            const convIdealSeq = conds.ideal_response_sequence as
              | Array<{ step: number; action: string; detail: string }>
              | undefined;
            if (convIdealSeq?.length) {
              sections.push('  ✅ IDEAL MANAGEMENT SEQUENCE:');
              for (const s of convIdealSeq) {
                sections.push(`    Step ${s.step}: ${s.action} — ${s.detail}`);
              }
            }

            const convEquip = conds.required_equipment as
              | Array<{ item: string; quantity: number; purpose: string }>
              | undefined;
            if (convEquip?.length) {
              sections.push(
                `  Equipment: ${convEquip.map((e) => `${e.item} x${e.quantity} (${e.purpose})`).join('; ')}`,
              );
            }

            const convPersonnel = conds.required_personnel as
              | { role: string; count: number }
              | undefined;
            if (convPersonnel) {
              sections.push(`  Personnel: ${convPersonnel.count}x ${convPersonnel.role}`);
            }
          }
        }
      }

      // Currently placed assets (so agent knows what infrastructure exists)
      const { data: placed } = await supabaseAdmin
        .from('placed_assets')
        .select('asset_type, label, team_name, geometry')
        .eq('session_id', sessionId)
        .eq('status', 'active')
        .limit(20);

      if (placed && placed.length > 0) {
        sections.push('', '## 🗺️ DEPLOYED INFRASTRUCTURE (what is on the map right now):');
        for (const p of placed as Array<Record<string, unknown>>) {
          const geom = p.geometry as { type?: string } | null;
          sections.push(
            `- ${p.asset_type} "${p.label}" by ${p.team_name} (${geom?.type || 'unknown'})`,
          );
        }
      }
    } catch (err) {
      logger.warn({ error: err, sessionId }, 'AI agent: failed to load advanced intelligence');
    }

    return sections.length > 0 ? sections.join('\n') : null;
  }

  /**
   * Append team-specific expert playbook so each role knows the "complete
   * answer" for their domain — equipment, procedures, sequencing, and
   * what a perfect response looks like.
   */
  private appendTeamExpertPlaybook(parts: string[], teamName: string): void {
    const tk = getTeamScopeKey(teamName);

    if (tk === 'evacuation') {
      parts.push(
        '',
        '### EXPERT PLAYBOOK: EVACUATION',
        '',
        '#### Your Perfect Response Sequence:',
        '1. Deploy OUTER CORDON polygon immediately — this is your #1 priority. Size it wide enough to keep ALL civilians, media, and bystanders away from the scene.',
        '2. Establish ACCESS CONTROL POINTS at each exit/entry — claim exits as "security_checkpoint" with exclusivity. Only authorized personnel pass through.',
        '3. Deploy INNER CORDON polygon around the hot zone — tighter perimeter. Only specialized responders (fire, medical) enter with your authorization.',
        '4. Assign officers to each cordon segment — specify headcount: "4 officers on north inner cordon, 2 on south outer cordon".',
        '5. Establish a COMMAND POST in the cold zone — place as a Point asset with label "Incident Command Post".',
        '6. Coordinate access requests — when medical team needs to enter hot zone, you authorize and log entry.',
        '',
        '#### Equipment You Must Specify:',
        '- Cordon tape / barriers / traffic cones for physical perimeter',
        '- Body-worn cameras for evidence preservation',
        '- Portable radios (specific channel assignments)',
        '- Vehicle barriers (bollards, patrol cars) for vehicle exclusion zones',
        '- Loudhailer / PA system for crowd dispersal orders',
        '- Crime scene tape and evidence markers (if secondary device or forensic scene)',
        '',
        '#### Situational Awareness:',
        '- ALWAYS check for secondary threats before declaring an area secure',
        '- If scenario involves an active threat (shooter, bomber), establish "safe corridor" LineStrings for evacuation routes BEFORE medical teams enter',
        '- If crowds are panicking near your cordon, request crowd management reinforcements with specific numbers',
        '- Preserve evidence inside the hot zone — instruct fire/medical teams to minimize disturbance',
        '- If media arrives, designate a MEDIA STAGING AREA in the cold zone as a placed asset',
        '- Log and track every person entering/exiting the inner cordon (state this in your decision)',
      );
    }

    if (tk === 'fire') {
      parts.push(
        '',
        '### EXPERT PLAYBOOK: FIRE SAFETY',
        '',
        '#### Your Perfect Response Sequence:',
        '1. Assess the hazard type FIRST — read the hazard pin properties. Is it fire, chemical, gas, structural? This determines your equipment.',
        '2. Establish PPE level for your team BEFORE approaching:',
        '   - Level A: full encapsulation suit + SCBA (chemical/biological unknowns)',
        '   - Level B: splash protection + SCBA (known chemical, no vapor threat)',
        '   - Level C: splash protection + APR (known chemical, low concentration)',
        '   - Level D: standard turnout gear (fire only, no chemical)',
        '3. Place a DECONTAMINATION CORRIDOR in the warm zone — this is a polygon between hot and cold zones. All responders exiting hot zone must pass through.',
        '4. Attack the hazard with pin_response — specify exact equipment and agent:',
        '   - Class A fire (ordinary combustibles): water, foam',
        '   - Class B fire (flammable liquids): foam, CO2, dry chemical',
        '   - Class C fire (electrical): CO2, dry chemical (NEVER water)',
        '   - Class D fire (combustible metals): special dry powder',
        '   - Chemical spill: containment booms, absorbent pads, neutralizing agents',
        '   - Gas leak: gas detectors, ventilation fans, spark-free tools',
        '5. Monitor for re-ignition or hazard escalation — request ongoing monitoring with thermal imaging cameras.',
        '6. Only declare "contained" when the hazard is no longer spreading. Only declare "resolved" after full suppression and atmospheric monitoring confirms safe.',
        '',
        '#### Equipment You Must Specify:',
        '- Fire: fire engine with pump capacity (e.g., "2000 LPM pumper"), hose lines (specify length/diameter), thermal imaging camera, ventilation fans',
        '- HAZMAT: gas detection meters (4-gas detector, PID), decon shower system, containment booms, absorbent materials, chemical reference database (ERG guide)',
        '- Rescue: hydraulic rescue tools (jaws of life, spreaders, cutters) for entrapment, shoring equipment for structural collapse',
        '- Personnel: specify crew size ("Engine Company Alpha, 4 firefighters" not just "a fire team")',
        '',
        '#### Critical Rules:',
        '- YOU are the ONLY team authorized to enter the hot zone. No Medical Triage or Evacuation team enters until you declare it safe.',
        '- Hot zone casualty extraction is YOUR exclusive job: locate casualties, stabilize with basic DRABC, carry them on stretcher with full PPE to the warm zone boundary. Then radio medical to take over.',
        '- Check wind direction before positioning (upwind approach for HAZMAT)',
        '- Structural assessment before entry — if building is compromised, request structural engineer before sending crews in',
        '- Establish a water supply point and specify hydrant location or tanker',
        '- When responding to an inject about fire spread or hazard escalation, your decision MUST name: which engine company, how many firefighters, what hose line diameter, what agent, what PPE level.',
      );
    }

    if (tk === 'triage') {
      parts.push(
        '',
        '### EXPERT PLAYBOOK: MEDICAL TRIAGE',
        '',
        '#### Your Perfect Response Sequence:',
        '1. Place a TRIAGE TENT inside the warm zone, near an exit — this is your base of operations. It must be a placed asset on the map.',
        '2. If mass casualties expected, place a FIELD HOSPITAL (larger polygon) in the cold zone for extended treatment.',
        '3. Begin SYSTEMATIC TRIAGE using pin_response — one patient at a time, using START protocol:',
        '   - Can they walk? → GREEN (minor)',
        '   - Breathing after airway opened? → No → BLACK (deceased)',
        '   - Respiratory rate > 30? → RED (immediate)',
        '   - Radial pulse absent or CRT > 2 sec? → RED (immediate)',
        '   - Cannot follow commands? → RED (immediate)',
        '   - Otherwise → YELLOW (delayed)',
        '4. After triage, TREAT patients based on color priority (RED first, then YELLOW):',
        '   - Each treatment must specify the exact intervention and equipment.',
        '5. When a patient is TREATED and STABLE, arrange TRANSPORT to a hospital from the AVAILABLE FACILITIES list with a specific vehicle.',
        '',
        '#### Equipment By Injury Type (MUST specify in pin_response):',
        '- Fracture (limb): rigid splint (SAM splint), elastic bandage, sling. If open fracture: sterile dressing first, then splint. Stretcher for non-ambulatory.',
        '- Fracture (spinal/cervical): cervical collar, spine board, head blocks, straps. DO NOT move without full spinal immobilization.',
        '- Burns (minor, <10% BSA): cool running water 20 min, burns dressing, cling film, oral analgesia.',
        '- Burns (major, >20% BSA): IV access (2 large bore), Parkland formula fluids (4ml × kg × %BSA), burns dressing, intubation kit if airway burns.',
        '- Hemorrhage (external): direct pressure, tourniquet (limb), hemostatic gauze (junctional), pressure dressing.',
        '- Hemorrhage (internal/suspected): IV fluids, rapid transport, pelvic binder if pelvic fracture suspected.',
        '- Crush injury: IV normal saline BEFORE extrication (prevents crush syndrome), calcium gluconate, sodium bicarbonate, cardiac monitor.',
        '- Smoke inhalation: high-flow oxygen (15L NRB mask), nebulized salbutamol, intubation kit on standby.',
        '- Chemical exposure: full decontamination BEFORE treatment. Remove contaminated clothing. Specific antidotes if known (atropine for nerve agent, pralidoxime).',
        '- Blast injury: check for tympanic membrane rupture, blast lung (oxygen, no positive pressure), embedded shrapnel (do NOT remove, stabilize in place).',
        '- Psychological trauma: quiet area in cold zone, crisis counselor, blanket, warm drink. Do not sedate.',
        '',
        '#### Transport Requirements (DESTINATION IS MANDATORY):',
        '- GREEN patients: walking or by bus to Assembly Area [name] at [coords]. State personnel ratio (e.g., "1 marshal per 20 walking wounded").',
        '- YELLOW patients: ambulance transport within 1 hour to a hospital from the AVAILABLE FACILITIES list (e.g., "2 patients by ambulance to [hospital name from list], est. 12 min"). State escort count.',
        '- RED patients: immediate ambulance to a hospital from the AVAILABLE FACILITIES list with department (e.g., "1 patient by ambulance to [hospital name from list] Trauma Centre, est. 8 min"). If >20 min drive, request helicopter. State 1:1 paramedic escort.',
        '- BLACK patients: DO NOT TRANSPORT. Tag, cover, document location, and move on immediately. Coroner handles BLACK patients AFTER all survivors are stabilized. Never allocate ambulances or personnel to BLACK patients while RED/YELLOW patients await care.',
        '- ALWAYS specify: patient count per vehicle, escort personnel with ratio, receiving facility name (from AVAILABLE FACILITIES), and estimated transit time.',
        '- For handoff between teams: name the receiving team and their asset (e.g., "Handover to Triage Station A for START assessment by Dr. [persona]").',
        '',
        '#### Critical Rules:',
        '- NEVER enter the hot zone without fire team clearance — wait for "scene safe" confirmation',
        '- Set up casualty collection point at hot/warm zone boundary — fire team brings patients TO you',
        '- Track patient numbers: state how many GREEN/YELLOW/RED/BLACK at each decision point',
        '- If hospital capacity is an issue, mention load-balancing across facilities',
        '- Request specific specialist resources by exact count and role: "2 paramedics with ALS capability, 1 triage officer, 3 stretcher bearers" — NEVER just "medical team"',
        '- Every pin_response MUST list: equipment items by name, responder count, PPE worn by responders, expected outcome',
      );
    }

    // Evacuation-specific crowd management guidance (appended to the evacuation playbook above)
    if (tk === 'evacuation') {
      parts.push(
        '',
        '#### Crowd Evacuation Operations:',
        '1. CLAIM exits early — decide which exits your team will manage. Specify exclusive or shared.',
        '2. Place ASSEMBLY POINTS as placed assets in the cold zone — one for each major exit route. Name them clearly.',
        '3. Draw EVACUATION ROUTES as LineString assets — from the incident area through your claimed exits to assembly points.',
        '4. Assess crowd pins — how many people, what behavior (calm, anxious, panicking)? This determines approach.',
        '5. Issue EVACUATION ORDERS via decision — name the specific crowd, the exit they should use, and the EXACT assembly point destination by name and coordinates.',
        '   Example: "Directing ~80 evacuees near Main Hall via Exit B to Assembly Area A at [-33.889, 151.274]. Deploying 4x Marshals (1:20 marshal-to-evacuee ratio)."',
        '6. Deploy MARSHALS along routes — specify headcount AND ratio: "4 marshals at Exit B corridor (1:20 ratio for 80 evacuees), 2 at assembly point entrance".',
        '7. Conduct HEADCOUNT at assembly point — verify expected vs actual evacuees. Report discrepancies.',
        '',
        '#### Crowd Equipment:',
        '- Megaphones / PA system for crowd direction',
        '- High-visibility vests for marshals (specify count)',
        '- Barrier tape for route channeling',
        '- Wheelchairs / evacuation chairs for mobility-impaired',
        '- Signage / directional arrows for route marking',
        '- Headcount clickers / registration sheets at assembly points',
        '',
        '#### Crowd Management Expertise:',
        '- Calculate EXIT FLOW RATE: ~60 people/min through a standard door.',
        '- PANICKING crowds need calming BEFORE orderly evacuation. Deploy trained marshals with PA first.',
        '- VULNERABLE POPULATIONS: identify elderly, disabled, children. These need assisted evacuation.',
        '- If stampede risk detected, STOP evacuation and stabilize before resuming.',
        '- Separate walking wounded (GREEN tag patients) from crowd evacuees.',
        '- Assembly points must be UPWIND of any fire/chemical hazard.',
        '- Track numbers: "Evacuated 350 of estimated 500 through Exit B. 150 remaining in Level 2."',
        '',
        '#### 🩺 Injured in a Crowd — ENDORSEMENT PROTOCOL:',
        'You manage crowds, you do NOT treat patients. If you discover injured individuals in a crowd:',
        '1. STABILIZE the scene — clear space around the injured, control crowd movement.',
        '2. ENDORSE the injured to Medical Triage by submitting a decision:',
        '   Title: "Endorse [N] injured civilians from [crowd location] to Medical Triage"',
        '   Description: Describe the injuries observed and state you are endorsing them for medical assessment.',
        '   This updates their status to "endorsed_to_triage" so the Medical Triage team can see and treat them.',
        "3. Do NOT triage, apply tourniquets, administer first aid, or assign triage colors. That is Medical Triage's job.",
        '4. If a crowd contains people with minor walking injuries (GREEN), you may still direct them to an assembly point.',
        '   But anyone who needs treatment (bleeding, fractures, burns) must be endorsed to Medical Triage.',
      );
    }

    if (tk === 'media') {
      parts.push(
        '',
        '### EXPERT PLAYBOOK: MEDIA & COMMUNICATIONS',
        '',
        '#### Your Perfect Response Sequence:',
        '1. Establish MEDIA STAGING AREA as a placed asset in the cold zone — away from operations but with line of sight.',
        '2. Draft initial PUBLIC STATEMENT — confirm incident type, state response is underway, do NOT speculate on casualties or cause.',
        '3. Designate a SPOKESPERSON and brief them — specify by role, not by name.',
        '4. Monitor and respond to SOCIAL MEDIA reports — flag misinformation for correction.',
        '5. Issue periodic UPDATES with verified information only — casualties confirmed by medical, cause confirmed by investigation.',
        '6. Coordinate with all teams before releasing sensitive information — especially casualty numbers and cause.',
        '',
        '#### ⚠️ STATEMENT QUALITY — MANDATORY (enforced by validation):',
        '- Every public statement MUST contain SPECIFIC, ACCURATE information — generic phrases will be REJECTED.',
        '- BAD (too vague): "We are managing the situation and all necessary measures are being taken."',
        '- GOOD (specific): "At 14:32, an incident was reported at [venue name]. Emergency services responded within 4 minutes. Currently, 12 casualties are being triaged at the warm zone triage station. 3 critical patients have been transported to [hospital name from AVAILABLE FACILITIES]. Approximately 200 evacuees have been directed to Assembly Area A via Exit B. The inner perimeter is secured by police. We will provide updates every 30 minutes."',
        '- Include: incident time, location by name, casualty count (verified by triage), evacuation count, hazard status, team deployments, next update time.',
        '- If exact numbers are not yet verified, say "approximately X" or "at least X confirmed" — but NEVER omit numbers entirely.',
        '- Reference the ground situation data provided to you for accurate figures.',
        '',
        '#### Equipment You Must Specify:',
        '- Press briefing area: podium, microphone, backdrop',
        '- Social media monitoring station: laptop, mobile hotspot',
        '- Media credentials / access passes for authorized press',
        '- Pre-prepared holding statements and Q&A templates',
        '',
        '#### Public Sentiment Awareness:',
        '- Your decisions directly affect PUBLIC SENTIMENT meter — careless statements damage trust.',
        '- Acknowledge the situation without speculation: "We are aware of an incident at [location]. Emergency services are responding."',
        '- If misinformation is spreading, issue CORRECTION statements quickly.',
        '- If casualties are involved, express concern without confirming numbers until verified by medical team.',
        '- Coordinate with police on whether to release suspect information (active threat vs resolved).',
      );
    }

    if (tk === 'pursuit') {
      parts.push(
        '',
        '### EXPERT PLAYBOOK: PURSUIT & INVESTIGATION',
        '',
        '#### Your Perfect Response Sequence:',
        '1. Gather situation reports from all teams — build a COMMON OPERATING PICTURE.',
        '2. Assess threat level: is this ongoing, resolved, or at risk of escalation? Are there secondary threats?',
        '3. If active threat (hostage, active shooter): establish CONTAINMENT perimeter, negotiate if possible, coordinate tactical response.',
        '4. Identify and preserve EVIDENCE — mark locations, instruct teams not to disturb, request forensics.',
        '5. Conduct WITNESS INTERVIEWS — identify key witnesses, establish safe interview area in cold zone.',
        '6. Brief Incident Commander on threat assessment and recommended course of action.',
        '',
        '#### Equipment You Must Specify:',
        '- Evidence markers and collection kits',
        '- CCTV / surveillance access requests (specify camera locations)',
        '- Tactical communications (encrypted channel)',
        '- Negotiation phone/line if hostage situation',
        '- Forensic team with specialized equipment (specify: CBRN detection, explosive ordnance disposal, digital forensics)',
        '',
        '#### Critical Rules:',
        '- Check for SECONDARY DEVICES or threats — especially in bombing scenarios. Report all suspicious items.',
        '- If suspects are identified, coordinate with police for containment — do NOT send medical teams into an area with active threat',
        '- Preserve chain of custody for all evidence',
        '- Brief all teams on threat updates in real-time via chat',
      );
    }

    if (tk === 'bomb_squad') {
      parts.push(
        '',
        '### EXPERT PLAYBOOK: BOMB SQUAD / EOD',
        '',
        '#### Phase 1 — Setup:',
        '1. Establish EOD STAGING AREA in the cold zone (150m+ from incident center)',
        '2. Request SITREP from unified command — confirm primary device status',
        '3. Confirm comms channel and equipment readiness',
        '',
        '#### Phase 2 — Proactive Sweeps:',
        '4. As other teams place operational areas (triage tents, command posts, assembly points), SYSTEMATICALLY SWEEP each one',
        '5. Prioritize high-value assets: ICP, triage tents, assembly areas near the incident',
        '6. Sweep 1-2 assets per decision cycle using your sweep resources (K9, robot, personnel)',
        '',
        '#### Phase 3 — Device Response (when suspicious package is reported or discovered):',
        '7. Read the device properties carefully: container_type, container_material, visibility, stability',
        '8. ESTABLISH EXCLUSION ZONE — use the correct_standoff_m from device properties',
        '9. ORDER COMMS BLACKOUT within exclusion zone (prevent RF-triggered detonation)',
        '10. COORDINATE with nearby teams to EVACUATE their operational area if within the exclusion zone',
        '11. DEPLOY EOD ROBOT for visual assessment — NEVER manual approach first',
        '12. DEPLOY PORTABLE X-RAY — multiple angles if metallic container',
        '13. SELECT RENDER SAFE PROCEDURE based on container material:',
        '    - Soft containers (backpack, cardboard): Standard Water Cannon / Water Disruption',
        '    - Metallic containers (briefcase, pipe, pressure cooker): Hard Target Disruptor',
        '    - Sealed/unstable containers: Controlled Detonation (blow-in-place)',
        '    - Vehicle-borne: Vehicle-rated Standoff Disruptor',
        '14. EXECUTE RSP via robot',
        '15. Technician approach in bomb suit for confirmation',
        '16. Collect evidence for forensics',
        '17. Shrink exclusion zone, restore comms, declare ALL CLEAR',
        '',
        '#### CRITICAL WARNINGS:',
        '- LIVE DEVICES DETONATE AFTER 2 MINUTES from discovery — time is critical',
        '- NEVER approach manually before deploying robot',
        '- NEVER use standard water disruptor on metallic containers',
        '- NEVER move an unstable device manually',
        '- ALWAYS establish exclusion zone BEFORE any render-safe attempt',
        '- ALWAYS order comms blackout within exclusion zone',
        '',
        '#### Equipment Available:',
        '- EOD Robot (ROV), Portable X-ray, Standard Water Disruptor, Hard Target Disruptor',
        '- Blast Shield / Bomb Suit (×2), K9 Explosive Detection Unit',
        '- Total Containment Vessel (TCV), Counter-charge Kit',
        '- Electronic Countermeasure (ECM), Detonation Cord, Evidence Collection Kit',
        '',
        '#### Contraindications by Container:',
        '- Metallic: do NOT use standard water cannon (fragmentation risk)',
        '- Unstable: do NOT move manually, do NOT transport without TCV',
        '- Unknown: treat as worst-case (metallic + unstable) until X-ray confirms',
        '',
        '#### SWEEP ACTION (Bomb Squad exclusive):',
        'Use the "sweep_asset" action to sweep other teams\' placed assets for hidden devices.',
        'Format: { "action": "sweep_asset", "sweep_asset": { "asset_id": "<exact UUID from SWEEPABLE ASSETS list>", "asset_label": "<label>" } }',
        'You MUST sweep at least 1 asset per cycle when there are un-swept assets available.',
        'If a device is found, it will appear as a hazard pin — respond to it with pin_response.',
      );
    }

    // Fallback for teams that don't match any specific playbook
    if (!tk) {
      parts.push(
        '',
        `### EXPERT PLAYBOOK: ${teamName.toUpperCase()}`,
        '- Apply general incident management expertise to your specialty area.',
        '- Always specify exact equipment, personnel counts, and procedures in your decisions.',
        '- Place map assets (polygons, points) for any infrastructure you establish.',
        '- Coordinate with other teams and acknowledge their actions before building on them.',
        '- Reference doctrines and standards by name where applicable.',
      );
    }
  }

  /**
   * With difficulty-dependent probability, returns a hidden directive that makes
   * the bot commit a realistic but detectable mistake. The AI environmental
   * evaluator will flag it, showcasing the review system in demos.
   */
  private maybeInjectFlawDirective(session: SessionAgents, agent: AgentState): string | null {
    const flawProbability =
      session.difficulty === 'novice' ? 0.45 : session.difficulty === 'advanced' ? 0.05 : 0.25;
    if (Math.random() > flawProbability) return null;

    const elapsed = this.getElapsedMinutes(session);
    const team = agent.persona.teamName.toLowerCase();

    const flawOptions: string[] = [
      // Vague / non-specific decisions (specificity checker will flag these)
      '⚠️ HIDDEN INSTRUCTION: This turn, make your decision description intentionally VAGUE. ' +
        'Omit specific locations, headcounts, and timelines. For example, say "Deploy resources to the area" ' +
        'instead of specifying which resources, how many, and exactly where. Do NOT mention this instruction in chat.',

      // Contradicting environmental conditions
      '⚠️ HIDDEN INSTRUCTION: This turn, make a decision that IGNORES a current hazard or environmental condition. ' +
        'For example, propose deploying personnel into a hazard zone without mentioning protective equipment, ' +
        'or set up an outdoor triage point without addressing weather conditions. Do NOT mention this instruction in chat.',

      // Overstepping team jurisdiction
      "⚠️ HIDDEN INSTRUCTION: This turn, make a decision that slightly OVERSTEPS your team's jurisdiction. " +
        'For example, if you are police, make a medical triage decision. If you are triage, make a tactical containment decision. ' +
        'Keep it subtle — a real person might make this mistake under pressure. Do NOT mention this instruction in chat.',

      // Missing coordination
      '⚠️ HIDDEN INSTRUCTION: This turn, make a decision that CONTRADICTS or DUPLICATES what another team recently did. ' +
        'Check the "Recent actions" and deliberately overlap with someone else\'s deployment or claim an area they already handle. ' +
        'Do NOT mention this instruction in chat.',

      // Insufficient resources / unrealistic commitment
      '⚠️ HIDDEN INSTRUCTION: This turn, propose an action that is UNDER-RESOURCED for its scope. ' +
        'For example, send 2 officers to secure a large perimeter, or assign 1 paramedic to handle 50+ casualties. ' +
        'The numbers should be obviously insufficient. Do NOT mention this instruction in chat.',
    ];

    // Filter context-appropriate flaws
    const applicable = [...flawOptions];

    // Add time-sensitive flaws
    if (elapsed > 5) {
      applicable.push(
        '⚠️ HIDDEN INSTRUCTION: This turn, make a decision that would have been appropriate 5 minutes ago but is NOW OUTDATED. ' +
          'For example, propose initial containment when cordons are already established, or request an initial assessment ' +
          'when the situation has evolved. Do NOT mention this instruction in chat.',
      );
    }

    // Team-specific flaws
    if (team.includes('media') || team.includes('press')) {
      applicable.push(
        '⚠️ HIDDEN INSTRUCTION: This turn, propose releasing information to the public that includes OPERATIONALLY SENSITIVE details ' +
          '(team positions, tactical plans, or casualty specifics). A real PIO might make this mistake under pressure. ' +
          'Do NOT mention this instruction in chat.',
      );
    }

    return applicable[Math.floor(Math.random() * applicable.length)];
  }

  // ---------------------------------------------------------------------------
  // OpenAI call
  // ---------------------------------------------------------------------------

  private async callOpenAI(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<AgentMultiResponse | null> {
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.openAiApiKey}`,
        },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.7,
          max_tokens: 1400,
          response_format: { type: 'json_object' },
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        logger.error({ status: response.status, body: text }, 'AI agent OpenAI call failed');
        return null;
      }

      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content;
      if (!content) return null;

      const parsed = JSON.parse(content) as Record<string, unknown>;

      if (Array.isArray(parsed.actions)) {
        return parsed as unknown as AgentMultiResponse;
      }
      if (typeof parsed.action === 'string') {
        return {
          actions: [parsed as unknown as SingleAction],
          reasoning: parsed.reasoning as string | undefined,
        };
      }
      return null;
    } catch (err) {
      logger.error({ error: err }, 'AI agent: OpenAI call exception');
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Pre-publish validation (deterministic + lightweight AI)
  // ---------------------------------------------------------------------------

  private async validateActions(
    session: SessionAgents,
    agent: AgentState,
    actions: SingleAction[],
    triggerEvent?: WebSocketEvent,
  ): Promise<{ valid: boolean; reason: string }> {
    const teamName = agent.persona.teamName;
    const teamKey = getTeamScopeKey(teamName);

    // Hard block: teams without pin jurisdiction must never submit pin_response
    const PIN_RESPONSE_TEAMS: Record<string, Set<string>> = {
      triage: new Set(['casualty']),
      fire: new Set(['casualty', 'hazard']),
      evacuation: new Set(['casualty']),
      bomb_squad: new Set(['hazard']),
    };
    const allowedTargets = teamKey ? PIN_RESPONSE_TEAMS[teamKey] : undefined;
    const pinAction = actions.find((a) => a.action === 'pin_response' && a.pin_response);
    if (pinAction?.pin_response) {
      if (!allowedTargets) {
        return {
          valid: false,
          reason: `${teamName} does NOT have pin response jurisdiction. Do NOT interact with casualties or hazards. Your role is ${teamKey === 'media' ? 'public communication and media management' : teamKey === 'pursuit' ? 'suspect tracking and intelligence' : 'coordination'} only. Submit a DECISION instead.`,
        };
      }
      if (!allowedTargets.has(pinAction.pin_response.target_type)) {
        return {
          valid: false,
          reason: `${teamName} cannot respond to ${pinAction.pin_response.target_type} pins. Your jurisdiction is limited to: ${[...allowedTargets].join(', ')} pins only.`,
        };
      }
    }

    // Load blueprint to check completeness
    const scenarioMetrics = await loadScenarioMetrics(
      session.sessionId,
      session.scenarioId,
      session.incidentCenter,
    );
    const blueprint = teamKey ? generateTeamBlueprint(teamKey, scenarioMetrics) : null;

    const { data: placedRaw } = await supabaseAdmin
      .from('placed_assets')
      .select('asset_type')
      .eq('session_id', session.sessionId)
      .eq('team_name', teamName)
      .eq('status', 'active');
    const placedTypes = new Set(
      (placedRaw ?? []).map((a) => (a as Record<string, unknown>).asset_type as string),
    );

    const isOperational =
      !blueprint || blueprint.items.every((item) => placedTypes.has(item.asset_type));
    const pendingItems = blueprint
      ? blueprint.items
          .filter((item) => !placedTypes.has(item.asset_type))
          .sort((a, b) => a.priority - b.priority)
      : [];

    // Infrastructure awareness: log a warning but do NOT block pin responses or decisions
    // The evaluator will flag missing infrastructure as consequences (same as human players)
    if (!isOperational && pendingItems.length > 0) {
      logger.info(
        { botUserId: agent.persona.botUserId, teamName, pending: pendingItems.length },
        'AI agent: operating area incomplete but allowing action (evaluator will handle consequences)',
      );
    }

    // Check 4: Media statement / public communication quality
    // Only reject statements that are ENTIRELY generic fluff with no substance.
    // Statements with specific numbers, locations, or actions pass — the AI evaluator
    // handles nuanced feedback (missing rebuttal, missing spokesperson, etc.) via consequences.
    const decisionForMedia = actions.find((a) => a.action === 'decision' && a.decision);
    if (decisionForMedia?.decision) {
      const fullText = `${decisionForMedia.decision.title} ${decisionForMedia.decision.description}`;
      const textLower = fullText.toLowerCase();

      const isMediaStatement =
        /public statement|press release|media release|media statement|press briefing|public update|official statement|public communication|issue.*statement|release.*statement|coordinate.*media.*statement/i.test(
          textLower,
        );
      const isCoordinateWithMedia =
        /coordinate.*with.*media|request.*media.*team|liaise.*with.*pio|ask.*media.*to.*publish|media.*team.*to.*issue/i.test(
          textLower,
        );

      if (isMediaStatement || isCoordinateWithMedia) {
        const hasSpecificNumbers =
          /\d+\s*(casualt|patient|injur|dead|wound|affect|evacuee|people|person|crowd|responder|ambulance|team)/i.test(
            fullText,
          );
        const hasSpecificLocation =
          /\bat\b.*\b(gate|exit|zone|area|street|road|station|beach|building|hall)/i.test(
            textLower,
          );
        const hasSpecificAction =
          /\b(triage|evacuat|contain|cordon|secur|transport|treat|deploy|establish|decontaminat)/i.test(
            textLower,
          );
        const isGenericFluff =
          /managing the situation|situation is under control|response is underway|working to ensure|all necessary measures|appropriate action|responding accordingly|we are aware/i.test(
            textLower,
          );

        // Only reject if the statement is pure generic fluff with NO substance at all
        const hasAnySubstance = hasSpecificNumbers || hasSpecificLocation || hasSpecificAction;
        if (isGenericFluff && !hasAnySubstance) {
          return {
            valid: false,
            reason: `Media statements MUST contain specific, verifiable information — not generic reassurances like "the situation is under control". Include concrete facts from the ground truth: ${scenarioMetrics.totalCasualties} casualties, ${scenarioMetrics.totalCrowdSize} crowd members, ${scenarioMetrics.hazardCount} hazard(s), ${scenarioMetrics.exitCount} exits.`,
          };
        }
      }
    }

    // Check 4b: Non-media teams must NOT issue public statements for media_statement injects
    if (decisionForMedia?.decision) {
      const triggerInjectData = (triggerEvent?.data as Record<string, unknown> | undefined)
        ?.inject as Record<string, unknown> | undefined;
      const triggerResponseType = (triggerInjectData?.response_type as string) ?? 'standard';
      const isThisMediaTeam = /media|communi/i.test(teamName);

      if (triggerResponseType === 'media_statement' && !isThisMediaTeam) {
        const dText =
          `${decisionForMedia.decision.title} ${decisionForMedia.decision.description}`.toLowerCase();
        const looksLikeStatement =
          /public statement|press release|media statement|official statement|we are informing|we can confirm to the press|we announce/i.test(
            dText,
          );
        const looksLikeCoordination =
          /communicate to media|coordinate with media|inform media team|advise media|relay to media|update media team/i.test(
            dText,
          );

        if (looksLikeStatement && !looksLikeCoordination) {
          return {
            valid: false,
            reason:
              'Non-media teams must coordinate with the media team, not issue public statements directly. Frame as: "Communicate to media team: [your verified facts]"',
          };
        }
      }
    }

    // Check 5: Inject relevance — if responding to an inject, does the response match the content?
    if (triggerEvent?.type === 'inject.published') {
      const injectData = (triggerEvent.data as Record<string, unknown>)?.inject as
        | Record<string, unknown>
        | undefined;
      if (injectData) {
        const injectText =
          `${injectData.title || ''} ${injectData.content || injectData.description || ''}`.toLowerCase();
        const NON_MEDICAL =
          /media|press|journalist|reporter|camera|diplomat|ambassador|consul|official|vip|dignitar|politic|religious|influencer|social media|live.?stream/i;
        const MEDICAL_KEYWORDS =
          /casualty response|initiate triage|triage tag|administer first aid/i;
        const decisionAction = actions.find((a) => a.action === 'decision' && a.decision);
        if (
          decisionAction?.decision &&
          NON_MEDICAL.test(injectText) &&
          MEDICAL_KEYWORDS.test(
            `${decisionAction.decision.title} ${decisionAction.decision.description}`,
          )
        ) {
          return {
            valid: false,
            reason: `The inject is about "${(injectData.title as string) || 'non-medical situation'}" — this is NOT a medical/casualty event. Do NOT respond with triage or casualty actions. Respond with a coordination order, communication action, or request for assistance from the relevant team.`,
          };
        }
      }
    }

    return { valid: true, reason: '' };
  }

  /**
   * Programmatic fallback using the blueprint: when the bot fails validation
   * MAX_VALIDATION_RETRIES times, auto-place the next blueprint item with
   * correct geometry, personnel, and equipment.
   */
  private async generateFallbackPlacement(
    session: SessionAgents,
    agent: AgentState,
  ): Promise<SingleAction[] | null> {
    const center = session.incidentCenter;
    if (!center) return null;

    const teamKey = getTeamScopeKey(agent.persona.teamName);
    if (!teamKey) return null;

    const zonesDrawn = await hasDrawnZones(session.sessionId);

    const scenarioMetrics = await loadScenarioMetrics(
      session.sessionId,
      session.scenarioId,
      center,
    );
    const blueprint = generateTeamBlueprint(teamKey, scenarioMetrics);

    const { data: placedRaw } = await supabaseAdmin
      .from('placed_assets')
      .select('asset_type')
      .eq('session_id', session.sessionId)
      .eq('team_name', agent.persona.teamName)
      .eq('status', 'active');
    const placedTypes = new Set(
      (placedRaw ?? []).map((a) => (a as Record<string, unknown>).asset_type as string),
    );

    // Use blueprint id to track completion (asset_type can be shared across items)
    const placedIds = new Set<string>();
    for (const item of blueprint.items) {
      if (placedTypes.has(item.asset_type)) placedIds.add(item.id);
    }

    const pending = blueprint.items
      .filter((item) => !placedIds.has(item.id))
      .sort((a, b) => a.priority - b.priority);

    if (pending.length === 0) return null;

    // Collect items to place this cycle: the next item, plus any polygon that
    // anchors to it (so point + surrounding perimeter are placed atomically).
    const itemsToPlace: BlueprintItem[] = [pending[0]];

    if (pending[0].geometry_type === 'point') {
      // Look for a subsequent polygon that anchors to this point's asset_type
      const pointType = pending[0].asset_type;
      for (let i = 1; i < pending.length; i++) {
        const candidate = pending[i];
        if (candidate.geometry_type !== 'polygon' || !candidate.radius_deg) continue;
        const mapping = CORDON_ANCHOR_MAP[candidate.id] ?? CORDON_ANCHOR_MAP[candidate.asset_type];
        if (mapping && Array.isArray(mapping.anchorTo) && mapping.anchorTo.includes(pointType)) {
          itemsToPlace.push(candidate);
          break;
        }
      }
    }

    const actions: SingleAction[] = [];
    let primaryLat = center.lat;
    let primaryLng = center.lng;

    for (const item of itemsToPlace) {
      let geometry: { type: string; coordinates: unknown };
      let placedLat: number;
      let placedLng: number;

      if (item.geometry_type === 'polygon' && item.radius_deg) {
        // Polygons: center on the point asset just placed, or incident center
        placedLat = primaryLat;
        placedLng = primaryLng;

        if (!ZONE_DECLARATION_TYPES.has(item.asset_type)) {
          const anchorAsset = await resolveCordonAnchor(
            item.asset_type,
            item.id,
            session.sessionId,
            agent.persona.teamName,
            center,
          );
          if (anchorAsset) {
            placedLat = anchorAsset.lat;
            placedLng = anchorAsset.lng;
          }
        }

        const clampedRadius = clampCordonRadius(item.radius_deg, item.asset_type);
        const pts: [number, number][] = [];
        for (let i = 0; i < 12; i++) {
          const angle = (2 * Math.PI * i) / 12;
          pts.push([
            placedLng + clampedRadius * Math.cos(angle),
            placedLat + clampedRadius * Math.sin(angle),
          ]);
        }
        pts.push(pts[0]);
        geometry = { type: 'Polygon', coordinates: [pts] };
      } else {
        const effectiveZone = resolveEffectiveZone(item.zone, teamKey, zonesDrawn);
        const zoneCoord = randomCoordInZone(center, effectiveZone, scenarioMetrics);
        placedLat = zoneCoord.lat;
        placedLng = zoneCoord.lng;
        primaryLat = placedLat;
        primaryLng = placedLng;
        geometry = {
          type: 'Point',
          coordinates: [placedLng, placedLat],
        };
      }

      const personnelDesc = item.personnel
        .map((p) => `${p.count}x ${p.role}${p.ppe ? ` (${p.ppe})` : ''}`)
        .join(', ');
      const equipDesc = item.equipment.join(', ');
      const coordsStr = `[${placedLat.toFixed(6)}, ${placedLng.toFixed(6)}]`;
      const effectiveRadius = item.radius_deg
        ? clampCordonRadius(item.radius_deg, item.asset_type)
        : null;
      const radiusStr = effectiveRadius
        ? ` Radius: ~${Math.round(effectiveRadius * METERS_PER_DEG)}m.`
        : '';

      logger.info(
        { botUserId: agent.persona.botUserId, assetType: item.asset_type, label: item.label },
        'AI agent: generating fallback placement from blueprint after failed retries',
      );

      const FALLBACK_ZONE_MAP: Record<string, string> = {
        hot_zone: 'hot',
        warm_zone: 'warm',
        cold_zone: 'cold',
      };
      const zoneProps: Record<string, unknown> = {
        personnel: personnelDesc,
        equipment: equipDesc,
        capacity: item.capacity,
      };
      if (item.asset_type in FALLBACK_ZONE_MAP) {
        zoneProps.zone_classification = FALLBACK_ZONE_MAP[item.asset_type];
      }

      actions.push({
        action: 'placement',
        placement: {
          asset_type: item.asset_type,
          label: item.label,
          geometry,
          properties: zoneProps,
        },
      });

      // Decision for each item
      actions.push({
        action: 'decision',
        decision: {
          title: `Establish ${item.label}`,
          description: `${item.description} Location: ${coordsStr} in the ${item.zone} zone.${radiusStr} Deploying ${personnelDesc}. Equipment: ${equipDesc}.`,
        },
      });
    }

    return actions;
  }

  /**
   * AI-based placement extraction: when a bot writes a decision that mentions
   * infrastructure, use a lightweight AI call to identify intent and create
   * the appropriate placements with correct geometry.
   */
  private async aiExtractAndCreatePlacements(
    session: SessionAgents,
    agent: AgentState,
    title: string,
    description: string,
  ): Promise<void> {
    const center = session.incidentCenter;
    if (!center) return;

    const teamName = agent.persona.teamName;

    // Quick pre-check: skip if the team has all required infrastructure
    const infraStatus = await checkInfrastructureStatus(session.sessionId, teamName);
    if (infraStatus.ready) return;

    const fullText = `${title} ${description}`;
    // Quick keyword gate — only call AI if text mentions something placement-like
    const mentionsInfra =
      /cordon|tent|point|post|area|zone|staging|barricade|roadblock|perimeter|fence|barrier|assembly|command|triage|hospital|decon/i;
    if (!mentionsInfra.test(fullText)) return;

    const scenarioMetrics = await loadScenarioMetrics(
      session.sessionId,
      session.scenarioId,
      center,
    );

    // Build the allowed asset types for this team
    const teamKey = getTeamScopeKey(teamName);
    const TEAM_PLACEMENTS = teamKey
      ? ((
          {
            police: [
              'command_post',
              'inner_cordon',
              'outer_cordon',
              'roadblock',
              'observation_post',
              'staging_area',
              'forward_command',
            ],
            security: [
              'command_post',
              'inner_cordon',
              'outer_cordon',
              'roadblock',
              'observation_post',
              'staging_area',
            ],
            fire: [
              'fire_truck',
              'water_supply',
              'forward_command',
              'staging_area',
              'command_post',
              'decontamination_zone',
            ],
            hazmat: [
              'fire_truck',
              'water_supply',
              'forward_command',
              'staging_area',
              'command_post',
              'exclusion_zone',
              'decontamination_zone',
            ],
            triage: [
              'triage_point',
              'field_hospital',
              'casualty_collection',
              'ambulance_staging',
              'helicopter_lz',
              'command_post',
              'inner_cordon',
            ],
            medical: [
              'triage_point',
              'field_hospital',
              'casualty_collection',
              'ambulance_staging',
              'helicopter_lz',
              'command_post',
              'inner_cordon',
            ],
            ems: [
              'triage_point',
              'field_hospital',
              'casualty_collection',
              'ambulance_staging',
              'helicopter_lz',
            ],
            evacuation: ['assembly_point', 'staging_area', 'marshal_post', 'command_post'],
            media: ['press_cordon', 'media_staging'],
          } as Record<string, string[]>
        )[teamKey] ?? [])
      : [];

    try {
      const extractionPrompt = [
        'Analyze this emergency response decision and identify any infrastructure the team intends to place on the map.',
        '',
        `Team: ${teamName}`,
        `Allowed asset types: ${TEAM_PLACEMENTS.join(', ')}`,
        `Missing required infrastructure: ${infraStatus.missing.join(', ')}`,
        `Decision title: ${title}`,
        `Decision text: ${description}`,
        `Incident center: [${center.lat}, ${center.lng}]`,
        '',
        `Zone boundaries (meters from incident center):`,
        `  HOT zone: 0–${scenarioMetrics.hotZoneRadius}m (${(scenarioMetrics.hotZoneRadius / METERS_PER_DEG).toFixed(6)}°)`,
        `  WARM zone: ${scenarioMetrics.hotZoneRadius}–${scenarioMetrics.warmZoneRadius}m (${(scenarioMetrics.warmZoneRadius / METERS_PER_DEG).toFixed(6)}°)`,
        `  COLD zone: ${scenarioMetrics.warmZoneRadius}–${scenarioMetrics.coldZoneRadius}m (${(scenarioMetrics.coldZoneRadius / METERS_PER_DEG).toFixed(6)}°)`,
        '',
        'For each intended placement, return JSON array:',
        '[{ "asset_type": "...", "geometry_type": "point" or "polygon", "lat": number, "lng": number, "radius_deg": number_or_null, "label": "..." }]',
        '',
        'Rules:',
        '- Only return placements from the allowed asset types list.',
        '- Prioritize the missing required infrastructure.',
        '- CRITICAL for cordons/perimeters (inner_cordon, outer_cordon, exclusion_zone): ALWAYS set lat/lng to the incident center coordinates. Cordons must be centered on the incident pin, never offset randomly.',
        '- For team-specific operating perimeters (triage cordon, press cordon, assembly perimeter): set lat/lng to the incident center — the system will auto-anchor them to the correct placed asset.',
        '- For point types in the HOT zone: coordinates within ' +
          (scenarioMetrics.hotZoneRadius / METERS_PER_DEG).toFixed(6) +
          '° of center.',
        '- For point types in the WARM zone: coordinates between ' +
          (scenarioMetrics.hotZoneRadius / METERS_PER_DEG).toFixed(6) +
          '° and ' +
          (scenarioMetrics.warmZoneRadius / METERS_PER_DEG).toFixed(6) +
          '° of center.',
        '- For point types in the COLD zone: coordinates between ' +
          (scenarioMetrics.warmZoneRadius / METERS_PER_DEG).toFixed(6) +
          '° and ' +
          (scenarioMetrics.coldZoneRadius / METERS_PER_DEG).toFixed(6) +
          '° of center.',
        '- For polygon types: set radius_deg to max 0.00045 (~50m radius). NEVER larger.',
        '- For point types: set radius_deg to null.',
        '- Return empty array [] if no infrastructure placement is intended.',
      ].join('\n');

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.openAiApiKey}`,
        },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: [
            {
              role: 'system',
              content:
                'You extract infrastructure placement intents from emergency response decisions. Return valid JSON only.',
            },
            { role: 'user', content: extractionPrompt },
          ],
          temperature: 0.2,
          max_tokens: 500,
          response_format: { type: 'json_object' },
        }),
      });

      if (!response.ok) return;

      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content;
      if (!content) return;

      const parsed = JSON.parse(content) as Record<string, unknown>;
      const placements = (
        Array.isArray(parsed.placements) ? parsed.placements : Array.isArray(parsed) ? parsed : []
      ) as Array<{
        asset_type: string;
        geometry_type: string;
        lat?: number;
        lng?: number;
        radius_deg?: number;
        label?: string;
      }>;

      if (placements.length === 0) return;

      // Check what already exists to avoid duplicates
      const { data: existingAssets } = await supabaseAdmin
        .from('placed_assets')
        .select('asset_type, geometry')
        .eq('session_id', session.sessionId)
        .eq('team_name', teamName)
        .eq('status', 'active');

      const existingTypes = new Set(
        (existingAssets ?? []).map((a) => (a as Record<string, unknown>).asset_type as string),
      );

      // Load all existing pin positions for coordinate deconfliction
      const occupiedCoords = await loadOccupiedCoordinates(session.sessionId);

      let placedCount = 0;
      for (const p of placements) {
        if (placedCount >= 4) break;
        if (!TEAM_PLACEMENTS.includes(p.asset_type)) continue;
        if (existingTypes.has(p.asset_type)) continue;
        if (!isPlacementAllowedForTeam(teamName, p.asset_type)) continue;

        let pLat: number;
        let pLng: number;

        const isCordonType = /cordon|perimeter|exclusion_zone/i.test(p.asset_type);
        if (isCordonType && p.geometry_type === 'polygon') {
          const anchor = await resolveCordonAnchor(
            p.asset_type,
            p.asset_type,
            session.sessionId,
            teamName,
            center,
          );
          pLat = anchor?.lat ?? center.lat;
          pLng = anchor?.lng ?? center.lng;
        } else if (p.lat != null && p.lng != null) {
          pLat = p.lat;
          pLng = p.lng;
        } else {
          const inferredZone = /hot_zone|exclusion/i.test(p.asset_type)
            ? 'hot'
            : /warm_zone|triage|forward_command|fire_truck|water_supply|decon|casualty_collection/i.test(
                  p.asset_type,
                )
              ? 'warm'
              : 'cold';
          const zonesExist = await hasDrawnZones(session.sessionId);
          const effectiveZone = resolveEffectiveZone(inferredZone, teamKey, zonesExist);
          const metrics = await loadScenarioMetrics(session.sessionId, session.scenarioId, center);
          const zoneCoord = randomCoordInZone(center, effectiveZone, metrics);
          pLat = zoneCoord.lat;
          pLng = zoneCoord.lng;
        }

        // Deconflict: ensure minimum 100m from all existing pins (skip for cordons anchored to incident center)
        if (!isCordonType) {
          const nudged = deconflictCoordinate(pLat, pLng, occupiedCoords, MIN_PIN_DISTANCE_M);
          pLat = nudged.lat;
          pLng = nudged.lng;
        }

        let geometry: { type: string; coordinates: unknown };
        const catalogEntry = ASSET_TYPE_CATALOG[p.asset_type];
        const shouldBePolygon =
          p.geometry_type === 'polygon' || catalogEntry?.geometry === 'polygon';

        // Snap point placements to building studs if inside a building
        if (!shouldBePolygon) {
          const snapped = await snapIfInsideBuilding(
            pLat,
            pLng,
            'G',
            session.scenarioId,
            session.sessionId,
          );
          pLat = snapped.lat;
          pLng = snapped.lng;
        }

        if (shouldBePolygon) {
          const radiusDeg = p.radius_deg || 30 / METERS_PER_DEG;
          const clampedR = clampCordonRadius(radiusDeg, p.asset_type);
          const pts: [number, number][] = [];
          for (let i = 0; i < 12; i++) {
            const angle = (2 * Math.PI * i) / 12;
            pts.push([pLng + clampedR * Math.cos(angle), pLat + clampedR * Math.sin(angle)]);
          }
          pts.push(pts[0]);
          geometry = { type: 'Polygon', coordinates: [pts] };
        } else {
          geometry = { type: 'Point', coordinates: [pLng, pLat] };
        }

        const label = p.label || `${teamName} ${p.asset_type.replace(/_/g, ' ')}`;

        logger.info(
          { botUserId: agent.persona.botUserId, assetType: p.asset_type, label },
          'AI agent: AI-extracted placement from decision text',
        );

        await this.dispatcher.createPlacement(session.sessionId, agent.persona.botUserId, {
          team_name: teamName,
          asset_type: p.asset_type,
          label,
          geometry,
          properties: {},
        });

        // Auto-create paired perimeter for point placements
        if (geometry.type === 'Point') {
          await autoCreatePairedPerimeter(
            session.sessionId,
            teamName,
            p.asset_type,
            pLat,
            pLng,
            agent.persona.botUserId,
          );
        }

        // Track newly placed coordinate to avoid stacking within the same batch
        occupiedCoords.push({ lat: pLat, lng: pLng });
        existingTypes.add(p.asset_type);
        placedCount++;
      }
    } catch (err) {
      logger.warn({ error: err }, 'AI agent: AI placement extraction failed, skipping');
    }
  }

  // ---------------------------------------------------------------------------
  // Action execution
  // ---------------------------------------------------------------------------

  private async executeSingleAction(
    session: SessionAgents,
    agent: AgentState,
    action: SingleAction,
    triggerEvent?: WebSocketEvent,
  ): Promise<void> {
    const { sessionId, channelId } = session;
    const { botUserId, teamName } = agent.persona;

    // Extract trigger inject text for relevance checks
    const triggerInjectData =
      triggerEvent?.type === 'inject.published'
        ? ((triggerEvent.data as Record<string, unknown>)?.inject as
            | Record<string, unknown>
            | undefined)
        : undefined;
    const triggerInjectText = triggerInjectData
      ? `${(triggerInjectData.title as string) ?? ''} ${(triggerInjectData.description as string) ?? (triggerInjectData.content as string) ?? ''}`.toLowerCase()
      : '';

    switch (action.action) {
      case 'decision': {
        if (!action.decision) break;

        // Always extract and place any infrastructure mentioned in the decision text,
        // regardless of whether it gets auto-converted to a pin_response below.
        await this.tryExtractPlacementsFromDecision(
          session,
          agent,
          action.decision.title,
          action.decision.description,
        );

        // Fallback: if the decision text mentions a casualty/hazard UUID,
        // auto-convert to a pin_response so the pin actually gets updated
        const converted = await this.tryConvertDecisionToPinResponse(
          session,
          agent,
          action.decision.title,
          action.decision.description,
          triggerInjectText,
        );
        if (converted) {
          logger.info(
            { botUserId, targetId: converted.target_id, targetType: converted.target_type },
            'AI agent: auto-converted decision to pin_response (decision text referenced a pin)',
          );
          await this.dispatcher.respondToPin(sessionId, botUserId, teamName, converted);
          break;
        }

        await this.dispatcher.proposeAndExecuteDecision(sessionId, botUserId, {
          title: action.decision.title,
          description: action.decision.description,
        });
        break;
      }

      case 'placement': {
        if (!action.placement) break;
        if (!isPlacementAllowedForTeam(teamName, action.placement.asset_type)) {
          logger.warn(
            { botUserId, teamName, assetType: action.placement.asset_type },
            'AI agent: placement blocked — asset type not allowed for this team',
          );
          break;
        }

        const assetType = action.placement.asset_type;
        const isCordonLike = /cordon|perimeter|exclusion_zone/i.test(assetType);

        // Skip if a perimeter with the same label already exists (e.g. auto-created)
        if (isCordonLike && action.placement.label) {
          const { data: dup } = await supabaseAdmin
            .from('placed_assets')
            .select('id')
            .eq('session_id', sessionId)
            .eq('team_name', teamName)
            .eq('label', action.placement.label)
            .eq('status', 'active')
            .limit(1);
          if (dup?.length) {
            logger.info(
              { botUserId, teamName, label: action.placement.label },
              'AI agent: skipping perimeter — already exists (auto-paired)',
            );
            break;
          }
        }

        // Block cordon/perimeter placement until the team has at least one point asset
        if (isCordonLike && !ZONE_DECLARATION_TYPES.has(assetType)) {
          const { data: teamAssets } = await supabaseAdmin
            .from('placed_assets')
            .select('asset_type')
            .eq('session_id', sessionId)
            .eq('team_name', teamName)
            .eq('status', 'active');
          const hasPointAsset = (teamAssets ?? []).some((a) => {
            const t = (a as Record<string, unknown>).asset_type as string;
            return !/cordon|perimeter|exclusion_zone|_zone$/i.test(t);
          });
          if (!hasPointAsset) {
            logger.info(
              { botUserId, teamName, assetType },
              'AI agent: cordon blocked — team has no point assets yet to anchor around',
            );
            break;
          }
        }

        let geometry: { type: string; coordinates: unknown };

        // For cordons, generate a deterministic circle polygon instead of trusting the LLM
        if (isCordonLike && session.incidentCenter) {
          const anchor = await resolveCordonAnchor(
            assetType,
            assetType,
            sessionId,
            teamName,
            session.incidentCenter,
          );
          const center = anchor ?? session.incidentCenter;
          const radiusDeg = clampCordonRadius(0.00045, assetType); // ~50m radius
          const SEGMENTS = 16;
          const ring: number[][] = [];
          for (let i = 0; i <= SEGMENTS; i++) {
            const angle = (2 * Math.PI * i) / SEGMENTS;
            ring.push([
              center.lng + radiusDeg * Math.cos(angle),
              center.lat + radiusDeg * Math.sin(angle),
            ]);
          }
          geometry = { type: 'Polygon', coordinates: [ring] };
        } else {
          geometry = this.translateGeometry(
            action.placement.geometry,
            session.incidentCenter,
            action.placement.asset_type,
          );
        }

        await this.dispatcher.createPlacement(sessionId, botUserId, {
          team_name: teamName,
          asset_type: action.placement.asset_type,
          label: action.placement.label || action.placement.asset_type.replace(/_/g, ' '),
          geometry,
          properties: action.placement.properties,
        });

        // Auto-create paired perimeter for point placements
        if (!isCordonLike && geometry.type === 'Point') {
          const coords = geometry.coordinates as number[];
          if (coords?.length >= 2) {
            await autoCreatePairedPerimeter(
              sessionId,
              teamName,
              assetType,
              coords[1],
              coords[0],
              botUserId,
            );
          }
        }
        break;
      }

      case 'claim': {
        if (!action.claim?.location_label) break;
        const locationId = await this.resolveLocationId(
          session.scenarioId,
          action.claim.location_label,
        );
        if (locationId) {
          await this.dispatcher.claimLocation(
            sessionId,
            locationId,
            teamName,
            action.claim.claimed_as || 'operational_use',
            action.claim.exclusivity,
          );
        }
        break;
      }

      case 'pin_response': {
        if (!action.pin_response?.target_id) {
          logger.warn(
            { botUserId, pinResponse: action.pin_response },
            'AI agent: pin_response missing target_id, skipping',
          );
          break;
        }
        // Look up the pin's casualty_type and zone for jurisdiction checks
        let pinCasualtyType: string | undefined;
        let pinZone: string | undefined;
        if (action.pin_response.target_type === 'casualty') {
          const { data: pinData } = await supabaseAdmin
            .from('scenario_casualties')
            .select('casualty_type, location_lat, location_lng')
            .eq('id', action.pin_response.target_id)
            .single();
          if (pinData) {
            pinCasualtyType = (pinData as Record<string, unknown>).casualty_type as string;
            const pLat = Number((pinData as Record<string, unknown>).location_lat);
            const pLng = Number((pinData as Record<string, unknown>).location_lng);
            if (session.incidentCenter) {
              // Fetch actual zone radii from scenario_hazards.zones
              const { data: zoneSource } = await supabaseAdmin
                .from('scenario_hazards')
                .select('zones')
                .eq('session_id', sessionId)
                .in('status', ['active', 'escalating'])
                .limit(5);
              interface ZoneRadii {
                zone_type: string;
                radius_m: number;
                polygon?: [number, number][];
              }
              let zones: ZoneRadii[] = [];
              for (const zs of (zoneSource ?? []) as Array<Record<string, unknown>>) {
                const z = zs.zones as ZoneRadii[] | null;
                if (z && z.length > 0) {
                  zones = z;
                  break;
                }
              }
              const dist = haversineM(
                pLat,
                pLng,
                session.incidentCenter.lat,
                session.incidentCenter.lng,
              );
              if (zones.length > 0) {
                const sorted = [...zones].sort((a, b) => a.radius_m - b.radius_m);
                let matched = false;
                for (const z of sorted) {
                  if (z.polygon && z.polygon.length > 0) {
                    if (pointInPolygon(pLat, pLng, z.polygon)) {
                      pinZone = z.zone_type;
                      matched = true;
                      break;
                    }
                  } else if (dist <= z.radius_m) {
                    pinZone = z.zone_type;
                    matched = true;
                    break;
                  }
                }
                if (!matched) pinZone = 'outside';
              } else {
                if (dist <= 50) pinZone = 'hot';
                else if (dist <= 150) pinZone = 'warm';
                else if (dist <= 300) pinZone = 'cold';
                else pinZone = 'outside';
              }
            }
          }
        }

        // Log jurisdiction info — evaluator will handle consequences (same as human players)
        if (
          this.isTeamBlockedFromPinResponse(
            teamName,
            action.pin_response.target_type,
            pinCasualtyType,
            pinZone,
          )
        ) {
          logger.info(
            {
              botUserId,
              teamName,
              targetType: action.pin_response.target_type,
              pinCasualtyType,
              pinZone,
            },
            'AI agent: pin_response outside jurisdiction — evaluator will handle consequences',
          );
        }
        const pr = action.pin_response;
        logger.info(
          { botUserId, targetId: pr.target_id, targetType: pr.target_type, label: pr.target_label },
          'AI agent: executing pin_response',
        );

        // Fire/Hazmat teams can extract casualties but cannot assign triage colors
        const teamKey = getTeamScopeKey(teamName);
        const stripTriage =
          teamKey && EXTRACT_ONLY_TEAMS.has(teamKey) && pr.target_type === 'casualty';

        await this.dispatcher.respondToPin(sessionId, botUserId, teamName, {
          target_id: pr.target_id,
          target_type: pr.target_type,
          target_label: pr.target_label || 'Unknown target',
          actions: pr.actions || [],
          resources: pr.resources || [],
          triage_color: stripTriage ? undefined : pr.triage_color,
          description: pr.description || '',
        });
        break;
      }

      case 'sweep_asset': {
        if (!action.sweep_asset?.asset_id) break;
        const sa = action.sweep_asset;
        logger.info(
          { botUserId, assetId: sa.asset_id, assetLabel: sa.asset_label },
          'AI agent: executing sweep_asset',
        );
        try {
          const sweepResult = await performSweep(sessionId, sa.asset_id);
          logger.info(
            {
              botUserId,
              assetId: sa.asset_id,
              found: sweepResult.found,
              isLive: sweepResult.is_live,
            },
            'AI agent: sweep completed',
          );
        } catch (sweepErr) {
          logger.warn({ error: sweepErr, botUserId, assetId: sa.asset_id }, 'Sweep failed');
        }
        break;
      }

      case 'chat': {
        if (!action.chat?.content || !channelId) break;
        await this.dispatcher.sendChatMessage(channelId, sessionId, botUserId, action.chat.content);
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private canAct(agent: AgentState, session: SessionAgents): boolean {
    if (agent.pendingCooldown) return false;
    const now = Date.now();
    const isEarly = this.getElapsedMinutes(session) < FOUNDATIONAL_PHASE_MINUTES;
    let throttle = isEarly ? AGENT_THROTTLE_EARLY_MS : AGENT_THROTTLE_MS;
    if (agent.lastActionWasPinResponse) throttle = AGENT_THROTTLE_PIN_MS;
    if (now - agent.lastActionTs < throttle) return false;
    if (session.scriptAware && session.scriptNextEventTs > 0) {
      if (session.scriptNextEventTs - now < HYBRID_DEFER_WINDOW_MS) return false;
    }
    return true;
  }

  private getElapsedMinutes(session: SessionAgents): number {
    return (Date.now() - session.startedAt) / 60_000;
  }

  private extractOriginatorId(event: WebSocketEvent): string | null {
    const data = event.data;
    const decision = data.decision as Record<string, unknown> | undefined;
    if (decision?.proposed_by) return decision.proposed_by as string;
    const placement = data.placement as Record<string, unknown> | undefined;
    if (placement?.placed_by) return placement.placed_by as string;
    const message = data.message as Record<string, unknown> | undefined;
    if (message?.sender_id) return message.sender_id as string;
    return null;
  }

  private translateGeometry(
    geometry: { type: string; coordinates: unknown },
    center: { lat: number; lng: number } | null,
    assetType?: string,
  ): { type: string; coordinates: unknown } {
    if (!center) return this.clampPolygonSize(geometry, center, assetType);

    const isNearOrigin = (coord: number[]): boolean =>
      Math.abs(coord[0]) < 1 && Math.abs(coord[1]) < 1;
    const translate = (coord: number[]): number[] => [coord[0] + center.lng, coord[1] + center.lat];

    try {
      if (geometry.type === 'Point') {
        const coords = geometry.coordinates as number[];
        if (Array.isArray(coords) && coords.length >= 2 && isNearOrigin(coords)) {
          return { type: 'Point', coordinates: translate(coords) };
        }
      } else if (geometry.type === 'LineString') {
        const coords = geometry.coordinates as number[][];
        if (Array.isArray(coords) && coords.length > 0 && isNearOrigin(coords[0])) {
          return { type: 'LineString', coordinates: coords.map(translate) };
        }
      } else if (geometry.type === 'Polygon') {
        const rings = geometry.coordinates as number[][][];
        if (
          Array.isArray(rings) &&
          rings.length > 0 &&
          rings[0].length > 0 &&
          isNearOrigin(rings[0][0])
        ) {
          return { type: 'Polygon', coordinates: rings.map((ring) => ring.map(translate)) };
        }
      }
    } catch {
      // geometry already absolute or malformed
    }
    return this.clampPolygonSize(geometry, center, assetType);
  }

  /**
   * Shrink oversized polygons so they don't span unrealistically large areas.
   * Max allowed span: ~0.0009° (~100m diameter / 50m radius).
   * Zone declaration types (hot_zone, warm_zone, cold_zone, hazard_zone) are exempt.
   */
  private clampPolygonSize(
    geometry: { type: string; coordinates: unknown },
    center: { lat: number; lng: number } | null,
    assetType?: string,
  ): { type: string; coordinates: unknown } {
    if (assetType && ZONE_DECLARATION_TYPES.has(assetType)) return geometry;
    if (geometry.type !== 'Polygon') return geometry;
    const MAX_SPAN = 0.0009; // ~100m diameter = 50m radius

    try {
      const rings = geometry.coordinates as number[][][];
      if (!Array.isArray(rings) || rings.length === 0 || rings[0].length < 4) return geometry;

      const ring = rings[0];
      let minLng = Infinity,
        maxLng = -Infinity,
        minLat = Infinity,
        maxLat = -Infinity;
      for (const c of ring) {
        if (c[0] < minLng) minLng = c[0];
        if (c[0] > maxLng) maxLng = c[0];
        if (c[1] < minLat) minLat = c[1];
        if (c[1] > maxLat) maxLat = c[1];
      }

      const spanLng = maxLng - minLng;
      const spanLat = maxLat - minLat;

      if (spanLng <= MAX_SPAN && spanLat <= MAX_SPAN) return geometry;

      const scaleFactor = Math.min(
        MAX_SPAN / Math.max(spanLng, 0.0001),
        MAX_SPAN / Math.max(spanLat, 0.0001),
      );
      const cLng = center?.lng ?? (minLng + maxLng) / 2;
      const cLat = center?.lat ?? (minLat + maxLat) / 2;

      const scaled = rings.map((r) =>
        r.map((coord) => [
          cLng + (coord[0] - cLng) * scaleFactor,
          cLat + (coord[1] - cLat) * scaleFactor,
        ]),
      );

      logger.info(
        {
          originalSpan: { lng: spanLng.toFixed(5), lat: spanLat.toFixed(5) },
          scaleFactor: scaleFactor.toFixed(3),
        },
        'AI agent: clamped oversized polygon',
      );

      return { type: 'Polygon', coordinates: scaled };
    } catch {
      return geometry;
    }
  }

  /**
   * Re-center a cordon/perimeter polygon on the correct anchor point.
   * Computes the LLM polygon's centroid, then shifts all vertices so the
   * centroid lands on the resolved anchor (incident center or team asset).
   */
  private async snapCordonToAnchor(
    geometry: { type: string; coordinates: unknown },
    assetType: string,
    sessionId: string,
    teamName: string,
    incidentCenter: { lat: number; lng: number },
  ): Promise<{ type: string; coordinates: unknown }> {
    try {
      const anchor = await resolveCordonAnchor(
        assetType,
        assetType,
        sessionId,
        teamName,
        incidentCenter,
      );
      if (!anchor) return geometry;

      const rings = geometry.coordinates as number[][][];
      if (!Array.isArray(rings) || rings.length === 0 || rings[0].length < 4) return geometry;

      const ring = rings[0];
      let cLng = 0;
      let cLat = 0;
      const n =
        ring[ring.length - 1][0] === ring[0][0] && ring[ring.length - 1][1] === ring[0][1]
          ? ring.length - 1
          : ring.length;
      for (let i = 0; i < n; i++) {
        cLng += ring[i][0];
        cLat += ring[i][1];
      }
      cLng /= n;
      cLat /= n;

      const dLng = anchor.lng - cLng;
      const dLat = anchor.lat - cLat;

      // Only snap if the centroid is off by more than ~10m
      if (Math.abs(dLat) < 0.0001 && Math.abs(dLng) < 0.0001) return geometry;

      const shifted = rings.map((r) => r.map((coord) => [coord[0] + dLng, coord[1] + dLat]));

      logger.info(
        {
          assetType,
          shiftLat: dLat.toFixed(6),
          shiftLng: dLng.toFixed(6),
          anchor: `[${anchor.lat.toFixed(6)}, ${anchor.lng.toFixed(6)}]`,
        },
        'AI agent: snapped cordon polygon to correct anchor point',
      );

      return { type: 'Polygon', coordinates: shifted };
    } catch {
      return geometry;
    }
  }

  /**
   * When the LLM outputs a decision instead of a pin_response but the text
   * clearly references a specific casualty/hazard UUID, auto-convert it so
   * the pin actually gets updated on the map and the spectator panel fires.
   */
  private async tryConvertDecisionToPinResponse(
    session: SessionAgents,
    agent: AgentState,
    title: string,
    description: string,
    triggerInjectText?: string,
  ): Promise<{
    target_id: string;
    target_type: 'casualty' | 'hazard';
    target_label: string;
    actions: string[];
    resources: Array<{ type: string; label: string; quantity: number }>;
    triage_color?: 'green' | 'yellow' | 'red' | 'black';
    description: string;
  } | null> {
    const fullText = `${title} ${description}`.toLowerCase();

    // Look for UUID patterns that match known casualties or hazards
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    const foundIds = fullText.match(uuidPattern);
    if (foundIds?.length) {
      // Check casualties first
      const { data: casualty } = await supabaseAdmin
        .from('scenario_casualties')
        .select('id, casualty_type, conditions, status')
        .eq('session_id', session.sessionId)
        .in('id', foundIds)
        .limit(1)
        .maybeSingle();

      if (casualty) {
        const cType = casualty.casualty_type as string;
        const isCrowdPin =
          cType === 'crowd' || cType === 'evacuee_group' || cType === 'convergent_crowd';
        const tk = getTeamScopeKey(agent.persona.teamName);

        // Block cross-team pin interactions
        if (isCrowdPin && tk !== 'evacuation') {
          logger.debug(
            { team: agent.persona.teamName, casualtyType: cType },
            "AI agent: skipping auto-convert — crowd pin is not this team's jurisdiction",
          );
          return null;
        }
        if (!isCrowdPin && tk === 'evacuation') {
          logger.debug(
            { team: agent.persona.teamName, casualtyType: cType },
            "AI agent: skipping auto-convert — patient pin is not evacuation's jurisdiction",
          );
          return null;
        }

        const conds = (casualty.conditions as Record<string, unknown>) ?? {};
        const patName = (conds.name as string) || '';
        const vis = (conds.visible_description as string) || (conds.injury_type as string) || '';
        const triageColor = this.inferTriageColor(fullText, conds);
        return {
          target_id: casualty.id as string,
          target_type: 'casualty',
          target_label: patName || vis || `${cType} (${casualty.status})`,
          actions: this.inferActionsFromText(fullText, 'casualty'),
          resources: [{ type: 'responder', label: `${agent.persona.teamName} Team`, quantity: 1 }],
          triage_color: isCrowdPin ? undefined : triageColor,
          description: description.slice(0, 300),
        };
      }

      // Check hazards
      const { data: hazard } = await supabaseAdmin
        .from('scenario_hazards')
        .select('id, hazard_type, status')
        .eq('session_id', session.sessionId)
        .in('id', foundIds)
        .limit(1)
        .maybeSingle();

      if (hazard) {
        return {
          target_id: hazard.id as string,
          target_type: 'hazard',
          target_label: `${hazard.hazard_type} (${hazard.status})`,
          actions: this.inferActionsFromText(fullText, 'hazard'),
          resources: [{ type: 'responder', label: `${agent.persona.teamName} Team`, quantity: 1 }],
          description: description.slice(0, 300),
        };
      }
    }

    // Also detect keyword-based references to casualties/hazards without UUIDs.
    // BUT FIRST: if the trigger inject describes a non-medical/non-hazard situation
    // (media, diplomats, VIPs, crowds without injuries), do NOT auto-convert even
    // if the bot's generated text mentions triage/treatment keywords.
    const NON_MEDICAL_INJECT_PATTERNS =
      /media|press|journalist|reporter|camera|diplomat|ambassador|consul|official|vip|dignitar|politic|protest|complain|public (concern|outrage|pressure)|social media|broadcast|interview|crowd.*(approach|gather|watch|curious)/i;
    const ACTUAL_INJURY_IN_INJECT =
      /injur|wound|bleed|casualt|victim|burn|fractur|unconscious|cardiac|breathing|pain|trauma|contaminat|expos|collapse/i;

    if (
      triggerInjectText &&
      NON_MEDICAL_INJECT_PATTERNS.test(triggerInjectText) &&
      !ACTUAL_INJURY_IN_INJECT.test(triggerInjectText)
    ) {
      logger.debug(
        { botUserId: agent.persona.botUserId, team: agent.persona.teamName },
        'AI agent: skipping keyword-based pin_response auto-conversion — trigger inject is not a medical/hazard situation',
      );
      return null;
    }

    const teamKey = getTeamScopeKey(agent.persona.teamName);
    const CROWD_TYPES = new Set(['crowd', 'evacuee_group', 'convergent_crowd']);

    const casualtyKeywords =
      /triage|treat|first aid|tourniquet|administer|assess (patient|casualt|victim|injur)/i;
    const hazardKeywords =
      /contain (fire|spill|leak|chemical)|suppress fire|extinguish|deploy foam|hazmat/i;
    const crowdKeywords =
      /evacuate|direct.*crowd|marshal|assembly|shelter.*in.*place|crowd.*manage/i;

    // Determine what type of pin this team should interact with
    const wantsCasualty =
      casualtyKeywords.test(fullText) && (teamKey === 'triage' || teamKey === 'fire');
    const wantsCrowd = crowdKeywords.test(fullText) && teamKey === 'evacuation';
    const wantsHazard =
      hazardKeywords.test(fullText) && (teamKey === 'fire' || teamKey === 'bomb_squad');

    if (wantsCasualty) {
      const statusFilter = ['undiscovered', 'identified', 'endorsed_to_triage', 'at_assembly'];
      const { data: targets } = await supabaseAdmin
        .from('scenario_casualties')
        .select('id, status, casualty_type, conditions')
        .eq('session_id', session.sessionId)
        .in('status', statusFilter)
        .limit(5);

      // Filter out crowd-type pins — triage only gets individual patients
      const filtered = (targets ?? []).filter((t) => {
        const ct = (t as Record<string, unknown>).casualty_type as string;
        return !CROWD_TYPES.has(ct);
      });

      if (filtered.length > 0) {
        const target = filtered[0] as unknown as Record<string, unknown>;
        const conds = (target.conditions as Record<string, unknown>) ?? {};
        const pName = (conds.name as string) || '';
        const vis = (conds.visible_description as string) || '';
        return {
          target_id: target.id as string,
          target_type: 'casualty',
          target_label: pName || vis || `${target.casualty_type} (${target.status})`,
          actions: this.inferActionsFromText(fullText, 'casualty'),
          resources: [{ type: 'responder', label: `${agent.persona.teamName} Team`, quantity: 1 }],
          triage_color: this.inferTriageColor(fullText, conds),
          description: description.slice(0, 300),
        };
      }
    }

    if (wantsCrowd) {
      const { data: targets } = await supabaseAdmin
        .from('scenario_casualties')
        .select('id, status, casualty_type, conditions')
        .eq('session_id', session.sessionId)
        .in('status', [
          'undiscovered',
          'identified',
          'being_moved',
          'being_evacuated',
          'at_assembly',
        ])
        .limit(5);

      const filtered = (targets ?? []).filter((t) => {
        const ct = (t as Record<string, unknown>).casualty_type as string;
        return CROWD_TYPES.has(ct);
      });

      if (filtered.length > 0) {
        const target = filtered[0] as unknown as Record<string, unknown>;
        const conds = (target.conditions as Record<string, unknown>) ?? {};
        const vis = (conds.visible_description as string) || '';
        return {
          target_id: target.id as string,
          target_type: 'casualty',
          target_label: vis || `${target.casualty_type} (${target.status})`,
          actions: this.inferActionsFromText(fullText, 'casualty'),
          resources: [{ type: 'responder', label: `${agent.persona.teamName} Team`, quantity: 1 }],
          description: description.slice(0, 300),
        };
      }
    }

    if (wantsHazard) {
      const { data: targets } = await supabaseAdmin
        .from('scenario_hazards')
        .select('id, status, hazard_type')
        .eq('session_id', session.sessionId)
        .in('status', ['active', 'escalating'])
        .limit(1);

      if (targets?.length) {
        const target = targets[0] as unknown as Record<string, unknown>;
        return {
          target_id: target.id as string,
          target_type: 'hazard',
          target_label: `${target.hazard_type} (${target.status})`,
          actions: this.inferActionsFromText(fullText, 'hazard'),
          resources: [{ type: 'responder', label: `${agent.persona.teamName} Team`, quantity: 1 }],
          description: description.slice(0, 300),
        };
      }
    }

    return null;
  }

  private inferTriageColor(
    text: string,
    conditions: Record<string, unknown>,
  ): 'green' | 'yellow' | 'red' | 'black' {
    const existing = conditions.triage_color as string | undefined;
    if (existing && ['green', 'yellow', 'red', 'black'].includes(existing))
      return existing as 'green' | 'yellow' | 'red' | 'black';
    if (/critical|immediate|severe|life.?threaten/i.test(text)) return 'red';
    if (/delayed|moderate|stable but/i.test(text)) return 'yellow';
    if (/deceased|dead|no pulse|black tag/i.test(text)) return 'black';
    return 'green';
  }

  private inferActionsFromText(text: string, targetType: 'casualty' | 'hazard'): string[] {
    const actions: string[] = [];
    if (targetType === 'casualty') {
      if (/triage/i.test(text)) actions.push('Initiate Triage');
      if (/first aid|treat/i.test(text)) actions.push('Administer First Aid');
      if (/tourniquet|bleed/i.test(text)) actions.push('Apply Tourniquet');
      if (/iv|fluid/i.test(text)) actions.push('Establish IV Access');
      if (/assess/i.test(text)) actions.push('Assess Injuries');
      if (/stabiliz/i.test(text)) actions.push('Stabilize Patient');
      if (actions.length === 0) actions.push('Assess and Triage');
    } else {
      if (/contain/i.test(text)) actions.push('Deploy Containment');
      if (/suppress|extinguish/i.test(text)) actions.push('Fire Suppression');
      if (/foam|chemical/i.test(text)) actions.push('Deploy Foam/Agent');
      if (/decon/i.test(text)) actions.push('Establish Decon Corridor');
      if (/ventilat/i.test(text)) actions.push('Ventilation');
      if (actions.length === 0) actions.push('Assess and Contain');
    }
    return actions;
  }

  /**
   * When a bot writes a decision mentioning infrastructure (cordon, triage tent,
   * command post, etc.) but didn't include a placement action, parse the text
   * and auto-create the placement on the map.
   */
  private async tryExtractPlacementsFromDecision(
    session: SessionAgents,
    agent: AgentState,
    title: string,
    description: string,
  ): Promise<void> {
    await extractAndPlaceInfrastructureFromText(
      session.sessionId,
      session.scenarioId,
      agent.persona.teamName,
      title,
      description,
      session.incidentCenter,
      agent.persona.botUserId,
    );
  }

  /**
   * Programmatic round-robin exit claiming: load all exits, assign one per team,
   * then loop again until all exits are claimed or all teams have 2.
   */
  private async claimExitsRoundRobin(
    session: SessionAgents,
    agentEntries: Array<[string, AgentState]>,
  ): Promise<void> {
    const { data: allExits } = await supabaseAdmin
      .from('scenario_locations')
      .select('id, label, location_type, pin_category')
      .eq('scenario_id', session.scenarioId)
      .in('pin_category', ['entry_exit']);

    const exitPins = (allExits ?? []) as Array<Record<string, unknown>>;
    if (exitPins.length === 0) {
      logger.info({ sessionId: session.sessionId }, 'No exits to claim in kickstart');
      return;
    }

    const teamClaimPurpose = (teamName: string): string => {
      const tk = getTeamScopeKey(teamName);
      if (tk === 'evacuation') return 'evacuation_checkpoint';
      if (tk === 'triage') return 'casualty_entry';
      if (tk === 'fire') return 'emergency_access';
      if (tk === 'pursuit') return 'security_checkpoint';
      if (tk === 'media') return 'media_access';
      return 'operational_use';
    };

    const remainingExits = [...exitPins];
    const assignments: Array<{
      agent: AgentState;
      exitId: string;
      exitLabel: string;
      purpose: string;
    }> = [];
    const maxPerTeam = Math.max(1, Math.ceil(exitPins.length / agentEntries.length));

    const teamClaimCounts = new Map<string, number>();

    let round = 0;
    while (remainingExits.length > 0 && round < maxPerTeam) {
      for (const [, agentState] of agentEntries) {
        if (remainingExits.length === 0) break;
        const currentCount = teamClaimCounts.get(agentState.persona.teamName) || 0;
        if (currentCount > round) continue;

        const exit = remainingExits.shift()!;
        const purpose = teamClaimPurpose(agentState.persona.teamName);
        assignments.push({
          agent: agentState,
          exitId: exit.id as string,
          exitLabel: exit.label as string,
          purpose,
        });
        teamClaimCounts.set(agentState.persona.teamName, currentCount + 1);
      }
      round++;
    }

    let delay = KICKSTART_INITIAL_DELAY_MS;
    for (const { agent, exitId, exitLabel, purpose } of assignments) {
      const capturedDelay = delay;
      setTimeout(async () => {
        if (session.stopped) return;
        try {
          const claimed = await this.dispatcher.claimLocation(
            session.sessionId,
            exitId,
            agent.persona.teamName,
            purpose,
            'exclusive',
          );
          if (claimed) {
            const channelId = session.channelId;
            if (channelId) {
              await this.dispatcher.sendChatMessage(
                channelId,
                session.sessionId,
                agent.persona.botUserId,
                `${agent.persona.fullName} claiming ${exitLabel} as ${purpose.replace(/_/g, ' ')} for ${agent.persona.teamName}.`,
              );
            }
          }
        } catch (err) {
          logger.error(
            { error: err, exitId, team: agent.persona.teamName },
            'Kickstart exit claim failed',
          );
        }
      }, capturedDelay);
      delay += 3_000 + Math.random() * 2_000;
    }

    logger.info(
      {
        sessionId: session.sessionId,
        totalExits: exitPins.length,
        assignments: assignments.length,
      },
      'Kickstart: programmatic round-robin exit claiming scheduled',
    );
  }

  /**
   * Fallback: if a decision mentions claiming/securing exits but no claim action was included,
   * find matching exit locations and auto-claim them.
   */
  private async tryExtractClaimsFromDecision(
    session: SessionAgents,
    agent: AgentState,
    title: string,
    description: string,
  ): Promise<void> {
    const fullText = `${title} ${description}`.toLowerCase();

    // Only proceed if the text mentions claiming/securing/checkpoint
    if (!/(claim|secur|checkpoint|control|man(ning)?|assign|designat)\b/i.test(fullText)) {
      return;
    }

    // Fetch all claimable exits that haven't been claimed yet
    const { data: allExits } = await supabaseAdmin
      .from('scenario_locations')
      .select('id, label, pin_category')
      .eq('scenario_id', session.scenarioId);

    if (!allExits?.length) return;

    const exitPins = (allExits as Array<Record<string, unknown>>).filter(
      (l) => (l.pin_category as string) === 'entry_exit',
    );
    if (exitPins.length === 0) return;

    // Check existing claims
    const { data: existingClaims } = await supabaseAdmin
      .from('session_location_claims')
      .select('location_id')
      .eq('session_id', session.sessionId);
    const claimedIds = new Set(
      (existingClaims ?? []).map((c) => (c as Record<string, unknown>).location_id as string),
    );

    let claimedCount = 0;
    for (const exit of exitPins) {
      if (claimedCount >= 2) break;
      const exitId = exit.id as string;
      if (claimedIds.has(exitId)) continue;

      const exitLabel = ((exit.label as string) || '').toLowerCase();
      const exitWords = exitLabel.split(/[\s,/-]+/).filter((w) => w.length > 3);
      const matchScore = exitWords.filter((w) => fullText.includes(w)).length;

      if (matchScore >= 1) {
        logger.info(
          {
            botUserId: agent.persona.botUserId,
            exitLabel: exit.label,
            team: agent.persona.teamName,
          },
          'AI agent: auto-claiming exit from decision text (fallback)',
        );
        await this.dispatcher.claimLocation(
          session.sessionId,
          exitId,
          agent.persona.teamName,
          'security_checkpoint',
          'exclusive',
        );
        claimedCount++;
      }
    }
  }

  /**
   * Returns true if the given team should NOT be allowed to use pin_response.
   * Checks: team type, target type, casualty subtype, and zone access.
   */
  private isTeamBlockedFromPinResponse(
    teamName: string,
    targetType?: string,
    casualtyType?: string,
    pinZone?: string,
  ): boolean {
    if (!targetType) return false;
    const tk = getTeamScopeKey(teamName);

    // These teams never interact with any pins directly
    if (tk === 'media' || tk === 'pursuit') {
      return true;
    }

    // Bomb squad only interacts with hazard pins (suspicious packages / explosives)
    if (tk === 'bomb_squad') {
      return targetType !== 'hazard';
    }

    // Crowd pins: ONLY evacuation may interact
    if (
      casualtyType === 'crowd' ||
      casualtyType === 'evacuee_group' ||
      casualtyType === 'convergent_crowd'
    ) {
      if (tk === 'evacuation') return false;
      return true;
    }

    // Zone-based access control for patients
    if (targetType === 'casualty' && pinZone === 'hot') {
      // Hot zone: ONLY Hazards / Fire / Rescue may extract — Medical Triage/evacuation CANNOT enter
      if (tk === 'fire') return false;
      return true;
    }

    // Hazards / Fire / Rescue can only interact with patients for extraction (not in warm/cold zone)
    if (targetType === 'casualty' && tk === 'fire') {
      if (pinZone && pinZone !== 'hot' && pinZone !== 'unknown' && pinZone !== 'outside') {
        return true;
      }
    }

    // Check against the hardcoded allowed pin types
    if (tk && TEAM_ALLOWED_PIN_TYPES[tk]) {
      return !TEAM_ALLOWED_PIN_TYPES[tk].has(targetType);
    }

    return false;
  }

  private async resolveLocationId(scenarioId: string, label: string): Promise<string | null> {
    try {
      // Strategy 1: exact ilike match
      const { data: exact } = await supabaseAdmin
        .from('scenario_locations')
        .select('id, label')
        .eq('scenario_id', scenarioId)
        .ilike('label', `%${label}%`)
        .limit(1);

      if (exact?.length) return (exact[0] as Record<string, unknown>).id as string;

      // Strategy 2: try each significant word in the label
      const words = label
        .split(/[\s,/-]+/)
        .filter((w) => w.length > 3)
        .map((w) => w.toLowerCase());

      if (words.length > 0) {
        const { data: allLocs } = await supabaseAdmin
          .from('scenario_locations')
          .select('id, label')
          .eq('scenario_id', scenarioId);

        if (allLocs?.length) {
          let bestMatch: string | null = null;
          let bestScore = 0;
          for (const loc of allLocs) {
            const locLabel = (
              ((loc as Record<string, unknown>).label as string) || ''
            ).toLowerCase();
            let score = 0;
            for (const w of words) {
              if (locLabel.includes(w)) score++;
            }
            if (score > bestScore) {
              bestScore = score;
              bestMatch = (loc as Record<string, unknown>).id as string;
            }
          }
          if (bestScore >= 1) return bestMatch;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Structured detail loaders for classified prompts
  // ---------------------------------------------------------------------------

  private async loadPatientDetail(
    sessionId: string,
    patientId: string,
  ): Promise<{
    name: string;
    age: number | null;
    sex: string;
    role: string;
    status: string;
    mobility: string;
    consciousness: string;
    breathing: string;
    accessibility: string;
    visibleDescription: string;
    injuries: Array<{ type: string; severity: string; body_part: string }>;
    treatmentReqs: Array<{ intervention: string; priority: string; reason: string }>;
    transportPrereqs: string[];
    contraindications: string[];
    idealSequence: Array<{ step: number; action: string; detail: string }>;
    requiredPpe: string[];
    requiredEquipment: Array<{ item: string; quantity: number; purpose: string }>;
    expectedMinutes: number | null;
    recommendedTransport: string;
    deteriorationTimeline: Array<{ at_minutes: number; description: string }>;
  } | null> {
    try {
      const { data } = await supabaseAdmin
        .from('scenario_casualties')
        .select('status, conditions')
        .eq('id', patientId)
        .eq('session_id', sessionId)
        .single();
      if (!data) return null;
      const c = (data.conditions ?? {}) as Record<string, unknown>;
      return {
        name: (c.name as string) || '',
        age: (c.age as number) || null,
        sex: (c.sex as string) || '',
        role: (c.role as string) || '',
        status: data.status as string,
        mobility: (c.mobility as string) || 'unknown',
        consciousness: (c.consciousness as string) || 'unknown',
        breathing: (c.breathing as string) || 'unknown',
        accessibility: (c.accessibility as string) || 'open',
        visibleDescription: (c.visible_description as string) || '',
        injuries:
          (c.injuries as Array<{ type: string; severity: string; body_part: string }>) || [],
        treatmentReqs:
          (c.treatment_requirements as Array<{
            intervention: string;
            priority: string;
            reason: string;
          }>) || [],
        transportPrereqs: (c.transport_prerequisites as string[]) || [],
        contraindications: (c.contraindications as string[]) || [],
        idealSequence:
          (c.ideal_response_sequence as Array<{
            step: number;
            action: string;
            detail: string;
          }>) || [],
        requiredPpe: (c.required_ppe as string[]) || [],
        requiredEquipment:
          (c.required_equipment as Array<{ item: string; quantity: number; purpose: string }>) ||
          [],
        expectedMinutes: (c.expected_time_to_treat_minutes as number) || null,
        recommendedTransport: (c.recommended_transport as string) || '',
        deteriorationTimeline:
          (c.deterioration_timeline as Array<{ at_minutes: number; description: string }>) || [],
      };
    } catch {
      return null;
    }
  }

  private async loadHazardDetail(
    sessionId: string,
    hazardId: string,
  ): Promise<{
    hazardType: string;
    status: string;
    description: string;
    idealSequence: Array<{
      step: number;
      action: string;
      detail: string;
      responsible_team?: string;
    }>;
    equipmentReqs: Array<{
      equipment_type: string;
      label?: string;
      quantity: number;
      critical: boolean;
    }>;
    requiredPpe: Array<{ item: string; mandatory: boolean }>;
  } | null> {
    try {
      const { data } = await supabaseAdmin
        .from('scenario_hazards')
        .select('hazard_type, status, properties')
        .eq('id', hazardId)
        .eq('session_id', sessionId)
        .single();
      if (!data) return null;
      const p = (data.properties ?? {}) as Record<string, unknown>;
      const resReqs = (p.resolution_requirements ?? {}) as Record<string, unknown>;
      return {
        hazardType: (data.hazard_type as string) || 'unknown',
        status: (data.status as string) || 'unknown',
        description: (p.enriched_description as string) || (p.description as string) || '',
        idealSequence:
          (resReqs.ideal_response_sequence as Array<{
            step: number;
            action: string;
            detail: string;
            responsible_team?: string;
          }>) || [],
        equipmentReqs:
          (p.equipment_requirements as Array<{
            equipment_type: string;
            label?: string;
            quantity: number;
            critical: boolean;
          }>) || [],
        requiredPpe: (resReqs.required_ppe as Array<{ item: string; mandatory: boolean }>) || [],
      };
    } catch {
      return null;
    }
  }

  // Ground situation loader — separated by type with zone tagging
  // ---------------------------------------------------------------------------

  private async loadGroundSituation(
    sessionId: string,
    scenarioId: string,
    teamScopeKey?: string,
  ): Promise<{
    patients: string[];
    crowds: string[];
    hazards: string[];
    claimableExits: Array<{
      label: string;
      location_type: string;
      claimStatus: string;
    }>;
    pinZoneMap: Map<string, string>;
    availableFacilities: string[];
    sweepableAssets: string[];
  }> {
    const result = {
      patients: [] as string[],
      crowds: [] as string[],
      hazards: [] as string[],
      claimableExits: [] as Array<{ label: string; location_type: string; claimStatus: string }>,
      pinZoneMap: new Map<string, string>(),
      availableFacilities: [] as string[],
      sweepableAssets: [] as string[],
    };

    const CROWD_TYPES = new Set(['crowd', 'evacuee_group', 'convergent_crowd']);

    try {
      // Load zone ground truth polygons for zone classification
      const { data: hazardsWithZones } = await supabaseAdmin
        .from('scenario_hazards')
        .select('location_lat, location_lng, zones')
        .eq('session_id', sessionId)
        .in('status', ['active', 'escalating'])
        .limit(5);

      interface ZoneGT {
        zone_type: string;
        radius_m: number;
        polygon?: [number, number][];
        allowed_teams: string[];
      }

      let zoneData: ZoneGT[] = [];
      let hazardCenter: { lat: number; lng: number } | null = null;
      for (const h of (hazardsWithZones ?? []) as Array<Record<string, unknown>>) {
        const zones = h.zones as ZoneGT[] | null;
        if (zones && zones.length > 0) {
          zoneData = zones;
          hazardCenter = {
            lat: Number(h.location_lat),
            lng: Number(h.location_lng),
          };
          break;
        }
      }

      const classifyPinZone = (lat: number, lng: number): string => {
        if (zoneData.length === 0 || !hazardCenter) return 'unknown';
        const dist = haversineM(lat, lng, hazardCenter.lat, hazardCenter.lng);
        const sorted = [...zoneData].sort((a, b) => a.radius_m - b.radius_m);
        for (const z of sorted) {
          if (z.polygon && z.polygon.length > 0) {
            if (pointInPolygon(lat, lng, z.polygon)) return z.zone_type;
          } else if (dist <= z.radius_m) {
            return z.zone_type;
          }
        }
        return 'outside';
      };

      // Casualties — split into patients vs crowds
      const { data: casualties } = await supabaseAdmin
        .from('scenario_casualties')
        .select(
          'id, casualty_type, headcount, status, location_lat, location_lng, conditions, player_triage_color, assigned_team',
        )
        .eq('session_id', sessionId)
        .in('status', [
          'undiscovered',
          'identified',
          'being_moved',
          'being_evacuated',
          'awaiting_triage',
          'at_assembly',
          'endorsed_to_triage',
          'in_treatment',
        ])
        .limit(15);

      for (const c of (casualties ?? []) as Array<Record<string, unknown>>) {
        const cType = c.casualty_type as string;
        const lat = Number(c.location_lat);
        const lng = Number(c.location_lng);
        const zone = classifyPinZone(lat, lng);
        const conds = c.conditions as Record<string, unknown> | null;
        const condSummary = conds?.description || conds?.injury_type || '';
        const triageTag = c.player_triage_color ? `, triage: ${c.player_triage_color}` : '';
        const assigned = c.assigned_team ? `, assigned: ${c.assigned_team}` : '';
        const zoneLabel =
          zone !== 'unknown' && zone !== 'outside' ? `, ZONE: ${zone.toUpperCase()}` : '';
        const pinId = c.id as string;
        const isCrowd = CROWD_TYPES.has(cType);
        const status = c.status as string;

        result.pinZoneMap.set(pinId, zone);

        const patientName = !isCrowd && conds?.name ? ` "${conds.name}"` : '';
        const line = `[id:${pinId}]${patientName} ${cType} (${c.headcount} people) at [${lat}, ${lng}] — status: ${status}${zoneLabel}${triageTag}${assigned}${condSummary ? `, ${condSummary}` : ''}`;

        if (isCrowd) {
          // Crowds: only visible to evacuation team
          if (!teamScopeKey || teamScopeKey === 'evacuation') {
            result.crowds.push(line);
          }
        } else {
          // Individual patients: filter by team role and zone
          if (!teamScopeKey) {
            result.patients.push(line);
          } else if (teamScopeKey === 'triage') {
            // Triage only sees patients that are endorsed to them or in warm/cold zones (not hot)
            if (zone !== 'hot') {
              result.patients.push(line);
            }
          } else if (teamScopeKey === 'fire') {
            // Fire only sees hot zone patients (for extraction)
            if (zone === 'hot' || zone === 'unknown') {
              result.patients.push(line);
            }
          }
          // Other teams (media, pursuit, bomb_squad) don't see patient pins
        }
      }

      // Hazards (include ID, tagged with zone)
      const { data: hazards } = await supabaseAdmin
        .from('scenario_hazards')
        .select('id, hazard_type, status, location_lat, location_lng, properties')
        .eq('session_id', sessionId)
        .in('status', ['active', 'escalating'])
        .limit(8);

      for (const h of (hazards ?? []) as Array<Record<string, unknown>>) {
        const props = h.properties as Record<string, unknown> | null;
        const propSummary = props?.description || props?.size || '';
        const lat = Number(h.location_lat);
        const lng = Number(h.location_lng);
        const zone = classifyPinZone(lat, lng);
        const zoneLabel =
          zone !== 'unknown' && zone !== 'outside' ? `, ZONE: ${zone.toUpperCase()}` : '';
        const pinId = h.id as string;
        const hazardType = (h.hazard_type as string) || '';
        result.pinZoneMap.set(pinId, zone);

        // Filter hazards by team scope
        const isExplosiveHazard = /bomb|explosive|ied|detonat|suspicious.*package/i.test(
          hazardType,
        );
        if (teamScopeKey === 'bomb_squad') {
          if (isExplosiveHazard) {
            result.hazards.push(
              `[id:${pinId}] ${hazardType} at [${lat}, ${lng}] — ${h.status}${zoneLabel}${propSummary ? `, ${propSummary}` : ''}`,
            );
          }
        } else if (teamScopeKey === 'fire') {
          if (!isExplosiveHazard) {
            result.hazards.push(
              `[id:${pinId}] ${hazardType} at [${lat}, ${lng}] — ${h.status}${zoneLabel}${propSummary ? `, ${propSummary}` : ''}`,
            );
          }
        } else if (!teamScopeKey) {
          result.hazards.push(
            `[id:${pinId}] ${hazardType} at [${lat}, ${lng}] — ${h.status}${zoneLabel}${propSummary ? `, ${propSummary}` : ''}`,
          );
        }
        // Other teams (triage, evacuation, media, pursuit) don't interact with hazard pins
      }

      // Claimable exits
      const { data: exits } = await supabaseAdmin
        .from('scenario_locations')
        .select('id, label, location_type')
        .eq('scenario_id', scenarioId)
        .in('location_type', ['exit', 'entry', 'exit_entry', 'entry_exit'])
        .limit(15);

      if (exits && exits.length > 0) {
        const exitIds = (exits as Array<Record<string, unknown>>).map((e) => e.id as string);
        const { data: claims } = await supabaseAdmin
          .from('session_location_claims')
          .select('location_id, claimed_by_team, claimed_as')
          .eq('session_id', sessionId)
          .in('location_id', exitIds);

        const claimMap = new Map<string, { team: string; as: string }>();
        for (const cl of (claims ?? []) as Array<Record<string, unknown>>) {
          claimMap.set(cl.location_id as string, {
            team: cl.claimed_by_team as string,
            as: cl.claimed_as as string,
          });
        }

        for (const exit of exits as Array<Record<string, unknown>>) {
          const claim = claimMap.get(exit.id as string);
          result.claimableExits.push({
            label: exit.label as string,
            location_type: exit.location_type as string,
            claimStatus: claim
              ? `CLAIMED by ${claim.team} as ${claim.as}`
              : 'UNCLAIMED — available',
          });
        }
      }

      // Available facilities — hospitals (from scenario_locations) + placed operational assets
      const { data: facilityPins } = await supabaseAdmin
        .from('scenario_locations')
        .select('label, location_type, coordinates, conditions')
        .eq('scenario_id', scenarioId)
        .in('location_type', ['hospital', 'police_station', 'fire_station']);

      for (const f of (facilityPins ?? []) as Array<Record<string, unknown>>) {
        const coords = f.coordinates as { lat: number; lng: number } | null;
        const conds = f.conditions as Record<string, unknown> | null;
        const beds = conds?.emergency_beds_available ?? conds?.capacity ?? '';
        const dist = conds?.distance_from_incident_m ?? '';
        let detail = `${(f.location_type as string).replace(/_/g, ' ')}: "${f.label}"`;
        if (coords) detail += ` at [${coords.lat}, ${coords.lng}]`;
        if (dist) detail += ` (${dist}m from incident)`;
        if (beds) detail += ` — capacity: ${beds} beds`;
        result.availableFacilities.push(detail);
      }

      const { data: placedOps } = await supabaseAdmin
        .from('placed_assets')
        .select('asset_type, label, geometry, team_name')
        .eq('session_id', sessionId)
        .in('asset_type', [
          'triage_point',
          'field_hospital',
          'casualty_collection',
          'assembly_point',
          'decontamination_zone',
          'ambulance_staging',
          'staging_area',
          'command_post',
        ]);

      for (const p of (placedOps ?? []) as Array<Record<string, unknown>>) {
        const geom = p.geometry as { coordinates?: [number, number] } | null;
        const coordStr = geom?.coordinates
          ? ` at [${geom.coordinates[1]}, ${geom.coordinates[0]}]`
          : '';
        const team = p.team_name ? ` (${p.team_name})` : '';
        result.availableFacilities.push(
          `${(p.asset_type as string).replace(/_/g, ' ')}: "${p.label}"${coordStr}${team}`,
        );
      }
    } catch (err) {
      logger.debug({ error: err, sessionId }, 'AI agent: failed to load ground situation');
    }

    // Sweepable assets for bomb squad — all other teams' placed assets that haven't been swept yet
    if (teamScopeKey === 'bomb_squad') {
      try {
        const { data: allAssets } = await supabaseAdmin
          .from('placed_assets')
          .select('id, asset_type, label, team_name, geometry')
          .eq('session_id', sessionId)
          .eq('status', 'active');

        const { data: sessionRow } = await supabaseAdmin
          .from('sessions')
          .select('hidden_devices')
          .eq('id', sessionId)
          .single();

        const hiddenDevices = (sessionRow?.hidden_devices as Array<Record<string, unknown>>) ?? [];
        const sweptAssetIds = new Set(
          hiddenDevices.filter((d) => d.discovered === true).map((d) => d.asset_id as string),
        );

        const { count: sweepCount } = await supabaseAdmin
          .from('session_events')
          .select('id', { count: 'exact', head: true })
          .eq('session_id', sessionId)
          .eq('event_type', 'bomb_squad_sweep');
        const totalSwept = sweepCount ?? 0;

        for (const a of (allAssets ?? []) as Array<Record<string, unknown>>) {
          const aTeam = a.team_name as string;
          if (/bomb|eod/i.test(aTeam)) continue;
          const aid = a.id as string;
          const alreadySwept = sweptAssetIds.has(aid);
          const geom = a.geometry as { coordinates?: [number, number] } | null;
          const coordStr = geom?.coordinates
            ? ` at [${geom.coordinates[1]}, ${geom.coordinates[0]}]`
            : '';
          const status = alreadySwept ? ' [SWEPT ✓]' : ' [NOT SWEPT]';
          result.sweepableAssets.push(
            `[id:${aid}] ${(a.asset_type as string).replace(/_/g, ' ')}: "${a.label}"${coordStr} (${aTeam})${status}`,
          );
        }

        if (totalSwept === 0 && result.sweepableAssets.length > 0) {
          result.sweepableAssets.unshift(
            '⚠️ NO SWEEPS PERFORMED YET — prioritize sweeping high-value assets immediately',
          );
        }
      } catch (sweepErr) {
        logger.debug({ error: sweepErr, sessionId }, 'Failed to load sweepable assets');
      }
    }

    return result;
  }

  private async loadRecentSessionActivity(sessionId: string): Promise<string[]> {
    const lines: string[] = [];
    try {
      const { data: decisions } = await supabaseAdmin
        .from('decisions')
        .select(
          'title, type, status, created_at, ai_evaluation, creator:user_profiles!decisions_proposed_by_fkey(full_name)',
        )
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(8);

      for (const d of (decisions ?? []) as Array<Record<string, unknown>>) {
        const creator = d.creator as Record<string, unknown> | null;
        const name = (creator?.full_name as string) || 'Unknown';
        let line = `${name} — ${d.status}: "${d.title}"`;
        const evalData = d.ai_evaluation as Record<string, unknown> | null;
        if (evalData) {
          const consistent = evalData.consistent as boolean | undefined;
          const kind = (evalData.mismatch_kind as string) || '';
          const feedback = (evalData.feedback_summary as string) || '';
          if (consistent === false && feedback) {
            line += ` [EVALUATOR: ${kind ? kind.toUpperCase() + ' — ' : ''}${feedback.slice(0, 120)}]`;
          }
        }
        lines.push(line);
      }

      const { data: placements } = await supabaseAdmin
        .from('placed_assets')
        .select(
          'asset_type, label, created_at, placed_by_profile:user_profiles!placed_assets_placed_by_fkey(full_name)',
        )
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(5);

      for (const p of (placements ?? []) as Array<Record<string, unknown>>) {
        const profile = p.placed_by_profile as Record<string, unknown> | null;
        const name = (profile?.full_name as string) || 'Unknown';
        lines.push(`${name} placed ${p.asset_type}: "${p.label}"`);
      }

      const { data: messages } = await supabaseAdmin
        .from('chat_messages')
        .select('content, created_at, sender:user_profiles!chat_messages_sender_id_fkey(full_name)')
        .eq('session_id', sessionId)
        .neq('type', 'system')
        .order('created_at', { ascending: false })
        .limit(5);

      for (const m of (messages ?? []) as Array<Record<string, unknown>>) {
        const sender = m.sender as Record<string, unknown> | null;
        const name = (sender?.full_name as string) || 'Unknown';
        lines.push(`${name} said: "${(m.content as string)?.slice(0, 100)}"`);
      }
    } catch (err) {
      logger.debug({ error: err, sessionId }, 'AI agent: failed to load recent activity');
    }
    return lines;
  }

  private async loadOwnEvaluatorFeedback(sessionId: string, botUserId: string): Promise<string[]> {
    const lines: string[] = [];
    try {
      const { data: decisions } = await supabaseAdmin
        .from('decisions')
        .select('title, ai_evaluation')
        .eq('session_id', sessionId)
        .eq('proposed_by', botUserId)
        .order('created_at', { ascending: false })
        .limit(4);

      for (const d of (decisions ?? []) as Array<Record<string, unknown>>) {
        const evalData = d.ai_evaluation as Record<string, unknown> | null;
        if (!evalData) continue;
        const consistent = evalData.consistent as boolean | undefined;
        if (consistent !== false) continue;
        const kind = (evalData.mismatch_kind as string) || '';
        const feedback = (evalData.feedback_summary as string) || '';
        if (feedback) {
          lines.push(
            `"${(d.title as string)?.slice(0, 60)}" → ${kind ? kind.toUpperCase() + ': ' : ''}${feedback.slice(0, 200)}`,
          );
        }
      }
    } catch (err) {
      logger.debug({ error: err }, 'AI agent: failed to load own evaluator feedback');
    }
    return lines;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let agentServiceInstance: DemoAIAgentService | null = null;

export function getDemoAIAgentService(): DemoAIAgentService {
  if (!agentServiceInstance) {
    agentServiceInstance = new DemoAIAgentService();
  }
  return agentServiceInstance;
}
