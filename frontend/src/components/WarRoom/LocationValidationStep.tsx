import { useState, useCallback, useMemo } from 'react';
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Polygon,
  Polyline,
  Tooltip,
  useMap,
} from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

// ── Types ─────────────────────────────────────────────────────────────────

interface POI {
  name: string;
  lat: number;
  lng: number;
  address?: string;
  location?: string;
}

interface RouteGeometry {
  name?: string;
  highway_type?: string;
  coordinates: [number, number][];
}

interface OsmVicinity {
  center?: { lat: number; lng: number };
  hospitals?: POI[];
  police?: POI[];
  fire_stations?: POI[];
  cctv_or_surveillance?: POI[];
  route_geometries?: RouteGeometry[];
}

interface GeoResultData {
  parsed?: {
    scenario_type?: string;
    location?: string;
    venue_name?: string;
  };
  geocode?: { lat: number; lng: number; display_name?: string };
  osmVicinity?: OsmVicinity;
  areaSummary?: string;
  venueName?: string;
}

interface LocationValidationStepProps {
  geoResult: Record<string, unknown> | null;
  onUpdate: (updated: Record<string, unknown>) => void;
  sceneConfig: Record<string, unknown> | null;
  loading: boolean;
  error: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const POI_COLORS: Record<string, string> = {
  hospitals: '#ef4444',
  police: '#3b82f6',
  fire_stations: '#f97316',
  cctv_or_surveillance: '#6b7280',
};

const POI_LABELS: Record<string, string> = {
  hospitals: 'Hospitals',
  police: 'Police Stations',
  fire_stations: 'Fire Stations',
  cctv_or_surveillance: 'CCTV / Surveillance',
};

// ── FlyTo helper ──────────────────────────────────────────────────────────

function FlyTo({ lat, lng, zoom }: { lat: number; lng: number; zoom?: number }) {
  const map = useMap();
  map.flyTo([lat, lng], zoom ?? map.getZoom(), { duration: 0.5 });
  return null;
}

// ── Component ─────────────────────────────────────────────────────────────

export function LocationValidationStep({
  geoResult,
  onUpdate,
  sceneConfig,
  loading,
  error,
}: LocationValidationStepProps) {
  const [flyTarget, setFlyTarget] = useState<{ lat: number; lng: number } | null>(null);
  const [selectedPoi, setSelectedPoi] = useState<string | null>(null);
  const [areaExpanded, setAreaExpanded] = useState(false);

  const geo = geoResult as unknown as GeoResultData | null;
  const vicinity = geo?.osmVicinity;
  const center = geo?.geocode ?? vicinity?.center;

  const buildingPolygon = sceneConfig?.buildingPolygon as [number, number][] | undefined;
  const blastSite = sceneConfig?.blastSite as { x: number; y: number } | undefined;

  // Compute building centroid for map center fallback
  const buildingCenter = useMemo(() => {
    if (!buildingPolygon || buildingPolygon.length < 3) return null;
    const lat = buildingPolygon.reduce((s, p) => s + p[0], 0) / buildingPolygon.length;
    const lng = buildingPolygon.reduce((s, p) => s + p[1], 0) / buildingPolygon.length;
    return { lat, lng };
  }, [buildingPolygon]);

  const mapCenter = center ?? buildingCenter ?? { lat: 7.065, lng: 125.609 };

  // Remove a POI from a category
  const removePoi = useCallback(
    (category: string, index: number) => {
      if (!geo?.osmVicinity) return;
      const updated = { ...geo };
      const vicinityClone = { ...updated.osmVicinity! };
      const arr = [...((vicinityClone as Record<string, POI[]>)[category] ?? [])];
      arr.splice(index, 1);
      (vicinityClone as Record<string, POI[]>)[category] = arr;
      updated.osmVicinity = vicinityClone;
      onUpdate(updated as unknown as Record<string, unknown>);
    },
    [geo, onUpdate],
  );

  // Update a POI position (drag)
  const updatePoiPosition = useCallback(
    (category: string, index: number, lat: number, lng: number) => {
      if (!geo?.osmVicinity) return;
      const updated = { ...geo };
      const vicinityClone = { ...updated.osmVicinity! };
      const arr = [...((vicinityClone as Record<string, POI[]>)[category] ?? [])];
      arr[index] = { ...arr[index], lat, lng };
      (vicinityClone as Record<string, POI[]>)[category] = arr;
      updated.osmVicinity = vicinityClone;
      onUpdate(updated as unknown as Record<string, unknown>);
    },
    [geo, onUpdate],
  );
  void updatePoiPosition; // used in drag handler below

  // Loading state
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-[400px]">
        <div className="text-lg terminal-text text-cyan-400 animate-pulse mb-4">
          VALIDATING LOCATION...
        </div>
        <div className="text-xs terminal-text text-robotic-yellow/40">
          Fetching nearby hospitals, police stations, fire stations, routes...
        </div>
        <div className="mt-6 w-48 h-1 bg-robotic-gray-200 rounded overflow-hidden">
          <div className="h-full bg-cyan-500 animate-pulse" style={{ width: '60%' }} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-[400px]">
        <div className="text-lg terminal-text text-red-400 mb-4">VALIDATION FAILED</div>
        <div className="text-xs terminal-text text-red-300/70 max-w-md text-center">{error}</div>
      </div>
    );
  }

  if (!geo) {
    return (
      <div className="text-sm terminal-text text-robotic-yellow/40 text-center py-12">
        No location data available. Go back and complete the scene editor first.
      </div>
    );
  }

  const poiCategories = ['hospitals', 'police', 'fire_stations', 'cctv_or_surveillance'] as const;

  return (
    <div className="flex flex-col lg:flex-row h-[calc(100vh-320px)] min-h-[500px] gap-3">
      {/* Left: POI panel */}
      <div className="w-full lg:w-80 flex-shrink-0 overflow-y-auto space-y-3">
        {/* Venue / Location header */}
        <div className="border border-robotic-gray-200 rounded p-3">
          <div className="text-xs terminal-text text-cyan-400 font-bold uppercase">
            {geo.venueName || geo.parsed?.venue_name || 'Location'}
          </div>
          {geo.geocode?.display_name && (
            <div className="text-[10px] terminal-text text-robotic-yellow/40 mt-1">
              {geo.geocode.display_name}
            </div>
          )}
          {center && (
            <div className="text-[10px] terminal-text text-robotic-yellow/20 mt-1">
              {center.lat.toFixed(6)}, {center.lng.toFixed(6)}
            </div>
          )}
        </div>

        {/* Area summary (collapsible) */}
        {geo.areaSummary && (
          <div className="border border-robotic-gray-200 rounded">
            <button
              onClick={() => setAreaExpanded(!areaExpanded)}
              className="w-full text-left px-3 py-2 text-xs terminal-text text-robotic-yellow/60 hover:text-robotic-yellow/80 flex justify-between items-center"
            >
              <span>Area Research Summary</span>
              <span>{areaExpanded ? '−' : '+'}</span>
            </button>
            {areaExpanded && (
              <div className="px-3 pb-3 text-[10px] terminal-text text-robotic-yellow/40 whitespace-pre-wrap max-h-48 overflow-y-auto">
                {geo.areaSummary}
              </div>
            )}
          </div>
        )}

        {/* POI lists by category */}
        {poiCategories.map((cat) => {
          const pois = (vicinity?.[cat] as POI[] | undefined) ?? [];
          const color = POI_COLORS[cat];
          return (
            <div key={cat} className="border border-robotic-gray-200 rounded">
              <div className="px-3 py-2 flex justify-between items-center border-b border-robotic-gray-200">
                <div className="flex items-center gap-2">
                  <span
                    className="w-3 h-3 rounded-full inline-block"
                    style={{ backgroundColor: color }}
                  />
                  <span className="text-xs terminal-text text-robotic-yellow/70">
                    {POI_LABELS[cat]}
                  </span>
                </div>
                <span className="text-[10px] terminal-text text-robotic-yellow/30">
                  {pois.length}
                </span>
              </div>
              {pois.length === 0 && (
                <div className="px-3 py-2 text-[10px] terminal-text text-robotic-yellow/20 italic">
                  None found in area
                </div>
              )}
              {pois.map((poi, i) => {
                const dist = center ? haversineKm(center.lat, center.lng, poi.lat, poi.lng) : null;
                const poiKey = `${cat}-${i}`;
                const isSelected = selectedPoi === poiKey;
                return (
                  <div
                    key={i}
                    className={`px-3 py-1.5 flex items-center justify-between border-b border-robotic-gray-200 last:border-b-0 cursor-pointer hover:bg-robotic-gray-200/30 ${
                      isSelected ? 'bg-cyan-900/20' : ''
                    }`}
                    onClick={() => {
                      setSelectedPoi(poiKey);
                      setFlyTarget({ lat: poi.lat, lng: poi.lng });
                    }}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-xs terminal-text text-robotic-yellow/70 truncate">
                        {poi.name || 'Unnamed'}
                      </div>
                      {dist !== null && (
                        <div className="text-[9px] terminal-text text-robotic-yellow/30">
                          {dist < 1 ? `${Math.round(dist * 1000)}m` : `${dist.toFixed(1)}km`} away
                        </div>
                      )}
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removePoi(cat, i);
                      }}
                      className="text-red-500/50 hover:text-red-400 text-xs ml-2 flex-shrink-0"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Right: Map */}
      <div className="flex-1 relative rounded overflow-hidden border border-robotic-gray-200 min-h-[300px]">
        <MapContainer
          center={[mapCenter.lat, mapCenter.lng]}
          zoom={15}
          style={{ width: '100%', height: '100%' }}
          zoomControl={true}
        >
          <TileLayer
            attribution="&copy; OSM"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            maxNativeZoom={19}
            maxZoom={22}
          />

          {flyTarget && <FlyTo lat={flyTarget.lat} lng={flyTarget.lng} />}

          {/* Building polygon */}
          {buildingPolygon && buildingPolygon.length >= 3 && (
            <Polygon
              positions={buildingPolygon.map(([la, ln]) => [la, ln] as [number, number])}
              pathOptions={{ color: '#22d3ee', weight: 2, fillColor: '#22d3ee', fillOpacity: 0.1 }}
            />
          )}

          {/* Blast site marker (if available from scene config) */}
          {blastSite &&
            buildingPolygon &&
            buildingPolygon.length >= 3 &&
            (() => {
              const refLat = buildingPolygon.reduce((s, p) => s + p[0], 0) / buildingPolygon.length;
              const refLng = buildingPolygon.reduce((s, p) => s + p[1], 0) / buildingPolygon.length;
              const mPerDegLat = 111320;
              const mPerDegLng = 111320 * Math.cos((refLat * Math.PI) / 180);
              const lat = refLat - blastSite.y / mPerDegLat;
              const lng = refLng + blastSite.x / mPerDegLng;
              return (
                <CircleMarker
                  center={[lat, lng]}
                  radius={8}
                  pathOptions={{
                    color: '#ef4444',
                    fillColor: '#ef4444',
                    fillOpacity: 0.6,
                    weight: 2,
                  }}
                >
                  <Tooltip>Blast Site</Tooltip>
                </CircleMarker>
              );
            })()}

          {/* Center marker */}
          {center && (
            <CircleMarker
              center={[center.lat, center.lng]}
              radius={6}
              pathOptions={{ color: '#22c55e', fillColor: '#22c55e', fillOpacity: 0.6, weight: 2 }}
            >
              <Tooltip>Incident Center</Tooltip>
            </CircleMarker>
          )}

          {/* POI markers */}
          {poiCategories.map((cat) => {
            const pois = (vicinity?.[cat] as POI[] | undefined) ?? [];
            const color = POI_COLORS[cat];
            return pois.map((poi, i) => (
              <CircleMarker
                key={`${cat}-${i}`}
                center={[poi.lat, poi.lng]}
                radius={selectedPoi === `${cat}-${i}` ? 10 : 7}
                pathOptions={{
                  color,
                  fillColor: color,
                  fillOpacity: selectedPoi === `${cat}-${i}` ? 0.9 : 0.6,
                  weight: selectedPoi === `${cat}-${i}` ? 3 : 2,
                }}
                eventHandlers={{
                  click: () => {
                    setSelectedPoi(`${cat}-${i}`);
                  },
                }}
              >
                <Tooltip>
                  <span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                    {poi.name || 'Unnamed'}
                  </span>
                </Tooltip>
              </CircleMarker>
            ));
          })}

          {/* Route polylines */}
          {vicinity?.route_geometries?.map((route, i) => (
            <Polyline
              key={`route-${i}`}
              positions={route.coordinates.map(([lng, lat]) => [lat, lng] as [number, number])}
              pathOptions={{ color: '#a3a3a3', weight: 2, opacity: 0.5, dashArray: '4 4' }}
            >
              {route.name && <Tooltip sticky>{route.name}</Tooltip>}
            </Polyline>
          ))}
        </MapContainer>

        {/* Map legend */}
        <div
          className="absolute bottom-3 right-3 bg-black/80 rounded px-3 py-2 text-[10px] terminal-text space-y-1 pointer-events-none"
          style={{ zIndex: 1000 }}
        >
          {Object.entries(POI_COLORS).map(([key, color]) => (
            <div key={key} className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
              <span className="text-robotic-yellow/50">{POI_LABELS[key]}</span>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-green-500" />
            <span className="text-robotic-yellow/50">Incident Center</span>
          </div>
        </div>
      </div>
    </div>
  );
}
