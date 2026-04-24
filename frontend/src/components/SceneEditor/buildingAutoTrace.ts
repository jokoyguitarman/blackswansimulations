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

// ── Helper: RGB distance between two pixel indices ────────────────────────

function rgbDist(data: Uint8ClampedArray, i: number, j: number): number {
  const dr = data[i] - data[j];
  const dg = data[i + 1] - data[j + 1];
  const db = data[i + 2] - data[j + 2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function rgbDistToColor(
  data: Uint8ClampedArray,
  i: number,
  r: number,
  g: number,
  b: number,
): number {
  const dr = data[i] - r;
  const dg = data[i + 1] - g;
  const db = data[i + 2] - b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

// ── Sample target color: 5x5 median around click point ───────────────────

function sampleTargetColor(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  cx: number,
  cy: number,
): { r: number; g: number; b: number } | null {
  const samples: Array<{ r: number; g: number; b: number }> = [];
  const radius = 2; // 5x5 grid

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const idx = (y * width + x) * 4;
      const lum = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
      if (lum < 40) continue; // skip dark text pixels
      samples.push({ r: data[idx], g: data[idx + 1], b: data[idx + 2] });
    }
  }

  if (samples.length === 0) return null;

  // Median of each channel independently
  samples.sort((a, b) => a.r - b.r);
  const medR = samples[Math.floor(samples.length / 2)].r;
  samples.sort((a, b) => a.g - b.g);
  const medG = samples[Math.floor(samples.length / 2)].g;
  samples.sort((a, b) => a.b - b.b);
  const medB = samples[Math.floor(samples.length / 2)].b;

  return { r: medR, g: medG, b: medB };
}

// ── Gradient computation with 3x3 average smoothing ──────────────────────

function computeSmoothedGradient(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array {
  // First pass: per-pixel gradient magnitude
  const rawGrad = new Float32Array(width * height);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const l = (y * width + (x - 1)) * 4;
      const r = (y * width + (x + 1)) * 4;
      const t = ((y - 1) * width + x) * 4;
      const b = ((y + 1) * width + x) * 4;

      // Luminance gradient
      const lLum = data[l] * 0.299 + data[l + 1] * 0.587 + data[l + 2] * 0.114;
      const rLum = data[r] * 0.299 + data[r + 1] * 0.587 + data[r + 2] * 0.114;
      const tLum = data[t] * 0.299 + data[t + 1] * 0.587 + data[t + 2] * 0.114;
      const bLum = data[b] * 0.299 + data[b + 1] * 0.587 + data[b + 2] * 0.114;

      const gx = rLum - lLum;
      const gy = bLum - tLum;
      let grad = Math.sqrt(gx * gx + gy * gy);

      // RGB gradient (catches colored edges that luminance misses)
      const rgbGx = Math.sqrt(
        (data[r] - data[l]) ** 2 +
          (data[r + 1] - data[l + 1]) ** 2 +
          (data[r + 2] - data[l + 2]) ** 2,
      );
      const rgbGy = Math.sqrt(
        (data[b] - data[t]) ** 2 +
          (data[b + 1] - data[t + 1]) ** 2 +
          (data[b + 2] - data[t + 2]) ** 2,
      );
      const rgbGrad = Math.max(rgbGx, rgbGy) * 0.5;
      if (rgbGrad > grad) grad = rgbGrad;

      rawGrad[y * width + x] = grad;
    }
  }

  // Second pass: 3x3 average smoothing (denoises single-pixel spikes)
  const smoothed = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          sum += rawGrad[(y + dy) * width + (x + dx)];
          count++;
        }
      }
      smoothed[y * width + x] = sum / count;
    }
  }

  return smoothed;
}

