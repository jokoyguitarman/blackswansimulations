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
import type { Server as SocketServer } from 'socket.io';
import type { CounterDefinition } from '../counterDefinitions.js';

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

/**
 * Sum of impact scores where the affected team matches the given key (case-insensitive).
 * Used to penalize evacuation rate, triage band, and media sentiment when other teams hurt this one.
 */
function incomingImpactOn(
  matrix: Record<string, Record<string, number>> | null | undefined,
  affectedTeamKey: string,
): number {
  if (!matrix || typeof matrix !== 'object') return 0;
  const keyLower = affectedTeamKey.toLowerCase();
  let sum = 0;
  for (const [acting, affectedMap] of Object.entries(matrix)) {
    if (typeof affectedMap !== 'object' || affectedMap === null) continue;
    if (acting.toLowerCase() === keyLower) continue; // exclude self
    for (const [affected, score] of Object.entries(affectedMap)) {
      if (affected.toLowerCase() === keyLower && typeof score === 'number') {
        sum += score;
      }
    }
  }
  return sum;
}

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

    // Phase 6 (optional): time-based state updates — set surge_active at T+10, supply_level at T+15 if no supply decision
    // Merge inject_state_effects so counters see bomb-related state changes
    const rawState = (session.current_state as Record<string, unknown>) || {};
    const injectEffects = (session.inject_state_effects as Record<string, unknown>) || {};
    const currentState = mergeStateWithInjectEffects(rawState, injectEffects);
    const nextState: Record<string, unknown> = { ...currentState };
    let stateChanged = false;

    // Fetch latest impact matrix for robustness-based rate modulation (evac and triage) and incoming-impact penalties
    let robustnessByTeam: Record<string, number> = {};
    let impactMatrix: Record<string, Record<string, number>> = {};
    const { data: latestMatrix } = await supabaseAdmin
      .from('session_impact_matrix')
      .select('robustness_by_team, matrix')
      .eq('session_id', session.id)
      .order('evaluated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestMatrix?.robustness_by_team && typeof latestMatrix.robustness_by_team === 'object') {
      robustnessByTeam = latestMatrix.robustness_by_team as Record<string, number>;
    }
    if (latestMatrix?.matrix && typeof latestMatrix.matrix === 'object') {
      impactMatrix = latestMatrix.matrix as Record<string, Record<string, number>>;
    }

    // Route-effect pressure: recent decisions with slow/congested route apply penalty to evac rate and triage band
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: recentDecisionsWithRoute } = await supabaseAdmin
      .from('decisions')
      .select('id, environmental_consistency')
      .eq('session_id', session.id)
      .eq('status', 'executed')
      .gte('executed_at', fiveMinutesAgo);
    const hasSuboptimalRoute = (recentDecisionsWithRoute ?? []).some((d) => {
      const ec = (d as { environmental_consistency?: { route_effect?: string } })
        .environmental_consistency;
      const re = ec?.route_effect;
      return re === 'slow' || re === 'congested';
    });

    const triageState = (nextState.triage_state as Record<string, unknown>) || {};
    if (elapsedMinutes >= 10 && triageState.surge_active !== true) {
      (nextState.triage_state as Record<string, unknown>) = { ...triageState, surge_active: true };
      stateChanged = true;
    }
    const triageAfterSurge = (nextState.triage_state as Record<string, unknown>) || {};
    if (
      elapsedMinutes >= 15 &&
      triageAfterSurge.supply_request_made !== true &&
      triageAfterSurge.supply_level !== 'critical'
    ) {
      (nextState.triage_state as Record<string, unknown>) = {
        ...triageAfterSurge,
        supply_level: 'low',
      };
      stateChanged = true;
    }
    // --- Generic counter engine (data-driven from counter_definitions) ---
    const counterDefsMap = (nextState._counter_definitions ?? {}) as Record<
      string,
      CounterDefinition[]
    >;
    const hasCounterDefs = Object.keys(counterDefsMap).length > 0;

    const nowIso = new Date().toISOString();
    const counterTicks = (nextState._counter_ticks as Record<string, string>) ?? {};

    if (hasCounterDefs) {
      for (const [stateKey, defs] of Object.entries(counterDefsMap)) {
        const teamState = (nextState[stateKey] as Record<string, unknown>) ?? {};
        const teamNameRaw = stateKey.replace(/_state$/, '');

        // Resolve team robustness (try Title-case and lowercase)
        const teamRobustness =
          robustnessByTeam[teamNameRaw.charAt(0).toUpperCase() + teamNameRaw.slice(1)] ??
          robustnessByTeam[teamNameRaw] ??
          null;

        // Delta-based accumulation: compute minutes since last tick for this team
        const lastTickIso = counterTicks[stateKey];
        const lastTickMs = lastTickIso ? new Date(lastTickIso).getTime() : 0;
        const nowMs = Date.now();
        const tickDeltaMinutes =
          lastTickMs > 0 ? Math.max(0, (nowMs - lastTickMs) / 60000) : elapsedMinutes;
        counterTicks[stateKey] = nowIso;

        // Process time_rate counters (delta-based accumulation)
        for (const def of defs) {
          if (def.behavior !== 'time_rate' || def.type !== 'number') continue;
          const cfg = def.config ?? {};

          if (cfg.requires_flag && teamState[cfg.requires_flag] !== true) continue;

          let rate = cfg.base_rate_per_min ?? 10;

          // Robustness modifier
          if (
            cfg.robustness_affects &&
            teamRobustness !== null &&
            typeof teamRobustness === 'number'
          ) {
            const lowMult = cfg.robustness_low_mult ?? 0.25;
            const highMult = cfg.robustness_high_mult ?? 1.25;
            const mod = teamRobustness <= 4 ? lowMult : teamRobustness >= 8 ? highMult : 1;
            rate = rate * mod;
          }

          // Congestion penalty
          if (cfg.congestion_halves) {
            const exitsCongested = teamState.exits_congested as string[] | undefined;
            const managedEffects =
              (nextState.managed_effects as Record<string, { managed?: boolean }> | undefined) ??
              {};
            const hasUnmanagedCongestion =
              Array.isArray(exitsCongested) &&
              exitsCongested.some((e) => {
                if (typeof e !== 'string' || !e.trim()) return false;
                const key = `${teamNameRaw}.exits_congested:${e.trim()}`;
                return managedEffects[key]?.managed !== true;
              });
            if (hasUnmanagedCongestion) rate = Math.floor(rate / 2);
          }

          // Cross-team impact penalty
          if (cfg.impact_sensitive) {
            const incoming = incomingImpactOn(impactMatrix, teamNameRaw);
            if (incoming < 0) {
              rate = rate * Math.max(0.5, 1 + incoming * 0.15);
            }
          }

          // Route pressure
          if (hasSuboptimalRoute) {
            rate = rate * 0.85;
          }

          // Inject-driven rate modifier (e.g. equipment failure → 0.5, extra resources → 1.3)
          if (cfg.rate_modifier_key) {
            const modifier = Number(teamState[cfg.rate_modifier_key]);
            if (modifier > 0) rate = rate * modifier;
          }

          // Marshal/steward boost (e.g. marshals_deployed → 1.15x)
          if (cfg.marshal_boost_key && teamState[cfg.marshal_boost_key] === true) {
            rate = rate * (cfg.marshal_boost_mult ?? 1.15);
          }

          // Delta-based accumulation: add rate * tickDelta to current value
          const cap = cfg.cap_key ? Math.max(0, Number(teamState[cfg.cap_key]) || 0) : Infinity;
          const curVal = Math.max(0, Number(teamState[def.key]) || 0);
          const delta = Math.max(0, Math.floor(rate * tickDeltaMinutes));
          const newVal = Math.min(cap === Infinity ? Infinity : cap, curVal + delta);
          if (newVal > curVal) {
            teamState[def.key] = newVal;
            stateChanged = true;
          }
        }

        // Process derived counters (with robustness-driven split fractions)
        for (const def of defs) {
          if (def.behavior !== 'derived' || def.type !== 'number') continue;
          const cfg = def.config ?? {};

          if (cfg.source_pool_key && cfg.split_fractions) {
            const poolVal = Math.max(0, Number(teamState[cfg.source_pool_key]) || 0);
            const pool = cfg.pool_fraction ? Math.floor(poolVal * cfg.pool_fraction) : poolVal;

            const processedKey = cfg.rate_key;
            const processed = processedKey
              ? Math.min(pool, Math.max(0, Number(teamState[processedKey]) || 0))
              : pool;

            // Select split fractions based on team robustness band
            let activeSplits = cfg.split_fractions;
            if (teamRobustness !== null && typeof teamRobustness === 'number') {
              if (teamRobustness <= 4 && cfg.split_fractions_low) {
                activeSplits = cfg.split_fractions_low;
              } else if (teamRobustness >= 8 && cfg.split_fractions_high) {
                activeSplits = cfg.split_fractions_high;
              }
            }

            for (const [fracKey, frac] of Object.entries(activeSplits)) {
              const derivedVal = Math.floor(processed * (frac as number));
              teamState[fracKey] = derivedVal;
            }
            teamState[def.key] = Math.max(0, pool - processed);
            stateChanged = true;
          }
        }

        nextState[stateKey] = teamState;
      }
      nextState._counter_ticks = counterTicks;
    } else {
      // Legacy hardcoded evacuation/triage counter logic (backward compatibility)
      // Uses delta-based accumulation (same approach as data-driven engine above)
      const legacyLastTickIso = counterTicks._legacy;
      const legacyLastTickMs = legacyLastTickIso ? new Date(legacyLastTickIso).getTime() : 0;
      const legacyNowMs = Date.now();
      const legacyTickDelta =
        legacyLastTickMs > 0
          ? Math.max(0, (legacyNowMs - legacyLastTickMs) / 60000)
          : elapsedMinutes;
      counterTicks._legacy = nowIso;
      nextState._counter_ticks = counterTicks;

      const BASE_EVAC_RATE_PER_MIN = 40;
      const evacState = (nextState.evacuation_state as Record<string, unknown>) || {};
      const totalEvacuees = Math.max(0, Number(evacState.total_evacuees) || 1000);
      if (evacState.flow_control_decided === true) {
        let rate = BASE_EVAC_RATE_PER_MIN;
        const exitsCongested = evacState.exits_congested as string[] | undefined;
        const managedEffects =
          (nextState.managed_effects as Record<string, { managed?: boolean }> | undefined) ?? {};
        const hasUnmanagedCongestedExit =
          Array.isArray(exitsCongested) &&
          exitsCongested.some((e) => {
            if (typeof e !== 'string' || !e.trim()) return false;
            const key = `evacuation.exits_congested:${e.trim()}`;
            return managedEffects[key]?.managed !== true;
          });
        if (hasUnmanagedCongestedExit) rate = Math.floor(rate / 2);
        const evacRobustness = robustnessByTeam.Evacuation ?? robustnessByTeam.evacuation ?? null;
        if (evacRobustness !== null && typeof evacRobustness === 'number') {
          const mod = evacRobustness <= 7 ? 0.25 : evacRobustness >= 8 ? 1.25 : 1;
          rate = rate * mod;
        }
        const incomingOnEvac = incomingImpactOn(impactMatrix, 'evacuation');
        if (incomingOnEvac < 0) {
          rate = rate * Math.max(0.5, 1 + incomingOnEvac * 0.15);
        }
        if (hasSuboptimalRoute) {
          rate = rate * 0.85;
        }
        const currentEvacuated = Math.max(0, Number(evacState.evacuated_count) || 0);
        const evacDelta = Math.max(0, Math.floor(rate * legacyTickDelta));
        const evacuated = Math.min(totalEvacuees, currentEvacuated + evacDelta);
        if (evacuated > currentEvacuated) {
          (nextState.evacuation_state as Record<string, unknown>) = {
            ...evacState,
            evacuated_count: evacuated,
          };
          stateChanged = true;
        }
      }

      const triageStateNext = (nextState.triage_state as Record<string, unknown>) || {};
      const pool =
        typeof triageStateNext.initial_patients_at_site === 'number'
          ? Math.max(0, triageStateNext.initial_patients_at_site)
          : Math.max(0, Math.floor(totalEvacuees * 0.25));
      const baseRobustness = robustnessByTeam.Triage ?? robustnessByTeam.triage ?? 5.5;
      const boost = (triageStateNext.robustness_boost as number) ?? 0;
      const triageRobustness = Math.max(1, Math.min(10, baseRobustness + boost));
      let band: 'low' | 'mid' | 'high' =
        triageRobustness <= 4 ? 'low' : triageRobustness <= 7 ? 'mid' : 'high';
      const incomingOnTriage = incomingImpactOn(impactMatrix, 'triage');
      if (incomingOnTriage < 0 && band === 'high') band = 'mid';
      else if (incomingOnTriage < 0 && band === 'mid') band = 'low';
      if (hasSuboptimalRoute && band === 'high') band = 'mid';
      else if (hasSuboptimalRoute && band === 'mid') band = 'low';
      const BASE_TRIAGE_PROCESSED_PER_MIN = 8;
      const throughputMult = band === 'low' ? 0.5 : band === 'high' ? 1.25 : 1;
      const triageRate = BASE_TRIAGE_PROCESSED_PER_MIN * throughputMult;
      const prevProcessed = Math.max(
        0,
        (Number(triageStateNext.deaths_on_site) || 0) +
          (Number(triageStateNext.handed_over_to_hospital) || 0) +
          (Number(triageStateNext.patients_being_treated) || 0),
      );
      const triageDelta = Math.max(0, Math.floor(triageRate * legacyTickDelta));
      const processed = Math.min(pool, prevProcessed + triageDelta);
      const deathFrac = band === 'low' ? 0.25 : band === 'high' ? 0.05 : 0.12;
      const deaths = Math.min(processed, Math.floor(processed * deathFrac));
      const remaining = processed - deaths;
      const transportFrac = band === 'low' ? 0.2 : band === 'high' ? 0.6 : 0.4;
      const handedOver = Math.floor(remaining * transportFrac);
      const beingTreated = Math.max(0, remaining - handedOver);
      const patientsWaiting = Math.max(0, pool - processed);
      (nextState.triage_state as Record<string, unknown>) = {
        ...triageStateNext,
        deaths_on_site: deaths,
        handed_over_to_hospital: handedOver,
        patients_being_treated: beingTreated,
        patients_waiting: patientsWaiting,
        casualties: deaths,
      };
      stateChanged = true;
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
