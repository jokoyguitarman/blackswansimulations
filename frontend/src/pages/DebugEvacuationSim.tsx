import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  MapContainer,
  TileLayer,
  Polygon,
  Circle,
  CircleMarker,
  useMapEvents,
} from 'react-leaflet';
import L from 'leaflet';
import { supabase } from '../lib/supabase';
import { PolygonEvacuationEngine } from '../lib/evacuation/engine';
import type { PedSnapshot, EvacMetrics } from '../lib/evacuation/engine';
import type { ExitDef, PolygonSimConfig, Vec2 } from '../lib/evacuation/types';
import { DEFAULT_POLYGON_CONFIG } from '../lib/evacuation/types';
import { projectPolygon, nearestEdge, polygonBounds, edgeLength } from '../lib/evacuation/geometry';
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

// ---------------------------------------------------------------------------
// Types for OSM data
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Speed color
// ---------------------------------------------------------------------------

function speedColor(speedMs: number): string {
  if (speedMs < 0.3) return '#ef4444';
  if (speedMs < 0.8) return '#f59e0b';
  return '#22c55e';
}

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

const CANVAS_PAD = 50;
const TARGET_CANVAS_SIZE = 700;

function computeScale(verts: Vec2[]) {
  const b = polygonBounds(verts);
  const maxDim = Math.max(b.width, b.height);
  return maxDim > 0 ? (TARGET_CANVAS_SIZE - CANVAS_PAD * 2) / maxDim : 20;
}

// ---------------------------------------------------------------------------
// Map click handler
// ---------------------------------------------------------------------------

