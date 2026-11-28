export interface ReviewPlanTeam {
  team_uid?: string;
  team_name?: string;
  from_name?: string;
  source_id?: string;
  reason?: string;
}

export interface ReviewPlan {
  applicable?: boolean;
  teams?: { retire?: ReviewPlanTeam[]; successors?: ReviewPlanTeam[] };
  injects?: { retire?: Array<{ inject_id?: string; inject_key?: string; reason?: string }> };
  orphans?: Array<{
    id: string;
    kind?: string;
    message?: string;
    choices?: string[];
    condition_key?: string;
    target_key?: string;
  }>;
  scheduled_sessions?: Array<{ unassigned_players?: unknown[]; session_id?: string }>;
  primary_swap?: { story?: { premise?: string } } | null;
}

export interface ReviewRevision {
  inject_id: string;
  inject_key?: string;
  decision?: string;
  reason?: string;
  write?: string;
  new?: { title?: string; content?: string };
}

export interface ReviewFlag {
  inject_id: string;
  inject_key?: string;
  reason?: string;
  provenance?: string;
  suggestion?: { title?: string; content?: string };
}

export interface ReviewStageOutput {
  stage?: string;
  skipped?: boolean;
  revisions?: ReviewRevision[];
  flags?: ReviewFlag[];
  generated?: {
    personas?: Array<{ name?: string; handle?: string }>;
    team_storylines?: Record<string, unknown>;
    stakeholders?: Array<{ id?: string; name?: string }>;
    shared_injects?: Array<{ title?: string }>;
    gates?: Array<{ title?: string }>;
    pages?: Array<Record<string, unknown>>;
    layer_injects?: Array<{ title?: string }>;
    pressure_injects?: Array<{ title?: string }>;
  } | null;
}

export interface ReviewRow {
  id: string;
  title: string;
  detail: string;
  before?: string;
  after?: string;
  reason?: string;
  rejectable: boolean;
  injectId?: string;
  choices?: string[];
  kind?: string;
  conditionKey?: string;
  targetKey?: string;
}

