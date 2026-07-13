import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

/**
 * Live end-to-end verification of the trainer scenario-editing feature
 * (social media crisis, phase 1).
 *
 * Run with the backend already listening on :3001:
 *   npx tsx scripts/e2e-scenario-edit-verify.ts
 *
 * What it does, in order:
 *  1. Provisions a trainer test account (e2e-editverify-trainer@...) and JWT.
 *  2. Grants 1 scenario credit, compiles a small hand-built social scenario
 *     through the REAL compile endpoint (skips charter AI by sending charters).
 *  3. Verifies the edit lock: locked at 0 session credits, unlocked after top-up.
 *  4. Exercises every edit endpoint: inject PATCH (incl. unknown-team downgrade),
 *     scenario initial_state PATCH (persona/fact/org edits), team charter PATCH,
 *     objective PATCH (+ scenarios.objectives sync), inject create/delete,
 *     image regeneration.
 *  5. Creates a session, edits AFTER create, starts the session, and verifies
 *     the start-time re-sync (current_state + sim_org_pages pick up the edits).
 *  6. Verifies the live-session lock, then waits for the inject scheduler to
 *     fire the edited inject and checks the social_posts row carries the
 *     edited content and author.
 *  7. Completes the session, verifies the lock reopens, then drains credits
 *     and verifies it locks again.
 *
 * The scenario/session are left in the DB (titled "E2E VERIFY ...") for
 * manual inspection; delete them from the UI afterwards.
 */

const API = process.env.E2E_API_URL ?? 'http://localhost:3001';
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const EMAIL = 'e2e-editverify-trainer@loadtest.example.com';
const PASSWORD = process.env.LOADTEST_PASSWORD ?? 'LoadTest#Harness!2026';

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

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

  // Re-sign-in so the JWT carries the trainer app_metadata role.
  const res2 = await signIn();
  if (res2.error) throw new Error(`re-sign-in failed: ${res2.error.message}`);
  token = res2.data.session!.access_token;
  return userId;
}

async function grantCredits(trainerId: string, type: 'scenario' | 'session', delta: number) {
  const rows = [];
  const per = delta > 0 ? 1 : -1;
  for (let i = 0; i < Math.abs(delta); i++) {
    rows.push({ trainer_id: trainerId, credit_type: type, delta: per, reason: 'admin_adjustment' });
  }
  const { error } = await admin.from('credit_ledger').insert(rows);
  if (error) throw new Error(`credit grant failed: ${error.message}`);
}

async function getBalance(trainerId: string, type: 'scenario' | 'session'): Promise<number> {
  const { data } = await admin
    .from('credit_ledger')
    .select('delta')
    .eq('trainer_id', trainerId)
    .eq('credit_type', type);
  return (data ?? []).reduce((s, r) => s + (r.delta as number), 0);
}

// ─── Compile payload (hand-built; charters provided so no charter AI call) ───

const FIXED_TEAMS = ['Communications', 'Procurement', 'Sales', 'Legal'];

