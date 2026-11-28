import {
  FIXED_TEAM_NAMES,
  getCatalogCharter,
  canonicalPresetName,
  type TeamCharter,
  type TeamExpectedAction,
} from './teamCharterService.js';
import { countryCode, countrySlug, isKnownCountry } from '../../shared/countries.js';
import {
  resolveTeamFunction,
  type CountryEntry,
  type OrgRegistryEntry,
} from '../lib/stakeholderContract.js';

// ─── Generator-side extensions of the shared contract (§5.1 kind) ────────────

export type OrgKind = 'company' | 'office' | 'agency' | 'ngo' | 'other';

/**
 * Generator-owned organisation model (contract §5): organisation inputs from
 * the wizard, org keys, short names, composed team names, the canonical
 * registry, and the Executive team preset. Pure functions — no DB, no AI.
 *
 * teamCharterService.ts is runtime-owned; this file only imports its catalog.
 */

// ─── Inputs (wire shapes from the wizard) ────────────────────────────────────

export interface RosterEntryInput {
  /** Preset function name or the trainer's custom department name. */
  team_name: string;
  description?: string;
  is_custom?: boolean;
  is_public_voice?: boolean;
  /** Set on an existing team so a rename keeps the same logical team. */
  team_uid?: string;
}

export interface OrganisationInput {
  org_key?: string;
  /** Stable organisation id from the baseline snapshot. New cards omit it. */
  org_uid?: string;
  display_name: string;
  short_name?: string;
  country: string;
  city?: string;
  kind?: OrgKind;
  facebook_handle?: string;
  x_handle?: string;
  logo_url?: string;
  is_primary: boolean;
  team_roster: RosterEntryInput[];
  /** 'ai' = nobody plays this office; its page and carriers are simulated (pressure plan §12). */
  operation?: 'players' | 'ai';
}

export interface CompetitorInput {
  name: string;
  country: string;
  facebook_handle?: string;
  x_handle?: string;
  /** Kept when it is already an antagonist key; otherwise a key is derived. */
  org_key?: string;
  /** Trainer text. Maps onto the runtime stance; there is no second field. */
  description?: string;
}

/** Pressure organisation as entered / accepted in the wizard (pressure plan §5.1). */
export type PressureKind = 'union' | 'regulator' | 'ngo' | 'community_group' | 'political';
export type PressureRegister = 'statutory' | 'advocacy' | 'grassroots' | 'political';

export interface PressureOrgInput {
  org_key?: string;
  display_name: string;
  kind: PressureKind;
  country: string;
  city?: string;
  register?: PressureRegister;
  /** Free text from the trainer: what this body wants. */
  wants?: string;
  facebook_handle?: string;
  x_handle?: string;
  /** Filled by the storyline stage; round-tripped to org-page + compile. */
  spokesperson_stakeholder_id?: string;
  /** Protagonist org_keys it presses; defaults to the protagonists in its country, else all. */
  targets_org_keys?: string[];
}

export interface NormalisedPressureOrg {
  org_key: string;
  display_name: string;
  short_name: string;
  kind: PressureKind;
  country: string;
  city?: string;
  register: PressureRegister;
  wants?: string;
  facebook_handle?: string;
  x_handle?: string;
  spokesperson_stakeholder_id?: string;
  targets_org_keys: string[];
}

export function defaultRegisterFor(kind: PressureKind): PressureRegister {
  switch (kind) {
    case 'regulator':
      return 'statutory';
    case 'union':
    case 'ngo':
      return 'advocacy';
    case 'community_group':
      return 'grassroots';
    case 'political':
      return 'political';
  }
}

// ─── Normalised organisation (what generation runs on) ───────────────────────

export interface NormalisedTeam {
  /** Composed, scenario-unique identity ("Communications — NBI" or bare "Communications"). */
  team_name: string;
  /** Present when the team already existed in the baseline. */
  team_uid?: string;
  /** Catalog name or custom slug (Title Case). Never null for generated teams. */
  function_key: string;
  description: string;
  is_custom: boolean;
  is_public_voice: boolean;
}

