import { logger } from '../lib/logger.js';
import {
  callSocialCrisisAI,
  type NPCPersona,
  type FactSheet,
  type SocialInject,
} from './socialCrisisGeneratorService.js';
import type { NormalisedOrg, OrgTeamCharter } from './scenarioOrgModel.js';
import { EXECUTIVE_FUNCTION, teamNamesForFunction } from './scenarioOrgModel.js';
import {
  STAKEHOLDER_RELATIONSHIPS as RELATIONSHIPS,
  PERSUADABILITIES as PERSUADABILITY,
  type Persuadability,
  type Stakeholder,
  type StakeholderRelationship,
} from '../lib/stakeholderContract.js';
import {
  claimHandle,
  normaliseHandle,
  type CrisisContext,
  type TakenIdentifiers,
} from './multiOrgGenerationService.js';
import { countryDialPrefix, countrySlug } from '../../shared/countries.js';

/**
 * Stakeholder characters (contract §3) and the injects they author (§4).
 *
 * The AI writes the people; code decides identity, ownership, uniqueness,
 * timing, scoping and author fields. Nothing about routing is trusted from the
 * model: owning_team is normalised to a FUNCTION, emails target explicit
 * composed team names, and every inject carries stakeholder_id + author fields
 * copied from the record.
 */

export interface StakeholderGenerationResult {
  stakeholders: Stakeholder[];
  injects: SocialInject[];
  personaTwins: NPCPersona[];
}

const MIN_STAKEHOLDER_INJECT_MINUTES = 10;
const MIN_PUBLIC_ERUPTION_MINUTES = 20;

const RELATIONSHIPS_BY_FUNCTION: Record<string, StakeholderRelationship[]> = {
  Communications: ['media', 'community', 'internal'],
  Legal: ['regulator', 'partner', 'internal'],
  Procurement: ['supplier', 'partner', 'internal'],
  Sales: ['client', 'partner', 'internal'],
  Executive: ['investor', 'partner', 'regulator', 'internal'],
};

const C_SUITE_TITLE =
  /\b(CEO|CFO|COO|CMO|CTO|CHRO|Chief\b|President|Director[- ]General|Commissioner|Secretary[- ]General|Managing Director)\b/i;
const NOTE_TIME_TOKENS =
  /(\bT\+\d+|\b\d{1,3}\s*(min|mins|minutes)\b|\bwill\s+(post|publish|leak|escalate|go public|issue)|\b(plans?|about|threaten\w*)\s+to\b|\bdeadline\b)/i;
const STOPWORDS = new Set([
  'about',
  'their',
  'there',
  'these',
  'those',
  'which',
  'would',
  'could',
  'should',
  'after',
  'before',
  'being',
  'since',
  'still',
  'until',
  'while',
  'where',
  'other',
  'organisation',
  'organization',
  'company',
  'crisis',
  'team',
  'contact',
  'email',
  'phone',
  'relationship',
  'account',
  'office',
]);

// ─── Public API ──────────────────────────────────────────────────────────────

/** Org-specific stakeholders for every team of one organisation (one AI call; two if > 4 teams). */
export async function generateStakeholdersForOrg(
  org: NormalisedOrg,
  charters: OrgTeamCharter[],
  personasInCountry: NPCPersona[],
  factSheet: FactSheet,
  crisis: CrisisContext,
  taken: TakenIdentifiers,
  multiOrg: boolean,
): Promise<StakeholderGenerationResult> {
  const orgCharters = charters.filter(
    (c) => (c.org_key ?? 'primary') === org.org_key || (!multiOrg && c.org_key == null),
  );
  // Two teams per call keeps each response well inside the token budget (each stakeholder
  // carries nested inject content); a truncated response would otherwise parse to nothing.
  const groups = chunk(orgCharters, 2);
  const results = await Promise.all(
    groups.map((group) =>
      generateForTeams(org, group, charters, personasInCountry, factSheet, crisis, taken, multiOrg),
    ),
  );
  return mergeResults(results);
}

