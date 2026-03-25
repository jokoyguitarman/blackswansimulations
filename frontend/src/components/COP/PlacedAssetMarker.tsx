import { Marker, Popup, Polygon, Polyline, Tooltip } from 'react-leaflet';
import { DivIcon } from 'leaflet';
import type { LatLngExpression } from 'leaflet';

export interface PlacedAsset {
  id: string;
  session_id: string;
  team_name: string;
  placed_by: string;
  asset_type: string;
  label: string;
  geometry: {
    type: string;
    coordinates: unknown;
  };
  properties: Record<string, unknown>;
  placement_score: Record<string, unknown> | null;
  status: string;
  placed_at: string;
}

interface PlacedAssetMarkerProps {
  asset: PlacedAsset;
  isOwnTeam: boolean;
  onRemove?: (id: string) => void;
  onRelocate?: (id: string) => void;
}

const TEAM_COLORS: Record<string, string> = {
  evacuation: '#22c55e',
  triage: '#f59e0b',
  media: '#3b82f6',
  police: '#6366f1',
  fire: '#ef4444',
  command: '#0ea5e9',
};

function getTeamColor(teamName: string): string {
  const key = teamName.toLowerCase();
  for (const [k, v] of Object.entries(TEAM_COLORS)) {
    if (key.includes(k)) return v;
  }
  return '#a855f7';
}

const ASSET_ICONS: Record<string, string> = {
  triage_tent: '⛺',
  ambulance_staging: '🚑',
  decon_zone: '☢️',
  barrier: '🚧',
  marshal_post: '🧑',
  assembly_point: '🚩',
  press_cordon: '🚧',
  briefing_point: '🎤',
  camera_position: '📷',
  command_post: '🎯',
  field_hospital: '⚕️',
  helicopter_lz: '🚁',
  water_point: '💧',
  fire_truck_staging: '🚒',
  radio_relay: '📻',
  operational_area: '⬡',
};

function getAssetIcon(assetType: string): string {
  return ASSET_ICONS[assetType] ?? '📍';
}

function getScoreIndicator(score: Record<string, unknown> | null): {
  symbol: string;
  color: string;
} {
  if (!score) return { symbol: '✓', color: '#22c55e' };
  const overall = typeof score.overall === 'number' ? score.overall : null;
  if (overall !== null) {
    if (overall >= 0.7) return { symbol: '✓', color: '#22c55e' };
    if (overall >= 0.4) return { symbol: '!', color: '#f59e0b' };
    return { symbol: '✗', color: '#ef4444' };
  }
  // Fallback for legacy scores
  const numericVals = Object.values(score).filter((v): v is number => typeof v === 'number');
  if (!numericVals.length) return { symbol: '✓', color: '#22c55e' };
  const totalPenalty = numericVals.reduce((sum, v) => sum + Math.min(0, v), 0);
  if (totalPenalty < -0.3) return { symbol: '✗', color: '#ef4444' };
  if (totalPenalty < -0.1) return { symbol: '!', color: '#f59e0b' };
  return { symbol: '✓', color: '#22c55e' };
}

function createPlacedAssetIcon(asset: PlacedAsset, isOwnTeam: boolean): DivIcon {
  const color = getTeamColor(asset.team_name);
  const emoji = getAssetIcon(asset.asset_type);
  const scoreInd = getScoreIndicator(asset.placement_score);
  const opacity = isOwnTeam ? 1 : 0.75;

  return new DivIcon({
    className: 'placed-asset-marker',
    html: `
      <div style="
        position: relative;
        background-color: ${color};
        width: 36px;
        height: 36px;
        border-radius: 50%;
        border: 2px solid ${isOwnTeam ? 'white' : 'rgba(255,255,255,0.5)'};
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
        opacity: ${opacity};
        cursor: ${isOwnTeam ? 'grab' : 'default'};
      ">
        <span>${emoji}</span>
        <span style="
          position: absolute;
          top: -4px;
          right: -4px;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: ${scoreInd.color};
          color: white;
          font-size: 9px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: bold;
          border: 1px solid rgba(0,0,0,0.3);
        ">${scoreInd.symbol}</span>
      </div>
    `,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    popupAnchor: [0, -18],
  });
}

