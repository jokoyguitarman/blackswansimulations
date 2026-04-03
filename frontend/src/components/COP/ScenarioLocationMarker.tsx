import { Marker, Popup, Circle, Polyline, CircleMarker } from 'react-leaflet';
import { DivIcon } from 'leaflet';
import type { LatLngExpression } from 'leaflet';
import { svg } from './mapIcons';

/**
 * Scenario location pin (map pin from DB).
 * Supports narrative-derived location_type (free-form) with pin_category for visual grouping.
 */

export interface ScenarioLocationPin {
  id: string;
  location_type: string;
  /** Structural category for color/symbol; stored in conditions.pin_category */
  pin_category?: string;
  /** One-sentence narrative significance; stored in conditions.narrative_description */
  narrative_description?: string;
  label: string;
  coordinates: { lat?: number; lng?: number };
  conditions?: Record<string, unknown>;
  claimable_by?: string[];
  claimed_by_team?: string | null;
  claimed_as?: string | null;
  claim_exclusivity?: string | null;
}

interface ScenarioLocationMarkerProps {
  location: ScenarioLocationPin;
  position: LatLngExpression;
  draggable?: boolean;
  onDragEnd?: (id: string, lat: number, lng: number) => void;
  sessionElapsedMinutes?: number;
}

const isLastKnownAdversary = (pin: ScenarioLocationPin): boolean => {
  const cat = pin.pin_category?.toLowerCase() ?? '';
  const condCat = ((pin.conditions?.pin_category as string) ?? '').toLowerCase();
  return cat === 'last_known_adversary' || condCat === 'last_known_adversary';
};

const isAdversarySighting = (pin: ScenarioLocationPin): boolean => {
  const cat = pin.pin_category?.toLowerCase() ?? '';
  const condCat = ((pin.conditions?.pin_category as string) ?? '').toLowerCase();
  return cat === 'adversary_sighting' || condCat === 'adversary_sighting';
};

const getSightingStatus = (pin: ScenarioLocationPin): 'active' | 'stale' | 'debunked' => {
  return ((pin.conditions?.sighting_status as string) || 'active') as
    | 'active'
    | 'stale'
    | 'debunked';
};

const getPinColor = (pin: ScenarioLocationPin): string => {
  const cat = pin.pin_category?.toLowerCase() ?? '';
  const t = pin.location_type.toLowerCase();

  if (isAdversarySighting(pin)) {
    const status = getSightingStatus(pin);
    if (status === 'debunked') return '#6b7280';
    if (status === 'stale') return '#9ca3af';
    return '#dc2626';
  }
  if (isLastKnownAdversary(pin)) return '#dc2626';
  if (
    cat === 'incident_site' ||
    t.includes('blast') ||
    t.includes('epicentre') ||
    t.includes('device') ||
    t.includes('attack')
  )
    return '#b91c1c';
  if (
    cat === 'cordon' ||
    t.includes('cordon') ||
    t.includes('perimeter') ||
    t.includes('exclusion')
  )
    return '#7c3aed';
  if (cat === 'triage' || t.includes('triage') || t.includes('casualty') || t.includes('medical'))
    return '#d97706';
  if (cat === 'route' || t === 'route') return '#15803d';
  if (
    cat === 'access' ||
    cat === 'entry_exit' ||
    t.includes('exit') ||
    t.includes('entry') ||
    t.includes('route') ||
    t.includes('pathway') ||
    t.includes('ingress') ||
    t.includes('egress')
  )
    return '#059669';
  if (
    cat === 'command' ||
    t.includes('command') ||
    t.includes('icp') ||
    t.includes('ops') ||
    t.includes('negotiat')
  )
    return '#0284c7';
  if (
    cat === 'staging' ||
    t.includes('staging') ||
    t.includes('holding') ||
    t.includes('assembly') ||
    t.includes('pool')
  )
    return '#0891b2';
  if (
    cat === 'poi' ||
    t.includes('hospital') ||
    t.includes('police') ||
    t.includes('fire') ||
    t.includes('scdf') ||
    t.includes('media') ||
    t.includes('press')
  )
    return '#4338ca';
  if (t.includes('cctv')) return '#a855f7';
  if (t.includes('community')) return '#0d9488';
  return '#4b5563';
};