/** Common stakeholders: relevant to every organisation, emitted ONCE with org_key null (contract §3.2.2). */
export async function generateCommonStakeholders(
  orgs: NormalisedOrg[],
  allCharters: OrgTeamCharter[],
  keyPersonas: NPCPersona[],
  factSheet: FactSheet,
  crisis: CrisisContext,
  taken: TakenIdentifiers,
): Promise<StakeholderGenerationResult> {
  const functionsAnywhere = Array.from(new Set(allCharters.map((c) => c.function_key)));
  const orgSummary = orgs.map((o) => `${o.display_name} (${o.kind}, ${o.country})`).join('; ');
  const raw = await callSocialCrisisAI(
    `You are creating COMMON STAKEHOLDERS for a crisis simulation: named people or desks that EVERY organisation in the exercise has a relationship with — the affected family's spokesperson, a national broadcaster's crisis desk, an embassy duty officer, a national regulator, a community figure. NOT internal staff of any one organisation.

Create 3-6 common stakeholders. For each, choose "owning_function" from exactly this list of functions that exist in the exercise: ${functionsAnywhere.join(', ')} — the function whose teams (in every organisation) would own this relationship.

${STAKEHOLDER_FIELD_SPEC}

Return ONLY valid JSON: { "stakeholders": [ { ...fields..., "owning_function": "...", "scheduled_injects": [ ... ] } ] }`,
    `Crisis: ${crisis.crisisType}\nOrganisations: ${orgSummary}\nContext: ${crisis.context}\n${factsBlock(factSheet)}\n${personaBlock(keyPersonas)}`,
    7000,
    0.8,
  );

  const out: StakeholderGenerationResult = { stakeholders: [], injects: [], personaTwins: [] };
  for (const item of (raw?.stakeholders as Array<Record<string, unknown>>) || []) {
    const fn = String(item.owning_function || item.owning_team || '').trim();
    const matched = functionsAnywhere.find((f) => f.toLowerCase() === fn.toLowerCase());
    if (!matched) {
      logger.warn({ code: 'MO-STK-001', owning: fn, name: item.name }, 'stakeholder_dropped');
      continue;
    }
    const stakeholder = finalizeStakeholder(item, matched, null, 'common', taken);
    if (!stakeholder) continue;
    const targetTeams = teamNamesForFunction(allCharters, matched);
    const { injects, twin } = buildStakeholderInjects(stakeholder, item, {
      targetTeams,
      orgKey: null,
      country: null,
      dial: '+65',
    });
    out.stakeholders.push(stakeholder);
    out.injects.push(...injects);
    if (twin) out.personaTwins.push(twin);
  }
  logger.info(
    { count: out.stakeholders.length, injects: out.injects.length },
    'common_stakeholders_generated',
  );
  return out;
}

/** Idempotent: add a persona twin for any stakeholder that authors feed/news content but has none. */
export function ensurePersonaTwins(
  stakeholders: Stakeholder[],
  injects: SocialInject[],
  personas: NPCPersona[],
  countryByOrgKey: Map<string, string | null | undefined>,
): NPCPersona[] {
  const existing = new Set(personas.map((p) => p.handle));
  const added: NPCPersona[] = [];
  const feedAuthors = new Set(
    injects
      .filter(
        (i) =>
          i.delivery_config?.stakeholder_id &&
          ['social_feed', 'news'].includes(i.delivery_config.app),
      )
      .map((i) => String(i.delivery_config.stakeholder_id)),
  );
  for (const s of stakeholders) {
    if (!feedAuthors.has(s.id) || existing.has(s.handle)) continue;
    const twin = personaTwinFor(
      s,
      s.org_key ? (countryByOrgKey.get(s.org_key) ?? undefined) : undefined,
    );
    existing.add(twin.handle);
    added.push(twin);
    logger.info(
      { stakeholderId: s.id, handle: s.handle, country: twin.country },
      'persona_twin_created',
    );
  }
  return added;
}

// ─── Per-team generation ─────────────────────────────────────────────────────

