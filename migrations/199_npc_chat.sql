-- Migration 199: NPC-authored chat messages (stakeholder DMs in TeamChat).
-- Runtime plan §3.3. Idempotent.
--
-- chat_messages.sender_id becomes nullable; NPC rows carry sender_stakeholder_id instead.
-- Every row must still have exactly one kind of sender.

ALTER TABLE chat_messages ALTER COLUMN sender_id DROP NOT NULL;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS sender_stakeholder_id TEXT;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS sender_display_name TEXT;

ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_sender_present;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_sender_present
  CHECK (sender_id IS NOT NULL OR sender_stakeholder_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_chat_messages_stakeholder_sender
  ON chat_messages (session_id, sender_stakeholder_id) WHERE sender_stakeholder_id IS NOT NULL;

COMMENT ON COLUMN chat_messages.sender_stakeholder_id IS
  'initial_state.stakeholders[].id when the message was written by an NPC contact (sender_id NULL).';
