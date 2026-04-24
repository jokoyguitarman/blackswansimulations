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
import { MapContainer, TileLayer, Polygon, useMap } from 'react-leaflet';
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
import { generateWallPoints, type WallInspectionPoint } from '../../lib/rts/wallInspection';
import { createSceneConfig, updateSceneConfig } from '../../lib/rts/sceneConfigApi';
import 'leaflet/dist/leaflet.css';

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
  spatialContext: string | null;
}

function generateStudsForPolygon(polygon: [number, number][], verts: Vec2[]): StudPoint[] {
  if (polygon.length < 3) return [];
  const SPACING = 3;
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
  const dLat = SPACING / 111_320;
  const dLng = SPACING / (111_320 * Math.cos((midLat * Math.PI) / 180));
  const refLat = polygon.reduce((s, p) => s + p[0], 0) / polygon.length;
  const refLng = polygon.reduce((s, p) => s + p[1], 0) / polygon.length;
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos((refLat * Math.PI) / 180);

  const studs: StudPoint[] = [];
  let idx = 0;
  for (let la = minLat; la <= maxLat; la += dLat) {
    for (let ln = minLng; ln <= maxLng; ln += dLng) {
      if (pointInPoly(la, ln, polygon)) {
        studs.push({
          id: `stud-${idx++}`,
          lat: la,
          lng: ln,
          simPos: {
            x: (ln - refLng) * mPerDegLng,
            y: (refLat - la) * mPerDegLat,
          },
          spatialContext: 'inside_building',
        });
      }
    }
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

// ── Main Component ────────────────────────────────────────────────────────

let exitIdCounter = 1000;

export function SceneEditor({
  incidentType,
  onSave,
  initialSceneId,
  weaponType: externalWeaponType,
  onWeaponTypeChange,
}: SceneEditorProps) {
  // Phase: 'map' (searching) or 'edit' (scene editing)
  const [phase, setPhase] = useState<'map' | 'edit'>('map');

  // Map search state
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [radius, setRadius] = useState('300');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<Record<string, unknown>>>([]);
  const [searchOpen, setSearchOpen] = useState(false);
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

  // Zone circles (trainer-editable)
  const [gameZones, setGameZones] = useState<Array<{ type: string; radius: number }>>([
    { type: 'hot', radius: 25 },
    { type: 'warm', radius: 50 },
    { type: 'cold', radius: 100 },
  ]);

  // Editor mode
  const [activeMode, setActiveMode] = useState<string>('select');

  // Save state
  const [sceneConfigId, setSceneConfigId] = useState<string | null>(initialSceneId || null);
  const [saving, setSaving] = useState(false);

  // Canvas refs
  const leafletMapRef = useRef<L.Map | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const renderCtxRef = useRef<RenderContext | null>(null);
  const rafRef = useRef(0);
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 });

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

  // ── Search ────────────────────────────────────────────────────────────

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    try {
      const resp = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&limit=5`,
      );
      const results = await resp.json();
      setSearchResults(results as Array<Record<string, unknown>>);
      setSearchOpen(true);
    } catch {
      setSearchResults([]);
    }
  }, [searchQuery]);

  const handleSelectResult = useCallback((result: Record<string, unknown>) => {
    setLat(String(result.lat));
    setLng(String(result.lon));
    setSearchOpen(false);
  }, []);

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

  const backToMap = useCallback(() => {
    setPhase('map');
    cancelAnimationFrame(rafRef.current);
    setActiveMode('select');
  }, []);

  // ── Canvas click handler ──────────────────────────────────────────────

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || !renderCtxRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const sim = toSim(cx, cy);
      const snapped = snapToStud(sim);

      if (activeMode === 'place_exit') {
        const snap = nearestEdge(snapped.pos.x, snapped.pos.y, projectedVerts);
        const w = 3;
        const len = edgeLength(projectedVerts, snap.edgeIndex);
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
        // Simplified: single-click places wall start, second click places end
        // For now, use a simple two-click pattern
      }
    },
    [activeMode, toSim, snapToStud, projectedVerts],
  );

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
      };

      if (sceneConfigId) {
        await updateSceneConfig(sceneConfigId, {
          exits,
          interiorWalls,
          hazardZones,
          stairwells,
          blastSite,
          blastRadius,
          wallInspectionPoints: wallPoints,
          plantedItems,
          pedestrianCount,
        });
        onSave(sceneConfigId, config);
      } else {
        const id = await createSceneConfig({
          name: selectedGrid.buildingName || 'Scene',
          buildingPolygon: selectedGrid.polygon,
          buildingName: selectedGrid.buildingName,
          centerLat: config.centerLat,
          centerLng: config.centerLng,
          exits,
          interiorWalls,
          hazardZones,
          stairwells,
          blastSite,
          blastRadius,
          casualtyClusters: [],
          wallInspectionPoints: wallPoints,
          plantedItems,
          pedestrianCount,
        });
        setSceneConfigId(id);
        onSave(id, config);
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

  // ── Render loop ───────────────────────────────────────────────────────

  useEffect(() => {
    if (phase !== 'edit' || !selectedGrid || projectedVerts.length < 3) return;

    const loop = () => {
      const map = leafletMapRef.current;
      if (map && selectedGrid) {
        renderCtxRef.current = computeMapRenderContext(map, selectedGrid.polygon, projectedVerts);
      }
      const canvas = canvasRef.current;
      const rc = renderCtxRef.current;
      if (canvas && rc) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const state = createInitialGameState();
          renderRTS(
            ctx,
            canvas.width,
            canvas.height,
            rc,
            state,
            projectedVerts,
            exits,
            [],
            true,
            wallPoints,
            null,
            new Set(),
            new Set(),
            [],
            null,
            [],
            null,
            interiorWalls,
            hazardZones,
            stairwells,
            blastSite,
            blastSite ? gameZones : undefined,
            null,
            null,
            simStuds.length > 0 ? simStuds : null,
          );
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [
    phase,
    selectedGrid,
    projectedVerts,
    exits,
    interiorWalls,
    hazardZones,
    stairwells,
    blastSite,
    wallPoints,
    simStuds,
  ]);

  const setLeafletMap = useCallback((m: L.Map) => {
    leafletMapRef.current = m;
  }, []);

  // ── RENDER ────────────────────────────────────────────────────────────

  // Map phase: search and select building
  if (phase === 'map') {
    return (
      <div className="flex flex-col h-full">
        <div className="flex gap-2 items-end mb-3 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <label className="text-[10px] terminal-text text-robotic-yellow/40 uppercase">
              Search Place
            </label>
            <div className="flex gap-1">
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder="Search for a place..."
                className="flex-1 px-3 py-2 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow terminal-text text-sm"
              />
              <button
                onClick={handleSearch}
                className="px-3 py-2 text-xs terminal-text border border-robotic-yellow/50 text-robotic-yellow hover:bg-robotic-yellow/10"
              >
                Search
              </button>
            </div>
            {searchOpen && searchResults.length > 0 && (
              <div className="absolute z-20 bg-gray-900 border border-robotic-yellow/50 rounded mt-1 max-h-48 overflow-y-auto w-full max-w-md">
                {searchResults.map((r, i) => (
                  <button
                    key={i}
                    onClick={() => handleSelectResult(r)}
                    className="block w-full text-left px-3 py-2 text-xs terminal-text text-robotic-yellow/70 hover:bg-robotic-yellow/10 border-b border-robotic-gray-200 last:border-b-0"
                  >
                    {String(r.display_name || '')}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex gap-2 items-end">
            <div>
              <label className="text-[10px] terminal-text text-robotic-yellow/40">Lat</label>
              <input
                value={lat}
                onChange={(e) => setLat(e.target.value)}
                className="w-24 px-2 py-2 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow terminal-text text-sm"
              />
            </div>
            <div>
              <label className="text-[10px] terminal-text text-robotic-yellow/40">Lng</label>
              <input
                value={lng}
                onChange={(e) => setLng(e.target.value)}
                className="w-24 px-2 py-2 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow terminal-text text-sm"
              />
            </div>
            <div>
              <label className="text-[10px] terminal-text text-robotic-yellow/40">Radius</label>
              <input
                value={radius}
                onChange={(e) => setRadius(e.target.value)}
                className="w-16 px-2 py-2 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow terminal-text text-sm"
              />
            </div>
            <button
              onClick={handleFetch}
              disabled={fetchLoading || !lat || !lng}
              className="military-button px-4 py-2 text-xs disabled:opacity-50"
            >
              {fetchLoading ? 'Fetching...' : 'Fetch Buildings'}
            </button>
          </div>
        </div>

        {error && <p className="text-xs text-red-400 mb-2">{error}</p>}

        {fetchResult && (
          <div className="space-y-2">
            <p className="text-xs terminal-text text-robotic-yellow/50">
              {fetchResult.grids.length} buildings found. Select one:
            </p>
            <div className="grid grid-cols-2 gap-2 max-h-60 overflow-y-auto">
              {fetchResult.grids.map((g, i) => (
                <button
                  key={i}
                  onClick={() => selectBuilding(i)}
                  className="text-left px-3 py-2 border border-robotic-yellow/30 hover:border-robotic-yellow text-xs terminal-text text-robotic-yellow/70 hover:text-robotic-yellow bg-black/30 hover:bg-black/50"
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
    <div className="flex h-full gap-3">
      {/* Left: Tools panel */}
      <div className="w-56 overflow-y-auto space-y-2 flex-shrink-0">
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
              </div>
              {gameZones.map((zone, i) => {
                const colors: Record<string, string> = {
                  hot: '#ef4444',
                  warm: '#f97316',
                  cold: '#eab308',
                };
                return (
                  <div key={zone.type} className="flex items-center gap-2 mb-1">
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

      {/* Right: Map + Canvas */}
      <div
        className="flex-1 relative overflow-hidden rounded border border-robotic-gray-200"
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
          onClick={handleCanvasClick}
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
        />
        {activeMode !== 'select' && (
          <div
            className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/70 rounded px-3 py-1 text-xs text-robotic-yellow pointer-events-none"
            style={{ zIndex: 1001 }}
          >
            Click map to place — ESC or click a tool to cancel
          </div>
        )}
      </div>
    </div>
  );
}
