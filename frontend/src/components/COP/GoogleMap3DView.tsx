import { useEffect, useRef, useState, useMemo } from 'react';
import { setOptions, importLibrary } from '@googlemaps/js-api-loader';
import { useWebSocket } from '../../hooks/useWebSocket';
import { api } from '../../lib/api';

type WebSocketEvent = {
  type: string;
  data: unknown;
};

interface Incident {
  id: string;
  title: string;
  description: string;
  location_lat?: number | null;
  location_lng?: number | null;
  severity: string;
  status: string;
  type: string;
  casualty_count?: number;
}

interface Resource {
  id?: string;
  resource_type: string;
  quantity: number;
  location_lat?: number | null;
  location_lng?: number | null;
  agency_name: string;
}

interface EvacuationZoneData {
  id: string;
  center_lat: number;
  center_lng: number;
  radius_meters: number;
  title: string;
}

interface ScenarioLocationPin {
  id: string;
  location_type: string;
  pin_category?: string;
  narrative_description?: string;
  label: string;
  coordinates: { lat?: number; lng?: number };
  conditions?: Record<string, unknown>;
}

const ALWAYS_SHOW_PIN_CATEGORIES = new Set([
  'incident_site',
  'access',
  'triage',
  'command',
  'staging',
]);

const ALWAYS_SHOW_LOCATION_TYPE_KEYWORDS = [
  'blast',
  'exit',
  'triage',
  'evacuation_holding',
  'evac_holding',
  'pathway',
  'parking',
  'epicentre',
  'device',
];

const POI_INSIDER_CATEGORY_MAP: Record<string, string> = {
  hospital: 'hospitals',
  police_station: 'police',
  fire_station: 'fire_stations',
  cctv: 'cctv',
  community_center: 'community_centres',
};

function isAlwaysShowPin(locationType: string, pinCategory?: string): boolean {
  if (pinCategory && ALWAYS_SHOW_PIN_CATEGORIES.has(pinCategory)) return true;
  const t = locationType.toLowerCase();
  return ALWAYS_SHOW_LOCATION_TYPE_KEYWORDS.some((kw) => t.includes(kw));
}

function getInsiderCategory(locationType: string, pinCategory?: string): string | undefined {
  if (pinCategory === 'poi') return 'poi';
  return POI_INSIDER_CATEGORY_MAP[locationType];
}

function getPinColor(pin: ScenarioLocationPin): string {
  const cat = pin.pin_category?.toLowerCase() ?? '';
  const t = pin.location_type.toLowerCase();

  if (
    cat === 'incident_site' ||
    t.includes('blast') ||
    t.includes('epicentre') ||
    t.includes('device') ||
    t.includes('attack')
  )
    return '#b91c1c';
  if (
    cat === 'cordon' ||
    t.includes('cordon') ||
    t.includes('perimeter') ||
    t.includes('exclusion')
  )
    return '#7c3aed';
  if (cat === 'triage' || t.includes('triage') || t.includes('casualty') || t.includes('medical'))
    return '#d97706';
  if (
    cat === 'access' ||
    t.includes('exit') ||
    t.includes('entry') ||
    t.includes('route') ||
    t.includes('pathway') ||
    t.includes('ingress') ||
    t.includes('egress')
  )
    return '#059669';
  if (
    cat === 'command' ||
    t.includes('command') ||
    t.includes('icp') ||
    t.includes('ops') ||
    t.includes('negotiat')
  )
    return '#0284c7';
  if (
    cat === 'staging' ||
    t.includes('staging') ||
    t.includes('holding') ||
    t.includes('assembly') ||
    t.includes('pool')
  )
    return '#0891b2';
  if (
    cat === 'poi' ||
    t.includes('hospital') ||
    t.includes('police') ||
    t.includes('fire') ||
    t.includes('scdf') ||
    t.includes('media') ||
    t.includes('press')
  )
    return '#4338ca';
  if (t.includes('cctv')) return '#a855f7';
  if (t.includes('community')) return '#0d9488';
  return '#4b5563';
}

