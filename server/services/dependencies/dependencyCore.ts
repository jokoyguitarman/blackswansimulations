/**
 * Pure checks for initial_state.team_dependencies. No database and no network.
 * Runtime transitions are re-exported from dependencyRuntimeCore.ts.
 * Generation and the editor are other work packages.
 */

import {
  conditionGroupKeys,
  matchTeamRef,
  type ActiveTeam,
  type NormalizedConditions,
  type TeamDependencies,
  type TeamDependencyEdge,
  type TeamRef,
} from '../../../shared/teamDependencies.js';
import { dependencyEdgeSchema } from './dependencySchema.js';
import { slugifyTeamName } from '../../../shared/conditionKeyGrammar.js';
import { parseConditionKey, type ConditionDef } from '../conditions/conditionCatalog.js';

export { evaluateDependency, nextState } from './dependencyRuntimeCore.js';
export type { DependencyEvaluation } from './dependencyRuntimeCore.js';

export type { ActiveTeam, TeamDependencyEdge, TeamDependencies };

export type DependencyIssueCode =
  | 'MO-DEP-001'
  | 'MO-DEP-002'
  | 'MO-DEP-003'
  | 'MO-DEP-004'
  | 'MO-DEP-005'
  | 'MO-DEP-006'
  | 'MO-DEP-007'
  | 'MO-DEP-008'
  | 'MO-DEP-009';

export interface DependencyIssue {
  code: DependencyIssueCode;
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface DependencyInjectRef {
  inject_key: string;
  trigger_time_minutes?: number | null;
  /** False when the inject is timed. Omitted means the caller did not say. */
  conditional?: boolean;
  condition_keys?: readonly string[];
}

export interface TeamRow {
  team_uid?: string | null;
  team_name?: string | null;
  org_key?: string | null;
}

export interface OrgOperationRow {
  org_key?: string | null;
  operation?: string | null;
}

export interface DependencyValidation {
  edges: TeamDependencyEdge[];
  issues: DependencyIssue[];
}

type InjectInput = string | DependencyInjectRef;

function issue(
  code: DependencyIssueCode,
  path: string,
  message: string,
  severity: DependencyIssue['severity'] = 'error',
): DependencyIssue {
  return { code, path, message, severity };
}

function usesDependencyKey(key: string): boolean {
  const body = key.split('|')[0]?.trim() ?? '';
  return body.startsWith('dependency_');
}

function referencesEdge(key: string, depId: string): boolean {
  const body = key.split('|')[0]?.trim() ?? '';
  if (!body.startsWith('dependency_')) return false;
  const rest = body.slice('dependency_'.length);
  const colon = rest.indexOf(':');
  if (colon < 0) return false;
  const arg = rest.slice(colon + 1);
  return arg === depId || arg.startsWith(`${depId}:`);
}

function injectKeyArgs(def: ConditionDef, args: readonly string[]): string[] {
  const refs: string[] = [];
  (def.params ?? []).forEach((param, index) => {
    if (param.type === 'inject_key' && args[index]) refs.push(args[index]);
  });
  return refs;
}

function schemaMessage(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): string {
  return error.issues
    .map((item) => {
      const path = item.path.length ? item.path.map(String).join('.') : 'edge';
      return `${path}: ${item.message}`;
    })
    .join('; ');
}

function asInject(item: InjectInput): DependencyInjectRef {
  if (typeof item === 'string') return { inject_key: item, condition_keys: [] };
  return item;
}

function teamIdentity(ref: TeamRef, team: ActiveTeam | null, index: number): string {
  if (team?.team_uid) return `uid:${team.team_uid}`;
  if (ref.team_uid) return `uid:${ref.team_uid}`;
  const slug = slugifyTeamName(team?.team_name ?? ref.team_name);
  return slug ? `name:${slug}` : `blank:${index}`;
}

function refreshRef(ref: TeamRef, team: ActiveTeam | null): TeamRef {
  return {
    team_uid: ref.team_uid,
    team_name: team ? team.team_name : ref.team_name,
  };
}

export { toActiveTeams } from '../../../shared/teamDependencies.js';

export function readDependencyEdges(value: unknown): { edges: unknown[] } | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'team_dependencies must be an object' };
  }
  const record = value as { v?: unknown; edges?: unknown };
  if (record.v !== 1) return { error: 'team_dependencies.v must be 1' };
  if (!Array.isArray(record.edges)) return { error: 'team_dependencies.edges must be an array' };
  return { edges: record.edges };
}

