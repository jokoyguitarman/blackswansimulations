import type { SetupDelta } from '../setupDeltaCore.js';
import type { SetupSnapshot, SnapshotOrg, SnapshotTeam } from '../setupSnapshotCore.js';
import type {
  LobbySession,
  PlannerInject,
  PlannerTeam,
  RemapPlannerInput,
} from '../remapPlanner.js';

export function delta(partial: Partial<SetupDelta> = {}): SetupDelta {
  return {
    added_orgs: [],
    added_teams: [],
    added_pressure: [],
    added_rivals: [],
    removed_orgs: [],
    removed_teams: [],
    removed_pressure: [],
    removed_rivals: [],
    renamed_orgs: [],
    renamed_teams: [],
    relocated_orgs: [],
    changed_text: [],
    primary_swap: null,
    brief_changed: false,
    new_countries: [],
    vacated_countries: [],
    becomes_multi_org: false,
    empty: false,
    ...partial,
  };
}

export function team(
  partial: Partial<PlannerTeam> & Pick<PlannerTeam, 'id' | 'team_uid' | 'team_name'>,
): PlannerTeam {
  return {
    org_key: partial.org_key ?? 'primary',
    function_key: partial.function_key ?? partial.team_name,
    team_description: partial.team_description ?? '',
    charter: partial.charter ?? null,
    expected_actions: partial.expected_actions ?? null,
    scoring_rubric: partial.scoring_rubric ?? null,
    ...partial,
  };
}

export function inject(
  partial: Partial<PlannerInject> & Pick<PlannerInject, 'id'> & { inject_key: string },
): PlannerInject {
  const { inject_key: injectKey, delivery_config: config, ...rest } = partial;
  return {
    title: rest.title ?? injectKey,
    content: rest.content ?? '',
    target_teams: rest.target_teams ?? [],
    has_history: rest.has_history ?? false,
    generation_source: rest.generation_source ?? 'war_room',
    ...rest,
    delivery_config: { inject_key: injectKey, ...(config ?? {}) },
  };
}

export function emptySession(
  partial: Partial<LobbySession> & Pick<LobbySession, 'session_id'>,
): LobbySession {
  return {
    status: 'scheduled',
    start_time: null,
    teams: [],
    channels: [],
    call_lines: [],
    call_takers: [],
    role_assignments: [],
    page_controllers: [],
    org_pages: [],
    ...partial,
  };
}

export function snapshotOrg(
  partial: Partial<SnapshotOrg> & Pick<SnapshotOrg, 'org_uid' | 'org_key' | 'display_name'>,
): SnapshotOrg {
  return {
    short_name: partial.short_name ?? 'ORG',
    country: partial.country ?? 'Singapore',
    kind: partial.kind ?? 'company',
    operation: partial.operation ?? 'players',
    is_primary: partial.is_primary ?? false,
    teams: partial.teams ?? [],
    ...partial,
  };
}

export function snapshotTeam(
  partial: Partial<SnapshotTeam> & Pick<SnapshotTeam, 'team_uid' | 'team_name'>,
): SnapshotTeam {
  return {
    function_key: partial.function_key ?? partial.team_name,
    description: partial.description ?? '',
    is_custom: partial.is_custom ?? false,
    is_public_voice: partial.is_public_voice ?? false,
    ...partial,
  };
}

export function snapshot(orgs: SnapshotOrg[], partial: Partial<SetupSnapshot> = {}): SetupSnapshot {
  return {
    crisis: {
      crisis_type: 'Plant fire',
      context: 'Night shift',
      uploaded_doc_name: null,
      uploaded_doc_text_hash: null,
      country: 'Singapore',
      org_name: 'Acme',
      duration: 60,
      auto_antagonist: true,
    },
    organisations: orgs,
    pressure_organisations: partial.pressure_organisations ?? [],
    competitors: partial.competitors ?? [],
    inject_keys: partial.inject_keys ?? [],
    multi_org: orgs.length > 1,
    ...partial,
  };
}

export function input(
  partial: Partial<RemapPlannerInput> & Pick<RemapPlannerInput, 'delta' | 'edited'>,
): RemapPlannerInput {
  return {
    initial_state: partial.initial_state ?? {},
    teams: partial.teams ?? [],
    injects: partial.injects ?? [],
    sessions: partial.sessions ?? [],
    ...partial,
  };
}
