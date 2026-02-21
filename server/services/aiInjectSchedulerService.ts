import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import {
  generateInjectFromDecision,
  computeInterTeamImpactMatrix,
  identifyEscalationFactors,
  identifyDeEscalationFactors,
  generateEscalationPathways,
  generateDeEscalationPathways,
} from './aiService.js';
import { publishInjectToSession } from '../routes/injects.js';
import { env } from '../env.js';
import type { Server as SocketServer } from 'socket.io';

/**
 * AI Inject Scheduler Service
 * Runs every 5 minutes to generate:
 * 1. Universal injects based on all recent decisions and state (visible to all)
 * 2. Team-specific injects based on decisions from each team (visible only to that team)
 */
export class AIInjectSchedulerService {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private readonly checkIntervalMs = 5 * 60 * 1000; // 5 minutes
  private io: SocketServer | null = null;

  constructor(io?: SocketServer) {
    this.io = io || null;
    logger.info(
      {
        intervalMs: this.checkIntervalMs,
        intervalMinutes: 5,
      },
      'AIInjectSchedulerService initialized',
    );
  }

  /**
   * Start the scheduler
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('AIInjectSchedulerService is already running');
      return;
    }

    if (!env.openAiApiKey) {
      logger.warn('OpenAI API key not configured, AI inject scheduler will not run');
      return;
    }

    this.isRunning = true;
    // Run immediately on start, then every 5 minutes
    this.checkAndGenerateInjects();
    this.intervalId = setInterval(() => {
      this.checkAndGenerateInjects();
    }, this.checkIntervalMs);

    logger.info('AIInjectSchedulerService started (runs every 5 minutes)');
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
    logger.info('AIInjectSchedulerService stopped');
  }

  /**
   * Check active sessions and generate AI injects based on recent activity
   */
  private async checkAndGenerateInjects(): Promise<void> {
    try {
      // Get all active sessions
      const { data: sessions, error: sessionsError } = await supabaseAdmin
        .from('sessions')
        .select('id, scenario_id, start_time, trainer_id, status, current_state')
        .eq('status', 'in_progress')
        .not('start_time', 'is', null);

      if (sessionsError) {
        logger.error(
          { error: sessionsError },
          'Failed to fetch active sessions for AI inject generation',
        );
        return;
      }

      if (!sessions || sessions.length === 0) {
        logger.debug('No active sessions found for AI inject generation');
        return;
      }

      logger.info({ sessionCount: sessions.length }, 'Checking sessions for AI inject generation');

      // Process each session
      for (const session of sessions) {
        try {
          await this.processSessionForAIInjects(session);
        } catch (sessionErr) {
          logger.error(
            { error: sessionErr, sessionId: session.id },
            'Error processing session for AI inject generation',
          );
          // Continue with next session even if one fails
        }
      }
    } catch (err) {
      logger.error({ error: err }, 'Error in checkAndGenerateInjects');
    }
  }

