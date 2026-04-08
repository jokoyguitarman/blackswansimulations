import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { fetchVenueBuilding, type OsmBuilding } from '../services/osmVicinityService.js';
import {
  generateStudGrids,
  generateBlastRadiusStuds,
  classifyStudZones,
  snapCoordinate,
  findContainingGrid,
  findNearestGrid,
  BLAST_BANDS_EXPLOSIVE,
  BLAST_BANDS_MELEE,
  BLAST_BANDS_DEFAULT,
  type StudGrid,
  type BlastBandConfig,
} from '../services/buildingStudService.js';
import { haversineM } from '../services/geoUtils.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';

const router = Router();

function pickBlastBands(weaponClass: string | undefined): BlastBandConfig[] {
  if (weaponClass === 'explosive') return BLAST_BANDS_EXPLOSIVE;
  if (weaponClass?.startsWith('melee')) return BLAST_BANDS_MELEE;
  return BLAST_BANDS_DEFAULT;
}

// In-memory grid cache for snap-test reuse within the same session
let lastGridsKey = '';
let lastGrids: StudGrid[] = [];

/**
 * GET /api/debug/building-studs?lat=...&lng=...&radius=300
 *   &hazardLat=...&hazardLng=...&weaponClass=explosive
 *   &scenarioId=...  (optional — loads cached buildings from DB instead of Overpass)
 *
 * Diagnostic endpoint: fetch building footprints from Overpass (or DB cache)
 * and generate stud grids. When hazard params are provided, also generates
 * blast radius outdoor studs and classifies all studs with blast band metadata.
 */
router.get('/building-studs', requireAuth, async (req, res) => {
  const scenarioId = (req.query.scenarioId as string) || undefined;

  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);
  const radius = parseInt(req.query.radius as string, 10) || 300;

  if (!scenarioId && (Number.isNaN(lat) || Number.isNaN(lng))) {
    return res.status(400).json({ error: 'lat and lng query params are required (or scenarioId)' });
  }

  const hazardLat = parseFloat(req.query.hazardLat as string);
  const hazardLng = parseFloat(req.query.hazardLng as string);
  const weaponClass = (req.query.weaponClass as string) || undefined;
  const hasHazard = !Number.isNaN(hazardLat) && !Number.isNaN(hazardLng);

  const t0 = Date.now();
  let buildings: OsmBuilding[] = [];
  let fetchError: string | null = null;
  let fetchSource: 'overpass' | 'scenario_cache' = 'overpass';

  if (scenarioId) {
    // Load cached building data from scenario's insider_knowledge
    fetchSource = 'scenario_cache';
    try {
      const { data: sc } = await supabaseAdmin
        .from('scenarios')
        .select('insider_knowledge')
        .eq('id', scenarioId)
        .single();

      if (!sc) {
        return res.status(404).json({ error: `Scenario ${scenarioId} not found` });
      }

      const ik = sc.insider_knowledge as Record<string, unknown> | null;
      const osmVicinity = ik?.osm_vicinity as Record<string, unknown> | undefined;
      const cachedBuildings = osmVicinity?.buildings as OsmBuilding[] | undefined;
      buildings = cachedBuildings ?? [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err, scenarioId }, 'Debug building-studs scenario fetch failed');
      fetchError = msg;
      buildings = [];
    }
  } else {
    try {
      buildings = await fetchVenueBuilding(lat, lng, radius);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err, lat, lng, radius }, 'Debug building-studs Overpass fetch failed');
      fetchError = msg;
      buildings = [];
    }
  }

  const fetchMs = Date.now() - t0;
  const withPolygon = buildings.filter(
    (b) => b.footprint_polygon && b.footprint_polygon.length >= 3,
  );

  const grids: StudGrid[] = [];
  let gridMs = 0;
  if (withPolygon.length > 0) {
    const t1 = Date.now();
    grids.push(...generateStudGrids(withPolygon));
    gridMs = Date.now() - t1;
  }

  let blastStudCount = 0;
  let blastBandsUsed: BlastBandConfig[] = [];

  if (hasHazard) {
    const bands = pickBlastBands(weaponClass);
    blastBandsUsed = bands;
    const hazardCenters = [{ lat: hazardLat, lng: hazardLng }];

    // Classify building studs
    classifyStudZones(grids, hazardCenters, [], bands);

    // Generate outdoor blast radius studs
    const blastGrid = generateBlastRadiusStuds(hazardCenters, bands, grids);
    if (blastGrid) {
      blastStudCount = blastGrid.studs.length;
      grids.push(blastGrid);
    }
  }

  const buildingStuds = grids
    .filter((g) => g.buildingIndex >= 0)
    .reduce((s, g) => s + g.studs.length, 0);
  const totalStuds = buildingStuds + blastStudCount;

  // Cache grids for snap-test
  lastGridsKey = scenarioId ? `scenario:${scenarioId}` : `${lat},${lng},${radius}`;
  lastGrids = grids;

  // Per-band counts
  const bandCounts: Record<string, number> = {};
  for (const g of grids) {
    for (const s of g.studs) {
      if (s.blastBand) {
        bandCounts[s.blastBand] = (bandCounts[s.blastBand] || 0) + 1;
      }
    }
  }

  const payload = {
    stats: {
      fetchMs,
      fetchSource,
      gridMs,
      buildingsReturned: buildings.length,
      buildingsWithPolygon: withPolygon.length,
      gridsGenerated: grids.filter((g) => g.buildingIndex >= 0).length,
      totalStuds,
      buildingStuds,
      outdoorStuds: blastStudCount,
      bandCounts,
      weaponClass: weaponClass ?? 'default',
      blastBands: blastBandsUsed.map((b) => ({ band: b.band, minM: b.minM, maxM: b.maxM })),
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
        studType: s.studType,
        blastBand: s.blastBand ?? null,
        operationalZone: s.operationalZone ?? null,
        distFromIncidentM: s.distFromIncidentM != null ? Math.round(s.distFromIncidentM) : null,
      })),
    })),
  };

  return res.json(payload);
});

