/**
 * Inter-agency interdependency matrix for the social-crisis after-action report.
 *
 * The decision log is often empty: teams decide by sending mail, sharing intel,
 * escalating, posting a public line, or parking a draft in clearance. This builds
 * the grid the log does not. A cell exists only when one team addressed, named,
 * or owed intel to another. Naming your own agency fans out to the sibling teams.
 * An empty seat stays on the grid when someone relied on it.
 */
import { DECISION_VERB_RE } from './decisions/decisionDetectionCore.js';

export type ImpactKind =
  'told' | 'enabled' | 'late' | 'withheld' | 'handed_off' | 'held' | 'unanswered' | 'consequence';

export type ImpactSource =
  'decision_log' | 'email' | 'intel' | 'escalation' | 'public_post' | 'draft';

export interface MatrixTeam {
  name: string;
  /** Agency display name. Null for a single-organisation exercise. */
  org: string | null;
  staffed: boolean;
  /** Extra labels that mean this team (short codes the scenario uses). */
  aliases?: string[];
}

export interface MatrixEmail {
  at_minute: number | null;
  from_team: string;
  to_teams: string[];
  text: string;
}

export interface MatrixIntel {
  title: string;
  holder_team: string;
  needed_by: string[];
  shared: boolean;
  shared_at_minutes: number | null;
  shared_by_team: string | null;
  deadline_minutes: number | null;
  deadline_missed: boolean;
}

export interface MatrixDecision {
  at_minute: number | null;
  by_team: string | null;
  summary: string;
  informed: string[];
  reactions: Array<{
    actor: string;
    outcome: string;
    title: string;
    at_minute: number | null;
  }>;
}

export interface MatrixAction {
  at_minute: number | null;
  team: string;
  action_type: string;
  text: string;
  /** Team that owns the draft, when the actor is a reviewer on another team. */
  document_team?: string | null;
}

export interface MatrixPost {
  at_minute: number | null;
  team: string;
  text: string;
  overall: number | null;
}

export interface MatrixInput {
  teams: MatrixTeam[];
  emails: MatrixEmail[];
  intel: MatrixIntel[];
  decisions: MatrixDecision[];
  actions: MatrixAction[];
  posts: MatrixPost[];
}

export interface MatrixEffect {
  at_minute: number | null;
  kind: ImpactKind;
  source: ImpactSource;
  summary: string;
}

export interface MatrixImpact {
  team: string;
  kind: ImpactKind;
  summary: string;
  same_org: boolean;
}

export interface MatrixDecisionRow {
  at_minute: number | null;
  by: string;
  what: string;
  source: ImpactSource;
  impacts: MatrixImpact[];
}

export interface MatrixCell {
  from: string;
  to: string;
  same_org: boolean;
  email_count: number;
  headline: ImpactKind;
  effects: MatrixEffect[];
}

export interface AgencyCell {
  from: string;
  to: string;
  email_count: number;
  headline: ImpactKind;
  effects: number;
}

export interface InterdependencyMatrix {
  teams: MatrixTeam[];
  cells: MatrixCell[];
  /** Ministry / company roll-up. Empty when the exercise has one agency. */
  agencies: string[];
  agency_cells: AgencyCell[];
  decisions: MatrixDecisionRow[];
  coverage: {
    decision_log_count: number;
    emails_naming_another_team: number;
    email_edges: number;
    intel_shared: number;
    intel_withheld: number;
    escalations: number;
    public_lines: number;
    drafts_held: number;
    effects: number;
  };
  note: string;
}

const KIND_RANK: Record<ImpactKind, number> = {
  told: 1,
  enabled: 2,
  consequence: 3,
  handed_off: 4,
  held: 5,
  late: 6,
  unanswered: 7,
  withheld: 8,
};

const STOP_WORDS = new Set(['of', 'and', 'the', 'for', 'de', 'da', 'di', 'du']);
const MAX_EFFECTS = 8;
const MAX_EMAIL_DECISIONS = 12;
const MAX_PUBLIC_PER_TEAM = 4;
const MAX_DECISIONS = 40;
const AXIS_CAP = 16;

