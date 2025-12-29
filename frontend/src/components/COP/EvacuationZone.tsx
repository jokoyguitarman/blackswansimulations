import { Circle, Popup } from 'react-leaflet';
import type { LatLngExpression } from 'leaflet';

/**
 * Evacuation Zone Component - Client-side only
 * Separation of concerns: UI for displaying evacuation zones on map
 */

interface EvacuationZoneProps {
  center: LatLngExpression;
  radius: number; // in meters
  title: string;
}

export const EvacuationZone = ({ center, radius, title }: EvacuationZoneProps) => {
  return (
    <>
      <Circle
        center={center}
        radius={radius}
        pathOptions={{
          color: '#ef4444', // red-500
          fillColor: '#ef4444',
          fillOpacity: 0.2,
          weight: 2,
          dashArray: '10, 10',
        }}
      >
        <Popup>
          <div className="p-2 min-w-[200px]">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xl">⚠️</span>
              <h3 className="text-sm font-semibold terminal-text">{title}</h3>
            </div>
            <div className="space-y-1 text-xs terminal-text">
              <div className="flex items-center gap-2">
                <span className="text-robotic-yellow/70">[RADIUS]</span>
                <span>{radius}m</span>
              </div>
              <p className="text-red-400 font-semibold">EVACUATION ZONE</p>
            </div>
          </div>
        </Popup>
      </Circle>

      {/* Center marker */}
      <Circle
        center={center}
        radius={50} // Small center point
        pathOptions={{
          color: '#ef4444',
          fillColor: '#ef4444',
          fillOpacity: 0.8,
          weight: 2,
        }}
      >
        <Popup>
          <div className="p-2 text-xs terminal-text">
            <p className="font-semibold">{title}</p>
            <p className="text-robotic-yellow/70">Center of evacuation zone</p>
          </div>
        </Popup>
      </Circle>
    </>
  );
};