const STAKEHOLDER_FIELD_SPEC = `For EACH stakeholder provide:
- "name", "title", "organisation" (their employer / body; for internal staff the organisation itself)
- "relationship": one of ${RELATIONSHIPS.join(', ')}
- "note": ONE or TWO sentences the player may read in a contacts sheet — relationship context only (who they are to us, history, preferences). NEVER mention any concern, complaint, planned action, or timing.
- "personality" (register, temperament, how they write), "stance" (current posture toward the organisation in this crisis)
- "knowledge": 1-3 facts this person holds and will share if asked (may quote confirmed facts)
- "will_not_disclose": 1-2 things they will not reveal regardless of how they are asked
- "grievance": the concern driving their scheduled inject(s), or "" if this is a pure contact with none
- "resolution_criteria": 1-4 concrete, checkable things a player exchange must contain before they would drop or soften the inject; [] when grievance is ""
- "persuadability": "none" | "low" | "medium" | "high" (regulators and statutory bodies: none or low)
- "hard_constraints": constraints that hold even when criteria are met (statutory duty, editorial independence), usually with none/low
- "scheduled_injects": [] for pure contacts; otherwise 1-2 items: { "channel": "email" | "social_post" | "phone_call" | "news", "trigger_time_minutes": 12-45, "title": "...", "content": "..." (for email start with "Subject: ..."), "platform": "x_twitter" | "facebook" (social_post only) }. An email must come first if there is also a social post.
Rules: internal staff are GROUND-LEVEL (duty managers, shift leads, ops coordinators, analysts) — never C-suite. At least two stakeholders per team must be pure contacts with grievance "". Names culturally appropriate to the country. Vary persuadability.`;

async function generateForTeams(
  org: NormalisedOrg,
  charters: OrgTeamCharter[],
  allCharters: OrgTeamCharter[],
  personasInCountry: NPCPersona[],
  factSheet: FactSheet,
  crisis: CrisisContext,
  taken: TakenIdentifiers,
  multiOrg: boolean,
): Promise<StakeholderGenerationResult> {
  const teamsBlock = charters
    .map((c) => {
      const rels = RELATIONSHIPS_BY_FUNCTION[c.function_key] ?? inferRelationships(c);
      return `- FUNCTION "${c.function_key}" (team "${c.team_name}"): ${c.mission}\n  relationship types to cover: ${rels.join(', ')}`;
    })
    .join('\n');
  const prompt = (perTeam: string) =>
    `You are creating the STAKEHOLDER CONTACTS for ONE organisation in a crisis simulation: the named clients, suppliers, regulators, partners, journalists, internal colleagues, community figures that each of its teams deals with. These become the team's contacts sheet and, for some, scheduled events in the exercise.

ORGANISATION: ${org.display_name} (${org.kind}, ${org.city ? `${org.city}, ` : ''}${org.country})
TEAMS (create ${perTeam} stakeholders for EACH team; set "owning_function" to the team's FUNCTION exactly as written):
${teamsBlock}

${STAKEHOLDER_FIELD_SPEC}
${org.kind === 'agency' ? 'Public-sector mapping: liaison agencies -> partner; oversight bodies/ministries -> regulator; press corps -> media; barangay/community leaders -> community; informants and field units -> other/internal.' : ''}

Return ONLY valid JSON: { "stakeholders": [ { ...fields..., "owning_function": "...", "scheduled_injects": [ ... ] } ] }`;
  const userPrompt = `Crisis: ${crisis.crisisType}${crisis.orgName ? `\nOrganisation under crisis: ${crisis.orgName}` : ''}\nCountry: ${org.country}\nContext: ${crisis.context}\n${factsBlock(factSheet)}\n${personaBlock(personasInCountry.filter((p) => p.tier === 'key'))}`;

  // First attempt asks for the full contact book; if the model fails (typically a
  // truncated JSON body), retry once with a smaller ask rather than shipping fillers.
  let raw = await callSocialCrisisAI(prompt('6-8'), userPrompt, 12000, 0.8);
  if (!raw || !Array.isArray(raw.stakeholders) || (raw.stakeholders as unknown[]).length === 0) {
    logger.warn(
      { orgKey: org.org_key, teams: charters.map((c) => c.team_name) },
      'stakeholder_call_retry',
    );
    raw = await callSocialCrisisAI(prompt('4-5'), userPrompt, 12000, 0.7);
  }

  const out: StakeholderGenerationResult = { stakeholders: [], injects: [], personaTwins: [] };
  const functions = new Map(charters.map((c) => [c.function_key.toLowerCase(), c]));
  const dial = countryDialPrefix(org.country);

  for (const item of (raw?.stakeholders as Array<Record<string, unknown>>) || []) {
    const owning = String(item.owning_function || item.owning_team || '').trim();
    // Accept bare function, or a composed team name, or case-insensitive function.
    const charter =
      functions.get(owning.toLowerCase()) ??
      charters.find((c) => c.team_name.toLowerCase() === owning.toLowerCase()) ??
      charters.find((c) => owning.toLowerCase().startsWith(c.function_key.toLowerCase()));
    if (!charter) {
      logger.warn(
        { code: 'MO-STK-001', owning, name: item.name, orgKey: org.org_key },
        'stakeholder_dropped',
      );
      continue;
    }
    const stakeholder = finalizeStakeholder(
      item,
      charter.function_key,
      multiOrg ? org.org_key : null,
      countrySlug(org.short_name || org.display_name),
      taken,
    );
    if (!stakeholder) continue;
    const { injects, twin } = buildStakeholderInjects(stakeholder, item, {
      targetTeams: [charter.team_name],
      orgKey: multiOrg ? org.org_key : null,
      country: multiOrg ? org.country : null,
      dial,
    });
    out.stakeholders.push(stakeholder);
    out.injects.push(...injects);
    if (twin) {
      twin.country = multiOrg ? org.country : undefined;
      out.personaTwins.push(twin);
    }
  }

  // Guarantee the contract's "team x org has contacts + a pure contact" rule (MO-STK-008) with
  // deterministic internal contacts when the model under-delivers.
  for (const c of charters) {
    const mine = out.stakeholders.filter((s) => s.owning_team === c.function_key);
    if (mine.length === 0 || !mine.some((s) => s.grievance === '')) {
      const filler = syntheticInternalContact(org, c, multiOrg, taken);
      out.stakeholders.push(filler);
      logger.warn({ orgKey: org.org_key, teamName: c.team_name }, 'stakeholder_filler_added');
    }
  }

  logger.info(
    {
      orgKey: org.org_key,
      count: out.stakeholders.length,
      withGrievance: out.stakeholders.filter((s) => s.grievance !== '').length,
      pureContacts: out.stakeholders.filter((s) => s.grievance === '').length,
      injects: out.injects.length,
    },
    'stakeholders_generated',
  );
  return out;
}

