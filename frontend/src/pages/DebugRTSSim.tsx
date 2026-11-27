import React, { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  MapContainer,
  TileLayer,
  Polygon,
  Circle,
  CircleMarker,
  useMapEvents,
  useMap,
} from 'react-leaflet';
import L from 'leaflet';
import { supabase } from '../lib/supabase';
import { PolygonEvacuationEngine } from '../lib/evacuation/engine';
import type { PedSnapshot, ShowcaseMetrics, StairFlightView } from '../lib/evacuation/engine';
import type { ExitDef, PolygonSimConfig, Vec2, ZoneKind } from '../lib/evacuation/types';
import {
  HazardField,
  MOUTH_APPROACH_M,
  assemblyMinDistanceM,
  distanceToOutline,
} from '../lib/evacuation/hazardSensing';
import { stepDoorLeaves } from '../lib/rts/doorLeaf';
import { snapWallPoint } from '../lib/rts/wallSnap';
import { SHOWCASE, SHOWCASE_SOURCES } from '../lib/evacuation/showcaseConstants';
import { blastEffectsTriggerSec, countdownLabel, shiftEvents } from '../lib/evacuation/showcase';
import { DEFAULT_POLYGON_CONFIG } from '../lib/evacuation/types';
import {
  projectPolygon,
  nearestEdge,
  edgeLength,
  isInsidePolygon,
} from '../lib/evacuation/geometry';
import { LEVEL } from '../lib/evacuation/levelConstants';
import {
  defaultLevels,
  effectiveLevelPlan,
  levelOf,
  linkLevels,
  normaliseStairwell,
  sortLevels,
} from '../lib/rts/levels';
import { generateSceneStuds, projectSceneStuds, type SceneCoverPoint } from '../lib/rts/sceneStuds';
import {
  HOLLAND_VILLAGE_OSM_ID,
  footprintSessionNote,
  levelsForFootprint,
  type OsmBuildingFootprint,
} from '../lib/rts/footprintLevels';
import { HOLLAND_BOMB, layoutHawkerCentre, type LayoutLabel } from '../lib/rts/hawkerLayout';
import { EMPTY_HAWKER_FACTS, type HawkerFacts } from '@shared/hawkerFacts';
import { RTSEngine } from '../lib/rts/engine';
import {
  SHOWCASE_LEGEND_LINES,
  computeMapRenderContext,
  renderRTS,
  toSim as rcToSim,
} from '../lib/rts/renderer';
import type { PlacedObjectDraw } from '../lib/rts/renderer';
import type { RenderContext } from '../lib/rts/renderer';
import { BLAST_DATASET } from '../lib/rts/blast/blastDataset';
import {
  clampCharge,
  computeBlastRings,
  defaultCharge,
  type BlastRings,
  type ChargeSpec,
} from '../lib/rts/blast/blastModel';
import { readStoredBlast, writeStoredBlast } from '../lib/rts/blast/blastSiteRecord';
import {
  FX,
  noteDowngradeFrom,
  shouldAutoDowngrade,
  type FxQuality,
} from '../lib/rts/fx/fxConstants';
import {
  advanceGameFrame,
  cappedFrameDt,
  createSharedClock,
  createSpeedMeter,
  noteFrameSpeed,
  resetSharedClock,
  speedLabel,
} from '../lib/rts/fx/simClock';
import {
  activeRasterLayout,
  createRasterLayoutCache,
  type RasterLayout,
} from '../lib/rts/fx/hazardRaster';
import { HazardFxRenderer, type HazardFxContext } from '../lib/rts/fx/drawHazardFx';
import {
  UNIT_CATALOG,
  EQUIPMENT_CATALOG,
  type UnitKind,
  type EquipmentKind,
  type TeamId,
  type PlantedItem,
  type CasualtyCluster,
  type CasualtyPin,
  type InteriorWall,
  type HazardZone,
  type HazardType,
  type Stairwell,
  type LevelDef,
  HAZARD_DEFS,
} from '../lib/rts/types';
import {
  loadSavedMaps,
  saveMap,
  deleteSavedMap,
  generateMapId,
  type SavedMap,
} from '../lib/rts/savedMaps';
import {
  generateWallPoints,
  fetchStreetViewImage,
  type WallInspectionPoint,
} from '../lib/rts/wallInspection';
import { generateSingleCasualty } from '../lib/rts/casualtyPresets';
import { DEFAULT_FIRE_PARAMS, type FireParams } from '../lib/rts/fireSimulation';
import {
  COMMON_PICKS,
  MATERIAL_LIBRARY,
  absorbLegacyFuelCircles,
  confirmedFuelCells,
  entryById,
  entryCanBurn,
  matchFromEntry,
  matchMaterials,
  snapObjectsToStuds,
  suggestLibraryEntry,
  type PlacedObject,
} from '../lib/rts/materialLibrary';
import { foodCourtPlacedObjects, foodCourtSample } from '../lib/rts/foodCourtSample';
import { harbourHouseFuelObjects, harbourHouseSample } from '../lib/rts/harbourHouseShowcase';
import { smokeCorridorFuelObjects, smokeCorridorSample } from '../lib/rts/smokeCorridorTest';
import {
  stairShaftFuelObjects,
  stairShaftSample,
  stairShaftStuds,
} from '../lib/rts/stairShaftTest';
import {
  officeTowerFuelObjects,
  officeTowerSample,
  officeTowerStuds,
} from '../lib/rts/officeTowerFire';
import {
  SpatialEffectsEngine,
  blastSmokeStudIds,
  type StudEffectState,
  type HazardPhase,
  type HazardEvent,
  type SmokeLayerView,
} from '../lib/rts/spatialEffects';
import { attachBuilding, storeyId } from '../lib/rts/effectsBuilding';
import {
  blastIgnitionZone,
  hazardsForEffects,
  runEffectsPreviewAsync,
  syncIgnition,
} from '../lib/rts/effectsPreview';
import { HOOD_FAN_WHEN, windTerrainFactor, type HoodFanWhen } from '../lib/rts/twoZone';
import {
  createSceneConfig,
  loadSceneConfig,
  updateSceneConfig,
  listSceneConfigs,
  deleteSceneConfig,
  type SceneConfigSummary,
} from '../lib/rts/sceneConfigApi';
import 'leaflet/dist/leaflet.css';

const GOOGLE_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

function placementCover(
  blast: { x: number; y: number } | null,
  radiusM: number,
  zones: readonly { pos: { x: number; y: number }; radius: number }[],
  objects: readonly { pos: { x: number; y: number } }[],
): SceneCoverPoint[] {
  const points: SceneCoverPoint[] = [];
  if (blast) points.push({ x: blast.x, y: blast.y, radiusM });
  for (const zone of zones) points.push({ x: zone.pos.x, y: zone.pos.y, radiusM: zone.radius });
  for (const object of objects) points.push({ x: object.pos.x, y: object.pos.y });
  return points;
}

function makeLevel(id: string, people = 0): LevelDef {
  const basement = id.startsWith('B');
  return {
    id,
    name: id === 'G' ? 'Ground' : basement ? `Basement ${id.slice(1)}` : `Level ${id.slice(1)}`,
    index: id === 'G' ? 0 : basement ? -Number(id.slice(1)) : Number(id.slice(1)),
    heightM: basement ? LEVEL.DEFAULT_BASEMENT_HEIGHT_M : LEVEL.DEFAULT_STOREY_HEIGHT_M,
    designed: true,
    pedestrianCount: people,
  };
}

function readShowcaseSettings(params: URLSearchParams): {
  showcase: boolean;
  afterExit: 'zone' | 'disperse' | 'mixed';
} {
  let stored: { showcase?: boolean; afterExit?: string } = {};
  try {
    const raw = localStorage.getItem('rtsShowcaseSettings');
    if (raw) stored = JSON.parse(raw) as { showcase?: boolean; afterExit?: string };
  } catch {
    stored = {};
  }
  const afterExit =
    stored.afterExit === 'disperse' || stored.afterExit === 'mixed' || stored.afterExit === 'zone'
      ? stored.afterExit
      : 'zone';
  const showcase = params.has('showcase')
    ? params.get('showcase') === '1'
    : Boolean(stored.showcase);
  return { showcase, afterExit };
}

function roundTenth(metres: number): number {
  return Math.round(metres * 10) / 10;
}

function chargeTooltip(spec: ChargeSpec, notes: string[]): string {
  const preset = BLAST_DATASET.presets.find((p) => p.key === spec.presetKey);
  const lines = BLAST_DATASET.criteria.map((row) => {
    const metric = row.metric === 'incident' ? 'Ps' : 'Ps+q';
    return `${row.key}: ${row.thresholdKpa.value} kPa, ${metric}, ${row.thresholdKpa.ref}`;
  });
  if (preset) {
    lines.push(
      `TNT pressure factor ${preset.tntEqPressure.value} (${preset.tntEqPressure.confidence}), ${preset.tntEqPressure.ref}`,
    );
    lines.push(
      `TNT impulse factor ${preset.tntEqImpulse.value} (${preset.tntEqImpulse.confidence}), ${preset.tntEqImpulse.ref}`,
    );
  }
  if (notes.length > 0) lines.push(notes.join('; '));
  return lines.join('\n');
}

function showcaseInjuryRings(
  pos: Vec2,
  manual: boolean,
  radius: number,
  rings: BlastRings,
  faint: boolean,
) {
  if (manual) {
    return {
      pos,
      lethalM: roundTenth(radius * SHOWCASE.LETHAL_RING_FRACTION),
      seriousM: roundTenth(radius * SHOWCASE.SERIOUS_RING_FRACTION),
      minorM: roundTenth(radius * SHOWCASE.MINOR_RING_FRACTION),
      glassInjuryM: null,
      glassBreakageM: null,
      faint,
    };
  }
  return {
    pos,
    lethalM: roundTenth(rings.lethalM),
    seriousM: roundTenth(rings.seriousM),
    minorM: roundTenth(rings.minorM),
    glassInjuryM: roundTenth(rings.glassInjuryM),
    glassBreakageM: roundTenth(rings.glassBreakageM),
    faint,
  };
}

function readFxQuality(): FxQuality {
  try {
    const value = localStorage.getItem('rtsFxQuality');
    if (value === 'high' || value === 'low' || value === 'classic') return value;
  } catch {
    /* private mode */
  }
  return 'high';
}

function aboveGroundHeightM(floors: string[] | undefined): number {
  const list = floors && floors.length > 0 ? floors : ['G'];
  const n = list.filter((f) => {
    const id = f === 'Ground' ? 'G' : f;
    return id === 'G' || id.startsWith('L');
  }).length;
  return Math.max(1, n) * SHOWCASE.BUILDING_STOREY_HEIGHT_M;
}

const ASSUMED_VALUE_TOOLTIP = Object.entries(SHOWCASE_SOURCES)
  .filter(([, source]) => source.status === 'assumed')
  .map(([key, source]) => `${key}: ${source.ref}`)
  .join('\n');

// ── API helpers ─────────────────────────────────────────────────────────
const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
function apiUrl(path: string): string {
  return API_BASE ? `${API_BASE}${path}` : path;
}
async function getAuthHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    Authorization: session ? `Bearer ${session.access_token}` : '',
  };
}

// ── Feature flags (set to true to re-enable hidden UI) ──────────────────
/** Screen pixels a right-press must travel before it pans instead of ordering a move. */
const PAN_THRESHOLD_PX = 5;
/**
 * Deepest map zoom. At 22 a 60 m building is about 1600 px wide, so on a
 * 2560–3840 px focus pane it could not get past 40–60% of the width; 24 lets
 * a building fill any pane. Tiles stop at 19 and are scaled up past it.
 */
const MAX_MAP_ZOOM = 24;
/** Room under a pane's level chip, top-right, for anything else in that corner. */
const LEVEL_CHIP_CLEARANCE_PX = 44;

type PaneCount = 1 | 2 | 4;
interface PaneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Equal cells, primary first: side by side for two (stacked in portrait), 2×2 for four. */
function layoutPanes(count: PaneCount, w: number, h: number, portrait: boolean): PaneRect[] {
  const cols = count === 4 ? 2 : count === 2 && !portrait ? 2 : 1;
  const rows = count === 4 ? 2 : count === 2 && portrait ? 2 : 1;
  const rects: PaneRect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = Math.round((c * w) / cols);
      const y = Math.round((r * h) / rows);
      rects.push({
        x,
        y,
        w: Math.round(((c + 1) * w) / cols) - x,
        h: Math.round(((r + 1) * h) / rows) - y,
      });
    }
  }
  return rects;
}

/** Levels for panes 2..n: the other storeys lowest first, then every storey again in turn. */
function defaultPaneLevels(count: PaneCount, levelIds: string[], active: string): string[] {
  const all = sortLevels(levelIds);
  const others = all.filter((id) => id !== active);
  return Array.from({ length: count - 1 }, (_, i) =>
    i < others.length ? others[i] : all[(i - others.length) % all.length],
  );
}

function levelSummary(
  levelId: string,
  studs: Array<{ id: string; floor: string }>,
  effectStates: Map<string, StudEffectState> | null,
  pedestrians: PedSnapshot[],
): { remaining: number; burning: number; meanSmoke: number } {
  const floorStuds = studs.filter((s) => storeyId(s.floor) === levelId);
  let burning = 0;
  let smoke = 0;
  for (const s of floorStuds) {
    const st = effectStates?.get(s.id);
    if (!st) continue;
    if (st.fire.state === 'burning') burning += 1;
    smoke += st.smoke;
  }
  const remaining = pedestrians.filter(
    (p) =>
      (p.level ?? 'G') === levelId &&
      (p.state === 'idle' ||
        p.state === 'reacting' ||
        p.state === 'evacuating' ||
        (!p.state && !p.evacuated)),
  ).length;
  return { remaining, burning, meanSmoke: floorStuds.length > 0 ? smoke / floorStuds.length : 0 };
}

/** What the render loop needs from a secondary level pane. */
interface PaneHandle {
  map: L.Map | null;
  canvas: HTMLCanvasElement | null;
  level: string;
  fx: HazardFxRenderer | null;
  fxCtx: HazardFxContext | null;
}

const ENABLE_CASUALTY_PLACEMENT = false;
const ENABLE_AI_ENRICHMENT = false;
const ENABLE_MICROSOFT_FOOTPRINT = false;

// ── Client-side stud generation for drawn/loaded buildings ──────────────
function generateStudsForPolygon(
  polygon: [number, number][],
  _spacingM: number,
  buildingIndex: number,
): StudPoint[] {
  return generateSceneStuds(polygon, buildingIndex, ['G']);
}

// ── OSM types ───────────────────────────────────────────────────────────
interface StudPoint {
  id: string;
  lat: number;
  lng: number;
  floor: string;
  studType: 'building' | 'outdoor' | 'street';
  blastBand: string | null;
  operationalZone: string | null;
  distFromIncidentM: number | null;
  spatialContext: 'inside_building' | 'road' | 'open_air' | null;
}
interface SimStud extends StudPoint {
  simPos: Vec2;
}

function fuelCellsFor(objects: readonly PlacedObject[], studs: readonly SimStud[]) {
  return confirmedFuelCells(
    objects,
    studs.map((stud) => ({
      id: stud.id,
      simPos: stud.simPos,
      level: storeyId(stud.floor),
      spatialContext: stud.spatialContext,
    })),
  );
}

function objectsOnStuds(
  polygon: [number, number][],
  studs: StudPoint[],
  objects: PlacedObject[],
): PlacedObject[] {
  return snapObjectsToStuds(
    objects,
    projectSceneStuds(polygon, studs).map((stud) => ({
      id: stud.id,
      simPos: stud.simPos,
      level: stud.floor,
    })),
  );
}

function placedObjectDraws(objects: readonly PlacedObject[]): PlacedObjectDraw[] {
  const draws = objects.map((obj): PlacedObjectDraw => ({
    id: obj.id,
    pos: obj.pos,
    level: obj.level,
    confirmed: obj.confirmed,
    burns: obj.confirmed && obj.matches.some((match) => entryCanBurn(match.fuel)),
    label: obj.confirmed
      ? obj.matches.map((match) => match.label).join(', ') || 'Object'
      : obj.description || 'Unconfirmed',
  }));
  const confirmed = draws.filter((draw) => draw.confirmed).length;
  if (confirmed <= 40) return draws;
  return draws.map((draw) => (draw.confirmed ? { ...draw, label: '' } : draw));
}
interface GridItem {
  buildingIndex: number;
  buildingName: string | null;
  polygon: [number, number][];
  floors: string[];
  spacingM: number;
  studs: StudPoint[];
}
interface BuildingSummary {
  name: string | null;
  lat: number;
  lng: number;
  levels: number | null;
  use: string | null;
  polygonPoints: number;
}
interface FetchResult {
  grids: GridItem[];
  buildings: BuildingSummary[];
}

