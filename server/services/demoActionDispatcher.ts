import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from './websocketService.js';
import { logAndBroadcastEvent } from './eventService.js';
import { validatePlacement } from './placementValidationService.js';
import { evaluatePlacement } from './spatialScoringService.js';
import { evaluatePinResolution } from './pinResolutionService.js';
import {
  updateStateOnDecisionExecution,
  updateTeamStateFromDecision,
} from './scenarioStateService.js';
import { classifyDecision, shouldCancelScheduledInject } from './aiService.js';
import { evaluateAllObjectivesForSession } from './objectiveTrackingService.js';
import { evaluateDecisionBasedTriggers } from './injectTriggerService.js';
import {
  updateTeamHeatMeter,
  selectAndPublishPathwayOutcome,
  nudgePublicSentiment,
} from './heatMeterService.js';
import { evaluateDecisionAgainstEnvironment } from './environmentalConsistencyService.js';
import { evaluateEnvironmentalPrerequisite } from './environmentalPrerequisiteService.js';
import {
  evaluateEnvironmentalManagementIntentAndUpdateState,
  recordSpaceClaim,
} from './environmentalConditionManagementService.js';
import { evaluateStateEffectManagementAndUpdateState } from './stateEffectManagementService.js';
import { applyDecisionCasualtyEffects } from './decisionCasualtyEffectsService.js';
import { evaluateTransportOutcome } from './transportOutcomeService.js';
import { publishInjectToSession } from '../routes/injects.js';
import { env } from '../env.js';
import { io } from '../index.js';

/**
 * Fixed UUIDs for demo bot users (must match migration 147).
 */
export const DEMO_BOT_IDS = {
  police: 'a0000000-de00-b000-0001-000000000001',
  triage: 'a0000000-de00-b000-0001-000000000002',
  evacuation: 'a0000000-de00-b000-0001-000000000003',
  media: 'a0000000-de00-b000-0001-000000000004',
  fire: 'a0000000-de00-b000-0001-000000000005',
  intelligence: 'a0000000-de00-b000-0001-000000000006',
  negotiation: 'a0000000-de00-b000-0001-000000000007',
  security: 'a0000000-de00-b000-0001-000000000008',
  trainer: 'a0000000-de00-b000-0001-000000000099',
} as const;

const BOT_TEAM_KEYWORDS: Record<string, keyof typeof DEMO_BOT_IDS> = {
  police: 'police',
  triage: 'triage',
  medical: 'triage',
  health: 'triage',
  evacuation: 'evacuation',
  civil: 'evacuation',
  media: 'media',
  press: 'media',
  fire: 'fire',
  hazmat: 'fire',
  fire_hazmat: 'fire',
  intelligence: 'intelligence',
  intel: 'intelligence',
  negotiation: 'negotiation',
  hostage: 'negotiation',
  security: 'security',
  mall_security: 'security',
  resort_security: 'security',
  bomb_squad: 'police',
  close_protection: 'police',
  event_security: 'security',
  crowd_management: 'evacuation',
  transit_security: 'security',
  public_health: 'triage',
  operations: 'evacuation',
};

/**
 * Resolve a team name from the scenario to a bot user UUID.
 */
export function resolveBotUserId(teamName: string): string {
  const key = teamName.toLowerCase().replace(/[\s-]+/g, '_');
  for (const [keyword, botKey] of Object.entries(BOT_TEAM_KEYWORDS)) {
    if (key.includes(keyword) || keyword.includes(key)) {
      return DEMO_BOT_IDS[botKey];
    }
  }
  return DEMO_BOT_IDS.police;
}

/**
 * Resolve the participant role string expected by session_participants.
 */
export function resolveBotRole(teamName: string): string {
  const key = teamName.toLowerCase();
  if (key.includes('police') || key.includes('bomb') || key.includes('close_protection'))
    return 'police_commander';
  if (
    key.includes('triage') ||
    key.includes('medical') ||
    key.includes('health') ||
    key.includes('public_health')
  )
    return 'health_director';
  if (key.includes('media') || key.includes('press')) return 'public_information_officer';
  if (key.includes('intelligence') || key.includes('intel')) return 'intelligence_analyst';
  if (key.includes('fire') || key.includes('hazmat')) return 'defence_liaison';
  if (key.includes('negotiation') || key.includes('hostage')) return 'police_commander';
  if (
    key.includes('evacuation') ||
    key.includes('civil') ||
    key.includes('crowd') ||
    key.includes('operations')
  )
    return 'civil_government';
  if (key.includes('security')) return 'defence_liaison';
  return 'civil_government';
}