const getSymbol = (pin: ScenarioLocationPin): string => {
  const cat = pin.pin_category?.toLowerCase() ?? '';
  const t = pin.location_type.toLowerCase();

  if (isAdversarySighting(pin)) {
    const status = getSightingStatus(pin);
    if (status === 'debunked') return svg('suspect_debunked');
    if (status === 'stale') return svg('suspect_stale');
    return svg('suspect_silhouette');
  }
  if (isLastKnownAdversary(pin)) return svg('suspect_silhouette');
  if (
    cat === 'incident_site' ||
    t.includes('blast') ||
    t.includes('device') ||
    t.includes('epicentre') ||
    t.includes('attack')
  )
    return svg('explosion');
  if (
    cat === 'cordon' ||
    t.includes('cordon') ||
    t.includes('perimeter') ||
    t.includes('exclusion')
  )
    return svg('cordon');
  if (cat === 'triage' || t.includes('triage') || t.includes('casualty'))
    return svg('medical_cross');
  if (t.includes('negotiat') || t.includes('ops') || t.includes('command') || t.includes('icp'))
    return svg('command');
  if (cat === 'command') return svg('command');
  if (cat === 'route' || t === 'route') return svg('route');
  if (
    cat === 'access' ||
    cat === 'entry_exit' ||
    t.includes('exit') ||
    t.includes('entry') ||
    t.includes('route') ||
    t.includes('pathway') ||
    t.includes('ingress') ||
    t.includes('egress')
  )
    return svg('door');
  if (
    cat === 'staging' ||
    t.includes('staging') ||
    t.includes('holding') ||
    t.includes('assembly') ||
    t.includes('pool')
  )
    return svg('staging');
  if (t.includes('media') || t.includes('press')) return svg('broadcast');
  if (t.includes('hospital')) return svg('hospital');
  if (t.includes('police')) return svg('police');
  if (t.includes('fire') || t.includes('scdf')) return svg('fire_station');
  if (t.includes('cctv')) return svg('camera');
  if (t.includes('community')) return svg('community');
  return svg('pin');
};

const isIncidentSite = (pin: ScenarioLocationPin): boolean => {
  const cat = pin.pin_category?.toLowerCase() ?? '';
  const t = pin.location_type.toLowerCase();
  return (
    cat === 'incident_site' ||
    t.includes('blast') ||
    t.includes('epicentre') ||
    t.includes('device') ||
    t.includes('attack') ||
    t.includes('explosion') ||
    t.includes('detonation') ||
    t.includes('impact')
  );
};

