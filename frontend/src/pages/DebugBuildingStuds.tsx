import { useState, useCallback, useRef, useEffect } from 'react';
import {
  MapContainer,
  TileLayer,
  Polygon,
  CircleMarker,
  Circle,
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

interface StudItem {
  id: string;
  lat: number;
  lng: number;
  floor: string;
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

interface Stats {
  fetchMs: number;
  gridMs: number;
  buildingsReturned: number;
  buildingsWithPolygon: number;
  gridsGenerated: number;
  totalStuds: number;
  payloadSizeKB: number;
  fetchError: string | null;
}

interface DebugResult {
  stats: Stats;
  buildings: BuildingSummary[];
  grids: GridItem[];
}

function ClickHandler({ onClick }: { onClick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

export function DebugBuildingStuds() {
  const [lat, setLat] = useState('1.2989008');
  const [lng, setLng] = useState('103.855176');
  const [radius, setRadius] = useState('300');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DebugResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeFloor, setActiveFloor] = useState('G');
  const mapRef = useRef<L.Map | null>(null);

  const handleMapClick = useCallback((clickLat: number, clickLng: number) => {
    setLat(clickLat.toFixed(7));
    setLng(clickLng.toFixed(7));
    setResult(null);
    setError(null);
  }, []);

  const handleFetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const headers = await getAuthHeaders();
      const params = new URLSearchParams({ lat, lng, radius });
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
  }, [lat, lng, radius, activeFloor]);

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

  const filteredStuds = result
    ? result.grids.flatMap((g) => g.studs.filter((s) => s.floor === activeFloor))
    : [];

  const parsedLat = parseFloat(lat);
  const parsedLng = parseFloat(lng);
  const parsedRadius = parseInt(radius, 10) || 300;

  return (
    <div className="min-h-screen bg-black text-green-400 font-mono">
      <div className="max-w-[1600px] mx-auto p-4">
        <h1 className="text-xl mb-4 text-green-300 border-b border-green-800 pb-2">
          [DEBUG] Building Studs Diagnostic
        </h1>

        {/* Controls */}
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
            {loading ? 'Fetching...' : 'Fetch & Generate'}
          </button>
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
        </div>

        {error && (
          <div className="bg-red-900/40 border border-red-700 text-red-300 px-3 py-2 text-sm rounded mb-4">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-4">
          {/* Map */}
          <div className="rounded border border-green-800 overflow-hidden" style={{ height: 560 }}>
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

              {/* Building polygons */}
              {result?.grids.map((grid) => (
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
              {filteredStuds.map((stud) => (
                <CircleMarker
                  key={stud.id}
                  center={[stud.lat, stud.lng]}
                  radius={3}
                  pathOptions={{
                    color: '#f59e0b',
                    fillColor: '#fbbf24',
                    fillOpacity: 0.7,
                    weight: 1,
                  }}
                  interactive={false}
                />
              ))}
            </MapContainer>
          </div>

          {/* Stats panel */}
          <div className="space-y-3">
            <div className="bg-gray-900 border border-green-800 rounded p-3">
              <h2 className="text-sm text-green-500 mb-2 border-b border-green-900 pb-1">
                Instructions
              </h2>
              <p className="text-xs text-green-600 leading-relaxed">
                Click the map to set coordinates, adjust the radius, then hit &quot;Fetch &amp;
                Generate&quot;. The endpoint calls Overpass directly for building footprints and
                runs stud generation on the result.
              </p>
            </div>

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
                    <span className="text-green-600">Total studs:</span>
                    <span className="text-green-300">{result.stats.totalStuds}</span>
                    <span className="text-green-600">Payload size:</span>
                    <span className="text-green-300">{result.stats.payloadSizeKB} KB</span>
                  </div>
                  {result.stats.fetchError && (
                    <div className="mt-2 text-xs text-red-400 bg-red-900/30 p-2 rounded break-all">
                      {result.stats.fetchError}
                    </div>
                  )}
                </div>

                <div className="bg-gray-900 border border-green-800 rounded p-3">
                  <h2 className="text-sm text-green-500 mb-2 border-b border-green-900 pb-1">
                    Studs on floor: {activeFloor}
                  </h2>
                  <div className="text-xs text-green-300">{filteredStuds.length} studs</div>
                </div>

                {result.buildings.length > 0 && (
                  <div className="bg-gray-900 border border-green-800 rounded p-3 max-h-48 overflow-y-auto">
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