export const PlacedAssetMarker = ({
  asset,
  isOwnTeam,
  onRemove,
  onRelocate,
}: PlacedAssetMarkerProps) => {
  const geom = asset.geometry;

  if (geom.type === 'Polygon') {
    const coords = geom.coordinates as [number, number][][];
    if (!coords?.[0]?.length) return null;
    const positions: LatLngExpression[] = coords[0].map(
      ([lng, lat]) => [lat, lng] as LatLngExpression,
    );
    const color = getTeamColor(asset.team_name);
    const lengthM = asset.properties?.length_m as number | undefined;
    const areaM2 = asset.properties?.area_m2 as number | undefined;
    const enclosesCount = Array.isArray(asset.properties?.encloses)
      ? (asset.properties.encloses as string[]).length
      : 0;

    return (
      <Polygon
        positions={positions}
        pathOptions={{
          color,
          fillColor: color,
          fillOpacity: isOwnTeam ? 0.2 : 0.1,
          weight: 2,
          dashArray: isOwnTeam ? undefined : '6, 4',
        }}
      >
        <Tooltip sticky>
          <div className="text-xs">
            <div className="font-semibold">
              {getAssetIcon(asset.asset_type)} {asset.label}
            </div>
            <div className="text-gray-500">{asset.team_name}</div>
            {areaM2 != null && (
              <div className="text-gray-400 font-mono">
                {areaM2 >= 1_000_000
                  ? `${(areaM2 / 1_000_000).toFixed(2)} km²`
                  : areaM2 >= 10_000
                    ? `${(areaM2 / 10_000).toFixed(2)} ha`
                    : `${Math.round(areaM2)} m²`}
              </div>
            )}
            {lengthM != null && !areaM2 && (
              <div className="text-gray-400 font-mono">
                {lengthM >= 1000 ? `${(lengthM / 1000).toFixed(2)} km` : `${Math.round(lengthM)} m`}
              </div>
            )}
            {enclosesCount > 0 && (
              <div className="text-green-500 font-medium">
                {enclosesCount} asset{enclosesCount > 1 ? 's' : ''} enclosed
              </div>
            )}
          </div>
        </Tooltip>
        <Popup>
          <AssetPopupContent
            asset={asset}
            isOwnTeam={isOwnTeam}
            onRemove={onRemove}
            onRelocate={onRelocate}
          />
        </Popup>
      </Polygon>
    );
  }

  if (geom.type === 'LineString') {
    const coords = geom.coordinates as [number, number][];
    if (!coords?.length) return null;
    const positions: LatLngExpression[] = coords.map(
      ([lng, lat]) => [lat, lng] as LatLngExpression,
    );
    const color = getTeamColor(asset.team_name);
    const lengthM = asset.properties?.length_m as number | undefined;

    return (
      <Polyline
        positions={positions}
        pathOptions={{
          color,
          weight: 4,
          opacity: isOwnTeam ? 0.9 : 0.65,
          dashArray: isOwnTeam ? undefined : '8, 4',
        }}
      >
        <Tooltip sticky>
          <div className="text-xs">
            <div className="font-semibold">
              {getAssetIcon(asset.asset_type)} {asset.label}
            </div>
            <div className="text-gray-500">{asset.team_name}</div>
            {lengthM != null && (
              <div className="text-gray-400 font-mono">
                {lengthM >= 1000 ? `${(lengthM / 1000).toFixed(2)} km` : `${Math.round(lengthM)} m`}
              </div>
            )}
          </div>
        </Tooltip>
        <Popup>
          <AssetPopupContent
            asset={asset}
            isOwnTeam={isOwnTeam}
            onRemove={onRemove}
            onRelocate={onRelocate}
          />
        </Popup>
      </Polyline>
    );
  }

  // Default: Point
  const coords = geom.coordinates as [number, number];
  if (!coords?.length) return null;
  const position: LatLngExpression = [coords[1], coords[0]];
  const icon = createPlacedAssetIcon(asset, isOwnTeam);
  const capacity = asset.properties?.capacity as number | undefined;
  const capacityUnit = asset.properties?.capacity_unit as string | undefined;

  return (
    <Marker position={position} icon={icon} draggable={isOwnTeam}>
      {capacity != null && (
        <Tooltip direction="top" offset={[0, -20]} permanent className="capacity-tooltip">
          <span style={{ fontSize: '10px', fontFamily: 'monospace', fontWeight: 'bold' }}>
            {capacity} {capacityUnit ?? 'units'}
          </span>
        </Tooltip>
      )}
      <Popup>
        <AssetPopupContent
          asset={asset}
          isOwnTeam={isOwnTeam}
          onRemove={onRemove}
          onRelocate={onRelocate}
        />
      </Popup>
    </Marker>
  );
};