// ── Edge-aware flood fill with relative tolerance ────────────────────────

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

  // Multi-sample target color (5x5 median)
  const target = sampleTargetColor(data, width, height, sx, sy);
  if (!target) return mask; // clicked on text or very dark area

  // Local tolerance: generous for neighbor-to-neighbor (same surface)
  const localTolerance = 12 + tolerance * 0.3;
  // Global tolerance: loose drift limit from click color
  const globalTolerance = 30 + tolerance * 1.5;

  // Pre-compute smoothed gradient edge map
  const gradient = computeSmoothedGradient(data, width, height);

  // Relaxed edge threshold: only strong building boundaries block
  const edgeThreshold = 15 + tolerance * 0.5;

  // Queue stores [x, y, parentPixelIndex]
  const startPI = (sy * width + sx) * 4;
  const queue: number[] = [sx, sy, startPI];
  mask[sy * width + sx] = 1;
  const maxPixels = width * height * 0.3;
  let filled = 0;

  while (queue.length > 0 && filled < maxPixels) {
    const parentPI = queue.pop()!;
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

      // Strong edge barrier (smoothed gradient)
      if (gradient[ni] > edgeThreshold) continue;

      const pi = ni * 4;

      // Skip very dark pixels (text/labels)
      const lum = data[pi] * 0.299 + data[pi + 1] * 0.587 + data[pi + 2] * 0.114;
      if (lum < 40) continue;

      // Local check: is this pixel similar to its parent? (handles gradients)
      const localDist = rgbDist(data, pi, parentPI);
      if (localDist > localTolerance) continue;

      // Global check: hasn't drifted too far from original click color
      const globalDist = rgbDistToColor(data, pi, target.r, target.g, target.b);
      if (globalDist > globalTolerance) continue;

      mask[ni] = 1;
      queue.push(nx, ny, pi);
    }
  }

  return mask;
}

// ── Morphological close (dilate then erode) ──────────────────────────────

export function morphologicalClose(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number = 2,
): Uint8Array {
  // Dilate: expand filled regions
  const dilated = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 1) {
        dilated[y * width + x] = 1;
        continue;
      }
      let found = false;
      outer: for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height && mask[ny * width + nx] === 1) {
            found = true;
            break outer;
          }
        }
      }
      dilated[y * width + x] = found ? 1 : 0;
    }
  }

  // Erode: shrink back to original size (but holes are now filled)
  const result = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (dilated[y * width + x] === 0) continue;
      let allFilled = true;
      outer2: for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height && dilated[ny * width + nx] === 0) {
            allFilled = false;
            break outer2;
          }
        }
      }
      result[y * width + x] = allFilled ? 1 : 0;
    }
  }

  return result;
}

// ── Contour extraction (Moore neighborhood tracing) ──────────────────────

export function extractContour(
  mask: Uint8Array,
  width: number,
  height: number,
): Array<{ x: number; y: number }> {
  let startX = -1;
  let startY = -1;
  for (let y = 0; y < height && startX < 0; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 1) {
        const hasEmpty =
          x === 0 ||
          y === 0 ||
          x === width - 1 ||
          y === height - 1 ||
          mask[y * width + (x - 1)] === 0 ||
          mask[y * width + (x + 1)] === 0 ||
          mask[(y - 1) * width + x] === 0 ||
          mask[(y + 1) * width + x] === 0;
        if (hasEmpty) {
          startX = x;
          startY = y;
          break;
        }
      }
    }
  }

  if (startX < 0) return [];

  const dx = [-1, -1, 0, 1, 1, 1, 0, -1];
  const dy = [0, -1, -1, -1, 0, 1, 1, 1];
  const contour: Array<{ x: number; y: number }> = [];
  let cx = startX;
  let cy = startY;
  let dir = 0;
  const maxSteps = width * height;

  for (let step = 0; step < maxSteps; step++) {
    contour.push({ x: cx, y: cy });
    let found = false;
    const searchStart = (dir + 5) % 8;
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

// ── Douglas-Peucker polygon simplification ───────────────────────────────

export function simplifyPolygon(
  points: Array<{ x: number; y: number }>,
  epsilon: number = 2.5,
): Array<{ x: number; y: number }> {
  if (points.length <= 2) return points;

  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], first, last);
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

function perpDist(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.0001) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dx * (a.y - p.y) - dy * (a.x - p.x)) / len;
}

// ── Pixel → lat/lng conversion ───────────────────────────────────────────

export function pixelsToLatLng(
  points: Array<{ x: number; y: number }>,
  map: L.Map,
): [number, number][] {
  return points.map((p) => {
    const ll = map.containerPointToLatLng([p.x, p.y]);
    return [ll.lat, ll.lng] as [number, number];
  });
}

// ── Full auto-trace pipeline ─────────────────────────────────────────────

export async function autoTraceBuilding(
  map: L.Map,
  clickX: number,
  clickY: number,
  tolerance: number = 20,
): Promise<{ polygon: [number, number][]; pixelCount: number }> {
  const imageData = await captureMapPixels(map);
  let mask = floodFillMask(imageData, clickX, clickY, tolerance);

  const pixelCount = mask.reduce((s, v) => s + v, 0);
  if (pixelCount < 50) {
    return { polygon: [], pixelCount };
  }

  // Morphological close to fill text/icon holes
  mask = morphologicalClose(mask, imageData.width, imageData.height, 3);

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
