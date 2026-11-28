import { Fragment, useState } from 'react';
import {
  displayRef,
  matchTeamRef,
  takenDependencyIds,
  type TeamDependencyEdge,
} from '@shared/teamDependencies';
import { WrIcon } from '../UI/WarRoomIcon';
import { WrSection } from '../UI/Collapsible';
import { filterLane, laneShowsSearch, takeLanePages } from './lanePaging';
import {
  formatSaveError,
  readOrgs,
  type DependencyDocument,
  type EditorTeam,
} from './dependencyDocument';
import { DependencyDrawer, type DrawerInject } from './DependencyDrawer';
import { dependencyPreviewSentence, dependencyTableCells } from './dependencyPreview';

interface StakeholderChoice {
  id: string;
  name: string;
}

function readStakeholders(initialState: Record<string, unknown>): StakeholderChoice[] {
  if (!Array.isArray(initialState.stakeholders)) return [];
  const options: StakeholderChoice[] = [];
  for (const item of initialState.stakeholders) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { id?: unknown; name?: unknown };
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id) continue;
    const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : id;
    options.push({ id, name });
  }
  return options;
}

function injectKey(inject: DrawerInject): string | null {
  const key = inject.delivery_config?.inject_key;
  return typeof key === 'string' ? key : null;
}

