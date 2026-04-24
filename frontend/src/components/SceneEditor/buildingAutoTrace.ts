import type L from 'leaflet';

/**
 * Capture the visible map tiles as pixel data by compositing tile <img>
 * elements onto an offscreen canvas. Tiles must be served with CORS
 * headers (via the /api/tiles proxy) for getImageData to work.
 */
export function captureMapPixels(map: L.Map): ImageData {
  const container = map.getContainer();
  const { width, height } = container.getBoundingClientRect();
  const w = Math.round(width);
  const h = Math.round(height);

  const offscreen = document.createElement('canvas');
  offscreen.width = w;
  offscreen.height = h;
  const ctx = offscreen.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');

  // White background (matches OSM tile background)
  ctx.fillStyle = '#f2efe9';
  ctx.fillRect(0, 0, w, h);

  // Find all tile images in the tile pane and draw them at their CSS positions
  const tilePane = container.querySelector('.leaflet-tile-pane');
  if (tilePane) {
    const imgs = tilePane.querySelectorAll('img.leaflet-tile');
    const containerRect = container.getBoundingClientRect();

    imgs.forEach((img) => {
      const imgEl = img as HTMLImageElement;
      if (!imgEl.complete || imgEl.naturalWidth === 0) return;

      const rect = imgEl.getBoundingClientRect();
      const x = rect.left - containerRect.left;
      const y = rect.top - containerRect.top;

      try {
        ctx.drawImage(imgEl, x, y, rect.width, rect.height);
      } catch {
        // Skip tainted tiles (shouldn't happen with proxy)
      }
    });
  }

  return ctx.getImageData(0, 0, w, h);
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
  const radius = 4; // 9x9 grid for more representative sampling

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const idx = (y * width + x) * 4;
      const lum = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
      if (lum < 60) continue; // skip dark text/icon pixels
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

      // Local check: is this pixel similar to its parent? (handles gradients)
      const localDist = rgbDist(data, pi, parentPI);
      if (localDist > localTolerance) continue;

      // Skip very dark pixels only if they also fail global check
      // (text is both dark AND far from building color)
      const lum = data[pi] * 0.299 + data[pi + 1] * 0.587 + data[pi + 2] * 0.114;
      if (lum < 35) continue;

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

// ── Largest connected component extraction ───────────────────────────────

function largestConnectedComponent(mask: Uint8Array, width: number, height: number): Uint8Array {
  const labels = new Int32Array(width * height);
  let nextLabel = 1;
  const componentSizes = new Map<number, number>();

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (mask[idx] !== 1 || labels[idx] !== 0) continue;

      // BFS to label this component
      const label = nextLabel++;
      let size = 0;
      const q: number[] = [x, y];
      labels[idx] = label;

      while (q.length > 0) {
        const cy = q.pop()!;
        const cx = q.pop()!;
        size++;

        const neighbors = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const ni = ny * width + nx;
          if (mask[ni] === 1 && labels[ni] === 0) {
            labels[ni] = label;
            q.push(nx, ny);
          }
        }
      }
      componentSizes.set(label, size);
    }
  }

  // Find the largest component
  let bestLabel = 0;
  let bestSize = 0;
  for (const [label, size] of componentSizes) {
    if (size > bestSize) {
      bestSize = size;
      bestLabel = label;
    }
  }

  // Create mask with only the largest component
  const result = new Uint8Array(width * height);
  if (bestLabel > 0) {
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === bestLabel) result[i] = 1;
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

/**
 * Show a debug popup with the captured image and flood fill mask overlay.
 */
