import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { publishInjectToSession } from '../routes/injects.js';
import { shouldCancelScheduledInject } from './aiService.js';
import { updateTeamHeatMeter } from './heatMeterService.js';
import { runGateEvaluationForSession } from './gateEvaluationService.js';
import { mergeStateWithInjectEffects } from './injectPublishEffectsService.js';
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
import {
  evaluateInjectConditions,
  type EvaluationContext,
  type ConditionsToAppear,
  type ConditionsToCancel,
} from './conditionEvaluatorService.js';
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
          'id, scenario_id, start_time, trainer_id, status, current_state, inject_state_effects',
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
        evacuated_count: liveCounters.evacuation.total_evacuated,
        total_evacuated: liveCounters.evacuation.total_evacuated,
        civilians_at_assembly: liveCounters.evacuation.civilians_at_assembly,
        still_inside: liveCounters.evacuation.still_inside,
        in_transit: liveCounters.evacuation.in_transit,
        convergent_crowds_count: liveCounters.evacuation.convergent_crowds_count,
      };

      // Merge triage counters
      const triageState = (nextState.triage_state as Record<string, unknown>) ?? {};
      (nextState.triage_state as Record<string, unknown>) = {
        ...triageState,
        awaiting_triage: liveCounters.triage.awaiting_triage,
        in_treatment: liveCounters.triage.in_treatment,
        patients_being_treated: liveCounters.triage.in_treatment,
        red_immediate: liveCounters.triage.red_immediate,
        yellow_delayed: liveCounters.triage.yellow_delayed,
        green_minor: liveCounters.triage.green_minor,
        ready_for_transport: liveCounters.triage.ready_for_transport,
        transported: liveCounters.triage.transported,
        handed_over_to_hospital: liveCounters.triage.transported,
        deaths_on_site: liveCounters.triage.deaths_on_site,
        casualties: liveCounters.triage.deaths_on_site,
        patients_waiting: liveCounters.triage.awaiting_triage,
      };

      // Merge fire/rescue counters
      const fireState = (nextState.fire_rescue_state as Record<string, unknown>) ?? {};
      (nextState.fire_rescue_state as Record<string, unknown>) = {
        ...fireState,
        active_fires: liveCounters.fire_rescue.active_fires,
        fires_contained: liveCounters.fire_rescue.fires_contained,
        fires_resolved: liveCounters.fire_rescue.fires_resolved,
        casualties_in_hot_zone: liveCounters.fire_rescue.casualties_in_hot_zone,
        extracted_to_warm: liveCounters.fire_rescue.extracted_to_warm,
        debris_cleared: liveCounters.fire_rescue.debris_cleared,
      };

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
    const { data: injectsRaw, error: injectsError } = await supabaseAdmin
      .from('scenario_injects')
      .select(
        'id, trigger_time_minutes, title, content, required_gate_id, required_gate_not_met_id, target_teams, inject_scope',
      )
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

          const cancelled = await runAiCancellationGate(
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

    // --- Condition-based injects: evaluate conditions, pass through AI gate, publish ---
    try {
      const { data: condInjectsRaw } = await supabaseAdmin
        .from('scenario_injects')
        .select(
          'id, title, content, severity, target_teams, inject_scope, conditions_to_appear, conditions_to_cancel, eligible_after_minutes, state_effect',
        )
        .eq('scenario_id', session.scenario_id)
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
