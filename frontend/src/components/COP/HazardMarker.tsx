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
};

function getHazardVisual(type: string): { emoji: string; color: string } {
  return HAZARD_ICONS[type] ?? { emoji: '⚠️', color: '#f97316' };
}

function createHazardIcon(hazard: HazardData): DivIcon {
  const { emoji, color } = getHazardVisual(hazard.hazard_type);
  const isActive = hazard.status === 'active' || hazard.status === 'escalating';
  const pulseClass = isActive ? 'hazard-pulse' : '';

  return new DivIcon({
    className: `hazard-marker ${pulseClass}`,
    html: `
      <div style="
        position: relative;
        width: 40px;
        height: 40px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
      ">
        ${
          isActive
            ? `<div style="
          position: absolute;
          inset: -4px;
          border-radius: 50%;
          border: 2px solid ${color};
          opacity: 0.4;
          animation: hazardPulse 2s ease-in-out infinite;
        "></div>`
            : ''
        }
        <div style="
          background-color: ${color};
          width: 36px;
          height: 36px;
          border-radius: 50%;
          border: 3px solid ${hazard.status === 'escalating' ? '#fff' : 'rgba(255,255,255,0.7)'};
          box-shadow: 0 2px 10px rgba(0,0,0,0.5), 0 0 20px ${color}40;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 18px;
        ">
          <span>${emoji}</span>
        </div>
        ${
          hazard.status === 'escalating'
            ? `<div style="
          position: absolute;
          top: -2px;
          right: -2px;
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: #ef4444;
          border: 1px solid white;
          animation: hazardPulse 1s ease-in-out infinite;
        "></div>`
            : ''
        }
      </div>
      <style>
        @keyframes hazardPulse {
          0%, 100% { transform: scale(1); opacity: 0.4; }
          50% { transform: scale(1.3); opacity: 0.1; }
        }
      </style>
    `,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    popupAnchor: [0, -20],
  });
}

export const HazardMarker = ({ hazard, onClick }: HazardMarkerProps) => {
  const icon = createHazardIcon(hazard);
  const position: LatLngExpression = [hazard.location_lat, hazard.location_lng];

  return (
    <Marker position={position} icon={icon} eventHandlers={{ click: () => onClick(hazard) }}>
      <Tooltip>
        <div className="text-xs">
          <div className="font-semibold capitalize">{hazard.hazard_type.replace(/_/g, ' ')}</div>
          <div className="capitalize text-gray-500">{hazard.status}</div>
          {hazard.properties.size && <div>Size: {String(hazard.properties.size)}</div>}
        </div>
      </Tooltip>
    </Marker>
  );
};
