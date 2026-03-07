import { useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import { Icon, Marker as LeafletMarker } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { IncidentMarker } from './IncidentMarker';
import { ResourceMarker } from './ResourceMarker';
import { EvacuationZone } from './EvacuationZone';
import { ScenarioLocationMarker, type ScenarioLocationPin } from './ScenarioLocationMarker';
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
}

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
}: MapViewProps) => {
  const mapDisabledByEnv = import.meta.env.VITE_DISABLE_MAP === 'true';
  const isMapDisabled = disabled || mapDisabledByEnv;

  const [evacuationZones, setEvacuationZones] = useState(initialEvacuationZones);
  const [scenarioLocations, setScenarioLocations] = useState<ScenarioLocationPin[]>([]);
  const [environmentalState, setEnvironmentalState] = useState<{
    routes?: Array<{ label?: string; managed?: boolean }>;
    areas?: unknown[];
  } | null>(null);
  const [isContainerReady, setIsContainerReady] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Fetch scenario locations (map pins) for this session's scenario
  useEffect(() => {
    if (!sessionId || isMapDisabled) return;
    let cancelled = false;
    api.sessions
      .getLocations(sessionId)
      .then((res) => {
        if (!cancelled && Array.isArray(res.data)) {
          setScenarioLocations(
            res.data.map((loc) => ({
              id: loc.id,
              location_type: loc.location_type,
              label: loc.label,
              coordinates: loc.coordinates ?? {},
            })),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setScenarioLocations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, isMapDisabled]);

  // Listen for state updates: evacuation zones + environmental_state (Step 6)
  useWebSocket({
    sessionId,
    eventTypes: ['state.updated'],
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
              routes?: Array<{ label?: string; managed?: boolean }>;
              areas?: unknown[];
            },
          );
        }
      }
    },
    enabled: !!sessionId && !isMapDisabled,
  });

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
  // Hide cordon so teams must decide whether and where to place it
  const scenarioLocationsForMap = scenarioLocationsWithCoords.filter(
    (loc) => loc.location_type !== 'cordon',
  );

  const unmanagedRoutes = Array.isArray(environmentalState?.routes)
    ? environmentalState.routes.filter((r) => r.managed === false)
    : [];
  const hasUnmanagedRoutes = unmanagedRoutes.length > 0;

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

  // Callback ref: on mount only set ref and schedule ready; do NOT run cleanContainerElement here.
  const containerCallbackRef = (element: HTMLDivElement | null) => {
    if (element) {
      containerRef.current = element;
      requestAnimationFrame(() => setIsContainerReady(true));
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

  return (
    <div
      ref={containerCallbackRef}
      className="military-border w-full relative"
      style={{
        height: '600px',
        minHeight: '600px',
        width: '100%',
        position: 'relative',
        display: 'block',
      }}
    >
      {/* Optional legend: environmental state (traffic / routes) */}
      {hasUnmanagedRoutes && (
        <div
          className="absolute top-2 left-2 z-[1000] px-2 py-1.5 rounded bg-black/80 border border-robotic-yellow/50 text-xs terminal-text text-robotic-yellow"
          aria-label="Environmental state legend"
        >
          <span className="font-medium">Traffic / routes:</span> {unmanagedRoutes.length} unmanaged
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
          <MapCleanup />

          <MapUpdater
            incidents={incidents}
            selectedIncidentId={selectedIncidentId}
            initialCenter={initialCenter}
            initialZoom={initialZoom}
          />

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
        </MapContainer>
      )}
    </div>
  );
};
