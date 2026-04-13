import { useEffect, useState, useCallback } from 'react';
import { CircleMarker, Polygon, Polyline, useMap } from 'react-leaflet';
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
}

const MIN_ZOOM_TO_SHOW = 16;

const ZONE_COLORS: Record<string, { color: string; fill: string }> = {
  kill: { color: '#ef4444', fill: '#f87171' },
  critical: { color: '#f97316', fill: '#fb923c' },
  serious: { color: '#eab308', fill: '#facc15' },
  minor: { color: '#3b82f6', fill: '#60a5fa' },
};

const OCCUPIED_STYLE = { color: '#94a3b8', fill: '#94a3b8' };

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

  // open_air — zone-colored
  return {
    color: zoneStyle?.color ?? '#6366f1',
    fillColor: zoneStyle?.fill ?? '#818cf8',
    fillOpacity: 0.55,
    weight: 1,
    radius: 3,
  };
}

export const BuildingStudOverlay = ({
  scenarioId,
  sessionId,
  floor,
  refreshKey,
}: BuildingStudOverlayProps) => {
  const map = useMap();
  const [grids, setGrids] = useState<GridData[]>([]);
  const [roads, setRoads] = useState<RoadPolyline[]>([]);
  const [zoom, setZoom] = useState(map.getZoom());

  const fetchStuds = useCallback(async () => {
    try {
      const result = await api.scenarios.getBuildingStuds(scenarioId, sessionId, floor);
      if (result?.grids) setGrids(result.grids);
      if (result?.roadPolylines) setRoads(result.roadPolylines);
    } catch {
      // Non-critical — overlay just won't render
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

  if (zoom < MIN_ZOOM_TO_SHOW || (grids.length === 0 && roads.length === 0)) return null;

  return (
    <>
      {/* Road polylines — rendered underneath everything */}
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

      {/* Building outlines — incident (orange solid) vs surrounding (gray dashed) */}
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

      {/* Stud dots — styled by spatial context */}
      {grids.flatMap((grid) =>
        grid.studs.map((stud) => {
          const style = getStudStyle(stud);
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
              interactive={false}
            />
          );
        }),
      )}
    </>
  );
};
