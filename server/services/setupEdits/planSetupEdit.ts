import { loadSetupEditSource } from './deltaBuildContext.js';
import { recomputeSetupEdit } from './prepareSetupEditBuild.js';
import {
  activeResolutionTargets,
  type OrphanResolution,
  type RemapPlan,
  type RemapPlannerInput,
} from './remapPlanner.js';

export interface OrphanTargetLists {
  teams: string[];
  inject_keys: string[];
  org_keys: string[];
}

/**
 * Names the Review picker may offer. This is the planner's active-target set:
 * surviving teams, surviving inject keys, and post-swap protagonist org keys.
 */
export function orphanTargetLists(input: RemapPlannerInput, plan: RemapPlan): OrphanTargetLists {
  const active = activeResolutionTargets(input, plan);
  return {
    teams: [...active.teams].sort(),
    inject_keys: [...active.injectKeys].sort(),
    org_keys: [...active.orgKeys].sort(),
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
    targets: orphanTargetLists(
      {
        delta: recomputed.delta,
        edited: recomputed.edited,
        initial_state: source.remap.initial_state,
        teams: source.remap.teams,
        injects: source.remap.injects,
        sessions: source.remap.sessions,
        ...(request.resolutions ? { resolutions: request.resolutions } : {}),
      },
      recomputed.plan,
    ),
  };
}
