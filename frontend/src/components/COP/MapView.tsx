import { useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import { Icon, Marker as LeafletMarker } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { IncidentMarker } from './IncidentMarker';
import { ResourceMarker } from './ResourceMarker';
import { EvacuationZone } from './EvacuationZone';
import { ScenarioLocationMarker, type ScenarioLocationPin } from './ScenarioLocationMarker';
import { RoutePolyline, type RouteData } from './RoutePolyline';
import { WindIndicator, type WindData } from './WindIndicator';
import { BlastZoneOverlay } from './BlastZoneOverlay';
import { CrowdDensityOverlay, type CrowdArea } from './CrowdDensityOverlay';
import { AssetPalette, type DraggableAssetDef } from './AssetPalette';
import { PlacedAssetMarker, type PlacedAsset } from './PlacedAssetMarker';
import { MapDropHandler } from './MapDropHandler';
import { HazardMarker, type HazardData } from './HazardMarker';
import { HazardAssessmentModal } from './HazardAssessmentModal';
import { FloorSelector, type FloorPlan } from './FloorSelector';
import { FloorPlanOverlay } from './FloorPlanOverlay';
import { useWebSocket } from '../../hooks/useWebSocket';
import { api } from '../../lib/api';
import type { LatLngExpression } from 'leaflet';

type WebSocketEvent = {
  type: string;
  data: unknown;
};

// Fix Leaflet default icon issue
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

const DefaultIcon = new Icon({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

if (typeof window !== 'undefined') {
  LeafletMarker.prototype.options.icon = DefaultIcon;
}

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

/**
 * pin_category values that are always visible to all players.
 * Legacy location_type keywords are also checked for backward compatibility.
 */
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

/** poi pin_category maps to insider-revealed category. Legacy exact-match also supported. */
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

interface MapViewProps {
  sessionId: string;
  incidents?: Incident[];
  resources?: Resource[];
  evacuationZones?: EvacuationZoneData[];
  onIncidentClick?: (incident: Incident) => void;
  onResourceClick?: (resource: Resource) => void;
  selectedIncidentId?: string | null;
  initialCenter?: LatLngExpression;
  initialZoom?: number;
  disabled?: boolean;
  /** When true, call invalidateSize so the map fills the container (e.g. after module becomes visible). */
  isVisible?: boolean;
  /** When true, use height 100% to fill the parent (e.g. session map module). */
  fillHeight?: boolean;
  /** Increment to refetch locations (e.g. after user asked Insider, so new POI categories appear). */
  locationsRefreshTrigger?: number;
  /** When true (e.g. trainer view), show all pins regardless of Insider reveal; default false. */
  showAllPins?: boolean;
  /** Live session current_state — used to conditionally show/hide pins with visible_after_state_key. */
  currentState?: Record<string, unknown>;
  /** Draggable asset definitions for the player's team (Phase 3). */
  draggableAssets?: DraggableAssetDef[];
  /** Player's team name for placement ownership. */
  teamName?: string;
}

/**
 * When isVisible becomes true, call map.invalidateSize() so Leaflet recalculates
 * (e.g. after the map module is shown from hidden).
 */
const MapSizeInvalidator = ({ isVisible }: { isVisible?: boolean }) => {
  const map = useMap();
  useEffect(() => {
    if (!isVisible) return;
    const run = () => {
      try {
        map.invalidateSize();
      } catch (_) {
        // Ignore
      }
    };
    run();
    const t1 = setTimeout(run, 100);
    const t2 = setTimeout(run, 400);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [isVisible, map]);
  return null;
};

/**
 * Calls map.remove() on unmount so Leaflet cleans up before React tears down the DOM.
 * Prevents "removeChild" errors when the map module is hidden.
 */
const MapCleanup = () => {
  const map = useMap();
  useEffect(() => {
    return () => {
      try {
        map.remove();
      } catch (_) {
        // Ignore if already removed
      }
    };
  }, [map]);
  return null;
};

/**
 * Simplified Map Initializer - Uses ResizeObserver to wait for dimensions
 */
const MapInitializer = ({
  initialCenter,
  initialZoom,
  onReady,
}: {
  initialCenter?: LatLngExpression;
  initialZoom?: number;
  onReady?: () => void;
}) => {
  const map = useMap();
  const hasInitialized = useRef(false);

  useEffect(() => {
    if (hasInitialized.current) return;

    const container = map.getContainer();
    if (!container) return;

    // Use ResizeObserver to wait for container to have dimensions
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0 && !hasInitialized.current) {
          hasInitialized.current = true;
          resizeObserver.disconnect();

          // Force layout recalculation
          void container.offsetWidth;

          // Invalidate size to ensure Leaflet sees the dimensions
          map.invalidateSize();

          // Set initial view
          if (initialCenter && initialZoom !== undefined) {
            const center = Array.isArray(initialCenter)
              ? initialCenter
              : [initialCenter.lat, initialCenter.lng];

            map.setView(center as [number, number], initialZoom, { animate: false });

            // Invalidate again after setView
            setTimeout(() => {
              map.invalidateSize();
              onReady?.();
            }, 100);
          } else {
            onReady?.();
          }
          return;
        }
      }
    });

    resizeObserver.observe(container);

    // Fallback: Check immediately and periodically
    const checkDimensions = () => {
      const width = container.offsetWidth || container.clientWidth;
      const height = container.offsetHeight || container.clientHeight;

      if (width > 0 && height > 0 && !hasInitialized.current) {
        hasInitialized.current = true;
        resizeObserver.disconnect();

        map.invalidateSize();

        if (initialCenter && initialZoom !== undefined) {
          const center = Array.isArray(initialCenter)
            ? initialCenter
            : [initialCenter.lat, initialCenter.lng];

          map.setView(center as [number, number], initialZoom, { animate: false });
          setTimeout(() => {
            map.invalidateSize();
            onReady?.();
          }, 100);
        } else {
          onReady?.();
        }
      }
    };

    // Check immediately and then periodically
    checkDimensions();
    const interval = setInterval(() => {
      if (!hasInitialized.current) {
        checkDimensions();
      } else {
        clearInterval(interval);
        resizeObserver.disconnect();
      }
    }, 100);

    // Cleanup
    return () => {
      clearInterval(interval);
      resizeObserver.disconnect();
    };
  }, [map, initialCenter, initialZoom, onReady]);

  return null;
};

