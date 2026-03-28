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
    hazards,
    floor_plans,
    casualties,
    equipment,
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
        generation_source: 'war_room',
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
          ...(loc.pin_category === 'entry_exit' ? { claimable_by: ['all'] } : {}),
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

    if (hazards && hazards.length > 0) {
      const { error: hazError } = await supabaseAdmin.from('scenario_hazards').insert(
        hazards.map((h) => ({
          scenario_id: scenarioId,
          hazard_type: h.hazard_type,
          location_lat: h.location_lat,
          location_lng: h.location_lng,
          floor_level: h.floor_level ?? 'G',
          properties: h.properties ?? {},
          assessment_criteria: h.assessment_criteria ?? [],
          image_url: h.image_url ?? null,
          image_sequence: h.image_sequence ?? null,
          status: h.status ?? 'active',
          appears_at_minutes: h.appears_at_minutes ?? 0,
          resolution_requirements: h.resolution_requirements ?? {},
          personnel_requirements: h.personnel_requirements ?? {},
          equipment_requirements: h.equipment_requirements ?? [],
          deterioration_timeline: h.deterioration_timeline ?? {},
          enriched_description: h.enriched_description ?? null,
          fire_class: h.fire_class ?? null,
          debris_type: h.debris_type ?? null,
        })),
      );
      if (hazError) {
        logger.warn({ error: hazError }, 'scenario_hazards insert failed (non-blocking)');
      }
    }

    if (floor_plans && floor_plans.length > 0) {
      const { error: fpError } = await supabaseAdmin.from('scenario_floor_plans').insert(
        floor_plans.map((fp) => ({
          scenario_id: scenarioId,
          floor_level: fp.floor_level,
          floor_label: fp.floor_label,
          plan_svg: fp.plan_svg ?? null,
          plan_image_url: fp.plan_image_url ?? null,
          bounds: fp.bounds ?? null,
          features: fp.features ?? [],
          environmental_factors: fp.environmental_factors ?? [],
        })),
      );
      if (fpError) {
        logger.warn({ error: fpError }, 'scenario_floor_plans insert failed (non-blocking)');
      }
    }

    if (casualties && casualties.length > 0) {
      const { error: casError } = await supabaseAdmin.from('scenario_casualties').insert(
        casualties.map((c) => ({
          scenario_id: scenarioId,
          casualty_type: c.casualty_type,
          location_lat: c.location_lat,
          location_lng: c.location_lng,
          floor_level: c.floor_level ?? 'G',
          headcount: c.headcount ?? 1,
          conditions: c.conditions ?? {},
          status: c.status ?? 'undiscovered',
          appears_at_minutes: c.appears_at_minutes ?? 0,
        })),
      );
      if (casError) {
        logger.warn({ error: casError }, 'scenario_casualties insert failed (non-blocking)');
      }
    }

    if (equipment && equipment.length > 0) {
      const { error: eqError } = await supabaseAdmin.from('scenario_equipment').insert(
        equipment.map((e) => ({
          scenario_id: scenarioId,
          equipment_type: e.equipment_type,
          label: e.label,
          icon: e.icon ?? null,
          properties: e.properties ?? {},
        })),
      );
      if (eqError) {
        logger.warn({ error: eqError }, 'scenario_equipment insert failed (non-blocking)');
      }
    }

    const knowledgeToSave = insider_knowledge || {};
    if (Object.keys(knowledgeToSave).length > 0) {
      const { error: updError } = await supabaseAdmin
        .from('scenarios')
        .update({ insider_knowledge: knowledgeToSave })
        .eq('id', scenarioId);
      if (updError) throw new Error(`insider_knowledge update: ${updError.message}`);
    }

    const usedTitles = new Set<string>(time_injects.map((i) => i.title).filter(Boolean));

    if (decision_injects && decision_injects.length > 0) {
      for (const inj of decision_injects) {
        let title = inj.title || inj.trigger_condition?.slice(0, 100) || 'Decision point';
        if (usedTitles.has(title)) {
          let suffix = 1;
          while (usedTitles.has(`${title} (${suffix})`)) suffix++;
          title = `${title} (${suffix})`;
        }
        usedTitles.add(title);
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
          generation_source: 'war_room',
        });
        if (injError) throw new Error(`scenario_injects (decision): ${injError.message}`);
      }
    }

    if (condition_driven_injects && condition_driven_injects.length > 0) {
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
          requires_response: inj.requires_response ?? true,
          requires_coordination: false,
          conditions_to_appear: inj.conditions_to_appear,
          conditions_to_cancel: inj.conditions_to_cancel?.length ? inj.conditions_to_cancel : null,
          eligible_after_minutes: inj.eligible_after_minutes ?? null,
          objective_penalty: inj.objective_penalty ?? null,
          state_effect: inj.state_effect ?? null,
          ai_generated: true,
          generation_source: 'war_room',
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
