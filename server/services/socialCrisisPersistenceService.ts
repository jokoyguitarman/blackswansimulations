import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import type { SocialCrisisPayload } from './socialCrisisGeneratorService.js';
import type { TeamCharter } from './teamCharterService.js';
import { functionKeyForTeamRow } from './scenarioOrgModel.js';
import { validateScenarioPayload } from './scenarioValidationService.js';
import { retainKnownConditions } from './conditions/conditionCatalog.js';
import { stampGeneratedInjectKeys } from '../lib/injectKey.js';
import { applyInjectGenStamp } from '../lib/injectFingerprint.js';
import { stampOrgIdentity } from '../lib/templateRows.js';

const VALID_INJECT_SCOPES = ['universal', 'role_specific', 'team_specific'];
const VALID_SEVERITIES = ['low', 'medium', 'high', 'critical'];

function sanitizeScope(scope: string | undefined): string {
  if (scope && VALID_INJECT_SCOPES.includes(scope)) return scope;
  return 'universal';
}

function sanitizeSeverity(severity: string | undefined): string {
  if (severity && VALID_SEVERITIES.includes(severity)) return severity;
  return 'medium';
}

/**
 * Validate an inject's team targeting against the scenario's team names.
 * Unknown team references are downgraded to universal (with a warning) so
 * content is never silently undeliverable at runtime.
 * (Also used by the trainer inject-edit endpoints in routes/scenarios.ts.)
 */
export function sanitizeTeamTargeting(
  inj: { inject_scope?: string; target_teams?: string[]; title?: string },
  validTeamNames: Set<string>,
): { inject_scope: string; target_teams: string[] } {
  const scope = sanitizeScope(inj.inject_scope);
  const targets = inj.target_teams || [];

  if (scope !== 'team_specific') return { inject_scope: scope, target_teams: targets };

  const known = targets.filter((t) => validTeamNames.has(t));
  if (known.length === 0) {
    logger.warn(
      { title: inj.title, target_teams: targets },
      'Inject targets unknown team(s); downgrading to universal',
    );
    return { inject_scope: 'universal', target_teams: [] };
  }
  if (known.length < targets.length) {
    logger.warn(
      { title: inj.title, dropped: targets.filter((t) => !validTeamNames.has(t)) },
      'Inject referenced unknown team name(s); dropped',
    );
  }
  return { inject_scope: 'team_specific', target_teams: known };
}

/** Charter as produced by the generator: runtime shape plus optional organisation identity (contract §5.2). */
export type PersistableTeamCharter = TeamCharter & {
  org_key?: string | null;
  function_key?: string | null;
};

export { functionKeyForTeamRow };

// Postgres says "column X does not exist"; PostgREST says "Could not find the 'X' column ... in the schema cache".
const MISSING_ORG_COLUMN =
  /(column .*(org_key|function_key).* does not exist|could not find the '(org_key|function_key)' column)/i;
const MISSING_TEAM_UID_COLUMN =
  /(column .*team_uid.* does not exist|could not find the 'team_uid' column)/i;

export const MIGRATION_197_HINT =
  'migration 197 (scenario_teams.org_key/function_key) must be applied before multi-organisation scenarios can be compiled';

let teamUidColumnWarned = false;

/**
 * Insert scenario_teams rows carrying org_key/function_key (migration 197) and,
 * when the caller set it, team_uid (migration 275). A missing optional column is
 * stripped and the insert retried. Multi-org rows still refuse to drop org_key.
 * `dropped` receives column names that were removed so the caller can avoid
 * citing a team_uid the table did not store.
 */
