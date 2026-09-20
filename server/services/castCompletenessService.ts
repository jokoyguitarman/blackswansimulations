import { logger } from '../lib/logger.js';
import {
  callSocialCrisisAI,
  type FactSheet,
  type SOPStep,
} from './socialCrisisGeneratorService.js';
import type { NormalisedOrg, OrgTeamCharter } from './scenarioOrgModel.js';
import { EXECUTIVE_FUNCTION } from './scenarioOrgModel.js';
import type { Stakeholder, StakeholderRelationship } from '../lib/stakeholderContract.js';
import { resolveTeamFunction } from '../lib/stakeholderContract.js';
import { claimEmail, claimId, finalizeStakeholder } from './stakeholderGenerationService.js';
import {
  claimHandle,
  normaliseHandle,
  type CrisisContext,
  type TakenIdentifiers,
} from './multiOrgGenerationService.js';
import { countrySlug } from '../../shared/countries.js';

/**
 * Cast completeness — the carrier rule (docs/executive-decisions-organic-plan.md §4.1,
 * handover §10.1). For every path a detected decision can travel there must be a
 * contactable NPC who can carry it onward: per protagonist organisation and per site
 * a site leader, an HR counterpart, a workforce representative (when labour is in the
 * story), a lightweight roster with a distribution list, a local reporter and the
 * relevant regulator; plus the Executive team's shadow (EA, board contact).
 *
 * Pure helpers (gap detection, roster synthesis, SOP steps, validation) are exported
 * separately from the AI-backed `completeCast()` so they can be unit-tested.
 */

export type CarrierRole =
  | 'site_leader'
  | 'hr_counterpart'
  | 'workforce_rep'
  | 'roster'
  | 'distribution_list'
  | 'local_reporter'
  | 'regulator'
  | 'exec_assistant'
  | 'board_contact';

export interface Site {
  site_key: string;
  name: string;
  country: string;
  city?: string;
}

export interface CastGap {
  org_key: string;
  site: Site;
  missing: CarrierRole[];
}

export interface CastOptions {
  labourSignal: boolean;
  multiOrg: boolean;
}

export const ROSTER_SIZE = 10;
export const MIN_ROSTER_FOR_VALIDATION = 6;

// ─── Signals ─────────────────────────────────────────────────────────────────

const LABOUR_RE =
  /\b(worker|workers|workforce|staff|employee|employees|driver|drivers|labou?r|shift|shifts|layoff|layoffs|redundan\w*|retrench\w*|closure|factory|plant|depot|overtime|union|wage|wages|forced labou?r|strike)\b/i;
const PRODUCT_SAFETY_RE =
  /\b(recall|contaminat\w*|defect\w*|safety|injur\w*|spoil\w*|batch|product line|faulty)\b/i;

export function detectLabourSignal(text: string): boolean {
  return LABOUR_RE.test(text);
}
export function detectProductSafetySignal(text: string): boolean {
  return PRODUCT_SAFETY_RE.test(text);
}

// ─── Sites ───────────────────────────────────────────────────────────────────

/** One site per organisation by default (its city or country); registry `sites[]` may add more. */
export function sitesFor(org: NormalisedOrg): Site[] {
  const key = countrySlug(org.city || org.country || org.display_name) || 'site';
  return [
    {
      site_key:
        `${org.org_key === 'primary' ? 'hq' : countrySlug(org.short_name || org.display_name)}_${key}`.slice(
          0,
          40,
        ),
      name: `${org.display_name} — ${org.city || org.country}`,
      country: org.country,
      city: org.city,
    },
  ];
}

// ─── Owning functions by role ────────────────────────────────────────────────

const HR_RE =
  /\b(hr|human resources|people|employee|driver|workforce|labou?r|staff|welfare|relations)\b/i;
const OPS_RE =
  /\b(operation|operations|fleet|plant|site|depot|branch|manufactur\w*|production|logistics|facility)\b/i;

