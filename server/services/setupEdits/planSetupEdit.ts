import { injectKeyOf } from '../../lib/injectKey.js';
import { loadSetupEditSource } from './deltaBuildContext.js';
import { recomputeSetupEdit } from './prepareSetupEditBuild.js';
import type { OrphanResolution, RemapPlan } from './remapPlanner.js';
import type { SetupSnapshot } from './setupSnapshotCore.js';
import type { SetupEditBuildSource } from './prepareSetupEditBuild.js';

export interface OrphanTargetLists {
  teams: string[];
  inject_keys: string[];
  org_keys: string[];
}

/** Active names a Review picker may offer. Removed rows are left out. */
export function orphanTargetLists(
  source: SetupEditBuildSource,
  plan: RemapPlan,
  edited: SetupSnapshot,
): OrphanTargetLists {
  const removedTeams = new Set(
    plan.teams.retire.filter((team) => team.reason === 'removed').map((team) => team.team_uid),
  );
  const renamed = new Map(plan.teams.successors.map((team) => [team.team_uid, team.team_name]));
  const teams = new Set<string>();
  for (const team of source.remap.teams) {
    if (removedTeams.has(team.team_uid)) continue;
    const name = renamed.get(team.team_uid) ?? team.team_name;
    if (name) teams.add(name);
  }
  for (const org of edited.organisations) {
    for (const team of org.teams) if (team.team_name) teams.add(team.team_name);
  }
  const retiredInjects = new Set(plan.injects.retire.map((inject) => inject.inject_id));
  const injectKeys = new Set<string>();
  for (const inject of source.remap.injects) {
    if (retiredInjects.has(inject.id)) continue;
    const key = injectKeyOf(inject);
    if (key) injectKeys.add(key);
  }
  const orgKeys = new Set<string>();
  for (const org of edited.organisations) if (org.org_key) orgKeys.add(org.org_key);
  for (const org of edited.pressure_organisations) if (org.org_key) orgKeys.add(org.org_key);
  for (const org of edited.competitors) if (org.org_key) orgKeys.add(org.org_key);
  return {
    teams: [...teams].sort(),
    inject_keys: [...injectKeys].sort(),
    org_keys: [...orgKeys].sort(),
  };
}

export interface PlanSetupEditRequest {
  scenarioId: string;
  editId: string;
  resolutions?: Readonly<Record<string, OrphanResolution>>;
  /** Unsaved wizard input. Used for this response only; the draft row is not written. */
  draftInput?: unknown;
}

export type PlanSetupEditResult =
  | { ok: true; plan: RemapPlan; targets: OrphanTargetLists }
  | { ok: false; status: number; code: string; error: string };

/**
 * Dry-run of the remap plan for the open edit. No scenario or draft writes.
 * An open edit whose draft was never attached (a failed abandon) is reported
 * so the wizard can offer to abandon and start again.
 */
export async function planOpenSetupEdit(request: PlanSetupEditRequest): Promise<PlanSetupEditResult> {
  const loaded = await loadSetupEditSource(request.editId);
  if (!loaded.available) {
    return {
      ok: false,
      status: 404,
      code: 'SETUP_EDITS_UNAVAILABLE',
      error: 'Setup edits are not available until the migration is applied.',
    };
  }
  const source = loaded.source;
  if (!source || source.edit.scenario_id !== request.scenarioId) {
    return { ok: false, status: 404, code: 'SETUP_EDIT_NOT_FOUND', error: 'Setup edit not found' };
  }
  if (source.edit.status !== 'open') {
    return {
      ok: false,
      status: 409,
      code: 'SETUP_EDIT_NOT_OPEN',
      error: 'This setup edit is not open.',
    };
  }
  if (!source.edit.draft_id && request.draftInput === undefined) {
    return {
      ok: false,
      status: 409,
      code: 'SETUP_EDIT_NO_DRAFT',
      error: 'This edit has no draft. Abandon it and start again.',
    };
  }
  const recomputed = recomputeSetupEdit(source, {
    resolutions: request.resolutions,
    ...(request.draftInput !== undefined ? { draft_input: request.draftInput } : {}),
  });
  if (!recomputed.ok) return recomputed;
  return {
    ok: true,
    plan: recomputed.plan,
    targets: orphanTargetLists(source, recomputed.plan, recomputed.edited),
  };
}
