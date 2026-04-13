import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MapContainer,
  TileLayer,
  useMap,
  Polygon,
  Polyline,
  CircleMarker,
  Tooltip,
} from 'react-leaflet';
import { Icon, Marker as LeafletMarker } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { IncidentMarker } from './IncidentMarker';
import { ResourceMarker } from './ResourceMarker';
import { ScenarioLocationMarker, type ScenarioLocationPin } from './ScenarioLocationMarker';
import { RoutePolyline, type RouteData } from './RoutePolyline';
import { WindIndicator, type WindData } from './WindIndicator';
import { BlastZoneOverlay } from './BlastZoneOverlay';
import { CrowdDensityOverlay, type CrowdArea } from './CrowdDensityOverlay';
import { AssetPalette, type DraggableAssetDef } from './AssetPalette';
import { PlacedAssetMarker, type PlacedAsset } from './PlacedAssetMarker';
import { MapDropHandler } from './MapDropHandler';
import { MapDrawHandler } from './MapDrawHandler';
import { HazardMarker, type HazardData } from './HazardMarker';
import { CasualtyPin, type CasualtyData } from './CasualtyPin';
import { CrowdPin, type CrowdData } from './CrowdPin';
import { EntryExitPin, type EntryExitData } from './EntryExitPin';
import { MapElementResponsePanel, type MapElementTarget } from './MapElementResponsePanel';
import { FloorSelector, type FloorPlan } from './FloorSelector';
import { FloorPlanOverlay } from './FloorPlanOverlay';
import { BuildingStudOverlay } from './BuildingStudOverlay';
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
  'last_known_adversary',
  'adversary_sighting',
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
  /** Scenario ID — needed for building stud overlay. */
  scenarioId?: string;
  incidents?: Incident[];
  resources?: Resource[];
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
  /** When true, pre-built incident zone polygons (hot/warm/cold) are hidden from the map. They remain in ground truth only. */
  hidePrebuiltZones?: boolean;
  /** Live session current_state — used to conditionally show/hide pins with visible_after_state_key. */
  currentState?: Record<string, unknown>;
  /** Draggable asset definitions for the player's team (Phase 3). */
  draggableAssets?: DraggableAssetDef[];
  /** Player's team name for placement ownership. */
  teamName?: string;
  /** Called when a new placement is created via draw/drop (for action recording). */
  onPlacementCreated?: (placement: {
    id: string;
    label: string;
    asset_type: string;
    geometry: Record<string, unknown>;
    properties: Record<string, unknown>;
  }) => void;
  /** Called when a placement's label/properties are updated after creation (e.g. zone classification). */
  onPlacementUpdated?: (
    placementId: string,
    label: string,
    properties: Record<string, unknown>,
  ) => void;
  /** True when actions are being recorded — shows a visual indicator. */
  isRecordingActions?: boolean;
  /** Action recording state for the AssetPalette. */
  actionRecording?: {
    active: boolean;
    incidentId?: string;
    incidentTitle?: string;
    actions: Array<{ placementId: string; label: string; assetType: string }>;
    crowdMoves?: Array<{ crowdId: string; label: string }>;
  } | null;
  /** Called when user clicks "Submit Actions" in the palette. */
  onSubmitActions?: (description: string) => void;
  /** Called when user clicks "Cancel Recording" in the palette. */
  onCancelRecording?: () => void;
  /** Called when user clicks "Record Actions" in the palette. */
  onStartRecording?: () => void;
  /** Called when a crowd pin is moved (for action recording). */
  onCrowdMoved?: (crowd: {
    id: string;
    label: string;
    fromLat: number;
    fromLng: number;
    toLat: number;
    toLng: number;
  }) => void;
  /** When true (trainer view), skip the exit-claiming gate and always show all operational pins. */
  bypassExitGate?: boolean;
  /** Scenario type for context-aware team response actions. */
  scenarioType?: string;
  /** Session start time (ISO string) for computing elapsed time in markers. */
  sessionStartTime?: string;
  /** Optional children rendered inside MapContainer (e.g. DemoMapAnimator). */
  children?: React.ReactNode;
  /** When true, clicking near a stud shows an inspect popup with its metadata. */
  inspectStuds?: boolean;
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
 * Re-centers the map when the effective center is computed from loaded locations
 * (used when the scenario has no center_lat/center_lng).
 */
