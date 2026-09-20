import { logger } from '../lib/logger.js';
import {
  callSocialCrisisAI,
  type BrandedHistoryPost,
  type FactSheet,
  type NPCPersona,
  type OrgConfig,
  type OrgPagePlatformConfig,
  type PagePosture,
  type SocialInject,
} from './socialCrisisGeneratorService.js';
import type {
  NormalisedOrg,
  NormalisedPressureOrg,
  OrgTeamCharter,
  PressureKind,
} from './scenarioOrgModel.js';
import type { Stakeholder, StakeholderRelationship } from '../lib/stakeholderContract.js';
import {
  claimEmail,
  claimId,
  finalizeStakeholder,
  personaTwinFor,
} from './stakeholderGenerationService.js';
import {
  claimHandle,
  normaliseHandle,
  type CrisisContext,
  type TakenIdentifiers,
} from './multiOrgGenerationService.js';
import { countrySlug } from '../../shared/countries.js';

/**
 * Pressure organisations — generator half (docs/pressure-organisations-plan.md §5).
 * Pages with an advocacy / statutory / grassroots / political voice, each anchored to a
 * spokesperson stakeholder, plus their scheduled page-authored statements.
 * `aligned` pages (AI-operated protagonist offices) are produced by `alignedPostureFor`.
 */

const MIN_STATEMENT_MINUTES = 15;

export const RELATIONSHIP_BY_KIND: Record<PressureKind, StakeholderRelationship> = {
  union: 'union',
  regulator: 'regulator',
  ngo: 'community',
  community_group: 'community',
  political: 'other',
};

/** Owning function for a pressure org's spokesperson, by kind and the target org's roster. */
export function spokespersonOwnerFor(kind: PressureKind, charters: OrgTeamCharter[]): string {
  const fns = charters.map((c) => c.function_key);
  const has = (f: string) => fns.includes(f);
  const hrLike = charters.find(
    (c) =>
      ![
        'Communications',
        'Legal',
        'Executive',
        'Shareholder Engagement',
        'Stakeholder Engagement',
      ].includes(c.function_key) &&
      /\b(hr|human|people|employee|driver|workforce|labou?r|staff|relations|welfare)\b/i.test(
        `${c.function_key} ${c.mission}`,
      ),
  )?.function_key;
  switch (kind) {
    case 'regulator':
      return has('Legal')
        ? 'Legal'
        : has('Communications')
          ? 'Communications'
          : fns[0] || 'Communications';
    case 'union':
      return (
        hrLike ??
        (has('Stakeholder Engagement')
          ? 'Stakeholder Engagement'
          : has('Communications')
            ? 'Communications'
            : fns[0] || 'Communications')
      );
    default:
      return has('Communications') ? 'Communications' : fns[0] || 'Communications';
  }
}

// ─── Pages ───────────────────────────────────────────────────────────────────

interface RawPressurePage {
  org_key?: string;
  facebook?: OrgPagePlatformConfig;
  x_twitter?: OrgPagePlatformConfig;
  branded_history?: BrandedHistoryPost[];
  posture?: Partial<PagePosture>;
}

