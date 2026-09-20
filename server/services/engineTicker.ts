import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { runPressureEngine, flipUnstaffedOrgsToAi } from './pressureEngineService.js';
import { runDecisionTick } from './decisions/decisionCascadeService.js';

/**
 * Generator-owned runtime engines (docs/executive-decisions-organic-plan.md §5–§6), ticked on
 * their own interval so injectSchedulerService stays untouched:
 *   - pressure engine (pressure pages + AI-operated offices)
 *   - organic decision relay / propagation tick
 *   - one-off at session start: unstaffed protagonist orgs become AI-operated
 */
const TICK_MS = 60_000;
const START_GRACE_MINUTES = 4;

let interval: NodeJS.Timeout | null = null;
const inFlight = new Set<string>();
const startHandled = new Set<string>();

export function startGeneratorEngines(): void {
  if (interval) return;
  if (!env.enableExecutiveDecisions) {
    logger.info('Generator engines disabled (ENABLE_EXECUTIVE_DECISIONS=false)');
    return;
  }
  interval = setInterval(() => void tick(), TICK_MS);
  logger.info('Generator engines started (pressure engine + organic decisions, every 60s)');
}

export function stopGeneratorEngines(): void {
  if (interval) clearInterval(interval);
  interval = null;
}

async function tick(): Promise<void> {
  try {
    const { data: sessions, error } = await supabaseAdmin
      .from('sessions')
      .select('id, start_time, sim_mode')
      .eq('status', 'in_progress')
      .eq('sim_mode', 'social_media')
      .not('start_time', 'is', null);
    if (error) {
      logger.warn({ error }, 'engineTicker: session query failed');
      return;
    }
    for (const s of sessions || []) {
      const id = String(s.id);
      if (inFlight.has(id)) continue;
      inFlight.add(id);
      const elapsed = Math.max(0, (Date.now() - new Date(String(s.start_time)).getTime()) / 60000);
      try {
        if (!startHandled.has(id) && elapsed <= START_GRACE_MINUTES + 1) {
          startHandled.add(id);
          const flipped = await flipUnstaffedOrgsToAi(id).catch(() => []);
          if (flipped.length > 0)
            logger.info({ sessionId: id, flipped }, 'unstaffed orgs now AI-operated');
        } else {
          startHandled.add(id);
        }
        await runPressureEngine(id, elapsed);
        await runDecisionTick(id, elapsed);
      } catch (err) {
        logger.warn({ err, sessionId: id }, 'engineTicker: session tick failed');
      } finally {
        inFlight.delete(id);
      }
    }
    // Forget finished sessions.
    const live = new Set((sessions || []).map((s) => String(s.id)));
    for (const id of startHandled) if (!live.has(id)) startHandled.delete(id);
  } catch (err) {
    logger.warn({ err }, 'engineTicker: tick failed');
  }
}
