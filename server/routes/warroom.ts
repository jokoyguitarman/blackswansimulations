import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';
import { validate } from '../lib/validation.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import {
  generateAndPersistWarroomScenario,
  suggestWarroomTeams,
  stageParseAndGeocode,
  stageTeamsAndNarrative,
  stageResearchDoctrines,
  stageGenerateAndPersist,
  buildUserTeams,
  type WarroomProgressPhase,
  type DoctrineResearchResult,
  type ParseAndGeocodeResult,
  type WarroomTeamInput,
} from '../services/warroomService.js';

function applyWizardGeocodeOverride(
  geoResult: ParseAndGeocodeResult,
  body: Record<string, unknown>,
): void {
  const o = body.geocode_override as
    | { lat: number; lng: number; display_name?: string }
    | undefined;
  if (!o || typeof o.lat !== 'number' || typeof o.lng !== 'number') return;
  geoResult.geocodeResult = {
    lat: o.lat,
    lng: o.lng,
    display_name: o.display_name || geoResult.venueName,
  };
}
import { env } from '../env.js';

const router = Router();

function writeProgress(
  res: import('express').Response,
  phase: WarroomProgressPhase,
  message: string,
) {
  res.write(JSON.stringify({ type: 'progress', phase, message }) + '\n');
}

const teamSchema = z.object({
  team_name: z.string().min(1).max(100),
  team_description: z.string().max(500).optional(),
  min_participants: z.number().int().min(1).max(50).optional(),
  max_participants: z.number().int().min(1).max(50).optional(),
});

const generateSchema = z.object({
  body: z.object({
    prompt: z.string().max(2000).optional(),
    scenario_type: z
      .enum([
        'open_field_shooting',
        'knife_attack',
        'gas_attack',
        'kidnapping',
        'car_bomb',
        'bombing',
        'bombing_mall',
        'suicide_bombing',
        'vehicle_ramming',
        'poisoning',
        'infrastructure_attack',
        'hostage_siege',
        'hijacking',
        'arson',
        'assassination',
        'stampede_crush',
        'active_shooter',
        'biohazard',
        'nuclear_plant_leak',
      ])
      .optional(),
    setting: z
      .enum([
        'beach',
        'subway',
        'mall',
        'resort',
        'hotel',
        'train',
        'open_field',
        'stadium',
        'concert',
        'festival',
        'government',
        'conference',
        'airport',
        'school',
        'hospital',
        'embassy',
        'power_plant',
      ])
      .optional(),
    terrain: z
      .enum(['jungle', 'mountain', 'coastal', 'desert', 'urban', 'rural', 'swamp', 'island'])
      .optional(),
    location: z.string().max(500).optional(),
    complexity_tier: z.enum(['minimal', 'standard', 'full', 'rich']).optional(),
    duration_minutes: z.number().int().min(20).max(240).optional(),
    include_adversary_pursuit: z.boolean().optional(),
    inject_profiles: z.array(z.string().min(1).max(50)).min(2).max(35).optional(),
    secondary_devices_count: z.number().int().min(0).max(10).optional(),
    real_bombs_count: z.number().int().min(0).max(10).optional(),
    teams: z.array(teamSchema).optional(),
  }),
});

const suggestTeamsSchema = z.object({
  body: z.object({
    prompt: z.string().max(2000).optional(),
    scenario_type: z
      .enum([
        'open_field_shooting',
        'knife_attack',
        'gas_attack',
        'kidnapping',
        'car_bomb',
        'bombing',
        'bombing_mall',
        'suicide_bombing',
        'vehicle_ramming',
        'poisoning',
        'infrastructure_attack',
        'hostage_siege',
        'hijacking',
        'arson',
        'assassination',
        'stampede_crush',
        'active_shooter',
        'biohazard',
        'nuclear_plant_leak',
      ])
      .optional(),
    setting: z
      .enum([
        'beach',
        'subway',
        'mall',
        'resort',
        'hotel',
        'train',
        'open_field',
        'stadium',
        'concert',
        'festival',
        'government',
        'conference',
        'airport',
        'school',
        'hospital',
        'embassy',
        'power_plant',
      ])
      .optional(),
    terrain: z
      .enum(['jungle', 'mountain', 'coastal', 'desert', 'urban', 'rural', 'swamp', 'island'])
      .optional(),
    location: z.string().max(500).optional(),
  }),
});

