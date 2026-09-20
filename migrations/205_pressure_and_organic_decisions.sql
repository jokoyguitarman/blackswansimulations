-- Migration 205: pressure organisations (third page side) + organic executive decisions.
-- docs/pressure-organisations-plan.md §6.1 / docs/executive-decisions-organic-plan.md §3.2. Idempotent.
BEGIN;

-- 1. Org pages: a third role, AI-run with a register; spokesperson link; AI-operated offices ---------
ALTER TABLE sim_org_pages DROP CONSTRAINT IF EXISTS sim_org_pages_role_check;
ALTER TABLE sim_org_pages
  ADD CONSTRAINT sim_org_pages_role_check CHECK (role IN ('protagonist', 'antagonist', 'pressure'));
ALTER TABLE sim_org_pages ADD COLUMN IF NOT EXISTS spokesperson_stakeholder_id TEXT;
ALTER TABLE sim_org_pages ADD COLUMN IF NOT EXISTS register TEXT;
ALTER TABLE sim_org_pages ADD COLUMN IF NOT EXISTS kind TEXT;
ALTER TABLE sim_org_pages ADD COLUMN IF NOT EXISTS operation TEXT;

-- 2. Decision ledger head (reuse 203's session_decisions): detected-decision detail + status --------
ALTER TABLE session_decisions ADD COLUMN IF NOT EXISTS detail JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE session_decisions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE session_decisions DROP CONSTRAINT IF EXISTS session_decisions_status_check;
ALTER TABLE session_decisions
  ADD CONSTRAINT session_decisions_status_check CHECK (status IN ('active', 'dismissed', 'reversed'));

-- 3. Knowledge state per actor with provenance (organic plan §6.3) -----------------------------------
CREATE TABLE IF NOT EXISTS decision_knowledge (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id   UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  decision_id  UUID NOT NULL REFERENCES session_decisions(id) ON DELETE CASCADE,
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('stakeholder', 'group', 'page', 'crowd', 'team', 'player')),
  actor_id     TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('unaware', 'rumour', 'informed', 'officially_notified')),
  learned_from TEXT,
  learned_via  TEXT CHECK (learned_via IN ('direct_message', 'internal_relay', 'grievance_relay', 'public_exposure', 'formal_notice')),
  at_minute    INTEGER NOT NULL DEFAULT 0,
  ref_table    TEXT,
  ref_id       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, decision_id, actor_kind, actor_id)
);
CREATE INDEX IF NOT EXISTS idx_decision_knowledge_decision ON decision_knowledge (session_id, decision_id);
ALTER TABLE decision_knowledge ENABLE ROW LEVEL SECURITY;
-- Service-role only (no policies).

-- 4. Cascade event tree (organic plan §6.7 / handover §10.4) ------------------------------------------
CREATE TABLE IF NOT EXISTS decision_events (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id   UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  decision_id  UUID NOT NULL REFERENCES session_decisions(id) ON DELETE CASCADE,
  parent_id    UUID REFERENCES decision_events(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL CHECK (kind IN (
    'detected', 'told', 'found_out', 'notice_sent', 'reaction_planned', 'reaction_fired',
    'reaction_softened', 'reaction_withdrawn', 'reaction_delayed', 'public_effect', 'dismissed', 'reversed'
  )),
  actor_kind   TEXT,
  actor_id     TEXT,
  at_minute    INTEGER NOT NULL DEFAULT 0,
  ref_table    TEXT,
  ref_id       TEXT,
  summary      TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_decision_events_decision ON decision_events (session_id, decision_id, created_at);
ALTER TABLE decision_events ENABLE ROW LEVEL SECURITY;

-- 5. session_events vocabulary: full list from 203 + the new engine types ---------------------------
ALTER TABLE session_events DROP CONSTRAINT IF EXISTS session_events_event_type_check;
ALTER TABLE session_events ADD CONSTRAINT session_events_event_type_check CHECK (event_type IN (
  'decision', 'decision_executed', 'inject', 'inject_cancelled', 'ai_step_start', 'ai_step_end',
  'communication', 'resource_change', 'status_update', 'incident', 'media_post', 'message',
  'bomb_squad_sweep', 'patient_queue_processed', 'hazard_queue_processed',
  'quality_failure_inject_fired', 'zone_skip_violation', 'friction_inject_fired',
  'state_effect_managed', 'direction_intent',
  'trainer_alert', 'consequence_inject', 'antagonist_post', 'antagonist_reply',
  'extremist_post', 'extremist_reply', 'director_action', 'evaluator_result',
  'inject_modified', 'inject_delayed', 'stakeholder_verdict',
  'decision_recorded', 'obligation_met', 'obligation_lapsed',
  -- organic executive decisions (205)
  'decision_detected', 'decision_propagated', 'decision_dismissed', 'decision_reversed',
  -- pressure organisations / AI-operated offices (205)
  'pressure_post', 'pressure_reply', 'pressure_stand_down'
));

COMMIT;
