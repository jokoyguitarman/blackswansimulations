-- Migration 279: AI director proposals, session mode and seed.
-- NOT APPLIED. Applying this to the shared Supabase project needs the user's explicit approval.
-- Idempotent: safe to run twice.
-- Rollback (branch or local database only, never the shared project):
--   DROP TABLE IF EXISTS director_proposals;
--   ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_director_mode_check;
--   ALTER TABLE sessions DROP COLUMN IF EXISTS director_mode;
--   ALTER TABLE sessions DROP COLUMN IF EXISTS director_seed;
--   ALTER TABLE scenario_injects DROP CONSTRAINT IF EXISTS scenario_injects_generation_source_check;
--   ALTER TABLE scenario_injects ADD CONSTRAINT scenario_injects_generation_source_check CHECK (generation_source IN (
--     'migration','war_room','trainer','pathway_outcome','inaction_penalty','decision_response',
--     'matrix_friction','specificity_feedback','adversary_adaptation','pursuit_branch','witness_relay',
--     'deterioration_cycle','sentiment_positive','protocol_violation','editorial_feedback',
--     'stakeholder_modified','decision_consequence','sentiment_negative','transport_outcome',
--     'escalation_chain'
--   ));
BEGIN;

CREATE TABLE IF NOT EXISTS director_proposals (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id             UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq                    INTEGER NOT NULL,
  minute                 INTEGER NOT NULL,
  wake_reason            TEXT NOT NULL CHECK (wake_reason IN ('signals','periodic','trainer_request')),
  seed                   BIGINT,
  signals                JSONB NOT NULL DEFAULT '[]'::jsonb,
  observation            JSONB NOT NULL DEFAULT '{}'::jsonb,
  observation_sha256     TEXT,
  prompt_version         TEXT,
  prompt_text            TEXT,
  model                  TEXT,
  temperature            DOUBLE PRECISION,
  provider_seed_applied  BOOLEAN,
  raw_output             JSONB,
  proposal               JSONB,
  guardrails             JSONB NOT NULL DEFAULT '[]'::jsonb,
  consistency            JSONB,
  fairness               JSONB,
  auto_publish_at        TIMESTAMPTZ,
  status                 TEXT NOT NULL CHECK (status IN (
                           'proposed','approved','edited','vetoed','expired','auto_published',
                           'rejected_guardrail','no_action','failed','budget_denied'
                         )),
  mode                   TEXT NOT NULL CHECK (mode IN ('suggest','auto')),
  fairness_override      BOOLEAN NOT NULL DEFAULT false,
  decided_by             UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  decided_at             TIMESTAMPTZ,
  edit_before            JSONB,
  edit_after             JSONB,
  veto_reason            TEXT,
  inject_id              UUID REFERENCES scenario_injects(id) ON DELETE SET NULL,
  tokens_in              INTEGER,
  tokens_out             INTEGER,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_director_proposals_session_created
  ON director_proposals (session_id, created_at);

ALTER TABLE director_proposals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE director_proposals FROM anon, authenticated;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS director_mode TEXT;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_director_mode_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_director_mode_check
  CHECK (director_mode IN ('off','suggest','auto'));
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS director_seed BIGINT;

-- Runtime director copies use generation_source 'ai_director'.
-- Full list re-asserted from migration 272 (never drop values).
ALTER TABLE scenario_injects DROP CONSTRAINT IF EXISTS scenario_injects_generation_source_check;
ALTER TABLE scenario_injects ADD CONSTRAINT scenario_injects_generation_source_check CHECK (generation_source IN (
  'migration',
  'war_room',
  'trainer',
  'pathway_outcome',
  'inaction_penalty',
  'decision_response',
  'matrix_friction',
  'specificity_feedback',
  'adversary_adaptation',
  'pursuit_branch',
  'witness_relay',
  'deterioration_cycle',
  'sentiment_positive',
  'protocol_violation',
  'editorial_feedback',
  'stakeholder_modified',
  'decision_consequence',
  'sentiment_negative',
  'transport_outcome',
  'escalation_chain',
  'ai_director'
));

COMMIT;
