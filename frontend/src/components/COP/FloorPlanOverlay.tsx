import { useEffect, useMemo, useRef } from 'react';
import { ImageOverlay, Marker, Tooltip, useMap } from 'react-leaflet';
import { DivIcon, LatLngBounds, SVGOverlay as LeafletSVGOverlay } from 'leaflet';
import type { LatLngBoundsExpression, LatLngExpression } from 'leaflet';
import type { FloorPlan } from './FloorSelector';
import { svg } from './mapIcons';

interface FloorPlanOverlayProps {
  floor: FloorPlan;
}

function createFeatureIcon(feature: FloorPlan['features'][0]): DivIcon {
  const typeIcons: Record<string, string> = {
    escalator: svg('escalator', 12),
    elevator: svg('elevator', 12),
    stairs: svg('stairs', 12),
    emergency_exit: svg('exit_sign', 12),
    exit: svg('exit_sign', 12),
    entrance: svg('person', 12),
    room: svg('room', 12),
    corridor: svg('corridor', 12),
    food_court: svg('food_court', 12),
    retail: svg('retail', 12),
    restroom: svg('restroom', 12),
    fire_extinguisher: svg('extinguisher', 12),
    fire_alarm: svg('fire_alarm', 12),
    first_aid: svg('medical_cross', 12),
    electrical_panel: svg('electrical', 12),
    ventilation: svg('ventilation', 12),
    water_supply: svg('water', 12),
    parking: svg('parking', 12),
    office: svg('office', 12),
    storage: svg('supply', 12),
  };

  const featureIcon = typeIcons[feature.type] ?? svg('pin', 12);

  return new DivIcon({
    className: 'floor-feature-marker',
    html: `
      <div style="
        background: rgba(0,0,0,0.7);
        border: 1px solid rgba(234,179,8,0.5);
        border-radius: 4px;
        padding: 2px 4px;
        font-size: 12px;
        white-space: nowrap;
        display: flex;
        align-items: center;
        gap: 3px;
      ">
        <span>${featureIcon}</span>
        <span style="font-size: 9px; color: rgba(234,179,8,0.8); font-family: monospace;">${feature.label}</span>
      </div>
    `,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

/**
 * Renders an SVG string as a Leaflet SVGOverlay, geo-referenced to building bounds.
 */
function SvgFloorOverlay({
  svgString,
  bounds,
}: {
  svgString: string;
  bounds: LatLngBoundsExpression;
}) {
  const map = useMap();
  const overlayRef = useRef<LeafletSVGOverlay | null>(null);

  const sanitisedSvg = useMemo(() => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgString, 'image/svg+xml');
    const svgEl = doc.querySelector('svg');
    if (!svgEl) return null;
    svgEl.removeAttribute('width');
    svgEl.removeAttribute('height');
    svgEl.setAttribute('preserveAspectRatio', 'none');
    return svgEl;
  }, [svgString]);

  useEffect(() => {
    if (!sanitisedSvg) return;

    const leafletBounds =
      bounds instanceof LatLngBounds
        ? bounds
        : new LatLngBounds(
            (bounds as [[number, number], [number, number]])[0],
            (bounds as [[number, number], [number, number]])[1],
          );

    const overlay = new LeafletSVGOverlay(sanitisedSvg, leafletBounds, {
      opacity: 0.85,
      interactive: false,
      zIndex: 100,
    });

    overlay.addTo(map);
    overlayRef.current = overlay;

    return () => {
      overlay.remove();
      overlayRef.current = null;
    };
  }, [map, sanitisedSvg, bounds]);

  return null;
}

export const FloorPlanOverlay = ({ floor }: FloorPlanOverlayProps) => {
  const bounds = floor.bounds as {
    southWest: [number, number];
    northEast: [number, number];
  } | null;

  const leafletBounds: LatLngBoundsExpression | null = bounds
    ? [bounds.southWest, bounds.northEast]
    : null;

  return (
    <>
      {/* SVG floor plan overlay (server-generated from real building polygon) */}
      {floor.plan_svg && leafletBounds && (
        <SvgFloorOverlay svgString={floor.plan_svg} bounds={leafletBounds} />
      )}

      {/* Fallback: raster image overlay */}
      {!floor.plan_svg && floor.plan_image_url && leafletBounds && (
        <ImageOverlay
          url={floor.plan_image_url}
          bounds={leafletBounds}
          opacity={0.7}
          zIndex={100}
        />
      )}

      {/* Feature markers (geo-referenced) */}
      {floor.features
        .filter((f) => f.geometry?.type === 'Point')
        .map((feature) => {
          const coords = feature.geometry!.coordinates as [number, number];
          if (!coords?.length) return null;
          const position: LatLngExpression = [coords[1], coords[0]];
          const icon = createFeatureIcon(feature);

          return (
            <Marker key={feature.id} position={position} icon={icon}>
              <Tooltip>
                <div className="text-xs">
                  <div className="font-semibold">{feature.label}</div>
                  <div className="text-gray-500 capitalize">{feature.type.replace(/_/g, ' ')}</div>
                </div>
              </Tooltip>
            </Marker>
          );
        })}
    </>
  );
};
