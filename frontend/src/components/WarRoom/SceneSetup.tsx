import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, Polygon, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { ExitDef, Vec2 } from '../../lib/evacuation/types';
import { projectPolygon, nearestEdge, edgeLength } from '../../lib/evacuation/geometry';
import type {
  InteriorWall,
  HazardZone,
  HazardType,
  Stairwell,
  CasualtyCluster,
  PlantedItem,
} from '../../lib/rts/types';
import { HAZARD_DEFS, createInitialGameState } from '../../lib/rts/types';
import { generateWallPoints, type WallInspectionPoint } from '../../lib/rts/wallInspection';
import { generateBlastCasualties } from '../../lib/rts/casualtyPresets';
import { renderRTS, computeMapRenderContext } from '../../lib/rts/renderer';
import type { RenderContext } from '../../lib/rts/renderer';
import 'leaflet/dist/leaflet.css';

interface SceneSetupProps {
  buildingPolygon: [number, number][];
  buildingName: string | null;
  centerLat: number;
  centerLng: number;
  onSave: (config: SceneSetupResult) => void;
  initialConfig?: Partial<SceneSetupResult>;
}

export interface SceneSetupResult {
  buildingPolygon: [number, number][];
  buildingName: string | null;
  exits: ExitDef[];
  interiorWalls: InteriorWall[];
  hazardZones: HazardZone[];
  stairwells: Stairwell[];
  blastSite: Vec2 | null;
  casualtyClusters: CasualtyCluster[];
  plantedItems: PlantedItem[];
  wallInspectionPoints: WallInspectionPoint[];
  pedestrianCount: number;
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
    const bounds = L.latLngBounds(polygon.map(([la, ln]) => [la, ln] as [number, number]));
    map.fitBounds(bounds, { padding: [80, 80], maxZoom: 20 });
  }, [map, polygon]);
  return null;
}

let exitIdCounter = 1000;

