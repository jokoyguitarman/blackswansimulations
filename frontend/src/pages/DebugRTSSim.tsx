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
    map.fitBounds(leafletBounds, { padding: [120, 120], maxZoom: 19 });
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

  // ── Projected polygon ─────────────────────────────────────────────────
  const selectedGrid = selectedGridIdx != null ? fetchResult?.grids[selectedGridIdx] : null;

  const projectedVerts = useMemo<Vec2[]>(() => {
    if (!selectedGrid) return [];
    return projectPolygon(selectedGrid.polygon);
  }, [selectedGrid]);

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
        setLat(clickLat.toFixed(7));
        setLng(clickLng.toFixed(7));
      }
    },
    [phase],
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

      // Generate wall inspection points for this building
      const grid = fetchResult?.grids[gridIdx];
      if (grid && grid.polygon.length >= 3) {
        const verts = projectPolygon(grid.polygon);
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
    evacEngRef.current = new PolygonEvacuationEngine(config, exits);
    rtsRef.current.setBuildingVertices(projectedVerts);
    setPedestrians(evacEngRef.current.getSnapshots());
  }, [projectedVerts, exits, pedestrianCount]);

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
        setPedestrians(evac.getSnapshots());
      }

      // Recompute render context from map on each frame (handles zoom/pan)
      updateRenderCtx();

      const canvas = canvasRef.current;
      const rc = renderCtxRef.current;
      if (canvas && rc) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          renderRTS(
            ctx,
            canvas.width,
            canvas.height,
            rc,
            rts.state,
            projectedVerts,
            exits,
            pedestrians,
            true,
            wallPoints,
            activeWallPoint?.id ?? null,
          );
        }
      }

      rerender();
      rafRef.current = requestAnimationFrame(loop);
    },
    [projectedVerts, exits, pedestrians, rerender, updateRenderCtx, wallPoints, activeWallPoint],
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
      setWallPointImage(dataUrl);
    }
    setWallPointLoading(false);
  }, []);

  const closePhotoCard = useCallback(() => {
    setActiveWallPoint(null);
    setWallPointImage(null);
    setAssessmentText('');
  }, []);

  // ── Canvas mouse handlers ─────────────────────────────────────────────
  const dragStartRef = useRef<Vec2 | null>(null);
  const isDraggingRef = useRef(false);

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
        dragStartRef.current = sim;
        isDraggingRef.current = false;
      }
    },
    [toSim],
  );

  const handleCanvasMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!renderCtxRef.current) return;
      const rect = canvasRef.current!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const sim = toSim(cx, cy);

      const rts = rtsRef.current;
      if (dragStartRef.current && rts.state.interactionMode.type === 'select') {
        isDraggingRef.current = true;
        rts.state.selection.selectionBox = { start: dragStartRef.current, end: sim };
      }
    },
    [toSim],
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

      if (mode.type === 'select') {
        if (isDraggingRef.current && dragStartRef.current) {
          rts.selectUnitsInBox(dragStartRef.current, sim);
        } else {
          // Check wall inspection points first
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
    },
    [toSim, projectedVerts, exits, newExitWidth, wallPoints, handleWallPointClick],
  );

  const handleCanvasWheel = useCallback((e: React.WheelEvent) => {
    const map = leafletMapRef.current;
    if (!map) return;
    if (e.deltaY < 0) map.zoomIn();
    else map.zoomOut();
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

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
              <div className="absolute top-full left-0 w-80 mt-1 bg-gray-900 border border-green-700 rounded shadow-lg z-50 max-h-48 overflow-y-auto">
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
          {error && <span className="text-red-400 text-xs">{error}</span>}
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
        <div className="flex-1 relative overflow-hidden" ref={containerRef}>
          <MapContainer
            center={[
              Number.isNaN(parsedLat) ? 1.3 : parsedLat,
              Number.isNaN(parsedLng) ? 103.8 : parsedLng,
            ]}
            zoom={18}
            style={{ height: '100%', width: '100%' }}
            zoomControl={phase === 'map'}
            dragging={phase === 'map'}
            scrollWheelZoom={phase === 'map'}
            doubleClickZoom={false}
          >
            <TileLayer
              attribution="&copy; OSM"
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
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
                }}
                className="cursor-crosshair"
                onMouseDown={handleCanvasMouseDown}
                onMouseMove={handleCanvasMouseMove}
                onMouseUp={handleCanvasMouseUp}
                onWheel={handleCanvasWheel}
                onContextMenu={handleContextMenu}
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
                    Left: select · Drag: box select · Right: move · Scroll: zoom · Click 📷 to
                    inspect wall
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
                      <div className="flex items-center justify-center h-48 text-xs text-gray-500">
                        {GOOGLE_MAPS_KEY
                          ? 'No Street View image available for this location'
                          : 'Set VITE_GOOGLE_MAPS_API_KEY to enable Street View'}
                      </div>
                    )}
                  </div>

                  {/* Coordinates */}
                  <div className="px-3 py-1.5 text-xs text-gray-500 border-t border-gray-800 flex gap-3">
                    <span>
                      Wall: {activeWallPoint.lat.toFixed(6)}, {activeWallPoint.lng.toFixed(6)}
                    </span>
                    <span>Heading: {Math.round(activeWallPoint.heading)}°</span>
                  </div>

                  {/* Assessment input */}
                  <div className="px-3 py-2 border-t border-gray-800">
                    <label className="block text-xs text-cyan-400 mb-1">Assessment</label>
                    <textarea
                      value={assessmentText}
                      onChange={(e) => setAssessmentText(e.target.value)}
                      placeholder="Describe what you observe — suspicious items, structural damage, concealment points..."
                      className="w-full bg-gray-800 border border-gray-700 text-green-300 text-xs rounded px-2 py-1.5 resize-none focus:border-cyan-500 focus:outline-none"
                      rows={3}
                    />
                    <div className="flex justify-between items-center mt-1.5">
                      <span className="text-xs text-gray-600">AI evaluation coming soon</span>
                      <button
                        disabled={!assessmentText.trim()}
                        className="bg-cyan-800 hover:bg-cyan-700 disabled:opacity-30 text-cyan-100 px-3 py-1 text-xs rounded border border-cyan-600"
                      >
                        Submit Assessment
                      </button>
                    </div>
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
                      <button
                        key={idx}
                        onClick={() => selectBuilding(idx)}
                        className={`w-full text-left p-2 rounded border text-xs transition-colors ${
                          selectedGridIdx === idx
                            ? 'border-cyan-500 bg-cyan-900/30 text-cyan-300'
                            : 'border-green-900 hover:border-green-700 text-green-500 hover:text-green-400'
                        }`}
                      >
                        <div className="font-bold">
                          {grid.buildingName || `Building #${grid.buildingIndex}`}
                        </div>
                        <div className="text-green-700 mt-0.5">{grid.polygon.length} pts</div>
                      </button>
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
                    type="range"
                    min={20}
                    max={500}
                    step={10}
                    value={pedestrianCount}
                    onChange={(e) => setPedestrianCount(Number(e.target.value))}
                    className="w-full"
                  />
                  <span className="text-xs text-green-400">{pedestrianCount}</span>
                </div>
                <div className="text-xs text-green-700 mt-1">
                  Exits: {exits.length} · Staging: {gameState.stagingArea ? 'Set' : 'Not set'}
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
