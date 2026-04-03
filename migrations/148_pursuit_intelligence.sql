-- Pursuit Intelligence System: response tracking for adversary sighting injects.
-- Tracks how teams respond to each sighting tip and scores against ground truth (is_false_lead).

CREATE TABLE IF NOT EXISTS session_pursuit_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sighting_pin_id UUID NOT NULL REFERENCES scenario_locations(id) ON DELETE CASCADE,
  inject_id UUID REFERENCES scenario_injects(id),
  adversary_id TEXT NOT NULL DEFAULT 'adversary_1',
  team_name TEXT NOT NULL,

  -- NATO Admiralty grading
  source_reliability CHAR(1) NOT NULL DEFAULT 'E',
  info_credibility CHAR(1) NOT NULL DEFAULT '5',
  nato_grade TEXT GENERATED ALWAYS AS (source_reliability || info_credibility) STORED,

  -- Ground truth (hidden from players until debunk)
  is_false_lead BOOLEAN NOT NULL DEFAULT false,

  -- Response tracking
  response_window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  response_window_end TIMESTAMPTZ,
  response_type TEXT NOT NULL DEFAULT 'pending'
    CHECK (response_type IN ('pending', 'committed', 'cautious', 'ignored', 'split')),
  decisions_committed UUID[] DEFAULT '{}',
  assets_deployed UUID[] DEFAULT '{}',

  -- Scoring
  score_impact TEXT
    CHECK (score_impact IS NULL OR score_impact IN (
      'good_commit', 'wasted_resources', 'good_caution', 'missed_lead', 'good_recovery'
    )),
  time_wasted_seconds INT DEFAULT 0,

  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spr_session ON session_pursuit_responses(session_id);
CREATE INDEX IF NOT EXISTS idx_spr_pending ON session_pursuit_responses(response_type)
  WHERE response_type = 'pending';
CREATE INDEX IF NOT EXISTS idx_spr_sighting ON session_pursuit_responses(sighting_pin_id);
