/**
 * Shared types for the AI teammate bot runtime (docs/ai-teammate-bots-plan.md).
 *
 * Bots are ordinary session participants that act through the public HTTP API
 * with their own JWTs. Nothing here is visible to the game routes.
 */

export type ActionKind =
  | 'statement' // official statement as the org page (page holder only)
  | 'post' // top-level post as self
  | 'reply' // reply to a post
  | 'flag' // flag a post as harmful / false
  | 'report' // report a post to the platform
  | 'like'
  | 'repost'
  | 'dispute' // fact-based takedown request
  | 'email_read'
  | 'email_reply'
  | 'email_forward' // relay intel to another team
  | 'dm_reply'
  | 'draft_create' // write a document in Docs (and submit it for review)
  | 'draft_review' // approve / request changes on a teammate's document
  | 'chat' // team channel message
  | 'fact_check'
  | 'escalate'
  | 'read_news'
  | 'idle';

export const ALL_ACTION_KINDS: readonly ActionKind[] = [
  'statement',
  'post',
  'reply',
  'flag',
  'report',
  'like',
  'repost',
  'dispute',
  'email_read',
  'email_reply',
  'email_forward',
  'dm_reply',
  'draft_create',
  'draft_review',
  'chat',
  'fact_check',
  'escalate',
  'read_news',
  'idle',
];

export interface BotAction {
  kind: ActionKind;
  /** Post / email / draft / article id, or DM recipient handle for dm_reply. */
  targetId?: string | null;
  /** Copy for anything that writes text. */
  text?: string | null;
  /** Email subject, or document title for draft_create. */
  subject?: string | null;
  /** Email recipients (email_reply / email_forward). */
  to?: string[] | null;
  verdict?: 'approve' | 'request_changes' | null;
  /** Why the bot chose this; logged, never shown in the UI. */
  reason?: string;
  /** Where the decision came from. */
  source: 'triage' | 'llm' | 'fallback' | 'event' | 'nudge';
}

export interface BotPersona {
  /** Stable 1-based slot in the pool. */
  slot: number;
  email: string;
  username: string;
  fullName: string;
  /** Personality / working style only. The team lane always comes from the charter. */
  persona: string;
  gender: 'male' | 'female';
  ageBracket: 'under_18' | '18_25' | '26_35' | '36_50' | '51_plus';
  religion: 'buddhism' | 'christianity' | 'hinduism' | 'islam' | 'sikhism' | 'taoism' | 'none';
  race: string;
}

export type BotStatus = 'idle' | 'acting' | 'paused' | 'stopped';

export interface BotStats {
  actions: number;
  failures: number;
  byKind: Partial<Record<ActionKind, number>>;
  llmCalls: number;
  llmFallbacks: number;
  lastAction: { kind: ActionKind; at: string; summary: string } | null;
  lastError: string | null;
}

export interface TeamCharterView {
  team_name: string;
  function_key: string | null;
  org_key: string | null;
  mission: string;
  responsibilities: string[];
  out_of_lane: string[];
  tasks: string[];
  /** Only populated when the bot "knows the rubric" (high intellect). */
  expected_actions: Array<{
    action_id: string;
    description: string;
    detection_action_type: string;
    timing_benchmark_minutes: number | null;
    weight: number;
    tier: number;
  }>;
  can_post_publicly: boolean;
  scoring_rubric: string;
}
