import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { validate } from '../lib/validation.js';
import { createDefaultChannels } from '../services/channelService.js';
import { initializeSessionObjectives } from '../services/objectiveTrackingService.js';
import { initializeSessionGateProgress } from '../services/gateEvaluationService.js';
import { loadAndApplyEnvironmentalState } from '../services/environmentalStateService.js';
import { cloneScenarioPinsForSession } from '../services/sessionPinCloningService.js';
import { getWebSocketService } from '../services/websocketService.js';
import { snapshotFinalStateOnCompletion } from '../services/scenarioStateService.js';
import { resolveBotUserId, resolveBotRole } from '../services/demoActionDispatcher.js';
import { getDemoPlaybackService, listDemoScripts } from '../services/demoScriptPlaybackService.js';
import { getDemoAIAgentService } from '../services/demoAIAgentService.js';
import { generateDemoScript } from '../services/demoScriptGeneratorService.js';

const router = Router();

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const startDemoSchema = z.object({
  body: z.object({
    scenarioId: z.string().uuid(),
    scriptId: z.string().optional(),
    speedMultiplier: z.number().min(0.25).max(20).default(1),
    mode: z.enum(['scripted', 'ai', 'hybrid']).default('scripted'),
    difficulty: z.enum(['novice', 'intermediate', 'advanced']).default('intermediate'),
  }),
});

const stopDemoSchema = z.object({
  body: z.object({
    sessionId: z.string().uuid(),
  }),
});

const generateScriptSchema = z.object({
  body: z.object({
    scenarioId: z.string().uuid(),
    durationMinutes: z.number().min(3).max(60).optional(),
    eventDensity: z.enum(['light', 'normal', 'heavy']).optional(),
  }),
});

// ---------------------------------------------------------------------------
// POST /api/demo/start
// ---------------------------------------------------------------------------

