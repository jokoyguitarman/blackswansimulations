import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { MapContainer, TileLayer, Polygon, Marker, Tooltip, useMap } from 'react-leaflet';
import L, { DivIcon } from 'leaflet';
import { api } from '../../lib/api';
import { projectPolygon } from '../../lib/evacuation/geometry';
import { PolygonEvacuationEngine } from '../../lib/evacuation/engine';
import type { PedSnapshot } from '../../lib/evacuation/engine';
import { DEFAULT_POLYGON_CONFIG } from '../../lib/evacuation/types';
import type { PolygonSimConfig } from '../../lib/evacuation/types';
import {
  renderRTS,
  computeMapRenderContext,
  latLngToSim,
  toSim as rcToSim,
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
import { svg } from '../../components/COP/mapIcons';
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
  blast_site: {
    x: number;
    y: number;
    radius?: number;
    gameZones?: Array<{ type: string; radius: number; center?: { x: number; y: number } }>;
  } | null;
  wall_inspection_points: Array<Record<string, unknown>>;
  pedestrian_count: number;
  enrichment_result?: Record<string, unknown> | null;
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
  const [activeHazard, setActiveHazard] = useState<HazardZone | null>(null);
  const [plantedItems, setPlantedItems] = useState<Array<Record<string, unknown>>>([]);
  const [rawCasualties, setRawCasualties] = useState<
    Array<{ id: string; lat: number; lng: number; tag: string }>
  >([]);
  const [rawLocations, setRawLocations] = useState<
    Array<{ id: string; lat: number; lng: number; label: string; category: string }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [hasScene, setHasScene] = useState<boolean | null>(null);
  const [showBlastZone, setShowBlastZone] = useState(false);
  const [showOperatingZones, setShowOperatingZones] = useState(false);

  // Hazard progression preview
  interface EnvSnapshot {
    at_minutes: number;
    stud_effects: Array<{
      stud_id: string;
      smoke_density: number;
      fire_intensity: number;
      gas_concentration: number;
      structural_damage: number;
      visibility_m: number;
    }>;
  }
  const [envTimeline, setEnvTimeline] = useState<EnvSnapshot[]>([]);
  const [showHazardTimeline, setShowHazardTimeline] = useState(false);
  const [timelineIndex, setTimelineIndex] = useState(0);
  const [hazardEnrichmentMap, setHazardEnrichmentMap] = useState<
    Map<string, Record<string, unknown>>
  >(new Map());

  // Evacuation preview
  const [showEvacuation, setShowEvacuation] = useState(false);
  const [evacRunning, setEvacRunning] = useState(false);
  const evacEngRef = useRef<PolygonEvacuationEngine | null>(null);
  const [pedestrians, setPedestrians] = useState<PedSnapshot[]>([]);
  const evacSpeedRef = useRef(1);

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

        // Extract environmental timeline from enrichment_result if present
        const enrichment = (scene as unknown as Record<string, unknown>)
          .enrichment_result as Record<string, unknown> | null;
        if (enrichment?.sceneSynthesis) {
          const syn = enrichment.sceneSynthesis as Record<string, unknown>;
          const timeline = (syn.environmentalTimeline as EnvSnapshot[]) || [];
          if (timeline.length > 0) setEnvTimeline(timeline);
        }
        // Build hazard enrichment lookup
        if (enrichment?.hazardAnalysis) {
          const haMap = new Map<string, Record<string, unknown>>();
          for (const ha of enrichment.hazardAnalysis as Array<Record<string, unknown>>) {
            if (ha.hazardId) haMap.set(ha.hazardId as string, ha);
          }
          if (haMap.size > 0) setHazardEnrichmentMap(haMap);
        }

        const polygon = scene.building_polygon;
        const casualties = (casualtiesRes as { data: Array<Record<string, unknown>> }).data || [];
        const converted: CasualtyPin[] = casualties
          .filter((c) => c.location_lat != null && c.location_lng != null)
          .map((c) => {
            const pos = latLngToSim(c.location_lat as number, c.location_lng as number, polygon);
            const conditions = (c.conditions ?? {}) as Record<string, unknown>;
            return {
              id: c.id as string,
              pos,
              description:
                (conditions.visible_description as string) ||
                (conditions.injury_description as string) ||
                '',
              trueTag: 'untagged' as TriageTag,
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
        setRawCasualties(
          casualties
            .filter((c) => c.location_lat != null && c.location_lng != null)
            .map((c) => ({
              id: c.id as string,
              lat: c.location_lat as number,
              lng: c.location_lng as number,
              tag:
                ((c.conditions as Record<string, unknown>)?.triage_color as string) || 'untagged',
            })),
        );

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
        // Filter out locations too far from building (>500m in sim-space)
        const nearbyLocs = simLocs.filter((l) => Math.hypot(l.simPos.x, l.simPos.y) < 500);
        setScenarioLocations(nearbyLocs);
        setRawLocations(
          locs
            .filter((l) => (l.coordinates as Record<string, unknown>)?.lat != null)
            .map((l) => {
              const coords = l.coordinates as { lat: number; lng: number };
              const sim = latLngToSim(coords.lat, coords.lng, polygon);
              if (Math.hypot(sim.x, sim.y) >= 500) return null;
              return {
                id: (l.id as string) || '',
                lat: coords.lat,
                lng: coords.lng,
                label: (l.label as string) || '',
                category: (l.pin_category as string) || (l.location_type as string) || 'poi',
              };
            })
            .filter((l): l is NonNullable<typeof l> => l !== null),
        );

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

        // Load planted items from scene config
        const planted = (scene as unknown as Record<string, unknown>).planted_items as
          | Array<Record<string, unknown>>
          | undefined;
        if (planted && planted.length > 0) setPlantedItems(planted);
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

  const sceneGameZones = useMemo<Array<{ type: string; radius: number; center?: Vec2 }>>(() => {
    const gz = sceneConfig?.blast_site?.gameZones;
    if (!gz || !Array.isArray(gz)) return [];
    return gz;
  }, [sceneConfig]);

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

      const hitCas = casualtyPins.find((c) => Math.hypot(c.pos.x - sim.x, c.pos.y - sim.y) < 3);
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
        setActiveHazard(null);
        return;
      }

      const hitHz = hazardZones.find(
        (hz) => Math.hypot(hz.pos.x - sim.x, hz.pos.y - sim.y) < Math.max(hz.radius, 5),
      );
      if (hitHz) {
        setActiveHazard(hitHz);
        setActiveCasualtyPin(null);
        setActiveWallPoint(null);
        setActiveLocation(null);
        return;
      }

      setActiveCasualtyPin(null);
      setActiveWallPoint(null);
      setActiveLocation(null);
      setActiveHazard(null);
    },
    [casualtyPins, wallPoints, scenarioLocations, hazardZones],
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
          if (showOperatingZones) {
            for (const zone of incidentZones) {
              drawIncidentZone(ctx, zone, rc);
            }
          }

          // Compute effectStates from selected timeline snapshot
          let activeEffects: Map<
            string,
            { fire: { state: string }; gas: number; flood: number; structural: number }
          > | null = null;
          if (showHazardTimeline && envTimeline.length > 0) {
            const snap = envTimeline[Math.min(timelineIndex, envTimeline.length - 1)];
            if (snap?.stud_effects?.length > 0) {
              activeEffects = new Map();
              for (const e of snap.stud_effects) {
                activeEffects.set(e.stud_id, {
                  fire: {
                    state:
                      e.fire_intensity > 0.5
                        ? 'burning'
                        : e.fire_intensity > 0.01
                          ? 'heating'
                          : 'none',
                  },
                  gas: e.gas_concentration,
                  flood: 0,
                  structural: e.structural_damage,
                });
              }
            }
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
            pedestrians,
            true,
            wallPoints,
            activeWallPoint?.id ?? null,
            new Set(plantedItems.map((p) => p.wallPointId as string)),
            new Set(),
            [],
            null,
            [],
            null,
            interiorWalls,
            hazardZones,
            stairwells,
            blastSite,
            sceneGameZones.length > 0 ? sceneGameZones : undefined,
            null,
            null,
            simStuds,
            activeEffects,
            undefined,
            showBlastZone,
            showOperatingZones,
          );

          // Location and casualty pins are rendered as Leaflet DivIcon markers (not on canvas)
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
    showHazardTimeline,
    timelineIndex,
    envTimeline,
    pedestrians,
    showBlastZone,
    showOperatingZones,
    sceneGameZones,
  ]);

  // Evacuation engine step
  useEffect(() => {
    if (!evacRunning || !evacEngRef.current) return;
    let frameId = 0;
    const step = () => {
      const eng = evacEngRef.current;
      if (!eng) return;
      const speed = evacSpeedRef.current;
      for (let i = 0; i < speed; i++) eng.step();
      setPedestrians(eng.getSnapshots());
      frameId = requestAnimationFrame(step);
    };
    frameId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameId);
  }, [evacRunning]);

  const startEvacuation = useCallback(() => {
    if (!sceneConfig || !projectedVerts.length || !exits.length) return;
    const config: PolygonSimConfig = {
      vertices: projectedVerts,
      pedestrianCount: sceneConfig.pedestrian_count || 120,
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
      doorWidth: w.doorWidth ?? 1.5,
      doorPosition: w.doorPosition ?? 0.5,
    }));
    const obstacles = hazardZones.map((hz) => ({ x: hz.pos.x, y: hz.pos.y, radius: hz.radius }));
    evacEngRef.current = new PolygonEvacuationEngine(config, exits, iwDefs, obstacles);
    setPedestrians(evacEngRef.current.getSnapshots());
    setEvacRunning(true);
  }, [sceneConfig, projectedVerts, exits, interiorWalls, hazardZones]);

  const stopEvacuation = useCallback(() => {
    setEvacRunning(false);
    evacEngRef.current?.destroy();
    evacEngRef.current = null;
    setPedestrians([]);
  }, []);

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
      className={`relative overflow-hidden rounded border border-robotic-gray-200 ${fillHeight ? 'h-full' : ''} flex flex-col`}
      style={fillHeight ? undefined : { height }}
    >
      {/* Preview toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-robotic-gray-300 border-b border-robotic-gray-200 flex-shrink-0">
        <button
          onClick={() => {
            setShowHazardTimeline(!showHazardTimeline);
            if (showHazardTimeline) setTimelineIndex(0);
          }}
          disabled={envTimeline.length === 0}
          className={`text-[10px] terminal-text px-2 py-1 rounded border transition-colors ${
            showHazardTimeline
              ? 'border-red-500 bg-red-900/30 text-red-300'
              : 'border-robotic-gray-200 text-robotic-yellow/50 hover:border-robotic-yellow/40'
          } ${envTimeline.length === 0 ? 'opacity-30 cursor-not-allowed' : ''}`}
        >
          {showHazardTimeline ? 'Hide Hazards' : 'Hazard Timeline'}
        </button>

        <button
          onClick={() => {
            if (showEvacuation) {
              stopEvacuation();
              setShowEvacuation(false);
            } else {
              setShowEvacuation(true);
              startEvacuation();
            }
          }}
          disabled={!exits.length}
          className={`text-[10px] terminal-text px-2 py-1 rounded border transition-colors ${
            showEvacuation
              ? 'border-cyan-500 bg-cyan-900/30 text-cyan-300'
              : 'border-robotic-gray-200 text-robotic-yellow/50 hover:border-robotic-yellow/40'
          } ${!exits.length ? 'opacity-30 cursor-not-allowed' : ''}`}
        >
          {showEvacuation ? 'Stop Evacuation' : 'Evacuation Preview'}
        </button>

        {showEvacuation && (
          <>
            <button
              onClick={() => setEvacRunning(!evacRunning)}
              className="text-[10px] terminal-text px-2 py-1 border border-robotic-gray-200 text-robotic-yellow/50 rounded"
            >
              {evacRunning ? 'Pause' : 'Play'}
            </button>
            {[1, 2, 5].map((s) => (
              <button
                key={s}
                onClick={() => {
                  evacSpeedRef.current = s;
                }}
                className={`text-[9px] terminal-text px-1.5 py-0.5 rounded border ${
                  evacSpeedRef.current === s
                    ? 'border-cyan-500 text-cyan-300'
                    : 'border-robotic-gray-200 text-robotic-yellow/30'
                }`}
              >
                {s}x
              </button>
            ))}
            <span className="text-[9px] terminal-text text-robotic-yellow/30">
              {pedestrians.filter((p) => p.evacuated).length}/{pedestrians.length} evacuated
            </span>
          </>
        )}

        <button
          onClick={() => setShowBlastZone(!showBlastZone)}
          className={`text-[10px] terminal-text px-2 py-1 rounded border transition-colors ${
            showBlastZone
              ? 'border-red-500 bg-red-900/30 text-red-300'
              : 'border-robotic-gray-200 text-robotic-yellow/50 hover:border-robotic-yellow/40'
          }`}
        >
          {showBlastZone ? 'Hide Blast Radius' : 'Show Blast Radius'}
        </button>

        <button
          onClick={() => setShowOperatingZones(!showOperatingZones)}
          className={`text-[10px] terminal-text px-2 py-1 rounded border transition-colors ${
            showOperatingZones
              ? 'border-orange-500 bg-orange-900/30 text-orange-300'
              : 'border-robotic-gray-200 text-robotic-yellow/50 hover:border-robotic-yellow/40'
          }`}
        >
          {showOperatingZones ? 'Hide Operating Zones' : 'Show Operating Zones'}
        </button>

        {showHazardTimeline && envTimeline.length > 0 && (
          <div className="flex items-center gap-2 ml-2">
            <span className="text-[9px] terminal-text text-red-400">
              T+{envTimeline[timelineIndex]?.at_minutes ?? 0} min
            </span>
            <input
              type="range"
              min={0}
              max={envTimeline.length - 1}
              value={timelineIndex}
              onChange={(e) => setTimelineIndex(Number(e.target.value))}
              className="w-32"
            />
            <div className="flex gap-0.5">
              {envTimeline.map((s, i) => (
                <button
                  key={i}
                  onClick={() => setTimelineIndex(i)}
                  className={`text-[8px] terminal-text px-1 py-0.5 rounded ${
                    i === timelineIndex
                      ? 'bg-red-900/40 text-red-300'
                      : 'text-robotic-yellow/20 hover:text-robotic-yellow/40'
                  }`}
                >
                  {s.at_minutes}m
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Map + Canvas */}
      <div className="flex-1 relative" ref={containerRef}>
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

          {/* Casualty markers (Leaflet DivIcon with SVG from mapIcons) */}
          {rawCasualties.map((c) => {
            const bg = '#9ca3af';
            return (
              <Marker
                key={`cas-${c.id}`}
                position={[c.lat, c.lng]}
                zIndexOffset={2000}
                icon={
                  new DivIcon({
                    className: '',
                    html: `<div style="background:${bg};width:24px;height:24px;border-radius:50%;border:2px solid #000;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.4)">${svg('person', 14)}</div>`,
                    iconSize: [24, 24],
                    iconAnchor: [12, 12],
                  })
                }
                eventHandlers={{
                  click: () => {
                    const pin = casualtyPins.find((p) => p.id === c.id);
                    if (pin) {
                      setActiveCasualtyPin(pin);
                      setActiveWallPoint(null);
                      setActiveLocation(null);
                      setActiveHazard(null);
                    }
                  },
                }}
              />
            );
          })}

          {/* Location markers (Leaflet DivIcon with SVG from mapIcons) */}
          {rawLocations.map((loc) => {
            const cat = loc.category.toLowerCase().replace(/[\s-]/g, '_');
            const colorByCategory = (c: string): string => {
              if (c.includes('hospital') || c.includes('clinic') || c.includes('medical'))
                return '#ef4444';
              if (c.includes('police') || c.includes('law')) return '#3b82f6';
              if (c.includes('fire') && !c.includes('firearm')) return '#f97316';
              if (c.includes('incident') || c.includes('blast') || c.includes('epicentr'))
                return '#ef4444';
              if (c.includes('entry') || c.includes('exit') || c.includes('door')) return '#06b6d4';
              if (c.includes('staging') || c.includes('assembly') || c.includes('rvp'))
                return '#22c55e';
              if (c.includes('cctv') || c.includes('camera') || c.includes('surveil'))
                return '#8b5cf6';
              if (c.includes('cordon') || c.includes('perimete')) return '#f87171';
              return '#a78bfa';
            };
            const iconByCategory = (c: string): string => {
              if (c.includes('hospital') || c.includes('clinic') || c.includes('medical'))
                return 'hospital';
              if (c.includes('police') || c.includes('law')) return 'police';
              if (c.includes('fire') && !c.includes('firearm')) return 'fire_station';
              if (c.includes('incident') || c.includes('blast') || c.includes('epicentr'))
                return 'siren';
              if (c.includes('entry') || c.includes('exit') || c.includes('door')) return 'door';
              if (c.includes('staging') || c.includes('rvp')) return 'staging';
              if (c.includes('assembly') || c.includes('muster')) return 'flag';
              if (c.includes('cctv') || c.includes('camera') || c.includes('surveil'))
                return 'cctv';
              if (c.includes('cordon') || c.includes('perimete')) return 'cordon';
              if (c.includes('route') || c.includes('road') || c.includes('highway'))
                return 'route';
              if (c.includes('community') || c.includes('church') || c.includes('school'))
                return 'community';
              return 'pin';
            };
            const bg = colorByCategory(cat);
            const iconKey = iconByCategory(cat);
            return (
              <Marker
                key={`loc-${loc.id}`}
                position={[loc.lat, loc.lng]}
                zIndexOffset={1500}
                icon={
                  new DivIcon({
                    className: '',
                    html: `<div style="background:${bg};width:26px;height:26px;border-radius:50%;border:2px solid #fff;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.3)">${svg(iconKey, 16)}</div>`,
                    iconSize: [26, 26],
                    iconAnchor: [13, 13],
                  })
                }
                eventHandlers={{
                  click: () => {
                    const sl = scenarioLocations.find((s) => s.label === loc.label);
                    if (sl) {
                      setActiveLocation(sl);
                      setActiveCasualtyPin(null);
                      setActiveWallPoint(null);
                      setActiveHazard(null);
                    }
                  },
                }}
              >
                <Tooltip className="pin-tooltip">
                  <span className="text-xs">{loc.label}</span>
                </Tooltip>
              </Marker>
            );
          })}
        </MapContainer>
        <canvas
          ref={canvasRef}
          width={canvasSize.w}
          height={canvasSize.h}
          onClick={handleCanvasClick}
          onWheel={(e) => {
            e.preventDefault();
            const map = leafletMapRef.current;
            if (map) e.deltaY < 0 ? map.zoomIn() : map.zoomOut();
          }}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: canvasSize.w,
            height: canvasSize.h,
            pointerEvents: 'auto',
            zIndex: 450,
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
              <span className="text-xs text-white font-bold">Wall Point {activeWallPoint.id}</span>
              <button
                onClick={() => setActiveWallPoint(null)}
                className="text-gray-400 hover:text-white text-sm px-1"
              >
                X
              </button>
            </div>
            <div className="p-3">
              {activeWallPoint.imageUrl ? (
                <img
                  src={activeWallPoint.imageUrl}
                  alt="Wall point"
                  className="w-full rounded border border-gray-700"
                />
              ) : (
                <p className="text-xs text-gray-500">No photo available</p>
              )}
              <div className="mt-2 text-[10px] text-gray-400">
                Heading: {Math.round(activeWallPoint.heading || 0)}°
              </div>
              {/* Planted devices at this wall point */}
              {plantedItems.filter((p) => p.wallPointId === activeWallPoint.id).length > 0 && (
                <div className="mt-2 border-t border-red-900/50 pt-2">
                  <div className="text-[10px] text-red-400 font-bold mb-1">Planted Devices</div>
                  {plantedItems
                    .filter((p) => p.wallPointId === activeWallPoint.id)
                    .map((p, i) => (
                      <div
                        key={i}
                        className="text-[10px] text-red-300 bg-red-900/20 rounded px-2 py-1 mb-1"
                      >
                        <span className="text-red-500">
                          {(p.threatLevel as string) || 'unknown'}
                        </span>
                        {' — '}
                        {(p.description as string) || 'No description'}
                      </div>
                    ))}
                </div>
              )}
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

        {/* Hazard detail panel */}
        {activeHazard &&
          (() => {
            const enriched = hazardEnrichmentMap.get(activeHazard.id);
            return (
              <div
                className="absolute top-4 left-4 bg-gray-900/95 border border-orange-700 rounded-lg shadow-2xl overflow-y-auto"
                style={{ zIndex: 1002, width: 380, maxHeight: 'calc(100% - 32px)' }}
              >
                <div className="flex items-center justify-between px-3 py-2 bg-orange-900/40 border-b border-orange-800">
                  <span className="text-xs text-orange-300 font-bold">
                    {(enriched?.identifiedMaterial as string) ||
                      activeHazard.label ||
                      activeHazard.hazardType}
                  </span>
                  <button
                    onClick={() => setActiveHazard(null)}
                    className="text-gray-400 hover:text-white text-sm px-1"
                  >
                    X
                  </button>
                </div>
                <div className="p-3 text-xs text-gray-300 space-y-2">
                  <div>
                    Type: <span className="text-orange-300">{activeHazard.hazardType}</span>
                  </div>
                  <div>
                    Radius: <span className="text-orange-300">{activeHazard.radius}m</span>
                  </div>
                  {!!enriched?.riskLevel && (
                    <div>
                      Risk:{' '}
                      <span
                        className={`font-bold ${
                          String(enriched.riskLevel).toLowerCase().includes('high')
                            ? 'text-red-400'
                            : 'text-orange-400'
                        }`}
                      >
                        {String(enriched.riskLevel)}
                      </span>
                    </div>
                  )}
                  {!!enriched?.generatedDescription && (
                    <div className="whitespace-pre-wrap text-gray-400 border-t border-gray-800 pt-2">
                      {String(enriched.generatedDescription)}
                    </div>
                  )}
                  {!enriched?.generatedDescription && activeHazard.description && (
                    <div className="whitespace-pre-wrap text-gray-400">
                      {activeHazard.description}
                    </div>
                  )}
                  {!!enriched?.blastInteraction && (
                    <div>
                      <span className="text-[9px] text-gray-500 uppercase">Blast Interaction:</span>{' '}
                      <span className="text-gray-400">{String(enriched.blastInteraction)}</span>
                    </div>
                  )}
                  {!!enriched?.secondaryEffects &&
                    (enriched.secondaryEffects as string[]).length > 0 && (
                      <div>
                        <span className="text-[9px] text-gray-500 uppercase">
                          Secondary Effects:
                        </span>{' '}
                        <span className="text-gray-400">
                          {(enriched.secondaryEffects as string[]).join('; ')}
                        </span>
                      </div>
                    )}
                  {!!enriched?.progressionTimeline && (
                    <div>
                      <span className="text-[9px] text-gray-500 uppercase">Progression:</span>{' '}
                      <span className="text-gray-400">{String(enriched.progressionTimeline)}</span>
                    </div>
                  )}
                  {!!enriched?.chainReactionRisk && (
                    <div>
                      <span className="text-[9px] text-gray-500 uppercase">Chain Reaction:</span>{' '}
                      <span className="text-gray-400">{String(enriched.chainReactionRisk)}</span>
                    </div>
                  )}
                  {!!enriched?.responderGuidance && (
                    <div className="border-t border-gray-800 pt-2">
                      <span className="text-[9px] text-cyan-500 uppercase">
                        Responder Guidance:
                      </span>
                      <div className="text-cyan-400/70 mt-0.5">
                        {String(enriched.responderGuidance)}
                      </div>
                    </div>
                  )}
                  {activeHazard.photos && activeHazard.photos.length > 0 && (
                    <div className="grid grid-cols-2 gap-1 mt-2">
                      {activeHazard.photos.map((photo, i) => (
                        <img
                          key={i}
                          src={photo}
                          alt={`Hazard ${i + 1}`}
                          className="w-full h-20 object-cover rounded border border-gray-700"
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
      </div>
    </div>
  );
}