// ─── Normalisation ───────────────────────────────────────────────────────────

export function finalizeStakeholder(
  raw: Record<string, unknown>,
  owningFunction: string,
  orgKey: string | null,
  orgSlug: string,
  taken: TakenIdentifiers,
): Stakeholder | null {
  const name = String(raw.name || '').trim();
  if (name.length < 2) return null;
  let title = String(raw.title || 'Contact')
    .trim()
    .slice(0, 80);
  const organisation =
    String(raw.organisation || '')
      .trim()
      .slice(0, 120) || 'Independent';
  const relRaw = String(raw.relationship || 'other').toLowerCase() as StakeholderRelationship;
  const relationship: StakeholderRelationship = (RELATIONSHIPS as readonly string[]).includes(
    relRaw,
  )
    ? relRaw
    : 'other';

  // Sender-realism (MO-STK-010): internal contacts are ground-level.
  if (relationship === 'internal' && C_SUITE_TITLE.test(title)) {
    logger.warn({ name, title, code: 'MO-STK-010' }, 'internal_title_downgraded');
    title = 'Operations Coordinator';
  }

  const grievance = String(raw.grievance || '').trim();
  let criteria = Array.isArray(raw.resolution_criteria)
    ? (raw.resolution_criteria as unknown[])
        .map(String)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 4)
    : [];
  if (grievance === '') criteria = [];
  else if (criteria.length === 0)
    criteria = [
      'Given a direct, factual answer to the concern raised and a named point of contact',
    ];

  let persuadability = String(raw.persuadability || 'medium').toLowerCase() as Persuadability;
  if (!(PERSUADABILITY as readonly string[]).includes(persuadability)) persuadability = 'medium';
  let hardConstraints = Array.isArray(raw.hard_constraints)
    ? (raw.hard_constraints as unknown[]).map(String).filter(Boolean).slice(0, 3)
    : [];
  if (
    relationship === 'regulator' &&
    grievance !== '' &&
    persuadability !== 'none' &&
    persuadability !== 'low'
  ) {
    persuadability = 'low';
  }
  if (relationship === 'regulator' && grievance !== '' && hardConstraints.length === 0) {
    hardConstraints = [
      'Statutory process must be followed regardless; only tone and timing may change',
    ];
  }

  const nameSlug = countrySlug(name).replace(/_+/g, '_');
  const id = claimId(taken, `stk_${orgSlug}_${nameSlug}`.slice(0, 60));
  const [first, ...rest] = name.replace(/["“”]/g, '').split(/\s+/).filter(Boolean);
  const last = rest.length > 0 ? rest[rest.length - 1] : '';
  const emailLocal =
    countrySlug(`${first}${last ? `.${last}` : ''}`).replace(/_/g, '.') || nameSlug;
  const emailDomain = `${countrySlug(organisation).replace(/_/g, '') || orgSlug}.sim`;
  const email = claimEmail(taken, `${emailLocal}@${emailDomain}`);
  const handleWanted = normaliseHandle(
    `${first || 'contact'}${last ? last.charAt(0) : ''}_${countrySlug(organisation).slice(0, 10)}`,
  );
  const handle = claimHandle(taken, handleWanted, orgSlug.slice(0, 4));

  let note = String(raw.note || '')
    .trim()
    .slice(0, 400);
  const injectTitles = Array.isArray(raw.scheduled_injects)
    ? (raw.scheduled_injects as Array<Record<string, unknown>>).map((i) => String(i.title || ''))
    : [];
  if (noteLeaks(note, grievance, injectTitles)) {
    logger.warn({ id, code: 'MO-STK-009' }, 'note_neutralised');
    note = `${title} at ${organisation}. Existing relationship with the team.`;
  }
  if (!note) note = `${title} at ${organisation}.`;

  return {
    id,
    name,
    title,
    organisation,
    relationship,
    owning_team: owningFunction,
    org_key: orgKey,
    email,
    phone: raw.phone ? String(raw.phone).slice(0, 40) : null,
    handle,
    note,
    personality: String(raw.personality || 'Professional, direct.').slice(0, 600),
    stance: String(raw.stance || 'Watching how the organisation responds.').slice(0, 400),
    knowledge: Array.isArray(raw.knowledge)
      ? (raw.knowledge as unknown[]).map(String).filter(Boolean).slice(0, 4)
      : [],
    will_not_disclose: Array.isArray(raw.will_not_disclose)
      ? (raw.will_not_disclose as unknown[]).map(String).filter(Boolean).slice(0, 3)
      : [],
    grievance,
    resolution_criteria: criteria,
    persuadability,
    hard_constraints: hardConstraints,
  };
}

/** True when the player-visible note reveals the grievance, the inject, or its timing (MO-STK-009). */
export function noteLeaks(note: string, grievance: string, injectTitles: string[]): boolean {
  if (!note) return false;
  if (NOTE_TIME_TOKENS.test(note)) return true;
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((w) => w.length >= 6 && !STOPWORDS.has(w)),
    );
  const noteTokens = tokens(note);
  const secret = tokens(`${grievance} ${injectTitles.join(' ')}`);
  let overlap = 0;
  for (const t of noteTokens) if (secret.has(t)) overlap++;
  return overlap >= 2;
}

