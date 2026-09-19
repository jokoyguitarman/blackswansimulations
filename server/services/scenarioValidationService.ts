import { logger } from '../lib/logger.js';
import type { SocialCrisisPayload, SocialInject } from './socialCrisisGeneratorService.js';
import type { TeamCharter } from './teamCharterService.js';
import {
  StakeholderSchema,
  OrgRegistryEntrySchema,
  ExecutiveDecisionSchema,
  resolveTeamFunction,
  type Stakeholder,
} from './stakeholderShapes.js';
import { functionKeyForTeamRow } from './scenarioOrgModel.js';

type PersistableTeamCharter = TeamCharter & {
  org_key?: string | null;
  function_key?: string | null;
};

/**
 * Pre-persist acceptance checklist (contract §9 + generator invariants).
 * Every rule has a stable MO-* code. Violations throw BEFORE any row is
 * written so compile fails loudly, the credit is refunded, and the trainer
 * sees the first failing rule with record ids. Warnings are logged, never
 * swallowed.
 */

export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
}

export class MultiOrgValidationError extends Error {
  code: string;
  path: string;
  all: ValidationIssue[];
  constructor(all: ValidationIssue[]) {
    const first = all[0];
    super(`${first.code}: ${first.message}`);
    this.name = 'MultiOrgValidationError';
    this.code = first.code;
    this.path = first.path;
    this.all = all;
  }
}

const MIN_STAKEHOLDER_INJECT_MINUTES = 10;
const NOTE_LEAK =
  /(\bT\+\d+|\b\d{1,3}\s*(min|mins|minutes)\b|\bwill\s+(post|publish|leak|escalate|go public)|\b(plans?|about|threaten\w*)\s+to\b)/i;

