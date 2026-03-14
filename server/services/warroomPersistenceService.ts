/**
 * War Room Persistence Service
 * Inserts scenario data into Supabase via supabaseAdmin (no SQL migration execution).
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { refreshOsmVicinityForScenario } from './osmVicinityService.js';
import type { WarroomScenarioPayload } from './warroomAiService.js';

const VALID_INJECT_TYPES = [
  'media_report',
  'field_update',
  'citizen_call',
  'intel_brief',
  'resource_shortage',
  'weather_change',
  'political_pressure',
];

function normalizeInjectType(type: string): string {
  const t = type?.toLowerCase().replace(/\s+/g, '_') || 'field_update';
  return VALID_INJECT_TYPES.includes(t) ? t : 'field_update';
}

function normalizeInjectScope(
  scope: string | undefined,
): 'universal' | 'role_specific' | 'team_specific' {
  const s = (scope ?? 'universal').toLowerCase().replace(/\s+/g, '_');
  if (s === 'team_specific' || s === 'team') return 'team_specific';
  if (s === 'role_specific' || s === 'role') return 'role_specific';
  return 'universal';
}

export interface PersistOptions {
  center_lat?: number;
  center_lng?: number;
  vicinity_radius_meters?: number;
}

/**
 * Persist War Room scenario to Supabase.
 * Insert order: scenarios → scenario_teams → scenario_injects (time) → scenario_objectives →
 * scenario_locations → scenario_environmental_seeds → update insider_knowledge →
 * scenario_injects (decision).
 */
