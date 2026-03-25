import { useEffect, useState, useCallback, useRef } from 'react';
import { useMap, useMapEvents, Polyline, Polygon, Tooltip, CircleMarker } from 'react-leaflet';
import type { LatLng, LeafletMouseEvent } from 'leaflet';
import { api } from '../../lib/api';
import type { DraggableAssetDef } from './AssetPalette';

interface MapDrawHandlerProps {
  sessionId: string;
  teamName: string;
  drawingAsset: DraggableAssetDef;
  onFinish: () => void;
  onCancel: () => void;
}

function haversineDistance(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * sinLng * sinLng;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`;
  return `${Math.round(meters)} m`;
}

function polylineLength(points: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineDistance(points[i - 1], points[i]);
  }
  return total;
}

function polygonArea(points: LatLng[]): number {
  if (points.length < 3) return 0;
  const R = 6371000;
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    const lat1 = (points[i].lat * Math.PI) / 180;
    const lat2 = (points[j].lat * Math.PI) / 180;
    const dLng = ((points[j].lng - points[i].lng) * Math.PI) / 180;
    total += dLng * (2 + Math.sin(lat1) + Math.sin(lat2));
  }
  return Math.abs((total * R * R) / 2);
}

function formatArea(sqMeters: number): string {
  if (sqMeters >= 1_000_000) return `${(sqMeters / 1_000_000).toFixed(2)} km²`;
  if (sqMeters >= 10_000) return `${(sqMeters / 10_000).toFixed(2)} ha`;
  return `${Math.round(sqMeters)} m²`;
}

export const MapDrawHandler = ({
  sessionId,
  teamName,
  drawingAsset,
  onFinish,
  onCancel,
}: MapDrawHandlerProps) => {
  const map = useMap();
  const [vertices, setVertices] = useState<LatLng[]>([]);
  const [cursorPos, setCursorPos] = useState<LatLng | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const verticesRef = useRef(vertices);
  verticesRef.current = vertices;

  const isPolygon = drawingAsset.geometry_type === 'polygon';
  const minPoints = isPolygon ? 3 : 2;

  const finishDrawing = useCallback(async () => {
    const pts = verticesRef.current;
    if (pts.length < minPoints || submitting) return;
    setSubmitting(true);

    const coordinates = pts.map((p) => [p.lng, p.lat]);
    const geometry = isPolygon
      ? { type: 'Polygon' as const, coordinates: [[...coordinates, coordinates[0]]] }
      : { type: 'LineString' as const, coordinates };

    const totalLength = polylineLength(pts);
    const props: Record<string, unknown> = { length_m: Math.round(totalLength) };
    if (isPolygon) {
      props.area_m2 = Math.round(polygonArea(pts));
    }

    try {
      await api.placements.create(sessionId, {
        team_name: teamName,
        asset_type: drawingAsset.asset_type,
        label: drawingAsset.label,
        geometry,
        properties: props,
      });
    } catch {
      // Validation errors shown by WS event
    }
    setSubmitting(false);
    onFinish();
  }, [sessionId, teamName, drawingAsset, isPolygon, minPoints, submitting, onFinish]);

  useMapEvents({
    click(e: LeafletMouseEvent) {
      if (submitting) return;
      setVertices((prev) => [...prev, e.latlng]);
    },
    dblclick(e: LeafletMouseEvent) {
      e.originalEvent.preventDefault();
      e.originalEvent.stopPropagation();
      // Add the double-click point then finish
      setVertices((prev) => {
        const next = [...prev, e.latlng];
        verticesRef.current = next;
        return next;
      });
      setTimeout(() => finishDrawing(), 0);
    },
    mousemove(e: LeafletMouseEvent) {
      setCursorPos(e.latlng);
    },
    contextmenu(e: LeafletMouseEvent) {
      e.originalEvent.preventDefault();
      onCancel();
    },
  });

  // Disable double-click zoom while drawing
  useEffect(() => {
    map.doubleClickZoom.disable();
    const container = map.getContainer();
    container.style.cursor = 'crosshair';

    return () => {
      map.doubleClickZoom.enable();
      container.style.cursor = '';
    };
  }, [map]);

  // Escape to cancel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter' && verticesRef.current.length >= minPoints) {
        finishDrawing();
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && verticesRef.current.length > 0) {
        setVertices((prev) => prev.slice(0, -1));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel, finishDrawing, minPoints]);

  const previewPoints = cursorPos ? [...vertices, cursorPos] : vertices;
  const positions = previewPoints.map((p) => [p.lat, p.lng] as [number, number]);
  const totalDist = polylineLength(previewPoints);

  return (
    <>
      {/* Preview shape */}
      {positions.length >= 2 && (
        <>
          {isPolygon ? (
            <Polygon
              positions={positions}
              pathOptions={{
                color: '#f59e0b',
                fillColor: '#f59e0b',
                fillOpacity: 0.15,
                weight: 2,
                dashArray: '8, 4',
              }}
            >
              {previewPoints.length >= 3 && (
                <Tooltip sticky>
                  <span className="text-xs font-mono">
                    {formatDistance(totalDist)} perimeter · {formatArea(polygonArea(previewPoints))}
                  </span>
                </Tooltip>
              )}
            </Polygon>
          ) : (
            <Polyline
              positions={positions}
              pathOptions={{
                color: '#f59e0b',
                weight: 3,
                dashArray: '8, 4',
              }}
            >
              <Tooltip sticky>
                <span className="text-xs font-mono">{formatDistance(totalDist)}</span>
              </Tooltip>
            </Polyline>
          )}
        </>
      )}

      {/* Vertex markers */}
      {vertices.map((v, i) => (
        <CircleMarker
          key={i}
          center={[v.lat, v.lng]}
          radius={5}
          pathOptions={{
            color: '#f59e0b',
            fillColor: i === 0 ? '#22c55e' : '#f59e0b',
            fillOpacity: 1,
            weight: 2,
          }}
        />
      ))}
    </>
  );
};
