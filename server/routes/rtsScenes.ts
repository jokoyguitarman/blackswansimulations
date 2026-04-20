import { Router, json } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { uploadRtsSceneImage } from '../lib/storage.js';
import { logger } from '../lib/logger.js';

const router = Router();

// POST /api/rts-scenes — create a new scene config
router.post('/', requireAuth, json(), async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    const {
      scenarioId,
      name,
      buildingPolygon,
      buildingName,
      centerLat,
      centerLng,
      exits,
      interiorWalls,
      hazardZones,
      stairwells,
      blastSite,
      casualtyClusters,
      plantedItems,
      wallInspectionPoints,
      pedestrianCount,
    } = req.body;

    if (!buildingPolygon || !Array.isArray(buildingPolygon) || buildingPolygon.length < 3) {
      return res
        .status(400)
        .json({ error: 'buildingPolygon with at least 3 vertices is required' });
    }

    const { data, error } = await supabaseAdmin
      .from('rts_scene_configs')
      .insert({
        scenario_id: scenarioId || null,
        name: name || 'Untitled Scene',
        building_polygon: buildingPolygon,
        building_name: buildingName || null,
        center_lat: centerLat || null,
        center_lng: centerLng || null,
        exits: exits || [],
        interior_walls: interiorWalls || [],
        hazard_zones: hazardZones || [],
        stairwells: stairwells || [],
        blast_site: blastSite || null,
        casualty_clusters: casualtyClusters || [],
        planted_items: plantedItems || [],
        wall_inspection_points: wallInspectionPoints || [],
        pedestrian_count: pedestrianCount || 120,
        created_by: user.id,
      })
      .select('id')
      .single();

    if (error) {
      logger.error({ error }, 'Failed to create RTS scene config');
      return res.status(500).json({ error: 'Failed to create scene config' });
    }

    res.json({ data: { id: data.id } });
  } catch (err) {
    logger.error({ err }, 'Error in POST /rts-scenes');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/rts-scenes/:id — load a scene config
router.get('/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from('rts_scene_configs')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Scene config not found' });
    }

    res.json({ data });
  } catch (err) {
    logger.error({ err }, 'Error in GET /rts-scenes/:id');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/rts-scenes?scenario_id=... — load scene config for a scenario
router.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const scenarioId = req.query.scenario_id as string;
    const createdBy = req.query.created_by as string;

    let query = supabaseAdmin
      .from('rts_scene_configs')
      .select(
        'id, name, building_name, center_lat, center_lng, pedestrian_count, created_at, updated_at',
      )
      .order('updated_at', { ascending: false });

    if (scenarioId) query = query.eq('scenario_id', scenarioId);
    if (createdBy) query = query.eq('created_by', createdBy);

    const { data, error } = await query.limit(50);

    if (error) {
      logger.error({ error }, 'Failed to list RTS scene configs');
      return res.status(500).json({ error: 'Failed to list scene configs' });
    }

    res.json({ data: data || [] });
  } catch (err) {
    logger.error({ err }, 'Error in GET /rts-scenes');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/rts-scenes/:id — update scene config
router.patch('/:id', requireAuth, json(), async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const updates: Record<string, unknown> = {};

    const allowedFields = [
      'name',
      'scenario_id',
      'building_polygon',
      'building_name',
      'center_lat',
      'center_lng',
      'exits',
      'interior_walls',
      'hazard_zones',
      'stairwells',
      'blast_site',
      'casualty_clusters',
      'planted_items',
      'wall_inspection_points',
      'wall_photo_urls',
      'casualty_image_urls',
      'pedestrian_count',
      'enrichment_result',
    ];

    const fieldMap: Record<string, string> = {
      scenarioId: 'scenario_id',
      buildingPolygon: 'building_polygon',
      buildingName: 'building_name',
      centerLat: 'center_lat',
      centerLng: 'center_lng',
      interiorWalls: 'interior_walls',
      hazardZones: 'hazard_zones',
      blastSite: 'blast_site',
      casualtyClusters: 'casualty_clusters',
      plantedItems: 'planted_items',
      wallInspectionPoints: 'wall_inspection_points',
      wallPhotoUrls: 'wall_photo_urls',
      casualtyImageUrls: 'casualty_image_urls',
      pedestrianCount: 'pedestrian_count',
      enrichmentResult: 'enrichment_result',
    };

    for (const [key, value] of Object.entries(req.body)) {
      const dbField = fieldMap[key] || key;
      if (allowedFields.includes(dbField)) {
        updates[dbField] = value;
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const { data, error } = await supabaseAdmin
      .from('rts_scene_configs')
      .update(updates)
      .eq('id', id)
      .select('id, updated_at')
      .single();

    if (error) {
      logger.error({ error, id }, 'Failed to update RTS scene config');
      return res.status(500).json({ error: 'Failed to update scene config' });
    }

    res.json({ data });
  } catch (err) {
    logger.error({ err }, 'Error in PATCH /rts-scenes/:id');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/rts-scenes/:id/upload-image — upload an image to Storage
router.post(
  '/:id/upload-image',
  requireAuth,
  json({ limit: '10mb' }),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const { imageData, key, imageType } = req.body;

      if (!imageData || !key) {
        return res.status(400).json({ error: 'imageData (base64) and key are required' });
      }

      const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      const contentType = imageData.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';

      const publicUrl = await uploadRtsSceneImage(buffer, id, key, contentType);

      const urlField = imageType === 'casualty' ? 'casualty_image_urls' : 'wall_photo_urls';
      const { data: existing } = await supabaseAdmin
        .from('rts_scene_configs')
        .select('wall_photo_urls, casualty_image_urls')
        .eq('id', id)
        .single();

      const existingUrls = (existing as Record<string, unknown> | null)?.[urlField];
      const urls: Record<string, string> = (existingUrls as Record<string, string>) || {};
      urls[key] = publicUrl;

      await supabaseAdmin
        .from('rts_scene_configs')
        .update({ [urlField]: urls })
        .eq('id', id);

      res.json({ data: { url: publicUrl } });
    } catch (err) {
      logger.error({ err }, 'Error in POST /rts-scenes/:id/upload-image');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// DELETE /api/rts-scenes/:id
router.delete('/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabaseAdmin.from('rts_scene_configs').delete().eq('id', id);

    if (error) {
      logger.error({ error, id }, 'Failed to delete RTS scene config');
      return res.status(500).json({ error: 'Failed to delete' });
    }

    res.json({ data: { deleted: true } });
  } catch (err) {
    logger.error({ err }, 'Error in DELETE /rts-scenes/:id');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as rtsScenesRouter };