export async function persistWarroomScenario(
  payload: WarroomScenarioPayload,
  createdBy: string,
  options: PersistOptions = {},
): Promise<string> {
  const {
    scenario,
    teams,
    objectives,
    time_injects,
    decision_injects,
    condition_driven_injects,
    locations,
    environmental_seeds,
    insider_knowledge,
  } = payload;

  const { data: scenarioRow, error: scenarioError } = await supabaseAdmin
    .from('scenarios')
    .insert({
      title: scenario.title,
      description: scenario.description,
      category: scenario.category,
      difficulty: scenario.difficulty,
      duration_minutes: scenario.duration_minutes,
      objectives: scenario.objectives,
      initial_state: scenario.initial_state,
      briefing: scenario.briefing,
      role_specific_briefs: scenario.role_specific_briefs,
      created_by: createdBy,
      is_active: true,
      center_lat: options.center_lat ?? null,
      center_lng: options.center_lng ?? null,
      vicinity_radius_meters: options.vicinity_radius_meters ?? null,
    })
    .select('id')
    .single();

  if (scenarioError || !scenarioRow) {
    logger.error({ error: scenarioError }, 'Failed to insert scenario');
    throw new Error(scenarioError?.message || 'Failed to create scenario');
  }

  const scenarioId = scenarioRow.id;

  try {
    if (teams.length > 0) {
      const { error: teamsError } = await supabaseAdmin.from('scenario_teams').insert(
        teams.map((t) => ({
          scenario_id: scenarioId,
          team_name: t.team_name,
          team_description: t.team_description,
          required_roles: [],
          min_participants: t.min_participants ?? 1,
          max_participants: t.max_participants ?? 10,
          ...(t.counter_definitions?.length ? { counter_definitions: t.counter_definitions } : {}),
        })),
      );
      if (teamsError) throw new Error(`scenario_teams: ${teamsError.message}`);
    }

    for (const inj of time_injects) {
      const { error: injError } = await supabaseAdmin.from('scenario_injects').insert({
        scenario_id: scenarioId,
        trigger_time_minutes: inj.trigger_time_minutes,
        trigger_condition: null,
        type: normalizeInjectType(inj.type),
        title: inj.title,
        content: inj.content,
        affected_roles: [],
        severity: inj.severity || 'high',
        inject_scope: normalizeInjectScope(inj.inject_scope),
        target_teams: inj.target_teams || [],
        requires_response: inj.requires_response ?? true,
        requires_coordination: inj.requires_coordination ?? false,
        conditions_to_appear: inj.conditions_to_appear ?? null,
        conditions_to_cancel: inj.conditions_to_cancel ?? null,
        eligible_after_minutes: inj.eligible_after_minutes ?? null,
        objective_penalty: inj.objective_penalty ?? null,
        state_effect: inj.state_effect ?? null,
        ai_generated: true,
      });
      if (injError) throw new Error(`scenario_injects (time): ${injError.message}`);
    }

    if (objectives.length > 0) {
      const { error: objError } = await supabaseAdmin.from('scenario_objectives').insert(
        objectives.map((o) => ({
          scenario_id: scenarioId,
          objective_id: o.objective_id || o.objective_name.toLowerCase().replace(/\s+/g, '_'),
          objective_name: o.objective_name,
          description: o.description,
          weight: o.weight ?? 25,
          success_criteria: o.success_criteria ?? {},
        })),
      );
      if (objError) throw new Error(`scenario_objectives: ${objError.message}`);
    }

    if (locations && locations.length > 0) {
      const { error: locError } = await supabaseAdmin.from('scenario_locations').insert(
        locations.map((loc, i) => ({
          scenario_id: scenarioId,
          location_type: loc.location_type,
          label: loc.label,
          coordinates: loc.coordinates,
          conditions: {
            ...(loc.conditions ?? {}),
            ...(loc.pin_category ? { pin_category: loc.pin_category } : {}),
            ...(loc.description ? { narrative_description: loc.description } : {}),
          },
          display_order: loc.display_order ?? i,
        })),
      );
      if (locError) throw new Error(`scenario_locations: ${locError.message}`);
    }

    if (environmental_seeds && environmental_seeds.length > 0) {
      const { error: seedError } = await supabaseAdmin.from('scenario_environmental_seeds').insert(
        environmental_seeds.map((s, i) => ({
          scenario_id: scenarioId,
          variant_label: s.variant_label,
          seed_data: s.seed_data ?? {},
          display_order: s.display_order ?? i,
        })),
      );
      if (seedError) throw new Error(`scenario_environmental_seeds: ${seedError.message}`);
    }

    const knowledgeToSave = insider_knowledge || {};
    if (Object.keys(knowledgeToSave).length > 0) {
      const { error: updError } = await supabaseAdmin
        .from('scenarios')
        .update({ insider_knowledge: knowledgeToSave })
        .eq('id', scenarioId);
      if (updError) throw new Error(`insider_knowledge update: ${updError.message}`);
    }

    if (decision_injects && decision_injects.length > 0) {
      for (const inj of decision_injects) {
        const title = inj.title || inj.trigger_condition?.slice(0, 100) || 'Decision point';
        const content = inj.content || inj.trigger_condition || '';
        const { error: injError } = await supabaseAdmin.from('scenario_injects').insert({
          scenario_id: scenarioId,
          trigger_time_minutes: null,
          trigger_condition: inj.trigger_condition,
          type: normalizeInjectType(inj.type),
          title,
          content,
          affected_roles: [],
          severity: inj.severity || 'high',
          inject_scope: normalizeInjectScope(inj.inject_scope),
          target_teams: inj.target_teams || [],
          requires_response: inj.requires_response ?? true,
          requires_coordination: inj.requires_coordination ?? false,
          conditions_to_appear: inj.conditions_to_appear ?? null,
          conditions_to_cancel: inj.conditions_to_cancel ?? null,
          eligible_after_minutes: inj.eligible_after_minutes ?? null,
          objective_penalty: inj.objective_penalty ?? null,
          state_effect: inj.state_effect ?? null,
          ai_generated: true,
        });
        if (injError) throw new Error(`scenario_injects (decision): ${injError.message}`);
      }
    }

    if (condition_driven_injects && condition_driven_injects.length > 0) {
      const usedTitles = new Set<string>(
        [
          ...time_injects.map((i) => i.title),
          ...(decision_injects ?? []).map(
            (i) => i.title || i.trigger_condition?.slice(0, 100) || 'Decision point',
          ),
        ].filter(Boolean),
      );
      for (const inj of condition_driven_injects) {
        let title = inj.title || 'Condition-driven inject';
        if (usedTitles.has(title)) {
          let suffix = 1;
          while (usedTitles.has(`${title} (${suffix})`)) suffix++;
          title = `${title} (${suffix})`;
        }
        usedTitles.add(title);
        const { error: injError } = await supabaseAdmin.from('scenario_injects').insert({
          scenario_id: scenarioId,
          trigger_time_minutes: null,
          trigger_condition: null,
          type: normalizeInjectType(inj.type),
          title,
          content: inj.content,
          affected_roles: [],
          severity: inj.severity || 'high',
          inject_scope: normalizeInjectScope(inj.inject_scope),
          target_teams: inj.target_teams || [],
          requires_response: true,
          requires_coordination: false,
          conditions_to_appear: inj.conditions_to_appear,
          conditions_to_cancel: inj.conditions_to_cancel?.length ? inj.conditions_to_cancel : null,
          eligible_after_minutes: inj.eligible_after_minutes ?? null,
          objective_penalty: inj.objective_penalty ?? null,
          state_effect: inj.state_effect ?? null,
          ai_generated: true,
        });
        if (injError) throw new Error(`scenario_injects (condition-driven): ${injError.message}`);
      }
    }

    if (
      options.center_lat != null &&
      options.center_lng != null &&
      options.vicinity_radius_meters != null
    ) {
      try {
        await refreshOsmVicinityForScenario(scenarioId);
      } catch (osmErr) {
        logger.warn(
          { err: osmErr, scenarioId },
          'OSM vicinity refresh failed during persist; scenario created without real facility data',
        );
      }
    }

    logger.info(
      {
        scenarioId,
        teams: teams.length,
        injects:
          time_injects.length +
          (decision_injects?.length ?? 0) +
          (condition_driven_injects?.length ?? 0),
      },
      'War Room scenario persisted',
    );
    return scenarioId;
  } catch (err) {
    await supabaseAdmin.from('scenarios').delete().eq('id', scenarioId);
    throw err;
  }
}
