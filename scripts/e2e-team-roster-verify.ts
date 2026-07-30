import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

/**
 * Live end-to-end verification of the custom team roster feature.
 *
 * Run with the backend listening on :3001:
 *   npx tsx scripts/e2e-team-roster-verify.ts
 *
 * Flow:
 *  1. Provision the e2e trainer, grant credits.
 *  2. GET team-catalog (preset cards for the wizard).
 *  3. Reject an invalid roster (two public voices) with 400 — no AI, no credit.
 *  4. Run REAL generation (generate-storyline) with a roster of
 *     Communications (preset) + "Franchise Relations" (custom, public voice):
 *     charters adapted/synthesized, per-team storylines for the actual roster.
 *  5. Compile with those charters — including one deliberately invalid
 *     detection_action_type to prove server-side sanitization.
 *  6. DB assertions: scenario_teams flags, valid detection vocabulary,
 *     strategic benchmarks include the custom team, storyline injects target
 *     roster teams only.
 *  7. Post-compile edits: expected-action edit triggers benchmark recompute;
 *     public-voice reassignment clears the flag on the previous holder.
 */

const API = process.env.E2E_API_URL ?? 'http://localhost:3001';
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const EMAIL = 'e2e-editverify-trainer@loadtest.example.com';
const PASSWORD = process.env.LOADTEST_PASSWORD ?? 'LoadTest#Harness!2026';

const ALLOWED_DETECTION = new Set([
  'post_created',
  'reply_posted',
  'post_liked',
  'post_reposted',
  'post_flagged',
  'post_reported',
  'dm_sent',
  'dm_read',
  'email_sent',
  'email_read',
  'call_answered',
  'call_declined',
  'news_read',
  'fact_checked',
  'draft_created',
  'draft_submitted_for_approval',
  'draft_approved',
  'draft_published',
  'escalated',
  'chat_message_sent',
  'content_graded',
  'misinfo_flagged',
  'group_post_created',
  'group_joined',
  'event_created',
  'event_responded',
  'event_discussed',
  'dispute_filed',
  'dispute_upheld',
  'dispute_rejected',
]);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let token = '';
async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

async function provisionTrainer(): Promise<string> {
  const signIn = async () => {
    const c = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return c.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  };
  let res = await signIn();
  if (res.error) {
    const { error } = await admin.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: 'E2E Edit Verify Trainer', agency_name: 'E2E' },
    });
    if (error && !/already/i.test(error.message)) throw new Error(error.message);
    await sleep(1000);
    res = await signIn();
    if (res.error) throw new Error(`sign-in failed: ${res.error.message}`);
  }
  const userId = res.data.user!.id;
  await admin.auth.admin.updateUserById(userId, {
    app_metadata: { role: 'trainer', agency: 'E2E' },
  });
  await admin.from('user_profiles').update({ role: 'trainer' }).eq('id', userId);
  const res2 = await signIn();
  if (res2.error) throw new Error(`re-sign-in failed: ${res2.error.message}`);
  token = res2.data.session!.access_token;
  return userId;
}

async function setBalance(trainerId: string, type: 'scenario' | 'session', target: number) {
  const { data } = await admin
    .from('credit_ledger')
    .select('delta')
    .eq('trainer_id', trainerId)
    .eq('credit_type', type);
  const current = (data ?? []).reduce((s, r) => s + (r.delta as number), 0);
  const diff = target - current;
  if (diff === 0) return;
  const rows = Array.from({ length: Math.abs(diff) }, () => ({
    trainer_id: trainerId,
    credit_type: type,
    delta: diff > 0 ? 1 : -1,
    reason: 'admin_adjustment',
  }));
  const { error } = await admin.from('credit_ledger').insert(rows);
  if (error) throw new Error(`credit adjust failed: ${error.message}`);
}

const CUSTOM_TEAM = 'Franchise Relations';
const CUSTOM_DESC =
  'Manages relationships with franchise owners: answers their concerns during the crisis, keeps them supplied with verified talking points for their local customers, and relays franchisee-side intel back to HQ.';