/** Generate identities, bios, pre-crisis history and posture for pressure orgs (batched per country). */
export async function generatePressureOrgPages(
  pressureOrgs: NormalisedPressureOrg[],
  protagonists: NormalisedOrg[],
  crisis: CrisisContext,
  factSheet: FactSheet,
  onProgress?: (msg: string) => void,
): Promise<OrgConfig[]> {
  if (pressureOrgs.length === 0) return [];
  const byCountry = new Map<string, NormalisedPressureOrg[]>();
  for (const p of pressureOrgs) {
    if (!byCountry.has(p.country)) byCountry.set(p.country, []);
    byCountry.get(p.country)!.push(p);
  }
  const results = await Promise.all(
    Array.from(byCountry.entries()).map(async ([country, list]) => {
      onProgress?.(`Generating pressure-group pages for ${country}...`);
      const targetsLine = (p: NormalisedPressureOrg) =>
        p.targets_org_keys
          .map((k) => protagonists.find((o) => o.org_key === k)?.display_name || k)
          .join(', ');
      const raw = await callSocialCrisisAI(
        `You are creating the social media presence and POSTURE of the organisations applying pressure on a company in crisis — regulators, unions, NGOs, community groups, political actors. They are NOT competitors: they do not sell anything and never mock. Each speaks in its own register:
- statutory (regulator/ministry): formal, procedural, cites law and process, never speculates or amplifies rumour; escalates to inspection / notice / penalty.
- advocacy (union / NGO): members- or victims-first, cites specific harms, demands consultation and remedies; escalates to notice of industrial action / campaign / boycott.
- grassroots (community group): local, emotional but factual; organises meetings and petitions.
- political: positions against the company within the country's political register; questions to ministers, calls for inquiries.

For EACH organisation below produce:
- "org_key" (copy exactly)
- "facebook": { page_name, page_handle (@...), page_bio (1-2 sentences), follower_count }
- "x_twitter": { page_name, page_handle (@...), page_bio, follower_count }
- "branded_history": 4-6 pre-crisis posts in register { content, platform ("facebook"|"x_twitter"), post_format "text", days_ago (2-30), media_description "" } — advisories, campaigns, reports, member updates; never product talk
- "posture": { "mandate" (1 sentence), "demands" (2-4 concrete demands on the target organisation(s)), "escalation_ladder" (3-4 ordered rungs from statement to action), "stand_down_signals" (2-3 checkable things that would satisfy them) }

Everything authentic to ${country}. Return ONLY valid JSON: { "pages": [ ... ] }`,
        `Crisis: ${crisis.crisisType}\nContext: ${crisis.context.slice(0, 1500)}\nConfirmed facts: ${factSheet.confirmed_facts.slice(0, 6).join('; ')}\n\nORGANISATIONS:\n${list
          .map(
            (p) =>
              `- org_key "${p.org_key}": ${p.display_name} (${p.kind}, register ${p.register}${p.city ? `, ${p.city}` : ''}); presses: ${targetsLine(p)}${p.wants ? `; wants: ${p.wants}` : ''}`,
          )
          .join('\n')}`,
        7000,
        0.7,
      );
      const pages = (raw?.pages as RawPressurePage[]) || [];
      return list.map((p) =>
        toOrgConfig(
          p,
          pages.find((x) => x.org_key === p.org_key),
          protagonists,
        ),
      );
    }),
  );
  const configs = results.flat();
  logger.info({ count: configs.length }, 'pressure_pages_generated');
  return configs;
}

function toOrgConfig(
  p: NormalisedPressureOrg,
  raw: RawPressurePage | undefined,
  protagonists: NormalisedOrg[],
): OrgConfig {
  const handleBase = `@${countrySlug(p.short_name || p.display_name).replace(/_/g, '')}`.slice(
    0,
    20,
  );
  const fb: OrgPagePlatformConfig = {
    page_name: String(raw?.facebook?.page_name || p.display_name).slice(0, 80),
    page_handle: p.facebook_handle || String(raw?.facebook?.page_handle || `${handleBase}Official`),
    page_bio: String(raw?.facebook?.page_bio || `Official page of ${p.display_name}.`).slice(
      0,
      300,
    ),
    follower_count:
      Number(raw?.facebook?.follower_count) || (p.kind === 'regulator' ? 120000 : 35000),
  };
  const tw: OrgPagePlatformConfig = {
    page_name: String(raw?.x_twitter?.page_name || p.short_name || p.display_name).slice(0, 80),
    page_handle: p.x_handle || String(raw?.x_twitter?.page_handle || `${handleBase}`),
    page_bio: String(raw?.x_twitter?.page_bio || fb.page_bio).slice(0, 200),
    follower_count: Number(raw?.x_twitter?.follower_count) || Math.round(fb.follower_count * 0.6),
  };
  const targetNames = p.targets_org_keys.map(
    (k) => protagonists.find((o) => o.org_key === k)?.display_name || k,
  );
  const posture: PagePosture = {
    register: p.register,
    mandate: String(raw?.posture?.mandate || defaultMandate(p)).slice(0, 300),
    demands: arr(raw?.posture?.demands, 4, defaultDemands(p, targetNames)),
    escalation_ladder: arr(raw?.posture?.escalation_ladder, 4, defaultLadder(p)),
    targets_org_keys: p.targets_org_keys,
    stand_down_signals: arr(raw?.posture?.stand_down_signals, 3, defaultStandDown(p)),
  };
  return {
    org_key: p.org_key,
    display_name: p.display_name,
    is_primary: false,
    role: 'pressure',
    control_mode: 'ai',
    kind: p.kind,
    posture,
    ...(p.spokesperson_stakeholder_id
      ? { spokesperson_stakeholder_id: p.spokesperson_stakeholder_id }
      : {}),
    facebook: fb,
    x_twitter: tw,
    branded_history: Array.isArray(raw?.branded_history) ? raw!.branded_history!.slice(0, 6) : [],
    country: p.country,
    ...(p.city ? { city: p.city } : {}),
  };
}

