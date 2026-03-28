import { Marker, Tooltip } from 'react-leaflet';
import { DivIcon } from 'leaflet';
import type { LatLngExpression } from 'leaflet';

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
  endorsed_to_triage: 'Endorsed to Triage',
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

  let emoji = '🧑';
  if (isDeceased) emoji = '💀';
  else if (isResolved) emoji = '✅';
  else if (mobility === 'trapped') emoji = '🆘';
  else if (mobility === 'non_ambulatory') emoji = '🛏️';

  return new DivIcon({
    className: 'casualty-marker',
    html: `
      <div style="
        position: relative;
        width: 36px;
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        ${isResolved ? 'opacity: 0.5;' : ''}
      ">
        <div style="
          background-color: ${isResolved ? '#22c55e' : isDeceased ? '#1f2937' : '#18181b'};
          width: 32px;
          height: 32px;
          border-radius: 50%;
          border: 3px solid ${isUnassessed && !isResolved && !isDeceased ? '#9ca3af' : color};
          box-shadow: 0 2px 8px rgba(0,0,0,0.4);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 15px;
          ${isUnassessed && !isResolved && !isDeceased ? 'animation: pulse 2s infinite;' : ''}
        ">
          <span>${emoji}</span>
        </div>
        ${
          mobility === 'trapped'
            ? `<div style="
          position: absolute; top: -3px; right: -3px;
          width: 14px; height: 14px; border-radius: 50%;
          background: #ef4444; border: 1px solid white;
          display: flex; align-items: center; justify-content: center;
          font-size: 8px; color: white; font-weight: bold;
        ">!</div>`
            : ''
        }
      </div>
    `,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    popupAnchor: [0, -18],
  });
}

export const CasualtyPin = ({ casualty, onClick }: CasualtyPinProps) => {
  const icon = createCasualtyIcon(casualty);
  const position: LatLngExpression = [casualty.location_lat, casualty.location_lng];
  const conds = casualty.conditions as Record<string, unknown>;
  const visibleDesc = (conds.visible_description as string) ?? '';
  const playerTag =
    (conds.player_triage_color as string | undefined) ??
    ((casualty as unknown as Record<string, unknown>).player_triage_color as string | undefined);
  const displayColor = playerTag ?? (conds.triage_color as string) ?? '';
  const mobility = (conds.mobility as string) ?? '';
  const accessibility = (conds.accessibility as string) ?? '';
  const consciousness = (conds.consciousness as string) ?? '';

  return (
    <Marker position={position} icon={icon} eventHandlers={{ click: () => onClick(casualty) }}>
      <Tooltip className="pin-tooltip">
        <div
          style={{ maxWidth: 320, whiteSpace: 'normal', wordWrap: 'break-word' }}
          className="text-xs"
        >
          <div className="font-semibold">
            Patient —{' '}
            {playerTag ? `${displayColor.toUpperCase()} (tagged)` : 'UNASSESSED — click to triage'}
          </div>
          <div className="capitalize text-gray-500">
            {STATUS_LABELS[casualty.status] ?? casualty.status}
          </div>
          {mobility && <div className="capitalize">Mobility: {mobility.replace(/_/g, ' ')}</div>}
          {accessibility && accessibility !== 'open' && (
            <div className="capitalize text-orange-400">
              Access: {accessibility.replace(/_/g, ' ')}
            </div>
          )}
          {consciousness && <div className="capitalize">Consciousness: {consciousness}</div>}
          {visibleDesc && <div className="mt-1 text-gray-400 leading-tight">{visibleDesc}</div>}
        </div>
      </Tooltip>
    </Marker>
  );
};
