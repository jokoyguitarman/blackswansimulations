import { useEffect, useState, useCallback, useRef } from 'react';
import { CircleMarker, Polygon, Polyline, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import { api } from '../../lib/api';

interface StudData {
  id: string;
  lat: number;
  lng: number;
  floor: string;
  occupied: boolean;
  blastBand: string | null;
  operationalZone: string | null;
  distFromIncidentM: number | null;
  studType: string;
  spatialContext: string;
  contextBuildingName: string | null;
  contextRoadName: string | null;
}

interface GridData {
  buildingIndex: number;
  buildingName: string | null;
  polygon: [number, number][];
  floors: string[];
  spacingM: number;
  isIncidentBuilding: boolean;
  studs: StudData[];
}

interface RoadPolyline {
  name: string;
  highway_type: string;
  coordinates: [number, number][];
}

interface BuildingStudOverlayProps {
  scenarioId: string;
  sessionId?: string;
  floor?: string;
  /** Refresh trigger — increment to refetch occupancy (e.g. after a placement) */
  refreshKey?: number;
  /** When true, clicking the map inspects the nearest stud */
  inspectable?: boolean;
}

const MIN_ZOOM_TO_SHOW = 16;
const INSPECT_SNAP_RADIUS_PX = 20;

const ZONE_COLORS: Record<string, { color: string; fill: string }> = {
  kill: { color: '#ef4444', fill: '#f87171' },
  critical: { color: '#f97316', fill: '#fb923c' },
  serious: { color: '#eab308', fill: '#facc15' },
  minor: { color: '#3b82f6', fill: '#60a5fa' },
};

const OCCUPIED_STYLE = { color: '#94a3b8', fill: '#94a3b8' };

const CONTEXT_LABELS: Record<string, string> = {
  inside_building: 'Inside Building',
  road: 'Road',
  open_air: 'Open Air',
};

const BAND_LABELS: Record<string, string> = {
  kill: 'Kill Zone',
  critical: 'Critical Zone',
  serious: 'Serious Zone',
  minor: 'Minor Zone',
};

const ZONE_LABELS: Record<string, string> = {
  hot: 'Hot Zone',
  warm: 'Warm Zone',
  cold: 'Cold Zone',
};

function getStudStyle(stud: StudData) {
  if (stud.occupied) {
    return {
      color: OCCUPIED_STYLE.color,
      fillColor: OCCUPIED_STYLE.fill,
      fillOpacity: 0.25,
      weight: 0.5,
      radius: 2.5,
    };
  }

  const zoneStyle = stud.blastBand ? ZONE_COLORS[stud.blastBand] : null;

  if (stud.spatialContext === 'inside_building') {
    return {
      color: zoneStyle?.color ?? '#6366f1',
      fillColor: zoneStyle?.fill ?? '#818cf8',
      fillOpacity: 0.15,
      weight: 0.5,
      radius: 2,
    };
  }

  if (stud.spatialContext === 'road') {
    return {
      color: '#10b981',
      fillColor: '#34d399',
      fillOpacity: 0.6,
      weight: 1,
      radius: 2.5,
    };
  }

  return {
    color: zoneStyle?.color ?? '#6366f1',
    fillColor: zoneStyle?.fill ?? '#818cf8',
    fillOpacity: 0.55,
    weight: 1,
    radius: 3,
  };
}

function StudInspectPopup({ stud, position }: { stud: StudData; position: [number, number] }) {
  const contextLabel = CONTEXT_LABELS[stud.spatialContext] ?? stud.spatialContext;
  const bandLabel = stud.blastBand ? (BAND_LABELS[stud.blastBand] ?? stud.blastBand) : null;
  const zoneLabel = stud.operationalZone
    ? (ZONE_LABELS[stud.operationalZone] ?? stud.operationalZone)
    : null;

  return (
    <Popup position={position} autoPan={false}>
      <div style={{ fontFamily: 'monospace', fontSize: 11, lineHeight: 1.6, minWidth: 180 }}>
        <div
          style={{
            fontWeight: 700,
            marginBottom: 4,
            borderBottom: '1px solid #444',
            paddingBottom: 3,
          }}
        >
          STUD INSPECTOR
        </div>
        <div>
          <strong>Context:</strong> {contextLabel}
        </div>
        {stud.contextBuildingName && (
          <div>
            <strong>Building:</strong> {stud.contextBuildingName}
          </div>
        )}
        {stud.contextRoadName && (
          <div>
            <strong>Road:</strong> {stud.contextRoadName}
          </div>
        )}
        {bandLabel && (
          <div>
            <strong>Blast Band:</strong> {bandLabel}
          </div>
        )}
        {zoneLabel && (
          <div>
            <strong>Op Zone:</strong> {zoneLabel}
          </div>
        )}
        {stud.distFromIncidentM != null && (
          <div>
            <strong>Dist from incident:</strong> {stud.distFromIncidentM}m
          </div>
        )}
        <div>
          <strong>Floor:</strong> {stud.floor}
        </div>
        <div>
          <strong>Occupied:</strong> {stud.occupied ? 'Yes' : 'No'}
        </div>
        <div style={{ opacity: 0.5, fontSize: 9, marginTop: 3 }}>{stud.id}</div>
      </div>
    </Popup>
  );
}

export const BuildingStudOverlay = ({
  scenarioId,
  sessionId,
  floor,
  refreshKey,
  inspectable = false,
}: BuildingStudOverlayProps) => {
  const map = useMap();
  const [grids, setGrids] = useState<GridData[]>([]);
  const [roads, setRoads] = useState<RoadPolyline[]>([]);
  const [zoom, setZoom] = useState(map.getZoom());
  const [inspectedStud, setInspectedStud] = useState<StudData | null>(null);
  const gridsRef = useRef(grids);
  gridsRef.current = grids;

  const fetchStuds = useCallback(async () => {
    try {
      const result = await api.scenarios.getBuildingStuds(scenarioId, sessionId, floor);
      if (result?.grids) setGrids(result.grids);
      if (result?.roadPolylines) setRoads(result.roadPolylines);
    } catch {
      // Non-critical
    }
  }, [scenarioId, sessionId, floor]);

  useEffect(() => {
    fetchStuds();
  }, [fetchStuds, refreshKey]);

  useEffect(() => {
    const onZoom = () => setZoom(map.getZoom());
    map.on('zoomend', onZoom);
    return () => {
      map.off('zoomend', onZoom);
    };
  }, [map]);

  // Click-to-inspect handler
  useEffect(() => {
    if (!inspectable) {
      setInspectedStud(null);
      return;
    }

    const onClick = (e: L.LeafletMouseEvent) => {
      const clickPx = map.latLngToContainerPoint(e.latlng);
      let nearest: StudData | null = null;
      let nearestDistPx = Infinity;

      for (const grid of gridsRef.current) {
        for (const stud of grid.studs) {
          const studPx = map.latLngToContainerPoint([stud.lat, stud.lng]);
          const dx = clickPx.x - studPx.x;
          const dy = clickPx.y - studPx.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < nearestDistPx) {
            nearestDistPx = d;
            nearest = stud;
          }
        }
      }

      if (nearest && nearestDistPx <= INSPECT_SNAP_RADIUS_PX) {
        setInspectedStud(nearest);
      } else {
        setInspectedStud(null);
      }
    };

    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
    };
  }, [inspectable, map]);

  if (zoom < MIN_ZOOM_TO_SHOW || (grids.length === 0 && roads.length === 0)) return null;

  return (
    <>
      {/* Road polylines */}
      {roads.map((road, ri) => (
        <Polyline
          key={`road-${ri}`}
          positions={road.coordinates.map(([lat, lng]) => [lat, lng] as [number, number])}
          pathOptions={{
            color: '#475569',
            weight: 3,
            opacity: 0.35,
            dashArray: '6, 4',
          }}
          interactive={false}
        />
      ))}

      {/* Building outlines */}
      {grids.map((grid) => {
        if (grid.polygon.length < 3) return null;
        const isIncident = grid.isIncidentBuilding;
        return (
          <Polygon
            key={`bldg-outline-${grid.buildingIndex}`}
            positions={grid.polygon.map(([lat, lng]) => [lat, lng] as [number, number])}
            pathOptions={
              isIncident
                ? {
                    color: '#f97316',
                    weight: 2,
                    fillOpacity: 0.08,
                    fillColor: '#f97316',
                  }
                : {
                    color: '#64748b',
                    weight: 1.5,
                    fillOpacity: 0.15,
                    fillColor: '#475569',
                    dashArray: '4, 4',
                  }
            }
          />
        );
      })}

      {/* Stud dots */}
      {grids.flatMap((grid) =>
        grid.studs.map((stud) => {
          const style = getStudStyle(stud);
          const isSelected = inspectedStud?.id === stud.id;
          return (
            <CircleMarker
              key={stud.id}
              center={[stud.lat, stud.lng]}
              radius={isSelected ? style.radius + 3 : style.radius}
              pathOptions={{
                color: isSelected ? '#ffffff' : style.color,
                fillColor: isSelected ? '#f59e0b' : style.fillColor,
                fillOpacity: isSelected ? 1 : style.fillOpacity,
                weight: isSelected ? 2 : style.weight,
              }}
              interactive={false}
            />
          );
        }),
      )}

      {/* Inspect popup */}
      {inspectedStud && (
        <StudInspectPopup stud={inspectedStud} position={[inspectedStud.lat, inspectedStud.lng]} />
      )}
    </>
  );
};
