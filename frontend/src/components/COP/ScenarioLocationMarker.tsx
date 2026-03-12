import { Marker, Popup } from 'react-leaflet';
import { DivIcon } from 'leaflet';
import type { LatLngExpression } from 'leaflet';

/**
 * Scenario location pin (map pin from DB).
 * Supports narrative-derived location_type (free-form) with pin_category for visual grouping.
 */

export interface ScenarioLocationPin {
  id: string;
  location_type: string;
  /** Structural category for color/symbol; stored in conditions.pin_category */
  pin_category?: string;
  /** One-sentence narrative significance; stored in conditions.narrative_description */
  narrative_description?: string;
  label: string;
  coordinates: { lat?: number; lng?: number };
  conditions?: Record<string, unknown>;
}

interface ScenarioLocationMarkerProps {
  location: ScenarioLocationPin;
  position: LatLngExpression;
}

const getPinColor = (pin: ScenarioLocationPin): string => {
  const cat = pin.pin_category?.toLowerCase() ?? '';
  const t = pin.location_type.toLowerCase();

  if (
    cat === 'incident_site' ||
    t.includes('blast') ||
    t.includes('epicentre') ||
    t.includes('device') ||
    t.includes('attack')
  )
    return '#b91c1c';
  if (
    cat === 'cordon' ||
    t.includes('cordon') ||
    t.includes('perimeter') ||
    t.includes('exclusion')
  )
    return '#7c3aed';
  if (cat === 'triage' || t.includes('triage') || t.includes('casualty') || t.includes('medical'))
    return '#d97706';
  if (
    cat === 'access' ||
    t.includes('exit') ||
    t.includes('entry') ||
    t.includes('route') ||
    t.includes('pathway') ||
    t.includes('ingress') ||
    t.includes('egress')
  )
    return '#059669';
  if (
    cat === 'command' ||
    t.includes('command') ||
    t.includes('icp') ||
    t.includes('ops') ||
    t.includes('negotiat')
  )
    return '#0284c7';
  if (
    cat === 'staging' ||
    t.includes('staging') ||
    t.includes('holding') ||
    t.includes('assembly') ||
    t.includes('pool')
  )
    return '#0891b2';
  if (
    cat === 'poi' ||
    t.includes('hospital') ||
    t.includes('police') ||
    t.includes('fire') ||
    t.includes('scdf') ||
    t.includes('media') ||
    t.includes('press')
  )
    return '#4338ca';
  if (t.includes('cctv')) return '#a855f7';
  if (t.includes('community')) return '#0d9488';
  return '#4b5563';
};

const getSymbol = (pin: ScenarioLocationPin): string => {
  const cat = pin.pin_category?.toLowerCase() ?? '';
  const t = pin.location_type.toLowerCase();

  if (
    cat === 'incident_site' ||
    t.includes('blast') ||
    t.includes('device') ||
    t.includes('epicentre') ||
    t.includes('attack')
  )
    return '💥';
  if (
    cat === 'cordon' ||
    t.includes('cordon') ||
    t.includes('perimeter') ||
    t.includes('exclusion')
  )
    return '⛔';
  if (cat === 'triage' || t.includes('triage') || t.includes('casualty')) return '⚕';
  if (t.includes('negotiat') || t.includes('ops') || t.includes('command') || t.includes('icp'))
    return '🎯';
  if (cat === 'command') return '🎯';
  if (
    cat === 'access' ||
    t.includes('exit') ||
    t.includes('entry') ||
    t.includes('route') ||
    t.includes('pathway') ||
    t.includes('ingress') ||
    t.includes('egress')
  )
    return '🚪';
  if (
    cat === 'staging' ||
    t.includes('staging') ||
    t.includes('holding') ||
    t.includes('assembly') ||
    t.includes('pool')
  )
    return '⛺';
  if (t.includes('media') || t.includes('press')) return '📡';
  if (t.includes('hospital')) return '🏥';
  if (t.includes('police')) return '🛡';
  if (t.includes('fire') || t.includes('scdf')) return '🚒';
  if (t.includes('cctv')) return '📹';
  if (t.includes('community')) return '🏛';
  return '📍';
};

const createPinIcon = (pin: ScenarioLocationPin): DivIcon => {
  const color = getPinColor(pin);
  const symbol = getSymbol(pin);
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
  const icon = createPinIcon(location);
  const narrativeDesc =
    location.narrative_description ??
    (location.conditions?.narrative_description as string | undefined);

  return (
    <Marker position={position} icon={icon}>
      <Popup>
        <div className="p-2 min-w-[150px] max-w-[220px]">
          <div className="text-sm font-medium terminal-text text-robotic-yellow">
            {location.label}
          </div>
          <div className="text-xs text-robotic-yellow/60 mt-0.5 capitalize">
            {location.location_type.replace(/_/g, ' ')}
          </div>
          {narrativeDesc && (
            <div className="text-xs text-robotic-yellow/80 mt-1 leading-snug">{narrativeDesc}</div>
          )}
        </div>
      </Popup>
    </Marker>
  );
};
