/**
 * Organic executive decisions — detection core (pure; docs/executive-decisions-organic-plan.md §6.1).
 * Eligibility, the cheap pre-filter, output normalisation, the act gate, the informed-set
 * resolution and slugging. No IO, so every rule here is unit-tested.
 */
import {
  DECISION_CATEGORIES,
  FINALITIES,
  type ActorRef,
  type DecisionCategory,
  type DetectedDecision,
  type LearnedVia,
} from './decisionTypes.js';

export const EXECUTIVE_FUNCTION = 'Executive';
export const MIN_CONFIDENCE = 0.7;
export const MIN_MESSAGE_CHARS = 40;

/** Functions other than Executive that may take a cascading decision, and in which categories. */
export const NON_EXECUTIVE_ALLOWANCES: Record<string, DecisionCategory[]> = {
  Legal: ['legal_action'],
  Communications: ['public_position'],
};

/** Pre-filter: decision verbs / commitments. Cheap gate before any model call. */
export const DECISION_VERB_RE =
  /\b(we are|we will|we have decided|i have decided|decided to|effective (immediately|today|tomorrow|from)|with effect from|suspend\w*|clos(e|ing|ure)|halt\w*|recall\w*|terminat\w*|approve\w*|announce\w*|resum\w*|lay(ing)? off|layoffs?|withdraw\w*|file (a|the)|sue\w*|litigat\w*|shut\w*|retrench\w*|redundan\w*|freeze|cancel\w*|discontinu\w*|go ahead|proceed with|sign off|greenlight|authoris\w*|authoriz\w*)\b/i;

export function passesPreFilter(text: string, threadHasCandidate = false): boolean {
  const t = (text || '').trim();
  if (t.length < MIN_MESSAGE_CHARS) return false;
  return threadHasCandidate || DECISION_VERB_RE.test(t);
}

/** Who may decide (v1 answer #1): Executive; Legal for legal_action; Communications for public_position. */
export function isEligibleAuthor(
  functionKey: string | null,
  category?: DecisionCategory | null,
): boolean {
  if (!functionKey) return false;
  if (functionKey === EXECUTIVE_FUNCTION) return true;
  const allowed = NON_EXECUTIVE_ALLOWANCES[functionKey];
  if (!allowed) return false;
  // Before detection we don't know the category yet: eligible to be *checked*.
  if (!category) return true;
  return allowed.includes(category);
}

/** Validate + coerce the model's JSON into a DetectedDecision (never throws). */
export function normaliseDetection(
  raw: unknown,
  knownStakeholderIds: Set<string>,
  knownFunctions: Set<string>,
): DetectedDecision {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const confidence = clamp01(Number(r.confidence));
  const finality = (FINALITIES as readonly string[]).includes(String(r.finality))
    ? (r.finality as DetectedDecision['finality'])
    : 'exploratory';
  const category = (DECISION_CATEGORIES as readonly string[]).includes(String(r.category))
    ? (r.category as DecisionCategory)
    : 'other';
  const scope = (r.scope && typeof r.scope === 'object' ? r.scope : {}) as Record<string, unknown>;
  const ids = (v: unknown) =>
    Array.isArray(v)
      ? Array.from(
          new Set((v as unknown[]).map(String).filter((id) => knownStakeholderIds.has(id))),
        )
      : [];
  const fns = (v: unknown) =>
    Array.isArray(v)
      ? Array.from(new Set((v as unknown[]).map(String).filter((f) => knownFunctions.has(f))))
      : [];
  return {
    is_decision: r.is_decision === true,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    finality,
    summary: String(r.summary || '')
      .trim()
      .slice(0, 300),
    category,
    scope: {
      org_key: scope.org_key ? String(scope.org_key) : null,
      country: scope.country ? String(scope.country) : null,
      site_key: scope.site_key ? String(scope.site_key) : null,
      subject: String(scope.subject || '').slice(0, 200),
    },
    affected_stakeholder_ids: ids(r.affected_stakeholder_ids),
    should_know_functions: fns(r.should_know_functions),
    should_know_stakeholder_ids: ids(r.should_know_stakeholder_ids),
    reverses: r.reverses && String(r.reverses) !== 'none' ? String(r.reverses) : null,
  };
}

