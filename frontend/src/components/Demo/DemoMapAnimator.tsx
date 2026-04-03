import { useEffect, useCallback, useRef } from 'react';
import { useMap } from 'react-leaflet';
import { useWebSocket } from '../../hooks/useWebSocket';
import type { WebSocketEvent } from '../../lib/websocketClient';

const ZOOM_LEVEL = 18;
const ZOOM_DURATION = 1.2;
const RETURN_DELAY_MS = 8000;
const IDLE_ROAM_INTERVAL_MS = 20000;
const ROAM_ZOOM = 17;
const ROAM_DURATION = 2.5;

interface DemoMapAnimatorProps {
  sessionId: string;
  initialCenter: [number, number];
  initialZoom: number;
}

/**
 * Sits inside <MapContainer> and animates the map camera:
 * 1. Zooms to pin when a bot interacts with a casualty/hazard (demo.pin_response)
 * 2. Zooms to placed asset when a bot drops one (asset.placed)
 * 3. Gently roams between points of interest during idle periods
 */
export function DemoMapAnimator({ sessionId, initialCenter, initialZoom }: DemoMapAnimatorProps) {
  const map = useMap();
  const returnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roamTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interestPoints = useRef<Array<[number, number]>>([initialCenter]);
  const lastFocusTs = useRef(0);

  const clearTimers = useCallback(() => {
    if (returnTimer.current) clearTimeout(returnTimer.current);
    if (roamTimer.current) clearTimeout(roamTimer.current);
  }, []);

  const scheduleReturn = useCallback(() => {
    clearTimers();
    returnTimer.current = setTimeout(() => {
      map.flyTo(initialCenter, initialZoom, { duration: ROAM_DURATION });
    }, RETURN_DELAY_MS);
  }, [map, initialCenter, initialZoom, clearTimers]);

  const focusOn = useCallback(
    (lat: number, lng: number, zoom?: number) => {
      const now = Date.now();
      if (now - lastFocusTs.current < 3000) return;
      lastFocusTs.current = now;

      clearTimers();
      map.flyTo([lat, lng], zoom ?? ZOOM_LEVEL, { duration: ZOOM_DURATION });

      if (
        !interestPoints.current.some(
          ([a, b]) => Math.abs(a - lat) < 0.0001 && Math.abs(b - lng) < 0.0001,
        )
      ) {
        interestPoints.current.push([lat, lng]);
        if (interestPoints.current.length > 15) interestPoints.current.shift();
      }

      scheduleReturn();
    },
    [map, clearTimers, scheduleReturn],
  );

  const handleEvent = useCallback(
    (event: WebSocketEvent) => {
      if (event.type === 'demo.pin_response') {
        const d = event.data as Record<string, unknown>;
        const lat = Number(d.target_lat);
        const lng = Number(d.target_lng);
        if (lat && lng && !isNaN(lat) && !isNaN(lng)) {
          focusOn(lat, lng, ZOOM_LEVEL);
        }
      } else if (event.type === 'asset.placed') {
        const d = event.data as Record<string, unknown>;
        const asset = (d.asset ?? d.placement ?? d) as Record<string, unknown>;
        const geom = asset.geometry as Record<string, unknown> | undefined;
        if (geom?.type === 'Point') {
          const coords = geom.coordinates as number[];
          if (coords?.length >= 2) focusOn(coords[1], coords[0], ROAM_ZOOM);
        } else if (geom?.type === 'Polygon') {
          const ring = (geom.coordinates as number[][][])?.[0];
          if (ring?.length) {
            let cLat = 0,
              cLng = 0;
            for (const c of ring) {
              cLat += c[1];
              cLng += c[0];
            }
            focusOn(cLat / ring.length, cLng / ring.length, ROAM_ZOOM);
          }
        }
      } else if (event.type === 'decision.proposed' || event.type === 'decision.executed') {
        // Slight pan to keep things dynamic
        const pts = interestPoints.current;
        if (pts.length > 1) {
          const idx = Math.floor(Math.random() * pts.length);
          const [lat, lng] = pts[idx];
          focusOn(lat, lng, ROAM_ZOOM);
        }
      }
    },
    [focusOn],
  );

  useWebSocket({
    sessionId,
    eventTypes: ['demo.pin_response', 'asset.placed', 'decision.proposed', 'decision.executed'],
    onEvent: handleEvent,
  });

  // Idle roam: periodically pan to different interest points
  useEffect(() => {
    const startRoaming = () => {
      roamTimer.current = setInterval(() => {
        const pts = interestPoints.current;
        if (pts.length <= 1) return;
        if (Date.now() - lastFocusTs.current < IDLE_ROAM_INTERVAL_MS * 0.7) return;
        const idx = Math.floor(Math.random() * pts.length);
        const [lat, lng] = pts[idx];
        map.flyTo([lat, lng], ROAM_ZOOM, { duration: ROAM_DURATION });
      }, IDLE_ROAM_INTERVAL_MS);
    };

    const delay = setTimeout(startRoaming, IDLE_ROAM_INTERVAL_MS);
    return () => {
      clearTimeout(delay);
      if (roamTimer.current) clearInterval(roamTimer.current);
    };
  }, [map]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => clearTimers();
  }, [clearTimers]);

  return null;
}
