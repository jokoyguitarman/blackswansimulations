import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { validate } from '../lib/validation.js';
import {
  refreshOsmVicinityForScenario,
  fetchVenueBuilding,
} from '../services/osmVicinityService.js';
import { generateScenarioMaps } from '../services/scenarioMapImageService.js';
import { uploadScenarioMap } from '../lib/storage.js';
import { getConditionConfigForScenario } from '../services/scenarioConditionConfigService.js';
import { circleToPolygon } from '../services/geoUtils.js';
import {
  getOccupiedStudIds,
  loadClassifiedGrids,
  invalidateGridCache,
} from '../services/buildingStudService.js';

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
      .is('session_id', null)
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

// Get research cases linked to a scenario
router.get('/:id/research', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from('scenario_research_usage')
      .select('relevance_score, research_cases(*)')
      .eq('scenario_id', id)
      .order('relevance_score', { ascending: false });
    if (error) {
      logger.error({ error, scenarioId: id }, 'Failed to fetch scenario research');
      return res.status(500).json({ error: 'Failed to fetch research' });
    }
    const cases = (data ?? []).map((row: Record<string, unknown>) => ({
      ...(row.research_cases as Record<string, unknown>),
      relevance_score: row.relevance_score,
    }));
    res.json({ data: cases });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /scenarios/:id/research');
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
    const { locations, hazards, casualties, zones } = req.body as {
      locations?: Array<{
        id: string;
        lat: number;
        lng: number;
        conditions?: Record<string, unknown>;
      }>;
      hazards?: Array<{ id: string; lat: number; lng: number }>;
      casualties?: Array<{ id: string; lat: number; lng: number }>;
      zones?: Array<{ hazard_id: string; zone_type: string; radius_m: number }>;
    };

    const errors: string[] = [];

    if (locations?.length) {
      for (const loc of locations) {
        const updatePayload: Record<string, unknown> = {
          coordinates: { lat: loc.lat, lng: loc.lng },
        };

        // For zone locations, recalculate the polygon when center moves or radius changes
        if (loc.conditions) {
          updatePayload.conditions = loc.conditions;
        } else {
          const { data: existingLoc } = await supabaseAdmin
            .from('scenario_locations')
            .select('pin_category, conditions')
            .eq('id', loc.id)
            .eq('scenario_id', scenarioId)
            .single();

          if (
            existingLoc?.pin_category === 'incident_zone' ||
            existingLoc?.pin_category === 'blast_zone'
          ) {
            const conds = (existingLoc.conditions ?? {}) as Record<string, unknown>;
            const radiusM = Number(conds.radius_m) || 100;
            const newPolygon = circleToPolygon(loc.lat, loc.lng, radiusM);
            updatePayload.conditions = { ...conds, polygon: newPolygon };
          }
        }

        const { error } = await supabaseAdmin
          .from('scenario_locations')
          .update(updatePayload)
          .eq('id', loc.id)
          .eq('scenario_id', scenarioId);
        if (error) errors.push(`location ${loc.id}: ${error.message}`);
      }
    }
    if (hazards?.length) {
      for (const h of hazards) {
        // Fetch existing zones so we can recalculate polygons at the new center
        const { data: hazardRow } = await supabaseAdmin
          .from('scenario_hazards')
          .select('zones')
          .eq('id', h.id)
          .eq('scenario_id', scenarioId)
          .single();

        const existingZones = (hazardRow?.zones ?? []) as Array<Record<string, unknown>>;
        const updatedZones = existingZones.map((z) => {
          const radius = Number(z.radius_m) || 100;
          return { ...z, polygon: circleToPolygon(h.lat, h.lng, radius) };
        });

        const updatePayload: Record<string, unknown> = {
          location_lat: h.lat,
          location_lng: h.lng,
        };
        if (existingZones.length > 0) {
          updatePayload.zones = updatedZones;
        }

        const { error } = await supabaseAdmin
          .from('scenario_hazards')
          .update(updatePayload)
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
    if (zones?.length) {
      const hazardIds = [...new Set(zones.map((z) => z.hazard_id))];
      for (const hid of hazardIds) {
        const { data: hazardRow, error: fetchErr } = await supabaseAdmin
          .from('scenario_hazards')
          .select('location_lat, location_lng, zones')
          .eq('id', hid)
          .eq('scenario_id', scenarioId)
          .single();
        if (fetchErr || !hazardRow) {
          errors.push(`zone hazard ${hid}: ${fetchErr?.message ?? 'not found'}`);
          continue;
        }
        const existing = (hazardRow.zones ?? []) as Array<Record<string, unknown>>;
        const centerLat = Number(hazardRow.location_lat);
        const centerLng = Number(hazardRow.location_lng);
        const updated = existing.map((ez) => {
          const match = zones.find(
            (z) => z.hazard_id === hid && z.zone_type === (ez.zone_type as string),
          );
          if (!match) return ez;
          const newPolygon = circleToPolygon(centerLat, centerLng, match.radius_m);
          return { ...ez, radius_m: match.radius_m, polygon: newPolygon };
        });
        const { error: updateErr } = await supabaseAdmin
          .from('scenario_hazards')
          .update({ zones: updated })
          .eq('id', hid)
          .eq('scenario_id', scenarioId);
        if (updateErr) errors.push(`zone ${hid}: ${updateErr.message}`);
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

      // Get template injects only (exclude session-scoped runtime injects)
      const { data: originalInjects, error: injectsError } = await supabaseAdmin
        .from('scenario_injects')
        .select('*')
        .eq('scenario_id', id)
        .is('session_id', null);

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

// Retry route generation for a scenario
router.post('/:id/retry-routes', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    if (user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { id: scenarioId } = req.params;

    const { data: scenario, error: scenErr } = await supabaseAdmin
      .from('scenarios')
      .select('center_lat, center_lng, category, title, description, briefing, insider_knowledge')
      .eq('id', scenarioId)
      .single();

    if (scenErr || !scenario) {
      return res.status(404).json({ error: 'Scenario not found' });
    }
    if (!scenario.center_lat || !scenario.center_lng) {
      return res.status(400).json({ error: 'Scenario has no geocoded center coordinates' });
    }

    // Check if routes already exist
    const { data: existingRoutes } = await supabaseAdmin
      .from('scenario_locations')
      .select('id')
      .eq('scenario_id', scenarioId)
      .eq('location_type', 'route')
      .limit(1);

    if (existingRoutes?.length) {
      return res.json({
        ok: true,
        message: 'Routes already exist',
        routes_count: existingRoutes.length,
      });
    }

    const openAiApiKey = process.env.OPENAI_API_KEY;
    if (!openAiApiKey) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    const { fetchRouteGeometries: fetchRoutes } = await import('../services/osmVicinityService.js');
    const { computeRouteCorridors, enrichRouteLocations: enrichRoutes } =
      await import('../services/warroomAiService.js');

    const lat = Number(scenario.center_lat);
    const lng = Number(scenario.center_lng);

    logger.info({ scenarioId, lat, lng }, 'Retrying route generation');

    const routeGeoms = await fetchRoutes(lat, lng, 6000);
    if (!routeGeoms.length) {
      return res.status(502).json({
        error: 'OSM route fetch returned no data — Overpass may be unavailable. Try again later.',
      });
    }

    // Fetch existing POI locations for corridor computation
    const { data: poiLocs } = await supabaseAdmin
      .from('scenario_locations')
      .select('id, label, location_type, pin_category, coordinates, conditions')
      .eq('scenario_id', scenarioId)
      .eq('pin_category', 'poi');

    const facilityPins = (poiLocs ?? []).map((p) => ({
      label: p.label as string,
      coordinates: p.coordinates as { lat: number; lng: number },
      location_type: p.location_type as string,
      conditions: (p.conditions ?? {}) as Record<string, unknown>,
    }));

    const incidentLoc = await supabaseAdmin
      .from('scenario_locations')
      .select('coordinates')
      .eq('scenario_id', scenarioId)
      .eq('pin_category', 'incident_site')
      .limit(1)
      .single();

    const incidentCoords = (incidentLoc.data?.coordinates as { lat: number; lng: number }) ?? {
      lat,
      lng,
    };

    const corridors = computeRouteCorridors(
      routeGeoms,
      facilityPins.map((p) => ({
        label: p.label,
        coordinates: p.coordinates,
        location_type: p.location_type,
      })),
      incidentCoords,
    );

    if (!corridors.length) {
      return res.status(422).json({ error: 'No route corridors computed from OSM data' });
    }

    const routeLocations = await enrichRoutes(
      {
        scenario_type: scenario.category || 'terrorism',
        setting: '',
        terrain: '',
        location: null,
        venue_name: scenario.title || '',
        complexity_tier: 'full',
        typeSpec: {},
        settingSpec: {},
        terrainSpec: {},
      },
      corridors,
      facilityPins.map((p) => ({
        label: p.label,
        location_type: p.location_type,
        conditions: p.conditions,
      })),
      openAiApiKey,
      undefined,
      { title: scenario.title, description: scenario.description, briefing: scenario.briefing },
    );

    if (!routeLocations?.length) {
      return res.status(422).json({ error: 'AI route enrichment returned no results' });
    }

    // Insert the route locations
    const rows = routeLocations.map((r) => ({
      scenario_id: scenarioId,
      location_type: r.location_type,
      pin_category: r.pin_category ?? 'route',
      label: r.label,
      coordinates: r.coordinates,
      conditions: r.conditions ?? {},
      display_order: r.display_order ?? 500,
    }));

    const { error: insertErr } = await supabaseAdmin.from('scenario_locations').insert(rows);
    if (insertErr) {
      logger.error({ error: insertErr, scenarioId }, 'Failed to insert retry-route locations');
      return res.status(500).json({ error: 'Failed to save route locations' });
    }

    // Also store route summaries in insider_knowledge.osm_vicinity.emergency_routes
    const ik = (scenario.insider_knowledge ?? {}) as Record<string, unknown>;
    const osmVicinity = (ik.osm_vicinity ?? {}) as Record<string, unknown>;
    const routeSummaries = routeLocations.map((r) => {
      const c = (r.conditions ?? {}) as Record<string, unknown>;
      return {
        description: r.label,
        highway_type: c.highway_type as string | undefined,
        one_way: c.one_way as boolean | undefined,
      };
    });
    osmVicinity.emergency_routes = routeSummaries;
    ik.osm_vicinity = osmVicinity;
    await supabaseAdmin.from('scenarios').update({ insider_knowledge: ik }).eq('id', scenarioId);

    logger.info({ scenarioId, count: rows.length }, 'Route locations generated via retry');
    res.json({ ok: true, routes_count: rows.length });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /scenarios/:id/retry-routes');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Map AI-returned hazard labels (often long prose) back to DB hazard rows. */
function resolveHazardMatchFromAiLabel(
  aiLabel: string,
  hazards: Array<{
    id: string;
    label: string;
    hazard_type: string;
    location_lat: number;
    location_lng: number;
  }>,
): (typeof hazards)[0] | null {
  const t = aiLabel.trim();
  if (!t) return null;

  // Exact match
  for (const h of hazards) {
    if (h.label === t) return h;
  }

  // Index-based: "H0", "H1", or "H0: Some Label"
  const idxMatch = t.match(/^H(\d+)(?:\s*[:—–-]\s*|$)/i);
  if (idxMatch) {
    const idx = parseInt(idxMatch[1], 10);
    if (idx >= 0 && idx < hazards.length) return hazards[idx];
  }

  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const nt = norm(t);
  for (const h of hazards) {
    if (norm(h.label) === nt) return h;
  }
  const tl = t.toLowerCase();
  for (const h of hazards) {
    if (h.label.length >= 3 && tl.includes(h.label.toLowerCase())) return h;
  }
  const prefix = tl.slice(0, 40);
  for (const h of hazards) {
    const hl = h.label.toLowerCase();
    if (hl.length >= 3 && tl.startsWith(hl.slice(0, Math.min(28, hl.length)))) return h;
    if (hl.length >= 3 && hl.startsWith(prefix.slice(0, Math.min(16, prefix.length)))) return h;
  }
  for (const h of hazards) {
    const ht = h.hazard_type.toLowerCase();
    if (ht.length >= 4 && tl.includes(ht)) {
      const sameType = hazards.filter((x) => x.hazard_type === h.hazard_type);
      if (sameType.length === 1) return h;
    }
  }
  if (hazards.length === 1) return hazards[0] ?? null;
  return null;
}

// Retry deterioration generation for a scenario (trainer/admin)
router.post('/:id/retry-deterioration', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    if (user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { id: scenarioId } = req.params;
    const force = Boolean((req.body as Record<string, unknown> | undefined)?.force);

    const { data: scenario, error: scenErr } = await supabaseAdmin
      .from('scenarios')
      .select('id, title, description, briefing, insider_knowledge')
      .eq('id', scenarioId)
      .single();

    if (scenErr || !scenario) {
      return res.status(404).json({ error: 'Scenario not found' });
    }

    // Fetch hazards/casualties/locations from DB
    const [{ data: hazards }, { data: casualties }, { data: locations }] = await Promise.all([
      supabaseAdmin
        .from('scenario_hazards')
        .select(
          'id, hazard_type, location_lat, location_lng, floor_level, properties, deterioration_timeline, spawn_condition, parent_pin_id',
        )
        .eq('scenario_id', scenarioId)
        .is('session_id', null)
        .order('appears_at_minutes', { ascending: true }),
      supabaseAdmin
        .from('scenario_casualties')
        .select(
          'id, casualty_type, location_lat, location_lng, floor_level, headcount, conditions, spawn_condition, parent_pin_id',
        )
        .eq('scenario_id', scenarioId)
        .is('session_id', null)
        .order('appears_at_minutes', { ascending: true }),
      supabaseAdmin
        .from('scenario_locations')
        .select('id, label, location_type, pin_category, coordinates, conditions')
        .eq('scenario_id', scenarioId)
        .order('display_order', { ascending: true }),
    ]);

    const hazardRows = (hazards ?? []) as Array<Record<string, unknown>>;
    const casualtyRows = (casualties ?? []) as Array<Record<string, unknown>>;
    const locationRows = (locations ?? []) as Array<Record<string, unknown>>;

    if (hazardRows.length === 0 && casualtyRows.length === 0) {
      return res.status(400).json({ error: 'Scenario has no hazards or casualties to enrich' });
    }

    const existingSpawnCount =
      hazardRows.filter((h) => h.spawn_condition != null || h.parent_pin_id != null).length +
      casualtyRows.filter((c) => c.spawn_condition != null || c.parent_pin_id != null).length;
    if (existingSpawnCount > 0 && !force) {
      return res.json({
        ok: true,
        message: 'Deterioration spawn pins already exist (use force to rebuild)',
        hazards_updated: 0,
        casualties_updated: 0,
        spawn_hazards_inserted: 0,
        spawn_casualties_inserted: 0,
      });
    }

    if (existingSpawnCount > 0 && force) {
      await Promise.all([
        supabaseAdmin
          .from('scenario_hazards')
          .delete()
          .eq('scenario_id', scenarioId)
          .or('spawn_condition.not.is.null,parent_pin_id.not.is.null'),
        supabaseAdmin
          .from('scenario_casualties')
          .delete()
          .eq('scenario_id', scenarioId)
          .or('spawn_condition.not.is.null,parent_pin_id.not.is.null'),
      ]);
    }

    const ik = (scenario.insider_knowledge ?? {}) as Record<string, unknown>;
    const customFacts = Array.isArray(ik.custom_facts)
      ? (ik.custom_facts as Array<Record<string, unknown>>)
      : [];
    const baselineFactors = Array.isArray(ik.baseline_escalation_factors)
      ? (ik.baseline_escalation_factors as Array<Record<string, unknown>>)
      : [];

    // Pull a few linked research case summaries for extra grounding (best-effort)
    const { data: linkedResearch } = await supabaseAdmin
      .from('scenario_research_usage')
      .select(
        'relevance_score, research_cases(name, summary, environment, hazards_triggered, secondary_effects)',
      )
      .eq('scenario_id', scenarioId)
      .order('relevance_score', { ascending: false })
      .limit(5);

    const researchBlock =
      (linkedResearch ?? []).length > 0
        ? (linkedResearch ?? [])
            .map((row: Record<string, unknown>) => {
              const rc = row.research_cases as Record<string, unknown>;
              return `- ${String(rc?.name ?? 'Case')}: ${(rc?.summary ?? '').toString().slice(0, 240)}${
                rc?.hazards_triggered ? ` | hazards: ${JSON.stringify(rc.hazards_triggered)}` : ''
              }${
                rc?.secondary_effects
                  ? ` | secondaries: ${JSON.stringify(rc.secondary_effects)}`
                  : ''
              }`;
            })
            .join('\n')
        : '';

    const areaContext = [
      `Scenario: ${String(scenario.title ?? '')}`,
      (scenario.description as string)
        ? `Description: ${(scenario.description as string).slice(0, 800)}`
        : '',
      (scenario.briefing as string)
        ? `Briefing: ${(scenario.briefing as string).slice(0, 800)}`
        : '',
      customFacts.length
        ? `Facility / custom facts:\n${customFacts
            .map((f) => `- ${String(f.topic ?? 'Fact')}: ${String(f.summary ?? '').slice(0, 260)}`)
            .join('\n')}`
        : '',
      baselineFactors.length
        ? `Baseline escalation factors:\n${baselineFactors
            .map(
              (f) =>
                `- ${String(f.name ?? 'Factor')}: ${String(f.description ?? '').slice(0, 260)}`,
            )
            .join('\n')}`
        : '',
      researchBlock ? `Linked research cases:\n${researchBlock}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const venue = (scenario.title as string) || 'the venue';

    const openAiApiKey = process.env.OPENAI_API_KEY;
    if (!openAiApiKey) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    const { researchDeteriorationPhysics, deteriorationResearchToPromptBlock } =
      await import('../services/warroomResearchService.js');
    const { generateDeteriorationTimeline } = await import('../services/warroomAiService.js');

    const hazardsForAi = hazardRows.map((h) => {
      const props = (h.properties ?? {}) as Record<string, unknown>;
      const label = String(props.label ?? h.hazard_type ?? 'hazard');
      return {
        id: String(h.id),
        label,
        hazard_type: String(h.hazard_type ?? 'hazard'),
        location_lat: Number(h.location_lat) || 0,
        location_lng: Number(h.location_lng) || 0,
        properties: props,
      };
    });

    const casualtiesForAi = casualtyRows.map((c) => ({
      id: String(c.id),
      casualty_type: String(c.casualty_type ?? 'patient'),
      location_lat: Number(c.location_lat) || 0,
      location_lng: Number(c.location_lng) || 0,
      conditions: (c.conditions ?? {}) as Record<string, unknown>,
      headcount: c.headcount != null ? Number(c.headcount) : undefined,
    }));

    // Synthesise crowd location pins as seed casualties so the AI can spawn
    // casualty pins even when scenario_casualties is empty.
    const crowdPins = locationRows.filter(
      (l) => String(l.pin_category ?? '') === 'crowd' || String(l.location_type ?? '') === 'crowd',
    );
    const crowdAsCasualties = crowdPins.map((cp) => {
      const coords = (cp.coordinates ?? {}) as Record<string, unknown>;
      const conds = (cp.conditions ?? {}) as Record<string, unknown>;
      return {
        id: `crowd-${String(cp.id)}`,
        casualty_type: 'crowd',
        location_lat: Number(coords.lat ?? 0),
        location_lng: Number(coords.lng ?? 0),
        conditions: {
          visible_description: String(conds.description || cp.label || 'Crowd area'),
          capacity_persons: conds.capacity_persons ?? undefined,
        } as Record<string, unknown>,
        headcount: Number(conds.capacity_persons ?? conds.headcount ?? 20),
      };
    });

    const allCasualtiesForAi = [...casualtiesForAi, ...crowdAsCasualties];

    const detResearch = await researchDeteriorationPhysics(
      hazardsForAi.map((h) => ({
        label: h.label,
        hazard_type: h.hazard_type,
        properties: h.properties,
      })),
      allCasualtiesForAi.map((c) => ({ casualty_type: c.casualty_type, conditions: c.conditions })),
      areaContext || '',
      venue,
      openAiApiKey,
    );

    if (!detResearch) {
      return res.status(502).json({ error: 'Deterioration research failed (search model)' });
    }

    const detPromptBlock = deteriorationResearchToPromptBlock(detResearch);

    const detResult = await generateDeteriorationTimeline(
      hazardsForAi.map((h) => ({
        label: h.label,
        hazard_type: h.hazard_type,
        location_lat: h.location_lat,
        location_lng: h.location_lng,
        properties: h.properties,
      })),
      allCasualtiesForAi.map((c) => ({
        casualty_type: c.casualty_type,
        location_lat: c.location_lat,
        location_lng: c.location_lng,
        conditions: c.conditions,
        headcount: c.headcount,
      })),
      locationRows.map((l) => ({
        label: String(l.label ?? ''),
        location_type: String(l.location_type ?? l.pin_category ?? ''),
        lat: ((l.coordinates as { lat?: number })?.lat ??
          ((l as unknown as Record<string, unknown>).lat as number | undefined) ??
          0) as number,
        lng: ((l.coordinates as { lng?: number })?.lng ??
          ((l as unknown as Record<string, unknown>).lng as number | undefined) ??
          0) as number,
      })),
      detPromptBlock,
      venue,
      openAiApiKey,
    );

    if (!detResult) {
      return res.status(502).json({ error: 'Deterioration timeline generation failed' });
    }

    // Persist hazard timelines (match AI labels to DB rows — model often returns prose)
    let hazardsUpdated = 0;
    for (const eh of detResult.enriched_hazard_timelines) {
      const matched = resolveHazardMatchFromAiLabel(eh.hazard_label, hazardsForAi);
      if (!matched) {
        logger.warn(
          { scenarioId, hazard_label: eh.hazard_label?.slice?.(0, 120) },
          'retry-deterioration: unmatched hazard_label for timeline',
        );
        continue;
      }
      const { error: upErr } = await supabaseAdmin
        .from('scenario_hazards')
        .update({ deterioration_timeline: eh.deterioration_timeline })
        .eq('id', matched.id)
        .eq('scenario_id', scenarioId);
      if (!upErr) hazardsUpdated++;
    }

    // Persist casualty timelines (use index mapping to the fetched casualty order)
    // Skip crowd-synthesised entries (IDs start with "crowd-") — they have no DB row.
    let casualtiesUpdated = 0;
    for (const ec of detResult.enriched_casualty_timelines) {
      const entry = allCasualtiesForAi[ec.casualty_index];
      const cid = entry?.id;
      if (!cid || cid.startsWith('crowd-')) continue;
      const prevConds = (entry.conditions ?? {}) as Record<string, unknown>;
      const nextConds = { ...prevConds, deterioration_timeline: ec.deterioration_timeline };
      const { error: upErr } = await supabaseAdmin
        .from('scenario_casualties')
        .update({ conditions: nextConds })
        .eq('id', cid)
        .eq('scenario_id', scenarioId);
      if (!upErr) casualtiesUpdated++;
    }

    // Insert spawn pins
    let spawnHazardsInserted = 0;
    let spawnCasualtiesInserted = 0;

    for (const sp of detResult.spawn_pins) {
      const parent = resolveHazardMatchFromAiLabel(sp.parent_pin_label, hazardsForAi);
      if (!parent) {
        logger.warn(
          { scenarioId, parent_pin_label: sp.parent_pin_label?.slice?.(0, 120) },
          'retry-deterioration: unmatched spawn parent_pin_label',
        );
        continue;
      }

      if (sp.pin_type === 'hazard') {
        const props = { ...(sp.properties ?? {}) } as Record<string, unknown>;
        props.label = sp.label;
        if (!props.description) props.description = sp.description;
        const row = {
          scenario_id: scenarioId,
          hazard_type: sp.hazard_type || 'secondary_hazard',
          location_lat: parent.location_lat + sp.lat_offset,
          location_lng: parent.location_lng + sp.lng_offset,
          floor_level: sp.floor_level || 'G',
          properties: props,
          assessment_criteria: [],
          status: 'delayed',
          appears_at_minutes: sp.appears_at_minutes,
          resolution_requirements: {},
          personnel_requirements: {},
          equipment_requirements: [],
          deterioration_timeline: {},
          zones: [],
          parent_pin_id: parent.id,
          spawn_condition: sp.spawn_condition,
        };
        const { error: insErr } = await supabaseAdmin.from('scenario_hazards').insert(row);
        if (!insErr) spawnHazardsInserted++;
      } else {
        const conds = { ...(sp.conditions ?? {}) } as Record<string, unknown>;
        if (!conds.visible_description) conds.visible_description = sp.description;
        const row = {
          scenario_id: scenarioId,
          casualty_type: sp.casualty_type || 'patient',
          location_lat: parent.location_lat + sp.lat_offset,
          location_lng: parent.location_lng + sp.lng_offset,
          floor_level: sp.floor_level || 'G',
          headcount: sp.headcount ?? 1,
          conditions: conds,
          status: 'delayed',
          appears_at_minutes: sp.appears_at_minutes,
          destination_lat: null,
          destination_lng: null,
          destination_label: null,
          movement_speed_mpm: 0,
          parent_pin_id: parent.id,
          spawn_condition: sp.spawn_condition,
        };
        const { error: insErr } = await supabaseAdmin.from('scenario_casualties').insert(row);
        if (!insErr) spawnCasualtiesInserted++;
      }
    }

    const spawnPinsFromAi = detResult.spawn_pins?.length ?? 0;
    const spawnPinsMatched = spawnHazardsInserted + spawnCasualtiesInserted;
    if (spawnPinsFromAi > 0 && spawnPinsMatched === 0) {
      logger.warn(
        { scenarioId, spawnPinsFromAi },
        'retry-deterioration: AI produced spawn pins but NONE matched a parent hazard label',
      );
    }

    // Persist cascade narrative
    if (detResult.cascade_narrative) {
      const nextIk = { ...(ik ?? {}) } as Record<string, unknown>;
      nextIk.cascade_narrative = detResult.cascade_narrative;
      await supabaseAdmin
        .from('scenarios')
        .update({ insider_knowledge: nextIk })
        .eq('id', scenarioId);
    }

    return res.json({
      ok: true,
      hazards_updated: hazardsUpdated,
      casualties_updated: casualtiesUpdated,
      spawn_hazards_inserted: spawnHazardsInserted,
      spawn_casualties_inserted: spawnCasualtiesInserted,
      spawn_pins_from_ai: spawnPinsFromAi,
      crowd_pins_injected: crowdAsCasualties.length,
    });
  } catch (err) {
    logger.error(
      { error: err, scenarioId: req.params?.id },
      'Error in POST /scenarios/:id/retry-deterioration',
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Retry / generate research-driven custom facts for a scenario (trainer/admin)
router.post('/:id/retry-custom-facts', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    if (user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { id: scenarioId } = req.params;

    const openAiApiKey = process.env.OPENAI_API_KEY;
    if (!openAiApiKey) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    const { data: scenario, error: scenErr } = await supabaseAdmin
      .from('scenarios')
      .select('id, title, category, description, briefing, insider_knowledge')
      .eq('id', scenarioId)
      .single();

    if (scenErr || !scenario) {
      return res.status(404).json({ error: 'Scenario not found' });
    }

    const [{ data: hazards }, { data: locations }, { data: researchUsage }] = await Promise.all([
      supabaseAdmin
        .from('scenario_hazards')
        .select('hazard_type, properties, location_lat, location_lng')
        .eq('scenario_id', scenarioId)
        .is('session_id', null)
        .order('appears_at_minutes', { ascending: true }),
      supabaseAdmin
        .from('scenario_locations')
        .select('location_type, pin_category, label, coordinates, conditions')
        .eq('scenario_id', scenarioId)
        .order('display_order', { ascending: true }),
      supabaseAdmin
        .from('scenario_research_usage')
        .select(
          'relevance_score, research_cases(name, summary, environment, hazards_triggered, secondary_effects, environment_factors)',
        )
        .eq('scenario_id', scenarioId)
        .order('relevance_score', { ascending: false })
        .limit(8),
    ]);

    const hazardBlock = (hazards ?? [])
      .slice(0, 24)
      .map((h: Record<string, unknown>) => {
        const props = (h.properties ?? {}) as Record<string, unknown>;
        const label = String(props.label ?? h.hazard_type ?? 'hazard');
        const vm = props.venue_material_context
          ? String(props.venue_material_context).slice(0, 280)
          : '';
        return `- ${label} (${String(h.hazard_type ?? '')})${vm ? ` — ${vm}` : ''}`;
      })
      .join('\n');

    const facilitiesBlock = (locations ?? [])
      .filter((l: Record<string, unknown>) => {
        const t = String(l.location_type ?? '');
        const pc = String(l.pin_category ?? '');
        return (
          pc === 'poi' ||
          pc === 'incident_site' ||
          t === 'hospital' ||
          t === 'fire_station' ||
          t === 'police_station' ||
          t === 'entry_point' ||
          t === 'assembly_point'
        );
      })
      .slice(0, 24)
      .map(
        (l: Record<string, unknown>) =>
          `- ${String(l.label ?? '')} (${String(l.location_type ?? l.pin_category ?? '')})`,
      )
      .join('\n');

    const researchBlock = (researchUsage ?? [])
      .map((row: Record<string, unknown>) => {
        const rc = row.research_cases as Record<string, unknown>;
        const name = String(rc?.name ?? 'Case');
        const summary = String(rc?.summary ?? '').slice(0, 260);
        const hz = rc?.hazards_triggered ? ` hazards=${JSON.stringify(rc.hazards_triggered)}` : '';
        const sec = rc?.secondary_effects
          ? ` secondaries=${JSON.stringify(rc.secondary_effects)}`
          : '';
        return `- ${name}: ${summary}${hz}${sec}`;
      })
      .join('\n');

    const force = Boolean((req.body as Record<string, unknown> | undefined)?.force);

    const ik = (scenario.insider_knowledge ?? {}) as Record<string, unknown>;
    const prior = Array.isArray(ik.custom_facts) ? (ik.custom_facts as unknown[]) : [];
    if (prior.length > 0 && !force) {
      return res.json({
        ok: true,
        facts_count: prior.length,
        message: 'Custom facts already exist (pass force: true to regenerate)',
      });
    }

    const researchArchive = ik.research_archive;
    let researchArchiveBlock = '';
    if (researchArchive && typeof researchArchive === 'object') {
      const ra = researchArchive as Record<string, unknown>;
      const chunks: string[] = [];
      for (const key of [
        'area_structured',
        'hazard_material_context',
        'sensitive_infrastructure',
      ] as const) {
        if (ra[key] == null) continue;
        const raw = JSON.stringify(ra[key]);
        const cap = 2400;
        chunks.push(`${key}:\n${raw.length > cap ? `${raw.slice(0, cap)}…` : raw}`);
      }
      researchArchiveBlock = chunks.join('\n\n').slice(0, 7200);
    }

    // Use the same search model as warroomResearchService
    const SEARCH_MODEL = 'gpt-4o-search-preview';

    const prompt = `You are an intelligence analyst supporting a crisis simulation. Generate research-oriented "Custom Facts" that help trainers run a realistic scenario.

Scenario title: ${String(scenario.title ?? '')}
Scenario type: ${String(scenario.category ?? '')}
Description: ${String(scenario.description ?? '').slice(0, 1200)}
Briefing: ${String(scenario.briefing ?? '').slice(0, 1200)}

Known hazards & facility material context:
${hazardBlock || '(none provided)'}

Nearby facilities / key pins:
${facilitiesBlock || '(none provided)'}

Linked real-world research cases:
${researchBlock || '(none linked)'}

Persisted area / material research (from scenario generation — use as authoritative context when present):
${researchArchiveBlock || '(none stored in insider_knowledge.research_archive)'}

Produce 6–10 Custom Facts. They MUST be venue- and incident-relevant, and should emphasize:
- Establishment type / industrial process context (if implied)
- On-site chemicals, compressed gases, fuels, oxidizers, dust explosion risks, refrigeration gases, etc.
- Secondary hazards that are realistic given the above (e.g., oxidizers + organics, ammonia plume drift, oxygen enrichment)
- Nearby infrastructure/sensitive facilities (hospitals, schools, ports, utilities) and what that changes operationally

Put the deepest technical grounding in "detail" (3–8 sentences): plausible exposure routes, confinement, incompatibilities, and secondary events. When HAZMAT or industrial fire applies, use credible safety framing (e.g. flammable atmosphere / LEL context, oxygen displacement or toxic exposure in enclosed spaces, oxidizer–fuel interactions) without fabricating exact numeric limits unless they are standard for a named substance.

Return ONLY valid JSON:
{
  "custom_facts": [
    { "topic": "string", "summary": "1–2 sentences", "detail": "3–8 sentences with concrete specifics" }
  ]
}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model: SEARCH_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 5000,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      logger.error(
        { status: response.status, body: text },
        'retry-custom-facts OpenAI call failed',
      );
      return res.status(502).json({ error: 'Custom facts generation failed' });
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return res.status(502).json({ error: 'Custom facts generation returned empty' });

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch)
      return res.status(502).json({ error: 'Custom facts generation returned non-JSON' });

    const parsed = JSON.parse(jsonMatch[0]) as { custom_facts?: Array<Record<string, unknown>> };
    const facts = Array.isArray(parsed.custom_facts) ? parsed.custom_facts : [];
    if (facts.length === 0) return res.status(502).json({ error: 'No custom facts generated' });

    const nextIk = { ...ik, custom_facts: facts };
    const { error: upErr } = await supabaseAdmin
      .from('scenarios')
      .update({ insider_knowledge: nextIk })
      .eq('id', scenarioId);
    if (upErr) return res.status(500).json({ error: 'Failed to save custom facts' });

    return res.json({ ok: true, facts_count: facts.length });
  } catch (err) {
    logger.error(
      { error: err, scenarioId: req.params?.id },
      'Error in POST /scenarios/:id/retry-custom-facts',
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Pin enrichment helpers — generate rich structured data via LLM
// ---------------------------------------------------------------------------

async function buildScenarioPinEnrichmentContext(scenarioId: string): Promise<string> {
  const { data: scenario } = await supabaseAdmin
    .from('scenarios')
    .select('title, category, description, briefing, insider_knowledge')
    .eq('id', scenarioId)
    .single();

  const ik = ((scenario?.insider_knowledge ?? {}) as Record<string, unknown>) || {};
  const customFacts = Array.isArray(ik.custom_facts)
    ? (ik.custom_facts as Array<Record<string, unknown>>)
    : [];

  const [{ data: hazards }, { data: locations }, { data: researchUsage }] = await Promise.all([
    supabaseAdmin
      .from('scenario_hazards')
      .select('hazard_type, enriched_description, properties')
      .eq('scenario_id', scenarioId)
      .is('session_id', null)
      .order('appears_at_minutes', { ascending: true })
      .limit(18),
    supabaseAdmin
      .from('scenario_locations')
      .select('label, location_type, pin_category')
      .eq('scenario_id', scenarioId)
      .order('display_order', { ascending: true })
      .limit(18),
    supabaseAdmin
      .from('scenario_research_usage')
      .select(
        'relevance_score, research_cases(name, summary, environment, hazards_triggered, secondary_effects)',
      )
      .eq('scenario_id', scenarioId)
      .order('relevance_score', { ascending: false })
      .limit(5),
  ]);

  const hazardsBlock = (hazards ?? [])
    .map((h: Record<string, unknown>) => {
      const props = (h.properties ?? {}) as Record<string, unknown>;
      const label = String(
        props.label ?? h.enriched_description ?? h.hazard_type ?? 'hazard',
      ).slice(0, 160);
      return `- ${label} (${String(h.hazard_type ?? '')})`;
    })
    .join('\n');

  const locationsBlock = (locations ?? [])
    .map(
      (l: Record<string, unknown>) =>
        `- ${String(l.label ?? '')} (${String(l.location_type ?? l.pin_category ?? '')})`,
    )
    .join('\n');

  const researchBlock = (researchUsage ?? [])
    .map((row: Record<string, unknown>) => {
      const rc = row.research_cases as Record<string, unknown>;
      const name = String(rc?.name ?? 'Case');
      const summary = String(rc?.summary ?? '').slice(0, 220);
      return `- ${name}: ${summary}`;
    })
    .join('\n');

  const factsBlock = customFacts.length
    ? customFacts
        .slice(0, 10)
        .map((f) => `- ${String(f.topic ?? 'Fact')}: ${String(f.summary ?? '').slice(0, 220)}`)
        .join('\n')
    : '';

  return [
    `Scenario: ${String(scenario?.title ?? '')} (${String(scenario?.category ?? '')})`,
    scenario?.description ? `Description: ${String(scenario.description).slice(0, 700)}` : '',
    scenario?.briefing ? `Briefing: ${String(scenario.briefing).slice(0, 700)}` : '',
    factsBlock ? `Custom facts:\n${factsBlock}` : '',
    hazardsBlock ? `Existing hazards:\n${hazardsBlock}` : '',
    locationsBlock ? `Key locations:\n${locationsBlock}` : '',
    researchBlock ? `Linked research cases:\n${researchBlock}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function enrichPatientConditions(
  triageColor: string,
  injuryType: string,
  description?: string,
  scenarioContext?: string,
): Promise<Record<string, unknown>> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return {};

  const descHint = description ? `\nDescription provided by trainer: "${description}"` : '';
  const ctx = scenarioContext
    ? `\n\nScenario context (must stay consistent with this):\n${scenarioContext}`
    : '';

  const prompt = `You are a pre-hospital emergency medicine expert. Generate a single realistic patient profile for a crisis training exercise.

Triage color: ${triageColor.toUpperCase()}
Injury type: ${injuryType.replace(/_/g, ' ')}${descHint}
${ctx}

Generate a medically accurate patient profile consistent with the triage color and injury type.

Return ONLY valid JSON:
{
  "injuries": [{ "type": "string", "severity": "minor|moderate|severe|critical", "body_part": "string", "visible_signs": "string" }],
  "triage_color": "${triageColor}",
  "mobility": "ambulatory|non_ambulatory|trapped",
  "consciousness": "alert|confused|unconscious|unresponsive",
  "breathing": "normal|labored|absent",
  "accessibility": "open|in_smoke|under_debris|behind_fire",
  "visible_description": "1-2 sentences of ONLY what a responder SEES approaching — no diagnoses",
  "treatment_requirements": [{ "intervention": "string", "priority": "critical|high|medium", "reason": "string" }],
  "transport_prerequisites": ["string"],
  "contraindications": ["string"],
  "ideal_response_sequence": [{ "step": 1, "action": "string", "detail": "string" }],
  "required_ppe": ["string"],
  "required_equipment": [{ "item": "string", "quantity": 1, "purpose": "string" }],
  "expected_time_to_treat_minutes": 10
}

Rules:
- injuries: 1-3 injuries consistent with the type and severity implied by the triage color
- GREEN = minor, walking wounded. YELLOW = serious but stable. RED = life-threatening, immediate care. BLACK = deceased/expectant.
- ideal_response_sequence: 4-8 ordered steps from approach to handoff (PPE, survey, interventions, packaging)
- required_ppe: at minimum nitrile gloves; add N95/face shield/turnout gear if contamination or burns
- required_equipment: specific items with quantity and purpose (e.g. SAM splint, burn dressing, tourniquet)
- treatment_requirements: real pre-hospital interventions with clinical rationale
- transport_prerequisites: what must be done before safe transport
- contraindications: dangerous actions to avoid for this patient`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1200,
        temperature: 0.7,
      }),
    });

    if (!res.ok) return {};
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content as string | undefined;
    if (!raw) return {};
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch (err) {
    logger.warn({ err }, 'Patient enrichment failed; using basic conditions');
    return {};
  }
}

async function enrichHazardDetails(
  hazardType: string,
  description?: string,
  scenarioContext?: string,
): Promise<{
  properties: Record<string, unknown>;
  resolution_requirements: Record<string, unknown>;
  equipment_requirements: Array<Record<string, unknown>>;
  enriched_description: string;
}> {
  const apiKey = process.env.OPENAI_API_KEY;
  const fallback = {
    properties: { severity: 'medium', description: description || hazardType.replace(/_/g, ' ') },
    resolution_requirements: {},
    equipment_requirements: [],
    enriched_description: description || hazardType.replace(/_/g, ' '),
  };
  if (!apiKey) return fallback;

  const descHint = description ? `\nDescription: "${description}"` : '';
  const ctx = scenarioContext
    ? `\n\nScenario context (must stay consistent with this):\n${scenarioContext}`
    : '';

  const prompt = `You are an emergency response expert. Generate detailed hazard data for a crisis training exercise.

Hazard type: ${hazardType.replace(/_/g, ' ')}${descHint}${ctx}

Return ONLY valid JSON:
{
  "properties": {
    "severity": "low|medium|high|critical",
    "description": "2-3 sentence description of what responders see",
    "fuel_source": "what is burning/leaking/collapsing (if applicable)",
    "spread_risk": "low|medium|high"
  },
  "enriched_description": "1-2 sentence vivid description for display",
  "resolution_requirements": {
    "ideal_response_sequence": [
      { "step": 1, "action": "string", "detail": "string", "responsible_team": "string" }
    ],
    "required_ppe": [{ "item": "string", "mandatory": true }],
    "estimated_resolution_minutes": 30
  },
  "equipment_requirements": [
    { "equipment_type": "string", "label": "string", "quantity": 1, "critical": true }
  ]
}

Rules:
- ideal_response_sequence: 4-8 steps from approach to resolution (zone setup, PPE, containment, mitigation, monitoring)
- required_ppe: specific items needed to approach this hazard safely
- equipment_requirements: 2-4 items with realistic quantities`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1000,
        temperature: 0.7,
      }),
    });

    if (!res.ok) return fallback;
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content as string | undefined;
    if (!raw) return fallback;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    return {
      properties: (parsed.properties as Record<string, unknown>) || fallback.properties,
      resolution_requirements: (parsed.resolution_requirements as Record<string, unknown>) || {},
      equipment_requirements:
        (parsed.equipment_requirements as Array<Record<string, unknown>>) || [],
      enriched_description:
        (parsed.enriched_description as string) || fallback.enriched_description,
    };
  } catch (err) {
    logger.warn({ err }, 'Hazard enrichment failed; using basic details');
    return fallback;
  }
}

async function enrichCrowdConditions(
  crowdType: string,
  headcount: number,
  behavior?: string,
  description?: string,
  scenarioContext?: string,
): Promise<Record<string, unknown>> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey)
    return {
      behavior: behavior || 'calm',
      description: description || `Group of ~${headcount} people`,
    };

  const descHint = description ? `\nDescription: "${description}"` : '';
  const ctx = scenarioContext
    ? `\n\nScenario context (must stay consistent with this):\n${scenarioContext}`
    : '';

  const prompt = `You are a crowd psychology expert. Generate realistic crowd profile data for a crisis training exercise.

Crowd type: ${crowdType.replace(/_/g, ' ')}
Headcount: ~${headcount}
Behavior: ${behavior || 'unknown'}${descHint}${ctx}

Return ONLY valid JSON:
{
  "behavior": "calm|anxious|panicking|hostile|cooperative",
  "description": "2-3 sentence description of what responders observe",
  "movement_pattern": "stationary|milling|fleeing|converging",
  "special_needs": ["elderly", "children", "disabled", "non_english_speakers"],
  "risk_factors": ["stampede_risk", "bottleneck", "crush_potential", "medical_emergencies_likely"],
  "management_requirements": {
    "personnel_ratio": "1:25 marshal-to-evacuee",
    "equipment_needed": ["megaphone", "barrier_tape", "high_vis_vests"],
    "priority_actions": ["establish_cordon", "identify_exit_routes", "deploy_marshals"]
  },
  "estimated_evacuation_minutes": 15,
  "injured_count_estimate": 0
}

Rules:
- Tailor the response to the crowd type (evacuee group vs convergent crowd vs bystanders)
- injured_count_estimate: 0 for calm crowds, 1-3 for panicking (trampling), 0 for convergent
- risk_factors: only include realistic risks for this crowd size and behavior`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 800,
        temperature: 0.7,
      }),
    });

    if (!res.ok) return {};
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content as string | undefined;
    if (!raw) return {};
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch (err) {
    logger.warn({ err }, 'Crowd enrichment failed; using basic conditions');
    return {
      behavior: behavior || 'calm',
      description: description || `Group of ~${headcount} people`,
    };
  }
}

// ── Create a single pin (trainer/admin — scenario preview editing) ──
router.post('/:id/pins', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    if (user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { id: scenarioId } = req.params;
    const { pin_type, data } = req.body as {
      pin_type: 'location' | 'hazard' | 'casualty';
      data: Record<string, unknown>;
    };

    if (!pin_type || !data) {
      return res.status(400).json({ error: 'pin_type and data are required' });
    }

    const BLOCKED_LOCATION_TYPES = new Set([
      'triage_point',
      'field_hospital',
      'casualty_collection',
      'ambulance_staging',
      'helicopter_lz',
      'command_post',
      'forward_command',
      'staging_area',
      'marshal_post',
      'assembly_point',
      'reunification_point',
      'inner_cordon',
      'outer_cordon',
      'press_cordon',
      'media_staging',
      'decontamination_zone',
      'exclusion_zone',
      'fire_truck',
      'water_supply',
      'roadblock',
      'observation_post',
    ]);

    if (pin_type === 'location') {
      const locType = (data.location_type as string) || '';
      if (BLOCKED_LOCATION_TYPES.has(locType)) {
        return res.status(400).json({
          error: `Location type "${locType}" is responder infrastructure and cannot be manually added`,
        });
      }

      const row = {
        scenario_id: scenarioId,
        label: data.label || 'Unnamed Pin',
        location_type: data.location_type || 'poi',
        coordinates: { lat: data.lat, lng: data.lng },
        pin_category: data.pin_category || null,
        conditions: data.conditions || {},
        claimable_by: data.location_type === 'entry_exit' ? ['all'] : null,
      };

      const { data: inserted, error } = await supabaseAdmin
        .from('scenario_locations')
        .insert(row)
        .select()
        .single();

      if (error) {
        logger.error({ error, scenarioId }, 'Failed to create location pin');
        return res.status(500).json({ error: 'Failed to create pin' });
      }
      return res.json({ ok: true, pin: inserted });
    }

    if (pin_type === 'hazard') {
      const hazardType = (data.hazard_type as string) || 'unknown';
      const desc = (data.label as string) || (data.description as string) || '';

      logger.info({ hazardType, desc }, 'Enriching hazard pin via LLM');
      const scenarioCtx = await buildScenarioPinEnrichmentContext(scenarioId);
      const hazardEnriched = await enrichHazardDetails(hazardType, desc || undefined, scenarioCtx);

      const row = {
        scenario_id: scenarioId,
        session_id: null,
        hazard_type: hazardType,
        location_lat: data.lat,
        location_lng: data.lng,
        floor_level: (data.floor_level as string) || 'G',
        properties: hazardEnriched.properties,
        status: 'active',
        appears_at_minutes: 0,
        enriched_description: hazardEnriched.enriched_description,
        zones: [],
        resolution_requirements: hazardEnriched.resolution_requirements,
        equipment_requirements: hazardEnriched.equipment_requirements,
      };

      const { data: inserted, error } = await supabaseAdmin
        .from('scenario_hazards')
        .insert(row)
        .select()
        .single();

      if (error) {
        logger.error({ error, scenarioId }, 'Failed to create hazard pin');
        return res.status(500).json({ error: 'Failed to create pin' });
      }

      // For explosion-type hazards, auto-create blast zone locations
      const explosionRe = /explosion|bomb|blast|detonat|ied/i;
      if (explosionRe.test(String(row.hazard_type))) {
        const lat = Number(data.lat);
        const lng = Number(data.lng);
        const blastRadii = [
          { radius_m: 15, zone_type: 'blast_lethal', label: 'Lethal Zone (0–49 ft)' },
          { radius_m: 30, zone_type: 'blast_severe', label: 'Severe Injury Zone (49–98 ft)' },
          { radius_m: 50, zone_type: 'blast_fragment', label: 'Fragment Zone (98–164 ft)' },
        ];
        for (const br of blastRadii) {
          await supabaseAdmin.from('scenario_locations').insert({
            scenario_id: scenarioId,
            label: br.label,
            location_type: 'blast_radius',
            coordinates: { lat, lng },
            pin_category: 'blast_zone',
            conditions: {
              zone_type: br.zone_type,
              radius_m: br.radius_m,
              polygon: circleToPolygon(lat, lng, br.radius_m),
              linked_hazard_id: (inserted as Record<string, unknown>).id,
            },
          });
        }
      }

      return res.json({ ok: true, pin: inserted });
    }

    if (pin_type === 'casualty') {
      const casualtyType = (data.casualty_type as string) || 'individual';
      let conditions: Record<string, unknown> = (data.conditions as Record<string, unknown>) || {};
      const scenarioCtx = await buildScenarioPinEnrichmentContext(scenarioId);

      if (casualtyType === 'individual' || casualtyType === 'patient') {
        const triageColor =
          (data.triage_color as string) || (conditions.triage_color as string) || 'yellow';
        const injuryType =
          (data.injury_type as string) || (conditions.injury_type as string) || 'blunt_trauma';
        const desc =
          (data.description as string) || (conditions.injury_description as string) || '';

        logger.info({ triageColor, injuryType, desc }, 'Enriching patient pin via LLM');
        const enriched = await enrichPatientConditions(
          triageColor,
          injuryType,
          desc || undefined,
          scenarioCtx,
        );
        if (Object.keys(enriched).length > 0) {
          conditions = { ...conditions, ...enriched };
        } else {
          conditions = {
            ...conditions,
            triage_color: triageColor,
            injury_type: injuryType,
            visible_description: desc || `Patient with ${injuryType.replace(/_/g, ' ')}`,
          };
        }
      } else if (casualtyType === 'crowd' || casualtyType === 'group') {
        const headcount = Number(data.headcount) || 10;
        const behavior = (data.behavior as string) || (conditions.behavior as string) || 'anxious';
        const desc = (data.description as string) || (conditions.description as string) || '';

        logger.info(
          { crowdType: casualtyType, headcount, behavior },
          'Enriching crowd pin via LLM',
        );
        const enriched = await enrichCrowdConditions(
          casualtyType,
          headcount,
          behavior,
          desc || undefined,
          scenarioCtx,
        );
        if (Object.keys(enriched).length > 0) {
          conditions = { ...conditions, ...enriched };
        }
      }

      const row = {
        scenario_id: scenarioId,
        session_id: null,
        casualty_type: casualtyType,
        location_lat: data.lat,
        location_lng: data.lng,
        floor_level: (data.floor_level as string) || 'G',
        headcount: Number(data.headcount) || 1,
        conditions,
        status: 'undiscovered',
        appears_at_minutes: 0,
      };

      const { data: inserted, error } = await supabaseAdmin
        .from('scenario_casualties')
        .insert(row)
        .select()
        .single();

      if (error) {
        logger.error({ error, scenarioId }, 'Failed to create casualty pin');
        return res.status(500).json({ error: 'Failed to create pin' });
      }
      return res.json({ ok: true, pin: inserted });
    }

    return res.status(400).json({ error: `Unknown pin_type: ${pin_type}` });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /scenarios/:id/pins');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Delete a single pin (trainer/admin — scenario preview editing) ──
router.delete('/:id/pins/:pinId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    if (user.role !== 'trainer' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { id: scenarioId, pinId } = req.params;
    const pinType = (req.query.pin_type as string) || '';

    if (!['location', 'hazard', 'casualty'].includes(pinType)) {
      return res
        .status(400)
        .json({ error: 'pin_type query param must be location, hazard, or casualty' });
    }

    if (pinType === 'location') {
      const { error } = await supabaseAdmin
        .from('scenario_locations')
        .delete()
        .eq('id', pinId)
        .eq('scenario_id', scenarioId);
      if (error) {
        logger.error({ error, scenarioId, pinId }, 'Failed to delete location pin');
        return res.status(500).json({ error: 'Failed to delete pin' });
      }
    } else if (pinType === 'hazard') {
      // Also delete linked blast_zone locations
      await supabaseAdmin
        .from('scenario_locations')
        .delete()
        .eq('scenario_id', scenarioId)
        .eq('pin_category', 'blast_zone')
        .filter('conditions->>linked_hazard_id', 'eq', pinId);

      const { error } = await supabaseAdmin
        .from('scenario_hazards')
        .delete()
        .eq('id', pinId)
        .eq('scenario_id', scenarioId);
      if (error) {
        logger.error({ error, scenarioId, pinId }, 'Failed to delete hazard pin');
        return res.status(500).json({ error: 'Failed to delete pin' });
      }
    } else if (pinType === 'casualty') {
      const { error } = await supabaseAdmin
        .from('scenario_casualties')
        .delete()
        .eq('id', pinId)
        .eq('scenario_id', scenarioId);
      if (error) {
        logger.error({ error, scenarioId, pinId }, 'Failed to delete casualty pin');
        return res.status(500).json({ error: 'Failed to delete pin' });
      }
    }

    logger.info({ scenarioId, pinId, pinType, userId: user.id }, 'Pin deleted');
    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err }, 'Error in DELETE /scenarios/:id/pins/:pinId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

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

// ---------------------------------------------------------------------------
// GET /scenarios/:id/building-studs — stud grids with occupancy for frontend
// ---------------------------------------------------------------------------

router.get('/:id/building-studs', requireAuth, async (req, res) => {
  try {
    const { id: scenarioId } = req.params;
    const sessionId = req.query.sessionId as string | undefined;
    const floor = (req.query.floor as string) || undefined;

    const grids = await loadClassifiedGrids(scenarioId);
    if (grids.length === 0) {
      return res.json({ grids: [], occupiedStudIds: [] });
    }

    const occupied = await getOccupiedStudIds(scenarioId, grids, sessionId);

    const responseGrids = grids.map((g) => ({
      buildingIndex: g.buildingIndex,
      buildingName: g.buildingName,
      polygon: g.polygon,
      floors: g.floors,
      spacingM: g.spacingM,
      studs: g.studs
        .filter((s) => !floor || s.floor === floor)
        .map((s) => ({
          id: s.id,
          lat: s.lat,
          lng: s.lng,
          floor: s.floor,
          occupied: occupied.has(s.id),
          blastBand: s.blastBand ?? null,
          operationalZone: s.operationalZone ?? null,
          distFromIncidentM: s.distFromIncidentM != null ? Math.round(s.distFromIncidentM) : null,
        })),
    }));

    res.json({ grids: responseGrids });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /scenarios/:id/building-studs');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /scenarios/:id/backfill-buildings — fetch OSM buildings for scenarios missing them
// ---------------------------------------------------------------------------

router.post('/:id/backfill-buildings', requireAuth, async (req, res) => {
  try {
    const { id: scenarioId } = req.params;
    const radiusM = Number(req.query.radius) || 300;

    const { data: sc, error: scErr } = await supabaseAdmin
      .from('scenarios')
      .select('center_lat, center_lng, insider_knowledge')
      .eq('id', scenarioId)
      .single();

    if (scErr || !sc) {
      return res.status(404).json({ error: 'Scenario not found' });
    }

    const ik = (sc.insider_knowledge ?? {}) as Record<string, unknown>;
    const osmVicinity = (ik.osm_vicinity ?? {}) as Record<string, unknown>;

    const existingBuildings = osmVicinity.buildings as unknown[] | undefined;
    if (existingBuildings?.length) {
      return res.json({
        status: 'already_populated',
        buildingCount: existingBuildings.length,
        message: 'Buildings already exist in insider_knowledge',
      });
    }

    let lat = sc.center_lat as number | null;
    let lng = sc.center_lng as number | null;

    if (lat == null || lng == null) {
      const { data: hazards } = await supabaseAdmin
        .from('scenario_hazards')
        .select('location_lat, location_lng')
        .eq('scenario_id', scenarioId)
        .limit(1);

      if (hazards?.length) {
        lat = hazards[0].location_lat as number;
        lng = hazards[0].location_lng as number;
      }
    }

    if (lat == null || lng == null) {
      return res.status(400).json({
        error: 'No coordinates available — scenario has no center_lat/center_lng and no hazards',
      });
    }

    const buildings = await fetchVenueBuilding(lat, lng, radiusM);

    if (buildings.length === 0) {
      return res.json({
        status: 'no_buildings_found',
        buildingCount: 0,
        lat,
        lng,
        radiusM,
        message: 'Overpass returned 0 buildings at these coordinates',
      });
    }

    const updatedOsmVicinity = { ...osmVicinity, buildings };
    const updatedIk = { ...ik, osm_vicinity: updatedOsmVicinity };

    const { error: updateErr } = await supabaseAdmin
      .from('scenarios')
      .update({ insider_knowledge: updatedIk })
      .eq('id', scenarioId);

    if (updateErr) {
      logger.error(
        { error: updateErr, scenarioId },
        'Failed to update insider_knowledge with buildings',
      );
      return res.status(500).json({ error: 'Failed to save building data' });
    }

    invalidateGridCache(scenarioId);

    logger.info(
      { scenarioId, buildingCount: buildings.length, lat, lng, radiusM },
      'Backfilled buildings for scenario',
    );

    return res.json({
      status: 'backfilled',
      buildingCount: buildings.length,
      buildings: buildings.map((b) => ({
        name: b.name,
        hasPolygon: !!(b.footprint_polygon && b.footprint_polygon.length >= 3),
        distance: Math.round(b.distance_from_center_m),
      })),
      lat,
      lng,
      radiusM,
    });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /scenarios/:id/backfill-buildings');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as scenariosRouter };
