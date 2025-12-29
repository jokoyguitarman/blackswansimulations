import { useEffect, useRef, useState, useMemo } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import { Icon, Marker as LeafletMarker, Map as LeafletMap } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { IncidentMarker } from './IncidentMarker';
import { ResourceMarker } from './ResourceMarker';
import { EvacuationZone } from './EvacuationZone';
import { useWebSocket } from '../../hooks/useWebSocket';
import type { LatLngExpression } from 'leaflet';

type WebSocketEvent = {
  type: string;
  data: unknown;
};

// Global map instance registry to prevent double initialization in StrictMode
const mapInstances = new Map<string, LeafletMap>();

// Clean up map instance
const cleanupMapInstance = (instanceId: string) => {
  const map = mapInstances.get(instanceId);
  if (map) {
    try {
      map.remove();
    } catch (e) {
      // Ignore cleanup errors
    }
    mapInstances.delete(instanceId);
  }
};

/**
 * MapView Component - Client-side only
 * Separation of concerns: UI for interactive map display
 */

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

// Set default icon
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
  disabled?: boolean; // Option to skip/disable map entirely
}

// Component to handle map initialization (runs when map is created)
const MapInitializer = ({
  instanceId,
  initialCenter,
  initialZoom,
  mapInstanceRef,
}: {
  instanceId: string;
  initialCenter?: LatLngExpression;
  initialZoom?: number;
  mapInstanceRef: React.MutableRefObject<LeafletMap | null>;
}) => {
  const map = useMap();
  const hasInitialized = useRef(false);

  useEffect(() => {
    if (hasInitialized.current) return;

    console.log('[MapInitializer] Map created!', map);
    console.log('[MapInitializer] Instance ID:', instanceId);
    console.log('[MapInitializer] Existing instance?', mapInstances.has(instanceId));

    // Final check: ensure no duplicate instance exists
    if (mapInstances.has(instanceId)) {
      const existingMap = mapInstances.get(instanceId);
      if (existingMap && existingMap !== map) {
        // Duplicate detected - remove this one immediately
        console.warn('[MapInitializer] Duplicate map detected, removing...');
        try {
          map.remove();
        } catch (e) {
          console.error('[MapInitializer] Error removing duplicate map:', e);
        }
        return;
      }
    }

    // Clean up any stale reference
    if (mapInstanceRef.current && mapInstanceRef.current !== map) {
      console.log('[MapInitializer] Cleaning up stale map reference');
      try {
        mapInstanceRef.current.remove();
      } catch (e) {
        console.error('[MapInitializer] Error removing stale map:', e);
      }
    }

    // Register this instance globally
    mapInstances.set(instanceId, map);
    mapInstanceRef.current = map;
    console.log('[MapInitializer] Map registered successfully:', instanceId);

    // CRITICAL: Wait for container to have actual DOM dimensions before setting view
    // VERSION 4.0 - Robust dimension checking with parent container validation and ResizeObserver
    const setupMap = () => {
      try {
        console.log('[MapInitializer] Setting up map... [VERSION 4.0]');

        // Get DOM container directly
        const container = map.getContainer();
        if (!container) {
          console.error('[MapInitializer] Container element not found!');
          return;
        }

        // Force layout recalculation by accessing layout properties
        // This ensures CSS has been computed
        void container.offsetWidth;
        void container.offsetHeight;

        // Check parent containers to ensure they have dimensions
        let parent = container.parentElement;
        let parentLevel = 0;
        while (parent && parentLevel < 5) {
          const parentWidth = parent.offsetWidth || parent.clientWidth;
          const parentHeight = parent.offsetHeight || parent.clientHeight;
          const parentRect = parent.getBoundingClientRect();
          console.log(`[MapInitializer] Parent level ${parentLevel}:`, {
            tag: parent.tagName,
            className: parent.className,
            offsetWidth: parentWidth,
            offsetHeight: parentHeight,
            rect: { width: parentRect.width, height: parentRect.height },
            computedWidth: window.getComputedStyle(parent).width,
            computedHeight: window.getComputedStyle(parent).height,
            display: window.getComputedStyle(parent).display,
          });
          parent = parent.parentElement;
          parentLevel++;
        }

        // Check actual DOM dimensions - these are the REAL computed values
        const rect = container.getBoundingClientRect();
        const domWidth = container.offsetWidth;
        const domHeight = container.offsetHeight;
        const clientWidth = container.clientWidth;
        const clientHeight = container.clientHeight;
        const computedStyle = window.getComputedStyle(container);
        const leafletSize = map.getSize();

        console.log('[MapInitializer] DOM dimensions check:', {
          offsetWidth: domWidth,
          offsetHeight: domHeight,
          clientWidth: clientWidth,
          clientHeight: clientHeight,
          rect: { width: rect.width, height: rect.height },
          computedHeight: computedStyle.height,
          computedWidth: computedStyle.width,
          display: computedStyle.display,
          visibility: computedStyle.visibility,
          position: computedStyle.position,
        });
        console.log('[MapInitializer] Leaflet reported size:', leafletSize);

        // If DOM has dimensions but Leaflet doesn't, force update
        if (domWidth > 0 && domHeight > 0) {
          console.log('[MapInitializer] DOM has dimensions, proceeding...');
          if (leafletSize.x === 0 || leafletSize.y === 0) {
            console.log("[MapInitializer] DOM has size but Leaflet doesn't - forcing resize...");
            // Force multiple invalidations to ensure Leaflet sees the dimensions
            map.invalidateSize();
            requestAnimationFrame(() => {
              map.invalidateSize();
              requestAnimationFrame(() => {
                map.invalidateSize();
                const newSize = map.getSize();
                console.log('[MapInitializer] After forced resize, Leaflet size:', newSize);
                if (newSize.x > 0 && newSize.y > 0) {
                  continueSetup();
                } else {
                  // Force window resize event to trigger Leaflet's resize handler
                  window.dispatchEvent(new Event('resize'));
                  setTimeout(() => {
                    map.invalidateSize();
                    continueSetup();
                  }, 100);
                }
              });
            });
          } else {
            continueSetup();
          }
        } else {
          console.warn('[MapInitializer] DOM container has no dimensions yet!');
          console.warn('[MapInitializer] offsetWidth:', domWidth, 'offsetHeight:', domHeight);
          console.warn("[MapInitializer] This means parent containers don't have dimensions yet");

          // Use ResizeObserver to wait for container to get dimensions
          if ('ResizeObserver' in window) {
            let observerFired = false;
            const resizeObserver = new ResizeObserver((entries) => {
              for (const entry of entries) {
                const { width, height } = entry.contentRect;
                console.log('[MapInitializer] ResizeObserver fired, dimensions:', width, height);
                if (width > 0 && height > 0 && !observerFired) {
                  observerFired = true;
                  resizeObserver.disconnect();
                  console.log(
                    '[MapInitializer] Container got dimensions via ResizeObserver, setting up...',
                  );
                  map.invalidateSize();
                  setTimeout(() => {
                    continueSetup();
                  }, 100);
                  return;
                }
              }
            });
            resizeObserver.observe(container);

            // Fallback timeout
            setTimeout(() => {
              if (!observerFired) {
                console.warn('[MapInitializer] ResizeObserver timeout, forcing setup anyway...');
                resizeObserver.disconnect();
                map.invalidateSize();
                continueSetup();
              }
            }, 3000);
          } else {
            // Fallback: wait and retry
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                setTimeout(() => {
                  map.invalidateSize();
                  const newDomWidth = container.offsetWidth;
                  const newDomHeight = container.offsetHeight;
                  console.log('[MapInitializer] After wait, DOM dimensions:', {
                    width: newDomWidth,
                    height: newDomHeight,
                  });
                  if (newDomWidth > 0 && newDomHeight > 0) {
                    continueSetup();
                  } else {
                    console.warn(
                      '[MapInitializer] Container still has no dimensions, forcing setup...',
                    );
                    continueSetup();
                  }
                }, 500);
              });
            });
          }
        }
      } catch (e) {
        console.error('[MapInitializer] Error setting up map:', e);
        // Still try to continue
        continueSetup();
      }
    };

    const continueSetup = () => {
      try {
        // Get the actual DOM container element and check its computed dimensions
        const container = map.getContainer();
        if (!container) {
          console.error('[MapInitializer] Container element not found!');
          return;
        }

        // Force layout recalculation by accessing layout properties
        const containerRect = container.getBoundingClientRect();
        const containerWidth = container.offsetWidth || containerRect.width;
        const containerHeight = container.offsetHeight || containerRect.height;

        console.log('[MapInitializer] DOM container dimensions:', {
          offsetWidth: container.offsetWidth,
          offsetHeight: container.offsetHeight,
          clientWidth: container.clientWidth,
          clientHeight: container.clientHeight,
          getBoundingClientRect: containerRect,
          computedWidth: containerWidth,
          computedHeight: containerHeight,
        });

        // If DOM element has dimensions but Leaflet doesn't, force update
        if (containerWidth > 0 && containerHeight > 0) {
          // Force Leaflet to recalculate size by directly setting container size
          const leafletSize = map.getSize();
          console.log('[MapInitializer] Leaflet reported size:', leafletSize);

          if (leafletSize.x === 0 || leafletSize.y === 0) {
            console.log(
              '[MapInitializer] Leaflet size is 0 but DOM has dimensions, forcing resize...',
            );
            // Trigger resize event to force Leaflet to recalculate
            window.dispatchEvent(new Event('resize'));
            map.invalidateSize();

            // Wait a bit and check again
            setTimeout(() => {
              const newSize = map.getSize();
              console.log('[MapInitializer] Leaflet size after forced resize:', newSize);
              if (newSize.x > 0 && newSize.y > 0) {
                setMapView();
              } else {
                // Last resort: manually set size on Leaflet map
                console.log('[MapInitializer] Attempting manual size fix...');
                try {
                  // Access internal Leaflet properties to force size
                  (map as any)._onResize();
                  setTimeout(() => setMapView(), 100);
                } catch (e) {
                  console.error('[MapInitializer] Manual resize failed:', e);
                  // Still try to set view - might work anyway
                  setMapView();
                }
              }
            }, 100);
          } else {
            setMapView();
          }
        } else {
          console.warn('[MapInitializer] DOM container also has 0x0 dimensions, waiting longer...');
          // Container itself has no size - might be hidden or not laid out
          setTimeout(() => {
            map.invalidateSize();
            const newRect = container.getBoundingClientRect();
            if (newRect.width > 0 && newRect.height > 0) {
              continueSetup(); // Retry
            } else {
              console.error('[MapInitializer] Container still has no dimensions after wait');
              // Set view anyway - might work when container becomes visible
              setMapView();
            }
          }, 500);
        }
      } catch (e) {
        console.error('[MapInitializer] Error in continueSetup:', e);
        // Still try to set view
        setMapView();
      }
    };

    const setMapView = () => {
      try {
        map.invalidateSize();
        const size = map.getSize();
        console.log('[MapInitializer] Setting view, container size:', size);

        if (initialCenter && initialZoom !== undefined) {
          const center = Array.isArray(initialCenter)
            ? initialCenter
            : [initialCenter.lat, initialCenter.lng];

          console.log('[MapInitializer] Setting view to:', center, initialZoom);
          map.setView(center as [number, number], initialZoom, { animate: false });

          // Verify after a delay
          setTimeout(() => {
            map.invalidateSize();
            const actualZoom = map.getZoom();
            const actualCenter = map.getCenter();
            const bounds = map.getBounds();
            const finalSize = map.getSize();
            const container = map.getContainer();
            const domSize = container
              ? {
                  width: container.offsetWidth,
                  height: container.offsetHeight,
                }
              : null;

            console.log('[MapInitializer] View set successfully');
            console.log('[MapInitializer] Actual zoom:', actualZoom);
            console.log('[MapInitializer] Actual center:', actualCenter);
            console.log('[MapInitializer] Map bounds:', bounds?.toBBoxString());
            console.log('[MapInitializer] Leaflet container size:', finalSize);
            console.log('[MapInitializer] DOM container size:', domSize);

            if (finalSize.x === 0 || finalSize.y === 0) {
              console.error('[MapInitializer] ERROR: Leaflet still reports 0x0 size!');
              if (domSize && domSize.width > 0 && domSize.height > 0) {
                console.log('[MapInitializer] But DOM has dimensions - tiles might still load');
              }
            } else {
              console.log('[MapInitializer] Container size is valid, tiles should load now');
            }
          }, 200);
        }
      } catch (e) {
        console.error('[MapInitializer] Error setting map view:', e);
      }
    };

    // Use ResizeObserver to detect when container gets dimensions
    const container = map.getContainer();
    if (container && 'ResizeObserver' in window) {
      let observerSetup = false;
      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          console.log('[MapInitializer] ResizeObserver fired, dimensions:', width, height);
          if (width > 0 && height > 0 && !hasInitialized.current) {
            console.log('[MapInitializer] Container has dimensions, setting up map...');
            resizeObserver.disconnect();
            observerSetup = true;
            setupMap();
            return;
          }
        }
      });
      resizeObserver.observe(container);

      // Also call setup immediately in case dimensions are already available
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!observerSetup && !hasInitialized.current) {
            const rect = container.getBoundingClientRect();
            const width = container.offsetWidth || rect.width;
            const height = container.offsetHeight || rect.height;
            console.log('[MapInitializer] Immediate check, dimensions:', width, height);
            if (width > 0 && height > 0) {
              resizeObserver.disconnect();
              observerSetup = true;
              setupMap();
            }
          }
        });
      });

      // Fallback timeout
      setTimeout(() => {
        if (!observerSetup && !hasInitialized.current) {
          console.log('[MapInitializer] ResizeObserver timeout, forcing setup...');
          resizeObserver.disconnect();
          setupMap();
        }
      }, 2000);
    } else {
      // Fallback: Call setup when map is ready
      map.whenReady(() => {
        console.log('[MapInitializer] Map.whenReady() called');
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setupMap();
          });
        });
      });

      // Also call after a delay as backup
      setTimeout(() => {
        if (!hasInitialized.current) {
          console.log('[MapInitializer] Backup setup after timeout');
          setupMap();
        }
      }, 500);
    }

    // Clean up on map destroy
    map.on('remove', () => {
      console.log('[MapInitializer] Map being removed');
      mapInstances.delete(instanceId);
      if (mapInstanceRef.current === map) {
        mapInstanceRef.current = null;
      }
    });

    hasInitialized.current = true;

    return () => {
      // Cleanup on unmount
      mapInstances.delete(instanceId);
      if (mapInstanceRef.current === map) {
        mapInstanceRef.current = null;
      }
    };
  }, [map, instanceId, initialCenter, initialZoom, mapInstanceRef]);

  return null;
};

