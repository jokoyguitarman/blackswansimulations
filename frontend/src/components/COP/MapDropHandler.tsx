import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import { api } from '../../lib/api';
import type { DraggableAssetDef } from './AssetPalette';

interface MapDropHandlerProps {
  sessionId: string;
  teamName: string;
  enabled: boolean;
}

export const MapDropHandler = ({ sessionId, teamName, enabled }: MapDropHandlerProps) => {
  const map = useMap();

  useEffect(() => {
    if (!enabled) return;

    const container = map.getContainer();

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const raw = e.dataTransfer?.getData('application/json');
      if (!raw) return;

      let asset: DraggableAssetDef;
      try {
        asset = JSON.parse(raw);
      } catch {
        return;
      }

      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const latlng = map.containerPointToLatLng([x, y]);

      try {
        await api.placements.create(sessionId, {
          team_name: teamName,
          asset_type: asset.asset_type,
          label: asset.label,
          geometry: {
            type: 'Point',
            coordinates: [latlng.lng, latlng.lat],
          },
          properties: {},
        });
      } catch {
        // Validation errors handled by UI
      }
    };

    container.addEventListener('dragover', handleDragOver);
    container.addEventListener('drop', handleDrop);

    return () => {
      container.removeEventListener('dragover', handleDragOver);
      container.removeEventListener('drop', handleDrop);
    };
  }, [map, sessionId, teamName, enabled]);

  return null;
};