  /**
   * Process a single session to generate universal and team-specific AI injects
   */
  private async processSessionForAIInjects(session: {
    id: string;
    scenario_id: string;
    start_time: string;
    trainer_id: string;
    status: string;
    current_state: Record<string, unknown> | null;
  }): Promise<void> {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    // Get all decisions made in the last 5 minutes
    const { data: recentDecisions, error: decisionsError } = await supabaseAdmin
      .from('decisions')
      .select(
        'id, title, description, type, proposed_by, executed_at, ai_classification, creator:user_profiles!decisions_proposed_by_fkey(id, full_name)',
      )
      .eq('session_id', session.id)
      .eq('status', 'executed')
      .gte('executed_at', fiveMinutesAgo)
      .order('executed_at', { ascending: false });

    if (decisionsError) {
      logger.error(
        { error: decisionsError, sessionId: session.id },
        'Failed to fetch recent decisions for AI inject generation',
      );
      return;
    }

    // Checkpoint 6: Run full cycle even with zero decisions (matrix row every cycle; no-decision case = all absent)
    const hasDecisions = (recentDecisions?.length ?? 0) > 0;
    if (hasDecisions) {
      logger.info(
        { sessionId: session.id, recentDecisionsCount: recentDecisions!.length },
        'Found executed decisions in last 5 minutes',
      );
    } else {
      logger.debug(
        { sessionId: session.id },
        'No decisions in last 5 minutes; running cycle for factors/pathways and matrix row (all absent)',
      );
    }

    // CONTEXT: Get injects published in the last 5 minutes (for AI context, not for triggering)
    const { data: recentInjects, error: injectsError } = await supabaseAdmin
      .from('session_events')
      .select('metadata, created_at')
      .eq('session_id', session.id)
      .eq('event_type', 'inject')
      .gte('created_at', fiveMinutesAgo)
      .order('created_at', { ascending: false });

    if (injectsError) {
      logger.warn(
        { error: injectsError, sessionId: session.id },
        'Failed to fetch recent injects for context (continuing anyway)',
      );
      // Don't return - we can still generate injects without this context
    }

    if (hasDecisions) {
      logger.info(
        {
          sessionId: session.id,
          recentDecisionsCount: recentDecisions!.length,
          recentInjectsCount: recentInjects?.length || 0,
        },
        'Generating AI injects (recent injects included for context)',
      );
    }

    // Calculate session duration
    const sessionStart = new Date(session.start_time);
    const now = new Date();
    const sessionDurationMinutes = Math.floor(
      (now.getTime() - sessionStart.getTime()) / (1000 * 60),
    );

    // Get scenario info
    const { data: scenario } = await supabaseAdmin
      .from('scenarios')
      .select('id, title, description')
      .eq('id', session.scenario_id)
      .single();

    // Get upcoming injects
    const { data: upcomingInjects } = await supabaseAdmin
      .from('scenario_injects')
      .select('trigger_time_minutes, type, title, content, severity')
      .eq('scenario_id', session.scenario_id)
      .not('trigger_time_minutes', 'is', null)
      .gt('trigger_time_minutes', sessionDurationMinutes)
      .order('trigger_time_minutes', { ascending: true })
      .limit(10);

    // Get objectives
    const { data: objectives } = await supabaseAdmin
      .from('scenario_objective_progress')
      .select('objective_id, objective_name, status, progress_percentage')
      .eq('session_id', session.id);

    // Get participants
    const { data: participants } = await supabaseAdmin
      .from('session_participants')
      .select('user_id, role')
      .eq('session_id', session.id);

    // Get team assignments
    const { data: teamAssignments } = await supabaseAdmin
      .from('session_teams')
      .select('user_id, team_name')
      .eq('session_id', session.id);

    // Format recent decisions with team info
    const formattedDecisions = (recentDecisions || []).map((d: Record<string, unknown>) => {
      const userId = d.proposed_by as string;
      const userTeam = teamAssignments?.find(
        (ta: { user_id: string; team_name: string }) => ta.user_id === userId,
      );

      return {
        id: d.id as string,
        title: d.title as string,
        description: d.description as string,
        type: d.type as string,
        proposed_by: userId,
        proposed_by_name: (d.creator as { full_name?: string } | null)?.full_name,
        team: userTeam?.team_name || null,
        executed_at: d.executed_at as string,
        ai_classification: (d.ai_classification as Record<string, unknown> | null) || undefined,
      };
    });

    // Format recent injects
    const formattedInjects = (recentInjects || []).map((e: Record<string, unknown>) => {
      const metadata = e.metadata as Record<string, unknown> | null;
      return {
        type: (metadata?.type as string) || 'unknown',
        title: (metadata?.title as string) || 'Unknown',
        content: (metadata?.content as string) || '',
        published_at: e.created_at as string,
      };
    });

    // Get unique teams that have members (all teams in session for taxonomy)
    const teamsWithMembers = new Set(
      teamAssignments?.map((ta: { team_name: string }) => ta.team_name) || [],
    );
    const allTeams = Array.from(teamsWithMembers);
    // Response taxonomy: "textual" if team had executed decision in window, else "absent"
    const responseTaxonomy: Record<string, 'textual' | 'absent'> = {};
    for (const team of allTeams) {
      responseTaxonomy[team] = formattedDecisions.some(
        (d: { team: string | null }) => d.team === team,
      )
        ? 'textual'
        : 'absent';
    }

    // Build base context (used for both universal and team-specific injects)
    const baseContext = {
      scenarioDescription: scenario?.description,
      recentDecisions: formattedDecisions,
      recentInjects: formattedInjects,
      sessionDurationMinutes,
      upcomingInjects: upcomingInjects || [],
      currentState: session.current_state || {},
      objectives: objectives || [],
      participants: participants || [],
      teams: Array.from(teamsWithMembers),
    };

    // Stage 2/3: Recompute escalation factors and pathways every 5-min cycle from current state and injects in last 5 minutes (Checkpoint 6)
    let escalationFactorsSnapshot: Array<{
      id: string;
      name: string;
      description: string;
      severity: string;
    }> = [];
    let escalationPathwaysSnapshot: Array<{
      pathway_id: string;
      trajectory: string;
      trigger_behaviours: string[];
    }> = [];
    let deEscalationFactorsSnapshot: Array<{
      id: string;
      name: string;
      description: string;
    }> = [];
    let deEscalationPathwaysSnapshot: Array<{
      pathway_id: string;
      trajectory: string;
      mitigating_behaviours: string[];
      emerging_challenges?: string[];
    }> = [];
    if (env.openAiApiKey) {
      try {
        const objectivesForFactors = (objectives || []).map(
          (o: { objective_id?: string; objective_name?: string }) => ({
            objective_id: o.objective_id,
            objective_name: o.objective_name,
          }),
        );
        const factorsResult = await identifyEscalationFactors(
          scenario?.description ?? '',
          session.current_state ?? {},
          objectivesForFactors,
          formattedInjects.map((i: { type?: string; title?: string; content?: string }) => ({
            type: i.type,
            title: i.title,
            content: i.content,
          })),
          env.openAiApiKey,
        );
        escalationFactorsSnapshot = factorsResult.factors;

        let deEscalationFactors: Array<{ id: string; name: string; description: string }> = [];
        try {
          const deEscFactorsResult = await identifyDeEscalationFactors(
            scenario?.description ?? '',
            session.current_state ?? {},
            objectivesForFactors,
            formattedInjects.map((i: { type?: string; title?: string; content?: string }) => ({
              type: i.type,
              title: i.title,
              content: i.content,
            })),
            factorsResult.factors,
            env.openAiApiKey,
          );
          deEscalationFactors = deEscFactorsResult.factors;
          deEscalationFactorsSnapshot = deEscFactorsResult.factors;
        } catch (deEscFactorsErr) {
          logger.warn(
            { error: deEscFactorsErr, sessionId: session.id },
            'Failed to compute de-escalation factors, continuing',
          );
        }

        await supabaseAdmin.from('session_escalation_factors').insert({
          session_id: session.id,
          evaluated_at: new Date().toISOString(),
          factors: factorsResult.factors,
          de_escalation_factors: deEscalationFactors,
        });
        logger.info(
          { sessionId: session.id, factorCount: factorsResult.factors.length },
          'Escalation factors computed and saved',
        );

        try {
          const pathwaysResult = await generateEscalationPathways(
            scenario?.description ?? '',
            session.current_state ?? {},
            factorsResult.factors,
            env.openAiApiKey,
          );
          escalationPathwaysSnapshot = pathwaysResult.pathways;

          let deEscalationPathways: Array<{
            pathway_id: string;
            trajectory: string;
            mitigating_behaviours: string[];
            emerging_challenges?: string[];
          }> = [];
          try {
            const deEscPathwaysResult = await generateDeEscalationPathways(
              scenario?.description ?? '',
              session.current_state ?? {},
              pathwaysResult.pathways,
              deEscalationFactorsSnapshot,
              env.openAiApiKey,
            );
            deEscalationPathways = deEscPathwaysResult.pathways;
            deEscalationPathwaysSnapshot = deEscPathwaysResult.pathways;
          } catch (deEscPathwaysErr) {
            logger.warn(
              { error: deEscPathwaysErr, sessionId: session.id },
              'Failed to compute de-escalation pathways, continuing',
            );
          }

          await supabaseAdmin.from('session_escalation_pathways').insert({
            session_id: session.id,
            evaluated_at: new Date().toISOString(),
            pathways: pathwaysResult.pathways,
            de_escalation_pathways: deEscalationPathways,
          });
          logger.info(
            { sessionId: session.id, pathwayCount: pathwaysResult.pathways.length },
            'Escalation pathways computed and saved',
          );
        } catch (pathwaysErr) {
          logger.warn(
            { error: pathwaysErr, sessionId: session.id },
            'Failed to compute or save escalation pathways, continuing',
          );
        }
      } catch (factorsErr) {
        logger.warn(
          { error: factorsErr, sessionId: session.id },
          'Failed to load or compute escalation factors, continuing',
        );
      }
    }

    // Latest impact matrix/factors for inject generation (Checkpoint 8)
    let latestImpactMatrix: Record<string, Record<string, number>> | null = null;
    let latestImpactAnalysis: {
      overall?: string;
      matrix_reasoning?: string;
      robustness_reasoning?: string;
    } | null = null;
    let latestRobustnessByDecision: Record<string, number> | null = null;

    // Inter-team impact matrix: write a row every cycle (Checkpoint 6). With decisions: call AI; without: empty row + response_taxonomy
    if (env.openAiApiKey) {
      try {
        const evaluatedAt = new Date().toISOString();
        const baseInsert = {
          session_id: session.id,
          evaluated_at: evaluatedAt,
          response_taxonomy: Object.keys(responseTaxonomy).length > 0 ? responseTaxonomy : null,
        };

        if (formattedDecisions.length > 0 && teamsWithMembers.size > 0) {
          const teamsArray = Array.from(teamsWithMembers);
          const decisionsWithTeam = formattedDecisions.map((d: Record<string, unknown>) => ({
            decision_id: String(d.id),
            title: String(d.title ?? ''),
            description: String(d.description ?? ''),
            type: (d.type as string) ?? null,
            team: (d.team as string) ?? null,
          }));
          const impactResult = await computeInterTeamImpactMatrix(
            teamsArray,
            decisionsWithTeam,
            env.openAiApiKey,
            scenario?.description,
            escalationFactorsSnapshot.length > 0 ? escalationFactorsSnapshot : undefined,
            escalationPathwaysSnapshot.length > 0 ? escalationPathwaysSnapshot : undefined,
            Object.keys(responseTaxonomy).length > 0 ? responseTaxonomy : undefined,
          );
          latestImpactMatrix = impactResult.matrix;
          latestImpactAnalysis = impactResult.analysis ?? null;
          latestRobustnessByDecision = impactResult.robustnessByDecisionId ?? null;
          await supabaseAdmin.from('session_impact_matrix').insert({
            ...baseInsert,
            matrix: impactResult.matrix,
            robustness_by_decision: impactResult.robustnessByDecisionId ?? {},
            escalation_factors_snapshot:
              escalationFactorsSnapshot.length > 0 ? escalationFactorsSnapshot : null,
            analysis: impactResult.analysis ?? null,
          });
          logger.info(
            {
              sessionId: session.id,
              teamCount: teamsArray.length,
              decisionCount: formattedDecisions.length,
            },
            'Inter-team impact matrix computed and saved',
          );
        } else {
          await supabaseAdmin.from('session_impact_matrix').insert({
            ...baseInsert,
            matrix: {},
            robustness_by_decision: {},
            escalation_factors_snapshot:
              escalationFactorsSnapshot.length > 0 ? escalationFactorsSnapshot : null,
            analysis: null,
          });
          logger.info(
            { sessionId: session.id, taxonomy: responseTaxonomy },
            'Impact matrix row written (no decisions in window)',
          );
        }
      } catch (matrixErr) {
        logger.warn(
          { error: matrixErr, sessionId: session.id },
          'Failed to compute or save impact matrix, continuing with inject generation',
        );
      }
    }

    // Enrich context for inject generation with matrix and escalation data (Checkpoint 8)
    Object.assign(baseContext, {
      latestImpactMatrix: latestImpactMatrix ?? undefined,
      latestImpactAnalysis: latestImpactAnalysis ?? undefined,
      latestRobustnessByDecision: latestRobustnessByDecision ?? undefined,
      escalationFactors:
        escalationFactorsSnapshot.length > 0 ? escalationFactorsSnapshot : undefined,
      escalationPathways:
        escalationPathwaysSnapshot.length > 0 ? escalationPathwaysSnapshot : undefined,
      deEscalationFactors:
        deEscalationFactorsSnapshot.length > 0 ? deEscalationFactorsSnapshot : undefined,
      deEscalationPathways:
        deEscalationPathwaysSnapshot.length > 0 ? deEscalationPathwaysSnapshot : undefined,
      responseTaxonomy: Object.keys(responseTaxonomy).length > 0 ? responseTaxonomy : undefined,
    });

    // 1. Generate UNIVERSAL inject and 2. TEAM-SPECIFIC injects only when there are decisions (Checkpoint 6)
    if (formattedDecisions.length > 0) {
      await this.generateUniversalInject(session, baseContext, formattedDecisions);

      for (const teamName of teamsWithMembers) {
        const teamDecisions = formattedDecisions.filter((d) => d.team === teamName);
        if (teamDecisions.length > 0) {
          await this.generateTeamSpecificInject(session, baseContext, teamName, teamDecisions);
        }
      }
    }
  }

