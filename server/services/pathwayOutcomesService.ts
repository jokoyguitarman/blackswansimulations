import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { identifyEscalationFactors, identifyDeEscalationFactors } from './aiService.js';
import { env } from '../env.js';

/**
 * Run escalation/de-escalation factor identification when an inject is published.
 * Factors are stored and used as context for the dynamic decision consequence system
 * (generateDecisionConsequence in heatMeterService.ts).
 *
 * Pathway generation and pre-generated outcome injects have been removed —
 * consequences are now generated on-the-fly per decision based on the actual
 * decision text + robustness band + these stored factors.
 */
export async function runPathwayOutcomesOnInjectPublished(
  sessionId: string,
  injectId: string,
): Promise<void> {
  if (!env.openAiApiKey) {
    logger.debug({ sessionId, injectId }, 'No OpenAI key; skipping factor identification');
    return;
  }

  try {
    await supabaseAdmin.from('session_events').insert({
      session_id: sessionId,
      event_type: 'ai_step_start',
      description: 'AI: Identifying escalation factors from published inject…',
      actor_id: null,
      metadata: { step: 'escalation_factors', inject_id: injectId },
    });
  } catch {
    // non-fatal
  }

  try {
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('id, scenario_id, start_time, current_state')
      .eq('id', sessionId)
      .single();

    if (sessionError || !session) {
      logger.warn({ error: sessionError, sessionId }, 'Factor identification: session not found');
      return;
    }

    const { data: inject, error: injectError } = await supabaseAdmin
      .from('scenario_injects')
      .select('id, type, title, content, inject_scope, target_teams')
      .eq('id', injectId)
      .single();

    if (injectError || !inject) {
      logger.warn(
        { error: injectError, injectId, sessionId },
        'Factor identification: inject not found',
      );
      return;
    }

    const { data: scenario } = await supabaseAdmin
      .from('scenarios')
      .select('id, description, insider_knowledge')
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

    const { data: objectives } = await supabaseAdmin
      .from('scenario_objective_progress')
      .select('objective_id, objective_name')
      .eq('session_id', sessionId);

    const objectivesForFactors = (objectives || []).map(
      (o: { objective_id?: string; objective_name?: string }) => ({
        objective_id: o?.objective_id,
        objective_name: o?.objective_name,
      }),
    );

    const scenarioDescription = (scenario?.description ?? '') + layoutContext;

    const singleInjectContext = [
      {
        type: inject.type,
        title: inject.title,
        content: inject.content,
      },
    ];

    const triggerScope = (inject as { inject_scope?: string | null }).inject_scope;
    const triggerTargetTeams = (inject as { target_teams?: string[] | null }).target_teams;
    const isTeamSpecific =
      (triggerScope === 'team_specific' || triggerScope === 'team') &&
      Array.isArray(triggerTargetTeams) &&
      triggerTargetTeams.length > 0;

    let teamsToProcess: string[];
    if (isTeamSpecific) {
      teamsToProcess = triggerTargetTeams!;
    } else {
      const { data: teamRows } = await supabaseAdmin
        .from('session_teams')
        .select('team_name')
        .eq('session_id', sessionId);
      const uniqueTeams = [
        ...new Set((teamRows ?? []).map((r: { team_name: string }) => r.team_name)),
      ];
      teamsToProcess = uniqueTeams.length > 0 ? uniqueTeams : ['all'];
    }

    const baselineFactors = Array.isArray(insiderKnowledge.baseline_escalation_factors)
      ? (insiderKnowledge.baseline_escalation_factors as Array<{
          id: string;
          name: string;
          description: string;
          severity: string;
        }>)
      : [];

    for (const teamName of teamsToProcess) {
      const isSingleTeamFallback = teamName === 'all';
      const teamFocusContext = isSingleTeamFallback
        ? undefined
        : `This inject targets the ${teamName} team specifically. All factors must relate exclusively to this team's domain, responsibilities, and potential actions or failures.`;

      logger.info(
        { sessionId, injectId, team: teamName },
        'Identifying escalation factors for team',
      );

      const factorsResult = await identifyEscalationFactors(
        scenarioDescription,
        (session.current_state as Record<string, unknown>) ?? {},
        objectivesForFactors,
        singleInjectContext,
        env.openAiApiKey,
        teamFocusContext,
      );
      const existingFactorIds = new Set(factorsResult.factors.map((f) => f.id));
      const mergedFactors = [
        ...factorsResult.factors,
        ...baselineFactors.filter((f) => f && !existingFactorIds.has(f.id)),
      ];

      let deEscalationFactors: Array<{ id: string; name: string; description: string }> = [];
      try {
        const deEscResult = await identifyDeEscalationFactors(
          scenarioDescription,
          (session.current_state as Record<string, unknown>) ?? {},
          objectivesForFactors,
          singleInjectContext,
          mergedFactors,
          env.openAiApiKey,
          teamFocusContext,
        );
        deEscalationFactors = deEscResult.factors;
      } catch (deEscErr) {
        logger.warn(
          { error: deEscErr, sessionId, team: teamName },
          'De-escalation factors failed, continuing',
        );
      }

      await supabaseAdmin.from('session_escalation_factors').insert({
        session_id: sessionId,
        evaluated_at: new Date().toISOString(),
        trigger_inject_id: injectId,
        target_team: isSingleTeamFallback ? null : teamName,
        factors: mergedFactors,
        de_escalation_factors: deEscalationFactors,
      });

      logger.info(
        {
          sessionId,
          injectId,
          team: teamName,
          escalationCount: mergedFactors.length,
          deEscalationCount: deEscalationFactors.length,
        },
        'Escalation factors identified and stored for team',
      );
    }

    logger.info(
      { sessionId, injectId, teamsProcessed: teamsToProcess },
      'Escalation factors identified for all teams',
    );

    await supabaseAdmin.from('session_events').insert({
      session_id: sessionId,
      event_type: 'ai_step_end',
      description: 'AI: Escalation factors identified',
      actor_id: null,
      metadata: { step: 'escalation_factors', inject_id: injectId },
    });
  } catch (err) {
    logger.error({ err, sessionId, injectId }, 'Factor identification on inject publish failed');
    throw err;
  }
}
