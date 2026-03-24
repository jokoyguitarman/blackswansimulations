import { Circle, Popup } from 'react-leaflet';
import type { LatLngExpression } from 'leaflet';

interface BlastZoneOverlayProps {
  center: LatLngExpression;
  blastRadius: number;
  innerCordonRadius?: number;
  outerCordonRadius?: number;
  label?: string;
}

export const BlastZoneOverlay = ({
  center,
  blastRadius,
  innerCordonRadius,
  outerCordonRadius,
  label,
}: BlastZoneOverlayProps) => {
  return (
    <>
      {/* Outer cordon — dashed purple */}
      {outerCordonRadius && outerCordonRadius > 0 && (
        <Circle
          center={center}
          radius={outerCordonRadius}
          pathOptions={{
            color: '#7c3aed',
            fillColor: '#7c3aed',
            fillOpacity: 0.03,
            weight: 2,
            dashArray: '12, 8',
          }}
        >
          <Popup>
            <div className="p-2 text-xs terminal-text">
              <p className="font-semibold text-purple-400">OUTER CORDON</p>
              <p>Radius: {outerCordonRadius}m</p>
            </div>
          </Popup>
        </Circle>
      )}

      {/* Inner cordon — dashed orange */}
      {innerCordonRadius && innerCordonRadius > 0 && (
        <Circle
          center={center}
          radius={innerCordonRadius}
          pathOptions={{
            color: '#f97316',
            fillColor: '#f97316',
            fillOpacity: 0.06,
            weight: 2,
            dashArray: '8, 6',
          }}
        >
          <Popup>
            <div className="p-2 text-xs terminal-text">
              <p className="font-semibold text-orange-400">INNER CORDON</p>
              <p>Radius: {innerCordonRadius}m</p>
            </div>
          </Popup>
        </Circle>
      )}

      {/* Blast exclusion zone — solid red fill */}
      <Circle
        center={center}
        radius={blastRadius}
        pathOptions={{
          color: '#dc2626',
          fillColor: '#dc2626',
          fillOpacity: 0.15,
          weight: 3,
        }}
      >
        <Popup>
          <div className="p-2 text-xs terminal-text">
            <p className="font-semibold text-red-400">BLAST EXCLUSION ZONE</p>
            <p>Radius: {blastRadius}m</p>
            {label && <p className="text-robotic-yellow/70 mt-1">{label}</p>}
            <p className="text-red-300 mt-1 font-semibold">NO ENTRY — Asset placement blocked</p>
          </div>
        </Popup>
      </Circle>

      {/* Blast epicentre marker */}
      <Circle
        center={center}
        radius={15}
        pathOptions={{
          color: '#dc2626',
          fillColor: '#dc2626',
          fillOpacity: 0.9,
          weight: 2,
        }}
      />
    </>
  );
};
