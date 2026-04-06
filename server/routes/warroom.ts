import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';
import { validate } from '../lib/validation.js';
import {
  generateAndPersistWarroomScenario,
  suggestWarroomTeams,
  stageParseAndGeocode,
  stageTeamsAndNarrative,
  stageResearchDoctrines,
  stageGenerateAndPersist,
  type WarroomProgressPhase,
  type DoctrineResearchResult,
} from '../services/warroomService.js';
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

export { router as warroomRouter };