/** The function (team) that owns a carrier role, given the organisation's charters. */
export function ownerFunctionFor(role: CarrierRole, charters: OrgTeamCharter[]): string | null {
  const fns = charters.map((c) => ({ fn: c.function_key, text: `${c.function_key} ${c.mission}` }));
  const has = (f: string) => fns.some((x) => x.fn === f);
  const custom = (re: RegExp) => fns.find((x) => !isPreset(x.fn) && re.test(x.text))?.fn ?? null;
  const first = fns[0]?.fn ?? null;
  switch (role) {
    case 'site_leader':
      return (
        custom(OPS_RE) ??
        (has(EXECUTIVE_FUNCTION) ? EXECUTIVE_FUNCTION : null) ??
        (has('Communications') ? 'Communications' : first)
      );
    case 'hr_counterpart':
    case 'workforce_rep':
    case 'roster':
    case 'distribution_list':
      return (
        custom(HR_RE) ??
        (has('Stakeholder Engagement') ? 'Stakeholder Engagement' : null) ??
        (has('Communications') ? 'Communications' : first)
      );
    case 'local_reporter':
      return has('Communications') ? 'Communications' : first;
    case 'regulator':
      return has('Legal') ? 'Legal' : has('Communications') ? 'Communications' : first;
    case 'exec_assistant':
      return has(EXECUTIVE_FUNCTION) ? EXECUTIVE_FUNCTION : null;
    case 'board_contact':
      return has('Shareholder Engagement')
        ? 'Shareholder Engagement'
        : has(EXECUTIVE_FUNCTION)
          ? EXECUTIVE_FUNCTION
          : null;
  }
}

function isPreset(fn: string): boolean {
  return [
    'Communications',
    'Shareholder Engagement',
    'Stakeholder Engagement',
    'Legal',
    'Procurement',
    'Sales',
    EXECUTIVE_FUNCTION,
  ].includes(fn);
}

// ─── Gap detection (pure) ────────────────────────────────────────────────────

const ROLE_MATCHERS: Record<
  Exclude<CarrierRole, 'roster' | 'distribution_list'>,
  (s: Stakeholder) => boolean
> = {
  site_leader: (s) =>
    s.relationship === 'internal' &&
    s.tier !== 'roster' &&
    /\b(plant|site|depot|branch|factory|country|general|operations|facility|regional)\b/i.test(
      s.title,
    ) &&
    /\b(manager|head|director|lead|superintendent)\b/i.test(s.title),
  hr_counterpart: (s) =>
    s.relationship === 'internal' &&
    s.tier !== 'roster' &&
    /\b(hr|human resources|people|personnel|industrial relations)\b/i.test(s.title),
  workforce_rep: (s) =>
    s.relationship === 'union' ||
    (s.relationship === 'internal' &&
      /\b(steward|staff council|union|works council|workers'? representative|employee representative)\b/i.test(
        s.title,
      )),
  local_reporter: (s) => s.relationship === 'media',
  regulator: (s) => s.relationship === 'regulator',
  exec_assistant: (s) =>
    s.relationship === 'internal' &&
    /\b(executive assistant|chief of staff|ea to|office of the ceo)\b/i.test(s.title),
  board_contact: (s) =>
    s.relationship === 'investor' && /\b(board|director|chair)\b/i.test(s.title),
};

function belongsTo(s: Stakeholder, org: NormalisedOrg, multiOrg: boolean): boolean {
  if (!multiOrg) return true;
  return s.org_key === null || s.org_key === org.org_key;
}

export function detectCastGaps(
  org: NormalisedOrg,
  charters: OrgTeamCharter[],
  stakeholders: Stakeholder[],
  opts: CastOptions,
): CastGap[] {
  const mine = stakeholders.filter((s) => belongsTo(s, org, opts.multiOrg));
  const hasExecutive = charters.some((c) => c.function_key === EXECUTIVE_FUNCTION);
  const gaps: CastGap[] = [];
  for (const site of sitesFor(org)) {
    const atSite = (s: Stakeholder) => !s.site_key || s.site_key === site.site_key;
    const missing: CarrierRole[] = [];
    const need = (role: CarrierRole, present: boolean) => {
      if (!present) missing.push(role);
    };
    need(
      'site_leader',
      mine.some((s) => atSite(s) && ROLE_MATCHERS.site_leader(s)),
    );
    need(
      'hr_counterpart',
      mine.some((s) => atSite(s) && ROLE_MATCHERS.hr_counterpart(s)),
    );
    if (opts.labourSignal) {
      need(
        'workforce_rep',
        mine.some((s) => atSite(s) && ROLE_MATCHERS.workforce_rep(s)),
      );
      need(
        'roster',
        mine.filter((s) => s.tier === 'roster' && s.site_key === site.site_key).length >=
          MIN_ROSTER_FOR_VALIDATION,
      );
      need(
        'distribution_list',
        mine.some((s) => s.kind === 'group' && s.site_key === site.site_key),
      );
    }
    need(
      'local_reporter',
      mine.some((s) => ROLE_MATCHERS.local_reporter(s)),
    );
    need(
      'regulator',
      mine.some((s) => ROLE_MATCHERS.regulator(s)),
    );
    if (hasExecutive) {
      need('exec_assistant', mine.some(ROLE_MATCHERS.exec_assistant));
      need('board_contact', mine.some(ROLE_MATCHERS.board_contact));
    }
    if (missing.length > 0) gaps.push({ org_key: org.org_key, site, missing });
  }
  return gaps;
}

