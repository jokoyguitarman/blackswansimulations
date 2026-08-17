// Optimises the four illustrations behind the "what makes it behave like a real
// crisis" reveal cards. Cards are portrait-ish, so the crop is taller than wide.
// Usage: node scripts/make-principle-art.mjs <directory-of-source-pngs>
import sharp from 'sharp';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const assets = process.argv[2];
const out = join(here, '..', 'public', 'marketing');

const names = [
  'principle-1-multiagency',
  'principle-2-asymmetry',
  'principle-3-adaptive',
  'principle-4-interdependency',
];

for (const name of names) {
  await sharp(join(assets, `${name}.png`))
    .resize({ width: 900, height: 620, fit: 'cover', position: 'centre' })
    .webp({ quality: 66 })
    .toFile(join(out, `${name}.webp`));
  const { size } = await stat(join(out, `${name}.webp`));
  console.log(`${name}.webp  ${String(size).padStart(7)} bytes`);
}
