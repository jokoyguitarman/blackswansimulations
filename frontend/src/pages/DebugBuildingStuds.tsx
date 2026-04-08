import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  MapContainer,
  TileLayer,
  Polygon,
  CircleMarker,
  Circle,
  Polyline,
  useMapEvents,
} from 'react-leaflet';
import { supabase } from '../lib/supabase';
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
// Types
// ---------------------------------------------------------------------------

interface StudItem {
  id: string;
  lat: number;
  lng: number;
  floor: string;
  studType: 'building' | 'outdoor';
  blastBand: string | null;
  operationalZone: string | null;
  distFromIncidentM: number | null;
}

interface GridItem {
  buildingIndex: number;
  buildingName: string | null;
  polygon: [number, number][];
  floors: string[];
  spacingM: number;
  studs: StudItem[];
}

interface BuildingSummary {
  name: string | null;
  lat: number;
  lng: number;
  levels: number | null;
  use: string | null;
  polygonPoints: number;
}

interface BandInfo {
  band: string;
  minM: number;
  maxM: number;
}

interface Stats {
  fetchMs: number;
  gridMs: number;
  buildingsReturned: number;
  buildingsWithPolygon: number;
  gridsGenerated: number;
  totalStuds: number;
  buildingStuds: number;
  outdoorStuds: number;
  bandCounts: Record<string, number>;
  weaponClass: string;
  blastBands: BandInfo[];
  payloadSizeKB: number;
  fetchError: string | null;
}

interface DebugResult {
  stats: Stats;
  buildings: BuildingSummary[];
  grids: GridItem[];
}

