-- Migration 198: department (team) chat channels, NPC DM channel type, read cursors,
-- and channel-membership RLS for chat_messages.
--
-- Runtime plan §2.1 (docs/stakeholder-runtime-plan.md). Idempotent.
--
-- Behaviour change to note: the previous chat_messages SELECT policy let ANY session
-- participant read EVERY message in the session, which also meant Supabase Realtime pushed
-- direct-message rows to every connected client. The new policy checks channel membership,
-- so `direct`, `npc_direct`, `team` and `trainer` rows reach members only.

-- 1. Channel types + columns ---------------------------------------------------------------
ALTER TABLE chat_channels DROP CONSTRAINT IF EXISTS chat_channels_type_check;
ALTER TABLE chat_channels ADD CONSTRAINT chat_channels_type_check
  CHECK (type IN (
    'public', 'inter_agency', 'private', 'command', 'trainer', 'role_specific', 'direct',
    'team', 'npc_direct'
  ));

ALTER TABLE chat_channels ADD COLUMN IF NOT EXISTS team_name TEXT;
ALTER TABLE chat_channels ADD COLUMN IF NOT EXISTS stakeholder_id TEXT;

COMMENT ON COLUMN chat_channels.team_name IS
  'type = team: the session_teams.team_name whose members may read/post. Membership is derived live.';
COMMENT ON COLUMN chat_channels.stakeholder_id IS
  'type = npc_direct: initial_state.stakeholders[].id of the NPC on the other side of this DM.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_channels_team
  ON chat_channels (session_id, team_name) WHERE type = 'team';
CREATE INDEX IF NOT EXISTS idx_chat_channels_stakeholder
  ON chat_channels (session_id, stakeholder_id) WHERE type = 'npc_direct';
CREATE INDEX IF NOT EXISTS idx_chat_channels_session_type
  ON chat_channels (session_id, type);

-- 2. Read cursors (unread badges) ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_channel_reads (
  channel_id   UUID NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (channel_id, user_id)
);

ALTER TABLE chat_channel_reads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage their own read cursors" ON chat_channel_reads;
CREATE POLICY "Users manage their own read cursors" ON chat_channel_reads
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- 3. Channel access predicate --------------------------------------------------------------
-- Mirrored in TypeScript by server/lib/channelAccess.ts — keep the two in step.
CREATE OR REPLACE FUNCTION can_user_access_channel(p_channel_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM chat_channels c
    JOIN sessions s ON s.id = c.session_id
    WHERE c.id = p_channel_id
      AND (
        -- owning trainer / admins see everything
        s.trainer_id = p_user_id
        OR EXISTS (SELECT 1 FROM user_profiles up WHERE up.id = p_user_id AND up.role = 'admin')
        -- DMs (human or NPC): listed members only
        OR (c.type IN ('direct', 'npc_direct') AND c.members ? p_user_id::text)
        -- department channels: current members of that team
        OR (c.type = 'team' AND EXISTS (
              SELECT 1 FROM session_teams st
              WHERE st.session_id = c.session_id
                AND st.user_id = p_user_id
                AND st.team_name = c.team_name))
        -- everything else (public / inter_agency / command / private / role_specific):
        -- any session participant. `trainer` is intentionally excluded here.
        OR (c.type NOT IN ('direct', 'npc_direct', 'team', 'trainer')
            AND is_user_session_participant(c.session_id, p_user_id))
      )
  );
$$;

GRANT EXECUTE ON FUNCTION can_user_access_channel(UUID, UUID) TO authenticated;

-- 4. chat_messages SELECT policy ------------------------------------------------------------
DROP POLICY IF EXISTS "Session participants can view messages" ON chat_messages;
DROP POLICY IF EXISTS "Channel members can view messages" ON chat_messages;
CREATE POLICY "Channel members can view messages" ON chat_messages
  FOR SELECT USING (can_user_access_channel(channel_id, auth.uid()));

ANALYZE chat_channels;
ANALYZE chat_messages;
