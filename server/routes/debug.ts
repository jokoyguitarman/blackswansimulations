import { Router, json } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import {
  fetchVenueBuilding,
  type OsmBuilding,
  type FetchLogEntry,
} from '../services/osmVicinityService.js';
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
import { evaluateBombSquadAssessment } from '../services/rtsVisionService.js';
import {
  generateCasualtySceneImage,
  generateVictimImage,
  evaluateTriageAssessment,
} from '../services/rtsCasualtyService.js';
import { env } from '../env.js';

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
  let fetchLog: FetchLogEntry[] = [];

  if (scenarioId) {
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
      fetchLog.push({
        phase: 'scenario_cache',
        status: buildings.length > 0 ? 'ok' : 'empty',
        latencyMs: Date.now() - t0,
        detail: `Loaded ${buildings.length} buildings from scenario insider_knowledge cache`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err, scenarioId }, 'Debug building-studs scenario fetch failed');
      fetchError = msg;
      buildings = [];
      fetchLog.push({
        phase: 'scenario_cache',
        status: 'error',
        latencyMs: Date.now() - t0,
        detail: `Scenario cache fetch failed: ${msg}`,
      });
    }
  } else {
    try {
      const result = await fetchVenueBuilding(lat, lng, radius, { withLog: true });
      buildings = result.buildings;
      fetchLog = result.fetchLog;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err, lat, lng, radius }, 'Debug building-studs Overpass fetch failed');
      fetchError = msg;
      buildings = [];
      fetchLog.push({
        phase: 'overpass',
        status: 'error',
        latencyMs: Date.now() - t0,
        detail: `Top-level Overpass fetch failed: ${msg}`,
      });
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
    fetchLog,
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

// ── RTS Vision Assessment (GPT-5.1 / GPT-4.1) ─────────────────────────
router.post('/rts-assess', requireAuth, json(), async (req: AuthenticatedRequest, res) => {
  try {
    if (!env.openAiApiKey) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    const { imageUrl, playerAction, plantedItem, context } = req.body;

    if (!playerAction || typeof playerAction !== 'string') {
      return res.status(400).json({ error: 'playerAction is required' });
    }

    const result = await evaluateBombSquadAssessment(
      {
        imageUrl: imageUrl || '',
        playerAction,
        plantedItem: plantedItem || null,
        context: context || 'Bomb squad sweep of building perimeter during crisis exercise.',
      },
      env.openAiApiKey,
    );

    res.json({ data: result });
  } catch (err) {
    logger.error({ err }, 'Error in POST /debug/rts-assess');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── RTS Casualty Scene Image Generation (DALL-E 3) ─────────────────────
router.post('/rts-casualty-image', requireAuth, json(), async (req: AuthenticatedRequest, res) => {
  try {
    if (!env.openAiApiKey) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    const { victims, sceneContext } = req.body;
    if (!victims || !Array.isArray(victims) || victims.length === 0) {
      return res.status(400).json({ error: 'victims array is required' });
    }

    const imageUrl = await generateCasualtySceneImage(
      { victims, sceneContext: sceneContext || 'Bombing aftermath near a building entrance' },
      env.openAiApiKey,
    );

    if (!imageUrl) {
      return res.status(502).json({ error: 'Image generation failed' });
    }

    res.json({ data: { imageUrl } });
  } catch (err) {
    logger.error({ err }, 'Error in POST /debug/rts-casualty-image');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── RTS Individual Victim Image (DALL-E 3) ──────────────────────────────
router.post('/rts-victim-image', requireAuth, json(), async (req: AuthenticatedRequest, res) => {
  try {
    if (!env.openAiApiKey) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    const { victim, sceneContext } = req.body;
    if (!victim || !victim.description) {
      return res.status(400).json({ error: 'victim with description is required' });
    }

    const imageUrl = await generateVictimImage(
      victim,
      sceneContext || 'Bombing aftermath near a building',
      env.openAiApiKey,
    );

    if (!imageUrl) {
      return res.status(502).json({ error: 'Victim image generation failed' });
    }

    res.json({ data: { imageUrl } });
  } catch (err) {
    logger.error({ err }, 'Error in POST /debug/rts-victim-image');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── RTS Triage Assessment Evaluation (GPT Vision) ───────────────────────
router.post('/rts-triage-assess', requireAuth, json(), async (req: AuthenticatedRequest, res) => {
  try {
    if (!env.openAiApiKey) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    const { imageUrl, victims, sceneContext } = req.body;
    if (!victims || !Array.isArray(victims) || victims.length === 0) {
      return res.status(400).json({ error: 'victims array is required' });
    }

    const result = await evaluateTriageAssessment(
      {
        imageUrl: imageUrl || '',
        victims,
        sceneContext: sceneContext || 'Mass casualty triage exercise at bombing scene.',
      },
      env.openAiApiKey,
    );

    res.json({ data: result });
  } catch (err) {
    logger.error({ err }, 'Error in POST /debug/rts-triage-assess');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as debugRouter };
