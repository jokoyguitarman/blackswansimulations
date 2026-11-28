import { slugifyTeamName } from '@shared/conditionKeyGrammar';
import { isInjectKey } from '@shared/injectKeySlug';
import {
  dependencyIdInKey,
  fromEditorModel,
  uniqueDependencyId,
  type DependencyEditorModel,
  type DependencySource,
  type TeamDependencyEdge,
  type TeamRef,
} from '@shared/teamDependencies';

export interface DependencyEdgeInput {
  model: DependencyEditorModel;
  upstream: TeamRef | null;
  downstream: readonly TeamRef[];
  brokenKeys: readonly string[];
  brokenQuantifier: DependencyEditorModel['broken']['quantifier'];
  brokenThreshold: number;
  metKeys: readonly string[];
  metQuantifier: DependencyEditorModel['broken']['quantifier'];
  metThreshold: number;
  brokenError: string | null;
  metError: string | null;
  durationMinutes: number;
  takenIds: ReadonlySet<string>;
  source: DependencySource;
}

/** The drawer's save checks, with no React and no network. */
export function buildDependencyEdge(
  input: DependencyEdgeInput,
): { edge: TeamDependencyEdge } | { error: string } {
  const upstream = input.upstream;
  const downstream = [...input.downstream];
  if (!upstream) return { error: 'Choose the upstream team.' };
  if (downstream.length < 1 || downstream.length > 3) {
    return { error: 'Choose 1 to 3 downstream teams.' };
  }
  const identities = new Set(
    downstream.map((team) => team.team_uid || slugifyTeamName(team.team_name)),
  );
  if (identities.size !== downstream.length) return { error: 'Downstream teams must be distinct.' };
  const upstreamId = upstream.team_uid || slugifyTeamName(upstream.team_name);
  if (identities.has(upstreamId)) {
    return { error: 'A downstream team has to be different from the upstream team.' };
  }
  if (!input.model.deliverable.trim()) return { error: 'Name the deliverable.' };
  if (
    !Number.isInteger(input.model.lagMinutes) ||
    input.model.lagMinutes < 0 ||
    input.model.lagMinutes > 30
  ) {
    return { error: 'Lag must be a whole number from 0 to 30 minutes.' };
  }
  if (input.brokenError) return { error: input.brokenError };
  if (input.metError) return { error: input.metError };
  if (input.brokenKeys.length === 0) return { error: 'Add at least one break condition.' };
  if (input.brokenKeys.some((key) => dependencyIdInKey(key))) {
    return { error: 'A dependency cannot break on another dependency.' };
  }
  if (input.metKeys.some((key) => dependencyIdInKey(key))) {
    return { error: 'Resolved when cannot use a dependency key.' };
  }
  if (input.model.dueMode === 'by_minute') {
    if (!Number.isInteger(input.model.byMinute) || input.model.byMinute < 0) {
      return { error: 'Due minute must be a whole number.' };
    }
    if (input.durationMinutes > 0 && input.model.byMinute > input.durationMinutes) {
      return { error: `Due minute is past the ${input.durationMinutes}-minute scenario.` };
    }
  } else if (!isInjectKey(input.model.afterInjectKey)) {
    return { error: 'Choose the inject the due window starts after.' };
  }
  const id = input.model.id || uniqueDependencyId(input.model.deliverable, input.takenIds);
  return {
    edge: fromEditorModel({
      ...input.model,
      id,
      upstream,
      downstream,
      deliverable: input.model.deliverable.trim(),
      why: input.model.why.trim(),
      source: input.source,
      broken: {
        quantifier: input.brokenQuantifier,
        threshold: input.brokenQuantifier === 'at_least' ? input.brokenThreshold : 1,
        keys: [...input.brokenKeys],
      },
      met:
        input.metKeys.length === 0
          ? null
          : {
              quantifier: input.metQuantifier,
              threshold: input.metQuantifier === 'at_least' ? input.metThreshold : 1,
              keys: [...input.metKeys],
            },
    }),
  };
}
