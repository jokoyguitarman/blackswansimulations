import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/canonicalJson.js';
import type { BuildRequest } from '../warroomBuild/buildTypes.js';
import { planRemap, type RemapPlan } from './remapPlanner.js';
import type { RemapState } from './remapPlanLoader.js';
import { computeDelta, type SetupDelta } from './setupDeltaCore.js';
import {
  snapshotFromDraftInput,
  type SetupSnapshot,
} from './setupSnapshotCore.js';

export function hashPlan(plan: RemapPlan): string {
  return createHash('sha256').update(canonicalJson(plan)).digest('hex');
}

export interface SetupEditBuildSource {
  edit: {
    id: string;
    scenario_id: string;
    status: string;
    draft_id: string | null;
    baseline: unknown;
    edit_number: number | null;
  };
  draft_input: unknown;
  remap: RemapState;
}

export type PreparedSetupEdit =
  | { ok: true; request: BuildRequest; delta: SetupDelta; plan: RemapPlan }
  | { ok: false; status: number; code: string; error: string };

/**
 * Recomputes the delta and the remap plan from the frozen baseline and the
 * draft. The client's delta and plan hash are ignored.
 */
export function prepareSetupEditRequest(
  source: SetupEditBuildSource,
  request: BuildRequest,
): PreparedSetupEdit {
  const baseline = asSnapshot(source.edit.baseline);
  if (!baseline) {
    return {
      ok: false,
      status: 409,
      code: 'SETUP_EDIT_NOT_READY',
      error: 'This edit has no baseline yet.',
    };
  }
  const edited = snapshotFromDraftInput(source.draft_input, baseline);
  const delta = computeDelta(baseline, edited);
  if (delta.empty) {
    return {
      ok: false,
      status: 400,
      code: 'SETUP_EDIT_EMPTY',
      error: 'This edit does not change the setup.',
    };
  }
  const plan = planRemap({
    delta,
    edited,
    initial_state: source.remap.initial_state,
    teams: source.remap.teams,
    injects: source.remap.injects,
    sessions: source.remap.sessions,
  });
  const overlay = requestFromSnapshot(request, edited);
  return {
    ok: true,
    delta,
    plan,
    request: {
      ...overlay,
      mode: 'setup_edit',
      setup_edit_id: source.edit.id,
      delta,
      plan_hash: hashPlan(plan),
    },
  };
}

export function requestFromSnapshot(request: BuildRequest, edited: SetupSnapshot): BuildRequest {
  const primary = edited.organisations.find((org) => org.is_primary) ?? edited.organisations[0];
  return {
    ...request,
    crisis_type: edited.crisis.crisis_type || request.crisis_type,
    context: edited.crisis.context,
    country: primary?.country || edited.crisis.country || request.country,
    org_name: primary?.display_name || edited.crisis.org_name,
    duration: edited.crisis.duration ?? request.duration,
    auto_antagonist: edited.crisis.auto_antagonist,
    organisations: edited.organisations.map((org) => ({
      org_key: org.org_key,
      display_name: org.display_name,
      short_name: org.short_name || undefined,
      country: org.country,
      city: org.city,
      kind: kindOf(org.kind),
      facebook_handle: org.facebook_handle,
      x_handle: org.x_handle,
      is_primary: org.is_primary,
      operation: org.operation,
      team_roster: org.teams.map((team) => ({
        team_name: team.team_name,
        description: team.description,
        is_custom: team.is_custom,
        is_public_voice: team.is_public_voice,
      })),
    })),
    competitors: edited.competitors
      .filter((rival) => !rival.auto_generated)
      .map((rival) => ({
        name: rival.name,
        country: rival.country,
        org_key: rival.org_key,
        description: rival.description,
        facebook_handle: rival.facebook_handle,
        x_handle: rival.x_handle,
      })),
    pressure_organisations: edited.pressure_organisations.map((org) => ({
      org_key: org.org_key,
      display_name: org.display_name,
      kind: pressureKind(org.kind),
      country: org.country,
      city: org.city,
      register: pressureRegister(org.register),
      wants: org.wants,
      facebook_handle: org.facebook_handle,
      x_handle: org.x_handle,
      targets_org_keys: org.targets_org_keys,
    })),
  };
}

function asSnapshot(value: unknown): SetupSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<SetupSnapshot>;
  if (!Array.isArray(row.organisations) || row.organisations.length === 0) return null;
  if (!row.crisis || typeof row.crisis !== 'object') return null;
  return value as SetupSnapshot;
}

function kindOf(kind: string): 'company' | 'office' | 'agency' | 'ngo' | 'other' {
  if (kind === 'office' || kind === 'agency' || kind === 'ngo' || kind === 'other' || kind === 'company') {
    return kind;
  }
  return 'other';
}

function pressureKind(
  kind: string | undefined,
): 'union' | 'regulator' | 'ngo' | 'community_group' | 'political' {
  if (
    kind === 'union' ||
    kind === 'regulator' ||
    kind === 'ngo' ||
    kind === 'community_group' ||
    kind === 'political'
  ) {
    return kind;
  }
  return 'ngo';
}

function pressureRegister(
  register: string | undefined,
): 'statutory' | 'advocacy' | 'grassroots' | 'political' | undefined {
  if (
    register === 'statutory' ||
    register === 'advocacy' ||
    register === 'grassroots' ||
    register === 'political'
  ) {
    return register;
  }
  return undefined;
}
