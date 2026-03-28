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
  const color = BEHAVIOR_COLORS[behavior] ?? '#6b7280';
  const isResolved = crowd.status === 'resolved' || crowd.status === 'at_assembly';
  const mixedWounded = (conds.mixed_wounded as Array<Record<string, unknown>>) ?? [];
  const hasWounded = mixedWounded.length > 0;

  return new DivIcon({
    className: 'crowd-marker',
    html: `
      <div style="
        position: relative;
        width: 44px;
        height: 44px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: ${isDraggable ? 'grab' : 'pointer'};
        ${isResolved ? 'opacity: 0.5;' : ''}
      ">
        <div style="
          background-color: ${isResolved ? '#22c55e' : '#18181b'};
          width: 40px;
          height: 40px;
          border-radius: 8px;
          border: 3px solid ${color};
          box-shadow: 0 2px 10px rgba(0,0,0,0.4);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          font-size: 14px;
        ">
          <span>👥</span>
          <span style="font-size: 10px; font-weight: bold; color: white; line-height: 1;">${crowd.headcount}</span>
        </div>
        ${
          hasWounded
            ? `<div style="
          position: absolute; top: -4px; right: -4px;
          width: 16px; height: 16px; border-radius: 50%;
          background: #dc2626; border: 1px solid white;
          display: flex; align-items: center; justify-content: center;
          font-size: 8px;
        ">🩹</div>`
            : ''
        }
        ${
          isDraggable
            ? `<div style="
          position: absolute; bottom: -6px; left: 50%; transform: translateX(-50%);
          font-size: 8px; color: #22c55e; white-space: nowrap;
          text-shadow: 0 1px 2px black;
        ">drag</div>`
            : ''
        }
      </div>
    `,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    popupAnchor: [0, -22],
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
      <Tooltip>
        <div className="text-xs max-w-xs">
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
          {visibleDesc && (
            <div className="mt-1 text-gray-400 leading-tight">
              {visibleDesc.length > 180 ? visibleDesc.slice(0, 180) + '...' : visibleDesc}
            </div>
          )}
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
