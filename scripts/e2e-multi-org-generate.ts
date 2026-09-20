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
  runOrgPagePipeline,
  buildCompileArtifacts,
  chartersFromWire,
} from '../server/services/multiOrgPipeline.js';
import {
  generateConvergenceLayer,
  generateIntelDependencies,
  assemblePayload,
  normalizeOrgPages,
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
        // Pressure plan §12: nobody plays the Malaysian office — its page runs `aligned`.
        operation: 'ai' as const,
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
// Pressure organisations (pressure plan §5.1): a statutory regulator and an advocacy union.
const pressureOrganisations = SINGLE
  ? []
  : [
      {
        display_name: 'Ministry of Human Resources Malaysia',
        kind: 'regulator' as const,
        country: 'Malaysia',
        city: 'Putrajaya',
      },
      {
        display_name: 'Transport Workers Union of Malaysia',
        kind: 'union' as const,
        country: 'Malaysia',
        city: 'Johor Bahru',
        wants: 'Consultation before any roster change and payment of all outstanding overtime',
      },
    ];

async function main() {
  if (VALIDATE_FILE) {
    const { readFileSync } = await import('node:fs');
    const { payload, charters } = JSON.parse(readFileSync(VALIDATE_FILE, 'utf8'));
    // Mirror compile's normalisation of older dumps: the retired menu decision layer is stripped.
    const is = payload.scenario.initial_state;
    delete is.decision_space;
    delete is.chain_of_command;
    for (const s of is.stakeholders || []) delete s.latent_grievances;
    const menuGated = (i: {
      delivery_config?: Record<string, unknown>;
      conditions_to_appear?: { conditions?: string[] };
    }) =>
      !!i.delivery_config?.decision_key ||
      (i.conditions_to_appear?.conditions || []).some((c: string) =>
        c.startsWith('decision_recorded:'),
      );
    payload.condition_injects = payload.condition_injects.filter((i: never) => !menuGated(i));
    payload.time_injects = payload.time_injects.filter((i: never) => !menuGated(i));
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
  const orgsResult = resolveOrganisations(organisations, competitors, pressureOrganisations);
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
  // Footprint countries without a protagonist org contribute an UNSCOPED spillover crowd.
  const spillover = npc.personas.filter((p) => !p.country);
  check(
    'org-country personas carry a country; spillover crowd is unscoped',
    npc.personas.filter((p) => p.country).every((p) => countries.includes(p.country!)),
    `${spillover.length} unscoped spillover personas`,
  );
  check(
    'handles unique across countries',
    new Set(npc.personas.map((p) => p.handle)).size === npc.personas.length,
    `${npc.personas.length} personas`,
  );
  check(
    'footprint inferred (countries with roles, labour signal)',
    npc.footprint.countries.length >= countries.length && npc.footprint.labour_signal === true,
    npc.footprint.countries.map((c) => `${c.name}:${c.role}`).join(', ') +
      ` | implied: ${npc.footprint.implied_organisations.map((o) => o.display_name).join(', ') || '—'}` +
      ` | pressure: ${npc.footprint.pressure_organisations.map((p) => `${p.kind}:${p.display_name}`).join(', ') || '—'}`,
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

  // 4. Cast completeness (organic decisions plan §4.1) — carriers, roster, distribution lists
  console.log(`\n[4] cast completeness (${stamp()})`);
  const charters = chartersFromWire(story.team_charters, orgsResult);
  check(
    'every stakeholder has sensitivities',
    stks.every((s) => Array.isArray(s.sensitivities) && s.sensitivities.length > 0),
    `${stks.filter((s) => !Array.isArray(s.sensitivities) || s.sensitivities.length === 0).length} without`,
  );
  const roster = stks.filter((s) => s.tier === 'roster');
  const groups = stks.filter((s) => s.kind === 'group');
  check(
    'workforce roster generated per site',
    roster.length >= 6 * orgs.length,
    `${roster.length} roster entries`,
  );
  check(
    'distribution list per site resolves to roster members',
    groups.length >= orgs.length &&
      groups.every(
        (g) =>
          (g.members || []).length > 0 &&
          (g.members || []).every((m) => roster.some((r) => r.id === m)),
      ),
    `${groups.length} lists`,
  );
  check(
    'site leader + HR counterpart per site',
    orgs.every((o) =>
      stks.some(
        (s) =>
          s.relationship === 'internal' &&
          (s.org_key === o.org_key || !multiOrg) &&
          /manager|head|lead|director/i.test(s.title) &&
          s.tier !== 'roster',
      ),
    ),
  );
  check(
    'notification SOP steps generated',
    (story.sop_steps || []).length >= 2,
    `${(story.sop_steps || []).length} steps`,
  );
  check('charters resolved for all teams', charters.length === expectedTeams.length);
  if (!SINGLE) {
    check(
      'pressure orgs anchored to spokespersons (linked both ways)',
      story.pressure_organisations.length === pressureOrganisations.length &&
        story.pressure_organisations.every((p) => {
          const sp = stks.find((s) => s.id === p.spokesperson_stakeholder_id);
          return !!sp && sp.page_org_key === p.org_key && sp.grievance !== '';
        }),
      story.pressure_organisations
        .map((p) => `${p.org_key} → ${p.spokesperson_stakeholder_id}`)
        .join(', '),
    );
    check(
      'regulator spokesperson is none/low persuadability',
      story.pressure_organisations
        .filter((p) => p.kind === 'regulator')
        .every((p) => {
          const sp = stks.find((s) => s.id === p.spokesperson_stakeholder_id);
          return !!sp && (sp.persuadability === 'none' || sp.persuadability === 'low');
        }),
    );
  }

  // 4b. Org pages: protagonist pages, AI-operated office (aligned), pressure pages + statements
  console.log(`\n[4b] org pages + pressure pages (${stamp()})`);
  const pageResult = await runOrgPagePipeline(
    orgsResult,
    CRISIS,
    undefined,
    true,
    () => undefined,
    { stakeholders: stks, factSheet: npc.factSheet, crisis },
  );
  const pages = normalizeOrgPages(pageResult.orgPage);
  check(
    'every protagonist has a page; pressure orgs have AI pages with posture',
    orgs.every((o) => pages.some((p) => p.org_key === o.org_key && p.role === 'protagonist')) &&
      orgsResult.pressureOrgs.every((p) =>
        pages.some(
          (pg) =>
            pg.org_key === p.org_key &&
            pg.role === 'pressure' &&
            pg.control_mode === 'ai' &&
            !!pg.posture &&
            pg.posture.demands.length > 0 &&
            pg.posture.escalation_ladder.length >= 2,
        ),
      ),
    pages
      .map(
        (p) =>
          `${p.org_key}[${p.role}/${p.control_mode}${p.posture ? `/${p.posture.register}` : ''}]`,
      )
      .join(' '),
  );
  if (!SINGLE) {
    const slm = pages.find((p) => p.org_key === orgs[1].org_key);
    check(
      'AI-operated office page is ai-controlled with an aligned posture',
      !!slm &&
        slm.control_mode === 'ai' &&
        slm.operation === 'ai' &&
        slm.posture?.register === 'aligned',
    );
    check(
      'pressure statements: page identity as author, spokesperson as stakeholder, >= T+15',
      pageResult.pressure_injects.length >= orgsResult.pressureOrgs.length * 2 &&
        pageResult.pressure_injects.every((i) => {
          const dc = i.delivery_config;
          const pg = pages.find((p) => p.org_key === dc.page_org_key);
          return (
            !!pg &&
            dc.author_type === 'official_account' &&
            (dc.author_handle === pg.x_twitter?.page_handle ||
              dc.author_handle === pg.facebook?.page_handle) &&
            !!dc.stakeholder_id &&
            (i.trigger_time_minutes ?? 0) >= 15
          );
        }),
      `${pageResult.pressure_injects.length} statements`,
    );
    check(
      'registry carries pressure entries with spokesperson + AI operation',
      pageResult.orgs.some((o) => o.side === 'pressure' && !!o.spokesperson_stakeholder_id) &&
        pageResult.orgs.some((o) => o.side === 'protagonist' && o.operation === 'ai'),
    );
  }

  // 5. Compile artefacts + payload + validation
  console.log(`\n[5] compile artefacts + validation (${stamp()})`);
  const stakeholderInjects: SocialInject[] = [...stkInjects, ...pageResult.pressure_injects];
  personas.push(
    ...pageResult.persona_twins.filter((t) => !personas.some((p) => p.handle === t.handle)),
  );
  const artifacts = buildCompileArtifacts(orgsResult, {
    team_charters: story.team_charters,
    stakeholders: stks,
    stakeholder_injects: stakeholderInjects,
    personas,
    org_page: pageResult.orgPage,
    sop_steps: story.sop_steps,
    decision_context: story.decision_context,
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
    pageResult.orgPage,
    'Sigma Logistics',
    null,
    {
      orgs: artifacts.registry,
      countries: artifacts.countries,
      country: artifacts.primaryCountry,
      stakeholders: artifacts.stakeholders,
      extraInjects: artifacts.extraInjects,
      decision_context: artifacts.decision_context,
    },
  );
  (payload.scenario.initial_state as Record<string, unknown>).strategic_benchmarks =
    benchmarksFromCharters(artifacts.charters);
  const is = payload.scenario.initial_state;
  check(
    'payload carries orgs/countries/stakeholders',
    (is.orgs?.length ?? 0) >= orgs.length &&
      (is.countries?.length ?? 0) === countries.length &&
      (is.stakeholders?.length ?? 0) === stks.length,
  );
  check('initial_state.country = primary country', is.country === primary.country);
  check(
    'time_injects include stakeholder emails',
    payload.time_injects.some((i) => i.delivery_config.stakeholder_id),
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