interface SnapResult {
  input: { lat: number; lng: number; floor: string };
  snapped: { lat: number; lng: number; studId: string | null };
  snapDistM: number | null;
  studMetadata: StudItem | null;
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const ZONE_COLORS: Record<string, { color: string; fill: string }> = {
  kill: { color: '#ef4444', fill: '#f87171' },
  critical: { color: '#f97316', fill: '#fb923c' },
  serious: { color: '#eab308', fill: '#facc15' },
  minor: { color: '#3b82f6', fill: '#60a5fa' },
};

const BAND_CIRCLE_COLORS: Record<string, string> = {
  kill: '#ef4444',
  critical: '#f97316',
  serious: '#eab308',
  minor: '#3b82f6',
};

const DEFAULT_STUD_STYLE = { color: '#6366f1', fill: '#818cf8' };

function getStudStyle(stud: StudItem, isSelected: boolean) {
  const isOutdoor = stud.studType === 'outdoor';
  const zoneStyle = stud.blastBand ? ZONE_COLORS[stud.blastBand] : null;
  const colors = zoneStyle ?? DEFAULT_STUD_STYLE;

  if (isSelected) {
    return {
      color: '#ffffff',
      fillColor: colors.fill,
      fillOpacity: 1,
      weight: 2,
      radius: 6,
    };
  }

  return {
    color: colors.color,
    fillColor: colors.fill,
    fillOpacity: isOutdoor ? 0.45 : 0.65,
    weight: isOutdoor ? 0.5 : 1,
    radius: isOutdoor ? 2 : 3,
  };
}

// ---------------------------------------------------------------------------
// Map click handler
// ---------------------------------------------------------------------------

type ClickMode = 'coordinates' | 'hazard' | 'snap';

function ClickHandler({
  mode,
  onCoordClick,
  onHazardClick,
  onSnapClick,
}: {
  mode: ClickMode;
  onCoordClick: (lat: number, lng: number) => void;
  onHazardClick: (lat: number, lng: number) => void;
  onSnapClick: (lat: number, lng: number) => void;
}) {
  useMapEvents({
    click(e) {
      if (mode === 'hazard') onHazardClick(e.latlng.lat, e.latlng.lng);
      else if (mode === 'snap') onSnapClick(e.latlng.lat, e.latlng.lng);
      else onCoordClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DebugBuildingStuds() {
  const [lat, setLat] = useState('1.2989008');
  const [lng, setLng] = useState('103.855176');
  const [radius, setRadius] = useState('300');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DebugResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeFloor, setActiveFloor] = useState('G');
  const mapRef = useRef<L.Map | null>(null);

  // Hazard center
  const [hazardLat, setHazardLat] = useState<number | null>(null);
  const [hazardLng, setHazardLng] = useState<number | null>(null);
  const [weaponClass, setWeaponClass] = useState<string>('explosive');

  // Click mode
  const [clickMode, setClickMode] = useState<ClickMode>('coordinates');

  // Inspector
  const [selectedStud, setSelectedStud] = useState<StudItem | null>(null);
  const [selectedGridName, setSelectedGridName] = useState<string | null>(null);

  // Snap test
  const [snapResult, setSnapResult] = useState<SnapResult | null>(null);
  const [snapLoading, setSnapLoading] = useState(false);
  const [occupiedIds, setOccupiedIds] = useState<Set<string>>(new Set());
  const [snapFloor, setSnapFloor] = useState('G');

  const handleCoordClick = useCallback((clickLat: number, clickLng: number) => {
    setLat(clickLat.toFixed(7));
    setLng(clickLng.toFixed(7));
    setResult(null);
    setError(null);
    setSelectedStud(null);
    setSnapResult(null);
  }, []);

  const handleHazardClick = useCallback((clickLat: number, clickLng: number) => {
    setHazardLat(clickLat);
    setHazardLng(clickLng);
    setClickMode('coordinates');
  }, []);

  const handleSnapClick = useCallback(
    async (clickLat: number, clickLng: number) => {
      setSnapLoading(true);
      try {
        const headers = await getAuthHeaders();
        const res = await fetch(apiUrl('/api/debug/snap-test'), {
          method: 'POST',
          headers,
          body: JSON.stringify({
            lat: clickLat,
            lng: clickLng,
            floor: snapFloor,
            occupiedStudIds: [...occupiedIds],
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const data: SnapResult = await res.json();
        setSnapResult(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSnapLoading(false);
      }
    },
    [snapFloor, occupiedIds],
  );

  const handleFetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    setSelectedStud(null);
    setSnapResult(null);
    try {
      const headers = await getAuthHeaders();
      const params = new URLSearchParams({ lat, lng, radius });
      if (hazardLat != null && hazardLng != null) {
        params.set('hazardLat', hazardLat.toFixed(7));
        params.set('hazardLng', hazardLng.toFixed(7));
        params.set('weaponClass', weaponClass);
      }
      const res = await fetch(apiUrl(`/api/debug/building-studs?${params}`), { headers });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data: DebugResult = await res.json();
      setResult(data);
      if (data.grids.length > 0) {
        const floors = [...new Set(data.grids.flatMap((g) => g.floors))];
        if (floors.length > 0 && !floors.includes(activeFloor)) {
          setActiveFloor(floors[0]);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [lat, lng, radius, activeFloor, hazardLat, hazardLng, weaponClass]);

  useEffect(() => {
    if (mapRef.current) {
      const parsedLat = parseFloat(lat);
      const parsedLng = parseFloat(lng);
      if (!Number.isNaN(parsedLat) && !Number.isNaN(parsedLng)) {
        mapRef.current.setView([parsedLat, parsedLng], mapRef.current.getZoom());
      }
    }
  }, [lat, lng]);

  const allFloors = result ? [...new Set(result.grids.flatMap((g) => g.floors))].sort() : [];

  const filteredStuds = useMemo(() => {
    if (!result) return [];
    return result.grids.flatMap((g) =>
      g.studs
        .filter((s) => s.floor === activeFloor)
        .map((s) => ({ ...s, _gridName: g.buildingName })),
    );
  }, [result, activeFloor]);

  const parsedLat = parseFloat(lat);
  const parsedLng = parseFloat(lng);
  const parsedRadius = parseInt(radius, 10) || 300;

  const handleStudClick = useCallback((stud: StudItem & { _gridName: string | null }) => {
    setSelectedStud(stud);
    setSelectedGridName(
      stud.studType === 'building' ? (stud._gridName ?? `Building ${stud.id.split('-')[1]}`) : null,
    );
  }, []);

  const modeLabel: Record<ClickMode, string> = {
    coordinates: 'Set Coordinates',
    hazard: 'Set Hazard Center',
    snap: 'Snap Test',
  };

  const modeButtonClass = (m: ClickMode) =>
    `px-3 py-1 text-xs rounded border transition-colors ${
      clickMode === m
        ? 'bg-green-700 border-green-500 text-green-100'
        : 'bg-gray-900 border-green-800 text-green-600 hover:text-green-400'
    }`;

  return (
    <div className="min-h-screen bg-black text-green-400 font-mono">
      <div className="max-w-[1800px] mx-auto p-4">
        <h1 className="text-xl mb-4 text-green-300 border-b border-green-800 pb-2">
          [DEBUG] Building Studs &amp; Blast Radius Diagnostic
        </h1>

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
          <div>
            <label className="block text-xs text-green-600 mb-1">Weapon Class</label>
            <select
              value={weaponClass}
              onChange={(e) => setWeaponClass(e.target.value)}
              className="bg-gray-900 border border-green-800 text-green-300 px-2 py-1 text-sm rounded"
            >
              <option value="explosive">Explosive</option>
              <option value="melee">Melee</option>
              <option value="default">Default</option>
            </select>
          </div>
          {allFloors.length > 1 && (
            <div>
              <label className="block text-xs text-green-600 mb-1">Floor</label>
              <select
                value={activeFloor}
                onChange={(e) => setActiveFloor(e.target.value)}
                className="bg-gray-900 border border-green-800 text-green-300 px-2 py-1 text-sm rounded"
              >
                {allFloors.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button
            onClick={handleFetch}
            disabled={loading}
            className="bg-green-800 hover:bg-green-700 disabled:opacity-50 text-green-100 px-4 py-1.5 text-sm rounded border border-green-600 transition-colors"
          >
            {loading ? 'Fetching...' : 'Fetch & Generate'}
          </button>
        </div>

        {/* Click mode toggles */}
        <div className="flex gap-2 mb-4 items-center">
          <span className="text-xs text-green-600 mr-1">Click mode:</span>
          {(Object.keys(modeLabel) as ClickMode[]).map((m) => (
            <button key={m} onClick={() => setClickMode(m)} className={modeButtonClass(m)}>
              {modeLabel[m]}
            </button>
          ))}
          {hazardLat != null && hazardLng != null && (
            <span className="text-xs text-red-400 ml-2">
              Hazard: {hazardLat.toFixed(5)}, {hazardLng.toFixed(5)}
            </span>
          )}
          {hazardLat != null && (
            <button
              onClick={() => {
                setHazardLat(null);
                setHazardLng(null);
              }}
              className="text-xs text-red-500 hover:text-red-400 underline ml-1"
            >
              Clear
            </button>
          )}
        </div>

        {error && (
          <div className="bg-red-900/40 border border-red-700 text-red-300 px-3 py-2 text-sm rounded mb-4">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-4">
          {/* Map */}
          <div className="rounded border border-green-800 overflow-hidden" style={{ height: 640 }}>
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
              <ClickHandler
                mode={clickMode}
                onCoordClick={handleCoordClick}
                onHazardClick={handleHazardClick}
                onSnapClick={handleSnapClick}
              />

              {/* Search radius circle */}
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

              {/* Hazard center marker */}
              {hazardLat != null && hazardLng != null && (
                <CircleMarker
                  center={[hazardLat, hazardLng]}
                  radius={8}
                  pathOptions={{
                    color: '#ef4444',
                    fillColor: '#dc2626',
                    fillOpacity: 0.9,
                    weight: 3,
                  }}
                />
              )}

              {/* Blast band reference circles */}
              {hazardLat != null &&
                hazardLng != null &&
                result?.stats.blastBands?.map((b) => (
                  <Circle
                    key={`band-${b.band}`}
                    center={[hazardLat, hazardLng]}
                    radius={b.maxM}
                    pathOptions={{
                      color: BAND_CIRCLE_COLORS[b.band] ?? '#888',
                      weight: 1,
                      fillOpacity: 0,
                      dashArray: '5, 5',
                    }}
                  />
                ))}

              {/* Building polygons */}
              {result?.grids
                .filter((g) => g.buildingIndex >= 0)
                .map((grid) => (
                  <Polygon
                    key={`bldg-${grid.buildingIndex}`}
                    positions={grid.polygon.map(([la, ln]) => [la, ln] as [number, number])}
                    pathOptions={{
                      color: '#6366f1',
                      weight: 2,
                      fillOpacity: 0.08,
                      fillColor: '#818cf8',
                    }}
                  />
                ))}

              {/* Stud dots */}
              {filteredStuds.map((stud) => {
                const isOccupied = occupiedIds.has(stud.id);
                const isSelected = selectedStud?.id === stud.id;
                const style = isOccupied
                  ? {
                      color: '#94a3b8',
                      fillColor: '#475569',
                      fillOpacity: 0.3,
                      weight: 0.5,
                      radius: 2,
                    }
                  : getStudStyle(stud, isSelected);

                return (
                  <CircleMarker
                    key={stud.id}
                    center={[stud.lat, stud.lng]}
                    radius={style.radius}
                    pathOptions={{
                      color: style.color,
                      fillColor: style.fillColor,
                      fillOpacity: style.fillOpacity,
                      weight: style.weight,
                    }}
                    interactive={true}
                    eventHandlers={{
                      click: () => handleStudClick(stud),
                    }}
                  />
                );
              })}

              {/* Snap result visualization */}
              {snapResult?.snapped.studId && (
                <>
                  {/* Line from click to snapped stud */}
                  <Polyline
                    positions={[
                      [snapResult.input.lat, snapResult.input.lng],
                      [snapResult.snapped.lat, snapResult.snapped.lng],
                    ]}
                    pathOptions={{
                      color: '#22c55e',
                      weight: 2,
                      dashArray: '4, 4',
                    }}
                  />
                  {/* Click point */}
                  <CircleMarker
                    center={[snapResult.input.lat, snapResult.input.lng]}
                    radius={4}
                    pathOptions={{
                      color: '#f97316',
                      fillColor: '#fb923c',
                      fillOpacity: 0.9,
                      weight: 2,
                    }}
                  />
                  {/* Snapped stud highlight */}
                  <CircleMarker
                    center={[snapResult.snapped.lat, snapResult.snapped.lng]}
                    radius={7}
                    pathOptions={{
                      color: '#22c55e',
                      fillColor: '#4ade80',
                      fillOpacity: 0.8,
                      weight: 2,
                    }}
                  />
                </>
              )}
            </MapContainer>
          </div>

          {/* Right sidebar */}
          <div className="space-y-3 max-h-[640px] overflow-y-auto">
            {/* Instructions */}
            <div className="bg-gray-900 border border-green-800 rounded p-3">
              <h2 className="text-sm text-green-500 mb-2 border-b border-green-900 pb-1">
                Instructions
              </h2>
              <p className="text-xs text-green-600 leading-relaxed">
                1. Click map to set center coordinates, then &quot;Fetch &amp; Generate&quot;.
                <br />
                2. Switch to &quot;Set Hazard Center&quot; and click map to place an explosion.
                <br />
                3. &quot;Fetch &amp; Generate&quot; again to see blast radius studs.
                <br />
                4. Click any stud to inspect its metadata.
                <br />
                5. Switch to &quot;Snap Test&quot; to test pin snap placement.
              </p>
            </div>

            {/* Stud Inspector */}
            {selectedStud && (
              <div className="bg-gray-900 border border-green-800 rounded p-3">
                <h2 className="text-sm text-green-500 mb-2 border-b border-green-900 pb-1">
                  Stud Inspector
                </h2>
                <div className="grid grid-cols-[100px_1fr] gap-y-1 text-xs">
                  <span className="text-green-600">ID:</span>
                  <span className="text-green-300 break-all">{selectedStud.id}</span>

                  <span className="text-green-600">Type:</span>
                  <span
                    className={
                      selectedStud.studType === 'building' ? 'text-indigo-400' : 'text-amber-400'
                    }
                  >
                    {selectedStud.studType === 'building' ? 'BUILDING (indoor)' : 'OUTDOOR'}
                  </span>

                  {selectedStud.studType === 'building' && selectedGridName && (
                    <>
                      <span className="text-green-600">Building:</span>
                      <span className="text-green-300">{selectedGridName}</span>
                    </>
                  )}

                  <span className="text-green-600">Floor:</span>
                  <span className="text-green-300">{selectedStud.floor}</span>

                  <span className="text-green-600">Blast Band:</span>
                  <span className="flex items-center gap-1.5">
                    {selectedStud.blastBand ? (
                      <>
                        <span
                          className="inline-block w-3 h-3 rounded-sm"
                          style={{
                            backgroundColor: ZONE_COLORS[selectedStud.blastBand]?.fill ?? '#6366f1',
                          }}
                        />
                        <span className="text-green-300 uppercase">{selectedStud.blastBand}</span>
                      </>
                    ) : (
                      <span className="text-green-700">N/A</span>
                    )}
                  </span>

                  <span className="text-green-600">Op. Zone:</span>
                  <span className="text-green-300">{selectedStud.operationalZone ?? 'N/A'}</span>

                  <span className="text-green-600">Dist (m):</span>
                  <span className="text-green-300">
                    {selectedStud.distFromIncidentM != null
                      ? `${selectedStud.distFromIncidentM}m`
                      : 'N/A'}
                  </span>

                  <span className="text-green-600">Lat/Lng:</span>
                  <span className="text-green-300 text-[10px]">
                    {selectedStud.lat.toFixed(7)}, {selectedStud.lng.toFixed(7)}
                  </span>
                </div>
              </div>
            )}

            {/* Snap Test Panel */}
            <div className="bg-gray-900 border border-green-800 rounded p-3">
              <h2 className="text-sm text-green-500 mb-2 border-b border-green-900 pb-1">
                Snap-to-Place Test
              </h2>
              <p className="text-xs text-green-700 mb-2">
                Switch click mode to &quot;Snap Test&quot;, then click inside a building to test
                snap placement.
              </p>
              <div className="flex gap-2 items-center mb-2">
                <label className="text-xs text-green-600">Floor:</label>
                <select
                  value={snapFloor}
                  onChange={(e) => setSnapFloor(e.target.value)}
                  className="bg-gray-900 border border-green-800 text-green-300 px-2 py-0.5 text-xs rounded"
                >
                  {(allFloors.length > 0 ? allFloors : ['G']).map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => setOccupiedIds(new Set())}
                  className="text-xs text-red-500 hover:text-red-400 underline ml-auto"
                >
                  Clear Occupancy ({occupiedIds.size})
                </button>
              </div>

              {snapLoading && <p className="text-xs text-green-400 animate-pulse">Snapping...</p>}

              {snapResult && (
                <div className="space-y-2 mt-2">
                  <div className="grid grid-cols-[90px_1fr] gap-y-1 text-xs">
                    <span className="text-green-600">Click at:</span>
                    <span className="text-orange-300">
                      {snapResult.input.lat.toFixed(7)}, {snapResult.input.lng.toFixed(7)}
                    </span>

                    <span className="text-green-600">Snapped to:</span>
                    <span className="text-green-300">
                      {snapResult.snapped.studId ? (
                        <>
                          {snapResult.snapped.lat.toFixed(7)}, {snapResult.snapped.lng.toFixed(7)}
                        </>
                      ) : (
                        <span className="text-red-400">NO MATCH</span>
                      )}
                    </span>

                    <span className="text-green-600">Stud ID:</span>
                    <span className="text-green-300 break-all">
                      {snapResult.snapped.studId ?? '—'}
                    </span>

                    <span className="text-green-600">Snap dist:</span>
                    <span className="text-green-300">
                      {snapResult.snapDistM != null ? `${snapResult.snapDistM}m` : '—'}
                    </span>

                    {snapResult.studMetadata && (
                      <>
                        <span className="text-green-600">Type:</span>
                        <span
                          className={
                            snapResult.studMetadata.studType === 'building'
                              ? 'text-indigo-400'
                              : 'text-amber-400'
                          }
                        >
                          {snapResult.studMetadata.studType}
                        </span>

                        <span className="text-green-600">Band:</span>
                        <span className="flex items-center gap-1">
                          {snapResult.studMetadata.blastBand && (
                            <span
                              className="inline-block w-2.5 h-2.5 rounded-sm"
                              style={{
                                backgroundColor:
                                  ZONE_COLORS[snapResult.studMetadata.blastBand]?.fill ?? '#888',
                              }}
                            />
                          )}
                          <span className="text-green-300">
                            {snapResult.studMetadata.blastBand ?? 'N/A'}
                          </span>
                        </span>

                        <span className="text-green-600">Op. Zone:</span>
                        <span className="text-green-300">
                          {snapResult.studMetadata.operationalZone ?? 'N/A'}
                        </span>
                      </>
                    )}
                  </div>

                  {snapResult.snapped.studId && (
                    <button
                      onClick={() => {
                        if (snapResult.snapped.studId) {
                          setOccupiedIds((prev) => {
                            const next = new Set(prev);
                            next.add(snapResult.snapped.studId!);
                            return next;
                          });
                        }
                      }}
                      disabled={occupiedIds.has(snapResult.snapped.studId)}
                      className="bg-amber-800 hover:bg-amber-700 disabled:opacity-40 text-amber-100 px-3 py-1 text-xs rounded border border-amber-600 transition-colors w-full"
                    >
                      {occupiedIds.has(snapResult.snapped.studId)
                        ? 'Already Occupied'
                        : 'Mark as Occupied'}
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Stats */}
            {result && (
              <>
                <div className="bg-gray-900 border border-green-800 rounded p-3">
                  <h2 className="text-sm text-green-500 mb-2 border-b border-green-900 pb-1">
                    Fetch Stats
                  </h2>
                  <div className="grid grid-cols-2 gap-y-1 text-xs">
                    <span className="text-green-600">Overpass fetch:</span>
                    <span className={result.stats.fetchError ? 'text-red-400' : 'text-green-300'}>
                      {result.stats.fetchMs}ms
                      {result.stats.fetchError && ' (FAILED)'}
                    </span>
                    <span className="text-green-600">Grid generation:</span>
                    <span className="text-green-300">{result.stats.gridMs}ms</span>
                    <span className="text-green-600">Buildings returned:</span>
                    <span className="text-green-300">{result.stats.buildingsReturned}</span>
                    <span className="text-green-600">With polygon:</span>
                    <span className="text-green-300">{result.stats.buildingsWithPolygon}</span>
                    <span className="text-green-600">Grids generated:</span>
                    <span className="text-green-300">{result.stats.gridsGenerated}</span>
                  </div>
                  {result.stats.fetchError && (
                    <div className="mt-2 text-xs text-red-400 bg-red-900/30 p-2 rounded break-all">
                      {result.stats.fetchError}
                    </div>
                  )}
                </div>

                {/* Stud counts */}
                <div className="bg-gray-900 border border-green-800 rounded p-3">
                  <h2 className="text-sm text-green-500 mb-2 border-b border-green-900 pb-1">
                    Stud Counts
                  </h2>
                  <div className="grid grid-cols-2 gap-y-1 text-xs">
                    <span className="text-green-600">Total studs:</span>
                    <span className="text-green-300">{result.stats.totalStuds}</span>
                    <span className="text-green-600">Building (indoor):</span>
                    <span className="text-indigo-400">{result.stats.buildingStuds}</span>
                    <span className="text-green-600">Outdoor (blast):</span>
                    <span className="text-amber-400">{result.stats.outdoorStuds}</span>
                    <span className="text-green-600">On floor {activeFloor}:</span>
                    <span className="text-green-300">{filteredStuds.length}</span>
                    <span className="text-green-600">Weapon class:</span>
                    <span className="text-green-300 uppercase">{result.stats.weaponClass}</span>
                    <span className="text-green-600">Payload size:</span>
                    <span className="text-green-300">{result.stats.payloadSizeKB} KB</span>
                  </div>

                  {Object.keys(result.stats.bandCounts).length > 0 && (
                    <div className="mt-2 pt-2 border-t border-green-900">
                      <span className="text-xs text-green-600">Per-band:</span>
                      <div className="grid grid-cols-2 gap-y-1 text-xs mt-1">
                        {['kill', 'critical', 'serious', 'minor'].map((band) => (
                          <React.Fragment key={band}>
                            <span className="flex items-center gap-1">
                              <span
                                className="inline-block w-2.5 h-2.5 rounded-sm"
                                style={{
                                  backgroundColor: ZONE_COLORS[band]?.fill ?? '#888',
                                }}
                              />
                              <span className="text-green-400 uppercase">{band}:</span>
                            </span>
                            <span className="text-green-300">
                              {result.stats.bandCounts[band] ?? 0}
                            </span>
                          </React.Fragment>
                        ))}
                      </div>
                    </div>
                  )}

                  {result.stats.blastBands.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-green-900">
                      <span className="text-xs text-green-600">Band radii:</span>
                      <div className="text-xs text-green-700 mt-1 space-y-0.5">
                        {result.stats.blastBands.map((b) => (
                          <div key={b.band}>
                            {b.band.toUpperCase()}: {b.minM}–{b.maxM}m
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Buildings list */}
                {result.buildings.length > 0 && (
                  <div className="bg-gray-900 border border-green-800 rounded p-3 max-h-40 overflow-y-auto">
                    <h2 className="text-sm text-green-500 mb-2 border-b border-green-900 pb-1">
                      Buildings ({result.buildings.length})
                    </h2>
                    <div className="space-y-1">
                      {result.buildings.map((b, i) => (
                        <div key={i} className="text-xs text-green-400">
                          <span className="text-green-600">#{i + 1}</span> {b.name || '(unnamed)'}
                          <span className="text-green-700 ml-1">
                            {b.polygonPoints}pts
                            {b.levels && ` · ${b.levels}F`}
                            {b.use && ` · ${b.use}`}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {!result && !loading && (
              <div className="bg-gray-900 border border-green-800 rounded p-3 text-center">
                <p className="text-xs text-green-700">No data yet. Click the map and fetch.</p>
              </div>
            )}

            {loading && (
              <div className="bg-gray-900 border border-green-800 rounded p-3 text-center">
                <p className="text-xs text-green-400 animate-pulse">Querying Overpass API...</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
