/**
 * Loads the teams and template injects a dependency save is checked against.
 * Team reads go through activeTeams so retired rows stay out.
 */

import { logger } from '../../lib/logger.js';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { activeTeams, activeTemplateInjects } from '../../lib/templateRows.js';
import { collectConditionKeys } from '../conditions/conditionCatalog.js';
import { isInjectKey } from '../../../shared/injectKeySlug.js';
import {
  prepareTeamDependencies,
  toActiveTeams,
  type DependencyInjectRef,
  type DependencyIssue,
  type OrgOperationRow,
} from './dependencyCore.js';

const MISSING_TEAM_UID =
  /column .*team_uid.* does not exist|could not find the 'team_uid' column/i;

let teamUidColumnWarned = false;

function isMissingTeamUid(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const message = error.message ?? '';
  if (MISSING_TEAM_UID.test(message)) return true;
  return (error.code === '42703' || error.code === 'PGRST204') && /team_uid/i.test(message);
}

function warnTeamUidMissing(): void {
  if (teamUidColumnWarned) return;
  teamUidColumnWarned = true;
  logger.warn(
    { event: 'team_uid_column_unavailable' },
    'scenario_teams.team_uid is absent because migration 275 is not applied; dependency checks fall back to team names',
  );
}

function orgsOf(initialState: unknown): OrgOperationRow[] {
  if (!initialState || typeof initialState !== 'object') return [];
  const orgs = (initialState as { orgs?: unknown }).orgs;
  if (!Array.isArray(orgs)) return [];
  return orgs.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const row = raw as { org_key?: unknown; operation?: unknown };
    return [
      {
        org_key: typeof row.org_key === 'string' ? row.org_key : null,
        operation: typeof row.operation === 'string' ? row.operation : null,
      },
    ];
  });
}

async function loadTeamRows(scenarioId: string): Promise<
  | { rows: Record<string, unknown>[] }
  | { error: string }
> {
  const withUid = await activeTeams(
    supabaseAdmin
      .from('scenario_teams')
      .select('team_uid, team_name, org_key')
      .eq('scenario_id', scenarioId)
      .order('team_name', { ascending: true }),
  );
  if (withUid.error && isMissingTeamUid(withUid.error)) {
    warnTeamUidMissing();
    const plain = await activeTeams(
      supabaseAdmin
        .from('scenario_teams')
        .select('team_name, org_key')
        .eq('scenario_id', scenarioId)
        .order('team_name', { ascending: true }),
    );
    if (plain.error) return { error: plain.error.message };
    return { rows: (plain.data ?? []) as Record<string, unknown>[] };
  }
  if (withUid.error) return { error: withUid.error.message };
  return { rows: (withUid.data ?? []) as Record<string, unknown>[] };
}

async function loadInjectRefs(scenarioId: string): Promise<DependencyInjectRef[] | { error: string }> {
  const { data, error } = await activeTemplateInjects(
    supabaseAdmin
      .from('scenario_injects')
      .select('trigger_time_minutes, conditions_to_appear, conditions_to_cancel, delivery_config')
      .eq('scenario_id', scenarioId)
      .is('session_id', null),
  );
  if (error) return { error: error.message };
  const refs: DependencyInjectRef[] = [];
  for (const row of data ?? []) {
    const config = row.delivery_config as { inject_key?: unknown } | null;
    const key = config?.inject_key;
    if (typeof key !== 'string' || !isInjectKey(key)) continue;
    const conditionKeys = collectConditionKeys(row.conditions_to_appear, row.conditions_to_cancel);
    const timed = typeof row.trigger_time_minutes === 'number';
    refs.push({
      inject_key: key,
      trigger_time_minutes: timed ? row.trigger_time_minutes : null,
      conditional: !timed && conditionKeys.length > 0,
      condition_keys: conditionKeys,
    });
  }
  return refs;
}

/** Active teams for a scenario. Retired rows stay out. Missing team_uid falls back to names. */
export async function loadScenarioTeams(
  scenarioId: string,
): Promise<{ teams: ReturnType<typeof toActiveTeams> } | { error: string }> {
  const loaded = await loadTeamRows(scenarioId);
  if ('error' in loaded) return loaded;
  return {
    teams: toActiveTeams(
      loaded.rows.map((row) => ({
        team_uid: typeof row.team_uid === 'string' ? row.team_uid : null,
        team_name: typeof row.team_name === 'string' ? row.team_name : null,
        org_key: typeof row.org_key === 'string' ? row.org_key : null,
      })),
    ),
  };
}

export async function normalizeScenarioDependencies(
  scenarioId: string,
  initialState: Record<string, unknown>,
  durationMinutes: number | null,
): Promise<{ initialState: Record<string, unknown> } | { issues: DependencyIssue[] }> {
  if (!Object.prototype.hasOwnProperty.call(initialState, 'team_dependencies')) {
    return { initialState };
  }
  if (initialState.team_dependencies == null) return { initialState };

  const teams = await loadTeamRows(scenarioId);
  if ('error' in teams) {
    logger.error({ scenarioId, error: teams.error }, 'Failed to load teams for dependency validation');
    throw new Error('Failed to load teams for dependency validation');
  }
  const injects = await loadInjectRefs(scenarioId);
  if ('error' in injects) {
    logger.error({ scenarioId, error: injects.error }, 'Failed to load injects for dependency validation');
    throw new Error('Failed to load injects for dependency validation');
  }

  const prepared = prepareTeamDependencies(
    initialState.team_dependencies,
    toActiveTeams(
      teams.rows.map((row) => ({
        team_uid: typeof row.team_uid === 'string' ? row.team_uid : null,
        team_name: typeof row.team_name === 'string' ? row.team_name : null,
        org_key: typeof row.org_key === 'string' ? row.org_key : null,
      })),
      orgsOf(initialState),
    ),
    injects,
    durationMinutes,
  );
  if (!prepared.ok) return { issues: prepared.issues };
  const warnings = prepared.issues.filter((item) => item.severity === 'warning');
  if (warnings.length > 0) {
    logger.warn({ scenarioId, issues: warnings }, 'Team dependency warnings');
  }
  return {
    initialState: { ...initialState, team_dependencies: prepared.team_dependencies },
  };
}
