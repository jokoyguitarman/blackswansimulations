import { blankGenerated, type SetupEditStageOutput } from '../deltaBuildTypes.js';
import type { OrphanResolution, RemapPlan } from '../remapPlanner.js';
import type {
  MergeCurrent,
  MergeEdit,
  MergeInjectRow,
  MergeSetupEditInput,
  MergeTeamRow,
} from '../setupMergeCore.js';
import { snapshot, snapshotOrg, snapshotTeam } from './remapFixtures.js';
import type { SetupSnapshot } from '../setupSnapshotCore.js';

const ESCALATION = {
  max_steps: 1,
  steps: [{ after_minutes: 5, urgency: 'follow_up', app: 'same' }],
};

const MOOD = {
  recovery: 'none',
  rungs: [{ id: 'calm', when: {}, label: 'Calm' }],
};

const RUBRIC = { criteria: ['Acknowledge the caller'] };

export function emptyOutputs(): SetupEditStageOutput[] {
  return ['characters', 'storyline', 'convergence', 'pages'].map((stage) => ({
    stage,
    revisions: [],
    flags: [],
    generated: blankGenerated(),
    text_updates: [],
    narrative_update: null,
    objective_updates: [],
    setup_source_update: null,
    stakeholder_updates: [],
    brief_diff: null,
    swap_premise: null,
    skipped: true,
    personas: [],
    fact_sheet: { confirmed_facts: [], unconfirmed_claims: [] },
    communities: [],
    countries: [],
    injects: [],
    team_storylines: {},
    team_charters: [],
    stakeholders: [],
    stakeholder_injects: [],
    persona_twins: [],
    orgs: [],
    sop_steps: [],
    decision_context: { leakiness: 0, labour_signal: false, product_safety_signal: false },
    pressure_organisations: [],
    sharedInjects: [],
    convergenceGates: [],
    narrative: null,
    objectives: [],
    dimensionLabels: null,
    org_page: null,
    pressure_injects: [],
  }));
}

export function acmeSnapshot(teams = defaultTeams()): SetupSnapshot {
  return snapshot([
    snapshotOrg({
      org_uid: 'uid-acme',
      org_key: 'primary',
      display_name: 'Acme',
      short_name: 'ACME',
      country: 'Singapore',
      is_primary: true,
      teams,
    }),
  ]);
}

export function defaultTeams() {
  return [
    snapshotTeam({
      team_uid: 'uid-comms',
      team_name: 'Communications',
      function_key: 'Communications',
      description: 'Night desk',
      is_public_voice: true,
    }),
    snapshotTeam({
      team_uid: 'uid-legal',
      team_name: 'Legal',
      function_key: 'Legal',
      description: 'Counsel',
    }),
  ];
}

export function orgPage(orgKey: string, name: string, primary: boolean, uid = orgKey) {
  return {
    org_uid: uid,
    org_key: orgKey,
    display_name: name,
    is_primary: primary,
    role: 'protagonist',
    control_mode: 'player',
    facebook: { page_name: name, page_handle: `@${orgKey}`, page_bio: '', follower_count: 10 },
    x_twitter: { page_name: name, page_handle: `@${orgKey}`, page_bio: '', follower_count: 10 },
  };
}

export function baseState(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    country: 'Singapore',
    org_name: 'Acme',
    orgs: [
      {
        org_uid: 'uid-acme',
        org_key: 'primary',
        display_name: 'Acme',
        country: 'Singapore',
        kind: 'company',
        side: 'protagonist',
        is_primary: true,
        operation: 'players',
      },
    ],
    countries: [{ name: 'Singapore', code: 'SG' }],
    org_page: { orgs: [orgPage('primary', 'Acme', true, 'uid-acme')] },
    stakeholders: [],
    npc_personas: [],
    fact_sheet: { confirmed_facts: ['The warehouse fire started at dusk'], unconfirmed_claims: [] },
    player_roles: [{ role_id: 'cs_head', title: 'Head of Customer Service', team_name: 'Communications' }],
    call_coverage_gate: 'warn',
    ...extra,
  };
}

