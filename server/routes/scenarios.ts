import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { validate } from '../lib/validation.js';
import { refreshOsmVicinityForScenario } from '../services/osmVicinityService.js';
import { generateScenarioMaps } from '../services/scenarioMapImageService.js';
import { uploadScenarioMap } from '../lib/storage.js';
import { getConditionConfigForScenario } from '../services/scenarioConditionConfigService.js';

const router = Router();

// Validation schemas
const createScenarioSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(200),
    description: z.string().min(1),
    category: z.enum([
      'cyber',
      'infrastructure',
      'civil_unrest',
      'natural_disaster',
      'health_emergency',
      'terrorism',
      'custom',
    ]),
    difficulty: z.enum(['beginner', 'intermediate', 'advanced', 'expert']),
    duration_minutes: z.number().int().positive().default(60),
    objectives: z.array(z.string()).default([]),
    initial_state: z.record(z.string(), z.unknown()).default({}),
    briefing: z.string().max(10000).optional(),
    role_specific_briefs: z.record(z.string(), z.string()).optional(),
    center_lat: z.number().min(-90).max(90).optional(),
    center_lng: z.number().min(-180).max(180).optional(),
    vicinity_radius_meters: z.number().int().positive().optional(),
    vicinity_map_url: z.string().url().max(2000).optional().nullable(),
    layout_image_url: z.string().url().max(2000).optional().nullable(),
    insider_knowledge: z.record(z.string(), z.unknown()).optional().nullable(),
    suggested_injects: z
      .array(
        z.object({
          trigger_time_minutes: z.number().int().nonnegative(),
          type: z.enum([
            'media_report',
            'field_update',
            'citizen_call',
            'intel_brief',
            'resource_shortage',
            'weather_change',
            'political_pressure',
          ]),
          title: z.string().min(1).max(200),
          content: z.string().min(1),
          severity: z.enum(['low', 'medium', 'high', 'critical']),
          affected_roles: z.array(z.string()).default([]),
          inject_scope: z
            .enum(['universal', 'role_specific', 'team_specific'])
            .default('universal'),
          target_teams: z.array(z.string()).optional(),
          requires_response: z.boolean().default(false),
          requires_coordination: z.boolean().default(false),
        }),
      )
      .optional(),
  }),
});

const updateScenarioSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().min(1).optional(),
    category: z
      .enum([
        'cyber',
        'infrastructure',
        'civil_unrest',
        'natural_disaster',
        'health_emergency',
        'terrorism',
        'custom',
      ])
      .optional(),
    difficulty: z.enum(['beginner', 'intermediate', 'advanced', 'expert']).optional(),
    duration_minutes: z.number().int().positive().optional(),
    objectives: z.array(z.string()).optional(),
    initial_state: z.record(z.string(), z.unknown()).optional(),
    briefing: z.string().max(10000).optional(),
    role_specific_briefs: z.record(z.string(), z.string()).optional(),
    is_active: z.boolean().optional(),
    center_lat: z.number().min(-90).max(90).optional().nullable(),
    center_lng: z.number().min(-180).max(180).optional().nullable(),
    vicinity_radius_meters: z.number().int().positive().optional().nullable(),
    vicinity_map_url: z.string().url().max(2000).optional().nullable(),
    layout_image_url: z.string().url().max(2000).optional().nullable(),
    insider_knowledge: z.record(z.string(), z.unknown()).optional().nullable(),
    refresh_vicinity: z.boolean().optional(),
  }),
});

// Get all scenarios (active only for non-trainers)
router.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    const isTrainer = user.role === 'trainer' || user.role === 'admin';

    let query = supabaseAdmin
      .from('scenarios')
      .select('*')
      .order('created_at', { ascending: false });

    // Non-trainers only see active scenarios
    if (!isTrainer) {
      query = query.eq('is_active', true);
    }

    const { data, error } = await query;

    if (error) {
      logger.error({ error, userId: user.id }, 'Failed to fetch scenarios');
      return res.status(500).json({ error: 'Failed to fetch scenarios' });
    }

    res.json({ data });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /scenarios');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single scenario
router.get('/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const user = req.user!;

    const { data, error } = await supabaseAdmin.from('scenarios').select('*').eq('id', id).single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Scenario not found' });
      }
      logger.error({ error, scenarioId: id }, 'Failed to fetch scenario');
      return res.status(500).json({ error: 'Failed to fetch scenario' });
    }

    // Non-trainers can only see active scenarios
    if (user.role !== 'trainer' && user.role !== 'admin' && !data.is_active) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({ data });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /scenarios/:id');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get condition config (condition_keys, keyword_patterns) for a scenario
