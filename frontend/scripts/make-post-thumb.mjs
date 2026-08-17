// Cuts a wide thumbnail for the photo attached to the hero feed post. The slot is
// ~440x80 CSS pixels, so 880x176 covers 2x displays without shipping a full image.
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const marketing = join(here, '..', 'public', 'marketing');
const docs = join(here, '..', '..', 'docs');

const source = join(marketing, 'crisis-site-response.webp');
const name = 'post-site-photo.webp';

// Pull the crop from slightly above centre: that is where the marshal, the cordon
// tape and the crowd all sit, and it survives being letterboxed to a thin strip.
const buffer = await sharp(source)
  .resize({ width: 880, withoutEnlargement: true })
  .extract({ left: 0, top: 150, width: 880, height: 176 })
  .webp({ quality: 74 })
  .toBuffer();

for (const dir of [marketing, docs]) {
  await sharp(buffer).toFile(join(dir, name));
}

const { size } = await import('node:fs/promises').then((fs) => fs.stat(join(docs, name)));
console.log(`${name}: 880x176, ${size.toLocaleString()} bytes`);
