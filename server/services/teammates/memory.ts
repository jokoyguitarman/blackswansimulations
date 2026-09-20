import type { ActionKind } from './types.js';

/**
 * Per-bot memory and the per-team blackboard (docs/ai-teammate-bots-plan.md §9.3).
 *
 * Memory is in-process and rebuilt from the database on resume (perception.ts
 * seeds it from the bot's own posts, emails and actions). The blackboard is
 * shared by every bot on the same team in a session so they divide work instead
 * of dog-piling the same post, and so a human teammate's activity releases claims.
 */

export interface Commitment {
  text: string;
  /** epoch ms, null when no time could be parsed */
  dueAt: number | null;
  madeAt: number;
  met: boolean;
}

export interface RememberedGrade {
  overall: number;
  improvements: string[];
  at: number;
  kind: 'post' | 'statement' | 'draft';
}

export interface BotMemory {
  /** Target ids this bot has acted on (post / email / draft / thread / article). */
  handled: Set<string>;
  /** Official statements this bot published as the page, oldest first. */
  statements: Array<{ at: number; text: string }>;
  commitments: Commitment[];
  /** Email ids this bot has replied to, and email ids it has read. */
  repliedEmails: Set<string>;
  readEmails: Set<string>;
  /** DM thread ids this bot has answered. */
  repliedThreads: Set<string>;
  readNews: Set<string>;
  grades: RememberedGrade[];
  /** Post ids whose grade has already been folded into `grades`. */
  gradedPostIds: Set<string>;
  /** Chat message ids already considered, so a mention only wakes the bot once. */
  seenChat: Set<string>;
  /** Short natural-language log of recent actions, newest last (capped). */
  recentActions: string[];
  /** player_actions.action_type values this bot has produced (charter task completion). */
  doneActionTypes: Set<string>;
  lastStatementAt: number;
  lastPostAt: number;
  lastChatAt: number;
  /** Set once perception has seeded the memory from the database. */
  seeded: boolean;
}

export function createMemory(): BotMemory {
  return {
    handled: new Set(),
    statements: [],
    commitments: [],
    repliedEmails: new Set(),
    readEmails: new Set(),
    repliedThreads: new Set(),
    readNews: new Set(),
    grades: [],
    gradedPostIds: new Set(),
    seenChat: new Set(),
    recentActions: [],
    doneActionTypes: new Set(),
    lastStatementAt: 0,
    lastPostAt: 0,
    lastChatAt: 0,
    seeded: false,
  };
}

const MAX_RECENT = 20;
const MAX_GRADES = 6;

export function rememberAction(mem: BotMemory, kind: ActionKind, summary: string): void {
  mem.recentActions.push(`${kind}: ${summary}`.slice(0, 200));
  if (mem.recentActions.length > MAX_RECENT) mem.recentActions.shift();
}

export function rememberGrade(mem: BotMemory, grade: RememberedGrade): void {
  mem.grades.push(grade);
  if (mem.grades.length > MAX_GRADES) mem.grades.shift();
}

/**
 * Pull time-bound promises out of a public statement so a later statement can
 * honour them ("update within the hour", "next update at 3pm", "in 30 minutes").
 */
export function extractCommitments(text: string, now = Date.now()): Commitment[] {
  const out: Commitment[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    const lower = s.toLowerCase();
    if (!/(update|statement|brief|report back|confirm|publish|announce)/.test(lower)) continue;
    let dueAt: number | null = null;
    const min = lower.match(/within (\d{1,3}) ?min/);
    const hrs = lower.match(/within (?:the next )?(\d{1,2}) ?hour|within the hour|within an hour/);
    if (min) dueAt = now + Number(min[1]) * 60_000;
    else if (hrs) dueAt = now + (hrs[1] ? Number(hrs[1]) : 1) * 3_600_000;
    else if (/next update|further update|will update/.test(lower)) dueAt = null;
    else continue;
    out.push({ text: s.trim().slice(0, 240), dueAt, madeAt: now, met: false });
  }
  return out;
}

export function openCommitments(mem: BotMemory, now = Date.now()): Commitment[] {
  return mem.commitments.filter(
    (c) => !c.met && (c.dueAt === null || c.dueAt <= now + 15 * 60_000),
  );
}

/** A new official statement satisfies every open commitment about "an update". */
export function settleCommitments(mem: BotMemory): void {
  for (const c of mem.commitments) c.met = true;
}

// ---------------------------------------------------------------------------
// Team blackboard
// ---------------------------------------------------------------------------

export interface Claim {
  by: string;
  byName: string;
  kind: ActionKind;
  at: number;
}

export interface TeamBoard {
  teamName: string;
  claims: Map<string, Claim>;
  plan: string | null;
  planPostedAt: number;
  /** Who currently holds the org page on this team (user id), if known. */
  pageHolder: string | null;
}

export const CLAIM_TTL_MS = 5 * 60 * 1000;

export function createBoard(teamName: string): TeamBoard {
  return { teamName, claims: new Map(), plan: null, planPostedAt: 0, pageHolder: null };
}

export function pruneClaims(board: TeamBoard, now = Date.now()): void {
  for (const [id, c] of board.claims) if (now - c.at > CLAIM_TTL_MS) board.claims.delete(id);
}

/** True if someone else on the team already owns this target. */
export function isClaimedByOther(
  board: TeamBoard,
  targetId: string,
  me: string,
  now = Date.now(),
): boolean {
  pruneClaims(board, now);
  const c = board.claims.get(targetId);
  return !!c && c.by !== me;
}

export function claim(board: TeamBoard, targetId: string, c: Claim): void {
  board.claims.set(targetId, c);
}

export function release(board: TeamBoard, targetId: string): void {
  board.claims.delete(targetId);
}
