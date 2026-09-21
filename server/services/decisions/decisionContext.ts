/**
 * Organic executive decisions — shared session/scenario context loaders.
 */
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { getScenarioSnapshot, type ScenarioSnapshot } from '../../lib/scenarioCache.js';
import { normalizeOrgPages, type OrgConfig } from '../socialCrisisGeneratorService.js';
import { getStakeholders } from '../stakeholderService.js';
import { getSessionTeams, type SessionTeam } from '../orgRegistryService.js';
import type { OrgRegistryEntry, Stakeholder } from '../../lib/stakeholderContract.js';
import { toCastEntry, type CastEntry } from './decisionTypes.js';

export interface SessionInfo {
  id: string;
  scenario_id: string;
  trainer_id: string | null;
  start_time: string | null;
  status: string;
  sim_mode: string | null;
}

export interface DecisionContextBundle {
  session: SessionInfo;
  scenario: ScenarioSnapshot;
  elapsedMinutes: number;
  stakeholders: Stakeholder[];
  stakeholderById: Map<string, Stakeholder>;
  stakeholderByEmail: Map<string, Stakeholder>;
  cast: Map<string, CastEntry>;
  registry: OrgRegistryEntry[];
  orgCountry: Map<string, string>;
  pages: OrgConfig[];
  pressurePages: Map<
    string,
    { spokesperson_id: string; display_name: string; country: string | null; page: OrgConfig }
  >;
  teams: SessionTeam[];
  decisionContext: {
    leakiness: number;
    labour_signal: boolean;
    product_safety_signal: boolean;
    notification_function?: string;
  };
  factSheet: { confirmed_facts: string[] };
  crisisDescription: string;
}

export async function getSessionInfo(sessionId: string): Promise<SessionInfo | null> {
  const { data } = await supabaseAdmin
    .from('sessions')
    .select('id, scenario_id, trainer_id, start_time, status, sim_mode')
    .eq('id', sessionId)
    .maybeSingle();
  if (!data?.scenario_id) return null;
  return {
    id: String(data.id),
    scenario_id: String(data.scenario_id),
    trainer_id: data.trainer_id ? String(data.trainer_id) : null,
    start_time: data.start_time ? String(data.start_time) : null,
    status: String(data.status || ''),
    sim_mode: data.sim_mode ? String(data.sim_mode) : null,
  };
}

/**
 * Whole minutes since session start. Integer on purpose: `detected_at_minute` feeds
 * `scenario_injects.trigger_time_minutes` / `eligible_after_minutes` and the `at_minute` columns
 * of `decision_knowledge` / `decision_events`, all INTEGER — a fractional value made every
 * cascade insert fail with `invalid input syntax for type integer` (spec §15).
 */
export function elapsedMinutesOf(session: SessionInfo): number {
  if (!session.start_time) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(session.start_time).getTime()) / 60000));
}

export async function loadDecisionContext(
  sessionId: string,
): Promise<DecisionContextBundle | null> {
  const session = await getSessionInfo(sessionId);
  if (!session) return null;
  const scenario = await getScenarioSnapshot(session.scenario_id);
  if (!scenario) return null;
  const is = scenario.initial_state;
  const stakeholders = await getStakeholders(session.scenario_id);
  const stakeholderById = new Map(stakeholders.map((s) => [s.id, s]));
  const stakeholderByEmail = new Map(stakeholders.map((s) => [s.email.toLowerCase(), s]));
  const cast = new Map(stakeholders.map((s) => [s.id, toCastEntry(s)]));
  const registry = (Array.isArray(is.orgs) ? (is.orgs as OrgRegistryEntry[]) : []).filter(
    (o) => o && o.org_key,
  );
  const orgCountry = new Map<string, string>();
  for (const o of registry) if (o.country) orgCountry.set(o.org_key, o.country);
  const pages = normalizeOrgPages(is.org_page as Record<string, unknown> | undefined);
  const pressurePages = new Map<
    string,
    { spokesperson_id: string; display_name: string; country: string | null; page: OrgConfig }
  >();
  for (const p of pages) {
    if (p.role === 'pressure' && p.spokesperson_stakeholder_id) {
      pressurePages.set(p.org_key, {
        spokesperson_id: p.spokesperson_stakeholder_id,
        display_name: p.display_name,
        country: p.country ?? null,
        page: p,
      });
    }
  }
  const teams = await getSessionTeams(sessionId);
  const dc = (is.decision_context as Record<string, unknown> | undefined) || {};
  const factSheet = (is.fact_sheet as { confirmed_facts?: string[] } | undefined) || {};
  return {
    session,
    scenario,
    elapsedMinutes: elapsedMinutesOf(session),
    stakeholders,
    stakeholderById,
    stakeholderByEmail,
    cast,
    registry,
    orgCountry,
    pages,
    pressurePages,
    teams,
    decisionContext: {
      leakiness: Number.isFinite(Number(dc.leakiness))
        ? Math.max(0, Math.min(1, Number(dc.leakiness)))
        : 0.5,
      labour_signal: !!dc.labour_signal,
      product_safety_signal: !!dc.product_safety_signal,
      ...(dc.notification_function
        ? { notification_function: String(dc.notification_function) }
        : {}),
    },
    factSheet: {
      confirmed_facts: Array.isArray(factSheet.confirmed_facts)
        ? factSheet.confirmed_facts.map(String)
        : [],
    },
    crisisDescription: scenario.description || scenario.title,
  };
}

/** Compact cast for prompts: principals + groups (roster summarised per site). */
export function castForPrompt(ctx: DecisionContextBundle, limit = 60): string {
  const principals = Array.from(ctx.cast.values()).filter((c) => c.tier !== 'roster');
  const rosterBySite = new Map<string, number>();
  for (const c of ctx.cast.values()) {
    if (c.tier === 'roster')
      rosterBySite.set(
        c.site_key || c.org_key || 'site',
        (rosterBySite.get(c.site_key || c.org_key || 'site') || 0) + 1,
      );
  }
  const lines = principals
    .slice(0, limit)
    .map(
      (c) =>
        `- ${c.id} | ${c.name}, ${c.title} @ ${c.organisation} | ${c.relationship}${c.kind === 'group' ? ` | GROUP(${c.members?.length ?? 0})` : ''} | org ${c.org_key ?? 'common'}${c.site_key ? ` | site ${c.site_key}` : ''} | owner ${c.owning_team}${c.page_org_key ? ` | speaks for page ${c.page_org_key}` : ''} | reacts to: ${c.sensitivities.slice(0, 2).join('; ') || '—'}`,
    );
  for (const [site, n] of rosterBySite)
    lines.push(`- (roster) ${n} employees at ${site} — reachable via the site's distribution list`);
  return lines.join('\n');
}
