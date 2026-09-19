import { logger } from '../lib/logger.js';
import type { ScenarioBlueprint } from './blueprint/blueprintTypes.js';
import {
  callSocialCrisisAI,
  adaptTeamCharters,
  synthesizeTeamCharter,
  generateAllTeamStorylines,
  type NPCPersona,
  type FactSheet,
  type SocialInject,
  type TeamDef,
  type OrgPromptContext,
} from './socialCrisisGeneratorService.js';
import {
  EXECUTIVE_CHARTER,
  EXECUTIVE_FUNCTION,
  getCatalogCharterByFunction,
  type NormalisedOrg,
  type OrgTeamCharter,
} from './scenarioOrgModel.js';
import { countryDialPrefix } from '../../shared/countries.js';

/**
 * Multi-organisation generation orchestration (contract §5): the parts of the
 * pipeline that run ONCE per scenario (fact sheet), PER COUNTRY (public crowd)
 * and PER ORGANISATION (charters, team storylines). Single-org scenarios run
 * through the same functions with one org and one country.
 */

export interface CrisisContext {
  crisisType: string;
  context: string;
  duration: number;
  orgName?: string;
  blueprint?: ScenarioBlueprint | null;
}

/** Identifiers already used anywhere in the scenario; shared across every parallel branch. */
export interface TakenIdentifiers {
  handles: Set<string>;
  emails: Set<string>;
  ids: Set<string>;
}

export function newTakenIdentifiers(): TakenIdentifiers {
  return { handles: new Set(), emails: new Set(), ids: new Set() };
}

/** Claim a handle, suffixing deterministically on collision. */
export function claimHandle(taken: TakenIdentifiers, wanted: string, suffix: string): string {
  const handle = normaliseHandle(wanted);
  if (!taken.handles.has(handle)) {
    taken.handles.add(handle);
    return handle;
  }
  const base = handle.slice(0, Math.max(3, 30 - suffix.length - 1));
  let candidate = `${base}_${suffix}`.slice(0, 31);
  let n = 2;
  while (taken.handles.has(candidate)) {
    candidate = `${base.slice(0, Math.max(3, 30 - suffix.length - 3))}_${suffix}${n++}`.slice(
      0,
      31,
    );
  }
  logger.warn({ original: handle, final: candidate }, 'handle_collision_suffixed');
  taken.handles.add(candidate);
  return candidate;
}