interface Alias {
  label: string;
  teams: string[];
  kind: 'team' | 'org';
  org: string | null;
  primary: boolean;
  retired: boolean;
}

interface CellAcc {
  from: string;
  to: string;
  email_count: number;
  first_email_minute: number | null;
  excerpt: string | null;
  effects: MatrixEffect[];
}

function trunc(value: string, max: number): string {
  const s = value.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordsOf(name: string): string[] {
  return name.split(/[^A-Za-z0-9]+/).filter(Boolean);
}

function leadingToken(name: string): string | null {
  const first = wordsOf(name)[0];
  if (!first || !/^[A-Z]{3,6}$/.test(first)) return null;
  if (first.toLowerCase() === name.trim().toLowerCase()) return null;
  return first;
}

function trailingSegment(name: string): string | null {
  const parts = name.split(/\s+[—–-]\s+/);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1].trim();
  if (last.length < 2 || last.length > 40) return null;
  return last;
}

function acronym(name: string): string | null {
  const words = wordsOf(name).filter((w) => !STOP_WORDS.has(w.toLowerCase()));
  if (words.length < 2) return null;
  const ac = words.map((w) => w[0].toUpperCase()).join('');
  if (ac.length < 3 || ac.length > 6) return null;
  return ac;
}

function compileAliases(teams: MatrixTeam[]): Alias[] {
  const aliases: Alias[] = [];
  const add = (
    label: string,
    teamNames: string[],
    kind: 'team' | 'org',
    org: string | null,
    primary: boolean,
  ) => {
    const clean = label.trim();
    if (clean.length < 2) return;
    const key = clean.toLowerCase();
    const existing = aliases.find((a) => a.label.toLowerCase() === key);
    if (!existing) {
      aliases.push({
        label: clean,
        teams: [...new Set(teamNames)],
        kind: teamNames.length > 1 ? 'org' : kind,
        org,
        primary,
        retired: false,
      });
      return;
    }
    if (existing.org && org && existing.org !== org) {
      if (existing.primary || primary) return;
      existing.retired = true;
      return;
    }
    for (const name of teamNames) {
      if (!existing.teams.includes(name)) existing.teams.push(name);
    }
    if (!existing.org) existing.org = org;
    if (existing.teams.length > 1) existing.kind = 'org';
  };

  for (const team of teams) {
    add(team.name, [team.name], 'team', team.org, true);
    for (const extra of team.aliases ?? []) add(extra, [team.name], 'team', team.org, false);
    const token = leadingToken(team.name);
    if (token) add(token, [team.name], 'team', team.org, false);
    const trailing = trailingSegment(team.name);
    if (trailing) add(trailing, [team.name], 'team', team.org, false);
  }

  const byOrg = new Map<string, string[]>();
  for (const team of teams) {
    if (!team.org) continue;
    const list = byOrg.get(team.org) ?? [];
    list.push(team.name);
    byOrg.set(team.org, list);
  }
  for (const [org, members] of byOrg) {
    add(org, members, 'org', org, false);
    const ac = acronym(org);
    if (ac) add(ac, members, 'org', org, false);
  }

  return aliases
    .filter((a) => !a.retired && a.teams.length > 0)
    .sort((a, b) => b.label.length - a.label.length || a.label.localeCompare(b.label));
}

function namedTeams(
  text: string,
  fromTeam: string,
  aliases: Alias[],
): Array<{ team: string; label: string }> {
  const found: Array<{ team: string; label: string }> = [];
  const seen = new Set<string>();
  let remaining = text;
  for (const alias of aliases) {
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(alias.label)}(?![A-Za-z0-9])`, 'i');
    if (!re.test(remaining)) continue;
    for (const team of alias.teams) {
      if (team === fromTeam || seen.has(team)) continue;
      seen.add(team);
      found.push({ team, label: alias.label });
    }
    remaining = remaining.replace(
      new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(alias.label)}(?![A-Za-z0-9])`, 'gi'),
      ' ',
    );
  }
  return found;
}

