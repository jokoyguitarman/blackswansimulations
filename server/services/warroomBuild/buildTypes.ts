import { z } from 'zod';
import type {
  FactSheet,
  NPCPersona,
  ObjectiveDef,
  SocialInject,
  SOPStep,
} from '../socialCrisisGeneratorService.js';
import type { CountryEntry, OrgRegistryEntry, Stakeholder } from '../../lib/stakeholderContract.js';
import type { DecisionContext } from '../multiOrgPipeline.js';
import type { PeaceFeed } from '../generation/peaceFeedCore.js';
import {
  competitorsSchema,
  organisationsSchema,
  pressureOrganisationsSchema,
  type TeamCharterWire,
} from './wireSchemas.js';

/** Frozen once, at build start (durable scenario builds §3). */
export const buildRequestSchema = z.object({
  crisis_type: z.string().min(1), // wizard: crisisDescription
  context: z.string().default(''), // wizard: crisisDescription (as today)
  country: z.string().default('Singapore'),
  org_name: z.string().optional(),
  brand_logo_url: z.string().optional(),
  blueprint: z.unknown().optional(),
  organisations: organisationsSchema.min(1), // = organisationsPayload
  competitors: competitorsSchema.default([]), // = competitorsPayload
  pressure_organisations: pressureOrganisationsSchema.default([]), // = pressureOrganisationsPayload
  auto_antagonist: z.boolean().default(true),
  duration: z.number().default(60),
});
export type BuildRequest = z.infer<typeof buildRequestSchema>;

export const STAGES = ['characters', 'storyline', 'convergence', 'pages'] as const;
export type BuildStage = (typeof STAGES)[number];
/** Present on a run only when ENABLE_PEACE_FEED_BUILD_STAGE is on. */
export const PEACE_STAGE = 'peace' as const;
export type ExtendedStage = BuildStage | typeof PEACE_STAGE;
export type BuildStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';
export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'interrupted';
export type CancelReason = 'user' | 'replaced' | 'unwatched';
export type BuildErrorCode =
  'stage_failed' | 'interrupted_too_often' | 'invalid_request' | 'internal';
export type LogKind = 'progress' | 'stage' | 'warning' | 'error' | 'system';

export const STAGE_LABEL: Record<BuildStage, string> = {
  characters: 'Characters',
  storyline: 'Storyline',
  convergence: 'Convergence',
  pages: 'Organisation pages',
};

export interface StageState {
  status: StageStatus;
  attempts: number; // incremented each time the stage starts running
  started_at?: string; // ISO
  finished_at?: string;
  ms?: number;
  error?: string; // trainer-facing text (§6)
}
export type StageStates = Record<BuildStage, StageState> & { peace?: StageState };

