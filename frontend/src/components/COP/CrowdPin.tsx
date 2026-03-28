import { Marker, Tooltip } from 'react-leaflet';
import { DivIcon } from 'leaflet';
import type { LatLngExpression } from 'leaflet';

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

function createCrowdIcon(crowd: CrowdData, isDraggable: boolean): DivIcon {
  const conds = crowd.conditions as Record<string, unknown>;
  const behavior = (conds.behavior as string) ?? 'calm';
  const color = BEHAVIOR_COLORS[behavior] ?? '#8b5cf6';
  const isResolved = crowd.status === 'resolved' || crowd.status === 'at_assembly';
  const bgColor = isResolved ? '#22c55e' : color;
  const size = Math.min(36, 24 + Math.floor(crowd.headcount / 15));

  return new DivIcon({
    className: 'crowd-marker',
    html: `<div style="
      background:${bgColor};
      width:${size}px;height:${size}px;border-radius:50%;
      border:2px solid #fff;
      box-shadow:0 2px 6px rgba(0,0,0,.3);
      display:flex;align-items:center;justify-content:center;
      font-size:${Math.floor(size * 0.45)}px;line-height:1;
      cursor:${isDraggable ? 'grab' : 'pointer'};
      ${isResolved ? 'opacity:0.5;' : ''}
    "><span style="filter:drop-shadow(0 0 1px rgba(0,0,0,.5))">👥</span></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -(size / 2)],
  });
}

export const CrowdPin = ({ crowd, onClick, isDraggable = false, onDragEnd }: CrowdPinProps) => {
  const icon = createCrowdIcon(crowd, isDraggable);
  const position: LatLngExpression = [crowd.location_lat, crowd.location_lng];
  const conds = crowd.conditions as Record<string, unknown>;
  const behavior = (conds.behavior as string) ?? '';
  const movement = (conds.movement_direction as string) ?? '';
  const visibleDesc = (conds.visible_description as string) ?? '';
  const mixedWounded = (conds.mixed_wounded as Array<Record<string, unknown>>) ?? [];
  const bottleneck = conds.bottleneck as boolean;

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
          <div className="font-semibold">Crowd — {crowd.headcount} people</div>
          <div className="capitalize text-gray-500">{crowd.status}</div>
          {behavior && <div className="capitalize">Behavior: {behavior}</div>}
          {movement && <div>Movement: {movement}</div>}
          {bottleneck && <div className="text-red-400 font-semibold">Bottleneck!</div>}
          {mixedWounded.length > 0 && (
            <div className="text-orange-400">
              Walking wounded:{' '}
              {mixedWounded.reduce((sum, w) => sum + ((w.count as number) ?? 0), 0)}
            </div>
          )}
          {visibleDesc && <div className="mt-1 text-gray-400 leading-tight">{visibleDesc}</div>}
          {!isDraggable && crowd.status === 'identified' && (
            <div className="mt-1 text-gray-500 italic">
              Place marshals nearby to enable movement
            </div>
          )}
        </div>
      </Tooltip>
    </Marker>
  );
};
