import type { Vec2 } from '../evacuation/types';

// ── Team identifiers ──────────────────────────────────────────────────────
export type TeamId = 'evacuation' | 'police' | 'medical' | 'fire' | 'bomb_squad' | 'media' | 'ic';

// ── Unit types per team ───────────────────────────────────────────────────
export type UnitKind =
  | 'marshal'
  | 'police_officer'
  | 'medic'
  | 'paramedic'
  | 'rescue_officer'
  | 'search_dog'
  | 'eod_tech'
  | 'eod_robot'
  | 'press_officer'
  | 'family_liaison';

export interface UnitDef {
  kind: UnitKind;
  team: TeamId;
  label: string;
  speed: number; // m/s
  radius: number; // render radius in meters
  color: string; // base fill color
  abilities: string[];
}

export const UNIT_CATALOG: Record<UnitKind, UnitDef> = {
  marshal: {
    kind: 'marshal',
    team: 'evacuation',
    label: 'Marshal',
    speed: 2.2,
    radius: 0.6,
    color: '#4ade80',
    abilities: ['redirect', 'unfreeze', 'pa_announce'],
  },
  police_officer: {
    kind: 'police_officer',
    team: 'police',
    label: 'Police Officer',
    speed: 2.0,
    radius: 0.6,
    color: '#60a5fa',
    abilities: ['cordon', 'access_control', 'crowd_control', 'redirect', 'close_exit'],
  },
  medic: {
    kind: 'medic',
    team: 'medical',
    label: 'Medic',
    speed: 1.2,
    radius: 0.6,
    color: '#f87171',
    abilities: ['triage', 'treat', 'load', 'retriage', 'screen'],
  },
  paramedic: {
    kind: 'paramedic',
    team: 'medical',
    label: 'Paramedic',
    speed: 1.4,
    radius: 0.6,
    color: '#fb923c',
    abilities: ['triage', 'treat', 'load', 'retriage', 'screen', 'field_triage'],
  },
  rescue_officer: {
    kind: 'rescue_officer',
    team: 'fire',
    label: 'Rescue Officer',
    speed: 1.4,
    radius: 0.7,
    color: '#fbbf24',
    abilities: [
      'structural_assess',
      'search',
      'extract',
      'breach',
      'deploy_ladder',
      'lighting_rig',
    ],
  },
  search_dog: {
    kind: 'search_dog',
    team: 'fire',
    label: 'Search Dog Team',
    speed: 1.8,
    radius: 0.5,
    color: '#d97706',
    abilities: ['enhanced_search'],
  },
  eod_tech: {
    kind: 'eod_tech',
    team: 'bomb_squad',
    label: 'EOD Technician',
    speed: 0.8,
    radius: 0.7,
    color: '#a78bfa',
    abilities: [
      'visual_sweep',
      'investigate',
      'deploy_robot',
      'render_safe',
      'advise',
      'exclusion_zone',
    ],
  },
  eod_robot: {
    kind: 'eod_robot',
    team: 'bomb_squad',
    label: 'EOD Robot',
    speed: 0.3,
    radius: 0.4,
    color: '#7c3aed',
    abilities: ['remote_inspect', 'remote_disrupt', 'approach_device'],
  },
  press_officer: {
    kind: 'press_officer',
    team: 'media',
    label: 'Press Officer',
    speed: 2.0,
    radius: 0.5,
    color: '#e879f9',
    abilities: ['draft_statement', 'briefing', 'media_escort', 'social_monitor'],
  },
  family_liaison: {
    kind: 'family_liaison',
    team: 'media',
    label: 'Family Liaison',
    speed: 2.0,
    radius: 0.5,
    color: '#f0abfc',
    abilities: ['staff_frc', 'provide_updates', 'missing_persons'],
  },
};

