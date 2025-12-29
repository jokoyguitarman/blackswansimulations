import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { validate } from '../lib/validation.js';

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
      const updates = req.body;

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

      logger.info({ scenarioId: id, userId: user.id }, 'Scenario updated');
      res.json({ data });
    } catch (err) {
      logger.error({ error: err }, 'Error in PATCH /scenarios/:id');
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
        const injectsToInsert = originalInjects.map((inject: any) => ({
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
