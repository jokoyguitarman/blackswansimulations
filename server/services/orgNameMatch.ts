/**
 * Matching AI-generated organisation pages back to the organisations the trainer asked for.
 *
 * The page generator lists the requested allies and competitors in its prompt and the model
 * answers with one page per organisation — but it paraphrases names ("Dyson Malaysia (local
 * office / operations)" comes back as "Dyson Malaysia"). Identity must never depend on the model
 * echoing a string exactly: every page has to end up carrying the registry `org_key` of the
 * organisation it was generated for, or compile fails MO-ORG-005 after a seven-minute build.
 *
 * Pure functions, no IO. Used by the generator (assign keys as pages are produced) and by the
 * pipeline / compile (repair pages that still carry an unknown key).
 */

const GENERIC_TOKENS = new Set([
  'the',
  'of',
  'and',
  'for',
  'ltd',
  'limited',
  'inc',
  'co',
  'corp',
  'corporation',
  'company',
  'pte',
  'plc',
  'llc',
  'group',
  'holdings',
  'office',
  'local',
  'operations',
  'branch',
  'hq',
  'headquarters',
  'sdn',
  'bhd',
  'berhad',
]);

/** Lowercase, drop parenthesised asides and punctuation, collapse whitespace. */
export function simplifyOrgName(name: string): string {
  return String(name || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function significantTokens(simplified: string): string[] {
  return simplified.split(' ').filter((t) => t.length > 1 && !GENERIC_TOKENS.has(t));
}

/**
 * True when two organisation names plausibly denote the same organisation:
 * identical after simplification, one contains the other, or every significant token of the
 * shorter name appears in the longer one.
 */
export function orgNamesMatch(a: string, b: string): boolean {
  const sa = simplifyOrgName(a);
  const sb = simplifyOrgName(b);
  if (!sa || !sb) return false;
  if (sa === sb) return true;
  const [shorter, longer] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
  if (shorter.length >= 4 && longer.includes(shorter)) return true;
  const ta = significantTokens(shorter);
  const tb = new Set(significantTokens(longer));
  if (ta.length === 0) return false;
  return ta.every((t) => tb.has(t));
}

export interface RosterRef {
  name: string;
}

export interface GeneratedOrgLike {
  ref?: unknown;
  org_role?: unknown;
  display_name?: unknown;
}

export interface RosterMatch<T extends RosterRef> {
  /** Index into the raw generated list. */
  index: number;
  role: 'protagonist' | 'antagonist';
  /** The requested organisation this page stands for; null for an invented rival. */
  requested: T | null;
  /** How the match was made (for logs). */
  via: 'ref' | 'name' | 'position' | 'invented';
}

export interface RosterMatchResult<T extends RosterRef> {
  matches: RosterMatch<T>[];
  /** Raw indexes with no organisation to stand for (hallucinated protagonist pages, surplus rivals). */
  dropped: Array<{ index: number; reason: string }>;
  /** Requested organisations that got no page at all. */
  unmatched: Array<{ role: 'protagonist' | 'antagonist'; requested: T }>;
}

/**
 * Pair generated pages with the roster they were generated from.
 *
 * Order of evidence: the `ref` the prompt asked the model to echo (`A1`, `C2`, `NEW`), then a
 * name match, then position within the same role when counts line up. A protagonist page that
 * matches nothing is dropped — a player-side page without a registry entry is unusable. An
 * antagonist page that matches nothing is kept as an invented rival only when `allowInvented`.
 */
export function matchGeneratedOrgsToRoster<T extends RosterRef>(
  raw: GeneratedOrgLike[],
  allies: T[],
  competitors: T[],
  allowInvented: boolean,
): RosterMatchResult<T> {
  const matches: RosterMatch<T>[] = [];
  const dropped: RosterMatchResult<T>['dropped'] = [];
  const usedAlly = new Set<number>();
  const usedComp = new Set<number>();
  const decided = new Set<number>();

  const claim = (
    index: number,
    role: 'protagonist' | 'antagonist',
    pool: T[],
    used: Set<number>,
    at: number,
    via: RosterMatch<T>['via'],
  ) => {
    used.add(at);
    decided.add(index);
    matches.push({ index, role, requested: pool[at], via });
  };

  const parseRef = (
    ref: unknown,
  ): { role: 'protagonist' | 'antagonist'; at: number } | 'new' | null => {
    const s = String(ref ?? '')
      .trim()
      .toUpperCase();
    if (s === 'NEW') return 'new';
    const m = /^([AC])\s*-?\s*(\d{1,2})$/.exec(s);
    if (!m) return null;
    const at = Number(m[2]) - 1;
    return m[1] === 'A' ? { role: 'protagonist', at } : { role: 'antagonist', at };
  };

  // Pass 1 — refs.
  raw.forEach((o, index) => {
    const ref = parseRef(o.ref);
    if (!ref || ref === 'new') return;
    const pool = ref.role === 'protagonist' ? allies : competitors;
    const used = ref.role === 'protagonist' ? usedAlly : usedComp;
    if (ref.at >= 0 && ref.at < pool.length && !used.has(ref.at)) {
      claim(index, ref.role, pool, used, ref.at, 'ref');
    }
  });

  // Pass 2 — names, same role first, then the other role (the model sometimes flips roles).
  const roleOf = (o: GeneratedOrgLike): 'protagonist' | 'antagonist' =>
    o.org_role === 'antagonist' ? 'antagonist' : 'protagonist';
  const byName = (index: number, pool: T[], used: Set<number>): number => {
    const name = String(raw[index].display_name || '');
    for (let at = 0; at < pool.length; at++) {
      if (!used.has(at) && orgNamesMatch(name, pool[at].name)) return at;
    }
    return -1;
  };
  raw.forEach((o, index) => {
    if (decided.has(index)) return;
    const first = roleOf(o);
    const order: Array<'protagonist' | 'antagonist'> =
      first === 'protagonist' ? ['protagonist', 'antagonist'] : ['antagonist', 'protagonist'];
    for (const role of order) {
      const pool = role === 'protagonist' ? allies : competitors;
      const used = role === 'protagonist' ? usedAlly : usedComp;
      const at = byName(index, pool, used);
      if (at >= 0) {
        claim(index, role, pool, used, at, 'name');
        return;
      }
    }
  });

  // Pass 3 — position: leftover pages of a role paired in order with leftover requests of that role.
  for (const role of ['protagonist', 'antagonist'] as const) {
    const pool = role === 'protagonist' ? allies : competitors;
    const used = role === 'protagonist' ? usedAlly : usedComp;
    const leftoverRaw = raw
      .map((o, index) => ({ o, index }))
      .filter(
        ({ o, index }) => !decided.has(index) && roleOf(o) === role && parseRef(o.ref) !== 'new',
      );
    const leftoverReq = pool.map((_, at) => at).filter((at) => !used.has(at));
    const n = Math.min(leftoverRaw.length, leftoverReq.length);
    for (let i = 0; i < n; i++) {
      claim(leftoverRaw[i].index, role, pool, used, leftoverReq[i], 'position');
    }
  }

  // Pass 4 — what is left: invented rivals (kept when allowed) and hallucinated pages (dropped).
  raw.forEach((o, index) => {
    if (decided.has(index)) return;
    const role = roleOf(o);
    if (role === 'antagonist' && allowInvented) {
      decided.add(index);
      matches.push({ index, role, requested: null, via: 'invented' });
      return;
    }
    dropped.push({
      index,
      reason:
        role === 'protagonist'
          ? `protagonist page "${String(o.display_name || '')}" matches no requested organisation`
          : `rival page "${String(o.display_name || '')}" matches no named competitor and inventing is off`,
    });
  });

  const unmatched: RosterMatchResult<T>['unmatched'] = [];
  allies.forEach((a, at) => {
    if (!usedAlly.has(at)) unmatched.push({ role: 'protagonist', requested: a });
  });
  competitors.forEach((c, at) => {
    if (!usedComp.has(at)) unmatched.push({ role: 'antagonist', requested: c });
  });

  matches.sort((x, y) => x.index - y.index);
  return { matches, dropped, unmatched };
}

// ─── Repairing pages that already carry an unknown key ──────────────────────

export interface PageLike {
  org_key: string;
  display_name: string;
  role: 'protagonist' | 'antagonist' | 'pressure' | string;
  is_primary?: boolean;
  auto_generated?: boolean;
  country?: string;
}

export interface RegistryOrgLike {
  org_key: string;
  display_name: string;
  short_name?: string;
  country: string;
}

export interface CompetitorLike {
  org_key: string;
  name: string;
  country?: string;
}

export interface PageKeyRepair {
  /** Pages to keep, with keys rewritten where a match was found. Same order as the input. */
  pages: PageLike[];
  fixes: Array<{ from: string; to: string; display_name: string; via: 'name' | 'only_candidate' }>;
  dropped: Array<{ org_key: string; display_name: string; reason: string }>;
}

/**
 * Make every non-primary protagonist / antagonist page point at a registry key.
 *
 * Pages whose key the registry knows are untouched (pressure pages and the primary included).
 * A protagonist page with an unknown key is matched to an unclaimed registry organisation by
 * name, or — when exactly one unclaimed candidate is left — by elimination. Antagonist pages are
 * matched the same way against the named competitors; an unmatched antagonist page is kept as an
 * auto-generated rival only when it already says so. Anything still unresolved is dropped, because
 * the payload would fail MO-ORG-005 otherwise. Pure; callers log the fixes/drops.
 */
export function repairOrgPageKeys<P extends PageLike>(
  pages: P[],
  registryOrgs: RegistryOrgLike[],
  competitors: CompetitorLike[],
): PageKeyRepair & { pages: P[] } {
  const known = new Set<string>([
    ...registryOrgs.map((o) => o.org_key),
    ...competitors.map((c) => c.org_key),
  ]);
  const claimed = new Set<string>(pages.map((p) => p.org_key).filter((k) => known.has(k)));
  const fixes: PageKeyRepair['fixes'] = [];
  const dropped: PageKeyRepair['dropped'] = [];
  const out: P[] = [];

  for (const page of pages) {
    if (page.is_primary || page.role === 'pressure' || known.has(page.org_key)) {
      out.push(page);
      continue;
    }
    if (page.role === 'antagonist' && page.auto_generated) {
      // Invented rival: its key is minted by the generator and enters the registry via autoRival.
      out.push(page);
      continue;
    }

    const candidates: Array<{ org_key: string; names: string[]; country?: string }> =
      page.role === 'antagonist'
        ? competitors
            .filter((c) => !claimed.has(c.org_key))
            .map((c) => ({ org_key: c.org_key, names: [c.name], country: c.country }))
        : registryOrgs
            .filter((o) => !claimed.has(o.org_key) && o.org_key !== 'primary')
            .map((o) => ({
              org_key: o.org_key,
              names: [o.display_name, ...(o.short_name ? [o.short_name] : [])],
              country: o.country,
            }));

    let hit = candidates.find((c) => c.names.some((n) => orgNamesMatch(page.display_name, n)));
    let via: 'name' | 'only_candidate' = 'name';
    if (!hit && candidates.length === 1) {
      hit = candidates[0];
      via = 'only_candidate';
    }
    if (!hit) {
      dropped.push({
        org_key: page.org_key,
        display_name: page.display_name,
        reason: `no registry organisation matches this ${page.role} page`,
      });
      continue;
    }
    claimed.add(hit.org_key);
    fixes.push({ from: page.org_key, to: hit.org_key, display_name: page.display_name, via });
    out.push({
      ...page,
      org_key: hit.org_key,
      ...(hit.country && !page.country ? { country: hit.country } : {}),
    });
  }

  return { pages: out, fixes, dropped };
}
