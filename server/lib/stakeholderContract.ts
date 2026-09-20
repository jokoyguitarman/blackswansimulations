/**
 * Stakeholder contacts — shared generation ↔ runtime contract.
 *
 * Source of truth: docs/stakeholder-contacts-contract.md (v3). The generator agent imports
 * this file to validate what it persists; the runtime imports it to read what was persisted.
 * Pure module: no DB access, no side effects.
 */
import { z } from 'zod';

// ─── Relationship / persuadability vocabularies (contract §3) ────────────────

export const STAKEHOLDER_RELATIONSHIPS = [
  'client',
  'supplier',
  'regulator',
  'partner',
  'internal',
  'media',
  'community',
  'investor',
  'union',
  'other',
] as const;
export type StakeholderRelationship = (typeof STAKEHOLDER_RELATIONSHIPS)[number];

export const PERSUADABILITIES = ['none', 'low', 'medium', 'high'] as const;
export type Persuadability = (typeof PERSUADABILITIES)[number];

export const VERDICTS = ['keep', 'modify', 'delay', 'cancel'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Contract §3.1 — outcomes the reconsideration judge may return per persuadability level. */
export const ALLOWED_VERDICTS: Record<Persuadability, ReadonlySet<Verdict>> = {
  none: new Set<Verdict>(['keep', 'modify']),
  low: new Set<Verdict>(['keep', 'modify', 'delay']),
  medium: new Set<Verdict>(['keep', 'modify', 'delay', 'cancel']),
  high: new Set<Verdict>(['keep', 'modify', 'delay', 'cancel']),
};

export const MAX_DELAY_MINUTES = 15;

/**
 * Number of resolution criteria that must be met before `cancel` is permitted.
 * medium → all; high → most (ceil(total / 2), minimum 1); none/low → never (Infinity).
 */
export function criteriaThreshold(p: Persuadability, total: number): number {
  if (p === 'medium') return total;
  if (p === 'high') return Math.max(1, Math.ceil(total / 2));
  return Number.POSITIVE_INFINITY;
}

// ─── Stakeholder record (contract §3) ────────────────────────────────────────

const LatentGrievanceSchema = z.object({
  grievance: z.string(),
  resolution_criteria: z.array(z.string()),
  persuadability: z.enum(PERSUADABILITIES),
  hard_constraints: z.array(z.string()).default([]),
  eruption_inject_keys: z.array(z.string()).default([]),
});
export type LatentGrievance = z.infer<typeof LatentGrievanceSchema>;

const HANDLE_RE = /^@[a-z0-9_]{3,30}$/;
const ID_RE = /^[a-z0-9_]+$/;

// ─── v3.2 vocabularies (additive) ────────────────────────────────────────────
export const STAKEHOLDER_KINDS = ['person', 'group'] as const;
export type StakeholderKind = (typeof STAKEHOLDER_KINDS)[number];
export const STAKEHOLDER_TIERS = ['principal', 'roster'] as const;
export type StakeholderTier = (typeof STAKEHOLDER_TIERS)[number];

/**
 * Non-strict on purpose: unknown keys the generator adds later are preserved, so additive
 * surface survives a round-trip through the runtime.
 */
export const StakeholderSchema = z
  .object({
    // identity (player-visible)
    id: z.string().regex(ID_RE, 'id must be a lowercase slug'),
    name: z.string().min(1),
    title: z.string().default(''),
    organisation: z.string().min(1),
    relationship: z.enum(STAKEHOLDER_RELATIONSHIPS),
    owning_team: z.string().min(1),
    org_key: z.string().min(1).nullable().default(null),
    // contact details (player-visible)
    email: z
      .string()
      .min(3)
      .refine((v) => v === v.toLowerCase(), 'email must be lowercase')
      .refine((v) => v.includes('@'), 'email must contain @'),
    phone: z.string().nullable().default(null),
    handle: z.string().regex(HANDLE_RE, 'handle must match /^@[a-z0-9_]{3,30}$/'),
    note: z.string().default(''),
    avatar_url: z.string().optional(),
    // character (hidden)
    personality: z.string().default(''),
    stance: z.string().default(''),
    knowledge: z.array(z.string()).default([]),
    will_not_disclose: z.array(z.string()).default([]),
    // reconsideration model (hidden)
    grievance: z.string().default(''),
    resolution_criteria: z.array(z.string()).default([]),
    persuadability: z.enum(PERSUADABILITIES).default('medium'),
    hard_constraints: z.array(z.string()).default([]),
    // RETIRED with the menu-based decision layer (2026-09-20). Still parsed so scenarios compiled
    // with it load; the generator strips it at compile time; the runtime ignores it.
    // See docs/executive-decisions-organic-handover.md.
    /** @deprecated */
    latent_grievances: z.record(z.string(), LatentGrievanceSchema).optional(),
    // ─── v3.2 additive (organic executive decisions §10.2 / pressure organisations) ───
    /** 'group' = distribution list; mail to it reaches `members`. Default 'person'. */
    kind: z.enum(STAKEHOLDER_KINDS).optional(),
    /** Stakeholder ids; required when kind === 'group'. */
    members: z.array(z.string()).optional(),
    /** 'roster' = lightweight workforce entry: sampled replies, no own injects. Default 'principal'. */
    tier: z.enum(STAKEHOLDER_TIERS).optional(),
    /** Grouping within an org (plant / depot / branch) used by propagation. */
    site_key: z.string().optional(),
    /** Plain-language: what kinds of executive decisions this person reacts to. */
    sensitivities: z.array(z.string()).optional(),
    /** Spokesperson of a pressure page (reverse link to orgs[].org_key). */
    page_org_key: z.string().optional(),
  })
  .passthrough()
  .superRefine((s, ctx) => {
    if (s.grievance === '' && s.resolution_criteria.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resolution_criteria'],
        message: 'resolution_criteria must be empty when grievance is empty',
      });
    }
    if (s.grievance !== '' && s.resolution_criteria.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resolution_criteria'],
        message: 'a stakeholder with a grievance needs at least one resolution criterion',
      });
    }
  });