router.post(
  '/suggest-teams',
  requireAuth,
  validate(suggestTeamsSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const { prompt, scenario_type, setting, terrain, location } = req.body;

      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can use the War Room' });
      }

      if (!env.openAiApiKey) {
        return res.status(500).json({ error: 'OpenAI API key not configured' });
      }

      if (!prompt && !scenario_type) {
        return res
          .status(400)
          .json({ error: 'Provide either prompt or scenario_type (with setting, terrain)' });
      }

      const result = await suggestWarroomTeams(
        { prompt, scenario_type, setting, terrain, location },
        env.openAiApiKey,
      );
      res.json({ data: result });
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      logger.error({ error: error.message }, 'Error in POST /warroom/suggest-teams');
      const statusCode =
        error.statusCode && error.statusCode >= 400 && error.statusCode < 600
          ? error.statusCode
          : 500;
      res.status(statusCode).json({
        error: error.message || 'Failed to suggest teams',
      });
    }
  },
);

router.post(
  '/generate',
  requireAuth,
  validate(generateSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const {
        prompt,
        scenario_type,
        setting,
        terrain,
        location,
        complexity_tier,
        duration_minutes,
        include_adversary_pursuit,
        inject_profiles,
        secondary_devices_count,
        real_bombs_count,
        teams,
      } = req.body;

      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can use the War Room' });
      }

      if (!env.openAiApiKey) {
        return res.status(500).json({ error: 'OpenAI API key not configured' });
      }

      if (!prompt && !scenario_type) {
        return res
          .status(400)
          .json({ error: 'Provide either prompt or scenario_type (with setting, terrain)' });
      }

      logger.info(
        { userId: user.id, prompt: prompt?.slice(0, 50), scenario_type, setting, terrain },
        'War Room generate requested',
      );

      const { scenarioId } = await generateAndPersistWarroomScenario(
        {
          prompt,
          scenario_type,
          setting,
          terrain,
          location,
          complexity_tier,
          duration_minutes,
          include_adversary_pursuit,
          inject_profiles,
          secondary_devices_count,
          real_bombs_count,
          teams,
        },
        env.openAiApiKey,
        user.id,
      );

      logger.info({ userId: user.id, scenarioId }, 'War Room scenario created');
      res.json({ data: { scenarioId } });
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      logger.error({ error: error.message }, 'Error in POST /warroom/generate');

      const statusCode =
        error.statusCode && error.statusCode >= 400 && error.statusCode < 600
          ? error.statusCode
          : 500;

      res.status(statusCode).json({
        error: error.message || 'Failed to generate scenario',
      });
    }
  },
);

// Streaming generate: same as /generate but streams progress events as NDJSON
// Support both with and without trailing slash for proxy/CDN compatibility
router.post(
  ['/generate-stream', '/generate-stream/'],
  requireAuth,
  validate(generateSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const {
        prompt,
        scenario_type,
        setting,
        terrain,
        location,
        complexity_tier,
        duration_minutes,
        include_adversary_pursuit,
        inject_profiles,
        secondary_devices_count,
        real_bombs_count,
        teams,
      } = req.body;

      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can use the War Room' });
      }

      if (!env.openAiApiKey) {
        return res.status(500).json({ error: 'OpenAI API key not configured' });
      }

      if (!prompt && !scenario_type) {
        return res
          .status(400)
          .json({ error: 'Provide either prompt or scenario_type (with setting, terrain)' });
      }

      logger.info(
        { userId: user.id, prompt: prompt?.slice(0, 50), scenario_type, setting, terrain },
        'War Room generate-stream requested',
      );

      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.flushHeaders?.();

      const onProgress = (phase: WarroomProgressPhase, message: string) => {
        writeProgress(res, phase, message);
        res.flushHeaders?.();
      };

      const { scenarioId } = await generateAndPersistWarroomScenario(
        {
          prompt,
          scenario_type,
          setting,
          terrain,
          location,
          complexity_tier,
          duration_minutes,
          include_adversary_pursuit,
          inject_profiles,
          secondary_devices_count,
          real_bombs_count,
          teams,
        },
        env.openAiApiKey,
        user.id,
        onProgress,
      );

      res.write(JSON.stringify({ type: 'done', data: { scenarioId } }) + '\n');
      logger.info({ userId: user.id, scenarioId }, 'War Room scenario created (stream)');
      res.end();
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      logger.error({ error: error.message }, 'Error in POST /warroom/generate-stream');
      if (!res.headersSent) {
        const statusCode =
          error.statusCode && error.statusCode >= 400 && error.statusCode < 600
            ? error.statusCode
            : 500;
        res.status(statusCode).json({
          error: error.message || 'Failed to generate scenario',
        });
      } else {
        res.write(
          JSON.stringify({
            type: 'error',
            error: error.message || 'Failed to generate scenario',
          }) + '\n',
        );
        res.end();
      }
    }
  },
);