// ── Equipment types ───────────────────────────────────────────────────────
export type EquipmentKind =
  | 'hard_barrier'
  | 'tape_cordon'
  | 'road_block'
  | 'access_control_point'
  | 'assembly_point'
  | 'directional_sign'
  | 'megaphone'
  | 'ccp_tent'
  | 'treatment_area'
  | 'ambulance_staging'
  | 'minor_injuries_area'
  | 'body_holding_area'
  | 'structural_prop'
  | 'lighting_rig'
  | 'ladder'
  | 'exclusion_zone'
  | 'all_clear_marker'
  | 'blast_blanket'
  | 'media_briefing_point'
  | 'family_reception_centre'
  | 'fcp';

export interface EquipmentDef {
  kind: EquipmentKind;
  team: TeamId;
  label: string;
  placeTime: number; // seconds
  radius: number; // visual radius meters
  color: string;
  isPhysicsBody: boolean;
  icon: string; // unicode/emoji shorthand for canvas
}

export const EQUIPMENT_CATALOG: Record<EquipmentKind, EquipmentDef> = {
  hard_barrier: {
    kind: 'hard_barrier',
    team: 'police',
    label: 'Hard Barrier',
    placeTime: 3,
    radius: 1.5,
    color: '#3b82f6',
    isPhysicsBody: true,
    icon: '▮',
  },
  tape_cordon: {
    kind: 'tape_cordon',
    team: 'police',
    label: 'Tape Cordon',
    placeTime: 1,
    radius: 1.0,
    color: '#93c5fd',
    isPhysicsBody: false,
    icon: '┄',
  },
  road_block: {
    kind: 'road_block',
    team: 'police',
    label: 'Road Block',
    placeTime: 5,
    radius: 2.0,
    color: '#1d4ed8',
    isPhysicsBody: true,
    icon: '⛔',
  },
  access_control_point: {
    kind: 'access_control_point',
    team: 'police',
    label: 'Access Control Point',
    placeTime: 2,
    radius: 1.5,
    color: '#2563eb',
    isPhysicsBody: false,
    icon: '🚧',
  },
  assembly_point: {
    kind: 'assembly_point',
    team: 'evacuation',
    label: 'Assembly Point',
    placeTime: 1,
    radius: 3.0,
    color: '#22c55e',
    isPhysicsBody: false,
    icon: 'A',
  },
  directional_sign: {
    kind: 'directional_sign',
    team: 'evacuation',
    label: 'Directional Sign',
    placeTime: 2,
    radius: 1.0,
    color: '#86efac',
    isPhysicsBody: false,
    icon: '→',
  },
  megaphone: {
    kind: 'megaphone',
    team: 'evacuation',
    label: 'Megaphone/PA',
    placeTime: 1,
    radius: 2.0,
    color: '#4ade80',
    isPhysicsBody: false,
    icon: '📢',
  },
  ccp_tent: {
    kind: 'ccp_tent',
    team: 'medical',
    label: 'CCP Tent',
    placeTime: 10,
    radius: 4.0,
    color: '#ef4444',
    isPhysicsBody: false,
    icon: '⛺',
  },
  treatment_area: {
    kind: 'treatment_area',
    team: 'medical',
    label: 'Treatment Area',
    placeTime: 5,
    radius: 3.0,
    color: '#f87171',
    isPhysicsBody: false,
    icon: '+',
  },
  ambulance_staging: {
    kind: 'ambulance_staging',
    team: 'medical',
    label: 'Ambulance Staging',
    placeTime: 3,
    radius: 3.0,
    color: '#dc2626',
    isPhysicsBody: false,
    icon: '🚑',
  },
  minor_injuries_area: {
    kind: 'minor_injuries_area',
    team: 'medical',
    label: 'Minor Injuries Area',
    placeTime: 3,
    radius: 2.5,
    color: '#fca5a5',
    isPhysicsBody: false,
    icon: '🩹',
  },
  body_holding_area: {
    kind: 'body_holding_area',
    team: 'medical',
    label: 'Body Holding Area',
    placeTime: 5,
    radius: 2.5,
    color: '#991b1b',
    isPhysicsBody: false,
    icon: '✝',
  },
  structural_prop: {
    kind: 'structural_prop',
    team: 'fire',
    label: 'Structural Prop',
    placeTime: 8,
    radius: 1.5,
    color: '#eab308',
    isPhysicsBody: false,
    icon: '⊥',
  },
  lighting_rig: {
    kind: 'lighting_rig',
    team: 'fire',
    label: 'Lighting Rig',
    placeTime: 3,
    radius: 8.0,
    color: '#fef08a',
    isPhysicsBody: false,
    icon: '💡',
  },
  ladder: {
    kind: 'ladder',
    team: 'fire',
    label: 'Ladder',
    placeTime: 5,
    radius: 1.5,
    color: '#ca8a04',
    isPhysicsBody: false,
    icon: '🪜',
  },
  exclusion_zone: {
    kind: 'exclusion_zone',
    team: 'bomb_squad',
    label: 'Exclusion Zone',
    placeTime: 1,
    radius: 10,
    color: '#7c3aed',
    isPhysicsBody: false,
    icon: '⊘',
  },
  all_clear_marker: {
    kind: 'all_clear_marker',
    team: 'bomb_squad',
    label: 'All Clear',
    placeTime: 1,
    radius: 1.5,
    color: '#a78bfa',
    isPhysicsBody: false,
    icon: '✓',
  },
  blast_blanket: {
    kind: 'blast_blanket',
    team: 'bomb_squad',
    label: 'Blast Blanket',
    placeTime: 3,
    radius: 1.5,
    color: '#6d28d9',
    isPhysicsBody: false,
    icon: '▦',
  },
  media_briefing_point: {
    kind: 'media_briefing_point',
    team: 'media',
    label: 'Media Briefing Point',
    placeTime: 3,
    radius: 2.5,
    color: '#e879f9',
    isPhysicsBody: false,
    icon: '🎤',
  },
  family_reception_centre: {
    kind: 'family_reception_centre',
    team: 'media',
    label: 'Family Reception Centre',
    placeTime: 10,
    radius: 4.0,
    color: '#f0abfc',
    isPhysicsBody: false,
    icon: '🏠',
  },
  fcp: {
    kind: 'fcp',
    team: 'ic',
    label: 'Forward Command Post',
    placeTime: 5,
    radius: 3.0,
    color: '#fcd34d',
    isPhysicsBody: false,
    icon: '⚑',
  },
};

