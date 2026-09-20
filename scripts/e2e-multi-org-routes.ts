import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

/**
 * HTTP-level smoke test of the multi-organisation War Room routes.
 *
 *   E2E_API_URL=http://localhost:3011 npx tsx scripts/e2e-multi-org-routes.ts [--payload <dumped-payload.json>]
 *
 * Verifies, against a running backend, that:
 *  - /team-catalog exposes the Executive preset
 *  - every generate-* endpoint rejects invalid organisations with a 400 + MO-* code
 *    BEFORE starting an AI job or streaming
 *  - /compile rejects invalid organisations BEFORE consuming the scenario credit
 *  - (with --payload) /compile accepts a real multi-org payload: it either persists
 *    (migration 197 applied; rows checked, scenario deleted) or fails loudly with the
 *    migration-197 message and refunds the credit
 *  - the stakeholder CRUD routes are mounted (404 for an unknown scenario)
 */

const API = process.env.E2E_API_URL ?? 'http://localhost:3011';
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const EMAIL = 'e2e-multiorg-trainer@loadtest.example.com';
const PASSWORD = process.env.LOADTEST_PASSWORD ?? 'LoadTest#Harness!2026';
const argv = process.argv.slice(2);
const PAYLOAD_FILE = argv.includes('--payload') ? argv[argv.indexOf('--payload') + 1] : null;

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
  const signIn = async () =>
    createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    }).auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  let res = await signIn();
  if (res.error) {
    const { error } = await admin.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: 'E2E Multi-org Trainer', agency_name: 'E2E' },
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

async function balance(trainerId: string, type: 'scenario' | 'session'): Promise<number> {
  const { data } = await admin
    .from('credit_ledger')
    .select('delta')
    .eq('trainer_id', trainerId)
    .eq('credit_type', type);
  return (data ?? []).reduce((s, r) => s + (r.delta as number), 0);
}
async function setBalance(trainerId: string, type: 'scenario' | 'session', target: number) {
  const cur = await balance(trainerId, type);
  const delta = target - cur;
  if (delta === 0) return;
  const rows = Array.from({ length: Math.abs(delta) }, () => ({
    trainer_id: trainerId,
    credit_type: type,
    delta: delta > 0 ? 1 : -1,
    reason: 'admin_adjustment',
  }));
  const { error } = await admin.from('credit_ledger').insert(rows);
  if (error) throw new Error(error.message);
}

const validOrgs = [
  {
    display_name: 'Sigma Logistics',
    country: 'Singapore',
    kind: 'company',
    is_primary: true,
    team_roster: [
      { team_name: 'Communications', is_public_voice: true },
      { team_name: 'Legal' },
      { team_name: 'Executive' },
    ],
  },
  {
    display_name: 'Sigma Logistics Malaysia',
    short_name: 'SLM',
    country: 'Malaysia',
    kind: 'office',
    is_primary: false,
    team_roster: [{ team_name: 'Communications', is_public_voice: true }, { team_name: 'Sales' }],
  },
];
const base = {
  crisis_type: 'smoke',
  context: 'smoke',
  country: 'Singapore',
  duration: 60,
  personas: [],
  fact_sheet: { confirmed_facts: [], unconfirmed_claims: [] },
};

