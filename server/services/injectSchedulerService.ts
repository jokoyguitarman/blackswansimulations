import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { publishInjectToSession } from '../routes/injects.js';
import { shouldCancelScheduledInject } from './aiService.js';
import { updateTeamHeatMeter } from './heatMeterService.js';
import { runGateEvaluationForSession } from './gateEvaluationService.js';
import { mergeStateWithInjectEffects } from './injectPublishEffectsService.js';
import { runPursuitResponseCheck } from './pursuitResponseTracker.js';
import { env } from '../env.js';
import { getWebSocketService } from './websocketService.js';
import { evaluatePinResolution } from './pinResolutionService.js';
import { runHazardDeterioration } from './hazardDeteriorationService.js';
import { runPeopleDeterioration } from './peopleDeteriorationService.js';
import {
  processExitFlow,
  checkPendingEndorsements,
  processNonAmbulatoryExtraction,
} from './exitFlowService.js';
import { runAreaMonitors } from './areaMonitorService.js';
import { runMovementTick } from './movementService.js';
import { computeLiveCounters } from './liveCounterService.js';
import { performSweep } from './bombSquadSweepService.js';
import { DemoActionDispatcher, resolveBotUserId } from './demoActionDispatcher.js';
import { determineZone, type ZoneRadii, type PlacedZoneArea } from './geoUtils.js';
import {
  evaluateInjectConditions,
  type EvaluationContext,
  type ConditionsToAppear,
  type ConditionsToCancel,
} from './conditionEvaluatorService.js';
import { shouldCancelSocialInject } from './socialCrisisAiService.js';
import { computeSocialState } from './socialStateUpdaterService.js';
import { computeSessionSentiment } from './sentimentSimService.js';
import { checkResponseDeadlines } from './responseTrackerService.js';
import { generateAmbientPosts } from './ambientContentService.js';
import type { Server as SocketServer } from 'socket.io';
/**
 * Shared AI cancellation gate for any inject about to be published.
 * Returns true if the inject was cancelled (caller should skip publishing).
 */
async function runAiCancellationGate(
  inject: {
    id: string;
    title: string | null;
    content?: string;
    target_teams?: string[] | null;
    severity?: string | null;
    inject_scope?: string | null;
  },
  session: { id: string; scenario_id: string; trainer_id: string },
  allDecisionsForAi: Array<{
    title: string;
    description: string;
    type: string | null;
    proposed_by: string | null;
  }>,
  userIdToTeam: Map<string, string>,
  io: SocketServer | null,
): Promise<boolean> {
  if (!env.openAiApiKey) return false;

  try {
    const targetTeams = inject.target_teams ?? null;
    const relevantDecisions =
      !targetTeams || targetTeams.length === 0
        ? allDecisionsForAi
        : allDecisionsForAi.filter((d) => {
            const team = d.proposed_by ? userIdToTeam.get(d.proposed_by) : undefined;
            return team != null && targetTeams.includes(team);
          });

    await supabaseAdmin.from('session_events').insert({
      session_id: session.id,
      event_type: 'ai_step_start',
      description: `AI: Evaluating whether to cancel inject: ${inject.title ?? inject.id}`,
      actor_id: null,
      metadata: { step: 'evaluating_inject_cancellation', inject_title: inject.title ?? null },
    });

    const result = await shouldCancelScheduledInject(
      { title: inject.title ?? '', content: inject.content ?? '' },
      relevantDecisions,
      env.openAiApiKey,
    );

    await supabaseAdmin.from('session_events').insert({
      session_id: session.id,
      event_type: 'ai_step_end',
      description: result.cancel
        ? `AI: Cancelled inject: ${inject.title ?? inject.id}${result.adversary_inject ? ' (adversary adapts)' : ''}`
        : `AI: Publishing inject: ${inject.title ?? inject.id}`,
      actor_id: null,
      metadata: {
        step: 'evaluating_inject_cancellation',
        cancel: result.cancel,
        cancel_reason: result.cancel_reason ?? null,
        has_adversary_adaptation: !!result.adversary_inject,
      },
    });

    if (!result.cancel) return false;

    // --- Inject was cancelled ---
    await supabaseAdmin.from('session_events').insert({
      session_id: session.id,
      event_type: 'inject_cancelled',
      description: `Inject cancelled: ${inject.title ?? inject.id} - ${result.cancel_reason ?? 'Team actions addressed the concern'}`,
      actor_id: null,
      metadata: {
        inject_id: inject.id,
        cancel_reason: result.cancel_reason ?? null,
        cancelled_at: new Date().toISOString(),
      },
    });

    // Credit teams with positive heat meter
    const creditTeams = inject.target_teams ?? null;
    const teamsToCredit =
      creditTeams && creditTeams.length > 0
        ? creditTeams
        : [
            ...new Set(
              relevantDecisions
                .map((d) => (d.proposed_by ? userIdToTeam.get(d.proposed_by) : undefined))
                .filter(Boolean) as string[],
            ),
          ];
    for (const team of teamsToCredit) {
      try {
        await updateTeamHeatMeter(session.id, team, 'good');
      } catch {
        /* non-critical */
      }
    }
    if (teamsToCredit.length > 0) {
      logger.info(
        { sessionId: session.id, injectTitle: inject.title, teams: teamsToCredit },
        'Inject cancelled — positive scoring awarded',
      );
    }

    // Adversary adaptation: publish a follow-up if the adversary can still cause trouble
    if (result.adversary_inject && session.scenario_id) {
      try {
        const adaptTitle = `${result.adversary_inject.title} – ${(inject.target_teams ?? [])[0] ?? 'all'} (${inject.id.slice(0, 8)})`;
        const { data: adaptInject, error: adaptErr } = await supabaseAdmin
          .from('scenario_injects')
          .insert({
            scenario_id: session.scenario_id,
            session_id: session.id,
            type: 'field_update',
            title: adaptTitle,
            content: result.adversary_inject.content,
            severity: inject.severity ?? 'medium',
            inject_scope: inject.inject_scope ?? 'team_specific',
            target_teams: inject.target_teams ?? null,
            requires_response: true,
            requires_coordination: false,
            ai_generated: true,
            generation_source: 'adversary_adaptation',
          })
          .select()
          .single();

        if (adaptErr) {
          logger.warn(
            { err: adaptErr, sessionId: session.id, origInjectTitle: inject.title },
            'Failed to insert adversary adaptation inject',
          );
        } else if (adaptInject && io) {
          await publishInjectToSession(adaptInject.id, session.id, session.trainer_id, io);
          logger.info(
            { sessionId: session.id, origInjectTitle: inject.title, adaptTitle: adaptInject.title },
            'Adversary adaptation inject published',
          );
        }
      } catch (adaptPublishErr) {
        logger.warn(
          { err: adaptPublishErr, sessionId: session.id },
          'Failed to publish adversary adaptation inject',
        );
      }
    }

    logger.info(
      {
        sessionId: session.id,
        injectId: inject.id,
        injectTitle: inject.title,
        cancel_reason: result.cancel_reason,
      },
      'Scheduled inject cancelled by adversary engine',
    );
    return true;
  } catch (cancelErr) {
    logger.warn(
      { error: cancelErr, sessionId: session.id, injectId: inject.id },
      'AI cancellation check failed, publishing inject anyway',
    );
    return false;
  }
}

/**
 * Inject Scheduler Service
 * Monitors active sessions and publishes (1) time-based injects when trigger_time_minutes is reached,
 * (2) condition-driven injects when conditions_to_appear are met and conditions_to_cancel are not (Step 4).
 */
