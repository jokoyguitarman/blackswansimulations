import { Marker, Tooltip } from 'react-leaflet';
import { DivIcon } from 'leaflet';
import type { LatLngExpression } from 'leaflet';
import { svg } from './mapIcons';

export interface CasualtyData {
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

interface CasualtyPinProps {
  casualty: CasualtyData;
  onClick: (casualty: CasualtyData) => void;
}

const TRIAGE_COLORS: Record<string, string> = {
  green: '#22c55e',
  yellow: '#eab308',
  red: '#dc2626',
  black: '#1f2937',
};

const STATUS_LABELS: Record<string, string> = {
  undiscovered: 'Undiscovered',
  identified: 'Identified',
  being_evacuated: 'Being Evacuated',
  at_assembly: 'At Assembly',
  awaiting_triage: 'Awaiting Medical Triage',
  endorsed_to_triage: 'Endorsed to Medical Triage',
  in_treatment: 'In Treatment',
  endorsed_to_transport: 'Ready for Transport',
  transported: 'Transported',
  resolved: 'Resolved',
  deceased: 'Deceased',
};

function createCasualtyIcon(casualty: CasualtyData): DivIcon {
  const conds = casualty.conditions as Record<string, unknown>;
  const playerTag =
    (conds.player_triage_color as string | undefined) ??
    ((casualty as unknown as Record<string, unknown>).player_triage_color as string | undefined);
  const triageColor = playerTag ?? (conds.triage_color as string) ?? 'yellow';
  const color = TRIAGE_COLORS[triageColor] ?? '#eab308';
  const isUnassessed = !playerTag;
  const mobility = (conds.mobility as string) ?? 'ambulatory';
  const isResolved = casualty.status === 'resolved' || casualty.status === 'transported';
  const isDeceased = casualty.status === 'deceased';

  let icon = svg('person');
  if (isDeceased) icon = svg('deceased');
  else if (isResolved) icon = svg('resolved');
  else if (mobility === 'trapped') icon = svg('person_trapped');
  else if (mobility === 'non_ambulatory') icon = svg('stretcher');

  const bgColor = isResolved
    ? '#22c55e'
    : isDeceased
      ? '#1f2937'
      : isUnassessed
        ? '#9ca3af'
        : color;
  const size = 28;

  return new DivIcon({
    className: 'casualty-marker',
    html: `<div style="
      background:${bgColor};
      width:${size}px;height:${size}px;border-radius:50%;
      border:2px solid #fff;
      box-shadow:0 2px 6px rgba(0,0,0,.3);
      display:flex;align-items:center;justify-content:center;
      cursor:pointer;
      ${isResolved ? 'opacity:0.5;' : ''}
      ${isUnassessed && !isResolved && !isDeceased ? 'animation:pulse 2s infinite;' : ''}
    ">${icon}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -(size / 2)],
  });
}

export const CasualtyPin = ({ casualty, onClick }: CasualtyPinProps) => {
  const icon = createCasualtyIcon(casualty);
  const position: LatLngExpression = [casualty.location_lat, casualty.location_lng];
  const conds = casualty.conditions as Record<string, unknown>;
  const playerTag =
    (conds.player_triage_color as string | undefined) ??
    ((casualty as unknown as Record<string, unknown>).player_triage_color as string | undefined);
  const displayColor = playerTag ?? (conds.triage_color as string) ?? '';

  return (
    <Marker position={position} icon={icon} eventHandlers={{ click: () => onClick(casualty) }}>
      <Tooltip className="pin-tooltip">
        <div className="text-xs">
          <div className="font-semibold">
            {playerTag ? `${displayColor.toUpperCase()}` : 'UNASSESSED'}
          </div>
          <div className="capitalize text-gray-500">
            {STATUS_LABELS[casualty.status] ?? casualty.status}
          </div>
        </div>
      </Tooltip>
    </Marker>
  );
};
