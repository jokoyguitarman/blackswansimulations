import { logger } from '../lib/logger.js';
import {
  callSocialCrisisAI,
  type FactSheet,
  type NPCPersona,
  type SocialInject,
  type SOPStep,
} from './socialCrisisGeneratorService.js';
import {
  EXECUTIVE_FUNCTION,
  type NormalisedOrg,
  type OrgTeamCharter,
  type ChainOfCommandEdge,
  type ExecutiveDecision,
} from './scenarioOrgModel.js';
import {
  PERSUADABILITIES as PERSUADABILITY,
  type LatentGrievance,
  type Persuadability,
  type Stakeholder,
} from '../lib/stakeholderContract.js';
import type { CrisisContext } from './multiOrgGenerationService.js';
import { countrySlug } from '../../shared/countries.js';

/**
 * Decision layer substrate (contract §7A, reserved surface). Real executives
 * are players; the simulation guarantees SOP consequences for the decisions
 * they take. Everything here is DORMANT until the runtime's decision action
 * and condition primitives ship: templates have no trigger time and fire only
 * on `decision_recorded:<key>` / `inject_published:<key>` conditions.
 *
 * Generated only when at least one organisation fields an Executive team.
 */

export interface DecisionLayerResult {
  decision_space: ExecutiveDecision[];
  /** Stakeholders with latent_grievances merged in (same objects, mutated). */
  stakeholders: Stakeholder[];
  /** Eruption + spillover + HQ follow-up templates (trigger null, condition-gated). */
  templates: SocialInject[];
  chain_of_command: ChainOfCommandEdge[];
  sop_steps: SOPStep[];
}

interface RawDecision {
  decision_key?: string;
  label?: string;
  description?: string;
  decidable_by?: string[];
  affected?: string[];
  severity?: string;
  obligations?: Array<{
    obligation_key?: string;
    description?: string;
    owed_by_function?: string;
    owed_to_relationships?: string[];
    window_minutes?: number;
    detection?: string;
  }>;
  public_statement_expected?: boolean;
}

interface RawLatent {
  decision_key?: string;
  stakeholder_id?: string;
  grievance?: string;
  resolution_criteria?: string[];
  persuadability?: string;
  hard_constraints?: string[];
  eruption?: { channel?: string; title?: string; content?: string; platform?: string };
}

interface RawSpillover {
  decision_key?: string;
  country?: string;
  title?: string;
  content?: string;
  author_handle?: string;
  platform?: string;
}

export function hasExecutiveTeam(orgs: NormalisedOrg[]): boolean {
  return orgs.some((o) => o.teams.some((t) => t.function_key === EXECUTIVE_FUNCTION));
}

