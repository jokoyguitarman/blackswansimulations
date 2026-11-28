/**
 * Response-branch stage (WP8 §8.2.4). One standard-tier JSON call per 10 parent
 * injects. Tests pass a fake client; the default client is the shared chat client.
 */

import { logger } from '../../lib/logger.js';
import { stampGeneratedInjectKeys } from '../../lib/injectKey.js';
import { catalogPromptBlock } from '../conditions/conditionCatalog.js';
import { deriveGenericRubric, readAuthoredRubric } from '../judging/judgeCore.js';
import type { FactSheet, SocialInject } from '../socialCrisisGeneratorService.js';
import { chatJson, systemUser, type ChatOptions } from '../ai/chatClient.js';
import type { EscalationConfig } from '../escalation/escalationCore.js';
import {
  bindParentKeys,
  coverageReport,
  parentAlreadyBranched,
  postProcessResponseBranches,
  selectBranchParents,
  stripBranchCarry,
  type BranchInject,
  type BranchParent,
  type BranchRubricUpdate,
  type CoverageReport,
} from './responseBranchesCore.js';
import {
  applyPhoneRedials,
  goPublicInject,
  goPublicKeyFor,
  isChainRoot,
  postProcessEscalation,
  postProcessMoodLadder,
  pruneDoubleChase,
  stakeholdersForLadders,
  type ChainRepairContext,
  type ChainStakeholder,
} from './chainLadderCore.js';

const BRANCH_PLATFORMS = ['email', 'call', 'chat', 'dm', 'social', 'cross', 'stakeholder'] as const;
const BATCH_SIZE = 10;
const LADDER_BATCH = 6;

export interface BranchStakeholder {
  id: string;
  name?: string | null;
  relationship?: string | null;
  persuadability?: string | null;
  tier?: string | null;
  organisation?: string | null;
  title?: string | null;
  personality?: string | null;
  stance?: string | null;
  owning_team?: string | null;
  mood_ladder?: unknown;
}

export interface BranchCrisisContext {
  crisisType: string;
  duration: number;
  context?: string;
  country?: string;
  location?: string;
  orgName?: string;
}

export interface ResponseBranchChatRequest {
  system: string;
  user: string;
}

export interface ResponseBranchClient {
  complete(request: ResponseBranchChatRequest): Promise<unknown>;
}

export interface GenerateBranchesOptions {
  client?: ResponseBranchClient;
  /** When set, only these parent keys are sent to the model. */
  onlyParentKeys?: ReadonlySet<string>;
}

const CONSEQUENCE_GUIDANCE =
  'A consequence lands where a real one would — an ignored supplier emails again, then phones; a community leader posts publicly; a regulator writes a formal email.';

export function responseBranchChatOptions(system: string, user: string): ChatOptions {
  return {
    tier: 'standard',
    messages: systemUser(system, user),
    json: true,
    maxTokens: 8000,
    temperature: 0.7,
    timeoutMs: 240_000,
    retry: { attempts: 5, baseDelayMs: 2_000 },
    growOnTruncation: true,
    label: 'generator.responseBranches',
  };
}

const defaultClient: ResponseBranchClient = {
  async complete(request) {
    return chatJson(responseBranchChatOptions(request.system, request.user));
  },
};

export function ensureInjectKeys(injects: SocialInject[]): void {
  const stamped = stampGeneratedInjectKeys(injects);
  stamped.forEach((row, index) => {
    injects[index].delivery_config = row.delivery_config as unknown as SocialInject['delivery_config'];
  });
}

