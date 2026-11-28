import { z } from 'zod';
import { chatJson, systemUser } from '../ai/chatClient.js';
import { generatePersonasForCountry, type TakenIdentifiers } from '../multiOrgGenerationService.js';
import {
  generatePressureOrgPages,
  ensureSpokespersons,
} from '../pressureOrgGenerationService.js';
import {
  defaultRegisterFor,
  getCatalogCharterByFunction,
  type NormalisedOrg,
  type NormalisedPressureOrg,
  type OrgKind,
  type OrgTeamCharter,
  type PressureKind,
} from '../scenarioOrgModel.js';
import {
  generateSecondaryOrgPages,
  generateTeamStoryline,
  synthesizeTeamCharter,
  type ObjectiveDef,
  type OrgPromptContext,
  type SocialInject,
  type TeamDef,
} from '../socialCrisisGeneratorService.js';
import { generateStakeholdersForOrg } from '../stakeholderGenerationService.js';
import type { TeamCharterWire } from '../warroomBuild/wireSchemas.js';
import { emptyBriefDiff, type BriefDiff } from './affectedLayers.js';
import {
  DELTA_PROMPT_MAX_TOKENS,
  MAX_GATES,
  MAX_NEW_GROUP_PERSONAS,
  MAX_SHARED_INJECTS,
} from './briefRevisionCore.js';
import type { DeltaBuildContext, DeltaGenerators, LayerRevisionResult } from './deltaBuildTypes.js';
import type { SetupSnapshot, SnapshotOrg } from './setupSnapshotCore.js';

const briefDiffSchema = z.object({
  severity: z.enum(['cosmetic', 'facts', 'story']).catch('facts'),
  fact_changes: z
    .array(
      z.object({
        kind: z.enum(['add', 'change', 'remove']).catch('change'),
        old: z.string().optional(),
        new: z.string().optional(),
      }),
    )
    .default([]),
  renamed_entities: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
  added_premises: z.array(z.string()).default([]),
  removed_premises: z.array(z.string()).default([]),
  timeline_change: z.string().optional(),
  affected_layers: z.array(z.string()).optional(),
  new_groups: z.array(z.string()).optional(),
});

const factSheetSchema = z.object({
  confirmed_facts: z.array(z.string()).default([]),
  unconfirmed_claims: z
    .array(
      z.object({
        claim: z.string(),
        status: z.enum(['TRUE', 'FALSE', 'UNVERIFIED']),
        truth: z.string(),
        spread_by: z.array(z.string()).optional(),
      }),
    )
    .default([]),
  crisis_cluster: z.enum(['victim', 'accidental', 'preventable']).optional(),
});

const layerDecisionSchema = z.object({
  inject_id: z.string(),
  decision: z.enum(['keep', 'revise', 'retire']),
  title: z.string().optional(),
  content: z.string().optional(),
  trigger_time_minutes: z.number().optional(),
  conditions_to_appear: z.unknown().optional(),
  conditions_to_cancel: z.unknown().optional(),
  reason: z.string().optional(),
});

const socialInjectSchema = z.object({
  trigger_time_minutes: z.number().optional(),
  type: z.string().default('social_post'),
  title: z.string().default('Update'),
  content: z.string().default(''),
  severity: z.string().default('medium'),
  inject_scope: z.string().default('universal'),
  target_teams: z.array(z.string()).default([]),
  requires_response: z.boolean().optional(),
  conditions_to_appear: z.unknown().optional(),
  conditions_to_cancel: z.array(z.string()).optional(),
  delivery_config: z.record(z.string(), z.unknown()).default({}),
});

const layerRevisionSchema = z.object({
  decisions: z.array(layerDecisionSchema).default([]),
  new_injects: z.array(socialInjectSchema).default([]),
});

const narrativeSchema = z.object({
  narrative: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
      briefing: z.string().optional(),
    })
    .default({}),
  objectives: z
    .array(
      z.object({
        objective_id: z.string(),
        objective_name: z.string(),
        description: z.string().default(''),
        weight: z.number().default(25),
      }),
    )
    .default([]),
});

