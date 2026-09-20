import { z } from 'zod';

/**
 * TEMPORARY generator-side mirror of docs/stakeholder-contacts-contract.md (v3)
 * §3 (Stakeholder), §5.1 (org registry), §5.2 (resolveTeamFunction), §6
 * (visibility predicate) and §7A (decision layer, reserved surface).
 *
 * The runtime agent owns the canonical `server/lib/stakeholderContract.ts`
 * (their first commit). When it lands, every import of this file switches to
 * that one and this file is deleted. Shapes here MUST stay verbatim with the
 * contract; do not add generator-private fields.
 */

// ─── §3 Stakeholder ──────────────────────────────────────────────────────────

export const RELATIONSHIPS = [
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
export type StakeholderRelationship = (typeof RELATIONSHIPS)[number];

export const PERSUADABILITY = ['none', 'low', 'medium', 'high'] as const;
export type Persuadability = (typeof PERSUADABILITY)[number];

/** §7A — latent grievance keyed by decision_key; dormant until decision_recorded:<key>. */
export interface LatentGrievance {
  grievance: string;
  resolution_criteria: string[];
  persuadability: Persuadability;
  hard_constraints: string[];
  eruption_inject_keys: string[];
}

export interface Stakeholder {
  // Identity (player-visible)
  id: string;
  name: string;
  title: string;
  organisation: string;
  relationship: StakeholderRelationship;
  /** Team FUNCTION ("Communications", "Legal", custom slug) — never a composed per-org name. */
  owning_team: string;
  /** initial_state.orgs[].org_key of a protagonist org; null = common (visible to the owning function in every org). */
  org_key: string | null;
  // Contact details (player-visible)
  email: string;
  phone: string | null;
  handle: string;
  note: string;
  avatar_url?: string;
  // Character (HIDDEN)
  personality: string;
  stance: string;
  knowledge: string[];
  will_not_disclose: string[];
  // Reconsideration model (HIDDEN)
  grievance: string;
  resolution_criteria: string[];
  persuadability: Persuadability;
  hard_constraints: string[];
  // §7A (reserved)
  latent_grievances?: Record<string, LatentGrievance>;
}

export const HANDLE_REGEX = /^@[a-z0-9_]{3,30}$/;
export const STAKEHOLDER_ID_REGEX = /^stk_[a-z0-9_]{3,60}$/;

export const LatentGrievanceSchema = z.object({
  grievance: z.string().min(1),
  resolution_criteria: z.array(z.string().min(1)).min(1).max(4),
  persuadability: z.enum(PERSUADABILITY),
  hard_constraints: z.array(z.string()),
  eruption_inject_keys: z.array(z.string().min(1)).min(1),
});

export const StakeholderSchema = z
  .object({
    id: z.string().regex(STAKEHOLDER_ID_REGEX),
    name: z.string().min(2).max(80),
    title: z.string().min(2).max(80),
    organisation: z.string().min(2).max(120),
    relationship: z.enum(RELATIONSHIPS),
    owning_team: z.string().min(1).max(60),
    org_key: z.string().min(1).nullable(),
    email: z
      .string()
      .min(5)
      .max(120)
      .refine((v) => v === v.toLowerCase(), 'email must be lowercase'),
    phone: z.string().max(40).nullable(),
    handle: z.string().regex(HANDLE_REGEX),
    note: z.string().max(400),
    avatar_url: z.string().url().optional(),
    personality: z.string().min(1),
    stance: z.string().min(1),
    knowledge: z.array(z.string()),
    will_not_disclose: z.array(z.string()),
    grievance: z.string(),
    resolution_criteria: z.array(z.string().min(1)).max(4),
    persuadability: z.enum(PERSUADABILITY),
    hard_constraints: z.array(z.string()),
    latent_grievances: z.record(z.string(), LatentGrievanceSchema).optional(),
  })
  .refine(
    (s) =>
      s.grievance.trim() === ''
        ? s.resolution_criteria.length === 0
        : s.resolution_criteria.length >= 1,
    'grievance and resolution_criteria must agree (empty grievance => no criteria; non-empty => 1-4)',
  );

// ─── §5.1 Organisation registry ──────────────────────────────────────────────

export const ORG_KINDS = ['company', 'office', 'agency', 'ngo', 'other'] as const;
export type OrgKind = (typeof ORG_KINDS)[number];
export type OrgSide = 'protagonist' | 'antagonist';

export interface OrgRegistryEntry {
  org_key: string;
  display_name: string;
  short_name?: string;
  country: string;
  city?: string;
  kind?: OrgKind;
  side: OrgSide;
  is_primary?: boolean;
}

export interface CountryEntry {
  name: string;
  code?: string;
  timezone?: string;
  languages?: string[];
}

export const ORG_KEY_REGEX = /^[a-z0-9_]{3,64}$/;

export const OrgRegistryEntrySchema = z.object({
  org_key: z.string().regex(ORG_KEY_REGEX),
  display_name: z.string().min(2).max(120),
  short_name: z.string().min(1).max(20).optional(),
  country: z.string().min(2).max(80),
  city: z.string().max(80).optional(),
  kind: z.enum(ORG_KINDS).optional(),
  side: z.enum(['protagonist', 'antagonist']),
  is_primary: z.boolean().optional(),
});

export const CountryEntrySchema = z.object({
  name: z.string().min(2).max(80),
  code: z.string().length(2).optional(),
  timezone: z.string().optional(),
  languages: z.array(z.string()).optional(),
});

// ─── §5.2 Team identity ──────────────────────────────────────────────────────

export interface TeamIdentity {
  team_name: string;
  function_key: string | null;
  org_key: string | null;
}

/** Contract §5.2 — the one rule for resolving what kind of team a row is. */
export function resolveTeamFunction(team: {
  team_name: string;
  function_key: string | null;
}): string {
  return team.function_key ?? team.team_name;
}

// ─── §6 Visibility predicate (used generator-side only by authoring endpoints) ─

export function isStakeholderVisibleToTeam(
  s: Pick<Stakeholder, 'owning_team' | 'org_key'>,
  team: TeamIdentity,
): boolean {
  const functionMatch =
    s.owning_team === resolveTeamFunction(team) || s.owning_team === team.team_name;
  if (!functionMatch) return false;
  if (s.org_key === null || team.org_key === null) return true;
  return s.org_key === team.org_key;
}

// ─── §7A Decision layer (reserved surface) ───────────────────────────────────

export interface SopObligation {
  obligation_key: string;
  description: string;
  owed_to_stakeholder_ids: string[];
  owed_by_function: string;
  /** Alias of owed_by_function — the runtime contract module's field name. */
  by_function: string;
  window_minutes: number;
  detection: 'stakeholder_contacted' | 'statement_published' | 'internal_directive_sent';
}

export interface ExecutiveDecision {
  decision_key: string;
  label: string;
  /** Alias of label — the runtime contract module's field name. */
  title: string;
  description: string;
  decidable_by_org_keys: string[];
  affected_org_keys: string[];
  severity: 'low' | 'medium' | 'high';
  sop_obligations: SopObligation[];
  eruption_inject_keys: string[];
  spillover_inject_keys: string[];
  public_statement_expected: boolean;
}

/** `to` holds function names and/or stakeholder ids (ids start with "stk_"). */
export interface ChainOfCommandEdge {
  org_key: string;
  from_function: string;
  to: string[];
}

export const DECISION_KEY_REGEX = /^[a-z0-9_]{3,60}$/;

export const ExecutiveDecisionSchema = z.object({
  decision_key: z.string().regex(DECISION_KEY_REGEX),
  label: z.string().min(2).max(120),
  title: z.string().min(1),
  description: z.string().min(2).max(600),
  decidable_by_org_keys: z.array(z.string()).min(1),
  affected_org_keys: z.array(z.string()).min(1),
  severity: z.enum(['low', 'medium', 'high']),
  sop_obligations: z.array(
    z.object({
      obligation_key: z.string().min(2).max(60),
      description: z.string().min(2).max(300),
      owed_to_stakeholder_ids: z.array(z.string()),
      owed_by_function: z.string().min(1),
      by_function: z.string().min(1),
      window_minutes: z.number().int().min(5).max(120),
      detection: z.enum([
        'stakeholder_contacted',
        'statement_published',
        'internal_directive_sent',
      ]),
    }),
  ),
  eruption_inject_keys: z.array(z.string()),
  spillover_inject_keys: z.array(z.string()),
  public_statement_expected: z.boolean(),
});

/** Player-facing strip (contract §6): hidden fields never leave the server to players. */
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
