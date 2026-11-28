-- Migration 277: apply a scenario setup edit in place.
-- NOT APPLIED. Applying this to the shared Supabase project needs the user's explicit approval.
-- Idempotent: safe to run twice.
-- Depends on 274 (scenario_setup_edits, count_scenario_setup_edit) and 275 (valid-time columns).
-- Migrations 268–273 are not required. session_call_lines, session_call_takers,
-- session_role_assignments, inject_deliveries and session_dependency_states (280)
-- are touched only inside IF to_regclass(...) IS NOT NULL THEN EXECUTE ... END IF.
-- escalation_chains, escalation_chain_steps and stakeholder_moods are session
-- history. This migration does not read or write them. Chain and mood config
-- travels on the inject's delivery_config.
-- History for an in-place inject patch is re-checked against inject_publications (208)
-- and, only when that table exists, inject_deliveries. A new publication returns stale
-- before the edit is counted, so a rejected apply does not consume an allowance.
-- Rollback (branch or local database only, never the shared project):
--   DROP FUNCTION IF EXISTS public.apply_scenario_setup_edit(UUID, TEXT, JSONB, BOOLEAN, INT);
--   DROP FUNCTION IF EXISTS public.scenario_initial_state_md5(UUID);
--   Restore scenario_teams / scenario_injects retire_reason checks to
--   ('removed','renamed','revised'), drop scenario_setup_edit from credit_ledger's
--   reason check, and restore UNIQUE(scenario_id, objective_id) after duplicate
--   objective rows are gone.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.scenarios') IS NULL
     OR to_regclass('public.scenario_setup_edits') IS NULL
     OR to_regprocedure('public.count_scenario_setup_edit(uuid, boolean, integer)') IS NULL THEN
    RAISE EXCEPTION 'Apply migrations 274 and 275 before 277_apply_scenario_setup_edit.sql';
  END IF;
END $$;

-- Planner reasons from a re-key are not in the 275 check.
ALTER TABLE public.scenario_teams DROP CONSTRAINT IF EXISTS scenario_teams_retire_reason_check;
ALTER TABLE public.scenario_teams
  ADD CONSTRAINT scenario_teams_retire_reason_check
  CHECK (retire_reason IS NULL OR retire_reason IN (
    'removed', 'renamed', 'revised', 'rekeyed', 'renamed_rekeyed'
  ));

ALTER TABLE public.scenario_injects DROP CONSTRAINT IF EXISTS scenario_injects_retire_reason_check;
ALTER TABLE public.scenario_injects
  ADD CONSTRAINT scenario_injects_retire_reason_check
  CHECK (retire_reason IS NULL OR retire_reason IN (
    'removed', 'renamed', 'revised',
    'targets_only_removed', 'team_layer', 'org_key', 'pressure_layer', 'dependent'
  ));

