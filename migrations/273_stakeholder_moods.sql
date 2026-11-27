-- Migration 273: stakeholder mood ladder state.
-- NOT APPLIED. Applying this to the shared Supabase project needs the user's explicit approval.
-- Idempotent: safe to run twice.
-- Rollback (branch or local database only, never the shared project):
--   DROP FUNCTION IF EXISTS claim_mood_consequence(UUID, TEXT, TEXT, TEXT, JSONB);
--   DROP FUNCTION IF EXISTS bump_mood_recovery(UUID, TEXT, TEXT);
--   DROP FUNCTION IF EXISTS consume_mood_recovery(UUID, TEXT, TEXT);
--   DROP TABLE IF EXISTS stakeholder_moods;
BEGIN;

CREATE TABLE IF NOT EXISTS stakeholder_moods (
  session_id             UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  stakeholder_id         TEXT NOT NULL,
  scope_team             TEXT NOT NULL DEFAULT '',
  rung_id                TEXT NOT NULL,
  episode_anchor_minute  INTEGER,
  entered_minute         INTEGER NOT NULL,
  profile                JSONB NOT NULL,
  history                JSONB NOT NULL DEFAULT '[]'::jsonb,
  consequences_fired     TEXT[] NOT NULL DEFAULT '{}',
  locks                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, stakeholder_id, scope_team)
);

ALTER TABLE stakeholder_moods ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE stakeholder_moods FROM anon, authenticated;

-- Appends one consequence id only while it is absent, and merges locks in the same statement.
CREATE OR REPLACE FUNCTION claim_mood_consequence(
  p_session_id UUID,
  p_stakeholder_id TEXT,
  p_scope_team TEXT,
  p_consequence_id TEXT,
  p_patch JSONB
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  updated INT;
BEGIN
  UPDATE stakeholder_moods
  SET
    consequences_fired = consequences_fired || ARRAY[p_consequence_id],
    locks = (
      COALESCE(locks, '{}'::jsonb)
      || (COALESCE(p_patch, '{}'::jsonb) - 'grievance_append')
    ) || jsonb_build_object(
      'grievance_append',
      COALESCE(locks->'grievance_append', '[]'::jsonb)
        || COALESCE(p_patch->'grievance_append', '[]'::jsonb)
    ),
    updated_at = NOW()
  WHERE session_id = p_session_id
    AND stakeholder_id = p_stakeholder_id
    AND scope_team = p_scope_team
    AND NOT (consequences_fired @> ARRAY[p_consequence_id]);
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated > 0;
END;
$$;

-- Adds one recovery step without replacing verdict, persuadability, or other locks.
CREATE OR REPLACE FUNCTION bump_mood_recovery(
  p_session_id UUID,
  p_stakeholder_id TEXT,
  p_scope_team TEXT
) RETURNS VOID
LANGUAGE sql
AS $$
  UPDATE stakeholder_moods
  SET locks = jsonb_set(
        COALESCE(locks, '{}'::jsonb),
        '{pending_recovery_steps}',
        to_jsonb(COALESCE((locks->>'pending_recovery_steps')::int, 0) + 1)
      ),
      updated_at = NOW()
  WHERE session_id = p_session_id
    AND stakeholder_id = p_stakeholder_id
    AND scope_team = p_scope_team;
$$;

-- Drops only the recovery counter. Every other lock stays.
CREATE OR REPLACE FUNCTION consume_mood_recovery(
  p_session_id UUID,
  p_stakeholder_id TEXT,
  p_scope_team TEXT
) RETURNS VOID
LANGUAGE sql
AS $$
  UPDATE stakeholder_moods
  SET locks = COALESCE(locks, '{}'::jsonb) - 'pending_recovery_steps',
      updated_at = NOW()
  WHERE session_id = p_session_id
    AND stakeholder_id = p_stakeholder_id
    AND scope_team = p_scope_team;
$$;

REVOKE ALL ON FUNCTION claim_mood_consequence(UUID, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION bump_mood_recovery(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION consume_mood_recovery(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_mood_consequence(UUID, TEXT, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION bump_mood_recovery(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION consume_mood_recovery(UUID, TEXT, TEXT) TO service_role;

COMMIT;