// ─── Roster + distribution list (deterministic) ──────────────────────────────

const NAME_POOLS: Record<string, { first: string[]; last: string[] }> = {
  Malaysia: {
    first: [
      'Aiman',
      'Nurul',
      'Farid',
      'Siti',
      'Hafiz',
      'Aisyah',
      'Wei Jie',
      'Mei Ling',
      'Arun',
      'Kavitha',
      'Zulkifli',
      'Nadia',
    ],
    last: [
      'Rahman',
      'Ismail',
      'Abdullah',
      'Tan',
      'Lim',
      'Wong',
      'Muniandy',
      'Krishnan',
      'Yusof',
      'Hassan',
      'Chong',
      'Lee',
    ],
  },
  Singapore: {
    first: [
      'Wei Ming',
      'Hui Ling',
      'Jason',
      'Priya',
      'Muhammad',
      'Serene',
      'Kok Wai',
      'Nur',
      'Ravi',
      'Grace',
      'Zhi Hao',
      'Farah',
    ],
    last: [
      'Tan',
      'Lim',
      'Lee',
      'Ng',
      'Goh',
      'Rahman',
      'Kumar',
      'Chua',
      'Ong',
      'Ho',
      'Ismail',
      'Pillai',
    ],
  },
  Philippines: {
    first: [
      'Jose',
      'Maria',
      'Ramon',
      'Ana',
      'Carlo',
      'Liza',
      'Paolo',
      'Grace',
      'Miguel',
      'Joy',
      'Rico',
      'Cristina',
    ],
    last: [
      'Santos',
      'Reyes',
      'Cruz',
      'Bautista',
      'Garcia',
      'Mendoza',
      'Torres',
      'Flores',
      'Ramos',
      'Villanueva',
      'Castro',
      'Aquino',
    ],
  },
  Indonesia: {
    first: [
      'Budi',
      'Sari',
      'Agus',
      'Dewi',
      'Rizky',
      'Putri',
      'Andi',
      'Fitri',
      'Hendra',
      'Ayu',
      'Yoga',
      'Lestari',
    ],
    last: [
      'Santoso',
      'Wijaya',
      'Pratama',
      'Saputra',
      'Hidayat',
      'Kusuma',
      'Setiawan',
      'Nugroho',
      'Wibowo',
      'Halim',
      'Siregar',
      'Gunawan',
    ],
  },
  default: {
    first: [
      'Alex',
      'Sam',
      'Jordan',
      'Maya',
      'Chris',
      'Dana',
      'Lee',
      'Nina',
      'Omar',
      'Rosa',
      'Tariq',
      'Elena',
    ],
    last: [
      'Smith',
      'Johnson',
      'Brown',
      'Garcia',
      'Martin',
      'Silva',
      'Novak',
      'Okafor',
      'Haddad',
      'Fischer',
      'Costa',
      'Ivanova',
    ],
  },
};
const ROLES = [
  'Line Operator',
  'Shift Supervisor',
  'Machine Technician',
  'Quality Inspector',
  'Warehouse Assistant',
  'Forklift Operator',
  'Team Leader',
  'Maintenance Fitter',
  'Packing Operator',
  'Logistics Clerk',
  'Driver',
  'Security Officer',
];
const SHIFTS = ['day shift', 'night shift', 'rotating shift'];
const DISPOSITIONS = [
  'Quiet and loyal; worried about the mortgage.',
  'Outspoken; posts on Facebook when angry.',
  'Long-serving; trusted by younger colleagues.',
  'Sceptical of management after the last restructure.',
  'Pragmatic; wants facts and dates, not reassurance.',
  'Anxious; forwards every rumour to the family group.',
  'Union-minded; knows the branch secretary personally.',
  'Cooperative; will help organise colleagues if treated fairly.',
];

