import { Marker, Tooltip } from 'react-leaflet';
import { DivIcon } from 'leaflet';
import type { LatLngExpression } from 'leaflet';
import { svg } from './mapIcons';

export interface HazardZone {
  zone_type: string;
  radius_m: number;
  polygon?: number[][];
  required_ppe?: string[];
  authorized_teams?: string[];
}

export interface HazardData {
  id: string;
  hazard_type: string;
  location_lat: number;
  location_lng: number;
  floor_level: string;
  properties: Record<string, unknown>;
  assessment_criteria: unknown[];
  image_url: string | null;
  current_image_url: string | null;
  current_description: string | null;
  status: string;
  appears_at_minutes: number;
  enriched_description?: string | null;
  fire_class?: string | null;
  debris_type?: string | null;
  resolution_requirements?: Record<string, unknown>;
  personnel_requirements?: Record<string, unknown>;
  equipment_requirements?: Array<Record<string, unknown>>;
  deterioration_timeline?: Record<string, unknown>;
  zones?: HazardZone[];
}

interface HazardMarkerProps {
  hazard: HazardData;
  onClick: (hazard: HazardData) => void;
}

const HAZARD_ICONS: Record<string, { icon: string; color: string }> = {
  fire: { icon: svg('fire'), color: '#dc2626' },
  chemical_spill: { icon: svg('chemical'), color: '#a855f7' },
  structural_collapse: { icon: svg('collapse'), color: '#78716c' },
  debris: { icon: svg('debris'), color: '#92400e' },
  gas_leak: { icon: svg('gas'), color: '#eab308' },
  flood: { icon: svg('flood'), color: '#0284c7' },
  biological: { icon: svg('biohazard'), color: '#65a30d' },
  explosion: { icon: svg('explosion'), color: '#ef4444' },
  electrical: { icon: svg('electrical'), color: '#f59e0b' },
  smoke: { icon: svg('smoke'), color: '#6b7280' },
};

function getHazardVisual(type: string): { icon: string; color: string } {
  return HAZARD_ICONS[type] ?? { icon: svg('hazard_generic'), color: '#f97316' };
}

function statusColor(status: string, baseColor: string): string {
  if (status === 'resolved') return '#22c55e';
  if (status === 'contained') return '#f97316';
  return baseColor;
}

function createHazardIcon(hazard: HazardData): DivIcon {
  const { icon, color: baseColor } = getHazardVisual(hazard.hazard_type);
  const color = statusColor(hazard.status, baseColor);
  const isResolved = hazard.status === 'resolved';
  const size = 30;
  const displayIcon = isResolved ? svg('resolved') : icon;

  return new DivIcon({
    className: 'hazard-marker',
    html: `<div style="
      background:${color};
      width:${size}px;height:${size}px;border-radius:50%;
      border:2px solid #fff;
      box-shadow:0 2px 6px rgba(0,0,0,.3);
      display:flex;align-items:center;justify-content:center;
      cursor:pointer;
      ${isResolved ? 'opacity:0.6;' : ''}
    ">${displayIcon}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -(size / 2)],
  });
}

export const HazardMarker = ({ hazard, onClick }: HazardMarkerProps) => {
  const icon = createHazardIcon(hazard);
  const position: LatLngExpression = [hazard.location_lat, hazard.location_lng];

  return (
    <Marker position={position} icon={icon} eventHandlers={{ click: () => onClick(hazard) }}>
      <Tooltip className="pin-tooltip">
        <div className="text-xs">
          <div className="font-semibold capitalize">{hazard.hazard_type.replace(/_/g, ' ')}</div>
          <div className="capitalize text-gray-500">
            {hazard.status}
            {hazard.status === 'resolved' ? ' — Resolved' : ''}
          </div>
        </div>
      </Tooltip>
    </Marker>
  );
};
