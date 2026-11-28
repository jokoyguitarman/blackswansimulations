export interface OrphanChoiceInput {
  choice: string;
  inject_key?: string;
  team_name?: string;
  org_keys?: string[];
}

/** What a complete retarget or reassign must name. Null when the choice needs no target. */
export type OrphanTargetField = 'team_name' | 'inject_key' | 'org_keys';

export interface OrphanRef {
  id: string;
  kind: string;
  /** Set when the orphan is a condition scope, including a team-dependency condition. */
  condition_key?: string;
  /** Set when the orphan points at a retired inject key. */
  target_key?: string;
}

export interface OrphanCatalogs {
  teams: readonly string[];
  injectKeys: readonly string[];
  orgKeys: readonly string[];
}

/** The planner lists `retire_inject`; the route and `resolutionApplies` accept `retire`. */
export function canonicalOrphanChoice(choice: string): string {
  return choice === 'retire_inject' ? 'retire' : choice;
}

const TARGETED = new Set(['retarget', 'reassign']);

/**
 * The picker for one orphan and one choice. Team-dependency condition orphans
 * and team-scoped conditions use a team. Inject references use an inject key.
 * Pressure groups use organisation keys. A choice with no target returns null.
 */
export function orphanTargetField(orphan: OrphanRef, choice: string): OrphanTargetField | null {
  const canonical = canonicalOrphanChoice(choice);
  if (!TARGETED.has(canonical)) return null;
  switch (orphan.kind) {
    case 'player_role':
    case 'stakeholder':
      return canonical === 'reassign' ? 'team_name' : null;
    case 'pressure_targets':
      return canonical === 'retarget' ? 'org_keys' : null;
    case 'mood_consequence':
      return canonical === 'retarget' ? 'inject_key' : null;
    case 'condition':
    case 'chain_target':
      if (canonical !== 'retarget') return null;
      return orphan.target_key ? 'inject_key' : 'team_name';
    case 'team_dependency':
      if (canonical === 'reassign' || orphan.condition_key) return 'team_name';
      if (orphan.target_key) return 'inject_key';
      return null;
    default:
      return null;
  }
}

export function orphanChoiceLabel(choice: string): string {
  return choice.replaceAll('_', ' ');
}

/**
 * A decision the server will accept. Incomplete choices, including a target
 * that is not in the active catalog, return null so the UI does not re-plan.
 */
export function completeOrphanDecision(
  orphan: OrphanRef,
  choice: string,
  target: { team_name?: string; inject_key?: string; org_keys?: readonly string[] },
  catalogs: OrphanCatalogs,
): OrphanChoiceInput | null {
  const trimmed = choice.trim();
  if (!trimmed) return null;
  const canonical = canonicalOrphanChoice(trimmed);
  const field = orphanTargetField(orphan, canonical);
  if (!field) return { choice: canonical };
  if (field === 'team_name') {
    const name = target.team_name?.trim() ?? '';
    if (!catalogs.teams.includes(name)) return null;
    return { choice: canonical, team_name: name };
  }
  if (field === 'inject_key') {
    const key = target.inject_key?.trim() ?? '';
    if (!catalogs.injectKeys.includes(key)) return null;
    return { choice: canonical, inject_key: key };
  }
  const keys = (target.org_keys ?? []).filter((key) => catalogs.orgKeys.includes(key));
  if (keys.length === 0) return null;
  return { choice: canonical, org_keys: [...keys] };
}

/** Apply waits for a fresh plan with no orphans left. A missing plan is not ready. */
export function applyBlockedByPlan(input: {
  plan: { applicable?: boolean; orphans?: readonly unknown[] } | null;
  planning: boolean;
}): boolean {
  if (input.planning || !input.plan) return true;
  if ((input.plan.orphans?.length ?? 0) > 0) return true;
  return input.plan.applicable === false;
}