export function TeamDependenciesSection({
  scenarioId,
  initialState,
  teamList,
  injects,
  durationMinutes,
  locked,
  document,
  onInjectCreated,
  onInjectUpdated,
}: {
  scenarioId: string;
  initialState: Record<string, unknown>;
  teamList: readonly EditorTeam[];
  injects: readonly DrawerInject[];
  durationMinutes: number;
  locked: boolean;
  document: DependencyDocument;
  onInjectCreated: (row: Record<string, unknown>) => void;
  onInjectUpdated: (row: Record<string, unknown>) => void;
}) {
  const orgs = readOrgs(initialState);
  const { edges, error, teams, commit } = document;
  const [teamFilter, setTeamFilter] = useState('all');
  const [orgFilter, setOrgFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [pages, setPages] = useState(1);
  const [editing, setEditing] = useState<TeamDependencyEdge | null | 'new'>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const orgLabel = (edge: TeamDependencyEdge): string => {
    const upstream = displayRef(edge.upstream, teams);
    if (upstream.removed) return 'Removed teams';
    const row = teamList.find((team) => matchTeamRef(edge.upstream, [teamRow(team)]) != null);
    if (!row?.org_key) return 'This organisation';
    const org = orgs.find((item) => item.org_key === row.org_key);
    return org?.display_name || org?.name || row.org_key;
  };

  const cards = edges.map((edge) => {
    const upstream = displayRef(edge.upstream, teams);
    const downstream = edge.downstream.map((ref) => displayRef(ref, teams));
    const org = orgLabel(edge);
    const search = [
      upstream.name,
      ...downstream.map((team) => team.name),
      edge.deliverable,
      edge.why,
      edge.kind,
      org,
    ].join(' ');
    return { edge, search, org, upstream, downstream };
  });
  cards.sort((a, b) => {
    if (a.org === b.org) return 0;
    if (a.org === 'Removed teams') return 1;
    if (b.org === 'Removed teams') return -1;
    return a.org.localeCompare(b.org);
  });

  const orgOptions = Array.from(new Set(cards.map((card) => card.org))).sort((a, b) => {
    if (a === 'Removed teams') return 1;
    if (b === 'Removed teams') return -1;
    return a.localeCompare(b);
  });
  const teamOptions = Array.from(
    new Set(teams.filter((team) => team.playable !== false).map((team) => team.team_name)),
  ).sort((a, b) => a.localeCompare(b));

  const filtered = cards.filter((card) => {
    if (kindFilter !== 'all' && card.edge.kind !== kindFilter) return false;
    if (orgFilter !== 'all' && card.org !== orgFilter) return false;
    if (teamFilter !== 'all') {
      const names = [card.upstream.name, ...card.downstream.map((team) => team.name)];
      if (!names.includes(teamFilter)) return false;
    }
    return true;
  });
  const searched = filterLane(filtered, query);
  const visible = takeLanePages(searched, pages);
  const showSearch = laneShowsSearch(edges.length);

  const retire = async (edge: TeamDependencyEdge) => {
    if (
      !window.confirm(
        `Retire the dependency “${edge.deliverable}”? Its consequence injects stay on the timeline.`,
      )
    ) {
      return;
    }
    setRowError(null);
    try {
      await commit((current) => current.filter((item) => item.id !== edge.id));
      if (editing && editing !== 'new' && editing.id === edge.id) setEditing(null);
    } catch (err) {
      setRowError(formatSaveError(err));
    }
  };

  return (
    <WrSection
      id="dependencies"
      title="Team dependencies"
      subtitle="Who owes what to whom. A removed team stays here until you fix the row or retire it."
      count={edges.length}
      icon="users"
      family="var(--f-org)"
      defaultOpen
    >
      <div data-section="team-dependencies">
        {error && (
          <p className="text-xs text-danger mb-2">These dependencies could not be read: {error}</p>
        )}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className="text-[11px] text-muted font-medium">Filter</span>
          <select
            aria-label="Filter by team"
            className="text-xs bg-surface border border-border rounded px-2 py-1"
            value={teamFilter}
            onChange={(event) => {
              setTeamFilter(event.target.value);
              setPages(1);
            }}
          >
            <option value="all">All teams</option>
            {teamOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by organisation"
            className="text-xs bg-surface border border-border rounded px-2 py-1"
            value={orgFilter}
            onChange={(event) => {
              setOrgFilter(event.target.value);
              setPages(1);
            }}
          >
            <option value="all">All organisations</option>
            {orgOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by kind"
            className="text-xs bg-surface border border-border rounded px-2 py-1"
            value={kindFilter}
            onChange={(event) => {
              setKindFilter(event.target.value);
              setPages(1);
            }}
          >
            <option value="all">All kinds</option>
            {[
              'information',
              'decision',
              'approval',
              'resource',
              'action',
              'coverage',
              'restraint',
            ].map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
          {showSearch && (
            <input
              aria-label="Search dependencies"
              className="text-xs bg-surface border border-border rounded px-2 py-1 ml-auto"
              placeholder="Search dependencies"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPages(1);
              }}
            />
          )}
          {!locked && (
            <button
              type="button"
              className={`wr-btn sm ${showSearch ? '' : 'ml-auto'}`}
              disabled={!!error}
              onClick={() => setEditing('new')}
            >
              <WrIcon name="plus" /> Add dependency
            </button>
          )}
        </div>

        {edges.length === 0 ? (
          <p className="text-xs text-muted py-2">
            No team dependencies yet. Add one to say what an upstream team owes a downstream team.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left border-collapse">
              <thead>
                <tr className="text-[11px] text-muted border-b border-border">
                  <th className="py-1 pr-2 font-medium">Upstream (owes)</th>
                  <th className="py-1 pr-2 font-medium">Downstream (needs)</th>
                  <th className="py-1 pr-2 font-medium">Deliverable</th>
                  <th className="py-1 pr-2 font-medium">Breaks when</th>
                  <th className="py-1 pr-2 font-medium">Lag</th>
                  <th className="py-1 font-medium">Consequences</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((card, index) => {
                  const previous = visible[index - 1];
                  const showOrg = !previous || previous.org !== card.org;
                  const cells = dependencyTableCells({
                    upstreamName: card.upstream.name,
                    upstreamRemoved: card.upstream.removed,
                    downstream: card.downstream,
                    deliverable: card.edge.deliverable,
                    brokenKeys: groupKeys(card.edge),
                    lagMinutes: card.edge.lag_minutes,
                    consequences: card.edge.consequence_keys.map((key) => {
                      const found = injects.find((inject) => injectKey(inject) === key);
                      return { title: found?.title || key, found: !!found };
                    }),
                  });
                  const preview = card.upstream.removed
                    ? 'This team was removed. Fix the upstream team, or retire the dependency.'
                    : dependencyPreviewSentence({
                        upstream: card.upstream.name,
                        downstream: card.downstream.map((team) => team.name),
                        brokenKeys: groupKeys(card.edge),
                        lagMinutes: card.edge.lag_minutes,
                        consequences: card.edge.consequence_keys.map((key) => ({
                          title: injects.find((inject) => injectKey(inject) === key)?.title || key,
                        })),
                      });
                  return (
                    <Fragment key={card.edge.id}>
                      {showOrg && (
                        <tr className="bg-surface-2">
                          <td colSpan={6} className="py-1 px-1 text-[11px] font-medium text-muted">
                            {card.org}
                          </td>
                        </tr>
                      )}
                      <tr
                        className="border-b border-border cursor-pointer hover:bg-surface-2"
                        title={preview}
                        data-section={
                          card.upstream.removed ? 'dependency-orphan' : 'dependency-row'
                        }
                        onClick={() => setEditing(card.edge)}
                      >
                        <td
                          className={`py-1.5 pr-2 ${card.upstream.removed ? 'text-warning' : 'text-ink'}`}
                        >
                          {cells.upstream}
                        </td>
                        <td className="py-1.5 pr-2 text-ink">{cells.downstream}</td>
                        <td className="py-1.5 pr-2 text-ink">{cells.deliverable}</td>
                        <td className="py-1.5 pr-2 text-muted">{cells.breaksWhen}</td>
                        <td className="py-1.5 pr-2 text-muted">{cells.lag}</td>
                        <td className="py-1.5 text-ink">
                          {cells.consequences}
                          {card.upstream.removed && !locked && (
                            <span className="block mt-1 space-x-2">
                              <button
                                type="button"
                                className="text-brand hover:underline"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setEditing(card.edge);
                                }}
                              >
                                Fix
                              </button>
                              <button
                                type="button"
                                className="text-danger hover:underline"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void retire(card.edge);
                                }}
                              >
                                Retire
                              </button>
                            </span>
                          )}
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {visible.length < searched.length && (
              <button
                type="button"
                className="wr-btn sm mt-2"
                onClick={() => setPages((current) => current + 1)}
              >
                Show more
              </button>
            )}
            {searched.length === 0 && (
              <p className="text-xs text-muted py-2">No dependencies match this filter.</p>
            )}
            {showSearch && (
              <p className="text-[11px] text-muted mt-1">
                Showing {visible.length} of {searched.length} dependencies
              </p>
            )}
          </div>
        )}
        {rowError && <p className="text-xs text-danger mt-2">{rowError}</p>}
      </div>

      {editing && (
        <DependencyDrawer
          scenarioId={scenarioId}
          edge={editing === 'new' ? null : editing}
          teams={teams}
          injects={injects}
          stakeholders={readStakeholders(initialState)}
          durationMinutes={durationMinutes}
          takenDependencyIds={takenDependencyIds(edges, injects)}
          locked={locked}
          onClose={() => setEditing(null)}
          onCommit={async (next) => {
            await commit((current) => {
              const index = current.findIndex((item) => item.id === next.id);
              if (index < 0) return [...current, next];
              return current.map((item) => (item.id === next.id ? next : item));
            });
          }}
          onInjectCreated={onInjectCreated}
          onInjectUpdated={onInjectUpdated}
        />
      )}
    </WrSection>
  );
}

function teamRow(team: EditorTeam): { team_uid: string | null; team_name: string } {
  return { team_uid: team.team_uid ?? null, team_name: team.team_name };
}

function groupKeys(edge: TeamDependencyEdge): string[] {
  return 'all' in edge.broken_when ? edge.broken_when.all : edge.broken_when.conditions;
}
