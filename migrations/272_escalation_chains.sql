-- Migration 272: escalation chains for unanswered injects.
-- NOT APPLIED. Applying this to the shared Supabase project needs the user's explicit approval.
-- Idempotent: safe to run twice.
-- Rollback (branch or local database only, never the shared project):
--   DROP TABLE IF EXISTS escalation_chain_steps;
--   DROP TABLE IF EXISTS escalation_chains;
--   ALTER TABLE scenario_injects DROP CONSTRAINT IF EXISTS scenario_injects_generation_source_check;
--   ALTER TABLE scenario_injects ADD CONSTRAINT scenario_injects_generation_source_check CHECK (generation_source IN (
--     'migration','war_room','trainer','pathway_outcome','inaction_penalty','decision_response',
--     'matrix_friction','specificity_feedback','adversary_adaptation','pursuit_branch','witness_relay',
--     'deterioration_cycle','sentiment_positive','protocol_violation','editorial_feedback',
--     'stakeholder_modified','decision_consequence','sentiment_negative','transport_outcome'
--   ));
BEGIN;

CREATE TABLE IF NOT EXISTS escalation_chains (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id                  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  root_delivery_id            UUID NOT NULL REFERENCES inject_deliveries(id) ON DELETE CASCADE,
  root_inject_id              UUID NOT NULL,
  root_key                    TEXT NOT NULL,
  scope_team                  TEXT,
  stakeholder_id              TEXT,
  config                      JSONB NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active','stopped','exhausted','cancelled')),
  steps_sent                  INTEGER NOT NULL DEFAULT 0,
  max_steps                   INTEGER NOT NULL,
  last_step_delivered_minute  INTEGER NOT NULL,
  next_due_minute             INTEGER,
  waiting_on_call_group_id    UUID,
  stopped_reason              TEXT CHECK (stopped_reason IN
                                ('response','relevant_response','passed_response','contact_elsewhere',
                                 'gave_up','session_ended','trainer')),
  stopped_by_response_id      UUID,
  stopped_minute              INTEGER,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (root_delivery_id)
);

CREATE INDEX IF NOT EXISTS idx_esc_chains_active ON escalation_chains (session_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_esc_chain_any ON escalation_chains (session_id, root_inject_id)
  WHERE scope_team IS NULL;

CREATE TABLE IF NOT EXISTS escalation_chain_steps (
  chain_id          UUID NOT NULL REFERENCES escalation_chains(id) ON DELETE CASCADE,
  step_no           INTEGER NOT NULL,
  inject_id         UUID REFERENCES scenario_injects(id) ON DELETE SET NULL,
  urgency           TEXT NOT NULL,
  app               TEXT NOT NULL,
  delivered_minute  INTEGER,
  content_mode      TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, step_no)
);

ALTER TABLE escalation_chains ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalation_chain_steps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE escalation_chains, escalation_chain_steps FROM anon, authenticated;

-- Runtime chain copies use generation_source 'escalation_chain'.
-- Full list re-asserted from migration 206 (never drop values).
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
  'escalation_chain'
));

COMMIT;
