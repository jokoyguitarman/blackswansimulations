import { Marker, Tooltip } from 'react-leaflet';
import { DivIcon } from 'leaflet';
import type { LatLngExpression } from 'leaflet';

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
}

interface HazardMarkerProps {
  hazard: HazardData;
  onClick: (hazard: HazardData) => void;
}

const HAZARD_ICONS: Record<string, { emoji: string; color: string }> = {
  fire: { emoji: '🔥', color: '#dc2626' },
  chemical_spill: { emoji: '☣️', color: '#a855f7' },
  structural_collapse: { emoji: '🏚️', color: '#78716c' },
  debris: { emoji: '🧱', color: '#92400e' },
  gas_leak: { emoji: '💨', color: '#eab308' },
  flood: { emoji: '🌊', color: '#0284c7' },
  biological: { emoji: '☢️', color: '#65a30d' },
  explosion: { emoji: '💥', color: '#ef4444' },
  electrical: { emoji: '⚡', color: '#f59e0b' },
  smoke: { emoji: '🌫️', color: '#6b7280' },
};

function getHazardVisual(type: string): { emoji: string; color: string } {
  return HAZARD_ICONS[type] ?? { emoji: '⚠️', color: '#f97316' };
}

function statusColor(status: string, baseColor: string): string {
  if (status === 'resolved') return '#22c55e';
  if (status === 'contained') return '#f97316';
  return baseColor;
}

function createHazardIcon(hazard: HazardData): DivIcon {
  const { emoji, color: baseColor } = getHazardVisual(hazard.hazard_type);
  const color = statusColor(hazard.status, baseColor);
  const isResolved = hazard.status === 'resolved';
  const size = 30;
  const displayEmoji = isResolved ? '✅' : emoji;

  return new DivIcon({
    className: 'hazard-marker',
    html: `<div style="
      background:${color};
      width:${size}px;height:${size}px;border-radius:50%;
      border:2px solid #fff;
      box-shadow:0 2px 6px rgba(0,0,0,.3);
      display:flex;align-items:center;justify-content:center;
      font-size:${Math.floor(size * 0.5)}px;line-height:1;
      cursor:pointer;
      ${isResolved ? 'opacity:0.6;' : ''}
    "><span style="filter:drop-shadow(0 0 1px rgba(0,0,0,.5))">${displayEmoji}</span></div>`,
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
          {hazard.fire_class && <div>Fire Class: {hazard.fire_class}</div>}
          {hazard.debris_type && <div>Debris: {hazard.debris_type}</div>}
          {hazard.properties.size != null && <div>Size: {String(hazard.properties.size)}</div>}
          {hazard.enriched_description && (
            <div className="mt-1 text-gray-400 leading-tight">{hazard.enriched_description}</div>
          )}
        </div>
      </Tooltip>
    </Marker>
  );
};