export class DemoActionDispatcher {
  // Sequential queue for background evaluation to prevent OpenAI rate-limit flooding
  private evalQueue: Array<() => Promise<void>> = [];
  private evalRunning = false;

  private enqueueEvaluation(task: () => Promise<void>): void {
    this.evalQueue.push(task);
    if (!this.evalRunning) this.drainEvalQueue();
  }

  private async drainEvalQueue(): Promise<void> {
    if (this.evalRunning) return;
    this.evalRunning = true;
    while (this.evalQueue.length > 0) {
      const task = this.evalQueue.shift()!;
      try {
        await task();
      } catch (err) {
        logger.error({ error: err }, 'Demo: queued evaluation task failed');
      }
      // Small breathing room between evaluations to avoid API bursts
      await new Promise((r) => setTimeout(r, 2000));
    }
    this.evalRunning = false;
  }

  /**
   * Insert a decision row, mark it executed, broadcast, and fire background processing.
   */
  async proposeAndExecuteDecision(
    sessionId: string,
    botUserId: string,
    payload: {
      title: string;
      description: string;
      decision_type?: string;
      response_to_incident_id?: string;
    },
  ): Promise<string | null> {
    try {
      const title = payload.title.trim().slice(0, 200) || payload.description.trim().slice(0, 80);

      const { data: decision, error: insertErr } = await supabaseAdmin
        .from('decisions')
        .insert({
          session_id: sessionId,
          proposed_by: botUserId,
          response_to_incident_id: payload.response_to_incident_id || null,
          title,
          description: payload.description,
          type: null,
          status: 'proposed',
        })
        .select()
        .single();

      if (insertErr || !decision) {
        logger.error({ error: insertErr, sessionId }, 'Demo: failed to create decision');
        return null;
      }

      // Immediately execute (bots auto-execute their own proposals)
      const { data: executed, error: execErr } = await supabaseAdmin
        .from('decisions')
        .update({ status: 'executed', executed_at: new Date().toISOString() })
        .eq('id', decision.id)
        .eq('status', 'proposed')
        .select('*, creator:user_profiles!decisions_proposed_by_fkey(id, full_name, role)')
        .single();

      if (execErr || !executed) {
        logger.error(
          { error: execErr, decisionId: decision.id },
          'Demo: failed to execute decision',
        );
        return decision.id;
      }

      const mapped = { ...executed, decision_type: executed.type };

      try {
        getWebSocketService().decisionProposed(sessionId, mapped);
      } catch {
        /* ok */
      }
      try {
        getWebSocketService().decisionExecuted(sessionId, mapped);
      } catch {
        /* ok */
      }

      logAndBroadcastEvent(
        io,
        sessionId,
        'decision',
        {
          decision_id: decision.id,
          title: decision.title,
          decision_type: decision.type,
          status: 'executed',
          creator: executed.creator || { id: botUserId },
        },
        botUserId,
      ).catch(() => {});

      // Queue background processing sequentially to avoid OpenAI rate-limit flooding
      this.enqueueEvaluation(() => this.processDecisionBackground(decision.id, executed));

      logger.info({ decisionId: decision.id, botUserId }, 'Demo: decision proposed + executed');
      return decision.id;
    } catch (err) {
      logger.error(
        { error: err, sessionId },
        'Demo: unexpected error in proposeAndExecuteDecision',
      );
      return null;
    }
  }