async function main() {
  console.log(`\n=== Multi-org route smoke test against ${API} ===\n`);
  const health = await fetch(`${API}/api/health`).catch(() => null);
  if (!health || !health.ok) throw new Error(`backend not reachable at ${API}`);
  const trainerId = await provisionTrainer();
  await setBalance(trainerId, 'scenario', 1);
  check('trainer provisioned with 1 scenario credit', (await balance(trainerId, 'scenario')) === 1);

  // team catalog
  const cat = await apiFetch('/api/warroom/social-crisis/team-catalog');
  const catJson = await cat.json();
  check(
    'team-catalog includes Executive preset',
    cat.ok &&
      (catJson.data as Array<{ team_name: string; is_executive?: boolean }>).some(
        (c) => c.team_name === 'Executive' && c.is_executive,
      ),
  );

  // generate-npcs invalid country
  const r1 = await apiFetch('/api/warroom/social-crisis/generate-npcs', {
    method: 'POST',
    body: JSON.stringify({ ...base, organisations: [{ ...validOrgs[0], country: 'Narnia' }] }),
  });
  const j1 = await r1.json();
  check(
    'generate-npcs rejects unknown country (400 MO-ORG-004, no job)',
    r1.status === 400 && j1.code === 'MO-ORG-004' && !j1.job_id,
    `${r1.status} ${j1.code}`,
  );

  // generate-storyline duplicate names -> 400 before streaming
  const r2 = await apiFetch('/api/warroom/social-crisis/generate-storyline', {
    method: 'POST',
    body: JSON.stringify({
      ...base,
      organisations: [validOrgs[0], { ...validOrgs[1], display_name: 'Sigma Logistics' }],
    }),
  });
  const j2 = await r2.json().catch(() => ({}));
  check(
    'generate-storyline rejects duplicate org names (400 MO-ORG-003)',
    r2.status === 400 && j2.code === 'MO-ORG-003',
    `${r2.status} ${j2.code}`,
  );

  // generate-convergence roster too small
  const r3 = await apiFetch('/api/warroom/social-crisis/generate-convergence', {
    method: 'POST',
    body: JSON.stringify({
      ...base,
      location: '',
      team_storylines: {},
      organisations: [{ ...validOrgs[0], team_roster: [{ team_name: 'Communications' }] }],
    }),
  });
  const j3 = await r3.json();
  check(
    'generate-convergence rejects 1-team roster (400 MO-TEAM-001)',
    r3.status === 400 && j3.code === 'MO-TEAM-001',
    `${r3.status} ${j3.code}`,
  );

  // generate-org-page invalid competitor
  const r4 = await apiFetch('/api/warroom/social-crisis/generate-org-page', {
    method: 'POST',
    body: JSON.stringify({
      crisis_description: 'smoke',
      country: 'Singapore',
      organisations: validOrgs,
      competitors_with_country: [{ name: 'X', country: 'Atlantis' }],
    }),
  });
  const j4 = await r4.json().catch(() => ({}));
  check(
    'generate-org-page rejects competitor with unknown country (400 MO-CRY-001)',
    r4.status === 400 && j4.code === 'MO-CRY-001',
    `${r4.status} ${j4.code}`,
  );

  // compile invalid organisations -> 400 before credit
  const r5 = await apiFetch('/api/warroom/social-crisis/compile', {
    method: 'POST',
    body: JSON.stringify({
      narrative: { title: 't', description: 'd', briefing: 'b' },
      objectives: [],
      personas: [],
      fact_sheet: { confirmed_facts: [], unconfirmed_claims: [] },
      communities: [],
      shared_injects: [],
      convergence_gates: [],
      organisations: [{ ...validOrgs[0], is_primary: false }, validOrgs[1]],
    }),
  });
  const j5 = await r5.json();
  check(
    'compile rejects organisations without a primary (400 MO-ORG-002)',
    r5.status === 400 && j5.code === 'MO-ORG-002',
    `${r5.status} ${j5.code}`,
  );
  check(
    'compile rejection did not consume the credit',
    (await balance(trainerId, 'scenario')) === 1,
  );

  // stakeholder routes mounted
  const r6 = await apiFetch('/api/scenarios/00000000-0000-0000-0000-000000000000/stakeholders');
  check(
    'stakeholder routes mounted (404/403 for unknown scenario)',
    r6.status === 404 || r6.status === 403,
    `${r6.status}`,
  );

  // Single-org team insert must survive an un-migrated database (fallback strips the two columns).
  {
    const { insertTeamRowsWithOrgColumns } =
      await import('../server/services/socialCrisisPersistenceService.js');
    const { data: scen, error: scenErr } = await admin
      .from('scenarios')
      .insert({
        title: 'E2E MULTI-ORG probe (delete me)',
        description: 'probe',
        category: 'social_media_crisis',
        difficulty: 'expert',
        duration_minutes: 60,
        objectives: [],
        initial_state: {},
        created_by: trainerId,
      })
      .select('id')
      .single();
    if (scenErr || !scen) check('probe scenario created', false, scenErr?.message);
    else {
      const probe = await admin.from('scenario_teams').select('org_key').limit(1);
      const migrated = !probe.error;
      const err = await insertTeamRowsWithOrgColumns(
        [
          {
            scenario_id: scen.id,
            team_name: 'Communications',
            team_description: 'probe',
            required_roles: [],
            min_participants: 1,
            max_participants: 4,
            org_key: null,
            function_key: 'Communications',
          },
        ],
        scen.id,
      );
      const { data: rows } = await admin
        .from('scenario_teams')
        .select('team_name')
        .eq('scenario_id', scen.id);
      check(
        migrated
          ? 'single-org team insert writes org columns (197 applied)'
          : 'single-org team insert falls back without 197 (columns stripped)',
        err === null && (rows || []).length === 1,
        err || `${(rows || []).length} row(s)`,
      );
      const multiErr = await insertTeamRowsWithOrgColumns(
        [
          {
            scenario_id: scen.id,
            team_name: 'Legal — SL',
            team_description: 'probe',
            required_roles: [],
            min_participants: 1,
            max_participants: 4,
            org_key: 'primary',
            function_key: 'Legal',
          },
        ],
        scen.id,
      );
      check(
        migrated
          ? 'multi-org team insert succeeds (197 applied)'
          : 'multi-org team insert refuses without 197 (names the migration)',
        migrated ? multiErr === null : !!multiErr && /migration 197/i.test(multiErr),
        multiErr ? multiErr.slice(0, 120) : 'ok',
      );
      await admin.from('scenarios').delete().eq('id', scen.id);
    }
  }

  // optional real compile
  if (PAYLOAD_FILE && existsSync(PAYLOAD_FILE)) {
    console.log('\n[compile] real multi-org payload');
    const { payload, charters } = JSON.parse(readFileSync(PAYLOAD_FILE, 'utf8'));
    const is = payload.scenario.initial_state;
    const orgsFromRegistry = (
      is.orgs as Array<{
        org_key: string;
        display_name: string;
        short_name?: string;
        country: string;
        city?: string;
        kind?: string;
        side: string;
        is_primary?: boolean;
      }>
    )
      .filter((o) => o.side === 'protagonist')
      .map((o) => ({
        display_name: o.display_name,
        short_name: o.short_name,
        country: o.country,
        city: o.city,
        kind: o.kind || 'company',
        is_primary: !!o.is_primary,
        team_roster: (
          charters as Array<{
            org_key: string | null;
            function_key: string;
            is_custom?: boolean;
            can_post_publicly?: boolean;
            mission: string;
          }>
        )
          .filter((c) => (c.org_key ?? 'primary') === o.org_key)
          .map((c) => ({
            team_name: c.function_key,
            is_custom: !!c.is_custom,
            is_public_voice: !!c.can_post_publicly,
            description: c.is_custom ? c.mission : undefined,
          })),
      }));
    const timeInjects = payload.time_injects as Array<{
      delivery_config: Record<string, unknown>;
      target_teams: string[];
      inject_scope: string;
    }>;
    const stakeholderInjects = [
      ...timeInjects.filter((i) => i.delivery_config.stakeholder_id),
      ...(payload.condition_injects as Array<{ delivery_config: Record<string, unknown> }>).filter(
        (i) => i.delivery_config.decision_key,
      ),
    ];
    const teamStorylines: Record<string, unknown[]> = {};
    for (const inj of timeInjects.filter(
      (i) => !i.delivery_config.stakeholder_id && i.inject_scope === 'team_specific',
    )) {
      const t = inj.target_teams[0];
      (teamStorylines[t] ||= []).push(inj);
    }
    const body = {
      narrative: {
        title: `E2E MULTI-ORG ROUTES ${new Date().toISOString().slice(0, 16)}`,
        description: payload.scenario.description,
        briefing: payload.scenario.briefing,
      },
      crisis_type: 'e2e',
      org_name: 'Sigma Logistics',
      country: is.country,
      objectives: payload.objectives,
      personas: is.npc_personas,
      fact_sheet: is.fact_sheet,
      communities: is.affected_communities,
      storyline_injects: timeInjects.filter(
        (i) =>
          !i.delivery_config.stakeholder_id &&
          i.inject_scope === 'universal' &&
          !i.delivery_config.intel_key,
      ),
      team_storylines: teamStorylines,
      team_charters: charters,
      shared_injects: [],
      convergence_gates: (
        payload.condition_injects as Array<{ delivery_config: Record<string, unknown> }>
      ).filter((i) => !i.delivery_config.decision_key),
      dimension_labels: is.dimension_labels,
      org_page: null,
      duration: 60,
      organisations: orgsFromRegistry,
      competitors: (is.orgs as Array<{ side: string; display_name: string; country: string }>)
        .filter((o) => o.side === 'antagonist')
        .map((o) => ({ name: o.display_name, country: o.country })),
      stakeholders: is.stakeholders,
      stakeholder_injects: stakeholderInjects,
      decision_space: is.decision_space,
      chain_of_command: is.chain_of_command,
    };
    const rc = await apiFetch('/api/warroom/social-crisis/compile', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const jc = await rc.json();
    check(
      'compile accepted the multi-org payload (job started)',
      rc.ok && !!jc.job_id,
      `${rc.status} ${jc.error || jc.job_id}`,
    );
    if (jc.job_id) {
      let final: {
        status: string;
        data?: { scenario_id: string; inject_count: number };
        error?: string;
      } | null = null;
      for (let i = 0; i < 100; i++) {
        await sleep(3000);
        const p = await apiFetch(`/api/warroom/social-crisis/job-status/${jc.job_id}`);
        const pj = await p.json();
        if (pj.status !== 'generating') {
          final = pj;
          break;
        }
      }
      if (!final) check('compile job finished', false, 'timed out');
      else if (final.status === 'completed' && final.data) {
        check(
          'compile persisted (migration 197 present)',
          true,
          `${final.data.scenario_id} · ${final.data.inject_count} injects`,
        );
        const { data: rows } = await admin
          .from('scenario_teams')
          .select('team_name, org_key, function_key')
          .eq('scenario_id', final.data.scenario_id);
        check(
          'scenario_teams rows carry org_key + function_key',
          (rows || []).length > 0 && (rows || []).every((r) => !!r.org_key && !!r.function_key),
          (rows || []).map((r) => `${r.team_name}:${r.org_key}/${r.function_key}`).join(', '),
        );
        const rs = await apiFetch(`/api/scenarios/${final.data.scenario_id}/stakeholders`);
        const sj = await rs.json();
        check(
          'GET /stakeholders returns records + registry',
          rs.ok && Array.isArray(sj.data) && sj.data.length > 0 && sj.orgs.length >= 2,
          `${sj.data?.length} stakeholders`,
        );
        // Edit lock (server-enforced): no session credits => 423. Prove it, then unlock and edit.
        await setBalance(trainerId, 'session', 0);
        const target =
          (sj.data as Array<{ id: string; name: string; grievance: string }>).find(
            (s) => s.grievance,
          ) ?? sj.data[0];
        const url = `/api/scenarios/${final.data.scenario_id}/stakeholders/${target.id}`;
        const body = JSON.stringify({ name: `${target.name} Jr` });
        const locked = await apiFetch(url, { method: 'PATCH', body });
        check(
          'PATCH stakeholder is locked without session credits (423)',
          locked.status === 423,
          `${locked.status}`,
        );
        await setBalance(trainerId, 'session', 1);
        const rp = await apiFetch(url, { method: 'PATCH', body });
        const pj = await rp.json();
        check(
          'PATCH stakeholder renames + propagates to authored injects',
          rp.ok && pj.data.name === `${target.name} Jr` && (pj.injects_updated ?? 0) >= 1,
          `${rp.status} injects_updated=${pj.injects_updated}`,
        );
        const { data: renamed } = await admin
          .from('scenario_injects')
          .select('delivery_config')
          .eq('scenario_id', final.data.scenario_id);
        const authored = (renamed || []).filter(
          (r) => (r.delivery_config as Record<string, unknown>)?.stakeholder_id === target.id,
        );
        check(
          'authored injects now carry the new name',
          authored.length > 0 &&
            authored.every((r) => {
              const dc = r.delivery_config as Record<string, unknown>;
              return (dc.from_name ?? dc.author_display_name) === `${target.name} Jr`;
            }),
          `${authored.length} inject(s)`,
        );
        await setBalance(trainerId, 'session', 0);
        await admin.from('scenarios').delete().eq('id', final.data.scenario_id);
        console.log('  cleaned up test scenario');
        check('credit consumed exactly once', (await balance(trainerId, 'scenario')) === 0);
      } else {
        const msg = String(final.error || '');
        check(
          'compile failed loudly with the migration-197 message and refunded',
          /migration 197/i.test(msg) && (await balance(trainerId, 'scenario')) === 1,
          msg.slice(0, 160),
        );
      }
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});
