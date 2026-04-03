import { useEffect, useCallback, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import { useWebSocket } from '../../hooks/useWebSocket';
import type { WebSocketEvent } from '../../lib/websocketClient';

const PIN_ZOOM = 22;
const PLACEMENT_ZOOM = 21;
const ZOOM_DURATION = 1.5;
const RETURN_DELAY_MS = 10000;
const IDLE_ROAM_INTERVAL_MS = 20000;
const ROAM_ZOOM = 17;
const ROAM_DURATION = 2.5;
const PULSE_DURATION_MS = 8000;

interface DemoMapAnimatorProps {
  sessionId: string;
  initialCenter: [number, number];
  initialZoom: number;
}

const PULSE_CSS = `
@keyframes demo-pin-pulse {
  0%   { transform: scale(0.3); opacity: 1; }
  50%  { transform: scale(1.8); opacity: 0.5; }
  100% { transform: scale(3); opacity: 0; }
}
@keyframes demo-pin-glow {
  0%, 100% { box-shadow: 0 0 30px 15px rgba(245, 158, 11, 0.7); }
  50%      { box-shadow: 0 0 60px 30px rgba(245, 158, 11, 1); }
}
@keyframes demo-pin-label-fade {
  0%   { opacity: 0; transform: translateY(10px); }
  20%  { opacity: 1; transform: translateY(0); }
  80%  { opacity: 1; }
  100% { opacity: 0; }
}
.demo-pin-pulse-ring {
  position: absolute;
  width: 200px;
  height: 200px;
  margin-left: -100px;
  margin-top: -100px;
  border-radius: 50%;
  border: 4px solid #f59e0b;
  animation: demo-pin-pulse 2s ease-out infinite;
  pointer-events: none;
  z-index: 9999;
}
.demo-pin-pulse-core {
  position: absolute;
  width: 60px;
  height: 60px;
  margin-left: -30px;
  margin-top: -30px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(245,158,11,0.9) 0%, rgba(245,158,11,0.3) 50%, rgba(245,158,11,0) 70%);
  animation: demo-pin-glow 1.2s ease-in-out infinite;
  pointer-events: none;
  z-index: 10000;
}
.demo-pin-label {
  position: absolute;
  top: 40px;
  left: 50%;
  transform: translateX(-50%);
  white-space: nowrap;
  font-size: 11px;
  font-weight: bold;
  color: #f59e0b;
  text-shadow: 0 0 8px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,1);
  animation: demo-pin-label-fade 8s ease-out forwards;
  pointer-events: none;
  z-index: 10001;
}
`;

function ensurePulseStyles() {
  if (document.getElementById('demo-pulse-css')) return;
  const style = document.createElement('style');
  style.id = 'demo-pulse-css';
  style.textContent = PULSE_CSS;
  document.head.appendChild(style);
}

/**
 * Sits inside <MapContainer> and animates the map camera:
 * 1. Zooms to pin when a bot interacts with a casualty/hazard (demo.pin_response)
 * 2. Zooms to placed asset when a bot drops one (asset.placed)
 * 3. Gently roams between points of interest during idle periods
 * 4. Shows a pulsing ring on the pin being interacted with
 */
export function DemoMapAnimator({ sessionId, initialCenter, initialZoom }: DemoMapAnimatorProps) {
  const map = useMap();
  const returnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roamTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interestPoints = useRef<Array<[number, number]>>([initialCenter]);
  const lastFocusTs = useRef(0);
  const pulseMarker = useRef<L.Marker | null>(null);
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => ensurePulseStyles(), []);

  const clearTimers = useCallback(() => {
    if (returnTimer.current) clearTimeout(returnTimer.current);
    if (roamTimer.current) clearTimeout(roamTimer.current);
  }, []);

  const removePulse = useCallback(() => {
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
    if (pulseMarker.current) {
      pulseMarker.current.remove();
      pulseMarker.current = null;
    }
  }, []);

  const showPulse = useCallback(
    (lat: number, lng: number, label?: string) => {
      removePulse();
      const labelHtml = label
        ? `<div class="demo-pin-label">${label.replace(/</g, '&lt;')}</div>`
        : '';
      const icon = L.divIcon({
        className: '',
        html: `<div class="demo-pin-pulse-ring"></div><div class="demo-pin-pulse-core"></div>${labelHtml}`,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      });
      pulseMarker.current = L.marker([lat, lng], { icon, interactive: false }).addTo(map);
      pulseTimer.current = setTimeout(removePulse, PULSE_DURATION_MS);
    },
    [map, removePulse],
  );

  const scheduleReturn = useCallback(() => {
    clearTimers();
    returnTimer.current = setTimeout(() => {
      map.flyTo(initialCenter, initialZoom, { duration: ROAM_DURATION });
    }, RETURN_DELAY_MS);
  }, [map, initialCenter, initialZoom, clearTimers]);

  const focusOn = useCallback(
    (lat: number, lng: number, zoom?: number, pulse?: boolean, label?: string) => {
      const now = Date.now();
      if (now - lastFocusTs.current < 3000) return;
      lastFocusTs.current = now;

      clearTimers();
      map.flyTo([lat, lng], zoom ?? PIN_ZOOM, { duration: ZOOM_DURATION });

      if (pulse) showPulse(lat, lng, label);

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
    [map, clearTimers, scheduleReturn, showPulse],
  );

  const handleEvent = useCallback(
    (event: WebSocketEvent) => {
      if (event.type === 'demo.pin_response') {
        const d = event.data as Record<string, unknown>;
        const lat = Number(d.target_lat);
        const lng = Number(d.target_lng);
        if (lat && lng && !isNaN(lat) && !isNaN(lng)) {
          const team = (d.team_name as string) ?? '';
          const action = (d.action_label as string) ?? 'Pin Response';
          const label = team ? `${team.replace(/_/g, ' ').toUpperCase()}: ${action}` : action;
          focusOn(lat, lng, PIN_ZOOM, true, label);
        }
      } else if (event.type === 'asset.placed' || event.type === 'placement.created') {
        const d = event.data as Record<string, unknown>;
        const asset = (d.asset ?? d.placement ?? d) as Record<string, unknown>;
        const geom = asset.geometry as Record<string, unknown> | undefined;
        const assetLabel =
          (asset.label as string) ?? ((asset.asset_type as string) ?? 'Asset').replace(/_/g, ' ');
        const teamLabel = ((asset.team_name as string) ?? '').replace(/_/g, ' ').toUpperCase();
        const label = teamLabel ? `${teamLabel}: ${assetLabel}` : assetLabel;
        if (geom?.type === 'Point') {
          const coords = geom.coordinates as number[];
          if (coords?.length >= 2) focusOn(coords[1], coords[0], PLACEMENT_ZOOM, true, label);
        } else if (geom?.type === 'Polygon') {
          const ring = (geom.coordinates as number[][][])?.[0];
          if (ring?.length) {
            let cLat = 0,
              cLng = 0;
            for (const c of ring) {
              cLat += c[1];
              cLng += c[0];
            }
            focusOn(cLat / ring.length, cLng / ring.length, PLACEMENT_ZOOM, true, label);
          }
        }
      } else if (event.type === 'decision.proposed' || event.type === 'decision.executed') {
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
    eventTypes: [
      'demo.pin_response',
      'asset.placed',
      'placement.created',
      'decision.proposed',
      'decision.executed',
    ],
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
    return () => {
      clearTimers();
      removePulse();
    };
  }, [clearTimers, removePulse]);

  return null;
}