function getSymbol(pin: ScenarioLocationPin): string {
  const cat = pin.pin_category?.toLowerCase() ?? '';
  const t = pin.location_type.toLowerCase();

  if (
    cat === 'incident_site' ||
    t.includes('blast') ||
    t.includes('device') ||
    t.includes('epicentre') ||
    t.includes('attack')
  )
    return '💥';
  if (
    cat === 'cordon' ||
    t.includes('cordon') ||
    t.includes('perimeter') ||
    t.includes('exclusion')
  )
    return '⛔';
  if (cat === 'triage' || t.includes('triage') || t.includes('casualty')) return '⚕';
  if (t.includes('negotiat') || t.includes('ops') || t.includes('command') || t.includes('icp'))
    return '🎯';
  if (cat === 'command') return '🎯';
  if (
    cat === 'access' ||
    t.includes('exit') ||
    t.includes('entry') ||
    t.includes('route') ||
    t.includes('pathway') ||
    t.includes('ingress') ||
    t.includes('egress')
  )
    return '🚪';
  if (
    cat === 'staging' ||
    t.includes('staging') ||
    t.includes('holding') ||
    t.includes('assembly') ||
    t.includes('pool')
  )
    return '⛺';
  if (t.includes('media') || t.includes('press')) return '📡';
  if (t.includes('hospital')) return '🏥';
  if (t.includes('police')) return '🛡';
  if (t.includes('fire') || t.includes('scdf')) return '🚒';
  if (t.includes('cctv')) return '📹';
  if (t.includes('community')) return '🏛';
  return '📍';
}

function normalizeCenter(
  center: [number, number] | { lat: number; lng: number },
): [number, number] {
  if (Array.isArray(center)) return center;
  return [center.lat, center.lng];
}

function zoomToRange(zoom: number): number {
  return 35_000_000 / Math.pow(2, zoom);
}

let optionsSet = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadMaps3DLibrary(): Promise<any> {
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!apiKey) return Promise.reject(new Error('VITE_GOOGLE_MAPS_API_KEY not set'));

  if (!optionsSet) {
    setOptions({ key: apiKey });
    optionsSet = true;
  }

  console.log('[GoogleMap3D] Loading maps3d library...');
  const libraryPromise = importLibrary('maps3d');

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Google Maps 3D library load timed out after 15s')), 15000),
  );

  return Promise.race([libraryPromise, timeout]).then((result) => {
    console.log('[GoogleMap3D] maps3d library loaded successfully');
    return result;
  });
}

export interface GoogleMap3DViewProps {
  sessionId: string;
  incidents?: Incident[];
  resources?: Resource[];
  evacuationZones?: EvacuationZoneData[];
  onIncidentClick?: (incident: Incident) => void;
  onResourceClick?: (resource: Resource) => void;
  selectedIncidentId?: string | null;
  initialCenter?: [number, number] | { lat: number; lng: number };
  initialZoom?: number;
  isVisible?: boolean;
  fillHeight?: boolean;
  locationsRefreshTrigger?: number;
  showAllPins?: boolean;
  currentState?: Record<string, unknown>;
}

