import { useEffect, useState, useCallback } from 'react';
import { CircleMarker, Polygon, useMap } from 'react-leaflet';
import { api } from '../../lib/api';

interface StudData {
  id: string;
  lat: number;
  lng: number;
  floor: string;
  occupied: boolean;
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
        grid.studs.map((stud) => (
          <CircleMarker
            key={stud.id}
            center={[stud.lat, stud.lng]}
            radius={stud.occupied ? 2.5 : 3}
            pathOptions={{
              color: stud.occupied ? '#94a3b8' : '#6366f1',
              fillColor: stud.occupied ? '#94a3b8' : '#818cf8',
              fillOpacity: stud.occupied ? 0.25 : 0.5,
              weight: stud.occupied ? 0.5 : 1,
            }}
            interactive={false}
          />
        )),
      )}
    </>
  );
};