// ---------------------------------------------------------------------------
// Wizard Mode Endpoints (multi-step human-in-the-loop generation)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Wizard Drafts (DB-backed, resumable)
// ---------------------------------------------------------------------------

const wizardDraftCreateSchema = z.object({
  body: z.object({
    input: z.record(z.string(), z.unknown()).default({}),
  }),
});

router.post(
  ['/wizard/drafts', '/wizard/drafts/'],
  requireAuth,
  validate(wizardDraftCreateSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can use the War Room' });
      }

      const { input } = req.body as { input: Record<string, unknown> };
      const { data, error } = await supabaseAdmin
        .from('warroom_wizard_drafts')
        .insert({
          created_by: user.id,
          status: 'draft',
          current_step: 1,
          input: input ?? {},
        })
        .select('id')
        .single();

      if (error || !data) {
        logger.error({ error }, 'Failed to create wizard draft');
        return res.status(500).json({ error: 'Failed to create wizard draft' });
      }

      return res.json({ data: { draft_id: data.id } });
    } catch (err) {
      const error = err as Error;
      logger.error({ error: error.message }, 'Error in POST /warroom/wizard/drafts');
      return res.status(500).json({ error: error.message || 'Draft creation failed' });
    }
  },
);

router.get(
  ['/wizard/drafts/:id', '/wizard/drafts/:id/'],
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can use the War Room' });
      }
      const draftId = req.params.id;
      const { data, error } = await supabaseAdmin
        .from('warroom_wizard_drafts')
        .select('*')
        .eq('id', draftId)
        .single();
      if (error || !data) return res.status(404).json({ error: 'Draft not found' });

      // Basic access control: creator or admin
      if (data.created_by && data.created_by !== user.id && user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }

      return res.json({ data });
    } catch (err) {
      const error = err as Error;
      logger.error({ error: error.message }, 'Error in GET /warroom/wizard/drafts/:id');
      return res.status(500).json({ error: error.message || 'Draft fetch failed' });
    }
  },
);

const wizardDraftPatchSchema = z.object({
  body: z.object({
    status: z.string().optional(),
    current_step: z.number().int().min(1).max(10).optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    validated_doctrines: z.record(z.string(), z.unknown()).optional(),
  }),
});

router.patch(
  ['/wizard/drafts/:id', '/wizard/drafts/:id/'],
  requireAuth,
  validate(wizardDraftPatchSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can use the War Room' });
      }
      const draftId = req.params.id;

      const { data: draft, error: fetchErr } = await supabaseAdmin
        .from('warroom_wizard_drafts')
        .select('id, created_by, input')
        .eq('id', draftId)
        .single();
      if (fetchErr || !draft) return res.status(404).json({ error: 'Draft not found' });
      if (draft.created_by && draft.created_by !== user.id && user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }

      const patch = req.body as Record<string, unknown>;
      const updatePayload: Record<string, unknown> = {};
      if (typeof patch.status === 'string') updatePayload.status = patch.status;
      if (typeof patch.current_step === 'number') updatePayload.current_step = patch.current_step;
      if (patch.input && typeof patch.input === 'object') {
        updatePayload.input = {
          ...(draft.input ?? {}),
          ...(patch.input as Record<string, unknown>),
        };
      }
      if (patch.validated_doctrines && typeof patch.validated_doctrines === 'object') {
        updatePayload.validated_doctrines = patch.validated_doctrines;
      }

      const { data: updated, error: upErr } = await supabaseAdmin
        .from('warroom_wizard_drafts')
        .update(updatePayload)
        .eq('id', draftId)
        .select('*')
        .single();
      if (upErr || !updated) return res.status(500).json({ error: 'Failed to update draft' });
      return res.json({ data: updated });
    } catch (err) {
      const error = err as Error;
      logger.error({ error: error.message }, 'Error in PATCH /warroom/wizard/drafts/:id');
      return res.status(500).json({ error: error.message || 'Draft update failed' });
    }
  },
);