// ── Runtime instances ─────────────────────────────────────────────────────
export interface RTSUnit {
  id: string;
  def: UnitDef;
  pos: Vec2;
  waypoints: Vec2[];
  state: 'idle' | 'moving' | 'working';
  workTimer: number;
  selected: boolean;
  placedAt: number; // game-time when spawned
}

export interface RTSEquipment {
  id: string;
  def: EquipmentDef;
  pos: Vec2;
  placedBy: string; // unit id
  placedAt: number; // game-time
  active: boolean;
  orientation?: number; // radians, for directional items
}

// ── Game clock & state ────────────────────────────────────────────────────
export interface GameClock {
  elapsed: number; // seconds since detonation
  speed: number; // multiplier (1 = realtime)
  paused: boolean;
  phase: GamePhase;
}

export type GamePhase =
  | 'setup' // pre-detonation: place building, configure scenario
  | 'phase0' // detonation
  | 'phase1' // command & control
  | 'phase2' // initial assessment
  | 'phase3' // active operations
  | 'phase4' // complications
  | 'phase5'; // resolution

export const PHASE_THRESHOLDS: Record<GamePhase, number> = {
  setup: -1,
  phase0: 0,
  phase1: 0,
  phase2: 120, // T+2:00
  phase3: 300, // T+5:00
  phase4: 900, // T+15:00
  phase5: 1500, // T+25:00
};

export interface HeatMeter {
  value: number; // 0-10 scale
  events: HeatEvent[];
}

export interface HeatEvent {
  time: number;
  delta: number;
  reason: string;
  team: TeamId;
}

// ── Selection state ───────────────────────────────────────────────────────
export interface SelectionState {
  selectedUnitIds: Set<string>;
  selectionBox: { start: Vec2; end: Vec2 } | null;
  hoveredUnitId: string | null;
}

