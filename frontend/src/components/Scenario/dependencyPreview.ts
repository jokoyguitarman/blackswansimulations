/**
 * Plain-English sentences for a team dependency and the table cells
 * the dependencies tab renders. No React and no network.
 */

export interface PreviewConsequence {
  team?: string;
  title: string;
}

export interface DependencyPreviewInput {
  upstream: string;
  downstream: readonly string[];
  brokenKeys: readonly string[];
  brokenQuantifier?: 'all' | 'any' | 'at_least';
  metKeys?: readonly string[];
  lagMinutes: number;
  consequences: readonly PreviewConsequence[];
  injectTitles?: Readonly<Record<string, string>>;
}

export interface ConsequenceCell {
  title: string;
  /** The inject key exists on the scenario. */
  found: boolean;
}

export interface DependencyTableInput {
  upstreamName: string;
  upstreamRemoved: boolean;
  downstream: readonly { name: string; removed: boolean }[];
  deliverable: string;
  brokenKeys: readonly string[];
  lagMinutes: number;
  consequences: readonly ConsequenceCell[];
}

export interface DependencyTableCells {
  upstream: string;
  downstream: string;
  deliverable: string;
  breaksWhen: string;
  lag: string;
  consequences: string;
}

function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function quoted(text: string): string {
  return `‘${text}’`;
}

function humanize(slug: string): string {
  return slug.replace(/_/g, ' ');
}

function titleFor(key: string, titles: Readonly<Record<string, string>>): string {
  const named = titles[key];
  return quoted(named && named.trim() ? named.trim() : humanize(key));
}

function keyBody(key: string): string {
  return key.split('|')[0] ?? key;
}

/** One break condition, as the preview sentence says it. */
export function breakPhrase(key: string, titles: Readonly<Record<string, string>> = {}): string {
  const body = keyBody(key);
  const unresponded = /^unresponded:([a-z0-9_]+):(\d+)$/.exec(body);
  if (unresponded) {
    return `doesn't reply to ${titleFor(unresponded[1] ?? '', titles)} within ${unresponded[2]} minutes`;
  }
  const replyFailed = /^reply_failed:([a-z0-9_]+)$/.exec(body);
  if (replyFailed) return `replies poorly to ${titleFor(replyFailed[1] ?? '', titles)}`;
  const silent = /^team_silent:(\d+)$/.exec(body);
  if (silent) return `stays silent for ${silent[1]} minutes`;
  const duty = /^duty_missed:([a-z0-9_]+)/.exec(body);
  if (duty) return `misses ${quoted(humanize(duty[1] ?? ''))}`;
  const content = /^content_failed:(\d+):(\d+)$/.exec(body);
  if (content) {
    return content[1] === '1'
      ? `has content scored below ${content[2]}`
      : `has at least ${content[1]} pieces of content scored below ${content[2]}`;
  }
  const decision = /^decision_made:([a-z0-9_]+)$/.exec(body);
  if (decision) return `makes a ${humanize(decision[1] ?? '')} decision`;
  const action = /^action_count_gte:([a-z0-9_]+):(\d+)$/.exec(body);
  if (action) {
    const name = quoted(humanize(action[1] ?? ''));
    return action[2] === '1' ? `does ${name}` : `does ${name} at least ${action[2]} times`;
  }
  const intel = /^intel_missing:([a-z0-9_]+)$/.exec(body);
  if (intel) return `hasn't shared ${titleFor(intel[1] ?? '', titles)}`;
  const email = /^email_unreplied:([a-z0-9_]+):(\d+)$/.exec(body);
  if (email) {
    return `doesn't reply to the email ${titleFor(email[1] ?? '', titles)} within ${email[2]} minutes`;
  }
  return `breaks ${quoted(humanize(body))}`;
}

/** Short label for the dependencies table. */
export function shortBreak(key: string): string {
  const body = keyBody(key);
  const unresponded = /^unresponded:[a-z0-9_]+:(\d+)$/.exec(body);
  if (unresponded) return `no reply ${unresponded[1]}`;
  if (/^reply_failed:/.test(body)) return 'poor reply';
  const silent = /^team_silent:(\d+)$/.exec(body);
  if (silent) return `silent ${silent[1]}`;
  if (/^duty_missed:/.test(body)) return 'missed duty';
  if (/^content_failed:/.test(body)) return 'poor content';
  if (/^decision_made:/.test(body)) return 'decision';
  if (/^action_count_gte:/.test(body)) return 'action';
  if (/^intel_missing:/.test(body)) return 'intel missing';
  const email = /^email_unreplied:[a-z0-9_]+:(\d+)$/.exec(body);
  if (email) return `no email reply ${email[1]}`;
  return 'condition';
}

