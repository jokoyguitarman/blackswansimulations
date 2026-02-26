import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import {
  identifyEscalationFactors,
  identifyDeEscalationFactors,
  generateEscalationPathways,
  generateDeEscalationPathways,
  generatePathwayOutcomeInjects,
} from './aiService.js';
import { env } from '../env.js';

/**
 * Run pathway outcomes generation when an inject is published.
 * Identifies factors and pathways from the just-published inject, generates outcome injects
 * (worst to best by robustness band), and stores them for the next 5-min cycle to match and publish.
 * Called fire-and-forget from publishInjectToSession.
 */
export async function runPathwayOutcomesOnInjectPublished(
  sessionId: string,
  injectId: string,
): Promise<void> {
  if (!env.openAiApiKey) {
    logger.debug({ sessionId, injectId }, 'No OpenAI key; skipping pathway outcomes');
    return;
  }

  try {
    await supabaseAdmin.from('session_events').insert({
      session_id: sessionId,
      event_type: 'ai_step_start',
      description: 'AI: Generating pathway outcomes from published inject…',
      actor_id: null,
      metadata: { step: 'pathway_outcomes', inject_id: injectId },
    });
  } catch {
    // non-fatal
  }

  try {
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('id, scenario_id, current_state')
      .eq('id', sessionId)
      .single();

    if (sessionError || !session) {
      logger.warn({ error: sessionError, sessionId }, 'Pathway outcomes: session not found');
      return;
    }

    const { data: inject, error: injectError } = await supabaseAdmin
      .from('scenario_injects')
      .select('id, type, title, content')
      .eq('id', injectId)
      .single();

    if (injectError || !inject) {
      logger.warn(
        { error: injectError, injectId, sessionId },
        'Pathway outcomes: inject not found',
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

    // Bad-branch context: session has not_met gates → bias AI toward escalation
    const { data: notMetProgress } = await supabaseAdmin
      .from('session_gate_progress')
      .select('gate_id')
      .eq('session_id', sessionId)
      .eq('status', 'not_met');
    const notMetGateIds = (notMetProgress ?? []).map((r: { gate_id: string }) => r.gate_id);
    const badBranchContext =
      notMetGateIds.length > 0
        ? `Session is on the bad branch for gate(s): [${notMetGateIds.join(', ')}]. Bias toward escalation and ongoing consequences; avoid suggesting improvement unless decisions are concrete and specific.`
        : '';
    const scenarioDescriptionWithContext =
      (scenario?.description ?? '') +
      layoutContext +
      (badBranchContext ? '\n\n' + badBranchContext : '');

    const singleInjectContext = [
      {
        type: inject.type,
        title: inject.title,
        content: inject.content,
      },
    ];
    const justPublishedInject = singleInjectContext[0] ?? null;

    const factorsResult = await identifyEscalationFactors(
      scenarioDescriptionWithContext,
      (session.current_state as Record<string, unknown>) ?? {},
      objectivesForFactors,
      singleInjectContext,
      env.openAiApiKey,
    );

    let deEscalationFactors: Array<{ id: string; name: string; description: string }> = [];
    try {
      const deEscResult = await identifyDeEscalationFactors(
        scenarioDescriptionWithContext,
        (session.current_state as Record<string, unknown>) ?? {},
        objectivesForFactors,
        singleInjectContext,
        factorsResult.factors,
        env.openAiApiKey,
      );
      deEscalationFactors = deEscResult.factors;
    } catch (deEscErr) {
      logger.warn(
        { error: deEscErr, sessionId },
        'Pathway outcomes: de-escalation factors failed, continuing',
      );
    }

    const pathwaysResult = await generateEscalationPathways(
      scenarioDescriptionWithContext,
      (session.current_state as Record<string, unknown>) ?? {},
      factorsResult.factors,
      justPublishedInject,
      env.openAiApiKey,
    );

    let deEscalationPathways: Array<{
      pathway_id: string;
      trajectory: string;
      mitigating_behaviours: string[];
      emerging_challenges?: string[];
    }> = [];
    try {
      const dePathResult = await generateDeEscalationPathways(
        scenarioDescriptionWithContext,
        (session.current_state as Record<string, unknown>) ?? {},
        pathwaysResult.pathways,
        deEscalationFactors,
        justPublishedInject,
        env.openAiApiKey,
      );
      deEscalationPathways = dePathResult.pathways;
    } catch (dePathErr) {
      logger.warn(
        { error: dePathErr, sessionId },
        'Pathway outcomes: de-escalation pathways failed, continuing',
      );
    }

    const pathwayUsageSummary = await buildPathwayUsageSummary(sessionId);

    const outcomeResult = await generatePathwayOutcomeInjects(
      scenarioDescriptionWithContext,
      { type: inject.type, title: inject.title, content: inject.content },
      pathwaysResult.pathways,
      deEscalationPathways,
      pathwayUsageSummary,
      env.openAiApiKey,
    );

    const factorsSnapshot = {
      escalation: factorsResult.factors,
      de_escalation: deEscalationFactors,
    };
    const pathwaysSnapshot = {
      escalation: pathwaysResult.pathways,
      de_escalation: deEscalationPathways,
    };

    await supabaseAdmin.from('session_escalation_factors').insert({
      session_id: sessionId,
      evaluated_at: new Date().toISOString(),
      factors: factorsResult.factors,
      de_escalation_factors: deEscalationFactors,
    });

    await supabaseAdmin.from('session_escalation_pathways').insert({
      session_id: sessionId,
      evaluated_at: new Date().toISOString(),
      pathways: pathwaysResult.pathways,
      de_escalation_pathways: deEscalationPathways,
    });

    await supabaseAdmin.from('session_pathway_outcomes').insert({
      session_id: sessionId,
      trigger_inject_id: injectId,
      evaluated_at: new Date().toISOString(),
      factors_snapshot: factorsSnapshot,
      pathways_snapshot: pathwaysSnapshot,
      outcomes: outcomeResult.outcomes,
    });

    logger.info(
      {
        sessionId,
        injectId,
        outcomeCount: outcomeResult.outcomes.length,
      },
      'Pathway outcomes generated and stored',
    );

    await supabaseAdmin.from('session_events').insert({
      session_id: sessionId,
      event_type: 'ai_step_end',
      description: 'AI: Pathway outcomes generated',
      actor_id: null,
      metadata: { step: 'pathway_outcomes', inject_id: injectId },
    });
  } catch (err) {
    logger.error({ err, sessionId, injectId }, 'Pathway outcomes on inject publish failed');
    throw err;
  }
}

async function buildPathwayUsageSummary(sessionId: string): Promise<string | undefined> {
  try {
    const { data: pathwayRows } = await supabaseAdmin
      .from('session_escalation_pathways')
      .select('pathways, de_escalation_pathways')
      .eq('session_id', sessionId)
      .order('evaluated_at', { ascending: false })
      .limit(5);

    const { data: outcomeRows } = await supabaseAdmin
      .from('session_pathway_outcomes')
      .select('pathways_snapshot')
      .eq('session_id', sessionId)
      .order('evaluated_at', { ascending: false })
      .limit(5);

    const themes: string[] = [];
    const addTrajectories = (pathways: Array<{ trajectory?: string; pathway_id?: string }>) => {
      for (const p of pathways || []) {
        if (p.trajectory) themes.push(p.trajectory.slice(0, 80));
      }
    };

    for (const row of pathwayRows || []) {
      const pathways = row.pathways as Array<{ trajectory?: string }> | null;
      const dePathways = row.de_escalation_pathways as Array<{ trajectory?: string }> | null;
      if (pathways) addTrajectories(pathways);
      if (dePathways) addTrajectories(dePathways);
    }
    for (const row of outcomeRows || []) {
      const snap = row.pathways_snapshot as {
        escalation?: Array<{ trajectory?: string }>;
        de_escalation?: Array<{ trajectory?: string }>;
      } | null;
      if (snap?.escalation) addTrajectories(snap.escalation);
      if (snap?.de_escalation) addTrajectories(snap.de_escalation);
    }

    if (themes.length === 0) return undefined;
    const unique = [...new Set(themes)].slice(0, 10);
    return unique.join('; ');
  } catch {
    return undefined;
  }
}