function presentKind(kind: ImpactKind, staffed: boolean): ImpactKind {
  if (!staffed && (kind === 'told' || kind === 'handed_off' || kind === 'enabled')) {
    return 'unanswered';
  }
  return kind;
}

function worse(current: ImpactKind, next: ImpactKind): ImpactKind {
  return KIND_RANK[next] >= KIND_RANK[current] ? next : current;
}

function canon(label: string | null | undefined, teams: MatrixTeam[]): string | null {
  if (!label) return null;
  const hit = teams.find((t) => t.name.toLowerCase() === label.trim().toLowerCase());
  return hit ? hit.name : null;
}

export function buildInterdependencyMatrix(input: MatrixInput): InterdependencyMatrix {
  const teams = [...input.teams].sort((a, b) => {
    if (a.staffed !== b.staffed) return a.staffed ? -1 : 1;
    const org = (a.org || '').localeCompare(b.org || '');
    if (org !== 0) return org;
    return a.name.localeCompare(b.name);
  });
  const byName = new Map(teams.map((t) => [t.name, t]));
  const aliases = compileAliases(teams);
  const cells = new Map<string, CellAcc>();
  const decisions: MatrixDecisionRow[] = [];

  const sameOrg = (a: string, b: string): boolean => {
    const left = byName.get(a);
    const right = byName.get(b);
    return !!left?.org && left.org === right?.org;
  };

  const touch = (from: string, to: string): CellAcc | null => {
    if (!byName.has(from) || !byName.has(to) || from === to) return null;
    const key = `${from}\0${to}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        from,
        to,
        email_count: 0,
        first_email_minute: null,
        excerpt: null,
        effects: [],
      };
      cells.set(key, cell);
    }
    return cell;
  };

  const addEffect = (from: string, to: string, effect: MatrixEffect) => {
    const cell = touch(from, to);
    if (!cell) return;
    const target = byName.get(to);
    const kind = presentKind(effect.kind, target?.staffed !== false);
    const stored = { ...effect, kind };
    const duplicate = cell.effects.some(
      (e) => e.kind === stored.kind && e.summary === stored.summary && e.source === stored.source,
    );
    if (!duplicate && cell.effects.length < MAX_EFFECTS) cell.effects.push(stored);
  };

  const impactFor = (from: string, to: string, kind: ImpactKind, summary: string): MatrixImpact => {
    const target = byName.get(to);
    return {
      team: to,
      kind: presentKind(kind, target?.staffed !== false),
      summary,
      same_org: sameOrg(from, to),
    };
  };

  let emailsNaming = 0;
  let emailDecisions = 0;
  for (const email of input.emails) {
    const from = canon(email.from_team, teams);
    if (!from) continue;
    const direct = email.to_teams
      .map((name) => canon(name, teams))
      .filter((name): name is string => !!name && name !== from);
    const named = namedTeams(email.text, from, aliases).map((hit) => hit.team);
    const targets = [...new Set([...direct, ...named])];
    if (targets.length === 0) continue;
    emailsNaming += 1;
    const decisionLike =
      email.text.trim().length >= 40 &&
      DECISION_VERB_RE.test(email.text) &&
      emailDecisions < MAX_EMAIL_DECISIONS;
    if (decisionLike) emailDecisions += 1;
    const impacts: MatrixImpact[] = [];
    for (const to of targets) {
      const cell = touch(from, to);
      if (!cell) continue;
      cell.email_count += 1;
      if (cell.first_email_minute == null) cell.first_email_minute = email.at_minute;
      if (!cell.excerpt) cell.excerpt = trunc(email.text, 160);
      const summary = 'Named or addressed in email';
      impacts.push(impactFor(from, to, 'told', summary));
    }
    if (decisionLike) {
      decisions.push({
        at_minute: email.at_minute,
        by: from,
        what: trunc(email.text, 180),
        source: 'email',
        impacts,
      });
    }
  }

  let intelShared = 0;
  let intelWithheld = 0;
  for (const item of input.intel) {
    const from = canon(
      item.shared ? item.shared_by_team || item.holder_team : item.holder_team,
      teams,
    );
    const holder = from ?? (item.holder_team || 'Unknown');
    const late =
      item.shared &&
      item.deadline_minutes != null &&
      item.shared_at_minutes != null &&
      item.shared_at_minutes > item.deadline_minutes;
    const kind: ImpactKind = !item.shared
      ? 'withheld'
      : late || item.deadline_missed
        ? 'late'
        : 'enabled';
    if (item.shared) intelShared += 1;
    else intelWithheld += 1;
    const when = item.shared ? item.shared_at_minutes : null;
    const what = item.shared ? `Intel shared: ${item.title}` : `Intel not shared: ${item.title}`;
    const impacts: MatrixImpact[] = [];
    for (const raw of item.needed_by) {
      const to = canon(raw, teams);
      if (!to || !from) continue;
      const summary = item.shared
        ? late
          ? `Shared after the deadline (T+${item.shared_at_minutes}, due T+${item.deadline_minutes})`
          : `Shared${item.shared_at_minutes != null ? ` at T+${item.shared_at_minutes}` : ''}`
        : item.deadline_minutes != null
          ? `Never shared. Deadline was T+${item.deadline_minutes}`
          : 'Never shared';
      addEffect(from, to, {
        at_minute: when,
        kind,
        source: 'intel',
        summary: `${item.title}. ${summary}`,
      });
      impacts.push(impactFor(from, to, kind, summary));
    }
    decisions.push({
      at_minute: when ?? item.deadline_minutes,
      by: holder,
      what,
      source: 'intel',
      impacts,
    });
  }

  let escalations = 0;
  for (const action of input.actions) {
    if (action.action_type !== 'escalated') continue;
    const from = canon(action.team, teams);
    if (!from) continue;
    escalations += 1;
    const hits = namedTeams(action.text, from, aliases);
    const summary = trunc(action.text, 160) || 'Escalated an item';
    const impacts = hits.map((hit) =>
      impactFor(from, hit.team, 'handed_off', 'Escalated to this team'),
    );
    for (const impact of impacts) {
      addEffect(from, impact.team, {
        at_minute: action.at_minute,
        kind: 'handed_off',
        source: 'escalation',
        summary,
      });
    }
    decisions.push({
      at_minute: action.at_minute,
      by: from,
      what: summary.startsWith('Escalat') ? summary : `Escalated: ${summary}`,
      source: 'escalation',
      impacts,
    });
  }

  const postsByTeam = new Map<string, MatrixPost[]>();
  for (const post of input.posts) {
    const from = canon(post.team, teams);
    if (!from) continue;
    const statement =
      (post.overall != null && post.overall >= 70) || post.text.trim().length >= 140;
    if (!statement) continue;
    const list = postsByTeam.get(from) ?? [];
    list.push(post);
    postsByTeam.set(from, list);
  }
  let publicLines = 0;
  for (const [from, posts] of postsByTeam) {
    const chosen = [...posts]
      .sort((a, b) => {
        const grade = (b.overall ?? -1) - (a.overall ?? -1);
        if (grade !== 0) return grade;
        return (a.at_minute ?? 0) - (b.at_minute ?? 0);
      })
      .slice(0, MAX_PUBLIC_PER_TEAM);
    for (const post of chosen) {
      publicLines += 1;
      const hits = namedTeams(post.text, from, aliases);
      const summary = trunc(post.text, 160);
      const impacts = hits.map((hit) =>
        impactFor(from, hit.team, 'told', 'Named in a public line'),
      );
      for (const impact of impacts) {
        addEffect(from, impact.team, {
          at_minute: post.at_minute,
          kind: 'told',
          source: 'public_post',
          summary,
        });
      }
      decisions.push({
        at_minute: post.at_minute,
        by: from,
        what: `Public line: ${summary}`,
        source: 'public_post',
        impacts,
      });
    }
  }

  const published = new Set<string>();
  for (const action of input.actions) {
    if (action.action_type !== 'draft_published') continue;
    const owner = canon(action.document_team, teams) || canon(action.team, teams);
    if (owner) published.add(owner);
  }
  for (const team of postsByTeam.keys()) published.add(team);

  const draftsByTeam = new Map<string, MatrixAction[]>();
  for (const action of input.actions) {
    if (
      action.action_type !== 'draft_submitted_for_approval' &&
      action.action_type !== 'draft_approved'
    ) {
      continue;
    }
    const owner = canon(action.document_team, teams) || canon(action.team, teams);
    if (!owner || published.has(owner)) continue;
    const list = draftsByTeam.get(owner) ?? [];
    list.push(action);
    draftsByTeam.set(owner, list);
  }
  let draftsHeld = 0;
  for (const [from, items] of draftsByTeam) {
    draftsHeld += 1;
    const submitted = items.filter((a) => a.action_type === 'draft_submitted_for_approval');
    const source = submitted.length > 0 ? submitted : items;
    const text = trunc(source.map((a) => a.text).join(' '), 160);
    const what = text
      ? `Draft submitted for clearance and not published. ${text}`
      : 'Draft submitted for clearance and not published.';
    const hits = namedTeams(source.map((a) => a.text).join('\n'), from, aliases);
    const impacts = hits.map((hit) =>
      impactFor(from, hit.team, 'held', 'Named in a draft that was not published'),
    );
    for (const impact of impacts) {
      addEffect(from, impact.team, {
        at_minute: source[0]?.at_minute ?? null,
        kind: 'held',
        source: 'draft',
        summary: what,
      });
    }
    const minutes = source.map((a) => a.at_minute).filter((m): m is number => m != null);
    decisions.push({
      at_minute: minutes.length > 0 ? Math.min(...minutes) : null,
      by: from,
      what,
      source: 'draft',
      impacts,
    });
  }

  for (const decision of input.decisions) {
    const from = canon(decision.by_team, teams);
    const by = from ?? decision.by_team ?? 'Unassigned';
    const impacts: MatrixImpact[] = [];
    const seen = new Set<string>();
    const record = (label: string, kind: ImpactKind, summary: string, at: number | null) => {
      if (!from) return;
      for (const hit of namedTeams(label, from, aliases)) {
        const key = `${hit.team}:${kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        addEffect(from, hit.team, { at_minute: at, kind, source: 'decision_log', summary });
        impacts.push(impactFor(from, hit.team, kind, summary));
      }
    };
    for (const informed of decision.informed) {
      record(informed, 'told', 'Told directly about the decision', decision.at_minute);
    }
    for (const reaction of decision.reactions) {
      const kind: ImpactKind =
        reaction.outcome === 'fired'
          ? 'consequence'
          : reaction.outcome === 'withdrawn' || reaction.outcome === 'softened'
            ? 'enabled'
            : 'told';
      const summary =
        reaction.outcome === 'fired'
          ? `Consequence fired: ${reaction.title}`
          : reaction.outcome === 'withdrawn'
            ? `Consequence withdrawn: ${reaction.title}`
            : reaction.outcome === 'softened'
              ? `Consequence softened: ${reaction.title}`
              : `Consequence ${reaction.outcome}: ${reaction.title}`;
      record(reaction.actor, kind, summary, reaction.at_minute ?? decision.at_minute);
    }
    decisions.push({
      at_minute: decision.at_minute,
      by,
      what: trunc(decision.summary, 180) || 'Recorded decision',
      source: 'decision_log',
      impacts,
    });
  }

  const matrixCells: MatrixCell[] = [];
  let emailEdges = 0;
  for (const cell of cells.values()) {
    if (cell.email_count > 0) {
      emailEdges += 1;
      const target = byName.get(cell.to);
      cell.effects.unshift({
        at_minute: cell.first_email_minute,
        kind: presentKind('told', target?.staffed !== false),
        source: 'email',
        summary: cell.excerpt
          ? `${cell.email_count} email${cell.email_count === 1 ? '' : 's'}. ${cell.excerpt}`
          : `${cell.email_count} email${cell.email_count === 1 ? '' : 's'} named or addressed this team`,
      });
      if (cell.effects.length > MAX_EFFECTS) cell.effects.length = MAX_EFFECTS;
    }
    const headline = cell.effects.reduce<ImpactKind>(
      (best, effect) => worse(best, effect.kind),
      'told',
    );
    matrixCells.push({
      from: cell.from,
      to: cell.to,
      same_org: sameOrg(cell.from, cell.to),
      email_count: cell.email_count,
      headline,
      effects: cell.effects,
    });
  }

  const mentioned = new Set<string>();
  for (const cell of matrixCells) {
    mentioned.add(cell.from);
    mentioned.add(cell.to);
  }
  for (const row of decisions) {
    const by = canon(row.by, teams);
    if (by) mentioned.add(by);
    for (const impact of row.impacts) mentioned.add(impact.team);
  }
  let axis = teams.filter((t) => t.staffed || mentioned.has(t.name));
  if (axis.length > AXIS_CAP) {
    axis = axis.filter((t) => mentioned.has(t.name)).slice(0, AXIS_CAP);
  }

  const agencies = [...new Set(teams.map((t) => t.org).filter((org): org is string => !!org))];
  const agencyCells: AgencyCell[] = [];
  if (agencies.length >= 2) {
    const rolled = new Map<string, AgencyCell & { rank: ImpactKind }>();
    for (const cell of matrixCells) {
      const from = byName.get(cell.from)?.org;
      const to = byName.get(cell.to)?.org;
      if (!from || !to || from === to) continue;
      const key = `${from}\0${to}`;
      const current = rolled.get(key);
      if (!current) {
        rolled.set(key, {
          from,
          to,
          email_count: cell.email_count,
          headline: cell.headline,
          effects: cell.effects.length,
          rank: cell.headline,
        });
      } else {
        current.email_count += cell.email_count;
        current.effects += cell.effects.length;
        current.rank = worse(current.rank, cell.headline);
        current.headline = current.rank;
      }
    }
    for (const cell of rolled.values()) {
      agencyCells.push({
        from: cell.from,
        to: cell.to,
        email_count: cell.email_count,
        headline: cell.headline,
        effects: cell.effects,
      });
    }
    agencyCells.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  }

  const keptEmails = decisions.filter((d) => d.source === 'email');
  const keptOther = decisions.filter((d) => d.source !== 'email');
  const room = Math.max(0, MAX_DECISIONS - keptOther.length);
  const kept = [...keptOther, ...keptEmails.slice(0, room)].sort((a, b) => {
    if (a.at_minute == null && b.at_minute == null) return 0;
    if (a.at_minute == null) return 1;
    if (b.at_minute == null) return -1;
    return a.at_minute - b.at_minute;
  });

  const onAxis = new Set(axis.map((t) => t.name));
  const visibleCells = matrixCells
    .filter((c) => onAxis.has(c.from) && onAxis.has(c.to))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  const note =
    input.decisions.length === 0
      ? 'No decision was written to the decision log. Each row is a decision visible in mail, an intel share, an escalation, a public line, or a draft sent for clearance. A cell is filled only when another team was addressed, named, or listed as needing the intel. An empty seat stays on the matrix when someone relied on it.'
      : 'Rows combine the decision log with mail, intel shares, escalations, public lines and drafts. A cell is filled only when another team was addressed, named, or listed as needing the intel. An empty seat stays on the matrix when someone relied on it.';

  return {
    teams: axis,
    cells: visibleCells,
    agencies,
    agency_cells: agencyCells,
    decisions: kept,
    coverage: {
      decision_log_count: input.decisions.length,
      emails_naming_another_team: emailsNaming,
      email_edges: emailEdges,
      intel_shared: intelShared,
      intel_withheld: intelWithheld,
      escalations,
      public_lines: publicLines,
      drafts_held: draftsHeld,
      effects: visibleCells.length,
    },
    note,
  };
}
