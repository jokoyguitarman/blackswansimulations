/**
 * Organic executive decisions — shared types (docs/executive-decisions-organic-plan.md §3, §6).
 */
import type { Stakeholder } from '../../lib/stakeholderContract.js';

export const DECISION_CATEGORIES = [
  'workforce', // layoffs, closures, suspensions, shift changes
  'operations', // recall, halt production, resume, site closure/reopening
  'public_position', // official line, apology, denial, disclosure
  'legal_action', // litigation, filings, regulator submissions
  'commercial', // pricing, contracts, supplier changes
  'governance', // leadership changes, investigations, board matters
  'other',
] as const;
export type DecisionCategory = (typeof DECISION_CATEGORIES)[number];

export const FINALITIES = ['final', 'conditional', 'exploratory'] as const;
export type Finality = (typeof FINALITIES)[number];

export type ActorKind = 'stakeholder' | 'group' | 'page' | 'crowd' | 'team' | 'player';

export interface ActorRef {
  actor_kind: ActorKind;
  actor_id: string;
}

export interface DecisionSource {
  ref_table: 'sim_emails' | 'chat_messages' | 'player_drafts' | 'manual';
  ref_id: string | null;
  excerpt: string;
}

/** What the detector returns (validated) for one executive message. */
export interface DetectedDecision {
  is_decision: boolean;
  confidence: number;
  finality: Finality;
  summary: string;
  category: DecisionCategory;
  scope: {
    org_key: string | null;
    country: string | null;
    site_key: string | null;
    subject: string;
  };
  affected_stakeholder_ids: string[];
  should_know_functions: string[];
  should_know_stakeholder_ids: string[];
  reverses: string | null;
}

export const KNOWLEDGE_STATES = ['unaware', 'rumour', 'informed', 'officially_notified'] as const;
export type KnowledgeState = (typeof KNOWLEDGE_STATES)[number];
export type LearnedVia =
  | 'direct_message'
  | 'internal_relay'
  | 'grievance_relay'
  | 'public_exposure'
  | 'formal_notice';

export interface KnowledgeEntry extends ActorRef {
  state: KnowledgeState;
  learned_from: string | null;
  learned_via: LearnedVia | null;
  at_minute: number;
  ref_table?: string | null;
  ref_id?: string | null;
}

export type PlanNodeKind = 'reaction' | 'relay' | 'public';
export type PlanChannel = 'email' | 'chat_dm' | 'social_post' | 'news' | 'page_statement' | 'phone';

export interface GrievanceOverride {
  grievance: string;
  resolution_criteria: string[];
  persuadability: 'none' | 'low' | 'medium' | 'high';
  hard_constraints: string[];
}

export interface PlanNode {
  id: string;
  kind: PlanNodeKind;
  actor_kind: 'stakeholder' | 'group' | 'page' | 'crowd';
  actor_id: string;
  channel: PlanChannel;
  /** Minutes after detection at which this node fires (reaction/public) or the relay happens. */
  delay_minutes: number;
  parent_node_id: string | null;
  depth: number;
  content: { title: string; body: string };
  grievance_override?: GrievanceOverride;
  target_teams: string[];
  org_key: string | null;
  country: string | null;
  /** Filled once the node became a scenario_injects row / a delivered relay message. */
  inject_id?: string | null;
  inject_key?: string;
  fired_at_minute?: number | null;
  relayed?: boolean;
  /** For relay nodes: who learns (stakeholder ids / group ids). */
  learners?: string[];
}

export interface DecisionPlan {
  version: number;
  planned_at_minute: number;
  nodes: PlanNode[];
}

export interface NoticeAssessment {
  at_minute: number;
  order_ok: boolean;
  before_leak: boolean;
  tone_grade: number | null;
  coverage: number;
  by_user_id: string;
  step_ids: string[];
}

export interface DecisionDetail {
  summary: string;
  category: DecisionCategory;
  confidence: number;
  finality: Finality;
  scope: DetectedDecision['scope'];
  affected_stakeholder_ids: string[];
  should_know_functions: string[];
  should_know_stakeholder_ids: string[];
  informed: Array<ActorRef & { via: LearnedVia }>;
  sources: DecisionSource[];
  reverses_decision_id: string | null;
  detected_at_minute: number;
  author_user_id: string | null;
  author_team: string | null;
  author_function: string | null;
  plan?: DecisionPlan;
  notice?: NoticeAssessment;
  /** In-memory fallback (pre-205) for knowledge when the table is missing. */
  knowledge_fallback?: KnowledgeEntry[];
}

export interface DecisionRecord {
  id: string;
  session_id: string;
  org_key: string | null;
  decision_key: string;
  title: string;
  recorded_by: string | null;
  team_name: string | null;
  recorded_at_minute: number;
  recorded_by_trainer: boolean;
  status: 'active' | 'dismissed' | 'reversed';
  detail: DecisionDetail;
  recorded_at: string;
}

/** Compact cast entry handed to the LLM (never hidden fields beyond sensitivities). */
export interface CastEntry {
  id: string;
  name: string;
  title: string;
  organisation: string;
  relationship: Stakeholder['relationship'];
  org_key: string | null;
  owning_team: string;
  kind: 'person' | 'group';
  tier: 'principal' | 'roster';
  site_key: string | null;
  sensitivities: string[];
  members?: string[];
  page_org_key?: string | null;
}

export function toCastEntry(s: Stakeholder): CastEntry {
  return {
    id: s.id,
    name: s.name,
    title: s.title,
    organisation: s.organisation,
    relationship: s.relationship,
    org_key: s.org_key,
    owning_team: s.owning_team,
    kind: s.kind === 'group' ? 'group' : 'person',
    tier: s.tier === 'roster' ? 'roster' : 'principal',
    site_key: s.site_key ?? null,
    sensitivities: s.sensitivities ?? [],
    ...(s.members ? { members: s.members } : {}),
    page_org_key: s.page_org_key ?? null,
  };
}
