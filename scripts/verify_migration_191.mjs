// Verification for migration 191 + scoring overhaul wiring.
// Read-only checks plus a guarded insert/cleanup probe (always deletes what it inserts).
// Run from repo root:  node scripts/verify_migration_191.mjs
import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

// Env lives in frontend/.env.local for this project.
loadEnv({ path: new URL('../frontend/.env.local', import.meta.url) });

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env');
  process.exit(1);
}
const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

let pass = 0;
let fail = 0;
const ok = (m) => {
  console.log('  PASS  ' + m);
  pass++;
};
const bad = (m) => {
  console.log('  FAIL  ' + m);
  fail++;
};

console.log('\n=== Migration 191 / scoring overhaul verification ===\n');

// 1. social_post_flags new columns exist
console.log('[1] social_post_flags reason columns');
{
  const { error } = await db
    .from('social_post_flags')
    .select('violation_category, reason_text, is_valid_report')
    .limit(1);
  if (error) bad('columns missing or not selectable: ' + error.message);
  else ok('violation_category, reason_text, is_valid_report all selectable');
}

// 2. Constraint probe: dispute_* and post_reported inserts must succeed now.
//    Uses a real session + user, tags rows as test, and deletes them in a finally block.
console.log('\n[2] player_actions action_type CHECK accepts new types');
{
  const { data: sess } = await db
    .from('sessions')
    .select('id')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data: usr } = await db.from('user_profiles').select('id').limit(1).maybeSingle();

  if (!sess || !usr) {
    console.log('  SKIP  no session/user available to probe FK-bound insert');
  } else {
    const probeTypes = ['dispute_filed', 'dispute_upheld', 'dispute_rejected', 'post_reported'];
    const insertedIds = [];
    try {
      for (const t of probeTypes) {
        const { data, error } = await db
          .from('player_actions')
          .insert({
            session_id: sess.id,
            player_id: usr.id,
            action_type: t,
            content: '__migration191_probe__',
            metadata: { __test__: true },
          })
          .select('id')
          .single();
        if (error) bad(`insert ${t} rejected: ${error.message}`);
        else {
          ok(`insert ${t} accepted`);
          insertedIds.push(data.id);
        }
      }
      // Negative control: a bogus type must still be rejected.
      const { error: bogusErr } = await db
        .from('player_actions')
        .insert({
          session_id: sess.id,
          player_id: usr.id,
          action_type: '__definitely_not_valid__',
          metadata: { __test__: true },
        })
        .select('id')
        .single();
      if (bogusErr) ok('bogus action_type correctly rejected (constraint active)');
      else bad('bogus action_type was ACCEPTED - constraint not enforced');
    } finally {
      if (insertedIds.length) {
        const { error: delErr } = await db.from('player_actions').delete().in('id', insertedIds);
        if (delErr) console.log('  WARN  cleanup failed, remove manually: ' + insertedIds.join(', '));
        else console.log('  (cleaned up ' + insertedIds.length + ' probe rows)');
      }
    }
  }
}

// 3. sim_emails has the grading column we write to (pre-existing, but confirm).
console.log('\n[3] sim_emails.sop_compliance_score present');
{
  const { error } = await db.from('sim_emails').select('sop_compliance_score').limit(1);
  if (error) bad('sop_compliance_score not selectable: ' + error.message);
  else ok('sop_compliance_score selectable');
}

// 4. Read-only sanity: latest social_media session current_state shape.
console.log('\n[4] live social_state shape (read-only)');
{
  const { data: s } = await db
    .from('sessions')
    .select('id, current_state, sim_mode, status')
    .eq('sim_mode', 'social_media')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!s) {
    console.log('  SKIP  no social_media session found yet');
  } else {
    const cs = s.current_state || {};
    const ss = cs.social_state || null;
    console.log(`  latest social session ${s.id} (status=${s.status})`);
    if (ss) {
      const keys = ['report_precision', 'time_to_first_statement_minutes', 'transparency_score'];
      for (const k of keys) {
        if (k in ss) ok(`social_state has new field: ${k}`);
        else console.log(`  INFO  social_state missing ${k} (will appear after next engine tick)`);
      }
    } else {
      console.log('  INFO  no social_state yet (engine has not ticked for this session)');
    }
    if (cs.crisis_standards) ok('current_state.crisis_standards present (watchdog ran)');
    else console.log('  INFO  no crisis_standards yet (watchdog runs ~2min into a live session)');
  }
}

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail > 0 ? 1 : 0);
