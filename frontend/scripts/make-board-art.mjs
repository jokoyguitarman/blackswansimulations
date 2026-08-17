// Optimises the six storyboard illustrations. Each sits in a wide strip beside or
// above the board copy, so 960px covers 2x on the widest slot it ever occupies.
// Usage: node scripts/make-board-art.mjs <directory-of-source-pngs>
import sharp from 'sharp';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const assets = process.argv[2];
const out = join(here, '..', 'public', 'marketing');

const names = [
  'board-1-confirmed',
  'board-2-footage',
  'board-3-deadlock',
  'board-4-silence',
  'board-5-correcting',
  'board-6-contained',
];

for (const name of names) {
  const src = join(assets, `${name}.png`);
  await sharp(src)
    .resize({ width: 960, height: 540, fit: 'cover', position: 'centre' })
    .webp({ quality: 68 })
    .toFile(join(out, `${name}.webp`));
  const { size } = await stat(join(out, `${name}.webp`));
  console.log(`${name}.webp  ${String(size).padStart(7)} bytes`);
}
