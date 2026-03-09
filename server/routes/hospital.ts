import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { validate } from '../lib/validation.js';
import { answerHospitalCapacityQuestion } from '../services/hospitalCapacityService.js';
import { env } from '../env.js';

const router = Router();

const askSchema = z.object({
  params: z.object({
    sessionId: z.string().uuid(),
  }),
  body: z.object({
    hospital_id: z.string().min(1).max(100),
    content: z.string().min(1).max(2000),
  }),
});

// Restore sessionId from parent router
router.use((req, _res, next) => {
  const sessionId = (req as { hospitalSessionId?: string }).hospitalSessionId;
  if (sessionId) req.params.sessionId = sessionId;
  next();
});

// GET /sessions/:sessionId/hospital/list - list hospitals available for DM
router.get('/list', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const sessionId = req.params.sessionId;
    const user = req.user!;

    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('id, scenario_id, trainer_id, current_state')
      .eq('id', sessionId)
      .single();

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.trainer_id !== user.id && user.role !== 'admin') {
      const { data: participant } = await supabaseAdmin
        .from('session_participants')
        .select('user_id')
        .eq('session_id', sessionId)
        .eq('user_id', user.id)
        .single();
      if (!participant) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const currentState = (session.current_state as Record<string, unknown>) || {};
    const envState = currentState.environmental_state as
      | { areas?: Array<{ area_id?: string; label?: string; type?: string }> }
      | undefined;
    const areas = envState?.areas ?? [];

    const hospitals = areas
      .filter((a) => a.type === 'hospital')
      .map((a) => ({
        id: a.area_id ?? a.label ?? 'unknown',
        label: a.label ?? a.area_id ?? 'Unknown Hospital',
      }));

    // Fallback: if no hospitals in env state, use scenario_locations
    if (hospitals.length === 0 && session.scenario_id) {
      const { data: locations } = await supabaseAdmin
        .from('scenario_locations')
        .select('id, label')
        .eq('scenario_id', session.scenario_id)
        .eq('location_type', 'hospital')
        .order('display_order', { ascending: true });

      const fromLocations = (locations ?? []).map((loc) => ({
        id: (loc.id as string) ?? (loc.label as string) ?? 'unknown',
        label: (loc.label as string) ?? 'Unknown Hospital',
      }));
      return res.json({ data: fromLocations });
    }

    return res.json({ data: hospitals });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /sessions/:sessionId/hospital/list');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /sessions/:sessionId/hospital/ask - ask a hospital about capacity
router.post('/ask', requireAuth, validate(askSchema), async (req: AuthenticatedRequest, res) => {
  try {
    const sessionId = req.params.sessionId;
    const user = req.user!;
    const { hospital_id, content } = req.body;

    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('id, scenario_id, trainer_id, current_state')
      .eq('id', sessionId)
      .single();

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.trainer_id !== user.id && user.role !== 'admin') {
      const { data: participant } = await supabaseAdmin
        .from('session_participants')
        .select('user_id')
        .eq('session_id', sessionId)
        .eq('user_id', user.id)
        .single();
      if (!participant) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const currentState = (session.current_state as Record<string, unknown>) || {};
    const envState = currentState.environmental_state as
      | {
          areas?: Array<{
            area_id?: string;
            label?: string;
            type?: string;
            at_capacity?: boolean;
            capacity?: number;
          }>;
        }
      | undefined;
    const areas = envState?.areas ?? [];

    const area = areas.find(
      (a) =>
        a.type === 'hospital' &&
        (a.area_id === hospital_id || (a.label ?? '').toLowerCase() === hospital_id.toLowerCase()),
    );

    let hospitalLabel: string;
    let atCapacity: boolean;
    let capacityAvailable: number | undefined;

    if (area) {
      hospitalLabel = area.label ?? area.area_id ?? 'Hospital';
      atCapacity = area.at_capacity === true;
      capacityAvailable = typeof area.capacity === 'number' ? area.capacity : undefined;
    } else {
      // Fallback: might be from scenario_locations (id is UUID)
      const { data: loc } = await supabaseAdmin
        .from('scenario_locations')
        .select('label')
        .eq('scenario_id', session.scenario_id)
        .eq('location_type', 'hospital')
        .eq('id', hospital_id)
        .single();

      hospitalLabel = (loc?.label as string) ?? hospital_id;
      atCapacity = false; // unknown from locations, assume available
    }

    const answer = await answerHospitalCapacityQuestion(
      {
        hospitalId: hospital_id,
        hospitalLabel,
        atCapacity,
        capacityAvailable,
        question: content,
      },
      env.openAiApiKey,
    );

    return res.json({ data: { answer } });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /sessions/:sessionId/hospital/ask');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as hospitalRouter };