export function SceneSetup({
  buildingPolygon,
  buildingName,
  centerLat,
  centerLng,
  onSave,
  initialConfig,
}: SceneSetupProps) {
  const leafletMapRef = useRef<L.Map | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const renderCtxRef = useRef<RenderContext | null>(null);
  const rafRef = useRef(0);

  const [exits, setExits] = useState<ExitDef[]>(initialConfig?.exits || []);
  const [interiorWalls] = useState<InteriorWall[]>(initialConfig?.interiorWalls || []);
  const [hazardZones, setHazardZones] = useState<HazardZone[]>(initialConfig?.hazardZones || []);
  const [stairwells, setStairwells] = useState<Stairwell[]>(initialConfig?.stairwells || []);
  const [blastSite, setBlastSite] = useState<Vec2 | null>(initialConfig?.blastSite || null);
  const [casualtyClusters, setCasualtyClusters] = useState<CasualtyCluster[]>(
    initialConfig?.casualtyClusters || [],
  );
  const [plantedItems] = useState<PlantedItem[]>(initialConfig?.plantedItems || []);
  const [pedestrianCount, setPedestrianCount] = useState(initialConfig?.pedestrianCount || 120);
  const [newExitWidth, setNewExitWidth] = useState(3);
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 500 });
  const [activeMode, setActiveMode] = useState<string>('select');

  const projectedVerts = useMemo(() => projectPolygon(buildingPolygon), [buildingPolygon]);
  const wallPoints = useMemo(
    () => generateWallPoints(buildingPolygon, projectedVerts),
    [buildingPolygon, projectedVerts],
  );

  const setLeafletMap = useCallback((map: L.Map) => {
    leafletMapRef.current = map;
  }, []);

  // Canvas resize
  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCanvasSize({
          w: Math.round(entry.contentRect.width),
          h: Math.round(entry.contentRect.height),
        });
      }
    });
    obs.observe(containerRef.current);
    const rect = containerRef.current.getBoundingClientRect();
    setCanvasSize({ w: Math.round(rect.width), h: Math.round(rect.height) });
    return () => obs.disconnect();
  }, []);

  // Render loop
  useEffect(() => {
    const loop = () => {
      const map = leafletMapRef.current;
      if (map && projectedVerts.length >= 3) {
        renderCtxRef.current = computeMapRenderContext(map, buildingPolygon, projectedVerts);
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
            casualtyClusters,
            null,
            interiorWalls,
            hazardZones,
            stairwells,
            blastSite,
          );
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [
    buildingPolygon,
    projectedVerts,
    exits,
    wallPoints,
    casualtyClusters,
    interiorWalls,
    hazardZones,
    stairwells,
    blastSite,
  ]);

  // Click handler
  const toSim = useCallback((cx: number, cy: number): Vec2 => {
    const rc = renderCtxRef.current;
    if (!rc) return { x: 0, y: 0 };
    return {
      x: (cx - rc.padX) / rc.scale + rc.bounds.minX,
      y: (cy - rc.padY) / rc.scale + rc.bounds.minY,
    };
  }, []);

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = canvasRef.current!.getBoundingClientRect();
      const sim = toSim(e.clientX - rect.left, e.clientY - rect.top);

      if (activeMode === 'place_exit') {
        const snap = nearestEdge(sim.x, sim.y, projectedVerts);
        const maxW = edgeLength(projectedVerts, snap.edgeIndex) * 0.9;
        const w = Math.min(newExitWidth, maxW);
        setExits((prev) => [
          ...prev,
          {
            id: `exit-${++exitIdCounter}`,
            center: snap.point,
            width: w,
            edgeIndex: snap.edgeIndex,
            description: '',
            status: 'unknown' as const,
            photos: [],
          },
        ]);
        setActiveMode('select');
      } else if (activeMode === 'place_blast') {
        setBlastSite(sim);
        setActiveMode('select');
      } else if (activeMode === 'place_casualty') {
        const dist = blastSite ? Math.hypot(sim.x - blastSite.x, sim.y - blastSite.y) : 50;
        const { victims, sceneDescription } = generateBlastCasualties(dist);
        setCasualtyClusters((prev) => [
          ...prev,
          {
            id: `cas-${Date.now()}`,
            pos: sim,
            victims,
            sceneDescription,
            imageUrl: null,
            imageGenerating: false,
            discovered: true,
            triageComplete: false,
            aiEvaluation: null,
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
    [activeMode, projectedVerts, newExitWidth, blastSite, toSim],
  );

  const handleSave = useCallback(() => {
    onSave({
      buildingPolygon,
      buildingName,
      exits,
      interiorWalls,
      hazardZones,
      stairwells,
      blastSite,
      casualtyClusters,
      plantedItems,
      wallInspectionPoints: wallPoints,
      pedestrianCount,
    });
  }, [
    buildingPolygon,
    buildingName,
    exits,
    interiorWalls,
    hazardZones,
    stairwells,
    blastSite,
    casualtyClusters,
    plantedItems,
    wallPoints,
    pedestrianCount,
    onSave,
  ]);

  return (
    <div className="flex gap-4" style={{ height: 500 }}>
      {/* Left: tools */}
      <div className="w-52 overflow-y-auto space-y-2 flex-shrink-0">
        <div className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-1">
          Scene Tools
        </div>

        <button
          onClick={() => setActiveMode('place_exit')}
          className={`w-full text-left text-xs px-2 py-1.5 border rounded ${activeMode === 'place_exit' ? 'border-cyan-400 bg-cyan-900/30 text-cyan-300' : 'border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50'}`}
        >
          🚪 Place Exit
        </button>
        <button
          onClick={() => setActiveMode('place_blast')}
          className={`w-full text-left text-xs px-2 py-1.5 border rounded ${activeMode === 'place_blast' ? 'border-red-400 bg-red-900/30 text-red-300' : 'border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50'}`}
        >
          💥 Blast Site {blastSite ? '(replace)' : ''}
        </button>
        <button
          onClick={() => setActiveMode('place_casualty')}
          className={`w-full text-left text-xs px-2 py-1.5 border rounded ${activeMode === 'place_casualty' ? 'border-red-400 bg-red-900/30 text-red-300' : 'border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50'}`}
        >
          🏥 Place Casualties
        </button>
        <button
          onClick={() => setActiveMode('place_stairwell')}
          className={`w-full text-left text-xs px-2 py-1.5 border rounded ${activeMode === 'place_stairwell' ? 'border-cyan-400 bg-cyan-900/30 text-cyan-300' : 'border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50'}`}
        >
          🪜 Place Stairwell
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

        <div className="mt-2">
          <label className="text-xs text-robotic-yellow/50 block mb-1">Exit Width (m)</label>
          <input
            type="range"
            min={1}
            max={8}
            step={0.5}
            value={newExitWidth}
            onChange={(e) => setNewExitWidth(Number(e.target.value))}
            className="w-full"
          />
          <span className="text-xs text-robotic-yellow/70">{newExitWidth}m</span>
        </div>
        <div>
          <label className="text-xs text-robotic-yellow/50 block mb-1">Pedestrians</label>
          <input
            type="number"
            min={1}
            step={10}
            value={pedestrianCount}
            onChange={(e) => setPedestrianCount(Math.max(1, Number(e.target.value) || 1))}
            className="w-full bg-black/50 border border-robotic-yellow/30 text-robotic-yellow text-xs px-2 py-1 rounded"
          />
        </div>

        <div className="text-xs text-robotic-yellow/50 mt-2">
          Exits: {exits.length} · Blast: {blastSite ? '✓' : '—'} · Casualties:{' '}
          {casualtyClusters.length}
        </div>

        <button onClick={handleSave} className="w-full mt-3 military-button px-4 py-2 text-xs">
          [SAVE SCENE]
        </button>
      </div>

      {/* Right: map + canvas */}
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
          <FitBounds polygon={buildingPolygon} />
          <Polygon
            positions={buildingPolygon.map(([la, ln]) => [la, ln] as [number, number])}
            pathOptions={{ color: '#22d3ee', weight: 2, fillOpacity: 0 }}
          />
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
