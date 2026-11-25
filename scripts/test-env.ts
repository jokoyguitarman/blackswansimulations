// Preloaded by `npm test` before any test module. server/env.ts requires a Supabase URL and
// key, and server/lib/supabaseAdmin.ts builds its client at import, so modules that only
// need pure helpers crash without them. These placeholders let the imports succeed; they
// always replace the real values so a unit test can never reach a real project. The
// address is loopback port 9 (discard), so any query that does slip through fails fast on
// this machine. Tests that need a live database must skip themselves.
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-placeholder-not-a-key';