export async function generateResponseBranches(
  injects: SocialInject[],
  stakeholders: readonly BranchStakeholder[],
  factSheet: FactSheet,
  crisisContext: BranchCrisisContext,
  options: GenerateBranchesOptions = {},
): Promise<{ branches: SocialInject[]; rubrics: BranchRubricUpdate[] }> {
  ensureInjectKeys(injects);
  const duration = crisisContext.duration > 0 ? crisisContext.duration : 60;
  const relationships = new Map(stakeholders.map((stakeholder) => [stakeholder.id, stakeholder]));
  let parents = selectBranchParents(injects as unknown as BranchInject[], duration).map((parent) => {
    const stakeholder = parent.stakeholder_id ? relationships.get(parent.stakeholder_id) : undefined;
    return stakeholder?.relationship ? { ...parent, relationship: stakeholder.relationship } : parent;
  });
  if (options.onlyParentKeys) {
    parents = parents.filter((parent) => options.onlyParentKeys?.has(parent.inject_key));
  }
  if (parents.length === 0) return { branches: [], rubrics: [] };

  const client = options.client ?? defaultClient;
  const taken = new Set(
    injects
      .map((inject) => inject.delivery_config?.inject_key)
      .filter((key): key is string => typeof key === 'string'),
  );
  const branches: SocialInject[] = [];
  const rubrics: BranchRubricUpdate[] = [];
  for (let offset = 0; offset < parents.length; offset += BATCH_SIZE) {
    const batch = parents.slice(offset, offset + BATCH_SIZE);
    const request = {
      system: branchSystemPrompt(),
      user: branchUserPrompt(batch, stakeholders, factSheet, crisisContext),
    };
    let raw: unknown = null;
    try {
      raw = await client.complete(request);
    } catch (err) {
      logger.warn({ err, event: 'response_branches_failed' }, 'Response branch batch failed');
    }
    const model =
      raw && typeof raw === 'object'
        ? (raw as { branches?: unknown; rubrics?: unknown; escalations?: unknown })
        : {};
    const processed = postProcessResponseBranches(model, batch, duration, taken);
    if (raw && typeof raw === 'object' && 'escalations' in (raw as object)) {
      applyModelEscalations(
        model.escalations,
        batch,
        injects,
        stakeholders,
        duration,
        conditionalKeysOf(injects, processed.branches),
      );
      processed.branches = pruneDoubleChase(
        processed.branches,
        chainsOn(injects, batch.map((parent) => parent.inject_key)),
      );
    }
    applyPhoneRedials(processed.branches, stakeholders);
    branches.push(...(processed.branches as unknown as SocialInject[]));
    rubrics.push(...processed.rubrics);
    for (const key of processed.branches) {
      const injectKey = key.delivery_config?.inject_key;
      if (typeof injectKey === 'string') taken.add(injectKey);
    }
  }
  applyRubrics(injects, rubrics);
  applyPhoneRedials(injects as unknown as BranchInject[], stakeholders);
  return { branches, rubrics };
}

export async function attachResponseBranches(input: {
  crisis: BranchCrisisContext;
  factSheet: FactSheet;
  stakeholders: readonly BranchStakeholder[];
  injects: SocialInject[];
  branchSink: SocialInject[];
  client?: ResponseBranchClient;
  /** Drop round-trip fields after rubrics have been copied onto the parents. */
  stripCarry?: boolean;
}): Promise<CoverageReport> {
  const pool = dedupe(input.injects);
  bindParentKeys(pool as unknown as BranchInject[]);
  ensureInjectKeys(pool);
  const duration = input.crisis.duration > 0 ? input.crisis.duration : 60;
  const relationships = new Map(
    input.stakeholders.map((stakeholder) => [stakeholder.id, stakeholder.relationship]),
  );
  const parents = selectBranchParents(pool as unknown as BranchInject[], duration).map((parent) => {
    const relationship = parent.stakeholder_id ? relationships.get(parent.stakeholder_id) : undefined;
    return relationship ? { ...parent, relationship } : parent;
  });
  const pendingKeys = new Set(
    parents
      .filter((parent) => !parentAlreadyBranched(parent, pool as unknown as BranchInject[]))
      .map((parent) => parent.inject_key),
  );
  if (pendingKeys.size > 0) {
    const generated = await generateResponseBranches(
      pool,
      input.stakeholders,
      input.factSheet,
      input.crisis,
      { client: input.client, onlyParentKeys: pendingKeys },
    );
    for (const branch of generated.branches) {
      if (pool.includes(branch) || input.branchSink.includes(branch)) continue;
      input.branchSink.push(branch);
      pool.push(branch);
    }
  }
  await ensureChainsRedialsAndLadders({
    pool,
    branchSink: input.branchSink,
    stakeholders: input.stakeholders,
    duration,
    crisis: input.crisis,
    factSheet: input.factSheet,
    client: input.client,
  });
  applyRubrics(
    pool,
    parents.map((parent) => ({
      inject_key: parent.inject_key,
      rubric: carriedRubric(pool, parent) ?? genericFor(parent),
    })),
  );
  if (input.stripCarry) {
    for (const inject of pool) {
      if (inject.delivery_config?.branch) stripBranchCarry(inject as unknown as BranchInject);
    }
  }
  const report = coverageReport(pool as unknown as BranchInject[], input.stakeholders);
  logger.info(
    {
      event: 'conditional_coverage',
      by_platform: report.by_platform,
      chained_roots: report.chained_roots,
      redialing_calls: report.redialing_calls,
      stakeholders_with_ladder: report.stakeholders_with_ladder,
      gave_up_consequences: report.gave_up_consequences,
    },
    'Conditional inject coverage',
  );
  if (report.gaps.length > 0) {
    logger.warn(
      { event: 'conditional_coverage_gap', gaps: report.gaps, by_platform: report.by_platform },
      'A delivery platform has no conditional inject',
    );
  }
  return report;
}