function arr(v: unknown, max: number, fallback: string[]): string[] {
  const list = Array.isArray(v)
    ? (v as unknown[])
        .map(String)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, max)
    : [];
  return list.length > 0 ? list : fallback;
}
function defaultMandate(p: NormalisedPressureOrg): string {
  switch (p.kind) {
    case 'regulator':
      return `Enforce the law and protect the public interest in ${p.country}.`;
    case 'union':
      return `Protect the jobs, pay and safety of members in ${p.country}.`;
    case 'ngo':
      return `Hold organisations accountable for harm to people in ${p.country}.`;
    case 'community_group':
      return `Represent the affected community in ${p.city || p.country}.`;
    case 'political':
      return `Hold the company and the government to account in ${p.country}.`;
  }
}
function defaultDemands(p: NormalisedPressureOrg, targets: string[]): string[] {
  const t = targets.join(' and ');
  return p.wants
    ? [p.wants]
    : [
        `Full disclosure of what ${t} knew and when`,
        `A concrete remediation plan with dates`,
        `A named senior contact for ongoing questions`,
      ];
}
function defaultLadder(p: NormalisedPressureOrg): string[] {
  switch (p.kind) {
    case 'regulator':
      return [
        'Public statement noting the report',
        'Formal request for records with a deadline',
        'Notice of inspection / enforcement action',
      ];
    case 'union':
      return [
        'Public statement demanding consultation',
        'Notice of picket with a 48-hour deadline',
        'Notice of industrial action',
      ];
    default:
      return [
        'Public statement of concern',
        'Open letter with demands and a deadline',
        'Call for boycott / public campaign',
      ];
  }
}
function defaultStandDown(p: NormalisedPressureOrg): string[] {
  return p.kind === 'regulator'
    ? [
        'Records requested are provided in full',
        'A named compliance contact responds within the deadline',
      ]
    : [
        'Direct engagement from a senior representative',
        'Written commitments with dates',
        'A named contact for follow-up',
      ];
}

/** Posture for an AI-operated protagonist office (pressure plan §12). */
export function alignedPostureFor(org: NormalisedOrg, hq: NormalisedOrg | undefined): PagePosture {
  return {
    register: 'aligned',
    mandate: `Speak for ${org.display_name} in ${org.country}, consistent with ${hq?.display_name || 'headquarters'}.`,
    demands: [],
    escalation_ladder: [
      'Local holding statement acknowledging the situation and promising an update',
      'Local update once headquarters has published its line',
      'Local clarification correcting inaccurate claims about the site',
    ],
    targets_org_keys: hq ? [hq.org_key] : [],
    stand_down_signals: ['Headquarters publishes an official statement covering this site'],
  };
}

// ─── Spokespersons ───────────────────────────────────────────────────────────

/**
 * Ensure every pressure org has exactly one spokesperson stakeholder linked both ways.
 * Reuses an existing contact whose organisation matches; otherwise generates one (AI,
 * with a deterministic fallback). Mutates `pressureOrgs[i].spokesperson_stakeholder_id`.
 */