// ── Leaflet helpers ─────────────────────────────────────────────────────
function ClickHandler({ onClick }: { onClick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function MapRefSync({ onMap }: { onMap: (map: L.Map) => void }) {
  const map = useMap();
  useEffect(() => {
    onMap(map);
  }, [map, onMap]);
  return null;
}

function FitBounds({ polygon }: { polygon: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (polygon.length < 3) return;
    const latlngs = polygon.map(([la, ln]) => [la, ln] as [number, number]);
    const leafletBounds = L.latLngBounds(latlngs);
    map.fitBounds(leafletBounds, { padding: [120, 120], maxZoom: MAX_MAP_ZOOM });
  }, [map, polygon]);
  return null;
}

let exitIdCounter = 0;
type PagePhase = 'map' | 'rts';

// ── Team palette data ───────────────────────────────────────────────────
const TEAM_UNITS: Record<TeamId, UnitKind[]> = {
  ic: [],
  evacuation: ['marshal'],
  police: ['police_officer'],
  medical: ['medic', 'paramedic'],
  fire: ['rescue_officer', 'search_dog'],
  bomb_squad: ['eod_tech'],
  media: ['press_officer', 'family_liaison'],
};

const TEAM_EQUIPMENT: Record<TeamId, EquipmentKind[]> = {
  ic: ['fcp'],
  evacuation: ['assembly_point', 'directional_sign', 'megaphone'],
  police: ['hard_barrier', 'tape_cordon', 'road_block', 'access_control_point'],
  medical: [
    'ccp_tent',
    'treatment_area',
    'ambulance_staging',
    'minor_injuries_area',
    'body_holding_area',
  ],
  fire: ['structural_prop', 'lighting_rig', 'ladder'],
  bomb_squad: ['exclusion_zone', 'all_clear_marker', 'blast_blanket'],
  media: ['media_briefing_point', 'family_reception_centre'],
};

const TEAM_COLORS: Record<TeamId, string> = {
  ic: '#fcd34d',
  evacuation: '#4ade80',
  police: '#60a5fa',
  medical: '#f87171',
  fire: '#fbbf24',
  bomb_squad: '#a78bfa',
  media: '#e879f9',
};

const TEAM_LABELS: Record<TeamId, string> = {
  ic: 'Incident Commander',
  evacuation: 'Evacuation',
  police: 'Police / Cordon',
  medical: 'Triage / Medical',
  fire: 'Fire / Rescue',
  bomb_squad: 'Bomb Squad / EOD',
  media: 'Media / Comms',
};

const ALL_TEAMS: TeamId[] = [
  'ic',
  'evacuation',
  'police',
  'medical',
  'fire',
  'bomb_squad',
  'media',
];

// =====================================================================
// Main component
// =====================================================================
function useIsPortrait() {
  const [portrait, setPortrait] = useState(
    () => typeof window !== 'undefined' && window.innerHeight > window.innerWidth * 1.1,
  );
  useEffect(() => {
    const check = () => setPortrait(window.innerHeight > window.innerWidth * 1.1);
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
    return () => {
      window.removeEventListener('resize', check);
      window.removeEventListener('orientationchange', check);
    };
  }, []);
  return portrait;
}

export function DebugRTSSim() {
  const isPortrait = useIsPortrait();
  const [searchParams] = useSearchParams();
  const isWarroomMode = searchParams.get('warroom') === '1';
  const warroomLat = searchParams.get('lat');
  const warroomLng = searchParams.get('lng');
  const warroomDraftId = searchParams.get('draftId');
  // warroomSceneId available via searchParams.get('sceneId') if needed

  // ── Map state ─────────────────────────────────────────────────────────
  const [lat, setLat] = useState(warroomLat || '');
  const [lng, setLng] = useState(warroomLng || '');
  const [radius, setRadius] = useState('500');
  const [loading, setLoading] = useState(false);
  const [fetchResult, setFetchResult] = useState<FetchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedGridIdx, setSelectedGridIdx] = useState<number | null>(null);
  const [phase, setPhase] = useState<PagePhase>('map');

  // ── User geolocation (for map centering + search bias) ────────────────
  const [userGeoPos, setUserGeoPos] = useState<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    // Skip auto-geolocate if warroom provided coordinates
    if (warroomLat && warroomLng) {
      setUserGeoPos({ lat: parseFloat(warroomLat), lng: parseFloat(warroomLng) });
      return;
    }
    if (!navigator.geolocation) {
      setLat('1.2989008');
      setLng('103.855176');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const gLat = pos.coords.latitude;
        const gLng = pos.coords.longitude;
        setUserGeoPos({ lat: gLat, lng: gLng });
        setLat(gLat.toFixed(7));
        setLng(gLng.toFixed(7));
        const map = leafletMapRef.current;
        if (map) map.setView([gLat, gLng], 18);
        // Detect country from GPS
        fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${gLat}&lon=${gLng}&format=json&zoom=3`,
          { headers: { 'User-Agent': 'Prophyion/1.0' } },
        )
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (d?.address?.country_code) setSearchCountry(d.address.country_code.toUpperCase());
          })
          .catch(() => {});
      },
      () => {
        setLat('1.2989008');
        setLng('103.855176');
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
    );
  }, []);

  // ── Leaflet map ref ───────────────────────────────────────────────────
  const leafletMapRef = useRef<L.Map | null>(null);
  const setLeafletMap = useCallback((map: L.Map) => {
    leafletMapRef.current = map;
  }, []);

  // ── RTS state ─────────────────────────────────────────────────────────
  const rtsRef = useRef<RTSEngine>(new RTSEngine());
  const evacEngRef = useRef<PolygonEvacuationEngine | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const lastTimeRef = useRef(0);
  const renderCtxRef = useRef<RenderContext | null>(null);

  const [exits, setExits] = useState<ExitDef[]>([]);
  const [pedestrians, setPedestrians] = useState<PedSnapshot[]>([]);
  const [_, forceRender] = useState(0);
  const rerender = useCallback(() => forceRender((n) => n + 1), []);

  const [pedestrianCount, setPedestrianCount] = useState(120);
  const [newExitWidth, setNewExitWidth] = useState(3);
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 });

  // ── Split level view ──────────────────────────────────────────────────
  const [paneCount, setPaneCount] = useState<PaneCount>(1);
  const [paneLevels, setPaneLevels] = useState<string[]>([]);
  const [panesLinked, setPanesLinked] = useState(true);
  const panesLinkedRef = useRef(panesLinked);
  panesLinkedRef.current = panesLinked;
  const panesRef = useRef(new Map<number, PaneHandle>());
  const registerPane = useCallback((index: number, patch: Partial<PaneHandle> | null) => {
    const panes = panesRef.current;
    if (patch === null) {
      panes.get(index)?.fx?.dispose();
      panes.delete(index);
      return;
    }
    const pane = panes.get(index) ?? { map: null, canvas: null, level: 'G', fx: null, fxCtx: null };
    panes.set(index, { ...pane, ...patch });
  }, []);
  const setPaneLevel = useCallback((index: number, id: string) => {
    setPaneLevels((prev) => {
      const next = [...prev];
      next[index - 1] = id;
      return next;
    });
  }, []);
  const panPane = useCallback((map: L.Map, dx: number, dy: number) => {
    const target = panesLinkedRef.current ? (leafletMapRef.current ?? map) : map;
    target.panBy([dx, dy], { animate: false });
  }, []);
  const zoomPane = useCallback((map: L.Map, point: L.Point, delta: number) => {
    const target = panesLinkedRef.current ? (leafletMapRef.current ?? map) : map;
    const zoom = Math.min(
      target.getMaxZoom(),
      Math.max(target.getMinZoom(), target.getZoom() + delta),
    );
    target.setZoomAround(point, zoom);
  }, []);

  // ── Layout: collapsible panels and the floating levels box ────────────
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [levelsBoxOpen, setLevelsBoxOpen] = useState(true);
  const focusMode = !leftPanelOpen && !rightPanelOpen && !levelsBoxOpen;
  const toggleFocusMode = useCallback(() => {
    const open = focusMode;
    setLeftPanelOpen(open);
    setRightPanelOpen(open);
    setLevelsBoxOpen(open);
  }, [focusMode]);

  // ── Saved maps ────────────────────────────────────────────────────────
  const [savedMaps, setSavedMaps] = useState<SavedMap[]>(() => loadSavedMaps());
  const [saveMapName, setSaveMapName] = useState('');

  // ── Scene config (DB persistence) ─────────────────────────────────────
  const [sceneConfigId, setSceneConfigId] = useState<string | null>(null);
  const [dbScenes, setDbScenes] = useState<SceneConfigSummary[]>([]);
  const [savingScene, setSavingScene] = useState(false);
  const [liveOnly, setLiveOnly] = useState(false);
  const [liveNote, setLiveNote] = useState<string | null>(null);
  const [layoutLabels, setLayoutLabels] = useState<LayoutLabel[]>([]);
  const [hollandLoading, setHollandLoading] = useState(false);
  const [hollandError, setHollandError] = useState<string | null>(null);

  // ── Place search (Nominatim) ──────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<
    Array<{ lat: string; lon: string; display_name: string }>
  >([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchCountry, setSearchCountry] = useState('');
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(null);

  // ── Wall inspection ───────────────────────────────────────────────────
  const [wallPoints, setWallPoints] = useState<WallInspectionPoint[]>([]);
  const [activeWallPoint, setActiveWallPoint] = useState<WallInspectionPoint | null>(null);
  const [wallPointImage, setWallPointImage] = useState<string | null>(null);
  const [wallPointLoading, setWallPointLoading] = useState(false);
  const [assessmentText, setAssessmentText] = useState('');
  const [assessmentLoading, setAssessmentLoading] = useState(false);
  const [aiResponse, setAiResponse] = useState<string | null>(null);

  // ── Planted items (trainer threats) ───────────────────────────────────
  const [plantedItems, setPlantedItems] = useState<PlantedItem[]>([]);
  const [plantDescription, setPlantDescription] = useState('');
  const [plantThreatLevel, setPlantThreatLevel] =
    useState<PlantedItem['threatLevel']>('real_device');
  const [plantDifficulty, setPlantDifficulty] =
    useState<PlantedItem['concealmentDifficulty']>('moderate');
  const [isTrainerMode, setIsTrainerMode] = useState(true);

  // ── Casualty pins ────────────────────────────────────────────────────
  const [casualtyPins, setCasualtyPins] = useState<CasualtyPin[]>([]);
  const [activeCasualtyPin, setActiveCasualtyPin] = useState<CasualtyPin | null>(null);

  // ── Draw building tool ─────────────────────────────────────────────────
  const [drawingBuilding, setDrawingBuilding] = useState(false);
  const [drawnVertices, setDrawnVertices] = useState<[number, number][]>([]);
  const [drawnBuildingName, setDrawnBuildingName] = useState('Custom Building');
  const [redrawIndex, setRedrawIndex] = useState<number | null>(null);

  const handleDrawMapClick = useCallback(
    (clickLat: number, clickLng: number) => {
      if (!drawingBuilding) return;
      setDrawnVertices((prev) => [...prev, [clickLat, clickLng]]);
    },
    [drawingBuilding],
  );

  const handleFinishDrawing = useCallback(() => {
    if (drawnVertices.length < 3) return;
    setLiveOnly(false);
    setLiveNote(null);
    setLayoutLabels([]);

    const polygon = drawnVertices;
    let cLat = 0,
      cLng = 0;
    for (const [la, ln] of polygon) {
      cLat += la;
      cLng += ln;
    }
    cLat /= polygon.length;
    cLng /= polygon.length;

    if (redrawIndex != null && fetchResult) {
      const existingGrid = fetchResult.grids[redrawIndex];
      const updatedGrids = [...fetchResult.grids];
      updatedGrids[redrawIndex] = {
        ...existingGrid,
        polygon,
        buildingName: drawnBuildingName || existingGrid.buildingName,
        studs: generateStudsForPolygon(polygon, 5, existingGrid.buildingIndex),
      };
      const updatedBuildings = [...fetchResult.buildings];
      if (updatedBuildings[redrawIndex]) {
        updatedBuildings[redrawIndex] = {
          ...updatedBuildings[redrawIndex],
          lat: cLat,
          lng: cLng,
          polygonPoints: polygon.length,
          name: drawnBuildingName || updatedBuildings[redrawIndex].name,
        };
      }
      setFetchResult({ grids: updatedGrids, buildings: updatedBuildings });
    } else {
      const bIdx = fetchResult ? fetchResult.grids.length : 0;
      const newGrid: GridItem = {
        buildingIndex: bIdx,
        buildingName: drawnBuildingName || 'Custom Building',
        polygon,
        floors: ['Ground'],
        spacingM: 5,
        studs: generateStudsForPolygon(polygon, 5, bIdx),
      };
      const newBuilding: BuildingSummary = {
        name: drawnBuildingName || 'Custom Building',
        lat: cLat,
        lng: cLng,
        levels: 1,
        use: 'custom',
        polygonPoints: polygon.length,
      };
      if (fetchResult) {
        setFetchResult({
          grids: [...fetchResult.grids, newGrid],
          buildings: [...fetchResult.buildings, newBuilding],
        });
      } else {
        setFetchResult({ grids: [newGrid], buildings: [newBuilding] });
      }
    }

    setDrawingBuilding(false);
    setDrawnVertices([]);
    setRedrawIndex(null);
  }, [drawnVertices, drawnBuildingName, fetchResult, redrawIndex]);

  const handleCancelDrawing = useCallback(() => {
    setDrawingBuilding(false);
    setDrawnVertices([]);
    setRedrawIndex(null);
  }, []);

  const handleUndoVertex = useCallback(() => {
    setDrawnVertices((prev) => prev.slice(0, -1));
  }, []);

  // ── Blast site ─────────────────────────────────────────────────────────
  const [blastSite, setBlastSite] = useState<Vec2 | null>(null);
  const blastRecordRef = useRef<Record<string, unknown> | null>(null);

  // ── Trainer GPS tracking ──────────────────────────────────────────────
  const [gpsEnabled, setGpsEnabled] = useState(false);
  const [gpsSimPos, setGpsSimPos] = useState<Vec2 | null>(null);
  const [gpsAccuracy, setGpsAccuracy] = useState(0);
  const gpsWatchIdRef = useRef<number | null>(null);

  // ── Interior elements ─────────────────────────────────────────────────
  const [interiorWalls, setInteriorWalls] = useState<InteriorWall[]>([]);
  const [hazardZones, setHazardZones] = useState<HazardZone[]>([]);
  const [placedObjects, setPlacedObjects] = useState<PlacedObject[]>([]);
  const [activeObjectId, setActiveObjectId] = useState<string | null>(null);
  const [gasJetCount, setGasJetCount] = useState(0);
  const [arcCount, setArcCount] = useState(0);
  const [sprayCount, setSprayCount] = useState(0);
  const [placingObject, setPlacingObject] = useState(false);
  const [objectNotice, setObjectNotice] = useState<string | null>(null);
  const [stairwells, setStairwells] = useState<Stairwell[]>([]);
  const [levels, setLevels] = useState<LevelDef[]>([makeLevel('G', 120)]);
  const [activeLevel, setActiveLevel] = useState('G');
  const [blastLevel, setBlastLevel] = useState('G');
  const [selectedStairId, setSelectedStairId] = useState<string | null>(null);
  const [copyTargets, setCopyTargets] = useState<string[]>([]);
  const placeLinkKindRef = useRef<'stair' | 'lift'>('stair');
  // wallDrawStart state removed — now tracked in InteractionMode

  // ── Hazard detail card ────────────────────────────────────────────────
  const [activeHazard, setActiveHazard] = useState<HazardZone | null>(null);
  const hazardPhotoRef = useRef<HTMLInputElement>(null);

  // ── Exit detail card ──────────────────────────────────────────────────
  const [activeExit, setActiveExit] = useState<ExitDef | null>(null);
  const exitPhotoRef = useRef<HTMLInputElement>(null);

  // ── Wall detail card ──────────────────────────────────────────────────
  const [activeWall, setActiveWall] = useState<InteriorWall | null>(null);
  const wallPhotoRef = useRef<HTMLInputElement>(null);

  // ── AI Enrichment ──────────────────────────────────────────────────────
  const [enriching, setEnriching] = useState(false);
  const [enrichResult, setEnrichResult] = useState<{
    enrichedCasualties: Array<{ id: string; description: string; trueTag: string }>;
    generatedCasualties: Array<{ id: string; description: string; trueTag: string }>;
    hazardAnalysis: Array<{
      hazardId: string;
      identifiedMaterial: string;
      riskLevel: string;
      blastInteraction: string;
      secondaryEffects: string[];
      responderGuidance: string;
      generatedDescription: string;
      events?: Array<{
        triggerTimeSec: number;
        eventType: string;
        spreadType: string | null;
        spreadRadius: number;
        spreadRate: number;
        description: string;
        severity: string;
      }>;
      hazardStates?: {
        initial: string;
        triggered: string;
        worsening: string;
        critical: string;
      };
    }>;
    overallAssessment: string;
    sceneSynthesis: {
      chainReactions: string[];
      escalationTimeline: string;
      keyChallenges: string[];
      casualtyDeteriorationRisks: string[];
    };
  } | null>(null);
  const [enrichExpanded, setEnrichExpanded] = useState(false);

  // ── Stud grid toggle + inspect ────────────────────────────────────────
  const [showStudGrid, setShowStudGrid] = useState(true);
  const [studInspectMode, setStudInspectMode] = useState(false);
  const [inspectedStud, setInspectedStud] = useState<SimStud | null>(null);

  // ── Blast radius ──────────────────────────────────────────────────────
  const [blastRadius, setBlastRadius] = useState(20);
  const blastRadiusRef = useRef(blastRadius);
  blastRadiusRef.current = blastRadius;

  // ── Evacuation showcase ───────────────────────────────────────────────
  const showcasePrefs = useMemo(() => readShowcaseSettings(searchParams), [searchParams]);
  const [showcase, setShowcase] = useState(showcasePrefs.showcase);
  const [afterExit, setAfterExit] = useState<'zone' | 'disperse' | 'mixed'>(
    showcasePrefs.afterExit,
  );
  const [charge, setCharge] = useState<ChargeSpec>(defaultCharge());
  const [manualRadius, setManualRadius] = useState(() => !showcase);
  const [chargeNote, setChargeNote] = useState<string | null>(null);
  const rings = useMemo(() => computeBlastRings(charge), [charge]);
  const chargeRef = useRef(charge);
  chargeRef.current = charge;
  const ringsRef = useRef(rings);
  ringsRef.current = rings;
  const manualRadiusRef = useRef(manualRadius);
  manualRadiusRef.current = manualRadius;
  useEffect(() => {
    if (manualRadius) return;
    const next = roundTenth(rings.minorM);
    setBlastRadius((prev) => (prev === next ? prev : next));
  }, [manualRadius, rings.minorM]);
  const [zoneKinds, setZoneKinds] = useState<Record<string, ZoneKind>>({});
  const blastFiredRef = useRef(false);
  const placedObjectsRef = useRef<PlacedObject[]>([]);
  /** Discharge-only until the loaded scene says otherwise. */
  const hoodFanWhenRef = useRef<HoodFanWhen>(HOOD_FAN_WHEN);
  const [windSpeedMs, setWindSpeedMs] = useState(0);
  const [windDeg, setWindDeg] = useState(0);
  const windRef = useRef({ speedMs: 0, directionRad: 0 });
  windRef.current = {
    speedMs: windSpeedMs,
    directionRad: (windDeg * Math.PI) / 180,
  };
  const placeObjectRef = useRef(false);
  const objectIdRef = useRef(0);
  const explosionStartRef = useRef<number | null>(null);
  const [banner, setBanner] = useState<{ until: number; text: string } | null>(null);
  const hazardFieldRef = useRef<HazardField | null>(null);
  const showcaseRef = useRef(showcase);
  showcaseRef.current = showcase;
  const afterExitRef = useRef(afterExit);
  afterExitRef.current = afterExit;
  const zoneKindsRef = useRef(zoneKinds);
  zoneKindsRef.current = zoneKinds;
  const reducedMotion = useMemo(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    [],
  );
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;
  const [fxQuality, setFxQuality] = useState<FxQuality>(readFxQuality);
  const fxQualityRef = useRef(fxQuality);
  fxQualityRef.current = fxQuality;
  const [fxDowngraded, setFxDowngraded] = useState(false);
  /** Quality before the current automatic run. A second step does not replace it. */
  const fxDowngradeFromRef = useRef<FxQuality | null>(null);
  const fxSuppressRef = useRef(false);
  const fxTimesRef = useRef(new Float32Array(60));
  const fxFrameTimesRef = useRef(new Float32Array(60));
  const fxActiveRef = useRef(new Uint8Array(60));
  const fxTimePosRef = useRef(0);
  const fxTimeCountRef = useRef(0);
  const fxWarmupRef = useRef(30);
  /** Previous frame's sim time, ms. The frame interval it lands in is the next one. */
  const prevSimMsRef = useRef(0);
  const fxDebugRef = useRef(searchParams.get('fxdebug') === '1');
  const hazardFxRef = useRef<HazardFxRenderer | null>(null);
  if (hazardFxRef.current === null && typeof document !== 'undefined') {
    hazardFxRef.current = new HazardFxRenderer(FX.FX_RNG_SEED);
  }
  const hazardFxSlotRef = useRef<{ renderer: HazardFxRenderer; ctx: HazardFxContext } | null>(null);
  const hazardFxCtxRef = useRef<HazardFxContext>({
    quality: 'high',
    reducedMotion: false,
    nowMs: 0,
    layout: null,
    states: null,
    buildingVerts: [],
    cellM: 3,
    layers: null,
  });
  /** Room smoke layers from the last effects step, tagged with the engine that made them. */
  const smokeLayersRef = useRef<{
    engine: SpatialEffectsEngine | null;
    layers: SmokeLayerView[] | null;
  }>({ engine: null, layers: null });
  const rasterCacheRef = useRef(createRasterLayoutCache());
  const rasterLayoutRef = useRef<RasterLayout | null>(null);
  const simClockRef = useRef(createSharedClock());
  /** Share of the running setup preview done, or null when none is running. */
  const [previewProgress, setPreviewProgress] = useState<number | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => previewAbortRef.current?.abort(), []);
  /** Drop a running preview, so it can't install its engine over a scene it wasn't built for. */
  const cancelPreview = useCallback(() => {
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    setPreviewProgress(null);
  }, []);
  const speedMeterRef = useRef(createSpeedMeter());
  /** '10x (running 3.1x)' while the clock runs slower than the chosen speed. */
  const [slowedSpeed, setSlowedSpeed] = useState<string | null>(null);
  const [showcaseHud, setShowcaseHud] = useState<{
    metrics: ShowcaseMetrics | null;
    burning: number;
    smoke: number;
  } | null>(null);
  const hudAtRef = useRef(0);
  const [stairFlights, setStairFlights] = useState<StairFlightView[]>([]);
  const stairHudAtRef = useRef(0);
  const [responderStairId, setResponderStairId] = useState('');
  useEffect(() => {
    try {
      localStorage.setItem('rtsShowcaseSettings', JSON.stringify({ showcase, afterExit }));
    } catch {
      /* private mode or quota */
    }
  }, [showcase, afterExit]);

  // ── Operational zones (hot/warm/cold) ─────────────────────────────────
  const [gameZones, setGameZones] = useState([
    { id: 'hot', type: 'hot' as const, radius: 50 },
    { id: 'warm', type: 'warm' as const, radius: 100 },
    { id: 'cold', type: 'cold' as const, radius: 200 },
  ]);
  const [showGameZones, setShowGameZones] = useState(true);

  // ── Projected polygon ─────────────────────────────────────────────────
  const selectedGrid = selectedGridIdx != null ? fetchResult?.grids[selectedGridIdx] : null;

  const projectedVerts = useMemo<Vec2[]>(() => {
    if (!selectedGrid) return [];
    return projectPolygon(selectedGrid.polygon);
  }, [selectedGrid]);

  // ── Convert studs to sim-space ────────────────────────────────────────
  const simStuds = useMemo<SimStud[]>(() => {
    if (!selectedGrid || !selectedGrid.studs || selectedGrid.studs.length === 0) return [];
    const poly = selectedGrid.polygon;
    if (poly.length === 0) return [];

    let sumLat = 0,
      sumLng = 0;
    for (const [la, ln] of poly) {
      sumLat += la;
      sumLng += ln;
    }
    const refLat = sumLat / poly.length;
    const refLng = sumLng / poly.length;
    const mPerDegLat = 111_320;
    const mPerDegLng = 111_320 * Math.cos((refLat * Math.PI) / 180);

    return selectedGrid.studs.map((s) => ({
      ...s,
      simPos: {
        x: (s.lng - refLng) * mPerDegLng,
        y: (refLat - s.lat) * mPerDegLat,
      },
    }));
  }, [selectedGrid]);

  // Also convert studs from all OTHER grids (outdoor context)
  const allSimStuds = useMemo<SimStud[]>(() => {
    if (!fetchResult || !selectedGrid) return simStuds;
    const poly = selectedGrid.polygon;
    if (poly.length === 0) return simStuds;

    let sumLat = 0,
      sumLng = 0;
    for (const [la, ln] of poly) {
      sumLat += la;
      sumLng += ln;
    }
    const refLat = sumLat / poly.length;
    const refLng = sumLng / poly.length;
    const mPerDegLat = 111_320;
    const mPerDegLng = 111_320 * Math.cos((refLat * Math.PI) / 180);

    const otherStuds: SimStud[] = [];
    for (const grid of fetchResult.grids) {
      if (grid.buildingIndex === selectedGrid.buildingIndex) continue;
      if (!grid.studs) continue;
      for (const s of grid.studs) {
        if (s.floor !== 'G') continue;
        otherStuds.push({
          ...s,
          simPos: {
            x: (s.lng - refLng) * mPerDegLng,
            y: (refLat - s.lat) * mPerDegLat,
          },
        });
      }
    }
    return [...simStuds, ...otherStuds];
  }, [fetchResult, selectedGrid, simStuds]);

  const simStudsRef = useRef(allSimStuds);
  simStudsRef.current = allSimStuds;
  const selectedGridRef = useRef(selectedGrid);
  selectedGridRef.current = selectedGrid;
  const fetchResultRef = useRef(fetchResult);
  fetchResultRef.current = fetchResult;
  const floorsRef = useRef(selectedGrid?.floors ?? ['G']);
  floorsRef.current = selectedGrid?.floors ?? ['G'];
  const growFieldRef = useRef<(sim: Vec2) => SimStud[] | null>(() => null);

  const snapToStud = useCallback((simPos: Vec2): { pos: Vec2; stud: SimStud | null } => {
    const pick = (studs: readonly SimStud[]) => {
      const active = activeLevelRef.current;
      const onLevel = studs.filter((s) => storeyId(s.floor) === active);
      if (onLevel.length === 0) return { pos: simPos, stud: null };
      let best: SimStud | null = null;
      let bestDist = Infinity;
      for (const s of onLevel) {
        const d = Math.hypot(s.simPos.x - simPos.x, s.simPos.y - simPos.y);
        if (d < bestDist) {
          bestDist = d;
          best = s;
        }
      }
      if (best && bestDist < 8) return { pos: best.simPos, stud: best };
      return { pos: simPos, stud: null };
    };
    const hit = pick(simStudsRef.current);
    if (hit.stud) return hit;
    const grown = growFieldRef.current(simPos);
    return grown ? pick(grown) : hit;
  }, []);

  const snapWallEnd = useCallback(
    (simPos: Vec2): { pos: Vec2; stud: SimStud | null } => {
      const snapped = snapToStud(simPos);
      const level = activeLevelRef.current;
      const ends = interiorWallsRef.current
        .filter((w) => (w.level ?? 'G') === level)
        .flatMap((w) => [w.start, w.end]);
      const wall = snapWallPoint(
        simPos,
        projectedVertsRef.current,
        ends,
        snapped.stud ? snapped.pos : null,
      );
      return { pos: wall.pos, stud: snapped.stud };
    },
    [snapToStud],
  );

  // ── Prevent browser zoom on canvas/map area ────────────────────────────
  useEffect(() => {
    if (phase !== 'rts') return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const preventWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
    };
    const preventGesture = (e: Event) => {
      e.preventDefault();
    };

    canvas.addEventListener('wheel', preventWheel, { passive: false });
    container.addEventListener('wheel', preventWheel, { passive: false });
    document.addEventListener('gesturestart', preventGesture);
    document.addEventListener('gesturechange', preventGesture);

    return () => {
      canvas.removeEventListener('wheel', preventWheel);
      container.removeEventListener('wheel', preventWheel);
      document.removeEventListener('gesturestart', preventGesture);
      document.removeEventListener('gesturechange', preventGesture);
    };
  }, [phase]);

  // ── GPS watcher ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!gpsEnabled || !selectedGrid || !navigator.geolocation) {
      if (gpsWatchIdRef.current != null) {
        navigator.geolocation.clearWatch(gpsWatchIdRef.current);
        gpsWatchIdRef.current = null;
      }
      setGpsSimPos(null);
      return;
    }

    const polygon = selectedGrid.polygon;
    const n = polygon.length;
    let refLat = 0,
      refLng = 0;
    for (const [la, ln] of polygon) {
      refLat += la;
      refLng += ln;
    }
    refLat /= n;
    refLng /= n;
    const metersPerDegLat = 111320;
    const metersPerDegLng = 111320 * Math.cos((refLat * Math.PI) / 180);

    gpsWatchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const simX = (pos.coords.longitude - refLng) * metersPerDegLng;
        const simY = (refLat - pos.coords.latitude) * metersPerDegLat;
        setGpsSimPos({ x: simX, y: simY });
        setGpsAccuracy(pos.coords.accuracy);
      },
      (err) => {
        console.warn('GPS error:', err.message);
        setGpsSimPos(null);
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 },
    );

    return () => {
      if (gpsWatchIdRef.current != null) {
        navigator.geolocation.clearWatch(gpsWatchIdRef.current);
        gpsWatchIdRef.current = null;
      }
    };
  }, [gpsEnabled, selectedGrid]);

  // ── Canvas resize tracking ────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'rts' || !containerRef.current) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setCanvasSize({ w: Math.round(width), h: Math.round(height) });
      }
      leafletMapRef.current?.invalidateSize();
    });
    obs.observe(containerRef.current);
    const rect = containerRef.current.getBoundingClientRect();
    setCanvasSize({ w: Math.round(rect.width), h: Math.round(rect.height) });
    leafletMapRef.current?.invalidateSize();
    return () => obs.disconnect();
  }, [phase]);

  const shownPanes: PaneCount = phase === 'rts' ? paneCount : 1;
  const shownPanesRef = useRef(shownPanes);
  shownPanesRef.current = shownPanes;
  /** With several panes the hint bar and the legend fold into one button instead of covering panes. */
  const [gridHelpOpen, setGridHelpOpen] = useState(false);
  const paneRects = layoutPanes(shownPanes, canvasSize.w, canvasSize.h, isPortrait);
  const primaryRect = paneRects[0];
  /** With several panes the box opens under the main pane's level chip and stays in that pane. */
  const levelsBoxPlace =
    shownPanes > 1
      ? {
          top: primaryRect.y + LEVEL_CHIP_CLEARANCE_PX,
          maxHeight: Math.max(120, primaryRect.h - LEVEL_CHIP_CLEARANCE_PX - 8),
        }
      : null;
  // MapContainer fixes its style at mount, so the primary pane is sized on its element.
  const primaryPaneBox = shownPanes > 1 ? primaryRect : null;
  const primaryPaneKey = primaryPaneBox
    ? `${primaryPaneBox.x},${primaryPaneBox.y},${primaryPaneBox.w},${primaryPaneBox.h}`
    : 'full';
  /** The container position Leaflet set at init ('relative'), put back on returning to 1 pane. */
  const mapPositionRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const map = leafletMapRef.current;
    if (!map) return;
    const style = map.getContainer().style;
    mapPositionRef.current ??= style.position;
    style.position = primaryPaneBox ? 'absolute' : mapPositionRef.current;
    style.left = primaryPaneBox ? `${primaryPaneBox.x}px` : '';
    style.top = primaryPaneBox ? `${primaryPaneBox.y}px` : '';
    style.width = primaryPaneBox ? `${primaryPaneBox.w}px` : '100%';
    style.height = primaryPaneBox ? `${primaryPaneBox.h}px` : '100%';
    map.invalidateSize({ pan: true });
  }, [primaryPaneKey]);

  // ── Map phase handlers ────────────────────────────────────────────────
  const handleFetch = useCallback(async () => {
    setLiveOnly(false);
    setLiveNote(null);
    setLayoutLabels([]);
    setLoading(true);
    setError(null);
    setFetchResult(null);
    setSelectedGridIdx(null);
    try {
      const headers = await getAuthHeaders();
      const params = new URLSearchParams();
      if (lat) params.set('lat', lat);
      if (lng) params.set('lng', lng);
      if (radius) params.set('radius', radius);
      const res = await fetch(apiUrl(`/api/debug/building-studs?${params}`), { headers });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setFetchResult({ grids: data.grids ?? [], buildings: data.buildings ?? [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [lat, lng, radius]);

  // Auto-fetch buildings in warroom mode
  useEffect(() => {
    if (isWarroomMode && warroomLat && warroomLng && !fetchResult && lat && lng) {
      handleFetch();
    }
  }, [isWarroomMode, warroomLat, warroomLng, fetchResult, lat, lng, handleFetch]);

  const handleMapClick = useCallback(
    (clickLat: number, clickLng: number) => {
      if (phase === 'map') {
        if (drawingBuilding) {
          handleDrawMapClick(clickLat, clickLng);
        } else {
          setLat(clickLat.toFixed(7));
          setLng(clickLng.toFixed(7));
        }
      }
    },
    [phase, drawingBuilding, handleDrawMapClick],
  );

  // ── Place search (Nominatim) ────────────────────────────────────────
  const handleSearchInput = useCallback(
    (query: string) => {
      setSearchQuery(query);
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      if (query.trim().length < 3) {
        setSearchResults([]);
        return;
      }
      searchTimerRef.current = setTimeout(async () => {
        try {
          const params = new URLSearchParams({
            q: query,
            format: 'json',
            limit: '8',
            addressdetails: '0',
          });
          if (searchCountry) {
            params.set('countrycodes', searchCountry.toLowerCase());
          }
          if (userGeoPos) {
            const bias = 0.5;
            params.set(
              'viewbox',
              `${userGeoPos.lng - bias},${userGeoPos.lat + bias},${userGeoPos.lng + bias},${userGeoPos.lat - bias}`,
            );
            params.set('bounded', '0');
          }
          const resp = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
            headers: { 'User-Agent': 'Prophyion/1.0' },
          });
          if (resp.ok) {
            const data = await resp.json();
            setSearchResults(data);
            setSearchOpen(true);
          }
        } catch {
          setSearchResults([]);
        }
      }, 400);
    },
    [userGeoPos, searchCountry],
  );

  const handleSelectSearchResult = useCallback(
    (result: { lat: string; lon: string; display_name: string }) => {
      setLat(parseFloat(result.lat).toFixed(7));
      setLng(parseFloat(result.lon).toFixed(7));
      setSearchQuery(result.display_name);
      setSearchOpen(false);
      setSearchResults([]);
      // Pan the map to the selected location
      const map = leafletMapRef.current;
      if (map) {
        map.setView([parseFloat(result.lat), parseFloat(result.lon)], 18);
      }
    },
    [],
  );

  // ── Save / load map handlers ────────────────────────────────────────
  const handleSaveMap = useCallback(() => {
    if (liveOnly) return;
    if (!fetchResult || !saveMapName.trim()) return;
    const map: SavedMap = {
      id: generateMapId(),
      name: saveMapName.trim(),
      lat,
      lng,
      radius,
      savedAt: Date.now(),
      grids: fetchResult.grids,
      buildings: fetchResult.buildings,
    };
    saveMap(map);
    setSavedMaps(loadSavedMaps());
    setSaveMapName('');
  }, [fetchResult, saveMapName, lat, lng, radius, liveOnly]);

  const handleLoadSavedMap = useCallback((m: SavedMap) => {
    cancelPreview();
    hoodFanWhenRef.current = HOOD_FAN_WHEN;
    setLiveOnly(false);
    setLiveNote(null);
    setLayoutLabels([]);
    setLat(m.lat);
    setLng(m.lng);
    setRadius(m.radius);
    setFetchResult({
      grids: m.grids.map((g, i) => {
        const existing = (g as GridItem).studs;
        return {
          ...g,
          studs:
            existing && existing.length > 0
              ? existing
              : generateStudsForPolygon(g.polygon, 5, g.buildingIndex ?? i),
        };
      }),
      buildings: m.buildings,
    });
    setSelectedGridIdx(null);
  }, []);

  const handleDeleteSavedMap = useCallback((id: string) => {
    deleteSavedMap(id);
    setSavedMaps(loadSavedMaps());
  }, []);

  // ── Select building → go to RTS ──────────────────────────────────────
  const selectBuilding = useCallback(
    (gridIdx: number) => {
      setSelectedGridIdx(gridIdx);
      setExits([]);
      setPedestrians([]);
      setPhase('rts');
      setActiveWallPoint(null);
      setWallPointImage(null);
      setAssessmentText('');
      evacEngRef.current?.destroy();
      evacEngRef.current = null;
      rtsRef.current = new RTSEngine();

      // Set building vertices for pathfinding
      const grid = fetchResult?.grids[gridIdx];
      const nextLevels = defaultLevels(grid?.floors ?? ['G']).map((l) =>
        l.id === 'G' ? { ...l, pedestrianCount } : l,
      );
      setLevels(nextLevels);
      setActiveLevel('G');
      setBlastLevel('G');
      setSelectedStairId(null);
      if (grid && grid.polygon.length >= 3) {
        const verts = projectPolygon(grid.polygon);
        rtsRef.current.setBuildingVertices(verts);
        const pts = generateWallPoints(grid.polygon, verts);
        setWallPoints(pts);
      } else {
        setWallPoints([]);
      }
    },
    [fetchResult, pedestrianCount],
  );

  const backToMap = useCallback(() => {
    cancelPreview();
    setPhase('map');
    cancelAnimationFrame(rafRef.current);
    evacEngRef.current?.destroy();
    evacEngRef.current = null;
    effectsEngineRef.current = null;
    setEffectStates(null);
    setGasJetCount(0);
    setArcCount(0);
    setSprayCount(0);
    rtsRef.current = new RTSEngine();
    setPedestrians([]);
    setWallPoints([]);
    setActiveWallPoint(null);
    setWallPointImage(null);
    setTimeout(() => leafletMapRef.current?.invalidateSize(), 100);
  }, []);

  // ── Scene config save/load ──────────────────────────────────────────
  const handleSaveSceneToDb = useCallback(async () => {
    if (liveOnly) return;
    if (!selectedGrid || projectedVerts.length < 3) return;
    setSavingScene(true);
    try {
      const polygon = selectedGrid.polygon;
      let cLat = 0,
        cLng = 0;
      for (const [la, ln] of polygon) {
        cLat += la;
        cLng += ln;
      }
      cLat /= polygon.length;
      cLng /= polygon.length;

      const nextBlast = blastSite
        ? writeStoredBlast(blastRecordRef.current, blastSite, charge, manualRadius, blastRadius)
        : null;
      if (nextBlast) blastRecordRef.current = nextBlast;
      const payload = {
        name: selectedGrid.buildingName || 'Untitled Scene',
        buildingPolygon: polygon,
        buildingName: selectedGrid.buildingName ?? undefined,
        centerLat: cLat,
        centerLng: cLng,
        exits,
        interiorWalls,
        hazardZones,
        stairwells,
        blastSite: nextBlast ? { ...nextBlast, level: blastLevel } : null,
        levels,
        placedObjects,
        casualtyPins,
        plantedItems,
        wallInspectionPoints: wallPoints,
        pedestrianCount,
      };

      if (sceneConfigId) {
        await updateSceneConfig(sceneConfigId, payload);
      } else {
        const { id } = await createSceneConfig(payload);
        setSceneConfigId(id);
      }
    } catch (err) {
      console.error('Failed to save scene:', err);
    }
    setSavingScene(false);
  }, [
    selectedGrid,
    projectedVerts,
    exits,
    interiorWalls,
    hazardZones,
    stairwells,
    blastSite,
    charge,
    manualRadius,
    blastRadius,
    blastLevel,
    levels,
    placedObjects,
    casualtyPins,
    plantedItems,
    wallPoints,
    pedestrianCount,
    sceneConfigId,
    liveOnly,
  ]);

  const handleEnrichScene = useCallback(async () => {
    if (enriching) return;
    setEnriching(true);
    setEnrichResult(null);
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(apiUrl('/api/debug/rts-enrich-scene'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          incidentDescription: isWarroomMode ? 'Explosion at building' : 'Explosion at building',
          blastRadius: blastRadius,
          blastSite: blastSite,
          casualtyPins: casualtyPins.map((c) => ({
            id: c.id,
            pos: c.pos,
            description: c.description || '',
            trueTag: c.trueTag || 'untagged',
            photos: c.imageUrl ? [c.imageUrl] : [],
            insideBuilding: c.insideBuilding ?? false,
          })),
          hazards: hazardZones.map((h) => ({
            id: h.id,
            pos: h.pos,
            hazardType: h.hazardType,
            severity: h.severity,
            description: h.description || '',
            photos: h.photos || [],
            insideBuilding: h.insideBuilding ?? false,
          })),
          exits: exits.map((e) => ({
            id: e.id,
            status: e.status || 'open',
            description: e.description || '',
            width: e.width,
          })),
          wallMaterials: interiorWalls.map((w) => w.material).filter(Boolean),
          gameZones: [],
          buildingName: selectedGrid?.buildingName || null,
          pedestrianCount,
        }),
      });
      if (resp.ok) {
        const { data } = await resp.json();
        setEnrichResult(data);
        setEnrichExpanded(true);

        if (sceneConfigId) {
          updateSceneConfig(sceneConfigId, { enrichmentResult: data }).catch(() => {});
        }

        // Auto-merge enriched descriptions into hazards that had none
        if (data.hazardAnalysis?.length) {
          setHazardZones((prev) =>
            prev.map((hz) => {
              const analysis = data.hazardAnalysis.find(
                (a: { hazardId: string; generatedDescription: string }) => a.hazardId === hz.id,
              );
              if (analysis && !hz.description && analysis.generatedDescription) {
                return { ...hz, description: analysis.generatedDescription };
              }
              return hz;
            }),
          );
        }

        // Auto-merge enriched descriptions into casualties that had none
        if (data.enrichedCasualties?.length) {
          setCasualtyPins((prev) =>
            prev.map((cp) => {
              const enriched = data.enrichedCasualties.find((e: { id: string }) => e.id === cp.id);
              if (enriched && !cp.description) {
                return { ...cp, description: enriched.description };
              }
              return cp;
            }),
          );
        }
      } else {
        const errText = await resp.text();
        console.error('Enrichment failed:', errText);
        alert('Scene enrichment failed — check console');
      }
    } catch (err) {
      console.error('Enrichment error:', err);
      alert('Scene enrichment error — check console');
    }
    setEnriching(false);
  }, [
    enriching,
    blastSite,
    casualtyPins,
    hazardZones,
    exits,
    interiorWalls,
    selectedGrid,
    pedestrianCount,
    isWarroomMode,
  ]);

  const handleLoadSceneFromDb = useCallback(async (id: string) => {
    cancelPreview();
    hoodFanWhenRef.current = HOOD_FAN_WHEN;
    setLiveOnly(false);
    setLiveNote(null);
    setLayoutLabels([]);
    try {
      const sc = await loadSceneConfig(id);
      setSceneConfigId(sc.id);

      const savedLevels = Array.isArray(sc.levels) ? (sc.levels as LevelDef[]) : [];
      const levelIds = savedLevels.length > 0 ? savedLevels.map((level) => level.id) : ['G'];
      const loadedObjects = Array.isArray(sc.placed_objects)
        ? (sc.placed_objects as PlacedObject[])
        : [];
      const absorbed = absorbLegacyFuelCircles(sc.hazard_zones as HazardZone[], loadedObjects);
      const storedBlast = readStoredBlast(sc.blast_site);
      const grid: GridItem = {
        buildingIndex: 0,
        buildingName: sc.building_name,
        polygon: sc.building_polygon,
        floors: levelIds,
        spacingM: 5,
        studs: generateSceneStuds(
          sc.building_polygon,
          0,
          levelIds,
          placementCover(
            storedBlast?.pos ?? null,
            storedBlast?.radiusM ?? 0,
            absorbed.zones,
            absorbed.objects,
          ),
        ),
      };
      setFetchResult({
        grids: [grid],
        buildings: [
          {
            name: sc.building_name,
            lat: sc.center_lat ?? 0,
            lng: sc.center_lng ?? 0,
            levels: 1,
            use: 'custom',
            polygonPoints: sc.building_polygon.length,
          },
        ],
      });
      setSelectedGridIdx(0);
      setExits(sc.exits as ExitDef[]);
      setInteriorWalls(sc.interior_walls as InteriorWall[]);
      setHazardZones(absorbed.zones);
      setPlacedObjects(objectsOnStuds(sc.building_polygon, grid.studs, absorbed.objects));
      setActiveObjectId(null);
      setPlacingObject(false);
      setStairwells(sc.stairwells as Stairwell[]);
      if (storedBlast) {
        blastRecordRef.current = storedBlast.record;
        setBlastSite(storedBlast.pos);
        setBlastLevel(
          typeof storedBlast.record.level === 'string' ? storedBlast.record.level : 'G',
        );
        const savedCharge = storedBlast.charge;
        if (savedCharge) {
          const restored = clampCharge({
            presetKey:
              typeof savedCharge.presetKey === 'string' ? savedCharge.presetKey : 'unknown',
            amountKg: Number(savedCharge.amountKg),
            burst: savedCharge.burst === 'free_air' ? 'free_air' : 'surface',
            heightM: Number(savedCharge.heightM),
          });
          setCharge(restored.spec);
          setChargeNote(restored.notes[0] ?? null);
          setManualRadius(storedBlast.manualRadius);
          if (storedBlast.manualRadius) {
            setBlastRadius(storedBlast.radiusM ?? 20);
          }
        } else {
          setCharge(defaultCharge());
          setChargeNote(null);
          setManualRadius(true);
          setBlastRadius(storedBlast.radiusM ?? 20);
        }
      } else {
        blastRecordRef.current = null;
        setBlastSite(null);
        setBlastLevel('G');
      }
      setLevels(savedLevels.length > 0 ? savedLevels : defaultLevels(['G']));
      setActiveLevel('G');
      setSelectedStairId(null);
      // Backward compatibility: convert old casualty_clusters to individual pins
      const rawPins = (sc as unknown as Record<string, unknown>).casualty_pins as
        CasualtyPin[] | undefined;
      const rawClusters = sc.casualty_clusters as CasualtyCluster[] | undefined;
      if (rawPins && rawPins.length > 0) {
        setCasualtyPins(
          rawPins.map((p) => ({
            ...p,
            currentTag: p.currentTag ?? p.trueTag,
            deteriorationLevel: p.deteriorationLevel ?? 0,
          })),
        );
      } else if (rawClusters && rawClusters.length > 0) {
        const converted: CasualtyPin[] = [];
        for (const cluster of rawClusters) {
          for (let vi = 0; vi < cluster.victims.length; vi++) {
            const v = cluster.victims[vi];
            const offset = vi * 1.5;
            converted.push({
              id: v.id || `cas-conv-${Date.now()}-${vi}`,
              pos: { x: cluster.pos.x + offset, y: cluster.pos.y },
              description: v.description,
              trueTag: v.trueTag,
              currentTag: v.trueTag,
              observableSigns: v.observableSigns,
              imageUrl: v.imageUrl,
              imageGenerating: false,
              autoGenerated: false,
              deteriorationLevel: 0,
              insideBuilding: cluster.insideBuilding,
              spatialContext: cluster.spatialContext,
            });
          }
        }
        setCasualtyPins(converted);
      } else {
        setCasualtyPins([]);
      }
      setPlantedItems(sc.planted_items as PlantedItem[]);
      setPedestrianCount(sc.pedestrian_count);

      const verts = projectPolygon(sc.building_polygon);
      rtsRef.current = new RTSEngine();
      rtsRef.current.setBuildingVertices(verts);
      rtsRef.current.setExits(sc.exits as ExitDef[]);

      const pts = generateWallPoints(sc.building_polygon, verts);
      setWallPoints(pts);

      if (sc.enrichment_result) {
        setEnrichResult(sc.enrichment_result as typeof enrichResult);
        setEnrichExpanded(true);
      }

      setPhase('rts');
    } catch (err) {
      console.error('Failed to load scene:', err);
    }
  }, []);

  const handleLoadFoodCourt = useCallback(() => {
    cancelPreview();
    setLiveOnly(false);
    setLiveNote(null);
    setLayoutLabels([]);
    const scene = foodCourtSample.scene;
    hoodFanWhenRef.current = scene.hoodFanWhen;
    const polygon = scene.buildingPolygon.map((pair) => [pair[0], pair[1]] as [number, number]);
    const savedLevels = scene.levels.map((level) => ({ ...level }));
    const levelIds = savedLevels.map((level) => level.id);
    const placed = foodCourtPlacedObjects();
    const storedBlast = readStoredBlast(scene.blastSite);
    const grid: GridItem = {
      buildingIndex: 0,
      buildingName: scene.buildingName,
      polygon,
      floors: levelIds,
      spacingM: 3,
      studs: generateSceneStuds(
        polygon,
        0,
        levelIds,
        placementCover(storedBlast?.pos ?? null, storedBlast?.radiusM ?? 0, [], placed),
      ),
    };
    setUserGeoPos({ lat: scene.centerLat, lng: scene.centerLng });
    setLat(String(scene.centerLat));
    setLng(String(scene.centerLng));
    setFetchResult({
      grids: [grid],
      buildings: [
        {
          name: scene.buildingName,
          lat: scene.centerLat,
          lng: scene.centerLng,
          levels: 1,
          use: 'food court',
          polygonPoints: polygon.length,
        },
      ],
    });
    setSelectedGridIdx(0);
    setSceneConfigId(null);
    setExits(scene.exits.map((exit) => ({ ...exit, photos: [...exit.photos] })) as ExitDef[]);
    setInteriorWalls(
      scene.interiorWalls.map((wall) => ({
        ...wall,
        photos: [...wall.photos],
        start: { ...wall.start },
        end: { ...wall.end },
      })) as InteriorWall[],
    );
    setHazardZones([]);
    setPlacedObjects(objectsOnStuds(polygon, grid.studs, placed));
    setActiveObjectId(null);
    setPlacingObject(false);
    setObjectNotice(null);
    setStairwells([]);
    setCasualtyPins([]);
    setPlantedItems([]);
    setPedestrianCount(scene.pedestrianCount);
    setLevels(savedLevels.length > 0 ? (savedLevels as LevelDef[]) : defaultLevels(['G']));
    setActiveLevel('G');
    setSelectedStairId(null);
    if (storedBlast) {
      blastRecordRef.current = storedBlast.record;
      setBlastSite(storedBlast.pos);
      setBlastLevel(typeof storedBlast.record.level === 'string' ? storedBlast.record.level : 'G');
      setManualRadius(true);
      setBlastRadius(storedBlast.radiusM ?? 8);
    }
    setShowcase(true);
    effectsEngineRef.current = null;
    setEffectStates(null);
    setGasJetCount(0);
    setArcCount(0);
    setSprayCount(0);
    const verts = projectPolygon(polygon);
    rtsRef.current = new RTSEngine();
    rtsRef.current.setBuildingVertices(verts);
    rtsRef.current.setExits(scene.exits as unknown as ExitDef[]);
    setWallPoints(generateWallPoints(polygon, verts));
    setPhase('rts');
  }, []);

  const handleLoadHarbourHouse = useCallback(() => {
    cancelPreview();
    setLiveOnly(false);
    setLiveNote(null);
    setLayoutLabels([]);
    const scene = harbourHouseSample.scene;
    hoodFanWhenRef.current = scene.hoodFanWhen;
    const polygon = scene.buildingPolygon.map((pair) => [pair[0], pair[1]] as [number, number]);
    const savedLevels = scene.levels.map((level) => ({ ...level }));
    const levelIds = savedLevels.map((level) => level.id);
    const grid: GridItem = {
      buildingIndex: 0,
      buildingName: scene.buildingName,
      polygon,
      floors: levelIds,
      spacingM: 3,
      studs: generateSceneStuds(polygon, 0, levelIds),
    };
    setUserGeoPos({ lat: scene.centerLat, lng: scene.centerLng });
    setLat(String(scene.centerLat));
    setLng(String(scene.centerLng));
    setFetchResult({
      grids: [grid],
      buildings: [
        {
          name: scene.buildingName,
          lat: scene.centerLat,
          lng: scene.centerLng,
          levels: 1,
          use: 'house',
          polygonPoints: polygon.length,
        },
      ],
    });
    setSelectedGridIdx(0);
    setSceneConfigId(null);
    setExits(scene.exits.map((exit) => ({ ...exit, photos: [...exit.photos] })) as ExitDef[]);
    setInteriorWalls(
      scene.interiorWalls.map((wall) => ({
        ...wall,
        photos: [...wall.photos],
        start: { ...wall.start },
        end: { ...wall.end },
      })) as InteriorWall[],
    );
    setHazardZones([]);
    const projected = projectSceneStuds(polygon, grid.studs);
    setPlacedObjects(
      harbourHouseFuelObjects(
        projected.map((stud) => ({
          id: stud.id,
          simPos: stud.simPos,
          spatialContext: stud.spatialContext,
          level: stud.floor,
        })),
      ),
    );
    setActiveObjectId(null);
    setPlacingObject(false);
    setObjectNotice(null);
    setStairwells([]);
    setCasualtyPins([]);
    setPlantedItems([]);
    setPedestrianCount(scene.pedestrianCount);
    setLevels(savedLevels.length > 0 ? (savedLevels as LevelDef[]) : defaultLevels(['G']));
    setActiveLevel('G');
    setSelectedStairId(null);
    const storedBlast = readStoredBlast(scene.blastSite);
    if (storedBlast) {
      blastRecordRef.current = storedBlast.record;
      setBlastSite(storedBlast.pos);
      setBlastLevel(typeof storedBlast.record.level === 'string' ? storedBlast.record.level : 'G');
      setManualRadius(true);
      setBlastRadius(storedBlast.radiusM ?? 15);
    }
    setShowcase(true);
    const verts = projectPolygon(polygon);
    rtsRef.current = new RTSEngine();
    rtsRef.current.setBuildingVertices(verts);
    rtsRef.current.setExits(scene.exits as unknown as ExitDef[]);
    setWallPoints(generateWallPoints(polygon, verts));
    setPhase('rts');
  }, []);

  const handleLoadSmokeCorridor = useCallback(() => {
    cancelPreview();
    setLiveOnly(false);
    setLiveNote(null);
    setLayoutLabels([]);
    const scene = smokeCorridorSample.scene;
    hoodFanWhenRef.current = scene.hoodFanWhen;
    const polygon = scene.buildingPolygon.map((pair) => [pair[0], pair[1]] as [number, number]);
    const savedLevels = scene.levels.map((level) => ({ ...level }));
    const levelIds = savedLevels.map((level) => level.id);
    const grid: GridItem = {
      buildingIndex: 0,
      buildingName: scene.buildingName,
      polygon,
      floors: levelIds,
      spacingM: 3,
      studs: generateSceneStuds(polygon, 0, levelIds),
    };
    setUserGeoPos({ lat: scene.centerLat, lng: scene.centerLng });
    setLat(String(scene.centerLat));
    setLng(String(scene.centerLng));
    setFetchResult({
      grids: [grid],
      buildings: [
        {
          name: scene.buildingName,
          lat: scene.centerLat,
          lng: scene.centerLng,
          levels: 1,
          use: 'office',
          polygonPoints: polygon.length,
        },
      ],
    });
    setSelectedGridIdx(0);
    setSceneConfigId(null);
    setExits(scene.exits.map((exit) => ({ ...exit, photos: [...exit.photos] })) as ExitDef[]);
    setInteriorWalls(
      scene.interiorWalls.map((wall) => ({
        ...wall,
        photos: [...wall.photos],
        start: { ...wall.start },
        end: { ...wall.end },
      })),
    );
    setHazardZones([]);
    const projected = projectSceneStuds(polygon, grid.studs);
    setPlacedObjects(
      smokeCorridorFuelObjects(
        projected.map((stud) => ({
          id: stud.id,
          simPos: stud.simPos,
          spatialContext: stud.spatialContext,
          level: stud.floor,
        })),
      ),
    );
    setActiveObjectId(null);
    setPlacingObject(false);
    setObjectNotice(null);
    setStairwells([]);
    setCasualtyPins([]);
    setPlantedItems([]);
    setPedestrianCount(scene.pedestrianCount);
    setLevels(savedLevels as LevelDef[]);
    setActiveLevel('G');
    setSelectedStairId(null);
    const storedBlast = readStoredBlast(scene.blastSite);
    if (storedBlast) {
      blastRecordRef.current = storedBlast.record;
      setBlastSite(storedBlast.pos);
      setBlastLevel('G');
      setManualRadius(true);
      setBlastRadius(storedBlast.radiusM ?? 2);
    }
    setShowcase(true);
    effectsEngineRef.current = null;
    setEffectStates(null);
    setGasJetCount(0);
    setArcCount(0);
    setSprayCount(0);
    const verts = projectPolygon(polygon);
    rtsRef.current = new RTSEngine();
    rtsRef.current.setBuildingVertices(verts);
    rtsRef.current.setExits(scene.exits as unknown as ExitDef[]);
    setWallPoints(generateWallPoints(polygon, verts));
    setPhase('rts');
  }, []);

  const handleLoadStairShaft = useCallback(() => {
    cancelPreview();
    setLiveOnly(false);
    setLiveNote(null);
    setLayoutLabels([]);
    const scene = stairShaftSample.scene;
    hoodFanWhenRef.current = scene.hoodFanWhen;
    const polygon = scene.buildingPolygon.map((pair) => [pair[0], pair[1]] as [number, number]);
    const savedLevels = scene.levels.map((level) => ({ ...level }));
    const levelIds = savedLevels.map((level) => level.id);
    const grid: GridItem = {
      buildingIndex: 0,
      buildingName: scene.buildingName,
      polygon,
      floors: levelIds,
      spacingM: 3,
      studs: stairShaftStuds(polygon, levelIds),
    };
    setUserGeoPos({ lat: scene.centerLat, lng: scene.centerLng });
    setLat(String(scene.centerLat));
    setLng(String(scene.centerLng));
    setFetchResult({
      grids: [grid],
      buildings: [
        {
          name: scene.buildingName,
          lat: scene.centerLat,
          lng: scene.centerLng,
          levels: 2,
          use: 'office',
          polygonPoints: polygon.length,
        },
      ],
    });
    setSelectedGridIdx(0);
    setSceneConfigId(null);
    setExits(scene.exits.map((exit) => ({ ...exit, photos: [...exit.photos] })) as ExitDef[]);
    setInteriorWalls([]);
    setHazardZones([]);
    const projected = projectSceneStuds(polygon, grid.studs);
    setPlacedObjects(
      stairShaftFuelObjects(
        projected.map((stud) => ({
          id: stud.id,
          simPos: stud.simPos,
          spatialContext: stud.spatialContext,
          level: stud.floor,
        })),
      ),
    );
    setActiveObjectId(null);
    setPlacingObject(false);
    setObjectNotice(null);
    setStairwells(scene.stairwells.map((shaft) => ({ ...shaft, pos: { ...shaft.pos } })));
    setCasualtyPins([]);
    setPlantedItems([]);
    setPedestrianCount(scene.pedestrianCount);
    setLevels(savedLevels as LevelDef[]);
    setActiveLevel('G');
    setSelectedStairId(scene.stairwells[0]?.id ?? null);
    const storedBlast = readStoredBlast(scene.blastSite);
    if (storedBlast) {
      blastRecordRef.current = storedBlast.record;
      setBlastSite(storedBlast.pos);
      setBlastLevel('G');
      setManualRadius(true);
      setBlastRadius(storedBlast.radiusM ?? 4);
    }
    setShowcase(true);
    effectsEngineRef.current = null;
    setEffectStates(null);
    setGasJetCount(0);
    setArcCount(0);
    setSprayCount(0);
    const verts = projectPolygon(polygon);
    rtsRef.current = new RTSEngine();
    rtsRef.current.setBuildingVertices(verts);
    rtsRef.current.setExits(scene.exits as unknown as ExitDef[]);
    setWallPoints(generateWallPoints(polygon, verts));
    setPhase('rts');
  }, []);

  const handleLoadOfficeTower = useCallback(() => {
    cancelPreview();
    setLiveOnly(false);
    setLiveNote(null);
    setLayoutLabels([]);
    const scene = officeTowerSample.scene;
    hoodFanWhenRef.current = scene.hoodFanWhen;
    const polygon = scene.buildingPolygon.map((pair) => [pair[0], pair[1]] as [number, number]);
    const savedLevels = scene.levels.map((level) => ({ ...level }));
    const levelIds = savedLevels.map((level) => level.id);
    const grid: GridItem = {
      buildingIndex: 0,
      buildingName: scene.buildingName,
      polygon,
      floors: levelIds,
      spacingM: 3,
      studs: officeTowerStuds(polygon),
    };
    setUserGeoPos({ lat: scene.centerLat, lng: scene.centerLng });
    setLat(String(scene.centerLat));
    setLng(String(scene.centerLng));
    setFetchResult({
      grids: [grid],
      buildings: [
        {
          name: scene.buildingName,
          lat: scene.centerLat,
          lng: scene.centerLng,
          levels: 3,
          use: 'office',
          polygonPoints: polygon.length,
        },
      ],
    });
    setSelectedGridIdx(0);
    setSceneConfigId(null);
    setExits(scene.exits.map((exit) => ({ ...exit, photos: [...exit.photos] })) as ExitDef[]);
    setInteriorWalls(
      scene.interiorWalls.map((wall) => ({
        ...wall,
        photos: [...wall.photos],
        start: { ...wall.start },
        end: { ...wall.end },
      })),
    );
    setHazardZones([]);
    const projected = projectSceneStuds(polygon, grid.studs);
    setPlacedObjects(
      officeTowerFuelObjects(
        projected.map((stud) => ({
          id: stud.id,
          simPos: stud.simPos,
          spatialContext: stud.spatialContext,
          level: stud.floor,
        })),
      ),
    );
    setActiveObjectId(null);
    setPlacingObject(false);
    setObjectNotice(null);
    setStairwells(scene.stairwells.map((shaft) => ({ ...shaft, pos: { ...shaft.pos } })));
    setCasualtyPins([]);
    setPlantedItems([]);
    setPedestrianCount(scene.pedestrianCount);
    setLevels(savedLevels as LevelDef[]);
    setActiveLevel('G');
    setSelectedStairId(scene.stairwells[0]?.id ?? null);
    const storedBlast = readStoredBlast(scene.blastSite);
    if (storedBlast) {
      blastRecordRef.current = storedBlast.record;
      setBlastSite(storedBlast.pos);
      setBlastLevel('G');
      setManualRadius(true);
      setBlastRadius(storedBlast.radiusM ?? 2);
    }
    setShowcase(true);
    effectsEngineRef.current = null;
    setEffectStates(null);
    setGasJetCount(0);
    setArcCount(0);
    setSprayCount(0);
    const verts = projectPolygon(polygon);
    rtsRef.current = new RTSEngine();
    rtsRef.current.setBuildingVertices(verts);
    rtsRef.current.setExits(scene.exits as unknown as ExitDef[]);
    setWallPoints(generateWallPoints(polygon, verts));
    setPhase('rts');
  }, []);

  const handleLoadHollandVillage = useCallback(async () => {
    cancelPreview();
    setHollandLoading(true);
    setHollandError(null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(
        apiUrl(`/api/debug/osm-building?osmId=${encodeURIComponent(HOLLAND_VILLAGE_OSM_ID)}`),
        { headers },
      );
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        building?: OsmBuildingFootprint;
      };
      if (!res.ok || !body.building || body.building.polygon.length < 3) {
        throw new Error(body.error || `Could not load ${HOLLAND_VILLAGE_OSM_ID}`);
      }
      const building = body.building;
      const polygon = building.polygon.map((pair) => [pair[0], pair[1]] as [number, number]);
      const nextLevels = levelsForFootprint({
        aboveGround: building.levels,
        underground: building.underground,
      }).map((level) =>
        level.id === 'G' ? { ...level, pedestrianCount: HOLLAND_BOMB.crowd } : level,
      );
      const levelIds = nextLevels.map((level) => level.id);
      let centerLat = 0;
      let centerLng = 0;
      for (const [lat, lng] of polygon) {
        centerLat += lat;
        centerLng += lng;
      }
      centerLat /= polygon.length;
      centerLng /= polygon.length;
      const grid: GridItem = {
        buildingIndex: 0,
        buildingName: building.name,
        polygon,
        floors: levelIds,
        spacingM: 3,
        studs: generateSceneStuds(polygon, 0, levelIds),
      };
      setUserGeoPos({ lat: centerLat, lng: centerLng });
      setLat(String(centerLat));
      setLng(String(centerLng));
      setFetchResult({
        grids: [grid],
        buildings: [
          {
            name: building.name,
            lat: centerLat,
            lng: centerLng,
            levels: building.levels,
            use: building.buildingType,
            polygonPoints: polygon.length,
          },
        ],
      });
      setSelectedGridIdx(0);
      setSceneConfigId(null);
      setLiveOnly(true);
      const verts = projectPolygon(polygon);
      const indoor = projectSceneStuds(polygon, grid.studs)
        .filter((stud) => stud.spatialContext === 'inside_building' && stud.floor === 'G')
        .map((stud) => ({ id: stud.id, x: stud.simPos.x, y: stud.simPos.y }));
      let facts: HawkerFacts = EMPTY_HAWKER_FACTS;
      let researchNote = 'No page could be fetched, so the interior is assumed.';
      try {
        const interior = await fetch(
          apiUrl(
            `/api/debug/building-interior?name=${encodeURIComponent(building.name ?? 'Holland Village Market and Food Centre')}`,
          ),
          { headers },
        );
        if (interior.ok) {
          const research = (await interior.json()) as {
            mode?: string;
            facts?: HawkerFacts;
            note?: string;
          };
          if (research.facts) facts = research.facts;
          researchNote = research.note || researchNote;
        }
      } catch {
        researchNote = 'The interior search failed, so the interior is assumed.';
      }
      const upperFloors = nextLevels
        .filter((level) => level.id !== 'G' && !level.designed)
        .map((level) => level.id);
      const layout = layoutHawkerCentre({
        verts,
        studs: indoor,
        facts,
        upperFloorIds: upperFloors,
      });
      hoodFanWhenRef.current = layout.hoodFanWhen;
      const covered = generateSceneStuds(
        polygon,
        0,
        levelIds,
        placementCover(layout.bomb, HOLLAND_BOMB.fireballM, [], layout.objects),
        grid.studs.map((stud) => [stud.lat, stud.lng] as [number, number]),
      );
      if (covered.length !== grid.studs.length) {
        grid.studs = covered;
        setFetchResult((prev) =>
          prev
            ? {
                ...prev,
                grids: prev.grids.map((item) =>
                  item.buildingIndex === grid.buildingIndex ? { ...item, studs: covered } : item,
                ),
              }
            : prev,
        );
      }
      setLiveNote(`${footprintSessionNote(building)} ${researchNote}`);
      setLayoutLabels(layout.labels);
      setExits(layout.exits);
      setInteriorWalls(layout.walls);
      setHazardZones([]);
      setPlacedObjects(objectsOnStuds(polygon, grid.studs, layout.objects));
      setActiveObjectId(null);
      setPlacingObject(false);
      setObjectNotice(null);
      setStairwells([]);
      setCasualtyPins([]);
      setPlantedItems([]);
      setPedestrians([]);
      setPedestrianCount(HOLLAND_BOMB.crowd);
      setLevels(nextLevels);
      setActiveLevel('G');
      setBlastLevel('G');
      setSelectedStairId(null);
      blastRecordRef.current = null;
      setCharge(defaultCharge());
      setManualRadius(true);
      setBlastRadius(HOLLAND_BOMB.fireballM);
      setBlastSite(layout.bomb);
      setShowcase(true);
      effectsEngineRef.current = null;
      setEffectStates(null);
      setGasJetCount(0);
      setArcCount(0);
      setSprayCount(0);
      rtsRef.current = new RTSEngine();
      rtsRef.current.setBuildingVertices(verts);
      rtsRef.current.setExits(layout.exits);
      setWallPoints(generateWallPoints(polygon, verts));
      setPhase('rts');
    } catch (err) {
      setHollandError(err instanceof Error ? err.message : String(err));
    } finally {
      setHollandLoading(false);
    }
  }, []);

  const handleLoadDbSceneList = useCallback(async () => {
    try {
      const scenes = await listSceneConfigs();
      setDbScenes(scenes);
    } catch (err) {
      console.error('Failed to list scenes:', err);
    }
  }, []);

  const handleDeleteDbScene = useCallback(
    async (id: string) => {
      try {
        await deleteSceneConfig(id);
        setDbScenes((prev) => prev.filter((s) => s.id !== id));
        if (sceneConfigId === id) setSceneConfigId(null);
      } catch (err) {
        console.error('Failed to delete scene:', err);
      }
    },
    [sceneConfigId],
  );

  // ── Initialize evac engine ────────────────────────────────────────────
  const initEvacEngine = useCallback(() => {
    if (projectedVerts.length < 3 || exits.length === 0) return;
    evacEngRef.current?.destroy();
    const config: PolygonSimConfig = {
      vertices: projectedVerts,
      pedestrianCount,
      pedestrianRadius: DEFAULT_POLYGON_CONFIG.pedestrianRadius,
      desiredSpeed: DEFAULT_POLYGON_CONFIG.desiredSpeed,
      panicFactor: DEFAULT_POLYGON_CONFIG.panicFactor,
      // The shared sim clock counts crowd time in FIXED_DT steps.
      dt: FX.FIXED_DT,
    };
    // Convert interior walls to engine format
    const iwDefs = interiorWalls.map((w) => ({
      id: w.id,
      startX: w.start.x,
      startY: w.start.y,
      endX: w.end.x,
      endY: w.end.y,
      hasDoor: w.hasDoor,
      doorWidth: w.doorWidth,
      doorPosition: w.doorPosition,
      level: w.level,
      openFraction: w.openFraction,
      fireRatingMin: w.fireRatingMin,
      doorExposedSec: w.doorExposedSec,
      doorFailed: w.doorFailed,
      doorPinned: w.doorPinned,
    }));
    const multi = levels.length > 1;
    const exitsByLevel: Record<string, ExitDef[]> = {};
    const wallsByLevel: Record<string, typeof iwDefs> = {};
    if (multi) {
      for (const lv of levels) {
        const plan = effectiveLevelPlan(lv.id, levels, { walls: interiorWalls, exits });
        exitsByLevel[lv.id] = plan.exits;
        wallsByLevel[lv.id] = plan.walls.map((w) => ({
          id: w.id,
          startX: w.start.x,
          startY: w.start.y,
          endX: w.end.x,
          endY: w.end.y,
          hasDoor: w.hasDoor,
          doorWidth: w.doorWidth,
          doorPosition: w.doorPosition,
          level: lv.id,
          openFraction: w.openFraction,
          fireRatingMin: w.fireRatingMin,
          doorExposedSec: w.doorExposedSec,
          doorFailed: w.doorFailed,
          doorPinned: w.doorPinned,
        }));
      }
    }

    const obstacles = showcase
      ? casualtyPins.map((c) => ({ x: c.pos.x, y: c.pos.y, radius: 1.5 }))
      : [
          ...hazardZones.map((hz) => ({ x: hz.pos.x, y: hz.pos.y, radius: hz.radius })),
          ...casualtyPins.map((c) => ({ x: c.pos.x, y: c.pos.y, radius: 1.5 })),
        ];

    const zones = rtsRef.current.state.equipment
      .filter((e) => e.def.kind === 'assembly_point' && e.active)
      .map((e) => ({
        id: e.id,
        pos: e.pos,
        radius: e.def.radius,
        label: e.def.label,
        kind: zoneKinds[e.id] ?? ('assembly' as const),
      }));
    evacEngRef.current = new PolygonEvacuationEngine(
      config,
      exits,
      iwDefs,
      obstacles,
      showcase
        ? {
            afterExit,
            zones,
            seed: SHOWCASE.RNG_SEED,
            buildingHeightM: aboveGroundHeightM(selectedGrid?.floors),
          }
        : undefined,
      multi
        ? {
            ids: levels.map((l) => l.id),
            exitsByLevel,
            wallsByLevel,
            stairs: stairwells.map((sw) => normaliseStairwell(sw, levels)),
            counts: Object.fromEntries(
              levels.map((l) => [
                l.id,
                l.pedestrianCount > 0 ? l.pedestrianCount : l.id === 'G' ? pedestrianCount : 0,
              ]),
            ),
            heights: Object.fromEntries(levels.map((l) => [l.id, l.heightM])),
          }
        : undefined,
    );
    if (multi) evacEngRef.current.setBlastLevel(blastLevel);
    if (showcase) evacEngRef.current.setInteriorWalls(iwDefs);
    rtsRef.current.setBuildingVertices(projectedVerts);
    rtsRef.current.setExits(exits);
    setPedestrians(evacEngRef.current.getSnapshots());
  }, [
    projectedVerts,
    exits,
    pedestrianCount,
    interiorWalls,
    hazardZones,
    casualtyPins,
    levels,
    stairwells,
    blastLevel,
    showcase,
    afterExit,
    zoneKinds,
    selectedGrid,
  ]);

  // Keep engine exits in sync when exits change (for pathfinding)
  useEffect(() => {
    rtsRef.current.setExits(exits);
  }, [exits]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phase !== 'rts') return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape' && placeObjectRef.current) {
        e.preventDefault();
        placeObjectRef.current = false;
        setPlacingObject(false);
        return;
      }
      if (e.key === 'Escape' && rtsRef.current.state.interactionMode.type !== 'select') {
        e.preventDefault();
        rtsRef.current.setInteractionMode({ type: 'select' });
        rerender();
        return;
      }
      if (e.key !== 'PageUp' && e.key !== 'PageDown') return;
      e.preventDefault();
      const ids = sortLevels(levelsRef.current.map((l) => l.id));
      setActiveLevel((cur) => {
        const i = Math.max(0, ids.indexOf(cur));
        const next =
          e.key === 'PageUp' ? ids[Math.min(ids.length - 1, i + 1)] : ids[Math.max(0, i - 1)];
        return next ?? cur;
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, rerender]);

  // ── Canvas toSim helper ───────────────────────────────────────────────
  const toSim = useCallback((cx: number, cy: number): Vec2 => {
    const rc = renderCtxRef.current;
    if (!rc) return { x: 0, y: 0 };
    return rcToSim(cx, cy, rc);
  }, []);

  // ── Recompute render context from map ─────────────────────────────────
  const updateRenderCtx = useCallback(() => {
    const map = leafletMapRef.current;
    if (!map || !selectedGrid || projectedVerts.length < 3) {
      renderCtxRef.current = null;
      return;
    }
    renderCtxRef.current = computeMapRenderContext(map, selectedGrid.polygon, projectedVerts);
  }, [selectedGrid, projectedVerts]);
  const paneRenderCtx = useCallback(
    (map: L.Map): RenderContext | null =>
      selectedGrid && projectedVerts.length >= 3
        ? computeMapRenderContext(map, selectedGrid.polygon, projectedVerts)
        : null,
    [selectedGrid, projectedVerts],
  );

  // ── Refs for animation loop (avoid stale closures & constant recreation) ──
  const exitsRef = useRef(exits);
  exitsRef.current = exits;
  placedObjectsRef.current = placedObjects;
  placeObjectRef.current = placingObject;
  const projectedVertsRef = useRef(projectedVerts);
  projectedVertsRef.current = projectedVerts;
  const wallPointsRef = useRef(wallPoints);
  wallPointsRef.current = wallPoints;
  const activeWallPointRef = useRef(activeWallPoint);
  activeWallPointRef.current = activeWallPoint;
  const pedestriansRef = useRef(pedestrians);
  pedestriansRef.current = pedestrians;
  const plantedItemsRef = useRef(plantedItems);
  plantedItemsRef.current = plantedItems;
  const casualtyPinsRef = useRef(casualtyPins);
  casualtyPinsRef.current = casualtyPins;
  const activeCasualtyRef = useRef(activeCasualtyPin);
  activeCasualtyRef.current = activeCasualtyPin;
  const interiorWallsRef = useRef(interiorWalls);
  interiorWallsRef.current = interiorWalls;
  const hazardZonesRef = useRef(hazardZones);
  hazardZonesRef.current = hazardZones;
  const blastDirectZoneRef = useRef<HazardZone | null>(null);
  const stairwellsRef = useRef(stairwells);
  stairwellsRef.current = stairwells;
  const levelsRef = useRef(levels);
  levelsRef.current = levels;
  /** A unit placed in a multi-storey scene stands on the storey in view. */
  const unitLevel = () => (levelsRef.current.length > 1 ? activeLevelRef.current : undefined);
  const activeLevelRef = useRef(activeLevel);
  activeLevelRef.current = activeLevel;
  const blastLevelRef = useRef(blastLevel);
  blastLevelRef.current = blastLevel;
  const blastSiteRef = useRef(blastSite);
  blastSiteRef.current = blastSite;
  growFieldRef.current = (sim) => {
    const grid = selectedGridRef.current;
    const fetched = fetchResultRef.current;
    if (!grid || !fetched) return null;
    const cover = placementCover(
      blastSiteRef.current,
      blastRadiusRef.current,
      hazardZonesRef.current,
      placedObjectsRef.current,
    );
    cover.push({ x: sim.x, y: sim.y });
    const next = generateSceneStuds(
      grid.polygon,
      grid.buildingIndex,
      grid.floors,
      cover,
      grid.studs.map((stud) => [stud.lat, stud.lng] as [number, number]),
    );
    if (next.length === grid.studs.length) return null;
    setFetchResult({
      ...fetched,
      grids: fetched.grids.map((item) =>
        item.buildingIndex === grid.buildingIndex ? { ...item, studs: next } : item,
      ),
    });
    return projectSceneStuds(grid.polygon, next);
  };
  const hoverSimPosRef = useRef<Vec2 | null>(null);
  const gpsSimPosRef = useRef(gpsSimPos);
  gpsSimPosRef.current = gpsSimPos;
  const gpsAccuracyRef = useRef(gpsAccuracy);
  gpsAccuracyRef.current = gpsAccuracy;
  const showStudGridRef = useRef(showStudGrid);
  showStudGridRef.current = showStudGrid;
  const gameZonesRef = useRef(gameZones);
  gameZonesRef.current = gameZones;
  const showGameZonesRef = useRef(showGameZones);
  showGameZonesRef.current = showGameZones;

  // ── Fire simulation ────────────────────────────────────────────────────
  const effectsEngineRef = useRef<SpatialEffectsEngine | null>(null);
  const [effectStates, setEffectStates] = useState<Map<string, StudEffectState> | null>(null);
  const effectStatesRef = useRef(effectStates);
  effectStatesRef.current = effectStates;
  const [hazardRuntimeStates, setHazardRuntimeStates] = useState<Map<
    string,
    { phase: HazardPhase; phaseDescription: string }
  > | null>(null);
  const [effectPreviewTime, setEffectPreviewTime] = useState(300);
  const [effectCalibrating, setEffectCalibrating] = useState(false);
  const [fireParams, setFireParams] = useState<(FireParams & { reasoning?: string }) | null>(null);
  const [detonationLoading, setDetonationLoading] = useState(false);

  // ── Main animation loop ───────────────────────────────────────────────
  const loop = useCallback(
    (time: number) => {
      const dt = lastTimeRef.current ? (time - lastTimeRef.current) / 1000 : 0;
      lastTimeRef.current = time;
      const simStartMs = performance.now();

      const rts = rtsRef.current;
      const clock = rts.state.clock;
      const showcaseOn = showcaseRef.current;

      const evac = evacEngRef.current;
      const effectsEng = effectsEngineRef.current;
      const simRunning = !clock.paused && clock.phase !== 'setup';
      const sharedSteps = simRunning && (evac != null || effectsEng != null);
      if (!sharedSteps) {
        rts.tick(clock.phase === 'setup' || clock.paused ? dt : cappedFrameDt(dt, clock.speed));
      }
      if (evac && simRunning && showcaseOn) {
        const liveEffects = effectsEngineRef.current;
        if (liveEffects) {
          evac.setHazardStates(liveEffects.studStates);
          evac.setShaftColumns(liveEffects.shaftColumns());
        }
        evac.syncExits(exitsRef.current);
        evac.setZones(
          rts.state.equipment
            .filter((e) => e.def.kind === 'assembly_point' && e.active)
            .map((e) => ({
              id: e.id,
              pos: e.pos,
              radius: e.def.radius,
              label: e.def.label,
              kind: zoneKindsRef.current[e.id] ?? 'assembly',
            })),
        );
        evac.setResponders(
          rts.state.units
            .filter((u) => u.def.abilities.includes('unfreeze'))
            .map((u) => ({ id: u.id, pos: u.pos, level: u.level })),
        );
      }

      const walls = interiorWallsRef.current;
      const hazards = hazardsForEffects(hazardZonesRef.current, blastDirectZoneRef.current);
      if (effectsEng && simRunning) {
        const studsNow = simStudsRef.current;
        if (effectsEng.studStates.size < studsNow.length) {
          effectsEng.extendStuds(
            studsNow.map((stud) => ({
              id: stud.id,
              simPos: stud.simPos,
              spatialContext: stud.spatialContext,
              level: storeyId(stud.floor),
            })),
          );
          const grouped = new Map<string, Array<{ id: string; simPos: Vec2; indoor: boolean }>>();
          for (const stud of studsNow) {
            const level = storeyId(stud.floor);
            const list = grouped.get(level) ?? [];
            list.push({
              id: stud.id,
              simPos: stud.simPos,
              indoor: stud.spatialContext === 'inside_building',
            });
            grouped.set(level, list);
          }
          const fields = new Map<string, HazardField>();
          for (const [id, list] of grouped) fields.set(id, new HazardField(list, 3));
          evacEngRef.current?.setHazardFields(fields);
          const ground = fields.get('G') ?? new HazardField([], 3);
          hazardFieldRef.current = ground;
          evacEngRef.current?.setHazardField(ground);
        }
        effectsEng.setHoodFanWhen(hoodFanWhenRef.current);
        effectsEng.setWind(windRef.current.speedMs, windRef.current.directionRad);
        effectsEng.setFuelCells(fuelCellsFor(placedObjectsRef.current, simStudsRef.current));
        effectsEng.setStoreyHeights(
          Object.fromEntries(levelsRef.current.map((level) => [level.id, level.heightM])),
        );
        effectsEng.setBuildingEnvelope(projectedVertsRef.current, exitsRef.current);
        syncIgnition(
          effectsEng,
          placedObjectsRef.current,
          hazardZonesRef.current,
          chargeRef.current,
          levelsRef.current,
        );
      }

      let effectSteps = 0;
      if (sharedSteps) {
        const blastStep = Math.round(SHOWCASE.BLAST_AT_GAME_S / FX.FIXED_DT);
        const fireBlast = () => {
          blastFiredRef.current = true;
          const site = blastSiteRef.current;
          if (site && evac) {
            const manual = manualRadiusRef.current;
            const spec = chargeRef.current;
            evac.triggerBlast(
              site,
              manual
                ? blastRadiusRef.current
                : {
                    mode: 'pressure',
                    spec,
                    heightM: spec.burst === 'free_air' ? spec.heightM : 0,
                  },
            );
          }
          explosionStartRef.current = performance.now();
          setBanner({
            until: performance.now() + SHOWCASE.BANNER_S * 1000,
            text: `EXPLOSION · ${rts.formatClock()}`,
          });
        };
        const ran = advanceGameFrame(
          rts,
          simClockRef.current,
          dt,
          clock.speed,
          {
            beforeSteps: evac
              ? (doorDt) => {
                  const bodies = pedestriansRef.current
                    .filter((person) => person.state !== 'left_map')
                    .map((person) => ({ x: person.x, y: person.y, level: person.level }));
                  stepDoorLeaves(
                    walls,
                    bodies,
                    effectsEng?.exposedDoorIds() ?? new Set<string>(),
                    doorDt,
                    MOUTH_APPROACH_M,
                  );
                  evac.syncDoorLeaves(walls);
                }
              : undefined,
            crowdStep: evac
              ? (stepNo) => {
                  if (showcaseOn && !blastFiredRef.current && stepNo >= blastStep) fireBlast();
                  evac.step();
                }
              : undefined,
            effectsStep: effectsEng
              ? () => effectsEng.step(FX.EFFECTS_DT, walls, hazards)
              : undefined,
          },
          { budgetMs: FX.SIM_BUDGET_MS, now: () => performance.now() },
        );
        effectSteps = ran.effectSteps;
        const meter = speedMeterRef.current;
        const speedBefore = meter.speed;
        if (
          noteFrameSpeed(meter, clock.speed, dt, ran.crowdSteps * FX.FIXED_DT) ||
          meter.speed !== speedBefore
        ) {
          const label = speedLabel(clock.speed, meter.effective);
          const slowed = label === `${clock.speed}x` ? null : label;
          setSlowedSpeed((prev) => (prev === slowed ? prev : slowed));
        }
      }

      if (evac && simRunning) {
        const snaps = evac.getSnapshots();
        pedestriansRef.current = snaps;
        setPedestrians(snaps);
        if (performance.now() - stairHudAtRef.current >= 250) {
          stairHudAtRef.current = performance.now();
          setStairFlights(evac.getStairFlights());
        }
        if (showcaseOn && performance.now() - hudAtRef.current >= 250) {
          hudAtRef.current = performance.now();
          const stats = effectsEngineRef.current?.getStats();
          setShowcaseHud({
            metrics: evac.getMetrics().showcase ?? null,
            burning: stats?.fire.burning ?? 0,
            smoke: stats?.smokeAffected ?? 0,
          });
        }
      }

      if (effectsEng && simRunning) {
        const effectDt = effectSteps * FX.EFFECTS_DT;
        effectStatesRef.current = new Map(effectsEng.studStates);
        if (effectSteps > 0 || smokeLayersRef.current.engine !== effectsEng) {
          smokeLayersRef.current = { engine: effectsEng, layers: effectsEng.smokeLayers() };
        }
        const jetCount = effectsEng.gasJets().length;
        setGasJetCount((prev) => (prev === jetCount ? prev : jetCount));
        const liveArcs = effectsEng.electricalArcs().length;
        setArcCount((prev) => (prev === liveArcs ? prev : liveArcs));
        const liveSprays = effectsEng.sprays().length;
        setSprayCount((prev) => (prev === liveSprays ? prev : liveSprays));

        // Casualty deterioration based on spatial effects
        const eStates = effectsEng.studStates;
        let pinsChanged = false;
        const updatedPins = casualtyPinsRef.current.map((pin) => {
          const nearest = simStudsRef.current.reduce<{ id: string; dist: number } | null>(
            (best, s) => {
              const d = Math.hypot(s.simPos.x - pin.pos.x, s.simPos.y - pin.pos.y);
              return !best || d < best.dist ? { id: s.id, dist: d } : best;
            },
            null,
          );
          if (!nearest || nearest.dist > 8) return pin;
          const es = eStates.get(nearest.id);
          if (!es) return pin;

          let dRate = 0;
          if (es.fire.state === 'burning') dRate += effectDt * 0.008;
          else if (es.fire.state === 'heating') dRate += effectDt * 0.003;
          if (es.gas > 0.1) dRate += effectDt * 0.002 * es.gas;
          if (es.flood > 0.3) dRate += effectDt * 0.001 * es.flood;

          if (dRate <= 0) return pin;
          pinsChanged = true;
          const newLevel = Math.min(1, pin.deteriorationLevel + dRate);
          let newTag = pin.currentTag;
          if (pin.currentTag === 'green' && newLevel >= 0.3) newTag = 'yellow';
          if ((pin.currentTag === 'green' || pin.currentTag === 'yellow') && newLevel >= 0.6)
            newTag = 'red';
          if (pin.currentTag !== 'black' && newLevel >= 0.9) newTag = 'black';
          return { ...pin, deteriorationLevel: newLevel, currentTag: newTag };
        });
        if (pinsChanged) casualtyPinsRef.current = updatedPins;
      }

      const simMs = performance.now() - simStartMs;
      updateRenderCtx();

      const fillFxCtx = (fxCtx: HazardFxContext, level: string) => {
        const layout = activeRasterLayout(
          rasterCacheRef.current,
          simStudsRef.current,
          3,
          levelsRef.current.length > 1,
          level,
        );
        fxCtx.quality = fxQualityRef.current;
        fxCtx.reducedMotion = reducedMotionRef.current;
        fxCtx.nowMs = performance.now();
        fxCtx.layout = layout;
        fxCtx.states = effectsEngineRef.current?.studStates ?? null;
        const layerSnap = smokeLayersRef.current;
        fxCtx.layers =
          layerSnap.engine != null && layerSnap.engine === effectsEngineRef.current
            ? layerSnap.layers
            : null;
        fxCtx.buildingVerts = projectedVertsRef.current;
        fxCtx.cellM = 3;
        return layout;
      };

      const drawLevelView = (
        ctx: CanvasRenderingContext2D,
        w: number,
        h: number,
        viewRc: RenderContext,
        level: string,
        hazardFx: { renderer: HazardFxRenderer; ctx: HazardFxContext } | null,
      ) => {
        const planted = new Set(plantedItemsRef.current.map((p) => p.wallPointId));
        const discovered = new Set(
          plantedItemsRef.current.filter((p) => p.discovered).map((p) => p.wallPointId),
        );
        renderRTS(
          ctx,
          w,
          h,
          viewRc,
          rts.state,
          projectedVertsRef.current,
          exitsRef.current,
          pedestriansRef.current,
          true,
          wallPointsRef.current,
          activeWallPointRef.current?.id ?? null,
          planted,
          discovered,
          [],
          null,
          casualtyPinsRef.current,
          activeCasualtyRef.current?.id ?? null,
          interiorWallsRef.current,
          showcaseOn && !blastFiredRef.current
            ? hazardZonesRef.current.filter((h) => h.id !== 'blast-direct')
            : hazardZonesRef.current,
          stairwellsRef.current,
          showcaseOn && rts.state.clock.phase !== 'setup' && !blastFiredRef.current
            ? null
            : levelsRef.current.length > 1 && blastLevelRef.current !== level
              ? null
              : blastSiteRef.current,
          showGameZonesRef.current ? gameZonesRef.current : undefined,
          (() => {
            const mode = rtsRef.current.state.interactionMode;
            if (mode.type === 'draw_wall' && mode.startPoint) {
              return {
                start: mode.startPoint,
                cursor: hoverSimPosRef.current ?? mode.startPoint,
              };
            }
            return null;
          })(),
          gpsSimPosRef.current
            ? { pos: gpsSimPosRef.current, accuracy: gpsAccuracyRef.current }
            : null,
          showcaseOn || !showStudGridRef.current
            ? null
            : simStudsRef.current.filter(
                (s) => levelsRef.current.length <= 1 || storeyId(s.floor) === level,
              ),
          effectStatesRef.current,
          showcaseOn ? blastRadiusRef.current : undefined,
          showcaseOn ? false : true,
          showGameZonesRef.current,
          null,
          showcaseOn
            ? {
                hazardStuds: simStudsRef.current.filter(
                  (s) => levelsRef.current.length <= 1 || storeyId(s.floor) === level,
                ),
                effectStates: effectsEngineRef.current?.studStates ?? null,
                cellM: 3,
                explosion: (() => {
                  if (!explosionStartRef.current || !blastSiteRef.current) return null;
                  const ageS = (performance.now() - explosionStartRef.current) / 1000;
                  if (ageS > SHOWCASE.FX_FIREBALL_S) return null;
                  return {
                    pos: blastSiteRef.current,
                    radiusM: blastRadiusRef.current,
                    ageS,
                    reducedMotion: reducedMotionRef.current,
                  };
                })(),
                injuryRings:
                  showcaseOn &&
                  blastSiteRef.current &&
                  (rts.state.clock.phase === 'setup' || blastFiredRef.current)
                    ? showcaseInjuryRings(
                        blastSiteRef.current,
                        manualRadiusRef.current,
                        blastRadiusRef.current,
                        ringsRef.current,
                        rts.state.clock.phase === 'setup' && !blastFiredRef.current,
                      )
                    : null,
                zones: rts.state.equipment
                  .filter((e) => e.def.kind === 'assembly_point' && e.active)
                  .map((e) => ({
                    id: e.id,
                    pos: e.pos,
                    radius: e.def.radius,
                    label: e.def.label,
                    kind: zoneKindsRef.current[e.id] ?? ('assembly' as const),
                  })),
                zoneCounts: evac?.getMetrics().showcase?.arrived ?? {},
                assemblyRingM:
                  rts.state.clock.phase === 'setup'
                    ? assemblyMinDistanceM(aboveGroundHeightM(floorsRef.current))
                    : null,
                hazardFx: hazardFx,
                legend: shownPanesRef.current === 1,
              }
            : null,
          levelsRef.current.length > 1
            ? {
                active: level,
                levels: sortLevels(levelsRef.current.map((l) => l.id)),
                ghostAlpha: LEVEL.GHOST_ALPHA,
                showGhostPeople: true,
              }
            : null,
          placedObjectDraws(placedObjectsRef.current),
          effectsEngineRef.current?.gasJets() ?? null,
          effectsEngineRef.current?.electricalArcs() ?? null,
          effectsEngineRef.current?.sprays() ?? null,
        );
      };

      const canvas = canvasRef.current;
      const rc = renderCtxRef.current;
      if (canvas && rc) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          if (showcaseOn) {
            const fxCtx = hazardFxCtxRef.current;
            rasterLayoutRef.current = fillFxCtx(fxCtx, activeLevelRef.current);
            const renderer = hazardFxRef.current;
            const slot = hazardFxSlotRef.current;
            if (renderer && slot) {
              slot.renderer = renderer;
              slot.ctx = fxCtx;
            } else if (renderer) {
              hazardFxSlotRef.current = { renderer, ctx: fxCtx };
            }
          }
          drawLevelView(
            ctx,
            canvas.width,
            canvas.height,
            rc,
            activeLevelRef.current,
            hazardFxSlotRef.current,
          );
          if (showcaseOn && fxQualityRef.current !== 'classic' && hazardFxRef.current) {
            const sample = hazardFxRef.current.last.ms;
            if (fxWarmupRef.current > 0) {
              fxWarmupRef.current--;
            } else {
              const ring = fxTimesRef.current;
              const frames = fxFrameTimesRef.current;
              const active = fxActiveRef.current;
              const pos = fxTimePosRef.current;
              ring[pos] = sample;
              // The sim budget alone can stretch a frame past FRAME_DOWNGRADE_MS;
              // only the rest of the frame says anything about drawing cost.
              frames[pos] = Math.max(0, dt * 1000 - prevSimMsRef.current);
              active[pos] = hazardFxRef.current.last.covering ? 1 : 0;
              fxTimePosRef.current = (pos + 1) % ring.length;
              if (fxTimeCountRef.current < ring.length) fxTimeCountRef.current++;
              if (fxTimeCountRef.current === ring.length && !fxSuppressRef.current) {
                let drawSum = 0;
                let frameSum = 0;
                let activeFrames = 0;
                for (let i = 0; i < ring.length; i++) {
                  drawSum += ring[i];
                  frameSum += frames[i];
                  activeFrames += active[i];
                }
                const effectsActive = activeFrames * 2 >= ring.length;
                if (
                  shouldAutoDowngrade(drawSum / ring.length, frameSum / ring.length, effectsActive)
                ) {
                  const current = fxQualityRef.current;
                  const next = current === 'high' ? 'low' : current === 'low' ? 'classic' : null;
                  if (next) {
                    fxDowngradeFromRef.current = noteDowngradeFrom(
                      fxDowngradeFromRef.current,
                      current,
                    );
                    fxQualityRef.current = next;
                    setFxQuality(next);
                    setFxDowngraded(true);
                    fxTimeCountRef.current = 0;
                    fxWarmupRef.current = 30;
                    try {
                      localStorage.setItem('rtsFxQuality', next);
                    } catch {
                      /* ignore */
                    }
                  }
                }
              }
            }
          }
          if (fxDebugRef.current && showcaseOn) {
            const classic = fxQualityRef.current === 'classic';
            const stats = classic ? undefined : hazardFxRef.current?.last;
            const fxMs = classic ? 0 : (stats?.ms ?? 0);
            const embers = classic ? 0 : (stats?.embers ?? 0);
            const collisions = rasterLayoutRef.current?.collisions ?? 0;
            const layers = hazardFxCtxRef.current.layers?.length ?? 0;
            const label =
              collisions > 0
                ? `fx ${fxMs.toFixed(2)} · embers ${embers} · layers ${layers} · quality ${fxQualityRef.current} · collisions ${collisions}`
                : `fx ${fxMs.toFixed(2)} · embers ${embers} · layers ${layers} · quality ${fxQualityRef.current}`;
            ctx.save();
            ctx.font = '12px monospace';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'top';
            ctx.fillStyle = 'rgba(0,0,0,0.6)';
            const box = ctx.measureText(label).width + 16;
            // With several panes the level chip and the levels box hold the top of the main pane.
            const top = shownPanesRef.current > 1 ? canvas.height - 48 : 8;
            ctx.fillRect(canvas.width - box - 8, top, box, 20);
            ctx.fillStyle = '#bbf7d0';
            ctx.fillText(label, canvas.width - 16, top + 3);
            ctx.restore();
          }
        }
      }

      const primaryMap = leafletMapRef.current;
      for (const pane of panesRef.current.values()) {
        if (!pane.map || !pane.canvas) continue;
        if (panesLinkedRef.current && primaryMap) {
          const center = primaryMap.getCenter();
          const zoom = primaryMap.getZoom();
          if (pane.map.getZoom() !== zoom || !pane.map.getCenter().equals(center)) {
            pane.map.setView(center, zoom, { animate: false });
          }
        }
        const paneRc = paneRenderCtx(pane.map);
        const paneCtx = pane.canvas.getContext('2d');
        if (!paneRc || !paneCtx) continue;
        let paneFx: { renderer: HazardFxRenderer; ctx: HazardFxContext } | null = null;
        if (showcaseOn) {
          pane.fx ??= new HazardFxRenderer(FX.FX_RNG_SEED);
          pane.fxCtx ??= { ...hazardFxCtxRef.current };
          fillFxCtx(pane.fxCtx, pane.level);
          paneFx = { renderer: pane.fx, ctx: pane.fxCtx };
        }
        drawLevelView(paneCtx, pane.canvas.width, pane.canvas.height, paneRc, pane.level, paneFx);
      }

      prevSimMsRef.current = simMs;
      rerender();
      rafRef.current = requestAnimationFrame(loop);
    },
    [rerender, updateRenderCtx, paneRenderCtx],
  );

  useEffect(() => {
    return () => {
      hazardFxRef.current?.dispose();
      hazardFxRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (phase !== 'rts') return;
    lastTimeRef.current = 0;
    // Leaflet needs to recalculate after layout shift
    setTimeout(() => leafletMapRef.current?.invalidateSize(), 100);
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase, loop]);

  useEffect(() => {
    // A hidden tab gets no frames. Without this, the first frame back spans the
    // whole hidden time and the speed reading shows e.g. "running 0.1x".
    const onVisibility = () => {
      lastTimeRef.current = 0;
      speedMeterRef.current = createSpeedMeter();
      setSlowedSpeed(null);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // ── Wall inspection point click ────────────────────────────────────────
  const handleWallPointClick = useCallback(async (wp: WallInspectionPoint) => {
    setActiveWallPoint(wp);
    setAssessmentText('');

    if (wp.cached && wp.imageUrl) {
      setWallPointImage(wp.imageUrl);
      return;
    }

    if (!GOOGLE_MAPS_KEY) {
      setWallPointImage(null);
      return;
    }

    setWallPointLoading(true);
    setWallPointImage(null);
    const dataUrl = await fetchStreetViewImage(wp, GOOGLE_MAPS_KEY);
    if (dataUrl) {
      wp.imageUrl = dataUrl;
      wp.cached = true;
      wp.imageSource = 'streetview';
      setWallPointImage(dataUrl);
    }
    setWallPointLoading(false);
  }, []);

  const closePhotoCard = useCallback(() => {
    setActiveWallPoint(null);
    setWallPointImage(null);
    setAssessmentText('');
    setAiResponse(null);
  }, []);

  const photoUploadRef = useRef<HTMLInputElement>(null);

  const handlePhotoUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !activeWallPoint) return;
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        activeWallPoint.imageUrl = dataUrl;
        activeWallPoint.cached = true;
        activeWallPoint.imageSource = 'custom';
        setWallPointImage(dataUrl);
        rerender();
      };
      reader.readAsDataURL(file);
      e.target.value = '';
    },
    [activeWallPoint, rerender],
  );

  // ── Plant a threat at the active wall point ───────────────────────────
  const handlePlantItem = useCallback(() => {
    if (!activeWallPoint || !plantDescription.trim()) return;
    const item: PlantedItem = {
      id: `planted-${Date.now()}`,
      wallPointId: activeWallPoint.id,
      description: plantDescription.trim(),
      threatLevel: plantThreatLevel,
      concealmentDifficulty: plantDifficulty,
      discovered: false,
      assessed: false,
      assessmentCorrect: null,
      aiResponse: null,
      detonationTimer: null,
    };
    setPlantedItems((prev) => [...prev, item]);
    setPlantDescription('');
  }, [activeWallPoint, plantDescription, plantThreatLevel, plantDifficulty]);

  const handleRemovePlantedItem = useCallback((itemId: string) => {
    setPlantedItems((prev) => prev.filter((p) => p.id !== itemId));
  }, []);

  // ── Submit assessment to GPT vision ───────────────────────────────────
  const handleSubmitAssessment = useCallback(async () => {
    if (!activeWallPoint || !assessmentText.trim()) return;

    setAssessmentLoading(true);
    setAiResponse(null);

    const plantedAtPoint = plantedItems.find(
      (p) => p.wallPointId === activeWallPoint.id && !p.discovered,
    );

    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(apiUrl('/api/debug/rts-assess'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          imageUrl: wallPointImage || '',
          playerAction: assessmentText.trim(),
          plantedItem: plantedAtPoint
            ? {
                description: plantedAtPoint.description,
                threatLevel: plantedAtPoint.threatLevel,
                concealmentDifficulty: plantedAtPoint.concealmentDifficulty,
              }
            : null,
          context:
            'Bomb squad sweep of building perimeter during crisis exercise. EOD technician is inspecting this section of the building exterior.',
        }),
      });

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        setAiResponse(`Error: ${body.error || resp.statusText}`);
        setAssessmentLoading(false);
        return;
      }

      const { data } = await resp.json();
      setAiResponse(data.response);

      if (data.found && plantedAtPoint) {
        setPlantedItems((prev) =>
          prev.map((p) =>
            p.id === plantedAtPoint.id
              ? {
                  ...p,
                  discovered: true,
                  assessed: true,
                  assessmentCorrect: true,
                  aiResponse: data.response,
                }
              : p,
          ),
        );
      } else if (plantedAtPoint) {
        setPlantedItems((prev) =>
          prev.map((p) =>
            p.id === plantedAtPoint.id
              ? { ...p, assessed: true, assessmentCorrect: false, aiResponse: data.response }
              : p,
          ),
        );
      }
    } catch (err) {
      setAiResponse('Failed to connect to assessment server.');
    }
    setAssessmentLoading(false);
  }, [activeWallPoint, assessmentText, wallPointImage, plantedItems]);

  // ── Casualty pin handlers ────────────────────────────────────────────
  const handleCasualtyPinClick = useCallback((pin: CasualtyPin) => {
    setActiveCasualtyPin(pin);
  }, []);

  // ── Canvas mouse handlers ─────────────────────────────────────────────
  const dragStartRef = useRef<Vec2 | null>(null);
  const isDraggingRef = useRef(false);
  const elementDragRef = useRef<{ type: string; id: string } | null>(null);
  /**
   * Map pan gesture. Middle-drag and Space+left-drag pan at once; a right
   * press in select mode only pans once it moves past PAN_THRESHOLD_PX, so a
   * still right-click still issues the move order on release.
   */
  const mapPanRef = useRef<{
    button: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    active: boolean;
    sim: Vec2;
    shift: boolean;
  } | null>(null);
  const spaceHeldRef = useRef(false);
  const suppressClickRef = useRef(false);
  const [panCursor, setPanCursor] = useState<'none' | 'grab' | 'grabbing'>('none');

  const placeVerticalLink = useCallback((pos: Vec2, stud: SimStud | null) => {
    const lv = levelsRef.current;
    if (stairwellsRef.current.length >= 40) return;
    if (
      projectedVertsRef.current.length >= 3 &&
      !isInsidePolygon(pos.x, pos.y, projectedVertsRef.current)
    ) {
      return;
    }
    const sorted = sortLevels(lv.map((l) => l.id));
    const from = activeLevelRef.current;
    const idx = sorted.indexOf(from);
    if (idx < 0) return;
    const to = sorted[idx + 1] ?? sorted[idx - 1];
    if (!to || to === from) return;
    const kind = placeLinkKindRef.current;
    setStairwells((prev) => {
      const draft: Stairwell = {
        id: `sw-${Date.now()}`,
        pos,
        connectsFloors: [0, 1],
        blocked: false,
        label: `${kind === 'lift' ? 'Lift' : 'Stair'} ${prev.length + 1}`,
        kind,
        widthM: LEVEL.DEFAULT_STAIR_WIDTH_M,
        levels: { from, to },
        studId: stud?.id,
        insideBuilding: stud ? stud.spatialContext === 'inside_building' : undefined,
        spatialContext: stud?.spatialContext ?? undefined,
      };
      return [...prev, normaliseStairwell(draft, lv)];
    });
  }, []);

  // Hit-test draggable elements in setup mode
  const findDraggableAt = useCallback((sim: Vec2): { type: string; id: string } | null => {
    const state = rtsRef.current.state;

    // Staging area is always draggable (IC action) when it exists
    if (
      state.stagingArea &&
      Math.hypot(sim.x - state.stagingArea.x, sim.y - state.stagingArea.y) < 5
    )
      return { type: 'stagingArea', id: 'staging' };

    // Other elements only draggable in trainer setup mode
    if (state.clock.phase !== 'setup') return null;
    const here = (level?: string) => (level ?? 'G') === activeLevelRef.current;
    const bs = blastSiteRef.current;
    if (bs && here(blastLevelRef.current) && Math.hypot(sim.x - bs.x, sim.y - bs.y) < 4)
      return { type: 'blastSite', id: 'blast' };
    for (const c of casualtyPinsRef.current) {
      if (!here(c.level)) continue;
      if (Math.hypot(c.pos.x - sim.x, c.pos.y - sim.y) < 8) return { type: 'casualty', id: c.id };
    }
    for (const hz of hazardZonesRef.current) {
      if (!here(hz.level)) continue;
      if (Math.hypot(hz.pos.x - sim.x, hz.pos.y - sim.y) < Math.max(hz.radius, 8))
        return { type: 'hazard', id: hz.id };
    }
    for (const sw of stairwellsRef.current) {
      if (!linkLevels(sw, levelsRef.current).includes(activeLevelRef.current)) continue;
      if (Math.hypot(sw.pos.x - sim.x, sw.pos.y - sim.y) < 5)
        return { type: 'stairwell', id: sw.id };
    }
    return null;
  }, []);

  const applyElementDrag = useCallback(
    (drag: { type: string; id: string }, sim: Vec2) => {
      const snapped = snapToStud(sim);
      const sp = snapped.pos;
      const studMeta = snapped.stud
        ? {
            studId: snapped.stud.id,
            insideBuilding: snapped.stud.spatialContext === 'inside_building',
            spatialContext: snapped.stud.spatialContext ?? undefined,
          }
        : {};
      if (drag.type === 'blastSite') setBlastSite(sp);
      else if (drag.type === 'stagingArea') rtsRef.current.setStagingArea(sp);
      else if (drag.type === 'casualty')
        setCasualtyPins((prev) =>
          prev.map((c) => (c.id === drag.id ? { ...c, pos: { ...sp }, ...studMeta } : c)),
        );
      else if (drag.type === 'hazard')
        setHazardZones((prev) =>
          prev.map((h) => (h.id === drag.id ? { ...h, pos: { ...sp }, ...studMeta } : h)),
        );
      else if (drag.type === 'stairwell')
        setStairwells((prev) =>
          prev.map((s) => (s.id === drag.id ? { ...s, pos: { ...sp }, ...studMeta } : s)),
        );
    },
    [snapToStud],
  );

  const handleCanvasMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!renderCtxRef.current) return;
      const rect = canvasRef.current!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const sim = toSim(cx, cy);

      const rts = rtsRef.current;
      const mode = rts.state.interactionMode;

      const startPan = (active: boolean) => {
        mapPanRef.current = {
          button: e.button,
          startX: e.clientX,
          startY: e.clientY,
          lastX: e.clientX,
          lastY: e.clientY,
          active,
          sim,
          shift: e.shiftKey,
        };
        if (active) setPanCursor('grabbing');
      };

      if (e.button === 1 || (e.button === 0 && spaceHeldRef.current)) {
        e.preventDefault();
        startPan(true);
        return;
      }

      if (placeObjectRef.current && e.button === 0) return;

      if (mode.type === 'select') {
        if (e.button === 2) {
          e.preventDefault();
          startPan(false);
          return;
        }

        // Check for draggable element
        const hit = findDraggableAt(sim);
        if (hit) {
          elementDragRef.current = hit;
          isDraggingRef.current = false;
          dragStartRef.current = sim;
          return;
        }

        dragStartRef.current = sim;
        isDraggingRef.current = false;
      }
    },
    [toSim, findDraggableAt],
  );

  const handleCanvasMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!renderCtxRef.current) return;
      const rect = canvasRef.current!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const sim = toSim(cx, cy);
      hoverSimPosRef.current = sim;

      // Map panning runs from window listeners so it survives leaving the canvas.
      if (mapPanRef.current) return;

      // Element dragging
      if (elementDragRef.current && dragStartRef.current) {
        const moved = Math.hypot(sim.x - dragStartRef.current.x, sim.y - dragStartRef.current.y);
        if (moved > 1) {
          isDraggingRef.current = true;
          applyElementDrag(elementDragRef.current, sim);
        }
        return;
      }

      const rts = rtsRef.current;
      if (dragStartRef.current && rts.state.interactionMode.type === 'select') {
        const dragDist = Math.hypot(sim.x - dragStartRef.current.x, sim.y - dragStartRef.current.y);
        if (dragDist > 2) {
          isDraggingRef.current = true;
          rts.state.selection.selectionBox = { start: dragStartRef.current, end: sim };
        }
      }
    },
    [toSim, applyElementDrag],
  );

  const handleCanvasMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (mapPanRef.current) return;

      if (!renderCtxRef.current) return;
      const rect = canvasRef.current!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const sim = toSim(cx, cy);
      const rts = rtsRef.current;
      const mode = rts.state.interactionMode;

      if (placeObjectRef.current && e.button === 0) {
        const snapped = snapToStud(sim);
        if (!snapped.stud) {
          setObjectNotice('Click a stud.');
          return;
        }
        const id = `obj-${++objectIdRef.current}`;
        const stud = snapped.stud;
        setPlacedObjects((prev) => [
          ...prev,
          {
            id,
            studId: stud.id,
            pos: snapped.pos,
            level: activeLevelRef.current,
            description: '',
            matches: [],
            confirmed: false,
          },
        ]);
        setActiveObjectId(id);
        setPlacingObject(false);
        placeObjectRef.current = false;
        setObjectNotice(null);
        return;
      }

      // Stud inspect mode
      if (studInspectMode) {
        const studs = simStudsRef.current;
        let nearest: SimStud | null = null;
        let nearestDist = Infinity;
        for (const s of studs) {
          const d = Math.hypot(s.simPos.x - sim.x, s.simPos.y - sim.y);
          if (d < nearestDist) {
            nearestDist = d;
            nearest = s;
          }
        }
        if (nearest && nearestDist < 10) {
          setInspectedStud(nearest);
        } else {
          setInspectedStud(null);
        }
        return;
      }

      // Finalize element drag — if no actual movement, fall through to click handling
      if (elementDragRef.current) {
        if (isDraggingRef.current) {
          applyElementDrag(elementDragRef.current, sim);
          elementDragRef.current = null;
          dragStartRef.current = null;
          isDraggingRef.current = false;
          return;
        }
        // No movement — treat as a click on the element
        const clickedElement = elementDragRef.current;
        elementDragRef.current = null;
        dragStartRef.current = null;
        isDraggingRef.current = false;

        if (clickedElement.type === 'stairwell') {
          setSelectedStairId(clickedElement.id);
          return;
        }
        if (clickedElement.type === 'hazard') {
          const hz = hazardZonesRef.current.find((h) => h.id === clickedElement.id);
          if (hz) {
            setActiveHazard(hz);
            return;
          }
        }
        if (clickedElement.type === 'casualty') {
          const cas = casualtyPinsRef.current.find((c) => c.id === clickedElement.id);
          if (cas) {
            handleCasualtyPinClick(cas);
            return;
          }
        }
        // For other elements (blast, staging, stairwell) — just deselect
        return;
      }

      if (mode.type === 'select') {
        if (isDraggingRef.current && dragStartRef.current) {
          rts.selectUnitsInBox(dragStartRef.current, sim);
        } else {
          // Check casualty clusters
          const hitCas = casualtyPinsRef.current.find(
            (c) =>
              (c.level ?? 'G') === activeLevelRef.current &&
              Math.hypot(c.pos.x - sim.x, c.pos.y - sim.y) < 8,
          );
          if (hitCas) {
            handleCasualtyPinClick(hitCas);
            rts.state.selection.selectionBox = null;
            dragStartRef.current = null;
            isDraggingRef.current = false;
            return;
          }

          const hitObj = placedObjectsRef.current.find(
            (obj) =>
              (obj.level ?? 'G') === activeLevelRef.current &&
              Math.hypot(obj.pos.x - sim.x, obj.pos.y - sim.y) < 2.5,
          );
          if (hitObj) {
            if (
              rts.state.clock.phase !== 'setup' &&
              hitObj.confirmed &&
              hitObj.matches.some((match) => match.behaviour === 'pressurised_gas') &&
              effectsEngineRef.current?.isJetting(hitObj.id)
            ) {
              effectsEngineRef.current.shutOffGas(hitObj.id);
              setGasJetCount(effectsEngineRef.current.gasJets().length);
            }
            if (
              rts.state.clock.phase !== 'setup' &&
              hitObj.confirmed &&
              hitObj.matches.some((match) => match.behaviour === 'electrical') &&
              effectsEngineRef.current?.isArcing(hitObj.id)
            ) {
              effectsEngineRef.current.shutOffPower(hitObj.id);
              setArcCount(effectsEngineRef.current.electricalArcs().length);
            }
            setActiveObjectId(hitObj.id);
            rts.state.selection.selectionBox = null;
            dragStartRef.current = null;
            isDraggingRef.current = false;
            return;
          }

          // Check hazard pins (click to inspect)
          const hitHz = hazardZonesRef.current.find(
            (hz) =>
              (hz.level ?? 'G') === activeLevelRef.current &&
              Math.hypot(hz.pos.x - sim.x, hz.pos.y - sim.y) < Math.max(hz.radius, 8),
          );
          if (hitHz) {
            setActiveHazard(hitHz);
            rts.state.selection.selectionBox = null;
            dragStartRef.current = null;
            isDraggingRef.current = false;
            return;
          }

          // Check exits (click to inspect)
          const hitExit = exitsRef.current.find(
            (ex) =>
              (ex.level ?? 'G') === activeLevelRef.current &&
              Math.hypot(ex.center.x - sim.x, ex.center.y - sim.y) < Math.max(ex.width, 4),
          );
          if (hitExit) {
            setActiveExit(hitExit);
            rts.state.selection.selectionBox = null;
            dragStartRef.current = null;
            isDraggingRef.current = false;
            return;
          }

          // Check interior walls (click to inspect)
          const hitWall = interiorWallsRef.current.find((w) => {
            if ((w.level ?? 'G') !== activeLevelRef.current) return false;
            const mx = (w.start.x + w.end.x) / 2;
            const my = (w.start.y + w.end.y) / 2;
            return Math.hypot(mx - sim.x, my - sim.y) < 5;
          });
          if (hitWall) {
            setActiveWall(hitWall);
            rts.state.selection.selectionBox = null;
            dragStartRef.current = null;
            isDraggingRef.current = false;
            return;
          }

          const hitStair = stairwellsRef.current.find(
            (sw) =>
              linkLevels(sw, levelsRef.current).includes(activeLevelRef.current) &&
              Math.hypot(sw.pos.x - sim.x, sw.pos.y - sim.y) < 5,
          );
          if (hitStair) {
            setSelectedStairId(hitStair.id);
            rts.state.selection.selectionBox = null;
            dragStartRef.current = null;
            isDraggingRef.current = false;
            return;
          }

          // Check wall inspection points
          const hitWp = wallPoints.find(
            (wp) => Math.hypot(wp.simPos.x - sim.x, wp.simPos.y - sim.y) < 3.0,
          );
          if (hitWp) {
            handleWallPointClick(hitWp);
            rts.state.selection.selectionBox = null;
            dragStartRef.current = null;
            isDraggingRef.current = false;
            return;
          }

          const unit = rts.findUnitAt(sim);
          if (unit) {
            rts.selectUnit(unit.id, e.shiftKey);
          } else {
            rts.deselectAll();
          }
        }
        rts.state.selection.selectionBox = null;
        dragStartRef.current = null;
        isDraggingRef.current = false;
        return;
      }

      if (e.button !== 0) return;

      if (mode.type === 'place_staging') {
        rts.setStagingArea(sim);
        rts.setInteractionMode({ type: 'select' });
        return;
      }

      if (mode.type === 'spawn_unit') {
        const spawnPos = rts.state.stagingArea ?? sim;
        const u = rts.spawnUnit(mode.unitKind, spawnPos, unitLevel());
        if (rts.state.stagingArea) {
          rts.issueMove([u.id], sim, false);
        }
        rts.setInteractionMode({ type: 'select' });
        return;
      }

      if (mode.type === 'place_equipment') {
        const selected = rts.getSelectedUnits();
        const placer = selected.length > 0 ? selected[0].id : 'system';
        rts.placeEquipment(mode.equipmentKind, sim, placer);
        rts.setInteractionMode({ type: 'select' });
        return;
      }

      if (mode.type === 'place_exit') {
        if (projectedVerts.length < 3) return;
        const snap = nearestEdge(sim.x, sim.y, projectedVerts);
        const maxW = edgeLength(projectedVerts, snap.edgeIndex) * 0.9;
        const w = Math.min(newExitWidth, maxW);
        const id = `exit-${++exitIdCounter}`;
        setExits((prev) => [
          ...prev,
          {
            id,
            center: snap.point,
            width: w,
            edgeIndex: snap.edgeIndex,
            description: '',
            status: 'unknown' as const,
            photos: [],
            level: activeLevelRef.current,
          },
        ]);
        return;
      }

      if (mode.type === 'draw_wall') {
        const snapped = snapWallEnd(sim);
        if (!mode.startPoint) {
          rts.setInteractionMode({ type: 'draw_wall', startPoint: snapped.pos });
        } else {
          setInteriorWalls((prev) => [
            ...prev,
            {
              id: `iw-${Date.now()}`,
              start: mode.startPoint!,
              end: snapped.pos,
              hasDoor: false,
              doorWidth: 1.5,
              doorPosition: 0.5,
              description: '',
              material: '',
              photos: [],
              studId: snapped.stud?.id,
              insideBuilding: snapped.stud?.spatialContext === 'inside_building',
              spatialContext: snapped.stud?.spatialContext ?? undefined,
              level: activeLevelRef.current,
            },
          ]);
          rts.setInteractionMode({ type: 'draw_wall', startPoint: null });
        }
        return;
      }

      if (mode.type === 'place_door') {
        let bestIdx = -1;
        let bestDist = 8;
        for (let i = 0; i < interiorWalls.length; i++) {
          const w = interiorWalls[i];
          if ((w.level ?? 'G') !== activeLevelRef.current) continue;
          const mx = (w.start.x + w.end.x) / 2;
          const my = (w.start.y + w.end.y) / 2;
          const d = Math.hypot(sim.x - mx, sim.y - my);
          if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
          }
        }
        if (bestIdx >= 0) {
          setInteriorWalls((prev) =>
            prev.map((w, i) => (i === bestIdx ? { ...w, hasDoor: true } : w)),
          );
        }
        rts.setInteractionMode({ type: 'select' });
        return;
      }

      if (mode.type === 'place_hazard') {
        const snapped = snapToStud(sim);
        setHazardZones((prev) => [
          ...prev,
          {
            id: `hz-${Date.now()}`,
            pos: snapped.pos,
            radius: 5,
            hazardType: mode.hazardType,
            severity: 'medium',
            label: HAZARD_DEFS[mode.hazardType].label,
            description: '',
            photos: [],
            studId: snapped.stud?.id,
            insideBuilding: snapped.stud?.spatialContext === 'inside_building',
            spatialContext: snapped.stud?.spatialContext ?? undefined,
            level: activeLevelRef.current,
          },
        ]);
        return;
      }

      if (mode.type === 'place_stairwell') {
        const snapped = snapToStud(sim);
        placeVerticalLink(snapped.pos, snapped.stud);
        return;
      }

      if (mode.type === 'place_blast_site') {
        const snapped = snapToStud(sim);
        setBlastLevel(activeLevelRef.current);
        setBlastSite(snapped.pos);
        rts.setInteractionMode({ type: 'select' });
        return;
      }
    },
    [
      toSim,
      projectedVerts,
      exits,
      interiorWalls,
      newExitWidth,
      wallPoints,
      handleWallPointClick,
      casualtyPins,
      handleCasualtyPinClick,
      applyElementDrag,
      snapWallEnd,
    ],
  );

  const handleCanvasWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const map = leafletMapRef.current;
    if (!map || e.deltaY === 0) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    const zoom = Math.min(
      map.getMaxZoom(),
      Math.max(map.getMinZoom(), map.getZoom() + (e.deltaY < 0 ? 1 : -1)),
    );
    if (rect) map.setZoomAround(L.point(e.clientX - rect.left, e.clientY - rect.top), zoom);
    else map.setZoom(zoom);
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  // ── Map pan: window listeners, Space modifier, click suppression ──────
  useEffect(() => {
    if (phase !== 'rts') return;
    let pointerOverMap = false;
    const spaceHasOwnMeaning = (t: EventTarget | null) => {
      const el = t instanceof HTMLElement ? t : null;
      if (!el) return false;
      if (el.isContentEditable) return true;
      return !!el.closest(
        'input, textarea, select, button, a[href], summary, [role="button"], [role="checkbox"]',
      );
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      // A focused control keeps Space unless the pointer is on the map; text fields always keep it.
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!pointerOverMap && spaceHasOwnMeaning(e.target)) return;
      e.preventDefault();
      if (spaceHeldRef.current) return;
      spaceHeldRef.current = true;
      if (!mapPanRef.current) setPanCursor('grab');
    };
    const releaseSpace = () => {
      spaceHeldRef.current = false;
      if (!mapPanRef.current?.active) setPanCursor('none');
    };
    const cancelPan = () => {
      mapPanRef.current = null;
      setPanCursor(spaceHeldRef.current ? 'grab' : 'none');
    };
    const onBlur = () => {
      releaseSpace();
      if (mapPanRef.current) cancelPan();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') releaseSpace();
    };
    const onMove = (e: MouseEvent) => {
      pointerOverMap = e.target === canvasRef.current;
      const pan = mapPanRef.current;
      if (!pan) return;
      // The release happened outside the window, so no mouseup will arrive.
      if (e.buttons === 0) {
        cancelPan();
        return;
      }
      if (!pan.active) {
        if (Math.hypot(e.clientX - pan.startX, e.clientY - pan.startY) < PAN_THRESHOLD_PX) return;
        pan.active = true;
        setPanCursor('grabbing');
      }
      leafletMapRef.current?.panBy([pan.lastX - e.clientX, pan.lastY - e.clientY], {
        animate: false,
      });
      pan.lastX = e.clientX;
      pan.lastY = e.clientY;
    };
    const onUp = (e: MouseEvent) => {
      const pan = mapPanRef.current;
      if (!pan || e.button !== pan.button) return;
      mapPanRef.current = null;
      if (pan.active) {
        suppressClickRef.current = true;
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      } else if (pan.button === 2) {
        const rts = rtsRef.current;
        const selected = [...rts.state.selection.selectedUnitIds];
        if (selected.length > 0) rts.issueMove(selected, pan.sim, pan.shift);
      }
      setPanCursor(spaceHeldRef.current ? 'grab' : 'none');
    };
    const canvas = canvasRef.current;
    const swallowClick = (e: MouseEvent) => {
      if (!suppressClickRef.current) return;
      e.stopImmediatePropagation();
      e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    canvas?.addEventListener('click', swallowClick, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      canvas?.removeEventListener('click', swallowClick, true);
      mapPanRef.current = null;
      spaceHeldRef.current = false;
      setPanCursor('none');
    };
  }, [phase]);

  // ── Touch support ─────────────────────────────────────────────────────
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchPinchDistRef = useRef<number | null>(null);
  const touchPanCenterRef = useRef<{ x: number; y: number } | null>(null);
  const wallDrawTouchRef = useRef<Vec2 | null>(null);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      if (e.touches.length === 2) {
        const dx = e.touches[1].clientX - e.touches[0].clientX;
        const dy = e.touches[1].clientY - e.touches[0].clientY;
        touchPinchDistRef.current = Math.hypot(dx, dy);
        touchPanCenterRef.current = {
          x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
        };
        return;
      }
      if (e.touches.length !== 1) return;
      e.preventDefault();

      const touch = e.touches[0];
      const rect = canvasRef.current!.getBoundingClientRect();
      const cx = touch.clientX - rect.left;
      const cy = touch.clientY - rect.top;
      const sim = toSim(cx, cy);

      touchStartRef.current = { x: cx, y: cy, time: Date.now() };
      dragStartRef.current = sim;
      isDraggingRef.current = false;
      hoverSimPosRef.current = sim;

      // Wall draw: touch-and-drag mode — capture start point
      const currentMode = rtsRef.current.state.interactionMode;
      if (currentMode.type === 'draw_wall') {
        const start = snapWallEnd(sim).pos;
        wallDrawTouchRef.current = start;
        rtsRef.current.setInteractionMode({ type: 'draw_wall', startPoint: start });
        return;
      }

      // Check for draggable element
      const hit = findDraggableAt(sim);
      if (hit) {
        elementDragRef.current = hit;
      }

      // Long press = move command (replaces right-click) — only if not dragging an element
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = setTimeout(() => {
        const rts = rtsRef.current;
        const selected = [...rts.state.selection.selectedUnitIds];
        if (selected.length > 0 && rts.state.interactionMode.type === 'select') {
          rts.issueMove(selected, sim, false);
          touchStartRef.current = null;
          dragStartRef.current = null;
          rerender();
        }
      }, 500);
    },
    [toSim, rerender, snapWallEnd],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      if (e.touches.length === 2 && touchPinchDistRef.current != null) {
        const dx = e.touches[1].clientX - e.touches[0].clientX;
        const dy = e.touches[1].clientY - e.touches[0].clientY;
        const dist = Math.hypot(dx, dy);
        const map = leafletMapRef.current;

        // Pinch zoom
        const pinchDelta = dist - touchPinchDistRef.current;
        if (map && Math.abs(pinchDelta) > 20) {
          if (pinchDelta > 0) map.zoomIn();
          else map.zoomOut();
          touchPinchDistRef.current = dist;
        }

        // Two-finger pan
        if (map && touchPanCenterRef.current) {
          const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          const panDx = cx - touchPanCenterRef.current.x;
          const panDy = cy - touchPanCenterRef.current.y;
          if (Math.abs(panDx) > 2 || Math.abs(panDy) > 2) {
            map.panBy([-panDx, -panDy], { animate: false });
            touchPanCenterRef.current = { x: cx, y: cy };
          }
        }
        return;
      }
      if (e.touches.length !== 1) return;

      const touch = e.touches[0];
      const rect = canvasRef.current!.getBoundingClientRect();
      const cx = touch.clientX - rect.left;
      const cy = touch.clientY - rect.top;
      hoverSimPosRef.current = toSim(cx, cy);

      // Wall draw drag: just update hover for the preview line
      if (wallDrawTouchRef.current) return;

      if (!touchStartRef.current) return;
      const moved = Math.hypot(cx - touchStartRef.current.x, cy - touchStartRef.current.y);

      if (moved > 10) {
        if (longPressTimerRef.current) {
          clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
        }
        isDraggingRef.current = true;
        const sim = toSim(cx, cy);

        // Element dragging (hazards, casualties, etc.)
        if (elementDragRef.current) {
          applyElementDrag(elementDragRef.current, sim);
          return;
        }

        const rts = rtsRef.current;
        if (dragStartRef.current && rts.state.interactionMode.type === 'select') {
          rts.state.selection.selectionBox = { start: dragStartRef.current, end: sim };
        }
      }
    },
    [toSim],
  );

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent<HTMLCanvasElement>) => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      touchPinchDistRef.current = null;
      touchPanCenterRef.current = null;

      // Finalize wall draw on touch (drag-to-draw)
      if (wallDrawTouchRef.current) {
        const rect0 = canvasRef.current!.getBoundingClientRect();
        const lt = e.changedTouches[0];
        const endSnap = snapWallEnd(toSim(lt.clientX - rect0.left, lt.clientY - rect0.top));
        const endSim = endSnap.pos;
        const startSim = wallDrawTouchRef.current;
        const wallLen = Math.hypot(endSim.x - startSim.x, endSim.y - startSim.y);
        if (wallLen > 1) {
          setInteriorWalls((prev) => [
            ...prev,
            {
              id: `iw-${Date.now()}`,
              start: startSim,
              end: endSim,
              hasDoor: false,
              doorWidth: 1.5,
              doorPosition: 0.5,
              description: '',
              material: '',
              photos: [],
              studId: endSnap.stud?.id,
              insideBuilding: endSnap.stud?.spatialContext === 'inside_building',
              spatialContext: endSnap.stud?.spatialContext ?? undefined,
              level: activeLevelRef.current,
            },
          ]);
        }
        wallDrawTouchRef.current = null;
        rtsRef.current.setInteractionMode({ type: 'draw_wall', startPoint: null });
        hoverSimPosRef.current = null;
        rerender();
        return;
      }

      // Finalize element drag on touch
      if (elementDragRef.current) {
        if (isDraggingRef.current) {
          const rect2 = canvasRef.current!.getBoundingClientRect();
          const lt = e.changedTouches[0];
          applyElementDrag(
            elementDragRef.current,
            toSim(lt.clientX - rect2.left, lt.clientY - rect2.top),
          );
          elementDragRef.current = null;
          touchStartRef.current = null;
          dragStartRef.current = null;
          isDraggingRef.current = false;
          rerender();
          return;
        }
        // No movement — treat as click
        const clickedEl = elementDragRef.current;
        elementDragRef.current = null;
        if (clickedEl.type === 'hazard') {
          const hz = hazardZonesRef.current.find((h) => h.id === clickedEl.id);
          if (hz) setActiveHazard(hz);
        } else if (clickedEl.type === 'casualty') {
          const cas = casualtyPinsRef.current.find((c) => c.id === clickedEl.id);
          if (cas) handleCasualtyPinClick(cas);
        }
        touchStartRef.current = null;
        dragStartRef.current = null;
        isDraggingRef.current = false;
        rerender();
        return;
      }

      if (!touchStartRef.current) return;
      const elapsed = Date.now() - touchStartRef.current.time;

      const rect = canvasRef.current!.getBoundingClientRect();
      const lastTouch = e.changedTouches[0];
      const cx = lastTouch.clientX - rect.left;
      const cy = lastTouch.clientY - rect.top;
      const sim = toSim(cx, cy);
      const rts = rtsRef.current;
      const mode = rts.state.interactionMode;

      // Stud inspect mode (touch)
      if (studInspectMode && elapsed < 300) {
        const studs = simStudsRef.current;
        let nearest: SimStud | null = null;
        let nearestDist = Infinity;
        for (const s of studs) {
          const d = Math.hypot(s.simPos.x - sim.x, s.simPos.y - sim.y);
          if (d < nearestDist) {
            nearestDist = d;
            nearest = s;
          }
        }
        if (nearest && nearestDist < 10) setInspectedStud(nearest);
        else setInspectedStud(null);
        touchStartRef.current = null;
        rerender();
        return;
      }

      if (isDraggingRef.current && dragStartRef.current) {
        rts.selectUnitsInBox(dragStartRef.current, sim);
        rts.state.selection.selectionBox = null;
      } else if (elapsed < 300) {
        if (mode.type === 'select') {
          const hitCas = casualtyPinsRef.current.find(
            (c) =>
              (c.level ?? 'G') === activeLevelRef.current &&
              Math.hypot(c.pos.x - sim.x, c.pos.y - sim.y) < 8,
          );
          if (hitCas) {
            handleCasualtyPinClick(hitCas);
          } else {
            const hitHz2 = hazardZonesRef.current.find(
              (hz) =>
                (hz.level ?? 'G') === activeLevelRef.current &&
                Math.hypot(hz.pos.x - sim.x, hz.pos.y - sim.y) < Math.max(hz.radius, 8),
            );
            if (hitHz2) {
              setActiveHazard(hitHz2);
            } else {
              const hitWp = wallPoints.find(
                (wp) => Math.hypot(wp.simPos.x - sim.x, wp.simPos.y - sim.y) < 3.0,
              );
              if (hitWp) {
                handleWallPointClick(hitWp);
              } else {
                const unit = rts.findUnitAt(sim);
                if (unit) {
                  rts.selectUnit(unit.id, false);
                } else {
                  rts.deselectAll();
                }
              }
            }
          }
        } else if (mode.type === 'place_staging') {
          rts.setStagingArea(sim);
          rts.setInteractionMode({ type: 'select' });
        } else if (mode.type === 'spawn_unit') {
          const spawnPos = rts.state.stagingArea ?? sim;
          const u = rts.spawnUnit(mode.unitKind, spawnPos, unitLevel());
          if (rts.state.stagingArea) rts.issueMove([u.id], sim, false);
          rts.setInteractionMode({ type: 'select' });
        } else if (mode.type === 'place_equipment') {
          const selected = rts.getSelectedUnits();
          const placer = selected.length > 0 ? selected[0].id : 'system';
          rts.placeEquipment(mode.equipmentKind, sim, placer);
          rts.setInteractionMode({ type: 'select' });
        } else if (mode.type === 'place_exit') {
          if (projectedVerts.length >= 3) {
            const snap = nearestEdge(sim.x, sim.y, projectedVerts);
            const maxW = edgeLength(projectedVerts, snap.edgeIndex) * 0.9;
            const w = Math.min(newExitWidth, maxW);
            const id = `exit-${++exitIdCounter}`;
            setExits((prev) => [
              ...prev,
              {
                id,
                center: snap.point,
                width: w,
                edgeIndex: snap.edgeIndex,
                description: '',
                status: 'unknown' as const,
                photos: [],
                level: activeLevelRef.current,
              },
            ]);
          }
        } else if (mode.type === 'draw_wall') {
          const snapped = snapWallEnd(sim);
          if (!mode.startPoint) {
            rts.setInteractionMode({ type: 'draw_wall', startPoint: snapped.pos });
          } else {
            setInteriorWalls((prev) => [
              ...prev,
              {
                id: `iw-${Date.now()}`,
                start: mode.startPoint!,
                end: snapped.pos,
                hasDoor: false,
                doorWidth: 1.5,
                doorPosition: 0.5,
                description: '',
                material: '',
                photos: [],
                studId: snapped.stud?.id,
                insideBuilding: snapped.stud?.spatialContext === 'inside_building',
                spatialContext: snapped.stud?.spatialContext ?? undefined,
                level: activeLevelRef.current,
              },
            ]);
            rts.setInteractionMode({ type: 'draw_wall', startPoint: null });
          }
        } else if (mode.type === 'place_door') {
          let bestIdx = -1;
          let bestDist = 8;
          for (let i = 0; i < interiorWalls.length; i++) {
            const w = interiorWalls[i];
            if ((w.level ?? 'G') !== activeLevelRef.current) continue;
            const d = Math.hypot(
              sim.x - (w.start.x + w.end.x) / 2,
              sim.y - (w.start.y + w.end.y) / 2,
            );
            if (d < bestDist) {
              bestDist = d;
              bestIdx = i;
            }
          }
          if (bestIdx >= 0)
            setInteriorWalls((prev) =>
              prev.map((w, i) => (i === bestIdx ? { ...w, hasDoor: true } : w)),
            );
          rts.setInteractionMode({ type: 'select' });
        } else if (mode.type === 'place_hazard') {
          const snapped = snapToStud(sim);
          setHazardZones((prev) => [
            ...prev,
            {
              id: `hz-${Date.now()}`,
              pos: snapped.pos,
              radius: 5,
              hazardType: mode.hazardType,
              severity: 'medium',
              label: HAZARD_DEFS[mode.hazardType].label,
              description: '',
              photos: [],
              studId: snapped.stud?.id,
              insideBuilding: snapped.stud?.spatialContext === 'inside_building',
              spatialContext: snapped.stud?.spatialContext ?? undefined,
              level: activeLevelRef.current,
            },
          ]);
        } else if (mode.type === 'place_stairwell') {
          const snapped = snapToStud(sim);
          placeVerticalLink(snapped.pos, snapped.stud);
        } else if (mode.type === 'place_blast_site') {
          const snapped = snapToStud(sim);
          setBlastLevel(activeLevelRef.current);
          setBlastSite(snapped.pos);
          rts.setInteractionMode({ type: 'select' });
        }
      }

      touchStartRef.current = null;
      dragStartRef.current = null;
      isDraggingRef.current = false;
      rerender();
    },
    [
      toSim,
      rerender,
      casualtyPins,
      wallPoints,
      projectedVerts,
      interiorWalls,
      exits,
      newExitWidth,
      handleCasualtyPinClick,
      handleWallPointClick,
      snapWallEnd,
    ],
  );

  // ── Staging area handler ──────────────────────────────────────────────
  const handleSetStagingArea = () => {
    const placing = rtsRef.current.state.interactionMode.type === 'place_staging';
    rtsRef.current.setInteractionMode(placing ? { type: 'select' } : { type: 'place_staging' });
    rerender();
  };

  // ── Derived values ────────────────────────────────────────────────────
  const rts = rtsRef.current;
  const gameState = rts.state;
  const clockDisplay = rts.formatClock();
  const phaseLabel =
    showcase && !blastFiredRef.current ? 'PRE-INCIDENT — QUIET PERIOD' : rts.phaseLabel();
  const chargePreset = BLAST_DATASET.presets.find((p) => p.key === charge.presetKey);
  const parsedLat = parseFloat(lat);
  const parsedLng = parseFloat(lng);
  const parsedRadius = parseInt(radius, 10) || 500;

  const initEffectsEngine = useCallback(() => {
    const studs = simStudsRef.current;
    blastDirectZoneRef.current = null;
    if (studs.length === 0 || !blastSite) return;
    const multi = levelsRef.current.length > 1;
    const bLevel = blastLevelRef.current;
    const asFireStuds = studs.map((s) => ({
      id: s.id,
      simPos: s.simPos,
      spatialContext: s.spatialContext,
      level: storeyId(s.floor),
    }));
    const attachShafts = (engine: SpatialEffectsEngine) =>
      attachBuilding(engine, {
        stairwells: stairwellsRef.current,
        levels: levelsRef.current,
        vertices: projectedVertsRef.current,
        exits: exitsRef.current,
      });
    const publishFields = () => {
      const evac = evacEngRef.current;
      if (!evac) return;
      if (!multi) return;
      const grouped = new Map<string, Array<{ id: string; simPos: Vec2; indoor: boolean }>>();
      for (const s of asFireStuds) {
        const list = grouped.get(s.level) ?? [];
        list.push({
          id: s.id,
          simPos: s.simPos,
          indoor: s.spatialContext === 'inside_building',
        });
        grouped.set(s.level, list);
      }
      const fields = new Map<string, HazardField>();
      for (const [id, list] of grouped) fields.set(id, new HazardField(list, 3));
      evac.setHazardFields(fields);
      evac.setBlastLevel(bLevel);
      evac.setHazardField(fields.get('G') ?? new HazardField([], 3));
    };

    if (showcaseRef.current) {
      const manual = manualRadiusRef.current;
      const liveRings = ringsRef.current;
      const spreadRadius = manual ? blastRadiusRef.current : liveRings.ignitionM;
      const affectRadius = manual ? blastRadiusRef.current : liveRings.minorM;
      const engine = new SpatialEffectsEngine(fireParams ?? DEFAULT_FIRE_PARAMS);
      engine.init(asFireStuds);
      attachShafts(engine);
      const fuelCells = fuelCellsFor(placedObjectsRef.current, studs);
      const fuelIds = new Set(fuelCells.keys());
      engine.setFuelCells(fuelCells);
      const t0 = blastEffectsTriggerSec(engine.timeScale);
      if (enrichResult?.hazardAnalysis) {
        for (const ha of enrichResult.hazardAnalysis) {
          if ((ha.events && ha.events.length > 0) || ha.hazardStates) {
            engine.registerHazard(
              ha.hazardId,
              shiftEvents((ha.events ?? []) as HazardEvent[], t0),
              ha.hazardStates ?? {
                initial: 'Unknown',
                triggered: 'Unknown',
                worsening: 'Unknown',
                critical: 'Unknown',
              },
            );
          }
        }
      }
      const affectedStuds = blastSmokeStudIds(
        asFireStuds
          .filter(
            (s) =>
              (!multi || s.level === bLevel) &&
              Math.hypot(s.simPos.x - blastSite.x, s.simPos.y - blastSite.y) <= affectRadius,
          )
          .map((s) => s.id),
        fuelIds,
      );
      engine.registerHazard(
        'blast-direct',
        [
          {
            triggerTimeSec: t0,
            eventType: 'explode',
            spreadType: 'fire',
            spreadRadius,
            spreadRate: 10,
            description: 'Direct blast ignition',
            severity: 'critical',
            smokeGeneration: 'heavy',
            affectedStuds,
          },
        ],
        {
          initial: 'Pre-detonation',
          triggered: 'Blast wave',
          worsening: 'Fire spreading',
          critical: 'Engulfed',
        },
      );
      blastDirectZoneRef.current = blastIgnitionZone(
        blastSite,
        spreadRadius,
        multi ? bLevel : undefined,
      );
      hazardFieldRef.current = new HazardField(
        studs.map((s) => ({
          id: s.id,
          simPos: s.simPos,
          indoor: s.spatialContext === 'inside_building',
        })),
        3,
      );
      evacEngRef.current?.setHazardField(hazardFieldRef.current);
      publishFields();
      effectsEngineRef.current = engine;
      setEffectStates(new Map(engine.studStates));
      setHazardRuntimeStates(
        new Map(
          Array.from(engine.hazardStates.entries()).map(([k, v]) => [
            k,
            { phase: v.phase, phaseDescription: v.phaseDescription },
          ]),
        ),
      );
      return;
    }

    const engine = new SpatialEffectsEngine(fireParams ?? undefined);
    engine.init(asFireStuds);
    attachShafts(engine);
    engine.setFuelCells(fuelCellsFor(placedObjectsRef.current, studs));

    if (enrichResult?.hazardAnalysis) {
      for (const ha of enrichResult.hazardAnalysis) {
        if ((ha.events && ha.events.length > 0) || ha.hazardStates) {
          engine.registerHazard(
            ha.hazardId,
            (ha.events ?? []) as HazardEvent[],
            ha.hazardStates ?? {
              initial: 'Unknown',
              triggered: 'Unknown',
              worsening: 'Unknown',
              critical: 'Unknown',
            },
          );
        }
      }
    }

    const hasAnyEvents = enrichResult?.hazardAnalysis?.some(
      (ha) => ha.events && ha.events.length > 0,
    );
    if (!hasAnyEvents) {
      engine.registerHazard(
        'blast-direct',
        [
          {
            triggerTimeSec: 0,
            eventType: 'explode',
            spreadType: 'fire',
            spreadRadius: blastRadius,
            spreadRate: 10,
            description: 'Direct blast ignition',
            severity: 'critical',
          },
        ],
        {
          initial: 'Pre-detonation',
          triggered: 'Blast wave',
          worsening: 'Fire spreading',
          critical: 'Engulfed',
        },
      );

      blastDirectZoneRef.current = blastIgnitionZone(
        blastSite,
        blastRadius,
        multi ? bLevel : undefined,
      );
    }
    publishFields();

    effectsEngineRef.current = engine;
    setEffectStates(new Map(engine.studStates));
    setHazardRuntimeStates(
      new Map(
        Array.from(engine.hazardStates.entries()).map(([k, v]) => [
          k,
          { phase: v.phase, phaseDescription: v.phaseDescription },
        ]),
      ),
    );
  }, [blastSite, fireParams, enrichResult]);

  const handleDetonation = useCallback(async () => {
    if (exits.length === 0) return;
    if (showcaseRef.current && (!blastSiteRef.current || simStudsRef.current.length === 0)) return;

    blastFiredRef.current = false;
    explosionStartRef.current = null;
    setGasJetCount(0);
    setArcCount(0);
    setSprayCount(0);
    setBanner(null);
    setShowcaseHud(null);
    hudAtRef.current = 0;
    resetSharedClock(simClockRef.current);
    cancelPreview();
    speedMeterRef.current = createSpeedMeter();
    setSlowedSpeed(null);

    if (!enrichResult && hazardZones.length > 0) {
      setDetonationLoading(true);
      try {
        await handleEnrichScene();
      } catch {
        // Continue without enrichment
      }
      setDetonationLoading(false);
    }

    initEvacEngine();
    rts.startDetonation();
    initEffectsEngine();
  }, [exits, enrichResult, hazardZones, handleEnrichScene, initEvacEngine, initEffectsEngine]);

  const levelIds = levels.map((l) => l.id);
  const paneLevelAt = (index: number) => {
    const id = paneLevels[index - 1];
    return id && levelIds.includes(id) ? id : activeLevel;
  };
  const choosePaneCount = (count: PaneCount) => {
    const defaults = defaultPaneLevels(count, levelIds, activeLevel);
    setPaneLevels((prev) =>
      defaults.map((id, i) => (prev[i] && levelIds.includes(prev[i]) ? prev[i] : id)),
    );
    setPaneCount(count);
  };
  const primaryMapView = leafletMapRef.current
    ? { center: leafletMapRef.current.getCenter(), zoom: leafletMapRef.current.getZoom() }
    : null;

  // =====================================================================
  // RENDER
  // =====================================================================
  return (
    <div className="h-screen bg-black text-green-400 font-mono flex flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-green-800 p-3 flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-lg tracking-wider text-amber-400">
            {isWarroomMode ? '[SCENE DESIGNER — WAR ROOM]' : '[RTS CRISIS SIMULATION — PROTOTYPE]'}
          </h1>
          <p className="text-xs text-green-700 mt-0.5">
            {phase === 'map'
              ? 'Select a building to begin the scenario'
              : `${selectedGrid?.buildingName || `Building #${selectedGridIdx}`} — ${phaseLabel}`}
          </p>
        </div>
        <div className="flex gap-2 items-center">
          {phase === 'rts' && (
            <div className="flex items-center gap-1" role="group" aria-label="Level panes">
              <span className="text-xs text-green-700">Panes</span>
              {([1, 2, 4] as const).map((count) => (
                <button
                  key={count}
                  type="button"
                  onClick={() => choosePaneCount(count)}
                  aria-pressed={paneCount === count}
                  title={count === 1 ? 'One map' : `Show ${count} levels side by side, in step`}
                  className={`text-xs border rounded px-2 py-1 ${
                    paneCount === count
                      ? 'text-cyan-300 border-cyan-600 bg-cyan-900/30'
                      : 'text-green-600 hover:text-green-400 border-green-800'
                  }`}
                >
                  {count}
                </button>
              ))}
              {paneCount > 1 && (
                <button
                  type="button"
                  onClick={() => setPanesLinked((linked) => !linked)}
                  aria-pressed={panesLinked}
                  title={
                    panesLinked
                      ? 'Panes pan and zoom together; click to move each on its own'
                      : 'Each pane pans and zooms on its own; click to follow the main pane'
                  }
                  className={`text-xs border rounded px-2 py-1 ${
                    panesLinked
                      ? 'text-cyan-300 border-cyan-600 bg-cyan-900/30'
                      : 'text-green-600 hover:text-green-400 border-green-800'
                  }`}
                >
                  {panesLinked ? 'Linked' : 'Unlinked'}
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={toggleFocusMode}
            aria-pressed={focusMode}
            title={
              focusMode
                ? 'Show the side panels and levels box'
                : 'Collapse everything around the map'
            }
            className={`text-xs border rounded px-2 py-1 ${
              focusMode
                ? 'text-cyan-300 border-cyan-600 bg-cyan-900/30 hover:text-cyan-200'
                : 'text-green-600 hover:text-green-400 border-green-800'
            }`}
          >
            {focusMode ? '⤡ Exit focus' : '⤢ Focus'}
          </button>
          {phase === 'rts' && (
            <>
              <span className="text-amber-300 text-sm font-bold">{clockDisplay}</span>
              {slowedSpeed && !gameState.clock.paused && (
                <span
                  className="text-amber-500 text-xs"
                  title="The clock is running slower than the chosen speed to keep frames responsive"
                >
                  {slowedSpeed}
                </span>
              )}
              <button
                onClick={backToMap}
                className="text-xs text-green-600 hover:text-green-400 border border-green-800 rounded px-2 py-1"
              >
                ← Back to Map
              </button>
            </>
          )}
          {isWarroomMode ? (
            <button
              onClick={() => {
                const params = new URLSearchParams();
                if (warroomDraftId) params.set('draft', warroomDraftId);
                if (sceneConfigId) params.set('sceneId', sceneConfigId);
                window.location.href = `/warroom?${params}`;
              }}
              className="text-xs text-amber-400 hover:text-amber-300 border border-amber-700 rounded px-3 py-1 font-bold"
            >
              ← Return to WarRoom
            </button>
          ) : (
            <a
              href="/debug/evacuation-sim"
              className="text-xs text-green-600 hover:text-green-400 border border-green-800 rounded px-2 py-1"
            >
              Evac Sim
            </a>
          )}
        </div>
      </div>

      {/* MAP PHASE — controls bar */}
      {phase === 'map' && (
        <div className="flex flex-wrap gap-3 p-3 items-end border-b border-green-900 flex-shrink-0">
          {/* Place search with country dropdown */}
          <div>
            <label className="block text-xs text-green-600 mb-1">Country</label>
            <select
              value={searchCountry}
              onChange={(e) => setSearchCountry(e.target.value)}
              className="bg-gray-900 border border-green-800 text-green-300 px-2 py-1 text-sm rounded w-28"
            >
              <option value="">All</option>
              <option value="AF">Afghanistan</option>
              <option value="AL">Albania</option>
              <option value="DZ">Algeria</option>
              <option value="AR">Argentina</option>
              <option value="AU">Australia</option>
              <option value="AT">Austria</option>
              <option value="BD">Bangladesh</option>
              <option value="BE">Belgium</option>
              <option value="BR">Brazil</option>
              <option value="BN">Brunei</option>
              <option value="KH">Cambodia</option>
              <option value="CA">Canada</option>
              <option value="CN">China</option>
              <option value="CO">Colombia</option>
              <option value="CZ">Czech Republic</option>
              <option value="DK">Denmark</option>
              <option value="EG">Egypt</option>
              <option value="FI">Finland</option>
              <option value="FR">France</option>
              <option value="DE">Germany</option>
              <option value="GR">Greece</option>
              <option value="HK">Hong Kong</option>
              <option value="HU">Hungary</option>
              <option value="IN">India</option>
              <option value="ID">Indonesia</option>
              <option value="IQ">Iraq</option>
              <option value="IE">Ireland</option>
              <option value="IL">Israel</option>
              <option value="IT">Italy</option>
              <option value="JP">Japan</option>
              <option value="JO">Jordan</option>
              <option value="KZ">Kazakhstan</option>
              <option value="KE">Kenya</option>
              <option value="KR">South Korea</option>
              <option value="KW">Kuwait</option>
              <option value="LA">Laos</option>
              <option value="LB">Lebanon</option>
              <option value="MY">Malaysia</option>
              <option value="MX">Mexico</option>
              <option value="MM">Myanmar</option>
              <option value="NL">Netherlands</option>
              <option value="NZ">New Zealand</option>
              <option value="NG">Nigeria</option>
              <option value="NO">Norway</option>
              <option value="PK">Pakistan</option>
              <option value="PH">Philippines</option>
              <option value="PL">Poland</option>
              <option value="PT">Portugal</option>
              <option value="QA">Qatar</option>
              <option value="RO">Romania</option>
              <option value="RU">Russia</option>
              <option value="SA">Saudi Arabia</option>
              <option value="SG">Singapore</option>
              <option value="ZA">South Africa</option>
              <option value="ES">Spain</option>
              <option value="LK">Sri Lanka</option>
              <option value="SE">Sweden</option>
              <option value="CH">Switzerland</option>
              <option value="TW">Taiwan</option>
              <option value="TH">Thailand</option>
              <option value="TR">Turkey</option>
              <option value="AE">UAE</option>
              <option value="UA">Ukraine</option>
              <option value="GB">United Kingdom</option>
              <option value="US">United States</option>
              <option value="VN">Vietnam</option>
            </select>
          </div>
          <div className="relative">
            <label className="block text-xs text-green-600 mb-1">Search Place</label>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => handleSearchInput(e.target.value)}
              onFocus={() => {
                if (searchResults.length > 0) setSearchOpen(true);
              }}
              placeholder="e.g. National Library Singapore"
              className="bg-gray-900 border border-green-800 text-green-300 px-2 py-1 text-sm w-64 rounded"
            />
            {searchOpen && searchResults.length > 0 && (
              <div
                className="absolute top-full left-0 w-80 mt-1 bg-gray-900 border border-green-700 rounded shadow-lg max-h-48 overflow-y-auto"
                style={{ zIndex: 2000 }}
              >
                {searchResults.map((r, i) => (
                  <button
                    key={i}
                    onClick={() => handleSelectSearchResult(r)}
                    className="w-full text-left px-3 py-2 text-xs text-green-400 hover:bg-green-900/40 hover:text-green-300 border-b border-green-900/50 last:border-b-0"
                  >
                    {r.display_name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className="block text-xs text-green-600 mb-1">Latitude</label>
            <input
              type="text"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              className="bg-gray-900 border border-green-800 text-green-300 px-2 py-1 text-sm w-36 rounded"
            />
          </div>
          <div>
            <label className="block text-xs text-green-600 mb-1">Longitude</label>
            <input
              type="text"
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              className="bg-gray-900 border border-green-800 text-green-300 px-2 py-1 text-sm w-36 rounded"
            />
          </div>
          <div>
            <label className="block text-xs text-green-600 mb-1">Radius (m)</label>
            <input
              type="text"
              value={radius}
              onChange={(e) => setRadius(e.target.value)}
              className="bg-gray-900 border border-green-800 text-green-300 px-2 py-1 text-sm w-20 rounded"
            />
          </div>
          <button
            onClick={handleFetch}
            disabled={loading}
            className="bg-green-800 hover:bg-green-700 disabled:opacity-50 text-green-100 px-4 py-1.5 text-sm rounded border border-green-600"
          >
            {loading ? 'Fetching...' : 'Fetch Buildings'}
          </button>
          <button
            onClick={() => {
              if (drawingBuilding) {
                handleCancelDrawing();
              } else {
                setDrawingBuilding(true);
                setDrawnVertices([]);
              }
            }}
            className={`px-4 py-1.5 text-sm rounded border transition-colors ${
              drawingBuilding
                ? 'bg-amber-800 hover:bg-amber-700 text-amber-100 border-amber-600'
                : 'bg-gray-800 hover:bg-gray-700 text-amber-300 border-amber-800'
            }`}
          >
            {drawingBuilding ? 'Cancel Drawing' : '✏️ Draw Building'}
          </button>
          {error && <span className="text-red-400 text-xs">{error}</span>}
          {drawingBuilding && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-amber-400">
                {redrawIndex != null ? `Redrawing "${drawnBuildingName}" — ` : ''}
                Click map to add vertices ({drawnVertices.length} placed)
                {drawnVertices.length === 0 && ' — start with first corner'}
                {drawnVertices.length >= 1 && drawnVertices.length < 3 && ' — need at least 3'}
              </span>
              {drawnVertices.length > 0 && (
                <button
                  onClick={handleUndoVertex}
                  className="text-xs text-amber-500 hover:text-amber-300 border border-amber-800 rounded px-2 py-0.5"
                >
                  Undo
                </button>
              )}
              {drawnVertices.length >= 3 && (
                <>
                  <input
                    type="text"
                    value={drawnBuildingName}
                    onChange={(e) => setDrawnBuildingName(e.target.value)}
                    placeholder="Building name"
                    className="bg-gray-800 border border-amber-800 text-amber-300 px-2 py-0.5 text-xs rounded w-32"
                  />
                  <button
                    onClick={handleFinishDrawing}
                    className="bg-green-800 hover:bg-green-700 text-green-100 text-xs px-3 py-0.5 rounded border border-green-600"
                  >
                    Finish Drawing
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* MAIN AREA */}
      <div className={`flex ${isPortrait ? 'flex-col' : 'flex-row'} flex-1 overflow-hidden`}>
        {/* Left sidebar: team palette (RTS only, hidden in warroom mode) — below map on mobile */}
        {phase === 'rts' && !isWarroomMode && !leftPanelOpen && (
          <PanelEdgeTab
            side="left"
            label="Teams"
            portrait={isPortrait}
            orderClass={isPortrait ? 'order-3' : 'order-1'}
            onOpen={() => setLeftPanelOpen(true)}
          />
        )}
        {phase === 'rts' && !isWarroomMode && (
          <div
            className={`${isPortrait ? 'order-3 w-full border-t' : 'order-1 w-56 border-r flex-shrink-0'} border-green-800 overflow-y-auto p-2 space-y-2 min-h-0${leftPanelOpen ? '' : ' hidden'}`}
          >
            <PanelCollapseButton
              side="left"
              portrait={isPortrait}
              onClick={() => setLeftPanelOpen(false)}
            />
            <div className="space-y-1">
              <div className="text-xs text-green-600 uppercase tracking-wider">Active Team</div>
              {ALL_TEAMS.map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    rts.setActiveTeam(t);
                    rerender();
                  }}
                  className={`w-full text-left text-xs px-2 py-1.5 rounded border transition-colors ${
                    gameState.activeTeam === t
                      ? 'border-white/40 bg-white/10 text-white'
                      : 'border-green-900 text-green-600 hover:text-green-400 hover:border-green-700'
                  }`}
                  style={
                    gameState.activeTeam === t
                      ? { borderColor: TEAM_COLORS[t] + '80', color: TEAM_COLORS[t] }
                      : {}
                  }
                >
                  {TEAM_LABELS[t]}
                </button>
              ))}
            </div>

            <div className="space-y-1">
              <div className="text-xs text-green-600 uppercase tracking-wider mt-3">Units</div>
              {TEAM_UNITS[gameState.activeTeam].map((uk) => {
                const def = UNIT_CATALOG[uk];
                return (
                  <button
                    key={uk}
                    onClick={() => {
                      rts.setInteractionMode({ type: 'spawn_unit', unitKind: uk });
                      rerender();
                    }}
                    className={`w-full text-left text-xs px-2 py-1.5 rounded border transition-colors ${
                      gameState.interactionMode.type === 'spawn_unit' &&
                      gameState.interactionMode.unitKind === uk
                        ? 'border-cyan-400 bg-cyan-900/30 text-cyan-300'
                        : 'border-green-900 text-green-500 hover:text-green-400 hover:border-green-700'
                    }`}
                  >
                    <span
                      className="inline-block w-3 h-3 rounded-full mr-1.5"
                      style={{ backgroundColor: def.color }}
                    />
                    {def.label}
                    <span className="text-green-700 ml-1">({def.speed}m/s)</span>
                  </button>
                );
              })}
              {TEAM_UNITS[gameState.activeTeam].length === 0 && (
                <div className="text-xs text-green-800 italic px-2">IC has no deployable units</div>
              )}
            </div>

            <div className="space-y-1">
              <div className="text-xs text-green-600 uppercase tracking-wider mt-3">Equipment</div>
              {TEAM_EQUIPMENT[gameState.activeTeam].map((ek) => {
                const def = EQUIPMENT_CATALOG[ek];
                return (
                  <button
                    key={ek}
                    onClick={() => {
                      rts.setInteractionMode({ type: 'place_equipment', equipmentKind: ek });
                      rerender();
                    }}
                    className={`w-full text-left text-xs px-2 py-1.5 rounded border transition-colors ${
                      gameState.interactionMode.type === 'place_equipment' &&
                      gameState.interactionMode.equipmentKind === ek
                        ? 'border-cyan-400 bg-cyan-900/30 text-cyan-300'
                        : 'border-green-900 text-green-500 hover:text-green-400 hover:border-green-700'
                    }`}
                  >
                    <span className="mr-1.5">{def.icon}</span>
                    {def.label}
                  </button>
                );
              })}
            </div>

            {/* IC-specific actions (hidden in warroom scene design mode) */}
            {!isWarroomMode &&
              gameState.activeTeam === 'ic' &&
              gameState.clock.phase !== 'setup' && (
                <div className="space-y-1">
                  <div className="text-xs text-green-600 uppercase tracking-wider mt-3">
                    IC Actions
                  </div>
                  <button
                    onClick={handleSetStagingArea}
                    className={`w-full text-left text-xs px-2 py-1.5 rounded border transition-colors ${
                      gameState.interactionMode.type === 'place_staging'
                        ? 'border-cyan-400 bg-cyan-900/30 text-cyan-300'
                        : gameState.stagingArea
                          ? 'border-green-700 bg-green-900/20 text-green-400'
                          : 'border-amber-800 text-amber-400 hover:border-amber-600'
                    }`}
                  >
                    📍{' '}
                    {gameState.interactionMode.type === 'place_staging'
                      ? 'Click the map to place the staging area'
                      : gameState.stagingArea
                        ? 'Relocate Staging Area'
                        : 'Set Staging Area (RVP)'}
                  </button>
                  {!gameState.stagingArea && (
                    <div className="text-xs text-amber-600 px-2 italic">
                      Units spawn at click location until a staging area is set
                    </div>
                  )}
                </div>
              )}
          </div>
        )}

        {/* CENTER: Map (always visible) with canvas overlay in RTS mode */}
        <div
          className={`${isPortrait ? 'order-1 flex-shrink-0 h-[55vh]' : 'order-2 flex-1'} relative overflow-hidden`}
          ref={containerRef}
          style={{ touchAction: 'none' }}
        >
          {/* GPS loading overlay */}
          {!userGeoPos && !warroomLat && (
            <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-[500] pointer-events-none">
              <div className="text-center">
                <div className="text-amber-400 text-sm font-mono animate-pulse mb-1">
                  Locating you...
                </div>
                <div className="text-green-700 text-xs font-mono">Acquiring GPS position</div>
              </div>
            </div>
          )}
          <MapContainer
            center={[
              Number.isNaN(parsedLat) ? 1.3 : parsedLat,
              Number.isNaN(parsedLng) ? 103.8 : parsedLng,
            ]}
            zoom={18}
            maxZoom={MAX_MAP_ZOOM}
            style={{ height: '100%', width: '100%' }}
            zoomControl={phase === 'map'}
            dragging={phase === 'map'}
            scrollWheelZoom={phase === 'map'}
            doubleClickZoom={false}
          >
            <TileLayer
              attribution="&copy; OSM"
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              maxNativeZoom={19}
              maxZoom={MAX_MAP_ZOOM}
            />
            <MapRefSync onMap={setLeafletMap} />

            {phase === 'map' && <ClickHandler onClick={handleMapClick} />}

            {/* Search radius (map phase only) */}
            {phase === 'map' && !Number.isNaN(parsedLat) && !Number.isNaN(parsedLng) && (
              <>
                <Circle
                  center={[parsedLat, parsedLng]}
                  radius={parsedRadius}
                  pathOptions={{
                    color: '#22c55e',
                    weight: 1,
                    fillOpacity: 0.05,
                    dashArray: '6, 4',
                  }}
                />
                <CircleMarker
                  center={[parsedLat, parsedLng]}
                  radius={5}
                  pathOptions={{
                    color: '#22c55e',
                    fillColor: '#4ade80',
                    fillOpacity: 0.8,
                    weight: 2,
                  }}
                />
              </>
            )}

            {/* Building polygons */}
            {fetchResult?.grids
              .filter((g) => g.buildingIndex >= 0 && g.polygon.length >= 3)
              .map((grid, idx) => {
                const isSelected = selectedGridIdx === idx;
                if (phase === 'rts' && !isSelected) return null;
                return (
                  <Polygon
                    key={`bldg-${grid.buildingIndex}`}
                    positions={grid.polygon.map(([la, ln]) => [la, ln] as [number, number])}
                    pathOptions={{
                      color: isSelected ? '#22d3ee' : '#6366f1',
                      weight: isSelected ? 3 : 2,
                      fillOpacity: phase === 'rts' ? 0 : isSelected ? 0.2 : 0.08,
                      fillColor: isSelected ? '#22d3ee' : '#818cf8',
                    }}
                    eventHandlers={
                      phase === 'map' && !drawingBuilding
                        ? { click: () => selectBuilding(idx) }
                        : {}
                    }
                  />
                );
              })}

            {/* Drawing polygon preview */}
            {drawingBuilding && drawnVertices.length >= 2 && (
              <Polygon
                positions={drawnVertices.map(([la, ln]) => [la, ln] as [number, number])}
                pathOptions={{
                  color: '#f59e0b',
                  weight: 3,
                  fillOpacity: 0.1,
                  fillColor: '#f59e0b',
                  dashArray: '8, 6',
                }}
              />
            )}
            {drawingBuilding &&
              drawnVertices.map(([la, ln], i) => (
                <CircleMarker
                  key={`dv-${i}`}
                  center={[la, ln]}
                  radius={4}
                  pathOptions={{
                    color: '#f59e0b',
                    fillColor: i === 0 ? '#ef4444' : '#fbbf24',
                    fillOpacity: 1,
                    weight: 2,
                  }}
                />
              ))}

            {/* In RTS mode, fit the map to the building */}
            {phase === 'rts' && selectedGrid && <FitBounds polygon={selectedGrid.polygon} />}
          </MapContainer>

          {/* Canvas overlay (RTS mode) */}
          {phase === 'rts' && (
            <>
              <canvas
                ref={canvasRef}
                width={primaryRect.w}
                height={primaryRect.h}
                style={{
                  position: 'absolute',
                  top: primaryRect.y,
                  left: primaryRect.x,
                  width: primaryRect.w,
                  height: primaryRect.h,
                  pointerEvents: 'auto',
                  zIndex: 1000,
                  touchAction: 'none',
                }}
                className={
                  panCursor === 'grabbing'
                    ? 'cursor-grabbing'
                    : panCursor === 'grab'
                      ? 'cursor-grab'
                      : 'cursor-crosshair'
                }
                onMouseDown={handleCanvasMouseDown}
                onMouseMove={handleCanvasMouseMove}
                onMouseUp={handleCanvasMouseUp}
                onWheel={handleCanvasWheel}
                onContextMenu={handleContextMenu}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
              />
              {shownPanes > 1 && (
                <>
                  <div
                    className="absolute pointer-events-none"
                    style={{
                      left: primaryRect.x,
                      top: primaryRect.y,
                      width: primaryRect.w,
                      height: primaryRect.h,
                      zIndex: 1050,
                    }}
                  >
                    <PaneLevelChip
                      level={activeLevel}
                      levels={levels}
                      summary={levelSummary(activeLevel, allSimStuds, effectStates, pedestrians)}
                      primary
                      onLevel={setActiveLevel}
                    />
                  </div>
                  {paneRects.slice(1).map((rect, i) => (
                    <LevelPane
                      key={i + 1}
                      index={i + 1}
                      rect={rect}
                      level={paneLevelAt(i + 1)}
                      levels={levels}
                      summary={levelSummary(
                        paneLevelAt(i + 1),
                        allSimStuds,
                        effectStates,
                        pedestrians,
                      )}
                      initialView={primaryMapView}
                      onLevel={setPaneLevel}
                      register={registerPane}
                      onPan={panPane}
                      onZoom={zoomPane}
                    />
                  ))}
                </>
              )}
              {levelsBoxOpen ? (
                <LevelSwitcher
                  onClose={() => setLevelsBoxOpen(false)}
                  place={levelsBoxPlace}
                  levels={levels}
                  activeLevel={activeLevel}
                  interiorWalls={interiorWalls}
                  exits={exits}
                  hazardZones={hazardZones}
                  casualtyPins={casualtyPins}
                  stairwells={stairwells}
                  pedestrians={pedestrians}
                  studs={allSimStuds}
                  effectStates={effectStates}
                  copyTargets={copyTargets}
                  onActive={setActiveLevel}
                  onLevels={setLevels}
                  onCopyTargets={setCopyTargets}
                  onCopy={(from, targets) => {
                    if (targets.length === 0) return;
                    setInteriorWalls((prev) => [
                      ...prev,
                      ...targets.flatMap((to) =>
                        prev
                          .filter((w) => levelOf(w) === from)
                          .map((w) => ({ ...w, id: `${w.id}-${to}-${Date.now()}`, level: to })),
                      ),
                    ]);
                    setExits((prev) => [
                      ...prev,
                      ...targets.flatMap((to) =>
                        prev
                          .filter((e) => levelOf(e) === from)
                          .map((e) => ({ ...e, id: `${e.id}-${to}-${Date.now()}`, level: to })),
                      ),
                    ]);
                  }}
                  pedestrianCount={pedestrianCount}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setLevelsBoxOpen(true)}
                  onMouseDown={(e) => e.stopPropagation()}
                  title="Show the levels box"
                  className="absolute top-2 left-2 bg-black/85 border border-slate-600 hover:border-slate-400 rounded px-2 py-1 text-xs text-slate-200"
                  style={{ zIndex: 1100, ...(levelsBoxPlace ? { top: levelsBoxPlace.top } : {}) }}
                >
                  ▤ Levels · {levels.find((l) => l.id === activeLevel)?.name ?? activeLevel}
                </button>
              )}
              {banner && performance.now() < banner.until && (
                <div
                  role="status"
                  className="absolute left-1/2 top-4 -translate-x-1/2 bg-red-700 text-white font-bold px-4 py-2 rounded pointer-events-none"
                  style={{ zIndex: 1100 }}
                >
                  {banner.text}
                </div>
              )}
              {/* Mode indicator overlay */}
              {gameState.interactionMode.type !== 'select' || shownPanes === 1 ? (
                <div
                  className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/70 rounded px-3 py-1.5 text-xs text-green-400 pointer-events-none"
                  style={{ zIndex: 1001 }}
                >
                  {gameState.interactionMode.type !== 'select' ? (
                    <span className="text-amber-400">
                      Mode: {gameState.interactionMode.type.replace(/_/g, ' ').toUpperCase()} —
                      click to place, middle or Space+drag pan, ESC to cancel
                    </span>
                  ) : (
                    <span>
                      Mouse: click select · drag box · right-click move · scroll zoom · right/middle
                      or Space+drag pan | Touch: tap select · long-press move · drag box · pinch
                      zoom · 2-finger drag pan
                    </span>
                  )}
                </div>
              ) : (
                <div
                  className="absolute bottom-2 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1 text-xs"
                  style={{ zIndex: 1001, maxWidth: 'calc(100% - 16px)' }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onWheel={(e) => e.stopPropagation()}
                >
                  {gridHelpOpen && (
                    <div className="bg-slate-900/90 border border-slate-600 rounded px-3 py-2 text-slate-200 space-y-1">
                      <div className="text-green-400">
                        Mouse: click select · drag box · right-click move · scroll zoom ·
                        right/middle or Space+drag pan | Touch: tap select · long-press move · drag
                        box · pinch zoom · 2-finger drag pan
                      </div>
                      {showcase &&
                        SHOWCASE_LEGEND_LINES.map((line) => <div key={line}>{line}</div>)}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => setGridHelpOpen((open) => !open)}
                    aria-expanded={gridHelpOpen}
                    className="bg-black/80 border border-slate-600 hover:border-slate-400 rounded px-2 py-1 text-slate-200"
                  >
                    {gridHelpOpen
                      ? 'Hide controls and legend'
                      : showcase
                        ? 'Controls and legend'
                        : 'Controls'}
                  </button>
                </div>
              )}

              {/* ── Floating photo card ── */}
              {activeWallPoint && (
                <div
                  className="absolute top-4 right-4 w-[420px] bg-gray-900/95 border border-cyan-700 rounded-lg shadow-2xl overflow-hidden"
                  style={{ zIndex: 1002 }}
                >
                  {/* Card header */}
                  <div className="flex items-center justify-between px-3 py-2 bg-gray-800/80 border-b border-cyan-800">
                    <div className="text-xs text-cyan-300 font-bold">
                      Wall Inspection — Point {activeWallPoint.id}
                    </div>
                    <button
                      onClick={closePhotoCard}
                      className="text-gray-400 hover:text-white text-sm px-1"
                    >
                      ✕
                    </button>
                  </div>

                  {/* Photo area */}
                  <div className="relative bg-black" style={{ minHeight: 200 }}>
                    {wallPointLoading && (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="text-cyan-400 text-xs animate-pulse">
                          Loading Street View...
                        </div>
                      </div>
                    )}
                    {wallPointImage && (
                      <img
                        src={wallPointImage}
                        alt={`Street View at wall point ${activeWallPoint.id}`}
                        className="w-full h-auto"
                      />
                    )}
                    {!wallPointImage && !wallPointLoading && (
                      <div className="flex flex-col items-center justify-center h-48 text-xs text-gray-500 px-4 text-center">
                        {GOOGLE_MAPS_KEY ? (
                          <>
                            <span className="text-gray-400 mb-1">
                              No outdoor Street View coverage here
                            </span>
                            <span className="text-gray-600">
                              This wall section has no Google street-level imagery. Try a nearby
                              point.
                            </span>
                          </>
                        ) : (
                          'Set VITE_GOOGLE_MAPS_API_KEY to enable Street View'
                        )}
                      </div>
                    )}
                  </div>

                  {/* Upload / replace photo (trainer mode) */}
                  {isTrainerMode && gameState.clock.phase === 'setup' && (
                    <div className="px-3 py-1.5 border-t border-gray-800 flex gap-2 items-center">
                      <input
                        ref={photoUploadRef}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="hidden"
                        onChange={handlePhotoUpload}
                      />
                      <input
                        id="photo-gallery-input"
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={handlePhotoUpload}
                      />
                      <button
                        onClick={() => photoUploadRef.current?.click()}
                        className="bg-amber-800 hover:bg-amber-700 text-amber-100 text-xs px-3 py-1 rounded border border-amber-600"
                      >
                        📷 Take Photo
                      </button>
                      <button
                        onClick={() => document.getElementById('photo-gallery-input')?.click()}
                        className="bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs px-3 py-1 rounded border border-gray-600"
                      >
                        📁 Gallery
                      </button>
                      <span className="text-xs text-gray-600">
                        {activeWallPoint.imageSource === 'custom'
                          ? 'Custom'
                          : activeWallPoint.imageSource === 'streetview'
                            ? 'Street View'
                            : 'None'}
                      </span>
                    </div>
                  )}

                  {/* Coordinates */}
                  <div className="px-3 py-1.5 text-xs text-gray-500 border-t border-gray-800 flex gap-3">
                    <span>
                      Wall: {activeWallPoint.lat.toFixed(6)}, {activeWallPoint.lng.toFixed(6)}
                    </span>
                    <span>Heading: {Math.round(activeWallPoint.heading)}°</span>
                  </div>

                  {/* Trainer: plant threat (setup mode only) */}
                  {isTrainerMode && gameState.clock.phase === 'setup' && (
                    <div className="px-3 py-2 border-t border-red-900/50 bg-red-950/20">
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="text-xs text-red-400 font-bold">
                          Plant Threat (Trainer)
                        </label>
                        {plantedItems.filter((p) => p.wallPointId === activeWallPoint.id).length >
                          0 && (
                          <span className="text-xs text-red-300 bg-red-900/40 px-1.5 py-0.5 rounded">
                            {
                              plantedItems.filter((p) => p.wallPointId === activeWallPoint.id)
                                .length
                            }{' '}
                            planted
                          </span>
                        )}
                      </div>
                      {plantedItems
                        .filter((p) => p.wallPointId === activeWallPoint.id)
                        .map((p) => (
                          <div
                            key={p.id}
                            className="flex items-start gap-1.5 mb-1.5 bg-red-900/20 rounded px-2 py-1"
                          >
                            <span className="text-xs text-red-300 flex-1">{p.description}</span>
                            <span className="text-xs text-red-500">{p.threatLevel}</span>
                            <button
                              onClick={() => handleRemovePlantedItem(p.id)}
                              className="text-red-600 hover:text-red-400 text-xs"
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      <textarea
                        value={plantDescription}
                        onChange={(e) => setPlantDescription(e.target.value)}
                        placeholder="Describe what is hidden here — e.g. 'Pipe bomb concealed inside the green recycling bin to the left of the entrance'"
                        className="w-full bg-gray-800 border border-red-800 text-red-200 text-xs rounded px-2 py-1.5 resize-none focus:border-red-500 focus:outline-none"
                        rows={2}
                      />
                      <div className="flex gap-2 mt-1.5">
                        <select
                          value={plantThreatLevel}
                          onChange={(e) =>
                            setPlantThreatLevel(e.target.value as PlantedItem['threatLevel'])
                          }
                          className="bg-gray-800 border border-red-800 text-red-300 text-xs rounded px-1 py-1 flex-1"
                        >
                          <option value="real_device">Real Device</option>
                          <option value="secondary_device">Secondary Device</option>
                          <option value="decoy">Decoy</option>
                        </select>
                        <select
                          value={plantDifficulty}
                          onChange={(e) =>
                            setPlantDifficulty(
                              e.target.value as PlantedItem['concealmentDifficulty'],
                            )
                          }
                          className="bg-gray-800 border border-red-800 text-red-300 text-xs rounded px-1 py-1 flex-1"
                        >
                          <option value="easy">Easy</option>
                          <option value="moderate">Moderate</option>
                          <option value="hard">Hard</option>
                        </select>
                        <button
                          onClick={handlePlantItem}
                          disabled={!plantDescription.trim()}
                          className="bg-red-800 hover:bg-red-700 disabled:opacity-30 text-white text-xs px-3 py-1 rounded border border-red-600"
                        >
                          Plant
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Player: assessment input */}
                  <div className="px-3 py-2 border-t border-gray-800">
                    <label className="block text-xs text-cyan-400 mb-1">
                      {isTrainerMode
                        ? 'Assessment (Player View Preview)'
                        : 'What do you want to inspect?'}
                    </label>
                    <textarea
                      value={assessmentText}
                      onChange={(e) => setAssessmentText(e.target.value)}
                      placeholder="Be specific — name the objects you want to inspect (e.g. 'Inspect the recycling bin near the entrance and the concrete planter to the right')"
                      className="w-full bg-gray-800 border border-gray-700 text-green-300 text-xs rounded px-2 py-1.5 resize-none focus:border-cyan-500 focus:outline-none"
                      rows={3}
                    />

                    {/* AI response */}
                    {aiResponse && (
                      <div
                        className={`mt-2 px-2.5 py-2 rounded text-xs border ${
                          plantedItems.find(
                            (p) => p.wallPointId === activeWallPoint.id && p.discovered,
                          )
                            ? 'bg-red-900/30 border-red-700 text-red-200'
                            : 'bg-gray-800 border-gray-700 text-green-300'
                        }`}
                      >
                        <div className="text-gray-400 text-xs mb-1 font-bold">
                          Exercise Observer:
                        </div>
                        {aiResponse}
                      </div>
                    )}

                    <div className="flex justify-between items-center mt-1.5">
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-gray-600 flex items-center gap-1 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={isTrainerMode}
                            onChange={(e) => setIsTrainerMode(e.target.checked)}
                            className="rounded border-gray-600"
                          />
                          Trainer mode
                        </label>
                      </div>
                      <button
                        onClick={handleSubmitAssessment}
                        disabled={!assessmentText.trim() || assessmentLoading}
                        className="bg-cyan-800 hover:bg-cyan-700 disabled:opacity-30 text-cyan-100 px-3 py-1 text-xs rounded border border-cyan-600"
                      >
                        {assessmentLoading ? 'Evaluating...' : 'Submit Assessment'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Floating casualty pin card ── */}
              {activeCasualtyPin && (
                <div
                  className="absolute top-4 bg-gray-900/95 border border-red-700 rounded-lg shadow-2xl overflow-hidden"
                  style={{
                    zIndex: 1002,
                    left: 16,
                    width: 420,
                    maxHeight: 'calc(100% - 32px)',
                    overflowY: 'auto',
                  }}
                >
                  <div className="flex items-center justify-between px-3 py-2 bg-red-900/40 border-b border-red-800">
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                          activeCasualtyPin.currentTag === 'red'
                            ? 'bg-red-700 text-white'
                            : activeCasualtyPin.currentTag === 'yellow'
                              ? 'bg-yellow-600 text-white'
                              : activeCasualtyPin.currentTag === 'green'
                                ? 'bg-green-700 text-white'
                                : activeCasualtyPin.currentTag === 'black'
                                  ? 'bg-gray-600 text-white'
                                  : 'bg-gray-500 text-white'
                        }`}
                      >
                        {activeCasualtyPin.currentTag.toUpperCase()}
                      </span>
                      <span className="text-xs text-red-300 font-bold">
                        Casualty — {activeCasualtyPin.id.slice(0, 12)}
                      </span>
                    </div>
                    <button
                      onClick={() => setActiveCasualtyPin(null)}
                      className="text-gray-400 hover:text-white text-sm px-1"
                    >
                      ✕
                    </button>
                  </div>

                  {activeCasualtyPin.currentTag !== activeCasualtyPin.trueTag && (
                    <div className="px-3 py-1.5 bg-red-950 border-b border-red-800 text-xs text-red-400">
                      Deteriorated: was {activeCasualtyPin.trueTag.toUpperCase()}, now{' '}
                      {activeCasualtyPin.currentTag.toUpperCase()}
                    </div>
                  )}

                  {activeCasualtyPin.deteriorationLevel > 0 && (
                    <div className="px-3 py-2 border-b border-gray-800">
                      <div className="text-xs text-gray-500 mb-1">Deterioration</div>
                      <div className="w-full h-2 bg-gray-800 rounded overflow-hidden">
                        <div
                          className="h-full transition-all"
                          style={{
                            width: `${activeCasualtyPin.deteriorationLevel * 100}%`,
                            backgroundColor:
                              activeCasualtyPin.deteriorationLevel > 0.7
                                ? '#ef4444'
                                : activeCasualtyPin.deteriorationLevel > 0.4
                                  ? '#f97316'
                                  : '#eab308',
                          }}
                        />
                      </div>
                    </div>
                  )}

                  <div className="px-3 py-2 border-b border-gray-800">
                    <label className="block text-xs text-red-400 mb-1">Description</label>
                    <textarea
                      value={activeCasualtyPin.description}
                      onChange={(e) => {
                        const desc = e.target.value;
                        setCasualtyPins((prev) =>
                          prev.map((p) =>
                            p.id === activeCasualtyPin.id ? { ...p, description: desc } : p,
                          ),
                        );
                        setActiveCasualtyPin((prev) =>
                          prev ? { ...prev, description: desc } : prev,
                        );
                      }}
                      placeholder="Describe the casualty's injuries..."
                      className="w-full bg-gray-800 border border-gray-700 text-green-300 text-xs rounded px-2 py-1.5 resize-none focus:border-red-500 focus:outline-none"
                      rows={3}
                    />
                  </div>

                  <div className="px-3 py-2 border-b border-gray-800 text-xs space-y-1">
                    <div className="text-red-400 font-bold mb-1">Observable Signs</div>
                    <div className="text-gray-400">
                      Breathing: {activeCasualtyPin.observableSigns.breathing || '—'}
                    </div>
                    <div className="text-gray-400">
                      Pulse: {activeCasualtyPin.observableSigns.pulse || '—'}
                    </div>
                    <div className="text-gray-400">
                      Consciousness: {activeCasualtyPin.observableSigns.consciousness || '—'}
                    </div>
                    <div className="text-gray-400">
                      Injuries: {activeCasualtyPin.observableSigns.visibleInjuries || '—'}
                    </div>
                    <div className="text-gray-400">
                      Mobility: {activeCasualtyPin.observableSigns.mobility || '—'}
                    </div>
                    <div className="text-gray-400">
                      Bleeding: {activeCasualtyPin.observableSigns.bleeding || '—'}
                    </div>
                  </div>

                  <div className="px-3 py-2 border-b border-gray-800 text-xs text-gray-500">
                    {activeCasualtyPin.insideBuilding ? 'Inside building' : 'Outside building'}
                    {activeCasualtyPin.studId && (
                      <span className="ml-2 text-gray-700">Stud: {activeCasualtyPin.studId}</span>
                    )}
                  </div>

                  <div className="px-3 py-2 border-t border-gray-800">
                    <button
                      onClick={() => {
                        setCasualtyPins((prev) =>
                          prev.filter((c) => c.id !== activeCasualtyPin.id),
                        );
                        setActiveCasualtyPin(null);
                      }}
                      className="w-full bg-red-900/40 hover:bg-red-800 text-red-300 text-xs px-3 py-1.5 rounded border border-red-700"
                    >
                      Delete This Casualty
                    </button>
                  </div>
                </div>
              )}

              {/* ── Floating hazard detail card ── */}
              {activeHazard && (
                <div
                  className="absolute top-4 bg-gray-900/95 border border-orange-700 rounded-lg shadow-2xl overflow-hidden"
                  style={{
                    zIndex: 1002,
                    right: 16,
                    width: 380,
                    maxHeight: 'calc(100% - 32px)',
                    overflowY: 'auto',
                  }}
                >
                  <div className="flex items-center justify-between px-3 py-2 bg-orange-900/40 border-b border-orange-800">
                    <div
                      className="text-xs font-bold"
                      style={{ color: HAZARD_DEFS[activeHazard.hazardType].color }}
                    >
                      {HAZARD_DEFS[activeHazard.hazardType].icon} {activeHazard.label}
                    </div>
                    <button
                      onClick={() => setActiveHazard(null)}
                      className="text-gray-400 hover:text-white text-sm px-1"
                    >
                      ✕
                    </button>
                  </div>

                  {/* Runtime hazard state (during gameplay) */}
                  {hazardRuntimeStates?.has(activeHazard.id) &&
                    gameState.clock.phase !== 'setup' &&
                    (() => {
                      const rs = hazardRuntimeStates.get(activeHazard.id)!;
                      const phaseColors: Record<string, string> = {
                        stable: 'bg-green-800 text-green-200',
                        triggered: 'bg-yellow-800 text-yellow-200',
                        worsening: 'bg-orange-800 text-orange-200',
                        critical: 'bg-red-800 text-red-200',
                        resolved: 'bg-gray-700 text-gray-300',
                      };
                      return (
                        <div className="px-3 py-2 border-b border-gray-800">
                          <div className="flex items-center gap-2 mb-1">
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase ${phaseColors[rs.phase] || 'bg-gray-700 text-gray-300'}`}
                            >
                              {rs.phase}
                            </span>
                          </div>
                          <div className="text-xs text-gray-300">{rs.phaseDescription}</div>
                        </div>
                      );
                    })()}

                  {/* Hazard type & severity */}
                  <div className="px-3 py-2 flex gap-2 items-center border-b border-gray-800">
                    <select
                      value={activeHazard.severity}
                      onChange={(e) => {
                        const sev = e.target.value as HazardZone['severity'];
                        setHazardZones((prev) =>
                          prev.map((h) => (h.id === activeHazard.id ? { ...h, severity: sev } : h)),
                        );
                        setActiveHazard((prev) => (prev ? { ...prev, severity: sev } : prev));
                      }}
                      className="bg-gray-800 border border-orange-800 text-orange-300 text-xs rounded px-2 py-1"
                    >
                      <option value="low">Low Severity</option>
                      <option value="medium">Medium Severity</option>
                      <option value="high">High Severity</option>
                    </select>
                  </div>

                  {/* Radius slider */}
                  <div className="px-3 py-2 border-b border-gray-800">
                    <label className="block text-xs text-orange-400 mb-1">
                      Radius: {activeHazard.radius}m
                    </label>
                    <input
                      type="range"
                      min={2}
                      max={50}
                      step={1}
                      value={activeHazard.radius}
                      onChange={(e) => {
                        const r = Number(e.target.value);
                        setHazardZones((prev) =>
                          prev.map((h) => (h.id === activeHazard.id ? { ...h, radius: r } : h)),
                        );
                        setActiveHazard((prev) => (prev ? { ...prev, radius: r } : prev));
                      }}
                      className="w-full"
                    />
                    <div className="flex justify-between text-[10px] text-gray-600 mt-0.5">
                      <span>2m</span>
                      <span>50m</span>
                    </div>
                  </div>

                  {/* Description */}
                  <div className="px-3 py-2 border-b border-gray-800">
                    <label className="block text-xs text-orange-400 mb-1">Description</label>
                    <textarea
                      value={activeHazard.description}
                      onChange={(e) => {
                        const desc = e.target.value;
                        setHazardZones((prev) =>
                          prev.map((h) =>
                            h.id === activeHazard.id ? { ...h, description: desc } : h,
                          ),
                        );
                        setActiveHazard((prev) => (prev ? { ...prev, description: desc } : prev));
                      }}
                      placeholder="Describe the hazard — chemical type, material, risk level, containment needs..."
                      className="w-full bg-gray-800 border border-gray-700 text-green-300 text-xs rounded px-2 py-1.5 resize-none focus:border-orange-500 focus:outline-none"
                      rows={3}
                    />
                  </div>

                  {/* Photos */}
                  <div className="px-3 py-2">
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-xs text-orange-400">
                        Photos ({activeHazard.photos.length})
                      </label>
                      <div className="flex gap-1">
                        <input
                          ref={hazardPhotoRef}
                          type="file"
                          accept="image/*"
                          capture="environment"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (!file || !activeHazard) return;
                            const reader = new FileReader();
                            reader.onloadend = () => {
                              const url = reader.result as string;
                              const updated = [...activeHazard.photos, url];
                              setHazardZones((prev) =>
                                prev.map((h) =>
                                  h.id === activeHazard.id ? { ...h, photos: updated } : h,
                                ),
                              );
                              setActiveHazard((prev) =>
                                prev ? { ...prev, photos: updated } : prev,
                              );
                            };
                            reader.readAsDataURL(file);
                            e.target.value = '';
                          }}
                        />
                        <button
                          onClick={() => hazardPhotoRef.current?.click()}
                          className="bg-orange-800 hover:bg-orange-700 text-orange-100 text-xs px-2 py-0.5 rounded border border-orange-600"
                        >
                          📷 Take Photo
                        </button>
                        <button
                          onClick={() => {
                            const input = document.createElement('input');
                            input.type = 'file';
                            input.accept = 'image/*';
                            input.onchange = (ev) => {
                              const file = (ev.target as HTMLInputElement).files?.[0];
                              if (!file || !activeHazard) return;
                              const reader = new FileReader();
                              reader.onloadend = () => {
                                const url = reader.result as string;
                                const updated = [...activeHazard.photos, url];
                                setHazardZones((prev) =>
                                  prev.map((h) =>
                                    h.id === activeHazard.id ? { ...h, photos: updated } : h,
                                  ),
                                );
                                setActiveHazard((prev) =>
                                  prev ? { ...prev, photos: updated } : prev,
                                );
                              };
                              reader.readAsDataURL(file);
                            };
                            input.click();
                          }}
                          className="bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs px-2 py-0.5 rounded border border-gray-600"
                        >
                          📁 Gallery
                        </button>
                      </div>
                    </div>
                    {activeHazard.photos.length === 0 && (
                      <p className="text-xs text-gray-600 italic">
                        No photos yet — add photos of the potential hazard
                      </p>
                    )}
                    <div className="grid grid-cols-2 gap-1.5">
                      {activeHazard.photos.map((photo, i) => (
                        <div key={i} className="relative group">
                          <img
                            src={photo}
                            alt={`Hazard photo ${i + 1}`}
                            className="w-full h-24 object-cover rounded border border-gray-700"
                          />
                          <button
                            onClick={() => {
                              const updated = activeHazard.photos.filter((_, idx) => idx !== i);
                              setHazardZones((prev) =>
                                prev.map((h) =>
                                  h.id === activeHazard.id ? { ...h, photos: updated } : h,
                                ),
                              );
                              setActiveHazard((prev) =>
                                prev ? { ...prev, photos: updated } : prev,
                              );
                            }}
                            className="absolute top-0.5 right-0.5 bg-red-800 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Delete hazard */}
                  <div className="px-3 py-2 border-t border-gray-800">
                    <button
                      onClick={() => {
                        setHazardZones((prev) => prev.filter((h) => h.id !== activeHazard.id));
                        setActiveHazard(null);
                      }}
                      className="w-full bg-red-900/40 hover:bg-red-800 text-red-300 text-xs px-3 py-1.5 rounded border border-red-700"
                    >
                      Delete This Hazard
                    </button>
                  </div>
                </div>
              )}

              {/* ── Floating exit detail card ── */}
              {activeExit && (
                <div
                  className="absolute top-4 bg-gray-900/95 border border-cyan-700 rounded-lg shadow-2xl overflow-hidden"
                  style={{
                    zIndex: 1002,
                    right: 16,
                    width: 360,
                    maxHeight: 'calc(100% - 32px)',
                    overflowY: 'auto',
                  }}
                >
                  <div className="flex items-center justify-between px-3 py-2 bg-cyan-900/40 border-b border-cyan-800">
                    <div className="text-xs text-cyan-300 font-bold">Exit — {activeExit.id}</div>
                    <button
                      onClick={() => setActiveExit(null)}
                      className="text-gray-400 hover:text-white text-sm px-1"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="px-3 py-2 space-y-2">
                    <div>
                      <label className="block text-xs text-cyan-400 mb-1">Status</label>
                      <select
                        value={activeExit.status}
                        onChange={(e) => {
                          const s = e.target.value as ExitDef['status'];
                          setExits((prev) =>
                            prev.map((ex) => (ex.id === activeExit.id ? { ...ex, status: s } : ex)),
                          );
                          setActiveExit((prev) => (prev ? { ...prev, status: s } : prev));
                        }}
                        className="w-full bg-gray-800 border border-gray-700 text-cyan-300 text-xs rounded px-2 py-1"
                      >
                        <option value="open">Open</option>
                        <option value="blocked">Blocked</option>
                        <option value="congested">Congested</option>
                        <option value="unknown">Unknown</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-cyan-400 mb-1">Description</label>
                      <textarea
                        value={activeExit.description}
                        onChange={(e) => {
                          const d = e.target.value;
                          setExits((prev) =>
                            prev.map((ex) =>
                              ex.id === activeExit.id ? { ...ex, description: d } : ex,
                            ),
                          );
                          setActiveExit((prev) => (prev ? { ...prev, description: d } : prev));
                        }}
                        placeholder="Describe this exit — is it clear? Obstructed? What does it look like?"
                        className="w-full bg-gray-800 border border-gray-700 text-green-300 text-xs rounded px-2 py-1.5 resize-none"
                        rows={3}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-cyan-400 mb-1">
                        Width: {activeExit.width.toFixed(1)}m
                      </label>
                    </div>
                    <div className="flex items-center justify-between">
                      <label className="text-xs text-cyan-400">
                        Photos ({activeExit.photos.length})
                      </label>
                      <div className="flex gap-1">
                        <input
                          ref={exitPhotoRef}
                          type="file"
                          accept="image/*"
                          capture="environment"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (!file || !activeExit) return;
                            const reader = new FileReader();
                            reader.onloadend = () => {
                              const url = reader.result as string;
                              const updated = [...activeExit.photos, url];
                              setExits((prev) =>
                                prev.map((ex) =>
                                  ex.id === activeExit.id ? { ...ex, photos: updated } : ex,
                                ),
                              );
                              setActiveExit((prev) => (prev ? { ...prev, photos: updated } : prev));
                            };
                            reader.readAsDataURL(file);
                            e.target.value = '';
                          }}
                        />
                        <button
                          onClick={() => exitPhotoRef.current?.click()}
                          className="bg-cyan-800 hover:bg-cyan-700 text-cyan-100 text-xs px-2 py-0.5 rounded border border-cyan-600"
                        >
                          📷 Photo
                        </button>
                      </div>
                    </div>
                    {activeExit.photos.length > 0 && (
                      <div className="grid grid-cols-2 gap-1.5">
                        {activeExit.photos.map((p, i) => (
                          <div key={i} className="relative group">
                            <img
                              src={p}
                              alt={`Exit photo ${i + 1}`}
                              className="w-full h-20 object-cover rounded border border-gray-700"
                            />
                            <button
                              onClick={() => {
                                const updated = activeExit.photos.filter((_, idx) => idx !== i);
                                setExits((prev) =>
                                  prev.map((ex) =>
                                    ex.id === activeExit.id ? { ...ex, photos: updated } : ex,
                                  ),
                                );
                                setActiveExit((prev) =>
                                  prev ? { ...prev, photos: updated } : prev,
                                );
                              }}
                              className="absolute top-0.5 right-0.5 bg-red-800 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center opacity-0 group-hover:opacity-100"
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="px-3 py-2 border-t border-gray-800">
                    <button
                      onClick={() => {
                        setExits((prev) => prev.filter((ex) => ex.id !== activeExit.id));
                        setActiveExit(null);
                      }}
                      className="w-full bg-red-900/40 hover:bg-red-800 text-red-300 text-xs px-3 py-1.5 rounded border border-red-700"
                    >
                      Delete This Exit
                    </button>
                  </div>
                </div>
              )}

              {/* ── Floating wall detail card ── */}
              {activeWall && (
                <div
                  className="absolute top-4 bg-gray-900/95 border border-gray-500 rounded-lg shadow-2xl overflow-hidden"
                  style={{
                    zIndex: 1002,
                    right: 16,
                    width: 360,
                    maxHeight: 'calc(100% - 32px)',
                    overflowY: 'auto',
                  }}
                >
                  <div className="flex items-center justify-between px-3 py-2 bg-gray-700/40 border-b border-gray-600">
                    <div className="text-xs text-gray-200 font-bold">
                      Interior Wall — {activeWall.id}
                    </div>
                    <button
                      onClick={() => setActiveWall(null)}
                      className="text-gray-400 hover:text-white text-sm px-1"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="px-3 py-2 space-y-2">
                    <div>
                      <label className="block text-xs text-gray-300 mb-1">Material</label>
                      <input
                        value={activeWall.material}
                        onChange={(e) => {
                          const m = e.target.value;
                          setInteriorWalls((prev) =>
                            prev.map((w) => (w.id === activeWall.id ? { ...w, material: m } : w)),
                          );
                          setActiveWall((prev) => (prev ? { ...prev, material: m } : prev));
                        }}
                        placeholder="e.g. Concrete, Drywall, Glass, Metal"
                        className="w-full bg-gray-800 border border-gray-700 text-green-300 text-xs rounded px-2 py-1"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-300 mb-1">Description</label>
                      <textarea
                        value={activeWall.description}
                        onChange={(e) => {
                          const d = e.target.value;
                          setInteriorWalls((prev) =>
                            prev.map((w) =>
                              w.id === activeWall.id ? { ...w, description: d } : w,
                            ),
                          );
                          setActiveWall((prev) => (prev ? { ...prev, description: d } : prev));
                        }}
                        placeholder="Describe this wall section — thickness, condition, any openings..."
                        className="w-full bg-gray-800 border border-gray-700 text-green-300 text-xs rounded px-2 py-1.5 resize-none"
                        rows={3}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-gray-400 flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={activeWall.hasDoor}
                          onChange={(e) => {
                            const v = e.target.checked;
                            setInteriorWalls((prev) =>
                              prev.map((w) => (w.id === activeWall.id ? { ...w, hasDoor: v } : w)),
                            );
                            setActiveWall((prev) => (prev ? { ...prev, hasDoor: v } : prev));
                          }}
                        />{' '}
                        Has Door
                      </label>
                      <span className="text-xs text-gray-600">
                        Length:{' '}
                        {Math.hypot(
                          activeWall.end.x - activeWall.start.x,
                          activeWall.end.y - activeWall.start.y,
                        ).toFixed(1)}
                        m
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <label className="text-xs text-gray-300">
                        Photos ({activeWall.photos.length})
                      </label>
                      <div className="flex gap-1">
                        <input
                          ref={wallPhotoRef}
                          type="file"
                          accept="image/*"
                          capture="environment"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (!file || !activeWall) return;
                            const reader = new FileReader();
                            reader.onloadend = () => {
                              const url = reader.result as string;
                              const updated = [...activeWall.photos, url];
                              setInteriorWalls((prev) =>
                                prev.map((w) =>
                                  w.id === activeWall.id ? { ...w, photos: updated } : w,
                                ),
                              );
                              setActiveWall((prev) => (prev ? { ...prev, photos: updated } : prev));
                            };
                            reader.readAsDataURL(file);
                            e.target.value = '';
                          }}
                        />
                        <button
                          onClick={() => wallPhotoRef.current?.click()}
                          className="bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs px-2 py-0.5 rounded border border-gray-600"
                        >
                          📷 Photo
                        </button>
                      </div>
                    </div>
                    {activeWall.photos.length > 0 && (
                      <div className="grid grid-cols-2 gap-1.5">
                        {activeWall.photos.map((p, i) => (
                          <div key={i} className="relative group">
                            <img
                              src={p}
                              alt={`Wall photo ${i + 1}`}
                              className="w-full h-20 object-cover rounded border border-gray-700"
                            />
                            <button
                              onClick={() => {
                                const updated = activeWall.photos.filter((_, idx) => idx !== i);
                                setInteriorWalls((prev) =>
                                  prev.map((w) =>
                                    w.id === activeWall.id ? { ...w, photos: updated } : w,
                                  ),
                                );
                                setActiveWall((prev) =>
                                  prev ? { ...prev, photos: updated } : prev,
                                );
                              }}
                              className="absolute top-0.5 right-0.5 bg-red-800 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center opacity-0 group-hover:opacity-100"
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="px-3 py-2 border-t border-gray-800">
                    <button
                      onClick={() => {
                        setInteriorWalls((prev) => prev.filter((w) => w.id !== activeWall.id));
                        setActiveWall(null);
                      }}
                      className="w-full bg-red-900/40 hover:bg-red-800 text-red-300 text-xs px-3 py-1.5 rounded border border-red-700"
                    >
                      Delete This Wall
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Right sidebar */}
        {!rightPanelOpen && (
          <PanelEdgeTab
            side="right"
            label={phase === 'map' ? 'Buildings' : 'Controls'}
            portrait={isPortrait}
            orderClass={isPortrait ? 'order-2' : 'order-3'}
            onOpen={() => setRightPanelOpen(true)}
          />
        )}
        {phase === 'map' ? (
          /* Building list (map phase) */
          <div
            className={`${isPortrait ? 'order-2 w-full border-t' : 'order-3 w-[28rem] border-l flex-shrink-0'} border-green-800 overflow-y-auto p-3 space-y-3 min-h-0${rightPanelOpen ? '' : ' hidden'}`}
          >
            <PanelCollapseButton
              side="right"
              portrait={isPortrait}
              onClick={() => setRightPanelOpen(false)}
            />
            <div className="bg-gray-900 border border-green-800 rounded p-3">
              <h2 className="text-sm text-amber-400 mb-2 border-b border-green-900 pb-1">
                RTS Prototype
              </h2>
              <div className="text-xs text-green-700 space-y-1">
                <p>1. Click the map or load a saved map</p>
                <p>2. Fetch buildings nearby</p>
                <p>3. Click a building to enter the RTS scenario</p>
                <p>4. Place exits, blast site, hazards, casualties</p>
                <p>5. Hit DETONATE to start the exercise</p>
              </div>
            </div>

            {/* Saved maps */}
            <div className="bg-gray-900 border border-green-800 rounded p-3">
              <h2 className="text-sm text-green-500 mb-2 border-b border-green-900 pb-1">
                Saved Maps
              </h2>
              {savedMaps.length === 0 && (
                <p className="text-xs text-green-800 italic">No saved maps yet</p>
              )}
              <div className="space-y-1.5 mb-2">
                {savedMaps.map((m) => (
                  <div key={m.id} className="flex items-center gap-1">
                    <button
                      onClick={() => handleLoadSavedMap(m)}
                      className="flex-1 text-left p-1.5 rounded border border-green-900 hover:border-green-700 text-xs text-green-500 hover:text-green-400 transition-colors"
                    >
                      <div className="font-bold">{m.name}</div>
                      <div className="text-green-800">
                        {m.grids.filter((g) => g.polygon.length >= 3).length} buildings
                      </div>
                    </button>
                    <button
                      onClick={() => handleDeleteSavedMap(m.id)}
                      className="text-red-700 hover:text-red-400 text-xs px-1"
                      title="Delete saved map"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              {fetchResult && (
                <div className="flex gap-1 mt-2">
                  <input
                    type="text"
                    value={saveMapName}
                    onChange={(e) => setSaveMapName(e.target.value)}
                    placeholder="Map name..."
                    className="flex-1 bg-gray-800 border border-green-800 text-green-300 px-2 py-1 text-xs rounded"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveMap();
                    }}
                  />
                  <button
                    onClick={handleSaveMap}
                    disabled={!saveMapName.trim() || liveOnly}
                    className="bg-green-800 hover:bg-green-700 disabled:opacity-30 text-green-100 px-2 py-1 text-xs rounded border border-green-600"
                  >
                    {liveOnly ? 'Demo' : 'Save'}
                  </button>
                </div>
              )}
            </div>

            <div className="bg-gray-900 border border-amber-800 rounded p-3">
              <h2 className="text-sm text-amber-400 mb-2">Sample scenes</h2>
              <button
                type="button"
                onClick={handleLoadFoodCourt}
                className="w-full text-xs text-left px-2 py-1.5 rounded border border-amber-700 text-amber-200 hover:border-amber-400"
              >
                Load food court
              </button>
              <button
                type="button"
                onClick={handleLoadHarbourHouse}
                className="w-full text-xs text-left px-2 py-1.5 mt-1 rounded border border-amber-700 text-amber-200 hover:border-amber-400"
              >
                Load Harbour House
              </button>
              <button
                type="button"
                onClick={handleLoadSmokeCorridor}
                className="w-full text-xs text-left px-2 py-1.5 mt-1 rounded border border-amber-700 text-amber-200 hover:border-amber-400"
              >
                Load smoke corridor test
              </button>
              <button
                type="button"
                onClick={handleLoadStairShaft}
                className="w-full text-xs text-left px-2 py-1.5 mt-1 rounded border border-amber-700 text-amber-200 hover:border-amber-400"
              >
                Load stair shaft test
              </button>
              <button
                type="button"
                onClick={handleLoadOfficeTower}
                className="w-full text-xs text-left px-2 py-1.5 mt-1 rounded border border-amber-700 text-amber-200 hover:border-amber-400"
              >
                Load three-storey office fire
              </button>
              <button
                type="button"
                onClick={handleLoadHollandVillage}
                disabled={hollandLoading}
                className="w-full text-xs text-left px-2 py-1.5 mt-1 rounded border border-amber-700 text-amber-200 hover:border-amber-400 disabled:opacity-50"
              >
                {hollandLoading ? 'Loading Holland Village…' : 'Load Holland Village'}
              </button>
              {hollandError && <p className="text-xs text-red-400 mt-1">{hollandError}</p>}
              <p className="text-xs text-amber-800 mt-2">
                Opens the plan in this browser. It does not save to the database.
              </p>
            </div>

            {/* Saved Scenes (DB) */}
            <div className="bg-gray-900 border border-blue-800 rounded p-3">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm text-blue-400 border-b border-blue-900 pb-1">
                  Saved Scenes (DB)
                </h2>
                <button
                  onClick={handleLoadDbSceneList}
                  className="text-xs text-blue-500 hover:text-blue-300"
                >
                  Refresh
                </button>
              </div>
              {dbScenes.length === 0 && (
                <p className="text-xs text-blue-800 italic">Click Refresh to load saved scenes</p>
              )}
              <div className="space-y-1.5">
                {dbScenes.map((sc) => (
                  <div key={sc.id} className="flex items-center gap-1">
                    <button
                      onClick={() => handleLoadSceneFromDb(sc.id)}
                      className="flex-1 text-left p-1.5 rounded border border-blue-900 hover:border-blue-700 text-xs text-blue-400 hover:text-blue-300"
                    >
                      <div className="font-bold">{sc.name || sc.building_name || 'Untitled'}</div>
                      <div className="text-blue-700">
                        {new Date(sc.updated_at).toLocaleDateString()}
                      </div>
                    </button>
                    <button
                      onClick={() => handleDeleteDbScene(sc.id)}
                      className="text-red-700 hover:text-red-400 text-xs px-1"
                      title="Delete"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Building list */}
            {fetchResult && (
              <div className="bg-gray-900 border border-green-800 rounded p-3">
                <h2 className="text-sm text-green-500 mb-2 border-b border-green-900 pb-1">
                  Buildings ({fetchResult.grids.filter((g) => g.polygon.length >= 3).length})
                </h2>
                <div className="space-y-1.5">
                  {fetchResult.grids
                    .map((grid, idx) => ({ grid, idx }))
                    .filter(({ grid }) => grid.polygon.length >= 3)
                    .map(({ grid, idx }) => (
                      <div key={idx} className="flex gap-1">
                        <button
                          onClick={() => selectBuilding(idx)}
                          className={`flex-1 text-left p-2 rounded border text-xs transition-colors ${
                            selectedGridIdx === idx
                              ? 'border-cyan-500 bg-cyan-900/30 text-cyan-300'
                              : 'border-green-900 hover:border-green-700 text-green-500 hover:text-green-400'
                          }`}
                        >
                          <div className="font-bold">
                            {grid.buildingName || `Building #${grid.buildingIndex}`}
                          </div>
                          <div className="text-green-700 mt-0.5">
                            {grid.polygon.length} pts
                            {grid.polygon.length <= 5 && (
                              <span className="text-amber-500 ml-1">⚠</span>
                            )}
                          </div>
                        </button>
                        <button
                          onClick={() => {
                            setRedrawIndex(idx);
                            setDrawnBuildingName(
                              grid.buildingName || `Building #${grid.buildingIndex}`,
                            );
                            setDrawnVertices([]);
                            setDrawingBuilding(true);
                          }}
                          title="Redraw this building's outline"
                          className="px-2 rounded border border-amber-900 text-amber-500 hover:text-amber-300 hover:border-amber-700 text-xs"
                        >
                          ✏️
                        </button>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          /* RTS controls (rts phase) */
          <div
            className={`${isPortrait ? 'order-2 w-full border-t' : 'order-3 w-[28rem] border-l flex-shrink-0'} border-green-800 overflow-y-auto p-3 space-y-3 min-h-0${rightPanelOpen ? '' : ' hidden'}`}
          >
            <PanelCollapseButton
              side="right"
              portrait={isPortrait}
              onClick={() => setRightPanelOpen(false)}
            />
            {/* Clock */}
            <div className="bg-gray-900 border border-green-800 rounded p-3">
              <div className="text-sm text-amber-400 font-bold mb-2">{phaseLabel}</div>
              <div className="text-2xl text-amber-300 font-bold text-center mb-3">
                {clockDisplay}
              </div>
              {showcase && !blastFiredRef.current && countdownLabel(gameState.clock.elapsed) && (
                <div className="text-center text-amber-200 text-sm mb-2">
                  {countdownLabel(gameState.clock.elapsed)}
                </div>
              )}
              <div className="flex gap-2">
                {gameState.clock.phase === 'setup' ? (
                  <button
                    onClick={handleDetonation}
                    disabled={
                      exits.length === 0 ||
                      detonationLoading ||
                      (showcase && (!blastSite || allSimStuds.length === 0))
                    }
                    className="flex-1 bg-red-800 hover:bg-red-700 disabled:opacity-30 text-white text-xs px-2 py-2 rounded border border-red-600 font-bold"
                  >
                    {detonationLoading
                      ? '⏳ Enriching...'
                      : showcase
                        ? '▶ START SHOWCASE'
                        : '💥 DETONATE'}
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      rts.togglePause();
                      rerender();
                    }}
                    className="flex-1 bg-gray-800 hover:bg-gray-700 text-green-300 text-xs px-2 py-1.5 rounded border border-green-800"
                  >
                    {gameState.clock.paused ? '▶ Resume' : '⏸ Pause'}
                  </button>
                )}
              </div>
              {gameState.clock.phase !== 'setup' && (
                <div className="flex gap-1 mt-2">
                  {[1, 2, 5, 10].map((s) => (
                    <button
                      key={s}
                      onClick={() => {
                        rts.setSpeed(s);
                        rerender();
                      }}
                      className={`flex-1 text-xs py-1 rounded border ${
                        gameState.clock.speed === s
                          ? 'border-amber-400 bg-amber-900/30 text-amber-300'
                          : 'border-green-900 text-green-600 hover:text-green-400'
                      }`}
                    >
                      {s}x
                    </button>
                  ))}
                </div>
              )}
              {slowedSpeed && !gameState.clock.paused && gameState.clock.phase !== 'setup' && (
                <div className="text-center text-amber-500 text-xs mt-1">
                  {slowedSpeed}: frames are too slow for the chosen speed
                </div>
              )}
            </div>

            <div className="bg-gray-900 border border-green-800 rounded p-3 space-y-2">
              <div className="text-xs text-green-400 font-bold">Wind</div>
              <label className="block text-xs text-gray-400">
                Open-country speed at 10 m, m/s
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={windSpeedMs}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setWindSpeedMs(Number.isFinite(next) && next > 0 ? next : 0);
                  }}
                  className="mt-1 w-full bg-gray-800 border border-gray-700 text-gray-100 px-2 py-1 text-xs rounded"
                />
              </label>
              <label className="block text-xs text-gray-400">
                Direction the wind travels, degrees from +x
                <input
                  type="number"
                  step={15}
                  value={windDeg}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setWindDeg(Number.isFinite(next) ? next : 0);
                  }}
                  className="mt-1 w-full bg-gray-800 border border-gray-700 text-gray-100 px-2 py-1 text-xs rounded"
                />
              </label>
              <div className="text-xs text-gray-500">
                Airport speed, open country, at 10 m. The site is suburban, so the local wind
                at 10 m is {windTerrainFactor(10).toFixed(2)} of this, and a lower opening sees
                less. 0 is still air. A face the wind blows straight onto takes Cp 0.6, then the
                angle and the plan's side ratio.
              </div>
            </div>

            <div className="space-y-1.5 border border-amber-900 rounded p-2">
              <div className="text-xs text-amber-400">Objects on studs</div>
              <button
                type="button"
                onClick={() => {
                  const next = !placingObject;
                  setPlacingObject(next);
                  placeObjectRef.current = next;
                  if (next) {
                    rts.setInteractionMode({ type: 'select' });
                    setObjectNotice('Click a stud.');
                  } else {
                    setObjectNotice(null);
                  }
                  rerender();
                }}
                className={`w-full text-xs text-left px-2 py-1.5 rounded border ${
                  placingObject
                    ? 'border-amber-400 bg-amber-900/30 text-amber-200'
                    : 'border-gray-700 text-gray-300 hover:border-gray-500'
                }`}
              >
                Place object {placingObject ? '(click a stud)' : ''}
              </button>
              {objectNotice && <div className="text-xs text-amber-500">{objectNotice}</div>}
              {placedObjects.length > 0 && (
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {placedObjects
                    .filter((obj) => (obj.level ?? 'G') === activeLevel)
                    .map((obj) => (
                      <button
                        key={obj.id}
                        type="button"
                        onClick={() => setActiveObjectId(obj.id)}
                        className={`w-full text-left text-xs px-2 py-1 rounded border ${
                          obj.id === activeObjectId
                            ? 'border-amber-400 text-amber-200'
                            : 'border-gray-800 text-gray-400'
                        }`}
                      >
                        {obj.confirmed
                          ? obj.matches.map((match) => match.label).join(', ') || 'Confirmed'
                          : obj.description || 'Unconfirmed'}
                        {obj.confirmed && obj.description
                          ? ` · ${obj.description.slice(0, 42)}`
                          : ''}
                        {obj.confirmed ? '' : ' · not confirmed'}
                      </button>
                    ))}
                </div>
              )}
              {(() => {
                const active = placedObjects.find((obj) => obj.id === activeObjectId);
                if (!active) return null;
                return (
                  <div className="space-y-1.5">
                    <label className="block text-xs text-gray-400">
                      Describe it
                      <input
                        value={active.description}
                        onChange={(e) => {
                          const description = e.target.value;
                          const matches = matchMaterials(
                            description,
                            ENABLE_AI_ENRICHMENT ? { suggest: suggestLibraryEntry } : undefined,
                          );
                          setPlacedObjects((prev) =>
                            prev.map((obj) =>
                              obj.id === active.id
                                ? { ...obj, description, matches, confirmed: false }
                                : obj,
                            ),
                          );
                        }}
                        placeholder="wooden table, steel legs"
                        className="mt-1 w-full bg-gray-800 border border-gray-700 text-gray-100 px-2 py-1 text-xs rounded"
                      />
                    </label>
                    <div className="flex flex-wrap gap-1">
                      {COMMON_PICKS.map((pick) => (
                        <button
                          key={pick.entryId}
                          type="button"
                          onClick={() => {
                            const entry = entryById(pick.entryId);
                            if (!entry) return;
                            setPlacedObjects((prev) =>
                              prev.map((obj) =>
                                obj.id === active.id
                                  ? {
                                      ...obj,
                                      description: pick.label,
                                      matches: [matchFromEntry(entry, 'common')],
                                      confirmed: false,
                                    }
                                  : obj,
                              ),
                            );
                          }}
                          className="text-xs px-1.5 py-1 rounded border border-gray-700 text-gray-300 hover:border-amber-600"
                        >
                          {pick.label}
                        </button>
                      ))}
                    </div>
                    {active.matches.length === 0 ? (
                      <div className="text-xs text-gray-500">
                        No library match yet. Pick a common item or choose one.
                      </div>
                    ) : (
                      <ul className="text-xs text-gray-300 space-y-0.5">
                        {active.matches.map((match) => (
                          <li key={match.entryId}>
                            {match.label} —{' '}
                            {entryCanBurn(match.fuel) ? 'can catch fire' : 'does not catch fire'}
                            {match.source === 'ai' ? ' · suggestion, confirm it' : ''}
                          </li>
                        ))}
                      </ul>
                    )}
                    <label className="block text-xs text-gray-500">
                      Choose another
                      <select
                        value=""
                        onChange={(e) => {
                          const entry = entryById(e.target.value);
                          if (!entry) return;
                          setPlacedObjects((prev) =>
                            prev.map((obj) =>
                              obj.id === active.id
                                ? {
                                    ...obj,
                                    matches: [matchFromEntry(entry, 'chosen')],
                                    confirmed: false,
                                  }
                                : obj,
                            ),
                          );
                        }}
                        className="mt-1 w-full bg-gray-800 border border-gray-700 text-gray-200 px-1 py-1 text-xs rounded"
                      >
                        <option value="">Library entry…</option>
                        {MATERIAL_LIBRARY.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        disabled={active.matches.length === 0 || active.confirmed}
                        onClick={() => {
                          setPlacedObjects((prev) =>
                            prev.map((obj) =>
                              obj.id === active.id ? { ...obj, confirmed: true } : obj,
                            ),
                          );
                        }}
                        className="flex-1 text-xs px-2 py-1.5 rounded border border-amber-600 text-amber-100 bg-amber-900/40 disabled:opacity-30"
                      >
                        {active.confirmed ? 'Confirmed' : 'Confirm'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setPlacedObjects((prev) => prev.filter((obj) => obj.id !== active.id));
                          setActiveObjectId(null);
                        }}
                        className="text-xs px-2 py-1.5 rounded border border-red-900 text-red-400"
                      >
                        Remove
                      </button>
                    </div>
                    <div className="text-xs text-gray-500">
                      {active.confirmed
                        ? 'Confirmed. Only a match that can catch fire will burn.'
                        : 'Not confirmed. This object does nothing.'}
                    </div>
                    {active.confirmed &&
                      active.matches.some((match) => match.behaviour === 'pressurised_gas') && (
                        <div className="space-y-1.5 border-t border-gray-800 pt-1.5">
                          <label className="block text-xs text-gray-400">
                            Automatic valve (seconds)
                            <input
                              type="number"
                              min={0}
                              step={1}
                              value={
                                active.valveSec != null && Number.isFinite(active.valveSec)
                                  ? active.valveSec
                                  : ''
                              }
                              placeholder="stays open"
                              onChange={(e) => {
                                const raw = e.target.value.trim();
                                const parsed = raw === '' ? null : Number(raw);
                                const valveSec =
                                  parsed != null && Number.isFinite(parsed) && parsed > 0
                                    ? parsed
                                    : null;
                                setPlacedObjects((prev) =>
                                  prev.map((obj) =>
                                    obj.id === active.id ? { ...obj, valveSec } : obj,
                                  ),
                                );
                              }}
                              className="mt-1 w-full bg-gray-800 border border-gray-700 text-gray-100 px-2 py-1 text-xs rounded"
                            />
                          </label>
                          <p className="text-xs text-gray-500">
                            Blank leaves the jet on until someone shuts it off. A time closes it on
                            its own.
                          </p>
                          {gameState.clock.phase === 'setup' && (
                            <button
                              type="button"
                              onClick={() => {
                                setBlastSite({ x: active.pos.x, y: active.pos.y });
                                setBlastLevel(active.level || 'G');
                                setManualRadius(true);
                                setBlastRadius(1);
                              }}
                              className="w-full text-xs px-2 py-1.5 rounded border border-orange-700 text-orange-200 hover:border-orange-400"
                            >
                              Blast at this line
                            </button>
                          )}
                          {effectsEngineRef.current?.isJetting(active.id) && (
                            <button
                              type="button"
                              onClick={() => {
                                effectsEngineRef.current?.shutOffGas(active.id);
                                setGasJetCount(effectsEngineRef.current?.gasJets().length ?? 0);
                              }}
                              className="w-full text-xs px-2 py-1.5 rounded border border-orange-400 bg-orange-900/50 text-orange-100"
                            >
                              Shut off this line
                            </button>
                          )}
                        </div>
                      )}
                    {active.confirmed &&
                      active.matches.some((match) => match.behaviour === 'electrical') &&
                      effectsEngineRef.current?.isArcing(active.id) && (
                        <button
                          type="button"
                          onClick={() => {
                            effectsEngineRef.current?.shutOffPower(active.id);
                            setArcCount(effectsEngineRef.current?.electricalArcs().length ?? 0);
                          }}
                          className="w-full text-xs px-2 py-1.5 rounded border border-sky-400 bg-sky-900/50 text-sky-100"
                        >
                          Shut off this supply
                        </button>
                      )}
                  </div>
                );
              })()}
            </div>

            <div className="bg-gray-900 border border-green-800 rounded p-3 space-y-2">
              <label className="flex items-center gap-2 text-xs text-green-300">
                <input
                  type="checkbox"
                  checked={showcase}
                  onChange={(e) => setShowcase(e.target.checked)}
                />
                Showcase mode
              </label>
              {showcase && (
                <div className="space-y-2 text-xs">
                  <label className="block text-green-500">
                    After exiting
                    <select
                      value={afterExit}
                      onChange={(e) =>
                        setAfterExit(e.target.value as 'zone' | 'disperse' | 'mixed')
                      }
                      className="mt-1 w-full bg-black border border-green-800 text-green-300 px-2 py-1 rounded"
                    >
                      <option value="zone">Go to assigned zones</option>
                      <option value="disperse">Keep running off the map</option>
                      <option value="mixed">Mixed (30% disperse)</option>
                    </select>
                  </label>
                  <label className="block text-green-500">
                    Effects
                    <select
                      value={fxQuality}
                      onChange={(e) => {
                        const next = e.target.value as FxQuality;
                        setFxQuality(next);
                        setFxDowngraded(false);
                        fxDowngradeFromRef.current = null;
                        fxTimeCountRef.current = 0;
                        fxWarmupRef.current = 30;
                        try {
                          localStorage.setItem('rtsFxQuality', next);
                        } catch {
                          /* ignore */
                        }
                      }}
                      className="mt-1 w-full bg-black border border-green-800 text-green-300 px-2 py-1 rounded"
                    >
                      <option value="high">High</option>
                      <option value="low">Low</option>
                      <option value="classic">Classic</option>
                    </select>
                  </label>
                  {fxDowngraded && (
                    <div className="text-amber-400">
                      Effects lowered to keep the sim smooth{' '}
                      <button
                        type="button"
                        className="underline"
                        onClick={() => {
                          const prev = fxDowngradeFromRef.current ?? fxQualityRef.current;
                          fxDowngradeFromRef.current = null;
                          fxSuppressRef.current = true;
                          setFxQuality(prev);
                          setFxDowngraded(false);
                          fxTimeCountRef.current = 0;
                          try {
                            localStorage.setItem('rtsFxQuality', prev);
                          } catch {
                            /* ignore */
                          }
                        }}
                      >
                        Undo
                      </button>
                    </div>
                  )}
                  <div className="space-y-1">
                    {(() => {
                      const zones = gameState.equipment.filter(
                        (e) => e.def.kind === 'assembly_point' && e.active,
                      );
                      const minD = assemblyMinDistanceM(aboveGroundHeightM(selectedGrid?.floors));
                      const unsafe = (e: (typeof zones)[number]) => {
                        const tooClose =
                          projectedVerts.length >= 3 &&
                          distanceToOutline(e.pos.x, e.pos.y, projectedVerts) < minD;
                        const inGlass =
                          !!blastSite &&
                          Math.hypot(e.pos.x - blastSite.x, e.pos.y - blastSite.y) <=
                            SHOWCASE.ZONE_UNSAFE_FACTOR * blastRadius;
                        return tooClose || inGlass;
                      };
                      const allUnsafe = zones.length > 0 && zones.every(unsafe);
                      return (
                        <>
                          {zones.map((e) => {
                            const minD = assemblyMinDistanceM(
                              aboveGroundHeightM(selectedGrid?.floors),
                            );
                            const notes: string[] = [];
                            if (
                              projectedVerts.length >= 3 &&
                              distanceToOutline(e.pos.x, e.pos.y, projectedVerts) < minD
                            ) {
                              notes.push(`Too close to building (< ${minD} m)`);
                            }
                            if (
                              blastSite &&
                              Math.hypot(e.pos.x - blastSite.x, e.pos.y - blastSite.y) <=
                                SHOWCASE.ZONE_UNSAFE_FACTOR * blastRadius
                            ) {
                              notes.push('Inside glass-injury radius');
                            }
                            const status = notes.length > 0 ? notes.join(' · ') : 'OK';
                            return (
                              <div
                                key={e.id}
                                className="border border-green-900 rounded p-2 space-y-1"
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span>{e.def.label}</span>
                                  <select
                                    value={zoneKinds[e.id] ?? 'assembly'}
                                    onChange={(ev) =>
                                      setZoneKinds((prev) => ({
                                        ...prev,
                                        [e.id]: ev.target.value as ZoneKind,
                                      }))
                                    }
                                    className="bg-black border border-green-800 text-green-300 px-1 py-0.5 rounded"
                                  >
                                    <option value="assembly">Assembly</option>
                                    <option value="safe">Safe</option>
                                    <option value="convening">Convening</option>
                                  </select>
                                </div>
                                <div
                                  className={status === 'OK' ? 'text-green-500' : 'text-amber-400'}
                                >
                                  {status}
                                </div>
                              </div>
                            );
                          })}
                          {allUnsafe && (
                            <div className="text-amber-400">
                              All assembly zones are unsafe; people will use the one farthest from
                              the blast.
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              rts.setInteractionMode({
                                type: 'place_equipment',
                                equipmentKind: 'assembly_point',
                              });
                              rerender();
                            }}
                            className="w-full text-left px-2 py-1.5 rounded border border-green-900 text-green-400 hover:border-green-700"
                          >
                            + Add zone
                          </button>
                        </>
                      );
                    })()}
                  </div>
                  <div className="space-y-1">
                    {exits.map((ex, i) => (
                      <label key={ex.id} className="flex items-center justify-between gap-2">
                        <span>Exit {i + 1}</span>
                        <select
                          value={
                            ex.status === 'blocked' || ex.status === 'congested'
                              ? ex.status
                              : 'open'
                          }
                          onChange={(ev) => {
                            const status = ev.target.value as ExitDef['status'];
                            setExits((prev) =>
                              prev.map((item) => (item.id === ex.id ? { ...item, status } : item)),
                            );
                          }}
                          className="bg-black border border-green-800 text-green-300 px-1 py-0.5 rounded"
                        >
                          <option value="open">open</option>
                          <option value="congested">congested</option>
                          <option value="blocked">blocked</option>
                        </select>
                      </label>
                    ))}
                  </div>
                  <p className="text-amber-500" title={ASSUMED_VALUE_TOOLTIP}>
                    Illustrative values, pending review
                  </p>
                </div>
              )}
            </div>

            {showcase && gameState.clock.phase !== 'setup' && showcaseHud?.metrics && (
              <div className="bg-gray-900 border border-green-800 rounded p-3 text-xs space-y-1 text-green-300">
                <div>Idle {showcaseHud.metrics.idle}</div>
                <div>Reacting {showcaseHud.metrics.reacting}</div>
                <div>
                  Evacuating {showcaseHud.metrics.evacuating} (crawling{' '}
                  {showcaseHud.metrics.crawling})
                </div>
                <div>Outside {showcaseHud.metrics.outside}</div>
                {Object.keys(showcaseHud.metrics.arrived).length === 0 ? (
                  <div>Arrived 0</div>
                ) : (
                  Object.entries(showcaseHud.metrics.arrived).map(([id, n]) => (
                    <div key={id}>
                      Arrived {gameState.equipment.find((eq) => eq.id === id)?.def.label ?? id}: {n}
                    </div>
                  ))
                )}
                {showcaseHud.metrics.unsafeZoneNote && (
                  <div className="text-amber-400">{showcaseHud.metrics.unsafeZoneNote}</div>
                )}
                <div>Left map {showcaseHud.metrics.leftMap}</div>
                <div>
                  Down {showcaseHud.metrics.down.lethal} lethal / {showcaseHud.metrics.down.serious}{' '}
                  serious
                </div>
                <div>Fume crawl {showcaseHud.metrics.fumeHeld}</div>
                <div>
                  Frozen {showcaseHud.metrics.frozen} (marshals freed {showcaseHud.metrics.unfrozen}
                  )
                </div>
                <div>Fume down {showcaseHud.metrics.fumeDown}</div>
                <div>Minor injured {showcaseHud.metrics.minorInjured}</div>
                <div>Reroutes {showcaseHud.metrics.reroutes}</div>
                <div>Burning studs {showcaseHud.burning}</div>
                <div>Smoke-affected studs {showcaseHud.smoke}</div>
              </div>
            )}

            {gameState.clock.phase !== 'setup' &&
              stairwells.some((sw) => (sw.kind ?? 'stair') === 'stair' && !sw.blocked) && (
                <StairFlightPanel
                  flights={stairFlights}
                  stairs={stairwells.filter(
                    (sw) => (sw.kind ?? 'stair') === 'stair' && !sw.blocked,
                  )}
                  stairId={responderStairId}
                  onStairId={setResponderStairId}
                  onSendUp={(id) => evacEngRef.current?.sendStairResponders(id, 4)}
                />
              )}

            {gasJetCount > 0 && (
              <div className="bg-gray-900 border border-orange-600 rounded p-3 space-y-2">
                <div className="text-xs text-orange-200">Gas jets {gasJetCount}</div>
                <button
                  type="button"
                  onClick={() => {
                    effectsEngineRef.current?.shutOffGas();
                    setGasJetCount(0);
                  }}
                  className="w-full text-xs px-2 py-1.5 rounded border border-orange-400 bg-orange-800 text-orange-50 font-bold"
                >
                  Shut off gas
                </button>
              </div>
            )}

            {sprayCount > 0 && (
              <div className="bg-gray-900 border border-sky-400 rounded p-3">
                <div className="text-xs text-sky-100">Sprays {sprayCount}</div>
              </div>
            )}

            {arcCount > 0 && (
              <div className="bg-gray-900 border border-sky-500 rounded p-3 space-y-2">
                <div className="text-xs text-sky-200">Arcs {arcCount}</div>
                <button
                  type="button"
                  onClick={() => {
                    effectsEngineRef.current?.shutOffPower();
                    setArcCount(0);
                  }}
                  className="w-full text-xs px-2 py-1.5 rounded border border-sky-400 bg-sky-800 text-sky-50 font-bold"
                >
                  Shut off power
                </button>
              </div>
            )}

            {/* Setup tools */}
            {gameState.clock.phase === 'setup' && (
              <div className="bg-gray-900 border border-green-800 rounded p-3 space-y-2">
                <div className="text-xs text-green-500 uppercase tracking-wider">Setup</div>
                <div className="space-y-1.5">
                  <button
                    onClick={() => {
                      rts.setInteractionMode(
                        gameState.interactionMode.type === 'place_exit'
                          ? { type: 'select' }
                          : { type: 'place_exit' },
                      );
                      rerender();
                    }}
                    className={`w-full text-xs text-left px-2 py-1.5 rounded border transition-colors ${
                      gameState.interactionMode.type === 'place_exit'
                        ? 'border-cyan-400 bg-cyan-900/30 text-cyan-300'
                        : 'border-green-900 text-green-500 hover:border-green-700'
                    }`}
                  >
                    🚪 Place Exit
                  </button>
                  <button
                    onClick={() => {
                      rts.setInteractionMode(
                        gameState.interactionMode.type === 'place_blast_site'
                          ? { type: 'select' }
                          : { type: 'place_blast_site' },
                      );
                      rerender();
                    }}
                    className={`w-full text-xs text-left px-2 py-1.5 rounded border transition-colors ${
                      gameState.interactionMode.type === 'place_blast_site'
                        ? 'border-red-400 bg-red-900/30 text-red-300'
                        : 'border-red-900 text-red-400 hover:border-red-700'
                    }`}
                  >
                    💥 Place Blast Site {blastSite ? '(replace)' : '(click map)'}
                  </button>
                  <button
                    onClick={() => setGpsEnabled((prev) => !prev)}
                    className={`w-full text-xs text-left px-2 py-1.5 rounded border transition-colors ${
                      gpsEnabled
                        ? 'border-blue-400 bg-blue-900/30 text-blue-300'
                        : 'border-green-900 text-green-500 hover:border-green-700'
                    }`}
                  >
                    📍 {gpsEnabled ? 'GPS Tracking ON' : 'Show My Location'}
                    {gpsEnabled && gpsSimPos && (
                      <span className="text-blue-500 ml-1">(±{Math.round(gpsAccuracy)}m)</span>
                    )}
                    {gpsEnabled && !gpsSimPos && (
                      <span className="text-yellow-500 ml-1 animate-pulse">(acquiring...)</span>
                    )}
                  </button>
                  {ENABLE_CASUALTY_PLACEMENT && (
                    <button
                      onClick={() => {
                        const handlePlace = (e: MouseEvent) => {
                          const canvas = canvasRef.current;
                          if (!canvas) return;
                          const rect = canvas.getBoundingClientRect();
                          const cx = e.clientX - rect.left;
                          const cy = e.clientY - rect.top;
                          const sim = toSim(cx, cy);
                          const snapped = snapToStud(sim);

                          let distance = 50;
                          if (blastSite) {
                            distance = Math.hypot(
                              snapped.pos.x - blastSite.x,
                              snapped.pos.y - blastSite.y,
                            );
                          }
                          const pin = generateSingleCasualty(distance, snapped.pos);
                          if (snapped.stud) {
                            pin.studId = snapped.stud.id;
                            pin.insideBuilding = snapped.stud.spatialContext === 'inside_building';
                            pin.spatialContext = snapped.stud.spatialContext ?? undefined;
                          }
                          pin.level = activeLevelRef.current;
                          setCasualtyPins((prev) => [...prev, pin]);
                          rerender();
                        };
                        canvasRef.current?.addEventListener('click', handlePlace, { once: true });
                      }}
                      className="w-full text-xs text-left px-2 py-1.5 rounded border border-red-900 text-red-400 hover:border-red-700"
                    >
                      🏥 Place Casualty{' '}
                      {blastSite ? '(injury based on blast distance)' : '(click map)'}
                    </button>
                  )}
                  <button
                    onClick={() => {
                      const handlePlace = (e: MouseEvent) => {
                        const canvas = canvasRef.current;
                        if (!canvas || projectedVerts.length < 3) return;
                        const rect = canvas.getBoundingClientRect();
                        const cx = e.clientX - rect.left;
                        const cy = e.clientY - rect.top;
                        const sim = toSim(cx, cy);
                        const snap = nearestEdge(sim.x, sim.y, projectedVerts);
                        const grid = selectedGrid;
                        if (!grid) return;
                        const n = grid.polygon.length;
                        const a = grid.polygon[snap.edgeIndex];
                        const b = grid.polygon[(snap.edgeIndex + 1) % n];
                        const pLat = a[0] + snap.t * (b[0] - a[0]);
                        const pLng = a[1] + snap.t * (b[1] - a[1]);
                        const metersPerDegLat = 111320;
                        const metersPerDegLng = 111320 * Math.cos((pLat * Math.PI) / 180);
                        const edgeDx = snap.point.x - sim.x;
                        const edgeDy = snap.point.y - sim.y;
                        const newPoint: WallInspectionPoint = {
                          id: `custom-${Date.now()}`,
                          wallIndex: snap.edgeIndex,
                          lat: pLat,
                          lng: pLng,
                          cameraLat: pLat + (edgeDy * 28) / metersPerDegLat,
                          cameraLng: pLng + (edgeDx * 28) / metersPerDegLng,
                          heading: 0,
                          simPos: { x: snap.point.x, y: snap.point.y },
                          imageUrl: null,
                          cached: false,
                          imageSource: 'custom',
                        };
                        setWallPoints((prev) => [...prev, newPoint]);
                        handleWallPointClick(newPoint);
                        canvas.removeEventListener('click', handlePlace);
                        rerender();
                      };
                      canvasRef.current?.addEventListener('click', handlePlace, { once: true });
                    }}
                    className="w-full text-xs text-left px-2 py-1.5 rounded border border-amber-900 text-amber-400 hover:border-amber-700"
                  >
                    📸 Add Custom Photo Point (click wall)
                  </button>
                </div>

                {/* Interior elements */}
                <div className="space-y-1.5 border-t border-green-900 pt-2">
                  <div className="text-xs text-green-500 uppercase tracking-wider">
                    Interior Elements
                  </div>
                  <button
                    onClick={() => {
                      rts.setInteractionMode(
                        gameState.interactionMode.type === 'draw_wall'
                          ? { type: 'select' }
                          : { type: 'draw_wall', startPoint: null },
                      );
                      rerender();
                    }}
                    className={`w-full text-xs text-left px-2 py-1.5 rounded border transition-colors ${
                      gameState.interactionMode.type === 'draw_wall'
                        ? 'border-cyan-400 bg-cyan-900/30 text-cyan-300'
                        : 'border-gray-700 text-gray-300 hover:border-gray-500'
                    }`}
                  >
                    🧱 Draw Interior Wall{' '}
                    {gameState.interactionMode.type === 'draw_wall' &&
                    gameState.interactionMode.startPoint
                      ? '(click end point)'
                      : '(click start → click end)'}
                  </button>
                  <button
                    onClick={() => {
                      rts.setInteractionMode(
                        gameState.interactionMode.type === 'place_door'
                          ? { type: 'select' }
                          : { type: 'place_door' },
                      );
                      rerender();
                    }}
                    className={`w-full text-xs text-left px-2 py-1.5 rounded border transition-colors ${
                      gameState.interactionMode.type === 'place_door'
                        ? 'border-cyan-400 bg-cyan-900/30 text-cyan-300'
                        : 'border-gray-700 text-gray-300 hover:border-gray-500'
                    }`}
                  >
                    🚪 Add Door to Interior Wall (click near wall)
                  </button>
                  <div className="text-xs text-gray-500 mt-1">Hazard Zones:</div>
                  <div className="grid grid-cols-2 gap-1">
                    {(Object.keys(HAZARD_DEFS) as HazardType[]).map((ht) => {
                      const def = HAZARD_DEFS[ht];
                      return (
                        <button
                          key={ht}
                          onClick={() => {
                            rts.setInteractionMode(
                              gameState.interactionMode.type === 'place_hazard' &&
                                (gameState.interactionMode as { hazardType?: string })
                                  .hazardType === ht
                                ? { type: 'select' }
                                : { type: 'place_hazard', hazardType: ht },
                            );
                            rerender();
                          }}
                          className={`text-xs px-1.5 py-1 rounded border text-left transition-colors ${
                            gameState.interactionMode.type === 'place_hazard' &&
                            gameState.interactionMode.hazardType === ht
                              ? 'border-cyan-400 bg-cyan-900/30'
                              : 'border-gray-700 hover:border-gray-500'
                          }`}
                          style={{ color: def.color }}
                        >
                          {def.icon} {def.label}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    onClick={() => {
                      const placing =
                        gameState.interactionMode.type === 'place_stairwell' &&
                        placeLinkKindRef.current === 'stair';
                      placeLinkKindRef.current = 'stair';
                      rts.setInteractionMode(
                        placing ? { type: 'select' } : { type: 'place_stairwell' },
                      );
                      rerender();
                    }}
                    className={`w-full text-xs text-left px-2 py-1.5 rounded border transition-colors ${
                      gameState.interactionMode.type === 'place_stairwell' &&
                      placeLinkKindRef.current === 'stair'
                        ? 'border-cyan-400 bg-cyan-900/30 text-cyan-300'
                        : 'border-gray-700 text-gray-300 hover:border-gray-500'
                    }`}
                  >
                    🪜 Place stair
                  </button>
                  <button
                    onClick={() => {
                      placeLinkKindRef.current = 'lift';
                      rts.setInteractionMode({ type: 'place_stairwell' });
                      rerender();
                    }}
                    className={`w-full text-xs text-left px-2 py-1.5 rounded border transition-colors ${
                      gameState.interactionMode.type === 'place_stairwell' &&
                      placeLinkKindRef.current === 'lift'
                        ? 'border-cyan-400 bg-cyan-900/30 text-cyan-300'
                        : 'border-gray-700 text-gray-300 hover:border-gray-500'
                    }`}
                  >
                    🛗 Place lift
                  </button>
                  {stairwells.length > 0 &&
                    (() => {
                      const editing =
                        stairwells.find((sw) => sw.id === selectedStairId) ?? stairwells[0];
                      return (
                        <>
                          <label className="block text-xs text-slate-400">
                            Edit stair
                            <select
                              value={editing.id}
                              onChange={(e) => setSelectedStairId(e.target.value)}
                              className="w-full bg-gray-800 border border-slate-700 text-slate-200 px-1 py-0.5 rounded mt-0.5"
                            >
                              {stairwells.map((sw) => (
                                <option key={sw.id} value={sw.id}>
                                  {sw.label || sw.id}
                                </option>
                              ))}
                            </select>
                          </label>
                          <StairEditor
                            stair={editing}
                            levels={levels}
                            onChange={(next) =>
                              setStairwells((prev) =>
                                prev.map((sw) =>
                                  sw.id === next.id ? normaliseStairwell(next, levels) : sw,
                                ),
                              )
                            }
                          />
                        </>
                      );
                    })()}
                  <div className="text-xs text-green-700">
                    Walls: {interiorWalls.length} · Hazards: {hazardZones.length} · Objects:{' '}
                    {placedObjects.length} · Stairs: {stairwells.length}
                  </div>
                </div>

                {/* Stud grid toggle + inspect */}
                <div className="border-t border-green-900 pt-2 space-y-1.5">
                  <label className="flex items-center gap-2 text-xs text-green-500 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={showStudGrid}
                      onChange={(e) => setShowStudGrid(e.target.checked)}
                      className="rounded border-green-700"
                    />
                    Show stud grid
                    <span className="text-green-800">
                      ({allSimStuds.length} studs, hidden in the showcase)
                    </span>
                  </label>
                  <label className="flex items-center gap-2 text-xs text-cyan-500 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={studInspectMode}
                      onChange={(e) => {
                        setStudInspectMode(e.target.checked);
                        if (!e.target.checked) setInspectedStud(null);
                      }}
                      className="rounded border-cyan-700"
                    />
                    Inspect studs (tap to examine)
                  </label>
                  {inspectedStud && (
                    <div className="bg-gray-950 border border-cyan-800 rounded p-2 text-xs space-y-0.5">
                      <div className="text-cyan-300 font-bold">{inspectedStud.id}</div>
                      <div className="text-green-400">
                        Context:{' '}
                        <span
                          className={
                            inspectedStud.spatialContext === 'inside_building'
                              ? 'text-green-300'
                              : 'text-gray-400'
                          }
                        >
                          {inspectedStud.spatialContext ?? 'unknown'}
                        </span>
                      </div>
                      <div className="text-gray-400">Type: {inspectedStud.studType}</div>
                      <div className="text-gray-400">
                        Lat: {inspectedStud.lat.toFixed(6)}, Lng: {inspectedStud.lng.toFixed(6)}
                      </div>
                      <div className="text-gray-400">
                        Sim: ({inspectedStud.simPos.x.toFixed(1)},{' '}
                        {inspectedStud.simPos.y.toFixed(1)})
                      </div>
                      {(() => {
                        const es = effectStates?.get(inspectedStud.id);
                        if (!es) return null;
                        return (
                          <>
                            {es.fire.state !== 'none' && (
                              <div className="text-red-400">Fire: {es.fire.state}</div>
                            )}
                            {es.gas > 0.01 && (
                              <div className="text-lime-400">Gas: {(es.gas * 100).toFixed(0)}%</div>
                            )}
                            {es.flood > 0.01 && (
                              <div className="text-blue-400">
                                Flood: {(es.flood * 100).toFixed(0)}%
                              </div>
                            )}
                            {es.structural > 0.01 && (
                              <div className="text-red-300">
                                Structural risk: {(es.structural * 100).toFixed(0)}%
                              </div>
                            )}
                          </>
                        );
                      })()}
                      {(() => {
                        const inZones = hazardZones.filter(
                          (h) =>
                            Math.hypot(
                              h.pos.x - inspectedStud!.simPos.x,
                              h.pos.y - inspectedStud!.simPos.y,
                            ) <= h.radius,
                        );
                        if (inZones.length === 0)
                          return (
                            <div className="text-gray-600 italic">No fuel (no hazard zone)</div>
                          );
                        return (
                          <div className="text-orange-400">
                            Fuel: {inZones.map((z) => z.label).join(', ')}
                          </div>
                        );
                      })()}
                      <button
                        onClick={() => setInspectedStud(null)}
                        className="text-xs text-cyan-600 hover:text-cyan-400 mt-1"
                      >
                        Dismiss
                      </button>
                    </div>
                  )}
                </div>

                {/* Blast radius + operational zones */}
                {blastSite && (
                  <div className="space-y-1.5 border-t border-green-900 pt-2">
                    <div className="text-xs text-green-500 uppercase tracking-wider">
                      Blast & Zones
                    </div>
                    <div className="space-y-1.5">
                      <div className="text-xs text-green-400 uppercase tracking-wider">Charge</div>
                      <label className="block text-xs text-green-600">
                        Explosive
                        <select
                          value={charge.presetKey}
                          onChange={(e) =>
                            setCharge((prev) => ({ ...prev, presetKey: e.target.value }))
                          }
                          className="mt-0.5 w-full bg-gray-800 border border-green-900 text-green-300 text-xs rounded px-1 py-1"
                        >
                          {BLAST_DATASET.presets.map((preset) => (
                            <option key={preset.key} value={preset.key}>
                              {preset.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block text-xs text-green-600">
                        Amount
                        <span className="mt-0.5 flex items-center gap-1">
                          <input
                            type="number"
                            min={0.1}
                            max={2000}
                            step={0.1}
                            value={Number.isFinite(charge.amountKg) ? charge.amountKg : ''}
                            onChange={(e) => {
                              const amountKg =
                                e.target.value === '' ? Number.NaN : Number(e.target.value);
                              setCharge((prev) => ({ ...prev, amountKg }));
                            }}
                            onBlur={(e) => {
                              const amountKg =
                                e.target.value === '' ? Number.NaN : Number(e.target.value);
                              const result = clampCharge({ ...charge, amountKg });
                              setCharge(result.spec);
                              setChargeNote(result.notes[0] ?? null);
                            }}
                            className="w-full bg-gray-800 border border-green-900 text-green-200 text-xs rounded px-1 py-1"
                          />
                          <span>kg</span>
                        </span>
                      </label>
                      <label className="flex items-center gap-2 text-xs text-green-500">
                        <input
                          type="radio"
                          name="charge-burst"
                          checked={charge.burst === 'surface'}
                          onChange={() => setCharge((prev) => ({ ...prev, burst: 'surface' }))}
                        />
                        Surface (on or near the ground)
                      </label>
                      <label className="flex items-center gap-2 text-xs text-green-500">
                        <input
                          type="radio"
                          name="charge-burst"
                          checked={charge.burst === 'free_air'}
                          onChange={() => setCharge((prev) => ({ ...prev, burst: 'free_air' }))}
                        />
                        Free air (raised)
                      </label>
                      <label className="block text-xs text-green-600">
                        Height
                        <span className="mt-0.5 flex items-center gap-1">
                          <input
                            type="number"
                            min={0.5}
                            max={30}
                            step={0.1}
                            disabled={charge.burst !== 'free_air'}
                            value={Number.isFinite(charge.heightM) ? charge.heightM : ''}
                            onChange={(e) => {
                              const heightM =
                                e.target.value === '' ? Number.NaN : Number(e.target.value);
                              setCharge((prev) => ({ ...prev, heightM }));
                            }}
                            onBlur={() => {
                              const result = clampCharge(charge);
                              setCharge(result.spec);
                              setChargeNote(result.notes[0] ?? null);
                            }}
                            className="w-full bg-gray-800 border border-green-900 text-green-200 text-xs rounded px-1 py-1 disabled:opacity-40"
                          />
                          <span>m</span>
                        </span>
                      </label>
                      {chargeNote && <div className="text-xs text-amber-500">{chargeNote}</div>}
                      <div
                        className="text-xs text-green-300 leading-relaxed"
                        title={chargeTooltip(charge, rings.notes)}
                      >
                        {manualRadius ? (
                          <div>Manual radius (not calculated)</div>
                        ) : (
                          <>
                            <div>
                              ≈ {rings.tntKg.toFixed(1)} kg TNT-equivalent (pressure) ·{' '}
                              {charge.burst === 'surface' ? 'surface burst' : 'free-air burst'}
                            </div>
                            <div>
                              Lethal ≤ {rings.lethalM.toFixed(1)} m · Serious ≤{' '}
                              {rings.seriousM.toFixed(1)} m · Minor ≤ {rings.minorM.toFixed(1)} m
                            </div>
                            <div>
                              Glass injury ≤ {rings.glassInjuryM.toFixed(1)} m · Glass breakage ≤{' '}
                              {rings.glassBreakageM.toFixed(1)} m
                            </div>
                            {chargePreset?.tntEqPressure.confidence === 'low' && (
                              <div>Low-confidence TNT factor for {chargePreset.label}</div>
                            )}
                            <div>
                              Calculated from Kingery–Bulmash curves and UFC thresholds (pending
                              review) · walls not modelled
                            </div>
                          </>
                        )}
                        <label className="mt-1 flex items-center gap-2 text-amber-500 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={manualRadius}
                            onChange={(e) => setManualRadius(e.target.checked)}
                          />
                          Manual override
                        </label>
                      </div>
                      <label className="flex items-center gap-2 text-xs text-amber-400">
                        Fireball
                        <input
                          type="number"
                          min={1}
                          max={100}
                          step={0.5}
                          value={blastRadius}
                          disabled={!manualRadius}
                          onChange={(e) => {
                            const next = Number(e.target.value);
                            if (Number.isFinite(next))
                              setBlastRadius(Math.min(100, Math.max(1, next)));
                          }}
                          className="w-16 bg-gray-800 border border-amber-900 text-amber-100 text-xs rounded px-1 py-0.5 disabled:opacity-40"
                        />
                        <span>m</span>
                      </label>
                      <input
                        type="range"
                        min={1}
                        max={100}
                        step={1}
                        value={blastRadius}
                        disabled={!manualRadius}
                        onChange={(e) => setBlastRadius(Number(e.target.value))}
                        className="w-full disabled:opacity-40"
                      />
                    </div>
                    <label className="flex items-center gap-2 text-xs text-amber-500 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={showGameZones}
                        onChange={(e) => setShowGameZones(e.target.checked)}
                        className="rounded border-amber-700"
                      />
                      Show operational zones
                    </label>
                    {showGameZones &&
                      gameZones.map((gz) => {
                        const colors: Record<string, string> = {
                          hot: 'text-red-400',
                          warm: 'text-orange-400',
                          cold: 'text-yellow-400',
                        };
                        const labels: Record<string, string> = {
                          hot: 'Hot Zone',
                          warm: 'Warm Zone',
                          cold: 'Cold Zone',
                        };
                        return (
                          <div key={gz.id}>
                            <label
                              className={`block text-xs mb-1 ${colors[gz.type] || 'text-gray-400'}`}
                            >
                              {labels[gz.type] || gz.type}: {gz.radius}m
                            </label>
                            <input
                              type="range"
                              min={10}
                              max={500}
                              step={5}
                              value={gz.radius}
                              onChange={(e) => {
                                const r = Number(e.target.value);
                                setGameZones((prev) =>
                                  prev.map((z) => (z.id === gz.id ? { ...z, radius: r } : z)),
                                );
                              }}
                              className="w-full"
                            />
                          </div>
                        );
                      })}
                  </div>
                )}

                {/* Polygon enhancement */}
                <div className="space-y-1.5 border-t border-green-900 pt-2">
                  <div className="text-xs text-green-500 uppercase tracking-wider">
                    Building Polygon
                  </div>
                  <div className="text-xs text-green-700">
                    {projectedVerts.length} vertices
                    {selectedGrid?.polygon && selectedGrid.polygon.length <= 5 && (
                      <span className="text-amber-500 ml-1">
                        ⚠ Simple shape — may need enhancement
                      </span>
                    )}
                  </div>
                  {ENABLE_MICROSOFT_FOOTPRINT && (
                    <button
                      onClick={async () => {
                        if (!selectedGrid) return;
                        const cLat =
                          selectedGrid.polygon.reduce((s, p) => s + p[0], 0) /
                          selectedGrid.polygon.length;
                        const cLng =
                          selectedGrid.polygon.reduce((s, p) => s + p[1], 0) /
                          selectedGrid.polygon.length;
                        try {
                          const headers = await getAuthHeaders();
                          const resp = await fetch(apiUrl('/api/debug/enhance-building'), {
                            method: 'POST',
                            headers,
                            body: JSON.stringify({
                              lat: cLat,
                              lng: cLng,
                              polygon: selectedGrid.polygon,
                              radius: 200,
                            }),
                          });
                          if (resp.ok) {
                            const { data } = await resp.json();
                            if (data.enhanced && fetchResult && selectedGridIdx != null) {
                              const newGrids = [...fetchResult.grids];
                              newGrids[selectedGridIdx] = {
                                ...newGrids[selectedGridIdx],
                                polygon: data.polygon,
                              };
                              setFetchResult({ ...fetchResult, grids: newGrids });
                              const verts = projectPolygon(data.polygon);
                              rtsRef.current.setBuildingVertices(verts);
                              const pts = generateWallPoints(data.polygon, verts);
                              setWallPoints(pts);
                              rerender();
                              alert(`Polygon enhanced: ${data.reason}`);
                            } else {
                              alert(`Not enhanced: ${data.reason}`);
                            }
                          }
                        } catch {
                          alert('Enhancement request failed');
                        }
                      }}
                      className="w-full text-xs text-left px-2 py-1.5 rounded border border-amber-900 text-amber-400 hover:border-amber-700"
                    >
                      🔍 Enhance with Microsoft Footprints
                    </button>
                  )}
                </div>

                <div>
                  <label className="block text-xs text-green-600 mb-1">Exit Width (m)</label>
                  <input
                    type="range"
                    min={1}
                    max={8}
                    step={0.5}
                    value={newExitWidth}
                    onChange={(e) => setNewExitWidth(Number(e.target.value))}
                    className="w-full"
                  />
                  <span className="text-xs text-green-400">{newExitWidth}m</span>
                </div>
                <div>
                  <label className="block text-xs text-green-600 mb-1">Pedestrian Count</label>
                  <input
                    type="number"
                    min={1}
                    step={10}
                    value={
                      levels.length > 1
                        ? (levels.find((l) => l.id === activeLevel)?.pedestrianCount ??
                          pedestrianCount)
                        : pedestrianCount
                    }
                    onChange={(e) => {
                      const n = Math.max(0, Number(e.target.value) || 0);
                      setPedestrianCount(Math.max(1, n));
                      setLevels((prev) =>
                        prev.map((l) => (l.id === activeLevel ? { ...l, pedestrianCount: n } : l)),
                      );
                    }}
                    className="w-full bg-gray-800 border border-green-800 text-green-300 px-2 py-1 text-xs rounded"
                  />
                  <span className="text-xs text-green-700 mt-0.5 block">
                    Large counts (&gt;500) may slow the simulation
                  </span>
                </div>
                <div className="text-xs text-green-700 mt-1">
                  Exits: {exits.length} · Blast: {blastSite ? '✓' : '—'} · Casualties:{' '}
                  {casualtyPins.length}
                </div>

                {/* Hazard Effects Simulation */}
                <div className="space-y-1.5 border-t border-green-900 pt-2">
                  <div className="text-xs text-green-500 uppercase tracking-wider">
                    Hazard Effects
                  </div>
                  {blastSite && allSimStuds.length > 0 && gameState.clock.phase === 'setup' && (
                    <>
                      <div>
                        <label className="block text-xs text-green-600 mb-1">
                          Preview Time: {Math.round(effectPreviewTime / 60)}min
                        </label>
                        <input
                          type="range"
                          min={60}
                          max={3600}
                          step={60}
                          value={effectPreviewTime}
                          onChange={(e) => setEffectPreviewTime(Number(e.target.value))}
                          className="w-full"
                        />
                      </div>
                      <button
                        onClick={async () => {
                          if (previewAbortRef.current) {
                            previewAbortRef.current.abort();
                            previewAbortRef.current = null;
                            setPreviewProgress(null);
                            return;
                          }
                          if (!blastSite) return;
                          const spread = manualRadius ? blastRadius : rings.ignitionM;
                          const abort = new AbortController();
                          previewAbortRef.current = abort;
                          setPreviewProgress(0);
                          const preview = await runEffectsPreviewAsync(
                            {
                              studs: allSimStuds.map((s) => ({
                                id: s.id,
                                simPos: s.simPos,
                                spatialContext: s.spatialContext,
                                level: storeyId(s.floor),
                              })),
                              fireParams: fireParams ?? undefined,
                              building: { stairwells, levels, vertices: projectedVerts, exits },
                              objects: placedObjects,
                              hazardZones,
                              charge,
                              blast: {
                                pos: blastSite,
                                level: levels.length > 1 ? blastLevel : undefined,
                                spreadRadius: spread,
                                affectRadius: manualRadius ? blastRadius : rings.minorM,
                              },
                              hazardAnalysis: enrichResult?.hazardAnalysis,
                              hoodFanWhen: hoodFanWhenRef.current,
                              wind: {
                                speedMs: windRef.current.speedMs,
                                directionRad: windRef.current.directionRad,
                              },
                            },
                            effectPreviewTime,
                            interiorWalls,
                            {
                              signal: abort.signal,
                              // Whole percents, so most slices leave the page unrendered.
                              onProgress: (f) => setPreviewProgress(Math.floor(f * 100) / 100),
                            },
                          );
                          if (previewAbortRef.current !== abort) return;
                          previewAbortRef.current = null;
                          setPreviewProgress(null);
                          if (!preview) return;
                          effectsEngineRef.current = preview;
                          setEffectStates(new Map(preview.studStates));
                        }}
                        className="w-full bg-orange-800 hover:bg-orange-700 text-orange-100 text-xs px-3 py-1.5 rounded border border-orange-600 font-bold"
                      >
                        {previewProgress == null
                          ? 'Preview Hazard Effects'
                          : `Previewing… ${Math.round(previewProgress * 100)}% (click to cancel)`}
                      </button>
                      {effectStates && (
                        <button
                          onClick={() => {
                            cancelPreview();
                            effectsEngineRef.current = null;
                            setEffectStates(null);
                            setHazardRuntimeStates(null);
                          }}
                          className="w-full text-xs text-orange-500 hover:text-orange-300 px-2 py-1"
                        >
                          Clear Preview
                        </button>
                      )}
                    </>
                  )}
                  {!blastSite && (
                    <div className="text-xs text-green-800 italic">
                      Place a blast site to enable hazard simulation
                    </div>
                  )}
                  {allSimStuds.length === 0 && blastSite && (
                    <div className="text-xs text-green-800 italic">
                      No studs available — fetch buildings first
                    </div>
                  )}
                  {effectStates &&
                    (() => {
                      const eng = effectsEngineRef.current;
                      if (!eng) return null;
                      const stats = eng.getStats();
                      return (
                        <div className="text-xs space-y-0.5 bg-gray-950 border border-orange-900 rounded p-2">
                          <div className="text-orange-300">
                            Time: {Math.round(eng.elapsed / 60)}min
                          </div>
                          <div className="text-red-400">
                            Fire: {stats.fire.burning} burning, {stats.fire.heating} heating
                          </div>
                          <div className="text-lime-400">Gas: {stats.gasAffected} studs</div>
                          <div className="text-blue-400">Flood: {stats.floodAffected} studs</div>
                          <div className="text-red-300">
                            Structural risk: {stats.structAffected} studs
                          </div>
                          <div className="mt-1 text-[10px] text-gray-600 space-x-3">
                            <span className="inline-block w-2 h-2 rounded-full bg-red-500 mr-0.5" />
                            Fire
                            <span className="inline-block w-2 h-2 rounded-full bg-lime-400 mr-0.5" />
                            Gas
                            <span className="inline-block w-2 h-2 rounded-full bg-blue-400 mr-0.5" />
                            Flood
                            <span className="inline-block w-2 h-2 rounded-full bg-red-300 mr-0.5 border border-dashed border-red-500" />
                            Structural
                          </div>
                        </div>
                      );
                    })()}

                  {/* AI Effect Calibration */}
                  <button
                    onClick={async () => {
                      setEffectCalibrating(true);
                      try {
                        const headers = await getAuthHeaders();
                        const resp = await fetch(apiUrl('/api/debug/rts-fire-params'), {
                          method: 'POST',
                          headers,
                          body: JSON.stringify({
                            incidentDescription: 'Explosion at building',
                            buildingName: selectedGrid?.buildingName || null,
                            hazards: hazardZones.map((h) => ({
                              hazardType: h.hazardType,
                              severity: h.severity,
                              description: h.description || '',
                              photos: h.photos || [],
                            })),
                            wallMaterials: interiorWalls.map((w) => w.material).filter(Boolean),
                            blastRadius: blastRadius,
                          }),
                        });
                        if (resp.ok) {
                          const { data } = await resp.json();
                          setFireParams(data);
                        } else {
                          console.error('Effect calibration failed');
                        }
                      } catch (err) {
                        console.error('Effect calibration error:', err);
                      }
                      setEffectCalibrating(false);
                    }}
                    disabled={effectCalibrating}
                    className="w-full bg-purple-800 hover:bg-purple-700 disabled:opacity-50 text-purple-100 text-xs px-3 py-1.5 rounded border border-purple-600"
                  >
                    {effectCalibrating
                      ? 'Calibrating...'
                      : fireParams
                        ? 'Re-Calibrate Effects (AI)'
                        : 'AI Calibrate Effects'}
                  </button>
                  <div className="text-xs text-green-800">
                    GPT-5.1 calibrates fire, gas, flood, and structural spread for your materials
                  </div>
                  {fireParams?.reasoning && (
                    <div className="text-xs text-purple-400 bg-gray-950 border border-purple-900 rounded p-2">
                      {fireParams.reasoning}
                    </div>
                  )}
                </div>

                {/* AI Enrichment */}
                {ENABLE_AI_ENRICHMENT && (
                  <div className="space-y-1.5 border-t border-green-900 pt-2">
                    <div className="text-xs text-green-500 uppercase tracking-wider">
                      AI Enrichment
                    </div>
                    <button
                      onClick={handleEnrichScene}
                      disabled={enriching}
                      className="w-full bg-purple-800 hover:bg-purple-700 disabled:opacity-50 text-purple-100 text-xs px-3 py-2 rounded border border-purple-600 font-bold"
                    >
                      {enriching ? '⏳ Enriching Scene...' : '🧠 Enrich Scene with AI'}
                    </button>
                    <div className="text-xs text-green-800">
                      GPT-5.1 analyzes each hazard and casualty individually, then synthesizes
                      cross-element interactions
                    </div>
                    {enriching && (
                      <div className="text-xs text-purple-400 animate-pulse">
                        Running {hazardZones.length + casualtyPins.length + 1} parallel AI calls...
                      </div>
                    )}
                    {enrichResult && (
                      <div className="space-y-1">
                        <button
                          onClick={() => setEnrichExpanded(!enrichExpanded)}
                          className="w-full text-xs text-left text-purple-300 hover:text-purple-200 flex items-center gap-1"
                        >
                          <span>{enrichExpanded ? '▼' : '▶'}</span>
                          <span>
                            Results: {enrichResult.hazardAnalysis.length} hazards,{' '}
                            {enrichResult.enrichedCasualties.length} casualties
                          </span>
                        </button>
                        {enrichExpanded && (
                          <div className="bg-gray-950 border border-purple-900 rounded p-2 space-y-2 max-h-60 overflow-y-auto">
                            <div className="text-xs text-purple-300 font-bold">Assessment</div>
                            <div className="text-xs text-green-400 whitespace-pre-wrap">
                              {typeof enrichResult.overallAssessment === 'string'
                                ? enrichResult.overallAssessment
                                : typeof enrichResult.overallAssessment === 'object' &&
                                    enrichResult.overallAssessment
                                  ? Object.entries(
                                      enrichResult.overallAssessment as Record<string, string>,
                                    ).map(([k, v]) => (
                                      <div key={k} className="mb-1">
                                        <span className="text-purple-400 font-semibold">{k}: </span>
                                        {String(v)}
                                      </div>
                                    ))
                                  : String(enrichResult.overallAssessment)}
                            </div>

                            {enrichResult.sceneSynthesis.keyChallenges.length > 0 && (
                              <>
                                <div className="text-xs text-purple-300 font-bold mt-1">
                                  Key Challenges
                                </div>
                                {enrichResult.sceneSynthesis.keyChallenges.map((ch, i) => (
                                  <div key={i} className="text-xs text-amber-400">
                                    • {ch}
                                  </div>
                                ))}
                              </>
                            )}

                            {enrichResult.sceneSynthesis.chainReactions.length > 0 && (
                              <>
                                <div className="text-xs text-purple-300 font-bold mt-1">
                                  Chain Reactions
                                </div>
                                {enrichResult.sceneSynthesis.chainReactions.map((cr, i) => (
                                  <div key={i} className="text-xs text-red-400">
                                    ⚠ {cr}
                                  </div>
                                ))}
                              </>
                            )}

                            {enrichResult.hazardAnalysis.length > 0 && (
                              <>
                                <div className="text-xs text-purple-300 font-bold mt-1">
                                  Hazard Analyses
                                </div>
                                {enrichResult.hazardAnalysis.map((ha) => (
                                  <div
                                    key={ha.hazardId}
                                    className="text-xs border-l-2 border-purple-800 pl-2 mb-1"
                                  >
                                    <div className="text-amber-300">
                                      {ha.identifiedMaterial} ({ha.riskLevel})
                                    </div>
                                    <div className="text-green-600">{ha.blastInteraction}</div>
                                    {ha.secondaryEffects.length > 0 && (
                                      <div className="text-red-500 text-[10px]">
                                        Effects: {ha.secondaryEffects.join(', ')}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </>
                            )}

                            {enrichResult.sceneSynthesis.escalationTimeline && (
                              <>
                                <div className="text-xs text-purple-300 font-bold mt-1">
                                  Escalation Timeline
                                </div>
                                <div className="text-xs text-green-500 whitespace-pre-wrap">
                                  {typeof enrichResult.sceneSynthesis.escalationTimeline ===
                                  'string'
                                    ? enrichResult.sceneSynthesis.escalationTimeline
                                    : JSON.stringify(
                                        enrichResult.sceneSynthesis.escalationTimeline,
                                        null,
                                        2,
                                      )}
                                </div>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <button
                  onClick={handleSaveSceneToDb}
                  disabled={savingScene || liveOnly}
                  className="w-full mt-2 bg-blue-800 hover:bg-blue-700 disabled:opacity-50 text-blue-100 text-xs px-3 py-1.5 rounded border border-blue-600"
                >
                  {liveOnly
                    ? 'Not saved — demo only'
                    : savingScene
                      ? 'Saving...'
                      : sceneConfigId
                        ? '💾 Update Scene in DB'
                        : '💾 Save Scene to DB'}
                </button>
                {liveOnly && liveNote && (
                  <div className="text-xs text-amber-300 mt-1">{liveNote}</div>
                )}
                {liveOnly && layoutLabels.length > 0 && (
                  <ul className="mt-2 max-h-48 overflow-auto space-y-1">
                    {layoutLabels.map((label) => (
                      <li key={label.id} className="text-xs text-slate-300">
                        <span
                          className={
                            label.origin === 'researched' ? 'text-emerald-400' : 'text-amber-500'
                          }
                        >
                          {label.origin === 'researched' ? 'Researched. ' : 'Assumed. '}
                        </span>
                        {label.text}
                        {label.sources.map((source) => (
                          <div key={`${source.url}-${source.quote}`} className="text-slate-500">
                            <a
                              href={source.url}
                              target="_blank"
                              rel="noreferrer"
                              className="underline text-emerald-600"
                            >
                              {source.title}
                            </a>
                            <div>{source.url}</div>
                            <div>{source.quote}</div>
                          </div>
                        ))}
                      </li>
                    ))}
                  </ul>
                )}
                {sceneConfigId && (
                  <div className="text-xs text-blue-500 mt-0.5">
                    Saved: {sceneConfigId.slice(0, 8)}...
                  </div>
                )}
              </div>
            )}

            {/* Unit info */}
            {rts.getSelectedUnits().length > 0 && (
              <div className="bg-gray-900 border border-green-800 rounded p-3">
                <div className="text-xs text-green-500 uppercase tracking-wider mb-2">
                  Selected ({rts.getSelectedUnits().length})
                </div>
                {rts
                  .getSelectedUnits()
                  .slice(0, 5)
                  .map((u) => (
                    <div
                      key={u.id}
                      className="text-xs text-green-400 flex items-center gap-1.5 mb-1"
                    >
                      <span
                        className="inline-block w-2.5 h-2.5 rounded-full"
                        style={{ backgroundColor: u.def.color }}
                      />
                      <span>{u.def.label}</span>
                      <span className="text-green-700">· {u.state}</span>
                    </div>
                  ))}
                {rts.getSelectedUnits().length > 5 && (
                  <div className="text-xs text-green-700">
                    +{rts.getSelectedUnits().length - 5} more
                  </div>
                )}
              </div>
            )}

            {/* Evacuation stats */}
            {gameState.clock.phase !== 'setup' && evacEngRef.current && (
              <div className="bg-gray-900 border border-green-800 rounded p-3">
                <div className="text-xs text-green-500 uppercase tracking-wider mb-2">
                  Evacuation
                </div>
                {(() => {
                  const m = evacEngRef.current?.getMetrics();
                  if (!m) return null;
                  return (
                    <div className="text-xs space-y-0.5">
                      <div className="text-green-400">
                        Remaining: <span className="text-amber-300">{m.remaining}</span>
                      </div>
                      <div className="text-green-400">
                        Evacuated: <span className="text-cyan-300">{m.evacuated}</span>
                      </div>
                      <div className="text-green-400">Total: {m.totalPedestrians}</div>
                      <div className="text-green-400">Avg Speed: {m.avgSpeed.toFixed(2)} m/s</div>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Event log */}
            <div className="bg-gray-900 border border-green-800 rounded p-3">
              <div className="text-xs text-green-500 uppercase tracking-wider mb-2">Event Log</div>
              <div className="space-y-0.5 max-h-32 overflow-y-auto">
                {gameState.heat.events.length === 0 && (
                  <div className="text-xs text-green-800 italic">No events yet</div>
                )}
                {gameState.heat.events
                  .slice(-10)
                  .reverse()
                  .map((evt, i) => (
                    <div key={i} className="text-xs">
                      <span className="text-green-700">{formatTime(evt.time)}</span>{' '}
                      <span className={evt.delta > 0 ? 'text-red-400' : 'text-green-400'}>
                        {evt.delta > 0 ? '+' : ''}
                        {evt.delta.toFixed(1)}
                      </span>{' '}
                      <span className="text-green-500">{evt.reason}</span>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `T+${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function StairEditor({
  stair,
  levels,
  onChange,
}: {
  stair: Stairwell;
  levels: LevelDef[];
  onChange: (next: Stairwell) => void;
}) {
  const from = stair.levels?.from ?? 'G';
  const to = stair.levels?.to ?? 'G';
  const setEnds = (nextFrom: string, nextTo: string) => {
    if (nextFrom === nextTo) return;
    if (!levels.some((l) => l.id === nextFrom) || !levels.some((l) => l.id === nextTo)) return;
    onChange({ ...stair, levels: { from: nextFrom, to: nextTo } });
  };
  return (
    <div className="border border-blue-900 rounded p-2 space-y-1 text-xs">
      <div className="text-blue-300">{stair.kind === 'lift' ? 'Lift' : 'Stair'}</div>
      <label className="block text-slate-400">
        Label
        <input
          value={stair.label}
          onChange={(e) => onChange({ ...stair, label: e.target.value })}
          className="w-full bg-gray-800 border border-slate-700 text-slate-200 px-1 py-0.5 rounded"
        />
      </label>
      <label className="block text-slate-400">
        From
        <select
          value={from}
          onChange={(e) => setEnds(e.target.value, to)}
          className="w-full bg-gray-800 border border-slate-700 text-slate-200 px-1 py-0.5 rounded"
        >
          {levels.map((l) => (
            <option key={l.id} value={l.id}>
              {l.id}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-slate-400">
        To
        <select
          value={to}
          onChange={(e) => setEnds(from, e.target.value)}
          className="w-full bg-gray-800 border border-slate-700 text-slate-200 px-1 py-0.5 rounded"
        >
          {levels.map((l) => (
            <option key={l.id} value={l.id}>
              {l.id}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-slate-400">
        Width (m)
        <input
          type="number"
          min={0.8}
          max={4}
          step={0.1}
          value={stair.widthM ?? LEVEL.DEFAULT_STAIR_WIDTH_M}
          onChange={(e) => {
            const raw = e.target.value;
            const n = Number(raw);
            const width =
              raw === '' || !Number.isFinite(n)
                ? LEVEL.DEFAULT_STAIR_WIDTH_M
                : Math.min(4, Math.max(0.8, n));
            onChange({ ...stair, widthM: width });
          }}
          className="w-full bg-gray-800 border border-slate-700 text-slate-200 px-1 py-0.5 rounded"
        />
      </label>
      <label
        className="flex items-center gap-2 text-slate-300"
        title="Landing doors shut: nobody walks it and no smoke or heat passes between storeys"
      >
        <input
          type="checkbox"
          checked={stair.blocked}
          onChange={(e) => onChange({ ...stair, blocked: e.target.checked })}
        />
        Blocked (doors shut)
      </label>
    </div>
  );
}

function PaneLevelChip({
  level,
  levels,
  summary,
  primary,
  onLevel,
}: {
  level: string;
  levels: LevelDef[];
  summary: { remaining: number; burning: number; meanSmoke: number };
  primary: boolean;
  onLevel: (id: string) => void;
}) {
  const ordered = [...levels].sort((a, b) => b.index - a.index);
  return (
    <div
      className="absolute top-2 right-2 bg-black/85 border border-slate-600 rounded px-1.5 py-1 text-xs text-slate-200 flex items-center gap-2 pointer-events-auto"
      style={{ zIndex: 1050 }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <select
        value={level}
        onChange={(e) => onLevel(e.target.value)}
        title={primary ? 'Level of the main pane (where you edit)' : 'Level shown in this pane'}
        className="bg-gray-900 border border-slate-600 text-slate-100 text-xs rounded px-1 py-0.5"
      >
        {ordered.map((lv) => (
          <option key={lv.id} value={lv.id}>
            {lv.name}
          </option>
        ))}
      </select>
      <span className="text-slate-400 whitespace-nowrap">
        {summary.remaining} in · {summary.burning} burn · smoke {summary.meanSmoke.toFixed(2)}
      </span>
      {primary && <span className="text-cyan-400 whitespace-nowrap">● main</span>}
    </div>
  );
}

/**
 * A view-only map pane for one level. The page's render loop draws into its
 * canvas; any drag pans and the wheel zooms, on the main map when linked.
 */
function LevelPane({
  index,
  rect,
  level,
  levels,
  summary,
  initialView,
  onLevel,
  register,
  onPan,
  onZoom,
}: {
  index: number;
  rect: PaneRect;
  level: string;
  levels: LevelDef[];
  summary: { remaining: number; burning: number; meanSmoke: number };
  initialView: { center: L.LatLng; zoom: number } | null;
  onLevel: (index: number, id: string) => void;
  register: (index: number, patch: Partial<PaneHandle> | null) => void;
  onPan: (map: L.Map, dx: number, dy: number) => void;
  onZoom: (map: L.Map, point: L.Point, delta: number) => void;
}) {
  const mapRef = useRef<L.Map | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const [initial] = useState(initialView);
  const [mapReady, setMapReady] = useState(false);
  const setMap = useCallback((map: L.Map) => {
    mapRef.current = map;
    setMapReady(true);
  }, []);
  useEffect(() => () => register(index, null), [index, register]);
  useEffect(() => {
    register(index, { map: mapRef.current, canvas: canvasRef.current, level });
  }, [index, level, mapReady, register]);
  useEffect(() => {
    mapRef.current?.invalidateSize({ pan: true });
  }, [rect.w, rect.h]);
  return (
    <div
      className={`absolute overflow-hidden border-green-800 ${rect.x > 0 ? 'border-l' : ''} ${rect.y > 0 ? 'border-t' : ''}`}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    >
      <MapContainer
        center={initial?.center ?? [1.3, 103.8]}
        zoom={initial?.zoom ?? 18}
        maxZoom={MAX_MAP_ZOOM}
        style={{ height: '100%', width: '100%' }}
        zoomControl={false}
        attributionControl={false}
        dragging={false}
        scrollWheelZoom={false}
        doubleClickZoom={false}
        boxZoom={false}
        keyboard={false}
        touchZoom={false}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxNativeZoom={19}
          maxZoom={MAX_MAP_ZOOM}
        />
        <MapRefSync onMap={setMap} />
      </MapContainer>
      <canvas
        ref={canvasRef}
        width={Math.max(1, rect.w)}
        height={Math.max(1, rect.h)}
        className="cursor-grab active:cursor-grabbing"
        style={{ position: 'absolute', inset: 0, zIndex: 1000, touchAction: 'none' }}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
        }}
        onPointerMove={(e) => {
          const drag = dragRef.current;
          const map = mapRef.current;
          if (!drag || drag.id !== e.pointerId || !map) return;
          onPan(map, drag.x - e.clientX, drag.y - e.clientY);
          drag.x = e.clientX;
          drag.y = e.clientY;
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        onWheel={(e) => {
          const map = mapRef.current;
          if (!map || e.deltaY === 0) return;
          const box = e.currentTarget.getBoundingClientRect();
          onZoom(map, L.point(e.clientX - box.left, e.clientY - box.top), e.deltaY < 0 ? 1 : -1);
        }}
      />
      <PaneLevelChip
        level={level}
        levels={levels}
        summary={summary}
        primary={false}
        onLevel={(id) => onLevel(index, id)}
      />
    </div>
  );
}

function PanelCollapseButton({
  side,
  portrait,
  onClick,
}: {
  side: 'left' | 'right';
  portrait: boolean;
  onClick: () => void;
}) {
  return (
    <div className={`flex ${side === 'left' ? 'justify-end' : 'justify-start'} -mb-1`}>
      <button
        type="button"
        onClick={onClick}
        title="Collapse panel"
        className="text-xs text-green-700 hover:text-green-400 border border-green-900 hover:border-green-700 rounded px-1.5 leading-tight"
      >
        {portrait ? '▾' : side === 'left' ? '«' : '»'}
      </button>
    </div>
  );
}

function PanelEdgeTab({
  side,
  label,
  portrait,
  orderClass,
  onOpen,
}: {
  side: 'left' | 'right';
  label: string;
  portrait: boolean;
  orderClass: string;
  onOpen: () => void;
}) {
  const edge = portrait
    ? 'w-full h-6 border-t'
    : `w-6 ${side === 'left' ? 'border-r' : 'border-l'}`;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Show ${label.toLowerCase()} panel`}
      className={`${orderClass} ${edge} flex-shrink-0 border-green-800 bg-black text-green-600 hover:text-green-400 hover:bg-green-950/40 text-[10px] uppercase tracking-widest flex items-center justify-center`}
    >
      <span style={portrait ? undefined : { writingMode: 'vertical-rl' }}>
        {portrait ? '▴' : side === 'left' ? '»' : '«'} {label}
      </span>
    </button>
  );
}

function LevelSwitcher({
  levels,
  activeLevel,
  interiorWalls,
  exits,
  hazardZones,
  casualtyPins,
  stairwells,
  pedestrians,
  studs,
  effectStates,
  copyTargets,
  onActive,
  onLevels,
  onCopyTargets,
  onCopy,
  pedestrianCount,
  onClose,
  place,
}: {
  levels: LevelDef[];
  activeLevel: string;
  interiorWalls: InteriorWall[];
  exits: ExitDef[];
  hazardZones: HazardZone[];
  casualtyPins: CasualtyPin[];
  stairwells: Stairwell[];
  pedestrians: PedSnapshot[];
  studs: Array<{ id: string; floor: string }>;
  effectStates: Map<string, StudEffectState> | null;
  copyTargets: string[];
  onActive: (id: string) => void;
  onLevels: (next: LevelDef[] | ((prev: LevelDef[]) => LevelDef[])) => void;
  onCopyTargets: (ids: string[]) => void;
  onCopy: (from: string, targets: string[]) => void;
  pedestrianCount: number;
  onClose: () => void;
  /** Where the box sits in the map area. Defaults to the top-left corner. */
  place?: { top: number; maxHeight: number } | null;
}) {
  const ordered = [...levels].sort((a, b) => b.index - a.index);
  const active = levels.find((l) => l.id === activeLevel) ?? levels[0];
  const addStorey = (dir: 'up' | 'down') => {
    onLevels((prev) => {
      if (prev.length >= LEVEL.MAX_LEVELS) return prev;
      const nums = prev
        .filter((l) => l.id.startsWith(dir === 'up' ? 'L' : 'B'))
        .map((l) => Number(l.id.slice(1)));
      const id = `${dir === 'up' ? 'L' : 'B'}${nums.length ? Math.max(...nums) + 1 : 1}`;
      const seeded = prev.map((l) =>
        l.id === 'G' && l.pedestrianCount === 0 ? { ...l, pedestrianCount } : l,
      );
      return [...seeded, makeLevel(id)].sort((a, b) => a.index - b.index);
    });
  };
  const removable = (lv: LevelDef) => {
    if (lv.id === 'G' || lv.designed) return false;
    if (lv.pedestrianCount > 0) return false;
    if (interiorWalls.some((w) => levelOf(w) === lv.id)) return false;
    if (exits.some((e) => levelOf(e) === lv.id)) return false;
    if (hazardZones.some((h) => levelOf(h) === lv.id)) return false;
    if (casualtyPins.some((c) => levelOf(c) === lv.id)) return false;
    if (stairwells.some((sw) => linkLevels(sw, levels).includes(lv.id))) return false;
    return true;
  };
  return (
    <div
      className="absolute top-2 left-2 bg-black/85 border border-slate-600 rounded p-1.5 text-xs text-slate-200 space-y-1 overflow-auto"
      style={{
        zIndex: 1100,
        pointerEvents: 'auto',
        maxHeight: place ? place.maxHeight : '75%',
        ...(place ? { top: place.top } : {}),
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-2 text-slate-400">
        <span className="uppercase tracking-wider text-[10px]">Levels</span>
        <button
          type="button"
          onClick={onClose}
          title="Hide the levels box"
          className="text-slate-400 hover:text-white px-1 leading-none"
        >
          ✕
        </button>
      </div>
      {ordered.map((lv) => {
        const plan = effectiveLevelPlan(lv.id, levels, { walls: interiorWalls, exits });
        const title = lv.designed
          ? lv.name
          : plan.assumedFrom
            ? `Assumed: copy of ${plan.assumedFrom}`
            : 'Undesigned';
        const {
          remaining,
          burning,
          meanSmoke: mean,
        } = levelSummary(lv.id, studs, effectStates, pedestrians);
        return (
          <button
            key={lv.id}
            type="button"
            onClick={() => onActive(lv.id)}
            className={`block w-full text-left px-1.5 py-1 rounded border ${
              lv.id === activeLevel ? 'border-amber-400 text-amber-200' : 'border-slate-700'
            }`}
          >
            <span className="flex items-center gap-1">
              {burning > 0 && <span className="inline-block w-2 h-2 rounded-full bg-red-500" />}
              {title}
            </span>
            <span className="block text-[10px] text-slate-400">
              {remaining} in · {burning} burn · smoke {mean.toFixed(2)}
            </span>
          </button>
        );
      })}
      <button
        type="button"
        className="w-full text-left px-1 py-0.5 border border-slate-700 rounded"
        onClick={() => addStorey('up')}
      >
        + Level above
      </button>
      <button
        type="button"
        className="w-full text-left px-1 py-0.5 border border-slate-700 rounded"
        onClick={() => addStorey('down')}
      >
        + Basement
      </button>
      <button
        type="button"
        className="w-full text-left px-1 py-0.5 border border-slate-700 rounded disabled:opacity-40"
        disabled={!active || !removable(active)}
        onClick={() => {
          if (!active || !removable(active)) return;
          onLevels((prev) => prev.filter((l) => l.id !== active.id));
          onActive('G');
        }}
      >
        Remove level
      </button>
      {active && (
        <div className="space-y-1 border-t border-slate-700 pt-1">
          <label className="block text-slate-400">
            Name
            <input
              value={active.name}
              onChange={(e) =>
                onLevels((prev) =>
                  prev.map((l) => (l.id === active.id ? { ...l, name: e.target.value } : l)),
                )
              }
              className="w-full bg-gray-800 border border-slate-700 px-1 py-0.5 rounded"
            />
          </label>
          <label className="block text-slate-400">
            Height (m)
            <input
              type="number"
              min={2}
              step={0.1}
              value={active.heightM}
              onChange={(e) =>
                onLevels((prev) =>
                  prev.map((l) =>
                    l.id === active.id ? { ...l, heightM: Number(e.target.value) || l.heightM } : l,
                  ),
                )
              }
              className="w-full bg-gray-800 border border-slate-700 px-1 py-0.5 rounded"
            />
          </label>
          <label className="block text-slate-400">
            People
            <input
              type="number"
              min={0}
              step={1}
              value={active.pedestrianCount}
              onChange={(e) =>
                onLevels((prev) =>
                  prev.map((l) =>
                    l.id === active.id
                      ? { ...l, pedestrianCount: Math.max(0, Number(e.target.value) || 0) }
                      : l,
                  ),
                )
              }
              className="w-full bg-gray-800 border border-slate-700 px-1 py-0.5 rounded"
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={active.designed}
              onChange={(e) =>
                onLevels((prev) =>
                  prev.map((l) => (l.id === active.id ? { ...l, designed: e.target.checked } : l)),
                )
              }
            />
            Designed
          </label>
          <div className="text-slate-400">Copy this level to…</div>
          {levels
            .filter((l) => l.id !== active.id)
            .map((l) => (
              <label key={l.id} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={copyTargets.includes(l.id)}
                  onChange={(e) =>
                    onCopyTargets(
                      e.target.checked
                        ? [...copyTargets, l.id]
                        : copyTargets.filter((id) => id !== l.id),
                    )
                  }
                />
                {l.id}
              </label>
            ))}
          <button
            type="button"
            className="w-full text-left px-1 py-0.5 border border-slate-700 rounded"
            onClick={() => onCopy(active.id, copyTargets)}
          >
            Copy
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Stair flights with anyone on them or waiting: the door queue on the floor,
 * the stream already on the stair waiting at the landing, and the people
 * walking the flight, with the release rate the flight has right now.
 */
function StairFlightPanel({
  flights,
  stairs,
  stairId,
  onStairId,
  onSendUp,
}: {
  flights: StairFlightView[];
  stairs: Stairwell[];
  stairId: string;
  onStairId: (id: string) => void;
  onSendUp: (id: string) => void;
}) {
  const picked = stairs.find((sw) => sw.id === stairId) ?? stairs[0];
  const labelOf = (id: string) => stairs.find((sw) => sw.id === id)?.label || id;
  return (
    <div className="bg-gray-900 border border-sky-800 rounded p-3 text-xs space-y-1 text-sky-200">
      <div className="font-semibold">Stair flights</div>
      {flights.length === 0 ? (
        <div className="text-gray-400">Nobody on or waiting for a stair</div>
      ) : (
        flights.map((f) => (
          <div key={`${f.stairId}:${f.dir}:${f.fromLevel}`} className="font-mono">
            {labelOf(f.stairId)} {f.fromLevel}
            {f.dir === 'down' ? '↓' : '↑'}
            {f.toLevel}: door {f.door} · landing {f.landing} · moving {f.moving}/{f.storage} ·{' '}
            {f.flowPerS.toFixed(2)} p/s
            {f.responders > 0 && <span className="text-red-300"> · crew {f.responders}</span>}
            {f.counterflow && <span className="text-amber-300"> · counterflow</span>}
            {f.full && <span className="text-red-400"> · full</span>}
          </div>
        ))
      )}
      {picked && (
        <div className="flex items-center gap-2 pt-1">
          <select
            className="bg-gray-800 border border-gray-700 rounded px-1 py-0.5"
            value={picked.id}
            onChange={(e) => onStairId(e.target.value)}
          >
            {stairs.map((sw) => (
              <option key={sw.id} value={sw.id}>
                {sw.label || sw.id}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="px-2 py-0.5 rounded bg-red-900 hover:bg-red-800 text-red-100"
            title="Four responders in breathing apparatus climb from the lowest storey to the top, against the crowd"
            onClick={() => onSendUp(picked.id)}
          >
            Send 4 crew up
          </button>
        </div>
      )}
    </div>
  );
}
