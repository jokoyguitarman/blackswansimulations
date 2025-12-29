import { Marker, Popup } from 'react-leaflet';
import { DivIcon } from 'leaflet';
import type { LatLngExpression } from 'leaflet';

/**
 * Resource Marker Component - Client-side only
 * Separation of concerns: UI for displaying resource markers on map
 */

interface Resource {
  id?: string;
  resource_type: string;
  quantity: number;
  agency_name: string;
}

interface ResourceMarkerProps {
  resource: Resource;
  position: LatLngExpression;
  onClick?: () => void;
}

const getResourceIcon = (resourceType: string): string => {
  const type = resourceType.toLowerCase();
  if (type.includes('ambulance') || type.includes('medical')) return '🚑';
  if (type.includes('police') || type.includes('officer')) return '🚓';
  if (type.includes('fire') || type.includes('truck')) return '🚒';
  if (type.includes('military') || type.includes('defence')) return '🪖';
  if (type.includes('helicopter')) return '🚁';
  return '📦';
};

const createResourceIcon = (resource: Resource): DivIcon => {
  const icon = getResourceIcon(resource.resource_type);
  const color = '#3b82f6'; // blue-500 for resources

  return new DivIcon({
    className: 'resource-marker',
    html: `
      <div style="
        background-color: ${color};
        width: 28px;
        height: 28px;
        border-radius: 50%;
        border: 2px solid white;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        cursor: pointer;
      ">
        ${icon}
      </div>
    `,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14],
  });
};

export const ResourceMarker = ({ resource, position, onClick }: ResourceMarkerProps) => {
  const icon = createResourceIcon(resource);

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
            <span className="text-xl">{getResourceIcon(resource.resource_type)}</span>
            <h3 className="text-sm font-semibold terminal-text">{resource.resource_type}</h3>
          </div>
          <div className="space-y-1 text-xs terminal-text">
            <div className="flex items-center gap-2">
              <span className="text-robotic-yellow/70">[QUANTITY]</span>
              <span>{resource.quantity}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-robotic-yellow/70">[AGENCY]</span>
              <span>{resource.agency_name}</span>
            </div>
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