export async function insertTeamRowsWithOrgColumns(
  rows: Array<Record<string, unknown> & { org_key: string | null; function_key: string | null }>,
  scenarioId: string,
  dropped?: Set<string>,
): Promise<string | null> {
  let payload = rows.map((row) => ({ ...row }));
  let lastMessage = 'scenario_teams insert failed';
  for (let attempt = 0; attempt < 4; attempt++) {
    const { error } = await supabaseAdmin.from('scenario_teams').insert(payload);
    if (!error) return null;
    lastMessage = error.message;

    if (MISSING_TEAM_UID_COLUMN.test(error.message) && payload.some((row) => 'team_uid' in row)) {
      if (!teamUidColumnWarned) {
        teamUidColumnWarned = true;
        logger.warn(
          { scenarioId, event: 'team_uid_column_unavailable' },
          'scenario_teams.team_uid is absent because migration 275 is not applied; teams were inserted without it',
        );
      }
      dropped?.add('team_uid');
      payload = payload.map((row) => {
        const rest: Record<string, unknown> = { ...row };
        delete rest.team_uid;
        return rest as typeof row;
      });
      continue;
    }

    if (MISSING_ORG_COLUMN.test(error.message) && payload.some((row) => 'org_key' in row || 'function_key' in row)) {
      if (payload.some((row) => row.org_key != null)) {
        return `${error.message} — ${MIGRATION_197_HINT}`;
      }
      logger.error(
        { scenarioId },
        'MIGRATION 197 NOT APPLIED: scenario_teams.org_key/function_key missing — inserting teams without organisation identity. Apply migrations/197_scenario_teams_org_function.sql.',
      );
      payload = payload.map((row) => {
        const rest: Record<string, unknown> = { ...row };
        delete rest.org_key;
        delete rest.function_key;
        return rest as typeof row;
      });
      continue;
    }

    return error.message;
  }
  return lastMessage;
}