export interface ReviewSection {
  id: 'added' | 'renamed' | 'removed' | 'revised' | 'flagged' | 'orphans';
  title: string;
  rows: ReviewRow[];
  /** Brief and swap revisions. Other sections are not rejectable. */
  keepAllOriginals: boolean;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function pageName(page: Record<string, unknown>): string {
  return text(page.display_name) || text(page.name) || text(page.org_key) || 'Page';
}

/**
 * Review sections for one edit. Revisions are pre-accepted; the caller tracks
 * which rows the trainer marks "Keep original".
 */
export function reviewSections(plan: ReviewPlan, outputs: readonly ReviewStageOutput[]): ReviewSection[] {
  const sections: ReviewSection[] = [];
  const added = addedRows(outputs);
  if (added.length > 0) {
    sections.push({ id: 'added', title: 'Added', rows: added, keepAllOriginals: false });
  }
  const renamed = (plan.teams?.successors ?? [])
    .filter((team) => team.reason !== 'rekeyed')
    .map((team) => ({
      id: `rename:${team.team_uid || team.team_name || team.from_name || 'team'}`,
      title: text(team.team_name) || 'Team',
      detail: text(team.from_name) ? `From ${text(team.from_name)}` : 'Renamed',
      before: text(team.from_name) || undefined,
      after: text(team.team_name) || undefined,
      rejectable: false,
    }));
  if (renamed.length > 0) {
    sections.push({ id: 'renamed', title: 'Renamed', rows: renamed, keepAllOriginals: false });
  }
  const removedTeams = (plan.teams?.retire ?? []).filter((team) => team.reason === 'removed');
  const removedInjects = plan.injects?.retire ?? [];
  const removed: ReviewRow[] = [
    ...removedTeams.map((team) => ({
      id: `remove-team:${team.team_uid || team.source_id || team.team_name}`,
      title: text(team.team_name) || 'Team',
      detail: 'Team retired',
      rejectable: false,
    })),
    ...removedInjects.map((inject) => ({
      id: `remove-inject:${inject.inject_id || inject.inject_key}`,
      title: text(inject.inject_key) || 'Inject',
      detail: text(inject.reason).replaceAll('_', ' ') || 'Retired',
      rejectable: false,
    })),
  ];
  if (removed.length > 0) {
    sections.push({ id: 'removed', title: 'Removed / retired', rows: removed, keepAllOriginals: false });
  }

  const revisions = new Map<string, ReviewRevision>();
  for (const output of outputs) {
    for (const revision of output.revisions ?? []) {
      if (!revision.inject_id) continue;
      if (revision.decision === 'keep' || revision.write === 'none') continue;
      revisions.set(revision.inject_id, revision);
    }
  }
  const revised: ReviewRow[] = [...revisions.values()].map((revision) => ({
    id: `revision:${revision.inject_id}`,
    title: text(revision.new?.title) || text(revision.inject_key) || 'Inject',
    detail: revision.decision === 'retire' ? 'Retire this inject' : 'Revised',
    before: text(revision.inject_key) || undefined,
    after: text(revision.new?.content) || text(revision.new?.title) || undefined,
    reason: text(revision.reason) || undefined,
    rejectable: true,
    injectId: revision.inject_id,
  }));
  if (plan.primary_swap?.story?.premise) {
    revised.unshift({
      id: 'swap-premise',
      title: 'Primary organisation',
      detail: 'Not rejectable. The story is re-centred.',
      reason: plan.primary_swap.story.premise,
      rejectable: false,
    });
  }
  if (revised.length > 0) {
    sections.push({
      id: 'revised',
      title: 'Revised by the brief change',
      rows: revised,
      keepAllOriginals: revised.some((row) => row.rejectable),
    });
  }

  const flags = new Map<string, ReviewFlag>();
  for (const output of outputs) {
    for (const flag of output.flags ?? []) {
      if (flag.inject_id) flags.set(flag.inject_id, flag);
    }
  }
  const flagged: ReviewRow[] = [...flags.values()].map((flag) => ({
    id: `flag:${flag.inject_id}`,
    title: text(flag.inject_key) || 'Hand-edited inject',
    detail: flag.provenance === 'unverified' ? 'Unverified' : 'Hand-edited',
    reason: text(flag.reason) || undefined,
    after: text(flag.suggestion?.content) || text(flag.suggestion?.title) || undefined,
    rejectable: false,
    injectId: flag.inject_id,
  }));
  if (flagged.length > 0) {
    sections.push({
      id: 'flagged',
      title: 'Hand-edited content flagged',
      rows: flagged,
      keepAllOriginals: false,
    });
  }

  const orphans: ReviewRow[] = (plan.orphans ?? []).map((orphan) => ({
    id: orphan.id,
    title: text(orphan.kind).replaceAll('_', ' ') || 'Decision',
    detail: text(orphan.message) || 'Needs a decision',
    rejectable: false,
    choices: orphan.choices ?? [],
    kind: orphan.kind,
    conditionKey: orphan.condition_key,
    targetKey: orphan.target_key,
  }));
  if (orphans.length > 0) {
    sections.push({ id: 'orphans', title: 'Needs your decision', rows: orphans, keepAllOriginals: false });
  }
  return sections;
}

function addedRows(outputs: readonly ReviewStageOutput[]): ReviewRow[] {
  const rows: ReviewRow[] = [];
  const seen = new Set<string>();
  const push = (id: string, title: string, detail: string) => {
    if (!title || seen.has(id)) return;
    seen.add(id);
    rows.push({ id, title, detail, rejectable: false });
  };
  for (const output of outputs) {
    const generated = output.generated;
    if (!generated) continue;
    for (const persona of generated.personas ?? []) {
      const name = text(persona.name) || text(persona.handle);
      push(`persona:${name}`, name, 'Persona');
    }
    for (const team of Object.keys(generated.team_storylines ?? {})) {
      push(`team:${team}`, team, 'Team storyline');
    }
    for (const stakeholder of generated.stakeholders ?? []) {
      const name = text(stakeholder.name) || text(stakeholder.id);
      push(`stakeholder:${name}`, name, 'Stakeholder');
    }
    for (const inject of [
      ...(generated.shared_injects ?? []),
      ...(generated.gates ?? []),
      ...(generated.layer_injects ?? []),
      ...(generated.pressure_injects ?? []),
    ]) {
      const title = text(inject.title);
      push(`inject:${title}`, title, 'New inject');
    }
    for (const page of generated.pages ?? []) {
      const name = pageName(page);
      push(`page:${name}`, name, 'Page');
    }
  }
  return rows;
}

export interface RemovalCounts {
  teams: number;
  injects: number;
  players: number;
  sessions: number;
}

export function removalCounts(plan: ReviewPlan): RemovalCounts {
  const sessions = (plan.scheduled_sessions ?? []).filter(
    (session) => (session.unassigned_players?.length ?? 0) > 0,
  );
  const players = sessions.reduce((sum, session) => sum + (session.unassigned_players?.length ?? 0), 0);
  return {
    teams: (plan.teams?.retire ?? []).filter((team) => team.reason === 'removed').length,
    injects: plan.injects?.retire?.length ?? 0,
    players,
    sessions: sessions.length,
  };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Confirmation copy for a dry-run plan. Matches the counts the trainer is about to accept. */
export function removalConfirmText(plan: ReviewPlan): string {
  const counts = removalCounts(plan);
  return `Removes ${plural(counts.teams, 'team')}, retires ${plural(counts.injects, 'inject')}, unassigns ${plural(counts.players, 'player')} in ${plural(counts.sessions, 'scheduled session')}.`;
}

export function skippedStageNames(outputs: readonly ReviewStageOutput[]): string[] {
  return outputs.filter((output) => output.skipped && output.stage).map((output) => output.stage as string);
}
