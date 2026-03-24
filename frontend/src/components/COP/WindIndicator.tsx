import { useMap } from 'react-leaflet';
import { useEffect, useRef } from 'react';
import L from 'leaflet';

export interface WindData {
  direction_degrees: number;
  speed_kph?: number;
  label?: string;
}

interface WindIndicatorProps {
  wind: WindData;
}

export const WindIndicator = ({ wind }: WindIndicatorProps) => {
  const map = useMap();
  const controlRef = useRef<L.Control | null>(null);

  useEffect(() => {
    if (controlRef.current) {
      map.removeControl(controlRef.current);
    }

    const WindControl = L.Control.extend({
      options: { position: 'topright' as L.ControlPosition },
      onAdd() {
        const container = L.DomUtil.create('div', 'leaflet-bar');
        container.style.cssText =
          'background: rgba(0,0,0,0.85); border: 1px solid rgba(234,179,8,0.5); border-radius: 6px; padding: 8px; min-width: 64px; text-align: center;';

        const arrowRotation = wind.direction_degrees;
        const speedText = wind.speed_kph != null ? `${wind.speed_kph} km/h` : '';
        const dirLabel = wind.label || degreesToCardinal(wind.direction_degrees);

        container.innerHTML = `
          <div style="font-size: 10px; color: rgba(234,179,8,0.7); font-family: monospace; margin-bottom: 4px;">WIND</div>
          <div style="font-size: 24px; line-height: 1; transform: rotate(${arrowRotation}deg); display: inline-block;">↓</div>
          <div style="font-size: 10px; color: rgba(234,179,8,0.9); font-family: monospace; margin-top: 4px;">${dirLabel}</div>
          ${speedText ? `<div style="font-size: 9px; color: rgba(234,179,8,0.6); font-family: monospace;">${speedText}</div>` : ''}
        `;

        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.disableScrollPropagation(container);
        return container;
      },
    });

    const control = new WindControl();
    control.addTo(map);
    controlRef.current = control;

    return () => {
      if (controlRef.current) {
        try {
          map.removeControl(controlRef.current);
        } catch {
          /* ignore */
        }
        controlRef.current = null;
      }
    };
  }, [map, wind.direction_degrees, wind.speed_kph, wind.label]);

  return null;
};

function degreesToCardinal(deg: number): string {
  const dirs = [
    'N',
    'NNE',
    'NE',
    'ENE',
    'E',
    'ESE',
    'SE',
    'SSE',
    'S',
    'SSW',
    'SW',
    'WSW',
    'W',
    'WNW',
    'NW',
    'NNW',
  ];
  const idx = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return dirs[idx];
}