export async function persistSocialCrisisScenario(
  payload: SocialCrisisPayload,
  createdBy: string,
  teamCharters?: PersistableTeamCharter[],
): Promise<string> {
  const { scenario, teams, objectives, sop, time_injects, condition_injects, decision_injects } =
    payload;

  // Contract §9 acceptance checklist: fail loudly BEFORE any row is written.
  validateScenarioPayload(payload, teamCharters ?? []);
  const initialState = stampOrgIdentity(scenario.initial_state);

  const { data: scenarioRow, error: scenarioErr } = await supabaseAdmin
    .from('scenarios')
    .insert({
      title: scenario.title,
      description: scenario.description,
      briefing: scenario.briefing,
      category: scenario.category,
      difficulty: scenario.difficulty,
      duration_minutes: scenario.duration_minutes,
      objectives: objectives.map((o) => o.objective_name),
      initial_state: initialState,
      blueprint: initialState.blueprint ?? null,
      created_by: createdBy,
    })
    .select('id')
    .single();

  if (scenarioErr || !scenarioRow) {
    logger.error({ error: scenarioErr }, 'Failed to insert social crisis scenario');
    throw new Error(`Scenario insert failed: ${scenarioErr?.message || 'no data'}`);
  }

  const scenarioId = scenarioRow.id;

  const validTeamNames = new Set(teams.map((t) => t.team_name));
  const teamUidByName = new Map<string, string>();
  let persistTeamUid = false;

  try {
    if (teams.length > 0) {
      const charterByName = new Map<string, PersistableTeamCharter>(
        (teamCharters || []).map((c) => [c.team_name, c]),
      );
      const teamRows = teams.map((t) => {
        const charter = charterByName.get(t.team_name);
        const teamUid = randomUUID();
        teamUidByName.set(t.team_name, teamUid);
        return {
          scenario_id: scenarioId,
          team_uid: teamUid,
          team_name: t.team_name,
          team_description: t.team_description,
          required_roles: [],
          min_participants: t.min_participants,
          max_participants: t.max_participants,
          // Contract §5.2 — organisation identity (null = single-org / spans all).
          org_key: charter?.org_key ?? null,
          function_key: functionKeyForTeamRow(t.team_name, charter),
          charter: charter
            ? {
                mission: charter.mission,
                responsibilities: charter.responsibilities,
                out_of_lane: charter.out_of_lane,
                is_custom: !!charter.is_custom,
                can_post_publicly: !!charter.can_post_publicly,
                sentiment_dimension: charter.sentiment_dimension || 'public_trust',
              }
            : null,
          expected_actions: charter ? charter.expected_actions : null,
          scoring_rubric: charter ? charter.scoring_rubric : null,
        };
      });
      const droppedTeamColumns = new Set<string>();
      const teamsErr = await insertTeamRowsWithOrgColumns(teamRows, scenarioId, droppedTeamColumns);
      if (teamsErr) throw new Error(`scenario_teams: ${teamsErr}`);
      persistTeamUid = !droppedTeamColumns.has('team_uid');
    }

    if (objectives.length > 0) {
      const validObjectives = objectives.filter((o) => o.objective_name);
      if (validObjectives.length > 0) {
        const { error: objErr } = await supabaseAdmin.from('scenario_objectives').insert(
          validObjectives.map((o) => ({
            scenario_id: scenarioId,
            objective_id: o.objective_id || o.objective_name.toLowerCase().replace(/\s+/g, '_'),
            objective_name: o.objective_name,
            description: o.description || '',
            weight: o.weight || 25,
            success_criteria: o.success_criteria || {},
          })),
        );
        if (objErr) throw new Error(`scenario_objectives: ${objErr.message}`);
      }
    }

    if (sop) {
      const { error: sopErr } = await supabaseAdmin.from('sop_definitions').insert({
        scenario_id: scenarioId,
        sop_name: sop.sop_name,
        description: sop.description,
        steps: sop.steps,
        response_time_limit_minutes: sop.response_time_limit_minutes,
        content_guidelines: sop.content_guidelines,
      });
      if (sopErr) logger.warn({ error: sopErr }, 'SOP insert failed (non-critical)');
    }

    const allInjects = [
      ...time_injects.map((inj) => ({
        scenario_id: scenarioId,
        trigger_time_minutes: inj.trigger_time_minutes ?? null,
        type: inj.type || 'social_post',
        title: inj.title,
        content: inj.content,
        severity: sanitizeSeverity(inj.severity),
        ...sanitizeTeamTargeting(inj, validTeamNames),
        requires_response: inj.requires_response || false,
        delivery_config: inj.delivery_config || null,
        conditions_to_appear: null,
        conditions_to_cancel: null,
        eligible_after_minutes: null,
        state_effect: inj.state_effect || null,
        ai_generated: true,
        generation_source: 'war_room',
        gen_layer: inj.gen_layer,
      })),
      ...condition_injects.flatMap((inj) => {
        const retained = retainKnownConditions(inj.conditions_to_appear, inj.conditions_to_cancel);
        for (const key of retained.dropped) {
          logger.warn(
            { event: 'generated_unknown_condition_key', key, title: inj.title },
            'Dropping unknown condition key from generated inject',
          );
        }
        if (retained.emptied) {
          logger.warn(
            { event: 'generated_inject_dropped_empty_conditions', title: inj.title },
            'Dropping generated inject whose conditions were all unknown',
          );
          return [];
        }
        return [
          {
            scenario_id: scenarioId,
            trigger_time_minutes: null,
            type: inj.type || 'social_post',
            title: inj.title,
            content: inj.content,
            severity: sanitizeSeverity(inj.severity),
            ...sanitizeTeamTargeting(inj, validTeamNames),
            requires_response: inj.requires_response || false,
            delivery_config: inj.delivery_config || null,
            conditions_to_appear: retained.conditions_to_appear,
            conditions_to_cancel: retained.conditions_to_cancel,
            eligible_after_minutes: inj.eligible_after_minutes || null,
            state_effect: inj.state_effect || null,
            ai_generated: true,
            generation_source: 'war_room',
            gen_layer: inj.gen_layer,
          },
        ];
      }),
      ...decision_injects.map((inj) => ({
        scenario_id: scenarioId,
        trigger_time_minutes: null,
        trigger_condition: inj.trigger_condition || null,
        type: inj.type || 'social_post',
        title: inj.title,
        content: inj.content,
        severity: sanitizeSeverity(inj.severity),
        ...sanitizeTeamTargeting(inj, validTeamNames),
        requires_response: false,
        delivery_config: inj.delivery_config || null,
        ai_generated: true,
        generation_source: 'war_room',
        gen_layer: inj.gen_layer,
      })),
    ];

    const stampedInjects = stampGeneratedInjectKeys(allInjects).map((row) =>
      applyInjectGenStamp(row, { teamUidByName, persistTeamUid }),
    );
    if (stampedInjects.length > 0) {
      const { error: injectsErr } = await supabaseAdmin
        .from('scenario_injects')
        .insert(stampedInjects);
      if (injectsErr) throw new Error(`scenario_injects: ${injectsErr.message}`);
    }

    logger.info(
      {
        scenarioId,
        teams: teams.length,
        objectives: objectives.length,
        injects: allInjects.length,
        hasResearchGuidelines: !!scenario.initial_state.research_guidelines,
      },
      'Social crisis scenario V2 persisted successfully',
    );

    return scenarioId;
  } catch (err) {
    logger.error({ err, scenarioId }, 'Social crisis persistence failed, rolling back scenario');
    await supabaseAdmin.from('scenarios').delete().eq('id', scenarioId);
    throw err;
  }
}