router.post(
  ['/wizard/drafts/:id/geocode-validate', '/wizard/drafts/:id/geocode-validate/'],
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can use the War Room' });
      }
      if (!env.openAiApiKey)
        return res.status(500).json({ error: 'OpenAI API key not configured' });

      const draftId = req.params.id;
      const { data: draft, error: fetchErr } = await supabaseAdmin
        .from('warroom_wizard_drafts')
        .select('id, created_by, input')
        .eq('id', draftId)
        .single();
      if (fetchErr || !draft) return res.status(404).json({ error: 'Draft not found' });
      if (draft.created_by && draft.created_by !== user.id && user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }

      const input = (draft.input ?? {}) as Record<string, unknown>;
      const result = await stageParseAndGeocode(input, env.openAiApiKey);
      applyWizardGeocodeOverride(result, input);

      const { error: upErr } = await supabaseAdmin
        .from('warroom_wizard_drafts')
        .update({
          geo_result: result as unknown,
          geocode_result: result.geocodeResult as unknown,
          osm_vicinity: (result.osmVicinity ?? null) as unknown,
          area_dossier: result.areaSummary || null,
          research_archive: {
            area_structured: (result as unknown as Record<string, unknown>).areaStructured ?? null,
            hazard_material_context:
              (result as unknown as Record<string, unknown>).hazardMaterialContext ?? null,
            sensitive_infrastructure:
              (result as unknown as Record<string, unknown>).sensitiveInfrastructure ?? null,
          },
          current_step: 2,
        })
        .eq('id', draftId);
      if (upErr) {
        logger.error({ error: upErr }, 'Failed to update draft with geocode results');
      }

      return res.json({
        data: {
          draft_id: draftId,
          parsed: {
            scenario_type: result.parsed.scenario_type,
            setting: result.parsed.setting,
            terrain: result.parsed.terrain,
            location: result.parsed.location,
            venue_name: result.parsed.venue_name,
            landmarks: result.parsed.landmarks,
          },
          geocode: result.geocodeResult,
          osmVicinity: result.osmVicinity ?? null,
          areaSummary: result.areaSummary || null,
          venueName: result.venueName,
          researchArchive: {
            area_structured: (result as unknown as Record<string, unknown>).areaStructured ?? null,
            hazard_material_context:
              (result as unknown as Record<string, unknown>).hazardMaterialContext ?? null,
            sensitive_infrastructure:
              (result as unknown as Record<string, unknown>).sensitiveInfrastructure ?? null,
          },
        },
      });
    } catch (err) {
      const error = err as Error;
      logger.error(
        { error: error.message },
        'Error in POST /warroom/wizard/drafts/:id/geocode-validate',
      );
      return res.status(500).json({ error: error.message || 'Geocode validation failed' });
    }
  },
);

