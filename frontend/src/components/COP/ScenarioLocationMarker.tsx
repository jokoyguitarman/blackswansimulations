import { Marker, Popup } from 'react-leaflet';
import { DivIcon } from 'leaflet';
import type { LatLngExpression } from 'leaflet';

/**
 * Scenario location pin (map pin from DB) — label only, no condition details.
 * Step 6: blast_site, exit, triage_site, cordon, pathway, parking.
 */

export interface ScenarioLocationPin {
  id: string;
  location_type: string;
  label: string;
  coordinates: { lat?: number; lng?: number };
}

interface ScenarioLocationMarkerProps {
  location: ScenarioLocationPin;
  position: LatLngExpression;
}

const getPinColor = (locationType: string): string => {
  const t = locationType.toLowerCase();
  if (t.includes('blast') || t.includes('epicentre')) return '#b91c1c';
  if (t.includes('exit')) return '#059669';
  if (t.includes('triage')) return '#d97706';
  if (t.includes('cordon')) return '#7c3aed';
  if (t.includes('area')) return '#6b7280';
  if (t.includes('pathway')) return '#2563eb';
  if (t.includes('parking')) return '#6b7280';
  if (t.includes('police')) return '#4338ca';
  if (t.includes('fire_station') || t.includes('scdf')) return '#ea580c';
  if (t.includes('hospital')) return '#0891b2';
  if (t.includes('community_center') || t.includes('community centre')) return '#0d9488';
  if (t.includes('cctv')) return '#a855f7';
  return '#4b5563';
};

/** Symbol per establishment/type so pins are distinguishable at a glance. */
const getSymbol = (locationType: string): string => {
  const t = locationType.toLowerCase();
  if (t.includes('blast') || t.includes('epicentre')) return '💥';
  if (t.includes('exit')) return '🚪';
  if (t.includes('triage')) return '⚕';
  if (t.includes('area')) return '▢';
  if (t.includes('pathway')) return '→';
  if (t.includes('parking')) return 'P';
  if (t.includes('police')) return '🛡';
  if (t.includes('fire_station') || t.includes('scdf')) return '🚒';
  if (t.includes('hospital')) return '🏥';
  if (t.includes('community_center') || t.includes('community centre')) return '🏛';
  if (t.includes('cctv')) return '📹';
  return '📍';
};

const createPinIcon = (locationType: string): DivIcon => {
  const color = getPinColor(locationType);
  const symbol = getSymbol(locationType);
  return new DivIcon({
    className: 'scenario-location-marker',
    html: `
      <div style="
        background-color: ${color};
        width: 32px;
        height: 32px;
        border-radius: 50%;
        border: 2px solid white;
        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        line-height: 1;
      ">
        <span style="filter: drop-shadow(0 0 1px rgba(0,0,0,0.5));">${symbol}</span>
      </div>
    `,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -16],
  });
};

export const ScenarioLocationMarker = ({ location, position }: ScenarioLocationMarkerProps) => {
  const icon = createPinIcon(location.location_type);

  return (
    <Marker position={position} icon={icon}>
      <Popup>
        <div className="p-2 min-w-[120px]">
          <div className="text-sm font-medium terminal-text text-robotic-yellow">
            {location.label}
          </div>
          <div className="text-xs text-robotic-yellow/70 mt-0.5 capitalize">
            {location.location_type.replace(/_/g, ' ')}
          </div>
        </div>
      </Popup>
    </Marker>
  );
};
