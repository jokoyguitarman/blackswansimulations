-- Migration 276: full-fidelity scenario clone.
-- NOT APPLIED. Applying this to the shared Supabase project needs the user's explicit approval.
-- Idempotent: safe to run twice.
-- Does not reference objects from migrations 268–273.
-- Column lists are the schema after migrations <=267 plus 274 and 275.
-- 268–273 add no columns to scenarios, scenario_injects or scenario_teams
-- (272 only widens a check constraint). Optional child copies are skipped
-- when to_regclass says the table is absent, so this file still applies on a
-- database that has never had those tables.
-- New columns must be added here and in server/services/scenarioClone/cloneColumns.ts.
-- valid_from is now(), not the source timestamp. retired_by_edit and superseded_by
-- are null. Edit history, sessions, drafts and builds are not copied.
-- Rollback (branch or local database only, never the shared project):
--   DROP FUNCTION IF EXISTS public.clone_scenario(UUID, UUID, TEXT);
BEGIN;

CREATE OR REPLACE FUNCTION public.clone_scenario(
  p_scenario_id UUID,
  p_user_id UUID,
  p_title TEXT
) RETURNS UUID
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $clone$
DECLARE
  v_new UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.scenarios WHERE id = p_scenario_id) THEN
    RETURN NULL;
  END IF;

  -- Omitted on purpose: id, created_at, updated_at. created_by and is_active are set.
  INSERT INTO public.scenarios (
    title,
    description,
    category,
    difficulty,
    duration_minutes,
    objectives,
    initial_state,
    briefing,
    role_specific_briefs,
    center_lat,
    center_lng,
    vicinity_radius_meters,
    vicinity_map_url,
    layout_image_url,
    insider_knowledge,
    sweep_device_pool,
    blueprint,
    setup_edits_used,
    created_by,
    is_active
  )
  SELECT
    COALESCE(NULLIF(btrim(p_title), ''), s.title || ' (Copy)'),
    s.description,
    s.category,
    s.difficulty,
    s.duration_minutes,
    s.objectives,
    s.initial_state,
    s.briefing,
    s.role_specific_briefs,
    s.center_lat,
    s.center_lng,
    s.vicinity_radius_meters,
    s.vicinity_map_url,
    s.layout_image_url,
    s.insider_knowledge,
    s.sweep_device_pool,
    s.blueprint,
    s.setup_edits_used,
    p_user_id,
    false
  FROM public.scenarios s
  WHERE s.id = p_scenario_id
  RETURNING id INTO v_new;

  IF v_new IS NULL THEN
    RETURN NULL;
  END IF;

  -- Active teams only. team_uid is kept. valid_from is the clone's now().
  INSERT INTO public.scenario_teams (
    scenario_id,
    team_name,
    team_description,
    required_roles,
    min_participants,
    max_participants,
    counter_definitions,
    is_investigative,
    charter,
    expected_actions,
    scoring_rubric,
    org_key,
    function_key,
    team_uid,
    valid_from,
    retired_at,
    retired_by_edit,
    retire_reason,
    superseded_by
  )
  SELECT
    v_new,
    t.team_name,
    t.team_description,
    t.required_roles,
    t.min_participants,
    t.max_participants,
    t.counter_definitions,
    t.is_investigative,
    t.charter,
    t.expected_actions,
    t.scoring_rubric,
    t.org_key,
    t.function_key,
    t.team_uid,
    now(),
    NULL,
    NULL,
    NULL,
    NULL
  FROM public.scenario_teams t
  WHERE t.scenario_id = p_scenario_id
    AND t.retired_at IS NULL;

  -- Active template injects only. inject_key stays inside delivery_config.
  INSERT INTO public.scenario_injects (
    scenario_id,
    trigger_time_minutes,
    trigger_condition,
    type,
    title,
    content,
    affected_roles,
    severity,
    requires_response,
    ai_generated,
    inject_scope,
    target_teams,
    requires_coordination,
    triggered_by_user_id,
    required_gate_id,
    required_gate_not_met_id,
    conditions_to_appear,
    conditions_to_cancel,
    eligible_after_minutes,
    objective_penalty,
    state_effect,
    generation_source,
    delivery_config,
    response_type,
    session_id,
    valid_from,
    retired_at,
    retired_by_edit,
    retire_reason,
    superseded_by
  )
  SELECT
    v_new,
    i.trigger_time_minutes,
    i.trigger_condition,
    i.type,
    i.title,
    i.content,
    i.affected_roles,
    i.severity,
    i.requires_response,
    i.ai_generated,
    i.inject_scope,
    i.target_teams,
    i.requires_coordination,
    i.triggered_by_user_id,
    i.required_gate_id,
    i.required_gate_not_met_id,
    i.conditions_to_appear,
    i.conditions_to_cancel,
    i.eligible_after_minutes,
    i.objective_penalty,
    i.state_effect,
    i.generation_source,
    i.delivery_config,
    i.response_type,
    NULL,
    now(),
    NULL,
    NULL,
    NULL,
    NULL
  FROM public.scenario_injects i
  WHERE i.scenario_id = p_scenario_id
    AND i.session_id IS NULL
    AND i.retired_at IS NULL;

  DROP TABLE IF EXISTS pg_temp.clone_hazard_map;
  CREATE TEMP TABLE clone_hazard_map (
    old_id UUID PRIMARY KEY,
    new_id UUID NOT NULL
  ) ON COMMIT DROP;

  IF to_regclass('public.scenario_objectives') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO public.scenario_objectives (
        scenario_id, objective_id, objective_name, description, success_criteria, weight
      )
      SELECT $1, o.objective_id, o.objective_name, o.description, o.success_criteria, o.weight
      FROM public.scenario_objectives o
      WHERE o.scenario_id = $2
        AND o.retired_at IS NULL
    $sql$ USING v_new, p_scenario_id;
  END IF;

  IF to_regclass('public.sop_definitions') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO public.sop_definitions (
        scenario_id, sop_name, description, steps, response_time_limit_minutes,
        escalation_rules, approval_chain, content_guidelines
      )
      SELECT
        $1, s.sop_name, s.description, s.steps, s.response_time_limit_minutes,
        s.escalation_rules, s.approval_chain, s.content_guidelines
      FROM public.sop_definitions s
      WHERE s.scenario_id = $2
    $sql$ USING v_new, p_scenario_id;
  END IF;

  IF to_regclass('public.scenario_hazards') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO clone_hazard_map (old_id, new_id)
      SELECT h.id, gen_random_uuid()
      FROM public.scenario_hazards h
      WHERE h.scenario_id = $1
        AND h.session_id IS NULL
    $sql$ USING p_scenario_id;

    -- parent_pin_id is filled afterwards so the new parent row already exists.
    EXECUTE $sql$
      INSERT INTO public.scenario_hazards (
        id,
        scenario_id,
        session_id,
        hazard_type,
        location_lat,
        location_lng,
        floor_level,
        properties,
        assessment_criteria,
        image_url,
        image_sequence,
        status,
        appears_at_minutes,
        resolution_requirements,
        personnel_requirements,
        equipment_requirements,
        deterioration_timeline,
        enriched_description,
        fire_class,
        debris_type,
        zones,
        detonation_deadline,
        parent_pin_id,
        spawn_condition,
        stud_id
      )
      SELECT
        m.new_id,
        $1,
        NULL,
        h.hazard_type,
        h.location_lat,
        h.location_lng,
        h.floor_level,
        h.properties,
        h.assessment_criteria,
        h.image_url,
        h.image_sequence,
        h.status,
        h.appears_at_minutes,
        h.resolution_requirements,
        h.personnel_requirements,
        h.equipment_requirements,
        h.deterioration_timeline,
        h.enriched_description,
        h.fire_class,
        h.debris_type,
        h.zones,
        h.detonation_deadline,
        NULL,
        h.spawn_condition,
        h.stud_id
      FROM public.scenario_hazards h
      JOIN clone_hazard_map m ON m.old_id = h.id
    $sql$ USING v_new;

    EXECUTE $sql$
      UPDATE public.scenario_hazards AS copied
      SET parent_pin_id = parent_map.new_id
      FROM clone_hazard_map AS self_map
      JOIN public.scenario_hazards AS source ON source.id = self_map.old_id
      JOIN clone_hazard_map AS parent_map ON parent_map.old_id = source.parent_pin_id
      WHERE copied.id = self_map.new_id
    $sql$;
  END IF;

  IF to_regclass('public.scenario_casualties') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO public.scenario_casualties (
        scenario_id,
        session_id,
        casualty_type,
        location_lat,
        location_lng,
        floor_level,
        headcount,
        conditions,
        status,
        assigned_team,
        linked_decision_id,
        appears_at_minutes,
        player_triage_color,
        assessed_by,
        assessed_at_minutes,
        destination_lat,
        destination_lng,
        destination_label,
        movement_speed_mpm,
        destination_reached_status,
        parent_pin_id,
        spawn_condition
      )
      SELECT
        $1,
        NULL,
        c.casualty_type,
        c.location_lat,
        c.location_lng,
        c.floor_level,
        c.headcount,
        c.conditions,
        c.status,
        c.assigned_team,
        c.linked_decision_id,
        c.appears_at_minutes,
        c.player_triage_color,
        c.assessed_by,
        c.assessed_at_minutes,
        c.destination_lat,
        c.destination_lng,
        c.destination_label,
        c.movement_speed_mpm,
        c.destination_reached_status,
        parent_map.new_id,
        c.spawn_condition
      FROM public.scenario_casualties c
      LEFT JOIN clone_hazard_map AS parent_map ON parent_map.old_id = c.parent_pin_id
      WHERE c.scenario_id = $2
        AND c.session_id IS NULL
    $sql$ USING v_new, p_scenario_id;
  END IF;

  IF to_regclass('public.scenario_equipment') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO public.scenario_equipment (
        scenario_id, equipment_type, label, icon, properties, applicable_teams
      )
      SELECT $1, e.equipment_type, e.label, e.icon, e.properties, e.applicable_teams
      FROM public.scenario_equipment e
      WHERE e.scenario_id = $2
    $sql$ USING v_new, p_scenario_id;
  END IF;

  IF to_regclass('public.scenario_floor_plans') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO public.scenario_floor_plans (
        scenario_id, floor_level, floor_label, plan_svg, plan_image_url,
        bounds, features, environmental_factors
      )
      SELECT
        $1, f.floor_level, f.floor_label, f.plan_svg, f.plan_image_url,
        f.bounds, f.features, f.environmental_factors
      FROM public.scenario_floor_plans f
      WHERE f.scenario_id = $2
    $sql$ USING v_new, p_scenario_id;
  END IF;

  IF to_regclass('public.rts_scene_configs') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO public.rts_scene_configs (
        scenario_id,
        name,
        building_polygon,
        building_name,
        center_lat,
        center_lng,
        exits,
        interior_walls,
        hazard_zones,
        stairwells,
        blast_site,
        casualty_clusters,
        planted_items,
        wall_inspection_points,
        wall_photo_urls,
        casualty_image_urls,
        pedestrian_count,
        enrichment_result,
        levels,
        placed_objects,
        created_by
      )
      SELECT
        $1,
        r.name,
        r.building_polygon,
        r.building_name,
        r.center_lat,
        r.center_lng,
        r.exits,
        r.interior_walls,
        r.hazard_zones,
        r.stairwells,
        r.blast_site,
        r.casualty_clusters,
        r.planted_items,
        r.wall_inspection_points,
        r.wall_photo_urls,
        r.casualty_image_urls,
        r.pedestrian_count,
        r.enrichment_result,
        r.levels,
        r.placed_objects,
        $3
      FROM public.rts_scene_configs r
      WHERE r.scenario_id = $2
    $sql$ USING v_new, p_scenario_id, p_user_id;
  END IF;

  RETURN v_new;
END;
$clone$;

REVOKE EXECUTE ON FUNCTION public.clone_scenario(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clone_scenario(UUID, UUID, TEXT)
  TO service_role;

COMMIT;
