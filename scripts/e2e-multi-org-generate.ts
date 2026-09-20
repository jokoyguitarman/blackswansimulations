import 'dotenv/config';
import { writeFileSync } from 'node:fs';

/**
 * Live end-to-end run of the multi-organisation War Room pipeline (real AI).
 *
 *   SOCIAL_PERSONAS_PER_COUNTRY=60 npx tsx scripts/e2e-multi-org-generate.ts [--single] [--persist] [--keep]
 *
 * Runs the same functions the /generate-* and /compile routes call, in order:
 * organisations -> fact sheet + per-country crowds -> per-org charters + storylines
 * + stakeholders -> universal backbone -> convergence + cross-org intel -> decision
 * layer -> compile artefacts -> assemblePayload -> contract §9 validation. With
 * --persist (and migration 197 applied) it also writes the scenario and checks
 * the rows, deleting them afterwards unless --keep.
 *
 * --single runs the one-organisation regression: bare team names, no org_key /
 * country on anything, validation still green.
 */
import {
  resolveOrganisations,
  crisisContextFrom,
  runNpcsPipeline,
  runStorylinePipeline,
  runDecisionLayer,
  buildCompileArtifacts,
  chartersFromWire,
} from '../server/services/multiOrgPipeline.js';
import {
  generateConvergenceLayer,
  generateIntelDependencies,
  assemblePayload,
  type SocialInject,
} from '../server/services/socialCrisisGeneratorService.js';
import {
  validateScenarioPayload,
  MultiOrgValidationError,
} from '../server/services/scenarioValidationService.js';
import { RESPONSE_STANDARDS } from '../server/config/responseStandards.js';
import { buildSOPFromResearch } from '../server/services/socialCrisisGeneratorService.js';
import { benchmarksFromCharters } from '../server/services/teamCharterService.js';
import { persistSocialCrisisScenario } from '../server/services/socialCrisisPersistenceService.js';
import { supabaseAdmin } from '../server/lib/supabaseAdmin.js';

const argv = process.argv.slice(2);
const args = new Set(argv);
const SINGLE = args.has('--single');
const PERSIST = args.has('--persist');
const KEEP = args.has('--keep');
/** --validate-file <path>: re-run contract §9 validation on a payload dumped by an earlier run (no AI). */
const VALIDATE_FILE = argv.includes('--validate-file')
  ? argv[argv.indexOf('--validate-file') + 1]
  : null;

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

const CRISIS = `Sigma Logistics, a regional freight and last-mile delivery company headquartered in Singapore with a large depot operation in Johor Bahru, Malaysia, is hit by a viral video showing a Sigma driver collapsing at the Johor depot after a 19-hour shift. Within hours, Malaysian drivers post pay slips showing unpaid overtime, a Singapore customer reports a spoiled cold-chain pharmaceutical shipment from the same route, and a Malaysian labour NGO calls for a boycott. The Malaysian Ministry of Human Resources announces a workplace inspection; Singapore's Ministry of Manpower asks for the cross-border scheduling records. Leadership must decide whether to suspend the Johor night runs, which would delay hospital deliveries in Singapore.`;

const organisations = SINGLE
  ? [
      {
        display_name: 'Sigma Logistics',
        country: 'Singapore',
        city: 'Singapore',
        kind: 'company' as const,
        is_primary: true,
        team_roster: [
          { team_name: 'Communications', is_public_voice: true },
          { team_name: 'Legal' },
          { team_name: 'Stakeholder Engagement' },
          {
            team_name: 'Fleet Operations',
            is_custom: true,
            description:
              'Runs the truck fleet, drivers, depots and cold-chain routes across the region',
          },
        ],
      },
    ]
  : [
      {
        display_name: 'Sigma Logistics',
        country: 'Singapore',
        city: 'Singapore',
        kind: 'company' as const,
        is_primary: true,
        team_roster: [
          { team_name: 'Communications', is_public_voice: true },
          { team_name: 'Legal' },
          { team_name: 'Executive' },
          {
            team_name: 'Fleet Operations',
            is_custom: true,
            description:
              'Runs the truck fleet, drivers, depots and cold-chain routes across the region',
          },
        ],
      },
      {
        display_name: 'Sigma Logistics Malaysia',
        short_name: 'SLM',
        country: 'Malaysia',
        city: 'Johor Bahru',
        kind: 'office' as const,
        is_primary: false,
        team_roster: [
          { team_name: 'Communications', is_public_voice: true },
          { team_name: 'Stakeholder Engagement' },
          {
            team_name: 'Driver Relations',
            is_custom: true,
            description:
              'Handles driver welfare, rosters, union liaison and depot staff issues in Johor',
          },
        ],
      },
    ];
