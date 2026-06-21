-- Security hardening: the demo bot / demo trainer accounts seeded in migration 147
-- only ever act server-side via the service-role client (DemoActionDispatcher). They
-- never sign in interactively, yet migration 147 set a hardcoded, committed password.
--
-- This migration removes that password so the committed literal can never be used to
-- authenticate as one of these privileged accounts. Server-side automation is
-- unaffected because it uses the service-role key, not password login.

UPDATE auth.users
SET encrypted_password = NULL,
    updated_at = NOW()
WHERE email LIKE '%@blackswan.internal';