/** Deterministic roster (name/role/shift/tenure/site) + one distribution list for a site. Pure. */
export function buildRosterAndList(
  org: NormalisedOrg,
  site: Site,
  ownerFunction: string,
  taken: TakenIdentifiers,
  opts: CastOptions,
  count = ROSTER_SIZE,
): Stakeholder[] {
  const pool = NAME_POOLS[site.country] ?? NAME_POOLS.default;
  const orgSlug = countrySlug(org.short_name || org.display_name).replace(/_+/g, '_') || 'org';
  const orgKey = opts.multiOrg ? org.org_key : null;
  const out: Stakeholder[] = [];
  for (let i = 0; i < count; i++) {
    const first = pool.first[i % pool.first.length];
    const last = pool.last[(i * 7 + 3) % pool.last.length];
    const name = `${first} ${last}`;
    const role = ROLES[i % ROLES.length];
    const tenure = 1 + ((i * 5) % 17);
    const id = claimId(taken, `stk_${orgSlug}_${countrySlug(name)}`.slice(0, 60));
    const email = claimEmail(
      taken,
      `${countrySlug(first).replace(/_/g, '.')}.${countrySlug(last)}@${orgSlug.replace(/_/g, '')}.sim`,
    );
    const handle = claimHandle(
      taken,
      normaliseHandle(
        `${first}${last.charAt(0)}_${countrySlug(site.city || site.country).slice(0, 8)}`,
      ),
      orgSlug.slice(0, 4),
    );
    out.push({
      id,
      name,
      title: `${role} (${SHIFTS[i % SHIFTS.length]}, ${tenure} yrs)`,
      organisation: org.display_name,
      relationship: 'internal',
      owning_team: ownerFunction,
      org_key: orgKey,
      email,
      phone: null,
      handle,
      note: `${role} at ${site.name}; ${SHIFTS[i % SHIFTS.length]}, ${tenure} years of service.`,
      personality: DISPOSITIONS[i % DISPOSITIONS.length],
      stance: 'Waiting to hear from management directly.',
      knowledge: [],
      will_not_disclose: [],
      grievance: '',
      resolution_criteria: [],
      persuadability: 'medium',
      hard_constraints: [],
      kind: 'person',
      tier: 'roster',
      site_key: site.site_key,
      sensitivities: [`Any change to shifts, headcount, pay or the future of ${site.name}`],
    });
  }
  const listId = claimId(
    taken,
    `stk_${orgSlug}_${countrySlug(site.site_key)}_all_staff`.slice(0, 60),
  );
  const listEmail = claimEmail(
    taken,
    `all-staff.${countrySlug(site.city || site.country).replace(/_/g, '-')}@${orgSlug.replace(/_/g, '')}.sim`,
  );
  const listHandle = claimHandle(
    taken,
    normaliseHandle(
      `${orgSlug.slice(0, 10)}_staff_${countrySlug(site.city || site.country).slice(0, 8)}`,
    ),
    'grp',
  );
  out.push({
    id: listId,
    name: `${site.name} — all staff (distribution list)`,
    title: 'Distribution list',
    organisation: org.display_name,
    relationship: 'internal',
    owning_team: ownerFunction,
    org_key: orgKey,
    email: listEmail,
    phone: null,
    handle: listHandle,
    note: `Reaches every employee at ${site.name} in one email. Use for formal notices; individual replies come from a few staff.`,
    personality: 'A mailing list: individual staff reply in their own voices.',
    stance: '',
    knowledge: [],
    will_not_disclose: [],
    grievance: '',
    resolution_criteria: [],
    persuadability: 'medium',
    hard_constraints: [],
    kind: 'group',
    members: out.map((r) => r.id),
    tier: 'principal',
    site_key: site.site_key,
    sensitivities: [`Any decision affecting employment at ${site.name}`],
  });
  return out;
}

// ─── Notification SOP (pure) ─────────────────────────────────────────────────

