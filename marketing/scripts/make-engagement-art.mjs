// Optimises the artwork for the "one engagement, three deliverables" cards and
// the data-handling band beneath them. Deliverable art sits in a card header, so
// it is cropped wide and shallow; the privacy band spans the full section.
// Usage: node scripts/make-engagement-art.mjs <directory-of-source-pngs>
import sharp from 'sharp';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const assets = process.argv[2];
const out = join(here, '..', 'public', 'marketing');

const jobs = [
  { name: 'deliverable-1-build', width: 760, height: 300 },
  { name: 'deliverable-2-simulations', width: 760, height: 300 },
  { name: 'deliverable-3-review', width: 760, height: 300 },
  { name: 'privacy-isolation', width: 1280, height: 440 },
];

for (const { name, width, height } of jobs) {
  await sharp(join(assets, `${name}.png`))
    .resize({ width, height, fit: 'cover', position: 'centre' })
    .webp({ quality: 66 })
    .toFile(join(out, `${name}.webp`));
  const { size } = await stat(join(out, `${name}.webp`));
  console.log(`${name}.webp  ${String(size).padStart(7)} bytes`);
}