export const GoogleMap3DView = ({
  sessionId,
  incidents = [],
  resources = [],
  evacuationZones: initialEvacuationZones = [],
  onIncidentClick,
  selectedIncidentId,
  initialCenter = [1.2931, 103.8558],
  initialZoom = 13,
  isVisible = true,
  fillHeight = false,
  locationsRefreshTrigger = 0,
  showAllPins = false,
  currentState,
}: GoogleMap3DViewProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const maps3dLibRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markersRef = useRef<any[]>([]);

  const [mapLoaded, setMapLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedPin, setSelectedPin] = useState<ScenarioLocationPin | null>(null);

  const [evacuationZones, setEvacuationZones] = useState(initialEvacuationZones);
  const [scenarioLocations, setScenarioLocations] = useState<ScenarioLocationPin[]>([]);
  const [mapRevealedCategories, setMapRevealedCategories] = useState<string[]>([]);

  // ---------- data fetching (mirrors MapView logic) ----------

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    api.sessions
      .getLocations(sessionId)
      .then((res) => {
        if (cancelled) return;
        if (Array.isArray(res.data)) {
          setScenarioLocations(
            res.data.map((loc: Record<string, unknown>) => {
              const conds = (loc.conditions as Record<string, unknown>) ?? {};
              return {
                id: loc.id as string,
                location_type: loc.location_type as string,
                pin_category: conds.pin_category as string | undefined,
                narrative_description: conds.narrative_description as string | undefined,
                label: loc.label as string,
                coordinates: (loc.coordinates as { lat?: number; lng?: number }) ?? {},
                conditions: conds,
              };
            }),
          );
        }
        setMapRevealedCategories(res.map_revealed_categories ?? []);
      })
      .catch(() => {
        if (!cancelled) {
          setScenarioLocations([]);
          setMapRevealedCategories([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, locationsRefreshTrigger]);

  useWebSocket({
    sessionId,
    eventTypes: ['state.updated'],
    onEvent: (event: WebSocketEvent) => {
      if (event.type === 'state.updated') {
        const state = (event.data as { state?: Record<string, unknown> })?.state;
        if (state?.evacuation_zones) {
          setEvacuationZones(state.evacuation_zones as EvacuationZoneData[]);
        }
      }
    },
    enabled: !!sessionId,
  });

  // ---------- pin filtering (mirrors MapView logic) ----------

  const scenarioLocationsWithCoords = scenarioLocations.filter(
    (loc) => typeof loc.coordinates?.lat === 'number' && typeof loc.coordinates?.lng === 'number',
  );

  const scenarioLocationsForMap = useMemo(() => {
    return scenarioLocationsWithCoords.filter((loc) => {
      const visKey = loc.conditions?.visible_after_state_key as string | undefined;
      if (visKey && currentState) {
        const [parentKey, childKey] = visKey.split('.');
        if (parentKey && childKey) {
          const parent = currentState[parentKey] as Record<string, unknown> | undefined;
          if (!parent?.[childKey]) return false;
        } else if (parentKey) {
          if (!currentState[parentKey]) return false;
        }
      } else if (visKey && !currentState) {
        return false;
      }

      const isCordon =
        loc.pin_category === 'cordon' ||
        loc.location_type === 'cordon' ||
        loc.location_type.toLowerCase().includes('cordon') ||
        loc.location_type.toLowerCase().includes('perimeter');
      if (isCordon) return showAllPins;
      if (showAllPins) return true;
      if (isAlwaysShowPin(loc.location_type, loc.pin_category)) return true;
      const insiderCat = getInsiderCategory(loc.location_type, loc.pin_category);
      if (!insiderCat) return true;
      return mapRevealedCategories.includes(insiderCat);
    });
  }, [scenarioLocationsWithCoords, showAllPins, mapRevealedCategories, currentState]);

  const incidentsWithLocation = incidents.filter(
    (i) => i.location_lat != null && i.location_lng != null,
  );

  const resourcesWithLocation = resources.filter(
    (r) => r.location_lat != null && r.location_lng != null,
  );

  // ---------- Google Maps 3D initialization ----------

  useEffect(() => {
    if (!import.meta.env.VITE_GOOGLE_MAPS_API_KEY) {
      setLoadError('Google Maps API key not configured (VITE_GOOGLE_MAPS_API_KEY)');
      return;
    }

    let mounted = true;

    (async () => {
      try {
        console.log('[GoogleMap3D] Init starting for session', sessionId);
        const maps3d = await loadMaps3DLibrary();
        if (!mounted) {
          console.log('[GoogleMap3D] Aborted: component unmounted during load');
          return;
        }
        if (!containerRef.current) {
          console.log('[GoogleMap3D] Aborted: container ref is null');
          return;
        }

        maps3dLibRef.current = maps3d;
        console.log('[GoogleMap3D] Library keys:', Object.keys(maps3d));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { Map3DElement } = maps3d as { Map3DElement: any; [k: string]: any };
        const [lat, lng] = normalizeCenter(initialCenter);
        console.log('[GoogleMap3D] Creating Map3DElement at', lat, lng);

        const map = new Map3DElement();
        map.mode = 'HYBRID';
        map.center = { lat, lng, altitude: 0 };
        map.range = zoomToRange(initialZoom);
        map.tilt = 55;
        map.heading = 0;
        map.defaultLabelsDisabled = false;
        map.style.width = '100%';
        map.style.height = '100%';
        map.style.display = 'block';

        containerRef.current.innerHTML = '';
        containerRef.current.appendChild(map);
        mapRef.current = map;
        setMapLoaded(true);
        console.log('[GoogleMap3D] Map element appended, mapLoaded=true');
      } catch (err: unknown) {
        console.error('[GoogleMap3D] Init failed:', err);
        if (mounted) {
          const msg = err instanceof Error ? err.message : 'Failed to load Google Maps 3D';
          setLoadError(msg);
        }
      }
    })();

    return () => {
      mounted = false;
      markersRef.current.forEach((m) => {
        try {
          m.remove();
        } catch (_) {
          /* ignore */
        }
      });
      markersRef.current = [];
      if (mapRef.current) {
        try {
          mapRef.current.remove();
        } catch (_) {
          /* ignore */
        }
        mapRef.current = null;
      }
      maps3dLibRef.current = null;
      setMapLoaded(false);
    };
  }, [sessionId]);

  // ---------- marker rendering ----------

  // TODO: Re-enable markers once Marker3DInteractiveElement content type issue is resolved.
  // The 3D marker API only accepts <img>/<svg>/PinElement inside <template>, not arbitrary HTML.
  useEffect(() => {
    if (!mapLoaded || !mapRef.current || !maps3dLibRef.current) return;
    return; // Skip marker rendering for now

    markersRef.current.forEach((m) => {
      try {
        m.remove();
      } catch (_) {
        /* ignore */
      }
    });
    markersRef.current = [];

    const lib = maps3dLibRef.current as Record<string, any>;
    const MarkerCtor = lib.Marker3DInteractiveElement ?? lib.Marker3DElement;
    const hasClickSupport = !!lib.Marker3DInteractiveElement;

    // --- scenario location pins ---
    scenarioLocationsForMap.forEach((loc) => {
      if (loc.coordinates?.lat == null || loc.coordinates?.lng == null) return;

      const marker = new MarkerCtor();
      marker.position = { lat: loc.coordinates.lat, lng: loc.coordinates.lng, altitude: 25 };
      marker.altitudeMode = 'RELATIVE_TO_GROUND';
      marker.extruded = true;

      const color = getPinColor(loc);
      const symbol = getSymbol(loc);

      const wrapper = document.createElement('div');
      wrapper.style.cssText = `
        display:flex; flex-direction:column; align-items:center; gap:2px; cursor:pointer;
      `;

      const circle = document.createElement('div');
      circle.style.cssText = `
        background:${color}; width:34px; height:34px; border-radius:50%;
        border:3px solid white; box-shadow:0 2px 8px rgba(0,0,0,0.4);
        display:flex; align-items:center; justify-content:center; font-size:17px; line-height:1;
      `;
      circle.textContent = symbol;

      const label = document.createElement('div');
      label.style.cssText = `
        background:rgba(0,0,0,0.75); color:#fbbf24; padding:2px 6px; border-radius:3px;
        font-size:10px; font-family:monospace; white-space:nowrap; max-width:160px;
        overflow:hidden; text-overflow:ellipsis;
      `;
      label.textContent = loc.label;

      wrapper.appendChild(circle);
      wrapper.appendChild(label);
      const template = document.createElement('template');
      template.content.appendChild(wrapper);
      marker.append(template);

      if (hasClickSupport) {
        marker.addEventListener('gmp-click', () => setSelectedPin(loc));
      }

      mapRef.current.append(marker);
      markersRef.current.push(marker);
    });

    // --- incident markers ---
    incidentsWithLocation.forEach((incident) => {
      const marker = new MarkerCtor();
      marker.position = {
        lat: incident.location_lat!,
        lng: incident.location_lng!,
        altitude: 35,
      };
      marker.altitudeMode = 'RELATIVE_TO_GROUND';
      marker.extruded = true;

      const wrapper = document.createElement('div');
      wrapper.style.cssText = `
        display:flex; flex-direction:column; align-items:center; gap:2px; cursor:pointer;
      `;

      const circle = document.createElement('div');
      circle.style.cssText = `
        background:#dc2626; width:40px; height:40px; border-radius:50%;
        border:3px solid #fbbf24; box-shadow:0 2px 12px rgba(220,38,38,0.6);
        display:flex; align-items:center; justify-content:center; font-size:20px; line-height:1;
      `;
      circle.textContent = '⚠️';

      const label = document.createElement('div');
      label.style.cssText = `
        background:rgba(220,38,38,0.85); color:white; padding:2px 6px; border-radius:3px;
        font-size:10px; font-family:monospace; white-space:nowrap; max-width:180px;
        overflow:hidden; text-overflow:ellipsis; font-weight:bold;
      `;
      label.textContent = incident.title;

      wrapper.appendChild(circle);
      wrapper.appendChild(label);
      const template = document.createElement('template');
      template.content.appendChild(wrapper);
      marker.append(template);

      if (hasClickSupport) {
        marker.addEventListener('gmp-click', () => onIncidentClick?.(incident));
      }

      mapRef.current.append(marker);
      markersRef.current.push(marker);
    });

    // --- resource markers ---
    resourcesWithLocation.forEach((resource) => {
      const marker = new MarkerCtor();
      marker.position = {
        lat: resource.location_lat!,
        lng: resource.location_lng!,
        altitude: 15,
      };
      marker.altitudeMode = 'RELATIVE_TO_GROUND';

      const wrapper = document.createElement('div');
      wrapper.style.cssText = `display:flex; flex-direction:column; align-items:center; gap:2px;`;

      const circle = document.createElement('div');
      circle.style.cssText = `
        background:#2563eb; width:30px; height:30px; border-radius:50%;
        border:2px solid white; box-shadow:0 2px 6px rgba(0,0,0,0.3);
        display:flex; align-items:center; justify-content:center;
        font-size:12px; color:white; font-weight:bold; font-family:monospace;
      `;
      circle.textContent = String(resource.quantity);

      const label = document.createElement('div');
      label.style.cssText = `
        background:rgba(37,99,235,0.85); color:white; padding:2px 6px; border-radius:3px;
        font-size:9px; font-family:monospace; white-space:nowrap;
      `;
      label.textContent = `${resource.resource_type} (${resource.agency_name})`;

      wrapper.appendChild(circle);
      wrapper.appendChild(label);
      const template = document.createElement('template');
      template.content.appendChild(wrapper);
      marker.append(template);

      mapRef.current.append(marker);
      markersRef.current.push(marker);
    });
  }, [mapLoaded, scenarioLocationsForMap, incidentsWithLocation, resourcesWithLocation]);

  // ---------- fly-to on incident selection ----------

  useEffect(() => {
    if (!mapRef.current || !selectedIncidentId) return;
    const incident = incidents.find((i) => i.id === selectedIncidentId);
    if (incident?.location_lat != null && incident?.location_lng != null) {
      const map = mapRef.current;
      if (typeof map.flyCameraTo === 'function') {
        map.flyCameraTo({
          endCamera: {
            center: { lat: incident.location_lat, lng: incident.location_lng, altitude: 0 },
            range: 500,
            tilt: 55,
            heading: map.heading ?? 0,
          },
          durationMillis: 1000,
        });
      } else {
        map.center = { lat: incident.location_lat, lng: incident.location_lng, altitude: 0 };
        map.range = 500;
      }
    }
  }, [selectedIncidentId, incidents]);

  // ---------- visibility handling ----------

  useEffect(() => {
    if (!mapRef.current || !isVisible) return;
    const container = containerRef.current;
    if (container) {
      void container.offsetWidth;
    }
  }, [isVisible]);

  // ---------- render ----------

  if (loadError) {
    return (
      <div
        className="military-border p-8 text-center flex flex-col items-center justify-center"
        style={{
          height: fillHeight ? '620px' : '600px',
          minHeight: fillHeight ? '620px' : '600px',
        }}
      >
        <h3 className="text-lg terminal-text text-robotic-orange mb-4">[3D_MAP_UNAVAILABLE]</h3>
        <p className="text-sm terminal-text text-robotic-yellow/70 mb-2">{loadError}</p>
        <p className="text-xs terminal-text text-robotic-yellow/50 max-w-md">
          Ensure VITE_GOOGLE_MAPS_API_KEY is set and the Maps JavaScript API + Map Tiles API are
          enabled in Google Cloud Console.
        </p>
      </div>
    );
  }

  const mapHeight = fillHeight ? '620px' : '600px';

  return (
    <div className="relative w-full" style={{ height: mapHeight, minHeight: mapHeight }}>
      <div ref={containerRef} className="w-full h-full" />

      {!mapLoaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-robotic-gray-300">
          <div className="text-center">
            <div className="text-lg terminal-text mb-2 animate-pulse">[LOADING_3D_MAP]</div>
            <div className="text-xs terminal-text text-robotic-yellow/50">
              Initializing Google Maps 3D photorealistic tiles...
            </div>
          </div>
        </div>
      )}

      {/* Evacuation zone count indicator */}
      {evacuationZones.length > 0 && (
        <div className="absolute top-2 left-2 z-10 px-2 py-1.5 rounded bg-black/80 border border-robotic-yellow/50 text-xs terminal-text text-robotic-yellow">
          <span className="font-medium">Evacuation zones:</span> {evacuationZones.length} active
        </div>
      )}

      {/* Selected pin info overlay */}
      {selectedPin && (
        <div className="absolute bottom-4 left-4 z-10 max-w-sm military-border p-4 bg-robotic-gray-300/95 backdrop-blur-sm">
          <div className="flex justify-between items-start gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span
                  className="w-4 h-4 rounded-full border border-white/50 flex-shrink-0"
                  style={{ background: getPinColor(selectedPin) }}
                />
                <span className="text-sm font-medium terminal-text text-robotic-yellow truncate">
                  {selectedPin.label}
                </span>
              </div>
              <div className="text-xs text-robotic-yellow/60 capitalize">
                {selectedPin.location_type.replace(/_/g, ' ')}
              </div>
              {(selectedPin.narrative_description ??
                (selectedPin.conditions?.narrative_description as string | undefined)) && (
                <div className="text-xs text-robotic-yellow/80 mt-1.5 leading-snug">
                  {selectedPin.narrative_description ??
                    (selectedPin.conditions?.narrative_description as string)}
                </div>
              )}
            </div>
            <button
              onClick={() => setSelectedPin(null)}
              className="px-2 py-1 text-xs terminal-text uppercase border border-robotic-orange text-robotic-orange hover:bg-robotic-orange/10 flex-shrink-0"
            >
              [X]
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