function AssetPopupContent({
  asset,
  isOwnTeam,
  onRemove,
  onRelocate,
}: {
  asset: PlacedAsset;
  isOwnTeam: boolean;
  onRemove?: (id: string) => void;
  onRelocate?: (id: string) => void;
}) {
  const scoreInd = getScoreIndicator(asset.placement_score);
  const placedTime = new Date(asset.placed_at).toLocaleTimeString();

  return (
    <div className="p-2 min-w-[160px] max-w-[240px]">
      <div className="text-sm font-semibold terminal-text text-robotic-yellow">{asset.label}</div>
      <div className="text-xs text-robotic-yellow/60 mt-0.5">{asset.team_name}</div>
      <div className="text-xs text-robotic-yellow/50 mt-0.5">Placed at {placedTime}</div>

      {asset.properties?.capacity != null && (
        <div className="mt-1.5 px-2 py-1 bg-robotic-yellow/10 border border-robotic-yellow/30 rounded text-xs">
          <div className="font-medium text-robotic-yellow">
            Capacity: {String(asset.properties.capacity)}{' '}
            {(asset.properties.capacity_unit as string) ?? 'units'}
          </div>
          {asset.properties.enclosed_area_m2 != null && (
            <div className="text-robotic-yellow/50 mt-0.5">
              Floor area: {Math.round(asset.properties.enclosed_area_m2 as number)} m²
            </div>
          )}
        </div>
      )}

      {Array.isArray(asset.properties?.encloses) &&
        (asset.properties.encloses as string[]).length > 0 && (
          <div className="mt-1 text-xs text-robotic-yellow/50">
            Encloses {(asset.properties.encloses as string[]).length} asset
            {(asset.properties.encloses as string[]).length > 1 ? 's' : ''}
          </div>
        )}

      {asset.placement_score && (
        <div className="mt-1.5 text-xs">
          <span style={{ color: scoreInd.color }} className="font-medium">
            {scoreInd.symbol === '✓'
              ? 'Good placement'
              : scoreInd.symbol === '!'
                ? 'Warnings'
                : 'Issues'}
            {typeof asset.placement_score.overall === 'number' && (
              <span className="ml-1">
                ({Math.round((asset.placement_score.overall as number) * 100)}%)
              </span>
            )}
          </span>
          {Array.isArray(asset.placement_score.dimensions) && (
            <ul className="mt-0.5 space-y-0.5">
              {(
                asset.placement_score.dimensions as Array<{
                  dimension: string;
                  score: number;
                  reasoning: string;
                }>
              ).map((dim) => (
                <li key={dim.dimension} className="text-robotic-yellow/60">
                  <span className="capitalize">{dim.dimension.replace(/_/g, ' ')}</span>:{' '}
                  <span
                    style={{
                      color:
                        dim.score >= 0.7 ? '#22c55e' : dim.score >= 0.4 ? '#f59e0b' : '#ef4444',
                    }}
                  >
                    {Math.round(dim.score * 100)}%
                  </span>
                  {dim.score < 0.7 && (
                    <span className="ml-1 text-robotic-yellow/40">— {dim.reasoning}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {isOwnTeam && (
        <div className="flex gap-2 mt-2">
          {onRelocate && (
            <button
              onClick={() => onRelocate(asset.id)}
              className="text-[10px] px-2 py-0.5 bg-robotic-yellow/20 border border-robotic-yellow/40 rounded text-robotic-yellow hover:bg-robotic-yellow/30"
            >
              Relocate
            </button>
          )}
          {onRemove && (
            <button
              onClick={() => onRemove(asset.id)}
              className="text-[10px] px-2 py-0.5 bg-red-500/20 border border-red-500/40 rounded text-red-400 hover:bg-red-500/30"
            >
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}