export interface NormalisedOrg {
  org_key: string;
  org_uid?: string;
  display_name: string;
  short_name: string;
  country: string;
  city?: string;
  kind: OrgKind;
  facebook_handle?: string;
  x_handle?: string;
  logo_url?: string;
  is_primary: boolean;
  teams: NormalisedTeam[];
  operation: 'players' | 'ai';
}

export interface NormalisedCompetitor {
  org_key: string;
  name: string;
  country: string;
  facebook_handle?: string;
  x_handle?: string;
  description?: string;
}

/** Generator-side charter = runtime TeamCharter + organisation identity. */
export type OrgTeamCharter = TeamCharter & {
  org_key: string | null;
  function_key: string;
  country: string;
  short_name: string;
};

export interface ValidationDetail {
  code: string;
  path: string;
  message: string;
}

export type OrganisationsValidation =
  | {
      ok: true;
      orgs: NormalisedOrg[];
      competitors: NormalisedCompetitor[];
      pressureOrgs: NormalisedPressureOrg[];
      multiOrg: boolean;
    }
  | { ok: false; code: string; message: string; details: ValidationDetail[] };

// ─── Presets ─────────────────────────────────────────────────────────────────

export const EXECUTIVE_FUNCTION = 'Executive';

/**
 * Executive Leadership preset (contract §7A). Real executives join as players.
 * Expected actions use ONLY today's detection vocabulary and no detection_hints,
 * so leadership scoring works before any runtime decision-layer work ships.
 */
export const EXECUTIVE_CHARTER: TeamCharter = {
  team_name: EXECUTIVE_FUNCTION,
  mission:
    'Set the organisation\u2019s position and direct the response. You decide, you authorise the departments, and you own the consequences of every decision made during the crisis.',
  responsibilities: [
    'Decide the organisational position and priorities as the crisis develops',
    'Give written direction to departments and authorise their actions',
    'Approve external statements before Communications publishes them',
    'Engage the board, regulators, and major partners personally when the stakes require it',
    'Verify facts before deciding; do not act on rumour',
    'Relay information you hold that a department needs, and ask departments for facts you are missing',
  ],
  expected_actions: [
    {
      action_id: 'exec_brief_departments',
      description: 'Brief the departments on direction and priorities',
      detection_action_type: 'chat_message_sent',
      timing_benchmark_minutes: 10,
      weight: 25,
      tier: 1,
    },
    {
      action_id: 'exec_written_direction',
      description: 'Issue written direction or engage a senior stakeholder by email',
      detection_action_type: 'email_sent',
      timing_benchmark_minutes: 20,
      weight: 30,
      tier: 2,
    },
    {
      action_id: 'exec_approve_statement',
      description: 'Approve the official statement before it is published',
      detection_action_type: 'draft_approved',
      timing_benchmark_minutes: 30,
      weight: 30,
      tier: 2,
    },
    {
      action_id: 'exec_verify_before_deciding',
      description: 'Verify claims against confirmed facts before deciding',
      detection_action_type: 'fact_checked',
      timing_benchmark_minutes: 15,
      weight: 15,
      tier: 1,
    },
  ],
  scoring_rubric:
    'Judge as executive leadership: clarity and timeliness of direction, consistency between the decision taken and the public message, humanity toward affected people, adherence to company SOP (affected stakeholders engaged before external communication), and no public commitments the departments cannot honour. Penalise indecision under pressure, contradiction of earlier statements, and bypassing the departments.',
  out_of_lane: [
    'Drafting operational content or handling individual customer complaints',
    'Posting publicly without Communications (unless designated the public voice)',
    'Negotiating supplier terms or legal wording personally',
  ],
  min_participants: 1,
  max_participants: 6,
  can_post_publicly: false,
  sentiment_dimension: 'public_trust',
};

/** Preset functions the roster builder offers: the runtime catalog plus Executive. */
export const GENERATOR_PRESET_FUNCTIONS: readonly string[] = [
  ...FIXED_TEAM_NAMES,
  EXECUTIVE_FUNCTION,
];

export function isPresetFunction(name: string): boolean {
  return GENERATOR_PRESET_FUNCTIONS.includes(name);
}

/** Catalog charter for a function (runtime catalog incl. retired presets, or Executive), else null. */
export function getCatalogCharterByFunction(functionKey: string): TeamCharter | null {
  if (functionKey === EXECUTIVE_FUNCTION) return EXECUTIVE_CHARTER;
  return getCatalogCharter(functionKey);
}

