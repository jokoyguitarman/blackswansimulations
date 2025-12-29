-- Enable Supabase Realtime on critical tables for instant updates
-- This allows frontend components to subscribe to database changes
-- Realtime respects RLS policies automatically

-- Enable Realtime for chat_messages
-- Users will receive INSERT events for messages in channels they have access to
ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;

-- Enable Realtime for session_events
-- Users will receive INSERT events for events in sessions they participate in
-- This includes injects, decisions, resource changes, etc.
ALTER PUBLICATION supabase_realtime ADD TABLE session_events;

-- Enable Realtime for incidents
-- Users will receive INSERT/UPDATE events for incidents they can see
-- Visibility is controlled by RLS policies and role/team assignments
ALTER PUBLICATION supabase_realtime ADD TABLE incidents;

-- Enable Realtime for incident_assignments
-- Users will receive INSERT/UPDATE/DELETE events for assignments
-- This allows instant updates when incidents are assigned/unassigned
ALTER PUBLICATION supabase_realtime ADD TABLE incident_assignments;

-- Note: RLS policies must allow users to SELECT rows they should receive updates for
-- Realtime subscriptions automatically respect RLS policies