export function teamRow(partial: Partial<MergeTeamRow> & Pick<MergeTeamRow, 'id' | 'team_uid' | 'team_name'>): MergeTeamRow {
  return {
    team_description: '',
    required_roles: [],
    min_participants: 1,
    max_participants: 4,
    counter_definitions: null,
    is_investigative: false,
    charter: {
      function_key: partial.function_key ?? partial.team_name,
      is_custom: false,
      can_post_publicly: partial.team_name === 'Communications',
      mission: partial.team_name,
    },
    expected_actions: [],
    scoring_rubric: 'Be clear',
    org_key: 'primary',
    function_key: partial.function_key ?? partial.team_name,
    ...partial,
  };
}

export function injectRow(
  partial: Partial<MergeInjectRow> & Pick<MergeInjectRow, 'id'> & { inject_key: string },
): MergeInjectRow {
  const { inject_key: injectKey, delivery_config: config, ...rest } = partial;
  return {
    has_history: false,
    trigger_time_minutes: 20,
    trigger_condition: null,
    type: 'social_post',
    title: injectKey,
    content: 'The night shift reported smoke.',
    affected_roles: [],
    severity: 'medium',
    requires_response: false,
    ai_generated: true,
    inject_scope: 'universal',
    target_teams: [],
    requires_coordination: false,
    triggered_by_user_id: null,
    required_gate_id: null,
    required_gate_not_met_id: null,
    conditions_to_appear: null,
    conditions_to_cancel: null,
    eligible_after_minutes: null,
    objective_penalty: null,
    state_effect: null,
    generation_source: 'war_room',
    response_type: null,
    ...rest,
    delivery_config: {
      inject_key: injectKey,
      app: 'email',
      escalation: ESCALATION,
      mood_ladder: MOOD,
      response_rubric: RUBRIC,
      ...(config ?? {}),
    },
  };
}

export function emptyPlan(partial: Partial<RemapPlan> = {}): RemapPlan {
  return {
    teams: { retire: [], successors: [] },
    injects: { rewrite_in_place: [], cow: [], retire: [] },
    initial_state: { patch: [], move_to_retired: [] },
    scheduled_sessions: [],
    orphans: [],
    warnings: [],
    applicable: true,
    phases: [],
    primary_swap: null,
    vacated_countries: [],
    ...partial,
  };
}

export function applyInput(partial: {
  current?: MergeCurrent;
  plan?: RemapPlan;
  outputs?: SetupEditStageOutput[];
  edit?: Partial<MergeEdit>;
  resolutions?: Readonly<Record<string, OrphanResolution>>;
} = {}): MergeSetupEditInput {
  const baseline = partial.edit?.baseline ?? acmeSnapshot();
  const current = partial.current ?? {
    scenario: {
      title: 'Warehouse fire',
      description: 'Smoke in the loading bay',
      briefing: 'The warehouse is burning',
      category: 'social_media_crisis',
      difficulty: 'intermediate',
      duration_minutes: 60,
      initial_state: baseState(),
      objectives: [],
    },
    teams: [
      teamRow({ id: 'team-comms', team_uid: 'uid-comms', team_name: 'Communications', team_description: 'Night desk' }),
      teamRow({ id: 'team-legal', team_uid: 'uid-legal', team_name: 'Legal', function_key: 'Legal', team_description: 'Counsel' }),
    ],
    injects: [injectRow({ id: 'inj-plant', inject_key: 'plant_update' })],
  };
  return {
    current,
    plan: partial.plan ?? emptyPlan(),
    buildOutputs: partial.outputs ?? emptyOutputs(),
    edit: {
      id: partial.edit?.id ?? 'edit-1',
      baseline,
      edited: partial.edit?.edited ?? baseline,
      opened: partial.edit?.opened,
    },
    resolutions: partial.resolutions,
  };
}

export { ESCALATION, MOOD, RUBRIC };