/** Catalog charter for a persisted team row via the contract's resolver. */
export function getCatalogCharterForTeam(team: {
  team_name: string;
  function_key: string | null;
}): TeamCharter | null {
  return getCatalogCharterByFunction(resolveTeamFunction(team));
}

/** function_key for a team row: explicit from the charter, else the catalog name when the team IS one, else null (custom). */
export function functionKeyForTeamRow(
  teamName: string,
  charter?: { function_key?: string | null } | null,
): string | null {
  if (charter?.function_key) return charter.function_key;
  return isPresetFunction(teamName) ? teamName : null;
}

// ─── Naming helpers ──────────────────────────────────────────────────────────

const SHORT_NAME_STOPWORDS = new Set(['of', 'the', 'and', 'for', 'de', 'la', 'del']);
const TEAM_NAME_MAX = 100;
const TEAM_NAME_SEPARATOR = ' \u2014 '; // " — "

/** Title-cased stable slug for a custom department ("anti kidnapping liaison" -> "Anti Kidnapping Liaison"). */
export function functionKeyFor(entry: RosterEntryInput): string {
  const raw = entry.team_name.trim().replace(/\s+/g, ' ');
  if (!entry.is_custom && isPresetFunction(raw)) return raw;
  return raw
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
    .slice(0, 40);
}