function carriedRubric(injects: readonly SocialInject[], parent: BranchParent) {
  for (const inject of injects) {
    const config = inject.delivery_config;
    if (!config?.branch) continue;
    if (config.parent_inject_key !== parent.inject_key && config.parent_title !== parent.title) continue;
    if (config.parent_response_rubric && readAuthoredRubric(config.parent_response_rubric)) {
      return config.parent_response_rubric;
    }
  }
  return null;
}

function genericFor(parent: BranchParent) {
  return deriveGenericRubric(
    {
      content: parent.content,
      stakeholder: parent.relationship ? { relationship: parent.relationship } : null,
    },
    null,
  );
}

function applyRubrics(injects: readonly SocialInject[], rubrics: readonly BranchRubricUpdate[]): void {
  const byKey = new Map(rubrics.map((row) => [row.inject_key, row.rubric]));
  for (const inject of injects) {
    const key = inject.delivery_config?.inject_key;
    if (!key || !byKey.has(key)) continue;
    if (readAuthoredRubric(inject.delivery_config?.response_rubric)) continue;
    inject.delivery_config = {
      ...inject.delivery_config,
      response_rubric: byKey.get(key),
    };
  }
}

function branchSystemPrompt(): string {
  return `You write conditional response branches for a crisis-communications exercise.

For every parent inject (an email, phone call, or direct message that asks for a reply, or that comes from a stakeholder), return 2 to 4 branches:
- no_reply: appears on unresponded:<inject_key>:<window>, or email_unreplied / dm_unanswered / call_missed / call_unreturned for that channel. Cancel on responded:<inject_key>, or email_replied / call_answered for that channel.
- poor_reply: appears on reply_failed:<inject_key> or reply_tone:<inject_key>:dismissive|defensive|hostile. Cancel on reply_best_passed:<inject_key>.
- good_reply: appears on reply_passed:<inject_key>. A thank-you or a de-escalation. Cancel on reply_failed:<inject_key>.
- risky_admission (optional): appears on reply_risky_admission:<inject_key> and escalates to legal or a regulator.

${CONSEQUENCE_GUIDANCE}
delivery_config.app is one of social_feed, email, group_chat, phone_call, news, messenger_dm, npc_dm.
Use only condition keys from this catalogue:
${catalogPromptBlock(BRANCH_PLATFORMS)}

Also return a response_rubric for each parent: asks, 3 or 4 criteria, expected_tone, pass_threshold.
An explicit empty conditions_to_cancel means the branch is not cancelled. Omit conditions_to_cancel only when you want the default cancel.

Also return an escalation chain for every parent:
- 2 to 4 steps. Urgency never decreases (reminder, follow_up, urgent, final, escalated).
- after_minutes is an integer from 3 to 15, and the whole chain finishes inside the scenario duration.
- At least one step changes channel. Email, then a text (npc_dm or messenger_dm), then a phone call is the usual pattern.
- The last step is either urgency escalated from a more senior stakeholder in the same organisation (use only ids from the stakeholder list; never invent a person) or a public social_feed post.
- Templates use placeholders ({ask}, {minutes_waiting}, {sender_name}, {recipient_team}, {root_minute}, {followups_sent}, {missed_calls}) and do not state a literal number of minutes.
- For a parent that has a chain, do not also write no_reply chasers except one final public consequence. That consequence is on_exhausted.publish_inject_key.

Return ONLY JSON:
{ "branches": [ { "parent_inject_key": "...", "branch": "no_reply|poor_reply|good_reply|risky_admission", "title": "...", "content": "...", "type": "email_inbound|phone_call|social_post|chat_message|dm", "delivery_config": { "app": "...", "inject_key": "..." }, "conditions_to_appear": { "all": ["..."] }, "conditions_to_cancel": ["..."], "eligible_after_minutes": 0 } ], "rubrics": [ { "inject_key": "...", "asks": ["..."], "criteria": ["..."], "expected_tone": ["..."], "pass_threshold": 2 } ], "escalations": [ { "inject_key": "...", "escalation": { "max_steps": 3, "scope": "per_team", "stop_on": "any_response", "stop_on_contact": true, "steps": [ { "after_minutes": 5, "urgency": "follow_up", "app": "npc_dm", "content_mode": "template", "template": "Following up. Could you confirm {ask}?" } ], "on_exhausted": { "publish_inject_key": "..." } } } ] }`;
}