/** The act gate (§6.1): only final decisions with enough confidence and a non-empty summary cascade. */
export function shouldAct(d: DetectedDecision, authorFunction: string | null): boolean {
  if (!d.is_decision || d.finality !== 'final' || d.confidence < MIN_CONFIDENCE) return false;
  if (d.summary.length < 8) return false;
  return isEligibleAuthor(authorFunction, d.category);
}

/** A stable per-org slug: "close_johor_depot_30_days" (unique against `taken`). */
export function slugForDecision(summary: string, taken: Set<string>): string {
  const base =
    summary
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter((w) => !STOPWORDS.has(w))
      .slice(0, 6)
      .join('_')
      .slice(0, 48) || 'decision';
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) candidate = `${base}_${n++}`;
  taken.add(candidate);
  return candidate;
}
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'to',
  'of',
  'and',
  'we',
  'will',
  'are',
  'have',
  'decided',
  'that',
  'for',
  'in',
  'on',
  'with',
  'be',
  'is',
]);

export interface InformedResolutionInput {
  /** Addresses on the message (to + cc), lowercase. */
  addresses: string[];
  /** Session players by sim address. */
  players: Array<{
    user_id: string;
    address: string;
    team_name: string | null;
    function_key: string | null;
  }>;
  /** Stakeholders by email (lowercase) → { id, kind, members }. */
  stakeholdersByEmail: Map<string, { id: string; kind: 'person' | 'group'; members: string[] }>;
  /** For chat: explicit member user ids (channel members) with their functions. */
  channelMembers?: Array<{
    user_id: string;
    team_name: string | null;
    function_key: string | null;
  }>;
  /** For npc_direct chat: the stakeholder. */
  directStakeholderId?: string | null;
  authorUserId: string;
  via: LearnedVia;
}

/** Who was told by this message (players → teams/functions; stakeholders; groups expand to members). */
export function resolveInformedSet(
  input: InformedResolutionInput,
): Array<ActorRef & { via: LearnedVia }> {
  const out: Array<ActorRef & { via: LearnedVia }> = [];
  const seen = new Set<string>();
  const push = (actor_kind: ActorRef['actor_kind'], actor_id: string) => {
    const key = `${actor_kind}:${actor_id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ actor_kind, actor_id, via: input.via });
  };
  const addresses = new Set(input.addresses.map((a) => a.trim().toLowerCase()).filter(Boolean));
  for (const p of input.players) {
    if (p.user_id === input.authorUserId) continue;
    if (addresses.has(p.address.toLowerCase())) {
      push('player', p.user_id);
      if (p.team_name) push('team', p.team_name);
    }
  }
  for (const addr of addresses) {
    const s = input.stakeholdersByEmail.get(addr);
    if (!s) continue;
    if (s.kind === 'group') {
      push('group', s.id);
      for (const m of s.members) push('stakeholder', m);
    } else {
      push('stakeholder', s.id);
    }
  }
  for (const m of input.channelMembers || []) {
    if (m.user_id === input.authorUserId) continue;
    push('player', m.user_id);
    if (m.team_name) push('team', m.team_name);
  }
  if (input.directStakeholderId) push('stakeholder', input.directStakeholderId);
  return out;
}

/** Functions "told" by a message = functions of informed teams (function_key ?? team_name). */
export function informedFunctions(
  informed: ActorRef[],
  teams: Array<{ team_name: string; function_key: string | null }>,
): Set<string> {
  const byName = new Map(teams.map((t) => [t.team_name, t.function_key ?? t.team_name]));
  const out = new Set<string>();
  for (const a of informed)
    if (a.actor_kind === 'team') out.add(byName.get(a.actor_id) ?? a.actor_id);
  return out;
}

/** Formal-notice heuristic (§6.6): HR-like author to a workforce carrier, referencing the decision. */
export function looksLikeFormalNotice(
  text: string,
  recipients: Array<{ relationship: string; kind: 'person' | 'group'; title: string }>,
  decisionSummary: string,
): boolean {
  if (recipients.length === 0) return false;
  const workforce = recipients.some(
    (r) =>
      r.kind === 'group' ||
      r.relationship === 'union' ||
      (r.relationship === 'internal' &&
        /\b(hr|human resources|steward|staff|manager|supervisor|representative)\b/i.test(r.title)),
  );
  if (!workforce) return false;
  const words = decisionSummary
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 4 && !STOPWORDS.has(w));
  const hits = words.filter((w) => text.toLowerCase().includes(w)).length;
  return hits >= Math.min(2, Math.max(1, Math.floor(words.length / 3)));
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}