// Component to handle map updates and centering
const MapUpdater = ({
  incidents,
  // resources, // Unused - keeping for potential future use
  // evacuationZones, // Unused - keeping for potential future use
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
  const hasInitialized = useRef(false);

  // CRITICAL: Invalidate size on mount and window resize (don't set view here - MapInitializer does that)
  useEffect(() => {
    if (hasInitialized.current) return;

    // Give map time to render, then invalidate size
    const timer = setTimeout(() => {
      try {
        console.log('[MapUpdater] Invalidating map size after mount...');
        const size = map.getSize();
        const zoom = map.getZoom();
        const center = map.getCenter();

        map.invalidateSize();

        console.log('[MapUpdater] Map size invalidated');
        console.log('[MapUpdater] Current zoom:', zoom);
        console.log('[MapUpdater] Current center:', center);
        console.log('[MapUpdater] Map bounds:', map.getBounds()?.toBBoxString());
        console.log('[MapUpdater] Map container size:', size);

        // Check if size is valid
        if (size && size.x > 0 && size.y > 0) {
          console.log('[MapUpdater] Container size is valid');
        } else {
          console.warn('[MapUpdater] WARNING: Container size might be invalid:', size);
        }

        hasInitialized.current = true;
      } catch (e) {
        console.error('[MapUpdater] Error invalidating size:', e);
      }
    }, 300); // Delay to ensure container is ready

    // Also invalidate on window resize
    const handleResize = () => {
      try {
        map.invalidateSize();
      } catch (e) {
        // Ignore errors
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', handleResize);
    };
  }, [map, initialCenter, initialZoom]);

  // Center map on selected incident
  useEffect(() => {
    if (selectedIncidentId && incidents && incidents.length > 0) {
      const selectedIncident = incidents.find((inc) => inc.id === selectedIncidentId);
      if (selectedIncident && selectedIncident.location_lat && selectedIncident.location_lng) {
        map.setView(
          [selectedIncident.location_lat, selectedIncident.location_lng] as [number, number],
          16,
          { animate: true, duration: 0.5 },
        );
        setTimeout(() => map.invalidateSize(), 100);
      }
    }
  }, [map, selectedIncidentId, incidents]);

  // Fit map to show all incidents (only when no specific incident is selected AND we have incidents)
  useEffect(() => {
    if (selectedIncidentId) return; // Don't fit if an incident is selected
    if (!incidents || incidents.length === 0) return; // Don't fit if no incidents

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
    }
  }, [map, incidents, selectedIncidentId]);

  return null;
};

export const MapView = ({
  sessionId,
  incidents = [],
  resources = [],
  evacuationZones: initialEvacuationZones = [],
  onIncidentClick,
  onResourceClick,
  selectedIncidentId,
  initialCenter = [1.2931, 103.8558] as LatLngExpression, // Singapore default (Suntec City area)
  initialZoom = 13,
  disabled = false,
}: MapViewProps) => {
  // Check environment variable to disable map
  const mapDisabledByEnv = import.meta.env.VITE_DISABLE_MAP === 'true';
  const isMapDisabled = disabled || mapDisabledByEnv;

  const [evacuationZones, setEvacuationZones] = useState(initialEvacuationZones);
  const [mapError, setMapError] = useState<string | null>(null);
  const mapInstanceRef = useRef<LeafletMap | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Create a stable instance ID that persists across StrictMode remounts
  const instanceId = useMemo(() => `map-instance-${sessionId}`, [sessionId]);

  // Use a unique key that changes when sessionId changes to force remount
  // This prevents Leaflet from trying to initialize on an already-initialized container
  const [mapKey, setMapKey] = useState(() => `map-${sessionId}-${Date.now()}-${Math.random()}`);

  // Cleanup map instance before remounting
  useEffect(() => {
    // Clean up existing instance for this sessionId
    cleanupMapInstance(instanceId);

    return () => {
      // Clean up on unmount
      cleanupMapInstance(instanceId);
      if (mapInstanceRef.current) {
        mapInstanceRef.current = null;
      }
    };
  }, [instanceId]);

  // Update key when sessionId changes and cleanup old map
  useEffect(() => {
    // Clean up previous instance
    cleanupMapInstance(instanceId);

    // Generate new key to force remount
    setMapKey(`map-${sessionId}-${Date.now()}-${Math.random()}`);
    setMapError(null); // Reset error on session change
  }, [sessionId, instanceId]);

  // Listen for state updates to add evacuation zones
  useWebSocket({
    sessionId,
    eventTypes: ['state.updated'],
    onEvent: (event: WebSocketEvent) => {
      if (event.type === 'state.updated') {
        const state = (event.data as any).state;
        if (state?.evacuation_zones) {
          setEvacuationZones(state.evacuation_zones);
        }
      }
    },
    enabled: !!sessionId,
  });

  // Filter incidents and resources with valid locations
  const incidentsWithLocation = incidents.filter(
    (incident) => incident.location_lat && incident.location_lng,
  );
  const resourcesWithLocation = resources.filter(
    (resource) => resource.location_lat && resource.location_lng,
  );

  // Fallback UI component (reusable)
  const FallbackUI = () => (
    <div className="military-border h-[600px] w-full relative flex items-center justify-center bg-robotic-gray-300/10">
      <div className="text-center p-8">
        <div className="text-2xl terminal-text text-robotic-yellow mb-4 uppercase">
          [MAP UNAVAILABLE]
        </div>
        <p className="text-sm terminal-text text-robotic-yellow/70 mb-4">
          {disabled
            ? 'Map is disabled.'
            : 'Map loading failed. Continuing without map visualization.'}
        </p>
        <div className="text-xs terminal-text text-robotic-yellow/50 mb-6">
          {incidentsWithLocation.length > 0 && (
            <div className="mb-2">
              {incidentsWithLocation.length} incident{incidentsWithLocation.length !== 1 ? 's' : ''}{' '}
              with location data
            </div>
          )}
          {resourcesWithLocation.length > 0 && (
            <div>
              {resourcesWithLocation.length} resource{resourcesWithLocation.length !== 1 ? 's' : ''}{' '}
              with location data
            </div>
          )}
        </div>
        {!isMapDisabled && (
          <>
            <button
              onClick={() => {
                // Cleanup existing map instance
                if (mapInstanceRef.current) {
                  try {
                    mapInstanceRef.current.remove();
                  } catch (e) {
                    // Ignore cleanup errors
                  }
                  mapInstanceRef.current = null;
                }

                // Clear any Leaflet containers
                if (containerRef.current) {
                  const containers = containerRef.current.querySelectorAll('.leaflet-container');
                  containers.forEach((container) => {
                    try {
                      const mapId = (container as any)._leaflet_id;
                      if (mapId && (window as any).L) {
                        const map = (window as any).L.Map.prototype.get(mapId);
                        if (map) map.remove();
                      }
                    } catch (e) {
                      // Ignore
                    }
                  });
                }

                // Reset and remount
                setMapError(null);
                setMapKey(`map-${sessionId}-${Date.now()}-${Math.random()}`);
              }}
              className="px-4 py-2 military-border border-robotic-yellow text-robotic-yellow hover:bg-robotic-yellow/20 transition-colors text-sm terminal-text uppercase mr-2"
            >
              [RETRY MAP]
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 military-border border-robotic-orange text-robotic-orange hover:bg-robotic-orange/20 transition-colors text-sm terminal-text uppercase"
            >
              [RELOAD PAGE]
            </button>
          </>
        )}
      </div>
    </div>
  );

  // Global error handler for Leaflet initialization errors
  useEffect(() => {
    const handleError = (e: ErrorEvent) => {
      const errorMessage = e.message || e.error?.message || '';
      if (
        errorMessage.includes('already initialized') ||
        errorMessage.includes('Map container is already initialized')
      ) {
        setMapError('Map container already initialized. Reloading map...');
        // Auto-retry after a brief delay
        setTimeout(() => {
          // Force cleanup and remount
          if (mapInstanceRef.current) {
            try {
              mapInstanceRef.current.remove();
            } catch (err) {
              // Ignore
            }
          }
          mapInstanceRef.current = null;
          setMapError(null);
          setMapKey(`map-${sessionId}-${Date.now()}-${Math.random()}`);
        }, 500);
      }
    };

    const handleUnhandledRejection = (e: PromiseRejectionEvent) => {
      const errorMessage = e.reason?.message || String(e.reason || '');
      if (
        errorMessage.includes('already initialized') ||
        errorMessage.includes('Map container is already initialized')
      ) {
        setMapError('Map container already initialized. Reloading map...');
        setTimeout(() => {
          if (mapInstanceRef.current) {
            try {
              mapInstanceRef.current.remove();
            } catch (err) {
              // Ignore
            }
          }
          mapInstanceRef.current = null;
          setMapError(null);
          setMapKey(`map-${sessionId}-${Date.now()}-${Math.random()}`);
        }, 500);
      }
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  }, [sessionId]);

  // Generate unique container ID each render to ensure freshness
  const containerId = `leaflet-map-container-${sessionId}-${mapKey.split('-').pop()}`;

  // Clean function to remove all Leaflet traces from DOM element
  const cleanContainerElement = (container: HTMLDivElement) => {
    // Remove any existing Leaflet containers
    const leafletContainers = container.querySelectorAll('.leaflet-container');
    leafletContainers.forEach((leafletDiv) => {
      try {
        // Remove Leaflet's internal ID
        if ((leafletDiv as any)._leaflet_id) {
          const leafletId = (leafletDiv as any)._leaflet_id;
          // Try to get and remove the map instance
          if ((window as any).L?.Map) {
            try {
              const existingMap = (window as any).L.Map.prototype.get(leafletId);
              if (existingMap) {
                existingMap.remove();
              }
            } catch (e) {
              // Map might not exist in registry, continue cleanup
            }
          }
          delete (leafletDiv as any)._leaflet_id;
        }
        // Remove the element
        leafletDiv.remove();
      } catch (e) {
        // Ignore cleanup errors
      }
    });

    // Clean any Leaflet properties on the container itself
    if ((container as any)._leaflet_id) {
      delete (container as any)._leaflet_id;
    }
  };

  // Callback ref - runs SYNCHRONOUSLY when React mounts the div
  // This is critical: it runs BEFORE MapContainer renders, preventing double initialization
  const containerCallbackRef = (element: HTMLDivElement | null) => {
    console.log('[MapView] Callback ref called with element:', !!element);

    // Store ref for other uses
    containerRef.current = element;

    if (element) {
      console.log('[MapView] Cleaning container element before MapContainer renders');
      console.log(
        '[MapView] Existing leaflet containers:',
        element.querySelectorAll('.leaflet-container').length,
      );

      // Clean immediately when div is mounted - runs BEFORE children render
      cleanContainerElement(element);

      console.log('[MapView] Container cleaned, MapContainer should render now');
    } else {
      console.log('[MapView] Element is null - unmounting');
    }
  };

  // Also clean on unmount via useEffect
  useEffect(() => {
    return () => {
      if (containerRef.current) {
        cleanContainerElement(containerRef.current);
      }
    };
  }, [mapKey]); // Run on every key change

  // Use useEffect to catch initialization errors (must be after all other hooks)
  useEffect(() => {
    // Reset error when mapKey changes (new map attempt)
    if (mapError) {
      console.log('[MapView] Resetting map error for new map key:', mapKey);
      setMapError(null);
    }

    console.log('[MapView] Setting up map initialization check for key:', mapKey);
    console.log('[MapView] Container ref:', containerRef.current);
    console.log('[MapView] Map disabled?', isMapDisabled);

    // Give map time to initialize before checking
    const timer = setTimeout(() => {
      console.log('[MapView] Checking map initialization after timeout...');
      console.log('[MapView] Container ref exists?', !!containerRef.current);

      // Only check if we don't already have an error and map is not disabled
      if (isMapDisabled) {
        console.log('[MapView] Map is disabled, skipping check');
        return;
      }

      const mapElement = containerRef.current?.querySelector('.leaflet-container');
      console.log('[MapView] Leaflet container element found?', !!mapElement);
      console.log('[MapView] Container HTML:', containerRef.current?.innerHTML?.substring(0, 200));

      if (!mapElement) {
        // Map didn't initialize - but only set error if we haven't set one already
        setMapError((prevError) => {
          // Only set new error if we don't have one
          if (!prevError) {
            console.error('[MapView] Map failed to initialize - container element not found');
            console.error('[MapView] Container ref:', containerRef.current);
            console.error('[MapView] Container children:', containerRef.current?.children.length);
            return 'Map failed to initialize';
          }
          return prevError;
        });
      } else {
        console.log('[MapView] Map initialized successfully!');
      }
    }, 5000); // Give map 5 seconds to load (longer for slower connections)

    return () => {
      console.log('[MapView] Cleaning up map check timer');
      clearTimeout(timer);
    };
  }, [mapKey, isMapDisabled, sessionId, mapError]);

  // NOW we can do conditional returns - all hooks are called above
  // If map is disabled or failed to load, show fallback UI
  if (isMapDisabled || mapError) {
    return <FallbackUI />;
  }

  return (
    <div
      ref={containerCallbackRef}
      id={containerId}
      className="military-border w-full relative"
      key={`container-${mapKey}`}
      style={{
        height: '600px',
        minHeight: '600px',
        width: '100%',
        position: 'relative',
        zIndex: 0,
        display: 'block',
        visibility: 'visible',
      }}
    >
      <MapContainer
        key={mapKey}
        center={initialCenter}
        zoom={initialZoom}
        style={{
          height: '600px',
          width: '100%',
          position: 'relative',
          zIndex: 0,
          display: 'block',
        }}
        className="leaflet-container"
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
            loading: () => console.log('[TileLayer] Tiles loading...'),
            load: () => console.log('[TileLayer] Tiles loaded successfully'),
            tileerror: (error) => {
              console.error('[TileLayer] Tile error:', error);
              console.error('[TileLayer] Failed tile:', error.tile);
            },
          }}
        />

        <MapInitializer
          instanceId={instanceId}
          initialCenter={initialCenter}
          initialZoom={initialZoom}
          mapInstanceRef={mapInstanceRef}
        />

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
    </div>
  );
};