function branchUserPrompt(
  parents: readonly BranchParent[],
  stakeholders: readonly BranchStakeholder[],
  factSheet: FactSheet,
  crisis: BranchCrisisContext,
): string {
  const byId = new Map(stakeholders.map((stakeholder) => [stakeholder.id, stakeholder]));
  const described = parents.map((parent) => {
    const stakeholder = parent.stakeholder_id ? byId.get(parent.stakeholder_id) : undefined;
    return {
      inject_key: parent.inject_key,
      app: parent.app,
      title: parent.title,
      target_teams: parent.target_teams,
      window_minutes: parent.window_minutes,
      stakeholder: stakeholder
        ? {
            id: stakeholder.id,
            name: stakeholder.name,
            relationship: stakeholder.relationship,
            organisation: stakeholder.organisation,
            title: stakeholder.title,
            persuadability: stakeholder.persuadability,
          }
        : null,
      content: parent.content.slice(0, 800),
    };
  });
  return [
    `Crisis: ${crisis.crisisType}`,
    crisis.orgName ? `Organisation: ${crisis.orgName}` : '',
    `Duration: ${crisis.duration} minutes`,
    crisis.country ? `Country: ${crisis.country}` : '',
    crisis.context ? `Context: ${crisis.context}` : '',
    `Confirmed facts: ${(factSheet.confirmed_facts ?? []).slice(0, 8).join('; ')}`,
    `Stakeholders:\n${JSON.stringify(stakeholders.map((stakeholder) => ({ id: stakeholder.id, name: stakeholder.name, organisation: stakeholder.organisation, title: stakeholder.title, relationship: stakeholder.relationship })))}`,
    `Parents:\n${JSON.stringify(described)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function moodLadderChatOptions(system: string, user: string): ChatOptions {
  return {
    tier: 'standard',
    messages: systemUser(system, user),
    json: true,
    maxTokens: 8000,
    temperature: 0.7,
    timeoutMs: 240_000,
    retry: { attempts: 5, baseDelayMs: 2_000 },
    growOnTruncation: true,
    label: 'generator.moodLadders',
  };
}

const moodDefaultClient: ResponseBranchClient = {
  async complete(request) {
    return chatJson(moodLadderChatOptions(request.system, request.user));
  },
};

async function ensureChainsRedialsAndLadders(input: {
  pool: SocialInject[];
  branchSink: SocialInject[];
  stakeholders: readonly BranchStakeholder[];
  duration: number;
  crisis: BranchCrisisContext;
  factSheet: FactSheet;
  client?: ResponseBranchClient;
}): Promise<void> {
  const conditionalKeys = conditionalKeysOf(input.pool, []);
  const chains = new Map<string, EscalationConfig>();
  for (const inject of input.pool) {
    if (!isChainRoot(inject)) continue;
    const key = inject.delivery_config?.inject_key;
    if (!key) continue;
    const result = postProcessEscalation(
      inject.delivery_config?.escalation,
      contextFor(inject, input.stakeholders, input.duration, conditionalKeys),
    );
    logChain(key, result.repairs, result.dropped);
    if (!result.escalation) {
      delete inject.delivery_config.escalation;
      continue;
    }
    inject.delivery_config = { ...inject.delivery_config, escalation: result.escalation };
    chains.set(key, result.escalation);
  }
  const branches = input.pool.filter((inject) => typeof inject.delivery_config?.branch === 'string');
  const kept = new Set(pruneDoubleChase(branches, chains));
  removeDroppedBranches(input.pool, kept);
  removeDroppedBranches(input.branchSink, kept);
  applyPhoneRedials(input.pool, input.stakeholders);
  await generateMoodLadders({ ...input, client: input.client ?? moodDefaultClient });
}

function chainsOn(injects: readonly SocialInject[], keys: readonly string[]): Map<string, EscalationConfig> {
  const wanted = new Set(keys);
  const chains = new Map<string, EscalationConfig>();
  for (const inject of injects) {
    const key = inject.delivery_config?.inject_key;
    const escalation = inject.delivery_config?.escalation;
    if (typeof key !== 'string' || !wanted.has(key)) continue;
    if (!escalation || typeof escalation !== 'object' || Array.isArray(escalation)) continue;
    chains.set(key, escalation as EscalationConfig);
  }
  return chains;
}

function applyModelEscalations(
  raw: unknown,
  parents: readonly BranchParent[],
  injects: readonly SocialInject[],
  stakeholders: readonly ChainStakeholder[],
  duration: number,
  conditionalKeys: Set<string>,
): void {
  const rows = Array.isArray(raw) ? raw : [];
  for (const parent of parents) {
    const row = rows.map((item) => asRecord(item)).find((item) => item?.inject_key === parent.inject_key);
    if (!row) continue;
    const inject = injects.find(
      (item) => item.delivery_config?.inject_key === parent.inject_key && !item.delivery_config?.branch,
    );
    if (!inject?.delivery_config) continue;
    const result = postProcessEscalation(
      row.escalation ?? row,
      contextFor(inject, stakeholders, duration, conditionalKeys),
    );
    logChain(parent.inject_key, result.repairs, result.dropped);
    if (!result.escalation) {
      delete inject.delivery_config.escalation;
      continue;
    }
    inject.delivery_config = { ...inject.delivery_config, escalation: result.escalation };
  }
}

async function generateMoodLadders(input: {
  pool: SocialInject[];
  branchSink: SocialInject[];
  stakeholders: readonly BranchStakeholder[];
  duration: number;
  crisis: BranchCrisisContext;
  factSheet: FactSheet;
  client: ResponseBranchClient;
}): Promise<void> {
  const selected = stakeholdersForLadders(input.stakeholders);
  if (selected.length === 0) return;
  const taken = new Set(
    input.pool
      .map((inject) => inject.delivery_config?.inject_key)
      .filter((key): key is string => typeof key === 'string'),
  );
  for (let offset = 0; offset < selected.length; offset += LADDER_BATCH) {
    const batch = selected.slice(offset, offset + LADDER_BATCH);
    let raw: unknown = null;
    try {
      raw = await input.client.complete({
        system: moodSystemPrompt(),
        user: moodUserPrompt(batch, input.crisis, input.factSheet, input.duration),
      });
    } catch (err) {
      logger.warn({ err, event: 'mood_ladders_failed' }, 'Mood ladder batch failed');
    }
    const rows = Array.isArray(asRecord(raw)?.ladders) ? (asRecord(raw)?.ladders as unknown[]) : [];
    for (const stakeholder of batch) {
      const row = rows
        .map((item) => asRecord(item))
        .find((item) => item?.stakeholder_id === stakeholder.id);
      const goesPublic = asRecord(row?.goes_public);
      const requested = typeof goesPublic?.inject_key === 'string' ? goesPublic.inject_key : '';
      const existing = existingGoPublic(input.pool, stakeholder.id);
      const existingKey = existing?.delivery_config?.inject_key;
      let key: string;
      if (typeof existingKey === 'string' && existingKey) {
        key = existingKey;
      } else if (requested && /^[a-z0-9_]{1,60}$/.test(requested) && !taken.has(requested)) {
        taken.add(requested);
        key = requested;
      } else {
        key = goPublicKeyFor(stakeholder.id, taken);
      }
      const repaired = postProcessMoodLadder(row?.mood_ladder, {
        stakeholder,
        goPublicKey: key,
        durationMinutes: input.duration,
      });
      if (repaired.repairs.length > 0) {
        logger.warn(
          { event: 'generated_ladder_repaired', stakeholder_id: stakeholder.id, repairs: repaired.repairs },
          'Repaired a generated mood ladder',
        );
      }
      stakeholder.mood_ladder = repaired.ladder;
      if (!existing) {
        const article = goPublicInject(stakeholder, key, {
          title: typeof goesPublic?.title === 'string' ? goesPublic.title : undefined,
          content: typeof goesPublic?.content === 'string' ? goesPublic.content : undefined,
        }) as unknown as SocialInject;
        input.branchSink.push(article);
        input.pool.push(article);
      }
      dropUnresolvedPublish(stakeholder, input.pool);
    }
  }
}

function moodSystemPrompt(): string {
  return `You write a mood ladder for each stakeholder who can be kept waiting in a crisis exercise.

For each stakeholder return a mood_ladder:
- escalated_variant is "angry" for activists and union stakeholders, and "disappointed" for elders and partners.
- The first rung's when is {}.
- At most one terminal rung, and it is last. Use id gave_up.
- One or two script lines per rung, in that stakeholder's voice, each at most 300 characters.
- reply_style says how they speak on that rung.
- gave_up_after_minutes is a positive integer shorter than the scenario duration.
- The gave_up rung has a publish_inject consequence. goes_public is the press article or social post where they go public. Its inject_key is that consequence. Do not invent a different stakeholder.

Return ONLY JSON:
{ "ladders": [ { "stakeholder_id": "...", "mood_ladder": { "gave_up_after_minutes": 30, "escalated_variant": "angry|disappointed", "recovery": "one_rung_per_good_reply", "rungs": [ { "id": "calm", "label": "Calm", "when": {}, "reply_style": "...", "script": { "opening": "...", "lines": ["..."] }, "consequences": [] } ] }, "goes_public": { "inject_key": "...", "title": "...", "content": "..." } } ] }`;
}

function moodUserPrompt(
  stakeholders: readonly BranchStakeholder[],
  crisis: BranchCrisisContext,
  factSheet: FactSheet,
  duration: number,
): string {
  return [
    `Crisis: ${crisis.crisisType}`,
    `Duration: ${duration} minutes`,
    crisis.context ? `Context: ${crisis.context}` : '',
    `Confirmed facts: ${(factSheet.confirmed_facts ?? []).slice(0, 6).join('; ')}`,
    `Stakeholders:\n${JSON.stringify(
      stakeholders.map((stakeholder) => ({
        id: stakeholder.id,
        name: stakeholder.name,
        title: stakeholder.title,
        organisation: stakeholder.organisation,
        relationship: stakeholder.relationship,
        persuadability: stakeholder.persuadability,
        personality: stakeholder.personality,
        stance: stakeholder.stance,
      })),
    )}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function contextFor(
  inject: SocialInject,
  stakeholders: readonly ChainStakeholder[],
  duration: number,
  conditionalKeys: Set<string>,
): ChainRepairContext {
  const stakeholderId = inject.delivery_config?.stakeholder_id;
  return {
    rootKey: inject.delivery_config?.inject_key ?? '',
    rootApp: inject.delivery_config?.app ?? 'email',
    rootStakeholderId: typeof stakeholderId === 'string' ? stakeholderId : null,
    rootTriggerMinute: inject.trigger_time_minutes ?? null,
    durationMinutes: duration,
    stakeholders,
    conditionalKeys,
  };
}

function conditionalKeysOf(injects: readonly SocialInject[], branches: readonly BranchInject[]): Set<string> {
  const keys = new Set<string>();
  for (const inject of injects) {
    const key = inject.delivery_config?.inject_key;
    if (typeof key === 'string' && inject.trigger_time_minutes == null) keys.add(key);
  }
  for (const branch of branches) {
    const key = branch.delivery_config?.inject_key;
    if (typeof key === 'string') keys.add(key);
  }
  return keys;
}

function logChain(injectKey: string, repairs: readonly string[], dropped: boolean): void {
  if (dropped) {
    logger.warn(
      { event: 'generated_chain_dropped', inject_key: injectKey, repairs },
      'Dropping a generated escalation chain that could not be repaired',
    );
    return;
  }
  if (repairs.length === 0) return;
  logger.warn(
    { event: 'generated_chain_repaired', inject_key: injectKey, repairs },
    'Repaired a generated escalation chain',
  );
}

function removeDroppedBranches(list: SocialInject[], kept: ReadonlySet<SocialInject>): void {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const inject = list[index];
    if (typeof inject?.delivery_config?.branch !== 'string') continue;
    if (!kept.has(inject)) list.splice(index, 1);
  }
}

function existingGoPublic(pool: readonly SocialInject[], stakeholderId: string): SocialInject | undefined {
  const needle = `stakeholder_gave_up:${stakeholderId}`;
  return pool.find((inject) => {
    if (inject.trigger_time_minutes != null) return false;
    const key = inject.delivery_config?.inject_key;
    if (typeof key !== 'string' || !key) return false;
    return conditionKeys(inject).some((item) => item.split('|')[0] === needle);
  });
}

function conditionKeys(inject: SocialInject): string[] {
  const appear = inject.conditions_to_appear;
  if (!appear) return [];
  if ('all' in appear && Array.isArray(appear.all)) return appear.all;
  if ('conditions' in appear && Array.isArray(appear.conditions)) return appear.conditions;
  return [];
}

/** A generated publish_inject whose target is not in this pass is removed, so compile does not throw. */
function dropUnresolvedPublish(stakeholder: BranchStakeholder, pool: readonly SocialInject[]): void {
  const ladder = asRecord(stakeholder.mood_ladder);
  const rungs = ladder && Array.isArray(ladder.rungs) ? ladder.rungs : null;
  if (!rungs) return;
  const known = new Set(
    pool
      .map((inject) => inject.delivery_config?.inject_key)
      .filter((key): key is string => typeof key === 'string' && key.length > 0),
  );
  let dropped = false;
  for (const rung of rungs) {
    const row = asRecord(rung);
    if (!row || !Array.isArray(row.consequences)) continue;
    row.consequences = row.consequences.filter((consequence) => {
      const item = asRecord(consequence);
      if (!item || item.type !== 'publish_inject') return true;
      if (typeof item.inject_key === 'string' && known.has(item.inject_key)) return true;
      dropped = true;
      return false;
    });
  }
  if (!dropped) return;
  logger.warn(
    { event: 'generated_ladder_publish_dropped', stakeholder_id: stakeholder.id },
    'Dropping a generated publish_inject whose target is not in the scenario',
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function dedupe(injects: readonly SocialInject[]): SocialInject[] {
  const seen = new Set<SocialInject>();
  const pool: SocialInject[] = [];
  for (const inject of injects) {
    if (!inject || seen.has(inject)) continue;
    seen.add(inject);
    pool.push(inject);
  }
  return pool;
}
