/**
 * Multi-recipient stakeholder mail — pure helpers (contract v3.2, handover §10.5 R1).
 *
 * A player email may address several stakeholders at once: principals, rank-and-file roster
 * members, and distribution lists (`kind: 'group'`) that stand for many people. Every recipient
 * must be recorded as contacted; only a bounded sample answers. No I/O here so it can be unit
 * tested; the lookups are injected.
 */
import type { Stakeholder } from './stakeholderContract.js';

/** Replies per player email across all stakeholder recipients (primary included). */
export const MAX_EMAIL_RESPONDERS = 3;
/** Of those, at most this many rank-and-file (`tier: 'roster'`) voices. */
export const MAX_ROSTER_RESPONDERS = 2;

export interface ResolvedRecipients {
  /** Mirrors the legacy `to_addresses[0]` semantics — may be a group, may be null. */
  primary: Stakeholder | null;
  /** Deduplicated respondent candidates: groups expanded to members, group records excluded. */
  all: Stakeholder[];
}

export async function resolveStakeholderRecipients(
  addresses: string[],
  findByEmail: (address: string) => Promise<Stakeholder | null>,
  findById: (id: string) => Promise<Stakeholder | null>,
): Promise<ResolvedRecipients> {
  const direct: Array<Stakeholder | null> = [];
  for (const raw of addresses) {
    const addr = String(raw ?? '')
      .trim()
      .toLowerCase();
    direct.push(addr ? await findByEmail(addr) : null);
  }
  const seen = new Set<string>();
  const all: Stakeholder[] = [];
  const push = (s: Stakeholder | null) => {
    if (!s || seen.has(s.id) || s.kind === 'group') return;
    seen.add(s.id);
    all.push(s);
  };
  for (const s of direct) {
    if (!s) continue;
    if (s.kind === 'group') {
      for (const memberId of s.members ?? []) push(await findById(memberId));
    } else {
      push(s);
    }
  }
  return { primary: direct[0] ?? null, all };
}

/** Small deterministic hash so the roster sample is stable per email (replays match). */
export function stableHash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Who answers: the primary (unless it is a group), then principals in recipient order, then a
 * stable sample of roster members — bounded so a notice to sixty employees costs three model
 * calls, not sixty.
 */
export function pickResponders(
  all: Stakeholder[],
  primary: Stakeholder | null,
  seed: string,
): Stakeholder[] {
  const out: Stakeholder[] = [];
  if (primary && primary.kind !== 'group') out.push(primary);
  const rest = all.filter((s) => s.id !== primary?.id);
  for (const s of rest) {
    if (out.length >= MAX_EMAIL_RESPONDERS) break;
    if (s.tier !== 'roster') out.push(s);
  }
  const rosterBudget = Math.min(MAX_ROSTER_RESPONDERS, MAX_EMAIL_RESPONDERS - out.length);
  if (rosterBudget > 0) {
    const roster = rest
      .filter((s) => s.tier === 'roster')
      .sort((a, b) => stableHash(seed + a.id) - stableHash(seed + b.id));
    out.push(...roster.slice(0, rosterBudget));
  }
  return out;
}