router.post(
  ['/wizard/drafts/:id/research-doctrines', '/wizard/drafts/:id/research-doctrines/'],
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can use the War Room' });
      }
      if (!env.openAiApiKey)
        return res.status(500).json({ error: 'OpenAI API key not configured' });

      const draftId = req.params.id;
      const { data: draft, error: fetchErr } = await supabaseAdmin
        .from('warroom_wizard_drafts')
        .select('id, created_by, input, geo_result')
        .eq('id', draftId)
        .single();
      if (fetchErr || !draft) return res.status(404).json({ error: 'Draft not found' });
      if (draft.created_by && draft.created_by !== user.id && user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }
      if (!draft.geo_result)
        return res
          .status(400)
          .json({ error: 'Draft is missing geo_result; run geocode-validate first' });

      const geoResult = structuredClone(draft.geo_result) as unknown as ParseAndGeocodeResult;
      const input = (draft.input ?? {}) as Record<string, unknown>;
      applyWizardGeocodeOverride(geoResult, input);

      const { phase1Preview, userTeams } = await stageTeamsAndNarrative(
        geoResult as unknown as Parameters<typeof stageTeamsAndNarrative>[0],
        input as unknown as Parameters<typeof stageTeamsAndNarrative>[1],
        env.openAiApiKey,
      );

      const doctrines = await stageResearchDoctrines(
        phase1Preview,
        geoResult as unknown as Parameters<typeof stageResearchDoctrines>[1],
        userTeams,
        env.openAiApiKey,
      );

      await supabaseAdmin
        .from('warroom_wizard_drafts')
        .update({
          phase1_preview: phase1Preview as unknown,
          doctrines: {
            standardsFindings: doctrines.standardsFindings,
            perTeamDoctrines: doctrines.perTeamDoctrines,
            teamWorkflows: doctrines.teamWorkflows,
          },
          current_step: 3,
        })
        .eq('id', draftId);

      return res.json({
        data: {
          draft_id: draftId,
          phase1Preview,
          doctrines: {
            standardsFindings: doctrines.standardsFindings,
            perTeamDoctrines: doctrines.perTeamDoctrines,
            teamWorkflows: doctrines.teamWorkflows,
          },
          geocode: (geoResult as unknown as Record<string, unknown>).geocodeResult ?? null,
          areaSummary: (geoResult as unknown as Record<string, unknown>).areaSummary ?? null,
        },
      });
    } catch (err) {
      const error = err as Error;
      logger.error(
        { error: error.message },
        'Error in POST /warroom/wizard/drafts/:id/research-doctrines',
      );
      return res.status(500).json({ error: error.message || 'Doctrine research failed' });
    }
  },
);

// Persist scenario from a draft in one shot (used by Quick Generate and Wizard finalization)
router.post(
  ['/wizard/drafts/:id/persist', '/wizard/drafts/:id/persist/'],
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can use the War Room' });
      }
      if (!env.openAiApiKey)
        return res.status(500).json({ error: 'OpenAI API key not configured' });

      const draftId = req.params.id;
      const { data: draft, error: fetchErr } = await supabaseAdmin
        .from('warroom_wizard_drafts')
        .select(
          'id, created_by, input, geo_result, phase1_preview, doctrines, validated_doctrines, scenario_id',
        )
        .eq('id', draftId)
        .single();
      if (fetchErr || !draft) return res.status(404).json({ error: 'Draft not found' });
      if (draft.created_by && draft.created_by !== user.id && user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }
      if (draft.scenario_id) {
        return res.json({ data: { scenarioId: draft.scenario_id, draft_id: draftId } });
      }
      if (!draft.geo_result) return res.status(400).json({ error: 'Draft is missing geo_result' });
      if (!draft.phase1_preview)
        return res.status(400).json({ error: 'Draft is missing phase1_preview' });
      if (!draft.doctrines) return res.status(400).json({ error: 'Draft is missing doctrines' });

      const geoResult = structuredClone(draft.geo_result) as unknown as ParseAndGeocodeResult;
      const phase1Preview = draft.phase1_preview as unknown as Parameters<
        typeof stageGenerateAndPersist
      >[1];
      const input = (draft.input ?? {}) as Record<string, unknown>;
      applyWizardGeocodeOverride(geoResult, input);

      const userTeams = buildUserTeams(input.teams as WarroomTeamInput[] | undefined);

      const baseDoc = (draft.doctrines ?? {}) as Record<string, unknown>;
      const valDoc = (draft.validated_doctrines ?? null) as Record<string, unknown> | null;
      const doctrines = {
        standardsFindings: (valDoc?.standardsFindings ??
          baseDoc.standardsFindings ??
          []) as DoctrineResearchResult['standardsFindings'],
        perTeamDoctrines: (valDoc?.perTeamDoctrines ??
          baseDoc.perTeamDoctrines ??
          {}) as DoctrineResearchResult['perTeamDoctrines'],
        teamWorkflows: (valDoc?.teamWorkflows ??
          baseDoc.teamWorkflows ??
          {}) as DoctrineResearchResult['teamWorkflows'],
      };

      const { scenarioId } = await stageGenerateAndPersist(
        geoResult,
        phase1Preview,
        userTeams as Parameters<typeof stageGenerateAndPersist>[2],
        doctrines,
        input as unknown as Parameters<typeof stageGenerateAndPersist>[4],
        env.openAiApiKey,
        user.id,
      );

      await supabaseAdmin
        .from('warroom_wizard_drafts')
        .update({ scenario_id: scenarioId, status: 'persisted', current_step: 6 })
        .eq('id', draftId);

      return res.json({ data: { scenarioId, draft_id: draftId } });
    } catch (err) {
      const error = err as Error;
      logger.error({ error: error.message }, 'Error in POST /warroom/wizard/drafts/:id/persist');
      return res.status(500).json({ error: error.message || 'Persist failed' });
    }
  },
);