// ─── Injects authored by a stakeholder (contract §4) ─────────────────────────

interface InjectScope {
  /** Explicit composed team names (org-specific: one; common: every team of the function). */
  targetTeams: string[];
  orgKey: string | null;
  country: string | null;
  dial: string;
}

export function buildStakeholderInjects(
  s: Stakeholder,
  raw: Record<string, unknown>,
  scope: InjectScope,
): { injects: SocialInject[]; twin: NPCPersona | null } {
  const injects: SocialInject[] = [];
  let twin: NPCPersona | null = null;
  if (s.grievance === '') return { injects, twin };

  const scheduled = Array.isArray(raw.scheduled_injects)
    ? (raw.scheduled_injects as Array<Record<string, unknown>>).slice(0, 2)
    : [];

  for (const item of scheduled) {
    const channel = String(item.channel || 'email');
    let t = Number(item.trigger_time_minutes);
    const minT =
      channel === 'social_post' || channel === 'news'
        ? MIN_PUBLIC_ERUPTION_MINUTES
        : MIN_STAKEHOLDER_INJECT_MINUTES;
    if (!Number.isFinite(t) || t < minT) {
      logger.warn(
        { stakeholderId: s.id, from: t, to: minT, code: 'MO-INJ-006' },
        'stakeholder_inject_shifted',
      );
      t = minT;
    }
    const title = String(item.title || `${s.name}: ${s.relationship}`).slice(0, 200);
    const content = String(item.content || '').trim();
    if (!content) continue;

    const scopeKeys = {
      ...(scope.orgKey ? { org_key: scope.orgKey } : {}),
      ...(scope.country ? { country: scope.country } : {}),
    };

    if (channel === 'email') {
      injects.push({
        trigger_time_minutes: Math.round(t),
        type: 'email_inbound',
        title,
        content: content.startsWith('Subject:') ? content : `Subject: ${title}\n\n${content}`,
        severity: 'medium',
        inject_scope: 'team_specific',
        target_teams: scope.targetTeams,
        requires_response: true,
        delivery_config: {
          app: 'email',
          stakeholder_id: s.id,
          from_name: s.name,
          from_address: s.email,
          email_category: s.relationship === 'internal' ? 'sitrep_request' : 'general',
          priority: 'high',
          stakeholder_team: s.owning_team,
          ...scopeKeys,
        },
      });
    } else if (channel === 'social_post') {
      const platform =
        String(item.platform || 'x_twitter') === 'facebook' ? 'facebook' : 'x_twitter';
      injects.push({
        trigger_time_minutes: Math.round(t),
        type: 'social_post',
        title,
        content,
        severity: 'high',
        inject_scope: 'universal',
        target_teams: [],
        delivery_config: {
          app: 'social_feed',
          platform,
          stakeholder_id: s.id,
          author_handle: s.handle,
          author_display_name: s.name,
          author_type: s.relationship === 'media' ? 'npc_media' : 'npc_public',
          ...scopeKeys,
        },
      });
      twin = twin ?? personaTwinFor(s, scope.country ?? undefined);
    } else if (channel === 'phone_call') {
      const phone =
        s.phone ||
        `${scope.dial} ${String(1000 + Math.floor(Math.random() * 9000))} ${String(1000 + Math.floor(Math.random() * 9000))}`;
      if (!s.phone) s.phone = phone;
      injects.push({
        trigger_time_minutes: Math.round(t),
        type: 'phone_call',
        title,
        content,
        severity: 'high',
        inject_scope: 'team_specific',
        target_teams: scope.targetTeams,
        delivery_config: {
          app: 'phone_call',
          stakeholder_id: s.id,
          from_name: s.name,
          from_address: phone,
          ...scopeKeys,
        },
      });
    } else if (channel === 'news') {
      injects.push({
        trigger_time_minutes: Math.round(t),
        type: 'news_article',
        title,
        content,
        severity: 'high',
        inject_scope: 'universal',
        target_teams: [],
        delivery_config: {
          app: 'news',
          stakeholder_id: s.id,
          outlet_name: s.organisation,
          headline: title,
          author_handle: s.handle,
          author_display_name: s.name,
          author_type: 'npc_media',
          ...scopeKeys,
        },
      });
      twin = twin ?? personaTwinFor(s, scope.country ?? undefined);
    }
  }

  // A grievance with no usable scheduled inject: emit one deterministic email so the mechanic exists.
  if (injects.length === 0) {
    injects.push({
      trigger_time_minutes: MIN_STAKEHOLDER_INJECT_MINUTES + 5,
      type: 'email_inbound',
      title: `${s.name}: ${s.title} — ${s.relationship}`,
      content: `Subject: Following up on the situation\n\n${s.grievance}\n\nI would appreciate a direct answer.\n\n${s.name}\n${s.title}, ${s.organisation}`,
      severity: 'medium',
      inject_scope: 'team_specific',
      target_teams: scope.targetTeams,
      requires_response: true,
      delivery_config: {
        app: 'email',
        stakeholder_id: s.id,
        from_name: s.name,
        from_address: s.email,
        email_category: s.relationship === 'internal' ? 'sitrep_request' : 'general',
        priority: 'high',
        stakeholder_team: s.owning_team,
        ...(scope.orgKey ? { org_key: scope.orgKey } : {}),
        ...(scope.country ? { country: scope.country } : {}),
      },
    });
  }

  return { injects, twin };
}