export function notificationSopSteps(
  hrFunction: string,
  commsFunction: string,
  siteNames: string[],
): SOPStep[] {
  const sites = siteNames.join(', ');
  return [
    {
      step_id: 'brief_site_leadership',
      name: 'Brief site leadership',
      description: `Brief the site leader and the site HR counterpart (${sites}) with the decision, its timeline and the support measures before anything reaches the workforce.`,
      time_limit_minutes: 15,
      owner_function: hrFunction,
      trigger: 'decision_notification',
      must_precede: ['notify_affected_employees'],
    },
    {
      step_id: 'notify_workforce_representatives',
      name: 'Consult workforce representatives',
      description:
        'Consult the union branch / staff representatives before employees are told; share the rationale, timeline and support measures; invite their questions.',
      time_limit_minutes: 20,
      owner_function: hrFunction,
      trigger: 'decision_notification',
      must_precede: ['notify_affected_employees'],
    },
    {
      step_id: 'notify_affected_employees',
      name: 'Notify affected employees',
      description: `Notify every affected employee (individually or via the site distribution list) with a clear, humane, lawful notice that states what is happening, when, why, and what support is available.`,
      time_limit_minutes: 45,
      owner_function: hrFunction,
      trigger: 'decision_notification',
      must_precede: ['public_statement_after_staff'],
    },
    {
      step_id: 'public_statement_after_staff',
      name: 'No public statement before staff are told',
      description:
        'Publish the official line only after site leadership, representatives and affected employees have been notified.',
      time_limit_minutes: 60,
      owner_function: commsFunction,
      trigger: 'decision_notification',
    },
  ];
}

// ─── Sensitivities (deterministic fallback) ──────────────────────────────────

export function defaultSensitivities(
  s: Stakeholder,
  orgName: string,
  country: string | null,
): string[] {
  const place = country ? ` in ${country}` : '';
  switch (s.relationship) {
    case 'regulator':
      return [
        `Any decision that touches compliance, safety or statutory notice obligations${place}`,
        `Anything that changes what ${orgName} told the authority`,
      ];
    case 'union':
      return [
        `Any change to jobs, shifts, pay or site status affecting members${place}`,
        'Decisions taken without consulting representatives',
      ];
    case 'internal':
      return [
        `Any change to operations, headcount or leadership at ${orgName}${place}`,
        'Being told after outsiders',
      ];
    case 'client':
      return [
        `Anything affecting deliveries, service continuity or product safety from ${orgName}`,
      ];
    case 'supplier':
      return [
        `Anything affecting volumes, payments or the future of the supply relationship with ${orgName}`,
      ];
    case 'media':
      return [
        `Any decision by ${orgName} that affects people${place}`,
        'Contradictions between statements and actions',
      ];
    case 'investor':
      return [
        'Anything material to revenue, liability or reputation',
        'Decisions announced without disclosure discipline',
      ];
    case 'community':
      return [`Any decision affecting jobs, safety or services in the community${place}`];
    default:
      return [`Decisions by ${orgName} that change the situation they are involved in`];
  }
}

// ─── AI-backed completion ────────────────────────────────────────────────────

const ROLE_BRIEFS: Record<
  Exclude<CarrierRole, 'roster' | 'distribution_list'>,
  { title: string; relationship: StakeholderRelationship }
> = {
  site_leader: { title: 'Site / plant / depot manager for the site', relationship: 'internal' },
  hr_counterpart: { title: 'HR business partner at the site', relationship: 'internal' },
  workforce_rep: {
    title: 'Union branch secretary or shop steward for the site workforce',
    relationship: 'union',
  },
  local_reporter: {
    title: 'Local labour / business reporter for the site country',
    relationship: 'media',
  },
  regulator: {
    title: 'Relevant regulator contact for the site country',
    relationship: 'regulator',
  },
  exec_assistant: { title: 'Executive assistant to the CEO', relationship: 'internal' },
  board_contact: { title: 'Board member or chair (investor side)', relationship: 'investor' },
};

export interface CastCompletionResult {
  added: Stakeholder[];
  sopSteps: SOPStep[];
  gaps: CastGap[];
}

/**
 * Fill every carrier gap for an organisation: AI for the principals (one call per org),
 * deterministic synthesis for roster + distribution list, fallbacks for everything.
 * Also backfills `sensitivities` on existing principals that lack them.
 */
