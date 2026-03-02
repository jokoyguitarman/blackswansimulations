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
  if (t.includes('pathway')) return '#2563eb';
  if (t.includes('parking')) return '#6b7280';
  return '#4b5563';
};

const createPinIcon = (locationType: string): DivIcon => {
  const color = getPinColor(locationType);
  return new DivIcon({
    className: 'scenario-location-marker',
    html: `
      <div style="
        background-color: ${color};
        width: 28px;
        height: 28px;
        border-radius: 50% 50% 50% 0;
        transform: rotate(-45deg);
        border: 2px solid white;
        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        display: flex;
        align-items: center;
        justify-content: center;
      ">
        <span style="transform: rotate(45deg); font-size: 14px;">📍</span>
      </div>
    `,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
    popupAnchor: [0, -28],
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
