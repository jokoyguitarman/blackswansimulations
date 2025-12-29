import { Marker, Popup } from 'react-leaflet';
import { Icon, DivIcon } from 'leaflet';
import type { LatLngExpression } from 'leaflet';

/**
 * Incident Marker Component - Client-side only
 * Separation of concerns: UI for displaying incident markers on map
 */

interface Incident {
  id: string;
  title: string;
  description: string;
  severity: string;
  status: string;
  type: string;
  casualty_count?: number;
}

interface IncidentMarkerProps {
  incident: Incident;
  position: LatLngExpression;
  onClick?: () => void;
  isSelected?: boolean;
}

const getSeverityColor = (severity: string): string => {
  switch (severity) {
    case 'critical':
      return '#ef4444'; // red-500
    case 'high':
      return '#f97316'; // orange-500
    case 'medium':
      return '#eab308'; // yellow-500
    case 'low':
      return '#6b7280'; // gray-500
    default:
      return '#6b7280';
  }
};

const getSeverityIcon = (severity: string): string => {
  switch (severity) {
    case 'critical':
      return '🚨';
    case 'high':
      return '⚠️';
    case 'medium':
      return '📋';
    case 'low':
      return '📍';
    default:
      return '📍';
  }
};

const createIncidentIcon = (severity: string, isSelected?: boolean): DivIcon => {
  const color = getSeverityColor(severity);
  const icon = getSeverityIcon(severity);
  const size = isSelected ? 40 : 32;
  const borderWidth = isSelected ? 5 : 3;
  const borderColor = isSelected ? '#eab308' : 'white'; // Yellow border when selected
  const shadow = isSelected
    ? '0 4px 16px rgba(234, 179, 8, 0.6), 0 2px 8px rgba(0,0,0,0.3)'
    : '0 2px 8px rgba(0,0,0,0.3)';

  return new DivIcon({
    className: `incident-marker ${isSelected ? 'selected' : ''}`,
    html: `
      <div style="
        background-color: ${color};
        width: ${size}px;
        height: ${size}px;
        border-radius: 50%;
        border: ${borderWidth}px solid ${borderColor};
        box-shadow: ${shadow};
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: ${isSelected ? '22px' : '18px'};
        cursor: pointer;
        transition: all 0.2s;
      ">
        ${icon}
      </div>
    `,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
};

export const IncidentMarker = ({
  incident,
  position,
  onClick,
  isSelected,
}: IncidentMarkerProps) => {
  const icon = createIncidentIcon(incident.severity, isSelected);

  return (
    <Marker
      position={position}
      icon={icon}
      eventHandlers={{
        click: () => {
          onClick?.();
        },
      }}
    >
      <Popup>
        <div className="p-2 min-w-[200px]">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xl">{getSeverityIcon(incident.severity)}</span>
            <h3 className="text-sm font-semibold terminal-text">{incident.title}</h3>
          </div>
          <div className="space-y-1 text-xs terminal-text">
            <div className="flex items-center gap-2">
              <span className="text-robotic-yellow/70">[TYPE]</span>
              <span>{incident.type}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-robotic-yellow/70">[SEVERITY]</span>
              <span
                className={`px-2 py-0.5 rounded border ${
                  incident.severity === 'critical'
                    ? 'bg-red-500/20 text-red-400 border-red-400'
                    : incident.severity === 'high'
                      ? 'bg-orange-500/20 text-orange-400 border-orange-400'
                      : incident.severity === 'medium'
                        ? 'bg-yellow-500/20 text-yellow-400 border-yellow-400'
                        : 'bg-gray-500/20 text-gray-400 border-gray-400'
                }`}
              >
                {incident.severity.toUpperCase()}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-robotic-yellow/70">[STATUS]</span>
              <span>{incident.status.replace('_', ' ').toUpperCase()}</span>
            </div>
            {incident.casualty_count !== undefined && incident.casualty_count > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-robotic-yellow/70">[CASUALTIES]</span>
                <span>{incident.casualty_count}</span>
              </div>
            )}
            <p className="text-robotic-yellow/70 mt-2 line-clamp-2">{incident.description}</p>
            {onClick && (
              <button
                onClick={onClick}
                className="mt-2 px-2 py-1 text-xs terminal-text uppercase border border-robotic-yellow text-robotic-yellow hover:bg-robotic-yellow/10"
              >
                [VIEW_DETAILS]
              </button>
            )}
          </div>
        </div>
      </Popup>
    </Marker>
  );
};
