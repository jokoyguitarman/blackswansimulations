/**
 * SceneEditor — Reusable scene design component.
 *
 * Extracted from DebugRTSSim's scene-design flow. Provides:
 *  - Building search + polygon selection (map phase)
 *  - Scene editing tools (exits, walls, hazards, blast site, stairwells)
 *  - Perimeter wall inspection points + planted items
 *  - Save/load scene configs to/from DB
 *  - Canvas rendering via renderRTS
 *
 * Does NOT include: RTS game engine, unit spawning, evacuation sim,
 * spatial effects runtime, equipment placement, clock/phase management.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  MapContainer,
  TileLayer,
  Polygon,
  CircleMarker,
  Circle,
  useMap,
  useMapEvents,
} from 'react-leaflet';
import L from 'leaflet';
import { supabase } from '../../lib/supabase';
import { projectPolygon, nearestEdge, edgeLength } from '../../lib/evacuation/geometry';
import { renderRTS, computeMapRenderContext } from '../../lib/rts/renderer';
import type { RenderContext } from '../../lib/rts/renderer';
import {
  type InteriorWall,
  type HazardZone,
  type HazardType,
  type Stairwell,
  type PlantedItem,
  HAZARD_DEFS,
  createInitialGameState,
} from '../../lib/rts/types';
import type { ExitDef, Vec2 } from '../../lib/evacuation/types';
import {
  generateWallPoints,
  fetchStreetViewImage,
  type WallInspectionPoint,
} from '../../lib/rts/wallInspection';
import {
  createSceneConfig,
  updateSceneConfig,
  loadSceneConfig,
} from '../../lib/rts/sceneConfigApi';
import { BuildingDrawHandler } from './BuildingDrawHandler';
import { autoTraceBuilding } from './buildingAutoTrace';
import 'leaflet/dist/leaflet.css';

const GOOGLE_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

// ── Types ─────────────────────────────────────────────────────────────────

export interface SceneConfig {
  buildingPolygon: [number, number][];
  buildingName: string | null;
  centerLat: number;
  centerLng: number;
  exits: ExitDef[];
  interiorWalls: InteriorWall[];
  hazardZones: HazardZone[];
  stairwells: Stairwell[];
  blastSite: Vec2 | null;
  blastRadius: number;
  wallInspectionPoints: WallInspectionPoint[];
  plantedItems: PlantedItem[];
  pedestrianCount: number;
  weaponType: string | null;
  locationDescription: string | null;
}

export interface SceneEditorProps {
  incidentType: string;
  onSave: (sceneId: string, config: SceneConfig) => void;
  initialSceneId?: string | null;
  weaponType?: string | null;
  onWeaponTypeChange?: (wt: string) => void;
}

// ── API helper ────────────────────────────────────────────────────────────

async function getAuthHeaders() {
  const { data } = await supabase.auth.getSession();
  const session = data?.session;
  return {
    'Content-Type': 'application/json',
    Authorization: session ? `Bearer ${session.access_token}` : '',
  };
}

const apiUrl = (path: string) => {
  const base = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
  return base ? `${base}${path}` : path;
};

// ── Stud generation (client-side for scene preview) ───────────────────────

interface StudPoint {
  id: string;
  lat: number;
  lng: number;
  simPos: Vec2;
  studType: string;
  spatialContext: string | null;
}

const STUD_SPACING_M = 3;
const EXTERIOR_PADDING_M = 150;

function generateStudsForPolygon(polygon: [number, number][], _verts: Vec2[]): StudPoint[] {
  if (polygon.length < 3) return [];
  let minLat = Infinity,
    maxLat = -Infinity,
    minLng = Infinity,
    maxLng = -Infinity;
  for (const [la, ln] of polygon) {
    if (la < minLat) minLat = la;
    if (la > maxLat) maxLat = la;
    if (ln < minLng) minLng = ln;
    if (ln > maxLng) maxLng = ln;
  }
  const midLat = (minLat + maxLat) / 2;
  const dLat = STUD_SPACING_M / 111_320;
  const dLng = STUD_SPACING_M / (111_320 * Math.cos((midLat * Math.PI) / 180));
  const extPadLat = EXTERIOR_PADDING_M / 111_320;
  const extPadLng = EXTERIOR_PADDING_M / (111_320 * Math.cos((midLat * Math.PI) / 180));
  const refLat = polygon.reduce((s, p) => s + p[0], 0) / polygon.length;
  const refLng = polygon.reduce((s, p) => s + p[1], 0) / polygon.length;
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos((refLat * Math.PI) / 180);

  const studs: StudPoint[] = [];
  let row = 0;
  for (let la = minLat - extPadLat; la <= maxLat + extPadLat; la += dLat) {
    let col = 0;
    for (let ln = minLng - extPadLng; ln <= maxLng + extPadLng; ln += dLng) {
      const inside = pointInPoly(la, ln, polygon);
      studs.push({
        id: inside ? `stud-${row}-${col}` : `ext-${row}-${col}`,
        lat: la,
        lng: ln,
        simPos: {
          x: (ln - refLng) * mPerDegLng,
          y: (refLat - la) * mPerDegLat,
        },
        studType: inside ? 'building' : 'outdoor',
        spatialContext: inside ? 'inside_building' : 'open_air',
      });
      col++;
    }
    row++;
  }
  return studs;
}

function pointInPoly(lat: number, lng: number, polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i];
    const [yj, xj] = polygon[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ── Leaflet helpers ───────────────────────────────────────────────────────

function MapRefSync({ onMap }: { onMap: (m: L.Map) => void }) {
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
    const bounds = L.latLngBounds(polygon.map(([la, ln]) => [la, ln] as [number, number]));
    map.fitBounds(bounds, { padding: [80, 80], maxZoom: 20 });
  }, [map, polygon]);
  return null;
}

function FlyToPoint({ lat, lng, zoom }: { lat: number; lng: number; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    if (lat === 0 && lng === 0) return;
    map.flyTo([lat, lng], zoom, { duration: 0.8 });
  }, [map, lat, lng, zoom]);
  return null;
}

function AutoTraceClickHandler({
  active,
  tolerance,
  onResult,
  onStatus,
}: {
  active: boolean;
  tolerance: number;
  onResult: (polygon: [number, number][]) => void;
  onStatus: (status: string | null) => void;
}) {
  const map = useMap();
  useMapEvents({
    click(e) {
      if (!active) return;
      const cp = map.latLngToContainerPoint(e.latlng);
      onStatus('Tracing...');
      try {
        const { polygon, pixelCount } = autoTraceBuilding(map, cp.x, cp.y, tolerance);
        if (polygon.length < 3) {
          onStatus(
            pixelCount < 50
              ? 'No building detected at this point. Try clicking directly on a building.'
              : 'Could not trace a clean outline. Try a different spot.',
          );
          return;
        }
        onStatus(null);
        onResult(polygon);
      } catch {
        onStatus('Trace failed. Try again.');
      }
    },
  });

  useEffect(() => {
    if (!active) return;
    const container = map.getContainer();
    container.style.cursor = 'crosshair';
    return () => {
      container.style.cursor = '';
    };
  }, [map, active]);

  return null;
}

// ── Main Component ────────────────────────────────────────────────────────

let exitIdCounter = 1000;

export function SceneEditor({
  incidentType,
  onSave,
  initialSceneId,
  weaponType: externalWeaponType,
  onWeaponTypeChange,
}: SceneEditorProps) {
  void incidentType; // will be used for scene-specific defaults later

  // Phase: 'map' (searching) or 'edit' (scene editing)
  const [phase, setPhase] = useState<'map' | 'edit'>('map');

  // GPS + Map search state
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [radius, setRadius] = useState('300');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<
    Array<{ lat: string; lon: string; display_name: string }>
  >([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchCountry, setSearchCountry] = useState('');
  const [userGeoPos, setUserGeoPos] = useState<{ lat: number; lng: number } | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mapPhaseMapRef = useRef<L.Map | null>(null);
  const [fetchResult, setFetchResult] = useState<{
    grids: Array<{
      buildingIndex: number;
      buildingName: string | null;
      polygon: [number, number][];
      studs: StudPoint[];
    }>;
  } | null>(null);
  const [selectedGridIdx, setSelectedGridIdx] = useState<number | null>(null);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Draw building mode
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawnBuildingName, setDrawnBuildingName] = useState('');
  const [locationDescription, setLocationDescription] = useState<string | null>(null);

  // Auto-trace mode
  const [isAutoTracing, setIsAutoTracing] = useState(false);
  const [autoTracePreview, setAutoTracePreview] = useState<[number, number][] | null>(null);
  const [autoTraceTolerance, setAutoTraceTolerance] = useState(20);
  const [autoTraceStatus, setAutoTraceStatus] = useState<string | null>(null);

  // Scene state
  const [exits, setExits] = useState<ExitDef[]>([]);
  const [interiorWalls, setInteriorWalls] = useState<InteriorWall[]>([]);
  const [hazardZones, setHazardZones] = useState<HazardZone[]>([]);
  const [stairwells, setStairwells] = useState<Stairwell[]>([]);
  const [blastSite, setBlastSite] = useState<Vec2 | null>(null);
  const [blastRadius, setBlastRadius] = useState(20);
  const [wallPoints, setWallPoints] = useState<WallInspectionPoint[]>([]);
  const [plantedItems, setPlantedItems] = useState<PlantedItem[]>([]);
  const [pedestrianCount, setPedestrianCount] = useState(120);
  const [localWeaponType, setLocalWeaponType] = useState(externalWeaponType || '');

  // Zone circles (trainer-editable, individually movable)
  const [gameZones, setGameZones] = useState<
    Array<{ type: string; radius: number; center?: Vec2 }>
  >([
    { type: 'hot', radius: 25 },
    { type: 'warm', radius: 50 },
    { type: 'cold', radius: 100 },
  ]);

  // Stud inspection
  const [studInspectMode, setStudInspectMode] = useState(false);
  const [inspectedStud, setInspectedStud] = useState<StudPoint | null>(null);

  // Editor mode
  const [activeMode, setActiveMode] = useState<string>('select');

  // Save state
  const [sceneConfigId, setSceneConfigId] = useState<string | null>(initialSceneId || null);
  const [saving, setSaving] = useState(false);

  // Wall inspection state
  const [activeWallPoint, setActiveWallPoint] = useState<WallInspectionPoint | null>(null);
  const [wallPointImage, setWallPointImage] = useState<string | null>(null);
  const [wallPointLoading, setWallPointLoading] = useState(false);
  const [plantDescription, setPlantDescription] = useState('');
  const [plantThreatLevel, setPlantThreatLevel] =
    useState<PlantedItem['threatLevel']>('real_device');
  const [plantDifficulty] = useState<PlantedItem['concealmentDifficulty']>('moderate');
  const photoUploadRef = useRef<HTMLInputElement>(null);
  const hazardPhotoRef = useRef<HTMLInputElement>(null);

  // Canvas refs
  const leafletMapRef = useRef<L.Map | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const renderCtxRef = useRef<RenderContext | null>(null);
  const rafRef = useRef(0);
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 });

  // Render-loop refs (keeps RAF loop current without effect restarts)
  const exitsRef = useRef(exits);
  exitsRef.current = exits;
  const wallPointsRef = useRef(wallPoints);
  wallPointsRef.current = wallPoints;
  const activeWallPointRef = useRef(activeWallPoint);
  activeWallPointRef.current = activeWallPoint;
  const interiorWallsRef = useRef(interiorWalls);
  interiorWallsRef.current = interiorWalls;
  const hazardZonesRef = useRef(hazardZones);
  hazardZonesRef.current = hazardZones;
  const stairwellsRef = useRef(stairwells);
  stairwellsRef.current = stairwells;
  const blastSiteRef = useRef(blastSite);
  blastSiteRef.current = blastSite;
  const blastRadiusRef = useRef(blastRadius);
  blastRadiusRef.current = blastRadius;
  const gameZonesRef = useRef(gameZones);
  gameZonesRef.current = gameZones;
  const simStudsRef = useRef<StudPoint[]>([]);
  const plantedItemsRef = useRef(plantedItems);
  plantedItemsRef.current = plantedItems;

  // Derived
  const selectedGrid = useMemo(
    () => (selectedGridIdx != null && fetchResult ? fetchResult.grids[selectedGridIdx] : null),
    [selectedGridIdx, fetchResult],
  );
  const projectedVerts = useMemo(
    () => (selectedGrid ? projectPolygon(selectedGrid.polygon) : []),
    [selectedGrid],
  );
  const simStuds = useMemo(
    () => (selectedGrid ? generateStudsForPolygon(selectedGrid.polygon, projectedVerts) : []),
    [selectedGrid, projectedVerts],
  );
  simStudsRef.current = simStuds;

  // Sim-space converter
  const toSim = useCallback((cx: number, cy: number): Vec2 => {
    const rc = renderCtxRef.current;
    if (!rc) return { x: 0, y: 0 };
    return {
      x: (cx - rc.padX) / rc.scale + rc.bounds.minX,
      y: (cy - rc.padY) / rc.scale + rc.bounds.minY,
    };
  }, []);

  const snapToStud = useCallback(
    (sim: Vec2): { pos: Vec2; stud: StudPoint | null } => {
      let best: StudPoint | null = null;
      let bestDist = 6;
      for (const s of simStuds) {
        const d = Math.hypot(s.simPos.x - sim.x, s.simPos.y - sim.y);
        if (d < bestDist) {
          bestDist = d;
          best = s;
        }
      }
      return best ? { pos: best.simPos, stud: best } : { pos: sim, stud: null };
    },
    [simStuds],
  );

  // ── Auto-load saved scene when initialSceneId is set ─────────────────

  const sceneLoadedRef = useRef(false);
  useEffect(() => {
    if (!initialSceneId || sceneLoadedRef.current) return;
    sceneLoadedRef.current = true;

    loadSceneConfig(initialSceneId)
      .then((row) => {
        const r = row as unknown as Record<string, unknown>;
        const polygon = r.building_polygon as [number, number][] | undefined;
        if (!polygon || polygon.length < 3) return;

        const entry = {
          buildingIndex: 0,
          buildingName: (r.building_name as string) || null,
          polygon,
          studs: [] as StudPoint[],
        };
        setFetchResult({ grids: [entry] });
        setSelectedGridIdx(0);

        // Restore scene elements
        const exitsRaw = (r.exits as ExitDef[]) || [];
        setExits(exitsRaw);
        setInteriorWalls((r.interior_walls as InteriorWall[]) || []);
        setHazardZones((r.hazard_zones as HazardZone[]) || []);
        setStairwells((r.stairwells as Stairwell[]) || []);
        setPlantedItems((r.planted_items as PlantedItem[]) || []);
        setPedestrianCount((r.pedestrian_count as number) || 120);

        const bs = r.blast_site as Record<string, unknown> | null;
        if (bs && typeof bs.x === 'number' && typeof bs.y === 'number') {
          setBlastSite({ x: bs.x, y: bs.y });
          if (bs.radius) setBlastRadius(bs.radius as number);
          if (bs.weaponType) {
            setLocalWeaponType(bs.weaponType as string);
            onWeaponTypeChange?.(bs.weaponType as string);
          }
          if (bs.locationDescription) setLocationDescription(bs.locationDescription as string);
          if (bs.gameZones)
            setGameZones(bs.gameZones as Array<{ type: string; radius: number; center?: Vec2 }>);
        }

        // Generate wall points from polygon
        const verts = projectPolygon(polygon);
        const pts = generateWallPoints(polygon, verts);
        setWallPoints((r.wall_inspection_points as WallInspectionPoint[]) || pts);

        setActiveMode('select');
        setPhase('edit');
      })
      .catch(() => {
        // Failed to load -- trainer can re-design
      });
  }, [initialSceneId]);

  // ── GPS auto-detect on mount ──────────────────────────────────────────

  useEffect(() => {
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
        const map = mapPhaseMapRef.current;
        if (map) map.setView([gLat, gLng], 16);
        fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${gLat}&lon=${gLng}&format=json&zoom=3`,
          { headers: { 'User-Agent': 'BlackSwanSimulations/1.0' } },
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

  // ── Debounced search ────────────────────────────────────────────────

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
    },
    [userGeoPos, searchCountry],
  );

  const handleSelectResult = useCallback(
    (result: { lat: string; lon: string; display_name: string }) => {
      setLat(parseFloat(result.lat).toFixed(7));
      setLng(parseFloat(result.lon).toFixed(7));
      setSearchQuery(result.display_name);
      setLocationDescription(result.display_name);
      setSearchOpen(false);
      setSearchResults([]);
      const map = mapPhaseMapRef.current;
      if (map) map.setView([parseFloat(result.lat), parseFloat(result.lon)], 17);
    },
    [],
  );

  // ── Fetch buildings ───────────────────────────────────────────────────

  const handleFetch = useCallback(async () => {
    setFetchLoading(true);
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setFetchResult({ grids: data.grids ?? [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFetchLoading(false);
    }
  }, [lat, lng, radius]);

  // ── Select building → enter edit mode ─────────────────────────────────

  const selectBuilding = useCallback(
    (gridIdx: number) => {
      setSelectedGridIdx(gridIdx);
      setExits([]);
      setInteriorWalls([]);
      setHazardZones([]);
      setStairwells([]);
      setBlastSite(null);
      setPlantedItems([]);
      setActiveMode('select');
      setPhase('edit');

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

  // ── Draw building polygon → enter edit mode ───────────────────────────

  const handleDrawComplete = useCallback(
    (polygon: [number, number][]) => {
      const entry = {
        buildingIndex: 0,
        buildingName: drawnBuildingName || null,
        polygon,
        studs: [] as StudPoint[],
      };
      const newResult = { grids: [...(fetchResult?.grids ?? []), entry] };
      setFetchResult(newResult);
      const idx = newResult.grids.length - 1;
      setSelectedGridIdx(idx);
      setExits([]);
      setInteriorWalls([]);
      setHazardZones([]);
      setStairwells([]);
      setBlastSite(null);
      setPlantedItems([]);
      setActiveMode('select');
      setPhase('edit');
      setIsDrawing(false);
      if (!locationDescription) {
        setLocationDescription(drawnBuildingName || searchQuery || null);
      }

      if (polygon.length >= 3) {
        const verts = projectPolygon(polygon);
        const pts = generateWallPoints(polygon, verts);
        setWallPoints(pts);
      } else {
        setWallPoints([]);
      }
    },
    [fetchResult, drawnBuildingName, locationDescription, searchQuery],
  );

  const backToMap = useCallback(() => {
    setPhase('map');
    cancelAnimationFrame(rafRef.current);
    setActiveMode('select');
  }, []);

  // ── Wall inspection callbacks ──────────────────────────────────────────

  const handleWallPointClick = useCallback(async (wp: WallInspectionPoint) => {
    setActiveWallPoint(wp);

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
  }, []);

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
      };
      reader.readAsDataURL(file);
      e.target.value = '';
    },
    [activeWallPoint],
  );

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

  // ── Canvas interaction system (drag, pan, click, inspect) ────────────

  const dragStartRef = useRef<Vec2 | null>(null);
  const isDraggingRef = useRef(false);
  const elementDragRef = useRef<{ type: string; id: string } | null>(null);
  const mapPanRef = useRef<{ startX: number; startY: number } | null>(null);
  const wallDrawStartRef = useRef<Vec2 | null>(null);
  const hoverSimPosRef = useRef<Vec2 | null>(null);
  const renderOnceRef = useRef<() => void>(() => {});

  const [activeHazard, setActiveHazard] = useState<HazardZone | null>(null);
  const [activeWall, setActiveWall] = useState<InteriorWall | null>(null);

  const findDraggableAt = useCallback((sim: Vec2): { type: string; id: string } | null => {
    const bs = blastSiteRef.current;
    if (bs && Math.hypot(sim.x - bs.x, sim.y - bs.y) < 4) return { type: 'blastSite', id: 'blast' };
    for (const hz of hazardZonesRef.current) {
      if (Math.hypot(hz.pos.x - sim.x, hz.pos.y - sim.y) < Math.max(hz.radius, 8))
        return { type: 'hazard', id: hz.id };
    }
    for (const sw of stairwellsRef.current) {
      if (Math.hypot(sw.pos.x - sim.x, sw.pos.y - sim.y) < 5)
        return { type: 'stairwell', id: sw.id };
    }
    for (const iw of interiorWallsRef.current) {
      const dx = iw.end.x - iw.start.x;
      const dy = iw.end.y - iw.start.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < 0.01) continue;
      const t = Math.max(
        0,
        Math.min(1, ((sim.x - iw.start.x) * dx + (sim.y - iw.start.y) * dy) / len2),
      );
      const px = iw.start.x + t * dx;
      const py = iw.start.y + t * dy;
      if (Math.hypot(sim.x - px, sim.y - py) < 3) return { type: 'wall', id: iw.id };
    }
    // Zone center dragging (click near the zone center marker)
    const fallback = bs;
    if (fallback) {
      for (const gz of gameZonesRef.current) {
        const zc = gz.center ?? fallback;
        if (Math.hypot(zc.x - sim.x, zc.y - sim.y) < 8) return { type: 'zone', id: gz.type };
      }
    }
    return null;
  }, []);

  const applyElementDrag = useCallback(
    (drag: { type: string; id: string }, sim: Vec2) => {
      const snapped = snapToStud(sim);
      const sp = snapped.pos;
      const ctx = (snapped.stud?.spatialContext ?? undefined) as
        | 'inside_building'
        | 'road'
        | 'open_air'
        | undefined;
      if (drag.type === 'blastSite') {
        setBlastSite(sp);
        // Move zones that haven't been individually repositioned
        setGameZones((prev) => prev.map((gz) => (gz.center ? gz : { ...gz, center: sp })));
      } else if (drag.type === 'zone') {
        setGameZones((prev) =>
          prev.map((gz) => (gz.type === drag.id ? { ...gz, center: { ...sp } } : gz)),
        );
      } else if (drag.type === 'hazard')
        setHazardZones((prev) =>
          prev.map((h) =>
            h.id === drag.id
              ? {
                  ...h,
                  pos: { ...sp },
                  studId: snapped.stud?.id,
                  insideBuilding: ctx === 'inside_building',
                  spatialContext: ctx,
                }
              : h,
          ),
        );
      else if (drag.type === 'stairwell')
        setStairwells((prev) => prev.map((s) => (s.id === drag.id ? { ...s, pos: { ...sp } } : s)));
    },
    [snapToStud],
  );

  const handleCanvasMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || !renderCtxRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const sim = toSim(e.clientX - rect.left, e.clientY - rect.top);

      // In placement modes, don't start drag/pan
      if (activeMode !== 'select') return;

      // Check for a draggable element
      const hit = findDraggableAt(sim);
      if (hit) {
        elementDragRef.current = hit;
        isDraggingRef.current = false;
        dragStartRef.current = sim;
        return;
      }

      // Start map pan
      mapPanRef.current = { startX: e.clientX, startY: e.clientY };
      dragStartRef.current = sim;
      isDraggingRef.current = false;
    },
    [activeMode, toSim, findDraggableAt],
  );

  const handleCanvasMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!renderCtxRef.current) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const sim = toSim(e.clientX - rect.left, e.clientY - rect.top);
      hoverSimPosRef.current = sim;

      // Map panning — repaint canvas synchronously to eliminate 1-frame lag
      if (mapPanRef.current && !elementDragRef.current) {
        const map = leafletMapRef.current;
        if (map) {
          const dx = e.clientX - mapPanRef.current.startX;
          const dy = e.clientY - mapPanRef.current.startY;
          map.panBy([-dx, -dy], { animate: false });
          mapPanRef.current = { startX: e.clientX, startY: e.clientY };
          renderOnceRef.current();
        }
        isDraggingRef.current = true;
        return;
      }

      // Element dragging
      if (elementDragRef.current && dragStartRef.current) {
        const moved = Math.hypot(sim.x - dragStartRef.current.x, sim.y - dragStartRef.current.y);
        if (moved > 1) {
          isDraggingRef.current = true;
          applyElementDrag(elementDragRef.current, sim);
        }
      }
    },
    [toSim, applyElementDrag],
  );

  const handleCanvasMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      // End map pan
      if (mapPanRef.current && !elementDragRef.current) {
        const wasDragging = isDraggingRef.current;
        mapPanRef.current = null;
        dragStartRef.current = null;
        isDraggingRef.current = false;
        if (wasDragging) return;
        // Fall through to click handling if no actual drag happened
      }

      const canvas = canvasRef.current;
      if (!canvas || !renderCtxRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const sim = toSim(e.clientX - rect.left, e.clientY - rect.top);
      const snapped = snapToStud(sim);

      // Finalize element drag
      if (elementDragRef.current) {
        if (isDraggingRef.current) {
          applyElementDrag(elementDragRef.current, sim);
          elementDragRef.current = null;
          dragStartRef.current = null;
          isDraggingRef.current = false;
          return;
        }
        // No movement — treat as click on the element
        const clickedEl = elementDragRef.current;
        elementDragRef.current = null;
        dragStartRef.current = null;
        isDraggingRef.current = false;

        if (clickedEl.type === 'hazard') {
          const hz = hazardZones.find((h) => h.id === clickedEl.id);
          if (hz) {
            setActiveHazard(hz);
            return;
          }
        }
        if (clickedEl.type === 'wall') {
          const iw = interiorWalls.find((w) => w.id === clickedEl.id);
          if (iw) {
            setActiveWall(iw);
            return;
          }
        }
        if (clickedEl.type === 'blastSite') return;
        if (clickedEl.type === 'stairwell') return;
      }

      // Stud inspect mode
      if (studInspectMode) {
        const studs = simStudsRef.current;
        let nearest: StudPoint | null = null;
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
        return;
      }

      // Select mode: check wall points
      if (activeMode === 'select') {
        const hitWp = wallPoints.find(
          (wp) => Math.hypot(wp.simPos.x - sim.x, wp.simPos.y - sim.y) < 3.0,
        );
        if (hitWp) {
          handleWallPointClick(hitWp);
          return;
        }
      }

      // Placement modes
      if (activeMode === 'place_exit') {
        const snap = nearestEdge(snapped.pos.x, snapped.pos.y, projectedVerts);
        const w = 3;
        void edgeLength;
        const t = snap.t;
        const edge = projectedVerts[snap.edgeIndex];
        const next = projectedVerts[(snap.edgeIndex + 1) % projectedVerts.length];
        const cx2 = edge.x + (next.x - edge.x) * t;
        const cy2 = edge.y + (next.y - edge.y) * t;
        setExits((prev) => [
          ...prev,
          {
            id: `exit-${++exitIdCounter}`,
            center: { x: cx2, y: cy2 },
            width: w,
            edgeIndex: snap.edgeIndex,
            description: '',
            status: 'unknown' as const,
            photos: [],
          },
        ]);
        setActiveMode('select');
      } else if (activeMode === 'place_blast_site') {
        setBlastSite(snapped.pos);
        setActiveMode('select');
      } else if (activeMode.startsWith('place_hazard_')) {
        const ht = activeMode.replace('place_hazard_', '') as HazardType;
        setHazardZones((prev) => [
          ...prev,
          {
            id: `hz-${Date.now()}`,
            pos: snapped.pos,
            radius: 5,
            hazardType: ht,
            severity: 'medium',
            label: HAZARD_DEFS[ht]?.label || ht,
            description: '',
            photos: [],
            studId: snapped.stud?.id,
            insideBuilding: snapped.stud?.spatialContext === 'inside_building',
            spatialContext:
              (snapped.stud?.spatialContext as HazardZone['spatialContext']) ?? undefined,
          },
        ]);
        setActiveMode('select');
      } else if (activeMode === 'place_stairwell') {
        setStairwells((prev) => [
          ...prev,
          {
            id: `sw-${Date.now()}`,
            pos: snapped.pos,
            connectsFloors: [0, 1],
            blocked: false,
            label: `Stairwell ${prev.length + 1}`,
          },
        ]);
        setActiveMode('select');
      } else if (activeMode === 'draw_wall') {
        if (!wallDrawStartRef.current) {
          wallDrawStartRef.current = snapped.pos;
        } else {
          const start = wallDrawStartRef.current;
          setInteriorWalls((prev) => [
            ...prev,
            {
              id: `iw-${Date.now()}`,
              start,
              end: snapped.pos,
              hasDoor: false,
              doorWidth: 1.5,
              doorPosition: 0.5,
              description: '',
              material: '',
              photos: [],
              studId: snapped.stud?.id,
              insideBuilding: snapped.stud?.spatialContext === 'inside_building',
              spatialContext:
                (snapped.stud?.spatialContext as InteriorWall['spatialContext']) ?? undefined,
            },
          ]);
          wallDrawStartRef.current = null;
        }
      }
    },
    [
      activeMode,
      toSim,
      snapToStud,
      projectedVerts,
      wallPoints,
      handleWallPointClick,
      hazardZones,
      interiorWalls,
      applyElementDrag,
      studInspectMode,
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

  // ── Save scene to DB ──────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (!selectedGrid) return;
    setSaving(true);
    try {
      const config: SceneConfig = {
        buildingPolygon: selectedGrid.polygon,
        buildingName: selectedGrid.buildingName,
        centerLat: selectedGrid.polygon.reduce((s, p) => s + p[0], 0) / selectedGrid.polygon.length,
        centerLng: selectedGrid.polygon.reduce((s, p) => s + p[1], 0) / selectedGrid.polygon.length,
        exits,
        interiorWalls,
        hazardZones,
        stairwells,
        blastSite,
        blastRadius,
        wallInspectionPoints: wallPoints,
        plantedItems,
        pedestrianCount,
        weaponType: localWeaponType || null,
        locationDescription,
      };

      const enrichedBlastSite = blastSite
        ? {
            ...blastSite,
            radius: blastRadius,
            weaponType: localWeaponType || null,
            gameZones,
            locationDescription,
          }
        : null;
      const exitsWithPos = exits.map((e) => ({ ...e, pos: e.center }));

      if (sceneConfigId) {
        await updateSceneConfig(sceneConfigId, {
          exits: exitsWithPos,
          interiorWalls,
          hazardZones,
          stairwells,
          blastSite: enrichedBlastSite,
          wallInspectionPoints: wallPoints,
          plantedItems,
          pedestrianCount,
        });
        onSave(sceneConfigId, config);
      } else {
        const result = await createSceneConfig({
          name: selectedGrid.buildingName || 'Scene',
          buildingPolygon: selectedGrid.polygon,
          buildingName: selectedGrid.buildingName || undefined,
          centerLat: config.centerLat,
          centerLng: config.centerLng,
          exits: exitsWithPos,
          interiorWalls,
          hazardZones,
          stairwells,
          blastSite: enrichedBlastSite,
          casualtyClusters: [],
          wallInspectionPoints: wallPoints,
          plantedItems,
          pedestrianCount,
        });
        const newId = result.id;
        setSceneConfigId(newId);
        onSave(newId, config);
      }
    } catch (err) {
      console.error('Failed to save scene', err);
    } finally {
      setSaving(false);
    }
  }, [
    selectedGrid,
    exits,
    interiorWalls,
    hazardZones,
    stairwells,
    blastSite,
    blastRadius,
    wallPoints,
    plantedItems,
    pedestrianCount,
    localWeaponType,
    gameZones,
    locationDescription,
    sceneConfigId,
    onSave,
  ]);

  // ── Canvas resize ─────────────────────────────────────────────────────

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) setCanvasSize({ w: Math.round(width), h: Math.round(height) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Render loop (reads refs so it always paints current state) ────────

  const selectedGridRef = useRef(selectedGrid);
  selectedGridRef.current = selectedGrid;
  const projectedVertsRef = useRef(projectedVerts);
  projectedVertsRef.current = projectedVerts;

  const renderOnce = useCallback((): void => {
    const grid = selectedGridRef.current;
    const verts = projectedVertsRef.current;
    if (!grid || verts.length < 3) return;

    const map = leafletMapRef.current;
    if (map) {
      renderCtxRef.current = computeMapRenderContext(map, grid.polygon, verts);
    }
    const canvas = canvasRef.current;
    // Sync canvas buffer to match its actual display size
    if (canvas) {
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      if (cw > 0 && ch > 0 && (canvas.width !== cw || canvas.height !== ch)) {
        canvas.width = cw;
        canvas.height = ch;
      }
    }
    const rc = renderCtxRef.current;
    if (canvas && rc) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const planted = new Set(plantedItemsRef.current.map((p) => p.wallPointId));
        const state = createInitialGameState();
        const studs = simStudsRef.current;
        const blast = blastSiteRef.current;
        renderRTS(
          ctx,
          canvas.width,
          canvas.height,
          rc,
          state,
          verts,
          exitsRef.current,
          [],
          true,
          wallPointsRef.current,
          activeWallPointRef.current?.id ?? null,
          planted,
          new Set(),
          [],
          null,
          [],
          null,
          interiorWallsRef.current,
          hazardZonesRef.current,
          stairwellsRef.current,
          blast,
          blast ? gameZonesRef.current : undefined,
          wallDrawStartRef.current
            ? {
                start: wallDrawStartRef.current,
                cursor: hoverSimPosRef.current ?? wallDrawStartRef.current,
              }
            : null,
          null,
          studs.length > 0 ? studs : null,
          null,
          blastRadiusRef.current,
          true,
          true,
        );
      }
    }
  }, []);
  renderOnceRef.current = renderOnce;

  const renderLoop = useCallback(() => {
    renderOnce();
    rafRef.current = requestAnimationFrame(renderLoop);
  }, [renderOnce]);

  useEffect(() => {
    if (phase !== 'edit' || !selectedGrid || projectedVerts.length < 3) return;
    rafRef.current = requestAnimationFrame(renderLoop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase, selectedGrid, projectedVerts, renderLoop]);

  const setLeafletMap = useCallback((m: L.Map) => {
    leafletMapRef.current = m;
  }, []);

  // ── Map phase: sync map to lat/lng ────────────────────────────────────

  const mapPhaseLat = lat ? parseFloat(lat) : 1.2989;
  const mapPhaseLng = lng ? parseFloat(lng) : 103.855;

  const setMapPhaseMap = useCallback((m: L.Map) => {
    mapPhaseMapRef.current = m;
  }, []);

  // ── RENDER ────────────────────────────────────────────────────────────

  // Map phase: search and select building with map
  if (phase === 'map') {
    return (
      <div className="flex flex-col md:flex-row h-full gap-2 md:gap-3">
        {/* Controls panel: scrollable strip above map on narrow, sidebar on wide */}
        <div className="w-full md:w-80 flex-shrink-0 flex flex-col gap-2 md:gap-3 overflow-y-auto max-h-[40vh] md:max-h-none">
          {/* GPS status */}
          {!lat && !lng && (
            <div className="px-3 py-2 bg-cyan-900/20 border border-cyan-500/30 text-xs terminal-text text-cyan-400 animate-pulse">
              Locating you...
            </div>
          )}

          {/* Country dropdown */}
          <div>
            <label className="text-[10px] terminal-text text-robotic-yellow/40 uppercase">
              Country
            </label>
            <select
              value={searchCountry}
              onChange={(e) => setSearchCountry(e.target.value)}
              className="w-full mt-0.5 px-2 py-2 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow terminal-text text-sm"
            >
              <option value="">All Countries</option>
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

          {/* Search input (debounced) */}
          <div className="relative">
            <label className="text-[10px] terminal-text text-robotic-yellow/40 uppercase">
              Search Place
            </label>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => handleSearchInput(e.target.value)}
              placeholder="Type to search (3+ chars)..."
              className="w-full mt-0.5 px-3 py-2 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow terminal-text text-sm"
            />
            {searchOpen && searchResults.length > 0 && (
              <div className="absolute z-20 bg-gray-900 border border-robotic-yellow/50 rounded mt-1 max-h-48 overflow-y-auto w-full">
                {searchResults.map((r, i) => (
                  <button
                    key={i}
                    onClick={() => handleSelectResult(r)}
                    className="block w-full text-left px-3 py-2 text-xs terminal-text text-robotic-yellow/70 hover:bg-robotic-yellow/10 border-b border-robotic-gray-200 last:border-b-0"
                  >
                    {r.display_name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Lat / Lng / Radius */}
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-[10px] terminal-text text-robotic-yellow/40">Lat</label>
              <input
                value={lat}
                onChange={(e) => setLat(e.target.value)}
                className="w-full px-2 py-2 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow terminal-text text-sm"
              />
            </div>
            <div className="flex-1">
              <label className="text-[10px] terminal-text text-robotic-yellow/40">Lng</label>
              <input
                value={lng}
                onChange={(e) => setLng(e.target.value)}
                className="w-full px-2 py-2 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow terminal-text text-sm"
              />
            </div>
            <div className="w-16">
              <label className="text-[10px] terminal-text text-robotic-yellow/40">Radius</label>
              <input
                value={radius}
                onChange={(e) => setRadius(e.target.value)}
                className="w-full px-2 py-2 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow terminal-text text-sm"
              />
            </div>
          </div>

          {/* Drawing mode status */}
          {isDrawing ? (
            <div className="space-y-3">
              <div className="px-3 py-2 bg-amber-900/20 border border-amber-500/30 text-xs terminal-text text-amber-400">
                Click on the map to place vertices. Close the polygon by clicking the first vertex
                or press Enter. ESC to cancel.
              </div>
              <div>
                <label className="text-[10px] terminal-text text-robotic-yellow/40 uppercase">
                  Building Name (optional)
                </label>
                <input
                  type="text"
                  value={drawnBuildingName}
                  onChange={(e) => setDrawnBuildingName(e.target.value)}
                  placeholder="e.g. San Pedro Cathedral"
                  className="w-full mt-0.5 px-3 py-2 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow terminal-text text-sm"
                />
              </div>
              <button
                onClick={() => {
                  setIsDrawing(false);
                  setDrawnBuildingName('');
                }}
                className="w-full px-4 py-2 text-xs terminal-text border border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50"
              >
                Cancel Drawing
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <button
                onClick={handleFetch}
                disabled={fetchLoading || !lat || !lng}
                className="military-button w-full px-4 py-2 text-xs disabled:opacity-50"
              >
                {fetchLoading ? 'Fetching Buildings...' : 'Fetch Buildings'}
              </button>

              <div className="flex items-center gap-2">
                <div className="flex-1 border-t border-robotic-gray-200" />
                <span className="text-[10px] terminal-text text-robotic-yellow/30 uppercase">
                  or
                </span>
                <div className="flex-1 border-t border-robotic-gray-200" />
              </div>

              <button
                onClick={() => setIsDrawing(true)}
                className="w-full px-4 py-2 text-xs terminal-text border border-cyan-500/50 text-cyan-400 hover:bg-cyan-900/20 hover:border-cyan-400"
              >
                Draw Building on Map
              </button>

              <button
                onClick={() => {
                  setIsAutoTracing(true);
                  setAutoTracePreview(null);
                  setAutoTraceStatus('Click on a building on the map to auto-trace its outline.');
                }}
                className="w-full px-4 py-2 text-xs terminal-text border border-purple-500/50 text-purple-400 hover:bg-purple-900/20 hover:border-purple-400"
              >
                Auto-Trace Building (Magic Wand)
              </button>
            </div>
          )}

          {/* Auto-trace mode UI */}
          {isAutoTracing && (
            <div className="space-y-3">
              {autoTraceStatus && (
                <div
                  className={`px-3 py-2 text-xs terminal-text border rounded ${
                    autoTraceStatus === 'Tracing...'
                      ? 'bg-purple-900/20 border-purple-500/30 text-purple-400 animate-pulse'
                      : autoTraceStatus.includes('No building') ||
                          autoTraceStatus.includes('failed') ||
                          autoTraceStatus.includes('Could not')
                        ? 'bg-red-900/20 border-red-500/30 text-red-400'
                        : 'bg-purple-900/20 border-purple-500/30 text-purple-400'
                  }`}
                >
                  {autoTraceStatus}
                </div>
              )}

              <div>
                <label className="text-[10px] terminal-text text-robotic-yellow/40 uppercase">
                  Color Tolerance: {autoTraceTolerance}
                </label>
                <input
                  type="range"
                  min={10}
                  max={40}
                  value={autoTraceTolerance}
                  onChange={(e) => setAutoTraceTolerance(Number(e.target.value))}
                  className="w-full"
                />
                <div className="flex justify-between text-[9px] terminal-text text-robotic-yellow/20">
                  <span>Tight</span>
                  <span>Loose</span>
                </div>
              </div>

              {autoTracePreview && autoTracePreview.length >= 3 && (
                <div className="space-y-2">
                  <p className="text-xs terminal-text text-purple-400">
                    Traced {autoTracePreview.length} vertices. Accept or retry.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        handleDrawComplete(autoTracePreview);
                        setIsAutoTracing(false);
                        setAutoTracePreview(null);
                        setAutoTraceStatus(null);
                      }}
                      className="flex-1 military-button px-3 py-2 text-xs"
                    >
                      Accept
                    </button>
                    <button
                      onClick={() => {
                        setAutoTracePreview(null);
                        setAutoTraceStatus('Click on a building to trace again.');
                      }}
                      className="flex-1 px-3 py-2 text-xs terminal-text border border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50"
                    >
                      Retry
                    </button>
                  </div>
                </div>
              )}

              <button
                onClick={() => {
                  setIsAutoTracing(false);
                  setAutoTracePreview(null);
                  setAutoTraceStatus(null);
                }}
                className="w-full px-4 py-2 text-xs terminal-text border border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50"
              >
                Cancel Auto-Trace
              </button>
            </div>
          )}

          {error && <p className="text-xs text-red-400">{error}</p>}

          {/* Building results list */}
          {!isDrawing && fetchResult && (
            <div className="space-y-2">
              <p className="text-xs terminal-text text-robotic-yellow/50">
                {fetchResult.grids.length} buildings found. Select one:
              </p>
              <div className="space-y-1 max-h-60 overflow-y-auto">
                {fetchResult.grids.map((g, i) => (
                  <button
                    key={i}
                    onClick={() => selectBuilding(i)}
                    className="w-full text-left px-3 py-2 border border-robotic-yellow/30 hover:border-robotic-yellow text-xs terminal-text text-robotic-yellow/70 hover:text-robotic-yellow bg-black/30 hover:bg-black/50"
                  >
                    <div className="font-bold">{g.buildingName || `Building ${i + 1}`}</div>
                    <div className="text-[10px] text-robotic-yellow/40">
                      {g.polygon.length} vertices
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Map: full-width below controls on portrait, right sidebar on landscape */}
        <div className="flex-1 relative rounded overflow-hidden border border-robotic-gray-200 min-h-[250px]">
          <MapContainer
            center={[mapPhaseLat, mapPhaseLng]}
            zoom={16}
            style={{ width: '100%', height: '100%' }}
            zoomControl={true}
          >
            <TileLayer
              attribution="&copy; OSM"
              url={`${(import.meta.env.VITE_API_URL || '').replace(/\/$/, '')}/api/tiles/{z}/{x}/{y}.png`}
              maxNativeZoom={19}
              maxZoom={22}
              crossOrigin="anonymous"
            />
            <MapRefSync onMap={setMapPhaseMap} />
            <FlyToPoint lat={mapPhaseLat} lng={mapPhaseLng} zoom={19} />

            {/* Green dot + radius coverage circle */}
            {lat && lng && (
              <>
                <Circle
                  center={[parseFloat(lat), parseFloat(lng)]}
                  radius={parseFloat(radius) || 300}
                  pathOptions={{
                    color: '#22c55e',
                    weight: 1,
                    fillColor: '#22c55e',
                    fillOpacity: 0.08,
                    dashArray: '6 4',
                  }}
                />
                <CircleMarker
                  center={[parseFloat(lat), parseFloat(lng)]}
                  radius={8}
                  pathOptions={{
                    color: '#22c55e',
                    fillColor: '#22c55e',
                    fillOpacity: 0.6,
                    weight: 2,
                  }}
                />
              </>
            )}

            {/* Render building polygons when fetched */}
            {fetchResult?.grids.map((g, i) => (
              <Polygon
                key={i}
                positions={g.polygon.map(([la, ln]) => [la, ln] as [number, number])}
                pathOptions={{
                  color: '#f59e0b',
                  weight: 2,
                  fillColor: '#f59e0b',
                  fillOpacity: 0.15,
                }}
                eventHandlers={{
                  click: () => selectBuilding(i),
                }}
              />
            ))}

            {/* Draw building polygon handler */}
            <BuildingDrawHandler
              active={isDrawing}
              onComplete={handleDrawComplete}
              onCancel={() => {
                setIsDrawing(false);
                setDrawnBuildingName('');
              }}
            />

            {/* Auto-trace click handler */}
            <AutoTraceClickHandler
              active={isAutoTracing && !autoTracePreview}
              tolerance={autoTraceTolerance}
              onResult={(polygon) => setAutoTracePreview(polygon)}
              onStatus={setAutoTraceStatus}
            />

            {/* Auto-trace preview polygon */}
            {autoTracePreview && autoTracePreview.length >= 3 && (
              <Polygon
                positions={autoTracePreview.map(([la, ln]) => [la, ln] as [number, number])}
                pathOptions={{
                  color: '#a855f7',
                  weight: 3,
                  fillColor: '#a855f7',
                  fillOpacity: 0.2,
                  dashArray: '8, 4',
                }}
              />
            )}
          </MapContainer>
        </div>
      </div>
    );
  }

  // Edit phase: scene tools + canvas
  const centerLat = selectedGrid
    ? selectedGrid.polygon.reduce((s, p) => s + p[0], 0) / selectedGrid.polygon.length
    : 0;
  const centerLng = selectedGrid
    ? selectedGrid.polygon.reduce((s, p) => s + p[1], 0) / selectedGrid.polygon.length
    : 0;

  return (
    <div className="flex flex-col lg:flex-row h-full gap-3">
      {/* Tools panel: top on portrait/narrow, left on landscape/wide */}
      <div className="w-full lg:w-56 overflow-y-auto lg:overflow-x-visible space-y-2 flex-shrink-0 max-h-[35vh] lg:max-h-none">
        <button
          onClick={backToMap}
          className="w-full text-xs terminal-text text-robotic-yellow/50 hover:text-robotic-yellow border border-robotic-gray-200 px-2 py-1"
        >
          &larr; Back to Map
        </button>

        <div className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-1">
          Scene Tools
        </div>

        <button
          onClick={() => setActiveMode('place_exit')}
          className={`w-full text-left text-xs px-2 py-1.5 border rounded ${activeMode === 'place_exit' ? 'border-cyan-400 bg-cyan-900/30 text-cyan-300' : 'border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50'}`}
        >
          Place Exit
        </button>
        <button
          onClick={() => setActiveMode('place_blast_site')}
          className={`w-full text-left text-xs px-2 py-1.5 border rounded ${activeMode === 'place_blast_site' ? 'border-red-400 bg-red-900/30 text-red-300' : 'border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50'}`}
        >
          Blast Site {blastSite ? '(replace)' : ''}
        </button>
        <button
          onClick={() => setActiveMode('place_stairwell')}
          className={`w-full text-left text-xs px-2 py-1.5 border rounded ${activeMode === 'place_stairwell' ? 'border-cyan-400 bg-cyan-900/30 text-cyan-300' : 'border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50'}`}
        >
          Place Stairwell
        </button>
        <button
          onClick={() => {
            if (activeMode === 'draw_wall') {
              setActiveMode('select');
              wallDrawStartRef.current = null;
            } else {
              setActiveMode('draw_wall');
              wallDrawStartRef.current = null;
            }
          }}
          className={`w-full text-left text-xs px-2 py-1.5 border rounded ${activeMode === 'draw_wall' ? 'border-cyan-400 bg-cyan-900/30 text-cyan-300' : 'border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50'}`}
        >
          Draw Interior Wall{' '}
          {activeMode === 'draw_wall' && wallDrawStartRef.current
            ? '(click end point)'
            : '(click start → end)'}
        </button>

        <div className="text-xs text-robotic-yellow/50 mt-2">Hazards:</div>
        {(Object.keys(HAZARD_DEFS) as HazardType[]).map((ht) => (
          <button
            key={ht}
            onClick={() => setActiveMode(`place_hazard_${ht}`)}
            className={`w-full text-left text-xs px-2 py-1 border rounded ${activeMode === `place_hazard_${ht}` ? 'border-cyan-400 bg-cyan-900/30' : 'border-robotic-gray-200 hover:border-robotic-yellow/50'}`}
            style={{ color: HAZARD_DEFS[ht].color }}
          >
            {HAZARD_DEFS[ht].icon} {HAZARD_DEFS[ht].label}
          </button>
        ))}

        {blastSite && (
          <div className="border-t border-robotic-gray-200 pt-2 mt-2 space-y-2">
            <label className="text-[10px] terminal-text text-robotic-yellow/40">
              Blast Radius (m)
            </label>
            <input
              type="range"
              min={5}
              max={100}
              value={blastRadius}
              onChange={(e) => setBlastRadius(Number(e.target.value))}
              className="w-full"
            />
            <div className="text-xs terminal-text text-robotic-yellow/50 text-center">
              {blastRadius}m
            </div>

            <label className="text-[10px] terminal-text text-robotic-yellow/40 block mt-2">
              Weapon / Chemical Type
            </label>
            <select
              value={localWeaponType}
              onChange={(e) => {
                setLocalWeaponType(e.target.value);
                onWeaponTypeChange?.(e.target.value);
              }}
              className="w-full px-2 py-1 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow text-xs"
            >
              <option value="">-- Select or type below --</option>
              <option value="ied_pipe_bomb">IED / Pipe Bomb</option>
              <option value="car_bomb_anfo">Car Bomb (ANFO)</option>
              <option value="suicide_vest">Suicide Vest</option>
              <option value="pressure_cooker">Pressure Cooker Bomb</option>
              <option value="propane_ied">Propane IED</option>
              <option value="c4_military">C4 / Military Explosive</option>
              <option value="fertilizer_bomb">Fertilizer Bomb</option>
              <option value="chemical_sarin">Chemical (Sarin)</option>
              <option value="chemical_chlorine">Chemical (Chlorine Gas)</option>
              <option value="chemical_unknown">Chemical (Unknown Agent)</option>
            </select>
            <input
              type="text"
              value={localWeaponType}
              onChange={(e) => {
                setLocalWeaponType(e.target.value);
                onWeaponTypeChange?.(e.target.value);
              }}
              placeholder="Or type custom weapon/chemical..."
              className="w-full px-2 py-1 bg-black/50 border border-robotic-yellow/30 text-robotic-yellow text-[10px]"
            />

            <div className="mt-3">
              <div className="text-[10px] terminal-text text-robotic-yellow/40 uppercase mb-1">
                Operational Zones
                <span className="normal-case ml-1 text-robotic-yellow/20">
                  (drag center on map)
                </span>
              </div>
              {gameZones.map((zone, i) => {
                const colors: Record<string, string> = {
                  hot: '#ef4444',
                  warm: '#f97316',
                  cold: '#eab308',
                };
                return (
                  <div key={zone.type} className="mb-2">
                    <div className="flex items-center gap-2">
                      <span
                        className="text-[10px] terminal-text w-10"
                        style={{ color: colors[zone.type] || '#aaa' }}
                      >
                        {zone.type.toUpperCase()}
                      </span>
                      <input
                        type="range"
                        min={5}
                        max={200}
                        value={zone.radius}
                        onChange={(e) => {
                          const newZones = [...gameZones];
                          newZones[i] = { ...zone, radius: Number(e.target.value) };
                          setGameZones(newZones);
                        }}
                        className="flex-1"
                      />
                      <span className="text-[10px] terminal-text text-robotic-yellow/50 w-10 text-right">
                        {zone.radius}m
                      </span>
                    </div>
                    {zone.center && (
                      <button
                        onClick={() => {
                          const newZones = [...gameZones];
                          newZones[i] = { ...zone, center: undefined };
                          setGameZones(newZones);
                        }}
                        className="text-[9px] terminal-text text-robotic-yellow/30 hover:text-robotic-yellow/60 mt-0.5 ml-12"
                      >
                        Reset to blast center
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="border-t border-robotic-gray-200 pt-2 mt-2">
          <label className="text-[10px] terminal-text text-robotic-yellow/40">Pedestrians</label>
          <input
            type="number"
            min={10}
            max={5000}
            value={pedestrianCount}
            onChange={(e) => setPedestrianCount(Number(e.target.value))}
            className="w-full px-2 py-1 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow text-xs"
          />
        </div>

        <div className="border-t border-robotic-gray-200 pt-2 mt-2">
          <div className="text-[10px] terminal-text text-robotic-yellow/40 mb-1">Stats</div>
          <div className="text-[10px] terminal-text text-robotic-yellow/30 space-y-0.5">
            <div>Exits: {exits.length}</div>
            <div>Walls: {interiorWalls.length}</div>
            <div>Hazards: {hazardZones.length}</div>
            <div>Stairs: {stairwells.length}</div>
            <div>Wall Points: {wallPoints.length}</div>
            <div>Devices: {plantedItems.length}</div>
            <div>Studs: {simStuds.length}</div>
          </div>
        </div>

        <div className="border-t border-robotic-gray-200 pt-2 mt-2">
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
            <div className="bg-gray-950 border border-cyan-800 rounded p-2 text-xs space-y-0.5 mt-2">
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
                Sim: ({inspectedStud.simPos.x.toFixed(1)}, {inspectedStud.simPos.y.toFixed(1)})
              </div>
              {(() => {
                const inZones = hazardZones.filter(
                  (h) =>
                    Math.hypot(
                      h.pos.x - inspectedStud!.simPos.x,
                      h.pos.y - inspectedStud!.simPos.y,
                    ) <= h.radius,
                );
                if (inZones.length === 0)
                  return <div className="text-gray-600 italic">No fuel (no hazard zone)</div>;
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

        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full mt-2 bg-blue-800 hover:bg-blue-700 disabled:opacity-50 text-blue-100 text-xs px-3 py-1.5 rounded border border-blue-600"
        >
          {saving ? 'Saving...' : sceneConfigId ? 'Update Scene' : 'Save Scene'}
        </button>
        {sceneConfigId && (
          <div className="text-xs text-blue-500 mt-0.5">Saved: {sceneConfigId.slice(0, 8)}...</div>
        )}
      </div>

      {/* Map + Canvas: below on portrait/narrow, right on landscape/wide */}
      <div
        className="flex-1 relative overflow-hidden rounded border border-robotic-gray-200 min-h-[350px]"
        ref={containerRef}
      >
        <MapContainer
          center={[centerLat, centerLng]}
          zoom={19}
          maxZoom={22}
          style={{ height: '100%', width: '100%' }}
          doubleClickZoom={false}
        >
          <TileLayer
            attribution="&copy; OSM"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            maxNativeZoom={19}
            maxZoom={22}
          />
          <MapRefSync onMap={setLeafletMap} />
          {selectedGrid && <FitBounds polygon={selectedGrid.polygon} />}
          {selectedGrid && (
            <Polygon
              positions={selectedGrid.polygon.map(([la, ln]) => [la, ln] as [number, number])}
              pathOptions={{ color: '#22d3ee', weight: 2, fillOpacity: 0 }}
            />
          )}
        </MapContainer>
        <canvas
          ref={canvasRef}
          width={canvasSize.w}
          height={canvasSize.h}
          onMouseDown={handleCanvasMouseDown}
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={handleCanvasMouseUp}
          onWheel={handleCanvasWheel}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'auto',
            zIndex: 1000,
            touchAction: 'none',
            cursor: activeMode !== 'select' ? 'crosshair' : 'grab',
          }}
        />
        {activeMode !== 'select' && (
          <div
            className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/70 rounded px-3 py-1 text-xs text-robotic-yellow pointer-events-none"
            style={{ zIndex: 1001 }}
          >
            Click map to place — ESC or click a tool to cancel
          </div>
        )}

        {/* Floating wall inspection / photo viewer panel */}
        {activeWallPoint && (
          <div
            className="absolute top-4 right-4 w-[400px] bg-gray-900/95 border border-cyan-700 rounded-lg shadow-2xl overflow-hidden"
            style={{ zIndex: 1002 }}
          >
            {/* Header */}
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
            <div className="relative bg-black" style={{ minHeight: 180 }}>
              {wallPointLoading && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="text-cyan-400 text-xs animate-pulse">Loading Street View...</div>
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
                <div className="flex flex-col items-center justify-center h-44 text-xs text-gray-500 px-4 text-center">
                  {GOOGLE_MAPS_KEY ? (
                    <>
                      <span className="text-gray-400 mb-1">
                        No outdoor Street View coverage here
                      </span>
                      <span className="text-gray-600">Upload a photo or try a nearby point.</span>
                    </>
                  ) : (
                    'Set VITE_GOOGLE_MAPS_API_KEY to enable Street View'
                  )}
                </div>
              )}
            </div>

            {/* Upload / replace photo */}
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
                id="se-photo-gallery-input"
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handlePhotoUpload}
              />
              <button
                onClick={() => photoUploadRef.current?.click()}
                className="bg-amber-800 hover:bg-amber-700 text-amber-100 text-xs px-3 py-1 rounded border border-amber-600"
              >
                Take Photo
              </button>
              <button
                onClick={() => document.getElementById('se-photo-gallery-input')?.click()}
                className="bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs px-3 py-1 rounded border border-gray-600"
              >
                Gallery
              </button>
              <span className="text-xs text-gray-600">
                {activeWallPoint.imageSource === 'custom'
                  ? 'Custom'
                  : activeWallPoint.imageSource === 'streetview'
                    ? 'Street View'
                    : 'None'}
              </span>
            </div>

            {/* Coordinates */}
            <div className="px-3 py-1.5 text-xs text-gray-500 border-t border-gray-800 flex gap-3">
              <span>
                Wall: {activeWallPoint.lat.toFixed(6)}, {activeWallPoint.lng.toFixed(6)}
              </span>
              <span>Heading: {Math.round(activeWallPoint.heading)}°</span>
            </div>

            {/* Plant threat section */}
            <div className="px-3 py-2 border-t border-red-900/50 bg-red-950/20">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs text-red-400 font-bold">Plant Threat (Trainer)</label>
                {plantedItems.filter((p) => p.wallPointId === activeWallPoint.id).length > 0 && (
                  <span className="text-xs text-red-300 bg-red-900/40 px-1.5 py-0.5 rounded">
                    {plantedItems.filter((p) => p.wallPointId === activeWallPoint.id).length}{' '}
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
                placeholder="Describe what is hidden here — e.g. 'Pipe bomb concealed inside the green recycling bin'"
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
                <button
                  onClick={handlePlantItem}
                  disabled={!plantDescription.trim()}
                  className="bg-red-800 hover:bg-red-700 disabled:opacity-30 text-white text-xs px-3 py-1 rounded border border-red-600"
                >
                  Plant
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Floating hazard inspector panel (full) */}
        {activeHazard && (
          <div
            className="absolute top-4 bg-gray-900/95 border border-orange-700 rounded-lg shadow-2xl overflow-hidden"
            style={{
              zIndex: 1002,
              left: 16,
              width: 380,
              maxHeight: 'calc(100% - 32px)',
              overflowY: 'auto',
            }}
          >
            <div className="flex items-center justify-between px-3 py-2 bg-orange-900/40 border-b border-orange-800">
              <div
                className="text-xs font-bold"
                style={{
                  color: HAZARD_DEFS[activeHazard.hazardType as HazardType]?.color || '#f97316',
                }}
              >
                {HAZARD_DEFS[activeHazard.hazardType as HazardType]?.icon}{' '}
                {activeHazard.label || activeHazard.hazardType}
              </div>
              <button
                onClick={() => setActiveHazard(null)}
                className="text-gray-400 hover:text-white text-sm px-1"
              >
                ✕
              </button>
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
                    prev.map((h) => (h.id === activeHazard.id ? { ...h, description: desc } : h)),
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
                        setActiveHazard((prev) => (prev ? { ...prev, photos: updated } : prev));
                      };
                      reader.readAsDataURL(file);
                      e.target.value = '';
                    }}
                  />
                  <button
                    onClick={() => hazardPhotoRef.current?.click()}
                    className="bg-orange-800 hover:bg-orange-700 text-orange-100 text-xs px-2 py-0.5 rounded border border-orange-600"
                  >
                    Take Photo
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
                          setActiveHazard((prev) => (prev ? { ...prev, photos: updated } : prev));
                        };
                        reader.readAsDataURL(file);
                      };
                      input.click();
                    }}
                    className="bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs px-2 py-0.5 rounded border border-gray-600"
                  >
                    Gallery
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
                        setActiveHazard((prev) => (prev ? { ...prev, photos: updated } : prev));
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

        {/* Floating interior wall panel */}
        {activeWall && (
          <div
            className="absolute bottom-4 left-4 w-[340px] bg-gray-900/95 border border-slate-600 rounded-lg shadow-2xl overflow-hidden"
            style={{ zIndex: 1002 }}
          >
            <div className="flex items-center justify-between px-3 py-2 bg-slate-800/80 border-b border-slate-700">
              <div className="text-xs text-slate-300 font-bold">
                Interior Wall — {activeWall.id}
              </div>
              <button
                onClick={() => setActiveWall(null)}
                className="text-gray-400 hover:text-white text-sm px-1"
              >
                ✕
              </button>
            </div>

            {/* Length */}
            <div className="px-3 py-1.5 text-xs text-gray-400 border-b border-gray-800">
              Length:{' '}
              {Math.hypot(
                activeWall.end.x - activeWall.start.x,
                activeWall.end.y - activeWall.start.y,
              ).toFixed(1)}
              m
            </div>

            {/* Material dropdown */}
            <div className="px-3 py-2 border-b border-gray-800">
              <label className="block text-xs text-slate-400 mb-1">Material</label>
              <select
                value={activeWall.material}
                onChange={(e) => {
                  const mat = e.target.value;
                  setInteriorWalls((prev) =>
                    prev.map((w) => (w.id === activeWall.id ? { ...w, material: mat } : w)),
                  );
                  setActiveWall((prev) => (prev ? { ...prev, material: mat } : prev));
                }}
                className="w-full bg-gray-800 border border-slate-700 text-slate-300 text-xs rounded px-2 py-1"
              >
                <option value="">-- Select material --</option>
                <option value="concrete">Concrete</option>
                <option value="brick">Brick</option>
                <option value="drywall">Drywall / Gypsum</option>
                <option value="cinder_block">Cinder Block</option>
                <option value="glass">Glass</option>
                <option value="metal">Metal / Steel</option>
                <option value="wood">Wood</option>
                <option value="plywood">Plywood / Partition</option>
                <option value="stone">Stone / Masonry</option>
                <option value="reinforced_concrete">Reinforced Concrete</option>
              </select>
            </div>

            {/* Description */}
            <div className="px-3 py-2 border-b border-gray-800">
              <label className="block text-xs text-slate-400 mb-1">Description</label>
              <textarea
                value={activeWall.description}
                onChange={(e) => {
                  const desc = e.target.value;
                  setInteriorWalls((prev) =>
                    prev.map((w) => (w.id === activeWall.id ? { ...w, description: desc } : w)),
                  );
                  setActiveWall((prev) => (prev ? { ...prev, description: desc } : prev));
                }}
                placeholder="Describe the wall — load-bearing, partial, damaged, etc."
                className="w-full bg-gray-800 border border-gray-700 text-slate-300 text-xs rounded px-2 py-1.5 resize-none focus:border-slate-500 focus:outline-none"
                rows={2}
              />
            </div>

            {/* Has door toggle */}
            <div className="px-3 py-2 border-b border-gray-800 flex items-center gap-2">
              <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={activeWall.hasDoor}
                  onChange={(e) => {
                    const val = e.target.checked;
                    setInteriorWalls((prev) =>
                      prev.map((w) => (w.id === activeWall.id ? { ...w, hasDoor: val } : w)),
                    );
                    setActiveWall((prev) => (prev ? { ...prev, hasDoor: val } : prev));
                  }}
                  className="rounded border-slate-600"
                />
                Has a door / opening
              </label>
            </div>

            {/* Delete wall */}
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
      </div>
    </div>
  );
}
