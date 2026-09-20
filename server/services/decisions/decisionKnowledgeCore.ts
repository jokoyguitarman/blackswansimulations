/**
 * Organic executive decisions — knowledge core (pure; docs/executive-decisions-organic-plan.md §6.3).
 * State ranks, monotonic transitions, group expansion, public exposure. No IO.
 */
import type { ActorRef, KnowledgeEntry, KnowledgeState, LearnedVia } from './decisionTypes.js';

const RANK: Record<KnowledgeState, number> = {
  unaware: 0,
  rumour: 1,
  informed: 2,
  officially_notified: 3,
};

export function rankOf(state: KnowledgeState): number {
  return RANK[state];
}

/** Knowledge only ever moves forward: a formal notice is never downgraded by a later rumour. */
export function transition(
  current: KnowledgeEntry | undefined,
  next: KnowledgeEntry,
): KnowledgeEntry | null {
  if (!current) return next;
  if (RANK[next.state] > RANK[current.state]) return next;
  return null;
}

export type KnowledgeMap = Map<string, KnowledgeEntry>;

export function actorKey(a: ActorRef): string {
  return `${a.actor_kind}:${a.actor_id}`;
}

/** Apply one learning event; returns the entries that actually changed. */
export function learn(
  map: KnowledgeMap,
  actors: ActorRef[],
  state: KnowledgeState,
  via: LearnedVia,
  learnedFrom: string | null,
  atMinute: number,
  ref?: { ref_table: string; ref_id: string | null },
): KnowledgeEntry[] {
  const changed: KnowledgeEntry[] = [];
  for (const a of actors) {
    const key = actorKey(a);
    const next: KnowledgeEntry = {
      ...a,
      state,
      learned_from: learnedFrom,
      learned_via: via,
      at_minute: atMinute,
      ref_table: ref?.ref_table ?? null,
      ref_id: ref?.ref_id ?? null,
    };
    const t = transition(map.get(key), next);
    if (t) {
      map.set(key, t);
      changed.push(t);
    }
  }
  return changed;
}

/** A group told = every member told at the same minute (R1 workaround: recipients, not the log). */
export function expandGroups(actors: ActorRef[], groups: Map<string, string[]>): ActorRef[] {
  const out: ActorRef[] = [];
  const seen = new Set<string>();
  const push = (a: ActorRef) => {
    const k = actorKey(a);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(a);
  };
  for (const a of actors) {
    push(a);
    if (a.actor_kind === 'group')
      for (const m of groups.get(a.actor_id) || [])
        push({ actor_kind: 'stakeholder', actor_id: m });
  }
  return out;
}

/** Public exposure: everyone in the country (or everyone, when unscoped) who is still below `informed`. */
export function publicExposure(
  map: KnowledgeMap,
  candidates: Array<ActorRef & { country: string | null }>,
  country: string | null,
  atMinute: number,
  ref?: { ref_table: string; ref_id: string | null },
): KnowledgeEntry[] {
  const affected = candidates.filter((c) => !country || !c.country || c.country === country);
  return learn(
    map,
    affected.map(({ actor_kind, actor_id }) => ({ actor_kind, actor_id })),
    'informed',
    'public_exposure',
    'public',
    atMinute,
    ref,
  );
}

/** Should-know gap: who should have been told but is still below `informed` at `now`. */
export function shouldKnowGap(map: KnowledgeMap, shouldKnow: ActorRef[]): ActorRef[] {
  return shouldKnow.filter((a) => rankOf(map.get(actorKey(a))?.state ?? 'unaware') < RANK.informed);
}

/** Internal relay probability per tick (leakiness 0..1, minutes since the source learned). */
export function relayProbability(leakiness: number, minutesSinceLearned: number): number {
  const l = Math.max(0, Math.min(1, leakiness));
  const t = Math.max(0, minutesSinceLearned);
  // Starts low, grows with time; leaky orgs saturate faster.
  return Math.min(0.95, l * 0.25 + (t / 60) * (0.2 + l * 0.5));
}