  /**
   * Background AI processing, mirroring processExecutedDecisionInBackground.
   * Runs state update, AI classification, inject triggers, heat meter.
   */
  private async processDecisionBackground(
    decisionId: string,
    decision: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = decision.session_id as string;
    const botUserId = decision.proposed_by as string;
    const title = (decision.title as string) ?? '';
    const description = (decision.description as string) ?? '';

    // Phase 1: State update (quick DB write)
    try {
      await updateStateOnDecisionExecution(sessionId, {
        id: decisionId,
        decision_type: (decision.type as string) || 'operational_action',
        title,
        description,
        resources_needed: decision.resources_needed as Record<string, unknown> | undefined,
        consequences: decision.consequences as Record<string, unknown> | undefined,
      });
    } catch (err) {
      logger.error({ error: err, decisionId }, 'Demo: state update error');
    }

    if (!env.openAiApiKey) {
      try {
        await supabaseAdmin
          .from('decisions')
          .update({
            environmental_consistency: {
              consistent: true,
              reason: 'Demo bot — no API key, auto-approved',
            },
          })
          .eq('id', decisionId);
      } catch {
        /* best-effort */
      }
      return;
    }

    // Phase 2: AI classification
    let aiClassification: Awaited<ReturnType<typeof classifyDecision>> | null = null;
    try {
      aiClassification = await classifyDecision({ title, description }, env.openAiApiKey);

      await supabaseAdmin
        .from('decisions')
        .update({
          type: (aiClassification as { primary_category?: string }).primary_category,
          ai_classification: aiClassification,
        })
        .eq('id', decisionId);

      logger.info({ decisionId }, 'Demo: classification complete');
    } catch (err) {
      logger.error({ error: err, decisionId }, 'Demo: AI classification failed');
    }

    // Resolve author team + session metadata
    const { data: authorTeams } = await supabaseAdmin
      .from('session_teams')
      .select('team_name')
      .eq('session_id', sessionId)
      .eq('user_id', botUserId);
    const authorTeamNames = (authorTeams ?? []).map((r: { team_name: string }) => r.team_name);
    const teamName = authorTeamNames.length > 0 ? authorTeamNames[0] : null;

    const { data: sessionRow } = await supabaseAdmin
      .from('sessions')
      .select('start_time, scenario_id, trainer_id')
      .eq('id', sessionId)
      .single();
    const sessionScenarioId = (sessionRow as { scenario_id?: string } | null)?.scenario_id ?? null;
    const sessionTrainerId = (sessionRow as { trainer_id?: string } | null)?.trainer_id ?? null;
    const startTime = (sessionRow as { start_time?: string } | null)?.start_time;
    const elapsedMinutes = startTime
      ? Math.floor((Date.now() - new Date(startTime).getTime()) / 60000)
      : 0;

    // Phase 3: Environmental consistency evaluation
    let envResult: Record<string, unknown> = { consistent: true };
    let aiEnvResult: Record<string, unknown> = { consistent: true };
    let prereqResult: Record<string, unknown> | null = null;
    let qualityFailureCount = 0;

    if (authorTeamNames.length > 0) {
      const { data: prevFailEvents } = await supabaseAdmin
        .from('session_events')
        .select('id')
        .eq('session_id', sessionId)
        .eq('event_type', 'quality_failure_inject_fired')
        .filter('metadata->>team', 'eq', authorTeamNames[0]);
      qualityFailureCount = prevFailEvents?.length ?? 0;
    }

    try {
      const decisionForEval = {
        id: decisionId,
        title,
        description,
        type: (decision.type as string) ?? null,
        team_name: teamName ?? undefined,
      };

      const [rawEnvResult, prereqOut] = await Promise.all([
        evaluateDecisionAgainstEnvironment(
          sessionId,
          decisionForEval,
          env.openAiApiKey,
          null,
          teamName ?? undefined,
          qualityFailureCount,
        ),
        evaluateEnvironmentalPrerequisite(sessionId, decisionForEval, undefined, env.openAiApiKey),
      ]);

      aiEnvResult = rawEnvResult as unknown as Record<string, unknown>;
      const { result: pResult, evaluationReason: envPrereqReason } = prereqOut;
      prereqResult = pResult as unknown as Record<string, unknown> | null;
      envResult =
        prereqResult && !(prereqResult as { consistent?: boolean }).consistent
          ? prereqResult
          : (rawEnvResult as unknown as Record<string, unknown>);

      await supabaseAdmin
        .from('decisions')
        .update({ environmental_consistency: envResult })
        .eq('id', decisionId);

      if (envPrereqReason != null) {
        await supabaseAdmin
          .from('decisions')
          .update({ evaluation_reasoning: { env_prerequisite: envPrereqReason } })
          .eq('id', decisionId);
      }

      logger.info(
        {
          decisionId,
          consistent: (envResult as { consistent?: boolean }).consistent,
          mismatch_kind: (envResult as { mismatch_kind?: string }).mismatch_kind ?? null,
          severity: (envResult as { severity?: string }).severity ?? null,
        },
        'Demo: environmental consistency evaluated',
      );
    } catch (err) {
      logger.error({ error: err, decisionId }, 'Demo: environmental evaluation failed');
      try {
        await supabaseAdmin
          .from('decisions')
          .update({
            environmental_consistency: {
              consistent: true,
              reason: 'Demo bot — evaluation failed, auto-approved',
            },
          })
          .eq('id', decisionId);
      } catch {
        /* best-effort */
      }
    }

    // Phase 4: Quality failure injects (specificity / env inconsistency consequences)
    const envC = envResult as {
      consistent?: boolean;
      specific?: boolean;
      feedback?: string;
      reason?: string;
      mismatch_kind?: string;
      consequence_title?: string;
      rejected?: boolean;
      rejection_reason?: string;
    };
    const aiEnvC = aiEnvResult as typeof envC;

    type FailureType =
      | 'vague'
      | 'contradiction'
      | 'below_standard'
      | 'prereq'
      | 'rejected'
      | 'infrastructure_gap';
    let failureType: FailureType | null = null;
    let failureContent = '';

    const rejected = envC.rejected === true || aiEnvC.rejected === true;
    const rejectionReason = envC.rejection_reason || aiEnvC.rejection_reason || '';

    if (rejected && rejectionReason) {
      failureType = 'rejected';
      failureContent = rejectionReason;
    } else if (envC.specific === false && envC.feedback) {
      failureType = 'vague';
      failureContent = envC.feedback;
    } else if (!envC.consistent && envC.mismatch_kind === 'infrastructure_gap' && envC.reason) {
      failureType = 'infrastructure_gap';
      failureContent = envC.reason;
    } else if (
      !envC.consistent &&
      envC.mismatch_kind !== 'below_standard' &&
      envC.mismatch_kind !== 'infrastructure_gap' &&
      envC.reason
    ) {
      failureType = 'contradiction';
      failureContent = envC.reason;
    } else if (!envC.consistent && envC.mismatch_kind === 'below_standard' && envC.reason) {
      failureType = 'below_standard';
      failureContent = envC.reason;
    } else if (
      prereqResult &&
      !(prereqResult as { consistent?: boolean }).consistent &&
      (prereqResult as { reason?: string }).reason
    ) {
      failureType = 'prereq';
      failureContent = (prereqResult as { reason?: string }).reason!;
    }

    const FALLBACK_TITLES: Record<FailureType, string> = {
      vague: 'Field report — operational complications',
      contradiction: 'Field report — ground conditions',
      below_standard: 'Field report — standards shortfall',
      prereq: 'Field report — environmental constraint',
      rejected: 'Action cannot be carried out',
      infrastructure_gap: 'Field report — infrastructure not established',
    };

    if (
      failureType &&
      failureContent &&
      authorTeamNames.length > 0 &&
      sessionScenarioId &&
      sessionTrainerId &&
      io
    ) {
      try {
        // Check if prior decisions already addressed this concern
        if (env.openAiApiKey && failureType !== 'rejected') {
          const { data: allDecisionRows } = await supabaseAdmin
            .from('decisions')
            .select('title, description, type')
            .eq('session_id', sessionId)
            .eq('status', 'executed')
            .order('executed_at', { ascending: true })
            .limit(50);
          const allDecisions = (allDecisionRows ?? []).map(
            (d: { title: string; description: string; type: string | null }) => ({
              title: d.title ?? '',
              description: d.description ?? '',
              type: d.type,
            }),
          );

          if (allDecisions.length > 0) {
            try {
              const cancelCheck = await shouldCancelScheduledInject(
                { title: failureContent.slice(0, 200), content: failureContent },
                allDecisions,
                env.openAiApiKey,
              );
              if (cancelCheck.cancel) {
                logger.info(
                  { decisionId, team: authorTeamNames[0], failureType },
                  'Demo: quality failure inject cancelled — decisions addressed concern',
                );
                await updateTeamHeatMeter(sessionId, authorTeamNames[0], 'good');
                failureType = null;
                failureContent = '';
              }
            } catch (cancelErr) {
              logger.warn(
                { err: cancelErr, decisionId },
                'Demo: quality failure cancellation check failed, proceeding',
              );
            }
          }
        }

        if (failureType && failureContent) {
          const escalationIdx = Math.min(qualityFailureCount, 2);
          const injectSeverity: 'medium' | 'high' | 'critical' =
            failureType === 'rejected'
              ? 'critical'
              : escalationIdx >= 2
                ? 'critical'
                : escalationIdx >= 1
                  ? 'high'
                  : 'medium';
          const aiTitle = envC.consequence_title || aiEnvC.consequence_title;
          const titleBase = aiTitle || FALLBACK_TITLES[failureType];
          const injectTitle = `${titleBase} – ${authorTeamNames[0]} (${decisionId.slice(0, 8)})`;

          const { data: qualityInject, error: qualityInsertErr } = await supabaseAdmin
            .from('scenario_injects')
            .insert({
              scenario_id: sessionScenarioId,
              type: 'field_update',
              title: injectTitle,
              content: failureContent,
              severity: injectSeverity,
              inject_scope: 'team_specific',
              target_teams: [authorTeamNames[0]],
              requires_response: true,
              requires_coordination: false,
              ai_generated: true,
              generation_source: 'specificity_feedback',
            })
            .select()
            .single();

          if (qualityInsertErr) {
            logger.warn(
              { err: qualityInsertErr, decisionId, team: authorTeamNames[0] },
              'Demo: quality failure inject insert failed',
            );
          }

          if (qualityInject) {
            await publishInjectToSession(qualityInject.id, sessionId, sessionTrainerId, io);
            await supabaseAdmin.from('session_events').insert({
              session_id: sessionId,
              event_type: 'quality_failure_inject_fired',
              description: `Quality failure (${failureType}) for ${authorTeamNames[0]} (escalation ${qualityFailureCount + 1})`,
              actor_id: null,
              metadata: {
                team: authorTeamNames[0],
                decision_id: decisionId,
                failure_type: failureType,
                escalation: qualityFailureCount + 1,
              },
            });
            logger.info(
              {
                sessionId,
                decisionId,
                team: authorTeamNames[0],
                failureType,
                escalation: qualityFailureCount + 1,
                severity: injectSeverity,
              },
              'Demo: quality failure inject published',
            );
          }
        }
      } catch (qualityErr) {
        logger.warn(
          { err: qualityErr, sessionId, decisionId },
          'Demo: failed to fire quality failure inject',
        );
      }
    }

    // Phase 5: Heat meter with proper mistake classification
    if (teamName) {
      let mistakeType: 'vague' | 'contradiction' | 'prereq' | 'rejected' | 'good' = 'good';
      if (rejected) {
        mistakeType = 'rejected';
      } else if (envC.specific === false) {
        mistakeType = 'vague';
      } else if (!envC.consistent && envC.mismatch_kind === 'infrastructure_gap') {
        mistakeType = 'prereq';
      } else if (
        !envC.consistent &&
        envC.mismatch_kind !== 'below_standard' &&
        envC.mismatch_kind !== 'infrastructure_gap'
      ) {
        mistakeType = 'contradiction';
      } else if (!envC.consistent) {
        mistakeType = 'prereq';
      }

      try {
        const { heat_percentage } = await updateTeamHeatMeter(sessionId, teamName, mistakeType, io);

        // Pathway outcome injects (escalation when heat is high)
        if (sessionScenarioId && sessionTrainerId && io) {
          await selectAndPublishPathwayOutcome(
            sessionId,
            teamName,
            heat_percentage,
            sessionScenarioId,
            sessionTrainerId,
            io,
          );
        }

        // Public sentiment nudge (media team)
        if (teamName === 'media') {
          await nudgePublicSentiment(sessionId, mistakeType);
        }
      } catch (err) {
        logger.error({ error: err, decisionId }, 'Demo: heat meter / pathway / sentiment failed');
      }
    }

    // Phase 6: Team state + inject triggers
    if (aiClassification) {
      try {
        await updateTeamStateFromDecision(
          sessionId,
          decisionId,
          authorTeamNames,
          aiClassification,
          elapsedMinutes,
          {
            decisionTitle: title,
            decisionDescription: description,
            scenarioId: sessionScenarioId ?? undefined,
          },
        );

        if (io && teamName) {
          await evaluateDecisionBasedTriggers(
            sessionId,
            { id: decisionId, title, description },
            aiClassification,
            io,
            teamName,
          );
        }
      } catch (err) {
        logger.error({ error: err, decisionId }, 'Demo: team state / triggers failed');
      }
    }

    // Phase 7: Background tasks (env management, space claims, casualty effects, transport, objectives, events)
    const bgTasks: Promise<unknown>[] = [];

    // Environmental management intent
    bgTasks.push(
      evaluateEnvironmentalManagementIntentAndUpdateState(
        sessionId,
        { id: decisionId, title, description, type: (decision.type as string) ?? null },
        env.openAiApiKey,
      ).catch((err) =>
        logger.error({ error: err, decisionId }, 'Demo: env condition management failed'),
      ),
    );

    // State effect management
    bgTasks.push(
      evaluateStateEffectManagementAndUpdateState(
        sessionId,
        { id: decisionId, title, description },
        env.openAiApiKey,
        botUserId,
      ).catch((err) =>
        logger.error({ error: err, decisionId }, 'Demo: state effect management failed'),
      ),
    );

    // Space claims auto-detection
    if (authorTeamNames.length > 0 && sessionScenarioId) {
      bgTasks.push(
        (async () => {
          const decisionLower = `${title} ${description}`.toLowerCase();
          const { data: scLocations } = await supabaseAdmin
            .from('scenario_locations')
            .select('id, label, conditions')
            .eq('scenario_id', sessionScenarioId);

          if (scLocations && scLocations.length > 0) {
            const assignmentPatterns =
              /\b(set\s+up|establish|designate|use\s+as|deploy\s+at|create|place|position|station\s+at|locate|assign|convert|transform|operate)\b/i;
            if (assignmentPatterns.test(decisionLower)) {
              for (const loc of scLocations) {
                const cond = (loc.conditions as Record<string, unknown>) ?? {};
                const isCandidateSpace =
                  cond.pin_category === 'candidate_space' || Array.isArray(cond.potential_uses);
                if (!isCandidateSpace) continue;

                const label = ((loc.label as string) ?? '').toLowerCase();
                if (!label || !decisionLower.includes(label)) continue;

                const usePatterns: Array<[RegExp, string]> = [
                  [/triage/i, 'triage'],
                  [/command\s*(post|center|centre)/i, 'command_post'],
                  [/staging/i, 'staging'],
                  [/evacuation|assembly/i, 'evacuation_assembly'],
                  [/media/i, 'media_center'],
                  [/negotiation/i, 'negotiation_post'],
                  [/decontamination|decon/i, 'decontamination'],
                  [/morgue|mortuary|casualty\s*collection/i, 'casualty_collection'],
                  [/logistics|supply/i, 'logistics'],
                ];
                let claimedAs = 'designated_area';
                for (const [pattern, name] of usePatterns) {
                  if (pattern.test(decisionLower)) {
                    claimedAs = name;
                    break;
                  }
                }

                const { data: sessionForTime } = await supabaseAdmin
                  .from('sessions')
                  .select('current_state')
                  .eq('id', sessionId)
                  .single();
                const gameMinutes = (
                  (sessionForTime as Record<string, unknown>)?.current_state as Record<
                    string,
                    unknown
                  >
                )?.game_time_minutes as number;

                await recordSpaceClaim(
                  sessionId,
                  loc.id as string,
                  authorTeamNames[0],
                  claimedAs,
                  typeof gameMinutes === 'number' ? gameMinutes : 0,
                  (loc as { label?: string }).label ?? undefined,
                );
                break;
              }
            }
          }
        })().catch((err) =>
          logger.error({ error: err, decisionId }, 'Demo: space claim recording failed'),
        ),
      );
    }

    // Casualty movement effects
    bgTasks.push(
      applyDecisionCasualtyEffects(sessionId, title, description, teamName).catch((err) =>
        logger.error({ error: err, decisionId }, 'Demo: decision casualty effects failed'),
      ),
    );

    // Transport outcome evaluation
    if (authorTeamNames.length > 0 && io) {
      bgTasks.push(
        evaluateTransportOutcome(
          sessionId,
          { id: decisionId, title, description, type: (decision.type as string) ?? null },
          authorTeamNames[0],
          env.openAiApiKey,
          io,
        ).catch((err) =>
          logger.error({ error: err, decisionId }, 'Demo: transport outcome failed'),
        ),
      );
    }

    // Objectives evaluation
    bgTasks.push(
      evaluateAllObjectivesForSession(sessionId, env.openAiApiKey).catch((err) =>
        logger.error({ error: err, decisionId }, 'Demo: objective evaluation failed'),
      ),
    );

    // Event logging
    if (io) {
      bgTasks.push(
        logAndBroadcastEvent(
          io,
          sessionId,
          'decision_executed',
          { decision_id: decisionId, title, description, team: teamName ?? 'unknown' },
          botUserId,
        ).catch((err) => logger.error({ error: err, decisionId }, 'Demo: event logging failed')),
      );
    }

    await Promise.allSettled(bgTasks);
  }