const wizardGeocodeSchema = z.object({
  body: z.object({
    prompt: z.string().max(2000).optional(),
    scenario_type: z.string().max(100).optional(),
    setting: z.string().max(100).optional(),
    terrain: z.string().max(100).optional(),
    location: z.string().max(500).optional(),
    teams: z.array(teamSchema).optional(),
  }),
});

router.post(
  '/wizard/geocode-validate',
  requireAuth,
  validate(wizardGeocodeSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can use the War Room' });
      }
      if (!env.openAiApiKey) {
        return res.status(500).json({ error: 'OpenAI API key not configured' });
      }

      const result = await stageParseAndGeocode(req.body, env.openAiApiKey);

      res.json({
        data: {
          parsed: {
            scenario_type: result.parsed.scenario_type,
            setting: result.parsed.setting,
            terrain: result.parsed.terrain,
            location: result.parsed.location,
            venue_name: result.parsed.venue_name,
            landmarks: result.parsed.landmarks,
          },
          geocode: result.geocodeResult,
          osmVicinity: result.osmVicinity ?? null,
          areaSummary: result.areaSummary || null,
          venueName: result.venueName,
        },
      });
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      logger.error({ error: error.message }, 'Error in POST /warroom/wizard/geocode-validate');
      const statusCode =
        error.statusCode && error.statusCode >= 400 && error.statusCode < 600
          ? error.statusCode
          : 500;
      res.status(statusCode).json({ error: error.message || 'Geocode validation failed' });
    }
  },
);

const wizardDoctrinesSchema = z.object({
  body: z.object({
    prompt: z.string().max(2000).optional(),
    scenario_type: z.string().max(100).optional(),
    setting: z.string().max(100).optional(),
    terrain: z.string().max(100).optional(),
    location: z.string().max(500).optional(),
    complexity_tier: z.enum(['minimal', 'standard', 'full', 'rich']).optional(),
    inject_profiles: z.array(z.string().min(1).max(50)).min(2).max(35).optional(),
    teams: z.array(teamSchema).optional(),
    geocode_override: z
      .object({
        lat: z.number(),
        lng: z.number(),
        display_name: z.string().optional(),
      })
      .optional(),
  }),
});

router.post(
  '/wizard/research-doctrines',
  requireAuth,
  validate(wizardDoctrinesSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can use the War Room' });
      }
      if (!env.openAiApiKey) {
        return res.status(500).json({ error: 'OpenAI API key not configured' });
      }

      const geoResult = await stageParseAndGeocode(req.body, env.openAiApiKey);

      if (req.body.geocode_override) {
        geoResult.geocodeResult = {
          lat: req.body.geocode_override.lat,
          lng: req.body.geocode_override.lng,
          display_name: req.body.geocode_override.display_name || geoResult.venueName,
        };
      }

      const { phase1Preview, userTeams } = await stageTeamsAndNarrative(
        geoResult,
        req.body,
        env.openAiApiKey,
      );

      const doctrines = await stageResearchDoctrines(
        phase1Preview,
        geoResult,
        userTeams,
        env.openAiApiKey,
      );

      res.json({
        data: {
          phase1Preview,
          doctrines: {
            standardsFindings: doctrines.standardsFindings,
            perTeamDoctrines: doctrines.perTeamDoctrines,
            teamWorkflows: doctrines.teamWorkflows,
          },
          geocode: geoResult.geocodeResult,
          areaSummary: geoResult.areaSummary || null,
        },
      });
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      logger.error({ error: error.message }, 'Error in POST /warroom/wizard/research-doctrines');
      const statusCode =
        error.statusCode && error.statusCode >= 400 && error.statusCode < 600
          ? error.statusCode
          : 500;
      res.status(statusCode).json({ error: error.message || 'Doctrine research failed' });
    }
  },
);