/**
 * Map Updater - Handles map updates and centering
 */
const MapUpdater = ({
  incidents,
  selectedIncidentId,
  initialCenter,
  initialZoom,
}: {
  incidents?: Incident[];
  selectedIncidentId?: string | null;
  initialCenter?: LatLngExpression;
  initialZoom?: number;
}) => {
  const map = useMap();

  // Invalidate size on mount and window resize
  useEffect(() => {
    const handleResize = () => {
      map.invalidateSize();
    };

    // Invalidate after a short delay to ensure container is laid out
    const timer = setTimeout(() => {
      map.invalidateSize();
    }, 200);

    window.addEventListener('resize', handleResize);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', handleResize);
    };
  }, [map]);

  // Center map on selected incident
  useEffect(() => {
    if (selectedIncidentId && incidents && incidents.length > 0) {
      const selectedIncident = incidents.find((inc) => inc.id === selectedIncidentId);
      if (selectedIncident?.location_lat && selectedIncident?.location_lng) {
        map.setView(
          [selectedIncident.location_lat, selectedIncident.location_lng] as [number, number],
          16,
          { animate: true, duration: 0.5 },
        );
        setTimeout(() => map.invalidateSize(), 100);
      }
    }
  }, [map, selectedIncidentId, incidents]);

  // Fit map to show all incidents (when no specific incident is selected)
  useEffect(() => {
    if (selectedIncidentId) return;
    if (!incidents || incidents.length === 0) return;

    const incidentsWithLocation = incidents.filter(
      (incident) => incident.location_lat && incident.location_lng,
    );

    if (incidentsWithLocation.length > 0) {
      const bounds = incidentsWithLocation.map(
        (incident) => [incident.location_lat!, incident.location_lng!] as [number, number],
      );

      if (bounds.length > 0) {
        map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
        setTimeout(() => map.invalidateSize(), 100);
      }
    } else if (initialCenter && initialZoom) {
      // If no incidents, set to initial view
      const center = Array.isArray(initialCenter)
        ? initialCenter
        : [initialCenter.lat, initialCenter.lng];
      map.setView(center as [number, number], initialZoom);
      setTimeout(() => map.invalidateSize(), 100);
    }
  }, [map, incidents, selectedIncidentId, initialCenter, initialZoom]);

  return null;
};

/**
 * Fallback UI when map is disabled or failed to load
 */
