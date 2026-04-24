import { useState, useCallback, useRef, useEffect } from 'react';
import { useMap, useMapEvents, Polygon, CircleMarker, Tooltip } from 'react-leaflet';
import type { LatLng, LeafletMouseEvent } from 'leaflet';

interface BuildingDrawHandlerProps {
  active: boolean;
  onComplete: (polygon: [number, number][]) => void;
  onCancel: () => void;
}

const SNAP_RADIUS_PX = 18;
const MIN_VERTICES = 3;

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

function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`;
  return `${Math.round(meters)} m`;
}

function formatArea(sqMeters: number): string {
  if (sqMeters >= 10_000) return `${(sqMeters / 10_000).toFixed(2)} ha`;
  return `${Math.round(sqMeters)} m²`;
}

export function BuildingDrawHandler({ active, onComplete, onCancel }: BuildingDrawHandlerProps) {
  const map = useMap();
  const [vertices, setVertices] = useState<LatLng[]>([]);
  const [cursorPos, setCursorPos] = useState<LatLng | null>(null);
  const [nearStart, setNearStart] = useState(false);
  const verticesRef = useRef(vertices);
  verticesRef.current = vertices;

  const finish = useCallback(() => {
    const pts = verticesRef.current;
    if (pts.length < MIN_VERTICES) return;
    const polygon: [number, number][] = pts.map((p) => [p.lat, p.lng]);
    onComplete(polygon);
    setVertices([]);
    setCursorPos(null);
    setNearStart(false);
  }, [onComplete]);

  const isNearFirstVertex = useCallback(
    (latlng: LatLng): boolean => {
      if (verticesRef.current.length < MIN_VERTICES) return false;
      const first = verticesRef.current[0];
      const clickPx = map.latLngToContainerPoint(latlng);
      const firstPx = map.latLngToContainerPoint(first);
      const dx = clickPx.x - firstPx.x;
      const dy = clickPx.y - firstPx.y;
      return dx * dx + dy * dy <= SNAP_RADIUS_PX * SNAP_RADIUS_PX;
    },
    [map],
  );

  useMapEvents({
    click(e: LeafletMouseEvent) {
      if (!active) return;
      if (isNearFirstVertex(e.latlng)) {
        finish();
        return;
      }
      setVertices((prev) => [...prev, e.latlng]);
    },
    dblclick(e: LeafletMouseEvent) {
      if (!active) return;
      e.originalEvent.preventDefault();
      e.originalEvent.stopPropagation();
      setVertices((prev) => {
        const next = [...prev, e.latlng];
        verticesRef.current = next;
        return next;
      });
      setTimeout(() => finish(), 0);
    },
    mousemove(e: LeafletMouseEvent) {
      if (!active) return;
      setCursorPos(e.latlng);
      setNearStart(isNearFirstVertex(e.latlng));
    },
    contextmenu(e: LeafletMouseEvent) {
      if (!active) return;
      e.originalEvent.preventDefault();
      onCancel();
    },
  });

  useEffect(() => {
    if (!active) return;
    map.doubleClickZoom.disable();
    const container = map.getContainer();
    container.style.cursor = 'crosshair';
    return () => {
      map.doubleClickZoom.enable();
      container.style.cursor = '';
    };
  }, [map, active]);

  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setVertices([]);
        onCancel();
      }
      if (e.key === 'Enter' && verticesRef.current.length >= MIN_VERTICES) {
        finish();
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && verticesRef.current.length > 0) {
        setVertices((prev) => prev.slice(0, -1));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active, onCancel, finish]);

  // Reset vertices when entering draw mode
  useEffect(() => {
    if (active) setVertices([]);
  }, [active]);

  if (!active) return null;

  const previewEnd = nearStart && vertices.length >= MIN_VERTICES ? vertices[0] : cursorPos;
  const previewPoints = previewEnd ? [...vertices, previewEnd] : vertices;
  const positions = previewPoints.map((p) => [p.lat, p.lng] as [number, number]);
  const closedPts = [...previewPoints, previewPoints[0]];
  const perimeter = polylineLength(closedPts);

  return (
    <>
      {positions.length >= 2 && (
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
              <span style={{ fontSize: 11, fontFamily: 'monospace' }}>
                {formatDistance(perimeter)} perimeter · {formatArea(polygonArea(previewPoints))}
              </span>
            </Tooltip>
          )}
        </Polygon>
      )}

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
}
