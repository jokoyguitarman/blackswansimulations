import { svg } from '../../components/COP/mapIcons';

const cache = new Map<string, HTMLImageElement>();
const loading = new Set<string>();

/**
 * Get a cached HTMLImageElement rendered from an SVG icon in mapIcons.ts.
 * Returns null on first call while the image loads; subsequent calls return
 * the ready image. This avoids blocking the render loop.
 */
export function getIcon(key: string, size = 24): HTMLImageElement | null {
  const cacheKey = `${key}_${size}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.complete && cached.naturalWidth > 0) return cached;
  if (loading.has(cacheKey)) return null;

  const svgStr = svg(key, size);
  if (!svgStr) return null;

  loading.add(cacheKey);
  const img = new Image();
  img.onload = () => {
    cache.set(cacheKey, img);
    loading.delete(cacheKey);
  };
  img.onerror = () => {
    loading.delete(cacheKey);
  };
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);
  cache.set(cacheKey, img);
  return null;
}

/** Category-to-icon-key mapping for scenario locations */
export const LOCATION_ICON_KEY: Record<string, string> = {
  hospital: 'hospital',
  police: 'police',
  fire_station: 'fire_station',
  incident_site: 'siren',
  entry_exit: 'door',
  staging_area: 'staging',
  assembly_point: 'flag',
  poi: 'pin',
  cctv: 'cctv',
  cordon: 'cordon',
  community: 'community',
};

/** Hazard type to icon key mapping */
export const HAZARD_ICON_KEY: Record<string, string> = {
  combustible: 'fire',
  ignitable: 'explosion',
  debris_risk: 'debris',
  falling_object: 'hazard_generic',
  electrical: 'electrical',
  chemical: 'chemical',
  gas: 'gas',
  smoke: 'smoke',
  flood: 'flood',
  biohazard: 'biohazard',
  collapse: 'collapse',
};
