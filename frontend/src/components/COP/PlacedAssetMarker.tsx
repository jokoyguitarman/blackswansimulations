import { useRef, useCallback } from 'react';
import { Marker, Popup, Polygon, Polyline, Tooltip } from 'react-leaflet';
import { DivIcon } from 'leaflet';
import type { LatLngExpression } from 'leaflet';
import { svg } from './mapIcons';

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
  isDraggable?: boolean;
  /** When true, disables interactivity so map click events pass through (for polygon drawing). */
  drawingActive?: boolean;
  /** When true, applies entrance animations (drop-in for points, draw for lines/polygons). */
  isNew?: boolean;
  /** Cross-team interaction callback (e.g. bomb squad sweep). Triggers the response panel. */
  onInteract?: (asset: PlacedAsset) => void;
  onRemove?: (id: string) => void;
  onRelocate?: (id: string) => void;
  onDragEnd?: (id: string, newLat: number, newLng: number) => void;
  onGeometryDragEnd?: (id: string, newGeometry: { type: string; coordinates: unknown }) => void;
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
  triage_tent: svg('tent'),
  ambulance_staging: svg('ambulance'),
  decon_zone: svg('chemical'),
  barrier: svg('barrier'),
  marshal_post: svg('marshal'),
  triage_officer: svg('triage_officer'),
  media_liaison: svg('media_officer'),
  firefighter_post: svg('firefighter'),
  assembly_point: svg('flag'),
  press_cordon: svg('barrier'),
  briefing_point: svg('broadcast'),
  camera_position: svg('camera'),
  command_post: svg('command'),
  field_hospital: svg('medical_cross'),
  helicopter_lz: svg('helicopter'),
  water_point: svg('water'),
  fire_truck_staging: svg('fire_truck'),
  radio_relay: svg('radio'),
  operational_area: svg('hexagon'),
  hazard_zone: svg('hazard_generic'),
};