const stakeholderTextSchema = z.object({
  stakeholders: z
    .array(
      z.object({
        id: z.string(),
        grievance: z.string().default(''),
        knowledge: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

const convergenceSchema = z.object({
  shared: z.array(socialInjectSchema).default([]),
  gates: z.array(socialInjectSchema).default([]),
});

const branchSchema = z.object({
  branches: z.array(socialInjectSchema).default([]),
});

const pageHistorySchema = z.object({
  branded_history: z.unknown(),
});

/**
 * Addition calls go through the create-mode generators. Brief diff, fact sheet,
 * layer revision, narrative, stakeholder text, convergence delta, branches and
 * page history are edit-only and parsed with zod.
 */
export function createDeltaGenerators(): DeltaGenerators {
  return {
    async briefDiff(input) {
      const raw = await ask(
        'Compare the old and new crisis brief. Return JSON with severity (cosmetic|facts|story), fact_changes [{kind, old, new}], renamed_entities [{from, to}], added_premises, removed_premises, timeline_change, affected_layers, new_groups. cosmetic means wording only. affected_layers must use only the layer names listed.',
        `Layers:\n${input.layers.join('\n') || '(none)'}\n\nOld brief:\n${clip(input.oldBrief, 2000)}\n\nNew brief:\n${clip(input.newBrief, 2000)}\n\nFact sheet:\n${clip(JSON.stringify(input.factSheet), 2000)}`,
        'setupEdit.briefDiff',
      );
      return parseBrief(raw);
    },
    async reviseFactSheet(input) {
      const raw = await ask(
        input.appendOnly
          ? 'Append facts the brief adds. Do not delete or reword the trainer\'s facts. Return JSON {confirmed_facts, unconfirmed_claims, crisis_cluster}.'
          : 'Revise the fact sheet. Keep every fact the diff does not add, change, or remove. Return JSON {confirmed_facts, unconfirmed_claims, crisis_cluster}.',
        `${clip(JSON.stringify(input.diff), 2000)}\n\n${clip(JSON.stringify(input.factSheet), 3000)}`,
        'setupEdit.factSheet',
      );
      const parsed = factSheetSchema.safeParse(raw);
      if (!parsed.success) throw new Error('setupEdit.factSheet returned no fact sheet');
      return {
        confirmed_facts: parsed.data.confirmed_facts,
        unconfirmed_claims: parsed.data.unconfirmed_claims,
        crisis_cluster: parsed.data.crisis_cluster ?? input.factSheet.crisis_cluster,
      };
    },
    async generatePersonas(input) {
      const personas = await generatePersonasForCountry(
        crisisOf(input.ctx),
        input.country,
        orgsInCountry(input.ctx, input.country),
        input.ctx.fact_sheet,
        takenOf(input.ctx),
      );
      return personas;
    },
    async generatePersonaGroups(input) {
      return generatePersonasForCountry(
        crisisOf(input.ctx),
        input.ctx.edited.crisis.country,
        [],
        input.ctx.fact_sheet,
        takenOf(input.ctx),
        MAX_NEW_GROUP_PERSONAS,
        undefined,
        { groups: input.groups },
      );
    },
    async generateCharter(input) {
      const org = input.ctx.edited.organisations.find((item) => item.org_key === input.orgKey);
      const team = org?.teams.find((item) => item.team_name === input.teamName);
      const charter = await synthesizeTeamCharter(
        input.teamName,
        team?.description || input.teamName,
        {
          crisisType: input.ctx.edited.crisis.crisis_type,
          context: input.ctx.edited.crisis.context,
          country: org?.country || input.ctx.edited.crisis.country,
          orgName: org?.display_name,
        },
        team?.is_public_voice === true,
        orgPrompt(input.ctx, input.orgKey),
      );
      const wire: TeamCharterWire = {
        team_name: charter.team_name,
        mission: charter.mission,
        responsibilities: charter.responsibilities,
        out_of_lane: charter.out_of_lane,
        scoring_rubric: charter.scoring_rubric,
        expected_actions: charter.expected_actions,
        min_participants: charter.min_participants,
        max_participants: charter.max_participants,
        is_custom: true,
        can_post_publicly: charter.can_post_publicly,
        sentiment_dimension: charter.sentiment_dimension,
        org_key: input.orgKey,
        function_key: team?.function_key,
        country: org?.country,
        short_name: org?.short_name,
      };
      return wire;
    },
    async generateTeamStoryline(input) {
      const org = input.ctx.edited.organisations.find((item) => item.org_key === input.orgKey);
      const team = org?.teams.find((item) => item.team_name === input.teamName);
      const allTeams = teamDefs(input.ctx);
      const injects = await generateTeamStoryline(
        {
          team_name: input.teamName,
          team_description: team?.description || input.teamName,
          min_participants: 1,
          max_participants: 4,
        },
        {
          crisisType: input.ctx.edited.crisis.crisis_type,
          location: org?.city || '',
          country: input.country || org?.country || input.ctx.edited.crisis.country,
          context: input.ctx.edited.crisis.context,
          duration: input.ctx.edited.crisis.duration ?? 60,
          orgName: org?.display_name,
        },
        input.ctx.personas,
        input.ctx.fact_sheet,
        allTeams,
        orgPrompt(input.ctx, input.orgKey),
      );
      return injects;
    },
    async generateStakeholders(input) {
      const org = input.ctx.edited.organisations.find((item) => item.org_key === input.orgKey);
      if (!org) return { stakeholders: [], injects: [] };
      const normalised = normalisedOrg(org);
      const charters = chartersFor(org);
      const result = await generateStakeholdersForOrg(
        normalised,
        charters,
        input.ctx.personas,
        input.ctx.fact_sheet,
        crisisOf(input.ctx),
        takenOf(input.ctx),
        input.ctx.edited.organisations.length > 1,
      );
      return { stakeholders: result.stakeholders, injects: result.injects };
    },
    async generateSpokesperson(input) {
      const pressure = input.ctx.edited.pressure_organisations.find((item) => item.org_key === input.orgKey);
      if (!pressure) return { stakeholder: null, injects: [] };
      const protagonists = input.ctx.edited.organisations.map(normalisedOrg);
      const charters = input.ctx.edited.organisations.flatMap((org) => chartersFor(org));
      const added = await ensureSpokespersons(
        [normalisedPressure(pressure)],
        [],
        protagonists,
        charters,
        crisisOf(input.ctx),
        takenOf(input.ctx),
        protagonists.length > 1,
      );
      const stakeholder = added[0] ?? null;
      return { stakeholder, injects: [] };
    },
    async reviseLayer(input) {
      const raw = await ask(
        'Revise this one layer. For each ai_owned id return decision keep, revise, or retire. revise includes title, content, and optional trigger_time_minutes. Do not change inject_key or app. Ignore hand_edited. Add at most 3 injects for added premises. Return JSON {decisions: [{inject_id, decision, title, content, trigger_time_minutes, reason}], new_injects: []}.',
        `Layer: ${input.layer}\nCountry: ${input.country ?? ''}\nDiff: ${clip(JSON.stringify(input.diff), 1500)}\nOwned: ${clip(JSON.stringify(input.owned), 4000)}\nHand-edited context: ${clip(JSON.stringify(input.handEdited), 1500)}`,
        'setupEdit.reviseLayer',
      );
      const parsed = layerRevisionSchema.safeParse(raw);
      if (!parsed.success) throw new Error('setupEdit.reviseLayer returned no decisions');
      const result: LayerRevisionResult = {
        decisions: parsed.data.decisions,
        new_injects: parsed.data.new_injects.slice(0, 3).map(toSocialInject),
      };
      return result;
    },
    async reviseStakeholderText(input) {
      const raw = await ask(
        'Revise grievance and knowledge for these stakeholders in one reply. Return JSON {stakeholders: [{id, grievance, knowledge: string[]}]}.',
        clip(JSON.stringify({ diff: input.diff, stakeholders: input.stakeholders }), 4000),
        'setupEdit.stakeholderText',
      );
      const parsed = stakeholderTextSchema.safeParse(raw);
      if (!parsed.success) throw new Error('setupEdit.stakeholderText returned no stakeholders');
      return parsed.data.stakeholders;
    },
    async convergenceDelta(input) {
      const raw = await ask(
        `Link the new teams to the existing ones. Return ${MAX_SHARED_INJECTS} or fewer shared injects (at least 2 when you can) and at most ${MAX_GATES} gates. JSON {shared: [], gates: []}.`,
        `New teams: ${input.newTeams.join(', ')}\nExisting: ${input.existingTeams.join(', ')}\nCrisis: ${clip(input.crisis, 400)}`,
        'setupEdit.convergenceDelta',
      );
      const parsed = convergenceSchema.safeParse(raw);
      if (!parsed.success) throw new Error('setupEdit.convergenceDelta returned no injects');
      return {
        shared: parsed.data.shared.slice(0, MAX_SHARED_INJECTS).map(toSocialInject),
        gates: parsed.data.gates.slice(0, MAX_GATES).map(toSocialInject),
      };
    },
    async reviseNarrative(input) {
      const raw = await ask(
        input.keepBriefing
          ? 'Revise the title, description, and objectives. Do not change the briefing. Return JSON {narrative: {title, description, briefing}, objectives: []}.'
          : 'Revise the narrative, briefing, and objectives for the new story. Return JSON {narrative: {title, description, briefing}, objectives: []}.',
        clip(JSON.stringify(input), 4000),
        'setupEdit.narrative',
      );
      const parsed = narrativeSchema.safeParse(raw);
      if (!parsed.success) throw new Error('setupEdit.narrative returned no narrative');
      const objectives: ObjectiveDef[] = parsed.data.objectives;
      return {
        narrative: {
          title: parsed.data.narrative.title || input.narrative.title,
          description: parsed.data.narrative.description || input.narrative.description,
          briefing: input.keepBriefing
            ? input.narrative.briefing
            : parsed.data.narrative.briefing || input.narrative.briefing,
        },
        objectives,
      };
    },
    async regenerateBranches(input) {
      const raw = await ask(
        'Regenerate response branches for this one parent. Return JSON {branches: [{title, content, delivery_config: {app}}]}.',
        `Parent ${input.parentKey}: ${input.parentTitle}\nDiff: ${clip(JSON.stringify(input.diff), 1200)}`,
        'setupEdit.branches',
      );
      const parsed = branchSchema.safeParse(raw);
      if (!parsed.success) throw new Error('setupEdit.branches returned no branches');
      return parsed.data.branches.map((row) => {
        const inject = toSocialInject(row);
        return {
          ...inject,
          delivery_config: { ...inject.delivery_config, parent_inject_key: input.parentKey },
        };
      });
    },
    async generatePages(input) {
      const allies = input.orgs
        .filter((org) => org.role === 'ally')
        .map((org) => rosterEntry(input.ctx, org.org_key, org.name, org.description));
      const rivals = input.orgs
        .filter((org) => org.role === 'rival')
        .map((org) => rosterEntry(input.ctx, org.org_key, org.name, org.description));
      const pressure = input.orgs
        .filter((org) => org.role === 'pressure')
        .map((org) => input.ctx.edited.pressure_organisations.find((item) => item.org_key === org.org_key))
        .filter((org): org is NonNullable<typeof org> => !!org)
        .map(normalisedPressure);
      const primary = input.ctx.edited.organisations.find((org) => org.is_primary) ?? input.ctx.edited.organisations[0];
      const pages: Array<Record<string, unknown>> = [];
      if (allies.length > 0 || rivals.length > 0) {
        const secondary = await generateSecondaryOrgPages(
          input.ctx.edited.crisis.crisis_type,
          primary?.country || input.ctx.edited.crisis.country,
          primary?.display_name || input.ctx.edited.crisis.org_name,
          { allies, competitors: rivals, auto_antagonist: false },
        );
        pages.push(...secondary.map(pageRecord));
      }
      if (pressure.length > 0) {
        const generated = await generatePressureOrgPages(
          pressure,
          input.ctx.edited.organisations.map(normalisedOrg),
          crisisOf(input.ctx),
          input.ctx.fact_sheet,
        );
        pages.push(...generated.map(pageRecord));
      }
      return pages;
    },
    async revisePageHistory(input) {
      const raw = await ask(
        'Revise this one page\'s branded history for the new premise. Return JSON {branded_history: []}.',
        `Org: ${input.orgKey}\nCountry: ${input.country ?? ''}\nDiff: ${clip(JSON.stringify(input.diff), 1200)}\nHistory: ${clip(JSON.stringify(input.history), 2500)}`,
        'setupEdit.pageHistory',
      );
      const parsed = pageHistorySchema.safeParse(raw);
      if (!parsed.success) return input.history;
      return parsed.data.branded_history ?? input.history;
    },
  };
}

function parseBrief(raw: Record<string, unknown>): BriefDiff {
  const parsed = briefDiffSchema.safeParse(raw);
  if (!parsed.success) throw new Error('setupEdit.briefDiff returned no diff');
  const diff = emptyBriefDiff(parsed.data.severity);
  diff.fact_changes = parsed.data.fact_changes;
  diff.renamed_entities = parsed.data.renamed_entities.filter((row) => row.from && row.to);
  diff.added_premises = parsed.data.added_premises;
  diff.removed_premises = parsed.data.removed_premises;
  if (parsed.data.timeline_change) diff.timeline_change = parsed.data.timeline_change;
  if (parsed.data.affected_layers && parsed.data.affected_layers.length > 0) {
    diff.affected_layers = parsed.data.affected_layers;
  }
  if (parsed.data.new_groups && parsed.data.new_groups.length > 0) diff.new_groups = parsed.data.new_groups;
  return diff;
}

function toSocialInject(row: z.infer<typeof socialInjectSchema>): SocialInject {
  const app = typeof row.delivery_config.app === 'string' ? row.delivery_config.app : 'social_feed';
  return {
    type: row.type,
    title: row.title,
    content: row.content,
    severity: row.severity,
    inject_scope: row.inject_scope,
    target_teams: row.target_teams,
    trigger_time_minutes: row.trigger_time_minutes,
    requires_response: row.requires_response,
    conditions_to_appear: row.conditions_to_appear as SocialInject['conditions_to_appear'],
    conditions_to_cancel: row.conditions_to_cancel,
    delivery_config: { ...row.delivery_config, app: app as SocialInject['delivery_config']['app'] },
  };
}

async function ask(system: string, user: string, label: string): Promise<Record<string, unknown>> {
  const result = await chatJson<Record<string, unknown>>({
    tier: 'standard',
    messages: systemUser(system, user),
    json: true,
    maxTokens: DELTA_PROMPT_MAX_TOKENS,
    temperature: 0.4,
    timeoutMs: 120_000,
    retry: { attempts: 3, baseDelayMs: 1_000 },
    label,
    throwOnError: true,
  });
  if (!result || typeof result !== 'object') throw new Error(`${label} returned no JSON`);
  return result;
}

function crisisOf(ctx: DeltaBuildContext) {
  return {
    crisisType: ctx.edited.crisis.crisis_type,
    context: ctx.edited.crisis.context,
    duration: ctx.edited.crisis.duration ?? 60,
    orgName: ctx.edited.crisis.org_name,
  };
}

function takenOf(ctx: DeltaBuildContext): TakenIdentifiers {
  return {
    handles: new Set(ctx.taken_handles),
    emails: new Set(ctx.taken_emails),
    ids: new Set(ctx.taken_stakeholder_ids),
  };
}

function orgsInCountry(ctx: DeltaBuildContext, country: string): NormalisedOrg[] {
  return ctx.edited.organisations.filter((org) => org.country === country).map(normalisedOrg);
}

function normalisedOrg(org: SnapshotOrg): NormalisedOrg {
  return {
    org_key: org.org_key,
    org_uid: org.org_uid,
    display_name: org.display_name,
    short_name: org.short_name,
    country: org.country,
    city: org.city,
    kind: orgKind(org.kind),
    facebook_handle: org.facebook_handle,
    x_handle: org.x_handle,
    is_primary: org.is_primary,
    operation: org.operation,
    teams: org.teams.map((team) => ({
      team_name: team.team_name,
      function_key: team.function_key,
      description: team.description,
      is_custom: team.is_custom,
      is_public_voice: team.is_public_voice,
    })),
  };
}

function normalisedPressure(org: SetupSnapshot['pressure_organisations'][number]): NormalisedPressureOrg {
  const kind = pressureKind(org.kind);
  return {
    org_key: org.org_key,
    display_name: org.display_name,
    short_name: org.display_name.slice(0, 20),
    kind,
    country: org.country,
    city: org.city,
    register: pressureRegister(org.register) ?? defaultRegisterFor(kind),
    wants: org.wants,
    facebook_handle: org.facebook_handle,
    x_handle: org.x_handle,
    targets_org_keys: org.targets_org_keys,
  };
}

function chartersFor(org: SnapshotOrg): OrgTeamCharter[] {
  return org.teams.map((team) => {
    const catalog = getCatalogCharterByFunction(team.function_key);
    return {
      team_name: team.team_name,
      mission: catalog?.mission || team.description || team.team_name,
      responsibilities: catalog?.responsibilities ?? [team.description || team.team_name],
      expected_actions: catalog?.expected_actions ?? [],
      scoring_rubric: catalog?.scoring_rubric ?? '',
      out_of_lane: catalog?.out_of_lane ?? [],
      min_participants: catalog?.min_participants ?? 1,
      max_participants: catalog?.max_participants ?? 4,
      is_custom: team.is_custom,
      can_post_publicly: team.is_public_voice,
      sentiment_dimension: catalog?.sentiment_dimension ?? 'public_trust',
      org_key: org.org_key,
      function_key: team.function_key,
      country: org.country,
      short_name: org.short_name,
    };
  });
}

function teamDefs(ctx: DeltaBuildContext): TeamDef[] {
  return ctx.edited.organisations.flatMap((org) =>
    org.teams.map((team) => ({
      team_name: team.team_name,
      team_description: team.description,
      min_participants: 1,
      max_participants: 4,
    })),
  );
}

function orgPrompt(ctx: DeltaBuildContext, orgKey: string): OrgPromptContext | null {
  const org = ctx.edited.organisations.find((item) => item.org_key === orgKey);
  if (!org) return null;
  return {
    display_name: org.display_name,
    short_name: org.short_name,
    country: org.country,
    city: org.city,
    kind: org.kind,
    other_orgs: ctx.edited.organisations
      .filter((item) => item.org_key !== orgKey)
      .map((item) => ({
        display_name: item.display_name,
        country: item.country,
        same_country: item.country === org.country,
      })),
  };
}

function rosterEntry(ctx: DeltaBuildContext, orgKey: string, name: string, description?: string) {
  const rival = ctx.edited.competitors.find((item) => item.org_key === orgKey);
  const ally = ctx.edited.organisations.find((item) => item.org_key === orgKey);
  const source = ally ?? rival;
  return {
    name,
    org_key: orgKey,
    country: ally?.country || rival?.country || ctx.edited.crisis.country,
    city: ally?.city,
    kind: ally?.kind,
    description: description || rival?.description,
    facebook_handle: source && 'facebook_handle' in source ? source.facebook_handle : undefined,
    x_handle: source && 'x_handle' in source ? source.x_handle : undefined,
  };
}

function orgKind(kind: string): OrgKind {
  if (kind === 'office' || kind === 'agency' || kind === 'ngo' || kind === 'other' || kind === 'company') {
    return kind;
  }
  return 'other';
}

function pressureKind(kind: string | undefined): PressureKind {
  if (kind === 'union' || kind === 'regulator' || kind === 'ngo' || kind === 'community_group' || kind === 'political') {
    return kind;
  }
  return 'ngo';
}

function pressureRegister(
  register: string | undefined,
): 'statutory' | 'advocacy' | 'grassroots' | 'political' | undefined {
  if (register === 'statutory' || register === 'advocacy' || register === 'grassroots' || register === 'political') {
    return register;
  }
  return undefined;
}

function pageRecord(page: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(page)) out[key] = value;
  return out;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
