import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import {
  generateInjectFromDecision,
  computeInterTeamImpactMatrix,
  computePublicSentiment,
  aggregateThemeUsage,
  computeDecisionsSummaryLine,
  type ThemeUsageByScope,
  type ThemeUsageEntry,
  type PathwayOutcome,
} from './aiService.js';
import { publishInjectToSession } from '../routes/injects.js';
import { env } from '../env.js';
import { getWebSocketService } from './websocketService.js';
import type { Server as SocketServer } from 'socket.io';

/**
 * Compute per-team average robustness from decisions in the window.
 * Used for evac/triage rate modulation in the inject scheduler.
 */
function computeRobustnessByTeam(
  formattedDecisions: Array<{ id: string; team?: string | null }>,
  robustnessByDecisionId: Record<string, number>,
): Record<string, number> {
  const byTeam: Record<string, number[]> = {};
  for (const d of formattedDecisions) {
    const team = d.team ?? 'Unknown';
    if (!team) continue;
    const score = robustnessByDecisionId[String(d.id)];
    if (typeof score !== 'number') continue;
    if (!byTeam[team]) byTeam[team] = [];
    byTeam[team].push(score);
  }
  const result: Record<string, number> = {};
  for (const [team, scores] of Object.entries(byTeam)) {
    if (scores.length === 0) continue;
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    result[team] = Math.round(avg * 10) / 10;
  }
  return result;
}

/**
 * Apply Checkpoint 2 robustness cap: decisions marked environmentally inconsistent
 * (contradiction: high severity -> cap 3, medium -> cap 6; below_standard -> cap 6 only).
 */
async function applyEnvironmentalConsistencyCap(
  robustnessByDecisionId: Record<string, number> | null,
  decisionIds: string[],
  sessionId: string,
): Promise<Record<string, number> | null> {
  if (
    !robustnessByDecisionId ||
    Object.keys(robustnessByDecisionId).length === 0 ||
    decisionIds.length === 0
  )
    return robustnessByDecisionId;
  const { data: rows } = await supabaseAdmin
    .from('decisions')
    .select('id, environmental_consistency')
    .eq('session_id', sessionId)
    .in('id', decisionIds);
  type EnvConsistency = {
    consistent?: boolean;
    severity?: string;
    mismatch_kind?: 'contradiction' | 'below_standard';
  };
  const envByDecision = new Map<string, EnvConsistency>();
  for (const row of rows ?? []) {
    const r = row as {
      id: string;
      environmental_consistency?: {
        consistent?: boolean;
        severity?: string;
        mismatch_kind?: string;
      } | null;
    };
    if (r.environmental_consistency && typeof r.environmental_consistency === 'object') {
      const ec = r.environmental_consistency;
      const kind =
        ec.mismatch_kind === 'below_standard'
          ? ('below_standard' as const)
          : ec.mismatch_kind === 'contradiction'
            ? ('contradiction' as const)
            : undefined;
      envByDecision.set(r.id, {
        consistent: ec.consistent,
        severity: ec.severity,
        mismatch_kind: kind,
      });
    }
  }
  const capped: Record<string, number> = {};
  for (const [id, score] of Object.entries(robustnessByDecisionId)) {
    const env = envByDecision.get(id);
    if (env?.consistent !== false) {
      capped[id] = score;
      continue;
    }
    if (env.mismatch_kind === 'below_standard') {
      capped[id] = Math.min(score, 6);
      continue;
    }
    if (env?.severity === 'high') capped[id] = Math.min(score, 3);
    else if (env?.severity === 'medium') capped[id] = Math.min(score, 6);
    else capped[id] = score;
  }
  return capped;
}

/** When session has not_met gates, prefer escalation (low/medium) over de-escalation (high). */
function effectiveRobustnessBand(
  band: 'low' | 'medium' | 'high',
  hasNotMetGates: boolean,
): 'low' | 'medium' | 'high' {
  if (!hasNotMetGates) return band;
  if (band === 'high') return 'medium';
  return band;
}

/**
 * AI Inject Scheduler Service
 * Runs every 5 minutes to generate:
 * 1. Universal injects based on all recent decisions and state (visible to all)
 * 2. Team-specific injects based on decisions from each team (visible only to that team)
 */
