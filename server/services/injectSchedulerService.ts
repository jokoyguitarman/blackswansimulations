import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { publishInjectToSession } from '../routes/injects.js';
import { shouldCancelScheduledInject } from './aiService.js';
import { env } from '../env.js';
import type { Server as SocketServer } from 'socket.io';

/**
 * Inject Scheduler Service
 * Monitors active sessions and automatically publishes injects when their trigger_time_minutes is reached
 */
export class InjectSchedulerService {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private readonly checkIntervalMs: number;
  private readonly enabled: boolean;
  private io: SocketServer | null = null;

  constructor(io?: SocketServer) {
    this.io = io || null;
    // Get configuration from environment
    this.checkIntervalMs = env.injectSchedulerIntervalMs;
    this.enabled = env.enableAutoInjects;

    logger.info(
      {
        enabled: this.enabled,
        intervalMs: this.checkIntervalMs,
        nodeEnv: env.nodeEnv,
      },
      'InjectSchedulerService initialized',
    );
  }

  /**
   * Start the scheduler
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('InjectSchedulerService is already running');
      return;
    }

    if (!this.enabled) {
      logger.info('InjectSchedulerService is disabled');
      return;
    }

    this.isRunning = true;
    logger.info({ intervalMs: this.checkIntervalMs }, 'Starting InjectSchedulerService');

    // Run immediately on start, then on interval
    this.checkAndPublishInjects().catch((err) => {
      logger.error({ error: err }, 'Error in initial inject check');
    });

    this.intervalId = setInterval(() => {
      this.checkAndPublishInjects().catch((err) => {
        logger.error({ error: err }, 'Error in periodic inject check');
      });
    }, this.checkIntervalMs);
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    logger.info('InjectSchedulerService stopped');
  }

  /**
   * Check active sessions and publish injects that should be triggered
   */
  private async checkAndPublishInjects(): Promise<void> {
    try {
      // Get all active sessions with start_time
      const { data: sessions, error: sessionsError } = await supabaseAdmin
        .from('sessions')
        .select('id, scenario_id, start_time, trainer_id, status')
        .eq('status', 'in_progress')
        .not('start_time', 'is', null);

      if (sessionsError) {
        logger.error({ error: sessionsError }, 'Failed to fetch active sessions');
        return;
      }

      if (!sessions || sessions.length === 0) {
        logger.debug('No active sessions found (status=in_progress with start_time)');
        return;
      }

      logger.info({ sessionCount: sessions.length }, 'Checking active sessions for injects');

      // Process each session
      for (const session of sessions) {
        try {
          await this.processSession(session);
        } catch (sessionErr) {
          logger.error(
            { error: sessionErr, sessionId: session.id },
            'Error processing session for injects',
          );
          // Continue with next session even if one fails
        }
      }
    } catch (err) {
      logger.error({ error: err }, 'Error in checkAndPublishInjects');
    }
  }

