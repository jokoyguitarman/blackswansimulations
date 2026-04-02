import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { ChatInterface } from '../components/Chat/ChatInterface';
import { DecisionWorkflow } from '../components/Decisions/DecisionWorkflow';
import { AIInjectSystem } from '../components/Injects/AIInjectSystem';
import { MediaFeed } from '../components/Media/MediaFeed';
import { AARDashboard } from '../components/AAR/AARDashboard';
import { DecisionsAIRatingsPanel } from '../components/AAR/DecisionsAIRatingsPanel';
import { ParticipantManagement } from '../components/Session/ParticipantManagement';
import { TrainerEnvironmentalTruths } from '../components/Session/TrainerEnvironmentalTruths';
import { TeamAssignmentModal } from '../components/Teams/TeamAssignmentModal';
import { SessionLobby } from '../components/Session/SessionLobby';
import { NotificationBell } from '../components/Notifications/NotificationBell';
import { IncidentsPanel } from '../components/Incidents/IncidentsPanel';
import { MapView } from '../components/COP/MapView';
import type { DraggableAssetDef } from '../components/COP/AssetPalette';
import { CreateDecisionForm } from '../components/Forms/CreateDecisionForm';

const TEAM_ASSET_CATALOG: Record<string, DraggableAssetDef[]> = {
  evacuation: [
    { asset_type: 'assembly_point', icon: 'flag', geometry_type: 'point', label: 'Assembly Point' },
    { asset_type: 'marshal_post', icon: 'marshal', geometry_type: 'point', label: 'Marshal Post' },
    {
      asset_type: 'ambulance_staging',
      icon: 'ambulance',
      geometry_type: 'point',
      label: 'Ambulance Staging',
    },
  ],
  triage: [
    { asset_type: 'triage_tent', icon: 'tent', geometry_type: 'point', label: 'Triage Tent' },
    {
      asset_type: 'triage_officer',
      icon: 'triage_officer',
      geometry_type: 'point',
      label: 'Triage Officer',
    },
    {
      asset_type: 'field_hospital',
      icon: 'medical',
      geometry_type: 'point',
      label: 'Field Hospital',
    },
    {
      asset_type: 'ambulance_staging',
      icon: 'ambulance',
      geometry_type: 'point',
      label: 'Ambulance Staging',
    },
    { asset_type: 'decon_zone', icon: 'hazmat', geometry_type: 'point', label: 'Decon Zone' },
  ],
  media: [
    { asset_type: 'press_cordon', icon: 'barrier', geometry_type: 'line', label: 'Press Cordon' },
    {
      asset_type: 'media_liaison',
      icon: 'media_officer',
      geometry_type: 'point',
      label: 'Media Liaison',
    },
    {
      asset_type: 'briefing_point',
      icon: 'podium',
      geometry_type: 'point',
      label: 'Media Briefing Point',
    },
    {
      asset_type: 'camera_position',
      icon: 'camera',
      geometry_type: 'point',
      label: 'Camera Position',
    },
  ],
  fire_hazmat: [
    { asset_type: 'decon_zone', icon: 'hazmat', geometry_type: 'point', label: 'Decon Zone' },
    {
      asset_type: 'firefighter_post',
      icon: 'firefighter',
      geometry_type: 'point',
      label: 'Firefighter Post',
    },
    {
      asset_type: 'fire_truck_staging',
      icon: 'fire_truck',
      geometry_type: 'point',
      label: 'Fire Truck Staging',
    },
    { asset_type: 'water_point', icon: 'water', geometry_type: 'point', label: 'Water Point' },
  ],
  police: [
    {
      asset_type: 'tactical_unit',
      icon: 'tactical_unit',
      geometry_type: 'point',
      label: 'Tactical Unit',
    },
    {
      asset_type: 'sniper_position',
      icon: 'sniper',
      geometry_type: 'point',
      label: 'Sniper Position',
    },
    { asset_type: 'k9_unit', icon: 'k9', geometry_type: 'point', label: 'K9 Unit' },
    {
      asset_type: 'arrest_team',
      icon: 'arrest_team',
      geometry_type: 'point',
      label: 'Arrest Team',
    },
    {
      asset_type: 'police_cordon',
      icon: 'barrier',
      geometry_type: 'line',
      label: 'Police Cordon',
    },
    {
      asset_type: 'armed_response_vehicle',
      icon: 'armored_vehicle',
      geometry_type: 'point',
      label: 'Armed Response Vehicle',
    },
  ],
  negotiation: [
    {
      asset_type: 'negotiation_post',
      icon: 'negotiation_post',
      geometry_type: 'point',
      label: 'Negotiation Post',
    },
    {
      asset_type: 'listening_post',
      icon: 'listening_post',
      geometry_type: 'point',
      label: 'Listening Post',
    },
    {
      asset_type: 'communication_relay',
      icon: 'radio',
      geometry_type: 'point',
      label: 'Communication Relay',
    },
    {
      asset_type: 'safe_perimeter',
      icon: 'barrier',
      geometry_type: 'line',
      label: 'Safe Perimeter',
    },
  ],
  intelligence: [
    {
      asset_type: 'observation_post',
      icon: 'eye',
      geometry_type: 'point',
      label: 'Observation Post',
    },
    {
      asset_type: 'surveillance_drone',
      icon: 'drone',
      geometry_type: 'point',
      label: 'Surveillance Drone',
    },
    { asset_type: 'intel_hub', icon: 'intel_hub', geometry_type: 'point', label: 'Intel Hub' },
    {
      asset_type: 'covert_position',
      icon: 'covert',
      geometry_type: 'point',
      label: 'Covert Position',
    },
  ],
  close_protection: [
    {
      asset_type: 'protection_detail',
      icon: 'protection_detail',
      geometry_type: 'point',
      label: 'Protection Detail',
    },
    { asset_type: 'safe_room', icon: 'safe_room', geometry_type: 'point', label: 'Safe Room' },
    {
      asset_type: 'vip_extraction_point',
      icon: 'vip_extract',
      geometry_type: 'point',
      label: 'VIP Extraction Point',
    },
    {
      asset_type: 'armored_vehicle_staging',
      icon: 'armored_vehicle',
      geometry_type: 'point',
      label: 'Armored Vehicle Staging',
    },
  ],
  event_security: [
    {
      asset_type: 'security_checkpoint',
      icon: 'checkpoint',
      geometry_type: 'point',
      label: 'Security Checkpoint',
    },
    { asset_type: 'cctv_monitor', icon: 'cctv', geometry_type: 'point', label: 'CCTV Monitor' },
    {
      asset_type: 'crowd_barrier',
      icon: 'barrier',
      geometry_type: 'line',
      label: 'Crowd Barrier',
    },
    {
      asset_type: 'steward_post',
      icon: 'steward',
      geometry_type: 'point',
      label: 'Steward Post',
    },
    {
      asset_type: 'search_point',
      icon: 'search_point',
      geometry_type: 'point',
      label: 'Search Point',
    },
  ],
  crowd_management: [
    {
      asset_type: 'crush_barrier',
      icon: 'crush_barrier',
      geometry_type: 'line',
      label: 'Crush Barrier',
    },
    {
      asset_type: 'pa_announcement_point',
      icon: 'pa_system',
      geometry_type: 'point',
      label: 'PA Announcement Point',
    },
    {
      asset_type: 'crowd_flow_marshal',
      icon: 'marshal',
      geometry_type: 'point',
      label: 'Crowd Flow Marshal',
    },
    {
      asset_type: 'capacity_monitor_post',
      icon: 'capacity_monitor',
      geometry_type: 'point',
      label: 'Capacity Monitor Post',
    },
    {
      asset_type: 'crowd_barrier_line',
      icon: 'barrier',
      geometry_type: 'line',
      label: 'Crowd Barrier',
    },
  ],
  transit_security: [
    {
      asset_type: 'platform_barrier',
      icon: 'platform_barrier',
      geometry_type: 'line',
      label: 'Platform Barrier',
    },
    {
      asset_type: 'service_control_point',
      icon: 'service_control',
      geometry_type: 'point',
      label: 'Service Control Point',
    },
    {
      asset_type: 'station_lockdown_post',
      icon: 'checkpoint',
      geometry_type: 'point',
      label: 'Station Lockdown Post',
    },
    {
      asset_type: 'transit_cctv_monitor',
      icon: 'cctv',
      geometry_type: 'point',
      label: 'CCTV Monitor',
    },
  ],
  fire: [
    {
      asset_type: 'firefighter_post',
      icon: 'firefighter',
      geometry_type: 'point',
      label: 'Firefighter Post',
    },
    {
      asset_type: 'fire_truck_staging',
      icon: 'fire_truck',
      geometry_type: 'point',
      label: 'Fire Truck Staging',
    },
    { asset_type: 'water_point', icon: 'water', geometry_type: 'point', label: 'Water Point' },
    {
      asset_type: 'search_rescue_team',
      icon: 'person',
      geometry_type: 'point',
      label: 'Search & Rescue Team',
    },
    {
      asset_type: 'fire_cordon',
      icon: 'barrier',
      geometry_type: 'line',
      label: 'Fire Cordon',
    },
  ],
  bomb_squad: [
    {
      asset_type: 'eod_operator',
      icon: 'blast_shield',
      geometry_type: 'point',
      label: 'EOD Operator',
    },
    {
      asset_type: 'bomb_disposal_robot',
      icon: 'bomb_robot',
      geometry_type: 'point',
      label: 'Bomb Disposal Robot',
    },
    {
      asset_type: 'blast_cordon',
      icon: 'barrier',
      geometry_type: 'line',
      label: 'Blast Cordon',
    },
    {
      asset_type: 'xray_station',
      icon: 'xray_scanner',
      geometry_type: 'point',
      label: 'X-Ray Station',
    },
    {
      asset_type: 'controlled_detonation_zone',
      icon: 'bomb',
      geometry_type: 'polygon',
      label: 'Controlled Detonation Zone',
    },
  ],
  mall_security: [
    {
      asset_type: 'security_desk',
      icon: 'mall_badge',
      geometry_type: 'point',
      label: 'Security Desk',
    },
    {
      asset_type: 'mall_cctv_monitor',
      icon: 'cctv',
      geometry_type: 'point',
      label: 'CCTV Monitor',
    },
    {
      asset_type: 'metal_detector_gate',
      icon: 'metal_detector',
      geometry_type: 'point',
      label: 'Metal Detector Gate',
    },
    {
      asset_type: 'security_patrol',
      icon: 'steward',
      geometry_type: 'point',
      label: 'Security Patrol',
    },
    {
      asset_type: 'mall_lockdown_gate',
      icon: 'barrier',
      geometry_type: 'line',
      label: 'Lockdown Gate',
    },
    {
      asset_type: 'mall_pa_point',
      icon: 'pa_system',
      geometry_type: 'point',
      label: 'PA Announcement Point',
    },
  ],
  resort_security: [
    {
      asset_type: 'resort_patrol_post',
      icon: 'resort_patrol',
      geometry_type: 'point',
      label: 'Resort Patrol Post',
    },
    {
      asset_type: 'beach_patrol_post',
      icon: 'beach_patrol',
      geometry_type: 'point',
      label: 'Beach Patrol Post',
    },
    {
      asset_type: 'perimeter_fence_line',
      icon: 'perimeter_fence',
      geometry_type: 'line',
      label: 'Perimeter Fence',
    },
    {
      asset_type: 'resort_cctv',
      icon: 'cctv',
      geometry_type: 'point',
      label: 'CCTV Monitor',
    },
    {
      asset_type: 'guest_holding_area',
      icon: 'staging',
      geometry_type: 'point',
      label: 'Guest Holding Area',
    },
  ],
  public_health: [
    {
      asset_type: 'testing_station',
      icon: 'test_kit',
      geometry_type: 'point',
      label: 'Testing Station',
    },
    {
      asset_type: 'water_sampling_point',
      icon: 'water_sample',
      geometry_type: 'point',
      label: 'Water Sampling Point',
    },
    {
      asset_type: 'quarantine_zone',
      icon: 'hexagon',
      geometry_type: 'polygon',
      label: 'Quarantine Zone',
    },
    {
      asset_type: 'public_health_officer',
      icon: 'biohazard_suit',
      geometry_type: 'point',
      label: 'Public Health Officer',
    },
    {
      asset_type: 'distribution_point',
      icon: 'supply',
      geometry_type: 'point',
      label: 'Supply Distribution Point',
    },
  ],
  operations: [
    {
      asset_type: 'ops_center_post',
      icon: 'ops_center',
      geometry_type: 'point',
      label: 'Operations Centre',
    },
    {
      asset_type: 'utility_control',
      icon: 'utility',
      geometry_type: 'point',
      label: 'Utility Control Point',
    },
    {
      asset_type: 'generator_staging',
      icon: 'supply',
      geometry_type: 'point',
      label: 'Generator Staging',
    },
    {
      asset_type: 'ops_cordon',
      icon: 'barrier',
      geometry_type: 'line',
      label: 'Operations Cordon',
    },
  ],
};

