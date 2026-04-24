import html2canvas from 'html2canvas';
import type L from 'leaflet';

/**
 * Capture the visible map tiles as pixel data by screenshotting
 * the Leaflet map container.
 */
export async function captureMapPixels(map: L.Map): Promise<ImageData> {
  const container = map.getContainer();
  const canvas = await html2canvas(container, {
    useCORS: true,
    allowTaint: true,
    logging: false,
    backgroundColor: null,
    scale: 1,
    // Only capture the tile pane, skip controls/overlays
    ignoreElements: (el) => {
      const cls = el.className || '';
      if (typeof cls === 'string') {
        if (cls.includes('leaflet-control')) return true;
        if (cls.includes('leaflet-overlay-pane')) return true;
        if (cls.includes('leaflet-marker-pane')) return true;
        if (cls.includes('leaflet-popup-pane')) return true;
      }
      return false;
    },
  });
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Flood fill from a starting pixel, collecting all connected pixels
 * within a color tolerance. Returns a binary mask.
 */
export function floodFillMask(
  imageData: ImageData,
  startX: number,
  startY: number,
  tolerance: number = 20,
): Uint8Array {
  const { width, height, data } = imageData;
  const mask = new Uint8Array(width * height);

  const sx = Math.round(startX);
  const sy = Math.round(startY);
  if (sx < 0 || sx >= width || sy < 0 || sy >= height) return mask;

  const startIdx = (sy * width + sx) * 4;
  const targetR = data[startIdx];
  const targetG = data[startIdx + 1];
  const targetB = data[startIdx + 2];

  const colorDist = (idx: number): number => {
    const r = data[idx] - targetR;
    const g = data[idx + 1] - targetG;
    const b = data[idx + 2] - targetB;
    return Math.sqrt(r * r + g * g + b * b);
  };

  // Skip if click point is on very dark pixel (text label)
  const brightness = targetR * 0.299 + targetG * 0.587 + targetB * 0.114;
  if (brightness < 40) return mask;

  const queue: number[] = [sx, sy];
  mask[sy * width + sx] = 1;
  const maxPixels = width * height * 0.4; // safety: don't fill more than 40% of screen
  let filled = 0;

  while (queue.length > 0 && filled < maxPixels) {
    const cy = queue.pop()!;
    const cx = queue.pop()!;
    filled++;

    const neighbors = [
      [cx - 1, cy],
      [cx + 1, cy],
      [cx, cy - 1],
      [cx, cy + 1],
    ];

    for (const [nx, ny] of neighbors) {
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const ni = ny * width + nx;
      if (mask[ni]) continue;

      const pi = ni * 4;
      // Skip very dark pixels (text/labels overlaid on buildings)
      const nb = data[pi] * 0.299 + data[pi + 1] * 0.587 + data[pi + 2] * 0.114;
      if (nb < 40) continue;

      if (colorDist(pi) <= tolerance) {
        mask[ni] = 1;
        queue.push(nx, ny);
      }
    }
  }

  return mask;
}

/**
 * Extract the boundary contour of a binary mask using Moore neighborhood tracing.
 * Returns ordered boundary pixel coordinates.
 */
export function extractContour(
  mask: Uint8Array,
  width: number,
  height: number,
): Array<{ x: number; y: number }> {
  // Find the first boundary pixel (top-left scan)
  let startX = -1;
  let startY = -1;
  for (let y = 0; y < height && startX < 0; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 1) {
        // Check if it's on the boundary (has at least one non-mask neighbor)
        const hasEmptyNeighbor =
          x === 0 ||
          y === 0 ||
          x === width - 1 ||
          y === height - 1 ||
          mask[y * width + (x - 1)] === 0 ||
          mask[y * width + (x + 1)] === 0 ||
          mask[(y - 1) * width + x] === 0 ||
          mask[(y + 1) * width + x] === 0;
        if (hasEmptyNeighbor) {
          startX = x;
          startY = y;
          break;
        }
      }
    }
  }

  if (startX < 0) return [];

  // Moore neighborhood: 8 directions clockwise from left
  const dx = [-1, -1, 0, 1, 1, 1, 0, -1];
  const dy = [0, -1, -1, -1, 0, 1, 1, 1];

  const contour: Array<{ x: number; y: number }> = [];
  let cx = startX;
  let cy = startY;
  let dir = 0; // start direction: left
  const maxSteps = width * height;

  for (let step = 0; step < maxSteps; step++) {
    contour.push({ x: cx, y: cy });

    // Search clockwise for next boundary pixel
    let found = false;
    const searchStart = (dir + 5) % 8; // backtrack direction + 1
    for (let i = 0; i < 8; i++) {
      const d = (searchStart + i) % 8;
      const nx = cx + dx[d];
      const ny = cy + dy[d];
      if (nx >= 0 && nx < width && ny >= 0 && ny < height && mask[ny * width + nx] === 1) {
        cx = nx;
        cy = ny;
        dir = d;
        found = true;
        break;
      }
    }

    if (!found) break;
    if (cx === startX && cy === startY && contour.length > 2) break;
  }

  return contour;
}

/**
 * Ramer-Douglas-Peucker polygon simplification.
 * Reduces a dense contour to a small number of meaningful vertices.
 */
export function simplifyPolygon(
  points: Array<{ x: number; y: number }>,
  epsilon: number = 2.5,
): Array<{ x: number; y: number }> {
  if (points.length <= 2) return points;

  // Find the point with the maximum distance from the line between first and last
  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > epsilon) {
    const left = simplifyPolygon(points.slice(0, maxIdx + 1), epsilon);
    const right = simplifyPolygon(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }

  return [first, last];
}

function perpendicularDistance(
  point: { x: number; y: number },
  lineStart: { x: number; y: number },
  lineEnd: { x: number; y: number },
): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.0001) return Math.hypot(point.x - lineStart.x, point.y - lineStart.y);
  return Math.abs(dx * (lineStart.y - point.y) - dy * (lineStart.x - point.x)) / len;
}

/**
 * Convert pixel coordinates to lat/lng using the Leaflet map projection.
 */
export function pixelsToLatLng(
  points: Array<{ x: number; y: number }>,
  map: L.Map,
): [number, number][] {
  return points.map((p) => {
    const ll = map.containerPointToLatLng([p.x, p.y]);
    return [ll.lat, ll.lng] as [number, number];
  });
}

/**
 * Full auto-trace pipeline: capture → flood fill → contour → simplify → convert.
 */
export async function autoTraceBuilding(
  map: L.Map,
  clickX: number,
  clickY: number,
  tolerance: number = 20,
): Promise<{ polygon: [number, number][]; pixelCount: number }> {
  const imageData = await captureMapPixels(map);
  const mask = floodFillMask(imageData, clickX, clickY, tolerance);

  const pixelCount = mask.reduce((s, v) => s + v, 0);
  if (pixelCount < 50) {
    return { polygon: [], pixelCount };
  }

  const contour = extractContour(mask, imageData.width, imageData.height);
  if (contour.length < 3) {
    return { polygon: [], pixelCount };
  }

  const simplified = simplifyPolygon(contour, 2.5);
  if (simplified.length < 3) {
    return { polygon: [], pixelCount };
  }

  const polygon = pixelsToLatLng(simplified, map);
  return { polygon, pixelCount };
}