// ── Interaction mode ──────────────────────────────────────────────────────
export type InteractionMode =
  | { type: 'select' }
  | { type: 'spawn_unit'; unitKind: UnitKind }
  | { type: 'place_equipment'; equipmentKind: EquipmentKind }
  | { type: 'place_exit' }
  | { type: 'delete_exit' };

// ── Full game state ───────────────────────────────────────────────────────
export interface RTSGameState {
  clock: GameClock;
  units: RTSUnit[];
  equipment: RTSEquipment[];
  heat: HeatMeter;
  activeTeam: TeamId;
  interactionMode: InteractionMode;
  selection: SelectionState;
  stagingArea: Vec2 | null;
}

// ── Planted items (trainer threats) ────────────────────────────────────
export interface PlantedItem {
  id: string;
  wallPointId: string;
  description: string;
  threatLevel: 'decoy' | 'real_device' | 'secondary_device';
  concealmentDifficulty: 'easy' | 'moderate' | 'hard';
  discovered: boolean;
  assessed: boolean;
  assessmentCorrect: boolean | null;
  aiResponse: string | null;
  detonationTimer: number | null;
}

// ── Casualty clusters (triage mechanic) ───────────────────────────────
export type TriageTag = 'red' | 'yellow' | 'green' | 'black' | 'untagged';

export interface CasualtyVictim {
  id: string;
  label: string;
  trueTag: TriageTag;
  description: string;
  observableSigns: {
    breathing: string;
    pulse: string;
    consciousness: string;
    visibleInjuries: string;
    mobility: string;
    bleeding: string;
  };
  imageUrl: string | null;
  imageGenerating: boolean;
  playerTag: TriageTag;
  taggedAt: number | null;
}

export interface CasualtyCluster {
  id: string;
  pos: Vec2;
  victims: CasualtyVictim[];
  sceneDescription: string;
  imageUrl: string | null;
  imageGenerating: boolean;
  discovered: boolean;
  triageComplete: boolean;
  aiEvaluation: string | null;
}

// ── Interior elements (trainer-placed building internals) ─────────────
export interface InteriorWall {
  id: string;
  start: Vec2;
  end: Vec2;
  hasDoor: boolean;
  doorWidth: number;
  doorPosition: number;
}

export type HazardType =
  | 'combustible'
  | 'chemical'
  | 'structural'
  | 'fire'
  | 'electrical'
  | 'debris'
  | 'smoke';

export interface HazardZone {
  id: string;
  pos: Vec2;
  radius: number;
  hazardType: HazardType;
  severity: 'low' | 'medium' | 'high';
  label: string;
}

export interface Stairwell {
  id: string;
  pos: Vec2;
  connectsFloors: [number, number];
  blocked: boolean;
  label: string;
}

export const HAZARD_DEFS: Record<HazardType, { label: string; color: string; icon: string }> = {
  combustible: { label: 'Combustible', color: '#f97316', icon: '🔥' },
  chemical: { label: 'Chemical', color: '#a855f7', icon: '☣' },
  structural: { label: 'Structural Weakness', color: '#eab308', icon: '⚠' },
  fire: { label: 'Active Fire', color: '#ef4444', icon: '🔥' },
  electrical: { label: 'Electrical', color: '#3b82f6', icon: '⚡' },
  debris: { label: 'Debris / Collapse', color: '#78716c', icon: '🧱' },
  smoke: { label: 'Smoke / Low Vis', color: '#6b7280', icon: '🌫' },
};

export function createInitialGameState(): RTSGameState {
  return {
    clock: { elapsed: 0, speed: 1, paused: true, phase: 'setup' },
    units: [],
    equipment: [],
    heat: { value: 5, events: [] },
    activeTeam: 'ic',
    interactionMode: { type: 'select' },
    selection: { selectedUnitIds: new Set(), selectionBox: null, hoveredUnitId: null },
    stagingArea: null,
  };
}