router.post(
  '/start',
  requireAuth,
  validate(startDemoSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers/admins can start demos' });
      }

      const { scenarioId, scriptId, speedMultiplier, mode, difficulty } = req.body;

      // 1. Load scenario
      const { data: scenario, error: scenarioErr } = await supabaseAdmin
        .from('scenarios')
        .select('id, title, initial_state, center_lat, center_lng')
        .eq('id', scenarioId)
        .single();

      if (scenarioErr || !scenario) {
        return res.status(404).json({ error: 'Scenario not found' });
      }

      // 2. Load scenario teams
      const { data: scenarioTeams } = await supabaseAdmin
        .from('scenario_teams')
        .select('team_name, team_description')
        .eq('scenario_id', scenarioId);

      const teamNames = (scenarioTeams ?? []).map((t: { team_name: string }) => t.team_name);

      if (teamNames.length === 0) {
        return res.status(400).json({ error: 'Scenario has no teams defined' });
      }

      // 3. Create session (owned by the real user who launched the demo)
      const trainerId = user.id;
      const { data: session, error: sessionErr } = await supabaseAdmin
        .from('sessions')
        .insert({
          scenario_id: scenarioId,
          trainer_id: trainerId,
          status: 'scheduled',
          current_state: scenario.initial_state || {},
          join_token: `demo-${Date.now()}`,
          join_enabled: false,
          join_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        })
        .select()
        .single();

      if (sessionErr || !session) {
        logger.error({ error: sessionErr }, 'Demo: failed to create session');
        return res.status(500).json({ error: 'Failed to create demo session' });
      }

      const sessionId = session.id;

      // 4. Create default channels
      await createDefaultChannels(sessionId, trainerId);

      // 5. Add bot users as participants and assign to teams
      for (const teamName of teamNames) {
        const botUserId = resolveBotUserId(teamName);
        const role = resolveBotRole(teamName);

        await supabaseAdmin
          .from('session_participants')
          .upsert(
            { session_id: sessionId, user_id: botUserId, role },
            { onConflict: 'session_id,user_id' },
          );

        await supabaseAdmin.from('session_teams').upsert(
          {
            session_id: sessionId,
            user_id: botUserId,
            team_name: teamName,
            assigned_by: trainerId,
          },
          { onConflict: 'session_id,user_id,team_name' },
        );
      }

      // 6. Start the session
      const startTime = new Date().toISOString();
      const { error: startErr } = await supabaseAdmin
        .from('sessions')
        .update({ status: 'in_progress', start_time: startTime })
        .eq('id', sessionId)
        .select()
        .single();

      if (startErr) {
        logger.error({ error: startErr, sessionId }, 'Demo: failed to start session');
        return res.status(500).json({ error: 'Failed to start demo session' });
      }

      // Run session initialization
      try {
        await cloneScenarioPinsForSession(sessionId, scenarioId);
      } catch (e) {
        logger.warn({ error: e, sessionId }, 'Demo: pin cloning failed');
      }
      try {
        await initializeSessionObjectives(sessionId);
      } catch (e) {
        logger.warn({ error: e, sessionId }, 'Demo: objective init failed');
      }
      try {
        await initializeSessionGateProgress(sessionId);
      } catch (e) {
        logger.warn({ error: e, sessionId }, 'Demo: gate init failed');
      }
      try {
        await loadAndApplyEnvironmentalState(sessionId);
      } catch (e) {
        logger.warn({ error: e, sessionId }, 'Demo: env state init failed');
      }

      try {
        getWebSocketService().sessionStarted(sessionId, {
          session_id: sessionId,
          status: 'in_progress',
          start_time: startTime,
        });
      } catch {
        /* ok */
      }

      // 7. Start the appropriate mode
      let playbackStarted = false;
      let aiAgentsStarted = false;

      if (mode === 'scripted' || mode === 'hybrid') {
        const playback = getDemoPlaybackService();
        const chosenScript = scriptId || listDemoScripts()[0]?.id;

        if (chosenScript) {
          const incidentCenter =
            scenario.center_lat != null && scenario.center_lng != null
              ? { lat: scenario.center_lat, lng: scenario.center_lng }
              : undefined;

          const { DemoActionDispatcher } = await import('../services/demoActionDispatcher.js');
          const channelId = await new DemoActionDispatcher().getSessionChannelId(sessionId);

          playbackStarted = await playback.start(
            sessionId,
            chosenScript,
            speedMultiplier,
            incidentCenter,
            undefined,
            channelId ?? undefined,
          );
        }
      }

      if (mode === 'ai' || mode === 'hybrid') {
        const agents = getDemoAIAgentService();
        aiAgentsStarted = await agents.start(sessionId, scenarioId, {
          scriptAware: mode === 'hybrid',
          difficulty: difficulty || 'intermediate',
        });
      }

      logger.info(
        { sessionId, scenarioId, mode, scriptId, playbackStarted, aiAgentsStarted },
        'Demo: session created and started',
      );

      res.status(201).json({
        data: {
          sessionId,
          scenarioTitle: scenario.title,
          spectatorUrl: `/sessions/${sessionId}?spectator=true`,
          mode,
          playbackStarted,
          aiAgentsStarted,
          teamCount: teamNames.length,
          teams: teamNames,
        },
      });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /demo/start');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/demo/stop
// ---------------------------------------------------------------------------

router.post(
  '/stop',
  requireAuth,
  validate(stopDemoSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { sessionId } = req.body;

      getDemoPlaybackService().stop(sessionId);
      getDemoAIAgentService().stop(sessionId);

      await supabaseAdmin
        .from('sessions')
        .update({ status: 'completed', end_time: new Date().toISOString() })
        .eq('id', sessionId);

      snapshotFinalStateOnCompletion(sessionId).catch((err) =>
        logger.warn({ err, sessionId }, 'Demo: snapshot on stop failed'),
      );

      logger.info({ sessionId }, 'Demo: stopped');
      res.json({ success: true });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /demo/stop');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/demo/active
// ---------------------------------------------------------------------------

router.get('/active', requireAuth, async (_req, res) => {
  try {
    const playback = getDemoPlaybackService();
    const agents = getDemoAIAgentService();
    const active = playback.listActive().map((d) => ({
      ...d,
      aiAgentsRunning: agents.isRunning(d.sessionId),
    }));
    res.json({ data: active });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /demo/active');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/demo/scripts
// ---------------------------------------------------------------------------

router.get('/scripts', requireAuth, async (_req, res) => {
  try {
    res.json({ data: listDemoScripts() });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /demo/scripts');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/demo/generate-script
// ---------------------------------------------------------------------------

router.post(
  '/generate-script',
  requireAuth,
  validate(generateScriptSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      if (user.role !== 'trainer' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Only trainers/admins can generate scripts' });
      }

      const { scenarioId, durationMinutes, eventDensity } = req.body;

      const result = await generateDemoScript(scenarioId, {
        durationMinutes,
        eventDensity,
      });

      if (!result) {
        return res.status(500).json({ error: 'Failed to generate demo script' });
      }

      res.status(201).json({
        data: {
          scriptId: result.filePath.split(/[\\/]/).pop()?.replace('.json', ''),
          name: result.script.name,
          eventCount: result.script.events.length,
          durationMinutes: result.script.durationMinutes,
          scenarioType: result.script.scenarioType,
        },
      });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /demo/generate-script');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export { router as demoRouter };