export type Stakeholder = z.infer<typeof StakeholderSchema>;

/** Array form with cross-record uniqueness (id / email / handle). */
export const StakeholdersSchema = z.array(StakeholderSchema).superRefine((arr, ctx) => {
  const seen: Record<'id' | 'email' | 'handle', Map<string, number>> = {
    id: new Map(),
    email: new Map(),
    handle: new Map(),
  };
  arr.forEach((s, i) => {
    for (const field of ['id', 'email', 'handle'] as const) {
      const v = s[field].toLowerCase();
      const first = seen[field].get(v);
      if (first !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, field],
          message: `duplicate ${field} "${s[field]}" (first seen at index ${first})`,
        });
      } else {
        seen[field].set(v, i);
      }
    }
  });
});

// ─── Player-visible projection (contract §3 "HIDDEN") ────────────────────────

export const PLAYER_VISIBLE_FIELDS = [
  'id',
  'name',
  'title',
  'organisation',
  'relationship',
  'owning_team',
  'org_key',
  'email',
  'phone',
  'handle',
  'note',
  'avatar_url',
] as const;

export type PlayerVisibleStakeholder = Pick<Stakeholder, (typeof PLAYER_VISIBLE_FIELDS)[number]>;

/** Strip every hidden field. Never send a raw Stakeholder to a player client. */
export function toPlayerVisible(s: Stakeholder): PlayerVisibleStakeholder {
  const out: Partial<PlayerVisibleStakeholder> = {};
  for (const key of PLAYER_VISIBLE_FIELDS) {
    const v = s[key];
    if (v !== undefined) (out as Record<string, unknown>)[key] = v;
  }
  return out as PlayerVisibleStakeholder;
}

// ─── Organisation registry (contract §5.1) ───────────────────────────────────

/** v3.2: third side for unions, regulators, NGOs, community groups, political actors. */
export const ORG_SIDES = ['protagonist', 'antagonist', 'pressure'] as const;
export type OrgSide = (typeof ORG_SIDES)[number];
export const ORG_KINDS = [
  'company',
  'office',
  'agency',
  'ngo',
  'other',
  // pressure-side kinds (v3.2)
  'union',
  'regulator',
  'community_group',
  'political',
] as const;
export type OrgKind = (typeof ORG_KINDS)[number];
export const PRESSURE_KINDS = [
  'union',
  'regulator',
  'ngo',
  'community_group',
  'political',
] as const;
/** Voice of an AI-run page: pressure registers + `aligned` (AI-operated protagonist offices only). */
export const PAGE_REGISTERS = [
  'statutory',
  'advocacy',
  'grassroots',
  'political',
  'aligned',
] as const;
export type PageRegister = (typeof PAGE_REGISTERS)[number];