function showDebugPopup(
  imageData: ImageData,
  mask: Uint8Array,
  clickX: number,
  clickY: number,
  targetColor: { r: number; g: number; b: number } | null,
  pixelCount: number,
  tolerance: number,
) {
  // Remove previous debug popup
  const prev = document.getElementById('autotrace-debug');
  if (prev) prev.remove();

  const { width, height } = imageData;

  const popup = document.createElement('div');
  popup.id = 'autotrace-debug';
  popup.style.cssText = `
    position: fixed; top: 10px; right: 10px; z-index: 10000;
    background: #1a1a2e; border: 2px solid #e94560; border-radius: 8px;
    padding: 10px; color: #eee; font-family: monospace; font-size: 11px;
    max-width: 520px; box-shadow: 0 4px 20px rgba(0,0,0,0.5);
  `;

  // Scale factor for display (don't show full-res)
  const scale = Math.min(500 / width, 300 / height, 1);
  const dw = Math.round(width * scale);
  const dh = Math.round(height * scale);

  // Canvas 1: captured tiles
  const c1 = document.createElement('canvas');
  c1.width = dw;
  c1.height = dh;
  const ctx1 = c1.getContext('2d')!;
  // Draw the captured image scaled down
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = width;
  tempCanvas.height = height;
  tempCanvas.getContext('2d')!.putImageData(imageData, 0, 0);
  ctx1.drawImage(tempCanvas, 0, 0, dw, dh);
  // Draw click point
  ctx1.beginPath();
  ctx1.arc(clickX * scale, clickY * scale, 6, 0, Math.PI * 2);
  ctx1.strokeStyle = '#ff0';
  ctx1.lineWidth = 2;
  ctx1.stroke();
  ctx1.fillStyle = '#ff0';
  ctx1.font = '10px monospace';
  ctx1.fillText(`click (${clickX}, ${clickY})`, clickX * scale + 8, clickY * scale - 4);

  // Canvas 2: mask overlay on tiles
  const c2 = document.createElement('canvas');
  c2.width = dw;
  c2.height = dh;
  const ctx2 = c2.getContext('2d')!;
  ctx2.drawImage(tempCanvas, 0, 0, dw, dh);
  // Overlay mask in red
  const maskOverlay = ctx2.getImageData(0, 0, dw, dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const srcX = Math.floor(x / scale);
      const srcY = Math.floor(y / scale);
      if (srcX < width && srcY < height && mask[srcY * width + srcX] === 1) {
        const idx = (y * dw + x) * 4;
        maskOverlay.data[idx] = 255;
        maskOverlay.data[idx + 1] = Math.floor(maskOverlay.data[idx + 1] * 0.3);
        maskOverlay.data[idx + 2] = Math.floor(maskOverlay.data[idx + 2] * 0.3);
        maskOverlay.data[idx + 3] = 200;
      }
    }
  }
  ctx2.putImageData(maskOverlay, 0, 0);

  // Color swatch
  const colorStr = targetColor
    ? `rgb(${targetColor.r}, ${targetColor.g}, ${targetColor.b})`
    : 'null';

  // Click pixel actual color
  const pi = (Math.round(clickY) * width + Math.round(clickX)) * 4;
  const actualColor = `rgb(${imageData.data[pi]}, ${imageData.data[pi + 1]}, ${imageData.data[pi + 2]})`;

  popup.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
      <b style="color:#e94560;">Auto-Trace Debug</b>
      <button id="autotrace-debug-close" style="background:none;border:none;color:#888;cursor:pointer;font-size:16px;">✕</button>
    </div>
    <div style="display:flex; gap:8px; margin-bottom:8px;">
      <div>
        <div style="color:#888;margin-bottom:2px;">Captured Tiles (${width}x${height})</div>
      </div>
      <div>
        <div style="color:#888;margin-bottom:2px;">Flood Fill Mask (red=filled)</div>
      </div>
    </div>
    <div style="display:flex; gap:8px; margin-bottom:8px;" id="autotrace-debug-canvases"></div>
    <div style="display:flex; gap:12px; align-items:center; margin-bottom:4px;">
      <span>Target: <span style="display:inline-block;width:14px;height:14px;background:${colorStr};border:1px solid #888;vertical-align:middle;"></span> ${colorStr}</span>
      <span>Click px: <span style="display:inline-block;width:14px;height:14px;background:${actualColor};border:1px solid #888;vertical-align:middle;"></span> ${actualColor}</span>
    </div>
    <div>Tolerance: ${tolerance} | Filled: ${pixelCount} px | Tiles found: ${document.querySelectorAll('.leaflet-tile-pane img.leaflet-tile').length}</div>
  `;

  document.body.appendChild(popup);
  const canvasContainer = document.getElementById('autotrace-debug-canvases')!;
  c1.style.border = '1px solid #333';
  c2.style.border = '1px solid #333';
  canvasContainer.appendChild(c1);
  canvasContainer.appendChild(c2);

  document.getElementById('autotrace-debug-close')!.onclick = () => popup.remove();
}

export function autoTraceBuilding(
  map: L.Map,
  clickX: number,
  clickY: number,
  tolerance: number = 20,
): { polygon: [number, number][]; pixelCount: number } {
  const imageData = captureMapPixels(map);

  // Get target color for debug
  const sx = Math.round(clickX);
  const sy = Math.round(clickY);
  const target =
    sx >= 0 && sx < imageData.width && sy >= 0 && sy < imageData.height
      ? sampleTargetColor(imageData.data, imageData.width, imageData.height, sx, sy)
      : null;

  let mask = floodFillMask(imageData, clickX, clickY, tolerance);

  const rawPixelCount = mask.reduce((s, v) => s + v, 0);

  if (rawPixelCount < 50) {
    showDebugPopup(imageData, mask, clickX, clickY, target, rawPixelCount, tolerance);
    return { polygon: [], pixelCount: rawPixelCount };
  }

  // Morphological close to fill text/icon holes
  mask = morphologicalClose(mask, imageData.width, imageData.height, 3);

  // Keep only the largest connected blob (discard small fragments)
  mask = largestConnectedComponent(mask, imageData.width, imageData.height);

  const pixelCount = mask.reduce((s, v) => s + v, 0);

  // Show debug popup with cleaned mask
  showDebugPopup(imageData, mask, clickX, clickY, target, pixelCount, tolerance);

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
