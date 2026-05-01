import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import type { SocialCrisisPayload } from './socialCrisisGeneratorService.js';

const VALID_INJECT_SCOPES = ['universal', 'role_specific', 'team_specific'];
const VALID_SEVERITIES = ['low', 'medium', 'high', 'critical'];

function sanitizeScope(scope: string | undefined): string {
  if (scope && VALID_INJECT_SCOPES.includes(scope)) return scope;
  return 'universal';
}

function sanitizeSeverity(severity: string | undefined): string {
  if (severity && VALID_SEVERITIES.includes(severity)) return severity;
  return 'medium';
}

export async function persistSocialCrisisScenario(
  payload: SocialCrisisPayload,
  createdBy: string,
): Promise<string> {
  const { scenario, teams, objectives, sop, time_injects, condition_injects, decision_injects } =
    payload;

  const { data: scenarioRow, error: scenarioErr } = await supabaseAdmin
    .from('scenarios')
    .insert({
      title: scenario.title,
      description: scenario.description,
      briefing: scenario.briefing,
      category: scenario.category,
      difficulty: scenario.difficulty,
      duration_minutes: scenario.duration_minutes,
      objectives: objectives.map((o) => o.objective_name),
      initial_state: scenario.initial_state,
      created_by: createdBy,
    })
    .select('id')
    .single();

  if (scenarioErr || !scenarioRow) {
    logger.error({ error: scenarioErr }, 'Failed to insert social crisis scenario');
    throw new Error(`Scenario insert failed: ${scenarioErr?.message || 'no data'}`);
  }

  const scenarioId = scenarioRow.id;

  try {
    if (teams.length > 0) {
      const { error: teamsErr } = await supabaseAdmin.from('scenario_teams').insert(
        teams.map((t) => ({
          scenario_id: scenarioId,
          team_name: t.team_name,
          team_description: t.team_description,
          required_roles: [],
          min_participants: t.min_participants,
          max_participants: t.max_participants,
        })),
      );
      if (teamsErr) throw new Error(`scenario_teams: ${teamsErr.message}`);
    }

    if (objectives.length > 0) {
      const { error: objErr } = await supabaseAdmin.from('scenario_objectives').insert(
        objectives.map((o) => ({
          scenario_id: scenarioId,
          objective_id: o.objective_id,
          objective_name: o.objective_name,
          description: o.description,
          weight: o.weight,
          success_criteria: o.success_criteria || {},
        })),
      );
      if (objErr) throw new Error(`scenario_objectives: ${objErr.message}`);
    }

    const { error: sopErr } = await supabaseAdmin.from('sop_definitions').insert({
      scenario_id: scenarioId,
      sop_name: sop.sop_name,
      description: sop.description,
      steps: sop.steps,
      response_time_limit_minutes: sop.response_time_limit_minutes,
      content_guidelines: sop.content_guidelines,
    });
    if (sopErr) logger.warn({ error: sopErr }, 'SOP insert failed (non-critical)');

    const allInjects = [
      ...time_injects.map((inj) => ({
        scenario_id: scenarioId,
        trigger_time_minutes: inj.trigger_time_minutes ?? null,
        type: inj.type || 'social_post',
        title: inj.title,
        content: inj.content,
        severity: sanitizeSeverity(inj.severity),
        inject_scope: sanitizeScope(inj.inject_scope),
        target_teams: inj.target_teams || [],
        requires_response: inj.requires_response || false,
        delivery_config: inj.delivery_config,
        conditions_to_appear: null,
        conditions_to_cancel: null,
        eligible_after_minutes: null,
        state_effect: inj.state_effect || null,
        ai_generated: true,
        generation_source: 'war_room',
      })),
      ...condition_injects.map((inj) => ({
        scenario_id: scenarioId,
        trigger_time_minutes: null,
        type: inj.type || 'social_post',
        title: inj.title,
        content: inj.content,
        severity: sanitizeSeverity(inj.severity),
        inject_scope: sanitizeScope(inj.inject_scope),
        target_teams: inj.target_teams || [],
        requires_response: inj.requires_response || false,
        delivery_config: inj.delivery_config,
        conditions_to_appear: inj.conditions_to_appear || null,
        conditions_to_cancel: inj.conditions_to_cancel || null,
        eligible_after_minutes: inj.eligible_after_minutes || null,
        state_effect: inj.state_effect || null,
        ai_generated: true,
        generation_source: 'war_room',
      })),
      ...decision_injects.map((inj) => ({
        scenario_id: scenarioId,
        trigger_time_minutes: null,
        trigger_condition:
          ((inj as unknown as Record<string, unknown>).trigger_condition as string) || null,
        type: inj.type || 'social_post',
        title: inj.title,
        content: inj.content,
        severity: sanitizeSeverity(inj.severity),
        inject_scope: sanitizeScope(inj.inject_scope),
        target_teams: inj.target_teams || [],
        requires_response: false,
        delivery_config: inj.delivery_config,
        ai_generated: true,
        generation_source: 'war_room',
      })),
    ];

    if (allInjects.length > 0) {
      const { error: injectsErr } = await supabaseAdmin.from('scenario_injects').insert(allInjects);
      if (injectsErr) throw new Error(`scenario_injects: ${injectsErr.message}`);
    }

    logger.info(
      {
        scenarioId,
        teams: teams.length,
        objectives: objectives.length,
        injects: allInjects.length,
      },
      'Social crisis scenario persisted successfully',
    );

    return scenarioId;
  } catch (err) {
    logger.error({ err, scenarioId }, 'Social crisis persistence failed, rolling back scenario');
    await supabaseAdmin.from('scenarios').delete().eq('id', scenarioId);
    throw err;
  }
}