/** Per-session lock: avoid processing the same session in two overlapping ticks (prevents double publish). */
const sessionsInProgress = new Set<string>();

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
      // Get all active sessions with start_time (current_state for condition evaluator context)
      const { data: sessions, error: sessionsError } = await supabaseAdmin
        .from('sessions')
        .select(
          'id, scenario_id, start_time, trainer_id, status, current_state, inject_state_effects, sim_mode',
        )
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

      // Process each session (skip if same session still being processed from a prior tick — prevents double publish)
      for (const session of sessions) {
        if (sessionsInProgress.has(session.id)) {
          logger.debug(
            { sessionId: session.id },
            'Session already being processed, skipping this tick',
          );
          continue;
        }
        sessionsInProgress.add(session.id);
        try {
          await this.processSession(session);
        } catch (sessionErr) {
          logger.error(
            { error: sessionErr, sessionId: session.id },
            'Error processing session for injects',
          );
          // Continue with next session even if one fails
        } finally {
          sessionsInProgress.delete(session.id);
        }
      }
    } catch (err) {
      logger.error({ error: err }, 'Error in checkAndPublishInjects');
    }
  }

  /**
   * Process a single session to check for injects that should be published (time-based and condition-based).
   */
  private async processSession(session: {
    id: string;
    scenario_id: string;
    start_time: string;
    trainer_id: string;
    status: string;
    current_state?: Record<string, unknown> | null;
    inject_state_effects?: Record<string, unknown> | null;
    sim_mode?: string | null;
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

    // Merge inject_state_effects so live counters see disruption-related modifiers
    const rawState = (session.current_state as Record<string, unknown>) || {};
    const injectEffects = (session.inject_state_effects as Record<string, unknown>) || {};
    const currentState = mergeStateWithInjectEffects(rawState, injectEffects);
    const nextState: Record<string, unknown> = { ...currentState };
    let stateChanged = false;

    // Live pin-driven counters: all counters derived from scenario_casualties / scenario_hazards
    try {
      const liveCounters = await computeLiveCounters(session.id, session.scenario_id);

      // Merge evacuation counters
      const evacState = (nextState.evacuation_state as Record<string, unknown>) ?? {};
      (nextState.evacuation_state as Record<string, unknown>) = {
        ...evacState,
        total_evacuated: liveCounters.evacuation.total_evacuated,
        civilians_at_assembly: liveCounters.evacuation.civilians_at_assembly,
        still_inside: liveCounters.evacuation.still_inside,
        in_transit: liveCounters.evacuation.in_transit,
        convergent_crowds_count: liveCounters.evacuation.convergent_crowds_count,
        crowd_compliance_score: liveCounters.evacuation.crowd_compliance_score,
      };

      // Merge triage counters
      const triageState = (nextState.triage_state as Record<string, unknown>) ?? {};
      (nextState.triage_state as Record<string, unknown>) = {
        ...triageState,
        total_patients: liveCounters.triage.total_patients,
        awaiting_triage: liveCounters.triage.awaiting_triage,
        in_treatment: liveCounters.triage.in_treatment,
        red_immediate: liveCounters.triage.red_immediate,
        yellow_delayed: liveCounters.triage.yellow_delayed,
        green_minor: liveCounters.triage.green_minor,
        black_deceased: liveCounters.triage.black_deceased,
        ready_for_transport: liveCounters.triage.ready_for_transport,
        transported: liveCounters.triage.transported,
        deaths_on_site: liveCounters.triage.deaths_on_site,
      };

      // Merge fire/rescue counters
      const fireState = (nextState.fire_rescue_state as Record<string, unknown>) ?? {};
      (nextState.fire_rescue_state as Record<string, unknown>) = {
        ...fireState,
        active_fires: liveCounters.fire_rescue.active_fires,
        fires_contained: liveCounters.fire_rescue.fires_contained,
        fires_resolved: liveCounters.fire_rescue.fires_resolved,
        hazards_active: liveCounters.fire_rescue.hazards_active,
        hazards_resolved: liveCounters.fire_rescue.hazards_resolved,
        casualties_in_hot_zone: liveCounters.fire_rescue.casualties_in_hot_zone,
        extracted_to_warm: liveCounters.fire_rescue.extracted_to_warm,
        debris_cleared: liveCounters.fire_rescue.debris_cleared,
      };

      // Merge bomb squad counters
      const bombState = (nextState.bomb_squad_state as Record<string, unknown>) ?? {};
      (nextState.bomb_squad_state as Record<string, unknown>) = {
        ...bombState,
        active_threats: liveCounters.bomb_squad.active_threats,
        tips_received: liveCounters.bomb_squad.tips_received,
        devices_found: liveCounters.bomb_squad.devices_found,
        devices_rendered_safe: liveCounters.bomb_squad.devices_rendered_safe,
        false_alarms_cleared: liveCounters.bomb_squad.false_alarms_cleared,
        sweeps_completed: liveCounters.bomb_squad.sweeps_completed,
        detonations: liveCounters.bomb_squad.detonations,
        exclusion_zones_active: liveCounters.bomb_squad.exclusion_zones_active,
      };

      // Merge area occupancy breakdown
      if (liveCounters.area_occupancy?.length) {
        nextState.area_occupancy = liveCounters.area_occupancy;
      }

      stateChanged = true;
    } catch (liveErr) {
      logger.warn({ err: liveErr, sessionId: session.id }, 'Live counter computation failed');
    }

    if (stateChanged) {
      try {
        await supabaseAdmin
          .from('sessions')
          .update({ current_state: nextState })
          .eq('id', session.id);
        getWebSocketService().stateUpdated?.(session.id, {
          state: nextState,
          timestamp: new Date().toISOString(),
        });
        (session as { current_state?: Record<string, unknown> }).current_state = nextState;
      } catch (stateErr) {
        logger.error(
          { err: stateErr, sessionId: session.id },
          'Failed to apply scheduler time-based state update',
        );
      }
    }

    // Run gate evaluation so session_gate_progress is up to date before selecting injects
    let ioForGates = this.io;
    if (!ioForGates) {
      const { io } = await import('../index.js');
      ioForGates = io;
    }
    await runGateEvaluationForSession(session.id, elapsedMinutes, ioForGates);

    // Evaluate pursuit response windows (breadcrumb sighting intel tracking)
    try {
      await runPursuitResponseCheck(session.id);
    } catch (pursuitErr) {
      logger.warn({ err: pursuitErr, sessionId: session.id }, 'Pursuit response check error');
    }

    // Load gate progress for this session (for required_gate_id and required_gate_not_met_id filtering, and for condition context).
    // scenario_injects.required_gate_id / required_gate_not_met_id are scenario_gates.id (UUID); session_gate_progress uses gate_id (TEXT). Build map by scenario_gates.id.
    const { data: scenarioGates } = await supabaseAdmin
      .from('scenario_gates')
      .select('id, gate_id')
      .eq('scenario_id', session.scenario_id);
    const gateIdToUuid = new Map<string, string>();
    for (const g of scenarioGates ?? []) {
      gateIdToUuid.set(g.gate_id, g.id);
    }
    const { data: gateProgressRows, error: gateProgressError } = await supabaseAdmin
      .from('session_gate_progress')
      .select('gate_id, status')
      .eq('session_id', session.id);
    if (gateProgressError) {
      logger.debug(
        { error: gateProgressError, sessionId: session.id },
        'Failed to load session_gate_progress for inject filtering, using empty',
      );
    }
    const gateStatusByGateUuid = new Map<string, string>();
    for (const row of gateProgressRows ?? []) {
      const uuid = gateIdToUuid.get(row.gate_id);
      if (uuid) gateStatusByGateUuid.set(uuid, row.status);
    }

    // Load published and cancelled injects (for both time-based and condition-based filtering)
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

    const publishedInjectIds = new Set<string>();
    if (publishedEvents) {
      for (const event of publishedEvents) {
        const injectId = (event.metadata as { inject_id?: string })?.inject_id;
        if (injectId) publishedInjectIds.add(injectId);
        else
          logger.warn(
            { sessionId: session.id, eventMetadata: event.metadata },
            'Published event found but missing inject_id in metadata',
          );
      }
    }

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

    // Get time-based injects for this scenario (trigger_time_minutes <= elapsed)
    // Include template injects (session_id IS NULL) and this session's runtime injects
    const { data: injectsRaw, error: injectsError } = await supabaseAdmin
      .from('scenario_injects')
      .select(
        'id, trigger_time_minutes, title, content, required_gate_id, required_gate_not_met_id, target_teams, inject_scope',
      )
      .eq('scenario_id', session.scenario_id)
      .or(`session_id.is.null,session_id.eq.${session.id}`)
      .not('trigger_time_minutes', 'is', null)
      .lte('trigger_time_minutes', elapsedMinutes);

    if (injectsError) {
      logger.error(
        { error: injectsError, sessionId: session.id, scenarioId: session.scenario_id },
        'Failed to fetch injects for session',
      );
      return;
    }

    // Filter: include when (no required_gate or gate met) and (no required_gate_not_met or that gate not_met)
    type InjectRow = {
      id: string;
      trigger_time_minutes: number | null;
      title: string | null;
      content?: string;
      severity?: string | null;
      required_gate_id?: string | null;
      required_gate_not_met_id?: string | null;
      target_teams?: string[] | null;
      inject_scope?: string | null;
    };
    const injects = (injectsRaw ?? []).filter((inj: InjectRow) => {
      if (inj.required_gate_id != null) {
        const status = gateStatusByGateUuid.get(inj.required_gate_id);
        if (status !== 'met') return false;
      }
      if (inj.required_gate_not_met_id != null) {
        const status = gateStatusByGateUuid.get(inj.required_gate_not_met_id);
        if (status !== 'not_met') return false;
      }
      return true;
    }) as typeof injectsRaw;

    const injectsToPublish = injects.filter(
      (inject) => !publishedInjectIds.has(inject.id) && !cancelledInjectIds.has(inject.id),
    );

    if (injectsToPublish.length > 0) {
      logger.info(
        {
          sessionId: session.id,
          injectsToPublish: injectsToPublish.map((i) => ({
            id: i.id,
            triggerTime: i.trigger_time_minutes,
            title: i.title,
          })),
        },
        'Publishing time-based injects',
      );
    }

    // Fetch all decisions and team mappings (shared by time-based AI checks)
    const { data: allDecisions } = await supabaseAdmin
      .from('decisions')
      .select('id, title, description, type, proposed_by')
      .eq('session_id', session.id)
      .eq('status', 'executed')
      .order('executed_at', { ascending: false })
      .limit(50);

    const allDecisionsForAi: Array<{
      title: string;
      description: string;
      type: string | null;
      proposed_by: string | null;
    }> = (allDecisions || []).map((d) => ({
      title: d.title ?? '',
      description: d.description ?? '',
      type: d.type as string | null,
      proposed_by: d.proposed_by as string | null,
    }));

    // Append active map placements as pseudo-decisions so the AI cancellation
    // gate can see physical assets (cordons, triage zones, assembly points, etc.)
    const { data: activePlacements } = await supabaseAdmin
      .from('placed_assets')
      .select('asset_type, label, geometry, properties, team_name, placed_at')
      .eq('session_id', session.id)
      .eq('status', 'active');

    for (const p of activePlacements ?? []) {
      const geomType = (p.geometry as Record<string, unknown>)?.type ?? 'Point';
      const props = (p.properties ?? {}) as Record<string, unknown>;
      const details = [
        props.length_m ? `${props.length_m}m long` : null,
        props.area_m2 ? `${props.area_m2}m² area` : null,
        props.capacity
          ? `capacity ${props.capacity} ${(props.capacity_unit as string) ?? 'people'}`
          : null,
      ]
        .filter(Boolean)
        .join(', ');

      allDecisionsForAi.push({
        title: `[MAP PLACEMENT] ${p.label ?? p.asset_type} by ${p.team_name}`,
        description: `${p.team_name} placed a ${p.label ?? p.asset_type} (${geomType}) on the map${details ? `: ${details}` : ''}`,
        type: 'map_action',
        proposed_by: null,
      });
    }

    const { data: teamMappings } = await supabaseAdmin
      .from('session_teams')
      .select('user_id, team_name')
      .eq('session_id', session.id);
    const userIdToTeam = new Map<string, string>();
    for (const tm of teamMappings ?? []) {
      userIdToTeam.set(
        (tm as { user_id: string }).user_id,
        (tm as { team_name: string }).team_name,
      );
    }

    // --- Time-based injects: publish with AI cancellation gate ---
    if (injectsToPublish.length > 0) {
      for (const inject of injectsToPublish) {
        try {
          if (!this.io) {
            const { io } = await import('../index.js');
            this.io = io;
          }

          let cancelled = false;
          if (session.sim_mode === 'social_media') {
            const { data: playerActions } = await supabaseAdmin
              .from('player_actions')
              .select('action_type, content, created_at, metadata')
              .eq('session_id', session.id)
              .order('created_at', { ascending: false })
              .limit(30);

            const sentiment = await computeSessionSentiment(session.id);

            const { count: pendingCount } = await supabaseAdmin
              .from('social_posts')
              .select('id', { count: 'exact', head: true })
              .eq('session_id', session.id)
              .eq('requires_response', true)
              .is('responded_at', null);

            const researchGuidelines =
              ((session.current_state as Record<string, unknown>)?.research_guidelines as Record<
                string,
                unknown
              >) || undefined;

            const result = await shouldCancelSocialInject(
              {
                title: inject.title ?? '',
                content: (inject as { content?: string }).content ?? '',
              },
              (playerActions || []).map((a) => ({
                action_type: a.action_type as string,
                content: a.content as string | null,
                created_at: a.created_at as string,
                metadata: (a.metadata || {}) as Record<string, unknown>,
              })),
              sentiment,
              pendingCount ?? 0,
              researchGuidelines as Parameters<typeof shouldCancelSocialInject>[4],
            );
            cancelled = result.cancel;
          } else {
            cancelled = await runAiCancellationGate(
              {
                id: inject.id,
                title: inject.title ?? null,
                content: (inject as { content?: string }).content,
                target_teams: (inject as InjectRow).target_teams,
                severity: (inject as InjectRow).severity,
                inject_scope: (inject as InjectRow).inject_scope,
              },
              { id: session.id, scenario_id: session.scenario_id, trainer_id: session.trainer_id },
              allDecisionsForAi,
              userIdToTeam,
              this.io,
            );
          }
          if (cancelled) continue;

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
            logger.warn(
              { sessionId: session.id, injectId: inject.id },
              'Socket server not available, skipping inject publish',
            );
            continue;
          }

          await publishInjectToSession(inject.id, session.id, session.trainer_id, this.io);
          publishedInjectIds.add(inject.id);
          logger.info(
            { sessionId: session.id, injectId: inject.id },
            'Inject auto-published successfully',
          );
        } catch (publishErr) {
          logger.error(
            { error: publishErr, sessionId: session.id, injectId: inject.id },
            'Failed to auto-publish inject',
          );
        }
      }
    }

    // --- Social media crisis: compute social state before condition evaluation ---
    if (session.sim_mode === 'social_media') {
      try {
        await computeSocialState(session.id, elapsedMinutes);
      } catch (stateErr) {
        logger.warn({ err: stateErr, sessionId: session.id }, 'Social state computation error');
      }
    }

    // --- Condition-based injects: evaluate conditions, pass through AI gate, publish ---
    try {
      const { data: condInjectsRaw } = await supabaseAdmin
        .from('scenario_injects')
        .select(
          'id, title, content, severity, target_teams, inject_scope, conditions_to_appear, conditions_to_cancel, eligible_after_minutes, state_effect',
        )
        .eq('scenario_id', session.scenario_id)
        .or(`session_id.is.null,session_id.eq.${session.id}`)
        .not('conditions_to_appear', 'is', null)
        .is('trigger_time_minutes', null);

      const condInjects = (condInjectsRaw ?? []).filter(
        (inj: { id: string; eligible_after_minutes?: number | null }) =>
          !publishedInjectIds.has(inj.id) &&
          !cancelledInjectIds.has(inj.id) &&
          (inj.eligible_after_minutes == null || inj.eligible_after_minutes <= elapsedMinutes),
      );

      if (condInjects.length > 0) {
        const gateStatusByGateId: Record<string, 'pending' | 'met' | 'not_met'> = {};
        for (const [uuid, status] of gateStatusByGateUuid.entries()) {
          for (const g of scenarioGates ?? []) {
            if (g.id === uuid) {
              gateStatusByGateId[g.gate_id] = status as 'pending' | 'met' | 'not_met';
            }
          }
        }

        const publishedKeysOrTags: string[] = [];
        for (const event of publishedEvents ?? []) {
          const meta = event.metadata as { inject_id?: string; title?: string; tags?: string[] };
          if (meta?.title) publishedKeysOrTags.push(meta.title);
          if (meta?.tags) publishedKeysOrTags.push(...meta.tags);
        }

        const { count: placedAssetsCount } = await supabaseAdmin
          .from('placed_assets')
          .select('id', { count: 'exact', head: true })
          .eq('session_id', session.id);

        const evalContext: EvaluationContext = {
          sessionId: session.id,
          scenarioId: session.scenario_id,
          elapsedMinutes,
          currentState: nextState,
          executedDecisions: (allDecisions ?? []).map((d) => ({
            id: d.id,
            title: d.title ?? '',
            description: d.description ?? '',
            decision_type: d.type as string | undefined,
          })),
          publishedScenarioInjectIds: [...publishedInjectIds],
          publishedInjectKeysOrTags: publishedKeysOrTags,
          gateStatusByGateId,
          placedAssetsCount: placedAssetsCount ?? 0,
        };

        for (const condInject of condInjects) {
          const result = evaluateInjectConditions(
            condInject.conditions_to_appear as ConditionsToAppear | null,
            condInject.conditions_to_cancel as ConditionsToCancel | null,
            evalContext,
          );

          if (result.status === 'cancel_met') {
            await supabaseAdmin.from('session_events').insert({
              session_id: session.id,
              event_type: 'inject_cancelled',
              metadata: { inject_id: condInject.id, reason: 'condition_cancel_met' },
            });
            cancelledInjectIds.add(condInject.id);
            logger.info(
              { sessionId: session.id, injectId: condInject.id, title: condInject.title },
              'Condition-based inject cancelled (cancel condition met)',
            );
            continue;
          }

          if (result.status === 'appear_met') {
            if (!this.io) {
              const { io } = await import('../index.js');
              this.io = io;
            }

            const cancelled = await runAiCancellationGate(
              {
                id: condInject.id,
                title: condInject.title ?? null,
                content: condInject.content as string | undefined,
                target_teams: condInject.target_teams as string[] | null,
                severity: condInject.severity as string | null,
                inject_scope: condInject.inject_scope as string | null,
              },
              { id: session.id, scenario_id: session.scenario_id, trainer_id: session.trainer_id },
              allDecisionsForAi,
              userIdToTeam,
              this.io,
            );
            if (cancelled) continue;

            logger.info(
              {
                sessionId: session.id,
                injectId: condInject.id,
                injectTitle: condInject.title,
                elapsedMinutes,
              },
              'Auto-publishing condition-based inject',
            );

            await publishInjectToSession(condInject.id, session.id, session.trainer_id, this.io);
            publishedInjectIds.add(condInject.id);
          }
        }
      }
    } catch (condErr) {
      logger.warn(
        { err: condErr, sessionId: session.id },
        'Condition-based inject evaluation error',
      );
    }

    // --- Spatial pin resolution: check if placed assets resolve hazard/casualty pins ---
    try {
      await evaluatePinResolution(session.id);
    } catch (pinErr) {
      logger.warn({ err: pinErr, sessionId: session.id }, 'Pin resolution evaluation error');
    }

    // --- Deterioration cycles (every 10 minutes — run on every tick, the services
    //     internally track timing via elapsed minutes) ---
    try {
      await Promise.all([runHazardDeterioration(session.id), runPeopleDeterioration(session.id)]);
    } catch (detErr) {
      logger.warn({ err: detErr, sessionId: session.id }, 'Deterioration cycle error');
    }

    // --- Evacuation spatial pipeline ---
    try {
      await Promise.all([
        processExitFlow(session.id),
        processNonAmbulatoryExtraction(session.id),
        checkPendingEndorsements(session.id),
      ]);
    } catch (evacErr) {
      logger.warn({ err: evacErr, sessionId: session.id }, 'Evacuation pipeline error');
    }

    // --- Movement tick: interpolate moving casualty/crowd pins ---
    try {
      const movementLastTickIso = (
        (session.current_state as Record<string, unknown>)?._counter_ticks as Record<string, string>
      )?._movement;
      const movementLastMs = movementLastTickIso ? new Date(movementLastTickIso).getTime() : 0;
      const movementDelta =
        movementLastMs > 0 ? Math.max(0, (Date.now() - movementLastMs) / 60000) : 0.5;
      await runMovementTick(session.id, session.scenario_id, movementDelta);
      // Update movement tick timestamp in state (will be persisted next cycle)
      const csForMovement = (session.current_state ?? {}) as Record<string, unknown>;
      const ticks = (csForMovement._counter_ticks as Record<string, string>) ?? {};
      ticks._movement = new Date().toISOString();
      csForMovement._counter_ticks = ticks;
    } catch (moveErr) {
      logger.warn({ err: moveErr, sessionId: session.id }, 'Movement tick error');
    }

    // --- Area monitors: capacity, carer ratio, equipment, exit congestion ---
    try {
      let ioForMonitors = this.io;
      if (!ioForMonitors) {
        const { io: serverIo } = await import('../index.js');
        ioForMonitors = serverIo;
      }
      await runAreaMonitors(session.id, session.scenario_id, elapsedMinutes, ioForMonitors);
    } catch (monErr) {
      logger.warn({ err: monErr, sessionId: session.id }, 'Area monitor evaluation error');
    }

    // --- Detonation timer: check for expired live bombs ---
    try {
      await this.checkDetonationTimers(session.id, session.scenario_id, session.trainer_id);
    } catch (detErr) {
      logger.warn({ err: detErr, sessionId: session.id }, 'Detonation timer check error');
    }

    // --- Bomb squad auto-sweep: deterministically sweep one un-swept asset per tick ---
    try {
      await this.checkSweepQueue(session.id, elapsedMinutes);
    } catch (sweepErr) {
      logger.warn({ err: sweepErr, sessionId: session.id }, 'Bomb squad sweep queue error');
    }

    // --- Patient queue: deterministically process casualties (fire extraction + triage) ---
    try {
      await this.checkPatientQueue(session.id, session.scenario_id, elapsedMinutes);
    } catch (patientErr) {
      logger.warn({ err: patientErr, sessionId: session.id }, 'Patient queue processing error');
    }

    // --- Hazard queue: deterministically respond to active hazards ---
    try {
      await this.checkHazardQueue(session.id, session.scenario_id, elapsedMinutes);
    } catch (hazardErr) {
      logger.warn({ err: hazardErr, sessionId: session.id }, 'Hazard queue processing error');
    }

    // --- Social media crisis: check response deadlines + ambient posts ---
    if (session.sim_mode === 'social_media') {
      try {
        await checkResponseDeadlines(session.id);
      } catch (socialErr) {
        logger.warn(
          { err: socialErr, sessionId: session.id },
          'Social response deadline check error',
        );
      }

      try {
        await generateAmbientPosts(session.id);
      } catch (ambientErr) {
        logger.warn({ err: ambientErr, sessionId: session.id }, 'Ambient post generation error');
      }
    }
  }

  /**
   * Deterministic bomb squad sweep: every tick (after a grace period), sweep
   * the next un-swept placed asset.  No LLM involved — just call performSweep().
   * One asset per tick to pace the sweep cadence naturally.
   * Creates proper decisions & chat messages so sweeps are visible in the UI.
   */
  private async checkSweepQueue(sessionId: string, elapsedMinutes: number): Promise<void> {
    const SWEEP_START_MINUTE = 3;
    if (elapsedMinutes < SWEEP_START_MINUTE) return;

    const { data: sessionRow } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id, hidden_devices')
      .eq('id', sessionId)
      .single();
    if (!sessionRow) return;

    const { data: bombTeam } = await supabaseAdmin
      .from('scenario_teams')
      .select('team_name')
      .eq('scenario_id', sessionRow.scenario_id)
      .ilike('team_name', '%bomb%')
      .limit(1);
    if (!bombTeam || bombTeam.length === 0) return;

    const { data: allAssets } = await supabaseAdmin
      .from('placed_assets')
      .select('id, label, asset_type, team_name')
      .eq('session_id', sessionId)
      .eq('status', 'active');
    if (!allAssets || allAssets.length === 0) return;

    const bombTeamName = (bombTeam[0] as Record<string, unknown>).team_name as string;
    const nonBombAssets = allAssets.filter(
      (a) => (a as Record<string, unknown>).team_name !== bombTeamName,
    );
    if (nonBombAssets.length === 0) return;

    const { data: sweepEvents } = await supabaseAdmin
      .from('session_events')
      .select('metadata')
      .eq('session_id', sessionId)
      .eq('event_type', 'bomb_squad_sweep');
    const sweptAssetIds = new Set<string>();
    for (const ev of sweepEvents ?? []) {
      const meta = ev.metadata as Record<string, unknown> | null;
      if (meta?.asset_id) sweptAssetIds.add(meta.asset_id as string);
    }

    const nextAsset = nonBombAssets.find((a) => !sweptAssetIds.has(a.id));
    if (!nextAsset) return;

    const assetLabel =
      ((nextAsset as Record<string, unknown>).label as string) ||
      ((nextAsset as Record<string, unknown>).asset_type as string) ||
      'asset';
    const assetTeam = (nextAsset as Record<string, unknown>).team_name as string;
    const assetType = ((nextAsset as Record<string, unknown>).asset_type as string).replace(
      /_/g,
      ' ',
    );
    const sweepNumber = sweptAssetIds.size + 1;
    const totalToSweep = nonBombAssets.length;

    logger.info(
      {
        sessionId,
        assetId: nextAsset.id,
        label: assetLabel,
        sweep: `${sweepNumber}/${totalToSweep}`,
      },
      'Auto-sweeping placed asset for bomb squad',
    );

    // Pick detection equipment based on asset type
    const equipment = this.pickSweepEquipment(assetType);

    const result = await performSweep(sessionId, nextAsset.id, {
      personnel: equipment.personnel,
      k9: equipment.k9,
      robot: equipment.robot,
    });

    // Create decision and chat via the dispatcher (same as other bot actions)
    const botUserId = resolveBotUserId(bombTeamName);
    const dispatcher = new DemoActionDispatcher();
    const channelId = await dispatcher.getSessionChannelId(sessionId);

    if (result.found) {
      const containerDesc = result.container_type?.replace(/_/g, ' ') ?? 'suspicious item';
      const liveWarning = result.is_live
        ? 'Device is assessed as LIVE — 2-minute render-safe window activated. Requesting immediate RSP (Render Safe Procedure).'
        : 'Device appears INERT — maintaining exclusion zone pending full examination.';

      await dispatcher.proposeAndExecuteDecision(sessionId, botUserId, {
        title: `EOD Sweep ${sweepNumber}/${totalToSweep}: DEVICE FOUND at ${assetLabel}`,
        description: [
          `Bomb Squad conducted systematic sweep of ${assetTeam}'s ${assetType} ("${assetLabel}") — sweep ${sweepNumber} of ${totalToSweep}.`,
          `Detection method: ${equipment.summary}.`,
          `Result: ${containerDesc} DISCOVERED. ${liveWarning}`,
          result.is_live
            ? 'Immediate actions: deploying remote-operated vehicle (ROV) for closer examination, establishing 100m exclusion zone, all personnel to withdraw behind hard cover.'
            : 'Maintaining 50m cordon. EOD team conducting manual approach with protective equipment for controlled disruption.',
        ].join(' '),
      });

      if (channelId) {
        await dispatcher.sendChatMessage(
          channelId,
          sessionId,
          botUserId,
          `🚨 SWEEP ${sweepNumber}/${totalToSweep} — DEVICE FOUND at "${assetLabel}" (${assetTeam}'s ${assetType}). ${equipment.summary}. ${containerDesc} located. ${result.is_live ? '⚠️ LIVE DEVICE — RSP initiated, 2-min window.' : 'Inert device — controlled disruption planned.'}`,
        );
      }
    } else {
      await dispatcher.proposeAndExecuteDecision(sessionId, botUserId, {
        title: `EOD Sweep ${sweepNumber}/${totalToSweep}: ${assetLabel} — CLEAR`,
        description: [
          `Bomb Squad conducted systematic sweep of ${assetTeam}'s ${assetType} ("${assetLabel}") — sweep ${sweepNumber} of ${totalToSweep}.`,
          `Detection method: ${equipment.summary}.`,
          `Result: Area CLEAR — no suspicious items detected. Asset cleared for continued operations.`,
          sweepNumber < totalToSweep
            ? `${totalToSweep - sweepNumber} asset(s) remaining in sweep queue.`
            : 'All operational assets have been swept. Perimeter sweep complete.',
        ].join(' '),
      });

      if (channelId) {
        await dispatcher.sendChatMessage(
          channelId,
          sessionId,
          botUserId,
          `✅ SWEEP ${sweepNumber}/${totalToSweep} — "${assetLabel}" (${assetTeam}'s ${assetType}) is CLEAR. ${equipment.summary}. ${sweepNumber < totalToSweep ? `${totalToSweep - sweepNumber} remaining.` : 'All assets swept.'}`,
        );
      }
    }

    logger.info(
      {
        sessionId,
        assetId: nextAsset.id,
        found: result.found,
        hazardId: result.hazard_id,
        sweep: `${sweepNumber}/${totalToSweep}`,
      },
      'Bomb squad auto-sweep completed',
    );
  }

  /**
   * Select realistic detection equipment based on asset type.
   * Returns a personnel count, K9/robot flags, and a human-readable summary.
   */
  private pickSweepEquipment(assetType: string): {
    personnel: number;
    k9: boolean;
    robot: boolean;
    summary: string;
  } {
    const t = assetType.toLowerCase();

    if (t.includes('command') || t.includes('post') || t.includes('hq')) {
      return {
        personnel: 4,
        k9: true,
        robot: false,
        summary:
          '4-person team with explosive detection dog (EDD), portable X-ray, and vapour trace detector',
      };
    }
    if (t.includes('triage') || t.includes('medical') || t.includes('treatment')) {
      return {
        personnel: 3,
        k9: true,
        robot: false,
        summary: '3-person team with explosive detection dog (EDD) and handheld vapour analyser',
      };
    }
    if (t.includes('staging') || t.includes('marshalling') || t.includes('assembly')) {
      return {
        personnel: 3,
        k9: false,
        robot: true,
        summary: '3-person team with remote-operated vehicle (ROV) and ground-penetrating radar',
      };
    }
    if (t.includes('cordon') || t.includes('perimeter') || t.includes('barrier')) {
      return {
        personnel: 2,
        k9: false,
        robot: false,
        summary: '2-person team with visual inspection and portable X-ray scanner',
      };
    }
    if (t.includes('vehicle') || t.includes('ambulance') || t.includes('transport')) {
      return {
        personnel: 2,
        k9: false,
        robot: true,
        summary:
          '2-person team with under-vehicle inspection mirror (UVIM) and remote-operated vehicle',
      };
    }
    // Default for any other asset
    return {
      personnel: 3,
      k9: true,
      robot: false,
      summary:
        '3-person team with explosive detection dog (EDD), visual search, and electronic countermeasures sweep',
    };
  }

  // =========================================================================
  // Deterministic patient processing queue
  // =========================================================================

  /**
   * Process up to PATIENTS_PER_TICK casualties each scheduler tick.
   * Fire/Rescue handles HOT zone patients (extraction + basic first aid).
   * Triage/Medical handles WARM/COLD zone patients (triage, treat, transport).
   * No LLM involved — actions are derived from zone + status deterministically.
   */
  private async checkPatientQueue(
    sessionId: string,
    scenarioId: string,
    elapsedMinutes: number,
  ): Promise<void> {
    const PATIENT_START_MINUTE = 6;
    const PATIENTS_PER_TICK = 3;
    if (elapsedMinutes < PATIENT_START_MINUTE) return;

    const { data: allTeams } = await supabaseAdmin
      .from('scenario_teams')
      .select('team_name')
      .eq('scenario_id', scenarioId);
    if (!allTeams?.length) return;

    const teamNames = allTeams.map((t) => (t as Record<string, unknown>).team_name as string);
    const fireTeam = teamNames.find((n) => /fire|hazard|rescue/i.test(n) && !/bomb/i.test(n));
    const triageTeam = teamNames.find((n) => /triage|medical|health|ems|ambulance/i.test(n));
    if (!fireTeam && !triageTeam) return;

    const { data: casualties } = await supabaseAdmin
      .from('scenario_casualties')
      .select(
        'id, casualty_type, headcount, status, location_lat, location_lng, conditions, player_triage_color, assigned_team',
      )
      .eq('session_id', sessionId)
      .in('status', [
        'undiscovered',
        'identified',
        'awaiting_triage',
        'endorsed_to_triage',
        'at_assembly',
        'in_treatment',
      ])
      .not('casualty_type', 'in', '("crowd","evacuee_group","convergent_crowd")')
      .order('created_at', { ascending: true })
      .limit(40);
    if (!casualties?.length) return;

    // Sort by triage priority: RED → YELLOW → GREEN → undetermined → BLACK
    const TRIAGE_PRIORITY: Record<string, number> = {
      red: 0,
      immediate: 0,
      yellow: 1,
      delayed: 1,
      green: 2,
      minor: 2,
      black: 4,
      expectant: 4,
      deceased: 4,
    };
    const triagePriority = (cas: Record<string, unknown>): number => {
      const color =
        (cas.player_triage_color as string) ||
        ((cas.conditions as Record<string, unknown> | null)?.triage_category as string) ||
        '';
      return TRIAGE_PRIORITY[color.toLowerCase()] ?? 3;
    };
    (casualties as Array<Record<string, unknown>>).sort(
      (a, b) => triagePriority(a) - triagePriority(b),
    );

    const zoneCtx = await this.loadZoneContext(sessionId);

    const classifyZone = (lat: number, lng: number) =>
      determineZone(
        lat,
        lng,
        zoneCtx.playerZones as unknown as PlacedZoneArea[],
        zoneCtx.warRoomZones,
        zoneCtx.incidentLat,
        zoneCtx.incidentLng,
      );

    // Skip patients that already have active decisions this tick (avoid double-processing)
    const { data: recentPinEvents } = await supabaseAdmin
      .from('session_events')
      .select('metadata')
      .eq('session_id', sessionId)
      .eq('event_type', 'patient_queue_processed')
      .order('created_at', { ascending: false })
      .limit(50);
    const recentlyProcessed = new Set<string>();
    for (const ev of recentPinEvents ?? []) {
      const meta = ev.metadata as Record<string, unknown> | null;
      if (meta?.casualty_id) recentlyProcessed.add(meta.casualty_id as string);
    }

    let processed = 0;
    const dispatcher = new DemoActionDispatcher();
    const channelId = await dispatcher.getSessionChannelId(sessionId);

    for (const cas of casualties as Array<Record<string, unknown>>) {
      if (processed >= PATIENTS_PER_TICK) break;

      const casId = cas.id as string;
      if (recentlyProcessed.has(casId)) continue;

      const lat = Number(cas.location_lat);
      const lng = Number(cas.location_lng);
      const zone = classifyZone(lat, lng);
      const status = cas.status as string;
      const conds = (cas.conditions ?? {}) as Record<string, unknown>;
      const triageColor =
        (cas.player_triage_color as string) || (conds.triage_category as string) || null;
      const visDesc =
        (conds.visible_description as string) || (conds.injury_type as string) || 'casualty';

      // Skip BLACK/deceased patients — tag only, don't spend resources
      const isBlack =
        triageColor === 'black' ||
        triageColor === 'expectant' ||
        triageColor === 'deceased' ||
        this.inferTriageColor(conds) === 'black';
      if (isBlack && status !== 'undiscovered') {
        // Already discovered/tagged — skip entirely, survivors take priority
        continue;
      }

      let handlingTeam: string | null = null;
      let actions: string[] = [];
      let description = '';
      let assignedTriageColor: string | undefined;
      const targetType = 'casualty' as const;

      if (zone === 'hot' && fireTeam) {
        // HOT zone: Fire/Rescue extracts to warm zone
        if (status === 'undiscovered' || status === 'identified') {
          handlingTeam = fireTeam;
          const mobility = conds.mobility as string | undefined;
          const isTrapped = mobility === 'trapped' || mobility === 'non_ambulatory';
          actions = isTrapped
            ? [
                'DRABC Assessment',
                'Extrication from debris',
                'Package on stretcher',
                'Extract to WARM zone',
              ]
            : ['DRABC Assessment', 'Apply basic first aid', 'Escort to WARM zone'];
          description = [
            `Hazards / Fire / Rescue responding to ${visDesc} in HOT ZONE.`,
            isTrapped
              ? 'Patient is trapped/non-ambulatory — deploying extrication team with stretcher carry.'
              : 'Patient is ambulatory — escorting with basic first aid.',
            `Extracting to warm zone for triage handoff to ${triageTeam || 'Medical'}.`,
            `Personnel: 2x Firefighters (1:1 ratio for extraction).`,
          ].join(' ');
        }
      } else if ((zone === 'warm' || zone === 'unknown') && triageTeam) {
        // WARM zone: Triage team handles triage + treatment
        // 'identified' patients must be triaged first (extract moved them here)
        if (
          status === 'awaiting_triage' ||
          status === 'endorsed_to_triage' ||
          status === 'at_assembly' ||
          status === 'identified'
        ) {
          handlingTeam = triageTeam;
          const inferColor = this.inferTriageColor(conds);
          assignedTriageColor = inferColor;

          if (inferColor === 'black') {
            actions = ['Confirm no signs of life', 'Assign BLACK tag', 'Cover and document'];
            description = [
              `Medical Triage confirming ${visDesc} in ${zone.toUpperCase()} ZONE as EXPECTANT.`,
              'No signs of life after airway check. BLACK tag assigned, body covered and documented.',
              'Moving on to next surviving patient. Coroner notification pending.',
            ].join(' ');
          } else {
            actions = [
              'START Triage Protocol',
              `Assign triage tag: ${inferColor.toUpperCase()}`,
              'Administer first aid',
              'Stabilize for treatment',
            ];
            description = [
              `Medical Triage responding to ${visDesc} in ${zone.toUpperCase()} ZONE.`,
              `START assessment: assigning ${inferColor.toUpperCase()} triage tag.`,
              inferColor === 'red'
                ? 'IMMEDIATE priority — establishing IV access, applying haemostatic dressing, preparing for urgent treatment.'
                : inferColor === 'yellow'
                  ? 'DELAYED priority — wound dressing applied, vital signs stable, queued for treatment within 1 hour.'
                  : 'MINOR — walking wounded, self-aid with supervision. Directed to assembly area.',
              `Personnel: 1x Triage Nurse (1:1 assessment ratio).`,
            ].join(' ');
          }
        } else if (status === 'in_treatment') {
          // Ready for transport out of warm zone into cold
          handlingTeam = triageTeam;
          actions = [
            'Prepare for transport',
            'Package patient',
            'Arrange ambulance to cold zone facility',
          ];
          const destLabel = 'cold zone facility';
          description = [
            `Medical Triage preparing ${visDesc} for transport from ${zone.toUpperCase()} ZONE.`,
            `Patient stabilized (triage: ${triageColor?.toUpperCase() || 'ASSESSED'}).`,
            `Arranging ambulance transport to ${destLabel}.`,
            `Personnel: 1x Paramedic escort (1:1 for ${triageColor === 'red' ? 'critical' : 'stable'} transport).`,
          ].join(' ');
        }
      } else if (zone === 'cold' && triageTeam) {
        // COLD zone: transport to hospital
        if (status === 'in_treatment') {
          handlingTeam = triageTeam;
          actions = ['Final assessment', 'Prepare for hospital transport', 'Ambulance dispatch'];
          description = [
            `Medical Triage arranging definitive transport for ${visDesc} from COLD ZONE.`,
            `Patient treated (triage: ${triageColor?.toUpperCase() || 'ASSESSED'}).`,
            `Dispatching ambulance to nearest appropriate hospital.`,
            `Personnel: 1x Paramedic + 1x EMT for transport escort.`,
          ].join(' ');
        } else if (
          status === 'awaiting_triage' ||
          status === 'endorsed_to_triage' ||
          status === 'identified'
        ) {
          handlingTeam = triageTeam;
          const inferColor = this.inferTriageColor(conds);
          assignedTriageColor = inferColor;

          if (inferColor === 'black') {
            actions = ['Confirm no signs of life', 'Assign BLACK tag', 'Cover and document'];
            description = [
              `Medical Triage confirming ${visDesc} in COLD ZONE as EXPECTANT.`,
              'No signs of life after airway check. BLACK tag assigned, body covered and documented.',
              'Moving on to next surviving patient. Coroner notification pending.',
            ].join(' ');
          } else {
            actions = [
              'START Triage Protocol',
              `Assign triage tag: ${inferColor.toUpperCase()}`,
              'Begin definitive treatment',
            ];
            description = [
              `Medical Triage responding to ${visDesc} in COLD ZONE.`,
              `START assessment: assigning ${inferColor.toUpperCase()} triage tag.`,
              `Beginning definitive treatment at cold zone facility.`,
              `Personnel: 1x Triage Nurse + 1x Paramedic.`,
            ].join(' ');
          }
        }
      }

      if (!handlingTeam || actions.length === 0) continue;

      const botUserId = resolveBotUserId(handlingTeam);

      const pinPayload = {
        target_id: casId,
        target_type: targetType,
        target_label: `${visDesc} (${casId.slice(0, 8)})`,
        actions,
        resources: [{ type: 'medic', label: `${handlingTeam} personnel`, quantity: 2 }],
        triage_color: assignedTriageColor as 'green' | 'yellow' | 'red' | 'black' | undefined,
        description,
      };

      await dispatcher.respondToPin(sessionId, botUserId, handlingTeam, pinPayload);

      // Log so we don't double-process next tick
      await supabaseAdmin.from('session_events').insert({
        session_id: sessionId,
        event_type: 'patient_queue_processed',
        description: `Patient queue: ${handlingTeam} → ${visDesc} (${zone} zone, ${status})`,
        actor_id: botUserId,
        metadata: {
          casualty_id: casId,
          team: handlingTeam,
          zone,
          action: actions[0],
          status_before: status,
        },
      });

      if (channelId) {
        const emoji = zone === 'hot' ? '🔴' : zone === 'warm' ? '🟡' : '🔵';
        await dispatcher.sendChatMessage(
          channelId,
          sessionId,
          botUserId,
          `${emoji} ${handlingTeam}: Responding to ${visDesc} in ${zone.toUpperCase()} zone — ${actions.slice(0, 2).join(', ')}. ${assignedTriageColor ? `Triage: ${assignedTriageColor.toUpperCase()}.` : ''}`,
        );
      }

      processed++;

      // Small delay between patients to prevent API flooding
      if (processed < PATIENTS_PER_TICK) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    if (processed > 0) {
      logger.info(
        { sessionId, processed, elapsed: elapsedMinutes },
        'Patient queue: processed patients this tick',
      );
    }
  }

  /**
   * Infer triage color from casualty conditions when no player triage tag exists.
   */
  private inferTriageColor(conds: Record<string, unknown>): string {
    const cat = (conds.triage_category as string)?.toLowerCase();
    if (cat === 'red' || cat === 'immediate') return 'red';
    if (cat === 'yellow' || cat === 'delayed') return 'yellow';
    if (cat === 'black' || cat === 'expectant' || cat === 'deceased') return 'black';
    if (cat === 'green' || cat === 'minor') return 'green';

    // Infer from severity/injury description
    const desc = ((conds.visible_description as string) ?? '').toLowerCase();
    const injury = ((conds.injury_type as string) ?? '').toLowerCase();
    const combined = `${desc} ${injury}`;
    if (/cardiac|arrest|unresponsive|critical|severe.*bleed|amputation|crush/i.test(combined))
      return 'red';
    if (/fracture|burn|moderate|laceration|concussion|blunt.*trauma/i.test(combined))
      return 'yellow';
    if (/deceased|dead|no.*pulse|expectant/i.test(combined)) return 'black';
    return 'green';
  }

  // =========================================================================
  // Deterministic hazard processing queue
  // =========================================================================

  /**
   * Process active hazards each tick. Fire team responds to non-explosive hazards,
   * bomb squad responds to explosive hazards. One hazard per tick per team.
   */
  private async checkHazardQueue(
    sessionId: string,
    scenarioId: string,
    elapsedMinutes: number,
  ): Promise<void> {
    const HAZARD_START_MINUTE = 5;
    if (elapsedMinutes < HAZARD_START_MINUTE) return;

    const { data: hazards } = await supabaseAdmin
      .from('scenario_hazards')
      .select('id, hazard_type, status, location_lat, location_lng, properties')
      .eq('session_id', sessionId)
      .in('status', ['active', 'escalating'])
      .order('created_at', { ascending: true })
      .limit(10);
    if (!hazards?.length) return;

    // Check which hazards already have decisions this session
    const { data: hazardEvents } = await supabaseAdmin
      .from('session_events')
      .select('metadata')
      .eq('session_id', sessionId)
      .eq('event_type', 'hazard_queue_processed');
    const processedHazards = new Set<string>();
    for (const ev of hazardEvents ?? []) {
      const meta = ev.metadata as Record<string, unknown> | null;
      if (meta?.hazard_id) processedHazards.add(meta.hazard_id as string);
    }

    const { data: allTeams } = await supabaseAdmin
      .from('scenario_teams')
      .select('team_name')
      .eq('scenario_id', scenarioId);
    const teamNames = (allTeams ?? []).map(
      (t) => (t as Record<string, unknown>).team_name as string,
    );
    const fireTeam = teamNames.find((n) => /fire|hazard|rescue/i.test(n) && !/bomb/i.test(n));
    const bombTeam = teamNames.find((n) => /bomb|eod/i.test(n));

    const dispatcher = new DemoActionDispatcher();
    const channelId = await dispatcher.getSessionChannelId(sessionId);

    let fireProcessed = false;
    let bombProcessed = false;

    for (const haz of hazards as Array<Record<string, unknown>>) {
      const hazId = haz.id as string;
      if (processedHazards.has(hazId)) continue;

      const hazardType = (haz.hazard_type as string) || '';
      const isExplosive = /bomb|explosive|ied|detonat|suspicious.*package/i.test(hazardType);
      const props = (haz.properties ?? {}) as Record<string, unknown>;
      const propDesc = (props.description as string) || '';
      const lat = Number(haz.location_lat);
      const lng = Number(haz.location_lng);

      let handlingTeam: string | null = null;
      let actions: string[] = [];
      let description = '';

      if (isExplosive && bombTeam && !bombProcessed) {
        handlingTeam = bombTeam;
        bombProcessed = true;
        actions = [
          'Establish exclusion zone',
          'Deploy EOD robot for examination',
          'Initiate render safe procedure',
        ];
        description = [
          `Bomb Squad responding to ${hazardType.replace(/_/g, ' ')} at [${lat.toFixed(5)}, ${lng.toFixed(5)}].`,
          propDesc ? `Assessment: ${propDesc}.` : '',
          `Establishing 100m exclusion zone. Deploying remote-operated vehicle for initial examination.`,
          `Personnel: 4x EOD operators, 1x EDD handler.`,
        ]
          .filter(Boolean)
          .join(' ');
      } else if (!isExplosive && fireTeam && !fireProcessed) {
        handlingTeam = fireTeam;
        fireProcessed = true;

        const isFireHazard = /fire|blaze|smoke|flame/i.test(hazardType);
        const isHazmat = /hazmat|chemical|spill|gas|toxic/i.test(hazardType);
        const isCollapse = /collapse|structural|debris/i.test(hazardType);

        if (isFireHazard) {
          actions = ['Deploy fire suppression', 'Establish water supply', 'Search & rescue sweep'];
          description = [
            `Hazards / Fire / Rescue responding to ${hazardType.replace(/_/g, ' ')} at [${lat.toFixed(5)}, ${lng.toFixed(5)}].`,
            propDesc ? `Assessment: ${propDesc}.` : '',
            `Deploying 2x BA crews for interior attack. Establishing water relay from nearest hydrant.`,
            `Personnel: 6x Firefighters, 1x Incident Commander.`,
          ]
            .filter(Boolean)
            .join(' ');
        } else if (isHazmat) {
          actions = ['Identify substance', 'Establish decon corridor', 'Contain spill'];
          description = [
            `Hazards / Fire / Rescue responding to HAZMAT incident: ${hazardType.replace(/_/g, ' ')} at [${lat.toFixed(5)}, ${lng.toFixed(5)}].`,
            propDesc ? `Assessment: ${propDesc}.` : '',
            `Deploying HAZMAT crew in Level B PPE. Establishing decontamination corridor downwind.`,
            `Personnel: 4x HAZMAT technicians, 2x Decon specialists.`,
          ]
            .filter(Boolean)
            .join(' ');
        } else if (isCollapse) {
          actions = ['Structural assessment', 'Deploy USAR team', 'Establish shoring'];
          description = [
            `Hazards / Fire / Rescue responding to structural hazard: ${hazardType.replace(/_/g, ' ')} at [${lat.toFixed(5)}, ${lng.toFixed(5)}].`,
            propDesc ? `Assessment: ${propDesc}.` : '',
            `Deploying Urban Search and Rescue team. Structural engineer requested for assessment.`,
            `Personnel: 4x USAR technicians, 2x Heavy rescue operators.`,
          ]
            .filter(Boolean)
            .join(' ');
        } else {
          actions = ['Assess hazard', 'Establish safety perimeter', 'Initiate mitigation'];
          description = [
            `Hazards / Fire / Rescue responding to ${hazardType.replace(/_/g, ' ')} at [${lat.toFixed(5)}, ${lng.toFixed(5)}].`,
            propDesc ? `Assessment: ${propDesc}.` : '',
            `Establishing safety perimeter and initiating hazard mitigation protocol.`,
            `Personnel: 4x Firefighters.`,
          ]
            .filter(Boolean)
            .join(' ');
        }
      }

      if (!handlingTeam || actions.length === 0) continue;

      const botUserId = resolveBotUserId(handlingTeam);

      await dispatcher.respondToPin(sessionId, botUserId, handlingTeam, {
        target_id: hazId,
        target_type: 'hazard',
        target_label: `${hazardType.replace(/_/g, ' ')} (${hazId.slice(0, 8)})`,
        actions,
        resources: [{ type: 'crew', label: `${handlingTeam} crew`, quantity: 4 }],
        description,
      });

      await supabaseAdmin.from('session_events').insert({
        session_id: sessionId,
        event_type: 'hazard_queue_processed',
        description: `Hazard queue: ${handlingTeam} → ${hazardType} (${haz.status})`,
        actor_id: botUserId,
        metadata: {
          hazard_id: hazId,
          team: handlingTeam,
          hazard_type: hazardType,
        },
      });

      if (channelId) {
        await dispatcher.sendChatMessage(
          channelId,
          sessionId,
          botUserId,
          `🔥 ${handlingTeam}: Responding to ${hazardType.replace(/_/g, ' ')} — ${actions.slice(0, 2).join(', ')}.`,
        );
      }

      if (fireProcessed && bombProcessed) break;
    }
  }

  /**
   * Load zone context (war room zones, player zones, incident center) for zone classification.
   */
  private async loadZoneContext(sessionId: string): Promise<{
    warRoomZones: ZoneRadii[];
    playerZones: Array<{
      asset_type: string;
      properties: Record<string, unknown> | null;
      geometry: Record<string, unknown>;
    }>;
    incidentLat: number;
    incidentLng: number;
  }> {
    const [hazResult, areaResult] = await Promise.all([
      supabaseAdmin
        .from('scenario_hazards')
        .select('location_lat, location_lng, zones')
        .eq('session_id', sessionId)
        .in('status', ['active', 'escalating', 'contained'])
        .limit(5),
      supabaseAdmin
        .from('placed_assets')
        .select('asset_type, label, geometry, properties')
        .eq('session_id', sessionId)
        .eq('status', 'active')
        .in('asset_type', ['hazard_zone', 'hot_zone', 'warm_zone', 'cold_zone']),
    ]);

    const hazards = hazResult.data ?? [];
    let incidentLat = 0,
      incidentLng = 0;
    let warRoomZones: ZoneRadii[] = [];

    if (hazards.length > 0) {
      for (const h of hazards) {
        incidentLat += Number(h.location_lat);
        incidentLng += Number(h.location_lng);
      }
      incidentLat /= hazards.length;
      incidentLng /= hazards.length;
      warRoomZones =
        hazards.map((h) => (h.zones ?? []) as ZoneRadii[]).find((z) => z.length > 0) ?? [];
    }

    const playerZones = (areaResult.data ?? []).map((a) => ({
      asset_type: a.asset_type as string,
      properties: a.properties as Record<string, unknown> | null,
      geometry: a.geometry as Record<string, unknown>,
    }));

    return { warRoomZones, playerZones, incidentLat, incidentLng };
  }

  /**
   * Check for live suspicious_package hazards whose detonation deadline has passed.
   * When timer expires: mark as escalating, spawn explosion effects, fire friction inject.
   */
  private async checkDetonationTimers(
    sessionId: string,
    scenarioId: string,
    trainerId: string,
  ): Promise<void> {
    const now = new Date();
    const { data: expiredDevices } = await supabaseAdmin
      .from('scenario_hazards')
      .select('id, location_lat, location_lng, properties, detonation_deadline')
      .eq('session_id', sessionId)
      .eq('hazard_type', 'suspicious_package')
      .eq('status', 'active')
      .not('detonation_deadline', 'is', null);

    if (!expiredDevices || expiredDevices.length === 0) return;

    for (const device of expiredDevices) {
      const deadline = new Date((device as Record<string, unknown>).detonation_deadline as string);
      if (deadline > now) continue;

      const props = (device as Record<string, unknown>).properties as Record<string, unknown>;
      if (props?.is_live !== true) continue;

      const lat = (device as Record<string, unknown>).location_lat as number;
      const lng = (device as Record<string, unknown>).location_lng as number;
      const containerType = (props.container_type as string) ?? 'unknown';

      // Mark the device as escalated
      await supabaseAdmin
        .from('scenario_hazards')
        .update({ status: 'escalating', detonation_deadline: null })
        .eq('id', device.id);

      // Spawn explosion hazard at same location
      await supabaseAdmin.from('scenario_hazards').insert({
        scenario_id: scenarioId,
        session_id: sessionId,
        hazard_type: 'secondary_explosion',
        location_lat: lat,
        location_lng: lng,
        floor_level: 'G',
        properties: {
          source_device_id: device.id,
          container_type: containerType,
          estimated_yield: props.estimated_yield ?? 'medium',
        },
        assessment_criteria: ['assess_damage', 'search_rescue', 'fire_suppression'],
        status: 'active',
        appears_at_minutes: 0,
      });

      // Spawn blast casualties (3-5 victims within 50m)
      const METER_TO_DEG = 1 / 111_320;
      const casualtyCount = 3 + Math.floor(Math.random() * 3);
      const newCasualties = [];
      for (let i = 0; i < casualtyCount; i++) {
        const angle = Math.random() * 2 * Math.PI;
        const dist = 5 + Math.random() * 45;
        const cLat = lat + Math.cos(angle) * dist * METER_TO_DEG;
        const cLng =
          lng + Math.sin(angle) * dist * METER_TO_DEG * (1 / Math.cos((lat * Math.PI) / 180));
        const severity = i < 1 ? 'red' : i < 3 ? 'yellow' : 'green';
        newCasualties.push({
          scenario_id: scenarioId,
          session_id: sessionId,
          casualty_type: 'patient',
          location_lat: cLat,
          location_lng: cLng,
          floor_level: 'G',
          headcount: 1,
          conditions: {
            triage_category: severity,
            mechanism_of_injury: 'secondary_explosion',
            spawned_by_detonation: device.id,
          },
          status: 'undiscovered',
          appears_at_minutes: 0,
        });
      }
      await supabaseAdmin.from('scenario_casualties').insert(newCasualties);

      // Broadcast detonation event
      const ws = getWebSocketService();
      ws.broadcastToSession(sessionId, {
        type: 'device_detonated',
        data: {
          device_id: device.id,
          lat,
          lng,
          container_type: containerType,
          casualties_spawned: casualtyCount,
        },
        timestamp: now.toISOString(),
      });

      // Fire universal inject — a detonation affects all teams
      const { data: allTeams } = await supabaseAdmin
        .from('scenario_teams')
        .select('team_name')
        .eq('scenario_id', scenarioId);
      const allTeamNames = (allTeams ?? []).map(
        (t) => (t as Record<string, unknown>).team_name as string,
      );

      const { data: detonationInject } = await supabaseAdmin
        .from('scenario_injects')
        .insert({
          scenario_id: scenarioId,
          session_id: sessionId,
          title: `DEVICE DETONATED — Secondary explosion`,
          content: `A ${containerType.replace(/_/g, ' ')} device has detonated, causing ${casualtyCount} additional casualties and significant structural damage. The bomb squad failed to render the device safe in time. All teams must reassess their operational areas immediately. Expect mass casualty surge, structural collapse risk, and secondary hazards.`,
          type: 'field_update',
          severity: 'critical',
          inject_scope: 'universal',
          target_teams: allTeamNames,
          trigger_time_minutes: null,
          ai_generated: true,
          generation_source: 'deterioration_cycle',
        })
        .select('id')
        .single();

      if (detonationInject) {
        if (!this.io) {
          const { io } = await import('../index.js');
          this.io = io;
        }
        if (this.io) {
          await publishInjectToSession(detonationInject.id, sessionId, trainerId, this.io);
        }
      }

      logger.warn(
        { sessionId, deviceId: device.id, containerType, casualties: casualtyCount },
        'Live device detonated — timer expired',
      );
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