const createPinIcon = (pin: ScenarioLocationPin, stalenessMinutes?: number): DivIcon => {
  const color = getPinColor(pin);
  const symbol = getSymbol(pin);
  const primary = isIncidentSite(pin);
  const adversary = isLastKnownAdversary(pin);
  const sighting = isAdversarySighting(pin);
  const sightingStatus = sighting ? getSightingStatus(pin) : null;
  const isSightingActive = sighting && sightingStatus === 'active';
  const isSightingStale = sighting && sightingStatus === 'stale';
  const isSightingDebunked = sighting && sightingStatus === 'debunked';

  const sightingSize = isSightingDebunked ? 28 : isSightingStale ? 30 : 40;
  const size = primary ? 48 : adversary ? 44 : sighting ? sightingSize : 32;
  const borderWidth = primary ? 3 : adversary || isSightingActive ? 3 : 2;
  const svgSize = primary
    ? 24
    : adversary
      ? 22
      : isSightingActive
        ? 20
        : isSightingStale
          ? 14
          : isSightingDebunked
            ? 14
            : 16;
  const borderColor = primary
    ? '#fbbf24'
    : adversary || isSightingActive
      ? '#ef4444'
      : isSightingDebunked
        ? '#6b7280'
        : isSightingStale
          ? '#9ca3af'
          : 'white';
  const shadowStyle = primary
    ? `0 0 16px 4px ${color}88, 0 4px 12px rgba(0,0,0,0.4)`
    : adversary || isSightingActive
      ? `0 0 20px 6px rgba(239,68,68,0.5), 0 4px 12px rgba(0,0,0,0.4)`
      : isSightingDebunked
        ? '0 2px 4px rgba(0,0,0,0.2)'
        : '0 2px 6px rgba(0,0,0,0.3)';
  const cssClass = primary
    ? 'scenario-location-marker primary-incident'
    : adversary || isSightingActive
      ? 'scenario-location-marker adversary-marker'
      : 'scenario-location-marker';
  const pulseClass = primary
    ? 'primary-incident-pulse'
    : adversary || isSightingActive
      ? 'adversary-pulse'
      : '';

  const showStaleness =
    (adversary || isSightingActive) && stalenessMinutes != null && stalenessMinutes > 0;
  const stalenessLabel = showStaleness
    ? `<div style="
          position:absolute;
          bottom:-18px;left:50%;transform:translateX(-50%);
          white-space:nowrap;
          font-size:9px;font-weight:bold;
          color:#fca5a5;
          text-shadow:0 1px 3px rgba(0,0,0,0.8);
          font-family:monospace;
          pointer-events:none;
        ">Last seen ${Math.round(stalenessMinutes!)}m ago</div>`
    : '';

  const natoGrade = (pin.conditions?.nato_grade as string) || null;
  const natoColor = natoGrade
    ? /^[AB][12]/.test(natoGrade)
      ? '#22c55e'
      : /^[CD][34]/.test(natoGrade)
        ? '#f59e0b'
        : '#ef4444'
    : null;
  const natoLabel =
    natoGrade && (sighting || adversary)
      ? `<div style="
          position:absolute;
          top:-14px;left:50%;transform:translateX(-50%);
          white-space:nowrap;
          font-size:9px;font-weight:900;
          color:${natoColor};
          background:rgba(0,0,0,0.75);
          padding:0 3px;border-radius:2px;
          border:1px solid ${natoColor}44;
          font-family:monospace;
          pointer-events:none;
          letter-spacing:0.5px;
        ">${natoGrade}</div>`
      : '';

  const debunkedLabel = isSightingDebunked
    ? `<div style="
          position:absolute;
          bottom:-16px;left:50%;transform:translateX(-50%);
          white-space:nowrap;
          font-size:8px;font-weight:bold;
          color:#ef4444;
          text-shadow:0 1px 3px rgba(0,0,0,0.8);
          font-family:monospace;
          pointer-events:none;
          text-decoration:line-through;
        ">FALSE LEAD</div>`
    : '';

  const sightingOrderLabel = isSightingStale
    ? `<div style="
          position:absolute;
          bottom:-14px;left:50%;transform:translateX(-50%);
          white-space:nowrap;
          font-size:8px;font-weight:bold;
          color:#9ca3af;
          text-shadow:0 1px 3px rgba(0,0,0,0.8);
          font-family:monospace;
          pointer-events:none;
        ">#${((pin.conditions?.sighting_order as number) ?? 0) + 1}</div>`
    : '';

  return new DivIcon({
    className: cssClass,
    html: `
      ${
        primary || adversary || isSightingActive
          ? `<div class="${pulseClass}" style="
        position:absolute;
        top:50%;left:50%;
        width:${size + 16}px;height:${size + 16}px;
        margin-left:-${(size + 16) / 2}px;margin-top:-${(size + 16) / 2}px;
        border-radius:50%;
        border:2px solid ${adversary || isSightingActive ? '#ef4444' : color};
        opacity:0;
        pointer-events:none;
      "></div>`
          : ''
      }
      <div style="
        position:relative;
        background-color: ${color};
        width: ${size}px;
        height: ${size}px;
        border-radius: 50%;
        border: ${borderWidth}px solid ${borderColor};
        box-shadow: ${shadowStyle};
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: ${svgSize}px;
        line-height: 1;
        z-index:10;
        ${isSightingDebunked ? 'opacity:0.5;' : isSightingStale ? 'opacity:0.65;' : ''}
      ">
        ${primary || adversary || sighting ? symbol.replace(/width="16"/, `width="${svgSize}"`).replace(/height="16"/, `height="${svgSize}"`) : symbol}
      </div>
      ${natoLabel}
      ${stalenessLabel}
      ${debunkedLabel}
      ${sightingOrderLabel}
    `,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
};

const INTEL_SOURCE_LABELS: Record<string, { label: string; icon: string; color: string }> = {
  cctv: { label: 'CCTV', icon: '📹', color: '#a855f7' },
  anpr: { label: 'ANPR', icon: '🚗', color: '#3b82f6' },
  helicopter_thermal: { label: 'HELO THERMAL', icon: '🚁', color: '#22c55e' },
  k9_tracking: { label: 'K9 TRACK', icon: '🐕', color: '#f59e0b' },
  cell_tower: { label: 'CELL TOWER', icon: '📡', color: '#6366f1' },
  eyewitness: { label: 'EYEWITNESS', icon: '👁', color: '#ef4444' },
  forensic: { label: 'FORENSIC', icon: '🔬', color: '#14b8a6' },
  financial: { label: 'FINANCIAL', icon: '💳', color: '#f97316' },
  social_media: { label: 'SOCIAL MEDIA', icon: '📱', color: '#ec4899' },
  hospital_alert: { label: 'HOSPITAL', icon: '🏥', color: '#10b981' },
  informant: { label: 'INFORMANT', icon: '🕵', color: '#8b5cf6' },
};

const CONFIDENCE_STYLES: Record<
  string,
  { color: string; fillOpacity: number; weight: number; dash: string; label: string }
> = {
  high: { color: '#22c55e', fillOpacity: 0.06, weight: 2, dash: '', label: 'HIGH' },
  medium: { color: '#f59e0b', fillOpacity: 0.08, weight: 1.5, dash: '8 4', label: 'MEDIUM' },
  low: { color: '#ef4444', fillOpacity: 0.1, weight: 1, dash: '4 4', label: 'LOW' },
};

function computeDirectionArrow(
  center: [number, number],
  direction: string,
  radiusM: number,
): [number, number][] | null {
  const dirMap: Record<string, number> = {
    north: 0,
    northeast: 45,
    east: 90,
    southeast: 135,
    south: 180,
    southwest: 225,
    west: 270,
    northwest: 315,
  };
  const lower = direction.toLowerCase();
  let angleDeg: number | null = null;
  for (const [key, val] of Object.entries(dirMap)) {
    if (lower.includes(key)) {
      angleDeg = val;
      break;
    }
  }
  if (angleDeg === null) return null;

  const angleRad = (angleDeg * Math.PI) / 180;
  const mToDeg = 1 / 111_320;
  const len = Math.max(radiusM * 1.5, 200) * mToDeg;
  const cosLat = Math.cos((center[0] * Math.PI) / 180);

  const tip: [number, number] = [
    center[0] + Math.cos(angleRad) * len,
    center[1] + (Math.sin(angleRad) * len) / cosLat,
  ];
  return [center, tip];
}

export const ScenarioLocationMarker = ({
  location,
  position,
  draggable,
  onDragEnd,
  sessionElapsedMinutes,
}: ScenarioLocationMarkerProps) => {
  const adversary = isLastKnownAdversary(location);
  const sighting = isAdversarySighting(location);
  const anyAdversary = adversary || sighting;
  const sightingStatus = sighting ? getSightingStatus(location) : null;
  const lastSeenAt = anyAdversary
    ? ((location.conditions?.last_seen_at_minutes as number | undefined) ?? 0)
    : 0;
  const stalenessMinutes =
    anyAdversary && sessionElapsedMinutes != null ? sessionElapsedMinutes - lastSeenAt : undefined;
  const icon = createPinIcon(location, stalenessMinutes);
  const narrativeDesc =
    location.narrative_description ??
    (location.conditions?.narrative_description as string | undefined);

  const intelSource = (location.conditions?.intel_source as string) || null;
  const confidence = (location.conditions?.confidence as string) || null;
  const accuracyRadiusM = (location.conditions?.accuracy_radius_m as number) || 0;
  const directionOfTravel = (location.conditions?.direction_of_travel as string) || null;
  const testsContainment = (location.conditions?.tests_containment as boolean) || false;
  const natoGrade = (location.conditions?.nato_grade as string) || null;

  const confidenceStyle = confidence
    ? CONFIDENCE_STYLES[confidence] || CONFIDENCE_STYLES.low
    : null;
  const intelMeta = intelSource ? INTEL_SOURCE_LABELS[intelSource] || null : null;

  const showUncertainty =
    anyAdversary && sightingStatus !== 'debunked' && sightingStatus !== 'stale';
  const effectiveRadius = showUncertainty
    ? accuracyRadiusM > 0
      ? accuracyRadiusM +
        (stalenessMinutes != null && stalenessMinutes > 0
          ? Math.min(stalenessMinutes * 40, 800)
          : 0)
      : stalenessMinutes != null && stalenessMinutes > 0
        ? Math.min(stalenessMinutes * 80, 2000)
        : 0
    : 0;

  const posArray: [number, number] = Array.isArray(position)
    ? (position as [number, number])
    : [
        (position as { lat: number; lng: number }).lat,
        (position as { lat: number; lng: number }).lng,
      ];

  const showDirection = anyAdversary && sightingStatus !== 'debunked' && sightingStatus !== 'stale';
  const directionArrow =
    showDirection && directionOfTravel
      ? computeDirectionArrow(posArray, directionOfTravel, effectiveRadius || 200)
      : null;

  // Legacy sighting history trail (only for old-style single moving pin)
  const sightingHistory =
    adversary && Array.isArray(location.conditions?.sighting_history)
      ? (location.conditions.sighting_history as Array<{
          lat: number;
          lng: number;
          zone_label: string;
          seen_at_minutes: number;
          intel_source: string;
          confidence: string;
        }>)
      : [];

  const corridorPositions: LatLngExpression[] =
    sightingHistory.length > 0
      ? [...sightingHistory.map((s) => [s.lat, s.lng] as LatLngExpression), position]
      : [];

  return (
    <>
      {/* Pursuit corridor polyline connecting all past sightings to current position */}
      {corridorPositions.length >= 2 && (
        <Polyline
          positions={corridorPositions}
          pathOptions={{
            color: '#f97316',
            weight: 2,
            opacity: 0.35,
            dashArray: '6 8',
          }}
        />
      )}

      {/* Ghost pins at previous sighting locations */}
      {sightingHistory.map((s, idx) => {
        const ghostConfStyle = CONFIDENCE_STYLES[s.confidence] || CONFIDENCE_STYLES.low;
        const ghostIntel = INTEL_SOURCE_LABELS[s.intel_source] || null;
        return (
          <CircleMarker
            key={`ghost-${location.id}-${idx}`}
            center={[s.lat, s.lng]}
            radius={6}
            pathOptions={{
              color: ghostConfStyle.color,
              fillColor: ghostConfStyle.color,
              fillOpacity: 0.25,
              weight: 1,
              opacity: 0.4,
            }}
          >
            <Popup>
              <div className="p-2 min-w-[140px] max-w-[220px]">
                <div className="text-xs font-bold terminal-text text-robotic-yellow/60">
                  CLEARED — T+{Math.round(s.seen_at_minutes)}min
                </div>
                <div className="text-xs text-robotic-yellow/50 mt-0.5">{s.zone_label}</div>
                {ghostIntel && (
                  <div className="flex items-center gap-1 mt-1">
                    <span
                      className="inline-flex items-center gap-0.5 px-1 py-0.5 text-[9px] font-bold rounded"
                      style={{
                        backgroundColor: ghostIntel.color + '15',
                        color: ghostIntel.color,
                        opacity: 0.7,
                      }}
                    >
                      {ghostIntel.icon} {ghostIntel.label}
                    </span>
                    <span
                      className="px-1 py-0.5 text-[9px] font-bold rounded font-mono"
                      style={{
                        backgroundColor: ghostConfStyle.color + '15',
                        color: ghostConfStyle.color,
                        opacity: 0.7,
                      }}
                    >
                      {ghostConfStyle.label}
                    </span>
                  </div>
                )}
                <div className="text-[10px] text-robotic-yellow/40 mt-1 italic">
                  Suspect no longer at this location
                </div>
              </div>
            </Popup>
          </CircleMarker>
        );
      })}

      {showUncertainty && effectiveRadius > 0 && (
        <Circle
          center={position}
          radius={effectiveRadius}
          pathOptions={{
            color: confidenceStyle?.color || '#ef4444',
            fillColor: confidenceStyle?.color || '#ef4444',
            fillOpacity: confidenceStyle?.fillOpacity ?? 0.08,
            weight: confidenceStyle?.weight ?? 1,
            dashArray: confidenceStyle?.dash || '6 4',
            className: 'adversary-uncertainty-radius',
          }}
        />
      )}
      {directionArrow && (
        <Polyline
          positions={directionArrow}
          pathOptions={{
            color: confidenceStyle?.color || '#f59e0b',
            weight: 3,
            opacity: 0.7,
            dashArray: '10 6',
          }}
        />
      )}
      <Marker
        position={position}
        icon={icon}
        draggable={draggable}
        eventHandlers={
          draggable && onDragEnd
            ? {
                dragend: (e) => {
                  const latlng = e.target.getLatLng();
                  onDragEnd(location.id, latlng.lat, latlng.lng);
                },
              }
            : undefined
        }
      >
        <Popup>
          <div className="p-2 min-w-[180px] max-w-[260px]">
            <div className="text-sm font-medium terminal-text text-robotic-yellow">
              {location.label}
            </div>
            <div className="text-xs text-robotic-yellow/60 mt-0.5 capitalize">
              {sighting
                ? sightingStatus === 'debunked'
                  ? 'DEBUNKED — False Lead'
                  : `Sighting Report #${((location.conditions?.sighting_order as number) ?? 0) + 1}`
                : adversary
                  ? 'Last Known Position'
                  : location.location_type.replace(/_/g, ' ')}
            </div>

            {natoGrade && anyAdversary && (
              <div className="flex items-center gap-1.5 mt-1">
                <span
                  className="px-1.5 py-0.5 text-[11px] font-black rounded font-mono tracking-wider"
                  style={{
                    backgroundColor:
                      (/^[AB][12]/.test(natoGrade)
                        ? '#22c55e'
                        : /^[CD][34]/.test(natoGrade)
                          ? '#f59e0b'
                          : '#ef4444') + '22',
                    color: /^[AB][12]/.test(natoGrade)
                      ? '#22c55e'
                      : /^[CD][34]/.test(natoGrade)
                        ? '#f59e0b'
                        : '#ef4444',
                    border: `1px solid ${/^[AB][12]/.test(natoGrade) ? '#22c55e' : /^[CD][34]/.test(natoGrade) ? '#f59e0b' : '#ef4444'}44`,
                  }}
                >
                  INTEL {natoGrade}
                </span>
                <span className="text-[9px] text-robotic-yellow/50 font-mono">
                  {natoGrade[0] === 'A'
                    ? 'Completely Reliable'
                    : natoGrade[0] === 'B'
                      ? 'Usually Reliable'
                      : natoGrade[0] === 'C'
                        ? 'Fairly Reliable'
                        : natoGrade[0] === 'D'
                          ? 'Not Usually Reliable'
                          : natoGrade[0] === 'E'
                            ? 'Unreliable'
                            : 'Cannot Judge'}{' '}
                  ·{' '}
                  {natoGrade[1] === '1'
                    ? 'Confirmed'
                    : natoGrade[1] === '2'
                      ? 'Probably True'
                      : natoGrade[1] === '3'
                        ? 'Possibly True'
                        : natoGrade[1] === '4'
                          ? 'Doubtful'
                          : 'Improbable'}
                </span>
              </div>
            )}

            {anyAdversary && intelMeta && (
              <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold rounded"
                  style={{
                    backgroundColor: intelMeta.color + '22',
                    color: intelMeta.color,
                    border: `1px solid ${intelMeta.color}44`,
                  }}
                >
                  {intelMeta.icon} {intelMeta.label}
                </span>
                {confidenceStyle && (
                  <span
                    className="px-1.5 py-0.5 text-[10px] font-bold rounded font-mono"
                    style={{
                      backgroundColor: confidenceStyle.color + '22',
                      color: confidenceStyle.color,
                      border: `1px solid ${confidenceStyle.color}44`,
                    }}
                  >
                    {confidenceStyle.label}
                  </span>
                )}
                <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-amber-900/30 text-amber-400 border border-amber-500/30">
                  SINGLE SOURCE
                </span>
              </div>
            )}

            {sighting && sightingStatus === 'debunked' && (
              <div className="text-xs text-red-400 mt-1 font-mono font-bold">
                Debunked at T+
                {Math.round((location.conditions?.debunked_at_minutes as number) ?? 0)}min
              </div>
            )}
            {anyAdversary &&
              sightingStatus !== 'debunked' &&
              stalenessMinutes != null &&
              stalenessMinutes > 0 && (
                <div className="text-xs text-red-400 mt-1 font-mono">
                  Last seen {Math.round(stalenessMinutes)} min ago
                  {effectiveRadius > 0 && ` · ~${Math.round(effectiveRadius)}m radius`}
                </div>
              )}
            {anyAdversary && sightingStatus !== 'debunked' && directionOfTravel && (
              <div className="text-xs text-amber-400 mt-0.5 font-mono">
                Direction: {directionOfTravel}
              </div>
            )}
            {anyAdversary && testsContainment && (
              <div className="text-xs text-purple-400 mt-0.5 font-mono font-bold">
                ⚡ TESTING PERIMETER
              </div>
            )}
            {anyAdversary && typeof location.conditions?.last_seen_description === 'string' && (
              <div className="text-xs text-robotic-yellow/80 mt-1 leading-snug italic">
                {location.conditions.last_seen_description}
              </div>
            )}
            {narrativeDesc && !anyAdversary && (
              <div className="text-xs text-robotic-yellow/80 mt-1 leading-snug">
                {narrativeDesc}
              </div>
            )}
          </div>
        </Popup>
      </Marker>
    </>
  );
};
