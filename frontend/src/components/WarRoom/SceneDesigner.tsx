import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, Polygon, useMap } from 'react-leaflet';
import L from 'leaflet';
import { supabase } from '../../lib/supabase';
import { PolygonEvacuationEngine } from '../../lib/evacuation/engine';
import type { PedSnapshot } from '../../lib/evacuation/engine';
import type { ExitDef, PolygonSimConfig, Vec2 } from '../../lib/evacuation/types';
import { DEFAULT_POLYGON_CONFIG } from '../../lib/evacuation/types';
import { projectPolygon, nearestEdge, edgeLength } from '../../lib/evacuation/geometry';
import { renderRTS, computeMapRenderContext } from '../../lib/rts/renderer';
import type { RenderContext } from '../../lib/rts/renderer';
import {
  type InteriorWall,
  type HazardZone,
  type HazardType,
  type Stairwell,
  type CasualtyPin,
  type GameZone,
  type PlantedItem,
  type TriageTag,
  HAZARD_DEFS,
  createInitialGameState,
} from '../../lib/rts/types';
import { generateWallPoints, type WallInspectionPoint } from '../../lib/rts/wallInspection';
import 'leaflet/dist/leaflet.css';

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
    map.fitBounds(L.latLngBounds(polygon.map(([la, ln]) => [la, ln] as [number, number])), {
      padding: [80, 80],
      maxZoom: 20,
    });
  }, [map, polygon]);
  return null;
}

// ── Types ───────────────────────────────────────────────────────────────

interface GridItem {
  buildingIndex: number;
  buildingName: string | null;
  polygon: [number, number][];
  floors: string[];
  spacingM: number;
}

export interface SceneDesignerResult {
  buildingPolygon: [number, number][];
  buildingName: string | null;
  exits: ExitDef[];
  interiorWalls: InteriorWall[];
  hazardZones: HazardZone[];
  stairwells: Stairwell[];
  blastSite: Vec2 | null;
  blastRadius: number;
  gameZones: GameZone[];
  casualtyPins: CasualtyPin[];
  plantedItems: PlantedItem[];
  wallInspectionPoints: WallInspectionPoint[];
  pedestrianCount: number;
}

interface SceneDesignerProps {
  centerLat: number;
  centerLng: number;
  radius?: number;
  osmBuildings?: GridItem[];
  initialConfig?: Partial<SceneDesignerResult>;
  onSave: (config: SceneDesignerResult) => void;
}

// ── Component ───────────────────────────────────────────────────────────