  /**
   * Generate a universal inject visible to all players
   */
  private async generateUniversalInject(
    session: { id: string; scenario_id: string; trainer_id: string },
    context: Record<string, unknown>,
    allDecisions: Array<Record<string, unknown>>,
  ): Promise<void> {
    const primaryDecision = allDecisions[0] || {
      id: 'aggregated',
      title: 'Recent Activity Summary',
      description: `Based on ${allDecisions.length} decisions and ${(context.recentInjects as Array<unknown>)?.length || 0} injects in the last 5 minutes`,
      type: 'coordination_order',
    };

    // Enhanced context for universal inject
    const universalContext = {
      ...context,
      injectType: 'universal',
      focus: 'overall_state',
      instructions:
        'Generate a general/universal inject that reflects the overall state of play and all decisions made. This should be visible to all players and provide a high-level view of the situation.',
    } as typeof context & {
      injectType: string;
      focus: string;
      instructions: string;
    };

    const generatedInject = await generateInjectFromDecision(
      {
        title: primaryDecision.title as string,
        description: primaryDecision.description as string,
        type: primaryDecision.type as string,
      },
      universalContext as Parameters<typeof generateInjectFromDecision>[1],
      env.openAiApiKey!,
    );

    if (!generatedInject) {
      logger.debug({ sessionId: session.id }, 'AI determined no universal inject needed');
      return;
    }

    // Force universal scope
    const { data: createdInject, error: createError } = await supabaseAdmin
      .from('scenario_injects')
      .insert({
        scenario_id: session.scenario_id,
        trigger_time_minutes: null,
        trigger_condition: null,
        type: generatedInject.type,
        title: generatedInject.title,
        content: generatedInject.content,
        severity: generatedInject.severity,
        affected_roles: generatedInject.affected_roles || [],
        inject_scope: 'universal', // Force universal
        target_teams: null, // Not team-specific
        requires_response: generatedInject.requires_response ?? false,
        requires_coordination: generatedInject.requires_coordination ?? false,
        ai_generated: true,
        triggered_by_user_id: null, // Universal, not tied to a specific user
      })
      .select()
      .single();

    if (createError || !createdInject) {
      logger.error(
        { error: createError, sessionId: session.id },
        'Failed to create universal AI-generated inject',
      );
      return;
    }

    // Publish the inject
    if (!this.io) {
      const { io } = await import('../index.js');
      this.io = io;
    }

    await publishInjectToSession(createdInject.id, session.id, session.trainer_id, this.io);

    logger.info(
      {
        sessionId: session.id,
        injectId: createdInject.id,
        scope: 'universal',
        basedOnDecisions: allDecisions.length,
      },
      'Universal AI inject generated and published',
    );
  }

