import { Marker, Tooltip } from 'react-leaflet';
import { DivIcon } from 'leaflet';
import type { LatLngExpression } from 'leaflet';
import { svg } from './mapIcons';

export interface CrowdData {
  id: string;
  casualty_type: string;
  location_lat: number;
  location_lng: number;
  floor_level: string;
  headcount: number;
  conditions: Record<string, unknown>;
  status: string;
  assigned_team: string | null;
  appears_at_minutes: number;
  updated_at: string;
}

interface CrowdPinProps {
  crowd: CrowdData;
  onClick: (crowd: CrowdData) => void;
  isDraggable?: boolean;
  onDragEnd?: (crowd: CrowdData, newLat: number, newLng: number) => void;
}

const BEHAVIOR_COLORS: Record<string, string> = {
  calm: '#22c55e',
  anxious: '#eab308',
  panicking: '#ef4444',
  sheltering: '#3b82f6',
  fleeing: '#f97316',
};

const CONVERGENT_ORIGIN_ICONS: Record<string, string> = {
  onlooker: svg('eye'),
  media: svg('camera'),
  family: svg('heart_broken'),
  helper: svg('handshake'),
};

const CONVERGENT_ORIGIN_COLORS: Record<string, string> = {
  onlooker: '#a855f7',
  media: '#06b6d4',
  family: '#ec4899',
  helper: '#f59e0b',
};

function createCrowdIcon(crowd: CrowdData, isDraggable: boolean): DivIcon {
  const conds = crowd.conditions as Record<string, unknown>;
  const behavior = (conds.behavior as string) ?? 'calm';
  const isConvergent = crowd.casualty_type === 'convergent_crowd';
  const crowdOrigin = (conds.crowd_origin as string) ?? '';
  const isResolved = crowd.status === 'resolved' || crowd.status === 'at_assembly';

  let bgColor: string;
  let emoji: string;
  if (isConvergent) {
    bgColor = isResolved ? '#22c55e' : (CONVERGENT_ORIGIN_COLORS[crowdOrigin] ?? '#a855f7');
    emoji = CONVERGENT_ORIGIN_ICONS[crowdOrigin] ?? svg('person');
  } else {
    const color = BEHAVIOR_COLORS[behavior] ?? '#8b5cf6';
    bgColor = isResolved ? '#22c55e' : color;
    emoji = svg('crowd');
  }

  const size = Math.min(36, 24 + Math.floor(crowd.headcount / 15));
  const borderStyle = isConvergent ? '2px dashed #fff' : '2px solid #fff';

  return new DivIcon({
    className: 'crowd-marker',
    html: `<div style="
      background:${bgColor};
      width:${size}px;height:${size}px;border-radius:50%;
      border:${borderStyle};
      box-shadow:0 2px 6px rgba(0,0,0,.3);
      display:flex;align-items:center;justify-content:center;
      cursor:${isDraggable ? 'grab' : 'pointer'};
      ${isResolved ? 'opacity:0.5;' : ''}
    ">${emoji}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -(size / 2)],
  });
}

export const CrowdPin = ({ crowd, onClick, isDraggable = false, onDragEnd }: CrowdPinProps) => {
  const icon = createCrowdIcon(crowd, isDraggable);
  const position: LatLngExpression = [crowd.location_lat, crowd.location_lng];
  const conds = crowd.conditions as Record<string, unknown>;
  const crowdOrigin = (conds.crowd_origin as string) ?? '';

  return (
    <Marker
      position={position}
      icon={icon}
      draggable={isDraggable}
      eventHandlers={{
        click: () => onClick(crowd),
        dragend: (e) => {
          if (onDragEnd) {
            const { lat, lng } = e.target.getLatLng();
            onDragEnd(crowd, lat, lng);
          }
        },
      }}
    >
      <Tooltip className="pin-tooltip">
        <div className="text-xs">
          <div className="font-semibold">
            {crowd.casualty_type === 'convergent_crowd'
              ? `${crowdOrigin || 'Convergent'} — ${crowd.headcount}`
              : `Crowd — ${crowd.headcount}`}
          </div>
          <div className="capitalize text-gray-500">{crowd.status}</div>
        </div>
      </Tooltip>
    </Marker>
  );
};