const UNIVERSAL_ASSETS: DraggableAssetDef[] = [
  { asset_type: 'barrier', icon: 'barrier', geometry_type: 'line', label: 'Barrier / Cordon' },
  {
    asset_type: 'operational_area',
    icon: 'area',
    geometry_type: 'polygon',
    label: 'Operational Area',
  },
  {
    asset_type: 'hazard_zone',
    icon: 'zone',
    geometry_type: 'polygon',
    label: 'Hazard Zone',
  },
  { asset_type: 'command_post', icon: 'command', geometry_type: 'point', label: 'Command Post' },
  { asset_type: 'radio_relay', icon: 'radio', geometry_type: 'point', label: 'Radio Relay' },
];

const EQUIPMENT_ICON_MAP: Record<string, string> = {
  droplet: 'water',
  flame: 'extinguisher',
  wind: 'oxygen',
  bed: 'stretcher',
  clipboard: 'clipboard',
  wrench: 'wrench',
  heart: 'heart',
  syringe: 'syringe',
  'first-aid': 'bandage',
  bone: 'splint',
  shield: 'shield',
  camera: 'camera',
  package: 'medical',
  accessibility: 'stretcher',
};

function getAssetsForTeam(
  teamName: string,
  equipment: Array<{
    equipment_type: string;
    label: string;
    icon: string | null;
    properties: Record<string, unknown>;
    applicable_teams?: string[];
  }>,
): DraggableAssetDef[] {
  const key = teamName.toLowerCase().replace(/[\s-]/g, '_');
  let specific = TEAM_ASSET_CATALOG[key];
  if (!specific) {
    for (const [catalogKey, assets] of Object.entries(TEAM_ASSET_CATALOG)) {
      if (key.includes(catalogKey) || catalogKey.includes(key)) {
        specific = assets;
        break;
      }
    }
  }
  const base = specific
    ? [...specific]
    : [
        {
          asset_type: 'assembly_point',
          icon: 'flag',
          geometry_type: 'point' as const,
          label: 'Assembly Point',
        },
        {
          asset_type: 'triage_tent',
          icon: 'tent',
          geometry_type: 'point' as const,
          label: 'Triage Tent',
        },
      ];

  const existingTypes = new Set(base.map((a) => a.asset_type));

  for (const eq of equipment) {
    if (existingTypes.has(eq.equipment_type)) continue;

    if (eq.applicable_teams && eq.applicable_teams.length > 0) {
      const matches = eq.applicable_teams.some((t) => key.includes(t) || t.includes(key));
      if (!matches) continue;
    }

    existingTypes.add(eq.equipment_type);
    base.push({
      asset_type: eq.equipment_type,
      icon: EQUIPMENT_ICON_MAP[eq.icon ?? ''] ?? 'medical',
      geometry_type: 'point',
      label: eq.label,
    });
  }

  return [...base, ...UNIVERSAL_ASSETS];
}
import { useWebSocket } from '../hooks/useWebSocket';
import { type WebSocketEvent } from '../lib/websocketClient';
import { useRoleVisibility } from '../hooks/useRoleVisibility';
import { useAuth } from '../contexts/AuthContext';
import { BackgroundMusic } from '../components/Session/BackgroundMusic';
import { CinematicOverlay } from '../components/Demo/CinematicOverlay';
import { ActivityTicker } from '../components/Demo/ActivityTicker';
import { TeamSpotlightOverlay } from '../components/Demo/TeamSpotlightOverlay';

interface Session {
  id: string;
  status: string;
  scenario_id: string;
  start_time?: string | null;
  current_state?: {
    evacuation_zones?: Array<{
      id: string;
      center_lat: number;
      center_lng: number;
      radius_meters: number;
      title: string;
    }>;
    [key: string]: unknown;
  };
  inject_state_effects?: Record<string, unknown>;
  trainer_instructions?: string | null;
  scheduled_start_time?: string | null;
  join_token?: string | null;
  join_enabled?: boolean;
  join_expires_at?: string | null;
  scenarios?: {
    id?: string;
    title: string;
    description: string;
    center_lat?: number | null;
    center_lng?: number | null;
  };
  participants?: Array<{
    user_id: string;
    role: string;
    is_ready?: boolean;
    user?: {
      id: string;
      full_name: string;
      email?: string;
      role: string;
      agency_name?: string;
    };
  }>;
}

interface CounterDefinition {
  key: string;
  label: string;
  type: 'number' | 'boolean' | 'enum';
  initial_value: number | boolean | string;
  behavior: string;
  visible_to?: 'all' | 'trainer_only';
  config?: {
    cap_key?: string;
    [k: string]: unknown;
  };
}

interface ScenarioTeamWithCounters {
  team_name: string;
  team_description?: string;
  counter_definitions?: CounterDefinition[] | null;
}

/**
 * Flatten any nested objects inside *_state entries of current_state to primitives.
 * Prevents React error #31 when AI-generated state contains objects as counter values.
 */
function sanitizeCurrentState(state: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (
      key.endsWith('_state') &&
      value != null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      const teamState: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v != null && typeof v === 'object' && !Array.isArray(v)) {
          teamState[k] = JSON.stringify(v);
        } else {
          teamState[k] = v;
        }
      }
      result[key] = teamState;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Deep-merge inject_state_effects on top of current_state (two-level merge).
 * Inject effects live in a separate DB column to avoid race conditions with
 * the counter scheduler that writes current_state.
 */
function mergeInjectEffects(
  currentState: Record<string, unknown>,
  injectEffects?: Record<string, unknown>,
): Record<string, unknown> {
  if (!injectEffects || Object.keys(injectEffects).length === 0) return currentState;
  const merged: Record<string, unknown> = { ...currentState };
  for (const [key, val] of Object.entries(injectEffects)) {
    if (
      val != null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      merged[key] != null &&
      typeof merged[key] === 'object' &&
      !Array.isArray(merged[key])
    ) {
      merged[key] = {
        ...(merged[key] as Record<string, unknown>),
        ...(val as Record<string, unknown>),
      };
    } else {
      merged[key] = val;
    }
  }
  return merged;
}