/** Map robustness scores (1-10) to band for pathway outcome selection. */
function computeRobustnessBand(
  robustnessByDecision: Record<string, number> | null,
): 'low' | 'medium' | 'high' {
  if (!robustnessByDecision || Object.keys(robustnessByDecision).length === 0) return 'medium';
  const values = Object.values(robustnessByDecision);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean <= 3) return 'low';
  if (mean >= 7) return 'high';
  return 'medium';
}

/**
 * Band from only the given teams' decisions (for team-specific pathway outcomes).
 * If no decisions from those teams, returns 'medium'.
 */
function computeRobustnessBandForTeams(
  robustnessByDecision: Record<string, number> | null,
  decisionsWithTeam: Array<{ id: string; team: string | null }>,
  targetTeams: string[],
): 'low' | 'medium' | 'high' {
  if (!robustnessByDecision || targetTeams.length === 0)
    return computeRobustnessBand(robustnessByDecision);
  const teamSet = new Set(targetTeams);
  const decisionIdsFromTeams = decisionsWithTeam
    .filter((d) => d.team != null && teamSet.has(d.team))
    .map((d) => d.id);
  const values = decisionIdsFromTeams
    .map((id) => robustnessByDecision[id])
    .filter((v): v is number => typeof v === 'number');
  if (values.length === 0) return 'medium';
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean <= 3) return 'low';
  if (mean >= 7) return 'high';
  return 'medium';
}

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
      .select('id, title, description, insider_knowledge')
      .eq('id', session.scenario_id)
      .single();

    const insiderKnowledge = (scenario?.insider_knowledge as Record<string, unknown>) || {};
    const layoutGroundTruth = insiderKnowledge.layout_ground_truth as
      | {
          evacuee_count?: number;
          exits?: Array<{ label?: string; flow_per_min?: number; status?: string }>;
          zones?: Array<{ label?: string; capacity?: number }>;
        }
      | undefined;
    let layoutContext = '';
    if (layoutGroundTruth) {
      const parts: string[] = [];
      if (layoutGroundTruth.evacuee_count != null)
        parts.push(`Evacuees: ${layoutGroundTruth.evacuee_count}`);
      if (layoutGroundTruth.exits?.length)
        parts.push(
          `Exits: ${layoutGroundTruth.exits.map((e) => `${e.label ?? 'Exit'}${e.flow_per_min != null ? ` ${e.flow_per_min}/min` : ''}${e.status ? ` [${e.status}]` : ''}`).join('; ')}`,
        );
      if (layoutGroundTruth.zones?.length)
        parts.push(
          `Zones: ${layoutGroundTruth.zones.map((z) => `${z.label ?? 'Zone'}${z.capacity != null ? ` capacity ${z.capacity}` : ''}`).join('; ')}`,
        );
      if (parts.length > 0) layoutContext = `\n\nLAYOUT GROUND TRUTH: ${parts.join('. ')}`;
    }
    const scenarioDescriptionWithLayout = (scenario?.description ?? '') + layoutContext;

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

    // Format recent injects (last 5 min - for immediate context and impact matrix)
    const formattedInjects = (recentInjects || []).map((e: Record<string, unknown>) => {
      const metadata = e.metadata as Record<string, unknown> | null;
      const targetTeamsRaw = metadata?.target_teams;
      return {
        type: (metadata?.type as string) || 'unknown',
        title: (metadata?.title as string) || 'Unknown',
        content: (metadata?.content as string) || '',
        published_at: e.created_at as string,
        severity: (metadata?.severity as string) || undefined,
        target_teams: Array.isArray(targetTeamsRaw) ? targetTeamsRaw : null,
      };
    });

    // Session-wide theme usage: all injects this session (no 5-min filter) for diversity guidance
    let themeUsageThisSession: Record<string, ThemeUsageEntry> = {};
    let themeUsageByScope: ThemeUsageByScope = {};
    let decisionsSummaryLine = '';
    try {
      const { data: allSessionInjects } = await supabaseAdmin
        .from('session_events')
        .select('metadata')
        .eq('session_id', session.id)
        .eq('event_type', 'inject')
        .order('created_at', { ascending: true });

      if (allSessionInjects && allSessionInjects.length > 0) {
        const injectsForAggregation = allSessionInjects.map((e: Record<string, unknown>) => {
          const metadata = (e.metadata as Record<string, unknown>) || {};
          return {
            title: (metadata.title as string) || '',
            content: (metadata.content as string) || '',
            inject_scope: (metadata.inject_scope as string) || 'universal',
            target_teams: (metadata.target_teams as string[] | null) || null,
          };
        });
        const aggregated = aggregateThemeUsage(injectsForAggregation);
        themeUsageThisSession = aggregated.themeUsageThisSession;
        themeUsageByScope = aggregated.themeUsageByScope;
      }
      decisionsSummaryLine = computeDecisionsSummaryLine(formattedDecisions);
    } catch (themeErr) {
      logger.warn(
        { error: themeErr, sessionId: session.id },
        'Theme usage aggregation failed, continuing without session theme context',
      );
    }

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
      scenarioDescription: scenarioDescriptionWithLayout,
      recentDecisions: formattedDecisions,
      recentInjects: formattedInjects,
      sessionDurationMinutes,
      upcomingInjects: upcomingInjects || [],
      currentState: session.current_state || {},
      objectives: objectives || [],
      participants: participants || [],
      teams: Array.from(teamsWithMembers),
      themeUsageThisSession:
        Object.keys(themeUsageThisSession).length > 0 ? themeUsageThisSession : undefined,
      themeUsageByScope: Object.keys(themeUsageByScope).length > 0 ? themeUsageByScope : undefined,
      decisionsSummaryLine: decisionsSummaryLine || undefined,
    };

    // Load latest escalation factors and pathways (written by pathwayOutcomesService on inject publish)
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
    const { data: latestFactorsRow } = await supabaseAdmin
      .from('session_escalation_factors')
      .select('factors, de_escalation_factors')
      .eq('session_id', session.id)
      .order('evaluated_at', { ascending: false })
      .limit(1)
      .single();
    if (latestFactorsRow) {
      escalationFactorsSnapshot = Array.isArray(latestFactorsRow.factors)
        ? latestFactorsRow.factors
        : [];
      deEscalationFactorsSnapshot = Array.isArray(latestFactorsRow.de_escalation_factors)
        ? latestFactorsRow.de_escalation_factors
        : [];
    }
    if (
      escalationFactorsSnapshot.length === 0 &&
      Array.isArray(insiderKnowledge.baseline_escalation_factors)
    ) {
      escalationFactorsSnapshot = insiderKnowledge.baseline_escalation_factors as Array<{
        id: string;
        name: string;
        description: string;
        severity: string;
      }>;
    }
    const { data: latestPathwaysRow } = await supabaseAdmin
      .from('session_escalation_pathways')
      .select('pathways, de_escalation_pathways')
      .eq('session_id', session.id)
      .order('evaluated_at', { ascending: false })
      .limit(1)
      .single();
    if (latestPathwaysRow) {
      escalationPathwaysSnapshot = Array.isArray(latestPathwaysRow.pathways)
        ? latestPathwaysRow.pathways
        : [];
      deEscalationPathwaysSnapshot = Array.isArray(latestPathwaysRow.de_escalation_pathways)
        ? latestPathwaysRow.de_escalation_pathways
        : [];
    }

    // Latest impact matrix/factors for inject generation (Checkpoint 8)
    let latestImpactMatrix: Record<string, Record<string, number>> | null = null;
    let latestImpactAnalysis: {
      overall?: string;
      matrix_reasoning?: string;
      robustness_reasoning?: string;
      robustness_reasoning_by_decision?: Record<string, string>;
    } | null = null;
    let latestRobustnessByDecision: Record<string, number> | null = null;

    // Inter-team impact matrix: write a row every cycle (Checkpoint 6). With decisions: call AI; without: empty row + response_taxonomy
    if (env.openAiApiKey) {
      try {
        await supabaseAdmin.from('session_events').insert({
          session_id: session.id,
          event_type: 'ai_step_start',
          description: 'AI: Computing inter-team impact matrix…',
          actor_id: null,
          metadata: { step: 'impact_matrix' },
        });
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
          const scenarioContextParts = [
            scenario?.description,
            typeof insiderKnowledge.sector_standards === 'string'
              ? `Sector standards (use to calibrate robustness):\n${insiderKnowledge.sector_standards}`
              : null,
          ].filter(Boolean) as string[];
          const scenarioContext =
            scenarioContextParts.length > 0 ? scenarioContextParts.join('\n\n') : undefined;
          const impactResult = await computeInterTeamImpactMatrix(
            teamsArray,
            decisionsWithTeam,
            env.openAiApiKey,
            scenarioContext,
            escalationFactorsSnapshot.length > 0 ? escalationFactorsSnapshot : undefined,
            escalationPathwaysSnapshot.length > 0 ? escalationPathwaysSnapshot : undefined,
            Object.keys(responseTaxonomy).length > 0 ? responseTaxonomy : undefined,
            formattedInjects.length > 0 ? formattedInjects : undefined,
          );
          const decisionIds = formattedDecisions.map((d: Record<string, unknown>) => String(d.id));
          const cappedRobustness = await applyEnvironmentalConsistencyCap(
            impactResult.robustnessByDecisionId ?? null,
            decisionIds,
            session.id,
          );
          latestImpactMatrix = impactResult.matrix;
          latestImpactAnalysis = impactResult.analysis ?? null;
          latestRobustnessByDecision =
            cappedRobustness ?? impactResult.robustnessByDecisionId ?? null;
          const robustnessByTeam = computeRobustnessByTeam(
            formattedDecisions,
            latestRobustnessByDecision ?? {},
          );
          await supabaseAdmin.from('session_impact_matrix').insert({
            ...baseInsert,
            matrix: impactResult.matrix,
            robustness_by_decision: latestRobustnessByDecision ?? {},
            robustness_by_team: robustnessByTeam,
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
            robustness_by_team: {},
            escalation_factors_snapshot:
              escalationFactorsSnapshot.length > 0 ? escalationFactorsSnapshot : null,
            analysis: null,
          });
          logger.info(
            { sessionId: session.id, taxonomy: responseTaxonomy },
            'Impact matrix row written (no decisions in window)',
          );
        }
        await supabaseAdmin.from('session_events').insert({
          session_id: session.id,
          event_type: 'ai_step_end',
          description: 'AI: Impact matrix computed',
          actor_id: null,
          metadata: { step: 'impact_matrix' },
        });
      } catch (matrixErr) {
        logger.warn(
          { error: matrixErr, sessionId: session.id },
          'Failed to compute or save impact matrix, continuing with inject generation',
        );
      }
    }

    // Public sentiment: AI-backed media_state.public_sentiment from full state and media actions
    try {
      const currentState = (session.current_state as Record<string, unknown>) || {};
      const evac = (currentState.evacuation_state as Record<string, unknown>) || {};
      const triage = (currentState.triage_state as Record<string, unknown>) || {};
      const media = (currentState.media_state as Record<string, unknown>) || {};
      const stateSummary = [
        `Evac: ${evac.evacuated_count ?? 0} / ${evac.total_evacuees ?? 1000} evacuated`,
        `Triage: ${triage.deaths_on_site ?? 0} deaths on site, ${triage.handed_over_to_hospital ?? 0} handed over, ${triage.patients_being_treated ?? 0} being treated, ${triage.patients_waiting ?? 0} waiting`,
        `Recent injects: ${(formattedInjects || [])
          .slice(0, 5)
          .map(
            (i: { title?: string; severity?: string }) =>
              `${i.title ?? '?'} (${i.severity ?? 'N/A'})`,
          )
          .join('; ')}`,
        `Misinformation addressed: ${media.misinformation_addressed ? 'yes' : 'no'}, statements issued: ${media.statements_issued ?? 0}`,
      ].join('. ');
      const mediaSummary = [
        `Statements: ${media.statements_issued ?? 0}, misinformation addressed count: ${media.misinformation_addressed_count ?? 0}`,
        formattedDecisions?.length
          ? `Recent decisions (media-related): ${
              formattedDecisions
                .filter((d: { team?: string | null }) => /media/i.test(String(d.team ?? '')))
                .map(
                  (d: { title?: string; description?: string }) =>
                    `${d.title ?? '?'}: ${(d.description ?? '').slice(0, 80)}...`,
                )
                .join(' | ') || 'none'
            }`
          : '',
      ]
        .filter(Boolean)
        .join('. ');
      const sentimentResult = await computePublicSentiment(
        stateSummary,
        mediaSummary,
        env.openAiApiKey,
      );
      // Incoming impact penalty: other teams hurting media lowers public sentiment (scale 1-10)
      let sentimentToWrite = sentimentResult.public_sentiment;
      if (latestImpactMatrix && typeof latestImpactMatrix === 'object') {
        let incomingOnMedia = 0;
        for (const [acting, affectedMap] of Object.entries(latestImpactMatrix)) {
          if (typeof affectedMap !== 'object' || affectedMap === null) continue;
          if (acting.toLowerCase() === 'media') continue;
          for (const [affected, score] of Object.entries(affectedMap)) {
            if (affected.toLowerCase() === 'media' && typeof score === 'number') {
              incomingOnMedia += score;
            }
          }
        }
        if (incomingOnMedia < 0) {
          sentimentToWrite = Math.max(1, sentimentResult.public_sentiment + incomingOnMedia);
        }
      }
      const { data: sessionForState } = await supabaseAdmin
        .from('sessions')
        .select('current_state')
        .eq('id', session.id)
        .single();
      const latestState = (sessionForState?.current_state as Record<string, unknown>) || {};
      const latestMedia = (latestState.media_state as Record<string, unknown>) || {};
      const nextState = {
        ...latestState,
        media_state: {
          ...latestMedia,
          public_sentiment: sentimentToWrite,
          sentiment_label: sentimentResult.sentiment_label,
          sentiment_reason: sentimentResult.reason,
        },
      };
      await supabaseAdmin
        .from('sessions')
        .update({ current_state: nextState })
        .eq('id', session.id);
      getWebSocketService().stateUpdated?.(session.id, {
        state: nextState,
        timestamp: new Date().toISOString(),
      });
      (session as { current_state?: Record<string, unknown> }).current_state = nextState;
    } catch (sentimentErr) {
      logger.warn(
        { err: sentimentErr, sessionId: session.id },
        'Failed to compute or persist public sentiment',
      );
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

    // When session has not_met gates, bias outcome selection toward escalation (low/medium) over high
    const { data: notMetGates } = await supabaseAdmin
      .from('session_gate_progress')
      .select('gate_id')
      .eq('session_id', session.id)
      .eq('status', 'not_met')
      .limit(1);
    const hasNotMetGates = (notMetGates?.length ?? 0) > 0;

    // Load all pathway outcome rows from the last 5 minutes (one per trigger inject); publish one outcome inject per row
    const { data: pathwayOutcomesRows } = await supabaseAdmin
      .from('session_pathway_outcomes')
      .select('id, outcomes, trigger_inject_id, evaluated_at')
      .eq('session_id', session.id)
      .gte('evaluated_at', fiveMinutesAgo)
      .order('evaluated_at', { ascending: true });

    const rows = (pathwayOutcomesRows ?? []) as Array<{
      id: string;
      outcomes: PathwayOutcome[] | string;
      trigger_inject_id?: string;
      evaluated_at?: string;
    }>;
    const maxPathwayOutcomesPerCycle = 5;
    const rowsToProcess = rows.slice(0, maxPathwayOutcomesPerCycle);

    function parseOutcomes(raw: PathwayOutcome[] | string | null | undefined): PathwayOutcome[] {
      if (Array.isArray(raw)) return raw;
      if (typeof raw === 'string') {
        try {
          const parsed = JSON.parse(raw) as PathwayOutcome[] | PathwayOutcome;
          return Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          return [];
        }
      }
      return [];
    }

    const hasPathwayOutcomes = rowsToProcess.some((r) => parseOutcomes(r.outcomes).length > 0);

    if (formattedDecisions.length > 0) {
      if (hasPathwayOutcomes) {
        // Pathway outcome selection uses only the robustness band (from per-decision robustness scores).
        // Universal/multi-team rows use global band; team_specific rows use band from target_teams only.
        if (!this.io) {
          const { io } = await import('../index.js');
          this.io = io;
        }

        let publishedCount = 0;
        for (const row of rowsToProcess) {
          const outcomes = parseOutcomes(row.outcomes);
          if (outcomes.length === 0) continue;

          const firstOutcome = outcomes[0];
          const scope = (firstOutcome?.inject_payload?.inject_scope as string) ?? 'universal';
          const targetTeamsRaw = firstOutcome?.inject_payload?.target_teams;
          const targetTeams = Array.isArray(targetTeamsRaw) ? targetTeamsRaw : [];

          const useTeamBand = scope === 'team_specific' && targetTeams.length > 0;
          const rawBand = useTeamBand
            ? computeRobustnessBandForTeams(
                latestRobustnessByDecision,
                formattedDecisions,
                targetTeams,
              )
            : computeRobustnessBand(latestRobustnessByDecision);
          const robustnessBand = effectiveRobustnessBand(rawBand, hasNotMetGates);

          if (useTeamBand) {
            logger.debug(
              {
                sessionId: session.id,
                trigger_inject_id: row.trigger_inject_id,
                targetTeams,
                robustnessBand,
              },
              'Pathway outcome row: using team-specific band',
            );
          }

          const matching = outcomes.filter((o) => o.robustness_band === robustnessBand);
          const toPublish =
            matching.length > 0
              ? matching[0]
              : outcomes[Math.floor(Math.random() * outcomes.length)];

          const { data: createdInject, error: createError } = await supabaseAdmin
            .from('scenario_injects')
            .insert({
              scenario_id: session.scenario_id,
              trigger_time_minutes: null,
              trigger_condition: null,
              type: toPublish.inject_payload.type,
              title: toPublish.inject_payload.title,
              content: toPublish.inject_payload.content,
              severity: toPublish.inject_payload.severity,
              affected_roles: toPublish.inject_payload.affected_roles ?? [],
              inject_scope: toPublish.inject_payload.inject_scope ?? 'universal',
              target_teams: toPublish.inject_payload.target_teams ?? null,
              requires_response: toPublish.inject_payload.requires_response === true,
              requires_coordination: false,
              ai_generated: true,
              triggered_by_user_id: null,
            })
            .select()
            .single();

          if (!createError && createdInject) {
            await publishInjectToSession(
              createdInject.id,
              session.id,
              session.trainer_id,
              this.io!,
            );
            publishedCount += 1;
            logger.info(
              {
                sessionId: session.id,
                injectId: createdInject.id,
                robustnessBand,
                outcomeId: toPublish.outcome_id,
                trigger_inject_id: row.trigger_inject_id,
              },
              'Pathway outcome inject published',
            );
          } else {
            logger.warn(
              {
                error: createError,
                sessionId: session.id,
                trigger_inject_id: row.trigger_inject_id,
              },
              'Failed to create outcome inject for row, continuing',
            );
          }
        }

        if (publishedCount === 0) {
          await this.generateUniversalInject(session, baseContext, formattedDecisions);
          for (const teamName of teamsWithMembers) {
            const teamDecisions = formattedDecisions.filter((d) => d.team === teamName);
            if (teamDecisions.length > 0) {
              await this.generateTeamSpecificInject(session, baseContext, teamName, teamDecisions);
            }
          }
        }
      } else {
        // No pathway outcomes yet (e.g. first cycle before any inject published): fallback to generate from decision
        if (env.openAiApiKey) {
          await supabaseAdmin.from('session_events').insert({
            session_id: session.id,
            event_type: 'ai_step_start',
            description: 'AI: Generating injects from decisions…',
            actor_id: null,
            metadata: { step: 'inject_generation' },
          });
        }
        await this.generateUniversalInject(session, baseContext, formattedDecisions);
        for (const teamName of teamsWithMembers) {
          const teamDecisions = formattedDecisions.filter((d) => d.team === teamName);
          if (teamDecisions.length > 0) {
            await this.generateTeamSpecificInject(session, baseContext, teamName, teamDecisions);
          }
        }
        if (env.openAiApiKey) {
          await supabaseAdmin.from('session_events').insert({
            session_id: session.id,
            event_type: 'ai_step_end',
            description: 'AI: Injects generated',
            actor_id: null,
            metadata: { step: 'inject_generation' },
          });
        }
      }
    } else {
      // No decisions in 5-minute window: punish inaction (pathway outcome or inaction inject)
      if (hasPathwayOutcomes) {
        const robustnessBand = effectiveRobustnessBand('low', hasNotMetGates);
        if (!this.io) {
          const { io } = await import('../index.js');
          this.io = io;
        }
        let publishedCount = 0;
        for (const row of rowsToProcess) {
          if (publishedCount >= 1) break; // At most one outcome inject per cycle for inaction
          const outcomes = parseOutcomes(row.outcomes);
          if (outcomes.length === 0) continue;
          const matching = outcomes.filter((o) => o.robustness_band === robustnessBand);
          const inactionOutcome =
            matching.length > 0
              ? matching.find((o) => o.consequence_for_inaction === true)
              : undefined;
          const toPublish =
            inactionOutcome ??
            (matching.length > 0
              ? matching[0]
              : outcomes[Math.floor(Math.random() * outcomes.length)]);
          const { data: createdInject, error: createError } = await supabaseAdmin
            .from('scenario_injects')
            .insert({
              scenario_id: session.scenario_id,
              trigger_time_minutes: null,
              trigger_condition: null,
              type: toPublish.inject_payload.type,
              title: toPublish.inject_payload.title,
              content: toPublish.inject_payload.content,
              severity: toPublish.inject_payload.severity,
              affected_roles: toPublish.inject_payload.affected_roles ?? [],
              inject_scope: toPublish.inject_payload.inject_scope ?? 'universal',
              target_teams: toPublish.inject_payload.target_teams ?? null,
              requires_response: toPublish.inject_payload.requires_response === true,
              requires_coordination: false,
              ai_generated: true,
              triggered_by_user_id: null,
            })
            .select()
            .single();
          if (!createError && createdInject) {
            await publishInjectToSession(
              createdInject.id,
              session.id,
              session.trainer_id,
              this.io!,
            );
            publishedCount += 1;
            logger.info(
              {
                sessionId: session.id,
                injectId: createdInject.id,
                robustnessBand,
                outcomeId: toPublish.outcome_id,
                trigger_inject_id: row.trigger_inject_id,
              },
              'Pathway outcome inject published (inaction, low band)',
            );
          } else {
            logger.warn(
              {
                error: createError,
                sessionId: session.id,
                trigger_inject_id: row.trigger_inject_id,
              },
              'Failed to create outcome inject for row (inaction), continuing',
            );
          }
        }
      } else {
        // No pathway outcomes: generate one universal inaction inject via AI
        if (env.openAiApiKey) {
          await supabaseAdmin.from('session_events').insert({
            session_id: session.id,
            event_type: 'ai_step_start',
            description: 'AI: Generating inject from inaction…',
            actor_id: null,
            metadata: { step: 'inject_generation' },
          });
        }
        const inactionContext = {
          ...baseContext,
          inactionCycle: true,
          instructionsOverride:
            'Generate an inject that reflects escalation or deterioration due to the lack of any team response in the last 5 minutes.',
        };
        await this.generateUniversalInject(session, inactionContext, []);
        if (env.openAiApiKey) {
          await supabaseAdmin.from('session_events').insert({
            session_id: session.id,
            event_type: 'ai_step_end',
            description: 'AI: Inaction inject generated',
            actor_id: null,
            metadata: { step: 'inject_generation' },
          });
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

    // Enhanced context for universal inject (inactionCycle/instructionsOverride passed through when set)
    const universalContext = {
      ...context,
      injectType: 'universal',
      focus: 'overall_state',
      instructions:
        (context.instructionsOverride as string) ||
        'Generate a general/universal inject that reflects the overall state of play and all decisions made. This should be visible to all players and provide a high-level view of the situation.',
    } as typeof context & {
      injectType: string;
      focus: string;
      instructions: string;
      inactionCycle?: boolean;
      instructionsOverride?: string;
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
