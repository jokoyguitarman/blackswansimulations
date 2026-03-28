import { Marker, Popup, Tooltip } from 'react-leaflet';
import { DivIcon } from 'leaflet';
import type { LatLngExpression } from 'leaflet';
import { useState } from 'react';

export interface EntryExitData {
  id: string;
  label: string;
  location_type: string;
  coordinates: { lat: number; lng: number };
  conditions: Record<string, unknown>;
  claimable_by: string[];
  claimed_by_team: string | null;
  claimed_as: string | null;
}

interface EntryExitPinProps {
  location: EntryExitData;
  currentTeam: string;
  teamNames: string[];
  onClaim: (locationId: string, teamName: string, claimedAs: string) => void;
}

const CLAIM_OPTIONS = [
  { value: 'evacuation_exit', label: 'Evacuation Exit' },
  { value: 'fire_team_entry', label: 'Fire Team Entry' },
  { value: 'medical_entry', label: 'Medical Entry' },
  { value: 'command_access', label: 'Command Access' },
  { value: 'media_access', label: 'Media Access Point' },
  { value: 'supply_entry', label: 'Supply Entry' },
];

function createEntryExitIcon(location: EntryExitData): DivIcon {
  const isClaimed = !!location.claimed_by_team;
  const color = isClaimed ? '#3b82f6' : '#6b7280';

  return new DivIcon({
    className: 'entry-exit-marker',
    html: `
      <div style="
        position: relative;
        width: 36px;
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
      ">
        <div style="
          background-color: ${isClaimed ? '#1e40af' : '#374151'};
          width: 32px;
          height: 32px;
          border-radius: 6px;
          border: 2px solid ${color};
          box-shadow: 0 2px 8px rgba(0,0,0,0.4);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 16px;
        ">
          <span>${isClaimed ? '🚪' : '🚧'}</span>
        </div>
        ${
          isClaimed
            ? `<div style="
          position: absolute; bottom: -8px; left: 50%; transform: translateX(-50%);
          font-size: 7px; color: #93c5fd; white-space: nowrap;
          text-shadow: 0 1px 2px black; font-weight: bold;
          max-width: 60px; overflow: hidden; text-overflow: ellipsis;
        ">${location.claimed_as?.replace(/_/g, ' ') ?? ''}</div>`
            : ''
        }
      </div>
    `,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    popupAnchor: [0, -18],
  });
}

export const EntryExitPin = ({ location, currentTeam, onClaim }: EntryExitPinProps) => {
  const icon = createEntryExitIcon(location);
  const position: LatLngExpression = [location.coordinates.lat, location.coordinates.lng];
  const isClaimed = !!location.claimed_by_team;
  const [selectedClaim, setSelectedClaim] = useState(CLAIM_OPTIONS[0].value);
  const conds = location.conditions;
  const exitType = (conds.exit_type as string) ?? '';
  const widthM = conds.width_m as number | undefined;
  const flowRate = conds.capacity_flow_per_min as number | undefined;

  return (
    <Marker position={position} icon={icon}>
      <Tooltip>
        <div className="text-xs max-w-xs">
          <div className="font-semibold">{location.label}</div>
          {exitType && <div className="capitalize">{exitType.replace(/_/g, ' ')}</div>}
          {widthM != null && <div>Width: {widthM}m</div>}
          {flowRate != null && <div>Flow rate: {flowRate}/min</div>}
          {isClaimed ? (
            <div className="text-blue-400 mt-1">
              Claimed by {location.claimed_by_team} as {location.claimed_as?.replace(/_/g, ' ')}
            </div>
          ) : (
            <div className="text-gray-400 mt-1 italic">Click to claim</div>
          )}
        </div>
      </Tooltip>
      {!isClaimed && (
        <Popup>
          <div className="text-sm min-w-[180px]">
            <div className="font-semibold mb-2">{location.label}</div>
            <div className="text-xs text-gray-500 mb-2">Assign this point for your team</div>
            <select
              className="w-full p-1 text-xs border border-gray-600 rounded bg-gray-800 text-white mb-2"
              value={selectedClaim}
              onChange={(e) => setSelectedClaim(e.target.value)}
            >
              {CLAIM_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button
              className="w-full px-2 py-1 text-xs font-semibold rounded bg-blue-600 hover:bg-blue-500 text-white"
              onClick={() => onClaim(location.id, currentTeam, selectedClaim)}
            >
              Claim as {currentTeam}
            </button>
          </div>
        </Popup>
      )}
    </Marker>
  );
};
