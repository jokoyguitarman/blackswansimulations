import { Router } from 'express';

const router = Router();

/**
 * Tile proxy: fetches OSM tiles and serves them with CORS headers
 * so the frontend can read tile pixel data for building auto-trace.
 */
router.get('/:z/:x/:y.png', async (req, res) => {
  const { z, x, y } = req.params;
  const subdomains = ['a', 'b', 'c'];
  const sub = subdomains[Math.abs(parseInt(x) + parseInt(y)) % subdomains.length];
  const url = `https://${sub}.tile.openstreetmap.org/${z}/${x}/${y}.png`;

  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'BlackSwanSimulations/1.0' },
    });

    if (!resp.ok) {
      res.status(resp.status).end();
      return;
    }

    const buffer = Buffer.from(await resp.arrayBuffer());

    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    });
    res.send(buffer);
  } catch {
    res.status(502).end();
  }
});

export const tileProxyRouter = router;