  /**
   * Create a placement on the map (Point, LineString, or Polygon).
   */
  async createPlacement(
    sessionId: string,
    botUserId: string,
    payload: {
      team_name: string;
      asset_type: string;
      label: string;
      geometry: { type: string; coordinates: unknown };
      properties?: Record<string, unknown>;
    },
  ): Promise<string | null> {
    try {
      const { team_name, asset_type, label, geometry, properties } = payload;

      const validation = await validatePlacement(
        sessionId,
        team_name,
        asset_type,
        geometry as Record<string, unknown>,
        properties ?? {},
      );

      if (!validation.valid) {
        logger.warn(
          { sessionId, asset_type, blocks: validation.blocks },
          'Demo: placement blocked by validation',
        );
        // For demo purposes, proceed anyway by skipping validation
      }

      const spatialScore = await evaluatePlacement(
        sessionId,
        team_name,
        asset_type,
        geometry as Record<string, unknown>,
      );

      const { data: placement, error } = await supabaseAdmin
        .from('placed_assets')
        .insert({
          session_id: sessionId,
          team_name,
          placed_by: botUserId,
          asset_type,
          label: label || asset_type.replace(/_/g, ' '),
          geometry,
          properties: properties ?? {},
          placement_score: {
            ...(validation.valid ? validation.score_modifiers : {}),
            overall: spatialScore.overall,
            dimensions: spatialScore.dimensions,
          },
        })
        .select()
        .single();

      if (error || !placement) {
        logger.error({ error, sessionId, asset_type }, 'Demo: failed to create placement');
        return null;
      }

      try {
        getWebSocketService().broadcastToSession(sessionId, {
          type: 'placement.created',
          data: { placement, warnings: validation.warnings ?? [] },
          timestamp: new Date().toISOString(),
        });
      } catch {
        /* non-blocking */
      }

      evaluatePinResolution(sessionId).catch(() => {});

      logger.info({ placementId: placement.id, asset_type, team_name }, 'Demo: placement created');
      return placement.id;
    } catch (err) {
      logger.error({ error: err, sessionId }, 'Demo: unexpected error in createPlacement');
      return null;
    }
  }

