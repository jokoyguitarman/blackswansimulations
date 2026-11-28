import { useEffect, useRef, useState } from 'react';
import {
  readTeamDependencies,
  refreshEdgeTeamNames,
  type ActiveTeam,
  type TeamDependencyEdge,
} from '@shared/teamDependencies';

export interface EditorTeam {
  team_name: string;
  team_uid?: string | null;
  org_key?: string | null;
}

export interface EditorOrg {
  org_key?: string;
  operation?: string;
  display_name?: string;
  name?: string;
}

/**
 * An organisation with `operation: 'ai'` is not playable. Teams with no org,
 * and orgs that omit operation, are playable. Same rule as the server validator.
 */
export function editorActiveTeams(
  teams: readonly EditorTeam[],
  orgs: readonly EditorOrg[],
): ActiveTeam[] {
  const aiOrgs = new Set(
    orgs.flatMap((org) => (org.operation === 'ai' && org.org_key ? [org.org_key] : [])),
  );
  const active: ActiveTeam[] = [];
  for (const team of teams) {
    const name = team.team_name.trim();
    if (!name) continue;
    const orgKey = team.org_key ?? null;
    active.push({
      team_uid: team.team_uid ?? null,
      team_name: name,
      playable: orgKey == null || !aiOrgs.has(orgKey),
    });
  }
  return active;
}

export function readOrgs(initialState: Record<string, unknown>): EditorOrg[] {
  if (!Array.isArray(initialState.orgs)) return [];
  const orgs: EditorOrg[] = [];
  for (const item of initialState.orgs) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    orgs.push({
      org_key: typeof row.org_key === 'string' ? row.org_key : undefined,
      operation: typeof row.operation === 'string' ? row.operation : undefined,
      display_name: typeof row.display_name === 'string' ? row.display_name : undefined,
      name: typeof row.name === 'string' ? row.name : undefined,
    });
  }
  return orgs;
}

export interface DependencyDocument {
  edges: TeamDependencyEdge[];
  error: string | null;
  teams: ActiveTeam[];
  commit: (update: (edges: readonly TeamDependencyEdge[]) => TeamDependencyEdge[]) => Promise<void>;
}

/**
 * One queue so two saves (the tab and the inject form) cannot overwrite each
 * other with a stale copy of `team_dependencies`.
 */
export function useDependencyDocument(
  initialState: Record<string, unknown>,
  saveInitialState: (
    mutate: (state: Record<string, unknown>) => Record<string, unknown>,
  ) => Promise<unknown>,
  teams: readonly EditorTeam[],
): DependencyDocument {
  const active = editorActiveTeams(teams, readOrgs(initialState));
  const activeRef = useRef(active);
  activeRef.current = active;
  const stored = initialState.team_dependencies;
  const read = readTeamDependencies(stored);
  const serverEdges = 'error' in read ? [] : read.dependencies.edges;
  const error = 'error' in read ? read.error : null;
  const edgesRef = useRef<TeamDependencyEdge[]>(serverEdges);
  const [edges, setEdges] = useState<TeamDependencyEdge[]>(serverEdges);
  const saveRef = useRef(saveInitialState);
  saveRef.current = saveInitialState;
  const queue = useRef(Promise.resolve());

  useEffect(() => {
    const next = readTeamDependencies(stored);
    const list = 'error' in next ? [] : next.dependencies.edges;
    edgesRef.current = list;
    setEdges(list);
  }, [stored]);

  const commit = (update: (current: readonly TeamDependencyEdge[]) => TeamDependencyEdge[]) => {
    const run = queue.current.then(async () => {
      const next = update(edgesRef.current).map((edge) =>
        refreshEdgeTeamNames(edge, activeRef.current),
      );
      await saveRef.current((state) => ({
        ...state,
        team_dependencies: { v: 1, edges: next },
      }));
      edgesRef.current = next;
      setEdges(next);
    });
    queue.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return { edges, error, teams: active, commit };
}
