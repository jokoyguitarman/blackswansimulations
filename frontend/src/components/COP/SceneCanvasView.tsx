import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { MapContainer, TileLayer, Polygon, useMap } from 'react-leaflet';
import L from 'leaflet';
import { api } from '../../lib/api';
import { projectPolygon } from '../../lib/evacuation/geometry';
import {
  renderRTS,
  computeMapRenderContext,
  latLngToSim,
  toSim as rcToSim,
  drawScenarioLocation,
  drawIncidentZone,
  drawRoadPolyline,
} from '../../lib/rts/renderer';
import type { RenderContext, SimLocation, SimZone, SimRoad } from '../../lib/rts/renderer';
import {
  createInitialGameState,
  type InteriorWall,
  type HazardZone,
  type HazardType,
  type Stairwell,
  type CasualtyPin,
  type TriageTag,
} from '../../lib/rts/types';
import type { ExitDef, Vec2 } from '../../lib/evacuation/types';
import type { WallInspectionPoint } from '../../lib/rts/wallInspection';
import 'leaflet/dist/leaflet.css';

interface SceneCanvasViewProps {
  scenarioId: string;
  sessionId?: string;
  height?: number;
  fillHeight?: boolean;
  showAllPins?: boolean;
  onLoaded?: (hasScene: boolean) => void;
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

type SceneConfigData = {
  building_polygon: [number, number][];
  building_name: string | null;
  center_lat: number | null;
  center_lng: number | null;
  exits: Array<Record<string, unknown>>;
  interior_walls: Array<Record<string, unknown>>;
  hazard_zones: Array<Record<string, unknown>>;
  stairwells: Array<Record<string, unknown>>;
  blast_site: { x: number; y: number } | null;
  wall_inspection_points: Array<Record<string, unknown>>;
  pedestrian_count: number;
};

export function SceneCanvasView({
  scenarioId,
  height = 600,
  fillHeight,
  onLoaded,
}: SceneCanvasViewProps) {
  const leafletMapRef = useRef<L.Map | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const renderCtxRef = useRef<RenderContext | null>(null);
  const rafRef = useRef(0);

  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 });
  const [sceneConfig, setSceneConfig] = useState<SceneConfigData | null>(null);
  const [casualtyPins, setCasualtyPins] = useState<CasualtyPin[]>([]);
  const [scenarioLocations, setScenarioLocations] = useState<SimLocation[]>([]);
  const [incidentZones, setIncidentZones] = useState<SimZone[]>([]);
  const [roadPolylines, setRoadPolylines] = useState<SimRoad[]>([]);
  const [simStuds, setSimStuds] = useState<Array<{
    simPos: Vec2;
    studType: string;
    spatialContext: string | null;
    id: string;
  }> | null>(null);
  const [activeCasualtyPin, setActiveCasualtyPin] = useState<CasualtyPin | null>(null);
  const [activeWallPoint, setActiveWallPoint] = useState<WallInspectionPoint | null>(null);
  const [activeLocation, setActiveLocation] = useState<SimLocation | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasScene, setHasScene] = useState<boolean | null>(null);

  // Load scene config and scenario pins
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [sceneRes, casualtiesRes, locationsRes, hazardsRes, studsRes] = await Promise.all([
          api.scenarios.getSceneConfig(scenarioId),
          api.scenarios.getScenarioCasualties(scenarioId).catch(() => ({ data: [] })),
          api.scenarios.getScenarioLocations(scenarioId).catch(() => ({ data: [] })),
          api.scenarios.getScenarioHazards(scenarioId).catch(() => ({ data: [] })),
          api.scenarios
            .getBuildingStuds(scenarioId)
            .catch(() => ({ grids: [], roadPolylines: [] })),
        ]);

        if (cancelled) return;

        const scene = sceneRes.data as SceneConfigData | null;
        if (!scene?.building_polygon || scene.building_polygon.length < 3) {
          setHasScene(false);
          onLoaded?.(false);
          setLoading(false);
          return;
        }

        setSceneConfig(scene);
        setHasScene(true);
        onLoaded?.(true);

        const polygon = scene.building_polygon;
        const casualties = (casualtiesRes as { data: Array<Record<string, unknown>> }).data || [];
        const converted: CasualtyPin[] = casualties
          .filter((c) => c.location_lat != null && c.location_lng != null)
          .map((c) => {
            const pos = latLngToSim(c.location_lat as number, c.location_lng as number, polygon);
            const conditions = (c.conditions ?? {}) as Record<string, unknown>;
            const triageTag = (
              (conditions.triage_category as string) || 'green'
            ).toLowerCase() as TriageTag;
            return {
              id: c.id as string,
              pos,
              description:
                (conditions.visible_description as string) ||
                (conditions.injury_description as string) ||
                '',
              trueTag: triageTag,
              currentTag: 'untagged' as TriageTag,
              observableSigns: {
                breathing: (conditions.breathing as string) || '',
                pulse: (conditions.pulse as string) || '',
                consciousness: (conditions.consciousness as string) || '',
                visibleInjuries: (conditions.visible_injuries as string) || '',
                mobility: (conditions.mobility as string) || '',
                bleeding: (conditions.bleeding as string) || '',
              },
              imageUrl: null,
              imageGenerating: false,
              autoGenerated: true,
              deteriorationLevel: 0,
            };
          });

        setCasualtyPins(converted);

        // Convert scenario locations to sim-space
        const locs = (locationsRes as { data: Array<Record<string, unknown>> }).data || [];
        const simLocs: SimLocation[] = locs
          .filter((l) => (l.coordinates as Record<string, unknown>)?.lat != null)
          .map((l) => {
            const coords = l.coordinates as { lat: number; lng: number };
            return {
              simPos: latLngToSim(coords.lat, coords.lng, polygon),
              label: (l.label as string) || '',
              pinCategory: (l.pin_category as string) || undefined,
              locationType: (l.location_type as string) || undefined,
            };
          });
        setScenarioLocations(simLocs);

        // Extract incident zones from hazards
        const hazards = (hazardsRes as { data: Array<Record<string, unknown>> }).data || [];
        const zones: SimZone[] = [];
        for (const h of hazards) {
          if (!h.location_lat || !h.location_lng) continue;
          const hCenter = latLngToSim(h.location_lat as number, h.location_lng as number, polygon);
          const hZones = (h.zones as Array<Record<string, unknown>>) || [];
          for (const z of hZones) {
            if (z.radius_m) {
              zones.push({
                center: hCenter,
                radiusM: z.radius_m as number,
                zoneType: (z.zone_type as string) || 'warm',
              });
            }
          }
        }
        setIncidentZones(zones);

        // Convert road polylines and studs to sim-space
        const studsData = studsRes as {
          grids: Array<{
            studs: Array<{
              id: string;
              lat: number;
              lng: number;
              studType: string;
              spatialContext: string;
            }>;
          }>;
          roadPolylines: Array<{
            name: string;
            highway_type: string;
            coordinates: [number, number][];
          }>;
        };
        const roads: SimRoad[] = (studsData.roadPolylines || []).map((r) => ({
          points: r.coordinates.map(([lat, lng]) => latLngToSim(lat, lng, polygon)),
          name: r.name,
        }));
        setRoadPolylines(roads);

        const allStuds = (studsData.grids || []).flatMap((g) =>
          g.studs.map((s) => ({
            id: s.id,
            simPos: latLngToSim(s.lat, s.lng, polygon),
            studType: s.studType || 'building',
            spatialContext: s.spatialContext || null,
          })),
        );
        if (allStuds.length > 0) setSimStuds(allStuds);
      } catch (err) {
        console.error('SceneCanvasView: failed to load data', err);
        setHasScene(false);
        onLoaded?.(false);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [scenarioId, onLoaded]);

  // Parse scene config into sim-space data
  const projectedVerts = useMemo(
    () => (sceneConfig ? projectPolygon(sceneConfig.building_polygon) : []),
    [sceneConfig],
  );

  const exits = useMemo<ExitDef[]>(() => {
    if (!sceneConfig?.exits) return [];
    return sceneConfig.exits.map((e) => ({
      id: (e.id as string) || 'exit',
      center: (e.center as Vec2) || { x: 0, y: 0 },
      width: (e.width as number) || 2,
      edgeIndex: (e.edgeIndex as number) || 0,
      description: (e.description as string) || '',
      status: ((e.status as string) || 'unknown') as ExitDef['status'],
      photos: (e.photos as string[]) || [],
    }));
  }, [sceneConfig]);

  const interiorWalls = useMemo<InteriorWall[]>(() => {
    if (!sceneConfig?.interior_walls) return [];
    return sceneConfig.interior_walls.map((w) => ({
      id: (w.id as string) || '',
      start: (w.start as Vec2) || { x: 0, y: 0 },
      end: (w.end as Vec2) || { x: 0, y: 0 },
      hasDoor: !!(w.hasDoor as boolean),
      doorWidth: (w.doorWidth as number) || 1.5,
      doorPosition: (w.doorPosition as number) || 0.5,
      description: (w.description as string) || '',
      material: (w.material as string) || '',
      photos: (w.photos as string[]) || [],
    }));
  }, [sceneConfig]);

  const hazardZones = useMemo<HazardZone[]>(() => {
    if (!sceneConfig?.hazard_zones) return [];
    return sceneConfig.hazard_zones.map((h) => ({
      id: (h.id as string) || '',
      pos: (h.pos as Vec2) || { x: 0, y: 0 },
      radius: (h.radius as number) || 5,
      hazardType: ((h.hazardType as string) || 'combustible') as HazardType,
      severity: ((h.severity as string) || 'medium') as 'low' | 'medium' | 'high',
      label: (h.label as string) || '',
      description: (h.description as string) || '',
      photos: (h.photos as string[]) || [],
    }));
  }, [sceneConfig]);

  const stairwells = useMemo<Stairwell[]>(() => {
    if (!sceneConfig?.stairwells) return [];
    return sceneConfig.stairwells.map((s) => ({
      id: (s.id as string) || '',
      pos: (s.pos as Vec2) || { x: 0, y: 0 },
      connectsFloors: (s.connectsFloors as [number, number]) || [0, 1],
      blocked: !!(s.blocked as boolean),
      label: (s.label as string) || '',
    }));
  }, [sceneConfig]);

  const blastSite = useMemo<Vec2 | null>(() => sceneConfig?.blast_site || null, [sceneConfig]);

  const wallPoints = useMemo<WallInspectionPoint[]>(() => {
    if (!sceneConfig?.wall_inspection_points) return [];
    return sceneConfig.wall_inspection_points as unknown as WallInspectionPoint[];
  }, [sceneConfig]);

  const setLeafletMap = useCallback((map: L.Map) => {
    leafletMapRef.current = map;
  }, []);

  // Canvas resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height: h } = entry.contentRect;
        if (width > 0 && h > 0) {
          setCanvasSize({ w: Math.round(width), h: Math.round(h) });
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Click handler for canvas interaction
  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rc = renderCtxRef.current;
      if (!rc || !canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const sim = rcToSim(cx, cy, rc);

      const hitCas = casualtyPins.find((c) => Math.hypot(c.pos.x - sim.x, c.pos.y - sim.y) < 8);
      if (hitCas) {
        setActiveCasualtyPin(hitCas);
        setActiveWallPoint(null);
        setActiveLocation(null);
        return;
      }

      const hitWp = wallPoints.find(
        (wp) => wp.simPos && Math.hypot(wp.simPos.x - sim.x, wp.simPos.y - sim.y) < 3,
      );
      if (hitWp) {
        setActiveWallPoint(hitWp);
        setActiveCasualtyPin(null);
        setActiveLocation(null);
        return;
      }

      const hitLoc = scenarioLocations.find(
        (l) => Math.hypot(l.simPos.x - sim.x, l.simPos.y - sim.y) < 10,
      );
      if (hitLoc) {
        setActiveLocation(hitLoc);
        setActiveCasualtyPin(null);
        setActiveWallPoint(null);
        return;
      }

      setActiveCasualtyPin(null);
      setActiveWallPoint(null);
      setActiveLocation(null);
    },
    [casualtyPins, wallPoints, scenarioLocations],
  );

  // Render loop
  useEffect(() => {
    if (!sceneConfig || projectedVerts.length < 3) return;

    const loop = () => {
      const map = leafletMapRef.current;
      if (map && projectedVerts.length >= 3) {
        renderCtxRef.current = computeMapRenderContext(
          map,
          sceneConfig.building_polygon,
          projectedVerts,
        );
      }
      const canvas = canvasRef.current;
      const rc = renderCtxRef.current;
      if (canvas && rc) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);

          // Background layers: roads and incident zones (behind building)
          for (const road of roadPolylines) {
            drawRoadPolyline(ctx, road, rc);
          }
          for (const zone of incidentZones) {
            drawIncidentZone(ctx, zone, rc);
          }

          // Main RTS scene (building, walls, hazards, exits, casualties)
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
            activeWallPoint?.id ?? null,
            new Set(),
            new Set(),
            [],
            null,
            casualtyPins,
            activeCasualtyPin?.id ?? null,
            interiorWalls,
            hazardZones,
            stairwells,
            blastSite,
            undefined,
            null,
            null,
            simStuds,
          );

          // Foreground layers: scenario location labels (on top of everything)
          for (const loc of scenarioLocations) {
            drawScenarioLocation(ctx, loc, rc);
          }
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [
    sceneConfig,
    projectedVerts,
    exits,
    interiorWalls,
    hazardZones,
    stairwells,
    blastSite,
    wallPoints,
    casualtyPins,
    scenarioLocations,
    incidentZones,
    roadPolylines,
    simStuds,
    activeCasualtyPin,
    activeWallPoint,
  ]);

  if (loading) {
    return (
      <div
        style={fillHeight ? undefined : { height }}
        className={`flex items-center justify-center bg-black/50 border border-robotic-gray-200 rounded ${fillHeight ? 'h-full' : ''}`}
      >
        <p className="text-xs terminal-text text-robotic-yellow/70 animate-pulse">
          Loading scene...
        </p>
      </div>
    );
  }

  if (!hasScene || !sceneConfig) {
    return null;
  }

  const centerLat =
    sceneConfig.center_lat ??
    sceneConfig.building_polygon.reduce((s, p) => s + p[0], 0) /
      sceneConfig.building_polygon.length;
  const centerLng =
    sceneConfig.center_lng ??
    sceneConfig.building_polygon.reduce((s, p) => s + p[1], 0) /
      sceneConfig.building_polygon.length;

  return (
    <div
      className={`relative overflow-hidden rounded border border-robotic-gray-200 ${fillHeight ? 'h-full' : ''}`}
      ref={containerRef}
      style={fillHeight ? undefined : { height }}
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
        <FitBounds polygon={sceneConfig.building_polygon} />
        <Polygon
          positions={sceneConfig.building_polygon.map(([la, ln]) => [la, ln] as [number, number])}
          pathOptions={{ color: '#22d3ee', weight: 2, fillOpacity: 0 }}
        />
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

      {/* Casualty inspection panel */}
      {activeCasualtyPin && (
        <div
          className="absolute top-4 left-4 bg-gray-900/95 border border-red-700 rounded-lg shadow-2xl overflow-y-auto"
          style={{ zIndex: 1002, width: 380, maxHeight: 'calc(100% - 32px)' }}
        >
          <div className="flex items-center justify-between px-3 py-2 bg-red-900/40 border-b border-red-800">
            <div className="flex items-center gap-2">
              <span
                className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                  activeCasualtyPin.trueTag === 'red'
                    ? 'bg-red-700 text-white'
                    : activeCasualtyPin.trueTag === 'yellow'
                      ? 'bg-yellow-600 text-black'
                      : activeCasualtyPin.trueTag === 'green'
                        ? 'bg-green-700 text-white'
                        : activeCasualtyPin.trueTag === 'black'
                          ? 'bg-gray-800 text-white'
                          : 'bg-gray-600 text-white'
                }`}
              >
                {activeCasualtyPin.trueTag.toUpperCase()}
              </span>
              <span className="text-xs text-white font-bold">
                Casualty {activeCasualtyPin.id.slice(0, 8)}
              </span>
            </div>
            <button
              onClick={() => setActiveCasualtyPin(null)}
              className="text-gray-400 hover:text-white text-sm px-1"
            >
              X
            </button>
          </div>
          <div className="p-3 space-y-2">
            {activeCasualtyPin.description && (
              <p className="text-xs text-gray-300">{activeCasualtyPin.description}</p>
            )}
            <div className="grid grid-cols-2 gap-1 text-[10px]">
              {activeCasualtyPin.observableSigns.breathing && (
                <div>
                  <span className="text-gray-500">Breathing:</span>{' '}
                  <span className="text-gray-300">
                    {activeCasualtyPin.observableSigns.breathing}
                  </span>
                </div>
              )}
              {activeCasualtyPin.observableSigns.pulse && (
                <div>
                  <span className="text-gray-500">Pulse:</span>{' '}
                  <span className="text-gray-300">{activeCasualtyPin.observableSigns.pulse}</span>
                </div>
              )}
              {activeCasualtyPin.observableSigns.consciousness && (
                <div>
                  <span className="text-gray-500">Consciousness:</span>{' '}
                  <span className="text-gray-300">
                    {activeCasualtyPin.observableSigns.consciousness}
                  </span>
                </div>
              )}
              {activeCasualtyPin.observableSigns.visibleInjuries && (
                <div>
                  <span className="text-gray-500">Injuries:</span>{' '}
                  <span className="text-gray-300">
                    {activeCasualtyPin.observableSigns.visibleInjuries}
                  </span>
                </div>
              )}
              {activeCasualtyPin.observableSigns.mobility && (
                <div>
                  <span className="text-gray-500">Mobility:</span>{' '}
                  <span className="text-gray-300">
                    {activeCasualtyPin.observableSigns.mobility}
                  </span>
                </div>
              )}
              {activeCasualtyPin.observableSigns.bleeding && (
                <div>
                  <span className="text-gray-500">Bleeding:</span>{' '}
                  <span className="text-gray-300">
                    {activeCasualtyPin.observableSigns.bleeding}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Wall photo point panel */}
      {activeWallPoint && (
        <div
          className="absolute top-4 left-4 bg-gray-900/95 border border-cyan-700 rounded-lg shadow-2xl overflow-y-auto"
          style={{ zIndex: 1002, width: 380, maxHeight: 'calc(100% - 32px)' }}
        >
          <div className="flex items-center justify-between px-3 py-2 bg-cyan-900/40 border-b border-cyan-800">
            <span className="text-xs text-white font-bold">
              Wall Point {(activeWallPoint as Record<string, unknown>).id as string}
            </span>
            <button
              onClick={() => setActiveWallPoint(null)}
              className="text-gray-400 hover:text-white text-sm px-1"
            >
              X
            </button>
          </div>
          <div className="p-3">
            {(activeWallPoint as Record<string, unknown>).imageUrl ? (
              <img
                src={(activeWallPoint as Record<string, unknown>).imageUrl as string}
                alt="Wall point"
                className="w-full rounded border border-gray-700"
              />
            ) : (
              <p className="text-xs text-gray-500">No photo available</p>
            )}
            <div className="mt-2 text-[10px] text-gray-400">
              Heading:{' '}
              {Math.round(((activeWallPoint as Record<string, unknown>).heading as number) || 0)}°
            </div>
          </div>
        </div>
      )}

      {/* Location info panel */}
      {activeLocation && (
        <div
          className="absolute top-4 left-4 bg-gray-900/95 border border-amber-700 rounded-lg shadow-2xl overflow-y-auto"
          style={{ zIndex: 1002, width: 380, maxHeight: 'calc(100% - 32px)' }}
        >
          <div className="flex items-center justify-between px-3 py-2 bg-amber-900/40 border-b border-amber-800">
            <span className="text-xs text-white font-bold">{activeLocation.label}</span>
            <button
              onClick={() => setActiveLocation(null)}
              className="text-gray-400 hover:text-white text-sm px-1"
            >
              X
            </button>
          </div>
          <div className="p-3 text-xs text-gray-300">
            <div className="text-[10px] text-gray-500 uppercase mb-1">
              {activeLocation.pinCategory || activeLocation.locationType || 'Location'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