function getAssetIcon(assetType: string): string {
  return ASSET_ICONS[assetType] ?? svg('pin');
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

function computeCentroid(positions: [number, number][]): [number, number] {
  if (!positions.length) return [0, 0];
  let latSum = 0,
    lngSum = 0;
  for (const [lat, lng] of positions) {
    latSum += lat;
    lngSum += lng;
  }
  return [latSum / positions.length, lngSum / positions.length];
}

function createPolygonLabelIcon(label: string, color: string): DivIcon {
  const truncated = label.length > 24 ? label.slice(0, 22) + '…' : label;
  return new DivIcon({
    className: 'polygon-label-icon',
    html: `
      <div style="
        white-space: nowrap;
        background: ${color}dd;
        color: white;
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.5px;
        padding: 2px 6px;
        border-radius: 3px;
        border: 1px solid rgba(255,255,255,0.5);
        box-shadow: 0 1px 4px rgba(0,0,0,0.4);
        text-transform: uppercase;
        pointer-events: none;
      ">${truncated}</div>
    `,
    iconSize: [0, 0],
    iconAnchor: [0, 8],
  });
}

function createDragHandleIcon(color: string): DivIcon {
  return new DivIcon({
    className: 'polygon-drag-handle',
    html: `
      <div style="
        width: 28px; height: 28px; border-radius: 50%;
        background: ${color}; border: 2px solid white;
        box-shadow: 0 2px 8px rgba(0,0,0,0.5);
        display: flex; align-items: center; justify-content: center;
        cursor: grab;
      ">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="white">
          <path d="M8 1l3 3H9v3h3V5l3 3-3 3V9H9v3h2l-3 3-3-3h2V9H4v2l-3-3 3-3v2h3V4H5l3-3z"/>
        </svg>
      </div>
    `,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function createPlacedAssetIcon(
  asset: PlacedAsset,
  isOwnTeam: boolean,
  isNew: boolean = false,
): DivIcon {
  const color = getTeamColor(asset.team_name);
  const iconSvg = getAssetIcon(asset.asset_type);
  const scoreInd = getScoreIndicator(asset.placement_score);
  const opacity = isOwnTeam ? 1 : 0.75;

  return new DivIcon({
    className: `placed-asset-marker${isNew ? ' is-new' : ''}`,
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
        opacity: ${opacity};
        cursor: ${isOwnTeam ? 'grab' : 'default'};
      ">
        ${iconSvg}
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
  isDraggable = false,
  drawingActive = false,
  isNew = false,
  onInteract,
  onRemove,
  onRelocate,
  onDragEnd,
  onGeometryDragEnd,
}: PlacedAssetMarkerProps) => {
  const geom = asset.geometry;
  const centroidRef = useRef<[number, number]>([0, 0]);

  const handlePolygonDrag = useCallback(
    (e: { target: { getLatLng: () => { lat: number; lng: number } } }) => {
      if (!onGeometryDragEnd) return;
      const { lat: newLat, lng: newLng } = e.target.getLatLng();
      const [oldLat, oldLng] = centroidRef.current;
      const dLat = newLat - oldLat;
      const dLng = newLng - oldLng;

      if (geom.type === 'Polygon') {
        const coords = geom.coordinates as [number, number][][];
        const newCoords = coords.map((ring) =>
          ring.map(([lng, lat]) => [lng + dLng, lat + dLat] as [number, number]),
        );
        onGeometryDragEnd(asset.id, { type: 'Polygon', coordinates: newCoords });
      } else if (geom.type === 'LineString') {
        const coords = geom.coordinates as [number, number][];
        const newCoords = coords.map(([lng, lat]) => [lng + dLng, lat + dLat] as [number, number]);
        onGeometryDragEnd(asset.id, { type: 'LineString', coordinates: newCoords });
      }
    },
    [asset.id, geom, onGeometryDragEnd],
  );

  if (geom.type === 'Polygon') {
    const coords = geom.coordinates as [number, number][][];
    if (!coords?.[0]?.length) return null;
    const positions: LatLngExpression[] = coords[0].map(
      ([lng, lat]) => [lat, lng] as LatLngExpression,
    );

    const latLngPairs = coords[0].map(([lng, lat]) => [lat, lng] as [number, number]);
    const centroid = computeCentroid(latLngPairs);
    centroidRef.current = centroid;

    const canDrag = isDraggable && isOwnTeam && !drawingActive && !!onGeometryDragEnd;
    const color = getTeamColor(asset.team_name);

    const ZONE_TYPES: Record<string, string> = {
      hazard_zone: '',
      hot_zone: 'hot',
      warm_zone: 'warm',
      cold_zone: 'cold',
    };
    if (asset.asset_type in ZONE_TYPES) {
      const classification =
        (asset.properties?.zone_classification as string | undefined) ||
        ZONE_TYPES[asset.asset_type];
      const zoneColors: Record<string, { fill: string; border: string; label: string }> = {
        hot: { fill: '#dc2626', border: '#dc2626', label: 'HOT ZONE' },
        warm: { fill: '#f59e0b', border: '#f59e0b', label: 'WARM ZONE' },
        cold: { fill: '#22c55e', border: '#22c55e', label: 'COLD ZONE' },
      };
      const zone = classification ? zoneColors[classification] : undefined;
      const fillColor = zone?.fill ?? '#94a3b8';
      const borderColor = zone?.border ?? '#94a3b8';

      return (
        <>
          <Polygon
            positions={positions}
            interactive={!drawingActive}
            bubblingMouseEvents={drawingActive}
            pathOptions={{
              color: borderColor,
              fillColor,
              fillOpacity:
                classification === 'hot' ? 0.18 : classification === 'warm' ? 0.13 : 0.08,
              weight: 2,
              dashArray: '10, 6',
            }}
          >
            {!drawingActive && (
              <Popup autoPan={false}>
                <AssetPopupContent
                  asset={asset}
                  isOwnTeam={isOwnTeam}
                  onInteract={onInteract}
                  onRemove={onRemove}
                  onRelocate={onRelocate}
                />
              </Popup>
            )}
          </Polygon>
          {!drawingActive && (
            <Marker
              position={centroid as LatLngExpression}
              icon={createPolygonLabelIcon(zone?.label || asset.label, borderColor)}
              interactive={false}
            />
          )}
          {canDrag && (
            <Marker
              position={centroid as LatLngExpression}
              icon={createDragHandleIcon(borderColor)}
              draggable
              eventHandlers={{ dragend: handlePolygonDrag }}
            >
              <Tooltip direction="top" offset={[0, -14]}>
                <span style={{ fontSize: 10 }}>Drag to move zone</span>
              </Tooltip>
            </Marker>
          )}
        </>
      );
    }

    const lengthM = asset.properties?.length_m as number | undefined;
    const areaM2 = asset.properties?.area_m2 as number | undefined;
    const enclosesCount = Array.isArray(asset.properties?.encloses)
      ? (asset.properties.encloses as string[]).length
      : 0;

    return (
      <>
        <Polygon
          positions={positions}
          interactive={!drawingActive}
          bubblingMouseEvents={drawingActive}
          pathOptions={{
            color,
            fillColor: color,
            fillOpacity: isOwnTeam ? 0.2 : 0.1,
            weight: 2,
            dashArray: isOwnTeam ? undefined : '6, 4',
            className: isNew ? 'demo-draw-line demo-fill-reveal' : undefined,
          }}
        >
          {!drawingActive && (
            <>
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
                      {lengthM >= 1000
                        ? `${(lengthM / 1000).toFixed(2)} km`
                        : `${Math.round(lengthM)} m`}
                    </div>
                  )}
                  {enclosesCount > 0 && (
                    <div className="text-green-500 font-medium">
                      {enclosesCount} asset{enclosesCount > 1 ? 's' : ''} enclosed
                    </div>
                  )}
                </div>
              </Tooltip>
              <Popup autoPan={false}>
                <AssetPopupContent
                  asset={asset}
                  isOwnTeam={isOwnTeam}
                  onInteract={onInteract}
                  onRemove={onRemove}
                  onRelocate={onRelocate}
                />
              </Popup>
            </>
          )}
        </Polygon>
        {!drawingActive && (
          <Marker
            position={centroid as LatLngExpression}
            icon={createPolygonLabelIcon(asset.label, color)}
            interactive={false}
          />
        )}
        {canDrag && (
          <Marker
            position={centroid as LatLngExpression}
            icon={createDragHandleIcon(color)}
            draggable
            eventHandlers={{ dragend: handlePolygonDrag }}
          >
            <Tooltip direction="top" offset={[0, -14]}>
              <span style={{ fontSize: 10 }}>Drag to move</span>
            </Tooltip>
          </Marker>
        )}
      </>
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

    const latLngPairs = coords.map(([lng, lat]) => [lat, lng] as [number, number]);
    const centroid = computeCentroid(latLngPairs);
    centroidRef.current = centroid;
    const canDrag = isDraggable && isOwnTeam && !drawingActive && !!onGeometryDragEnd;

    return (
      <>
        <Polyline
          positions={positions}
          interactive={!drawingActive}
          bubblingMouseEvents={drawingActive}
          pathOptions={{
            color,
            weight: 4,
            opacity: isOwnTeam ? 0.9 : 0.65,
            dashArray: isOwnTeam ? undefined : '8, 4',
            className: isNew ? 'demo-draw-line' : undefined,
          }}
        >
          {!drawingActive && (
            <>
              <Tooltip sticky>
                <div className="text-xs">
                  <div className="font-semibold">
                    {getAssetIcon(asset.asset_type)} {asset.label}
                  </div>
                  <div className="text-gray-500">{asset.team_name}</div>
                  {lengthM != null && (
                    <div className="text-gray-400 font-mono">
                      {lengthM >= 1000
                        ? `${(lengthM / 1000).toFixed(2)} km`
                        : `${Math.round(lengthM)} m`}
                    </div>
                  )}
                </div>
              </Tooltip>
              <Popup autoPan={false}>
                <AssetPopupContent
                  asset={asset}
                  isOwnTeam={isOwnTeam}
                  onInteract={onInteract}
                  onRemove={onRemove}
                  onRelocate={onRelocate}
                />
              </Popup>
            </>
          )}
        </Polyline>
        {canDrag && (
          <Marker
            position={centroid as LatLngExpression}
            icon={createDragHandleIcon(color)}
            draggable
            eventHandlers={{ dragend: handlePolygonDrag }}
          >
            <Tooltip direction="top" offset={[0, -14]}>
              <span style={{ fontSize: 10 }}>Drag to move</span>
            </Tooltip>
          </Marker>
        )}
      </>
    );
  }

  // Default: Point
  const coords = geom.coordinates as [number, number];
  if (!coords?.length) return null;
  const position: LatLngExpression = [coords[1], coords[0]];
  const icon = createPlacedAssetIcon(asset, isOwnTeam, isNew);
  const capacity = asset.properties?.capacity as number | undefined;
  const capacityUnit = asset.properties?.capacity_unit as string | undefined;

  return (
    <Marker
      position={position}
      icon={icon}
      draggable={drawingActive ? false : isDraggable}
      interactive={!drawingActive}
      bubblingMouseEvents={drawingActive}
      eventHandlers={{
        dragend: (e) => {
          if (onDragEnd) {
            const { lat, lng } = e.target.getLatLng();
            onDragEnd(asset.id, lat, lng);
          }
        },
      }}
    >
      {!drawingActive && capacity != null && (
        <Tooltip direction="top" offset={[0, -20]} permanent className="capacity-tooltip">
          <span style={{ fontSize: '10px', fontFamily: 'monospace', fontWeight: 'bold' }}>
            {capacity} {capacityUnit ?? 'units'}
          </span>
        </Tooltip>
      )}
      {!drawingActive && (
        <Popup autoPan={false}>
          <AssetPopupContent
            asset={asset}
            isOwnTeam={isOwnTeam}
            onInteract={onInteract}
            onRemove={onRemove}
            onRelocate={onRelocate}
          />
        </Popup>
      )}
    </Marker>
  );
};

function AssetPopupContent({
  asset,
  isOwnTeam,
  onInteract,
  onRemove,
  onRelocate,
}: {
  asset: PlacedAsset;
  isOwnTeam: boolean;
  onInteract?: (asset: PlacedAsset) => void;
  onRemove?: (id: string) => void;
  onRelocate?: (id: string) => void;
}) {
  return (
    <div className="p-2 min-w-[140px] max-w-[200px]">
      <div className="text-sm font-semibold terminal-text text-robotic-yellow">{asset.label}</div>
      <div className="text-xs text-robotic-yellow/60 mt-0.5">{asset.team_name}</div>

      {asset.properties?.capacity != null && (
        <div className="mt-1.5 text-xs font-medium text-robotic-yellow">
          Capacity: {String(asset.properties.capacity)}{' '}
          {(asset.properties.capacity_unit as string) ?? 'units'}
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

      {onInteract && (
        <div className="mt-2">
          <button
            onClick={() => onInteract(asset)}
            className="w-full text-[10px] px-2 py-1 bg-amber-500/20 border border-amber-500/50 rounded text-amber-300 hover:bg-amber-500/30 font-semibold uppercase tracking-wide"
          >
            Sweep / Inspect
          </button>
        </div>
      )}
    </div>
  );
}