function buildCompileBody() {
  const mkInject = (
    t: number | undefined,
    title: string,
    content: string,
    author: string,
    extra: Record<string, unknown> = {},
  ) => ({
    trigger_time_minutes: t,
    type: 'social_post',
    title,
    content,
    severity: 'medium',
    inject_scope: 'universal',
    target_teams: [],
    requires_response: false,
    delivery_config: { app: 'social_feed', platform: 'x_twitter', author_handle: author },
    ...extra,
  });

  return {
    narrative: {
      title: 'E2E VERIFY — Bottled Water Contamination Rumor',
      description:
        'A viral claim alleges AquaPure bottled water is contaminated. Verification scenario created by the automated edit-feature test.',
      briefing: 'Respond to the contamination rumor. This is an automated verification scenario.',
    },
    crisis_type: 'product_contamination_rumor',
    org_name: 'AquaPure',
    country: 'Singapore',
    duration: 60,
    objectives: [
      {
        objective_id: 'contain_narrative',
        objective_name: 'Contain the false narrative',
        description: 'Counter the contamination rumor with verified facts.',
        weight: 60,
      },
      {
        objective_id: 'maintain_trust',
        objective_name: 'Maintain public trust',
        description: 'Keep public trust above collapse threshold.',
        weight: 40,
      },
    ],
    personas: [
      {
        handle: '@citywatch_sg',
        name: 'City Watch SG',
        type: 'npc_media',
        personality: 'Fast-moving citizen news account, reposts unverified claims.',
        bias: 'sensationalist',
        follower_count: 52000,
        image_prompts: [],
      },
      {
        handle: '@e2eskeptic',
        name: 'Skeptical Sam',
        type: 'npc_public',
        personality: 'Asks pointed questions, demands evidence.',
        bias: 'none',
        follower_count: 800,
        image_prompts: [],
      },
      {
        handle: '@health_hoax_hunter',
        name: 'Hoax Hunter',
        type: 'npc_public',
        personality: 'Debunks health misinformation with sources.',
        bias: 'none',
        follower_count: 4300,
        image_prompts: [],
      },
    ],
    fact_sheet: {
      confirmed_facts: [
        'All AquaPure batches passed SFA testing on 10 July.',
        'No hospital has reported contamination-linked admissions.',
      ],
      unconfirmed_claims: [
        {
          claim: 'A child was hospitalised after drinking AquaPure.',
          status: 'FALSE',
          truth: 'No such admission exists; the photo is from 2019.',
        },
      ],
    },
    communities: ['Parents groups', 'Hawker suppliers'],
    team_storylines: {
      Communications: [
        mkInject(
          3,
          'Press inquiry lands',
          'Reporter asks for comment on the rumor.',
          '@citywatch_sg',
          {
            inject_scope: 'team_specific',
            target_teams: ['Communications'],
            delivery_config: { app: 'email', author_handle: '@citywatch_sg' },
          },
        ),
      ],
    },
    team_charters: FIXED_TEAMS.map((name) => ({
      team_name: name,
      mission: `${name} mission for the AquaPure rumor response (E2E).`,
      responsibilities: [`Handle ${name.toLowerCase()} duties during the rumor crisis.`],
    })),
    storyline_injects: [
      mkInject(
        0,
        'Rumor breaks',
        'BREAKING: contamination claim spreading about AquaPure.',
        '@citywatch_sg',
      ),
      mkInject(
        2,
        'Bogus team target',
        'This inject targets a team that does not exist.',
        '@e2eskeptic',
        { inject_scope: 'team_specific', target_teams: ['Ghost Team'] },
      ),
      mkInject(45, 'Late follow-up', 'Rumor resurfaces in parents group.', '@citywatch_sg'),
    ],
    shared_injects: [],
    convergence_gates: [],
    dimension_labels: {
      public_trust: 'Public Trust',
      community_safety: 'Community Safety',
      narrative_control: 'Narrative Control',
      escalation_risk: 'Escalation Risk',
    },
    org_page: {
      facebook: {
        page_name: 'AquaPure SG',
        page_handle: 'aquapure.sg',
        page_bio: 'Pure water, transparent process.',
        follower_count: 12000,
      },
      x_twitter: {
        page_name: 'AquaPure',
        page_handle: '@aquapure_sg',
        page_bio: 'Official AquaPure account.',
        follower_count: 8000,
      },
      branded_history: [
        {
          content: 'Factory open day this weekend — come see how AquaPure is made!',
          platform: 'facebook',
          post_format: 'announcement',
          days_ago: 6,
        },
      ],
    },
  };
}

// ─── Main flow ───────────────────────────────────────────────────────────────

