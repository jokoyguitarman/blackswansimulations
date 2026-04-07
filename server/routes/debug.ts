import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { fetchVenueBuilding } from '../services/osmVicinityService.js';
import { generateStudGrids } from '../services/buildingStudService.js';
import { logger } from '../lib/logger.js';

const router = Router();

/**
 * GET /api/debug/building-studs?lat=...&lng=...&radius=300
 *
 * Diagnostic endpoint: fetch building footprints from Overpass and generate
 * stud grids without going through the full scenario pipeline.
 */
router.get('/building-studs', requireAuth, async (req, res) => {
  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);
  const radius = parseInt(req.query.radius as string, 10) || 300;

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({ error: 'lat and lng query params are required' });
  }

  const t0 = Date.now();
  let buildings;
  let fetchError: string | null = null;

  try {
    buildings = await fetchVenueBuilding(lat, lng, radius);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, lat, lng, radius }, 'Debug building-studs fetch failed');
    fetchError = msg;
    buildings = [];
  }

  const fetchMs = Date.now() - t0;
  const withPolygon = buildings.filter(
    (b) => b.footprint_polygon && b.footprint_polygon.length >= 3,
  );

  let grids: ReturnType<typeof generateStudGrids> = [];
  let gridMs = 0;
  if (withPolygon.length > 0) {
    const t1 = Date.now();
    grids = generateStudGrids(withPolygon);
    gridMs = Date.now() - t1;
  }

  const totalStuds = grids.reduce((s, g) => g.studs.length + s, 0);

  const payload = {
    stats: {
      fetchMs,
      gridMs,
      buildingsReturned: buildings.length,
      buildingsWithPolygon: withPolygon.length,
      gridsGenerated: grids.length,
      totalStuds,
      payloadSizeKB: Math.round(JSON.stringify(withPolygon).length / 1024),
      fetchError,
    },
    buildings: withPolygon.map((b) => ({
      name: b.name,
      lat: b.lat,
      lng: b.lng,
      levels: b.building_levels ?? null,
      use: b.building_use ?? null,
      polygonPoints: b.footprint_polygon?.length ?? 0,
    })),
    grids: grids.map((g) => ({
      buildingIndex: g.buildingIndex,
      buildingName: g.buildingName,
      polygon: g.polygon,
      floors: g.floors,
      spacingM: g.spacingM,
      studs: g.studs.map((s) => ({
        id: s.id,
        lat: s.lat,
        lng: s.lng,
        floor: s.floor,
      })),
    })),
  };

  return res.json(payload);
});

export { router as debugRouter };
