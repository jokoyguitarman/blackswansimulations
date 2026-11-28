import { chatJson, systemUser } from '../ai/chatClient.js';
import type { Stakeholder } from '../../lib/stakeholderContract.js';
import type { FactSheet, NPCPersona, ObjectiveDef, SocialInject } from '../socialCrisisGeneratorService.js';
import type { TeamCharterWire } from '../warroomBuild/wireSchemas.js';
import { emptyBriefDiff, type BriefDiff } from './affectedLayers.js';
import type { DeltaGenerators, LayerRevisionResult } from './deltaBuildTypes.js';

/**
 * One chat call per generator. Layer revisions send a single layer.
 * Tests never use this object; they pass stubs.
 */
export function createDeltaGenerators(): DeltaGenerators {
  return {
    async briefDiff(input) {
      const raw = await ask(
        'Compare the old and new crisis brief. Return JSON: severity (cosmetic|facts|story), fact_changes [{kind, old, new}], renamed_entities [{from, to}], added_premises, removed_premises, timeline_change, affected_layers, new_groups. cosmetic means wording only.',
        `Old brief:\n${clip(input.oldBrief, 2000)}\n\nNew brief:\n${clip(input.newBrief, 2000)}\n\nFact sheet:\n${clip(JSON.stringify(input.factSheet), 2000)}`,
        'setupEdit.briefDiff',
      );
      return normaliseDiff(raw);
    },
    async reviseFactSheet(input) {
      const raw = await ask(
        input.appendOnly
          ? 'Append facts the brief adds. Do not delete or reword the trainer\'s facts. Return JSON {confirmed_facts, unconfirmed_claims, crisis_cluster}.'
          : 'Revise the fact sheet. Keep every fact the diff does not add, change, or remove. Return JSON {confirmed_facts, unconfirmed_claims, crisis_cluster}.',
        `${clip(JSON.stringify(input.diff), 2000)}\n\n${clip(JSON.stringify(input.factSheet), 3000)}`,
        'setupEdit.factSheet',
      );
      return normaliseFactSheet(raw, input.factSheet);
    },
    async generatePersonas(input) {
      const raw = await ask(
        'Generate personas for one country. Existing handles are taken. Return JSON {personas: [{handle, name, type, personality, bias, follower_count, backstory, posting_pattern, specific_claims, country}]}.',
        `Country: ${input.country}\nCrisis: ${clip(input.crisis, 500)}\nTaken: ${input.takenHandles.slice(0, 40).join(' ')}`,
        'setupEdit.personas',
      );
      return asArray(raw, 'personas').map((row, index) => asPersona(row, input.country, index));
    },
    async generatePersonaGroups(input) {
      const raw = await ask(
        'Generate at most 10 personas for the named groups. Return JSON {personas: [...] } with the same persona fields.',
        `Groups: ${input.groups.join('; ')}\nCrisis: ${clip(input.crisis, 500)}\nTaken: ${input.takenHandles.slice(0, 40).join(' ')}`,
        'setupEdit.personaGroups',
      );
      return asArray(raw, 'personas').slice(0, 10).map((row, index) => asPersona(row, '', index));
    },
    async generateCharter(input) {
      const raw = await ask(
        'Write one team charter. Return JSON {team_name, mission, responsibilities: string[]}.',
        `Team: ${input.teamName}\nOrganisation: ${input.orgName}\nCrisis: ${clip(input.crisis, 500)}`,
        'setupEdit.charter',
      );
      const row = asRecord(raw);
      const charter: TeamCharterWire = {
        team_name: text(row.team_name) || input.teamName,
        mission: text(row.mission) || input.teamName,
        responsibilities: asStrings(row.responsibilities),
      };
      return charter;
    },
    async generateTeamStoryline(input) {
      const raw = await ask(
        'Write the storyline injects for one team. Return JSON {injects: [{title, content, type, severity, trigger_time_minutes, target_teams, delivery_config: {app}}]}.',
        `Team: ${input.teamName}\nOrganisation: ${input.orgName}\nCountry: ${input.country ?? ''}\nCrisis: ${clip(input.crisis, 500)}`,
        'setupEdit.teamStoryline',
      );
      return asArray(raw, 'injects').map((row) => asInject(row, [input.teamName]));
    },
    async generateStakeholders(input) {
      const raw = await ask(
        'Add stakeholders for one organisation. Do not reuse taken ids, emails, or handles. Return JSON {stakeholders: [], injects: []}.',
        `Org: ${input.orgName} (${input.orgKey})\nCrisis: ${clip(input.crisis, 400)}\nTaken ids: ${input.takenIds.slice(0, 30).join(' ')}`,
        'setupEdit.stakeholders',
      );
      return {
        stakeholders: asArray(raw, 'stakeholders') as Stakeholder[],
        injects: asArray(raw, 'injects').map((row) => asInject(row, [])),
      };
    },
    async generateSpokesperson(input) {
      const raw = await ask(
        'Create one spokesperson and their injects for a pressure group. Return JSON {stakeholder, injects}.',
        `Group: ${input.name} (${input.orgKey})\nWants: ${clip(input.wants, 300)}\nCrisis: ${clip(input.crisis, 300)}`,
        'setupEdit.spokesperson',
      );
      const row = asRecord(raw);
      const stakeholder = asRecord(row.stakeholder);
      return {
        stakeholder: text(stakeholder.id) ? (stakeholder as unknown as Stakeholder) : null,
        injects: asArray(raw, 'injects').map((item) => asInject(item, [])),
      };
    },
    async reviseLayer(input) {
      const raw = await ask(
        'Revise this one layer. For each ai_owned id return decision keep, revise, or retire. revise includes title, content, and optional trigger_time_minutes. Do not change inject_key or app. Ignore hand_edited. Add at most 3 injects for added premises. Return JSON {decisions: [{inject_id, decision, title, content, trigger_time_minutes, reason}], new_injects: []}.',
        `Layer: ${input.layer}\nCountry: ${input.country ?? ''}\nDiff: ${clip(JSON.stringify(input.diff), 1500)}\nOwned: ${clip(JSON.stringify(input.owned), 4000)}\nHand-edited context: ${clip(JSON.stringify(input.handEdited), 1500)}`,
        'setupEdit.reviseLayer',
      );
      const result: LayerRevisionResult = {
        decisions: asArray(raw, 'decisions').map((row) => ({
          inject_id: text(asRecord(row).inject_id),
          decision: decisionOf(asRecord(row).decision),
          title: text(asRecord(row).title) || undefined,
          content: text(asRecord(row).content) || undefined,
          trigger_time_minutes: numberOrUndefined(asRecord(row).trigger_time_minutes),
          conditions_to_appear: asRecord(row).conditions_to_appear,
          conditions_to_cancel: asRecord(row).conditions_to_cancel,
          reason: text(asRecord(row).reason) || undefined,
        })),
        new_injects: asArray(raw, 'new_injects').slice(0, 3).map((row) => asInject(row, [])),
      };
      return result;
    },
    async reviseStakeholderText(input) {
      const raw = await ask(
        'Revise grievance and knowledge for these stakeholders in one reply. Return JSON {stakeholders: [{id, grievance, knowledge: string[]}]}.',
        clip(JSON.stringify({ diff: input.diff, stakeholders: input.stakeholders }), 4000),
        'setupEdit.stakeholderText',
      );
      return asArray(raw, 'stakeholders').map((row) => ({
        id: text(asRecord(row).id),
        grievance: text(asRecord(row).grievance),
        knowledge: asStrings(asRecord(row).knowledge),
      }));
    },
    async convergenceDelta(input) {
      const raw = await ask(
        'Link the new teams to the existing ones. Return 2 to 4 shared injects and at most 2 gates. JSON {shared: [], gates: []}.',
        `New teams: ${input.newTeams.join(', ')}\nExisting: ${input.existingTeams.join(', ')}\nCrisis: ${clip(input.crisis, 400)}`,
        'setupEdit.convergenceDelta',
      );
      return {
        shared: asArray(raw, 'shared').slice(0, 4).map((row) => asInject(row, [])),
        gates: asArray(raw, 'gates').slice(0, 2).map((row) => asInject(row, [])),
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
      const row = asRecord(raw);
      const narrative = asRecord(row.narrative);
      return {
        narrative: {
          title: text(narrative.title) || input.narrative.title,
          description: text(narrative.description) || input.narrative.description,
          briefing: input.keepBriefing
            ? input.narrative.briefing
            : text(narrative.briefing) || input.narrative.briefing,
        },
        objectives: asArray(raw, 'objectives').map((item, index) => asObjective(item, input.objectives[index])),
      };
    },
    async regenerateBranches(input) {
      const raw = await ask(
        'Regenerate response branches for this one parent. Return JSON {branches: [{title, content, delivery_config: {app, parent_inject_key}}]}.',
        `Parent ${input.parentKey}: ${input.parentTitle}\nDiff: ${clip(JSON.stringify(input.diff), 1200)}`,
        'setupEdit.branches',
      );
      return asArray(raw, 'branches').map((row) => {
        const inject = asInject(row, []);
        return {
          ...inject,
          delivery_config: { ...inject.delivery_config, parent_inject_key: input.parentKey },
        };
      });
    },
    async generatePages(input) {
      const raw = await ask(
        'Write pages for this batch only. Return JSON {pages: [{org_key, display_name, stance, branded_history: []}]}.',
        `Crisis: ${clip(input.crisis, 400)}\nOrgs: ${clip(JSON.stringify(input.orgs), 2500)}`,
        'setupEdit.pages',
      );
      return asArray(raw, 'pages').map((row) => asRecord(row));
    },
    async revisePageHistory(input) {
      const raw = await ask(
        'Revise this one page\'s branded history for the new premise. Return JSON {branded_history: []}.',
        `Org: ${input.orgKey}\nCountry: ${input.country ?? ''}\nDiff: ${clip(JSON.stringify(input.diff), 1200)}\nHistory: ${clip(JSON.stringify(input.history), 2500)}`,
        'setupEdit.pageHistory',
      );
      const row = asRecord(raw);
      return row.branded_history ?? input.history;
    },
  };
}

async function ask(system: string, user: string, label: string): Promise<Record<string, unknown>> {
  const result = await chatJson<Record<string, unknown>>({
    tier: 'standard',
    messages: systemUser(system, user),
    json: true,
    maxTokens: 2500,
    temperature: 0.4,
    timeoutMs: 120_000,
    retry: { attempts: 3, baseDelayMs: 1_000 },
    label,
    throwOnError: true,
  });
  if (!result) throw new Error(`${label} returned no JSON`);
  return result;
}

function normaliseDiff(raw: Record<string, unknown>): BriefDiff {
  const severity = raw.severity === 'cosmetic' || raw.severity === 'facts' || raw.severity === 'story'
    ? raw.severity
    : 'facts';
  const diff = emptyBriefDiff(severity);
  diff.fact_changes = asArray(raw, 'fact_changes').map((row) => {
    const item = asRecord(row);
    const kind = item.kind === 'add' || item.kind === 'remove' || item.kind === 'change' ? item.kind : 'change';
    return { kind, old: text(item.old) || undefined, new: text(item.new) || undefined };
  });
  diff.renamed_entities = asArray(raw, 'renamed_entities').map((row) => ({
    from: text(asRecord(row).from),
    to: text(asRecord(row).to),
  })).filter((row) => row.from && row.to);
  diff.added_premises = asStrings(raw.added_premises);
  diff.removed_premises = asStrings(raw.removed_premises);
  const timeline = text(raw.timeline_change);
  if (timeline) diff.timeline_change = timeline;
  const layers = asStrings(raw.affected_layers);
  if (layers.length > 0) diff.affected_layers = layers;
  const groups = asStrings(raw.new_groups);
  if (groups.length > 0) diff.new_groups = groups;
  return diff;
}

function normaliseFactSheet(raw: Record<string, unknown>, current: FactSheet): FactSheet {
  return {
    confirmed_facts: asStrings(raw.confirmed_facts).length > 0 ? asStrings(raw.confirmed_facts) : current.confirmed_facts,
    unconfirmed_claims: Array.isArray(raw.unconfirmed_claims)
      ? (raw.unconfirmed_claims as FactSheet['unconfirmed_claims'])
      : current.unconfirmed_claims,
    crisis_cluster:
      raw.crisis_cluster === 'victim' || raw.crisis_cluster === 'accidental' || raw.crisis_cluster === 'preventable'
        ? raw.crisis_cluster
        : current.crisis_cluster,
  };
}

function asPersona(raw: unknown, country: string, index: number): NPCPersona {
  const row = asRecord(raw);
  return {
    handle: text(row.handle) || `@persona_${index + 1}`,
    name: text(row.name) || `Persona ${index + 1}`,
    type: personaType(row.type),
    personality: text(row.personality),
    bias: text(row.bias) || 'none',
    follower_count: typeof row.follower_count === 'number' ? row.follower_count : 100,
    backstory: text(row.backstory),
    posting_pattern: text(row.posting_pattern),
    specific_claims: asStrings(row.specific_claims),
    country: text(row.country) || country || undefined,
  };
}

function asInject(raw: unknown, teams: string[]): SocialInject {
  const row = asRecord(raw);
  const delivery = asRecord(row.delivery_config);
  const app = text(delivery.app) || 'social_feed';
  return {
    type: text(row.type) || 'social_post',
    title: text(row.title) || 'Update',
    content: text(row.content),
    severity: text(row.severity) || 'medium',
    inject_scope: text(row.inject_scope) || (teams.length > 0 ? 'team_specific' : 'universal'),
    target_teams: asStrings(row.target_teams).length > 0 ? asStrings(row.target_teams) : teams,
    trigger_time_minutes: numberOrUndefined(row.trigger_time_minutes),
    requires_response: row.requires_response === true,
    conditions_to_appear: row.conditions_to_appear as SocialInject['conditions_to_appear'],
    conditions_to_cancel: Array.isArray(row.conditions_to_cancel)
      ? (row.conditions_to_cancel as string[])
      : undefined,
    delivery_config: {
      ...delivery,
      app: app as SocialInject['delivery_config']['app'],
      ...(text(delivery.inject_key) ? { inject_key: text(delivery.inject_key) } : {}),
    },
  };
}

function asObjective(raw: unknown, fallback: ObjectiveDef | undefined): ObjectiveDef {
  const row = asRecord(raw);
  return {
    objective_id: text(row.objective_id) || fallback?.objective_id || 'objective',
    objective_name: text(row.objective_name) || fallback?.objective_name || 'Objective',
    description: text(row.description) || fallback?.description || '',
    weight: typeof row.weight === 'number' ? row.weight : fallback?.weight ?? 25,
  };
}

function decisionOf(value: unknown): 'keep' | 'revise' | 'retire' {
  return value === 'revise' || value === 'retire' || value === 'keep' ? value : 'keep';
}

function personaType(value: unknown): NPCPersona['type'] {
  if (
    value === 'npc_public' ||
    value === 'npc_media' ||
    value === 'npc_politician' ||
    value === 'npc_influencer'
  ) {
    return value;
  }
  return 'npc_public';
}

function asArray(raw: Record<string, unknown> | unknown, key: string): unknown[] {
  const row = asRecord(raw);
  return Array.isArray(row[key]) ? row[key] : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
