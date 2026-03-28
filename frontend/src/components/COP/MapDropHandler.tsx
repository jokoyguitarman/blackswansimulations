import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import { api } from '../../lib/api';
import type { DraggableAssetDef } from './AssetPalette';
import type { PlacedAsset } from './PlacedAssetMarker';

interface MapDropHandlerProps {
  sessionId: string;
  teamName: string;
  enabled: boolean;
  onPlacementCreated?: (placement: {
    id: string;
    label: string;
    asset_type: string;
    geometry: Record<string, unknown>;
    properties: Record<string, unknown>;
  }) => void;
  onOptimisticPlace?: (asset: PlacedAsset) => void;
  onOptimisticConfirm?: (tempId: string, realAsset: PlacedAsset) => void;
  onOptimisticRevert?: (tempId: string) => void;
}

export const MapDropHandler = ({
  sessionId,
  teamName,
  enabled,
  onPlacementCreated,
  onOptimisticPlace,
  onOptimisticConfirm,
  onOptimisticRevert,
}: MapDropHandlerProps) => {
  const map = useMap();

  useEffect(() => {
    if (!enabled) return;

    const container = map.getContainer();
    let draggingOverMap = false;

    const disableMapDrag = () => {
      if (!draggingOverMap) {
        draggingOverMap = true;
        map.dragging.disable();
      }
    };

    const enableMapDrag = () => {
      if (draggingOverMap) {
        draggingOverMap = false;
        map.dragging.enable();
      }
    };

    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault();
      disableMapDrag();
    };

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      disableMapDrag();
    };

    const handleDragLeave = (e: DragEvent) => {
      const related = e.relatedTarget as Node | null;
      if (!related || !container.contains(related)) {
        enableMapDrag();
      }
    };

    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      enableMapDrag();

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

      const geom = { type: 'Point' as const, coordinates: [latlng.lng, latlng.lat] };
      const tempId = `temp_${crypto.randomUUID()}`;

      const optimistic: PlacedAsset = {
        id: tempId,
        session_id: sessionId,
        team_name: teamName,
        placed_by: 'self',
        asset_type: asset.asset_type,
        label: asset.label,
        geometry: geom,
        properties: {},
        placement_score: null,
        status: 'active',
        placed_at: new Date().toISOString(),
      };

      onOptimisticPlace?.(optimistic);
      onPlacementCreated?.({
        id: tempId,
        label: asset.label,
        asset_type: asset.asset_type,
        geometry: geom,
        properties: {},
      });

      api.placements
        .create(sessionId, {
          team_name: teamName,
          asset_type: asset.asset_type,
          label: asset.label,
          geometry: geom,
          properties: {},
        })
        .then((result) => {
          const placed = result?.data as Record<string, unknown> | undefined;
          if (placed?.id) {
            onOptimisticConfirm?.(tempId, {
              ...optimistic,
              id: placed.id as string,
              geometry: (placed.geometry as PlacedAsset['geometry']) ?? geom,
              properties: (placed.properties as Record<string, unknown>) ?? {},
              placement_score: (placed.placement_score as Record<string, unknown> | null) ?? null,
            });
          }
        })
        .catch(() => {
          onOptimisticRevert?.(tempId);
        });
    };

    container.addEventListener('dragenter', handleDragEnter);
    container.addEventListener('dragover', handleDragOver);
    container.addEventListener('dragleave', handleDragLeave);
    container.addEventListener('drop', handleDrop);

    return () => {
      container.removeEventListener('dragenter', handleDragEnter);
      container.removeEventListener('dragover', handleDragOver);
      container.removeEventListener('dragleave', handleDragLeave);
      container.removeEventListener('drop', handleDrop);
      enableMapDrag();
    };
  }, [
    map,
    sessionId,
    teamName,
    enabled,
    onPlacementCreated,
    onOptimisticPlace,
    onOptimisticConfirm,
    onOptimisticRevert,
  ]);

  return null;
};