async function main() {
  console.log('== E2E scenario-edit verification ==');

  console.log('\n[1] Provisioning trainer...');
  const trainerId = await provisionTrainer();
  console.log(`    trainer ${trainerId}`);

  // Zero out any leftover credits from previous runs for deterministic checks.
  const scen0 = await getBalance(trainerId, 'scenario');
  const sess0 = await getBalance(trainerId, 'session');
  if (scen0 !== 0) await grantCredits(trainerId, 'scenario', -scen0);
  if (sess0 !== 0) await grantCredits(trainerId, 'session', -sess0);
  await grantCredits(trainerId, 'scenario', 1);

  console.log('\n[2] Compiling scenario via real compile endpoint...');
  const compileRes = await apiFetch('/api/warroom/social-crisis/compile', {
    method: 'POST',
    body: JSON.stringify(buildCompileBody()),
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
  console.log(`    scenario ${scenarioId}`);
  check('Compile persisted a scenario', true, scenarioId);

  // ── Lock: 0 session credits ──
  console.log('\n[3] Edit lock at 0 session credits...');
  let ed = (await (await apiFetch(`/api/scenarios/${scenarioId}/editability`)).json()).data;
  check(
    'Locked when session credits = 0',
    ed.editable === false && ed.reason === 'no_session_credits',
    JSON.stringify(ed),
  );

  const injects0 = (await (await apiFetch(`/api/scenarios/${scenarioId}/injects`)).json())
    .data as Array<Record<string, unknown>>;
  const t0 = injects0.find((i) => i.title === 'Rumor breaks')!;
  const lockedPatch = await apiFetch(`/api/scenarios/${scenarioId}/injects/${t0.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ content: 'should be rejected' }),
  });
  check('Inject PATCH rejected while locked (423)', lockedPatch.status === 423);

  await grantCredits(trainerId, 'session', 2);
  ed = (await (await apiFetch(`/api/scenarios/${scenarioId}/editability`)).json()).data;
  check(
    'Unlocked after credit top-up',
    ed.editable === true && ed.session_credits === 2,
    JSON.stringify(ed),
  );

  // ── Compile-time team-targeting sanitize ──
  const bogus = injects0.find((i) => i.title === 'Bogus team target')!;
  check(
    'Compile downgraded unknown-team inject to universal',
    bogus.inject_scope === 'universal' && (bogus.target_teams as string[]).length === 0,
    `scope=${bogus.inject_scope}`,
  );

  // ── Inject edits ──
  console.log('\n[4] Inject editing...');
  const editRes = await apiFetch(`/api/scenarios/${scenarioId}/injects/${t0.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      title: 'Rumor breaks (EDITED)',
      content: 'EDITED-MARKER-1: contamination claim now names a specific school.',
      delivery_config: {
        app: 'social_feed',
        platform: 'x_twitter',
        author_handle: '@e2eskeptic',
        author_display_name: 'Skeptical Sam',
      },
    }),
  });
  const edited = (await editRes.json()).data;
  check(
    'Inject PATCH applied + stamped trainer',
    editRes.ok &&
      edited.content.startsWith('EDITED-MARKER-1') &&
      edited.generation_source === 'trainer' &&
      (edited.delivery_config as Record<string, unknown>).author_handle === '@e2eskeptic',
  );

  const ghostRes = await apiFetch(`/api/scenarios/${scenarioId}/injects/${t0.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ inject_scope: 'team_specific', target_teams: ['Ghost Team'] }),
  });
  const ghost = (await ghostRes.json()).data;
  check(
    'Edit-time unknown-team downgrade to universal',
    ghostRes.ok &&
      ghost.inject_scope === 'universal' &&
      (ghost.target_teams as string[]).length === 0,
  );

  const validTeamRes = await apiFetch(`/api/scenarios/${scenarioId}/injects/${bogus.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ inject_scope: 'team_specific', target_teams: ['Legal', 'Ghost'] }),
  });
  const validTeam = (await validTeamRes.json()).data;
  check(
    'Edit-time targeting keeps known team, drops unknown',
    validTeamRes.ok &&
      validTeam.inject_scope === 'team_specific' &&
      JSON.stringify(validTeam.target_teams) === JSON.stringify(['Legal']),
  );

  const createRes = await apiFetch(`/api/scenarios/${scenarioId}/injects`, {
    method: 'POST',
    body: JSON.stringify({
      title: 'Trainer-added inject',
      content: 'TRAINER-ADDED-MARKER: hotline flooded with calls.',
      type: 'social_post',
      trigger_time_minutes: 0,
      severity: 'high',
      delivery_config: {
        app: 'social_feed',
        platform: 'facebook',
        author_handle: '@health_hoax_hunter',
      },
    }),
  });
  const createdInject = (await createRes.json()).data;
  check(
    'Trainer inject created',
    createRes.status === 201 && createdInject.generation_source === 'trainer',
  );

  const delRes = await apiFetch(`/api/scenarios/${scenarioId}/injects/${createdInject.id}`, {
    method: 'DELETE',
  });
  check('Trainer inject deleted', delRes.ok);

  // ── Scenario-row edits (personas / fact sheet / org page) ──
  console.log('\n[5] initial_state edits (personas, facts, org page)...');
  const scenRow = (await (await apiFetch(`/api/scenarios/${scenarioId}`)).json()).data;
  const is1 = scenRow.initial_state as Record<string, unknown>;
  const personas1 = is1.npc_personas as Array<Record<string, unknown>>;
  personas1.find((p) => p.handle === '@citywatch_sg')!.personality =
    'PERSONA-EDIT-MARKER: now cautious, retracts unverified claims quickly.';
  (is1.fact_sheet as Record<string, unknown>).confirmed_facts = [
    ...((is1.fact_sheet as Record<string, unknown>).confirmed_facts as string[]),
    'FACT-EDIT-MARKER: independent lab retest confirmed purity on 12 July.',
  ];
  const patch1 = await apiFetch(`/api/scenarios/${scenarioId}`, {
    method: 'PATCH',
    body: JSON.stringify({ initial_state: is1 }),
  });
  check('initial_state PATCH (persona + fact) accepted', patch1.ok);

  // ── Team charter edit ──
  console.log('\n[6] Team charter edit...');
  const teams = (await (await apiFetch(`/api/scenarios/${scenarioId}/teams`)).json()).data as Array<
    Record<string, unknown>
  >;
  const comms = teams.find((t) => t.team_name === 'Communications')!;
  const charterRes = await apiFetch(`/api/scenarios/${scenarioId}/teams/${comms.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      charter: { mission: 'CHARTER-EDIT-MARKER: own all public messaging for AquaPure.' },
      scoring_rubric: 'RUBRIC-EDIT-MARKER: reward source citations.',
    }),
  });
  const charterData = (await charterRes.json()).data;
  check(
    'Team charter PATCH applied (merge preserved responsibilities)',
    charterRes.ok &&
      String((charterData.charter as Record<string, unknown>).mission ?? '').startsWith(
        'CHARTER-EDIT-MARKER',
      ) &&
      Array.isArray((charterData.charter as Record<string, unknown>).responsibilities),
    JSON.stringify(charterData.charter).slice(0, 120),
  );

  // ── Objective edit + sync ──
  console.log('\n[7] Objective edit...');
  const objectives = (await (await apiFetch(`/api/scenarios/${scenarioId}/objectives`)).json())
    .data as Array<Record<string, unknown>>;
  const obj = objectives.find((o) => o.objective_id === 'contain_narrative')!;
  const objRes = await apiFetch(`/api/scenarios/${scenarioId}/objectives/${obj.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ objective_name: 'OBJECTIVE-EDIT-MARKER contain narrative', weight: 55 }),
  });
  check('Objective PATCH applied', objRes.ok);
  const scenAfterObj = (await (await apiFetch(`/api/scenarios/${scenarioId}`)).json()).data;
  check(
    'scenarios.objectives list synced with new name',
    (scenAfterObj.objectives as string[]).includes('OBJECTIVE-EDIT-MARKER contain narrative'),
  );

  // ── Image regeneration ──
  console.log('\n[8] Image regeneration (real image API call)...');
  const regenRes = await apiFetch(
    `/api/scenarios/${scenarioId}/injects/${t0.id}/regenerate-image`,
    {
      method: 'POST',
    },
  );
  if (regenRes.ok) {
    const regenData = (await regenRes.json()).data;
    const urls = ((regenData.delivery_config as Record<string, unknown>).media_urls ||
      []) as string[];
    check('Image regenerated and attached', urls.length > 0 && urls[0].startsWith('http'), urls[0]);
  } else {
    check(
      'Image regenerated and attached',
      false,
      `HTTP ${regenRes.status}: ${(await regenRes.text()).slice(0, 200)}`,
    );
  }

  // ── Session flow ──
  console.log('\n[9] Create session, edit AFTER create, then start...');
  const sessRes = await apiFetch('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ scenario_id: scenarioId }),
  });
  if (!sessRes.ok) throw new Error(`session create failed: ${await sessRes.text()}`);
  const sessionId = (await sessRes.json()).data.id as string;
  console.log(`    session ${sessionId}`);

  // Edits between create and start — these are exactly what the start-time
  // re-sync (Trap 1 & 2 fixes) must carry into the session.
  const scenRow2 = (await (await apiFetch(`/api/scenarios/${scenarioId}`)).json()).data;
  const is2 = scenRow2.initial_state as Record<string, unknown>;
  const personas2 = is2.npc_personas as Array<Record<string, unknown>>;
  personas2.find((p) => p.handle === '@e2eskeptic')!.personality =
    'AFTER-CREATE-PERSONA-MARKER: demands lab reports before believing anything.';
  const orgPage2 = is2.org_page as Record<string, unknown>;
  (orgPage2.facebook as Record<string, unknown>).page_name = 'AquaPure SG (AFTER-CREATE-EDIT)';
  const patch2 = await apiFetch(`/api/scenarios/${scenarioId}`, {
    method: 'PATCH',
    body: JSON.stringify({ initial_state: is2 }),
  });
  check('Edits between session create and start accepted', patch2.ok);

  const editAfterCreate = await apiFetch(`/api/scenarios/${scenarioId}/injects/${t0.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      content: 'EDIT-AFTER-CREATE-MARKER: rumor now cites a fabricated SFA memo.',
    }),
  });
  check('Inject editable after session created (not yet started)', editAfterCreate.ok);

  console.log('    starting session (may take a while: start-time AI checkpoint)...');
  const startRes = await apiFetch(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'in_progress' }),
  });
  check('Session started', startRes.ok, startRes.ok ? undefined : await startRes.text());

  // Trap 1: current_state re-synced from live scenario at start
  const { data: sessRow } = await admin
    .from('sessions')
    .select('current_state')
    .eq('id', sessionId)
    .single();
  const cs = (sessRow?.current_state ?? {}) as Record<string, unknown>;
  const csPersonas = (cs.npc_personas || []) as Array<Record<string, unknown>>;
  const csSkeptic = csPersonas.find((p) => p.handle === '@e2eskeptic');
  check(
    'Trap 1: current_state re-synced at start (post-create persona edit present)',
    String(csSkeptic?.personality || '').startsWith('AFTER-CREATE-PERSONA-MARKER'),
  );
  const csFacts = ((cs.fact_sheet as Record<string, unknown>)?.confirmed_facts || []) as string[];
  check(
    'Trap 1: current_state carries edited fact sheet',
    csFacts.some((f) => f.startsWith('FACT-EDIT-MARKER')),
  );

  // Trap 2: org pages re-seeded at start
  const { data: orgRows } = await admin
    .from('sim_org_pages')
    .select('*')
    .eq('session_id', sessionId);
  const orgJson = JSON.stringify(orgRows ?? []);
  check(
    'Trap 2: sim_org_pages re-seeded with post-create org edit',
    orgJson.includes('AFTER-CREATE-EDIT'),
    `rows=${orgRows?.length ?? 0}`,
  );

  // Live-session lock
  console.log('\n[10] Live-session lock...');
  ed = (await (await apiFetch(`/api/scenarios/${scenarioId}/editability`)).json()).data;
  check(
    'Locked while session in_progress',
    ed.editable === false && ed.reason === 'live_session',
    JSON.stringify(ed),
  );
  const liveEdit = await apiFetch(`/api/scenarios/${scenarioId}/injects/${t0.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ content: 'should be rejected mid-session' }),
  });
  check('Inject PATCH rejected mid-session (423)', liveEdit.status === 423);

  // Wait for the T+0 inject to fire (scheduler ticks every 30s)
  console.log('\n[11] Waiting for the edited inject to fire into the feed (up to 2 min)...');
  let firedPost: Record<string, unknown> | null = null;
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const { data: posts } = await admin
      .from('social_posts')
      .select('content, author_handle, inject_id, media_urls')
      .eq('session_id', sessionId)
      .not('inject_id', 'is', null);
    firedPost =
      (posts ?? []).find((p) => String(p.content).includes('EDIT-AFTER-CREATE-MARKER')) ?? null;
    if (firedPost) break;
  }
  check(
    'Edited inject fired with EDITED content',
    firedPost !== null,
    firedPost ? String(firedPost.content).slice(0, 80) : 'no matching social_posts row after 2 min',
  );
  if (firedPost) {
    check(
      'Fired post attributed to EDITED author',
      String(firedPost.author_handle) === '@e2eskeptic',
      String(firedPost.author_handle),
    );
    const media = (firedPost.media_urls || []) as string[];
    check('Fired post carries regenerated image', media.length > 0, media[0] ?? 'none');
  }

  // Complete + unlock
  console.log('\n[12] Complete session, verify unlock, then drain credits...');
  const doneRes = await apiFetch(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'completed' }),
  });
  check('Session completed', doneRes.ok);
  await sleep(2000);
  ed = (await (await apiFetch(`/api/scenarios/${scenarioId}/editability`)).json()).data;
  check(
    'Unlocked after session ends (1 credit left)',
    ed.editable === true && ed.session_credits === 1,
    JSON.stringify(ed),
  );

  await grantCredits(trainerId, 'session', -1);
  ed = (await (await apiFetch(`/api/scenarios/${scenarioId}/editability`)).json()).data;
  check('Locked again at 0 credits', ed.editable === false && ed.reason === 'no_session_credits');

  // ── Summary ──
  const failed = results.filter((r) => !r.ok);
  console.log('\n==================================================');
  console.log(`Results: ${results.length - failed.length}/${results.length} passed`);
  for (const f of failed) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  console.log(`Scenario: ${scenarioId}`);
  console.log(`Session:  ${sessionId}`);
  console.log('(Left in DB for inspection — titled "E2E VERIFY ...")');
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('E2E verification aborted:', err);
  process.exit(1);
});