  /**
   * Send a chat message in a channel.
   */
  async sendChatMessage(
    channelId: string,
    sessionId: string,
    botUserId: string,
    content: string,
    messageType: string = 'text',
  ): Promise<string | null> {
    try {
      const { data: inserted, error: insertErr } = await supabaseAdmin
        .from('chat_messages')
        .insert({
          channel_id: channelId,
          session_id: sessionId,
          sender_id: botUserId,
          content,
          type: messageType,
        })
        .select('*')
        .single();

      if (insertErr || !inserted) {
        logger.error({ error: insertErr, channelId }, 'Demo: failed to insert message');
        return null;
      }

      const { data: fullMsg } = await supabaseAdmin
        .from('chat_messages')
        .select('*, sender:user_profiles!chat_messages_sender_id_fkey(id, full_name, role)')
        .eq('id', inserted.id)
        .single();

      const msg = fullMsg || inserted;

      try {
        getWebSocketService().messageSent(channelId, msg);
      } catch {
        /* ok */
      }

      logAndBroadcastEvent(
        io,
        sessionId,
        'message',
        {
          channel_id: channelId,
          message_id: msg.id,
          sender: msg.sender || { id: botUserId },
          content: msg.content,
        },
        botUserId,
      ).catch(() => {});

      logger.info({ messageId: msg.id, channelId }, 'Demo: chat message sent');
      return msg.id;
    } catch (err) {
      logger.error({ error: err, channelId }, 'Demo: unexpected error in sendChatMessage');
      return null;
    }
  }