export async function ensureSpokespersons(
  pressureOrgs: NormalisedPressureOrg[],
  stakeholders: Stakeholder[],
  protagonists: NormalisedOrg[],
  charters: OrgTeamCharter[],
  crisis: CrisisContext,
  taken: TakenIdentifiers,
  multiOrg: boolean,
): Promise<Stakeholder[]> {
  const added: Stakeholder[] = [];
  for (const p of pressureOrgs) {
    const target =
      protagonists.find((o) => p.targets_org_keys.includes(o.org_key)) ?? protagonists[0];
    const targetCharters = charters.filter(
      (c) => (c.org_key ?? 'primary') === target?.org_key || (!multiOrg && c.org_key == null),
    );
    const owner = spokespersonOwnerFor(
      p.kind,
      targetCharters.length > 0 ? targetCharters : charters,
    );
    const relationship = RELATIONSHIP_BY_KIND[p.kind];
    const orgKey = multiOrg && p.targets_org_keys.length === 1 ? p.targets_org_keys[0] : null;

    let spokesperson = p.spokesperson_stakeholder_id
      ? stakeholders.find((s) => s.id === p.spokesperson_stakeholder_id)
      : undefined;
    if (!spokesperson) {
      const slug = countrySlug(p.display_name);
      spokesperson = stakeholders.find(
        (s) =>
          !s.page_org_key &&
          s.relationship === relationship &&
          s.tier !== 'roster' &&
          (countrySlug(s.organisation) === slug ||
            countrySlug(s.organisation).includes(slug.slice(0, 12)) ||
            slug.includes(countrySlug(s.organisation).slice(0, 12))),
      );
    }
    if (!spokesperson) {
      spokesperson = await generateSpokesperson(
        p,
        target,
        owner,
        relationship,
        orgKey,
        crisis,
        taken,
      );
      added.push(spokesperson);
    }
    spokesperson.page_org_key = p.org_key;
    if (spokesperson.grievance === '') {
      // A page that issues statements needs a live concern the team can address.
      spokesperson.grievance =
        p.wants ||
        `${p.display_name} has had no direct engagement from ${target?.display_name || 'the organisation'} on the crisis.`;
      spokesperson.resolution_criteria = [
        'Direct engagement from a senior representative',
        'Written commitments with dates',
        'A named contact for follow-up',
      ];
    }
    if (
      p.kind === 'regulator' &&
      spokesperson.persuadability !== 'none' &&
      spokesperson.persuadability !== 'low'
    )
      spokesperson.persuadability = 'low';
    p.spokesperson_stakeholder_id = spokesperson.id;
  }
  return added;
}

async function generateSpokesperson(
  p: NormalisedPressureOrg,
  target: NormalisedOrg | undefined,
  owner: string,
  relationship: StakeholderRelationship,
  orgKey: string | null,
  crisis: CrisisContext,
  taken: TakenIdentifiers,
): Promise<Stakeholder> {
  const orgSlug = countrySlug(p.short_name || p.display_name) || 'pressure';
  const raw = await callSocialCrisisAI(
    `Create the SPOKESPERSON of an organisation applying pressure in a crisis simulation: the one contactable person who speaks for it. Fields: "name", "title", "organisation" (exactly "${p.display_name}"), "relationship" ("${relationship}"), "note" (1-2 sentences a player may read; no timing, no planned actions), "personality", "stance", "knowledge" (1-3), "will_not_disclose" (1-2), "grievance" (what they publicly demand of ${target?.display_name || 'the company'} right now), "resolution_criteria" (2-3 checkable things that would satisfy them), "persuadability" (${p.kind === 'regulator' ? '"none" or "low"' : p.kind === 'union' ? '"low"' : '"medium"'}), "hard_constraints" (statutory duties / duty to members, if any). Authentic to ${p.country}. Return ONLY valid JSON with those fields.`,
    `Crisis: ${crisis.crisisType}\nOrganisation: ${p.display_name} (${p.kind}, ${p.register}, ${p.country})${p.wants ? `\nWants: ${p.wants}` : ''}`,
    2500,
    0.7,
  );
  let s: Stakeholder | null = null;
  if (raw && typeof raw === 'object') {
    s = finalizeStakeholder(
      { ...raw, organisation: p.display_name, relationship, scheduled_injects: [] },
      owner,
      orgKey,
      orgSlug,
      taken,
    );
  }
  if (!s) {
    const title =
      p.kind === 'regulator'
        ? 'Director of Enforcement'
        : p.kind === 'union'
          ? 'Branch Secretary'
          : 'Spokesperson';
    const name = `${title}, ${p.short_name}`;
    s = {
      id: claimId(taken, `stk_${orgSlug}_spokesperson`),
      name,
      title,
      organisation: p.display_name,
      relationship,
      owning_team: owner,
      org_key: orgKey,
      email: claimEmail(taken, `media@${orgSlug.replace(/_/g, '')}.sim`),
      phone: null,
      handle: claimHandle(taken, normaliseHandle(`${orgSlug.slice(0, 14)}_spokesperson`), 'prs'),
      note: `Speaks for ${p.display_name}.`,
      personality: 'Formal, measured.',
      stance: 'Demanding answers.',
      knowledge: [],
      will_not_disclose: [],
      grievance: p.wants || `No engagement from ${target?.display_name || 'the company'}.`,
      resolution_criteria: [
        'Direct engagement from a senior representative',
        'Written commitments with dates',
      ],
      persuadability: p.kind === 'regulator' ? 'none' : p.kind === 'union' ? 'low' : 'medium',
      hard_constraints:
        p.kind === 'regulator' ? ['Statutory process must be followed regardless'] : [],
    };
  }
  s.tier = 'principal';
  s.kind = 'person';
  s.sensitivities = [
    `Any decision by ${target?.display_name || 'the company'} that affects the people ${p.display_name} represents`,
  ];
  return s;
}