const MapAutoCenter = ({ center, zoom }: { center: [number, number] | null; zoom: number }) => {
  const map = useMap();
  const hasCentered = useRef(false);
  useEffect(() => {
    if (!center || hasCentered.current) return;
    hasCentered.current = true;
    map.flyTo(center, zoom, { duration: 1.2 });
  }, [map, center, zoom]);
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
        map.fitBounds(bounds, { padding: [50, 50], maxZoom: 19 });
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
  scenarioId,
  incidents = [],
  resources = [],
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
  hidePrebuiltZones = false,
  currentState,
  draggableAssets = [],
  teamName,
  onPlacementCreated,
  onPlacementUpdated,
  isRecordingActions,
  actionRecording,
  onSubmitActions,
  onCancelRecording,
  onStartRecording,
  onCrowdMoved,
  bypassExitGate = false,
  scenarioType,
  sessionStartTime,
  children,
  inspectStuds = false,
}: MapViewProps) => {
  const mapDisabledByEnv = import.meta.env.VITE_DISABLE_MAP === 'true';
  const isMapDisabled = disabled || mapDisabledByEnv;

  const [scenarioLocations, setScenarioLocations] = useState<ScenarioLocationPin[]>([]);
  const [mapRevealedCategories, setMapRevealedCategories] = useState<string[]>([]);
  const [environmentalState, setEnvironmentalState] = useState<{
    routes?: RouteData[];
    areas?: CrowdArea[];
    wind?: WindData;
  } | null>(null);
  const [placedAssets, setPlacedAssets] = useState<PlacedAsset[]>([]);
  const optimisticIdsRef = useRef<Map<string, string>>(new Map());
  const newPlacementIdsRef = useRef<Set<string>>(new Set());
  const [hazards, setHazards] = useState<HazardData[]>([]);
  const [respondToElement, setRespondToElement] = useState<MapElementTarget | null>(null);
  const [casualties, setCasualties] = useState<CasualtyData[]>([]);
  const [crowds, setCrowds] = useState<CrowdData[]>([]);
  const [entryExitPins, setEntryExitPins] = useState<EntryExitData[]>([]);
  const [floorPlans, setFloorPlans] = useState<FloorPlan[]>([]);
  const [activeFloor, setActiveFloor] = useState('G');
  const [isContainerReady, setIsContainerReady] = useState(false);
  const [studRefreshKey, setStudRefreshKey] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containmentAlert, setContainmentAlert] = useState<{
    type: 'held' | 'breach';
    message: string;
    zone_label: string;
  } | null>(null);

  const openHazardPanel = useCallback((h: HazardData) => {
    const details: Array<{ label: string; value: string }> = [];
    for (const [k, v] of Object.entries(h.properties)) {
      if (v == null || v === '') continue;
      details.push({
        label: k.replace(/_/g, ' '),
        value: Array.isArray(v) ? v.join(', ') : String(v),
      });
    }
    if (h.fire_class) details.push({ label: 'Fire Class', value: h.fire_class });
    if (h.debris_type) details.push({ label: 'Debris Type', value: h.debris_type });
    setRespondToElement({
      elementType: 'hazard',
      elementId: h.id,
      title: h.hazard_type.replace(/_/g, ' '),
      subtitle: h.status,
      description: h.current_description || h.enriched_description || undefined,
      imageUrl: h.current_image_url || h.image_url,
      status: h.status,
      details,
    });
  }, []);

  const openCrowdPanel = useCallback((c: CrowdData) => {
    const conds = c.conditions as Record<string, unknown>;
    const details: Array<{ label: string; value: string }> = [];
    details.push({ label: 'Headcount', value: String(c.headcount) });
    if (conds.behavior) details.push({ label: 'Behavior', value: String(conds.behavior) });
    if (conds.movement_direction)
      details.push({ label: 'Movement', value: String(conds.movement_direction) });
    if (conds.bottleneck) details.push({ label: 'Bottleneck', value: 'Yes' });
    const mixedWounded = (conds.mixed_wounded as Array<Record<string, unknown>>) ?? [];
    if (mixedWounded.length > 0) {
      const count = mixedWounded.reduce((s, w) => s + ((w.count as number) ?? 0), 0);
      details.push({ label: 'Walking Wounded', value: String(count) });
    }
    setRespondToElement({
      elementType: 'crowd',
      elementId: c.id,
      title: `Crowd — ${c.headcount} people`,
      subtitle: String(conds.behavior ?? 'unknown'),
      description: (conds.visible_description as string) ?? undefined,
      status: c.status,
      details,
    });
  }, []);

  const openCasualtyPanel = useCallback((c: CasualtyData) => {
    const conds = c.conditions as Record<string, unknown>;
    const details: Array<{ label: string; value: string }> = [];
    if (conds.mobility)
      details.push({ label: 'Mobility', value: String(conds.mobility).replace(/_/g, ' ') });
    if (conds.consciousness)
      details.push({ label: 'Consciousness', value: String(conds.consciousness) });
    if (conds.breathing) details.push({ label: 'Breathing', value: String(conds.breathing) });
    if (conds.accessibility && conds.accessibility !== 'open')
      details.push({
        label: 'Access',
        value: String(conds.accessibility).replace(/_/g, ' '),
      });
    const injuries = (conds.injuries as Array<Record<string, unknown>>) ?? [];
    if (injuries.length > 0) {
      details.push({
        label: 'Injuries',
        value: injuries.map((i) => String(i.type ?? '').replace(/_/g, ' ')).join(', '),
      });
    }
    const playerTag =
      (conds.player_triage_color as string | undefined) ??
      ((c as unknown as Record<string, unknown>).player_triage_color as string | undefined);
    if (playerTag) {
      details.push({ label: 'Triage Tag', value: playerTag.toUpperCase() });
    }
    setRespondToElement({
      elementType: 'casualty',
      elementId: c.id,
      title: `Patient — ${c.casualty_type.replace(/_/g, ' ')}`,
      subtitle: c.status,
      description: (conds.visible_description as string) ?? undefined,
      status: c.status,
      details,
      lat: c.location_lat,
      lng: c.location_lng,
    });
  }, []);

  const isBombSquad = /bomb|eod|explosive/i.test(teamName ?? '');

  const openPlacedAssetPanel = useCallback((asset: PlacedAsset) => {
    const details: Array<{ label: string; value: string }> = [];
    details.push({ label: 'Owning Team', value: asset.team_name });
    details.push({ label: 'Asset Type', value: asset.asset_type.replace(/_/g, ' ') });
    if (asset.properties?.capacity != null) {
      details.push({
        label: 'Capacity',
        value: `${asset.properties.capacity} ${(asset.properties.capacity_unit as string) ?? 'units'}`,
      });
    }
    setRespondToElement({
      elementType: 'placed_asset',
      elementId: asset.id,
      title: asset.label,
      subtitle: asset.team_name,
      status: asset.status,
      details,
    });
  }, []);

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
                pin_category:
                  ((loc as Record<string, unknown>).pin_category as string | undefined) ??
                  (conds.pin_category as string | undefined),
                narrative_description: conds.narrative_description as string | undefined,
                label: loc.label,
                coordinates: loc.coordinates ?? {},
                conditions: conds,
                claimable_by: loc.claimable_by as string[] | undefined,
                claimed_by_team: (loc.claimed_by_team as string) ?? null,
                claimed_as: (loc.claimed_as as string) ?? null,
                claim_exclusivity: (loc.claim_exclusivity as string) ?? null,
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

  useEffect(() => {
    if (locationsRefreshTrigger > 0) {
      setStudRefreshKey((k) => k + 1);
    }
  }, [locationsRefreshTrigger]);

  // Compute effective map center from incident site pin when scenario has no center_lat/lng
  const effectiveCenter = useMemo(() => {
    if (
      !Array.isArray(initialCenter) ||
      Math.abs((initialCenter as number[])[0] - 1.3521) > 0.01 ||
      Math.abs((initialCenter as number[])[1] - 103.8198) > 0.01
    ) {
      return null;
    }
    const incidentPin = scenarioLocations.find(
      (loc) =>
        (loc.pin_category === 'incident_site' || loc.location_type === 'incident_site') &&
        typeof loc.coordinates?.lat === 'number',
    );
    const targetPin =
      incidentPin ??
      scenarioLocations.find(
        (loc) =>
          typeof loc.coordinates?.lat === 'number' && typeof loc.coordinates?.lng === 'number',
      );
    if (targetPin?.coordinates?.lat && targetPin?.coordinates?.lng) {
      return [targetPin.coordinates.lat, targetPin.coordinates.lng] as [number, number];
    }
    return null;
  }, [scenarioLocations, initialCenter]);

  // Extract entry/exit pins from scenario locations
  useEffect(() => {
    const eeLocations = scenarioLocations
      .filter(
        (sl) =>
          sl.pin_category === 'entry_exit' &&
          typeof sl.coordinates?.lat === 'number' &&
          typeof sl.coordinates?.lng === 'number',
      )
      .map((sl) => ({
        id: sl.id,
        label: sl.label,
        location_type: sl.location_type,
        coordinates: sl.coordinates as { lat: number; lng: number },
        conditions: (sl.conditions ?? {}) as Record<string, unknown>,
        claimable_by: (sl.claimable_by as string[] | undefined) ??
          ((sl.conditions as Record<string, unknown>)?.claimable_by as string[]) ?? ['all'],
        claimed_by_team:
          (sl.claimed_by_team as string | null) ??
          ((sl.conditions as Record<string, unknown>)?.claimed_by_team as string | null) ??
          null,
        claimed_as:
          (sl.claimed_as as string | null) ??
          ((sl.conditions as Record<string, unknown>)?.claimed_as as string | null) ??
          null,
        claim_exclusivity:
          (sl.claim_exclusivity as string | null) ??
          ((sl.conditions as Record<string, unknown>)?.claim_exclusivity as string | null) ??
          null,
      }));
    setEntryExitPins(eeLocations);
  }, [scenarioLocations]);

  const allExitsClaimed =
    bypassExitGate || (entryExitPins.length > 0 && entryExitPins.every((p) => !!p.claimed_by_team));
  const exitClaimProgress = {
    claimed: entryExitPins.filter((p) => !!p.claimed_by_team).length,
    total: entryExitPins.length,
  };

  // Listen for state updates: evacuation zones, environmental_state, placements, location claims
  useWebSocket({
    sessionId,
    eventTypes: [
      'state.updated',
      'placement.created',
      'placement.updated',
      'placement.removed',
      'location.claimed',
      'casualty.moved',
      'casualty.updated',
      'casualty.created',
      'adversary_sighting_update',
      'adversary_sighting_new',
      'sighting_stale',
      'sighting_debunked',
      'adversary_location_cleared',
      'adversary_casualties_spawned',
      'containment_held',
      'containment_breach',
    ],
    onEvent: (event: WebSocketEvent) => {
      if (event.type === 'state.updated') {
        const state = (event.data as { state?: Record<string, unknown> })?.state;
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
          const confirmedRealIds = new Set(optimisticIdsRef.current.values());
          if (confirmedRealIds.has(placement.id)) return;

          newPlacementIdsRef.current.add(placement.id);
          setTimeout(() => newPlacementIdsRef.current.delete(placement.id), 3000);

          setPlacedAssets((prev) => {
            if (prev.some((p) => p.id === placement.id)) return prev;
            return [...prev, placement];
          });
          setStudRefreshKey((k) => k + 1);
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
          setStudRefreshKey((k) => k + 1);
        }
      }
      if (event.type === 'location.claimed') {
        const { location } = event.data as { location: Record<string, unknown> };
        if (location?.id) {
          setEntryExitPins((prev) =>
            prev.map((p) =>
              p.id === location.id
                ? {
                    ...p,
                    claimed_by_team: (location.claimed_by_team as string) ?? null,
                    claimed_as: (location.claimed_as as string) ?? null,
                    claim_exclusivity: (location.claim_exclusivity as string) ?? null,
                  }
                : p,
            ),
          );
        }
      }
      if (event.type === 'casualty.moved' || event.type === 'casualty.updated') {
        const d = event.data as {
          casualty_id?: string;
          lat?: number;
          lng?: number;
          status?: string;
          arrived?: boolean;
        };
        if (d.casualty_id) {
          setCasualties((prev) =>
            prev.map((c) =>
              c.id === d.casualty_id
                ? {
                    ...c,
                    ...(d.lat != null && d.lng != null
                      ? { location_lat: d.lat, location_lng: d.lng }
                      : {}),
                    ...(d.status ? { status: d.status } : {}),
                  }
                : c,
            ),
          );
          setCrowds((prev) =>
            prev.map((c) =>
              c.id === d.casualty_id
                ? {
                    ...c,
                    ...(d.lat != null && d.lng != null
                      ? { location_lat: d.lat, location_lng: d.lng }
                      : {}),
                    ...(d.status ? { status: d.status } : {}),
                    ...(d.arrived === true && typeof (c as CrowdData).headcount === 'number'
                      ? {}
                      : {}),
                  }
                : c,
            ),
          );
        }
      }
      if (event.type === 'casualty.created') {
        const d = event.data as { casualty_id?: string };
        if (d.casualty_id && sessionId) {
          api.casualties
            .list(sessionId)
            .then((res) => {
              if (Array.isArray(res.data)) {
                setCasualties(
                  (res.data as CasualtyData[]).filter((c) => c.casualty_type === 'patient'),
                );
                setCrowds(
                  (res.data as CrowdData[]).filter(
                    (c) =>
                      c.casualty_type === 'crowd' ||
                      c.casualty_type === 'evacuee_group' ||
                      c.casualty_type === 'convergent_crowd',
                  ),
                );
              }
            })
            .catch(() => {});
        }
      }
      if (event.type === 'adversary_sighting_update') {
        const d = event.data as {
          pin_id?: string;
          coordinates?: { lat: number; lng: number };
          zone_label?: string;
          description?: string;
          last_seen_at_minutes?: number;
          intel_source?: string;
          confidence?: string;
          accuracy_radius_m?: number;
          direction_of_travel?: string | null;
          tests_containment?: boolean;
          sighting_history?: Array<{
            lat: number;
            lng: number;
            zone_label: string;
            seen_at_minutes: number;
            intel_source: string;
            confidence: string;
          }>;
        };
        if (d.pin_id && d.coordinates) {
          setScenarioLocations((prev) =>
            prev.map((loc) =>
              loc.id === d.pin_id
                ? {
                    ...loc,
                    coordinates: d.coordinates!,
                    label: `Last Seen: ${d.zone_label || 'Unknown'}`,
                    conditions: {
                      ...(loc.conditions ?? {}),
                      zone_label: d.zone_label,
                      last_seen_at_minutes: d.last_seen_at_minutes,
                      last_seen_description: d.description,
                      intel_source: d.intel_source,
                      confidence: d.confidence,
                      accuracy_radius_m: d.accuracy_radius_m,
                      direction_of_travel: d.direction_of_travel,
                      tests_containment: d.tests_containment,
                      sighting_history: d.sighting_history,
                    },
                  }
                : loc,
            ),
          );
        }
      }
      if (event.type === 'adversary_sighting_new') {
        const d = event.data as {
          pin_id?: string;
          adversary_id?: string;
          coordinates?: { lat: number; lng: number };
          zone_label?: string;
          description?: string;
          last_seen_at_minutes?: number;
          intel_source?: string;
          confidence?: string;
          accuracy_radius_m?: number;
          direction_of_travel?: string | null;
          tests_containment?: boolean;
          sighting_order?: number;
          nato_grade?: string;
          sighting_status?: string;
        };
        if (d.pin_id && d.coordinates) {
          setScenarioLocations((prev) => {
            if (prev.some((loc) => loc.id === d.pin_id)) return prev;
            return [
              ...prev,
              {
                id: d.pin_id!,
                location_type: 'adversary_sighting',
                pin_category: 'adversary_sighting',
                label: `Sighting #${(d.sighting_order ?? 0) + 1}: ${d.zone_label || 'Unknown'}`,
                coordinates: d.coordinates!,
                conditions: {
                  adversary_id: d.adversary_id,
                  pin_category: 'adversary_sighting',
                  sighting_status: d.sighting_status || 'active',
                  sighting_order: d.sighting_order,
                  zone_label: d.zone_label,
                  last_seen_at_minutes: d.last_seen_at_minutes,
                  last_seen_description: d.description,
                  intel_source: d.intel_source,
                  confidence: d.confidence,
                  accuracy_radius_m: d.accuracy_radius_m,
                  direction_of_travel: d.direction_of_travel,
                  tests_containment: d.tests_containment,
                  nato_grade: d.nato_grade,
                },
              },
            ];
          });
        }
      }
      if (event.type === 'sighting_stale') {
        const d = event.data as { pin_ids?: string[] };
        if (d.pin_ids?.length) {
          const staleSet = new Set(d.pin_ids);
          setScenarioLocations((prev) =>
            prev.map((loc) => {
              if (!staleSet.has(loc.id)) return loc;
              // Don't mark hidden pins as stale — they haven't appeared yet
              const curStatus = (loc.conditions as Record<string, unknown>)?.sighting_status;
              if (curStatus === 'hidden') return loc;
              return {
                ...loc,
                conditions: { ...(loc.conditions ?? {}), sighting_status: 'stale' },
              };
            }),
          );
        }
      }
      if (event.type === 'sighting_debunked') {
        const d = event.data as { pin_id?: string; debunked_at_minutes?: number };
        if (d.pin_id) {
          setScenarioLocations((prev) =>
            prev.map((loc) =>
              loc.id === d.pin_id
                ? {
                    ...loc,
                    conditions: {
                      ...(loc.conditions ?? {}),
                      sighting_status: 'debunked',
                      debunked_at_minutes: d.debunked_at_minutes,
                    },
                  }
                : loc,
            ),
          );
        }
      }
      if (event.type === 'adversary_location_cleared') {
        const d = event.data as {
          adversary_id?: string;
          cleared_zone_label?: string;
          new_zone_label?: string;
          message?: string;
        };
        setContainmentAlert({
          type: 'held',
          message:
            d.message || `Suspect no longer at ${d.cleared_zone_label || 'previous location'}.`,
          zone_label: d.cleared_zone_label || 'Unknown',
        });
        setTimeout(() => setContainmentAlert(null), 10000);
      }
      if (event.type === 'adversary_casualties_spawned' && sessionId) {
        api.casualties
          .list(sessionId)
          .then((res) => {
            if (Array.isArray(res.data)) {
              setCasualties(
                (res.data as CasualtyData[]).filter((c) => c.casualty_type === 'patient'),
              );
            }
          })
          .catch(() => {});
      }
      if (event.type === 'containment_held' || event.type === 'containment_breach') {
        const d = event.data as { result?: string; message?: string; zone_label?: string };
        setContainmentAlert({
          type: event.type === 'containment_held' ? 'held' : 'breach',
          message:
            d.message ||
            (event.type === 'containment_held' ? 'Perimeter holding.' : 'Containment breached!'),
          zone_label: d.zone_label || 'Unknown',
        });
        setTimeout(() => setContainmentAlert(null), 12000);
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
          setPlacedAssets(res.data as unknown as PlacedAsset[]);
        }
      })
      .catch(() => {
        /* ignore */
      });
    api.hazards
      .list(sessionId, { includeZones: showAllPins })
      .then((res) => {
        if (cancelled) return;
        if (Array.isArray(res.data)) {
          setHazards(res.data as HazardData[]);
        }
      })
      .catch(() => {
        /* ignore */
      });
    api.casualties
      .list(sessionId)
      .then((res) => {
        if (cancelled) return;
        if (Array.isArray(res.data)) {
          const patients = (res.data as CasualtyData[]).filter(
            (c) => c.casualty_type === 'patient',
          );
          const crowdItems = (res.data as CrowdData[]).filter(
            (c) =>
              c.casualty_type === 'crowd' ||
              c.casualty_type === 'evacuee_group' ||
              c.casualty_type === 'convergent_crowd',
          );
          setCasualties(patients);
          setCrowds(crowdItems);
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

  // Periodically refresh hazards, casualties, and placements (safety net for missed WS events)
  useEffect(() => {
    if (!sessionId || isMapDisabled) return;
    const interval = setInterval(() => {
      api.hazards
        .list(sessionId, { includeZones: showAllPins })
        .then((res) => {
          if (Array.isArray(res.data)) {
            setHazards(res.data as HazardData[]);
          }
        })
        .catch(() => {
          /* ignore */
        });
      api.casualties
        .list(sessionId)
        .then((res) => {
          if (Array.isArray(res.data)) {
            const patients = (res.data as CasualtyData[]).filter(
              (c) => c.casualty_type === 'patient',
            );
            const crowdItems = (res.data as CrowdData[]).filter(
              (c) =>
                c.casualty_type === 'crowd' ||
                c.casualty_type === 'evacuee_group' ||
                c.casualty_type === 'convergent_crowd',
            );
            setCasualties(patients);
            setCrowds(crowdItems);
          }
        })
        .catch(() => {
          /* ignore */
        });
      api.placements
        .list(sessionId)
        .then((res) => {
          if (Array.isArray(res.data)) {
            setPlacedAssets(res.data as unknown as PlacedAsset[]);
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
  // Zone locations rendered as polygons, not as pin markers
  const zoneLocationPins = scenarioLocationsWithCoords.filter(
    (loc) => loc.pin_category === 'incident_zone' || loc.location_type === 'incident_zone',
  );

  const scenarioLocationsForMap = scenarioLocationsWithCoords.filter((loc) => {
    if (loc.pin_category === 'incident_zone' || loc.location_type === 'incident_zone') return false;
    // Sighting pins that haven't been revealed yet must be completely invisible.
    // 'hidden' = pre-created, not yet triggered. Also filter any sighting pin without 'active' status
    // that was incorrectly marked 'stale' before its inject fired.
    const sightingStatus = loc.conditions?.sighting_status as string | undefined;
    const isSightingPin =
      loc.pin_category === 'adversary_sighting' || loc.location_type === 'adversary_sighting';
    if (isSightingPin && sightingStatus === 'hidden') return false;
    // Entry/exit pins are rendered separately via EntryExitPin component
    if (loc.pin_category === 'entry_exit') return false;

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

  const handleOptimisticPlace = useCallback((asset: PlacedAsset) => {
    optimisticIdsRef.current.set(asset.id, '');
    setPlacedAssets((prev) => [...prev, asset]);
  }, []);

  const handleOptimisticConfirm = useCallback((tempId: string, realAsset: PlacedAsset) => {
    optimisticIdsRef.current.set(tempId, realAsset.id);
    setPlacedAssets((prev) => prev.map((p) => (p.id === tempId ? realAsset : p)));
    setTimeout(() => optimisticIdsRef.current.delete(tempId), 10000);
  }, []);

  const handleOptimisticRevert = useCallback((tempId: string) => {
    optimisticIdsRef.current.delete(tempId);
    setPlacedAssets((prev) => prev.filter((p) => p.id !== tempId));
  }, []);

  const handlePlacementDragEnd = useCallback(
    (assetId: string, newLat: number, newLng: number) => {
      const newGeom = { type: 'Point' as const, coordinates: [newLng, newLat] };
      setPlacedAssets((prev) =>
        prev.map((p) => (p.id === assetId ? { ...p, geometry: newGeom } : p)),
      );
      api.placements.update(sessionId, assetId, { geometry: newGeom }).catch(() => {
        api.placements.list(sessionId).then((res) => {
          if (Array.isArray(res.data)) {
            setPlacedAssets(res.data as unknown as PlacedAsset[]);
          }
        });
      });
    },
    [sessionId],
  );

  const handleGeometryDragEnd = useCallback(
    (assetId: string, newGeometry: { type: string; coordinates: unknown }) => {
      setPlacedAssets((prev) =>
        prev.map((p) => (p.id === assetId ? { ...p, geometry: newGeometry } : p)),
      );
      api.placements.update(sessionId, assetId, { geometry: newGeometry }).catch(() => {
        api.placements.list(sessionId).then((res) => {
          if (Array.isArray(res.data)) {
            setPlacedAssets(res.data as unknown as PlacedAsset[]);
          }
        });
      });
    },
    [sessionId],
  );

  const [drawingAsset, setDrawingAsset] = useState<DraggableAssetDef | null>(null);
  const [drawVertexCount, setDrawVertexCount] = useState(0);
  const [drawFinishSignal, setDrawFinishSignal] = useState(0);

  // Zone classification dialog — shown after a hazard_zone polygon is placed
  const [zoneClassifyTarget, setZoneClassifyTarget] = useState<{
    placementId: string;
    sessionId: string;
    existingProps: Record<string, unknown>;
  } | null>(null);

  const handlePlacementCreatedWithZoneCheck = useCallback(
    (placement: {
      id: string;
      label: string;
      asset_type: string;
      geometry: Record<string, unknown>;
      properties: Record<string, unknown>;
    }) => {
      onPlacementCreated?.(placement);
      if (placement.asset_type === 'hazard_zone') {
        setZoneClassifyTarget({
          placementId: placement.id,
          sessionId,
          existingProps: placement.properties,
        });
      }
    },
    [onPlacementCreated, sessionId],
  );

  const handleZoneClassify = useCallback(
    async (classification: 'hot' | 'warm' | 'cold') => {
      if (!zoneClassifyTarget) return;
      const newLabel = `${classification.charAt(0).toUpperCase() + classification.slice(1)} Zone`;
      const newProps = {
        ...zoneClassifyTarget.existingProps,
        zone_classification: classification,
      };
      try {
        await api.placements.update(zoneClassifyTarget.sessionId, zoneClassifyTarget.placementId, {
          properties: newProps,
          label: newLabel,
        });
        onPlacementUpdated?.(zoneClassifyTarget.placementId, newLabel, newProps);
      } catch (err) {
        console.error('Failed to classify zone:', err);
      }
      setZoneClassifyTarget(null);
    },
    [zoneClassifyTarget, onPlacementUpdated],
  );

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

  // Compute which crowd pins are near marshals (client-side proximity check)
  const crowdDraggability = useMemo(() => {
    const result = new Map<string, boolean>();
    const MARSHAL_RANGE_DEG = 0.001; // ~100m at equator

    const marshalAssets = placedAssets.filter((a) => {
      const t = a.asset_type.toLowerCase();
      return t.includes('marshal') || t.includes('steward') || t.includes('police');
    });

    for (const crowd of crowds) {
      let hasMarshal = false;
      for (const m of marshalAssets) {
        const geom = m.geometry as Record<string, unknown>;
        if (!geom) continue;
        let mLat = 0,
          mLng = 0;
        if ((geom.type as string) === 'Point') {
          const coords = geom.coordinates as number[];
          mLat = coords[1];
          mLng = coords[0];
        } else if ((geom.type as string) === 'Polygon') {
          const coords = ((geom.coordinates as number[][][]) ?? [[]])[0];
          for (const c of coords) {
            mLat += c[1];
            mLng += c[0];
          }
          mLat /= coords.length || 1;
          mLng /= coords.length || 1;
        } else continue;

        if (
          Math.abs(crowd.location_lat - mLat) <= MARSHAL_RANGE_DEG &&
          Math.abs(crowd.location_lng - mLng) <= MARSHAL_RANGE_DEG
        ) {
          hasMarshal = true;
          break;
        }
      }
      result.set(crowd.id, hasMarshal);
    }
    return result;
  }, [crowds, placedAssets]);

  if (isMapDisabled) {
    return <FallbackUI />;
  }

  // When fillHeight, stretch to fill the parent container; standalone uses a sensible default.
  const mapHeight = fillHeight ? '100%' : '600px';

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
          className={`leaflet-container${drawingAsset ? ' drawing-mode-active' : ''}`}
          scrollWheelZoom={true}
          doubleClickZoom={true}
          zoomControl={true}
          maxZoom={22}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            subdomains={['a', 'b', 'c']}
            noWrap={false}
            updateWhenZooming={true}
            updateWhenIdle={true}
            maxNativeZoom={19}
            maxZoom={22}
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
          <MapAutoCenter center={effectiveCenter} zoom={initialZoom ?? 16} />
          <MapCleanup />

          {/* Drop handler for drag-and-drop asset placement (disabled while drawing or not recording) */}
          {teamName && !drawingAsset && isRecordingActions && (
            <MapDropHandler
              sessionId={sessionId}
              teamName={teamName}
              enabled={draggableAssets.length > 0 && !disabled}
              placedAssets={placedAssets}
              onPlacementCreated={handlePlacementCreatedWithZoneCheck}
              onOptimisticPlace={handleOptimisticPlace}
              onOptimisticConfirm={handleOptimisticConfirm}
              onOptimisticRevert={handleOptimisticRevert}
            />
          )}

          {/* Drawing handler for line/polygon assets (only when recording) */}
          {teamName && drawingAsset && isRecordingActions && (
            <MapDrawHandler
              sessionId={sessionId}
              teamName={teamName}
              drawingAsset={drawingAsset}
              placedAssets={placedAssets}
              onFinish={() => {
                setDrawingAsset(null);
                setDrawVertexCount(0);
              }}
              onCancel={() => {
                setDrawingAsset(null);
                setDrawVertexCount(0);
              }}
              finishSignal={drawFinishSignal}
              onVertexCountChange={setDrawVertexCount}
              onPlacementCreated={handlePlacementCreatedWithZoneCheck}
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

          {/* Building Stud Overlay — snap-point grid inside buildings */}
          {scenarioId && (
            <BuildingStudOverlay
              scenarioId={scenarioId}
              sessionId={sessionId}
              floor={activeFloor}
              refreshKey={studRefreshKey}
              inspectable={inspectStuds}
            />
          )}

          {/* Crowd Density Overlay */}
          {Array.isArray(environmentalState?.areas) && environmentalState.areas.length > 0 && (
            <CrowdDensityOverlay areas={environmentalState.areas} />
          )}

          {/* Wind Direction Indicator */}
          {environmentalState?.wind && <WindIndicator wind={environmentalState.wind} />}

          {/* Adversary sighting breadcrumb trails */}
          {(() => {
            const sightingPins = scenarioLocationsForMap
              .filter((loc) => {
                const cat = loc.pin_category?.toLowerCase() ?? '';
                const condCat = ((loc.conditions?.pin_category as string) ?? '').toLowerCase();
                return (
                  cat === 'adversary_sighting' ||
                  condCat === 'adversary_sighting' ||
                  cat === 'last_known_adversary' ||
                  condCat === 'last_known_adversary'
                );
              })
              .sort(
                (a, b) =>
                  ((a.conditions?.sighting_order as number) ?? 0) -
                  ((b.conditions?.sighting_order as number) ?? 0),
              );

            const byAdversary = new Map<string, typeof sightingPins>();
            for (const pin of sightingPins) {
              const advId = (pin.conditions?.adversary_id as string) || 'adversary_1';
              if (!byAdversary.has(advId)) byAdversary.set(advId, []);
              byAdversary.get(advId)!.push(pin);
            }

            return Array.from(byAdversary.entries()).map(([advId, pins]) => {
              if (pins.length < 2) return null;
              const positions = pins
                .filter((p) => p.coordinates.lat != null && p.coordinates.lng != null)
                .map((p) => [p.coordinates.lat!, p.coordinates.lng!] as [number, number]);
              if (positions.length < 2) return null;
              return (
                <Polyline
                  key={`trail-${advId}`}
                  positions={positions}
                  pathOptions={{
                    color: '#f97316',
                    weight: 2,
                    opacity: 0.4,
                    dashArray: '8 6',
                  }}
                />
              );
            });
          })()}

          {/* Scenario location pins (Step 6: labels only; cordon hidden so teams decide) */}
          {scenarioLocationsForMap.map((loc) => (
            <ScenarioLocationMarker
              key={loc.id}
              location={loc}
              position={[loc.coordinates.lat!, loc.coordinates.lng!] as LatLngExpression}
              sessionElapsedMinutes={
                sessionStartTime
                  ? Math.max(0, (Date.now() - new Date(sessionStartTime).getTime()) / 60000)
                  : undefined
              }
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
                isDraggable={!!teamName && asset.team_name === teamName && !!isRecordingActions}
                drawingActive={!!drawingAsset}
                isNew={newPlacementIdsRef.current.has(asset.id)}
                onInteract={
                  isBombSquad && asset.team_name !== teamName ? openPlacedAssetPanel : undefined
                }
                onRemove={
                  teamName && asset.team_name === teamName ? handleRemovePlacement : undefined
                }
                onDragEnd={handlePlacementDragEnd}
                onGeometryDragEnd={handleGeometryDragEnd}
              />
            ))}

          {/* Floor Plan Overlay (Phase 5) */}
          {floorPlans
            .filter((f) => f.floor_level === activeFloor)
            .map((floor) => (
              <FloorPlanOverlay key={floor.id} floor={floor} />
            ))}

          {/* Zone polygons from independent zone locations (new format) or hazard zones (legacy) */}
          {showAllPins && !hidePrebuiltZones && zoneLocationPins.length > 0
            ? [...zoneLocationPins]
                .sort((a, b) => {
                  const rA = Number((a.conditions as Record<string, unknown>)?.radius_m) || 0;
                  const rB = Number((b.conditions as Record<string, unknown>)?.radius_m) || 0;
                  return rB - rA;
                })
                .map((zl) => {
                  const conds = (zl.conditions ?? {}) as Record<string, unknown>;
                  const zoneType = (conds.zone_type as string) || 'unknown';
                  const polygon = conds.polygon as number[][] | undefined;
                  if (!polygon || polygon.length < 3) return null;
                  const ZONE_COLORS: Record<string, { color: string; fillColor: string }> = {
                    hot: { color: '#dc2626', fillColor: '#dc262640' },
                    warm: { color: '#f59e0b', fillColor: '#f59e0b30' },
                    cold: { color: '#3b82f6', fillColor: '#3b82f620' },
                  };
                  const style = ZONE_COLORS[zoneType] ?? {
                    color: '#6b7280',
                    fillColor: '#6b728020',
                  };
                  const positions = polygon.map((p) => [p[0], p[1]] as [number, number]);
                  const radiusM = Number(conds.radius_m) || 0;
                  return (
                    <span key={`zl-${zl.id}`}>
                      <Polygon
                        positions={positions}
                        pathOptions={{
                          color: style.color,
                          fillColor: style.fillColor,
                          fillOpacity: 0.3,
                          weight: 2,
                          dashArray: '6 4',
                        }}
                      >
                        <Tooltip direction="center" permanent={false}>
                          {zoneType.toUpperCase()} ZONE{radiusM ? ` (${radiusM}m)` : ''}
                        </Tooltip>
                      </Polygon>
                      <CircleMarker
                        center={
                          [zl.coordinates?.lat ?? 0, zl.coordinates?.lng ?? 0] as LatLngExpression
                        }
                        radius={5}
                        pathOptions={{
                          color: style.color,
                          fillColor: style.color,
                          fillOpacity: 0.9,
                          weight: 1,
                        }}
                      >
                        <Tooltip direction="top" offset={[0, -6]} permanent>
                          <span
                            style={{
                              fontSize: 9,
                              fontWeight: 700,
                              letterSpacing: 0.5,
                              textTransform: 'uppercase',
                            }}
                          >
                            {zoneType} zone
                          </span>
                        </Tooltip>
                      </CircleMarker>
                    </span>
                  );
                })
            : showAllPins &&
              !hidePrebuiltZones &&
              hazards
                .filter((h) => h.floor_level === activeFloor || !floorPlans.length)
                .flatMap((hazard) =>
                  [...(hazard.zones ?? [])]
                    .filter((z) => z.polygon && z.polygon.length >= 3)
                    .sort((a, b) => b.radius_m - a.radius_m)
                    .map((zone) => {
                      const ZONE_COLORS: Record<string, { color: string; fillColor: string }> = {
                        hot: { color: '#dc2626', fillColor: '#dc262640' },
                        warm: { color: '#f59e0b', fillColor: '#f59e0b30' },
                        cold: { color: '#3b82f6', fillColor: '#3b82f620' },
                      };
                      const style = ZONE_COLORS[zone.zone_type] ?? {
                        color: '#6b7280',
                        fillColor: '#6b728020',
                      };
                      const positions = zone.polygon!.map((p) => [p[0], p[1]] as [number, number]);
                      return (
                        <Polygon
                          key={`zone-${hazard.id}-${zone.zone_type}`}
                          positions={positions}
                          pathOptions={{
                            color: style.color,
                            fillColor: style.fillColor,
                            fillOpacity: 0.3,
                            weight: 2,
                            dashArray: '6 4',
                          }}
                        />
                      );
                    }),
                )}

          {/* Hazard Markers — gated behind exit claiming, filtered by active floor */}
          {allExitsClaimed &&
            hazards
              .filter((h) => h.floor_level === activeFloor || !floorPlans.length)
              .map((hazard) => (
                <HazardMarker key={hazard.id} hazard={hazard} onClick={openHazardPanel} />
              ))}

          {/* Casualty Pins (individual patients) — gated behind exit claiming */}
          {allExitsClaimed &&
            casualties
              .filter((c) => c.floor_level === activeFloor || !floorPlans.length)
              .map((casualty) => (
                <CasualtyPin key={casualty.id} casualty={casualty} onClick={openCasualtyPanel} />
              ))}

          {/* Crowd Pins (civilian groups) — gated behind exit claiming */}
          {allExitsClaimed &&
            crowds
              .filter((c) => c.floor_level === activeFloor || !floorPlans.length)
              .map((crowd) => (
                <CrowdPin
                  key={crowd.id}
                  crowd={crowd}
                  isDraggable={(crowdDraggability.get(crowd.id) ?? false) && !!isRecordingActions}
                  onClick={openCrowdPanel}
                  onDragEnd={async (c, newLat, newLng) => {
                    const oldLat = c.location_lat;
                    const oldLng = c.location_lng;
                    setCrowds((prev) =>
                      prev.map((cr) =>
                        cr.id === c.id ? { ...cr, location_lat: newLat, location_lng: newLng } : cr,
                      ),
                    );
                    try {
                      await api.casualties.update(sessionId, c.id, {
                        location_lat: newLat,
                        location_lng: newLng,
                      });
                      onCrowdMoved?.({
                        id: c.id,
                        label: `Crowd (${c.headcount} people)`,
                        fromLat: oldLat,
                        fromLng: oldLng,
                        toLat: newLat,
                        toLng: newLng,
                      });
                    } catch {
                      setCrowds((prev) =>
                        prev.map((cr) =>
                          cr.id === c.id
                            ? { ...cr, location_lat: oldLat, location_lng: oldLng }
                            : cr,
                        ),
                      );
                    }
                  }}
                />
              ))}

          {/* Entry/Exit Pins */}
          {entryExitPins.map((loc) => (
            <EntryExitPin
              key={loc.id}
              location={loc}
              currentTeam={teamName ?? ''}
              teamNames={[]}
              onClaim={async (locationId, tn, claimedAs, claimExclusivity) => {
                try {
                  await api.locations.claim(sessionId, locationId, tn, claimedAs, claimExclusivity);
                  setEntryExitPins((prev) =>
                    prev.map((p) =>
                      p.id === locationId
                        ? {
                            ...p,
                            claimed_by_team: tn,
                            claimed_as: claimedAs,
                            claim_exclusivity: claimExclusivity,
                          }
                        : p,
                    ),
                  );
                } catch (err: unknown) {
                  const msg = err instanceof Error ? err.message : 'Failed to claim this point';
                  if (msg.toLowerCase().includes('already claimed')) {
                    const refreshed = await api.sessions.getLocations(sessionId);
                    const locs = (refreshed?.data ?? []) as Array<Record<string, unknown>>;
                    const found = locs.find((l) => l.id === locationId) as
                      | Record<string, unknown>
                      | undefined;
                    if (found?.claimed_by_team) {
                      setEntryExitPins((prev) =>
                        prev.map((p) =>
                          p.id === locationId
                            ? {
                                ...p,
                                claimed_by_team: found.claimed_by_team as string,
                                claimed_as: (found.claimed_as as string) ?? null,
                              }
                            : p,
                        ),
                      );
                    }
                  }
                  alert(msg);
                }
              }}
            />
          ))}
          {children}
        </MapContainer>
      )}

      {containmentAlert && (
        <div
          className={`absolute top-3 left-1/2 -translate-x-1/2 z-[1500] px-4 py-2.5 rounded-lg border backdrop-blur-sm shadow-xl font-mono text-xs max-w-[90%] text-center animate-pulse ${
            containmentAlert.type === 'held'
              ? 'bg-green-900/80 border-green-500/60 text-green-200'
              : 'bg-red-900/80 border-red-500/60 text-red-200'
          }`}
        >
          <div className="font-bold text-sm mb-0.5">
            {containmentAlert.type === 'held' ? '🛡 PERIMETER HOLDING' : '🚨 CONTAINMENT BREACH'}
          </div>
          <div>{containmentAlert.message}</div>
        </div>
      )}

      {/* Zone classification dialog — appears after drawing a hazard_zone polygon */}
      {zoneClassifyTarget && (
        <div
          className="absolute inset-0 z-[2000] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.5)' }}
        >
          <div
            className="rounded-lg border p-5 shadow-2xl"
            style={{
              background: 'rgba(15,23,42,0.97)',
              borderColor: 'rgba(148,163,184,0.3)',
              minWidth: 300,
            }}
          >
            <div className="text-sm font-mono text-gray-200 mb-1 uppercase tracking-wide text-center">
              Classify This Zone
            </div>
            <div className="text-[11px] font-mono text-gray-400 text-center mb-4">
              What type of hazard zone is this area?
            </div>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => handleZoneClassify('hot')}
                className="flex items-center gap-3 px-4 py-2.5 rounded border text-left transition-colors hover:brightness-125"
                style={{
                  background: 'rgba(220,38,38,0.15)',
                  borderColor: 'rgba(220,38,38,0.5)',
                }}
              >
                <span
                  className="w-4 h-4 rounded-full flex-shrink-0"
                  style={{ background: '#dc2626' }}
                />
                <div>
                  <div className="text-xs font-mono font-bold text-red-300">HOT ZONE</div>
                  <div className="text-[10px] font-mono text-red-400/70">
                    Immediate danger — specialist access only
                  </div>
                </div>
              </button>
              <button
                onClick={() => handleZoneClassify('warm')}
                className="flex items-center gap-3 px-4 py-2.5 rounded border text-left transition-colors hover:brightness-125"
                style={{
                  background: 'rgba(245,158,11,0.15)',
                  borderColor: 'rgba(245,158,11,0.5)',
                }}
              >
                <span
                  className="w-4 h-4 rounded-full flex-shrink-0"
                  style={{ background: '#f59e0b' }}
                />
                <div>
                  <div className="text-xs font-mono font-bold text-amber-300">WARM ZONE</div>
                  <div className="text-[10px] font-mono text-amber-400/70">
                    Transition area — triage, decon, stabilization
                  </div>
                </div>
              </button>
              <button
                onClick={() => handleZoneClassify('cold')}
                className="flex items-center gap-3 px-4 py-2.5 rounded border text-left transition-colors hover:brightness-125"
                style={{
                  background: 'rgba(34,197,94,0.15)',
                  borderColor: 'rgba(34,197,94,0.5)',
                }}
              >
                <span
                  className="w-4 h-4 rounded-full flex-shrink-0"
                  style={{ background: '#22c55e' }}
                />
                <div>
                  <div className="text-xs font-mono font-bold text-green-300">COLD ZONE</div>
                  <div className="text-[10px] font-mono text-green-400/70">
                    Safe area — treatment, staging, command
                  </div>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Exit claiming progress banner */}
      {!allExitsClaimed && entryExitPins.length > 0 && (
        <div
          className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] px-4 py-2 rounded border"
          style={{
            background: 'rgba(0,0,0,0.9)',
            borderColor: 'rgba(245,158,11,0.6)',
            maxWidth: '380px',
          }}
        >
          <div className="text-xs font-mono text-amber-300 text-center mb-1 uppercase tracking-wide">
            Plan Your Pathways
          </div>
          <div className="text-[10px] font-mono text-gray-400 text-center mb-2">
            Claim all entry/exit points before responding to incidents
          </div>
          <div className="w-full bg-gray-700 rounded-full h-2 mb-1">
            <div
              className="bg-amber-500 h-2 rounded-full transition-all duration-500"
              style={{
                width: `${exitClaimProgress.total > 0 ? (exitClaimProgress.claimed / exitClaimProgress.total) * 100 : 0}%`,
              }}
            />
          </div>
          <div className="text-[10px] font-mono text-amber-400 text-center">
            {exitClaimProgress.claimed} / {exitClaimProgress.total} assigned
          </div>
        </div>
      )}

      {/* Recording indicator overlay */}
      {isRecordingActions && (
        <div
          className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] flex items-center gap-2 px-3 py-1.5 rounded-full border"
          style={{
            background: 'rgba(0,0,0,0.85)',
            borderColor: 'rgba(239,68,68,0.5)',
          }}
        >
          <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          <span className="text-xs font-mono text-red-300">RECORDING ACTIONS</span>
        </div>
      )}

      {/* Asset Palette (Phase 3) */}
      {draggableAssets.length > 0 && teamName && (
        <AssetPalette
          assets={draggableAssets}
          teamName={teamName}
          placedCounts={ownPlacedCounts}
          onAssetDragStart={() => {}}
          onStartDraw={(asset) => setDrawingAsset(asset)}
          onFinishDraw={() => setDrawFinishSignal((s) => s + 1)}
          onCancelDraw={() => {
            setDrawingAsset(null);
            setDrawVertexCount(0);
          }}
          drawingAssetType={drawingAsset?.asset_type ?? null}
          drawVertexCount={drawVertexCount}
          disabled={disabled}
          actionRecording={actionRecording}
          onSubmitActions={onSubmitActions}
          onCancelRecording={onCancelRecording}
          onStartRecording={onStartRecording}
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

      {/* Unified Response Panel (hazard, crowd, casualty) */}
      {respondToElement && (
        <MapElementResponsePanel
          element={respondToElement}
          availableAssets={draggableAssets}
          sessionId={sessionId}
          teamName={teamName ?? 'unknown'}
          onClose={() => setRespondToElement(null)}
          placedAssets={placedAssets}
          scenarioLocations={scenarioLocations}
          scenarioType={scenarioType}
          onTriageAssess={async (casualtyId, triageColor) => {
            await api.casualties.assess(sessionId, casualtyId, {
              player_triage_color: triageColor,
              team_name: teamName ?? 'unknown',
            });
            setCasualties((prev) =>
              prev.map((c) =>
                c.id === casualtyId
                  ? {
                      ...c,
                      status: c.status === 'undiscovered' ? 'identified' : c.status,
                      conditions: { ...c.conditions, player_triage_color: triageColor },
                    }
                  : c,
              ),
            );
          }}
        />
      )}
    </div>
  );
};