export const SessionView = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isSpectator = searchParams.get('spectator') === 'true';
  const spectatorMode = searchParams.get('mode') || 'cinematic';
  const { isTrainer } = useRoleVisibility();
  const { user } = useAuth();
  // Notifications are now handled automatically by the backend notification system
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);
  // Card notification state: 'new' = green dot, 'viewed' = yellow dot, 'none' = no dot
  const [cardNotifications, setCardNotifications] = useState<
    Record<string, 'new' | 'viewed' | 'none'>
  >({});
  const [showMapModule, setShowMapModule] = useState(true);
  const [mapModuleReady, setMapModuleReady] = useState(false);
  const [mapHasBeenOpened, setMapHasBeenOpened] = useState(false);
  const [showMapDecisionForm, setShowMapDecisionForm] = useState(false);
  const [locationsRefreshTrigger, setLocationsRefreshTrigger] = useState(0);
  const sessionContentRef = useRef<HTMLDivElement | null>(null);
  const [_incidents, setIncidents] = useState<
    Array<{
      id: string;
      title: string;
      description: string;
      location_lat?: number | null;
      location_lng?: number | null;
      severity: string;
      status: string;
      type: string;
      casualty_count?: number;
    }>
  >([]);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [showTeamAssignmentModal, setShowTeamAssignmentModal] = useState(false);
  const [filterTeam, setFilterTeam] = useState<string>('none');
  const [myTeams, setMyTeams] = useState<Array<{ team_name: string; team_role?: string }>>([]);
  const [scenarioTeams, setScenarioTeams] = useState<ScenarioTeamWithCounters[]>([]);
  const [backendDecisions, setBackendDecisions] = useState<
    Array<{
      id: string;
      title: string;
      executed_at: string | null;
      environmental_consistency?: {
        consistent?: boolean;
        mismatch_kind?: string;
        severity?: string;
        reason?: string;
      } | null;
    }>
  >([]);
  const [backendActivities, setBackendActivities] = useState<
    Array<{
      type: string;
      at: string;
      title?: string;
      reason?: string;
      step?: string;
      summary?: string;
      matrix?: Record<string, Record<string, number>>;
      robustness_by_decision?: Record<string, number>;
      response_taxonomy?: Record<string, string>;
      analysis?: {
        overall?: string;
        matrix_reasoning?: string;
        robustness_reasoning?: string;
        matrix_cell_reasoning?: Record<string, Record<string, string>>;
        raw_robustness_by_decision?: Record<string, number>;
        robustness_cap_detail?: Record<
          string,
          { raw: number; capped: number; severity: string; mismatch_kind: string; reason?: string }
        >;
      };
      computed_band?: 'low' | 'medium' | 'high';
      managed_effect_keys?: string[];
      factors?: Array<{ id: string; name: string; description: string; severity: string }>;
      de_escalation_factors?: Array<{ id: string; name: string; description: string }>;
      pathways?: Array<{
        pathway_id: string;
        trajectory: string;
        trigger_behaviours: string[];
      }>;
      de_escalation_pathways?: Array<{
        pathway_id: string;
        trajectory: string;
        mitigating_behaviours: string[];
        emerging_challenges?: string[];
      }>;
    }>
  >([]);

  // --- Scenario-generated equipment (dynamic palette) ---
  const [scenarioEquipment, setScenarioEquipment] = useState<
    Array<{
      id: string;
      scenario_id: string;
      equipment_type: string;
      label: string;
      icon: string | null;
      properties: Record<string, unknown>;
      applicable_teams?: string[];
    }>
  >([]);

  // --- Action recording state for map-based decisions ---
  const [actionRecording, setActionRecording] = useState<{
    active: boolean;
    incidentId?: string;
    incidentTitle?: string;
    actions: Array<{
      placementId: string;
      label: string;
      assetType: string;
      geometryType: string;
      properties: Record<string, unknown>;
    }>;
    crowdMoves: Array<{
      crowdId: string;
      label: string;
      fromLat: number;
      fromLng: number;
      toLat: number;
      toLng: number;
    }>;
  } | null>(null);

  const handlePlacementCreated = useCallback(
    (placement: {
      id: string;
      label: string;
      asset_type: string;
      geometry: Record<string, unknown>;
      properties: Record<string, unknown>;
    }) => {
      if (!actionRecording?.active) return;
      setActionRecording((prev) => {
        if (!prev?.active) return prev;
        return {
          ...prev,
          actions: [
            ...prev.actions,
            {
              placementId: placement.id,
              label: placement.label,
              assetType: placement.asset_type,
              geometryType: (placement.geometry?.type as string) ?? 'Point',
              properties: placement.properties,
            },
          ],
        };
      });
    },
    [actionRecording?.active],
  );

  const handlePlacementUpdated = useCallback(
    (placementId: string, label: string, properties: Record<string, unknown>) => {
      setActionRecording((prev) => {
        if (!prev?.active) return prev;
        return {
          ...prev,
          actions: prev.actions.map((a) =>
            a.placementId === placementId
              ? { ...a, label, properties: { ...a.properties, ...properties } }
              : a,
          ),
        };
      });
    },
    [],
  );

  const handleCrowdMoved = useCallback(
    (move: {
      id: string;
      label: string;
      fromLat: number;
      fromLng: number;
      toLat: number;
      toLng: number;
    }) => {
      if (!actionRecording?.active) return;
      setActionRecording((prev) => {
        if (!prev?.active) return prev;
        return {
          ...prev,
          crowdMoves: [
            ...prev.crowdMoves,
            {
              crowdId: move.id,
              label: move.label,
              fromLat: move.fromLat,
              fromLng: move.fromLng,
              toLat: move.toLat,
              toLng: move.toLng,
            },
          ],
        };
      });
    },
    [actionRecording?.active],
  );

  const handleStartRecording = useCallback(() => {
    setActionRecording({ active: true, actions: [], crowdMoves: [] });
  }, []);

  const handleRespondWithAction = useCallback((incidentId: string, incidentTitle: string) => {
    setActionRecording({ active: true, incidentId, incidentTitle, actions: [], crowdMoves: [] });
  }, []);

  const handleCancelRecording = useCallback(() => {
    setActionRecording(null);
  }, []);

  const handleSubmitActions = useCallback(
    async (userDescription: string) => {
      const hasActions = (actionRecording?.actions?.length ?? 0) > 0;
      const hasCrowdMoves = (actionRecording?.crowdMoves?.length ?? 0) > 0;
      if (!id || !actionRecording?.active || (!hasActions && !hasCrowdMoves)) return;

      const teamName = myTeams[0]?.team_name ?? 'Unknown team';
      const descParts: string[] = [];

      if (hasActions) {
        const grouped = new Map<string, typeof actionRecording.actions>();
        for (const a of actionRecording.actions) {
          const key = a.label;
          if (!grouped.has(key)) grouped.set(key, []);
          grouped.get(key)!.push(a);
        }

        const parts: string[] = [];
        for (const [label, group] of grouped) {
          const count = group.length;
          for (const item of group) {
            const details: string[] = [];
            const p = item.properties;
            if (p.length_m) details.push(`${p.length_m}m long`);
            if (p.area_m2) details.push(`${p.area_m2}m² area`);
            if (p.capacity) {
              const unit = (p.capacity_unit as string) ?? 'people';
              details.push(`capacity: ${p.capacity} ${unit}`);
            }
            if (p.encloses && Array.isArray(p.encloses) && (p.encloses as string[]).length > 0) {
              details.push(`encloses ${(p.encloses as string[]).length} asset(s)`);
            }
            const geoLabel =
              item.geometryType === 'Polygon'
                ? 'zone'
                : item.geometryType === 'LineString'
                  ? 'line'
                  : 'point';
            const detailStr = details.length ? ` — ${details.join(', ')}` : '';
            parts.push(`${label} (${geoLabel})${detailStr}`);
          }
          if (count > 1) {
            parts.push(`(${count}x ${label} total)`);
          }
        }
        descParts.push(`${teamName} placed: ${parts.join('; ')}`);
      }

      if (hasCrowdMoves) {
        const moveParts: string[] = [];
        for (const m of actionRecording.crowdMoves) {
          moveParts.push(`Moved "${m.label}" to new position`);
        }
        descParts.push(`${teamName} crowd movements: ${moveParts.join('; ')}`);
      }

      const autoDesc = descParts.join('. ');
      const fullDescription = userDescription
        ? `${userDescription}\n\nMap actions: ${autoDesc}`
        : autoDesc;
      const title = actionRecording.incidentTitle
        ? `Map response to: ${actionRecording.incidentTitle}`
        : `Map deployment by ${teamName}`;

      try {
        const createResult = await api.decisions.create({
          session_id: id,
          title,
          description: fullDescription,
          team_name: teamName,
          response_to_incident_id: actionRecording.incidentId ?? null,
          proposed_action: fullDescription,
          auto_execute: true,
        });

        const decision = createResult?.data as { id?: string } | undefined;
        if (decision?.id) {
          await api.decisions.execute(decision.id);

          await Promise.allSettled(
            actionRecording.actions.map((a) =>
              api.placements.update(id, a.placementId, {
                linked_decision_id: decision.id!,
              }),
            ),
          );
        }
      } catch (err) {
        console.error('Failed to submit map actions as decision:', err);
        alert(
          `Failed to submit map actions: ${err instanceof Error ? err.message : 'Unknown error'}`,
        );
      }

      setActionRecording(null);
    },
    [id, actionRecording, myTeams],
  );

  // If Insider reply contains a #show-map hash link, ensure map opens (it's already visible by default).
  useEffect(() => {
    const openFromHash = () => {
      if (window.location.hash === '#show-map') setShowMapModule(true);
    };
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
    return () => window.removeEventListener('hashchange', openFromHash);
  }, []);

  // Once the user opens the map, keep it mounted but hidden when closed (avoids Leaflet removeChild on unmount).
  useEffect(() => {
    if (showMapModule) setMapHasBeenOpened(true);
  }, [showMapModule]);

  // Mount MapView as soon as the map module is shown so Leaflet gets into the DOM.
  useEffect(() => {
    if (!showMapModule) {
      setMapModuleReady(false);
      return;
    }
    setMapModuleReady(true);
  }, [showMapModule]);

  useEffect(() => {
    if (id) {
      loadSession();
      loadIncidents(id);
      loadMyTeams();
    }
  }, [id, user?.id]);

  // Load scenario teams when session has scenario (for dynamic team counters)
  useEffect(() => {
    const scenarioId = session?.scenarios?.id ?? session?.scenario_id;
    if (!scenarioId) return;
    api.teams
      .getScenarioTeams(scenarioId)
      .then((r) => setScenarioTeams(r.data || []))
      .catch(() => setScenarioTeams([]));
  }, [session?.scenarios?.id, session?.scenario_id]);

  // Load scenario equipment for dynamic palette
  useEffect(() => {
    if (!id) return;
    api.equipment
      .list(id)
      .then((r) => setScenarioEquipment(r.data || []))
      .catch(() => setScenarioEquipment([]));
  }, [id]);

  // Backend/AI activity log for trainers (poll every 8s when in progress, load once when completed)
  useEffect(() => {
    if (!id || !isTrainer || !session) return;
    if (session.status !== 'in_progress' && session.status !== 'completed') return;
    const loadBackendActivity = async () => {
      try {
        const res = await api.sessions.getBackendActivity(id);
        setBackendActivities(res.activities || []);
        setBackendDecisions(res.decisions || []);
      } catch {
        // Non-blocking; leave previous data
      }
    };
    loadBackendActivity();
    const interval =
      session.status === 'in_progress' ? setInterval(loadBackendActivity, 8000) : undefined;
    return () => (interval ? clearInterval(interval) : undefined);
  }, [id, isTrainer, session?.status]);

  // Mark card as viewed (green → yellow dot)
  const markCardViewed = (cardId: string) => {
    setCardNotifications((prev) => {
      if (prev[cardId] === 'new') {
        return { ...prev, [cardId]: 'viewed' };
      }
      return prev;
    });
  };

  const loadMyTeams = async () => {
    if (!id || !user?.id) {
      console.log('[SessionView] loadMyTeams: Missing id or user.id', { id, userId: user?.id });
      return;
    }
    try {
      const result = await api.teams.getSessionTeams(id);
      console.log('[SessionView] loadMyTeams: API result', {
        allAssignments: result.data,
        userId: user.id,
      });
      const myTeamAssignments = (result.data || []).filter(
        (assignment: any) => assignment.user_id === user.id,
      );
      console.log('[SessionView] loadMyTeams: Filtered assignments', myTeamAssignments);
      setMyTeams(
        myTeamAssignments.map((a: any) => ({
          team_name: a.team_name,
          team_role: a.team_role,
        })),
      );
    } catch (error) {
      console.error('[SessionView] Failed to load team assignments:', error);
    }
  };

  // Update current time every second for timer
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Calculate elapsed time
  const elapsedTime = useMemo(() => {
    if (!session?.start_time || session.status !== 'in_progress') {
      return null;
    }

    const start = new Date(session.start_time);
    const elapsed = currentTime.getTime() - start.getTime();

    const hours = Math.floor(elapsed / (1000 * 60 * 60));
    const minutes = Math.floor((elapsed % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((elapsed % (1000 * 60)) / 1000);

    return {
      hours,
      minutes,
      seconds,
      totalSeconds: Math.floor(elapsed / 1000),
    };
  }, [session?.start_time, session?.status, currentTime]);

  const loadIncidents = async (sessionId: string) => {
    try {
      const result = await api.incidents.list(sessionId);
      setIncidents(
        (result.data || []) as Array<{
          id: string;
          title: string;
          description: string;
          location_lat?: number | null;
          location_lng?: number | null;
          severity: string;
          status: string;
          type: string;
          casualty_count?: number;
        }>,
      );
    } catch (error) {
      console.error('Failed to load incidents:', error);
    }
  };

  // Function commented out as it's currently unused
  // const handleIncidentClick = (incident: {
  //   id: string;
  //   title: string;
  //   description: string;
  //   location_lat?: number | null;
  //   location_lng?: number | null;
  //   severity: string;
  //   status: string;
  //   type: string;
  //   casualty_count?: number;
  // }) => {
  //   setSelectedIncidentId(incident.id);
  //   // Scroll to incidents panel if it exists
  //   setTimeout(() => {
  //     const incidentsPanel = document.getElementById('incidents-panel');
  //     if (incidentsPanel) {
  //       incidentsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  //     }
  //   }, 100);
  // };

  // WebSocket subscription for notifications and card updates
  useWebSocket({
    sessionId: id || '',
    eventTypes: [
      'inject.published',
      'decision.proposed',
      'decision.approved',
      'decision.executed',
      'resource.requested',
      'resource.countered',
      'resource.approved',
      'resource.rejected',
      'resource.transferred',
      'message.sent',
      'incident.created',
      'incident.updated',
      'media_post',
      'state.updated',
    ],
    onEvent: (event: WebSocketEvent) => {
      if (event.type === 'state.updated') {
        const payload = event.data as {
          state?: Record<string, unknown>;
          inject_state_effects?: Record<string, unknown>;
        };
        if (payload?.state) {
          const state = sanitizeCurrentState(payload.state);
          setSession((prev) => {
            if (!prev) return null;
            const update: Partial<Session> = { current_state: state };
            if (payload.inject_state_effects) {
              update.inject_state_effects = payload.inject_state_effects;
            }
            return { ...prev, ...update };
          });
        }
        return;
      }
      // Handle event-specific UI updates
      // Note: Notifications are now automatically created by the backend notification system

      // Update card notification dots based on event type
      if (event.type === 'inject.published') {
        setCardNotifications((prev) => ({ ...prev, injects: 'new' }));
        // Also update timeline
        setCardNotifications((prev) => ({ ...prev, timeline: 'new' }));
      } else if (
        event.type === 'decision.proposed' ||
        event.type === 'decision.approved' ||
        event.type === 'decision.executed'
      ) {
        setCardNotifications((prev) => ({ ...prev, decisions: 'new' }));
        // Also update timeline
        setCardNotifications((prev) => ({ ...prev, timeline: 'new' }));
      } else if (event.type === 'message.sent') {
        setCardNotifications((prev) => ({ ...prev, chat: 'new' }));
        // Also update timeline
        setCardNotifications((prev) => ({ ...prev, timeline: 'new' }));
      } else if (event.type === 'incident.created' || event.type === 'incident.updated') {
        setCardNotifications((prev) => ({ ...prev, incidents: 'new' }));
        // Also update timeline
        setCardNotifications((prev) => ({ ...prev, timeline: 'new' }));
        // Reload incidents to update map
        if (id) {
          loadIncidents(id);
        }
      } else if (event.type === 'media_post') {
        setCardNotifications((prev) => ({ ...prev, media: 'new' }));
      } else if (
        event.type === 'resource.requested' ||
        event.type === 'resource.countered' ||
        event.type === 'resource.approved' ||
        event.type === 'resource.rejected' ||
        event.type === 'resource.transferred'
      ) {
        // Resource events update timeline
        setCardNotifications((prev) => ({ ...prev, timeline: 'new' }));
      }
    },
    enabled: !!id && session?.status === 'in_progress',
  });

  const loadSession = async () => {
    if (!id) return;
    try {
      // Remove this - it's already called in Sessions page
      // if (!isTrainer) {
      //   try {
      //     await api.sessions.processInvitations();
      //   } catch (err) {
      //     console.debug('Failed to process invitations:', err);
      //   }
      // }

      const result = await api.sessions.get(id);
      const sessionData = result.data as Session;
      if (sessionData.current_state && typeof sessionData.current_state === 'object') {
        sessionData.current_state = sanitizeCurrentState(
          sessionData.current_state as Record<string, unknown>,
        ) as Session['current_state'];
      }
      // Add currentUserId for lobby component
      (sessionData as unknown as { currentUserId?: string }).currentUserId = user?.id;
      setSession(sessionData);
    } catch (error) {
      console.error('Failed to load session:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleStartSession = async () => {
    if (!id) return;
    try {
      await api.sessions.update(id, { status: 'in_progress' });
      await loadSession();
    } catch (error) {
      console.error('Failed to start session:', error);
      alert('Failed to start session');
    }
  };

  const handleCompleteSession = async () => {
    if (!id) return;
    if (
      !confirm(
        'Are you sure you want to complete this session? This will end the exercise and allow AAR generation.',
      )
    ) {
      return;
    }
    try {
      await api.sessions.update(id, { status: 'completed' });
      await loadSession();
    } catch (error) {
      console.error('Failed to complete session:', error);
      alert('Failed to complete session');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center scanline">
        <div className="text-center">
          <div className="text-lg terminal-text mb-2 animate-pulse">[LOADING]</div>
          <div className="text-xs terminal-text text-robotic-yellow/50">Loading session...</div>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="min-h-screen flex items-center justify-center scanline">
        <div className="military-border p-8 text-center">
          <h2 className="text-xl terminal-text text-robotic-orange mb-4">
            [ERROR] Session Not Found
          </h2>
          <button onClick={() => navigate('/sessions')} className="military-button px-6 py-3">
            [BACK_TO_SESSIONS]
          </button>
        </div>
      </div>
    );
  }

  // Show lobby if session is scheduled
  if (session.status === 'scheduled') {
    return (
      <div className="min-h-screen scanline">
        {/* Header */}
        <div className="military-border border-b-2 border-robotic-yellow bg-robotic-gray-300">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between items-center h-16">
              <div>
                <h1 className="text-lg terminal-text uppercase">
                  {session.scenarios?.title || 'Session'}
                </h1>
                <p className="text-xs terminal-text text-robotic-yellow/70">
                  Status: {session.status.toUpperCase().replace('_', ' ')}
                </p>
              </div>
              <div className="flex items-center gap-4">
                <NotificationBell />
                <button
                  onClick={() => navigate('/sessions')}
                  className="px-4 py-2 text-xs terminal-text uppercase border border-robotic-orange text-robotic-orange hover:bg-robotic-orange/10"
                >
                  [BACK]
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Lobby Content */}
        <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
          {id && (
            <SessionLobby
              sessionId={id}
              session={session}
              onStartSession={handleStartSession}
              onSessionUpdate={loadSession}
            />
          )}
        </div>
      </div>
    );
  }

  // ── Spectator Mode ──────────────────────────────────────────────────────
  if (isSpectator && id && session) {
    const isGodView = spectatorMode === 'god';

    return (
      <div className="h-screen w-screen overflow-hidden bg-robotic-gray-400 relative flex">
        {/* Map area */}
        <div className={`relative ${isGodView ? 'flex-1' : 'absolute inset-0'}`}>
          <MapView
            sessionId={id}
            incidents={[]}
            resources={[]}
            isVisible={true}
            fillHeight
            showAllPins
            bypassExitGate
            locationsRefreshTrigger={locationsRefreshTrigger}
            sessionStartTime={session?.start_time ?? undefined}
            currentState={mergeInjectEffects(
              (session?.current_state as Record<string, unknown>) ?? {},
              session?.inject_state_effects,
            )}
            initialCenter={
              session?.scenarios?.center_lat != null && session?.scenarios?.center_lng != null
                ? ([session.scenarios.center_lat, session.scenarios.center_lng] as [number, number])
                : [1.3521, 103.8198]
            }
            initialZoom={16}
            teamName="Spectator"
            draggableAssets={[]}
            scenarioType={
              ((session?.current_state as Record<string, unknown>)?.scenario_type as string) ??
              undefined
            }
          />
        </div>

        {/* God View: Activity ticker sidebar */}
        {isGodView && (
          <div className="w-80 h-full shrink-0">
            <ActivityTicker sessionId={id} />
          </div>
        )}

        {/* Cinematic overlay (action cards, inject banners) */}
        {spectatorMode === 'cinematic' && <CinematicOverlay sessionId={id} />}

        {/* Team Spotlight overlay */}
        {spectatorMode === 'spotlight' && <TeamSpotlightOverlay sessionId={id} />}

        {/* Top-left: DEMO badge + scenario name */}
        <div className="absolute top-4 left-4 z-[1000] flex items-center gap-3">
          <span className="px-3 py-1 text-xs font-bold uppercase tracking-widest bg-robotic-red text-white rounded">
            DEMO
          </span>
          <span className="px-3 py-1.5 text-sm terminal-text bg-robotic-gray-300/90 border border-robotic-yellow/50 rounded backdrop-blur-sm">
            {session.scenarios?.title || 'Simulation'}
          </span>
        </div>

        {/* Top-right: Elapsed time */}
        {elapsedTime && (
          <div className="absolute top-4 right-4 z-[1000] px-4 py-2 bg-robotic-gray-300/90 border border-robotic-yellow/50 rounded backdrop-blur-sm">
            <span className="text-xs terminal-text text-robotic-yellow/70 uppercase mr-2">
              ELAPSED
            </span>
            <span className="text-lg terminal-text text-robotic-yellow font-mono font-bold">
              {String(elapsedTime.hours).padStart(2, '0')}:
              {String(elapsedTime.minutes).padStart(2, '0')}:
              {String(elapsedTime.seconds).padStart(2, '0')}
            </span>
          </div>
        )}

        {/* Bottom-left: Mode switcher */}
        <div className="absolute bottom-4 left-4 z-[1000] flex items-center gap-1">
          {(['cinematic', 'god', 'spotlight'] as const).map((m) => (
            <button
              key={m}
              onClick={() => {
                const url = new URL(window.location.href);
                url.searchParams.set('mode', m);
                window.history.replaceState({}, '', url.toString());
              }}
              className={`px-3 py-1.5 text-xs terminal-text uppercase border rounded backdrop-blur-sm ${
                spectatorMode === m
                  ? 'bg-robotic-yellow/20 border-robotic-yellow text-robotic-yellow'
                  : 'bg-robotic-gray-300/70 border-robotic-yellow/30 text-robotic-yellow/50 hover:text-robotic-yellow/80'
              }`}
            >
              {m === 'cinematic' ? 'CINE' : m === 'god' ? 'GOD' : 'TEAM'}
            </button>
          ))}
        </div>

        {/* Bottom-right: Exit spectator */}
        <div className="absolute bottom-4 right-4 z-[1000]">
          <button
            onClick={() => navigate(`/sessions/${id}`)}
            className="px-3 py-1.5 text-xs terminal-text uppercase border border-robotic-orange/50 text-robotic-orange/70 hover:text-robotic-orange rounded bg-robotic-gray-300/70 backdrop-blur-sm"
          >
            EXIT DEMO
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen scanline">
      {/* Header */}
      <div className="military-border border-b-2 border-robotic-yellow bg-robotic-gray-300">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center gap-6 flex-1">
              <div>
                <h1 className="text-lg terminal-text uppercase">
                  {session.scenarios?.title || 'Session'}
                </h1>
                <p className="text-xs terminal-text text-robotic-yellow/70">
                  Status: {session.status.toUpperCase().replace('_', ' ')}
                </p>
              </div>
              {/* Player Name and Team Assignments */}
              <div className="flex items-center gap-4">
                {/* Player Name */}
                {user && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs terminal-text text-robotic-yellow/70 uppercase">
                      Player:
                    </span>
                    <span className="px-2 py-1 text-xs terminal-text military-border bg-robotic-gray-200 border-robotic-yellow">
                      {session?.participants?.find((p) => p.user_id === user.id)?.user?.full_name ||
                        user.displayName ||
                        user.email ||
                        'Unknown'}
                    </span>
                  </div>
                )}
                {/* Team Assignments Badge */}
                <div className="flex items-center gap-2">
                  <span className="text-xs terminal-text text-robotic-yellow/70 uppercase">
                    Teams:
                  </span>
                  {myTeams.length > 0 ? (
                    <div className="flex gap-1">
                      {myTeams.map((team, idx) => (
                        <span
                          key={idx}
                          className="px-2 py-1 text-xs terminal-text military-border bg-robotic-green/20 border-robotic-green"
                        >
                          {team.team_name.toUpperCase()}
                          {team.team_role && (
                            <span className="ml-1 text-robotic-yellow/70">({team.team_role})</span>
                          )}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="px-2 py-1 text-xs terminal-text text-robotic-yellow/50 italic">
                      [NO_TEAMS_ASSIGNED]
                    </span>
                  )}
                </div>
              </div>
              {elapsedTime && (
                <div className="military-border px-4 py-2 bg-robotic-gray-200 border-robotic-yellow">
                  <div className="flex items-center gap-2">
                    <span className="text-xs terminal-text text-robotic-yellow/70 uppercase">
                      [ELAPSED_TIME]
                    </span>
                    <span className="text-lg terminal-text text-robotic-yellow font-mono font-bold">
                      {String(elapsedTime.hours).padStart(2, '0')}:
                      {String(elapsedTime.minutes).padStart(2, '0')}:
                      {String(elapsedTime.seconds).padStart(2, '0')}
                    </span>
                  </div>
                </div>
              )}
              {session.status === 'completed' && (
                <div className="military-border px-4 py-2 bg-robotic-green/20 border-robotic-green">
                  <span className="text-xs terminal-text text-robotic-green uppercase">
                    [SESSION_COMPLETED]
                  </span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              {session.status === 'in_progress' && (
                <BackgroundMusic src="/audio/detective-bgm.mp3" />
              )}
              <NotificationBell />
              {isTrainer && session.status === 'in_progress' && (
                <button
                  onClick={handleCompleteSession}
                  className="px-4 py-2 text-xs terminal-text uppercase border border-robotic-red text-robotic-red hover:bg-robotic-red/10"
                >
                  [COMPLETE_SESSION]
                </button>
              )}
              <button
                onClick={() => navigate('/sessions')}
                className="px-4 py-2 text-xs terminal-text uppercase border border-robotic-orange text-robotic-orange hover:bg-robotic-orange/10"
              >
                [BACK]
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Team Assignments Info Panel - Show during active session */}
      {session.status === 'in_progress' && myTeams.length > 0 && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="military-border p-4 bg-robotic-green/10 border-robotic-green">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-sm terminal-text uppercase text-robotic-green">
                [YOUR_TEAM_ASSIGNMENTS]
              </span>
              <div className="flex gap-2 flex-wrap">
                {myTeams.map((team, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-2 px-3 py-1 military-border bg-robotic-gray-200"
                  >
                    <span className="text-sm terminal-text font-semibold">
                      {team.team_name.toUpperCase()}
                    </span>
                    {team.team_role && (
                      <span className="text-xs terminal-text text-robotic-yellow/70">
                        ({team.team_role})
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <p className="text-xs terminal-text text-robotic-yellow/70 mt-2">
              You will receive team-specific injects and information during the session.
            </p>
          </div>
        </div>
      )}

      {/* Team Counters Panel - dynamic per scenario teams; trainer sees all, participant sees own team(s) */}
      {(session.status === 'in_progress' || session.status === 'completed') &&
        (() => {
          const cs = session.current_state as Record<string, unknown> | undefined;

          // Map team_name to current_state key (backward compat: Evacuation/Triage/Media)
          const teamToStateKey = (name: string): string => {
            const n = (name ?? '').toLowerCase();
            if (/evacuation|evac/.test(n)) return 'evacuation_state';
            if (/triage/.test(n)) return 'triage_state';
            if (/media/.test(n)) return 'media_state';
            if (/fire|rescue|scdf/.test(n)) return 'fire_rescue_state';
            return `${n.replace(/\s+/g, '_')}_state`;
          };

          // Use scenario teams when available; fallback to legacy evac/triage/media if no teams
          const teamsToShow =
            scenarioTeams.length > 0
              ? scenarioTeams
              : [{ team_name: 'Evacuation' }, { team_name: 'Triage' }, { team_name: 'Media' }];

          const blocks: React.ReactNode[] = [];
          for (const team of teamsToShow) {
            const stateKey = teamToStateKey(team.team_name);
            const state = (cs?.[stateKey] as Record<string, unknown> | undefined) ?? {};
            const showBlock =
              isTrainer ||
              myTeams.some((t) => t.team_name?.toLowerCase() === team.team_name?.toLowerCase());
            if (!showBlock) continue;
            if (Object.keys(state).length === 0 && !isTrainer) continue;

            const displayName =
              team.team_name.charAt(0).toUpperCase() + (team.team_name?.slice(1) ?? '');

            const defs = (team as ScenarioTeamWithCounters).counter_definitions;

            // Trainer view always uses the live-counter sections below (which
            // read real-time values from the scheduler). Players see the
            // counter_definitions-driven display with template-defined caps.
            if (!isTrainer && defs && Array.isArray(defs) && defs.length > 0) {
              // Data-driven rendering from counter_definitions
              const visibleDefs = defs.filter((d) => d.visible_to !== 'trainer_only' || isTrainer);
              if (visibleDefs.length === 0 && !isTrainer) continue;

              blocks.push(
                <div key={stateKey} className="military-border p-3 bg-robotic-gray-300">
                  <div className="text-xs terminal-text uppercase text-robotic-yellow/80 mb-2">
                    {displayName}
                  </div>
                  <div className="text-sm terminal-text text-robotic-gray-50 space-y-1">
                    {visibleDefs.map((def) => {
                      const val = state[def.key];
                      if (def.type === 'number') {
                        const numVal = Math.max(0, Number(val) || 0);
                        const capKey = def.config?.cap_key;
                        const capVal = capKey ? Math.max(0, Number(state[capKey]) || 0) : null;
                        return (
                          <div key={def.key}>
                            {def.label}: {numVal}
                            {capVal != null && capVal > 0 && (
                              <>
                                {' / '}
                                {capVal}
                                <span className="text-robotic-yellow/70 ml-1">
                                  ({Math.round((numVal / capVal) * 100)}%)
                                </span>
                              </>
                            )}
                          </div>
                        );
                      } else if (def.type === 'boolean') {
                        return (
                          <div key={def.key}>
                            {def.label}: {val === true ? 'Yes' : 'No'}
                          </div>
                        );
                      } else {
                        return (
                          <div key={def.key}>
                            {def.label}:{' '}
                            {val == null
                              ? '–'
                              : typeof val === 'object'
                                ? JSON.stringify(val)
                                : String(val)}
                          </div>
                        );
                      }
                    })}
                  </div>
                </div>,
              );
            } else if (stateKey === 'evacuation_state') {
              const totalEvac = Math.max(
                0,
                Number(state.total_evacuated) || Number(state.evacuated_count) || 0,
              );
              const atAssembly = Math.max(0, Number(state.civilians_at_assembly) || 0);
              const stillIn = Math.max(0, Number(state.still_inside) || 0);
              const transit = Math.max(0, Number(state.in_transit) || 0);
              blocks.push(
                <div key={stateKey} className="military-border p-3 bg-robotic-gray-300">
                  <div className="text-xs terminal-text uppercase text-robotic-yellow/80 mb-2">
                    {displayName}
                  </div>
                  <div className="text-sm terminal-text text-robotic-gray-50 space-y-1">
                    <div>At assembly: {atAssembly}</div>
                    <div>Total evacuated: {totalEvac}</div>
                    <div>Still inside: {stillIn}</div>
                    <div>In transit: {transit}</div>
                  </div>
                </div>,
              );
            } else if (stateKey === 'triage_state') {
              blocks.push(
                <div key={stateKey} className="military-border p-3 bg-robotic-gray-300">
                  <div className="text-xs terminal-text uppercase text-robotic-yellow/80 mb-2">
                    {displayName}
                  </div>
                  <div className="text-sm terminal-text text-robotic-gray-50 space-y-1">
                    <div>
                      Awaiting triage:{' '}
                      {Math.max(
                        0,
                        Number(state.awaiting_triage) || Number(state.patients_waiting) || 0,
                      )}
                    </div>
                    <div>
                      In treatment:{' '}
                      {Math.max(
                        0,
                        Number(state.in_treatment) || Number(state.patients_being_treated) || 0,
                      )}
                      {(Number(state.red_immediate) > 0 ||
                        Number(state.yellow_delayed) > 0 ||
                        Number(state.green_minor) > 0) && (
                        <span className="text-robotic-yellow/70 ml-1">
                          (
                          {Number(state.red_immediate) > 0 && (
                            <span className="text-red-400">{Number(state.red_immediate)}R</span>
                          )}
                          {Number(state.yellow_delayed) > 0 && (
                            <span className="text-yellow-400 ml-1">
                              {Number(state.yellow_delayed)}Y
                            </span>
                          )}
                          {Number(state.green_minor) > 0 && (
                            <span className="text-green-400 ml-1">
                              {Number(state.green_minor)}G
                            </span>
                          )}
                          )
                        </span>
                      )}
                    </div>
                    <div>
                      Ready for transport: {Math.max(0, Number(state.ready_for_transport) || 0)}
                    </div>
                    <div>
                      Transported:{' '}
                      {Math.max(
                        0,
                        Number(state.transported) || Number(state.handed_over_to_hospital) || 0,
                      )}
                    </div>
                    <div>Deaths on site: {Math.max(0, Number(state.deaths_on_site) || 0)}</div>
                  </div>
                </div>,
              );
            } else if (stateKey === 'media_state') {
              const unanswered = Math.max(0, Number(state.unanswered_challenges) || 0);
              blocks.push(
                <div key={stateKey} className="military-border p-3 bg-robotic-gray-300">
                  <div className="text-xs terminal-text uppercase text-robotic-yellow/80 mb-2">
                    {displayName}
                  </div>
                  <div className="text-sm terminal-text text-robotic-gray-50 space-y-1">
                    <div>
                      Statements issued: {Math.max(0, Number(state.statements_issued) || 0)}
                    </div>
                    <div>
                      Misinformation addressed:{' '}
                      {Math.max(0, Number(state.misinformation_addressed_count) || 0)}
                    </div>
                    <div>
                      Public sentiment:{' '}
                      {state.public_sentiment != null ? Number(state.public_sentiment) : '–'} / 10
                      {state.sentiment_label != null ? (
                        <span
                          className="ml-1 text-robotic-yellow/70"
                          title={String(state.sentiment_reason ?? '')}
                        >
                          ({String(state.sentiment_label)})
                        </span>
                      ) : null}
                    </div>
                    {unanswered > 0 && (
                      <div className="text-red-400">Unanswered challenges: {unanswered}</div>
                    )}
                  </div>
                </div>,
              );
            } else if (stateKey === 'fire_rescue_state') {
              blocks.push(
                <div key={stateKey} className="military-border p-3 bg-robotic-gray-300">
                  <div className="text-xs terminal-text uppercase text-robotic-yellow/80 mb-2">
                    {displayName}
                  </div>
                  <div className="text-sm terminal-text text-robotic-gray-50 space-y-1">
                    <div>Active fires: {Math.max(0, Number(state.active_fires) || 0)}</div>
                    <div>Fires contained: {Math.max(0, Number(state.fires_contained) || 0)}</div>
                    <div>Fires extinguished: {Math.max(0, Number(state.fires_resolved) || 0)}</div>
                    <div>
                      Casualties in hot zone:{' '}
                      {Math.max(0, Number(state.casualties_in_hot_zone) || 0)}
                    </div>
                    <div>
                      Extracted to warm zone: {Math.max(0, Number(state.extracted_to_warm) || 0)}
                    </div>
                    <div>Debris cleared: {Math.max(0, Number(state.debris_cleared) || 0)}</div>
                  </div>
                </div>,
              );
            } else {
              // Generic team: show counter-like keys (numbers, booleans as yes/no)
              const entries = Object.entries(state).filter(
                ([_, v]) =>
                  typeof v === 'number' ||
                  typeof v === 'boolean' ||
                  (typeof v === 'string' && v.length < 50),
              );
              if (entries.length > 0 || isTrainer) {
                blocks.push(
                  <div key={stateKey} className="military-border p-3 bg-robotic-gray-300">
                    <div className="text-xs terminal-text uppercase text-robotic-yellow/80 mb-2">
                      {displayName}
                    </div>
                    <div className="text-sm terminal-text text-robotic-gray-50 space-y-1">
                      {entries.length > 0 ? (
                        entries.map(([k, v]) => (
                          <div key={k}>
                            {k.replace(/_/g, ' ')}:{' '}
                            {typeof v === 'boolean'
                              ? v
                                ? 'Yes'
                                : 'No'
                              : typeof v === 'object' && v !== null
                                ? JSON.stringify(v)
                                : String(v)}
                          </div>
                        ))
                      ) : (
                        <span className="text-robotic-gray-500 text-xs">No metrics yet</span>
                      )}
                    </div>
                  </div>,
                );
              }
            }
          }

          if (blocks.length === 0) return null;
          return (
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
              <div className="military-border p-4 bg-robotic-gray-200">
                <h3 className="text-sm terminal-text uppercase text-robotic-yellow mb-3">
                  [TEAM METRICS]
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {blocks}
                </div>
              </div>
            </div>
          );
        })()}

      {/* Area Occupancy Breakdown */}
      {session.status === 'in_progress' &&
        (() => {
          const areaOccupancy = (session.current_state as Record<string, unknown> | undefined)
            ?.area_occupancy as Array<{ area_label: string; headcount: number }> | undefined;
          if (!areaOccupancy?.length) return null;
          return (
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2">
              <div className="military-border p-4 bg-robotic-gray-200">
                <h3 className="text-sm terminal-text uppercase text-robotic-yellow mb-3">
                  [AREA OCCUPANCY]
                </h3>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                  {areaOccupancy.map((a) => (
                    <div
                      key={a.area_label}
                      className="military-border p-2 bg-robotic-gray-300 text-center"
                    >
                      <div className="text-xs terminal-text text-robotic-yellow/80 uppercase truncate">
                        {a.area_label}
                      </div>
                      <div className="text-lg terminal-text text-robotic-gray-50 font-bold">
                        {a.headcount}
                      </div>
                      <div className="text-[10px] terminal-text text-robotic-gray-500 uppercase">
                        people
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })()}

      {/* Full-Width Heat Meter Bar */}
      {session.status === 'in_progress' &&
        (() => {
          const heatMeter = (session.current_state as Record<string, unknown> | undefined)
            ?.heat_meter as Record<string, { heat_percentage?: number }> | undefined;
          const teamsToShow = isTrainer
            ? Object.keys(heatMeter ?? {})
            : myTeams.map((t) => t.team_name).filter((tn) => heatMeter?.[tn]);
          if (!heatMeter || teamsToShow.length === 0) return null;
          return (
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2">
              <div className="military-border p-4 bg-robotic-gray-200">
                <h3 className="text-sm terminal-text uppercase text-robotic-yellow mb-3">
                  [HEAT METER]
                </h3>
                <div className="space-y-2">
                  {teamsToShow.map((tn) => {
                    const pct = heatMeter[tn]?.heat_percentage ?? 0;
                    const barColor =
                      pct >= 60
                        ? 'bg-red-500'
                        : pct >= 40
                          ? 'bg-orange-500'
                          : pct >= 20
                            ? 'bg-yellow-500'
                            : 'bg-green-500';
                    const textColor =
                      pct >= 60
                        ? 'text-red-400'
                        : pct >= 40
                          ? 'text-orange-400'
                          : pct >= 20
                            ? 'text-yellow-400'
                            : 'text-green-400';
                    return (
                      <div key={tn} className="flex items-center gap-3">
                        <span className="text-xs terminal-text text-robotic-yellow/70 uppercase w-24 shrink-0">
                          {tn.toUpperCase()}
                        </span>
                        <div className="flex-1 h-3 bg-robotic-gray-100 rounded-sm overflow-hidden">
                          <div
                            className={`h-full ${barColor} transition-all duration-500`}
                            style={{ width: `${Math.min(100, pct)}%` }}
                          />
                        </div>
                        <span
                          className={`text-sm terminal-text font-mono font-bold w-12 text-right ${textColor}`}
                        >
                          {pct.toFixed(0)}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })()}

      {/* Live map module - visible by default, can be hidden by user (trainers use the map in the trainer grid instead) */}
      {id && !isTrainer && (
        <div
          className={`max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2 ${showMapModule ? '' : 'hidden'}`}
          aria-hidden={!showMapModule}
        >
          <div className="military-border p-6 bg-robotic-gray-300 flex flex-col h-[calc(100vh-120px)] min-h-[700px]">
            <div className="flex justify-between items-center mb-3 flex-shrink-0">
              <h3 className="text-lg terminal-text uppercase">[MAP]</h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowMapDecisionForm(true)}
                  className="military-button px-4 py-2 text-xs terminal-text whitespace-nowrap border-green-400 text-green-400 hover:bg-green-400/10"
                >
                  [CREATE_DECISION]
                </button>
              </div>
            </div>
            {showMapDecisionForm && (
              <div className="mb-3 flex-shrink-0">
                <CreateDecisionForm
                  sessionId={id}
                  onClose={() => setShowMapDecisionForm(false)}
                  onSuccess={() => setShowMapDecisionForm(false)}
                />
              </div>
            )}
            <div className="flex-1 min-h-0 rounded border border-robotic-yellow/30 overflow-hidden">
              {mapModuleReady && mapHasBeenOpened && (
                <MapView
                  sessionId={id}
                  incidents={[]}
                  resources={[]}
                  isVisible={showMapModule}
                  fillHeight
                  locationsRefreshTrigger={locationsRefreshTrigger}
                  sessionStartTime={session?.start_time ?? undefined}
                  currentState={mergeInjectEffects(
                    (session?.current_state as Record<string, unknown>) ?? {},
                    session?.inject_state_effects,
                  )}
                  initialCenter={
                    session?.scenarios?.center_lat != null && session?.scenarios?.center_lng != null
                      ? ([session.scenarios.center_lat, session.scenarios.center_lng] as [
                          number,
                          number,
                        ])
                      : [1.3521, 103.8198]
                  }
                  initialZoom={16}
                  teamName={myTeams[0]?.team_name}
                  draggableAssets={
                    myTeams[0]?.team_name
                      ? getAssetsForTeam(myTeams[0].team_name, scenarioEquipment)
                      : []
                  }
                  scenarioType={
                    ((session?.current_state as Record<string, unknown>)
                      ?.scenario_type as string) ?? undefined
                  }
                  onPlacementCreated={handlePlacementCreated}
                  onPlacementUpdated={handlePlacementUpdated}
                  isRecordingActions={!!actionRecording?.active}
                  actionRecording={actionRecording}
                  onSubmitActions={handleSubmitActions}
                  onCancelRecording={handleCancelRecording}
                  onStartRecording={handleStartRecording}
                  onCrowdMoved={handleCrowdMoved}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Card-Based Content Grid */}
      <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
        {/* Shared team filter */}
        {id && (
          <div className="military-border p-3 mb-4 bg-robotic-gray-300 flex items-center gap-3">
            <label className="text-xs terminal-text text-robotic-yellow/70 uppercase">
              [FILTER BY TEAM]
            </label>
            <select
              value={filterTeam}
              onChange={(e) => setFilterTeam(e.target.value)}
              className="military-input terminal-text text-sm px-3 py-1"
            >
              <option value="none">No filter</option>
              <option value="All teams">All teams only</option>
              {scenarioTeams.map((t) => (
                <option key={t.team_name} value={t.team_name}>
                  {t.team_name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div
          ref={sessionContentRef}
          className="grid grid-cols-1 md:grid-cols-2 gap-6"
          tabIndex={-1}
        >
          {/* Row 1: Incidents Card */}
          {id && (
            <div
              className="military-border p-6 bg-robotic-gray-300 relative cursor-pointer overflow-visible flex flex-col h-[750px]"
              onClick={() => markCardViewed('incidents')}
            >
              <div className="flex items-center justify-between mb-4 flex-shrink-0">
                <h3 className="text-lg terminal-text uppercase">[INCIDENTS]</h3>
                {cardNotifications['incidents'] === 'new' && (
                  <div className="w-3 h-3 bg-robotic-green rounded-full"></div>
                )}
                {cardNotifications['incidents'] === 'viewed' && (
                  <div className="w-3 h-3 bg-robotic-yellow rounded-full"></div>
                )}
              </div>
              <div className="flex-1 overflow-y-auto min-h-0" onClick={(e) => e.stopPropagation()}>
                <IncidentsPanel
                  sessionId={id}
                  selectedIncidentId={selectedIncidentId}
                  onIncidentSelect={(incidentId) => setSelectedIncidentId(incidentId)}
                  isTrainer={isTrainer}
                  filterTeam={filterTeam}
                  onRespondWithAction={handleRespondWithAction}
                />
              </div>
            </div>
          )}

          {/* Media Card */}
          {id && (
            <div
              className="military-border p-6 bg-robotic-gray-300 relative cursor-pointer overflow-visible flex flex-col h-[750px]"
              onClick={() => markCardViewed('media')}
            >
              <div className="flex items-center justify-between mb-4 flex-shrink-0">
                <h3 className="text-lg terminal-text uppercase">[MEDIA]</h3>
                {cardNotifications['media'] === 'new' && (
                  <div className="w-3 h-3 bg-robotic-green rounded-full"></div>
                )}
                {cardNotifications['media'] === 'viewed' && (
                  <div className="w-3 h-3 bg-robotic-yellow rounded-full"></div>
                )}
              </div>
              <div className="flex-1 overflow-y-auto min-h-0" onClick={(e) => e.stopPropagation()}>
                <MediaFeed sessionId={id} />
              </div>
            </div>
          )}

          {/* Decisions Card */}
          {id && (
            <div
              className="military-border p-6 bg-robotic-gray-300 relative cursor-pointer overflow-visible flex flex-col h-[750px]"
              onClick={() => markCardViewed('decisions')}
            >
              <div className="flex items-center justify-between mb-4 flex-shrink-0">
                <h3 className="text-lg terminal-text uppercase">[DECISIONS]</h3>
                {cardNotifications['decisions'] === 'new' && (
                  <div className="w-3 h-3 bg-robotic-green rounded-full"></div>
                )}
                {cardNotifications['decisions'] === 'viewed' && (
                  <div className="w-3 h-3 bg-robotic-yellow rounded-full"></div>
                )}
              </div>
              <div className="flex-1 overflow-y-auto min-h-0" onClick={(e) => e.stopPropagation()}>
                <DecisionWorkflow sessionId={id} filterTeam={filterTeam} hideCreateButton />
              </div>
            </div>
          )}

          {/* Chat Card */}
          {id && (
            <div
              className="military-border p-6 bg-robotic-gray-300 relative cursor-pointer overflow-visible flex flex-col h-[750px]"
              onClick={() => markCardViewed('chat')}
            >
              <div className="flex items-center justify-between mb-4 flex-shrink-0">
                <h3 className="text-lg terminal-text uppercase">[CHAT]</h3>
                {cardNotifications['chat'] === 'new' && (
                  <div className="w-3 h-3 bg-robotic-green rounded-full"></div>
                )}
                {cardNotifications['chat'] === 'viewed' && (
                  <div className="w-3 h-3 bg-robotic-yellow rounded-full"></div>
                )}
              </div>
              <div className="flex-1 overflow-y-auto min-h-0" onClick={(e) => e.stopPropagation()}>
                <ChatInterface
                  sessionId={id}
                  onInsiderAsked={() => setLocationsRefreshTrigger((t) => t + 1)}
                />
              </div>
            </div>
          )}

          {/* Injects Card - Trainer only */}
          {id && session.scenarios && session.scenarios.id && isTrainer && (
            <div
              className="military-border p-6 bg-robotic-gray-300 relative cursor-pointer overflow-visible flex flex-col h-[750px]"
              onClick={() => markCardViewed('injects')}
            >
              <div className="flex items-center justify-between mb-4 flex-shrink-0">
                <h3 className="text-lg terminal-text uppercase">[INJECTS]</h3>
                {cardNotifications['injects'] === 'new' && (
                  <div className="w-3 h-3 bg-robotic-green rounded-full"></div>
                )}
                {cardNotifications['injects'] === 'viewed' && (
                  <div className="w-3 h-3 bg-robotic-yellow rounded-full"></div>
                )}
              </div>
              <div className="flex-1 overflow-y-auto min-h-0" onClick={(e) => e.stopPropagation()}>
                <AIInjectSystem sessionId={id} scenarioId={session.scenarios.id} />
              </div>
            </div>
          )}

          {/* Participants Card - Trainer only */}
          {id && session && isTrainer && (
            <div
              className="military-border p-6 bg-robotic-gray-300 relative cursor-pointer overflow-visible flex flex-col h-[750px]"
              onClick={() => markCardViewed('participants')}
            >
              <div className="flex items-center justify-between mb-4 flex-shrink-0">
                <h3 className="text-lg terminal-text uppercase">[PARTICIPANTS]</h3>
                {cardNotifications['participants'] === 'new' && (
                  <div className="w-3 h-3 bg-robotic-green rounded-full"></div>
                )}
                {cardNotifications['participants'] === 'viewed' && (
                  <div className="w-3 h-3 bg-robotic-yellow rounded-full"></div>
                )}
              </div>
              <div className="flex-1 overflow-y-auto min-h-0" onClick={(e) => e.stopPropagation()}>
                <div className="space-y-4">
                  {isTrainer && (
                    <div className="flex justify-between items-center">
                      <span className="text-sm terminal-text text-robotic-yellow/70">
                        [MANAGE_TEAMS]
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowTeamAssignmentModal(true);
                        }}
                        className="military-button px-4 py-2 text-sm"
                      >
                        [MANAGE]
                      </button>
                    </div>
                  )}
                  <ParticipantManagement
                    sessionId={id}
                    participants={(session.participants || []).map((p) => ({
                      ...p,
                      user: p.user
                        ? {
                            id: p.user_id,
                            full_name: p.user.full_name,
                            email: '',
                            role: p.user.role,
                            agency_name: '',
                          }
                        : undefined,
                    }))}
                    onUpdate={loadSession}
                  />
                  {showTeamAssignmentModal && id && (
                    <TeamAssignmentModal
                      sessionId={id}
                      onClose={() => setShowTeamAssignmentModal(false)}
                      onSuccess={() => {
                        loadSession();
                      }}
                    />
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Trainer only: Environmental truths (2 cols), then full map (2 cols), then Timeline last (2 cols × 2 rows) */}
          {id && isTrainer && session?.scenarios?.id && (
            <>
              {/* Environmental truths / conditions - 2 columns width */}
              <div
                className="md:col-span-2 military-border p-6 bg-robotic-gray-300 relative flex flex-col h-[750px]"
                onClick={() => markCardViewed('env_truths')}
              >
                <div className="flex items-center justify-between mb-4 flex-shrink-0">
                  <h3 className="text-lg terminal-text uppercase">
                    [ENVIRONMENTAL TRUTHS] Conditions players are evaluated against
                  </h3>
                </div>
                <div
                  className="flex-1 overflow-y-auto min-h-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  <TrainerEnvironmentalTruths sessionId={id} scenarioId={session.scenarios.id} />
                </div>
              </div>

              {/* Trainer map - 2 columns, always visible, all pins */}
              <div className="md:col-span-2 military-border p-6 bg-robotic-gray-300 flex flex-col h-[calc(100vh-120px)] min-h-[700px]">
                <div className="flex justify-between items-center mb-3 flex-shrink-0">
                  <h3 className="text-lg terminal-text uppercase">
                    [TRAINER MAP] All markings and pins
                  </h3>
                </div>
                <div className="flex-1 min-h-0 rounded border border-robotic-yellow/30 overflow-hidden">
                  <MapView
                    sessionId={id}
                    incidents={[]}
                    resources={[]}
                    isVisible={true}
                    fillHeight
                    showAllPins
                    bypassExitGate
                    locationsRefreshTrigger={locationsRefreshTrigger}
                    sessionStartTime={session?.start_time ?? undefined}
                    currentState={mergeInjectEffects(
                      (session?.current_state as Record<string, unknown>) ?? {},
                      session?.inject_state_effects,
                    )}
                    initialCenter={
                      session?.scenarios?.center_lat != null &&
                      session?.scenarios?.center_lng != null
                        ? ([session.scenarios.center_lat, session.scenarios.center_lng] as [
                            number,
                            number,
                          ])
                        : [1.3521, 103.8198]
                    }
                    initialZoom={16}
                    teamName={isTrainer ? 'Trainer' : myTeams[0]?.team_name}
                    draggableAssets={
                      isTrainer
                        ? [
                            ...Object.values(TEAM_ASSET_CATALOG)
                              .flat()
                              .filter(
                                (a, i, arr) =>
                                  arr.findIndex((b) => b.asset_type === a.asset_type) === i,
                              ),
                            ...UNIVERSAL_ASSETS,
                          ]
                        : myTeams[0]?.team_name
                          ? getAssetsForTeam(myTeams[0].team_name, scenarioEquipment)
                          : []
                    }
                    scenarioType={
                      ((session?.current_state as Record<string, unknown>)
                        ?.scenario_type as string) ?? undefined
                    }
                  />
                </div>
              </div>

              {/* Decisions & AI Ratings - 2 cols, before timeline (completed sessions only) */}
              {session.status === 'completed' && (
                <div
                  className="md:col-span-2 military-border p-6 bg-robotic-gray-300 relative cursor-pointer overflow-visible flex flex-col h-[750px]"
                  onClick={() => markCardViewed('decisions_ai')}
                >
                  <div className="flex items-center justify-between mb-4 flex-shrink-0">
                    <h3 className="text-lg terminal-text uppercase">[DECISIONS & AI RATINGS]</h3>
                    {cardNotifications['decisions_ai'] === 'new' && (
                      <div className="w-3 h-3 bg-robotic-green rounded-full"></div>
                    )}
                    {cardNotifications['decisions_ai'] === 'viewed' && (
                      <div className="w-3 h-3 bg-robotic-yellow rounded-full"></div>
                    )}
                  </div>
                  <div
                    className="flex-1 overflow-y-auto min-h-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <DecisionsAIRatingsPanel sessionId={id} filterTeam={filterTeam} />
                  </div>
                </div>
              )}

              {/* Timeline - 2 cols, fixed height (3 rows), scrollable */}
              <div
                className="md:col-span-2 military-border p-6 bg-robotic-gray-300 relative cursor-pointer flex flex-col h-[750px]"
                onClick={() => markCardViewed('timeline')}
              >
                <div className="flex items-center justify-between mb-4 flex-shrink-0">
                  <h3 className="text-lg terminal-text uppercase">[TIMELINE] Session activity</h3>
                  {cardNotifications['timeline'] === 'new' && (
                    <div className="w-3 h-3 bg-robotic-green rounded-full"></div>
                  )}
                  {cardNotifications['timeline'] === 'viewed' && (
                    <div className="w-3 h-3 bg-robotic-yellow rounded-full"></div>
                  )}
                </div>
                <div
                  className="flex-1 overflow-y-auto min-h-0 space-y-2 text-sm"
                  onClick={(e) => e.stopPropagation()}
                >
                  {session?.status !== 'in_progress' && session?.status !== 'completed' ? (
                    <p className="text-robotic-yellow/70">
                      No activity yet. Session activity (injects, impact matrix, escalation) will
                      appear here when the session is in progress.
                    </p>
                  ) : backendActivities.length === 0 ? (
                    <p className="text-robotic-yellow/70">
                      No activity yet. Injects and impact matrix will appear here.
                    </p>
                  ) : (
                    backendActivities.map((a, i) => (
                      <div
                        key={`${a.type}-${a.at}-${a.step ?? ''}-${i}`}
                        className="border border-robotic-yellow/30 p-2 bg-robotic-gray-300/80 font-mono text-xs"
                      >
                        <span className="text-robotic-yellow/90">
                          {new Date(a.at).toLocaleTimeString()}
                        </span>
                        {' — '}
                        {a.type === 'inject_published' && (
                          <span className="text-robotic-green">
                            Inject published: {a.title ?? '—'}
                          </span>
                        )}
                        {a.type === 'inject_cancelled' && (
                          <span className="text-robotic-yellow">
                            Inject cancelled by AI. Reason: {a.reason ?? '—'}
                          </span>
                        )}
                        {a.type === 'ai_step_start' && (
                          <span className="text-robotic-cyan/90">
                            {a.title ?? `AI: ${a.step ?? 'step'} started`}
                          </span>
                        )}
                        {a.type === 'ai_step_end' && (
                          <div>
                            <span className="text-robotic-green/90">
                              {a.title ?? `AI: ${a.step ?? 'step'} completed`}
                            </span>
                            {a.step === 'evaluating_inject_cancellation' && a.reason && (
                              <div className="mt-1 text-robotic-yellow/80">Reason: {a.reason}</div>
                            )}
                          </div>
                        )}
                        {a.type === 'state_effect_managed' && (
                          <div>
                            <span className="text-robotic-gold">
                              State effect managed{a.summary ? ` (${a.summary})` : ''}
                            </span>
                          </div>
                        )}
                        {a.type === 'escalation_factors_computed' && (
                          <div>
                            <span className="text-robotic-gold">
                              Escalation factors computed ({a.summary ?? '—'})
                            </span>
                            {a.factors && a.factors.length > 0 && (
                              <div className="mt-2 pt-2 border-t border-robotic-yellow/20">
                                <div className="text-robotic-yellow/80 mb-1">
                                  [ESCALATION FACTORS]
                                </div>
                                <ul className="list-disc pl-4 space-y-1 text-robotic-green/90 text-xs break-words">
                                  {a.factors.map((f) => (
                                    <li key={f.id}>
                                      {f.name} ({f.severity}): {f.description}
                                      {(f as { consequence_for_inaction?: boolean })
                                        .consequence_for_inaction && (
                                        <span className="ml-1 text-robotic-yellow/90 text-xs">
                                          [Consequence for inaction]
                                        </span>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {a.de_escalation_factors && a.de_escalation_factors.length > 0 && (
                              <div className="mt-2 pt-2 border-t border-robotic-yellow/20">
                                <div className="text-robotic-yellow/80 mb-1">
                                  [DE-ESCALATION FACTORS]
                                </div>
                                <ul className="list-disc pl-4 space-y-1 text-robotic-green/90 text-xs break-words">
                                  {a.de_escalation_factors.map((f) => (
                                    <li key={f.id}>
                                      {f.name}: {f.description}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        )}
                        {a.type === 'escalation_pathways_computed' && (
                          <div>
                            <span className="text-robotic-gold">
                              Escalation pathways computed ({a.summary ?? '—'})
                            </span>
                            {a.pathways && a.pathways.length > 0 && (
                              <div className="mt-2 pt-2 border-t border-robotic-yellow/20">
                                <div className="text-robotic-yellow/80 mb-1">[PATHWAYS]</div>
                                <ul className="list-disc pl-4 space-y-1 text-robotic-green/90 text-xs break-words">
                                  {a.pathways.map((p) => (
                                    <li key={p.pathway_id}>
                                      {p.trajectory}
                                      {p.trigger_behaviours?.length
                                        ? ` (triggers: ${p.trigger_behaviours.join(', ')})`
                                        : ''}
                                      {(p as { consequence_for_inaction?: boolean })
                                        .consequence_for_inaction && (
                                        <span className="ml-1 text-robotic-yellow/90 text-xs">
                                          [Consequence for inaction]
                                        </span>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {a.de_escalation_pathways && a.de_escalation_pathways.length > 0 && (
                              <div className="mt-2 pt-2 border-t border-robotic-yellow/20">
                                <div className="text-robotic-yellow/80 mb-1">
                                  [DE-ESCALATION PATHWAYS]
                                </div>
                                <ul className="list-disc pl-4 space-y-1 text-robotic-green/90 text-xs break-words">
                                  {a.de_escalation_pathways.map((p) => (
                                    <li key={p.pathway_id}>{p.trajectory}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        )}
                        {a.type === 'impact_matrix_computed' && (
                          <div>
                            <span className="text-robotic-gold">
                              Impact matrix computed ({a.summary ?? '—'})
                              {a.computed_band && (
                                <span className="ml-1 text-robotic-yellow/80 text-xs">
                                  [Band: {a.computed_band}]
                                </span>
                              )}
                            </span>
                            {a.analysis?.overall && (
                              <div className="mt-2 pt-2 border-t border-robotic-yellow/20 break-words">
                                <div className="text-robotic-yellow/80 mb-1">[AI REASONING]</div>
                                <p className="text-robotic-green/90 text-xs whitespace-pre-wrap">
                                  {a.analysis.overall}
                                </p>
                                {a.analysis.matrix_reasoning && (
                                  <p className="text-robotic-green/80 text-xs mt-1 whitespace-pre-wrap">
                                    Matrix: {a.analysis.matrix_reasoning}
                                  </p>
                                )}
                                {a.analysis.robustness_reasoning && (
                                  <p className="text-robotic-green/80 text-xs mt-1 whitespace-pre-wrap">
                                    Robustness: {a.analysis.robustness_reasoning}
                                  </p>
                                )}
                              </div>
                            )}
                            {a.response_taxonomy && Object.keys(a.response_taxonomy).length > 0 && (
                              <div className="mt-2 pt-2 border-t border-robotic-yellow/20">
                                <div className="text-robotic-yellow/80 mb-1">
                                  [RESPONSE TAXONOMY]
                                </div>
                                <div className="flex flex-wrap gap-1">
                                  {Object.entries(a.response_taxonomy).map(([team, cat]) => (
                                    <span
                                      key={team}
                                      className="bg-robotic-gray-400 px-1 rounded text-robotic-green/90"
                                    >
                                      {team}:{' '}
                                      {typeof cat === 'object' ? JSON.stringify(cat) : String(cat)}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                            {a.matrix && Object.keys(a.matrix).length > 0 && (
                              <div className="mt-2 pt-2 border-t border-robotic-yellow/20">
                                <div className="text-robotic-yellow/80 mb-1">
                                  [INTER-TEAM IMPACT -2..+2]
                                </div>
                                <div className="overflow-x-auto space-y-2">
                                  {Object.entries(a.matrix).map(([acting, affectedMap]) => (
                                    <div key={acting} className="text-robotic-green/90">
                                      {Object.entries(affectedMap as Record<string, number>).map(
                                        ([team, score]) => {
                                          const cellReason =
                                            a.analysis?.matrix_cell_reasoning?.[acting]?.[team];
                                          return (
                                            <div
                                              key={`${acting}-${team}`}
                                              className="ml-2 mb-1 border-l-2 border-robotic-yellow/30 pl-2"
                                            >
                                              <span className="font-medium">
                                                {acting} → {team}:{' '}
                                                {typeof score === 'object'
                                                  ? JSON.stringify(score)
                                                  : String(score)}
                                              </span>
                                              {cellReason && (
                                                <p className="text-robotic-green/80 text-xs mt-0.5 italic break-words whitespace-pre-wrap">
                                                  {typeof cellReason === 'object'
                                                    ? JSON.stringify(cellReason)
                                                    : String(cellReason)}
                                                </p>
                                              )}
                                            </div>
                                          );
                                        },
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                            {a.robustness_by_decision &&
                              Object.keys(a.robustness_by_decision).length > 0 && (
                                <div className="mt-2 pt-2 border-t border-robotic-yellow/20">
                                  <div className="text-robotic-yellow/80 mb-1">
                                    [PER-DECISION ROBUSTNESS 1-10]
                                  </div>
                                  <div className="flex flex-wrap gap-1">
                                    {Object.entries(a.robustness_by_decision).map(
                                      ([decId, score]) => {
                                        const dec = backendDecisions.find((d) => d.id === decId);
                                        const label = dec?.title
                                          ? `${dec.title.slice(0, 30)}…`
                                          : `${decId.slice(0, 8)}…`;
                                        return (
                                          <span
                                            key={decId}
                                            className="bg-robotic-gray-400 px-1 rounded break-all text-xs"
                                            title={dec?.title ?? decId}
                                          >
                                            {label}:
                                            {typeof score === 'object'
                                              ? JSON.stringify(score)
                                              : String(score)}
                                          </span>
                                        );
                                      },
                                    )}
                                  </div>
                                </div>
                              )}
                            {a.robustness_by_decision &&
                              Object.keys(a.robustness_by_decision).length > 0 && (
                                <div className="mt-2 pt-2 border-t border-robotic-yellow/20">
                                  <div className="text-robotic-yellow/80 mb-1">
                                    [ROBUSTNESS PROCESS: RAW → CAPPED]
                                  </div>
                                  <ul className="list-none space-y-1.5 text-xs">
                                    {Object.keys(a.robustness_by_decision).map((decId) => {
                                      const cappedScore = a.robustness_by_decision![decId];
                                      const rawScore =
                                        a.analysis?.raw_robustness_by_decision?.[decId];
                                      const capDetail = a.analysis?.robustness_cap_detail?.[decId];
                                      const dec = backendDecisions.find((d) => d.id === decId);
                                      const decLabel = dec?.title ?? `${decId.slice(0, 8)}…`;
                                      return (
                                        <li
                                          key={decId}
                                          className="border-l-2 border-robotic-yellow/30 pl-2 text-robotic-green/90 break-words"
                                        >
                                          <span className="font-mono text-robotic-gray-50">
                                            {decLabel.length > 35
                                              ? `${decLabel.slice(0, 35)}…`
                                              : decLabel}
                                          </span>
                                          {' — raw: '}
                                          {rawScore != null ? String(rawScore) : '—'}
                                          {' → capped (used): '}
                                          {String(cappedScore)}
                                          {capDetail && (
                                            <div className="mt-0.5 text-robotic-yellow/80 italic">
                                              Below standard / mismatch — {capDetail.severity}{' '}
                                              {capDetail.mismatch_kind}.
                                              {capDetail.reason ? ` ${capDetail.reason}` : ''}
                                            </div>
                                          )}
                                        </li>
                                      );
                                    })}
                                  </ul>
                                </div>
                              )}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* AAR - same size as map (h-[700px]), under timeline (completed sessions only) */}
              {session.status === 'completed' && (
                <div
                  className="md:col-span-2 military-border p-6 bg-robotic-gray-300 relative cursor-pointer flex flex-col h-[700px]"
                  onClick={() => markCardViewed('aar')}
                >
                  <div className="flex items-center justify-between mb-4 flex-shrink-0">
                    <h3 className="text-lg terminal-text uppercase">[AAR] After Action Review</h3>
                    {cardNotifications['aar'] === 'new' && (
                      <div className="w-3 h-3 bg-robotic-green rounded-full"></div>
                    )}
                    {cardNotifications['aar'] === 'viewed' && (
                      <div className="w-3 h-3 bg-robotic-yellow rounded-full"></div>
                    )}
                  </div>
                  <div
                    className="flex-1 overflow-y-auto min-h-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <AARDashboard sessionId={id} />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