async function main() {
  console.log('== E2E custom team roster verification ==');

  console.log('\n[1] Provisioning trainer + credits...');
  const trainerId = await provisionTrainer();
  await setBalance(trainerId, 'scenario', 1);
  await setBalance(trainerId, 'session', 1);

  // ── Team catalog ──
  console.log('\n[2] Team catalog endpoint...');
  const catRes = await apiFetch('/api/warroom/social-crisis/team-catalog');
  const catalog = catRes.ok ? ((await catRes.json()).data as Array<Record<string, unknown>>) : [];
  check(
    'Team catalog returns the 4 presets',
    catalog.length === 4 && catalog.some((c) => c.team_name === 'Communications'),
    catalog.map((c) => c.team_name).join(', '),
  );

  // ── Invalid roster rejected before any AI ──
  console.log('\n[3] Invalid roster rejection...');
  const badRes = await apiFetch('/api/warroom/social-crisis/generate-storyline', {
    method: 'POST',
    body: JSON.stringify({
      crisis_type: 'test',
      context: 'test',
      personas: [],
      fact_sheet: { confirmed_facts: [], unconfirmed_claims: [] },
      team_roster: [
        { team_name: 'Communications', is_custom: false, is_public_voice: true },
        {
          team_name: CUSTOM_TEAM,
          description: CUSTOM_DESC,
          is_custom: true,
          is_public_voice: true,
        },
      ],
    }),
  });
  check('Two public voices rejected with 400', badRes.status === 400, `HTTP ${badRes.status}`);

  // ── Real generation with a mixed roster ──
  console.log('\n[4] Live generation with Communications + custom team (AI, may take minutes)...');
  const personas = [
    {
      handle: '@franchise_freddy',
      name: 'Freddy Lim',
      type: 'npc_public',
      personality: 'Anxious franchise owner, posts publicly when worried.',
      bias: 'none',
      follower_count: 900,
      backstory: 'Owns two outlets',
      specific_claims: [],
    },
    {
      handle: '@makan_watch',
      name: 'Makan Watch',
      type: 'npc_media',
      personality: 'Food-scene news account, quick to amplify.',
      bias: 'sensationalist',
      follower_count: 41000,
      backstory: 'Anonymous admin team',
      specific_claims: [],
    },
  ];
  const factSheet = {
    confirmed_facts: ['All outlets passed inspection on 28 July.'],
    unconfirmed_claims: [
      {
        claim: 'An outlet used expired stock.',
        status: 'FALSE',
        truth: 'Stock rotation logs are clean.',
      },
    ],
  };

  const genRes = await apiFetch('/api/warroom/social-crisis/generate-storyline', {
    method: 'POST',
    body: JSON.stringify({
      crisis_type: 'Food safety rumor hitting a franchise restaurant chain',
      context:
        'A viral post claims a franchise outlet served expired food. Franchise owners are panicking; HQ must respond. (E2E roster verification)',
      country: 'Singapore',
      org_name: 'WokHey Group',
      duration: 60,
      personas,
      fact_sheet: factSheet,
      team_roster: [
        { team_name: 'Communications', is_custom: false, is_public_voice: false },
        {
          team_name: CUSTOM_TEAM,
          description: CUSTOM_DESC,
          is_custom: true,
          is_public_voice: true,
        },
      ],
    }),
  });
  if (!genRes.ok) throw new Error(`generate-storyline failed: ${await genRes.text()}`);
  const ndjson = await genRes.text();
  let genComplete: Record<string, unknown> | null = null;
  for (const line of ndjson.split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'complete') genComplete = msg;
      if (msg.type === 'error') throw new Error(`generation error: ${msg.message}`);
    } catch (e) {
      if ((e as Error).message?.startsWith('generation error')) throw e;
    }
  }
  if (!genComplete) throw new Error('generate-storyline stream had no complete message');

  const charters = (genComplete.team_charters || []) as Array<Record<string, unknown>>;
  const teamStorylines = (genComplete.team_storylines || {}) as Record<
    string,
    Array<Record<string, unknown>>
  >;
  const customCharter = charters.find((c) => c.team_name === CUSTOM_TEAM);
  const commsCharter = charters.find((c) => c.team_name === 'Communications');

  check('Charters returned for both roster teams', charters.length === 2);
  check(
    'Custom charter synthesized (is_custom + public voice + rubric)',
    !!customCharter &&
      customCharter.is_custom === true &&
      customCharter.can_post_publicly === true &&
      String(customCharter.scoring_rubric || '').length > 20,
  );
  const customActions = (customCharter?.expected_actions || []) as Array<Record<string, unknown>>;
  check(
    'Custom expected actions non-empty, all in detection vocabulary',
    customActions.length > 0 &&
      customActions.every((a) => ALLOWED_DETECTION.has(String(a.detection_action_type))),
    customActions.map((a) => a.detection_action_type).join(', '),
  );
  check(
    'Preset kept catalog machinery, public voice moved off Communications',
    !!commsCharter && commsCharter.can_post_publicly === false,
  );
  check(
    'Per-team storyline generated for the custom team',
    (teamStorylines[CUSTOM_TEAM] || []).length > 0,
    `${(teamStorylines[CUSTOM_TEAM] || []).length} injects`,
  );

  // ── Compile with the generated charters (+ a poisoned detection type) ──
  console.log('\n[5] Compile with roster charters (one invalid detection type injected)...');
  const poisonedCharters = charters.map((c) =>
    c.team_name === CUSTOM_TEAM
      ? {
          ...c,
          expected_actions: [
            ...((c.expected_actions || []) as Array<Record<string, unknown>>),
            {
              action_id: 'poison_test',
              description: 'This uses a detection type that does not exist',
              detection_action_type: 'telepathy_used',
              timing_benchmark_minutes: 10,
              weight: 20,
              tier: 2,
            },
          ],
        }
      : c,
  );

  const compileRes = await apiFetch('/api/warroom/social-crisis/compile', {
    method: 'POST',
    body: JSON.stringify({
      narrative: {
        title: 'E2E VERIFY — Franchise Food Safety Rumor',
        description: 'Roster-verification scenario compiled by the automated test.',
        briefing: 'Respond to the food safety rumor. Automated verification scenario.',
      },
      crisis_type: 'Food safety rumor hitting a franchise restaurant chain',
      org_name: 'WokHey Group',
      country: 'Singapore',
      duration: 60,
      objectives: [
        {
          objective_id: 'protect_franchisees',
          objective_name: 'Keep franchisees informed and calm',
          description: 'Franchise Relations relays verified facts before owners go public.',
          weight: 50,
        },
        {
          objective_id: 'counter_rumor',
          objective_name: 'Counter the expired-stock rumor',
          description: 'Communications publishes a fact-based response.',
          weight: 50,
        },
      ],
      personas,
      fact_sheet: factSheet,
      communities: ['Franchise owners'],
      team_storylines: teamStorylines,
      team_charters: poisonedCharters,
      storyline_injects: genComplete.injects || [],
      shared_injects: [],
      convergence_gates: [],
      org_page: {
        facebook: {
          page_name: 'WokHey Group',
          page_handle: 'wokhey.sg',
          page_bio: 'Wok-fresh across 40 outlets.',
          follower_count: 22000,
        },
        x_twitter: {
          page_name: 'WokHey',
          page_handle: '@wokhey_sg',
          page_bio: 'Official WokHey account.',
          follower_count: 9000,
        },
        branded_history: [],
      },
    }),
  });
  if (!compileRes.ok) throw new Error(`compile start failed: ${await compileRes.text()}`);
  const { job_id } = (await compileRes.json()) as { job_id: string };

  let scenarioId = '';
  for (let i = 0; i < 100; i++) {
    await sleep(3000);
    const js = await (await apiFetch(`/api/warroom/social-crisis/job-status/${job_id}`)).json();
    if (js.status === 'completed') {
      scenarioId = js.data.scenario_id;
      break;
    }
    if (js.status === 'failed') throw new Error(`compile failed: ${js.error}`);
    if (i % 5 === 0) console.log('    compiling...');
  }
  if (!scenarioId) throw new Error('compile timed out');
  check('Compile persisted the roster scenario', true, scenarioId);

  // ── DB assertions ──
  console.log('\n[6] Database assertions...');
  const { data: teamRows } = await admin
    .from('scenario_teams')
    .select('team_name, charter, expected_actions, scoring_rubric')
    .eq('scenario_id', scenarioId);
  check('scenario_teams has exactly the 2 roster teams', (teamRows ?? []).length === 2);

  const customRow = (teamRows ?? []).find((t) => t.team_name === CUSTOM_TEAM);
  const commsRow = (teamRows ?? []).find((t) => t.team_name === 'Communications');
  const customRowCharter = (customRow?.charter || {}) as Record<string, unknown>;
  const commsRowCharter = (commsRow?.charter || {}) as Record<string, unknown>;
  check(
    'Custom row persisted with is_custom + can_post_publicly',
    customRowCharter.is_custom === true && customRowCharter.can_post_publicly === true,
  );
  check(
    'Communications row persisted with can_post_publicly=false',
    commsRowCharter.can_post_publicly === false,
  );

  const persistedActions = (customRow?.expected_actions || []) as Array<Record<string, unknown>>;
  check(
    'Poisoned detection type stripped at compile; valid actions kept',
    persistedActions.length > 0 &&
      persistedActions.every((a) => ALLOWED_DETECTION.has(String(a.detection_action_type))) &&
      !persistedActions.some((a) => a.action_id === 'poison_test'),
    persistedActions.map((a) => a.detection_action_type).join(', '),
  );

  const { data: scenRow } = await admin
    .from('scenarios')
    .select('initial_state')
    .eq('id', scenarioId)
    .single();
  const benchmarks = ((scenRow?.initial_state as Record<string, unknown>)?.strategic_benchmarks ||
    []) as Array<Record<string, unknown>>;
  check(
    'Strategic benchmarks include the custom team',
    benchmarks.some((b) => b.team === CUSTOM_TEAM),
    `${benchmarks.length} benchmarks total`,
  );

  const { data: injectRows } = await admin
    .from('scenario_injects')
    .select('inject_scope, target_teams')
    .eq('scenario_id', scenarioId)
    .is('session_id', null);
  const rosterNames = new Set(['Communications', CUSTOM_TEAM]);
  const badTargets = (injectRows ?? []).filter(
    (i) =>
      i.inject_scope === 'team_specific' &&
      ((i.target_teams || []) as string[]).some((t) => !rosterNames.has(t)),
  );
  check(
    'All team-specific injects target roster teams only',
    badTargets.length === 0,
    `${(injectRows ?? []).length} injects checked`,
  );

  // ── Post-compile edits ──
  console.log('\n[7] Post-compile edits (expected actions + public voice)...');
  const teamsApi = (await (await apiFetch(`/api/scenarios/${scenarioId}/teams`)).json())
    .data as Array<Record<string, unknown>>;
  const customApi = teamsApi.find((t) => t.team_name === CUSTOM_TEAM)!;
  const commsApi = teamsApi.find((t) => t.team_name === 'Communications')!;

  const editRes = await apiFetch(`/api/scenarios/${scenarioId}/teams/${customApi.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      expected_actions: [
        {
          action_id: 'fr_owner_dm',
          description: 'Answer franchise owner DMs with verified facts',
          detection_action_type: 'dm_sent',
          timing_benchmark_minutes: 15,
          weight: 50,
          tier: 2,
        },
        {
          action_id: 'fr_invalid',
          description: 'Invalid detection type should be dropped',
          detection_action_type: 'mind_reading',
          timing_benchmark_minutes: 10,
          weight: 25,
          tier: 1,
        },
        {
          action_id: 'fr_relay',
          description: 'Relay franchisee intel to HQ chat',
          detection_action_type: 'chat_message_sent',
          timing_benchmark_minutes: 30,
          weight: 50,
          tier: 3,
        },
      ],
    }),
  });
  const editedTeam = (await editRes.json()).data as Record<string, unknown>;
  const editedActions = (editedTeam.expected_actions || []) as Array<Record<string, unknown>>;
  check(
    'Expected-action edit sanitized (invalid dropped, 2 kept)',
    editRes.ok &&
      editedActions.length === 2 &&
      editedActions.every((a) => ALLOWED_DETECTION.has(String(a.detection_action_type))),
    editedActions.map((a) => a.action_id).join(', '),
  );

  const { data: scenAfter } = await admin
    .from('scenarios')
    .select('initial_state')
    .eq('id', scenarioId)
    .single();
  const benchAfter = ((scenAfter?.initial_state as Record<string, unknown>)?.strategic_benchmarks ||
    []) as Array<Record<string, unknown>>;
  const customBench = benchAfter.filter((b) => b.team === CUSTOM_TEAM);
  check(
    'Benchmarks recomputed from edited expected actions',
    customBench.length === 2 && customBench.some((b) => b.action_id === 'fr_owner_dm'),
    customBench.map((b) => b.action_id).join(', '),
  );

  const unsetRes = await apiFetch(`/api/scenarios/${scenarioId}/teams/${customApi.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ can_post_publicly: false }),
  });
  check('Directly unsetting the public voice rejected (400)', unsetRes.status === 400);

  const voiceRes = await apiFetch(`/api/scenarios/${scenarioId}/teams/${commsApi.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ can_post_publicly: true }),
  });
  check('Public voice reassigned to Communications', voiceRes.ok);
  const { data: teamsAfterVoice } = await admin
    .from('scenario_teams')
    .select('team_name, charter')
    .eq('scenario_id', scenarioId);
  const voiceHolders = (teamsAfterVoice ?? []).filter(
    (t) => ((t.charter || {}) as Record<string, unknown>).can_post_publicly === true,
  );
  check(
    'Exactly one public voice after reassignment',
    voiceHolders.length === 1 && voiceHolders[0].team_name === 'Communications',
    voiceHolders.map((t) => t.team_name).join(', '),
  );

  // ── Summary ──
  const failed = results.filter((r) => !r.ok);
  console.log('\n==================================================');
  console.log(`Results: ${results.length - failed.length}/${results.length} passed`);
  for (const f of failed) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  console.log(`Scenario: ${scenarioId}`);
  console.log('(Left in DB for inspection — titled "E2E VERIFY ...")');
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('E2E roster verification aborted:', err);
  process.exit(1);
});