export function normaliseHandle(raw: string): string {
  const body = String(raw || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
  return `@${body.length >= 3 ? body : `${body}${'x'.repeat(3 - body.length)}`}`;
}

export function orgPromptContext(org: NormalisedOrg, allOrgs: NormalisedOrg[]): OrgPromptContext {
  return {
    display_name: org.display_name,
    short_name: org.short_name,
    country: org.country,
    city: org.city,
    kind: org.kind,
    other_orgs: allOrgs
      .filter((o) => o.org_key !== org.org_key)
      .map((o) => ({
        display_name: o.display_name,
        country: o.country,
        same_country: o.country === org.country,
      })),
  };
}

// ─── Once per scenario: fact sheet + communities ─────────────────────────────

export async function generateFactSheetAndCommunities(
  crisis: CrisisContext,
  orgs: NormalisedOrg[],
): Promise<{ factSheet: FactSheet; communities: string[] }> {
  const countries = Array.from(new Set(orgs.map((o) => o.country)));
  const result = await callSocialCrisisAI(
    `You are an expert crisis simulation designer creating the GROUND TRUTH for a training exercise.

First analyse the crisis description and identify its type (product recall, corporate scandal, labour dispute, kidnapping / public-safety incident, data breach, environmental disaster, ...). Tailor everything to that crisis. Do NOT assume racial or religious tension unless the description says so.

Produce:
1. AFFECTED STAKEHOLDER GROUPS: 2-6 concrete groups most affected or most vocal, across all countries involved.
2. FACT SHEET — the simulation's ground truth:
   - confirmed_facts: 6-12 facts official sources have confirmed. Where the crisis spans several countries or organisations, include facts specific to each (what happened where, which agency/office holds which fact).
   - unconfirmed_claims: 5-8 false or unverified claims circulating, each with claim, status (FALSE|UNVERIFIED), truth, and spread_by (empty array for now).
   - crisis_cluster: Coombs SCCT responsibility: "victim" | "accidental" | "preventable".

Return ONLY valid JSON:
{ "communities": ["..."], "fact_sheet": { "confirmed_facts": ["..."], "unconfirmed_claims": [{ "claim": "...", "status": "FALSE", "truth": "...", "spread_by": [] }], "crisis_cluster": "victim|accidental|preventable" } }`,
    `Crisis scenario: ${crisis.crisisType}${crisis.orgName ? `\nOrganisation under crisis: ${crisis.orgName}` : ''}
Countries involved: ${countries.join(', ')}
Organisations: ${orgs.map((o) => `${o.display_name} (${o.kind}, ${o.country}${o.is_primary ? ', primary' : ''})`).join('; ')}
Detailed context: ${crisis.context}`,
    6000,
    0.7,
  );

  const factSheet = (result?.fact_sheet as FactSheet) || {
    confirmed_facts: [],
    unconfirmed_claims: [],
  };
  if (!Array.isArray(factSheet.confirmed_facts)) factSheet.confirmed_facts = [];
  if (!Array.isArray(factSheet.unconfirmed_claims)) factSheet.unconfirmed_claims = [];
  const communities = Array.isArray(result?.communities)
    ? (result!.communities as unknown[]).map(String).filter(Boolean)
    : [];
  return { factSheet, communities };
}

// ─── Per country: the public crowd ───────────────────────────────────────────

const KEY_PERSONAS_PER_COUNTRY = 14;
const BACKGROUND_BATCH = 40;

export async function generatePersonasForCountry(
  crisis: CrisisContext,
  country: string,
  orgsInCountry: NormalisedOrg[],
  factSheet: FactSheet,
  taken: TakenIdentifiers,
  targetCount = 200,
  onProgress?: (msg: string) => void,
): Promise<NPCPersona[]> {
  const orgList =
    orgsInCountry.map((o) => `${o.display_name} (${o.kind})`).join(', ') || 'none named';
  const factsContext = `Confirmed: ${factSheet.confirmed_facts.join('; ')}\nFalse claims: ${factSheet.unconfirmed_claims.map((c) => `"${c.claim}" (${c.status})`).join('; ')}`;

  onProgress?.(`${country}: generating key voices...`);
  const keyResult = await callSocialCrisisAI(
    `You are creating the KEY social media characters for ONE COUNTRY in a crisis simulation. Everything must be authentic to ${country}: names, institutions, media outlets, slang-free but locally flavoured register, and the organisations present there.

Generate ${KEY_PERSONAS_PER_COUNTRY} key personas that drive the public conversation in ${country}:
- 5-6 HOSTILE/OUTRAGED voices (each a distinct angle of attack; some may spread the false claims below — set specific_claims)
- 2-3 FEAR/AMPLIFIER voices
- 2-3 SUPPORTIVE/REASONED voices (experts, community advocates)
- 2-3 MEDIA voices (${country} outlets or journalists) — type "npc_media"
- 1 WILDCARD (politician / influencer) — type "npc_politician" or "npc_influencer"

For EACH persona: handle (unique, lowercase, letters/digits/underscore), name (culturally appropriate for ${country}), type, personality (2-3 sentences), bias, follower_count, backstory (2 sentences), posting_pattern, specific_claims (0-3 from the false claims, or empty), image_prompts (0-2).

Organisations in ${country}: ${orgList}
Facts and claims:
${factsContext}

Return ONLY valid JSON: { "personas": [ { "handle": "@...", "name": "...", "type": "npc_public|npc_media|npc_politician|npc_influencer", "personality": "...", "bias": "...", "follower_count": 0, "backstory": "...", "posting_pattern": "...", "specific_claims": [], "image_prompts": [] } ] }`,
    `Crisis: ${crisis.crisisType}${crisis.orgName ? `\nOrganisation under crisis: ${crisis.orgName}` : ''}\nCountry: ${country}\nContext: ${crisis.context}`,
    8000,
    0.8,
  );

  const personas: NPCPersona[] = [];
  for (const raw of (keyResult?.personas as Array<Record<string, unknown>>) || []) {
    const p = toPersona(raw, country, 'key');
    p.handle = claimHandle(taken, p.handle, countrySuffix(country));
    personas.push(p);
  }
  logger.info({ country, added: personas.length }, 'crowd_key_voices_complete');

  // Background batches until the target (never fail on shortfall).
  const batches = Math.max(0, Math.ceil((targetCount - personas.length) / BACKGROUND_BATCH));
  for (let b = 0; b < batches; b++) {
    onProgress?.(`${country}: background crowd batch ${b + 1}/${batches}...`);
    const existing = Array.from(taken.handles).slice(-120);
    const bgResult = await callSocialCrisisAI(
      `You are generating BACKGROUND social media users in ${country} for a crisis simulation: regular people who mix crisis reactions with normal life content.

Generate exactly ${BACKGROUND_BATCH} unique personas. Names culturally appropriate for ${country}. Handles unique (lowercase letters/digits/underscore).
${existing.length > 0 ? `Do NOT reuse any of these handles: ${existing.join(', ')}` : ''}

Each: handle, name, type "npc_public", personality (1 sentence), bias ("angry"|"sympathetic"|"indifferent"|"skeptical"|"supportive"|"none"), follower_count (50-2000), normal_interests (2-3 topics).

Return ONLY valid JSON: { "personas": [ { "handle": "@user", "name": "Name", "type": "npc_public", "personality": "...", "bias": "...", "follower_count": 200, "normal_interests": ["cooking", "football"] } ] }`,
      `Batch ${b + 1} of background users in ${country} for: ${crisis.crisisType.substring(0, 200)}`,
      6000,
      0.9,
    );
    const rawList = (bgResult?.personas as Array<Record<string, unknown>>) || [];
    let added = 0;
    for (const raw of rawList) {
      const p = toPersona(raw, country, 'background');
      p.handle = claimHandle(taken, p.handle, countrySuffix(country));
      personas.push(p);
      added++;
    }
    logger.info({ country, batch: b + 1, added, total: personas.length }, 'crowd_batch_complete');
    if (rawList.length === 0) break; // AI shortfall: stop early
  }

  if (personas.length < 50) {
    logger.warn({ country, count: personas.length }, 'crowd_shortfall');
  }
  return personas;
}

function countrySuffix(country: string): string {
  return country
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .slice(0, 2);
}

function toPersona(
  raw: Record<string, unknown>,
  country: string,
  tier: 'key' | 'background',
): NPCPersona {
  const type = String(raw.type || 'npc_public');
  return {
    handle: normaliseHandle(String(raw.handle || 'user')),
    name: String(raw.name || 'Unknown'),
    type: (['npc_public', 'npc_media', 'npc_politician', 'npc_influencer'].includes(type)
      ? type
      : 'npc_public') as NPCPersona['type'],
    personality: String(raw.personality || ''),
    bias: String(raw.bias || 'none'),
    follower_count: Number(raw.follower_count) || (tier === 'key' ? 5000 : 200),
    backstory: String(raw.backstory || ''),
    posting_pattern: String(raw.posting_pattern || ''),
    specific_claims: Array.isArray(raw.specific_claims)
      ? (raw.specific_claims as unknown[]).map(String)
      : [],
    image_prompts: Array.isArray(raw.image_prompts)
      ? (raw.image_prompts as unknown[]).map(String)
      : [],
    tier,
    normal_interests: Array.isArray(raw.normal_interests)
      ? (raw.normal_interests as unknown[]).map(String)
      : [],
    country,
  };
}

// ─── Per organisation: charters ──────────────────────────────────────────────

export async function buildOrgCharters(
  org: NormalisedOrg,
  allOrgs: NormalisedOrg[],
  crisis: CrisisContext,
): Promise<OrgTeamCharter[]> {
  const orgCtx = orgPromptContext(org, allOrgs);
  const multiOrg = allOrgs.length > 1;
  const presetFunctions = org.teams
    .filter((t) => !t.is_custom && t.function_key !== EXECUTIVE_FUNCTION)
    .map((t) => t.function_key);
  const customs = org.teams.filter((t) => t.is_custom);

  const [presets, customCharters] = await Promise.all([
    presetFunctions.length > 0
      ? adaptTeamCharters(
          crisis.crisisType,
          crisis.context,
          org.country,
          org.display_name,
          presetFunctions,
          orgCtx,
        )
      : Promise.resolve([]),
    Promise.all(
      customs.map((t) =>
        synthesizeTeamCharter(
          t.function_key,
          t.description,
          {
            crisisType: crisis.crisisType,
            context: crisis.context,
            country: org.country,
            orgName: org.display_name,
          },
          t.is_public_voice,
          orgCtx,
        ),
      ),
    ),
  ]);

  const byFunction = new Map<string, (typeof presets)[number]>();
  for (const p of presets) byFunction.set(p.team_name, p);
  for (const c of customCharters) byFunction.set(c.team_name, c);

  return org.teams.map((t) => {
    const base =
      t.function_key === EXECUTIVE_FUNCTION
        ? EXECUTIVE_CHARTER
        : (byFunction.get(t.function_key) ?? getCatalogCharterByFunction(t.function_key));
    const fallback: OrgTeamCharter = {
      team_name: t.team_name,
      mission: t.description || `${t.function_key} for ${org.display_name}`,
      responsibilities: [],
      expected_actions: [],
      scoring_rubric: '',
      out_of_lane: [],
      min_participants: 1,
      max_participants: 4,
      is_custom: t.is_custom,
      can_post_publicly: t.is_public_voice,
      sentiment_dimension: 'public_trust',
      org_key: multiOrg ? org.org_key : null,
      function_key: t.function_key,
      country: org.country,
      short_name: org.short_name,
    };
    if (!base) return fallback;
    return {
      ...base,
      team_name: t.team_name,
      is_custom: t.is_custom,
      can_post_publicly: t.is_public_voice,
      org_key: multiOrg ? org.org_key : null,
      function_key: t.function_key,
      country: org.country,
      short_name: org.short_name,
    };
  });
}

// ─── Per organisation: team storylines ───────────────────────────────────────

export async function generateOrgTeamStorylines(
  org: NormalisedOrg,
  allOrgs: NormalisedOrg[],
  charters: OrgTeamCharter[],
  crisis: CrisisContext,
  personasInCountry: NPCPersona[],
  factSheet: FactSheet,
  onTeamComplete?: (teamName: string, injectCount: number) => void,
): Promise<Record<string, SocialInject[]>> {
  const multiOrg = allOrgs.length > 1;
  const teamDefs: TeamDef[] = charters.map((c) => ({
    team_name: c.team_name,
    team_description: `${c.mission} Responsibilities: ${c.responsibilities.join('; ')}`,
    min_participants: c.min_participants,
    max_participants: c.max_participants,
  }));
  const keyPersonas = personasInCountry.filter((p) => p.tier === 'key');
  const storylines = await generateAllTeamStorylines(
    teamDefs,
    {
      crisisType: crisis.crisisType,
      location: org.city || org.country,
      country: org.country,
      context: crisis.context,
      duration: crisis.duration,
      orgName: org.display_name,
    },
    keyPersonas.length > 0 ? keyPersonas : personasInCountry.slice(0, 14),
    factSheet,
    onTeamComplete,
    multiOrg ? orgPromptContext(org, allOrgs) : null,
  );

  // Stamp scoping keys (code, never the model): org for private delivery, country for feed visibility.
  const dial = countryDialPrefix(org.country);
  for (const injects of Object.values(storylines)) {
    for (const inj of injects) {
      const dc = { ...(inj.delivery_config || { app: 'social_feed' as const }) };
      if (multiOrg) {
        dc.org_key = org.org_key;
        dc.country = org.country;
      }
      if (dc.app === 'phone_call' && dc.from_address && !String(dc.from_address).startsWith('+')) {
        dc.from_address = `${dial} ${dc.from_address}`;
      }
      inj.delivery_config = dc;
    }
  }
  return storylines;
}
