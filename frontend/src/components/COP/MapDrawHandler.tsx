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
  /** Increment to trigger finish from outside (e.g. a Finish button). */
  finishSignal?: number;
  /** Reports the current vertex count so parent can enable/disable Finish button. */
  onVertexCountChange?: (count: number) => void;
}

const SNAP_RADIUS_PX = 18;

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
  finishSignal,
  onVertexCountChange,
}: MapDrawHandlerProps) => {
  const map = useMap();
  const [vertices, setVertices] = useState<LatLng[]>([]);
  const [cursorPos, setCursorPos] = useState<LatLng | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [nearStart, setNearStart] = useState(false);
  const verticesRef = useRef(vertices);
  verticesRef.current = vertices;

  const isPolygon = drawingAsset.geometry_type === 'polygon';
  const minPoints = isPolygon ? 3 : 2;

  // Report vertex count changes to parent
  useEffect(() => {
    onVertexCountChange?.(vertices.length);
  }, [vertices.length, onVertexCountChange]);

  const finishDrawing = useCallback(
    async (closeLoop = false) => {
      const pts = verticesRef.current;
      if (pts.length < minPoints || submitting) return;
      setSubmitting(true);

      const coordinates = pts.map((p) => [p.lng, p.lat]);

      let geometry: { type: 'Polygon' | 'LineString'; coordinates: unknown };
      if (isPolygon) {
        geometry = { type: 'Polygon', coordinates: [[...coordinates, coordinates[0]]] };
      } else if (closeLoop && coordinates.length >= 2) {
        geometry = { type: 'LineString', coordinates: [...coordinates, coordinates[0]] };
      } else {
        geometry = { type: 'LineString', coordinates };
      }

      const measurePts = closeLoop ? [...pts, pts[0]] : pts;
      const totalLength = polylineLength(measurePts);
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
    },
    [sessionId, teamName, drawingAsset, isPolygon, minPoints, submitting, onFinish],
  );

  // Allow parent to trigger finish via incrementing finishSignal
  const prevSignalRef = useRef(finishSignal);
  useEffect(() => {
    if (finishSignal !== undefined && finishSignal !== prevSignalRef.current) {
      prevSignalRef.current = finishSignal;
      finishDrawing();
    }
  }, [finishSignal, finishDrawing]);

  /** Check if a screen point is within SNAP_RADIUS_PX of the first vertex. */
  const isNearFirstVertex = useCallback(
    (latlng: LatLng): boolean => {
      if (verticesRef.current.length < minPoints) return false;
      const first = verticesRef.current[0];
      const clickPx = map.latLngToContainerPoint(latlng);
      const firstPx = map.latLngToContainerPoint(first);
      const dx = clickPx.x - firstPx.x;
      const dy = clickPx.y - firstPx.y;
      return dx * dx + dy * dy <= SNAP_RADIUS_PX * SNAP_RADIUS_PX;
    },
    [map, minPoints],
  );

  useMapEvents({
    click(e: LeafletMouseEvent) {
      if (submitting) return;
      if (isNearFirstVertex(e.latlng)) {
        finishDrawing(true);
        return;
      }
      setVertices((prev) => [...prev, e.latlng]);
    },
    dblclick(e: LeafletMouseEvent) {
      e.originalEvent.preventDefault();
      e.originalEvent.stopPropagation();
      setVertices((prev) => {
        const next = [...prev, e.latlng];
        verticesRef.current = next;
        return next;
      });
      setTimeout(() => finishDrawing(), 0);
    },
    mousemove(e: LeafletMouseEvent) {
      setCursorPos(e.latlng);
      setNearStart(isNearFirstVertex(e.latlng));
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

  // Keyboard shortcuts
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

  // Build preview: when near the start vertex, snap the preview line back to vertex[0]
  const previewEnd = nearStart && vertices.length >= minPoints ? vertices[0] : cursorPos;
  const previewPoints = previewEnd ? [...vertices, previewEnd] : vertices;
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
                color: nearStart ? '#22c55e' : '#f59e0b',
                fillColor: nearStart ? '#22c55e' : '#f59e0b',
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
                color: nearStart ? '#22c55e' : '#f59e0b',
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
          radius={i === 0 && nearStart ? 9 : 5}
          pathOptions={{
            color: i === 0 ? '#22c55e' : '#f59e0b',
            fillColor: i === 0 ? '#22c55e' : '#f59e0b',
            fillOpacity: i === 0 && nearStart ? 0.5 : 1,
            weight: i === 0 && nearStart ? 3 : 2,
          }}
        />
      ))}
    </>
  );
};
