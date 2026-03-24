import { Polyline, Tooltip } from 'react-leaflet';
import type { LatLngExpression } from 'leaflet';

export interface RouteData {
  label?: string;
  problem?: string | null;
  managed?: boolean;
  travel_time_minutes?: number;
  capacity_per_min?: number;
  geometry?: [number, number][];
}

function getRouteColor(route: RouteData): string {
  if (!route.problem) return '#22c55e'; // green — clear
  if (route.managed) return '#f59e0b'; // amber — problem but managed
  return '#ef4444'; // red — problem, unmanaged
}

function getRouteDash(route: RouteData): string | undefined {
  if (!route.problem && !route.managed) return '8 6'; // dashed gray for no-status
  return undefined;
}

function getRouteWeight(route: RouteData): number {
  if (route.problem && !route.managed) return 5;
  if (route.problem && route.managed) return 4;
  return 3;
}

function getRouteOpacity(route: RouteData): number {
  if (route.problem && !route.managed) return 0.85;
  return 0.65;
}

interface RoutePolylineProps {
  route: RouteData;
}

export const RoutePolyline = ({ route }: RoutePolylineProps) => {
  if (!route.geometry?.length || route.geometry.length < 2) return null;

  const positions: LatLngExpression[] = route.geometry.map(
    ([lat, lng]) => [lat, lng] as LatLngExpression,
  );

  const color = getRouteColor(route);
  const dashArray = getRouteDash(route);
  const weight = getRouteWeight(route);
  const opacity = getRouteOpacity(route);

  const statusText = !route.problem ? 'Clear' : route.managed ? 'Managed' : 'Unmanaged';

  return (
    <Polyline
      positions={positions}
      pathOptions={{
        color,
        weight,
        opacity,
        dashArray,
        lineCap: 'round',
        lineJoin: 'round',
      }}
    >
      <Tooltip sticky>
        <div className="text-xs">
          <div className="font-semibold">{route.label ?? 'Route'}</div>
          <div>
            Status: <span style={{ color }}>{statusText}</span>
          </div>
          {route.problem && <div>Issue: {route.problem}</div>}
          {route.travel_time_minutes != null && (
            <div>Travel time: {route.travel_time_minutes} min</div>
          )}
          {route.capacity_per_min != null && <div>Capacity: {route.capacity_per_min}/min</div>}
        </div>
      </Tooltip>
    </Polyline>
  );
};
