import { Circle, Tooltip } from 'react-leaflet';
import type { LatLngExpression } from 'leaflet';

export interface CrowdArea {
  area_id?: string;
  label?: string;
  lat: number;
  lng: number;
  crowd_density?: number;
  radius_m?: number;
}

interface CrowdDensityOverlayProps {
  areas: CrowdArea[];
}

function getDensityColor(density: number): string {
  if (density >= 0.8) return '#dc2626'; // critical
  if (density >= 0.6) return '#f97316'; // high
  if (density >= 0.4) return '#eab308'; // moderate
  return '#22c55e'; // low
}

function getDensityLabel(density: number): string {
  if (density >= 0.8) return 'Critical';
  if (density >= 0.6) return 'High';
  if (density >= 0.4) return 'Moderate';
  return 'Low';
}

export const CrowdDensityOverlay = ({ areas }: CrowdDensityOverlayProps) => {
  return (
    <>
      {areas
        .filter((a) => a.crowd_density != null && a.crowd_density > 0)
        .map((area, idx) => {
          const density = area.crowd_density!;
          const color = getDensityColor(density);
          const radius = area.radius_m ?? Math.max(50, density * 200);
          const center: LatLngExpression = [area.lat, area.lng];

          return (
            <Circle
              key={area.area_id ?? `crowd-${idx}`}
              center={center}
              radius={radius}
              pathOptions={{
                color,
                fillColor: color,
                fillOpacity: 0.12 + density * 0.18,
                weight: 1,
                dashArray: '4, 4',
              }}
            >
              <Tooltip sticky>
                <div className="text-xs">
                  <div className="font-semibold">{area.label ?? 'Area'}</div>
                  <div>
                    Crowd density:{' '}
                    <span style={{ color }}>
                      {getDensityLabel(density)} ({Math.round(density * 100)}%)
                    </span>
                  </div>
                </div>
              </Tooltip>
            </Circle>
          );
        })}
    </>
  );
};
