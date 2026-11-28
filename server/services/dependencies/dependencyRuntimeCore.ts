/**
 * Pure dependency transitions. Condition keys are evaluated through the
 * shared evaluator so a dependency and an inject see the same facts.
 */

import { applyAnySugar, expandPlaceholders, resolveTeamRef } from '../../../shared/teamDependencies.js';
import type { ActiveTeam, NormalizedConditions, TeamDependencyEdge } from '../../../shared/teamDependencies.js';
import { describeConditionKey, type EvaluationContext } from '../conditionEvaluatorService.js';
import {
  emptyDependencyState,
  type DependencyEvidence,
  type DependencyRuntimeState,
} from './dependencyConditionsCore.js';

export interface DependencyEvaluation {
  broken: boolean;
  met: boolean;
  evidence: DependencyEvidence[];
  /** Upstream team is gone. The edge never leaves its current status. */
  inert: boolean;
}

interface GroupOutcome {
  met: boolean;
  evidence: DependencyEvidence[];
}

function groupOf(group: NormalizedConditions | null | undefined): {
  kind: 'all' | 'threshold';
  keys: string[];
  threshold: number;
} | null {
  if (!group) return null;
  const normalized = applyAnySugar(group) as NormalizedConditions;
  if ('all' in normalized && Array.isArray(normalized.all)) {
    return { kind: 'all', keys: normalized.all, threshold: normalized.all.length };
  }
  if ('conditions' in normalized && Array.isArray(normalized.conditions)) {
    return {
      kind: 'threshold',
      keys: normalized.conditions,
      threshold: Math.max(1, normalized.threshold ?? 1),
    };
  }
  return null;
}

function keyOutcomes(
  key: string,
  ctx: EvaluationContext,
  upstream: string,
  downstream: readonly string[],
): GroupOutcome {
  const perTeam = key.includes('|team=@downstream');
  const names: Array<string | null> = perTeam ? [...downstream] : [null];
  if (perTeam && names.length === 0) return { met: false, evidence: [] };
  const evidence: DependencyEvidence[] = [];
  for (const name of names) {
    const expanded = expandPlaceholders(key, { upstream, downstream: name });
    if (expanded.includes('|team=@')) continue;
    const described = describeConditionKey(expanded, ctx);
    if (!described.met) continue;
    evidence.push({ key: expanded, detail: described.detail, minute: ctx.elapsedMinutes });
  }
  return { met: evidence.length > 0, evidence };
}

function groupOutcome(
  group: NormalizedConditions | null | undefined,
  ctx: EvaluationContext,
  upstream: string,
  downstream: readonly string[],
): GroupOutcome {
  const plan = groupOf(group);
  if (!plan || plan.keys.length === 0) return { met: false, evidence: [] };
  const results = plan.keys.map((key) => keyOutcomes(key, ctx, upstream, downstream));
  const metCount = results.filter((item) => item.met).length;
  const met = plan.kind === 'all' ? metCount === plan.keys.length : metCount >= plan.threshold;
  if (!met) return { met: false, evidence: [] };
  return { met: true, evidence: results.flatMap((item) => item.evidence) };
}

export function evaluateDependency(
  edge: TeamDependencyEdge,
  ctx: EvaluationContext,
  teams: readonly ActiveTeam[],
): DependencyEvaluation {
  const upstream = resolveTeamRef(edge.upstream, teams);
  if (!upstream) return { broken: false, met: false, evidence: [], inert: true };
  const downstream: string[] = [];
  for (const ref of edge.downstream) {
    const name = resolveTeamRef(ref, teams);
    if (name && !downstream.includes(name)) downstream.push(name);
  }
  const broken = groupOutcome(edge.broken_when, ctx, upstream, downstream);
  const met = groupOutcome(edge.met_when, ctx, upstream, downstream);
  return {
    broken: broken.met,
    met: met.met,
    evidence: [...met.evidence, ...broken.evidence],
    inert: false,
  };
}

/**
 * pending → met when met holds (met wins if both hold in the same tick);
 * pending → broken otherwise; broken → recovered once met. Waived, met and
 * recovered stay put. broken_minute is written only on the pending → broken step.
 */
export function nextState(
  current: DependencyRuntimeState | null,
  evaluation: DependencyEvaluation,
  elapsed: number,
): DependencyRuntimeState {
  const base = current ?? emptyDependencyState();
  if (evaluation.inert) return base;
  if (base.status === 'waived' || base.status === 'met' || base.status === 'recovered') return base;
  if (base.status === 'pending') {
    if (evaluation.met) return { ...base, status: 'met', met_minute: elapsed };
    if (evaluation.broken) return { ...base, status: 'broken', broken_minute: elapsed };
    return base;
  }
  if (base.status === 'broken' && evaluation.met) {
    return { ...base, status: 'recovered', recovered_minute: elapsed };
  }
  return base;
}