export function personaTwinFor(s: Stakeholder, country?: string): NPCPersona {
  return {
    handle: s.handle,
    name: s.name,
    type: s.relationship === 'media' ? 'npc_media' : 'npc_public',
    personality: s.personality,
    bias: s.stance.length > 0 ? s.stance.slice(0, 60) : 'none',
    follower_count: s.relationship === 'media' ? 25000 : 1200,
    backstory: `${s.title}, ${s.organisation}.`,
    posting_pattern: 'Posts when a grievance is unaddressed; otherwise quiet.',
    specific_claims: [],
    tier: 'key',
    ...(country ? { country } : {}),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function syntheticInternalContact(
  org: NormalisedOrg,
  charter: OrgTeamCharter,
  multiOrg: boolean,
  taken: TakenIdentifiers,
): Stakeholder {
  const roleByFunction: Record<string, string> = {
    Communications: 'Media Relations Coordinator',
    Legal: 'Legal Operations Analyst',
    Procurement: 'Supplier Operations Coordinator',
    Sales: 'Customer Service Lead',
    [EXECUTIVE_FUNCTION]: 'Chief of Staff Office Coordinator',
  };
  const title =
    roleByFunction[charter.function_key] ?? `${charter.function_key} Operations Coordinator`;
  const name = `Duty Desk, ${charter.function_key}`;
  const orgSlug = countrySlug(org.short_name || org.display_name);
  const id = claimId(taken, `stk_${orgSlug}_${countrySlug(charter.function_key)}_desk`);
  const email = claimEmail(
    taken,
    `${countrySlug(charter.function_key).replace(/_/g, '.')}.desk@${orgSlug.replace(/_/g, '')}.sim`,
  );
  const handle = claimHandle(
    taken,
    normaliseHandle(
      `${countrySlug(charter.function_key).slice(0, 10)}_desk_${orgSlug.slice(0, 8)}`,
    ),
    orgSlug.slice(0, 4),
  );
  return {
    id,
    name,
    title,
    organisation: org.display_name,
    relationship: 'internal',
    owning_team: charter.function_key,
    org_key: multiOrg ? org.org_key : null,
    email,
    phone: null,
    handle,
    note: `${title}. Internal desk for ${charter.function_key} at ${org.display_name}; answers status questions from the team.`,
    personality: 'Brisk, factual, procedural.',
    stance: 'Supportive of the team; wants clear requests.',
    knowledge: ['Current operational status as circulated internally'],
    will_not_disclose: ['Anything not yet confirmed by the operations lead'],
    grievance: '',
    resolution_criteria: [],
    persuadability: 'medium',
    hard_constraints: [],
  };
}

function inferRelationships(c: OrgTeamCharter): StakeholderRelationship[] {
  const text = `${c.mission} ${c.responsibilities.join(' ')}`.toLowerCase();
  const rels: StakeholderRelationship[] = ['internal'];
  if (/customer|client|passenger|patient|member/.test(text)) rels.push('client');
  if (/supplier|vendor|logistic|franchise/.test(text)) rels.push('supplier');
  if (/regulator|ministry|authority|court|law|legal|compliance/.test(text)) rels.push('regulator');
  if (/press|media|journalist|public/.test(text)) rels.push('media');
  if (/community|resident|family|barangay|union|worker|employee/.test(text)) rels.push('community');
  if (/partner|agency|liaison|coordinat/.test(text)) rels.push('partner');
  return Array.from(new Set(rels));
}

function factsBlock(f: FactSheet): string {
  return `Confirmed facts: ${f.confirmed_facts.join('; ')}\nFalse/unverified claims: ${f.unconfirmed_claims.map((c) => `"${c.claim}" (${c.status})`).join('; ')}`;
}

function personaBlock(personas: NPCPersona[]): string {
  const list = personas
    .slice(0, 12)
    .map((p) => `${p.handle} (${p.name}, ${p.type})`)
    .join(', ');
  return list
    ? `Public voices already in the feed (do not duplicate them as stakeholders): ${list}`
    : '';
}

function claimId(taken: TakenIdentifiers, wanted: string): string {
  let id = wanted.replace(/_+/g, '_');
  let n = 2;
  while (taken.ids.has(id)) id = `${wanted}_${n++}`.slice(0, 60);
  taken.ids.add(id);
  return id;
}

function claimEmail(taken: TakenIdentifiers, wanted: string): string {
  let email = wanted.toLowerCase().replace(/[^a-z0-9@._-]/g, '');
  const [local, domain] = email.split('@');
  let n = 2;
  while (taken.emails.has(email)) email = `${local}${n++}@${domain}`;
  taken.emails.add(email);
  return email;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out.length > 0 ? out : [[]];
}

function mergeResults(results: StakeholderGenerationResult[]): StakeholderGenerationResult {
  return {
    stakeholders: results.flatMap((r) => r.stakeholders),
    injects: results.flatMap((r) => r.injects),
    personaTwins: results.flatMap((r) => r.personaTwins),
  };
}