  /**
   * Generate a team-specific inject visible only to members of that team
   */
  private async generateTeamSpecificInject(
    session: { id: string; scenario_id: string; trainer_id: string },
    context: Record<string, unknown>,
    teamName: string,
    teamDecisions: Array<Record<string, unknown>>,
  ): Promise<void> {
    const primaryDecision = teamDecisions[0] || {
      id: 'team_aggregated',
      title: `Team ${teamName} Activity Summary`,
      description: `Based on ${teamDecisions.length} decisions from team ${teamName} in the last 5 minutes`,
      type: 'coordination_order',
    };

    // Enhanced context for team-specific inject
    const teamContext = {
      ...context,
      injectType: 'team_specific',
      focus: 'team_actions',
      teamName: teamName,
      teamDecisions: teamDecisions,
      instructions: `Generate a detailed, team-specific inject for ${teamName} based on decisions made by team members. This should be more specific and detailed than the universal inject, focusing on the consequences and implications of this team's actions. Only visible to ${teamName} members.`,
    } as typeof context & {
      injectType: string;
      focus: string;
      teamName: string;
      teamDecisions: Array<Record<string, unknown>>;
      instructions: string;
    };

    const generatedInject = await generateInjectFromDecision(
      {
        title: primaryDecision.title as string,
        description: primaryDecision.description as string,
        type: primaryDecision.type as string,
      },
      teamContext as Parameters<typeof generateInjectFromDecision>[1],
      env.openAiApiKey!,
    );

    if (!generatedInject) {
      logger.debug(
        { sessionId: session.id, teamName },
        'AI determined no team-specific inject needed',
      );
      return;
    }

    // Force team-specific scope
    const { data: createdInject, error: createError } = await supabaseAdmin
      .from('scenario_injects')
      .insert({
        scenario_id: session.scenario_id,
        trigger_time_minutes: null,
        trigger_condition: null,
        type: generatedInject.type,
        title: generatedInject.title,
        content: generatedInject.content,
        severity: generatedInject.severity,
        affected_roles: generatedInject.affected_roles || [],
        inject_scope: 'team_specific', // Force team-specific
        target_teams: [teamName], // Only this team
        requires_response: generatedInject.requires_response ?? false,
        requires_coordination: generatedInject.requires_coordination ?? false,
        ai_generated: true,
        triggered_by_user_id: null, // Team-based, not user-based
      })
      .select()
      .single();

    if (createError || !createdInject) {
      logger.error(
        { error: createError, sessionId: session.id, teamName },
        'Failed to create team-specific AI-generated inject',
      );
      return;
    }

    // Publish the inject
    if (!this.io) {
      const { io } = await import('../index.js');
      this.io = io;
    }

    await publishInjectToSession(createdInject.id, session.id, session.trainer_id, this.io);

    logger.info(
      {
        sessionId: session.id,
        injectId: createdInject.id,
        scope: 'team_specific',
        teamName: teamName,
        basedOnDecisions: teamDecisions.length,
      },
      'Team-specific AI inject generated and published',
    );
  }
}

// Singleton instance
let schedulerInstance: AIInjectSchedulerService | null = null;

export function initializeAIInjectScheduler(io?: SocketServer): AIInjectSchedulerService {
  if (!schedulerInstance) {
    schedulerInstance = new AIInjectSchedulerService(io);
  }
  return schedulerInstance;
}

export function getAIInjectScheduler(): AIInjectSchedulerService | null {
  return schedulerInstance;
}