-- Copy-on-write objectives keep objective_id. The full unique blocks the successor.
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT c.conname INTO constraint_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'scenario_objectives'
    AND c.contype = 'u'
    AND (
      SELECT array_agg(a.attname::text ORDER BY cols.ord)
      FROM unnest(c.conkey) WITH ORDINALITY AS cols(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = cols.attnum
    ) = ARRAY['scenario_id', 'objective_id']::text[];
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.scenario_objectives DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_scenario_objectives_active_key
  ON public.scenario_objectives (scenario_id, objective_id)
  WHERE retired_at IS NULL;

DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT c.conname INTO constraint_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'credit_ledger'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%reason%'
    AND pg_get_constraintdef(c.oid) NOT ILIKE '%credit_type%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.credit_ledger DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE public.credit_ledger
  ADD CONSTRAINT credit_ledger_reason_check
  CHECK (reason IN (
    'invoice_paid',
    'scenario_generated',
    'session_created',
    'refund',
    'admin_adjustment',
    'scenario_setup_edit'
  ));

CREATE OR REPLACE FUNCTION public.scenario_initial_state_md5(p_scenario_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT md5(initial_state::text)
    FROM public.scenarios
   WHERE id = p_scenario_id;
$$;

-- Returns applied | stale | live_session | limit_reached | not_applying | not_found | count_failed.
-- The caller has already moved the edit to applying. p_is_admin is the applying user's role.
CREATE OR REPLACE FUNCTION public.apply_scenario_setup_edit(
  p_edit_id UUID,
  p_expected_state_md5 TEXT,
  p_bundle JSONB,
  p_is_admin BOOLEAN,
  p_limit INT
) RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_scenario UUID;
  v_status TEXT;
  v_md5 TEXT;
  v_count TEXT;
  v_ids UUID[];
  v_session JSONB;
  v_session_id UUID;
  v_session_status TEXT;
  v_start TIMESTAMPTZ;
  v_hit BOOLEAN;
  v_renames JSONB;
  v_move JSONB;
BEGIN
  SELECT scenario_id, status INTO v_scenario, v_status
    FROM public.scenario_setup_edits
   WHERE id = p_edit_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF v_status IS DISTINCT FROM 'applying' THEN
    RETURN 'not_applying';
  END IF;

  SELECT md5(initial_state::text) INTO v_md5
    FROM public.scenarios
   WHERE id = v_scenario
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF v_md5 IS DISTINCT FROM p_expected_state_md5 THEN
    RETURN 'stale';
  END IF;

  -- Hold scheduled and live rows so a start cannot pass the re-check.
  PERFORM id
    FROM public.sessions
   WHERE scenario_id = v_scenario
     AND status IN ('scheduled', 'in_progress', 'paused')
   FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.sessions
     WHERE scenario_id = v_scenario
       AND status IN ('in_progress', 'paused')
  ) THEN
    RETURN 'live_session';
  END IF;

  SELECT COALESCE(array_agg((s.value->>'session_id')::uuid), ARRAY[]::uuid[])
    INTO v_ids
    FROM jsonb_array_elements(COALESCE(p_bundle->'scheduled_sessions', '[]'::jsonb)) AS s(value);

  IF EXISTS (
    SELECT 1
      FROM public.sessions
     WHERE id = ANY(v_ids)
       AND (status IS DISTINCT FROM 'scheduled' OR start_time IS NOT NULL)
  ) THEN
    RETURN 'live_session';
  END IF;

  v_hit := false;
  IF jsonb_array_length(COALESCE(p_bundle->'history_free_inject_ids', '[]'::jsonb)) > 0 THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.inject_publications p
        JOIN jsonb_array_elements_text(p_bundle->'history_free_inject_ids') AS wanted(id)
          ON p.inject_id = wanted.id::uuid
    ) INTO v_hit;
    IF v_hit THEN
      RETURN 'stale';
    END IF;
    IF to_regclass('public.inject_deliveries') IS NOT NULL THEN
      EXECUTE $hist$
        SELECT EXISTS (
          SELECT 1
            FROM public.inject_deliveries d
            JOIN jsonb_array_elements_text($1) AS wanted(id)
              ON d.inject_id = wanted.id::uuid
        )
      $hist$ INTO v_hit USING p_bundle->'history_free_inject_ids';
      IF v_hit THEN
        RETURN 'stale';
      END IF;
    END IF;
  END IF;

  v_count := public.count_scenario_setup_edit(p_edit_id, COALESCE(p_is_admin, false), p_limit);
  IF v_count = 'limit_reached' THEN
    RETURN 'limit_reached';
  END IF;
  IF v_count = 'not_found' THEN
    RETURN 'not_found';
  END IF;
  IF v_count IS NULL OR v_count NOT IN ('counted', 'uncounted', 'already_counted') THEN
    RETURN 'count_failed';
  END IF;

  UPDATE public.scenario_teams AS t
     SET retired_at = now(),
         retired_by_edit = p_edit_id,
         retire_reason = r.reason,
         superseded_by = r.superseded_by
    FROM jsonb_to_recordset(COALESCE(p_bundle->'teams'->'retire', '[]'::jsonb))
      AS r(id uuid, reason text, superseded_by uuid)
   WHERE t.id = r.id
     AND t.scenario_id = v_scenario;

  INSERT INTO public.scenario_teams (
    id,
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
    r.id,
    v_scenario,
    r.team_name,
    r.team_description,
    COALESCE(r.required_roles, ARRAY[]::text[]),
    COALESCE(r.min_participants, 1),
    r.max_participants,
    r.counter_definitions,
    COALESCE(r.is_investigative, false),
    r.charter,
    r.expected_actions,
    r.scoring_rubric,
    r.org_key,
    r.function_key,
    r.team_uid,
    now(),
    NULL,
    NULL,
    NULL,
    NULL
  FROM jsonb_to_recordset(COALESCE(p_bundle->'teams'->'insert', '[]'::jsonb)) AS r(
    id uuid,
    team_name text,
    team_description text,
    required_roles text[],
    min_participants int,
    max_participants int,
    counter_definitions jsonb,
    is_investigative boolean,
    charter jsonb,
    expected_actions jsonb,
    scoring_rubric text,
    org_key text,
    function_key text,
    team_uid uuid
  )
  ON CONFLICT (id) DO NOTHING;

  UPDATE public.scenario_injects AS i
     SET title = r.title,
         content = r.content,
         type = r.type,
         severity = r.severity,
         trigger_time_minutes = r.trigger_time_minutes,
         trigger_condition = r.trigger_condition,
         inject_scope = r.inject_scope,
         target_teams = r.target_teams,
         requires_response = r.requires_response,
         conditions_to_appear = r.conditions_to_appear,
         conditions_to_cancel = r.conditions_to_cancel,
         eligible_after_minutes = r.eligible_after_minutes,
         delivery_config = r.delivery_config,
         state_effect = r.state_effect,
         generation_source = r.generation_source
    FROM jsonb_to_recordset(COALESCE(p_bundle->'injects'->'patch', '[]'::jsonb)) AS r(
      id uuid,
      title text,
      content text,
      type text,
      severity text,
      trigger_time_minutes int,
      trigger_condition text,
      inject_scope text,
      target_teams text[],
      requires_response boolean,
      conditions_to_appear jsonb,
      conditions_to_cancel jsonb,
      eligible_after_minutes int,
      delivery_config jsonb,
      state_effect jsonb,
      generation_source text
    )
   WHERE i.id = r.id
     AND i.scenario_id = v_scenario
     AND i.session_id IS NULL
     AND i.retired_at IS NULL;

  UPDATE public.scenario_injects AS i
     SET retired_at = now(),
         retired_by_edit = p_edit_id,
         retire_reason = r.reason,
         superseded_by = r.superseded_by
    FROM jsonb_to_recordset(COALESCE(p_bundle->'injects'->'retire', '[]'::jsonb))
      AS r(id uuid, reason text, superseded_by uuid)
   WHERE i.id = r.id
     AND i.scenario_id = v_scenario;

  INSERT INTO public.scenario_injects (
    id,
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
    r.id,
    v_scenario,
    r.trigger_time_minutes,
    r.trigger_condition,
    r.type,
    r.title,
    r.content,
    r.affected_roles,
    r.severity,
    COALESCE(r.requires_response, false),
    COALESCE(r.ai_generated, false),
    r.inject_scope,
    COALESCE(r.target_teams, ARRAY[]::text[]),
    COALESCE(r.requires_coordination, false),
    r.triggered_by_user_id,
    r.required_gate_id,
    r.required_gate_not_met_id,
    r.conditions_to_appear,
    r.conditions_to_cancel,
    r.eligible_after_minutes,
    r.objective_penalty,
    r.state_effect,
    r.generation_source,
    r.delivery_config,
    r.response_type,
    NULL,
    now(),
    NULL,
    NULL,
    NULL,
    NULL
  FROM jsonb_to_recordset(COALESCE(p_bundle->'injects'->'insert', '[]'::jsonb)) AS r(
    id uuid,
    trigger_time_minutes int,
    trigger_condition text,
    type text,
    title text,
    content text,
    affected_roles jsonb,
    severity text,
    requires_response boolean,
    ai_generated boolean,
    inject_scope text,
    target_teams text[],
    requires_coordination boolean,
    triggered_by_user_id uuid,
    required_gate_id uuid,
    required_gate_not_met_id uuid,
    conditions_to_appear jsonb,
    conditions_to_cancel jsonb,
    eligible_after_minutes int,
    objective_penalty jsonb,
    state_effect jsonb,
    generation_source text,
    delivery_config jsonb,
    response_type text
  )
  ON CONFLICT (id) DO NOTHING;

  UPDATE public.scenario_objectives AS o
     SET objective_name = r.objective_name,
         description = r.description,
         weight = r.weight
    FROM jsonb_to_recordset(COALESCE(p_bundle->'objectives'->'update', '[]'::jsonb)) AS r(
      id uuid,
      objective_name text,
      description text,
      weight numeric
    )
   WHERE o.id = r.id
     AND o.scenario_id = v_scenario
     AND o.retired_at IS NULL;

  UPDATE public.scenario_objectives AS o
     SET retired_at = now()
    FROM jsonb_to_recordset(COALESCE(p_bundle->'objectives'->'retire', '[]'::jsonb)) AS r(id uuid)
   WHERE o.id = r.id
     AND o.scenario_id = v_scenario;

  INSERT INTO public.scenario_objectives (
    id, scenario_id, objective_id, objective_name, description, success_criteria, weight
  )
  SELECT
    r.id,
    v_scenario,
    r.objective_id,
    r.objective_name,
    r.description,
    COALESCE(r.success_criteria, '{}'::jsonb),
    COALESCE(r.weight, 25)
  FROM jsonb_to_recordset(COALESCE(p_bundle->'objectives'->'insert', '[]'::jsonb)) AS r(
    id uuid,
    objective_id text,
    objective_name text,
    description text,
    success_criteria jsonb,
    weight numeric
  )
  ON CONFLICT (id) DO NOTHING;

  UPDATE public.scenarios
     SET initial_state = p_bundle->'scenario'->'initial_state',
         briefing = CASE
           WHEN COALESCE((p_bundle->'scenario'->>'set_briefing')::boolean, false)
             THEN p_bundle->'scenario'->>'briefing'
           ELSE briefing
         END,
         description = CASE
           WHEN COALESCE((p_bundle->'scenario'->>'set_description')::boolean, false)
             THEN p_bundle->'scenario'->>'description'
           ELSE description
         END,
         title = CASE
           WHEN COALESCE((p_bundle->'scenario'->>'set_title')::boolean, false)
             THEN p_bundle->'scenario'->>'title'
           ELSE title
         END,
         objectives = COALESCE(p_bundle->'scenario'->'objective_names', objectives),
         updated_at = now()
   WHERE id = v_scenario;

  FOR v_session IN
    SELECT value
      FROM jsonb_array_elements(COALESCE(p_bundle->'scheduled_sessions', '[]'::jsonb))
  LOOP
    v_session_id := (v_session->>'session_id')::uuid;
    SELECT status, start_time INTO v_session_status, v_start
      FROM public.sessions
     WHERE id = v_session_id
     FOR UPDATE;
    -- Writes are already in this transaction. Raising aborts them, including the count.
    IF NOT FOUND OR v_session_status IS DISTINCT FROM 'scheduled' OR v_start IS NOT NULL THEN
      RAISE EXCEPTION 'live_session' USING ERRCODE = 'P0001';
    END IF;

    v_renames := COALESCE(v_session->'rename'->'team_names', '[]'::jsonb);
    UPDATE public.session_teams AS st
       SET team_name = m.to_name
      FROM jsonb_to_recordset(v_renames) AS m(from_name text, to_name text)
     WHERE st.session_id = v_session_id
       AND st.team_name = m.from_name;

    UPDATE public.chat_channels AS c
       SET team_name = m.to_name
      FROM jsonb_to_recordset(COALESCE(v_session->'rename'->'channels', '[]'::jsonb))
        AS m(from_name text, to_name text)
     WHERE c.session_id = v_session_id
       AND c.team_name = m.from_name;

    -- Insert the new line, move takers onto it, then delete the old line.
    -- The taker foreign key has no ON UPDATE, so this order is required.
    IF to_regclass('public.session_call_lines') IS NOT NULL
       AND to_regclass('public.session_call_takers') IS NOT NULL THEN
      FOR v_move IN
        SELECT value
          FROM jsonb_array_elements(COALESCE(v_session->'rename'->'call_lines', '[]'::jsonb))
      LOOP
        EXECUTE
          'INSERT INTO public.session_call_lines (session_id, team_name) VALUES ($1, $2) ON CONFLICT (session_id, team_name) DO NOTHING'
          USING v_session_id, v_move->>'to_team';
        EXECUTE
          'UPDATE public.session_call_takers SET team_name = $1 WHERE session_id = $2 AND team_name = $3'
          USING v_move->>'to_team', v_session_id, v_move->>'from_team';
        EXECUTE
          'DELETE FROM public.session_call_lines WHERE session_id = $1 AND team_name = $2'
          USING v_session_id, v_move->>'from_team';
      END LOOP;
      EXECUTE $call$
        DELETE FROM public.session_call_takers
         WHERE session_id = $1
           AND team_name IN (SELECT jsonb_array_elements_text($2))
      $call$ USING v_session_id, COALESCE(v_session->'delete_call_lines', '[]'::jsonb);
      EXECUTE $call$
        DELETE FROM public.session_call_lines
         WHERE session_id = $1
           AND team_name IN (SELECT jsonb_array_elements_text($2))
      $call$ USING v_session_id, COALESCE(v_session->'delete_call_lines', '[]'::jsonb);
    END IF;

    IF to_regclass('public.session_role_assignments') IS NOT NULL THEN
      EXECUTE $role$
        DELETE FROM public.session_role_assignments
         WHERE session_id = $1
           AND role_id IN (SELECT jsonb_array_elements_text($2))
      $role$ USING v_session_id, COALESCE(v_session->'retire_roles', '[]'::jsonb);
    END IF;

    DELETE FROM public.chat_channels AS c
     WHERE c.session_id = v_session_id
       AND c.team_name IN (
         SELECT jsonb_array_elements_text(COALESCE(v_session->'delete_channels', '[]'::jsonb))
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.chat_messages m WHERE m.channel_id = c.id
       );

    DELETE FROM public.session_teams
     WHERE session_id = v_session_id
       AND team_name IN (
         SELECT jsonb_array_elements_text(COALESCE(v_session->'remove_teams', '[]'::jsonb))
       );

    -- One statement, so the two keys of a swap are not applied one after the other.
    UPDATE public.session_page_controllers AS spc
       SET org_key = m.to_key
      FROM jsonb_to_recordset(COALESCE(v_session->'remap_page_controllers', '[]'::jsonb))
        AS m(from_key text, to_key text, user_id uuid)
     WHERE spc.session_id = v_session_id
       AND spc.org_key = m.from_key
       AND spc.user_id = m.user_id;

    DELETE FROM public.session_page_controllers
     WHERE session_id = v_session_id
       AND org_key IN (
         SELECT jsonb_array_elements_text(COALESCE(v_session->'remove_org_keys', '[]'::jsonb))
       );

    IF to_regclass('public.session_dependency_states') IS NOT NULL THEN
      EXECUTE $dep$
        UPDATE public.session_dependency_states AS s
           SET upstream_team = m.to_name,
               updated_at = now()
          FROM jsonb_to_recordset($1) AS m(from_name text, to_name text)
         WHERE s.session_id = $2
           AND s.upstream_team = m.from_name
      $dep$ USING v_renames, v_session_id;
      EXECUTE $dep$
        UPDATE public.session_dependency_states AS s
           SET downstream_teams = mapped.names,
               updated_at = now()
          FROM (
            SELECT s2.dep_id,
                   ARRAY(
                     SELECT COALESCE(m.to_name, u.name)
                       FROM unnest(s2.downstream_teams) WITH ORDINALITY AS u(name, ord)
                       LEFT JOIN jsonb_to_recordset($1) AS m(from_name text, to_name text)
                         ON m.from_name = u.name
                      ORDER BY u.ord
                   ) AS names
              FROM public.session_dependency_states s2
             WHERE s2.session_id = $2
          ) AS mapped
         WHERE s.session_id = $2
           AND s.dep_id = mapped.dep_id
           AND s.downstream_teams IS DISTINCT FROM mapped.names
      $dep$ USING v_renames, v_session_id;
    END IF;

    IF COALESCE((v_session->>'delete_sim_org_pages')::boolean, false) THEN
      UPDATE public.social_posts
         SET reply_to_post_id = NULL
       WHERE session_id = v_session_id
         AND reply_to_post_id IN (
           SELECT id FROM public.social_posts
            WHERE session_id = v_session_id AND is_branded_history IS TRUE
         );
      UPDATE public.social_posts
         SET original_post_id = NULL
       WHERE session_id = v_session_id
         AND original_post_id IN (
           SELECT id FROM public.social_posts
            WHERE session_id = v_session_id AND is_branded_history IS TRUE
         );
      DELETE FROM public.social_posts
       WHERE session_id = v_session_id
         AND is_branded_history IS TRUE;
      DELETE FROM public.sim_org_pages
       WHERE session_id = v_session_id;
    END IF;
  END LOOP;

  UPDATE public.scenario_setup_edits
     SET status = 'applied',
         applied_at = now(),
         applied_summary = p_bundle->'summary',
         error = NULL
   WHERE id = p_edit_id;

  RETURN 'applied';
END;
$$;

REVOKE ALL ON FUNCTION
  public.scenario_initial_state_md5(UUID),
  public.apply_scenario_setup_edit(UUID, TEXT, JSONB, BOOLEAN, INT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.scenario_initial_state_md5(UUID),
  public.apply_scenario_setup_edit(UUID, TEXT, JSONB, BOOLEAN, INT)
  TO service_role;

COMMIT;