export async function completeCast(
  org: NormalisedOrg,
  charters: OrgTeamCharter[],
  stakeholders: Stakeholder[],
  factSheet: FactSheet,
  crisis: CrisisContext,
  taken: TakenIdentifiers,
  opts: CastOptions,
): Promise<CastCompletionResult> {
  const orgCharters = charters.filter(
    (c) => (c.org_key ?? 'primary') === org.org_key || (!opts.multiOrg && c.org_key == null),
  );
  const gaps = detectCastGaps(org, orgCharters, stakeholders, opts);
  const added: Stakeholder[] = [];
  const orgSlug = countrySlug(org.short_name || org.display_name).replace(/_+/g, '_') || 'org';
  const orgKey = opts.multiOrg ? org.org_key : null;

  for (const gap of gaps) {
    const principalRoles = gap.missing.filter(
      (r) => r !== 'roster' && r !== 'distribution_list',
    ) as Array<Exclude<CarrierRole, 'roster' | 'distribution_list'>>;
    if (principalRoles.length > 0) {
      const generated = await generatePrincipals(
        org,
        gap.site,
        principalRoles,
        orgCharters,
        factSheet,
        crisis,
        taken,
        orgKey,
        orgSlug,
      );
      added.push(...generated);
    }
    const hrFn =
      ownerFunctionFor('roster', orgCharters) ?? orgCharters[0]?.function_key ?? 'Communications';
    if (gap.missing.includes('roster') || gap.missing.includes('distribution_list')) {
      const existingRoster = stakeholders.filter(
        (s) => s.tier === 'roster' && s.site_key === gap.site.site_key,
      );
      const need = Math.max(0, ROSTER_SIZE - existingRoster.length);
      const synth = buildRosterAndList(org, gap.site, hrFn, taken, opts, need);
      // buildRosterAndList always appends a list; drop it if one already exists at the site
      const hasList = stakeholders.some(
        (s) => s.kind === 'group' && s.site_key === gap.site.site_key,
      );
      for (const s of synth) {
        if (s.kind === 'group') {
          if (hasList) continue;
          s.members = [...existingRoster.map((r) => r.id), ...(s.members || [])];
        }
        added.push(s);
      }
    }
    logger.info(
      { orgKey: org.org_key, site: gap.site.site_key, missing: gap.missing, added: added.length },
      'cast_gap_filled',
    );
  }

  // Sensitivities backfill on every principal of this org that lacks them.
  for (const s of stakeholders) {
    if (!belongsTo(s, org, opts.multiOrg)) continue;
    if (!Array.isArray(s.sensitivities) || s.sensitivities.length === 0) {
      s.sensitivities = defaultSensitivities(s, org.display_name, org.country);
    }
  }

  const hrFn =
    ownerFunctionFor('hr_counterpart', orgCharters) ??
    orgCharters[0]?.function_key ??
    'Communications';
  const commsFn = orgCharters.some((c) => c.function_key === 'Communications')
    ? 'Communications'
    : hrFn;
  const sopSteps = opts.labourSignal
    ? notificationSopSteps(
        hrFn,
        commsFn,
        sitesFor(org).map((s) => s.name),
      )
    : [];
  return { added, sopSteps, gaps };
}

async function generatePrincipals(
  org: NormalisedOrg,
  site: Site,
  roles: Array<Exclude<CarrierRole, 'roster' | 'distribution_list'>>,
  charters: OrgTeamCharter[],
  factSheet: FactSheet,
  crisis: CrisisContext,
  taken: TakenIdentifiers,
  orgKey: string | null,
  orgSlug: string,
): Promise<Stakeholder[]> {
  const rolesBlock = roles
    .map(
      (r) =>
        `- role_key "${r}": ${ROLE_BRIEFS[r].title} (relationship: ${ROLE_BRIEFS[r].relationship})`,
    )
    .join('\n');
  const raw = await callSocialCrisisAI(
    `You are completing the CAST of a crisis simulation with the people a decision travels through. Create exactly one contactable character for EACH role below, authentic to ${site.country}. They are PURE CONTACTS today (no scheduled action): grievance "" and resolution_criteria [].

For each: "role_key" (copy exactly), "name", "title" (specific; internal staff are ground-level, never C-suite), "organisation" (${org.display_name} for internal roles; the real body for union / media / regulator / board), "relationship", "note" (1-2 sentences a player may read; no timing, no planned actions), "personality", "stance", "knowledge" (1-3 facts they hold), "will_not_disclose" (1-2), "persuadability" (regulators none|low; union low; others medium), "hard_constraints" (statutory duties, if any), "sensitivities" (2-3 plain-language kinds of executive decision this person reacts to).

ROLES:
${rolesBlock}

Return ONLY valid JSON: { "people": [ { ...fields... } ] }`,
    `Crisis: ${crisis.crisisType}\nOrganisation: ${org.display_name} (${org.kind}) — site: ${site.name}, ${site.country}\nConfirmed facts: ${factSheet.confirmed_facts.slice(0, 6).join('; ')}`,
    5000,
    0.7,
  );
  const people = (raw?.people as Array<Record<string, unknown>>) || [];
  const out: Stakeholder[] = [];
  for (const role of roles) {
    const item = people.find((p) => String(p.role_key || '') === role);
    const owner = ownerFunctionFor(role, charters);
    if (!owner) continue;
    let s: Stakeholder | null = null;
    if (item) {
      s = finalizeStakeholder(
        { ...item, grievance: '', resolution_criteria: [], scheduled_injects: [] },
        owner,
        orgKey,
        orgSlug,
        taken,
      );
    }
    if (!s) s = syntheticCarrier(role, org, site, owner, orgKey, orgSlug, taken);
    s.tier = 'principal';
    s.kind = 'person';
    s.site_key = site.site_key;
    if (!Array.isArray(s.sensitivities) || s.sensitivities.length === 0) {
      const fromModel = Array.isArray(item?.sensitivities)
        ? (item!.sensitivities as unknown[]).map(String).filter(Boolean).slice(0, 3)
        : [];
      s.sensitivities =
        fromModel.length > 0 ? fromModel : defaultSensitivities(s, org.display_name, site.country);
    }
    out.push(s);
  }
  return out;
}

