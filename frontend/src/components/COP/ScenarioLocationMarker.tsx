import { Marker, Popup } from 'react-leaflet';
import { DivIcon } from 'leaflet';
import type { LatLngExpression } from 'leaflet';
import { svg } from './mapIcons';

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
  claimable_by?: string[];
  claimed_by_team?: string | null;
  claimed_as?: string | null;
  claim_exclusivity?: string | null;
}

interface ScenarioLocationMarkerProps {
  location: ScenarioLocationPin;
  position: LatLngExpression;
  draggable?: boolean;
  onDragEnd?: (id: string, lat: number, lng: number) => void;
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
  if (cat === 'route' || t === 'route') return '#15803d';
  if (
    cat === 'access' ||
    cat === 'entry_exit' ||
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
    return svg('explosion');
  if (
    cat === 'cordon' ||
    t.includes('cordon') ||
    t.includes('perimeter') ||
    t.includes('exclusion')
  )
    return svg('cordon');
  if (cat === 'triage' || t.includes('triage') || t.includes('casualty'))
    return svg('medical_cross');
  if (t.includes('negotiat') || t.includes('ops') || t.includes('command') || t.includes('icp'))
    return svg('command');
  if (cat === 'command') return svg('command');
  if (cat === 'route' || t === 'route') return svg('route');
  if (
    cat === 'access' ||
    cat === 'entry_exit' ||
    t.includes('exit') ||
    t.includes('entry') ||
    t.includes('route') ||
    t.includes('pathway') ||
    t.includes('ingress') ||
    t.includes('egress')
  )
    return svg('door');
  if (
    cat === 'staging' ||
    t.includes('staging') ||
    t.includes('holding') ||
    t.includes('assembly') ||
    t.includes('pool')
  )
    return svg('staging');
  if (t.includes('media') || t.includes('press')) return svg('broadcast');
  if (t.includes('hospital')) return svg('hospital');
  if (t.includes('police')) return svg('police');
  if (t.includes('fire') || t.includes('scdf')) return svg('fire_station');
  if (t.includes('cctv')) return svg('camera');
  if (t.includes('community')) return svg('community');
  return svg('pin');
};

const isIncidentSite = (pin: ScenarioLocationPin): boolean => {
  const cat = pin.pin_category?.toLowerCase() ?? '';
  const t = pin.location_type.toLowerCase();
  return (
    cat === 'incident_site' ||
    t.includes('blast') ||
    t.includes('epicentre') ||
    t.includes('device') ||
    t.includes('attack') ||
    t.includes('explosion') ||
    t.includes('detonation') ||
    t.includes('impact')
  );
};

const createPinIcon = (pin: ScenarioLocationPin): DivIcon => {
  const color = getPinColor(pin);
  const symbol = getSymbol(pin);
  const primary = isIncidentSite(pin);
  const size = primary ? 48 : 32;
  const borderWidth = primary ? 3 : 2;
  const svgSize = primary ? 24 : 16;

  return new DivIcon({
    className: `scenario-location-marker${primary ? ' primary-incident' : ''}`,
    html: `
      ${
        primary
          ? `<div class="primary-incident-pulse" style="
        position:absolute;
        top:50%;left:50%;
        width:${size + 16}px;height:${size + 16}px;
        margin-left:-${(size + 16) / 2}px;margin-top:-${(size + 16) / 2}px;
        border-radius:50%;
        border:2px solid ${color};
        opacity:0;
        animation:incident-pulse 2s ease-out infinite;
        pointer-events:none;
      "></div>`
          : ''
      }
      <div style="
        position:relative;
        background-color: ${color};
        width: ${size}px;
        height: ${size}px;
        border-radius: 50%;
        border: ${borderWidth}px solid ${primary ? '#fbbf24' : 'white'};
        box-shadow: ${primary ? `0 0 16px 4px ${color}88, 0 4px 12px rgba(0,0,0,0.4)` : '0 2px 6px rgba(0,0,0,0.3)'};
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: ${svgSize}px;
        line-height: 1;
        z-index:10;
      ">
        ${primary ? symbol.replace(/width="16"/, `width="${svgSize}"`).replace(/height="16"/, `height="${svgSize}"`) : symbol}
      </div>
    `,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
};

export const ScenarioLocationMarker = ({
  location,
  position,
  draggable,
  onDragEnd,
}: ScenarioLocationMarkerProps) => {
  const icon = createPinIcon(location);
  const narrativeDesc =
    location.narrative_description ??
    (location.conditions?.narrative_description as string | undefined);

  return (
    <Marker
      position={position}
      icon={icon}
      draggable={draggable}
      eventHandlers={
        draggable && onDragEnd
          ? {
              dragend: (e) => {
                const latlng = e.target.getLatLng();
                onDragEnd(location.id, latlng.lat, latlng.lng);
              },
            }
          : undefined
      }
    >
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