export async function generateDecisionLayer(
  orgs: NormalisedOrg[],
  charters: OrgTeamCharter[],
  stakeholders: Stakeholder[],
  personas: NPCPersona[],
  factSheet: FactSheet,
  crisis: CrisisContext,
): Promise<DecisionLayerResult> {
  const multiOrg = orgs.length > 1;
  const decidingOrgs = orgs.filter((o) =>
    o.teams.some((t) => t.function_key === EXECUTIVE_FUNCTION),
  );
  const orgLine = (o: NormalisedOrg) =>
    `${o.org_key}: ${o.display_name} (${o.kind}, ${o.country}) — teams: ${o.teams.map((t) => t.function_key).join(', ')}`;

  // ── Call 1: the decision space ──
  const raw = await callSocialCrisisAI(
    `You are designing the EXECUTIVE DECISION SPACE for a crisis simulation in which real executives play the leadership team. Nothing here is scripted to happen: these are the plausible consequential decisions leadership COULD take, and what company SOP would oblige them to do if they take one.

ORGANISATIONS (org_key: name):
${orgs.map(orgLine).join('\n')}
Executive teams exist at: ${decidingOrgs.map((o) => o.org_key).join(', ')}

Produce 4-8 decisions, at least one per severity level. Each decision:
- "decision_key": snake_case, unique (e.g. "close_plant_johor", "partial_layoffs_my", "suspend_production", "independent_audit", "compensation_scheme", "leadership_change")
- "label" (short), "description" (1-2 sentences)
- "decidable_by": org_keys whose Executive team can take it (subset of ${decidingOrgs.map((o) => o.org_key).join(', ')})
- "affected": org_keys whose stakeholders react (${multiOrg ? 'high-severity decisions must affect at least one org other than the decider' : 'the organisation itself'})
- "severity": "low" | "medium" | "high"
- "obligations": 1-3 SOP obligations triggered by the decision, each { "obligation_key", "description" (e.g. "Brief employee representatives and local HR before any external communication"), "owed_by_function" (a function that exists in the affected or deciding org), "owed_to_relationships": which stakeholder relationship types must be engaged (from: client, supplier, regulator, partner, internal, media, community, investor, union), "window_minutes": 15-60, "detection": "stakeholder_contacted" | "statement_published" | "internal_directive_sent" }
- "public_statement_expected": boolean

Return ONLY valid JSON: { "decisions": [ ... ] }`,
    `Crisis: ${crisis.crisisType}\nContext: ${crisis.context}\nConfirmed facts: ${factSheet.confirmed_facts.slice(0, 8).join('; ')}`,
    6000,
    0.7,
  );

  const orgKeys = new Set(orgs.map((o) => o.org_key));
  const functionsByOrg = new Map(
    orgs.map((o) => [o.org_key, new Set(o.teams.map((t) => t.function_key))]),
  );
  const decisions: ExecutiveDecision[] = [];
  const usedKeys = new Set<string>();

  for (const d of ((raw?.decisions as RawDecision[]) || []).slice(0, 8)) {
    const key = countrySlug(String(d.decision_key || d.label || ''))
      .replace(/_+/g, '_')
      .slice(0, 60);
    if (!key || usedKeys.has(key)) continue;
    const decidable = (d.decidable_by || [])
      .map(String)
      .filter((k) => decidingOrgs.some((o) => o.org_key === k));
    if (decidable.length === 0) decidable.push(decidingOrgs[0].org_key);
    const affected = (d.affected || []).map(String).filter((k) => orgKeys.has(k));
    if (affected.length === 0) affected.push(decidable[0]);
    const severity = (['low', 'medium', 'high'] as const).includes(d.severity as 'low')
      ? (d.severity as 'low' | 'medium' | 'high')
      : 'medium';

    const obligations = (d.obligations || []).slice(0, 3).map((ob, i) => {
      const owedBy = String(ob.owed_by_function || 'Communications');
      const rels = (ob.owed_to_relationships || []).map(String);
      const owedTo = stakeholders
        .filter(
          (s) =>
            (s.org_key === null || affected.includes(s.org_key)) && rels.includes(s.relationship),
        )
        .slice(0, 6)
        .map((s) => s.id);
      const detection = (
        ['stakeholder_contacted', 'statement_published', 'internal_directive_sent'] as const
      ).includes(ob.detection as 'stakeholder_contacted')
        ? (ob.detection as 'stakeholder_contacted')
        : 'stakeholder_contacted';
      // owed_by must exist in the deciding or an affected org; else fall back to Communications/first function.
      const candidateOrgs = [...decidable, ...affected];
      const exists = candidateOrgs.some((k) => functionsByOrg.get(k)?.has(owedBy));
      const fallbackFn =
        candidateOrgs
          .map((k) => Array.from(functionsByOrg.get(k) || []))
          .flat()
          .find((f) => f === 'Communications') ??
        Array.from(functionsByOrg.get(candidateOrgs[0]) || [])[0] ??
        'Communications';
      return {
        obligation_key: countrySlug(String(ob.obligation_key || `${key}_ob_${i}`))
          .replace(/_+/g, '_')
          .slice(0, 60),
        description: String(
          ob.description || 'Engage the affected stakeholders before any external communication',
        ).slice(0, 300),
        owed_to_stakeholder_ids: owedTo,
        owed_by_function: exists ? owedBy : fallbackFn,
        by_function: exists ? owedBy : fallbackFn,
        window_minutes: Math.max(5, Math.min(120, Math.round(Number(ob.window_minutes) || 30))),
        detection,
      };
    });

    usedKeys.add(key);
    decisions.push({
      decision_key: key,
      label: String(d.label || key).slice(0, 120),
      title: String(d.label || key).slice(0, 120),
      description: String(d.description || '').slice(0, 600) || String(d.label || key),
      decidable_by_org_keys: decidable,
      affected_org_keys: affected,
      severity,
      sop_obligations: obligations,
      eruption_inject_keys: [],
      spillover_inject_keys: [],
      public_statement_expected: d.public_statement_expected !== false,
    });
  }

  if (decisions.length === 0) {
    logger.warn('decision_space_empty');
    return {
      decision_space: [],
      stakeholders,
      templates: [],
      chain_of_command: buildChainOfCommand(orgs, charters, stakeholders),
      sop_steps: [],
    };
  }

  // ── Call 2: latent grievances + eruption content + spillover posts ──
  const candidateStakeholders = stakeholders.filter((s) =>
    ['internal', 'union', 'community', 'partner', 'client', 'supplier'].includes(s.relationship),
  );
  const otherCountriesFor = (dec: ExecutiveDecision) => {
    const affectedCountries = new Set(
      orgs.filter((o) => dec.affected_org_keys.includes(o.org_key)).map((o) => o.country),
    );
    return Array.from(new Set(orgs.map((o) => o.country))).filter((c) => !affectedCountries.has(c));
  };
  const mediaByCountry = new Map<string, NPCPersona[]>();
  for (const p of personas) {
    if (p.type === 'npc_media' && p.country) {
      if (!mediaByCountry.has(p.country)) mediaByCountry.set(p.country, []);
      mediaByCountry.get(p.country)!.push(p);
    }
  }

  const raw2 = await callSocialCrisisAI(
    `You are writing the CONSEQUENCES of executive decisions in a crisis simulation. For each decision, choose 2-4 stakeholders (from the list) in the AFFECTED organisations who would react badly if the decision reached them the wrong way (through rumour, without consultation, without support), and write their latent grievance.

Then, for each decision and each OTHER country listed for it, write one spillover post from that country's media picking the story up (a comparison, a "what does this mean for us here", a regulator's reaction).

DECISIONS:
${decisions.map((d) => `- ${d.decision_key} (${d.severity}; affects ${d.affected_org_keys.join(', ')}): ${d.label} — ${d.description}. Other countries: ${otherCountriesFor(d).join(', ') || 'none'}`).join('\n')}

STAKEHOLDERS (id | name | title | relationship | org_key):
${candidateStakeholders.map((s) => `${s.id} | ${s.name} | ${s.title} | ${s.relationship} | ${s.org_key ?? 'common'}`).join('\n')}

MEDIA PERSONAS BY COUNTRY: ${Array.from(mediaByCountry.entries())
      .map(
        ([c, ps]) =>
          `${c}: ${ps
            .slice(0, 3)
            .map((p) => p.handle)
            .join(', ')}`,
      )
      .join('; ')}

For each latent grievance: { "decision_key", "stakeholder_id", "grievance" (how they learned it and what is missing), "resolution_criteria" (1-4 checkable things — being briefed, a timeline, a named contact, support measures), "persuadability" ("none"|"low"|"medium"|"high"; union delegates low with a hard constraint to inform members), "hard_constraints": [], "eruption": { "channel": "social_post"|"email"|"news", "title", "content" (the leak / angry post / notice they would issue if not engaged), "platform": "x_twitter"|"facebook" } }
For each spillover: { "decision_key", "country", "title", "content", "author_handle" (one of that country's media personas), "platform" }

Return ONLY valid JSON: { "latent": [ ... ], "spillover": [ ... ] }`,
    `Crisis: ${crisis.crisisType}\nContext: ${crisis.context}`,
    9000,
    0.8,
  );

  const templates: SocialInject[] = [];
  const stakeholderById = new Map(stakeholders.map((s) => [s.id, s]));
  const countryByOrg = new Map(orgs.map((o) => [o.org_key, o.country]));
  const usedInjectKeys = new Set<string>();

  for (const l of (raw2?.latent as RawLatent[]) || []) {
    const decision = decisions.find((d) => d.decision_key === String(l.decision_key || ''));
    const s = stakeholderById.get(String(l.stakeholder_id || ''));
    if (!decision || !s) continue;
    const grievance = String(l.grievance || '').trim();
    if (!grievance) continue;
    let criteria = (l.resolution_criteria || [])
      .map(String)
      .map((c) => c.trim())
      .filter(Boolean)
      .slice(0, 4);
    if (criteria.length === 0)
      criteria = [
        'Briefed directly before any external announcement, with a named point of contact',
      ];
    let persuadability = String(l.persuadability || 'medium').toLowerCase() as Persuadability;
    if (!(PERSUADABILITY as readonly string[]).includes(persuadability)) persuadability = 'medium';
    if (s.relationship === 'union' && persuadability === 'high') persuadability = 'low';

    const injectKey = uniqueKey(
      usedInjectKeys,
      `erupt_${decision.decision_key}_${s.id.replace(/^stk_/, '')}`,
    );
    const eruptionOrgKey = s.org_key ?? decision.affected_org_keys[0];
    const eruptionCountry = countryByOrg.get(eruptionOrgKey);
    // News eruptions only from media stakeholders; anyone else erupts on the feed or by email.
    let channel = String(l.eruption?.channel || 'social_post');
    if (channel === 'news' && s.relationship !== 'media') channel = 'social_post';
    const title = String(l.eruption?.title || `${s.name} reacts to ${decision.label}`).slice(
      0,
      200,
    );
    const content = String(l.eruption?.content || grievance);
    const scope = {
      ...(multiOrg && eruptionOrgKey ? { org_key: eruptionOrgKey } : {}),
      ...(multiOrg && eruptionCountry ? { country: eruptionCountry } : {}),
    };
    const base = {
      trigger_time_minutes: undefined,
      title,
      content,
      severity: decision.severity === 'high' ? 'critical' : 'high',
      conditions_to_appear: {
        threshold: 1,
        conditions: [`decision_recorded:${decision.decision_key}`],
      },
    };
    if (channel === 'email') {
      templates.push({
        ...base,
        type: 'email_inbound',
        inject_scope: 'team_specific',
        target_teams: charters
          .filter(
            (c) =>
              c.function_key === s.owning_team &&
              (s.org_key === null || c.org_key === s.org_key || c.org_key === null),
          )
          .map((c) => c.team_name),
        delivery_config: {
          app: 'email',
          stakeholder_id: s.id,
          inject_key: injectKey,
          decision_key: decision.decision_key,
          from_name: s.name,
          from_address: s.email,
          email_category: 'general',
          priority: 'urgent',
          stakeholder_team: s.owning_team,
          ...scope,
        },
      });
    } else if (channel === 'news') {
      templates.push({
        ...base,
        type: 'news_article',
        inject_scope: 'universal',
        target_teams: [],
        delivery_config: {
          app: 'news',
          stakeholder_id: s.id,
          inject_key: injectKey,
          decision_key: decision.decision_key,
          outlet_name: s.organisation,
          headline: title,
          author_handle: s.handle,
          author_display_name: s.name,
          author_type: 'npc_media',
          ...scope,
        },
      });
    } else {
      templates.push({
        ...base,
        type: 'social_post',
        inject_scope: 'universal',
        target_teams: [],
        delivery_config: {
          app: 'social_feed',
          platform:
            String(l.eruption?.platform || 'x_twitter') === 'facebook' ? 'facebook' : 'x_twitter',
          stakeholder_id: s.id,
          inject_key: injectKey,
          decision_key: decision.decision_key,
          author_handle: s.handle,
          author_display_name: s.name,
          author_type: s.relationship === 'media' ? 'npc_media' : 'npc_public',
          ...scope,
        },
      });
    }

    const latent: LatentGrievance = {
      grievance,
      resolution_criteria: criteria,
      persuadability,
      hard_constraints: (l.hard_constraints || []).map(String).filter(Boolean).slice(0, 3),
      eruption_inject_keys: [injectKey],
    };
    s.latent_grievances = { ...(s.latent_grievances || {}), [decision.decision_key]: latent };
    decision.eruption_inject_keys.push(injectKey);
    // Any obligation with no explicit owed-to list picks up this reacting stakeholder.
    for (const ob of decision.sop_obligations) {
      if (!ob.owed_to_stakeholder_ids.includes(s.id) && ob.owed_to_stakeholder_ids.length < 8) {
        ob.owed_to_stakeholder_ids.push(s.id);
      }
    }
  }

  for (const sp of (raw2?.spillover as RawSpillover[]) || []) {
    const decision = decisions.find((d) => d.decision_key === String(sp.decision_key || ''));
    const country = String(sp.country || '');
    if (!decision || !country || decision.eruption_inject_keys.length === 0) continue;
    const media = mediaByCountry.get(country) || [];
    const author = media.find((p) => p.handle === String(sp.author_handle || '')) ?? media[0];
    if (!author) continue;
    const injectKey = uniqueKey(
      usedInjectKeys,
      `spill_${decision.decision_key}_${countrySlug(country)}`,
    );
    const orgHere = orgs.find((o) => o.country === country);
    templates.push({
      trigger_time_minutes: undefined,
      type: 'social_post',
      title: String(sp.title || `${country} media on ${decision.label}`).slice(0, 200),
      content: String(sp.content || '').trim() || `${author.name} reports on ${decision.label}.`,
      severity: 'high',
      inject_scope: 'universal',
      target_teams: [],
      delivery_config: {
        app: 'social_feed',
        platform: String(sp.platform || 'x_twitter') === 'facebook' ? 'facebook' : 'x_twitter',
        author_handle: author.handle,
        author_display_name: author.name,
        author_type: 'npc_media',
        inject_key: injectKey,
        decision_key: decision.decision_key,
        country,
        ...(orgHere ? { org_key: orgHere.org_key } : {}),
      },
      conditions_to_appear: {
        threshold: 1,
        conditions: decision.eruption_inject_keys.map((k) => `inject_published:${k}`),
      },
      eligible_after_minutes: 10,
    });
    decision.spillover_inject_keys.push(injectKey);
  }

  // HQ follow-up: the deciding org's leadership hears that the story broke elsewhere first.
  for (const decision of decisions) {
    if (decision.eruption_inject_keys.length === 0) continue;
    const deciderKey = decision.decidable_by_org_keys[0];
    const decider = orgs.find((o) => o.org_key === deciderKey);
    if (!decider) continue;
    const execTeam = charters.find(
      (c) =>
        c.function_key === EXECUTIVE_FUNCTION && (c.org_key === deciderKey || c.org_key === null),
    );
    if (!execTeam) continue;
    const injectKey = uniqueKey(usedInjectKeys, `hq_${decision.decision_key}`);
    templates.push({
      trigger_time_minutes: undefined,
      type: 'email_inbound',
      title: `Board office: why did we hear about "${decision.label}" from outside?`,
      content: `Subject: ${decision.label} — external coverage\n\nThe board office is receiving press enquiries about the ${decision.label.toLowerCase()} before any internal note reached us. Please confirm what has been communicated to affected staff and partners, and when.\n\nOffice of the Chief of Staff`,
      severity: 'high',
      inject_scope: 'team_specific',
      target_teams: [execTeam.team_name],
      delivery_config: {
        app: 'email',
        from_name: 'Office of the Chief of Staff',
        from_address: `chiefofstaff.office@${countrySlug(decider.short_name || decider.display_name).replace(/_/g, '')}.sim`,
        email_category: 'sitrep_request',
        priority: 'urgent',
        inject_key: injectKey,
        decision_key: decision.decision_key,
        stakeholder_team: EXECUTIVE_FUNCTION,
        ...(multiOrg ? { org_key: deciderKey, country: decider.country } : {}),
      },
      conditions_to_appear: {
        threshold: 1,
        conditions: decision.eruption_inject_keys.map((k) => `inject_published:${k}`),
      },
      eligible_after_minutes: 5,
    });
    decision.spillover_inject_keys.push(injectKey);
  }

  logger.info(
    {
      decisions: decisions.length,
      templates: templates.length,
      latent: stakeholders.filter((s) => s.latent_grievances).length,
    },
    'decision_layer_generated',
  );

  return {
    decision_space: decisions,
    stakeholders,
    templates,
    chain_of_command: buildChainOfCommand(orgs, charters, stakeholders),
    sop_steps: decisionSopSteps(decisions),
  };
}