function syntheticCarrier(
  role: Exclude<CarrierRole, 'roster' | 'distribution_list'>,
  org: NormalisedOrg,
  site: Site,
  owner: string,
  orgKey: string | null,
  orgSlug: string,
  taken: TakenIdentifiers,
): Stakeholder {
  const brief = ROLE_BRIEFS[role];
  const titles: Record<typeof role, string> = {
    site_leader: 'Site Operations Manager',
    hr_counterpart: 'HR Business Partner',
    workforce_rep: 'Union Branch Secretary',
    local_reporter: 'Labour & Business Reporter',
    regulator: 'Labour Standards Officer',
    exec_assistant: 'Executive Assistant to the CEO',
    board_contact: 'Non-Executive Director',
  };
  const orgs: Record<typeof role, string> = {
    site_leader: org.display_name,
    hr_counterpart: org.display_name,
    workforce_rep: `${site.country} Workers Union — ${site.city || site.country} Branch`,
    local_reporter: `${site.country} Business Daily`,
    regulator: `Ministry of Labour, ${site.country}`,
    exec_assistant: org.display_name,
    board_contact: `${org.display_name} Board`,
  };
  const name = `${titles[role]} (${site.city || site.country})`;
  const id = claimId(
    taken,
    `stk_${orgSlug}_${countrySlug(role)}_${countrySlug(site.site_key).slice(0, 12)}`.slice(0, 60),
  );
  const email = claimEmail(
    taken,
    `${countrySlug(role).replace(/_/g, '.')}.${countrySlug(site.city || site.country)}@${countrySlug(orgs[role]).replace(/_/g, '') || orgSlug}.sim`,
  );
  const handle = claimHandle(
    taken,
    normaliseHandle(
      `${countrySlug(role).slice(0, 12)}_${countrySlug(site.city || site.country).slice(0, 8)}`,
    ),
    orgSlug.slice(0, 4),
  );
  return {
    id,
    name,
    title: titles[role],
    organisation: orgs[role],
    relationship: brief.relationship,
    owning_team: owner,
    org_key: orgKey,
    email,
    phone: null,
    handle,
    note: `${titles[role]} for ${site.name}.`,
    personality: 'Professional, direct.',
    stance: 'Waiting for the organisation to communicate clearly.',
    knowledge: [],
    will_not_disclose: [],
    grievance: '',
    resolution_criteria: [],
    persuadability: role === 'regulator' ? 'none' : role === 'workforce_rep' ? 'low' : 'medium',
    hard_constraints:
      role === 'regulator'
        ? ['Statutory process must be followed regardless']
        : role === 'workforce_rep'
          ? ['Must inform members of any development']
          : [],
    kind: 'person',
    tier: 'principal',
    site_key: site.site_key,
    sensitivities: [],
  };
}

// ─── Validation (pure) — MO-CAST-* ───────────────────────────────────────────

export interface CastIssue {
  code: string;
  path: string;
  message: string;
}