/** A `warroom_builds` row. Timestamps are ISO strings, as PostgREST returns them. */
export interface BuildRow {
  id: string;
  draft_id: string;
  created_by: string;
  pool: string;
  status: BuildStatus;
  current_stage: ExtendedStage | null;
  stage_states: StageStates;
  request: BuildRequest;
  request_hash: string;
  idempotency_key: string;
  error: string | null;
  error_code: string | null;
  cancel_requested_at: string | null;
  cancel_reason: CancelReason | null;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  interruptions: number;
  last_seen_at: string;
  log_count: number;
  compile_status: 'running' | 'succeeded' | 'failed' | null;
  compile_heartbeat_at: string | null;
  credit_ledger_id: string | null;
  credit_invoice_id: string | null;
  scenario_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Poll payload (§5.2). `stages` drops timestamps the trainer does not need. */
export interface BuildView {
  id: string;
  draft_id: string;
  status: BuildStatus;
  current_stage: ExtendedStage | null;
  stages: Record<
    BuildStage,
    { status: StageStatus; attempts: number; ms?: number; error?: string }
  > & {
    peace?: { status: StageStatus; attempts: number; ms?: number; error?: string };
  };
  error: string | null;
  error_code: string | null;
  cancel_reason: CancelReason | null;
  interruptions: number;
  request_hash: string;
  resumable: boolean; // status ∈ {paused, failed, cancelled} and cancel_reason !== 'replaced'
  resume_from: ExtendedStage | null; // nextStage(stage_states) when resumable
  compile: { status: 'running' | 'succeeded' | 'failed' | null; scenario_id: string | null };
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

/** One log line as the poll returns it (`at` is the row's created_at). */
export interface LogLine {
  seq: number;
  stage: string | null;
  kind: LogKind;
  message: string;
  at: string;
}

/** Persisted stage outputs (§4.3). Field names are the ones written to `warroom_build_outputs`. */
export interface CharactersOutput {
  personas: NPCPersona[];
  fact_sheet: FactSheet;
  communities: string[];
  countries: CountryEntry[];
  per_country_counts?: Record<string, number>;
  footprint?: unknown;
}

export interface StorylineOutput {
  injects: SocialInject[];
  team_storylines: Record<string, SocialInject[]>;
  team_charters: TeamCharterWire[];
  stakeholders: Stakeholder[];
  stakeholder_injects: SocialInject[];
  persona_twins: NPCPersona[];
  orgs: OrgRegistryEntry[];
  countries?: CountryEntry[];
  sop_steps: SOPStep[];
  decision_context: DecisionContext;
  pressure_organisations: Array<{
    display_name: string;
    org_key: string;
    spokesperson_stakeholder_id?: string;
  }>;
}

export interface ConvergenceOutput {
  sharedInjects?: SocialInject[];
  shared_injects?: SocialInject[];
  convergenceGates?: SocialInject[];
  convergence_gates?: SocialInject[];
  narrative?: { title: string; description: string; briefing: string } | null;
  objectives?: ObjectiveDef[];
  dimensionLabels?: Record<string, string> | null;
  dimension_labels?: Record<string, string> | null;
  intel_injects?: Record<string, SocialInject[]>;
}

export interface PagesOutput {
  org_page?: Record<string, unknown> | null;
  orgs?: OrgRegistryEntry[];
  countries?: CountryEntry[];
  pressure_injects?: SocialInject[];
  persona_twins?: NPCPersona[];
  /** Set when the stage was skipped. Review ignores page fields. */
  skipped?: boolean;
}

/** Durable peace stage. A null feed is a warning, not a failed build. */
export interface PeaceOutput {
  peace_period?: PeaceFeed | null;
  warning?: string;
}

export interface StageOutputs {
  characters?: CharactersOutput;
  storyline?: StorylineOutput;
  convergence?: ConvergenceOutput;
  pages?: PagesOutput;
  peace?: PeaceOutput;
}

/**
 * The keys `buildDraftInput` writes for generated artefacts, so the client
 * applies a review with one function (§4.4 / §9.4).
 */
export interface ReviewPayload {
  personas: NPCPersona[];
  fact_sheet: FactSheet;
  communities: string[];
  per_country_counts?: Record<string, number>;
  storyline_injects: SocialInject[];
  team_storylines: Record<string, SocialInject[]>;
  team_charters: TeamCharterWire[];
  stakeholders: Stakeholder[];
  stakeholder_injects: SocialInject[];
  org_registry: OrgRegistryEntry[];
  sop_steps: SOPStep[];
  decision_context: DecisionContext;
  pressure_links: Array<{
    display_name: string;
    org_key: string;
    spokesperson_stakeholder_id?: string;
  }>;
  shared_injects: SocialInject[];
  convergence_gates: SocialInject[];
  narrative: { title: string; description: string; briefing: string } | null;
  objectives: ObjectiveDef[];
  dimension_labels: Record<string, string> | null;
  org_page: Record<string, unknown> | null;
  /** Set only when the peace stage stored a feed. Absent means today's review. */
  peace_period?: PeaceFeed;
}
