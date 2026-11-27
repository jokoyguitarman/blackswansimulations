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

const BRANCH_PLATFORMS = ['email', 'call', 'chat', 'dm', 'social', 'cross', 'stakeholder'] as const;
const BATCH_SIZE = 10;

export interface BranchStakeholder {
  id: string;
  name?: string;
  relationship?: string;
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
    const model = raw && typeof raw === 'object' ? (raw as { branches?: unknown; rubrics?: unknown }) : {};
    const processed = postProcessResponseBranches(model, batch, duration, taken);
    branches.push(...(processed.branches as unknown as SocialInject[]));
    rubrics.push(...processed.rubrics);
    for (const key of processed.branches) {
      const injectKey = key.delivery_config?.inject_key;
      if (typeof injectKey === 'string') taken.add(injectKey);
    }
  }
  applyRubrics(injects, rubrics);
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
  const report = coverageReport(pool as unknown as BranchInject[]);
  logger.info(
    { event: 'conditional_coverage', by_platform: report.by_platform },
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

Return ONLY JSON:
{ "branches": [ { "parent_inject_key": "...", "branch": "no_reply|poor_reply|good_reply|risky_admission", "title": "...", "content": "...", "type": "email_inbound|phone_call|social_post|chat_message|dm", "delivery_config": { "app": "...", "inject_key": "..." }, "conditions_to_appear": { "all": ["..."] }, "conditions_to_cancel": ["..."], "eligible_after_minutes": 0 } ], "rubrics": [ { "inject_key": "...", "asks": ["..."], "criteria": ["..."], "expected_tone": ["..."], "pass_threshold": 2 } ] }`;
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
        ? { id: stakeholder.id, name: stakeholder.name, relationship: stakeholder.relationship }
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
    `Parents:\n${JSON.stringify(described)}`,
  ]
    .filter(Boolean)
    .join('\n');
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