/**
 * POST /api/debug/snap-test
 *
 * Test the snap-to-stud algorithm. Uses the grids from the last
 * GET /debug/building-studs call (cached in memory).
 */
router.post('/snap-test', requireAuth, (req, res) => {
  const {
    lat,
    lng,
    floor = 'G',
    occupiedStudIds = [],
  } = req.body as {
    lat: number;
    lng: number;
    floor?: string;
    occupiedStudIds?: string[];
  };

  if (lat == null || lng == null) {
    return res.status(400).json({ error: 'lat and lng are required in the request body' });
  }

  if (lastGrids.length === 0) {
    return res.status(400).json({
      error: 'No grids cached. Call GET /debug/building-studs first.',
    });
  }

  const occupied = new Set(occupiedStudIds);
  const buildingGrids = lastGrids.filter((g) => g.buildingIndex >= 0);
  const result = snapCoordinate(lat, lng, floor, buildingGrids, occupied);

  let studMetadata = null;
  if (result.studId) {
    const grid =
      findContainingGrid(result.lat, result.lng, buildingGrids) ??
      findNearestGrid(result.lat, result.lng, buildingGrids);
    if (grid) {
      const stud = grid.studs.find((s) => s.id === result.studId);
      if (stud) {
        studMetadata = {
          id: stud.id,
          lat: stud.lat,
          lng: stud.lng,
          floor: stud.floor,
          studType: stud.studType,
          buildingIndex: stud.buildingIndex,
          blastBand: stud.blastBand ?? null,
          operationalZone: stud.operationalZone ?? null,
          distFromIncidentM:
            stud.distFromIncidentM != null ? Math.round(stud.distFromIncidentM) : null,
        };
      }
    }
  }

  return res.json({
    input: { lat, lng, floor },
    snapped: {
      lat: result.lat,
      lng: result.lng,
      studId: result.studId,
    },
    snapDistM: result.studId
      ? Math.round(haversineM(lat, lng, result.lat, result.lng) * 100) / 100
      : null,
    studMetadata,
    gridsKey: lastGridsKey,
  });
});

export { router as debugRouter };