export function validateScenarioPayload(
  payload: SocialCrisisPayload,
  charters: PersistableTeamCharter[],
): void {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const fail = (code: string, path: string, message: string) =>
    errors.push({ code, path, message });
  const warn = (code: string, path: string, message: string) =>
    warnings.push({ code, path, message });

  const is = payload.scenario.initial_state;
  const orgs = is.orgs || [];
  const countries = is.countries || [];
  const stakeholders = is.stakeholders || [];
  const personas = is.npc_personas || [];
  const decisions = is.decision_space || [];
  const injects: SocialInject[] = [
    ...payload.time_injects,
    ...payload.condition_injects,
    ...payload.decision_injects,
  ];
  const multiOrg = orgs.length > 1;

  // ── Registry ──
  const protagonistKeys = new Set(
    orgs.filter((o) => o.side === 'protagonist').map((o) => o.org_key),
  );
  const allOrgKeys = new Set(orgs.map((o) => o.org_key));
  const countrySet = new Set<string>(
    countries.length > 0 ? countries.map((c) => c.name) : orgs.map((o) => o.country),
  );
  for (const o of orgs) {
    const parsed = OrgRegistryEntrySchema.safeParse(o);
    if (!parsed.success)
      fail(
        'MO-ORG-005',
        `orgs.${o.org_key}`,
        `Registry entry invalid: ${parsed.error.issues[0]?.message}`,
      );
    if (countries.length > 0 && !countrySet.has(o.country)) {
      fail(
        'MO-ORG-006',
        `orgs.${o.org_key}`,
        `Country "${o.country}" of ${o.display_name} missing from countries[]`,
      );
    }
  }
  if (
    orgs.length > 0 &&
    orgs.filter((o) => o.side === 'protagonist' && o.is_primary).length !== 1
  ) {
    fail('MO-ORG-002', 'orgs', 'Exactly one protagonist organisation must be marked primary');
  }
  if (is.country && orgs.length > 0) {
    const primary = orgs.find((o) => o.is_primary);
    if (primary && primary.country !== is.country) {
      fail(
        'MO-ORG-006',
        'initial_state.country',
        `initial_state.country "${is.country}" must equal the primary organisation's country "${primary.country}"`,
      );
    }
  }
  const pages = (is.org_page?.orgs || []) as Array<{ org_key: string; country?: string }>;
  if (orgs.length > 0) {
    for (const p of pages) {
      if (!allOrgKeys.has(p.org_key)) {
        fail(
          'MO-ORG-005',
          `org_page.${p.org_key}`,
          `Org page "${p.org_key}" references an org_key not in the registry`,
        );
      }
    }
  }

  // ── Teams ──
  const teamFunctionByName = new Map<
    string,
    { function_key: string | null; org_key: string | null }
  >();
  for (const t of payload.teams) {
    const charter = charters.find((c) => c.team_name === t.team_name);
    const function_key = functionKeyForTeamRow(t.team_name, charter);
    const org_key = charter?.org_key ?? null;
    teamFunctionByName.set(t.team_name, { function_key, org_key });
    if (org_key !== null && !protagonistKeys.has(org_key)) {
      fail(
        'MO-TEAM-002',
        `teams.${t.team_name}`,
        `Team "${t.team_name}" has org_key ${org_key} not in the protagonist registry`,
      );
    }
    if (charter && !charter.is_custom && !function_key) {
      fail(
        'MO-TEAM-003',
        `teams.${t.team_name}`,
        `Catalog team "${t.team_name}" is missing function_key`,
      );
    }
  }
  const teamNames = new Set(payload.teams.map((t) => t.team_name));
  // One public voice per org (or per scenario when single-org).
  const voicesByOrg = new Map<string, number>();
  for (const c of charters) {
    const k = c.org_key ?? '__single';
    if (c.can_post_publicly) voicesByOrg.set(k, (voicesByOrg.get(k) || 0) + 1);
  }
  for (const [k, n] of voicesByOrg) {
    if (n > 1)
      fail(
        'MO-TEAM-004',
        `teams.${k}`,
        `Organisation ${k} has ${n} public-voice teams (exactly one expected)`,
      );
  }

  // ── Personas ──
  const personaHandles = new Map<string, number>();
  for (const p of personas) {
    personaHandles.set(p.handle, (personaHandles.get(p.handle) || 0) + 1);
    if (p.country && countrySet.size > 0 && !countrySet.has(p.country)) {
      fail(
        'MO-PER-001',
        `personas.${p.handle}`,
        `Persona ${p.handle}: country "${p.country}" unknown`,
      );
    }
  }
  for (const [h, n] of personaHandles)
    if (n > 1) fail('MO-PER-002', `personas.${h}`, `Duplicate persona handle ${h}`);
  if (multiOrg) {
    for (const c of countrySet) {
      const n = personas.filter((p) => p.country === c).length;
      if (n < 50) warn('MO-PER-003', `personas.${c}`, `Country ${c}: only ${n} personas generated`);
    }
  }
  const pageHandles = new Set<string>();
  for (const p of (is.org_page?.orgs || []) as Array<{
    facebook?: { page_handle?: string };
    x_twitter?: { page_handle?: string };
  }>) {
    if (p.facebook?.page_handle) pageHandles.add(p.facebook.page_handle.toLowerCase());
    if (p.x_twitter?.page_handle) pageHandles.add(p.x_twitter.page_handle.toLowerCase());
  }

  // ── Stakeholders ──
  const stakeholderById = new Map<string, Stakeholder>();
  const seenEmails = new Map<string, string>();
  const seenHandles = new Map<string, string>();
  const identityKey = (s: Stakeholder) => `${s.name}|${s.title}|${s.organisation}`.toLowerCase();
  const seenIdentity = new Map<string, Stakeholder>();
  for (const s of stakeholders) {
    const parsed = StakeholderSchema.safeParse(s);
    if (!parsed.success) {
      fail(
        'MO-STK-005',
        `stakeholders.${s.id}`,
        `Stakeholder ${s.id}: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`,
      );
    }
    if (stakeholderById.has(s.id))
      fail('MO-STK-004', `stakeholders.${s.id}`, `Duplicate stakeholder id "${s.id}"`);
    stakeholderById.set(s.id, s);
    if (seenEmails.has(s.email))
      fail(
        'MO-STK-004',
        `stakeholders.${s.id}`,
        `Duplicate email "${s.email}" (stakeholder ${s.id} vs ${seenEmails.get(s.email)})`,
      );
    seenEmails.set(s.email, s.id);
    if (seenHandles.has(s.handle))
      fail(
        'MO-STK-004',
        `stakeholders.${s.id}`,
        `Duplicate handle "${s.handle}" (stakeholder ${s.id} vs ${seenHandles.get(s.handle)})`,
      );
    seenHandles.set(s.handle, s.id);
    if (pageHandles.has(s.handle.toLowerCase()))
      fail('MO-STK-004', `stakeholders.${s.id}`, `Handle "${s.handle}" collides with an org page`);
    // A persona with the same handle is REQUIRED for feed authors (checked below) and must be the twin,
    // so a collision with a non-twin persona is only an error when names differ.
    const twin = personas.find((p) => p.handle === s.handle);
    if (twin && twin.name !== s.name)
      fail(
        'MO-STK-004',
        `stakeholders.${s.id}`,
        `Handle "${s.handle}" collides with persona "${twin.name}"`,
      );

    // owning_team resolves to a function (org-scoped when org_key set) — MO-STK-001
    const matches = Array.from(teamFunctionByName.entries()).filter(([teamName, t]) => {
      const fn = resolveTeamFunction({ team_name: teamName, function_key: t.function_key });
      if (fn !== s.owning_team && teamName !== s.owning_team) return false;
      if (s.org_key === null || t.org_key === null) return true;
      return t.org_key === s.org_key;
    });
    if (matches.length === 0) {
      fail(
        'MO-STK-001',
        `stakeholders.${s.id}`,
        `Stakeholder ${s.id}: owning_team "${s.owning_team}" matches no team in ${s.org_key ?? 'the scenario'}`,
      );
    }
    if (s.org_key !== null && !protagonistKeys.has(s.org_key)) {
      fail(
        'MO-STK-002',
        `stakeholders.${s.id}`,
        `Stakeholder ${s.id}: org_key ${s.org_key} is not a protagonist organisation`,
      );
    }
    const idKey = identityKey(s);
    const dup = seenIdentity.get(idKey);
    if (dup && dup.org_key !== s.org_key) {
      fail(
        'MO-STK-003',
        `stakeholders.${s.id}`,
        `Stakeholder "${s.name}" duplicated across orgs (${dup.id}, ${s.id}) — emit once with org_key null`,
      );
    }
    seenIdentity.set(idKey, s);
    if (NOTE_LEAK.test(s.note))
      fail(
        'MO-STK-009',
        `stakeholders.${s.id}`,
        `Stakeholder ${s.id}: note reveals timing or a planned action`,
      );
  }

  // ── Injects ──
  const injectKeys = new Map<string, number>();
  const feedAuthorsNeedingTwin = new Set<string>();
  const injectsByStakeholder = new Map<string, number>();
  for (const inj of injects) {
    const dc = inj.delivery_config || ({} as SocialInject['delivery_config']);
    const path = `injects.${inj.title}`;
    if (dc.stakeholder_id) {
      const s = stakeholderById.get(dc.stakeholder_id);
      if (!s) {
        fail(
          'MO-INJ-001',
          path,
          `Inject "${inj.title}": stakeholder_id ${dc.stakeholder_id} not found`,
        );
      } else {
        injectsByStakeholder.set(s.id, (injectsByStakeholder.get(s.id) || 0) + 1);
        // Author fields per §4.2
        if (dc.app === 'email' && dc.from_address !== s.email)
          fail(
            'MO-INJ-005',
            path,
            `Inject "${inj.title}": from_address "${dc.from_address}" ≠ stakeholder ${s.id} email "${s.email}"`,
          );
        if (dc.app === 'email' && dc.from_name !== s.name)
          fail(
            'MO-INJ-005',
            path,
            `Inject "${inj.title}": from_name "${dc.from_name}" ≠ stakeholder ${s.id} name`,
          );
        if ((dc.app === 'social_feed' || dc.app === 'news') && dc.author_handle !== s.handle)
          fail(
            'MO-INJ-005',
            path,
            `Inject "${inj.title}": author_handle "${dc.author_handle}" ≠ stakeholder ${s.id} handle "${s.handle}"`,
          );
        if (dc.app === 'phone_call' && s.phone && dc.from_address !== s.phone)
          fail(
            'MO-INJ-005',
            path,
            `Inject "${inj.title}": phone from_address ≠ stakeholder ${s.id} phone`,
          );
        if (dc.app === 'news' && dc.outlet_name !== s.organisation)
          fail(
            'MO-INJ-005',
            path,
            `Inject "${inj.title}": outlet_name ≠ stakeholder ${s.id} organisation`,
          );
        if (dc.app === 'social_feed' || dc.app === 'news') feedAuthorsNeedingTwin.add(s.id);
        if (
          inj.trigger_time_minutes != null &&
          inj.trigger_time_minutes < MIN_STAKEHOLDER_INJECT_MINUTES
        ) {
          fail(
            'MO-INJ-006',
            path,
            `Inject "${inj.title}": stakeholder inject at T+${inj.trigger_time_minutes} (< ${MIN_STAKEHOLDER_INJECT_MINUTES})`,
          );
        }
      }
    }
    if (dc.org_key && !allOrgKeys.has(dc.org_key))
      fail('MO-INJ-002', path, `Inject "${inj.title}": org_key ${dc.org_key} unknown`);
    if (dc.country && countrySet.size > 0 && !countrySet.has(dc.country))
      fail('MO-INJ-003', path, `Inject "${inj.title}": country "${dc.country}" unknown`);
    if (dc.org_key && dc.country) {
      const org = orgs.find((o) => o.org_key === dc.org_key);
      if (org && org.country !== dc.country)
        fail(
          'MO-INJ-004',
          path,
          `Inject "${inj.title}": org ${dc.org_key} is not in ${dc.country}`,
        );
    }
    if (dc.inject_key) {
      injectKeys.set(dc.inject_key, (injectKeys.get(dc.inject_key) || 0) + 1);
      const hasCondition = !!inj.conditions_to_appear;
      if (inj.trigger_time_minutes != null || !hasCondition) {
        fail(
          'MO-DEC-005',
          path,
          `Template "${inj.title}" would fire on the clock (templates need trigger null + a condition)`,
        );
      }
    }
    if (inj.inject_scope === 'team_specific') {
      for (const t of inj.target_teams || []) {
        if (!teamNames.has(t))
          warn(
            'MO-INJ-007',
            path,
            `Inject "${inj.title}" targets unknown team "${t}" (sanitizer will downgrade)`,
          );
      }
    }
  }
  for (const [k, n] of injectKeys)
    if (n > 1) fail('MO-DEC-007', `injects.${k}`, `Duplicate inject_key ${k}`);
  for (const sid of feedAuthorsNeedingTwin) {
    const s = stakeholderById.get(sid)!;
    if (!personas.some((p) => p.handle === s.handle)) {
      fail(
        'MO-STK-006',
        `stakeholders.${sid}`,
        `Stakeholder ${sid} posts on the feed but has no persona twin (${s.handle})`,
      );
    }
  }
  for (const s of stakeholders) {
    const n = injectsByStakeholder.get(s.id) || 0;
    if (s.grievance === '' && n > 0)
      fail(
        'MO-STK-007',
        `stakeholders.${s.id}`,
        `Stakeholder ${s.id} has no grievance but authors ${n} inject(s)`,
      );
  }
  // Team x org coverage (MO-STK-008): each team has >= 1 visible stakeholder and >= 1 pure contact.
  if (stakeholders.length > 0) {
    for (const [teamName, t] of teamFunctionByName) {
      const fn = resolveTeamFunction({ team_name: teamName, function_key: t.function_key });
      const visible = stakeholders.filter(
        (s) =>
          (s.owning_team === fn || s.owning_team === teamName) &&
          (s.org_key === null || t.org_key === null || s.org_key === t.org_key),
      );
      if (visible.length === 0)
        fail('MO-STK-008', `teams.${teamName}`, `Team "${teamName}" has no contacts`);
      else if (!visible.some((s) => s.grievance === ''))
        fail(
          'MO-STK-008',
          `teams.${teamName}`,
          `Team "${teamName}" has no pure contact (every contact has a grievance)`,
        );
    }
  }

  // ── Decision layer ──
  const decisionKeys = new Set<string>();
  for (const d of decisions) {
    const parsed = ExecutiveDecisionSchema.safeParse(d);
    if (!parsed.success)
      fail(
        'MO-DEC-001',
        `decisions.${d.decision_key}`,
        `Decision ${d.decision_key}: ${parsed.error.issues[0]?.message}`,
      );
    if (decisionKeys.has(d.decision_key))
      fail('MO-DEC-007', `decisions.${d.decision_key}`, `Duplicate decision_key ${d.decision_key}`);
    decisionKeys.add(d.decision_key);
    for (const k of [...d.decidable_by_org_keys, ...d.affected_org_keys]) {
      if (!protagonistKeys.has(k))
        fail(
          'MO-DEC-001',
          `decisions.${d.decision_key}`,
          `Decision ${d.decision_key}: unknown org ${k}`,
        );
    }
    for (const ob of d.sop_obligations) {
      for (const sid of ob.owed_to_stakeholder_ids) {
        if (!stakeholderById.has(sid))
          fail(
            'MO-DEC-002',
            `decisions.${d.decision_key}`,
            `Decision ${d.decision_key}: obligation owed to unknown stakeholder ${sid}`,
          );
      }
      const fnExists = Array.from(teamFunctionByName.entries()).some(
        ([name, t]) =>
          resolveTeamFunction({ team_name: name, function_key: t.function_key }) ===
          ob.owed_by_function,
      );
      if (!fnExists)
        fail(
          'MO-DEC-002',
          `decisions.${d.decision_key}`,
          `Decision ${d.decision_key}: obligation owed by unknown function ${ob.owed_by_function}`,
        );
    }
    for (const k of [...d.eruption_inject_keys, ...d.spillover_inject_keys]) {
      const tpl = injects.find((i) => i.delivery_config?.inject_key === k);
      if (!tpl)
        fail(
          'MO-DEC-003',
          `decisions.${d.decision_key}`,
          `Decision ${d.decision_key}: template ${k} missing`,
        );
      else if (tpl.delivery_config?.decision_key !== d.decision_key)
        fail(
          'MO-DEC-003',
          `decisions.${d.decision_key}`,
          `Decision ${d.decision_key}: template ${k} belongs to another decision`,
        );
    }
    if (d.severity === 'high') {
      for (const orgKey of d.affected_org_keys) {
        const reacting = stakeholders.some(
          (s) =>
            s.latent_grievances?.[d.decision_key] && (s.org_key === orgKey || s.org_key === null),
        );
        if (!reacting)
          warn(
            'MO-DEC-006',
            `decisions.${d.decision_key}`,
            `Decision ${d.decision_key}: no reacting stakeholder in ${orgKey}`,
          );
      }
    }
  }
  for (const s of stakeholders) {
    for (const [dk, lg] of Object.entries(s.latent_grievances || {})) {
      for (const k of lg.eruption_inject_keys) {
        const tpl = injects.find((i) => i.delivery_config?.inject_key === k);
        if (!tpl)
          fail(
            'MO-DEC-004',
            `stakeholders.${s.id}`,
            `Stakeholder ${s.id}: latent eruption ${k} (decision ${dk}) has no template`,
          );
        else if (tpl.delivery_config?.stakeholder_id !== s.id)
          fail(
            'MO-DEC-004',
            `stakeholders.${s.id}`,
            `Stakeholder ${s.id}: latent eruption ${k} not authored by them`,
          );
      }
    }
  }

  for (const w of warnings) logger.warn({ code: w.code, path: w.path }, w.message);
  if (errors.length > 0) {
    logger.error({ errors }, 'compile_validation_failed');
    throw new MultiOrgValidationError(errors);
  }
}
