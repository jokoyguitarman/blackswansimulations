-- Voice calls and recordings for P2P WebRTC voice chat
CREATE TABLE IF NOT EXISTS voice_calls (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  initiated_by UUID NOT NULL REFERENCES user_profiles(id),
  participants JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended'))
);

CREATE INDEX idx_voice_calls_session ON voice_calls(session_id);

CREATE TABLE IF NOT EXISTS voice_recordings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  call_id UUID NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES user_profiles(id),
  storage_path TEXT NOT NULL,
  duration_seconds REAL,
  transcript TEXT,
  transcribed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_voice_recordings_call ON voice_recordings(call_id);
CREATE INDEX idx_voice_recordings_session ON voice_recordings(session_id);

-- Extend chat_messages type CHECK to include voice_transcript
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_type_check;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_type_check
  CHECK (type IN ('text', 'system', 'sitrep', 'alert', 'voice_transcript'));