  /**
   * Claim a scenario location (exit/entry) for a team.
   */
  async claimLocation(
    sessionId: string,
    locationId: string,
    teamName: string,
    claimedAs: string,
    claimExclusivity?: string,
  ): Promise<boolean> {
    try {
      const { data: existing } = await supabaseAdmin
        .from('session_location_claims')
        .select('id')
        .eq('session_id', sessionId)
        .eq('location_id', locationId)
        .maybeSingle();

      if (existing) {
        logger.debug({ sessionId, locationId }, 'Demo: location already claimed, skipping');
        return false;
      }

      const claimRow: Record<string, unknown> = {
        session_id: sessionId,
        location_id: locationId,
        claimed_by_team: teamName,
        claimed_as: claimedAs,
      };
      if (claimExclusivity === 'exclusive' || claimExclusivity === 'shared') {
        claimRow.claim_exclusivity = claimExclusivity;
      }

      const { error } = await supabaseAdmin.from('session_location_claims').insert(claimRow);
      if (error) {
        logger.warn({ error, sessionId, locationId }, 'Demo: failed to claim location');
        return false;
      }

      const { data: loc } = await supabaseAdmin
        .from('scenario_locations')
        .select('*')
        .eq('id', locationId)
        .single();

      if (loc) {
        try {
          getWebSocketService().locationClaimed(sessionId, {
            ...loc,
            claimed_by_team: teamName,
            claimed_as: claimedAs,
            claim_exclusivity: claimExclusivity ?? null,
          });
        } catch {
          /* ok */
        }
      }

      logger.info({ sessionId, locationId, teamName, claimedAs }, 'Demo: location claimed');
      return true;
    } catch (err) {
      logger.error({ error: err, sessionId, locationId }, 'Demo: claimLocation error');
      return false;
    }
  }