/** Initials of the display name ("National Bureau of Investigation" -> "NBI"); single words keep 6 chars. */
export function deriveShortName(displayName: string, taken: Set<string>, country: string): string {
  const words = displayName
    .trim()
    .split(/\s+/)
    .filter((w) => w && !SHORT_NAME_STOPWORDS.has(w.toLowerCase()));
  let base =
    words.length >= 2
      ? words
          .map((w) => w.charAt(0))
          .join('')
          .toUpperCase()
          .slice(0, 6)
      : (words[0] ?? displayName).slice(0, 6);
  if (!base) base = 'ORG';
  let candidate = base;
  if (taken.has(candidate.toLowerCase())) {
    candidate = `${base} ${countryCode(country).toUpperCase()}`;
  }
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${base}${n++}`;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/** Stable org key: primary keeps 'primary' (runtime depends on it); others org_<slug>_<cc>. */
export function makeOrgKey(
  org: { display_name: string; short_name?: string; country: string; is_primary: boolean },
  taken: Set<string>,
): string {
  if (org.is_primary) {
    taken.add('primary');
    return 'primary';
  }
  const slug = countrySlug(org.short_name || org.display_name).replace(/_+/g, '_') || 'org';
  const base = `org_${slug}_${countryCode(org.country)}`.slice(0, 60);
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) candidate = `${base}_${n++}`;
  taken.add(candidate);
  return candidate;
}

/** Antagonist org key, matching the existing page scheme (org_antagonist_<slug>_<i>). */
export function makeAntagonistOrgKey(name: string, index: number, taken: Set<string>): string {
  const slug = countrySlug(name) || 'rival';
  let candidate = `org_antagonist_${slug}_${index}`.slice(0, 64);
  let n = 2;
  while (taken.has(candidate)) candidate = `org_antagonist_${slug}_${index}_${n++}`.slice(0, 64);
  taken.add(candidate);
  return candidate;
}

/**
 * The ONE place team names are composed (§2.3). Single-org scenarios keep the
 * bare function so today's behaviour is unchanged; multi-org appends the org's
 * short name. Truncates the short name to respect VARCHAR(100).
 */
export function composeTeamName(
  functionKey: string,
  org: { short_name: string },
  multiOrg: boolean,
): string {
  if (!multiOrg) return functionKey;
  const budget = TEAM_NAME_MAX - functionKey.length - TEAM_NAME_SEPARATOR.length;
  const short = budget > 0 ? org.short_name.slice(0, budget) : '';
  return short
    ? `${functionKey}${TEAM_NAME_SEPARATOR}${short}`
    : functionKey.slice(0, TEAM_NAME_MAX);
}

// ─── Validation + normalisation (route + compile; wizard mirrors the rules) ──

const MIN_TEAMS = 2;

/** A baseline team an edit must keep identifiable across a rename. */
export interface StoredTeamIdentity {
  team_uid: string;
  team_name: string;
  org_key: string;
  function_key?: string;
}

/**
 * Pin identities while editing a compiled scenario. Absent on the create path,
 * which still derives keys and composes team names.
 */
export interface OrganisationIdentityOptions {
  /** Active baseline org keys. A card key in this set is kept. */
  baseline_org_keys: readonly string[];
  /** Org key that is primary in the baseline. Defaults to `primary` when that key is baseline. */
  baseline_primary_org_key?: string;
  /** Retired keys, and any other key a newly added organisation must not reuse. */
  retired_org_keys?: readonly string[];
  teams?: readonly StoredTeamIdentity[];
  /**
   * "Use organisation short names in every team name". Existing teams whose card
   * still shows the stored name are recomposed. An explicit rename on the card wins.
   */
  compose_existing_team_names?: boolean;
  /**
   * Card `org_key` of an existing or newly added organisation that becomes the
   * primary. The key itself is not rewritten here; the remap planner does that.
   */
  make_primary?: string | null;
}

function claimProvidedKey(
  key: string | undefined,
  pattern: RegExp,
  taken: Set<string>,
  honourable: Set<string> | null,
): string | null {
  if (!key || !pattern.test(key)) return null;
  if (honourable) {
    if (!honourable.has(key)) return null;
    honourable.delete(key);
    taken.add(key);
    return key;
  }
  if (taken.has(key)) return null;
  taken.add(key);
  return key;
}

function baselinePrimaryKey(identities: OrganisationIdentityOptions): string {
  if (identities.baseline_primary_org_key) return identities.baseline_primary_org_key;
  return identities.baseline_org_keys.includes('primary') ? 'primary' : '';
}

function teamNameForEdit(
  entry: RosterEntryInput,
  functionKey: string,
  shortName: string,
  multiOrg: boolean,
  identities: OrganisationIdentityOptions | undefined,
): { team_name: string; team_uid?: string } {
  const composed = composeTeamName(functionKey, { short_name: shortName }, multiOrg);
  if (!identities || !entry.team_uid) return { team_name: composed };
  const stored = identities.teams?.find((team) => team.team_uid === entry.team_uid);
  if (!stored) return { team_name: composed, team_uid: entry.team_uid };
  const requested = String(entry.team_name || '').trim();
  const unchanged =
    requested === stored.team_name || requested === (stored.function_key ?? '');
  if (identities.compose_existing_team_names && unchanged) {
    return {
      team_name: composeTeamName(functionKey, { short_name: shortName }, true),
      team_uid: stored.team_uid,
    };
  }
  if (unchanged) return { team_name: stored.team_name, team_uid: stored.team_uid };
  return { team_name: requested.slice(0, TEAM_NAME_MAX), team_uid: stored.team_uid };
}

export function validateOrganisations(
  input: OrganisationInput[],
  competitorsInput: CompetitorInput[] = [],
  pressureInput: PressureOrgInput[] = [],
  identities?: OrganisationIdentityOptions,
): OrganisationsValidation {
  const details: ValidationDetail[] = [];
  const fail = (code: string, path: string, message: string) =>
    details.push({ code, path, message });

  if (!Array.isArray(input) || input.length < 1) {
    fail('MO-ORG-001', 'organisations', 'Choose at least 1 organisation');
    return { ok: false, code: 'MO-ORG-001', message: details[0].message, details };
  }

  const primaries = input.filter((o) => o.is_primary);
  if (!identities && input.length === 1) {
    input[0].is_primary = true;
  } else if (!identities && primaries.length !== 1) {
    fail('MO-ORG-002', 'organisations', 'Exactly one organisation must be marked primary');
  } else if (identities) {
    const baselinePrimary = baselinePrimaryKey(identities);
    const submitted = new Set(
      input.map((org) => org.org_key?.trim()).filter((key): key is string => !!key),
    );
    const named = identities.make_primary?.trim() ?? '';
    if (baselinePrimary && !submitted.has(baselinePrimary) && !(named && submitted.has(named))) {
      fail('MO-EDIT-001', 'organisations', 'Make another organisation primary first');
    }
  }

  const seenNames = new Set<string>();
  const takenShort = new Set<string>();
  const honourable = identities ? new Set(identities.baseline_org_keys) : null;
  const takenKeys = new Set<string>(
    identities ? [...identities.baseline_org_keys, ...(identities.retired_org_keys ?? [])] : [],
  );
  const multiOrg = input.length > 1;
  const orgs: NormalisedOrg[] = [];

  // Primary first so it always claims 'primary'.
  const ordered = [...input].sort((a, b) => Number(b.is_primary) - Number(a.is_primary));

  for (const raw of ordered) {
    const displayName = String(raw.display_name || '').trim();
    const path = `organisations.${displayName || '?'}`;
    if (displayName.length < 2 || displayName.length > 120) {
      fail('MO-ORG-003', path, 'Organisation name must be 2-120 characters');
    }
    if (seenNames.has(displayName.toLowerCase())) {
      fail('MO-ORG-003', path, `Organisation names must be unique: "${displayName}"`);
    }
    seenNames.add(displayName.toLowerCase());

    const country = String(raw.country || '').trim();
    if (!isKnownCountry(country)) {
      fail('MO-ORG-004', path, `Unknown country "${country}" for ${displayName || 'organisation'}`);
    }

    const shortName = raw.short_name?.trim()
      ? raw.short_name.trim().slice(0, 20)
      : deriveShortName(displayName || 'Org', takenShort, country || 'Singapore');
    if (raw.short_name?.trim()) takenShort.add(shortName.toLowerCase());

    const provisional = raw.org_key?.trim() ?? '';
    let orgKey: string;
    if (identities && provisional && honourable?.has(provisional)) {
      honourable.delete(provisional);
      takenKeys.add(provisional);
      orgKey = provisional;
    } else if (identities && provisional && identities.baseline_org_keys.includes(provisional)) {
      fail('MO-ORG-003', path, `Organisation key "${provisional}" is already used`);
      orgKey = makeOrgKey(
        { display_name: displayName, short_name: shortName, country, is_primary: false },
        takenKeys,
      );
    } else {
      // A new organisation never takes `primary` here. A swap re-keys in the planner.
      orgKey = makeOrgKey(
        {
          display_name: displayName,
          short_name: shortName,
          country,
          is_primary: identities ? false : !!raw.is_primary,
        },
        takenKeys,
      );
    }

    // Roster
    const roster = Array.isArray(raw.team_roster) ? raw.team_roster : [];
    if (roster.length < MIN_TEAMS) {
      fail(
        'MO-TEAM-001',
        `${path}.team_roster`,
        `${displayName || 'Each organisation'}: choose at least ${MIN_TEAMS} teams`,
      );
    }
    const teams: NormalisedTeam[] = [];
    const seenFunctions = new Set<string>();
    let executiveCount = 0;
    for (const entry of roster) {
      const storedTeam =
        identities && entry.team_uid
          ? identities.teams?.find((team) => team.team_uid === entry.team_uid)
          : undefined;
      const requestedName = String(entry.team_name || '').trim();
      const unchangedExisting =
        !!storedTeam &&
        (requestedName === storedTeam.team_name || requestedName === (storedTeam.function_key ?? ''));
      const parsedEntry =
        unchangedExisting && storedTeam?.function_key
          ? {
              ...entry,
              team_name: storedTeam.function_key,
              is_custom: !isPresetFunction(storedTeam.function_key),
            }
          : entry;
      const rawName = String(parsedEntry.team_name || '').trim();
      if (!rawName) {
        fail('MO-TEAM-001', `${path}.team_roster`, 'Every team needs a name');
        continue;
      }
      // Retired preset names (Procurement / Sales) from older drafts map to their replacements.
      const legacyAlias = !parsedEntry.is_custom ? canonicalPresetName(rawName) : null;
      const name = legacyAlias && legacyAlias !== rawName ? legacyAlias : rawName;
      const isCustom = !!parsedEntry.is_custom || !isPresetFunction(name);
      if (!!parsedEntry.is_custom && isPresetFunction(name)) {
        fail(
          'MO-TEAM-001',
          `${path}.team_roster.${name}`,
          `"${name}" is a preset name — rename the custom department`,
        );
      }
      if (isCustom && String(parsedEntry.description || '').trim().length < 10) {
        fail(
          'MO-TEAM-005',
          `${path}.team_roster.${name}`,
          `Describe what "${name}" does (min 10 characters)`,
        );
      }
      const functionKey = functionKeyFor({ ...parsedEntry, team_name: name, is_custom: isCustom });
      if (seenFunctions.has(functionKey.toLowerCase())) {
        fail(
          'MO-TEAM-001',
          `${path}.team_roster.${name}`,
          `${displayName}: teams must have distinct functions ("${functionKey}" repeated)`,
        );
      }
      seenFunctions.add(functionKey.toLowerCase());
      if (functionKey === EXECUTIVE_FUNCTION) executiveCount++;
      const named = teamNameForEdit(parsedEntry, functionKey, shortName, multiOrg, identities);
      teams.push({
        team_name: named.team_name,
        ...(named.team_uid ? { team_uid: named.team_uid } : {}),
        function_key: functionKey,
        description: String(parsedEntry.description || '').trim(),
        is_custom: isCustom,
        is_public_voice: !!parsedEntry.is_public_voice,
      });
    }
    if (executiveCount > 1) {
      fail('MO-EXE-001', `${path}.team_roster`, `${displayName}: only one Executive team allowed`);
    }
    // Exactly one public voice per org: default Communications, else first non-Executive, else first.
    const voices = teams.filter((t) => t.is_public_voice);
    if (voices.length > 1) {
      fail(
        'MO-TEAM-004',
        `${path}.team_roster`,
        `${displayName}: tick exactly one team as public voice`,
      );
    } else if (voices.length === 0 && teams.length > 0) {
      const comms = teams.find((t) => t.function_key === 'Communications');
      const fallback =
        comms ?? teams.find((t) => t.function_key !== EXECUTIVE_FUNCTION) ?? teams[0];
      fallback.is_public_voice = true;
    }

    orgs.push({
      org_key: orgKey,
      ...(raw.org_uid?.trim() ? { org_uid: raw.org_uid.trim() } : {}),
      display_name: displayName,
      short_name: shortName,
      country,
      city: raw.city?.trim() || undefined,
      kind:
        raw.kind && (['company', 'office', 'agency', 'ngo', 'other'] as string[]).includes(raw.kind)
          ? raw.kind
          : 'company',
      facebook_handle: raw.facebook_handle?.trim() || undefined,
      x_handle: raw.x_handle?.trim() || undefined,
      logo_url: raw.logo_url?.trim() || undefined,
      is_primary: identities ? false : !!raw.is_primary,
      teams,
      operation: raw.operation === 'ai' ? 'ai' : 'players',
    });
  }
  if (identities) {
    const named = identities.make_primary?.trim() ?? '';
    const namedIndex = named
      ? ordered.findIndex((raw) => (raw.org_key?.trim() ?? '') === named)
      : -1;
    const baselineIndex =
      namedIndex >= 0
        ? -1
        : orgs.findIndex((org) => org.org_key === baselinePrimaryKey(identities));
    const primaryIndex = namedIndex >= 0 ? namedIndex : baselineIndex;
    if (primaryIndex >= 0) {
      orgs.forEach((org, index) => {
        org.is_primary = index === primaryIndex;
      });
    }
    if (
      orgs.filter((org) => org.is_primary).length !== 1 &&
      !details.some((detail) => detail.code === 'MO-EDIT-001')
    ) {
      fail('MO-ORG-002', 'organisations', 'Exactly one organisation must be marked primary');
    }
  }
  // MO-ORG-007: the primary organisation is where the human players are.
  const primaryOrg = orgs.find((o) => o.is_primary);
  if (primaryOrg && primaryOrg.operation === 'ai') {
    fail('MO-ORG-007', 'organisations', 'The primary organisation cannot be AI-operated');
  }

  // Composed names unique scenario-wide and within VARCHAR(100).
  const seenTeamNames = new Set<string>();
  for (const org of orgs) {
    for (const t of org.teams) {
      if (t.team_name.length > TEAM_NAME_MAX) {
        fail('MO-TEAM-001', `teams.${t.team_name}`, `Team name too long: "${t.team_name}"`);
      }
      const key = t.team_name.toLowerCase();
      if (seenTeamNames.has(key)) {
        fail(
          'MO-TEAM-001',
          `teams.${t.team_name}`,
          `Team name must be unique across organisations: "${t.team_name}"`,
        );
      }
      seenTeamNames.add(key);
    }
  }

  const competitors: NormalisedCompetitor[] = [];
  (competitorsInput || []).forEach((c, i) => {
    const name = String(c.name || '').trim();
    const country = String(c.country || '').trim();
    if (name.length < 2 || !isKnownCountry(country)) {
      fail('MO-CRY-001', `competitors.${i}`, 'Competitor needs a name and a country');
      return;
    }
    const providedKey = c.org_key?.trim();
    const description = String(c.description || '').trim();
    const keptKey = claimProvidedKey(
      providedKey,
      /^org_antagonist_[a-z0-9_]+$/,
      takenKeys,
      honourable,
    );
    competitors.push({
      org_key: keptKey ?? makeAntagonistOrgKey(name, i, takenKeys),
      name,
      country,
      facebook_handle: c.facebook_handle?.trim() || undefined,
      x_handle: c.x_handle?.trim() || undefined,
      description: description || undefined,
    });
  });

  const pressureOrgs = normalisePressureOrgs(
    pressureInput || [],
    orgs,
    takenKeys,
    seenNames,
    fail,
    honourable,
  );

  if (details.length > 0) {
    return { ok: false, code: details[0].code, message: details[0].message, details };
  }
  return { ok: true, orgs, competitors, pressureOrgs, multiOrg };
}

const PRESSURE_KIND_SET: readonly string[] = [
  'union',
  'regulator',
  'ngo',
  'community_group',
  'political',
];
const PRESSURE_REGISTER_SET: readonly string[] = [
  'statutory',
  'advocacy',
  'grassroots',
  'political',
];

/** Pressure org key: org_pressure_<slug>_<cc> (never collides with antagonist keys). */
export function makePressureOrgKey(name: string, country: string, taken: Set<string>): string {
  const slug = countrySlug(name).replace(/_+/g, '_') || 'pressure';
  const base = `org_pressure_${slug}_${countryCode(country)}`.slice(0, 60);
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) candidate = `${base}_${n++}`;
  taken.add(candidate);
  return candidate;
}

function normalisePressureOrgs(
  input: PressureOrgInput[],
  orgs: NormalisedOrg[],
  takenKeys: Set<string>,
  seenNames: Set<string>,
  fail: (code: string, path: string, message: string) => void,
  honourable: Set<string> | null = null,
): NormalisedPressureOrg[] {
  const out: NormalisedPressureOrg[] = [];
  const takenShort = new Set<string>();
  input.forEach((raw, i) => {
    const name = String(raw.display_name || '').trim();
    const path = `pressure_organisations.${name || i}`;
    if (name.length < 2 || name.length > 120) {
      fail('MO-PRS-001', path, 'Pressure organisation name must be 2-120 characters');
      return;
    }
    if (seenNames.has(name.toLowerCase())) {
      fail('MO-PRS-001', path, `Organisation names must be unique across every side: "${name}"`);
      return;
    }
    seenNames.add(name.toLowerCase());
    const country = String(raw.country || '').trim();
    if (!isKnownCountry(country)) {
      fail('MO-PRS-002', path, `Unknown country "${country}" for ${name}`);
      return;
    }
    const kind = String(raw.kind || '') as PressureKind;
    if (!PRESSURE_KIND_SET.includes(kind)) {
      fail('MO-PRS-002', path, `"${raw.kind}" is not a pressure organisation kind`);
      return;
    }
    const register = (
      PRESSURE_REGISTER_SET.includes(String(raw.register || ''))
        ? raw.register
        : defaultRegisterFor(kind)
    ) as PressureRegister;
    const protagonistKeys = new Set(orgs.map((o) => o.org_key));
    let targets = (raw.targets_org_keys || []).filter((k) => protagonistKeys.has(k));
    if (targets.length === 0) {
      const sameCountry = orgs.filter((o) => o.country === country).map((o) => o.org_key);
      targets = sameCountry.length > 0 ? sameCountry : orgs.map((o) => o.org_key);
    }
    if (targets.length === 0) {
      fail('MO-PRS-003', path, `${name} has no protagonist organisation to press`);
      return;
    }
    const keptKey = claimProvidedKey(
      raw.org_key?.trim(),
      /^org_pressure_[a-z0-9_]+$/,
      takenKeys,
      honourable,
    );
    out.push({
      org_key: keptKey ?? makePressureOrgKey(name, country, takenKeys),
      display_name: name,
      short_name: deriveShortName(name, takenShort, country),
      kind,
      country,
      city: raw.city?.trim() || undefined,
      register,
      wants: raw.wants?.trim() || undefined,
      facebook_handle: raw.facebook_handle?.trim() || undefined,
      x_handle: raw.x_handle?.trim() || undefined,
      spokesperson_stakeholder_id: raw.spokesperson_stakeholder_id?.trim() || undefined,
      targets_org_keys: targets,
    });
  });
  return out;
}

// ─── Registry ────────────────────────────────────────────────────────────────

export function buildOrgRegistry(
  orgs: NormalisedOrg[],
  competitors: NormalisedCompetitor[],
  autoRival?: { org_key: string; display_name: string; country: string } | null,
  pressureOrgs: NormalisedPressureOrg[] = [],
): OrgRegistryEntry[] {
  const entries: OrgRegistryEntry[] = orgs.map((o) => ({
    org_key: o.org_key,
    display_name: o.display_name,
    short_name: o.short_name,
    country: o.country,
    ...(o.city ? { city: o.city } : {}),
    kind: o.kind,
    side: 'protagonist' as const,
    ...(o.is_primary ? { is_primary: true } : {}),
    operation: o.operation,
    sites: [
      {
        site_key:
          `${o.org_key === 'primary' ? 'hq' : countrySlug(o.short_name || o.display_name)}_${countrySlug(o.city || o.country || o.display_name) || 'site'}`.slice(
            0,
            40,
          ),
        name: `${o.display_name} — ${o.city || o.country}`,
        country: o.country,
        ...(o.city ? { city: o.city } : {}),
      },
    ],
  }));
  for (const p of pressureOrgs) {
    entries.push({
      org_key: p.org_key,
      display_name: p.display_name,
      short_name: p.short_name,
      country: p.country,
      ...(p.city ? { city: p.city } : {}),
      kind: p.kind,
      side: 'pressure',
      ...(p.spokesperson_stakeholder_id
        ? { spokesperson_stakeholder_id: p.spokesperson_stakeholder_id }
        : {}),
    });
  }
  for (const c of competitors) {
    entries.push({
      org_key: c.org_key,
      display_name: c.name,
      country: c.country,
      kind: 'company',
      side: 'antagonist',
    });
  }
  if (autoRival) {
    entries.push({
      org_key: autoRival.org_key,
      display_name: autoRival.display_name,
      country: autoRival.country,
      kind: 'company',
      side: 'antagonist',
    });
  }
  return entries;
}

/** countries[] = {name, code} for every distinct country in the registry (no timezone/languages — no consumer). */
export function buildCountries(registry: OrgRegistryEntry[]): CountryEntry[] {
  const seen = new Map<string, CountryEntry>();
  for (const e of registry) {
    if (!e.country) continue;
    if (!seen.has(e.country)) {
      seen.set(e.country, { name: e.country, code: countryCode(e.country).toUpperCase() });
    }
  }
  return Array.from(seen.values());
}

/** org_key -> set of functions present, plus '*' for functions present anywhere. */
export function teamFunctionsByOrg(
  charters: Array<{ org_key: string | null; function_key: string }>,
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  map.set('*', new Set());
  for (const c of charters) {
    const key = c.org_key ?? 'primary';
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(c.function_key);
    map.get('*')!.add(c.function_key);
  }
  return map;
}

/** Composed team names for a function across all orgs (explicit target_teams for common stakeholders). */
export function teamNamesForFunction(
  charters: Array<{ team_name: string; function_key: string }>,
  functionKey: string,
): string[] {
  return charters.filter((c) => c.function_key === functionKey).map((c) => c.team_name);
}

export type { TeamExpectedAction };