export const OrgRegistryEntrySchema = z
  .object({
    org_key: z.string().min(1),
    display_name: z.string().min(1),
    short_name: z.string().optional(),
    country: z.string().min(1).nullable().default(null),
    city: z.string().optional(),
    kind: z.enum(ORG_KINDS).optional(),
    side: z.enum(ORG_SIDES).default('protagonist'),
    is_primary: z.boolean().optional(),
    // ─── v3.2 additive ───
    /** Required when side === 'pressure': the contactable person who speaks for the page. */
    spokesperson_stakeholder_id: z.string().optional(),
    /** Protagonist orgs only: 'ai' = no human players; page + carriers are simulated. */
    operation: z.enum(['players', 'ai']).optional(),
    /** Sites within the org (plant / depot / branch) for cast completeness and propagation. */
    sites: z
      .array(
        z.object({
          site_key: z.string().min(1),
          name: z.string().min(1),
          country: z.string().min(1),
          city: z.string().optional(),
        }),
      )
      .optional(),
  })
  .passthrough();
export type OrgRegistryEntry = z.infer<typeof OrgRegistryEntrySchema>;

export const OrgRegistrySchema = z.array(OrgRegistryEntrySchema).superRefine((arr, ctx) => {
  const keys = new Map<string, number>();
  arr.forEach((o, i) => {
    const first = keys.get(o.org_key);
    if (first !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, 'org_key'],
        message: `duplicate org_key "${o.org_key}" (first seen at index ${first})`,
      });
    } else keys.set(o.org_key, i);
  });
  const primaries = arr.filter((o) => o.side === 'protagonist' && o.is_primary);
  if (primaries.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'exactly one protagonist may be is_primary',
    });
  }
});

export const CountryEntrySchema = z
  .object({
    name: z.string().min(1),
    code: z.string().length(2).optional(),
    timezone: z.string().optional(),
    languages: z.array(z.string()).optional(),
  })
  .passthrough();
export type CountryEntry = z.infer<typeof CountryEntrySchema>;
export const CountriesSchema = z.array(CountryEntrySchema);

// ─── Team identity (contract §5.2) ───────────────────────────────────────────

export interface TeamIdentity {
  team_name: string;
  /** Catalog name or stable slug; null for custom teams without one. */
  function_key: string | null;
  /** Organisation the team belongs to; null = single-org scenario / spans all orgs. */
  org_key: string | null;
  /** Derived from the registry via org_key; null when unknown. */
  country: string | null;
}

/** Contract §5.2 — the one rule for "what kind of team is this". */
export function resolveTeamFunction(team: {
  team_name: string;
  function_key?: string | null;
}): string {
  return team.function_key ?? team.team_name;
}

// ─── Visibility predicate (contract §6) ──────────────────────────────────────

export function isStakeholderVisibleToTeam(
  s: Pick<Stakeholder, 'owning_team' | 'org_key'>,
  team: { team_name: string; function_key: string | null; org_key: string | null },
): boolean {
  // 1. Function match: owning_team names a function; exact team_name also accepted so custom
  //    teams without a function_key, and v1-style data, keep working.
  const functionMatch =
    s.owning_team === resolveTeamFunction(team) || s.owning_team === team.team_name;
  if (!functionMatch) return false;
  // 2. Org match: null on either side means "all organisations".
  if (s.org_key === null || s.org_key === undefined || team.org_key === null) return true;
  return s.org_key === team.org_key;
}

// ─── Workbook sheets (contract §6) ───────────────────────────────────────────

export const RELATIONSHIP_SHEETS: ReadonlyArray<readonly [StakeholderRelationship, string]> = [
  ['client', 'Clients'],
  ['supplier', 'Suppliers'],
  ['partner', 'Partners'],
  ['regulator', 'Regulators'],
  ['internal', 'Internal'],
  ['media', 'Media'],
  ['community', 'Community'],
  ['investor', 'Investors'],
  ['union', 'Unions'],
  ['other', 'Other'],
];

export function sheetLabel(relationship: StakeholderRelationship): string {
  return RELATIONSHIP_SHEETS.find(([r]) => r === relationship)?.[1] ?? 'Other';
}

// The menu-based decision layer (contract §7A) was retired on 2026-09-20 and its schemas removed
// once the generator dropped its last importer. Executive decisions are now detected at runtime
// from what executives write — see docs/executive-decisions-organic-plan.md.

/**
 * Cross-inject condition primitives keyed on `delivery_config.inject_key`. These survived the
 * decision-layer removal because they are generic (any inject may depend on another having
 * fired or been cancelled). `decision_recorded:*` is NOT a primitive any more; the evaluator
 * treats it as an unknown key (always false).
 */
export const INJECT_KEY_CONDITION_PREFIXES = ['inject_published:', 'inject_cancelled:'] as const;

export function isInjectKeyCondition(key: string): boolean {
  return INJECT_KEY_CONDITION_PREFIXES.some((p) => key.startsWith(p));
}