function lagWords(minutes: number): string {
  if (minutes <= 0) return 'immediately';
  if (minutes === 1) return '1 minute later';
  return `${minutes} minutes later`;
}

function receiveClause(
  downstream: readonly string[],
  consequences: readonly PreviewConsequence[],
): string {
  const titled = consequences.filter((item) => item.title.trim());
  if (titled.length === 0) {
    const who = downstream.length > 0 ? joinAnd(downstream) : 'the downstream team';
    return downstream.length > 1 ? `${who} are affected` : `${who} is affected`;
  }
  if (titled.length > 1 && titled.every((item) => item.team)) {
    return joinAnd(titled.map((item) => `${item.team} receives ${quoted(item.title.trim())}`));
  }
  const who =
    downstream.length > 0 ? joinAnd(downstream) : (titled[0]?.team ?? 'the downstream team');
  const verb = downstream.length > 1 ? 'receive' : 'receives';
  const what = joinAnd(titled.map((item) => quoted(item.title.trim())));
  return `${who} ${verb} ${what}`;
}

function deliversFirst(key: string): boolean {
  return /^(responded|reply_|email_replied|intel_shared)/.test(keyBody(key));
}

/** The sentence under a dependency and inside the "fails this" dialog. */
export function dependencyPreviewSentence(input: DependencyPreviewInput): string {
  const titles = input.injectTitles ?? {};
  const phrases = input.brokenKeys.map((key) => breakPhrase(key, titles));
  const quantifier = input.brokenQuantifier ?? 'any';
  const breakText =
    phrases.length === 0
      ? 'breaks the dependency'
      : quantifier === 'all'
        ? phrases.join(' and ')
        : phrases.join(' or ');
  const receive = receiveClause(input.downstream, input.consequences);
  let sentence = `When ${input.upstream} ${breakText}, ${receive} ${lagWords(input.lagMinutes)}.`;
  const met = input.metKeys ?? [];
  if (met.length > 0) {
    sentence += deliversFirst(met[0] ?? '')
      ? ` Cancelled if ${input.upstream} delivers first.`
      : ` Cancelled if ${input.upstream} meets it first.`;
  }
  return sentence;
}

export function causeChipText(
  upstream: string,
  deliverable: string,
  landsOn: readonly string[],
): string {
  const lands = landsOn.length > 0 ? joinAnd(landsOn) : 'another team';
  return `Fires when ${upstream} breaks ${quoted(deliverable)} · lands on ${lands}`;
}

function teamList(teams: readonly { name: string; removed: boolean }[]): string {
  return joinAnd(teams.map((team) => (team.removed ? `⚠ ${team.name} (removed)` : team.name)));
}

function consequenceCell(items: readonly ConsequenceCell[]): string {
  if (items.length === 0) return 'none';
  if (items.length === 1) {
    const one = items[0]!;
    return one.found ? `${one.title} (✓)` : one.title;
  }
  return `${items.length} injects`;
}

/** One dependencies-tab row, including the removed-team orphan. */
export function dependencyTableCells(input: DependencyTableInput): DependencyTableCells {
  if (input.upstreamRemoved) {
    return {
      upstream: `⚠ ${input.upstreamName} (removed)`,
      downstream: teamList(input.downstream),
      deliverable: input.deliverable,
      breaksWhen: '—',
      lag: '—',
      consequences: 'orphan: fix or retire',
    };
  }
  const first = input.brokenKeys[0];
  return {
    upstream: input.upstreamName,
    downstream: teamList(input.downstream),
    deliverable: input.deliverable,
    breaksWhen: first ? shortBreak(first) : '—',
    lag: input.lagMinutes === 1 ? '1 min' : `${Math.max(0, input.lagMinutes)} min`,
    consequences: consequenceCell(input.consequences),
  };
}