const standardsFindingSchema = z.object({
  domain: z.string(),
  source: z.string(),
  key_points: z.array(z.string()),
  decision_thresholds: z.string().optional(),
});

const teamWorkflowSchema = z.object({
  endgame: z.string(),
  steps: z.array(z.string()),
  personnel_ratios: z.record(z.string(), z.string()).optional(),
  sop_checklist: z.array(z.string()).optional(),
});

const wizardGenerateSchema = z.object({
  body: z.object({
    prompt: z.string().max(2000).optional(),
    scenario_type: z.string().max(100).optional(),
    setting: z.string().max(100).optional(),
    terrain: z.string().max(100).optional(),
    location: z.string().max(500).optional(),
    complexity_tier: z.enum(['minimal', 'standard', 'full', 'rich']).optional(),
    duration_minutes: z.number().int().min(20).max(240).optional(),
    include_adversary_pursuit: z.boolean().optional(),
    inject_profiles: z.array(z.string().min(1).max(50)).min(2).max(35).optional(),
    secondary_devices_count: z.number().int().min(0).max(10).optional(),
    real_bombs_count: z.number().int().min(0).max(10).optional(),
    teams: z.array(teamSchema).optional(),
    geocode_override: z
      .object({
        lat: z.number(),
        lng: z.number(),
        display_name: z.string().optional(),
      })
      .optional(),
    validated_doctrines: z
      .object({
        perTeamDoctrines: z.record(z.string(), z.array(standardsFindingSchema)),
        teamWorkflows: z.record(z.string(), teamWorkflowSchema).optional(),
      })
      .optional(),
  }),
});

router.post(
  ['/wizard/generate', '/wizard/generate/'],
  requireAuth,
  validate(wizardGenerateSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers can use the War Room' });
      }
      if (!env.openAiApiKey) {
        return res.status(500).json({ error: 'OpenAI API key not configured' });
      }

      logger.info({ userId: user.id, wizardMode: true }, 'War Room wizard generate requested');

      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.flushHeaders?.();

      const onProgress = (phase: WarroomProgressPhase, message: string) => {
        writeProgress(res, phase, message);
        res.flushHeaders?.();
      };

      const geoResult = await stageParseAndGeocode(req.body, env.openAiApiKey, onProgress);

      if (req.body.geocode_override) {
        geoResult.geocodeResult = {
          lat: req.body.geocode_override.lat,
          lng: req.body.geocode_override.lng,
          display_name: req.body.geocode_override.display_name || geoResult.venueName,
        };
      }

      const { phase1Preview, userTeams } = await stageTeamsAndNarrative(
        geoResult,
        req.body,
        env.openAiApiKey,
        onProgress,
      );

      let doctrines: DoctrineResearchResult;
      if (req.body.validated_doctrines) {
        const allFindings = Object.values(
          req.body.validated_doctrines.perTeamDoctrines,
        ).flat() as DoctrineResearchResult['standardsFindings'];
        doctrines = {
          standardsFindings: allFindings,
          perTeamDoctrines: req.body.validated_doctrines
            .perTeamDoctrines as DoctrineResearchResult['perTeamDoctrines'],
          teamWorkflows: (req.body.validated_doctrines.teamWorkflows ??
            {}) as DoctrineResearchResult['teamWorkflows'],
        };
        onProgress('standards_research', 'Using trainer-validated doctrines...');
      } else {
        doctrines = await stageResearchDoctrines(
          phase1Preview,
          geoResult,
          userTeams,
          env.openAiApiKey,
          onProgress,
        );
      }

      const { scenarioId } = await stageGenerateAndPersist(
        geoResult,
        phase1Preview,
        userTeams,
        doctrines,
        req.body,
        env.openAiApiKey,
        user.id,
        onProgress,
      );

      res.write(JSON.stringify({ type: 'done', data: { scenarioId } }) + '\n');
      logger.info({ userId: user.id, scenarioId }, 'War Room scenario created (wizard)');
      res.end();
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      logger.error({ error: error.message }, 'Error in POST /warroom/wizard/generate');
      if (!res.headersSent) {
        const statusCode =
          error.statusCode && error.statusCode >= 400 && error.statusCode < 600
            ? error.statusCode
            : 500;
        res.status(statusCode).json({ error: error.message || 'Wizard generation failed' });
      } else {
        res.write(
          JSON.stringify({
            type: 'error',
            error: error.message || 'Wizard generation failed',
          }) + '\n',
        );
        res.end();
      }
    }
  },
);