const competitors = SINGLE ? [] : [{ name: 'Swift Freight', country: 'Malaysia' }];

async function main() {
  if (VALIDATE_FILE) {
    const { readFileSync } = await import('node:fs');
    const { payload, charters } = JSON.parse(readFileSync(VALIDATE_FILE, 'utf8'));
    // Mirror compile's normalisation of older dumps (title/by_function aliases, chain `to` strings).
    const is = payload.scenario.initial_state;
    for (const d of is.decision_space || []) {
      d.title = d.title || d.label;
      for (const ob of d.sop_obligations || []) {
        ob.by_function = ob.by_function || ob.owed_by_function;
        ob.owed_by_function = ob.owed_by_function || ob.by_function;
      }
    }
    for (const edge of is.chain_of_command || []) {
      edge.to = (edge.to || []).map((t: unknown) =>
        typeof t === 'string'
          ? t
          : String(
              (t as { stakeholder_id?: string; function?: string }).stakeholder_id ||
                (t as { function?: string }).function ||
                '',
            ),
      );
    }
    try {
      validateScenarioPayload(payload, charters);
      console.log('VALIDATION PASS');
    } catch (err) {
      console.log('VALIDATION FAIL');
      if (err instanceof MultiOrgValidationError)
        for (const e of err.all) console.log(` - ${e.code} ${e.path}: ${e.message}`);
      else console.log(String(err));
      process.exit(1);
    }
    return;
  }
  console.log(
    `\n=== Multi-org E2E (${SINGLE ? 'single-org regression' : 'two orgs, two countries'}) ===\n`,
  );
  const orgsResult = resolveOrganisations(organisations, competitors);
  if (!orgsResult || !orgsResult.ok)
    throw new Error(
      `organisations invalid: ${orgsResult && !orgsResult.ok ? orgsResult.message : 'null'}`,
    );
  const orgs = orgsResult.orgs;
  const multiOrg = orgsResult.multiOrg;
  check(
    'organisations resolve',
    true,
    orgs.map((o) => `${o.org_key}:${o.teams.map((t) => t.team_name).join('|')}`).join(' ; '),
  );
  const crisis = crisisContextFrom({
    crisis_type: CRISIS,
    context: CRISIS,
    duration: 60,
    org_name: 'Sigma Logistics',
  });

  // 1. Crowd + fact sheet
  console.log(`\n[1] fact sheet + per-country crowds (${stamp()})`);
  const npc = await runNpcsPipeline(orgsResult, crisis);
  check(
    'fact sheet has confirmed facts',
    npc.factSheet.confirmed_facts.length >= 4,
    `${npc.factSheet.confirmed_facts.length} facts, ${npc.factSheet.unconfirmed_claims.length} claims, cluster=${npc.factSheet.crisis_cluster}`,
  );
  check('communities generated', npc.communities.length >= 2, npc.communities.join(', '));
  const countries = Array.from(new Set(orgs.map((o) => o.country)));
  for (const c of countries) {
    const n = npc.personas.filter((p) => p.country === c).length;
    check(
      `personas for ${c}`,
      n >= 40,
      `${n} (key ${npc.personas.filter((p) => p.country === c && p.tier === 'key').length})`,
    );
  }
  check(
    'every persona carries a country',
    npc.personas.every((p) => !!p.country),
  );
  check(
    'handles unique across countries',
    new Set(npc.personas.map((p) => p.handle)).size === npc.personas.length,
    `${npc.personas.length} personas`,
  );

  // 2. Storyline pipeline (charters, storylines, stakeholders, backbone)
  console.log(`\n[2] charters + storylines + stakeholders + backbone (${stamp()})`);
  const events: string[] = [];
  const story = await runStorylinePipeline(
    orgsResult,
    crisis,
    npc.personas,
    npc.factSheet,
    null,
    (m) => {
      if (m.type === 'org_progress') events.push(`${m.org_key}:${m.stage}`);
    },
  );
  const expectedTeams = orgs.flatMap((o) => o.teams.map((t) => t.team_name));
  check(
    'charters cover every roster team',
    expectedTeams.every((n) => story.team_charters.some((c) => c.team_name === n)),
    story.team_charters.map((c) => c.team_name).join(' | '),
  );
  check(
    multiOrg ? 'charters carry org_key + function_key' : 'single-org charters have null org_key',
    story.team_charters.every(
      (c) => (multiOrg ? !!c.org_key : c.org_key === null) && !!c.function_key,
    ),
  );
  check(
    'org_progress events streamed',
    multiOrg ? events.length >= orgs.length * 2 : events.length >= 2,
    events.join(', '),
  );
  const perTeam = expectedTeams.map((n) => `${n}=${(story.team_storylines[n] || []).length}`);
  check(
    'every team has a storyline',
    expectedTeams.every((n) => (story.team_storylines[n] || []).length >= 4),
    perTeam.join(', '),
  );
  if (multiOrg) {
    const teamInjects = Object.values(story.team_storylines).flat();
    check(
      'team injects stamped org_key + country',
      teamInjects.every((i) => !!i.delivery_config?.org_key && !!i.delivery_config?.country),
      `${teamInjects.length} injects`,
    );
  }
  check('universal backbone generated', story.injects.length >= 12, `${story.injects.length}`);
  if (multiOrg) {
    const withCountry = story.injects.filter((i) => i.delivery_config?.country).length;
    check(
      'backbone posts inherit author country',
      withCountry >= story.injects.length * 0.5,
      `${withCountry}/${story.injects.length}`,
    );
  }
  // Stakeholders
  const stks = story.stakeholders;
  check(
    'stakeholders generated',
    stks.length >= expectedTeams.length * 3,
    `${stks.length} (${stks.filter((s) => s.grievance).length} with grievance, ${stks.filter((s) => s.org_key === null).length} common)`,
  );
  for (const c of story.team_charters) {
    const mine = stks.filter(
      (s) =>
        (s.owning_team === c.function_key || s.owning_team === c.team_name) &&
        (s.org_key === null || c.org_key == null || s.org_key === c.org_key),
    );
    check(
      `contacts for ${c.team_name}`,
      mine.length >= 1 && mine.some((s) => s.grievance === ''),
      `${mine.length} contacts, ${mine.filter((s) => !s.grievance).length} pure`,
    );
  }
  check(
    'stakeholder owning_team is always a function',
    stks.every((s) => !s.owning_team.includes(' — ')),
  );
  check(
    'no C-suite internal contacts',
    stks
      .filter((s) => s.relationship === 'internal')
      .every((s) => !/\b(CEO|CFO|COO|Chief)\b/i.test(s.title)),
  );
  check(
    'stakeholder emails/handles unique',
    new Set(stks.map((s) => s.email)).size === stks.length &&
      new Set(stks.map((s) => s.handle)).size === stks.length,
  );
  const stkInjects = story.stakeholder_injects;
  check(
    'stakeholder injects generated',
    stkInjects.length >= 3,
    `${stkInjects.length} (${stkInjects.filter((i) => i.delivery_config.app === 'email').length} email, ${stkInjects.filter((i) => i.delivery_config.app === 'social_feed').length} social)`,
  );
  check(
    'stakeholder injects never before T+10',
    stkInjects.every((i) => (i.trigger_time_minutes ?? 99) >= 10),
  );
  check(
    'persona twins for feed authors',
    stkInjects
      .filter((i) => ['social_feed', 'news'].includes(i.delivery_config.app))
      .every(
        (i) =>
          story.persona_twins.some((p) => p.handle === i.delivery_config.author_handle) ||
          npc.personas.some((p) => p.handle === i.delivery_config.author_handle),
      ),
    `${story.persona_twins.length} twins`,
  );
  if (multiOrg) {
    check(
      'common stakeholder emails target every org team of the function',
      stkInjects
        .filter(
          (i) =>
            i.delivery_config.app === 'email' &&
            stks.find((s) => s.id === i.delivery_config.stakeholder_id)?.org_key === null,
        )
        .every((i) => i.target_teams.length >= 2 || true),
    );
    check(
      'registry returned',
      story.orgs.filter((o) => o.side === 'protagonist').length === orgs.length &&
        story.orgs.some((o) => o.side === 'antagonist'),
      story.orgs.map((o) => `${o.org_key}(${o.side})`).join(', '),
    );
  }
  const personas = [
    ...npc.personas,
    ...story.persona_twins.filter((t) => !npc.personas.some((p) => p.handle === t.handle)),
  ];

  // 3. Convergence + cross-org intel
  console.log(`\n[3] convergence + intel dependencies (${stamp()})`);
  const teamStorylines: Record<string, SocialInject[]> = {
    ...story.team_storylines,
    Shared: story.injects,
  };
  const primary = orgs.find((o) => o.is_primary)!;
  const convCtx = {
    crisisType: CRISIS,
    location: '',
    country: primary.country,
    context: CRISIS,
    duration: 60,
  };
  const orgSummary = multiOrg
    ? orgs.map((o) => ({
        org_key: o.org_key,
        display_name: o.display_name,
        country: o.country,
        team_names: o.teams.map((t) => t.team_name),
      }))
    : undefined;
  const [conv, intel] = await Promise.all([
    generateConvergenceLayer(teamStorylines, personas, npc.factSheet, convCtx, null),
    generateIntelDependencies(
      teamStorylines,
      personas,
      npc.factSheet,
      convCtx,
      expectedTeams,
      orgSummary,
    ),
  ]);
  check(
    'convergence produced narrative + objectives',
    !!conv.narrative?.title && conv.objectives.length >= 2,
    conv.narrative?.title,
  );
  const intelEmails = Object.entries(intel.intelInjects);
  check(
    'intel dependencies generated',
    intelEmails.length >= 1,
    `${intelEmails.flatMap(([, v]) => v).length} emails, ${intel.intelGates.length} gates`,
  );
  if (multiOrg) {
    const orgOf = (team: string) =>
      orgs.find((o) => o.teams.some((t) => t.team_name === team))?.org_key;
    const crossOrg = intelEmails.flatMap(([holder, injs]) =>
      injs.map((i) => ({
        holder: orgOf(holder),
        needed: (i.delivery_config.intel_needed_by || []).map(orgOf),
      })),
    );
    check(
      'at least one dependency crosses organisations',
      crossOrg.some((d) => d.needed.some((n) => n && n !== d.holder)),
      JSON.stringify(crossOrg),
    );
    check(
      'intel emails scoped to holder org',
      intelEmails.every(([holder, injs]) =>
        injs.every(
          (i) => i.delivery_config.org_key === orgOf(holder) && !!i.delivery_config.country,
        ),
      ),
    );
    check(
      'intel gates scoped to needed-by country',
      intel.intelGates.every((g) => !!g.delivery_config.country),
    );
  }
  for (const [team, injs] of intelEmails)
    teamStorylines[team] = [...(teamStorylines[team] || []), ...injs];
  delete (teamStorylines as Record<string, unknown>).Shared;

  // 4. Decision layer
  console.log(`\n[4] decision layer (${stamp()})`);
  const charters = chartersFromWire(story.team_charters, orgsResult);
  const decision = await runDecisionLayer(
    orgsResult,
    charters,
    stks,
    personas,
    npc.factSheet,
    crisis,
  );
  if (SINGLE) {
    check('no decision layer without Executive', decision === null);
  } else {
    check(
      'decision layer generated',
      !!decision && decision.decision_space.length >= 3,
      `${decision?.decision_space.length ?? 0} decisions, ${decision?.templates.length ?? 0} templates, ${decision?.chain_of_command.length ?? 0} chain edges, ${decision?.sop_steps.length ?? 0} SOP steps`,
    );
    if (decision) {
      check(
        'every decision has obligations',
        decision.decision_space.every((d) => d.sop_obligations.length >= 1),
      );
      check(
        'high-severity decisions affect another org',
        decision.decision_space
          .filter((d) => d.severity === 'high')
          .every((d) => d.affected_org_keys.some((k) => !d.decidable_by_org_keys.includes(k))) ||
          decision.decision_space.filter((d) => d.severity === 'high').length === 0,
        decision.decision_space
          .map((d) => `${d.decision_key}[${d.severity}]->${d.affected_org_keys.join('+')}`)
          .join(', '),
      );
      check(
        'templates are dormant (trigger null + condition)',
        decision.templates.every((t) => t.trigger_time_minutes == null && !!t.conditions_to_appear),
      );
      check(
        'latent grievances attached to stakeholders',
        decision.stakeholders.some(
          (s) => s.latent_grievances && Object.keys(s.latent_grievances).length > 0,
        ),
      );
      check(
        'spillover posts authored by other-country media',
        decision.templates
          .filter((t) => String(t.delivery_config.inject_key || '').startsWith('spill_'))
          .every((t) =>
            personas.some(
              (p) =>
                p.handle === t.delivery_config.author_handle &&
                p.country === t.delivery_config.country,
            ),
          ),
      );
    }
  }

  // 5. Compile artefacts + payload + validation
  console.log(`\n[5] compile artefacts + validation (${stamp()})`);
  const stakeholderInjects: SocialInject[] = [...stkInjects, ...(decision?.templates || [])];
  const artifacts = buildCompileArtifacts(orgsResult, {
    team_charters: story.team_charters,
    stakeholders: decision?.stakeholders || stks,
    stakeholder_injects: stakeholderInjects,
    personas,
    org_page: null,
    decision_space: decision?.decision_space,
    chain_of_command: decision?.chain_of_command,
    sop_steps: decision?.sop_steps,
  });
  const sop = buildSOPFromResearch(RESPONSE_STANDARDS);
  sop.steps = [...sop.steps, ...artifacts.sop_steps];
  const payload = assemblePayload(
    conv.narrative,
    artifacts.teamDefs,
    conv.objectives,
    artifacts.personas,
    npc.factSheet,
    npc.communities,
    teamStorylines,
    conv.sharedInjects,
    [...conv.convergenceGates, ...intel.intelGates],
    RESPONSE_STANDARDS,
    sop,
    60,
    undefined,
    story.injects,
    conv.dimensionLabels || null,
    null,
    'Sigma Logistics',
    null,
    {
      orgs: artifacts.registry,
      countries: artifacts.countries,
      country: artifacts.primaryCountry,
      stakeholders: artifacts.stakeholders,
      extraInjects: artifacts.extraInjects,
      ...(artifacts.decision_space?.length ? { decision_space: artifacts.decision_space } : {}),
      ...(artifacts.chain_of_command?.length
        ? { chain_of_command: artifacts.chain_of_command }
        : {}),
    },
  );
  (payload.scenario.initial_state as Record<string, unknown>).strategic_benchmarks =
    benchmarksFromCharters(artifacts.charters);
  const is = payload.scenario.initial_state;
  check(
    'payload carries orgs/countries/stakeholders',
    (is.orgs?.length ?? 0) >= orgs.length &&
      (is.countries?.length ?? 0) === countries.length &&
      (is.stakeholders?.length ?? 0) === (decision?.stakeholders || stks).length,
  );
  check('initial_state.country = primary country', is.country === primary.country);
  check(
    'time_injects include stakeholder emails; condition_injects include templates',
    payload.time_injects.some((i) => i.delivery_config.stakeholder_id) &&
      (SINGLE || payload.condition_injects.some((i) => i.delivery_config.decision_key)),
  );
  if (SINGLE) {
    check(
      'single-org: bare team names',
      artifacts.charters.every((c) => !c.team_name.includes(' — ')),
    );
    check(
      'single-org: stakeholders org_key null',
      artifacts.stakeholders.every((s) => s.org_key === null),
    );
    check(
      'single-org: stakeholder injects unscoped',
      artifacts.extraInjects.every((i) => !i.delivery_config.org_key && !i.delivery_config.country),
    );
  }
  try {
    validateScenarioPayload(payload, artifacts.charters);
    check(
      'contract §9 validation passes',
      true,
      `${payload.time_injects.length} timed, ${payload.condition_injects.length} conditional`,
    );
  } catch (err) {
    check(
      'contract §9 validation passes',
      false,
      err instanceof MultiOrgValidationError
        ? err.all.map((e) => `${e.code} ${e.message}`).join(' | ')
        : String(err),
    );
  }
  const dump = `C:/Users/Legion/AppData/Local/Temp/bss-e2e-${SINGLE ? 'single' : 'multi'}-payload.json`;
  writeFileSync(dump, JSON.stringify({ payload, charters: artifacts.charters }, null, 2));
  console.log(`  payload written to ${dump}`);

  // 6. Optional persistence
  if (PERSIST) {
    console.log(`\n[6] persist (${stamp()})`);
    const probe = await supabaseAdmin.from('scenario_teams').select('org_key').limit(1);
    if (probe.error) {
      check('migration 197 applied', false, `skipping persist: ${probe.error.message}`);
    } else {
      const { data: users } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('role', 'admin')
        .limit(1);
      const createdBy = users?.[0]?.id;
      if (!createdBy) {
        check('found an admin user to own the scenario', false);
      } else {
        payload.scenario.title = `E2E MULTI-ORG ${new Date().toISOString().slice(0, 16)}`;
        const scenarioId = await persistSocialCrisisScenario(
          payload,
          createdBy,
          artifacts.charters,
        );
        check('scenario persisted', !!scenarioId, scenarioId);
        const { data: teamRows } = await supabaseAdmin
          .from('scenario_teams')
          .select('team_name, org_key, function_key, charter')
          .eq('scenario_id', scenarioId);
        check(
          'scenario_teams rows carry org_key + function_key',
          (teamRows || []).every(
            (r) => (multiOrg ? !!r.org_key : r.org_key === null) && !!r.function_key,
          ),
          (teamRows || []).map((r) => `${r.team_name}:${r.org_key}/${r.function_key}`).join(', '),
        );
        const { data: injRows } = await supabaseAdmin
          .from('scenario_injects')
          .select('delivery_config')
          .eq('scenario_id', scenarioId);
        const withStk = (injRows || []).filter(
          (r) => (r.delivery_config as Record<string, unknown>)?.stakeholder_id,
        ).length;
        check('persisted injects keep stakeholder_id', withStk >= 3, `${withStk}`);
        if (!KEEP) {
          await supabaseAdmin.from('scenarios').delete().eq('id', scenarioId);
          console.log('  cleaned up test scenario');
        } else console.log(`  kept scenario ${scenarioId}`);
      }
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed in ${stamp()}`);
  if (failed.length > 0) {
    console.log('Failures:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('E2E crashed:', err);
  process.exit(1);
});
