import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
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
import type { PedSnapshot } from '../lib/evacuation/engine';
import type { ExitDef, PolygonSimConfig, Vec2 } from '../lib/evacuation/types';
import { DEFAULT_POLYGON_CONFIG } from '../lib/evacuation/types';
import { projectPolygon, nearestEdge, edgeLength } from '../lib/evacuation/geometry';
import { RTSEngine } from '../lib/rts/engine';
import { renderRTS, computeMapRenderContext, toSim as rcToSim } from '../lib/rts/renderer';
import type { RenderContext } from '../lib/rts/renderer';
import {
  UNIT_CATALOG,
  EQUIPMENT_CATALOG,
  type UnitKind,
  type EquipmentKind,
  type TeamId,
  type PlantedItem,
  type CasualtyCluster,
  type CasualtyVictim,
  type TriageTag,
  type InteriorWall,
  type HazardZone,
  type HazardType,
  type Stairwell,
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
import { generateBlastCasualties } from '../lib/rts/casualtyPresets';
import 'leaflet/dist/leaflet.css';

const GOOGLE_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

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

// ── OSM types ───────────────────────────────────────────────────────────
interface GridItem {
  buildingIndex: number;
  buildingName: string | null;
  polygon: [number, number][];
  floors: string[];
  spacingM: number;
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
    map.fitBounds(leafletBounds, { padding: [120, 120], maxZoom: 22 });
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
export function DebugRTSSim() {
  // ── Map state ─────────────────────────────────────────────────────────
  const [lat, setLat] = useState('1.2989008');
  const [lng, setLng] = useState('103.855176');
  const [radius, setRadius] = useState('300');
  const [loading, setLoading] = useState(false);
  const [fetchResult, setFetchResult] = useState<FetchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedGridIdx, setSelectedGridIdx] = useState<number | null>(null);
  const [phase, setPhase] = useState<PagePhase>('map');

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

  // ── Saved maps ────────────────────────────────────────────────────────
  const [savedMaps, setSavedMaps] = useState<SavedMap[]>(() => loadSavedMaps());
  const [saveMapName, setSaveMapName] = useState('');

  // ── Place search (Nominatim) ──────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<
    Array<{ lat: string; lon: string; display_name: string }>
  >([]);
  const [searchOpen, setSearchOpen] = useState(false);
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

  // ── Casualty clusters ─────────────────────────────────────────────────
  const [casualtyClusters, setCasualtyClusters] = useState<CasualtyCluster[]>([]);
  const [activeCasualtyCluster, setActiveCasualtyCluster] = useState<CasualtyCluster | null>(null);
  const [triageLoading, setTriageLoading] = useState(false);
  const [triageResult, setTriageResult] = useState<string | null>(null);

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
      const newGrid: GridItem = {
        buildingIndex: fetchResult ? fetchResult.grids.length : 0,
        buildingName: drawnBuildingName || 'Custom Building',
        polygon,
        floors: ['Ground'],
        spacingM: 3,
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

  // ── Trainer GPS tracking ──────────────────────────────────────────────
  const [gpsEnabled, setGpsEnabled] = useState(false);
  const [gpsSimPos, setGpsSimPos] = useState<Vec2 | null>(null);
  const [gpsAccuracy, setGpsAccuracy] = useState(0);
  const gpsWatchIdRef = useRef<number | null>(null);

  // ── Interior elements ─────────────────────────────────────────────────
  const [interiorWalls, setInteriorWalls] = useState<InteriorWall[]>([]);
  const [hazardZones, setHazardZones] = useState<HazardZone[]>([]);
  const [stairwells, setStairwells] = useState<Stairwell[]>([]);
  // wallDrawStart state removed — now tracked in InteractionMode

  // ── Projected polygon ─────────────────────────────────────────────────
  const selectedGrid = selectedGridIdx != null ? fetchResult?.grids[selectedGridIdx] : null;

  const projectedVerts = useMemo<Vec2[]>(() => {
    if (!selectedGrid) return [];
    return projectPolygon(selectedGrid.polygon);
  }, [selectedGrid]);

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
    });
    obs.observe(containerRef.current);
    const rect = containerRef.current.getBoundingClientRect();
    setCanvasSize({ w: Math.round(rect.width), h: Math.round(rect.height) });
    return () => obs.disconnect();
  }, [phase]);

  // ── Map phase handlers ────────────────────────────────────────────────
  const handleFetch = useCallback(async () => {
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
  const handleSearchInput = useCallback((query: string) => {
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
          limit: '6',
          addressdetails: '0',
        });
        const resp = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
          headers: { 'User-Agent': 'BlackSwanSimulations/1.0' },
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
  }, []);

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
  }, [fetchResult, saveMapName, lat, lng, radius]);

  const handleLoadSavedMap = useCallback((m: SavedMap) => {
    setLat(m.lat);
    setLng(m.lng);
    setRadius(m.radius);
    setFetchResult({ grids: m.grids, buildings: m.buildings });
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
      if (grid && grid.polygon.length >= 3) {
        const verts = projectPolygon(grid.polygon);
        rtsRef.current.setBuildingVertices(verts);
        const pts = generateWallPoints(grid.polygon, verts);
        setWallPoints(pts);
      } else {
        setWallPoints([]);
      }
    },
    [fetchResult],
  );

  const backToMap = useCallback(() => {
    setPhase('map');
    cancelAnimationFrame(rafRef.current);
    evacEngRef.current?.destroy();
    evacEngRef.current = null;
    rtsRef.current = new RTSEngine();
    setPedestrians([]);
    setWallPoints([]);
    setActiveWallPoint(null);
    setWallPointImage(null);
  }, []);

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
      dt: DEFAULT_POLYGON_CONFIG.dt,
    };
    // Convert interior walls to engine format
    const iwDefs = interiorWalls.map((w) => ({
      startX: w.start.x,
      startY: w.start.y,
      endX: w.end.x,
      endY: w.end.y,
      hasDoor: w.hasDoor,
      doorWidth: w.doorWidth,
      doorPosition: w.doorPosition,
    }));

    // Collect obstacle points (hazards + casualty clusters)
    const obstacles = [
      ...hazardZones.map((hz) => ({ x: hz.pos.x, y: hz.pos.y, radius: hz.radius })),
      ...casualtyClusters.map((c) => ({ x: c.pos.x, y: c.pos.y, radius: 3 })),
    ];

    evacEngRef.current = new PolygonEvacuationEngine(config, exits, iwDefs, obstacles);
    rtsRef.current.setBuildingVertices(projectedVerts);
    rtsRef.current.setExits(exits);
    setPedestrians(evacEngRef.current.getSnapshots());
  }, [projectedVerts, exits, pedestrianCount, interiorWalls, hazardZones, casualtyClusters]);

  // Keep engine exits in sync when exits change (for pathfinding)
  useEffect(() => {
    rtsRef.current.setExits(exits);
  }, [exits]);

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

  // ── Refs for animation loop (avoid stale closures & constant recreation) ──
  const exitsRef = useRef(exits);
  exitsRef.current = exits;
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
  const casualtyClustersRef = useRef(casualtyClusters);
  casualtyClustersRef.current = casualtyClusters;
  const activeCasualtyRef = useRef(activeCasualtyCluster);
  activeCasualtyRef.current = activeCasualtyCluster;
  const interiorWallsRef = useRef(interiorWalls);
  interiorWallsRef.current = interiorWalls;
  const hazardZonesRef = useRef(hazardZones);
  hazardZonesRef.current = hazardZones;
  const stairwellsRef = useRef(stairwells);
  stairwellsRef.current = stairwells;
  const blastSiteRef = useRef(blastSite);
  blastSiteRef.current = blastSite;
  const hoverSimPosRef = useRef<Vec2 | null>(null);
  const gpsSimPosRef = useRef(gpsSimPos);
  gpsSimPosRef.current = gpsSimPos;
  const gpsAccuracyRef = useRef(gpsAccuracy);
  gpsAccuracyRef.current = gpsAccuracy;

  // ── Main animation loop ───────────────────────────────────────────────
  const loop = useCallback(
    (time: number) => {
      const dt = lastTimeRef.current ? (time - lastTimeRef.current) / 1000 : 0;
      lastTimeRef.current = time;

      const rts = rtsRef.current;
      rts.tick(dt);

      const evac = evacEngRef.current;
      if (evac && !rts.state.clock.paused && rts.state.clock.phase !== 'setup') {
        const stepsPerFrame = Math.max(1, Math.round(rts.state.clock.speed));
        for (let i = 0; i < stepsPerFrame; i++) evac.step();
        const snaps = evac.getSnapshots();
        pedestriansRef.current = snaps;
        setPedestrians(snaps);
      }

      updateRenderCtx();

      const canvas = canvasRef.current;
      const rc = renderCtxRef.current;
      if (canvas && rc) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const planted = new Set(plantedItemsRef.current.map((p) => p.wallPointId));
          const discovered = new Set(
            plantedItemsRef.current.filter((p) => p.discovered).map((p) => p.wallPointId),
          );
          renderRTS(
            ctx,
            canvas.width,
            canvas.height,
            rc,
            rts.state,
            projectedVertsRef.current,
            exitsRef.current,
            pedestriansRef.current,
            true,
            wallPointsRef.current,
            activeWallPointRef.current?.id ?? null,
            planted,
            discovered,
            casualtyClustersRef.current,
            activeCasualtyRef.current?.id ?? null,
            interiorWallsRef.current,
            hazardZonesRef.current,
            stairwellsRef.current,
            blastSiteRef.current,
            (() => {
              const mode = rtsRef.current.state.interactionMode;
              if (mode.type === 'draw_wall' && mode.startPoint && hoverSimPosRef.current) {
                return { start: mode.startPoint, cursor: hoverSimPosRef.current };
              }
              return null;
            })(),
            gpsSimPosRef.current
              ? { pos: gpsSimPosRef.current, accuracy: gpsAccuracyRef.current }
              : null,
          );
        }
      }

      rerender();
      rafRef.current = requestAnimationFrame(loop);
    },
    [rerender, updateRenderCtx],
  );

  useEffect(() => {
    if (phase !== 'rts') return;
    lastTimeRef.current = 0;
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase, loop]);

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

  // ── Casualty cluster handlers ─────────────────────────────────────────
  const handlePlaceCasualtyCluster = useCallback(
    (pos: Vec2, victims: CasualtyVictim[], sceneDescription: string) => {
      const cluster: CasualtyCluster = {
        id: `cas-${Date.now()}`,
        pos: { ...pos },
        victims,
        sceneDescription,
        imageUrl: null,
        imageGenerating: false,
        discovered: true,
        triageComplete: false,
        aiEvaluation: null,
      };
      setCasualtyClusters((prev) => [...prev, cluster]);
      return cluster;
    },
    [],
  );

  const handleCasualtyClusterClick = useCallback((cluster: CasualtyCluster) => {
    setActiveCasualtyCluster(cluster);
    setTriageResult(null);
  }, []);

  const closeCasualtyCard = useCallback(() => {
    setActiveCasualtyCluster(null);
    setTriageResult(null);
  }, []);

  const handleGenerateCasualtyImage = useCallback(
    async (clusterId: string) => {
      const cluster = casualtyClusters.find((c) => c.id === clusterId);
      if (!cluster) return;

      setCasualtyClusters((prev) =>
        prev.map((c) => (c.id === clusterId ? { ...c, imageGenerating: true } : c)),
      );

      try {
        const headers = await getAuthHeaders();
        const resp = await fetch(apiUrl('/api/debug/rts-casualty-image'), {
          method: 'POST',
          headers,
          body: JSON.stringify({
            victims: cluster.victims.map((v) => ({
              label: v.label,
              trueTag: v.trueTag,
              description: v.description,
              observableSigns: v.observableSigns,
            })),
            sceneContext: cluster.sceneDescription,
          }),
        });

        if (resp.ok) {
          const { data } = await resp.json();
          setCasualtyClusters((prev) =>
            prev.map((c) =>
              c.id === clusterId ? { ...c, imageUrl: data.imageUrl, imageGenerating: false } : c,
            ),
          );
          if (activeCasualtyCluster?.id === clusterId) {
            setActiveCasualtyCluster((prev) =>
              prev ? { ...prev, imageUrl: data.imageUrl, imageGenerating: false } : prev,
            );
          }
        } else {
          setCasualtyClusters((prev) =>
            prev.map((c) => (c.id === clusterId ? { ...c, imageGenerating: false } : c)),
          );
        }
      } catch {
        setCasualtyClusters((prev) =>
          prev.map((c) => (c.id === clusterId ? { ...c, imageGenerating: false } : c)),
        );
      }
    },
    [casualtyClusters, activeCasualtyCluster],
  );

  const handleGenerateVictimImages = useCallback(
    async (clusterId: string) => {
      const cluster = casualtyClusters.find((c) => c.id === clusterId);
      if (!cluster) return;

      for (const victim of cluster.victims) {
        if (victim.imageUrl) continue;

        // Mark generating
        const updateVictim = (url: string | null, generating: boolean) => {
          setCasualtyClusters((prev) =>
            prev.map((c) =>
              c.id === clusterId
                ? {
                    ...c,
                    victims: c.victims.map((v) =>
                      v.id === victim.id ? { ...v, imageUrl: url, imageGenerating: generating } : v,
                    ),
                  }
                : c,
            ),
          );
          if (activeCasualtyCluster?.id === clusterId) {
            setActiveCasualtyCluster((prev) =>
              prev
                ? {
                    ...prev,
                    victims: prev.victims.map((v) =>
                      v.id === victim.id ? { ...v, imageUrl: url, imageGenerating: generating } : v,
                    ),
                  }
                : prev,
            );
          }
        };

        updateVictim(null, true);

        try {
          const headers = await getAuthHeaders();
          const resp = await fetch(apiUrl('/api/debug/rts-victim-image'), {
            method: 'POST',
            headers,
            body: JSON.stringify({
              victim: {
                label: victim.label,
                trueTag: victim.trueTag,
                description: victim.description,
                observableSigns: victim.observableSigns,
              },
              sceneContext: cluster.sceneDescription,
            }),
          });

          if (resp.ok) {
            const { data } = await resp.json();
            updateVictim(data.imageUrl, false);
          } else {
            updateVictim(null, false);
          }
        } catch {
          updateVictim(null, false);
        }
      }
    },
    [casualtyClusters, activeCasualtyCluster],
  );

  const handleUpdateVictimTag = useCallback(
    (clusterId: string, victimId: string, tag: TriageTag) => {
      setCasualtyClusters((prev) =>
        prev.map((c) =>
          c.id === clusterId
            ? {
                ...c,
                victims: c.victims.map((v) =>
                  v.id === victimId ? { ...v, playerTag: tag, taggedAt: Date.now() } : v,
                ),
              }
            : c,
        ),
      );
      if (activeCasualtyCluster?.id === clusterId) {
        setActiveCasualtyCluster((prev) =>
          prev
            ? {
                ...prev,
                victims: prev.victims.map((v) =>
                  v.id === victimId ? { ...v, playerTag: tag, taggedAt: Date.now() } : v,
                ),
              }
            : prev,
        );
      }
    },
    [activeCasualtyCluster],
  );

  const handleSubmitTriage = useCallback(async () => {
    if (!activeCasualtyCluster) return;
    const untagged = activeCasualtyCluster.victims.filter((v) => v.playerTag === 'untagged');
    if (untagged.length > 0) return;

    setTriageLoading(true);
    setTriageResult(null);

    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(apiUrl('/api/debug/rts-triage-assess'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          imageUrl: activeCasualtyCluster.imageUrl || '',
          victims: activeCasualtyCluster.victims.map((v) => ({
            label: v.label,
            trueTag: v.trueTag,
            description: v.description,
            playerTag: v.playerTag,
          })),
          sceneContext: activeCasualtyCluster.sceneDescription,
        }),
      });

      if (resp.ok) {
        const { data } = await resp.json();
        const evalText = `Score: ${data.overallScore}/${data.maxScore}\n${data.evaluation}\n\n${data.perVictim
          .map(
            (pv: { label: string; correct: boolean; feedback: string }) =>
              `${pv.label}: ${pv.correct ? '✓' : '✗'} ${pv.feedback}`,
          )
          .join(
            '\n',
          )}${data.criticalErrors.length > 0 ? `\n\nCRITICAL: ${data.criticalErrors.join(', ')}` : ''}`;

        setTriageResult(evalText);
        setCasualtyClusters((prev) =>
          prev.map((c) =>
            c.id === activeCasualtyCluster.id
              ? { ...c, triageComplete: true, aiEvaluation: evalText }
              : c,
          ),
        );
        setActiveCasualtyCluster((prev) =>
          prev ? { ...prev, triageComplete: true, aiEvaluation: evalText } : prev,
        );
      } else {
        setTriageResult('Triage evaluation failed. Try again.');
      }
    } catch {
      setTriageResult('Connection error. Try again.');
    }
    setTriageLoading(false);
  }, [activeCasualtyCluster]);

  // ── Canvas mouse handlers ─────────────────────────────────────────────
  const dragStartRef = useRef<Vec2 | null>(null);
  const isDraggingRef = useRef(false);
  const elementDragRef = useRef<{ type: string; id: string } | null>(null);

  // Hit-test draggable elements in setup mode
  const findDraggableAt = useCallback(
    (sim: Vec2): { type: string; id: string } | null => {
      const state = rtsRef.current.state;
      if (state.clock.phase !== 'setup' || !isTrainerMode) return null;
      if (blastSite && Math.hypot(sim.x - blastSite.x, sim.y - blastSite.y) < 4)
        return { type: 'blastSite', id: 'blast' };
      if (
        state.stagingArea &&
        Math.hypot(sim.x - state.stagingArea.x, sim.y - state.stagingArea.y) < 5
      )
        return { type: 'stagingArea', id: 'staging' };
      for (const c of casualtyClusters) {
        if (Math.hypot(c.pos.x - sim.x, c.pos.y - sim.y) < 5) return { type: 'casualty', id: c.id };
      }
      for (const hz of hazardZones) {
        if (Math.hypot(hz.pos.x - sim.x, hz.pos.y - sim.y) < hz.radius)
          return { type: 'hazard', id: hz.id };
      }
      for (const sw of stairwells) {
        if (Math.hypot(sw.pos.x - sim.x, sw.pos.y - sim.y) < 5)
          return { type: 'stairwell', id: sw.id };
      }
      return null;
    },
    [isTrainerMode, blastSite, casualtyClusters, hazardZones, stairwells],
  );

  const applyElementDrag = useCallback((drag: { type: string; id: string }, sim: Vec2) => {
    if (drag.type === 'blastSite') setBlastSite(sim);
    else if (drag.type === 'stagingArea') rtsRef.current.setStagingArea(sim);
    else if (drag.type === 'casualty')
      setCasualtyClusters((prev) =>
        prev.map((c) => (c.id === drag.id ? { ...c, pos: { ...sim } } : c)),
      );
    else if (drag.type === 'hazard')
      setHazardZones((prev) => prev.map((h) => (h.id === drag.id ? { ...h, pos: { ...sim } } : h)));
    else if (drag.type === 'stairwell')
      setStairwells((prev) => prev.map((s) => (s.id === drag.id ? { ...s, pos: { ...sim } } : s)));
  }, []);

  const handleCanvasMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!renderCtxRef.current) return;
      const rect = canvasRef.current!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const sim = toSim(cx, cy);

      const rts = rtsRef.current;
      const mode = rts.state.interactionMode;

      if (mode.type === 'select') {
        if (e.button === 2) {
          e.preventDefault();
          const selected = [...rts.state.selection.selectedUnitIds];
          if (selected.length > 0) {
            rts.issueMove(selected, sim, e.shiftKey);
          }
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
        isDraggingRef.current = true;
        rts.state.selection.selectionBox = { start: dragStartRef.current, end: sim };
      }
    },
    [toSim, applyElementDrag],
  );

  const handleCanvasMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!renderCtxRef.current) return;
      const rect = canvasRef.current!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const sim = toSim(cx, cy);
      const rts = rtsRef.current;
      const mode = rts.state.interactionMode;

      // Finalize element drag
      if (elementDragRef.current) {
        if (isDraggingRef.current) {
          applyElementDrag(elementDragRef.current, sim);
        }
        elementDragRef.current = null;
        dragStartRef.current = null;
        isDraggingRef.current = false;
        return;
      }

      if (mode.type === 'select') {
        if (isDraggingRef.current && dragStartRef.current) {
          rts.selectUnitsInBox(dragStartRef.current, sim);
        } else {
          // Check casualty clusters
          const hitCas = casualtyClusters.find(
            (c) => Math.hypot(c.pos.x - sim.x, c.pos.y - sim.y) < 5.0,
          );
          if (hitCas) {
            handleCasualtyClusterClick(hitCas);
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

      if (mode.type === 'spawn_unit') {
        const spawnPos = rts.state.stagingArea ?? sim;
        const u = rts.spawnUnit(mode.unitKind, spawnPos);
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
          { id, center: snap.point, width: w, edgeIndex: snap.edgeIndex },
        ]);
        rts.setInteractionMode({ type: 'select' });
        return;
      }

      if (mode.type === 'delete_exit') {
        const hit = exits.find((ex) => {
          const d = Math.hypot(ex.center.x - sim.x, ex.center.y - sim.y);
          return d < ex.width;
        });
        if (hit) {
          setExits((prev) => prev.filter((ex) => ex.id !== hit.id));
        }
        rts.setInteractionMode({ type: 'select' });
        return;
      }

      if (mode.type === 'draw_wall') {
        if (!mode.startPoint) {
          rts.setInteractionMode({ type: 'draw_wall', startPoint: sim });
        } else {
          setInteriorWalls((prev) => [
            ...prev,
            {
              id: `iw-${Date.now()}`,
              start: mode.startPoint!,
              end: sim,
              hasDoor: false,
              doorWidth: 1.5,
              doorPosition: 0.5,
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
        setHazardZones((prev) => [
          ...prev,
          {
            id: `hz-${Date.now()}`,
            pos: sim,
            radius: 5,
            hazardType: mode.hazardType,
            severity: 'medium',
            label: HAZARD_DEFS[mode.hazardType].label,
          },
        ]);
        rts.setInteractionMode({ type: 'select' });
        return;
      }

      if (mode.type === 'place_stairwell') {
        setStairwells((prev) => [
          ...prev,
          {
            id: `sw-${Date.now()}`,
            pos: sim,
            connectsFloors: [0, 1],
            blocked: false,
            label: `Stair ${prev.length + 1}`,
          },
        ]);
        rts.setInteractionMode({ type: 'select' });
        return;
      }

      if (mode.type === 'place_blast_site') {
        setBlastSite(sim);
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
      casualtyClusters,
      handleCasualtyClusterClick,
      applyElementDrag,
    ],
  );

  const handleCanvasWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const map = leafletMapRef.current;
    if (!map) return;
    if (e.deltaY < 0) map.zoomIn();
    else map.zoomOut();
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  // ── Touch support ─────────────────────────────────────────────────────
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchPinchDistRef = useRef<number | null>(null);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      if (e.touches.length === 2) {
        const dx = e.touches[1].clientX - e.touches[0].clientX;
        const dy = e.touches[1].clientY - e.touches[0].clientY;
        touchPinchDistRef.current = Math.hypot(dx, dy);
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

      // Long press = move command (replaces right-click)
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
    [toSim, rerender],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      if (e.touches.length === 2 && touchPinchDistRef.current != null) {
        // Pinch zoom
        const dx = e.touches[1].clientX - e.touches[0].clientX;
        const dy = e.touches[1].clientY - e.touches[0].clientY;
        const dist = Math.hypot(dx, dy);
        const delta = dist - touchPinchDistRef.current;
        const map = leafletMapRef.current;
        if (map && Math.abs(delta) > 20) {
          if (delta > 0) map.zoomIn();
          else map.zoomOut();
          touchPinchDistRef.current = dist;
        }
        return;
      }
      if (e.touches.length !== 1 || !touchStartRef.current) return;

      const touch = e.touches[0];
      const rect = canvasRef.current!.getBoundingClientRect();
      const cx = touch.clientX - rect.left;
      const cy = touch.clientY - rect.top;
      const moved = Math.hypot(cx - touchStartRef.current.x, cy - touchStartRef.current.y);

      if (moved > 10) {
        // Cancel long press on significant movement
        if (longPressTimerRef.current) {
          clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
        }
        isDraggingRef.current = true;
        const sim = toSim(cx, cy);
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

      if (!touchStartRef.current) return;
      const elapsed = Date.now() - touchStartRef.current.time;

      const rect = canvasRef.current!.getBoundingClientRect();
      const lastTouch = e.changedTouches[0];
      const cx = lastTouch.clientX - rect.left;
      const cy = lastTouch.clientY - rect.top;
      const sim = toSim(cx, cy);
      const rts = rtsRef.current;
      const mode = rts.state.interactionMode;

      if (isDraggingRef.current && dragStartRef.current) {
        // Drag end = box select
        rts.selectUnitsInBox(dragStartRef.current, sim);
        rts.state.selection.selectionBox = null;
      } else if (elapsed < 300) {
        // Short tap = click action
        if (mode.type === 'select') {
          const hitCas = casualtyClusters.find(
            (c) => Math.hypot(c.pos.x - sim.x, c.pos.y - sim.y) < 5.0,
          );
          if (hitCas) {
            handleCasualtyClusterClick(hitCas);
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
        } else if (mode.type === 'spawn_unit') {
          const spawnPos = rts.state.stagingArea ?? sim;
          const u = rts.spawnUnit(mode.unitKind, spawnPos);
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
              { id, center: snap.point, width: w, edgeIndex: snap.edgeIndex },
            ]);
          }
          rts.setInteractionMode({ type: 'select' });
        } else if (mode.type === 'delete_exit') {
          const hit = exits.find(
            (ex) => Math.hypot(ex.center.x - sim.x, ex.center.y - sim.y) < ex.width,
          );
          if (hit) setExits((prev) => prev.filter((ex) => ex.id !== hit.id));
          rts.setInteractionMode({ type: 'select' });
        } else if (mode.type === 'draw_wall') {
          if (!mode.startPoint) {
            rts.setInteractionMode({ type: 'draw_wall', startPoint: sim });
          } else {
            setInteriorWalls((prev) => [
              ...prev,
              {
                id: `iw-${Date.now()}`,
                start: mode.startPoint!,
                end: sim,
                hasDoor: false,
                doorWidth: 1.5,
                doorPosition: 0.5,
              },
            ]);
            rts.setInteractionMode({ type: 'draw_wall', startPoint: null });
          }
        } else if (mode.type === 'place_door') {
          let bestIdx = -1;
          let bestDist = 8;
          for (let i = 0; i < interiorWalls.length; i++) {
            const w = interiorWalls[i];
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
          setHazardZones((prev) => [
            ...prev,
            {
              id: `hz-${Date.now()}`,
              pos: sim,
              radius: 5,
              hazardType: mode.hazardType,
              severity: 'medium',
              label: HAZARD_DEFS[mode.hazardType].label,
            },
          ]);
          rts.setInteractionMode({ type: 'select' });
        } else if (mode.type === 'place_stairwell') {
          setStairwells((prev) => [
            ...prev,
            {
              id: `sw-${Date.now()}`,
              pos: sim,
              connectsFloors: [0, 1],
              blocked: false,
              label: `Stair ${prev.length + 1}`,
            },
          ]);
          rts.setInteractionMode({ type: 'select' });
        } else if (mode.type === 'place_blast_site') {
          setBlastSite(sim);
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
      casualtyClusters,
      wallPoints,
      projectedVerts,
      interiorWalls,
      exits,
      newExitWidth,
      handleCasualtyClusterClick,
      handleWallPointClick,
    ],
  );

  // ── Staging area handler ──────────────────────────────────────────────
  const handleSetStagingArea = () => {
    rtsRef.current.setInteractionMode({ type: 'select' });
    const handleStaging = (e: MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const sim = toSim(cx, cy);
      rtsRef.current.setStagingArea(sim);
      canvas.removeEventListener('click', handleStaging);
      rerender();
    };
    canvasRef.current?.addEventListener('click', handleStaging, { once: true });
  };

  // ── Derived values ────────────────────────────────────────────────────
  const rts = rtsRef.current;
  const gameState = rts.state;
  const clockDisplay = rts.formatClock();
  const phaseLabel = rts.phaseLabel();
  const parsedLat = parseFloat(lat);
  const parsedLng = parseFloat(lng);
  const parsedRadius = parseInt(radius, 10) || 300;

  const handleDetonation = () => {
    if (exits.length === 0) return;
    initEvacEngine();
    rts.startDetonation();
  };

  // =====================================================================
  // RENDER
  // =====================================================================
  return (
    <div className="min-h-screen bg-black text-green-400 font-mono flex flex-col">
      {/* Header */}
      <div className="border-b border-green-800 p-3 flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-lg tracking-wider text-amber-400">
            [RTS CRISIS SIMULATION — PROTOTYPE]
          </h1>
          <p className="text-xs text-green-700 mt-0.5">
            {phase === 'map'
              ? 'Select a building to begin the scenario'
              : `${selectedGrid?.buildingName || `Building #${selectedGridIdx}`} — ${phaseLabel}`}
          </p>
        </div>
        <div className="flex gap-2 items-center">
          {phase === 'rts' && (
            <>
              <span className="text-amber-300 text-sm font-bold">{clockDisplay}</span>
              <button
                onClick={backToMap}
                className="text-xs text-green-600 hover:text-green-400 border border-green-800 rounded px-2 py-1"
              >
                ← Back to Map
              </button>
            </>
          )}
          <a
            href="/debug/evacuation-sim"
            className="text-xs text-green-600 hover:text-green-400 border border-green-800 rounded px-2 py-1"
          >
            Evac Sim
          </a>
        </div>
      </div>

      {/* MAP PHASE — controls bar */}
      {phase === 'map' && (
        <div className="flex flex-wrap gap-3 p-3 items-end border-b border-green-900 flex-shrink-0">
          {/* Place search */}
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
      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar: team palette (RTS only) */}
        {phase === 'rts' && (
          <div className="w-56 border-r border-green-800 overflow-y-auto p-2 space-y-2 flex-shrink-0">
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
          </div>
        )}

        {/* CENTER: Map (always visible) with canvas overlay in RTS mode */}
        <div
          className="flex-1 relative overflow-hidden"
          ref={containerRef}
          style={{ touchAction: 'none' }}
        >
          <MapContainer
            center={[
              Number.isNaN(parsedLat) ? 1.3 : parsedLat,
              Number.isNaN(parsedLng) ? 103.8 : parsedLng,
            ]}
            zoom={18}
            maxZoom={22}
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
              maxZoom={22}
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
                    eventHandlers={phase === 'map' ? { click: () => selectBuilding(idx) } : {}}
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
                width={canvasSize.w}
                height={canvasSize.h}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: canvasSize.w,
                  height: canvasSize.h,
                  pointerEvents: 'auto',
                  zIndex: 1000,
                  touchAction: 'none',
                }}
                className="cursor-crosshair"
                onMouseDown={handleCanvasMouseDown}
                onMouseMove={handleCanvasMouseMove}
                onMouseUp={handleCanvasMouseUp}
                onWheel={handleCanvasWheel}
                onContextMenu={handleContextMenu}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
              />
              {/* Mode indicator overlay */}
              <div
                className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/70 rounded px-3 py-1.5 text-xs text-green-400 pointer-events-none"
                style={{ zIndex: 1001 }}
              >
                {gameState.interactionMode.type !== 'select' ? (
                  <span className="text-amber-400">
                    Mode: {gameState.interactionMode.type.replace(/_/g, ' ').toUpperCase()} — click
                    to place, ESC to cancel
                  </span>
                ) : (
                  <span>
                    Mouse: click select · drag box · right-click move · scroll zoom | Touch: tap
                    select · long-press move · drag box · pinch zoom
                  </span>
                )}
              </div>

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

              {/* ── Floating triage card ── */}
              {activeCasualtyCluster && (
                <div
                  className="absolute top-4 bg-gray-900/95 border border-red-700 rounded-lg shadow-2xl overflow-hidden"
                  style={{
                    zIndex: 1002,
                    left: 16,
                    width: 480,
                    maxHeight: 'calc(100% - 32px)',
                    overflowY: 'auto',
                  }}
                >
                  <div className="flex items-center justify-between px-3 py-2 bg-red-900/40 border-b border-red-800">
                    <div className="text-xs text-red-300 font-bold">
                      Casualty Cluster — {activeCasualtyCluster.victims.length} victims
                    </div>
                    <button
                      onClick={closeCasualtyCard}
                      className="text-gray-400 hover:text-white text-sm px-1"
                    >
                      ✕
                    </button>
                  </div>

                  {/* Scene image */}
                  <div className="relative bg-black" style={{ minHeight: 160 }}>
                    {activeCasualtyCluster.imageUrl ? (
                      <img
                        src={activeCasualtyCluster.imageUrl}
                        alt="Casualty scene"
                        className="w-full h-auto"
                      />
                    ) : activeCasualtyCluster.imageGenerating ? (
                      <div className="flex items-center justify-center h-40 text-red-400 text-xs animate-pulse">
                        Generating scene image with DALL-E 3...
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center h-40 gap-2">
                        <span className="text-xs text-gray-500">No scene image yet</span>
                        <button
                          onClick={() => handleGenerateCasualtyImage(activeCasualtyCluster.id)}
                          className="bg-red-800 hover:bg-red-700 text-white text-xs px-3 py-1 rounded border border-red-600"
                        >
                          Generate Scene Image (DALL-E 3)
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Scene description */}
                  <div className="px-3 py-1.5 text-xs text-gray-400 border-t border-gray-800">
                    {activeCasualtyCluster.sceneDescription}
                  </div>

                  {/* Victim cards — image-first */}
                  <div className="px-3 py-2 border-t border-gray-800 space-y-2">
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-xs text-red-400 font-bold">Triage Assessment</div>
                      {activeCasualtyCluster.victims.some(
                        (v) => !v.imageUrl && !v.imageGenerating,
                      ) && (
                        <button
                          onClick={() => handleGenerateVictimImages(activeCasualtyCluster.id)}
                          className="bg-red-800 hover:bg-red-700 text-white text-xs px-2 py-0.5 rounded border border-red-600"
                        >
                          Generate Victim Photos
                        </button>
                      )}
                    </div>
                    {activeCasualtyCluster.victims.map((v) => (
                      <div
                        key={v.id}
                        className="bg-gray-800 rounded overflow-hidden border border-gray-700"
                      >
                        {/* Victim image */}
                        <div className="relative">
                          {v.imageUrl ? (
                            <img
                              src={v.imageUrl}
                              alt={v.label}
                              className="w-full h-40 object-cover"
                            />
                          ) : v.imageGenerating ? (
                            <div className="w-full h-32 flex items-center justify-center bg-gray-900 text-red-400 text-xs animate-pulse">
                              Generating {v.label} image...
                            </div>
                          ) : (
                            <div className="w-full h-24 flex items-center justify-center bg-gray-900 text-gray-600 text-xs">
                              No photo — click "Generate Victim Photos" above
                            </div>
                          )}
                          {/* Label overlay on image */}
                          <div className="absolute top-1 left-1 bg-black/70 rounded px-1.5 py-0.5">
                            <span className="text-xs text-white font-bold">{v.label}</span>
                          </div>
                          {isTrainerMode && (
                            <div
                              className={`absolute top-1 right-1 rounded px-1.5 py-0.5 text-xs font-bold ${
                                v.trueTag === 'red'
                                  ? 'bg-red-700 text-white'
                                  : v.trueTag === 'yellow'
                                    ? 'bg-yellow-600 text-white'
                                    : v.trueTag === 'green'
                                      ? 'bg-green-700 text-white'
                                      : 'bg-gray-700 text-white'
                              }`}
                            >
                              {v.trueTag.toUpperCase()}
                            </div>
                          )}
                          {/* Current tag overlay */}
                          {v.playerTag !== 'untagged' && (
                            <div
                              className={`absolute bottom-1 right-1 rounded px-2 py-0.5 text-xs font-bold border ${
                                v.playerTag === 'red'
                                  ? 'bg-red-700 border-red-400 text-white'
                                  : v.playerTag === 'yellow'
                                    ? 'bg-yellow-600 border-yellow-400 text-white'
                                    : v.playerTag === 'green'
                                      ? 'bg-green-700 border-green-400 text-white'
                                      : 'bg-gray-600 border-gray-400 text-white'
                              }`}
                            >
                              Tagged: {v.playerTag.toUpperCase()}
                            </div>
                          )}
                        </div>
                        {/* Observable signs (collapsed, secondary to the image) */}
                        <div className="px-2 py-1.5">
                          <div className="text-xs text-gray-500 leading-tight mb-1.5">
                            {v.observableSigns.visibleInjuries} · {v.observableSigns.consciousness}{' '}
                            · {v.observableSigns.bleeding}
                          </div>
                          <div className="flex gap-1">
                            {(['red', 'yellow', 'green', 'black'] as TriageTag[]).map((tag) => (
                              <button
                                key={tag}
                                onClick={() =>
                                  handleUpdateVictimTag(activeCasualtyCluster.id, v.id, tag)
                                }
                                className={`flex-1 text-xs py-1.5 rounded border font-bold transition-colors ${
                                  v.playerTag === tag
                                    ? tag === 'red'
                                      ? 'bg-red-700 border-red-500 text-white'
                                      : tag === 'yellow'
                                        ? 'bg-yellow-700 border-yellow-500 text-white'
                                        : tag === 'green'
                                          ? 'bg-green-700 border-green-500 text-white'
                                          : 'bg-gray-600 border-gray-400 text-white'
                                    : 'border-gray-600 text-gray-400 hover:border-gray-400'
                                }`}
                              >
                                {tag.toUpperCase()}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* AI evaluation result */}
                  {triageResult && (
                    <div className="px-3 py-2 border-t border-gray-800 bg-gray-800/50">
                      <div className="text-xs text-amber-400 font-bold mb-1">
                        Exercise Observer — Triage Evaluation
                      </div>
                      <pre className="text-xs text-green-300 whitespace-pre-wrap">
                        {triageResult}
                      </pre>
                    </div>
                  )}

                  {/* Submit */}
                  <div className="px-3 py-2 border-t border-gray-800 flex justify-between items-center">
                    <span className="text-xs text-gray-600">
                      {
                        activeCasualtyCluster.victims.filter((v) => v.playerTag !== 'untagged')
                          .length
                      }
                      /{activeCasualtyCluster.victims.length} tagged
                    </span>
                    <button
                      onClick={handleSubmitTriage}
                      disabled={
                        activeCasualtyCluster.victims.some((v) => v.playerTag === 'untagged') ||
                        triageLoading ||
                        activeCasualtyCluster.triageComplete
                      }
                      className="bg-red-800 hover:bg-red-700 disabled:opacity-30 text-white text-xs px-4 py-1.5 rounded border border-red-600 font-bold"
                    >
                      {triageLoading
                        ? 'Evaluating...'
                        : activeCasualtyCluster.triageComplete
                          ? 'Triage Complete'
                          : 'Submit Triage'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Right sidebar */}
        {phase === 'map' ? (
          /* Building list (map phase) */
          <div className="w-80 border-l border-green-800 overflow-y-auto p-3 space-y-3 flex-shrink-0">
            <div className="bg-gray-900 border border-green-800 rounded p-3">
              <h2 className="text-sm text-amber-400 mb-2 border-b border-green-900 pb-1">
                RTS Prototype
              </h2>
              <div className="text-xs text-green-700 space-y-1">
                <p>1. Click the map or load a saved map</p>
                <p>2. Fetch buildings nearby</p>
                <p>3. Click a building to enter the RTS scenario</p>
                <p>4. Place exits, set staging area, deploy units</p>
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
                    disabled={!saveMapName.trim()}
                    className="bg-green-800 hover:bg-green-700 disabled:opacity-30 text-green-100 px-2 py-1 text-xs rounded border border-green-600"
                  >
                    Save
                  </button>
                </div>
              )}
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
          <div className="w-64 border-l border-green-800 overflow-y-auto p-3 space-y-3 flex-shrink-0">
            {/* Clock */}
            <div className="bg-gray-900 border border-green-800 rounded p-3">
              <div className="text-sm text-amber-400 font-bold mb-2">{phaseLabel}</div>
              <div className="text-2xl text-amber-300 font-bold text-center mb-3">
                {clockDisplay}
              </div>
              <div className="flex gap-2">
                {gameState.clock.phase === 'setup' ? (
                  <button
                    onClick={handleDetonation}
                    disabled={exits.length === 0}
                    className="flex-1 bg-red-800 hover:bg-red-700 disabled:opacity-30 text-white text-xs px-2 py-2 rounded border border-red-600 font-bold"
                  >
                    💥 DETONATE
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
            </div>

            {/* Setup tools */}
            {gameState.clock.phase === 'setup' && (
              <div className="bg-gray-900 border border-green-800 rounded p-3 space-y-2">
                <div className="text-xs text-green-500 uppercase tracking-wider">Setup</div>
                <div className="space-y-1.5">
                  <button
                    onClick={() => {
                      rts.setInteractionMode({ type: 'place_exit' });
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
                      rts.setInteractionMode({ type: 'delete_exit' });
                      rerender();
                    }}
                    className={`w-full text-xs text-left px-2 py-1.5 rounded border transition-colors ${
                      gameState.interactionMode.type === 'delete_exit'
                        ? 'border-red-400 bg-red-900/30 text-red-300'
                        : 'border-green-900 text-green-500 hover:border-green-700'
                    }`}
                  >
                    ❌ Delete Exit
                  </button>
                  <button
                    onClick={handleSetStagingArea}
                    className="w-full text-xs text-left px-2 py-1.5 rounded border border-green-900 text-green-500 hover:border-green-700"
                  >
                    📍 Set Staging Area (click map)
                  </button>
                  <button
                    onClick={() => {
                      rts.setInteractionMode({ type: 'place_blast_site' });
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
                  <button
                    onClick={() => {
                      const handlePlace = (e: MouseEvent) => {
                        const canvas = canvasRef.current;
                        if (!canvas) return;
                        const rect = canvas.getBoundingClientRect();
                        const cx = e.clientX - rect.left;
                        const cy = e.clientY - rect.top;
                        const sim = toSim(cx, cy);

                        let distance = 50;
                        if (blastSite) {
                          distance = Math.hypot(sim.x - blastSite.x, sim.y - blastSite.y);
                        }
                        const { victims, sceneDescription } = generateBlastCasualties(distance);
                        handlePlaceCasualtyCluster(sim, victims, sceneDescription);
                        canvas.removeEventListener('click', handlePlace);
                        rerender();
                      };
                      canvasRef.current?.addEventListener('click', handlePlace, { once: true });
                    }}
                    className="w-full text-xs text-left px-2 py-1.5 rounded border border-red-900 text-red-400 hover:border-red-700"
                  >
                    🏥 Place Casualty Cluster{' '}
                    {blastSite ? '(auto-generates by blast distance)' : '(click map)'}
                  </button>
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
                      rts.setInteractionMode({ type: 'draw_wall', startPoint: null });
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
                      rts.setInteractionMode({ type: 'place_door' });
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
                            rts.setInteractionMode({ type: 'place_hazard', hazardType: ht });
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
                      rts.setInteractionMode({ type: 'place_stairwell' });
                      rerender();
                    }}
                    className={`w-full text-xs text-left px-2 py-1.5 rounded border transition-colors ${
                      gameState.interactionMode.type === 'place_stairwell'
                        ? 'border-cyan-400 bg-cyan-900/30 text-cyan-300'
                        : 'border-gray-700 text-gray-300 hover:border-gray-500'
                    }`}
                  >
                    🪜 Place Stairwell (click inside building)
                  </button>
                  <div className="text-xs text-green-700">
                    Walls: {interiorWalls.length} · Hazards: {hazardZones.length} · Stairs:{' '}
                    {stairwells.length}
                  </div>
                </div>

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
                            // Re-project and update engine
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
                    value={pedestrianCount}
                    onChange={(e) => setPedestrianCount(Math.max(1, Number(e.target.value) || 1))}
                    className="w-full bg-gray-800 border border-green-800 text-green-300 px-2 py-1 text-xs rounded"
                  />
                  <span className="text-xs text-green-700 mt-0.5 block">
                    Large counts (&gt;500) may slow the simulation
                  </span>
                </div>
                <div className="text-xs text-green-700 mt-1">
                  Exits: {exits.length} · Staging: {gameState.stagingArea ? '✓' : '—'} · Blast:{' '}
                  {blastSite ? '✓' : '—'} · Casualties: {casualtyClusters.length}
                </div>
              </div>
            )}

            {/* Heat meter */}
            <div className="bg-gray-900 border border-green-800 rounded p-3">
              <div className="text-xs text-green-500 uppercase tracking-wider mb-2">Heat Meter</div>
              <div className="w-full h-4 bg-gray-800 rounded overflow-hidden">
                <div
                  className="h-full transition-all duration-300"
                  style={{
                    width: `${(gameState.heat.value / 10) * 100}%`,
                    backgroundColor:
                      gameState.heat.value < 3
                        ? '#22c55e'
                        : gameState.heat.value < 6
                          ? '#eab308'
                          : gameState.heat.value < 8
                            ? '#f97316'
                            : '#ef4444',
                  }}
                />
              </div>
              <div className="text-xs text-green-600 mt-1 text-right">
                {gameState.heat.value.toFixed(1)} / 10
              </div>
            </div>

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