// ─── Page-authored statements ────────────────────────────────────────────────

/** Scheduled statements from each pressure page (contract v3.2 §4.4): author = page, stakeholder = spokesperson. */
export function buildPressureStatements(
  pages: OrgConfig[],
  stakeholders: Stakeholder[],
  protagonists: NormalisedOrg[],
  /** Countries where humans play; a page in any other country posts UNSCOPED (pressure plan §11). */
  humanCountries: Set<string> = new Set(
    protagonists.filter((o) => o.operation !== 'ai').map((o) => o.country),
  ),
): { injects: SocialInject[]; personaTwins: NPCPersona[] } {
  const injects: SocialInject[] = [];
  const twins: NPCPersona[] = [];
  let slot = 0;
  for (const page of pages) {
    if (page.role !== 'pressure' || !page.spokesperson_stakeholder_id || !page.posture) continue;
    const s = stakeholders.find((x) => x.id === page.spokesperson_stakeholder_id);
    if (!s) continue;
    const targets = page.posture.targets_org_keys
      .map((k) => protagonists.find((o) => o.org_key === k)?.display_name || k)
      .join(' and ');
    const first = MIN_STATEMENT_MINUTES + 5 + (slot % 3) * 5; // 20, 25, 30
    const second = first + 20;
    slot++;
    const platform = page.x_twitter ? 'x_twitter' : 'facebook';
    const ident = platform === 'x_twitter' ? page.x_twitter : page.facebook;
    const base = (
      t: number,
      title: string,
      content: string,
      key: string,
      severity: string,
    ): SocialInject => ({
      trigger_time_minutes: t,
      type: 'social_post',
      title,
      content,
      severity,
      inject_scope: 'universal',
      target_teams: [],
      requires_response: true,
      delivery_config: {
        app: 'social_feed',
        platform,
        page_org_key: page.org_key,
        stakeholder_id: s.id,
        author_handle: ident.page_handle,
        author_display_name: ident.page_name,
        author_type: 'official_account',
        inject_key: key,
        // Unscoped when nobody plays in the page's country (pressure plan §11).
        ...(page.country && humanCountries.has(page.country) ? { country: page.country } : {}),
        ...(page.posture!.targets_org_keys.length === 1
          ? { org_key: page.posture!.targets_org_keys[0] }
          : {}),
      },
    });
    const rung1 = page.posture.escalation_ladder[0] || 'Public statement';
    const rung2 = page.posture.escalation_ladder[1] || 'Demand with a deadline';
    const demands = page.posture.demands
      .slice(0, 3)
      .map((d) => `• ${d}`)
      .join('\n');
    injects.push(
      base(
        first,
        `${page.display_name}: ${rung1}`,
        `${page.display_name} statement on ${targets}:\n\n${page.posture.mandate}\n\nWe call on ${targets} to:\n${demands}`,
        `pressure_${page.org_key}_1`,
        'high',
      ),
    );
    injects.push(
      base(
        second,
        `${page.display_name}: ${rung2}`,
        `${rung2}. ${page.display_name} has not received a satisfactory response from ${targets}. ${page.posture.stand_down_signals[0] ? `We expect: ${page.posture.stand_down_signals[0]}.` : ''}`,
        `pressure_${page.org_key}_2`,
        'high',
      ),
    );
    // The page is the author; the spokesperson's persona twin is still needed by the feed engines that
    // look up NPC personas by handle for the page's follow-up replies.
    twins.push(personaTwinFor(s, page.country));
  }
  return { injects, personaTwins: twins };
}
