import { readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { logger } from '../lib/logger.js';
import { DemoActionDispatcher, resolveBotUserId } from './demoActionDispatcher.js';
import { getDemoAIAgentService } from './demoAIAgentService.js';

export interface DemoScriptEvent {
  offsetMinutes: number;
  team: string;
  type: 'decision' | 'placement' | 'chat';
  payload: Record<string, unknown>;
}

export interface DemoScript {
  name: string;
  scenarioType: string;
  durationMinutes: number;
  coordinateOffsets?: boolean;
  events: DemoScriptEvent[];
}

interface RunningDemo {
  sessionId: string;
  scriptName: string;
  startedAt: Date;
  speedMultiplier: number;
  timers: NodeJS.Timeout[];
  finished: boolean;
}

const SCRIPTS_DIR = join(process.cwd(), 'demo_scripts');

/**
 * Loads all available demo scripts from the demo_scripts/ directory.
 */
export function listDemoScripts(): Array<{
  id: string;
  name: string;
  scenarioType: string;
  durationMinutes: number;
  eventCount: number;
}> {
  try {
    const files = readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.json'));
    return files.map((f) => {
      const raw = readFileSync(join(SCRIPTS_DIR, f), 'utf-8');
      const script = JSON.parse(raw) as DemoScript;
      return {
        id: basename(f, '.json'),
        name: script.name,
        scenarioType: script.scenarioType,
        durationMinutes: script.durationMinutes,
        eventCount: script.events.length,
      };
    });
  } catch {
    return [];
  }
}

export function loadDemoScript(scriptId: string): DemoScript | null {
  try {
    const raw = readFileSync(join(SCRIPTS_DIR, `${scriptId}.json`), 'utf-8');
    return JSON.parse(raw) as DemoScript;
  } catch {
    return null;
  }
}

/**
 * Translates relative coordinate offsets to absolute coordinates
 * based on a scenario's incident center.
 */
function translateGeometry(
  geometry: { type: string; coordinates: unknown },
  center: { lat: number; lng: number },
): { type: string; coordinates: unknown } {
  const offsetCoord = (coord: number[]): number[] => {
    return [coord[0] + center.lng, coord[1] + center.lat];
  };

  if (geometry.type === 'Point') {
    const coords = geometry.coordinates as number[];
    return { type: 'Point', coordinates: offsetCoord(coords) };
  }

  if (geometry.type === 'LineString') {
    const coords = geometry.coordinates as number[][];
    return { type: 'LineString', coordinates: coords.map(offsetCoord) };
  }

  if (geometry.type === 'Polygon') {
    const rings = geometry.coordinates as number[][][];
    return {
      type: 'Polygon',
      coordinates: rings.map((ring) => ring.map(offsetCoord)),
    };
  }

  return geometry;
}

export class DemoScriptPlaybackService {
  private activeDemos = new Map<string, RunningDemo>();
  private dispatcher = new DemoActionDispatcher();

  /**
   * Start playing a demo script for a session.
   */
  async start(
    sessionId: string,
    scriptId: string,
    speedMultiplier: number = 1.0,
    incidentCenter?: { lat: number; lng: number },
    teamToChannelMap?: Map<string, string>,
    defaultChannelId?: string,
  ): Promise<boolean> {
    if (this.activeDemos.has(sessionId)) {
      logger.warn({ sessionId }, 'Demo: session already has an active demo');
      return false;
    }

    const script = loadDemoScript(scriptId);
    if (!script) {
      logger.error({ scriptId }, 'Demo: script not found');
      return false;
    }

    const demo: RunningDemo = {
      sessionId,
      scriptName: script.name,
      startedAt: new Date(),
      speedMultiplier,
      timers: [],
      finished: false,
    };

    const channelId = defaultChannelId ?? (await this.dispatcher.getSessionChannelId(sessionId));

    for (const event of script.events) {
      const delayMs = (event.offsetMinutes * 60 * 1000) / speedMultiplier;
      const botUserId = resolveBotUserId(event.team);

      const timer = setTimeout(async () => {
        if (demo.finished) return;

        try {
          await this.executeEvent(sessionId, event, botUserId, {
            useOffsets: script.coordinateOffsets ?? false,
            incidentCenter,
            channelId,
            teamToChannelMap,
          });
        } catch (err) {
          logger.error(
            { error: err, sessionId, event: event.type, team: event.team },
            'Demo: event execution failed',
          );
        }
      }, delayMs);

      // Notify AI agents about upcoming script events (hybrid mode coordination)
      if (delayMs > 8000) {
        const preNotifyMs = delayMs - 8000;
        const notifyTimer = setTimeout(() => {
          if (demo.finished) return;
          try {
            getDemoAIAgentService().notifyUpcomingScriptEvent(sessionId, Date.now() + 8000);
          } catch {
            /* ok */
          }
        }, preNotifyMs);
        demo.timers.push(notifyTimer);
      }

      demo.timers.push(timer);
    }

    // Auto-finish timer
    const totalDuration = (script.durationMinutes * 60 * 1000) / speedMultiplier;
    const finishTimer = setTimeout(() => {
      demo.finished = true;
      this.activeDemos.delete(sessionId);
      logger.info({ sessionId, scriptName: script.name }, 'Demo: playback finished');
    }, totalDuration + 5000);
    demo.timers.push(finishTimer);

    this.activeDemos.set(sessionId, demo);
    logger.info(
      { sessionId, scriptId, eventCount: script.events.length, speedMultiplier },
      'Demo: playback started',
    );
    return true;
  }

  private async executeEvent(
    sessionId: string,
    event: DemoScriptEvent,
    botUserId: string,
    ctx: {
      useOffsets: boolean;
      incidentCenter?: { lat: number; lng: number };
      channelId: string | null;
      teamToChannelMap?: Map<string, string>;
    },
  ): Promise<void> {
    switch (event.type) {
      case 'decision': {
        await this.dispatcher.proposeAndExecuteDecision(sessionId, botUserId, {
          title: event.payload.title as string,
          description: event.payload.description as string,
          decision_type: event.payload.decision_type as string | undefined,
          response_to_incident_id: event.payload.response_to_incident_id as string | undefined,
        });
        break;
      }

      case 'placement': {
        let geometry = event.payload.geometry as { type: string; coordinates: unknown };
        if (ctx.useOffsets && ctx.incidentCenter) {
          geometry = translateGeometry(geometry, ctx.incidentCenter);
        }
        await this.dispatcher.createPlacement(sessionId, botUserId, {
          team_name: event.team,
          asset_type: event.payload.asset_type as string,
          label:
            (event.payload.label as string) ||
            (event.payload.asset_type as string).replace(/_/g, ' '),
          geometry,
          properties: event.payload.properties as Record<string, unknown> | undefined,
        });
        break;
      }

      case 'chat': {
        const channelId = ctx.teamToChannelMap?.get(event.team) ?? ctx.channelId;
        if (channelId) {
          await this.dispatcher.sendChatMessage(
            channelId,
            sessionId,
            botUserId,
            event.payload.content as string,
            (event.payload.message_type as string) || 'text',
          );
        }
        break;
      }
    }
  }

  /**
   * Stop an active demo.
   */
  stop(sessionId: string): boolean {
    const demo = this.activeDemos.get(sessionId);
    if (!demo) return false;

    demo.finished = true;
    for (const timer of demo.timers) {
      clearTimeout(timer);
    }
    this.activeDemos.delete(sessionId);
    logger.info({ sessionId }, 'Demo: playback stopped');
    return true;
  }

  /**
   * List all currently running demos.
   */
  listActive(): Array<{
    sessionId: string;
    scriptName: string;
    startedAt: Date;
    speedMultiplier: number;
  }> {
    return Array.from(this.activeDemos.values()).map((d) => ({
      sessionId: d.sessionId,
      scriptName: d.scriptName,
      startedAt: d.startedAt,
      speedMultiplier: d.speedMultiplier,
    }));
  }

  /**
   * Update the speed multiplier for remaining events. Already-scheduled timers keep their original timing.
   */
  getSpeedMultiplier(sessionId: string): number | null {
    return this.activeDemos.get(sessionId)?.speedMultiplier ?? null;
  }

  isRunning(sessionId: string): boolean {
    return this.activeDemos.has(sessionId);
  }
}

let playbackInstance: DemoScriptPlaybackService | null = null;

export function getDemoPlaybackService(): DemoScriptPlaybackService {
  if (!playbackInstance) {
    playbackInstance = new DemoScriptPlaybackService();
  }
  return playbackInstance;
}