export function validateCast(
  stakeholders: Stakeholder[],
  teams: Array<{ team_name: string; function_key: string | null; org_key: string | null }>,
  protagonistOrgs: Array<{ org_key: string; display_name: string; country: string | null }>,
  opts: { labourSignal: boolean; injectsByStakeholder: Map<string, number> },
): CastIssue[] {
  const issues: CastIssue[] = [];
  const multiOrg = protagonistOrgs.length > 1;
  const byId = new Map(stakeholders.map((s) => [s.id, s]));
  for (const org of protagonistOrgs) {
    const mine = stakeholders.filter(
      (s) => !multiOrg || s.org_key === null || s.org_key === org.org_key,
    );
    const path = `cast.${org.org_key}`;
    if (!mine.some(ROLE_MATCHERS.site_leader))
      issues.push({
        code: 'MO-CAST-001',
        path,
        message: `${org.display_name}: no site leader (plant/depot/branch manager) among internal contacts`,
      });
    if (!mine.some(ROLE_MATCHERS.hr_counterpart))
      issues.push({
        code: 'MO-CAST-002',
        path,
        message: `${org.display_name}: no HR counterpart among internal contacts`,
      });
    if (opts.labourSignal) {
      if (!mine.some(ROLE_MATCHERS.workforce_rep))
        issues.push({
          code: 'MO-CAST-003',
          path,
          message: `${org.display_name}: labour crisis without a workforce representative (union / steward)`,
        });
      const roster = mine.filter((s) => s.tier === 'roster');
      if (roster.length < MIN_ROSTER_FOR_VALIDATION)
        issues.push({
          code: 'MO-CAST-004',
          path,
          message: `${org.display_name}: roster has ${roster.length} employees (< ${MIN_ROSTER_FOR_VALIDATION})`,
        });
      const lists = mine.filter((s) => s.kind === 'group');
      if (lists.length === 0)
        issues.push({
          code: 'MO-CAST-004',
          path,
          message: `${org.display_name}: no distribution list`,
        });
      for (const g of lists) {
        const members = g.members || [];
        if (members.length === 0)
          issues.push({
            code: 'MO-CAST-004',
            path,
            message: `${g.name}: distribution list has no members`,
          });
        for (const m of members) {
          const ms = byId.get(m);
          if (!ms)
            issues.push({ code: 'MO-CAST-004', path, message: `${g.name}: member ${m} not found` });
          else if (
            multiOrg &&
            ms.org_key !== null &&
            g.org_key !== null &&
            ms.org_key !== g.org_key
          )
            issues.push({
              code: 'MO-CAST-004',
              path,
              message: `${g.name}: member ${m} belongs to another organisation`,
            });
        }
        // MO-CAST-008: owning team = majority owner of members
        const owners = new Map<string, number>();
        for (const m of members) {
          const ms = byId.get(m);
          if (ms) owners.set(ms.owning_team, (owners.get(ms.owning_team) || 0) + 1);
        }
        const majority = Array.from(owners.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
        if (majority && majority !== g.owning_team)
          issues.push({
            code: 'MO-CAST-008',
            path,
            message: `${g.name}: owned by ${g.owning_team} but members belong to ${majority}`,
          });
      }
    }
    if (!mine.some(ROLE_MATCHERS.local_reporter))
      issues.push({ code: 'MO-CAST-005', path, message: `${org.display_name}: no media contact` });
    if (!mine.some(ROLE_MATCHERS.regulator))
      issues.push({
        code: 'MO-CAST-006',
        path,
        message: `${org.display_name}: no regulator contact`,
      });
  }
  for (const s of stakeholders) {
    if (s.tier === 'roster' && (opts.injectsByStakeholder.get(s.id) || 0) > 0)
      issues.push({
        code: 'MO-CAST-007',
        path: `stakeholders.${s.id}`,
        message: `Roster entry ${s.id} authors injects (roster entries never do)`,
      });
    if (s.kind === 'group' && (!s.members || s.members.length === 0))
      issues.push({
        code: 'MO-CAST-004',
        path: `stakeholders.${s.id}`,
        message: `Group ${s.id} has no members`,
      });
  }
  // Every team with an owning function should still resolve (sanity for roster owners)
  const functions = new Set(teams.map((t) => resolveTeamFunction(t)));
  for (const s of stakeholders) {
    if (
      s.tier === 'roster' &&
      !functions.has(s.owning_team) &&
      !teams.some((t) => t.team_name === s.owning_team)
    )
      issues.push({
        code: 'MO-CAST-004',
        path: `stakeholders.${s.id}`,
        message: `Roster entry ${s.id} owned by unknown function ${s.owning_team}`,
      });
  }
  return issues;
}
