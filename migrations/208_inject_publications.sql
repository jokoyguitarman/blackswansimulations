-- Migration 208: inject publication claims — publish each inject at most once per session.
-- docs/session-bugfix-spec-2026-09-20.md §12.
--
-- The inject scheduler only had an in-process lock; with two API processes on one database every
-- scheduled inject fired twice (duplicate chat lines, emails, posts). publishInjectToSession() now
-- claims (session_id, inject_id) here first and returns when the claim already exists.
-- Idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS inject_publications (
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  inject_id   UUID NOT NULL REFERENCES scenario_injects(id) ON DELETE CASCADE,
  claimed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_by  UUID,
  PRIMARY KEY (session_id, inject_id)
);
ALTER TABLE inject_publications ENABLE ROW LEVEL SECURITY;
-- Service-role only (no policies): the claim is a server-side lock, never read by clients.

COMMIT;