  /**
   * Respond to a map pin (casualty or hazard). Creates a decision, updates
   * the pin status, optionally triage-tags a casualty, and broadcasts a
   * `demo.pin_response` event so spectator UIs can animate the panel.
   */
  async respondToPin(
    sessionId: string,
    botUserId: string,
    teamName: string,
    payload: {
      target_id: string;
      target_type: 'casualty' | 'hazard';
      target_label: string;
      actions: string[];
      resources: Array<{ type: string; label: string; quantity: number }>;
      triage_color?: 'green' | 'yellow' | 'red' | 'black';
      description: string;
    },
  ): Promise<string | null> {
    try {
      const typeLabel = payload.target_type === 'casualty' ? 'Casualty' : 'Hazard';
      const parts: string[] = [];
      if (payload.actions.length > 0) parts.push(`Actions: ${payload.actions.join(', ')}`);
      if (payload.resources.length > 0) {
        parts.push(
          `Resources: ${payload.resources.map((r) => `${r.quantity}x ${r.label}`).join(', ')}`,
        );
      }
      if (payload.triage_color) parts.push(`Triage tag: ${payload.triage_color.toUpperCase()}`);
      if (payload.description) parts.push(payload.description);

      const title = `Response to ${payload.target_label} by ${teamName}`;
      const description = `[${typeLabel} Response: ${payload.target_label}] ${parts.join('. ')}`;

      const decisionId = await this.proposeAndExecuteDecision(sessionId, botUserId, {
        title,
        description,
      });

      // Update casualty/hazard status in DB
      if (payload.target_type === 'casualty') {
        const updates: Record<string, unknown> = {
          updated_at: new Date().toISOString(),
          assigned_team: teamName,
        };

        if (payload.triage_color) {
          updates.player_triage_color = payload.triage_color;
          updates.assessed_by = teamName;
        }

        // Progress the status
        const { data: current } = await supabaseAdmin
          .from('scenario_casualties')
          .select('status')
          .eq('id', payload.target_id)
          .single();

        if (current) {
          const statusProgression: Record<string, string> = {
            undiscovered: 'identified',
            identified: 'endorsed_to_triage',
            endorsed_to_triage: 'in_treatment',
          };
          const currentStatus = current.status as string;
          if (statusProgression[currentStatus]) {
            updates.status = statusProgression[currentStatus];
          }
        }

        await supabaseAdmin.from('scenario_casualties').update(updates).eq('id', payload.target_id);
      } else {
        // Hazard: mark as being_mitigated or contained
        await supabaseAdmin
          .from('scenario_hazards')
          .update({
            status: 'being_mitigated',
            updated_at: new Date().toISOString(),
          })
          .eq('id', payload.target_id)
          .in('status', ['active', 'escalating']);
      }

      // Broadcast demo.pin_response so spectator UI can animate the panel
      try {
        getWebSocketService().broadcastToSession(sessionId, {
          type: 'demo.pin_response',
          data: {
            bot_user_id: botUserId,
            team_name: teamName,
            decision_id: decisionId,
            target_id: payload.target_id,
            target_type: payload.target_type,
            target_label: payload.target_label,
            actions: payload.actions,
            resources: payload.resources,
            triage_color: payload.triage_color || null,
            description: payload.description,
          },
          timestamp: new Date().toISOString(),
        });
      } catch {
        /* broadcast is best-effort */
      }

      logger.info(
        {
          sessionId,
          targetType: payload.target_type,
          targetId: payload.target_id,
          teamName,
          triageColor: payload.triage_color,
        },
        'Demo: pin response executed',
      );

      return decisionId;
    } catch (err) {
      logger.error({ error: err, sessionId }, 'Demo: respondToPin error');
      return null;
    }
  }

  /**
   * Find the main (inter_agency or public) channel for a session that a team can post in.
   */
  async getSessionChannelId(sessionId: string): Promise<string | null> {
    const { data: channels } = await supabaseAdmin
      .from('chat_channels')
      .select('id, type, name')
      .eq('session_id', sessionId)
      .in('type', ['inter_agency', 'public', 'command'])
      .order('created_at', { ascending: true })
      .limit(1);

    return channels?.[0]?.id ?? null;
  }
}
