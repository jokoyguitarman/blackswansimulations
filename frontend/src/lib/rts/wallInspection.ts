import type { Vec2 } from '../evacuation/types';

// ── Types ───────────────────────────────────────────────────────────────

export type ImageSource = 'streetview' | 'custom' | 'none';

export interface WallInspectionPoint {
  id: string;
  wallIndex: number;
  lat: number;
  lng: number;
  cameraLat: number;
  cameraLng: number;
  heading: number;
  simPos: Vec2;
  imageUrl: string | null;
  cached: boolean;
  imageSource: ImageSource;
}

// ── IndexedDB cache ─────────────────────────────────────────────────────

const DB_NAME = 'bss_streetview_cache';
const DB_VERSION = 1;
const STORE_NAME = 'images';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getCachedImage(key: string): Promise<string | null> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function setCachedImage(key: string, dataUrl: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(dataUrl, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Silently fail — cache is optional
  }
}

// ── Generate inspection points along building perimeter ─────────────────

const POINT_SPACING_METERS = 12;
const CAMERA_OFFSET_METERS = 28;

/**
 * Generate wall inspection points at regular intervals along each edge
 * of the building polygon.
 *
 * @param polygon Original lat/lng polygon vertices
 * @param projectedVerts Meter-space projected vertices
 * @param spacingM Distance between points in meters (default 12)
 */
export function generateWallPoints(
  polygon: [number, number][],
  projectedVerts: Vec2[],
  spacingM: number = POINT_SPACING_METERS,
): WallInspectionPoint[] {
  const points: WallInspectionPoint[] = [];
  const n = polygon.length;
  if (n < 3) return points;

  // Compute polygon centroid in lat/lng for inward direction reference
  let cLat = 0,
    cLng = 0;
  for (const [la, ln] of polygon) {
    cLat += la;
    cLng += ln;
  }
  cLat /= n;
  cLng /= n;

  let pointId = 0;

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [aLat, aLng] = polygon[i];
    const [bLat, bLng] = polygon[j];

    const aM = projectedVerts[i];
    const bM = projectedVerts[j];
    const edgeLen = Math.hypot(bM.x - aM.x, bM.y - aM.y);
    if (edgeLen < spacingM * 0.5) continue;

    // Outward normal: perpendicular to edge, pointing away from centroid
    const edgeDx = bM.x - aM.x;
    const edgeDy = bM.y - aM.y;
    // Two perpendicular candidates
    let nx = -edgeDy / edgeLen;
    let ny = edgeDx / edgeLen;
    // Pick the one pointing away from centroid
    const midMx = (aM.x + bM.x) / 2;
    const midMy = (aM.y + bM.y) / 2;
    // Centroid in meters (approx 0,0 since projection centers on centroid)
    let cMx = 0,
      cMy = 0;
    for (const v of projectedVerts) {
      cMx += v.x;
      cMy += v.y;
    }
    cMx /= projectedVerts.length;
    cMy /= projectedVerts.length;

    const toCenter = (cMx - midMx) * nx + (cMy - midMy) * ny;
    if (toCenter > 0) {
      nx = -nx;
      ny = -ny;
    }

    const numPoints = Math.max(1, Math.floor(edgeLen / spacingM));
    for (let k = 0; k < numPoints; k++) {
      const t = numPoints === 1 ? 0.5 : (k + 0.5) / numPoints;

      // Wall position in lat/lng
      const pLat = aLat + t * (bLat - aLat);
      const pLng = aLng + t * (bLng - aLng);

      // Sim-meter position on wall
      const pMx = aM.x + t * (bM.x - aM.x);
      const pMy = aM.y + t * (bM.y - aM.y);

      // Camera position offset outward in lat/lng
      // Convert meter offset to approximate lat/lng offset
      const metersPerDegLat = 111320;
      const metersPerDegLng = 111320 * Math.cos((pLat * Math.PI) / 180);
      const camLat = pLat + (ny * CAMERA_OFFSET_METERS) / metersPerDegLat;
      const camLng = pLng + (nx * CAMERA_OFFSET_METERS) / metersPerDegLng;

      // Heading: direction from camera toward wall (degrees from north, clockwise)
      const dLat = pLat - camLat;
      const dLng = pLng - camLng;
      const headingRad = Math.atan2(dLng, dLat);
      const heading = ((headingRad * 180) / Math.PI + 360) % 360;

      points.push({
        id: `wp-${i}-${pointId++}`,
        wallIndex: i,
        lat: pLat,
        lng: pLng,
        cameraLat: camLat,
        cameraLng: camLng,
        heading,
        simPos: { x: pMx, y: pMy },
        imageUrl: null,
        cached: false,
        imageSource: 'none',
      });
    }
  }

  return points;
}

// ── Fetch Street View image ─────────────────────────────────────────────

const STREETVIEW_SIZE = '600x400';
const STREETVIEW_FOV = 90;
const STREETVIEW_PITCH = 5;

function getStreetViewUrl(point: WallInspectionPoint, apiKey: string): string {
  return (
    `https://maps.googleapis.com/maps/api/streetview` +
    `?size=${STREETVIEW_SIZE}` +
    `&location=${point.cameraLat},${point.cameraLng}` +
    `&heading=${Math.round(point.heading)}` +
    `&pitch=${STREETVIEW_PITCH}` +
    `&fov=${STREETVIEW_FOV}` +
    `&source=outdoor` +
    `&key=${apiKey}`
  );
}

function getMetadataUrl(point: WallInspectionPoint, apiKey: string): string {
  return (
    `https://maps.googleapis.com/maps/api/streetview/metadata` +
    `?location=${point.cameraLat},${point.cameraLng}` +
    `&source=outdoor` +
    `&key=${apiKey}`
  );
}

/**
 * Check whether Google has outdoor Street View coverage at this point.
 * The metadata API is free and tells us if imagery exists before we pay
 * for the actual image fetch.
 */
async function hasOutdoorCoverage(point: WallInspectionPoint, apiKey: string): Promise<boolean> {
  try {
    const resp = await fetch(getMetadataUrl(point, apiKey));
    if (!resp.ok) return false;
    const data = await resp.json();
    return data.status === 'OK';
  } catch {
    return false;
  }
}

/**
 * Fetch a Street View image as a blob and convert to data URL for caching.
 * Returns the data URL, or null if no outdoor coverage exists or the fetch failed.
 */
export async function fetchStreetViewImage(
  point: WallInspectionPoint,
  apiKey: string,
): Promise<string | null> {
  const cacheKey = `sv_outdoor_${point.cameraLat.toFixed(6)}_${point.cameraLng.toFixed(6)}_${Math.round(point.heading)}`;

  // Check IndexedDB cache first
  const cached = await getCachedImage(cacheKey);
  if (cached) return cached;

  // Verify outdoor coverage exists (metadata API is free)
  const hasCoverage = await hasOutdoorCoverage(point, apiKey);
  if (!hasCoverage) return null;

  // Fetch the actual image
  try {
    const url = getStreetViewUrl(point, apiKey);
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const blob = await resp.blob();

    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        setCachedImage(cacheKey, dataUrl).catch(() => {});
        resolve(dataUrl);
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}