export function validateDependencies(
  edges: unknown,
  teams: readonly ActiveTeam[],
  injects: readonly InjectInput[],
  durationMinutes: number | null,
): DependencyValidation {
  if (!Array.isArray(edges)) {
    return {
      edges: [],
      issues: [issue('MO-DEP-001', 'edges', 'edges must be an array')],
    };
  }

  const byKey = new Map<string, DependencyInjectRef>();
  for (const item of injects) {
    const ref = asInject(item);
    if (!byKey.has(ref.inject_key)) byKey.set(ref.inject_key, ref);
  }

  const issues: DependencyIssue[] = [];
  const kept: TeamDependencyEdge[] = [];
  const seen = new Set<string>();

  edges.forEach((raw, index) => {
    const path = `edges[${index}]`;
    const parsed = dependencyEdgeSchema.safeParse(raw);
    if (!parsed.success) {
      issues.push(issue('MO-DEP-001', path, schemaMessage(parsed.error)));
      return;
    }
    const edge = parsed.data;
    if (seen.has(edge.id)) {
      issues.push(issue('MO-DEP-002', `${path}.id`, `Duplicate dependency id ${edge.id}`));
    }
    seen.add(edge.id);

    const upstreamTeam = matchTeamRef(edge.upstream, teams);
    if (!upstreamTeam) {
      issues.push(
        issue(
          'MO-DEP-003',
          `${path}.upstream`,
          `Upstream team "${edge.upstream.team_name || edge.upstream.team_uid || ''}" is not an active team`,
        ),
      );
    } else if (upstreamTeam.playable === false) {
      issues.push(
        issue(
          'MO-DEP-003',
          `${path}.upstream`,
          `Upstream team "${upstreamTeam.team_name}" is not a playable team`,
        ),
      );
    }

    if (edge.downstream.length > 3) {
      issues.push(
        issue(
          'MO-DEP-004',
          `${path}.downstream`,
          `A dependency lists ${edge.downstream.length} downstream teams; the maximum is 3`,
        ),
      );
    }

    const upstreamIdentity = teamIdentity(edge.upstream, upstreamTeam, -1);
    const seenDown = new Set<string>();
    edge.downstream.forEach((ref, downIndex) => {
      const downPath = `${path}.downstream[${downIndex}]`;
      const team = matchTeamRef(ref, teams);
      if (!team) {
        issues.push(
          issue(
            'MO-DEP-004',
            downPath,
            `Downstream team "${ref.team_name || ref.team_uid || ''}" is not an active team`,
          ),
        );
      } else if (team.playable === false) {
        issues.push(
          issue(
            'MO-DEP-004',
            downPath,
            `Downstream team "${team.team_name}" is not a playable team`,
          ),
        );
      }
      const identity = teamIdentity(ref, team, downIndex);
      if (identity === upstreamIdentity) {
        issues.push(
          issue('MO-DEP-004', downPath, 'Downstream team is the same as the upstream team'),
        );
      }
      if (seenDown.has(identity)) {
        issues.push(
          issue(
            'MO-DEP-004',
            downPath,
            `Downstream team "${ref.team_name}" is listed more than once`,
          ),
        );
      }
      seenDown.add(identity);
    });

    reportConditions(edge.broken_when, `${path}.broken_when`, byKey, issues);
    reportConditions(edge.met_when, `${path}.met_when`, byKey, issues);
    reportDue(edge, path, byKey, durationMinutes, issues);
    reportConsequences(edge, path, byKey, injects.map(asInject), issues);

    kept.push({
      ...edge,
      upstream: refreshRef(edge.upstream, upstreamTeam),
      downstream: edge.downstream.map((ref) => refreshRef(ref, matchTeamRef(ref, teams))),
    });
  });

  return { edges: kept, issues };
}