export function SceneDesigner({
  centerLat,
  centerLng,
  radius = 300,
  osmBuildings,
  initialConfig,
  onSave,
}: SceneDesignerProps) {
  const leafletMapRef = useRef<L.Map | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const renderCtxRef = useRef<RenderContext | null>(null);
  const rafRef = useRef(0);

  // ── Building state ────────────────────────────────────────────────────
  const [grids, setGrids] = useState<GridItem[]>(osmBuildings || []);
  const [selectedGridIdx, setSelectedGridIdx] = useState<number | null>(null);
  const [buildingPhase, setBuildingPhase] = useState<'pick' | 'design'>(
    osmBuildings?.length ? 'pick' : 'pick',
  );
  const [loading, setLoading] = useState(false);

  // ── Scene elements ────────────────────────────────────────────────────
  const [exits, setExits] = useState<ExitDef[]>(initialConfig?.exits || []);
  const [interiorWalls] = useState<InteriorWall[]>(initialConfig?.interiorWalls || []);
  const [hazardZones, setHazardZones] = useState<HazardZone[]>(initialConfig?.hazardZones || []);
  const [stairwells, setStairwells] = useState<Stairwell[]>(initialConfig?.stairwells || []);
  const [blastSite, setBlastSite] = useState<Vec2 | null>(initialConfig?.blastSite || null);
  const [blastRadius, setBlastRadius] = useState(initialConfig?.blastRadius || 20);
  const [gameZones, setGameZones] = useState<GameZone[]>(initialConfig?.gameZones || []);
  const [casualtyPins, setCasualtyPins] = useState<CasualtyPin[]>(
    initialConfig?.casualtyPins || [],
  );
  const [plantedItems] = useState<PlantedItem[]>(initialConfig?.plantedItems || []);
  const [pedestrianCount, setPedestrianCount] = useState(initialConfig?.pedestrianCount || 120);
  const [newExitWidth, setNewExitWidth] = useState(3);
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 });

  // ── Interaction mode ──────────────────────────────────────────────────
  const [activeMode, setActiveMode] = useState('select');

  // ── Evac preview ──────────────────────────────────────────────────────
  const [pedestrians, setPedestrians] = useState<PedSnapshot[]>([]);
  const evacEngRef = useRef<PolygonEvacuationEngine | null>(null);
  const [simRunning, setSimRunning] = useState(false);
  const lastTimeRef = useRef(0);

  // ── Derived ───────────────────────────────────────────────────────────
  const selectedGrid = selectedGridIdx != null ? grids[selectedGridIdx] : null;
  const projectedVerts = useMemo(() => {
    if (!selectedGrid) return [];
    return projectPolygon(selectedGrid.polygon);
  }, [selectedGrid]);
  const wallPoints = useMemo(() => {
    if (!selectedGrid || projectedVerts.length < 3) return [];
    return generateWallPoints(selectedGrid.polygon, projectedVerts);
  }, [selectedGrid, projectedVerts]);

  const setLeafletMap = useCallback((map: L.Map) => {
    leafletMapRef.current = map;
  }, []);

  // ── Fetch buildings if none provided ──────────────────────────────────
  const handleFetch = useCallback(async () => {
    setLoading(true);
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(
        apiUrl(`/api/debug/building-studs?lat=${centerLat}&lng=${centerLng}&radius=${radius}`),
        { headers },
      );
      if (resp.ok) {
        const data = await resp.json();
        setGrids(data.grids ?? []);
      }
    } catch {
      /* ignore */
    }
    setLoading(false);
  }, [centerLat, centerLng, radius]);

  useEffect(() => {
    if (!osmBuildings || osmBuildings.length === 0) handleFetch();
  }, [osmBuildings, handleFetch]);

  // ── Canvas resize ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries)
        setCanvasSize({
          w: Math.round(entry.contentRect.width),
          h: Math.round(entry.contentRect.height),
        });
      leafletMapRef.current?.invalidateSize();
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // ── Render + sim loop ─────────────────────────────────────────────────
  const pedestriansRef = useRef(pedestrians);
  pedestriansRef.current = pedestrians;
  const exitsRef = useRef(exits);
  exitsRef.current = exits;
  const wallPointsRef = useRef(wallPoints);
  wallPointsRef.current = wallPoints;
  const interiorWallsRef = useRef(interiorWalls);
  interiorWallsRef.current = interiorWalls;
  const hazardZonesRef = useRef(hazardZones);
  hazardZonesRef.current = hazardZones;
  const stairwellsRef = useRef(stairwells);
  stairwellsRef.current = stairwells;
  const blastSiteRef = useRef(blastSite);
  blastSiteRef.current = blastSite;
  const projectedVertsRef = useRef(projectedVerts);
  projectedVertsRef.current = projectedVerts;

  useEffect(() => {
    if (buildingPhase !== 'design') return;
    const loop = (time: number) => {
      lastTimeRef.current = time;

      const evac = evacEngRef.current;
      if (evac && simRunning) {
        for (let i = 0; i < 3; i++) evac.step();
        pedestriansRef.current = evac.getSnapshots();
        setPedestrians(evac.getSnapshots());
      }

      const map = leafletMapRef.current;
      const verts = projectedVertsRef.current;
      if (map && selectedGrid && verts.length >= 3) {
        renderCtxRef.current = computeMapRenderContext(map, selectedGrid.polygon, verts);
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
            verts,
            exitsRef.current,
            pedestriansRef.current,
            true,
            wallPointsRef.current,
            null,
            new Set(),
            new Set(),
            [],
            null,
            interiorWallsRef.current,
            hazardZonesRef.current,
            stairwellsRef.current,
            blastSiteRef.current,
          );
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    lastTimeRef.current = 0;
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [buildingPhase, selectedGrid, simRunning]);

  // ── Coordinate conversion ─────────────────────────────────────────────
  const toSim = useCallback((cx: number, cy: number): Vec2 => {
    const rc = renderCtxRef.current;
    if (!rc) return { x: 0, y: 0 };
    return {
      x: (cx - rc.padX) / rc.scale + rc.bounds.minX,
      y: (cy - rc.padY) / rc.scale + rc.bounds.minY,
    };
  }, []);

  // ── Canvas click ──────────────────────────────────────────────────────
  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = canvasRef.current!.getBoundingClientRect();
      const sim = toSim(e.clientX - rect.left, e.clientY - rect.top);

      if (activeMode === 'place_exit' && projectedVerts.length >= 3) {
        const snap = nearestEdge(sim.x, sim.y, projectedVerts);
        const maxW = edgeLength(projectedVerts, snap.edgeIndex) * 0.9;
        setExits((prev) => [
          ...prev,
          {
            id: `exit-${Date.now()}`,
            center: snap.point,
            width: Math.min(newExitWidth, maxW),
            edgeIndex: snap.edgeIndex,
            description: '',
            status: 'unknown' as const,
            photos: [],
          },
        ]);
        setActiveMode('select');
      } else if (activeMode === 'place_blast') {
        setBlastSite(sim);
        setGameZones([
          { id: 'gz-hot', type: 'hot', radius: blastRadius },
          { id: 'gz-warm', type: 'warm', radius: blastRadius * 2 },
          { id: 'gz-cold', type: 'cold', radius: blastRadius * 3 },
        ]);
        setActiveMode('select');
      } else if (activeMode === 'place_casualty') {
        const dist = blastSite ? Math.hypot(sim.x - blastSite.x, sim.y - blastSite.y) : 50;
        const tag: TriageTag =
          dist < 10 ? 'black' : dist < 20 ? 'red' : dist < 40 ? 'yellow' : 'green';
        setCasualtyPins((prev) => [
          ...prev,
          {
            id: `cp-${Date.now()}`,
            pos: sim,
            description: '',
            trueTag: tag,
            observableSigns: {
              breathing: '',
              pulse: '',
              consciousness: '',
              visibleInjuries: '',
              mobility: '',
              bleeding: '',
            },
            imageUrl: null,
            imageGenerating: false,
            autoGenerated: false,
          },
        ]);
        setActiveMode('select');
      } else if (activeMode.startsWith('place_hazard_')) {
        const ht = activeMode.replace('place_hazard_', '') as HazardType;
        setHazardZones((prev) => [
          ...prev,
          {
            id: `hz-${Date.now()}`,
            pos: sim,
            radius: 5,
            hazardType: ht,
            severity: 'medium',
            label: HAZARD_DEFS[ht].label,
            description: '',
            photos: [],
          },
        ]);
        setActiveMode('select');
      } else if (activeMode === 'place_stairwell') {
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
        setActiveMode('select');
      }
    },
    [activeMode, projectedVerts, newExitWidth, blastSite, blastRadius, toSim],
  );

  // ── Detonate preview ──────────────────────────────────────────────────
  const handleDetonate = useCallback(() => {
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
    const iwDefs = interiorWalls.map((w) => ({
      startX: w.start.x,
      startY: w.start.y,
      endX: w.end.x,
      endY: w.end.y,
      hasDoor: w.hasDoor,
      doorWidth: w.doorWidth,
      doorPosition: w.doorPosition,
    }));
    const obstacles = [
      ...hazardZones.map((hz) => ({ x: hz.pos.x, y: hz.pos.y, radius: hz.radius })),
      ...casualtyPins.map((c) => ({ x: c.pos.x, y: c.pos.y, radius: 2 })),
    ];
    evacEngRef.current = new PolygonEvacuationEngine(config, exits, iwDefs, obstacles);
    setPedestrians(evacEngRef.current.getSnapshots());
    setSimRunning(true);
  }, [projectedVerts, exits, interiorWalls, hazardZones, casualtyPins, pedestrianCount]);

  // ── Save ──────────────────────────────────────────────────────────────
  const handleSave = useCallback(() => {
    if (!selectedGrid) return;
    onSave({
      buildingPolygon: selectedGrid.polygon,
      buildingName: selectedGrid.buildingName,
      exits,
      interiorWalls,
      hazardZones,
      stairwells,
      blastSite,
      blastRadius,
      gameZones,
      casualtyPins,
      plantedItems,
      wallInspectionPoints: wallPoints,
      pedestrianCount,
    });
  }, [
    selectedGrid,
    exits,
    interiorWalls,
    hazardZones,
    stairwells,
    blastSite,
    blastRadius,
    gameZones,
    casualtyPins,
    plantedItems,
    wallPoints,
    pedestrianCount,
    onSave,
  ]);

  // =====================================================================
  // RENDER
  // =====================================================================

  // Building pick phase
  if (buildingPhase === 'pick') {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-3 p-3 border-b border-robotic-gray-200 flex-shrink-0">
          <span className="text-xs terminal-text text-robotic-yellow/70 uppercase">
            Select a building or draw one
          </span>
          <button
            onClick={handleFetch}
            disabled={loading}
            className="military-button px-3 py-1 text-xs disabled:opacity-50"
          >
            {loading ? 'Fetching...' : 'Fetch Buildings'}
          </button>
        </div>
        <div className="flex flex-1 overflow-hidden">
          <div className="flex-1 relative">
            <MapContainer
              center={[centerLat, centerLng]}
              zoom={18}
              maxZoom={22}
              style={{ height: '100%', width: '100%' }}
            >
              <TileLayer
                attribution="&copy; OSM"
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                maxNativeZoom={19}
                maxZoom={22}
              />
              <MapRefSync onMap={setLeafletMap} />
              {grids
                .filter((g) => g.polygon.length >= 3)
                .map((grid, idx) => (
                  <Polygon
                    key={idx}
                    positions={grid.polygon.map(([la, ln]) => [la, ln] as [number, number])}
                    pathOptions={{
                      color: selectedGridIdx === idx ? '#22d3ee' : '#6366f1',
                      weight: 2,
                      fillOpacity: selectedGridIdx === idx ? 0.2 : 0.08,
                    }}
                    eventHandlers={{
                      click: () => {
                        setSelectedGridIdx(idx);
                        setBuildingPhase('design');
                      },
                    }}
                  />
                ))}
            </MapContainer>
          </div>
          <div className="w-64 overflow-y-auto p-3 border-l border-robotic-gray-200 space-y-2">
            <div className="text-xs terminal-text text-robotic-yellow/50">
              {grids.filter((g) => g.polygon.length >= 3).length} buildings found
            </div>
            {grids
              .filter((g) => g.polygon.length >= 3)
              .map((grid, idx) => (
                <button
                  key={idx}
                  onClick={() => {
                    setSelectedGridIdx(idx);
                    setBuildingPhase('design');
                  }}
                  className="w-full text-left p-2 rounded border border-robotic-gray-200 text-xs terminal-text text-robotic-yellow/70 hover:border-robotic-yellow/50"
                >
                  <div className="font-bold">
                    {grid.buildingName || `Building #${grid.buildingIndex}`}
                  </div>
                  <div className="text-robotic-yellow/40">{grid.polygon.length} pts</div>
                </button>
              ))}
          </div>
        </div>
      </div>
    );
  }

  // Design phase
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 p-2 border-b border-robotic-gray-200 flex-shrink-0">
        <button
          onClick={() => {
            setBuildingPhase('pick');
            setSimRunning(false);
            evacEngRef.current?.destroy();
          }}
          className="text-xs terminal-text text-robotic-yellow/70 border border-robotic-gray-200 px-2 py-1 hover:border-robotic-yellow/50"
        >
          [BACK]
        </button>
        <span className="text-xs terminal-text text-robotic-yellow">
          {selectedGrid?.buildingName || 'Building'}
        </span>
        <div className="flex-1" />
        <button
          onClick={handleDetonate}
          disabled={exits.length === 0}
          className="bg-red-900/60 hover:bg-red-800 disabled:opacity-30 text-red-200 text-xs px-3 py-1 rounded border border-red-700"
        >
          {simRunning ? 'Restart Preview' : 'Test Detonate'}
        </button>
        <button onClick={handleSave} className="military-button px-3 py-1 text-xs">
          [SAVE SCENE]
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Tools panel */}
        <div className="w-52 overflow-y-auto p-2 space-y-2 border-r border-robotic-gray-200 flex-shrink-0 min-h-0">
          <div className="text-xs terminal-text text-robotic-yellow/50 uppercase">Scene Tools</div>

          <button
            onClick={() => setActiveMode('place_exit')}
            className={`w-full text-left text-xs px-2 py-1.5 border rounded terminal-text ${activeMode === 'place_exit' ? 'border-cyan-400 bg-cyan-900/30 text-cyan-300' : 'border-robotic-gray-200 text-robotic-yellow/70'}`}
          >
            Place Exit
          </button>
          <button
            onClick={() => setActiveMode('place_blast')}
            className={`w-full text-left text-xs px-2 py-1.5 border rounded terminal-text ${activeMode === 'place_blast' ? 'border-red-400 bg-red-900/30 text-red-300' : 'border-robotic-gray-200 text-robotic-yellow/70'}`}
          >
            Blast Site {blastSite ? '(replace)' : ''}
          </button>
          <button
            onClick={() => setActiveMode('place_casualty')}
            className={`w-full text-left text-xs px-2 py-1.5 border rounded terminal-text ${activeMode === 'place_casualty' ? 'border-red-400 bg-red-900/30 text-red-300' : 'border-robotic-gray-200 text-robotic-yellow/70'}`}
          >
            Place Casualty Pin
          </button>
          <button
            onClick={() => setActiveMode('place_stairwell')}
            className={`w-full text-left text-xs px-2 py-1.5 border rounded terminal-text ${activeMode === 'place_stairwell' ? 'border-cyan-400 bg-cyan-900/30 text-cyan-300' : 'border-robotic-gray-200 text-robotic-yellow/70'}`}
          >
            Place Stairwell
          </button>

          <div className="text-xs terminal-text text-robotic-yellow/40 mt-1">Hazards:</div>
          {(Object.keys(HAZARD_DEFS) as HazardType[]).map((ht) => (
            <button
              key={ht}
              onClick={() => setActiveMode(`place_hazard_${ht}`)}
              className={`w-full text-left text-xs px-2 py-1 border rounded ${activeMode === `place_hazard_${ht}` ? 'border-cyan-400 bg-cyan-900/30' : 'border-robotic-gray-200'}`}
              style={{ color: HAZARD_DEFS[ht].color }}
            >
              {HAZARD_DEFS[ht].icon} {HAZARD_DEFS[ht].label}
            </button>
          ))}

          <div className="border-t border-robotic-gray-200 pt-2 mt-2 space-y-1.5">
            <div>
              <label className="text-xs terminal-text text-robotic-yellow/40 block mb-0.5">
                Exit Width (m)
              </label>
              <input
                type="range"
                min={1}
                max={8}
                step={0.5}
                value={newExitWidth}
                onChange={(e) => setNewExitWidth(Number(e.target.value))}
                className="w-full"
              />
              <span className="text-xs terminal-text text-robotic-yellow/70">{newExitWidth}m</span>
            </div>
            <div>
              <label className="text-xs terminal-text text-robotic-yellow/40 block mb-0.5">
                Pedestrians
              </label>
              <input
                type="number"
                min={1}
                step={10}
                value={pedestrianCount}
                onChange={(e) => setPedestrianCount(Math.max(1, Number(e.target.value) || 1))}
                className="w-full bg-black/50 border border-robotic-yellow/30 text-robotic-yellow text-xs px-2 py-1 rounded"
              />
            </div>
            {blastSite && (
              <div>
                <label className="text-xs terminal-text text-robotic-yellow/40 block mb-0.5">
                  Blast Radius (m)
                </label>
                <input
                  type="number"
                  min={5}
                  max={500}
                  step={5}
                  value={blastRadius}
                  onChange={(e) => {
                    const r = Math.max(5, Number(e.target.value) || 20);
                    setBlastRadius(r);
                    setGameZones([
                      { id: 'gz-hot', type: 'hot', radius: r },
                      { id: 'gz-warm', type: 'warm', radius: r * 2 },
                      { id: 'gz-cold', type: 'cold', radius: r * 3 },
                    ]);
                  }}
                  className="w-full bg-black/50 border border-robotic-yellow/30 text-robotic-yellow text-xs px-2 py-1 rounded"
                />
                <div className="text-xs terminal-text text-robotic-yellow/40 mt-1">
                  Hot: {blastRadius}m · Warm: {blastRadius * 2}m · Cold: {blastRadius * 3}m
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-robotic-gray-200 pt-2 space-y-1.5">
            <button
              onClick={async () => {
                if (!selectedGrid) return;
                const cLat =
                  selectedGrid.polygon.reduce((s: number, p: [number, number]) => s + p[0], 0) /
                  selectedGrid.polygon.length;
                const cLng =
                  selectedGrid.polygon.reduce((s: number, p: [number, number]) => s + p[1], 0) /
                  selectedGrid.polygon.length;
                try {
                  const headers = await getAuthHeaders();
                  const params = new URLSearchParams({
                    lat: String(cLat),
                    lng: String(cLng),
                    radius: '300',
                  });
                  if (blastSite) {
                    params.set('hazardLat', String(cLat));
                    params.set('hazardLng', String(cLng));
                    params.set('weaponClass', 'explosive');
                  }
                  const resp = await fetch(apiUrl(`/api/debug/building-studs?${params}`), {
                    headers,
                  });
                  if (resp.ok) {
                    const data = await resp.json();
                    const totalStuds =
                      data.grids?.reduce(
                        (s: number, g: { studs: unknown[] }) => s + g.studs.length,
                        0,
                      ) ?? 0;
                    alert(
                      `Studs loaded: ${totalStuds} total across ${data.grids?.length ?? 0} grids`,
                    );
                  }
                } catch {
                  alert('Failed to load studs');
                }
              }}
              className="w-full text-left text-xs px-2 py-1.5 border rounded terminal-text border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50"
            >
              Load Studs
            </button>
            <div className="text-xs terminal-text text-robotic-yellow/40">
              Exits: {exits.length} · Casualties: {casualtyPins.length} · Hazards:{' '}
              {hazardZones.length} · Walls: {interiorWalls.length}
            </div>
          </div>
        </div>

        {/* Map + canvas */}
        <div className="flex-1 relative overflow-hidden" ref={containerRef}>
          <MapContainer
            center={[centerLat, centerLng]}
            zoom={18}
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
            onClick={handleCanvasClick}
          />
          {activeMode !== 'select' && (
            <div
              className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/70 rounded px-3 py-1 text-xs terminal-text text-robotic-yellow pointer-events-none"
              style={{ zIndex: 1001 }}
            >
              Click map to place — click another tool or press ESC to cancel
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