/** Deterministic: Executive -> every other function; each function -> its internal stakeholders. */
export function buildChainOfCommand(
  orgs: NormalisedOrg[],
  charters: OrgTeamCharter[],
  stakeholders: Stakeholder[],
): ChainOfCommandEdge[] {
  const edges: ChainOfCommandEdge[] = [];
  const multiOrg = orgs.length > 1;
  for (const org of orgs) {
    const key = multiOrg ? org.org_key : 'primary';
    const mine = charters.filter(
      (c) => (c.org_key ?? 'primary') === (multiOrg ? org.org_key : 'primary'),
    );
    const functions = mine.map((c) => c.function_key);
    if (functions.includes(EXECUTIVE_FUNCTION)) {
      edges.push({
        org_key: key,
        from_function: EXECUTIVE_FUNCTION,
        to: functions.filter((f) => f !== EXECUTIVE_FUNCTION),
      });
    }
    for (const fn of functions) {
      if (fn === EXECUTIVE_FUNCTION) continue;
      const internal = stakeholders.filter(
        (s) =>
          s.relationship === 'internal' &&
          s.owning_team === fn &&
          (s.org_key === null || !multiOrg || s.org_key === org.org_key),
      );
      if (internal.length > 0) {
        edges.push({
          org_key: key,
          from_function: fn,
          to: internal.slice(0, 8).map((s) => s.id),
        });
      }
    }
  }
  return edges;
}

/** Decision-triggered SOP steps appended to the scenario SOP (consumed by the runtime SOP checker when it learns triggers). */
export function decisionSopSteps(decisions: ExecutiveDecision[]): SOPStep[] {
  const steps: SOPStep[] = [];
  for (const d of decisions) {
    d.sop_obligations.forEach((ob, i) => {
      steps.push({
        step_id: `decision_${d.decision_key}_${i + 1}`,
        name: `On "${d.label}": ${ob.description.slice(0, 60)}`,
        description: `${ob.description} (owed by ${ob.owed_by_function}; detection: ${ob.detection}; triggered by decision_recorded:${d.decision_key})`,
        time_limit_minutes: ob.window_minutes,
      });
    });
  }
  return steps;
}

function uniqueKey(used: Set<string>, wanted: string): string {
  let key = wanted
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 60);
  let n = 2;
  while (used.has(key)) key = `${wanted.slice(0, 56)}_${n++}`;
  used.add(key);
  return key;
}