  /**
   * Process a single session to check for injects that should be published
   */
  private async processSession(session: {
    id: string;
    scenario_id: string;
    start_time: string;
    trainer_id: string;
    status: string;
  }): Promise<void> {
    // Calculate elapsed minutes
    const startTime = new Date(session.start_time).getTime();
    const now = Date.now();
    const elapsedMinutes = Math.floor((now - startTime) / 60000);

    logger.info(
      {
        sessionId: session.id,
        scenarioId: session.scenario_id,
        elapsedMinutes,
        startTime: session.start_time,
        status: session.status,
      },
      'Processing session for inject triggers',
    );

    // Get injects for this scenario that should be triggered (include content for AI cancellation check)
    const { data: injects, error: injectsError } = await supabaseAdmin
      .from('scenario_injects')
      .select('id, trigger_time_minutes, title, content')
      .eq('scenario_id', session.scenario_id)
      .not('trigger_time_minutes', 'is', null)
      .lte('trigger_time_minutes', elapsedMinutes);

    if (injectsError) {
      logger.error(
        { error: injectsError, sessionId: session.id, scenarioId: session.scenario_id },
        'Failed to fetch injects for session',
      );
      return;
    }

    if (!injects || injects.length === 0) {
      logger.debug(
        {
          sessionId: session.id,
          scenarioId: session.scenario_id,
          elapsedMinutes,
        },
        'No injects found that should be triggered (all may have already passed or none exist)',
      );
      return;
    }

    logger.info(
      {
        sessionId: session.id,
        injectCount: injects.length,
        injects: injects.map((i) => ({
          id: i.id,
          triggerTime: i.trigger_time_minutes,
          title: i.title,
        })),
      },
      'Found injects that should be triggered',
    );

    // Check which injects have already been published
    const { data: publishedEvents, error: eventsError } = await supabaseAdmin
      .from('session_events')
      .select('metadata')
      .eq('session_id', session.id)
      .eq('event_type', 'inject');

    if (eventsError) {
      logger.error(
        { error: eventsError, sessionId: session.id },
        'Failed to check published injects',
      );
      return;
    }

    // Extract published inject IDs
    const publishedInjectIds = new Set<string>();
    if (publishedEvents) {
      for (const event of publishedEvents) {
        const injectId = (event.metadata as { inject_id?: string })?.inject_id;
        if (injectId) {
          publishedInjectIds.add(injectId);
        } else {
          logger.warn(
            {
              sessionId: session.id,
              eventMetadata: event.metadata,
            },
            'Published event found but missing inject_id in metadata',
          );
        }
      }
    }

    // Check which injects were cancelled by AI (do not publish)
    const { data: cancelledEvents } = await supabaseAdmin
      .from('session_events')
      .select('metadata')
      .eq('session_id', session.id)
      .eq('event_type', 'inject_cancelled');

    const cancelledInjectIds = new Set<string>();
    if (cancelledEvents) {
      for (const event of cancelledEvents) {
        const injectId = (event.metadata as { inject_id?: string })?.inject_id;
        if (injectId) cancelledInjectIds.add(injectId);
      }
    }

    logger.debug(
      {
        sessionId: session.id,
        publishedInjectCount: publishedInjectIds.size,
        cancelledInjectCount: cancelledInjectIds.size,
      },
      'Checked for already-published and cancelled injects',
    );

    // Publish injects that haven't been published and weren't cancelled
    const injectsToPublish = injects.filter(
      (inject) => !publishedInjectIds.has(inject.id) && !cancelledInjectIds.has(inject.id),
    );

    if (injectsToPublish.length === 0) {
      logger.info(
        {
          sessionId: session.id,
          totalInjects: injects.length,
          alreadyPublished: injects.map((i) => i.id),
        },
        'All injects for this check have already been published',
      );
      return;
    }

    logger.info(
      {
        sessionId: session.id,
        injectsToPublish: injectsToPublish.map((i) => ({
          id: i.id,
          triggerTime: i.trigger_time_minutes,
          title: i.title,
        })),
        alreadyPublished: injects.filter((i) => publishedInjectIds.has(i.id)).map((i) => i.id),
      },
      'Publishing injects that have not been published yet',
    );

    // Decisions executed in the last 5 minutes (for AI cancellation check)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: recentDecisions } = await supabaseAdmin
      .from('decisions')
      .select('id, title, description, type')
      .eq('session_id', session.id)
      .eq('status', 'executed')
      .gte('executed_at', fiveMinutesAgo)
      .order('executed_at', { ascending: false });

    const decisionsForAi = (recentDecisions || []).map((d) => ({
      title: d.title ?? '',
      description: d.description ?? '',
      type: d.type as string | null,
    }));

    for (const inject of injectsToPublish) {
      try {
        // AI cancellation check: should this scheduled inject be suppressed due to recent decisions?
        if (env.openAiApiKey) {
          try {
            const result = await shouldCancelScheduledInject(
              {
                title: inject.title ?? '',
                content: (inject as { content?: string }).content ?? '',
              },
              decisionsForAi,
              env.openAiApiKey,
            );
            if (result.cancel) {
              await supabaseAdmin.from('session_events').insert({
                session_id: session.id,
                event_type: 'inject_cancelled',
                description: `Inject cancelled: ${inject.title ?? inject.id} - ${result.reason ?? 'AI determined recent decisions made it obsolete'}`,
                actor_id: null,
                metadata: {
                  inject_id: inject.id,
                  reason: result.reason ?? null,
                  cancelled_at: new Date().toISOString(),
                },
              });
              logger.info(
                {
                  sessionId: session.id,
                  injectId: inject.id,
                  injectTitle: inject.title,
                  reason: result.reason,
                },
                'Scheduled inject cancelled by AI, not publishing',
              );
              continue;
            }
          } catch (cancelErr) {
            logger.warn(
              { error: cancelErr, sessionId: session.id, injectId: inject.id },
              'AI cancellation check failed, publishing inject anyway',
            );
            // Fall through to publish (fail-open)
          }
        }

        logger.info(
          {
            sessionId: session.id,
            injectId: inject.id,
            injectTitle: inject.title,
            triggerTimeMinutes: inject.trigger_time_minutes,
            elapsedMinutes,
            timeDifference: elapsedMinutes - (inject.trigger_time_minutes || 0),
          },
          'Auto-publishing inject',
        );

        if (!this.io) {
          // Lazy import to avoid circular dependency
          const { io } = await import('../index.js');
          this.io = io;
        }

        await publishInjectToSession(inject.id, session.id, session.trainer_id, this.io);

        logger.info(
          { sessionId: session.id, injectId: inject.id },
          'Inject auto-published successfully',
        );
      } catch (publishErr) {
        logger.error(
          { error: publishErr, sessionId: session.id, injectId: inject.id },
          'Failed to auto-publish inject',
        );
        // Continue with next inject even if one fails
      }
    }
  }
}

// Singleton instance
let schedulerInstance: InjectSchedulerService | null = null;

/**
 * Initialize the inject scheduler service
 */
export const initializeInjectScheduler = (io: SocketServer): InjectSchedulerService => {
  if (!schedulerInstance) {
    schedulerInstance = new InjectSchedulerService(io);
  }
  return schedulerInstance;
};

/**
 * Get the inject scheduler service instance
 */
export const getInjectScheduler = (): InjectSchedulerService => {
  if (!schedulerInstance) {
    throw new Error(
      'InjectSchedulerService not initialized. Call initializeInjectScheduler first.',
    );
  }
  return schedulerInstance;
};
