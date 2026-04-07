import { useEffect, useState, useCallback } from 'react';
import { CircleMarker, Polygon, useMap } from 'react-leaflet';
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
}

interface GridData {
  buildingIndex: number;
  buildingName: string | null;
  polygon: [number, number][];
  floors: string[];
  spacingM: number;
  studs: StudData[];
}

interface BuildingStudOverlayProps {
  scenarioId: string;
  sessionId?: string;
  floor?: string;
  /** Refresh trigger — increment to refetch occupancy (e.g. after a placement) */
  refreshKey?: number;
}

const MIN_ZOOM_TO_SHOW = 18;

const ZONE_COLORS: Record<string, { color: string; fill: string }> = {
  kill: { color: '#ef4444', fill: '#f87171' },
  critical: { color: '#f97316', fill: '#fb923c' },
  serious: { color: '#eab308', fill: '#facc15' },
  minor: { color: '#3b82f6', fill: '#60a5fa' },
};

const OCCUPIED_STYLE = { color: '#94a3b8', fill: '#94a3b8' };
const DEFAULT_STYLE = { color: '#6366f1', fill: '#818cf8' };

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
  const colors = zoneStyle ?? DEFAULT_STYLE;

  return {
    color: colors.color,
    fillColor: colors.fill,
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
  const [zoom, setZoom] = useState(map.getZoom());

  const fetchStuds = useCallback(async () => {
    try {
      const result = await api.scenarios.getBuildingStuds(scenarioId, sessionId, floor);
      if (result?.grids) setGrids(result.grids);
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

  if (zoom < MIN_ZOOM_TO_SHOW || grids.length === 0) return null;

  return (
    <>
      {grids.map((grid) => (
        <Polygon
          key={`bldg-outline-${grid.buildingIndex}`}
          positions={grid.polygon.map(([lat, lng]) => [lat, lng] as [number, number])}
          pathOptions={{
            color: '#6366f1',
            weight: 1,
            fillOpacity: 0.03,
            dashArray: '4, 4',
          }}
        />
      ))}
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