router.get('/:id/condition-config', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const user = req.user!;

    const { data: scenario } = await supabaseAdmin
      .from('scenarios')
      .select('id')
      .eq('id', id)
      .single();

    if (!scenario) {
      return res.status(404).json({ error: 'Scenario not found' });
    }

    if (user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const config = await getConditionConfigForScenario(id);
    res.json({ data: config });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /scenarios/:id/condition-config');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all injects for a scenario (trainer only)
router.get('/:id/injects', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const user = req.user!;
    if (user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { data, error } = await supabaseAdmin
      .from('scenario_injects')
      .select('*')
      .eq('scenario_id', id)
      .order('trigger_time_minutes', { ascending: true, nullsFirst: false });
    if (error) {
      logger.error({ error, scenarioId: id }, 'Failed to fetch scenario injects');
      return res.status(500).json({ error: 'Failed to fetch injects' });
    }
    res.json({ data: data ?? [] });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /scenarios/:id/injects');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all teams for a scenario (trainer only)
router.get('/:id/teams', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const user = req.user!;
    if (user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { data, error } = await supabaseAdmin
      .from('scenario_teams')
      .select('*')
      .eq('scenario_id', id)
      .order('team_name', { ascending: true });
    if (error) {
      logger.error({ error, scenarioId: id }, 'Failed to fetch scenario teams');
      return res.status(500).json({ error: 'Failed to fetch teams' });
    }
    res.json({ data: data ?? [] });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /scenarios/:id/teams');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all locations for a scenario (trainer only)
router.get('/:id/locations', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const user = req.user!;
    if (user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { data, error } = await supabaseAdmin
      .from('scenario_locations')
      .select('*')
      .eq('scenario_id', id)
      .order('display_order', { ascending: true });
    if (error) {
      logger.error({ error, scenarioId: id }, 'Failed to fetch scenario locations');
      return res.status(500).json({ error: 'Failed to fetch locations' });
    }

    // Auto-repair GeoJSON-corrupted coordinates ({type:'Point',coordinates:[lng,lat]} → {lat,lng})
    const rows = data ?? [];
    for (const row of rows) {
      const coords = row.coordinates as Record<string, unknown> | null;
      if (
        coords &&
        coords.type === 'Point' &&
        Array.isArray(coords.coordinates) &&
        coords.coordinates.length >= 2
      ) {
        const [lng, lat] = coords.coordinates as number[];
        row.coordinates = { lat, lng };
        // Fire-and-forget DB repair
        supabaseAdmin
          .from('scenario_locations')
          .update({ coordinates: { lat, lng } })
          .eq('id', row.id)
          .then(({ error: repairErr }) => {
            if (repairErr)
              logger.warn({ id: row.id, error: repairErr }, 'Failed to auto-repair coordinates');
            else logger.info({ id: row.id }, 'Auto-repaired GeoJSON coordinates');
          });
      }
    }

    res.json({ data: rows });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /scenarios/:id/locations');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all environmental seeds for a scenario (trainer only)
router.get('/:id/seeds', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const user = req.user!;
    if (user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { data, error } = await supabaseAdmin
      .from('scenario_environmental_seeds')
      .select('*')
      .eq('scenario_id', id)
      .order('display_order', { ascending: true });
    if (error) {
      logger.error({ error, scenarioId: id }, 'Failed to fetch scenario seeds');
      return res.status(500).json({ error: 'Failed to fetch seeds' });
    }
    res.json({ data: data ?? [] });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /scenarios/:id/seeds');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all hazards for a scenario (trainer only — war room preview)
router.get('/:id/hazards', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const user = req.user!;
    if (user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { data, error } = await supabaseAdmin
      .from('scenario_hazards')
      .select('*')
      .eq('scenario_id', id)
      .is('session_id', null)
      .order('appears_at_minutes', { ascending: true });
    if (error) {
      logger.error({ error, scenarioId: id }, 'Failed to fetch scenario hazards');
      return res.status(500).json({ error: 'Failed to fetch hazards' });
    }
    res.json({ data: data ?? [] });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /scenarios/:id/hazards');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all casualties/crowds for a scenario (trainer only — war room preview)
router.get('/:id/casualties', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const user = req.user!;
    if (user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { data, error } = await supabaseAdmin
      .from('scenario_casualties')
      .select('*')
      .eq('scenario_id', id)
      .is('session_id', null)
      .order('appears_at_minutes', { ascending: true });
    if (error) {
      logger.error({ error, scenarioId: id }, 'Failed to fetch scenario casualties');
      return res.status(500).json({ error: 'Failed to fetch casualties' });
    }
    res.json({ data: data ?? [] });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /scenarios/:id/casualties');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all equipment for a scenario (trainer only — war room preview)
router.get('/:id/equipment', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const user = req.user!;
    if (user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { data, error } = await supabaseAdmin
      .from('scenario_equipment')
      .select('*')
      .eq('scenario_id', id)
      .order('created_at', { ascending: true });
    if (error) {
      logger.error({ error, scenarioId: id }, 'Failed to fetch scenario equipment');
      return res.status(500).json({ error: 'Failed to fetch equipment' });
    }
    res.json({ data: data ?? [] });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /scenarios/:id/equipment');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get floor plans for a scenario (trainer only — war room preview)
router.get('/:id/floor-plans', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const user = req.user!;
    if (user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { data, error } = await supabaseAdmin
      .from('scenario_floor_plans')
      .select('*')
      .eq('scenario_id', id)
      .order('floor_level', { ascending: true });
    if (error) {
      logger.error({ error, scenarioId: id }, 'Failed to fetch scenario floor plans');
      return res.status(500).json({ error: 'Failed to fetch floor plans' });
    }
    res.json({ data: data ?? [] });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /scenarios/:id/floor-plans');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Batch-update pin coordinates (trainer/admin — war room repositioning)
router.patch('/:id/pins', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    if (user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { id: scenarioId } = req.params;
    const { locations, hazards, casualties } = req.body as {
      locations?: Array<{ id: string; lat: number; lng: number }>;
      hazards?: Array<{ id: string; lat: number; lng: number }>;
      casualties?: Array<{ id: string; lat: number; lng: number }>;
    };

    const errors: string[] = [];

    if (locations?.length) {
      for (const loc of locations) {
        const { error } = await supabaseAdmin
          .from('scenario_locations')
          .update({
            coordinates: { lat: loc.lat, lng: loc.lng },
          })
          .eq('id', loc.id)
          .eq('scenario_id', scenarioId);
        if (error) errors.push(`location ${loc.id}: ${error.message}`);
      }
    }
    if (hazards?.length) {
      for (const h of hazards) {
        const { error } = await supabaseAdmin
          .from('scenario_hazards')
          .update({ location_lat: h.lat, location_lng: h.lng })
          .eq('id', h.id)
          .eq('scenario_id', scenarioId);
        if (error) errors.push(`hazard ${h.id}: ${error.message}`);
      }
    }
    if (casualties?.length) {
      for (const c of casualties) {
        const { error } = await supabaseAdmin
          .from('scenario_casualties')
          .update({ location_lat: c.lat, location_lng: c.lng })
          .eq('id', c.id)
          .eq('scenario_id', scenarioId);
        if (error) errors.push(`casualty ${c.id}: ${error.message}`);
      }
    }

    if (errors.length) {
      logger.warn({ errors, scenarioId }, 'Some pin updates failed');
      return res.json({ ok: true, warnings: errors });
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err }, 'Error in PATCH /scenarios/:id/pins');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create scenario (trainers only)
router.post(
  '/',
  requireAuth,
  validate(createScenarioSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const {
        title,
        description,
        category,
        difficulty,
        duration_minutes,
        objectives,
        initial_state,
        briefing,
        role_specific_briefs,
        center_lat,
        center_lng,
        vicinity_radius_meters,
        vicinity_map_url,
        layout_image_url,
        insider_knowledge,
        suggested_injects,
      } = req.body;

      // Only trainers and admins can create scenarios
      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can create scenarios' });
      }

      const { data, error } = await supabaseAdmin
        .from('scenarios')
        .insert({
          title,
          description,
          category,
          difficulty,
          duration_minutes,
          objectives,
          initial_state,
          briefing: briefing || null,
          role_specific_briefs: role_specific_briefs || {},
          center_lat: center_lat ?? null,
          center_lng: center_lng ?? null,
          vicinity_radius_meters: vicinity_radius_meters ?? null,
          vicinity_map_url: vicinity_map_url ?? null,
          layout_image_url: layout_image_url ?? null,
          insider_knowledge: insider_knowledge ?? null,
          created_by: user.id,
        })
        .select()
        .single();

      if (error) {
        logger.error({ error, userId: user.id }, 'Failed to create scenario');
        return res.status(500).json({ error: 'Failed to create scenario' });
      }

      // Create suggested injects if provided
      if (suggested_injects && suggested_injects.length > 0) {
        const injectsToInsert = suggested_injects.map(
          (inject: {
            trigger_time_minutes: number;
            type: string;
            title: string;
            content: string;
            severity: string;
            affected_roles: string[];
            inject_scope?: string;
            target_teams?: string[];
            requires_response?: boolean;
            requires_coordination?: boolean;
          }) => ({
            scenario_id: data.id,
            trigger_time_minutes: inject.trigger_time_minutes,
            type: inject.type,
            title: inject.title,
            content: inject.content,
            severity: inject.severity,
            affected_roles: inject.affected_roles || [],
            inject_scope: inject.inject_scope || 'universal',
            target_teams: inject.target_teams || null,
            requires_response: inject.requires_response ?? false,
            requires_coordination: inject.requires_coordination ?? false,
            ai_generated: true,
          }),
        );

        const { error: injectsError } = await supabaseAdmin
          .from('scenario_injects')
          .insert(injectsToInsert);

        if (injectsError) {
          logger.error(
            { error: injectsError, scenarioId: data.id },
            'Failed to create suggested injects',
          );
          // Don't fail the whole request, just log the error
        } else {
          logger.info(
            { scenarioId: data.id, injectCount: injectsToInsert.length },
            'Suggested injects created',
          );
        }
      }

      // When geography is present, trigger background map generation so maps are ready for play
      if (data.center_lat != null && data.center_lng != null) {
        const id = data.id;
        generateScenarioMaps(id)
          .then((result) => {
            if (result.error || (!result.vicinityPng && !result.layoutPng)) return;
            return Promise.all([
              result.vicinityPng
                ? uploadScenarioMap(result.vicinityPng, `${id}/vicinity.png`, 'image/png')
                : null,
              result.layoutPng
                ? uploadScenarioMap(result.layoutPng, `${id}/layout.png`, 'image/png')
                : null,
            ]).then((urls) => {
              const u: { vicinity_map_url?: string; layout_image_url?: string } = {};
              if (urls[0]) u.vicinity_map_url = urls[0];
              if (urls[1]) u.layout_image_url = urls[1];
              if (Object.keys(u).length > 0) {
                return supabaseAdmin.from('scenarios').update(u).eq('id', id);
              }
            });
          })
          .then(() =>
            logger.info({ scenarioId: id }, 'Background map generation completed (create)'),
          )
          .catch((err) =>
            logger.warn({ err, scenarioId: data.id }, 'Background map generation failed (create)'),
          );
      }

      logger.info({ scenarioId: data.id, userId: user.id }, 'Scenario created');
      res.status(201).json({ data });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /scenarios');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Update scenario (creator or admin only)
router.patch(
  '/:id',
  requireAuth,
  validate(updateScenarioSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const user = req.user!;
      const updates = { ...req.body };
      delete (updates as Record<string, unknown>).refresh_vicinity;

      // Check if user owns the scenario or is admin
      const { data: scenario } = await supabaseAdmin
        .from('scenarios')
        .select('created_by')
        .eq('id', id)
        .single();

      if (!scenario) {
        return res.status(404).json({ error: 'Scenario not found' });
      }

      if (scenario.created_by !== user.id && user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { data, error } = await supabaseAdmin
        .from('scenarios')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) {
        logger.error({ error, scenarioId: id }, 'Failed to update scenario');
        return res.status(500).json({ error: 'Failed to update scenario' });
      }

      if (req.body.refresh_vicinity === true && data) {
        const lat = data.center_lat ?? updates.center_lat;
        const lng = data.center_lng ?? updates.center_lng;
        const radius = data.vicinity_radius_meters ?? updates.vicinity_radius_meters;
        if (lat != null && lng != null && radius != null && radius > 0) {
          try {
            await refreshOsmVicinityForScenario(id);
            const { data: refreshed } = await supabaseAdmin
              .from('scenarios')
              .select('insider_knowledge')
              .eq('id', id)
              .single();
            if (refreshed)
              (data as Record<string, unknown>).insider_knowledge = refreshed.insider_knowledge;
          } catch (osmErr) {
            logger.warn({ error: osmErr, scenarioId: id }, 'OSM vicinity refresh failed');
            // Do not fail the PATCH; scenario was updated
          }
        }
      }

      // Optional B2: when geography is present, trigger background map regeneration (fire-and-forget)
      const lat = data.center_lat ?? updates.center_lat;
      const lng = data.center_lng ?? updates.center_lng;
      const radius = data.vicinity_radius_meters ?? updates.vicinity_radius_meters;
      if (lat != null && lng != null && radius != null && radius > 0) {
        generateScenarioMaps(id)
          .then((result) => {
            if (result.error || (!result.vicinityPng && !result.layoutPng)) return;
            return Promise.all([
              result.vicinityPng
                ? uploadScenarioMap(result.vicinityPng, `${id}/vicinity.png`, 'image/png')
                : null,
              result.layoutPng
                ? uploadScenarioMap(result.layoutPng, `${id}/layout.png`, 'image/png')
                : null,
            ]).then((urls) => {
              const u: { vicinity_map_url?: string; layout_image_url?: string } = {};
              if (urls[0]) u.vicinity_map_url = urls[0];
              if (urls[1]) u.layout_image_url = urls[1];
              if (Object.keys(u).length > 0) {
                return supabaseAdmin.from('scenarios').update(u).eq('id', id);
              }
            });
          })
          .then(() => logger.info({ scenarioId: id }, 'Background map generation completed'))
          .catch((err) => logger.warn({ err, scenarioId: id }, 'Background map generation failed'));
      }

      logger.info({ scenarioId: id, userId: user.id }, 'Scenario updated');
      res.json({ data });
    } catch (err) {
      logger.error({ error: err }, 'Error in PATCH /scenarios/:id');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Generate vicinity and layout map images (B2), upload to Storage, update scenario URLs
const generateMapsSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

router.post(
  '/:id/generate-maps',
  requireAuth,
  validate(generateMapsSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const user = req.user!;

      const { data: scenario } = await supabaseAdmin
        .from('scenarios')
        .select('id, created_by, center_lat, center_lng')
        .eq('id', id)
        .single();

      if (!scenario) {
        return res.status(404).json({ error: 'Scenario not found' });
      }
      if (scenario.created_by !== user.id && user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }

      const result = await generateScenarioMaps(id);
      if (result.error) {
        return res.status(400).json({ error: result.error });
      }

      const updates: { vicinity_map_url?: string | null; layout_image_url?: string | null } = {};

      if (result.vicinityPng) {
        try {
          updates.vicinity_map_url = await uploadScenarioMap(
            result.vicinityPng,
            `${id}/vicinity.png`,
            'image/png',
          );
        } catch (err) {
          logger.warn({ err, scenarioId: id }, 'Failed to upload vicinity map');
          updates.vicinity_map_url = null;
        }
      }
      if (result.layoutPng) {
        try {
          updates.layout_image_url = await uploadScenarioMap(
            result.layoutPng,
            `${id}/layout.png`,
            'image/png',
          );
        } catch (err) {
          logger.warn({ err, scenarioId: id }, 'Failed to upload layout map');
          updates.layout_image_url = null;
        }
      }

      if (Object.keys(updates).length === 0) {
        return res.status(500).json({
          error:
            'Map generation produced no images; check scenario has center_lat/center_lng and OSM tiles are reachable',
        });
      }

      const { data: updated, error: updateErr } = await supabaseAdmin
        .from('scenarios')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (updateErr) {
        logger.error(
          { error: updateErr, scenarioId: id },
          'Failed to update scenario with map URLs',
        );
        return res.status(500).json({ error: 'Failed to save map URLs' });
      }

      logger.info({ scenarioId: id, userId: user.id }, 'Scenario maps generated and URLs updated');
      res.json({ data: updated });
    } catch (err) {
      logger.error({ err }, 'Error in POST /scenarios/:id/generate-maps');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Clone scenario (duplicate with all injects)
const cloneScenarioSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    title: z.string().min(1).max(200).optional(),
  }),
});

router.post(
  '/:id/clone',
  requireAuth,
  validate(cloneScenarioSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const user = req.user!;
      const { title: customTitle } = req.body;

      // Get the original scenario
      const { data: originalScenario, error: fetchError } = await supabaseAdmin
        .from('scenarios')
        .select('*')
        .eq('id', id)
        .single();

      if (fetchError || !originalScenario) {
        return res.status(404).json({ error: 'Scenario not found' });
      }

      // Check if user has permission (can clone any scenario, but only trainers/admins)
      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can clone scenarios' });
      }

      // Get all injects for the original scenario
      const { data: originalInjects, error: injectsError } = await supabaseAdmin
        .from('scenario_injects')
        .select('*')
        .eq('scenario_id', id);

      if (injectsError) {
        logger.error(
          { error: injectsError, scenarioId: id },
          'Failed to fetch injects for cloning',
        );
        // Continue anyway - clone scenario without injects
      }

      // Create new scenario with copied data
      const newTitle = customTitle || `${originalScenario.title} (Copy)`;
      const { data: newScenario, error: createError } = await supabaseAdmin
        .from('scenarios')
        .insert({
          title: newTitle,
          description: originalScenario.description,
          category: originalScenario.category,
          difficulty: originalScenario.difficulty,
          duration_minutes: originalScenario.duration_minutes,
          objectives: originalScenario.objectives,
          initial_state: originalScenario.initial_state,
          briefing: originalScenario.briefing,
          role_specific_briefs: originalScenario.role_specific_briefs,
          center_lat: originalScenario.center_lat ?? null,
          center_lng: originalScenario.center_lng ?? null,
          vicinity_radius_meters: originalScenario.vicinity_radius_meters ?? null,
          vicinity_map_url: originalScenario.vicinity_map_url ?? null,
          layout_image_url: originalScenario.layout_image_url ?? null,
          insider_knowledge: originalScenario.insider_knowledge ?? null,
          created_by: user.id,
          is_active: false, // Cloned scenarios start as inactive
        })
        .select()
        .single();

      if (createError) {
        logger.error({ error: createError, originalScenarioId: id }, 'Failed to clone scenario');
        return res.status(500).json({ error: 'Failed to clone scenario' });
      }

      // Clone all injects if they exist
      if (originalInjects && originalInjects.length > 0) {
        type InjectRow = {
          trigger_time_minutes: number;
          trigger_condition: string | null;
          type: string;
          title: string;
          content: string;
          affected_roles: string[] | null;
          severity: string | null;
          requires_response: boolean;
          inject_scope?: string;
          target_teams: string[] | null;
          requires_coordination?: boolean;
          ai_generated?: boolean;
        };
        const injectsToInsert = originalInjects.map((inject: InjectRow) => ({
          scenario_id: newScenario.id,
          trigger_time_minutes: inject.trigger_time_minutes,
          trigger_condition: inject.trigger_condition,
          type: inject.type,
          title: inject.title,
          content: inject.content,
          affected_roles: inject.affected_roles,
          severity: inject.severity,
          requires_response: inject.requires_response,
          inject_scope: inject.inject_scope || 'universal',
          target_teams: inject.target_teams || null,
          requires_coordination: inject.requires_coordination ?? false,
          ai_generated: inject.ai_generated,
        }));

        const { error: injectsCreateError } = await supabaseAdmin
          .from('scenario_injects')
          .insert(injectsToInsert);

        if (injectsCreateError) {
          logger.error(
            { error: injectsCreateError, scenarioId: newScenario.id },
            'Failed to clone injects, but scenario was created',
          );
          // Don't fail - scenario is already created, just log the error
        } else {
          logger.info(
            { scenarioId: newScenario.id, injectCount: injectsToInsert.length },
            'Injects cloned successfully',
          );
        }
      }

      // Fetch the complete cloned scenario with injects
      const { data: completeScenario } = await supabaseAdmin
        .from('scenarios')
        .select('*')
        .eq('id', newScenario.id)
        .single();

      logger.info(
        { originalScenarioId: id, newScenarioId: newScenario.id, userId: user.id },
        'Scenario cloned successfully',
      );

      res.status(201).json({
        data: completeScenario,
        message: 'Scenario cloned successfully',
      });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /scenarios/:id/clone');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Delete scenario (creator or admin only)
router.delete('/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const user = req.user!;

    // Check if user owns the scenario or is admin
    const { data: scenario } = await supabaseAdmin
      .from('scenarios')
      .select('created_by')
      .eq('id', id)
      .single();

    if (!scenario) {
      return res.status(404).json({ error: 'Scenario not found' });
    }

    if (scenario.created_by !== user.id && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { error } = await supabaseAdmin.from('scenarios').delete().eq('id', id);

    if (error) {
      logger.error({ error, scenarioId: id }, 'Failed to delete scenario');
      return res.status(500).json({ error: 'Failed to delete scenario' });
    }

    logger.info({ scenarioId: id, userId: user.id }, 'Scenario deleted');
    res.status(204).send();
  } catch (err) {
    logger.error({ error: err }, 'Error in DELETE /scenarios/:id');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as scenariosRouter };
