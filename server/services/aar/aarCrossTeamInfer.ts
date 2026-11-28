/**
 * Inferred cause-and-effect when a session has no trigger rows.
 * Condition keys go through the catalogue and the cross-team profile.
 */

import { isInjectKey } from '../../../shared/injectKeySlug.js';
import type {
  CrossTeamEdgeInput,
  CrossTeamTriggerInput,
  PublishedInjectInput,
} from '../../../shared/crossTeamAar.js';
import {
  collectConditionKeys,
  formatConditionLabel,
  parseConditionKey,
} from '../conditions/conditionCatalog.js';
import {
  crossTeamProfile,
  referencedInjectKeys,
  type CrossTeamTeam,
} from '../conditions/crossTeamCore.js';
import { dependencyIdFromKey } from '../dependencies/dependencyConditionsCore.js';

export function inferCrossTeamTriggers(
  injects: readonly PublishedInjectInput[],
  edges: readonly CrossTeamEdgeInput[],
  teams: readonly CrossTeamTeam[],
): CrossTeamTriggerInput[] {
  const known = new Set(
    injects.map((inject) => inject.inject_key).filter((key) => isInjectKey(key)),
  );
  const byConsequence = new Map<string, CrossTeamEdgeInput>();
  for (const edge of edges) {
    for (const key of edge.consequence_keys) byConsequence.set(key, edge);
  }
  const triggers: CrossTeamTriggerInput[] = [];
  for (const inject of injects) {
    if (!isInjectKey(inject.inject_key)) continue;
    const appearKeys = collectConditionKeys(inject.conditions_to_appear, null);
    const edge = byConsequence.get(inject.inject_key) ?? edgeForDependency(appearKeys, edges);
    const profile = crossTeamProfile({ target_teams: inject.target_teams }, appearKeys, teams);
    const source =
      profile.source_teams.length > 0 ? profile.source_teams : edge ? [edge.upstream] : [];
    if (!edge && !profile.is_cross_team) continue;
    triggers.push({
      inject_key: inject.inject_key,
      title: inject.title || inject.inject_key,
      minute:
        inject.trigger_time_minutes == null
          ? (inject.published_minute ?? null)
          : inject.trigger_time_minutes,
      origin: edge ? 'dependency' : 'conditional',
      source_teams: source,
      target_teams: inject.target_teams,
      dep_id: edge?.id ?? null,
      cause_depth: 1,
      parent_inject_keys: parentKeys(inject, known),
      signals: signalLabels(appearKeys),
    });
  }
  return triggers;
}

function edgeForDependency(
  appearKeys: readonly string[],
  edges: readonly CrossTeamEdgeInput[],
): CrossTeamEdgeInput | undefined {
  for (const key of appearKeys) {
    const depId = dependencyIdFromKey(key);
    if (!depId) continue;
    const edge = edges.find((item) => item.id === depId);
    if (edge) return edge;
  }
  return undefined;
}

function parentKeys(inject: PublishedInjectInput, known: ReadonlySet<string>): string[] {
  const parents: string[] = [];
  const keys = collectConditionKeys(inject.conditions_to_appear, inject.conditions_to_cancel);
  for (const key of keys) {
    for (const ref of referencedInjectKeys(key)) {
      if (
        !isInjectKey(ref) ||
        !known.has(ref) ||
        ref === inject.inject_key ||
        parents.includes(ref)
      ) {
        continue;
      }
      parents.push(ref);
    }
  }
  return parents;
}

/** Appear keys that name no inject. Their catalogue label is the signal. */
function signalLabels(appearKeys: readonly string[]): string[] {
  const labels: string[] = [];
  for (const key of appearKeys) {
    if (referencedInjectKeys(key).some((ref) => isInjectKey(ref))) continue;
    const parsed = parseConditionKey(key);
    if ('error' in parsed || parsed.def.id.startsWith('dependency_')) continue;
    const label = formatConditionLabel(parsed);
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}