function reportConditions(
  group: NormalizedConditions | null,
  path: string,
  byKey: ReadonlyMap<string, DependencyInjectRef>,
  issues: DependencyIssue[],
): void {
  for (const key of conditionGroupKeys(group)) {
    if (usesDependencyKey(key)) {
      issues.push(
        issue(
          'MO-DEP-005',
          path,
          `Condition ${key} uses a dependency_* key. Dependencies cannot reference other dependencies`,
        ),
      );
      continue;
    }
    const parsed = parseConditionKey(key, { allowPlaceholders: true });
    if ('error' in parsed) {
      issues.push(issue('MO-DEP-005', path, `Condition ${key} failed to parse: ${parsed.error}`));
      continue;
    }
    for (const ref of injectKeyArgs(parsed.def, parsed.args)) {
      if (!byKey.has(ref)) {
        issues.push(
          issue(
            'MO-DEP-006',
            path,
            `Condition ${key} references inject_key "${ref}", which is not in the scenario`,
          ),
        );
      }
    }
  }
}

function reportDue(
  edge: TeamDependencyEdge,
  path: string,
  byKey: ReadonlyMap<string, DependencyInjectRef>,
  durationMinutes: number | null,
  issues: DependencyIssue[],
): void {
  const due = edge.due;
  if ('after_inject_key' in due && !byKey.has(due.after_inject_key)) {
    issues.push(
      issue(
        'MO-DEP-006',
        `${path}.due`,
        `Due references inject_key "${due.after_inject_key}", which is not in the scenario`,
      ),
    );
  }
  if (durationMinutes == null || !(durationMinutes > 0)) return;
  if ('by_minute' in due) {
    if (due.by_minute > durationMinutes) {
      issues.push(
        issue(
          'MO-DEP-007',
          `${path}.due`,
          `Due minute ${due.by_minute} is past the ${durationMinutes}-minute scenario`,
        ),
      );
    }
    return;
  }
  const trigger = byKey.get(due.after_inject_key)?.trigger_time_minutes;
  const end = typeof trigger === 'number' ? trigger + due.within_minutes : due.within_minutes;
  if (end > durationMinutes) {
    issues.push(
      issue(
        'MO-DEP-007',
        `${path}.due`,
        `The due window ends at minute ${end}, past the ${durationMinutes}-minute scenario`,
      ),
    );
  }
}

function reportConsequences(
  edge: TeamDependencyEdge,
  path: string,
  byKey: ReadonlyMap<string, DependencyInjectRef>,
  injects: readonly DependencyInjectRef[],
  issues: DependencyIssue[],
): void {
  if (edge.consequence_keys.length === 0) {
    issues.push(
      issue(
        'MO-DEP-008',
        `${path}.consequence_keys`,
        `Dependency ${edge.id} has no consequence_keys`,
        'warning',
      ),
    );
  }
  edge.consequence_keys.forEach((key, keyIndex) => {
    const inject = byKey.get(key);
    if (!inject) {
      issues.push(
        issue(
          'MO-DEP-008',
          `${path}.consequence_keys[${keyIndex}]`,
          `Consequence ${key} is not in the scenario`,
          'warning',
        ),
      );
      return;
    }
    if (inject.conditional === false) {
      issues.push(
        issue(
          'MO-DEP-008',
          `${path}.consequence_keys[${keyIndex}]`,
          `Consequence ${key} is not conditional`,
          'warning',
        ),
      );
    }
  });
  const referenced = injects.some((inject) =>
    (inject.condition_keys ?? []).some((key) => referencesEdge(key, edge.id)),
  );
  if (!referenced) {
    issues.push(
      issue('MO-DEP-009', path, `No inject conditions on dependency ${edge.id}`, 'warning'),
    );
  }
}

export function prepareTeamDependencies(
  document: unknown,
  teams: readonly ActiveTeam[],
  injects: readonly InjectInput[],
  durationMinutes: number | null,
):
  | { ok: true; team_dependencies: TeamDependencies; issues: DependencyIssue[] }
  | { ok: false; issues: DependencyIssue[] } {
  const read = readDependencyEdges(document);
  if ('error' in read) {
    return { ok: false, issues: [issue('MO-DEP-001', 'team_dependencies', read.error)] };
  }
  const result = validateDependencies(read.edges, teams, injects, durationMinutes);
  const errors = result.issues.filter((item) => item.severity === 'error');
  if (errors.length > 0) return { ok: false, issues: result.issues };
  return {
    ok: true,
    team_dependencies: { v: 1, edges: result.edges },
    issues: result.issues,
  };
}
