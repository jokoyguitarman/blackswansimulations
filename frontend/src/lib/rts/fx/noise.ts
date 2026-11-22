/**
 * Tileable value noise, two octaves. Generated once. Node has no ImageData,
 * so the fallback is a plain { width, height, data } with the same fields.
 */
export function makeValueNoiseTexture(size: number, seed: number): ImageData {
  const data = new Uint8ClampedArray(size * size * 4);
  const acc = new Float32Array(size * size);
  addOctave(acc, size, 8, seed, 0.65);
  addOctave(acc, size, 16, seed + 101, 0.35);
  for (let i = 0; i < acc.length; i++) {
    const o = i * 4;
    data[o] = 255;
    data[o + 1] = 255;
    data[o + 2] = 255;
    data[o + 3] = Math.round(acc[i] * 255);
  }
  const Ctor = globalThis.ImageData;
  if (typeof Ctor === 'function') return new Ctor(data, size, size);
  return { width: size, height: size, data } as ImageData;
}

function addOctave(acc: Float32Array, size: number, cells: number, seed: number, weight: number): void {
  for (let y = 0; y < size; y++) {
    const gy = (y / size) * cells;
    const y0 = Math.floor(gy) % cells;
    const y1 = (y0 + 1) % cells;
    const sy = smooth(gy - Math.floor(gy));
    for (let x = 0; x < size; x++) {
      const gx = (x / size) * cells;
      const x0 = Math.floor(gx) % cells;
      const x1 = (x0 + 1) % cells;
      const sx = smooth(gx - Math.floor(gx));
      const v00 = hash2(x0, y0, seed);
      const v10 = hash2(x1, y0, seed);
      const v01 = hash2(x0, y1, seed);
      const v11 = hash2(x1, y1, seed);
      const v =
        v00 * (1 - sx) * (1 - sy) +
        v10 * sx * (1 - sy) +
        v01 * (1 - sx) * sy +
        v11 * sx * sy;
      acc[y * size + x] += v * weight;
    }
  }
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(ix + 1, 0x27d4eb2d) ^ Math.imul(iy + 1, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
