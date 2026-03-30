-- Per-session location claims so that claiming exits in one session
-- does not bleed into other sessions using the same scenario.
CREATE TABLE IF NOT EXISTS session_location_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES scenario_locations(id) ON DELETE CASCADE,
  claimed_by_team TEXT NOT NULL,
  claimed_as TEXT NOT NULL,
  claim_exclusivity TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(session_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_session_location_claims_session
  ON session_location_claims(session_id);
