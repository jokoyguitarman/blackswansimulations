import { svg } from '../../components/COP/mapIcons';

const RENDER_SIZE = 48;
const cache = new Map<string, HTMLImageElement>();
let preloaded = false;

const PRELOAD_KEYS = [
  'explosion',
  'fire',
  'chemical',
  'collapse',
  'debris',
  'gas',
  'flood',
  'biohazard',
  'electrical',
  'smoke',
  'hazard_generic',
  'hospital',
  'police',
  'fire_station',
  'siren',
  'door',
  'staging',
  'flag',
  'pin',
  'cctv',
  'cordon',
  'community',
  'command',
  'person',
  'person_trapped',
  'stretcher',
  'deceased',
  'resolved',
  'crowd',
  'medical_cross',
  'ambulance',
  'tent',
  'barrier',
  'bomb',
  'bomb_robot',
  'blast_shield',
  'radio',
  'clipboard',
];

function loadIcon(key: string): void {
  if (cache.has(key)) return;
  const svgStr = svg(key, RENDER_SIZE);
  if (!svgStr) return;

  const blob = new Blob([svgStr], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const img = new Image(RENDER_SIZE, RENDER_SIZE);
  img.onload = () => URL.revokeObjectURL(url);
  img.onerror = () => {
    URL.revokeObjectURL(url);
    cache.delete(key);
  };
  img.src = url;
  cache.set(key, img);
}

export function preloadIcons(): void {
  if (preloaded) return;
  preloaded = true;
  for (const key of PRELOAD_KEYS) loadIcon(key);
}

export function getIcon(key: string): HTMLImageElement | null {
  if (!preloaded) preloadIcons();
  const img = cache.get(key);
  if (!img) {
    loadIcon(key);
    return cache.get(key) ?? null;
  }
  return img;
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
  poi: 'command',
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