function ClickHandler({ onClick }: { onClick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

// ---------------------------------------------------------------------------
// Exit ID counter
// ---------------------------------------------------------------------------

let exitIdCounter = 0;

// ===========================================================================
// Main component
// ===========================================================================

type PagePhase = 'map' | 'sim';
type InteractionMode = 'none' | 'place_exit' | 'delete_exit';

export function DebugEvacuationSim() {
  // ---- Phase 1: Map state ----
  const [lat, setLat] = useState('1.2989008');
  const [lng, setLng] = useState('103.855176');
  const [radius, setRadius] = useState('300');
  const [loading, setLoading] = useState(false);
  const [fetchResult, setFetchResult] = useState<FetchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mapRef = useRef<L.Map | null>(null);

  // ---- Building selection ----
  const [selectedGridIdx, setSelectedGridIdx] = useState<number | null>(null);
  const [phase, setPhase] = useState<PagePhase>('map');

  // ---- Phase 2: Simulation state ----
  const [exits, setExits] = useState<ExitDef[]>([]);
  const [mode, setMode] = useState<InteractionMode>('none');
  const [running, setRunning] = useState(false);
  const [metrics, setMetrics] = useState<EvacMetrics | null>(null);
  const [snapshots, setSnapshots] = useState<PedSnapshot[]>([]);
  const [selectedExitId, setSelectedExitId] = useState<string | null>(null);
  const [newExitWidth, setNewExitWidth] = useState(3);
  const [simSpeed, setSimSpeed] = useState(1);
  const [hoverInfo, setHoverInfo] = useState<string | null>(null);
  const [pedestrianCount, setPedestrianCount] = useState(DEFAULT_POLYGON_CONFIG.pedestrianCount);
  const [desiredSpeed, setDesiredSpeed] = useState(DEFAULT_POLYGON_CONFIG.desiredSpeed);
  const [panicFactor, setPanicFactor] = useState(DEFAULT_POLYGON_CONFIG.panicFactor);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PolygonEvacuationEngine | null>(null);
  const rafRef = useRef(0);

  // ---- Projected polygon ----
  const projectedVerts = useMemo<Vec2[]>(() => {
    if (selectedGridIdx == null || !fetchResult) return [];
    const grid = fetchResult.grids[selectedGridIdx];
    if (!grid) return [];
    return projectPolygon(grid.polygon);
  }, [fetchResult, selectedGridIdx]);

  const bounds = useMemo(() => polygonBounds(projectedVerts), [projectedVerts]);
  const scale = useMemo(() => computeScale(projectedVerts), [projectedVerts]);

  const canvasWidth =
    projectedVerts.length > 0
      ? Math.ceil(bounds.width * scale + CANVAS_PAD * 2)
      : TARGET_CANVAS_SIZE;
  const canvasHeight =
    projectedVerts.length > 0
      ? Math.ceil(bounds.height * scale + CANVAS_PAD * 2)
      : TARGET_CANVAS_SIZE;

  function toCanvas(mx: number, my: number) {
    return {
      cx: (mx - bounds.minX) * scale + CANVAS_PAD,
      cy: (my - bounds.minY) * scale + CANVAS_PAD,
    };
  }

  function toSim(cx: number, cy: number) {
    return {
      mx: (cx - CANVAS_PAD) / scale + bounds.minX,
      my: (cy - CANVAS_PAD) / scale + bounds.minY,
    };
  }

  // ---- Phase 1: Fetch buildings ----
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
      setFetchResult({
        grids: data.grids ?? [],
        buildings: data.buildings ?? [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [lat, lng, radius]);

  const handleMapClick = useCallback((clickLat: number, clickLng: number) => {
    setLat(clickLat.toFixed(7));
    setLng(clickLng.toFixed(7));
  }, []);

  useEffect(() => {
    if (mapRef.current) {
      const pLat = parseFloat(lat);
      const pLng = parseFloat(lng);
      if (!Number.isNaN(pLat) && !Number.isNaN(pLng)) {
        mapRef.current.setView([pLat, pLng], mapRef.current.getZoom());
      }
    }
  }, [lat, lng]);

  // ---- Select building & go to sim ----
  const selectBuilding = useCallback((gridIdx: number) => {
    setSelectedGridIdx(gridIdx);
    setExits([]);
    setSelectedExitId(null);
    setRunning(false);
    setMetrics(null);
    setSnapshots([]);
    setPhase('sim');
    engineRef.current?.destroy();
    engineRef.current = null;
  }, []);

  const backToMap = useCallback(() => {
    setPhase('map');
    setRunning(false);
    cancelAnimationFrame(rafRef.current);
    engineRef.current?.destroy();
    engineRef.current = null;
    setMetrics(null);
    setSnapshots([]);
  }, []);

  // ---- Phase 2: Engine init ----
  const initEngine = useCallback(() => {
    if (projectedVerts.length < 3) return;
    engineRef.current?.destroy();
    const config: PolygonSimConfig = {
      vertices: projectedVerts,
      pedestrianCount,
      pedestrianRadius: DEFAULT_POLYGON_CONFIG.pedestrianRadius,
      desiredSpeed,
      panicFactor,
      dt: DEFAULT_POLYGON_CONFIG.dt,
    };
    const eng = new PolygonEvacuationEngine(config, exits);
    engineRef.current = eng;
    setMetrics(eng.getMetrics());
    setSnapshots(eng.getSnapshots());
    setRunning(false);
  }, [projectedVerts, exits, pedestrianCount, desiredSpeed, panicFactor]);

  // ---- Draw ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || phase !== 'sim' || projectedVerts.length < 3) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    drawSim(
      ctx,
      canvasWidth,
      canvasHeight,
      projectedVerts,
      snapshots,
      exits,
      selectedExitId,
      mode,
      scale,
      bounds,
      toCanvas,
    );
  }, [
    snapshots,
    exits,
    projectedVerts,
    selectedExitId,
    mode,
    phase,
    canvasWidth,
    canvasHeight,
    scale,
    bounds,
  ]);

  // ---- Animation loop ----
  const loop = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return;
    const stepsPerFrame = Math.max(1, Math.round(simSpeed));
    for (let i = 0; i < stepsPerFrame; i++) eng.step();
    setSnapshots(eng.getSnapshots());
    setMetrics(eng.getMetrics());
    if (eng.getMetrics().remaining === 0) {
      setRunning(false);
      return;
    }
    rafRef.current = requestAnimationFrame(loop);
  }, [simSpeed]);

  useEffect(() => {
    if (running) {
      rafRef.current = requestAnimationFrame(loop);
    } else {
      cancelAnimationFrame(rafRef.current);
    }
    return () => cancelAnimationFrame(rafRef.current);
  }, [running, loop]);

  // ---- Canvas interaction ----
  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (projectedVerts.length < 3) return;
      const rect = canvasRef.current!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const { mx, my } = toSim(cx, cy);

      if (mode === 'place_exit') {
        const snap = nearestEdge(mx, my, projectedVerts);
        const maxW = edgeLength(projectedVerts, snap.edgeIndex) * 0.9;
        const w = Math.min(newExitWidth, maxW);
        const id = `exit-${++exitIdCounter}`;
        setExits((prev) => [
          ...prev,
          { id, center: snap.point, width: w, edgeIndex: snap.edgeIndex },
        ]);
        setMode('none');
        return;
      }

      if (mode === 'delete_exit') {
        const hit = findExitAt(mx, my, exits);
        if (hit) {
          setExits((prev) => prev.filter((ex) => ex.id !== hit.id));
          if (selectedExitId === hit.id) setSelectedExitId(null);
        }
        setMode('none');
        return;
      }

      const hit = findExitAt(mx, my, exits);
      if (hit) {
        setSelectedExitId(hit.id === selectedExitId ? null : hit.id);
      } else {
        setSelectedExitId(null);
      }
    },
    [mode, projectedVerts, exits, newExitWidth, selectedExitId],
  );

  const handleCanvasMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (projectedVerts.length < 3) return;
      const rect = canvasRef.current!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const { mx, my } = toSim(cx, cy);

      if (mode === 'place_exit') {
        const snap = nearestEdge(mx, my, projectedVerts);
        setHoverInfo(
          `Edge #${snap.edgeIndex} (${snap.point.x.toFixed(1)}, ${snap.point.y.toFixed(1)})`,
        );
      } else {
        const hit = findExitAt(mx, my, exits);
        setHoverInfo(
          hit
            ? `Exit "${hit.id}" — width: ${hit.width.toFixed(1)}m`
            : `(${mx.toFixed(1)}, ${my.toFixed(1)})`,
        );
      }
    },
    [mode, projectedVerts, exits],
  );

  const updateSelectedExitWidth = useCallback(
    (width: number) => {
      if (!selectedExitId) return;
      setExits((prev) => prev.map((ex) => (ex.id === selectedExitId ? { ...ex, width } : ex)));
    },
    [selectedExitId],
  );

  const handleReset = () => {
    cancelAnimationFrame(rafRef.current);
    initEngine();
  };

  const handleStart = () => {
    if (!engineRef.current || metrics?.remaining === 0) {
      initEngine();
      setTimeout(() => setRunning(true), 50);
    } else {
      setRunning(true);
    }
  };

  const selectedExit = exits.find((e) => e.id === selectedExitId) ?? null;
  const parsedLat = parseFloat(lat);
  const parsedLng = parseFloat(lng);
  const parsedRadius = parseInt(radius, 10) || 300;
  const selectedGrid = selectedGridIdx != null ? fetchResult?.grids[selectedGridIdx] : null;

  // ===========================================================================
  // RENDER
  // ===========================================================================

  return (
    <div className="min-h-screen bg-black text-green-400 font-mono p-4 flex flex-col">
      {/* Header */}
      <div className="border border-green-800 rounded p-3 mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg text-green-400 tracking-wider">
            [EVACUATION PARTICLE SIMULATION]
          </h1>
          <p className="text-xs text-green-700 mt-1">
            {phase === 'map'
              ? 'Select coordinates, fetch buildings, then click a building to simulate'
              : `Simulating: ${selectedGrid?.buildingName || `Building #${selectedGridIdx}`}`}
          </p>
        </div>
        <div className="flex gap-2">
          {phase === 'sim' && (
            <button
              onClick={backToMap}
              className="text-xs text-green-600 hover:text-green-400 border border-green-800 rounded px-2 py-1"
            >
              ← Back to Map
            </button>
          )}
          <a
            href="/debug/building-studs"
            className="text-xs text-green-600 hover:text-green-400 border border-green-800 rounded px-2 py-1"
          >
            Building Studs
          </a>
        </div>
      </div>

      {/* ================================================================= */}
      {/* PHASE 1: MAP */}
      {/* ================================================================= */}
      {phase === 'map' && (
        <>
          {/* Controls row */}
          <div className="flex flex-wrap gap-3 mb-4 items-end">
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
              className="bg-green-800 hover:bg-green-700 disabled:opacity-50 text-green-100 px-4 py-1.5 text-sm rounded border border-green-600 transition-colors"
            >
              {loading ? 'Fetching...' : 'Fetch Buildings'}
            </button>
          </div>

          {error && (
            <div className="bg-red-900/40 border border-red-700 text-red-300 px-3 py-2 text-sm rounded mb-4">
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-4 flex-1">
            {/* Map */}
            <div
              className="rounded border border-green-800 overflow-hidden"
              style={{ height: 600 }}
            >
              <MapContainer
                center={[
                  Number.isNaN(parsedLat) ? 1.3 : parsedLat,
                  Number.isNaN(parsedLng) ? 103.8 : parsedLng,
                ]}
                zoom={18}
                style={{ height: '100%', width: '100%' }}
                ref={mapRef}
              >
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <ClickHandler onClick={handleMapClick} />

                {/* Search radius */}
                {!Number.isNaN(parsedLat) && !Number.isNaN(parsedLng) && (
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
                )}

                {/* Center marker */}
                {!Number.isNaN(parsedLat) && !Number.isNaN(parsedLng) && (
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
                )}

                {/* Building polygons */}
                {fetchResult?.grids
                  .filter((g) => g.buildingIndex >= 0 && g.polygon.length >= 3)
                  .map((grid, idx) => (
                    <Polygon
                      key={`bldg-${grid.buildingIndex}`}
                      positions={grid.polygon.map(([la, ln]) => [la, ln] as [number, number])}
                      pathOptions={{
                        color: selectedGridIdx === idx ? '#22d3ee' : '#6366f1',
                        weight: selectedGridIdx === idx ? 3 : 2,
                        fillOpacity: selectedGridIdx === idx ? 0.2 : 0.08,
                        fillColor: selectedGridIdx === idx ? '#22d3ee' : '#818cf8',
                      }}
                      eventHandlers={{
                        click: () => selectBuilding(idx),
                      }}
                    />
                  ))}
              </MapContainer>
            </div>

            {/* Building list sidebar */}
            <div className="space-y-3 overflow-y-auto max-h-[600px]">
              <div className="bg-gray-900 border border-green-800 rounded p-3">
                <h2 className="text-sm text-green-500 mb-2 border-b border-green-900 pb-1">
                  Instructions
                </h2>
                <div className="text-xs text-green-700 space-y-1">
                  <p>1. Click the map to set coordinates</p>
                  <p>2. Click "Fetch Buildings" to load nearby structures</p>
                  <p>3. Click a building polygon on the map (or in the list) to start simulating</p>
                </div>
              </div>

              {fetchResult && (
                <div className="bg-gray-900 border border-green-800 rounded p-3">
                  <h2 className="text-sm text-green-500 mb-2 border-b border-green-900 pb-1">
                    Buildings ({fetchResult.grids.filter((g) => g.polygon.length >= 3).length})
                  </h2>
                  {fetchResult.grids.filter((g) => g.polygon.length >= 3).length === 0 && (
                    <p className="text-xs text-green-700 italic">
                      No buildings with polygons found.
                    </p>
                  )}
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
                              ? 'border-cyan-500 bg-cyan-900/20 text-cyan-300'
                              : 'border-green-900 bg-gray-800 text-green-400 hover:border-green-700'
                          }`}
                        >
                          <div className="font-semibold">
                            {grid.buildingName || `Building #${grid.buildingIndex}`}
                          </div>
                          <div className="text-green-700 mt-0.5">
                            {grid.polygon.length} pts · {grid.floors.length} floor(s)
                          </div>
                        </button>
                      ))}
                  </div>
                </div>
              )}

              {loading && (
                <div className="bg-gray-900 border border-green-800 rounded p-3 text-center">
                  <p className="text-xs text-green-400 animate-pulse">Querying Overpass API...</p>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* ================================================================= */}
      {/* PHASE 2: SIMULATION */}
      {/* ================================================================= */}
      {phase === 'sim' && projectedVerts.length >= 3 && (
        <div className="flex gap-4 flex-1 min-h-0">
          {/* Left panel — controls */}
          <div className="w-72 shrink-0 space-y-3 overflow-y-auto max-h-[calc(100vh-8rem)]">
            {/* Building info */}
            <div className="bg-gray-900 border border-green-800 rounded p-3">
              <h2 className="text-sm text-green-500 mb-2 border-b border-green-900 pb-1">
                Building
              </h2>
              <div className="text-xs text-green-300 font-semibold">
                {selectedGrid?.buildingName || `Building #${selectedGridIdx}`}
              </div>
              <div className="text-xs text-green-700 mt-1">
                {selectedGrid?.polygon.length} vertices · {bounds.width.toFixed(0)}m ×{' '}
                {bounds.height.toFixed(0)}m
              </div>
            </div>

            {/* Sim controls */}
            <div className="bg-gray-900 border border-green-800 rounded p-3">
              <h2 className="text-sm text-green-500 mb-2 border-b border-green-900 pb-1">
                Simulation
              </h2>
              <div className="flex gap-2 mb-3">
                {!running ? (
                  <button
                    onClick={handleStart}
                    disabled={exits.length === 0}
                    className="flex-1 px-2 py-1.5 text-xs font-semibold rounded bg-green-700 hover:bg-green-600 disabled:opacity-40 text-black"
                  >
                    ▶ START
                  </button>
                ) : (
                  <button
                    onClick={() => setRunning(false)}
                    className="flex-1 px-2 py-1.5 text-xs font-semibold rounded bg-amber-600 hover:bg-amber-500 text-black"
                  >
                    ⏸ PAUSE
                  </button>
                )}
                <button
                  onClick={handleReset}
                  className="flex-1 px-2 py-1.5 text-xs font-semibold rounded bg-red-800 hover:bg-red-700 text-white"
                >
                  ↺ RESET
                </button>
              </div>

              {exits.length === 0 && (
                <p className="text-xs text-amber-400 mb-2">Place at least one exit to start.</p>
              )}

              <label className="block text-xs text-green-600 mb-1">Speed: {simSpeed}x</label>
              <input
                type="range"
                min={1}
                max={10}
                step={1}
                value={simSpeed}
                onChange={(e) => setSimSpeed(Number(e.target.value))}
                className="w-full accent-green-500 mb-2"
              />

              <label className="block text-xs text-green-600 mb-1">
                Pedestrians: {pedestrianCount}
              </label>
              <input
                type="range"
                min={10}
                max={500}
                step={10}
                value={pedestrianCount}
                onChange={(e) => setPedestrianCount(Number(e.target.value))}
                className="w-full accent-green-500 mb-2"
                disabled={running}
              />

              <label className="block text-xs text-green-600 mb-1">
                Desired Speed: {desiredSpeed.toFixed(1)} m/s
              </label>
              <input
                type="range"
                min={0.5}
                max={3}
                step={0.1}
                value={desiredSpeed}
                onChange={(e) => setDesiredSpeed(Number(e.target.value))}
                className="w-full accent-green-500 mb-2"
              />

              <label className="block text-xs text-green-600 mb-1">
                Panic: {(panicFactor * 100).toFixed(0)}%
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={panicFactor}
                onChange={(e) => setPanicFactor(Number(e.target.value))}
                className="w-full accent-green-500"
              />
            </div>

            {/* Exit placement */}
            <div className="bg-gray-900 border border-green-800 rounded p-3">
              <h2 className="text-sm text-green-500 mb-2 border-b border-green-900 pb-1">
                Exit Placement
              </h2>
              <label className="block text-xs text-green-600 mb-1">
                New Exit Width: {newExitWidth.toFixed(1)}m
              </label>
              <input
                type="range"
                min={1}
                max={8}
                step={0.5}
                value={newExitWidth}
                onChange={(e) => setNewExitWidth(Number(e.target.value))}
                className="w-full accent-green-500 mb-3"
              />
              <div className="flex gap-2 mb-2">
                <button
                  onClick={() => setMode(mode === 'place_exit' ? 'none' : 'place_exit')}
                  className={`flex-1 px-2 py-1.5 text-xs font-semibold rounded border ${
                    mode === 'place_exit'
                      ? 'bg-green-700 border-green-500 text-black'
                      : 'bg-gray-800 border-green-900 text-green-400 hover:border-green-600'
                  }`}
                >
                  + Place Exit
                </button>
                <button
                  onClick={() => setMode(mode === 'delete_exit' ? 'none' : 'delete_exit')}
                  className={`flex-1 px-2 py-1.5 text-xs font-semibold rounded border ${
                    mode === 'delete_exit'
                      ? 'bg-red-700 border-red-500 text-white'
                      : 'bg-gray-800 border-green-900 text-green-400 hover:border-green-600'
                  }`}
                >
                  ✕ Delete Exit
                </button>
              </div>
              {mode === 'place_exit' && (
                <p className="text-xs text-amber-400 animate-pulse">Click on any wall edge...</p>
              )}
              {mode === 'delete_exit' && (
                <p className="text-xs text-red-400 animate-pulse">
                  Click on an exit to remove it...
                </p>
              )}
            </div>

            {/* Exit list */}
            <div className="bg-gray-900 border border-green-800 rounded p-3">
              <h2 className="text-sm text-green-500 mb-2 border-b border-green-900 pb-1">
                Exits ({exits.length})
              </h2>
              {exits.length === 0 && (
                <p className="text-xs text-green-700 italic">No exits placed yet.</p>
              )}
              <div className="space-y-2">
                {exits.map((ex) => {
                  const isSelected = ex.id === selectedExitId;
                  return (
                    <div
                      key={ex.id}
                      onClick={() => setSelectedExitId(isSelected ? null : ex.id)}
                      className={`p-2 rounded border cursor-pointer transition-colors ${
                        isSelected
                          ? 'border-cyan-500 bg-cyan-900/20'
                          : 'border-green-900 bg-gray-800 hover:border-green-700'
                      }`}
                    >
                      <div className="flex justify-between items-center text-xs">
                        <span className="text-green-300 font-semibold">Edge #{ex.edgeIndex}</span>
                        <span className="text-green-600">{ex.width.toFixed(1)}m</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Edit selected exit */}
            {selectedExit && (
              <div className="bg-gray-900 border border-cyan-800 rounded p-3">
                <h2 className="text-sm text-cyan-400 mb-2 border-b border-cyan-900 pb-1">
                  Edit Exit
                </h2>
                <label className="block text-xs text-cyan-600 mb-1">
                  Width: {selectedExit.width.toFixed(1)}m
                </label>
                <input
                  type="range"
                  min={0.5}
                  max={12}
                  step={0.5}
                  value={selectedExit.width}
                  onChange={(e) => updateSelectedExitWidth(Number(e.target.value))}
                  className="w-full accent-cyan-500 mb-2"
                />
                <button
                  onClick={() => {
                    setExits((prev) => prev.filter((ex) => ex.id !== selectedExitId));
                    setSelectedExitId(null);
                  }}
                  className="w-full px-2 py-1 text-xs rounded bg-red-800 hover:bg-red-700 text-white"
                >
                  Remove This Exit
                </button>
              </div>
            )}
          </div>

          {/* Center — canvas */}
          <div className="flex-1 flex flex-col items-center min-w-0">
            <div className="border border-green-800 rounded p-2 bg-gray-950 overflow-auto max-w-full">
              <canvas
                ref={canvasRef}
                width={canvasWidth}
                height={canvasHeight}
                onClick={handleCanvasClick}
                onMouseMove={handleCanvasMove}
                className={`block ${
                  mode === 'place_exit'
                    ? 'cursor-crosshair'
                    : mode === 'delete_exit'
                      ? 'cursor-not-allowed'
                      : 'cursor-default'
                }`}
              />
            </div>
            {hoverInfo && <div className="text-xs text-green-700 mt-1">{hoverInfo}</div>}
          </div>

          {/* Right panel — metrics */}
          <div className="w-64 shrink-0 space-y-3 overflow-y-auto max-h-[calc(100vh-8rem)]">
            {metrics && (
              <>
                <div className="bg-gray-900 border border-green-800 rounded p-3">
                  <h2 className="text-sm text-green-500 mb-2 border-b border-green-900 pb-1">
                    Live Metrics
                  </h2>
                  <div className="grid grid-cols-2 gap-y-1 text-xs">
                    <span className="text-green-600">Elapsed:</span>
                    <span className="text-green-300">{metrics.elapsed.toFixed(1)}s</span>
                    <span className="text-green-600">Total:</span>
                    <span className="text-green-300">{metrics.totalPedestrians}</span>
                    <span className="text-green-600">Evacuated:</span>
                    <span className="text-emerald-400">{metrics.evacuated}</span>
                    <span className="text-green-600">Remaining:</span>
                    <span className={metrics.remaining > 0 ? 'text-amber-400' : 'text-green-300'}>
                      {metrics.remaining}
                    </span>
                    <span className="text-green-600">Avg Speed:</span>
                    <span className="text-green-300">{metrics.avgSpeed.toFixed(2)} m/s</span>
                  </div>

                  <div className="mt-3">
                    <div className="flex justify-between text-xs text-green-600 mb-1">
                      <span>Progress</span>
                      <span>
                        {metrics.totalPedestrians > 0
                          ? ((metrics.evacuated / metrics.totalPedestrians) * 100).toFixed(0)
                          : 0}
                        %
                      </span>
                    </div>
                    <div className="w-full h-2 bg-gray-800 rounded overflow-hidden">
                      <div
                        className="h-full bg-green-500 transition-all duration-200"
                        style={{
                          width: `${metrics.totalPedestrians > 0 ? (metrics.evacuated / metrics.totalPedestrians) * 100 : 0}%`,
                        }}
                      />
                    </div>
                  </div>

                  {metrics.remaining === 0 && metrics.evacuated > 0 && (
                    <div className="mt-3 p-2 bg-green-900/30 border border-green-700 rounded text-center">
                      <span className="text-xs text-green-400 font-semibold">
                        COMPLETE — {metrics.elapsed.toFixed(1)}s
                      </span>
                    </div>
                  )}
                </div>

                <div className="bg-gray-900 border border-green-800 rounded p-3">
                  <h2 className="text-sm text-green-500 mb-2 border-b border-green-900 pb-1">
                    Exit Flow
                  </h2>
                  {metrics.exitFlows.map((ef) => {
                    const pct =
                      metrics!.totalPedestrians > 0
                        ? ((ef.count / metrics!.totalPedestrians) * 100).toFixed(0)
                        : '0';
                    const ex = exits.find((e) => e.id === ef.exitId);
                    return (
                      <div key={ef.exitId} className="mb-2">
                        <div className="flex justify-between text-xs">
                          <span className="text-green-400">Edge #{ex?.edgeIndex ?? '?'}</span>
                          <span className="text-green-300">
                            {ef.count} ({pct}%)
                          </span>
                        </div>
                        <div className="w-full h-1.5 bg-gray-800 rounded overflow-hidden mt-0.5">
                          <div
                            className="h-full bg-cyan-500 transition-all"
                            style={{
                              width: `${metrics!.totalPedestrians > 0 ? (ef.count / metrics!.totalPedestrians) * 100 : 0}%`,
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="bg-gray-900 border border-green-800 rounded p-3">
                  <h2 className="text-sm text-green-500 mb-2 border-b border-green-900 pb-1">
                    Speed Legend
                  </h2>
                  <div className="space-y-1 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="inline-block w-3 h-3 rounded-full bg-green-500" />
                      <span className="text-green-400">Moving freely (&gt; 0.8 m/s)</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="inline-block w-3 h-3 rounded-full bg-amber-500" />
                      <span className="text-green-400">Congested (0.3–0.8 m/s)</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="inline-block w-3 h-3 rounded-full bg-red-500" />
                      <span className="text-green-400">Jammed (&lt; 0.3 m/s)</span>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Helper functions
// ===========================================================================

function findExitAt(mx: number, my: number, exits: ExitDef[]): ExitDef | null {
  for (const ex of exits) {
    const dx = Math.abs(mx - ex.center.x);
    const dy = Math.abs(my - ex.center.y);
    if (dx < ex.width / 2 + 0.8 && dy < ex.width / 2 + 0.8) return ex;
  }
  return null;
}

// ===========================================================================
// Canvas draw
// ===========================================================================

function drawSim(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  verts: Vec2[],
  snapshots: PedSnapshot[],
  exits: ExitDef[],
  selectedExitId: string | null,
  mode: InteractionMode,
  _scale: number,
  _bounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
  },
  toCanvas: (mx: number, my: number) => { cx: number; cy: number },
) {
  ctx.clearRect(0, 0, cw, ch);
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, cw, ch);

  if (verts.length < 3) return;

  // Floor fill
  ctx.beginPath();
  const first = toCanvas(verts[0].x, verts[0].y);
  ctx.moveTo(first.cx, first.cy);
  for (let i = 1; i < verts.length; i++) {
    const p = toCanvas(verts[i].x, verts[i].y);
    ctx.lineTo(p.cx, p.cy);
  }
  ctx.closePath();
  ctx.fillStyle = '#111827';
  ctx.fill();

  // Grid lines (5m spacing within bounds)
  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = 0.5;
  const stepM = 5;
  const gridMinX = Math.floor(_bounds.minX / stepM) * stepM;
  const gridMaxX = Math.ceil(_bounds.maxX / stepM) * stepM;
  const gridMinY = Math.floor(_bounds.minY / stepM) * stepM;
  const gridMaxY = Math.ceil(_bounds.maxY / stepM) * stepM;

  for (let gx = gridMinX; gx <= gridMaxX; gx += stepM) {
    const p1 = toCanvas(gx, _bounds.minY);
    const p2 = toCanvas(gx, _bounds.maxY);
    ctx.beginPath();
    ctx.moveTo(p1.cx, p1.cy);
    ctx.lineTo(p2.cx, p2.cy);
    ctx.stroke();
  }
  for (let gy = gridMinY; gy <= gridMaxY; gy += stepM) {
    const p1 = toCanvas(_bounds.minX, gy);
    const p2 = toCanvas(_bounds.maxX, gy);
    ctx.beginPath();
    ctx.moveTo(p1.cx, p1.cy);
    ctx.lineTo(p2.cx, p2.cy);
    ctx.stroke();
  }

  // Scale labels
  ctx.fillStyle = '#374151';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  for (let gx = gridMinX; gx <= gridMaxX; gx += stepM) {
    const p = toCanvas(gx, _bounds.maxY);
    ctx.fillText(`${gx.toFixed(0)}m`, p.cx, p.cy + 14);
  }

  // Building outline (walls)
  ctx.strokeStyle = '#4ade80';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(first.cx, first.cy);
  for (let i = 1; i < verts.length; i++) {
    const p = toCanvas(verts[i].x, verts[i].y);
    ctx.lineTo(p.cx, p.cy);
  }
  ctx.closePath();
  ctx.stroke();

  // Edge index labels
  ctx.fillStyle = '#374151';
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const mid = toCanvas((a.x + b.x) / 2, (a.y + b.y) / 2);
    const nx = -(b.y - a.y);
    const ny = b.x - a.x;
    const nl = Math.hypot(nx, ny);
    if (nl > 0) {
      const offset = 10;
      ctx.fillText(`${i}`, mid.cx + (nx / nl) * offset, mid.cy + (ny / nl) * offset);
    }
  }

  // Exits
  for (const exit of exits) {
    const isSelected = exit.id === selectedExitId;
    const ec = toCanvas(exit.center.x, exit.center.y);

    // Draw exit gap (erase wall segment)
    const i = exit.edgeIndex;
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const edgeDx = b.x - a.x;
    const edgeDy = b.y - a.y;
    const edgeLen = Math.hypot(edgeDx, edgeDy);
    if (edgeLen < 0.01) continue;

    const halfW = exit.width / 2;
    const tCenter =
      ((exit.center.x - a.x) * edgeDx + (exit.center.y - a.y) * edgeDy) / (edgeLen * edgeLen);
    const tStart = Math.max(0, tCenter - halfW / edgeLen);
    const tEnd = Math.min(1, tCenter + halfW / edgeLen);

    const p1 = toCanvas(a.x + tStart * edgeDx, a.y + tStart * edgeDy);
    const p2 = toCanvas(a.x + tEnd * edgeDx, a.y + tEnd * edgeDy);

    // Black gap over wall
    ctx.strokeStyle = '#0a0a0a';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(p1.cx, p1.cy);
    ctx.lineTo(p2.cx, p2.cy);
    ctx.stroke();

    // Cyan dashes for exit
    ctx.strokeStyle = isSelected ? '#06b6d4' : '#22d3ee';
    ctx.lineWidth = isSelected ? 3 : 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(p1.cx, p1.cy);
    ctx.lineTo(p2.cx, p2.cy);
    ctx.stroke();
    ctx.setLineDash([]);

    // EXIT label
    ctx.fillStyle = isSelected ? '#06b6d4' : '#22d3ee';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    // Offset label outward from edge
    const enx = -(edgeDy / edgeLen);
    const eny = edgeDx / edgeLen;
    ctx.fillText('EXIT', ec.cx + enx * 14, ec.cy + eny * 14 + 3);
  }

  // Pedestrians
  const pedR = Math.max(0.25 * _scale, 2.5);
  for (const ped of snapshots) {
    if (ped.evacuated) continue;
    const p = toCanvas(ped.x, ped.y);
    const color = speedColor(ped.speed);
    ctx.beginPath();
    ctx.arc(p.cx, p.cy, pedR, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Mode overlay
  if (mode !== 'none') {
    ctx.beginPath();
    ctx.moveTo(first.cx, first.cy);
    for (let i = 1; i < verts.length; i++) {
      const p = toCanvas(verts[i].x, verts[i].y);
      ctx.lineTo(p.cx, p.cy);
    }
    ctx.closePath();
    ctx.fillStyle = mode === 'place_exit' ? 'rgba(34, 211, 238, 0.1)' : 'rgba(239, 68, 68, 0.08)';
    ctx.fill();
  }
}