// --- Wizard: Deterioration Preview ---
router.post(
  ['/wizard/deterioration-preview', '/wizard/deterioration-preview/'],
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      logger.info({ userId: user.id }, 'Deterioration preview requested');

      const { hazards, casualties, locations, venue, areaContext } = req.body as {
        hazards: Array<Record<string, unknown>>;
        casualties: Array<Record<string, unknown>>;
        locations: Array<Record<string, unknown>>;
        venue: string;
        areaContext?: string;
      };

      if (!hazards?.length && !casualties?.length) {
        res.status(400).json({ error: 'No hazards or casualties provided' });
        return;
      }

      if (!env.openAiApiKey) {
        res.status(500).json({ error: 'OpenAI API key not configured' });
        return;
      }

      const openAiKey = env.openAiApiKey;

      const { researchDeteriorationPhysics, deteriorationResearchToPromptBlock } =
        await import('../services/warroomResearchService.js');
      const { generateDeteriorationTimeline } = await import('../services/warroomAiService.js');

      const detResearch = await researchDeteriorationPhysics(
        (hazards || []).map((h) => ({
          label: (h.label as string) || (h.hazard_type as string),
          hazard_type: h.hazard_type as string,
          properties: h.properties as Record<string, unknown> | undefined,
        })),
        (casualties || []).map((c) => ({
          casualty_type: c.casualty_type as string,
          conditions: c.conditions as Record<string, unknown> | undefined,
        })),
        areaContext || '',
        venue || '',
        openAiKey,
      );

      if (!detResearch) {
        res.status(500).json({ error: 'Deterioration research failed' });
        return;
      }

      const detPromptBlock = deteriorationResearchToPromptBlock(detResearch);

      const detResult = await generateDeteriorationTimeline(
        (hazards || []).map((h) => ({
          label: (h.label as string) || (h.hazard_type as string),
          hazard_type: h.hazard_type as string,
          location_lat: h.location_lat as number,
          location_lng: h.location_lng as number,
          properties: h.properties as Record<string, unknown> | undefined,
        })),
        (casualties || []).map((c) => ({
          casualty_type: c.casualty_type as string,
          location_lat: c.location_lat as number,
          location_lng: c.location_lng as number,
          conditions: c.conditions as Record<string, unknown> | undefined,
          headcount: c.headcount as number | undefined,
        })),
        (locations || []).map((l) => ({
          label: l.label as string,
          location_type: (l.location_type as string) || (l.pin_category as string) || '',
          lat: (l.coordinates as { lat: number })?.lat ?? (l.lat as number) ?? 0,
          lng: (l.coordinates as { lng: number })?.lng ?? (l.lng as number) ?? 0,
        })),
        detPromptBlock,
        venue || '',
        openAiKey,
      );

      if (!detResult) {
        res.status(500).json({ error: 'Deterioration timeline generation failed' });
        return;
      }

      res.json({
        enrichedHazards: detResult.enriched_hazard_timelines,
        enrichedCasualties: detResult.enriched_casualty_timelines,
        spawnPins: detResult.spawn_pins,
        cascadeNarrative: detResult.cascade_narrative,
      });
    } catch (err) {
      const error = err as Error;
      logger.error({ error: error.message }, 'Error in POST /warroom/wizard/deterioration-preview');
      res.status(500).json({ error: error.message || 'Deterioration preview failed' });
    }
  },
);

export { router as warroomRouter };