const FallbackUI = () => (
  <div className="military-border p-8 text-center" style={{ height: '600px', minHeight: '600px' }}>
    <h3 className="text-lg terminal-text text-robotic-orange mb-4">[MAP_UNAVAILABLE]</h3>
    <p className="text-sm terminal-text text-robotic-yellow/70 mb-4">
      The interactive map is currently unavailable.
    </p>
    <p className="text-xs terminal-text text-robotic-yellow/50">
      Please check your connection or try refreshing the page.
    </p>
  </div>
);

/**
 * MapView Component - Simplified and Reliable
 *
 * Key improvements:
 * - Uses ResizeObserver to wait for container dimensions before initializing
 * - Simplified initialization logic
 * - Removed complex instance tracking
 * - Clean component lifecycle
 */
export const MapView = ({
  sessionId,
  incidents = [],
  resources = [],
  evacuationZones: initialEvacuationZones = [],
  onIncidentClick,
  onResourceClick,
  selectedIncidentId,
  initialCenter = [1.2931, 103.8558] as LatLngExpression,
  initialZoom = 13,
  disabled = false,
  isVisible = true,
  fillHeight = false,
  locationsRefreshTrigger = 0,
  showAllPins = false,
  currentState,
  draggableAssets = [],
  teamName,
}: MapViewProps) => {
  const mapDisabledByEnv = import.meta.env.VITE_DISABLE_MAP === 'true';
  const isMapDisabled = disabled || mapDisabledByEnv;

  const [evacuationZones, setEvacuationZones] = useState(initialEvacuationZones);
  const [scenarioLocations, setScenarioLocations] = useState<ScenarioLocationPin[]>([]);
  const [mapRevealedCategories, setMapRevealedCategories] = useState<string[]>([]);
  const [environmentalState, setEnvironmentalState] = useState<{
    routes?: RouteData[];
    areas?: CrowdArea[];
    wind?: WindData;
  } | null>(null);
  const [placedAssets, setPlacedAssets] = useState<PlacedAsset[]>([]);
  const [hazards, setHazards] = useState<HazardData[]>([]);
  const [selectedHazard, setSelectedHazard] = useState<HazardData | null>(null);
  const [floorPlans, setFloorPlans] = useState<FloorPlan[]>([]);
  const [activeFloor, setActiveFloor] = useState('G');
  const [isContainerReady, setIsContainerReady] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Fetch scenario locations (map pins) and which POI categories the user has asked the Insider about
  useEffect(() => {
    if (!sessionId || isMapDisabled) return;
    let cancelled = false;
    api.sessions
      .getLocations(sessionId)
      .then((res) => {
        if (cancelled) return;
        if (Array.isArray(res.data)) {
          setScenarioLocations(
            res.data.map((loc) => {
              const conds = (loc.conditions as Record<string, unknown>) ?? {};
              return {
                id: loc.id,
                location_type: loc.location_type,
                pin_category: conds.pin_category as string | undefined,
                narrative_description: conds.narrative_description as string | undefined,
                label: loc.label,
                coordinates: loc.coordinates ?? {},
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
  }, [sessionId, isMapDisabled, locationsRefreshTrigger]);

  // Listen for state updates: evacuation zones + environmental_state (Step 6)
  useWebSocket({
    sessionId,
    eventTypes: ['state.updated', 'placement.created', 'placement.updated', 'placement.removed'],
    onEvent: (event: WebSocketEvent) => {
      if (event.type === 'state.updated') {
        const state = (event.data as { state?: Record<string, unknown> })?.state;
        if (state?.evacuation_zones) {
          setEvacuationZones(state.evacuation_zones as EvacuationZoneData[]);
        }
        if (
          state &&
          typeof state.environmental_state === 'object' &&
          state.environmental_state !== null
        ) {
          setEnvironmentalState(
            state.environmental_state as {
              routes?: RouteData[];
              areas?: CrowdArea[];
              wind?: WindData;
            },
          );
        }
      }
      if (event.type === 'placement.created') {
        const { placement } = event.data as { placement: PlacedAsset };
        if (placement) {
          setPlacedAssets((prev) => [...prev.filter((p) => p.id !== placement.id), placement]);
        }
      }
      if (event.type === 'placement.updated') {
        const { placement } = event.data as { placement: PlacedAsset };
        if (placement) {
          setPlacedAssets((prev) => prev.map((p) => (p.id === placement.id ? placement : p)));
        }
      }
      if (event.type === 'placement.removed') {
        const { placement } = event.data as { placement: PlacedAsset };
        if (placement) {
          setPlacedAssets((prev) => prev.filter((p) => p.id !== placement.id));
        }
      }
    },
    enabled: !!sessionId && !isMapDisabled,
  });

  // Fetch existing placements and hazards on mount
  useEffect(() => {
    if (!sessionId || isMapDisabled) return;
    let cancelled = false;
    api.placements
      .list(sessionId)
      .then((res) => {
        if (cancelled) return;
        if (Array.isArray(res.data)) {
          setPlacedAssets(res.data as PlacedAsset[]);
        }
      })
      .catch(() => {
        /* ignore */
      });
    api.hazards
      .list(sessionId)
      .then((res) => {
        if (cancelled) return;
        if (Array.isArray(res.data)) {
          setHazards(res.data as HazardData[]);
        }
      })
      .catch(() => {
        /* ignore */
      });
    api.floorPlans
      .list(sessionId)
      .then((res) => {
        if (cancelled) return;
        if (Array.isArray(res.data)) {
          setFloorPlans(res.data as FloorPlan[]);
        }
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, isMapDisabled]);

  // Periodically refresh hazards (new ones may appear over time)
  useEffect(() => {
    if (!sessionId || isMapDisabled) return;
    const interval = setInterval(() => {
      api.hazards
        .list(sessionId)
        .then((res) => {
          if (Array.isArray(res.data)) {
            setHazards(res.data as HazardData[]);
          }
        })
        .catch(() => {
          /* ignore */
        });
    }, 30000);
    return () => clearInterval(interval);
  }, [sessionId, isMapDisabled]);

  // Filter incidents and resources with valid locations
  const incidentsWithLocation = incidents.filter(
    (incident) => incident.location_lat != null && incident.location_lng != null,
  );

  const resourcesWithLocation = resources.filter(
    (resource) => resource.location_lat != null && resource.location_lng != null,
  );

  const scenarioLocationsWithCoords = scenarioLocations.filter(
    (loc) => typeof loc.coordinates?.lat === 'number' && typeof loc.coordinates?.lng === 'number',
  );
  // Trainer sees all pins except cordon. Players see incident/access/triage/command/staging always;
  // poi only after Insider reveals it; cordon always hidden from players.
  // Pins with visible_after_state_key only appear once that state key is truthy.
  const scenarioLocationsForMap = scenarioLocationsWithCoords.filter((loc) => {
    // State-conditional visibility: hide until the referenced state key becomes truthy
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
    if (!insiderCat) return true; // unknown types default to visible
    return mapRevealedCategories.includes(insiderCat);
  });

  const unmanagedRoutes = Array.isArray(environmentalState?.routes)
    ? environmentalState.routes.filter((r) => r.managed === false)
    : [];
  const hasUnmanagedRoutes = unmanagedRoutes.length > 0;

  // Placement counts for the asset palette
  const ownPlacedCounts: Record<string, number> = {};
  if (teamName) {
    for (const p of placedAssets) {
      if (p.team_name === teamName) {
        ownPlacedCounts[p.asset_type] = (ownPlacedCounts[p.asset_type] ?? 0) + 1;
      }
    }
  }

  const handleRemovePlacement = async (placementId: string) => {
    try {
      await api.placements.remove(sessionId, placementId);
    } catch {
      /* handled by WS */
    }
  };

  // Key stable per session so map only remounts when session changes, not on every render
  const mapKey = `map-${sessionId}`;

  // Only clean on unmount. Do NOT clean on mount: React Strict Mode mount-unmount-remount
  // (or ref running after Leaflet has created DOM) would remove nodes Leaflet owns and cause removeChild errors.
  const cleanContainerElement = (element: HTMLDivElement | null) => {
    if (!element) return;
    const existingContainers = element.querySelectorAll('.leaflet-container');
    existingContainers.forEach((container) => {
      try {
        if ((container as any)._leaflet_id) {
          delete (container as any)._leaflet_id;
        }
        // Only remove if still in the DOM (React may have already removed it during teardown).
        if (container.parentNode) {
          container.parentNode.removeChild(container);
        }
      } catch (e) {
        // Ignore cleanup errors
      }
    });
    if ((element as any)._leaflet_id) {
      delete (element as any)._leaflet_id;
    }
  };

  // Callback ref: set ref and mark container ready so MapContainer (Leaflet) mounts immediately.
  const containerCallbackRef = (element: HTMLDivElement | null) => {
    if (element) {
      containerRef.current = element;
      setIsContainerReady(true);
    } else {
      setIsContainerReady(false);
      // Do not clear containerRef here so useEffect cleanup can still clean the container
    }
  };

  // Clean only on unmount (e.g. navigate away); MapCleanup runs map.remove() before this.
  useEffect(() => {
    return () => {
      const el = containerRef.current;
      if (el?.isConnected) {
        cleanContainerElement(el);
      }
      containerRef.current = null;
    };
  }, [mapKey]);

  if (isMapDisabled) {
    return <FallbackUI />;
  }

  // When fillHeight, use fixed pixel height so Leaflet always has dimensions (avoids blank map from 100% resolving to 0)
  const mapHeight = fillHeight ? '620px' : '600px';

  return (
    <div
      ref={containerCallbackRef}
      className="military-border w-full relative"
      style={{
        height: mapHeight,
        minHeight: mapHeight,
        width: '100%',
        position: 'relative',
        display: 'block',
      }}
    >
      {/* Route status legend */}
      {Array.isArray(environmentalState?.routes) && environmentalState.routes.length > 0 && (
        <div
          className="absolute top-2 left-2 z-[1000] px-3 py-2 rounded bg-black/85 border border-robotic-yellow/50 text-xs terminal-text text-robotic-yellow space-y-1"
          aria-label="Route status legend"
        >
          <div className="font-medium mb-1">Routes</div>
          {hasUnmanagedRoutes && (
            <div className="flex items-center gap-2">
              <span className="inline-block w-3 h-0.5 bg-red-500 rounded" />
              <span>{unmanagedRoutes.length} unmanaged</span>
            </div>
          )}
          {environmentalState.routes.filter((r) => r.problem && r.managed).length > 0 && (
            <div className="flex items-center gap-2">
              <span className="inline-block w-3 h-0.5 bg-amber-500 rounded" />
              <span>
                {environmentalState.routes.filter((r) => r.problem && r.managed).length} managed
              </span>
            </div>
          )}
          {environmentalState.routes.filter((r) => !r.problem).length > 0 && (
            <div className="flex items-center gap-2">
              <span className="inline-block w-3 h-0.5 bg-green-500 rounded" />
              <span>{environmentalState.routes.filter((r) => !r.problem).length} clear</span>
            </div>
          )}
        </div>
      )}
      {isContainerReady && (
        <MapContainer
          key={mapKey}
          center={initialCenter}
          zoom={initialZoom}
          style={{
            height: '100%',
            width: '100%',
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
          }}
          className="leaflet-container"
          scrollWheelZoom={true}
          doubleClickZoom={true}
          zoomControl={true}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            subdomains={['a', 'b', 'c']}
            noWrap={false}
            updateWhenZooming={true}
            updateWhenIdle={true}
            maxZoom={19}
            minZoom={2}
            eventHandlers={{
              loading: () => console.log('[MapView] Tiles loading...'),
              load: () => console.log('[MapView] Tiles loaded'),
              tileerror: (error) => {
                console.error('[MapView] Tile error:', error);
              },
            }}
          />

          <MapInitializer
            initialCenter={initialCenter}
            initialZoom={initialZoom}
            onReady={() => {
              console.log('[MapView] Map initialized and ready');
            }}
          />
          <MapSizeInvalidator isVisible={isVisible} />
          <MapCleanup />

          {/* Drop handler for drag-and-drop asset placement */}
          {teamName && (
            <MapDropHandler
              sessionId={sessionId}
              teamName={teamName}
              enabled={draggableAssets.length > 0 && !disabled}
            />
          )}

          <MapUpdater
            incidents={incidents}
            selectedIncidentId={selectedIncidentId}
            initialCenter={initialCenter}
            initialZoom={initialZoom}
          />

          {/* Route Polylines */}
          {Array.isArray(environmentalState?.routes) &&
            environmentalState.routes
              .filter((r) => r.geometry?.length && r.geometry.length >= 2)
              .map((route, idx) => (
                <RoutePolyline key={`route-${route.label ?? idx}`} route={route} />
              ))}

          {/* Blast Zone Overlays from incident_site pins */}
          {scenarioLocationsForMap
            .filter((loc) => {
              const cat = loc.pin_category?.toLowerCase() ?? '';
              const t = loc.location_type.toLowerCase();
              return cat === 'incident_site' || t.includes('blast') || t.includes('epicentre');
            })
            .filter((loc) => loc.conditions?.blast_radius_m)
            .map((loc) => (
              <BlastZoneOverlay
                key={`blast-${loc.id}`}
                center={[loc.coordinates.lat!, loc.coordinates.lng!] as LatLngExpression}
                blastRadius={loc.conditions!.blast_radius_m as number}
                innerCordonRadius={loc.conditions?.inner_cordon_radius_m as number | undefined}
                outerCordonRadius={loc.conditions?.outer_cordon_radius_m as number | undefined}
                label={loc.label}
              />
            ))}

          {/* Crowd Density Overlay */}
          {Array.isArray(environmentalState?.areas) && environmentalState.areas.length > 0 && (
            <CrowdDensityOverlay areas={environmentalState.areas} />
          )}

          {/* Wind Direction Indicator */}
          {environmentalState?.wind && <WindIndicator wind={environmentalState.wind} />}

          {/* Evacuation Zones */}
          {evacuationZones.map((zone) => (
            <EvacuationZone
              key={zone.id}
              center={[zone.center_lat, zone.center_lng] as LatLngExpression}
              radius={zone.radius_meters}
              title={zone.title}
            />
          ))}

          {/* Scenario location pins (Step 6: labels only; cordon hidden so teams decide) */}
          {scenarioLocationsForMap.map((loc) => (
            <ScenarioLocationMarker
              key={loc.id}
              location={loc}
              position={[loc.coordinates.lat!, loc.coordinates.lng!] as LatLngExpression}
            />
          ))}

          {/* Incident Markers */}
          {incidentsWithLocation.map((incident) => (
            <IncidentMarker
              key={incident.id}
              incident={incident}
              position={[incident.location_lat!, incident.location_lng!] as LatLngExpression}
              onClick={() => onIncidentClick?.(incident)}
              isSelected={selectedIncidentId === incident.id}
            />
          ))}

          {/* Resource Markers */}
          {resourcesWithLocation.map((resource, idx) => (
            <ResourceMarker
              key={resource.id || `resource-${idx}`}
              resource={resource}
              position={[resource.location_lat!, resource.location_lng!] as LatLngExpression}
              onClick={() => onResourceClick?.(resource)}
            />
          ))}

          {/* Placed Assets (Phase 3) — filtered by active floor when multi-floor */}
          {placedAssets
            .filter((a) => {
              if (!floorPlans.length) return true;
              const floor = (a.properties?.floor_level as string) ?? 'G';
              return floor === activeFloor;
            })
            .map((asset) => (
              <PlacedAssetMarker
                key={asset.id}
                asset={asset}
                isOwnTeam={!!teamName && asset.team_name === teamName}
                onRemove={
                  teamName && asset.team_name === teamName ? handleRemovePlacement : undefined
                }
              />
            ))}

          {/* Floor Plan Overlay (Phase 5) */}
          {floorPlans
            .filter((f) => f.floor_level === activeFloor)
            .map((floor) => (
              <FloorPlanOverlay key={floor.id} floor={floor} />
            ))}

          {/* Hazard Markers (Phase 4) — filtered by active floor */}
          {hazards
            .filter((h) => h.status !== 'resolved')
            .filter((h) => h.floor_level === activeFloor || !floorPlans.length)
            .map((hazard) => (
              <HazardMarker key={hazard.id} hazard={hazard} onClick={setSelectedHazard} />
            ))}
        </MapContainer>
      )}

      {/* Asset Palette (Phase 3) */}
      {draggableAssets.length > 0 && teamName && (
        <AssetPalette
          assets={draggableAssets}
          teamName={teamName}
          placedCounts={ownPlacedCounts}
          onAssetDragStart={() => {}}
          disabled={disabled}
        />
      )}

      {/* Floor Selector (Phase 5) */}
      {floorPlans.length > 1 && (
        <FloorSelector
          floors={floorPlans}
          activeFloor={activeFloor}
          onFloorChange={setActiveFloor}
          hazardFloors={
            new Set(hazards.filter((h) => h.status !== 'resolved').map((h) => h.floor_level))
          }
        />
      )}

      {/* Hazard Assessment Modal (Phase 4) */}
      {selectedHazard && (
        <HazardAssessmentModal
          hazard={selectedHazard}
          onClose={() => setSelectedHazard(null)}
          onSubmitDecision={async (hazardId, description) => {
            try {
              await api.decisions.create({
                session_id: sessionId,
                description: `[Hazard Assessment: ${selectedHazard.hazard_type.replace(/_/g, ' ')}] ${description}`,
                team_name: teamName,
              });
            } catch {
              /* ignore */
            }
          }}
        />
      )}
    </div>
  );
};
