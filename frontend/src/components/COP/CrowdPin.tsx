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

const CONVERGENT_ORIGIN_ICONS: Record<string, string> = {
  onlooker: '👀',
  media: '📷',
  family: '💔',
  helper: '🤝',
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
    emoji = CONVERGENT_ORIGIN_ICONS[crowdOrigin] ?? '🚶';
  } else {
    const color = BEHAVIOR_COLORS[behavior] ?? '#8b5cf6';
    bgColor = isResolved ? '#22c55e' : color;
    emoji = '👥';
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
      font-size:${Math.floor(size * 0.45)}px;line-height:1;
      cursor:${isDraggable ? 'grab' : 'pointer'};
      ${isResolved ? 'opacity:0.5;' : ''}
    "><span style="filter:drop-shadow(0 0 1px rgba(0,0,0,.5))">${emoji}</span></div>`,
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
  const crowdOrigin = (conds.crowd_origin as string) ?? '';
  const obstructionRisk = (conds.obstruction_risk as string) ?? '';

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
          {crowd.casualty_type === 'convergent_crowd' ? (
            <>
              <div className="font-semibold capitalize">
                {crowdOrigin || 'Convergent'} — {crowd.headcount} people
              </div>
              <div className="capitalize text-gray-500">{crowd.status}</div>
              {behavior && <div className="capitalize">Behavior: {behavior}</div>}
              {obstructionRisk && obstructionRisk !== 'low' && (
                <div
                  className={`font-semibold ${obstructionRisk === 'high' ? 'text-red-400' : 'text-yellow-400'}`}
                >
                  Obstruction risk: {obstructionRisk}
                </div>
              )}
            </>
          ) : (
            <>
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
            </>
          )}
          {visibleDesc && <div className="mt-1 text-gray-400 leading-tight">{visibleDesc}</div>}
          {!isDraggable && crowd.status === 'identified' && (
            <div className="mt-1 text-gray-500 italic">
              {crowd.casualty_type === 'convergent_crowd'
                ? 'Approaching the incident area'
                : 'Place marshals nearby to enable movement'}
            </div>
          )}
        </div>
      </Tooltip>
    </Marker>
  );
};
