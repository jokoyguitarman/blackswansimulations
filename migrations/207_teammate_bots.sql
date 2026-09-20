-- Migration 207: AI teammate bots for the social media crisis module
-- (docs/ai-teammate-bots-plan.md §5).
--
--   * user_profiles.is_bot     — marks the pooled bot accounts so lobby, ledger and AAR can badge
--                                them. Every other consumer keeps treating them as participants.
--   * sessions.bot_intellect   — the single session-wide "bot intellect" slider (0-100). Read by the
--                                bot runtime at the start of every turn; null/absent means default 70.
--
-- The bot auth accounts themselves are NOT inserted here. They are created by the server through
-- the Supabase Admin API (teammates/accounts.ts) so GoTrue writes every auth.users column it needs
-- for password sign-in; hand-written auth.users rows (migration 147 style) are only safe for
-- accounts that never log in. Additive and idempotent.
BEGIN;

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_user_profiles_is_bot
  ON public.user_profiles (is_bot)
  WHERE is_bot;

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS bot_intellect SMALLINT DEFAULT 70;

ALTER TABLE public.sessions DROP CONSTRAINT IF EXISTS sessions_bot_intellect_range;
ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_bot_intellect_range
  CHECK (bot_intellect IS NULL OR (bot_intellect >= 0 AND bot_intellect <= 100));

COMMENT ON COLUMN public.user_profiles.is_bot IS
  'True for pooled AI teammate accounts (server-managed). Display-only flag; gameplay treats bots as participants.';
COMMENT ON COLUMN public.sessions.bot_intellect IS
  'Session-wide AI teammate skill slider, 0 (novice) to 100 (expert). See docs/ai-teammate-bots-plan.md §9.1.';

COMMIT;
